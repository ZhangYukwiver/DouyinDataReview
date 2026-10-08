import { describe, expect, it } from "vitest";
import {
  dayGap, formatChange, formatIndex, formatShare, indexKeyword, indexPageUrl, indexWindow, parseHotTopics, parseKeywordValid, parseLatestDay, parsePortrait, parseRelatedWords, parseScores, parseTrend, shiftDay, shortDay,
} from "./douyinIndex";

const ok = { BaseResp: { StatusCode: 0, StatusMessage: "" } };

describe("indexKeyword", () => {
  it("only lets plain words through, not links or work ids", () => {
    expect(indexKeyword("  咖啡 ")).toBe("咖啡");
    expect(indexKeyword("C++ & 咖啡")).toBe("C++ & 咖啡");
    expect(indexKeyword("")).toBeNull();
    expect(indexKeyword("https://www.douyin.com/video/7690508847588330798")).toBeNull();
    expect(indexKeyword("7690508847588330798")).toBeNull();
    expect(indexKeyword("字".repeat(31))).toBeNull();
    expect(indexKeyword("a\nb")).toBeNull();
  });
});

describe("dates", () => {
  it("shifts across month and year ends", () => {
    expect(shiftDay("20261006", -30)).toBe("20260906");
    expect(shiftDay("20260105", -10)).toBe("20251226");
    expect(shiftDay("20240301", -1)).toBe("20240229");
  });
  it("ends at the latest day and never starts before the word has data", () => {
    expect(indexWindow("20261006", "20190101")).toEqual({ start: "20260906", end: "20261006" });
    expect(indexWindow("20261006", "20261001")).toEqual({ start: "20261001", end: "20261006" });
    expect(indexWindow("20261006", null)).toEqual({ start: "20260906", end: "20261006" });
  });
  it("short labels", () => { expect(shortDay("20261006")).toBe("10/06"); });
  it("counts the days between two dates", () => {
    expect(dayGap("20261006", "20261004")).toBe(2);
    expect(dayGap("20260301", "20260228")).toBe(1);
    expect(dayGap("20261004", "20261006")).toBe(-2);
  });
});

describe("parseLatestDay / parseKeywordValid", () => {
  it("reads the latest day and ignores business errors", () => {
    expect(parseLatestDay({ keyword_latest_day: "20261006", ...ok })).toBe("20261006");
    expect(parseLatestDay({ keyword_latest_day: "20261006", BaseResp: { StatusCode: -1 } })).toBeNull();
    expect(parseLatestDay(null)).toBeNull();
  });
  it("tells a word with an index from one without", () => {
    expect(parseKeywordValid({ 咖啡: { status: 0, valid_day: "20190101" } }, "咖啡")).toEqual({ hasData: true, validDay: "20190101" });
    expect(parseKeywordValid({ 冷门: { status: 2, valid_day: "" } }, "冷门")).toEqual({ hasData: false, validDay: null });
    // 服务端会把词归一化（去空格、转小写），键对不上时取唯一那一项
    expect(parseKeywordValid({ iphone: { status: 0, valid_day: "20210920" } }, "iPhone")).toEqual({ hasData: true, validDay: "20210920" });
    expect(parseKeywordValid({}, "x")).toEqual({ hasData: false, validDay: null });
  });
});

describe("parseTrend", () => {
  const item = (keyword: string, scale = 1) => ({
    keyword,
    // 故意乱序：官方不保证逐日顺序
    hot_list: [{ datetime: "20261002", index: String(300 * scale) }, { datetime: "20261001", index: String(100 * scale) }],
    search_hot_list: [{ datetime: "20261001", index: String(10 * scale) }, { datetime: "20261002", index: String(30 * scale) }],
    average: { average: String(200 * scale), search_average: String(20 * scale) },
    last_average: { average: String(250 * scale), search_average: String(10 * scale) },
    last_year_average: { average: "0", search_average: String(16 * scale) },
    top_point_list: [{ date: "20261002", style: "1" }, { date: "20261001", style: "0" }],
    // 搜索指数有自己的飙升/波峰点，和综合指数的不是同一批日子
    search_top_point_list: [{ date: "20260930", style: "1" }, { date: "20260930", style: "1" }, { date: "20261001", style: "0" }],
  });

  it("matches the keyword, sorts days, and works out mom/yoy from the averages", () => {
    const trend = parseTrend({ hot_list: [item("拿铁", 7), item("咖啡")], ...ok }, "咖啡")!;
    expect(trend.days).toEqual(["20261001", "20261002"]);
    expect(trend.comprehensive).toEqual([100, 300]);
    expect(trend.search).toEqual([10, 30]);
    expect(trend.averages).toEqual({ comprehensive: 200, search: 20 });
    expect(trend.mom.comprehensive).toBeCloseTo(-0.2);
    expect(trend.mom.search).toBeCloseTo(1);
    expect(trend.yoy.comprehensive).toBeNull();
    expect(trend.yoy.search).toBeCloseTo(0.25);
    expect(trend.highlights.comprehensive).toEqual({ rises: ["20261001"], peaks: ["20261002"] });
    expect(trend.highlights.search).toEqual({ rises: ["20261001"], peaks: ["20260930"] });
  });

  it("returns null for a word without an index", () => {
    expect(parseTrend({ hot_list: [], ...ok }, "冷门")).toBeNull();
    expect(parseTrend({ hot_list: [{ keyword: "冷门", hot_list: [] }], ...ok }, "冷门")).toBeNull();
    expect(parseTrend({ hot_list: [item("咖啡")], BaseResp: { StatusCode: 414 } }, "咖啡")).toBeNull();
  });
});

describe("parseScores", () => {
  const entry = (keyword: string, overview: object, diffs: object) => ({ keyword, overview, last_period_diff: diffs, last_year_diff: diffs });
  it("maps content/spread/search scores", () => {
    const scores = parseScores({
      keyword_index_interpretations: [
        entry("拿铁", { content_index: 1, consume_index: 1, search_index: 1 }, {}),
        entry("咖啡", { content_index: 871830, consume_index: 1088312, search_index: 11021526 }, { content_diff: 0.029, consume_diff: -0.157, search_diff: -1 }),
      ], ...ok,
    }, "咖啡")!;
    expect(scores).toEqual({ content: 871830, spread: 1088312, search: 11021526 });
  });
  it("treats all-zero scores as no data", () => {
    expect(parseScores({ keyword_index_interpretations: [entry("冷门", { content_index: 0, consume_index: 0, search_index: 0 }, { content_diff: -1 })], ...ok }, "冷门")).toBeNull();
  });
});

describe("parseRelatedWords", () => {
  const row = (relation_word: string, score_rank: string, relation_score: number, score_rate = "1.2%", correlation_change = false) => ({ relation_word, score_rank, relation_score, score_rate, correlation_change });
  it("sorts by rank and marks only the words the official page calls new", () => {
    // correlation_change 实测是「关联度没降」，老词（涨幅是正数）也常为 true，不能当成新词
    const words = parseRelatedWords({ search_relation_word_list: [row("c", "3", 0.0025), row("a", "1", 0.01, "14.10%", true), row("b", "2", 0.0064, "新", true), { relation_word: "" }], ...ok });
    expect(words).toEqual([{ word: "a", fresh: false }, { word: "b", fresh: true }, { word: "c", fresh: false }]);
  });
  it("is empty for a cold word and honours the limit", () => {
    expect(parseRelatedWords({ ...ok })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => row(`w${index}`, String(index + 1), 1 / (index + 1)));
    expect(parseRelatedWords({ search_relation_word_list: many, ...ok }, 5)).toHaveLength(5);
  });
});

describe("parsePortrait", () => {
  const group = (name_en: string, label_list: object[]) => ({ name_en, label_list });
  it("keeps age and gender whole and the biggest few provinces", () => {
    const portrait = parsePortrait({
      data: [
        group("age", [{ name_zh: "18-23", value: 0.2137, tgi: 105.5 }, { name_zh: "24-30", value: 0.3, tgi: 120 }]),
        group("gender", [{ name_zh: "男", value: 0.4, tgi: 90 }, { name_zh: "女", value: 0.6, tgi: 110 }]),
        group("province", [{ name_zh: "A", value: 0.05 }, { name_zh: "B", value: 0.2 }, { name_zh: "C", value: 0.1 }]),
      ], ...ok,
    }, 2)!;
    expect(portrait.age[0]).toEqual({ label: "18-23", share: 0.2137 });
    expect(portrait.gender.map((row) => row.label)).toEqual(["男", "女"]);
    expect(portrait.provinces.map((row) => row.label)).toEqual(["B", "C"]);
  });
  it("is null when the word has no portrait", () => {
    expect(parsePortrait({ BaseResp: { StatusCode: 500, StatusMessage: "关键词不为空" } })).toBeNull();
    expect(parsePortrait({ data: [], ...ok })).toBeNull();
  });
});

describe("formatting", () => {
  it("uses the official 万 habit", () => {
    expect(formatIndex(4940000)).toBe("494.0 万");
    expect(formatIndex(9999)).toBe("9999");
    expect(formatIndex(1234.6)).toBe("1235");
  });
  it("signs changes and handles missing ones", () => {
    expect(formatChange(0.2509)).toBe("+25.1%");
    expect(formatChange(-0.0709)).toBe("-7.1%");
    expect(formatChange(1.5)).toBe("+150%");
    expect(formatChange(null)).toBe("—");
    expect(formatShare(0.2137)).toBe("21%");
    expect(formatShare(0.05)).toBe("5.0%");
  });
  it("links to the official page with the word encoded", () => {
    expect(indexPageUrl("咖啡 & 拿铁")).toBe("https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/analysis?source=creator&keyword=%E5%92%96%E5%95%A1%20%26%20%E6%8B%BF%E9%93%81&tab=heat_index&appName=aweme");
  });
});

describe("parseHotTopics", () => {
  const entry = (rank: string, name: string, flag: string) => ({ rank, topic_name: name, topic_index: "12101718", rank_flag: flag, content_cnt: "3", vv: "547", category: "旅行" });
  it("reads both boards, orders by rank and maps rank_flag to a direction", () => {
    const topics = parseHotTopics({ ...ok, current: [entry("2", "B", "-1"), entry("1", "A", "1"), entry("3", " ", "0"), entry("4", "D", "0")], rocketing: [entry("1", "R", "0")] });
    expect(topics?.current.map((item) => [item.rank, item.name, item.trend])).toEqual([[1, "A", 1], [2, "B", -1], [4, "D", 0]]);
    expect(topics?.current[0]).toMatchObject({ index: 12101718, category: "旅行" });
    expect(topics?.rocketing).toHaveLength(1);
  });
  it("treats a business error or two empty boards as not read", () => {
    expect(parseHotTopics({ BaseResp: { StatusCode: 500 }, current: [entry("1", "A", "0")] })).toBeNull();
    expect(parseHotTopics({ ...ok, current: [], rocketing: [] })).toBeNull();
    expect(parseHotTopics(null)).toBeNull();
  });
});
