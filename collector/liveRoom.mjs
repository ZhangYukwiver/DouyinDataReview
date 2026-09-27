import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { pageNeedsVerification } from "./readOnlyPage.mjs";

// 工作台看直播：采集器在共享无头会话里开一个直播间标签页，只做三件事——
// 读直播间信息（拉流地址给工作台自己播）、听弹幕、别的都不碰。
// 不点任何东西，所以发弹幕、送礼、点赞这些在这里根本没有入口。

const ENTER_PATH = "/webcast/room/web/enter/";
const IM_FETCH_PATH = "/webcast/im/fetch/";
const MESSAGE_LIMIT = 300;
const ROOM_INFO_TIMEOUT_MS = 25_000;
// 工作台每秒来取一次弹幕；这么久没人来取，说明播放器没了，收掉标签页
const IDLE_CLOSE_MS = 30_000;
// 退出后等一会儿再收浏览器：换台、重试马上又要用，免得刚关就重开
const RELEASE_DELAY_MS = 10_000;
// 关注的人谁在播：抖音关注页顶上那一排用的同一个接口（GET，读的是登录账号的关注）
const FOLLOWING_URL = "https://www.douyin.com/webcast/web/feed/follow/?aid=6383&device_platform=webapp&channel=channel_pc_web&request_tag_from=web&scene=aweme_pc_follow_top";
const FOLLOWING_CACHE_MS = 30_000;

export class LiveRoomError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "LiveRoomError";
    this.code = code;
    this.status = status;
  }
}

/** live.douyin.com 的链接或纯数字房间号 → 房间号；认不出返回 null。 */
export function liveRoomIdFrom(value) {
  const text = String(value ?? "").trim();
  if (/^\d{1,20}$/u.test(text)) return text;
  try {
    const url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
    return url.hostname === "live.douyin.com" ? /^\/(\d{1,20})\/?$/u.exec(url.pathname)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

// ---- protobuf：只认用得到的几个字段，线格式手解，不引依赖 ----

function readFields(bytes) {
  const fields = [];
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (offset >= bytes.length || shift > 63n) throw new RangeError("bad varint");
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  };
  while (offset < bytes.length) {
    const key = varint();
    const number = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) fields.push([number, varint()]);
    else if (wire === 2) {
      const length = Number(varint());
      if (offset + length > bytes.length) throw new RangeError("bad length");
      fields.push([number, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new RangeError("bad fixed");
    } else throw new RangeError("bad wire type");
  }
  return fields;
}

const field = (fields, number) => fields.find(([key]) => key === number)?.[1];
const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : "";
const count = (value) => typeof value === "bigint" ? Number(value) : null;
const nested = (value) => Buffer.isBuffer(value) ? readFields(value) : [];

function liveEvent(method, payload) {
  if (!Buffer.isBuffer(payload)) return null;
  if (method === "WebcastChatMessage" || method === "WebcastEmojiChatMessage") {
    const fields = readFields(payload);
    // 普通弹幕的正文在 3；表情弹幕在 5，是 [比心] 这样的文字代码
    const content = text(field(fields, method === "WebcastChatMessage" ? 3 : 5)).trim();
    if (!content) return null;
    const common = nested(field(fields, 1));
    return {
      type: "chat",
      id: String(field(common, 2) ?? ""),
      roomId: String(field(common, 3) ?? ""),
      user: text(field(nested(field(fields, 2)), 3)),
      text: content,
    };
  }
  if (method === "WebcastRoomUserSeqMessage") return { type: "online", value: count(field(readFields(payload), 3)) };
  if (method === "WebcastLikeMessage") return { type: "likes", value: count(field(readFields(payload), 3)) };
  // 状态 3 = 主播下播
  if (method === "WebcastControlMessage") return count(field(readFields(payload), 2)) === 3 ? { type: "ended" } : null;
  return null;
}

/** im/fetch 的响应体本身就是这一层：一串 { method, payload }。 */
export function decodeLiveMessages(response) {
  const events = [];
  for (const [number, message] of readFields(response)) {
    if (number !== 1 || !Buffer.isBuffer(message)) continue;
    const fields = readFields(message);
    const event = liveEvent(text(field(fields, 1)), field(fields, 2));
    if (event) events.push(event);
  }
  return events;
}

/** WebSocket 的一帧：外面包一层 PushFrame，payload 一般 gzip 过；心跳帧没有消息。 */
export function decodeLiveFrame(frame) {
  const fields = readFields(frame);
  if (text(field(fields, 7)) !== "msg") return [];
  const payload = field(fields, 8);
  if (!Buffer.isBuffer(payload)) return [];
  return decodeLiveMessages(payload[0] === 0x1f && payload[1] === 0x8b ? gunzipSync(payload) : payload);
}

// ---- 直播间信息 ----

const httpsUrl = (value) => typeof value === "string" && /^https?:\/\//iu.test(value) ? value.replace(/^http:/iu, "https:") : null;

export function normalizeLiveRoom(payload, webRid) {
  const room = payload?.data?.data?.[0];
  if (!room || typeof room !== "object") return null;
  const owner = room.owner ?? payload.data.user ?? {};
  const pull = room.stream_url?.live_core_sdk_data?.pull_data;
  let qualities = [];
  try {
    const streams = JSON.parse(pull.stream_data).data;
    qualities = pull.options.qualities
      .map((quality) => ({ key: String(quality.sdk_key), name: String(quality.name), level: Number(quality.level) || 0, url: httpsUrl(streams[quality.sdk_key]?.main?.hls) }))
      .filter((quality) => quality.url)
      .sort((left, right) => right.level - left.level)
      .map(({ key, name, url }) => ({ key, name, url }));
  } catch {
    // ponytail: 清晰度表拿不到时只给一档默认地址，够看；要细分再去读 hls_pull_url_map
    const url = httpsUrl(room.stream_url?.hls_pull_url);
    if (url) qualities = [{ key: "default", name: "默认", url }];
  }
  const defaultKey = pull?.options?.default_quality?.sdk_key;
  return {
    webRid,
    roomId: String(room.id_str ?? ""),
    // 2 是正在播，4 是已下播；下播的直播间没有拉流地址
    live: room.status === 2 && qualities.length > 0,
    title: String(room.title ?? ""),
    anchor: {
      name: String(owner.nickname ?? ""),
      avatar: httpsUrl(owner.avatar_thumb?.url_list?.[0]),
      secUid: typeof owner.sec_uid === "string" ? owner.sec_uid : null,
    },
    cover: httpsUrl(room.cover?.url_list?.[0]),
    online: Number.isFinite(room.room_view_stats?.display_value) ? room.room_view_stats.display_value : null,
    likes: Number.isFinite(room.like_count) ? room.like_count : null,
    qualities,
    defaultQuality: qualities.some((quality) => quality.key === defaultKey) ? defaultKey : qualities.at(-1)?.key ?? null,
  };
}

/** 关注的人正在播的直播间；格式不对返回 null。条目里的直播间对象和进房接口里的一样。 */
export function normalizeFollowingLive(payload) {
  const list = payload?.data?.data;
  if (payload?.status_code !== 0 || !Array.isArray(list)) return null;
  return list.flatMap((item) => {
    // 关注页那个 POST 接口把直播间放在 data 里，这个 GET 放在 room 里
    const room = item?.room ?? item?.data;
    const webRid = String(item?.web_rid ?? room?.owner?.web_rid ?? "");
    if (!room || typeof room !== "object" || !/^\d{1,20}$/u.test(webRid) || (room.status ?? 2) !== 2) return [];
    const online = room.room_view_stats?.display_short ?? room.user_count_str;
    return [{
      webRid,
      title: String(room.title ?? ""),
      anchor: { name: String(room.owner?.nickname ?? ""), avatar: httpsUrl(room.owner?.avatar_thumb?.url_list?.[0]) },
      cover: httpsUrl(room.cover?.url_list?.[0]),
      online: online ? String(online).replace(/w/giu, "万") : null,
      tag: item.tag_name ? String(item.tag_name) : null,
    }];
  });
}

// ---- 标签页 ----

export class LiveRooms {
  constructor(collector) {
    this.collector = collector;
    this.rooms = new Map();
    // 进房和收浏览器排同一个队：新的浏览器不能在旧的还没关完时起
    this.queue = Promise.resolve();
    this.releaseTimer = null;
    this.followingCache = null;
  }

  get size() {
    return this.rooms.size;
  }

  async open(input) {
    const webRid = liveRoomIdFrom(input);
    if (!webRid) throw new LiveRoomError("invalid_room", "认不出这个直播间，请粘贴 live.douyin.com 的链接或房间号。", 400);
    // 快速换台时上一个可能还在进房：先关掉它的页面让它尽快收尾，再排队进新的，免得两边同时去起浏览器
    for (const room of this.rooms.values()) void room.page.close().catch(() => {});
    clearTimeout(this.releaseTimer);
    const entered = this.queue.then(() => this.enter(webRid));
    this.queue = entered.catch(() => {});
    return entered;
  }

  async following({ refresh = false } = {}) {
    if (!refresh && this.followingCache && Date.now() - this.followingCache.at < FOLLOWING_CACHE_MS) return this.followingCache.list;
    clearTimeout(this.releaseTimer);
    const work = this.queue.then(() => this.readFollowing());
    this.queue = work.catch(() => {});
    try {
      return await work;
    } finally {
      this.scheduleRelease();
    }
  }

  async readFollowing() {
    const collector = this.collector;
    if (collector.visibleBrowserWorkRunning()) throw new LiveRoomError("collector_busy", "采集器正在用浏览器读取记录，读完就能看到关注的人谁在播。");
    const context = await collector.ensureBrowser({ headless: true });
    if (!await collector.hasLoginSession(context, null)) throw new LiveRoomError("login_required", "登录抖音以后，才能看到关注的人谁在播。");
    const page = await context.newPage();
    try {
      // 在一个空白的同源页面里带着登录 cookie 读：不加载抖音页面，不进任何直播间，也不用页面签名（09-27 实测同族接口不签名结果一致）
      await page.goto("https://www.douyin.com/robots.txt", { waitUntil: "domcontentloaded", timeout: 20_000 });
      const payload = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        return response.ok ? response.json().catch(() => null) : null;
      }, FOLLOWING_URL);
      const list = normalizeFollowingLive(payload);
      if (!list) throw new LiveRoomError("following_unavailable", "没读到关注的人的直播，请稍后重试。", 502);
      this.followingCache = { at: Date.now(), list };
      return list;
    } catch (error) {
      if (error instanceof LiveRoomError) throw error;
      throw new LiveRoomError("following_unavailable", "没读到关注的人的直播，请检查网络后重试。", 502);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async enter(webRid) {
    // 播放器同一时间只看一个直播间，换台就把上一个收掉（会话留着给新的用）
    await this.closeAll({ release: false });
    const collector = this.collector;
    if (collector.visibleBrowserWorkRunning()) throw new LiveRoomError("collector_busy", "采集器正在用浏览器读取记录，读完就能看直播。");
    const context = await collector.ensureBrowser({ headless: true });
    const page = await context.newPage();
    const room = {
      id: randomUUID(), webRid, page, info: null, messages: [], seen: new Set(), seq: 0,
      online: null, likes: null, ended: false, lastRead: Date.now(), timer: null,
    };
    this.rooms.set(room.id, room);
    page.on("close", () => this.forget(room));
    page.on("crash", () => void this.close(room.id));
    try {
      await prepareLivePage(page);
      let resolveInfo;
      const infoReady = new Promise((resolve) => { resolveInfo = resolve; });
      page.once("close", () => resolveInfo(null));
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.hostname !== "live.douyin.com") return;
        if (url.pathname === ENTER_PATH && url.searchParams.get("web_rid") === webRid) {
          void response.json().then((payload) => {
            const info = normalizeLiveRoom(payload, webRid);
            if (!info) return;
            room.info = info;
            room.online ??= info.online;
            room.likes ??= info.likes;
            resolveInfo(info);
          }).catch(() => {});
        } else if (url.pathname === IM_FETCH_PATH && /protobuf/iu.test(response.headers()["content-type"] ?? "")) {
          // 进房时这一下会带回最近几条弹幕，免得一开始是空的
          void response.body().then((body) => this.ingest(room, decodeLiveMessages(body))).catch(() => {});
        }
      });
      page.on("websocket", (socket) => {
        if (!/\/webcast\/im\/push\//u.test(socket.url())) return;
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload === "string") return;
          try { this.ingest(room, decodeLiveFrame(payload)); } catch { /* 坏帧跳过 */ }
        });
      });
      await page.goto(`https://live.douyin.com/${webRid}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {
        throw new LiveRoomError("page_load_failed", "直播间页面没打开，请检查网络后重试。", 504);
      });
      // 这页没人看，不画出来：脚本和弹幕连接照跑，渲染和合成省掉一大半
      await page.addStyleTag({ content: "html{display:none!important}" }).catch(() => {});
      let timeout;
      const info = await Promise.race([infoReady, new Promise((resolve) => { timeout = setTimeout(resolve, ROOM_INFO_TIMEOUT_MS, null); })]);
      clearTimeout(timeout);
      if (!info) {
        if (await pageNeedsVerification(page)) throw new LiveRoomError("verification_required", "抖音要求验证，请先在「连接与采集」里用手动监听打开一次抖音完成验证。");
        throw new LiveRoomError("room_unavailable", "没读到这个直播间的信息，请稍后重试。", 504);
      }
      room.timer = setInterval(() => {
        if (Date.now() - room.lastRead > IDLE_CLOSE_MS) void this.close(room.id);
      }, 10_000);
      room.timer.unref?.();
      return this.snapshot(room, -1);
    } catch (error) {
      await this.close(room.id);
      throw error;
    }
  }

  ingest(room, events) {
    for (const event of events) {
      // 页面万一跳到了别的直播间，那边的消息不算
      if (event.roomId && room.info?.roomId && event.roomId !== room.info.roomId) continue;
      if (event.type === "online" && event.value !== null) room.online = event.value;
      else if (event.type === "likes" && event.value !== null) room.likes = event.value;
      else if (event.type === "ended") room.ended = true;
      else if (event.type === "chat") {
        if (event.id && room.seen.has(event.id)) continue;
        if (event.id) room.seen.add(event.id);
        room.messages.push({ seq: ++room.seq, user: event.user, text: event.text });
        if (room.messages.length > MESSAGE_LIMIT) room.messages.splice(0, room.messages.length - MESSAGE_LIMIT);
        if (room.seen.size > MESSAGE_LIMIT * 4) room.seen = new Set([...room.seen].slice(-MESSAGE_LIMIT));
      }
    }
  }

  snapshot(room, after) {
    return {
      id: room.id,
      room: room.info,
      online: room.online,
      likes: room.likes,
      ended: room.ended,
      cursor: room.seq,
      messages: room.messages.filter((message) => message.seq > after),
    };
  }

  read(id, after) {
    const room = this.rooms.get(id);
    if (!room || room.page.isClosed()) throw new LiveRoomError("session_expired", "和直播间的连接断了，请重新进入。", 410);
    room.lastRead = Date.now();
    return this.snapshot(room, Number.isSafeInteger(after) ? after : -1);
  }

  forget(room) {
    clearInterval(room.timer);
    if (this.rooms.get(room.id) === room) this.rooms.delete(room.id);
  }

  async close(id, { release = true } = {}) {
    const room = this.rooms.get(id);
    if (!room) return false;
    this.forget(room);
    await room.page.close().catch(() => {});
    if (release) this.scheduleRelease();
    return true;
  }

  scheduleRelease() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => { this.queue = this.queue.then(() => this.releaseIfIdle()).catch(() => {}); }, RELEASE_DELAY_MS);
    this.releaseTimer.unref?.();
  }

  // 这个无头会话要是只为看直播开的，看完就收掉；聊天、读取、探索还开着页面就留着
  async releaseIfIdle() {
    const context = this.collector.context;
    if (this.rooms.size || !context || !this.collector.contextHeadless) return;
    if (context.pages().some((page) => !page.isClosed() && page.url() !== "about:blank")) return;
    await this.collector.releaseHeadlessContextIfIdle();
  }

  async closeAll(options) {
    for (const id of [...this.rooms.keys()]) await this.close(id, options);
  }
}

/**
 * 画面由工作台自己拉流播放，这个标签页里的播放器不必再下一份；图片、礼物特效包、活动小程序也没人看。
 * ponytail: 实测（09-27）这样开着一个直播页约占 1/3 个核（只拦拉流时约 60%）；要再省就得拿页面签好的
 * 弹幕地址在 Node 里自己连，替页面回 ack 和心跳，然后关掉页面。
 */
async function prepareLivePage(page) {
  const network = await page.context().newCDPSession(page);
  // 还没跑过完整读取时，共享会话用的是无头默认 UA；带 HeadlessChrome 的直播间不连弹幕
  const userAgent = await page.evaluate(() => navigator.userAgent);
  if (userAgent.includes("HeadlessChrome")) await network.send("Emulation.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") });
  network.on("Fetch.requestPaused", ({ requestId }) => {
    void network.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  await network.send("Fetch.enable", {
    patterns: [
      ...["*://pull-*", "*.flv*", "*.m3u8*", "*.zip*", "*bytegecko.com*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
      { urlPattern: "*", resourceType: "Image", requestStage: "Request" },
    ],
  });
}
