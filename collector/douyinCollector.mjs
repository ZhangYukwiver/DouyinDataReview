import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

import {
  DIRECT_FAVORITE_ENDPOINT,
  DIRECT_HISTORY_ENDPOINT,
  DIRECT_LIKED_ENDPOINT,
  DirectHistoryError,
  captureDirectHistoryTemplate,
  countMissingDirectHistoryViewTimes,
  fetchDirectHistoryPage,
  loadDirectHistoryTemplate,
  validateDirectHistoryUrl,
} from "./directHistory.mjs";
import {
  CollectorAdapterError,
  RecordAccumulator,
  matchDouyinEndpoint,
  createEmptyRecords,
  mergeRecords,
  normalizeDouyinResponse,
  normalizeRecord,
} from "./normalizer.mjs";
import {
  ChatAdapterError,
  ChatConversationAccumulator,
  ChatMessageAccumulator,
  normalizeChatAvatarUrl,
} from "./chatNormalizer.mjs";
import { normalizeDirectSyncState } from "./store.mjs";
import {
  downloadDouyinVideo,
  resolveDouyinStream,
  normalizeDouyinVideoUrl,
  VideoDownloadError,
} from "./videoDownloader.mjs";
import { ChatSendError, validateChatSend } from "./chatSender.mjs";
import { CreatorCenter } from "./creatorCenter.mjs";
import { LiveRooms } from "./liveRoom.mjs";
import { DirectApiClient, loadDirectSession, saveDirectSession, sameDirectSession, needsDirectSessionRefresh } from "./directApi.mjs";
import { readDirectCredentialMaterial, completeDirectCredentialExport, requireDirectCredentials } from "./directCredentials.mjs";
import { DirectChatClient } from "./directChat.mjs";
import { BrowserConnectionError } from "./browserConnection.mjs";

const HOME_URL = "https://www.douyin.com/";
const SELF_PROFILE_URL = "https://www.douyin.com/user/self";
const LOGIN_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const REQUIRED_TYPES = ["watch_history", "liked_videos", "favorite_videos"];
const TYPE_LABELS = { watch_history: "观看历史", liked_videos: "点赞列表", favorite_videos: "收藏列表" };
const ENDPOINT_ACTIVATION_WAIT_MS = 8_000;
const MAX_CHAT_MESSAGES = 100_000;
// ponytail: bound a broken cursor chain while still allowing the 100k-message
// local cap to be reached for a genuinely long friend conversation.
const CHAT_FRIEND_HISTORY_PAGE_LIMIT = 2_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const DIRECT_CREDENTIAL_EXPORT_TIMEOUT_MS = 45_000;
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

export async function readLoginIdentity(page) {
  if (!page || typeof page.evaluate !== "function") return null;
  const raw = await page.evaluate(() => {
    const str = (value) => (typeof value === "string" && value) ? value : (typeof value === "number" && value ? String(value) : null);
    const pickUrl = (value) => typeof value === "string" ? (value || null)
      : Array.isArray(value?.url_list) ? (value.url_list.find((url) => typeof url === "string" && url) ?? null) : null;
    let rendered = null;
    try {
      rendered = JSON.parse(decodeURIComponent(globalThis.document?.getElementById("RENDER_DATA")?.textContent ?? ""))?.app?.user ?? null;
    } catch {
      // 页面没有或改了格式就只看 store
    }
    const current = globalThis.userInfoStore?.curLoginUserInfo;
    const source = current?.uid ? current : (rendered?.isLogin && rendered.info?.uid ? rendered.info : null);
    let saved = null;
    try {
      saved = JSON.parse(globalThis.localStorage?.getItem("user_info") ?? "null");
    } catch {
      // 坏缓存不影响别的字段
    }
    const savedSecUid = typeof saved?.uid === "string" && saved.uid.startsWith("MS4w") ? saved.uid : null;
    return {
      uid: str(source?.uid) ?? str(source?.user_id),
      secUid: str(source?.secUid) ?? str(source?.sec_uid) ?? savedSecUid,
      nickname: str(source?.nickname) ?? str(source?.realName) ?? str(saved?.nickname),
      avatar: pickUrl(source?.avatar300Url) ?? pickUrl(source?.avatarUrl)
        ?? pickUrl(source?.avatar_300x300) ?? pickUrl(source?.avatar_larger) ?? pickUrl(source?.avatar_thumb)
        ?? pickUrl(saved?.avatarUrl),
    };
  }).catch(() => null);
  if (!raw || typeof raw !== "object") return null;
  const text = (value, limit) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
  const uid = /^\d{1,32}$/u.test(raw.uid ?? "") ? raw.uid : null;
  const secUid = text(raw.secUid, 200);
  if (!uid && !secUid) return null;
  return {
    uid,
    secUid,
    nickname: text(raw.nickname, 100),
    avatar: normalizeChatAvatarUrl(text(raw.avatar, 2_048)?.replace(/^http:\/\//iu, "https://")) ?? null,
  };
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

function accountMismatchError(nickname) {
  return new CollectorAdapterError("account_mismatch", `导入的登录凭据属于另一个抖音号${nickname ? `「${nickname}」` : ""}，这次读到的没有保存。请在设置 → 账号中重新连接浏览器，确认正确账号后导入凭据。`);
}

function safeMessage(error, fallback) {
  if (error instanceof Error && error.message === "login_timeout") return "登录等待已超时，请重新同步。";
  if (error instanceof DirectHistoryError) return error.message;
  if (error instanceof CollectorAdapterError) return error.message;
  if (error instanceof ChatAdapterError) return error.message;
  if (error instanceof BrowserConnectionError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "抖音网页加载超时，请检查网络后重试。";
  return fallback;
}

export async function closeContextWithin(context) {
  if (context?.externalBrowser) return;
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

const COMPLETION_PAGE_LIMIT = 300;
const COMPLETION_OVERLAP_MS = 60 * 60 * 1000;

// 上次标到哪就从哪接着读，往回多读一小时，免得漏掉读取途中才看完的
export function completionScanFloor(records) {
  let newest = -Infinity;
  for (const record of records) {
    if (typeof record.watchCompleted === "boolean") newest = Math.max(newest, Date.parse(record.occurredAt ?? "") || -Infinity);
  }
  return newest - COMPLETION_OVERLAP_MS;
}

// 抖音的「已看完」只认每个视频最近那次观看：时间对上就是看完了；
// 视频不在列表里、而且这是它最新的一条，才算没看完。其余（比如后来又看了一遍）保持原样。
export function labelWatchCompletion(records, completed, coveredFromMs) {
  const latest = new Map();
  for (const record of records) {
    const at = Date.parse(record.occurredAt ?? "");
    if (record.videoId && at > (latest.get(record.videoId) ?? -Infinity)) latest.set(record.videoId, at);
  }
  return records.map((record) => {
    const at = Date.parse(record.occurredAt ?? "");
    if (record.occurredAtSource !== "platform_action" || record.mediaType === "live" || !record.videoId || !(at >= coveredFromMs)) return record;
    const completedAt = completed.get(record.videoId);
    // 上次读取时还停在这条上、后来看完了：抖音把时间挪到了离开那一刻，这条的「没看完」作废
    if (completedAt > at && record.watchCompleted === false) {
      const { watchCompleted, ...rest } = record;
      return rest;
    }
    const label = completedAt === at ? true : !completed.has(record.videoId) && latest.get(record.videoId) === at ? false : undefined;
    return label === undefined || record.watchCompleted === label ? record : { ...record, watchCompleted: label };
  });
}

// 直播观看历史通过 HTTP 按游标分页。
async function collectLiveHistoryRecords(context) {
  const endpoint = { kind: "live_history", pathname: "/webcast/feed/" };
  {
    const records = [], seen = new Set(); let cursor = "0";
    for (let page = 0; page < 50; page += 1) {
      if (seen.has(cursor)) throw new DirectHistoryError("pagination_stalled", "直播观看记录分页游标重复。");
      seen.add(cursor);
      const payload = await context.request(endpoint.pathname, { query: { request_tag_from: "web", need_map: "1", source_key: "drawer_hot_live_history", app_name: "douyin_web", live_id: "1", language: "zh-CN", max_time: cursor }, referer: `${SELF_PROFILE_URL}?showTab=record` });
      const result = normalizeDouyinResponse(endpoint, payload);
      records.push(...result.records);
      if (result.pagination.hasMore === false) return records;
      if (!/^\d{1,20}$/u.test(result.pagination.cursor ?? "")) throw new DirectHistoryError("pagination_missing", "直播观看记录缺少下一页游标。");
      cursor = result.pagination.cursor; await delay(300);
    }
    throw new DirectHistoryError("record_limit", "直播观看记录超过读取页数上限。");
  }
}

function finalizeDirectType(type, incremental, existingRecords, fetchedRecords, knownIds, rejectedIds, final = true) {
  if (type === "watch_history") {
    return mergeRecordList(type, existingRecords, fetchedRecords);
  }
  if (!incremental && final) return structuredClone(fetchedRecords);
  if (!incremental) {
    // 整份重读还没读完时，没读到的旧记录先留着，中途被打断也不会把本地记录截短；读完才按这次的结果整份替换
    const fetchedIds = new Set(fetchedRecords.map((record) => record.id));
    return [...structuredClone(fetchedRecords), ...existingRecords.filter((record) => !fetchedIds.has(record.id))];
  }

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

async function visibleLoginControl(page) {
  if (!page || page.isClosed()) return false;
  for (const role of ["button", "link"]) {
    const candidate = await firstVisible(page.getByRole(role, { name: "登录", exact: true }), 4);
    if (candidate) return candidate;
  }
  return null;
}

export async function openLoginDialog(page) {
  if (!page || page.isClosed()) return false;
  for (const role of ["button", "link"]) {
    if (await clickFirstVisible(page.getByRole(role, { name: "登录", exact: true }))) return true;
  }
  return false;
}

async function hasVisibleLoginControl(page) {
  return Boolean(await visibleLoginControl(page));
}

export class DouyinCollector {
  constructor({ dataDirectory, signerDirectory, store, account = null, onAccountIdentity = null }) {
    this.dataDirectory = dataDirectory;
    this.signerDirectory = signerDirectory;
    this.store = store;
    this.context = null;
    this.contextHeadless = null;
    this.externalConnection = null;
    this.externalSource = null;
    this.externalSessionState = "reconnect_required";
    this.directApi = null;
    this.directApiPromise = null;
    this.syncPromise = null;
    this.syncStopRequested = false;
    this.accountUid = account?.uid ?? null;
    // 核对时发现浏览器里登录的是别的号；登回原来的号核对通过前，无界面读取也不做
    this.accountMismatch = false;
    this.onAccountIdentity = onAccountIdentity;
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
    // 下载完成后的可选通知。
    this.afterVideoDownload = null;
    this.liveRooms = new LiveRooms(this);
    this.creatorCenter = new CreatorCenter(this);
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
      // 记录读取仅使用 HTTP。
      syncMode: null,
      syncFull: false,
      // 聊天接收单独一份状态，这样它和记录读取、视频下载可以同时跑，互不覆盖对方的进度
      chat: { state: "idle", connection: null, message: null, progress: null, code: null },
      chatConnection: null,
      // 当前是哪个账号；昵称头像登录后从页面读到才有
      account: account ? { id: account.id, nickname: account.nickname ?? null, avatar: account.avatar ?? null } : null,
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
    try {
      const source = JSON.parse(await readFile(path.join(this.dataDirectory, "external-browser.json"), "utf8"));
      if (["chrome", "edge", "comet"].includes(source.browser)) this.externalSource = source;
    } catch { /* Credentials remain account-bound even when an older cache has no source marker. */ }
    try {
      const session = await loadDirectSession(this.dataDirectory, this.accountUid);
      await loadDirectHistoryTemplate(this.dataDirectory);
      requireDirectCredentials(session);
      // A browser's short token can expire while the imported login remains
      // usable. Verify the actual HTTP identity before asking for a new import.
      this.externalSessionState = "ready";
    } catch { /* Missing, incomplete or expired credentials need an explicit CDP import. */ }
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
    return { ...structuredClone(this.status), revision: this.statusRevision, recordsRevision: this.store?.recordsRevision,
      browserSource: { mode: "cdp", browser: this.externalSource?.browser ?? null,
        connected: this.externalConnection?.connected === true, credentials: this.externalSessionState } };
  }

  externalSessionError(error) {
    if (!["direct_session_missing", "write_credentials_missing", "login_required", "session_rejected",
      "verification_required", "account_mismatch", "template_missing", "template_invalid", "template_mismatch"].includes(error?.code)) return error;
    if (this.externalSessionState === "exporting") {
      const problem = new DirectHistoryError("browser_import_failed", `浏览器账号已识别，但凭据导入未完成。${error.message}`);
      problem.cause = error;
      return problem;
    }
    this.externalSessionState = "reconnect_required";
    const problem = new DirectHistoryError("browser_reconnect_required", "导入的登录凭据已失效或不完整，请在设置 → 账号中重新连接浏览器，完成登录或验证后再次导入。");
    // Each caller owns its task state; only publish the shared credential flag here.
    this.updateStatus({});
    return problem;
  }

  async detachExternalBrowser() {
    const connection = this.externalConnection;
    this.externalConnection = null;
    if (connection && this.context === connection.context) {
      this.context = null;
      this.contextHeadless = null;
    }
    await connection?.disconnect();
  }

  async attachExternalBrowser(connection, identity, page) {
    if (!connection.connected || !identity?.uid) throw new BrowserConnectionError("browser_login_required", "请先在浏览器里登录抖音，再重新连接。");
    if (this.accountUid && this.accountUid !== identity.uid) throw accountMismatchError(identity.nickname);
    await this.close();
    const files = ["direct-session.json", "direct-history-template.json", "external-browser.json"];
    const previous = { source: this.externalSource, state: this.externalSessionState };
    const backups = await Promise.all(files.map(async name => {
      try { return await readFile(path.join(this.dataDirectory, name)); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }));
    // Bootstrap the complete HTTP session while attached. A failed refresh
    // restores the previous import instead of destroying usable credentials.
    try {
      await Promise.all(files.slice(0, 2).map(name => rm(path.join(this.dataDirectory, name), { force: true })));
      this.externalSource = { browser: connection.browser };
      this.externalSessionState = "exporting";
      await writeFile(path.join(this.dataDirectory, "external-browser.json"), `${JSON.stringify(this.externalSource)}\n`, { mode: 0o600 });
      this.externalConnection = connection;
      this.context = connection.context;
      this.contextHeadless = false;
      this.updateStatus({ state: "idle", phase: null, progress: null, browserOpen: true, message: "正在导出登录凭据，完成前请保持浏览器打开。" });
      connection.context.once("close", () => {
        if (this.externalConnection !== connection) return;
        this.externalConnection = null;
        this.context = null;
        this.contextHeadless = null;
        this.updateStatus({ browserOpen: false });
      });
      this.accountMismatch = false;
      await this.applyAccountIdentity(identity);
      await this.cacheDirectSession(connection.context, page, identity);
      await this.ensureDirectApi({ history: true, security: true });
      const imported = await loadDirectSession(this.dataDirectory, identity.uid);
      await loadDirectHistoryTemplate(this.dataDirectory);
      requireDirectCredentials(imported);
      this.externalSessionState = "ready";
      await this.detachExternalBrowser();
      this.updateStatus({ state: "idle", phase: null, progress: null, browserOpen: false,
        message: `已导入 ${connection.label} 中「${identity.nickname || "抖音账号"}」的登录凭据，可以关闭浏览器；凭据失效后再重新连接。` });
    } catch (error) {
      await this.close();
      await Promise.all(files.map((name, index) => backups[index] === null
        ? rm(path.join(this.dataDirectory, name), { force: true })
        : writeFile(path.join(this.dataDirectory, name), backups[index], { mode: 0o600 })));
      this.externalSource = previous.source ?? { browser: connection.browser };
      this.externalSessionState = previous.state;
      if (!previous.source) await writeFile(path.join(this.dataDirectory, "external-browser.json"), `${JSON.stringify(this.externalSource)}\n`, { mode: 0o600 });
      throw error;
    }
  }

  async disconnectExternalBrowser() {
    await this.detachExternalBrowser();
    this.updateStatus({ browserOpen: false, message: this.externalSessionState === "ready"
      ? "已断开浏览器，导入的凭据仍可供接口使用；失效后再重新连接。"
      : "请重新连接浏览器并导入登录凭据。" });
  }

  subscribeStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  // 只来了聊天时界面取这一份就够，不用每条消息都搬一遍几 MB 的记录
  getChatSnapshot() {
    const { schemaVersion, updatedAt, chatMessages, chatConversations, warnings } = this.snapshot;
    return structuredClone({ schemaVersion, updatedAt, chatMessages, chatConversations, warnings });
  }

  // 存盘前核对浏览器里登录的还是不是这个账号：换成别的抖音号就抛 account_mismatch，两个人的记录不能混进一份；
  // 是同一个号就顺手更新昵称头像（不用等）。读不到身份一律放行，不能耽误采集
  async assertAccountMatches(page) {
    const identity = await readLoginIdentity(page).catch(() => null);
    if (this.externalSource && !identity?.uid) throw new BrowserConnectionError("browser_identity_unavailable", "没有确认浏览器里的登录账号，请完成登录或验证后重试。");
    if (!identity) return;
    if (this.accountUid && identity.uid && identity.uid !== this.accountUid) {
      this.accountMismatch = true;
      throw accountMismatchError(identity.nickname);
    }
    if (identity.uid) this.accountMismatch = false;
    void this.applyAccountIdentity(identity);
    if (identity.uid && this.context) await this.cacheDirectSession(this.context, page, identity).catch(() => {});
  }

  async cacheDirectSession(context, page, identity, { updateApi = true } = {}) {
    const template = await loadDirectHistoryTemplate(this.dataDirectory).catch(() => null);
    const userAgent = context.externalBrowser ? await page.evaluate(() => navigator.userAgent)
      : template?.headers["user-agent"] ?? await page.evaluate(() => navigator.userAgent);
    const previous = await loadDirectSession(this.dataDirectory, identity.uid).catch(() => null);
    const next = { version: 1, uid: identity.uid, secUid: identity.secUid,
      userAgent, values: template?.values ?? {}, requestHeaders: template?.headers ?? {}, cookies: await context.cookies() };
    if (previous && sameDirectSession(previous, next)) next.security = previous.security;
    const session = await saveDirectSession(this.dataDirectory, next);
    // A chat identity refresh must not dispose an HTTP request currently reading records.
    if (!updateApi) return session;
    if (this.directApi && !sameDirectSession(this.directApi.session, session)) {
      await this.directApi.close(); this.directApi = null;
    } else this.directApi?.replaceSession(session);
    return session;
  }

  async ensureDirectApi({ history = false, security = false, signal } = {}) {
    signal?.throwIfAborted();
    if (this.externalSessionState === "reconnect_required" && !this.externalConnection?.connected)
      throw this.externalSessionError(new DirectHistoryError("direct_session_missing", "请重新导入登录凭据。"));
    if (this.accountMismatch) throw accountMismatchError();
    if (this.directApiPromise) {
      const api = await this.directApiPromise;
      if (security) await this.ensureDirectWriteCredentials(api, signal);
      return api;
    }
    const work = (async () => {
      let session;
      try {
        session = await loadDirectSession(this.dataDirectory, this.accountUid);
        if (this.externalSource && this.externalConnection?.connected) {
          const cookies = await this.externalConnection.context.cookies();
          if (!sameDirectSession(session, { ...session, cookies }))
            throw new DirectHistoryError("direct_session_missing", "浏览器登录态已变化，需要重新核对账号。");
          session = await saveDirectSession(this.dataDirectory, { ...session, cookies });
        }
        if ((history || !session.values.webid) && !await loadDirectHistoryTemplate(this.dataDirectory).catch(() => null))
          throw new DirectHistoryError("direct_session_missing", "登录会话尚未完成请求参数初始化。");
      }
      catch (error) {
        if (error?.code !== "direct_session_missing") throw error;
        if (!this.externalConnection?.connected) throw error;
        // Existing profiles need one session export. Subsequent reads use only the cached HTTP session.
        const context = this.ensureImportBrowser();
        const page = await context.newPage();
        try {
          await page.goto(SELF_PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
          signal?.throwIfAborted();
          if (!await this.hasLoginSession(context, page)) throw new DirectHistoryError("login_required", "请先在采集器中登录抖音。");
          await this.assertAccountMatches(page);
          if (history || !session?.values.webid) {
            await this.prepareDirectHistoryTemplate(context, page, this.syncRunId);
            const cached = await loadDirectSession(this.dataDirectory, this.accountUid);
            const template = await loadDirectHistoryTemplate(this.dataDirectory);
            await saveDirectSession(this.dataDirectory, { ...cached, values: template.values, userAgent: template.headers["user-agent"] });
          }
          session = await loadDirectSession(this.dataDirectory, this.accountUid);
        } finally {
          await page.close().catch(() => {});
        }
      }
      const template = history ? await loadDirectHistoryTemplate(this.dataDirectory)
        : await loadDirectHistoryTemplate(this.dataDirectory).catch(() => null);
      if (template) session = { ...session, values: template.values, requestHeaders: template.headers };
      if (this.directApi && !sameDirectSession(this.directApi.session, session)) {
        await this.directApi.close(); this.directApi = null;
      }
      this.directApi ??= new DirectApiClient(session, { dataDirectory: this.dataDirectory, directory: this.signerDirectory,
        onSessionError: error => this.externalSessionError(error) });
      this.directApi.replaceSession(session);
      try {
        // Refresh through the browser while importing; a detached cache still
        // has to pass the platform's HTTP identity check before any task runs.
        if (security || needsDirectSessionRefresh(this.directApi.session))
          await this.ensureDirectWriteCredentials(this.directApi, signal);
        const identity = await this.directApi.verifyIdentity(this.accountUid, signal);
        await this.applyAccountIdentity(identity);
        return this.directApi;
      } catch (error) {
        if (error?.code === "account_mismatch") this.accountMismatch = true;
        await this.directApi?.close(); this.directApi = null;
        throw error;
      }
    })();
    this.directApiPromise = work;
    let api;
    try { api = await work; }
    catch (error) { throw this.externalSessionError(error); }
    finally { if (this.directApiPromise === work) this.directApiPromise = null; }
    return api;
  }

  async ensureDirectWriteCredentials(api, signal) {
    try {
      const credentials = requireDirectCredentials(api.session);
      if (!needsDirectSessionRefresh(api.session) || !this.externalConnection?.connected) return credentials;
    } catch (error) { if (error.code !== "write_credentials_missing") throw error; }
    if (!this.externalConnection?.connected)
      throw this.externalSessionError(new DirectHistoryError("write_credentials_missing", "导入的签名凭据需要刷新。"));
    if (this.directSecurityPromise) return this.directSecurityPromise;
    const work = (async () => {
      const context = this.ensureImportBrowser();
      const page = await context.newPage();
      try {
        await page.goto(SELF_PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
        // The page can identify the account before its security SDK finishes
        // initializing. Allow a cold browser to finish the paired export.
        const deadline = Date.now() + DIRECT_CREDENTIAL_EXPORT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const identity = await readLoginIdentity(page);
          if (identity?.uid && identity.uid !== api.session.uid) throw accountMismatchError(identity.nickname);
          if (identity?.uid) {
            const material = await page.evaluate(readDirectCredentialMaterial);
            if (material) {
              const msToken = context.directMsToken || api.cookie("msToken");
              material.msToken = /^[A-Za-z0-9+/_=-]{100,1024}$/u.test(msToken || "") ? msToken : "";
            }
            if (material?.trait?.blob && material.ticket && material.privateKey && material.msToken) {
              // A fresh login to the same account rotates Cookies. Complete
              // its paired export before replacing the active HTTP client.
              const session = await this.cacheDirectSession(context, page, identity, { updateApi: false });
              // Export with the browser's current Cookie jar, independently
              // of a previously created HTTP context.
              const exporter = new DirectApiClient(session, { dataDirectory: api.dataDirectory, directory: api.directory,
                requestFactory: api.requestFactory, signer: api.signer });
              try {
                const security = await completeDirectCredentialExport(exporter, material);
                api.replaceSession(exporter.session);
                return security;
              } finally { await exporter.close(); }
            }
          }
          await delay(500, undefined, { signal });
        }
        throw new DirectHistoryError("write_credentials_missing", "未能获取完整签名与设备凭据，请在浏览器刷新抖音页面，完成登录或验证后重新连接。");
      } finally {
        await page.close().catch(() => {});
      }
    })();
    this.directSecurityPromise = work;
    try { return await work; } finally { if (this.directSecurityPromise === work) this.directSecurityPromise = null; }
  }

  // 昵称头像和已知的不一样才报；名单先落盘再推状态，前端收到新昵称会马上去拉名单
  async applyAccountIdentity(identity) {
    const current = this.status.account;
    if (!current) return;
    const nickname = identity.nickname ?? current.nickname;
    const avatar = identity.avatar ?? current.avatar;
    const uid = identity.uid ?? this.accountUid;
    if (nickname === current.nickname && avatar === current.avatar && uid === this.accountUid) return;
    this.accountUid = uid;
    try {
      await this.onAccountIdentity?.(identity);
    } catch {
      // 回写账号列表失败不影响采集
    }
    this.updateStatus({ account: { ...this.status.account, nickname, avatar } });
  }

  // 只算要存成文件的下载；边下边播可以直接停掉
  hasSavingVideoDownload() {
    return [...this.videoDownloadJobs.values()].some((job) => !job.playback && (job.status === "queued" || job.status === "running"));
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
      ...(job.video ? { video: job.video } : {}),
      ...(job.playback ? { streamKey: job.streamKey } : {}),
      // 图文播放：图片和配乐由播放器直接加载，实况短视频只给个有无，地址走 /stream?live=序号
      ...(job.stream?.images ? {
        images: job.stream.images.map((image) => ({ url: image.url, live: Boolean(image.live) })),
        music: job.stream.music,
      } : {}),
    };
  }

  touchVideoDownloadJob(job, patch = {}) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return this.publicVideoDownloadJob(job);
  }

  /** smallest：下最低一档清晰度，给 AI 解析用 */
  startVideoDownload(sourceUrl, { playback = false, smallest = false } = {}) {
    const normalizedSourceUrl = normalizeDouyinVideoUrl(sourceUrl);
    if (this.visibleBrowserWorkRunning()) {
      throw new VideoDownloadError("collector_busy", "采集器正在执行其他任务，请稍后再试。", { retryable: true });
    }
    this.reserveVideoDownloadJobSlot();
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      playback,
      smallest,
      ...(playback ? { streamKey: randomBytes(24).toString("base64url") } : {}),
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

  /** The player's <video> cannot send the session header, so each playback job carries its own key. */
  playbackStream(jobId, key, live = null) {
    const job = this.videoDownloadJobs.get(jobId);
    const expected = Buffer.from(job?.stream ? job.streamKey : "");
    const given = Buffer.from(String(key ?? ""));
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    // Playing can outlast the orphan timer; the player's DELETE or retention pruning ends it now.
    clearTimeout(job.releaseTimer);
    this.touchVideoDownloadJob(job);
    if (live === null) return job.stream.url ? job.stream : null;
    const url = job.stream.images?.[Number(live)]?.live;
    return url ? { url, referer: job.stream.referer } : null;
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
      try {
        context = await this.ensureDirectApi({ signal: controller.signal });
      } catch (error) {
        operation.statusRevisionAfterLaunch = this.statusRevision;
        throw error;
      }
      operation.statusRevisionAfterLaunch = this.statusRevision;
      controller.signal.throwIfAborted();
      // Playback only resolves the media address; the bytes are streamed to the player, never saved.
      if (job.playback) job.stream = await resolveDouyinStream({ context, sourceUrl: job.sourceUrl, signal: controller.signal });
      const result = job.playback ? {} : await downloadDouyinVideo({
        context,
        sourceUrl: job.sourceUrl,
        outputDirectory: path.join(this.dataDirectory, "downloads"),
        signal: controller.signal,
        smallest: job.smallest,
        onProgress: (bytes) => this.touchVideoDownloadJob(job, { bytes }),
      });
      this.touchVideoDownloadJob(job, {
        status: "complete",
        video: result.videoId === undefined ? null : {
          videoId: result.videoId, title: result.title, author: result.author, durationSeconds: result.durationSeconds,
          publishedAt: result.publishedAt, stats: result.stats, tags: result.tags, cover: result.cover,
        },
        fileName: result.fileName ?? null,
        filePath: result.filePath ?? null,
        bytes: result.bytes ?? null,
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
      if (this.videoDownloadActive === operation) {
        const canRestoreStatus = operation.statusRevisionAfterLaunch !== null
          && operation.statusRevisionAfterLaunch === this.statusRevision
          && !this.syncPromise
          && !this.chat?.active;
        if (canRestoreStatus) this.updateStatus(operation.previousStatus);
        this.videoDownloadActive = null;
      }
      try { this.afterVideoDownload?.(); } catch { /* 回调出错不该影响下载结果 */ }
    }
  }

  async clearRecords() {
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

  // 把本应用导出的文件并进本机记录：只补本机没有的，两边都有的以本机为准。
  // 聊天接收会拿内存里那份整份写回，所以和清除记录一样先停下，应用随后再接上
  async importRecords(data) {
    if (this.syncPromise) {
      throw Object.assign(new Error("正在读取，等它结束后再并入。"), { status: 409, code: "import_busy" });
    }
    await this.stopChatObservation({ silent: true });
    const before = this.snapshot;
    const records = createEmptyRecords();
    for (const type of Object.keys(records)) {
      const seen = new Set(before.records[type].map((record) => record.id));
      const added = (Array.isArray(data?.records?.[type]) ? data.records[type] : []).flatMap((item) => {
        const record = normalizeRecord(item);
        if (!record || seen.has(record.id)) return [];
        seen.add(record.id);
        return [record];
      });
      // 观看历史按时间排好；喜欢和收藏保留本机顺序，文件里多出来的接在后面
      records[type] = type === "watch_history"
        ? mergeRecordList(type, before.records[type], added)
        : [...before.records[type], ...added];
    }
    const conversations = Array.isArray(data?.chatConversations)
      ? data.chatConversations.filter((conversation) => typeof conversation?.id === "string")
      : [];
    this.snapshot = await this.store.save(records, before.warnings, {
      directSync: before.directSync,
      // 存盘时按编号去重，排在前面的本机消息优先
      chatMessages: [...before.chatMessages, ...(Array.isArray(data?.chatMessages) ? data.chatMessages : [])],
      chatConversations: mergeChatConversationSnapshots(conversations, before.chatConversations),
    });
    this.updateStatus({
      message: "已并入导入的记录",
      counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
      updatedAt: this.snapshot.updatedAt,
    });
    // 新增条数和状态里的计数同一个口径：聊天含群聊统计
    const after = recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations);
    const previous = recordCounts(before.records, before.chatMessages, before.chatConversations);
    return {
      added: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - previous[key]])),
      snapshot: this.getSnapshot(),
    };
  }

  startSync({ mode = "full_records" } = {}) {
    if (this.syncPromise) return false;
    this.syncStopRequested = false;
    const full = mode === "full_records";
    this.syncMode = "direct_records";
    const runId = this.syncRunId + 1;
    this.syncRunId = runId;
    this.updateStatus({
      syncMode: "direct_records",
      syncFull: full,
      state: "collecting",
      phase: "watch_history",
      progress: null,
      message: full ? "正在读取全部观看、点赞和收藏记录" : "正在读取新增观看、点赞和收藏记录",
    });
    const promise = this.runDirectRecords(runId, { full })
      .catch((error) => {
        if (error instanceof CollectorCancelledError || runId !== this.syncRunId) return;
        this.updateStatus({
          state: "error",
          code: error?.code ?? null,
          phase: null,
          progress: null,
          message: safeMessage(error, "记录接口读取失败。"),
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

  // 聊天接收独立于接口记录读取和视频下载。
  startChatObservation() {
    if (this.chatPromise) return false;
    const runId = this.chatRunId + 1;
    this.chatRunId = runId;
    let releaseStop;
    const chat = {
      active: true,
      mode: "chat",
      direct: true,
      runId,
      stop: () => releaseStop?.(),
      stopPromise: new Promise((resolve) => {
        releaseStop = resolve;
      }),
    };
    this.chat = chat;
    this.updateChat({ state: "launching_browser", connection: "connecting", progress: null, message: "正在连接抖音实时消息" });
    const promise = this.runChatObservation(runId, chat)
      .catch(async (error) => {
        if (error instanceof CollectorCancelledError || !chat.active || runId !== this.chatRunId) return;
        this.updateChat({
          state: "error",
          code: error?.code ?? null,
          connection: null,
          progress: null,
          message: safeMessage(error, "聊天读取启动失败，请稍后重试。"),
        });
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
    if (chat.direct) await chat.client?.close();
    await promise.catch(() => undefined);
    // Silent stops are used while another operation owns the shared browser.
    // Keep the nested chat state truthful even though the top-level status is
    // intentionally left to that other operation.
    this.updateChat({
      state: "idle",
      connection: null,
      progress: null,
      message: silent ? null : "已暂停实时接收，已保留聊天记录",
    });
    if (!silent) {
      this.updateStatus({
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
        browserOpen: Boolean(this.context),
      });
    }
    return true;
  }

  // Only credential export temporarily owns browser pages.
  visibleBrowserWorkRunning() {
    return this.externalSessionState === "exporting";
  }

  isChatReceiving() {
    return this.chat?.active === true && this.status.chat.state === "observing";
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
    if (!this.isChatReceiving() || observation.stopping) throw new ChatSendError("not_receiving", "先开始接收消息，才能发送。");
    if (!observation.historyReady) throw new ChatSendError("collector_busy", "正在整理聊天历史，整理完就能发送。");
    if (this.status.chat.connection !== "connected") throw new ChatSendError("not_connected", "消息连接还没连上，请稍后再发。");
    if (this.chatSendPromise) throw new ChatSendError("collector_busy", "上一条还在发送，请稍等。");
    if (this.chatSends.size >= 1000) throw new ChatSendError("send_limit", "本次会话发送数量已达上限，请重启采集器。");
    // One send at a time, deduplicated by requestId; a dispatched message is never retried here.
    const result = observation.client.send(request).then((outcome) => {
      if (outcome.chatMessage) observation.acceptSent?.(outcome.chatMessage);
      return outcome;
    });
    this.chatSends.set(request.requestId, { fingerprint, result });
    this.chatSendPromise = result;
    try {
      return await result;
    } catch (error) {
      // Only pre-dispatch failures reach here, so the same request may run again.
      this.chatSends.delete(request.requestId);
      throw error;
    } finally {
      if (this.chatSendPromise === result) this.chatSendPromise = null;
    }
  }

  chatClientForReading() {
    const chat = this.chat;
    if (!this.isChatReceiving() || chat.stopping || !chat.client)
      throw new ChatSendError("not_receiving", "先开始接收消息，才能看群消息和抖音上的火花。");
    if (!chat.historyReady) throw new ChatSendError("collector_busy", "正在整理聊天历史，整理完就能看。");
    return chat.client;
  }

  async readChatMessages(input) {
    const { pageMessages, ...result } = await this.chatClientForReading().messages(input);
    return result;
  }

  async readChatStreaks() {
    return this.chatClientForReading().streaks();
  }

  async getDirectChatClient(options = {}) {
    const api = await this.ensureDirectApi({ ...options, security: true });
    if (!api.chatClient) api.chatClient = new DirectChatClient(api);
    const client = api.chatClient;
    if (!client.conversations.size) {
      await client.initialize({ signal: options.signal });
      for (const known of this.snapshot?.chatConversations || []) {
        const item = client.conversations.get(known.id);
        if (item) { item.name ||= known.name; item.avatarUrl ||= known.avatarUrl; item.secUid ||= known.secUid; }
      }
    }
    return client;
  }

  async runChatObservation(runId, observation) {
    return this.runDirectChatObservation(runId, observation);
  }

  async runDirectChatObservation(runId, observation) {
    const controller = new AbortController();
    const originalStop = observation.stop;
    observation.stop = () => { controller.abort(); originalStop(); };
    const signal = controller.signal;
    const api = await this.ensureDirectApi({ security: true, signal });
    this.assertChatActive(runId);
    const client = api.chatClient ||= new DirectChatClient(api);
    observation.client = client;
    const messages = new ChatMessageAccumulator(this.snapshot.chatMessages);
    const conversations = new ChatConversationAccumulator(this.snapshot.chatConversations.map(conversation=>({
      ...conversation, messageCount: 0, ownMessageCount: 0,
    })), api.session.uid);
    conversations.addMessages(messages.snapshot());
    const initialGroups = new Map(this.snapshot.chatConversations.filter(c=>c.kind==="group").map(c=>[c.id,c]));
    const initialSnapshotTime = Date.parse(this.snapshot.updatedAt || "") || 0;
    const newGroupMessages = new Map();
    let processing = Promise.resolve();
    const accept = (payload) => {
      const work = processing.then(async () => {
        if (!observation.active || runId !== this.chatRunId) return;
        conversations.addConversations(payload.conversations || []);
        const normalized = (payload.messages || []).map(message=>({ ...message,
          conversationType: message.conversationType === "unknown" ? client.conversations.get(message.conversationId)?.kind || "unknown" : message.conversationType }));
        for (const message of normalized) {
          if (message.conversationType !== "group" || !message.id || (Date.parse(message.sentAt || "") || 0) <= initialSnapshotTime) continue;
          const fresh = newGroupMessages.get(message.conversationId) || new Map();
          fresh.set(message.id, message.senderId); newGroupMessages.set(message.conversationId, fresh);
        }
        conversations.addMessages(normalized.map(message=>message.conversationType === "group"
          ? { id: message.id, conversationId: message.conversationId, conversationType: "group", senderId: message.senderId } : message));
        messages.addMessages(normalized.filter(message=>message.conversationType !== "group"));
        const warnings = currentChatWarnings(this.snapshot.warnings);
        this.snapshot = await this.store.save(this.snapshot.records, warnings, { directSync: normalizeDirectSyncState(this.snapshot.directSync),
          chatMessages: messages.snapshot(), chatConversations: mergeChatConversationSnapshots(this.snapshot.chatConversations, conversations.snapshot().map(conversation=>{
            const baseline = initialGroups.get(conversation.id), fresh = newGroupMessages.get(conversation.id);
            return baseline && fresh ? { ...conversation,
              messageCount: Math.max(conversation.messageCount, baseline.messageCount + fresh.size),
              ownMessageCount: Math.max(conversation.ownMessageCount, baseline.ownMessageCount + [...fresh.values()].filter(sender=>sender===api.session.uid).length),
            } : conversation;
          })) });
        this.updateStatus({ counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations), updatedAt: this.snapshot.updatedAt });
      });
      processing = work.catch(()=>{});
      return work;
    };
    observation.acceptSent = message=>{ void accept({ messages: [message], conversations: [] }).catch(()=>{}); };
    try {
      this.updateChat({ state: "observing", connection: "connecting", progress: { current: 0, total: 0 }, message: "正在通过接口读取聊天会话" });
      await client.initialize({ signal, onPayload: accept, onProgress: progress=>this.updateChat({ progress: { current: progress.pages, total: progress.pages }, message: `已读取 ${progress.conversations} 个会话` }) });
      for (const known of this.snapshot.chatConversations) {
        const item = client.conversations.get(known.id);
        if (item) { item.name ||= known.name; item.avatarUrl ||= known.avatarUrl; item.secUid ||= known.secUid; }
      }
      // Connect before reading older pages, so pushes during hydration share
      // the same serialized accumulator and cannot be lost.
      await client.connect({ onPayload: accept, onConnection: connection=>{
        if (observation.active && runId === this.chatRunId) this.updateChat({ connection });
      }, onError: error=>{
        if (observation.active && runId === this.chatRunId) this.updateChat({ message: safeMessage(error, "实时消息暂不可用，正在重连") });
      } });
      const friends = [...client.conversations.values()].filter(c=>c.type===1);
      for (const [index, conversation] of friends.entries()) {
        signal.throwIfAborted(); this.assertChatActive(runId);
        this.updateChat({ progress: { current: index + 1, total: friends.length }, message: `正在读取聊天历史 ${index + 1}/${friends.length}` });
        let page = await client.messages({ conversationId: conversation.id }, { signal });
        await accept({ messages: page.pageMessages, conversations: [conversation] });
        for (let count = 1; page.hasMore && count < CHAT_FRIEND_HISTORY_PAGE_LIMIT; count += 1) {
          page = await client.messages({ conversationId: conversation.id, older: true }, { signal });
          await accept({ messages: page.pageMessages, conversations: [] });
          await delay(200, undefined, { signal });
        }
        if (page.hasMore) throw new DirectHistoryError("record_limit", "聊天历史达到读取容量，已保留读取到的消息。");
      }
      observation.historyReady = true;
      this.updateChat({ progress: null, message: "正在通过接口实时接收消息" });
      await observation.stopPromise;
    } finally {
      controller.abort(); await client.close(); await processing;
    }
  }

  assertSyncActive(runId) {
    if (runId !== this.syncRunId) throw new CollectorCancelledError();
  }

  assertChatActive(runId) {
    if (runId !== this.chatRunId) throw new CollectorCancelledError();
  }

  ensureImportBrowser() {
    if (!this.externalConnection?.connected || !this.context)
      throw this.externalSessionError(new DirectHistoryError("direct_session_missing", "请先导入浏览器登录凭据。"));
    return this.context;
  }

  async hasLoginSession(context, page) {
    const cookies = await context.cookies(HOME_URL);
    const hasCookie = cookies.some((cookie) => LOGIN_COOKIE_NAMES.has(cookie.name) && cookie.value.length > 0);
    return hasCookie && !await hasVisibleLoginControl(page);
  }

  async visit(page, url, runId, assertActive = (id) => this.assertSyncActive(id)) {
    assertActive(runId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await delay(1_500);
    assertActive(runId);
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
    for (const candidatePage of [...(this.externalSource ? this.context.pages() : page.context().pages())].reverse()) {
      profileUrl = normalizeOwnProfileUrl(candidatePage.url()) ?? await findOwnProfileLink(candidatePage);
      if (profileUrl) return profileUrl;
    }

    await this.visit(page, SELF_PROFILE_URL, runId);
    return normalizeOwnProfileUrl(page.url()) ?? await findOwnProfileLink(page);
  }

  async runSync(runId) {
    return this.runDirectRecords(runId, { full: true });
  }

  async readDirectHistory(context, cursor = "0", { completedOnly = false } = {}) {
    const currentUserAgent = context.currentUserAgent;
    return fetchDirectHistoryPage({
      context,
      currentUserAgent,
      dataDirectory: this.dataDirectory,
      directory: this.signerDirectory,
      cursor,
      completedOnly,
    });
  }

  // 「已看完」列表按观看时间倒序，读到比 stopBeforeMs 更早就停；返回视频 id → 那次观看的时间，以及读到的最早时间
  async readCompletedWatchTimes(context, runId, stopBeforeMs) {
    const completed = new Map();
    const cursors = new Set();
    let cursor = "0";
    let oldest = Infinity;
    for (let page = 1; page <= COMPLETION_PAGE_LIMIT; page += 1) {
      this.assertSyncActive(runId);
      if (cursors.has(cursor)) throw new DirectHistoryError("pagination_stalled", "看完标记分页游标重复，已停止读取。");
      cursors.add(cursor);
      const payload = await this.readDirectHistory(context, cursor, { completedOnly: true });
      this.assertSyncActive(runId);
      const field = (key) => payload?.[key] ?? payload?.data?.[key];
      const dates = field("aweme_date") ?? {};
      for (const item of field("aweme_list") ?? []) {
        const id = String(item?.aweme_id ?? "");
        if (!id) continue;
        // 和观看历史一样，没有 aweme_date 就退回 view_time；都没有也得记下它看完了，只是对不上具体哪次
        const raw = Number(dates[id] ?? item?.history_info?.view_time);
        const at = raw > 0 ? (raw < 10_000_000_000 ? raw * 1_000 : raw) : Number.NaN;
        completed.set(id, at);
        if (at > 0) oldest = Math.min(oldest, at);
      }
      this.updateStatus({ phase: "watch_history", message: `正在读取看完标记（第 ${page} 页，${completed.size} 条）` });
      const hasMore = field("has_more") === true || field("has_more") === 1;
      if (!hasMore || oldest < stopBeforeMs) break;
      cursor = String(field("max_cursor") ?? "");
      if (!/^\d{1,20}$/u.test(cursor)) break;
      await delay(900);
    }
    return { completed, coveredFromMs: oldest };
  }

  async collectDirectList(source, type, onPage) {
    return source.collectRecordPages(type, onPage);
  }

  async prepareDirectHistoryTemplate(context, page, runId) {
    try {
      return await loadDirectHistoryTemplate(this.dataDirectory);
    } catch (error) {
      if (!error || !["template_missing", "template_invalid"].includes(error.code)) throw error;
    }

    // A valid login session can bootstrap the request template in a hidden
    // page. This keeps the first usable incremental read headless even when a
    // prior visible sync failed to persist its template.
    if (typeof page?.waitForResponse !== "function") {
      throw new DirectHistoryError("template_missing", "增量读取配置尚未建立，请先完成一次观看历史读取。");
    }
    await this.visit(page, HOME_URL, runId);
    if (!await this.hasLoginSession(context, page)) {
      throw new DirectHistoryError("login_required", "增量读取需要先在浏览器中完成登录并导入凭据。");
    }
    await this.assertAccountMatches(page);
    const profileUrl = await this.resolveOwnProfileUrl(page, runId);
    const responsePromise = page.waitForResponse((response) => (
      Boolean(validateDirectHistoryUrl(response.url(), { allowSignature: true }))
    ), { timeout: 30_000 });
    await this.visit(page, profileTabUrl(profileUrl, "record") ?? `${SELF_PROFILE_URL}?showTab=record`, runId);
    const response = await responsePromise;
    const request = typeof response.request === "function" ? response.request() : null;
    const browserUserAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    const captured = await captureDirectHistoryTemplate(this.dataDirectory, request, browserUserAgent).catch(() => false);
    if (!captured) {
      throw new DirectHistoryError("template_missing", "无法从观看历史请求建立增量读取配置。");
    }
    return loadDirectHistoryTemplate(this.dataDirectory);
  }

  async runDirectRecords(runId, { full = false } = {}) {
    this.assertSyncActive(runId);
    // 核对时发现浏览器里登录的是别的号：登回原来的号之前不用那份登录态读，也别关掉用户正拿来换号的窗口
    if (this.accountMismatch) throw accountMismatchError();
    const context = await this.ensureDirectApi({ history: true });
    try {
      this.assertSyncActive(runId);
      const accumulator = new RecordAccumulator();
      const existingRecords = structuredClone(this.snapshot.records);
      const stagedRecords = structuredClone(existingRecords);
      const directSync = normalizeDirectSyncState(this.snapshot.directSync, this.snapshot.warnings);
      const incrementalByType = new Map(REQUIRED_TYPES.map((type) => [type, !full && directSync[type]]));
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
      const previewRecords = (type, final = false) => {
        const preview = structuredClone(stagedRecords);
        preview[type] = finalizeDirectType(
          type,
          incrementalByType.get(type),
          existingRecords[type],
          accumulator.snapshot().records[type],
          knownIds.get(type),
          rejectedIds.get(type),
          final,
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
        // 喜欢和收藏的增量一般一两页就读完，读完再一起存：中途存下的新记录会让下次读取在它们身上停住，中间那段就补不回来了
        if (type !== "watch_history" && incrementalByType.get(type)) return;
        if (Date.now() - lastProgressPersistAt < this.progressPersistIntervalMs) return;
        lastProgressPersistAt = Date.now();
        this.assertSyncActive(runId);
        this.snapshot = await this.store.save(previewRecords(type), this.snapshot.warnings, {
          // 观看历史读到一半存下的新记录，下次增量读取会在它们身上停住，被打断时中间那段就再也补不回来。
          // 存了新记录就先把它标成没读完，被打断的话下次整段重读（观看历史是合并，不会丢旧记录），读完再标回去
          directSync: newIds.get(type).size > 0 ? { ...directSync, [type]: false } : directSync,
          chatMessages: this.snapshot.chatMessages,
          chatConversations: this.snapshot.chatConversations,
        });
        this.updateStatus({ updatedAt: this.snapshot.updatedAt });
      };
      const persistCompletedType = async (type, finalPhase) => {
        this.assertSyncActive(runId);
        stagedRecords[type] = previewRecords(type, true)[type];
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
      // 直播记录只是观看历史的附加分栏：改版、读不到都不影响上面已经存好的视频记录
      this.updateStatus({ phase: "watch_history", message: "正在读取看过的直播" });
      const liveRecords = await collectLiveHistoryRecords(context).catch(() => []);
      this.assertSyncActive(runId);
      const withLive = mergeRecordList("watch_history", stagedRecords.watch_history, liveRecords);
      const liveAdded = withLive.length - stagedRecords.watch_history.length;
      const saveStaged = async () => {
        this.snapshot = await this.store.save(stagedRecords, this.snapshot.warnings, {
          directSync,
          chatMessages: this.snapshot.chatMessages,
          chatConversations: this.snapshot.chatConversations,
        });
      };
      // 没有新增也要写回：已有的直播记录可能刚补上封面、改了昵称
      if (liveRecords.length > 0) {
        stagedRecords.watch_history = withLive;
        await saveStaged();
      }
      // 看完标记也是附加信息：读不到就沿用按时间的估算，不影响上面已经存好的记录
      this.updateStatus({ phase: "watch_history", message: "正在读取看完标记" });
      const completion = await this.readCompletedWatchTimes(context, runId, completionScanFloor(stagedRecords.watch_history))
        .catch((error) => {
          if (error instanceof CollectorCancelledError) throw error;
          return null;
        });
      this.assertSyncActive(runId);
      if (completion) {
        const labelled = labelWatchCompletion(stagedRecords.watch_history, completion.completed, completion.coveredFromMs);
        if (labelled.some((record, index) => record !== stagedRecords.watch_history[index])) {
          stagedRecords.watch_history = labelled;
          await saveStaged();
        }
      }
      const newCounts = Object.fromEntries(REQUIRED_TYPES.map((type) => [type, newIds.get(type).size]));
      this.updateStatus({
        state: "complete",
        phase: null,
        progress: null,
        message: allIncremental
          ? `已读取新增记录（观看 ${newCounts.watch_history}、点赞 ${newCounts.liked_videos}、收藏 ${newCounts.favorite_videos}${liveAdded > 0 ? `、直播 ${liveAdded}` : ""}）`
          : `已读取并合并全部可见记录（观看 ${stagedRecords.watch_history.length}、点赞 ${stagedRecords.liked_videos.length}、收藏 ${stagedRecords.favorite_videos.length}）`,
        counts: recordCounts(this.snapshot.records, this.snapshot.chatMessages, this.snapshot.chatConversations),
        updatedAt: this.snapshot.updatedAt,
      });
    } finally {
      this.syncMode = null;
    }
  }

  async close() {
    clearTimeout(this.liveRooms.releaseTimer);
    await this.liveRooms.closeAll({ release: false });
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
    await this.stopChatObservation({ silent: true });
    await this.directApi?.chatClient?.close();
    await this.directApi?.close(); this.directApi = null;
    const context = this.context;
    this.context = null;
    this.contextHeadless = null;
    if (context) await closeContextWithin(context);
    const external = this.externalConnection;
    this.externalConnection = null;
    await external?.disconnect();
  }

  // 换账号前把这个账号的活全收掉：关直播间和浏览器，再等挂着的读取、监听、下载和存盘落地
  async shutdown() {
    clearTimeout(this.liveRooms.releaseTimer);
    await this.liveRooms.closeAll({ release: false });
    await this.close();
    await Promise.allSettled([
      this.syncPromise,
      this.chatPromise,
      this.videoDownloadQueue,
      this.liveRooms.queue,
      this.store?.writeQueue,
    ]);
    await this.liveRooms.closeAll({ release: false });
    // 收尾途中刚起来的浏览器（比如正在启动的那次）也一起关掉
    if (this.context) await this.close();
  }
}
