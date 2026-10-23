import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RecordFolderStore, sanitizeRecordFolders } from "./recordFolders.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "collector-folders-"));
  temporaryDirectories.push(directory);
  return directory;
}

const emptyList = { folders: [], items: {} };
const emptyLists = { lists: { watch_history: emptyList, liked_videos: emptyList, favorite_videos: emptyList } };

describe("sanitizeRecordFolders", () => {
  it("turns anything that is not an object into three empty lists", () => {
    for (const value of [null, undefined, "x", 1, [], {}, { lists: [] }, { lists: "x" }]) {
      expect(sanitizeRecordFolders(value)).toEqual(emptyLists);
    }
  });

  it("keeps only the three lists and fills in the missing ones", () => {
    const result = sanitizeRecordFolders({ lists: {
      liked_videos: { folders: [{ id: "a", name: "喜欢的" }], items: { v1: "a" } },
      chat: { folders: [{ id: "b", name: "别的" }], items: {} },
    } });
    expect(Object.keys(result.lists)).toEqual(["watch_history", "liked_videos", "favorite_videos"]);
    expect(result.lists.liked_videos).toEqual({ folders: [{ id: "a", name: "喜欢的" }], items: { v1: "a" } });
    expect(result.lists.watch_history).toEqual(emptyList);
    expect(result.lists.favorite_videos).toEqual(emptyList);
  });

  it("drops bad ids, empty or long names and repeated ids", () => {
    const long = "字".repeat(41);
    const emoji = "😀".repeat(40);
    const { folders } = sanitizeRecordFolders({ lists: { watch_history: { folders: [
      { id: "ok_1", name: "  学习  " },
      { id: "has space", name: "坏 id" },
      { id: "../x", name: "坏 id" },
      { id: "x".repeat(41), name: "太长的 id" },
      { id: 7, name: "数字 id" },
      { id: "empty", name: "   " },
      { id: "long", name: long },
      { id: "noname" },
      { id: "emoji", name: emoji },
      { id: "ok_1", name: "重复的" },
      "not an object",
      null,
    ], items: {} } } }).lists.watch_history;
    // 40 个 emoji 是 40 个字符，不算超长
    expect(folders).toEqual([{ id: "ok_1", name: "学习" }, { id: "emoji", name: emoji }]);
  });

  it("keeps at most 200 folders", () => {
    const many = Array.from({ length: 205 }, (_, index) => ({ id: `f${index}`, name: `夹${index}` }));
    const { folders } = sanitizeRecordFolders({ lists: { favorite_videos: { folders: many, items: {} } } }).lists.favorite_videos;
    expect(folders).toHaveLength(200);
    expect(folders.at(-1).id).toBe("f199");
  });

  it("drops items pointing at missing folders and keys of the wrong length", () => {
    const { items } = sanitizeRecordFolders({ lists: { watch_history: {
      folders: [{ id: "a", name: "甲" }, { id: "bad id", name: "乙" }],
      items: { v1: "a", v2: "gone", v3: "bad id", v4: 1, "": "a", ["k".repeat(301)]: "a", ["k".repeat(300)]: "a" },
    } } }).lists.watch_history;
    expect(items).toEqual({ v1: "a", ["k".repeat(300)]: "a" });
    // JSON 里来的 "__proto__" 是普通键，要原样留下
    const parsed = sanitizeRecordFolders(JSON.parse('{"lists":{"watch_history":{"folders":[{"id":"a","name":"甲"}],"items":{"__proto__":"a"}}}}'));
    expect(Object.keys(parsed.lists.watch_history.items)).toEqual(["__proto__"]);
    expect(JSON.stringify(parsed.lists.watch_history.items)).toBe('{"__proto__":"a"}');
  });

  it("treats folders and items of the wrong type as empty", () => {
    const result = sanitizeRecordFolders({ lists: {
      watch_history: { folders: { id: "a", name: "甲" }, items: [["v1", "a"]] },
      liked_videos: "x",
      favorite_videos: { folders: [{ id: "a", name: "甲" }], items: "v1" },
    } });
    expect(result.lists.watch_history).toEqual(emptyList);
    expect(result.lists.liked_videos).toEqual(emptyList);
    expect(result.lists.favorite_videos).toEqual({ folders: [{ id: "a", name: "甲" }], items: {} });
  });
});

describe("RecordFolderStore", () => {
  const sample = { lists: { watch_history: { folders: [{ id: "f1", name: "学习" }], items: { v1: "f1", v2: "missing" } } } };

  it("reads three empty lists when there is no file yet", async () => {
    const directory = await makeDirectory();
    expect(await new RecordFolderStore(directory).read()).toEqual(emptyLists);
    expect(await readdir(directory)).toEqual([]);
  });

  it("writes the cleaned data privately and reads it back after a restart", async () => {
    const directory = await makeDirectory();
    const store = new RecordFolderStore(directory);
    const saved = await store.write(sample);
    expect(saved.lists.watch_history).toEqual({ folders: [{ id: "f1", name: "学习" }], items: { v1: "f1" } });
    expect(await store.read()).toEqual(saved);
    const file = JSON.parse(await readFile(path.join(directory, "folders.json"), "utf8"));
    expect(file).toMatchObject({ schemaVersion: 1, lists: saved.lists });
    expect(Number.isNaN(Date.parse(file.updatedAt))).toBe(false);
    if (process.platform !== "win32") expect((await stat(path.join(directory, "folders.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["folders.json"]);
    expect(await new RecordFolderStore(directory).read()).toEqual(saved);
  });

  it("keeps a broken file aside instead of letting the next save overwrite it", async () => {
    const directory = await makeDirectory();
    await writeFile(path.join(directory, "folders.json"), '{"lists":{"watch_his');
    const store = new RecordFolderStore(directory);
    expect(await store.read()).toEqual(emptyLists);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^folders\.json\.broken-\d+$/u);
    expect(await readFile(path.join(directory, names[0]), "utf8")).toBe('{"lists":{"watch_his');
  });

  it("also keeps a broken file aside when the first call is a save", async () => {
    const directory = await makeDirectory();
    await writeFile(path.join(directory, "folders.json"), "{ broken");
    await new RecordFolderStore(directory).write(sample);
    const names = (await readdir(directory)).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("folders.json");
    expect(await readFile(path.join(directory, names[1]), "utf8")).toBe("{ broken");
  });

  it("saves concurrent writes in order so the later one ends up on disk", async () => {
    const directory = await makeDirectory();
    const store = new RecordFolderStore(directory);
    const first = { lists: { liked_videos: { folders: [{ id: "a", name: "先" }], items: {} } } };
    const second = { lists: { liked_videos: { folders: [{ id: "b", name: "后" }], items: {} } } };
    const [, later] = await Promise.all([store.write(first), store.write(second)]);
    expect(JSON.parse(await readFile(path.join(directory, "folders.json"), "utf8")).lists).toEqual(later.lists);
    expect((await store.read()).lists.liked_videos.folders).toEqual([{ id: "b", name: "后" }]);
    expect(await readdir(directory)).toEqual(["folders.json"]);
  });

  it("throws when the file cannot be written", async () => {
    const directory = await makeDirectory();
    const store = new RecordFolderStore(path.join(directory, "missing"));
    await expect(store.write(sample)).rejects.toMatchObject({ code: "ENOENT" });
    // 没写成就还是原来的内容
    expect(await store.read()).toEqual(emptyLists);
  });
});
