// 创作者中心（creator.douyin.com）的数据，只读。同一套读法也读创作者平台里的「抖音指数」（/api/v2/index/*）。
// 在共享无头会话里开一个 creator.douyin.com 的空白同源页，带着登录 cookie 直接请求接口：
// 10-06 实测这些接口不用页面签名，结果和官方页面一致。不加载创作者中心页面本身，
// 不点任何东西；能请求的只有下面白名单里的查询接口，发布、删除、回复这些写接口没有入口。

import { decryptIndexData } from "./indexCrypto.mjs";

const ORIGIN = "https://creator.douyin.com";
const BLANK_URL = `${ORIGIN}/robots.txt`;
// 详情页一次要读十来个接口，标签页留着复用；这么久没人读就收掉
const IDLE_CLOSE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BATCH = 24;

const CREATOR_QUERY = { aid: "2906", app_name: "aweme_creator_platform", device_platform: "web" };
const WORK_LIST_QUERY = { aid: "1128", scene: "star_atlas", device_platform: "android" };
const COMMENT_READ = "/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment";
const COMMENT_QUERY = { app_id: "2906", aid: "2906", device_platform: "webapp", channel_id: "618" };
// 评论搜索词是用户输入的任意文字，单独放行（URLSearchParams 会编码），限长
const TEXT_PARAMS = new Set(["keyword"]);
// 抖音指数的日期是 YYYYMMDD、平台只有这两个
const PARAM_CHECKS = { start_date: /^\d{8}$/u, end_date: /^\d{8}$/u, app_name: /^(?:aweme|toutiao)$/u };

// key → 接口。params 是工作台可以传进来的参数名；body 为 true 的是 POST JSON 查询（官方页面也这样发）
export const CREATOR_ENDPOINTS = {
  user_info: { path: "/aweme/v1/creator/user/info/", query: CREATOR_QUERY, params: [] },
  author_upgrade: { path: "/janus/douyin/creator/data/author/upgrade/", query: CREATOR_QUERY, params: [] },
  // 数据中心
  diagnosis: { method: "POST", path: "/dp/douyin/v1/creator/item/author_diagnosis", query: CREATOR_QUERY, params: [], body: true },
  contribution_top: { path: "/janus/douyin/creator/data/overview/item_contribution_top", query: CREATOR_QUERY, params: ["dimension", "recent_days"] },
  dashboard: { method: "POST", path: "/janus/douyin/creator/data/overview/dashboard", query: CREATOR_QUERY, params: ["recent_days"], body: true },
  dashboard_mix: { path: "/janus/douyin/creator/data/overview/dashboard/mix", query: CREATOR_QUERY, params: ["recent_days"] },
  dashboard_fans: { path: "/janus/douyin/creator/data/overview/dashboard/fans", query: CREATOR_QUERY, params: ["recent_days"] },
  mix_list: { path: "/web/api/creator/item/mix/list", query: CREATOR_QUERY, params: ["count"] },
  live_dashboard: { method: "POST", path: "/dp/douyin/v1/data/live/dashboardv2", query: CREATOR_QUERY, params: ["day_window", "tab_type"], body: true },
  live_trends: { method: "POST", path: "/dp/douyin/v1/data/live/trendsv2", query: CREATOR_QUERY, params: ["day_window", "metrics_type"], body: true },
  live_gift_billboard: { method: "POST", path: "/dp/douyin/v1/data/live/gift_billboard", query: CREATOR_QUERY, params: ["day_window"], body: true },
  live_watch_billboard: { method: "POST", path: "/dp/douyin/v1/data/live/watch_billboard", query: CREATOR_QUERY, params: ["day_window"], body: true },
  live_fans_source: { method: "POST", path: "/dp/douyin/v1/data/live/fans_source", query: CREATOR_QUERY, params: ["day_window"], body: true },
  fans_summary: { path: "/janus/douyin/creator/bff/data/fans/summary/v2", query: {}, params: [] },
  // 作品管理
  work_list: { path: "/janus/douyin/creator/pc/work_list", query: WORK_LIST_QUERY, params: ["status", "count", "max_cursor", "min_cursor"] },
  item_list: {
    path: "/web/api/creator/item/list",
    query: { ...CREATOR_QUERY, fields: "default,metrics", need_cooperation: "true", need_long_article: "true", disable_demo: "true" },
    params: ["user_id", "count", "order_by", "start_time", "end_time", "min_cursor", "max_cursor"],
  },
  // 作品详情
  item_mget: { path: "/web/api/creator/item/mget", query: CREATOR_QUERY, params: ["ids", "fields"] },
  item_summarize: { path: "/web/api/creator/data/item/summarize/", query: CREATOR_QUERY, params: ["item_id"] },
  item_compare: { path: "/janus/douyin/creator/data/diagnose/item_compare", query: CREATOR_QUERY, params: ["item_id", "selected_metric_count"] },
  item_trend: { path: "/janus/douyin/creator/data/item_analysis/metrics_trend", query: CREATOR_QUERY, params: ["item_id", "trend_type", "time_unit", "metrics_group", "metrics"] },
  item_realtime: { path: "/janus/douyin/creator/data/realtime/analysis/data_center", query: CREATOR_QUERY, params: ["user_id", "item_id", "analysis_type"] },
  item_progress: { path: "/janus/douyin/creator/bff/data/progress/analysis/v2", query: CREATOR_QUERY, params: ["item_id"] },
  item_bullet: { path: "/janus/douyin/creator/bff/data/bullet/analysis/v2", query: CREATOR_QUERY, params: ["item_id"] },
  item_chapter: { path: "/janus/douyin/creator/data/item/chapter", query: CREATOR_QUERY, params: ["user_id", "item_id"] },
  item_play_source: { path: "/janus/douyin/creator/data/item/play/source", query: CREATOR_QUERY, params: ["item_id"] },
  item_search_keyword: { path: "/janus/douyin/creator/data/item_analysis/search/keyword", query: CREATOR_QUERY, params: ["id"] },
  item_portrait: { path: "/janus/douyin/creator/data/fans/item/portrait", query: CREATOR_QUERY, params: ["item_id", "user_id"] },
  item_audience: { path: "/janus/douyin/creator/data/fans/item/others", query: CREATOR_QUERY, params: ["item_id", "user_id"] },
  comment_hotwords: { path: "/aweme/v1/creator/data/item/wordCloud/", query: CREATOR_QUERY, params: ["item_id", "mcn_type"] },
  // 评论：发布 30 天内走网页版读接口，更早的走创作者老接口（和官方一致）
  comment_list: { path: `${COMMENT_READ}/list/select/`, query: COMMENT_QUERY, params: ["aweme_id", "cursor", "count", "keyword", "sort_options", "comment_select_options"] },
  comment_replies: { path: `${COMMENT_READ}/list/reply/`, query: COMMENT_QUERY, params: ["item_id", "comment_id", "cursor", "count"] },
  comment_list_old: { path: "/aweme/v1/creator/comment/list", query: { aid: "2906" }, params: ["item_id", "cursor", "count", "sort"] },
  comment_replies_old: { path: "/aweme/v1/creator/comment/reply/list", query: { aid: "2906" }, params: ["comment_id", "cursor", "count"] },
  // 抖音指数：搜索一个词只用这几个。查询窗口的结束日取 index_valid_date.keyword_latest_day（T-1），
  // 关联词和人群取 index_relation_valid_date.datetime（T-3）。响应多半是加密的，read() 里解开。
  // 订阅、历史、消息这些个人接口不放进来。shape 把工作台传的单个词整理成官方页面发的请求体
  // 抖音指数首页的「抖音实时热点」「抖音飙升热点」两个榜，一个接口各 30 条
  index_hot_topic: { path: "/api/v2/hot/get_current_hot_topic", query: {}, params: [] },
  index_valid_date: { path: "/api/v2/index/get_all_valid_date", query: {}, params: [] },
  index_relation_valid_date: { path: "/api/v2/index/get_valid_date_for_relation", query: {}, params: [] },
  index_keyword_valid: { method: "POST", path: "/api/v2/index/get_keyword_valid_date", query: {}, params: ["keyword"], body: true, require: ["keyword"],
    shape: ({ keyword }) => ({ keyword_list: [keyword] }) },
  index_hot_trend: { method: "POST", path: "/api/v2/index/get_multi_keyword_hot_trend", query: {}, params: ["keyword", "start_date", "end_date", "app_name"], body: true, require: ["keyword", "start_date", "end_date"],
    shape: ({ keyword, start_date, end_date, app_name }) => ({ keyword_list: [keyword], start_date, end_date, app_name: app_name ?? "aweme", region: [] }) },
  index_interpretation: { method: "POST", path: "/api/v2/index/get_multi_keyword_interpretation", query: {}, params: ["keyword", "start_date", "end_date", "app_name"], body: true, require: ["keyword", "start_date", "end_date"],
    shape: ({ keyword, start_date, end_date, app_name }) => ({ keyword_list: [keyword], start_date, end_date, app_name: app_name ?? "aweme", region: [] }) },
  index_relation_word: { method: "POST", path: "/api/v2/index/get_relation_word", query: {}, params: ["keyword", "start_date", "end_date", "app_name"], body: true, require: ["keyword", "start_date", "end_date"],
    shape: ({ keyword, start_date, end_date, app_name }) => ({ param: { keyword, start_date, end_date, app_name: app_name ?? "aweme" } }) },
  index_portrait: { method: "POST", path: "/api/v2/index/get_portrait", query: {}, params: ["keyword", "start_date", "end_date", "app_name"], body: true, require: ["keyword", "start_date", "end_date"],
    shape: ({ keyword, start_date, end_date, app_name }) => ({ param: { keyword, app_name: app_name ?? "aweme", start_date, end_date } }) },
};

// 数字 id、逗号串、日期，以及 sec_item_id 这种 base64（带 @ / + =）
const PARAM_VALUE = /^[\w,.:@/+=-]{0,160}$/u;

export class CreatorCenterError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "CreatorCenterError";
    this.code = code;
    this.status = status;
  }
}

/** 白名单 key + 参数 → { method, url, body }；参数不合法返回 null。 */
export function creatorRequest(key, params = {}) {
  const endpoint = Object.hasOwn(CREATOR_ENDPOINTS, key) ? CREATOR_ENDPOINTS[key] : null;
  if (!endpoint || !params || typeof params !== "object" || Array.isArray(params)) return null;
  const picked = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!endpoint.params.includes(name)) return null;
    const text = String(value);
    if (Object.hasOwn(PARAM_CHECKS, name) ? !PARAM_CHECKS[name].test(text) : TEXT_PARAMS.has(name) ? text.length > 50 || /[\u0000-\u001f]/u.test(text) : !PARAM_VALUE.test(text)) return null;
    picked[name] = text;
  }
  if (endpoint.require?.some((name) => !picked[name]?.trim())) return null;
  const method = endpoint.method ?? "GET";
  const query = new URLSearchParams(endpoint.query);
  let body = null;
  if (endpoint.body) {
    // 官方页面把查询条件放 JSON 体里，数字按数字传；shape 的是整理好结构的（日期必须保持字符串）
    body = endpoint.shape ? JSON.stringify(endpoint.shape(picked)) : JSON.stringify(Object.fromEntries(Object.entries(picked).map(([name, value]) => [name, /^\d+$/u.test(value) && value.length < 16 ? Number(value) : value])));
  } else {
    for (const [name, value] of Object.entries(picked)) query.set(name, value);
  }
  return { method, url: `${ORIGIN}${endpoint.path}?${query}`, body };
}

/** 抖音的作品 id 超过 JS 安全整数，解析前把长数字改成字符串，免得精度丢掉认错作品。 */
export function parseCreatorJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(quoteLongNumbers(text));
  } catch {
    return null;
  }
}

// 只动字符串外面的整数：分享文案、图片地址里也常有长串数字，不能碰
function quoteLongNumbers(text) {
  let out = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      for (index += 1; index < text.length && text[index] !== "\""; index += 1) if (text[index] === "\\") index += 1;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < text.length && /[\d.eE+-]/u.test(text[end])) end += 1;
      const token = text.slice(index, end);
      if (/^-?\d{16,}$/u.test(token)) {
        out += `${text.slice(start, index)}"${token}"`;
        start = end;
      }
      index = end - 1;
    }
  }
  return out + text.slice(start);
}

// 抖音这几个接口未登录时的表现：HTTP 401/403，或者 status_code 8 / 2190008
function needsLogin(status, payload) {
  if (status === 401 || status === 403) return true;
  const code = Number(payload?.status_code ?? payload?.code ?? payload?.BaseResp?.StatusCode ?? 0);
  return code === 8 || code === 2190008 || code === 10008;
}

export class CreatorCenter {
  constructor(collector) {
    this.collector = collector;
    this.page = null;
    this.opening = null;
    this.idleTimer = null;
  }

  get active() {
    return Boolean(this.page && !this.page.isClosed()) || Boolean(this.opening);
  }

  async read(requests) {
    if (!Array.isArray(requests) || !requests.length || requests.length > MAX_BATCH) throw new CreatorCenterError("invalid_request", "请求无效，请重试。", 400);
    const prepared = requests.map((item) => creatorRequest(item?.key, item?.params ?? {}));
    if (prepared.some((item) => !item)) throw new CreatorCenterError("invalid_request", "请求无效，请重试。", 400);
    let page;
    try {
      page = await this.ensurePage();
    } catch (error) {
      // 没登录、连不上：浏览器可能已经启动了，不安排收尾就没人会释放它
      this.scheduleIdleClose();
      throw error;
    }
    clearTimeout(this.idleTimer);
    try {
      const raw = await page.evaluate(async ({ list, timeout }) => Promise.all(list.map(async ({ method, url, body }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(url, {
            method,
            credentials: "include",
            signal: controller.signal,
            headers: body === null ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
            body: body ?? undefined,
          });
          return { status: response.status, text: await response.text(), encrypted: response.headers.get("x-encrypted") };
        } catch {
          return { status: 0, text: "" };
        } finally {
          clearTimeout(timer);
        }
      })), { list: prepared, timeout: REQUEST_TIMEOUT_MS });
      // 抖音指数的响应带 x-encrypted：外层 {data:<密文>}，解开才是业务 JSON。解不开要单独标出来，别当成「没数据」
      const results = raw.map(({ status, text, encrypted }) => {
        if (!encrypted) return { status, data: parseCreatorJson(text) };
        const plain = decryptIndexData(parseCreatorJson(text)?.data);
        return plain ? { status, data: parseCreatorJson(plain) } : { status, data: null, undecryptable: true };
      });
      if (results.some(({ status, data }) => needsLogin(status, data))) throw new CreatorCenterError("login_required", "登录抖音以后，才能看创作者中心的数据。");
      if (results.every(({ status }) => status === 0)) throw new CreatorCenterError("creator_unavailable", "没连上抖音创作者中心，请检查网络后重试。", 502);
      return results.map(({ status, data, undecryptable }) => (status >= 200 && status < 300 && data ? { ok: true, data } : { ok: false, status, ...(undecryptable ? { reason: "undecryptable" } : {}) }));
    } finally {
      this.scheduleIdleClose();
    }
  }

  async ensurePage() {
    const collector = this.collector;
    if (this.page && !this.page.isClosed() && this.page.context() === collector.context) return this.page;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (collector.visibleBrowserWorkRunning()) throw new CreatorCenterError("collector_busy", "采集器正在用浏览器读取记录，读完就能看创作者中心。");
      const context = await collector.ensureBrowser({ headless: true });
      if (!await collector.hasLoginSession(context, null)) throw new CreatorCenterError("login_required", "登录抖音以后，才能看创作者中心的数据。");
      const page = await context.newPage();
      // 本机解析 creator.douyin.com 偶尔卡十几秒（10-06 冷启动第一次超时、紧接着重试就通），所以失败再试一次
      let opened = false;
      for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
        opened = await page.goto(BLANK_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS }).then(() => true, () => false);
      }
      if (!opened) {
        await page.close().catch(() => {});
        throw new CreatorCenterError("creator_unavailable", "没连上抖音创作者中心，请检查网络后重试。", 502);
      }
      page.on("close", () => { if (this.page === page) this.page = null; });
      this.page = page;
      return page;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  async close() {
    clearTimeout(this.idleTimer);
    const page = this.page;
    this.page = null;
    if (page) await page.close().catch(() => {});
    await this.collector.releaseHeadlessContextIfIdle?.();
  }
}
