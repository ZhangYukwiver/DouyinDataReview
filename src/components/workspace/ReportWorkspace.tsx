import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock6,
  Clock9,
  Clock12,
  Compass,
  Download,
  Eye,
  Heart,
  Hourglass,
  Image as ImageIcon,
  Info,
  Layers,
  Lock,
  MessageCircle,
  MessageSquareMore,
  Moon,
  Mountain,
  Pause,
  Phone,
  Play,
  Radio,
  RotateCcw,
  Send,
  Settings2,
  SkipForward,
  Spline,
  Star,
  Sticker,
  Target,
  UserRound,
} from "lucide-react-native";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";

import type {
  AnnualCreatorsData,
  AnnualInterestsData,
  AnnualKeptData,
  AnnualMonthlyData,
  AnnualOverviewData,
  AnnualReport,
  AnnualRhythmData,
} from "../../domain/annualReport";
import { countChatMessages } from "../../domain/chatRecords";
import type { ChatConversationSummary, ChatMessage, ChatMessageType } from "../../domain/chatRecords";
import type { LivingReport } from "../../domain/livingReport";
import { deriveProfile, progressPercentOf, type ProfileMetrics, type ProfileTitle } from "../../domain/profile";
import { deriveSurpriseInsights } from "../../domain/surpriseInsights";
import type {
  PersonalRecordCollection,
  PersonalRecordType,
  PersonalVideoRecord,
} from "../../domain/personalRecords";
import type { CollectorStatus } from "../../services/localCollector";
import { BOOK_PAGE_COUNT, BookGate, SKIP_BOOK, SKIP_INTRO, type SealStart } from "./BookGate";

export type WorkspaceViewKey = PersonalRecordType | "chat" | "summary" | "highlights";

export interface ContentWorkspaceProps {
  activeView: WorkspaceViewKey;
  records: PersonalRecordCollection;
  chatMessages: ChatMessage[];
  chatConversations?: ChatConversationSummary[];
  report: AnnualReport | LivingReport | null;
  sourceLabel: string;
  updatedAt: string | null;
  busy: boolean;
  status: CollectorStatus | null;
  onChangeView: (view: WorkspaceViewKey) => void;
  onOpenDashboard: () => void;
  onOpenRecord: (url: string) => Promise<void>;
  onOpenSettings: () => void;
  onReplayStory: () => void;
  onSync: () => void;
  onTogglePrivacy: () => void;
  privacy: boolean;
}

type Icon = React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type PageId = "open" | "evidence" | "footprint" | "timeline" | "rhythm" | "attention" | "content" | "creators" | "chat" | "cross" | "surprises" | "profile";

const pages: Array<{ id: PageId; title: string; en: string; dossier: string }> = [
  { id: "open", title: "入口", en: "OPEN THE REPORT", dossier: "OBSERVATION" },
  { id: "evidence", title: "观测凭证", en: "EVIDENCE", dossier: "EVIDENCE" },
  { id: "footprint", title: "内容足迹", en: "FOOTPRINT", dossier: "FOOTPRINT" },
  { id: "timeline", title: "时间轴", en: "TIMELINE", dossier: "TIMELINE" },
  { id: "rhythm", title: "你的节拍", en: "RHYTHM", dossier: "RHYTHM" },
  { id: "attention", title: "你如何停留", en: "ATTENTION", dossier: "ATTENTION" },
  { id: "content", title: "内容回声", en: "CONTENT ECHO", dossier: "CONTENT" },
  { id: "creators", title: "创作者宇宙", en: "CREATOR UNIVERSE", dossier: "CREATOR" },
  { id: "chat", title: "聊天回声", en: "CHAT ECHO", dossier: "CHAT" },
  { id: "cross", title: "交叉洞察", en: "CROSS PATTERNS", dossier: "PATTERN" },
  { id: "surprises", title: "意外发现", en: "SURPRISES", dossier: "SURPRISE" },
  { id: "profile", title: "习惯印章", en: "HABIT PROFILE", dossier: "PROFILE" },
];


const BOOK_RECORD_TYPES = ["watch_history", "liked_videos", "favorite_videos"] as const;

export function selectBookCoverUris(records: PersonalRecordCollection, privacy = false): string[] {
  if (privacy) return [];
  const seenKeys = new Set<string>();
  const seenUris = new Set<string>();
  return BOOK_RECORD_TYPES
    .flatMap((type, typeIndex) => records[type].map((record, recordIndex) => ({ record, order: typeIndex * 1_000_000 + recordIndex })))
    .filter(({ record }) => Boolean(record.coverUrl?.trim()))
    .sort((left, right) => time(right.record.occurredAt) - time(left.record.occurredAt) || left.order - right.order)
    .filter(({ record }) => {
      const uri = record.coverUrl!.trim();
      const key = record.videoId?.trim() ? `video:${record.videoId.trim()}` : `cover:${uri}`;
      if (seenKeys.has(key) || seenUris.has(uri)) return false;
      seenKeys.add(key);
      seenUris.add(uri);
      return true;
    })
    .slice(0, BOOK_PAGE_COUNT)
    .map(({ record }) => record.coverUrl!.trim());
}

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const weekLetters = ["M", "T", "W", "T", "F", "S", "S"];
const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const monthAbbr = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const chatTypes: Array<{ id: ChatMessageType; label: string }> = [
  { id: "text", label: "文字" }, { id: "image", label: "图片" }, { id: "sticker", label: "表情" },
  { id: "share", label: "分享" }, { id: "call", label: "通话" }, { id: "voice", label: "语音" }, { id: "video", label: "视频" },
  { id: "system", label: "系统" }, { id: "unknown", label: "其他" }, { id: "comment", label: "分享评论" },
];
// Keep the five visual rows from the reference page while folding newer
// message types into their closest interaction family.
const chatDisplayTypes: Array<{ id: ChatMessageType; label: string }> = chatTypes.slice(0, 5);
function chatDisplayType(type: ChatMessageType): ChatMessageType | null {
  switch (type) {
    case "text":
    case "image":
    case "sticker":
    case "share":
    case "call":
      return type;
    case "voice":
      return "call";
    case "video":
    case "comment":
      return "share";
    // System notices are text-like; unknown payloads stay out of the chart.
    // New message types must be assigned here explicitly instead of falling
    // through into a misleading visual bucket.
    case "system":
      return "text";
    case "unknown":
      return null;
  }
}
const pointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;
const motionData = (motion: "frame" | "sparkle-group" | "twinkle", index = 0) => ({
  dataSet: { loopMotion: motion, loopIndex: String(index % 6) },
} as unknown as { dataSet: Record<string, string> });
const LOOP_MOTION_CSS = `
@keyframes contentFrameGlow {
  0%, 100% { box-shadow: inset 0 0 0 0 rgba(201,152,91,0), 0 0 0 rgba(112,188,195,0); }
  50% { box-shadow: inset 0 0 0 1px rgba(201,152,91,.16), 0 0 18px rgba(112,188,195,.055); }
}
@keyframes contentSparkleGroup {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .72; transform: scale(1.015); }
}
@keyframes contentTwinkle {
  0%, 100% { filter: brightness(1); transform: scale(1); }
  45% { filter: brightness(1.42); transform: scale(1.14); }
  65% { filter: brightness(1.04); transform: scale(.96); }
}
@keyframes galaxySpin { to { transform: rotate(360deg); } }
@keyframes galaxySpinBack { to { transform: rotate(-360deg); } }
@keyframes starBreathe {
  0%, 100% { opacity: calc(var(--star, .6) * .45); transform: scale(.86); }
  50% { opacity: var(--star, .6); transform: scale(1.2); }
}
[data-loop-motion="frame"] { animation: contentFrameGlow 8s ease-in-out infinite; }
[data-loop-motion="sparkle-group"] { animation: contentSparkleGroup 5.6s ease-in-out infinite; transform-origin: center; will-change: opacity, transform; }
[data-loop-motion="twinkle"] { animation: contentTwinkle 4.8s ease-in-out infinite; transform-origin: center; will-change: filter, transform; }
[data-loop-motion="twinkle"][data-loop-index="1"] { animation-delay: 0.7s; }
[data-loop-motion="twinkle"][data-loop-index="2"] { animation-delay: 1.4s; }
[data-loop-motion="twinkle"][data-loop-index="3"] { animation-delay: 2.1s; }
[data-loop-motion="twinkle"][data-loop-index="4"] { animation-delay: 2.8s; }
[data-loop-motion="twinkle"][data-loop-index="5"] { animation-delay: 3.5s; }
@media (prefers-reduced-motion: reduce) {
  [data-loop-motion] { animation: none !important; filter: none !important; transform: none !important; box-shadow: none !important; }
}
`;

interface Ranked { name: string; count: number; share: number }
interface EvidenceRow {
  count: number;
  dots: number;
  confidence: number;
  range: [string, string] | null;
  caveat: string[];
  /** 24 个半月桶的观测强度 0..1，0 = 未观测。 */
  months: number[];
}
interface CrossData {
  labels: string[];
  matrix: Array<Array<number | null>>;
  patterns: Array<{ title: string; text: string }>;
  days: number;
}

type TimelineEventKind = "watch" | "chat" | "kept";

interface TimelineEventInput {
  kind: TimelineEventKind;
  label: string;
  at: string | null;
  url: string | null;
}

export interface ReportModel {
  year: number;
  period: string;
  total: number;
  unique: number;
  watch: number;
  liked: number;
  favorite: number;
  chat: number;
  chatGroups: ChatConversationSummary[];
  chatGroupMessages: number;
  chatOwnGroupMessages: number;
  dated: number;
  activeDays: number;
  creatorsCount: number;
  reliableRatio: number;
  status: "empty" | "partial" | "ok";
  warnings: string[];
  heatmap: number[];
  hours: number[];
  chatHours: number[];
  months: number[];
  topics: Ranked[];
  creators: Ranked[];
  formats: Ranked[];
  durations: Ranked[];
  chatKinds: Ranked[];
  completion: number | null;
  replays: number;
  intersection: { watchLiked: number; watchFavorite: number; likedFavorite: number; allThree: number };
  peakHour: number | null;
  peakDay: number | null;
  peakMonth: number | null;
  overlap: number | null;
  recent: Array<{ title: string; author: string | null; time: string | null; url: string | null }>;
  axes: Array<{ label: string; left: string; right: string; value: number | null }>;
  profile: string;
  profileEnglish: string;
  profileReason: string;
  profileMetrics: ProfileMetrics;
  /** Radar values used by the title page; these follow the title window. */
  profileAxes: Array<{ label: string; left: string; right: string; value: number | null }>;
  attentionSeconds: number;
  evidence: Record<"watch" | "chat" | "kept" | "creators", EvidenceRow>;
  events: Array<{ kind: TimelineEventKind; label: string; time: string; url: string | null }>;
  calendar: number[][];
  seasons: Array<{ title: string; sub: string[] }>;
  milestones: Array<{ title: string; sub: string }>;
  progressPercents: number[];
  durationBands: Array<{ label: string; en: string; share: number | null }>;
  chatSlots: Array<{ id: string; label: string; en: string; slots: number[] }>;
  cross: CrossData;
  creatorFocus: { concentration: number | null; discovery: number | null; tail: number[] };
  surprises: ReturnType<typeof deriveSurpriseInsights>;
}

export function ContentWorkspace(props: ContentWorkspaceProps) {
  const { width, height } = useWindowDimensions();
  // The story reference canvas is 768px wide; keep tablet-sized web windows
  // in the editorial two-column layout and reserve stacking for phones.
  const mobile = width < 720;
  const [page, setPage] = useState(() => initialPage(props.activeView));
  const [gate, setGate] = useState<"book" | "seal" | "done">(() => !SKIP_BOOK && Platform.OS === "web" && initialPage(props.activeView) === 0 ? "book" : "done");
  const [sealStart, setSealStart] = useState<SealStart | null>(null);
  // 第一页印章的屏幕实测矩形: SealIntro 落点/落尺寸以它为准, 保证任意窗口下飞章与页内印章严丝合缝
  const [pageSealRect, setPageSealRect] = useState<SealStart | null>(null);
  const model = useMemo(() => buildReportModel(props.records, props.chatMessages, props.report, props.chatConversations ?? []), [props.chatConversations, props.chatMessages, props.records, props.report]);
  const bookCoverUris = useMemo(() => selectBookCoverUris(props.records, props.privacy), [props.privacy, props.records]);
  const { onOpenSettings } = props;

  useEffect(() => {
    if (props.activeView === "chat") setPage(8);
    if (props.activeView === "highlights") setPage(10);
  }, [props.activeView]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return undefined;
    const styleId = "content-workspace-loop-motion";
    if (document.getElementById(styleId)) return undefined;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = LOOP_MOTION_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const { cover, step, turning } = useChapterTurn(page, setPage);
  const restart = () => {
    step(-page);
    setSealStart(null);
    setPageSealRect(null);
    setGate(!SKIP_BOOK && Platform.OS === "web" ? "book" : "done");
  };

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "Escape") {
        onOpenSettings();
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || event.key === " ") {
        event.preventDefault();
        step(1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenSettings, step]);

  const def = pages[page]!;
  const compactNav = Platform.OS === "web" && width < 900;
  const webGateScale = Platform.OS === "web" ? Math.min(width / 768, height / 482) : 1;
  // Dynamic pages use a 620px design height.  Fit that canvas into short web
  // viewports so the real components stay visible instead of being clipped by
  // the outer stage header/padding.  Wide desktop layouts remain at 1×.
  const webFrameWidth = Math.max(1, width - 52);
  const webFrameHeight = Math.max(1, height - 42);
  // Pages are composed on a fixed design canvas (reference art is ~1010×630).
  // Scale up as well as down so large viewports keep the reference proportions
  // instead of letting flex stretch the artwork away from the design.
  const webPageScale = Platform.OS === "web" && !mobile
    ? Math.min(2.2, webFrameWidth / 768, webFrameHeight / 620)
    : Platform.OS === "web"
      ? Math.min(1, webFrameWidth / 768, webFrameHeight / 620)
      : 1;
  const pageContent = (
    <Page current={def.id} mobile={mobile} model={model} onDashboard={props.onOpenDashboard} onNext={() => step(1)} onOpen={props.onOpenRecord} onRestart={restart} onSealRect={setPageSealRect} onSettings={props.onOpenSettings} privacy={props.privacy} source={props.sourceLabel} updatedAt={props.updatedAt} />
  );
  const renderedPage = Platform.OS === "web"
    ? <WebPageMotion cover={cover} dir={turning?.dir ?? 1} phase={turning?.phase ?? null}>{pageContent}</WebPageMotion>
    : pageContent;
  const fittedPage = Platform.OS === "web"
    ? <WebPageFit height={webFrameHeight} scale={webPageScale} width={webFrameWidth}>{renderedPage}</WebPageFit>
    : renderedPage;
  return (
    <>
    <View testID="content-workspace" style={styles.root}>
      <View {...motionData("frame")} style={styles.frame}>
        {Platform.OS === "web" ? (
          <View pointerEvents="none" style={styles.grain}>
            <Svg height="100%" preserveAspectRatio="none" width="100%">
              <Defs>
                <RadialGradient cx="50%" cy="40%" id="pageVignette" rx="82%" ry="72%">
                  <Stop offset="0" stopColor="#231F1B" stopOpacity="0.3" />
                  <Stop offset="0.55" stopColor="#171A1A" stopOpacity="0.12" />
                  <Stop offset="1" stopColor="#000000" stopOpacity="0.46" />
                </RadialGradient>
              </Defs>
              <Rect fill="url(#pageVignette)" height="100%" width="100%" />
            </Svg>
            <View style={styles.grainOverlay}>
              <Image resizeMode="repeat" source={require("./assets/paper-grain.png")} style={styles.grainImg} />
            </View>
            <View style={styles.warmTint} />
          </View>
        ) : null}
        {page >= 8 ? (
          <View pointerEvents="none" style={styles.grain}>
            {[styles.cornerTL, styles.cornerTR, styles.cornerBL, styles.cornerBR].map((corner, index) => (
              <View key={index} style={[styles.corner, corner]} />
            ))}
          </View>
        ) : null}
        <View {...vtBody} style={styles.flex}>
          <ScrollView contentContainerStyle={styles.lateScroll} showsVerticalScrollIndicator={false} style={styles.flex}>
            {fittedPage}
          </ScrollView>
        </View>
      </View>
      <View style={[styles.nav, compactNav && styles.navCompact]}>
        <Pressable accessibilityLabel="上一章" accessibilityRole="button" disabled={page === 0} onPress={() => step(-1)} style={({ pressed }) => [styles.navButton, compactNav && styles.navButtonCompact, page === 0 && styles.disabled, pressed && styles.pressed, pointer]}><ChevronLeft color="#9A9084" size={15} /></Pressable>
        <Text style={[styles.navCount, compactNav && styles.navCountCompact]}>{String(page + 1).padStart(2, "0")} / {String(pages.length).padStart(2, "0")}</Text>
        <Pressable accessibilityLabel="下一章" accessibilityRole="button" disabled={page === pages.length - 1} onPress={() => step(1)} style={({ pressed }) => [styles.navButton, compactNav && styles.navButtonCompact, page === pages.length - 1 && styles.disabled, pressed && styles.pressed, pointer]}><ChevronRight color="#9A9084" size={15} /></Pressable>
        <Pressable accessibilityLabel="连接与采集" accessibilityRole="button" onPress={props.onOpenSettings} style={({ pressed }) => [styles.navButton, compactNav && styles.navButtonCompact, pressed && styles.pressed, pointer]}><Settings2 color="#6F665B" size={13} /></Pressable>
      </View>
    </View>
    {Platform.OS === "web" && gate === "book" ? <BookGate covers={bookCoverUris} onDone={(start) => { setSealStart(start); setGate(SKIP_INTRO ? "done" : "seal"); }} privacy={props.privacy} /> : null}
    {Platform.OS === "web" && gate === "seal" ? <SealIntro auto onDone={() => setGate("done")} scale={webGateScale} start={sealStart} target={pageSealRect} /> : null}
    </>
  );
}

function Page(args: PageArgs & { current: PageId }) {
  switch (args.current) {
    case "open": return <OpenPage {...args} />;
    case "evidence": return <EvidencePage {...args} />;
    case "footprint": return <FootprintPage {...args} />;
    case "timeline": return <TimelinePage {...args} />;
    case "rhythm": return <RhythmPage {...args} />;
    case "attention": return <AttentionPage {...args} />;
    case "content": return <ContentPage {...args} />;
    case "creators": return <CreatorsPage {...args} />;
    case "chat": return <ChatPage {...args} />;
    case "cross": return <CrossPage {...args} />;
    case "surprises": return <SurprisesPage {...args} />;
    case "profile": return <ProfilePage {...args} />;
  }
}

// ponytail: 翻页动画已按要求移除, 换章即时切换; 旧的纸叶 View Transitions 实现看 git 历史。
// vtBody/vtAnchor 标记保留为惰性 data 属性, 免得动一遍所有章节组件。
const vtBody = Platform.OS === "web" ? ({ dataSet: { vtBody: "1" } } as unknown as { dataSet: Record<string, string> }) : null;
const vtAnchor = Platform.OS === "web" ? ({ dataSet: { vtAnchor: "1" } } as unknown as { dataSet: Record<string, string> }) : null;

const TURN_SHIFT = 70;

interface ChapterTurn { dir: 1 | -1; phase: "out" | "in" }

function reducedMotion() {
  return Platform.OS === "web"
    && typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useChapterTurn(page: number, setPage: (next: number) => void) {
  // 初值 1 = 报告是从幕后揭开的, 挂载后立刻演一遍入场
  const cover = useRef(new Animated.Value(1)).current;
  const [turning, setTurning] = useState<ChapterTurn | null>({ dir: 1, phase: "in" });
  // step 是 useCallback, 闭包里的 page 会过期, 用 ref 读当前章
  const state = useRef({ page });

  useEffect(() => {
    state.current.page = page;
  }, [page]);

  useEffect(() => {
    if (Platform.OS !== "web" || reducedMotion()) {
      cover.setValue(0);
      setTurning(null);
      return undefined;
    }
    const intro = Animated.timing(cover, { duration: 700, easing: Easing.inOut(Easing.cubic), toValue: 0, useNativeDriver: false });
    intro.start(({ finished }) => { if (finished) setTurning(null); });
    return () => intro.stop();
    // 只在进入报告时演一次
  }, [cover]);

  const step = useCallback((delta: number) => {
    // 同帧连按时 useEffect 还没同步 ref, 这里自己推进, 三次"下一章"才真走三章
    const target = Math.max(0, Math.min(pages.length - 1, state.current.page + delta));
    state.current.page = target;
    setPage(target);
  }, [setPage]);

  return { cover, step, turning };
}

function WebPageMotion({ children, cover, dir, phase }: { children: React.ReactNode; cover: Animated.Value; dir: 1 | -1; phase: "out" | "in" | null }) {
  // 静止态也必须是 Animated.View: 换成 View 会让 React 把整章子树卸载重建, 揭幕瞬间闪一下。
  // 只切 style(转场时才挂 transform), 静止时不留合成层。
  const shift = (phase === "out" ? -1 : 1) * dir * TURN_SHIFT;
  return (
    <Animated.View
      style={phase === null ? styles.flex : [styles.flex, {
        opacity: cover.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [
          { translateX: cover.interpolate({ inputRange: [0, 1], outputRange: [0, shift] }) },
          { scale: cover.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) },
        ],
      }]}
    >
      {children}
    </Animated.View>
  );
}

function WebPageFit({ children, height, scale, width }: { children: React.ReactNode; height: number; scale: number; width: number }) {
  if (Math.abs(scale - 1) < 0.001) return <View style={styles.flex}>{children}</View>;
  // Clamp the design-canvas width so ultra-wide viewports letterbox the page
  // instead of stretching the composition past the reference proportions.
  const canvasWidth = Math.min(width / scale, 1080);
  const sideGap = Math.max(0, (width - canvasWidth * scale) / 2);
  return (
    <View style={[styles.webFitViewport, { height, width }]}>
      <View style={{ height: height / scale, left: sideGap, transform: [{ scale }], transformOrigin: "top left", width: canvasWidth }}>
        {children}
      </View>
    </View>
  );
}

function referenceSheets() {
  if (Platform.OS !== "web" || typeof document === "undefined") return [] as const;
  return [
    require("./assets/reference/pages-01-04.png"),
    require("./assets/reference/pages-05-08.png"),
    require("./assets/reference/pages-09-12.png"),
  ] as const;
}

/* ---------- 印章开场: 手绘印章逐渐落成第一页 ---------- */

// 印章在第一页画布(768×512)里的裁剪框与圆心, 2026-08-29 按金圈外缘逐角重测: 圆心(429,282) 外缘 r66
const SEAL_BOX = { x: 355, y: 208, size: 148 };
const SEAL_CENTER = { x: 429, y: 282 };
const SEAL_DISC = 137;
const SEAL_INTRO_MS = 2200;

function SealIntro({ auto, onDone, scale, start, target }: { auto?: boolean; onDone: () => void; scale: number; start?: SealStart | null; target?: SealStart | null }) {
  const [layout, setLayout] = useState<{ w: number; h: number } | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const startedRef = useRef(false);

  const begin = () => {
    if (startedRef.current) {
      // 落章途中再点 = 跳过动画直接进第一页
      onDone();
      return;
    }
    startedRef.current = true;
    if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone();
      return;
    }
    Animated.timing(progress, { duration: SEAL_INTRO_MS, easing: Easing.inOut(Easing.cubic), toValue: 1, useNativeDriver: false }).start(({ finished }) => {
      if (finished) onDone();
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    // capture + preventDefault: 工作区翻页监听器见 defaultPrevented 会跳过
    const onKey = (event: KeyboardEvent) => {
      if (["Enter", " ", "ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) {
        event.preventDefault();
        begin();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    // auto: 书页压黑后停一拍自动落章(书那侧已完成点击交互); 有原位接力时拍子更短
    const timer = auto ? window.setTimeout(begin, start ? 200 : 350) : 0;
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sheet = referenceSheets()[0];
  const pageWidth = 768;
  const pageHeight = 482;
  // 优先用第一页印章的实测屏幕矩形(kExact), 没有时退回 768×482 画布近似
  const kExact = target && target.d > 0 ? target.d / SEAL_DISC : scale;
  const box = SEAL_BOX.size * kExact;
  let body: React.ReactNode = null;
  if (layout && sheet) {
    // 印章终点 = 第一页印章实测圆心; 退化路径 = 第一页画布(居中于本层)里的印章圆心;
    // 起点 = 书末页实印的屏幕矩形(BookGate 量好交接, 视口即本层坐标), 无接力时退回屏幕中央偏上
    const targetX = target ? target.cx : (layout.w - pageWidth * scale) / 2 + SEAL_CENTER.x * scale;
    const targetY = target ? target.cy : (layout.h - pageHeight * scale) / 2 + SEAL_CENTER.y * scale;
    const startX = start ? start.cx : layout.w / 2;
    const startY = start ? start.cy : layout.h * 0.46;
    const big = start
      ? (start.d * SEAL_BOX.size) / (SEAL_DISC * box)
      : Math.min(2.3, Math.max(1.1, (layout.h * 0.46) / box));
    const clamp = { extrapolate: "clamp" as const };
    const settle = (from: number, to: number) => progress.interpolate({ inputRange: [0, 0.08, 0.62], outputRange: [from, from * 1.03 - to * 0.03, to], ...clamp });
    body = (
      <>
        <Animated.View
          style={{
            position: "absolute",
            left: targetX - box / 2,
            top: targetY - box / 2,
            width: box,
            height: box,
            opacity: auto && !start ? progress.interpolate({ inputRange: [0, 0.07], outputRange: [0, 1], ...clamp }) : 1,
            transform: [
              { translateX: settle(startX - targetX, 0) },
              { translateY: settle(startY - targetY, 0) },
              { scale: progress.interpolate({ inputRange: [0, 0.08, 0.62], outputRange: [big, big * 1.05, 1], ...clamp }) },
              { rotate: progress.interpolate({ inputRange: [0, 0.62], outputRange: [start ? "0deg" : "-5deg", "0deg"], ...clamp }) },
            ],
          }}
        >
          <Animated.View style={[styles.sealIntroGlow, { borderRadius: box / 2, opacity: start
            ? progress.interpolate({ inputRange: [0, 0.32, 0.6], outputRange: [0, 0.5, 0], ...clamp })
            : progress.interpolate({ inputRange: [0, 0.5], outputRange: [0.9, 0], ...clamp }) }]} />
          <View style={{ borderRadius: (SEAL_DISC * kExact) / 2, height: SEAL_DISC * kExact, left: ((SEAL_BOX.size - SEAL_DISC) * kExact) / 2, overflow: "hidden", position: "absolute", top: ((SEAL_BOX.size - SEAL_DISC) * kExact) / 2, width: SEAL_DISC * kExact }}>
            <Image resizeMode="stretch" source={require("./assets/seal-hi.png")} style={{ height: SEAL_DISC * kExact, width: SEAL_DISC * kExact }} />
          </View>
        </Animated.View>
        {auto ? null : (
          <Animated.Text style={[styles.sealIntroHint, { top: startY + (box * big) / 2 + 26, opacity: progress.interpolate({ inputRange: [0, 0.1], outputRange: [0.55, 0], ...clamp }) }]}>
            点击 · 开启报告
          </Animated.Text>
        )}
      </>
    );
  }
  return (
    <View onLayout={(event) => setLayout({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={StyleSheet.absoluteFill} testID="seal-gate">
      <Animated.View style={[StyleSheet.absoluteFill, styles.sealIntroBackdrop, { opacity: progress.interpolate({ inputRange: [0.6, 0.97], outputRange: [1, 0], extrapolate: "clamp" }) }]} />
      <Pressable accessibilityLabel="开启报告，进入年度故事" accessibilityRole="button" onPress={begin} style={[StyleSheet.absoluteFill, pointer]} testID="seal-gate-scene">
        {body}
      </Pressable>
    </View>
  );
}

/* ---------- 01 入口 / OPEN THE REPORT ---------- */

function OpenPage({ mobile, model, onNext, onSealRect }: PageArgs) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const sealHostRef = useRef<View | null>(null);
  // ponytail: hero 按 WebPageFit 画布(onLayout)量,不再用窗口尺寸——窗口 hero × WebPageFit
  // 双重缩放曾把整组放大 ~1.2 倍并把按钮挤出底边; 比例常数由预期稿逐项实测反推
  const hero = box.w ? Math.min(2.2, Math.max(0.85, Math.min(box.w / 840, box.h / 530))) : 1;
  const sealD = Math.round(SEAL_DISC * hero * 1.155);
  const bandK = sealD / 196;
  const titleSize = Math.round(49 * hero);
  const reportSeal = () => {
    if (!onSealRect) return;
    const node = sealHostRef.current as unknown as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null;
    const rect = node?.getBoundingClientRect?.();
    if (rect && rect.width > 0) onSealRect({ cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, d: rect.width });
  };
  useEffect(() => {
    if (Platform.OS !== "web") return undefined;
    // WebPageTransition 入场还有 220ms 位移, 布局稳定后补量一次
    const timer = setTimeout(reportSeal, 480);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.w, box.h, sealD]);
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"这一年的观测就此启封，\n星图与印章之下，\n是你的内容宇宙。"} en="OPEN THE REPORT" mobile={mobile} no="01" title="入口" yearValue={model.year} />
    <View onLayout={(event) => setBox({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.openRoot}>
      <StarField />
      <View style={[styles.openCenter, { paddingBottom: Math.round(20 * hero) }]}>
        <View {...motionData("twinkle")} style={[styles.openSpark, { marginBottom: Math.round(8 * hero) }]}>
          <Svg height={Math.round(33 * hero)} viewBox="0 0 32 38" width={Math.round(32 * hero)}>
            <Path d={starD(16, 19, 7.2, 16.5, 0.12)} fill="#C9995F" />
            <Path d={starD(16, 19, 7, 7, 0.3)} fill="#C9995F" opacity={0.85} transform="rotate(45 16 19)" />
          </Svg>
        </View>
        <Text style={[styles.openTitle, { fontSize: titleSize, lineHeight: Math.round(titleSize * 1.22), letterSpacing: Math.round(5 * hero) }]}>个人内容宇宙报告</Text>
        <Text style={[styles.openYear, { fontSize: Math.round(30 * hero), letterSpacing: Math.round(7 * hero), marginTop: Math.round(5 * hero) }]}>{model.year}</Text>
        <Text {...motionData("twinkle", 2)} style={[styles.openMiniSpark, { fontSize: Math.round(12 * hero), marginTop: Math.round(12 * hero) }]}>✦</Text>
        <View style={styles.openSealRow}>
          <View style={[styles.openRule, { width: Math.round(68 * hero) }]} />
          <Text style={[styles.openSealLabel, { fontSize: Math.round(10 * hero), letterSpacing: 1.6 * hero }]}>OBSERVATION SEAL</Text>
          <View style={[styles.openRule, { width: Math.round(68 * hero) }]} />
        </View>
        <View style={[styles.openBand, { height: Math.round(sealD * 1.29), marginTop: Math.round(-12 * hero) }]}>
          <Constellation k={bandK} months={model.months} />
          <View collapsable={false} onLayout={reportSeal} ref={sealHostRef}>
            <ObservationSeal d={sealD} />
          </View>
        </View>
        <Pressable accessibilityRole="button" onPress={onNext} testID="story-begin" style={({ pressed }) => [styles.plaque, { marginTop: Math.round(35 * hero) }, pressed && styles.pressed, pointer]}>
          <View style={[styles.plaqueInner, { paddingHorizontal: Math.round(20 * hero), paddingVertical: Math.round(12 * hero), gap: Math.round(10 * hero) }]}>
            <View style={[styles.plaqueOrn, { width: Math.round(34 * hero) }]}>
              <View style={styles.plaqueOrnLine} />
              <View style={[styles.plaqueOrnTick, { left: Math.round(3 * hero) }]} />
            </View>
            <Text style={[styles.plaqueText, { fontSize: Math.round(20 * hero), letterSpacing: Math.round(1.5 * hero) }]}>开始观测</Text>
            <View style={[styles.plaqueOrn, { width: Math.round(34 * hero) }]}>
              <View style={styles.plaqueOrnLine} />
              <View style={[styles.plaqueOrnTick, { right: Math.round(3 * hero) }]} />
            </View>
          </View>
          <View style={[styles.plaqueNotch, styles.notchTL]} />
          <View style={[styles.plaqueNotch, styles.notchTR]} />
          <View style={[styles.plaqueNotch, styles.notchBL]} />
          <View style={[styles.plaqueNotch, styles.notchBR]} />
        </Pressable>
      </View>
    </View>
    </View>
  );
}

function StarField() {
  const stars = useMemo(() => Array.from({ length: 92 }, (_, index) => ({
    left: (index * 37.7 + 5) % 100,
    top: (index * 61.3 + 11) % 100,
    size: index % 11 === 0 ? 2.4 : index % 4 === 0 ? 1.8 : 1.2,
    opacity: 0.14 + ((index * 29) % 32) / 100,
    gold: index % 9 === 0,
  })), []);
  const sparkles: Array<[number, number, number, number]> = [[9, 16, 8, 0.4], [88, 12, 7, 0.5], [16, 74, 6, 0.35], [82, 68, 8, 0.45], [46, 8, 6, 0.35], [68, 86, 6, 0.3]];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {stars.map((star, index) => (
        <View key={index} style={{ position: "absolute", left: `${star.left}%`, top: `${star.top}%`, width: star.size, height: star.size, borderRadius: star.size, backgroundColor: star.gold ? "#C59861" : "#D8CFC4", opacity: star.opacity }} />
      ))}
      <View {...motionData("sparkle-group")} pointerEvents="none" style={StyleSheet.absoluteFill}>
        {sparkles.map(([left, top, size, opacity], index) => (
          <Text key={`s${index}`} style={{ position: "absolute", left: `${left}%`, top: `${top}%`, color: "#C59861", fontSize: size, opacity }}>✦</Text>
        ))}
      </View>
    </View>
  );
}

/** 四角星 path：rx/ry 不等时是竖向拉长的闪光星；waist 越小芒越细锐 */
function starD(cx: number, cy: number, rx: number, ry = rx, waist = 0.16): string {
  const bx = rx * waist;
  const by = ry * waist * 0.75;
  return `M ${cx} ${cy - ry} Q ${cx + bx} ${cy - by} ${cx + rx} ${cy} Q ${cx + bx} ${cy + by} ${cx} ${cy + ry} Q ${cx - bx} ${cy + by} ${cx - rx} ${cy} Q ${cx - bx} ${cy - by} ${cx} ${cy - ry} Z`;
}

function ObservationSeal({ d }: { d: number }) {
  const s = d / SEAL_DISC;
  return (
    <View style={[styles.sealWrap, { width: d, height: d, borderRadius: d / 2, shadowRadius: Math.round(44 * s) }]}>
      <View style={[styles.sealDisc, { width: d, height: d, borderRadius: d / 2 }]}>
        {/* ponytail: page-01-hi.png 圆心(858,571)裁 278² 高清实印; 低清 4 合 1 页放大会糊掉金圈 */}
        <Image resizeMode="stretch" source={require("./assets/seal-hi.png")} style={{ height: d, width: d }} />
      </View>
    </View>
  );
}

function Constellation({ k = 1, months = [] }: { k?: number; months?: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const max = Math.max(0, ...months);
  // ponytail: 折线剪影按参考图 14 个星点定死(0.485 那个藏在章后),坐标为内容区/带高比例,
  // 由预期稿逐点实测;真实月度数据只做两件事: 最多 0.1 的抬升 + 把最亮星挪到峰值月节点
  const base: Array<[number, number, number]> = [
    [0.039, 0.664, 3.4], [0.093, 0.614, 4.6], [0.158, 0.555, 3.6], [0.206, 0.377, 7],
    [0.272, 0.582, 4.8], [0.347, 0.505, 4.6], [0.485, 0.545, 3], [0.623, 0.564, 5.6],
    [0.672, 0.491, 3.6], [0.745, 0.568, 5.4], [0.822, 0.677, 5.2], [0.86, 0.473, 5],
    [0.926, 0.509, 4.4], [0.972, 0.614, 3.8],
  ];
  const monthAt = (index: number) => months.length ? Math.round(index * (months.length - 1) / (base.length - 1)) : 0;
  const maxMonth = max > 0 ? months.indexOf(max) : -1;
  const dataStar = maxMonth < 0 ? -1 : base.reduce((best, _, index) => (
    Math.abs(monthAt(index) - maxMonth) < Math.abs(monthAt(best) - maxMonth) ? index : best
  ), 0);
  const pts = base.map(([x, fallback, radius], index) => {
    const value = months[monthAt(index)] ?? 0;
    const bright = radius >= 6 || index === dataStar;
    return {
      x,
      y: Math.max(0.3, Math.min(0.74, fallback - (max ? value / max * 0.1 : 0))),
      r: (bright ? Math.max(radius, 6) : radius * 1.25) * k,
      bright,
    };
  });
  return (
    <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} pointerEvents="none" style={StyleSheet.absoluteFill}>
      {size.w > 0 ? (
        <Svg height={size.h} width={size.w}>
          {pts.slice(1).map((pt, index) => {
            const prev = pts[index]!;
            return <Line key={index} stroke="#8A6940" strokeWidth={Math.max(1.1, 1.3 * k)} opacity={0.9} x1={prev.x * size.w} x2={pt.x * size.w} y1={prev.y * size.h} y2={pt.y * size.h} />;
          })}
          {pts.map((pt, index) => (
            <React.Fragment key={index}>
              {pt.bright ? <Path d={starD(pt.x * size.w, pt.y * size.h, pt.r * 2.3, pt.r * 2.3, 0.3)} fill="#C79E6B" opacity={0.16} /> : null}
              <Path d={starD(pt.x * size.w, pt.y * size.h, pt.r, pt.r, 0.3)} fill={pt.bright ? "#EAC598" : "#C79E6B"} opacity={pt.bright ? 1 : 0.92} />
            </React.Fragment>
          ))}
          {/* 预期稿贴着印章两侧線上各有一颗小星 + 印章左下角外一颗 */}
          <Path d={starD(size.w / 2 - (98 * k + 11), size.h * 0.55, 4.4 * k, 4.4 * k, 0.3)} fill="#C79E6B" opacity={0.95} />
          <Path d={starD(size.w / 2 + (98 * k + 12), size.h * 0.553, 5 * k, 5 * k, 0.3)} fill="#D9B180" opacity={0.98} />
          <Path d={starD(size.w / 2 - (98 * k + 11) * 0.707, size.h / 2 + (98 * k + 11) * 0.78, 4.2 * k, 4.2 * k, 0.3)} fill="#C79E6B" opacity={0.9} />
          <SvgText fill="#A0835F" fontFamily={serif} fontSize={Math.round(14 * k)} x={pts[0]!.x * size.w - 2} y={pts[0]!.y * size.h + Math.round(30 * k)}>01</SvgText>
          <SvgText fill="#A0835F" fontFamily={serif} fontSize={Math.round(14 * k)} x={pts[13]!.x * size.w - 12} y={pts[13]!.y * size.h + Math.round(30 * k)}>12</SvgText>
        </Svg>
      ) : null}
    </View>
  );
}

/* ---------- 02 观测凭证 / EVIDENCE ---------- */

/** 预期稿 page-02-hi.png 的纸面坐标系（纸 1268×788，PIL 实测），渲染时统一乘缩放系数。 */
const EVD = {
  pw: 1268,
  ph: 788,
  vx: [281, 471, 622.5, 775],
  hy: [130.5, 268.5, 402.5, 538.5, 675],
  cols: [[40, 281], [281, 471], [471, 622.5], [622.5, 775], [775, 914]] as ReadonlyArray<readonly [number, number]>,
  heads: ["SOURCE", "EVIDENCE", "CONFIDENCE", "TIME RANGE", "CAVEAT"],
  box: { x: 932.5, y: 114.5, w: 320.5, h: 560.5 },
  gridPad: 18,
  ink: "#655C52",
  line: "#B29C82",
  teal: "#2E696E",
  starTeal: "#2A6C72",
  cellBlue: "#4C7C80",
  cellKhaki: "#B09E89",
} as const;

function EvStar({ filled, size }: { filled: boolean; size: number }) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Path
        d="M8 0.4Q9.5 6.5 15.6 8Q9.5 9.5 8 15.6Q6.5 9.5 0.4 8Q6.5 6.5 8 0.4Z"
        fill={filled ? EVD.starTeal : "none"}
        opacity={filled ? 1 : 0.55}
        stroke={filled ? undefined : EVD.starTeal}
        strokeWidth={filled ? 0 : 1.2}
      />
    </Svg>
  );
}

/** 内框四角花饰：主线圆角折入 + 外侧细弧 + 斜角小菱形。 */
function EvCorner({ s, corner }: { s: number; corner: "tl" | "tr" | "bl" | "br" }) {
  const size = 46 * s;
  const flip = {
    tl: undefined,
    tr: [{ scaleX: -1 as const }],
    bl: [{ scaleY: -1 as const }],
    br: [{ scaleX: -1 as const }, { scaleY: -1 as const }],
  }[corner];
  const pos = {
    tl: { left: 0, top: 0 },
    tr: { right: 0, top: 0 },
    bl: { left: 0, bottom: 0 },
    br: { right: 0, bottom: 0 },
  }[corner];
  return (
    <View pointerEvents="none" style={[{ position: "absolute", width: size, height: size }, pos, flip ? { transform: flip } : null]}>
      <Svg height={size} viewBox="0 0 46 46" width={size}>
        <Path d="M46 14H27Q14 14 14 27V46" fill="none" stroke="#A28C71" strokeWidth={1.3} />
        <Path d="M34 7Q7 7 7 34" fill="none" opacity={0.55} stroke="#A28C71" strokeWidth={1} />
        <Path d="M21 17Q16.5 16.5 16.5 20.5Q16.5 23.5 19.5 23Q22 22.6 21.5 20.2Q21.2 18.8 20 19" fill="none" opacity={0.85} stroke="#A28C71" strokeWidth={1} />
        <Path d="M27 14Q29.5 10.5 33 11.2Q36 11.8 35.4 14" fill="none" opacity={0.6} stroke="#A28C71" strokeWidth={0.9} />
        <Path d="M14 27Q10.5 29.5 11.2 33Q11.8 36 14 35.4" fill="none" opacity={0.6} stroke="#A28C71" strokeWidth={0.9} />
        <Path d="M10.5 8L13 10.5L10.5 13L8 10.5Z" fill="#A28C71" opacity={0.7} />
        <Path d="M40 11.2L41.6 12.8L40 14.4L38.4 12.8Z" fill="#A28C71" opacity={0.45} />
        <Path d="M11.2 40L12.8 41.6L14.4 40L12.8 38.4Z" fill="#A28C71" opacity={0.45} />
      </Svg>
    </View>
  );
}

function EvidencePage({ mobile, model }: PageArgs) {
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const rows: Array<{ label: string; icon: Icon; data: EvidenceRow }> = [
    { label: "短视频观看", icon: Play, data: model.evidence.watch },
    { label: "聊天互动", icon: MessageSquareMore, data: model.evidence.chat },
    { label: "收藏与点赞", icon: Star, data: model.evidence.kept },
    { label: "关注与创作者", icon: UserRound, data: model.evidence.creators },
  ];
  const s = area ? Math.min((area.w - 8) / EVD.pw, (area.h - 34) / EVD.ph) : 0;
  const rowCenter = (index: number) => ((EVD.hy[index] ?? 0) + (EVD.hy[index + 1] ?? 0)) / 2;
  const gridLeft = EVD.box.x + EVD.gridPad;
  const gridW = EVD.box.w - EVD.gridPad * 2;
  const pitch = gridW / 12;
  const cellW = pitch - 4;
  const cell = (ci: number, ri: number, children: React.ReactNode, extra?: object) => (
    <View
      key={`${ci}-${ri}`}
      style={[{
        position: "absolute",
        left: (EVD.cols[ci]?.[0] ?? 0) * s,
        width: ((EVD.cols[ci]?.[1] ?? 0) - (EVD.cols[ci]?.[0] ?? 0)) * s,
        top: (EVD.hy[ri] ?? 0) * s,
        height: ((EVD.hy[ri + 1] ?? 0) - (EVD.hy[ri] ?? 0)) * s,
        alignItems: "center",
        justifyContent: "center",
      }, extra]}
    >
      {children}
    </View>
  );
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"先看证据本身，\n每一类记录的覆盖、\n可信度与边界。"} en="EVIDENCE" mobile={mobile} no="02" title="观测凭证" yearValue={model.year} />
    <View
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (!area || Math.abs(area.w - width) > 1 || Math.abs(area.h - height) > 1) setArea({ w: width, h: height });
      }}
      style={styles.evRoot}
    >
      {s > 0 ? (
        <View style={{ width: EVD.pw * s, height: EVD.ph * s, backgroundColor: "#DBCCB9", borderWidth: 1, borderColor: "#7E6C55", borderRadius: 6 * s, overflow: "hidden" }}>
          {/* 校准羊皮纸：scratchpad/gen-paper.py 程序生成（实测色场 + 多尺度噪声），非裁自原稿 */}
          <Image resizeMode="stretch" source={require("./assets/evidence-paper.png")} style={styles.evGrain} />
          {/* 内框细线 + 四角花饰 */}
          {([
            { left: 46 * s, right: 46 * s, top: 14 * s, height: 1 },
            { left: 46 * s, right: 46 * s, bottom: 14 * s, height: 1 },
            { top: 46 * s, bottom: 46 * s, left: 14 * s, width: 1 },
            { top: 46 * s, bottom: 46 * s, right: 14 * s, width: 1 },
          ] as const).map((edge, index) => (
            <View key={index} pointerEvents="none" style={[{ position: "absolute", backgroundColor: "#A28C71", opacity: 0.8 }, edge]} />
          ))}
          <EvCorner corner="tl" s={s} />
          <EvCorner corner="tr" s={s} />
          <EvCorner corner="bl" s={s} />
          <EvCorner corner="br" s={s} />
          {/* 表格分隔线 */}
          {EVD.hy.map((y, index) => (
            <View key={`h${index}`} style={{ position: "absolute", left: 40 * s, width: (914 - 40) * s, top: y * s, height: 1, backgroundColor: index === 0 ? "#A6927A" : EVD.line }} />
          ))}
          {EVD.vx.map((x, index) => (
            <View key={`v${index}`} style={{ position: "absolute", left: x * s, width: 1, top: 81 * s, height: (683 - 81) * s, backgroundColor: EVD.line }} />
          ))}
          {/* 表头 */}
          {EVD.heads.map((head, index) => (
            <View key={head} style={{ position: "absolute", left: (EVD.cols[index]?.[0] ?? 0) * s, width: ((EVD.cols[index]?.[1] ?? 0) - (EVD.cols[index]?.[0] ?? 0)) * s, top: 81 * s, height: (130.5 - 81) * s, justifyContent: "flex-end", alignItems: "center", paddingBottom: 8 * s }}>
              <Text style={{ fontFamily: serif, fontSize: 15.5 * s, letterSpacing: 1.5 * s, color: "#63584A" }}>{head}</Text>
            </View>
          ))}
          {/* 数据行 */}
          {rows.map(({ data, icon: RowIcon, label }, ri) => (
            <React.Fragment key={label}>
              {cell(0, ri, (
                <>
                  <View style={{ width: 66 * s, height: 66 * s, borderRadius: 33 * s, borderWidth: 1, borderColor: "rgba(126,93,53,0.55)", alignItems: "center", justifyContent: "center" }}>
                    <View style={{ width: 63 * s, height: 63 * s, borderRadius: 31.5 * s, borderWidth: Math.max(1.2, 1.6 * s), borderColor: "#C29968", alignItems: "center", justifyContent: "center" }}>
                      <View style={{ width: 57 * s, height: 57 * s, borderRadius: 28.5 * s, backgroundColor: "#120F0B", borderWidth: 1, borderColor: "#3A2A17", alignItems: "center", justifyContent: "center" }}>
                        <RowIcon color="#D2A978" size={26 * s} strokeWidth={1.7} />
                      </View>
                    </View>
                  </View>
                  <Text style={{ fontFamily: serif, fontSize: 21 * s, fontWeight: "700", color: "#33281A", marginLeft: 13 * s }}>{label}</Text>
                </>
              ), { flexDirection: "row", justifyContent: "flex-start", paddingLeft: 18 * s })}
              {cell(1, ri, (
                <View style={{ flexDirection: "row", gap: 11.3 * s }}>
                  {[0, 1, 2, 3, 4].map((dot) => {
                    const half = data.dots - dot === 0.5;
                    const on = dot < data.dots && !half;
                    return (
                      <View key={dot} style={{ width: 14 * s, height: 14 * s, borderRadius: 7 * s, overflow: "hidden", borderWidth: 1, borderColor: on || half ? EVD.teal : "#A08C73", backgroundColor: on ? EVD.teal : "transparent" }}>
                        {half ? <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "50%", backgroundColor: EVD.teal }} /> : null}
                      </View>
                    );
                  })}
                </View>
              ))}
              {cell(2, ri, (
                <View style={{ flexDirection: "row", gap: 9 * s }}>
                  {[0, 1, 2, 3].map((star) => <EvStar filled={star < data.confidence} key={star} size={16 * s} />)}
                </View>
              ))}
              {cell(3, ri, data.range
                ? <><Text style={{ fontFamily: serif, fontSize: 15 * s, lineHeight: 22 * s, color: EVD.ink, fontVariant: ["tabular-nums"] }}>{data.range[0]}</Text><Text style={{ fontFamily: serif, fontSize: 15 * s, lineHeight: 22 * s, color: EVD.ink, fontVariant: ["tabular-nums"] }}>~ {data.range[1]}</Text></>
                : <Text style={{ fontFamily: serif, fontSize: 15 * s, color: EVD.ink }}>—</Text>)}
              {cell(4, ri, data.caveat.map((line) => (
                <Text key={line} style={{ fontFamily: serif, fontSize: 15 * s, lineHeight: 22 * s, color: "#716556" }}>{line}</Text>
              )))}
              {/* 覆盖格阵：上行 1-6 月半月桶，下行 7-12 月 */}
              {[0, 1].map((line) => (
                <View key={`g${ri}-${line}`} style={{ position: "absolute", left: gridLeft * s, top: (rowCenter(ri) - 25.5 + line * 29) * s, flexDirection: "row" }}>
                  {Array.from({ length: 12 }, (_, column) => {
                    const value = data.months[line * 12 + column] ?? 0;
                    // 确定性抖动：透明度 ±0.21、色相三选一、位置/尺寸 ±1px，模拟手涂水彩
                    const hash = (ri * 12 + column) * 7 + line * 5;
                    const jitter = ((hash % 7) - 3) * 0.07;
                    const hue = ["#4C7C80", "#52858A", "#457478"][hash % 3]!;
                    const jx = ((hash * 3) % 3) - 1;
                    const jy = ((hash * 5) % 3) - 1;
                    const cellOp = value > 0 ? Math.min(0.95, Math.max(0.42, 0.5 + 0.42 * Math.pow(value, 1.2) + jitter)) : Math.max(0.24, 0.4 + jitter * 0.6);
                    const fill = value > 0 ? hue : EVD.cellKhaki;
                    return (
                      <View key={column} style={{ width: cellW * s, height: 22 * s, marginRight: (pitch - cellW) * s }}>
                        <View style={{ position: "absolute", left: -2.5 * s, right: -2.5 * s, top: -2.5 * s, bottom: -2.5 * s, borderRadius: 4 * s, backgroundColor: fill, opacity: cellOp * 0.2 }} />
                        <View style={{ position: "absolute", left: (1 + jx) * s, top: (1 + jy) * s, right: (1 - jx) * s, bottom: (1 - jy) * s, borderRadius: 2 * s, backgroundColor: fill, opacity: cellOp }} />
                      </View>
                    );
                  })}
                </View>
              ))}
            </React.Fragment>
          ))}
          {/* COVERAGE 面板 */}
          <Text style={{ position: "absolute", left: EVD.box.x * s, width: EVD.box.w * s, top: 66 * s, textAlign: "center", fontFamily: serif, fontSize: 19 * s, letterSpacing: 3 * s, color: "#5E5140" }}>COVERAGE</Text>
          <Text style={{ position: "absolute", left: EVD.box.x * s, width: EVD.box.w * s, top: 105 * s, textAlign: "center", fontFamily: serif, fontSize: 14 * s, letterSpacing: 2 * s, color: "#7C6D5A" }}>{model.year}</Text>
          {/* 面板边框：顶边为年份让出缺口 */}
          <View pointerEvents="none" style={{ position: "absolute", left: EVD.box.x * s, top: EVD.box.y * s, width: EVD.box.w * s, height: EVD.box.h * s, borderWidth: 1, borderTopWidth: 0, borderColor: "#AF9B82" }} />
          <View pointerEvents="none" style={{ position: "absolute", left: EVD.box.x * s, top: EVD.box.y * s, width: (EVD.box.w / 2 - 38) * s, height: 1, backgroundColor: "#AF9B82" }} />
          <View pointerEvents="none" style={{ position: "absolute", left: (EVD.box.x + EVD.box.w / 2 + 38) * s, top: EVD.box.y * s, width: (EVD.box.w / 2 - 38) * s, height: 1, backgroundColor: "#AF9B82" }} />
          {["J", "F", "M", "A", "M", "J"].map((letter, index) => (
            <Text key={index} style={{ position: "absolute", left: (gridLeft + gridW * (index + 0.5) / 6 - 20) * s, width: 40 * s, top: 141 * s, textAlign: "center", fontFamily: serif, fontSize: 15.5 * s, color: "#7C6F60" }}>{letter}</Text>
          ))}
          {/* 图例 */}
          <View style={{ position: "absolute", left: 796 * s, top: 718 * s, flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 17 * s, height: 17 * s, borderRadius: 2 * s, backgroundColor: "#346468" }} />
            <Text style={{ fontFamily: serif, fontSize: 15 * s, color: "#6F5D48", marginLeft: 10 * s }}>observed</Text>
            <View style={{ width: 17 * s, height: 17 * s, borderRadius: 2 * s, backgroundColor: "#9B7E5B", marginLeft: 44 * s }} />
            <Text style={{ fontFamily: serif, fontSize: 15 * s, color: "#6F5D48", marginLeft: 10 * s }}>not observed</Text>
          </View>
        </View>
      ) : null}
    </View>
    </View>
  );
}

/* ---------- 03 内容足迹 / FOOTPRINT ---------- */

function FootprintPage({ mobile, model, onOpen }: PageArgs) {
  const stats: Array<{ icon: Icon; label: string; value: string; sub: string }> = [
    { icon: CalendarDays, label: "活跃天数", value: model.activeDays ? String(model.activeDays) : "—", sub: "/ 365" },
    { icon: Spline, label: "观测事件", value: model.total + model.chat ? (model.total + model.chat).toLocaleString("en-US") : "—", sub: "observed" },
    { icon: Layers, label: "内容形态", value: model.formats.length ? String(model.formats.length) : "—", sub: "formats" },
    { icon: Hourglass, label: "总注意力", value: attentionLabel(model.attentionSeconds), sub: "observed" },
  ];
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"一年留下的痕迹，\n在日历、事件流与\n关系图谱中展开。"} en="FOOTPRINT" mobile={mobile} no="03" title="内容足迹" yearValue={model.year} />
    <View style={styles.fpRoot}>
      <View style={[styles.fpStats, mobile && styles.fpStatsMobile]}>
        {stats.map(({ icon: StatIcon, label, sub, value }, index) => (
          <React.Fragment key={label}>
            <View style={styles.fpStat}>
              <StatIcon color="#C59861" size={28} strokeWidth={1.3} />
              <Text style={styles.fpStatLabel}>{label}</Text>
              <Text style={styles.fpStatValue}>{value}</Text>
              <Text style={styles.fpStatSub}>{sub}</Text>
            </View>
            {index < stats.length - 1 && !mobile ? <View style={styles.fpStatSep}><View style={styles.fpStatSepDot} /></View> : null}
          </React.Fragment>
        ))}
      </View>
      <View style={[styles.fpBody, mobile && styles.stack]}>
        <View style={[styles.fpCol, !mobile && styles.fpColCal]}>
          <ColHead cn="活动日历" en={`/ ${model.year}`} />
          <View style={styles.fpWeekRow}>{weekLetters.map((letter, index) => <Text key={index} style={styles.fpWeekLetter}>{letter}</Text>)}</View>
          {model.calendar.map((cells, month) => (
            <View key={month} style={styles.fpCalRow}>
              <Text style={styles.fpCalMonth}>{monthAbbr[month]}</Text>
              <View style={styles.fpCalCells}>{cells.map((level, index) => {
                // 三组近似色轮换出水彩式深浅波动，避免整片死平
                const palette = level === 2 ? ["#55787B", "#4C6E71", "#5E7F82"] : level === 1 ? ["#374E50", "#2F4648"] : ["#252A2A", "#292E2E", "#232828"];
                return <View key={index} style={[styles.fpCell, { backgroundColor: palette[(month * 7 + index * 5) % palette.length] }]} />;
              })}</View>
            </View>
          ))}
          <View style={styles.fpLegend}>
            <View style={[styles.fpCell, styles.fpCellHigh]} /><Text style={styles.fpLegendText}>active</Text>
            <View style={[styles.fpCell, styles.fpLegendGap]} /><Text style={styles.fpLegendText}>inactive</Text>
          </View>
        </View>
        <View style={[styles.fpCol, !mobile && styles.fpColMid]}>
          <ColHead cn="事件流" en="/ 近期" />
          <View style={styles.fpEvents}>
            {model.events.length > 1 ? <View style={styles.fpEventAxis} /> : null}
            {model.events.length ? model.events.map((event, index) => {
              const EventIcon = event.kind === "watch" ? Play : event.kind === "chat" ? MessageCircle : Star;
              const teal = event.kind === "watch";
              const eventBody = (
                <View style={styles.fpEvent}>
                  <View style={[styles.fpEventIcon, teal && styles.fpEventIconTeal]}><EventIcon color={teal ? "#7FB7BC" : "#C9AA85"} size={11} strokeWidth={1.7} /></View>
                  <Text style={styles.fpEventTag}>observed</Text>
                  <Text numberOfLines={1} style={[styles.fpEventName, styles.flex]}>{event.label}</Text>
                  <Text style={styles.fpEventTime}>{event.time}</Text>
                </View>
              );
              return event.url ? <Pressable accessibilityRole="link" key={index} onPress={() => void onOpen(event.url!)} style={({ pressed }) => [pressed && styles.pressed, pointer]}>{eventBody}</Pressable> : <View key={index}>{eventBody}</View>;
            }) : <Text style={styles.fpEmpty}>等待可定位时间的观测事件</Text>}
          </View>
        </View>
        <View style={[styles.fpCol, !mobile && styles.fpColTri]}>
          <ColHead cn="关系图谱" en="/ 注意力分布" />
          <AttentionTriangle model={model} />
        </View>
      </View>
    </View>
    </View>
  );
}

function ColHead({ cn, en }: { cn: string; en: string }) {
  return <View style={styles.colHead}><Text style={styles.colHeadCn}>{cn}</Text><Text style={styles.colHeadEn}>{en}</Text></View>;
}

function AttentionTriangle({ model }: { model: ReportModel }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const total = model.watch + model.liked + model.favorite + model.chat;
  const share = (value: number) => total ? `${Math.round(value / total * 100)}%` : "—";
  const nodes: Array<{ x: number; y: number; icon: Icon; tint: string }> = [
    { x: 0.52, y: 0.16, icon: Play, tint: "#7FB7BC" },
    { x: 0.2, y: 0.74, icon: Star, tint: "#C9995F" },
    { x: 0.84, y: 0.74, icon: MessageCircle, tint: "#7FB7BC" },
  ];
  const px = (node: { x: number; y: number }) => ({ cx: node.x * size.w, cy: node.y * size.h });
  // 全部装饰随画布高等比（系数取自预期稿 302px 等效画布），矮视口下三角与星饰同步缩放
  const u = size.h;
  const nodeR = Math.min(30, Math.max(18, u * 0.09));
  const iconS = Math.round(nodeR * 0.85);
  const starBox = Math.round(u * 0.12);
  return (
    <View style={styles.triWrap}>
      <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.triCanvas}>
        {size.w > 0 ? (
          <Svg height={size.h} width={size.w}>
            {[[0, 1], [1, 2], [2, 0]].map(([from, to], index) => {
              const a = px(nodes[from!]!);
              const b = px(nodes[to!]!);
              return <Line key={index} stroke="#483D2F" strokeWidth={1} x1={a.cx} x2={b.cx} y1={a.cy} y2={b.cy} />;
            })}
            {nodes.map((node, index) => {
              const point = px(node);
              const dx = point.cx - 0.52 * size.w;
              const dy = point.cy - 0.55 * size.h;
              const len = Math.hypot(dx, dy) || 1;
              return <Line key={`radial-${index}`} stroke="#6B5840" strokeDasharray="0.1 5" strokeLinecap="round" strokeWidth={1.2} x1={0.52 * size.w + dx / len * u * 0.1} x2={point.cx - dx / len * (nodeR - 2)} y1={0.55 * size.h + dy / len * u * 0.1} y2={point.cy - dy / len * (nodeR - 2)} />;
            })}
            <Circle cx={0.52 * size.w} cy={0.55 * size.h} fill="none" r={u * 0.152} stroke="#8E7D68" strokeDasharray="0.1 5.5" strokeLinecap="round" strokeWidth={1.5} />
            <Circle cx={0.52 * size.w} cy={0.55 * size.h} fill="none" r={u * 0.093} stroke="#6B5840" strokeDasharray="0.1 4" strokeLinecap="round" strokeWidth={0.9} />
            {[0, 90, 180, 270].map((deg) => {
              const rad = deg * Math.PI / 180;
              return <Path key={`cardinal-${deg}`} d={starD(0.52 * size.w + Math.cos(rad) * u * 0.152, 0.55 * size.h + Math.sin(rad) * u * 0.152, Math.max(2.6, u * 0.0126))} fill="#D8B182" />;
            })}
            {[40, 140, 220, 320].map((deg) => {
              const rad = deg * Math.PI / 180;
              return <Circle key={`tick-${deg}`} cx={0.52 * size.w + Math.cos(rad) * u * 0.152} cy={0.55 * size.h + Math.sin(rad) * u * 0.152} fill="#C79E6B" opacity={0.8} r={Math.max(1.1, u * 0.005)} />;
            })}
            {[20, 160].map((deg) => {
              const rad = deg * Math.PI / 180;
              return <Circle key={`inner-${deg}`} cx={0.52 * size.w + Math.cos(rad) * u * 0.093} cy={0.55 * size.h + Math.sin(rad) * u * 0.093} fill="#E3C39C" r={Math.max(1.3, u * 0.006)} />;
            })}
            <Path d={starD(0.52 * size.w - u * 0.21, 0.55 * size.h + u * 0.012, Math.max(1.9, u * 0.0086))} fill="#C79E6B" opacity={0.85} />
            <Path d={starD(0.52 * size.w + u * 0.2, 0.55 * size.h - u * 0.055, Math.max(1.6, u * 0.0073))} fill="#C79E6B" opacity={0.7} />
            {nodes.map((node, index) => {
              const point = px(node);
              return (
                <React.Fragment key={index}>
                  <Circle cx={point.cx} cy={point.cy} fill="#1D2222" r={nodeR} stroke="#B08755" strokeWidth={1.5} />
                  {[30, 75, 120, 165, 210, 255, 300, 345].map((deg) => {
                    const rad = deg * Math.PI / 180;
                    return <Line key={`dial-${deg}`} opacity={0.28} stroke="#C59861" strokeWidth={0.8} x1={point.cx + Math.cos(rad) * nodeR * 0.73} x2={point.cx + Math.cos(rad) * nodeR * 0.88} y1={point.cy + Math.sin(rad) * nodeR * 0.73} y2={point.cy + Math.sin(rad) * nodeR * 0.88} />;
                  })}
                </React.Fragment>
              );
            })}
          </Svg>
        ) : null}
        {size.w > 0 ? nodes.map((node, index) => {
          const NodeIcon = node.icon;
          return <View key={index} pointerEvents="none" style={{ position: "absolute", left: node.x * size.w - iconS / 2, top: node.y * size.h - iconS / 2 }}><NodeIcon color={node.tint} size={iconS} strokeWidth={1.5} /></View>;
        }) : null}
        {size.w > 0 ? (
          <View {...motionData("twinkle", 2)} pointerEvents="none" style={[styles.triStarWrap, { left: 0.52 * size.w - starBox / 2, top: 0.55 * size.h - starBox / 2 }]}>
            <Svg height={starBox} viewBox="0 0 84 84" width={starBox}>
              <Path d={starD(42, 42, 33, 33, 0.07)} fill="#C79E6B" opacity={0.16} />
              <Path d={starD(42, 42, 13, 13, 0.07)} fill="#D8B182" opacity={0.9} transform="rotate(45 42 42)" />
              <Path d={starD(42, 42, 24, 33, 0.05)} fill="#EAC598" />
              <Circle cx={42} cy={42} fill="#F4DEC2" r={1.8} />
            </Svg>
          </View>
        ) : null}
        {size.w > 0 ? (
          <>
            <View style={[styles.triLabel, { left: 0.52 * size.w + nodeR + 10, top: 0.16 * size.h - 18 }]}><Text style={styles.triName}>观看</Text><Text style={styles.triValue}>{share(model.watch)}</Text></View>
            <View style={[styles.triLabel, { left: 0.2 * size.w - nodeR - 10, top: 0.74 * size.h + nodeR + 8 }]}><Text style={styles.triName}>点赞/收藏</Text><Text style={styles.triValue}>{share(model.liked + model.favorite)}</Text></View>
            <View style={[styles.triLabel, { left: 0.84 * size.w - nodeR - 2, top: 0.74 * size.h + nodeR + 8 }]}><Text style={styles.triName}>互动</Text><Text style={styles.triValue}>{share(model.chat)}</Text></View>
          </>
        ) : null}
      </View>
      <Text style={styles.fpNote}>* 分布为观察期内相对关系，非绝对占比</Text>
    </View>
  );
}

/* ---------- 04 时间轴 / TIMELINE ---------- */

function TimelinePage({ mobile, model }: PageArgs) {
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"沿着十二个月，\n看强度起伏、里程碑\n与季节性的模式。"} en="TIMELINE" mobile={mobile} no="04" title="时间轴" yearValue={model.year} />
    <View style={styles.tlRoot}>
      <View style={styles.tlTitleRow}>
        <View style={styles.tlRule} />
        <Text {...motionData("twinkle", 3)} style={styles.tlStar}>✦</Text>
        <View style={styles.tlRuleShort} />
        <Text style={styles.tlYear}>{model.year}</Text>
        <View style={styles.tlRuleShort} />
        <Text {...motionData("twinkle", 4)} style={styles.tlStar}>✦</Text>
        <View style={styles.tlRule} />
      </View>
      <View style={[styles.tlBand, styles.tlBandChart]}>
        <BandLabel cn="强度" en="INTENSITY" />
        <IntensityChart months={model.months} />
      </View>
      <View style={[styles.tlBand, styles.tlBandMiddle]}>
        <BandLabel cn="里程碑" en="MILESTONES" />
        {model.dated ? (
          <View style={styles.tlMilestones}>
            <View style={styles.tlBaseline} />
            {model.milestones.map((milestone) => (
              <View key={milestone.title} style={styles.tlMilestone}>
                <View style={styles.tlNode}><View style={styles.tlNodeDot} /></View>
                <Text numberOfLines={2} style={styles.tlMilestoneTitle}>{milestone.title}</Text>
                <Text style={styles.tlMilestoneSub}>{milestone.sub.replace(" ", "\n")}</Text>
              </View>
            ))}
          </View>
        ) : <Text style={styles.tlEmpty}>尚无可定位的时间证据</Text>}
      </View>
      <View style={[styles.tlBand, styles.tlBandLast]}>
        <BandLabel cn="模式洞察" en="PATTERNS" />
        <View style={[styles.tlPatterns, mobile && styles.stack]}>
          {model.seasons.map((season) => (
            <View key={season.title} style={styles.tlPattern}>
              <Text {...motionData("twinkle", 5)} style={styles.tlPatternStar}>✦</Text>
              <Text style={styles.tlPatternTitle}>{season.title}</Text>
              {season.sub.map((line) => <Text key={line} style={styles.tlPatternSub}>{line}</Text>)}
            </View>
          ))}
        </View>
      </View>
    </View>
    </View>
  );
}

function BandLabel({ cn, en }: { cn: string; en: string }) {
  return <View style={styles.bandLabel}><Text style={styles.bandCn}>{cn}</Text><Text style={styles.bandEn}>{en}</Text></View>;
}

function IntensityChart({ months }: { months: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const max = Math.max(...months);
  const pad = 6;
  const chartH = size.h;
  const x = (index: number) => pad + index * (size.w - pad * 2) / 11;
  const y = (value: number) => max ? chartH - 12 - value / (max * 1.22) * (chartH - 34) : chartH - 12;
  const pts = months.map((value, index) => [x(index), y(value)] as [number, number]);
  return (
    <View style={styles.flex}>
      <View style={styles.tlMonthRow}>{monthAbbr.map((name) => <Text key={name} style={styles.tlMonth}>{name}</Text>)}</View>
      <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.tlChart}>
        {size.w > 0 ? (
          <Svg height={size.h} width={size.w}>
            <Defs>
              <LinearGradient id="tlArea" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#375E62" stopOpacity={0.85} />
                <Stop offset="1" stopColor="#131F20" stopOpacity={0.1} />
              </LinearGradient>
            </Defs>
            <Line stroke="#26221D" strokeDasharray="2 6" strokeWidth={0.8} x1={0} x2={size.w} y1={(chartH - 12) * 0.47} y2={(chartH - 12) * 0.47} />
            <Line stroke="#3C342A" strokeWidth={1} x1={0} x2={size.w} y1={chartH - 12} y2={chartH - 12} />
            {max ? <Path d={`${smoothPath(pts, chartH - 12)} L ${x(11)} ${chartH - 12} L ${x(0)} ${chartH - 12} Z`} fill="url(#tlArea)" /> : null}
            {monthAbbr.map((_, index) => (
              <Line key={index} opacity={0.75} stroke="#41372B" strokeDasharray="1.5 4.5" strokeWidth={0.9} x1={x(index)} x2={x(index)} y1={4} y2={chartH - 12} />
            ))}
            {max ? <Path d={smoothPath(pts, chartH - 12)} fill="none" stroke="#8FADB0" strokeWidth={1.1} opacity={0.55} /> : null}
          </Svg>
        ) : null}
        <Text style={[styles.tlAxis, styles.tlAxisHigh]}>高</Text>
        <Text style={[styles.tlAxis, styles.tlAxisMid]}>中</Text>
        <Text style={[styles.tlAxis, styles.tlAxisLow]}>低</Text>
        {!max ? <Text style={styles.tlEmptyChart}>等待时间证据</Text> : null}
      </View>
    </View>
  );
}

export function smoothPath(pts: Array<[number, number]>, floorY = Number.POSITIVE_INFINITY): string {
  if (!pts.length) return "";
  let path = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let index = 0; index < pts.length - 1; index += 1) {
    const p0 = pts[Math.max(0, index - 1)]!;
    const p1 = pts[index]!;
    const p2 = pts[index + 1]!;
    const p3 = pts[Math.min(pts.length - 1, index + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = Math.min(floorY, p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = Math.min(floorY, p2[1] - (p3[1] - p1[1]) / 6);
    path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  return path;
}

/* ---------- 05-12 章 · 观测图版 ---------- */

// 按参考稿热力图色簇实测校准: 金 hue≈34° 高饱和偏暗, teal hue≈180° 青灰偏暗
export const heatColors = ["#10171A", "#1A3133", "#27494B", "#406C72", "#8A6238", "#B07E40"];
// 金色只留给峰值时段, 其余走蓝绿系 —— 参考稿的金色云雾集中在高峰带
function heat(t: number): string { if (t <= 0.06) return heatColors[0]!; if (t < 0.38) return heatColors[1]!; if (t < 0.62) return heatColors[2]!; if (t < 0.8) return heatColors[3]!; if (t < 0.92) return heatColors[4]!; return heatColors[5]!; }
function confLabel(dots: number): string { const full = Math.floor(dots); return full >= 4 ? "高" : full === 3 ? "中高" : full === 2 ? "中" : full === 1 ? "低" : "待定"; }
export function pctLabel(value: number | null): string { return value === null ? "—" : `${Math.round(value)}%`; }
function starPath(cx: number, cy: number, r: number): string {
  const inner = r * 0.32;
  return `M ${cx} ${cy - r} L ${cx + inner} ${cy - inner} L ${cx + r} ${cy} L ${cx + inner} ${cy + inner} L ${cx} ${cy + r} L ${cx - inner} ${cy + inner} L ${cx - r} ${cy} L ${cx - inner} ${cy - inner} Z`;
}
function describeArc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0));
  const y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}
function hourly(heatmap: number[], rows: number[]): number[] {
  return Array.from({ length: 24 }, (_, hour) => rows.reduce((sum, row) => sum + (heatmap[row * 24 + hour] ?? 0), 0) / rows.length);
}

function CompassRose({ color = "#4A4034", size = 30 }: { color?: string; size?: number }) {
  // 档案罗盘刻度盘: 双细圈 + 方位刻度 + 贯穿十字 + 斜向指针 + 中心金点, 按参考稿左下角罗盘绘制
  const c = size / 2;
  const r = c - 1;
  const ticks = Array.from({ length: 16 }, (_, index) => {
    const angle = (index * Math.PI) / 8;
    const long = index % 4 === 0;
    const r0 = r * (long ? 0.86 : 0.93);
    return { x1: c + Math.cos(angle) * r0, y1: c + Math.sin(angle) * r0, x2: c + Math.cos(angle) * r, y2: c + Math.sin(angle) * r };
  });
  return (
    <Svg height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <Circle cx={c} cy={c} fill="none" r={r} stroke={color} strokeWidth={size >= 72 ? 1.1 : 0.9} />
      <Circle cx={c} cy={c} fill="none" r={r * 0.66} stroke={color} strokeWidth={0.7} opacity={0.85} />
      <Circle cx={c} cy={c} fill="none" r={r * 0.4} stroke={color} strokeDasharray="1 2.6" strokeWidth={0.6} opacity={0.8} />
      {ticks.map((tick, index) => <Line key={index} stroke={color} strokeWidth={index % 4 === 0 ? 0.9 : 0.6} x1={tick.x1} x2={tick.x2} y1={tick.y1} y2={tick.y2} />)}
      <Line stroke={color} strokeWidth={0.55} x1={c - r} x2={c + r} y1={c} y2={c} opacity={0.7} />
      <Line stroke={color} strokeWidth={0.55} x1={c} x2={c} y1={c - r} y2={c + r} opacity={0.7} />
      <Line stroke={color} strokeWidth={0.75} x1={c - r * 0.62} x2={c + r * 0.62} y1={c + r * 0.62} y2={c - r * 0.62} opacity={0.9} />
      <Path d={`M ${c + r * 0.62} ${c - r * 0.62} l ${-r * 0.14} ${r * 0.02} l ${r * 0.06} ${r * 0.08} Z`} fill={color} opacity={0.9} />
      <Path d={starD(c, c, r * 0.16, r * 0.16)} fill="#C59861" opacity={0.95} />
      <Circle cx={c} cy={c} fill="#C59861" r={size >= 72 ? 2 : 1.4} />
    </Svg>
  );
}

function ChapterRail({ desc, en, mobile, no, title, yearValue }: { desc: string; en: string; mobile: boolean; no: string; title: string; yearValue?: number }) {
  // Keep the chapter metadata on a predictable baseline across all twelve
  // pages.  The longer English labels otherwise wrap in the narrow rail and
  // push the divider/description down by one line.
  const compactEnglish = en.length >= 15;
  return (
    <View style={[styles.lpRail, mobile && styles.lpRailMobile]}>
      <View style={styles.lpRailTop}>
        <View style={styles.lpRailIdentity}>
          <Text style={styles.lpRailNo}>{no}</Text>
          <Text style={styles.lpRailYear}>{displayYear(yearValue)}</Text>
          <View {...motionData("twinkle", 0)} style={styles.lpRailSpark}>
            <Svg height={30} viewBox="0 0 24 30" width={24}>
              <Path d={starD(12, 15, 5.5, 13, 0.13)} fill="#D9B58A" />
              <Path d={starD(12, 15, 5.2, 5.2, 0.3)} fill="#D9B58A" opacity={0.8} transform="rotate(45 12 15)" />
            </Svg>
          </View>
        </View>
        <View style={styles.lpRailCopy}>
          <Text numberOfLines={1} style={styles.lpRailTitle}>{title}</Text>
          <Text numberOfLines={1} style={[styles.lpRailEn, compactEnglish && styles.lpRailEnCompact]}>{en}</Text>
          <View style={styles.lpRailDash} />
          <Text numberOfLines={3} style={styles.lpRailDesc}>{desc}</Text>
        </View>
      </View>
      <View style={styles.lpRailBottom}>
        <View style={styles.lpRailPatternCopy}>
          <Text style={styles.lpRailPattern}>PATTERN</Text>
          <Text style={styles.lpRailObserved}>observed</Text>
        </View>
        {/* 全书唯一的 vt 锚点: 纸叶翻动时罗盘被 VT 单独截出, 钉在原位不跟叶转 */}
        <View {...vtAnchor} style={styles.lpRailRose}><CompassRose size={96} /></View>
      </View>
    </View>
  );
}

function FooterStar({ size = 40 }: { size?: number }) {
  // 参考稿 footer 左侧的八芒星徽: 4 长芒 + 45° 4 短芒, 线面结合
  const c = size / 2;
  return (
    <Svg height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <Path d={starD(c, c, c * 0.3, c * 0.98, 0.1)} fill="#A8875F" />
      <Path d={starD(c, c, c * 0.98, c * 0.3, 0.1)} fill="#A8875F" />
      <Path d={starD(c, c, c * 0.5, c * 0.5, 0.16)} fill="#8C7150" transform={`rotate(45 ${c} ${c})`} />
      <Circle cx={c} cy={c} fill="#C9A579" r={c * 0.11} />
      <Circle cx={c} cy={c} fill="none" r={c * 0.18} stroke="#141210" strokeWidth={1} />
    </Svg>
  );
}

function PatternFooter({ dots, text }: { dots: number; text: string }) {
  const full = Math.floor(dots);
  const hasHalf = dots - full >= 0.5;
  return (
    <View style={styles.lpFooter}>
      <View {...motionData("twinkle", 1)}><FooterStar size={46} /></View>
      <View style={styles.flex}>
        <Text style={styles.lpFooterLabel}>PATTERN</Text>
        <Text style={styles.lpFooterText}>{text}</Text>
      </View>
      <View style={styles.lpFooterCell}>
        <Text style={styles.lpFooterLabel}>EVIDENCE</Text>
        <View style={styles.lpDots}>{[0, 1, 2, 3, 4, 5].map((dot) => (
          <View key={dot} style={[styles.lpDot, dot < full && styles.lpDotOn]}>
            {dot === full && hasHalf ? <View style={styles.lpDotHalf} /> : null}
          </View>
        ))}</View>
      </View>
      <View style={[styles.lpFooterCell, styles.lpFooterLast]}>
        <Text style={styles.lpFooterLabel}>CONFIDENCE</Text>
        <Text style={styles.lpFooterConf}>{confLabel(dots)}</Text>
      </View>
    </View>
  );
}

function BlockTitle({ cn, en }: { cn: string; en?: string }) {
  return (
    <View style={styles.lpBlockTitle}>
      <Text numberOfLines={1} style={[styles.lpBlockCn, { flexShrink: 0 }]}>{cn}</Text>
      {en ? <Text numberOfLines={1} style={[styles.lpBlockEn, styles.flexShrinkable]}>/ {en}</Text> : null}
    </View>
  );
}

/* ---------- 05 你的节拍 / RHYTHM ---------- */

function windowRange(hours: number[], from: number, to: number): string {
  const band = hours.slice(from, to);
  const max = Math.max(...band);
  if (!max) return "—";
  const peak = from + band.indexOf(max);
  let start = peak;
  let end = peak;
  while (start - 1 >= from && (hours[start - 1] ?? 0) >= max * 0.5) start -= 1;
  while (end + 1 < to && (hours[end + 1] ?? 0) >= max * 0.5) end += 1;
  const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  return `${clock(start)} – ${clock(Math.min(24, end + 1))}`;
}

function twinPeaks(hours: number[]): number[] {
  const top = maxIndex(hours);
  if (top === null) return [];
  const rest = hours.map((value, index) => (Math.abs(index - top) >= 5 ? value : 0));
  const next = maxIndex(rest);
  if (next !== null && (hours[next] ?? 0) >= (hours[top] ?? 0) * 0.55 && timePhrase(next) !== timePhrase(top)) return [top, next].sort((a, b) => a - b);
  return [top];
}

export function rhythmPattern(model: ReportModel): string {
  const peaks = twinPeaks(model.hours);
  if (!peaks.length) return "时间证据不足，节拍仍在成形。";
  const weekdayPeak = maxIndex(hourly(model.heatmap, [0, 1, 2, 3, 4]));
  const weekendPeak = maxIndex(hourly(model.heatmap, [5, 6]));
  const tail = weekdayPeak === null || weekendPeak === null ? "" : weekendPeak - weekdayPeak >= 2 ? "，周末整体右移且延长" : weekdayPeak - weekendPeak >= 2 ? "，周末整体前移" : "，周末与工作日节奏相近";
  if (peaks.length === 2) return `你的节奏呈现「双峰」形态：${timePhrase(peaks[0]!)}与${timePhrase(peaks[1]!)}为内容高峰期${tail}。`;
  return `你的节奏呈现「单峰」形态：${timePhrase(peaks[0]!)}是内容高峰期${tail}。`;
}

function smoothHeatmap(cells: number[]): number[] {
  // 参考稿热力图是被云雾晕染的连续色场; 对 7×24 网格做一次邻域平滑逼近这种观感
  const out = new Array<number>(cells.length).fill(0);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 24; col++) {
      let total = 0;
      let weight = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r > 6 || c < 0 || c > 23) continue;
          const w = 1 / (1 + Math.abs(dr) * 1.6 + Math.abs(dc) * 0.9);
          total += (cells[r * 24 + c] ?? 0) * w;
          weight += w;
        }
      }
      out[row * 24 + col] = weight ? total / weight : 0;
    }
  }
  return out;
}

function HeatCloud({ cells }: { cells: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  // 分位数分档: 无论数据分布如何, 色档构成比例都贴近参考稿(暗 30%/teal 45%/金 25%)
  const sorted = [...cells].sort((a, b) => a - b);
  const q = (frac: number) => sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))] ?? 0;
  // 金档从 70 分位起, 覆盖 ~30% —— 参考稿金云占比明显大于 teal
  const cuts = [q(0.26), q(0.44), q(0.6), q(0.7), q(0.88)];
  const levelOf = (value: number): number => {
    if (sorted[sorted.length - 1] === 0) return 0;
    for (let index = 0; index < cuts.length; index++) if (value <= cuts[index]!) return index;
    return 5;
  };
  const cols = 24;
  const rows = 7;
  const cw = size.w / cols;
  const ch = size.h / rows;
  return (
    <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.rhCloud}>
      {size.w > 0 ? (
        <Svg height={size.h} width={size.w}>
          <Defs>
            {heatColors.map((color, index) => (
              <RadialGradient id={`rhHeatG${index}`} key={color}>
                <Stop offset="0" stopColor={color} stopOpacity={index >= 4 ? 0.78 : 0.68} />
                <Stop offset="0.6" stopColor={color} stopOpacity={index >= 4 ? 0.46 : 0.38} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          <Rect fill="#10191A" height={size.h} width={size.w} />
          {/* 云雾层: 每格一个横向拉长的柔边光斑, 相邻重叠融合成参考稿的连续色场 */}
          {cells.map((value, index) => {
            const level = levelOf(value);
            if (level === 0) return null;
            const row = Math.floor(index / cols);
            const col = index % cols;
            const spread = level >= 4 ? 2.3 : 1.9;
            return <Ellipse cx={(col + 0.5) * cw} cy={(row + 0.5) * ch} fill={`url(#rhHeatG${level})`} key={index} rx={cw * spread} ry={ch * spread * 0.62} />;
          })}
          {/* 每格确定性明暗抖动: 参考稿在连续云场上仍保留手工马赛克式的格间差; 暗区收敛保持纯净 */}
          {cells.map((value, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            const wobble = ((index * 29 + row * 13) % 21) - 10; // -10..10
            const damp = levelOf(value) >= 2 ? 1 : 0.42;
            return (
              <Rect
                fill={wobble >= 0 ? "#E0C7A8" : "#000000"}
                height={ch}
                key={`w${index}`}
                opacity={(Math.abs(wobble) / 100) * damp}
                width={cw}
                x={col * cw}
                y={row * ch}
              />
            );
          })}
          {/* 网格线压出格子分界 */}
          {Array.from({ length: cols + 1 }, (_, index) => <Line key={`v${index}`} opacity={0.7} stroke="#090C0C" strokeWidth={1.2} x1={index * cw} x2={index * cw} y1={0} y2={size.h} />)}
          {Array.from({ length: rows + 1 }, (_, index) => <Line key={`h${index}`} opacity={0.7} stroke="#090C0C" strokeWidth={1.2} x1={0} x2={size.w} y1={index * ch} y2={index * ch} />)}
        </Svg>
      ) : null}
    </View>
  );
}

function RhythmPage({ mobile, model }: PageArgs) {
  const heatCells = smoothHeatmap(model.heatmap);
  const windows: Array<{ icon: Icon; label: string; range: string }> = [
    { icon: Clock6, label: "清晨", range: windowRange(model.hours, 5, 11) },
    { icon: Clock12, label: "午后", range: windowRange(model.hours, 11, 17) },
    { icon: Clock9, label: "夜晚", range: windowRange(model.hours, 17, 24) },
  ];
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"你的时间心跳图谱，\n在日常与周期中\n呈现规律与偏好。"} en="RHYTHM" mobile={mobile} no="05" title="你的节拍" yearValue={model.year} />
      <View style={styles.flex}>
        <View style={[styles.rhTop, mobile && styles.stack]}>
          <View style={[styles.rhHeatBlock, !mobile && styles.lpBorderRight]}>
            <View style={styles.rhHeatHead}>
              <Text style={styles.lpBlockCn}>日 × 时 活跃热力图</Text>
              <View style={styles.rhLegend}>
                <Text style={styles.lpMuted}>低</Text>
                <View style={styles.rhSwatchWrap}>
                  {heatColors.slice(1).map((color) => <View key={color} style={[styles.rhSwatch, { backgroundColor: color }]} />)}
                </View>
                <Text style={styles.lpMuted}>高</Text>
              </View>
            </View>
            <View style={styles.rhHeatGrid}>
              <View style={styles.rhWeekCol}>
                {weekdays.map((day) => <Text key={day} style={styles.rhWeek}>周{day}</Text>)}
              </View>
              <HeatCloud cells={heatCells} />
            </View>
            <View style={styles.rhAxisRow}>
              {Array.from({ length: 12 }, (_, index) => <Text key={index} style={styles.rhAxisText}>{index * 2}</Text>)}
            </View>
          </View>
          <View style={styles.rhWindows}>
            <Text style={styles.lpBlockCn}>活跃窗口</Text>
            {windows.map(({ icon: WindowIcon, label, range }, index) => (
              <View key={label} style={[styles.rhWindow, index > 0 && styles.rhWindowDivider]}>
                <View style={styles.rhWinIcon}><WindowIcon color="#C09D73" size={17} strokeWidth={1.4} /></View>
                <View>
                  <Text style={styles.rhWinLabel}>{label}</Text>
                  <Text style={styles.rhWinRange}>{range}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View style={[styles.rhBottom, mobile && styles.stack]}>
          <View style={[styles.rhChartBlock, !mobile && styles.lpBorderRight]}>
            <Text style={styles.lpBlockCn}>会话节奏曲线</Text>
            <SessionCurve hours={model.hours} />
          </View>
          <View style={styles.rhChartBlock}>
            <Text style={styles.lpBlockCn}>工作日 vs 周末</Text>
            <View style={styles.rhWkLegendRow}>
              <View style={styles.rhWkLegend}>
                <View style={styles.rhLegendLine} />
                <Text style={styles.rhLegendText}>工作日</Text>
              </View>
              <View style={styles.rhWkLegend}>
                <View style={styles.rhLegendDashWrap}>{[0, 1, 2, 3].map((dash) => <View key={dash} style={styles.rhLegendDash} />)}</View>
                <Text style={styles.rhLegendText}>周末</Text>
              </View>
            </View>
            <WeekSplitChart weekday={hourly(model.heatmap, [0, 1, 2, 3, 4])} weekend={hourly(model.heatmap, [5, 6])} />
          </View>
        </View>
        <PatternFooter dots={model.evidence.watch.dots} text={rhythmPattern(model)} />
      </View>
    </View>
  );
}

function SessionCurve({ hours }: { hours: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const values = Array.from({ length: 13 }, (_, index) => (hours[(index * 2) % 24] ?? 0) + (hours[(index * 2 + 1) % 24] ?? 0));
  const max = Math.max(...values);
  const x = (index: number) => 24 + index * (size.w - 34) / 12;
  const y = (value: number) => (max ? size.h - 8 - value / max * (size.h - 22) : size.h - 8);
  const pts = values.map((value, index) => [x(index), y(value)] as [number, number]);
  return (
    <View style={styles.flex}>
      <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.rhChart}>
        {size.w > 0 ? (
          <Svg height={size.h} width={size.w}>
            <Defs>
              <LinearGradient id="rhCurveFill" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#3F666A" stopOpacity="0.38" />
                <Stop offset="1" stopColor="#223E40" stopOpacity="0.04" />
              </LinearGradient>
            </Defs>
            {[0.14, 0.5, 0.86].map((frac) => <Line key={frac} stroke="#26221E" strokeDasharray="2 5" strokeWidth={0.8} x1={24} x2={size.w - 10} y1={size.h * frac} y2={size.h * frac} />)}
            <Line stroke="#3C342A" strokeWidth={1} x1={24} x2={size.w - 10} y1={size.h - 8} y2={size.h - 8} />
            {max ? <Path d={`${smoothPath(pts, size.h - 8)} L ${pts[pts.length - 1]![0]} ${size.h - 8} L ${pts[0]![0]} ${size.h - 8} Z`} fill="url(#rhCurveFill)" stroke="none" /> : null}
            {max ? <Path d={smoothPath(pts, size.h - 8)} fill="none" stroke="#6FADB3" strokeWidth={1.6} /> : null}
            {max ? pts.map((pt, index) => (
              <Circle cx={pt[0]} cy={pt[1]} fill={index % 3 === 1 ? "#D9A86C" : "#7FB1B5"} key={index} r={(values[index] ?? 0) >= max * 0.85 ? 3.6 : 2.8} />
            )) : null}
          </Svg>
        ) : null}
        <Text style={[styles.rhYLabel, styles.rhYHigh]}>高</Text>
        <Text style={[styles.rhYLabel, styles.rhYMid]}>中</Text>
        <Text style={[styles.rhYLabel, styles.rhYLow]}>低</Text>
        {!max ? <Text style={styles.lpChartEmpty}>等待时间证据</Text> : null}
      </View>
      <View style={styles.rhXAxis}>{[0, 4, 8, 12, 16, 20, 24].map((hour) => <Text key={hour} style={styles.lpAxisText}>{hour}</Text>)}</View>
    </View>
  );
}

function WeekSplitChart({ weekday, weekend }: { weekday: number[]; weekend: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  // 2 小时粒度降采样, 与参考稿的平缓双线一致
  const bucket = (values: number[]) => Array.from({ length: 13 }, (_, index) => (values[(index * 2) % 24] ?? 0) + (values[(index * 2 + 1) % 24] ?? 0));
  const wd = bucket(weekday);
  const we = bucket(weekend);
  const max = Math.max(...wd, ...we);
  const x = (index: number) => 10 + index * (size.w - 20) / 12;
  const y = (value: number) => (max ? size.h - 8 - value / max * (size.h - 22) : size.h - 8);
  const line = (values: number[]) => smoothPath(values.map((value, index) => [x(index), y(value)] as [number, number]), size.h - 8);
  return (
    <View style={styles.flex}>
      <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.rhChart}>
        {size.w > 0 ? (
          <Svg height={size.h} width={size.w}>
            <Line stroke="#3C342A" strokeWidth={1} x1={10} x2={size.w - 10} y1={size.h - 8} y2={size.h - 8} />
            {max ? <Path d={line(wd)} fill="none" stroke="#6FADB3" strokeWidth={1.6} /> : null}
            {max ? <Path d={line(we)} fill="none" stroke="#C9985B" strokeDasharray="5 4" strokeWidth={1.5} /> : null}
          </Svg>
        ) : null}
        {!max ? <Text style={styles.lpChartEmpty}>等待时间证据</Text> : null}
      </View>
      <View style={styles.rhXAxis}>{[0, 6, 12, 18, 24].map((hour) => <Text key={hour} style={styles.lpAxisText}>{hour}</Text>)}</View>
    </View>
  );
}

/* ---------- 06 你如何停留 / ATTENTION ---------- */

export function attentionPattern(completion: number | null): string {
  if (completion === null) return "尚未采集观看进度，停留方式待观测。";
  if (completion >= 66) return "你更偏向「深度沉浸」，长时间的专注观看构成主线。";
  if (completion >= 33) return "你更偏向「平衡区间」，能在兴趣内容中形成稳定的停留。";
  return "你更偏向「碎片浏览」，在快速滑动中筛选感兴趣的内容。";
}

function AttentionPage({ mobile, model }: PageArgs) {
  const pcts = model.progressPercents;
  const share = (test: (value: number) => boolean) => (pcts.length ? pcts.filter(test).length / pcts.length * 100 : null);
  const done = share((value) => value >= 90);
  const stages: Array<{ icon: Icon; label: string; value: string }> = [
    { icon: Eye, label: "开始浏览", value: pcts.length ? "100%" : "—" },
    { icon: Play, label: "继续观看", value: pctLabel(share((value) => value >= 25)) },
    { icon: Target, label: "深度观看", value: pctLabel(share((value) => value >= 60)) },
    { icon: CircleCheck, label: "完成观看", value: pctLabel(done) },
  ];
  const outcomes: Array<{ icon: Icon; label: string; value: string }> = [
    { icon: SkipForward, label: "跳过", value: pctLabel(share((value) => value < 15)) },
    { icon: Pause, label: "暂停", value: "—" },
    { icon: RotateCcw, label: "重播", value: model.watch ? `${Math.round(model.replays / model.watch * 100)}%` : "—" },
    { icon: CircleCheck, label: "完成", value: pctLabel(done) },
  ];
  const band = model.completion === null ? null : model.completion >= 66 ? 0 : model.completion >= 33 ? 1 : 2;
  const dots = [1, 10, 50, 200, 1000].filter((threshold) => pcts.length >= threshold).length;
  const specColors = ["#7FC3C9", "#D8CCBD", "#C9985B"];
  const spectrum = [
    { name: "深度沉浸", desc: "长时观看\n专注连贯" },
    { name: "平衡区间", desc: "适度浏览\n间歇停留" },
    { name: "碎片浏览", desc: "快速滑动\n短暂停留" },
  ];
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"从开始到完成，\n观察注意力的流动\n与分布。"} en="ATTENTION" mobile={mobile} no="06" title="你如何停留" yearValue={model.year} />
      <View style={styles.flex}>
        <View style={[styles.atBody, mobile && styles.stack]}>
          <View style={styles.atMain}>
            <Text style={styles.lpBlockCn}>从开始到完成的旅程</Text>
            <View style={[styles.atFunnelRow, mobile && styles.stack]}>
              <View pointerEvents="none" style={styles.atFunnelBg}>
                <AttentionFunnel density={pcts.length ? Math.min(1, pcts.length / 200) : 0} />
                <Text style={styles.atDone}>完成</Text>
              </View>
              <View style={[styles.atStages, styles.atStagesLeft]}>
                {stages.map(({ icon: StageIcon, label, value }, index) => (
                  <View key={label} style={styles.atStage}>
                    <View style={[styles.atStageIcon, index === 0 && styles.atStageIconBare]}><StageIcon color="#9CC3C6" size={index === 0 ? 16 : 13} strokeWidth={1.5} /></View>
                    <View style={styles.flex}>
                      <Text numberOfLines={1} style={styles.atStageLabel}>{label}</Text>
                      <Text style={styles.atStageValue}>{value}</Text>
                    </View>
                    <View style={[styles.atLead, index === 0 && styles.atLeadHidden]} />
                  </View>
                ))}
              </View>
              <View style={[styles.atStages, styles.atStagesRight]}>
                {outcomes.map(({ icon: OutIcon, label, value }) => (
                  <View key={label} style={styles.atStage}>
                    <View style={styles.atLead} />
                    <View style={[styles.atStageIcon, styles.atStageIconGold]}><OutIcon color="#C9AA85" size={13} strokeWidth={1.5} /></View>
                    <View style={styles.flex}>
                      <Text numberOfLines={1} style={styles.atStageLabel}>{label}</Text>
                      <Text style={styles.atStageValue}>{value}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          </View>
          <View style={styles.atSpectrum}>
            <Text style={styles.lpBlockCn}>注意力光谱</Text>
            <View style={styles.atSpecBody}>
              <Svg height={316} width={30}>
                <Defs>
                  <LinearGradient id="atSpec" x1="0" x2="0" y1="0" y2="1">
                    <Stop offset="0" stopColor="#5E979C" />
                    <Stop offset="0.48" stopColor="#7F9DA0" />
                    <Stop offset="1" stopColor="#A98150" />
                  </LinearGradient>
                </Defs>
                <Rect fill="url(#atSpec)" height={300} rx={11} width={22} x={4} y={8} />
                <Rect fill="none" height={300} rx={11} stroke="#0E1212" strokeOpacity={0.5} strokeWidth={1} width={22} x={4} y={8} />
                <Rect fill="#8FCACF" height={10} opacity={0.85} rx={5} width={14} x={8} y={12} />
                <Rect fill="#D9A86C" height={10} opacity={0.85} rx={5} width={14} x={8} y={294} />
              </Svg>
              <View style={styles.atSpecLabels}>
                {spectrum.map((row, index) => (
                  <View key={row.name} style={styles.atSpecRow}>
                    <Text style={[styles.atSpecMark, band === index && styles.atSpecMarkOn]}>▶</Text>
                    <View>
                      <Text style={[styles.atSpecName, { color: specColors[index] }]}>{row.name}</Text>
                      <Text style={styles.atSpecDesc}>{row.desc}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          </View>
        </View>
        <PatternFooter dots={dots} text={attentionPattern(model.completion)} />
      </View>
    </View>
  );
}

// 剖面按预览图 page-06-hi 逐行实测的归一化半宽重采样(锥口 y=30 半宽 148, 焦点 y=371)。
// 高 ÷ 锥口半宽 = 346/148 = 2.34，对齐预览的 476.5/204 = 2.34。取 17 个控制点是为了
// 让样条贴着实测曲线走 —— 点太稀时相邻段斜率不连续，锥壁中段会鼓出一块。
const funnelLevels: Array<[number, number]> = [[30, 148], [52, 131.9], [73, 117.8], [95, 105.3], [117, 94.1], [138, 83.4], [160, 73.6], [181, 64.9], [203, 57.1], [225, 50.4], [246, 44.5], [268, 39], [290, 33], [311, 26.4], [333, 20.5], [354, 16.4], [376, 13.2]];
// 截面椭圆的 ry/rx: 预览锥口远弧 y=171、近弧 y=222 → ry=25.5, rx=204
const FUNNEL_TILT = 0.125;
// 预览只有 3 条内环，中心相对高度 0.272 / 0.525 / 0.743
const funnelRings = [124, 212, 287];
function funnelWidth(y: number): number {
  for (let index = 0; index < funnelLevels.length - 1; index += 1) {
    const [y1, w1] = funnelLevels[index]!;
    const [y2, w2] = funnelLevels[index + 1]!;
    if (y <= y2) return w1 + (w2 - w1) * (y - y1) / (y2 - y1);
  }
  return 13;
}

const FUNNEL_APEX = { x: 190, y: 376 };
/**
 * 涡旋粒子：真的按柱坐标积分——u 指数下沉，角速度按 (U0/u)^0.55 随收缩加快(角动量守恒的近似)，
 * 再以 0.15 的椭圆压扁投影成锥体横截面。CSS transform 做不到这件事：绕竖轴的旋转投影到画面上
 * 依赖每个粒子自己的高度 u，不是一个仿射变换，硬拆成 scaleY/rotate 会把圆点拉成横条。
 */
const VORTEX_TOP = 356;
const VORTEX_FLOOR = 10;
const VORTEX_FILLS = ["url(#atDotCool)", "url(#atDotWarm)", "url(#atDotHot)"];
// 预览的粒子是有高斯外晕的发光点，不是实心圆；用径向渐变填充 + 放大半径来给
const VORTEX_DOT_STOPS: Array<[string, string]> = [["atDotCool", "#CFE4E6"], ["atDotWarm", "#C7A172"], ["atDotHot", "#EBCCA6"]];
// 晕的外径 ÷ 亮核半径
const VORTEX_HALO = 2.0;
const hash = (seed: number) => { const value = Math.sin(seed) * 43758.5453; return value - Math.floor(value); };

export interface VortexDot { theta: number; u: number; rho: number; arm: number; spin: number; size: number; seed: number; bucket: number }

const VORTEX_ARMS = 3;
const VORTEX_RIM_OMEGA = 0.5;
// 预览的粒子是缓缓下沉的; 之前一圈不到 2 秒, 像水槽排水
const VORTEX_SPEED = 0.42;
// u 上均匀分布 → 面密度 ∝ 1/u，锥口铺满而焦点自然收紧；指数下沉会把上半段抽空
const vortexFall = (u: number) => 24 + 62 * (1 - u / VORTEX_TOP) ** 1.6;
const armAngle = (arm: number, at: number) => (arm * 2 * Math.PI) / VORTEX_ARMS + at * VORTEX_RIM_OMEGA;

export function spawnVortex(count: number): VortexDot[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index * 1.37 + 0.11;
    const u = VORTEX_FLOOR + (VORTEX_TOP - VORTEX_FLOOR) * hash(n * 1.7);
    return {
      // 首帧就按"离开锥口后越转越快"的螺旋铺好，否则要等一整个生命周期旋臂才成形
      theta: armAngle(index % VORTEX_ARMS, 0) + 4.2 * (1 - u / VORTEX_TOP) + hash(n * 3.1) * 0.9,
      u,
      rho: Math.sqrt(hash(n * 5.9 + 1.1)) * 0.94,
      arm: index % VORTEX_ARMS,
      spin: 0.95 + hash(n * 9.4 + 3.3) * 0.12,
      size: 0.5 + hash(n * 7.3 + 2.7) ** 2 * 1.05,
      seed: n,
      bucket: -1,
    };
  });
}

export function stepVortex(dot: VortexDot, dt: number, at: number): void {
  // 角动量守恒的近似：截面收缩多少，角速度就补回来多少
  dot.theta += dot.spin * VORTEX_RIM_OMEGA * (VORTEX_TOP / Math.max(dot.u, VORTEX_FLOOR)) ** 0.55 * dt;
  dot.u -= vortexFall(dot.u) * dt;
  if (dot.u > VORTEX_FLOOR) return;
  dot.seed += 7.13;
  dot.u = VORTEX_TOP;
  // 从旋臂当前所在的角度重新投放，旋臂才不会随时间被打散
  dot.theta = armAngle(dot.arm, at) + hash(dot.seed * 3.1) * 0.9;
  dot.rho = Math.sqrt(hash(dot.seed * 5.9 + 1.1)) * 0.94;
}

export function vortexFrame(dot: VortexDot) {
  const height = dot.u / VORTEX_TOP;
  const y = FUNNEL_APEX.y - dot.u;
  // sqrt 收核: 越靠焦点越贴近轴心, 否则粒子只是沿锥壁滑下来
  const radius = dot.rho * (0.58 + 0.42 * Math.sqrt(height)) * funnelWidth(y) * 0.92;
  const front = (Math.sin(dot.theta) + 1) / 2;
  const fade = Math.min(1, (VORTEX_TOP - dot.u) / 12, (dot.u - VORTEX_FLOOR) / 26);
  return {
    cx: FUNNEL_APEX.x + Math.cos(dot.theta) * radius,
    // 与截面环同一套透视，粒子才落在锥体的横截圆盘上
    cy: y + Math.sin(dot.theta) * radius * FUNNEL_TILT,
    r: dot.size * (0.75 + 0.25 * height) * (0.86 + 0.28 * front) * VORTEX_HALO,
    opacity: Math.min(0.96, (0.26 + (1 - height) * 0.48 + front * 0.16) * fade),
    bucket: height < 0.1 ? 2 : height < 0.3 ? 1 : 0,
  };
}

function AttentionFunnel({ density }: { density: number }) {
  const leftPts = funnelLevels.map(([y, w]) => [190 - w, y] as [number, number]);
  const rightPts = funnelLevels.slice().reverse().map(([y, w]) => [190 + w, y] as [number, number]);
  const leftPath = smoothPath(leftPts);
  const rightPath = smoothPath(rightPts);
  const [rimY, rimW] = funnelLevels[0]!;
  const rimRy = rimW * FUNNEL_TILT;
  // 收口走椭圆的近弧: 之前用 Z 直接横着封口, 锥口的近弧就压在填充上, 看着像把顶部切成两半
  const rimNear = `A ${rimW} ${rimRy} 0 0 1 ${190 - rimW} ${rimY}`;
  const silhouette = `${leftPath} L ${rightPts[0]![0]} ${rightPts[0]![1]} ${rightPath.slice(rightPath.indexOf("C"))} ${rimNear} Z`;
  const dots = useMemo(() => spawnVortex(175 + Math.round(Math.max(0, Math.min(1, density)) * 140)), [density]);
  const layer = useRef<View>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    const node = layer.current as unknown as HTMLElement | null;
    const nodes = node?.querySelectorAll<SVGCircleElement>("circle");
    if (!nodes || nodes.length !== dots.length) return undefined;
    let last = performance.now();
    let elapsed = 0;
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000) * VORTEX_SPEED;
      last = now;
      elapsed += dt;
      for (let index = 0; index < dots.length; index += 1) {
        const dot = dots[index]!;
        stepVortex(dot, dt, elapsed);
        const frame = vortexFrame(dot);
        const el = nodes[index]!;
        el.setAttribute("cx", frame.cx.toFixed(2));
        el.setAttribute("cy", frame.cy.toFixed(2));
        el.setAttribute("r", frame.r.toFixed(2));
        el.setAttribute("opacity", frame.opacity.toFixed(3));
        if (frame.bucket !== dot.bucket) {
          dot.bucket = frame.bucket;
          el.setAttribute("fill", VORTEX_FILLS[frame.bucket]!);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [dots]);

  return (
    <View style={styles.atFunnelStack}>
      <Svg height={378} viewBox="0 0 380 410" width={351}>
        <Defs>
          <LinearGradient id="atBody" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor="#2E696E" stopOpacity={0.38} />
            <Stop offset="0.68" stopColor="#2E696E" stopOpacity={0.38} />
            <Stop offset="0.83" stopColor="#7A5C38" stopOpacity={0.34} />
            <Stop offset="1" stopColor="#B0762E" stopOpacity={0.3} />
          </LinearGradient>
          {/* 中轴亮、锥壁暗: 预览 t=0.4 时中轴 70 / 边缘 53，这道纵向光柱是空腔感的来源 */}
          <LinearGradient id="atCore" x1="0" x2="1" y1="0" y2="0">
            <Stop offset="0" stopColor="#9CC9CD" stopOpacity={0} />
            <Stop offset="0.24" stopColor="#9CC9CD" stopOpacity={0.02} />
            <Stop offset="0.47" stopColor="#A8D0D4" stopOpacity={0.105} />
            <Stop offset="0.72" stopColor="#9CC9CD" stopOpacity={0.02} />
            <Stop offset="1" stopColor="#16292B" stopOpacity={0.1} />
          </LinearGradient>
          <LinearGradient id="atMouth" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor="#151919" stopOpacity={1} />
            <Stop offset="0.7" stopColor="#161A1A" stopOpacity={1} />
            <Stop offset="1" stopColor="#1E2526" stopOpacity={1} />
          </LinearGradient>
          <LinearGradient id="atMouthX" x1="0" x2="1" y1="0" y2="0">
            <Stop offset="0" stopColor="#6FA9AE" stopOpacity={0.075} />
            <Stop offset="0.18" stopColor="#6FA9AE" stopOpacity={0.03} />
            <Stop offset="0.42" stopColor="#6FA9AE" stopOpacity={0} />
            <Stop offset="0.64" stopColor="#6FA9AE" stopOpacity={0} />
            <Stop offset="0.85" stopColor="#6FA9AE" stopOpacity={0.015} />
            <Stop offset="1" stopColor="#6FA9AE" stopOpacity={0.032} />
          </LinearGradient>
          <LinearGradient id="atEdge" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor="#5E8E92" stopOpacity={0.7} />
            <Stop offset="0.66" stopColor="#5E8E92" stopOpacity={0.7} />
            <Stop offset="0.84" stopColor="#9C794E" stopOpacity={0.6} />
            <Stop offset="1" stopColor="#C9A170" stopOpacity={0.7} />
          </LinearGradient>
        </Defs>
        <Ellipse cx={190} cy={rimY} fill="url(#atMouth)" rx={rimW} ry={rimRy} />
        <Ellipse cx={190} cy={rimY} fill="url(#atMouthX)" rx={rimW} ry={rimRy} />
        <Path d={silhouette} fill="url(#atBody)" />
        <Path d={silhouette} fill="url(#atCore)" />
        <Path d={leftPath} fill="none" stroke="url(#atEdge)" strokeWidth={1.15} />
        <Path d={rightPath} fill="none" stroke="url(#atEdge)" strokeWidth={1.15} />
        {funnelRings.map((y) => {
          const w = funnelWidth(y);
          const ry = Math.max(2.5, w * FUNNEL_TILT);
          // 远弧被锥体自身挡住, 预览里几乎看不见; 画成一条淡线, 近弧才是实线
          return (
            <React.Fragment key={y}>
              <Path d={`M ${190 - w} ${y} A ${w} ${ry} 0 0 1 ${190 + w} ${y}`} fill="none" stroke="#6D9CA0" strokeOpacity={0.16} strokeWidth={0.9} />
              <Path d={`M ${190 + w} ${y} A ${w} ${ry} 0 0 1 ${190 - w} ${y}`} fill="none" stroke="#5A8F94" strokeOpacity={0.45} strokeWidth={0.9} />
            </React.Fragment>
          );
        })}
        <Path d={`M ${190 - rimW} ${rimY} A ${rimW} ${rimRy} 0 0 1 ${190 + rimW} ${rimY}`} fill="none" stroke="#4A7174" strokeOpacity={0.5} strokeWidth={0.8} />
        {/* 唇口有厚度: 近弧上方 1.6 单位处先压一条暗线(内壁背光), 预览轴心 y=220 暗、222 亮 */}
        <Path d={`M ${190 + rimW} ${rimY} A ${rimW} ${rimRy - 1.6} 0 0 1 ${190 - rimW} ${rimY}`} fill="none" stroke="#070D0D" strokeOpacity={0.9} strokeWidth={1.8} />
        <Path d={`M ${190 + rimW} ${rimY} ${rimNear}`} fill="none" stroke="#6B9CA0" strokeOpacity={0.6} strokeWidth={1.2} />
      </Svg>
      <View pointerEvents="none" ref={layer} style={styles.atFunnelLayer}>
        <Svg height={378} viewBox="0 0 380 410" width={351}>
          <Defs>
            {VORTEX_DOT_STOPS.map(([id, color]) => (
              <RadialGradient id={id} key={id}>
                <Stop offset="0" stopColor={color} stopOpacity={1} />
                <Stop offset="0.32" stopColor={color} stopOpacity={0.9} />
                <Stop offset="0.58" stopColor={color} stopOpacity={0.3} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          {dots.map((dot, index) => {
            const frame = vortexFrame(dot);
            return <Circle cx={frame.cx} cy={frame.cy} fill={VORTEX_FILLS[frame.bucket]} key={index} opacity={frame.opacity} r={frame.r} />;
          })}
        </Svg>
      </View>
      <View pointerEvents="none" style={styles.atFunnelLayer}>
        <Svg height={378} viewBox="0 0 380 410" width={351}>
          <Defs>
            {/* 预览实测: 峰值 186 → d=8px 107 → d=16px 46 → d=25px 归零，比原来的线性晕紧得多 */}
            <RadialGradient id="atGlow">
              <Stop offset="0" stopColor="#FFD9AB" stopOpacity={0.95} />
              <Stop offset="0.32" stopColor="#F2B56A" stopOpacity={0.5} />
              <Stop offset="0.64" stopColor="#E0A155" stopOpacity={0.15} />
              <Stop offset="1" stopColor="#E0A155" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="atFlare">
              <Stop offset="0" stopColor="#FFD6A4" stopOpacity={0.8} />
              <Stop offset="0.45" stopColor="#F0B771" stopOpacity={0.28} />
              <Stop offset="1" stopColor="#F0B771" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={190} cy={376} fill="url(#atGlow)" r={19} />
          <Ellipse cx={190} cy={376} fill="url(#atFlare)" rx={26} ry={1.5} />
          <Ellipse cx={190} cy={376} fill="url(#atFlare)" rx={1.3} ry={19} />
          <Circle cx={190} cy={376} fill="#F3BE7E" opacity={0.92} r={6.2} />
          <Circle cx={190} cy={376} fill="#FCCE95" r={3.6} />
        </Svg>
      </View>
    </View>
  );
}

/* ---------- 07 内容回声 / CONTENT ECHO ---------- */

export function contentPattern(topics: Ranked[]): string {
  if (!topics.length) return "主题证据不足，回声尚未成形。";
  if (topics.length === 1) return `你的共振集中于「${topics[0]!.name}」，并在多形式中形成稳定互动。`;
  return `你的共振集中于「${topics[0]!.name}与${topics[1]!.name}」，并在多形式中形成稳定互动。`;
}

function ContentPage({ mobile, model }: PageArgs) {
  const rankColors = ["#47777B", "#4E787C", "#8A6940", "#A98558"];
  const formatDefs: Array<{ display: string; icon: Icon; key: string }> = [
    { display: "视频", icon: Play, key: "视频" },
    { display: "图像", icon: ImageIcon, key: "图文" },
    { display: "直播", icon: Radio, key: "直播" },
  ];
  const formats = formatDefs.map((def) => ({ ...def, share: model.formats.find((item) => item.name === def.key)?.share ?? 0 }));
  const formatTotal = formats.reduce((sum, item) => sum + item.share, 0);
  const topics = model.topics.slice(0, 4);
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"你与内容的共振，\n在主题、形式与互动中\n形成回声。"} en="CONTENT ECHO" mobile={mobile} no="07" title="内容回声" yearValue={model.year} />
      <View style={styles.flex}>
        <View style={[styles.ceBody, mobile && styles.stack]}>
          <View style={[styles.ceCol1, !mobile && styles.lpBorderRight]}>
            <View style={[styles.ceBlock, styles.flex]}>
              <Text style={styles.lpBlockCn}>主题星座图</Text>
              <TopicConstellation topics={topics} />
            </View>
            <View style={[styles.ceBlock, styles.lpBorderTop]}>
              <Text style={styles.lpBlockCn}>观看 × 点赞 × 收藏 交集</Text>
              <KeptVenn intersection={model.intersection} totals={{ watch: model.watch, liked: model.liked, favorite: model.favorite }} />
            </View>
          </View>
          <View style={styles.ceCol2}>
            <View style={styles.ceTopRow}>
              <View style={[styles.ceBlock, styles.ceFormats, !mobile && styles.lpBorderRight]}>
                <Text style={styles.lpBlockCn}>内容形式占比</Text>
                <View style={styles.ceFormatRow}>
                  {formats.map(({ display, icon: FormatIcon, share }) => (
                    <View key={display} style={styles.ceFormatCell}>
                      <View style={styles.ceFormatTile}><FormatIcon color="#C9AA85" size={16} strokeWidth={1.4} /></View>
                      <Text style={styles.ceFormatName}>{display}</Text>
                      <Text style={styles.ceFormatValue}>{formatTotal ? `${Math.round(share / formatTotal * 100)}%` : "—"}</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.ceSegments}>
                  {formatTotal ? formats.filter((item) => item.share > 0).map((item, index) => (
                    <View key={item.display} style={[styles.ceSegment, { flex: item.share, backgroundColor: ["#4E868B", "#C59861", "#8A6A42"][index % 3] }]} />
                  )) : <View style={[styles.ceSegment, styles.ceSegmentEmpty]} />}
                </View>
              </View>
              <View style={[styles.ceBlock, styles.flex]}>
                <Text style={styles.lpBlockCn}>时长分布</Text>
                {model.durationBands.map((bandItem, index) => (
                  <View key={bandItem.label} style={styles.ceDurRow}>
                    <Text style={styles.ceDurLabel}>{bandItem.label}</Text>
                    <Text style={styles.ceDurEn}>{bandItem.en}</Text>
                    <View style={styles.ceDurTrack}>
                      {bandItem.share !== null ? <View style={[styles.ceDurFill, { width: `${Math.max(3, bandItem.share * 82)}%`, backgroundColor: ["#4E787C", "#47777B", "#A98558", "#8A6940"][index] }]} /> : null}
                      <View style={styles.ceRankDash} />
                    </View>
                    <Text style={styles.ceDurValue}>{bandItem.share === null ? "—" : `${Math.round(bandItem.share * 100)}%`}</Text>
                  </View>
                ))}
              </View>
            </View>
            <View style={[styles.ceBlock, styles.lpBorderTop, styles.flex]}>
              <Text style={styles.lpBlockCn}>主题强度排名（匿名）</Text>
              <View style={styles.ceRankList}>
                {topics.length ? topics.map((topic, index) => (
                  <View key={topic.name} style={styles.ceRankRow}>
                    <Text style={styles.ceRankNo}>{index + 1}</Text>
                    <Text numberOfLines={1} style={styles.ceRankName}>{topic.name}</Text>
                    <View style={styles.ceRankTrack}>
                      <View style={[styles.ceRankFill, { width: `${Math.max(8, topic.count / (topics[0]!.count || 1) * 62)}%`, backgroundColor: rankColors[index] }]} />
                      <View style={styles.ceRankDash} />
                    </View>
                    <Text style={styles.ceRankValue}>{`${Math.round(topic.share * 100)}%`}</Text>
                  </View>
                )) : <Text style={styles.lpEmpty}>等待主题证据</Text>}
              </View>
              <Text style={styles.ceNote}>* 排名不代表价值，仅反映相对强度。</Text>
            </View>
          </View>
        </View>
        <PatternFooter dots={model.evidence.kept.dots} text={contentPattern(model.topics)} />
      </View>
    </View>
  );
}

function TopicConstellation({ topics }: { topics: Ranked[] }) {
  // 预期稿布局: 知识在上(最亮), 生活在右, 娱乐在下, 灵感在左; 三圈斜轨道 + 节点间虚线网
  const nodes = [
    { x: 196, y: 40, color: "#E9F1F2", glow: 17, r: 8.5 },
    { x: 252, y: 120, color: "#9CC3C6", glow: 13, r: 6.4 },
    { x: 152, y: 196, color: "#D9A86C", glow: 12, r: 6.4 },
    { x: 46, y: 96, color: "#C9985B", glow: 13, r: 6.4 },
  ];
  const sparks = Array.from({ length: 92 }, (_, index) => ({
    x: (index * 53 + 17) % 290 + 5,
    y: (index * 91 + 29) % 210 + 8,
    r: index % 7 === 0 ? 1.7 : index % 3 === 0 ? 1.2 : 0.9,
    opacity: 0.28 + ((index * 31) % 50) / 100,
  }));
  const wrap = useRef<View>(null);
  // 星系转动: 内圈快外圈慢(角速度 ~ 1/r), 星野最慢当远景。节点组整体公转, 组内每个节点
  // 再绕自身反向等速转一圈 —— 两次旋转的转角互相抵消, 净效果是纯平移, 所以标签始终水平。
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // 文档序即 JSX 书写序: 星野 / 外中内三圈 / 节点组, 之后是节点组内的 4 个反转组
    const gs = (wrap.current as unknown as HTMLElement | null)?.querySelectorAll<SVGGElement>("g");
    if (!gs) return;
    const spin = (el: SVGGElement | undefined, secs: number, ox: number, oy: number, back = false) => {
      if (!el) return;
      el.style.transformBox = "view-box";
      el.style.transformOrigin = `${ox}px ${oy}px`;
      el.style.animation = `${back ? "galaxySpinBack" : "galaxySpin"} ${secs}s linear infinite`;
    };
    [420, 176, 112, 68, 148].forEach((secs, index) => spin(gs[index], secs, 150, 114));
    nodes.forEach((node, index) => spin(gs[5 + index], 148, node.x, node.y, true));
  }, []);
  return (
    <View ref={wrap} style={styles.ceConstWrap}>
      <Svg height={330} viewBox="0 0 300 224" width={452}>
        <Defs>
          <RadialGradient id="ceSun">
            <Stop offset="0" stopColor="#E7BC87" stopOpacity={0.8} />
            <Stop offset="1" stopColor="#F2C389" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <G>{sparks.map((spark, index) => <Circle cx={spark.x} cy={spark.y} fill="#D8CFC4" key={index} opacity={spark.opacity} r={spark.r} />)}</G>
        <G><Ellipse cx={150} cy={114} fill="none" rx={132} ry={86} stroke="#536D6F" strokeDasharray="2 5" strokeWidth={1.1} transform="rotate(-6 150 114)" /></G>
        <G><Ellipse cx={150} cy={114} fill="none" rx={96} ry={60} stroke="#536D6F" strokeDasharray="2 5" strokeWidth={1.1} transform="rotate(4 150 114)" /></G>
        <G><Ellipse cx={150} cy={114} fill="none" rx={56} ry={34} stroke="#536D6F" strokeDasharray="2 5" strokeWidth={1.1} /></G>
        <Circle cx={150} cy={114} fill="url(#ceSun)" r={40} />
        <Circle cx={150} cy={114} fill="#E3BC8C" r={8.5} />
        {[[212, 74], [96, 168], [230, 168]].map(([sx, sy], index) => (
          <Path d={starD(sx!, sy!, 3.4, 3.4, 0.3)} fill="#C79E6B" key={`deco-${index}`} opacity={0.8} />
        ))}
        <G>
          {[[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => (topics[a!] && topics[b!] ? (
            <Line key={`web-${a}-${b}`} opacity={0.75} stroke="#5A7274" strokeDasharray="1 4" strokeWidth={1} x1={nodes[a!]!.x} x2={nodes[b!]!.x} y1={nodes[a!]!.y} y2={nodes[b!]!.y} />
          ) : null))}
          {nodes.map((node, index) => (topics[index] ? <Line key={index} stroke="#556E70" strokeDasharray="1 4" strokeWidth={1} x1={150} x2={node.x} y1={114} y2={node.y} /> : null))}
          {nodes.map((node, index) => {
            const topic = topics[index];
            return (
              <G key={index}>
                <Circle cx={node.x} cy={node.y} fill={node.color} opacity={topic ? 0.3 : 0.05} r={node.glow} />
                <Circle cx={node.x} cy={node.y} fill={topic ? node.color : "#3A4546"} r={topic ? node.r : 3.5} />
                {topic ? <SvgText fill="#E4D7C8" fontFamily={serif} fontSize={14.5} textAnchor={node.y > 180 ? "middle" : node.x > 150 ? "start" : "end"} x={node.y > 180 ? node.x : node.x + (node.x > 150 ? 14 : -14)} y={node.y > 180 ? node.y + 22 : node.y + 5}>{topic.name}</SvgText> : null}
              </G>
            );
          })}
        </G>
      </Svg>
    </View>
  );
}

function KeptVenn({ intersection, totals }: { intersection: ReportModel["intersection"]; totals: { watch: number; liked: number; favorite: number } }) {
  const circles: Array<{ cx: number; cy: number; stroke: string; icon: Icon; label: string; count: number; ix: number; iy: number }> = [
    { cx: 105, cy: 55, stroke: "#7FB0B4", icon: Eye, label: "观看", count: totals.watch, ix: 97, iy: 30 },
    { cx: 76, cy: 102, stroke: "#C9985B", icon: Heart, label: "点赞", count: totals.liked, ix: 42, iy: 106 },
    { cx: 134, cy: 102, stroke: "#A8804F", icon: Star, label: "收藏", count: totals.favorite, ix: 138, iy: 106 },
  ];
  const scale = 1.42;
  return (
    <View style={styles.ceVennWrap}>
      <Svg height={158 * scale} viewBox="0 0 210 158" width={210 * scale}>
        {circles.map((circle) => (
          <Circle cx={circle.cx} cy={circle.cy} fill={circle.stroke} fillOpacity={0.12} key={circle.label} r={44} stroke={circle.stroke} strokeOpacity={0.8} strokeWidth={1} />
        ))}
        <Path d={starD(105, 88, 6, 6, 0.3)} fill="#E7BC87" opacity={0.95} />
      </Svg>
      {circles.map(({ icon: VennIcon, ix, iy, label, stroke }) => (
        <View key={label} pointerEvents="none" style={[styles.ceVennTag, { left: ix * scale, top: iy * scale }]}>
          <VennIcon color={stroke} size={15} strokeWidth={1.5} />
          <Text style={styles.ceVennLabel}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

/* ---------- 08 创作者宇宙 / CREATOR UNIVERSE ---------- */

export function creatorsPattern(model: ReportModel): string {
  const exploration = model.axes[2]?.value ?? null;
  if (exploration === null) return "创作者证据不足，宇宙尚未展开。";
  if (exploration >= 55) return "你的创作者宇宙「广度优先」，长尾丰富，重复访问形成稳定核心。";
  return "你的创作者宇宙「深度优先」，少数熟悉的创作者构成稳定核心。";
}

function CreatorsPage({ mobile, model, privacy }: PageArgs) {
  const top3 = model.creators.slice(0, 3);
  const labels = [0, 1, 2].map((index) => (top3[index] ? (privacy ? `creator ${"ABC"[index]}` : top3[index]!.name) : null));
  const extras = Math.min(5, Math.max(0, model.creatorsCount - 3));
  const focus = model.creatorFocus;
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"你关注的创作者构成，\n勾勒出一个广度与深度\n并存的宇宙。"} en="CREATOR UNIVERSE" mobile={mobile} no="08" title="创作者宇宙" yearValue={model.year} />
      <View style={styles.flex}>
        <View style={[styles.cuBody, mobile && styles.stack]}>
          <View style={styles.cuMap}>
            <CreatorUniverse extras={extras} labels={labels} shares={top3.map((creator) => creator.share)} />
            {!model.creatorsCount ? <Text style={styles.lpEmpty}>等待创作者证据</Text> : null}
          </View>
          <View style={styles.cuRail}>
            <View style={styles.cuBlock}>
              <Text style={styles.lpBlockCn}>创作者集中度</Text>
              <View style={styles.cuDonutWrap}>
                <Donut value={focus.concentration} />
                <Text style={styles.cuDonutValue}>{pctLabel(focus.concentration)}</Text>
              </View>
              <Text style={styles.cuHint}>（越低越分散）</Text>
            </View>
            <View style={[styles.cuBlock, styles.lpBorderTop]}>
              <Text style={styles.lpBlockCn}>发现 vs 重复访问</Text>
              <DiscoveryGauge discovery={focus.discovery} />
              <View style={styles.cuLegendRow}>
                <Text {...motionData("twinkle", 2)} style={styles.cuLegendSpark}>✦</Text>
                <Text style={styles.lpMuted}>发现</Text>
                <View style={styles.cuLegendDot} />
                <Text style={styles.lpMuted}>重复访问</Text>
              </View>
            </View>
            <View style={[styles.cuBlock, styles.lpBorderTop, styles.flex]}>
              <Text style={styles.lpBlockCn}>长尾分布</Text>
              <TailChart tail={focus.tail} />
            </View>
          </View>
        </View>
        <PatternFooter dots={model.evidence.creators.dots} text={creatorsPattern(model)} />
      </View>
    </View>
  );
}

function CreatorUniverse({ extras, labels, shares }: { extras: number; labels: Array<string | null>; shares: number[] }) {
  const nodes = [
    { x: 348, y: 92, label: [320, 56] as const },
    { x: 432, y: 262, label: [396, 296] as const },
    { x: 156, y: 368, label: [118, 402] as const },
  ];
  const persons: Array<[number, number]> = [[116, 208], [226, 118], [378, 388], [452, 152], [80, 310]];
  const sparks = useMemo(() => Array.from({ length: 170 }, (_, index) => ({
    x: (index * 73 + 31) % 496 + 12,
    y: (index * 113 + 47) % 472 + 12,
    r: index % 6 === 0 ? 2.3 : index % 3 === 0 ? 1.7 : 1.2,
    color: index % 9 === 0 ? "#E3B276" : index % 5 === 0 ? "#A9D0D3" : "#E4DBD0",
    opacity: 0.35 + ((index * 37) % 55) / 100,
  })), []);
  const wrap = useRef<View>(null);
  // 星野呼吸: 每颗星自己的静态 opacity 存进 --star, 动画只在 0.32x~1x 之间摆; 周期和相位
  // 按序号错开, 否则 170 颗星整齐地一起明灭, 看着像屏幕在闪。
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // 星野是 svg 里最先画的一批 circle, 索引与 sparks 一一对应
    const stars = (wrap.current as unknown as HTMLElement | null)?.querySelectorAll<SVGCircleElement>("circle");
    if (!stars) return;
    sparks.forEach((spark, index) => {
      const el = stars[index];
      if (!el) return;
      el.style.transformBox = "fill-box";
      el.style.transformOrigin = "center";
      el.style.setProperty("--star", String(spark.opacity));
      // 负延时: 动画挂上的那一帧就已在周期中段, 正延时会先按原透明度停住再猛地跳到 0% 关键帧, 那一下就是闪
      const secs = 3.1 + (index % 17) * 0.29;
      el.style.animation = `starBreathe ${secs.toFixed(2)}s ease-in-out -${((index * 0.41) % secs).toFixed(2)}s infinite`;
    });
  }, [sparks]);
  return (
    <View ref={wrap} style={styles.cuMapWrap}>
      <Svg height={540} viewBox="0 0 520 500" width={562}>
        <Defs>
          <RadialGradient id="cuCore">
            <Stop offset="0" stopColor="#EFD6B8" stopOpacity={0.7} />
            <Stop offset="1" stopColor="#EFD6B8" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="cuGold">
            <Stop offset="0" stopColor="#E3BC8C" stopOpacity={0.75} />
            <Stop offset="1" stopColor="#E3BC8C" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {sparks.map((spark, index) => <Circle cx={spark.x} cy={spark.y} fill={spark.color} key={index} opacity={spark.opacity} r={spark.r} />)}
        {[64, 110, 156, 202, 242].map((radius) => <Circle cx={260} cy={250} fill="none" key={radius} r={radius} stroke="#526668" strokeDasharray="2 4" strokeWidth={1.2} />)}
        {Array.from({ length: 8 }, (_, spoke) => {
          const rad = (spoke * 45 * Math.PI) / 180;
          return <Line key={`spoke-${spoke}`} opacity={0.42} stroke="#567072" strokeDasharray="1 4" strokeWidth={0.9} x1={260 + Math.cos(rad) * 34} x2={260 + Math.cos(rad) * 242} y1={250 + Math.sin(rad) * 34} y2={250 + Math.sin(rad) * 242} />;
        })}
        <Circle cx={260} cy={250} fill="url(#cuCore)" r={25} />
        <Path d={starD(260, 250, 13, 27, 0.16)} fill="#EFD6B8" />
        <Path d={starD(260, 250, 27, 13, 0.16)} fill="#EFD6B8" opacity={0.9} />
        <Circle cx={260} cy={250} fill="none" opacity={0.6} r={21} stroke="#8F7D66" strokeDasharray="0.1 4" strokeLinecap="round" strokeWidth={1} />
        {labels[0] ? <>
          <Circle cx={nodes[0]!.x} cy={nodes[0]!.y} fill="none" opacity={0.7} r={20 + (shares[0] ?? 0) * 60} stroke="#9FBABC" strokeDasharray="1 3" strokeWidth={0.9} />
          <Circle cx={nodes[0]!.x} cy={nodes[0]!.y} fill="#0F1516" r={13 + (shares[0] ?? 0) * 60} stroke="#B9D0D2" strokeWidth={1.2} />
          <Circle cx={nodes[0]!.x} cy={nodes[0]!.y} fill="#EDE9E4" r={4.2} />
        </> : null}
        {labels[1] ? <>
          <Circle cx={nodes[1]!.x} cy={nodes[1]!.y} fill="url(#cuGold)" r={24} />
          <Circle cx={nodes[1]!.x} cy={nodes[1]!.y} fill="none" opacity={0.85} r={13} stroke="#C9985B" strokeWidth={1} />
          <Circle cx={nodes[1]!.x} cy={nodes[1]!.y} fill="#E3BC8C" r={5.4} />
        </> : null}
        {labels[2] ? <>
          <Circle cx={nodes[2]!.x} cy={nodes[2]!.y} fill="none" opacity={0.7} r={17 + (shares[2] ?? 0) * 50} stroke="#6E8D90" strokeDasharray="1 3" strokeWidth={0.9} />
          <Circle cx={nodes[2]!.x} cy={nodes[2]!.y} fill="#0F1516" r={11 + (shares[2] ?? 0) * 50} stroke="#7FA8AC" strokeWidth={1.1} />
          <Circle cx={nodes[2]!.x} cy={nodes[2]!.y} fill="#B8C6C7" r={3} />
        </> : null}
      </Svg>
      {persons.slice(0, extras).map(([x, y], index) => (
        <View key={index} style={[styles.cuPerson, { left: x - 13, top: y - 13 }]}>
          <UserRound color="#7E8B8C" size={12} strokeWidth={1.4} />
        </View>
      ))}
      {labels.map((label, index) => (label ? (
        <Text key={index} numberOfLines={1} style={[styles.cuLabel, { left: nodes[index]!.label[0], top: nodes[index]!.label[1] }]}>{label}</Text>
      ) : null))}
    </View>
  );
}

function Donut({ value }: { value: number | null }) {
  // 参考稿是 teal + gold 双色环: teal 段代表集中度占比
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <Svg height={104} viewBox="0 0 104 104" width={104}>
      <Circle cx={52} cy={52} fill="none" r={radius} stroke={value === null ? "#26211C" : "#B99F7F"} strokeWidth={10} />
      {value !== null ? (
        <Circle cx={52} cy={52} fill="none" r={radius} stroke="#4E787C" strokeDasharray={`${circumference * pct / 100} ${circumference}`} strokeWidth={10} transform="rotate(-90 52 52)" />
      ) : null}
    </Svg>
  );
}

function DiscoveryGauge({ discovery }: { discovery: number | null }) {
  const split = discovery === null ? null : 180 + Math.max(2, Math.min(178, discovery / 100 * 180));
  return (
    <View style={styles.cuGaugeWrap}>
      <Svg height={78} viewBox="0 0 150 78" width={150}>
        {split === null ? (
          <Path d={describeArc(75, 72, 54, 180, 360)} fill="none" stroke="#26211C" strokeWidth={10} />
        ) : (
          <>
            <Path d={describeArc(75, 72, 54, 180, split)} fill="none" stroke="#4E868B" strokeWidth={10} />
            <Path d={describeArc(75, 72, 54, split, 360)} fill="none" stroke="#C9985B" strokeWidth={10} />
          </>
        )}
      </Svg>
      <View style={styles.cuGaugeValues}>
        <Text style={styles.cuGaugeTeal}>{pctLabel(discovery)}</Text>
        <Text style={styles.cuGaugeSep}>:</Text>
        <Text style={styles.cuGaugeGold}>{discovery === null ? "—" : `${Math.round(100 - discovery)}%`}</Text>
      </View>
    </View>
  );
}

function TailChart({ tail }: { tail: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  // 只画前 48 名 + 幂压缩: 参考稿的长尾是快速衰减后缓坡的平滑曲线
  const soft = tail.slice(0, 48).map((value, index) => Math.pow(Math.max(0, value), 0.5) + (48 - index) * 0.012);
  const max = Math.max(1e-6, ...soft);
  const pts = soft.map((value, index) => [12 + index * (size.w - 22) / Math.max(1, soft.length - 1), size.h - 12 - value / max * (size.h - 24)] as [number, number]);
  return (
    <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.cuTailWrap}>
      {size.w > 0 && tail.length > 1 ? (
        <Svg height={size.h} width={size.w}>
          <Defs>
            <LinearGradient id="cuTailFill" x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor="#3F666A" stopOpacity="0.3" />
              <Stop offset="1" stopColor="#223E40" stopOpacity="0.02" />
            </LinearGradient>
          </Defs>
          <Line stroke="#3C342A" strokeWidth={1} x1={12} x2={12} y1={4} y2={size.h - 12} />
          <Line stroke="#3C342A" strokeWidth={1} x1={12} x2={size.w - 4} y1={size.h - 12} y2={size.h - 12} />
          <Path d={`${smoothPath(pts, size.h - 12)} L ${pts[pts.length - 1]![0]} ${size.h - 12} L ${pts[0]![0]} ${size.h - 12} Z`} fill="url(#cuTailFill)" stroke="none" />
          <Path d={smoothPath(pts, size.h - 12)} fill="none" stroke="#6FADB3" strokeWidth={1.5} />
        </Svg>
      ) : null}
      <Text style={styles.cuTailY}>数量</Text>
      <Text style={styles.cuTailX}>排名</Text>
      {tail.length <= 1 ? <Text style={styles.lpChartEmpty}>等待更多创作者</Text> : null}
    </View>
  );
}

/* ---------- 09 聊天回声 / CHAT ECHO ---------- */

function ChatPage({ mobile, model }: PageArgs) {
  const slotIcons: Record<string, Icon> = { text: MessageCircle, image: ImageIcon, sticker: Sticker, share: Send, call: Phone, voice: Radio, video: Play, system: Info, unknown: MessageCircle };
  const privacyCn = model.chatGroups.length
    ? "隐私保护：时间与类型仅覆盖好友对话；群聊只计总量。"
    : "隐私保护：本页仅展示对话活动的时间与类型分布，不展示任何消息内容、具体信息或身份标识。";
  const privacyEn = model.chatGroups.length
    ? "Privacy first: Group chats are totals only; no content or identifiers are shown."
    : "Privacy first: No message content, details, or identifiers are shown.";
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"对话留下的节奏，\n只看时间与形态，\n不触碰任何内容。"} en="CHAT ECHO" mobile={mobile} no="09" title="聊天回声" yearValue={model.year} />
      <View style={styles.chBody}>
        <View>
          <BlockTitle cn="对话活动波形" en="ACTIVITY OVER TIME" />
          <View style={styles.chWaveRow}>
            <View style={styles.chWaveAxis}>
              <Text style={styles.lpMuted}>活跃度</Text>
              <Text style={styles.chAxisSmall}>High</Text>
              <Text style={styles.chAxisSmall}>Base</Text>
              <Text style={styles.chAxisSmall}>Low</Text>
            </View>
            <View style={styles.flex}>
              <ChatWave hours={model.chatHours} />
              <View style={styles.chTimeRow}>{["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "24:00"].map((label) => <Text key={label} style={styles.lpAxisText}>{label}</Text>)}</View>
            </View>
          </View>
        </View>
        <View style={[styles.chBottom, mobile && styles.stack]}>
          <View style={[styles.chTypes, !mobile && styles.lpBorderRight]}>
            <BlockTitle cn="消息类型节奏" en="MESSAGE TYPE RHYTHM" />
            {model.chatSlots.map((row) => {
              const RowIcon = slotIcons[row.id] ?? MessageCircle;
              const rowMax = Math.max(...row.slots);
              return (
                <View key={row.id} style={styles.chTypeRow}>
                  <RowIcon color="#9A8C7C" size={15} strokeWidth={1.5} />
                  <Text style={styles.chTypeCn}>{row.label}</Text>
                  <Text style={styles.chTypeEn}>{row.en}</Text>
                  <View style={styles.chDotLine}>
                    <View style={styles.chRowLine} />
                    {row.slots.map((count, index) => {
                      const dotSize = !count ? 2.2 : 4.5 + count / Math.max(1, rowMax) * 7.5;
                      const color = !count ? "#2E2924" : count >= rowMax * 0.66 ? "#B08652" : "#527A7E";
                      return (
                        <View key={index} style={styles.chDotSlot}>
                          <View style={styles.chSlotTick} />
                          <View style={{ width: dotSize, height: dotSize, borderRadius: dotSize, backgroundColor: color }} />
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
          <View style={styles.chWindows}>
            <BlockTitle cn="活跃窗口" en="ACTIVE WINDOWS" />
            <HourRing hours={model.chatHours} />
            <View style={styles.chRingLegend}>
              <View style={[styles.chLegendDot, { backgroundColor: "#4E787C" }]} />
              <Text style={styles.lpMuted}>高活跃时段</Text>
              <View style={[styles.chLegendDot, { backgroundColor: "#9C784B" }]} />
              <Text style={styles.lpMuted}>低活跃时段</Text>
            </View>
          </View>
        </View>
        <View style={styles.chPrivacy}>
          <View style={styles.chLockRing}><Lock color="#3A332A" size={13} strokeWidth={1.6} /></View>
          <View style={styles.flex}>
            <Text style={styles.chPrivacyCn}>{privacyCn}</Text>
            <Text style={styles.chPrivacyEn}>{privacyEn}</Text>
          </View>
          <View style={styles.chPrivacyRule} />
          <View {...motionData("twinkle", 0)}><CompassRose color="#6B5C49" size={27} /></View>
        </View>
      </View>
    </View>
  );
}

function ChatWave({ hours }: { hours: number[] }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rawMax = Math.max(...hours);
  // at() 输出经过幂压缩, 归一化用同尺度的 max
  const max = rawMax > 0 ? Math.pow(rawMax, 0.66) : 0;
  const mid = size.h * 0.5;
  // 96 点插值 + 确定性高频抖动, 复现参考稿的碎峰声波质感
  const N = 96;
  const at = (t: number) => {
    const hour = t * 24;
    const i0 = Math.floor(hour) % 24;
    const i1 = (i0 + 1) % 24;
    const frac = hour - Math.floor(hour);
    const base = (hours[i0] ?? 0) * (1 - frac) + (hours[i1] ?? 0) * frac;
    // 幂压缩抹平昼夜悬殊 + 高频抖动 → 参考稿的全天碎峰声波
    const jitter = 0.55 + 0.45 * Math.sin(t * 87.7 + 2.1) * Math.sin(t * 41.3 + 0.7);
    return Math.pow(base, 0.66) * jitter;
  };
  const x = (index: number) => index * size.w / (N - 1);
  // 第二组相位错开的包络: 预期稿上下两侧都是 teal×gold 交叠的双声部
  const at2 = (t: number) => {
    const hour = t * 24;
    const i0 = Math.floor(hour) % 24;
    const i1 = (i0 + 1) % 24;
    const frac = hour - Math.floor(hour);
    const base = (hours[i0] ?? 0) * (1 - frac) + (hours[i1] ?? 0) * frac;
    const jitter = 0.5 + 0.5 * Math.sin(t * 63.1 + 1.3) * Math.sin(t * 29.7 + 2.4);
    return Math.pow(base, 0.66) * jitter;
  };
  const lift = (value: number) => Math.min(1, value / (max || 1) * 1.4);
  const up = Array.from({ length: N }, (_, index) => [x(index), max ? mid - lift(at(index / (N - 1))) * (mid - 5) : mid] as [number, number]);
  const up2 = Array.from({ length: N }, (_, index) => [x(index), max ? mid - lift(at2(index / (N - 1) + 0.03)) * (mid - 5) * 0.9 : mid] as [number, number]);
  const down = Array.from({ length: N }, (_, index) => [x(index), max ? mid + lift(at(index / (N - 1) + 0.045)) * (size.h - mid - 5) * 0.94 : mid] as [number, number]);
  const down2 = Array.from({ length: N }, (_, index) => [x(index), max ? mid + lift(at2(index / (N - 1) + 0.085)) * (size.h - mid - 5) * 0.86 : mid] as [number, number]);
  const stars: Array<[number, number, number]> = [[0.16, 0.18, 4], [0.15, 0.78, 2.6], [0.62, 0.2, 2.6], [0.87, 0.72, 3.2]];
  return (
    <View onLayout={(event) => setSize({ w: event.nativeEvent.layout.width, h: event.nativeEvent.layout.height })} style={styles.chWave}>
      {size.w > 0 ? (
        <Svg height={size.h} width={size.w}>
          <Defs>
            <LinearGradient id="chUp" x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor="#4E7578" stopOpacity={0.55} />
              <Stop offset="1" stopColor="#4E787C" stopOpacity={0.08} />
            </LinearGradient>
            <LinearGradient id="chDown" x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor="#96764E" stopOpacity={0.08} />
              <Stop offset="1" stopColor="#82643F" stopOpacity={0.52} />
            </LinearGradient>
          </Defs>
          {[4, 8, 12, 16, 20].map((hour) => <Line key={hour} stroke="#2A2621" strokeDasharray="2 5" strokeWidth={0.8} x1={hour / 24 * size.w} x2={hour / 24 * size.w} y1={6} y2={size.h - 6} />)}
          {max ? <Path d={`${smoothPath(up2)} L ${size.w} ${mid} L 0 ${mid} Z`} fill="#8A6C48" fillOpacity={0.24} /> : null}
          {max ? <Path d={`${smoothPath(up)} L ${size.w} ${mid} L 0 ${mid} Z`} fill="url(#chUp)" /> : null}
          {max ? <Path d={`${smoothPath(down2)} L ${size.w} ${mid} L 0 ${mid} Z`} fill="#4E7578" fillOpacity={0.2} /> : null}
          {max ? <Path d={`${smoothPath(down)} L ${size.w} ${mid} L 0 ${mid} Z`} fill="url(#chDown)" /> : null}
          {max ? <Path d={smoothPath(up2)} fill="none" stroke="#8F6D43" strokeOpacity={0.6} strokeWidth={0.9} /> : null}
          {max ? <Path d={smoothPath(up)} fill="none" stroke="#7FA2A5" strokeOpacity={0.9} strokeWidth={1.2} /> : null}
          {max ? <Path d={smoothPath(down2)} fill="none" stroke="#79A0A4" strokeOpacity={0.5} strokeWidth={0.9} /> : null}
          {max ? <Path d={smoothPath(down)} fill="none" stroke="#8E6F49" strokeOpacity={0.8} strokeWidth={1.1} /> : null}
          <Line stroke="#4A4034" strokeWidth={2.6} x1={0} x2={size.w} y1={mid} y2={mid} />
          <Line stroke="#D8CFC4" strokeOpacity={0.9} strokeWidth={1.1} x1={0} x2={size.w} y1={mid} y2={mid} />
          {stars.map(([sx, sy, r], index) => <Path d={starD(sx * size.w, sy * size.h, r, r * 1.6)} fill="#D8CFC4" key={index} opacity={0.8} />)}
        </Svg>
      ) : null}
      {!max ? <Text style={styles.lpChartEmpty}>等待聊天证据</Text> : null}
    </View>
  );
}

function HourRing({ hours }: { hours: number[] }) {
  const max = Math.max(...hours);
  const spans: Array<{ from: number; to: number; level: 1 | 2 }> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const count = hours[hour] ?? 0;
    const level = !count ? 0 : count >= max * 0.6 ? 2 : 1;
    if (!level) continue;
    const prev = spans[spans.length - 1];
    if (prev && prev.level === level && prev.to === hour) prev.to = hour + 1;
    else spans.push({ from: hour, to: hour + 1, level });
  }
  const angle = (hour: number) => hour / 24 * 360 - 90;
  return (
    <View style={styles.chRing}>
      <Svg height={164} viewBox="0 0 196 196" width={164}>
        {Array.from({ length: 24 }, (_, tick) => {
          const rad = ((tick / 24 * 360 - 90) * Math.PI) / 180;
          const major = tick % 6 === 0;
          return <Line key={`t-${tick}`} stroke={major ? "#6B5C49" : "#3C342A"} strokeWidth={major ? 1.1 : 0.8} x1={98 + Math.cos(rad) * (major ? 80 : 83)} x2={98 + Math.cos(rad) * 87} y1={98 + Math.sin(rad) * (major ? 80 : 83)} y2={98 + Math.sin(rad) * 87} />;
        })}
        <Circle cx={98} cy={98} fill="none" r={66} stroke="#241F19" strokeWidth={15} />
        {spans.map((span, index) => (
          <Path d={describeArc(98, 98, 66, angle(span.from) + 1.5, angle(span.to) - 1.5)} fill="none" key={index} stroke={span.level === 2 ? "#4E787C" : "#9C784B"} strokeOpacity={span.level === 2 ? 0.95 : 0.82} strokeWidth={15} />
        ))}
        <Circle cx={98} cy={98} fill="none" r={50} stroke="#3C342A" strokeDasharray="1 4" strokeWidth={0.8} />
        <SvgText fill="#9A8C7C" fontFamily={serif} fontSize={13} textAnchor="middle" x={98} y={20}>24</SvgText>
        <SvgText fill="#9A8C7C" fontFamily={serif} fontSize={13} textAnchor="middle" x={185} y={103}>06</SvgText>
        <SvgText fill="#9A8C7C" fontFamily={serif} fontSize={13} textAnchor="middle" x={98} y={190}>12</SvgText>
        <SvgText fill="#9A8C7C" fontFamily={serif} fontSize={13} textAnchor="middle" x={11} y={103}>18</SvgText>
      </Svg>
      <View style={styles.chRingMoon}><Moon color="#8F867B" size={17} strokeWidth={1.4} /></View>
    </View>
  );
}

/* ---------- 10 交叉洞察 / CROSS PATTERNS ---------- */

function crossCellStyle(value: number | null, diagonal: boolean) {
  if (diagonal) return styles.cxCellDiag;
  if (value === null) return null;
  if (value >= 0.6) return styles.cxCellPosHot;
  if (value >= 0.3) return styles.cxCellPos;
  if (value <= -0.6) return styles.cxCellNegHot;
  if (value <= -0.3) return styles.cxCellNeg;
  return styles.cxCellWeak;
}

function CrossPage({ mobile, model }: PageArgs) {
  const { days, labels, matrix, patterns } = model.cross;
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"把分散的证据交叉，\n让藏在关联里的\n模式浮出水面。"} en="CROSS PATTERNS" mobile={mobile} no="10" title="交叉洞察" yearValue={model.year} />
      <View style={styles.chBody}>
        <BlockTitle cn="证据到模式" en="EVIDENCE → PATTERN" />
        <View style={[styles.cxRow, mobile && styles.stack]}>
          <View style={styles.cxBox}>
            <BlockTitle cn="相关矩阵" en="CORRELATION MATRIX" />
            <View style={styles.cxColHeadRow}>
              <View style={styles.cxRowLabelSpace} />
              {labels.map((label) => (
                <View key={label} style={styles.cxColLabel}>{[...label].map((char, index) => <Text key={index} style={styles.cxColChar}>{char}</Text>)}</View>
              ))}
            </View>
            {labels.map((rowLabel, row) => (
              <View key={rowLabel} style={styles.cxMatrixRow}>
                <Text style={styles.cxRowLabel}>{rowLabel}</Text>
                {labels.map((_, column) => {
                  const value = matrix[row]?.[column] ?? null;
                  const hot = row !== column && value !== null && Math.abs(value) >= 0.3;
                  return (
                    <View key={column} style={[styles.cxCell, crossCellStyle(value, row === column)]}>
                      {hot || row === column ? (
                        <Svg height={34} style={styles.cxCellStar} viewBox="0 0 34 34" width={34}>
                          <Path d={starD(17, 17, 4, 12, 0.14)} fill="#000000" opacity={0.22} />
                          <Path d={starD(17, 17, 12, 4, 0.14)} fill="#000000" opacity={0.22} />
                          <Path d={starD(17, 17, 3.4, 10, 0.14)} fill="#FFFFFF" opacity={0.18} transform="rotate(45 17 17)" />
                        </Svg>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ))}
            <View style={styles.cxLegend}>
              <View style={[styles.cxLegendSwatch, { backgroundColor: "#3E7277" }]} />
              <Text style={styles.lpMuted}>负相关</Text>
              <View style={[styles.cxLegendSwatch, { backgroundColor: "#2B2E2E" }]} />
              <Text style={styles.lpMuted}>弱相关</Text>
              <View style={[styles.cxLegendSwatch, { backgroundColor: "#96744A" }]} />
              <Text style={styles.lpMuted}>正相关</Text>
            </View>
          </View>
          <View style={[styles.cxBox, styles.cxPatterns]}>
            <BlockTitle cn="模式观察" en="PATTERN FOUND" />
            {patterns.map((pattern, index) => (
              <View key={index} style={styles.cxCard}>
                <View {...motionData("twinkle", index)} style={styles.cxCardRose}><CompassRose color="#C9A273" size={34} /></View>
                <View style={styles.flex}>
                  <Text style={styles.cxCardTitle}>{pattern.title}</Text>
                  <Text style={styles.cxCardText}>{pattern.text}</Text>
                </View>
                <View style={styles.cxCardNo}>
                  <Text style={styles.cxCardNoLabel}>pattern</Text>
                  <Text style={styles.cxCardNoText}>{String(index + 1).padStart(2, "0")}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View style={[styles.cxFacts, mobile && styles.stack]}>
          <View style={styles.cxFact}>
            <Layers color="#9A8C7C" size={20} strokeWidth={1.4} />
            <View style={styles.flex}>
              <Text style={styles.cxFactLabel}>样本量 / EVIDENCE</Text>
              <Text style={styles.cxFactValue}>{days >= 14 ? "足够充足 / Adequate" : days > 0 ? `有限（${days} 天）/ Limited` : "等待样本 / Awaiting"}</Text>
            </View>
          </View>
          <View style={[styles.cxFact, styles.cxFactMid]}>
            <Text {...motionData("twinkle", 3)} style={styles.cxFactSpark}>✦</Text>
            <View style={styles.flex}>
              <Text style={styles.cxFactLabel}>置信度 / CONFIDENCE</Text>
              <Text style={styles.cxFactValue}>{days >= 14 ? "中等 / Moderate" : "低 / Low"}</Text>
            </View>
          </View>
          <View style={styles.cxFact}>
            <Info color="#9A8C7C" size={20} strokeWidth={1.4} />
            <View style={styles.flex}>
              <Text style={styles.cxFactLabel}>注意事项 / CAVEAT</Text>
              <Text style={styles.cxFactValue}>相关不等于因果，仅为观测结果。</Text>
              <Text style={styles.cxFactEn}>Correlation ≠ Causation; Observational only.</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/* ---------- 11 意外发现 / SURPRISES ---------- */

function SurprisesPage({ mobile, model }: PageArgs) {
  const cards = model.surprises.map((insight, index) => ({
    no: String(index + 1).padStart(2, "0"),
    title: insight.title,
    text: insight.text,
    status: insight.status,
    art: [<ArtWaves key="waves" />, <ArtOrbit key="orbit" />, <ArtNight key="night" />][index],
  }));
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"那些出乎意料的对比，\n藏着尚未被察觉的\n习惯细节。"} en="SURPRISES" mobile={mobile} no="11" title="意外发现" yearValue={model.year} />
      <View style={styles.chBody}>
        <BlockTitle cn="观察到的有趣对比" en="OBSERVED CONTRASTS" />
        <View style={[styles.spRow, mobile && styles.stack]}>
          {cards.map((card) => (
            <View key={card.no} style={styles.spCard}>
              <View style={styles.spBadge}><Text style={styles.spBadgeText}>{card.no}</Text></View>
              <Text accessibilityLabel={card.status === "pending" ? "待观测" : undefined} numberOfLines={2} style={styles.spTitle}>{card.title}</Text>
              <View style={styles.spArt}>{card.art}</View>
              <View style={styles.spObsRow}>
                <View style={styles.spObsRule} />
                <Text style={styles.spObsLabel}>观察</Text>
                <View style={styles.spObsRule} />
              </View>
              <Text numberOfLines={5} style={styles.spText}>{card.text}</Text>
              <Text {...motionData("twinkle", 4)} style={styles.spCardSpark}>✦</Text>
            </View>
          ))}
          <View style={[styles.spCard, styles.spSealCard]}>
            <WaxSeal />
            <Text style={styles.spSealTitle}>好奇心，是你最稳定的引擎。</Text>
            <Text style={styles.spSealText}>继续探索，世界在回应你。</Text>
            <Text {...motionData("twinkle", 5)} style={styles.spSealSpark}>✦</Text>
          </View>
        </View>
        <View style={styles.spFoot}>
          <Eye color="#3A332A" size={17} strokeWidth={1.5} />
          <Text style={styles.spFootText}>注：以上为观测到的现象，不代表任何评价或判断。</Text>
          <Text style={styles.spFootEn}>Note: Observations only. Not evaluations or conclusions.</Text>
          <View style={styles.flex} />
          <Text style={styles.spFootRight}>保持好奇，保持自主。</Text>
          <MiniConstellation />
        </View>
      </View>
    </View>
  );
}

function ArtWaves() { return <Image resizeMode="contain" source={require("./assets/surprise-art-1.png")} style={styles.spArtImg} />; }
function ArtOrbit() { return <Image resizeMode="contain" source={require("./assets/surprise-art-2.png")} style={styles.spArtImg} />; }
function ArtNight() { return <Image resizeMode="contain" source={require("./assets/surprise-art-3.png")} style={styles.spArtImg} />; }
function WaxSeal() { return <Image resizeMode="contain" source={require("./assets/surprise-seal.png")} style={styles.spSealImg} />; }

function MiniConstellation() {
  return (
    <Svg height={16} viewBox="0 0 46 16" width={46}>
      <Line stroke="#6E5333" strokeWidth={0.7} x1={4} x2={16} y1={11} y2={4} />
      <Line stroke="#6E5333" strokeWidth={0.7} x1={16} x2={30} y1={4} y2={10} />
      <Line stroke="#6E5333" strokeWidth={0.7} x1={30} x2={42} y1={10} y2={5} />
      {([[4, 11], [16, 4], [30, 10], [42, 5]] as Array<[number, number]>).map(([x, y], index) => <Circle cx={x} cy={y} fill="#8A6435" key={index} r={index === 1 ? 1.8 : 1.2} />)}
    </Svg>
  );
}

/* ---------- 12 习惯印章 / HABIT PROFILE ---------- */

function profileSummary(model: ReportModel): Array<{ icon: Icon; title: string; text: string }> {
  const metrics = model.profileMetrics;
  const pct = (value: number | null) => value === null ? "待补充" : `${Math.round(value)}%`;
  const windowText = metrics.windowed
    ? metrics.windowLimited
      ? `称号判定仅看近${metrics.windowRequestedDays ?? 7}天，观看记录实际覆盖 ${metrics.windowObservedDays ?? 1} 天`
      : `称号判定仅看近${metrics.windowRequestedDays ?? 7}天`
    : metrics.windowUnavailable
      ? "未能建立时间窗口，暂使用已有记录"
      : "全量记录（非称号判定口径）";
  return [
    metrics.topicBreadth === null ? { icon: Compass, title: "词条范围待补充", text: "观看记录中暂未形成可识别的词条类别。" }
      : { icon: Compass, title: "词条与创作者范围", text: `${windowText}；覆盖 ${metrics.topicCount} 类词条，类别广度 ${pct(metrics.topicBreadth)}；创作者覆盖 ${pct(metrics.creatorBreadth)}。` },
    metrics.completion === null ? { icon: Target, title: "停留证据待补充", text: "观看记录中暂未采集可用的进度信息。" }
      : { icon: Target, title: "停留与留下", text: `平均观看 ${pct(metrics.completion)}；窗口内点赞 ${metrics.windowLikeRecords} 条（覆盖率 ${pct(metrics.likeRate)}），收藏 ${metrics.windowFavoriteRecords} 条（覆盖率 ${pct(metrics.favoriteRate)}）。` },
    { icon: MessageCircle, title: "聊天连接与频率", text: metrics.chatFrequency === null
      ? `已识别 ${metrics.chatPeople} 位聊天联系人，共 ${metrics.chatMessages} 条消息，日期信息待补充。`
      : `已识别 ${metrics.chatPeople} 位聊天联系人，共 ${metrics.chatMessages} 条消息，平均 ${metrics.chatFrequency.toFixed(1)} 条/活跃日。` },
  ];
}

function ProfilePage({ mobile, model, onDashboard, onRestart }: PageArgs) {
  const summary = profileSummary(model);
  const conf = model.evidence.watch.dots;
  const confEn: Record<string, string> = { 高: "High", 中高: "Solid", 中: "Moderate", 低: "Low", 待定: "Pending" };
  return (
    <View style={[styles.lpPage, mobile && styles.stack]}>
      <ChapterRail desc={"所有观测收束成\n一枚印章，\n为这一年盖章存档。"} en="HABIT PROFILE" mobile={mobile} no="12" title="习惯印章" yearValue={model.year} />
      <View style={styles.flex}>
      <View style={[styles.hpBody, mobile && styles.stack]}>
        <View style={[styles.hpEmblemCol, !mobile && styles.lpBorderRight]}>
          <EmblemBadge en={model.profileEnglish} profile={model.profile} />
        </View>
        <View style={styles.hpSummary}>
          <BlockTitle cn="你的习惯画像（观测结论）" en="EVIDENCE-BACKED SUMMARY" />
          <Text style={styles.hpProfileReason}>{model.profileReason}</Text>
          {summary.map(({ icon: LineIcon, text, title }, index) => (
            <View key={title} style={[styles.hpLine, index < summary.length - 1 && styles.hpLineDivider]}>
              <View style={styles.hpLineIcon}><LineIcon color="#C59861" size={18} strokeWidth={1.4} /></View>
              <View style={styles.flex}>
                <Text style={styles.hpLineTitle}>{title}</Text>
                <Text style={styles.hpLineText}>{text}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={[styles.hpRadarCol, mobile && styles.hpRadarColMobile]}>
          <BlockTitle cn="行为维度" en="HABIT DIMENSIONS" />
          <HabitRadar axes={model.profileAxes} />
        </View>
      </View>
      <View style={[styles.hpFacts, mobile && styles.stack]}>
        <View style={styles.hpFact}>
          <Text style={styles.cxFactLabel}>置信度 / CONFIDENCE</Text>
          <Text style={styles.cxFactValue}>{confLabel(conf)} / {confEn[confLabel(conf)]}</Text>
          <View style={styles.lpDots}>{[0, 1, 2, 3, 4, 5].map((dot) => <View key={dot} style={[styles.lpDot, dot < conf && styles.lpDotOn]} />)}</View>
        </View>
        <View style={[styles.hpFact, styles.hpFactMid]}>
          <Text style={styles.cxFactLabel}>局限性 / LIMITATIONS</Text>
          <View style={styles.hpLimitRow}>
            <Mountain color="#9A8C7C" size={19} strokeWidth={1.4} />
            <View style={styles.flex}>
              <Text style={styles.cxFactValue}>基于行为数据的观测，可能随时间与情境变化。</Text>
              <Text style={styles.cxFactEn}>Observational limits apply.</Text>
            </View>
          </View>
        </View>
        <View style={[styles.hpFact, styles.hpFactNext]}>
          <Text style={styles.cxFactLabel}>下一步 / NEXT</Text>
          <View style={[styles.hpButtons, mobile && styles.hpButtonsMobile]}>
            {Platform.OS === "web" ? (
              <Pressable accessibilityRole="button" onPress={() => window.print()} style={({ pressed }) => [styles.hpSaveBtn, pressed && styles.pressed, pointer]}>
                <Download color="#CFE0E2" size={14} strokeWidth={1.6} />
                <View>
                  <Text style={styles.hpSaveText}>保存报告</Text>
                  <Text style={styles.hpSaveEn}>Save Report</Text>
                </View>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={onRestart} style={({ pressed }) => [styles.hpReBtn, pressed && styles.pressed, pointer]}>
              <RotateCcw color="#3A332A" size={14} strokeWidth={1.6} />
              <View>
                <Text style={styles.hpReText}>重新观测</Text>
                <Text style={styles.hpReEn}>Re-observe</Text>
              </View>
            </Pressable>
            <Pressable accessibilityLabel="进入数据大屏" accessibilityRole="button" onPress={onDashboard} style={({ pressed }) => [styles.hpDashboardBtn, pressed && styles.pressed, pointer]}>
              <ArrowRight color="#7FA0A3" size={16} strokeWidth={1.6} />
            </Pressable>
          </View>
        </View>
      </View>
      </View>
    </View>
  );
}

/**
 * Keep the badge files statically referenced so Metro/Expo can bundle them on
 * native and web. The generic emblem remains a safe fallback for old or
 * otherwise unrecognised profile values.
 */
function profileBadgeSource(profile: string) {
  switch (profile as ProfileTitle) {
    case "万象漫游者": return require("./assets/profile-badge-many-worlds.png");
    case "深度沉浸者": return require("./assets/profile-badge-deep-immersion.png");
    case "珍藏策展人": return require("./assets/profile-badge-archive-curator.png");
    case "社交回响者": return require("./assets/profile-badge-social-resonator.png");
    case "多维共鸣者": return require("./assets/profile-badge-multidimensional.png");
    case "静默观测者": return require("./assets/profile-badge-quiet-observer.png");
    case "等待更多足迹": return require("./assets/profile-badge-awaiting-traces.png");
    default: return require("./assets/habit-emblem.png");
  }
}

function EmblemBadge({ en, profile }: { en: string; profile: string }) {
  return (
    <View {...motionData("twinkle", 2)} style={styles.hpEmblemWrap}>
      <Image resizeMode="contain" source={profileBadgeSource(profile)} style={styles.hpEmblemImg} />
      <Text style={styles.hpEmblemCn}>{profile}</Text>
      <Text style={styles.hpEmblemEn}>{en}</Text>
    </View>
  );
}

function HabitRadar({ axes }: { axes: ReportModel["axes"] }) {
  const dims = [
    { cn: "节奏", en: "Rhythm", value: axes[0]?.value ?? null },
    { cn: "注意力", en: "Attention", value: axes[1]?.value ?? null },
    { cn: "探索", en: "Exploration", value: axes[2]?.value ?? null },
    { cn: "承诺", en: "Commitment", value: axes[3]?.value ?? null },
    { cn: "社交表达", en: "Social Expression", value: axes[4]?.value ?? null },
  ];
  const cx = 150;
  const cy = 136;
  const radius = 112;
  const angle = (index: number) => (-90 + index * 72) * Math.PI / 180;
  const point = (index: number, r: number) => [cx + Math.cos(angle(index)) * r, cy + Math.sin(angle(index)) * r] as [number, number];
  const ringPath = (r: number) => `M ${dims.map((_, index) => point(index, r).join(" ")).join(" L ")} Z`;
  const valuePts = dims.map((dim, index) => point(index, radius * Math.max(0.12, Math.min(1, (dim.value ?? 15) / 100))));
  const labelPos = [
    { top: 2, left: 40, width: 240, alignItems: "center" as const },
    { top: 104, left: 272 },
    { top: 244, left: 218 },
    { top: 244, left: 20, width: 90, alignItems: "flex-end" as const },
    { top: 98, left: 0, width: 66, alignItems: "flex-end" as const },
  ];
  return (
    <View style={styles.hpRadarWrap}>
      <View style={styles.hpRadarInner}>
      <Svg height={272} style={styles.hpRadarSvg} viewBox="0 0 300 272" width={300}>
        {[0.25, 0.5, 0.75, 1].map((frac) => <Path d={ringPath(radius * frac)} fill="none" key={frac} stroke="#3E352B" strokeWidth={frac === 1 ? 1.2 : 0.8} />)}
        {dims.map((_, index) => {
          const [x, y] = point(index, radius);
          return <Line key={index} stroke="#332D26" strokeWidth={0.7} x1={cx} x2={x} y1={cy} y2={y} />;
        })}
        <Path d={`M ${valuePts.map((pt) => pt.join(" ")).join(" L ")} Z`} fill="#2E565A" fillOpacity={0.62} stroke="#6E9EA2" strokeWidth={1.3} />
        {valuePts.map((pt, index) => <Circle cx={pt[0]} cy={pt[1]} fill={dims[index]!.value === null ? "#3A3228" : "#D9A86C"} key={index} r={5} stroke="#0B0C0C" strokeWidth={1} />)}
      </Svg>
      {dims.map((dim, index) => (
        <View key={dim.cn} style={[styles.hpRadarLabel, labelPos[index]]}>
          <Text style={styles.hpRadarCn}>{dim.cn}</Text>
          <Text style={styles.hpRadarEn}>{dim.en}</Text>
        </View>
      ))}
      </View>
    </View>
  );
}

type PageArgs = { mobile: boolean; model: ReportModel; onDashboard: () => void; onNext: () => void; onOpen: (url: string) => Promise<void>; onRestart: () => void; onSealRect?: (rect: SealStart | null) => void; onSettings: () => void; privacy: boolean; source: string; updatedAt: string | null };


export function buildReportModel(
  records: PersonalRecordCollection,
  chats: ChatMessage[],
  report: AnnualReport | LivingReport | null,
  chatConversations: ChatConversationSummary[] = [],
): ReportModel {
  const groupIds = new Set(chatConversations.filter((conversation) => conversation.kind === "group").map((conversation) => conversation.id));
  const friendChats = chats.filter((message) => message.conversationType !== "group" && (!message.conversationId || !groupIds.has(message.conversationId)));
  const chatTotal = countChatMessages(chats, chatConversations);
  const profile = deriveProfile(records, chats, chatConversations);
  // The profile/title is evaluated on its recent video window. Report-wide
  // cards and charts intentionally keep their existing all-period scope.
  const profileAll = deriveProfile(records, chats, chatConversations, { windowDays: null });
  const chatGroups = chatConversations.filter((conversation) => conversation.kind === "group");
  const chatGroupMessages = chatGroups.reduce((total, conversation) => total + conversation.messageCount, 0);
  const chatOwnGroupMessages = chatGroups.reduce((total, conversation) => total + conversation.ownMessageCount, 0);
  const rows = (["watch_history", "liked_videos", "favorite_videos"] as const).flatMap((type) => records[type].map((record) => ({ record, type })));
  const dated = rows.filter(({ record }) => validDate(record.occurredAt));
  const reliable = dated.filter(({ record }) => record.occurredAtSource !== "unknown");
  const heatmap = Array.from({ length: 168 }, () => 0);
  const hours = Array.from({ length: 24 }, () => 0);
  const chatHours = Array.from({ length: 24 }, () => 0);
  const months = Array.from({ length: 12 }, () => 0);
  const dayCounts = Array.from({ length: 12 }, () => Array.from({ length: 32 }, () => 0));
  for (const { record, type } of reliable) {
    const date = new Date(record.occurredAt!);
    const hour = date.getHours();
    const heatIndex = ((date.getDay() + 6) % 7) * 24 + hour;
    if (type === "watch_history") { hours[hour] = (hours[hour] ?? 0) + 1; heatmap[heatIndex] = (heatmap[heatIndex] ?? 0) + 1; }
    const month = date.getMonth();
    months[month] = (months[month] ?? 0) + 1;
    dayCounts[month]![date.getDate()] = (dayCounts[month]![date.getDate()] ?? 0) + 1;
  }
  for (const message of friendChats) if (validDate(message.sentAt)) { const hour = new Date(message.sentAt!).getHours(); chatHours[hour] = (chatHours[hour] ?? 0) + 1; }

  const annual = isAnnual(report) ? report : null;
  const modelYear = annual?.year
    ?? report?.coverage.year
    ?? inferYear(reliable.map(({ record }) => record.occurredAt))
    ?? new Date().getFullYear();
  const overview = annual?.overview.data as AnnualOverviewData | undefined;
  const rhythm = annual?.rhythm.data as AnnualRhythmData | undefined;
  const monthly = annual?.monthly.data as AnnualMonthlyData | undefined;
  const interest = annual?.interests.data as AnnualInterestsData | undefined;
  const creatorData = annual?.creators.data as AnnualCreatorsData | undefined;
  const kept = annual?.kept.data as AnnualKeptData | undefined;
  if (rhythm?.heatmap.length) for (const cell of rhythm.heatmap) heatmap[cell.weekday * 24 + cell.hour] = cell.count;
  if (monthly?.months.some((month) => (month.liked ?? 0) + (month.favorite ?? 0) > 0)) monthly.months.forEach((month, index) => { months[index] = (month.liked ?? 0) + (month.favorite ?? 0); });

  const topicCounts = count(rows.flatMap(({ record }) => record.topics ?? []));
  const creatorCounts = count(rows.map(({ record }) => record.author).filter((value): value is string => Boolean(value?.trim())));
  const formats = rankMap(count(rows.map(({ record }) => formatName(record.mediaType))));
  const durations = rankMap(count(rows.map(({ record }) => durationName(record.durationSeconds)).filter((value): value is string => value !== null)));
  const chatKinds = rankMap(count(friendChats.map((message) => chatTypes.find((item) => item.id === message.type)?.label ?? "其他")));
  const topics = interest?.topics.length ? rank(interest.topics) : rankMap(topicCounts);
  const creators = creatorData?.top.length ? creatorData.top.map((item) => ({ name: item.name, count: item.count, share: item.share })) : rankMap(creatorCounts);
  const progress = records.watch_history.map(progressPercentOf).filter((value): value is number => value !== null);
  const completion = progress.length ? progress.reduce((sum, value) => sum + value, 0) / progress.length : null;
  const watchIds = records.watch_history.map((record) => record.videoId).filter((value): value is string => Boolean(value));
  const computedIntersection = makeIntersection(records);
  const intersection = kept ? { watchLiked: kept.pairwise.watchLiked, watchFavorite: kept.pairwise.watchFavorite, likedFavorite: kept.pairwise.likedFavorite, allThree: kept.allThree } : computedIntersection;
  const unique = new Set(rows.map(({ record, type }) => record.videoId ?? record.url ?? `${type}:${record.id}`)).size;
  const activeDays = new Set(reliable.map(({ record }) => dateKey(record.occurredAt!))).size;
  const dayTotals = weekdays.map((_, index) => heatmap.slice(index * 24, index * 24 + 24).reduce((sum, value) => sum + value, 0));
  const coverage = report?.coverage;
  const reliableRatio = coverage?.reliableDateRatio ?? (rows.length ? reliable.length / rows.length : 0);
  const status: ReportModel["status"] = rows.length || chatTotal ? (report?.status === "partial" || coverage?.partial ? "partial" : "ok") : "empty";
  const span = spanDays(reliable.map(({ record }) => record.occurredAt!));
  const exploration = profileAll.metrics.explorationScore;
  const retention = profileAll.metrics.retentionScore;
  const social = profileAll.metrics.socialScore;

  let attentionSeconds = 0;
  for (const record of records.watch_history) {
    const wp = record.watchProgress;
    if (!wp) continue;
    if (typeof wp.watchedSeconds === "number" && Number.isFinite(wp.watchedSeconds) && wp.watchedSeconds > 0) attentionSeconds += wp.watchedSeconds;
    else if (typeof wp.percent === "number" && Number.isFinite(wp.percent) && typeof record.durationSeconds === "number" && Number.isFinite(record.durationSeconds)) attentionSeconds += Math.max(0, wp.percent) / 100 * record.durationSeconds;
  }

  const durationsAll = rows.map(({ record }) => record.durationSeconds).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const durationBands = [
    { label: "短", en: "< 1 min", test: (value: number) => value < 60 },
    { label: "中", en: "1–10 min", test: (value: number) => value >= 60 && value < 600 },
    { label: "长", en: "10–30 min", test: (value: number) => value >= 600 && value < 1800 },
    { label: "超长", en: "> 30 min", test: (value: number) => value >= 1800 },
  ].map(({ en, label, test }) => ({ label, en, share: durationsAll.length ? durationsAll.filter(test).length / durationsAll.length : null }));

  const chatSlots = chatDisplayTypes.map((def) => ({ id: def.id, label: def.label, en: def.label === "文字" ? "Text" : def.label === "图片" ? "Image" : def.label === "表情" ? "Sticker" : def.label === "分享" ? "Share" : "Call", slots: Array.from({ length: 12 }, () => 0) }));
  for (const message of friendChats) {
    if (!validDate(message.sentAt)) continue;
    const slotRow = chatSlots.find((slot) => slot.id === chatDisplayType(message.type));
    if (!slotRow) continue;
    const slot = Math.floor(new Date(message.sentAt!).getHours() / 2);
    slotRow.slots[slot] = (slotRow.slots[slot] ?? 0) + 1;
  }

  // 不能用 indexOf 找重复：上万条观看记录就是上亿次比较，每次重算卡好几秒
  const seenIds = new Set<string>();
  const replayIds = new Set<string>();
  for (const id of watchIds) (seenIds.has(id) ? replayIds : seenIds).add(id);
  const daily = new Map<string, { watch: number; chat: number; night: number; kept: number; depthSum: number; depthN: number; revisit: number }>();
  const dayOf = (value: string) => {
    let dayRow = daily.get(dateKey(value));
    if (!dayRow) {
      dayRow = { watch: 0, chat: 0, night: 0, kept: 0, depthSum: 0, depthN: 0, revisit: 0 };
      daily.set(dateKey(value), dayRow);
    }
    return dayRow;
  };
  for (const record of records.watch_history) {
    if (!validDate(record.occurredAt) || record.occurredAtSource === "unknown") continue;
    const dayRow = dayOf(record.occurredAt!);
    dayRow.watch += 1;
    const hour = new Date(record.occurredAt!).getHours();
    if (hour >= 20 || hour < 5) dayRow.night += 1;
    if (record.videoId && replayIds.has(record.videoId)) dayRow.revisit += 1;
    const pct = record.watchProgress?.percent;
    if (typeof pct === "number" && Number.isFinite(pct)) {
      dayRow.depthSum += pct;
      dayRow.depthN += 1;
    }
  }
  for (const record of [...records.liked_videos, ...records.favorite_videos]) if (validDate(record.occurredAt)) dayOf(record.occurredAt!).kept += 1;
  for (const message of friendChats) if (validDate(message.sentAt)) dayOf(message.sentAt!).chat += 1;
  const dayRows = [...daily.values()];
  const crossLabels = ["内容深度", "活跃频率", "对话节奏", "夜间探索", "回访深度"];
  const crossSeries: Array<Array<number | null>> = [
    dayRows.map((dayRow) => (dayRow.depthN ? dayRow.depthSum / dayRow.depthN : null)),
    dayRows.map((dayRow) => dayRow.watch + dayRow.kept + dayRow.chat),
    dayRows.map((dayRow) => dayRow.chat),
    dayRows.map((dayRow) => dayRow.night),
    dayRows.map((dayRow) => dayRow.revisit),
  ];
  const crossMatrix = crossLabels.map((_, a) => crossLabels.map((__, b) => (a === b ? 1 : pearson(crossSeries[a]!, crossSeries[b]!))));
  const crossPairs: Array<{ a: string; b: string; r: number }> = [];
  for (let a = 0; a < crossLabels.length; a += 1) {
    for (let b = a + 1; b < crossLabels.length; b += 1) {
      const r = crossMatrix[a]![b] ?? null;
      if (r !== null) crossPairs.push({ a: crossLabels[a]!, b: crossLabels[b]!, r });
    }
  }
  crossPairs.sort((left, right) => Math.abs(right.r) - Math.abs(left.r));
  const crossPatterns: Array<{ title: string; text: string }> = [];
  for (const pair of crossPairs) {
    if (crossPatterns.length >= 2 || Math.abs(pair.r) < 0.35) break;
    if (pair.r > 0) {
      crossPatterns.push(crossPatterns.length === 0
        ? { title: `${pair.a}与${pair.b}呈正相关`, text: `当${pair.b}上升时，${pair.a}也随之增强。` }
        : { title: `${pair.a}与${pair.b}同向变化`, text: `${pair.b}走高的日子，${pair.a}通常也更高。` });
    } else {
      crossPatterns.push({ title: `${pair.a}与${pair.b}呈负相关`, text: `当${pair.b}上升时，${pair.a}趋于回落。` });
    }
  }
  const weakest = crossPairs[crossPairs.length - 1];
  if (weakest && Math.abs(weakest.r) < 0.25 && crossPatterns.length < 3) crossPatterns.push({ title: `${weakest.a}与${weakest.b}相对独立`, text: `${weakest.a}的变化，未明显改变${weakest.b}的走向。` });
  while (crossPatterns.length < 3) crossPatterns.push({ title: "更多模式待观测", text: "随着样本天数积累，交叉模式会逐步显现。" });

  const creatorTotals = [...creatorCounts.values()].sort((left, right) => right - left);
  const creatorSum = creatorTotals.reduce((sum, value) => sum + value, 0);
  const creatorFocus = {
    concentration: creatorSum ? creatorTotals.slice(0, 3).reduce((sum, value) => sum + value, 0) / creatorSum * 100 : null,
    discovery: creatorTotals.length ? creatorTotals.filter((value) => value === 1).length / creatorTotals.length * 100 : null,
    tail: creatorTotals.slice(3, 51),
  };

  const watchDates = records.watch_history.map((record) => record.occurredAt);
  const chatDates = friendChats.map((message) => message.sentAt);
  const keptDates = [...records.liked_videos, ...records.favorite_videos].map((record) => record.occurredAt);
  const creatorDates = rows.filter(({ record }) => record.author?.trim()).map(({ record }) => record.occurredAt);
  const evidence: ReportModel["evidence"] = {
    watch: evidenceRow(records.watch_history.length, watchDates, reliableRatio),
    chat: evidenceRow(chatTotal, chatDates, reliableRatio),
    kept: evidenceRow(records.liked_videos.length + records.favorite_videos.length, keptDates, reliableRatio),
    creators: evidenceRow(creatorData?.creatorCount ?? creatorCounts.size, creatorDates, reliableRatio),
  };

  const rawEvents: TimelineEventInput[] = [
    ...records.watch_history.map((record) => ({ kind: "watch" as const, label: "短视频观看", at: record.occurredAt, url: record.url })),
    ...[...records.liked_videos, ...records.favorite_videos].map((record) => ({ kind: "kept" as const, label: "收藏与点赞", at: record.occurredAt, url: record.url })),
    ...friendChats.map((message) => ({ kind: "chat" as const, label: "聊天互动", at: message.sentAt, url: message.share?.url ?? null })),
  ];
  const events = collapseWatchRuns(rawEvents);

  const calendar = dayCounts.map((days) => {
    const cells = Array.from({ length: 14 }, (_, cell) => {
      const lo = Math.floor(cell * 31 / 14) + 1;
      const hi = Math.floor((cell + 1) * 31 / 14);
      let sum = 0;
      for (let day = lo; day <= hi; day += 1) sum += days[day] ?? 0;
      return sum;
    });
    const cellMax = Math.max(...cells);
    return cells.map((value) => value === 0 ? 0 : value >= cellMax * 0.66 ? 2 : 1);
  });

  const monthAvg = months.reduce((sum, value) => sum + value, 0) / 12;
  // 三季各有一组设计稿词形; 与年均值比较后取增强/放缓/平稳变体
  const seasonWords: Array<[string, number[], string, string, string]> = [
    ["春季", [2, 3, 4], "春季内容探索增强", "春季节奏放缓", "春季节奏平稳"],
    ["夏季", [5, 6, 7], "夏季内容探索增强", "夏季节奏放缓", "夏季节奏平稳"],
    ["秋季", [8, 9, 10], "秋季互动与关注上升", "秋季节奏放缓", "秋季互动与关注平稳"],
  ];
  const seasons = seasonWords.map(([name, span3, up, down, flat]) => {
    const sum = span3.reduce((total, month) => total + (months[month] ?? 0), 0);
    if (!sum) return { title: `${name}暂无观测`, sub: ["awaiting", "observation"] };
    const title = sum > monthAvg * 3 * 1.08 ? up : sum < monthAvg * 3 * 0.85 ? down : flat;
    return { title, sub: ["pattern found", "observed"] };
  });
  const reliableTimes = reliable.map(({ record }) => time(record.occurredAt));
  const firstTime = reliableTimes.length ? Math.min(...reliableTimes) : null;
  const lastTime = reliableTimes.length ? Math.max(...reliableTimes) : null;
  const peakMonthValue = maxIndex(months);
  const peakHourValue = maxIndex(hours);
  // 里程碑文案是设计稿固定叙事; 数据只决定各节点是否点亮 (awaiting 态)
  const milestones: ReportModel["milestones"] = [
    firstTime === null
      ? { title: "观测启动\n待定位", sub: "awaiting" }
      : { title: "观测启动", sub: "pattern emerging" },
    peakMonthValue === null
      ? { title: "内容偏好\n待观测", sub: "awaiting" }
      : { title: "内容偏好\n变化显著", sub: "pattern found" },
    chatTotal > 0
      ? { title: "互动频次\n阶段性上升", sub: "pattern found" }
      : { title: "互动频次\n待观测", sub: "awaiting" },
    topics.length
      ? { title: "探索多样化\n增加", sub: "pattern found" }
      : { title: "探索多样性\n待观测", sub: "awaiting" },
    creators.length
      ? { title: "创作者关注\n提升", sub: "pattern found" }
      : { title: "创作者关注\n待观测", sub: "awaiting" },
    lastTime === null
      ? { title: "年末回顾\n待补充", sub: "awaiting" }
      : { title: "年末回顾", sub: "pattern reviewed" },
  ];
  const profileAxes: ReportModel["profileAxes"] = [
    // Rhythm is a report-level cadence observation; the remaining profile
    // axes mirror the same recent-window metrics that selected the title.
    { label: "节奏", left: "偶发", right: "稳定", value: span ? Math.min(100, activeDays / span * 100) : null },
    { label: "注意力", left: "碎片", right: "深潜", value: profile.metrics.completion },
    { label: "探索", left: "熟悉", right: "广域", value: profile.metrics.explorationScore === null ? null : Math.min(100, profile.metrics.explorationScore) },
    { label: "留存", left: "浏览", right: "珍藏", value: profile.metrics.retentionScore },
    { label: "互动", left: "独处", right: "表达", value: profile.metrics.socialScore },
  ];

  return {
    year: modelYear,
    period: annual?.periodLabel ?? (report && "currentWindow" in report ? report.currentWindow.label : "当前样本"),
    total: rows.length,
    unique: overview?.counts.total ?? unique,
    watch: records.watch_history.length,
    liked: records.liked_videos.length,
    favorite: records.favorite_videos.length,
    chat: chatTotal,
    chatGroups,
    chatGroupMessages,
    chatOwnGroupMessages,
    dated: reliable.length,
    activeDays: overview?.activeDays ?? activeDays,
    creatorsCount: creatorData?.creatorCount ?? creatorCounts.size,
    reliableRatio,
    status,
    warnings: coverage?.warnings ?? [],
    heatmap,
    hours,
    chatHours,
    months,
    topics,
    creators,
    formats,
    durations: interest?.durations.some((item) => item.count) ? rank(interest.durations.map((item) => ({ name: item.label, count: item.count }))) : durations,
    chatKinds,
    completion,
    replays: watchIds.length - new Set(watchIds).size,
    intersection,
    peakHour: rhythm?.mostActiveHour?.hour ?? maxIndex(hours),
    peakDay: rhythm?.mostActiveWeekday?.weekday ?? maxIndex(dayTotals),
    peakMonth: monthly?.peakMonth ? monthly.peakMonth.month - 1 : maxIndex(months),
    overlap: overlap(hours, chatHours),
    recent: rows.slice().sort((a, b) => time(b.record.occurredAt) - time(a.record.occurredAt)).slice(0, 12).map(({ record }) => ({ title: record.title || "未命名内容", author: record.author, time: record.occurredAt, url: record.url })),
    axes: [
      { label: "节奏", left: "偶发", right: "稳定", value: span ? Math.min(100, activeDays / span * 100) : null },
      { label: "注意力", left: "碎片", right: "深潜", value: completion },
      { label: "探索", left: "熟悉", right: "广域", value: exploration === null ? null : Math.min(100, exploration) },
      { label: "留存", left: "浏览", right: "珍藏", value: retention },
      { label: "互动", left: "独处", right: "表达", value: social },
    ],
    profile: profile.title,
    profileEnglish: profile.english,
    profileReason: profile.reason,
    profileMetrics: profile.metrics,
    profileAxes,
    attentionSeconds,
    evidence,
    events,
    calendar,
    seasons,
    milestones,
    progressPercents: progress,
    durationBands,
    chatSlots,
    cross: { labels: crossLabels, matrix: crossMatrix, patterns: crossPatterns, days: dayRows.length },
    creatorFocus,
    surprises: deriveSurpriseInsights(records, chats, { chatConversations }),
  };
}

/**
 * Compress the recent activity stream into viewing runs.
 *
 * A chat message is the only hard boundary: likes/favorites are deliberately
 * transparent, so they can remain visible between the first and last video
 * in one uninterrupted viewing run. The raw records are left untouched; this
 * helper only changes the derived event-stream presentation.
 */
function collapseWatchRuns(events: TimelineEventInput[]): ReportModel["events"] {
  const ordered = events
    .filter((event) => validDate(event.at))
    .map((event, index) => ({ event, index }))
    .sort((left, right) => time(left.event.at) - time(right.event.at) || left.index - right.index);
  const collapsed: TimelineEventInput[] = [];
  let watchRun: TimelineEventInput[] = [];

  const flushWatchRun = () => {
    if (watchRun.length === 0) return;
    const first = watchRun[0]!;
    collapsed.push(first);
    if (watchRun.length > 1) {
      const last = watchRun[watchRun.length - 1]!;
      collapsed.push(last);
    }
    watchRun = [];
  };

  for (const { event } of ordered) {
    if (event.kind === "watch") {
      watchRun.push(event);
      continue;
    }
    if (event.kind === "chat") flushWatchRun();
    collapsed.push(event);
  }
  flushWatchRun();

  return collapsed
    .sort((left, right) => time(right.at) - time(left.at))
    .slice(0, 8)
    .map(({ at, kind, label, url }) => ({
      kind,
      label,
      url,
      time: new Date(at!).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
    }));
}

function pearson(a: Array<number | null>, b: Array<number | null>): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x !== null && x !== undefined && y !== null && y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 6) return null;
  const mx = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const my = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index]! - mx;
    const dy = ys[index]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function evidenceRow(total: number, dates: Array<string | null | undefined>, reliableRatio: number): EvidenceRow {
  const valid = dates.filter((value) => validDate(value ?? null)).map((value) => new Date(value!));
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const date of valid) {
    const bucket = date.getMonth() * 2 + (date.getDate() > 15 ? 1 : 0);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  const peak = Math.max(...buckets, 1);
  const months = buckets.map((count) => (count ? 0.45 + 0.55 * (count / peak) : 0));
  let range: [string, string] | null = null;
  if (valid.length) {
    const times = valid.map((date) => date.getTime());
    range = [isoDay(new Date(Math.min(...times))), isoDay(new Date(Math.max(...times)))];
  }
  const thresholds = [1, 10, 50, 200, 1000];
  let dots = thresholds.filter((threshold) => total >= threshold).length;
  if (dots > 0 && dots < 5 && total >= Math.sqrt(thresholds[dots - 1]! * thresholds[dots]!)) dots += 0.5;
  const confidence = total === 0 ? 0 : reliableRatio >= 0.8 ? 4 : 3;
  // partial 按覆盖格阵自身的半月粒度判定: 任一半月桶空即为不完整观测
  const caveat = total === 0 ? ["awaiting"] : buckets.every((count) => count > 0) ? ["observed"] : ["observed", "partial"];
  return { count: total, dots, confidence, range, caveat, months };
}

function isAnnual(report: AnnualReport | LivingReport | null): report is AnnualReport { return Boolean(report && "cards" in report); }
function initialPage(view: WorkspaceViewKey): number { return view === "chat" ? 8 : view === "highlights" ? 10 : view === "summary" ? 0 : 2; }
function year(): number { return new Date().getFullYear(); }
function displayYear(value: number | null | undefined): number { return value ?? year(); }
function inferYear(values: Array<string | null | undefined>): number | null {
  const years: number[] = [];
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    const parsedYear = date.getFullYear();
    if (Number.isFinite(date.getTime()) && parsedYear >= 1970 && parsedYear <= 2200) years.push(parsedYear);
  }
  return years.length ? years.sort((a, b) => b - a)[0]! : null;
}
export function attentionLabel(seconds: number): string { if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`; if (seconds > 0) return `${Math.max(1, Math.round(seconds / 60))}m`; return "—"; }
function isoDay(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function validDate(value: string | null): boolean { return Boolean(value && Number.isFinite(new Date(value).getTime())); }
function time(value: string | null): number { const parsed = value ? new Date(value).getTime() : 0; return Number.isFinite(parsed) ? parsed : 0; }
function dateKey(value: string): string { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; }
function count(values: string[]): Map<string, number> { const result = new Map<string, number>(); for (const raw of values) { const value = raw.trim(); if (value) result.set(value, (result.get(value) ?? 0) + 1); } return result; }
function rankMap(values: Map<string, number>): Ranked[] { return rank([...values].map(([name, count]) => ({ name, count }))); }
function rank(values: Array<{ name: string; count: number }>): Ranked[] { const total = values.reduce((sum, value) => sum + value.count, 0); return values.filter((value) => value.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")).slice(0, 10).map((value) => ({ ...value, share: total ? value.count / total : 0 })); }
function formatName(value: PersonalVideoRecord["mediaType"]): string { return ({ video: "视频", image: "图文", live: "直播", unknown: "未知" } as const)[value ?? "unknown"]; }
function durationName(value: number | null | undefined): string | null { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null; if (value < 15) return "15 秒内"; if (value < 60) return "15–60 秒"; if (value < 300) return "1–5 分钟"; return "5 分钟以上"; }
function maxIndex(values: number[]): number | null { const max = Math.max(0, ...values); return max ? values.indexOf(max) : null; }
function overlap(left: number[], right: number[]): number | null { const union = left.filter((value, index) => value > 0 || (right[index] ?? 0) > 0).length; if (!union || !right.some((value) => value > 0)) return null; return left.filter((value, index) => value > 0 && (right[index] ?? 0) > 0).length / union * 100; }
function idSet(rows: PersonalVideoRecord[]): Set<string> { return new Set(rows.map((row) => row.videoId).filter((id): id is string => Boolean(id))); }
function common(left: Set<string>, right: Set<string>): number { return [...left].filter((id) => right.has(id)).length; }
function makeIntersection(records: PersonalRecordCollection): ReportModel["intersection"] { const watch = idSet(records.watch_history); const liked = idSet(records.liked_videos); const favorite = idSet(records.favorite_videos); return { watchLiked: common(watch, liked), watchFavorite: common(watch, favorite), likedFavorite: common(liked, favorite), allThree: [...watch].filter((id) => liked.has(id) && favorite.has(id)).length }; }
function spanDays(values: string[]): number { if (!values.length) return 0; const times = values.map((value) => new Date(value).getTime()); return Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000) + 1); }
function percent(value: number): string { return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`; }
function timePhrase(hour: number): string { return hour < 6 ? "深夜" : hour < 11 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 23 ? "夜晚" : "深夜"; }


const serif = Platform.OS === "web" ? "Georgia, 'Songti SC', 'STSong', 'SimSun', serif" : undefined;
// 预期稿的数字/英文标签是高对比 didone 体; CJK 回落 Songti
const didot = Platform.OS === "web" ? "Didot, 'Bodoni 72', Georgia, 'Songti SC', serif" : undefined;

const styles = StyleSheet.create({
  sealIntroBackdrop: { backgroundColor: "#0A0B0B" },
  sealIntroGlow: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, shadowColor: "#C9995F", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.55, shadowRadius: 46 },
  sealIntroHint: { position: "absolute", left: 0, right: 0, textAlign: "center", color: "#B9AC9C", fontSize: 12, letterSpacing: 4, fontFamily: "Songti SC, Noto Serif SC, Georgia, serif" },
  root: { flex: 1, minHeight: "100%", backgroundColor: "#0A0B0B", paddingHorizontal: 26, paddingTop: 16, paddingBottom: 24 },
  flex: { flex: 1, minWidth: 0 },
  flexShrinkable: { flexShrink: 1 },
  webFitViewport: { flex: 1, minWidth: 0, overflow: "hidden" },
  stack: { flexDirection: "column" },
  lateScroll: { flexGrow: 1 },

  /* 舞台外壳 */
  frame: { flex: 1, minHeight: 0, flexDirection: "row", borderWidth: 1, borderColor: "#6E5D49", backgroundColor: "#131717" },
  grain: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  grainOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, opacity: 0.3 },
  grainImg: { width: "100%", height: "100%" },
  warmTint: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(38,32,24,0.05)" },
  corner: { position: "absolute", width: 26, height: 26, borderColor: "#6E5D49", opacity: 0.9 },
  cornerTL: { left: 8, top: 8, borderLeftWidth: 1, borderTopWidth: 1 },
  cornerTR: { right: 8, top: 8, borderRightWidth: 1, borderTopWidth: 1 },
  cornerBL: { left: 8, bottom: 8, borderLeftWidth: 1, borderBottomWidth: 1 },
  cornerBR: { right: 8, bottom: 8, borderRightWidth: 1, borderBottomWidth: 1 },
  nav: { position: "absolute", right: 12, bottom: 8, flexDirection: "row", alignItems: "center", gap: 8, opacity: 0.85 },
  navCompact: { right: 8, bottom: 8, gap: 4 },
  navButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#3A3228", backgroundColor: "rgba(10,11,11,0.82)" },
  navButtonCompact: { width: 24, height: 24 },
  navCount: { color: "#9A8367", fontSize: 9, letterSpacing: 1.6, paddingHorizontal: 4 },
  navCountCompact: { fontSize: 8, letterSpacing: 1.1, paddingHorizontal: 2 },

  /* 01 入口 */
  openRoot: { flex: 1 },
  openCenter: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 8 },
  openSpark: { marginBottom: 18, opacity: 0.95 },
  openTitle: { color: "#EFDFCC", fontSize: 44, lineHeight: 56, fontFamily: serif, letterSpacing: 8, textAlign: "center", fontWeight: "700" },
  openYear: { color: "#B68B57", fontSize: 20, letterSpacing: 11, fontFamily: Platform.OS === "web" ? "'Songti SC', 'STSong', Georgia, serif" : undefined, marginTop: 14, fontWeight: "700" },
  openMiniSpark: { color: "#C9995F", fontSize: 9, marginTop: 16, opacity: 0.9 },
  openSealRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10 },
  openRule: { width: 110, height: 1, backgroundColor: "#5E5142" },
  openSealLabel: { color: "#B4A38F", fontSize: 9, letterSpacing: 3 },
  openBand: { alignSelf: "stretch", height: 252, alignItems: "center", justifyContent: "center", marginTop: 4 },
  sealWrap: { width: 196, height: 196, borderRadius: 98, alignItems: "center", justifyContent: "center", shadowColor: "#C59861", shadowOpacity: 0.28, shadowRadius: 44, shadowOffset: { width: 0, height: 0 } },
  sealDisc: { width: 196, height: 196, borderRadius: 98, overflow: "hidden", backgroundColor: "#14100A" },
  plaque: { marginTop: 16, backgroundColor: "#D2BBA0", padding: 4, shadowColor: "#000000", shadowOpacity: 0.34, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  plaqueInner: { flexDirection: "row", alignItems: "center", gap: 11, borderWidth: 1, borderColor: "#6E5C47", borderRadius: 5, paddingHorizontal: 20, paddingVertical: 11 },
  plaqueText: { color: "#2B2217", fontSize: 16, fontFamily: serif, letterSpacing: 6, fontWeight: "700" },
  // 预期稿按钮两侧是「十字尾线」装饰: 长横线 + 靠外端一根短竖刻
  plaqueOrn: { height: 11, justifyContent: "center" },
  plaqueOrnLine: { height: 1, backgroundColor: "#4A3D2C", alignSelf: "stretch" },
  plaqueOrnTick: { position: "absolute", top: 0, bottom: 0, width: 1, backgroundColor: "#4A3D2C" },
  // 四角内凹圆弧缺口(预期稿是 scallop 挖角, 不是斜切)
  plaqueNotch: { position: "absolute", width: 11, height: 11, borderRadius: 6, backgroundColor: "#101111" },
  notchTL: { left: -5.5, top: -5.5 },
  notchTR: { right: -5.5, top: -5.5 },
  notchBL: { left: -5.5, bottom: -5.5 },
  notchBR: { right: -5.5, bottom: -5.5 },

  /* 02 观测凭证（几何按 EVD 常量内联，随缩放系数走） */
  evRoot: { flex: 1, alignItems: "center", justifyContent: "center" },
  evGrain: { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" },

  /* 03 内容足迹 */
  fpRoot: { flex: 1, paddingHorizontal: 20, paddingVertical: 12 },
  fpStats: { flexDirection: "row", paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#2E2922" },
  fpStatsMobile: { flexWrap: "wrap" },
  fpStat: { flex: 1, minWidth: 140, alignItems: "center", gap: 5, paddingVertical: 4 },
  fpStatSep: { width: 1, height: 72, alignSelf: "center", backgroundColor: "#453A2C", alignItems: "center", justifyContent: "center" },
  fpStatSepDot: { width: 5, height: 5, backgroundColor: "#C59861", transform: [{ rotate: "45deg" }] },
  fpStatLabel: { color: "#CFC1B0", fontSize: 15, fontFamily: serif, letterSpacing: 4, marginTop: 4 },
  fpStatValue: { color: "#E3C8A6", fontSize: 40, lineHeight: 46, fontFamily: didot },
  fpStatSub: { color: "#6F665B", fontSize: 11, fontFamily: serif, letterSpacing: 1.5 },
  fpBody: { flex: 1, flexDirection: "row", paddingTop: 16 },
  fpCol: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
  fpColCal: { flex: 0, flexBasis: 236, flexGrow: 0, flexShrink: 0 },
  fpColTri: { flex: 0.82 },
  fpColMid: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: "#332C24" },
  colHead: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 12 },
  colHeadCn: { color: "#DEC7AB", fontSize: 18, fontFamily: serif, fontWeight: "600", letterSpacing: 1 },
  colHeadEn: { color: "#6F665B", fontSize: 12, letterSpacing: 1 },
  fpWeekRow: { width: 212, flexDirection: "row", justifyContent: "space-between", paddingLeft: 32, marginBottom: 6 },
  fpWeekLetter: { color: "#7E756A", fontSize: 13, fontFamily: serif, fontWeight: "600", letterSpacing: 1 },
  fpCalRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  fpCalMonth: { width: 32, color: "#93836F", fontSize: 11, fontFamily: serif, fontWeight: "600", letterSpacing: 1 },
  fpCalCells: { flexDirection: "row", gap: 2 },
  fpCell: { width: 11, height: 15, backgroundColor: "#2B2D2D" },
  fpCellLow: { backgroundColor: "#455E60" },
  fpCellHigh: { backgroundColor: "#6E8C8F" },
  fpLegend: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  fpLegendGap: { marginLeft: 14, backgroundColor: "#2B2D2D" },
  fpLegendText: { color: "#6F665B", fontSize: 10, fontFamily: serif },
  fpEvents: { gap: 15 },
  fpEventAxis: { position: "absolute", left: 10, top: 12, bottom: 12, width: 1, backgroundColor: "#4A3E30" },
  fpEvent: { flexDirection: "row", alignItems: "center", gap: 9 },
  fpEventIcon: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1.3, borderColor: "#5A4833", backgroundColor: "#0D0E0E" },
  fpEventIconTeal: { borderColor: "#4E7578" },
  fpEventTag: { color: "#94836F", fontSize: 12, fontFamily: serif, fontWeight: "600", letterSpacing: 0.5 },
  fpEventName: { color: "#D8CCBD", fontSize: 14, fontFamily: serif, fontWeight: "600" },
  fpEventTime: { color: "#A89986", fontSize: 13, fontFamily: serif, fontWeight: "600", letterSpacing: 1, fontVariant: ["tabular-nums", "lining-nums"] },
  fpEmpty: { color: "#6F665B", fontSize: 11, lineHeight: 18 },
  triWrap: { flex: 1 },
  triCanvas: { alignSelf: "stretch", aspectRatio: 0.8, maxHeight: 460, minHeight: 200 },
  triStarWrap: { position: "absolute" },
  triLabel: { position: "absolute", alignItems: "flex-start" },
  triName: { color: "#CFC1B0", fontSize: 15, fontFamily: serif, fontWeight: "600", letterSpacing: 1 },
  triValue: { color: "#D6BD9E", fontSize: 22, fontFamily: didot, fontWeight: "600", marginTop: 2 },
  fpNote: { color: "#6E655B", fontSize: 10, fontFamily: serif, marginTop: 26 },

  /* 04 时间轴 */
  tlRoot: { flex: 1, paddingHorizontal: 34, paddingVertical: 18 },
  tlTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 12 },
  tlRule: { width: 175, height: 1, backgroundColor: "#4A4034" },
  tlRuleShort: { width: 58, height: 1, backgroundColor: "#4A4034" },
  tlStar: { color: "#C59861", fontSize: 13, opacity: 0.9 },
  tlYear: { color: "#EDE1D2", fontSize: 40, fontFamily: Platform.OS === "web" ? "Didot, Georgia, 'Songti SC', serif" : serif, letterSpacing: 7, paddingHorizontal: 8 },
  tlBand: { flexDirection: "row", marginTop: 18 },
  tlBandChart: { height: 196 },
  tlBandMiddle: { flex: 1 },
  tlBandLast: { height: 168, borderTopWidth: 1, borderTopColor: "#2C2720", paddingTop: 12 },
  bandLabel: { width: 104, paddingTop: 8 },
  bandCn: { color: "#CFC1B0", fontSize: 14, letterSpacing: 2.5, fontFamily: serif },
  bandEn: { color: "#7C7266", fontSize: 10, letterSpacing: 2, marginTop: 5, fontFamily: serif },
  tlMonthRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2, marginBottom: 8 },
  tlMonth: { color: "#9C9081", fontSize: 13.5, letterSpacing: 1.8, fontFamily: didot },
  tlChart: { flex: 1, minHeight: 90 },
  tlAxis: { position: "absolute", left: -22, color: "#7A7165", fontSize: 11.5, fontFamily: serif },
  tlAxisHigh: { top: 4 },
  tlAxisMid: { top: "44%" },
  tlAxisLow: { bottom: 12 },
  tlEmptyChart: { position: "absolute", alignSelf: "center", top: "42%", color: "#6F665B", fontSize: 10, letterSpacing: 2 },
  tlMilestones: { flex: 1, flexDirection: "row", paddingTop: 10 },
  tlBaseline: { position: "absolute", left: 0, right: 0, top: 15, height: 1, backgroundColor: "#4A4136" },
  tlMilestone: { flex: 1, alignItems: "center", paddingHorizontal: 4 },
  tlNode: { width: 13, height: 13, borderRadius: 7, borderWidth: 1, borderColor: "#A8804F", backgroundColor: "#0B0C0C", alignItems: "center", justifyContent: "center" },
  tlNodeDot: { width: 3.5, height: 3.5, borderRadius: 2, backgroundColor: "#C59861" },
  tlMilestoneTitle: { color: "#D0BDA6", fontSize: 14.5, lineHeight: 21, textAlign: "center", marginTop: 10, maxWidth: 120, fontFamily: serif, letterSpacing: 1 },
  tlMilestoneSub: { color: "#7C7266", fontSize: 11, marginTop: 5, letterSpacing: 0.6, fontFamily: serif, fontStyle: "italic", textAlign: "center", lineHeight: 16 },
  tlEmpty: { flex: 1, color: "#6F665B", fontSize: 12, letterSpacing: 2, textAlign: "center", paddingTop: 24, fontFamily: serif },
  tlPatterns: { flex: 1, flexDirection: "row", gap: 40, alignItems: "flex-start", paddingTop: 6 },
  tlPattern: { flex: 1, height: 126, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#55442F", backgroundColor: "rgba(14,16,16,0.55)", paddingVertical: 14, paddingHorizontal: 10 },
  tlPatternStar: { position: "absolute", top: -9, color: "#C59861", fontSize: 12, backgroundColor: "#0E0E0D", paddingHorizontal: 7 },
  tlPatternTitle: { color: "#DEC7AB", fontSize: 18, fontFamily: serif, letterSpacing: 1.5, textAlign: "center" },
  tlPatternSub: { color: "#7C7266", fontSize: 11.5, marginTop: 6, letterSpacing: 0.6, fontFamily: serif, fontStyle: "italic" },

  /* 05-12 观测图版共用 */
  lpPage: { flex: 1, minHeight: 620, flexDirection: "row" },
  lpBorderRight: { borderRightWidth: 1, borderRightColor: "#332C24" },
  lpBorderTop: { borderTopWidth: 1, borderTopColor: "#332C24" },
  lpRail: { width: 256, borderRightWidth: 1, borderRightColor: "#332C24", paddingHorizontal: 30, paddingVertical: 24, justifyContent: "space-between" },
  lpRailMobile: { width: "100%", minHeight: 560, borderRightWidth: 0, borderBottomWidth: 1, borderBottomColor: "#332C24", paddingHorizontal: 24, paddingVertical: 20 },
  // Cap the top rhythm so a tall portrait viewport does not stretch the
  // heading all the way to the bottom of the rail.
  lpRailTop: { flexGrow: 1, flexShrink: 1, minHeight: 360, maxHeight: 520, justifyContent: "space-between" },
  lpRailIdentity: { height: 148, justifyContent: "space-between" },
  lpRailCopy: { minHeight: 222 },
  lpRailNo: { color: "#C4A886", fontSize: 52, lineHeight: 58, fontFamily: didot },
  lpRailYear: { color: "#A79885", fontSize: 13.5, letterSpacing: 2.6, fontFamily: didot },
  lpRailSpark: { opacity: 0.92 },
  lpRailTitle: { height: 46, color: "#D8BFA1", fontSize: 34, lineHeight: 46, fontFamily: serif, fontWeight: "700", letterSpacing: 4 },
  lpRailEn: { height: 24, color: "#B38955", fontSize: 14.5, lineHeight: 20, letterSpacing: 3.4, marginTop: 9, fontFamily: didot },
  lpRailEnCompact: { fontSize: 12.5, letterSpacing: 2.45 },
  lpRailDash: { width: 34, height: 2, backgroundColor: "#6E5D49", marginTop: 22 },
  lpRailDesc: { height: 81, color: "#847869", fontSize: 15.5, lineHeight: 27, marginTop: 18, fontFamily: serif },
  lpRailBottom: { height: 146, flexShrink: 0 },
  lpRailPatternCopy: { height: 36 },
  lpRailPattern: { color: "#776C5E", fontSize: 11.5, letterSpacing: 2.8, fontFamily: didot },
  lpRailObserved: { color: "#5E5850", fontSize: 11, letterSpacing: 1.2, marginTop: 4, fontFamily: serif },
  lpRailRose: { marginTop: 14, alignSelf: "flex-start", opacity: 0.9 },
  lpFooter: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderTopColor: "#332C24", paddingLeft: 26, paddingRight: 46, paddingVertical: 12 },
  lpFooterStar: { color: "#C59861", fontSize: 16 },
  lpFooterLabel: { color: "#776C5E", fontSize: 11.5, letterSpacing: 2.6, fontFamily: didot },
  lpFooterText: { color: "#CFBCA5", fontSize: 15, lineHeight: 22, marginTop: 5, fontFamily: serif },
  lpFooterCell: { paddingLeft: 10, minWidth: 78 },
  lpFooterLast: { minWidth: 62 },
  lpFooterConf: { color: "#CDB9A0", fontSize: 16, letterSpacing: 1.5, marginTop: 5, fontFamily: serif },
  lpDots: { flexDirection: "row", gap: 6, marginTop: 9 },
  lpDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: "#4A4034", overflow: "hidden" },
  lpDotOn: { backgroundColor: "#C59861", borderColor: "#C59861" },
  lpDotHalf: { position: "absolute", left: 0, top: 0, bottom: 0, width: "50%", backgroundColor: "#C59861" },
  lpBlockTitle: { flexDirection: "row", alignItems: "baseline", gap: 9, marginBottom: 12 },
  lpBlockCn: { color: "#D6BFA2", fontSize: 19, fontFamily: serif, fontWeight: "600", letterSpacing: 1.5 },
  lpBlockEn: { color: "#7C7266", fontSize: 12, letterSpacing: 2.3, fontFamily: didot },
  lpMuted: { color: "#7C7266", fontSize: 11, letterSpacing: 0.8, fontFamily: serif },
  lpAxisText: { color: "#7A7165", fontSize: 12.5, letterSpacing: 1, fontFamily: didot },
  lpEmpty: { color: "#6F665B", fontSize: 12, letterSpacing: 1, paddingVertical: 16, fontFamily: serif },
  lpChartEmpty: { position: "absolute", alignSelf: "center", top: "44%", color: "#6F665B", fontSize: 12, letterSpacing: 2, fontFamily: serif },

  /* 05 你的节拍 */
  rhTop: { height: 320, flexDirection: "row" },
  rhHeatBlock: { flex: 1, paddingHorizontal: 28, paddingVertical: 20 },
  rhHeatHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  rhLegend: { flexDirection: "row", alignItems: "center", gap: 7 },
  rhSwatchWrap: { flexDirection: "row" },
  rhSwatch: { width: 22, height: 8 },
  rhHeatGrid: { flexDirection: "row", height: 160 },
  rhWeekCol: { width: 34, justifyContent: "space-around", paddingVertical: 2 },
  rhWeek: { color: "#8A7F72", fontSize: 11.5, fontFamily: serif },
  rhCloud: { flex: 1, height: 160 },
  rhAxisRow: { flexDirection: "row", paddingLeft: 34, marginTop: 8 },
  rhAxisText: { flex: 1, color: "#7A7165", fontSize: 12, fontFamily: serif },
  rhWindows: { width: 192, paddingHorizontal: 22, paddingVertical: 20 },
  rhWindow: { flexDirection: "row", alignItems: "center", gap: 13, height: 62, marginTop: 12 },
  rhWindowDivider: {},
  rhWinIcon: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "#4A4034", alignItems: "center", justifyContent: "center" },
  rhWinLabel: { color: "#D8CCBD", fontSize: 14.5, fontFamily: serif, letterSpacing: 1.5 },
  rhWinRange: { color: "#8F867B", fontSize: 12.5, marginTop: 4, fontVariant: ["tabular-nums"], fontFamily: serif },
  rhBottom: { flex: 1, flexDirection: "row", borderTopWidth: 1, borderTopColor: "#332C24" },
  rhChartBlock: { flex: 1, paddingHorizontal: 28, paddingVertical: 16 },
  rhWkHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rhWkLegendRow: { flexDirection: "row", justifyContent: "center", gap: 40, marginTop: 12 },
  rhWkLegend: { flexDirection: "row", alignItems: "center", gap: 8 },
  rhLegendText: { color: "#B9AA97", fontSize: 13, fontFamily: serif, letterSpacing: 1 },
  rhLegendLine: { width: 20, height: 1.5, backgroundColor: "#6FADB3" },
  rhLegendDashWrap: { flexDirection: "row", gap: 2.5, marginLeft: 10 },
  rhLegendDash: { width: 5, height: 1.5, backgroundColor: "#C9985B" },
  rhChart: { flex: 1, minHeight: 84, marginTop: 6 },
  rhYLabel: { position: "absolute", left: 2, color: "#7A7165", fontSize: 11.5, fontFamily: serif },
  rhYHigh: { top: "10%" },
  rhYMid: { top: "46%" },
  rhYLow: { bottom: "12%" },
  rhXAxis: { flexDirection: "row", justifyContent: "space-between", paddingLeft: 24, paddingRight: 6, marginTop: 5 },

  /* 06 你如何停留 */
  atBody: { flex: 1, flexDirection: "row" },
  atMain: { flex: 1, paddingHorizontal: 10, paddingVertical: 20 },
  atFunnelRow: { flex: 1, marginTop: 2 },
  atFunnelBg: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  atStagesLeft: { position: "absolute", left: 4, top: 14, bottom: 26 },
  atStagesRight: { position: "absolute", right: 4, top: 14, bottom: 26 },
  atStages: { width: 148, justifyContent: "space-between", paddingVertical: 10 },
  atStage: { flexDirection: "row", alignItems: "center", gap: 9 },
  atStageIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: "#3E5B5E", alignItems: "center", justifyContent: "center" },
  atStageIconGold: { borderColor: "#5A4730" },
  atStageIconBare: { borderWidth: 0 },
  atStageLabel: { color: "#D5C7B6", fontSize: 13.5, fontFamily: serif, letterSpacing: 1 },
  atStageValue: { color: "#CB9D65", fontSize: 15, fontFamily: didot, marginTop: 3 },
  atLead: { width: 34, height: 1, borderTopWidth: 1, borderTopColor: "#4A5E60", borderStyle: "dashed", opacity: 0.8, marginHorizontal: 2 },
  atLeadHidden: { opacity: 0 },
  atFunnelWrap: { alignItems: "center", justifyContent: "center" },
  atFunnelStack: { width: 351, height: 378, marginTop: 28 },
  atFunnelLayer: { position: "absolute", left: 0, top: 0, width: 351, height: 378 },
  atDone: { color: "#D9A86C", fontSize: 13.5, letterSpacing: 4, marginTop: 4, fontFamily: serif },
  atSpectrum: { width: 228, borderLeftWidth: 1, borderLeftColor: "#332C24", paddingHorizontal: 22, paddingVertical: 20 },
  atSpecBody: { flex: 1, flexDirection: "row", gap: 18, marginTop: 16 },
  atSpecLabels: { flex: 1, justifyContent: "space-between", paddingVertical: 6, maxHeight: 316 },
  atSpecRow: { flexDirection: "row", gap: 9, alignItems: "flex-start" },
  atSpecMark: { color: "#D8CCBD", fontSize: 11, marginTop: 4, opacity: 0 },
  atSpecMarkOn: { opacity: 1 },
  atSpecName: { fontSize: 16, fontFamily: serif, letterSpacing: 1.5 },
  atSpecDesc: { color: "#7C7266", fontSize: 12, lineHeight: 19, marginTop: 7, fontFamily: serif },

  /* 07 内容回声 */
  ceBody: { flex: 1, flexDirection: "row" },
  ceCol1: { flex: 1 },
  ceCol2: { flex: 1.22 },
  ceBlock: { paddingHorizontal: 24, paddingVertical: 16 },
  ceTopRow: { flexDirection: "row" },
  ceFormats: { flex: 1.12 },
  ceFormatRow: { flexDirection: "row", marginTop: 8 },
  ceFormatCell: { flex: 1, alignItems: "center", gap: 6 },
  ceFormatTile: { width: 46, height: 46, borderRadius: 9, borderWidth: 1, borderColor: "#4A4034", backgroundColor: "rgba(18,23,23,0.5)", alignItems: "center", justifyContent: "center" },
  ceFormatName: { color: "#D5C7B6", fontSize: 13.5, fontFamily: serif },
  ceFormatValue: { color: "#D9A86C", fontSize: 14, fontFamily: serif },
  ceSegments: { flexDirection: "row", height: 10, marginTop: 16, gap: 2 },
  ceSegment: { height: 10 },
  ceSegmentEmpty: { flex: 1, backgroundColor: "#1E2222" },
  ceDurRow: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 17 },
  ceDurLabel: { width: 30, color: "#D5C7B6", fontSize: 13.5, fontFamily: serif },
  ceDurEn: { width: 62, color: "#7C7266", fontSize: 10.5, fontFamily: serif },
  ceDurTrack: { flex: 1, height: 5, flexDirection: "row", alignItems: "center" },
  ceDurFill: { height: 5, borderRadius: 2.5 },
  ceDurValue: { width: 40, color: "#9A938A", fontSize: 13, textAlign: "right", fontFamily: didot },
  ceRankList: { flex: 1, maxHeight: 330, justifyContent: "space-evenly" },
  ceRankRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  ceRankNo: { width: 22, color: "#BC915C", fontSize: 17, fontFamily: didot },
  ceRankName: { width: 66, color: "#D8CCBD", fontSize: 15, fontFamily: serif, letterSpacing: 1 },
  ceRankTrack: { flex: 1, height: 9, flexDirection: "row", alignItems: "center" },
  ceRankFill: { height: 9, borderRadius: 5 },
  ceRankDash: { flex: 1, height: 1, borderTopWidth: 1, borderTopColor: "#574C3F", borderStyle: "dotted", marginLeft: 7, opacity: 0.85 },
  ceRankValue: { width: 44, color: "#9A938A", fontSize: 13.5, textAlign: "right", fontFamily: didot },
  ceNote: { color: "#6F665B", fontSize: 12, marginTop: "auto", paddingTop: 12, fontFamily: serif },
  ceConstWrap: { flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center" },
  ceVennWrap: { height: 240, alignItems: "center", justifyContent: "flex-start", alignSelf: "center", width: 298 },
  ceVennTag: { position: "absolute", alignItems: "center" },
  ceVennLabel: { color: "#D5C7B6", fontSize: 12.5, marginTop: 4, fontFamily: serif },
  ceVennCount: { color: "#E7BC87", fontSize: 10.5, fontVariant: ["tabular-nums"], fontFamily: serif },
  ceVennCenter: { position: "absolute", alignItems: "center", justifyContent: "center", width: 26, height: 20 },

  /* 08 创作者宇宙 */
  cuBody: { flex: 1, flexDirection: "row" },
  cuMap: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 8 },
  cuMapWrap: { width: 520, height: 500 },
  cuLabel: { position: "absolute", color: "#D8CFC4", fontSize: 14, letterSpacing: 0.8, maxWidth: 130, fontFamily: serif },
  cuPerson: { position: "absolute", width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: "#394A4C", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(10,13,13,0.45)" },
  cuRail: { width: 240, borderLeftWidth: 1, borderLeftColor: "#332C24" },
  cuBlock: { paddingHorizontal: 22, paddingVertical: 16 },
  cuDonutWrap: { alignSelf: "center", alignItems: "center", justifyContent: "center", marginTop: 6 },
  cuDonutValue: { position: "absolute", color: "#DEC7AB", fontSize: 18, fontFamily: didot },
  cuHint: { color: "#7C7266", fontSize: 11.5, marginTop: 9, textAlign: "center", fontFamily: serif },
  cuGaugeWrap: { alignSelf: "center", alignItems: "center", marginTop: 6 },
  cuGaugeValues: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 3 },
  cuGaugeTeal: { color: "#7FACB0", fontSize: 16, fontFamily: serif },
  cuGaugeSep: { color: "#6F665B", fontSize: 12 },
  cuGaugeGold: { color: "#D9A86C", fontSize: 16, fontFamily: serif },
  cuLegendRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 9 },
  cuLegendSpark: { color: "#6FADB3", fontSize: 11 },
  cuLegendDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#C9985B", marginLeft: 12 },
  cuTailWrap: { flex: 1, minHeight: 66, maxHeight: 130, marginTop: 8, alignSelf: "stretch" },
  cuTailY: { position: "absolute", left: 0, top: -2, color: "#6F665B", fontSize: 10, fontFamily: serif },
  cuTailX: { position: "absolute", right: 2, bottom: -2, color: "#6F665B", fontSize: 10, fontFamily: serif },

  /* 09 聊天回声 */
  chBody: { flex: 1, paddingHorizontal: 28, paddingVertical: 10 },
  chWaveRow: { flexDirection: "row", gap: 10 },
  chWaveAxis: { width: 46, justifyContent: "space-between", paddingVertical: 8 },
  chAxisSmall: { color: "#6F665B", fontSize: 10.5, letterSpacing: 0.5, fontFamily: serif },
  chWave: { height: 128 },
  chTimeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  chBottom: { flex: 1, flexDirection: "row", marginTop: 12, paddingTop: 8 },
  chTypes: { flex: 1.5, paddingRight: 20 },
  chTypeRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9, minHeight: 27 },
  chTypeCn: { width: 36, color: "#D5C7B6", fontSize: 13.5, fontFamily: serif },
  chTypeEn: { width: 48, color: "#6F665B", fontSize: 10, fontFamily: serif },
  chDotLine: { flex: 1, flexDirection: "row", alignItems: "center" },
  chRowLine: { position: "absolute", left: 2, right: 2, top: "50%", height: 1, backgroundColor: "#3A332A" },
  chSlotTick: { position: "absolute", alignSelf: "center", top: 1, bottom: 1, width: 1, backgroundColor: "#332D26" },
  chDotSlot: { flex: 1, alignItems: "center", justifyContent: "center", height: 22 },
  chWindows: { width: 306, paddingLeft: 18, borderWidth: 1, borderColor: "#3A332A", borderRadius: 8, paddingVertical: 8, paddingRight: 12, marginLeft: 4 },
  chRing: { alignSelf: "center", marginTop: 2, alignItems: "center", justifyContent: "center" },
  chRingMoon: { position: "absolute" },
  chRingLegend: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 4 },
  chLegendDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 9 },
  chPrivacy: { flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: "#CDB89F", borderWidth: 1, borderColor: "#594C3D", paddingLeft: 20, paddingRight: 24, paddingVertical: 14, marginTop: 14 },
  chLockRing: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "#6E6150", alignItems: "center", justifyContent: "center" },
  chPrivacyCn: { color: "#332B22", fontSize: 15, lineHeight: 21, fontFamily: serif, fontWeight: "600" },
  chPrivacyEn: { color: "#6E6150", fontSize: 11.5, marginTop: 3, letterSpacing: 0.4, fontFamily: serif },
  chPrivacyRule: { width: 130, height: 1, backgroundColor: "#8A7A66" },

  /* 10 交叉洞察 */
  cxRow: { flex: 1, flexDirection: "row", gap: 16, marginTop: 2 },
  cxBox: { flex: 1, borderWidth: 1, borderColor: "#3A3228", paddingHorizontal: 20, paddingVertical: 12 },
  cxPatterns: { flex: 1.25 },
  cxColHeadRow: { flexDirection: "row", marginTop: 4, marginBottom: 8 },
  cxRowLabelSpace: { width: 70 },
  cxColLabel: { width: 36, alignItems: "center", marginRight: 5 },
  cxColChar: { color: "#8A7F72", fontSize: 11, lineHeight: 13.5, fontFamily: serif },
  cxMatrixRow: { flexDirection: "row", alignItems: "center", marginBottom: 5 },
  cxRowLabel: { width: 70, color: "#9A938A", fontSize: 12.5, fontFamily: serif },
  cxCell: { width: 34, height: 34, marginRight: 5, backgroundColor: "#1E2323", borderWidth: 1, borderColor: "#2B2824" },
  cxCellStar: { position: "absolute", left: -1, top: -1 },
  cxCellDiag: { backgroundColor: "#28474A" },
  cxCellPos: { backgroundColor: "#4A3B28" },
  cxCellPosHot: { backgroundColor: "#8A6A44" },
  cxCellNeg: { backgroundColor: "#28474A" },
  cxCellNegHot: { backgroundColor: "#38666A" },
  cxCellWeak: { backgroundColor: "#262A2A" },
  cxLegend: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 12 },
  cxLegendSwatch: { width: 12, height: 12, marginLeft: 9 },
  cxCard: { flex: 1, flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: "#CDB89F", borderWidth: 1, borderColor: "#594C3D", paddingHorizontal: 20, paddingVertical: 14, marginTop: 14, borderRadius: 3 },
  cxCardRose: { width: 50, height: 50, borderRadius: 10, backgroundColor: "#20292A", borderWidth: 1, borderColor: "#3A4344", alignItems: "center", justifyContent: "center" },
  cxCardTitle: { color: "#26221D", fontSize: 17.5, fontFamily: serif, fontWeight: "700", letterSpacing: 0.5 },
  cxCardText: { color: "#6F665B", fontSize: 12.5, lineHeight: 18, marginTop: 6, fontFamily: serif },
  cxCardNo: { alignItems: "flex-end" },
  cxCardNoLabel: { color: "#8A7A66", fontSize: 9, letterSpacing: 1.8, fontFamily: serif },
  cxCardNoText: { color: "#3E7277", fontSize: 28, fontFamily: didot, marginTop: 2 },
  cxFacts: { borderWidth: 1, borderColor: "#3A3228", flexDirection: "row", marginTop: 14, paddingVertical: 12, paddingHorizontal: 18, gap: 18 },
  cxFact: { flex: 1, flexDirection: "row", gap: 11, alignItems: "flex-start" },
  cxFactMid: { borderLeftWidth: 1, borderLeftColor: "#332C24", borderRightWidth: 1, borderRightColor: "#332C24", paddingHorizontal: 18 },
  cxFactSpark: { color: "#C59861", fontSize: 17 },
  cxFactLabel: { color: "#7C7266", fontSize: 10.5, letterSpacing: 1.6, fontFamily: serif },
  cxFactValue: { color: "#CFC1B0", fontSize: 13, lineHeight: 18, marginTop: 5, fontFamily: serif },
  cxFactEn: { color: "#6F665B", fontSize: 10, marginTop: 2, fontFamily: serif },

  /* 11 意外发现 */
  spRow: { flex: 1, flexDirection: "row", gap: 14, marginTop: 4 },
  spCard: { flex: 1, backgroundColor: "#C3B29E", borderWidth: 1, borderColor: "#594C3D", borderRadius: 5, paddingHorizontal: 16, paddingVertical: 18, alignItems: "center" },
  spBadge: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#46585A", borderWidth: 1, borderColor: "#8A6A42", alignItems: "center", justifyContent: "center" },
  spBadgeText: { color: "#D9B17F", fontSize: 11, fontWeight: "800", fontFamily: serif },
  spTitle: { color: "#25211C", fontSize: 18.5, fontFamily: serif, letterSpacing: 1, marginTop: 13, textAlign: "center" },
  spArt: { height: 160, alignSelf: "stretch", alignItems: "center", justifyContent: "center", marginTop: 10 },
  spArtImg: { width: "100%", height: "100%" },
  spSealImg: { width: 130, height: 132 },
  spObsRow: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 12, alignSelf: "stretch" },
  spObsRule: { flex: 1, height: 1, backgroundColor: "#8F7D68" },
  spObsLabel: { color: "#5E5140", fontSize: 10.5, letterSpacing: 2.5, fontFamily: serif },
  spText: { color: "#3E372E", fontSize: 11.5, lineHeight: 17, textAlign: "center", marginTop: 9, fontFamily: serif },
  spCardSpark: { color: "#8A6435", fontSize: 13, marginTop: 12 },
  spSealCard: { justifyContent: "center", gap: 14, backgroundColor: "#090D0D", borderColor: "#2E2A26", paddingHorizontal: 10 },
  spSealTitle: { color: "#D8CCBD", fontSize: 13.5, fontFamily: serif, textAlign: "center", lineHeight: 22, letterSpacing: 0.5 },
  spSealText: { color: "#8F867B", fontSize: 12, textAlign: "center", fontFamily: serif, letterSpacing: 1 },
  spSealSpark: { color: "#C9985B", fontSize: 13, textAlign: "center" },
  spFoot: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#CBB79E", borderWidth: 1, borderColor: "#594C3D", marginTop: 14, paddingVertical: 13, paddingLeft: 18, paddingRight: 60 },
  spFootText: { color: "#3A332A", fontSize: 12.5, fontFamily: serif },
  spFootEn: { color: "#7C6F5F", fontSize: 10, fontFamily: serif },
  spFootRight: { color: "#4A3E30", fontSize: 12.5, letterSpacing: 1.5, fontFamily: serif, marginRight: 10 },

  /* 12 习惯印章 */
  hpBody: { flex: 1, flexDirection: "row", marginTop: 2 },
  hpEmblemCol: { width: 218, alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  hpEmblemWrap: { width: 210, height: 254 },
  hpEmblemImg: { width: "100%", height: "100%" },
  hpEmblemCn: { position: "absolute", top: 189, left: 0, right: 0, textAlign: "center", color: "#E2D4C2", fontSize: 16, fontFamily: serif, letterSpacing: 1.8 },
  hpEmblemEn: { position: "absolute", top: 214, left: 0, right: 0, textAlign: "center", color: "#C9B9A5", fontSize: 9.5, fontFamily: serif, letterSpacing: 1.2 },
  hpSummary: { flex: 1, paddingHorizontal: 4, paddingVertical: 16 },
  hpProfileReason: { color: "#A8947B", fontSize: 11.5, lineHeight: 17, marginTop: -4, marginBottom: 8, fontFamily: serif },
  hpLine: { flex: 1, flexDirection: "row", alignItems: "center", gap: 15 },
  hpLineDivider: { borderBottomWidth: 1, borderBottomColor: "#26221D" },
  hpLineIcon: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: "#4A4034", alignItems: "center", justifyContent: "center" },
  hpLineTitle: { color: "#E4D7C6", fontSize: 16.5, fontFamily: serif, letterSpacing: 1.5 },
  hpLineText: { color: "#8F867B", fontSize: 12.5, lineHeight: 19, marginTop: 5, fontFamily: serif },
  hpRadarCol: { width: 258, borderLeftWidth: 1, borderLeftColor: "#332C24", paddingHorizontal: 16, paddingVertical: 16 },
  hpRadarColMobile: { width: "100%", borderLeftWidth: 0 },
  hpRadarWrap: { width: 234, height: 204, alignSelf: "center", marginTop: "auto", marginBottom: "auto" },
  hpRadarInner: { width: 316, height: 276, transform: [{ scale: 0.74 }], transformOrigin: "top left" },
  hpRadarSvg: { position: "absolute", left: 8, top: 2 },
  hpRadarLabel: { position: "absolute" },
  hpRadarCn: { color: "#D5C7B6", fontSize: 12.5, fontFamily: serif },
  hpRadarEn: { color: "#6F665B", fontSize: 9, marginTop: 2, fontFamily: serif },
  hpFacts: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#332C24", paddingVertical: 14, paddingLeft: 26, paddingRight: 22, gap: 14, alignItems: "flex-start" },
  hpFact: { flex: 1 },
  hpFactNext: { flex: 1.85 },
  hpFactMid: { flex: 1.2, borderLeftWidth: 1, borderLeftColor: "#332C24", borderRightWidth: 1, borderRightColor: "#332C24", paddingHorizontal: 20 },
  hpLimitRow: { flexDirection: "row", gap: 10, marginTop: 7, alignItems: "flex-start" },
  hpButtons: { flexDirection: "row", gap: 12, marginTop: 9 },
  hpButtonsMobile: { flexDirection: "column", alignItems: "stretch" },
  hpSaveBtn: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#243E40", borderWidth: 1, borderColor: "#4E6B6E", paddingHorizontal: 13, paddingVertical: 13 },
  hpSaveText: { color: "#D7E3E4", fontSize: 15, fontWeight: "700", letterSpacing: 1.5, fontFamily: serif },
  hpSaveEn: { color: "#7FA0A3", fontSize: 8.5, letterSpacing: 1.2, marginTop: 2, fontFamily: serif },
  hpReBtn: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#DFCDB8", borderWidth: 1, borderColor: "#594C3D", paddingHorizontal: 13, paddingVertical: 13 },
  hpReText: { color: "#3A332A", fontSize: 15, fontWeight: "700", letterSpacing: 1.5, fontFamily: serif },
  hpReEn: { color: "#8A7A66", fontSize: 8.5, letterSpacing: 1.2, marginTop: 2, fontFamily: serif },
  // ponytail: 预期稿只有两个按钮; 数据大屏入口收成一枚箭头方钮
  hpDashboardBtn: { alignItems: "center", justifyContent: "center", width: 38, alignSelf: "stretch", backgroundColor: "transparent", borderWidth: 1, borderColor: "#3E5254" },

    pressed: { opacity: 0.7, transform: [{ translateY: 1 }] },
  disabled: { opacity: 0.32 },
});
