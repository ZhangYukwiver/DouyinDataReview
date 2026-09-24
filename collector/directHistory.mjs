import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { request as playwrightRequest } from "playwright-core";

export const DIRECT_HISTORY_ENDPOINT = "https://www.douyin.com/aweme/v1/web/history/read/";
export const DIRECT_LIKED_ENDPOINT = "https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/";
export const DIRECT_FAVORITE_ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/listcollection/";
export const DIRECT_SIGNER_COMMIT = "42987a1aa0c88c4d7f00d106ea2bc87dc01b0edf";
export const DIRECT_SIGNER_FILES = Object.freeze({
  LICENSE: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
  "lib/runtime/bdms/index.js": "5c3b712aa5ee9b88aa438843512ed10d21564ef2acad3158baf68b37d639b29f",
  "lib/runtime/bdms/env.js": "ae95d680b2dfdd95b93f36dd74864e834e10f875df7f9ec69ad362b85194c3cd",
  "lib/runtime/bdms/bdms.js": "393b30953e215c3c006cd44c179c1e0cd2375a458bea268eb17bf1401096469b",
});

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSignerDirectory = path.resolve(moduleDirectory, "..", ".local-data", "direct-signer");
const asarPathMarker = `${path.sep}app.asar${path.sep}`;
const signerRunnerPath = path.join(moduleDirectory, "directSignerRunner.cjs").replace(
  asarPathMarker,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
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
const SAFE_TEMPLATE_PARAMETERS = new Set([
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
const MAX_SIGNER_OUTPUT_BYTES = 64 * 1024;
const SIGNER_TIMEOUT_MS = 8_000;
const DIRECT_LIST_RESPONSE_TIMEOUT_MS = 12_000;
const DIRECT_LIST_PAGE_OPERATION_TIMEOUT_MS = 15_000;
const DIRECT_LIST_CLOSE_TIMEOUT_MS = 5_000;
const MACOS_SIGNER_PROFILE = "(version 1) (allow default) (deny network*) (deny file-write*)";

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

async function closeWithin(resource, timeoutMs) {
  if (!resource || typeof resource.close !== "function") return;
  const task = Promise.resolve().then(() => resource.close());
  task.catch(() => undefined);
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

export function directSignerProcessConfiguration({
  platform = process.platform,
  executablePath = process.execPath,
  runtimeDirectory,
  runnerPath = signerRunnerPath,
} = {}) {
  if (!runtimeDirectory || !runnerPath || !executablePath) {
    throw new DirectHistoryError("signer_failed", "直接读取签名器缺少运行路径。");
  }
  if (platform !== "darwin" && platform !== "win32") {
    throw new DirectHistoryError("unsupported_platform", "直接读取目前仅支持 Windows 和 macOS。");
  }
  const resolvedRuntimeDirectory = path.resolve(runtimeDirectory);
  const resolvedRunnerPath = path.resolve(runnerPath);
  const nodeArguments = [
    "--permission",
    `--allow-fs-read=${resolvedRuntimeDirectory}`,
    `--allow-fs-read=${resolvedRunnerPath}`,
    resolvedRunnerPath,
    resolvedRuntimeDirectory,
  ];
  const env = {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ELECTRON_RUN_AS_NODE: "1",
    ...(platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  return {
    command: platform === "darwin" ? "/usr/bin/sandbox-exec" : executablePath,
    args: platform === "darwin"
      ? ["-p", MACOS_SIGNER_PROFILE, executablePath, ...nodeArguments]
      : nodeArguments,
    options: {
      cwd: resolvedRuntimeDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  };
}

function signerDirectory(value) {
  return path.resolve(value || process.env.DOUYIN_DIRECT_SIGNER_DIR || defaultSignerDirectory);
}

function templatePath(dataDirectory) {
  return path.join(path.resolve(dataDirectory), templateFileName);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

export async function verifyDirectSigner(directory) {
  const root = signerDirectory(directory);
  for (const [relativePath, expectedHash] of Object.entries(DIRECT_SIGNER_FILES)) {
    let content;
    try {
      content = await readFile(path.join(root, relativePath));
    } catch {
      throw new DirectHistoryError(
        "signer_missing",
        "直接读取签名器缺失，请重新安装应用；开发环境请运行 npm run direct:setup。",
      );
    }
    if (sha256(content) !== expectedHash) {
      throw new DirectHistoryError("signer_tampered", "直接读取签名器校验失败，已拒绝执行。");
    }
  }
  return realpath(path.join(root, "lib", "runtime"));
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
    throw new DirectHistoryError("login_required", "专用浏览器尚未登录，请先完成一次浏览器登录。");
  }
  for (const name of ["s_v_web_id", "UIFID"]) {
    if (!sessionValue(cookies, name)) {
      throw new DirectHistoryError("session_incomplete", "专用浏览器会话缺少直接读取所需字段，请重新登录后再试。");
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

export async function signDirectHistoryUrl(unsignedUrl, { directory, uifid = "", userAgent } = {}) {
  const url = validateDirectHistoryUrl(unsignedUrl, { canonicalHost: true });
  if (!url) throw new DirectHistoryError("unsafe_url", "直接读取只允许固定的抖音观看历史接口。");
  const validatedUserAgent = validateUserAgent(userAgent);
  if (!validatedUserAgent) throw new DirectHistoryError("template_invalid", "直接读取模板缺少有效浏览器标识。");
  const runtimeDirectory = await verifyDirectSigner(directory);
  const processConfiguration = directSignerProcessConfiguration({ runtimeDirectory });
  const payload = JSON.stringify({ url: url.toString(), method: "GET", body: "", uifid, userAgent: validatedUserAgent });
  const signature = await new Promise((resolve, reject) => {
    const child = spawn(
      processConfiguration.command,
      processConfiguration.args,
      processConfiguration.options,
    );
    let stdout = Buffer.alloc(0);
    let totalOutput = 0;
    let outputTooLarge = false;
    const capture = (chunk, keep) => {
      totalOutput += chunk.length;
      if (totalOutput > MAX_SIGNER_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
      } else if (keep) stdout = Buffer.concat([stdout, chunk]);
    };
    child.stdout.on("data", (chunk) => capture(chunk, true));
    child.stderr.on("data", (chunk) => capture(chunk, false));
    child.stdin.on("error", () => undefined);
    child.once("error", () => reject(new DirectHistoryError("signer_failed", "直接读取签名器无法启动。")));
    const timer = setTimeout(() => child.kill("SIGKILL"), SIGNER_TIMEOUT_MS);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputTooLarge) return reject(new DirectHistoryError("signer_output_too_large", "直接读取签名器输出异常，已停止执行。"));
      if (code !== 0) return reject(new DirectHistoryError("signer_failed", "直接读取签名器执行失败。"));
      const marker = "__SIGN_RESULT__";
      const output = stdout.toString("utf8");
      const index = output.lastIndexOf(marker);
      const line = index === -1 ? "" : output.slice(index + marker.length).split(/\r?\n/u, 1)[0];
      try {
        const parsed = JSON.parse(line);
        if (!parsed.ok || typeof parsed.a_bogus !== "string" || !/^[A-Za-z0-9+/_=-]{64,512}$/u.test(parsed.a_bogus)) {
          throw new Error("invalid_signature");
        }
        resolve(parsed.a_bogus);
      } catch {
        reject(new DirectHistoryError("signer_invalid_output", "直接读取签名器没有返回有效结果。"));
      }
    });
    child.stdin.end(payload);
  });
  url.searchParams.append("a_bogus", signature);
  return url;
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

function validateDirectPayload(payload, label) {
  const statusCode = directValue(payload, "status_code");
  // 8 是抖音的「未登录」：Cookie 还在，但服务端已让这次网页登录失效
  if (statusCode === 8) {
    throw new DirectHistoryError("login_required", "抖音登录已失效，请点「完整读取」，在弹出的浏览器里重新登录。");
  }
  if (statusCode !== undefined && statusCode !== 0) {
    throw new DirectHistoryError("douyin_error", `抖音读取返回状态码 ${String(statusCode).slice(0, 20)}。`);
  }
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
  directory,
  cursor = "0",
  requestFactory = playwrightRequest,
  signer = signDirectHistoryUrl,
}) {
  if (!context || typeof context.cookies !== "function" || typeof requestFactory?.newContext !== "function") {
    throw new DirectHistoryError("invalid_context", "直接读取没有可用的专用浏览器会话。");
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
  const userAgent = template.headers["user-agent"];
  const signedUrl = await signer(unsignedUrl, {
    directory,
    uifid: sessionValue(cookies, "UIFID"),
    userAgent,
  });
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
  } finally {
    await isolatedRequest.dispose().catch(() => undefined);
  }
}

function hiddenListConfig(type) {
  if (type === "liked_videos") {
    return {
      endpoint: DIRECT_LIKED_ENDPOINT,
      label: "点赞列表",
      pageUrl: "https://www.douyin.com/user/self?showTab=like",
    };
  }
  if (type === "favorite_videos") {
    return {
      endpoint: DIRECT_FAVORITE_ENDPOINT,
      label: "收藏列表",
      pageUrl: "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection",
    };
  }
  throw new DirectHistoryError("invalid_type", "无界面读取记录类型无效。");
}

export async function collectDirectRecordPages(context, type, onPage) {
  if (!context || typeof context.newPage !== "function" || typeof onPage !== "function") {
    throw new DirectHistoryError("invalid_context", "无界面读取没有可用的专用浏览器会话。");
  }
  const config = hiddenListConfig(type);
  const endpointPath = new URL(config.endpoint).pathname;
  const page = await context.newPage();
  const seenPages = new Map();
  let terminal = false;
  let responseError = null;
  let accessError = null;
  let responseCount = 0;
  const responseQueue = [];
  page.on("response", (response) => {
    let responseUrl;
    try {
      responseUrl = new URL(response.url());
    } catch {
      return;
    }
    if (
      !["https://www.douyin.com", "https://www-hj.douyin.com"].includes(responseUrl.origin)
      || responseUrl.pathname !== endpointPath
    ) return;
    const readTask = response.finished().catch(() => undefined).then(async () => ({
      body: await response.body(),
      headers: response.headers(),
      status: response.status(),
    }));
    let timeout;
    const task = Promise.race([
      readTask,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new DirectHistoryError(
          "response_timeout",
          `${config.label}响应读取超时。`,
        )), DIRECT_LIST_RESPONSE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    responseQueue.push(task);
    void task.catch(() => undefined);
  });
  const processResponse = async ({ body, headers, status }) => {
    if (terminal || responseError) return;
    if (status === 401 || status === 403) {
      accessError = new DirectHistoryError("session_rejected", `${config.label}读取返回 HTTP ${status}。`);
      return;
    }
    if (status === 429) throw new DirectHistoryError("rate_limited", `${config.label}读取触发限流。`);
    if (status !== 200) throw new DirectHistoryError("http_error", `${config.label}读取返回 HTTP ${status}。`);
    accessError = null;
    const declaredLength = Number(headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new DirectHistoryError("response_too_large", `${config.label}响应过大，已拒绝处理。`);
    }
    if (body.length > MAX_RESPONSE_BYTES) throw new DirectHistoryError("response_too_large", `${config.label}响应过大，已拒绝处理。`);
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new DirectHistoryError("invalid_json", `${config.label}接口没有返回有效 JSON。`);
    }
    const items = validateDirectPayload(payload, config.label);
    const rawHasMore = directValue(payload, "has_more");
    const hasMore = rawHasMore === 1 || rawHasMore === "1" || rawHasMore === true
      ? true
      : rawHasMore === 0 || rawHasMore === "0" || rawHasMore === false
        ? false
        : null;
    if (hasMore === null) throw new DirectHistoryError("pagination_missing", `${config.label}响应缺少分页状态。`);
    const cursor = String(directValue(payload, type === "liked_videos" ? "max_cursor" : "cursor") ?? "");
    if (hasMore && !/^\d{1,20}$/u.test(cursor)) {
      throw new DirectHistoryError("pagination_missing", `${config.label}响应缺少下一页游标。`);
    }
    const fingerprint = items.map((item) => String(item?.aweme_id ?? "")).join(",");
    if (hasMore && seenPages.has(cursor)) {
      if (seenPages.get(cursor) === fingerprint) return;
      throw new DirectHistoryError("pagination_stalled", `${config.label}分页游标重复，已停止且未保存本次结果。`);
    }
    if (hasMore) seenPages.set(cursor, fingerprint);
    responseCount += 1;
    const shouldContinue = await onPage(payload, responseCount);
    terminal = !hasMore || shouldContinue === false;
  };
  const processQueuedResponses = async () => {
    let processed = false;
    while (!terminal && responseQueue.length > 0) {
      await processResponse(await responseQueue.shift());
      processed = true;
    }
    return processed;
  };
  try {
    await page.goto(config.pageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    let stalled = 0;
    while (!terminal && !responseError && stalled < 20) {
      const previousResponseCount = responseCount;
      await settleWithin(() => page.evaluate(() => {
        const candidates = [document.scrollingElement, ...document.querySelectorAll("*")]
          .filter((element) => {
            if (!element || element.scrollHeight <= element.clientHeight + 200) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return /auto|scroll|overlay/u.test(style.overflowY)
              && rect.width >= innerWidth / 2
              && rect.height >= innerHeight / 2;
          })
          .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight);
        const surface = candidates[0] ?? document.scrollingElement;
        surface?.scrollTo?.(0, surface.scrollHeight);
        window.scrollTo(0, document.documentElement.scrollHeight);
      }), DIRECT_LIST_PAGE_OPERATION_TIMEOUT_MS, () => new DirectHistoryError(
        "page_timeout",
        `${config.label}页面操作超时，已停止读取。`,
      ));
      await new Promise((resolve) => setTimeout(resolve, 800));
      await processQueuedResponses().catch((error) => { responseError = error; });
      stalled = responseCount > previousResponseCount ? 0 : stalled + 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await processQueuedResponses().catch((error) => { responseError = error; });
    if (responseError) throw responseError;
    if (accessError && !terminal) throw accessError;
    if (!terminal) throw new DirectHistoryError("pagination_missing", `${config.label}未到达末页，已停止且未保存本次结果。`);
    return responseCount;
  } finally {
    await closeWithin(page, DIRECT_LIST_CLOSE_TIMEOUT_MS).catch(() => undefined);
  }
}

async function checkSigner() {
  const onWindows = process.platform === "win32";
  const userAgent = onWindows
    ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const url = new URL(DIRECT_HISTORY_ENDPOINT);
  for (const [name, value] of BUSINESS_PARAMETERS) url.searchParams.append(name, value);
  url.searchParams.append("device_platform", "webapp");
  url.searchParams.append("aid", "6383");
  url.searchParams.append("screen_width", "1920");
  url.searchParams.append("screen_height", "1080");
  url.searchParams.append("browser_language", "zh-CN");
  url.searchParams.append("browser_platform", onWindows ? "Win32" : "MacIntel");
  url.searchParams.append("cpu_core_num", "8");
  url.searchParams.append("device_memory", "8");
  url.searchParams.append("webid", "1234567890123456789");
  const signed = await signDirectHistoryUrl(url, { uifid: "offline-check-uifid", userAgent });
  if (!signed.searchParams.has("a_bogus")) throw new Error("signer_check_failed");
  console.log("DIRECT_SIGNER_OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "--check-signer") {
  checkSigner().catch((error) => {
    console.error(error instanceof DirectHistoryError ? error.message : "直接读取签名器检查失败。");
    process.exitCode = 1;
  });
}
