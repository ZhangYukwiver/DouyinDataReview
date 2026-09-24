import React from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  type LayoutChangeEvent,
  type TextProps,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Path, Text as SvgText } from "react-native-svg";

import {
  attentionLabel,
  attentionPattern,
  contentPattern,
  creatorsPattern,
  pctLabel,
  rhythmPattern,
  smoothPath,
  type ReportModel,
} from "./ReportWorkspace";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { fx, polylineLength, useCountUp, useDraw, useInView, ws } from "./motion";
import { buildReportGapShape, layoutReportTiles, reportColumnCount, REPORT_TILE_GAP } from "./reportLayout";

export interface ReportDashboardProps {
  mobile: boolean;
  model: ReportModel;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  /** 可用内容宽度，决定瀑布列数。 */
  width: number;
  /** 海报风格：尾部空当按直角切，不做圆角天际线。 */
  square?: boolean;
}

const weekLetters = ["M", "T", "W", "T", "F", "S", "S"];
const weekdayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const TEAL = color.cyan;
const GOLD = color.accent;
// 热力与饼图的色阶跟整体风格走（workspaceTheme）
const heatColors = color.heat;
const sliceColors = color.slices;

/**
 * 持续报告：与故事页（ReportWorkspace 十二章）同源的一屏读数。
 * 卡片按实际内容高度排入最短的一列，后续卡片向上补位，保持固定间距。
 */
export function ReportDashboard({ mobile, model, onOpenRecord, privacy, square = false, width }: ReportDashboardProps) {
  const observed = model.total + model.chat;
  const partial = model.status === "partial" || model.reliableRatio < 1;
  const pcts = model.progressPercents;
  const share = (test: (value: number) => boolean) => (pcts.length ? pcts.filter(test).length / pcts.length * 100 : null);
  const recent = [...new Map(model.recent.map((item) => [`${item.title}:${item.time}`, item])).values()].slice(0, 6);

  const tiles: Tile[] = [
    { key: "days", h: 108, node: (
      <Cardlet en="ACTIVE DAYS" key="days" title="活跃天数">
        <Figure sub="/ 365" value={model.activeDays || "—"} />
      </Cardlet>
    ) },
    { key: "events", h: 108, node: (
      <Cardlet en="EVENTS" key="events" title="观测事件">
        <Figure sub="observed" value={observed || "—"} />
      </Cardlet>
    ) },
    { key: "unique", h: 108, node: (
      <Cardlet en="UNIQUE" key="unique" title="去重内容">
        <Figure sub="unique" value={model.unique || "—"} />
      </Cardlet>
    ) },
    { key: "attention", h: 108, node: (
      <Cardlet en="ATTENTION" key="attention" title="总注意力">
        <Figure sub={model.watch ? `${model.watch.toLocaleString("zh-CN")} 条观看` : "observed"} value={attentionLabel(model.attentionSeconds)} />
      </Cardlet>
    ) },
    { key: "heat", h: 268, node: (
      <Cardlet
        en="WEEK × HOUR"
        foot={rhythmPattern(model)}
        key="heat"
        meta={model.peakDay === null ? "时间证据不足" : `${weekdayNames[model.peakDay]} 最密`}
        title="一周热力"
      >
        <HeatGrid heatmap={model.heatmap} />
      </Cardlet>
    ) },
    { key: "hours", h: 186, node: (
      <Cardlet en="HOURS" key="hours" meta={model.peakHour === null ? "—" : `${pad(model.peakHour)}:00 峰值`} title="一天的曲线">
        <HourCurve peak={model.peakHour} values={model.hours} />
      </Cardlet>
    ) },
    { key: "completion", h: 228, node: (
      <Cardlet en="COMPLETION" key="completion" meta={`${pcts.length.toLocaleString("zh-CN")} 条进度`} title="平均完成度">
        <Ring caption={model.watch ? `重播 ${Math.round(model.replays / model.watch * 100)}%` : "等待进度"} label={pctLabel(model.completion)} value={model.completion} />
      </Cardlet>
    ) },
    { key: "funnel", h: 252, node: (
      <Cardlet en="FUNNEL" foot={attentionPattern(model.completion)} key="funnel" meta="观看进度分档" title="停留漏斗">
        <Funnel steps={[
          { label: "开始浏览", value: pcts.length ? 100 : null },
          { label: "继续观看", value: share((value) => value >= 25) },
          { label: "深度观看", value: share((value) => value >= 60) },
          { label: "完成观看", value: share((value) => value >= 90) },
        ]} />
      </Cardlet>
    ) },
    { key: "topics", h: 262, node: (
      <Cardlet en="TOPICS" foot={contentPattern(model.topics)} key="topics" meta={`${model.topics.length} 个主题信号`} title="主题色块">
        <Mosaic items={model.topics.slice(0, 8).map((topic, index) => ({ label: privacy ? `话题${index + 1}` : topic.name, value: topic.count }))} />
      </Cardlet>
    ) },
    { key: "length", h: 244, node: (
      <Cardlet en="LENGTH" key="length" meta="按内容时长" title="时长构成">
        <Pie slices={model.durationBands.map((band) => ({ label: band.label, sub: band.en, value: band.share ?? 0 }))} />
      </Cardlet>
    ) },
    { key: "format", h: 212, node: (
      <Cardlet en="FORMAT" key="format" meta={`${model.formats.length} 种形态`} title="内容形态">
        <Pie donut slices={model.formats.slice(0, 4).map((format) => ({ label: format.name, sub: String(format.count), value: format.share }))} />
      </Cardlet>
    ) },
    { key: "tail", h: 258, node: (
      <Cardlet en="LONG TAIL" foot={creatorsPattern(model)} key="tail" meta={`${model.creatorsCount.toLocaleString("zh-CN")} 位可识别`} title="创作者长尾">
        <TailCurve head={model.creators.slice(0, 3).map((creator, index) => ({ label: privacy ? `创作者 ${index + 1}` : creator.name, value: creator.count }))} tail={model.creatorFocus.tail} />
      </Cardlet>
    ) },
    { key: "concentration", h: 228, node: (
      <Cardlet en="CONCENTRATION" key="concentration" meta="前三位占比" title="创作者集中度">
        <Ring caption={`新面孔 ${pctLabel(model.creatorFocus.discovery)}`} label={pctLabel(model.creatorFocus.concentration)} tone={GOLD} value={model.creatorFocus.concentration} />
      </Cardlet>
    ) },
    { key: "daynight", h: 216, node: (
      <Cardlet en="DAY & NIGHT" key="daynight" meta={`昼夜重合 ${pctLabel(model.overlap)}`} title="内容与对话">
        <DualCurve chat={model.chatHours} watch={model.hours} />
      </Cardlet>
    ) },
    { key: "chatmix", h: 254, node: (
      <Cardlet en="CHAT MIX" key="chatmix" meta={`${model.chat.toLocaleString("zh-CN")} 条消息`} title="消息类型">
        <Pie donut slices={model.chatKinds.slice(0, 5).map((kind) => ({ label: kind.name, sub: String(kind.count), value: kind.share }))} />
      </Cardlet>
    ) },
    { key: "months", h: 172, node: (
      <Cardlet en="MONTHS" key="months" meta={model.peakMonth === null ? "月份趋势不可用" : `峰值 ${monthNames[model.peakMonth]}`} title="全年起伏">
        <MonthCurve months={model.months} peak={model.peakMonth} />
      </Cardlet>
    ) },
    { key: "venn", h: 288, node: (
      <Cardlet en="OVERLAP" key="venn" meta="三类列表交集" title="留下的内容">
        <Venn intersection={model.intersection} totals={{ favorite: model.favorite, liked: model.liked, watch: model.watch }} />
      </Cardlet>
    ) },
    { key: "matrix", h: 276, node: (
      <Cardlet en="CORRELATION" key="matrix" meta={`${model.cross.days} 个观测日`} title="交叉矩阵">
        <Matrix labels={model.cross.labels} matrix={model.cross.matrix} />
      </Cardlet>
    ) },
    { key: "radar", h: 282, node: (
      <Cardlet en="HABIT PROFILE" key="radar" meta={model.profile} title="习惯雷达">
        <Radar axes={model.axes} />
      </Cardlet>
    ) },
    { key: "cross", h: 214, node: (
      <Cardlet en="CROSS PATTERNS" key="cross" meta="按相关性排序" title="交叉洞察">
        <InsightList items={model.cross.patterns.map((pattern) => ({ text: pattern.text, title: pattern.title }))} />
      </Cardlet>
    ) },
    { key: "surprises", h: 252, node: (
      <Cardlet
        en="SURPRISES"
        key="surprises"
        meta={`${model.surprises.filter((insight) => insight.status === "observed").length} / ${model.surprises.length} 已点亮`}
        title="意外发现"
      >
        <InsightList items={model.surprises.map((insight) => ({ badge: insight.status, text: insight.text, title: insight.title }))} />
      </Cardlet>
    ) },
    { key: "recent", h: 226, node: (
      <Cardlet en="RECENT" key="recent" meta={`${model.events.length.toLocaleString("zh-CN")} 条事件`} title="近期事件">
        <EventList items={recent} onOpenRecord={onOpenRecord} privacy={privacy} />
      </Cardlet>
    ) },
    { key: "boundary", h: 178, node: (
      <Cardlet en="BOUNDARY" key="boundary" meta={`${Math.round(model.reliableRatio * 100)}% 可靠时间`} title="数据边界">
        <Boundary model={model} />
      </Cardlet>
    ) },
  ];

  return (
    <ScrollView
      testID="report-dashboard"
      contentContainerStyle={[styles.content, mobile && styles.contentMobile]}
      showsVerticalScrollIndicator={false}
    >
      {partial ? (
        <View {...fx({ motion: "rise", ws: "stamp-bar" })} style={styles.coverage}>
          <Text {...ws("stamp")} style={styles.coverageLabel}>样本覆盖</Text>
          <Text style={styles.coverageText}>
            {model.dated.toLocaleString("zh-CN")} / {model.total.toLocaleString("zh-CN")} 条记录带可靠行为时间
            {model.warnings[0] ? ` · ${model.warnings[0]}` : ""}
          </Text>
        </View>
      ) : null}

      <Board mobile={mobile} square={square} tiles={tiles} width={width - (mobile ? 24 : 40)} />
    </ScrollView>
  );
}

/* ---------- 按内容高度补位：卡片自然撑开，排布只负责位置 ---------- */

interface Tile { key: string; h: number; node: React.ReactNode }

function Board({ mobile, square, tiles, width }: {
  mobile: boolean;
  square: boolean;
  tiles: Tile[];
  width: number;
}) {
  const [boardWidth, setBoardWidth] = React.useState(Math.max(0, width));
  const columns = reportColumnCount(boardWidth, mobile);
  const columnWidth = Math.max(0, (boardWidth - REPORT_TILE_GAP * (columns - 1)) / columns);
  const [measured, setMeasured] = React.useState<{ width: number; heights: Record<string, number> }>({ width: columnWidth, heights: {} });
  // 换行会改变内容高度；每次列宽改变都重新测量，内容变少时也允许卡片收回。
  const heights = measured.width === columnWidth ? measured.heights : {};
  const layout = layoutReportTiles(tiles, columns, heights);
  // 估高阶段的空当是假的，等所有卡片量完再补，免得占位块先闪一下再跳走。
  const settled = tiles.every((tile) => heights[tile.key] !== undefined);
  const gapShape = settled ? buildReportGapShape(layout.bottoms, layout.height, columnWidth, square ? 0 : undefined) : null;
  const onMeasure = (key: string, event: LayoutChangeEvent) => {
    const { height, width: actualWidth } = event.nativeEvent.layout;
    if (height <= 0 || Math.abs(actualWidth - columnWidth) > 0.5) return;
    setMeasured((current) => {
      const currentHeights = current.width === columnWidth ? current.heights : {};
      return Math.abs((currentHeights[key] ?? 0) - height) <= 0.5
        ? current
        : { width: columnWidth, heights: { ...currentHeights, [key]: height } };
    });
  };
  return (
    <View
      onLayout={(event) => setBoardWidth(event.nativeEvent.layout.width)}
      style={[styles.board, { height: layout.height }]}
      testID="report-board"
    >
      {layout.placed.map(({ column, top }, index) => (
        <BoardTile
          index={index}
          key={tiles[index]!.key}
          onLayout={(event) => onMeasure(tiles[index]!.key, event)}
          tileKey={tiles[index]!.key}
          style={{
            left: column * (columnWidth + REPORT_TILE_GAP),
            position: "absolute",
            top,
            width: columnWidth,
          }}
        >
          <View>{tiles[index]!.node}</View>
        </BoardTile>
      ))}
      {gapShape ? <SwarmGap {...gapShape} /> : null}
    </View>
  );
}

// 格子滚到视口才上浮进场，同一批露出的按序号错开；悬停微抬。
function BoardTile({ children, index, onLayout, style, tileKey }: {
  children: React.ReactNode;
  index: number;
  onLayout: (event: LayoutChangeEvent) => void;
  style: ViewStyle;
  tileKey: string;
}) {
  const [ref, inView] = useInView<View>();
  return <View {...fx({ reveal: inView, i: (index % 6) + 1, hover: "lift", ws: "d-tile" })} onLayout={onLayout} ref={ref} style={[styles.tile, style]} testID={`report-tile-${tileKey}`}>{children}</View>;
}

function SwarmGap({ focus, height, left, path, top, width }: {
  focus: { x: number; y: number };
  height: number;
  left: number;
  path: string;
  top: number;
  width: number;
}) {
  const paper = React.useRef<View | null>(null);
  React.useEffect(() => {
    const node = paper.current as unknown as HTMLElement | null;
    // clip-path 把背景、群点和点击热区一起裁成天际线的形状。
    if (node?.style) node.style.clipPath = `path("${path}")`;
  }, [path]);
  useSwarm(paper, focus.x, focus.y);
  return (
    <View pointerEvents="box-none" style={{ height, left, position: "absolute", top, width }} testID="report-tile-swarm">
      <View {...ws("d-swarm")} ref={paper} style={[styles.swarmPaper, { height, width }]}>
        <Text {...ws("d-swarmhint")} style={styles.swarmHint}>点一下会散开</Text>
      </View>
      <Svg height={height} pointerEvents="none" style={StyleSheet.absoluteFill} width={width}>
        <Path d={path} fill="none" stroke={color.border} strokeWidth={1} />
      </Svg>
    </View>
  );
}

/**
 * 照搬 reactbits 的 swarm cursor：一群会互相融成一坨的光点绕着指针转，点一下炸开再聚回来。
 * 原版是 ogl 两趟 WebGL——先把每个点和拖尾按高斯核累加成场，再用 smoothstep 卡出实心和辉光。
 * 这里同样两趟，但用 canvas：场画在离屏画布上，主画布用 lighter 叠几遍把场"卡"成实心边缘
 * （叠 n 遍等于 alpha×n 截顶，就是一次软阈值），再补一层模糊当辉光，最后 source-in 上色。
 * 不引依赖。native 不跑。
 */
function useSwarm(ref: React.RefObject<View | null>, focusX: number, focusY: number): void {
  React.useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (Platform.OS !== "web" || !node || typeof window === "undefined") return undefined;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%";
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      node.removeChild(canvas);
      return undefined;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TRAIL = 18;
    // 高斯核画成一张贴图，每帧只 drawImage，不反复建渐变
    const blob = document.createElement("canvas");
    blob.width = 160;
    blob.height = 160;
    const blobCtx = blob.getContext("2d")!;
    const kernel = blobCtx.createRadialGradient(80, 80, 0, 80, 80, 80);
    for (let stop = 0; stop <= 40; stop += 1) kernel.addColorStop(stop / 40, `rgba(255,255,255,${Math.exp(-((stop / 40) ** 2) * 3.6).toFixed(4)})`);
    blobCtx.fillStyle = kernel;
    blobCtx.fillRect(0, 0, 160, 160);
    const field = document.createElement("canvas");
    const fieldCtx = field.getContext("2d")!;
    const dots = Array.from({ length: 10 }, () => ({
      x: 0, y: 0, vx: 0, vy: 0,
      phase: Math.random() * Math.PI * 2,
      hand: Math.random() < 0.5 ? -1 : 1,
      agility: 0.75 + Math.random() * 0.5,
      past: [] as Array<[number, number]>,
    }));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let boxWidth = 1;
    let boxHeight = 1;
    let edgeColor = "#9ab";
    let coreColor = "#456";
    let styleKey = "";
    // 海报风格把这块空当印成实心色块（posterCss 里 --ws-swarm:off），群点不画
    let paused = false;
    const readColors = () => {
      const computed = window.getComputedStyle(node);
      edgeColor = computed.getPropertyValue("--ws-cyan").trim() || edgeColor;
      coreColor = computed.getPropertyValue("--ws-accent").trim() || coreColor;
      paused = computed.getPropertyValue("--ws-swarm").trim() === "off";
      styleKey = document.documentElement.dataset.style ?? "";
    };
    const resize = () => {
      boxWidth = node.clientWidth || 1;
      boxHeight = node.clientHeight || 1;
      canvas.width = Math.round(boxWidth * dpr);
      canvas.height = Math.round(boxHeight * dpr);
      field.width = canvas.width;
      field.height = canvas.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fieldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    readColors();
    const anchorX = Math.max(0, Math.min(boxWidth, focusX));
    const anchorY = Math.max(0, Math.min(boxHeight, focusY));
    for (const dot of dots) {
      const angle = Math.random() * Math.PI * 2;
      dot.x = anchorX + Math.cos(angle) * 40;
      dot.y = anchorY + Math.sin(angle) * 40;
    }
    const cursor = { x: anchorX, y: anchorY, inside: false };
    let burst = 0;
    const move = (event: PointerEvent) => {
      const box = node.getBoundingClientRect();
      cursor.x = event.clientX - box.left;
      cursor.y = event.clientY - box.top;
      cursor.inside = true;
    };
    const leave = () => { cursor.inside = false; };
    const down = (event: PointerEvent) => { move(event); burst = 1; };
    node.addEventListener("pointermove", move, { passive: true });
    node.addEventListener("pointerenter", move, { passive: true });
    node.addEventListener("pointerleave", leave);
    node.addEventListener("pointerdown", down);

    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (document.documentElement.dataset.style !== styleKey) readColors();
      if (paused) {
        ctx.clearRect(0, 0, boxWidth, boxHeight);
        return;
      }
      const anchorX = cursor.inside ? cursor.x : Math.max(0, Math.min(boxWidth, focusX));
      const anchorY = cursor.inside ? cursor.y : Math.max(0, Math.min(boxHeight, focusY));
      const seconds = now / 1000;
      burst = Math.max(0, burst - delta / 0.55);
      const band = Math.max(28, Math.min(boxWidth, boxHeight) * 0.32);
      const maxSpeed = 150 + band * 1.6;
      const apart = band * 0.78;
      if (!still) for (const [index, dot] of dots.entries()) {
        const dx = anchorX - dot.x;
        const dy = anchorY - dot.y;
        const distance = Math.hypot(dx, dy) || 1e-4;
        const ux = dx / distance;
        const uy = dy / distance;
        // 环绕半径慢慢呼吸，各点相位错开，看起来像一群而不是一圈
        const orbit = band * (0.42 + 0.46 * (Math.sin(seconds * 0.6 + dot.phase) * 0.5 + 0.5));
        const radial = Math.max(-1, Math.min(1, (distance - orbit) / (band * 0.85)));
        const swirl = Math.sqrt(Math.max(0, 1 - radial * radial)) * dot.hand;
        let wishX = ux * radial - uy * swirl;
        let wishY = uy * radial + ux * swirl;
        const wish = Math.hypot(wishX, wishY) || 1e-4;
        wishX /= wish;
        wishY /= wish;
        const rate = 5.5 * dot.agility * (1 - burst);
        let ax = (wishX * maxSpeed - dot.vx) * rate;
        let ay = (wishY * maxSpeed - dot.vy) * rate;
        if (burst > 0.001) {
          ax -= ux * maxSpeed * burst * 6;
          ay -= uy * maxSpeed * burst * 6;
        }
        for (const [other, mate] of dots.entries()) {
          if (other === index) continue;
          const sx = dot.x - mate.x;
          const sy = dot.y - mate.y;
          const gap = Math.hypot(sx, sy);
          if (gap > 1e-3 && gap < apart) {
            const push = (1 - gap / apart) * maxSpeed * 2.2;
            ax += (sx / gap) * push;
            ay += (sy / gap) * push;
          }
        }
        dot.vx += ax * delta;
        dot.vy += ay * delta;
        const speed = Math.hypot(dot.vx, dot.vy) || 1e-4;
        const ceiling = maxSpeed * (1 + burst * 3);
        const floor = maxSpeed * 0.3;
        const clamped = Math.max(floor, Math.min(ceiling, speed));
        dot.vx = (dot.vx / speed) * clamped;
        dot.vy = (dot.vy / speed) * clamped;
        dot.x += dot.vx * delta;
        dot.y += dot.vy * delta;
        dot.past.push([dot.x, dot.y]);
        if (dot.past.length > TRAIL) dot.past.shift();
      }
      // 第一趟：把每个点和它的拖尾按高斯核加成一张场
      const head = Math.max(9, Math.min(15, band * 0.19));
      fieldCtx.clearRect(0, 0, boxWidth, boxHeight);
      fieldCtx.globalCompositeOperation = "lighter";
      let sumX = 0;
      let sumY = 0;
      for (const dot of dots) {
        sumX += dot.x;
        sumY += dot.y;
        for (const [index, [x, y]] of dot.past.entries()) {
          const ratio = (index + 1) / dot.past.length;
          const radius = head * (0.22 + 0.6 * ratio);
          fieldCtx.globalAlpha = 0.08 + 0.42 * ratio ** 2;
          fieldCtx.drawImage(blob, x - radius, y - radius, radius * 2, radius * 2);
        }
        fieldCtx.globalAlpha = 1;
        fieldCtx.drawImage(blob, dot.x - head, dot.y - head, head * 2, head * 2);
      }
      fieldCtx.globalAlpha = 1;
      // 第二趟：叠 4 遍卡出实心（软阈值），再补一层模糊当辉光，最后只给形状上色
      ctx.clearRect(0, 0, boxWidth, boxHeight);
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "blur(1.5px)";
      for (let pass = 0; pass < 3; pass += 1) ctx.drawImage(field, 0, 0, boxWidth, boxHeight);
      ctx.filter = `blur(${Math.max(3, Math.round(head * 0.5))}px)`;
      ctx.globalAlpha = 0.45;
      ctx.drawImage(field, 0, 0, boxWidth, boxHeight);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-in";
      const cx = sumX / dots.length;
      const cy = sumY / dots.length;
      const tint = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(24, band * 1.6));
      tint.addColorStop(0, coreColor);
      tint.addColorStop(1, edgeColor);
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, boxWidth, boxHeight);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerenter", move);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("pointerdown", down);
      canvas.remove();
    };
  }, [focusX, focusY, ref]);
}

function Cardlet({ children, en, foot, meta, title }: {
  children: React.ReactNode;
  en: string;
  foot?: string;
  meta?: string;
  title: string;
}) {
  return (
    <>
      <View {...ws("d-head")} style={styles.tileHead}>
        <Text {...ws("d-title")} style={styles.tileTitle}>{title}</Text>
        <Text {...ws("d-en")} style={styles.tileEn}>/ {en}</Text>
        {meta ? <Text {...ws("d-meta")} numberOfLines={1} style={styles.tileMeta}>{meta}</Text> : null}
      </View>
      <View style={styles.tileBody}>{children}</View>
      {foot ? (
        <View {...ws("d-foot")} style={styles.tileFoot}>
          <Text {...ws("d-mark")} style={styles.tileFootMark}>✦</Text>
          <Text style={styles.tileFootText}>{foot}</Text>
        </View>
      ) : null}
    </>
  );
}

function Boundary({ model }: { model: ReportModel }) {
  return (
    <View>
      <Text style={styles.boundaryText}>
        {model.total.toLocaleString("zh-CN")} 条内容记录中 {model.dated.toLocaleString("zh-CN")} 条带可靠行为时间；
        无时间记录仍计入总量，但不参与时段、月份与交叉结论。聊天只统计时间与类型，群聊只计总量。
      </Text>
      {model.warnings.slice(0, 2).map((warning) => <Text key={warning} style={styles.boundaryNotice}>{warning}</Text>)}
    </View>
  );
}

/* ---------- 单一职责的图形组件 ---------- */

function Figure({ sub, value }: { sub: string; value: string | number }) {
  const count = useCountUp(typeof value === "number" ? value : 0);
  return (
    <View style={styles.figure}>
      <Text {...ws("d-figure")} style={styles.figureValue}>{typeof value === "number" ? count.toLocaleString("en-US") : value}</Text>
      <Text {...ws("mono")} numberOfLines={1} style={styles.figureSub}>{sub}</Text>
    </View>
  );
}

/** 周 × 小时的观看密度色块。 */
function HeatGrid({ heatmap }: { heatmap: number[] }) {
  const max = Math.max(1, ...heatmap);
  return (
    <View style={styles.heatWrap}>
      {weekLetters.map((letter, day) => (
        <View key={`${letter}:${day}`} style={styles.heatRow}>
          <Text style={styles.heatLetter}>{letter}</Text>
          <View style={styles.heatCells}>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = heatmap[day * 24 + hour] ?? 0;
              const step = value === 0 ? 0 : Math.min(heatColors.length - 1, 1 + Math.floor(value / max * (heatColors.length - 1.001)));
              return <View key={hour} style={[styles.heatCell, { backgroundColor: heatColors[step] }]} />;
            })}
          </View>
        </View>
      ))}
      <View style={styles.heatAxis}>
        <Text {...ws("mono")} style={styles.axisText}>00</Text>
        <Text {...ws("mono")} style={styles.axisText}>06</Text>
        <Text {...ws("mono")} style={styles.axisText}>12</Text>
        <Text {...ws("mono")} style={styles.axisText}>18</Text>
        <Text {...ws("mono")} style={styles.axisText}>23</Text>
      </View>
    </View>
  );
}

/** 24 小时观看量的面积曲线。 */
function HourCurve({ peak, values }: { peak: number | null; values: number[] }) {
  const [ref, t] = useDraw<View>();
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => [index / 23 * 300, 96 - value / max * 82] as [number, number]);
  const line = smoothPath(points);
  const length = polylineLength(points);
  const peakPoint = peak === null ? null : points[peak];
  return (
    <View ref={ref}>
      <Svg height={104} preserveAspectRatio="none" viewBox="0 0 300 104" width="100%">
        <Path d={`${line} L 300 104 L 0 104 Z`} fill={TEAL} fillOpacity={0.16 * t} />
        <Path d={line} fill="none" stroke={TEAL} strokeDasharray={length} strokeDashoffset={length * (1 - t)} strokeWidth={1.4} />
        {peakPoint ? <Circle cx={peakPoint[0]} cy={peakPoint[1]} fill={GOLD} opacity={t} r={3} /> : null}
      </Svg>
      <View style={styles.axisRow}>
        <Text {...ws("mono")} style={styles.axisText}>00</Text>
        <Text {...ws("mono")} style={styles.axisText}>06</Text>
        <Text {...ws("mono")} style={styles.axisText}>12</Text>
        <Text {...ws("mono")} style={styles.axisText}>18</Text>
        <Text {...ws("mono")} style={styles.axisText}>23</Text>
      </View>
    </View>
  );
}

/** 单值圆环。 */
function Ring({ caption, label, tone = TEAL, value }: { caption: string; label: string; tone?: string; value: number | null }) {
  const radius = 39;
  const circumference = 2 * Math.PI * radius;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const [ref, t] = useDraw<View>();
  return (
    <View ref={ref} style={styles.ringWrap}>
      <Svg height={104} viewBox="0 0 104 104" width={104}>
        <Circle cx={52} cy={52} fill="none" r={radius} stroke={color.surfaceMuted} strokeWidth={8} />
        {value !== null ? (
          <Circle
            cx={52}
            cy={52}
            fill="none"
            r={radius}
            stroke={tone}
            strokeDasharray={`${circumference * pct * t / 100} ${circumference}`}
            strokeWidth={8}
            transform="rotate(-90 52 52)"
          />
        ) : null}
      </Svg>
      <View pointerEvents="none" style={styles.ringCenter}><Text {...ws("d-ringvalue")} style={styles.ringValue}>{label}</Text></View>
      <View style={styles.ringSide}>
        <View style={[styles.ringSideMark, { backgroundColor: tone }]} />
        <Text style={styles.ringCaption}>{caption}</Text>
      </View>
    </View>
  );
}

/** 饼图 / 环形图，附带图例。 */
function Pie({ donut = false, slices }: { donut?: boolean; slices: Array<{ label: string; sub: string; value: number }> }) {
  const [ref, t] = useDraw<View>();
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  if (!total) return <Empty text="等待样本" />;
  const inner = donut ? 30 : 0;
  let angle = -Math.PI / 2;
  // 顺时针扫出：进度 t 决定一共画到哪个角度，各片依次吃掉自己那一段
  let budget = Math.PI * 2 * t;
  const drawn = slices.filter((slice) => slice.value > 0).map((slice, index) => {
    const sweep = slice.value / total * Math.PI * 2;
    const shown = Math.max(0, Math.min(sweep, budget));
    budget -= shown;
    const path = shown > 0.002 ? arcPath(56, 56, 52, inner, angle, angle + Math.min(shown, Math.PI * 2 - 0.0001)) : "";
    angle += sweep;
    return { path, slice, tone: sliceColors[index % sliceColors.length]! };
  });
  if (drawn.length === 1) {
    const only = drawn[0]!;
    return (
      <View style={styles.soloWrap}>
        <View style={[styles.soloBar, { backgroundColor: only.tone }]} />
        <View style={styles.soloCopy}>
          <Text numberOfLines={1} style={styles.legendLabel}>{only.slice.label}</Text>
          <Text {...ws("d-num big")} style={styles.soloValue}>{only.slice.sub}</Text>
        </View>
      </View>
    );
  }
  return (
    <View ref={ref} style={styles.pieWrap}>
      <Svg height={96} viewBox="0 0 112 112" width={96}>
        {drawn.map(({ path, tone }, index) => (path ? <Path d={path} fill={tone} key={index} /> : null))}
        {donut ? <Circle cx={56} cy={56} fill={color.surface} r={inner} /> : null}
      </Svg>
      <View style={styles.legend}>
        {drawn.map(({ slice, tone }, index) => (
          <View key={`${slice.label}:${index}`} style={styles.legendRow}>
            <View style={[styles.legendSwatch, { backgroundColor: tone }]} />
            <Text numberOfLines={1} style={styles.legendLabel}>{slice.label}</Text>
            <Text {...ws("d-num")} style={styles.legendValue}>{Math.round(slice.value / total * 100)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** 按占比铺开的色块（面积＝权重）。 */
function Mosaic({ items }: { items: Array<{ label: string; value: number }> }) {
  if (!items.length) return <Empty text="等待主题证据" />;
  const rows = [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))].filter((row) => row.length);
  const values = items.map((item) => item.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  return (
    <View style={styles.mosaic}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.mosaicRow}>
          {row.map((item, index) => {
            const weight = item.value / max;
            const step = max === min ? 3 : 1 + Math.round((item.value - min) / (max - min) * (heatColors.length - 2));
            return (
              <View
                {...ws("d-mosaic", step === heatColors.length - 2 && "dark")}
                key={`${item.label}:${index}`}
                style={[styles.mosaicCell, {
                  flexGrow: Math.max(0.4, weight),
                  backgroundColor: heatColors[step],
                  borderColor: item.value === max ? GOLD : color.border,
                }]}
              >
                <Text style={styles.mosaicLabel}>{item.label}</Text>
                <Text {...ws("d-num")} style={styles.mosaicValue}>{item.value}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** 逐级收窄的漏斗色块。 */
function Funnel({ steps }: { steps: Array<{ label: string; value: number | null }> }) {
  const [ref, t] = useDraw<View>();
  return (
    <View ref={ref} style={styles.funnel}>
      {steps.map((step, index) => (
        <View key={step.label} style={styles.funnelRow}>
          <Text style={styles.funnelLabel}>{step.label}</Text>
          <View {...ws("d-track")} style={styles.funnelTrack}>
            <View style={[styles.funnelBlock, {
              width: `${step.value === null ? 0 : Math.max(3, step.value) * t}%`,
              backgroundColor: index === 0 ? color.funnel0 : index === 1 ? color.funnel1 : index === 2 ? TEAL : GOLD,
            }]} />
          </View>
          <Text {...ws("d-num")} style={styles.funnelValue}>{pctLabel(step.value)}</Text>
        </View>
      ))}
    </View>
  );
}

/** 创作者长尾：前三位标注 + 尾部衰减曲线。 */
function TailCurve({ head, tail }: { head: Array<{ label: string; value: number }>; tail: number[] }) {
  const [ref, t] = useDraw<View>();
  const series = [...head.map((item) => item.value), ...tail];
  if (series.length < 2) return <Empty text="等待创作者证据" />;
  const max = Math.max(1, ...series);
  const scale = (value: number) => Math.log1p(Math.max(0, value)) / Math.log1p(max);
  const points = series.map((value, index) => [index / (series.length - 1) * 300, 86 - scale(value) * 72] as [number, number]);
  const line = smoothPath(points, 86);
  const length = polylineLength(points);
  return (
    <View ref={ref}>
      <Svg height={92} preserveAspectRatio="none" viewBox="0 0 300 92" width="100%">
        <Path d={`${line} L 300 92 L 0 92 Z`} fill={GOLD} fillOpacity={0.14 * t} />
        <Path d={line} fill="none" stroke={GOLD} strokeDasharray={length} strokeDashoffset={length * (1 - t)} strokeWidth={1.4} />
      </Svg>
      <View style={styles.headList}>
        {head.map((item, index) => (
          <View key={`${item.label}:${index}`} style={styles.headRow}>
            <Text {...ws("d-rank")} style={styles.headRank}>{pad(index + 1)}</Text>
            <Text numberOfLines={1} style={styles.headName}>{item.label}</Text>
            <Text {...ws("d-num")} style={styles.headValue}>{item.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** 内容与对话的两条昼夜曲线。 */
function DualCurve({ chat, watch }: { chat: number[]; watch: number[] }) {
  const [ref, t] = useDraw<View>();
  const line = (values: number[]) => {
    const max = Math.max(1, ...values);
    const points = values.map((value, index) => [index / 23 * 300, 96 - value / max * 78] as [number, number]);
    return { d: smoothPath(points), length: polylineLength(points) };
  };
  const watchLine = line(watch);
  const chatLine = line(chat);
  const hasChat = chat.some((value) => value > 0);
  return (
    <View ref={ref}>
      <Svg height={104} preserveAspectRatio="none" viewBox="0 0 300 104" width="100%">
        <Path d={`${watchLine.d} L 300 104 L 0 104 Z`} fill={TEAL} fillOpacity={0.14 * t} />
        <Path d={watchLine.d} fill="none" stroke={TEAL} strokeDasharray={watchLine.length} strokeDashoffset={watchLine.length * (1 - t)} strokeWidth={1.4} />
        {hasChat ? <Path d={chatLine.d} fill="none" opacity={t} stroke={GOLD} strokeDasharray="4 3" strokeWidth={1.4} /> : null}
      </Svg>
      <View style={styles.axisRow}>
        <Text {...ws("mono")} style={styles.axisText}>00</Text>
        <Text {...ws("mono")} style={styles.axisText}>06</Text>
        <Text {...ws("mono")} style={styles.axisText}>12</Text>
        <Text {...ws("mono")} style={styles.axisText}>18</Text>
        <Text {...ws("mono")} style={styles.axisText}>23</Text>
      </View>
      <View style={styles.legendInline}>
        <View style={[styles.legendSwatch, { backgroundColor: TEAL }]} /><Text style={styles.legendLabel}>内容</Text>
        <View style={[styles.legendSwatch, { backgroundColor: GOLD }]} /><Text style={styles.legendLabel}>{hasChat ? "对话" : "对话待观测"}</Text>
      </View>
    </View>
  );
}

/** 十二个月的起伏曲线。 */
function MonthCurve({ months, peak }: { months: number[]; peak: number | null }) {
  const [ref, t] = useDraw<View>();
  const max = Math.max(1, ...months);
  const points = months.map((value, index) => [index / 11 * 300, 78 - value / max * 64] as [number, number]);
  const line = smoothPath(points, 78);
  const length = polylineLength(points);
  const peakPoint = peak === null ? null : points[peak];
  return (
    <View ref={ref}>
      <Svg height={86} preserveAspectRatio="none" viewBox="0 0 300 86" width="100%">
        <Path d={`${line} L 300 86 L 0 86 Z`} fill={TEAL} fillOpacity={0.14 * t} />
        <Path d={line} fill="none" stroke={TEAL} strokeDasharray={length} strokeDashoffset={length * (1 - t)} strokeWidth={1.4} />
        {peakPoint ? <Circle cx={peakPoint[0]} cy={peakPoint[1]} fill={GOLD} opacity={t} r={3} /> : null}
      </Svg>
      <View style={styles.axisRow}>
        {monthNames.filter((_, index) => index % 3 === 0).map((name) => <Text key={name} style={styles.axisText}>{name}</Text>)}
        <Text {...ws("mono")} style={styles.axisText}>12月</Text>
      </View>
    </View>
  );
}

/** 三类列表的交集韦恩图。 */
function Venn({ intersection, totals }: { intersection: ReportModel["intersection"]; totals: { favorite: number; liked: number; watch: number } }) {
  const circles = [
    // 标签放在各自圆的独占月牙里（r=42，与另两圆无交叠），别落到圆外
    { cx: 100, cy: 52, label: "观看", tone: color.vennWatch, total: totals.watch, tx: 100, ty: 32 },
    { cx: 74, cy: 96, label: "喜欢", tone: GOLD, total: totals.liked, tx: 56, ty: 118 },
    { cx: 126, cy: 96, label: "收藏", tone: color.vennFavorite, total: totals.favorite, tx: 144, ty: 118 },
  ];
  return (
    <View>
      <Svg height={150} viewBox="0 0 200 150" width="100%">
        {circles.map((circle) => (
          <Circle cx={circle.cx} cy={circle.cy} fill={circle.tone} fillOpacity={0.13} key={circle.label} r={42} stroke={circle.tone} strokeOpacity={0.75} strokeWidth={1} />
        ))}
        {circles.map((circle) => (
          <SvgText fill={color.textMuted} fontSize={9} key={`${circle.label}-label`} textAnchor="middle" x={circle.tx} y={circle.ty}>{circle.label}</SvgText>
        ))}
        <SvgText fill={color.figure} fontSize={13} textAnchor="middle" x={100} y={92}>{intersection.allThree.toLocaleString("zh-CN")}</SvgText>
      </Svg>
      <View style={styles.cellGrid}>
        <Cell label="喜欢 ∩ 收藏" value={intersection.likedFavorite} />
        <Cell label="观看 ∩ 喜欢" value={intersection.watchLiked} />
        <Cell label="观看 ∩ 收藏" value={intersection.watchFavorite} />
        <Cell label="三类都有" value={intersection.allThree} />
      </View>
    </View>
  );
}

/** 五个日度指标的相关性色块矩阵。 */
function Matrix({ labels, matrix }: { labels: string[]; matrix: Array<Array<number | null>> }) {
  return (
    <View style={styles.matrix}>
      {matrix.map((row, rowIndex) => (
        <View key={labels[rowIndex] ?? rowIndex} style={styles.matrixRow}>
          <Text numberOfLines={1} style={styles.matrixLabel}>{labels[rowIndex]}</Text>
          {row.map((value, columnIndex) => (
            <View
              {...ws("d-mcell", rowIndex !== columnIndex && value !== null && `${value >= 0 ? "pos" : "neg"} s${Math.abs(value) >= 0.67 ? 3 : Math.abs(value) >= 0.34 ? 2 : 1}`)}
              key={columnIndex}
              style={[styles.matrixCell, rowIndex === columnIndex && styles.matrixCellSelf, {
                backgroundColor: rowIndex === columnIndex
                  ? color.surfaceRaised
                  : value === null
                    ? color.surfaceMuted
                    : value >= 0 ? GOLD : TEAL,
                // 相关性强弱用透明度表达；对角线与空值格子保持实色
                opacity: rowIndex === columnIndex || value === null ? 1 : 0.12 + Math.abs(value) * 0.72,
              }]}
            />
          ))}
        </View>
      ))}
      <View style={styles.matrixFootRow}>
        <View style={styles.matrixLabelSpacer} />
        {labels.map((label) => <Text key={label} numberOfLines={1} style={styles.matrixTick}>{label.slice(0, 2)}</Text>)}
      </View>
      <View style={styles.legendInline}>
        <View {...ws("d-mcell", "pos s3")} style={[styles.legendSwatch, { backgroundColor: alpha(GOLD, 0.8) }]} /><Text style={styles.legendLabel}>正相关</Text>
        <View {...ws("d-mcell", "neg s3")} style={[styles.legendSwatch, { backgroundColor: alpha(TEAL, 0.8) }]} /><Text style={styles.legendLabel}>负相关</Text>
      </View>
    </View>
  );
}

/** 五轴习惯雷达。 */
function Radar({ axes }: { axes: ReportModel["axes"] }) {
  const cx = 100;
  const cy = 84;
  const radius = 62;
  const angle = (index: number) => (-90 + index * 72) * Math.PI / 180;
  const point = (index: number, r: number): [number, number] => [cx + Math.cos(angle(index)) * r, cy + Math.sin(angle(index)) * r];
  const ring = (r: number) => `M ${axes.map((_, index) => point(index, r).join(" ")).join(" L ")} Z`;
  const [ref, t] = useDraw<View>();
  const shape = `M ${axes.map((axis, index) => point(index, radius * (0.1 + (Math.max(0.1, Math.min(1, (axis.value ?? 10) / 100)) - 0.1) * t)).join(" ")).join(" L ")} Z`;
  return (
    <View ref={ref}>
      <Svg height={168} viewBox="0 0 200 168" width="100%">
        {[0.35, 0.7, 1].map((scale) => <Path d={ring(radius * scale)} fill="none" key={scale} stroke={color.border} strokeWidth={0.8} />)}
        {axes.map((axis, index) => (
          <Path d={`M ${cx} ${cy} L ${point(index, radius).join(" ")}`} key={axis.label} stroke={color.border} strokeWidth={0.6} />
        ))}
        <Path d={shape} fill={GOLD} fillOpacity={0.2} stroke={GOLD} strokeWidth={1.3} />
        {axes.map((axis, index) => {
          const [x, y] = point(index, radius + 17);
          return (
            <SvgText fill={color.textMuted} fontSize={9.5} key={`${axis.label}-tag`} textAnchor="middle" x={x} y={y + 3}>
              {axis.label} {pctLabel(axis.value)}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

function InsightList({ items }: { items: Array<{ badge?: string; text: string; title: string }> }) {
  return (
    <View style={styles.insightList}>
      {items.map((item, index) => (
        <View key={`${item.title}:${index}`} style={styles.insight}>
          <Text {...ws("d-mark", item.badge === "pending" && "off")} style={[styles.insightMark, item.badge === "pending" && styles.insightMarkMuted]}>✦</Text>
          <View style={styles.insightCopy}>
            <View style={styles.insightTitleRow}>
              <Text {...ws("d-ititle")} style={styles.insightTitle}>{item.title}</Text>
              {item.badge ? <Text {...ws(item.badge === "pending" ? "stamp-ghost" : "stamp-sig")} style={[styles.badge, item.badge === "pending" && styles.badgeMuted]}>{item.badge}</Text> : null}
            </View>
            <Text style={styles.insightText}>{item.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function EventList({ items, onOpenRecord, privacy }: {
  items: ReportModel["recent"];
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
}) {
  if (!items.length) return <Empty text="等待带时间的记录" />;
  return (
    <View style={styles.eventList}>
      {items.map((item, index) => {
        const canOpen = Boolean(item.url && !privacy);
        return (
          <Pressable
            key={`${item.title}:${index}`}
            accessibilityLabel={`${privacy ? `内容 ${index + 1}` : item.title}${canOpen ? "，打开记录" : ""}`}
            accessibilityRole={canOpen ? "link" : undefined}
            disabled={!canOpen}
            onPress={() => item.url && void onOpenRecord(item.url)}
            {...fx({ hover: "tint", ws: "d-event" })}
            style={({ pressed }) => [styles.event, pressed && styles.pressed]}
          >
            <Text {...ws("d-rank")} style={styles.eventRank}>{pad(index + 1)}</Text>
            <Text numberOfLines={1} style={styles.eventTitle}>{privacy ? `内容 ${index + 1}` : item.title}</Text>
            <Text {...ws("mono")} style={styles.eventTime}>{formatTime(item.time)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <View {...ws("d-cell")} style={styles.cell}>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text {...ws("d-num big")} style={styles.cellValue}>{value.toLocaleString("zh-CN")}</Text>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

function arcPath(cx: number, cy: number, radius: number, inner: number, from: number, to: number): string {
  const at = (r: number, angle: number) => `${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`;
  const large = to - from > Math.PI ? 1 : 0;
  return inner > 0
    ? `M ${at(radius, from)} A ${radius} ${radius} 0 ${large} 1 ${at(radius, to)} L ${at(inner, to)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, from)} Z`
    : `M ${cx} ${cy} L ${at(radius, from)} A ${radius} ${radius} 0 ${large} 1 ${at(radius, to)} Z`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

// ponytail: 默认正文字体跟整体风格走（档案馆衬线 / 年志 Inter），见 workspaceTheme
const bodyType = { fontFamily: font.body } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 40 },
  contentMobile: { padding: 12, paddingBottom: 88 },

  coverage: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14, paddingHorizontal: 14, paddingVertical: 10, borderLeftWidth: 3, borderLeftColor: color.amber, borderRadius: radius.small, backgroundColor: color.amberSoft },
  coverageLabel: { color: color.amber, fontSize: 10, fontWeight: "600", letterSpacing: 2, fontFamily: font.mono },
  coverageText: { flex: 1, color: color.textSecondary, fontSize: 10.5, lineHeight: 17 },

  board: { position: "relative", marginTop: 12 },
  swarmPaper: { position: "relative", overflow: "hidden", backgroundColor: color.surface, cursor: "pointer" } as ViewStyle,
  swarmHint: { position: "absolute", right: 15, bottom: 13, color: color.textMuted, fontSize: 9, letterSpacing: 1, opacity: 0.7 },
  tile: { minWidth: 0, overflow: "hidden", paddingHorizontal: 13, paddingVertical: 13, borderWidth: 1, borderColor: color.border, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: color.shadow },
  tileHead: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 8 },
  tileTitle: { flexShrink: 0, color: color.text, fontSize: 15, fontWeight: "600", letterSpacing: 2.5, fontFamily: font.serif },
  tileEn: { flexGrow: 1, flexShrink: 1, color: color.textMuted, fontSize: 10, letterSpacing: 1.5, fontFamily: font.mono },
  tileMeta: { flexShrink: 0, maxWidth: "100%", color: color.textMuted, fontSize: 9.5, letterSpacing: 1 },
  tileBody: { marginTop: 10 },
  tileFoot: { flexDirection: "row", gap: 8, paddingTop: 10 },
  tileFootMark: { color: color.accent, fontSize: 10, paddingTop: 3 },
  tileFootText: { flex: 1, color: color.textMuted, fontSize: 10.5, lineHeight: 17, letterSpacing: 0.4 },

  figure: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  figureValue: { color: color.figure, fontSize: 38, lineHeight: 46, fontFamily: font.didot, letterSpacing: 1 },
  figureSub: { flexShrink: 1, color: color.textMuted, fontSize: 10.5, letterSpacing: 1.5 },

  heatWrap: { gap: 3 },
  heatRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heatLetter: { width: 10, color: color.textMuted, fontSize: 9.5, letterSpacing: 0.5 },
  heatCells: { flex: 1, flexDirection: "row", gap: 2 },
  heatCell: { flex: 1, height: 15 },
  heatAxis: { flexDirection: "row", justifyContent: "space-between", marginLeft: 18, marginTop: 5 },

  axisRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 5 },
  axisText: { color: color.textMuted, fontSize: 9, fontFamily: font.didot, letterSpacing: 0.5 },

  ringWrap: { flexDirection: "row", alignItems: "center", gap: 16 },
  ringCenter: { position: "absolute", left: 0, top: 41, width: 104, alignItems: "center" },
  ringValue: { color: color.figure, fontSize: 21, fontFamily: font.didot },
  ringCaption: { flex: 1, color: color.textMuted, fontSize: 10.5, lineHeight: 17, letterSpacing: 1.2 },
  ringSide: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  ringSideMark: { width: 10, height: 10 },

  pieWrap: { flexDirection: "row", alignItems: "center", gap: 14 },
  soloWrap: { flexDirection: "row", alignItems: "center", gap: 12 },
  soloBar: { width: 46, height: 46 },
  soloCopy: { flex: 1, minWidth: 0 },
  soloValue: { color: color.figure, fontSize: 17, fontFamily: font.didot, marginTop: 3 },
  legend: { flex: 1, minWidth: 0, gap: 7 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  legendSwatch: { width: 10, height: 10 },
  legendLabel: { flex: 1, color: color.textSecondary, fontSize: 10.5, letterSpacing: 0.5 },
  legendValue: { color: color.textMuted, fontSize: 10.5, fontFamily: font.didot },
  legendInline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },

  mosaic: { gap: 6 },
  mosaicRow: { flexDirection: "row", gap: 6 },
  mosaicCell: { flexBasis: 0, minWidth: 0, minHeight: 74, justifyContent: "flex-end", padding: 8, borderWidth: 1 },
  mosaicLabel: { color: color.text, fontSize: 11, letterSpacing: 0.5 },
  mosaicValue: { color: color.figure, fontSize: 13, fontFamily: font.didot, marginTop: 2 },

  funnel: { gap: 12 },
  funnelRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  funnelLabel: { width: 62, color: color.textSecondary, fontSize: 11, letterSpacing: 1 },
  funnelTrack: { flex: 1, height: 20, backgroundColor: color.surfaceMuted },
  funnelBlock: { height: 20 },
  funnelValue: { width: 42, color: color.textMuted, fontSize: 11, fontFamily: font.didot, textAlign: "right" },

  headList: { gap: 7, marginTop: 12 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  headRank: { width: 18, color: color.accent, fontSize: 10.5, fontFamily: font.didot },
  headName: { flex: 1, color: color.textSecondary, fontSize: 11, letterSpacing: 0.5 },
  headValue: { color: color.text, fontSize: 11, fontFamily: font.didot },

  cellGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  cell: { width: "48%", flexGrow: 1, minHeight: 46, justifyContent: "center", paddingHorizontal: 9, backgroundColor: color.surfaceRaised },
  cellLabel: { color: color.textMuted, fontSize: 9, letterSpacing: 1.2 },
  cellValue: { color: color.text, fontSize: 14, fontFamily: font.didot, marginTop: 2 },

  matrix: { gap: 3 },
  matrixRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  matrixLabel: { width: 52, color: color.textMuted, fontSize: 9.5, letterSpacing: 0.4 },
  matrixCell: { flex: 1, height: 26 },
  matrixCellSelf: { borderWidth: 1, borderColor: color.borderSoft },
  matrixFootRow: { flexDirection: "row", gap: 3, marginTop: 4 },
  matrixLabelSpacer: { width: 52 },
  matrixTick: { flex: 1, color: color.textMuted, fontSize: 8.5, textAlign: "center" },


  insightList: { gap: 13 },
  insight: { flexDirection: "row", gap: 9 },
  insightMark: { color: color.accent, fontSize: 11, paddingTop: 2 },
  insightMarkMuted: { color: color.textMuted },
  insightCopy: { flex: 1, minWidth: 0 },
  insightTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  insightTitle: { flex: 1, color: color.text, fontSize: 12.5, letterSpacing: 1.2 },
  insightText: { color: color.textSecondary, fontSize: 11, lineHeight: 18, letterSpacing: 0.4, marginTop: 4 },
  badge: { color: color.cyan, fontSize: 9, letterSpacing: 1.4 },
  badgeMuted: { color: color.textMuted },

  eventList: { marginTop: -4 },
  event: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  eventRank: { width: 20, color: color.accent, fontSize: 10.5, fontFamily: font.didot },
  eventTitle: { flex: 1, color: color.textSecondary, fontSize: 11.5, letterSpacing: 0.5 },
  eventTime: { color: color.textMuted, fontSize: 10.5, fontFamily: font.didot },

  boundaryText: { color: color.textMuted, fontSize: 10.5, lineHeight: 18 },
  boundaryNotice: { color: color.amber, fontSize: 10, lineHeight: 16, marginTop: 6 },

  empty: { color: color.textMuted, fontSize: 11, lineHeight: 18, paddingVertical: 16 },
  pressed: { opacity: 0.72 },
});
