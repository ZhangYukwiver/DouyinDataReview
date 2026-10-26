import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 记下每次改名时收件箱里有什么，用来确认 mp4 先到、json 最后出现
const renames = vi.hoisted(() => []);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: async (from, to) => {
      await actual.rename(from, to);
      renames.push({ to: path.basename(to), listing: (await actual.readdir(path.dirname(to))).sort() });
    },
  };
});

const { parseReelLabRequest, sendToReelLab } = await import("./reelLab.mjs");

const JOB = "12345678-1234-1234-1234-123456789abc";
const directories = [];

afterEach(async () => {
  renames.length = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(fileName = "clip.mp4") {
  const root = await mkdtemp(path.join(tmpdir(), "reellab-handoff-"));
  directories.push(root);
  const source = path.join(root, fileName);
  await writeFile(source, "fake video bytes");
  const inboxDirectory = path.join(root, "ReelLab", "inbox");
  const openInbox = vi.fn(async () => undefined);
  const options = {
    isInstalled: () => true,
    getDownloadFilePath: (jobId) => (jobId === JOB ? source : null),
    inboxDirectory,
    openInbox,
    now: () => new Date("2026-10-26T02:00:00.000Z"),
  };
  return { inboxDirectory, openInbox, options };
}

const request = { jobId: JOB, title: "  标题  ", author: "作者", url: "https://example.com/video/1", description: null, durationSeconds: 12.3 };

describe("send to ReelLab", () => {
  it("drops the video and then its json into the inbox, and wakes the app", async () => {
    const { inboxDirectory, openInbox, options } = await setup();
    expect(await sendToReelLab(request, options)).toEqual({ status: "sent" });

    const files = (await readdir(inboxDirectory)).sort();
    expect(files).toHaveLength(2);
    const [json, mp4] = files;
    const id = mp4.slice(0, -4);
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(json).toBe(`${id}.json`);
    expect(await readFile(path.join(inboxDirectory, mp4), "utf8")).toBe("fake video bytes");
    expect(JSON.parse(await readFile(path.join(inboxDirectory, json), "utf8"))).toEqual({
      version: 1, title: "标题", author: "作者", url: "https://example.com/video/1", description: null, durationSeconds: 12.3, sentAt: "2026-10-26T02:00:00.000Z",
    });
    // mp4 改好名时还没有任何 json；json 是最后一个改名的
    expect(renames.map((step) => step.to)).toEqual([`${id}.mp4`, `${id}.json`]);
    expect(renames[0].listing).toEqual([`${id}.mp4`]);
    expect(openInbox).toHaveBeenCalledTimes(1);
  });

  it("still counts as sent when the files are in place but the app could not be woken", async () => {
    const { inboxDirectory, openInbox, options } = await setup();
    openInbox.mockRejectedValueOnce(new Error("no handler"));
    expect(await sendToReelLab(request, options)).toEqual({ status: "sent", wakeFailed: true });
    expect(await readdir(inboxDirectory)).toHaveLength(2);
  });

  it("refuses anything that is not an mp4, such as a photo post zip", async () => {
    const { inboxDirectory, openInbox, options } = await setup("photos.zip");
    expect(await sendToReelLab(request, options)).toMatchObject({ status: "failed", message: expect.stringContaining("只能送视频") });
    await expect(readdir(inboxDirectory)).rejects.toThrow();
    expect(openInbox).not.toHaveBeenCalled();
  });

  it("writes nothing when ReelLab is not installed", async () => {
    const { inboxDirectory, openInbox, options } = await setup();
    expect(await sendToReelLab(request, { ...options, isInstalled: () => false })).toEqual({ status: "not_installed" });
    await expect(readdir(inboxDirectory)).rejects.toThrow();
    expect(openInbox).not.toHaveBeenCalled();
  });

  it("says so when the download job does not exist", async () => {
    const { inboxDirectory, openInbox, options } = await setup();
    expect(await sendToReelLab({ ...request, jobId: "87654321-4321-4321-4321-cba987654321" }, options)).toMatchObject({ status: "failed", message: expect.stringContaining("重新送一次") });
    await expect(readdir(inboxDirectory)).rejects.toThrow();
    expect(openInbox).not.toHaveBeenCalled();
  });

  it("rejects malformed requests and keeps only well-typed fields", () => {
    expect(parseReelLabRequest(null)).toBeNull();
    expect(parseReelLabRequest({ jobId: "../../etc/passwd" })).toBeNull();
    expect(parseReelLabRequest({ jobId: JOB, title: 5, author: "", url: "file:///etc/passwd", durationSeconds: Number.NaN, description: "x".repeat(800) })).toEqual({
      jobId: JOB, title: "未命名视频", author: null, url: null, description: "x".repeat(500), durationSeconds: null,
    });
  });
});
