import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowUpRight, ChevronDown, ChevronUp, RefreshCw } from "lucide-react-native";
import type { ExploreConnection, ExploreUser } from "../../services/explorer";
import { LocalCollectorError } from "../../services/localCollector";
import { loadDaren, type DarenResult } from "../../services/douyinIndex";
import {
  DAREN_METRICS, DAREN_PERIODS, TOP_VIDEO_ORDERS, WORK_METRICS, darenPageUrl, formatChange, formatIndex, formatShare, shortDay,
  type DarenMetric, type DarenPeriod, type TopVideoOrder,
} from "../../domain/douyinIndex";
import { BarList, LineChart } from "./CreatorCharts";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Tab = "author" | "works" | "fans";
const TABS: Array<{ key: Tab; label: string }> = [{ key: "author", label: "作者分析" }, { key: "works", label: "作品分析" }, { key: "fans", label: "粉丝分析" }];
const WORK_SPANS = [{ key: "week", label: "近 7 天" }, { key: "month", label: "近 30 天" }] as const;
// 只显示我们自己写的中文提示；程序里的异常不把英文原文甩给用户
const messageOf = (error: unknown) => error instanceof LocalCollectorError && error.message ? error.message : "没读到达人详情，请稍后重试。";
const fullDay = (day: string) => `${day.slice(0, 4)}/${day.slice(4, 6)}/${day.slice(6, 8)}`;

function Choice<K extends string>({ options, value, onChange }: { options: ReadonlyArray<{ key: K; label: string }>; value: K; onChange: (key: K) => void }) {
  return <View style={styles.row}>{options.map((option) => <Pressable key={option.key} accessibilityRole="button" aria-pressed={value === option.key} onPress={() => onChange(option.key)} style={[styles.chip, value === option.key && styles.chipOn]}>
    <Text style={[styles.chipText, value === option.key && styles.chipTextOn]}>{option.label}</Text>
  </Pressable>)}</View>;
}

/** 主页上这个人在抖音指数里的「达人详情」：作者分析、作品分析、粉丝分析。读失败不影响下面的作品列表。 */
export function DarenCard({ connection, user, disabled = false, onOpenVideo, onOpenPage }: {
  connection: ExploreConnection; user: ExploreUser; disabled?: boolean;
  /** 点近 30 天的作品：在探索里打开它的详情 */ onOpenVideo: (id: string) => void;
  onOpenPage: (url: string) => void;
}) {
  const [result, setResult] = useState<DarenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>("author");
  const [period, setPeriod] = useState<DarenPeriod>("day");
  const [metric, setMetric] = useState<DarenMetric>("like");
  const [span, setSpan] = useState<"week" | "month">("week");
  const [order, setOrder] = useState<TopVideoOrder>("like_list");
  const [listWidth, setListWidth] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(null);
    void loadDaren(connection, user, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [connection.baseUrl, connection.token, user.id, attempt]);

  const ready = result?.state === "ok" ? result : null;
  const daren = ready?.detail;
  const metricLabel = DAREN_METRICS.find((item) => item.key === metric)!.label;
  const videos = ready?.videos?.[order] ?? [];
  // 按宽度定列数，最后一行不够也不拉伸
  const columns = listWidth >= 900 ? 3 : listWidth >= 560 ? 2 : 1;
  const videoWidth = listWidth ? Math.floor((listWidth - 10 * (columns - 1)) / columns) : "100%";
  const missing = ready ? [!ready.works && "篇均", !ready.videos && "近 30 天作品", !ready.fans && "粉丝画像"].filter(Boolean) : [];
  return <View {...ws("e-box")} style={styles.card} testID="daren-card">
    <View style={styles.head}>
      <View style={styles.headCopy}>
        <Text {...ws("e-section")} accessibilityRole="header" style={styles.title}>达人详情</Text>
        {daren ? <Text style={styles.muted}>来自抖音指数，数据更新到 {shortDay(ready!.latestDay)}{daren.tags.length ? `，内容类型是${daren.tags.join(" / ")}` : ""}</Text> : null}
      </View>
      {ready ? <Pressable accessibilityRole="button" accessibilityLabel={collapsed ? "展开达人详情" : "收起达人详情"} onPress={() => setCollapsed(!collapsed)} style={styles.iconButton}>
        {collapsed ? <ChevronDown size={16} color={color.textMuted} /> : <ChevronUp size={16} color={color.textMuted} />}
      </Pressable> : null}
    </View>

    {!result && !error ? <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" color={color.cyan} /><Text style={styles.muted}>正在从抖音指数读取达人详情…</Text></View> : null}
    {error ? <View accessibilityRole="alert" style={styles.row}>
      <Text style={[styles.muted, styles.grow]}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取达人详情" onPress={() => setAttempt(attempt + 1)} style={styles.chip}><RefreshCw size={12} color={color.textSecondary} /><Text style={styles.chipText}>重试</Text></Pressable>
    </View> : null}
    {result?.state === "none" ? <Text accessibilityLiveRegion="polite" style={styles.muted}>抖音指数的达人库里还没有这个账号，粉丝多一些以后才会收录。</Text> : null}

    {ready && daren && !collapsed ? <>
      {daren.milestones.length ? <Text style={styles.muted}>涨粉里程碑：{daren.milestones.map((item) => `${fullDay(item.day)} 到 ${item.label}`).join("，")}</Text> : null}
      <View accessibilityRole="tablist" style={styles.tabs}>{TABS.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: tab === item.key }} onPress={() => setTab(item.key)} style={[styles.tab, tab === item.key && styles.tabOn]}>
        <Text style={[styles.tabText, tab === item.key && styles.tabTextOn]}>{item.label}</Text>
      </Pressable>)}</View>

      {tab === "author" ? <>
        <Choice options={DAREN_PERIODS} value={period} onChange={setPeriod} />
        <View style={styles.metrics}>{DAREN_METRICS.map((item) => {
          const stat = daren.stats[period][item.key];
          const selected = metric === item.key;
          return <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${item.label} ${formatIndex(stat.value)}，环比 ${formatChange(stat.change)}，点一下看逐日趋势`} aria-pressed={selected} onPress={() => setMetric(item.key)} style={[styles.metric, selected && styles.metricOn]}>
            <Text style={styles.muted}>{item.label}</Text>
            <Text {...ws("d-num big")} style={styles.metricValue}>{formatIndex(stat.value)}</Text>
            <Text style={styles.muted}>{period === "day" ? "日环比" : "环比"} {formatChange(stat.change)}</Text>
          </Pressable>;
        })}</View>
        <Text style={styles.sub}>{metricLabel}，最近 {daren.daily.days.length} 天每天的数</Text>
        <LineChart labels={daren.daily.days.map(shortDay)} series={[{ label: metricLabel, values: daren.daily[metric] }]} height={170} format={formatIndex} />
      </> : null}

      {tab === "works" ? <>
        {ready.works ? <>
          <Choice options={WORK_SPANS} value={span} onChange={setSpan} />
          <View style={styles.metrics}>{WORK_METRICS.map((item) => {
            const stat = ready.works![span][item.key];
            return <View key={item.key} style={styles.metric}>
              <Text style={styles.muted}>{item.label}</Text>
              <Text {...ws("d-num big")} style={styles.metricValue}>{formatIndex(stat.value)}</Text>
              <Text style={styles.muted}>环比 {formatChange(stat.change)}</Text>
            </View>;
          })}</View>
        </> : null}
        {ready.videos ? <>
          <Text style={styles.sub}>最近 30 天发的作品</Text>
          <Choice options={TOP_VIDEO_ORDERS} value={order} onChange={setOrder} />
          <View onLayout={(event) => setListWidth(event.nativeEvent.layout.width)} style={styles.videos}>{videos.slice(0, 10).map((video) => <Pressable key={video.id} accessibilityRole="button" accessibilityLabel={`查看作品：${video.title || "无标题"}`} disabled={disabled} onPress={() => onOpenVideo(video.id)} style={[styles.video, { width: videoWidth }, disabled && styles.dim]}>
            {video.cover ? <Image source={{ uri: video.cover }} style={styles.thumb} resizeMode="cover" /> : <View style={styles.thumb} />}
            <View style={styles.videoCopy}>
              <Text numberOfLines={2} style={styles.videoTitle}>{video.title || "（没有标题）"}</Text>
              <Text style={styles.muted}>{video.day ? `${shortDay(video.day)} 发布，` : ""}点赞 {formatIndex(video.likes)}，评论 {formatIndex(video.comments)}，分享 {formatIndex(video.shares)}，带来 {formatIndex(video.follows)} 个新粉丝</Text>
            </View>
          </Pressable>)}</View>
          {!videos.length ? <Text style={styles.muted}>最近 30 天没有发作品。</Text> : null}
        </> : null}
      </> : null}

      {tab === "fans" && ready.fans ? <>
        <View style={styles.portrait}>{ready.fans.map((group) => <View key={group.key} style={styles.portraitCol}>
          <Text style={styles.sub}>{group.title}</Text>
          <BarList valueHeader="占比" compareHeader="TGI" rows={group.rows.map((row) => ({ label: row.label, ratio: row.share, value: formatShare(row.share), compare: row.tgi === null ? null : String(Math.round(row.tgi)) }))} />
        </View>)}</View>
        <Text style={styles.muted}>TGI 是偏好度：100 是全站平均水平，越高说明这类人越偏爱这个达人。</Text>
      </> : null}

      {missing.length ? <View style={styles.row}>
        <Text style={[styles.muted, styles.grow]}>{missing.join("、")}这次没读到。</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="重新读取达人详情" onPress={() => setAttempt(attempt + 1)} style={styles.chip}><RefreshCw size={12} color={color.textSecondary} /><Text style={styles.chipText}>重新读取</Text></Pressable>
      </View> : null}
      <View style={styles.foot}>
        <Pressable accessibilityRole="link" accessibilityLabel="在抖音创作者平台查看完整的达人详情" onPress={() => onOpenPage(darenPageUrl(daren.id))} style={styles.chip}>
          <Text style={styles.chipText}>在创作者平台查看完整详情</Text><ArrowUpRight size={12} color={color.textSecondary} />
        </Pressable>
      </View>
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 }, headCopy: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: color.text, fontFamily: font.body, fontSize: 16, fontWeight: "600" },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 18 },
  sub: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }, grow: { flex: 1, minWidth: 160 },
  iconButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  tabs: { flexDirection: "row", gap: 20, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  tab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" }, tabOn: { borderBottomColor: color.cyan },
  tabText: { color: color.textMuted, fontFamily: font.body, fontSize: 13 }, tabTextOn: { color: color.text, fontWeight: "600" },
  metrics: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  // 等分一行：900 宽的窗口里五个也放得下，不会剩一个被拉满
  metric: { flexGrow: 1, flexBasis: 0, minWidth: 110, gap: 4, padding: 12, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  metricOn: { borderColor: color.cyan }, metricValue: { color: color.text, fontFamily: font.body, fontSize: 22, fontWeight: "600" },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  chipOn: { borderColor: color.cyan }, chipText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 }, chipTextOn: { color: color.text, fontWeight: "600" },
  dim: { opacity: 0.45 }, foot: { flexDirection: "row", justifyContent: "flex-end" },
  videos: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  video: { minWidth: 0, flexDirection: "row", gap: 12, padding: 10, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  thumb: { width: 54, height: 72, borderRadius: 4, backgroundColor: color.surfaceMuted },
  videoCopy: { flex: 1, minWidth: 0, gap: 6 }, videoTitle: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  portrait: { flexDirection: "row", flexWrap: "wrap", gap: 20 }, portraitCol: { flexGrow: 1, flexBasis: 260, minWidth: 0, gap: 8 },
});
