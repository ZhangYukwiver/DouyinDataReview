import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { request as playwrightRequest } from "playwright-core";
import { nativeSignedUrl } from "./nativeSignature.mjs";

export const DIRECT_HISTORY_ENDPOINT = "https://www.douyin.com/aweme/v1/web/history/read/";
export const DIRECT_LIKED_ENDPOINT = "https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/";
export const DIRECT_FAVORITE_ENDPOINT = "https://www-hj.douyin.com/aweme/v1/web/aweme/listcollection/";
const DIRECT_SELF_ENDPOINT = "https://www.douyin.com/aweme/v1/web/user/profile/self/";
// 已存的观看历史模板里记着这个值，加载时要对得上；签名早已不用它，改了会让大家的模板全部失效
export const DIRECT_SIGNER_COMMIT = "42987a1aa0c88c4d7f00d106ea2bc87dc01b0edf";

// Scroll every visible list surface. The profile page can put the record grid
// in a smaller nested container, so choosing only the largest half-viewport
// surface can leave the first response as the only page we ever receive.
export function scrollHiddenListPage() {
  const root = document.scrollingElement;
  const surfaces = [];
  const seen = new Set();
  const viewportWidth = Number(globalThis.innerWidth) || 0;
  const viewportHeight = Number(globalThis.innerHeight) || 0;
  const addSurface = (element, force = false) => {
    if (!element || seen.has(element)) return;
    const scrollHeight = Number(element.scrollHeight);
    const clientHeight = Number(element.clientHeight);
    const maximum = scrollHeight - clientHeight;
    if (!Number.isFinite(maximum) || maximum <= 32) return;
    const style = typeof globalThis.getComputedStyle === "function"
      ? globalThis.getComputedStyle(element)
      : null;
    if (!force && !/auto|scroll|overlay|hidden/u.test(String(style?.overflowY ?? ""))) return;
    const rect = typeof element.getBoundingClientRect === "function"
      ? element.getBoundingClientRect()
      : null;
    if (!force && (
      !rect
      || rect.width < 80
      || rect.height < 80
      || rect.right <= 0
      || rect.bottom <= 0
      || (viewportWidth > 0 && rect.left >= viewportWidth)
      || (viewportHeight > 0 && rect.top >= viewportHeight)
    )) return;
    seen.add(element);
    surfaces.push({
      element,
      area: Math.max(1, Number(rect?.width ?? element.clientWidth) * Number(rect?.height ?? element.clientHeight)),
    });
  };

  addSurface(root, true);
  for (const element of document.querySelectorAll("*")) addSurface(element);

  // Inner record lists should get a chance to trigger their own lazy loader
  // before an outer page surface changes the layout around them.
  surfaces.sort((left, right) => left.area - right.area);
  const maxSurfaces = 48;
  let movedCount = 0;
  for (const { element } of surfaces.slice(0, maxSurfaces)) {
    const before = Number(element.scrollTop) || 0;
    const target = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
    try {
      if (typeof element.scrollTo === "function") element.scrollTo(0, target);
    } catch {
      // Fall back to the property assignment below for partial DOM shims.
    }
    try {
      element.scrollTop = target;
    } catch {
      // A read-only surface cannot be used for pagination.
    }
    const after = Number(element.scrollTop) || 0;
    if (Math.abs(after - before) <= 1) continue;
    movedCount += 1;
    try {
      element.dispatchEvent?.(new Event("scroll", { bubbles: true }));
    } catch {
      // Dispatch is only an additional nudge; scrolling already happened.
    }
  }

  const documentHeight = Math.max(
    Number(document.documentElement?.scrollHeight) || 0,
    Number(root?.scrollHeight) || 0,
  );
  try {
    window.scrollTo?.(0, documentHeight);
  } catch {
    // The list response listener remains authoritative if the window surface
    // is unavailable in a browser shim.
  }
  return { candidateCount: surfaces.length, movedCount };
}

const templateFileName = "direct-history-template.json";
const DIRECT_HISTORY_ORIGIN = "https://www.douyin.com";
const DIRECT_HISTORY_TEMPLATE_ORIGINS = new Set([
  DIRECT_HISTORY_ORIGIN,
  "https://www-hj.douyin.com",
]);
const DIRECT_HISTORY_PATH = "/aweme/v1/web/history/read/";
const LOGIN_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const BUSINESS_PARAMETERS = new Map([
  ["count", "20"],
  ["max_cursor", "0"],
  ["directory", "0"],
  ["category", "0"],
  ["status", "-1"],
]);
const SESSION_PARAMETERS = new Map([
  ["msToken", "msToken"],
  ["verifyFp", "s_v_web_id"],
  ["fp", "s_v_web_id"],
  ["uifid", "UIFID"],
]);
export const SAFE_TEMPLATE_PARAMETERS = new Set([
  "device_platform", "aid", "channel", "update_version_code", "pc_client_type", "pc_libra_divert",
  "support_h265", "support_dash", "version_code", "version_name", "cookie_enabled", "screen_width",
  "screen_height", "browser_language", "browser_platform", "browser_name", "browser_version",
  "browser_online", "engine_name", "engine_version", "os_name", "os_version", "cpu_core_num",
  "device_memory", "platform", "downlink", "effective_type", "round_trip_time", "webid",
]);
const SAFE_TEMPLATE_HEADERS = new Set(["accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
const ALLOWED_TEMPLATE_PARAMETERS = new Set([
  ...BUSINESS_PARAMETERS.keys(),
  ...SESSION_PARAMETERS.keys(),
  ...SAFE_TEMPLATE_PARAMETERS,
]);
const REQUIRED_TEMPLATE_PARAMETERS = new Set([
  "count", "max_cursor", "verifyFp", "fp", "uifid", "aid", "device_platform", "webid",
]);
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const DIRECT_LIST_REQUEST_TIMEOUT_MS = 30_000;
// 一页喜欢/收藏本身就要传 1–2 MB；再隔 300ms，大约每秒一页，比抖音页面自己滚动加载（约每秒两页）还慢
const DIRECT_LIST_PAGE_INTERVAL_MS = 300;

export class DirectHistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DirectHistoryError";
    this.code = code;
  }
}

function settleWithin(operation, timeoutMs, onTimeout) {
  let timeout;
  const task = Promise.resolve().then(operation);
  task.catch(() => undefined);
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([task, deadline]).finally(() => clearTimeout(timeout));
}

function templatePath(dataDirectory) {
  return path.join(path.resolve(dataDirectory), templateFileName);
}

function safeTemplateString(value, limit = 300) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= limit
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function validateUserAgent(value) {
  return safeTemplateString(value, 500)
    && value.length >= 40
    && /\bChrome\/\d{2,3}(?:\.\d+){3}\b/u.test(value)
    ? value
    : null;
}

function validatedTemplate(value) {
  if (
    !value
    || value.version !== 1
    || value.signerCommit !== DIRECT_SIGNER_COMMIT
    || !Array.isArray(value.parameterOrder)
    || !value.values
    || !value.headers
  ) return null;
  const parameterOrder = [];
  const seen = new Set();
  for (const name of value.parameterOrder) {
    if (typeof name !== "string" || !ALLOWED_TEMPLATE_PARAMETERS.has(name) || seen.has(name)) return null;
    seen.add(name);
    parameterOrder.push(name);
  }
  if ([...REQUIRED_TEMPLATE_PARAMETERS].some((name) => !seen.has(name))) return null;

  const values = {};
  for (const name of SAFE_TEMPLATE_PARAMETERS) {
    if (!seen.has(name)) continue;
    const item = value.values[name];
    if (!safeTemplateString(item)) return null;
    values[name] = item;
  }
  if (values.aid !== "6383" || values.device_platform !== "webapp" || !/^\d{6,30}$/u.test(values.webid ?? "")) return null;

  const userAgent = validateUserAgent(value.headers["user-agent"]);
  if (!userAgent) return null;
  const headers = { "user-agent": userAgent };
  for (const name of SAFE_TEMPLATE_HEADERS) {
    const item = value.headers[name];
    if (item !== undefined) {
      if (!safeTemplateString(item)) return null;
      headers[name] = item;
    }
  }
  return {
    version: 1,
    signerCommit: DIRECT_SIGNER_COMMIT,
    capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : null,
    parameterOrder,
    values,
    headers,
  };
}

function validHistoryUrl(value, allowSignature = false, { canonicalHost = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.pathname !== DIRECT_HISTORY_PATH
    || (canonicalHost
      ? url.origin !== DIRECT_HISTORY_ORIGIN
      : !DIRECT_HISTORY_TEMPLATE_ORIGINS.has(url.origin))
    || url.username
    || url.password
    || (!allowSignature && url.searchParams.has("a_bogus"))
  ) return null;
  return url;
}

// The browser may route the same official endpoint through www-hj, while the
// direct replay path intentionally stays on the canonical www host.
export function validateDirectHistoryUrl(value, { allowSignature = false, canonicalHost = false } = {}) {
  return validHistoryUrl(value, allowSignature, { canonicalHost });
}

export async function captureDirectHistoryTemplate(dataDirectory, request, browserUserAgent = null) {
  if (!dataDirectory || !request || typeof request.url !== "function" || typeof request.headerValue !== "function") return false;
  const url = validateDirectHistoryUrl(request.url(), { allowSignature: true });
  if (!url?.searchParams.has("a_bogus")) return false;
  const parameterOrder = [];
  const values = {};
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    if (name === "a_bogus") continue;
    if (
      !ALLOWED_TEMPLATE_PARAMETERS.has(name)
      || seen.has(name)
      || !safeTemplateString(value, SESSION_PARAMETERS.has(name) ? 4_096 : 300)
    ) return false;
    seen.add(name);
    parameterOrder.push(name);
    if (SAFE_TEMPLATE_PARAMETERS.has(name)) values[name] = value;
  }
  const requestUserAgent = await request.headerValue("user-agent").catch(() => null);
  const headers = { "user-agent": validateUserAgent(requestUserAgent) ?? browserUserAgent };
  for (const name of SAFE_TEMPLATE_HEADERS) {
    const value = await request.headerValue(name).catch(() => null);
    if (value) headers[name] = value;
  }
  const template = validatedTemplate({
    version: 1,
    signerCommit: DIRECT_SIGNER_COMMIT,
    capturedAt: new Date().toISOString(),
    parameterOrder,
    values,
    headers,
  });
  if (!template) return false;
  const destination = templatePath(dataDirectory);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return true;
}

export async function loadDirectHistoryTemplate(dataDirectory) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(templatePath(dataDirectory), "utf8"));
  } catch {
    throw new DirectHistoryError(
      "template_missing",
      "增量读取尚未初始化，请点击「完整读取」完成一次观看历史读取后再试。",
    );
  }
  const template = validatedTemplate(parsed);
  if (!template) {
    throw new DirectHistoryError("template_invalid", "增量读取配置已失效，请点击「完整读取」更新后再试。");
  }
  return template;
}

export async function invalidateDirectHistoryTemplate(dataDirectory) {
  if (dataDirectory) await rm(templatePath(dataDirectory), { force: true });
}

function selectedCookieState(cookies) {
  return (cookies ?? []).filter((cookie) => {
    const domain = String(cookie?.domain ?? "").toLocaleLowerCase().replace(/^\./u, "");
    return (domain === "douyin.com" || domain.endsWith(".douyin.com"))
      && typeof cookie.name === "string"
      && typeof cookie.value === "string"
      && cookie.value;
  });
}

function selectedCookies(cookies) {
  const result = new Map();
  for (const cookie of selectedCookieState(cookies)) {
    if (!result.has(cookie.name) || cookie.domain === ".douyin.com" || cookie.domain === "douyin.com") {
      result.set(cookie.name, cookie.value);
    }
  }
  return result;
}

function sessionValue(cookies, name) {
  const candidates = selectedCookieState(cookies).filter((cookie) => cookie.name === name);
  return (candidates.find((cookie) => ["douyin.com", ".douyin.com"].includes(cookie.domain)) ?? candidates[0])?.value;
}

function requireSessionCookies(cookies) {
  const values = selectedCookies(cookies);
  if (![...LOGIN_COOKIE_NAMES].some((name) => values.has(name))) {
    throw new DirectHistoryError("login_required", "尚未导入登录凭据，请在设置 → 账号中连接浏览器并导入。");
  }
  for (const name of ["s_v_web_id", "UIFID"]) {
    if (!sessionValue(cookies, name)) {
      throw new DirectHistoryError("session_incomplete", "浏览器登录凭据缺少直接读取所需字段，请重新连接并导入。");
    }
  }
  return values;
}

export function buildUnsignedHistoryUrl(cookies, template) {
  const session = requireSessionCookies(cookies);
  const requestTemplate = validatedTemplate(template);
  if (!requestTemplate) throw new DirectHistoryError("template_invalid", "增量读取配置已失效，请点击「完整读取」更新后再试。");
  const url = new URL(DIRECT_HISTORY_ENDPOINT);
  for (const name of requestTemplate.parameterOrder) {
    const cookieName = SESSION_PARAMETERS.get(name);
    const value = BUSINESS_PARAMETERS.get(name)
      ?? (cookieName ? sessionValue(cookies, cookieName) : requestTemplate.values[name]);
    if (name === "msToken" && !value) continue;
    if (!value) throw new DirectHistoryError("template_invalid", "增量读取配置不完整，请点击「完整读取」更新后再试。");
    url.searchParams.append(name, value);
  }
  return { session, url };
}

export async function signDirectHistoryUrl(unsignedUrl, { userAgent } = {}) {
  const url = validateDirectHistoryUrl(unsignedUrl, { canonicalHost: true });
  if (!url) throw new DirectHistoryError("unsafe_url", "直接读取只允许固定的抖音观看历史接口。");
  const validatedUserAgent = validateUserAgent(userAgent);
  if (!validatedUserAgent) throw new DirectHistoryError("template_invalid", "直接读取模板缺少有效浏览器标识。");
  return new URL(nativeSignedUrl(url, { userAgent: validatedUserAgent }));
}

export const DIRECT_API_PATHS = new Set([
  "/aweme/v1/web/query/user/",
  "/webcast/feed/", "/webcast/web/feed/follow/",
  "/aweme/v1/web/user/profile/self/", "/aweme/v1/web/user/profile/other/",
  "/aweme/v1/web/aweme/detail/", "/aweme/v1/web/aweme/post/",
  "/aweme/v1/web/aweme/favorite/", "/aweme/v1/web/aweme/listcollection/",
  "/aweme/v1/web/collects/list/", "/aweme/v1/web/collects/video/list/",
  "/aweme/v1/web/comment/list/",
  "/aweme/v1/web/discover/search/", "/aweme/v1/web/search/item/", "/aweme/v1/web/tab/feed/",
  "/aweme/v1/web/commit/item/digg/", "/aweme/v1/web/aweme/collect/",
  "/aweme/v1/web/comment/publish", "/aweme/v1/web/comment/delete/", "/aweme/v1/web/commit/follow/user/",
  "/passport/safe/get_identity_security_token/",
]);
export const DIRECT_IM_PATHS = new Set(["/v1/message/send", "/v1/message/get_message_by_init", "/v1/message/get_user_message",
  "/v1/message/get_by_conversation", "/v2/conversation/get_info_list", "/v1/stranger/get_conversation_list"]);

// Keep the history signer's narrower URL boundary; other callers use an explicit API allowlist.
export async function signDirectApiUrl(unsignedUrl, options = {}) {
  let url;
  try { url = new URL(unsignedUrl); } catch { /* rejected below */ }
  const allowed = url && (["www.douyin.com", "www-hj.douyin.com"].includes(url.hostname) ? DIRECT_API_PATHS.has(url.pathname)
    : url.hostname === "imapi.douyin.com" && DIRECT_IM_PATHS.has(url.pathname));
  if (!url || url.protocol !== "https:" || !allowed
    || url.port || url.username || url.password || url.hash
    || url.searchParams.has("a_bogus")) {
    throw new DirectHistoryError("unsafe_url", "直接请求地址不在抖音接口白名单内。");
  }
  // A valid 500-character Chinese comment expands past 4 KiB when form
  // encoded. Keep the signer bound while accommodating the supported input.
  if (![undefined, "GET", "POST"].includes(options.method) || (options.body?.length ?? 0) > 8_192) {
    throw new DirectHistoryError("invalid_request", "直接请求方法或请求体无效。");
  }
  if (!validateUserAgent(options.userAgent)) throw new DirectHistoryError("template_invalid", "直接请求缺少有效浏览器标识。");
  return nativeSignedUrl(url, options);
}

function directItems(payload, label = "记录") {
  const items = Array.isArray(payload?.aweme_list)
    ? payload.aweme_list
    : Array.isArray(payload?.data?.aweme_list)
      ? payload.data.aweme_list
      : null;
  if (!items) throw new DirectHistoryError("schema_changed", `${label}响应缺少 aweme_list，未保存本次结果。`);
  return items;
}

function directValue(payload, key) {
  return payload?.[key] ?? payload?.data?.[key];
}

function checkDirectStatus(payload) {
  const statusCode = directValue(payload, "status_code");
  // 8 是抖音的「未登录」：Cookie 还在，但服务端已让这次网页登录失效
  if (statusCode === 8) {
    throw new DirectHistoryError("login_required", "抖音登录已失效，请点「完整读取」，在弹出的浏览器里重新登录。");
  }
  if (statusCode !== undefined && statusCode !== 0) {
    throw new DirectHistoryError("douyin_error", `抖音读取返回状态码 ${String(statusCode).slice(0, 20)}。`);
  }
}

function validateDirectPayload(payload, label) {
  checkDirectStatus(payload);
  return directItems(payload, label);
}

function timestampIsValid(value) {
  if (typeof value !== "number" && typeof value !== "string") return false;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const year = new Date(milliseconds).getUTCFullYear();
  return year >= 2000 && year <= 2100;
}

export function countMissingDirectHistoryViewTimes(payload) {
  const dates = directValue(payload, "aweme_date");
  return directItems(payload, "观看历史").filter((item) => {
    const id = String(item?.aweme_id ?? "");
    const mapped = dates && typeof dates === "object" && !Array.isArray(dates) && Object.hasOwn(dates, id)
      ? dates[id]
      : null;
    return !timestampIsValid(mapped) && !timestampIsValid(item?.history_info?.view_time);
  }).length;
}

export async function fetchDirectHistoryPage({
  context,
  currentUserAgent,
  dataDirectory,
  cursor = "0",
  completedOnly = false,
  requestFactory = playwrightRequest,
  signer = signDirectHistoryUrl,
}) {
  if (!context || typeof context.cookies !== "function" || typeof requestFactory?.newContext !== "function") {
    throw new DirectHistoryError("invalid_context", "直接读取没有可用的登录会话。");
  }
  const normalizedCursor = String(cursor);
  if (!/^\d{1,20}$/u.test(normalizedCursor)) {
    throw new DirectHistoryError("invalid_cursor", "观看历史分页游标无效，已停止读取。");
  }
  const template = await loadDirectHistoryTemplate(dataDirectory);
  if (validateUserAgent(currentUserAgent) !== template.headers["user-agent"]) {
    throw new DirectHistoryError("template_mismatch", "浏览器已变化，请点击「完整读取」更新增量读取配置后再试。");
  }
  const cookies = await context.cookies("https://www.douyin.com/", DIRECT_HISTORY_ENDPOINT);
  requireSessionCookies(cookies);
  const { url: unsignedUrl } = buildUnsignedHistoryUrl(cookies, template);
  unsignedUrl.searchParams.set("max_cursor", normalizedCursor);
  // 观看历史页「筛选 → 观看进度 → 已看完」发的就是这三个参数，紧跟在 count 后面；少了另外两个会回状态码 5
  if (completedOnly) {
    const params = [...unsignedUrl.searchParams];
    unsignedUrl.search = "";
    for (const [name, value] of params) {
      // 模板自己带的筛选（用户在页面里点过筛选时会被抓进来）不能跟着发，否则一个请求里有两个 status
      if (["status", "category", "directory"].includes(name)) continue;
      unsignedUrl.searchParams.append(name, value);
      if (name !== "count") continue;
      unsignedUrl.searchParams.append("status", "1");
      unsignedUrl.searchParams.append("category", "0");
      unsignedUrl.searchParams.append("directory", "0");
    }
    // 没带上筛选就会拿到整份历史，被当成「全看完了」
    if (unsignedUrl.searchParams.getAll("status").join() !== "1") {
      throw new DirectHistoryError("template_invalid", "增量读取配置缺少分页参数，无法读取看完标记。");
    }
  }
  const userAgent = template.headers["user-agent"];
  const signedUrl = await signer(unsignedUrl, { userAgent });
  if (!validateDirectHistoryUrl(signedUrl, { allowSignature: true, canonicalHost: true })?.searchParams.has("a_bogus")) {
    throw new DirectHistoryError("unsafe_url", "签名结果偏离固定观看历史接口，已拒绝发送。");
  }

  const isolatedRequest = await requestFactory.newContext({
    storageState: { cookies: selectedCookieState(cookies), origins: [] },
    userAgent,
  });
  try {
    let response;
    try {
      response = await isolatedRequest.get(signedUrl.toString(), {
        failOnStatusCode: false,
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.douyin.com/user/self?showTab=record",
          "User-Agent": userAgent,
          ...Object.fromEntries([...SAFE_TEMPLATE_HEADERS].flatMap((name) => (
            template.headers[name] ? [[name, template.headers[name]]] : []
          ))),
        },
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 30_000,
      });
    } catch {
      throw new DirectHistoryError("request_failed", "观看历史直接请求失败或发生重定向；本次没有重试。");
    }
    const status = response.status();
    if (status === 401 || status === 403) {
      await invalidateDirectHistoryTemplate(dataDirectory);
      throw new DirectHistoryError("session_rejected", `观看历史直接请求返回 HTTP ${status}，已停止且不会自动重试。`);
    }
    if (status === 429) throw new DirectHistoryError("rate_limited", "观看历史直接请求触发限流，已停止且不会自动重试。");
    if (status !== 200) throw new DirectHistoryError("http_error", `观看历史直接请求返回 HTTP ${status}。`);
    if (!validateDirectHistoryUrl(response.url(), { allowSignature: true, canonicalHost: true })) {
      throw new DirectHistoryError("unexpected_response", "观看历史响应来自非预期地址，已拒绝处理。");
    }
    const declaredLength = Number(response.headers()["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new DirectHistoryError("response_too_large", "观看历史响应过大，已拒绝处理。");
    }
    const body = await response.body();
    if (body.length > MAX_RESPONSE_BYTES) throw new DirectHistoryError("response_too_large", "观看历史响应过大，已拒绝处理。");
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new DirectHistoryError("invalid_json", "观看历史接口没有返回有效 JSON。");
    }
    validateDirectPayload(payload, "观看历史");
    return payload;
  } catch (error) {
    throw context.sessionError?.(error) ?? error;
  } finally {
    await isolatedRequest.dispose().catch(() => undefined);
  }
}

const DIRECT_LIST_LABELS = {
  liked_videos: "点赞列表",
  favorite_videos: "收藏列表",
};

// 设备和浏览器参数用观看历史模板里抓到的那份，和页面自己发的一样；msToken 和各种签名留给页面 SDK 补
function pageRequestUrl(endpoint, template, business) {
  const url = new URL(endpoint);
  for (const [name, value] of business) url.searchParams.append(name, value);
  for (const name of template.parameterOrder) {
    if (SAFE_TEMPLATE_PARAMETERS.has(name)) url.searchParams.append(name, template.values[name]);
  }
  return url.toString();
}

// 抖音页面自己翻喜欢、收藏时发的就是这两种请求：喜欢是 GET + max_cursor，收藏是 POST 表单 + cursor
function listRequest(type, template, cursor, secUid) {
  if (type === "liked_videos") {
    return {
      url: pageRequestUrl(DIRECT_LIKED_ENDPOINT, template, [
        ["sec_user_id", secUid], ["max_cursor", cursor], ["min_cursor", "0"], ["whale_cut_token", ""],
        ["cut_version", "1"], ["count", "18"], ["publish_video_strategy_type", "2"],
      ]),
      body: null,
    };
  }
  return {
    url: pageRequestUrl(DIRECT_FAVORITE_ENDPOINT, template, [["publish_video_strategy_type", "2"]]),
    body: `count=10&cursor=${cursor}`,
  };
}

// 在抖音页面里执行。页面的安全 SDK 会给这里发出的请求补上 a_bogus、msToken 和 x-secsdk-web-signature
async function fetchFromPage({ url, body }) {
  const response = await fetch(url, body === null ? { credentials: "include" } : {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function requestInPage(page, request, label) {
  const result = await settleWithin(
    () => page.evaluate(fetchFromPage, request),
    DIRECT_LIST_REQUEST_TIMEOUT_MS,
    () => new DirectHistoryError("page_timeout", `${label}请求超时，已停止读取。`),
  ).catch((error) => {
    if (error instanceof DirectHistoryError) throw error;
    throw new DirectHistoryError("request_failed", `${label}请求失败，请检查网络后重试。`);
  });
  const status = Number(result?.status);
  const text = typeof result?.text === "string" ? result.text : "";
  if (status === 401 || status === 403) {
    throw new DirectHistoryError("session_rejected", text.includes("Argus")
      ? `${label}请求被抖音安全网关拦下，已停止且未保存本次结果。`
      : `${label}读取返回 HTTP ${status}，已停止且未保存本次结果。`);
  }
  if (status === 429) throw new DirectHistoryError("rate_limited", `${label}读取触发限流，已停止且不会自动重试。`);
  if (status !== 200) throw new DirectHistoryError("http_error", `${label}读取返回 HTTP ${status}。`);
  if (text.length > MAX_RESPONSE_BYTES) throw new DirectHistoryError("response_too_large", `${label}响应过大，已拒绝处理。`);
  try {
    return JSON.parse(text);
  } catch {
    throw new DirectHistoryError("invalid_json", `${label}接口没有返回有效 JSON。`);
  }
}

// Legacy page adapter, retained for older callers. The current collector uses
// DirectApiClient with native A-Bogus and SecSDK signing, without page.evaluate.
export async function collectDirectRecordPages(page, type, onPage, { dataDirectory } = {}) {
  if (!page || typeof page.evaluate !== "function" || typeof onPage !== "function") {
    throw new DirectHistoryError("invalid_context", "无界面读取没有可用的抖音页面。");
  }
  const label = DIRECT_LIST_LABELS[type];
  if (!label) throw new DirectHistoryError("invalid_type", "无界面读取记录类型无效。");
  const template = await loadDirectHistoryTemplate(dataDirectory);
  let secUid = null;
  if (type === "liked_videos") {
    // 点赞列表要带本人的 sec_uid，问 profile/self 拿：拿到的一定是这个页面里登录的号
    const self = await requestInPage(page, { url: pageRequestUrl(DIRECT_SELF_ENDPOINT, template, []), body: null }, "账号资料");
    checkDirectStatus(self);
    secUid = typeof self?.user?.sec_uid === "string" && /^MS4w[\w-]{10,200}$/u.test(self.user.sec_uid) ? self.user.sec_uid : null;
    if (!secUid) throw new DirectHistoryError("schema_changed", "账号资料缺少 sec_uid，未读取点赞列表。");
  }
  const cursors = new Set();
  let cursor = "0";
  for (let pageCount = 1; ; pageCount += 1) {
    if (cursors.has(cursor)) {
      throw new DirectHistoryError("pagination_stalled", `${label}分页游标重复，已停止且未保存本次结果。`);
    }
    cursors.add(cursor);
    const payload = await requestInPage(page, listRequest(type, template, cursor, secUid), label);
    validateDirectPayload(payload, label);
    const rawHasMore = directValue(payload, "has_more");
    const hasMore = [1, "1", true].includes(rawHasMore) ? true : [0, "0", false].includes(rawHasMore) ? false : null;
    if (hasMore === null) throw new DirectHistoryError("pagination_missing", `${label}响应缺少分页状态。`);
    const next = String(directValue(payload, type === "liked_videos" ? "max_cursor" : "cursor") ?? "");
    if (hasMore && !/^\d{1,20}$/u.test(next)) {
      throw new DirectHistoryError("pagination_missing", `${label}响应缺少下一页游标。`);
    }
    if (await onPage(payload, pageCount) === false || !hasMore) return pageCount;
    cursor = next;
    await new Promise((resolve) => setTimeout(resolve, DIRECT_LIST_PAGE_INTERVAL_MS));
  }
}
