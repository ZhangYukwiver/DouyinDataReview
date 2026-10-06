import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, CircleCheck, Search, ThumbsUp } from "lucide-react-native";
import {
  ACTIVE_NAMES, ATTRACTION, AUDIENCE_CARDS, clockText, COMMENT_CROWDS, COMMENT_SORTS, COMMENT_TYPES, commentSelectOptions, commentTime,
  contentType as toContentType, detailDuration, detailMetric, detailNumber, ENGAGEMENT, fullTime, GENDER_NAMES, normalizeComment,
  olderThanDays, OVERVIEW_FANS, OVERVIEW_TIPS, OVERVIEW_TRAFFIC, playSources, portraitPercent, shortCount,
  type ContentType, type CreatorComment, type DetailCard, type DetailKind,
} from "../../domain/creatorCenter";
import { readCreator, type CreatorQuery } from "../../services/creatorCenter";
import type { ExploreConnection } from "../../services/explorer";
import { Bars, BarList, chartPalette, Donut, LineChart } from "./CreatorCharts";
import { Empty, ErrorLine, kit, Loading, MetricTile, Panel, RankTable, Segmented, SmallButton, Tabs, useCreator, type Raw } from "./CreatorKit";
import { renderEmojiText } from "./emojiText";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Tab = "overview" | "traffic" | "audience" | "hotwords" | "comments";
const MGET_FIELDS = "metrics,review,play_info,dou_plus,integrated_incentive,incentive_life,content_analysis";
const pad = (value: number) => String(value).padStart(2, "0");
const pct = (value: number, digits: number) => `${Math.round(value * 100 * 10 ** digits) / 10 ** digits}%`;

/** 趋势图上的值：digit 2 去尾零；百分比加 %，时长写成 X秒（官方 ft）。 */
function chartValue(value: number, kind: DetailKind, digit = 2): string {
  if (kind === "time") return `${Math.round(value)}秒`;
  const { text, unit } = detailNumber(value, digit, true);
  return `${text}${unit}${kind === "percent" ? "%" : ""}`;
}

export function CreatorWorkDetail({ connection, itemId, followers, onBack }: { connection: ExploreConnection; itemId: string; followers: number; onBack: () => void }) {
  const base = useCreator(connection, [{ key: "item_mget", params: { ids: itemId, fields: MGET_FIELDS } }, { key: "item_compare", params: { item_id: itemId, selected_metric_count: 2 } }, { key: "author_upgrade" }]);
  const item: Raw | null = base.data?.[0]?.items?.[0] ?? null;
  const compare: Raw | null = base.data?.[1] ?? null;
  const showXg = Boolean(base.data?.[2]?.is_show_per_client_data);
  const createTime = Number(item?.create_time ?? 0);
  const old90 = item ? olderThanDays(createTime, 90) : false;
  const type = toContentType(item?.type);
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: Array<{ label: string; value: Tab }> = [
    { label: "总览", value: "overview" }, { label: "流量分析", value: "traffic" }, { label: "观众分析", value: "audience" },
    ...(old90 ? [] : [{ label: "评论热词", value: "hotwords" as Tab }]), { label: "评论管理", value: "comments" },
  ];
  const back = <Pressable accessibilityRole="button" onPress={onBack} style={kit.row}><ArrowLeft size={16} color={color.text} /><Text style={kit.subhead}>作品管理</Text></Pressable>;
  if (base.error) return <View style={{ gap: 14 }}>{back}<ErrorLine text={base.error} onRetry={base.reload} /></View>;
  if (base.loading) return <View style={{ gap: 14 }}>{back}<Loading label="正在读取作品数据…" /></View>;
  if (!item) return <View style={{ gap: 14 }}>{back}<Empty lines={Number(base.data?.[0]?.status_code) === 7 ? ["暂不允许查看他人作品数据"] : ["数据暂未产出", "作品发布后，将从次日起开始生产数据"]} /></View>;

  const metrics: Raw = item.metrics ?? {};
  const pictures = Number(item.picture_info?.count ?? 0);
  const review = Number(item.review?.status);
  const reviewText = review === 2 ? "作品状态正常" : review === 1 ? "审核状态：审核中" : review === 5 ? "审核结果：需优化" : review === 6 ? "审核结果：仅好友可见" : "";
  const ctx: DetailContext = { connection, itemId, item, metrics, type, old90, createTime, showXg, compare, followers, single: type === "LONG_ARTICLE" || (type === "IMAGE_TEXT" && pictures === 1) };
  return <View style={{ gap: 16 }}>
    {back}
    <View {...ws("e-box")} style={styles.head}>
      <View style={styles.headCover}>
        {item.cover?.url_list?.[0] ? <Image source={{ uri: item.cover.url_list[0] }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        {type !== "LONG_ARTICLE" ? <Text {...ws("cr-badge")} style={styles.badge}>{pictures ? `${pictures}张` : detailDuration(Number(item.video_info?.duration ?? 0))}</Text> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <Text style={[kit.body, { color: item.description ? color.text : color.textMuted }]}>{item.description || "无视频描述"}</Text>
        <Text style={kit.muted}>{createTime ? fullTime(createTime) : ""}</Text>
        {reviewText ? <View style={kit.row}>{review === 2 ? <CircleCheck size={13} color={color.green} /> : null}<Text style={kit.muted}>{reviewText}</Text></View> : null}
      </View>
    </View>
    <Tabs options={tabs} value={tab} onChange={setTab} />
    {tab === "overview" ? <Overview ctx={ctx} /> : tab === "traffic" ? <Traffic ctx={ctx} /> : tab === "audience" ? <Audience ctx={ctx} /> : tab === "hotwords" ? <Hotwords ctx={ctx} /> : <Comments ctx={ctx} />}
  </View>;
}

interface DetailContext {
  connection: ExploreConnection; itemId: string; item: Raw; metrics: Raw; type: ContentType; old90: boolean; createTime: number;
  showXg: boolean; compare: Raw | null; followers: number; single: boolean;
}

/** 卡片 + 选中卡的趋势（新增/累计、每小时/每天）。 */
function TrendGroup({ ctx, title, tip, cards, fansGroup = false }: { ctx: DetailContext; title: string; tip?: string[]; cards: DetailCard[]; fansGroup?: boolean }) {
  const [selected, setSelected] = useState(cards[0]!.key);
  const [choices, setChoices] = useState<Record<string, { count: 1 | 2; unit: 1 | 2 }>>({});
  const card = cards.find((entry) => entry.key === selected) ?? cards[0]!;
  const choice = choices[card.key] ?? { count: card.counts[0]!, unit: card.units[0]! };
  const groups = `0,1${ctx.showXg ? ",2" : ""},3`;
  const trend = useCreator(ctx.connection, [{ key: "item_trend", params: { item_id: ctx.itemId, trend_type: choice.count, time_unit: choice.unit, metrics_group: groups, metrics: card.key } }]);
  const map: Raw = trend.data?.[0]?.trend_map?.[card.key] ?? {};
  const full: Raw[] = map["0"] ?? [];
  const scale = card.kind === "percent" ? 100 : 1;
  const value = (list: Raw[] | undefined, index: number) => (list?.[index] ? Math.max(Number(list[index].value), 0) * scale : null);
  const label = (time: string) => {
    const [date = "", clock = ""] = time.split(" ");
    return choice.unit === 2 ? `${date.slice(5)} ${clock.slice(0, 5)}` : date.slice(5);
  };
  const set = (patch: Partial<{ count: 1 | 2; unit: 1 | 2 }>) => setChoices((current) => ({ ...current, [card.key]: { ...choice, ...patch } }));
  return <Panel title={title} tip={tip}>
    <View style={kit.grid}>{cards.map((entry) => {
      const shown = detailMetric(ctx.metrics[entry.key], entry.kind, fansGroup);
      return <MetricTile key={entry.key} label={entry.label} value={shown.text} unit={shown.unit} selected={entry.key === card.key} onPress={() => setSelected(entry.key)} />;
    })}</View>
    <View style={kit.between}>
      <Text style={kit.subhead}>{title === "观众数据" ? `${card.label}趋势` : card.label}</Text>
      <View style={kit.row}>
        {card.counts.length ? <Segmented small options={card.counts.map((count) => ({ label: count === 1 ? "新增" : "累计", value: count }))} value={choice.count} onChange={(count) => set({ count })} /> : null}
        <Segmented small options={card.units.map((unit) => ({ label: unit === 2 ? "每小时" : "每天", value: unit }))} value={choice.unit} onChange={(unit) => set({ unit })} />
      </View>
    </View>
    {choice.unit === 2 && olderThanDays(ctx.createTime, 14) ? <Text style={kit.muted}>作品发布14天后“每小时”数据不再更新</Text> : null}
    {trend.error ? <Empty small text="数据获取失败，请稍后重试" /> : trend.loading ? <Loading /> : !full.length ? <Empty small /> : <LineChart
      height={200} labels={full.map((point) => label(String(point.date_time)))} series={[{ label: card.label, values: full.map((_, index) => value(full, index)) }]}
      format={(v) => chartValue(v, card.kind)} axisFormat={(v) => chartValue(v, card.kind, v > 0 && v < 1 ? 2 : 1)}
      details={(index) => {
        const lines: string[] = [];
        const yumme = value(map["3"], index);
        const douyin = !ctx.showXg && card.kind === "count" ? (value(full, index) ?? 0) - (yumme ?? 0) : value(map["1"], index);
        if (douyin !== null && (map["1"]?.length || map["3"]?.length)) lines.push(`抖音 ${chartValue(douyin, card.kind, 1)}`);
        if (ctx.showXg && value(map["2"], index) !== null) lines.push(`西瓜 ${chartValue(value(map["2"], index)!, card.kind, 1)}`);
        if (yumme !== null) lines.push(`抖音精选 ${chartValue(yumme, card.kind, 1)}`);
        return lines;
      }} />}
  </Panel>;
}

/** 超过 90 天的作品只有静态卡片。 */
function StaticCards({ ctx, title, cards, note }: { ctx: DetailContext; title: string; cards: Array<{ label: string; key: string; kind: DetailKind }>; note: string }) {
  return <Panel title={title} subtitle={note}>
    <View style={kit.grid}>{cards.map((card) => { const shown = detailMetric(ctx.metrics[card.key], card.kind); return <MetricTile key={card.key} label={card.label} value={shown.text} unit={shown.unit} />; })}</View>
  </Panel>;
}

function oldNote(ctx: DetailContext, prefix: string): string {
  if (ctx.createTime * 1000 < new Date(2024, 7, 13).getTime()) return "作品发布时间过久，以下数据暂无记录";
  const date = new Date((ctx.createTime + 90 * 86400) * 1000);
  return `${prefix}更新至${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
}

function Overview({ ctx }: { ctx: DetailContext }) {
  if (ctx.old90) {
    const traffic = OVERVIEW_TRAFFIC[ctx.type].map(({ label, key, kind }) => ({ label, key, kind }));
    return <View style={{ gap: 16 }}>
      <StaticCards ctx={ctx} title="流量" cards={traffic} note={oldNote(ctx, "以下数据")} />
      <StaticCards ctx={ctx} title="粉丝" cards={[{ label: "吸粉量", key: "subscribe_count", kind: "count" }, { label: "脱粉量", key: "unsubscribe_count", kind: "count" }, { label: "粉丝播放占比", key: "fan_view_proportion", kind: "percent" }]} note={oldNote(ctx, "以下数据")} />
    </View>;
  }
  return <View style={kit.columns}>
    <View style={[kit.column, { flex: 2 }]}>
      <TrendGroup ctx={ctx} title="流量" tip={OVERVIEW_TIPS[ctx.type]} cards={OVERVIEW_TRAFFIC[ctx.type]} />
      <TrendGroup ctx={ctx} title="粉丝" cards={OVERVIEW_FANS} fansGroup />
    </View>
    <Diagnosis ctx={ctx} />
  </View>;
}

const LOWER_IS_BETTER = new Set(["dislike_count", "dislike_rate", "bounce_rate_2s"]);
function compareRatio(ratio: number): string {
  const { text } = detailNumber(ratio * 100, 2, true);
  return `${ratio >= 0 ? "+" : ""}${text}%`;
}

/** 作品诊断（和自己往期作品比）；精选内容另有一块。条件不满足时不显示。 */
function Diagnosis({ ctx }: { ctx: DetailContext }) {
  const compare = ctx.compare ?? {};
  const changeType = compare.view_count_metric?.change_type;
  const selected: string[] = Array.isArray(compare.selected_metrics) ? compare.selected_metrics : [];
  const quality = Number(ctx.item.content_analysis?.quality) === 2;
  const showCompare = selected.length > 0 && (changeType === 0 || changeType === 1);
  if (!showCompare && !quality) return null;
  const metrics: Raw[] = Array.isArray(compare.metrics) ? compare.metrics : [];
  const picked = selected.map((key) => metrics.find((metric) => metric.name === key)).filter(Boolean) as Raw[];
  const names = picked.map((metric) => metric.name_desc).join("和");
  const ratio = Math.abs(Number(compare.view_count_metric?.change_ratio ?? 0) * 100);
  const ratioText = `${detailNumber(ratio, 2, true).text}%`;
  const video: Raw = ctx.item.content_analysis?.video_content_info ?? {};
  return <View style={[kit.column, { flex: 1 }]}>
    <Panel title="作品诊断">
      {quality ? <View style={{ gap: 8 }}>
        <Text style={kit.subhead}>已被标记为抖音精选内容{Number(video.subsidy_income) > 0 ? "，获得额外激励" : ""}</Text>
        <View style={kit.grid}><MetricTile label="流量扶持" value={String(video.subsidy_vv ?? "-")} /><MetricTile label="现金激励（元）" value={String(video.subsidy_income ?? "-")} /></View>
      </View> : null}
      {showCompare ? <View style={{ gap: 10 }}>
        <Text style={kit.subhead}>{changeType === 0 ? "流量上涨较多" : "流量下降较多"}</Text>
        <View style={kit.grid}>{picked.map((metric) => {
          const kind: DetailKind = Number(metric.metric_type) === 0 ? "percent" : Number(metric.metric_type) === 2 ? "time" : "count";
          const shown = detailMetric(metric.self_value, kind);
          return <MetricTile key={metric.name} label={metric.name_desc} value={shown.text} unit={shown.unit} note={`比往期${compareRatio(Number(metric.change_ratio) || 0)}`} />;
        })}</View>
        <Text style={kit.body}>{changeType === 0
          ? `播放量较往期上涨${ratioText}， 对比往期有所提升，您的表现非常出色，其中${names}数据表现很棒。`
          : `播放量较往期下降${ratioText} ， 这次也许是运气差了点，下次投稿可以试着${picked.map((metric) => `${LOWER_IS_BETTER.has(metric.name) ? "降低" : "提升"}${metric.name_desc}`).join("、")}。`}</Text>
      </View> : null}
    </Panel>
  </View>;
}

/** 内容吸引力 / 观众参与度的卡：不能点，可能带「比往期」。 */
function CompareCards({ ctx, cards }: { ctx: DetailContext; cards: Array<{ label: string; key: string; kind: DetailKind }> }) {
  const compare = ctx.compare ?? {};
  const changeType = compare.view_count_metric?.change_type;
  const showNote = !ctx.item.review?.details && [0, 1, 2].includes(changeType);
  const selected: string[] = Array.isArray(compare.selected_metrics) ? compare.selected_metrics : [];
  return <View style={kit.grid}>{cards.map((card) => {
    const shown = detailMetric(ctx.metrics[card.key], card.kind);
    const ratio = Number((compare.metrics as Raw[] | undefined)?.find((metric) => metric.name === card.key)?.change_ratio ?? 0);
    const tone = selected.includes(card.key) ? (changeType === 0 ? "up" : changeType === 1 ? "down" : null) : null;
    return <MetricTile key={card.key} label={card.label} value={shown.text} unit={shown.unit} note={showNote ? (ratio ? `比往期${compareRatio(ratio)}` : "比往期--") : null} noteTone={tone} />;
  })}</View>;
}

function Traffic({ ctx }: { ctx: DetailContext }) {
  if (ctx.old90) return <View style={{ gap: 16 }}>
    <StaticCards ctx={ctx} title="内容吸引力" cards={ATTRACTION[ctx.type]} note={oldNote(ctx, "以下数据")} />
    <StaticCards ctx={ctx} title="观众参与度" cards={ENGAGEMENT[ctx.type]} note={oldNote(ctx, ctx.type === "IMAGE_TEXT" ? "下载量、不感兴趣率" : ctx.type === "LONG_ARTICLE" ? "不感兴趣率" : "弹幕量、不感兴趣率")} />
  </View>;
  const tips: Record<ContentType, string[]> = {
    SHORT_VIDEO: [OVERVIEW_TIPS.SHORT_VIDEO[2]!, "平均播放占比：视频被播放的平均时长/视频总时长，越高说明作品被播放时长越长", OVERVIEW_TIPS.SHORT_VIDEO[3]!, OVERVIEW_TIPS.SHORT_VIDEO[4]!],
    MID_VIDEO: ["封面点击率：统计周期内作品封面的点击量/作品封面的曝光量，反映作品封面质量", OVERVIEW_TIPS.SHORT_VIDEO[2]!, "平均播放占比：视频被播放的平均时长/视频总时长，越高说明作品被播放时长越长", OVERVIEW_TIPS.SHORT_VIDEO[3]!, OVERVIEW_TIPS.SHORT_VIDEO[4]!],
    IMAGE_TEXT: ["封面点击率：统计周期内作品封面的点击量/作品封面的曝光量，反映作品封面质量", "文案展开率：图文详情页被展开的次数/作品播放量，越高说明文案被展开越多", "评论进入率：用户点击评论区的次数/作品播放量，越高说明评论区被查看越多", "文案完读率：完成阅读图文详情页的次数/阅读图文详情页总次数，越高说明文案被读完次数越多", "划走率：视频播放不足2s划走的人次/总播放量，包含本人观看，越高说明2秒内划走的用户越多"],
    LONG_ARTICLE: ["封面点击率：统计周期内作品封面的点击量/作品封面的曝光量，反映作品封面质量", "评论进入率：用户点击评论区的次数/作品播放量，越高说明评论区被查看越多", "划走率：视频播放不足2s划走的人次/总播放量，包含本人观看，越高说明2秒内划走的用户越多"],
  };
  return <View style={kit.columns}>
    <View style={kit.column}>
      <Panel title="内容吸引力" tip={tips[ctx.type]}>
        <CompareCards ctx={ctx} cards={ATTRACTION[ctx.type]} />
        {ctx.single ? null : <ViewTrend ctx={ctx} />}
        {ctx.single ? null : <Chapters ctx={ctx} />}
      </Panel>
      <Panel title="观众参与度" tip="弹幕量：视频互动弹幕量，数据每天12点更新">
        <CompareCards ctx={ctx} cards={ENGAGEMENT[ctx.type]} />
        {ctx.single ? null : <InteractionTrend ctx={ctx} />}
      </Panel>
    </View>
    <View style={kit.column}>
      <PlaySource ctx={ctx} />
      <Keywords ctx={ctx} />
    </View>
  </View>;
}

function analysisSeries(payload: Raw | null) {
  const current: Raw[] = payload?.analysis_trend?.current_item ?? [];
  const similar: Raw[] = payload?.analysis_trend?.similar_author ?? [];
  return { current, similar, empty: !current.length || !similar.length };
}

/** 留存 / 跳出 / 点赞分析的两条线图（当前作品 + 同类作品虚线）。 */
function AnalysisChart({ payload, isPic, labels: [mine, other], bucketed = false, height = 210 }: { payload: Raw | null; isPic: boolean; labels: [string, string]; bucketed?: boolean; height?: number }) {
  const { current, similar } = analysisSeries(payload);
  const keys = current.map((point) => String(point.key));
  const ranged = bucketed && keys[1] !== "00:02";
  const titles = keys.map((key, index) => isPic ? `第${key}张` : ranged ? `${index === 0 ? "00:00" : keys[index - 1]}-${key}` : key);
  const valleys = Object.values(payload?.valley_list ?? {}).flat().filter(Boolean).sort((a: any, b: any) => Number(a.start) - Number(b.start)) as Raw[];
  return <View style={{ gap: 8 }}>
    <View style={kit.row}><View style={[styles.dot, { backgroundColor: chartPalette[0] }]} /><Text style={kit.muted}>当前作品</Text><View style={[styles.dot, { backgroundColor: color.textMuted }]} /><Text style={kit.muted}>同类作品</Text></View>
    <LineChart height={height} labels={isPic ? keys.map((key) => `${key}`) : keys} titles={titles} fixedMax={1}
      series={[{ label: mine, values: current.map((point) => Number(point.value)) }, { label: other, values: keys.map((key) => { const hit = similar.find((point) => String(point.key) === key); return hit ? Number(hit.value) : null; }), color: color.textMuted, dashed: true }]}
      format={(value) => pct(value, 2)} axisFormat={(value) => pct(value, 1)} />
    {valleys.length ? <View style={{ gap: 4 }}>{valleys.map((valley, index) => <Text key={index} style={kit.muted}>
      <Text style={{ color: color.danger }}>低谷{index + 1}</Text>  {clockText(Number(valley.start))}–{clockText(Number(valley.end))}：当前位置离开观众较多，可以尝试优化作品节奏提升内容吸引力
    </Text>)}</View> : null}
  </View>;
}

function ViewTrend({ ctx }: { ctx: DetailContext }) {
  const isPic = ctx.type === "IMAGE_TEXT";
  const options = [...(ctx.type === "MID_VIDEO" ? [{ label: "进度分析", value: "progress" as const }] : []), { label: "留存分析", value: "retention" as const }, { label: "跳出分析", value: "bounce" as const }];
  const [mode, setMode] = useState(options[0]!.value);
  const views = Number(ctx.metrics.view_count);
  const query: CreatorQuery[] | null = mode === "progress"
    ? (views < 100 ? null : [{ key: "item_progress", params: { item_id: ctx.itemId } }])
    : [{ key: "item_realtime", params: { user_id: "", item_id: ctx.itemId, analysis_type: mode === "retention" ? (isPic ? 3 : 1) : (isPic ? 9 : 7) } }];
  const data = useCreator(ctx.connection, query);
  const payload = data.data?.[0] ?? null;
  let body: React.ReactNode;
  if (mode === "progress") {
    const forward: Raw[] = payload?.jump_forward ?? [];
    const backward: Raw[] = payload?.jump_backward ?? [];
    body = views < 100 ? <Empty small text="视频播放量小于100，暂不支持分析" /> : data.error ? <Empty small text="网络错误，请稍后重试" /> : data.loading ? <Loading />
      : !forward.length || !backward.length ? <Empty small text="视频无进度条拖动行为，暂不支持分析" />
        : <LineChart height={210} labels={forward.map((point) => clockText(Number(point.key)))} format={(value) => pct(value, 2)} axisFormat={(value) => pct(value, 0)}
          series={[{ label: "跳过率", values: forward.map((point) => Number(point.value)), color: color.cyan }, { label: "回看率", values: forward.map((point) => { const hit = backward.find((entry) => String(entry.key) === String(point.key)); return hit ? Number(hit.value) : null; }) }]} />;
  } else if (data.error) body = <Empty small text="网络错误，请稍后再试" />;
  else if (data.loading) body = <Loading />;
  else if (mode === "retention" && views < 200) body = <Empty small text="播放量超过200后，展示数据" />;
  else if (analysisSeries(payload).empty) body = <Empty small text="计算中，数据稍后更新" />;
  else body = <AnalysisChart payload={payload} isPic={isPic} labels={mode === "retention" ? ["留存", "同类"] : ["跳出率", "同类"]} bucketed={mode === "bounce"} />;
  return <View style={{ gap: 10 }}>
    <View style={kit.between}><Text style={kit.subhead}>观看趋势</Text><Segmented small options={options} value={mode} onChange={setMode} /></View>
    {body}
  </View>;
}

function Chapters({ ctx }: { ctx: DetailContext }) {
  const data = useCreator(ctx.connection, [{ key: "item_chapter", params: { user_id: "", item_id: ctx.itemId } }]);
  const payload = data.data?.[0];
  const details: Raw[] = payload?.chapter_info?.ChapterDetails ?? [];
  const top: Raw[] = payload?.chapter_top_data ?? [];
  if (details.length < 3 || !top.length) return null;
  const rows = [...top].sort((a, b) => Number(b.click_rate) - Number(a.click_rate));
  return <View style={{ gap: 8 }}>
    <Text style={kit.subhead}>章节点击率</Text>
    {rows.map((row, index) => <View key={index} style={kit.between}>
      <Text style={kit.body}>{index + 1}  {clockText(Number(row.chapter_detail?.Timestamp ?? 0) / 1000)}  {row.chapter_detail?.Desc}</Text>
      <Text style={kit.strong}>{(Number(row.click_rate) * 100).toFixed(1)}%</Text>
    </View>)}
  </View>;
}

function InteractionTrend({ ctx }: { ctx: DetailContext }) {
  const video = ctx.type === "SHORT_VIDEO" || ctx.type === "MID_VIDEO";
  const isPic = ctx.type === "IMAGE_TEXT";
  const [mode, setMode] = useState<"bullet" | "like">(video ? "bullet" : "like");
  const data = useCreator(ctx.connection, mode === "bullet" ? [{ key: "item_bullet", params: { item_id: ctx.itemId } }] : [{ key: "item_realtime", params: { user_id: "", item_id: ctx.itemId, analysis_type: isPic ? 8 : 2 } }]);
  const payload = data.data?.[0] ?? null;
  let body: React.ReactNode;
  if (mode === "bullet") {
    const current: Raw[] = payload?.current_item ?? [];
    const similar: Raw[] = payload?.similar_author ?? [];
    body = data.error ? <Empty small text="网络错误，请稍后重试" /> : data.loading ? <Loading /> : !current.length || !similar.length ? <Empty small text="视频未收到弹幕，暂无分析" />
      : <LineChart height={200} labels={current.map((point) => clockText(Number(point.key)))} format={(value) => detailNumber(value, 1, true).text}
        series={[{ label: "当前作品", values: current.map((point) => Number(point.value)) }, { label: "同类作品", values: current.map((point) => { const hit = similar.find((entry) => String(entry.key) === String(point.key)); return hit ? Number(hit.value) : null; }), color: color.textMuted, dashed: true }]} />;
  } else {
    body = data.error ? <Empty small text="网络错误，请稍后再试" /> : data.loading ? <Loading /> : analysisSeries(payload).empty ? <Empty small text="计算中，数据稍后更新" />
      : <AnalysisChart payload={payload} isPic={isPic} labels={["观众点赞", "同类"]} bucketed />;
  }
  return <View style={{ gap: 10 }}>
    <View style={kit.between}><Text style={kit.subhead}>{mode === "bullet" ? "弹幕分析" : "点赞分析"}</Text>
      {video ? <Segmented small options={[{ label: "弹幕", value: "bullet" as const }, { label: "点赞", value: "like" as const }]} value={mode} onChange={setMode} /> : null}</View>
    {body}
  </View>;
}

function PlaySource({ ctx }: { ctx: DetailContext }) {
  const data = useCreator(ctx.connection, [{ key: "item_play_source", params: { item_id: ctx.itemId } }]);
  const [expanded, setExpanded] = useState(false);
  const sources = playSources(data.data?.[0]?.play_source);
  const table = (title: string, rows: ReturnType<typeof playSources>["douyin"]) => <BarList nameHeader={title} valueHeader="来源占比" compareHeader="对比7日"
    rows={(expanded ? rows : rows.slice(0, 5)).map((row) => ({ label: row.name, ratio: row.percent, value: `${row.percent}%`, compare: `${row.diff > 0 ? "+" : ""}${row.diff}%`, compareSign: row.diff }))} />;
  const dou = Number(ctx.item.dou_plus?.view_count ?? 0);
  const life = Number(ctx.item.incentive_life?.incentive_play_count ?? 0);
  const boost = (ctx.item.integrated_incentive?.incentive_sum_list as Raw[] | undefined)?.find((entry) => entry.type === "vv_boost");
  const views = Number(ctx.metrics.view_count) || 0;
  const showBoost = Boolean(views && boost && Number(boost.total) + dou + life < views);
  const plays = (value: number) => { const { text, unit } = detailNumber(value, 1, true); return `${text}${unit}次播放`; };
  return <Panel title="流量来源" tip="流量来源统计了作品从不同途径播放的占比。若暂时没有看到某个渠道，说明对应渠道暂时没有播放，作品刚发布推荐页流量占比可能偏低，请等待系统推流">
    {data.error ? <Empty small text="网络错误，请稍后再试" /> : data.loading ? <Loading /> : !sources.douyin.length ? <Empty small /> : <View style={{ gap: 14 }}>
      {table("抖音 App", sources.douyin)}
      {sources.other.length ? table("其他 App", sources.other) : null}
      {sources.douyin.length > 5 || sources.other.length > 5 ? <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)}><Text style={kit.muted}>{expanded ? "收起" : "展开更多"}</Text></Pressable> : null}
    </View>}
    {dou > 0 || life > 0 || showBoost ? <View style={{ gap: 6 }}>
      <Text style={kit.subhead}>额外流量</Text>
      {dou > 0 ? <View style={kit.between}><Text style={kit.body}>DOU+投放</Text><Text style={kit.strong}>{plays(dou)}</Text></View> : null}
      {life > 0 ? <View style={kit.between}><Text style={kit.body}>生活服务流量奖励</Text><Text style={kit.strong}>{plays(life)}</Text></View> : null}
      {showBoost ? <View style={kit.between}><Text style={kit.body}>平台扶持流量</Text><Text style={kit.strong}>{plays(Number(boost!.total))}</Text></View> : null}
    </View> : null}
  </Panel>;
}

function Keywords({ ctx }: { ctx: DetailContext }) {
  const data = useCreator(ctx.connection, [{ key: "item_search_keyword", params: { id: ctx.itemId } }]);
  const payload = data.data?.[0];
  const top = (list: unknown) => (Array.isArray(list) ? [...list] : []).sort((a: Raw, b: Raw) => Number(b.percent) - Number(a.percent)).slice(0, 6) as Raw[];
  const showFrom = top(payload?.show_from);
  const inspire = top(payload?.inspire_search);
  const list = (title: string, rows: Raw[]) => <View style={{ gap: 6 }}>
    <Text style={kit.subhead}>{title}</Text>
    {rows.length ? rows.map((row, index) => <View key={`${row.keyword}${index}`} style={kit.between}><Text style={kit.body}>{index + 1}  {row.keyword}</Text><Text style={kit.muted}>{Number(row.percent) ? `${Math.round(Number(row.percent) * 1000) / 10}%` : "0%"}</Text></View>) : <Text style={kit.muted}>暂无数据</Text>}
  </View>;
  return <Panel title="搜索关键词" tip={["数据统计周期：", "1.作品发布至今的累积数据", "2.数据次日更新"]}>
    {data.error ? <Empty small text="网络错误，请稍后再试" /> : data.loading ? <Loading /> : !showFrom.length && !inspire.length ? <Empty small />
      : <View style={{ gap: 14 }}>{list("用户通过这些词看到作品", showFrom)}<View style={styles.divider} />{list("用户看完作品后常搜的词", inspire)}</View>}
  </Panel>;
}

function Audience({ ctx }: { ctx: DetailContext }) {
  if (ctx.old90) return <StaticCards ctx={ctx} title="观众数据" cards={AUDIENCE_CARDS} note={ctx.createTime * 1000 < new Date(2024, 7, 13).getTime() ? "作品发布时间过久，以下数据暂无记录" : `以下数据更新至${(() => { const d = new Date((ctx.createTime + 90 * 86400) * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })()}`} />;
  return <View style={{ gap: 16 }}>
    <TrendGroup ctx={ctx} title="观众数据" cards={AUDIENCE_CARDS} />
    <Portrait ctx={ctx} />
  </View>;
}

function Portrait({ ctx }: { ctx: DetailContext }) {
  const data = useCreator(ctx.connection, [{ key: "item_portrait", params: { item_id: ctx.itemId, user_id: "" } }, { key: "item_audience", params: { item_id: ctx.itemId, user_id: "" } }]);
  if (data.loading) return <Loading />;
  const ok = (payload: Raw | null) => (payload && Number(payload.status_code ?? 0) === 0 ? payload : {});
  const merged: Raw = data.error ? {} : { ...ok(data.data?.[0] ?? null), ...ok(data.data?.[1] ?? null) };
  if (!merged.gender && !merged.active && !merged.audience_search_most_keywords) {
    const today = new Date(ctx.createTime * 1000).toDateString() === new Date().toDateString();
    return <Panel><Empty lines={today ? ["今天发布的作品，将从次日提供数据"] : ["数据暂未产出", "正在加工中，请稍等"]} /></Panel>;
  }
  const ratios = (list: unknown) => (Array.isArray(list) ? list : []) as Raw[];
  const gender = ratios(merged.gender?.ratio_list).sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 7);
  const age = ratios(merged.age?.ratio_list).sort((a, b) => parseInt(a.key, 10) - parseInt(b.key, 10));
  const province = ratios(merged.province?.ratio_list);
  const provinceTotal = province.reduce((sum, row) => sum + Number(row.value || 0), 0);
  const interest = ratios(merged.audience_preference?.total_data?.ratio_data).sort((a, b) => Number(b.value) - Number(a.value));
  const keywords = ratios(merged.audience_search_most_keywords);
  const active = ratios(merged.active).slice(0, 7);
  const half = (title: string, body: React.ReactNode) => <Panel title={title} style={styles.half}>{body}</Panel>;
  return <View style={styles.portrait}>
    {half("性别分布", gender.length ? <Donut slices={gender.map((row) => ({ label: GENDER_NAMES[row.key] ?? row.key, value: Number(row.value) }))} /> : <Empty small />)}
    {half("年龄分布", age.length ? <Bars items={age.map((row) => ({ label: String(row.key), value: Number(row.value) }))} /> : <Empty small />)}
    <Panel title="地域分布" style={styles.full}>{province.length ? <RankTable headers={["地区", "占比"]} maxHeight={320}
      rows={[...province].sort((a, b) => Number(b.value) - Number(a.value)).map((row) => [String(row.key), portraitPercent(provinceTotal ? Number(row.value) / provinceTotal : 0)])} /> : <Empty small />}</Panel>
    {half("受众兴趣分布", !ctx.followers || !interest.length ? <Empty small /> : <RankTable headers={["兴趣", "占比"]} rows={interest.map((row) => [String(row.key), portraitPercent(Number(row.value))])} />)}
    {half("受众关注热词", data.error ? <Empty small text="暂无热词分析数据" /> : ctx.followers < 1000 ? <Empty small text="粉丝量未达到1000，暂无热词分析" /> : !keywords.length ? <Empty small text="作品观众数据不足暂无热词分析" />
      : <RankTable headers={["兴趣", "热度"]} rows={keywords.map((row) => [String(row.keywords), shortCount(row.query_cnt_7d)])} />)}
    {half("活跃分布", active.length ? <Donut slices={active.map((row) => ({ label: ACTIVE_NAMES[String(row.key)] ?? String(row.key), value: Number(row.value) }))} /> : <Empty small />)}
  </View>;
}

function Hotwords({ ctx }: { ctx: DetailContext }) {
  const data = useCreator(ctx.connection, [{ key: "comment_hotwords", params: { item_id: ctx.itemId, mcn_type: 0 } }]);
  const list: Raw[] = Array.isArray(data.data?.[0]?.word_cloud_list) ? data.data![0]!.word_cloud_list : [];
  if (data.loading) return <Loading />;
  if (!list.length) return <Panel><Empty /></Panel>;
  const cut = list.length > 14 ? Math.ceil(list.length / 2) : 14;
  const table = (rows: Raw[]) => <View style={{ flex: 1, minWidth: 260 }}><RankTable headers={["排名", "热词"]} rows={rows.map((row) => [String(row.rank ?? ""), String(row.word ?? "")])} /></View>;
  return <Panel title="评论热词"><View style={kit.columns}>{table(list.slice(0, cut))}{list.length > cut ? table(list.slice(cut)) : null}</View></Panel>;
}

function Comments({ ctx }: { ctx: DetailContext }) {
  const fresh = Date.now() <= ctx.createTime * 1000 + 30 * 86400000;
  const [type, setType] = useState("0");
  const [crowd, setCrowd] = useState("0");
  const [sort, setSort] = useState("TIME");
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [list, setList] = useState<CreatorComment[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [secId, setSecId] = useState<string | null>(fresh ? ctx.itemId : null);
  const [replyState, setReplyState] = useState<Record<string, { cursor: number; more: boolean; loading: boolean; open: boolean }>>({});
  const run = useRef(0);

  useEffect(() => {
    if (fresh) return;
    // 超过 30 天的作品走老评论接口，要先拿 sec_item_id（拿不到就用原 id）
    void readCreator(ctx.connection, [{ key: "item_summarize", params: { item_id: ctx.itemId } }]).then(([payload]) => setSecId(String(payload?.item_list?.[0]?.sec_item_id ?? ctx.itemId)), () => setSecId(ctx.itemId));
  }, []);

  async function load(reset: boolean) {
    if (!secId) return;
    const current = reset ? ++run.current : run.current;
    setLoading(true);
    const from = reset ? 0 : cursor;
    try {
      const sortOption = COMMENT_SORTS.find((item) => item.value === sort)!;
      const [payload] = await readCreator(ctx.connection, [fresh
        ? { key: "comment_list", params: { aweme_id: ctx.itemId, cursor: String(from), count: 10, keyword, sort_options: sortOption.option, comment_select_options: commentSelectOptions(type, crowd) } }
        : { key: "comment_list_old", params: { item_id: secId, cursor: from, count: 10, sort } }]);
      if (current !== run.current) return;
      const raw: Raw[] = (fresh ? payload?.comments : payload?.comment_info_list) ?? [];
      const next = raw.map(normalizeComment);
      setList((existing) => (reset ? next : existing.concat(next)));
      setCursor(Number(payload?.cursor) || from + 10);
      setHasMore(Boolean(payload?.has_more));
    } catch {
      if (current === run.current) setHasMore(false);
    } finally {
      if (current === run.current) setLoading(false);
    }
  }
  useEffect(() => { setReplyState({}); void load(true); }, [secId, type, crowd, sort, keyword]);

  async function loadReplies(comment: CreatorComment) {
    const state = replyState[comment.id] ?? { cursor: 0, more: true, loading: false, open: true };
    setReplyState((current) => ({ ...current, [comment.id]: { ...state, loading: true, open: true } }));
    try {
      const [payload] = await readCreator(ctx.connection, [fresh
        ? { key: "comment_replies", params: { item_id: ctx.itemId, comment_id: comment.id, cursor: String(state.cursor), count: 10 } }
        : { key: "comment_replies_old", params: { comment_id: comment.id, cursor: state.cursor, count: 10 } }]);
      const raw: Raw[] = (fresh ? payload?.comments : payload?.comment_info_list) ?? [];
      const replies = raw.map(normalizeComment);
      setList((current) => current.map((entry) => entry.id === comment.id ? { ...entry, replies: [...entry.replies, ...replies.filter((reply) => !entry.replies.some((old) => old.id === reply.id))] } : entry));
      setReplyState((current) => ({ ...current, [comment.id]: { cursor: Number(payload?.cursor) || state.cursor + 10, more: Boolean(payload?.has_more), loading: false, open: true } }));
    } catch {
      setReplyState((current) => ({ ...current, [comment.id]: { ...state, loading: false, more: false } }));
    }
  }

  const term = keyword.trim();
  const shown = term ? list.filter((comment) => `${comment.text}\n${comment.replies.map((reply) => reply.text).join("\n")}`.includes(term)) : list;
  const filtered = fresh && (term || type !== "0" || crowd !== "0" || sort !== "TIME");
  return <Panel>
    <View style={kit.row}>
      {fresh ? <Segmented small options={COMMENT_TYPES} value={type} onChange={setType} /> : null}
      {fresh ? <Segmented small options={COMMENT_CROWDS} value={crowd} onChange={setCrowd} /> : null}
      <Segmented small options={COMMENT_SORTS.map(({ label, value }) => ({ label, value }))} value={sort} onChange={setSort} />
      {fresh ? <View style={styles.search}><Search size={14} color={color.textMuted} /><TextInput accessibilityLabel="搜索评论关键词" value={draft} onChangeText={setDraft} onSubmitEditing={() => setKeyword(draft.trim())} onBlur={() => setKeyword(draft.trim())} placeholder="搜索评论关键词" placeholderTextColor={color.textMuted} style={styles.searchInput} /></View> : null}
    </View>
    <View style={{ gap: 2 }}>{shown.map((comment) => {
      const state = replyState[comment.id];
      const loaded = comment.replies.length;
      const remaining = Math.max(comment.replyCount - loaded, 0);
      const more = state ? state.more && (remaining > 0 || state.more) : remaining > 0;
      const open = state?.open ?? true;
      return <View key={comment.id} style={styles.comment}>
        <CommentBody comment={comment} />
        {open ? comment.replies.map((reply) => <View key={reply.id} style={styles.reply}><CommentBody comment={reply} /></View>) : null}
        {state?.loading ? <Loading /> : open && loaded && !more ? <Pressable accessibilityRole="button" onPress={() => setReplyState((current) => ({ ...current, [comment.id]: { ...(state ?? { cursor: 0, more: false, loading: false }), open: false } }))}><Text style={styles.link}>收起</Text></Pressable>
          : open && (more || remaining > 0) ? <Pressable accessibilityRole="button" onPress={() => void loadReplies(comment)}><Text style={styles.link}>查看{remaining || 10}条回复</Text></Pressable>
            : !open ? <Pressable accessibilityRole="button" onPress={() => setReplyState((current) => ({ ...current, [comment.id]: { ...state!, open: true } }))}><Text style={styles.link}>查看{comment.replyCount || loaded}条回复</Text></Pressable> : null}
      </View>;
    })}</View>
    {loading || !secId ? <Loading /> : shown.length ? (hasMore ? <View style={{ alignItems: "center" }}><SmallButton label="加载更多评论" onPress={() => void load(false)} /></View> : <Text style={[kit.muted, { textAlign: "center" }]}>没有更多评论</Text>)
      : filtered ? <Empty lines={["暂无符合条件的评论", "换个条件试试吧"]} />
        : <View style={{ alignItems: "center", gap: 8, paddingVertical: 30 }}><Text style={kit.muted}>暂无更多评论</Text><Pressable accessibilityRole="button" onPress={() => void load(true)}><Text style={styles.link}>点击刷新</Text></Pressable></View>}
  </Panel>;
}

function CommentBody({ comment }: { comment: CreatorComment }) {
  return <View style={styles.commentRow}>
    {comment.avatar ? <Image source={{ uri: comment.avatar }} style={styles.commentAvatar} /> : <View style={[styles.commentAvatar, { backgroundColor: color.surfaceMuted }]} />}
    <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
      <View style={kit.row}><Text style={styles.commentName}>{comment.name}</Text>{comment.isAuthor ? <Text {...ws("cr-note")} style={styles.author}>作者</Text> : null}</View>
      <Text style={kit.body}>{comment.folded ? "该评论被折叠" : <>{comment.replyTo ? `回复 ${comment.replyTo}：` : ""}{renderEmojiText(comment.text)}</>}</Text>
      {comment.images.length ? <View style={kit.row}>{comment.images.map((uri) => <Image key={uri} source={{ uri }} style={styles.commentImage} />)}</View> : null}
      <View style={kit.row}><Text style={kit.muted}>{comment.createTime ? commentTime(comment.createTime) : ""}</Text><ThumbsUp size={12} color={color.textMuted} /><Text style={kit.muted}>{comment.likes}</Text></View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", gap: 16, padding: 16, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  headCover: { width: 96, height: 128, borderRadius: 6, overflow: "hidden", backgroundColor: color.surfaceMuted },
  badge: { position: "absolute", right: 6, bottom: 6, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, fontFamily: font.body },
  dot: { width: 8, height: 8, borderRadius: 4 },
  divider: { height: 1, backgroundColor: color.borderSoft },
  portrait: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  half: { flexGrow: 1, flexBasis: 360 },
  full: { flexBasis: "100%" },
  search: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, minWidth: 180 },
  searchInput: { flex: 1, minHeight: 30, color: color.text, fontFamily: font.body, fontSize: 12 },
  comment: { gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  commentRow: { flexDirection: "row", gap: 10 },
  commentAvatar: { width: 32, height: 32, borderRadius: 16 },
  commentName: { color: color.text, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  author: { color: color.accent, fontFamily: font.body, fontSize: 10, paddingHorizontal: 5, borderRadius: 4, borderWidth: 1, borderColor: color.accent },
  commentImage: { width: 80, height: 80, borderRadius: 6, backgroundColor: color.surfaceMuted },
  reply: { marginLeft: 42 },
  link: { color: color.cyan, fontFamily: font.body, fontSize: 12, marginLeft: 42 },
});
