import { describe, expect, it, vi } from "vitest";
import { DouyinCollector } from "./douyinCollector.mjs";
import { createEmptyRecords } from "./normalizer.mjs";

// 工作台里点赞收藏、刷推荐看过以后，本机内容库不用等下次读取就跟上
function fake(records) {
  const self = { syncPromise: null, snapshot: { records, warnings: [], directSync: null, chatMessages: [], chatConversations: [] } };
  self.saveSnapshot = vi.fn(async (build) => { const [next] = build(self.snapshot); self.snapshot = { ...self.snapshot, records: next }; });
  return self;
}
const aweme = (id, extra = {}) => ({ aweme_id: id, desc: `作品${id}`, author: { nickname: "作者", uid: "1" }, ...extra });

describe("library write-back", () => {
  it("puts a liked work first and takes it out again after unliking", async () => {
    const self = fake({ ...createEmptyRecords(), liked_videos: [{ id: "liked_videos:1111111111", videoId: "1111111111", title: "旧", author: null, occurredAt: null, url: null }] });
    await DouyinCollector.prototype.syncInteraction.call(self, "liked_videos", aweme("2222222222"), true);
    expect(self.snapshot.records.liked_videos.map((item) => item.videoId)).toEqual(["2222222222", "1111111111"]);
    await DouyinCollector.prototype.syncInteraction.call(self, "liked_videos", aweme("2222222222"), false);
    expect(self.snapshot.records.liked_videos.map((item) => item.videoId)).toEqual(["1111111111"]);
    self.syncPromise = Promise.resolve();
    await DouyinCollector.prototype.syncInteraction.call(self, "liked_videos", aweme("3333333333"), true);
    expect(self.saveSnapshot).toHaveBeenCalledTimes(2);
  });
  it("merges only the new events from the first watch history page, keeping Douyin's times", async () => {
    const self = fake(createEmptyRecords());
    const page = { status_code: 0, has_more: 1, max_cursor: 1, aweme_date: { "2222222222": 1793240000, "1111111111": 1793230000 },
      aweme_list: [aweme("2222222222"), aweme("1111111111")] };
    Object.assign(self, { ensureDirectApi: vi.fn(async () => ({})), readDirectHistory: vi.fn(async () => page) });
    await DouyinCollector.prototype.refreshWatchHistoryHead.call(self);
    expect(self.snapshot.records.watch_history.map((item) => item.videoId)).toEqual(["2222222222", "1111111111"]);
    expect(self.snapshot.records.watch_history[0].occurredAt).toBe(new Date(1793240000 * 1000).toISOString());
    await DouyinCollector.prototype.refreshWatchHistoryHead.call(self);
    expect(self.saveSnapshot).toHaveBeenCalledOnce();
  });
  it("writes the player's own progress onto the in-app watch and drops the entry Douyin moved on finishing", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-29T06:30:00Z"), toFake: ["Date"] });
    try {
      const at = (iso) => Date.parse(iso) / 1000;
      const self = fake(createEmptyRecords());
      let page = { status_code: 0, aweme_date: { "2222222222": at("2026-10-29T06:30:01Z"), "1111111111": at("2026-10-29T06:30:00Z") },
        aweme_list: [aweme("2222222222"), aweme("1111111111")] };
      Object.assign(self, { ensureDirectApi: vi.fn(async () => ({})), readDirectHistory: vi.fn(async () => page) });
      const note = (input) => DouyinCollector.prototype.noteFeedWatch.call(self, input);
      const refresh = () => DouyinCollector.prototype.refreshWatchHistoryHead.call(self);
      note({ awemeId: "1111111111" }); vi.setSystemTime(Date.parse("2026-10-29T06:30:01Z")); note({ awemeId: "2222222222" });
      await refresh();
      // 1 看完离开：抖音把它挪到 06:31:00，紧跟着记 3；还没读到挪过的那条就先不标
      vi.setSystemTime(Date.parse("2026-10-29T06:31:00Z"));
      note({ awemeId: "3333333333", previous: { awemeId: "2222222222", positionMs: 59_000, durationMs: 60_000, finished: true } });
      await refresh();
      expect(self.snapshot.records.watch_history.find((item) => item.videoId === "2222222222").watchCompleted).toBeUndefined();
      page = { status_code: 0, aweme_date: { "3333333333": at("2026-10-29T06:31:00.001Z"), "2222222222": at("2026-10-29T06:31:00Z"), "1111111111": at("2026-10-29T06:30:00Z") },
        aweme_list: [aweme("3333333333"), aweme("2222222222"), aweme("1111111111")] };
      await refresh();
      const two = self.snapshot.records.watch_history.filter((item) => item.videoId === "2222222222");
      expect(two).toHaveLength(1);
      expect(two[0]).toMatchObject({ occurredAt: "2026-10-29T06:31:00.000Z", watchCompleted: true, watchProgress: { watchedSeconds: 60, percent: 100 } });
      // 关播放器时只报进度：3 没看完，原地写进那条
      note({ previous: { awemeId: "3333333333", positionMs: 12_000, durationMs: 48_000, finished: false } });
      await refresh();
      expect(self.snapshot.records.watch_history.find((item) => item.videoId === "3333333333")).toMatchObject({ watchCompleted: false, watchProgress: { watchedSeconds: 12, percent: 25 } });
      expect(self.snapshot.records.watch_history.map((item) => item.videoId)).toEqual(["3333333333", "2222222222", "1111111111"]);
    } finally { vi.useRealTimers(); }
  });
});
