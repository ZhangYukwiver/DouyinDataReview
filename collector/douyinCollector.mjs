import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { chromium } from "playwright-core";

import {
  DIRECT_FAVORITE_ENDPOINT,
  DIRECT_HISTORY_ENDPOINT,
  DIRECT_LIKED_ENDPOINT,
  DirectHistoryError,
  captureDirectHistoryTemplate,
  countMissingDirectHistoryViewTimes,
  collectDirectRecordPages,
  fetchDirectHistoryPage,
  invalidateDirectHistoryTemplate,
  loadDirectHistoryTemplate,
} from "./directHistory.mjs";
import { CollectorAdapterError, RecordAccumulator, matchDouyinEndpoint, mergeRecords } from "./normalizer.mjs";
import {
  ChatAdapterError,
  ChatConversationAccumulator,
  ChatMessageAccumulator,
  matchChatEndpoint,
  normalizeChatAvatarUrl,
  normalizeChatConversation,
  normalizeChatPayload,
  normalizeChatPresence,
} from "./chatNormalizer.mjs";
import {
  createEndpointProgress,
  isEndpointComplete,
  recordEndpointMatch,
  recordEndpointResult,
} from "./progress.mjs";
import { normalizeDirectSyncState } from "./store.mjs";
import {
  downloadDouyinVideo,
  normalizeDouyinVideoUrl,
  VideoDownloadError,
} from "./videoDownloader.mjs";
import { observeChatSockets } from "./chatRealtime.mjs";
import { ChatSendError, sendChatText, validateChatSend } from "./chatSender.mjs";

const HOME_URL = "https://www.douyin.com/";
const CHAT_URL = "https://www.douyin.com/chat?isPopup=1";
const SELF_PROFILE_URL = "https://www.douyin.com/user/self";
const LOGIN_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const REQUIRED_TYPES = ["watch_history", "liked_videos", "favorite_videos"];
const REQUIRED_PATHS = {
  watch_history: "/aweme/v1/web/history/read/",
  liked_videos: "/aweme/v1/web/aweme/favorite/",
  favorite_videos: "/aweme/v1/web/aweme/listcollection/",
};
const TYPE_LABELS = {
  watch_history: "观看历史",
  liked_videos: "点赞列表",
  favorite_videos: "收藏列表",
};
const MAX_LOGIN_WAIT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 100_000;
// ponytail: bound a broken cursor chain while still allowing the 100k-message
// local cap to be reached for a genuinely long friend conversation.
const CHAT_FRIEND_HISTORY_PAGE_LIMIT = 2_000;
const ENDPOINT_ACTIVATION_WAIT_MS = 8_000;
const RESPONSE_DRAIN_WAIT_MS = 12_000;
const RESPONSE_PROGRESS_SILENCE_MS = 20_000;
const RESPONSE_REPLAY_TIMEOUT_MS = 8_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const MANUAL_OBSERVATION_WARNING = "手动监听模式：仅保存你在独立浏览器中实际浏览到的数据，完整性不会自动验证。";
const LEGACY_CHAT_OBSERVATION_WARNING = "聊天监听模式：使用无头浏览器自动读取；群聊只保存群名和消息统计，好友对话保存已加载的完整消息内容。";
const LEGACY_CHAT_SNAPSHOT_WARNING = "聊天读取（单次）：使用无头浏览器自动读取，完成后自动停止；群聊只保存群名和消息统计，好友对话保存已加载的完整消息内容。";
const CHAT_OBSERVATION_WARNING = "聊天实时接收：整理历史后保持连接，新消息自动更新；暂停接收或关闭采集器后停止。群聊只保存群名和消息统计，好友对话保存已接收的内容。";
const DIRECT_COMPLETE_WARNING_PREFIX = "无界面读取完成：";
const DOWNLOAD_JOB_RETENTION_MS = 30 * 60 * 1_000;
const DOWNLOAD_JOB_LIMIT = 64;

function currentChatWarnings(warnings) {
  return (warnings ?? []).filter((warning) => warning !== LEGACY_CHAT_OBSERVATION_WARNING
    && warning !== LEGACY_CHAT_SNAPSHOT_WARNING
    && !warning.startsWith("本次聊天读取已启用已读回执拦截"));
}

export function directContextLaunchOptions({ executablePath, userAgent, platform = process.platform }) {
  return {
    executablePath,
    // Incremental reads must not create a visible or taskbar Chrome window.
    // Chrome's new headless mode still provides the page runtime needed by
    // Douyin to generate signed list requests.
    headless: true,
    locale: "zh-CN",
    userAgent,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    serviceWorkers: "block",
    args: [
      "--headless=new",
      "--window-size=1280,900",
    ],
  };
}

class CollectorCancelledError extends Error {
  constructor() {
    super("collector_cancelled");
    this.name = "CollectorCancelledError";
  }
}

function recordCounts(records, chatMessages = [], chatConversations = []) {
  const groupIds = new Set((chatConversations ?? [])
    .filter((conversation) => conversation?.kind === "group")
    .map((conversation) => conversation.id));
  const friendMessageCount = (chatMessages ?? []).filter((message) => (
    message?.conversationType !== "group" && !groupIds.has(message?.conversationId)
  )).length;
  const groupMessageCount = (chatConversations ?? [])
    .filter((conversation) => conversation?.kind === "group")
    .reduce((total, conversation) => total + (Number.isSafeInteger(conversation.messageCount) ? conversation.messageCount : 0), 0);
  return {
    watch_history: records.watch_history?.length ?? 0,
    liked_videos: records.liked_videos?.length ?? 0,
    favorite_videos: records.favorite_videos?.length ?? 0,
    chat_messages: Math.min(MAX_CHAT_MESSAGES, friendMessageCount + groupMessageCount),
  };
}

async function readCurrentUserId(page) {
  if (!page || typeof page.evaluate !== "function") return null;
  return page.evaluate(() => {
    const storeId = globalThis.userInfoStore?.curLoginUserInfo?.uid;
    let savedId = null;
    try {
      savedId = JSON.parse(globalThis.localStorage?.getItem("user_info") ?? "null")?.uid ?? null;
    } catch {
      // A malformed local cache should not stop chat collection.
    }
    const value = storeId ?? savedId;
    return value === null || value === undefined ? null : String(value);
  }).catch(() => null);
}

export async function readChatConversationCatalog(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  const rawCatalog = await page.evaluate(() => {
    const store = globalThis.conversationStore;
    if (!store) return [];
    const read = (target, key) => {
      try {
        return target?.[key] ?? null;
      } catch {
        return null;
      }
    };
    const firstText = (...values) => {
      for (const value of values) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        const text = String(value).trim();
        if (text) return text.slice(0, 500);
      }
      return null;
    };
    const mapLookup = (map, key) => {
      if (!map || key === null || key === undefined || key === "") return null;
      try {
        return map.get?.(key) ?? null;
      } catch {
        return null;
      }
    };
    const firstUrl = (...values) => {
      const queue = values.map((value) => ({ value, depth: 0 }));
      const seenValues = new Set();
      let inspected = 0;
      while (queue.length > 0 && inspected < 80) {
        const entry = queue.shift();
        if (!entry || entry.depth > 4) continue;
        inspected += 1;
        const value = entry.value;
        if (typeof value === "string") {
          const text = value.trim();
          if (/^https?:\/\//iu.test(text)) return text.slice(0, 2048);
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 20)) queue.push({ value: item, depth: entry.depth + 1 });
          continue;
        }
        if (!value || typeof value !== "object" || seenValues.has(value)) continue;
        seenValues.add(value);
        for (const key of [
          "avatarUrl", "avatar_url", "avatar", "avatarThumb", "avatar_thumb", "avatarMedium", "avatar_medium", "avatarLarger", "avatar_larger",
          "iconUrl", "icon_url", "icon", "url", "uri", "urlList", "url_list", "originUrlList", "origin_url_list",
          "largeUrlList", "large_url_list", "mediumUrlList", "medium_url_list", "thumbUrlList", "thumb_url_list",
        ]) {
          queue.push({ value: read(value, key), depth: entry.depth + 1 });
        }
      }
      return null;
    };
    const ids = [
      ...(store.sortedConversationIdList ?? []),
      ...(store.sortedStrangerConversationIdList ?? []),
    ];
    const result = [];
    const seen = new Set();
    for (const rawId of ids) {
      const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
      if (!id || seen.has(id)) continue;
      const conversation = store.conversationMap?.get(rawId)
        ?? store.strangerConversationMap?.get(rawId)
        ?? store.conversationMap?.get(id)
        ?? store.strangerConversationMap?.get(id);
      if (!conversation) continue;
      seen.add(id);
      const core = read(conversation, "coreInfo") ?? read(conversation, "core_info");
      const user = read(conversation, "userInfo")
        ?? read(conversation, "user_info")
        ?? read(conversation, "targetUser")
        ?? read(conversation, "target_user")
        ?? read(conversation, "user");
      const coreUser = read(core, "userInfo") ?? read(core, "user_info");
      const businessType = String(
        read(conversation, "bizType") ?? read(conversation, "type") ?? read(conversation, "conversationType") ?? "",
      ).toLowerCase();
      const explicitGroup = businessType === "2" || businessType === "group" || businessType === "group_chat";
      const participantMap = mapLookup(store.participantMapWithConversationId, id);
      let participants = [];
      try { participants = [...(participantMap?.values?.() ?? [])]; } catch { participants = []; }
      const participantSecUid = firstText(
        read(conversation, "toParticipantSecUserId"),
        read(conversation, "to_participant_sec_user_id"),
        read(conversation, "_toParticipantSecUserId"),
      );
      // The conversation objects in the current web client omit bizType. A
      // direct chat carries one target sec UID, while group entries expose
      // several participants and no target UID; use that as a conservative
      // fallback only when the endpoint did not provide an explicit type.
      const isGroup = explicitGroup || (!businessType && !participantSecUid && participants.length > 2);
      const userInfoStore = globalThis.userInfoStore;
      const selfUid = firstText(read(userInfoStore?.curLoginUserInfo, "uid"));
      let participant = null;
      let profile = null;
      if (!isGroup) {
        for (const candidate of participants) {
          const candidateUid = firstText(read(candidate, "userId"), read(candidate, "uid"));
          if (!candidateUid || candidateUid === selfUid) continue;
          const candidateSecUid = firstText(read(candidate, "secUid"), read(candidate, "sec_uid"));
          const candidateProfile = mapLookup(userInfoStore?.usersInfoMap, candidateUid)
            ?? mapLookup(userInfoStore?.usersInfoMap, candidateSecUid);
          participant ??= candidate;
          profile ??= candidateProfile;
          if (candidateProfile) {
            participant = candidate;
            profile = candidateProfile;
            break;
          }
        }
      }
      const name = isGroup
        ? firstText(
            read(conversation, "name"),
            read(conversation, "conversationName"),
            read(conversation, "conversation_name"),
            read(core, "name"),
            read(core, "nickname"),
            read(core, "nickName"),
            read(conversation, "nickname"),
            read(conversation, "nickName"),
            read(user, "nickname"),
            read(user, "nickName"),
            read(user, "name"),
            read(user, "displayName"),
            read(user, "display_name"),
            read(coreUser, "nickname"),
            read(coreUser, "nickName"),
            read(coreUser, "name"),
            read(coreUser, "displayName"),
            read(coreUser, "display_name"),
          )
        : firstText(
            read(profile, "nickname"),
            read(profile, "nickName"),
            read(profile, "nick_name"),
            read(participant, "alias"),
            read(conversation, "nickname"),
            read(conversation, "nickName"),
            read(user, "nickname"),
            read(user, "nickName"),
            read(coreUser, "nickname"),
            read(coreUser, "nickName"),
            read(conversation, "name"),
            read(conversation, "conversationName"),
            read(conversation, "conversation_name"),
            read(core, "name"),
            read(core, "nickname"),
            read(core, "nickName"),
            read(user, "name"),
            read(user, "displayName"),
            read(user, "display_name"),
            read(coreUser, "name"),
            read(coreUser, "displayName"),
            read(coreUser, "display_name"),
      );
      const avatarUrl = firstUrl(
        read(profile, "avatarUrl"),
        read(profile, "avatar_url"),
        read(read(profile, "avatar_thumb"), "url_list"),
        read(read(profile, "avatar_thumb"), "urlList"),
        read(read(profile, "avatar_small"), "url_list"),
        read(read(profile, "avatar_small"), "urlList"),
        read(read(profile, "avatar_medium"), "url_list"),
        read(read(profile, "avatar_medium"), "urlList"),
        read(read(profile, "avatar_larger"), "url_list"),
        read(read(profile, "avatar_larger"), "urlList"),
        read(profile, "avatar_thumb"),
        read(profile, "avatar_small"),
        read(profile, "avatar_medium"),
        read(profile, "avatar_larger"),
        read(profile, "avatar300Url"),
        read(profile, "avatar_300_url"),
        read(profile, "avatarThumb"),
        read(profile, "avatarLarger"),
        read(conversation, "avatarUrl"),
        read(conversation, "avatar_url"),
        read(conversation, "avatar"),
        read(conversation, "avatarThumb"),
        read(conversation, "avatar_thumb"),
        read(conversation, "avatarMedium"),
        read(conversation, "avatar_medium"),
        read(conversation, "avatarLarger"),
        read(conversation, "avatar_larger"),
        read(conversation, "iconUrl"),
        read(conversation, "icon_url"),
        read(conversation, "icon"),
        read(core, "avatarUrl"),
        read(core, "avatar_url"),
        read(core, "avatar"),
        read(core, "avatarThumb"),
        read(core, "avatar_thumb"),
        read(core, "avatarLarger"),
        read(core, "avatar_larger"),
        read(user, "avatarUrl"),
        read(user, "avatar_url"),
        read(user, "avatar"),
        read(user, "avatarThumb"),
        read(user, "avatar_thumb"),
        read(user, "avatarLarger"),
        read(user, "avatar_larger"),
        read(coreUser, "avatarUrl"),
        read(coreUser, "avatar_url"),
        read(coreUser, "avatar"),
        read(coreUser, "avatarThumb"),
        read(coreUser, "avatar_thumb"),
        read(coreUser, "avatarLarger"),
        read(coreUser, "avatar_larger"),
      );
      result.push({
        id,
        kind: isGroup ? "group" : "friend",
        name,
        avatarUrl,
        // The online-status endpoint keys on sec UID, not the conversation id.
        secUid: isGroup ? null : participantSecUid,
      });
    }
    return result;
  }).catch(() => []);
  return normalizeChatConversationCatalog(rawCatalog);
}

export function normalizeChatConversationCatalog(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const conversation = normalizeChatConversation(value);
    if (!conversation || seen.has(conversation.id)) return [];
    seen.add(conversation.id);
    return [conversation];
  });
}

function mergeChatConversationSnapshots(previous = [], current = []) {
  const merged = new Map((current ?? []).map((conversation) => [conversation.id, conversation]));
  for (const conversation of previous ?? []) {
    const next = merged.get(conversation.id);
    if (!next) {
      merged.set(conversation.id, conversation);
      continue;
    }
    merged.set(conversation.id, {
      ...conversation,
      ...next,
      kind: conversation.kind === "group" || next.kind === "group"
        ? "group"
        : next.kind === "unknown" ? conversation.kind : next.kind,
      name: conversation.kind === "group"
        ? conversation.name ?? next.name ?? null
        : next.name ?? conversation.name ?? null,
      avatarUrl: normalizeChatAvatarUrl(next.avatarUrl) ?? normalizeChatAvatarUrl(conversation.avatarUrl) ?? null,
      messageCount: Math.max(conversation.messageCount ?? 0, next.messageCount ?? 0),
      ownMessageCount: Math.max(conversation.ownMessageCount ?? 0, next.ownMessageCount ?? 0),
    });
  }
  return [...merged.values()];
}

function safeMessage(error, fallback) {
  if (error instanceof Error && error.message === "login_timeout") return "登录等待已超时，请重新同步。";
  if (error instanceof DirectHistoryError) return error.message;
  if (error instanceof CollectorAdapterError) return error.message;
  if (error instanceof ChatAdapterError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "抖音网页加载超时，请检查网络后重试。";
  return fallback;
}

async function closeContextWithin(context) {
  if (!context || typeof context.close !== "function") return;
  const closeTask = Promise.resolve().then(() => context.close());
  closeTask.catch(() => undefined);
  let timeout;
  let completed = false;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(resolve, CONTEXT_CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      closeTask.then(() => { completed = true; }, () => undefined),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (completed) return;

  let browser = null;
  try {
    browser = typeof context.browser === "function" ? context.browser() : null;
  } catch {
    return;
  }
  if (!browser || typeof browser.close !== "function") return;
  const browserTask = Promise.resolve().then(() => browser.close()).catch(() => undefined);
  let browserTimeout;
  try {
    await Promise.race([
      browserTask,
      new Promise((resolve) => {
        browserTimeout = setTimeout(resolve, CONTEXT_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(browserTimeout);
  }
}

function mergeRecordList(type, existingRecords, fetchedRecords) {
  if (type !== "watch_history") return structuredClone(fetchedRecords);
  const fetchedById = new Map(fetchedRecords.map((record) => [record.id, record]));
  const existingIds = new Set(existingRecords.map((record) => record.id));
  return [
    ...fetchedRecords.filter((record) => !existingIds.has(record.id)),
    ...existingRecords.map((record) => {
      const fresh = fetchedById.get(record.id);
      return fresh ? mergeRecords(record, fresh) : record;
    }),
  ].sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : 0;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : 0;
    return rightTime - leftTime;
  });
}

function finalizeDirectType(type, incremental, existingRecords, fetchedRecords, knownIds, rejectedIds) {
  if (type === "watch_history") {
    return mergeRecordList(type, existingRecords, fetchedRecords);
  }
  if (!incremental) return structuredClone(fetchedRecords);

  const fetchedById = new Map(fetchedRecords.map((record) => [record.id, record]));
  return [
    ...fetchedRecords.filter((record) => !knownIds.has(record.id)),
    ...existingRecords
      .filter((record) => !rejectedIds.has(record.id))
      .map((record) => {
        const fresh = fetchedById.get(record.id);
        return fresh ? mergeRecords(record, fresh) : record;
      }),
  ];
}

async function readJsonWithReplay(response, fallbackPage, replayUrls) {
  try {
    return await response.json();
  } catch (initialError) {
    const request = typeof response.request === "function" ? response.request() : null;
    if (!request || request.method?.() !== "GET") throw initialError;

    let page = fallbackPage;
    try {
      page = request.frame?.().page?.() ?? fallbackPage;
    } catch {
      // Service-worker requests do not expose a frame; use the active profile page.
    }
    if (!page || typeof page.evaluate !== "function") throw initialError;

    const requestUrl = response.url();
    const rawHeaders = typeof request.allHeaders === "function"
      ? await request.allHeaders().catch(() => ({}))
      : {};
    const headers = Object.fromEntries(Object.entries(rawHeaders).filter(([name]) => (
      !/^(?:accept-encoding|connection|content-length|cookie|host|origin|referer|sec-|user-agent)/iu.test(name)
    )));

    replayUrls.add(requestUrl);
    try {
      const replay = await page.evaluate(async ({ url, requestHeaders, timeoutMs, maxBytes }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const replayedResponse = await fetch(url, {
            method: "GET",
            headers: requestHeaders,
            credentials: "include",
            signal: controller.signal,
          });
          const declaredLength = Number(replayedResponse.headers.get("content-length") ?? 0);
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            return { body: null, ok: replayedResponse.ok, status: replayedResponse.status, tooLarge: true };
          }
          const body = await replayedResponse.text();
          return {
            body,
            ok: replayedResponse.ok,
            status: replayedResponse.status,
            tooLarge: new TextEncoder().encode(body).byteLength > maxBytes,
          };
        } finally {
          clearTimeout(timeout);
        }
      }, {
        url: requestUrl,
        requestHeaders: headers,
        timeoutMs: RESPONSE_REPLAY_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      });
      if (!replay.ok) {
        throw new CollectorAdapterError("http_error", `抖音网页响应重试返回 HTTP ${replay.status}。`);
      }
      if (replay.tooLarge) {
        throw new CollectorAdapterError("response_too_large", "抖音网页响应重试结果过大，已停止读取该页。");
      }
      try {
        return JSON.parse(replay.body);
      } catch {
        throw new CollectorAdapterError("invalid_json", "抖音网页响应重试未返回有效 JSON。");
      }
    } catch (replayError) {
      if (replayError instanceof CollectorAdapterError) throw replayError;
      throw initialError;
    } finally {
      replayUrls.delete(requestUrl);
    }
  }
}

async function readChatResponse(response) {
  try {
    return await response.json();
  } catch (jsonError) {
    if (typeof response.body !== "function") throw jsonError;
    try {
      return await response.body();
    } catch {
      throw jsonError;
    }
  }
}

async function firstVisible(locator, limit = 8) {
  const count = Math.min(await locator.count().catch(() => 0), limit);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function clickFirstVisible(locator) {
  const count = Math.min(await locator.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    try {
      await candidate.click({ timeout: 5_000 });
      return true;
    } catch {
      // A covered or detached candidate should not prevent trying the next match.
    }
  }
  return false;
}

async function clickSemanticTarget(page, labels, {
  roles = ["tab", "link", "button", "menuitem"],
  allowText = false,
  timeoutMs = ENDPOINT_ACTIVATION_WAIT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const label of labels) {
      const locators = [
        ...roles.flatMap((role) => [
          page.getByRole(role, { name: label, exact: true }),
          page.getByRole(role, { name: label, exact: false }),
        ]),
        page.getByLabel(label, { exact: true }),
        page.getByTitle(label, { exact: true }),
      ];
      if (allowText) locators.push(page.getByText(label, { exact: true }));

      for (const locator of locators) {
        if (await clickFirstVisible(locator)) return true;
      }
    }
    if (Date.now() >= deadline) break;
    await delay(250);
  } while (true);
  return false;
}

async function clickProfileTabTarget(page, tab, labels, options = {}) {
  const targetedLocators = [
    page.locator(`[role="tab"][aria-controls="semiTabPanel${tab}"]`),
    page.locator(`[role="tab"][aria-controls$="${tab}"]`),
    page.locator(`a[href*="showTab=${tab}"]`),
  ];
  for (const locator of targetedLocators) {
    if (await clickFirstVisible(locator)) return true;
  }
  return clickSemanticTarget(page, labels, options);
}

async function isProfileTabSelected(page, tab) {
  const locators = [
    page.locator(`[role="tab"][aria-controls="semiTabPanel${tab}"]`),
    page.locator(`[role="tab"][aria-controls$="${tab}"]`),
  ];
  for (const locator of locators) {
    const count = Math.min(await locator.count().catch(() => 0), 4);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const selected = await candidate.evaluate((element) => {
        const ariaSelected = element.getAttribute("aria-selected");
        return ariaSelected === null
          ? /active|selected|current/u.test(String(element.className || ""))
          : ariaSelected === "true";
      }).catch(() => false);
      if (selected) return true;
    }
  }
  return false;
}

export function normalizeOwnProfileUrl(value) {
  try {
    const url = new URL(value, HOME_URL);
    if (url.protocol !== "https:" || !["douyin.com", "www.douyin.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/user\/([^/?#]+)\/?$/u);
    if (!match || match[1] === "self") return null;
    url.hostname = "www.douyin.com";
    url.pathname = `/user/${match[1]}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function profileTabUrl(profileUrl, tab) {
  const normalized = normalizeOwnProfileUrl(profileUrl);
  if (!normalized || !["record", "like", "favorite_collection", "favorite_folder"].includes(tab)) return null;
  const url = new URL(normalized);
  url.searchParams.set("showTab", tab);
  return url.toString();
}

async function findOwnProfileLink(page) {
  for (const label of ["我的", "我的主页", "个人主页", "进入个人主页"]) {
    const candidates = [
      page.getByRole("link", { name: label, exact: true }),
      page.getByRole("link", { name: label, exact: false }),
      page.locator('a[href*="/user/"]').filter({ hasText: label }),
    ];
    for (const locator of candidates) {
      const candidate = await firstVisible(locator);
      if (!candidate) continue;
      const href = await candidate.getAttribute("href").catch(() => null);
      const normalized = normalizeOwnProfileUrl(href);
      if (normalized) return normalized;
    }
  }
  return null;
}

async function hasVisibleLoginControl(page) {
  if (!page || page.isClosed()) return false;
  for (const role of ["button", "link"]) {
    const candidate = await firstVisible(page.getByRole(role, { name: "登录", exact: true }), 4);
    if (candidate) return true;
  }
  return false;
}

async function clearNonCredentialWebCaches(context, page) {
  if (typeof context?.newCDPSession !== "function") return;
  const session = await context.newCDPSession(page).catch(() => null);
  if (!session) return;
  try {
    await session.send("Network.clearBrowserCache").catch(() => undefined);
    for (const origin of ["https://www.douyin.com", "https://douyin.com"]) {
      await session.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "cache_storage,indexeddb,service_workers",
      }).catch(() => undefined);
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function captureVisualSurfaceBaseline(page, targetTab) {
  return page.evaluate((expectedTab) => {
    const panel = document.getElementById(`semiTabPanel${expectedTab}`);
    const reset = () => {
      window.__douyinCollectorVisualBaseline = new Set();
      return 0;
    };
    if (!panel) return reset();
    const rect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(panel);
    if (
      panel.hidden
      || panel.getAttribute("aria-hidden") === "true"
      || style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0
      || rect.width < 80
      || rect.height < 80
    ) return reset();

    const left = Math.max(8, rect.left);
    const right = Math.min(window.innerWidth - 8, rect.right);
    const top = Math.max(8, rect.top);
    const bottom = Math.min(window.innerHeight - 8, rect.bottom);
    if (right - left < 80 || bottom - top < 80) return reset();

    const hits = new Set();
    for (const xRatio of [0.15, 0.4, 0.65, 0.88]) {
      for (const yRatio of [0.18, 0.42, 0.68, 0.88]) {
        const x = left + (right - left) * xRatio;
        const y = top + (bottom - top) * yRatio;
        const topHit = document.elementsFromPoint(x, y)
          .find((element) => element === panel || panel.contains(element));
        if (topHit) hits.add(topHit);
      }
    }
    window.__douyinCollectorVisualBaseline = hits;
    return hits.size;
  }, targetTab).catch(() => 0);
}

async function resolveActiveVisualSurface(page, targetTab) {
  const result = await page.evaluate((expectedTab) => {
    document.querySelectorAll('[data-douyin-collector-surface="active"]')
      .forEach((element) => element.removeAttribute("data-douyin-collector-surface"));

    const panel = document.getElementById(`semiTabPanel${expectedTab}`);
    if (!panel) return { resolved: false, candidateCount: 0 };
    const isWritableScrollSurface = (element, requireOverflow = true) => {
      const style = window.getComputedStyle(element);
      const maximum = element.scrollHeight - element.clientHeight;
      if (maximum <= 80 || (requireOverflow && !/auto|scroll|overlay/u.test(style.overflowY))) return false;
      const before = element.scrollTop;
      const probe = before < maximum - 1 ? before + 1 : Math.max(0, before - 1);
      element.scrollTop = probe;
      const writable = Math.abs(element.scrollTop - before) > 0.5;
      element.scrollTop = before;
      return writable;
    };
    const findFallbackScrollSurface = () => {
      for (let current = panel.parentElement; current; current = current.parentElement) {
        if (isWritableScrollSurface(current)) return current;
      }
      const documentSurface = document.scrollingElement;
      return documentSurface && isWritableScrollSurface(documentSurface, false) ? documentSurface : null;
    };
    const panelRect = panel.getBoundingClientRect();
    const panelStyle = window.getComputedStyle(panel);
    if (
      panel.hidden
      || panel.getAttribute("aria-hidden") === "true"
      || panelStyle.display === "none"
      || panelStyle.visibility === "hidden"
      || Number(panelStyle.opacity) === 0
    ) return { resolved: false, candidateCount: 0 };

    const panelHasBox = panelRect.width >= 80 && panelRect.height >= 80;
    const forcedFallback = panelHasBox ? null : findFallbackScrollSurface();
    if (!panelHasBox && !forcedFallback) return { resolved: false, candidateCount: 0 };
    const samplingRect = forcedFallback?.getBoundingClientRect() ?? panelRect;
    const left = Math.max(8, samplingRect.left);
    const right = Math.min(window.innerWidth - 8, samplingRect.right);
    const top = Math.max(8, samplingRect.top);
    const bottom = Math.min(window.innerHeight - 8, samplingRect.bottom);
    if (right - left < 80 || bottom - top < 80) return { resolved: false, candidateCount: 0 };

    const baseline = window.__douyinCollectorVisualBaseline instanceof Set
      ? window.__douyinCollectorVisualBaseline
      : new Set();
    const visibleThroughAncestors = (element) => {
      for (let current = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return typeof element.checkVisibility === "function"
        ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true;
    };
    const candidates = new Map();
    for (const xRatio of [0.12, 0.34, 0.58, 0.82, 0.94]) {
      for (const yRatio of [0.16, 0.38, 0.62, 0.84, 0.94]) {
        const point = {
          x: left + (right - left) * xRatio,
          y: top + (bottom - top) * yRatio,
        };
        const topHit = document.elementsFromPoint(point.x, point.y)
          .find((element) => !["HTML", "BODY"].includes(element.tagName));
        if (!topHit || !panel.contains(topHit) || !visibleThroughAncestors(topHit)) continue;

        let surface = null;
        for (let current = topHit; current && panel.contains(current); current = current.parentElement) {
          if (isWritableScrollSurface(current)) {
            surface = current;
            break;
          }
        }
        if (!surface) continue;
        const evidence = candidates.get(surface) ?? { hits: 0, newHits: 0 };
        evidence.hits += 1;
        if (!baseline.has(topHit)) evidence.newHits += 1;
        candidates.set(surface, evidence);
      }
    }

    const ranked = [...candidates.entries()].sort((leftEntry, rightEntry) =>
      rightEntry[1].newHits - leftEntry[1].newHits || rightEntry[1].hits - leftEntry[1].hits);
    let winner = forcedFallback ? [forcedFallback, {
      hits: 1,
      newHits: 1,
    }] : ranked[0];
    if (!forcedFallback && (!winner || winner[1].hits < 2 || (baseline.size > 0 && winner[1].newHits < 1))) {
      const fallback = findFallbackScrollSurface();
      if (!fallback) return { resolved: false, candidateCount: ranked.length };
      winner = [fallback, {
        hits: 1,
        newHits: 1,
      }];
    }
    const [surface, evidence] = winner;
    const rect = surface.getBoundingClientRect();
    surface.setAttribute("data-douyin-collector-surface", "active");
    return {
      resolved: true,
      candidateCount: ranked.length,
      hits: evidence.hits,
      newHits: evidence.newHits,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      remaining: Math.max(0, surface.scrollHeight - surface.clientHeight - surface.scrollTop),
    };
  }, targetTab).catch(() => null);
  return result && typeof result === "object"
    ? result
    : { resolved: false, candidateCount: 0 };
}

async function scrollResolvedVisualSurface(page) {
  const result = await page.evaluate(() => {
    const surface = document.querySelector('[data-douyin-collector-surface="active"]');
    if (!surface) return { resolved: false, moved: false, atBottom: true };
    const before = surface.scrollTop;
    surface.scrollTop = surface.scrollHeight;
    const maximum = surface.scrollHeight - surface.clientHeight;
    return {
      resolved: true,
      moved: Math.abs(surface.scrollTop - before) > 1,
      atBottom: maximum - surface.scrollTop <= 2,
    };
  }).catch(() => null);
  return result ?? { resolved: false, moved: false, atBottom: true };
}

async function clickLoadMoreInResolvedVisualSurface(page) {
  return page.evaluate(() => {
    const surface = document.querySelector('[data-douyin-collector-surface="active"]');
    if (!surface) return false;
    const labels = new Set(["加载更多", "查看更多", "继续加载"]);
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.pointerEvents !== "none";
    };
    const control = [surface, ...surface.querySelectorAll('button, a, [role="button"]')]
      .find((element) => {
        if (!(element instanceof HTMLElement) || element.hasAttribute("disabled") || !visible(element)) return false;
        const names = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")]
          .map((value) => value?.trim())
          .filter(Boolean);
        return names.some((name) => labels.has(name));
      });
    if (!control) return false;
    control.click();
    return true;
  }).catch(() => false);
}

export class DouyinCollector {
  constructor({ executablePath, dataDirectory, signerDirectory, store }) {
    this.executablePath = executablePath;
    this.dataDirectory = dataDirectory;
    this.signerDirectory = signerDirectory;
    this.profileDirectory = path.join(dataDirectory, "browser-profile");
    this.store = store;
    this.context = null;
    this.contextHeadless = null;
    this.syncPromise = null;
    this.syncStopRequested = false;
    this.observation = null;
    this.observationPromise = null;
    this.accountSwitchPromise = null;
    this.chat = null;
    this.chatPromise = null;
    this.chatRunId = 0;
    this.chatSends = new Map();
    this.chatSendPromise = null;
    this.syncRunId = 0;
    this.syncMode = null;
    // 边采边存的最小间隔，快照是整份重写的，不能每页都写
    this.progressPersistIntervalMs = 1_500;
    this.snapshot = null;
    this.videoDownloadJobs = new Map();
    this.videoDownloadQueue = Promise.resolve();
    this.videoDownloadControllers = new Set();
    this.videoDownloadActive = null;
    this.statusRevision = 0;
    this.statusListeners = new Set();
    this.status = {
      state: "idle",
      phase: null,
      message: "等待同步",
      counts: recordCounts({ watch_history: [], liked_videos: [], favorite_videos: [] }, [], []),
      progress: null,
      updatedAt: null,
      browserOpen: false,
      code: null,
      // page 要开可见浏览器，direct_records 走无头，前端据此决定还能做什么
      syncMode: null,
      // 聊天接收单独一份状态，这样它和记录读取、视频下载可以同时跑，互不覆盖对方的进度
      chat: { state: "idle", connection: null, message: null, progress: null, code: null },
      chatConnection: null,
    };
  }

  async initialize() {
    // Download jobs are intentionally in-memory only. Remove orphaned files
    // from a previous collector process because there is no job metadata left
    // that could authorize serving them after a restart.
    await rm(path.join(this.dataDirectory, "downloads"), { recursive: true, force: true }).catch(() => undefined);
    this.snapshot = await this.store.load();
    this.snapshot.chatMessages ??= [];
    this.snapshot.chatConversations ??= [];
    this.snapshot.warnings = currentChatWarnings(this.snapshot.warnings);
    this.updateStatus({
      counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
      updatedAt: this.snapshot.updatedAt,
    });
  }

  updateStatus(patch) {
    // 错误码只跟着 error 状态走，进入其他状态时清掉，别让上一次的错误码留在新状态里
    if (patch.state && patch.state !== "error") patch = { code: null, ...patch };
    this.status = { ...this.status, ...patch };
    this.statusRevision += 1;
    for (const listener of this.statusListeners) {
      try { listener(this.getStatus()); } catch { /* A disconnected UI must not interrupt collection. */ }
    }
  }

  // 聊天接收只写自己这份状态，顶层 chatConnection 留作旧字段的镜像
  updateChat(patch) {
    if (patch.state && patch.state !== "error") patch = { code: null, ...patch };
    const chat = { ...this.status.chat, ...patch };
    this.updateStatus({ chat, chatConnection: chat.connection });
  }

  getStatus() {
    return { ...structuredClone(this.status), revision: this.statusRevision };
  }

  subscribeStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  hasActiveVideoDownload() {
    return this.videoDownloadActive !== null
      || [...this.videoDownloadJobs.values()].some((job) => job.status === "queued" || job.status === "running");
  }

  oldestTerminalVideoDownloadJob() {
    return [...this.videoDownloadJobs.values()]
      .filter((job) => job.status !== "queued" && job.status !== "running")
      .sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
        const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
        return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
      })[0] ?? null;
  }

  scheduleVideoDownloadFileCleanup(job) {
    if (job?.playback) {
      void rm(path.join(this.dataDirectory, "downloads", `playback-${job.id}`), { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    if (typeof job?.filePath !== "string" || !job.filePath) return;
    const downloadsDirectory = path.resolve(this.dataDirectory, "downloads");
    const resolved = path.resolve(job.filePath);
    if (resolved === downloadsDirectory || !resolved.startsWith(`${downloadsDirectory}${path.sep}`)) return;
    void rm(resolved, { force: true }).catch(() => undefined);
  }

  retireVideoDownloadJob(job) {
    if (!job || this.videoDownloadJobs.get(job.id) !== job) return false;
    this.videoDownloadJobs.delete(job.id);
    clearTimeout(job.releaseTimer);
    this.scheduleVideoDownloadFileCleanup(job);
    return true;
  }

  pruneVideoDownloadJobs() {
    const cutoff = Date.now() - DOWNLOAD_JOB_RETENTION_MS;
    for (const job of this.videoDownloadJobs.values()) {
      const updatedAt = Date.parse(job.updatedAt ?? job.createdAt ?? "");
      if (job.status === "queued" || job.status === "running") continue;
      if (Number.isFinite(updatedAt) && updatedAt >= cutoff) continue;
      this.retireVideoDownloadJob(job);
    }
    while (this.videoDownloadJobs.size > DOWNLOAD_JOB_LIMIT) {
      const oldest = this.oldestTerminalVideoDownloadJob();
      if (!oldest) break;
      this.retireVideoDownloadJob(oldest);
    }
  }

  reserveVideoDownloadJobSlot() {
    this.pruneVideoDownloadJobs();
    while (this.videoDownloadJobs.size >= DOWNLOAD_JOB_LIMIT) {
      const oldest = this.oldestTerminalVideoDownloadJob();
      if (!oldest) {
        throw new VideoDownloadError("download_job_limit", "视频下载任务队列已满，请稍后重试。", { retryable: true });
      }
      this.retireVideoDownloadJob(oldest);
    }
  }

  publicVideoDownloadJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      sourceUrl: job.sourceUrl,
      status: job.status,
      fileName: job.fileName,
      bytes: job.bytes,
      errorCode: job.errorCode,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  touchVideoDownloadJob(job, patch = {}) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return this.publicVideoDownloadJob(job);
  }

  startVideoDownload(sourceUrl, { playback = false } = {}) {
    const normalizedSourceUrl = normalizeDouyinVideoUrl(sourceUrl);
    if (this.visibleBrowserWorkRunning()) {
      throw new VideoDownloadError("collector_busy", "采集器正在执行其他任务，请稍后再试。", { retryable: true });
    }
    this.reserveVideoDownloadJobSlot();
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      playback,
      sourceUrl: normalizedSourceUrl,
      status: "queued",
      fileName: null,
      filePath: null,
      bytes: null,
      errorCode: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.videoDownloadJobs.set(job.id, job);
    if (playback) {
      // Bound orphaned playback jobs even when a tab disappears before receiving its ID.
      job.releaseTimer = setTimeout(() => this.releaseVideoPlayback(job.id), 120_000);
      job.releaseTimer.unref?.();
    }
    const run = this.videoDownloadQueue
      .catch(() => undefined)
      .then(() => this.runVideoDownloadJob(job));
    this.videoDownloadQueue = run.catch(() => undefined);
    return this.publicVideoDownloadJob(job);
  }

  releaseVideoPlayback(jobId) {
    const job = this.videoDownloadJobs.get(jobId);
    if (!job) return true;
    if (!job.playback) return false;
    job.released = true;
    job.controller?.abort();
    if (job.status !== "running") {
      if (job.status === "queued") job.status = "failed";
      this.retireVideoDownloadJob(job);
    }
    return true;
  }

  getVideoDownloadJob(jobId) {
    this.pruneVideoDownloadJobs();
    return this.publicVideoDownloadJob(this.videoDownloadJobs.get(jobId));
  }

  getVideoDownloadFilePath(jobId) {
    const job = this.videoDownloadJobs.get(jobId);
    if (!job || job.status !== "complete" || !job.filePath) return null;
    const downloadsDirectory = path.resolve(this.dataDirectory, "downloads");
    const resolved = path.resolve(job.filePath);
    if (resolved !== downloadsDirectory && !resolved.startsWith(`${downloadsDirectory}${path.sep}`)) return null;
    return resolved;
  }

  async runVideoDownloadJob(job) {
    if (!job || job.status !== "queued") return;
    if (this.videoDownloadActive) {
      this.touchVideoDownloadJob(job, {
        status: "failed",
        errorCode: "collector_busy",
        error: "采集器正在执行其他下载任务，请稍后再试。",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    const operation = {
      job,
      previousStatus: structuredClone(this.status),
      statusRevisionAfterLaunch: null,
    };
    this.videoDownloadActive = operation;
    const controller = new AbortController();
    job.controller = controller;
    let context = null;
    let ownsContext = false;
    this.videoDownloadControllers.add(controller);
    this.touchVideoDownloadJob(job, {
      status: "running",
      startedAt: new Date().toISOString(),
      errorCode: null,
      error: null,
    });
    try {
      if (this.visibleBrowserWorkRunning()) {
        throw new VideoDownloadError("collector_busy", "采集器正在执行其他任务，请稍后再试。", { retryable: true });
      }
      if (this.context && !this.contextHeadless) {
        throw new VideoDownloadError("collector_busy", "请先停止手动监听，再下载视频。", { retryable: true });
      }
      const existingContext = this.context;
      try {
        context = await this.ensureBrowser({ headless: true });
      } catch (error) {
        operation.statusRevisionAfterLaunch = this.statusRevision;
        throw error;
      }
      ownsContext = context !== existingContext;
      operation.statusRevisionAfterLaunch = this.statusRevision;
      controller.signal.throwIfAborted();
      const result = await downloadDouyinVideo({
        context,
        sourceUrl: job.sourceUrl,
        outputDirectory: path.join(this.dataDirectory, "downloads", ...(job.playback ? [`playback-${job.id}`] : [])),
        signal: controller.signal,
        onProgress: (bytes) => this.touchVideoDownloadJob(job, { bytes }),
      });
      this.touchVideoDownloadJob(job, {
        status: "complete",
        fileName: result.fileName,
        filePath: result.filePath,
        bytes: result.bytes,
        completedAt: new Date().toISOString(),
        errorCode: null,
        error: null,
      });
    } catch (error) {
      const message = error instanceof VideoDownloadError
        ? error.message
        : error instanceof Error && error.message
          ? error.message
          : "视频下载失败，请稍后重试。";
      this.touchVideoDownloadJob(job, {
        status: "failed",
        errorCode: error?.code ?? "download_failed",
        error: message,
        completedAt: new Date().toISOString(),
      });
    } finally {
      this.videoDownloadControllers.delete(controller);
      delete job.controller;
      if (job.released) this.retireVideoDownloadJob(job);
      if (ownsContext && context) {
        // 聊天接收或无界面读取可能中途加入了同一个会话，别把它们一起关掉
        const shared = this.context === context && (this.chat?.active || this.syncMode === "direct_records");
        if (!shared) {
          if (this.context === context) {
            this.context = null;
            this.contextHeadless = null;
          }
          await closeContextWithin(context);
        }
      }
      if (this.videoDownloadActive === operation) {
        const canRestoreStatus = operation.statusRevisionAfterLaunch !== null
          && operation.statusRevisionAfterLaunch === this.statusRevision
          && !this.syncPromise
          && !this.observationPromise
          && !this.chat?.active
          && !this.accountSwitchPromise;
        if (canRestoreStatus) this.updateStatus(operation.previousStatus);
        this.videoDownloadActive = null;
      }
    }
  }

  async clearRecords() {
    await this.stopObservation({ silent: true });
    await this.stopChatObservation({ silent: true });
    this.snapshot = await this.store.clear();
    this.updateStatus({
      state: "idle",
      phase: null,
      progress: null,
      message: "本地记录已清除",
      counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
      updatedAt: this.snapshot.updatedAt,
    });
    return this.getSnapshot();
  }

  startSync({ allowAccountSwitch = false, mode = "page" } = {}) {
    if (this.syncPromise || this.observationPromise || (this.accountSwitchPromise && !allowAccountSwitch)) return false;
    // 无界面读取和聊天接收、视频下载共用一个无头会话，可以同时进行；
    // 需要可见浏览器的完整读取仍要等它们结束
    if (mode !== "direct_records" && (this.chatPromise || this.hasActiveVideoDownload())) return false;
    this.syncStopRequested = false;
    this.syncMode = mode;
    const runId = this.syncRunId + 1;
    this.syncRunId = runId;
    this.updateStatus({
      syncMode: mode,
      state: mode === "direct_records" ? "collecting" : "launching_browser",
      phase: mode === "direct_records" ? "watch_history" : null,
      progress: null,
      message: mode === "direct_records" ? "正在直接读取观看、点赞和收藏记录" : "正在准备同步",
    });
    const promise = (mode === "direct_records" ? this.runDirectRecords(runId) : this.runSync(runId))
      .catch((error) => {
        if (error instanceof CollectorCancelledError || runId !== this.syncRunId) return;
        this.updateStatus({
          state: "error",
          code: error?.code ?? null,
          phase: null,
          progress: null,
          message: safeMessage(error, mode === "direct_records"
            ? "记录直接读取失败。"
            : "采集失败，请关闭浏览器后重试。"),
        });
      })
      .finally(() => {
        if (this.syncPromise === promise) {
          this.syncPromise = null;
          this.syncMode = null;
          this.updateStatus({ syncMode: null });
        }
      });
    this.syncPromise = promise;
    return true;
  }

  stopSync({ silent = false } = {}) {
    const promise = this.syncPromise;
    if (!promise || this.syncStopRequested) return false;

    this.syncStopRequested = true;
    const cancellationRunId = this.syncRunId + 1;
    this.syncRunId = cancellationRunId;
    if (!silent) {
      this.updateStatus({
        state: "collecting",
        phase: null,
        progress: null,
        message: "正在停止读取",
      });
    }

    void promise.finally(() => {
      this.syncStopRequested = false;
      if (silent || this.syncRunId !== cancellationRunId) return;
      this.updateStatus({
        state: "idle",
        phase: null,
        progress: null,
        message: "已停止读取，已保留上次保存的记录",
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
        browserOpen: Boolean(this.context),
      });
    });
    return true;
  }

  startDirectRecords() {
    return this.startSync({ mode: "direct_records" });
  }

  // 聊天接收独立于记录读取和视频下载，只有要打开可见浏览器的任务才会挡住它
  startChatObservation({ allowAccountSwitch = false } = {}) {
    if (this.chatPromise || this.observationPromise || this.syncMode === "page"
      || (this.accountSwitchPromise && !allowAccountSwitch)) return false;
    const runId = this.chatRunId + 1;
    this.chatRunId = runId;
    let releaseStop;
    const chat = {
      active: true,
      mode: "chat",
      runId,
      stop: () => releaseStop?.(),
      stopPromise: new Promise((resolve) => {
        releaseStop = resolve;
      }),
    };
    this.chat = chat;
    this.updateChat({ state: "launching_browser", connection: "connecting", message: "正在连接抖音实时消息" });
    const promise = this.runChatObservation(runId, chat)
      .catch(async (error) => {
        if (error instanceof CollectorCancelledError || !chat.active || runId !== this.chatRunId) return;
        this.updateChat({
          state: "error",
          code: error?.code ?? null,
          connection: null,
          message: safeMessage(error, "聊天读取启动失败，请稍后重试。"),
        });
        await this.releaseHeadlessContextIfIdle();
      })
      .finally(() => {
        if (this.chat === chat) this.chat = null;
        if (this.chatPromise === promise) this.chatPromise = null;
      });
    this.chatPromise = promise;
    return true;
  }

  async stopChatObservation({ silent = false } = {}) {
    const chat = this.chat;
    const promise = this.chatPromise;
    if (!chat || !promise) return false;
    chat.stopping = true;
    // Let an in-flight send settle so its result is known; bounded because
    // callers of the stop endpoint time out after ten seconds.
    if (this.chatSendPromise) {
      const settled = new AbortController();
      await Promise.race([this.chatSendPromise.catch(() => undefined), delay(8_000, undefined, { signal: settled.signal }).catch(() => undefined)]);
      settled.abort();
    }
    chat.active = false;
    this.chatRunId += 1;
    chat.stop();
    if (this.context && this.contextHeadless) {
      const context = this.context;
      const otherPages = context.pages().filter((page) => page !== chat.page && !page.isClosed?.());
      // 记录读取、播放和探索各有自己的标签页，只有没人再用这个会话时才关掉它
      if (chat.page?.close && (otherPages.length > 0 || this.headlessWorkRunning())) {
        await chat.page.close().catch(() => undefined);
      } else {
        this.context = null;
        this.contextHeadless = null;
        // Closing also releases a pending navigation during cancellation.
        await closeContextWithin(context);
      }
    }
    await promise.catch(() => undefined);
    if (!silent) {
      this.updateChat({ state: "idle", connection: null, message: "已暂停实时接收，已保留聊天记录" });
      this.updateStatus({
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
        browserOpen: Boolean(this.context),
      });
    }
    return true;
  }

  // 有任务正占着可见浏览器窗口吗（完整读取、手动监听、切换账号）
  visibleBrowserWorkRunning() {
    return this.syncMode === "page" || Boolean(this.observationPromise) || Boolean(this.accountSwitchPromise);
  }

  // 还有别的无头任务在用这个共享会话吗
  headlessWorkRunning() {
    return this.syncMode === "direct_records" || this.hasActiveVideoDownload();
  }

  async releaseHeadlessContextIfIdle() {
    if (!this.context || !this.contextHeadless) return;
    if (this.chat?.active || this.headlessWorkRunning()) return;
    const context = this.context;
    this.context = null;
    this.contextHeadless = null;
    await closeContextWithin(context);
    this.updateStatus({ browserOpen: false });
  }

  isChatReceiving() {
    return this.chat?.active === true && this.contextHeadless === true
      && this.status.chat.state === "observing";
  }

  async sendChatMessage(input) {
    const request = validateChatSend(input);
    const fingerprint = `${request.conversationId}\n${request.text}`;
    const previous = this.chatSends.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ChatSendError("invalid_request", "请重新发送这条消息。", 400);
      return previous.result;
    }
    const observation = this.chat;
    if (!this.isChatReceiving() || observation.stopping || !observation.page || observation.page.isClosed()) throw new ChatSendError("not_receiving", "先开始接收消息，才能发送。");
    if (!observation.historyReady) throw new ChatSendError("collector_busy", "正在整理聊天历史，整理完就能发送。");
    if (this.status.chat.connection !== "connected") throw new ChatSendError("not_connected", "消息连接还没连上，请稍后再发。");
    if (this.chatSendPromise) throw new ChatSendError("collector_busy", "上一条还在发送，请稍等。");
    if (this.chatSends.size >= 1000) this.chatSends.delete(this.chatSends.keys().next().value);
    // One send at a time, deduplicated by requestId; a dispatched message is never retried here.
    const result = sendChatText(observation.page, request).then((outcome) => {
      if (outcome.chatMessage) observation.acceptSent?.(outcome.chatMessage);
      return outcome;
    });
    this.chatSends.set(request.requestId, { fingerprint, result });
    this.chatSendPromise = result;
    try {
      return await result;
    } catch (error) {
      // Only failures before the click reach here, so the same request may run again.
      this.chatSends.delete(request.requestId);
      throw error;
    } finally {
      if (this.chatSendPromise === result) this.chatSendPromise = null;
    }
  }

  isManualObserving() {
    return this.observation?.active === true && this.observation.mode === "records"
      && this.contextHeadless === false && this.status.state === "observing";
  }

  // 手动监听要打开可见浏览器，所有无头任务都得先让位
  startObservation({ allowAccountSwitch = false } = {}) {
    if (this.syncPromise || this.observationPromise || this.chatPromise || this.hasActiveVideoDownload()
      || (this.accountSwitchPromise && !allowAccountSwitch)) return false;
    const runId = this.syncRunId + 1;
    this.syncRunId = runId;
    let releaseStop;
    const observation = {
      active: true,
      mode: "records",
      runId,
      stop: () => releaseStop?.(),
      stopPromise: new Promise((resolve) => {
        releaseStop = resolve;
      }),
    };
    this.observation = observation;
    this.updateStatus({
      state: "launching_browser",
      phase: null,
      progress: null,
      message: "正在打开独立抖音浏览器以监听手动浏览",
    });
    const promise = this.runObservation(runId, observation)
      .catch((error) => {
        if (error instanceof CollectorCancelledError || !observation.active || runId !== this.syncRunId) return;
        this.updateStatus({
          state: "error",
          code: error?.code ?? null,
          phase: null,
          progress: null,
          message: safeMessage(error, "手动监听启动失败，请关闭浏览器后重试。"),
        });
      })
      .finally(() => {
        if (this.observation === observation) this.observation = null;
        if (this.observationPromise === promise) this.observationPromise = null;
      });
    this.observationPromise = promise;
    return true;
  }

  async stopObservation({ silent = false } = {}) {
    const observation = this.observation;
    const promise = this.observationPromise;
    if (!observation || !promise) return false;
    observation.stopping = true;
    observation.active = false;
    this.syncRunId += 1;
    observation.stop();
    await promise.catch(() => undefined);
    if (!silent) {
      this.updateStatus({
        state: "idle",
        phase: null,
        progress: null,
        message: "已停止手动监听，已保存已捕获的记录",
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
        browserOpen: Boolean(this.context),
      });
    }
    return true;
  }

  async runObservation(runId, observation) {
    const context = await this.ensureBrowser();
    this.assertSyncActive(runId);
    let page = await this.currentPage(context);
    if (!normalizeOwnProfileUrl(page.url()) && !new URL(page.url()).hostname.endsWith("douyin.com")) {
      await this.visit(page, HOME_URL, runId);
    }
    await this.waitForLogin(context, page, runId);
    this.assertSyncActive(runId);
    page = await this.currentPage(context);
    const browserUserAgent = typeof page.evaluate === "function"
      ? await page.evaluate(() => navigator.userAgent).catch(() => null)
      : null;

    const accumulator = new RecordAccumulator(this.snapshot.records);
    const pendingResponses = new Set();
    const processingChains = new Map();
    const replayUrls = new Set();
    let persistChain = Promise.resolve();
    let capturedResponses = 0;
    let acceptingResponses = true;

    const persistSnapshot = () => {
      persistChain = persistChain.then(async () => {
        if (!observation.active || runId !== this.syncRunId) return;
        const warnings = [...new Set([
          ...this.snapshot.warnings.filter((warning) => warning !== MANUAL_OBSERVATION_WARNING),
          MANUAL_OBSERVATION_WARNING,
        ])];
        this.snapshot = await this.store.save(accumulator.snapshot().records, warnings, {
          directSync: normalizeDirectSyncState(this.snapshot.directSync),
          chatMessages: this.snapshot.chatMessages,
          chatConversations: this.snapshot.chatConversations,
        });
        if (!observation.active || runId !== this.syncRunId) return;
        this.updateStatus({
          counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
          updatedAt: this.snapshot.updatedAt,
          message: `正在监听手动浏览，已捕获 ${capturedResponses} 个网页响应`,
        });
      });
      return persistChain;
    };

    const handleResponse = (response) => {
      if (!acceptingResponses || !observation.active || runId !== this.syncRunId) return;
      const endpoint = matchDouyinEndpoint(response.url());
      if (!endpoint) return;
      if (replayUrls.has(response.url())) return;
      const previous = processingChains.get(endpoint.pathname) ?? Promise.resolve();
      let task;
      task = previous.catch(() => undefined).then(async () => {
        if (!observation.active || runId !== this.syncRunId) return;
        if (!response.ok()) throw new CollectorAdapterError("http_error", `抖音网页请求返回 HTTP ${response.status()}。`);
        const declaredLength = Number(response.headers()["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          throw new CollectorAdapterError("response_too_large", "抖音网页响应过大，已停止读取该页。");
        }
        const payload = await readJsonWithReplay(response, page, replayUrls);
        if (!observation.active || runId !== this.syncRunId) return;
        accumulator.addResponse(endpoint, payload);
        if (endpoint.kind === "watch_history") {
          const request = typeof response.request === "function" ? response.request() : null;
          await captureDirectHistoryTemplate(this.dataDirectory, request, browserUserAgent).catch(() => false);
        }
        capturedResponses += 1;
        await persistSnapshot();
      }).catch(() => undefined).finally(() => {
        pendingResponses.delete(task);
        if (processingChains.get(endpoint.pathname) === task) processingChains.delete(endpoint.pathname);
      });
      processingChains.set(endpoint.pathname, task);
      pendingResponses.add(task);
    };

    context.on("response", handleResponse);
    this.updateStatus({
      state: "observing",
      phase: null,
      message: "正在监听手动浏览，请在独立浏览器中自行打开观看历史、喜欢和收藏",
      browserOpen: true,
    });
    await observation.stopPromise;
    acceptingResponses = false;
    context.off("response", handleResponse);
    await Promise.allSettled([...pendingResponses]);
    await persistChain;
  }

  async runChatObservation(runId, observation) {
    // 聊天的进度写进 status.chat，共享字段（计数、浏览器开关）才落到主状态上
    const report = ({ state, progress, message, chatConnection, ...shared }) => {
      const patch = {};
      if (state !== undefined) patch.state = state;
      if (progress !== undefined) patch.progress = progress;
      if (message !== undefined) patch.message = message;
      if (chatConnection !== undefined) patch.connection = chatConnection;
      // 记录读取那条线也在写 counts，聊天只认领自己那一项，免得两边来回覆盖
      if (shared.counts) shared.counts = { ...this.status.counts, chat_messages: shared.counts.chat_messages };
      if (Object.keys(shared).length > 0) this.updateStatus(shared);
      if (Object.keys(patch).length > 0) this.updateChat(patch);
    };
    const context = await this.ensureBrowser({ headless: true });
    this.assertChatActive(runId);
    let page = await this.currentPage(context);
    await this.waitForLogin(context, page, runId, { headless: true });
    this.assertChatActive(runId);
    page = await this.currentPage(context);
    if (!/^https:\/\/www\.douyin\.com\/(?:chat(?:[/?#]|$)|(?:[?#].*)?$)/u.test(page.url() ?? "") && page.url() !== "about:blank") {
      page = await context.newPage();
    }
    observation.page = page;

    const currentUserId = await readCurrentUserId(page);
    const existingGroupIds = new Set((this.snapshot.chatConversations ?? [])
      .filter((conversation) => conversation.kind === "group")
      .map((conversation) => conversation.id));
    const accumulator = new ChatMessageAccumulator((this.snapshot.chatMessages ?? []).filter((message) => (
      message?.conversationType !== "group" && !existingGroupIds.has(message?.conversationId)
    )));
    const conversationAccumulator = new ChatConversationAccumulator(this.snapshot.chatConversations ?? [], currentUserId);
    conversationAccumulator.addMessages(accumulator.snapshot());
    const initialGroups = new Map((this.snapshot.chatConversations ?? []).filter((conversation) => conversation.kind === "group").map((conversation) => [conversation.id, conversation]));
    const initialSnapshotTime = Date.parse(this.snapshot.updatedAt ?? "") || 0;
    const newGroupMessages = new Map();
    const pendingResponses = new Set();
    const processingChains = new Map();
    const paginationByConversation = new Map();
    const responseCountByConversation = new Map();
    let persistChain = Promise.resolve();
    let capturedResponses = 0;
    const responseErrors = [];
    let acceptingResponses = true;
    let conversationCurrent = 0;
    let conversationTotal = 0;
    let sweepFinished = false;
    let sweepPromise = Promise.resolve();
    let reconnectTimer;
    let reconnectPromise = null;
    let lastCatalogRefresh = 0;
    const receptionMessage = () => this.status.chatConnection === "connected"
      ? "正在实时接收新消息"
      : this.status.chatConnection === "reconnecting"
        ? "消息连接已断开，正在自动重连"
        : "正在连接实时消息";

    const persistSnapshot = () => {
      persistChain = persistChain.then(async () => {
        if (!observation.active || runId !== this.chatRunId) return;
        const warnings = [...new Set([
          ...currentChatWarnings(this.snapshot.warnings).filter((warning) => warning !== CHAT_OBSERVATION_WARNING),
          CHAT_OBSERVATION_WARNING,
          ...responseErrors,
        ])];
        this.snapshot = await this.store.save(this.snapshot.records, warnings, {
          directSync: normalizeDirectSyncState(this.snapshot.directSync),
          chatMessages: accumulator.snapshot(),
          chatConversations: mergeChatConversationSnapshots(
            this.snapshot.chatConversations ?? [],
            conversationAccumulator.snapshot().map((conversation) => {
              const baseline = initialGroups.get(conversation.id);
              const newMessages = newGroupMessages.get(conversation.id);
              if (!baseline || !newMessages) return conversation;
              return {
                ...conversation,
                messageCount: Math.max(conversation.messageCount, baseline.messageCount + newMessages.size),
                ownMessageCount: Math.max(conversation.ownMessageCount, baseline.ownMessageCount + [...newMessages.values()].filter((sender) => sender === conversationAccumulator.currentUserId).length),
              };
            }),
          ),
        });
        if (!observation.active || runId !== this.chatRunId) return;
        const count = recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations).chat_messages;
        report({
          progress: sweepFinished ? null : { current: conversationCurrent, total: conversationTotal },
          counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
          updatedAt: this.snapshot.updatedAt,
          message: sweepFinished ? receptionMessage() : `聊天历史整理：会话 ${conversationCurrent}/${conversationTotal}，已接收 ${count} 条互动`,
        });
      });
      return persistChain;
    };

    const processPayload = async (normalized) => {
      if (!observation.active || runId !== this.chatRunId) return;
      if (!conversationAccumulator.currentUserId) {
        const detectedUserId = await readCurrentUserId(page);
        if (detectedUserId) conversationAccumulator.setCurrentUserId(detectedUserId);
      }
      if (Date.now() - lastCatalogRefresh >= 5_000 && normalized.messages.some((message) => !conversationAccumulator.conversations.get(message.conversationId)?.name)) {
        lastCatalogRefresh = Date.now();
        conversationAccumulator.addConversations(await readChatConversationCatalog(page));
      }
      if (!observation.active || runId !== this.chatRunId) return;
      const metadataById = new Map((normalized.conversations ?? []).map((conversation) => [conversation.id, conversation]));
      const messages = normalized.messages.map((message) => {
        const conversation = metadataById.get(message.conversationId);
        const knownConversation = conversationAccumulator.conversations.get(message.conversationId);
        return {
          ...message,
          conversationType: message.conversationType === "unknown"
            ? conversation?.kind ?? knownConversation?.kind ?? "unknown"
            : message.conversationType,
          conversationName: message.conversationName ?? conversation?.name ?? knownConversation?.name ?? null,
        };
      });
      const conversationIds = new Set([
        ...(normalized.conversations ?? []).map((conversation) => conversation.id),
        ...messages.map((message) => message.conversationId),
      ]);
      for (const conversationId of conversationIds) {
        // Push notifications have no history cursor; never let them cancel
        // an in-flight history page or masquerade as a paging response.
        if (!conversationId || normalized.hasMore === null) continue;
        paginationByConversation.set(conversationId, {
          hasMore: normalized.hasMore,
          cursor: normalized.nextTimestamp,
        });
        responseCountByConversation.set(
          conversationId,
          (responseCountByConversation.get(conversationId) ?? 0) + 1,
        );
      }
      conversationAccumulator.addConversations(normalized.conversations);
      for (const message of messages) {
        if (message.conversationType !== "group" || !initialGroups.has(message.conversationId)
          || !(Date.parse(message.sentAt ?? "") > initialSnapshotTime)
          || conversationAccumulator.messageIds.get(message.conversationId)?.has(message.id)) continue;
        const newer = newGroupMessages.get(message.conversationId) ?? new Map();
        newer.set(message.id, message.senderId);
        newGroupMessages.set(message.conversationId, newer);
      }
      conversationAccumulator.addMessages(messages.map((message) => message.conversationType === "group"
        ? {
            id: message.id,
            conversationId: message.conversationId,
            conversationType: message.conversationType,
            senderId: message.senderId,
          }
        : message));
      // Group bodies are deliberately discarded at the collector boundary;
      // only the summary accumulator sees them.
      accumulator.addMessages(messages.filter((message) => message.conversationType !== "group"));
      capturedResponses += 1;
      if (messages.length > 0 || normalized.conversations?.length > 0) await persistSnapshot();
    };

    const receiveError = (error) => {
      if (!observation.active || runId !== this.chatRunId) return;
      const message = safeMessage(error, "聊天响应读取失败，已继续等待后续消息。");
      if (!responseErrors.includes(message)) responseErrors.push(message);
      report({ message });
    };
    const enqueuePayload = (readPayload) => {
      if (!acceptingResponses || !observation.active || runId !== this.chatRunId) return;
      const previous = processingChains.get("chat") ?? Promise.resolve();
      let task;
      task = previous.catch(() => undefined).then(async () => {
        if (!observation.active || runId !== this.chatRunId) return;
        await processPayload(await readPayload());
      }).catch(receiveError).finally(() => {
        pendingResponses.delete(task);
        if (processingChains.get("chat") === task) processingChains.delete("chat");
      });
      processingChains.set("chat", task);
      pendingResponses.add(task);
    };
    const handleResponse = (response) => {
      const endpoint = matchChatEndpoint(response.url());
      if (!endpoint) return;
      // The site polls its own online-status endpoint while the chat page is
      // open. Reading that answer keeps presence truthful without this app
      // ever asking for it, so nothing here changes what friends see.
      if (endpoint.kind === "chat_presence") {
        if (!acceptingResponses || !observation.active || runId !== this.chatRunId) return;
        Promise.resolve()
          .then(async () => {
            if (!response.ok()) return;
            conversationAccumulator.applyPresence(normalizeChatPresence(await readChatResponse(response)));
          })
          .catch(() => {});
        return;
      }
      enqueuePayload(async () => {
        if (!response.ok()) throw new ChatAdapterError("http_error", `聊天请求返回 HTTP ${response.status()}。`);
        const headers = typeof response.headers === "function" ? response.headers() : {};
        const declaredLength = Number(headers?.["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          throw new ChatAdapterError("response_too_large", "聊天响应过大，已停止读取该页。");
        }
        const body = await readChatResponse(response);
        const bodyBytes = typeof body === "string" ? Buffer.byteLength(body) : body?.byteLength ?? body?.length ?? 0;
        if (bodyBytes > MAX_RESPONSE_BYTES) throw new ChatAdapterError("response_too_large", "聊天响应过大，已停止读取该页。");
        return normalizeChatPayload(body, { endpoint });
      });
    };

    // Messages sent from this app: the site's own push may or may not echo them.
    observation.acceptSent = (message) => enqueuePayload(() => ({ messages: [message], conversations: [], hasMore: null }));
    const stopSockets = observeChatSockets(context, {
      onPayload: (normalized) => enqueuePayload(() => normalized),
      onConnection: (chatConnection) => {
        if (!observation.active || runId !== this.chatRunId) return;
        report({ chatConnection });
        if (sweepFinished) report({ message: receptionMessage() });
      },
      onError: receiveError,
    });
    context.on("response", handleResponse);
    try {
      report({
        state: "observing",
        progress: { current: 0, total: 0 },
        message: "聊天全量读取：正在读取会话列表",
        browserOpen: true,
      });
      const currentUrl = page.url() ?? "";
      if (currentUrl.includes("/chat")) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
        await delay(1_500);
        this.assertChatActive(runId);
      } else {
        await this.visit(page, CHAT_URL, runId);
      }
      const detectedUserId = await readCurrentUserId(page);
      if (detectedUserId) conversationAccumulator.setCurrentUserId(detectedUserId);
      report({
        state: "observing",
        progress: { current: 0, total: 0 },
        message: "聊天全量读取：正在整理会话列表",
        browserOpen: true,
      });

      sweepPromise = (async () => {
        let catalog = [];
        for (let attempt = 0; attempt < 5 && catalog.length === 0; attempt += 1) {
          this.assertChatActive(runId);
          catalog = await readChatConversationCatalog(page);
          if (catalog.length === 0) await delay(500);
        }
        conversationTotal = catalog.length;
        report({
          progress: { current: 0, total: conversationTotal },
          message: conversationTotal > 0
            ? `聊天全量读取：发现 ${conversationTotal} 个会话（0/${conversationTotal}）`
            : "聊天全量读取：未发现可读取的会话",
        });
        conversationAccumulator.addConversations(catalog);
        if (catalog.length > 0) await persistSnapshot();
        for (const [index, conversation] of catalog.entries()) {
          this.assertChatActive(runId);
          conversationCurrent = index + 1;
          if (typeof page.evaluate !== "function") break;
          const selected = await page.evaluate((conversationId) => {
            const store = globalThis.conversationStore;
            const item = store?.conversationMap?.get(conversationId)
              ?? store?.strangerConversationMap?.get(conversationId);
            if (!store || !item || typeof store.setCurConversation !== "function") return false;
            try {
              store.setCurConversation(item);
              return true;
            } catch {
              return false;
            }
          }, conversation.id).catch(() => false);
          if (!selected) continue;
          report({
            progress: { current: conversationCurrent, total: conversationTotal },
            message: `聊天全量读取：正在读取会话（${conversationCurrent}/${conversationTotal}）`,
          });
          await delay(850);
          // ponytail: group history can be enormous, so summaries use the pages
          // exposed during this run; a dedicated cursor export can be added if
          // exact all-history group counts become a requirement.
          // Friend conversations follow their cursor until completion or the
          // endpoint stops producing a response; the page cap is a last-resort
          // guard for a server that never advances its cursor.
          if (conversation.kind !== "friend" || typeof page.evaluate !== "function") continue;
          for (let pageCount = 0; pageCount < CHAT_FRIEND_HISTORY_PAGE_LIMIT; pageCount += 1) {
            this.assertChatActive(runId);
            const pagination = paginationByConversation.get(conversation.id);
            if (!pagination || pagination.hasMore !== true) break;
            const beforeResponses = responseCountByConversation.get(conversation.id) ?? 0;
            const moved = await page.evaluate(() => {
              const list = document.querySelector(".messageMessageListlist");
              if (!list) return false;
              list.scrollTop = list.scrollHeight;
              list.dispatchEvent(new Event("scroll", { bubbles: true }));
              return true;
            }).catch(() => false);
            if (!moved) break;
            report({
              progress: { current: conversationCurrent, total: conversationTotal },
              message: `聊天全量读取：会话 ${conversationCurrent}/${conversationTotal}，正在读取第 ${pageCount + 1} 页`,
            });
            await delay(1_000);
            if ((responseCountByConversation.get(conversation.id) ?? 0) === beforeResponses) break;
          }
        }
        // Selecting each friend conversation can lazily hydrate the profile
        // cache. Read the catalog once more after the sweep so nicknames and
        // avatars that arrived during history paging are persisted as well.
        const refreshedCatalog = await readChatConversationCatalog(page);
        if (refreshedCatalog.length > 0) {
          conversationAccumulator.addConversations(refreshedCatalog);
        }
        if (catalog.length > 0 || capturedResponses > 0) await persistSnapshot();
      })().catch((error) => {
        if (error instanceof CollectorCancelledError || runId !== this.chatRunId) return;
        // A catalog/sweep failure must not discard responses already captured.
        const message = safeMessage(error, "聊天会话扫描未完成，已保留已读取的消息。");
        if (!responseErrors.includes(message)) responseErrors.push(message);
        return persistSnapshot();
      }).finally(() => {
        sweepFinished = true;
        observation.historyReady = true;
      });

      // History hydration and live pushes share one accumulator. Finishing
      // history must not remove the listeners or close the receiving browser.
      await Promise.race([observation.stopPromise, sweepPromise]);
      if (sweepFinished && observation.active && runId === this.chatRunId) {
        report({
          state: "observing",
          progress: null,
          message: receptionMessage(),
          counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
          updatedAt: this.snapshot.updatedAt,
          browserOpen: true,
        });
        // The website handles normal socket reconnection. A reload is only a
        // fallback for a disconnected SDK that has stopped making progress.
        reconnectTimer = setInterval(() => {
          if (!observation.active || runId !== this.chatRunId || this.status.chatConnection === "connected" || reconnectPromise || this.chatSendPromise) return;
          reconnectPromise = (async () => {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
            if (!observation.active || runId !== this.chatRunId) return;
            conversationAccumulator.addConversations(await readChatConversationCatalog(page));
            await persistSnapshot();
          })().catch(() => {
            if (observation.active && runId === this.chatRunId) report({ chatConnection: "reconnecting", message: "消息连接暂不可用，正在重试" });
          }).finally(() => { reconnectPromise = null; });
        }, 30_000);
        await observation.stopPromise;
      }
    } finally {
      acceptingResponses = false;
      clearInterval(reconnectTimer);
      stopSockets();
      context.off("response", handleResponse);
      await Promise.allSettled([...pendingResponses, sweepPromise, reconnectPromise]);
      await persistChain;
    }
  }

  assertSyncActive(runId) {
    if (runId !== this.syncRunId) throw new CollectorCancelledError();
  }

  assertChatActive(runId) {
    if (runId !== this.chatRunId) throw new CollectorCancelledError();
  }

  async ensureBrowser({ headless = false } = {}) {
    if (this.context && (this.contextHeadless === headless || (this.contextHeadless === null && !headless))) {
      this.contextHeadless ??= false;
      return this.context;
    }
    if (this.context) {
      const staleContext = this.context;
      this.context = null;
      this.contextHeadless = null;
      await closeContextWithin(staleContext);
    }

    // 无头会话是几个任务共用的，启动它不该覆盖主状态；调用方自己会报告进度
    this.updateStatus(headless
      ? { browserOpen: false }
      : { state: "launching_browser", message: "正在打开独立抖音浏览器", browserOpen: false });
    // 无头会话是聊天接收、无界面读取和视频下载共用的，按最严的那个来配：
    // 屏蔽 Service Worker，并换上抓到的真实 UA——无头默认 UA 会被抖音列表接口挡掉。
    // ponytail: 模板要跑过一次完整读取才有；没有就先用默认 UA，那时也还做不了无界面读取
    const launchOptions = headless
      ? directContextLaunchOptions({
        executablePath: this.executablePath,
        userAgent: await loadDirectHistoryTemplate(this.dataDirectory)
          .then((template) => template.headers["user-agent"])
          .catch(() => undefined),
      })
      : {
        executablePath: this.executablePath,
        headless: false,
        locale: "zh-CN",
        // Visible pages must follow the real window, including user resizing.
        // A fixed emulated viewport can extend beyond the native content area.
        viewport: null,
        acceptDownloads: false,
      };
    const context = await chromium.launchPersistentContext(this.profileDirectory, launchOptions);
    this.context = context;
    this.contextHeadless = headless;
    context.on("close", () => {
      if (this.context !== context) return;
      this.context = null;
      this.contextHeadless = null;
      if (this.chat?.active) {
        this.chat.active = false;
        this.chat.stop();
        this.updateChat({ state: "idle", connection: null, progress: null, message: "浏览器会话已关闭，实时接收已停止" });
      }
      if (this.observation?.active) {
        this.observation.active = false;
        this.observation.stop();
      }
      this.updateStatus({
        state: this.status.state === "observing" ? "idle" : this.status.state,
        phase: this.status.state === "observing" ? null : this.status.phase,
        progress: this.status.state === "observing" ? null : this.status.progress,
        message: this.status.state === "observing" ? "独立浏览器已关闭，手动监听已停止" : this.status.message,
        browserOpen: false,
      });
    });
    this.updateStatus({ browserOpen: true });
    return context;
  }

  async currentPage(context) {
    // Comet exposes its onboarding WebContents as the first page, but it is
    // not a normal browser tab. Navigating it can fail or clip the website.
    const existing = context.pages().find((page) => !page.isClosed()
      && !/^(?:chrome|chrome-extension|edge|devtools):/u.test(page.url()));
    return existing ?? context.newPage();
  }

  async hasLoginSession(context, page) {
    const cookies = await context.cookies(HOME_URL);
    const hasCookie = cookies.some((cookie) => LOGIN_COOKIE_NAMES.has(cookie.name) && cookie.value.length > 0);
    return hasCookie && !await hasVisibleLoginControl(page);
  }

  async waitForLogin(context, page, runId, { headless = false } = {}) {
    this.assertSyncActive(runId);
    if (await this.hasLoginSession(context, page)) return;

    if (headless) {
      throw new ChatAdapterError("login_required", "聊天无头采集需要先在手动监听中完成一次登录。");
    }

    this.updateStatus({
      state: "awaiting_login",
      phase: null,
      message: "请在独立浏览器中登录抖音，登录后会自动继续",
    });
    const deadline = Date.now() + MAX_LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      this.assertSyncActive(runId);
      if (page.isClosed()) page = await this.currentPage(context);
      if (await this.hasLoginSession(context, page)) return;
      await delay(1_500);
    }
    this.assertSyncActive(runId);
    if (page.isClosed()) page = await this.currentPage(context);
    if (await this.hasLoginSession(context, page)) return;
    throw new Error("login_timeout");
  }

  async visit(page, url, runId) {
    this.assertSyncActive(runId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await delay(1_500);
    this.assertSyncActive(runId);
  }

  async resolveOwnProfileUrl(page, runId) {
    const current = normalizeOwnProfileUrl(page.url());
    if (current) return current;

    await this.visit(page, HOME_URL, runId);
    let profileUrl = await findOwnProfileLink(page);
    if (profileUrl) return profileUrl;

    await clickSemanticTarget(page, ["我的", "我的主页", "个人主页"], {
      roles: ["link", "button", "menuitem"],
      allowText: true,
      timeoutMs: 4_000,
    });
    await delay(750);
    this.assertSyncActive(runId);
    for (const candidatePage of [...page.context().pages()].reverse()) {
      profileUrl = normalizeOwnProfileUrl(candidatePage.url()) ?? await findOwnProfileLink(candidatePage);
      if (profileUrl) return profileUrl;
    }

    await this.visit(page, SELF_PROFILE_URL, runId);
    return normalizeOwnProfileUrl(page.url()) ?? await findOwnProfileLink(page);
  }

  async waitForVersionAdvance(responseVersions, kind, before, runId, timeoutMs = ENDPOINT_ACTIVATION_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertSyncActive(runId);
      if ((responseVersions.get(kind) ?? 0) > before) return true;
      await delay(200);
    }
    return (responseVersions.get(kind) ?? 0) > before;
  }

  async scrollUntilIdle(
    page,
    responseVersions,
    kinds,
    runId,
    terminalProgresses = [],
    maxSteps = Number.POSITIVE_INFINITY,
    targetTab = null,
    timing = {},
  ) {
    const now = timing.now ?? Date.now;
    const wait = timing.wait ?? delay;
    const responseSilenceTimeoutMs = timing.responseSilenceTimeoutMs ?? RESPONSE_PROGRESS_SILENCE_MS;
    let lastVersion = kinds.reduce((sum, kind) => sum + (responseVersions.get(kind) ?? 0), 0);
    let lastResponseProgressAt = now();
    let idleSteps = 0;
    let lastLoadMoreVersion = null;

    const recordVersionProgress = () => {
      const version = kinds.reduce((sum, kind) => sum + (responseVersions.get(kind) ?? 0), 0);
      const advanced = version !== lastVersion;
      if (advanced) {
        lastVersion = version;
        lastResponseProgressAt = now();
        idleSteps = 0;
      }
      return advanced;
    };
    const stopAfterResponseSilence = () => {
      if (now() - lastResponseProgressAt < responseSilenceTimeoutMs) return false;
      for (const progress of terminalProgresses) progress.responseProgressStalled = true;
      return true;
    };

    if (!targetTab) {
      for (const progress of terminalProgresses) progress.visualSurfaceMissing = true;
      return;
    }

    for (let step = 0; step < maxSteps && idleSteps < 8; step += 1) {
      this.assertSyncActive(runId);
      recordVersionProgress();
      if (stopAfterResponseSilence()) break;
      const activeProgresses = terminalProgresses.filter((progress) => progress.matchedCount > 0);
      if (activeProgresses.length > 0 && activeProgresses.every((progress) => isEndpointComplete(progress))) break;
      if (activeProgresses.some((progress) => (
        progress.cursorStalled || progress.paginationMissing || progress.repeatedPageFingerprint
      ))) break;
      if (activeProgresses.some((progress) => progress.processedCount < progress.matchedCount)) {
        await wait(250);
        continue;
      }

      let visualResult = await scrollResolvedVisualSurface(page)
        .catch(() => ({ resolved: false, moved: false, atBottom: true }));
      if (!visualResult.resolved) {
        const visualSurface = await resolveActiveVisualSurface(page, targetTab);
        if (!visualSurface.resolved) {
          for (const progress of terminalProgresses) progress.visualSurfaceMissing = true;
          break;
        }
        visualResult = await scrollResolvedVisualSurface(page)
          .catch(() => ({ resolved: false, moved: false, atBottom: true }));
        if (!visualResult.resolved) {
          for (const progress of terminalProgresses) progress.visualSurfaceMissing = true;
          break;
        }
      }

      const loadedMore = visualResult.atBottom
        && !visualResult.moved
        && lastLoadMoreVersion !== lastVersion
        ? await clickLoadMoreInResolvedVisualSurface(page)
        : false;
      if (loadedMore) lastLoadMoreVersion = lastVersion;
      await wait(900);
      this.assertSyncActive(runId);
      const advanced = recordVersionProgress();
      if (!advanced) {
        idleSteps = visualResult.moved || loadedMore ? 0 : idleSteps + 1;
      }
      if (stopAfterResponseSilence()) break;
    }
  }

  async collectPhase(page, responseVersions, phase, runId, terminalProgresses) {
    const before = responseVersions.get(phase) ?? 0;
    let fallbackLabels = [];
    let targetUrl = null;
    let targetTab = null;

    if (phase === "watch_history") {
      fallbackLabels = ["观看历史", "历史记录", "浏览记录"];
      targetTab = "record";
      const profileUrl = await this.resolveOwnProfileUrl(page, runId);
      targetUrl = profileTabUrl(profileUrl, targetTab) ?? `${SELF_PROFILE_URL}?showTab=${targetTab}`;
      const neutralUrl = profileTabUrl(profileUrl, "like") ?? `${SELF_PROFILE_URL}?showTab=like`;
      await this.visit(page, neutralUrl, runId);
      if (!await isProfileTabSelected(page, "like")) {
        await clickProfileTabTarget(page, "like", ["喜欢", "点赞"], {
          roles: ["tab", "link", "button", "menuitem"],
          allowText: true,
          timeoutMs: 4_000,
        });
        await delay(1_000);
        this.assertSyncActive(runId);
      }
      await captureVisualSurfaceBaseline(page, "like");
      await clickProfileTabTarget(page, targetTab, fallbackLabels, {
        allowText: true,
        timeoutMs: 5_000,
      });
    } else {
      targetTab = phase === "liked_videos" ? "like" : "favorite_collection";
      fallbackLabels = phase === "liked_videos"
        ? ["喜欢", "点赞"]
        : ["收藏", "收藏作品", "收藏视频", "收藏夹"];
      const profileUrl = await this.resolveOwnProfileUrl(page, runId);
      const neutralTab = "record";
      const neutralUrl = profileTabUrl(profileUrl, neutralTab) ?? `${SELF_PROFILE_URL}?showTab=${neutralTab}`;
      targetUrl = profileTabUrl(profileUrl, targetTab) ?? `${SELF_PROFILE_URL}?showTab=${targetTab}`;
      await this.visit(page, neutralUrl, runId);
      if (!await isProfileTabSelected(page, neutralTab)) {
        const neutralLabels = neutralTab === "record"
          ? ["观看历史", "历史记录", "浏览记录"]
          : ["收藏", "收藏作品", "收藏视频"];
        await clickProfileTabTarget(page, neutralTab, neutralLabels, {
          roles: ["tab", "link", "button", "menuitem"],
          allowText: true,
          timeoutMs: 4_000,
        });
        await delay(1_000);
        this.assertSyncActive(runId);
      }
      await captureVisualSurfaceBaseline(page, neutralTab);
      if (!await isProfileTabSelected(page, targetTab) || (responseVersions.get(phase) ?? 0) === before) {
        await clickProfileTabTarget(page, targetTab, fallbackLabels, {
          roles: ["tab", "link", "button", "menuitem"],
          allowText: true,
        });
      }
    }

    let advanced = await this.waitForVersionAdvance(responseVersions, phase, before, runId);
    let selected = targetTab ? await isProfileTabSelected(page, targetTab) : false;
    if (!advanced || !selected) {
      await clickProfileTabTarget(page, targetTab, fallbackLabels, {
        roles: ["tab", "link", "button", "menuitem"],
        allowText: true,
        timeoutMs: 4_000,
      });
      advanced = advanced || await this.waitForVersionAdvance(responseVersions, phase, before, runId, 3_000);
      selected = await isProfileTabSelected(page, targetTab);
    }
    if ((!advanced || !selected) && targetUrl) {
      await this.visit(page, targetUrl, runId);
      if (!await isProfileTabSelected(page, targetTab)) {
        await clickProfileTabTarget(page, targetTab, fallbackLabels, {
          roles: ["tab", "link", "button", "menuitem"],
          allowText: true,
          timeoutMs: 4_000,
        });
      }
      advanced = await this.waitForVersionAdvance(responseVersions, phase, before, runId, 5_000);
      selected = await isProfileTabSelected(page, targetTab);
    }
    if ((!advanced || !selected) && targetUrl && typeof page.reload === "function") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await delay(1_500);
      this.assertSyncActive(runId);
      if (!await isProfileTabSelected(page, targetTab)) {
        await clickProfileTabTarget(page, targetTab, fallbackLabels, {
          roles: ["tab", "link", "button", "menuitem"],
          allowText: true,
          timeoutMs: 4_000,
        });
      }
      await this.waitForVersionAdvance(responseVersions, phase, before, runId, 4_000);
    }
    const kinds = [phase];
    await resolveActiveVisualSurface(page, targetTab);
    await this.scrollUntilIdle(
      page,
      responseVersions,
      kinds,
      runId,
      terminalProgresses,
      Number.POSITIVE_INFINITY,
      targetTab,
    );
  }

  async runSync(runId) {
    this.assertSyncActive(runId);
    const context = await this.ensureBrowser();
    this.assertSyncActive(runId);
    let page = await this.currentPage(context);
    await clearNonCredentialWebCaches(context, page);
    await this.visit(page, HOME_URL, runId);
    await this.waitForLogin(context, page, runId);
    this.assertSyncActive(runId);
    page = await this.currentPage(context);
    const browserUserAgent = typeof page.evaluate === "function"
      ? await page.evaluate(() => navigator.userAgent)
      : null;

    const accumulator = new RecordAccumulator();
    const responseVersions = new Map();
    const primaryProgress = new Map(REQUIRED_TYPES.map((type) => [type, createEndpointProgress()]));
    const sampleIds = new Map(REQUIRED_TYPES.map((type) => [type, []]));
    const sampledIdSets = new Map(REQUIRED_TYPES.map((type) => [type, new Set()]));
    const activeProgressByPath = new Map();
    const responseErrors = [];
    const pendingResponses = new Set();
    const processingChains = new Map();
    const replayUrls = new Set();
    let lastResponseAt = 0;
    let acceptingResponses = true;

    const drainPendingResponses = async () => {
      const deadline = Date.now() + RESPONSE_DRAIN_WAIT_MS;
      while (Date.now() < deadline) {
        this.assertSyncActive(runId);
        const batch = [...pendingResponses];
        if (batch.length > 0) {
          const remaining = Math.max(1, deadline - Date.now());
          await Promise.race([
            Promise.allSettled(batch),
            delay(Math.min(1_000, remaining)),
          ]);
        }
        const quietFor = lastResponseAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastResponseAt;
        if (pendingResponses.size === 0 && quietFor >= 600) return true;
        await delay(Math.min(250, Math.max(50, 600 - quietFor)));
      }
      return pendingResponses.size === 0;
    };

    const handleResponse = (response) => {
      if (!acceptingResponses || runId !== this.syncRunId) return;
      const endpoint = matchDouyinEndpoint(response.url());
      if (!endpoint) return;
      if (replayUrls.has(response.url())) return;
      const progress = activeProgressByPath.get(endpoint.pathname);
      if (!progress) return;
      lastResponseAt = Date.now();
      responseVersions.set(endpoint.kind, (responseVersions.get(endpoint.kind) ?? 0) + 1);
      recordEndpointMatch(progress);
      const previous = processingChains.get(endpoint.pathname) ?? Promise.resolve();
      let task;
      task = previous.catch(() => undefined).then(async () => {
        if (!response.ok()) throw new CollectorAdapterError("http_error", `抖音网页请求返回 HTTP ${response.status()}。`);
        const declaredLength = Number(response.headers()["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          throw new CollectorAdapterError("response_too_large", "抖音网页响应过大，已停止读取该页。");
        }
        const payload = await readJsonWithReplay(response, page, replayUrls);
        this.assertSyncActive(runId);
        if (!acceptingResponses) return;
        const normalized = accumulator.addResponse(endpoint, payload);
        if (endpoint.kind === "watch_history") {
          const request = typeof response.request === "function" ? response.request() : null;
          await captureDirectHistoryTemplate(this.dataDirectory, request, browserUserAgent).catch(() => false);
        }
        const ids = sampleIds.get(endpoint.kind);
        const seen = sampledIdSets.get(endpoint.kind);
        for (const id of normalized.recordIds ?? []) {
          if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
        recordEndpointResult(progress, normalized.pagination, normalized);
        this.updateStatus({ counts: recordCounts(accumulator.snapshot().records, this.snapshot.chatMessages, this.snapshot.chatConversations) });
      }).catch((error) => {
        if (error instanceof CollectorCancelledError || runId !== this.syncRunId) return;
        responseErrors.push(safeMessage(error, "抖音响应读取失败。"));
      }).finally(() => {
        pendingResponses.delete(task);
        if (processingChains.get(endpoint.pathname) === task) processingChains.delete(endpoint.pathname);
      });
      processingChains.set(endpoint.pathname, task);
      pendingResponses.add(task);
    };

    context.on("response", handleResponse);
    const phaseWarnings = [];

    try {
      for (const phase of REQUIRED_TYPES) {
        this.assertSyncActive(runId);
        page = await this.currentPage(context);
        this.updateStatus({
          state: "collecting",
          phase,
          message: phase === "watch_history"
            ? "正在读取观看历史"
            : phase === "liked_videos"
              ? "正在读取点赞列表"
              : "正在读取收藏列表",
        });
        const progress = primaryProgress.get(phase);
        activeProgressByPath.set(REQUIRED_PATHS[phase], progress);
        await this.collectPhase(page, responseVersions, phase, runId, [progress]).catch((error) => {
          if (error instanceof CollectorCancelledError) throw error;
          phaseWarnings.push(safeMessage(error, "页面操作失败。"));
        });
        await drainPendingResponses();
        activeProgressByPath.delete(REQUIRED_PATHS[phase]);
      }

      const drained = await drainPendingResponses();
      acceptingResponses = false;
      if (!drained) phaseWarnings.push("部分抖音响应读取超时，本次结果按不完整数据处理。");

      const completeTypes = new Set();
      for (const type of REQUIRED_TYPES) {
        const progress = primaryProgress.get(type);
        if (isEndpointComplete(progress)) completeTypes.add(type);
      }

      const addProgressWarnings = (label, progress, { required = true } = {}) => {
        if (progress.matchedCount === 0) {
          if (required && !progress.verifiedEmpty) phaseWarnings.push(`${label}未捕获到网页响应。`);
          if (progress.responseProgressStalled) phaseWarnings.push(`${label}长时间没有新的网页响应，已停止继续滚动。`);
          return;
        }
        if (progress.processedCount < progress.matchedCount) {
          phaseWarnings.push(`${label}部分网页响应未能读取。`);
        }
        if (progress.visualSurfaceMissing) {
          phaseWarnings.push(`${label}未继续滚动，已使用当前读取到的 ${progress.uniqueAddedCount} 条。`);
        }
        if (progress.responseProgressStalled) {
          phaseWarnings.push(`${label}长时间没有新的网页响应，已停止继续滚动并使用当前结果。`);
        }
      };

      for (const type of REQUIRED_TYPES) {
        addProgressWarnings(TYPE_LABELS[type], primaryProgress.get(type));
      }

      const normalized = accumulator.snapshot().records;
      for (const type of REQUIRED_TYPES) {
        const currentById = new Map(normalized[type].map((record) => [record.id, record]));
        const currentSample = sampleIds.get(type).flatMap((id) => currentById.has(id) ? [currentById.get(id)] : []);
        if (completeTypes.has(type)) {
          normalized[type] = type === "watch_history"
            ? mergeRecordList(type, this.snapshot.records[type], currentSample)
            : currentSample;
        } else if (this.snapshot.records[type].length > 0) {
          normalized[type] = structuredClone(this.snapshot.records[type]);
          phaseWarnings.push(`${TYPE_LABELS[type]}读取不完整，已保留上次样本。`);
        } else {
          normalized[type] = currentSample;
          phaseWarnings.push(currentSample.length > 0
            ? `${TYPE_LABELS[type]}读取不完整，已使用本次读取到的 ${currentSample.length} 条。`
            : `${TYPE_LABELS[type]}未读取到可用记录，也未确认列表为空。`);
        }
      }

      const warnings = [...new Set([...phaseWarnings, ...responseErrors])];
      this.assertSyncActive(runId);
      this.snapshot = await this.store.save(normalized, warnings, {
        directSync: normalizeDirectSyncState(this.snapshot.directSync),
        chatMessages: this.snapshot.chatMessages,
        chatConversations: this.snapshot.chatConversations,
      });
      const complete = completeTypes.size === REQUIRED_TYPES.length && responseErrors.length === 0;
      this.updateStatus({
        state: complete ? "complete" : "partial",
        phase: null,
        progress: null,
        message: complete ? "全部可见记录已读取" : "部分列表未完整读取，已保留现有数据",
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
      });
    } finally {
      acceptingResponses = false;
      context.off("response", handleResponse);
    }
  }

  async readDirectHistory(context, cursor = "0") {
    const page = context.pages()[0] ?? await context.newPage();
    const currentUserAgent = await page.evaluate(() => navigator.userAgent);
    return fetchDirectHistoryPage({
      context,
      currentUserAgent,
      dataDirectory: this.dataDirectory,
      directory: this.signerDirectory,
      cursor,
    });
  }

  async collectDirectList(context, type, onPage) {
    return collectDirectRecordPages(context, type, onPage);
  }

  async runDirectRecords(runId) {
    this.assertSyncActive(runId);
    const visibleContext = this.contextHeadless === true ? null : this.context;
    if (visibleContext) {
      this.context = null;
      this.contextHeadless = null;
      await closeContextWithin(visibleContext);
      this.updateStatus({ browserOpen: false });
    }
    // 借用共用的无头会话另开标签页，聊天接收和视频下载可以一直跑着
    const context = await this.ensureBrowser({ headless: true });
    let page = null;
    try {
      this.assertSyncActive(runId);
      page = await context.newPage();
      const currentUserAgent = await page.evaluate(() => navigator.userAgent);
      const accumulator = new RecordAccumulator();
      const existingRecords = structuredClone(this.snapshot.records);
      const stagedRecords = structuredClone(existingRecords);
      const directSync = normalizeDirectSyncState(this.snapshot.directSync, this.snapshot.warnings);
      const incrementalByType = new Map(REQUIRED_TYPES.map((type) => [type, directSync[type]]));
      const allIncremental = REQUIRED_TYPES.every((type) => incrementalByType.get(type));
      const knownIds = new Map(REQUIRED_TYPES.map((type) => [
        type,
        new Set(incrementalByType.get(type) ? existingRecords[type].map((record) => record.id) : []),
      ]));
      const newIds = new Map(REQUIRED_TYPES.map((type) => [type, new Set()]));
      const rejectedIds = new Map(REQUIRED_TYPES.map((type) => [type, new Set()]));
      const returnedCounts = new Map(REQUIRED_TYPES.map((type) => [type, 0]));
      const filteredCounts = new Map(REQUIRED_TYPES.map((type) => [type, 0]));
      const pageCounts = {};
      let missingViewTimes = 0;
      const phases = [
        ["watch_history", DIRECT_HISTORY_ENDPOINT],
        ["liked_videos", DIRECT_LIKED_ENDPOINT],
        ["favorite_videos", DIRECT_FAVORITE_ENDPOINT],
      ];

      const trackResult = (type, result) => {
        returnedCounts.set(type, returnedCounts.get(type) + result.pageSize);
        filteredCounts.set(type, filteredCounts.get(type) + result.rejectedRecordIds.length);
        for (const id of result.acceptedRecordIds) {
          if (!knownIds.get(type).has(id)) newIds.get(type).add(id);
        }
        for (const id of result.rejectedRecordIds) rejectedIds.get(type).add(id);
      };
      const previewRecords = (type) => {
        const preview = structuredClone(stagedRecords);
        preview[type] = finalizeDirectType(
          type,
          incrementalByType.get(type),
          existingRecords[type],
          accumulator.snapshot().records[type],
          knownIds.get(type),
          rejectedIds.get(type),
        );
        return preview;
      };
      const progressMessage = (type, pageCount) => {
        const returned = returnedCounts.get(type);
        const filtered = filteredCounts.get(type);
        return incrementalByType.get(type)
          ? `正在读取${TYPE_LABELS[type]}新增记录（第 ${pageCount} 页，接口 ${returned} 条，新增 ${newIds.get(type).size} 条，过滤 ${filtered} 条）`
          : `正在读取${TYPE_LABELS[type]}全部记录（第 ${pageCount} 页，接口 ${returned} 条，保留 ${accumulator.snapshot().records[type].length} 条，过滤 ${filtered} 条）`;
      };
      // 每读一段就落盘，工作台边采边能看到新记录；限流是因为快照要整份重写
      let lastProgressPersistAt = Date.now();
      const persistProgress = async (type) => {
        if (Date.now() - lastProgressPersistAt < this.progressPersistIntervalMs) return;
        lastProgressPersistAt = Date.now();
        this.assertSyncActive(runId);
        this.snapshot = await this.store.save(previewRecords(type), this.snapshot.warnings, {
          directSync,
          chatMessages: this.snapshot.chatMessages,
          chatConversations: this.snapshot.chatConversations,
        });
        this.updateStatus({ updatedAt: this.snapshot.updatedAt });
      };
      const persistCompletedType = async (type, finalPhase) => {
        this.assertSyncActive(runId);
        stagedRecords[type] = previewRecords(type)[type];
        directSync[type] = true;
        const newCounts = Object.fromEntries(REQUIRED_TYPES.map((kind) => [kind, newIds.get(kind).size]));
        const warnings = [...new Set([
          finalPhase
            ? `${DIRECT_COMPLETE_WARNING_PREFIX}新增观看 ${newCounts.watch_history}、点赞 ${newCounts.liked_videos}、收藏 ${newCounts.favorite_videos}；读取观看历史 ${pageCounts.watch_history} 页、点赞 ${pageCounts.liked_videos} 页、收藏 ${pageCounts.favorite_videos} 页。`
            : `无界面读取阶段完成：${TYPE_LABELS[type]}已保存，其他分类继续读取。`,
          ...(missingViewTimes > 0
            ? [`其中 ${missingViewTimes} 条缺少观看日期，已保持为空，未使用发布时间或采集时间替代。`]
            : []),
        ])];
        this.snapshot = await this.store.save(stagedRecords, warnings, {
          directSync,
          chatMessages: this.snapshot.chatMessages,
          chatConversations: this.snapshot.chatConversations,
        });
        this.updateStatus({
          counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
          updatedAt: this.snapshot.updatedAt,
        });
      };

      for (const [phaseIndex, [type, endpointUrl]] of phases.entries()) {
        const endpoint = matchDouyinEndpoint(endpointUrl);
        if (type !== "watch_history") {
          pageCounts[type] = await this.collectDirectList(context, type, async (payload, pageCount) => {
            this.assertSyncActive(runId);
            const result = accumulator.addResponse(endpoint, payload);
            trackResult(type, result);
            this.updateStatus({
              phase: type,
              message: progressMessage(type, pageCount),
              counts: recordCounts(previewRecords(type), this.snapshot.chatMessages, this.snapshot.chatConversations),
            });
            await persistProgress(type);
            return !result.recordIds.some((id) => knownIds.get(type).has(id));
          });
          await persistCompletedType(type, phaseIndex === phases.length - 1);
          continue;
        }
        const cursors = new Set();
        const pageFingerprints = new Set();
        let cursor = "0";
        pageCounts[type] = 0;
        while (true) {
          this.assertSyncActive(runId);
          if (cursors.has(cursor)) {
            throw new DirectHistoryError("pagination_stalled", `${TYPE_LABELS[type]}分页游标重复，已停止且未保存本次结果。`);
          }
          cursors.add(cursor);
          const payload = await this.readDirectHistory(context, cursor);
          this.assertSyncActive(runId);
          const result = accumulator.addResponse(endpoint, payload);
          trackResult(type, result);
          pageCounts[type] += 1;
          if (type === "watch_history") missingViewTimes += countMissingDirectHistoryViewTimes(payload);
          if (result.pageFingerprint && pageFingerprints.has(result.pageFingerprint)) {
            throw new DirectHistoryError("pagination_stalled", `${TYPE_LABELS[type]}分页内容重复，已停止且未保存本次结果。`);
          }
          if (result.pageFingerprint) pageFingerprints.add(result.pageFingerprint);
          if (accumulator.isTruncated(type)) {
            throw new DirectHistoryError("record_limit", `${TYPE_LABELS[type]}响应超过本地安全容量，已停止且未保存本次结果。`);
          }
          this.updateStatus({
            phase: type,
            message: progressMessage(type, pageCounts[type]),
            counts: recordCounts(previewRecords(type), this.snapshot.chatMessages, this.snapshot.chatConversations),
          });
          await persistProgress(type);
          if (result.recordIds.some((id) => knownIds.get(type).has(id))) break;
          if (result.pagination.hasMore === false) break;
          if (result.pagination.hasMore !== true || !result.pagination.cursor) {
            throw new DirectHistoryError("pagination_missing", `${TYPE_LABELS[type]}响应缺少下一页游标，已停止且未保存本次结果。`);
          }
          cursor = result.pagination.cursor;
          await delay(900);
        }
        await persistCompletedType(type, phaseIndex === phases.length - 1);
      }
      const newCounts = Object.fromEntries(REQUIRED_TYPES.map((type) => [type, newIds.get(type).size]));
      this.updateStatus({
        state: "complete",
        phase: null,
        progress: null,
        message: allIncremental
          ? `已读取新增记录（观看 ${newCounts.watch_history}、点赞 ${newCounts.liked_videos}、收藏 ${newCounts.favorite_videos}）`
          : `已读取并合并全部可见记录（观看 ${stagedRecords.watch_history.length}、点赞 ${stagedRecords.liked_videos.length}、收藏 ${stagedRecords.favorite_videos.length}）`,
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
      });
    } finally {
      await page?.close().catch(() => undefined);
      // 读取结束后不留常驻的无头 Chrome，除非聊天或下载还在用它
      this.syncMode = null;
      await this.releaseHeadlessContextIfIdle();
    }
  }

  async switchAccount() {
    if (this.accountSwitchPromise) return false;
    if (this.hasActiveVideoDownload()) {
      throw new VideoDownloadError("collector_busy", "采集器正在下载视频，请稍后再试。", { retryable: true });
    }
    const promise = (async () => {
      this.syncRunId += 1;
      const runningSync = this.syncPromise;
      const runningObservation = this.observationPromise;
      if (runningObservation) await this.stopObservation({ silent: true });
      if (this.chatPromise) await this.stopChatObservation({ silent: true });
      if (runningSync) await runningSync;
      const context = this.context ?? await this.ensureBrowser();
      await this.clearDedicatedAccountData(context);
      await invalidateDirectHistoryTemplate(this.dataDirectory);
      await this.close();

      this.snapshot = await this.store.clear();
      this.updateStatus({
        state: "idle",
        phase: null,
        message: "旧账号会话已清除",
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
        browserOpen: false,
      });
      if (!this.startObservation({ allowAccountSwitch: true })) throw new Error("account_switch_observation_not_started");
    })();
    this.accountSwitchPromise = promise;
    try {
      await promise;
      return true;
    } finally {
      if (this.accountSwitchPromise === promise) this.accountSwitchPromise = null;
    }
  }

  async clearDedicatedAccountData(context) {
    const page = await this.currentPage(context);
    const session = await context.newCDPSession(page);
    try {
      await session.send("Network.clearBrowserCache");
      for (const origin of [
        "https://www.douyin.com",
        "https://douyin.com",
        "https://passport.douyin.com",
      ]) {
        await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      }
      await context.clearCookies();
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  async close() {
    for (const job of this.videoDownloadJobs.values()) {
      if (job.playback) {
        this.releaseVideoPlayback(job.id);
        continue;
      }
      if (job.status === "queued") {
        this.touchVideoDownloadJob(job, {
          status: "failed",
          errorCode: "collector_closed",
          error: "采集器已关闭，下载任务未执行。",
          completedAt: new Date().toISOString(),
        });
      }
    }
    for (const controller of this.videoDownloadControllers) controller.abort(new Error("collector_closed"));
    this.stopSync({ silent: true });
    await this.stopObservation({ silent: true });
    await this.stopChatObservation({ silent: true });
    const context = this.context;
    this.context = null;
    this.contextHeadless = null;
    if (context) await closeContextWithin(context);
  }
}
