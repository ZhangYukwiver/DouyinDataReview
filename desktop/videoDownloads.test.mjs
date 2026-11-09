import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { isVideoDownload, readVideoDownloadDirectory, uniqueSavePath, writeVideoDownloadDirectory } from "./videoDownloads.mjs";

it("视频和 zip 进下载文件夹、同名不覆盖、设置坏了退回默认", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "video-downloads-"));
  expect(isVideoDownload("a.mp4")).toBe(true);
  expect(isVideoDownload("作品-音频.m4a")).toBe(true);
  expect(isVideoDownload("抖音视频_3个.ZIP")).toBe(true);
  expect(isVideoDownload("抖音数据.json")).toBe(false);

  const target = path.join(directory, "抖音视频");
  expect(uniqueSavePath(target, "a.mp4")).toBe(path.join(target, "a.mp4"));
  writeFileSync(path.join(target, "a.mp4"), "");
  writeFileSync(path.join(target, "a (1).mp4"), "");
  expect(uniqueSavePath(target, "../a.mp4")).toBe(path.join(target, "a (2).mp4"));
  expect(uniqueSavePath(target, "a.mp4", new Set([path.join(target, "a (2).mp4")]))).toBe(path.join(target, "a (3).mp4"));

  const settings = path.join(directory, "video-downloads.json");
  expect(readVideoDownloadDirectory(settings, "/默认")).toBe("/默认");
  writeVideoDownloadDirectory(settings, target);
  expect(readVideoDownloadDirectory(settings, "/默认")).toBe(target);
  writeFileSync(settings, "{坏");
  expect(readVideoDownloadDirectory(settings, "/默认")).toBe("/默认");
});
