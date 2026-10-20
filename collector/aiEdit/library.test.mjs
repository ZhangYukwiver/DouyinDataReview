import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { MediaLibrary, mediaContentType } from "./library.mjs";
import { mediaKind, probeMedia } from "./media.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const kindOf = (name) => {
  if (name.endsWith(".mp4")) return "video";
  if (name.endsWith(".png")) return "image";
  throw new Error("unsupported");
};
const probe = async (filePath) => ({ kind: kindOf(filePath), duration_us: filePath.endsWith(".png") ? 86_400_000_000 : 2_000_000, width: 640, height: 360, audio: filePath.endsWith(".mp4"), video: true });

async function library(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-library-"));
  directories.push(directory);
  const media = new MediaLibrary({ directory: path.join(directory, "media"), probe, kindOf, pollMs: 5, ...options });
  await media.load();
  return media;
}

describe("MediaLibrary", () => {
  it("cleans up file names, maps project paths back to ids and refuses unusable media", async () => {
    const media = await library();
    const item = await media.upload(Readable.from([Buffer.from("x".repeat(64))]), "C:\\Users\\me\\旅行\u0000 片段.mp4");
    expect(item).toMatchObject({ name: "旅行 片段.mp4", kind: "video", durationUs: 2_000_000, hasAudio: true, size: 64 });
    const image = await media.upload(Readable.from([Buffer.from("y".repeat(32))]), "a.png");
    expect(image).toMatchObject({ kind: "image", durationUs: null, hasAudio: false });
    const filePath = media.readyPath(item.id);
    expect(path.dirname(filePath)).toBe(await realpath(media.directory));
    expect(media.idForPath(filePath)).toBe(item.id);
    expect(media.idForPath("/elsewhere/x.mp4")).toBeNull();
    expect(() => media.readyPath("nope")).toThrow(expect.objectContaining({ code: "media_not_found" }));
    media.items[0].status = "importing";
    expect(() => media.readyPath(media.items[0].id)).toThrow(expect.objectContaining({ code: "media_not_ready" }));
    media.items[0].status = "failed";
    expect(() => media.readyPath(media.items[0].id)).toThrow(expect.objectContaining({ code: "media_failed" }));
    await expect(media.upload(Readable.from([]), "empty.mp4")).rejects.toMatchObject({ code: "media_empty" });
    expect(mediaContentType("x.MOV")).toBe("video/quicktime");
    expect(mediaContentType("x.m4a")).toBe("audio/mp4");
  });

  it("records the upright size of rotated phone videos for the model and the page", async () => {
    const media = await library({ probe: probeMedia, kindOf: mediaKind });
    const fixture = (name) => readFile(new URL(`../fixtures/ai-edit/media-rotation/${name}`, import.meta.url));
    // 编码 128x72：转 90/270 度的记成竖的 72x128，转 180 度和镜像不变
    expect(await media.upload(Readable.from([await fixture("rot90.mp4")]), "竖拍.mp4")).toMatchObject({ width: 72, height: 128 });
    expect(await media.upload(Readable.from([await fixture("rot270.mp4")]), "竖拍2.mp4")).toMatchObject({ width: 72, height: 128 });
    expect(await media.upload(Readable.from([await fixture("rot180.mov")]), "倒置.mov")).toMatchObject({ width: 128, height: 72 });
    expect(await media.upload(Readable.from([await fixture("hflip.mp4")]), "镜像.mp4")).toMatchObject({ width: 128, height: 72 });
  });

  it("marks imports cut off by a restart as failed and keeps the index readable", async () => {
    const media = await library();
    const id = "e".repeat(32);
    await writeFile(path.join(media.root, "index.json"), JSON.stringify([
      { id, name: "下载中", kind: "video", status: "importing", file: `${id}.mp4`, source: { type: "douyin", url: "https://www.douyin.com/video/1" } },
      { id: "../../etc", file: "passwd" },
    ]));
    const reloaded = new MediaLibrary({ directory: media.directory, probe, kindOf });
    await reloaded.load();
    expect(reloaded.list()).toEqual([expect.objectContaining({ id, status: "failed", error: expect.stringContaining("重新添加") })]);
    expect(JSON.parse(await readFile(path.join(media.root, "index.json"), "utf8"))[0].status).toBe("failed");
  });

  it("waits for an import to settle, gives up after the timeout and stops when asked", async () => {
    const media = await library();
    const id = "f".repeat(32);
    media.items.push({ id, name: "x", kind: "video", status: "importing", file: `${id}.mp4`, source: { type: "douyin" } });
    setTimeout(() => { media.items[0].status = "ready"; }, 20);
    expect(await media.waitFor(id, { timeoutMs: 1_000 })).toMatchObject({ status: "ready" });
    media.items[0].status = "importing";
    await expect(media.waitFor(id, { timeoutMs: 20 })).rejects.toMatchObject({ code: "import_timeout" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(media.waitFor(id, { timeoutMs: 1_000, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await media.waitFor("0".repeat(32))).toBeNull();
  });

  it("refuses new media when full instead of silently dropping older files", async () => {
    const media = await library();
    const first = await media.upload(Readable.from([Buffer.from("x".repeat(64))]), "first.mp4");
    const fillers = Array.from({ length: 1_999 }, (_, index) => ({ id: index.toString(16).padStart(32, "0"), name: "x", kind: "video", status: "failed", file: "missing.mp4", source: { type: "local" } }));
    media.items.push(...fillers);
    await expect(media.upload(Readable.from([Buffer.from("y".repeat(64))]), "second.mp4")).rejects.toMatchObject({ code: "library_full", status: 409 });
    const collector = { startVideoDownload: () => { throw new Error("should not download"); } };
    const full = new MediaLibrary({ directory: media.directory, probe, kindOf, getCollector: () => collector });
    full.root = media.root;
    full.items = media.items;
    await expect(full.importDouyin({ url: "https://www.douyin.com/video/7300000000000000001" })).rejects.toMatchObject({ code: "library_full" });
    expect(media.get(first.id)).toBeTruthy();
    expect(await readdir(media.root)).toContain(`${first.id}.mp4`);
  });

  it("cleans up half-written and unindexed files on start, but never when the index could not be read", async () => {
    const media = await library();
    const kept = await media.upload(Readable.from([Buffer.from("x".repeat(64))]), "kept.mp4");
    const orphan = `${"1".repeat(32)}.mp4`;
    const partial = `${"2".repeat(32)}.mp4.part`;
    for (const name of [orphan, partial, "notes.txt"]) await writeFile(path.join(media.root, name), "x");
    const reloaded = new MediaLibrary({ directory: media.directory, probe, kindOf });
    await reloaded.load();
    expect((await readdir(media.root)).sort()).toEqual([`${kept.id}.mp4`, "index.json", "notes.txt"].sort());

    // 索引坏了：素材文件一个都不能当孤儿删
    await writeFile(path.join(media.root, "index.json"), "{broken");
    await writeFile(path.join(media.root, partial), "x");
    const broken = new MediaLibrary({ directory: media.directory, probe, kindOf });
    await broken.load();
    expect(await readdir(media.root)).toContain(`${kept.id}.mp4`);
    expect(await readdir(media.root)).not.toContain(partial);
  });

  it("removes an unfinished download's partial file together with the item", async () => {
    const media = await library();
    const id = "3".repeat(32);
    media.items.push({ id, name: "下载中", kind: "video", status: "importing", file: `${id}.mp4`, source: { type: "douyin" } });
    await writeFile(path.join(media.root, `${id}.mp4.part`), "x");
    expect(await media.remove(id)).toBe(true);
    expect(await readdir(media.root)).not.toContain(`${id}.mp4.part`);
  });

  it("checks the file key in constant time", async () => {
    const media = await library();
    expect(media.checkKey(media.key)).toBe(true);
    expect(media.checkKey(`${media.key}x`)).toBe(false);
    expect(media.checkKey(null)).toBe(false);
    expect(media.key).toMatch(/^[\w-]{32}$/u);
  });
});
