const core = iina.core;
const event = iina.event;
const mpv = iina.mpv;
const overlay = iina.overlay;
const preferences = iina.preferences;
const input = iina.input;
const console = iina.console;
const file = iina.file;
const iinaUtils = iina.utils;

const {
  SECTION_KIND_INTRO,
  SECTION_KIND_CREDITS,
  SECTION_KIND_RECAP,
  SECTION_KIND_SECTION,
  SECTION_SOURCE_AUDIO_FINGERPRINT,
  SECTION_SOURCE_VIDEO_FINGERPRINT,
  SECTION_SOURCE_TITLE,
  getLocalFilePath,
  getChapterStart,
  isVideoFilePath,
  parseSeasonEpisode,
} = require('./detectors/shared.js');
const { detectSectionsFromChapterTitles } = require('./detectors/chapter-title.js');
const { detectSectionsFromChapterTiming } = require('./detectors/chapter-timing.js');
const { createAudioMatchDetector } = require('./detectors/audio-match.js');
const { createVideoMatchDetector } = require('./detectors/video-match.js');

const INTRO_PROMPT_LEAD_IN = 1;
const AUTO_SKIP_START_DELAY_SECONDS = 0;
const AUTO_SKIP_MIN_START_DELAY_SECONDS = 0;
const AUTO_SKIP_MAX_START_DELAY_SECONDS = 10;
const AUTO_SKIP_STATUS_LEAD_IN_SECONDS = 2;
const AUTO_SKIP_STATUS_AFTER_SECONDS = 2;
const INTRO_PROMPT_AUTO_DISMISS_SECONDS = 15;
const INTRO_PROMPT_MIN_AUTO_DISMISS_SECONDS = 5;
const INTRO_PROMPT_MAX_AUTO_DISMISS_SECONDS = 20;
const SKIP_END_BUFFER_SECONDS = 1;
const SKIP_END_MIN_BUFFER_SECONDS = 0;
const SKIP_END_MAX_BUFFER_SECONDS = 10;
const DURATION_READ_DELAY_MS = 500;
const DETECTION_MIN_DURATION = 10 * 60;
const MOVIE_MIN_DURATION = 90 * 60;
const AUDIO_MATCH_CHAPTER_SNAP_WINDOW = 3;

const PREF_DETECT_CHAPTER_TITLES = 'detect_chapter_titles';
const PREF_DETECT_INTROS = 'detect_intros';
const PREF_DETECT_AUDIO_MATCHING = 'detect_audio_matching';
const PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS = 'audio_match_parse_episode_numbers';
const PREF_DETECT_CHAPTER_TIMING = 'detect_chapter_timing';
const PREF_DETECT_RECAPS = 'detect_recaps';
const PREF_DETECT_CREDITS = 'detect_credits';
const PREF_AUTO_SKIP_TITLE_INTROS = 'auto_skip_title_intros';
const PREF_AUTO_SKIP_TITLE_RECAPS = 'auto_skip_title_recaps';
const PREF_AUTO_SKIP_TITLE_CREDITS = 'auto_skip_title_credits';
const PREF_AUTO_SKIP_AUDIO_MATCHING = 'auto_skip_audio_matching';
const PREF_AUTO_SKIP_AUDIO_MATCHING_CREDITS = 'auto_skip_audio_matching_credits';
const PREF_AUTO_SKIP_START_DELAY_SECONDS = 'auto_skip_start_delay_seconds';
const PREF_SHOW_AUTO_SKIP_STATUS = 'show_auto_skip_status';
const PREF_AUTO_SKIP_FIRST_EPISODE_OF_SEASON = 'auto_skip_first_episode_of_season';
const PREF_POPUP_AUTO_DISMISS_SECONDS = 'popup_auto_dismiss_seconds';
const PREF_SKIP_END_BUFFER_SECONDS = 'skip_end_buffer_seconds';
const PREF_SKIP_KEY_BINDING = 'skip_key_binding';
const PREF_POPUP_BUTTON_GREY = 'popup_button_grey';
const PREF_DETECT_VIDEO_MATCHING = 'detect_video_matching';
const PREF_VIDEO_MATCH_PARSE_EPISODE_NUMBERS = 'video_match_parse_episode_numbers';
const PREF_AUTO_SKIP_VIDEO_MATCHING = 'auto_skip_video_matching';
const PREF_AUTO_SKIP_VIDEO_MATCHING_CREDITS = 'auto_skip_video_matching_credits';

let overlayReady = false;
let overlayVisible = false;
let overlayMode = null;
let overlayInitialized = false;
let handlersRegistered = false;
let detectedSections = [];
let currentOverlaySection = null;
let autoSkipStatusSectionId = null;
let autoSkipStatusPhase = null;
let autoSkipStatusHideTimer = null;
let dismissedSectionIds = Object.create(null);
let detectionRunId = 0;
let shownAudioDependencyWarningKey = null;
let registeredSkipKeyBinding = null;

function log(message) {
  console.log(message);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

const audioMatchDetector = createAudioMatchDetector({
  mpv: mpv,
  file: file,
  utils: iinaUtils,
  log: log,
  delay: delay,
});
const detectSectionFromAudioMatch = audioMatchDetector.detectSectionFromAudioMatch;
const getAudioMatchDependencyStatus = audioMatchDetector.getAudioMatchDependencyStatus;

const videoMatchDetector = createVideoMatchDetector({
  mpv: mpv,
  file: file,
  utils: iinaUtils,
  log: log,
  delay: delay,
});
const detectSectionFromVideoMatch = videoMatchDetector.detectSectionFromVideoMatch;
const getVideoMatchDependencyStatus = videoMatchDetector.getVideoMatchDependencyStatus;
const precomputeVideoMatch = videoMatchDetector.precomputeVideoMatch;
const getAdjacentPlaylistFiles = videoMatchDetector.getAdjacentPlaylistFiles;

function getPosition() {
  const position = mpv.getNumber('time-pos');
  return typeof position === 'number' && isFinite(position) ? position : null;
}

function getDuration() {
  const duration = mpv.getNumber('duration');
  return typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : null;
}

function getCurrentMediaPath() {
  try {
    const path = mpv.getString('path');
    return typeof path === 'string' && path ? getLocalFilePath(path) || path : null;
  } catch (error) {
    return null;
  }
}

function isDurationLongEnoughForDetection(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration >= DETECTION_MIN_DURATION;
}

function isMovieDuration(duration) {
  return typeof duration === 'number' && isFinite(duration) && duration > MOVIE_MIN_DURATION;
}

function getDetectionOptionsForDuration(options, duration) {
  if (!isMovieDuration(duration)) return options;

  return {
    detectChapterTitles: options.detectChapterTitles,
    detectAudioMatching: false,
    detectVideoMatching: false,
    parseAudioMatchEpisodeNumbers: options.parseAudioMatchEpisodeNumbers,
    parseVideoMatchEpisodeNumbers: options.parseVideoMatchEpisodeNumbers,
    detectChapterTiming: false,
    detectIntros: false,
    detectRecaps: false,
    detectCredits: options.detectCredits,
  };
}

function getBooleanPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallbackValue;
}

function getNumberPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (isFinite(parsed)) return parsed;
  }
  return fallbackValue;
}

function getStringPreference(key, fallbackValue) {
  if (!preferences || typeof preferences.get !== 'function') {
    return fallbackValue;
  }

  const value = preferences.get(key);
  return typeof value === 'string' ? value : fallbackValue;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isRecapDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_RECAPS, false);
}

function isIntroDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_INTROS, true);
}

function isCreditDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CREDITS, true);
}

function isChapterTitleDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TITLES, true);
}

function isAudioMatchingEnabled() {
  return getBooleanPreference(PREF_DETECT_AUDIO_MATCHING, false);
}

function isAudioMatchEpisodeParsingEnabled() {
  return getBooleanPreference(PREF_AUDIO_MATCH_PARSE_EPISODE_NUMBERS, true);
}

function isChapterTimingDetectionEnabled() {
  return getBooleanPreference(PREF_DETECT_CHAPTER_TIMING, false);
}

function isVideoMatchingEnabled() {
  return getBooleanPreference(PREF_DETECT_VIDEO_MATCHING, false);
}

function isVideoMatchEpisodeParsingEnabled() {
  return getBooleanPreference(PREF_VIDEO_MATCH_PARSE_EPISODE_NUMBERS, true);
}

function isVideoMatchingAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_VIDEO_MATCHING, false);
}

function isVideoMatchingCreditsAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_VIDEO_MATCHING_CREDITS, false);
}

function isTitleIntroAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_INTROS, false);
}

function isTitleRecapAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_RECAPS, false);
}

function isTitleCreditsAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_TITLE_CREDITS, false);
}

function isAudioMatchingAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_AUDIO_MATCHING, false);
}

function isAudioMatchingCreditsAutoSkipEnabled() {
  return getBooleanPreference(PREF_AUTO_SKIP_AUDIO_MATCHING_CREDITS, false);
}

function getDetectionOptionsFromPreferences() {
  return {
    detectChapterTitles: isChapterTitleDetectionEnabled(),
    detectAudioMatching: isAudioMatchingEnabled(),
    parseAudioMatchEpisodeNumbers: isAudioMatchEpisodeParsingEnabled(),
    detectVideoMatching: isVideoMatchingEnabled(),
    parseVideoMatchEpisodeNumbers: isVideoMatchEpisodeParsingEnabled(),
    detectChapterTiming: isChapterTimingDetectionEnabled(),
    detectIntros: isIntroDetectionEnabled(),
    detectRecaps: isRecapDetectionEnabled(),
    detectCredits: isCreditDetectionEnabled(),
  };
}

function getPopupAutoDismissSeconds() {
  return clampNumber(
    getNumberPreference(PREF_POPUP_AUTO_DISMISS_SECONDS, INTRO_PROMPT_AUTO_DISMISS_SECONDS),
    INTRO_PROMPT_MIN_AUTO_DISMISS_SECONDS,
    INTRO_PROMPT_MAX_AUTO_DISMISS_SECONDS,
  );
}

function getSkipEndBufferSeconds() {
  return clampNumber(
    getNumberPreference(PREF_SKIP_END_BUFFER_SECONDS, SKIP_END_BUFFER_SECONDS),
    SKIP_END_MIN_BUFFER_SECONDS,
    SKIP_END_MAX_BUFFER_SECONDS,
  );
}

function getAutoSkipStartDelaySeconds() {
  return clampNumber(
    getNumberPreference(PREF_AUTO_SKIP_START_DELAY_SECONDS, AUTO_SKIP_START_DELAY_SECONDS),
    AUTO_SKIP_MIN_START_DELAY_SECONDS,
    AUTO_SKIP_MAX_START_DELAY_SECONDS,
  );
}

function shouldShowAutoSkipStatus() {
  return getBooleanPreference(PREF_SHOW_AUTO_SKIP_STATUS, true);
}

function shouldAutoSkipFirstEpisodeOfSeason() {
  return getBooleanPreference(PREF_AUTO_SKIP_FIRST_EPISODE_OF_SEASON, true);
}

function getPopupButtonStyle() {
  return getBooleanPreference(PREF_POPUP_BUTTON_GREY, false) ? 'grey' : 'white';
}

function getSkipKeyBinding() {
  return getStringPreference(PREF_SKIP_KEY_BINDING, '').trim();
}

function formatAudioDependencyName(dependency) {
  if (dependency === 'node') return 'Node.js';
  if (dependency === 'ffmpeg') return 'ffmpeg';
  return dependency;
}

function formatAudioDependencyList(missingDependencies) {
  const labels = missingDependencies.map(formatAudioDependencyName);
  if (labels.length <= 1) return labels[0] || '';
  return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
}

function showAudioDependencyWarning(missingDependencies) {
  if (!Array.isArray(missingDependencies) || !missingDependencies.length) return;

  const key = missingDependencies.slice().sort().join(',');
  if (shownAudioDependencyWarningKey === key) return;
  shownAudioDependencyWarningKey = key;

  const message =
    '跳过片头：音频指纹检测需要 ' +
    formatAudioDependencyList(missingDependencies) +
    '。请查阅 README.md 了解配置方法，或在设置中关闭音频匹配以隐藏此提示。';
  log(message);
}

function hasEnabledDetectionMethod(options) {
  return !!(
    options &&
    ((options.detectChapterTitles &&
      (options.detectIntros || options.detectRecaps || options.detectCredits)) ||
      options.detectAudioMatching ||
      options.detectVideoMatching ||
      options.detectChapterTiming)
  );
}

function getSectionTitles(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections)) return [];

  const titles = [];
  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const section = sectionGroup.sections[i];
    for (let j = 0; j < section.titles.length; j++) {
      titles.push(section.titles[j]);
    }
  }
  return titles;
}

function getSectionSources(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections)) return [];

  const sources = [];
  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const source = sectionGroup.sections[i].source;
    if (sources.indexOf(source) === -1) {
      sources.push(source);
    }
  }
  return sources;
}

function getSkipLabel(sectionGroup) {
  if (!sectionGroup) return '跳过片头';
  if (sectionGroup.sections.length > 1) return '跳过开场';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return '跳过片尾';
  if (kind === SECTION_KIND_RECAP) return '跳过回顾';
  if (kind === SECTION_KIND_SECTION) return '跳过开场';
  return '跳过片头';
}

function getSectionDescription(sectionGroup) {
  if (!sectionGroup) return 'section';
  if (sectionGroup.sections.length > 1) return 'opening';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return 'credits';
  if (kind === SECTION_KIND_RECAP) return 'recap';
  if (kind === SECTION_KIND_SECTION) return 'opening';
  return 'intro';
}

function getSectionLabelNoun(sectionGroup) {
  if (!sectionGroup) return '片头';
  if (sectionGroup.sections.length > 1) return '开场';

  const kind = sectionGroup.sections[0].kind;
  if (kind === SECTION_KIND_CREDITS) return '片尾';
  if (kind === SECTION_KIND_RECAP) return '回顾';
  if (kind === SECTION_KIND_SECTION) return '开场';
  return '片头';
}

function getAutoSkipPendingLabel(sectionGroup) {
  return 'Skipping ' + getSectionLabelNoun(sectionGroup);
}

function getAutoSkipCompleteLabel(sectionGroup) {
  return getSectionLabelNoun(sectionGroup) + ' Skipped';
}

function getAutoSkipSettingsFromPreferences() {
  return {
    titleIntros: isTitleIntroAutoSkipEnabled(),
    titleRecaps: isTitleRecapAutoSkipEnabled(),
    titleCredits: isTitleCreditsAutoSkipEnabled(),
    audioMatching: isAudioMatchingAutoSkipEnabled(),
    audioMatchingCredits: isAudioMatchingCreditsAutoSkipEnabled(),
    videoMatching: isVideoMatchingAutoSkipEnabled(),
    videoMatchingCredits: isVideoMatchingCreditsAutoSkipEnabled(),
    startDelaySeconds: getAutoSkipStartDelaySeconds(),
    showStatus: shouldShowAutoSkipStatus(),
    autoSkipFirstEpisodeOfSeason: shouldAutoSkipFirstEpisodeOfSeason(),
  };
}

function getAutoSkipSettingForTitleKind(kind, settings) {
  if (kind === SECTION_KIND_CREDITS) return settings.titleCredits;
  if (kind === SECTION_KIND_RECAP) return settings.titleRecaps;
  return settings.titleIntros;
}

function resolveAutoSkipForSection(sectionGroup, settings) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return false;
  }

  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const section = sectionGroup.sections[i];
    if (section.source === SECTION_SOURCE_AUDIO_FINGERPRINT) {
      if (section.kind === SECTION_KIND_CREDITS) {
        if (settings.audioMatchingCredits) return true;
      } else {
        if (settings.audioMatching) return true;
      }
      continue;
    }
    if (section.source === SECTION_SOURCE_VIDEO_FINGERPRINT) {
      if (section.kind === SECTION_KIND_CREDITS) {
        if (settings.videoMatchingCredits) return true;
      } else {
        if (settings.videoMatching) return true;
      }
      continue;
    }
    if (
      section.source === SECTION_SOURCE_TITLE &&
      getAutoSkipSettingForTitleKind(section.kind, settings)
    ) {
      return true;
    }
  }

  return false;
}

function isIntroLikeSectionGroup(sectionGroup) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return false;
  }

  for (let i = 0; i < sectionGroup.sections.length; i++) {
    const kind = sectionGroup.sections[i].kind;
    if (kind === SECTION_KIND_INTRO || kind === SECTION_KIND_SECTION) {
      return true;
    }
  }

  return false;
}

function shouldDisableIntroAutoSkipForFirstEpisodeOfSeason(sectionGroup, mediaPath, settings) {
  if (settings.autoSkipFirstEpisodeOfSeason || !isIntroLikeSectionGroup(sectionGroup)) return false;

  const parsed = parseSeasonEpisode(mediaPath);
  return !!(parsed && !parsed.isSpecial && parsed.episode === 1);
}

function addAutoSkipState(sectionGroups, mediaPath) {
  const settings = getAutoSkipSettingsFromPreferences();
  return sectionGroups.map(function (sectionGroup) {
    let autoSkip = resolveAutoSkipForSection(sectionGroup, settings);
    if (
      autoSkip &&
      shouldDisableIntroAutoSkipForFirstEpisodeOfSeason(sectionGroup, mediaPath, settings)
    ) {
      log('已禁用自动跳过：本季第一集不跳过片头');
      autoSkip = false;
    }
    return Object.assign({}, sectionGroup, {
      autoSkip: autoSkip,
      autoSkipStartDelaySeconds: autoSkip ? settings.startDelaySeconds : 0,
      showAutoSkipStatus: autoSkip && settings.showStatus,
    });
  });
}

function shouldAutoSkipSection(sectionGroup) {
  return !!(sectionGroup && sectionGroup.autoSkip);
}

function getNearestChapterStartInWindow(chapters, target, maxDistance) {
  if (!Array.isArray(chapters) || typeof target !== 'number' || !isFinite(target)) return null;

  let nearestStart = null;
  let nearestDistance = null;
  for (let i = 0; i < chapters.length; i++) {
    const chapterStart = getChapterStart(chapters[i]);
    if (chapterStart === null) continue;

    const distance = Math.abs(chapterStart - target);
    if (distance <= maxDistance && (nearestDistance === null || distance < nearestDistance)) {
      nearestStart = chapterStart;
      nearestDistance = distance;
    }
  }

  return nearestStart;
}

function snapAudioSectionGroupToChapters(sectionGroup, chapters) {
  if (!sectionGroup || !Array.isArray(sectionGroup.sections) || !sectionGroup.sections.length) {
    return sectionGroup;
  }

  const nearestStart = getNearestChapterStartInWindow(
    chapters,
    sectionGroup.start,
    AUDIO_MATCH_CHAPTER_SNAP_WINDOW,
  );
  const nearestEnd = getNearestChapterStartInWindow(
    chapters,
    sectionGroup.end,
    AUDIO_MATCH_CHAPTER_SNAP_WINDOW,
  );
  const snappedStart = nearestStart === null ? sectionGroup.start : nearestStart;
  const snappedEnd = nearestEnd === null ? sectionGroup.end : nearestEnd;

  if (snappedStart === sectionGroup.start && snappedEnd === sectionGroup.end) {
    return sectionGroup;
  }
  if (snappedEnd <= snappedStart) {
    return sectionGroup;
  }

  log(
    '已将音频片头吸附到章节标记：' +
      sectionGroup.start.toFixed(2) +
      's-' +
      sectionGroup.end.toFixed(2) +
      's -> ' +
      snappedStart.toFixed(2) +
      's-' +
      snappedEnd.toFixed(2) +
      's',
  );

  return Object.assign({}, sectionGroup, {
    start: snappedStart,
    end: snappedEnd,
    sections: sectionGroup.sections.map(function (currentSection, index) {
      if (index !== 0) return currentSection;
      return Object.assign({}, currentSection, {
        start: snappedStart,
        end: snappedEnd,
      });
    }),
  });
}

async function getDetectionContext(runId) {
  await delay(DURATION_READ_DELAY_MS);
  if (runId !== detectionRunId) return null;

  const currentPath = getCurrentMediaPath();
  if (!isVideoFilePath(currentPath)) {
    return {
      skipMessage: '跳过片头检测：当前文件不是受支持的视频文件',
    };
  }

  const duration = getDuration();
  if (!isDurationLongEnoughForDetection(duration)) {
    return {
      skipMessage:
        '跳过片头检测：时长未知或低于 ' +
        Math.round(DETECTION_MIN_DURATION / 60) +
        ' 分钟',
    };
  }

  let chapters = [];
  try {
    chapters = core.getChapters();
  } catch (error) {
    log('章节查询失败：' + error);
  }

  return {
    chapters: chapters,
    duration: duration,
    mediaPath: currentPath,
  };
}

function detectFromChapterTitles(context, options) {
  try {
    return detectSectionsFromChapterTitles(context.chapters, context.duration, options);
  } catch (error) {
    log('章节标题片头检测失败：' + error);
    return [];
  }
}

async function detectFromAudioMatch(context, options, runId) {
  if (!options.detectAudioMatching) return [];

  try {
    const dependencyStatus = await getAudioMatchDependencyStatus();
    if (runId !== detectionRunId) return null;

    if (!dependencyStatus.ok) {
      showAudioDependencyWarning(dependencyStatus.missing);
      return [];
    }

    const audioOptions = Object.assign({}, options, {
      duration: context && context.duration,
    });
    const audioSectionGroups = await detectSectionFromAudioMatch(audioOptions);
    if (runId !== detectionRunId) return null;

    if (!Array.isArray(audioSectionGroups) || !audioSectionGroups.length) {
      return [];
    }

  return audioSectionGroups.map(function (audioSectionGroup) {
    return snapAudioSectionGroupToChapters(audioSectionGroup, context.chapters);
  });
} catch (error) {
    if (runId !== detectionRunId) return null;
    log('音频片头检测失败：' + error);
    return [];
  }
}

async function detectFromVideoMatch(context, options, runId) {
  if (!options.detectVideoMatching) return [];

  try {
    const dependencyStatus = await getVideoMatchDependencyStatus();
    if (runId !== detectionRunId) return null;

    if (!dependencyStatus.ok) {
      showAudioDependencyWarning(dependencyStatus.missing);
      return [];
    }

    const videoOptions = Object.assign({}, options, {
      duration: context && context.duration,
    });
    const videoSectionGroups = await detectSectionFromVideoMatch(videoOptions);
    if (runId !== detectionRunId) return null;

    if (!Array.isArray(videoSectionGroups) || !videoSectionGroups.length) {
      return [];
    }

    return videoSectionGroups.map(function (videoSectionGroup) {
      return snapAudioSectionGroupToChapters(videoSectionGroup, context.chapters);
    });
  } catch (error) {
    if (runId !== detectionRunId) return null;
    log('视频指纹检测失败：' + error);
    return [];
  }
}

function detectFromChapterTiming(context, options) {
  try {
    return detectSectionsFromChapterTiming(context.chapters, context.duration, options);
  } catch (error) {
    log('章节时序片头检测失败：' + error);
    return [];
  }
}

function mergeSectionGroups(existing, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return existing;
  if (!Array.isArray(existing) || !existing.length) return incoming;

  var filtered = incoming.filter(function (incomingGroup) {
    var incomingDuration = incomingGroup.end - incomingGroup.start;
    for (var i = 0; i < existing.length; i++) {
      var existingGroup = existing[i];
      var overlapStart = Math.max(existingGroup.start, incomingGroup.start);
      var overlapEnd = Math.min(existingGroup.end, incomingGroup.end);
      var overlap = overlapEnd - overlapStart;
      if (overlap > 0 && overlap / incomingDuration > 0.7) {
        return false;
      }
    }
    return true;
  });

  return existing.concat(filtered);
}

function finishDetection(sections, emptyMessage, context) {
  detectedSections = addAutoSkipState(
    Array.isArray(sections) ? sections : [],
    context && context.mediaPath,
  );

  if (emptyMessage) {
    log(emptyMessage);
    updateOverlay();
    return;
  }

  if (!detectedSections.length) {
    log('未检测到可跳过的片段');
    updateOverlay();
    return;
  }

  for (let i = 0; i < detectedSections.length; i++) {
    const sectionGroup = detectedSections[i];
    log(
      '检测到 ' +
        getSectionDescription(sectionGroup) +
        '，区间为 ' +
        sectionGroup.start.toFixed(2) +
        's 至 ' +
        sectionGroup.end.toFixed(2) +
        's，来源：' +
        getSectionSources(sectionGroup).join(', ') +
        '，标题：' +
        getSectionTitles(sectionGroup).join(', '),
    );
  }

  updateOverlay();
}

async function detectCurrentSections() {
  const runId = ++detectionRunId;
  const initialOptions = getDetectionOptionsFromPreferences();

  if (!hasEnabledDetectionMethod(initialOptions)) {
    finishDetection([], '跳过片头检测：所有检测方式均已禁用');
    return;
  }

  const context = await getDetectionContext(runId);
  if (!context) return;
  if (context.skipMessage) {
    finishDetection([], context.skipMessage, context);
    return;
  }

  const options = getDetectionOptionsForDuration(initialOptions, context.duration);
  if (!hasEnabledDetectionMethod(options)) {
    finishDetection(
      [],
      '跳过片头检测：电影级媒体仅通过章节标题检测片尾',
      context,
    );
    return;
  }

  let sections = detectFromChapterTitles(context, options);

  // Always run audio fingerprint alongside chapter titles (not just as fallback).
  // This ensures credits can be detected even when chapter titles already found intros.
  if (options.detectAudioMatching) {
    let audioSections = await detectFromAudioMatch(context, options, runId);
    if (audioSections === null) return;
    sections = mergeSectionGroups(sections, audioSections);
  }

  // Run video fingerprint alongside other methods to complement detection.
  if (options.detectVideoMatching) {
    let videoSections = await detectFromVideoMatch(context, options, runId);
    if (videoSections === null) return;
    sections = mergeSectionGroups(sections, videoSections);
  }

  if (!sections.length) {
    sections = detectFromChapterTiming(context, options);
  }

  finishDetection(sections, null, context);

  // Background precompute adjacent files for seamless switching
  precomputeAdjacentFiles(context.mediaPath, options);
}

function precomputeAdjacentFiles(currentFile, options) {
  if (!options || !options.detectVideoMatching || !currentFile) return;

  const adjacent = getAdjacentPlaylistFiles(currentFile);
  const targets = [adjacent.next, adjacent.previous].filter(Boolean);
  if (!targets.length) return;

  const precomputeOptions = {
    parseVideoMatchEpisodeNumbers: options.parseVideoMatchEpisodeNumbers,
  };

  // Sequential precompute in background (don't block main flow, avoid too many concurrent ffmpeg)
  (async function () {
    for (let i = 0; i < targets.length; i++) {
      try {
        await precomputeVideoMatch(targets[i], precomputeOptions);
      } catch (e) {
        // ignore precompute errors
      }
    }
  })();
}

function isPlaybackPaused() {
  return !!(core.status && core.status.paused);
}

function clearAutoSkipStatusTimer() {
  if (autoSkipStatusHideTimer === null) return;
  clearTimeout(autoSkipStatusHideTimer);
  autoSkipStatusHideTimer = null;
}

function dismissOverlay() {
  if (currentOverlaySection) {
    dismissedSectionIds[currentOverlaySection.id] = true;
  }
  setOverlayVisible(false, null);
}

function skipSection(sectionGroup, reason, options) {
  if (!sectionGroup) {
    log('触发跳过时未检测到对应片段');
    dismissOverlay();
    return;
  }

  const bufferSeconds = getSkipEndBufferSeconds();
  const seekTarget = Math.max(sectionGroup.start, sectionGroup.end - bufferSeconds);
  log(reason + ' - seeking to ' + seekTarget.toFixed(2) + 's');
  core.seekTo(seekTarget);
  dismissedSectionIds[sectionGroup.id] = true;
  if (
    !(options && options.keepOverlayVisible) &&
    currentOverlaySection &&
    currentOverlaySection.id === sectionGroup.id
  ) {
    setOverlayVisible(false, null);
  }
}

function handleSkipKeyDown(data) {
  if (!overlayVisible || overlayMode !== 'prompt' || !currentOverlaySection) {
    return false;
  }

  if (data && data.isRepeat) {
    return true;
  }

  skipSection(currentOverlaySection, '通过快捷键触发跳过');
  return true;
}

function unregisterSkipKeyBinding() {
  if (!registeredSkipKeyBinding || !input || typeof input.onKeyDown !== 'function') return;

  try {
    input.onKeyDown(registeredSkipKeyBinding, null);
  } catch (error) {
    log('跳过快捷键注销失败：' + error);
  }
  registeredSkipKeyBinding = null;
}

function syncSkipKeyBinding() {
  if (!input || typeof input.onKeyDown !== 'function') return;

  const keyBinding = getSkipKeyBinding();
  if (keyBinding === registeredSkipKeyBinding) return;

  unregisterSkipKeyBinding();
  if (!keyBinding) return;

  try {
    input.onKeyDown(keyBinding, handleSkipKeyDown);
    registeredSkipKeyBinding = keyBinding;
    log('已注册跳过快捷键：' + keyBinding);
  } catch (error) {
    log('跳过快捷键注册失败（"' + keyBinding + '"）：' + error);
  }
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  syncSkipKeyBinding();

  overlay.onMessage('skip', function () {
    skipSection(currentOverlaySection, '用户点击跳过');
  });

  overlay.onMessage('autoDismiss', function () {
    if (!overlayVisible || !currentOverlaySection) return;

    log('在 ' + getPopupAutoDismissSeconds() + ' 秒后自动消失');
    dismissOverlay();
  });

  overlay.onMessage('error', function (msg) {
    log('叠加层错误：' + msg);
  });
}

function initializeOverlay() {
  if (overlayInitialized || !core.window.loaded) return;
  overlayInitialized = true;
  log('正在初始化叠加层');

  overlay.loadFile('overlay.html');
}

function sendState(visible, sectionGroup, options) {
  const resolvedOptions = options || {};
  const mode = resolvedOptions.mode === 'status' ? 'status' : 'prompt';
  const autoDismissSeconds = getPopupAutoDismissSeconds();
  overlayVisible = visible;
  overlayMode = visible ? mode : null;
  currentOverlaySection = visible && mode === 'prompt' ? sectionGroup : null;
  if (!visible || mode !== 'status') {
    autoSkipStatusSectionId = null;
    autoSkipStatusPhase = null;
  }
  overlay.postMessage('state', {
    visible: visible,
    sectionId: sectionGroup ? sectionGroup.id : null,
    mode: mode,
    autoDismissMs: autoDismissSeconds * 1000,
    playbackPaused: isPlaybackPaused(),
    label: resolvedOptions.label || null,
    skipLabel: getSkipLabel(sectionGroup),
    buttonStyle: getPopupButtonStyle(),
  });
}

function setOverlayVisible(visible, sectionGroup, options) {
  const mode = options && options.mode === 'status' ? 'status' : 'prompt';
  sendState(visible, sectionGroup, options);
  overlay.setClickable(visible && mode === 'prompt');
}

function hideAutoSkipStatus(sectionId) {
  if (sectionId && autoSkipStatusSectionId !== sectionId) return;
  if (overlayMode === 'status') {
    setOverlayVisible(false, null);
  }
}

function showAutoSkipStatus(sectionGroup, phase) {
  if (!sectionGroup) return;

  if (
    overlayVisible &&
    overlayMode === 'status' &&
    autoSkipStatusSectionId === sectionGroup.id &&
    autoSkipStatusPhase === phase
  ) {
    return;
  }

  clearAutoSkipStatusTimer();
  autoSkipStatusSectionId = sectionGroup.id;
  autoSkipStatusPhase = phase;
  setOverlayVisible(true, sectionGroup, {
    mode: 'status',
    label:
      phase === 'complete'
        ? getAutoSkipCompleteLabel(sectionGroup)
        : getAutoSkipPendingLabel(sectionGroup),
  });

  if (phase === 'complete') {
    autoSkipStatusHideTimer = setTimeout(function () {
      autoSkipStatusHideTimer = null;
      hideAutoSkipStatus(sectionGroup.id);
    }, AUTO_SKIP_STATUS_AFTER_SECONDS * 1000);
  }
}

function getActiveSection(position, leadInSeconds) {
  const resolvedLeadInSeconds =
    typeof leadInSeconds === 'number' && isFinite(leadInSeconds)
      ? leadInSeconds
      : INTRO_PROMPT_LEAD_IN;

  for (let i = 0; i < detectedSections.length; i++) {
    const sectionGroup = detectedSections[i];
    if (dismissedSectionIds[sectionGroup.id]) continue;

    if (
      position >= Math.max(0, sectionGroup.start - resolvedLeadInSeconds) &&
      position < sectionGroup.end
    ) {
      return sectionGroup;
    }
  }

  return null;
}

function updateOverlay(position) {
  if (!overlayReady) return;
  syncSkipKeyBinding();

  if (typeof position !== 'number') {
    position = getPosition();
  }
  if (typeof position !== 'number' || !isFinite(position)) {
    return;
  }

  const activeAutoSkipSection = getActiveSection(position, AUTO_SKIP_STATUS_LEAD_IN_SECONDS);
  if (activeAutoSkipSection && shouldAutoSkipSection(activeAutoSkipSection)) {
    if (overlayVisible && overlayMode === 'prompt') {
      setOverlayVisible(false, null);
    }
    if (
      position <
      activeAutoSkipSection.start + activeAutoSkipSection.autoSkipStartDelaySeconds
    ) {
      if (activeAutoSkipSection.showAutoSkipStatus) {
        showAutoSkipStatus(activeAutoSkipSection, 'pending');
      }
      return;
    }

    skipSection(
      activeAutoSkipSection,
      '已触发自动跳过：' + getSectionDescription(activeAutoSkipSection),
      {
        keepOverlayVisible: activeAutoSkipSection.showAutoSkipStatus,
      },
    );
    if (activeAutoSkipSection.showAutoSkipStatus) {
      showAutoSkipStatus(activeAutoSkipSection, 'complete');
    }
    return;
  }

  if (overlayMode === 'status') {
    if (autoSkipStatusPhase === 'pending') {
      setOverlayVisible(false, null);
    }
    return;
  }

  const activeSection = getActiveSection(position);
  const show = !!activeSection;
  const sectionChanged =
    (!currentOverlaySection && !!activeSection) ||
    (!!currentOverlaySection && !activeSection) ||
    (!!currentOverlaySection && !!activeSection && currentOverlaySection.id !== activeSection.id);
  if (show === overlayVisible && !sectionChanged) return;

  log(
    (show ? '显示' : '隐藏') +
      ' 叠加层，位置 ' +
      position.toFixed(2) +
      's' +
      (show ? '，片段：' + getSectionDescription(activeSection) : ''),
  );
  setOverlayVisible(show, activeSection);
}

function resetState() {
  detectionRunId++;
  clearAutoSkipStatusTimer();
  dismissedSectionIds = Object.create(null);
  detectedSections = [];
  currentOverlaySection = null;
  if (overlayReady) {
    setOverlayVisible(false, null);
    return;
  }
  overlayVisible = false;
}

event.on('iina.window-loaded', function () {
  log('窗口已加载');
  initializeOverlay();
});

event.on('iina.plugin-overlay-loaded', function () {
  log('叠加层视图已加载');
  overlayReady = true;
  overlay.show();
  overlay.setClickable(false);
  registerHandlers();
  updateOverlay();
});

event.on('mpv.file-loaded', function () {
  log('文件已加载');
  resetState();
  detectCurrentSections();
  updateOverlay();
});

event.on('mpv.end-file', function () {
  resetState();
});

event.on('mpv.time-pos.changed', function () {
  updateOverlay();
});

event.on('mpv.pause.changed', function () {
  if (overlayReady && overlayVisible) {
    overlay.postMessage('playbackPaused', isPlaybackPaused());
  }
});

// Attempt init immediately in case window is already loaded
initializeOverlay();
