import React, { useRef, useState } from "react";
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { alpha, workspaceColors as color, workspaceFonts as font } from "./workspaceTheme";
import { ws } from "./motion";

// 创作者中心页用的几种图：折线（趋势）、环形（性别/活跃）、竖条（年龄）、横条（来源/地域）、雷达（五维诊断）。
// 只画官方页面上有的那几种，颜色全走工作台 token，跟着整体风格换。

// 数据色：web 上先取 --ws-chart-N（极简在 minimalCss 里定义成蓝的深浅档 + 中性灰），另外三种风格没定义，回退到原 token，像素不变
const chartBase = [color.accent, color.cyan, color.amber, color.green, color.danger, color.textSecondary];
export const chartPalette = Platform.OS === "web" ? chartBase.map((token, index) => `var(--ws-chart-${index}, ${token})`) : chartBase;
const DATA = chartPalette[0]!;

function useWidth(initial = 0): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(initial);
  return [width, (event) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (Math.abs(current - next) > 1 ? next : current));
  }];
}

function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
}

export interface LineSeries { label: string; values: Array<number | null>; color?: string; dashed?: boolean }

/** 趋势折线：横轴是日期/时刻，悬停显示当点数值。 */
export function LineChart({ labels, series, height = 220, format = (value) => String(value), percentAxis = false, fixedMax, axisFormat, details, titles }: {
  labels: string[]; series: LineSeries[]; height?: number; format?: (value: number) => string; percentAxis?: boolean;
  /** 固定纵轴上限（留存这类 0–1 的图） */ fixedMax?: number; axisFormat?: (value: number) => string;
  /** 悬停框里追加的行（环比、分端数据） */ details?: (index: number) => string[];
  /** 悬停框标题，默认用横轴标签 */ titles?: string[];
}) {
  const [width, onLayout] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const host = useRef<View | null>(null);
  const left = 44, right = 24, top = 12, bottom = 26;
  const plotWidth = Math.max(0, width - left - right);
  const plotHeight = height - top - bottom;
  const values = series.flatMap((item) => item.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  const max = fixedMax ?? niceMax(Math.max(0, ...values));
  const count = labels.length;
  const x = (index: number) => left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * max);
  const widest = Math.max(0, ...labels.map((label) => label.length));
  const step = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / Math.max(56, widest * 7 + 20)))));
  const pointer = (event: any) => {
    if (!count || !plotWidth) return;
    // 鼠标可能落在 svg 的线、点上，按容器位置算，别用相对子元素的 locationX
    const rect = (host.current as unknown as HTMLElement | null)?.getBoundingClientRect?.();
    const offset = rect ? event.nativeEvent.clientX - rect.left : event.nativeEvent.locationX ?? 0;
    const index = Math.round(((offset - left) / plotWidth) * (count - 1));
    setHover(Math.max(0, Math.min(count - 1, index)));
  };
  const axisLabel = (value: number) => axisFormat ? axisFormat(value) : percentAxis ? `${Math.round(value * 1000) / 10}%` : value >= 10000 ? `${Math.round(value / 1000) / 10}万` : String(Math.round(value * 100) / 100);
  return <View ref={host} onLayout={onLayout} style={{ height }} {...({ onMouseMove: pointer, onMouseLeave: () => setHover(null) } as object)}>
    {width ? <Svg width={width} height={height}>
      {ticks.map((tick) => <G key={tick}>
        <Line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke={color.borderSoft} strokeDasharray="3 4" strokeWidth={1} />
        <SvgText x={left - 8} y={y(tick) + 4} fill={color.textMuted} fontSize={10} textAnchor="end">{axisLabel(tick)}</SvgText>
      </G>)}
      {labels.map((label, index) => (index % step === 0 || index === count - 1) && (count - 1 - index >= step / 2 || index === count - 1)
        ? <SvgText key={`${label}${index}`} x={x(index)} y={height - 8} fill={color.textMuted} fontSize={10} textAnchor="middle">{label}</SvgText> : null)}
      {series.map((item, seriesIndex) => {
        const stroke = item.color ?? chartPalette[seriesIndex % chartPalette.length]!;
        let path = "";
        item.values.forEach((value, index) => {
          if (typeof value !== "number" || !Number.isFinite(value)) return;
          path += `${path && typeof item.values[index - 1] === "number" ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
        });
        const area = seriesIndex === 0 && series.length === 1 && path ? `${path}L${x(count - 1)},${y(0)}L${x(0)},${y(0)}Z` : "";
        return <G key={item.label}>
          {area ? <Path d={area} fill={alpha(stroke, 0.12)} /> : null}
          <Path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeDasharray={item.dashed ? "5 4" : undefined} />
          {count === 1 && typeof item.values[0] === "number" ? <Circle cx={x(0)} cy={y(item.values[0])} r={3} fill={stroke} /> : null}
        </G>;
      })}
      {hover !== null ? <G>
        <Line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotHeight} stroke={color.textMuted} strokeWidth={1} />
        {series.map((item, seriesIndex) => typeof item.values[hover] === "number"
          ? <Circle key={item.label} cx={x(hover)} cy={y(item.values[hover] as number)} r={3.5} fill={item.color ?? chartPalette[seriesIndex % chartPalette.length]} /> : null)}
      </G> : null}
    </Svg> : null}
    {hover !== null && width ? <View pointerEvents="none" style={[styles.tooltip, x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }]}>
      <Text {...ws("cr-note")} style={styles.tooltipTitle}>{titles?.[hover] ?? labels[hover]}</Text>
      {series.map((item, seriesIndex) => <View key={item.label} style={styles.tooltipRow}>
        <View style={[styles.dot, { backgroundColor: item.color ?? chartPalette[seriesIndex % chartPalette.length] }]} />
        <Text style={styles.tooltipText}>{item.label} {typeof item.values[hover] === "number" ? format(item.values[hover] as number) : "—"}</Text>
      </View>)}
      {details?.(hover).map((line) => <Text key={line} style={styles.tooltipText}>{line}</Text>)}
    </View> : null}
  </View>;
}

export interface Slice { label: string; value: number }

/** 环形图，旁边列出每块的占比。 */
export function Donut({ slices, size = 150 }: { slices: Slice[]; size?: number }) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  // 描边从三点钟方向开始画，偏移四分之一圈让它从正上方开始（不用 rotation，web 上会出 transform-origin 警告）
  let offset = 0;
  return <View style={styles.donutRow}>
    <Svg width={size} height={size}>
      <G>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={color.surfaceMuted} strokeWidth={18} fill="none" />
        {total > 0 ? slices.map((slice, index) => {
          const length = (Math.max(0, slice.value) / total) * circumference;
          const dash = <Circle key={slice.label} cx={size / 2} cy={size / 2} r={radius} stroke={chartPalette[index % chartPalette.length]} strokeWidth={18} fill="none"
            strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={circumference / 4 - offset} />;
          offset += length;
          return dash;
        }) : null}
      </G>
    </Svg>
    <View style={styles.legend}>{slices.map((slice, index) => <View key={slice.label} style={styles.legendRow}>
      <View style={[styles.dot, { backgroundColor: chartPalette[index % chartPalette.length] }]} />
      <Text style={styles.legendLabel}>{slice.label}</Text>
      <Text style={styles.legendValue}>{total > 0 ? `${Math.round((slice.value / total) * 100)}%` : "—"}</Text>
    </View>)}</View>
  </View>;
}

/** 竖条：年龄分布这类，值是 0–1 的占比。 */
export function Bars({ items, height = 190 }: { items: Slice[]; height?: number }) {
  const [width, onLayout] = useWidth();
  const left = 40, bottom = 24, top = 10;
  const plotHeight = height - top - bottom;
  const max = niceMax(Math.max(0, ...items.map((item) => item.value)) * 100) / 100;
  const slot = items.length ? (width - left) / items.length : 0;
  const ticks = [0, 0.5, 1].map((ratio) => ratio * max);
  return <View onLayout={onLayout} style={{ height }}>
    {width ? <Svg width={width} height={height}>
      {ticks.map((tick) => <G key={tick}>
        <Line x1={left} x2={width} y1={top + plotHeight - (tick / max) * plotHeight} y2={top + plotHeight - (tick / max) * plotHeight} stroke={color.borderSoft} strokeDasharray="3 4" />
        <SvgText x={left - 6} y={top + plotHeight - (tick / max) * plotHeight + 4} fill={color.textMuted} fontSize={10} textAnchor="end">{`${Math.round(tick * 100)}%`}</SvgText>
      </G>)}
      {items.map((item, index) => {
        const barHeight = max > 0 ? (item.value / max) * plotHeight : 0;
        const barWidth = Math.min(28, slot * 0.5);
        const cx = left + slot * index + slot / 2;
        return <G key={item.label}>
          <Rect x={cx - barWidth / 2} y={top + plotHeight - barHeight} width={barWidth} height={barHeight} fill={DATA} rx={2} />
          <SvgText x={cx} y={height - 6} fill={color.textMuted} fontSize={10} textAnchor="middle">{item.label}</SvgText>
        </G>;
      })}
    </Svg> : null}
  </View>;
}

/** 横条列表：流量来源、地域这类“名称 + 占比条 + 数值 (+ 对比)”的表。 */
export function BarList({ rows, valueHeader, compareHeader, nameHeader }: {
  rows: Array<{ label: string; ratio: number; value: string; compare?: string | null; compareSign?: number }>;
  nameHeader?: string; valueHeader?: string; compareHeader?: string;
}) {
  const max = Math.max(0, ...rows.map((row) => row.ratio));
  return <View style={styles.barList}>
    {nameHeader || valueHeader || compareHeader ? <View style={styles.barRow}>
      <Text {...ws("cr-note")} style={[styles.barName, styles.header]}>{nameHeader ?? ""}</Text>
      <Text {...ws("cr-note")} style={[styles.header, { flex: 1 }]}>{valueHeader ?? ""}</Text>
      {compareHeader ? <Text {...ws("cr-note")} style={[styles.barCompare, styles.header]}>{compareHeader}</Text> : null}
    </View> : null}
    {rows.map((row) => <View key={row.label} style={styles.barRow}>
      <Text numberOfLines={1} style={styles.barName}>{row.label}</Text>
      <View style={styles.barTrack}><View style={[styles.barFill, { width: `${max > 0 ? Math.max(1, (row.ratio / max) * 100) : 0}%` }]} /></View>
      <Text style={styles.barValue}>{row.value}</Text>
      {compareHeader ? <Text style={[styles.barCompare, { color: !row.compareSign ? color.textMuted : row.compareSign > 0 ? color.danger : color.green }]}>{row.compare ?? "—"}</Text> : null}
    </View>)}
  </View>;
}

/** 五维雷达：我的指标和同类作者两层，值是 0–1。 */
export function Radar({ axes, size = 240 }: { axes: Array<{ label: string; own: number; similar: number }>; size?: number }) {
  const center = size / 2;
  const radius = size / 2 - 34;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index / axes.length) * Math.PI * 2;
    const r = Math.max(0, Math.min(1, value)) * radius;
    return [center + Math.cos(angle) * r, center + Math.sin(angle) * r] as const;
  };
  const ring = (ratio: number) => axes.map((_, index) => point(index, ratio).join(",")).join(" ");
  return <Svg width={size} height={size}>
    {[0.25, 0.5, 0.75, 1].map((ratio) => <Polygon key={ratio} points={ring(ratio)} fill="none" stroke={color.borderSoft} strokeWidth={1} />)}
    {axes.map((axis, index) => {
      const [ex, ey] = point(index, 1);
      const [lx, ly] = point(index, 1.2);
      return <G key={axis.label}>
        <Line x1={center} y1={center} x2={ex} y2={ey} stroke={color.borderSoft} />
        <SvgText x={lx} y={ly + 4} fill={color.textSecondary} fontSize={11} textAnchor="middle">{axis.label}</SvgText>
      </G>;
    })}
    <Polygon points={axes.map((axis, index) => point(index, axis.similar).join(",")).join(" ")} fill={alpha(color.textMuted, 0.12)} stroke={color.textMuted} strokeWidth={1} />
    <Polygon points={axes.map((axis, index) => point(index, axis.own).join(",")).join(" ")} fill={alpha(DATA, 0.22)} stroke={DATA} strokeWidth={2} />
    {axes.map((axis, index) => { const [px, py] = point(index, axis.own); return <Circle key={axis.label} cx={px} cy={py} r={3} fill={DATA} />; })}
  </Svg>;
}

const styles = StyleSheet.create({
  tooltip: { position: "absolute", top: 6, paddingHorizontal: 10, paddingVertical: 8, gap: 4, borderRadius: 6, borderWidth: 1, borderColor: color.border, backgroundColor: color.surfaceRaised },
  tooltipTitle: { fontFamily: font.body, fontSize: 11, color: color.textMuted },
  tooltipRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tooltipText: { fontFamily: font.body, fontSize: 12, color: color.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  donutRow: { flexDirection: "row", alignItems: "center", gap: 22, flexWrap: "wrap" },
  legend: { gap: 8, minWidth: 120 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendLabel: { fontFamily: font.body, fontSize: 12, color: color.textSecondary, minWidth: 48 },
  legendValue: { fontFamily: font.body, fontSize: 12, color: color.text, fontWeight: "600" },
  barList: { gap: 10 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  barName: { width: 84, fontFamily: font.body, fontSize: 12, color: color.textSecondary },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: color.surfaceMuted, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4, backgroundColor: DATA },
  barValue: { width: 64, textAlign: "right", fontFamily: font.body, fontSize: 12, color: color.text },
  barCompare: { width: 64, textAlign: "right", fontFamily: font.body, fontSize: 12 },
  header: { fontFamily: font.body, fontSize: 11, color: color.textMuted },
});
