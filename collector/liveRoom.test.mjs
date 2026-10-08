import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeLiveFrame, liveRoomIdFrom, LiveRooms, normalizeFollowingLive, normalizeLiveRoom } from "./liveRoom.mjs";

// 按抖音直播 protobuf 的线格式拼测试帧（字段号是 09-26 实抓的帧里对出来的）
const varint = (value) => {
  let rest = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
};
const num = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
const bytes = (field, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
};
const msg = (...parts) => Buffer.concat(parts);
const envelope = (method, payload) => bytes(1, msg(bytes(1, method), bytes(2, payload), num(3, 1)));
const chat = (id, roomId, user, text, method = "WebcastChatMessage") => envelope(method, msg(
  bytes(1, msg(bytes(1, method), num(2, id), num(3, roomId))),
  bytes(2, msg(num(1, 98972578469n), bytes(3, user))),
  method === "WebcastChatMessage" ? bytes(3, text) : msg(num(3, 1), bytes(5, text)),
  num(15, 1790436484),
));
const pushFrame = (response) => msg(num(1, 1), num(3, 8888), bytes(5, msg(bytes(1, "compress_type"), bytes(2, "gzip"))), bytes(7, "msg"), bytes(8, gzipSync(response)));

describe("live rooms use of the shared browser", () => {
  it("counts reading who is live and entering a room as in-flight until they settle", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const rooms = new LiveRooms({ visibleBrowserWorkRunning: () => false, ensureBrowser: vi.fn(async () => { await gate; throw new Error("stop here"); }) });
    expect(rooms.inflight).toBe(0);
    const following = rooms.following({ refresh: true }).catch(() => undefined);
    await vi.waitFor(() => expect(rooms.inflight).toBe(1));
    const entering = rooms.open("921169302662").catch(() => undefined);
    await vi.waitFor(() => expect(rooms.inflight).toBe(2));
    release();
    await Promise.all([following, entering]);
    expect(rooms.inflight).toBe(0);
  });
});

describe("live room", () => {
  it("reads the room id from a link or a bare number", () => {
    expect(liveRoomIdFrom("https://live.douyin.com/921169302662?show_type=highlight")).toBe("921169302662");
    expect(liveRoomIdFrom(" live.douyin.com/123/ ")).toBe("123");
    expect(liveRoomIdFrom("921169302662")).toBe("921169302662");
    expect(liveRoomIdFrom("https://www.douyin.com/video/7310000000000000000")).toBeNull();
    expect(liveRoomIdFrom("https://live.douyin.com.example.com/123")).toBeNull();
    expect(liveRoomIdFrom("")).toBeNull();
  });

  it("decodes chat, viewers, likes and the end signal from a pushed frame", () => {
    const response = msg(
      chat(7689866125657543715n, 42, "灰涩毛衣", "思域牛逼"),
      chat(7689866125657543716n, 42, "🌈油卡", "[比心]", "WebcastEmojiChatMessage"),
      envelope("WebcastRoomUserSeqMessage", msg(num(3, 775036), bytes(8, "10万+"))),
      envelope("WebcastLikeMessage", msg(num(2, 18), num(3, 37294175))),
      envelope("WebcastGiftMessage", msg(bytes(1, "not decoded"))),
      envelope("WebcastControlMessage", msg(num(2, 3))),
      bytes(2, "cursor"), num(4, 1790436488372),
    );
    expect(decodeLiveFrame(pushFrame(response))).toEqual([
      { type: "chat", id: "7689866125657543715", roomId: "42", user: "灰涩毛衣", text: "思域牛逼" },
      { type: "chat", id: "7689866125657543716", roomId: "42", user: "🌈油卡", text: "[比心]" },
      { type: "online", value: 775036 },
      { type: "likes", value: 37294175 },
      { type: "ended" },
    ]);
    expect(decodeLiveFrame(msg(num(1, 5), bytes(7, "hb"), bytes(8, gzipSync(Buffer.alloc(0)))))).toEqual([]);
    expect(() => decodeLiveFrame(pushFrame(response).subarray(0, 40))).toThrow();
  });

  it("keeps each message once and ignores another room's messages", () => {
    const rooms = new LiveRooms({});
    const room = { info: { roomId: "42" }, messages: [], seen: new Set(), seq: 0, online: null, likes: null, ended: false };
    const events = decodeLiveFrame(pushFrame(msg(chat(1, 42, "a", "第一条"), chat(2, 43, "b", "别的直播间"), envelope("WebcastRoomUserSeqMessage", num(3, 9)))));
    rooms.ingest(room, events);
    rooms.ingest(room, events);
    expect(rooms.snapshot(room, 0)).toMatchObject({ online: 9, cursor: 1, messages: [{ seq: 1, user: "a", text: "第一条" }] });
    expect(rooms.snapshot(room, 1).messages).toEqual([]);
  });

  it("lists followed anchors who are live, from either shape of the follow feed", () => {
    const room = (title, status = 2) => ({ id_str: "1", status, title, user_count_str: "76w+", owner: { nickname: "陈伯", avatar_thumb: { url_list: ["http://p11.douyinpic.com/a.jpeg"] } }, cover: { url_list: ["https://p3.douyinpic.com/c.jpeg"] } });
    expect(normalizeFollowingLive({ status_code: 0, data: { data: [
      { web_rid: "921169302662", tag_name: "王者荣耀", room: room("陈伯大舞台") },
      { web_rid: "123", data: { ...room("下播了", 4) } },
      { web_rid: "not-a-room", room: room("坏数据") },
      { web_rid: "584923819885", data: { ...room("盘它"), room_view_stats: { display_short: "1.2万" } } },
      // the feed now reports rooms that are live as status 0
      { web_rid: "504448096643", room: room("天霸黑潮", 0) },
    ] } })).toEqual([
      { webRid: "921169302662", title: "陈伯大舞台", anchor: { name: "陈伯", avatar: "https://p11.douyinpic.com/a.jpeg" }, cover: "https://p3.douyinpic.com/c.jpeg", online: "76万+", tag: "王者荣耀" },
      { webRid: "584923819885", title: "盘它", anchor: { name: "陈伯", avatar: "https://p11.douyinpic.com/a.jpeg" }, cover: "https://p3.douyinpic.com/c.jpeg", online: "1.2万", tag: null },
      { webRid: "504448096643", title: "天霸黑潮", anchor: { name: "陈伯", avatar: "https://p11.douyinpic.com/a.jpeg" }, cover: "https://p3.douyinpic.com/c.jpeg", online: "76万+", tag: null },
    ]);
    expect(normalizeFollowingLive({ status_code: 0, data: { data: [] } })).toEqual([]);
    expect(normalizeFollowingLive({ status_code: 8, data: {} })).toBeNull();
  });

  it("turns the enter response into playable https streams, best first", () => {
    const streams = { origin: { main: { hls: "http://pull-hls-q11.douyincdn.com/a_or4.m3u8?sign=1" } }, sd: { main: { hls: "http://pull-hls-q11.douyincdn.com/a_sd.m3u8?sign=2" } }, ao: { main: { hls: "" } } };
    const payload = { data: { data: [{
      id_str: "7689851218365139754", status: 2, title: "陈伯大舞台", like_count: 35830499,
      owner: { nickname: "陈伯(全能王)", sec_uid: "MS4w", avatar_thumb: { url_list: ["https://p11.douyinpic.com/a.jpeg"] } },
      room_view_stats: { display_value: 767319 },
      stream_url: { live_core_sdk_data: { pull_data: {
        stream_data: JSON.stringify({ data: streams }),
        options: { default_quality: { sdk_key: "sd" }, qualities: [{ name: "高清", sdk_key: "sd", level: 2 }, { name: "蓝光", sdk_key: "origin", level: 4 }, { name: "音频", sdk_key: "ao", level: 0 }] },
      } } },
    }] } };
    expect(normalizeLiveRoom(payload, "921169302662")).toEqual({
      webRid: "921169302662", roomId: "7689851218365139754", live: true, title: "陈伯大舞台",
      anchor: { name: "陈伯(全能王)", avatar: "https://p11.douyinpic.com/a.jpeg", secUid: "MS4w" },
      cover: null, online: 767319, likes: 35830499,
      qualities: [
        { key: "origin", name: "蓝光", url: "https://pull-hls-q11.douyincdn.com/a_or4.m3u8?sign=1" },
        { key: "sd", name: "高清", url: "https://pull-hls-q11.douyincdn.com/a_sd.m3u8?sign=2" },
      ],
      defaultQuality: "sd",
    });
    const offline = normalizeLiveRoom({ data: { data: [{ id_str: "1", status: 4, title: "下播了", owner: { nickname: "主播" }, stream_url: {} }] } }, "123");
    expect(offline).toMatchObject({ live: false, qualities: [], defaultQuality: null, anchor: { name: "主播" } });
  });
});
