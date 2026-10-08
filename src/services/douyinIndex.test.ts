import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorQuery, CreatorResult } from "./creatorCenter";
import { clearKeywordIndexCache, loadKeywordExtras, loadKeywordIndex } from "./douyinIndex";

const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
const ok = { BaseResp: { StatusCode: 0 } };
const hit = (data: object): CreatorResult => ({ data: { ...data, ...ok } });
const miss: CreatorResult = { data: null, reason: "failed", status: 500 };
const undecryptable: CreatorResult = { data: null, reason: "undecryptable", status: 200 };
beforeEach(() => clearKeywordIndexCache());

const trendData = { hot_list: [{ keyword: "咖啡", hot_list: [{ datetime: "20261006", index: "100" }], search_hot_list: [{ datetime: "20261006", index: "10" }], average: { average: "100", search_average: "10" }, last_average: {}, last_year_average: {}, top_point_list: [] }] };
const scoreData = { keyword_index_interpretations: [{ keyword: "咖啡", overview: { content_index: 1, consume_index: 2, search_index: 3 }, last_period_diff: {}, last_year_diff: {} }] };

function fakeRead(handlers: Record<string, CreatorResult>) {
  return vi.fn(async (_connection: unknown, queries: CreatorQuery[]) => queries.map((query) => handlers[query.key] ?? miss));
}

describe("loadKeywordIndex", () => {
  const handlers = {
    index_valid_date: hit({ keyword_latest_day: "20261006" }),
    index_keyword_valid: hit({ 咖啡: { status: 0, valid_day: "20190101" } }),
    index_hot_trend: hit(trendData),
    index_interpretation: hit(scoreData),
  };

  it("walks the minimal chain and asks for the 31-day window ending on the latest day", async () => {
    const read = fakeRead(handlers);
    const result = await loadKeywordIndex(connection, "咖啡", undefined, read);
    expect(result).toMatchObject({ state: "ok", keyword: "咖啡", latestDay: "20261006", scores: { content: 1, spread: 2, search: 3 } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]![1]).toEqual([{ key: "index_valid_date" }, { key: "index_keyword_valid", params: { keyword: "咖啡" } }]);
    expect(read.mock.calls[1]![1][0]).toEqual({ key: "index_hot_trend", params: { keyword: "咖啡", start_date: "20260906", end_date: "20261006", app_name: "aweme" } });
  });

  it("stops after the first batch for a word without an index", async () => {
    const read = fakeRead({ ...handlers, index_keyword_valid: hit({ 冷门: { status: 2, valid_day: "" } }) });
    expect(await loadKeywordIndex(connection, "冷门", undefined, read)).toEqual({ state: "no_data" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("separates an unreadable answer and a failed read from 'no data'", async () => {
    await expect(loadKeywordIndex(connection, "咖啡", undefined, fakeRead({ ...handlers, index_hot_trend: undecryptable }))).rejects.toMatchObject({ code: "index_undecryptable" });
    clearKeywordIndexCache();
    await expect(loadKeywordIndex(connection, "咖啡", undefined, fakeRead({ ...handlers, index_hot_trend: miss }))).rejects.toMatchObject({ code: "index_unavailable" });
    clearKeywordIndexCache();
    await expect(loadKeywordIndex(connection, "咖啡", undefined, fakeRead({ ...handlers, index_valid_date: miss }))).rejects.toMatchObject({ code: "index_unavailable" });
  });

  it("treats an official business error as unreadable, not as 'no index', and does not cache it", async () => {
    const busy = { BaseResp: { StatusCode: 500, StatusMessage: "系统繁忙" } };
    const read = fakeRead({ ...handlers, index_hot_trend: { data: { hot_list: [], ...busy } } });
    await expect(loadKeywordIndex(connection, "咖啡", undefined, read, 1_000)).rejects.toMatchObject({ code: "index_unavailable" });
    // 没缓存：马上再搜会重新读
    const callsBefore = read.mock.calls.length;
    await expect(loadKeywordIndex(connection, "咖啡", undefined, read, 2_000)).rejects.toMatchObject({ code: "index_unavailable" });
    expect(read.mock.calls.length).toBeGreaterThan(callsBefore);
    clearKeywordIndexCache();
    await expect(loadKeywordIndex(connection, "咖啡", undefined, fakeRead({ ...handlers, index_keyword_valid: { data: { ...busy } } }), 1_000)).rejects.toMatchObject({ code: "index_unavailable" });
    // 对照：官方明确说没有（BaseResp 正常、hot_list 为空）才是无指数
    clearKeywordIndexCache();
    expect(await loadKeywordIndex(connection, "咖啡", undefined, fakeRead({ ...handlers, index_hot_trend: hit({ hot_list: [] }) }), 1_000)).toEqual({ state: "no_data" });
  });

  it("keeps working when only the score batch item fails, and caches for ten minutes", async () => {
    const read = fakeRead({ ...handlers, index_interpretation: miss });
    const first = await loadKeywordIndex(connection, "咖啡", undefined, read, 1_000);
    expect(first).toMatchObject({ state: "ok", scores: null });
    expect(await loadKeywordIndex(connection, "咖啡", undefined, read, 1_000 + 9 * 60_000)).toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
    await loadKeywordIndex(connection, "咖啡", undefined, read, 1_000 + 11 * 60_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("loadKeywordExtras", () => {
  it("uses the relation day (three days behind) for a 7-day window", async () => {
    const read = fakeRead({
      index_relation_valid_date: hit({ datetime: "20261004" }),
      index_relation_word: hit({ search_relation_word_list: [{ relation_word: "拿铁", score_rank: "1", relation_score: 0.5, score_rate: "新", correlation_change: true }] }),
      index_portrait: hit({ data: [{ name_en: "gender", label_list: [{ name_zh: "女", value: 0.6, tgi: 110 }] }] }),
    });
    const extras = await loadKeywordExtras(connection, "咖啡", undefined, read);
    expect(extras).toMatchObject({ day: "20261004", related: [{ word: "拿铁", fresh: true }], portrait: { gender: [{ label: "女" }] }, relatedMissing: false, portraitMissing: false });
    // 十分钟内同一个词不重读
    expect(await loadKeywordExtras(connection, "咖啡", undefined, read, Date.now() + 60_000)).toBe(extras);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![1][0]).toEqual({ key: "index_relation_word", params: { keyword: "咖啡", start_date: "20260928", end_date: "20261004", app_name: "aweme" } });
  });

  it("returns what it can and fails only when both are missing", async () => {
    const day = hit({ datetime: "20261004" });
    const partial = await loadKeywordExtras(connection, "咖啡", undefined, fakeRead({ index_relation_valid_date: day, index_relation_word: miss, index_portrait: hit({ data: [{ name_en: "age", label_list: [{ name_zh: "18-23", value: 0.2 }] }] }) }));
    expect(partial.related).toEqual([]);
    expect(partial.portrait?.age).toHaveLength(1);
    // 失败的那一半要标出来，界面才不会把「没读到」说成「没有」
    expect(partial).toMatchObject({ relatedMissing: true, portraitMissing: false });
    // 缺了一半是临时没读到：不缓存，马上再点能重新读
    const reads = fakeRead({ index_relation_valid_date: day, index_relation_word: hit({ search_relation_word_list: [{ relation_word: "拿铁", score_rank: "1", relation_score: 1, score_rate: "1%" }] }), index_portrait: hit({ data: [{ name_en: "age", label_list: [{ name_zh: "18-23", value: 0.2 }] }] }) });
    clearKeywordIndexCache();
    await loadKeywordExtras(connection, "咖啡", undefined, fakeRead({ index_relation_valid_date: day, index_portrait: hit({ data: [{ name_en: "age", label_list: [{ name_zh: "18-23", value: 0.2 }] }] }) }), 1_000);
    expect(await loadKeywordExtras(connection, "咖啡", undefined, reads, 2_000)).toMatchObject({ relatedMissing: false, related: [{ word: "拿铁" }] });
    clearKeywordIndexCache();
    const businessError = { data: { BaseResp: { StatusCode: 500, StatusMessage: "关键词不为空" } } };
    expect(await loadKeywordExtras(connection, "咖啡", undefined, fakeRead({ index_relation_valid_date: day, index_relation_word: hit({ search_relation_word_list: [{ relation_word: "拿铁", score_rank: "1", relation_score: 1, score_rate: "1%" }] }), index_portrait: businessError }))).toMatchObject({ portraitMissing: true, related: [{ word: "拿铁" }] });
    clearKeywordIndexCache();
    await expect(loadKeywordExtras(connection, "咖啡", undefined, fakeRead({ index_relation_valid_date: day }))).rejects.toMatchObject({ code: "index_unavailable", message: expect.stringContaining("关联词和人群") });
  });
});
