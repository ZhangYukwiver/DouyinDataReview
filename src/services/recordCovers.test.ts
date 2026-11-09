import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import { closeExplore, readExplore, type ExplorePage } from "./explorer";
import { isExpiredCover, loadRecordCover } from "./recordCovers";

vi.mock("./explorer", () => ({ readExplore: vi.fn(), closeExplore: vi.fn().mockResolvedValue(undefined) }));
const record: PersonalVideoRecord = { id: "old-photo", videoId: "1234567890123456789", title: "合成图文作品", author: null, occurredAt: null,
  url: "https://www.douyin.com/note/1234567890123456789", mediaType: "image", coverUrl: "https://p3-pc-sign.douyinpic.com/old.jpg?x-expires=1" };
const fresh = "https://p3-pc-sign.douyinpic.com/fresh.jpg";
const page = (id = record.videoId!, coverUrl = fresh): ExplorePage => ({ sessionId: `cover-${id}`, kind: "detail", items: [], profile: null,
  video: { ...record, videoId: id, coverUrl, authorProfile: null, liked: null, collected: null, images: [] }, hasMore: false, limited: false });
let run = 0;
const connection = () => ({ baseUrl: "http://127.0.0.1:4765", token: `cover-check-${++run}` });
const signal = () => new AbortController().signal;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("content library cover recovery", () => {
  it("recognizes expired signed covers without rejecting unsigned or future covers", () => {
    expect(isExpiredCover(record.coverUrl)).toBe(true);
    expect(isExpiredCover(null)).toBe(true);
    expect(isExpiredCover("invalid")).toBe(true);
    expect(isExpiredCover(fresh)).toBe(false);
    expect(isExpiredCover(`${fresh}?x-expires=${Math.floor(Date.now() / 1000) + 3600}`)).toBe(false);
  });

  it("refreshes duplicate watch records once, caches the cover and closes only its own detail session", async () => {
    const target = connection();
    let finish!: (value: ExplorePage) => void;
    vi.mocked(readExplore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = loadRecordCover(target, "account-a", record, signal());
    const second = loadRecordCover(target, "account-a", { ...record, id: "another-watch" }, signal());
    await vi.waitFor(() => expect(readExplore).toHaveBeenCalledOnce());
    finish(page());
    expect(await Promise.all([first, second])).toEqual([fresh, fresh]);
    expect(closeExplore).toHaveBeenCalledExactlyOnceWith(target, [`cover-${record.videoId}`]);
    expect(await loadRecordCover(target, "account-a", record, signal())).toBe(fresh);
    expect(readExplore).toHaveBeenCalledOnce();
  });

  it("skips queued covers after scrolling away and allows a later request", async () => {
    const target = connection(), cancelled = new AbortController();
    const next = { ...record, videoId: "1234567890123456790" };
    let finish!: (value: ExplorePage) => void;
    vi.mocked(readExplore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(page(next.videoId));
    const first = loadRecordCover(target, "account-a", record, signal());
    const skipped = loadRecordCover(target, "account-a", next, cancelled.signal);
    await vi.waitFor(() => expect(readExplore).toHaveBeenCalledOnce());
    cancelled.abort();
    finish(page());
    expect(await first).toBe(fresh);
    expect(await skipped).toBeNull();
    expect(readExplore).toHaveBeenCalledOnce();
    expect(await loadRecordCover(target, "account-a", next, signal())).toBe(fresh);
    expect(readExplore).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared refresh alive while another visible record still needs it", async () => {
    const target = connection(), departed = new AbortController();
    let finish!: (value: ExplorePage) => void;
    vi.mocked(readExplore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = loadRecordCover(target, "account-a", record, departed.signal);
    const second = loadRecordCover(target, "account-a", record, signal());
    await vi.waitFor(() => expect(readExplore).toHaveBeenCalledOnce());
    departed.abort();
    expect(vi.mocked(readExplore).mock.calls[0]![2]?.aborted).toBe(false);
    finish(page());
    expect(await second).toBe(fresh);
    await first;
    expect(readExplore).toHaveBeenCalledOnce();
  });

  it("recovers the queue after failed reads and rejects a cover for a different work", async () => {
    const target = connection();
    vi.mocked(readExplore).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page("1234567890123456790")).mockResolvedValueOnce(page());
    expect(await loadRecordCover(target, "account-a", record, signal())).toBeNull();
    expect(await loadRecordCover(target, "account-b", record, signal())).toBeNull();
    expect(await loadRecordCover(target, "account-c", record, signal())).toBe(fresh);
    expect(closeExplore).toHaveBeenCalledTimes(2);
  });

  it("separates accounts and connections and never requests live rooms or invalid work IDs", async () => {
    const target = connection();
    vi.mocked(readExplore).mockResolvedValue(page());
    for (const [server, owner] of [[target, "a"], [target, "b"], [{ ...target, token: "another-token" }, "a"], [{ ...target, baseUrl: "http://127.0.0.1:4766" }, "a"]] as const)
      expect(await loadRecordCover(server, owner, record, signal())).toBe(fresh);
    expect(await loadRecordCover(target, "a", { ...record, mediaType: "live" }, signal())).toBeNull();
    expect(await loadRecordCover(target, "a", { ...record, videoId: undefined, url: null }, signal())).toBeNull();
    expect(readExplore).toHaveBeenCalledTimes(4);
  });

  it("refreshes again when a cached signed cover reaches its expiry", async () => {
    vi.useFakeTimers();
    const target = connection();
    const signed = `${fresh}?x-expires=${Math.floor(Date.now() / 1000) + 600}`;
    vi.mocked(readExplore).mockResolvedValueOnce(page(record.videoId!, signed)).mockResolvedValueOnce(page());
    expect(await loadRecordCover(target, "a", record, signal())).toBe(signed);
    vi.setSystemTime(Date.now() + 600_000);
    expect(await loadRecordCover(target, "a", record, signal())).toBe(fresh);
    expect(readExplore).toHaveBeenCalledTimes(2);
  });

  it("retries a failed cover immediately after the same account imports fresh credentials", async () => {
    const target = connection();
    vi.mocked(readExplore).mockRejectedValueOnce(new Error("login expired")).mockResolvedValueOnce(page());
    expect(await loadRecordCover(target, JSON.stringify(["a", "reconnect_required"]), record, signal())).toBeNull();
    expect(await loadRecordCover(target, JSON.stringify(["a", "ready"]), record, signal())).toBe(fresh);
    expect(readExplore).toHaveBeenCalledTimes(2);
  });
});
