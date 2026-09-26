import { createHash } from "node:crypto";

const ENDPOINT_BY_PATH = new Map([
  ["/aweme/v1/web/history/read/", "watch_history"],
  ["/aweme/v1/web/aweme/favorite/", "liked_videos"],
  ["/aweme/v1/web/aweme/listcollection/", "favorite_videos"],
  ["/aweme/v1/web/collects/list/", "favorite_folders"],
  ["/aweme/v1/web/collects/video/list/", "favorite_videos"],
]);

const RECORD_TYPES = ["watch_history", "liked_videos", "favorite_videos"];
const RELIABLE_EVENT_SOURCES = new Set(["platform_action", "archive_action"]);
const MAX_RECORDS_PER_TYPE = 50_000;
const MAX_STRING_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;
const MAX_TOPICS = 100;
const MAX_TOPIC_LENGTH = 100;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const IMAGE_HOST_SUFFIXES = [
  "douyin.com",
  "douyinpic.com",
  "douyinvod.com",
  "byteimg.com",
  "ibytedtos.com",
  "snssdk.com",
];

export class CollectorAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollectorAdapterError";
    this.code = code;
  }
}

export function createEmptyRecords() {
  return {
    watch_history: [],
    liked_videos: [],
    favorite_videos: [],
  };
}

export function matchDouyinEndpoint(value) {
  try {
    const url = new URL(value);
    if (!["www.douyin.com", "www-hj.douyin.com"].includes(url.hostname)) return null;
    // 观看历史的「直播」分栏；同一路径也给首页直播推荐用，只认这个 source_key
    if (url.pathname === "/webcast/feed/") {
      return url.searchParams.get("source_key") === "drawer_hot_live_history"
        ? { kind: "live_history", pathname: url.pathname }
        : null;
    }
    const kind = ENDPOINT_BY_PATH.get(url.pathname);
    return kind ? { kind, pathname: url.pathname } : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value, limit = MAX_STRING_LENGTH) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, limit);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, limit);
  return null;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = cleanString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstObject(value, key) {
  if (!isObject(value)) return null;
  const child = value[key];
  return isObject(child) ? child : null;
}

function firstList(payload, key) {
  if (!isObject(payload)) return null;
  if (Array.isArray(payload[key])) return payload[key];
  const data = firstObject(payload, "data");
  return data && Array.isArray(data[key]) ? data[key] : null;
}

function firstValue(payload, key) {
  if (!isObject(payload)) return undefined;
  if (payload[key] !== undefined) return payload[key];
  return firstObject(payload, "data")?.[key];
}

function normalizePagination(payload) {
  const rawHasMore = firstValue(payload, "has_more");
  const hasMore = typeof rawHasMore === "boolean"
    ? rawHasMore
    : rawHasMore === 1 || rawHasMore === "1"
      ? true
      : rawHasMore === 0 || rawHasMore === "0"
        ? false
        : null;
  const cursor = firstString(
    firstValue(payload, "max_cursor"),
    firstValue(payload, "cursor"),
    firstValue(payload, "min_cursor"),
  );
  return { hasMore, cursor };
}

function normalizeNonNegativeInteger(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function favoriteFolderTotal(payload) {
  return normalizeNonNegativeInteger(firstValue(payload, "total") ?? firstValue(payload, "total_number"));
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = typeof value === "string" ? value.trim() : value;
  if (!raw) return null;
  const numeric = Number(raw);
  const milliseconds = Number.isFinite(numeric) && numeric > 0
    ? numeric < 10_000_000_000 ? numeric * 1000 : numeric
    : Number.NaN;
  const date = Number.isFinite(milliseconds) ? new Date(milliseconds) : new Date(String(raw));
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100
    ? date.toISOString()
    : null;
}

function watchHistoryEventId(videoId, occurredAt, source) {
  return videoId && occurredAt && RELIABLE_EVENT_SOURCES.has(source)
    ? `watch_history:${videoId}:${occurredAt}`
    : null;
}

function eventTimestamp(item, recordType, mappedHistoryTime) {
  if (!isObject(item)) return { value: null, source: "unknown" };
  const history = firstObject(item, "history_info") ?? firstObject(item, "historyInfo");
  const playback = firstObject(item, "play_progress") ?? firstObject(item, "playProgress");
  const candidates = recordType === "watch_history"
    ? [
        mappedHistoryTime,
        history?.view_time, history?.watch_time,
        history?.history_time, item.view_time, item.watch_time,
        item.history_time, item.last_view_time, item.event_time,
      ]
    : [playback?.last_modified_time, playback?.lastModifiedTime];

  for (const candidate of candidates) {
    const normalized = normalizeTimestamp(candidate);
    if (normalized) return { value: normalized, source: "platform_action" };
  }
  return { value: null, source: "unknown" };
}

function normalizeImageUrl(value) {
  const candidate = cleanString(value, MAX_URL_LENGTH);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLocaleLowerCase();
    if (parsed.protocol !== "https:" || !IMAGE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
      return null;
    }
    return parsed.toString().slice(0, MAX_URL_LENGTH);
  } catch {
    return null;
  }
}

function normalizeVideoUrl(value, awemeId) {
  const fallback = `https://www.douyin.com/video/${encodeURIComponent(awemeId)}`;
  const candidate = cleanString(value, MAX_URL_LENGTH);
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "douyin.com" || parsed.hostname.endsWith(".douyin.com"))
    ) {
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().slice(0, MAX_URL_LENGTH);
    }
  } catch {
    // Use the stable URL when a response contains a malformed share URL.
  }
  return fallback;
}

function normalizeCount(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_000_000_000_000 ? numeric : null;
}

function normalizeDuration(value, unit = "auto") {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const seconds = unit === "milliseconds" || (unit === "auto" && numeric > 1_000)
    ? numeric / 1_000
    : numeric;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_DURATION_SECONDS
    ? Math.round(seconds * 100) / 100
    : null;
}

function normalizePercent(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return percent <= 100 ? Math.round(percent * 100) / 100 : null;
}

function firstUrlFromObject(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const normalized = firstUrlFromObject(item);
      if (normalized) return normalized;
    }
    return null;
  }
  if (!isObject(value)) return normalizeImageUrl(value);
  for (const key of keys) {
    const direct = firstUrlFromObject(value[key]);
    if (direct) return direct;
  }
  const list = value.url_list ?? value.urlList ?? value.urls;
  if (Array.isArray(list)) {
    for (const item of list) {
      const normalized = normalizeImageUrl(item);
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizeMusic(item) {
  const music = firstObject(item, "music") ?? firstObject(item, "music_info");
  if (!music) return null;
  const result = {};
  const id = firstString(music.id, music.music_id, music.musicId);
  const title = firstString(music.title, music.name);
  const author = firstString(music.author, music.author_name, firstObject(music, "owner")?.nickname);
  const url = firstUrlFromObject(music, ["play_url", "playUrl"]);
  if (id) result.id = id;
  if (title) result.title = title;
  if (author) result.author = author;
  if (url) result.url = url;
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeTopics(item, title) {
  const topics = [];
  const add = (value) => {
    const normalized = cleanString(value, MAX_TOPIC_LENGTH)?.replace(/^#/u, "");
    if (normalized && !topics.includes(normalized) && topics.length < MAX_TOPICS) topics.push(normalized);
  };
  for (const list of [item.cha_list, item.chaList, item.text_extra, item.textExtra]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") add(entry);
      else if (isObject(entry)) add(entry.cha_name ?? entry.hashtag_name ?? entry.name ?? entry.text);
    }
  }
  if (typeof title === "string") {
    for (const match of title.matchAll(/#([^#\s,，。！？!?;；]{1,100})/gu)) add(match[1]);
  }
  return topics;
}

function normalizeStats(item) {
  const source = firstObject(item, "statistics") ?? firstObject(item, "stats") ?? {};
  const aliases = {
    playCount: ["play_count", "playCount", "view_count", "viewCount"],
    diggCount: ["digg_count", "diggCount", "like_count", "likeCount"],
    commentCount: ["comment_count", "commentCount"],
    shareCount: ["share_count", "shareCount"],
    collectCount: ["collect_count", "collectCount", "favorite_count", "favoriteCount"],
    downloadCount: ["download_count", "downloadCount"],
  };
  const result = {};
  for (const [name, keys] of Object.entries(aliases)) {
    const count = normalizeCount(keys.map((key) => source[key]).find((value) => value !== undefined));
    if (count !== null) result[name] = count;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeProgress(item, durationSeconds) {
  const history = firstObject(item, "history_info") ?? firstObject(item, "historyInfo");
  const playback = firstObject(item, "play_progress") ?? firstObject(item, "playProgress");
  if (!history && !playback) return null;
  const result = {};
  const watchedValue = history?.watched_duration ?? history?.watchedDuration ?? history?.watch_duration ?? history?.view_duration
    ?? playback?.play_progress ?? playback?.playProgress;
  const watched = normalizeDuration(watchedValue, "milliseconds");
  if (watched !== null) result.watchedSeconds = watched;
  let percent = normalizePercent(history?.play_progress ?? history?.playProgress ?? history?.progress ?? history?.percent);
  if (percent === null && watched !== null && durationSeconds > 0) {
    percent = Math.min(100, Math.round(Number(watchedValue) / 1_000 / durationSeconds * 10_000) / 100);
  }
  if (percent !== null) result.percent = percent;
  if (result.watchedSeconds === undefined && durationSeconds !== null && percent !== null) {
    result.watchedSeconds = Math.round(durationSeconds * percent / 100 * 100) / 100;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeMediaType(item) {
  if (item.is_live === true || item.media_type === "live" || item.mediaType === "live") return "live";
  if (Array.isArray(item.images) || Array.isArray(item.image_list) || Array.isArray(item.imageList)) return "image";
  if (isObject(item.video) || item.aweme_type === 0 || item.aweme_type === 4 || item.media_type === "video" || item.mediaType === "video") return "video";
  if (item.aweme_type !== undefined) {
    const value = cleanString(item.aweme_type)?.toLocaleLowerCase();
    if (value === "image" || value === "video" || value === "live") return value;
  }
  return null;
}

export function normalizeAweme(item, recordType, historyDates) {
  if (!isObject(item)) return null;
  const author = firstObject(item, "author");
  const shareInfo = firstObject(item, "share_info");
  const awemeId = firstString(item.aweme_id, item.awemeId, item.item_id, item.group_id);
  if (!awemeId) return null;

  const title = firstString(item.desc, item.caption, item.item_title, item.preview_title) ?? "未命名视频";
  const authorName = firstString(author?.nickname, author?.unique_id, item.author_name);
  const rawShareUrl = firstString(item.share_url, shareInfo?.share_url);
  const mappedHistoryTime = historyDates && Object.hasOwn(historyDates, awemeId)
    ? historyDates[awemeId]
    : undefined;
  const event = eventTimestamp(item, recordType, mappedHistoryTime);
  const video = firstObject(item, "video");
  const durationSeconds = normalizeDuration(
    video?.duration ?? item.duration ?? item.duration_seconds ?? item.durationSeconds,
    video?.duration !== undefined ? "milliseconds" : "auto",
  );
  const result = {
    id: recordType === "watch_history"
      ? watchHistoryEventId(awemeId, event.value, event.source) ?? `${recordType}:${awemeId}`
      : `${recordType}:${awemeId}`,
    title,
    author: authorName,
    occurredAt: event.value,
    url: normalizeVideoUrl(rawShareUrl, awemeId),
    videoId: awemeId,
  };

  const authorId = firstString(author?.uid, author?.sec_uid, author?.secUid, item.author_id);
  const authorAvatarUrl = firstUrlFromObject(
    author?.avatar_thumb ?? author?.avatar_medium ?? author?.avatar_larger,
    [],
  );
  const publishedAt = normalizeTimestamp(item.create_time ?? item.createTime ?? item.publish_time ?? item.published_at);
  const coverUrl = firstUrlFromObject(
    video?.cover ?? video?.origin_cover ?? video?.dynamic_cover ?? item.cover,
    [],
  );
  const mediaType = normalizeMediaType(item);
  const music = normalizeMusic(item);
  const topics = normalizeTopics(item, title);
  const stats = normalizeStats(item);
  const watchProgress = normalizeProgress(item, durationSeconds);

  if (authorId) result.authorId = authorId;
  if (authorAvatarUrl) result.authorAvatarUrl = authorAvatarUrl;
  result.occurredAtSource = event.source;
  if (publishedAt) result.publishedAt = publishedAt;
  if (coverUrl) result.coverUrl = coverUrl;
  if (mediaType) result.mediaType = mediaType;
  if (durationSeconds !== null) result.durationSeconds = durationSeconds;
  if (music) result.music = music;
  if (topics.length > 0) result.topics = topics;
  if (stats) result.stats = stats;
  if (watchProgress) result.watchProgress = watchProgress;
  return result;
}

// 直播观看记录：每位主播只有一条「最近一次观看时间」（微秒），没有直播间标题和观看时长。
// 按观看历史存、id 带时间，所以隔几天再看同一位主播会攒出新的一条。
function normalizeLiveRecord(item) {
  const live = firstObject(item, "UserLiveRecord");
  const user = firstObject(item, "user_info");
  const anchorId = firstString(live?.user_id_str);
  // 微秒和毫秒除以 1000 后 normalizeTimestamp 都能认对
  const watchedAt = normalizeTimestamp(Number(item.latest_watch_time_str ?? item.latest_watch_time) / 1000);
  if (!anchorId || !watchedAt || user?.user_canceled === true) return null;
  const videoId = `live-${anchorId}`;
  const author = firstString(live.nickname);
  const webRid = firstString(user?.web_rid, item.web_rid);
  const result = {
    id: watchHistoryEventId(videoId, watchedAt, "platform_action"),
    title: author ? `${author}的直播` : "看过的直播",
    author,
    occurredAt: watchedAt,
    url: webRid && /^\d{1,30}$/u.test(webRid) ? `https://live.douyin.com/${webRid}` : null,
    videoId,
    authorId: anchorId,
    occurredAtSource: "platform_action",
    mediaType: "live",
  };
  const avatar = firstUrlFromObject(live.avatar);
  if (avatar) {
    result.authorAvatarUrl = avatar;
    // 直播没有封面，拿主播头像顶上；图床按路径里的尺寸出图，100x100 撑满卡片会糊
    result.coverUrl = avatar.replace("/100x100/", "/720x720/");
  }
  return result;
}

function normalizeOptionalString(value, limit = MAX_STRING_LENGTH) {
  return cleanString(value, limit);
}

function normalizeRecordUrl(value) {
  const candidate = cleanString(value, MAX_URL_LENGTH);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "douyin.com" || parsed.hostname.endsWith(".douyin.com"))
    ) {
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().slice(0, MAX_URL_LENGTH);
    }
  } catch {
    // Invalid links are intentionally dropped at the collector boundary.
  }
  return null;
}

function videoIdFromWatchHistoryId(id, occurredAt) {
  if (!id.startsWith("watch_history:")) return null;
  const body = id.slice("watch_history:".length);
  if (!occurredAt) return body.slice(0, 200) || null;
  const timestamped = body.match(/^(.+?)(?::|@|\|)(\d{10,13}|\d{4}-\d{2}-\d{2}[T ].+)$/u);
  if (timestamped?.[1] && normalizeTimestamp(timestamped[2]) === occurredAt) {
    return timestamped[1].slice(0, 200);
  }
  return body.slice(0, 200) || null;
}

function deriveVideoId(record, occurredAt = null) {
  const direct = normalizeOptionalString(record.videoId, 200);
  if (direct) return direct;
  const id = normalizeOptionalString(record.id, 300);
  const watchHistoryId = id ? videoIdFromWatchHistoryId(id, occurredAt) : null;
  if (watchHistoryId) return watchHistoryId;
  if (id && /^[^:]+:(.+)$/u.test(id)) return id.replace(/^[^:]+:/u, "").slice(0, 200);
  const url = normalizeRecordUrl(record.url);
  if (url) {
    try {
      const match = new URL(url).pathname.match(/\/video\/([^/?#]+)/u);
      if (match?.[1]) return decodeURIComponent(match[1]).slice(0, 200);
    } catch {
      // Ignore malformed URL values.
    }
  }
  return null;
}

function normalizeStatsObject(value) {
  if (!isObject(value)) return null;
  const result = {};
  for (const key of ["playCount", "diggCount", "commentCount", "shareCount", "collectCount", "downloadCount"]) {
    const count = normalizeCount(value[key]);
    if (count !== null) result[key] = count;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeMusicObject(value) {
  if (!isObject(value)) return null;
  const result = {};
  for (const key of ["id", "title", "author"]) {
    const normalized = normalizeOptionalString(value[key]);
    if (normalized) result[key] = normalized;
  }
  const url = normalizeImageUrl(value.url) ?? normalizeRecordUrl(value.url);
  if (url) result.url = url;
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeProgressObject(value) {
  if (!isObject(value)) return null;
  const result = {};
  const seconds = normalizeDuration(value.watchedSeconds ?? value.watched_seconds, "seconds");
  const percent = normalizePercent(value.percent ?? value.progress);
  if (seconds !== null) result.watchedSeconds = seconds;
  if (percent !== null) result.percent = percent;
  return Object.keys(result).length > 0 ? result : null;
}

/** Normalize a record received from the local collector or a persisted file. */
export function normalizeRecord(value, timestampSource = "unknown") {
  if (!isObject(value)) return null;
  const rawId = normalizeOptionalString(value.id, 300);
  const title = normalizeOptionalString(value.title) ?? "Untitled video";
  if (!rawId) return null;
  const occurredAt = normalizeTimestamp(value.occurredAt);
  const source = ["platform_action", "archive_action", "unknown"].includes(value.occurredAtSource)
    ? value.occurredAtSource
    : occurredAt && RELIABLE_EVENT_SOURCES.has(timestampSource)
      ? timestampSource
      : "unknown";
  const videoId = deriveVideoId(value, occurredAt);
  const result = {
    id: rawId.startsWith("watch_history:")
      ? watchHistoryEventId(videoId, occurredAt, source) ?? rawId
      : rawId,
    title,
    author: normalizeOptionalString(value.author),
    occurredAt,
    url: normalizeRecordUrl(value.url),
  };
  if (videoId) result.videoId = videoId;
  const authorId = normalizeOptionalString(value.authorId, 200);
  const authorAvatarUrl = normalizeImageUrl(value.authorAvatarUrl ?? value.authorAvatar ?? value.avatarUrl);
  const publishedAt = normalizeTimestamp(value.publishedAt);
  const coverUrl = normalizeImageUrl(value.coverUrl ?? value.cover);
  const mediaType = ["video", "image", "live", "unknown"].includes(value.mediaType) ? value.mediaType : null;
  const durationSeconds = normalizeDuration(value.durationSeconds ?? value.duration, "seconds");
  const music = normalizeMusicObject(value.music);
  const topics = Array.isArray(value.topics)
    ? [...new Set(value.topics.flatMap((topic) => {
        const normalized = normalizeOptionalString(topic, MAX_TOPIC_LENGTH)?.replace(/^#/u, "");
        return normalized ? [normalized] : [];
      }))].slice(0, MAX_TOPICS)
    : [];
  const stats = normalizeStatsObject(value.stats ?? value.statistics);
  const watchProgress = normalizeProgressObject(value.watchProgress ?? value.progress);
  if (authorId) result.authorId = authorId;
  if (authorAvatarUrl) result.authorAvatarUrl = authorAvatarUrl;
  result.occurredAtSource = source;
  if (publishedAt) result.publishedAt = publishedAt;
  if (coverUrl) result.coverUrl = coverUrl;
  if (mediaType) result.mediaType = mediaType;
  if (durationSeconds !== null) result.durationSeconds = durationSeconds;
  if (music) result.music = music;
  if (topics.length > 0) result.topics = topics;
  if (stats) result.stats = stats;
  if (watchProgress) result.watchProgress = watchProgress;
  return result;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function isPlaceholderTitle(value) {
  return value === "Untitled video" || value === "未命名视频";
}

function mergeNested(existing, incoming, normalizer) {
  const left = normalizer(existing);
  const right = normalizer(incoming);
  if (!left) return right;
  if (!right) return left;
  return { ...left, ...right };
}

/** Merge a fresh response into an existing record without erasing rich fields. */
export function mergeRecords(existing, incoming) {
  const left = normalizeRecord(existing);
  const right = normalizeRecord(incoming);
  if (!left) return right;
  if (!right) return left;
  const merged = { ...left, ...right };
  for (const key of ["title", "author", "occurredAt", "url", "videoId", "authorId", "authorAvatarUrl", "publishedAt", "coverUrl", "mediaType", "durationSeconds"]) {
    if (!hasValue(right[key]) && hasValue(left[key])) merged[key] = left[key];
  }
  if (isPlaceholderTitle(right.title) && !isPlaceholderTitle(left.title)) merged.title = left.title;
  if (left.occurredAt && !right.occurredAt) {
    merged.occurredAt = left.occurredAt;
    merged.occurredAtSource = left.occurredAtSource;
  }
  if (left.occurredAtSource === "platform_action" && right.occurredAtSource !== "platform_action") {
    merged.occurredAtSource = left.occurredAtSource;
  }
  const topics = [...new Set([...(left.topics ?? []), ...(right.topics ?? [])])].slice(0, MAX_TOPICS);
  if (topics.length > 0) merged.topics = topics;
  const stats = mergeNested(left.stats, right.stats, normalizeStatsObject);
  if (stats) merged.stats = stats;
  const music = mergeNested(left.music, right.music, normalizeMusicObject);
  if (music) merged.music = music;
  const progress = mergeNested(left.watchProgress, right.watchProgress, normalizeProgressObject);
  if (progress) merged.watchProgress = progress;
  return merged;
}

function fingerprintRecordPage(records) {
  if (records.length === 0) return null;
  const hash = createHash("sha256");
  for (const id of records.map((record) => record.id).sort()) {
    hash.update(id);
    hash.update("\0");
  }
  return hash.digest("base64url");
}

function normalizeFolders(payload) {
  const items = firstList(payload, "collects_list");
  if (!items) {
    const rawItems = firstValue(payload, "collects_list");
    const pagination = normalizePagination(payload);
    if (rawItems === null && pagination.hasMore === false && favoriteFolderTotal(payload) === 0) return [];
    throw new CollectorAdapterError("schema_changed", "收藏夹响应缺少 collects_list。请更新采集器适配器。");
  }

  return items.flatMap((item) => {
    if (!isObject(item)) return [];
    const id = firstString(item.collects_id_str, item.collects_id);
    const name = firstString(item.collects_name, item.name);
    return id && name ? [{ id, name }] : [];
  });
}

function statusCode(payload) {
  if (!isObject(payload)) return null;
  const value = payload.status_code ?? firstObject(payload, "data")?.status_code;
  return typeof value === "number" ? value : null;
}

export function normalizeDouyinResponse(endpoint, payload) {
  if (!endpoint || (endpoint.kind !== "live_history" && !ENDPOINT_BY_PATH.has(endpoint.pathname))) {
    throw new CollectorAdapterError("unsupported_endpoint", "采集器收到了不支持的抖音响应。");
  }
  if (!isObject(payload)) {
    throw new CollectorAdapterError("invalid_response", "抖音返回了非 JSON 对象。");
  }

  const code = statusCode(payload);
  if (code === 8) {
    throw new CollectorAdapterError("login_required", "抖音登录已失效，请在采集器的浏览器里重新登录。");
  }
  if (code !== null && code !== 0) {
    throw new CollectorAdapterError("douyin_error", `抖音网页返回状态码 ${code}。`);
  }

  if (endpoint.kind === "favorite_folders") {
    const folders = normalizeFolders(payload);
    let pagination = normalizePagination(payload);
    const total = favoriteFolderTotal(payload);
    if (
      pagination.hasMore === null
      && total !== null
      && folders.length >= total
    ) {
      pagination = { ...pagination, hasMore: false };
    }
    return { records: [], folders, pagination };
  }

  if (endpoint.kind === "live_history") {
    if (!Array.isArray(payload.data)) {
      throw new CollectorAdapterError("schema_changed", "直播观看记录响应缺少 data。请更新采集器适配器。");
    }
    const extra = firstObject(payload, "extra");
    return {
      // type 11 是「今天 / 更早看过」这类日期分隔行，没有 UserLiveRecord，会被过滤掉
      records: payload.data.flatMap((item) => {
        const record = isObject(item) ? normalizeLiveRecord(item) : null;
        return record ? [record] : [];
      }),
      folders: [],
      pagination: {
        hasMore: typeof extra?.has_more === "boolean" ? extra.has_more : null,
        cursor: firstString(extra?.max_time_str),
      },
    };
  }

  const items = firstList(payload, "aweme_list");
  if (!items) {
    throw new CollectorAdapterError("schema_changed", "视频响应缺少 aweme_list。请更新采集器适配器。");
  }

  const historyDates = endpoint.kind === "watch_history" && isObject(firstValue(payload, "aweme_date"))
    ? firstValue(payload, "aweme_date")
    : null;
  const records = items.flatMap((item) => {
    const record = normalizeAweme(item, endpoint.kind, historyDates);
    return record ? [record] : [];
  });
  if (items.length > 0 && records.length === 0) {
    throw new CollectorAdapterError("schema_changed", "视频列表包含无法识别的数据。请更新采集器适配器。");
  }

  return {
    records,
    folders: [],
    pagination: normalizePagination(payload),
  };
}

export class RecordAccumulator {
  constructor(initialRecords = createEmptyRecords()) {
    this.records = createEmptyRecords();
    this.folders = new Map();
    this.truncatedTypes = new Set();
    for (const type of RECORD_TYPES) this.addRecords(type, initialRecords[type] ?? []);
  }

  addResponse(endpoint, payload) {
    const normalized = normalizeDouyinResponse(endpoint, payload);
    if (endpoint.kind === "favorite_folders") {
      for (const folder of normalized.folders) this.folders.set(folder.id, folder);
      return {
        added: normalized.folders.length,
        pageSize: normalized.folders.length,
        pageFingerprint: null,
        type: endpoint.kind,
        pagination: normalized.pagination,
      };
    }
    const acceptedRecords = normalized.records;
    const acceptedIds = new Set(acceptedRecords.map((record) => record.id));
    return {
      added: this.addRecords(endpoint.kind === "live_history" ? "watch_history" : endpoint.kind, acceptedRecords),
      pageSize: normalized.records.length,
      pageFingerprint: fingerprintRecordPage(normalized.records),
      recordIds: normalized.records.map((record) => record.id),
      acceptedRecordIds: [...acceptedIds],
      rejectedRecordIds: normalized.records.flatMap((record) => acceptedIds.has(record.id) ? [] : [record.id]),
      type: endpoint.kind,
      pagination: normalized.pagination,
    };
  }

  addRecords(type, records) {
    if (!RECORD_TYPES.includes(type)) return 0;
    const existing = new Map();
    const normalizeForType = (rawRecord) => {
      const record = normalizeRecord(rawRecord);
      if (!record || type !== "watch_history" || !record.videoId) return record;
      const eventId = watchHistoryEventId(record.videoId, record.occurredAt, record.occurredAtSource);
      return { ...record, id: eventId ?? `watch_history:${record.videoId}` };
    };
    const ingest = (rawRecords, trackTruncation) => {
      const normalized = rawRecords.map(normalizeForType).filter(Boolean);
      const ordered = type === "watch_history"
        ? normalized.sort((left, right) => Number(Boolean(watchHistoryEventId(right.videoId, right.occurredAt, right.occurredAtSource)))
          - Number(Boolean(watchHistoryEventId(left.videoId, left.occurredAt, left.occurredAtSource))))
        : normalized;
      for (let record of ordered) {
        const eventId = type === "watch_history"
          ? watchHistoryEventId(record.videoId, record.occurredAt, record.occurredAtSource)
          : null;
        if (eventId) {
          const placeholderId = `watch_history:${record.videoId}`;
          if (existing.has(placeholderId)) {
            record = mergeRecords(existing.get(placeholderId), record);
            existing.delete(placeholderId);
          }
        } else if (type === "watch_history" && record.videoId) {
          const reliableMatches = [...existing.values()].filter((candidate) =>
            candidate.videoId === record.videoId
            && Boolean(watchHistoryEventId(candidate.videoId, candidate.occurredAt, candidate.occurredAtSource)));
          if (reliableMatches.length === 1) {
            const [target] = reliableMatches;
            existing.set(target.id, mergeRecords(target, { ...record, id: target.id, occurredAt: null }));
            continue;
          }
          if (reliableMatches.length > 1) continue;
        }
        if (trackTruncation && existing.size >= MAX_RECORDS_PER_TYPE && !existing.has(record.id)) {
          this.truncatedTypes.add(type);
          break;
        }
        existing.set(record.id, mergeRecords(existing.get(record.id), record));
      }
    };
    ingest(this.records[type], false);
    const before = existing.size;
    ingest(records, true);
    this.records[type] = [...existing.values()].sort((left, right) => {
      const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : 0;
      const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : 0;
      return rightTime - leftTime;
    });
    return existing.size - before;
  }

  isTruncated(type) {
    return this.truncatedTypes.has(type);
  }

  snapshot() {
    return {
      records: structuredClone(this.records),
      folders: [...this.folders.values()],
    };
  }
}
