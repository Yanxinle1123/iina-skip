import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ANALYZE_SECONDS = 360;
const FRAME_FPS = 2;
const FRAME_HOP = 1 / FRAME_FPS;
const FRAME_WIDTH = 9;
const FRAME_HEIGHT = 8;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT;
const HAMMING_THRESHOLD = 16;
const MIN_MATCH_SECONDS = 20;
const MAX_MATCH_SECONDS = 150;
const SEARCH_WINDOW_SECONDS = 3;
const SEARCH_WINDOW_FRAMES = Math.ceil(SEARCH_WINDOW_SECONDS * FRAME_FPS);
const MIN_MATCH_FRAMES = Math.ceil(MIN_MATCH_SECONDS * FRAME_FPS);
const MAX_MATCH_FRAMES = Math.floor(MAX_MATCH_SECONDS * FRAME_FPS);

// --- algorithm fingerprint for cache invalidation ---
const ALGORITHM_VERSION = 'v1';

function computeAlgorithmFingerprint() {
  const params = {
    ANALYZE_SECONDS,
    FRAME_FPS,
    FRAME_WIDTH,
    FRAME_HEIGHT,
  };
  const hash = createHash('md5')
    .update(JSON.stringify(params))
    .digest('hex')
    .slice(0, 8);
  return `${ALGORITHM_VERSION}_${hash}`;
}

const ALGORITHM_FINGERPRINT = computeAlgorithmFingerprint();

// --- disk cache for frame hashes ---
const CACHE_DIR = join(tmpdir(), 'iina-skip-cache');

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getFileFingerprint(filePath) {
  return createHash('md5').update(filePath).digest('hex').slice(0, 16);
}

function getCachePath(filePath) {
  ensureCacheDir();
  const fileFp = getFileFingerprint(filePath);
  return join(CACHE_DIR, `${fileFp}_${ALGORITHM_FINGERPRINT}.json`);
}

function regionKey(startSeconds, durationSeconds) {
  return `${startSeconds}_${durationSeconds}`;
}

function loadCache(filePath) {
  const cachePath = getCachePath(filePath);
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const cached = JSON.parse(raw);
    if (!cached || cached.fingerprint !== ALGORITHM_FINGERPRINT) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveCache(filePath, regions) {
  const cachePath = getCachePath(filePath);
  const data = {
    fingerprint: ALGORITHM_FINGERPRINT,
    cached_at: new Date().toISOString(),
    file: filePath,
    regions,
  };
  try {
    writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
  } catch {
    // cache write failure is non-fatal
  }
}

// --- error handling ---------------------------------------------------------
class VideoMatchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function secondsToHms(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// --- ffmpeg frame extraction ------------------------------------------------
function ffprobeDuration(path, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath.replace(/ffmpeg$/, 'ffprobe'), [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const dur = parseFloat(stdout.trim());
      if (!isFinite(dur) || dur <= 0) return reject(new Error('invalid duration'));
      resolve(dur);
    });
    proc.on('error', reject);
  });
}

function extractFrames(path, startSeconds, durationSeconds, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(startSeconds),
      '-i', path,
      '-t', String(durationSeconds),
      '-vf', `fps=${FRAME_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`,
      '-an',
      '-f', 'rawvideo',
      'pipe:1',
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    proc.stdout.on('data', (d) => { chunks.push(d); });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-200)}`));
      }
      const buf = Buffer.concat(chunks);
      resolve(buf);
    });
    proc.on('error', reject);
  });
}

// --- dHash ------------------------------------------------------------------
function popcount32(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function popcount32Alt(n) {
  // Use BigInt for 64-bit values, but we pass two 32-bit halves.
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

function extractFrameHashes(rawData) {
  const frameCount = Math.floor(rawData.length / FRAME_BYTES);
  const hashes = [];

  for (let f = 0; f < frameCount; f++) {
    const offset = f * FRAME_BYTES;
    let hashHi = 0;
    let hashLo = 0;

    for (let row = 0; row < FRAME_HEIGHT; row++) {
      for (let col = 0; col < FRAME_WIDTH - 1; col++) {
        const left = rawData[offset + row * FRAME_WIDTH + col];
        const right = rawData[offset + row * FRAME_WIDTH + col + 1];
        const bitIndex = row * (FRAME_WIDTH - 1) + col;
        if (left > right) {
          if (bitIndex < 32) {
            hashHi |= (1 << (31 - bitIndex));
          } else {
            hashLo |= (1 << (63 - bitIndex));
          }
        }
      }
    }

    hashes.push({ hi: hashHi, lo: hashLo });
  }

  return hashes;
}

function hammingDistance(a, b) {
  let dist = 0;
  if (a.hi !== b.hi) {
    dist += popcount32(a.hi ^ b.hi);
  }
  if (a.lo !== b.lo) {
    dist += popcount32(a.lo ^ b.lo);
  }
  return dist;
}

// --- matching ---------------------------------------------------------------
function findMatchSegments(distances) {
  const segments = [];
  let inSegment = false;
  let start = 0;

  for (let i = 0; i < distances.length; i++) {
    const matches = distances[i] < HAMMING_THRESHOLD;
    if (matches && !inSegment) {
      start = i;
      inSegment = true;
    } else if (!matches && inSegment) {
      inSegment = false;
      const len = i - start;
      if (len >= MIN_MATCH_FRAMES && len <= MAX_MATCH_FRAMES) {
        segments.push({ start, end: i, length: len });
      }
    }
  }

  if (inSegment) {
    const len = distances.length - start;
    if (len >= MIN_MATCH_FRAMES && len <= MAX_MATCH_FRAMES) {
      segments.push({ start, end: distances.length, length: len });
    }
  }

  return segments;
}

function scoreSegment(segment, distances) {
  // Average similarity within the segment
  let totalSim = 0;
  for (let i = segment.start; i < segment.end; i++) {
    totalSim += 1 - distances[i] / 64;
  }
  const avgSim = totalSim / segment.length;

  // Length bonus (prefer longer matches, within limits)
  const lengthScore = (segment.length - MIN_MATCH_FRAMES) / (MAX_MATCH_FRAMES - MIN_MATCH_FRAMES);

  return round4(avgSim * 0.7 + lengthScore * 0.3);
}

function matchIntro(mainHashes, refHashesPerFile) {
  if (!mainHashes.length) return null;

  const mainLen = mainHashes.length;
  let bestSegment = null;
  let bestScore = -1;

  for (const ref of refHashesPerFile) {
    if (!ref.hashes.length) continue;
    const refLen = ref.hashes.length;
    const distances = [];

    for (let i = 0; i < mainLen; i++) {
      let bestDist = 64;
      const windowStart = Math.max(0, i - SEARCH_WINDOW_FRAMES);
      const windowEnd = Math.min(refLen, i + SEARCH_WINDOW_FRAMES + 1);
      for (let j = windowStart; j < windowEnd; j++) {
        const dist = hammingDistance(mainHashes[i], ref.hashes[j]);
        if (dist < bestDist) bestDist = dist;
      }
      distances.push(bestDist);
    }

    const segments = findMatchSegments(distances);
    for (const seg of segments) {
      const score = scoreSegment(seg, distances);
      if (score > bestScore) {
        bestScore = score;
        bestSegment = {
          start: seg.start * FRAME_HOP,
          end: seg.end * FRAME_HOP,
          length: seg.length,
          score,
          distances: distances.slice(seg.start, seg.end),
        };
      }
    }
  }

  if (!bestSegment) return null;

  return {
    start_seconds: round4(bestSegment.start),
    end_seconds: round4(bestSegment.end),
    duration_seconds: round4(bestSegment.end - bestSegment.start),
    confidence_score: bestSegment.score,
    confidence_label: bestSegment.score >= 0.8 ? 'high' : bestSegment.score >= 0.5 ? 'medium' : 'low',
  };
}

function matchOutro(mainHashes, refHashesPerFile, outroOffset) {
  if (!mainHashes.length) return null;

  const mainLen = mainHashes.length;
  let bestSegment = null;
  let bestScore = -1;

  for (const ref of refHashesPerFile) {
    if (!ref.hashes.length) continue;
    const refLen = ref.hashes.length;
    const distances = [];

    for (let i = 0; i < mainLen; i++) {
      let bestDist = 64;
      const windowStart = Math.max(0, i - SEARCH_WINDOW_FRAMES);
      const windowEnd = Math.min(refLen, i + SEARCH_WINDOW_FRAMES + 1);
      for (let j = windowStart; j < windowEnd; j++) {
        const dist = hammingDistance(mainHashes[i], ref.hashes[j]);
        if (dist < bestDist) bestDist = dist;
      }
      distances.push(bestDist);
    }

    const segments = findMatchSegments(distances);
    for (const seg of segments) {
      const score = scoreSegment(seg, distances);
      if (score > bestScore) {
        bestScore = score;
        bestSegment = {
          start: seg.start * FRAME_HOP,
          end: seg.end * FRAME_HOP,
          length: seg.length,
          score,
          distances: distances.slice(seg.start, seg.end),
        };
      }
    }
  }

  if (!bestSegment) return null;

  return {
    start_seconds: round4(bestSegment.start + outroOffset),
    end_seconds: round4(bestSegment.end + outroOffset),
    duration_seconds: round4(bestSegment.end - bestSegment.start),
    confidence_score: bestSegment.score,
    confidence_label: bestSegment.score >= 0.8 ? 'high' : bestSegment.score >= 0.5 ? 'medium' : 'low',
  };
}

// --- cached frame hash extraction --------------------------------------------
async function getFrameHashesCached(file, startSeconds, durationSeconds, ffmpegPath) {
  const key = regionKey(startSeconds, durationSeconds);
  const cache = loadCache(file);

  // Cache hit: return stored hashes
  if (cache && cache.regions && cache.regions[key]) {
    return cache.regions[key];
  }

  // Cache miss: extract frames, compute hashes, merge into cache
  const regions = (cache && cache.regions) ? { ...cache.regions } : {};

  try {
    const rawData = await extractFrames(file, startSeconds, durationSeconds, ffmpegPath);
    const hashes = extractFrameHashes(rawData);
    regions[key] = hashes;
    saveCache(file, regions);
    return hashes;
  } catch {
    // extraction failed, store empty array in cache to avoid repeated failures
    if (!regions[key]) {
      regions[key] = [];
      saveCache(file, regions);
    }
    throw new Error(`Failed to extract frames from ${file} at ${startSeconds}s`);
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const opts = { ffmpeg: null, main: null, refs: [], duration: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--main' && i + 1 < args.length) opts.main = args[++i];
    else if (arg === '--refs-json' && i + 1 < args.length) {
      try { opts.refs = JSON.parse(args[++i]); } catch { opts.refs = []; }
    }
    else if (arg === '--ffmpeg' && i + 1 < args.length) opts.ffmpeg = args[++i];
    else if (arg === '--duration' && i + 1 < args.length) {
      const d = parseFloat(args[++i]);
      if (isFinite(d) && d > 0) opts.duration = d;
    }
  }

  if (!opts.main || !Array.isArray(opts.refs) || !opts.refs.length) {
    process.stdout.write(JSON.stringify(fail('INVALID_ARGUMENTS', '需要 --main 和 --refs-json 参数')) + '\n');
    process.exit(1);
  }

  if (!opts.ffmpeg) {
    process.stdout.write(JSON.stringify(fail('INVALID_ARGUMENTS', '需要 --ffmpeg 参数')) + '\n');
    process.exit(1);
  }

  try {
    const allFiles = [opts.main, ...opts.refs];

    // --- auto-detect main file duration if not provided ---
    let mainDuration = opts.duration;
    if (!mainDuration) {
      try {
        mainDuration = await ffprobeDuration(opts.main, opts.ffmpeg);
      } catch (e) {
        // ffprobe failed, skip outro detection
      }
    }

    // --- compute outro offsets in parallel ---
    let outroOffset = 0;
    const refOutroOffsets = new Map();
    if (mainDuration) {
      outroOffset = Math.max(0, mainDuration - ANALYZE_SECONDS);
    }

    // Parallel ffprobe for all ref files
    if (mainDuration && outroOffset > 0) {
      const probeResults = await Promise.all(
        opts.refs.map(async (ref) => {
          try {
            const d = await ffprobeDuration(ref, opts.ffmpeg);
            return { ref, offset: Math.max(0, d - ANALYZE_SECONDS) };
          } catch {
            return { ref, offset: 0 };
          }
        })
      );
      for (const { ref, offset } of probeResults) {
        refOutroOffsets.set(ref, offset);
      }
    }

    // --- launch ALL frame extractions in parallel (with disk cache) ---
    const extractionTasks = [];

    // Intro: all files from start
    for (const file of allFiles) {
      extractionTasks.push({
        key: 'intro:' + file,
        promise: getFrameHashesCached(file, 0, ANALYZE_SECONDS, opts.ffmpeg),
      });
    }

    // Outro: only if we have duration
    if (mainDuration && outroOffset > 0) {
      extractionTasks.push({
        key: 'outro:' + opts.main,
        promise: getFrameHashesCached(opts.main, outroOffset, ANALYZE_SECONDS, opts.ffmpeg),
      });
      for (const ref of opts.refs) {
        const refOff = refOutroOffsets.get(ref) || 0;
        if (refOff > 0) {
          extractionTasks.push({
            key: 'outro:' + ref,
            promise: getFrameHashesCached(ref, refOff, ANALYZE_SECONDS, opts.ffmpeg),
          });
        } else {
          extractionTasks.push({
            key: 'outro:' + ref,
            promise: Promise.resolve([]),
          });
        }
      }
    }

    // Run all extractions concurrently
    const taskPromises = extractionTasks.map((t) =>
      t.promise
        .then((hashes) => ({ key: t.key, hashes }))
        .catch(() => ({ key: t.key, hashes: [] }))
    );
    const results = await Promise.all(taskPromises);

    // Build feature maps
    const featureMap = new Map();
    for (let i = 0; i < results.length; i++) {
      featureMap.set(results[i].key, results[i].hashes);
    }

    // --- intro matching ---
    const mainIntroHashes = featureMap.get('intro:' + opts.main) || [];
    const refIntroHashes = opts.refs.map((r) => ({ file: r, hashes: featureMap.get('intro:' + r) || [] }));
    const intro = matchIntro(mainIntroHashes, refIntroHashes);

    // --- outro matching ---
    let outro = null;
    if (mainDuration && outroOffset > 0) {
      const mainOutroHashes = featureMap.get('outro:' + opts.main) || [];
      const refOutroHashes = opts.refs.map((r) => ({ file: r, hashes: featureMap.get('outro:' + r) || [] }));
      outro = matchOutro(mainOutroHashes, refOutroHashes, outroOffset);
    }

    // Determine best overall confidence
    const confidenceScore = Math.max(
      intro?.confidence_score ?? 0,
      outro?.confidence_score ?? 0,
    );
    const confidenceLabel =
      confidenceScore >= 0.8 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low';

    const output = {
      main_file: opts.main,
      intro: intro || null,
      outro: outro || null,
      accepted: confidenceScore >= 0.5,
      confidence: {
        score: round4(confidenceScore),
        label: confidenceLabel,
        threshold: 0.5,
      },
    };

    process.stdout.write(JSON.stringify({ ok: true, output }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify(
      fail(error.code || 'MATCH_ERROR', error.message)
    ) + '\n');
    process.exit(1);
  }
}

main().catch((e) => {
  process.stdout.write(JSON.stringify(fail('FATAL', e.message)) + '\n');
  process.exit(1);
});
