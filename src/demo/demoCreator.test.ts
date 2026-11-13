import { describe, expect, it } from "vitest";
import {
  ATTRACTION, AUDIENCE_CARDS, contentType, DASHBOARD_CARDS, dashboardCardValue, dashboardMetrics, detailMetric, DIAGNOSIS, diagnosisBlock, diagnosisSentence,
  ENGAGEMENT, fansDistribution, GENDER_NAMES, LIVE_TABS, listCount, listMetricSet, listMetricsHidden, listRate, normalizeComment, OVERVIEW_FANS, OVERVIEW_TRAFFIC,
  playSources, workStatus,
} from "../domain/creatorCenter";
import { parseHotTopics } from "../domain/douyinIndex";
import { loadDaren, loadHotTopics } from "../services/douyinIndex";
import type { CreatorQuery, CreatorResult } from "../services/creatorCenter";
import { answerCreatorRead } from "./demoCreator";

type Raw = Record<string, any>;
const connection = { baseUrl: "http://127.0.0.1:1", token: "demo" };
// 和 readCreatorResults 一样过一遍 JSON，再按它的规则拆成 CreatorResult
const read = async (_: unknown, queries: CreatorQuery[]): Promise<CreatorResult[]> =>
  (JSON.parse(JSON.stringify(answerCreatorRead({ requests: queries }))).results as Raw[]).map((item) => (item.ok ? { data: item.data } : { data: null, reason: "failed" }));
const ask = (key: CreatorQuery["key"], params: CreatorQuery["params"] = {}): Raw => {
  const [result] = answerCreatorRead({ requests: [{ key, params }] }).results;
  if (!result?.ok) throw new Error(`${key} 没回数据`);
  return result.data;
};
/** 合成数据里不许有 NaN / Infinity（过 JSON 会变成 null，界面上就是「-」） */
function expectFinite(value: unknown, path = "data"): void {
  if (typeof value === "number") expect(Number.isFinite(value), path).toBe(true);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) expectFinite(child, `${path}.${key}`);
}
const shown = (text: string) => { expect(text).not.toMatch(/NaN|^-$|^--$/u); return text; };

describe("在线体验版的创作者中心", () => {
  it("一一对应地回答每个请求，不认识的 key 回 failed", () => {
    const requests: CreatorQuery[] = [{ key: "user_info" }, { key: "dashboard", params: { recent_days: 7 } }, { key: "comment_list_old", params: { item_id: "1" } }, { key: "daren_info", params: { user_id: "nobody" } }];
    const { results } = answerCreatorRead({ requests });
    expect(results).toHaveLength(requests.length);
    expect(results.map((item) => item.ok)).toEqual([true, true, true, false]);
    expect(answerCreatorRead({ requests: [{ key: "publish" }] }).results).toEqual([{ ok: false, reason: "failed" }]);
    expect(answerCreatorRead(null).results).toEqual([]);
  });

  it("账号卡、数据总览、贡献 TOP3 读得出来", () => {
    const info = ask("user_info");
    expect(info.has_data_mgmt_perm).toBe(true);
    expect(info.user_profile.follower_count).toBeGreaterThan(3000);
    expect(info.user_profile.follower_count).toBeLessThan(80000);
    const diagnosis = ask("diagnosis");
    expect(diagnosis.code).toBe(0);
    for (const item of DIAGNOSIS) {
      expect(Number(diagnosis.data[item.key].OwnValue)).toBeGreaterThan(0);
      shown(diagnosisBlock(item.key, diagnosis.data[item.key]).value);
      expect(diagnosisSentence(item.key, diagnosis.data[item.key]).parts.map((part) => part.text).join("")).not.toMatch(/NaN|undefined/u);
    }
    for (const dimension of [1, 2, 3, 5]) {
      const top = ask("contribution_top", { dimension, recent_days: 7 });
      expect(top.items).toHaveLength(3);
      for (const item of top.items) expect(ask("item_mget", { ids: item.item_id }).items).toHaveLength(1);
    }
    expectFinite([info, diagnosis]);
  });

  it("作品数据（投稿 / 合集）和粉丝数据每张卡都有值、趋势天数对", () => {
    expect(ask("mix_list", { count: 1 }).mixs.length).toBeGreaterThan(0);
    for (const days of [1, 7, 30]) {
      for (const [key, tab] of [["dashboard", "aweme"], ["dashboard_mix", "mix"], ["dashboard_fans", "fans"]] as const) {
        const payload = ask(key, { recent_days: days });
        expectFinite(payload);
        const metrics = dashboardMetrics(tab, payload);
        for (const card of DASHBOARD_CARDS[tab]) {
          expect(metrics.get(card.key), `${tab}.${card.key}`).toBeDefined();
          shown(dashboardCardValue(card, metrics.get(card.key)));
          expect(metrics.get(card.key)!.trends).toHaveLength(days);
        }
      }
    }
    const fans = dashboardMetrics("fans", ask("dashboard_fans", { recent_days: 7 }));
    expect(fans.get("total_fans_cnt")!.trends.at(-1).value).toBeLessThanOrEqual(ask("user_info").user_profile.follower_count + 50);
  });

  it("直播五组卡片、趋势和榜单", () => {
    for (const tab of LIVE_TABS) {
      const cards = ask("live_dashboard", { day_window: 7, tab_type: tab.id }).data;
      for (const metric of tab.metrics) {
        expect(cards[metric.key]?.name).toBeTruthy();
        expect(Number(cards[metric.key].value)).toBeGreaterThan(0);
        expect(ask("live_trends", { day_window: 7, metrics_type: metric.type }).data).toHaveLength(7);
      }
    }
    expect(ask("live_gift_billboard", { day_window: 7 }).data.gift_billboard.length).toBeGreaterThan(5);
    expect(ask("live_watch_billboard", { day_window: 30 }).data.watch_billboard).toHaveLength(20);
    expect(ask("live_fans_source", { day_window: 7 }).data.NewFansSource.some((item: Raw) => item.value > 0)).toBe(true);
  });

  it("粉丝画像每一维都有分布", () => {
    const data = ask("fans_summary");
    expect(fansDistribution(data.gender_distribution, "normalize", GENDER_NAMES).map((row) => row.name).sort()).toEqual(["女性", "男性"]);
    for (const [list, mode] of [[data.active_levels, "normalize"], [data.age_distribution, "age"], [data.device_brand_distribution, "normalize"], [data.city_distribution, "raw"], [data.fans_interest_distribution, "raw"]] as const) {
      const rows = fansDistribution(list, mode);
      expect(rows.length).toBeGreaterThan(2);
      for (const row of rows) expect(Number.isFinite(row.value) && row.value > 0).toBe(true);
    }
    expect(data.fans_portrait.like_item_keyword.length).toBeGreaterThan(3);
  });

  it("作品管理能翻完全部作品，状态和卡片指标都读得出来", () => {
    const all: Array<{ aweme: Raw; item: Raw }> = [];
    let cursor: string | number = 0;
    let total = 0;
    for (let page = 0; page < 20; page += 1) {
      const payload = ask("work_list", { status: 0, count: 40, max_cursor: cursor });
      total = payload.total;
      payload.aweme_list.forEach((aweme: Raw, index: number) => all.push({ aweme, item: payload.items[index] }));
      if (!payload.has_more) break;
      cursor = payload.max_cursor;
    }
    expect(all).toHaveLength(total);
    expect(new Set(all.map(({ aweme }) => aweme.aweme_id)).size).toBe(total);
    expect(new Set(all.map(({ aweme }) => workStatus(aweme).label))).toEqual(new Set(["审核中", "已发布", "", "不适宜公开"]));
    const visible = all.filter(({ aweme, item }) => !listMetricsHidden(aweme, item.metrics));
    expect(visible.length).toBeGreaterThan(total - 5);
    for (const { aweme, item } of visible) {
      for (const metric of listMetricSet({ ...aweme, metrics: item.metrics, type: item.type })) {
        shown(metric.kind === "rate" ? listRate(item.metrics[metric.key]) : listCount(item.metrics[metric.key]));
      }
    }
    expect(new Set(all.map(({ item }) => item.type))).toEqual(new Set([1, 2, 3, 4]));
    expect(ask("work_list", { status: 1, count: 12, max_cursor: 0 }).aweme_list.every((aweme: Raw) => workStatus(aweme).label !== "审核中")).toBe(true);
    expect(ask("work_list", { status: 2, count: 12, max_cursor: 0 }).aweme_list).toHaveLength(1);
    const sorted = ask("item_list", { user_id: "x", count: 12, order_by: 3, start_time: String(Date.now() - 90 * 86400000), end_time: String(Date.now()) });
    expect(sorted.items.length).toBe(12);
    expect(sorted.items[0].metrics.view_count).toBeGreaterThanOrEqual(sorted.items[11].metrics.view_count);
  });

  it("每种体裁的作品详情都能读出各个分析块", () => {
    const works: Raw[] = [];
    for (let cursor: string | number = 0, more = true; more;) {
      const payload = ask("work_list", { status: 1, count: 40, max_cursor: cursor });
      works.push(...payload.items.filter((item: Raw, index: number) => !payload.aweme_list[index].status.is_private));
      more = payload.has_more; cursor = payload.max_cursor;
    }
    const now = Date.now() / 1000;
    const recent = works.filter((item) => item.metrics.view_count > 300);
    const samples = [1, 2, 3, 4].map((type) => recent.find((item) => item.type === type)!);
    // 一条 30 天内的（新评论接口）、一条更早的（老评论接口）
    const fresh = recent.find((item) => item.type === 2 && ask("item_mget", { ids: item.id }).items[0].create_time > now - 20 * 86400)!;
    const stale = recent.find((item) => ask("item_mget", { ids: item.id }).items[0].create_time < now - 40 * 86400)!;
    for (const sample of [...samples, fresh, stale]) {
      const id = sample.id;
      const item = ask("item_mget", { ids: id, fields: "metrics" }).items[0];
      const type = contentType(item.type);
      expectFinite(item);
      for (const card of [...OVERVIEW_TRAFFIC[type], ...OVERVIEW_FANS, ...AUDIENCE_CARDS, ...ATTRACTION[type], ...ENGAGEMENT[type]]) shown(detailMetric(item.metrics[card.key], card.kind).text);
      for (const card of [...OVERVIEW_TRAFFIC[type], ...AUDIENCE_CARDS]) {
        for (const unit of [1, 2]) {
          const trend = ask("item_trend", { item_id: id, trend_type: card.counts[0]!, time_unit: unit, metrics_group: "0,1,3", metrics: card.key });
          expect(trend.trend_map[card.key]["0"].length, `${id} ${card.key}`).toBeGreaterThan(0);
          expectFinite(trend);
        }
      }
      const compare = ask("item_compare", { item_id: id, selected_metric_count: 2 });
      expect(compare.metrics.length).toBeGreaterThan(3);
      expect(playSources(ask("item_play_source", { item_id: id }).play_source).douyin.length).toBeGreaterThan(3);
      for (const analysis of type === "IMAGE_TEXT" ? [3, 9, 8] : [1, 7, 2]) {
        const trend = ask("item_realtime", { user_id: "", item_id: id, analysis_type: analysis }).analysis_trend;
        expect(trend.current_item.length).toBeGreaterThan(2);
        expect(trend.similar_author).toHaveLength(trend.current_item.length);
        expectFinite(trend);
      }
      const keywords = ask("item_search_keyword", { id });
      expect(keywords.show_from.length + keywords.inspire_search.length).toBeGreaterThan(0);
      const portrait = { ...ask("item_portrait", { item_id: id, user_id: "" }), ...ask("item_audience", { item_id: id, user_id: "" }) };
      expect(portrait.gender.ratio_list.length && portrait.active.length && portrait.audience_search_most_keywords.length).toBeTruthy();
      expect(ask("comment_hotwords", { item_id: id, mcn_type: 0 }).word_cloud_list.length).toBeGreaterThan(10);
      if (type === "MID_VIDEO") {
        expect(ask("item_progress", { item_id: id }).jump_forward.length).toBeGreaterThan(5);
        expect(ask("item_chapter", { user_id: "", item_id: id }).chapter_info.ChapterDetails.length).toBeGreaterThanOrEqual(3);
      }
      if (type !== "IMAGE_TEXT") expect(ask("item_bullet", { item_id: id }).current_item.length).toBeGreaterThan(2);
    }
    // 评论：新接口翻页 + 楼中楼；老接口要 item_summarize 先给 sec_item_id
    const first = ask("comment_list", { aweme_id: fresh.id, cursor: "0", count: 10, keyword: "", sort_options: 0, comment_select_options: "0" });
    const comments = first.comments.map(normalizeComment);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.every((comment: Raw) => comment.name && comment.text && comment.createTime > 0)).toBe(true);
    const withReplies = first.comments.find((comment: Raw) => comment.reply_comment_total > 0);
    if (withReplies) expect(ask("comment_replies", { item_id: fresh.id, comment_id: withReplies.cid, cursor: "0", count: 10 }).comments).toHaveLength(withReplies.reply_comment_total);
    const sec = ask("item_summarize", { item_id: stale.id }).item_list[0].sec_item_id;
    const old = ask("comment_list_old", { item_id: sec, cursor: 0, count: 10, sort: "HOT" }).comment_info_list.map(normalizeComment);
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((comment: Raw) => comment.name && comment.text)).toBe(true);
  });

  it("探索页的抖音热点两个榜各 30 条", async () => {
    const topics = parseHotTopics(ask("index_hot_topic"));
    expect(topics?.current).toHaveLength(30);
    expect(topics?.rocketing).toHaveLength(30);
    const loaded = await loadHotTopics(connection, undefined, read);
    expect(loaded.current[0]!.index).toBeGreaterThan(loaded.current[29]!.index);
  });

  it("主页上的达人详情按抖音号合成一位达人", async () => {
    const user = { id: "demo-user", handle: "demo_cook", name: "某位博主" };
    const result = await loadDaren(connection, user, undefined, read);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.detail.daily.days).toHaveLength(31);
    expect(result.works && result.videos && result.fans).toBeTruthy();
    expect(result.videos!.like_list.length).toBeGreaterThan(3);
  });
});
