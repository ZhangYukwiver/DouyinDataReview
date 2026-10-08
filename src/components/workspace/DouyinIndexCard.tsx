import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowUpRight, ChevronDown, ChevronUp, RefreshCw } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import { LocalCollectorError } from "../../services/localCollector";
import { loadKeywordExtras, loadKeywordIndex, type KeywordExtras, type KeywordIndex } from "../../services/douyinIndex";
import { dayGap, formatChange, formatIndex, formatShare, indexPageUrl, shortDay, type IndexHighlights, type PortraitRow } from "../../domain/douyinIndex";
import { BarList, LineChart } from "./CreatorCharts";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Metric = "search" | "comprehensive";
const METRICS: Array<{ key: Metric; label: string; hint: string }> = [
  { key: "search", label: "搜索指数", hint: "这个词被搜得有多热" },
  { key: "comprehensive", label: "综合指数", hint: "这个词整体的声量" },
];
// 只显示我们自己写的中文提示；别的错误（程序里的异常）不把英文原文甩给用户
const messageOf = (error: unknown) => error instanceof LocalCollectorError && error.message ? error.message : "没读到抖音指数，请稍后重试。";

/** 「搜索指数 涨得最快：09/25；最高：09/30、10/02」；官方没标出来就不说 */
function highlightText(label: string, { rises, peaks }: IndexHighlights): string | null {
  const parts = [rises.length ? `涨得最快：${rises.map(shortDay).join("、")}` : "", peaks.length ? `最高：${peaks.map(shortDay).join("、")}` : ""].filter(Boolean);
  return parts.length ? `${label} ${parts.join("；")}` : null;
}

/** 搜索一个词时，顺带看看它在抖音指数（创作者平台里的官方数据）上的热度。读失败不影响下面的搜索结果。 */
export function DouyinIndexCard({ connection, keyword, disabled = false, onSearch, onOpenPage }: {
  connection: ExploreConnection; keyword: string; disabled?: boolean;
  /** 点关联词：直接拿它去搜 */ onSearch: (word: string) => void;
  onOpenPage: (url: string) => void;
}) {
  const [result, setResult] = useState<KeywordIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [metric, setMetric] = useState<Metric>("search");
  const [collapsed, setCollapsed] = useState(false);
  const [extras, setExtras] = useState<KeywordExtras | null>(null);
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [extrasError, setExtrasError] = useState<string | null>(null);
  const extrasController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    extrasController.current?.abort();
    setResult(null); setError(null); setExtras(null); setExtrasError(null); setExtrasLoading(false);
    void loadKeywordIndex(connection, keyword, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => { controller.abort(); extrasController.current?.abort(); };
  }, [connection.baseUrl, connection.token, keyword, attempt]);

  async function openExtras() {
    if (extrasLoading) return;
    const controller = new AbortController();
    extrasController.current = controller;
    setExtrasLoading(true); setExtrasError(null);
    try {
      const value = await loadKeywordExtras(connection, keyword, controller.signal);
      if (!controller.signal.aborted) setExtras(value);
    } catch (cause) {
      if (!controller.signal.aborted) setExtrasError(messageOf(cause));
    } finally { if (!controller.signal.aborted) setExtrasLoading(false); }
  }

  const ready = result?.state === "ok" ? result : null;
  const trend = ready?.trend ?? null;
  const values = trend ? (metric === "search" ? trend.search : trend.comprehensive) : [];
  return <View {...ws("e-box")} style={styles.card} testID="douyin-index-card">
    <View style={styles.head}>
      <View style={styles.headCopy}>
        <Text {...ws("e-section")} accessibilityRole="header" style={styles.title}>抖音指数 · {keyword}</Text>
        {ready ? <Text style={styles.muted}>来自抖音创作者平台 · 近 {trend!.days.length} 天，截至 {shortDay(ready.latestDay)}</Text> : null}
      </View>
      {ready ? <Pressable accessibilityRole="button" accessibilityLabel={collapsed ? "展开抖音指数" : "收起抖音指数"} onPress={() => setCollapsed(!collapsed)} style={styles.iconButton}>
        {collapsed ? <ChevronDown size={16} color={color.textMuted} /> : <ChevronUp size={16} color={color.textMuted} />}
      </Pressable> : null}
    </View>

    {!result && !error ? <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" color={color.cyan} /><Text style={styles.muted}>正在读取抖音指数…</Text></View> : null}
    {error ? <View accessibilityRole="alert" style={styles.row}>
      <Text style={[styles.muted, styles.grow]}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取抖音指数" onPress={() => setAttempt(attempt + 1)} style={styles.chip}><RefreshCw size={12} color={color.textSecondary} /><Text style={styles.chipText}>重试</Text></Pressable>
    </View> : null}
    {result?.state === "no_data" ? <Text accessibilityLiveRegion="polite" style={styles.muted}>“{keyword}”暂时没有抖音指数，换个更常用的说法试试。</Text> : null}

    {ready && trend && !collapsed ? <>
      <View style={styles.metrics}>
        {METRICS.map((item) => {
          const average = item.key === "search" ? trend.averages.search : trend.averages.comprehensive;
          const mom = item.key === "search" ? trend.mom.search : trend.mom.comprehensive;
          const yoy = item.key === "search" ? trend.yoy.search : trend.yoy.comprehensive;
          const selected = metric === item.key;
          return <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${item.label}，日均 ${formatIndex(average)}，环比 ${formatChange(mom)}，同比 ${formatChange(yoy)}`} accessibilityHint={item.hint} aria-pressed={selected} onPress={() => setMetric(item.key)} style={[styles.metric, selected && styles.metricOn]}>
            <Text style={styles.muted}>{item.label} · 日均</Text>
            <Text {...ws("d-num big")} style={styles.metricValue}>{formatIndex(average)}</Text>
            <Text style={styles.muted}>环比 {formatChange(mom)} · 同比 {formatChange(yoy)}</Text>
          </Pressable>;
        })}
      </View>
      <LineChart labels={trend.days.map(shortDay)} series={[{ label: METRICS.find((item) => item.key === metric)!.label, values }]} height={170} format={formatIndex} />
      {highlightText(METRICS.find((item) => item.key === metric)!.label, trend.highlights[metric]) ? <Text style={styles.muted}>{highlightText(METRICS.find((item) => item.key === metric)!.label, trend.highlights[metric])}</Text> : null}
      {ready.scores ? <Text style={styles.muted}>近 {trend.days.length} 天的得分：内容 {formatIndex(ready.scores.content)}，传播 {formatIndex(ready.scores.spread)}，搜索 {formatIndex(ready.scores.search)}</Text> : null}

      {extras ? <><Extras extras={extras} latestDay={ready.latestDay} disabled={disabled} loading={extrasLoading} onSearch={onSearch} onRetry={() => void openExtras()} />
        {extrasError ? <Text accessibilityRole="alert" style={styles.muted}>{extrasError}</Text> : null}</> : <View style={styles.row}>
        <Pressable accessibilityRole="button" disabled={extrasLoading} onPress={() => void openExtras()} style={[styles.chip, extrasLoading && styles.dim]}>
          {extrasLoading ? <ActivityIndicator size="small" color={color.cyan} /> : null}<Text style={styles.chipText}>{extrasLoading ? "正在读取…" : "看关联词和人群"}</Text>
        </Pressable>
        {extrasError ? <Text accessibilityRole="alert" style={[styles.muted, styles.grow]}>{extrasError}</Text> : null}
      </View>}
      <View style={styles.foot}>
        <Pressable accessibilityRole="link" accessibilityLabel="在抖音创作者平台查看完整的抖音指数" onPress={() => onOpenPage(indexPageUrl(keyword))} style={styles.chip}>
          <Text style={styles.chipText}>在创作者平台查看完整指数</Text><ArrowUpRight size={12} color={color.textSecondary} />
        </Pressable>
      </View>
    </> : null}
  </View>;
}

const rows = (items: PortraitRow[]) => items.map((item) => ({ label: item.label, ratio: item.share, value: formatShare(item.share) }));

function Extras({ extras, latestDay, disabled, loading, onSearch, onRetry }: { extras: KeywordExtras; latestDay: string; disabled: boolean; loading: boolean; onSearch: (word: string) => void; onRetry: () => void }) {
  const portrait = extras.portrait;
  const behind = dayGap(latestDay, extras.day);
  return <View style={styles.extras} accessibilityLiveRegion="polite">
    <Text style={styles.muted}>关联词和人群只更新到 {shortDay(extras.day)}（往前 7 天）{behind > 0 ? `，比上面的指数早 ${behind} 天` : ""}。</Text>
    {extras.relatedMissing || extras.portraitMissing ? <View style={styles.row}>
      <Text style={[styles.muted, styles.grow]}>{extras.relatedMissing ? "关联词这次没读到。" : "这个词的人群数据暂时没读到。"}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取关联词和人群" disabled={loading} onPress={onRetry} style={[styles.chip, loading && styles.dim]}>
        {loading ? <ActivityIndicator size="small" color={color.cyan} /> : <RefreshCw size={12} color={color.textSecondary} />}<Text style={styles.chipText}>重新读取</Text>
      </Pressable>
    </View> : null}
    {extras.related.length ? <View>
      <Text style={styles.sub}>常和它一起被搜的词</Text>
      <View style={styles.wordWrap}>{extras.related.map((word) => <Pressable key={word.word} accessibilityRole="button" accessibilityLabel={`搜索：${word.word}`} disabled={disabled} onPress={() => onSearch(word.word)} style={[styles.chip, disabled && styles.dim]}>
        <Text style={styles.chipText}>{word.word}</Text>{word.fresh ? <Text style={styles.fresh}>新</Text> : null}
      </Pressable>)}</View>
    </View> : null}
    {portrait ? <View style={styles.portrait}>
      {portrait.gender.length ? <View style={styles.portraitCol}><Text style={styles.sub}>性别</Text><BarList rows={rows(portrait.gender)} /></View> : null}
      {portrait.age.length ? <View style={styles.portraitCol}><Text style={styles.sub}>年龄</Text><BarList rows={rows(portrait.age)} /></View> : null}
      {portrait.provinces.length ? <View style={styles.portraitCol}><Text style={styles.sub}>地域（前 {portrait.provinces.length}）</Text><BarList rows={rows(portrait.provinces)} /></View> : null}
    </View> : null}
    {!extras.related.length && !portrait && !extras.relatedMissing && !extras.portraitMissing ? <Text style={styles.muted}>这个词暂时没有关联词和人群数据。</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 }, headCopy: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: color.text, fontFamily: font.body, fontSize: 16, fontWeight: "600" },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 18 },
  sub: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, fontWeight: "600", marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }, grow: { flex: 1, minWidth: 160 },
  iconButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  metrics: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  metric: { flexGrow: 1, flexBasis: 220, gap: 4, padding: 12, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  metricOn: { borderColor: color.cyan }, metricValue: { color: color.text, fontFamily: font.body, fontSize: 22, fontWeight: "600" },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  chipText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 }, fresh: { color: color.accent, fontFamily: font.body, fontSize: 10 }, dim: { opacity: 0.45 },
  foot: { flexDirection: "row", justifyContent: "flex-end" },
  extras: { gap: 14 }, wordWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  portrait: { flexDirection: "row", flexWrap: "wrap", gap: 20 }, portraitCol: { flexGrow: 1, flexBasis: 220, minWidth: 0 },
});
