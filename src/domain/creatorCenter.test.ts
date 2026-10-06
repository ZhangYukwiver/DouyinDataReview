import { describe, expect, it } from "vitest";
import {
  commentSelectOptions, commentTime, contentType, dashboardCardValue, dashboardMetrics, DASHBOARD_CARDS, dcCount, dcValue, detailDuration,
  detailMetric, diagnosisBlock, diagnosisSentence, durationText, listCount, listDuration, listMetricSet, listMetricsHidden, listRate,
  normalizeComment, olderThanDays, periodText, playSources, portraitPercent, shortCount, workStatus,
} from "./creatorCenter";

// 期望值都来自 10-06 抓到的官方页面截图/文字（zzzz张 账号）或官方前端代码里的例子
describe("number formats", () => {
  it("matches the data center formats", () => {
    expect(dcCount(36)).toBe("36");
    expect(dcCount(0)).toBe("0");
    expect(dcCount(null)).toBe("-");
    expect(dcCount(123456)).toBe("12.35万");
    expect(dcValue(36.84210526315789, "%")).toBe("36.84%");
    expect(dcValue(5.157894736842105, "s")).toBe("5.16s");
    expect(dcValue(0, "%")).toBe("0");
  });

  it("matches the work list card formats", () => {
    expect(listRate("0.696970")).toBe("69.7%");
    expect(listRate("0.031250")).toBe("3.13%");
    expect(listRate("0.010753")).toBe("1.08%");
    expect(listRate("0")).toBe("0%");
    expect(listRate(undefined)).toBe("--");
    expect(listCount("196")).toBe("196");
    expect(listCount("12345")).toBe("1.2万");
    expect(listCount("1.000000")).toBe("1");
  });

  it("matches the work detail card formats", () => {
    expect(detailMetric("0.010753", "percent")).toEqual({ text: "1.08", unit: "%" });
    expect(detailMetric("0.592040", "percent")).toEqual({ text: "59.20", unit: "%" });
    expect(detailMetric("0", "percent")).toEqual({ text: "0.00", unit: "%" });
    expect(detailMetric("0", "percent", true)).toEqual({ text: "0", unit: "%" });
    expect(detailMetric("196", "count")).toEqual({ text: "196", unit: "" });
    expect(detailMetric("15000", "count")).toEqual({ text: "1.50", unit: "万" });
    expect(detailMetric("10000", "count")).toEqual({ text: "1", unit: "万" });
    expect(detailMetric("3.537313", "time")).toEqual({ text: "4秒", unit: "" });
    expect(detailMetric(undefined, "count")).toEqual({ text: "-", unit: "" });
    expect(durationText(63)).toBe("1分3秒");
    expect(shortCount(7402465)).toBe("740.2万");
    expect(shortCount(10000)).toBe("1万");
    expect(portraitPercent(0.12179)).toBe("12.18%");
    expect(portraitPercent(0.00001)).toBe("<0.01%");
  });

  it("formats durations and comment times", () => {
    expect(listDuration(90001)).toBe("01:30");
    expect(listDuration(58867)).toBe("00:59");
    expect(detailDuration(58867)).toBe("0:00:58");
    const now = new Date(2026, 9, 6, 14, 0).getTime();
    expect(commentTime(now / 1000 - 30, now)).toBe("刚刚");
    expect(commentTime(now / 1000 - 600, now)).toBe("10分钟前");
    expect(commentTime(new Date(2026, 9, 5, 9, 5).getTime() / 1000, now)).toBe("昨天09:05");
    expect(commentTime(new Date(2026, 8, 1, 9, 5).getTime() / 1000, now)).toBe("09月01日 09:05");
    expect(commentTime(new Date(2025, 8, 1, 9, 5).getTime() / 1000, now)).toBe("2025年09月01日 09:05");
  });
});

describe("data center", () => {
  const diagnosis = {
    PlayCnt: { OwnValue: 36, AuthorRank: 0.656198895240332, SimilarValue: 11 },
    Interact: { OwnValue: 0.027777777777777776, AuthorRank: 0.21042738762067512 },
    PlayFinishRatio: { OwnValue: 0, AuthorRank: 0 },
    PublishActivation: { OwnValue: 1, AuthorRank: 0.5669724748957686 },
  };

  it("builds the diagnosis blocks like the official page", () => {
    expect(diagnosisBlock("PlayCnt", diagnosis.PlayCnt)).toEqual({ label: "播放量", value: "36", rankText: "超过66%同类作者", tag: "较好" });
    expect(diagnosisBlock("Interact", diagnosis.Interact)).toMatchObject({ value: "2.8%", rankText: "低于79%同类作者", tag: null });
    expect(diagnosisBlock("PlayFinishRatio", diagnosis.PlayFinishRatio)).toMatchObject({ value: "0.0%", rankText: "低于100%同类作者" });
    const text = (key: Parameters<typeof diagnosisSentence>[0], entry: object) => diagnosisSentence(key, entry).parts.map((part) => part.text).join("");
    expect(text("PlayCnt", diagnosis.PlayCnt)).toBe("您的视频播放量为36，高于65.62%的同类创作者");
    expect(text("PublishActivation", diagnosis.PublishActivation)).toBe("您的投稿数为1，高于56.70%的同类创作者");
    expect(text("Interact", diagnosis.Interact)).toMatch(/^您的互动指数为2\.78%，低于78\.96%的同类创作者。作品的开头/u);
    expect(text("PlayFinishRatio", diagnosis.PlayFinishRatio)).toMatch(/^您的完播率为0\.00%，低于100%的同类创作者。想要作品吸引人/u);
  });

  it("maps dashboard metrics onto the official cards", () => {
    const payload = { metrics: [
      { english_metric_name: "play_cnt", metric_value: 36 }, { english_metric_name: "publish_cnt", metric_value: 1 },
      { english_metric_name: "completion_rate_5s", metric_value: 0.3684210526315789 }, { english_metric_name: "cover_click_ratio" },
      { english_metric_name: "avg_view_second", metric_value: 5.157894736842105 },
    ] };
    const metrics = dashboardMetrics("aweme", payload);
    const value = (key: string) => dashboardCardValue(DASHBOARD_CARDS.aweme.find((card) => card.key === key)!, metrics.get(key));
    expect(value("vv")).toBe("36");
    expect(value("publish_cnt")).toBe("1");
    expect(value("completion_rate_5s")).toBe("36.84%");
    expect(value("cover_click_ratio")).toBe("0");
    expect(value("average_play_duration")).toBe("5.16s");
    expect(value("like")).toBe("-");
    expect(periodText(7, new Date(2026, 9, 6))).toBe("2026-09-29 至 2026-10-05");
    expect(periodText(1, new Date(2026, 9, 6))).toBe("2026-10-05");
  });
});

describe("work list", () => {
  it("derives status labels and hides metrics for private works", () => {
    expect(workStatus({ status_value: 102, status: {} })).toEqual({ key: "PUBLISHED", label: "已发布" });
    expect(workStatus({ status_value: 141, status: {} }).label).toBe("审核中");
    expect(workStatus({ status_value: 144, status: {} }).label).toBe("不适宜公开");
    expect(workStatus({ status_value: 140, status: { private_status: 1, is_private: true } })).toEqual({ key: "PRIVATE", label: "" });
    expect(listMetricsHidden({ status_value: 140, status: { private_status: 1, is_private: true } }, { view_count: "0" })).toBe(true);
    expect(listMetricsHidden({ status_value: 102, status: {} }, { view_count: "32" })).toBe(false);
    expect(listMetricsHidden({ status_value: 102, status: {} }, undefined)).toBe(true);
  });

  it("picks the metric set by content", () => {
    expect(listMetricSet({ duration: 90001, type: 3 }).map((metric) => metric.label)).toEqual(["播放", "点赞", "评论", "分享", "收藏", "完播率", "2秒跳出率", "吸粉量"]);
    expect(listMetricSet({ duration: 200000, type: 4 }).map((metric) => metric.label)).toContain("平均播放占比");
    expect(listMetricSet({ is_pic_word: true, type: 1 }).map((metric) => metric.label)).toContain("文案展开率");
  });
});

describe("work detail", () => {
  it("classifies content and age", () => {
    expect(contentType(2)).toBe("SHORT_VIDEO");
    expect(contentType(4)).toBe("MID_VIDEO");
    expect(contentType(6)).toBe("IMAGE_TEXT");
    expect(contentType(8)).toBe("LONG_ARTICLE");
    const now = new Date(2026, 9, 6, 12);
    expect(olderThanDays(new Date(2026, 8, 28).getTime() / 1000, 90, now)).toBe(false);
    expect(olderThanDays(new Date(2026, 5, 1).getTime() / 1000, 90, now)).toBe(true);
  });

  it("processes play sources like the official table", () => {
    const sources = playSources([
      { app_id: 1128, key: "homepage_hot", value: 0.989247311827957, history_difference: -0.010752688172043001 },
      { app_id: 1128, key: "other", value: 0.010752688172043012, history_difference: 0.010752688172043012 },
      { app_id: 1128, key: "self_profile_vv_all", value: 0.01, history_difference: 0 },
      { app_id: 1128, key: "search", value: 0.0001, history_difference: 0 },
      { app_id: 2329, key: "yumme_vv_all", value: 0.2, history_difference: 0.0004 },
    ]);
    expect(sources.douyin).toEqual([
      { name: "推荐页", value: 0.989247311827957, percent: 98.9, diff: -1.1 },
      { name: "其他", value: 0.010752688172043012, percent: 1.1, diff: 1.1 },
    ]);
    expect(sources.other).toEqual([{ name: "精选App", value: 0.2, percent: 20, diff: 0 }]);
  });

  it("normalizes comments and filter options", () => {
    expect(commentSelectOptions("0", "0")).toBe("0");
    expect(commentSelectOptions("not_replied", "0")).toBe("0,not_replied");
    expect(commentSelectOptions("question", "friend")).toBe("friend,question");
    const comment = normalizeComment({
      cid: "1", text: "你好[微笑]", create_time: 1791266000, digg_count: 12000, reply_comment_total: 3, label_type: 1,
      user: { nickname: "", avatar_thumb: { url_list: ["a", "b"] } }, reply_comment: [{ cid: "2", text: "回", user: { nickname: "x" } }],
    });
    expect(comment).toMatchObject({ id: "1", name: "抖音用户", avatar: "b", isAuthor: true, likes: "1.2万", replyCount: 3 });
    expect(comment.replies[0]).toMatchObject({ id: "2", name: "x" });
  });
});
