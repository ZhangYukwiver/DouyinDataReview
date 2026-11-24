import { createHash } from "node:crypto";

export const BILIBILI_ORIGIN = "https://www.bilibili.com";
export const BILIBILI_API = "https://api.bilibili.com";
const LIVE = "https://api.live.bilibili.com";
const MESSAGE = "https://api.vc.bilibili.com";
const MEMBER = "https://member.bilibili.com";
const NAV = "/x/web-interface/nav";

export class BilibiliError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "BilibiliError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeBvid(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^BV[0-9A-Za-z]{10}$/u.test(id) ? id : null;
}

const invalid = message => new BilibiliError("invalid_request", message, 400);
const upstream = () => new BilibiliError("bilibili_upstream_failed", "B 站接口暂时没有返回有效数据。", 502);

function text(value, label, limit) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || [...input].length > limit) throw invalid(`${label}须为 1–${limit} 个字符。`);
  return input;
}

function id(value, label) {
  const input = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof input !== "string" || !/^[1-9][0-9]{0,19}$/u.test(input)) throw invalid(`${label}须为正整数。`);
  return input;
}

function optionalId(value, label) {
  return value === undefined ? undefined : id(value, label);
}

function count(value, label, fallback, max) {
  if (value === undefined) return fallback;
  const result = Number(id(value, label));
  if (result > max) throw invalid(`${label}不可超过 ${max}。`);
  return result;
}

function choice(value, label, allowed) {
  if (!allowed.includes(value)) throw invalid(`${label}须为 ${allowed.join("、")}。`);
  return value;
}

function enabled(value) {
  if (typeof value !== "boolean") throw invalid("enabled 须为布尔值。");
  return value;
}

function bvid(value) {
  const result = normalizeBvid(value);
  if (!result) throw invalid("请输入有效的 BVID。");
  return result;
}

function pageOf(input) {
  return { pn: count(input.page, "页码", 1, 1000), ps: count(input.pageSize, "每页数量", 20, 50) };
}

function queryOf(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined));
}

function wbiImageStem(url) {
  return typeof url === "string" ? /\/([0-9a-f]{32})\.[a-z]+(?:\?.*)?$/iu.exec(url)?.[1] : undefined;
}

// B 站的 nav 接口对未登录请求也返回这两个公开图片 URL。WBI 规定用 MD5 计算请求摘要。
const WBI_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function sign(params, nav) {
  const image = wbiImageStem(nav.wbi_img?.img_url);
  const sub = wbiImageStem(nav.wbi_img?.sub_url);
  if (!image || !sub) throw new BilibiliError("bilibili_wbi_unavailable", "B 站没有返回网页接口签名所需的数据。", 502);
  const imageStems = image + sub;
  const mixin = WBI_ORDER.map(index => imageStems[index]).join("");
  const query = queryOf({ ...params, wts: Math.floor(Date.now() / 1000) });
  query.sort();
  for (const [name, value] of query.entries()) query.set(name, value.replace(/[!'()*]/gu, ""));
  const encoded = query.toString().replace(/%7E/gu, "~");
  const digest = createHash("md5").update(encoded + mixin).digest("hex");
  return `${encoded}&w_rid=${digest}`;
}

function parseResponse(raw) {
  return JSON.parse(raw, (_key, value, context) => {
    // 私信 ID 等部分整数超过了 JavaScript 的精度。保留原始十进制字符串。
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context?.source ?? "")) {
      return context.source;
    }
    return value;
  });
}

function responseData(status, body) {
  const code = body?.code == null ? undefined : Number(body.code);
  if (status === 429 || status === 412 || [-352, -412, -509].includes(code)) {
    throw new BilibiliError("bilibili_rate_limited", "B 站限制了当前请求，请稍后再试。", 429);
  }
  if (status === 401 || code === -101) throw new BilibiliError("bilibili_login_required", "请先登录当前 B 站账号。", 409);
  if (status === 403 || [-111, -403].includes(code)) throw new BilibiliError("bilibili_forbidden", "当前 B 站账号无法执行这项操作。", 403);
  if (status === 404 || code === -404 || code === 62002) throw new BilibiliError("bilibili_not_found", "B 站内容不存在或不可访问。", 404);
  if (status < 200 || status >= 300 || code !== 0) throw upstream();
  return body.data ?? body.result ?? (body.trending ? { trending: body.trending } : null);
}

export async function openBilibiliProtocol(context, { signal }) {
  let nav;
  async function request(host, route, params = {}, { signed = false, form } = {}) {
    signal.throwIfAborted();
    const query = signed ? sign(params, nav) : queryOf(params).toString();
    const url = new URL(route, host);
    url.search = query;
    const referer = {
      [LIVE]: "https://live.bilibili.com/",
      [MESSAGE]: "https://message.bilibili.com/",
      [MEMBER]: `${MEMBER}/platform/data-center`,
      [BILIBILI_API]: route === "/x/web-interface/ranking/v2" ? `${BILIBILI_ORIGIN}/v/popular/rank/all` : `${BILIBILI_ORIGIN}/`,
    }[host];
    let response;
    try {
      response = await context.request.fetch(url.href, {
        method: form ? "POST" : "GET",
        headers: { Accept: "application/json", Referer: referer, ...(form ? { Origin: new URL(referer).origin } : {}) },
        ...(form ? { form } : {}),
        timeout: 15_000, maxRedirects: 0, maxRetries: 0,
      });
      const raw = await response.text();
      signal.throwIfAborted();
      let body;
      try { body = parseResponse(raw); } catch { body = null; }
      return responseData(response.status(), body);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof BilibiliError) throw error;
      throw upstream();
    } finally {
      await response?.dispose().catch(() => undefined);
    }
  }

  nav = await request(BILIBILI_API, NAV);
  if (!nav?.isLogin) throw new BilibiliError("bilibili_login_required", "请先登录当前 B 站账号。", 409);
  const mid = id(nav.mid, "当前账户 UID");
  const get = (route, params, { host = BILIBILI_API, signed = false } = {}) => request(host, route, params, { signed });

  async function post(route, form, { host = BILIBILI_API, query, signed = false } = {}) {
    const csrf = (await context.cookies(host)).find(cookie => cookie.name === "bili_jct")?.value;
    if (!csrf) throw new BilibiliError("bilibili_login_required", "当前登录缺少操作凭据，请重新登录 B 站。", 409);
    return request(host, route, query, { signed, form: { ...form, csrf, ...(host === MESSAGE ? { csrf_token: csrf } : {}) } });
  }

  async function videoId(video) {
    const data = await get("/x/web-interface/view", { bvid: video });
    if (!data?.aid) throw upstream();
    return id(data.aid, "视频 AV 号");
  }

  async function fetchSubtitle(reference) {
    let url;
    try { url = new URL(reference, BILIBILI_ORIGIN); } catch { throw upstream(); }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".hdslb.com") || url.port || url.username || url.password
      || !/^\/bfs\/(?:ai_)?subtitle\//u.test(url.pathname)) throw upstream();
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", Referer: `${BILIBILI_ORIGIN}/` },
        redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok || !response.body) throw upstream();
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) throw upstream();
        chunks.push(chunk);
      }
      const data = parseResponse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(data?.body)) throw upstream();
      return data.body;
    } catch {
      signal.throwIfAborted();
      throw upstream();
    }
  }

  return { mid, get, post, videoId, fetchSubtitle };
}

function prepareInteraction(input) {
  switch (input.action) {
    case "like": {
      const video = bvid(input.bvid);
      const like = enabled(input.enabled) ? "1" : "2";
      return ({ post }) => post("/x/web-interface/archive/like", { bvid: video, like });
    }
    case "follow": {
      const fid = id(input.mid, "UP 主 UID");
      const act = enabled(input.enabled) ? "1" : "2";
      return ({ post }) => post("/x/relation/modify", { fid, act, re_src: "11" });
    }
    case "comment": {
      const video = bvid(input.bvid);
      const message = text(input.text, "评论内容", 1000);
      const root = optionalId(input.root, "根评论 ID");
      const parent = optionalId(input.parent, "被回复评论 ID");
      if (parent && !root) throw invalid("回复楼中楼时需要根评论 ID。");
      return async ({ post, videoId }) => post("/x/v2/reply/add", {
        oid: await videoId(video), type: "1", message, ...(root ? { root, parent: parent ?? root } : {}),
      });
    }
    case "message": {
      const uid = id(input.uid, "收件人 UID");
      const content = text(input.text, "私信内容", 500);
      return ({ post, mid, deviceId }) => {
        if (uid === mid) throw invalid("不能给自己发送私信。");
        return post("/web_im/v1/web_im/send_msg", {
          "msg[sender_uid]": mid, "msg[receiver_id]": uid, "msg[receiver_type]": "1",
          "msg[msg_type]": "1", "msg[msg_status]": "0", "msg[content]": JSON.stringify({ content }),
          "msg[dev_id]": deviceId, "msg[new_face_version]": "0", "msg[timestamp]": String(Math.floor(Date.now() / 1000)),
          from_filework: "0", build: "0", mobi_app: "web",
        }, { host: MESSAGE, signed: true, query: { w_sender_uid: mid, w_receiver_id: uid } });
      };
    }
    default:
      throw invalid("action 须为 like、follow、comment 或 message。");
  }
}

function creatorData(input) {
  const member = { host: MEMBER };
  switch (input.panel) {
    case "overview":
      return ({ get }) => get("/x/web/index/stat", {}, member);
    case "audience":
      return async ({ get }) => {
        const [base, interests] = await Promise.all([get("/x/web/data/base", {}, member), get("/x/web/data/trend", {}, member)]);
        return { base, interests };
      };
    case "fans":
      return ({ get }) => get("/x/web/data/fan", {}, member);
    case "trend": {
      const metrics = ["play", "danmaku", "comment", "share", "coin", "favorite", "charge", "like"];
      const metric = choice(input.metric ?? "play", "趋势指标", metrics);
      return ({ get }) => get("/x/web/data/pandect", { type: metrics.indexOf(metric) + 1 }, member);
    }
    case "videos": {
      const page = pageOf(input);
      return ({ get }) => get("/x/web/data/archive/index", page, member);
    }
    case "video": {
      const video = bvid(input.bvid);
      return async ({ get, videoId }) => get("/x/web/data/archive", { aid: await videoId(video) }, member);
    }
    default:
      throw invalid("panel 须为 overview、audience、fans、trend、videos 或 video。");
  }
}

const webSign = { signed: true };
const messageHost = { host: MESSAGE };
const operations = {
  "/feed": input => {
    const fresh_idx = count(input.cursor, "推荐页游标", 1, 1000);
    const ps = count(input.pageSize, "每页数量", 20, 30);
    return ({ get }) => get("/x/web-interface/wbi/index/top/feed/rcmd", { fresh_type: 4, fresh_idx, fresh_idx_1h: fresh_idx, brush: fresh_idx, ps, feed_version: "V8" }, webSign);
  },
  "/search": input => {
    const keyword = text(input.keyword, "搜索词", 300);
    const search_type = choice(input.type ?? "video", "搜索类型", ["video", "bili_user", "live_room"]);
    const page = count(input.page, "页码", 1, 1000);
    return ({ get }) => get("/x/web-interface/wbi/search/type", { keyword, search_type, page }, webSign);
  },
  "/hot": input => {
    const kind = choice(input.kind ?? "search", "榜单类型", ["search", "popular", "ranking"]);
    if (kind === "search") {
      const limit = count(input.pageSize, "榜单条数", 20, 50);
      return ({ get }) => get("/x/web-interface/wbi/search/square", { limit }, webSign);
    }
    if (kind === "popular") {
      const page = pageOf(input);
      return ({ get }) => get("/x/web-interface/popular", page);
    }
    const rid = optionalId(input.region, "分区 ID") ?? "0";
    return ({ get }) => get("/x/web-interface/ranking/v2", { rid, type: "all" });
  },
  "/profile": input => {
    const mid = id(input.mid, "UP 主 UID");
    const page = pageOf(input);
    return async ({ get }) => {
      const [profile, videos] = await Promise.all([
        get("/x/space/wbi/acc/info", { mid }, webSign),
        get("/x/space/wbi/arc/search", { mid, ...page, order: "pubdate" }, webSign),
      ]);
      return { profile, videos };
    };
  },
  "/comments": input => {
    const video = bvid(input.bvid);
    const { pn, ps } = pageOf(input);
    const sort = choice(input.sort ?? "hot", "评论排序", ["hot", "time"]) === "hot" ? 2 : 0;
    return async ({ get, videoId }) => get("/x/v2/reply", { type: 1, oid: await videoId(video), sort, pn, ps });
  },
  "/comment-replies": input => {
    const video = bvid(input.bvid);
    const root = id(input.root, "根评论 ID");
    const page = pageOf(input);
    return async ({ get, videoId }) => get("/x/v2/reply/reply", { type: 1, oid: await videoId(video), root, ...page });
  },
  "/playback": input => {
    const video = bvid(input.bvid);
    const cid = id(input.cid, "分 P 的 CID");
    const qn = count(input.quality, "清晰度", 80, 127);
    return ({ get }) => get("/x/player/wbi/playurl", { bvid: video, cid, qn, fnval: 4048, fnver: 0, fourk: 1 }, webSign);
  },
  "/subtitles": input => {
    const video = bvid(input.bvid);
    const cid = id(input.cid, "分 P 的 CID");
    const language = input.language === undefined ? undefined : text(input.language, "字幕语言", 32);
    return async ({ get, fetchSubtitle }) => {
      const tracks = (await get("/x/player/wbi/v2", { bvid: video, cid }, webSign))?.subtitle?.subtitles;
      const items = Array.isArray(tracks) ? tracks : [];
      if (!language) return { tracks: items };
      const track = items.find(item => item?.lan === language);
      if (!track?.subtitle_url) throw new BilibiliError("bilibili_subtitle_not_found", "该分 P 没有这条字幕轨道。", 404);
      return { tracks: items, cues: await fetchSubtitle(track.subtitle_url) };
    };
  },
  "/live/playback": input => {
    const room_id = id(input.roomId, "直播间 ID");
    const qn = count(input.quality, "清晰度", 10000, 30000);
    return ({ get }) => get("/xlive/web-room/v2/index/getRoomPlayInfo", {
      room_id, qn, protocol: "0,1", format: "0,1,2", codec: "0,1,2", platform: "web", ptype: 8,
    }, { host: LIVE, signed: true });
  },
  "/live/following": input => {
    const { pn: page, ps: page_size } = pageOf({ ...input, pageSize: input.pageSize ?? 9 });
    return ({ get }) => get("/xlive/web-ucenter/user/following", { page, page_size, ignoreRecord: 1, hit_ab: true }, { host: LIVE });
  },
  "/history/read": input => {
    const kind = choice(input.kind ?? "all", "历史类型", ["all", "archive", "live", "article"]);
    const max = optionalId(input.max, "历史游标 max");
    const view_at = optionalId(input.viewAt, "历史游标 viewAt");
    const ps = count(input.pageSize, "每页数量", 20, 30);
    return ({ get }) => get("/x/web-interface/history/cursor", { type: kind === "all" ? undefined : kind, max, view_at, ps });
  },
  "/likes/recent": () => ({ get, mid }) => get("/x/space/like/video", { vmid: mid }),
  "/creator/data": creatorData,
  "/dm/sessions": input => {
    const end_ts = optionalId(input.before, "会话游标");
    return ({ get }) => get("/session_svr/v1/session_svr/get_sessions", {
      session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, build: 0, mobi_app: "web", end_ts,
    }, { ...messageHost, signed: true });
  },
  "/dm/messages": input => {
    const talker_id = id(input.uid, "会话对方 UID");
    const end_seqno = optionalId(input.before, "消息游标");
    const size = count(input.pageSize, "每页数量", 20, 30);
    return ({ get }) => get("/svr_sync/v1/svr_sync/fetch_session_msgs", {
      talker_id, session_type: 1, size, end_seqno, build: 0, mobi_app: "web",
    }, messageHost);
  },
  "/interact": prepareInteraction,
};

export function prepareBilibiliProtocol(route, body) {
  if (!Object.hasOwn(operations, route)) return null;
  if (body !== null && body !== undefined && (typeof body !== "object" || Array.isArray(body))) throw invalid("请求体须为 JSON 对象。");
  return operations[route](body ?? {});
}
