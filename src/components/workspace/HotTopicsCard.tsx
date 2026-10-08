import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import { LocalCollectorError } from "../../services/localCollector";
import { loadHotTopics } from "../../services/douyinIndex";
import { formatIndex, type HotTopic, type HotTopics } from "../../domain/douyinIndex";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

const LISTS: Array<{ key: keyof HotTopics; title: string }> = [{ key: "current", title: "抖音实时热点" }, { key: "rocketing", title: "抖音飙升热点" }];
const PREVIEW = 10;
const messageOf = (error: unknown) => error instanceof LocalCollectorError && error.message ? error.message : "没读到抖音热点榜，请稍后重试。";
const TREND_LABEL = { 1: "排名上升", [-1]: "排名下降", 0: "排名持平" } as const;

/** 探索页还没搜索时，显示创作者平台抖音指数首页的两个热点榜；点一个热点直接去搜它。读失败不影响搜索。 */
export function HotTopicsCard({ connection, disabled = false, onSearch }: { connection: ExploreConnection; disabled?: boolean; onSearch: (topic: string) => void }) {
  const [topics, setTopics] = useState<HotTopics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const controller = new AbortController();
    setTopics(null); setError(null);
    void loadHotTopics(connection, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setTopics(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [connection.baseUrl, connection.token, attempt]);

  return <View {...ws("e-box")} style={styles.card} testID="hot-topics-card">
    <View style={styles.head}>
      <Text {...ws("e-section")} accessibilityRole="header" style={styles.title}>抖音热点</Text>
      <Text style={styles.muted}>来自抖音创作者平台的抖音指数 · 点一个热点就去搜它</Text>
    </View>
    {!topics && !error ? <View accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator size="small" color={color.cyan} /><Text style={styles.muted}>正在读取抖音热点榜…</Text></View> : null}
    {error ? <View accessibilityRole="alert" style={styles.row}>
      <Text style={[styles.muted, styles.grow]}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取抖音热点榜" onPress={() => setAttempt(attempt + 1)} style={styles.chip}><RefreshCw size={12} color={color.textSecondary} /><Text style={styles.chipText}>重试</Text></Pressable>
    </View> : null}
    {topics ? <View style={styles.lists}>{LISTS.map(({ key, title }) => {
      const items = topics[key];
      const open = expanded[key] ?? false;
      return <View key={key} style={styles.list}>
        <Text style={styles.sub}>{title}</Text>
        {items.length ? (open ? items : items.slice(0, PREVIEW)).map((topic) => <Row key={`${topic.rank}:${topic.name}`} topic={topic} disabled={disabled} onSearch={onSearch} />) : <Text style={styles.muted}>这个榜这次是空的。</Text>}
        {items.length > PREVIEW ? <Pressable accessibilityRole="button" onPress={() => setExpanded({ ...expanded, [key]: !open })} style={styles.more}><Text style={styles.chipText}>{open ? "收起" : `展开全部 ${items.length} 条`}</Text></Pressable> : null}
      </View>;
    })}</View> : null}
  </View>;
}

function Row({ topic, disabled, onSearch }: { topic: HotTopic; disabled: boolean; onSearch: (topic: string) => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`搜索热点：${topic.name}，热点指数 ${formatIndex(topic.index)}，${TREND_LABEL[topic.trend]}`} disabled={disabled} onPress={() => onSearch(topic.name)} style={[styles.item, disabled && styles.dim]}>
    <Text style={[styles.rank, topic.rank <= 3 && styles.rankTop]}>{topic.rank}</Text>
    <Text numberOfLines={1} style={styles.name}>{topic.name}</Text>
    <Text style={styles.muted}>{formatIndex(topic.index)}</Text>
    <View style={styles.trend}>{topic.trend === 1 ? <ArrowUp size={13} color={color.accent} /> : topic.trend === -1 ? <ArrowDown size={13} color={color.textMuted} /> : <Text style={styles.muted}>–</Text>}</View>
  </Pressable>;
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  head: { gap: 4 }, title: { color: color.text, fontFamily: font.body, fontSize: 16, fontWeight: "600" },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }, grow: { flex: 1, minWidth: 160 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  chipText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  lists: { flexDirection: "row", flexWrap: "wrap", gap: 24 }, list: { flexGrow: 1, flexBasis: 300, minWidth: 0, gap: 2 },
  sub: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, fontWeight: "600", marginBottom: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  rank: { width: 22, color: color.textMuted, fontFamily: font.body, fontSize: 12, textAlign: "center" }, rankTop: { color: color.accent, fontWeight: "600" },
  name: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 13 }, trend: { width: 16, alignItems: "center" },
  more: { alignSelf: "flex-start", marginTop: 8, paddingVertical: 4 }, dim: { opacity: 0.45 },
});
