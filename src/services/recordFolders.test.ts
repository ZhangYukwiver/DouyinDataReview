import { describe, expect, it } from "vitest";

import type { PersonalVideoRecord } from "../domain/personalRecords";
import {
  ALL_FOLDERS,
  UNFILED,
  addFolder,
  countByFolder,
  filterByFolder,
  folderNameProblem,
  folderOf,
  moveToFolder,
  removeFolder,
  renameFolder,
  type RecordFolderList,
} from "./recordFolders";

const record = (id: string, videoId?: string): PersonalVideoRecord => ({ id, videoId, title: id, author: null, occurredAt: null, url: null });

describe("record folders", () => {
  // 同一个视频看了两次（两条观看记录），一条没有 videoId 的老记录
  const first = record("watch_history:7001:2026-10-01T00:00:00.000Z", "7001");
  const again = record("watch_history:7001:2026-10-02T00:00:00.000Z", "7001");
  const other = record("watch_history:7002:2026-10-03T00:00:00.000Z", "7002");
  const legacy = record("watch-legacy-1");
  const records = [first, again, other, legacy];
  const empty: RecordFolderList = { folders: [], items: {} };

  it("files a video once so every viewing of it moves together", () => {
    const list = moveToFolder(addFolder(empty, "  学习 ", "f1"), [first, legacy], "f1");
    expect(list.folders).toEqual([{ id: "f1", name: "学习" }]);
    expect(folderOf(list, again)?.name).toBe("学习");
    expect(filterByFolder(records, list, "f1")).toEqual([first, again, legacy]);
    expect(filterByFolder(records, list, UNFILED)).toEqual([other]);
    expect(filterByFolder(records, list, ALL_FOLDERS)).toBe(records);
    expect(countByFolder(records, list)).toEqual(new Map([["f1", 3], [UNFILED, 1]]));
  });

  it("moves back to unfiled and drops a deleted folder's videos into unfiled", () => {
    let list = moveToFolder(addFolder(addFolder(empty, "学习", "f1"), "搞笑", "f2"), records, "f1");
    list = moveToFolder(list, [other], "f2");
    list = moveToFolder(list, [legacy], null);
    expect(countByFolder(records, list)).toEqual(new Map([["f1", 2], ["f2", 1], [UNFILED, 1]]));
    list = removeFolder(list, "f1");
    expect(list.folders.map((folder) => folder.id)).toEqual(["f2"]);
    expect(list.items).toEqual({ "7002": "f2" });
    expect(countByFolder(records, list)).toEqual(new Map([[UNFILED, 3], ["f2", 1]]));
  });

  it("keeps just-moved videos in the filtered view until the filter changes", () => {
    const list = moveToFolder(addFolder(empty, "学习", "f1"), [first], "f1");
    expect(filterByFolder(records, list, UNFILED)).toEqual([other, legacy]);
    expect(filterByFolder(records, list, UNFILED, new Set(["7001"]))).toEqual(records);
    expect(filterByFolder(records, list, ALL_FOLDERS, new Set(["7001"]))).toBe(records);
  });

  it("treats an assignment to a folder that no longer exists as unfiled", () => {
    const list: RecordFolderList = { folders: [], items: { "7001": "gone" } };
    expect(folderOf(list, first)).toBeNull();
    expect(filterByFolder(records, list, UNFILED)).toEqual(records);
  });

  it("checks names: required, short, unique ignoring case, renaming to itself is fine", () => {
    const list = addFolder(empty, "Study", "f1");
    expect(folderNameProblem(list, "   ")).toBe("给文件夹起个名字。");
    expect(folderNameProblem(list, "一".repeat(21))).toBe("名字最多 20 个字。");
    expect(folderNameProblem(list, "😀".repeat(20))).toBeNull();
    expect(folderNameProblem(list, " study ")).toBe("已经有同名的文件夹了。");
    expect(folderNameProblem(list, "STUDY", "f1")).toBeNull();
    expect(renameFolder(list, "f1", " 学习 ").folders).toEqual([{ id: "f1", name: "学习" }]);
  });

  it("stops at the folder limit", () => {
    const full: RecordFolderList = { folders: Array.from({ length: 200 }, (_, index) => ({ id: `f${index}`, name: `夹${index}` })), items: {} };
    expect(folderNameProblem(full, "新的")).toBe("最多建 200 个文件夹。");
    expect(folderNameProblem(full, "改名", "f3")).toBeNull();
  });

  it("never mutates the list it was given", () => {
    const list = addFolder(empty, "学习", "f1");
    const frozen = JSON.stringify(list);
    moveToFolder(list, records, "f1");
    renameFolder(list, "f1", "别的");
    removeFolder(list, "f1");
    expect(JSON.stringify(list)).toBe(frozen);
  });
});
