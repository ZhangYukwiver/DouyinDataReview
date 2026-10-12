import { createHash, randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { DIRECT_IM_PATHS, DirectHistoryError } from "./directHistory.mjs";
import { directSecurityHeaders, requireDirectCredentials } from "./directCredentials.mjs";
import { signDirectRequest, parseDirectJson } from "./directWrites.mjs";
import { decodeProto, encodeProto, protoNumber as n, protoString as s, protoMessage as m, protoMapEntry as kv,
  protoField, protoText, protoInteger, protoChild, protoChildren } from "./directProto.mjs";
import { normalizeChatPayload, normalizeChatSocketPayload } from "./chatNormalizer.mjs";
import { normalizeStreaks } from "./chatViewer.mjs";
import { ChatSendError, validateChatSend } from "./chatSender.mjs";

export function buildDirectImRequest(session, command, body, { sequence = randomInt(10_000, 1_000_000), headers = {} } = {}) {
  const values = session.values || {};
  const map = { session_aid: "6383", session_did: "0", app_name: "douyin_pc", priority_region: "cn", user_agent: session.userAgent,
    cookie_enabled: "true", browser_language: values.browser_language || "zh-CN", browser_platform: values.browser_platform || "MacIntel",
    browser_name: "Mozilla", browser_version: session.userAgent.replace(/^Mozilla\//u, ""), browser_online: "true",
    screen_width: values.screen_width || "1920", screen_height: values.screen_height || "1080", referer: "https://www.douyin.com/jingxuan",
    timezone_name: "Asia/Shanghai", deviceId: "0", "is-retry": "0", ...headers };
  const writing = command === 100;
  return encodeProto([n(1, command), n(2, sequence), s(3, "0.1.8"), s(4, ""), n(5, 3), n(6, writing ? 0 : 1), s(7, "0d50935:feat/pc-im-group"),
    m(8, body), s(9, "0"), s(11, "douyin_pc"), s(14, "360000"), ...Object.entries(map).map(([key, value]) => kv(15, key, value)),
    n(18, 1), s(21, "douyin_web"), s(22, "web_sdk")]);
}

export function parseDirectConversation(fields) {
  const id = protoText(fields, 1), shortId = protoInteger(fields, 2), type = Number(protoInteger(fields, 3));
  if (!/^[\w:.-]{1,200}$/u.test(id) || !/^\d{1,30}$/u.test(shortId || "") || ![1, 2].includes(type)) return null;
  const core = protoChild(fields, 50);
  const ext = Object.fromEntries(protoChildren(core, 11).map((entry) => [protoText(entry, 1), protoText(entry, 2)]));
  return { id, shortId, type, ticket: protoText(fields, 4), kind: type === 1 ? "friend" : "group", name: protoText(core, 5) || null, ext };
}

export class DirectChatClient {
  constructor(api, { socketFactory = (url, options) => new WebSocket(url, ["binary", "base64", "pbbp2"], options) } = {}) {
    this.api = api; this.socketFactory = socketFactory; this.conversations = new Map(); this.messagePages = new Map();
    this.identity = null; this.socket = null; this.controller = null;
  }
  async request(pathname, command, body, { signal, headers, onDispatch = () => {} } = {}) {
    if (!DIRECT_IM_PATHS.has(pathname)) throw new DirectHistoryError("unsafe_url", "消息请求不在允许的接口内。");
    const security = requireDirectCredentials(this.api.session);
    const url = new URL(pathname, "https://imapi.douyin.com");
    url.search = new URLSearchParams({ verifyFp: this.api.cookie("s_v_web_id"), fp: this.api.cookie("s_v_web_id"),
      msToken: security.msToken || this.api.cookie("msToken") }).toString();
    const writing = command === 100;
    const signed = writing ? await signDirectRequest(this.api, url)
      : `${url.origin}${url.pathname}`;
    const bodyBytes = buildDirectImRequest(this.api.session, command, body, { headers });
    const auth = writing ? directSecurityHeaders(this.api.session, pathname) : {};
    delete auth["x-secsdk-csrf-token"];
    onDispatch();
    const response = await this.api.raw(signed, { method: "POST", body: bodyBytes, contentType: "application/x-protobuf", signal,
      referer: "https://www.douyin.com/", headers: { ...auth, Accept: "application/x-protobuf", Origin: "https://www.douyin.com" } });
    if (!response.buffer?.length || response.text?.trim() === "blocked") throw new DirectHistoryError("verification_required", "消息接口要求安全验证，请在登录窗口完成后重试。");
    const fields = decodeProto(response.buffer);
    const status = protoInteger(fields, 3);
    if (protoInteger(fields, 1) !== String(command)) throw new DirectHistoryError("schema_changed", "消息接口回执类型不一致。");
    if ((status && status !== "0") || (protoField(fields, 3)?.wire === 2 && protoText(fields, 3)))
      { const error = new DirectHistoryError("platform_rejected", "抖音没有接收本次消息请求。"); error.platformStatus = status; throw error; }
    return { fields, buffer: response.buffer, body: protoChild(fields, 6) };
  }
  acceptConversations(section, initial = false) {
    const accepted = new Set();
    const infos = initial ? protoChildren(section, 1).map((entry) => protoChild(entry, 1)) : protoChildren(section, 1);
    for (const fields of infos) {
      const conversation = parseDirectConversation(fields);
      if (conversation) {
        accepted.add(conversation.id);
        const previous = this.conversations.get(conversation.id);
        this.conversations.set(conversation.id, { ...previous, ...conversation, name: conversation.name || previous?.name || null });
      }
    }
    return accepted;
  }
  async initialize({ signal, onPayload = () => {}, onProgress = () => {} } = {}) {
    await this.api.verifyIdentity(this.api.session.uid, signal);
    let cursor = null; const seen = new Set();
    for (let page = 0; page < 10_000; page += 1) {
      signal?.throwIfAborted();
      if (seen.has(cursor)) throw new DirectHistoryError("pagination_stalled", "聊天初始化游标重复，已保留读取到的消息。");
      seen.add(cursor);
      const response = await this.request("/v1/message/get_message_by_init", 2043, [m(2043, [...(cursor ? [n(1, cursor)] : []), n(2, page)])], { signal });
      const section = protoChild(response.body, 2043);
      this.acceptConversations(section, true);
      const normalized = normalizeChatPayload(response.buffer, { endpoint: { kind: "chat_messages", pathname: "/v1/message/get_message_by_init" } });
      await onPayload(normalized); onProgress({ pages: page + 1, conversations: this.conversations.size });
      if (typeof normalized.hasMore !== "boolean") throw new DirectHistoryError("pagination_missing", "聊天初始化缺少分页状态。");
      if (!normalized.hasMore) return [...this.conversations.values()];
      if (!/^\d{1,30}$/u.test(normalized.nextTimestamp || "")) throw new DirectHistoryError("pagination_missing", "聊天初始化缺少下一页游标。");
      cursor = normalized.nextTimestamp; await delay(200, undefined, { signal });
    }
    throw new DirectHistoryError("record_limit", "聊天初始化达到读取容量，已保留读取到的消息。");
  }
  async refreshConversation(id, { signal } = {}) {
    const refreshed = await this.refreshConversations([id], { signal });
    if (!refreshed.has(id)) throw new ChatSendError("conversation_unavailable", "抖音未返回这个会话的最新资料，请刷新聊天后重试。", 410);
    return this.conversations.get(id);
  }
  async refreshConversations(ids, { signal } = {}) {
    const refreshed = new Set();
    const list = ids.map(id=>{
    const conversation = this.conversations.get(id);
    if (!conversation) throw new ChatSendError("conversation_unavailable", "当前账号找不到这个会话，请刷新聊天后重试。", 410);
      return conversation;
    });
    for (let offset = 0; offset < list.length; offset += 50) {
    const response = await this.request("/v2/conversation/get_info_list", 610,
        [m(610, list.slice(offset, offset + 50).map(conversation=>m(1, [s(1, conversation.id), n(2, conversation.shortId), n(3, conversation.type)])))], { signal });
      for (const id of this.acceptConversations(protoChild(response.body, 610))) refreshed.add(id);
    }
    return refreshed;
  }
  async messages({ conversationId, older = false }, { signal } = {}) {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) throw new ChatSendError("conversation_unavailable", "当前账号找不到这个会话。", 410);
    const previous = this.messagePages.get(conversationId);
    if (older && previous?.hasMore === false) return { conversationId, messages: previous.messages, pageMessages: [], hasMore: false };
    const cursor = older && previous ? previous.cursor : String(BigInt(Date.now()) * 1_000n);
    const response = await this.request("/v1/message/get_by_conversation", 301,
      [m(301, [s(1, conversationId), n(2, conversation.type), n(3, conversation.shortId), n(4, 1), n(5, cursor), n(6, 50)])], { signal });
    const normalized = normalizeChatPayload(response.buffer, { conversationId, conversationType: conversation.type,
      endpoint: { kind: "chat_messages", pathname: "/v1/message/get_by_conversation" } });
    if (typeof normalized.hasMore !== "boolean") throw new DirectHistoryError("pagination_missing", "聊天历史缺少分页状态。");
    if (normalized.hasMore === true && (!/^\d{1,30}$/u.test(normalized.nextTimestamp || "") || normalized.nextTimestamp === cursor))
      throw new DirectHistoryError("pagination_stalled", "聊天历史分页游标无效，已保留当前消息。");
    const messages = [...new Map([...(older ? previous?.messages || [] : []), ...normalized.messages].map((message) => [message.id, message])).values()]
      .sort((a, b) => (Date.parse(a.sentAt) || 0) - (Date.parse(b.sentAt) || 0)).slice(-1_000);
    this.messagePages.set(conversationId, { cursor: normalized.nextTimestamp, messages, hasMore: normalized.hasMore === true });
    return { conversationId, messages, pageMessages: normalized.messages, hasMore: normalized.hasMore };
  }
  async streaks({ signal } = {}) {
    const rows = [];
    const refreshed = await this.refreshConversations([...this.conversations.keys()], { signal });
    for (const [id, conversation] of this.conversations) {
      const raw = conversation.ext?.["a:consecutive_chat_data"];
      if (refreshed.has(id) && raw) rows.push([id, raw]);
    }
    return { streaks: normalizeStreaks(rows) };
  }
  async identityToken() {
    if (this.identity && Date.now() - this.identity.createdAt < 240_000) return this.identity;
    const path = "/passport/safe/get_identity_security_token/", security = requireDirectCredentials(this.api.session);
    const url = new URL(path, "https://www.douyin.com");
    url.search = new URLSearchParams({ passport_jssdk_version: "4.2.3", passport_jssdk_type: "lite", is_from_ttaccountsdk: "1", aid: "6383",
      language: "zh", scene: "web_im", auto_retry_req: "0", skip_verify: "false", identity_token_force_get_tag: "0",
      biz_trace_id: randomUUID().slice(0, 8), id_token_version: "1.2.10", msToken: security.msToken || this.api.cookie("msToken") }).toString();
    const signed = await signDirectRequest(this.api, url);
    const response = await this.api.raw(signed, { referer: "https://www.douyin.com/chat?isPopup=1", headers: { ...directSecurityHeaders(this.api.session, path),
      "x-tt-passport-csrf-token": this.api.cookie("passport_csrf_token") || this.api.cookie("passport_csrf_token_default") } });
    const payload = parseDirectJson(response), token = payload.data?.identity_security_token, deviceId = String(payload.data?.device_id || "");
    if (payload.message !== "success" || typeof token !== "string" || !token || token.length > 20_000 || !deviceId)
      throw new ChatSendError("identity_token_rejected", "抖音暂未提供当前会话的消息发送令牌，请完成登录验证后重试。");
    this.identity = { token, deviceId, createdAt: Date.now() };
    return this.identity;
  }
  async send(input, { content, messageType = 7, onDispatch = () => {} } = {}) {
    const request = validateChatSend(input);
    let conversation = this.conversations.get(request.conversationId);
    if (!conversation) throw new ChatSendError("conversation_unavailable", "当前账号找不到这个会话。", 410);
    const identity = await this.identityToken();
    conversation = await this.refreshConversation(conversation.id);
    if (!conversation.ticket) throw new ChatSendError("conversation_unavailable", "抖音尚未提供这个会话的发送票据。", 410);
    const payload = content || { aweType: 700, type: 0, richTextInfos: [], text: request.text };
    const clientId = request.requestId;
    const body = [s(1, conversation.id), n(2, conversation.type), n(3, conversation.shortId), s(4, JSON.stringify(payload)),
      kv(5, "s:mentioned_users", ""), kv(5, "s:client_message_id", clientId), kv(5, "s:stime", `${Date.now()}.${String(randomInt(100_000)).padStart(5, "0")}`),
      n(6, messageType), s(7, conversation.ticket), s(8, clientId)];
    let dispatched = false;
    try {
      const response = await this.request("/v1/message/send", 100, [m(100, body)], {
        headers: { identity_security_token: JSON.stringify({ token: identity.token }), identity_security_device_id: identity.deviceId, identity_security_aid: "" },
        onDispatch: () => { dispatched = true; onDispatch(); },
      });
      const acknowledgement = protoChild(response.body, 100), serverId = protoInteger(acknowledgement, 1);
      const status = protoInteger(acknowledgement, 3), checkCode = protoInteger(acknowledgement, 5) ?? protoInteger(acknowledgement, 4);
      if ((status && status !== "0") || (checkCode && checkCode !== "0")) return { outcome: "rejected", message: "抖音没有接收这条消息。" };
      const echoedClientId = protoText(acknowledgement, 4);
      if (!/^[1-9]\d*$/u.test(serverId || "") || protoText(response.fields, 4) !== "OK" || (echoedClientId && echoedClientId !== clientId))
        return { outcome: "unknown", message: "还未确认发送结果，请查看手机后再决定是否重发。" };
      const chatMessage = normalizeChatPayload({ msgs: [{ server_id: serverId, sender_uid: this.api.session.uid, type_code: messageType,
        created_at: Date.now(), content_json: payload }] }, { conversationId: conversation.id, conversationType: conversation.type }).messages[0] || null;
      return { outcome: "confirmed", message: "已发送", chatMessage };
    } catch (error) {
      if (!dispatched) throw error;
      return { outcome: error.code === "platform_rejected" ? "rejected" : "unknown", code: error.code || null, message: error.code === "platform_rejected"
        ? "抖音没有接收这条消息。" : "发送结果尚未确认，请查看手机后再决定是否重发。" };
    }
  }
  async connect({ onPayload, onConnection, onError }) {
    this.controller = new AbortController(); const signal = this.controller.signal;
    const run = async () => {
      let backoff = 1_000;
      while (!signal.aborted) {
        onConnection("connecting");
        try {
          const user = await this.api.request("/aweme/v1/web/query/user/", { query: { publish_video_strategy_type: "2" }, signal });
          const deviceId = String(user.id || "");
          if (!/^\d{1,30}$/u.test(deviceId) || String(user.user_uid) !== this.api.session.uid) throw new DirectHistoryError("account_mismatch", "实时消息账号身份不一致。");
          const url = new URL("wss://frontier-im.douyin.com/ws/v2");
          url.search = new URLSearchParams({ aid: "6383", device_platform: "douyin_pc", fpid: "9", device_id: deviceId, token: this.api.cookie("sessionid"),
            access_key: createHash("md5").update(`9e1bd35ec9db7b8d846de66ed140b1ad9${deviceId}f8a69f1719916z`).digest("hex") }).toString();
          const cookies = await this.api.cookies(url.toString());
          await new Promise((resolve) => {
            const socket = this.socketFactory(url.toString(), { origin: "https://www.douyin.com", headers: { "User-Agent": this.api.currentUserAgent,
              Cookie: cookies.map(c=>`${c.name}=${c.value}`).join("; ") }, handshakeTimeout: 20_000, maxPayload: 24 * 1024 * 1024 });
            this.socket = socket;
            const abort = () => { socket.terminate(); resolve(); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            socket.on("open", () => {
              backoff = 1_000; onConnection("connected");
              // Re-read the server's latest pages after every handshake. This
              // also recovers pushes that arrived during a disconnected window.
              void this.initialize({ signal, onPayload }).catch(error=>{ if (!signal.aborted) onError(error); });
            });
            socket.on("message", (data, binary) => { try { const payload = normalizeChatSocketPayload(binary ? data : data.toString()); if (payload) void Promise.resolve(onPayload(payload)).catch(onError); } catch (error) { onError(error); } });
            socket.on("error", () => { onConnection("reconnecting"); });
            socket.on("close", () => { signal.removeEventListener("abort", abort); this.socket = null; resolve(); });
          });
        } catch (error) { if (!signal.aborted) onError(error); }
        if (signal.aborted) break;
        onConnection("reconnecting"); await delay(backoff, undefined, { signal }).catch(() => {}); backoff = Math.min(backoff * 2, 30_000);
      }
    };
    this.connectionPromise = run();
    return () => this.close();
  }
  async close() { this.controller?.abort(); this.socket?.terminate(); await this.connectionPromise?.catch(() => {}); }
}
