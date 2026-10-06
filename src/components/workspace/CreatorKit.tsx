import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Info } from "lucide-react-native";
import { readCreator, type CreatorData, type CreatorQuery } from "../../services/creatorCenter";
import type { ExploreConnection } from "../../services/explorer";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

// 创作者中心各页共用的小零件：读数据的 hook、卡片框、指标块、切换条、空状态。

export type Raw = Record<string, any>;

// 同一个连接里读过的查询记下来，切 tab 回来不重读；点刷新才清掉
const cache = new Map<string, { at: number; data: CreatorData[] }>();
const CACHE_MS = 5 * 60_000;
export function clearCreatorCache() { cache.clear(); }

/** 读一批查询。queries 为 null 时不读（比如等前一个结果）。 */
export function useCreator(connection: ExploreConnection | null, queries: CreatorQuery[] | null) {
  const key = connection && queries ? `${connection.token}|${JSON.stringify(queries)}` : null;
  const cached = key ? cache.get(key) : undefined;
  const [state, setState] = useState<{ key: string | null; data: CreatorData[] | null; error: string | null }>({ key: null, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const queriesRef = useRef(queries);
  queriesRef.current = queries;
  useEffect(() => {
    if (!key || !connection || !queriesRef.current) return undefined;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) { setState({ key, data: hit.data, error: null }); return undefined; }
    const controller = new AbortController();
    setState((current) => ({ key, data: current.key === key ? current.data : null, error: null }));
    readCreator(connection, queriesRef.current, controller.signal).then((data) => {
      cache.set(key, { at: Date.now(), data });
      setState({ key, data, error: null });
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      setState({ key, data: null, error: error instanceof Error ? error.message : "读取失败，请重试。" });
    });
    return () => controller.abort();
  }, [key, nonce]);
  const reload = useCallback(() => { if (key) cache.delete(key); setNonce((value) => value + 1); }, [key]);
  const fresh = state.key === key;
  const data = fresh ? state.data : cached && Date.now() - cached.at < CACHE_MS ? cached.data : null;
  return { data, error: fresh ? state.error : null, loading: Boolean(key) && !data && !(fresh && state.error), reload };
}

export function Panel({ title, tip, extra, subtitle, children, style }: { title?: string; tip?: string | string[]; extra?: React.ReactNode; subtitle?: string; children: React.ReactNode; style?: object }) {
  const [showTip, setShowTip] = useState(false);
  const tips = Array.isArray(tip) ? tip : tip ? [tip] : [];
  return <View {...ws("e-box")} style={[styles.panel, style]}>
    {title ? <View style={styles.panelHead}>
      <View style={styles.panelTitleRow}>
        <Text {...ws("e-section")} style={styles.panelTitle}>{title}</Text>
        {tips.length ? <Pressable accessibilityRole="button" accessibilityLabel={`${title}说明`} onPress={() => setShowTip((value) => !value)} hitSlop={8}><Info size={14} color={color.textMuted} /></Pressable> : null}
        {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
      </View>
      {extra}
    </View> : null}
    {showTip ? <View style={styles.tipBox}>{tips.map((line) => <Text key={line} style={styles.tipText}>{line}</Text>)}</View> : null}
    {children}
  </View>;
}

export function Segmented<T extends string | number>({ options, value, onChange, small = false }: { options: Array<{ label: string; value: T }>; value: T | null; onChange: (value: T) => void; small?: boolean }) {
  return <View accessibilityRole="tablist" style={styles.segmented}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={String(option.value)} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onChange(option.value)} {...ws("e-tab", selected && "on")}
        style={[styles.segment, small && styles.segmentSmall, selected && styles.segmentOn]}>
        <Text style={[styles.segmentText, small && styles.segmentTextSmall, selected && styles.segmentTextOn]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

export function Tabs<T extends string>({ options, value, onChange }: { options: Array<{ label: string; value: T }>; value: T; onChange: (value: T) => void }) {
  return <View accessibilityRole="tablist" style={styles.tabs}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onChange(option.value)} {...ws("e-tab", selected && "on")} style={[styles.tab, selected && styles.tabOn]}>
        <Text style={[styles.tabText, selected && styles.tabTextOn]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** 一格指标：标题 + 数值（+ 单位小字）+ 可选的副文字。selectable 时可点。 */
export function MetricTile({ label, value, unit, note, noteTone, selected, onPress, tip, tag, wide }: {
  label: string; value: string; unit?: string; note?: string | null; noteTone?: "up" | "down" | null; selected?: boolean; onPress?: () => void; tip?: string; tag?: string | null; wide?: boolean;
}) {
  const body = <>
    <View style={styles.tileHead}><Text numberOfLines={1} style={styles.tileLabel}>{label}</Text>{tip ? <Text accessibilityLabel={tip} style={styles.tileTip}>ⓘ</Text> : null}{tag ? <Text style={styles.tag}>{tag}</Text> : null}</View>
    <Text style={styles.tileValue}>{value}{unit ? <Text style={styles.tileUnit}> {unit}</Text> : null}</Text>
    {note ? <Text style={[styles.tileNote, noteTone === "up" && { color: color.danger }, noteTone === "down" && { color: color.green }]}>{note}</Text> : null}
  </>;
  const style = [styles.tile, wide && styles.tileWide, selected && styles.tileOn];
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${label} ${value}${unit ?? ""}`} onPress={onPress} {...ws("e-box", selected && "on")} style={style}>{body}</Pressable>
    : <View style={style}>{body}</View>;
}

export function Empty({ text, lines, small = false }: { text?: string; lines?: string[]; small?: boolean }) {
  return <View style={[styles.empty, small && styles.emptySmall]}>{(lines ?? [text ?? "暂无数据"]).map((line) => <Text key={line} style={styles.emptyText}>{line}</Text>)}</View>;
}

export function Loading({ label }: { label?: string }) {
  return <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={color.cyan} />{label ? <Text style={styles.muted}>{label}</Text> : null}</View>;
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return <View accessibilityRole="alert" style={styles.error}>
    <Text style={styles.errorText}>{text}</Text>
    {onRetry ? <Pressable accessibilityRole="button" onPress={onRetry} style={styles.smallButton}><Text style={styles.smallButtonText}>重试</Text></Pressable> : null}
  </View>;
}

export function SmallButton({ label, onPress, disabled = false, children }: { label: string; onPress: () => void; disabled?: boolean; children?: React.ReactNode }) {
  return <Pressable {...ws("btn")} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.smallButton, disabled && { opacity: 0.45 }]}>
    {children}<Text style={styles.smallButtonText}>{label}</Text>
  </Pressable>;
}

/** 名次 + 名称 + 值的两列表（地域、兴趣、热词、搜索词这类）。 */
export function RankTable({ headers, rows, ranked = false, maxHeight }: { headers: [string, string]; rows: Array<[string, string]>; ranked?: boolean; maxHeight?: number }) {
  return <View>
    <View style={[styles.tableRow, styles.tableHead]}><Text style={[styles.tableCell, styles.tableHeadText]}>{headers[0]}</Text><Text style={[styles.tableValue, styles.tableHeadText]}>{headers[1]}</Text></View>
    <View style={maxHeight ? { maxHeight, overflow: "scroll" as any } : null}>
      {rows.map(([name, value], index) => <View key={`${name}${index}`} style={styles.tableRow}>
        {ranked ? <Text style={[styles.rank, index < 3 && styles.rankTop]}>{index + 1}</Text> : null}
        <Text numberOfLines={1} style={styles.tableCell}>{name}</Text>
        <Text style={styles.tableValue}>{value}</Text>
      </View>)}
    </View>
  </View>;
}

export const kit = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  columns: { flexDirection: "row", gap: 18, alignItems: "flex-start", flexWrap: "wrap" },
  column: { flex: 1, minWidth: 320, gap: 18 },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 12, lineHeight: 19 },
  body: { color: color.textSecondary, fontFamily: font.body, fontSize: 13, lineHeight: 22 },
  strong: { color: color.text, fontFamily: font.body, fontWeight: "600" },
  subhead: { color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
});

const styles = StyleSheet.create({
  panel: { gap: 16, padding: 20, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  panelHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  panelTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 1 },
  panelTitle: { color: color.text, fontFamily: font.body, fontSize: 16, fontWeight: "600" },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 18 },
  tipBox: { gap: 4, padding: 12, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  tipText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, lineHeight: 19 },
  segmented: { flexDirection: "row", gap: 2, padding: 3, borderRadius: radius.small, backgroundColor: color.surfaceMuted, alignSelf: "flex-start" },
  segment: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.small },
  segmentSmall: { paddingHorizontal: 10, paddingVertical: 4 },
  segmentOn: { backgroundColor: color.surface },
  segmentText: { color: color.textMuted, fontFamily: font.body, fontSize: 12 },
  segmentTextSmall: { fontSize: 11 },
  segmentTextOn: { color: color.text, fontWeight: "600" },
  tabs: { flexDirection: "row", gap: 22, borderBottomWidth: 1, borderBottomColor: color.borderSoft, flexWrap: "wrap" },
  tab: { paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: "transparent", marginBottom: -1 },
  tabOn: { borderBottomColor: color.accent },
  tabText: { color: color.textMuted, fontFamily: font.body, fontSize: 13 },
  tabTextOn: { color: color.text, fontWeight: "600" },
  tile: { flexGrow: 1, flexBasis: 0, minWidth: 104, gap: 6, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "transparent", borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  tileWide: { minWidth: 150 },
  tileOn: { borderColor: color.accent, backgroundColor: alpha(color.accent, 0.08) },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 5 },
  tileLabel: { color: color.textMuted, fontFamily: font.body, fontSize: 12, flexShrink: 1 },
  tileTip: { color: color.textMuted, fontSize: 11 },
  tag: { color: color.accent, fontFamily: font.body, fontSize: 10, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: alpha(color.accent, 0.14) },
  tileValue: { color: color.text, fontFamily: font.body, fontSize: 20, fontWeight: "600" },
  tileUnit: { color: color.textMuted, fontSize: 12, fontWeight: "400" },
  tileNote: { color: color.textMuted, fontFamily: font.body, fontSize: 11 },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 44, gap: 6 },
  emptySmall: { paddingVertical: 22 },
  emptyText: { color: color.textMuted, fontFamily: font.body, fontSize: 13, lineHeight: 21, textAlign: "center" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 30 },
  error: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.small, backgroundColor: color.dangerSoft, flexWrap: "wrap" },
  errorText: { flex: 1, minWidth: 200, color: color.danger, fontFamily: font.body, fontSize: 13, lineHeight: 21 },
  smallButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  smallButtonText: { color: color.text, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  tableHead: { borderBottomWidth: 1, borderBottomColor: color.borderSoft, backgroundColor: color.surfaceRaised },
  tableHeadText: { color: color.textMuted, fontSize: 11 },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  tableCell: { flex: 1, color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  tableValue: { color: color.text, fontFamily: font.body, fontSize: 12, textAlign: "right", minWidth: 60 },
  rank: { width: 20, textAlign: "center", color: color.textMuted, fontFamily: font.body, fontSize: 11 },
  rankTop: { color: color.accent, fontWeight: "700" },
});
