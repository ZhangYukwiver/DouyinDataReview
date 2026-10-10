import { describe, expect, it } from "vitest";
import {
  darenPageUrl, formatChange, formatIndex, formatShare, parseDaren, parseDarenDay, parseFans, parseHotTopics, parseTopVideos, parseWorkAverages, pickDaren, shiftDay, shortDay,
} from "./douyinIndex";

const ok = { BaseResp: { StatusCode: 0, StatusMessage: "" } };
// 达人接口：业务数据和 BaseResp 都包在 data 里（10-10 实抓的结构，数字多半是字符串）
const wrap = (data: object) => ({ data: { ...data, ...ok }, msg: "", status: 0 });

describe("dates", () => {
  it("shifts across month and year ends", () => {
    expect(shiftDay("20261006", -30)).toBe("20260906");
    expect(shiftDay("20260105", -10)).toBe("20251226");
    expect(shiftDay("20240301", -1)).toBe("20240229");
  });
  it("short labels", () => { expect(shortDay("20261006")).toBe("10/06"); });
  it("reads the daren data day and ignores business errors", () => {
    expect(parseDarenDay(wrap({ datetime: "20261008", update_time: "20261008" }))).toBe("20261008");
    expect(parseDarenDay({ data: { BaseResp: { StatusCode: -1 } }, msg: "", status: 0 })).toBeNull();
    expect(parseDarenDay(null)).toBeNull();
  });
});

describe("pickDaren", () => {
  const list = wrap({ userlist: [
    { user_id: "jhaibfhhedc", aweme_id: "Wangyukai0701z", aweme_url: "https://www.douyin.com/user/MS4wLjABAAAA8f1g" },
    { user_id: "fdebcgidigb", aweme_id: "WangYuKai0701", aweme_url: "https://www.douyin.com/user/MS4wLjABAAAASVa?from=x" },
  ] });
  it("matches the profile link first, then the handle (case-insensitive)", () => {
    expect(pickDaren(list, { id: "MS4wLjABAAAASVa", handle: "" })).toBe("fdebcgidigb");
    expect(pickDaren(list, { id: "unknown", handle: "wangyukai0701" })).toBe("fdebcgidigb");
  });
  it("does not guess when nothing matches or the id looks wrong", () => {
    expect(pickDaren(list, { id: "MS4wLjABAAAASV", handle: "WangYuKai070" })).toBeNull();
    expect(pickDaren(wrap({ userlist: [{ user_id: "a b", aweme_url: "https://www.douyin.com/user/X" }] }), { id: "X", handle: "" })).toBeNull();
    expect(pickDaren(null, { id: "X", handle: "x" })).toBeNull();
  });
});

describe("parseDaren", () => {
  const info = wrap({
    user_id: "fdebcgidigb", user_name: "脱缰凯✨", fans_count: "36284966", like_count: "1180882631", item_count: "1004", first_tag_name: "剧情", second_tag_name: "",
    fans_milestone: { first_1000w_fans_date: "20230805", first_1w_fans_date: "20191020", first_100w_fans_date: "20200227", create_time: "1501979661" },
  });
  const trend = wrap({
    like_info: { new_like_count_by_day: "1330136", new_like_count_by_month: "52985618", exchange_by_day: -0.33531784798924225, exchange_by_month: -0.115 },
    fans_info: { new_fans_count_by_week: "245568" },
    likelistday: [{ date: "20261008", count: "1330136", average: 0 }, { date: "20261006", count: "2298629" }, { date: "20261007", count: "2001161" }, { date: "bad", count: "1" }],
    fanslistday: [{ date: "20261008", count: "14809" }],
  });
  it("reads the header, milestones, every period's stats and the daily series in date order", () => {
    const daren = parseDaren(info, trend)!;
    expect(daren).toMatchObject({ id: "fdebcgidigb", name: "脱缰凯✨", tags: ["剧情"], fans: 36284966, likes: 1180882631, works: 1004 });
    expect(daren.milestones).toEqual([{ label: "1万粉", day: "20191020" }, { label: "100万粉", day: "20200227" }, { label: "1000万粉", day: "20230805" }]);
    expect(daren.stats.day.like).toEqual({ value: 1330136, change: -0.33531784798924225 });
    expect(daren.stats.month.like).toEqual({ value: 52985618, change: -0.115 });
    expect(daren.stats.week.fans).toEqual({ value: 245568, change: null });
    expect(daren.daily.days).toEqual(["20261006", "20261007", "20261008"]);
    expect(daren.daily.like).toEqual([2298629, 2001161, 1330136]);
    // 别的指标缺了那天就记 0，横轴跟点赞走
    expect(daren.daily.fans).toEqual([0, 0, 14809]);
    expect(parseDaren(info, trend, 2)!.daily.days).toEqual(["20261007", "20261008"]);
  });
  it("is null when either half is missing or failed", () => {
    expect(parseDaren(info, null)).toBeNull();
    expect(parseDaren({ data: { BaseResp: { StatusCode: -1, StatusMessage: "系统异常" } }, msg: "", status: 0 }, trend)).toBeNull();
    expect(parseDaren(info, wrap({ like_info: {} }))).toBeNull();
  });
});

describe("works and fans", () => {
  it("reads per-work averages for both windows", () => {
    const works = parseWorkAverages(wrap({ like_info: [{ like_average_count_by_week: 1910913.5, like_average_count_by_month: 1766250.3, exchange_by_week: 0.0069, exchange_by_month: 0.041 }], fans_info: [{ fans_average_count_by_week: 55550 }] }));
    expect(works?.week.like).toEqual({ value: 1910913.5, change: 0.0069 });
    expect(works?.month.fans).toEqual({ value: 0, change: null });
    expect(parseWorkAverages(wrap({}))).toBeNull();
  });
  it("keeps each ranking, skips rows without a real work id and reads the misspelt comment field", () => {
    const videos = parseTopVideos(wrap({
      like_list: [{ item_id: "7688236298419630438", video_text: " 复仇者联盟 ", picture: "https://p3-sign.douyinpic.com/a.jpeg", like_cnt: "2508371", coment_cnt: "18633", share_cnt: "207593", follow_cnt: "262039", create_time: "20260922" }, { item_id: "x", video_text: "坏数据" }],
      create_time_list: [],
    }))!;
    expect(videos.like_list).toEqual([{ id: "7688236298419630438", title: "复仇者联盟", cover: "https://p3-sign.douyinpic.com/a.jpeg", day: "20260922", likes: 2508371, comments: 18633, shares: 207593, follows: 262039 }]);
    expect(videos.create_time_list).toEqual([]);
    expect(parseTopVideos(wrap({ like_list: [] }))).toBeNull();
  });
  it("pairs shares with TGI by name, orders ages by age and drops the 'unclassified' interests", () => {
    const fans = parseFans(wrap({
      Gender: JSON.stringify([{ name: "male", value: 0.67 }, { name: "female", value: 0.33 }]), Gender_Tgi: JSON.stringify([{ name: "female", value: 71.2 }, { name: "male", value: 126.7 }]),
      Age: JSON.stringify([{ name: "31-40", value: 0.28 }, { name: "50-", value: 0.21 }, { name: "18-23", value: 0.24 }]),
      FirstTag: JSON.stringify([{ name: "随拍", value: 0.048 }, { name: "未分类（投稿数不足）", value: 0.045 }, { name: "剧情", value: 0.046 }]),
      SecondTag: "", City: "not json",
    }))!;
    expect(fans.map((group) => group.title)).toEqual(["性别", "年龄", "兴趣"]);
    expect(fans[0]!.rows).toEqual([{ label: "男", share: 0.67, tgi: 126.7 }, { label: "女", share: 0.33, tgi: 71.2 }]);
    expect(fans[1]!.rows.map((row) => row.label)).toEqual(["18-23", "31-40", "50 以上"]);
    expect(fans[2]!.rows.map((row) => row.label)).toEqual(["随拍", "剧情"]);
    expect(parseFans(wrap({ SecondTag: "" }))).toBeNull();
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
  it("links to the official daren page", () => {
    expect(darenPageUrl("fdebcgidigb")).toBe("https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/daren/detail?uid=fdebcgidigb");
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
