import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./directWrites.mjs", () => ({ directWrite: vi.fn() }));
const { directWrite } = await import("./directWrites.mjs");
const { mergeDouyinFolders, pushDouyinFolders, readDouyinFolders } = await import("./douyinFolders.mjs");

const A = "1111111111", B = "2222222222", C = "3333333333";
const remote = (douyinId, name, videos, pub = false) => ({ douyinId, name, public: pub, videos });

describe("mergeDouyinFolders", () => {
  it("adds Douyin folders and files their videos, keeping local folders", () => {
    const merged = mergeDouyinFolders({ folders: [{ id: "f1", name: "本地" }], items: { [C]: "f1" } },
      [remote("71", "教程", [A, B])]);
    expect(merged.folders).toEqual([{ id: "f1", name: "本地" }, { id: "dy-71", name: "教程", douyinId: "71" }]);
    expect(merged.items).toEqual({ [C]: "f1", [A]: "dy-71", [B]: "dy-71" });
  });

  it("follows Douyin: renames, drops deleted folders and videos taken out there", () => {
    const list = { folders: [{ id: "x", name: "旧名", douyinId: "71" }, { id: "y", name: "没了", douyinId: "72" }],
      items: { [A]: "x", [B]: "x", [C]: "y" } };
    const merged = mergeDouyinFolders(list, [remote("71", "新名", [A])]);
    expect(merged.folders).toEqual([{ id: "x", name: "新名", douyinId: "71" }]);
    expect(merged.items).toEqual({ [A]: "x" });
  });

  it("keeps a video where it is when Douyin has it in several folders, otherwise takes the first", () => {
    const list = { folders: [{ id: "x", name: "甲", douyinId: "71" }, { id: "y", name: "乙", douyinId: "72" }, { id: "l", name: "本地" }],
      items: { [A]: "y", [B]: "l" } };
    const merged = mergeDouyinFolders(list, [remote("71", "甲", [A, B]), remote("72", "乙", [A])]);
    expect(merged.items).toEqual({ [A]: "y", [B]: "x" });
  });

  it("returns the same content when nothing changed", () => {
    const list = { folders: [{ id: "x", name: "甲", douyinId: "71" }], items: { [A]: "x" } };
    expect(JSON.stringify(mergeDouyinFolders(list, [remote("71", "甲", [A])]))).toBe(JSON.stringify(list));
  });
});

describe("pushDouyinFolders", () => {
  const api = { request: vi.fn(async () => ({ status_code: 0, has_more: false, collects_list: [{ collects_id_str: "71", collects_name: "甲", status: 1 }] })) };
  const options = { enabled: () => true, getApi: async () => api };
  beforeEach(() => {
    directWrite.mockReset();
    directWrite.mockImplementation(async (_api, action, input) => (action === "folder" && input.op === "create"
      ? { status_code: 0, collects_info: { collects_id_str: "99" } } : { status_code: 0 }));
  });
  const before = { folders: [{ id: "x", name: "甲", douyinId: "71" }, { id: "y", name: "乙", douyinId: "72" }, { id: "l", name: "本地" }],
    items: { [A]: "x", [B]: "x", [C]: "l" } };

  it("does nothing on Douyin when only local folders change, and keeps new folders local while writes are off", async () => {
    const after = { ...before, items: { [A]: "x", [B]: "x" } };
    const saved = await pushDouyinFolders(before, after, { ...options, enabled: () => false });
    expect(saved).toEqual(after);
    const local = { folders: [...before.folders, { id: "n", name: "新的" }], items: { ...before.items, [C]: "n" } };
    expect(await pushDouyinFolders(before, local, { ...options, enabled: () => false })).toEqual(local);
    expect(directWrite).not.toHaveBeenCalled();
  });

  it("creates new folders privately, renames with the old visibility, moves videos and deletes folders", async () => {
    const after = {
      folders: [{ id: "x", name: "甲改", douyinId: "71" }, { id: "n", name: "新的", douyinId: "666" }, { id: "l", name: "本地" }],
      items: { [A]: "n", [B]: "l", [C]: "x" },
    };
    const saved = await pushDouyinFolders(before, after, options);
    // 请求里带来的 douyinId 不算，新夹用抖音回的编号
    expect(saved.folders).toEqual([{ id: "x", name: "甲改", douyinId: "71" }, { id: "n", name: "新的", douyinId: "99" }, { id: "l", name: "本地" }]);
    expect(directWrite.mock.calls.map(([, action, input]) => [action, input])).toEqual([
      ["folder", { op: "create", name: "新的", public: false }],
      ["folder", { op: "rename", id: "71", name: "甲改", public: true }],
      ["folderVideos", { ids: [A, B], from: { id: "71", name: "甲" } }],
      ["folderVideos", { ids: [A], to: { id: "99" } }],
      ["folderVideos", { ids: [C], to: { id: "71" } }],
      ["folder", { op: "delete", id: "72" }],
    ]);
  });

  it("refuses before calling Douyin when writes are off, the name is too long or the client sent no revision", async () => {
    const moved = { ...before, items: { ...before.items, [C]: "x" } };
    await expect(pushDouyinFolders(before, moved, { ...options, enabled: () => false })).rejects.toMatchObject({ code: "writes_disabled" });
    await expect(pushDouyinFolders(before, moved, { ...options, checked: false })).rejects.toMatchObject({ code: "folders_changed" });
    const long = { ...before, folders: [...before.folders, { id: "n", name: "一二三四五六七八九十一二三四五六" }] };
    await expect(pushDouyinFolders(before, long, options)).rejects.toMatchObject({ code: "invalid_request" });
    expect(directWrite).not.toHaveBeenCalled();
  });

  it("stops at the first refusal and says earlier steps already reached Douyin", async () => {
    directWrite.mockImplementation(async (_api, action) => (action === "folder" ? { status_code: 0 } : { status_code: 5, status_msg: "参数不合法" }));
    const after = { folders: before.folders.filter((folder) => folder.id !== "y"), items: { [A]: "l" } };
    const error = await pushDouyinFolders(before, after, options).catch((reason) => reason);
    expect(error).toMatchObject({ code: "douyin_folders_failed" });
    expect(error.message).toContain("参数不合法");
    expect(directWrite).toHaveBeenCalledTimes(1);
  });
});

describe("readDouyinFolders", () => {
  it("pages through the folders and each folder's videos", async () => {
    const pages = {
      "/aweme/v1/web/collects/list/:0": { status_code: 0, has_more: 1, cursor: 5, collects_list: [{ collects_id_str: "71", collects_name: "甲", status: 0 }] },
      "/aweme/v1/web/collects/list/:5": { status_code: 0, has_more: 0, collects_list: [{ collects_id_str: "72", collects_name: "乙", status: 1 }] },
      "/aweme/v1/web/collects/video/list/:0:71": { status_code: 0, has_more: false, aweme_list: [{ aweme_id: A }] },
      "/aweme/v1/web/collects/video/list/:0:72": { status_code: 0, has_more: false, aweme_list: null },
    };
    const api = { request: vi.fn(async (path, { query }) => pages[[path, query.cursor, query.collects_id].filter(Boolean).join(":")]) };
    expect(await readDouyinFolders(api)).toEqual([remote("71", "甲", [A]), remote("72", "乙", [], true)]);
  });

  it("fails as a whole when a page is refused", async () => {
    const api = { request: vi.fn(async () => ({ status_code: 2483, has_more: false })) };
    await expect(readDouyinFolders(api)).rejects.toMatchObject({ code: "douyin_error" });
  });
});
