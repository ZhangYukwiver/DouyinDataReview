import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLivePushUrl, decodeLivePush, decodeLiveResponse, DirectLiveClient, liveAcknowledgement, liveHeartbeat, signLivePush } from "./directLive.mjs";
import { decodeProto, encodeProto, protoBytes as b, protoInteger, protoMessage as m, protoNumber as n, protoString as s, protoText } from "./directProto.mjs";
import { LiveRooms } from "./liveRoom.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";

const session = { uid: "123", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/153.0.0.0 Safari/537.36", values: {}, security: { msToken: "test" } };
const server = "wss://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/";
const metadata = () => encodeProto([s(2, "cursor"), s(5, "internal"), n(8, 1_000), s(10, server)]);
const chat = (id = 1, roomId = 42, content = "收到弹幕") => m(1, [s(1, "WebcastChatMessage"), m(2, [m(1, [n(2, id), n(3, roomId)]), m(2, [s(3, "观众")]), s(3, content)])]);
const response = (fields = []) => encodeProto([...fields, s(2, "cursor-2"), s(5, "ack-data"), n(9, 1)]);
const frame = (bytes = response([chat()])) => encodeProto([n(2, 9_007_199_254_740_993n), s(7, "msg"), b(8, gzipSync(bytes))]);

class Socket extends EventEmitter {
  constructor({ open = true } = {}) { super(); this.readyState = 0; this.sent = []; if (open) queueMicrotask(() => this.open()); }
  open() { this.readyState = 1; this.emit("open"); }
  send(bytes, options, callback) { this.sent.push(Buffer.from(bytes)); callback?.(); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  close() { this.terminate(); }
}
function api({ live = true, wrongRoom = false } = {}) {
  return { session, cookie: () => "test", cookies: vi.fn(async () => [{ name: "ttwid", value: "current-session" }]),
    raw: vi.fn(async value => {
      const url = new URL(value);
      expect(url.origin).toBe("https://live.douyin.com");
      if (url.pathname === "/webcast/room/web/enter/") return { text: JSON.stringify({ status_code: 0, data: { data: [{ id_str: "42", status: live ? 2 : 4,
        stream_url: live ? { hls_pull_url: "https://pull.example.com/live.m3u8" } : {}, owner: {}, title: "房间" }] } }) };
      if (url.pathname === "/webcast/im/fetch/") return { text: "protobuf", buffer: metadata() };
      return { text: `self.__next_f.push([1,"{\\"user_unique_id\\":\\"789\\",\\"roomId\\":\\"${wrongRoom ? 43 : 42}\\"}"])` };
    }) };
}
const clients = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); });
function client(options = {}) {
  const sockets = [], responses = [];
  const transport = new DirectLiveClient(api(), { onResponse: bytes => responses.push(bytes), socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; }, ...options });
  clients.push(transport); return { transport, sockets, responses };
}

describe("live websocket wire protocol", () => {
  it("reads server metadata, gzip payload and uint64 log IDs without precision loss", () => {
    expect(decodeLiveResponse(metadata())).toMatchObject({ cursor: "cursor", internalExt: "internal", pushServer: server, heartbeatMs: 1_000, needAck: false });
    const pushed = decodeLivePush(frame());
    expect(pushed).toMatchObject({ logId: "9007199254740993", internalExt: "ack-data", needAck: true });
    const ack = decodeProto(liveAcknowledgement(pushed));
    expect(protoInteger(ack, 2)).toBe("9007199254740993");
    expect(protoText(ack, 7)).toBe("ack"); expect(protoText(ack, 8)).toBe("ack-data");
    expect(protoText(decodeProto(liveHeartbeat()), 7)).toBe("hb");
    expect(decodeLivePush(liveHeartbeat())).toBeNull();
  });
  it("rejects malformed and oversized decompressed frames", () => {
    expect(() => decodeLivePush(frame().subarray(0, 15))).toThrow();
    expect(() => decodeLivePush(frame(Buffer.alloc(4 * 1024 * 1024 + 1)))).toThrow();
    expect(() => decodeLiveResponse(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow();
  });
  it.each([
    "wss://example.com/webcast/im/push/v2/", "wss://webcast100-ws-web-lf.douyin.com.example.com/webcast/im/push/v2/",
    "ws://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/", "wss://webcast100-ws-web-lf.douyin.com:444/webcast/im/push/v2/",
    "wss://user@webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/", "wss://webcast100-ws-web-lf.douyin.com/other/",
  ])("rejects an untrusted push-server address: %s", pushServer => {
    expect(() => buildLivePushUrl({ ...decodeLiveResponse(metadata()), pushServer }, { roomId: "42", userId: "789", session })).toThrow();
  });
  it("signs only valid room/audience IDs and uses the current session browser identity", () => {
    const signature = signLivePush("42", "789", { counter: 0, nonce: 0x123456 });
    expect(signature).toHaveLength(16); expect(signLivePush("43", "789", { counter: 0, nonce: 0x123456 })).not.toBe(signature);
    expect(() => signLivePush("invalid", "789")).toThrow();
    const url = buildLivePushUrl(decodeLiveResponse(metadata()), { roomId: "42", userId: "789", session });
    expect(url.searchParams.get("room_id")).toBe("42"); expect(url.searchParams.get("user_unique_id")).toBe("789");
    expect(url.searchParams.get("browser_version")).toBe(session.userAgent.slice(8));
    expect(url.searchParams.get("signature")).toHaveLength(16);
  });
});

describe("native live transport", () => {
  it("bootstraps by HTTP, acknowledges each response and sends heartbeats without chat writes", async () => {
    vi.useFakeTimers(); const { transport, sockets, responses } = client();
    await transport.enter("12345"); await transport.start();
    expect(transport.userId).toBe("789"); expect(transport.metrics.connections).toBe(1);
    sockets[0].emit("message", frame(), true); sockets[0].emit("message", Buffer.from([0xff]), true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.metrics).toMatchObject({ frames: 1, acknowledgements: 1, heartbeats: 2, malformedFrames: 1 });
    expect(responses).toHaveLength(2);
    expect(sockets[0].sent.map(bytes => protoText(decodeProto(bytes), 7))).toEqual(["hb", "ack", "hb"]);
    expect(transport.api.raw.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
    transport.close(); expect(transport.heartbeat).toBeNull(); expect(transport.reconnectTimer).toBeNull();
  });
  it("refetches fresh cursor metadata after disconnection, and stops reconnecting on close", async () => {
    vi.useFakeTimers(); const refreshApi = vi.fn(async () => api());
    const { transport, sockets } = client({ refreshApi });
    const initialApi = transport.api;
    await transport.enter("12345"); await transport.start(); sockets[0].terminate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2); expect(transport.metrics.reconnects).toBe(1);
    expect(refreshApi).toHaveBeenCalledWith({ signal: transport.controller.signal });
    expect([...initialApi.raw.mock.calls, ...transport.api.raw.mock.calls]
      .filter(([value]) => new URL(value).pathname === "/webcast/im/fetch/")).toHaveLength(2);
    transport.close(); await vi.advanceTimersByTimeAsync(30_000); expect(sockets).toHaveLength(2);
  });
  it("caps reconnect attempts and closes cleanly after repeated handshake failures", async () => {
    vi.useFakeTimers(); const onClose = vi.fn();
    const { transport, sockets } = client({ onClose });
    await transport.enter("12345"); await transport.start();
    transport.socketFactory = () => { const socket = new Socket({ open: false }); queueMicrotask(() => { socket.emit("error", new Error("wire")); socket.terminate(); }); return socket; };
    sockets[0].terminate(); await vi.advanceTimersByTimeAsync(8_000);
    expect(transport.metrics.reconnects).toBe(3); expect(transport.closed).toBe(true); expect(onClose).toHaveBeenCalledOnce();
    expect(transport.heartbeat).toBeNull(); expect(transport.reconnectTimer).toBeNull();
  });
  it("stops on verification rejection instead of opening a browser or silently retrying", async () => {
    const directApi = api(); directApi.raw.mockResolvedValue({ text: "blocked" });
    const transport = new DirectLiveClient(directApi); clients.push(transport);
    await expect(transport.enter("12345")).rejects.toMatchObject({ code: "verification_required" });
    expect(transport.socket).toBeNull();
  });
  it("rejects room identity changes in the landing page", async () => {
    const transport = new DirectLiveClient(api({ wrongRoom: true })); clients.push(transport);
    await transport.enter("12345"); await expect(transport.start()).rejects.toMatchObject({ code: "room_unavailable" });
    expect(transport.api.raw).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending handshake immediately when the room closes", async () => {
    const { transport } = client({ socketFactory: () => new Socket({ open: false }) });
    await transport.enter("12345"); const pending = transport.start();
    const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transport.socket).not.toBeNull());
    transport.close(); await failed;
  });
});

describe("workspace integration", () => {
  it("closing during session bootstrap prevents a late room or websocket from opening", async () => {
    let release;
    const directApi = api();
    const collector = { ensureDirectApi: vi.fn(() => new Promise(resolve => { release = resolve; })), ensureBrowser: vi.fn(), visibleBrowserWorkRunning: () => false };
    const rooms = new LiveRooms(collector);
    const pending = rooms.open("12345");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(rooms.size).toBe(1));
    await rooms.closeAll({ release: false });
    release(directApi); await rejected;
    expect(rooms.size).toBe(0); expect(rooms.inflight).toBe(0); expect(directApi.raw).not.toHaveBeenCalled();
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
  });
  it("keeps an offline room browser-free and releases the session on close", async () => {
    const collector = { ensureDirectApi: vi.fn(async () => api({ live: false })), ensureBrowser: vi.fn(), visibleBrowserWorkRunning: () => false };
    const rooms = new LiveRooms(collector);
    try {
      const state = await rooms.open("12345"); expect(state.room.live).toBe(false);
      expect(rooms.read(state.id, 0).messages).toEqual([]);
      expect(collector.ensureBrowser).not.toHaveBeenCalled(); expect(await rooms.close(state.id)).toBe(true);
      expect(rooms.size).toBe(0); expect(() => rooms.read(state.id, 0)).toThrow();
    } finally { clearTimeout(rooms.releaseTimer); }
  });
  it("retains only 300 messages, skips other rooms and returns the ended state after stopping the socket", () => {
    const rooms = new LiveRooms({}), transport = { end: vi.fn(), closed: true };
    const room = { id: "test", info: { roomId: "42", live: true }, transport, messages: [], seen: new Set(), seq: 0, ended: false };
    rooms.rooms.set(room.id, room);
    rooms.ingest(room, Array.from({ length: 310 }, (_, index) => ({ type: "chat", id: String(index + 1), roomId: "42", user: "a", text: "弹幕" })));
    rooms.ingest(room, [{ type: "chat", id: "310", roomId: "42", text: "重复" }, { type: "chat", id: "311", roomId: "43", text: "别的房间" }, { type: "ended" }]);
    expect(room.messages).toHaveLength(300); expect(room.seq).toBe(310); expect(transport.end).toHaveBeenCalledOnce();
    expect(rooms.read("test", 309)).toMatchObject({ ended: true, messages: [{ seq: 310, text: "弹幕" }] });
  });
  it("collector close stops native live sockets and timers", async () => {
    const collector = new DouyinCollector({ dataDirectory: "output/direct-live-test", store: {} });
    collector.liveRooms.closeAll = vi.fn(async () => {});
    await collector.close(); expect(collector.liveRooms.closeAll).toHaveBeenCalled();
  });
  it("native rooms allow an idle credential browser to close, while legacy pages hold it", async () => {
    const collector = new DouyinCollector({ dataDirectory: "output/direct-live-test", store: {} });
    const context = { close: vi.fn(async () => {}) };
    collector.context = context; collector.contextHeadless = true;
    collector.liveRooms.rooms.set("native", { id: "native", page: null, transport: { close: vi.fn() } });
    expect(collector.liveRooms.usesBrowser).toBe(false);
    await collector.releaseHeadlessContextIfIdle();
    expect(context.close).toHaveBeenCalledOnce(); expect(collector.context).toBeNull();
    collector.liveRooms.rooms.set("legacy", { id: "legacy", page: { close: vi.fn(async () => {}) } });
    expect(collector.liveRooms.usesBrowser).toBe(true);
    await collector.close();
  });
});
