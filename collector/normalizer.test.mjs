import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CollectorAdapterError,
  RecordAccumulator,
  matchDouyinEndpoint,
  normalizeDouyinResponse,
} from "./normalizer.mjs";

function responseFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

describe("matchDouyinEndpoint", () => {
  it("matches only the supported Douyin hosts and exact paths", () => {
    expect(matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/?msToken=secret"))
      .toEqual({ kind: "watch_history", pathname: "/aweme/v1/web/history/read/" });
    expect(matchDouyinEndpoint("https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/?a_bogus=secret"))
      .toEqual({ kind: "liked_videos", pathname: "/aweme/v1/web/aweme/favorite/" });
    expect(matchDouyinEndpoint("https://evil.example/aweme/v1/web/history/read/")).toBeNull();
    expect(matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/extra")).toBeNull();
  });
});

describe("normalizeDouyinResponse", () => {
  it.each([
    ["history-read", "https://www.douyin.com/aweme/v1/web/history/read/", "watch_history", true],
    ["favorite", "https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/", "liked_videos", false],
    ["listcollection", "https://www.douyin.com/aweme/v1/web/aweme/listcollection/", "favorite_videos", false],
  ])("normalizes the redacted %s endpoint fixture", (fixtureName, url, expectedType, expectedHasMore) => {
    const endpoint = matchDouyinEndpoint(url);
    const result = normalizeDouyinResponse(endpoint, responseFixture(fixtureName));

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      occurredAtSource: "platform_action",
      videoId: expect.stringMatching(/^demo-/u),
    });
    expect(endpoint?.kind).toBe(expectedType);
    expect(result.pagination.hasMore).toBe(expectedHasMore);
  });

  it("keeps untrusted image URLs out of the liked fixture", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/aweme/favorite/");
    const [record] = normalizeDouyinResponse(endpoint, responseFixture("favorite")).records;

    expect(record).not.toHaveProperty("authorAvatarUrl");
    expect(record).not.toHaveProperty("coverUrl");
  });

  it("normalizes liked videos without treating publish time as like time", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/aweme/favorite/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "734001",
        desc: "测试视频",
        create_time: 1_700_000_000,
        share_url: "https://www.douyin.com/video/734001?msToken=secret#trace",
        author: { nickname: "作者甲" },
      }],
      has_more: false,
    });

    expect(result.records).toEqual([{
      id: "liked_videos:734001",
      title: "测试视频",
      author: "作者甲",
      occurredAt: null,
      url: "https://www.douyin.com/video/734001",
      videoId: "734001",
      occurredAtSource: "unknown",
      publishedAt: "2023-11-14T22:13:20.000Z",
    }]);
    expect(result.pagination).toEqual({ hasMore: false, cursor: null });
  });

  it.each([
    ["喜欢", "https://www.douyin.com/aweme/v1/web/aweme/favorite/", "digg_time"],
    ["收藏", "https://www.douyin.com/aweme/v1/web/aweme/listcollection/", "collect_time"],
  ])("uses play progress update time for %s records", (_label, url, legacyTimeField) => {
    const endpoint = matchDouyinEndpoint(url);
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "with-progress-time",
        [legacyTimeField]: 1_700_000_000,
        play_progress: { last_modified_time: 1_700_100_000 },
      }, {
        aweme_id: "without-progress-time",
        [legacyTimeField]: 1_700_000_000,
      }],
      has_more: false,
    });

    expect(result.records[0]).toMatchObject({
      occurredAt: new Date(1_700_100_000 * 1_000).toISOString(),
      occurredAtSource: "platform_action",
    });
    expect(result.records[1]).toMatchObject({
      occurredAt: null,
      occurredAtSource: "unknown",
    });
  });

  it("uses a dedicated history event timestamp when present", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      data: {
        aweme_list: [{
          aweme_id: "734002",
          caption: "历史记录",
          history_info: { view_time: 1_700_000_000 },
        }],
      },
    });

    expect(result.records[0]?.occurredAt).toBe("2023-11-14T22:13:20.000Z");
    expect(result.records[0]?.id).toBe("watch_history:734002:2023-11-14T22:13:20.000Z");
  });

  it("maps the history response aweme_date timestamps by video id", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "734003", caption: "历史记录" }],
      aweme_date: { "734003": 1_700_000_000_123 },
    });

    expect(result.records[0]).toMatchObject({
      occurredAt: "2023-11-14T22:13:20.123Z",
      occurredAtSource: "platform_action",
    });
  });

  it("accepts empty favorite lists as a successful response", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/aweme/listcollection/");
    expect(normalizeDouyinResponse(endpoint, { status_code: 0, aweme_list: [], has_more: false }).records).toEqual([]);
  });

  it("extracts favorite folder metadata without video guessing", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/list/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      collects_list: [{ collects_id_str: "42", collects_name: "教程" }],
    });
    expect(result).toEqual({
      records: [],
      folders: [{ id: "42", name: "教程" }],
      pagination: { hasMore: null, cursor: null },
    });
  });

  it("uses an explicit folder total as a terminal single-page contract", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/list/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      collects_list: [{ collects_id_str: "42", collects_name: "教程" }],
      total: "1",
    });

    expect(result.pagination).toEqual({ hasMore: false, cursor: null });
  });

  it("does not infer folder completion when total exceeds the returned page", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/list/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      collects_list: [{ collects_id_str: "42", collects_name: "教程" }],
      total: 2,
    });

    expect(result.pagination).toEqual({ hasMore: null, cursor: null });
  });

  it("accepts a null folder list only with an explicit empty terminal contract", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/list/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      collects_list: null,
      total_number: 0,
      has_more: false,
      cursor: 0,
    });

    expect(result.folders).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("rejects a null folder list when the response still claims more data", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/list/");
    expect(() => normalizeDouyinResponse(endpoint, {
      status_code: 0,
      collects_list: null,
      total_number: 0,
      has_more: true,
      cursor: 0,
    })).toThrowError(CollectorAdapterError);
  });

  it("reports schema changes instead of claiming an empty success", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/aweme/favorite/");
    expect(() => normalizeDouyinResponse(endpoint, { status_code: 0, items: [] }))
      .toThrowError(CollectorAdapterError);
  });

  it("normalizes bounded metadata and drops untrusted image hosts", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const result = normalizeDouyinResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "metadata-1",
        desc: "#travel a full record",
        create_time: 1_700_000_000,
        history_info: {
          view_time: 1_700_100_000,
          watched_duration: 12_500,
          play_progress: 0.5,
        },
        author: {
          uid: "author-1",
          nickname: "Creator",
          avatar_thumb: { url_list: ["https://p3.douyinpic.com/avatar"] },
        },
        video: {
          duration: 30_000,
          cover: { url_list: ["https://p3.douyinpic.com/cover"] },
        },
        music: {
          id: "music-1",
          title: "Track",
          author: "Artist",
          play_url: { url_list: ["https://p3.douyinvod.com/audio"] },
        },
        cha_list: [{ cha_name: "travel" }],
        text_extra: [{ hashtag_name: "city" }],
        statistics: {
          play_count: 100,
          digg_count: 10,
          comment_count: 3,
          share_count: 2,
          collect_count: 4,
        },
      }, {
        aweme_id: "metadata-2",
        desc: "unsafe image",
        author: {
          avatar_thumb: { url_list: ["https://evil.example/avatar"] },
        },
        video: {
          cover: { url_list: ["https://evil.example/cover"] },
        },
      }],
    });

    expect(result.records[0]).toMatchObject({
      videoId: "metadata-1",
      authorId: "author-1",
      authorAvatarUrl: "https://p3.douyinpic.com/avatar",
      occurredAtSource: "platform_action",
      publishedAt: "2023-11-14T22:13:20.000Z",
      coverUrl: "https://p3.douyinpic.com/cover",
      mediaType: "video",
      durationSeconds: 30,
      music: { id: "music-1", title: "Track", author: "Artist" },
      topics: ["travel", "city"],
      stats: { playCount: 100, diggCount: 10, commentCount: 3, shareCount: 2, collectCount: 4 },
      watchProgress: { watchedSeconds: 12.5, percent: 50 },
    });
    expect(result.records[1]).not.toHaveProperty("authorAvatarUrl");
    expect(result.records[1]).not.toHaveProperty("coverUrl");
  });
});

describe("RecordAccumulator", () => {
  it("keeps watch records at and below twenty percent, zero progress, and unknown progress", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const accumulator = new RecordAccumulator();
    const result = accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "below-twenty",
        play_progress: { play_progress: 1_999 },
        video: { duration: 10_000 },
      }, {
        aweme_id: "zero-progress",
        history_info: { play_progress: 0 },
        video: { duration: 10_000 },
      }, {
        aweme_id: "exactly-twenty",
        play_progress: { play_progress: 2_000 },
        video: { duration: 10_000 },
      }, {
        aweme_id: "unknown-progress",
        video: { duration: 10_000 },
      }],
      has_more: false,
    });

    expect(result.pageSize).toBe(4);
    expect(result.rejectedRecordIds).toEqual([]);
    expect(result.acceptedRecordIds).toEqual([
      "watch_history:below-twenty",
      "watch_history:zero-progress",
      "watch_history:exactly-twenty",
      "watch_history:unknown-progress",
    ]);
    expect(accumulator.snapshot().records.watch_history.map((record) => record.videoId)).toEqual([
      "below-twenty",
      "zero-progress",
      "exactly-twenty",
      "unknown-progress",
    ]);
    expect(accumulator.snapshot().records.watch_history[0]?.watchProgress).toEqual({
      watchedSeconds: 2,
      percent: 19.99,
    });
    expect(accumulator.snapshot().records.watch_history[1]?.watchProgress).toEqual({
      watchedSeconds: 0,
      percent: 0,
    });
    expect(accumulator.snapshot().records.watch_history[2]?.watchProgress).toEqual({
      watchedSeconds: 2,
      percent: 20,
    });
  });

  it("deduplicates records received across pages", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/collects/video/list/");
    const accumulator = new RecordAccumulator();
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "88", desc: "第一版" }],
    });
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "88", desc: "更新标题" }],
    });

    expect(accumulator.snapshot().records.favorite_videos).toHaveLength(1);
    expect(accumulator.snapshot().records.favorite_videos[0]?.title).toBe("更新标题");
  });

  it("returns an irreversible page fingerprint for progress diagnostics", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const accumulator = new RecordAccumulator();
    const result = accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "sensitive-video-id", desc: "历史记录" }],
      has_more: 1,
      max_cursor: "next-page",
    });

    expect(result.pageSize).toBe(1);
    expect(result.added).toBe(1);
    expect(result.pageFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.pageFingerprint).not.toContain("sensitive-video-id");
  });

  it("merges sparse duplicates without erasing valid metadata", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const accumulator = new RecordAccumulator();
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "merge-1",
        desc: "first title #old",
        history_info: { view_time: 1_700_000_000 },
        author: { nickname: "Creator", uid: "creator-1" },
        statistics: { play_count: 10, digg_count: 1 },
      }],
    });
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "merge-1",
        desc: "new title #new",
        statistics: { play_count: 20 },
      }],
    });
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "merge-1", statistics: { play_count: 25 } }],
    });

    const records = accumulator.snapshot().records.watch_history;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "watch_history:merge-1:2023-11-14T22:13:20.000Z",
      title: "new title #new",
      author: "Creator",
      authorId: "creator-1",
      occurredAt: "2023-11-14T22:13:20.000Z",
      occurredAtSource: "platform_action",
      topics: ["old", "new"],
      stats: { playCount: 25, diggCount: 1 },
    });
  });

  it("keeps separate watch events while migrating a timestamped legacy id", () => {
    const endpoint = matchDouyinEndpoint("https://www.douyin.com/aweme/v1/web/history/read/");
    const accumulator = new RecordAccumulator({
      watch_history: [{
        id: "watch_history:repeat-1:1700000000",
        title: "旧记录",
        author: null,
        occurredAt: "2023-11-14T22:13:20.000Z",
        occurredAtSource: "archive_action",
        url: "https://www.douyin.com/video/repeat-1",
      }],
      liked_videos: [],
      favorite_videos: [],
    });

    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{
        aweme_id: "repeat-1",
        desc: "同一次观看的新元数据",
        history_info: { view_time: 1_700_000_000 },
      }, {
        aweme_id: "repeat-1",
        desc: "一小时后再次观看",
        history_info: { view_time: 1_700_003_600 },
      }],
    });
    accumulator.addResponse(endpoint, {
      status_code: 0,
      aweme_list: [{ aweme_id: "repeat-1", desc: "无法归属到某次观看的稀疏响应" }],
    });

    const records = accumulator.snapshot().records.watch_history;
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toEqual([
      "watch_history:repeat-1:2023-11-14T23:13:20.000Z",
      "watch_history:repeat-1:2023-11-14T22:13:20.000Z",
    ]);
    expect(records[1]?.title).toBe("同一次观看的新元数据");
  });
});

describe("live history", () => {
  const url = "https://www.douyin.com/webcast/feed/?source_key=drawer_hot_live_history&max_time=0";
  const payload = {
    status_code: 0,
    extra: { has_more: false, max_time_str: "1787925896450000" },
    data: [
      { type: 11, placeholder: { type: 2, msg: "更早看过" }, latest_watch_time: 0 },
      {
        type: 12,
        latest_watch_time: 1789481964251000,
        latest_watch_time_str: "1789481964251000",
        UserLiveRecord: {
          user_id_str: "1013",
          nickname: "主播甲",
          avatar: { url_list: ["https://p3.douyinpic.com/aweme/100x100/a.jpeg", "https://evil.example/a.jpeg"] },
        },
        user_info: { web_rid: "584923819885", user_canceled: false },
      },
      {
        type: 12,
        latest_watch_time_str: "1787925896450000",
        UserLiveRecord: { user_id_str: "7622", nickname: "已注销" },
        user_info: { user_canceled: true },
      },
    ],
  };

  it("reads the record tab's live list but not the homepage live feed", () => {
    expect(matchDouyinEndpoint(url)).toEqual({ kind: "live_history", pathname: "/webcast/feed/" });
    expect(matchDouyinEndpoint("https://www.douyin.com/webcast/feed/?source_key=web_homepage_hot_web_live_cell")).toBeNull();
  });

  it("turns each anchor into a live watch record and files it under watch history", () => {
    const endpoint = matchDouyinEndpoint(url);
    const result = normalizeDouyinResponse(endpoint, payload);
    expect(result.pagination).toEqual({ hasMore: false, cursor: "1787925896450000" });
    expect(result.records).toEqual([{
      id: "watch_history:live-1013:2026-09-15T14:19:24.251Z",
      title: "主播甲的直播",
      author: "主播甲",
      occurredAt: "2026-09-15T14:19:24.251Z",
      url: "https://live.douyin.com/584923819885",
      videoId: "live-1013",
      authorId: "1013",
      occurredAtSource: "platform_action",
      mediaType: "live",
      authorAvatarUrl: "https://p3.douyinpic.com/aweme/100x100/a.jpeg",
      coverUrl: "https://p3.douyinpic.com/aweme/720x720/a.jpeg",
    }]);

    const accumulator = new RecordAccumulator();
    accumulator.addResponse(endpoint, payload);
    expect(accumulator.snapshot().records.watch_history.map((record) => [record.id, record.mediaType]))
      .toEqual([["watch_history:live-1013:2026-09-15T14:19:24.251Z", "live"]]);
  });
});
