import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request as playwrightRequest } from "playwright-core";
import { DIRECT_API_PATHS, SAFE_TEMPLATE_PARAMETERS, DirectHistoryError, signDirectApiUrl } from "./directHistory.mjs";
import { CREATOR_ENDPOINTS } from "./creatorCenter.mjs";
import { validateDirectCredentials } from "./directCredentials.mjs";

const ORIGIN = "https://www.douyin.com";
const SESSION_FILE = "direct-session.json";
const MAX_BYTES = 24 * 1024 * 1024;
const LOGIN_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const SESSION_HEADERS = new Set(["accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
const WEB_SIGN_PATHS = new Set([
  "/aweme/v1/web/aweme/detail/", "/aweme/v1/web/aweme/post/",
  "/aweme/v1/web/aweme/favorite/", "/aweme/v1/web/aweme/listcollection/",
  "/aweme/v1/web/collects/list/", "/aweme/v1/web/collects/video/list/",
]);

export function sessionCookies(cookies, now = Date.now()) {
  return (Array.isArray(cookies) ? cookies : []).filter((cookie) => {
    const domain = String(cookie?.domain ?? "").replace(/^\./u, "").toLowerCase();
    return (domain === "douyin.com" || domain.endsWith(".douyin.com"))
      && /^[!#$%&'*+.^_`|~\w-]+$/u.test(cookie.name ?? "")
      && typeof cookie.value === "string" && cookie.value && !/[;\r\n]/u.test(cookie.value)
      && !(cookie.expires !== -1 && cookie.expires != null && cookie.expires * 1000 <= now);
  });
}

export function sameDirectSession(first, second) {
  const login = (session) => JSON.stringify(sessionCookies(session.cookies).filter((cookie) => LOGIN_NAMES.has(cookie.name))
    .map(({ domain, path: cookiePath, name, value }) => [domain, cookiePath, name, value]).sort());
  return first.uid === second.uid && first.userAgent === second.userAgent && login(first) === login(second);
}

export function needsDirectSessionRefresh(session, now = Date.now()) {
  if (!session.browserBoundSession) return false;
  const tokens = sessionCookies(session.cookies, now).filter(cookie => cookie.name === "x_tt_token");
  return !tokens.some(cookie => cookie.expires === -1 || cookie.expires * 1000 > now + 5_000);
}

function validateSession(value, expectedUid) {
  const cookies = sessionCookies(value?.cookies);
  if (value?.version !== 1 || !/^\d{1,30}$/u.test(value.uid ?? "")
    || typeof value.userAgent !== "string" || !/^Mozilla\/5\.0 /u.test(value.userAgent)
    || /[\r\n]|HeadlessChrome/u.test(value.userAgent) || value.userAgent.length > 500
    || !cookies.some((cookie) => LOGIN_NAMES.has(cookie.name))) {
    throw new DirectHistoryError("direct_session_missing", "直接请求登录会话尚未建立或已过期，请先登录抖音。");
  }
  if (expectedUid && value.uid !== expectedUid) {
    throw new DirectHistoryError("account_mismatch", "登录会话与当前账号不一致，请重新登录当前账号。");
  }
  const values = Object.fromEntries([...SAFE_TEMPLATE_PARAMETERS].flatMap((name) => {
    const item = value.values?.[name];
    return typeof item === "string" && item.length <= 500 && !/[\r\n]/u.test(item) ? [[name, item]] : [];
  }));
  const session = { version: 1, uid: value.uid, userAgent: value.userAgent, cookies,
    browserBoundSession: value.browserBoundSession === true || value.cookies.some(cookie => cookie.name === "is_dbsc" && cookie.value === "true"),
    secUid: /^MS4w[\w-]{10,200}$/u.test(value.secUid ?? "") ? value.secUid : null,
    values,
    requestHeaders: Object.fromEntries([...SESSION_HEADERS].flatMap(name => {
      const header = value.requestHeaders?.[name];
      return typeof header === "string" && header.length <= 500 && !/[\r\n]/u.test(header) ? [[name, header]] : [];
    })),
    savedAt: value.savedAt ?? null };
  const security = validateDirectCredentials(value.security, session);
  if (security) session.security = security;
  return session;
}

export async function loadDirectSession(dataDirectory, expectedUid) {
  let value;
  try { value = JSON.parse(await readFile(path.join(dataDirectory, SESSION_FILE), "utf8")); }
  catch { throw new DirectHistoryError("direct_session_missing", "直接请求登录会话尚未建立，请先登录抖音。"); }
  return validateSession(value, expectedUid);
}

export async function saveDirectSession(dataDirectory, value) {
  const session = validateSession(value);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(dataDirectory, SESSION_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...session, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return session;
}

// Protocol reference: TikTokDownloader/src/encrypt/websign.py and
// cv-cat/DouYin_Spider/utils/secsdk_web_sign.py. The SDK signs the encoded query
// including a_bogus, UIFID and a seconds timestamp; URLSearchParams must not
// re-serialize the final query (spaces and punctuation would change).
export function signSecsdkUrl(value, uifid, timestamp = Math.floor(Date.now() / 1000)) {
  const url = new URL(value);
  const pairs = [...url.searchParams].filter(([name]) => !["timestamp", "x-secsdk-web-signature"].includes(name));
  if (!pairs.some(([name]) => name === "uifid") && uifid) pairs.push(["uifid", uifid]);
  pairs.push(["timestamp", String(timestamp)]);
  const query = pairs.map(([name, item]) => `${name}=${encodeURIComponent(item)}`).join("&");
  const id = pairs.find(([name]) => name === "uifid")?.[1] ?? uifid ?? "";
  const signature = createHash("md5").update(`${id}_${timestamp}_A96D855A08C0A9707F8BEF0D9A527E4E_${query}`).digest("hex");
  return `${url.origin}${url.pathname}?${query}&x-secsdk-web-signature=${signature}`;
}

export class DirectApiClient {
  constructor(session, { dataDirectory, directory, requestFactory = playwrightRequest, signer = signDirectApiUrl } = {}) {
    this.session = validateSession(session);
    this.dataDirectory = dataDirectory;
    this.directory = directory;
    this.requestFactory = requestFactory;
    this.signer = signer;
    this.currentUserAgent = session.userAgent;
    this.directApi = this;
    this.secUid = this.session.secUid;
    this.contextPromise = null;
    this.contextLease = null;
    this.retiredContexts = new Set();
  }
  async cookies(...urls) {
    const all = sessionCookies(this.session.cookies);
    return !urls.length ? all : all.filter((cookie) => urls.some((value) => {
      const url = new URL(value);
      const domain = cookie.domain.replace(/^\./u, "");
      return (url.hostname === domain || (cookie.domain.startsWith(".") && url.hostname.endsWith(`.${domain}`)))
        && url.pathname.startsWith(cookie.path || "/");
    }));
  }
  cookie(name, session = this.session) {
    const cookies = sessionCookies(session.cookies).filter((item) => item.name === name);
    return (cookies.find((item) => [".douyin.com", "douyin.com"].includes(item.domain)) ?? cookies[0])?.value ?? "";
  }
  getContextLease() {
    if (this.contextLease) return this.contextLease;
    const lease = { active: 0, retired: false, disposal: null, promise: null };
    const options = { storageState: { cookies: sessionCookies(this.session.cookies), origins: [] }, userAgent: this.currentUserAgent };
    lease.promise = Promise.resolve().then(() => this.requestFactory.newContext(options)).catch(error => {
      if (this.contextLease === lease) { this.contextLease = null; this.contextPromise = null; }
      throw error;
    });
    this.contextLease = lease; this.contextPromise = lease.promise;
    return lease;
  }
  async context() { return this.getContextLease().promise; }
  disposeContextLease(lease) {
    lease.disposal ??= lease.promise.then(context => context.dispose()).catch(() => {})
      .finally(() => this.retiredContexts.delete(lease));
    return lease.disposal;
  }
  retireCurrentContext() {
    const lease = this.contextLease;
    this.contextLease = null; this.contextPromise = null;
    if (!lease) return;
    lease.retired = true; this.retiredContexts.add(lease);
    if (!lease.active) void this.disposeContextLease(lease);
  }
  replaceSession(value) {
    const next = validateSession(value, this.session.uid);
    const jar = session => JSON.stringify(sessionCookies(session.cookies).map(cookie =>
      [cookie.domain, cookie.path, cookie.name, cookie.value, cookie.expires, cookie.httpOnly, cookie.secure, cookie.sameSite]).sort());
    if (next.userAgent !== this.session.userAgent || jar(next) !== jar(this.session)) {
      this.retireCurrentContext(); this.session = next;
    } else Object.assign(this.session, next);
    this.currentUserAgent = next.userAgent; this.secUid = next.secUid;
  }
  async close() {
    this.retireCurrentContext();
    await Promise.all([...this.retiredContexts].map(lease => this.disposeContextLease(lease)));
  }
  async persistSession() {
    if (this.dataDirectory) await saveDirectSession(this.dataDirectory, this.session);
  }
  async raw(url, { method = "GET", body = null, referer = `${ORIGIN}/`, signal, contentType, allowErrorStatus = false, headers = {} } = {}) {
    signal?.throwIfAborted();
    const isolated = Boolean(signal);
    const requestSession = this.session;
    const lease = isolated ? null : this.getContextLease();
    if (lease) lease.active += 1;
    let context, response;
    const abort = () => { void context?.dispose().catch(() => {}); };
    try {
      context = isolated ? await this.requestFactory.newContext({ storageState: { cookies: sessionCookies(requestSession.cookies), origins: [] }, userAgent: requestSession.userAgent }) : await lease.promise;
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      // APIRequestContext is an HTTP client; it never launches a browser or executes page code.
      response = await context.fetch(url, { method, data: body ?? undefined,
        headers: { ...requestSession.requestHeaders, Accept: "application/json, text/plain, */*", Referer: referer,
          "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": new URL(url).origin === ORIGIN ? "same-origin" : "same-site", priority: "u=1, i",
          "User-Agent": requestSession.userAgent, ...(new URL(url).hostname !== "imapi.douyin.com" && this.cookie("UIFID", requestSession) ? { uifid: this.cookie("UIFID", requestSession) } : {}),
          ...(body !== null ? { "content-type": contentType ?? "application/x-www-form-urlencoded; charset=UTF-8" } : {}), ...headers },
        maxRedirects: 0, maxRetries: 0, timeout: 30_000, failOnStatusCode: false });
      signal?.throwIfAborted();
      const status = response.status();
      if (!allowErrorStatus) {
        if (status === 401 || status === 403) throw new DirectHistoryError("session_rejected", `抖音接口返回 HTTP ${status}，请在登录浏览器中检查会话或验证提示。`);
        if (status === 429) throw new DirectHistoryError("rate_limited", "抖音接口触发限流，已停止读取。");
        if (status !== 200) throw new DirectHistoryError("http_error", `抖音接口返回 HTTP ${status}。`);
      }
      if (Number(response.headers()["content-length"] ?? 0) > MAX_BYTES) throw new DirectHistoryError("response_too_large", "接口响应超过读取容量。");
      const buffer = await response.body();
      if (buffer.length > MAX_BYTES) throw new DirectHistoryError("response_too_large", "接口响应超过读取容量。");
      const state = await context.storageState();
      if (this.session === requestSession) {
        this.session.cookies = sessionCookies(state.cookies);
        const msToken = response.headers()["x-ms-token"];
        if (this.session.security && ["www.douyin.com", "www-hj.douyin.com", "imapi.douyin.com"].includes(new URL(url).hostname) && /^[A-Za-z0-9+/_=-]{100,1024}$/u.test(msToken || ""))
          this.session.security.msToken = msToken;
        if (this.dataDirectory) await saveDirectSession(this.dataDirectory, this.session);
      }
      return { status, text: buffer.toString("utf8"), buffer, headers: response.headers(), encrypted: response.headers()["x-encrypted"] ?? null };
    } catch (error) {
      if (error instanceof DirectHistoryError || signal?.aborted) throw error;
      throw new DirectHistoryError("request_failed", "抖音直接请求失败，请检查网络后重试。");
    } finally {
      signal?.removeEventListener("abort", abort);
      await response?.dispose().catch(() => {});
      if (isolated) await context?.dispose().catch(() => {});
      if (lease) {
        lease.active -= 1;
        if (lease.retired && !lease.active) await this.disposeContextLease(lease);
      }
    }
  }
  async request(pathname, { query = {}, method = "GET", body = null, referer, signal } = {}) {
    if (!DIRECT_API_PATHS.has(pathname) || !["GET", "POST"].includes(method)) throw new DirectHistoryError("unsafe_url", "直接请求不在接口白名单内。");
    const url = new URL(pathname, ORIGIN);
    const common = { device_platform: "webapp", aid: "6383", channel: "channel_pc_web", ...this.session.values };
    for (const [name, value] of Object.entries({ ...common, ...query })) {
      if (!["count", "cursor", "max_cursor", "min_cursor", "status", "category", "directory", "a_bogus", "timestamp", "x-secsdk-web-signature"].includes(name) || name in query)
        url.searchParams.set(name, String(value));
    }
    const reply = pathname === "/aweme/v1/web/comment/list/reply/";
    // Reply signatures omit UIFID and fingerprint fields. The latter are appended
    // after a_bogus, as in DouYin_Spider's get_work_inner_comment protocol.
    for (const [name, cookie] of reply ? [["msToken", "msToken"]] : [["verifyFp", "s_v_web_id"], ["fp", "s_v_web_id"], ["uifid", "UIFID"], ["msToken", "msToken"]]) {
      const value = name === "msToken" ? this.session.security?.msToken || this.cookie(cookie) : this.cookie(cookie);
      if (value) url.searchParams.set(name, value);
    }
    const data = body === null ? null : typeof body === "string" ? body : new URLSearchParams(body).toString();
    const signed = await this.signer(url, { directory: this.directory, userAgent: this.currentUserAgent,
      uifid: this.cookie("UIFID"), method, body: data ?? "" });
    const checked = new URL(signed);
    if (checked.origin !== url.origin || checked.pathname !== pathname || checked.hash || checked.username || checked.password
      || !/^[A-Za-z0-9+/_=-]{64,512}$/u.test(checked.searchParams.get("a_bogus") ?? ""))
      throw new DirectHistoryError("unsafe_url", "签名结果偏离允许的接口，已停止请求。");
    let signedUrl = WEB_SIGN_PATHS.has(pathname) ? signSecsdkUrl(signed, this.cookie("UIFID")) : String(signed);
    if (reply && this.cookie("s_v_web_id")) signedUrl += `&verifyFp=${encodeURIComponent(this.cookie("s_v_web_id"))}&fp=${encodeURIComponent(this.cookie("s_v_web_id"))}`;
    const response = await this.raw(signedUrl, { method, body: data, referer, signal });
    if (response.text.trim() === "blocked") throw new DirectHistoryError("verification_required", "抖音要求安全验证，请在登录浏览器中完成后重试。");
    let payload;
    try { payload = JSON.parse(response.text); } catch { throw new DirectHistoryError("invalid_json", "抖音接口没有返回有效 JSON。"); }
    if (!payload || typeof payload !== "object") throw new DirectHistoryError("schema_changed", "抖音接口数据格式发生变化。");
    if ([payload.search_nil_info?.search_nil_type, payload.search_nil_info?.search_nil_item].includes("verify_check"))
      throw new DirectHistoryError("verification_required", "抖音要求安全验证，请在登录浏览器中完成后重试。");
    if (payload.status_code === 8) throw new DirectHistoryError("login_required", "抖音登录已失效，请重新登录后再试。");
    if (payload.status_code !== undefined && payload.status_code !== 0)
      throw new DirectHistoryError("platform_rejected", "抖音未确认本次请求，请检查登录状态或验证提示。");
    return payload;
  }
  async verifyIdentity(expectedUid, signal) {
    const payload = await this.request("/aweme/v1/web/query/user/", { query: { publish_video_strategy_type: "2" }, signal });
    const uid = String(payload.user_uid ?? "");
    // Expired sessions can still receive a numeric anonymous id with status 0.
    // Confirm the self profile before treating that id as another account.
    if ([0, "0"].includes(payload.user_uid_type)) {
      const profile = await this.request("/aweme/v1/web/user/profile/self/", { signal });
      if (Object.hasOwn(profile, "user") && profile.user === null)
        throw new DirectHistoryError("login_required", "抖音登录已失效，请重新登录后再试。");
      const selfUid = String(profile.user?.uid ?? "");
      if (!/^[1-9]\d{0,29}$/u.test(selfUid))
        throw new DirectHistoryError("schema_changed", "账号资料缺少身份信息，已停止读取。");
      if (selfUid !== this.session.uid || (expectedUid && selfUid !== expectedUid))
        throw new DirectHistoryError("account_mismatch", "接口登录账号与当前账号不一致，已停止读取。");
      if (selfUid !== uid)
        throw new DirectHistoryError("schema_changed", "登录身份接口返回了不同的身份信息，请刷新登录会话后再试。");
    }
    if (!/^\d{1,30}$/u.test(uid) || /^0+$/u.test(uid))
      throw new DirectHistoryError("schema_changed", "账号资料缺少身份信息，已停止读取。");
    if (uid !== this.session.uid || (expectedUid && uid !== expectedUid))
      throw new DirectHistoryError("account_mismatch", "接口登录账号与当前账号不一致，已停止读取。");
    return { uid };
  }
  async collectRecordPages(type, onPage, { signal } = {}) {
    if (!["liked_videos", "favorite_videos"].includes(type)) throw new DirectHistoryError("invalid_type", "记录类型无效。");
    const liked = type === "liked_videos";
    if (liked && !this.secUid) {
      const raw = await this.readCreator({ method: "GET", url: "https://creator.douyin.com/web/api/media/user/info/", body: null });
      let own;
      try { own = JSON.parse(raw.text)?.user; } catch { /* rejected below */ }
      if (own?.uid && String(own.uid) !== this.session.uid) throw new DirectHistoryError("account_mismatch", "账号资料与当前账号不一致。");
      if (!/^MS4w[\w-]{10,200}$/u.test(own?.sec_uid ?? "")) throw new DirectHistoryError("schema_changed", "账号资料缺少 sec_uid，已停止读取。");
      this.secUid = own.sec_uid; this.session.secUid = own.sec_uid;
      if (this.dataDirectory) await saveDirectSession(this.dataDirectory, this.session);
    }
    const seen = new Set(); let cursor = "0";
    for (let count = 1; count <= 10_000; count += 1) {
      signal?.throwIfAborted();
      if (seen.has(cursor)) throw new DirectHistoryError("pagination_stalled", "分页游标重复，已停止读取。");
      seen.add(cursor);
      const payload = await this.request(liked ? "/aweme/v1/web/aweme/favorite/" : "/aweme/v1/web/aweme/listcollection/", {
        method: liked ? "GET" : "POST", query: liked ? { sec_user_id: this.secUid, max_cursor: cursor, min_cursor: "0", whale_cut_token: "", cut_version: "1", count: "18", publish_video_strategy_type: "2" } : { publish_video_strategy_type: "2" },
        body: liked ? null : { count: "10", cursor }, signal,
        referer: `${ORIGIN}/user/self?showTab=${liked ? "like" : "favorite_collection"}`,
      });
      const data = payload.data ?? payload;
      if (!Array.isArray(data.aweme_list)) throw new DirectHistoryError("schema_changed", "列表响应缺少作品数据。");
      const more = [1, "1", true].includes(data.has_more) ? true : [0, "0", false].includes(data.has_more) ? false : null;
      if (more === null) throw new DirectHistoryError("pagination_missing", "列表响应缺少分页状态。");
      const next = String(data[liked ? "max_cursor" : "cursor"] ?? "");
      if (more && !/^\d{1,20}$/u.test(next)) throw new DirectHistoryError("pagination_missing", "列表响应缺少下一页游标。");
      if (await onPage(payload, count) === false || !more) return count;
      cursor = next; await delay(300, undefined, { signal });
    }
    throw new DirectHistoryError("record_limit", "读取页数超过容量，已停止读取。");
  }
  async readCreator(prepared) {
    const url = new URL(prepared.url);
    const endpoint = Object.values(CREATOR_ENDPOINTS).find((item) => item.path === url.pathname && (item.method ?? "GET") === prepared.method);
    const ownInfo = url.pathname === "/web/api/media/user/info/" && prepared.method === "GET";
    if (url.origin !== "https://creator.douyin.com" || url.username || url.password || url.hash || (!endpoint && !ownInfo)) throw new DirectHistoryError("unsafe_url", "创作者请求不在查询白名单内。");
    return this.raw(url.toString(), { method: prepared.method, body: prepared.body, contentType: "application/json", referer: "https://creator.douyin.com/", allowErrorStatus: true });
  }
}
