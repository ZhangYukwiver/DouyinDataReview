import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FeedFilterStore, sanitizeFeedFilter } from "./feedFilter.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "collector-feed-filter-"));
  temporaryDirectories.push(directory);
  return directory;
}

const event = (id, action = "hidden") => ({ t: 1_790_000_000_000, id, desc: "文案", author: "作者", matched: ["营销号"], action });

describe("推荐流过滤存储", () => {
  it("软件与网页共用词条，旧档保留迁移标记，主动清空不会恢复旧词条", async () => {
    const directory = await makeDirectory(), store = new FeedFilterStore(directory);
    expect(await store.read()).toMatchObject({ words: null, webPicks: false });
    await store.setSettings({ words: "露营\n咖啡", webPicks: true });
    await store.setSettings({ mode: "hide" });
    expect(await new FeedFilterStore(directory).read()).toMatchObject({ words: "露营\n咖啡", webPicks: true, mode: "hide" });
    await store.setSettings({ words: "", webPicks: false });
    expect(await new FeedFilterStore(directory).read()).toMatchObject({ words: "", webPicks: false });
    expect(sanitizeFeedFilter({ words: "长".repeat(3000), webPicks: "true" }).words).toHaveLength(2000);
    expect(sanitizeFeedFilter({ webPicks: "true" }).webPicks).toBe(false);
  });
  it("词条翻到哪、推过哪些逐项校验，每个词最多留最近 300 条", () => {
    const ids = Array.from({ length: 310 }, (_, index) => String(70000 + index));
    expect(sanitizeFeedFilter({ pickHistory: { 猫: { offset: 60, ids: [...ids, "坏", 7] }, 狗: { offset: -1 }, 鸟: "坏" } }).pickHistory).toEqual({
      猫: { offset: 60, ids: ids.slice(-300) }, 狗: { offset: 0, ids: [] }, 鸟: { offset: 0, ids: [] } });
    expect(sanitizeFeedFilter(null).pickHistory).toEqual({});
  });

  it("没有文件时给示例词条和「只记录」", async () => {
    const value = await new FeedFilterStore(await makeDirectory()).read();
    expect(value.mode).toBe("observe");
    expect(value.rules).toContain("营销号");
    expect(value.events).toEqual([]);
    expect(value).toMatchObject({ lastSeenAt: null, remove: false });
  });

  it("改词条、模式、扩展状态和记录都落盘，重开还在", async () => {
    const directory = await makeDirectory();
    const store = new FeedFilterStore(directory);
    await Promise.all([store.setSettings({ rules: "带货", mode: "hide" }), store.addEvents([event("7000000000000000001")]), store.touch(), store.requestRemove(true)]);
    const reopened = await new FeedFilterStore(directory).read();
    expect(reopened).toMatchObject({ rules: "带货", mode: "hide", remove: true, lastSeenAt: expect.any(Number), events: [event("7000000000000000001")] });
    await store.removed();
    expect(await new FeedFilterStore(directory).read()).toMatchObject({ remove: false, lastSeenAt: null });
    await store.clearEvents();
    expect((await new FeedFilterStore(directory).read()).events).toEqual([]);
  });

  it("扩展送来的记录逐条过一遍：动作不认识、没有作品号的丢掉，字段截短，最多留 500 条", () => {
    const value = sanitizeFeedFilter({ mode: "boom", events: [
      event("7000000000000000001", "deleted"), event("abc"), { ...event(""), action: "unreadable" },
      { ...event("7000000000000000002"), desc: "长".repeat(500), matched: ["a", "b", "c", "d", "e", "f", 7] },
      ...Array.from({ length: 600 }, (_, index) => event(String(7_100_000_000_000_000_000n + BigInt(index)))),
    ] });
    expect(value.mode).toBe("observe");
    expect(value.events).toHaveLength(500);
    expect(value.events.at(-1).id).toBe("7100000000000000599");
    const kept = sanitizeFeedFilter({ events: [{ ...event(""), action: "unreadable" }, { ...event("7000000000000000002"), desc: "长".repeat(500), matched: ["a", "b", "c", "d", "e", "f"] }] }).events;
    expect(kept[0].action).toBe("unreadable");
    expect(kept[1].desc).toHaveLength(120);
    expect(kept[1].matched).toHaveLength(5);
  });

  it("带视频信息的命中存成和观看记录一样的记录：同一个作品只留最近一次，清空时一起清", async () => {
    const directory = await makeDirectory();
    const store = new FeedFilterStore(directory);
    const aweme = (id) => ({ aweme_id: id, desc: "直播间带货 #好物", create_time: 1_780_000_000, aweme_type: 0,
      author: { nickname: "营销号甲", uid: "9", avatar_thumb: { url_list: ["https://p3.douyinpic.com/a.jpg"] } },
      video: { duration: 15_000, cover: { url_list: ["https://p3.douyinpic.com/c.jpg"] } },
      statistics: { digg_count: 12, comment_count: 3 }, text_extra: [{ hashtag_name: "好物" }], music: { id: "7", title: "原声", author: "营销号甲" } });
    await store.addEvents([
      { ...event("7000000000000000001"), aweme: aweme("7000000000000000001") },
      { ...event("7000000000000000002", "observed"), aweme: aweme("7000000000000000002") },
      // 没带视频信息、作品号对不上、动作不算挡的，都不进这一栏
      event("7000000000000000003"), { ...event("7000000000000000004"), aweme: aweme("7000000000000000005") },
      { ...event("", "unreadable"), aweme: aweme("7000000000000000006") },
    ]);
    await store.addEvents([{ ...event("7000000000000000001", "disliked"), t: 1_790_000_100_000, aweme: aweme("7000000000000000001") }]);
    const { videos, events } = await new FeedFilterStore(directory).read();
    expect(events).toHaveLength(6);
    expect(events.some((item) => "aweme" in item)).toBe(false);
    expect(videos.map((video) => [video.videoId, video.feedFilter.action])).toEqual([["7000000000000000002", "observed"], ["7000000000000000001", "disliked"]]);
    expect(videos[1]).toMatchObject({
      id: "feed_filtered:7000000000000000001", title: "直播间带货 #好物", author: "营销号甲", authorId: "9", url: "https://www.douyin.com/video/7000000000000000001",
      occurredAt: new Date(1_790_000_100_000).toISOString(), coverUrl: "https://p3.douyinpic.com/c.jpg", authorAvatarUrl: "https://p3.douyinpic.com/a.jpg",
      mediaType: "video", durationSeconds: 15, topics: ["好物"], stats: { diggCount: 12, commentCount: 3 }, music: { title: "原声" },
      feedFilter: { action: "disliked", matched: ["营销号"] },
    });
    await store.clearEvents();
    expect((await new FeedFilterStore(directory).read()).videos).toEqual([]);
  });

  it("磁盘上的视频记录也逐条过一遍：不是这一栏的、动作不认识的丢掉，最多留 1000 条", () => {
    const video = (id, action = "hidden") => ({ id: `feed_filtered:${id}`, title: "t", author: null, occurredAt: null, url: null, videoId: id, feedFilter: { action, matched: ["a", 7] } });
    const value = sanitizeFeedFilter({ videos: [video("1", "deleted"), { ...video("2"), id: "watch_history:2" }, video("3"),
      ...Array.from({ length: 1100 }, (_, index) => video(String(10_000 + index)))] });
    expect(value.videos).toHaveLength(1000);
    expect(value.videos.at(-1).videoId).toBe("11099");
    expect(sanitizeFeedFilter({ videos: [video("3")] }).videos[0].feedFilter).toEqual({ action: "hidden", matched: ["a"] });
  });

  it("半截文件先留底再当空的用", async () => {
    const directory = await makeDirectory();
    await writeFile(path.join(directory, "feed-filter.json"), "{\"rules\":");
    expect((await new FeedFilterStore(directory).read()).mode).toBe("observe");
    expect((await readdir(directory)).some((name) => name.startsWith("feed-filter.json.broken-"))).toBe(true);
  });

  it("只读不写盘", async () => {
    const directory = await makeDirectory();
    await new FeedFilterStore(directory).read();
    await expect(readFile(path.join(directory, "feed-filter.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
