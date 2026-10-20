import {
  createEmptyPersonalRecords,
  type PersonalRecordCollection,
  type PersonalRecordType,
  type PersonalVideoRecord,
  type PersonalVideoMediaType,
  type PersonalEventTimeSource,
  type PersonalVideoMusic,
  type PersonalVideoProgress,
  type PersonalVideoStats,
} from "../domain/personalRecords";
import { hasChatShareEvidence, type ChatConversationKind, type ChatConversationSummary, type ChatMessage, type ChatMessageType, type ChatShare } from "../domain/chatRecords";

export type CollectorState =
  | "idle"
  | "launching_browser"
  | "awaiting_login"
  | "observing"
  | "collecting"
  | "complete"
  | "partial"
  | "error";

export interface CollectorProgress {
  current: number;
  total: number;
}

export interface CollectorStatus {
  /** 导入凭据时按账号选择；缺省兼容旧采集器。 */
  readPermissions?: CollectorReadPermissions;
  state: CollectorState;
  phase: PersonalRecordType | "chat_messages" | null;
  message: string;
  counts: Record<PersonalRecordType, number> & { chat_messages: number };
  progress: CollectorProgress | null;
  updatedAt: string | null;
  browserOpen: boolean;
  /** state 为 error 时的错误码，如 login_required */
  code?: string | null;
  revision?: number;
  /** 记录本身换过几次（只存聊天不算）；老版本采集器没有这一项 */
  recordsRevision?: number;
  chatConnection?: "connecting" | "connected" | "reconnecting" | null;
  /** 当前读取走 direct_records；page 仅兼容旧采集器状态。 */
  syncMode: "page" | "direct_records" | null;
  syncFull?: boolean;
  /** 聊天接收自己的一份状态，和记录读取、视频下载互不影响 */
  chat: CollectorChatStatus;
  /** 正在用的抖音账号；老版本采集器没有这一项 */
  account?: { id: string; nickname: string | null; avatar: string | null } | null;
  browserSource?: { mode: "independent" | "cdp"; browser: BrowserLoginSource["id"] | null; connected: boolean;
    credentials?: "ready" | "exporting" | "reconnect_required" };
}

export interface CollectorReadPermissions {
  videos: boolean;
  chat: boolean;
}

export function canReadCollector(status: CollectorStatus | null, kind: keyof CollectorReadPermissions): boolean {
  return status?.readPermissions?.[kind] !== false;
}

const BROWSER_IDS: readonly string[] = ["app", "chrome", "edge", "comet"];

export interface BrowserLoginSource {
  // app = 桌面版应用内登录窗口
  id: "app" | "chrome" | "edge" | "comet";
  label: string;
  available: boolean;
  debugging: boolean;
  inspectUrl: string;
}

export interface BrowserLoginCandidate {
  id: string;
  browser: BrowserLoginSource["id"];
  nickname: string | null;
  uid: string;
  accountId: string | null;
  newAccount: boolean;
  /** 当前账号有记录但没绑定抖音号，可以把这个号归进来 */
  adoptable: boolean;
  readPermissions?: CollectorReadPermissions;
}

export interface CollectorAccount {
  id: string;
  nickname: string | null;
  avatar: string | null;
  uid: string | null;
  createdAt: string | null;
}

export interface CollectorAccounts {
  activeId: string;
  accounts: CollectorAccount[];
}

export interface CollectorChatStatus {
  state: CollectorState;
  connection: "connecting" | "connected" | "reconnecting" | null;
  message: string | null;
  progress: CollectorProgress | null;
  code?: string | null;
}

export interface CollectorSnapshot {
  schemaVersion: 2;
  updatedAt: string | null;
  records: PersonalRecordCollection;
  chatMessages: ChatMessage[];
  chatConversations: ChatConversationSummary[];
  warnings: string[];
}

export type VideoDownloadJobStatus = "queued" | "running" | "complete" | "failed";

export interface VideoDownloadJob {
  id: string;
  sourceUrl: string;
  status: VideoDownloadJobStatus;
  fileName: string | null;
  bytes: number | null;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Playback jobs only: grants the <video> element its stream without the session token. */
  streamKey?: string;
  /** Image posts only: pictures and music load directly; `live` marks a motion clip served through the stream. */
  images?: { url: string; live: boolean }[];
  music?: string | null;
}

export type ImageAlbum = { images: { url: string; live: string | null }[]; music: string | null };
/** A video stream URL, or the pictures of an image post. */
export type PlaybackMedia = string | ImageAlbum;

export interface VideoDownloadFile {
  blob: Blob;
  fileName: string | null;
}

export class LocalCollectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalCollectorError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] !== undefined && parts[1] >= 64 && parts[1] <= 127);
}

export function normalizeCollectorBaseUrl(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LocalCollectorError("invalid_url", "请输入完整的本地采集服务地址。");
  }

  const bareHostname = url.hostname.replace(/^\[|\]$/gu, "");
  const localHostname = bareHostname === "localhost" || bareHostname === "127.0.0.1" || bareHostname === "::1";
  const privateHostname = isPrivateIpv4(bareHostname) ||
    bareHostname.endsWith(".local") ||
    /^(?:f[cd]|fe8)[0-9a-f]*:/iu.test(bareHostname);
  if (!(["http:", "https:"].includes(url.protocol) && (localHostname || privateHostname))) {
    throw new LocalCollectorError("unsafe_url", "只允许连接本机或私有局域网采集服务。");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new LocalCollectorError("invalid_url", "采集服务地址不能包含账号、路径、查询参数或片段。");
  }
  return url.toString().replace(/\/$/u, "");
}

export function getDefaultCollectorBaseUrl(): string {
  return process.env.EXPO_PUBLIC_COLLECTOR_BASE_URL?.trim() || "http://127.0.0.1:4765";
}

export function parseLaunchPairingCode(hash: string): string | null {
  return /^#pair=(\d{8})$/u.exec(hash)?.[1] ?? null;
}

const MAX_RECORD_STRING = 500;
const MAX_RECORD_URL = 2_048;
const IMAGE_HOST_SUFFIXES = [
  "douyin.com",
  "douyinpic.com",
  "douyinvod.com",
  "byteimg.com",
  "ibytedtos.com",
  "snssdk.com",
] as const;
const CHAT_TYPES: ChatMessageType[] = ["text", "image", "sticker", "share", "comment", "call", "system", "voice", "video", "unknown"];
const NUMERIC_CHAT_ID = /^(?:0|\d{15,})$/u;

function cleanRecordString(value: unknown, limit = MAX_RECORD_STRING): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function parseDate(value: unknown): string | null {
  const text = cleanRecordString(value, 100);
  if (!text) return null;
  const numeric = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : Number.NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(text);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100
    ? date.toISOString()
    : null;
}

function parseDouyinUrl(value: unknown): string | null {
  const text = cleanRecordString(value, MAX_RECORD_URL);
  if (!text) return null;
  try {
    const candidate = new URL(text);
    if (
      candidate.protocol === "https:"
      && (candidate.hostname === "douyin.com" || candidate.hostname.endsWith(".douyin.com"))
    ) {
      candidate.search = "";
      candidate.hash = "";
      return candidate.toString().slice(0, MAX_RECORD_URL);
    }
  } catch {
    // Invalid or non-Douyin links remain unavailable in the App.
  }
  return null;
}

function parseImageUrl(value: unknown): string | null {
  const text = cleanRecordString(value, MAX_RECORD_URL);
  if (!text) return null;
  try {
    const candidate = new URL(text);
    const host = candidate.hostname.toLocaleLowerCase();
    if (
      candidate.protocol === "https:"
      && IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    ) return candidate.toString().slice(0, MAX_RECORD_URL);
  } catch {
    // Untrusted image hosts are dropped before they reach the DOM.
  }
  return null;
}

function parseChatAvatarUrl(value: unknown, depth = 0, seen = new Set<object>()): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  const direct = parseImageUrl(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const nested = parseChatAvatarUrl(item, depth + 1, seen);
      if (nested) return nested;
    }
    return null;
  }
  if (!isObject(value) || seen.has(value)) return null;
  seen.add(value);
  for (const key of [
    "avatarUrl",
    "avatar_url",
    "avatar",
    "avatarThumb",
    "avatar_thumb",
    "avatarLarger",
    "avatar_larger",
    "iconUrl",
    "icon_url",
    "icon",
    "url",
    "uri",
    "urlList",
    "url_list",
    "originUrlList",
    "origin_url_list",
    "largeUrlList",
    "large_url_list",
    "mediumUrlList",
    "medium_url_list",
    "thumbUrlList",
    "thumb_url_list",
  ] as const) {
    const nested = parseChatAvatarUrl(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  return null;
}

function parseCount(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_000_000_000_000 ? numeric : null;
}

function parseDuration(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric <= 86_400 ? numeric : numeric / 1_000 <= 86_400 ? numeric / 1_000 : null;
}

function parseMediaType(value: unknown): PersonalVideoMediaType | undefined {
  return value === "video" || value === "image" || value === "live" || value === "unknown" ? value : undefined;
}

function parseStats(value: unknown): PersonalVideoStats | null {
  if (!isObject(value)) return null;
  const result: PersonalVideoStats = {};
  const fields = ["playCount", "diggCount", "commentCount", "shareCount", "collectCount", "downloadCount"] as const;
  for (const field of fields) {
    const count = parseCount(value[field]);
    if (count !== null) result[field] = count;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function parseMusic(value: unknown): PersonalVideoMusic | null {
  if (!isObject(value)) return null;
  const result: PersonalVideoMusic = {};
  for (const field of ["id", "title", "author"] as const) {
    const text = cleanRecordString(value[field]);
    if (text) result[field] = text;
  }
  const url = parseImageUrl(value.url) ?? parseDouyinUrl(value.url);
  if (url) result.url = url;
  return Object.keys(result).length > 0 ? result : null;
}

function parseProgress(value: unknown): PersonalVideoProgress | null {
  if (!isObject(value)) return null;
  const result: PersonalVideoProgress = {};
  const seconds = parseDuration(value.watchedSeconds ?? value.watched_seconds);
  const rawPercent = typeof value.percent === "number" ? value.percent : typeof value.progress === "number" ? value.progress : null;
  const percent = rawPercent !== null && Number.isFinite(rawPercent)
    ? Math.min(100, Math.max(0, rawPercent <= 1 ? rawPercent * 100 : rawPercent))
    : null;
  if (seconds !== null) result.watchedSeconds = Math.round(seconds * 100) / 100;
  if (percent !== null) result.percent = Math.round(percent * 100) / 100;
  // Douyin only keeps a resume point: short videos never get one and a video that plays to the end
  // loops and resets it to 0, so 0 means "unknown", not "watched 0%".
  return (result.watchedSeconds ?? 0) > 0 || (result.percent ?? 0) > 0 ? result : null;
}

function parseVideoId(value: unknown, id: string, url: string | null): string | null {
  const direct = cleanRecordString(value, 200);
  if (direct) return direct;
  const idMatch = id.match(/^[^:]+:(.+)$/u);
  if (idMatch?.[1]) return idMatch[1].slice(0, 200);
  if (url) {
    try {
      const match = new URL(url).pathname.match(/\/video\/([^/?#]+)/u);
      if (match?.[1]) return decodeURIComponent(match[1]).slice(0, 200);
    } catch {
      // Ignore malformed paths.
    }
  }
  return null;
}

function parseRecord(value: unknown, defaultSource: PersonalEventTimeSource = "unknown"): PersonalVideoRecord | null {
  if (!isObject(value) || typeof value.id !== "string") return null;
  const id = cleanRecordString(value.id, 300);
  const title = cleanRecordString(value.title) ?? "Untitled video";
  if (!id) return null;
  const url = parseDouyinUrl(value.url);
  const record: PersonalVideoRecord = {
    id,
    title,
    author: cleanRecordString(value.author),
    occurredAt: parseDate(value.occurredAt),
    url,
  };
  const videoId = parseVideoId(value.videoId, id, url);
  if (videoId) record.videoId = videoId;
  const authorId = cleanRecordString(value.authorId, 200);
  const authorAvatarUrl = parseImageUrl(value.authorAvatarUrl ?? value.authorAvatar ?? value.avatarUrl);
  if (authorId) record.authorId = authorId;
  if (authorAvatarUrl) record.authorAvatarUrl = authorAvatarUrl;
  const source: PersonalEventTimeSource = value.occurredAtSource === "platform_action"
    || value.occurredAtSource === "archive_action"
    || value.occurredAtSource === "unknown"
    ? value.occurredAtSource
    : record.occurredAt && (defaultSource === "platform_action" || defaultSource === "archive_action")
      ? defaultSource
      : "unknown";
  record.occurredAtSource = source;
  const publishedAt = parseDate(value.publishedAt);
  if (publishedAt) record.publishedAt = publishedAt;
  const coverUrl = parseImageUrl(value.coverUrl ?? value.cover);
  if (coverUrl) record.coverUrl = coverUrl;
  const mediaType = parseMediaType(value.mediaType);
  if (mediaType) record.mediaType = mediaType;
  const durationSeconds = parseDuration(value.durationSeconds ?? value.duration);
  if (durationSeconds !== null) record.durationSeconds = Math.round(durationSeconds * 100) / 100;
  const music = parseMusic(value.music);
  if (music) record.music = music;
  if (Array.isArray(value.topics)) {
    const topics = [...new Set(value.topics.flatMap((topic) => {
      const text = cleanRecordString(topic, 100)?.replace(/^#/u, "");
      return text ? [text] : [];
    }))].slice(0, 100);
    if (topics.length > 0) record.topics = topics;
  }
  const stats = parseStats(value.stats ?? value.statistics);
  if (stats) record.stats = stats;
  const progress = parseProgress(value.watchProgress ?? value.progress);
  if (progress) record.watchProgress = progress;
  if (typeof value.watchCompleted === "boolean") record.watchCompleted = value.watchCompleted;
  return record;
}

function parseChatType(value: unknown): ChatMessageType {
  return typeof value === "string" && CHAT_TYPES.includes(value as ChatMessageType)
    ? value as ChatMessageType
    : "unknown";
}

function parseChatConversationKind(value: unknown): ChatConversationKind {
  const text = typeof value === "string" || typeof value === "number" ? String(value).toLowerCase() : "";
  if (text === "1" || text === "friend" || text === "private" || text === "one_to_one" || text === "one_to_one_chat" || text === "好友" || text === "私聊") return "friend";
  if (text === "2" || text === "group" || text === "group_chat" || text === "群聊") return "group";
  return "unknown";
}

function parseChatShare(value: unknown): ChatShare | null {
  if (!isObject(value)) return null;
  const share: ChatShare = {
    title: cleanRecordString(value.title),
    author: cleanRecordString(value.author),
    coverUrl: parseImageUrl(value.coverUrl ?? value.cover),
    url: parseDouyinUrl(value.url),
  };
  return Object.values(share).some(Boolean) ? share : null;
}

function parseChatMessage(value: unknown): ChatMessage | null {
  if (!isObject(value)) return null;
  const id = cleanRecordString(value.id, 300);
  if (!id) return null;
  const rawDuration = value.callDurationSeconds;
  const numericDuration = typeof rawDuration === "number"
    ? rawDuration
    : typeof rawDuration === "string" && /^\d+(?:\.\d+)?$/u.test(rawDuration.trim())
      ? Number(rawDuration)
      : Number.NaN;
  const duration = Number.isFinite(numericDuration) && numericDuration >= 0 && numericDuration <= 86_400
    ? Math.round(numericDuration)
    : null;
  const senderAvatarUrl = parseChatAvatarUrl([
    value.senderAvatarUrl,
    value.sender_avatar_url,
    value.sender_avatar,
    value.sender,
    value.senderInfo,
    value.sender_info,
  ]);
  const rawType = parseChatType(value.type);
  const share = parseChatShare(value.share);
  const shareHasEvidence = hasChatShareEvidence(share);
  const shareIsRenderable = rawType === "share" && shareHasEvidence;
  const rawText = cleanRecordString(value.text);
  const fallbackText = rawText && !/^\[分享\]$/u.test(rawText)
    ? rawText
    : (!shareIsRenderable && rawType === "share" && share?.title ? share.title : rawText);
  const type: ChatMessageType = rawType === "share" && !shareIsRenderable
    ? (fallbackText ? "text" : "unknown")
    : rawType;
  const message: ChatMessage = {
    id,
    conversationId: cleanRecordString(value.conversationId, 300),
    conversationType: parseChatConversationKind(value.conversationType),
    conversationName: cleanRecordString(value.conversationName),
    senderId: cleanRecordString(value.senderId, 300),
    senderName: cleanRecordString(value.senderName),
    sentAt: parseDate(value.sentAt),
    type,
    text: fallbackText,
    mediaUrl: parseImageUrl(value.mediaUrl),
    share: shareHasEvidence ? share : null,
    callDurationSeconds: duration,
  };
  if (senderAvatarUrl) message.senderAvatarUrl = senderAvatarUrl;
  // 抖音自己插的提示带 {{0}} 这种模板空位（比如跟没互关的人新建会话时那句），旧版采集器把它当成了「我发的文字」
  if (message.type === "text" && message.text && /\{\{\d+\}\}/u.test(message.text)) {
    message.type = "system";
    message.text = message.text.replace(/\{\{\d+\}\}/gu, "").trim();
  }
  if (type === "comment") {
    const comment = isObject(value.comment) ? value.comment : {};
    message.comment = {
      id: cleanRecordString(comment.id, 300),
      author: cleanRecordString(comment.author),
      text: isObject(value.comment) ? cleanRecordString(comment.text) : rawText,
      mediaUrl: parseImageUrl(comment.mediaUrl),
      mediaType: comment.mediaType === "image" || comment.mediaType === "sticker" || comment.mediaType === "video" ? comment.mediaType : null,
      sourceType: comment.sourceType === "image" || comment.sourceType === "video" ? comment.sourceType : null,
    };
    message.text = message.comment.text;
  }
  return message;
}

function isSyntheticChatPlaceholder(message: ChatMessage): boolean {
  if (message.type !== "unknown") return false;
  if (!NUMERIC_CHAT_ID.test(message.id.trim())) return false;
  return !message.text && !message.senderName && !message.mediaUrl && !message.share;
}

function parseChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const message = parseChatMessage(item);
    if (!message || isSyntheticChatPlaceholder(message) || seen.has(message.id)) return [];
    seen.add(message.id);
    return [message];
  });
}

function parseChatConversations(value: unknown): ChatConversationSummary[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const id = cleanRecordString(item.id, 300);
    const messageCount = parseCount(item.messageCount);
    const ownMessageCount = parseCount(item.ownMessageCount);
    if (!id || seen.has(id) || messageCount === null || ownMessageCount === null || ownMessageCount > messageCount) return [];
    seen.add(id);
    return [{
      id,
      kind: parseChatConversationKind(item.kind),
      name: cleanRecordString(item.name ?? item.conversationName ?? item.conversation_name ?? item.nickname ?? item.nickName),
      avatarUrl: parseChatAvatarUrl([
        item.avatarUrl,
        item.avatar_url,
        item.avatar,
        item.avatarThumb,
        item.avatar_thumb,
        item.avatarMedium,
        item.avatar_medium,
        item.avatarLarger,
        item.avatar_larger,
        item.iconUrl,
        item.icon_url,
        item.icon,
        item.coreInfo,
        item.core_info,
        item.userInfo,
        item.user_info,
      ]),
      secUid: cleanRecordString(item.secUid, 300),
      lastActiveAt: parseDate(item.lastActiveAt),
      messageCount,
      ownMessageCount,
    }];
  });
}

function parseRecords(value: unknown, defaultSource: PersonalEventTimeSource = "unknown"): PersonalRecordCollection {
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务返回了无效记录。");
  const result = createEmptyPersonalRecords();
  for (const type of Object.keys(result) as PersonalRecordType[]) {
    if (!Array.isArray(value[type])) throw new LocalCollectorError("invalid_response", "采集服务记录分类不完整。");
    result[type] = value[type].flatMap((item) => {
      const record = parseRecord(item, defaultSource);
      return record ? [record] : [];
    });
  }
  estimateWatchProgress(result.watch_history);
  return result;
}

// How the web player writes history (checked by scrolling the feed and reading its requests):
// - entering a video for the first time writes a record about a second later, even for a half-second flick;
// - scrolling back to a video already seen writes nothing;
// - leaving a video that played past ~90–95% moves its record to the moment it was left, a millisecond before
//   the next video's record, and Douyin marks that viewing as watched to the end (watchCompleted).
// So a marked video is 100%, and the rest are timed from their record to the next one. Records under a second
// apart are a scroll that went one video too far and came back: the first is the one watched, the others were
// flicked past. A marked video's record is when it was left, so the video before it ended at least 90% of the
// marked one's length earlier. Gaps over five minutes mean the app was closed or paused.
function estimateWatchProgress(records: PersonalVideoRecord[]): void {
  for (const record of records) {
    if (record.watchCompleted && record.mediaType === "video" && record.durationSeconds) {
      record.watchProgress = { watchedSeconds: record.durationSeconds, percent: 100 };
    }
  }
  const timed = records
    .filter((record) => record.occurredAtSource !== "unknown" && record.occurredAt)
    .map((record) => ({ record, at: Date.parse(record.occurredAt!) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  // Records saved before the label existed: a record followed within 3 ms by another video is that rewrite
  // (79 of 80 such pairs Douyin labelled were finished).
  const finished = (index: number) => {
    const { record, at } = timed[index]!;
    if (record.watchCompleted !== undefined) return record.watchCompleted;
    const next = timed[index + 1];
    return Boolean(next && next.at - at <= 3 && next.record.videoId !== record.videoId);
  };
  timed.forEach(({ record }, index) => {
    if (finished(index) && record.mediaType === "video" && record.durationSeconds) {
      record.watchProgress = { watchedSeconds: record.durationSeconds, percent: 100 };
    }
  });
  // a record within 3 ms of the one before is the next video entered, never a flick
  const flickedPast = (index: number) => {
    const gap = timed[index]!.at - timed[index - 1]!.at;
    return gap > 3 && gap < 1_000;
  };
  for (let index = 0; index < timed.length - 1; index += 1) {
    const { record, at } = timed[index]!;
    const duration = record.durationSeconds;
    if (record.watchProgress || record.mediaType !== "video" || !duration) continue;
    const flicked = index > 0 && flickedPast(index);
    let end = index + 1;
    if (!flicked) while (end < timed.length - 1 && flickedPast(end) && !finished(end)) end += 1;
    // the newest burst has nothing after it yet, so it is still unknown when the watched one ended
    if (!flicked && flickedPast(end) && !finished(end)) continue;
    const next = timed[end]!;
    // a video flicked past was on screen for the shorter of the gaps around it, both under a second
    let dwell = (flicked ? Math.min(next.at - at, at - timed[index - 1]!.at) : next.at - at) / 1_000;
    if (!flicked && finished(end) && next.record.videoId !== record.videoId) {
      dwell -= 0.9 * (next.record.durationSeconds ?? Infinity);
    }
    // a watched video can't end within a second of starting unless the labels disagree with the timing
    if (!(dwell >= 0) || dwell > 300 || (!flicked && dwell < 1)) continue;
    // Douyin says this one was not watched to the end, however long it stayed on screen
    const ceiling = record.watchCompleted === false ? 90 : 100;
    const percent = Math.min(ceiling, dwell / duration * 100);
    record.watchProgress = {
      watchedSeconds: Math.round(Math.min(dwell, duration * percent / 100) * 100) / 100,
      percent: Math.round(percent * 100) / 100,
    };
  }
}

function parseSnapshot(value: unknown): CollectorSnapshot {
  if (!isObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new LocalCollectorError("invalid_response", "采集服务版本不兼容。");
  }
  const chatConversations = parseChatConversations(value.chatConversations);
  const groupIds = new Set(chatConversations.filter((conversation) => conversation.kind === "group").map((conversation) => conversation.id));
  return {
    schemaVersion: 2,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    records: parseRecords(value.records, value.schemaVersion === 1 ? "platform_action" : "unknown"),
    chatMessages: parseChatMessages(value.chatMessages).filter((message) => message.conversationType !== "group" && (!message.conversationId || !groupIds.has(message.conversationId))),
    chatConversations,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === "string")
      : [],
  };
}

// 「导出数据」存下的就是界面那份快照，只是没带 schemaVersion；按采集器同一套规则原样读回
export function parseExportedSnapshot(value: unknown): CollectorSnapshot | null {
  if (!isObject(value) || typeof value.exportedAt !== "string") return null;
  return parseSnapshot({ ...value, schemaVersion: 2 });
}

function parseStatus(value: unknown): CollectorStatus {
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务状态无效。");
  const validStates: CollectorState[] = [
    "idle",
    "launching_browser",
    "awaiting_login",
    "observing",
    "collecting",
    "complete",
    "partial",
    "error",
  ];
  const state = validStates.find((item) => item === value.state);
  const rawCounts = isObject(value.counts) ? value.counts : null;
  function countFor(type: PersonalRecordType): number {
    const count = rawCounts?.[type];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new LocalCollectorError("invalid_response", "采集服务数量字段无效。");
    }
    return count;
  }
  if (!state || typeof value.message !== "string") {
    throw new LocalCollectorError("invalid_response", "采集服务状态字段不完整。");
  }
  const phases: Array<PersonalRecordType | "chat_messages" | null> = ["watch_history", "liked_videos", "favorite_videos", "chat_messages", null];
  const phase = phases.find((item) => item === value.phase) ?? null;
  return {
    state,
    phase,
    message: value.message,
    counts: {
      watch_history: countFor("watch_history"),
      liked_videos: countFor("liked_videos"),
      favorite_videos: countFor("favorite_videos"),
      chat_messages: (() => {
        const count = rawCounts?.chat_messages;
        return count === undefined ? 0 : countForChat(count);
      })(),
    },
    progress: parseCollectorProgress(value.progress),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    browserOpen: value.browserOpen === true,
    code: typeof value.code === "string" ? value.code : null,
    ...(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 ? { revision: value.revision } : {}),
    ...(typeof value.recordsRevision === "number" && Number.isSafeInteger(value.recordsRevision) && value.recordsRevision >= 0 ? { recordsRevision: value.recordsRevision } : {}),
    chatConnection: value.chatConnection === "connecting" || value.chatConnection === "connected" || value.chatConnection === "reconnecting"
      ? value.chatConnection : null,
    syncMode: value.syncMode === "page" || value.syncMode === "direct_records" ? value.syncMode : null,
    syncFull: value.syncFull === true,
    ...(isObject(value.readPermissions) ? { readPermissions: {
      videos: value.readPermissions.videos === true, chat: value.readPermissions.chat === true,
    } } : {}),
    chat: parseChatStatus(value.chat, validStates),
    account: parseStatusAccount(value.account),
    ...(isObject(value.browserSource) && ["independent", "cdp"].includes(String(value.browserSource.mode)) ? {
      browserSource: { mode: value.browserSource.mode as "independent" | "cdp",
        browser: BROWSER_IDS.includes(String(value.browserSource.browser)) ? value.browserSource.browser as BrowserLoginSource["id"] : null,
        connected: value.browserSource.connected === true,
        ...(["ready", "exporting", "reconnect_required"].includes(String(value.browserSource.credentials))
          ? { credentials: value.browserSource.credentials as "ready" | "exporting" | "reconnect_required" } : {}) },
    } : {}),
  };
}

const ACCOUNT_ID = /^(?:default|[0-9a-f]{12})$/u;

function parseStatusAccount(value: unknown): CollectorStatus["account"] {
  if (!isObject(value) || typeof value.id !== "string" || !ACCOUNT_ID.test(value.id)) return null;
  return { id: value.id, nickname: cleanRecordString(value.nickname, 100), avatar: parseImageUrl(value.avatar) };
}

function parseAccounts(value: unknown): CollectorAccounts {
  if (!isObject(value) || typeof value.activeId !== "string" || !Array.isArray(value.accounts)) {
    throw new LocalCollectorError("invalid_response", "采集服务没有返回账号列表。");
  }
  const accounts = value.accounts.flatMap((item): CollectorAccount[] => {
    if (!isObject(item) || typeof item.id !== "string" || !ACCOUNT_ID.test(item.id)) return [];
    return [{
      id: item.id,
      nickname: cleanRecordString(item.nickname, 100),
      avatar: parseImageUrl(item.avatar),
      uid: cleanRecordString(item.uid, 100),
      createdAt: parseDate(item.createdAt),
    }];
  });
  // 「账号 N」按添加的先后编号，没有时间的排最后
  accounts.sort((a, b) => (a.createdAt ?? "￿").localeCompare(b.createdAt ?? "￿"));
  return { activeId: value.activeId, accounts };
}

/** 面板和确认框里怎么称呼这个账号：有昵称用昵称，还没登录过的按添加先后叫「账号 N」 */
export function collectorAccountName(account: Pick<CollectorAccount, "nickname">, index: number): string {
  return account.nickname ?? `账号 ${index + 1}`;
}

/** 账号是哪天添加的，比如「10 月 3 日」；不是今年的带上年份 */
export function formatAccountAddedDay(createdAt: string | null, now = new Date()): string | null {
  const time = createdAt ? new Date(createdAt) : null;
  if (!time || Number.isNaN(time.getTime())) return null;
  const day = `${time.getMonth() + 1} 月 ${time.getDate()} 日`;
  return time.getFullYear() === now.getFullYear() ? day : `${time.getFullYear()} 年 ${day}`;
}

/** 列表里另一个登录着同一个抖音号的账号（按 uid 认）：同一个号添加了两次时，删之前要分得清哪个存着旧记录 */
export function findTwinAccount(accounts: readonly CollectorAccount[], account: CollectorAccount): CollectorAccount | null {
  if (!account.uid) return null;
  return accounts.find((item) => item.id !== account.id && item.uid === account.uid) ?? null;
}

// 聊天接收是否在跑（连接中也算），它和记录读取、视频下载各走各的
export function isChatReceiving(status: CollectorStatus | null | undefined): boolean {
  if (!status) return false;
  if (["launching_browser", "observing"].includes(status.chat.state)) return true;
  // An explicit nested terminal error wins over the legacy phase fallback.
  // Older collectors omit `chat`, while newer collectors can keep the
  // top-level record task in `collecting` or `observing` after chat fails.
  if (status.chat.state === "error") return false;
  // Collectors before the split status model exposed chat work on the shared
  // state/phase fields. Keep those responses usable while preferring the
  // nested chat state whenever it is present.
  return status.phase === "chat_messages" && ["launching_browser", "observing"].includes(status.state);
}

function parseChatStatus(value: unknown, validStates: CollectorState[]): CollectorChatStatus {
  const raw = isObject(value) ? value : {};
  const connection = raw.connection;
  return {
    state: validStates.find((item) => item === raw.state) ?? "idle",
    connection: connection === "connecting" || connection === "connected" || connection === "reconnecting" ? connection : null,
    message: typeof raw.message === "string" ? raw.message : null,
    progress: parseCollectorProgress(raw.progress),
    code: typeof raw.code === "string" ? raw.code : null,
  };
}

function parseCollectorProgress(value: unknown): CollectorProgress | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务进度字段无效。");
  const current = value.current;
  const total = value.total;
  if (
    typeof current !== "number" || !Number.isSafeInteger(current) || current < 0
    || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
    || current > total
  ) {
    throw new LocalCollectorError("invalid_response", "采集服务进度字段无效。");
  }
  return { current, total };
}

function countForChat(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalCollectorError("invalid_response", "采集服务聊天数量字段无效。");
  }
  return value;
}

function parseVideoDownloadJob(value: unknown): VideoDownloadJob {
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务下载任务无效。");
  const statuses: VideoDownloadJobStatus[] = ["queued", "running", "complete", "failed"];
  const status = statuses.find((item) => item === value.status);
  if (!status || typeof value.id !== "string" || typeof value.sourceUrl !== "string") {
    throw new LocalCollectorError("invalid_response", "采集服务下载任务字段不完整。");
  }
  const optionalString = (candidate: unknown): string | null => candidate === null || candidate === undefined
    ? null
    : typeof candidate === "string" ? candidate : null;
  const optionalBytes = (candidate: unknown): number | null => candidate === null || candidate === undefined
    ? null
    : typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  const https = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.startsWith("https://");
  const images = Array.isArray(value.images)
    ? value.images.flatMap((image) => isObject(image) && https(image.url) ? [{ url: image.url, live: image.live === true }] : [])
    : [];
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  if (!createdAt || !updatedAt) throw new LocalCollectorError("invalid_response", "采集服务下载任务时间字段无效。");
  return {
    id: value.id,
    sourceUrl: value.sourceUrl,
    status,
    fileName: optionalString(value.fileName),
    bytes: optionalBytes(value.bytes),
    errorCode: optionalString(value.errorCode),
    error: optionalString(value.error),
    createdAt,
    updatedAt,
    startedAt: optionalString(value.startedAt),
    completedAt: optionalString(value.completedAt),
    ...(typeof value.streamKey === "string" ? { streamKey: value.streamKey } : {}),
    ...(images.length ? { images, music: https(value.music) ? value.music : null } : {}),
  };
}

// 配对闲置 12 小时会过期（比如电脑睡了一夜）。App 登记续配函数后，请求碰到 not_paired 就重新配对再发一次；
// 还攥着旧令牌的轮询循环发请求时也会换成新令牌
let renewCollectorToken: ((expired: string) => Promise<string | null>) | null = null;
const renewedTokens = new Map<string, Promise<string | null>>();

export function setCollectorTokenRenewal(renew: ((expired: string) => Promise<string | null>) | null): void {
  renewCollectorToken = renew;
  renewedTokens.clear();
}

// 同一个过期令牌只续配一次，并发请求共用结果；续不上就忘掉，下次再试
async function renewAfterExpiry(expired: string): Promise<string | null> {
  if (!renewCollectorToken) return null;
  let renewal = renewedTokens.get(expired);
  if (!renewal) {
    renewal = renewCollectorToken(expired).catch(() => null);
    renewedTokens.set(expired, renewal);
  }
  const fresh = await renewal;
  if (!fresh) renewedTokens.delete(expired);
  return fresh;
}

// 探索、创作者中心这些自己解析响应的服务也走这里：配对过期一样自动续配、重发一次
export async function collectorFetch(connection: { baseUrl: string; token: string }, path: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) => fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}${path}`, {
    ...init,
    headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` },
  });
  const token = renewedTokens.size ? await latestToken(connection.token) : connection.token;
  const response = await send(token);
  if (response.status !== 401) return response;
  const payload = await response.clone().json().catch(() => null) as unknown;
  const fresh = isObject(payload) && payload.error === "not_paired" ? await renewAfterExpiry(token) : null;
  return fresh ? send(fresh) : response;
}

async function latestToken(token: string): Promise<string> {
  let current = token;
  for (let next = renewedTokens.get(current); next; next = renewedTokens.get(current)) {
    const renewed = await next;
    if (!renewed) break;
    current = renewed;
  }
  return current;
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string,
  timeoutMs = 10_000,
  renewed = false,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    options.signal?.throwIfAborted();
    // 没续过配就别多等一拍
    const authToken = token && renewedTokens.size ? await latestToken(token) : token;
    const response = await fetch(`${normalizeCollectorBaseUrl(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const errorCode = isObject(payload) && typeof payload.error === "string" ? payload.error : `http_${response.status}`;
      if (errorCode === "not_paired" && authToken && !renewed && await renewAfterExpiry(authToken)) {
        return await requestJson(baseUrl, path, options, authToken, timeoutMs, true);
      }
      const serverMessage = isObject(payload) && typeof payload.message === "string" && payload.message.trim() ? payload.message : null;
      const message = errorCode === "invalid_pairing_code"
        ? "配对码无效或已使用。"
        : errorCode === "pairing_code_local_only"
          ? "自动获取配对码仅支持当前电脑，请输入采集器显示的配对码。"
        : errorCode === "not_paired"
          ? "连接已过期，请重新配对。"
          : (["download_start_failed", "import_busy", "import_failed", "collector_busy"].includes(errorCode) || errorCode.startsWith("account_") || errorCode.startsWith("browser_")) && serverMessage
            ? serverMessage
          : errorCode === "collector_busy"
            ? "采集器正在忙，等它做完再试。"
          : errorCode === "account_active"
            ? "正在用的账号不能删，先切到别的账号再删。"
          : errorCode === "account_not_found"
            ? "找不到这个账号，可能已经删掉了。"
          : `采集服务请求失败（${response.status}）。`;
      throw new LocalCollectorError(errorCode, message);
    }
    return payload;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LocalCollectorError("timeout", "连接本地采集服务超时。");
    }
    throw new LocalCollectorError("unreachable", "无法连接本地采集服务，请确认服务已启动。");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function checkCollectorHealth(baseUrl: string): Promise<void> {
  const value = await requestJson(baseUrl, "/v1/health");
  if (!isObject(value) || value.ok !== true || value.version !== 1) {
    throw new LocalCollectorError("invalid_response", "该地址不是兼容的本地采集服务。");
  }
}

export async function getCollectorPairingCode(baseUrl: string): Promise<string> {
  const value = await requestJson(baseUrl, "/v1/pairing-code");
  if (!isObject(value) || typeof value.code !== "string" || !/^\d{8}$/u.test(value.code)) {
    throw new LocalCollectorError("invalid_response", "采集服务未返回有效配对码。");
  }
  return value.code;
}

export async function pairCollector(baseUrl: string, code: string): Promise<string> {
  if (!/^\d{8}$/u.test(code.trim())) throw new LocalCollectorError("invalid_code", "配对码应为 8 位数字。");
  const value = await requestJson(baseUrl, "/v1/pair", {
    method: "POST",
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!isObject(value) || typeof value.token !== "string" || value.token.length < 32) {
    throw new LocalCollectorError("invalid_response", "采集服务未返回有效会话。");
  }
  return value.token;
}

export async function getCollectorStatus(baseUrl: string, token: string, afterRevision?: number, signal?: AbortSignal): Promise<CollectorStatus> {
  const query = afterRevision === undefined ? "" : `?afterRevision=${afterRevision}`;
  return parseStatus(await requestJson(baseUrl, `/v1/status${query}`, { signal }, token));
}

export async function getCollectorRecords(baseUrl: string, token: string): Promise<CollectorSnapshot> {
  return parseSnapshot(await requestJson(baseUrl, "/v1/records", {}, token));
}

// 只取聊天：记录没换时不用每来一条消息就搬一遍、解析一遍几 MB 的记录
export async function getCollectorChat(baseUrl: string, token: string): Promise<Pick<CollectorSnapshot, "chatMessages" | "chatConversations" | "warnings">> {
  const value = await requestJson(baseUrl, "/v1/records?part=chat", {}, token);
  const { chatMessages, chatConversations, warnings } = parseSnapshot(isObject(value) ? { ...value, records: createEmptyPersonalRecords() } : value);
  return { chatMessages, chatConversations, warnings };
}

export async function startCollectorVideoDownload(
  baseUrl: string,
  token: string,
  url: string,
  signal?: AbortSignal,
  playback = false,
  /** 从探索页发起的下载：别关掉探索会话，回去还能接着加载更多 */
  keepExplore = false,
): Promise<VideoDownloadJob> {
  if (!url.trim()) throw new LocalCollectorError("invalid_url", "该记录没有可下载的抖音链接。");
  const value = await requestJson(baseUrl, "/v1/downloads", {
    method: "POST",
    body: JSON.stringify({ url: url.trim(), ...(playback ? { playback: true } : {}), ...(keepExplore ? { keepExplore: true } : {}) }),
    signal,
  }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回下载任务。");
  return parseVideoDownloadJob(value.job);
}

export async function getCollectorVideoDownload(
  baseUrl: string,
  token: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<VideoDownloadJob> {
  if (!/^[0-9a-f-]{20,}$/iu.test(jobId)) {
    throw new LocalCollectorError("invalid_job", "下载任务编号无效。");
  }
  const value = await requestJson(baseUrl, `/v1/downloads/${encodeURIComponent(jobId)}`, { signal }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回下载状态。");
  return parseVideoDownloadJob(value.job);
}

function fileNameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=(?:UTF-8'')?([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      const decoded = decodeURIComponent(encoded.replace(/^"|"$/gu, ""));
      return decoded || null;
    } catch {
      // Fall through to the plain filename form.
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/iu)?.[1]?.trim();
  return plain || null;
}

export async function fetchCollectorVideoFile(
  baseUrl: string,
  token: string,
  jobId: string,
  timeoutMs = 15 * 60 * 1_000,
  signal?: AbortSignal,
): Promise<VideoDownloadFile> {
  if (!/^[0-9a-f-]{20,}$/iu.test(jobId)) {
    throw new LocalCollectorError("invalid_job", "下载任务编号无效。");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${normalizeCollectorBaseUrl(baseUrl)}/v1/downloads/${encodeURIComponent(jobId)}/file`, {
      signal: controller.signal,
      headers: {
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        Authorization: `Bearer ${renewedTokens.size ? await latestToken(token) : token}`,
      },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as unknown;
      const code = isObject(payload) && typeof payload.error === "string" ? payload.error : `http_${response.status}`;
      throw new LocalCollectorError(code, code === "download_not_complete" ? "视频仍在准备中，请稍后再试。" : "无法获取已下载的视频文件。");
    }
    return {
      blob: await response.blob(),
      fileName: fileNameFromContentDisposition(response.headers.get("content-disposition")),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LocalCollectorError("timeout", "获取视频文件超时，请稍后重试。");
    }
    throw new LocalCollectorError("unreachable", "无法获取视频文件，请确认采集服务仍在运行。");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Resolve a playback job to a stream URL (or an image post's pictures); the job lives until `signal` aborts, nothing is saved. */
export async function loadCollectorVideo(
  baseUrl: string,
  token: string,
  url: string,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<PlaybackMedia> {
  const deadline = Date.now() + 90_000;
  let job: VideoDownloadJob | undefined;
  const release = () => {
    if (job) void requestJson(baseUrl, `/v1/downloads/${encodeURIComponent(job.id)}`, { method: "DELETE" }, token).catch(() => {});
  };
  try {
    signal.throwIfAborted();
    // Receive the bounded creation response even after a switch, so its job can be cancelled.
    job = await startCollectorVideoDownload(baseUrl, token, url, undefined, true);
    while (job.status === "queued" || job.status === "running") {
      signal.throwIfAborted();
      onProgress?.(job.status === "queued" ? "正在等待视频准备…" : "正在读取视频资源…");
      if (Date.now() >= deadline) throw new LocalCollectorError("timeout", "视频准备超时，请稍后重试。");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 800);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      job = await getCollectorVideoDownload(baseUrl, token, job.id, signal);
    }
    signal.throwIfAborted();
    if (job.status !== "complete" || !job.streamKey) {
      throw new LocalCollectorError(job.errorCode ?? "playback_failed", job.error ?? "视频暂时无法播放，请稍后重试。");
    }
    signal.addEventListener("abort", release, { once: true });
    const stream = `${normalizeCollectorBaseUrl(baseUrl)}/v1/downloads/${encodeURIComponent(job.id)}/stream?key=${encodeURIComponent(job.streamKey)}`;
    return job.images
      ? { images: job.images.map((image, index) => ({ url: image.url, live: image.live ? `${stream}&live=${index}` : null })), music: job.music ?? null }
      : stream;
  } catch (error) {
    release();
    signal.throwIfAborted();
    throw error;
  }
}

export async function startCollectorSync(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/sync", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回同步状态。");
  return parseStatus(value.status);
}

export async function stopCollectorSync(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/sync/stop", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回停止状态。");
  return parseStatus(value.status);
}

export async function startDirectRecordsSync(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/experimental/records-direct", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回直接读取状态。");
  return parseStatus(value.status);
}

export async function startCollectorChatObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/chat/observe", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回聊天读取状态。");
  return parseStatus(value.status);
}

export async function stopCollectorChatObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/chat/observe/stop", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回聊天读取状态。");
  return parseStatus(value.status);
}

export async function getCollectorAccounts(baseUrl: string, token: string): Promise<CollectorAccounts> {
  return parseAccounts(await requestJson(baseUrl, "/v1/accounts", {}, token));
}

export async function getBrowserLoginSources(baseUrl: string, token: string): Promise<BrowserLoginSource[]> {
  const value = await requestJson(baseUrl, "/v1/browser/sources", {}, token);
  if (!isObject(value) || !Array.isArray(value.sources)) throw new LocalCollectorError("invalid_response", "浏览器列表无效。");
  return value.sources.flatMap((item): BrowserLoginSource[] => {
    if (!isObject(item) || !BROWSER_IDS.includes(String(item.id)) || typeof item.label !== "string") return [];
    const id = item.id as BrowserLoginSource["id"];
    return [{ id, label: item.label, available: item.available === true, debugging: item.debugging === true, inspectUrl: `${id}://inspect/#remote-debugging` }];
  });
}

export async function inspectBrowserLogin(baseUrl: string, token: string, browser: BrowserLoginSource["id"], accountId?: string | null, signal?: AbortSignal): Promise<BrowserLoginCandidate> {
  // Browser authorization, navigation and up to five minutes for manual login.
  const value = await requestJson(baseUrl, withAccount("/v1/browser/connect", accountId), { method: "POST", body: JSON.stringify({ browser }), signal }, token, 7 * 60_000);
  const candidate = isObject(value) && isObject(value.candidate) ? value.candidate : null;
  if (!candidate || typeof candidate.id !== "string" || !/^[0-9a-f-]{36}$/u.test(candidate.id)
    || !BROWSER_IDS.includes(String(candidate.browser)) || typeof candidate.uid !== "string" || !/^\d{1,30}$/u.test(candidate.uid))
    throw new LocalCollectorError("invalid_response", "浏览器登录账号无效。");
  return { id: candidate.id, browser: candidate.browser as BrowserLoginSource["id"], uid: candidate.uid,
    nickname: cleanRecordString(candidate.nickname, 100), accountId: typeof candidate.accountId === "string" && ACCOUNT_ID.test(candidate.accountId) ? candidate.accountId : null,
    newAccount: candidate.newAccount === true, adoptable: candidate.adoptable === true,
    ...(isObject(candidate.readPermissions) ? { readPermissions: {
      videos: candidate.readPermissions.videos === true, chat: candidate.readPermissions.chat === true,
    } } : {}) };
}

/** 应用内登录等扫码时的二维码；不在等登录或码还没出来时是 null */
export async function getBrowserLoginQrCode(baseUrl: string, token: string): Promise<{ image: string; hint: string; verify: boolean } | null> {
  const value = await requestJson(baseUrl, "/v1/browser/login-qrcode", {}, token);
  const qrcode = isObject(value) && isObject(value.qrcode) ? value.qrcode : null;
  if (!qrcode || typeof qrcode.image !== "string" || !/^data:image\/(?:png|jpeg|gif|webp);base64,/u.test(qrcode.image)) return null;
  // verify：这张码是二次验证（使用原设备扫码）的，不是登录码
  return { image: qrcode.image, hint: typeof qrcode.hint === "string" ? qrcode.hint : "", verify: qrcode.verify === true };
}

/** 应用内登录或导入凭据时，后台的抖音页有没有弹出身份验证 */
export async function getBrowserVerification(baseUrl: string, token: string): Promise<boolean> {
  const value = await requestJson(baseUrl, "/v1/browser/verification", {}, token);
  return isObject(value) && value.verifying === true;
}

/** 把藏着的应用内登录窗口亮出来，用来做验证或改用验证码登录 */
export async function showBrowserLoginWindow(baseUrl: string, token: string): Promise<void> {
  await requestJson(baseUrl, "/v1/browser/login-window", { method: "POST", body: "{}" }, token);
}

export async function confirmBrowserLogin(baseUrl: string, token: string, id: string, readPermissions: CollectorReadPermissions, accountId?: string | null, adopt = false): Promise<CollectorAccountChange> {
  return parseAccountChange(await requestJson(baseUrl, withAccount("/v1/browser/confirm", accountId), { method: "POST", body: JSON.stringify({ id, readPermissions, ...(adopt ? { adopt } : {}) }) }, token, 5 * 60_000));
}

export async function cancelBrowserLogin(baseUrl: string, token: string, id: string): Promise<void> {
  await requestJson(baseUrl, "/v1/browser/pending", { method: "DELETE", body: JSON.stringify({ id }) }, token);
}

export async function disconnectBrowserLogin(baseUrl: string, token: string, accountId?: string | null): Promise<CollectorAccountChange> {
  return parseAccountChange(await requestJson(baseUrl, withAccount("/v1/browser/disconnect", accountId), { method: "POST", body: "{}" }, token, ACCOUNT_CHANGE_TIMEOUT_MS));
}

export interface CollectorAccountChange {
  accounts: CollectorAccounts;
  status: CollectorStatus;
}

function parseAccountChange(value: unknown): CollectorAccountChange {
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务没有返回账号列表。");
  return { accounts: parseAccounts(value), status: parseStatus(value.status) };
}

function checkAccountId(id: string): string {
  if (!ACCOUNT_ID.test(id)) throw new LocalCollectorError("invalid_account", "账号编号无效。");
  return id;
}

// 新建和切换都要先关掉旧账号的浏览器、等手上的活收尾，再开新账号的，多给点时间
const ACCOUNT_CHANGE_TIMEOUT_MS = 60_000;

export async function addCollectorAccount(baseUrl: string, token: string): Promise<CollectorAccountChange> {
  return parseAccountChange(await requestJson(baseUrl, "/v1/accounts", { method: "POST", body: "{}" }, token, ACCOUNT_CHANGE_TIMEOUT_MS));
}

export async function activateCollectorAccount(baseUrl: string, token: string, id: string): Promise<CollectorAccountChange> {
  const path = `/v1/accounts/${checkAccountId(id)}/activate`;
  return parseAccountChange(await requestJson(baseUrl, path, { method: "POST" }, token, ACCOUNT_CHANGE_TIMEOUT_MS));
}

export async function removeCollectorAccount(baseUrl: string, token: string, id: string): Promise<CollectorAccounts> {
  const path = `/v1/accounts/${checkAccountId(id)}`;
  return parseAccounts(await requestJson(baseUrl, path, { method: "DELETE" }, token, ACCOUNT_CHANGE_TIMEOUT_MS));
}

// 改记录的请求带上界面以为的当前账号：采集器已经被别的窗口切走时会回 account_changed，不会清错、并错
function withAccount(path: string, accountId: string | null | undefined): string {
  return accountId ? `${path}?account=${encodeURIComponent(checkAccountId(accountId))}` : path;
}

export async function clearCollectorRecords(baseUrl: string, token: string, accountId?: string | null): Promise<CollectorSnapshot> {
  return parseSnapshot(await requestJson(baseUrl, withAccount("/v1/records", accountId), { method: "DELETE" }, token));
}

export interface CollectorImportResult {
  snapshot: CollectorSnapshot;
  added: { watch_history: number; liked_videos: number; favorite_videos: number; chat_messages: number };
}

// 把导出文件并进采集器的本地记录；十几 MB 的上传加上先停聊天接收，给足一分钟
export async function importCollectorRecords(
  baseUrl: string,
  token: string,
  data: Pick<CollectorSnapshot, "records" | "chatMessages" | "chatConversations">,
  accountId?: string | null,
): Promise<CollectorImportResult> {
  const value = await requestJson(baseUrl, withAccount("/v1/records/import", accountId), { method: "POST", body: JSON.stringify(data) }, token, 60_000);
  if (!isObject(value) || !isObject(value.added)) throw new LocalCollectorError("invalid_response", "采集服务没有返回并入结果。");
  const added = value.added;
  const count = (key: keyof CollectorImportResult["added"]) => parseCount(added[key]) ?? 0;
  return {
    snapshot: parseSnapshot(value.snapshot),
    added: { watch_history: count("watch_history"), liked_videos: count("liked_videos"), favorite_videos: count("favorite_videos"), chat_messages: count("chat_messages") },
  };
}
