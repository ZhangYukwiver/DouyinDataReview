import { beforeEach, describe, expect, it } from "vitest";

import { ACHIEVEMENTS, arrangeBadges, countAchievement, noteAchievementWorks, resetAchievementCache, syncDataAchievements, unlockAchievement, type AchievementState } from "./achievements";

const store = new Map<string, string>();
const saved = () => JSON.parse(store.get("dy2.achievements") ?? "{}") as AchievementState;

beforeEach(() => {
  store.clear();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } } });
  resetAchievementCache();
});

describe("achievements", () => {
  it("和设计稿一样是 38 枚、编号不重复", () => {
    expect(ACHIEVEMENTS).toHaveLength(38);
    expect(new Set(ACHIEVEMENTS.map((item) => item.id)).size).toBe(38);
  });

  it("数据类够门槛就解锁，记录少了也不收回", () => {
    syncDataAchievements({ watch: 150, likes: 0, favorites: 0, chat: 0 });
    expect(Object.keys(saved().got).sort()).toEqual(["first-memory", "watch-1"]);
    syncDataAchievements({ watch: 40, likes: 60, favorites: 30, chat: 0 });
    expect(Object.keys(saved().got).sort()).toEqual(["favorites-1", "first-memory", "likes-1", "three-volumes", "watch-1"]);
    expect(saved().n.total).toBe(130);
  });

  it("下载按不同作品算，导出按次数算，读回来还在", () => {
    noteAchievementWorks("download", ["a", "a", "b"]);
    countAchievement("export", 5);
    resetAchievementCache();
    noteAchievementWorks("download", ["b", "c"]);
    expect(saved().n.download).toBe(3);
    expect(saved().got).toHaveProperty("download-1");
    expect(saved().got).toHaveProperty("export-2");
    expect(saved().got).not.toHaveProperty("export-3");
  });

  it("初次成就只靠点名解锁，不会被计数带出来", () => {
    countAchievement("search", 100);
    expect(saved().got).not.toHaveProperty("found-it");
    unlockAchievement("found-it");
    expect(saved().got).toHaveProperty("found-it");
  });

  it("徽章墙按拖过的顺序排，新获得的接在最后", () => {
    expect(arrangeBadges(["pioneer", "watch", "likes"], undefined)).toEqual(["pioneer", "watch", "likes"]);
    expect(arrangeBadges(["pioneer", "watch", "likes", "chat"], ["likes", "pioneer", "watch"])).toEqual(["likes", "pioneer", "watch", "chat"]);
    // 拖过的里有一类现在不在架上：跳过它，其余照旧
    expect(arrangeBadges(["pioneer", "likes", "export", "chat"], ["watch", "likes", "pioneer"])).toEqual(["likes", "pioneer", "export", "chat"]);
  });
});
