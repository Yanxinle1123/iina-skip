const {
  SECTION_KIND_INTRO,
  SECTION_KIND_CREDITS,
  SECTION_SOURCE_VIDEO_FINGERPRINT,
  formatParsedSeasonEpisode,
  getFilenameStem,
  getLocalFilePath,
  isVideoFilePath,
  parseSeasonEpisode,
} = require('./shared.js');

const VIDEO_MATCH_PLAYLIST_DELAY_MS = 500;
const VIDEO_MATCH_MAX_REFERENCE_FILES = 4;
const VIDEO_MATCH_HELPER_PATH = './vendor/video-match/video-helper.mjs';
const PLUGIN_PACKAGE_NAME = 'com.yanxinle1123.iinaskip.iinaplugin';
const PLUGIN_DEV_PACKAGE_NAME = 'com.yanxinle1123.iinaskip.iinaplugin-dev';
const BAD_REFERENCE_FILENAME_REGEX =
  /(?:^|[\s._\-[\(])(?:sample|trailer|extras?|ncop\d*|nced\d*|oped|creditless|preview)(?:$|[\s._\-\]\)])/i;
const BINARY_CANDIDATES = Object.freeze({
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
});

function createVideoMatchDetector(dependencies) {
  const mpv = dependencies.mpv;
  const file = dependencies.file;
  const iinaUtils = dependencies.utils;
  const delay = dependencies.delay;
  const log = dependencies.log;
  const binaryPathCache = Object.create(null);
  let homeDirectory = undefined;

  function logVideo(message) {
    log('视频指纹检测：' + message);
  }

  async function getHomeDirectory() {
    if (homeDirectory !== undefined) return homeDirectory;
    try {
      const result = await iinaUtils.exec('/usr/bin/printenv', ['HOME']);
      homeDirectory = result.status === 0 ? result.stdout.trim() || null : null;
    } catch (error) {
      homeDirectory = null;
    }
    return homeDirectory;
  }

  async function expandCandidatePath(path) {
    if (path.indexOf('~/') !== 0) return path;
    const home = await getHomeDirectory();
    return home ? home + path.slice(1) : null;
  }

  async function locateBinary(binary) {
    if (binaryPathCache[binary] !== undefined) return binaryPathCache[binary];

    const candidates = BINARY_CANDIDATES[binary] || [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = await expandCandidatePath(candidates[i]);
      if (!candidate) continue;
      try {
        if (file.exists(candidate)) {
          binaryPathCache[binary] = candidate;
          return candidate;
        }
      } catch (error) {}
    }

    try {
      const found = iinaUtils.fileInPath(binary);
      if (found) {
        binaryPathCache[binary] = found;
        return found;
      }
    } catch (error) {}

    try {
      const result = await iinaUtils.exec(binary, ['-version']);
      binaryPathCache[binary] = result.status === 0 ? binary : null;
      return binaryPathCache[binary];
    } catch (error) {
      binaryPathCache[binary] = null;
      return null;
    }
  }

  async function getVideoMatchDependencyStatus() {
    const missing = [];
    if (!(await locateBinary('node'))) missing.push('node');
    if (!(await locateBinary('ffmpeg'))) missing.push('ffmpeg');
    return { ok: missing.length === 0, missing: missing };
  }

  function resolvePluginPath(path) {
    try { return iinaUtils.resolvePath(path); } catch (error) { return path; }
  }

  function joinPath(base, p) {
    return base.replace(/\/+$/, '') + '/' + p.replace(/^\.?\//, '');
  }

  function fileExists(path) {
    try { if (file.exists(path)) return true; } catch (error) {}
    try { if (iinaUtils.fileInPath(path)) return true; } catch (error) {}
    const resolvedPath = resolvePluginPath(path);
    if (resolvedPath === path) return false;
    try { return file.exists(resolvedPath); } catch (error) {}
    try { return !!iinaUtils.fileInPath(resolvedPath); } catch (error) { return false; }
  }

  function getVideoMatchHelperPath() {
    const triedPaths = [];

    const tildeInstalledPath = joinPath(
      '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_PACKAGE_NAME,
      VIDEO_MATCH_HELPER_PATH,
    );
    if (triedPaths.indexOf(tildeInstalledPath) === -1) triedPaths.push(tildeInstalledPath);
    if (fileExists(tildeInstalledPath)) return resolvePluginPath(tildeInstalledPath);

    const tildeDevPath = joinPath(
      '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_DEV_PACKAGE_NAME,
      VIDEO_MATCH_HELPER_PATH,
    );
    if (triedPaths.indexOf(tildeDevPath) === -1) triedPaths.push(tildeDevPath);
    if (fileExists(tildeDevPath)) return resolvePluginPath(tildeDevPath);

    logVideo('helper 查找尝试路径：' + triedPaths.join(' | '));
    return null;
  }

  // --- playlist scanning (shared logic with audio-match) ---
  function getMpvPlaylistIndex(property) {
    try {
      const index = mpv.getNumber(property);
      return Number.isFinite(index) ? index : -1;
    } catch (error) { return -1; }
  }

  function getMpvPlaylistString(property) {
    try { return mpv.getString(property); } catch (error) { return null; }
  }

  function getPlaylistItems() {
    const count = getMpvPlaylistIndex('playlist-count');
    if (count <= 0) return [];
    const playingIndex = getMpvPlaylistIndex('playlist-playing-pos');
    const currentIndex = getMpvPlaylistIndex('playlist-pos');
    const items = [];
    for (let i = 0; i < count; i++) {
      const filename = getMpvPlaylistString('playlist/' + i + '/filename');
      if (!filename) continue;
      items.push({
        filename,
        isPlaying: i === playingIndex,
        isCurrent: i === currentIndex,
        playlistIndex: i,
      });
    }
    return items;
  }

  function normalizeComparablePath(value) {
    const localPath = getLocalFilePath(value);
    if (!localPath) return null;
    return localPath.replace(/\/+$/, '').toLowerCase();
  }

  function isPlayableLocalMedia(path) {
    return isVideoFilePath(path);
  }

  function isBadReferenceFilename(path) {
    return BAD_REFERENCE_FILENAME_REGEX.test(getFilenameStem(path));
  }

  function getPlaylistItemPath(item) {
    return item && item.filename ? item.filename : null;
  }

  function getCurrentMediaFile() {
    try {
      const items = getPlaylistItems();
      for (let i = 0; i < items.length; i++) {
        if (items[i].isPlaying || items[i].isCurrent) {
          const playlistPath = getPlaylistItemPath(items[i]);
          if (isPlayableLocalMedia(playlistPath)) return getLocalFilePath(playlistPath);
          logVideo('播放列表当前项不是可播放的本地媒体文件');
        }
      }
    } catch (error) {
      logVideo('播放列表查询失败，回退到 mpv 路径：' + error);
    }
    if (!mpv || typeof mpv.getString !== 'function') return null;
    const path = mpv.getString('path');
    const localPath = typeof path === 'string' && path ? getLocalFilePath(path) || path : null;
    return localPath;
  }

  function buildPlaylistReferenceCandidates(items, currentIndex, shouldParseEpisodeNumbers) {
    const candidates = [];
    for (let i = 0; i < items.length; i++) {
      const path = getPlaylistItemPath(items[i]);
      if (i === currentIndex || !isPlayableLocalMedia(path) || isBadReferenceFilename(path)) continue;
      const parsed = shouldParseEpisodeNumbers ? parseSeasonEpisode(path) : null;
      candidates.push({ index: i, path: getLocalFilePath(path), parsed });
    }
    return candidates;
  }

  function getCurrentPlaylistIndex(items, mainFile) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].isPlaying || items[i].isCurrent) return i;
    }
    const currentPath = normalizeComparablePath(mainFile);
    if (!currentPath) return -1;
    for (let j = 0; j < items.length; j++) {
      if (normalizeComparablePath(getPlaylistItemPath(items[j])) === currentPath) return j;
    }
    return -1;
  }

  function sortByPlaylistDistance(currentIndex) {
    return function (a, b) {
      const aDistance = Math.abs(a.index - currentIndex);
      const bDistance = Math.abs(b.index - currentIndex);
      const aPrevious = a.index < currentIndex ? 0 : 1;
      const bPrevious = b.index < currentIndex ? 0 : 1;
      return aDistance - bDistance || aPrevious - bPrevious || a.index - b.index;
    };
  }

  function sortByEpisodeOffset(currentEpisode) {
    return function (a, b) {
      const aOffset = a.parsed.episode - currentEpisode;
      const bOffset = b.parsed.episode - currentEpisode;
      const aDistance = Math.abs(aOffset);
      const bDistance = Math.abs(bOffset);
      const aSide = aOffset > 0 ? 0 : 1;
      const bSide = bOffset > 0 ? 0 : 1;
      return aDistance - bDistance || aSide - bSide || a.index - b.index;
    };
  }

  function isSameSeasonReference(candidate, currentParsed) {
    return (
      candidate.parsed &&
      !candidate.parsed.isSpecial &&
      candidate.parsed.season === currentParsed.season &&
      candidate.parsed.episode !== currentParsed.episode
    );
  }

  function getSameSeasonEpisodeRun(candidates, currentIndex, itemCount, currentParsed) {
    const candidateByIndex = Object.create(null);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (isSameSeasonReference(c, currentParsed)) candidateByIndex[c.index] = c;
    }
    const run = [];
    let prevEp = currentParsed.episode;
    for (let pi = currentIndex - 1; pi >= 0; pi--) {
      const c = candidateByIndex[pi];
      if (!c) break;
      if (c.parsed.episode >= prevEp) break;
      run.push(c);
      prevEp = c.parsed.episode;
    }
    let nextEp = currentParsed.episode;
    for (let ni = currentIndex + 1; ni < itemCount; ni++) {
      const c = candidateByIndex[ni];
      if (!c) break;
      if (c.parsed.episode <= nextEp) break;
      run.push(c);
      nextEp = c.parsed.episode;
    }
    return run;
  }

  function shouldParseEpisodeNumbers(options) {
    return !options || options.parseVideoMatchEpisodeNumbers !== false;
  }

  function getVideoReferenceFiles(mainFile, options) {
    const items = getPlaylistItems();
    const currentIndex = getCurrentPlaylistIndex(items, mainFile);
    if (currentIndex < 0) {
      logVideo('播放列表扫描：共 ' + items.length + ' 项，未找到当前项');
      return [];
    }
    const currentPath = getPlaylistItemPath(items[currentIndex]) || mainFile;
    const parseEpisodeNumbers = shouldParseEpisodeNumbers(options);
    const currentParsed = parseEpisodeNumbers ? parseSeasonEpisode(currentPath) : null;
    const candidates = buildPlaylistReferenceCandidates(items, currentIndex, parseEpisodeNumbers);
    logVideo(
      '播放列表扫描：共 ' + items.length + ' 项，当前索引 ' + currentIndex +
      '，当前项 ' + (parseEpisodeNumbers ? formatParsedSeasonEpisode(currentParsed) : '仅按播放列表顺序'),
    );
    let selected = [];
    if (currentParsed && !currentParsed.isSpecial) {
      selected = getSameSeasonEpisodeRun(candidates, currentIndex, items.length, currentParsed)
        .sort(sortByEpisodeOffset(currentParsed.episode));
      logVideo('参考候选：共 ' + candidates.length + ' 个可用，其中 ' + selected.length + ' 个为同季连续剧集');
    } else {
      selected = candidates.sort(sortByPlaylistDistance(currentIndex));
      logVideo('参考候选：共 ' + candidates.length + ' 个可用，使用播放列表相邻项回退');
    }
    const referenceFiles = selected.slice(0, VIDEO_MATCH_MAX_REFERENCE_FILES).map(function (c) { return c.path; });
    logVideo('已选择参考文件：' + (referenceFiles.length ? referenceFiles.join(' | ') : '(无)'));
    return referenceFiles;
  }

  // --- section validation & building ---
  function isValidVideoMatchSection(section) {
    if (!section || typeof section.start_seconds !== 'number') return false;
    const start = section.start_seconds;
    const end = section.end_seconds;
    return (
      typeof start === 'number' && isFinite(start) &&
      typeof end === 'number' && isFinite(end) &&
      start >= 0 && end > start
    );
  }

  function isValidVideoMatchOutput(output) {
    if (!output) return false;
    return isValidVideoMatchSection(output.intro) || isValidVideoMatchSection(output.outro);
  }

  function buildVideoMatchSectionGroup(output) {
    const groups = [];

    if (output.intro && typeof output.intro.start_seconds === 'number') {
      const start = output.intro.start_seconds;
      const end = output.intro.end_seconds;
      const id = 'video-intro-' + Math.round(start * 1000) + '-' + Math.round(end * 1000);
      groups.push({
        id: id,
        start: start,
        end: end,
        sections: [{
          start: start,
          end: end,
          titles: ['视频指纹片头'],
          source: SECTION_SOURCE_VIDEO_FINGERPRINT,
          kind: SECTION_KIND_INTRO,
          confidence: output.confidence || null,
        }],
      });
    }

    if (output.outro && typeof output.outro.start_seconds === 'number') {
      const start = output.outro.start_seconds;
      const end = output.outro.end_seconds;
      const id = 'video-outro-' + Math.round(start * 1000) + '-' + Math.round(end * 1000);
      groups.push({
        id: id,
        start: start,
        end: end,
        sections: [{
          start: start,
          end: end,
          titles: ['视频指纹片尾'],
          source: SECTION_SOURCE_VIDEO_FINGERPRINT,
          kind: SECTION_KIND_CREDITS,
          confidence: output.confidence || null,
        }],
      });
    }

    return groups;
  }

  // --- main detection ---
  async function detectSectionFromVideoMatch(options) {
    logVideo('读取播放列表前等待 ' + VIDEO_MATCH_PLAYLIST_DELAY_MS + ' 毫秒');
    await delay(VIDEO_MATCH_PLAYLIST_DELAY_MS);

    const mainFile = getCurrentMediaFile();
    const referenceFiles = getVideoReferenceFiles(mainFile, options);

    if (!mainFile || !Array.isArray(referenceFiles) || !referenceFiles.length) {
      logVideo('已跳过：缺少当前文件或参考文件');
      return null;
    }

    const nodePath = await locateBinary('node');
    if (!nodePath) {
      logVideo('已跳过：未找到 node');
      return null;
    }
    logVideo('使用 node：' + nodePath);

    const helperPath = getVideoMatchHelperPath();
    if (!helperPath) {
      logVideo('已跳过：未找到视频匹配 helper');
      return null;
    }
    logVideo('使用 helper：' + helperPath);

    const ffmpegPath = await locateBinary('ffmpeg');
    if (!ffmpegPath) {
      logVideo('已跳过：未找到 ffmpeg');
      return null;
    }
    logVideo('使用 ffmpeg：' + ffmpegPath);

    const refs = referenceFiles.slice(0, VIDEO_MATCH_MAX_REFERENCE_FILES);
    const args = [helperPath, '--main', mainFile, '--refs-json', JSON.stringify(refs)];
    if (ffmpegPath) args.push('--ffmpeg', ffmpegPath);
    if (typeof options.duration === 'number' && isFinite(options.duration) && options.duration > 0) {
      args.push('--duration', String(options.duration));
    } else {
      logVideo('未提供有效的视频时长，片尾检测将被跳过（仅检测片头）');
    }

    logVideo('正在运行 helper，共 ' + refs.length + ' 个参考文件');
    const result = await iinaUtils.exec(nodePath, args);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch (error) {
      logVideo('helper 返回了无效的 JSON 标准输出：' + (result.stdout || '(空)'));
      if (result.stderr) logVideo('helper 标准错误：' + result.stderr);
      return null;
    }

    if (!payload.ok) {
      logVideo(
        'helper 报告未匹配' +
          (payload.code ? ' [' + payload.code + ']' : '') +
          '：' + (payload.message || '(无消息)'),
      );
      return null;
    }

    const output = payload.output;
    if (isValidVideoMatchSection(output.intro)) {
      logVideo(
        '匹配器返回的片头区间为 ' +
          output.intro.start_seconds.toFixed(2) + 's-' +
          output.intro.end_seconds.toFixed(2) + 's，置信度 ' +
          (output.confidence
            ? output.confidence.score + ' (' + output.confidence.label + ')'
            : '(未知)'),
      );
    }
    if (isValidVideoMatchSection(output.outro)) {
      logVideo(
        '匹配器返回的片尾区间为 ' +
          output.outro.start_seconds.toFixed(2) + 's-' +
          output.outro.end_seconds.toFixed(2) + 's，置信度 ' +
          (output.confidence
            ? output.confidence.score + ' (' + output.confidence.label + ')'
            : '(未知)'),
      );
    }
    if (!isValidVideoMatchOutput(output)) {
      logVideo('匹配器返回了无效的片头/片尾结果');
    }

    return isValidVideoMatchOutput(output) ? buildVideoMatchSectionGroup(output) : null;
  }

  return {
    detectSectionFromVideoMatch: detectSectionFromVideoMatch,
    getVideoMatchDependencyStatus: getVideoMatchDependencyStatus,
  };
}

module.exports = {
  createVideoMatchDetector: createVideoMatchDetector,
};
