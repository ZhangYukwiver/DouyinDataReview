import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  directContextLaunchOptions,
  DouyinCollector,
  normalizeChatConversationCatalog,
  normalizeOwnProfileUrl,
  profileTabUrl,
  readChatConversationCatalog,
} from "./douyinCollector.mjs";
import { DirectHistoryError } from "./directHistory.mjs";
import { createEmptyRecords } from "./normalizer.mjs";
import { createEndpointProgress } from "./progress.mjs";
import { normalizeDirectSyncState } from "./store.mjs";
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

describe("collector browser page selection", () => {
  it("opens a normal tab instead of navigating Comet's internal welcome page", async () => {
    const collector = new DouyinCollector({ dataDirectory: "/tmp/dy-page-selection", store: {} });
    const normalPage = { isClosed: () => false, url: () => "about:blank" };
    const internal = { isClosed: () => false, url: () => "chrome://perplexity-onboarding/" };
    const context = { pages: () => [internal], newPage: vi.fn(async () => normalPage) };
    expect(await collector.currentPage(context)).toBe(normalPage);
    expect(context.newPage).toHaveBeenCalledOnce();
    context.pages = () => [internal, normalPage];
    expect(await collector.currentPage(context)).toBe(normalPage);
    expect(context.newPage).toHaveBeenCalledOnce();
  });
});

describe("normalizeChatConversationCatalog", () => {
  it("normalizes contact nickname aliases and safe avatar candidates", () => {
    expect(normalizeChatConversationCatalog([
      {
        id: "friend-1",
        kind: "friend",
        nickname: "联系人甲",
        avatar_thumb: { url_list: ["https://p3.douyinpic.com/contact.jpg"] },
      },
      {
        id: "friend-2",
        kind: "friend",
        nickName: "联系人乙",
        avatarUrl: "https://evil.example/avatar.jpg",
      },
    ])).toEqual([
      {
        id: "friend-1",
        kind: "friend",
        name: "联系人甲",
        avatarUrl: "https://p3.douyinpic.com/contact.jpg",
      },
      {
        id: "friend-2",
        kind: "friend",
        name: "联系人乙",
      },
    ]);
  });

  it("joins a direct conversation with the participant profile store", async () => {
    const previousConversationStore = globalThis.conversationStore;
    const previousUserInfoStore = globalThis.userInfoStore;
    globalThis.conversationStore = {
      sortedConversationIdList: ["friend-1", "group-1"],
      sortedStrangerConversationIdList: [],
      conversationMap: new Map([
        ["friend-1", { toParticipantSecUserId: "sec-friend" }],
        ["group-1", { toParticipantSecUserId: "" }],
      ]),
      strangerConversationMap: new Map(),
      participantMapWithConversationId: new Map([
        ["friend-1", new Map([
          ["me", { userId: "me", secUid: "sec-me" }],
          ["friend", { userId: "friend", secUid: "sec-friend" }],
        ])],
        ["group-1", new Map([
          ["me", { userId: "me", secUid: "sec-me" }],
          ["member-1", { userId: "member-1", secUid: "sec-member-1" }],
          ["member-2", { userId: "member-2", secUid: "sec-member-2" }],
        ])],
      ]),
    };
    globalThis.userInfoStore = {
      curLoginUserInfo: { uid: "me" },
      usersInfoMap: new Map([["friend", {
        nickname: "联系人甲",
        avatar_thumb: { url_list: ["https://p3.douyinpic.com/contact.jpg"] },
      }]]),
    };
    try {
      const page = { evaluate: async (callback) => callback() };
      expect(await readChatConversationCatalog(page)).toEqual([
        {
          id: "friend-1",
          kind: "friend",
          name: "联系人甲",
          avatarUrl: "https://p3.douyinpic.com/contact.jpg",
        },
        {
          id: "group-1",
          kind: "group",
          name: null,
        },
      ]);
    } finally {
      if (previousConversationStore === undefined) delete globalThis.conversationStore;
      else globalThis.conversationStore = previousConversationStore;
      if (previousUserInfoStore === undefined) delete globalThis.userInfoStore;
      else globalThis.userInfoStore = previousUserInfoStore;
    }
  });
});

function fakeContext(page) {
  const handlers = new Map();
  return {
    pages: () => [page],
    on: (event, handler) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: (event, value) => {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
}

function collectorForResponses(initialSnapshot, responses) {
  const page = { url: () => "https://www.douyin.com/user/account-id?showTab=favorite_collection" };
  const context = fakeContext(page);
  const store = mockStore();
  const collector = new DouyinCollector({
    executablePath: "chrome",
    dataDirectory: ".local-data-test",
    store,
  });
  collector.snapshot = initialSnapshot;
  collector.context = context;
  collector.syncRunId = 1;
  collector.ensureBrowser = vi.fn().mockResolvedValue(context);
  collector.currentPage = vi.fn().mockResolvedValue(page);
  collector.visit = vi.fn().mockResolvedValue(undefined);
  collector.waitForLogin = vi.fn().mockResolvedValue(undefined);
  collector.collectPhase = vi.fn(async (_page, _versions, phase) => {
    if (responses[phase]) context.emit("response", responses[phase]);
  });
  return { collector, store };
}

const terminalEmptyVideos = { status_code: 0, aweme_list: [], has_more: 0 };

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

describe("direct browser launch options", () => {
  it("uses a real headless Chrome context on Windows", () => {
    expect(directContextLaunchOptions({
      executablePath: "chrome.exe",
      userAgent: "test-agent",
      platform: "win32",
    })).toMatchObject({
      executablePath: "chrome.exe",
      headless: true,
      userAgent: "test-agent",
      args: [
        "--headless=new",
        "--window-size=1280,900",
      ],
    });
  });

  it("uses the same hidden mode on non-Windows platforms", () => {
    expect(directContextLaunchOptions({
      executablePath: "chromium",
      userAgent: "test-agent",
      platform: "linux",
    })).toMatchObject({
      headless: true,
      args: ["--headless=new", "--window-size=1280,900"],
    });
  });
});

describe("video download jobs", () => {
  it("skips abandoned queued playback while preserving an explicit download", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureBrowser = vi.fn();
    const playback = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    collector.releaseVideoPlayback(playback.id);
    await collector.videoDownloadQueue;
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
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
    collector.ensureBrowser = vi.fn(() => new Promise((resolve) => { release = () => resolve(context); }));
    const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890", { playback: true });
    await vi.waitFor(() => expect(collector.getVideoDownloadJob(job.id).status).toBe("running"));
    expect(collector.releaseVideoPlayback(job.id)).toBe(true);
    release();
    await collector.videoDownloadQueue;
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    expect(collector.hasActiveVideoDownload()).toBe(false);
    expect(collector.getVideoDownloadJob(job.id)).toBeNull();
  });

  it("removes only the released playback directory after the file has been read", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "playback-release-"));
    try {
      const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory, store: {} });
      const playbackDir = path.join(dataDirectory, "downloads", "playback-owned");
      await mkdir(playbackDir, { recursive: true });
      await writeFile(path.join(playbackDir, "video.mp4"), "temporary");
      const manualFile = path.join(dataDirectory, "downloads", "saved.mp4");
      await writeFile(manualFile, "saved");
      collector.videoDownloadJobs.set("owned", { id: "owned", playback: true, status: "complete" });
      collector.releaseVideoPlayback("owned");
      await vi.waitFor(async () => { await expect(access(playbackDir)).rejects.toThrow(); });
      await expect(access(manualFile)).resolves.toBeUndefined();
    } finally { await rm(dataDirectory, { recursive: true, force: true }); }
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

  it("restores the terminal collector status after its headless context closes on failure", async () => {
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
    collector.ensureBrowser = vi.fn(async () => {
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

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(collector.getStatus()).toEqual({ ...previousStatus, revision: expect.any(Number) });
    expect(collector.getStatus().revision).toBeGreaterThan(previousStatus.revision);
  });

  it("restores the terminal collector status when headless launch fails", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.status = {
      ...collector.status,
      state: "complete",
      message: "上一轮读取已完成",
      browserOpen: false,
    };
    const previousStatus = collector.getStatus();
    collector.ensureBrowser = vi.fn(async () => {
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

  it("blocks sync and observation while a download is running", async () => {
    let releaseBrowser;
    const browserGate = new Promise((resolve) => { releaseBrowser = resolve; });
    const context = { close: vi.fn(async () => undefined) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.ensureBrowser = vi.fn(async () => {
      collector.context = context;
      collector.contextHeadless = true;
      await browserGate;
      return context;
    });
    const job = {
      id: "download-concurrency",
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
    const running = collector.runVideoDownloadJob(job);
    await vi.waitFor(() => expect(job.status).toBe("running"));

    expect(collector.startSync()).toBe(false);
    expect(collector.startObservation()).toBe(false);

    releaseBrowser();
    await running;
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

  it("rejects account switching while a download is queued or running", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.videoDownloadJobs.set("download-switch-blocked", {
      id: "download-switch-blocked",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(collector.switchAccount()).rejects.toMatchObject({
      name: "VideoDownloadError",
      code: "collector_busy",
    });
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

describe("DouyinCollector account switching", () => {
  it("cancels the active run, clears dedicated account data and local records, then starts manual observation", async () => {
    const clearedSnapshot = emptySnapshot();
    const store = { clear: vi.fn().mockResolvedValue(clearedSnapshot) };
    const collector = new DouyinCollector({
      executablePath: "chrome",
      dataDirectory: ".local-data-test",
      store,
    });
    collector.snapshot = {
      ...emptySnapshot(),
      records: {
        ...createEmptyRecords(),
        liked_videos: [{
          id: "liked_videos:old",
          title: "旧账号记录",
          author: null,
          occurredAt: null,
          url: "https://www.douyin.com/video/old",
        }],
      },
    };
    collector.context = {};
    collector.syncRunId = 4;
    collector.clearDedicatedAccountData = vi.fn().mockResolvedValue(undefined);
    collector.close = vi.fn().mockImplementation(async () => {
      collector.context = null;
    });
    collector.startObservation = vi.fn().mockReturnValue(true);

    await expect(collector.switchAccount()).resolves.toBe(true);

    expect(collector.syncRunId).toBe(5);
    expect(collector.clearDedicatedAccountData).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(collector.snapshot.records.liked_videos).toEqual([]);
    expect(collector.startObservation).toHaveBeenCalledWith({ allowAccountSwitch: true });
  });

  it("rejects a normal sync while account data is being cleared", async () => {
    let releaseClear;
    const clearGate = new Promise((resolve) => {
      releaseClear = resolve;
    });
    const store = { clear: vi.fn().mockResolvedValue(emptySnapshot()) };
    const collector = new DouyinCollector({
      executablePath: "chrome",
      dataDirectory: ".local-data-test",
      store,
    });
    collector.snapshot = emptySnapshot();
    collector.context = {};
    collector.clearDedicatedAccountData = vi.fn().mockReturnValue(clearGate);
    collector.close = vi.fn().mockImplementation(async () => {
      collector.context = null;
    });
    collector.runSync = vi.fn().mockResolvedValue(undefined);
    collector.startObservation = vi.fn().mockReturnValue(true);

    const switching = collector.switchAccount();
    expect(collector.startSync()).toBe(false);
    releaseClear();

    await expect(switching).resolves.toBe(true);
    expect(collector.startObservation).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledTimes(1);
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
    collector.runSync = vi.fn().mockReturnValue(runGate);

    expect(collector.startSync()).toBe(true);
    expect(collector.getStatus().state).toBe("launching_browser");

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

describe("DouyinCollector manual observation", () => {
  it("shares its browser only after manual observation is ready", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.observation = { active: true, mode: "records" };
    collector.contextHeadless = false;
    collector.updateStatus({ state: "launching_browser" });
    expect(collector.isManualObserving()).toBe(false);
    collector.updateStatus({ state: "observing" });
    expect(collector.isManualObserving()).toBe(true);
    collector.observation.active = false;
    expect(collector.isManualObserving()).toBe(false);
    // 聊天接收走自己那条线，不算手动监听
    collector.observation = null;
    collector.chat = { active: true, mode: "chat" };
    collector.updateChat({ state: "observing" });
    expect(collector.isManualObserving()).toBe(false);
  });
  it("persists only responses produced while the user browses the dedicated browser", async () => {
    const page = { url: () => "https://www.douyin.com/" };
    const context = fakeContext(page);
    const store = mockStore("2026-08-09T00:20:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);

    expect(collector.startObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.getStatus().state).toBe("observing"));

    context.emit("response", fakeResponse("/aweme/v1/web/history/read/", {
      status_code: 0,
      aweme_list: [{ aweme_id: "manual-history", desc: "手动浏览" }],
      has_more: 1,
      max_cursor: "next-page",
    }));
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));

    expect(collector.getSnapshot().records.watch_history.map((record) => record.id))
      .toEqual(["watch_history:manual-history"]);
    expect(collector.getSnapshot().warnings).toContain(
      "手动监听模式：仅保存你在独立浏览器中实际浏览到的数据，完整性不会自动验证。",
    );
    expect(collector.startSync()).toBe(false);

    await expect(collector.stopObservation()).resolves.toBe(true);
    expect(collector.getStatus().state).toBe("idle");
  });

  it("captures IM chat responses into the independent chat message collection", async () => {
    const page = { url: () => "https://www.douyin.com/" };
    const context = fakeContext(page);
    const store = mockStore("2026-08-09T00:25:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);

    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.getStatus().chat.state).toBe("observing"));
    expect(collector.ensureBrowser).toHaveBeenCalledWith({ headless: true });

    context.emit("response", {
      url: () => "https://imapi.douyin.com/v1/message/get_by_conversation",
      ok: () => true,
      status: () => 200,
      headers: () => ({}),
      json: () => Promise.resolve({ msgs: [{
        conv_id: "conv-1",
        server_id: "chat-call-1",
        type_code: 193,
        content_json: { aweType: 193, tips: "通话了 3 分 28 秒" },
      }] }),
    });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    expect(collector.getSnapshot().chatMessages).toMatchObject([{
      id: "chat-call-1",
      type: "call",
      callDurationSeconds: 208,
    }]);

    await expect(collector.stopChatObservation()).resolves.toBe(true);
  });

  it("reloads an already-open chat page so its initial messages are not missed", async () => {
    let context;
    const page = {
      url: () => "https://www.douyin.com/chat?isPopup=1",
      reload: vi.fn(async () => {
        context.emit("response", {
          url: () => "https://imapi.douyin.com/v1/message/get_by_conversation",
          ok: () => true,
          status: () => 200,
          headers: () => ({}),
          json: () => Promise.resolve({ msgs: [{
            conv_id: "conv-reload",
            server_id: "chat-reload-1",
            type_code: 7,
            content_json: { text: "重载后捕获" },
          }] }),
        });
      }),
    };
    context = fakeContext(page);
    const store = mockStore("2026-08-09T00:30:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);

    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    expect(collector.ensureBrowser).toHaveBeenCalledWith({ headless: true });
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(collector.getSnapshot().chatMessages).toMatchObject([{ id: "chat-reload-1", text: "重载后捕获" }]);

    await expect(collector.stopChatObservation()).resolves.toBe(true);
  });

  it("stores friend bodies but only group aggregates", async () => {
    const page = {
      url: () => "https://www.douyin.com/",
      evaluate: vi.fn(async (fn) => String(fn).includes("userInfoStore") ? "me" : []),
    };
    const context = fakeContext(page);
    const store = mockStore("2026-08-09T00:26:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);

    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.getStatus().chat.state).toBe("observing"));
    context.emit("response", {
      url: () => "https://imapi.douyin.com/v1/message/get_by_conversation",
      ok: () => true,
      status: () => 200,
      headers: () => ({}),
      json: () => Promise.resolve({
        conversations: [{ id: "group-1", kind: "group", name: "测试群" }],
        msgs: [
          { conv_id: "group-1", conversation_type: 2, server_id: "group-1", sender_uid: "me", type_code: 7, content_json: { text: "群正文" } },
          { conv_id: "friend-1", conversation_type: 1, server_id: "friend-1", sender_uid: "me", type_code: 7, content_json: { text: "好友正文" } },
        ],
      }),
    });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    expect(collector.getSnapshot().chatMessages).toEqual([expect.objectContaining({ id: "friend-1", text: "好友正文" })]);
    expect(collector.getSnapshot().chatMessages).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "group-1" })]));
    expect(collector.getSnapshot().chatConversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "group-1", kind: "group", name: "测试群", messageCount: 1, ownMessageCount: 1 }),
      expect.objectContaining({ id: "friend-1", kind: "friend", messageCount: 1, ownMessageCount: 1 }),
    ]));
    await expect(collector.stopChatObservation()).resolves.toBe(true);
  });

  it("continues receiving after history finishes, reconnects without duplicates, and stops explicitly", async () => {
    const page = Object.assign(new EventEmitter(), {
      url: () => "https://www.douyin.com/",
      evaluate: vi.fn(async (fn) => {
        const source = String(fn);
        if (source.includes("sortedConversationIdList")) return [{ id: "friend-once", kind: "friend", name: "好友" }];
        if (source.includes("userInfoStore")) return "me";
        if (source.includes("setCurConversation")) return true;
        return null;
      }),
    });
    const context = fakeContext(page);
    const removeListener = vi.spyOn(context, "off");
    context.close = vi.fn(async () => undefined);
    const store = mockStore("2026-08-09T00:27:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.context = context;
    collector.contextHeadless = true;
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);
    const statusUpdates = vi.spyOn(collector, "updateStatus");

    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.getStatus().chat.state).toBe("observing"));
    context.emit("response", {
      url: () => "https://imapi.douyin.com/v1/message/get_by_conversation",
      ok: () => true,
      status: () => 200,
      headers: () => ({}),
      json: () => Promise.resolve({
        has_more: 0,
        msgs: [{
          conv_id: "friend-once",
          conversation_type: 1,
          server_id: "chat-once-1",
          sender_uid: "me",
          type_code: 7,
          content_json: { text: "历史消息" },
        }],
      }),
    });

    await vi.waitFor(() => expect(collector.getStatus().chat.progress).toBeNull(), { timeout: 5_000 });
    expect(collector.chatPromise).not.toBeNull();
    expect(collector.getStatus()).toMatchObject({ browserOpen: true, chat: expect.objectContaining({ state: "observing" }) });
    expect(statusUpdates.mock.calls.some(([patch]) => patch.chat?.progress?.current === 1 && patch.chat?.progress?.total === 1)).toBe(true);
    expect(statusUpdates.mock.calls.some(([patch]) => /聊天全量读取.*1\/1/u.test(patch.chat?.message ?? ""))).toBe(true);
    expect(collector.getStatus().chat.progress).toBeNull();
    expect(removeListener).not.toHaveBeenCalledWith("response", expect.any(Function));
    expect(context.close).not.toHaveBeenCalled();
    expect(collector.getSnapshot().chatMessages).toEqual([expect.objectContaining({ id: "chat-once-1" })]);

    const lateResponse = {
      url: () => "https://imapi.douyin.com/v1/message/get_by_conversation",
      ok: () => true,
      status: () => 200,
      headers: () => ({}),
      json: () => Promise.resolve({ msgs: [{
        conv_id: "friend-once",
        server_id: "chat-live",
        type_code: 7,
        content_json: { text: "历史整理后收到的新消息" },
      }] }),
    };
    context.emit("response", lateResponse);
    await vi.waitFor(() => expect(collector.getSnapshot().chatMessages).toHaveLength(2));
    const socket = Object.assign(new EventEmitter(), { url: () => "wss://frontier-im.douyin.com/ws/v2" });
    page.emit("websocket", socket);
    const push = JSON.stringify({ body: { has_new_message_notify: {
      conversation_id: "friend-once", conversation_type: 1,
      message: { server_message_id: "chat-live", message_type: 7, content: JSON.stringify({ text: "历史整理后收到的新消息" }) },
    } } });
    socket.emit("framereceived", { payload: push });
    expect(collector.getStatus().chatConnection).toBe("connected");
    socket.emit("close");
    expect(collector.getStatus().chatConnection).toBe("reconnecting");
    const reconnected = Object.assign(new EventEmitter(), { url: socket.url });
    page.emit("websocket", reconnected);
    reconnected.emit("framereceived", { payload: push });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.getStatus().chatConnection).toBe("connected");
    expect(collector.getSnapshot().chatMessages).toHaveLength(2);

    await expect(collector.stopChatObservation()).resolves.toBe(true);
    expect(collector.getStatus()).toMatchObject({ state: "idle", chatConnection: null });
    expect(collector.chatPromise).toBeNull();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("response", expect.any(Function));
    const saveCount = store.save.mock.calls.length;
    context.emit("response", lateResponse);
    reconnected.emit("framereceived", { payload: push });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.save).toHaveBeenCalledTimes(saveCount);
    expect(reconnected.eventNames()).toEqual([]);
  });

  it("increments a stored group summary for new messages without persisting group bodies or counting replays", async () => {
    const page = { url: () => "https://www.douyin.com/", evaluate: vi.fn(async (fn) => String(fn).includes("sortedConversationIdList") ? [] : "me") };
    const context = fakeContext(page), store = mockStore();
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = { ...emptySnapshot(), chatConversations: [{ id: "group-live", kind: "group", name: "测试群", messageCount: 100, ownMessageCount: 20 }] };
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);
    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.getStatus().chat.state).toBe("observing"));
    const response = fakeResponse("/v1/message/get_by_conversation", { msgs: [
      { conv_id: "group-live", conversation_type: 2, server_id: "group-old", sender_uid: "other", type_code: 7, created_at_us: Date.parse("2026-08-08T23:59:00Z") * 1000, content_json: { text: "历史群正文" } },
      { conv_id: "group-live", conversation_type: 2, server_id: "group-new", sender_uid: "me", type_code: 7, created_at_us: Date.parse("2026-08-09T00:01:00Z") * 1000, content_json: { text: "新群正文" } },
    ] });
    response.url = () => "https://imapi.douyin.com/v1/message/get_by_conversation";
    context.emit("response", response);
    await vi.waitFor(() => expect(collector.getSnapshot().chatConversations[0]).toMatchObject({ messageCount: 101, ownMessageCount: 21 }));
    context.emit("response", response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.getSnapshot().chatConversations[0]).toMatchObject({ messageCount: 101, ownMessageCount: 21 });
    expect(collector.getSnapshot().chatMessages).toEqual([]);
    await collector.stopChatObservation();
  });

  it("allows downloads during reception and pauses only the chat tab when another feature shares the browser", async () => {
    const page = { close: vi.fn(async () => {}) }, otherPage = { close: vi.fn(async () => {}) };
    const context = { pages: () => [page, otherPage], close: vi.fn(async () => {}) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.snapshot = emptySnapshot();
    collector.context = context;
    collector.contextHeadless = true;
    collector.chat = { active: true, mode: "chat", page, stop: vi.fn() };
    collector.chatPromise = Promise.resolve();
    collector.updateStatus({ state: "observing", phase: "chat_messages", chatConnection: "connected" });
    collector.runVideoDownloadJob = vi.fn(async () => {});
    expect(collector.startVideoDownload("https://www.douyin.com/video/1234567890").status).toBe("queued");
    await collector.videoDownloadQueue;
    expect(collector.runVideoDownloadJob).toHaveBeenCalledTimes(1);
    await collector.stopChatObservation();
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
    expect(otherPage.close).not.toHaveBeenCalled();
  });

  it("closes a chat context before waiting for a pending navigation to cancel", async () => {
    let rejectVisit;
    const page = { url: () => "https://www.douyin.com/" };
    const context = fakeContext(page);
    context.close = vi.fn(async () => rejectVisit?.(new Error("context closed")));
    const pendingVisit = new Promise((_, reject) => { rejectVisit = reject; });
    const store = mockStore("2026-08-09T00:28:00.000Z");
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.context = context;
    collector.contextHeadless = true;
    collector.ensureBrowser = vi.fn().mockResolvedValue(context);
    collector.currentPage = vi.fn().mockResolvedValue(page);
    collector.visit = vi.fn().mockReturnValue(pendingVisit);
    collector.waitForLogin = vi.fn().mockResolvedValue(undefined);

    expect(collector.startChatObservation()).toBe(true);
    await vi.waitFor(() => expect(collector.visit).toHaveBeenCalled());
    await expect(collector.stopChatObservation()).resolves.toBe(true);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(collector.getStatus().chat.state).toBe("idle");
  });

  it("falls back to the browser handle when a context refuses to close", async () => {
    const browser = { close: vi.fn(async () => undefined) };
    const context = {
      close: vi.fn(async () => { throw new Error("context already closed"); }),
      browser: () => browser,
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.context = context;
    await collector.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("DouyinCollector response completion", () => {
  it("preserves the previous records when pagination never reaches the last page", async () => {
    const initial = emptySnapshot();
    initial.records.liked_videos = [{
      id: "liked_videos:old",
      title: "旧记录",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/old",
    }];
    const { collector, store } = collectorForResponses(initial, {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
      liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", {
        status_code: 0,
        aweme_list: [{ aweme_id: "new", desc: "本次读取记录" }],
        has_more: 1,
        max_cursor: "next-page",
      }),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });

    await collector.runSync(1);

    const savedRecords = store.save.mock.calls[0][0];
    expect(savedRecords.liked_videos.map((record) => record.id)).toEqual(["liked_videos:old"]);
    expect(collector.snapshot.warnings).toContain("点赞列表读取不完整，已保留上次样本。");
    expect(collector.status.state).toBe("partial");
  });

  it("preserves the previous sample when a primary page emits no response", async () => {
    const initial = emptySnapshot();
    initial.records.liked_videos = [{
      id: "liked_videos:old",
      title: "旧记录",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/old",
      videoId: "old",
    }];
    const { collector } = collectorForResponses(initial, {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.liked_videos.map((record) => record.videoId)).toEqual(["old"]);
    expect(collector.snapshot.warnings).toContain("点赞列表未捕获到网页响应。");
    expect(collector.snapshot.warnings).toContain("点赞列表读取不完整，已保留上次样本。");
    expect(collector.status.state).toBe("partial");
  });

  it("waits for delayed response parsing before calculating capture warnings", async () => {
    const delayedHistory = () => new Promise((resolve) => {
      setTimeout(() => resolve(terminalEmptyVideos), 25);
    });
    const { collector } = collectorForResponses(emptySnapshot(), {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", delayedHistory),
      liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });

    await collector.runSync(1);

    expect(collector.snapshot.warnings).toEqual([]);
    expect(collector.status.state).toBe("complete");
  });

  it("recovers a later page after one duplicate response and a lost response body", async () => {
    const firstPagePayload = {
      status_code: 0,
      aweme_list: [{ aweme_id: "first-like", desc: "第一页记录" }],
      has_more: 1,
      max_cursor: "page-2",
    };
    const secondPagePayload = {
      status_code: 0,
      aweme_list: [{ aweme_id: "second-like", desc: "第二页记录" }],
      has_more: 1,
      max_cursor: "page-3",
    };
    const recoveredPayload = {
      status_code: 0,
      aweme_list: [{ aweme_id: "recovered-like", desc: "末页重试记录" }],
      has_more: 0,
    };
    const replayPage = {
      evaluate: vi.fn().mockResolvedValue({
        body: JSON.stringify(recoveredPayload),
        ok: true,
        status: 200,
        tooLarge: false,
      }),
    };
    const lostResponse = {
      ...fakeResponse("/aweme/v1/web/aweme/favorite/", () => Promise.reject(new Error("response body unavailable"))),
      request: () => ({
        allHeaders: () => Promise.resolve({ cookie: "private", "x-test-header": "kept" }),
        frame: () => ({ page: () => replayPage }),
        method: () => "GET",
      }),
    };
    const { collector } = collectorForResponses(emptySnapshot(), {});
    const context = collector.context;
    collector.collectPhase = vi.fn(async (_page, _versions, phase) => {
      if (phase === "liked_videos") {
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", firstPagePayload));
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", firstPagePayload));
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", secondPagePayload));
        context.emit("response", lostResponse);
        return;
      }
      const path = phase === "watch_history"
        ? "/aweme/v1/web/history/read/"
        : "/aweme/v1/web/aweme/listcollection/";
      context.emit("response", fakeResponse(path, terminalEmptyVideos));
    });

    await collector.runSync(1);

    expect(replayPage.evaluate).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      requestHeaders: { "x-test-header": "kept" },
      timeoutMs: 8_000,
    }));
    expect(collector.snapshot.records.liked_videos.map((record) => record.videoId))
      .toEqual(["first-like", "second-like", "recovered-like"]);
    expect(collector.snapshot.warnings).toEqual([]);
    expect(collector.status.state).toBe("complete");
  });

  it("applies pagination results in response order when JSON parsing finishes out of order", async () => {
    const delayedFirstPage = fakeResponse("/aweme/v1/web/history/read/", () => new Promise((resolve) => {
      setTimeout(() => resolve({
        status_code: 0,
        aweme_list: [{ aweme_id: "history-page-1", desc: "第一页" }],
        has_more: 1,
        max_cursor: "next-page",
      }), 25);
    }));
    const terminalHistoryPage = fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos);
    const { collector } = collectorForResponses(emptySnapshot(), {
      liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });
    const context = collector.context;
    collector.collectPhase = vi.fn(async (_page, _versions, phase) => {
      if (phase === "watch_history") {
        context.emit("response", delayedFirstPage);
        context.emit("response", terminalHistoryPage);
      } else {
        const response = {
          liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", terminalEmptyVideos),
          favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
        }[phase];
        if (response) context.emit("response", response);
      }
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.watch_history.map((record) => record.id))
      .toEqual(["watch_history:history-page-1"]);
    expect(collector.snapshot.warnings).toEqual([]);
    expect(collector.status.state).toBe("complete");
  });

  it("keeps every record returned before each primary endpoint reaches its last page", async () => {
    const page = (prefix) => ({
      status_code: 0,
      aweme_list: Array.from({ length: 55 }, (_, index) => ({
        aweme_id: `${prefix}-${index}`,
        desc: `${prefix} ${index}`,
        event_time: 1_700_000_000 + index,
      })),
      has_more: 0,
    });
    const { collector } = collectorForResponses(emptySnapshot(), {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", page("watch")),
      liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", page("liked")),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", page("favorite")),
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.watch_history).toHaveLength(55);
    expect(collector.snapshot.records.liked_videos).toHaveLength(55);
    expect(collector.snapshot.records.favorite_videos).toHaveLength(55);
    expect(collector.snapshot.records.watch_history.map((record) => record.videoId))
      .toEqual(Array.from({ length: 55 }, (_, index) => `watch-${54 - index}`));
    expect(collector.snapshot.records.liked_videos.map((record) => record.videoId))
      .toEqual(Array.from({ length: 55 }, (_, index) => `liked-${index}`));
    expect(collector.snapshot.records.favorite_videos.map((record) => record.videoId))
      .toEqual(Array.from({ length: 55 }, (_, index) => `favorite-${index}`));
    expect(collector.snapshot.warnings).toEqual([]);
    expect(collector.status.state).toBe("complete");
  });

  it("merges a complete automatic watch scan and preserves direct sync boundaries", async () => {
    const initial = emptySnapshot();
    initial.directSync = normalizeDirectSyncState({
      watch_history: true,
      liked_videos: true,
      favorite_videos: true,
    });
    initial.records.watch_history = [{
      id: "watch_history:old-watch:2026-08-01T00:00:00.000Z",
      title: "平台当前窗口外的旧观看",
      author: null,
      occurredAt: "2026-08-01T00:00:00.000Z",
      occurredAtSource: "platform_action",
      url: "https://www.douyin.com/video/old-watch",
      videoId: "old-watch",
    }];
    const { collector } = collectorForResponses(initial, {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", {
        status_code: 0,
        aweme_list: [{ aweme_id: "new-watch", history_info: { view_time: 1_786_000_000 } }],
        has_more: 0,
      }),
      liked_videos: fakeResponse("/aweme/v1/web/aweme/favorite/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.watch_history.map((record) => record.videoId))
      .toEqual(["new-watch", "old-watch"]);
    expect(collector.snapshot.directSync).toEqual(initial.directSync);
  });

  it("keeps the previous sample when a later response cannot be normalized", async () => {
    const initial = emptySnapshot();
    initial.records.liked_videos = [{
      id: "liked_videos:old",
      title: "旧记录",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/old",
      videoId: "old",
    }];
    const { collector } = collectorForResponses(initial, {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });
    const context = collector.context;
    collector.collectPhase = vi.fn(async (_page, _versions, phase) => {
      if (phase === "liked_videos") {
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", {
          status_code: 0,
          aweme_list: [{ aweme_id: "new", desc: "本次读取记录" }],
          has_more: 1,
          max_cursor: "next-page",
        }));
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", {
          status_code: 0,
          aweme_list: [{ new_schema_id: "unrecognized" }],
          has_more: 1,
          max_cursor: "next-page-2",
        }));
        return;
      }
      const response = {
        watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
        favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
      }[phase];
      if (response) context.emit("response", response);
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.liked_videos.map((record) => record.videoId)).toEqual(["old"]);
    expect(collector.snapshot.warnings).toContain("点赞列表读取不完整，已保留上次样本。");
    expect(collector.snapshot.warnings).toContain("视频列表包含无法识别的数据。请更新采集器适配器。");
    expect(collector.status.state).toBe("partial");
  });

  it("does not treat more than 50 records as complete when a later page fails", async () => {
    const initial = emptySnapshot();
    initial.records.liked_videos = [{
      id: "liked_videos:old",
      title: "旧记录",
      author: null,
      occurredAt: null,
      url: "https://www.douyin.com/video/old",
      videoId: "old",
    }];
    const { collector } = collectorForResponses(initial, {
      watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
      favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
    });
    const context = collector.context;
    collector.collectPhase = vi.fn(async (_page, _versions, phase) => {
      if (phase === "liked_videos") {
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", {
          status_code: 0,
          aweme_list: Array.from({ length: 55 }, (_, index) => ({
            aweme_id: `current-${index}`,
            desc: `本次记录 ${index}`,
          })),
          has_more: 1,
          max_cursor: "next-page",
        }));
        context.emit("response", fakeResponse("/aweme/v1/web/aweme/favorite/", {
          status_code: 0,
          aweme_list: [{ new_schema_id: "unrecognized" }],
          has_more: 1,
          max_cursor: "next-page-2",
        }));
        return;
      }
      const response = {
        watch_history: fakeResponse("/aweme/v1/web/history/read/", terminalEmptyVideos),
        favorite_videos: fakeResponse("/aweme/v1/web/aweme/listcollection/", terminalEmptyVideos),
      }[phase];
      if (response) context.emit("response", response);
    });

    await collector.runSync(1);

    expect(collector.snapshot.records.liked_videos).toHaveLength(1);
    expect(collector.snapshot.records.liked_videos[0].videoId).toBe("old");
    expect(collector.snapshot.warnings).toContain("点赞列表读取不完整，已保留上次样本。");
    expect(collector.status.state).toBe("partial");
  });
});

describe("DouyinCollector direct records", () => {
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
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    const visibleContext = { close: vi.fn(async () => undefined) };
    collector.context = visibleContext;
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async (_context, type, onPage) => {
      await onPage({ status_code: 0, aweme_list: [{ aweme_id: type === "liked_videos" ? "liked-new" : "favorite-new" }], has_more: 0 }, 1);
      return 1;
    });
    collector.readDirectHistory = vi.fn(async (_context, cursor) => {
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
    expect(collector.snapshot.records.liked_videos[0]?.videoId).toBe("liked-new");
    expect(collector.snapshot.records.favorite_videos[0]?.videoId).toBe("favorite-new");
    expect(collector.snapshot.records.watch_history).toHaveLength(2);
    expect(collector.readDirectHistory.mock.calls.map(([, cursor]) => cursor)).toEqual([
      "0",
      "1700000000000",
    ]);
    expect(collector.status.state).toBe("complete");
    expect(store.save).toHaveBeenCalledTimes(3);
    expect(collector.snapshot.directSync).toEqual({
      watch_history: true,
      liked_videos: true,
      favorite_videos: true,
    });
    expect(visibleContext.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does not save when the direct request fails", async () => {
    const store = { save: vi.fn() };
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.collectDirectList = vi.fn(async () => { throw new Error("request_failed"); });
    collector.readDirectHistory = vi.fn(async () => {
      throw new Error("request_failed");
    });

    await expect(collector.runDirectRecords(1)).rejects.toThrow("request_failed");
    expect(store.save).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed watch phase when a later direct list fails", async () => {
    const store = mockStore("2026-08-13T00:00:00.000Z");
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
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
    expect(context.close).toHaveBeenCalledTimes(1);
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
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
    collector.readDirectHistory = vi.fn(async () => ({
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

    expect(collector.readDirectHistory).toHaveBeenCalledTimes(1);
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
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
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
    expect(context.close).toHaveBeenCalledTimes(1);
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
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = initial;
    collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
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

describe("DouyinCollector deterministic tab fallback", () => {
  function interactiveLocator() {
    const locator = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn(),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(true),
    };
    locator.nth.mockReturnValue(locator);
    return locator;
  }

  it("visits the target Likes URL when a successful click emits no endpoint response", async () => {
    const locator = interactiveLocator();
    const page = {
      locator: vi.fn().mockReturnValue(locator),
      evaluate: vi.fn().mockResolvedValue(null),
      getByRole: vi.fn().mockReturnValue(locator),
      getByLabel: vi.fn().mockReturnValue(locator),
      getByTitle: vi.fn().mockReturnValue(locator),
      getByText: vi.fn().mockReturnValue(locator),
      reload: vi.fn().mockResolvedValue(undefined),
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;
    collector.resolveOwnProfileUrl = vi.fn().mockResolvedValue("https://www.douyin.com/user/account-id");
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForVersionAdvance = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    collector.scrollUntilIdle = vi.fn().mockResolvedValue(undefined);

    await collector.collectPhase(page, new Map(), "liked_videos", 1, []);

    expect(collector.visit).toHaveBeenNthCalledWith(
      1,
      page,
      "https://www.douyin.com/user/account-id?showTab=record",
      1,
    );
    expect(collector.visit).toHaveBeenNthCalledWith(
      2,
      page,
      "https://www.douyin.com/user/account-id?showTab=like",
      1,
    );
    expect(collector.scrollUntilIdle).toHaveBeenCalledWith(
      page,
      expect.any(Map),
      ["liked_videos"],
      1,
      [],
      Number.POSITIVE_INFINITY,
      "like",
    );
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("opens a neutral profile tab before clicking History", async () => {
    const locator = interactiveLocator();
    locator.evaluate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const page = {
      locator: vi.fn().mockReturnValue(locator),
      evaluate: vi.fn().mockResolvedValue(null),
      getByRole: vi.fn().mockReturnValue(locator),
      getByLabel: vi.fn().mockReturnValue(locator),
      getByTitle: vi.fn().mockReturnValue(locator),
      getByText: vi.fn().mockReturnValue(locator),
      reload: vi.fn().mockResolvedValue(undefined),
    };
    const responseVersions = new Map([["watch_history", 0]]);
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;
    collector.resolveOwnProfileUrl = vi.fn().mockResolvedValue("https://www.douyin.com/user/account-id");
    collector.visit = vi.fn().mockResolvedValue(undefined);
    collector.waitForVersionAdvance = vi.fn().mockResolvedValue(true);
    collector.scrollUntilIdle = vi.fn().mockResolvedValue(undefined);

    await collector.collectPhase(page, responseVersions, "watch_history", 1, []);

    expect(locator.click).toHaveBeenCalled();
    expect(collector.visit).toHaveBeenCalledTimes(1);
    expect(collector.visit).toHaveBeenCalledWith(
      page,
      "https://www.douyin.com/user/account-id?showTab=like",
      1,
    );
    expect(collector.scrollUntilIdle).toHaveBeenCalledWith(
      page,
      responseVersions,
      ["watch_history"],
      1,
      [],
      Number.POSITIVE_INFINITY,
      "record",
    );
  });

  it("does not scroll when the target panel cannot be resolved", async () => {
    const progress = createEndpointProgress();
    progress.matchedCount = 1;
    progress.processedCount = 1;
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      mouse: {
        move: vi.fn(),
        wheel: vi.fn(),
      },
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;

    await collector.scrollUntilIdle(
      page,
      new Map([["liked_videos", 1]]),
      ["liked_videos"],
      1,
      [progress],
      1,
      "like",
    );

    expect(progress.visualSurfaceMissing).toBe(true);
    expect(page.mouse.move).not.toHaveBeenCalled();
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });

  it("falls back to a scrollable ancestor when the active panel has no box", async () => {
    const attributes = new Map();
    const root = {
      tagName: "HTML",
      parentElement: null,
      hidden: false,
      inert: false,
      scrollHeight: 1_800,
      clientHeight: 900,
      scrollTop: 0,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      getBoundingClientRect: () => ({ left: 0, right: 1_280, top: 0, bottom: 900, width: 1_280, height: 900 }),
    };
    const panel = {
      tagName: "DIV",
      parentElement: root,
      hidden: false,
      inert: false,
      scrollHeight: 700,
      clientHeight: 700,
      scrollTop: 0,
      getAttribute: () => null,
      contains: (element) => element === panel || element === content,
      getBoundingClientRect: () => ({ left: 817, right: 817, top: 226, bottom: 226, width: 0, height: 0 }),
    };
    const content = {
      tagName: "DIV",
      parentElement: panel,
      hidden: false,
      inert: false,
      scrollHeight: 600,
      clientHeight: 600,
      scrollTop: 0,
      getAttribute: () => null,
    };
    const fakeDocument = {
      scrollingElement: root,
      querySelectorAll: () => attributes.has("data-douyin-collector-surface") ? [root] : [],
      querySelector: () => attributes.has("data-douyin-collector-surface") ? root : null,
      getElementById: (id) => id === "semiTabPanellike" ? panel : null,
      elementsFromPoint: () => [content],
    };
    const fakeWindow = {
      innerWidth: 1_280,
      innerHeight: 900,
      getComputedStyle: (element) => ({ overflowY: element === root ? "auto" : "visible", display: "block", visibility: "visible", opacity: "1" }),
      __douyinCollectorVisualBaseline: new Set(),
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);

    const progress = createEndpointProgress();
    progress.matchedCount = 1;
    progress.processedCount = 1;
    progress.uniqueAddedCount = 20;
    const page = {
      evaluate: vi.fn(async (callback, argument) => callback(argument)),
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;

    try {
      await collector.scrollUntilIdle(
        page,
        new Map([["liked_videos", 1]]),
        ["liked_videos"],
        1,
        [progress],
        1,
        "like",
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(progress.visualSurfaceMissing).toBe(false);
    expect(root.scrollTop).toBeGreaterThan(0);
  });

  it("continues scrolling after collecting 50 unique records", async () => {
    const progress = createEndpointProgress();
    progress.matchedCount = 1;
    progress.processedCount = 1;
    progress.uniqueAddedCount = 50;
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      mouse: { move: vi.fn(), wheel: vi.fn() },
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;

    await collector.scrollUntilIdle(
      page,
      new Map([["liked_videos", 1]]),
      ["liked_videos"],
      1,
      [progress],
      1,
      "like",
    );

    expect(page.evaluate).toHaveBeenCalled();
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });

  it("stops a visually moving surface when endpoint responses make no progress", async () => {
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    });
    const progress = createEndpointProgress();
    progress.matchedCount = 1;
    progress.processedCount = 1;
    const page = {
      evaluate: vi.fn().mockResolvedValue({ resolved: true, moved: true, atBottom: false }),
    };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.syncRunId = 1;

    await collector.scrollUntilIdle(
      page,
      new Map([["liked_videos", 1]]),
      ["liked_videos"],
      1,
      [progress],
      Number.POSITIVE_INFINITY,
      "like",
      {
        now: () => currentTime,
        wait,
        responseSilenceTimeoutMs: 1_800,
      },
    );

    expect(wait).toHaveBeenCalledTimes(2);
    expect(progress.responseProgressStalled).toBe(true);
    expect(progress.visualSurfaceMissing).toBe(false);
  });
});

describe("DouyinCollector concurrent headless work", () => {
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

  it("keeps the visible browser to itself", () => {
    const collector = receivingCollector();
    collector.runSync = vi.fn(() => new Promise(() => {}));
    collector.runObservation = vi.fn(() => new Promise(() => {}));
    expect(collector.startSync()).toBe(false);
    expect(collector.startObservation()).toBe(false);
  });

  it("blocks reception while the visible browser is busy", () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.snapshot = emptySnapshot();
    collector.runSync = vi.fn(() => new Promise(() => {}));
    expect(collector.startSync()).toBe(true);
    expect(collector.startChatObservation()).toBe(false);
    expect(() => collector.startVideoDownload("https://www.douyin.com/video/1234567890"))
      .toThrowError(expect.objectContaining({ code: "collector_busy" }));
  });

  it("saves each page of a direct read instead of waiting for the whole list", async () => {
    const store = mockStore();
    const page = { evaluate: vi.fn(async () => "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"), close: vi.fn(async () => undefined) };
    const context = { close: vi.fn(async () => undefined), pages: vi.fn(() => [page]), newPage: vi.fn(async () => page) };
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store });
    collector.snapshot = emptySnapshot();
    collector.syncRunId = 1;
    collector.progressPersistIntervalMs = 0;
    collector.ensureBrowser = vi.fn(async () => { collector.context = context; collector.contextHeadless = true; return context; });
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
