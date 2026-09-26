import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendChatMessage } from "./chatSend";
import { LocalCollectorError } from "./localCollector";
import { renewSparks, shareTargetIds, sparkRenewJob, type SparkSendUpdate } from "./sparkRenew";
import { createVideoShareSession } from "./videoFeed";

vi.mock("./chatSend", () => ({ CHAT_SEND_UNCONFIRMED: "chat_send_unconfirmed", sendChatMessage: vi.fn() }));
vi.mock("./videoFeed", () => ({ createVideoShareSession: vi.fn(), waitForCollector: (operation: () => unknown) => operation() }));
const connection = { baseUrl: "http://127.0.0.1:4765", token: "test-token" };
const me = "607350412292247";
const friends = ["0:1:102530395613:607350412292247", "0:1:607350412292247:1943533479536520", "0:1:607350412292247:7652969598506517553"];
const sent = { outcome: "confirmed" as const, message: "已发送" };
beforeEach(() => vi.clearAllMocks());

function run(ids = friends, payload: Parameters<typeof renewSparks>[2] = { kind: "text", text: "[续火花吧]" }, signal = new AbortController().signal) {
  const log: Array<[string, SparkSendUpdate]> = [];
  return renewSparks(connection, ids, payload, { signal, gapMs: () => 0, onUpdate: (id, update) => log.push([id, update]) }).then(() => log);
}
const finalStates = (log: Array<[string, SparkSendUpdate]>) => Object.fromEntries(log.map(([id, update]) => [id, update.state]));

describe("renewing sparks", () => {
  it("sends one friend at a time in order", async () => {
    vi.mocked(sendChatMessage).mockResolvedValue(sent);
    expect(finalStates(await run())).toEqual(Object.fromEntries(friends.map((id) => [id, "sent"])));
    expect(vi.mocked(sendChatMessage).mock.calls.map((call) => call[1])).toEqual(friends);
  });
  it("stops when the problem is not about one friend, or after two failures in a row", async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new LocalCollectorError("not_receiving", "先开始接收消息"));
    expect(Object.values(finalStates(await run()))).toEqual(["failed", "skipped", "skipped"]);
    vi.mocked(sendChatMessage).mockReset().mockResolvedValue({ outcome: "rejected", message: "抖音没有接收这条消息。" });
    expect(Object.values(finalStates(await run()))).toEqual(["failed", "failed", "skipped"]);
    expect(sendChatMessage).toHaveBeenCalledTimes(2);
  });
  it("stops the rest once the user stops, without touching the one in flight", async () => {
    const controller = new AbortController();
    vi.mocked(sendChatMessage).mockImplementation(async () => { controller.abort(); return sent; });
    expect(Object.values(finalStates(await run(friends, undefined, controller.signal)))).toEqual(["sent", "skipped", "skipped"]);
  });
  it("shares a video to the friend's own id and skips friends missing from the share list", async () => {
    const share = vi.fn().mockResolvedValue({ outcome: "confirmed", message: "已分享" });
    const close = vi.fn();
    vi.mocked(createVideoShareSession).mockReturnValue({ read: async () => ({ items: [{ id: "102530395613" }, { id: "1943533479536520" }] }), share, close } as never);
    const log: Array<[string, SparkSendUpdate]> = [];
    await renewSparks(connection, friends, { kind: "video", record: { id: "v", title: "视频", author: null, occurredAt: null, url: "https://www.douyin.com/video/123456789" } },
      { signal: new AbortController().signal, gapMs: () => 0, selfId: me, onUpdate: (id, update) => log.push([id, update]) });
    expect(finalStates(log)).toEqual({ [friends[0]!]: "sent", [friends[1]!]: "sent", [friends[2]!]: "skipped" });
    expect(share.mock.calls.map((call) => call[0])).toEqual(["102530395613", "1943533479536520"]);
    expect(close).toHaveBeenCalledTimes(1);
    // 自己也在分享名单里：只要认得出自己，就绝不会把自己当成对方
    expect(shareTargetIds(friends[1]!, me)).toEqual(["1943533479536520"]);
    expect(shareTargetIds("7091970798369407526", me)).toEqual(["7091970798369407526"]);
  });
});

describe("a renewal run outside the board", () => {
  it("keeps going with nobody watching, runs one at a time, and stops or clears on request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(sendChatMessage).mockImplementation(async () => { await gate; return sent; });
    sparkRenewJob.start(connection, friends, { kind: "text", text: "早" }, me);
    sparkRenewJob.start(connection, ["0:1:1:2"], { kind: "text", text: "不该发" }, me);
    expect(sparkRenewJob.snapshot()).toMatchObject({ running: true, ids: friends });
    sparkRenewJob.dismiss();
    expect(sparkRenewJob.snapshot()).not.toBeNull();
    sparkRenewJob.stop();
    release();
    await vi.waitFor(() => expect(sparkRenewJob.snapshot()?.running).toBe(false));
    expect(Object.values(sparkRenewJob.snapshot()!.progress).map((update) => update.state)).toEqual(["sent", "skipped", "skipped"]);
    expect(vi.mocked(sendChatMessage).mock.calls.map((call) => call[2])).toEqual(["早"]);
    sparkRenewJob.dismiss();
    expect(sparkRenewJob.snapshot()).toBeNull();
  });
});
