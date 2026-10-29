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
});
