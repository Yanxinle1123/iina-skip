const {
  SECTION_KIND_INTRO,
  SECTION_SOURCE_AUDIO_FINGERPRINT,
  formatParsedSeasonEpisode,
  getFilenameStem,
  getLocalFilePath,
  isVideoFilePath,
  parseSeasonEpisode,
} = require('./shared.js');

const AUDIO_MATCH_PLAYLIST_DELAY_MS = 500; // Delay to allow playlist properties to update
const AUDIO_MATCH_MAX_REFERENCE_FILES = 4;
const AUDIO_MATCH_HELPER_PATH = './vendor/audio-intro-match/iina-helper.mjs';
const PLUGIN_PACKAGE_NAME = 'com.yanxinle1123.iinaskip.iinaplugin';
const PLUGIN_DEV_PACKAGE_NAME = 'com.yanxinle1123.iinaskip.iinaplugin-dev';
const BAD_REFERENCE_FILENAME_REGEX =
  /(?:^|[\s._\-[\(])(?:sample|trailer|extras?|ncop\d*|nced\d*|oped|creditless|preview)(?:$|[\s._\-\]\)])/i;
const BINARY_CANDIDATES = Object.freeze({
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
});

function createAudioMatchDetector(dependencies) {
  const mpv = dependencies.mpv;
  const file = dependencies.file;
  const iinaUtils = dependencies.utils;
  const delay = dependencies.delay;
  const log = dependencies.log;
  const binaryPathCache = Object.create(null);
  let homeDirectory = undefined;

  function logAudio(message) {
    log('音频片头检测：' + message);
  }

  async function getHomeDirectory() {
    if (homeDirectory !== undefined) {
      return homeDirectory;
    }

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
    if (binaryPathCache[binary] !== undefined) {
      return binaryPathCache[binary];
    }

    const candidates = BINARY_CANDIDATES[binary] || [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = await expandCandidatePath(candidates[i]);
      if (!candidate) continue;

      try {
        if (file.exists(candidate)) {
          binaryPathCache[binary] = candidate;
          return candidate;
        }
      } catch (error) {
        // Keep trying other candidates.
      }
    }

    // IINA's fileInPath can miss GUI-unavailable shell paths; keep it as a backup only.
    try {
      const found = iinaUtils.fileInPath(binary);
      if (found) {
        binaryPathCache[binary] = found;
        return found;
      }
    } catch (error) {
      // Fall through to an execution probe.
    }

    try {
      const result = await iinaUtils.exec(binary, ['-version']);
      binaryPathCache[binary] = result.status === 0 ? binary : null;
      return binaryPathCache[binary];
    } catch (error) {
      binaryPathCache[binary] = null;
      return null;
    }
  }

  async function getAudioMatchDependencyStatus() {
    const missing = [];

    if (!(await locateBinary('node'))) {
      missing.push('node');
    }

    if (!(await locateBinary('ffmpeg'))) {
      missing.push('ffmpeg');
    }

    return {
      ok: missing.length === 0,
      missing: missing,
    };
  }

  function resolvePluginPath(path) {
    try {
      return iinaUtils.resolvePath(path);
    } catch (error) {
      return path;
    }
  }

  function joinPath(base, path) {
    return base.replace(/\/+$/, '') + '/' + path.replace(/^\.?\//, '');
  }

  function fileExists(path) {
    try {
      if (file.exists(path)) return true;
    } catch (error) {}

    try {
      if (iinaUtils.fileInPath(path)) return true;
    } catch (error) {}

    const resolvedPath = resolvePluginPath(path);
    if (resolvedPath === path) return false;

    try {
      return file.exists(resolvedPath);
    } catch (error) {}

    try {
      return !!iinaUtils.fileInPath(resolvedPath);
    } catch (error) {
      return false;
    }
  }

  function getAudioMatchHelperPath() {
    const triedPaths = [];

    const tildeInstalledPath = joinPath(
      '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_PACKAGE_NAME,
      AUDIO_MATCH_HELPER_PATH,
    );
    if (triedPaths.indexOf(tildeInstalledPath) === -1) triedPaths.push(tildeInstalledPath);
    if (fileExists(tildeInstalledPath)) return resolvePluginPath(tildeInstalledPath);

    const tildeDevPath = joinPath(
      '~/Library/Application Support/com.colliderli.iina/plugins/' + PLUGIN_DEV_PACKAGE_NAME,
      AUDIO_MATCH_HELPER_PATH,
    );
    if (triedPaths.indexOf(tildeDevPath) === -1) triedPaths.push(tildeDevPath);
    if (fileExists(tildeDevPath)) return resolvePluginPath(tildeDevPath);

    logAudio('helper 查找尝试路径：' + triedPaths.join(' | '));
    return null;
  }

  function getAudioMatchCacheDir() {
    try {
      return iinaUtils.resolvePath('@data/audio-intro-match-cache');
    } catch (error) {
      logAudio('特征缓存已禁用：解析 @data 路径失败：' + error);
      return null;
    }
  }

  function getCurrentMediaFile() {
    try {
      const items = getPlaylistItems();
      for (let i = 0; i < items.length; i++) {
        if (items[i].isPlaying || items[i].isCurrent) {
          const playlistPath = getPlaylistItemPath(items[i]);
          if (isPlayableLocalMedia(playlistPath)) {
            return getLocalFilePath(playlistPath);
          }
          logAudio('播放列表当前项不是可播放的本地媒体文件');
        }
      }
    } catch (error) {
      logAudio('播放列表查询失败，回退到 mpv 路径：' + error);
    }

    if (!mpv || typeof mpv.getString !== 'function') return null;

    const path = mpv.getString('path');
    const localPath = typeof path === 'string' && path ? getLocalFilePath(path) || path : null;
    logAudio('mpv 当前路径：' + (localPath || '(无)'));
    return localPath;
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

  function getMpvPlaylistIndex(property) {
    try {
      const index = mpv.getNumber(property);
      return Number.isFinite(index) ? index : -1;
    } catch (error) {
      return -1;
    }
  }

  function getMpvPlaylistString(property) {
    try {
      return mpv.getString(property);
    } catch (error) {
      return null;
    }
  }

  function getPlaylistItems() {
    const count = getMpvPlaylistIndex('playlist-count');
    if (count <= 0) {
      return [];
    }

    const playingIndex = getMpvPlaylistIndex('playlist-playing-pos');
    const currentIndex = getMpvPlaylistIndex('playlist-pos');
    const items = [];

    for (let i = 0; i < count; i++) {
      const filename = getMpvPlaylistString('playlist/' + i + '/filename');
      if (!filename) continue;

      items.push({
        filename: filename,
        isPlaying: i === playingIndex,
        isCurrent: i === currentIndex,
        playlistIndex: i,
      });
    }

    return items;
  }

  function buildPlaylistReferenceCandidates(items, currentIndex, shouldParseEpisodeNumbers) {
    const candidates = [];
    for (let i = 0; i < items.length; i++) {
      const path = getPlaylistItemPath(items[i]);
      if (i === currentIndex || !isPlayableLocalMedia(path) || isBadReferenceFilename(path)) {
        continue;
      }

      const parsed = shouldParseEpisodeNumbers ? parseSeasonEpisode(path) : null;
      candidates.push({
        index: i,
        path: getLocalFilePath(path),
        parsed: parsed,
      });
    }

    return candidates;
  }

  function getCurrentPlaylistIndex(items, mainFile) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].isPlaying || items[i].isCurrent) {
        return i;
      }
    }

    const currentPath = normalizeComparablePath(mainFile);
    if (!currentPath) return -1;

    for (let j = 0; j < items.length; j++) {
      if (normalizeComparablePath(getPlaylistItemPath(items[j])) === currentPath) {
        return j;
      }
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
      const candidate = candidates[i];
      if (isSameSeasonReference(candidate, currentParsed)) {
        candidateByIndex[candidate.index] = candidate;
      }
    }

    const run = [];
    let previousEpisode = currentParsed.episode;
    for (let previousIndex = currentIndex - 1; previousIndex >= 0; previousIndex--) {
      const candidate = candidateByIndex[previousIndex];
      if (!candidate) break;
      if (candidate.parsed.episode >= previousEpisode) break;
      run.push(candidate);
      previousEpisode = candidate.parsed.episode;
    }

    let nextEpisode = currentParsed.episode;
    for (let nextIndex = currentIndex + 1; nextIndex < itemCount; nextIndex++) {
      const candidate = candidateByIndex[nextIndex];
      if (!candidate) break;
      if (candidate.parsed.episode <= nextEpisode) break;
      run.push(candidate);
      nextEpisode = candidate.parsed.episode;
    }

    return run;
  }

  function shouldParseEpisodeNumbers(options) {
    return !options || options.parseAudioMatchEpisodeNumbers !== false;
  }

  function getAudioReferenceFiles(mainFile, options) {
    const items = getPlaylistItems();
    const currentIndex = getCurrentPlaylistIndex(items, mainFile);
    if (currentIndex < 0) {
      logAudio('播放列表扫描：共 ' + items.length + ' 项，未找到当前项');
      return [];
    }

    const currentPath = getPlaylistItemPath(items[currentIndex]) || mainFile;
    const parseEpisodeNumbers = shouldParseEpisodeNumbers(options);
    const currentParsed = parseEpisodeNumbers ? parseSeasonEpisode(currentPath) : null;
    const candidates = buildPlaylistReferenceCandidates(items, currentIndex, parseEpisodeNumbers);
    logAudio(
      '播放列表扫描：共 ' +
        items.length +
        ' 项，当前索引 ' +
        currentIndex +
        '，当前项 ' +
        (parseEpisodeNumbers ? formatParsedSeasonEpisode(currentParsed) : '仅按播放列表顺序'),
    );
    let selected = [];

    if (currentParsed && !currentParsed.isSpecial) {
      selected = getSameSeasonEpisodeRun(
        candidates,
        currentIndex,
        items.length,
        currentParsed,
      ).sort(sortByEpisodeOffset(currentParsed.episode));
      logAudio(
        '参考候选：共 ' +
          candidates.length +
          ' 个可用，其中 ' +
          selected.length +
          ' 个为当前集所在季的连续剧集',
      );
    } else {
      selected = candidates.sort(sortByPlaylistDistance(currentIndex));
      logAudio(
        '参考候选：共 ' + candidates.length + ' 个可用，使用播放列表相邻项回退',
      );
    }

    const referenceFiles = selected
      .slice(0, AUDIO_MATCH_MAX_REFERENCE_FILES)
      .map(function (candidate) {
        return candidate.path;
      });
    logAudio(
      '已选择参考文件：' +
        (referenceFiles.length ? referenceFiles.join(' | ') : '(无)'),
    );
    return referenceFiles;
  }

  function isValidAudioMatchSection(section) {
    if (!section || typeof section.start_seconds !== 'number') return false;

    const start = section.start_seconds;
    const end = section.end_seconds;
    return (
      typeof start === 'number' &&
      isFinite(start) &&
      typeof end === 'number' &&
      isFinite(end) &&
      start >= 0 &&
      end > start
    );
  }

  function isValidAudioMatchOutput(output) {
    if (!output) return false;

    return isValidAudioMatchSection(output.intro) || isValidAudioMatchSection(output.outro);
  }

  function buildAudioMatchSectionGroup(output) {
    const groups = [];

    if (output.intro && typeof output.intro.start_seconds === 'number') {
      const start = output.intro.start_seconds;
      const end = output.intro.end_seconds;
      const id = 'audio-intro-' + Math.round(start * 1000) + '-' + Math.round(end * 1000);

      groups.push({
        id: id,
        start: start,
        end: end,
        sections: [
          {
            start: start,
            end: end,
            titles: ['音频指纹片头'],
            source: SECTION_SOURCE_AUDIO_FINGERPRINT,
            kind: SECTION_KIND_INTRO,
            confidence: output.confidence || null,
            sharedAudio: output.shared_audio || null,
          },
        ],
      });
    }

    if (output.outro && typeof output.outro.start_seconds === 'number') {
      const start = output.outro.start_seconds;
      const end = output.outro.end_seconds;
      const id = 'audio-outro-' + Math.round(start * 1000) + '-' + Math.round(end * 1000);

      groups.push({
        id: id,
        start: start,
        end: end,
        sections: [
          {
            start: start,
            end: end,
            titles: ['音频指纹片尾'],
            source: SECTION_SOURCE_AUDIO_FINGERPRINT,
            kind: SECTION_KIND_CREDITS,
            confidence: output.confidence || null,
            sharedAudio: output.shared_audio || null,
          },
        ],
      });
    }

    return groups;
  }

  async function detectSectionFromAudioMatch(options) {
    logAudio('读取播放列表前等待 ' + AUDIO_MATCH_PLAYLIST_DELAY_MS + ' 毫秒');
    await delay(AUDIO_MATCH_PLAYLIST_DELAY_MS);

    const mainFile = getCurrentMediaFile();
    const referenceFiles = getAudioReferenceFiles(mainFile, options);

    if (!mainFile || !Array.isArray(referenceFiles) || !referenceFiles.length) {
      logAudio('已跳过：缺少当前文件或参考文件');
      return null;
    }

    const nodePath = await locateBinary('node');
    if (!nodePath) {
      logAudio('已跳过：未找到 node');
      return null;
    }
    logAudio('使用 node：' + nodePath);

    const helperPath = getAudioMatchHelperPath();
    if (!helperPath) {
      logAudio('已跳过：未找到音频匹配 helper');
      return null;
    }
    logAudio('使用 helper：' + helperPath);

    const ffmpegPath = await locateBinary('ffmpeg');
    if (!ffmpegPath) {
      logAudio('已跳过：未找到 ffmpeg');
      return null;
    }
    logAudio('使用 ffmpeg：' + ffmpegPath);

    const refs = referenceFiles.slice(0, AUDIO_MATCH_MAX_REFERENCE_FILES);
    const args = [helperPath, '--main', mainFile, '--refs-json', JSON.stringify(refs)];
    if (ffmpegPath) {
      args.push('--ffmpeg', ffmpegPath);
    }
    const cacheDir = getAudioMatchCacheDir();
    if (cacheDir) {
      args.push('--cache-dir', cacheDir);
    }
    if (typeof options.duration === 'number' && isFinite(options.duration) && options.duration > 0) {
      args.push('--duration', String(options.duration));
    } else {
      logAudio('未提供有效的视频时长，片尾检测将被跳过（仅检测片头）');
    }

    logAudio('正在运行 helper，共 ' + refs.length + ' 个参考文件');
    const result = await iinaUtils.exec(nodePath, args);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch (error) {
      logAudio('helper 返回了无效的 JSON 标准输出：' + (result.stdout || '(空)'));
      if (result.stderr) logAudio('helper 标准错误：' + result.stderr);
      return null;
    }

    if (!payload.ok) {
      logAudio(
        'helper 报告未匹配' +
          (payload.code ? ' [' + payload.code + ']' : '') +
          '：' +
          (payload.message || '(无消息)'),
      );
      return null;
    }

    const output = payload.output;
    if (isValidAudioMatchSection(output.intro)) {
      logAudio(
        '匹配器返回的片头区间为 ' +
          output.intro.start_seconds.toFixed(2) +
          's-' +
          output.intro.end_seconds.toFixed(2) +
          's，置信度 ' +
          (output.confidence
            ? output.confidence.score + ' (' + output.confidence.label + ')'
            : '(未知)'),
      );
    }
    if (isValidAudioMatchSection(output.outro)) {
      logAudio(
        '匹配器返回的片尾区间为 ' +
          output.outro.start_seconds.toFixed(2) +
          's-' +
          output.outro.end_seconds.toFixed(2) +
          's，置信度 ' +
          (output.confidence
            ? output.confidence.score + ' (' + output.confidence.label + ')'
            : '(未知)'),
      );
    }
    if (!isValidAudioMatchOutput(output)) {
      logAudio('匹配器返回了无效的片头/片尾结果');
    }

    return isValidAudioMatchOutput(output) ? buildAudioMatchSectionGroup(output) : null;
  }

  return {
    detectSectionFromAudioMatch: detectSectionFromAudioMatch,
    getAudioMatchDependencyStatus: getAudioMatchDependencyStatus,
  };
}

module.exports = {
  createAudioMatchDetector: createAudioMatchDetector,
};
