import { createHash, randomInt } from "node:crypto";
import { gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { DirectHistoryError } from "./directHistory.mjs";
import { decodeProto, encodeProto, protoBytes, protoInteger, protoNumber, protoText, protoString } from "./directProto.mjs";

const ORIGIN = "https://live.douyin.com";
const MAX_BYTES = 4 * 1024 * 1024;
const md5 = (value) => createHash("md5").update(value).digest();
const fail = (code, message) => { throw new DirectHistoryError(code, message); };
const numericId = (value) => /^[1-9]\d{0,19}$/u.test(String(value ?? ""));

// Wire protocol references (not a downloaded runtime):
// cv-cat/DouYin_Spider/dy_live/server.py, static/Live.proto and utils/xbogus_pure.py.
// The webcast signature authenticates the room/audience query; it does not
// solve CAPTCHA, obtain login cookies or replace the logged-in account session.
export function signLivePush(roomId, userId, { counter = 0, nonce = randomInt(0x1000000) } = {}) {
  if (!numericId(roomId) || !numericId(userId) || !Number.isSafeInteger(counter) || counter < 0
    || !Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffff) fail("invalid_room", "直播间连接参数无效。");
  const stub = md5(`live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.15,room_id=${roomId},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=${userId},device_platform=web,device_type=,ac=,identity=audience`);
  const emptyHash = md5(md5("")), queryHash = md5(stub);
  const plain = Buffer.from([(counter + 1) & 63, ((counter + 1) >>> 8) & 255, 9, 12,
    emptyHash[14], emptyHash[15], queryHash[14], queryHash[15], (nonce >>> 8) & 255, 0]);
  plain[9] = plain.subarray(0, 9).reduce((xor, byte) => xor ^ byte, 0);
  const key = nonce & 255, box = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let index = 0, swap = 0; index < 256; index += 1) {
    swap = (swap + box[index] + key) & 255;
    [box[index], box[swap]] = [box[swap], box[index]];
  }
  for (let offset = 0, index = 0, swap = 0; offset < plain.length; offset += 1) {
    index = (index + 1) & 255; swap = (swap + box[index]) & 255;
    [box[index], box[swap]] = [box[swap], box[index]];
    plain[offset] ^= box[(box[index] + box[swap]) & 255];
  }
  const frame = Buffer.concat([Buffer.from([64 | ((nonce >>> 16) & 1) * 16, key]), plain]);
  const alphabet = "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe";
  const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return [...frame.toString("base64")].map(char => char === "=" ? char : alphabet[standard.indexOf(char)]).join("");
}

export function decodeLiveResponse(bytes) {
  if (bytes.length > MAX_BYTES) fail("response_too_large", "直播消息超过读取容量。");
  const fields = decodeProto(bytes);
  return { bytes, cursor: protoText(fields, 2), internalExt: protoText(fields, 5),
    heartbeatMs: Number(protoInteger(fields, 8)) || 5_000, needAck: protoInteger(fields, 9) === "1", pushServer: protoText(fields, 10) };
}

export function decodeLivePush(frame) {
  if (frame.length > MAX_BYTES) fail("response_too_large", "直播消息超过读取容量。");
  const fields = decodeProto(frame);
  if (protoText(fields, 7) !== "msg") return null;
  const payload = fields.find(([number, item]) => number === 8 && item.wire === 2)?.[1].value;
  if (!payload) return null;
  const bytes = payload[0] === 0x1f && payload[1] === 0x8b ? gunzipSync(payload, { maxOutputLength: MAX_BYTES }) : payload;
  const response = decodeLiveResponse(bytes);
  return { ...response, logId: protoInteger(fields, 2) ?? "0" };
}

export const liveHeartbeat = () => encodeProto([protoString(7, "hb")]);
export const liveAcknowledgement = (response) => encodeProto([
  protoNumber(2, response.logId), protoString(7, "ack"), protoBytes(8, response.internalExt),
]);

export function liveBrowserParameters(session) {
  return { device_platform: "web", cookie_enabled: "true", screen_width: session.values.screen_width || "1440",
    screen_height: session.values.screen_height || "900", browser_language: "zh-CN",
    browser_platform: session.values.browser_platform || (/Windows/u.test(session.userAgent) ? "Win32" : "MacIntel"),
    browser_name: "Mozilla", browser_version: session.userAgent.replace(/^Mozilla\//u, ""), browser_online: "true", tz_name: "Asia/Shanghai" };
}

export function buildLivePushUrl(response, { roomId, userId, session, counter = 0 }) {
  let url;
  try { url = new URL(response.pushServer); } catch { /* validated below */ }
  if (!url || url.protocol !== "wss:" || !/^webcast\d+-ws-web-[a-z0-9-]+\.douyin\.com$/u.test(url.hostname)
    || !/^\/webcast\/im\/push\/v[23]\/$/u.test(url.pathname) || url.port || url.username || url.password || url.hash)
    fail("unsafe_url", "直播消息服务器地址不在允许范围内。");
  url.search = new URLSearchParams({ app_name: "douyin_web", version_code: "180800", webcast_sdk_version: "1.0.15",
    update_version_code: "1.0.15", compress: "gzip", ...liveBrowserParameters(session), cursor: response.cursor,
    internal_ext: response.internalExt, host: ORIGIN, aid: "6383", live_id: "1", did_rule: "3", endpoint: "live_pc", support_wrds: "1",
    user_unique_id: String(userId), im_path: "/webcast/im/fetch/", identity: "audience", need_persist_msg_count: "15", insert_task_id: "",
    live_reason: "", room_id: String(roomId), heartbeatDuration: "0", signature: signLivePush(roomId, userId, { counter }) }).toString();
  return url;
}

/** HTTP room bootstrap + native WebSocket. Only heartbeat/ack frames can be sent. */
export class DirectLiveClient {
  constructor(api, { socketFactory = (url, options) => new WebSocket(url, options),
    onResponse = () => {}, onClose = () => {}, refreshApi, reconnectDelayMs = 1_000, handshakeTimeoutMs = 15_000 } = {}) {
    this.api = api; this.socketFactory = socketFactory; this.onResponse = onResponse; this.onClose = onClose;
    this.reconnectDelayMs = reconnectDelayMs; this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.refreshApi = refreshApi;
    this.controller = new AbortController(); this.socket = null; this.closed = false; this.ended = false;
    this.heartbeat = null; this.reconnectTimer = null; this.reconnectAttempts = 0; this.counter = 0;
    this.metrics = { connections: 0, frames: 0, acknowledgements: 0, heartbeats: 0, malformedFrames: 0, reconnects: 0 };
  }
  async enter(webRid) {
    if (!numericId(webRid)) fail("invalid_room", "直播间房间号无效。");
    this.webRid = webRid;
    const url = new URL("/webcast/room/web/enter/", ORIGIN);
    url.search = new URLSearchParams({ aid: "6383", app_name: "douyin_web", live_id: "1", language: "zh-CN", enter_from: "link_share",
      ...liveBrowserParameters(this.api.session), web_rid: webRid, msToken: this.api.session.security?.msToken || this.api.cookie("msToken") }).toString();
    const response = await this.api.raw(url.href, { referer: `${ORIGIN}/${webRid}`, signal: this.controller.signal });
    if (response.text.trim() === "blocked") fail("verification_required", "抖音要求验证，请在专用浏览器完成后重试。");
    let payload;
    try { payload = JSON.parse(response.text); } catch { fail("room_unavailable", "直播间没有返回有效资料。"); }
    if (payload.status_code === 8) fail("login_required", "抖音登录已失效，请重新登录。");
    if (payload.status_code !== 0) fail("room_unavailable", "抖音暂未提供直播间资料。");
    this.roomId = String(payload.data?.data?.[0]?.id_str ?? "");
    if (!numericId(this.roomId)) fail("room_unavailable", "直播间资料缺少房间编号。");
    return payload;
  }
  async start() {
    // The live service gives this session an audience ID in SSR. It differs
    // from the account UID, so neither an invented ID nor session.uid is used.
    const landing = await this.api.raw(`${ORIGIN}/${this.webRid}`, { referer: `${ORIGIN}/`, signal: this.controller.signal,
      headers: { Accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    const html = landing.text.replace(/\\"/gu, '"');
    this.userId = /"user_unique_id"\s*:\s*"(\d+)"/u.exec(html)?.[1];
    const roomId = /"roomId"\s*:\s*"(\d+)"/u.exec(html)?.[1];
    if (!numericId(this.userId) || roomId !== this.roomId) fail("room_unavailable", "直播页面身份或房间编号不一致，已停止连接。");
    const response = await this.fetch();
    if (!this.ended) await this.connect(response);
  }
  async fetch() {
    const url = new URL("/webcast/im/fetch/", ORIGIN);
    url.search = new URLSearchParams({ resp_content_type: "protobuf", did_rule: "3", device_id: "", app_name: "douyin_web", endpoint: "live_pc",
      support_wrds: "1", user_unique_id: this.userId, identity: "audience", need_persist_msg_count: "15", insert_task_id: "", live_reason: "",
      room_id: this.roomId, version_code: "180800", last_rtt: "0", live_id: "1", aid: "6383", fetch_rule: "1", cursor: "", internal_ext: "",
      ...liveBrowserParameters(this.api.session), msToken: this.api.session.security?.msToken || this.api.cookie("msToken") }).toString();
    const result = await this.api.raw(url.href, { referer: `${ORIGIN}/${this.webRid}`, signal: this.controller.signal,
      headers: { Accept: "application/x-protobuf", Origin: ORIGIN } });
    if (result.text.trim() === "blocked") fail("verification_required", "直播消息接口要求安全验证，请在专用浏览器完成后重试。");
    const response = decodeLiveResponse(result.buffer);
    this.onResponse(response.bytes);
    return response;
  }
  async connect(response) {
    this.controller.signal.throwIfAborted();
    const url = buildLivePushUrl(response, { roomId: this.roomId, userId: this.userId, session: this.api.session, counter: this.counter++ });
    const cookies = await this.api.cookies(url.href.replace(/^wss:/u, "https:"));
    this.controller.signal.throwIfAborted();
    const socket = this.socketFactory(url.href, { headers: { "User-Agent": this.api.session.userAgent, Origin: ORIGIN,
      Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), "Accept-Language": "zh-CN,zh;q=0.9" },
      maxPayload: MAX_BYTES, handshakeTimeout: this.handshakeTimeoutMs, followRedirects: false });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let opened = false, settled = false;
      const abort = () => finish(this.controller.signal.reason);
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); this.controller.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => { finish(new DirectHistoryError("live_connection_failed", "直播消息连接超时，请重试。")); socket.terminate(); }, this.handshakeTimeoutMs);
      this.controller.signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => {
        if (this.closed || this.socket !== socket) { socket.close(); return; }
        opened = true; this.metrics.connections += 1;
        const duration = Math.min(10_000, Math.max(1_000, response.heartbeatMs));
        this.send(liveHeartbeat(), "heartbeats");
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send(liveHeartbeat(), "heartbeats"), duration);
        this.heartbeat.unref?.(); finish();
      });
      socket.on("message", (data, binary) => {
        if (!binary || this.closed || this.socket !== socket) return;
        try {
          const pushed = decodeLivePush(Buffer.from(data));
          if (!pushed) return;
          this.metrics.frames += 1; this.reconnectAttempts = 0;
          if (pushed.needAck) this.send(liveAcknowledgement(pushed), "acknowledgements");
          this.onResponse(pushed.bytes);
        } catch { this.metrics.malformedFrames += 1; }
      });
      socket.on("error", () => { if (!opened) finish(new DirectHistoryError("live_connection_failed", "直播消息连接失败，请检查网络或登录验证后重试。")); });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        clearInterval(this.heartbeat); this.heartbeat = null; this.socket = null;
        if (!opened) finish(new DirectHistoryError("live_connection_failed", "直播消息连接被关闭，请重试。"));
        if (opened && !this.closed && !this.ended) this.scheduleReconnect();
      });
    });
  }
  send(bytes, metric) {
    const socket = this.socket;
    if (!this.closed && socket?.readyState === WebSocket.OPEN) {
      socket.send(bytes, { binary: true }, error => { if (error && !this.closed) socket.terminate(); });
      this.metrics[metric] += 1;
    }
  }
  scheduleReconnect() {
    if (this.closed || this.ended || this.reconnectTimer) return;
    if (++this.reconnectAttempts > 3) { this.close(); this.onClose(); return; }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        this.metrics.reconnects += 1;
        if (this.refreshApi) this.api = await this.refreshApi({ signal: this.controller.signal });
        const response = await this.fetch();
        if (!this.ended) await this.connect(response);
      } catch (error) {
        if (this.closed) return;
        if (["verification_required", "login_required", "session_rejected", "rate_limited", "unsafe_url"].includes(error.code)) { this.close(); this.onClose(); }
        else this.scheduleReconnect();
      }
    }, this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer.unref?.();
  }
  end() { this.ended = true; this.close(); }
  close() {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    clearTimeout(this.reconnectTimer); clearInterval(this.heartbeat);
    this.reconnectTimer = null; this.heartbeat = null;
    const socket = this.socket; this.socket = null;
    if (socket?.readyState === WebSocket.OPEN) { socket.close(); socket.terminate(); }
    else socket?.terminate();
  }
}
