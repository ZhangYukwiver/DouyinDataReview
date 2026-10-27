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
