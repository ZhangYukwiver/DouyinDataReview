import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { hasChatShareEvidence, isSyntheticChatPlaceholder } from "./chatNormalizer.mjs";
import { createEmptyRecords, normalizeRecord } from "./normalizer.mjs";

export const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const RECORD_TYPES = ["watch_history", "liked_videos", "favorite_videos"];
const LEGACY_DIRECT_COMPLETE_WARNING_PREFIX = "无界面读取完成：";
const MAX_CHAT_MESSAGES = 100_000;
const MAX_CHAT_CONVERSATIONS = 10_000;
const MAX_CHAT_STRING = 500;
const CHAT_TYPES = new Set(["text", "image", "sticker", "share", "comment", "call", "system", "voice", "video", "unknown"]);
const IMAGE_HOST_SUFFIXES = ["douyin.com", "douyinpic.com", "douyinvod.com", "byteimg.com", "ibytedtos.com", "snssdk.com"];

function validRecordCollection(value) {
  return value &&
    typeof value === "object" &&
    Array.isArray(value.watch_history) &&
    Array.isArray(value.liked_videos) &&
    Array.isArray(value.favorite_videos);
}

function normalizeRecordCollection(value, timestampSource = "unknown") {
  if (!validRecordCollection(value)) return null;
  const records = createEmptyRecords();
  for (const type of Object.keys(records)) {
    records[type] = value[type].flatMap((item) => {
      const record = normalizeRecord(item, timestampSource);
      return record ? [record] : [];
    });
  }
  return records;
}

function normalizedWarnings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.slice(0, 500)))]
    : [];
}

function chatString(value, limit = MAX_CHAT_STRING) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function chatConversationKind(value) {
  const text = chatString(value, 50)?.toLowerCase();
  if (text === "group" || text === "group_chat" || text === "2" || text === "群聊") return "group";
  if (text === "friend" || text === "private" || text === "one_to_one" || text === "one_to_one_chat" || text === "1" || text === "好友" || text === "私聊") return "friend";
  return "unknown";
}

function chatDate(value) {
  const text = chatString(value, 100);
  if (!text) return null;
  const numeric = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : Number.NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric >= 1e14 ? numeric / 1_000 : numeric >= 1e11 ? numeric : numeric * 1_000)
    : new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function chatImageUrl(value) {
  const text = chatString(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function chatAvatarUrl(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || value === undefined) return null;
  const direct = chatImageUrl(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const nested = chatAvatarUrl(item, depth + 1, seen);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
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
  ]) {
    const nested = chatAvatarUrl(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  return null;
}

function chatDouyinUrl(value) {
  const text = chatString(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || !(url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))) return null;
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function normalizeChatMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = chatString(value.id, 300);
  if (!id) return null;
  const conversationType = chatConversationKind(value.conversationType);
  if (conversationType === "group") return null;
  const rawType = CHAT_TYPES.has(value.type) ? value.type : "unknown";
  const rawDuration = typeof value.callDurationSeconds === "number" && Number.isFinite(value.callDurationSeconds)
    && value.callDurationSeconds >= 0 && value.callDurationSeconds <= 86_400
    ? Math.round(value.callDurationSeconds)
    : null;
  let share = null;
  if (value.share && typeof value.share === "object" && !Array.isArray(value.share)) {
    const candidate = {
      title: chatString(value.share.title),
      author: chatString(value.share.author),
      coverUrl: chatImageUrl(value.share.coverUrl ?? value.share.cover),
      url: chatDouyinUrl(value.share.url),
    };
    if (Object.values(candidate).some(Boolean)) share = candidate;
  }
  const shareHasEvidence = hasChatShareEvidence(share);
  const shareIsRenderable = rawType === "share" && shareHasEvidence;
  const rawText = chatString(value.text);
  const fallbackText = rawText && !/^\[分享\]$/u.test(rawText)
    ? rawText
    : (!shareIsRenderable && rawType === "share" ? chatString(value.share?.title) : rawText);
  const type = rawType === "share" && !shareIsRenderable
    ? (fallbackText ? "text" : "unknown")
    : rawType;
  const senderAvatarUrl = chatAvatarUrl([
    value.senderAvatarUrl,
    value.sender_avatar_url,
    value.sender_avatar,
    value.sender,
    value.senderInfo,
    value.sender_info,
  ]);
  const result = {
    id,
    conversationId: chatString(value.conversationId, 300),
    conversationType,
    conversationName: chatString(value.conversationName),
    senderId: chatString(value.senderId, 300),
    senderName: chatString(value.senderName),
    sentAt: chatDate(value.sentAt),
    type,
    text: fallbackText,
    mediaUrl: chatImageUrl(value.mediaUrl),
    share: shareHasEvidence ? share : null,
    callDurationSeconds: rawDuration,
  };
  if (senderAvatarUrl) result.senderAvatarUrl = senderAvatarUrl;
  if (type === "comment") {
    const comment = value.comment && typeof value.comment === "object" ? value.comment : {};
    result.comment = {
      id: chatString(comment.id, 300),
      author: chatString(comment.author),
      text: value.comment ? chatString(comment.text) : rawText,
      mediaUrl: chatImageUrl(comment.mediaUrl),
      mediaType: ["image", "sticker", "video"].includes(comment.mediaType) ? comment.mediaType : null,
      sourceType: ["image", "video"].includes(comment.sourceType) ? comment.sourceType : null,
    };
    result.text = result.comment.text;
  }
  return result;
}

function normalizeChatCollection(value, groupConversationIds = new Set()) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const messages = [];
  for (const item of value) {
    if (messages.length >= MAX_CHAT_MESSAGES) break;
    const message = normalizeChatMessage(item);
    if (
      !message
      || isSyntheticChatPlaceholder(message)
      || message.conversationType === "group"
      || groupConversationIds.has(message.conversationId)
      || seen.has(message.id)
    ) continue;
    seen.add(message.id);
    messages.push(message);
  }
  return messages.sort((left, right) => (right.sentAt ? Date.parse(right.sentAt) : 0) - (left.sentAt ? Date.parse(left.sentAt) : 0));
}

function normalizeChatConversations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const conversations = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = chatString(item.id, 300);
    if (!id || seen.has(id) || conversations.length >= MAX_CHAT_CONVERSATIONS) continue;
    const kind = chatConversationKind(item.kind);
    const messageCount = Number.isSafeInteger(item.messageCount) && item.messageCount >= 0
      ? Math.min(item.messageCount, MAX_CHAT_MESSAGES)
      : 0;
    const ownMessageCount = Number.isSafeInteger(item.ownMessageCount) && item.ownMessageCount >= 0
      ? Math.min(item.ownMessageCount, messageCount)
      : 0;
    seen.add(id);
    conversations.push({
      id,
      kind,
      name: chatString(item.name ?? item.conversationName ?? item.conversation_name ?? item.nickname ?? item.nickName),
      avatarUrl: chatAvatarUrl(
        [
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
        ],
      ),
      secUid: chatString(item.secUid ?? item.sec_uid, 300),
      lastActiveAt: chatDate(item.lastActiveAt ?? item.last_active_at),
      messageCount,
      ownMessageCount,
    });
  }
  return conversations.sort((left, right) => right.messageCount - left.messageCount || left.id.localeCompare(right.id));
}

export function normalizeDirectSyncState(value, warnings = []) {
  const legacyComplete = Array.isArray(warnings)
    && warnings.some((warning) => typeof warning === "string"
      && warning.startsWith(LEGACY_DIRECT_COMPLETE_WARNING_PREFIX));
  return Object.fromEntries(RECORD_TYPES.map((type) => [
    type,
    value?.[type] === true || legacyComplete,
  ]));
}

export function emptyStoredSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    records: createEmptyRecords(),
    chatMessages: [],
    chatConversations: [],
    warnings: [],
    directSync: normalizeDirectSyncState(null),
  };
}

export class CollectorStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "records.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (
        !parsed ||
        ![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(parsed.schemaVersion) ||
        !validRecordCollection(parsed.records)
      ) {
        return emptyStoredSnapshot();
      }
      const chatConversations = normalizeChatConversations(parsed.chatConversations);
      const groupConversationIds = new Set(chatConversations
        .filter((conversation) => conversation.kind === "group")
        .map((conversation) => conversation.id));
      const normalizedChatMessages = normalizeChatCollection(parsed.chatMessages, groupConversationIds);
      const snapshot = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        records: normalizeRecordCollection(
          parsed.records,
          parsed.schemaVersion === LEGACY_SCHEMA_VERSION ? "platform_action" : "unknown",
        ),
        chatConversations,
        chatMessages: normalizedChatMessages,
        warnings: normalizedWarnings(parsed.warnings),
        directSync: normalizeDirectSyncState(parsed.directSync, parsed.warnings),
      };
      if (!snapshot.records) return emptyStoredSnapshot();
      // Persist the canonical v2 shape after reading a v1 snapshot.  Failure to
      // rewrite must not make an otherwise valid legacy snapshot disappear.
      const removedLegacyChatPlaceholders = Array.isArray(parsed.chatMessages)
        && normalizedChatMessages.length < parsed.chatMessages.length;
      const normalizedAmbiguousShares = Array.isArray(parsed.chatMessages)
        && parsed.chatMessages.some((item) => item?.type === "share" && !hasChatShareEvidence(item?.share));
      if (parsed.schemaVersion === LEGACY_SCHEMA_VERSION || removedLegacyChatPlaceholders || normalizedAmbiguousShares) {
        try {
          await this.writeSnapshot(snapshot);
        } catch {
          // The caller can still use the in-memory migrated snapshot.
        }
      }
      return snapshot;
    } catch (error) {
      if (error && error.code === "ENOENT") return emptyStoredSnapshot();
      throw error;
    }
  }

  async save(records, warnings = [], { directSync, chatMessages, chatConversations } = {}) {
    const normalizedRecords = normalizeRecordCollection(records) ?? createEmptyRecords();
    await mkdir(this.dataDirectory, { recursive: true });
    const normalizedConversations = normalizeChatConversations(chatConversations);
    const groupConversationIds = new Set(normalizedConversations
      .filter((conversation) => conversation.kind === "group")
      .map((conversation) => conversation.id));
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      records: normalizedRecords,
      chatConversations: normalizedConversations,
      chatMessages: normalizeChatCollection(chatMessages, groupConversationIds),
      warnings: normalizedWarnings(warnings),
      directSync: normalizeDirectSyncState(directSync),
    };
    await this.writeSnapshot(snapshot);
    return snapshot;
  }

  async writeSnapshot(snapshot) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  async clear() {
    return this.save(createEmptyRecords(), [], { chatMessages: [], chatConversations: [] });
  }
}
