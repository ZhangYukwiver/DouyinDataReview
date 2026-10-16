import React from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text as RNText, type TextProps, type TextStyle, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, RadialGradient, Rect, Stop, Text as SvgText } from "react-native-svg";
import {
  Activity,
  Bookmark,
  CalendarDays,
  CalendarRange,
  ChartPie,
  Clock,
  Eye,
  Fingerprint,
  Flame,
  Grid3x3,
  Heart,
  History,
  Hourglass,
  Layers,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Shapes,
  ShieldCheck,
  Smile,
  Sparkles,
  Target,
  Timer,
  TrendingUp,
  Users,
} from "lucide-react-native";

import type { ChatConversationSummary, ChatMessage } from "../../domain/chatRecords";
import type { PersonalRecordCollection } from "../../domain/personalRecords";
import { safeChatAvatarUrl } from "./ChatWorkspace";
import { buildDashboardExtras } from "./reportExtras";
import { attentionLabel, pctLabel, smoothPath, type ReportModel } from "./ReportWorkspace";
import { fx, polylineLength, useCountUp, useDraw } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

export interface ReportDashboardProps {
  mobile: boolean;
  model: ReportModel;
  /** 原始记录和聊天：取头像、封面、常用表情这些 ReportModel 里没有的东西。 */
  records: PersonalRecordCollection;
  chatMessages?: ChatMessage[];
  chatConversations?: ChatConversationSummary[];
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  /** 可用内容宽度：不够排四列时改成两列。 */
  width: number;
}

// 颜色全取工作台主题里的四种强调色（极简是蓝 / 绿 / 琥珀 / 红，档案馆、年志、海报各有自己那一组），
// 切整体风格时跟着变；每块面板认一种主色，图标、渐变和图形都用它
const BLUE = color.cyan;
const GREEN = color.green;
const AMBER = color.amber;
const RED = color.danger;
const PALETTE = [BLUE, GREEN, AMBER, RED, color.textMuted];
const HEAT = color.heat;
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const KIND_TONE = { watch: BLUE, chat: GREEN, kept: RED } as const;
const EVIDENCE = [["watch", "观看", BLUE], ["chat", "聊天", GREEN], ["kept", "留存", RED], ["creators", "创作者", AMBER]] as const;
type Icon = typeof Heart;

/**
 * 按列堆叠：每列从上到下放几块，列与列之间卡片高矮不同，横向接缝自然错开；
 * 各列等高，多出来的高度分给每块里的图形，所以底边对齐、中间不留空。
 */
const COLUMNS: Array<{ span: number; keys: string[] }> = [
  { span: 3, keys: ["profile", "topics", "length", "insights"] },
  { span: 4, keys: ["heat", "months", "calendar", "matrix"] },
  { span: 3, keys: ["attention", "contacts", "creators", "evidence", "log"] },
  { span: 2, keys: ["hours", "emojis", "kept", "chat", "format"] },
];

/**
 * 持续报告：一面错落堆叠的图形卡片墙。和故事页同源的 ReportModel 全部画出来，
 * 文字只留标题、数值和名字；每块用不同的图形，按格子实际尺寸撑满，进场时依次浮起、描线。
 */
export function ReportDashboard({ chatConversations = [], chatMessages = [], mobile, model, onOpenRecord, privacy, records, width }: ReportDashboardProps) {
  const extras = React.useMemo(() => buildDashboardExtras(records, chatMessages, chatConversations), [chatConversations, chatMessages, records]);
  const pcts = model.progressPercents;
  const reached = (min: number) => (pcts.length ? pcts.filter((value) => value >= min).length / pcts.length * 100 : null);
  const recent = [...new Map(model.recent.map((item) => [`${item.title}:${item.time}`, item])).values()].slice(0, 3);
  const mode = mobile ? "stack" : width < 1120 ? "narrow" : "wide";

  const panels: Record<string, React.ReactNode> = {
    profile: (
      <Panel glow={0.26} icon={Fingerprint} id="profile" title="画像" tone={BLUE}>
        <Text numberOfLines={1} style={styles.profile}>{model.profile}</Text>
        <Text numberOfLines={1} style={styles.profileEn}>{model.profileEnglish}</Text>
        <Fill minHeight={150}>{(w, h, t) => <RadarChart axes={model.axes} h={h} t={t} w={w} />}</Fill>
      </Panel>
    ),
    heat: (
      <Panel icon={Flame} id="heat" meta={model.peakHour === null ? undefined : `峰值 ${pad(model.peakHour)}:00`} title="一周热力" tone={AMBER}>
        <HeatGrid heatmap={model.heatmap} />
      </Panel>
    ),
    attention: (
      <Panel icon={Target} id="attention" meta={`重播 ${model.watch ? Math.round(model.replays / model.watch * 100) : 0}%`} title="停留" tone={GREEN}>
        <View style={styles.split}>
          <Ring label={pctLabel(model.completion)} size={86} value={model.completion} />
          <Funnel steps={[["开始", pcts.length ? 100 : null], ["继续", reached(25)], ["深度", reached(60)], ["看完", reached(90)]]} />
        </View>
      </Panel>
    ),
    hours: (
      <Panel icon={Clock} id="hours" title="24 小时" tone={BLUE}>
        <Fill minHeight={150}>{(w, h, t) => <ClockChart chat={model.chatHours} h={h} peak={model.peakHour} t={t} w={w} watch={model.hours} />}</Fill>
      </Panel>
    ),
    topics: (
      <Panel icon={LayoutGrid} id="topics" meta={`${model.topics.length} 个`} title="主题" tone={GREEN}>
        <Treemap items={model.topics.slice(0, 8).map((topic, index) => ({ name: privacy ? `话题 ${index + 1}` : topic.name, count: topic.count }))} />
      </Panel>
    ),
    months: (
      <Panel icon={TrendingUp} id="months" title="全年起伏" tone={BLUE}>
        <Fill minHeight={120}>{(w, h, t) => <MonthLine h={h} months={model.months} peak={model.peakMonth} t={t} w={w} />}</Fill>
      </Panel>
    ),
    creators: (
      <Panel icon={Users} id="creators" meta={`前三 ${pctLabel(model.creatorFocus.concentration)} · 新面孔 ${pctLabel(model.creatorFocus.discovery)}`} title="创作者" tone={AMBER}>
        <Fill minHeight={56}>{(w, h, t) => <TailCurve h={h} t={t} values={[...model.creators.slice(0, 3).map((creator) => creator.count), ...model.creatorFocus.tail]} w={w} />}</Fill>
        {model.creators.slice(0, 3).map((creator, index) => {
          const name = privacy ? `创作者 ${index + 1}` : creator.name;
          return (
            <View key={`${creator.name}:${index}`} style={styles.line}>
              <Avatar index={index} name={name} privacy={privacy} size={22} tone={PALETTE[index]!} uri={extras.creatorAvatars[creator.name]} />
              <Text numberOfLines={1} style={[styles.text, styles.grow]}>{name}</Text>
              <Text style={styles.num}>{fmt(creator.count)}</Text>
            </View>
          );
        })}
      </Panel>
    ),
    contacts: (
      <Panel icon={MessagesSquare} id="contacts" meta={extras.contacts.length ? `${extras.contacts.length} 位` : undefined} title="常聊" tone={GREEN}>
        <Contacts contacts={extras.contacts} privacy={privacy} />
      </Panel>
    ),
    emojis: (
      <Panel icon={Smile} id="emojis" meta={extras.emojis.length ? `${fmt(sum(extras.emojis.map((emoji) => emoji.count)))} 次` : undefined} title="常用表情" tone={AMBER}>
        <EmojiCloud emojis={extras.emojis} />
      </Panel>
    ),
    kept: (
      <Panel icon={Heart} id="kept" title="留下的" tone={RED}>
        <Fill minHeight={150}>{(w, h, t) => <Venn h={h} model={model} t={t} w={w} />}</Fill>
        {extras.keptCovers.length ? (
          <View style={styles.coverRow}>
            {extras.keptCovers.map((uri, index) => <Cover index={index} key={uri} privacy={privacy} uri={uri} />)}
          </View>
        ) : null}
      </Panel>
    ),
    calendar: (
      <Panel icon={CalendarDays} id="calendar" meta={`${fmt(model.activeDays)} 天`} title="年历" tone={BLUE}>
        <Calendar calendar={model.calendar} months={model.months} peak={model.peakMonth} />
      </Panel>
    ),
    evidence: (
      <Panel icon={ShieldCheck} id="evidence" meta={`${Math.round(model.reliableRatio * 100)}% 可靠`} title="证据覆盖" tone={GREEN}>
        {EVIDENCE.map(([key, label, tone]) => <EvidenceLine key={key} label={label} row={model.evidence[key]} tone={tone} />)}
      </Panel>
    ),
    chat: (
      <Panel icon={MessageCircle} id="chat" meta={model.chatGroups.length ? `群聊 ${model.chatGroups.length}` : undefined} title="聊天" tone={GREEN}>
        <View style={styles.split}>
          <Donut center={model.chat ? fmt(model.chat) : "—"} size={70} slices={model.chatKinds.slice(0, 5).map((kind) => kind.share)} />
          <View style={styles.legendList}>
            {model.chatKinds.slice(0, 5).map((kind, index) => <LegendRow key={kind.name} label={kind.name} tone={PALETTE[index]!} value={kind.share * 100} />)}
            {model.chatKinds.length ? null : <Empty text="还没有聊天" />}
          </View>
        </View>
        <SlotGrid rows={model.chatSlots} />
      </Panel>
    ),
    length: (
      <Panel icon={Timer} id="length" title="时长" tone={AMBER}>
        <Fill minHeight={96}>{(w, h, t) => <Lollipops h={h} items={model.durationBands.map((band) => ({ label: band.label, share: band.share ?? 0 }))} t={t} w={w} />}</Fill>
      </Panel>
    ),
    format: (
      <Panel icon={Shapes} id="format" title="形态" tone={RED}>
        <Fill minHeight={70}>{(w, h, t) => <Waffle h={h} shares={model.formats.slice(0, 4).map((format) => format.share)} t={t} w={w} />}</Fill>
        <View style={styles.legendInline}>
          {model.formats.slice(0, 4).map((format, index) => <LegendRow key={format.name} label={format.name} tone={PALETTE[index]!} value={format.share * 100} />)}
        </View>
      </Panel>
    ),
    matrix: (
      <Panel icon={Grid3x3} id="matrix" meta={`${model.cross.days} 天`} title="交叉矩阵" tone={BLUE}>
        <Matrix labels={model.cross.labels} matrix={model.cross.matrix} />
      </Panel>
    ),
    insights: (
      <Panel icon={Sparkles} id="insights" meta={`${model.surprises.filter((insight) => insight.status === "observed").length}/${model.surprises.length}`} title="洞察" tone={AMBER}>
        <View style={styles.rows}>
          {model.surprises.map((insight) => (
            <Pill key={insight.id} kind={insight.status === "observed" ? "on" : "off"} text={insight.title} tone={GREEN} />
          ))}
          {model.cross.patterns.map((pattern) => <Pill key={pattern.title} kind="link" text={pattern.title} tone={BLUE} />)}
        </View>
      </Panel>
    ),
    log: (
      <Panel icon={History} id="log" title="最近" tone={RED}>
        {extras.covers.length ? (
          <View style={styles.coverRow}>
            {extras.covers.slice(0, 5).map((cover, index) => (
              <Pressable
                accessibilityLabel={privacy ? `内容 ${index + 1}` : cover.title}
                disabled={!cover.url || privacy}
                key={cover.coverUrl}
                onPress={() => cover.url && void onOpenRecord(cover.url)}
                style={styles.coverSlot}
              >
                <Cover index={index} privacy={privacy} uri={cover.coverUrl} />
              </Pressable>
            ))}
          </View>
        ) : null}
        <Fill minHeight={34}>{(w, h, t) => <Timeline events={model.events} h={h} t={t} w={w} />}</Fill>
        {recent.map((item, index) => {
          const canOpen = Boolean(item.url && !privacy);
          return (
            <Pressable
              accessibilityLabel={`${privacy ? `内容 ${index + 1}` : item.title}${canOpen ? "，打开记录" : ""}`}
              accessibilityRole={canOpen ? "link" : undefined}
              disabled={!canOpen}
              key={`${item.title}:${index}`}
              onPress={() => item.url && void onOpenRecord(item.url)}
              style={styles.line}
            >
              <View style={[styles.dot, { backgroundColor: BLUE }]} />
              <Text style={styles.time}>{formatTime(item.time)}</Text>
              <Text numberOfLines={1} style={[styles.text, styles.grow, canOpen && styles.link]}>{privacy ? `内容 ${index + 1}` : item.title}</Text>
            </Pressable>
          );
        })}
      </Panel>
    ),
  };

  return (
    <ScrollView contentContainerStyle={[styles.content, mobile && styles.contentMobile]} showsVerticalScrollIndicator={false} style={styles.screen} testID="report-terminal">
      <View style={styles.board}>
        <Kpis columns={mode === "wide" ? 10 : 5} model={model} />
        <Columns mode={mode} panels={panels} />
        <Footer model={model} />
      </View>
    </ScrollView>
  );
}

/* ---------- 版面 ---------- */

function Columns({ mode, panels }: { mode: "wide" | "narrow" | "stack"; panels: Record<string, React.ReactNode> }) {
  // 窄屏把四列两两并成两列：第一、三列一组，第二、四列一组，宽窄搭配各占一半
  const columns = mode === "wide"
    ? COLUMNS
    : mode === "narrow"
      ? [{ span: 1, keys: [...COLUMNS[0]!.keys, ...COLUMNS[2]!.keys] }, { span: 1, keys: [...COLUMNS[1]!.keys, ...COLUMNS[3]!.keys] }]
      : [{ span: 1, keys: COLUMNS.flatMap((column) => column.keys) }];
  // 进场顺序按行扫：先每列第一块，再每列第二块，看起来是一层一层浮上来
  const order = new Map<string, number>();
  for (let depth = 0, n = 0; depth < 8; depth += 1) {
    for (const column of columns) if (column.keys[depth]) order.set(column.keys[depth]!, (n += 1));
  }
  return (
    <View style={styles.row}>
      {columns.map((column) => (
        <View key={column.keys[0]} style={[styles.column, { flexGrow: column.span }]}>
          {column.keys.map((key) => (
            <View key={key} {...fx({ motion: "rise", i: order.get(key) })} style={styles.slot}>{panels[key]}</View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Panel({ children, glow = 0.12, icon, id, meta, title, tone }: {
  children: React.ReactNode;
  glow?: number;
  icon: Icon;
  id: string;
  meta?: string;
  title: string;
  tone: string;
}) {
  return (
    <View {...fx({ hover: "lift" })} style={styles.panel} testID={`report-panel-${id}`}>
      <Glow strength={glow} tone={tone} />
      <View style={styles.head}>
        <Chip icon={icon} tone={tone} />
        <Text style={styles.title}>{title}</Text>
        <View style={styles.grow} />
        {meta ? <Text numberOfLines={1} style={styles.meta}>{meta}</Text> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** 卡片右上角的一团主色光晕。 */
function Glow({ strength, tone }: { strength: number; tone: string }) {
  const id = useGradientId();
  return (
    <View pointerEvents="none" style={styles.layer}>
      <Svg height="100%" width="100%">
        <Defs>
          <RadialGradient cx="100%" cy="0%" id={id} r="80%">
            <Stop offset="0" stopColor={tone} stopOpacity={strength} />
            <Stop offset="1" stopColor={tone} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect fill={`url(#${id})`} height="100%" width="100%" />
      </Svg>
    </View>
  );
}

function Chip({ icon: IconMark, size = 22, tone }: { icon: Icon; size?: number; tone: string }) {
  return (
    <View style={[styles.chip, { width: size, height: size, backgroundColor: alpha(tone, 0.14) }]}>
      <IconMark color={tone} size={Math.round(size * 0.56)} strokeWidth={2.2} />
    </View>
  );
}

/**
 * 量出格子剩下的宽高再画图，并给出进场进度 t（0→1）。图形绝对定位，不反过来撑大格子，
 * 所以量一次就稳定，不会像旧瀑布流那样测量和排布互相推着来回跳。
 */
function Fill({ children, minHeight }: { children: (w: number, h: number, t: number) => React.ReactNode; minHeight: number }) {
  const [ref, t] = useDraw<View>(1100);
  const [size, setSize] = React.useState<[number, number]>([0, 0]);
  return (
    <View
      onLayout={(event) => {
        const { height, width } = event.nativeEvent.layout;
        setSize((current) => (Math.abs(current[0] - width) < 1 && Math.abs(current[1] - height) < 1 ? current : [width, height]));
      }}
      ref={ref}
      style={[styles.fill, { minHeight }]}
    >
      {size[0] > 0 && size[1] > 0 ? <View style={styles.cover}>{children(Math.floor(size[0]), Math.floor(size[1]), t)}</View> : null}
    </View>
  );
}

// SVG 渐变要全页唯一的 id；React 的 useId 带冒号，放进 url(#…) 不好使，所以自己数
let gradientSeq = 0;
function useGradientId(): string {
  const ref = React.useRef("");
  if (!ref.current) ref.current = `report-g${(gradientSeq += 1)}`;
  return ref.current;
}

function Fade({ id, tone, top = 0.35 }: { id: string; tone: string; top?: number }) {
  return (
    <LinearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <Stop offset="0" stopColor={tone} stopOpacity={top} />
      <Stop offset="1" stopColor={tone} stopOpacity={0} />
    </LinearGradient>
  );
}

/** 一条平滑曲线从左往右描出来；曲线比折线长一点，乘个系数免得描不到头。 */
function Stroke({ d, points, t, tone, width = 1.6 }: { d: string; points: Array<[number, number]>; t: number; tone: string; width?: number }) {
  const length = polylineLength(points) * 1.1;
  return <Path d={d} fill="none" stroke={tone} strokeDasharray={`${length} ${length}`} strokeDashoffset={length * (1 - t)} strokeLinecap="round" strokeWidth={width} />;
}

function Kpis({ columns, model }: { columns: number; model: ReportModel }) {
  const weekdays = WEEK.map((_, day) => sum(model.heatmap.slice(day * 24, day * 24 + 24)));
  const cells: Array<{ label: string; icon: Icon; tone: string; value: number | string; spark?: number[]; part?: number }> = [
    { label: "活跃天数", icon: CalendarRange, tone: BLUE, value: model.activeDays, part: model.activeDays / 365 },
    { label: "观测事件", icon: Activity, tone: AMBER, value: model.total + model.chat, spark: model.months },
    { label: "去重内容", icon: Layers, tone: GREEN, value: model.unique, part: model.watch ? model.unique / model.watch : 0 },
    { label: "观看", icon: Eye, tone: BLUE, value: model.watch, spark: model.hours },
    { label: "喜欢", icon: Heart, tone: RED, value: model.liked, part: model.liked ? model.intersection.watchLiked / model.liked : 0 },
    { label: "收藏", icon: Bookmark, tone: AMBER, value: model.favorite, part: model.favorite ? model.intersection.watchFavorite / model.favorite : 0 },
    { label: "聊天", icon: MessageCircle, tone: GREEN, value: model.chat, spark: model.chatHours },
    { label: "创作者", icon: Users, tone: AMBER, value: model.creatorsCount, spark: model.creatorFocus.tail },
    { label: "注意力", icon: Hourglass, tone: BLUE, value: attentionLabel(model.attentionSeconds), spark: weekdays },
    { label: "完成度", icon: ChartPie, tone: GREEN, value: pctLabel(model.completion), part: (model.completion ?? 0) / 100 },
  ];
  return (
    <View {...fx({ motion: "fade" })} style={styles.kpiBand} testID="report-panel-kpis">
      {chunk(cells, columns).map((line, row) => (
        <View key={row} style={[styles.kpiLine, row > 0 && styles.kpiLineNext]}>
          {line.map((cell, index) => (
            <View key={cell.label} {...fx({ motion: "rise", i: index + 1 })} style={[styles.kpi, index > 0 && styles.kpiDivider]}>
              <View style={styles.line}>
                <Chip icon={cell.icon} size={18} tone={cell.tone} />
                <Text numberOfLines={1} style={styles.label}>{cell.label}</Text>
              </View>
              <Figure value={cell.value} />
              {cell.spark
                ? <Fill minHeight={18}>{(w, h, t) => <Spark h={h} t={t} tone={cell.tone} values={cell.spark!} w={w} />}</Fill>
                : <Meter tone={cell.tone} value={cell.part ?? 0} />}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Figure({ value }: { value: number | string }) {
  const count = useCountUp(typeof value === "number" ? value : 0);
  return <Text numberOfLines={1} style={styles.kpiValue}>{typeof value === "number" ? (value ? fmt(count) : "—") : value}</Text>;
}

function Meter({ tone, value }: { tone: string; value: number }) {
  const [ref, t] = useDraw<View>(1000);
  const r = Math.max(0, Math.min(1, value)) * t;
  return (
    <View ref={ref} style={styles.meter}>
      <View style={{ flexGrow: r, borderRadius: 3, backgroundColor: tone }} />
      <View style={{ flexGrow: 1 - r }} />
    </View>
  );
}

function Footer({ model }: { model: ReportModel }) {
  const complete = model.status === "ok" && model.reliableRatio >= 1;
  const tone = complete ? color.signal : color.amber;
  return (
    <View style={styles.footer} testID="report-panel-boundary">
      <View style={[styles.badge, { backgroundColor: alpha(tone, 0.14) }]}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={[styles.badgeText, { color: tone }]}>{complete ? "样本完整" : "部分样本"}</Text>
      </View>
      <Text numberOfLines={1} style={styles.label}>
        {model.period} · {fmt(model.dated)}/{fmt(model.total)} 条带可靠时间
        {model.warnings[0] ? <Text style={styles.warn}>{`  ${model.warnings[0]}`}</Text> : null}
      </Text>
    </View>
  );
}

/* ---------- 图形 ---------- */

/** 读数格底部的渐变小面积线，末端点一下。 */
function Spark({ h, t, tone, values, w }: { h: number; t: number; tone: string; values: number[]; w: number }) {
  const id = useGradientId();
  const max = Math.max(0, ...values);
  if (!max || values.length < 2) return null;
  const points = values.map((value, index) => [index / (values.length - 1) * (w - 3), h - 2 - value / max * (h - 4)] as [number, number]);
  const line = smoothPath(points, h);
  const end = points[points.length - 1]!;
  return (
    <Svg height={h} width={w}>
      <Defs><Fade id={id} tone={tone} top={0.4 * t} /></Defs>
      <Path d={`${line} L ${end[0]} ${h} L 0 ${h} Z`} fill={`url(#${id})`} />
      <Stroke d={line} points={points} t={t} tone={tone} width={1.4} />
      <Circle cx={end[0]} cy={end[1]} fill={tone} opacity={t} r={2} />
    </Svg>
  );
}

function RadarChart({ axes, h, t, w }: { axes: ReportModel["axes"]; h: number; t: number; w: number }) {
  const id = useGradientId();
  const cx = w / 2;
  const cy = h / 2 + 2;
  // 轴名写在 1.22 倍半径外，再留出两行字的高度
  const r = Math.max(12, Math.min(w / 2 - 30, (h / 2 - 16) / 1.22));
  const at = (index: number, k: number): [number, number] => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / axes.length;
    return [cx + Math.cos(angle) * r * k, cy + Math.sin(angle) * r * k];
  };
  // 网格用圆环而不是五边形，图形本身仍是多边形
  const values = axes.map((axis) => Math.max(0.06, (axis.value ?? 0) / 100) * t);
  const shape = `M${axes.map((_, index) => at(index, Math.max(0.02, values[index]!)).map((n) => n.toFixed(1)).join(" ")).join("L")}Z`;
  return (
    <Svg height={h} width={w}>
      <Defs>
        <RadialGradient cx="50%" cy="50%" id={id} r="50%">
          <Stop offset="0" stopColor={BLUE} stopOpacity={0.12} />
          <Stop offset="1" stopColor={BLUE} stopOpacity={0.5} />
        </RadialGradient>
      </Defs>
      {[1, 2 / 3, 1 / 3].map((k) => <Circle cx={cx} cy={cy} fill={BLUE} fillOpacity={0.035} key={k} r={r * k} stroke={color.border} strokeDasharray={k === 1 ? undefined : "2 3"} strokeWidth={1} />)}
      {axes.map((axis, index) => {
        const [x, y] = at(index, 1);
        return <Line key={axis.label} stroke={color.borderSoft} strokeWidth={1} x1={cx} x2={x} y1={cy} y2={y} />;
      })}
      <Path d={shape} fill={`url(#${id})`} stroke={BLUE} strokeLinejoin="round" strokeWidth={1.8} />
      {axes.map((axis, index) => {
        const [x, y] = at(index, Math.max(0.02, values[index]!));
        return <Circle cx={x} cy={y} fill={color.surface} key={axis.label} r={2.8} stroke={BLUE} strokeWidth={1.6} />;
      })}
      {axes.map((axis, index) => {
        const [x, y] = at(index, 1.22);
        const anchor = Math.abs(x - cx) < 4 ? "middle" : x > cx ? "start" : "end";
        return (
          <React.Fragment key={axis.label}>
            <SvgText fill={color.textMuted} fontSize={9} textAnchor={anchor} x={x} y={y - 1}>{axis.label}</SvgText>
            <SvgText fill={BLUE} fontSize={9.5} fontWeight="700" textAnchor={anchor} x={x} y={y + 9}>{axis.value === null ? "—" : Math.round(axis.value)}</SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

/** 周 × 小时圆点；点的大小和颜色都跟着量走，右边是每天合计，下面是每小时合计。 */
function HeatGrid({ heatmap }: { heatmap: number[] }) {
  const [ref, t] = useDraw<View>(1000);
  const max = Math.max(0, ...heatmap);
  const peak = max ? heatmap.indexOf(max) : -1;
  const hours = Array.from({ length: 24 }, (_, hour) => sum(WEEK.map((_, day) => heatmap[day * 24 + hour] ?? 0)));
  const hourMax = Math.max(0, ...hours);
  return (
    <View ref={ref} style={styles.grow}>
      <View style={styles.grid}>
        {WEEK.map((letter, day) => (
          <View key={letter} style={styles.gridRow}>
            <Text style={styles.gridLabel}>{letter}</Text>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = heatmap[day * 24 + hour] ?? 0;
              // 从左往右一列列亮起来
              const shown = Math.max(0, Math.min(1, t * 1.6 - hour / 24 * 0.6));
              return <Dot key={hour} peak={day * 24 + hour === peak} ratio={max ? value / max : 0} tone={HEAT[heatStep(value, max)]!} visible={shown} />;
            })}
            <Text style={styles.gridSum}>{fmt(sum(heatmap.slice(day * 24, day * 24 + 24)))}</Text>
          </View>
        ))}
      </View>
      <View style={styles.hourBars}>
        <View style={{ width: LABEL_W }} />
        {hours.map((value, hour) => <Col key={hour} ratio={hourMax ? value / hourMax * t : 0} tone={peak % 24 === hour ? AMBER : alpha(AMBER, 0.4)} />)}
        <View style={{ width: SUM_W }} />
      </View>
      <View style={[styles.axis, { marginLeft: LABEL_W + 2, marginRight: SUM_W + 2 }]}>
        {["00", "06", "12", "18", "23"].map((label) => <Text key={label} style={styles.axisText}>{label}</Text>)}
      </View>
    </View>
  );
}

/** 热力里的一颗圆点：量越大点越满，空的格子只剩一个淡淡的小点。 */
function Dot({ peak, ratio, tone, visible }: { peak?: boolean; ratio: number; tone: string; visible: number }) {
  const size = ratio > 0 ? 50 + ratio * 50 : 34;
  return (
    <View style={styles.dotCell}>
      <View style={[styles.dotFill, { width: `${size}%`, backgroundColor: tone, opacity: visible }, peak && styles.dotPeak]} />
    </View>
  );
}

/** 一根竖条：上面的空白和下面的柱子按比例分高度。 */
function Col({ ratio, tone }: { ratio: number; tone: string }) {
  const r = Math.max(0, Math.min(1, ratio));
  return (
    <View style={styles.barSlot}>
      <View style={{ flexGrow: 1 - r }} />
      <View style={[styles.barCap, { flexGrow: r, minHeight: r > 0 ? 1 : 0, backgroundColor: tone }]} />
    </View>
  );
}

/** 渐变圆环：绿过渡到蓝，中间写完成度。 */
function Ring({ label, size, value }: { label: string; size: number; value: number | null }) {
  const id = useGradientId();
  const [ref, t] = useDraw<View>(1200);
  const r = size / 2 - 6;
  const circumference = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value)) * t;
  return (
    <View ref={ref} style={{ width: size, height: size, alignSelf: "center" }}>
      <Svg height={size} width={size}>
        <Defs>
          <LinearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            <Stop offset="0" stopColor={GREEN} />
            <Stop offset="1" stopColor={BLUE} />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} fill={alpha(GREEN, 0.06)} r={r} stroke={color.surfaceMuted} strokeWidth={9} />
        {value === null ? null : (
          <Circle cx={size / 2} cy={size / 2} fill="none" r={r} stroke={`url(#${id})`} strokeDasharray={`${circumference * pct / 100} ${circumference}`} strokeLinecap="round" strokeWidth={9} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </Svg>
      <View style={styles.cover}><Text style={styles.ringValue}>{label}</Text></View>
    </View>
  );
}

/** 居中收窄的漏斗：每一档的宽度就是到达这一档的比例，越往下颜色越深。 */
function Funnel({ steps }: { steps: Array<[string, number | null]> }) {
  const [ref, t] = useDraw<View>(1000);
  return (
    <View ref={ref} style={styles.funnel}>
      {steps.map(([label, value], index) => (
        <View key={label} style={styles.funnelRow}>
          <Text style={styles.funnelLabel}>{label}</Text>
          <View style={styles.funnelTrack}>
            <View style={{ width: `${value === null ? 0 : Math.max(2, value) * t}%`, borderRadius: 99, backgroundColor: alpha(GREEN, 0.3 + index * 0.23) }} />
          </View>
          <Text style={styles.num}>{pctLabel(value)}</Text>
        </View>
      ))}
    </View>
  );
}

/** 24 小时环形钟：外圈扇条是内容量，内圈小点是聊天，中间写峰值时刻。 */
function ClockChart({ chat, h, peak, t, w, watch }: { chat: number[]; h: number; peak: number | null; t: number; w: number; watch: number[] }) {
  const id = useGradientId();
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.max(16, Math.min(w, h) / 2 - 12);
  const inner = outer * 0.42;
  const max = Math.max(0, ...watch);
  const chatMax = Math.max(0, ...chat);
  const angle = (hour: number) => -Math.PI / 2 + hour / 24 * 2 * Math.PI;
  const point = (r: number, a: number) => `${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`;
  const wedge = (hour: number, r: number) => {
    const a0 = angle(hour - 0.4);
    const a1 = angle(hour + 0.4);
    return `M${point(inner, a0)}L${point(r, a0)}A${r} ${r} 0 0 1 ${point(r, a1)}L${point(inner, a1)}A${inner} ${inner} 0 0 0 ${point(inner, a0)}Z`;
  };
  return (
    <Svg height={h} width={w}>
      <Defs>
        <RadialGradient cx="50%" cy="50%" id={id} r="50%">
          <Stop offset="0.4" stopColor={BLUE} stopOpacity={0} />
          <Stop offset="1" stopColor={BLUE} stopOpacity={0.1} />
        </RadialGradient>
      </Defs>
      <Circle cx={cx} cy={cy} fill={`url(#${id})`} r={outer} stroke={color.borderSoft} strokeWidth={1} />
      {watch.map((value, hour) => (value > 0 && max ? (
        <Path d={wedge(hour, inner + 1 + (outer - inner - 1) * value / max * t)} fill={hour === peak ? AMBER : BLUE} fillOpacity={hour === peak ? 1 : 0.25 + 0.6 * value / max} key={hour} />
      ) : null))}
      <Circle cx={cx} cy={cy} fill={color.surface} r={inner - 1} stroke={color.borderSoft} strokeWidth={1} />
      {chat.map((value, hour) => (value > 0 && chatMax ? (
        <Circle cx={cx + Math.cos(angle(hour)) * (inner - 7)} cy={cy + Math.sin(angle(hour)) * (inner - 7)} fill={GREEN} fillOpacity={(0.35 + 0.65 * value / chatMax) * t} key={hour} r={1 + 1.8 * value / chatMax} />
      ) : null))}
      {[0, 6, 12, 18].map((hour) => (
        <SvgText fill={color.textMuted} fontSize={8.5} key={hour} textAnchor="middle" x={cx + Math.cos(angle(hour)) * (outer + 7)} y={cy + Math.sin(angle(hour)) * (outer + 7) + 3}>{hour}</SvgText>
      ))}
      <SvgText fill={color.text} fontSize={13} fontWeight="700" opacity={t} textAnchor="middle" x={cx} y={cy + 4}>{peak === null ? "—" : `${peak}时`}</SvgText>
    </Svg>
  );
}

/** 矩形树图：按数量二分切块，面积就是占比；每块认一种强调色，大圆角、留缝。 */
function Treemap({ items }: { items: Array<{ name: string; count: number }> }) {
  if (!items.length) return <Empty text="等待主题样本" />;
  const total = sum(items.map((item) => item.count));
  const ranked = items.map((item, rank) => ({ ...item, rank }));
  const split = (group: typeof ranked, row: boolean): React.ReactNode => {
    const weight = sum(group.map((item) => item.count));
    if (group.length === 1) {
      const item = group[0]!;
      const tone = PALETTE[item.rank % 4]!;
      const roomy = item.count / total >= 0.06;
      return (
        <View key={item.name} {...fx({ motion: "pop", i: item.rank + 2 })} style={[styles.treeCell, { flexGrow: weight, backgroundColor: alpha(tone, Math.max(0.1, 0.26 - item.rank * 0.025)) }]}>
          {/* 太小的格子写不下字，只留色块 */}
          {roomy ? <Text numberOfLines={1} style={styles.treeName}>{item.name}</Text> : null}
          {roomy ? <Text numberOfLines={1} style={[styles.treeValue, { color: tone }]}>{fmt(item.count)} · {Math.round(item.count / total * 100)}%</Text> : null}
        </View>
      );
    }
    let cut = 0;
    let running = 0;
    while (cut < group.length - 1 && running + group[cut]!.count <= weight / 2) running += group[cut++]!.count;
    cut = Math.max(1, cut);
    return (
      <View key={group.map((item) => item.name).join("|")} style={[styles.treeGroup, { flexGrow: weight, flexDirection: row ? "row" : "column" }]}>
        {split(group.slice(0, cut), !row)}
        {split(group.slice(cut), !row)}
      </View>
    );
  };
  return <View style={styles.tree}>{split(ranked, true)}</View>;
}

/** 全年面积折线：虚线是月均，峰值月份打琥珀色气泡。 */
function MonthLine({ h, months, peak, t, w }: { h: number; months: number[]; peak: number | null; t: number; w: number }) {
  const id = useGradientId();
  const max = Math.max(1, ...months);
  const top = 24;
  const bottom = h - 14;
  const left = 8;
  const right = w - 8;
  const y = (value: number) => bottom - value / max * (bottom - top);
  const points = months.map((value, index) => [left + index * (right - left) / 11, y(value)] as [number, number]);
  const line = smoothPath(points, bottom);
  const mean = y(sum(months) / 12);
  const peakPoint = peak === null ? null : points[peak];
  const label = peak === null ? "" : fmt(months[peak] ?? 0);
  return (
    <Svg height={h} width={w}>
      <Defs><Fade id={id} tone={BLUE} top={0.32 * t} /></Defs>
      <Path d={`${line} L ${right} ${bottom} L ${left} ${bottom} Z`} fill={`url(#${id})`} />
      <Line stroke={color.textMuted} strokeDasharray="3 4" strokeOpacity={0.5 * t} strokeWidth={1} x1={left} x2={right} y1={mean} y2={mean} />
      <Stroke d={line} points={points} t={t} tone={BLUE} width={2.2} />
      {points.map(([x, py], index) => (index === peak ? null : <Circle cx={x} cy={py} fill={color.surface} key={index} opacity={t > index / 12 ? 1 : 0} r={2.4} stroke={BLUE} strokeWidth={1.4} />))}
      {peakPoint ? (
        <React.Fragment>
          <Circle cx={peakPoint[0]} cy={peakPoint[1]} fill={AMBER} fillOpacity={0.18 * t} r={9} />
          <Circle cx={peakPoint[0]} cy={peakPoint[1]} fill={AMBER} opacity={t} r={3.8} />
          <Rect fill={AMBER} height={15} opacity={t} rx={7.5} width={label.length * 6.5 + 12} x={peakPoint[0] - (label.length * 6.5 + 12) / 2} y={peakPoint[1] - 26} />
          <SvgText fill={color.surface} fontSize={9.5} fontWeight="700" opacity={t} textAnchor="middle" x={peakPoint[0]} y={peakPoint[1] - 15.5}>{label}</SvgText>
        </React.Fragment>
      ) : null}
      {points.map(([x], index) => <SvgText fill={index === peak ? AMBER : color.textMuted} fontSize={8.5} fontWeight={index === peak ? "700" : "400"} key={index} textAnchor="middle" x={x} y={h - 2}>{index + 1}</SvgText>)}
    </Svg>
  );
}

/** 创作者长尾：按对数刻度画出从头部到尾部的衰减。 */
function TailCurve({ h, t, values, w }: { h: number; t: number; values: number[]; w: number }) {
  const id = useGradientId();
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const scale = (value: number) => Math.log1p(Math.max(0, value)) / Math.log1p(max);
  const points = values.map((value, index) => [index / (values.length - 1) * w, h - 1 - scale(value) * (h - 7)] as [number, number]);
  const line = smoothPath(points, h);
  return (
    <Svg height={h} width={w}>
      <Defs><Fade id={id} tone={AMBER} top={0.35 * t} /></Defs>
      <Path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={`url(#${id})`} />
      <Stroke d={line} points={points} t={t} tone={AMBER} width={1.8} />
      {points.slice(0, 3).map(([x, y], index) => <Circle cx={x} cy={y} fill={PALETTE[index]} key={index} opacity={t} r={3.2} stroke={color.surface} strokeWidth={1.2} />)}
    </Svg>
  );
}

/** 三类列表的韦恩图：圆旁写类别和总数，两两重叠处写交集，中间是三类都有。 */
function Venn({ h, model, t, w }: { h: number; model: ReportModel; t: number; w: number }) {
  const r = Math.max(14, Math.min(w / 3.1, h / 2.9));
  const cx = w / 2;
  const cy = h / 2 + r * 0.12;
  // 三个圆从中间往外散开
  const k = r * 0.56 * (0.4 + 0.6 * t);
  const angles = [-90, 150, 30].map((degree) => degree * Math.PI / 180);
  const tones = [BLUE, RED, AMBER];
  const centers = angles.map((a) => [cx + Math.cos(a) * k, cy + Math.sin(a) * k] as [number, number]);
  const sets: Array<[string, number]> = [["看过", model.watch], ["喜欢", model.liked], ["收藏", model.favorite]];
  const pairs: Array<[number, number, number]> = [[0, 1, model.intersection.watchLiked], [0, 2, model.intersection.watchFavorite], [1, 2, model.intersection.likedFavorite]];
  const toward = (a: number, b: number, distance: number) => {
    const x = Math.cos(angles[a]!) + Math.cos(angles[b]!);
    const y = Math.sin(angles[a]!) + Math.sin(angles[b]!);
    const length = Math.hypot(x, y) || 1;
    return [cx + x / length * distance, cy + y / length * distance] as const;
  };
  return (
    <Svg height={h} width={w}>
      {centers.map(([x, y], index) => (
        <Circle cx={x} cy={y} fill={tones[index]} fillOpacity={0.16} key={index} r={r} stroke={tones[index]} strokeOpacity={0.8} strokeWidth={1.2} />
      ))}
      {sets.map(([name, total], index) => {
        const x = cx + Math.cos(angles[index]!) * (k + r * 0.5);
        const y = cy + Math.sin(angles[index]!) * (k + r * 0.5);
        return (
          <React.Fragment key={name}>
            <SvgText fill={tones[index]} fontSize={9} fontWeight="600" opacity={t} textAnchor="middle" x={x} y={y - 2}>{name}</SvgText>
            <SvgText fill={color.text} fontSize={10.5} fontWeight="700" opacity={t} textAnchor="middle" x={x} y={y + 10}>{fmt(total)}</SvgText>
          </React.Fragment>
        );
      })}
      {pairs.map(([a, b, value]) => {
        const [x, y] = toward(a, b, k * 0.95);
        return <SvgText fill={color.textSecondary} fontSize={9.5} key={`${a}${b}`} opacity={t} textAnchor="middle" x={x} y={y + 3}>{fmt(value)}</SvgText>;
      })}
      <Circle cx={cx} cy={cy} fill={color.surface} opacity={t} r={9} stroke={color.text} strokeWidth={1} />
      <SvgText fill={color.text} fontSize={10} fontWeight="700" opacity={t} textAnchor="middle" x={cx} y={cy + 3.5}>{fmt(model.intersection.allThree)}</SvgText>
    </Svg>
  );
}

/** 年历：每月 14 颗点的活跃度，右边一根短条是这个月的量，峰值月份用琥珀色。 */
function Calendar({ calendar, months, peak }: { calendar: number[][]; months: number[]; peak: number | null }) {
  const [ref, t] = useDraw<View>(1000);
  const max = Math.max(1, ...months);
  return (
    <View ref={ref} style={styles.grid}>
      {calendar.map((cells, month) => (
        <View key={month} style={styles.gridRow}>
          <Text style={styles.gridLabel}>{month + 1}月</Text>
          {cells.map((level, index) => (
            <Dot key={index} ratio={level / 2} tone={HEAT[level === 2 ? 4 : level === 1 ? 2 : 0]!} visible={Math.max(0, Math.min(1, t * 1.6 - month / 12 * 0.6))} />
          ))}
          <View style={styles.sumBar}>
            <View style={{ width: `${(months[month] ?? 0) / max * 100 * t}%`, borderRadius: 99, backgroundColor: month === peak ? AMBER : alpha(BLUE, 0.5) }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** 时长分档的棒棒糖图：杆高就是占比，每档一种颜色。 */
function Lollipops({ h, items, t, w }: { h: number; items: Array<{ label: string; share: number }>; t: number; w: number }) {
  const max = Math.max(0, ...items.map((item) => item.share));
  if (!max) return null;
  const slot = w / items.length;
  const top = 18;
  const bottom = h - 15;
  return (
    <Svg height={h} width={w}>
      <Line stroke={color.borderSoft} strokeWidth={1} x1={0} x2={w} y1={bottom} y2={bottom} />
      {items.map((item, index) => {
        const x = slot * (index + 0.5);
        const y = bottom - item.share / max * (bottom - top) * t;
        const tone = PALETTE[index]!;
        return (
          <React.Fragment key={item.label}>
            <Rect fill={tone} fillOpacity={0.12} height={Math.max(0, bottom - y)} rx={7} width={14} x={x - 7} y={y} />
            <Line stroke={tone} strokeLinecap="round" strokeWidth={2} x1={x} x2={x} y1={bottom} y2={y} />
            <Circle cx={x} cy={y} fill={tone} r={4.5} stroke={color.surface} strokeWidth={1.5} />
            <SvgText fill={color.text} fontSize={10} fontWeight="700" opacity={t} textAnchor="middle" x={x} y={y - 8}>{Math.round(item.share * 100)}%</SvgText>
            <SvgText fill={color.textMuted} fontSize={9} textAnchor="middle" x={x} y={h - 2}>{item.label}</SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

/** 一百颗点的华夫图，按形态占比上色，进场时一颗颗点亮。 */
function Waffle({ h, shares, t, w }: { h: number; shares: number[]; t: number; w: number }) {
  const total = sum(shares);
  if (!total) return null;
  const exact = shares.map((share) => share / total * 100);
  const counts = exact.map(Math.floor);
  // 最大余数法凑满一百格
  exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
    .slice(0, 100 - sum(counts)).forEach(({ index }) => { counts[index] = (counts[index] ?? 0) + 1; });
  const columns = Math.max(5, Math.min(25, Math.round(Math.sqrt(100 * w / h))));
  const rows = Math.ceil(100 / columns);
  const cell = Math.max(3, Math.min(w / columns, h / rows));
  const left = (w - columns * cell) / 2;
  const owner: number[] = counts.flatMap((count, index) => Array.from({ length: count }, () => index));
  const lit = Math.round(owner.length * t);
  return (
    <Svg height={h} width={w}>
      {owner.map((index, cellIndex) => (
        <Circle cx={left + (cellIndex % columns + 0.5) * cell} cy={(Math.floor(cellIndex / columns) + 0.5) * cell} fill={cellIndex < lit ? PALETTE[index] : color.surfaceMuted} key={cellIndex} r={cell * 0.38} />
      ))}
    </Svg>
  );
}

/** 饼环，中间写总数，配合旁边的图例读。 */
function Donut({ center, size, slices }: { center: string; size: number; slices: number[] }) {
  const [ref, t] = useDraw<View>(1100);
  const total = sum(slices.map((value) => Math.max(0, value)));
  const c = size / 2;
  let angle = -Math.PI / 2;
  let budget = Math.PI * 2 * t;
  return (
    <View ref={ref} style={{ width: size, height: size, alignSelf: "center" }}>
      <Svg height={size} width={size}>
        <Circle cx={c} cy={c} fill="none" r={c * 0.8} stroke={color.surfaceMuted} strokeWidth={c * 0.4} />
        {total ? slices.map((value, index) => {
          const sweep = Math.max(0, value) / total * Math.PI * 2;
          const shown = Math.max(0, Math.min(sweep, budget));
          budget -= shown;
          const from = angle + 0.025;
          angle += sweep;
          return shown > 0.06 ? <Path d={arcPath(c, c, c - 1, c * 0.6, from, from + Math.min(shown, Math.PI * 2 - 0.0001) - 0.05)} fill={PALETTE[index]} key={index} /> : null;
        }) : null}
      </Svg>
      <View style={styles.cover}><Text style={styles.donutValue}>{center}</Text></View>
    </View>
  );
}

function LegendRow({ label, tone, value }: { label: string; tone: string; value: number }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.swatch, { backgroundColor: tone }]} />
      <Text numberOfLines={1} style={styles.legendName}>{label}</Text>
      <Text style={styles.num}>{Math.round(value)}%</Text>
    </View>
  );
}

function EvidenceLine({ label, row, tone }: { label: string; row: ReportModel["evidence"]["watch"]; tone: string }) {
  const state = row.caveat.includes("awaiting") ? color.border : row.caveat.includes("partial") ? color.amber : color.signal;
  return (
    <View style={styles.evidence}>
      <View style={styles.line}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={styles.evidenceName}>{label}</Text>
        <View style={[styles.stateDot, { borderColor: state }]} />
        <Text style={[styles.num, styles.grow]}>{fmt(row.count)}</Text>
      </View>
      <View style={styles.evidenceStrip}>
        {row.months.map((value, index) => (
          <View key={index} style={[styles.pillCell, { backgroundColor: value ? alpha(tone, 0.2 + value * 0.75) : color.surfaceMuted }]} />
        ))}
      </View>
    </View>
  );
}

/** 聊天类型 × 两小时时段。 */
function SlotGrid({ rows }: { rows: ReportModel["chatSlots"] }) {
  const max = Math.max(0, ...rows.flatMap((row) => row.slots));
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row.id} style={styles.gridRow}>
          <Text numberOfLines={1} style={styles.gridLabel}>{row.label}</Text>
          {row.slots.map((value, index) => <Dot key={index} ratio={max ? value / max : 0} tone={value && max ? alpha(GREEN, 0.2 + value / max * 0.8) : color.surfaceMuted} visible={1} />)}
        </View>
      ))}
    </View>
  );
}

/** 相关矩阵：圆点大小是关系强弱，正相关蓝、负相关红，数值写在点上。 */
function Matrix({ labels, matrix }: { labels: string[]; matrix: Array<Array<number | null>> }) {
  if (!matrix.length) return <Empty text="观测日还不够" />;
  return (
    <View style={styles.grid}>
      {matrix.map((row, rowIndex) => (
        <View key={labels[rowIndex] ?? rowIndex} style={styles.gridRow}>
          <Text numberOfLines={1} style={styles.matrixLabel}>{labels[rowIndex]?.slice(0, 2)}</Text>
          {row.map((value, index) => {
            const self = index === rowIndex;
            const strength = value === null || self ? 0 : Math.abs(value);
            return (
              <View key={index} style={styles.matrixCell}>
                <View style={[styles.matrixBubble, {
                  width: `${self ? 18 : 34 + strength * 66}%`,
                  backgroundColor: self || value === null ? color.surfaceMuted : alpha(value >= 0 ? BLUE : RED, 0.18 + strength * 0.75),
                }]} />
                <Text style={[styles.matrixValue, strength >= 0.45 && { color: color.surface, fontWeight: "700" }]}>{self || value === null ? "" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2).slice(1)}`}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** 洞察一条一枚药丸：实心点是已经观察到，空心是还在等，菱形是交叉关联。 */
function Pill({ kind, text, tone }: { kind: "on" | "off" | "link"; text: string; tone: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: kind === "off" ? color.surfaceMuted : alpha(tone, 0.09) }]}>
      <View style={[styles.dot, kind === "on" && { backgroundColor: tone }, kind === "off" && styles.dotOff, kind === "link" && { borderRadius: 1, backgroundColor: tone, transform: [{ rotate: "45deg" }] }]} />
      <Text numberOfLines={1} style={[styles.text, styles.grow, kind === "off" && styles.off]}>{text}</Text>
    </View>
  );
}

/** 一天的事件时间轴：按时刻落点，颜色分观看 / 聊天 / 收藏点赞。 */
function Timeline({ events, h, t, w }: { events: ReportModel["events"]; h: number; t: number; w: number }) {
  const y = h / 2 - 4;
  const x = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return 7 + ((hour ?? 0) * 60 + (minute ?? 0)) / 1440 * (w - 14);
  };
  return (
    <Svg height={h} width={w}>
      <Rect fill={BLUE} fillOpacity={0.07} height={14} rx={7} width={w - 4} x={2} y={y - 7} />
      {[0, 6, 12, 18, 24].map((hour) => (
        <SvgText fill={color.textMuted} fontSize={8} key={hour} textAnchor="middle" x={7 + hour / 24 * (w - 14)} y={h - 1}>{hour}</SvgText>
      ))}
      {events.map((event, index) => <Circle cx={x(event.time)} cy={y} fill={KIND_TONE[event.kind]} key={index} r={3.8 * t} stroke={color.surface} strokeWidth={1.2} />)}
    </Svg>
  );
}

/** 圆头像：有安全的头像地址就显示图片，隐私模式或加载失败退回首字 / 序号。 */
function Avatar({ index, name, privacy, ring = false, size, tone, uri }: { index: number; name: string; privacy: boolean; ring?: boolean; size: number; tone: string; uri?: string | null }) {
  const [failed, setFailed] = React.useState(false);
  const safe = privacy || failed ? null : safeChatAvatarUrl(uri);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(tone, 0.16) }, ring && styles.avatarRing]}>
      {safe
        ? <Image accessibilityLabel={name} onError={() => setFailed(true)} resizeMode="cover" source={{ uri: safe }} style={{ width: size, height: size, borderRadius: size / 2 }} />
        : <Text style={[styles.avatarText, { color: tone, fontSize: size * 0.44 }]}>{privacy || !name ? index + 1 : name.slice(0, 1).toUpperCase()}</Text>}
    </View>
  );
}

/** 视频封面小图；隐私模式下只留一块主题色。 */
function Cover({ index, privacy, uri }: { index: number; privacy: boolean; uri: string }) {
  const [failed, setFailed] = React.useState(false);
  const tone = PALETTE[index % 4]!;
  return (
    <View style={[styles.cover34, { backgroundColor: alpha(tone, 0.18) }]}>
      {privacy || failed ? null : <Image onError={() => setFailed(true)} resizeMode="cover" source={{ uri }} style={styles.coverImage} />}
    </View>
  );
}

/** 常聊：头像、名字、双方消息比例条（深色是你发的），条长按消息量。 */
function Contacts({ contacts, privacy }: { contacts: Array<{ id: string; name: string; avatarUrl: string | null; messages: number; own: number }>; privacy: boolean }) {
  const [ref, t] = useDraw<View>(1000);
  if (!contacts.length) return <Empty text="还没有单聊记录" />;
  const top = Math.max(1, ...contacts.map((contact) => contact.messages));
  return (
    <View ref={ref} style={styles.rows}>
      <View style={styles.avatarStack}>
        {contacts.map((contact, index) => (
          <View key={contact.id} style={[styles.stackItem, { zIndex: contacts.length - index }]}>
            <Avatar index={index} name={contact.name} privacy={privacy} ring size={index === 0 ? 34 : 28} tone={PALETTE[index % 4]!} uri={contact.avatarUrl} />
          </View>
        ))}
        <View style={styles.grow} />
        <View style={styles.legendRow}><View style={[styles.swatch, { backgroundColor: GREEN }]} /><Text style={styles.label}>我</Text></View>
        <View style={styles.legendRow}><View style={[styles.swatch, { backgroundColor: alpha(GREEN, 0.3) }]} /><Text style={styles.label}>对方</Text></View>
      </View>
      {contacts.map((contact, index) => {
        const ownShare = contact.messages ? contact.own / contact.messages : 0;
        return (
          <View key={contact.id} style={styles.line}>
            <Text numberOfLines={1} style={styles.contactName}>{privacy ? `好友 ${index + 1}` : contact.name || `好友 ${index + 1}`}</Text>
            <View style={styles.contactTrack}>
              <View style={[styles.contactBar, { width: `${contact.messages / top * 100 * t}%` }]}>
                <View style={{ flexGrow: ownShare, backgroundColor: GREEN }} />
                <View style={{ flexGrow: 1 - ownShare, backgroundColor: alpha(GREEN, 0.3) }} />
              </View>
            </View>
            <Text style={styles.num}>{fmt(contact.messages)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** 常用表情云：越常用越大，最常用的那个套一圈并写次数。 */
function EmojiCloud({ emojis }: { emojis: Array<{ code: string; url: string; count: number }> }) {
  if (!emojis.length) return <Empty text="还没用过小表情" />;
  const max = Math.max(1, ...emojis.map((emoji) => emoji.count));
  return (
    <View style={styles.cloud}>
      {emojis.map((emoji, index) => {
        const size = Math.round(16 + 18 * Math.sqrt(emoji.count / max));
        return (
          <View key={emoji.code} {...fx({ motion: "pop", i: index + 1 })} style={[styles.emojiItem, index === 0 && styles.emojiTop]}>
            <Image accessibilityLabel={emoji.code} source={{ uri: emoji.url }} style={{ width: size, height: size }} />
            <Text style={[styles.emojiCount, index === 0 && { color: AMBER, fontWeight: "700" }]}>{index === 0 ? `×${fmt(emoji.count)}` : fmt(emoji.count)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

/* ---------- 小工具 ---------- */

function heatStep(value: number, max: number): number {
  return value === 0 || !max ? 0 : Math.min(HEAT.length - 1, 1 + Math.floor(value / max * (HEAT.length - 1.001)));
}

function arcPath(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const at = (r: number, angle: number) => `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`;
  const large = to - from > Math.PI ? 1 : 0;
  return `M ${at(outer, from)} A ${outer} ${outer} 0 ${large} 1 ${at(outer, to)} L ${at(inner, to)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, from)} Z`;
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime(value: string | null): string {
  if (!value) return "--/--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--/--";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

const bodyType = { fontFamily: font.body, color: color.textSecondary } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

const LABEL_W = 26;
const SUM_W = 32;
const GAP = 10;
const tabular: TextStyle = { fontVariant: ["tabular-nums"] };
// 柔和的浮起阴影：取主题里的黑，深色风格下也不会发光
const SOFT_SHADOW = `0 1px 2px ${alpha(color.black, 0.04)}, 0 8px 24px ${alpha(color.black, 0.06)}`;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceRaised },
  content: { padding: 16, paddingBottom: 28 },
  contentMobile: { padding: 10, paddingBottom: 86 },
  board: { gap: GAP },
  row: { flexDirection: "row", alignItems: "stretch", gap: GAP },
  column: { flexBasis: 0, flexShrink: 1, minWidth: 0, gap: GAP },
  slot: { flexGrow: 1, minWidth: 0 },
  grow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  fill: { position: "relative", flexGrow: 1, flexShrink: 1, minWidth: 0 },
  layer: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },

  panel: { flexGrow: 1, minWidth: 0, overflow: "hidden", paddingHorizontal: 12, paddingVertical: 11, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: SOFT_SHADOW },
  head: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 },
  chip: { flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 99 },
  title: { flexShrink: 0, color: color.text, fontSize: 12.5, fontWeight: "600" },
  meta: { flexShrink: 1, minWidth: 0, color: color.textMuted, fontSize: 10.5, ...tabular },
  body: { flexGrow: 1, gap: 6 },

  label: { flexShrink: 1, color: color.textMuted, fontSize: 10.5, lineHeight: 14 },
  text: { color: color.textSecondary, fontSize: 11 },
  num: { minWidth: 28, color: color.text, fontSize: 11, fontWeight: "600", textAlign: "right", ...tabular },
  time: { color: color.textMuted, fontSize: 10, ...tabular },
  empty: { color: color.textMuted, fontSize: 11, paddingVertical: 6 },
  link: { color: BLUE },
  off: { color: color.textMuted },
  warn: { color: color.amber },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  rows: { flexGrow: 1, justifyContent: "space-between", gap: 5 },
  split: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOff: { borderWidth: 1, borderColor: color.textMuted },
  stateDot: { width: 7, height: 7, borderRadius: 4, borderWidth: 2 },

  kpiBand: { overflow: "hidden", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: SOFT_SHADOW },
  kpiLine: { flexDirection: "row" },
  kpiLineNext: { borderTopWidth: 1, borderTopColor: color.borderSoft },
  kpi: { flexBasis: 0, flexGrow: 1, minWidth: 0, gap: 4, paddingHorizontal: 11, paddingTop: 9, paddingBottom: 10 },
  kpiDivider: { borderLeftWidth: 1, borderLeftColor: color.borderSoft },
  kpiValue: { color: color.figure, fontSize: 18, lineHeight: 22, fontWeight: "700", ...tabular },
  meter: { height: 5, marginTop: "auto", flexDirection: "row", overflow: "hidden", borderRadius: 3, backgroundColor: color.surfaceMuted },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 },
  badge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: 10.5, fontWeight: "600" },

  profile: { color: color.text, fontSize: 17, lineHeight: 21, fontWeight: "700" },
  profileEn: { color: BLUE, fontSize: 9.5, letterSpacing: 0.6, marginTop: -4 },
  ringValue: { color: color.figure, fontSize: 18, fontWeight: "700", ...tabular },
  donutValue: { color: color.text, fontSize: 12, fontWeight: "700", ...tabular },
  funnel: { flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "space-between", gap: 4 },
  funnelRow: { flexGrow: 1, minHeight: 14, flexDirection: "row", alignItems: "stretch", gap: 6 },
  funnelLabel: { width: 24, color: color.textMuted, fontSize: 10, alignSelf: "center" },
  funnelTrack: { flex: 1, flexDirection: "row", justifyContent: "center" },
  avatar: { flexShrink: 0, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  avatarRing: { borderWidth: 2, borderColor: color.surface },
  avatarText: { fontWeight: "700" },
  avatarStack: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8 },
  stackItem: { marginLeft: -12 },
  contactName: { width: 54, color: color.textSecondary, fontSize: 11 },
  contactTrack: { flex: 1, height: 8 },
  contactBar: { height: 8, flexDirection: "row", overflow: "hidden", borderRadius: 4 },
  coverRow: { flexDirection: "row", gap: 6 },
  coverSlot: { flex: 1, minWidth: 0 },
  cover34: { flex: 1, minWidth: 0, aspectRatio: 0.75, maxHeight: 64, overflow: "hidden", borderRadius: 8 },
  coverImage: { width: "100%", height: "100%" },
  cloud: { flexGrow: 1, flexDirection: "row", flexWrap: "wrap", alignContent: "center", alignItems: "flex-end", justifyContent: "center", columnGap: 8, rowGap: 6 },
  emojiItem: { alignItems: "center", gap: 1, padding: 3, borderRadius: 10 },
  emojiTop: { backgroundColor: alpha(AMBER, 0.12) },
  emojiCount: { color: color.textMuted, fontSize: 9, ...tabular },

  grid: { flexGrow: 1, gap: 2 },
  gridRow: { flexGrow: 1, minHeight: 10, flexDirection: "row", alignItems: "stretch", gap: 2 },
  gridLabel: { width: LABEL_W, color: color.textMuted, fontSize: 9, lineHeight: 10, alignSelf: "center" },
  gridSum: { width: SUM_W, color: color.textSecondary, fontSize: 9, lineHeight: 10, textAlign: "right", alignSelf: "center", ...tabular },
  sumBar: { width: SUM_W, height: 5, alignSelf: "center", flexDirection: "row", overflow: "hidden", borderRadius: 99, backgroundColor: color.surfaceMuted },
  dotCell: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center" },
  dotFill: { maxWidth: 15, maxHeight: "100%", aspectRatio: 1, borderRadius: 99 },
  dotPeak: { borderWidth: 1.5, borderColor: color.text },
  pillCell: { flex: 1, minWidth: 0, borderRadius: 99 },
  hourBars: { height: 18, flexDirection: "row", gap: 2, marginTop: 4 },
  barSlot: { flex: 1, minWidth: 0 },
  barCap: { borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  axisText: { color: color.textMuted, fontSize: 9, ...tabular },

  tree: { flexGrow: 1, minHeight: 120, flexDirection: "row", gap: 4 },
  treeGroup: { flexBasis: 0, minWidth: 0, minHeight: 0, gap: 4 },
  treeCell: { flexBasis: 0, minWidth: 0, minHeight: 0, overflow: "hidden", justifyContent: "flex-end", padding: 7, borderRadius: 10 },
  treeName: { color: color.text, fontSize: 11.5, fontWeight: "700" },
  treeValue: { fontSize: 10, fontWeight: "600", ...tabular },

  legendList: { flex: 1, minWidth: 0, gap: 3 },
  legendInline: { flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendName: { flexShrink: 1, color: color.textSecondary, fontSize: 10.5 },
  swatch: { width: 8, height: 8, borderRadius: 4 },

  evidence: { flexGrow: 1, justifyContent: "center", gap: 4 },
  evidenceName: { color: color.text, fontSize: 11, fontWeight: "600" },
  evidenceStrip: { height: 8, flexDirection: "row", gap: 2 },

  matrixLabel: { width: 26, color: color.textMuted, fontSize: 9.5, alignSelf: "center" },
  matrixCell: { flex: 1, minWidth: 0, minHeight: 20, alignItems: "center", justifyContent: "center" },
  matrixBubble: { position: "absolute", maxWidth: 30, maxHeight: "100%", aspectRatio: 1, borderRadius: 99 },
  matrixValue: { color: color.textSecondary, fontSize: 9, ...tabular },

  pill: { flexGrow: 1, minHeight: 20, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: 99 },
});
