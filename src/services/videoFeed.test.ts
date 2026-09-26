import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import { closeExplore, interactExplore, readExplore, type ExplorePage } from "./explorer";
import { LocalCollectorError } from "./localCollector";
import { buildVideoFeed, createVideoCommentsSession, createVideoShareSession, createVideoWheelGesture, waitForCollector } from "./videoFeed";

vi.mock("./explorer", () => ({ readExplore: vi.fn(), interactExplore: vi.fn(), closeExplore: vi.fn().mockResolvedValue(undefined) }));
const connection = { baseUrl: "http://127.0.0.1:4765", token: "test-token" };
const record: PersonalVideoRecord = { id: "record-1", title: "作品", author: "作者", occurredAt: null, url: "https://www.douyin.com/video/123456789", mediaType: "video" };
const page: ExplorePage = { sessionId: "owned-comments", kind: "comments", items: [], profile: null, video: null, hasMore: true, limited: false };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("video feed", () => {
  it("accumulates small wheel movements and suppresses the same gesture's inertia", () => {
    const gesture = createVideoWheelGesture();
    expect([gesture(25, 0), gesture(25, 50), gesture(25, 100)]).toEqual([0, 0, 1]);
    expect([gesture(70, 150), gesture(25, 250)]).toEqual([0, 0]);
    expect(gesture(70, 500)).toBe(1);
  });

  it("unlocks continuous scrolling without requiring a pause and accepts a reversed swipe", () => {
    const gesture = createVideoWheelGesture();
    const switches = Array.from({ length: 21 }, (_, index) => gesture(70, index * 100));
    expect(switches.filter(Boolean)).toEqual([1, 1, 1]);
    expect(gesture(-70, 2100)).toBe(-1);
  });
  it("preserves list order and skips image, live and unlinked rows", () => {
    const next = { ...record, id: "next" };
    expect(buildVideoFeed([{ ...record, id: "photo", mediaType: "image" }, record, { ...record, id: "live", mediaType: "live" }, { ...record, id: "missing", url: null }, next], record)).toEqual([record, next]);
    expect(buildVideoFeed([next], record)).toEqual([record, next]);
  });
});

describe("comment session lifecycle", () => {
  it("reads the selected work, reuses pagination and releases only its own session", async () => {
    vi.mocked(readExplore).mockResolvedValue(page);
    const session = createVideoCommentsSession(connection, record);
    await session.read();
    await session.read();
    expect(readExplore).toHaveBeenNthCalledWith(1, connection, { kind: "comments", id: "123456789", sessionId: undefined });
    expect(readExplore).toHaveBeenNthCalledWith(2, connection, { kind: "comments", id: "123456789", sessionId: "owned-comments" });
    session.close();
    expect(closeExplore).toHaveBeenCalledExactlyOnceWith(connection, ["owned-comments"]);
  });

  it("deduplicates an in-flight read and cleans up its late response after closing", async () => {
    let resolve!: (page: ExplorePage) => void;
    vi.mocked(readExplore).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const session = createVideoCommentsSession(connection, record);
    const pending = session.read();
    expect(session.read()).toBe(pending);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    session.close();
    resolve(page);
    await rejected;
    expect(closeExplore).toHaveBeenCalledExactlyOnceWith(connection, ["owned-comments"]);
    await expect(session.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reopens an expired comment page for the same video", async () => {
    vi.mocked(readExplore).mockResolvedValueOnce(page).mockRejectedValueOnce(new LocalCollectorError("session_expired", "expired")).mockResolvedValueOnce({ ...page, sessionId: "replacement" });
    const session = createVideoCommentsSession(connection, record);
    await session.read();
    expect((await session.read()).sessionId).toBe("replacement");
    expect(readExplore).toHaveBeenLastCalledWith(connection, { kind: "comments", id: "123456789" });
    session.close();
    expect(closeExplore).toHaveBeenLastCalledWith(connection, ["replacement"]);
  });

  it("rejects records without a work ID before contacting the collector", async () => {
    const session = createVideoCommentsSession(connection, { ...record, url: "https://v.douyin.com/short/" });
    await expect(session.read()).rejects.toThrow("作品 ID");
    expect(readExplore).not.toHaveBeenCalled();
    session.close();
  });

  it("serializes different reply threads and deduplicates the same pending thread", async () => {
    const first = { ...page, kind: "replies" as const, commentId: "111111111" };
    const second = { ...first, commentId: "222222222" };
    let resolve!: (value: ExplorePage) => void;
    vi.mocked(readExplore).mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValueOnce(second);
    const session = createVideoCommentsSession(connection, record);
    await session.read();
    const pending = session.readReplies(first.commentId);
    expect(session.readReplies(first.commentId)).toBe(pending);
    const queued = session.readReplies(second.commentId);
    expect(readExplore).toHaveBeenCalledTimes(2);
    resolve(first);
    expect(await pending).toBe(first);
    expect(await queued).toBe(second);
    expect(readExplore).toHaveBeenLastCalledWith(connection, { kind: "replies", id: "123456789", sessionId: "owned-comments", commentId: second.commentId });
    session.close();
    expect(closeExplore).toHaveBeenCalledExactlyOnceWith(connection, ["owned-comments"]);
  });

  it("closes the comment tab after a late reply and cancels another queued thread", async () => {
    let resolve!: (value: ExplorePage) => void;
    vi.mocked(readExplore).mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const session = createVideoCommentsSession(connection, record);
    await session.read();
    const pending = session.readReplies("111111111");
    const queued = session.readReplies("222222222");
    const cancelled = [expect(pending).rejects.toMatchObject({ name: "AbortError" }), expect(queued).rejects.toMatchObject({ name: "AbortError" })];
    session.close();
    resolve({ ...page, kind: "replies", commentId: "111111111" });
    await Promise.all(cancelled);
    expect(readExplore).toHaveBeenCalledTimes(2);
    expect(closeExplore).toHaveBeenCalledExactlyOnceWith(connection, ["owned-comments"]);
  });
});

describe("shared collector contention", () => {
  it("waits for an old request without retrying platform/login errors", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce(new LocalCollectorError("collector_busy", "busy")).mockResolvedValueOnce("ready");
    const pending = waitForCollector(operation, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe("ready");
    expect(operation).toHaveBeenCalledTimes(2);
    const unavailable = vi.fn().mockRejectedValue(new LocalCollectorError("login_required", "login"));
    await expect(waitForCollector(unavailable, new AbortController().signal)).rejects.toThrow("login");
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued video switch without starting another request", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(new LocalCollectorError("collector_busy", "busy"));
    const controller = new AbortController();
    const pending = waitForCollector(operation, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("posting from the player", () => {
  it("comments through the tab the comments were read from", async () => {
    vi.mocked(readExplore).mockResolvedValue(page);
    vi.mocked(interactExplore).mockResolvedValue({ outcome: "confirmed", message: "回复已发送" });
    const session = createVideoCommentsSession(connection, record);
    await expect(session.comment("好")).rejects.toThrow("评论还没加载好");
    await session.read();
    await session.comment("好", "7685745937210311461");
    expect(vi.mocked(interactExplore).mock.calls[0]![1]).toMatchObject({ sessionId: "owned-comments", action: "comment", text: "好", replyTo: "7685745937210311461" });
  });
  it("shares through its own list tab and releases it on close", async () => {
    vi.mocked(readExplore).mockResolvedValue({ ...page, sessionId: "owned-share", kind: "sharees" });
    vi.mocked(interactExplore).mockResolvedValue({ outcome: "confirmed", message: "已分享" });
    const session = createVideoShareSession(connection, record);
    await session.read();
    await session.share("102530395613");
    expect(readExplore).toHaveBeenCalledWith(connection, { kind: "sharees", id: "123456789" });
    expect(vi.mocked(interactExplore).mock.calls[0]![1]).toMatchObject({ sessionId: "owned-share", action: "share", targetId: "102530395613" });
    session.close();
    expect(closeExplore).toHaveBeenCalledWith(connection, ["owned-share"]);
  });
});
