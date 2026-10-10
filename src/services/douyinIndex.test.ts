import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorQuery, CreatorResult } from "./creatorCenter";
import { clearDarenCache, clearHotTopicsCache, loadDaren, loadHotTopics } from "./douyinIndex";

const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
// 达人接口的业务数据和 BaseResp 都包在 data 里
const hit = (data: object): CreatorResult => ({ data: { data: { ...data, BaseResp: { StatusCode: 0 } }, msg: "", status: 0 } });
const miss: CreatorResult = { data: null, reason: "failed", status: 500 };
beforeEach(() => clearDarenCache());

function fakeRead(handlers: Record<string, CreatorResult>) {
  return vi.fn(async (_connection: unknown, queries: CreatorQuery[]) => queries.map((query) => handlers[query.key] ?? miss));
}

const user = { id: "MS4wLjABAAAASVa", handle: "WangYuKai0701", name: "脱缰凯✨" };
const handlers = {
  daren_valid_date: hit({ datetime: "20261008" }),
  daren_suggest: hit({ userlist: [
    { user_id: "jhaibfhhedc", aweme_id: "Wangyukai0701z", aweme_url: "https://www.douyin.com/user/MS4wLjABAAAA8f1g" },
    { user_id: "fdebcgidigb", aweme_id: "WangYuKai0701", aweme_url: "https://www.douyin.com/user/MS4wLjABAAAASVa" },
  ] }),
  daren_info: hit({ user_id: "fdebcgidigb", user_name: "脱缰凯✨", fans_count: "36284966", like_count: "1180882631", item_count: "1004", first_tag_name: "剧情", second_tag_name: "演绎", fans_milestone: {} }),
  daren_trend: hit({ like_info: { new_like_count_by_day: "1330136", exchange_by_day: -0.3 }, likelistday: [{ date: "20261008", count: "1330136" }, { date: "20261007", count: "2001161" }] }),
  daren_work_average: hit({ like_info: [{ like_average_count_by_week: 1910913.5, exchange_by_week: 0.01 }] }),
  daren_top_videos: hit({ like_list: [{ item_id: "7688236298419630438", video_text: "复仇者联盟", like_cnt: "2508371", coment_cnt: "18633", create_time: "20260922" }] }),
  daren_fans: hit({ Gender: JSON.stringify([{ name: "male", value: 0.67 }, { name: "female", value: 0.33 }]) }),
};

describe("loadDaren", () => {
  it("finds the creator by profile link, then reads everything in one more batch", async () => {
    const read = fakeRead(handlers);
    const result = await loadDaren(connection, user, undefined, read);
    expect(result).toMatchObject({ state: "ok", latestDay: "20261008", detail: { id: "fdebcgidigb", fans: 36284966, tags: ["剧情", "演绎"] } });
    expect(read.mock.calls[0]![1]).toEqual([{ key: "daren_valid_date" }, { key: "daren_suggest", params: { keyword: "WangYuKai0701" } }]);
    // 近 30 天的作品窗口截到达人库的最新日
    expect(read.mock.calls[1]![1].find((query) => query.key === "daren_top_videos")).toEqual({ key: "daren_top_videos", params: { user_id: "fdebcgidigb", start_date: "20260908", end_date: "20261008" } });
    // 十分钟内同一个人不重读
    await loadDaren(connection, user, undefined, read, Date.now() + 60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says 'not a daren' only when the search really has no match, and caches that", async () => {
    const read = fakeRead({ ...handlers, daren_suggest: hit({ userlist: [{ user_id: "abc", aweme_id: "someone", aweme_url: "https://www.douyin.com/user/other" }] }) });
    expect(await loadDaren(connection, user, undefined, read, 1_000)).toEqual({ state: "none" });
    await loadDaren(connection, user, undefined, read, 2_000);
    expect(read).toHaveBeenCalledTimes(1);
    // 没有抖音号的用昵称搜
    const byName = fakeRead({ ...handlers, daren_suggest: hit({ userlist: [] }) });
    await loadDaren(connection, { ...user, id: "x", handle: "" }, undefined, byName);
    expect(byName.mock.calls[0]![1][1]).toEqual({ key: "daren_suggest", params: { keyword: "脱缰凯✨" } });
  });

  it("treats a failed or business-error search as not read, and does not cache it", async () => {
    const failed = { ...handlers, daren_suggest: { data: { data: { BaseResp: { StatusCode: -1, StatusMessage: "系统异常" } }, msg: "", status: 0 } } };
    await expect(loadDaren(connection, user, undefined, fakeRead(failed), 1_000)).rejects.toMatchObject({ code: "index_unavailable" });
    await expect(loadDaren(connection, user, undefined, fakeRead({ ...handlers, daren_valid_date: miss }), 1_000)).rejects.toMatchObject({ code: "index_unavailable" });
    expect((await loadDaren(connection, user, undefined, fakeRead(handlers), 2_000)).state).toBe("ok");
  });

  it("keeps the author analysis when the other parts fail, without caching the gap", async () => {
    const read = fakeRead({ ...handlers, daren_fans: miss, daren_top_videos: miss });
    expect(await loadDaren(connection, user, undefined, read, 1_000)).toMatchObject({ state: "ok", fans: null, videos: null, works: { week: { like: { value: 1910913.5 } } } });
    await loadDaren(connection, user, undefined, read, 2_000);
    expect(read).toHaveBeenCalledTimes(4);
    await expect(loadDaren(connection, user, undefined, fakeRead({ ...handlers, daren_trend: miss }))).rejects.toMatchObject({ code: "index_unavailable" });
  });
});

describe("loadHotTopics", () => {
  const board = { current: [{ rank: "1", topic_name: "A", topic_index: "100", rank_flag: "1" }], rocketing: [] };
  const reader = (data: any, calls: string[] = []): any => async (_c: unknown, queries: Array<{ key: string }>) => { calls.push(queries[0]!.key); return [{ data }]; };
  it("reads once, caches successes briefly and never caches a miss", async () => {
    clearHotTopicsCache();
    const calls: string[] = [];
    expect((await loadHotTopics(connection, undefined, reader(board, calls), 1_000)).current[0]).toMatchObject({ name: "A", trend: 1 });
    await loadHotTopics(connection, undefined, reader(board, calls), 2_000);
    expect(calls).toEqual(["index_hot_topic"]);
    await loadHotTopics(connection, undefined, reader(board, calls), 1_000 + 4 * 60_000);
    expect(calls).toHaveLength(2);
    clearHotTopicsCache();
    await expect(loadHotTopics(connection, undefined, reader({ BaseResp: { StatusCode: 500 } }))).rejects.toMatchObject({ code: "index_unavailable" });
    await expect(loadHotTopics(connection, undefined, reader(null))).rejects.toMatchObject({ code: "index_unavailable" });
    expect((await loadHotTopics(connection, undefined, reader(board))).current).toHaveLength(1);
  });
});
