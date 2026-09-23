import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCollectorRecords,
  fetchCollectorVideoFile,
  getCollectorPairingCode,
  getCollectorRecords,
  LocalCollectorError,
  loadCollectorVideo,
  getCollectorStatus,
  getCollectorVideoDownload,
  isChatReceiving,
  normalizeCollectorBaseUrl,
  parseLaunchPairingCode,
  pairCollector,
  startCollectorSync,
  startDirectRecordsSync,
  startCollectorObservation,
  startCollectorChatObservation,
  startCollectorVideoDownload,
  stopCollectorSync,
  stopCollectorObservation,
  stopCollectorChatObservation,
} from "./localCollector";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("video playback loading", () => {
  const baseUrl = "http://127.0.0.1:4765";
  const job = {
    id: "12345678-1234-1234-1234-123456789abc",
    sourceUrl: "https://www.douyin.com/video/1234567890",
    status: "queued",
    createdAt: "2026-09-06T00:00:00.000Z",
  };
  const jobResponse = (status: string, extra = {}) => new Response(JSON.stringify({ job: { ...job, status, ...extra } }));

  it("waits for media preparation and returns playable bytes with header-only authentication", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jobResponse("queued"))
      .mockResolvedValueOnce(jobResponse("running"))
      .mockResolvedValueOnce(jobResponse("complete"))
      .mockResolvedValueOnce(new Response("video bytes", { headers: { "Content-Type": "video/mp4" } }))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const pending = loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, new AbortController().signal, progress);
    await vi.advanceTimersByTimeAsync(1_600);
    const blob = await pending;
    expect(blob.type).toBe("video/mp4");
    expect(await blob.text()).toBe("video bytes");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/v1/downloads`, `${baseUrl}/v1/downloads/${job.id}`,
      `${baseUrl}/v1/downloads/${job.id}`, `${baseUrl}/v1/downloads/${job.id}/file`,
      `${baseUrl}/v1/downloads/${job.id}`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ playback: true });
    expect(fetchMock.mock.lastCall?.[1].method).toBe("DELETE");
    expect(progress.mock.calls.map(([message]) => message)).toEqual(["正在等待视频准备…", "正在读取视频资源…", "正在载入视频文件…"]);
    expect(fetchMock.mock.calls.every(([, init]) => init.headers.Authorization === "Bearer session-secret")).toBe(true);
  });

  it("stops polling immediately when the player closes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce(jobResponse("queued")).mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const pending = loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(2_400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.lastCall?.[1].method).toBe("DELETE");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request for an already closed player", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases a late-created job after switching without polling or downloading it", async () => {
    let resolve!: (response: Response) => void;
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const pending = loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    resolve(jobResponse("running"));
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.lastCall?.[1].method).toBe("DELETE");
    expect(fetchMock.mock.lastCall?.[1].signal.aborted).toBe(false);
  });

  it("bounds preparation and releases a job that remains queued", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init) => Promise.resolve(init.method === "DELETE" ? new Response('{"ok":true}') : jobResponse("queued")));
    vi.stubGlobal("fetch", fetchMock);
    const pending = loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(91_000);
    await rejected;
    expect(fetchMock.mock.lastCall?.[1].method).toBe("DELETE");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight media fetch when the player closes", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchCollectorVideoFile(baseUrl, "session-secret", job.id, undefined, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("surfaces a failed job without fetching a video file", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jobResponse("failed", { errorCode: "media_not_found", error: "没有可播放的视频" })).mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, new AbortController().signal))
      .rejects.toMatchObject({ code: "media_not_found", message: "没有可播放的视频" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.lastCall?.[1].method).toBe("DELETE");
  });

  it("shows the collector's busy reason so the user can retry later", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: "download_start_failed", message: "采集器正在执行其他任务，请稍后再试。",
    }), { status: 409 })));
    await expect(loadCollectorVideo(baseUrl, "session-secret", job.sourceUrl, new AbortController().signal))
      .rejects.toMatchObject({ code: "download_start_failed", message: "采集器正在执行其他任务，请稍后再试。" });
  });
});

describe("normalizeCollectorBaseUrl", () => {
  it("allows loopback and private LAN HTTP addresses", () => {
    expect(normalizeCollectorBaseUrl("http://127.0.0.1:4765/")).toBe("http://127.0.0.1:4765");
    expect(normalizeCollectorBaseUrl("http://192.168.10.5:4765")).toBe("http://192.168.10.5:4765");
  });

  it("rejects public HTTP addresses and URLs containing credentials", () => {
    expect(() => normalizeCollectorBaseUrl("http://example.com:4765")).toThrowError(LocalCollectorError);
    expect(() => normalizeCollectorBaseUrl("https://example.com:4765")).toThrowError(LocalCollectorError);
    expect(() => normalizeCollectorBaseUrl("https://user:pass@example.com")).toThrowError(LocalCollectorError);
  });
});

describe("parseLaunchPairingCode", () => {
  it("only accepts one exact 8-digit launch code", () => {
    expect(parseLaunchPairingCode("#pair=12345678")).toBe("12345678");
    expect(parseLaunchPairingCode("#pair=1234567")).toBeNull();
    expect(parseLaunchPairingCode("#pair=12345678&token=secret")).toBeNull();
  });
});

describe("local collector client", () => {
  it("uses the nested chat state even while the shared collector is idle", () => {
    expect(isChatReceiving({
      state: "idle",
      phase: null,
      message: "等待同步",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0, chat_messages: 0 },
      progress: null,
      updatedAt: null,
      browserOpen: true,
      syncMode: null,
      chatConnection: "connecting",
      chat: { state: "launching_browser", connection: "connecting", message: "正在连接", progress: null },
    })).toBe(true);
  });

  it("accepts the legacy chat phase when a collector has no nested state", () => {
    expect(isChatReceiving({
      state: "observing",
      phase: "chat_messages",
      message: "聊天监听中",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0, chat_messages: 2 },
      progress: null,
      updatedAt: null,
      browserOpen: true,
      syncMode: null,
      chatConnection: "connected",
      chat: { state: "idle", connection: null, message: null, progress: null },
    })).toBe(true);
  });

  it("does not let a nested chat error look active through the legacy phase", () => {
    expect(isChatReceiving({
      state: "observing",
      phase: "chat_messages",
      message: "记录监听中",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0, chat_messages: 2 },
      progress: null,
      updatedAt: null,
      browserOpen: true,
      syncMode: null,
      chatConnection: null,
      chat: { state: "error", connection: null, message: "登录超时", progress: null },
    })).toBe(false);
  });

  it("waits on revisions with header-only authentication and decodes the live connection state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      state: "observing", phase: "chat_messages", revision: 8, chatConnection: "reconnecting", message: "正在重连",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0, chat_messages: 2 },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCollectorStatus("http://127.0.0.1:4765", "session-secret", 7))
      .resolves.toMatchObject({ revision: 8, chatConnection: "reconnecting", phase: "chat_messages" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4765/v1/status?afterRevision=7", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer session-secret" }),
    }));
  });

  it("reads and validates the loopback pairing code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "12345678" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCollectorPairingCode("http://127.0.0.1:4765")).resolves.toBe("12345678");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4765/v1/pairing-code",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("rejects malformed pairing-code responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "123" }), { status: 200 })));
    await expect(getCollectorPairingCode("http://127.0.0.1:4765"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("validates pairing codes before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(pairCollector("http://127.0.0.1:4765", "123"))
      .rejects.toMatchObject({ code: "invalid_code" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the session token only in the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      state: "complete",
      phase: null,
      message: "完成",
      counts: { watch_history: 1, liked_videos: 2, favorite_videos: 3 },
      progress: { current: 2, total: 5 },
      updatedAt: "2026-08-08T00:00:00.000Z",
      browserOpen: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await getCollectorStatus("http://127.0.0.1:4765", "session-secret");
    expect(status.counts.favorite_videos).toBe(3);
    expect(status.progress).toEqual({ current: 2, total: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4765/v1/status",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer session-secret" }) }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("session-secret");
  });

  it("clears the local record cache through the authenticated endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-08-14T00:00:00.000Z",
      records: { watch_history: [], liked_videos: [], favorite_videos: [] },
      warnings: [],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await clearCollectorRecords("http://127.0.0.1:4765", "session-secret");

    expect(snapshot.records).toEqual({ watch_history: [], liked_videos: [], favorite_videos: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4765/v1/records",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ Authorization: "Bearer session-secret" }),
      }),
    );
  });

  it("starts and stops manual observation through local authenticated endpoints", async () => {
    const statusPayload = {
      state: "observing",
      phase: null,
      message: "监听中",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0 },
      updatedAt: null,
      browserOpen: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ started: true, status: statusPayload }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ stopped: true, status: { ...statusPayload, state: "idle" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCollectorObservation("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "observing" });
    await expect(stopCollectorObservation("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "idle" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4765/v1/observe",
      "http://127.0.0.1:4765/v1/observe/stop",
    ]);
  });

  it("starts and stops chat observation through dedicated endpoints", async () => {
    const statusPayload = {
      state: "observing",
      phase: "chat_messages",
      message: "聊天监听中",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 2 },
      updatedAt: null,
      browserOpen: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ started: true, status: statusPayload }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ stopped: true, status: { ...statusPayload, state: "idle", phase: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCollectorChatObservation("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "observing", phase: "chat_messages" });
    await expect(stopCollectorChatObservation("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "idle" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4765/v1/chat/observe",
      "http://127.0.0.1:4765/v1/chat/observe/stop",
    ]);
  });

  it("starts and stops record sync through local authenticated endpoints", async () => {
    const statusPayload = {
      state: "collecting",
      phase: "liked_videos",
      message: "正在读取点赞列表",
      counts: { watch_history: 12, liked_videos: 0, favorite_videos: 0 },
      updatedAt: null,
      browserOpen: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ started: true, status: statusPayload }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stopped: true,
        status: { ...statusPayload, phase: null, message: "正在停止读取" },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCollectorSync("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "collecting", phase: "liked_videos" });
    await expect(stopCollectorSync("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ state: "collecting", phase: null, message: "正在停止读取" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4765/v1/sync",
      "http://127.0.0.1:4765/v1/sync/stop",
    ]);
  });

  it("starts the loopback-only direct history experiment through its fixed endpoint", async () => {
    const statusPayload = {
      state: "collecting",
      phase: "watch_history",
      message: "正在直接读取全部可见观看历史",
      counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0 },
      updatedAt: null,
      browserOpen: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      started: true,
      status: statusPayload,
    }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startDirectRecordsSync("http://127.0.0.1:4765", "session-secret"))
      .resolves.toMatchObject({ phase: "watch_history" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4765/v1/experimental/records-direct",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects unreasonable count values from the service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      state: "complete",
      phase: null,
      message: "完成",
      counts: { watch_history: 9_999_999, liked_videos: 0, favorite_videos: 0 },
      updatedAt: null,
      browserOpen: false,
    }), { status: 200 })));

    await expect(getCollectorStatus("http://127.0.0.1:4765", "session-secret"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps HTTPS video links from legitimate Douyin subdomains", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-08-09T00:00:00.000Z",
      records: {
        watch_history: [{
          id: "watch_history:1",
          title: "测试视频",
          author: null,
          occurredAt: "2025-01-01T00:00:00.000Z",
          url: "https://v.douyin.com/example/",
        }],
        liked_videos: [],
        favorite_videos: [],
      },
      warnings: [],
    }), { status: 200 })));

    const snapshot = await getCollectorRecords("http://127.0.0.1:4765", "session-secret");
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.records.watch_history[0]?.url).toBe("https://v.douyin.com/example/");
    expect(snapshot.records.watch_history[0]?.videoId).toBe("1");
    expect(snapshot.records.watch_history[0]?.occurredAtSource).toBe("platform_action");
  });

  it("accepts and sanitizes schema v2 optional metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-08-09T00:00:00.000Z",
      records: {
        watch_history: [{
          id: "watch_history:rich",
          title: "rich record",
          author: "Creator",
          occurredAt: "2025-01-02T03:04:05.000Z",
          url: "https://www.douyin.com/video/rich",
          videoId: "rich",
          authorId: "creator-1",
          authorAvatarUrl: "https://p3.douyinpic.com/avatar",
          occurredAtSource: "platform_action",
          publishedAt: "2024-12-01T00:00:00.000Z",
          coverUrl: "https://p3.douyinpic.com/cover",
          mediaType: "video",
          durationSeconds: 42,
          music: { id: "music-1", title: "Track", author: "Artist" },
          topics: ["travel", "#city", "travel"],
          stats: { playCount: 100, diggCount: 10, ignored: "raw" },
          watchProgress: { watchedSeconds: 21, percent: 50 },
        }, {
          id: "watch_history:unsafe",
          title: "unsafe images",
          authorAvatarUrl: "https://evil.example/avatar",
          coverUrl: "https://evil.example/cover",
        }],
        liked_videos: [],
        favorite_videos: [],
      },
      warnings: [],
    }), { status: 200 })));

    const snapshot = await getCollectorRecords("http://127.0.0.1:4765", "session-secret");
    expect(snapshot.records.watch_history[0]).toMatchObject({
      videoId: "rich",
      authorId: "creator-1",
      authorAvatarUrl: "https://p3.douyinpic.com/avatar",
      occurredAtSource: "platform_action",
      publishedAt: "2024-12-01T00:00:00.000Z",
      coverUrl: "https://p3.douyinpic.com/cover",
      mediaType: "video",
      durationSeconds: 42,
      topics: ["travel", "city"],
      stats: { playCount: 100, diggCount: 10 },
      watchProgress: { watchedSeconds: 21, percent: 50 },
    });
    expect(snapshot.records.watch_history[1]).not.toHaveProperty("authorAvatarUrl");
    expect(snapshot.records.watch_history[1]).not.toHaveProperty("coverUrl");
  });

  it("accepts chat messages and preserves call duration/share metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-08-20T00:00:00.000Z",
      records: { watch_history: [], liked_videos: [], favorite_videos: [] },
      chatMessages: [{
        id: "chat-1",
        conversationId: "conv-1",
        conversationName: "会话",
        senderId: "user-1",
        senderName: "联系人",
        sentAt: "2026-08-20T00:00:00.000Z",
        type: "call",
        text: "通话",
        mediaUrl: "https://evil.example/image.jpg",
        share: {
          title: "标题",
          author: "作者",
          coverUrl: "https://p3.douyinpic.com/cover.jpg",
          url: "https://www.douyin.com/video/123?token=secret",
        },
        callDurationSeconds: 208,
      }, {
        id: "7678560234599844388",
        conversationId: "conv-1",
        conversationName: "会话",
        senderId: "user-1",
        senderName: null,
        sentAt: "2026-08-27T04:15:21.000Z",
        type: "unknown",
        text: null,
        mediaUrl: null,
        share: null,
        callDurationSeconds: null,
      }],
      chatConversations: [{
        id: "conv-1",
        kind: "friend",
        nickname: "联系人",
        avatar: { url_list: ["https://p3.douyinpic.com/contact-avatar.jpg"] },
        messageCount: 1,
        ownMessageCount: 0,
      }],
      warnings: [],
    }), { status: 200 })));

    const snapshot = await getCollectorRecords("http://127.0.0.1:4765", "session-secret");
    expect(snapshot.chatMessages[0]).toMatchObject({
      id: "chat-1",
      type: "call",
      callDurationSeconds: 208,
      mediaUrl: null,
      share: { coverUrl: "https://p3.douyinpic.com/cover.jpg", url: "https://www.douyin.com/video/123" },
    });
    expect(snapshot.chatMessages).toHaveLength(1);
    expect(snapshot.chatConversations[0]).toMatchObject({
      id: "conv-1",
      name: "联系人",
      avatarUrl: "https://p3.douyinpic.com/contact-avatar.jpg",
    });
  });

  it("normalizes title-only legacy shares to ordinary text on the client boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-08-20T00:00:00.000Z",
      records: { watch_history: [], liked_videos: [], favorite_videos: [] },
      chatMessages: [{
        id: "plain-share-1",
        conversationId: "conv-1",
        conversationType: "friend",
        conversationName: "会话",
        senderId: "user-1",
        senderName: "联系人",
        sentAt: "2026-08-20T00:00:00.000Z",
        type: "share",
        text: "普通消息",
        mediaUrl: null,
        share: { title: "普通消息", author: null, coverUrl: null, url: null },
        callDurationSeconds: null,
      }],
      chatConversations: [{ id: "conv-1", kind: "friend", name: "会话", messageCount: 1, ownMessageCount: 0 }],
      warnings: [],
    }), { status: 200 })));

    const snapshot = await getCollectorRecords("http://127.0.0.1:4765", "session-secret");
    expect(snapshot.chatMessages[0]).toMatchObject({ type: "text", text: "普通消息", share: null });
  });

  it("drops lookalike and non-HTTPS video links", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      updatedAt: null,
      records: {
        watch_history: [
          { id: "watch_history:1", title: "仿冒域名", url: "https://evildouyin.com/video/1" },
          { id: "watch_history:2", title: "非 HTTPS", url: "http://www.douyin.com/video/2" },
        ],
        liked_videos: [],
        favorite_videos: [],
      },
      warnings: [],
    }), { status: 200 })));

    const snapshot = await getCollectorRecords("http://127.0.0.1:4765", "session-secret");
    expect(snapshot.records.watch_history.map((record) => record.url)).toEqual([null, null]);
  });

  it("starts, polls, and fetches an authenticated video download", async () => {
    const jobId = "12345678-1234-1234-1234-123456789abc";
    const queuedJob = {
      id: jobId,
      sourceUrl: "https://v.douyin.com/example/",
      status: "queued",
      fileName: null,
      bytes: null,
      errorCode: null,
      error: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
    const completeJob = {
      ...queuedJob,
      status: "complete",
      fileName: "测试视频-123.mp4",
      bytes: 4,
      updatedAt: "2026-08-31T00:00:02.000Z",
      startedAt: "2026-08-31T00:00:00.100Z",
      completedAt: "2026-08-31T00:00:02.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: queuedJob }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: completeJob }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E8%A7%86%E9%A2%91-123.mp4",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCollectorVideoDownload("http://127.0.0.1:4765", "session-secret", queuedJob.sourceUrl))
      .resolves.toMatchObject({ id: jobId, status: "queued" });
    await expect(getCollectorVideoDownload("http://127.0.0.1:4765", "session-secret", jobId))
      .resolves.toMatchObject({ id: jobId, status: "complete", fileName: "测试视频-123.mp4" });
    await expect(fetchCollectorVideoFile("http://127.0.0.1:4765", "session-secret", jobId))
      .resolves.toMatchObject({ fileName: "测试视频-123.mp4" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:4765/v1/downloads",
      `http://127.0.0.1:4765/v1/downloads/${jobId}`,
      `http://127.0.0.1:4765/v1/downloads/${jobId}/file`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.headers?.Authorization === "Bearer session-secret")).toBe(true);
    expect(fetchMock.mock.calls.every(([url]) => !url.includes("session-secret"))).toBe(true);
  });
});
