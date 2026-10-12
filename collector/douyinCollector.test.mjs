import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  completionScanFloor,
  DouyinCollector,
  labelWatchCompletion,
  normalizeOwnProfileUrl,
  profileTabUrl,
  readLoginIdentity,
} from "./douyinCollector.mjs";
import { DirectHistoryError } from "./directHistory.mjs";
import { createEmptyRecords } from "./normalizer.mjs";
import { createEndpointProgress } from "./progress.mjs";
import { CollectorStore, normalizeDirectSyncState } from "./store.mjs";
import { VideoDownloadError } from "./videoDownloader.mjs";

function emptySnapshot() {
  return {
    schemaVersion: 2,
    updatedAt: "2026-08-09T00:00:00.000Z",
    records: createEmptyRecords(),
    chatMessages: [],
    chatConversations: [],
    warnings: [],
    directSync: normalizeDirectSyncState(null),
  };
}

function mockStore(updatedAt = "2026-08-09T00:10:00.000Z") {
  return {
    save: vi.fn(async (records, warnings, options = {}) => ({
      schemaVersion: 2,
      updatedAt,
      records: structuredClone(records),
      chatMessages: structuredClone(options.chatMessages ?? []),
      chatConversations: structuredClone(options.chatConversations ?? []),
      warnings: structuredClone(warnings),
      directSync: normalizeDirectSyncState(options.directSync),
    })),
  };
}

function fakeResponse(pathname, payload) {
  return {
    url: () => `https://www.douyin.com${pathname}`,
    ok: () => true,
    status: () => 200,
    headers: () => ({}),
    json: () => typeof payload === "function" ? payload() : Promise.resolve(payload),
  };
}

describe("watch completion labels", () => {
  const watch = (videoId, occurredAt, extra = {}) => ({
    id: `watch_history:${videoId}:${occurredAt}`, title: videoId, author: null, url: null, videoId, occurredAt, occurredAtSource: "platform_action", mediaType: "video", ...extra,
  });
  const ms = (iso) => Date.parse(iso);

  it("marks the viewing Douyin lists as finished, and a video missing from the list as unfinished", () => {
    const records = [
      watch("finished", "2026-09-30T13:05:01.570Z"),
      watch("skipped", "2026-09-30T13:02:30.037Z"),
      // watched again later: that newer viewing was finished, this older one is left alone
      watch("again", "2026-09-30T12:00:00.000Z"),
      watch("again", "2026-09-30T13:00:00.000Z"),
      // entry write that a later finish replaced on Douyin's side
      watch("replaced", "2026-09-30T12:30:00.000Z"),
      watch("old", "2026-09-29T00:00:00.000Z"),
      watch("undated", "2026-09-30T13:00:00.000Z", { occurredAtSource: "unknown" }),
      watch("live-1", "2026-09-30T13:00:00.000Z", { mediaType: "live" }),
    ];
    const completed = new Map([
      ["finished", ms("2026-09-30T13:05:01.570Z")],
      ["again", ms("2026-09-30T13:00:00.000Z")],
      ["replaced", ms("2026-09-30T12:40:00.000Z")],
    ]);

    const labels = labelWatchCompletion(records, completed, ms("2026-09-30T12:00:00.000Z")).map((record) => [record.videoId, record.watchCompleted]);

    expect(labels).toEqual([
      ["finished", true],
      ["skipped", false],
      ["again", undefined],
      ["again", true],
      ["replaced", undefined],
      ["old", undefined],
      ["undated", undefined],
      ["live-1", undefined],
    ]);
  });

  it("drops an unfinished label once that video turns up finished later, and never guesses for a finish without a time", () => {
    const records = [
      // read while still on screen, then watched to the end: Douyin moved its time to 13:00:40
      watch("was-on-screen", "2026-09-30T13:00:00.000Z", { watchCompleted: false }),
      watch("was-on-screen", "2026-09-30T13:00:40.000Z"),
      watch("no-time", "2026-09-30T13:01:00.000Z"),
    ];
    const completed = new Map([["was-on-screen", ms("2026-09-30T13:00:40.000Z")], ["no-time", Number.NaN]]);

    const labelled = labelWatchCompletion(records, completed, ms("2026-09-30T12:00:00.000Z"));

    expect(labelled.map((record) => record.watchCompleted)).toEqual([undefined, true, undefined]);
    expect(labelled[0]).not.toHaveProperty("watchCompleted");
  });

  it("labels nothing when the finished list came back empty", () => {
    expect(labelWatchCompletion([watch("a", "2026-09-30T13:00:00.000Z")], new Map(), Infinity)[0]).not.toHaveProperty("watchCompleted");
  });

  it("pages the finished list until it passes the floor, in seconds or milliseconds", async () => {
    const pages = {
      0: { status_code: 0, aweme_list: [{ aweme_id: "a" }, { aweme_id: "b", history_info: { view_time: 1_790_000_900 } }], aweme_date: { a: 1_790_001_000_000 }, has_more: 1, max_cursor: "1790000900000" },
      1790000900000: { status_code: 0, aweme_list: [{ aweme_id: "c" }], aweme_date: { c: 1_790_000_000 }, has_more: 1, max_cursor: "1790000000000" },
    };
    const self = { assertSyncActive: vi.fn(), updateStatus: vi.fn(), readDirectHistory: vi.fn(async (_context, cursor, options) => {
      expect(options).toEqual({ completedOnly: true });
      return pages[cursor];
    }) };

    // the second page reaches below the floor, so a third is never asked for
    const result = await DouyinCollector.prototype.readCompletedWatchTimes.call(self, {}, 1, 1_790_000_500_000);

    expect(self.readDirectHistory.mock.calls.map(([, cursor]) => cursor)).toEqual(["0", "1790000900000"]);
    expect(Object.fromEntries(result.completed)).toEqual({ a: 1_790_001_000_000, b: 1_790_000_900_000, c: 1_790_000_000_000 });
    expect(result.coveredFromMs).toBe(1_790_000_000_000);
  });

  it("resumes an hour before the newest labelled viewing", () => {
    expect(completionScanFloor([watch("a", "2026-09-30T13:00:00.000Z")])).toBe(-Infinity);
    expect(completionScanFloor([
      watch("a", "2026-09-30T13:00:00.000Z", { watchCompleted: false }),
      watch("b", "2026-09-30T14:00:00.000Z"),
      watch("c", "2026-09-30T11:00:00.000Z", { watchCompleted: true }),
    ])).toBe(ms("2026-09-30T12:00:00.000Z"));
  });
});

describe("importRecords", () => {
  it("only adds what the collector lacks, keeps local copies on overlap, and refuses while a read runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dy-import-"));
    try {
      const store = new CollectorStore(directory);
      const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: directory, store });
      const watch = (videoId, title, occurredAt) => ({ id: `watch_history:${videoId}:${occurredAt}`, videoId, title, occurredAt, occurredAtSource: "platform_action" });
      const liked = (videoId, title) => ({ id: `liked_videos:${videoId}`, videoId, title, occurredAt: null, occurredAtSource: "unknown" });
      const message = (id, sentAt) => ({ id, conversationId: "c1", senderId: "u1", sentAt, type: "text", text: id });
      // 本机记录和真实运行一样先过一遍存盘规范化
      await store.save({ watch_history: [watch("7000000000000000001", "本机", "2026-09-02T00:00:00.000Z")], liked_videos: [liked("7000000000000000011", "本机喜欢")], favorite_videos: [] }, [], {
        chatMessages: [message("m1", "2026-09-02T00:00:00.000Z")],
      });
      collector.snapshot = await store.load();
      const result = await collector.importRecords({
        records: {
          watch_history: [
            watch("7000000000000000001", "文件里的旧标题", "2026-09-02T00:00:00.000Z"),
            watch("7000000000000000002", "更早", "2026-09-01T00:00:00.000Z"),
            watch("7000000000000000003", "更晚", "2026-09-03T00:00:00.000Z"),
          ],
          liked_videos: [liked("7000000000000000011", "文件"), liked("7000000000000000012", "文件新增")],
          favorite_videos: [null],
        },
        chatMessages: [message("m1", "2026-09-02T00:00:00.000Z"), message("m2", "2026-09-03T00:00:00.000Z")],
        chatConversations: [{ id: "c1", kind: "private", messageCount: 2, ownMessageCount: 0 }],
      });
      expect(result.added).toEqual({ watch_history: 2, liked_videos: 1, favorite_videos: 0, chat_messages: 1 });
      const saved = await new CollectorStore(directory).load();
      expect(saved.records.watch_history.map((item) => item.title)).toEqual(["更晚", "本机", "更早"]);
      expect(saved.records.liked_videos.map((item) => item.title)).toEqual(["本机喜欢", "文件新增"]);
      expect(saved.chatMessages.map((item) => item.id)).toEqual(["m2", "m1"]);
      collector.syncPromise = new Promise(() => undefined);
      await expect(collector.importRecords({})).rejects.toMatchObject({ status: 409, code: "import_busy" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Douyin profile routing", () => {
  it("normalizes only a concrete same-origin profile URL", () => {
    expect(normalizeOwnProfileUrl("/user/account-id?from=nav#top"))
      .toBe("https://www.douyin.com/user/account-id");
    expect(normalizeOwnProfileUrl("https://douyin.com/user/another-id/"))
      .toBe("https://www.douyin.com/user/another-id");
    expect(normalizeOwnProfileUrl("https://www.douyin.com/user/self")).toBeNull();
    expect(normalizeOwnProfileUrl("https://evil.example/user/account-id")).toBeNull();
    expect(normalizeOwnProfileUrl("http://www.douyin.com/user/account-id")).toBeNull();
  });

  it("builds only supported profile tab URLs", () => {
    expect(profileTabUrl("https://www.douyin.com/user/account-id", "record"))
      .toBe("https://www.douyin.com/user/account-id?showTab=record");
    expect(profileTabUrl("https://www.douyin.com/user/account-id", "like"))
      .toBe("https://www.douyin.com/user/account-id?showTab=like");
    expect(profileTabUrl("https://www.douyin.com/user/account-id", "favorite_collection"))
      .toBe("https://www.douyin.com/user/account-id?showTab=favorite_collection");
    expect(profileTabUrl("https://www.douyin.com/user/account-id", "unknown")).toBeNull();
  });
});

describe("video download jobs", () => {
  it("skips abandoned queued playback while preserving an explicit download", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureDirectApi = vi.fn();
    const playback = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    collector.releaseVideoPlayback(playback.id);
    await collector.videoDownloadQueue;
    expect(collector.ensureDirectApi).not.toHaveBeenCalled();
    expect(collector.getVideoDownloadJob(playback.id)).toBeNull();
    const manual = { id: "manual", status: "queued", controller: new AbortController() };
    collector.videoDownloadJobs.set(manual.id, manual);
    expect(collector.releaseVideoPlayback(manual.id)).toBe(false);
    expect(manual.controller.signal.aborted).toBe(false);
    expect(manual.status).toBe("queued");
  });

  it("cancels running playback before media discovery and frees the serial queue", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    let release;
    const context = { close: vi.fn(async () => {}), newPage: vi.fn() };
    collector.ensureDirectApi = vi.fn(() => new Promise((resolve) => { release = () => resolve(context); }));
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    await vi.waitFor(() => expect(collector.getVideoDownloadJob(job.id).status).toBe("running"));
    expect(collector.releaseVideoPlayback(job.id)).toBe(true);
    release();
    await collector.videoDownloadQueue;
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(collector.hasActiveVideoDownload()).toBe(false);
    expect(collector.getVideoDownloadJob(job.id)).toBeNull();
  });

  it("hands out a resolved playback stream only for its key and only until release", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureDirectApi = vi.fn(async () => { throw new Error("no browser in tests"); });
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    expect(job.streamKey).toHaveLength(32);
    expect(collector.playbackStream(job.id, job.streamKey)).toBeNull();
    const stream = { url: "https://v3-web.douyinvod.com/a.mp4", referer: "https://www.douyin.com/video/1234567890", cookie: "" };
    collector.videoDownloadJobs.get(job.id).stream = stream;
    expect(collector.playbackStream(job.id, "wrong")).toBeNull();
    expect(collector.playbackStream(job.id, undefined)).toBeNull();
    expect(collector.playbackStream(job.id, job.streamKey)).toBe(stream);
    collector.videoDownloadJobs.get(job.id).status = "complete";
    collector.releaseVideoPlayback(job.id);
    expect(collector.playbackStream(job.id, job.streamKey)).toBeNull();
    expect(collector.startVideoDownload("https://www.douyin.com/video/1234567891")).not.toHaveProperty("streamKey");
  });
  it("gives an image post's pictures to the player and streams only its live clips", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureDirectApi = vi.fn(async () => { throw new Error("no browser in tests"); });
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    const referer = "https://www.douyin.com/note/1234567890";
    collector.videoDownloadJobs.get(job.id).stream = {
      images: [{ url: "https://p3-pc-sign.douyinpic.com/a.jpeg", live: "https://v11-weba.douyinvod.com/a/" }, { url: "https://p3-pc-sign.douyinpic.com/b.jpeg" }],
      music: "https://sf6-cdn-tos.douyinstatic.com/obj/ies-music/1.mp3",
      referer,
    };
    expect(collector.getVideoDownloadJob(job.id)).toMatchObject({
      images: [{ url: "https://p3-pc-sign.douyinpic.com/a.jpeg", live: true }, { url: "https://p3-pc-sign.douyinpic.com/b.jpeg", live: false }],
      music: "https://sf6-cdn-tos.douyinstatic.com/obj/ies-music/1.mp3",
    });
    expect(collector.playbackStream(job.id, job.streamKey, "0")).toEqual({ url: "https://v11-weba.douyinvod.com/a/", referer });
    expect(collector.playbackStream(job.id, job.streamKey, "1")).toBeNull();
    expect(collector.playbackStream(job.id, job.streamKey)).toBeNull();
    expect(collector.playbackStream(job.id, "wrong", "0")).toBeNull();
    collector.releaseVideoPlayback(job.id);
  });
  it("validates the source before creating a queued job", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    expect(() => collector.startVideoDownload("https://example.com/video/1")).toThrowError(/抖音视频链接/u);
    expect(collector.videoDownloadJobs.size).toBe(0);
  });

  it("keeps queued jobs private and blocks paths outside the download directory", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.runVideoDownloadJob = vi.fn().mockResolvedValue(undefined);
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890");
    expect(job).toMatchObject({ status: "queued", sourceUrl: "https://www.douyin.com/video/1234567890" });
    expect(job).not.toHaveProperty("filePath");
    await collector.videoDownloadQueue;
    expect(collector.runVideoDownloadJob).toHaveBeenCalledTimes(1);

    const internal = collector.videoDownloadJobs.get(job.id);
    internal.status = "complete";
    internal.filePath = "/tmp/not-a-download.mp4";
    expect(collector.getVideoDownloadFilePath(job.id)).toBeNull();
  });

  it("marks queued jobs as failed when the collector closes", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.runVideoDownloadJob = vi.fn().mockResolvedValue(undefined);
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890");
    await collector.close();
    expect(collector.getVideoDownloadJob(job.id)).toMatchObject({ status: "failed", errorCode: "collector_closed" });
  });

  it("restores the terminal collector status after an HTTP download failure", async () => {
    const context = {
      close: vi.fn(async () => undefined),
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.status = {
      ...collector.status,
      state: "partial",
      phase: "liked_videos",
      message: "已保留上次保存的记录",
      progress: { current: 2, total: 3 },
      browserOpen: false,
    };
    const previousStatus = collector.getStatus();
    collector.ensureDirectApi = vi.fn(async () => {
      collector.updateStatus({
        state: "launching_browser",
        phase: null,
        message: "正在启动无头抖音会话",
        browserOpen: true,
      });
      collector.context = context;
      collector.contextHeadless = true;
      return context;
    });
    collector.videoDownloadJobs.set("download-status-reset", {
      id: "download-status-reset",
      sourceUrl: "https://www.douyin.com/video/1234567890",
      status: "queued",
      fileName: null,
      filePath: null,
      bytes: null,
      errorCode: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    });

    await collector.runVideoDownloadJob(collector.videoDownloadJobs.get("download-status-reset"));

    expect(context.close).not.toHaveBeenCalled();
    expect(collector.getStatus()).toEqual({ ...previousStatus, revision: expect.any(Number) });
    expect(collector.getStatus().revision).toBeGreaterThan(previousStatus.revision);
  });

  it("tells the explore adapter after every download job settles, once the job no longer counts as active", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureDirectApi = vi.fn(async () => { throw new Error("headless_launch_failed"); });
    const activeWhenCalled = [];
    collector.afterVideoDownload = vi.fn(() => { activeWhenCalled.push(collector.hasActiveVideoDownload()); });
    const job = { id: "download-hook", sourceUrl: "https://www.douyin.com/video/1234567890", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    collector.videoDownloadJobs.set(job.id, job);
    await collector.runVideoDownloadJob(job);
    expect(collector.getVideoDownloadJob(job.id)).toMatchObject({ status: "failed" });
    expect(collector.afterVideoDownload).toHaveBeenCalledTimes(1);
    expect(activeWhenCalled).toEqual([false]);
    // 回调抛错也不影响任务结果
    collector.afterVideoDownload = () => { throw new Error("boom"); };
    const again = { ...job, id: "download-hook-2", status: "queued" };
    collector.videoDownloadJobs.set(again.id, again);
    await expect(collector.runVideoDownloadJob(again)).resolves.toBeUndefined();
  });

  it("only lets the last queued job see an idle collector", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureDirectApi = vi.fn(async () => { throw new Error("headless_launch_failed"); });
    const seen = [];
    collector.afterVideoDownload = () => seen.push(collector.hasActiveVideoDownload());
    const first = collector.startVideoDownload("https://www.douyin.com/video/1234567890");
    const second = collector.startVideoDownload("https://www.douyin.com/video/1234567891");
    await collector.videoDownloadQueue;
    expect(collector.getVideoDownloadJob(first.id)).toMatchObject({ status: "failed" });
    expect(collector.getVideoDownloadJob(second.id)).toMatchObject({ status: "failed" });
    expect(seen).toEqual([true, false]);
  });

  it("restores the terminal collector status when HTTP initialization fails", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.status = {
      ...collector.status,
      state: "complete",
      message: "上一轮读取已完成",
      browserOpen: false,
    };
    const previousStatus = collector.getStatus();
    collector.ensureDirectApi = vi.fn(async () => {
      collector.updateStatus({
        state: "launching_browser",
        message: "正在启动无头抖音会话",
        browserOpen: false,
      });
      throw new Error("headless_launch_failed");
    });
    const job = {
      id: "download-launch-failed",
      sourceUrl: "https://www.douyin.com/video/1234567890",
      status: "queued",
      fileName: null,
      filePath: null,
      bytes: null,
      errorCode: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    collector.videoDownloadJobs.set(job.id, job);

    await collector.runVideoDownloadJob(job);

    expect(collector.getVideoDownloadJob(job.id)).toMatchObject({ status: "failed" });
    expect(collector.getStatus()).toEqual({ ...previousStatus, revision: expect.any(Number) });
    expect(collector.getStatus().revision).toBeGreaterThan(previousStatus.revision);
  });

  it("rejects a new job when all retained slots are queued or running", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    for (let index = 0; index < 64; index += 1) {
      collector.videoDownloadJobs.set(`download-active-${index}`, {
        id: `download-active-${index}`,
        status: index % 2 === 0 ? "queued" : "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    expect(() => collector.startVideoDownload("https://www.douyin.com/video/1234567890"))
      .toThrowError(VideoDownloadError);
    try {
      collector.startVideoDownload("https://www.douyin.com/video/1234567890");
    } catch (error) {
      expect(error).toMatchObject({ name: "VideoDownloadError", code: "download_job_limit" });
    }
    expect(collector.videoDownloadJobs.size).toBe(64);
  });

  it("removes an expired terminal job file asynchronously when pruning", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "douyin-collector-download-jobs-"));
    const downloadsDirectory = path.join(dataDirectory, "downloads");
    const filePath = path.join(downloadsDirectory, "expired.mp4");
    await mkdir(downloadsDirectory, { recursive: true });
    await writeFile(filePath, "video");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory, store: {} });
    collector.videoDownloadJobs.set("download-expired", {
      id: "download-expired",
      status: "complete",
      filePath,
      updatedAt: new Date(Date.now() - 31 * 60 * 1_000).toISOString(),
      createdAt: new Date(Date.now() - 31 * 60 * 1_000).toISOString(),
    });

    try {
      collector.pruneVideoDownloadJobs();
      await vi.waitFor(async () => {
        await expect(access(filePath)).rejects.toThrow();
      });
      expect(collector.videoDownloadJobs.has("download-expired")).toBe(false);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("clears orphaned download files when the collector initializes", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "douyin-collector-download-cache-"));
    const filePath = path.join(dataDirectory, "downloads", "orphan.mp4");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "orphaned video");
    const collector = new DouyinCollector({
      executablePath: "chrome",
      dataDirectory,
      store: { load: vi.fn().mockResolvedValue(emptySnapshot()) },
    });

    try {
      await collector.initialize();
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

describe("DouyinCollector sync cancellation", () => {
  it("stops an active sync and keeps the last saved snapshot", async () => {
    let releaseRun;
    const runGate = new Promise((resolve) => {
      releaseRun = resolve;
    });
    const collector = new DouyinCollector({
      executablePath: "chrome",
      dataDirectory: ".local-data-test",
      store: {},
    });
    collector.snapshot = emptySnapshot();
    collector.runSync = vi.fn(async (runId) => {
      await runGate;
      collector.assertSyncActive(runId);
    });

    expect(collector.startSync()).toBe(true);
    const runningSync = collector.syncPromise;
    expect(collector.stopSync()).toBe(true);
    expect(collector.stopSync()).toBe(false);
    expect(collector.status).toMatchObject({
      state: "collecting",
      phase: null,
      message: "正在停止读取",
    });

    releaseRun();
    await runningSync;

    expect(collector.syncPromise).toBeNull();
    expect(collector.status).toMatchObject({
      state: "idle",
      phase: null,
      message: "已停止读取，已保留上次保存的记录",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0 },
    });
  });
});

describe("login identity", () => {
  const avatar = "https://p3-pc-sign.douyinpic.com/aweme/100x100/avatar.jpeg?x-expires=1&x-signature=a";

  // 在 node 里直接跑页面那段函数，页面全局用假的顶上
  async function readWith({ store, rendered, saved }) {
    const previous = { userInfoStore: globalThis.userInfoStore, document: globalThis.document, localStorage: globalThis.localStorage };
    if (store) globalThis.userInfoStore = { curLoginUserInfo: store };
    if (rendered) globalThis.document = { getElementById: (id) => id === "RENDER_DATA" ? { textContent: encodeURIComponent(JSON.stringify({ app: { user: rendered } })) } : null };
    if (saved) globalThis.localStorage = { getItem: (key) => key === "user_info" ? JSON.stringify(saved) : null };
    try {
      return await readLoginIdentity({ evaluate: async (callback) => callback() });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  }

  it("reads the logged-in user from the page store", async () => {
    await expect(readWith({
      store: { uid: "123456789012345", secUid: "MS4wLjABAAAA-store", nickname: "我", avatar300Url: avatar, avatarUrl: "https://p9-pc-sign.douyinpic.com/small.jpeg" },
    })).resolves.toEqual({ uid: "123456789012345", secUid: "MS4wLjABAAAA-store", nickname: "我", avatar });
  });

  it("falls back to RENDER_DATA before the store is ready, and never takes the cached secUid as the uid", async () => {
    await expect(readWith({
      rendered: { isLogin: true, info: { uid: "123456789012345", sec_uid: "MS4wLjABAAAA-render", nickname: "页面里的我", avatar_thumb: { url_list: [avatar.replace("https://", "http://")] } } },
      saved: { uid: "MS4wLjABAAAA-saved", nickname: "缓存里的我", avatarUrl: avatar },
    })).resolves.toEqual({ uid: "123456789012345", secUid: "MS4wLjABAAAA-render", nickname: "页面里的我", avatar });
    await expect(readWith({
      rendered: { isLogin: false, info: {} },
      saved: { uid: "MS4wLjABAAAA-saved", nickname: "缓存里的我", avatarUrl: avatar },
    })).resolves.toEqual({ uid: null, secUid: "MS4wLjABAAAA-saved", nickname: "缓存里的我", avatar });
  });

  it("returns null when nobody is logged in or the page cannot be read", async () => {
    await expect(readWith({ rendered: { isLogin: false } })).resolves.toBeNull();
    await expect(readLoginIdentity({ evaluate: vi.fn().mockRejectedValue(new Error("Execution context was destroyed")) })).resolves.toBeNull();
    await expect(readLoginIdentity({ evaluate: vi.fn().mockResolvedValue("me") })).resolves.toBeNull();
    await expect(readLoginIdentity(null)).resolves.toBeNull();
    // 不在抖音图床上的头像不要
    await expect(readLoginIdentity({ evaluate: vi.fn().mockResolvedValue({ uid: "1", nickname: "我", avatar: "https://evil.example/a.jpeg" }) }))
      .resolves.toEqual({ uid: "1", secUid: null, nickname: "我", avatar: null });
  });

  it("reports a changed identity once, writing the account list before the status", async () => {
    let finishWrite;
    const onAccountIdentity = vi.fn(() => new Promise((resolve) => { finishWrite = resolve; }));
    const collector = new DouyinCollector({
      executablePath: "chrome",
      dataDirectory: ".test",
      store: {},
      account: { id: "default", nickname: null, avatar: null, uid: null },
      onAccountIdentity,
    });
    expect(collector.getStatus().account).toEqual({ id: "default", nickname: null, avatar: null });
    const page = { evaluate: vi.fn().mockResolvedValue({ uid: "123", secUid: "MS4w-x", nickname: "我", avatar }) };
    // 采集流程只等核对，不等名单落盘
    await collector.assertAccountMatches(page);
    expect(onAccountIdentity).toHaveBeenCalledWith({ uid: "123", secUid: "MS4w-x", nickname: "我", avatar });
    expect(collector.getStatus().account).toEqual({ id: "default", nickname: null, avatar: null });
    finishWrite();
    await vi.waitFor(() => expect(collector.getStatus().account).toEqual({ id: "default", nickname: "我", avatar }));
    const revision = collector.getStatus().revision;
    await collector.assertAccountMatches(page);
    expect(collector.getStatus().revision).toBe(revision);
    expect(onAccountIdentity).toHaveBeenCalledTimes(1);
    // 读失败不抛、不改状态；回写失败也照样更新状态
    await expect(collector.assertAccountMatches({ evaluate: vi.fn().mockRejectedValue(new Error("closed")) })).resolves.toBeUndefined();
    onAccountIdentity.mockImplementation(() => Promise.reject(new Error("disk full")));
    await expect(collector.assertAccountMatches({ evaluate: vi.fn().mockResolvedValue({ uid: "123", nickname: "改名了" }) })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(collector.getStatus().account).toEqual({ id: "default", nickname: "改名了", avatar }));
  });

  describe("when CDP imports another Douyin account", () => {
    const other = { uid: "222", nickname: "别人" };
    const mine = { uid: "111", nickname: "我" };
    const accountCollector = (store = mockStore()) => {
      const onAccountIdentity = vi.fn(async () => undefined);
      const collector = new DouyinCollector({
        executablePath: "chrome",
        dataDirectory: ".test",
        store,
        account: { id: "aaaaaaaaaaaa", nickname: "我", avatar: null, uid: "111" },
        onAccountIdentity,
      });
      collector.snapshot = emptySnapshot();
      return { collector, onAccountIdentity, store };
    };

    it("refuses without touching the account, and keeps headless reads off until the right account is back", async () => {
      const { collector, onAccountIdentity } = accountCollector();
      await expect(collector.assertAccountMatches({ evaluate: vi.fn().mockResolvedValue(other) }))
        .rejects.toMatchObject({ code: "account_mismatch", message: expect.stringContaining("「别人」") });
      expect(onAccountIdentity).not.toHaveBeenCalled();
      expect(collector.accountUid).toBe("111");
      expect(collector.getStatus().account).toMatchObject({ nickname: "我" });

      collector.ensureBrowser = vi.fn();
      expect(collector.startDirectRecords()).toBe(true);
      await vi.waitFor(() => expect(collector.getStatus()).toMatchObject({ state: "error", code: "account_mismatch" }));
      expect(collector.ensureBrowser).not.toHaveBeenCalled();

      await collector.assertAccountMatches({ evaluate: vi.fn().mockResolvedValue(mine) });
      expect(collector.accountMismatch).toBe(false);
    });

    it("checks the HTTP account before saving anything from an incremental read", async () => {
      const runWith = (target, identity) => {
        const page = { goto: vi.fn(async () => undefined), evaluate: vi.fn().mockResolvedValue(identity), close: vi.fn(async () => undefined) };
        const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
        target.syncRunId = 1;
        target.ensureDirectApi = vi.fn(async () => { await target.assertAccountMatches(page); return context; });
        // 核对过了才轮到观看历史；让它直接停下，测试不用走完整个读取
        target.readDirectHistory = vi.fn(async () => { throw new Error("stop_here"); });
        target.collectDirectList = vi.fn();
        return target.runDirectRecords(1);
      };
      const { collector, store } = accountCollector();
      await expect(runWith(collector, other)).rejects.toMatchObject({ code: "account_mismatch" });
      // 观看历史还没读就拦下：别人的记录一条都没存
      expect(collector.readDirectHistory).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(collector.accountMismatch).toBe(true);

      // 还没认出过的账号：增量读取一打开页面就把昵称头像记下
      const onAccountIdentity = vi.fn(async () => undefined);
      const fresh = new DouyinCollector({
        executablePath: "chrome",
        dataDirectory: ".test",
        store: mockStore(),
        account: { id: "default", nickname: null, avatar: null, uid: null },
        onAccountIdentity,
      });
      fresh.snapshot = emptySnapshot();
      await expect(runWith(fresh, mine)).rejects.toThrow("stop_here");
      expect(onAccountIdentity).toHaveBeenCalledWith(expect.objectContaining({ uid: "111", nickname: "我" }));
      await vi.waitFor(() => expect(fresh.getStatus().account).toMatchObject({ id: "default", nickname: "我" }));
    });
  });
});

describe("DouyinCollector shutdown", () => {
  it("closes the browser and waits for running work and pending writes before returning", async () => {
    let finishWrite;
    const store = { writeQueue: new Promise((resolve) => { finishWrite = resolve; }) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.runDirectRecords = vi.fn(async (runId) => {
      await delay(30);
      collector.assertSyncActive(runId);
    });
    const context = { close: vi.fn(async () => undefined) };
    collector.context = context;
    collector.contextHeadless = true;
    expect(collector.startDirectRecords()).toBe(true);
    let done = false;
    const closing = collector.shutdown().then(() => { done = true; });
    await delay(60);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(collector.syncPromise).toBeNull();
    expect(done).toBe(false);
    finishWrite();
    await closing;
    expect(collector.context).toBeNull();
  });
});

describe("DouyinCollector sync startup", () => {
  it("replaces a stale terminal state before the async run yields", async () => {
    let finishRun;
    const runGate = new Promise((resolve) => {
      finishRun = resolve;
    });
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.status.state = "partial";
    collector.runDirectRecords = vi.fn().mockReturnValue(runGate);

    expect(collector.startSync()).toBe(true);
    expect(collector.getStatus().state).toBe("collecting");

    finishRun();
    await runGate;
  });

  it("exposes the error code so the app can react to a missing login", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.runDirectRecords = vi.fn().mockRejectedValue(new DirectHistoryError("login_required", "专用浏览器尚未登录"));

    expect(collector.startDirectRecords()).toBe(true);
    await collector.syncPromise;
    expect(collector.getStatus()).toMatchObject({ state: "error", code: "login_required", message: "专用浏览器尚未登录" });
  });
});

describe("DouyinCollector direct records", () => {
  it("bootstraps the history template from the official www-hj endpoint", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "douyin-headless-history-template-"));
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const requestUrl = new URL("https://www-hj.douyin.com/aweme/v1/web/history/read/");
    for (const [name, value] of Object.entries({
      count: "20",
      max_cursor: "0",
      device_platform: "webapp",
      aid: "6383",
      webid: "1234567890123456789",
      verifyFp: "test-private-fingerprint",
      fp: "test-private-fingerprint",
      uifid: "test-private-uifid",
      a_bogus: "test-private-signature",
    })) requestUrl.searchParams.append(name, value);
    const request = {
      url: () => requestUrl.toString(),
      headerValue: vi.fn(async () => null),
    };
    const response = { url: () => requestUrl.toString(), request: () => request };
    const page = {
      waitForResponse: vi.fn(async (predicate) => {
        expect(predicate(response)).toBe(true);
        expect(predicate({ url: () => "https://evil.example/aweme/v1/web/history/read/" })).toBe(false);
        return response;
      }),
      evaluate: vi.fn(async () => userAgent),
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory, store: {} });
    collector.syncRunId = 1;
    collector.visit = vi.fn(async () => undefined);
    collector.hasLoginSession = vi.fn(async () => true);
    collector.resolveOwnProfileUrl = vi.fn(async () => "https://www.douyin.com/user/account-id");

    try {
      await expect(collector.prepareDirectHistoryTemplate({}, page, 1)).resolves.toMatchObject({
        values: { aid: "6383", device_platform: "webapp" },
        headers: { "user-agent": userAgent },
      });
      expect(page.waitForResponse).toHaveBeenCalledTimes(1);
      expect(collector.visit).toHaveBeenLastCalledWith(
        page,
        "https://www.douyin.com/user/account-id?showTab=record",
        1,
      );
      const raw = await readFile(path.join(dataDirectory, "direct-history-template.json"), "utf8");
      expect(raw).not.toContain("test-private-");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reads each list through its last page and saves each completed phase", async () => {
    const initial = emptySnapshot();
    initial.warnings = [
      "其中 19 条缺少观看时间，已保持为空，未使用发布时间或采集时间替代。",
      "保留的其他提示。",
    ];
    initial.records.liked_videos = [{
      id: "liked_videos:liked-old",
      title: "旧点赞",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/liked-old",
      videoId: "liked-old",
    }];
    initial.records.favorite_videos = [{
      id: "favorite_videos:favorite-old",
      title: "旧收藏",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/favorite-old",
      videoId: "favorite-old",
    }];
    const store = mockStore("2026-08-13T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    const visibleContext = { close: vi.fn(async () => undefined) };
    collector.context = visibleContext;
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      await onPage({ status_code: 0, aweme_list: [{ aweme_id: type === "liked_videos" ? "liked-new" : "favorite-new" }], has_more: 0 }, 1);
      return 1;
    });
    collector.readDirectHistory = vi.fn(async (_context, cursor, options) => {
      if (options?.completedOnly) {
        return { status_code: 0, aweme_list: [{ aweme_id: "history-new" }], aweme_date: { "history-new": 1_700_000_000 }, has_more: 0 };
      }
      return cursor === "0" ? {
        status_code: 0,
        aweme_list: [{ aweme_id: "history-new", desc: "本次观看" }],
        aweme_date: { "history-new": 1_700_000_000 },
        has_more: 1,
        max_cursor: "1700000000000",
      } : {
        status_code: 0,
        aweme_list: [{ aweme_id: "history-second", desc: "上一页观看" }],
        aweme_date: { "history-second": 1_699_999_000 },
        has_more: 0,
      };
    });

    await collector.runDirectRecords(1);

    expect(collector.snapshot.records.watch_history[0]).toMatchObject({
      videoId: "history-new",
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
    });
    // 整份读完才替换：已经取消的旧喜欢、旧收藏不能留下来
    expect(collector.snapshot.records.liked_videos.map((record) => record.videoId)).toEqual(["liked-new"]);
    expect(collector.snapshot.records.favorite_videos.map((record) => record.videoId)).toEqual(["favorite-new"]);
    expect(collector.snapshot.records.watch_history).toHaveLength(2);
    expect(collector.readDirectHistory.mock.calls.map(([, cursor, options]) => [cursor, Boolean(options?.completedOnly)])).toEqual([
      ["0", false],
      ["1700000000000", false],
      ["0", true],
    ]);
    // the completed list reaches back only to history-new, so the older record stays unchecked
    expect(Object.fromEntries(collector.snapshot.records.watch_history.map((record) => [record.videoId, record.watchCompleted])))
      .toEqual({ "history-new": true, "history-second": undefined });
    expect(collector.status.state).toBe("complete");
    expect(store.save).toHaveBeenCalledTimes(4);
    expect(collector.snapshot.directSync).toEqual({
      watch_history: true,
      liked_videos: true,
      favorite_videos: true,
    });
    expect(visibleContext.close).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("finishes the sync with the records it read when the finished list can't be read", async () => {
    const store = mockStore("2026-08-13T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async () => 0);
    collector.readDirectHistory = vi.fn(async (_context, _cursor, options) => {
      if (options?.completedOnly) throw new DirectHistoryError("rate_limited", "限流");
      return { status_code: 0, aweme_list: [{ aweme_id: "saved-watch" }], aweme_date: { "saved-watch": 1_700_000_000 }, has_more: 0 };
    });

    await collector.runDirectRecords(1);

    expect(collector.status.state).toBe("complete");
    expect(collector.snapshot.records.watch_history.map((record) => [record.videoId, record.watchCompleted])).toEqual([["saved-watch", undefined]]);
  });

  it("does not save when the direct request fails", async () => {
    const store = { save: vi.fn() };
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async () => { throw new Error("request_failed"); });
    collector.readDirectHistory = vi.fn(async () => {
      throw new Error("request_failed");
    });

    await expect(collector.runDirectRecords(1)).rejects.toThrow("request_failed");
    expect(store.save).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("keeps a completed watch phase when a later direct list fails", async () => {
    const store = mockStore("2026-08-13T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.readDirectHistory = vi.fn(async () => ({
      status_code: 0,
      aweme_list: [{ aweme_id: "saved-watch", history_info: { view_time: 1_700_000_000 } }],
      has_more: 0,
    }));
    collector.collectDirectList = vi.fn(async () => {
      throw new Error("liked_request_failed");
    });

    await expect(collector.runDirectRecords(1)).rejects.toThrow("liked_request_failed");

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(collector.snapshot.records.watch_history.map((record) => record.videoId)).toEqual(["saved-watch"]);
    expect(collector.snapshot.directSync).toEqual({
      watch_history: true,
      liked_videos: false,
      favorite_videos: false,
    });
    expect(context.close).not.toHaveBeenCalled();
  });

  it("marks a type unfinished when an incremental read stops after saving new records", async () => {
    const initial = emptySnapshot();
    initial.warnings = ["无界面读取完成：新增观看 0、点赞 0、收藏 0；读取观看历史 1 页、点赞 1 页、收藏 1 页。"];
    initial.directSync = normalizeDirectSyncState({ watch_history: true, liked_videos: true, favorite_videos: true });
    initial.records.watch_history = [{
      id: "watch_history:history-old:2023-11-14T22:13:20.000Z",
      title: "旧观看",
      author: null,
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
      url: "https://www.douyin.com/video/history-old",
      videoId: "history-old",
    }];
    const store = mockStore("2026-08-14T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.progressPersistIntervalMs = 0;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.readDirectHistory = vi.fn()
      .mockResolvedValueOnce({
        status_code: 0,
        aweme_list: [{ aweme_id: "history-new", history_info: { view_time: 1_700_003_600 } }],
        has_more: 1,
        max_cursor: "1700003000000",
      })
      .mockRejectedValueOnce(new DirectHistoryError("rate_limited", "请求太频繁"));

    await expect(collector.runDirectRecords(1)).rejects.toThrow("请求太频繁");

    const [savedRecords, savedWarnings, savedOptions] = store.save.mock.calls.at(-1);
    expect(savedRecords.watch_history.map((record) => record.videoId)).toContain("history-new");
    expect(savedOptions.directSync).toMatchObject({ watch_history: false, liked_videos: true, favorite_videos: true });
    // 重新载入时旧的「读取完成」提示不能把它盖回已完成，否则下次又只读到 history-new 就停
    expect(normalizeDirectSyncState(savedOptions.directSync, savedWarnings).watch_history).toBe(false);
  });

  it.each([
    ["an incremental like read", true],
    ["a full like re-read", false],
  ])("keeps saved likes when %s stops halfway", async (_label, likesComplete) => {
    const initial = emptySnapshot();
    initial.directSync = normalizeDirectSyncState({ watch_history: true, liked_videos: likesComplete, favorite_videos: true });
    initial.records.watch_history = [{
      id: "watch_history:history-old:2023-11-14T22:13:20.000Z",
      title: "旧观看",
      author: null,
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
      url: "https://www.douyin.com/video/history-old",
      videoId: "history-old",
    }];
    initial.records.liked_videos = ["liked-a", "liked-b"].map((videoId) => ({
      id: `liked_videos:${videoId}`,
      title: videoId,
      author: null,
      occurredAt: null,
      url: `https://www.douyin.com/video/${videoId}`,
      videoId,
    }));
    const store = mockStore("2026-08-14T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.progressPersistIntervalMs = 0;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.readDirectHistory = vi.fn(async () => ({
      status_code: 0,
      aweme_list: [{ aweme_id: "history-old", history_info: { view_time: 1_700_000_000 } }],
      has_more: 0,
    }));
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      await onPage({ status_code: 0, aweme_list: [{ aweme_id: "liked-new" }], has_more: 1, max_cursor: "1" }, 1);
      throw new DirectHistoryError("rate_limited", "请求太频繁");
    });

    await expect(collector.runDirectRecords(1)).rejects.toThrow("请求太频繁");

    for (const [records, , options] of store.save.mock.calls) {
      expect(options.directSync.liked_videos).toBe(likesComplete);
      // 标着读完的存盘里不能出现只读了一半的新喜欢，否则下次增量会在它身上停住
      if (options.directSync.liked_videos) expect(records.liked_videos.map((record) => record.videoId)).not.toContain("liked-new");
    }
    const savedLikes = store.save.mock.calls.at(-1)[0].liked_videos.map((record) => record.videoId);
    expect(savedLikes).toEqual(expect.arrayContaining(["liked-a", "liked-b"]));
  });

  it("reads only through the known boundary after a completed direct sync", async () => {
    const initial = emptySnapshot();
    initial.warnings = ["自动读取留下的普通提示，不应影响增量状态。"];
    initial.directSync = normalizeDirectSyncState({
      watch_history: true,
      liked_videos: true,
      favorite_videos: true,
    });
    initial.records.watch_history = [{
      id: "watch_history:history-old:2023-11-14T22:13:20.000Z",
      title: "旧观看",
      author: null,
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
      url: "https://www.douyin.com/video/history-old",
      videoId: "history-old",
    }, {
      id: "watch_history:history-old",
      title: "必须原样保留的无日期旧记录",
      author: null,
      occurredAt: null,
      occurredAtSource: "unknown",
      url: "https://www.douyin.com/video/history-old",
      videoId: "history-old",
    }, {
      id: "watch_history:history-low:2023-11-14T21:13:20.000Z",
      title: "低于阈值的旧观看",
      author: null,
      occurredAt: "2023-11-14T21:13:20.000Z",
      occurredAtSource: "platform_action",
      url: "https://www.douyin.com/video/history-low",
      videoId: "history-low",
    }];
    initial.records.liked_videos = [{
      id: "liked_videos:liked-old",
      title: "旧点赞",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/liked-old",
      videoId: "liked-old",
    }];
    initial.records.favorite_videos = [{
      id: "favorite_videos:favorite-old",
      title: "旧收藏",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/favorite-old",
      videoId: "favorite-old",
    }];
    const store = mockStore("2026-08-14T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.readDirectHistory = vi.fn(async (_context, _cursor, options) => options?.completedOnly ? {
      status_code: 0,
      aweme_list: [],
      has_more: 0,
    } : ({
      status_code: 0,
      aweme_list: [
        { aweme_id: "history-new", history_info: { view_time: 1_700_003_600 } },
        {
          aweme_id: "history-low",
          history_info: { view_time: 1_699_996_400 },
          play_progress: { play_progress: 500 },
          video: { duration: 10_000 },
        },
        { aweme_id: "history-old", history_info: { view_time: 1_700_000_000 } },
      ],
      has_more: 1,
      max_cursor: "1699999000000",
    }));
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      const prefix = type === "liked_videos" ? "liked" : "favorite";
      const shouldContinue = await onPage({
        status_code: 0,
        aweme_list: [
          { aweme_id: `${prefix}-new` },
          {
            aweme_id: `${prefix}-old`,
            play_progress: { last_modified_time: 1_700_000_000 },
          },
        ],
        has_more: 1,
        ...(type === "liked_videos" ? { max_cursor: "1" } : { cursor: "1" }),
      }, 1);
      expect(shouldContinue).toBe(false);
      return 1;
    });

    await collector.runDirectRecords(1);

    expect(collector.readDirectHistory.mock.calls.filter(([, , options]) => !options?.completedOnly)).toHaveLength(1);
    expect(collector.snapshot.records.watch_history).toHaveLength(4);
    expect(collector.snapshot.records.watch_history.map((record) => record.id)).toContain("watch_history:history-old");
    expect(collector.snapshot.records.watch_history.map((record) => record.videoId)).toContain("history-low");
    expect(collector.snapshot.records.liked_videos).toHaveLength(2);
    expect(collector.snapshot.records.favorite_videos).toHaveLength(2);
    expect(collector.snapshot.records.liked_videos.find((record) => record.videoId === "liked-old")).toMatchObject({
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
    });
    expect(collector.snapshot.records.favorite_videos.find((record) => record.videoId === "favorite-old")).toMatchObject({
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
    });
    expect(collector.status.message).toBe("已读取新增记录（观看 1、点赞 1、收藏 1）");
    expect(store.save).toHaveBeenCalledTimes(3);
  });

  it("does not save when direct pagination repeats a cursor", async () => {
    const store = { save: vi.fn() };
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async () => 1);
    collector.readDirectHistory = vi.fn(async () => ({
      status_code: 0,
      aweme_list: [{ aweme_id: "history-new" }],
      has_more: 1,
      max_cursor: "1700000000000",
    }));

    await expect(collector.runDirectRecords(1)).rejects.toMatchObject({ code: "pagination_stalled" });
    expect(collector.readDirectHistory).toHaveBeenCalledTimes(2);
    expect(store.save).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("merges a complete direct result without deleting older watch history", async () => {
    const initial = emptySnapshot();
    initial.records.watch_history = Array.from({ length: 80 }, (_, index) => ({
      id: `watch_history:existing-${index}`,
      title: `既有记录 ${index}`,
      author: null,
      occurredAt: null,
      occurredAtSource: "unknown",
      url: `https://www.douyin.com/video/existing-${index}`,
      videoId: `existing-${index}`,
    }));
    const store = mockStore("2026-08-13T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      await onPage({ status_code: 0, aweme_list: [{ aweme_id: `${type}-new` }], has_more: 0 }, 1);
      return 1;
    });
    collector.readDirectHistory = vi.fn(async () => ({
      status_code: 0,
      aweme_list: [{
        aweme_id: "history-new",
        desc: "本次记录",
        history_info: { view_time: 1_700_000_000 },
      }],
      has_more: 0,
    }));

    await collector.runDirectRecords(1);

    expect(collector.snapshot.records.watch_history).toHaveLength(81);
    expect(collector.snapshot.records.watch_history.map((record) => record.videoId)).toContain("history-new");
    expect(collector.snapshot.records.watch_history.map((record) => record.videoId)).toContain("existing-0");
  });
});

describe("DouyinCollector concurrent HTTP work", () => {
  function receivingCollector() {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.snapshot = emptySnapshot();
    collector.chat = { active: true, mode: "chat", page: {}, stop: vi.fn() };
    collector.chatPromise = Promise.resolve();
    collector.updateChat({ state: "observing", connection: "connected" });
    collector.contextHeadless = true;
    return collector;
  }

  it("reads records without interrupting reception", () => {
    const collector = receivingCollector();
    collector.runDirectRecords = vi.fn(() => new Promise(() => {}));
    expect(collector.startSync({ mode: "direct_records" })).toBe(true);
    expect(collector.isChatReceiving()).toBe(true);
    // 记录读取写主状态，聊天写自己那份，谁也不盖谁
    collector.updateStatus({ state: "collecting", message: "正在读取观看历史", counts: { ...collector.status.counts, watch_history: 7 } });
    expect(collector.getStatus()).toMatchObject({
      state: "collecting",
      syncMode: "direct_records",
      chat: expect.objectContaining({ state: "observing", connection: "connected" }),
    });
    expect(collector.getStatus().counts.watch_history).toBe(7);
  });

  it("starts reception while records are being read", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.snapshot = emptySnapshot();
    collector.runDirectRecords = vi.fn(() => new Promise(() => {}));
    collector.runChatObservation = vi.fn(() => new Promise(() => {}));
    expect(collector.startSync({ mode: "direct_records" })).toBe(true);
    expect(collector.startChatObservation()).toBe(true);
    expect(collector.startVideoDownload("https://www.douyin.com/video/1234567890").status).toBe("queued");
  });

  it("saves each page of a direct read instead of waiting for the whole list", async () => {
    const store = mockStore();
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), goto: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.progressPersistIntervalMs = 0;
    collector.ensureDirectApi = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      await onPage({ status_code: 0, aweme_list: [{ aweme_id: `${type}-page-1` }], has_more: 0 }, 1);
      return 1;
    });
    let cursor = 0;
    collector.readDirectHistory = vi.fn(async () => {
      cursor += 1;
      return {
        status_code: 0,
        aweme_list: [{ aweme_id: `history-${cursor}` }],
        has_more: cursor < 2 ? 1 : 0,
        max_cursor: String(1_700_000_000_000 + cursor),
      };
    });
    const saved = [];
    store.save.mockImplementation(async (records) => {
      saved.push(records.watch_history.length);
      return { ...emptySnapshot(), records: structuredClone(records), updatedAt: "2026-08-09T00:10:00.000Z" };
    });

    await collector.runDirectRecords(1);

    // 第一页读完就已经存过一次，不用等整份观看历史读完
    expect(saved.slice(0, 2)).toEqual([1, 2]);
    expect(store.save.mock.calls.length).toBeGreaterThan(3);
  });
});
