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
  chatConnection?: "connecting" | "connected" | "reconnecting" | null;
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
}

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
  return Object.keys(result).length > 0 ? result : null;
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
  return result;
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
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 100_000) {
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
    chatConnection: value.chatConnection === "connecting" || value.chatConnection === "connected" || value.chatConnection === "reconnecting"
      ? value.chatConnection : null,
  };
}

function parseCollectorProgress(value: unknown): CollectorProgress | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务进度字段无效。");
  const current = value.current;
  const total = value.total;
  if (
    typeof current !== "number" || !Number.isSafeInteger(current) || current < 0 || current > 100_000
    || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > 100_000
    || current > total
  ) {
    throw new LocalCollectorError("invalid_response", "采集服务进度字段无效。");
  }
  return { current, total };
}

function countForChat(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100_000) {
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
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    options.signal?.throwIfAborted();
    const response = await fetch(`${normalizeCollectorBaseUrl(baseUrl)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const errorCode = isObject(payload) && typeof payload.error === "string" ? payload.error : `http_${response.status}`;
      const message = errorCode === "invalid_pairing_code"
        ? "配对码无效或已使用。"
        : errorCode === "pairing_code_local_only"
          ? "自动获取配对码仅支持当前电脑，请输入采集器显示的配对码。"
        : errorCode === "not_paired"
          ? "连接已过期，请重新配对。"
          : errorCode === "download_start_failed" && isObject(payload) && typeof payload.message === "string"
            ? payload.message
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

export async function startCollectorVideoDownload(
  baseUrl: string,
  token: string,
  url: string,
  signal?: AbortSignal,
  playback = false,
): Promise<VideoDownloadJob> {
  if (!url.trim()) throw new LocalCollectorError("invalid_url", "该记录没有可下载的抖音链接。");
  const value = await requestJson(baseUrl, "/v1/downloads", {
    method: "POST",
    body: JSON.stringify({ url: url.trim(), ...(playback ? { playback: true } : {}) }),
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
        Authorization: `Bearer ${token}`,
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

/** Reuse the collector's authenticated media pipeline without saving a browser download. */
export async function loadCollectorVideo(
  baseUrl: string,
  token: string,
  url: string,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<Blob> {
  const deadline = Date.now() + 90_000;
  let job: VideoDownloadJob | undefined;
  try {
    signal.throwIfAborted();
    // Receive the bounded creation response even after a switch, so its job can be cancelled.
    job = await startCollectorVideoDownload(baseUrl, token, url, undefined, true);
    while (job.status === "queued" || job.status === "running") {
      signal.throwIfAborted();
      onProgress?.(job.status === "queued" ? "正在等待视频准备…" : job.bytes
        ? `正在加载视频 · ${(job.bytes / 1024 / 1024).toFixed(1)} MB` : "正在读取视频资源…");
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
    if (job.status !== "complete") {
      throw new LocalCollectorError(job.errorCode ?? "playback_failed", job.error ?? "视频暂时无法播放，请稍后重试。");
    }
    onProgress?.("正在载入视频文件…");
    const file = await fetchCollectorVideoFile(baseUrl, token, job.id, Math.max(1, deadline - Date.now()), signal);
    signal.throwIfAborted();
    return file.blob;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    if (job) {
      // The browser owns its Blob now; release playback files and cancel unfinished work.
      void requestJson(baseUrl, `/v1/downloads/${encodeURIComponent(job.id)}`, { method: "DELETE" }, token).catch(() => {});
    }
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

export async function startCollectorObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/observe", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回监听状态。");
  return parseStatus(value.status);
}

export async function startCollectorChatObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/chat/observe", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回聊天读取状态。");
  return parseStatus(value.status);
}

export async function stopCollectorObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/observe/stop", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回监听状态。");
  return parseStatus(value.status);
}

export async function stopCollectorChatObservation(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/chat/observe/stop", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回聊天读取状态。");
  return parseStatus(value.status);
}

export async function switchCollectorAccount(baseUrl: string, token: string): Promise<CollectorStatus> {
  const value = await requestJson(baseUrl, "/v1/account/switch", { method: "POST" }, token);
  if (!isObject(value)) throw new LocalCollectorError("invalid_response", "采集服务未返回换号状态。");
  return parseStatus(value.status);
}

export async function clearCollectorRecords(baseUrl: string, token: string): Promise<CollectorSnapshot> {
  return parseSnapshot(await requestJson(baseUrl, "/v1/records", { method: "DELETE" }, token));
}
