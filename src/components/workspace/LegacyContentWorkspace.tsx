import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  type TextProps,
  useWindowDimensions,
  View,
} from "react-native";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  Download,
  Eye,
  EyeOff,
  Heart,
  History,
  LayoutGrid,
  LayoutDashboard,
  List,
  MessageCircle,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Star,
} from "lucide-react-native";

import type {
  AnnualContentRef,
  AnnualHighlightsData,
  AnnualReport,
} from "../../domain/annualReport";
import type { LivingChapter, LivingReport } from "../../domain/livingReport";
import { countChatMessages, type ChatConversationSummary, type ChatMessage } from "../../domain/chatRecords";
import type {
  PersonalRecordCollection,
  PersonalRecordType,
  PersonalVideoRecord,
} from "../../domain/personalRecords";
import type { CollectorStatus } from "../../services/localCollector";
import type { ExploreConnection } from "../../services/explorer";
import type { AppStyle } from "../../services/appStyle";
import Svg, { Circle } from "react-native-svg";
import { ChatWorkspace } from "./ChatWorkspace";
import { RecordVideoPlayer, type RecordVideoLoader } from "./RecordVideoPlayer";
import { BatchVideoDownloadDialog } from "./BatchVideoDownloadDialog";
import { MAX_BATCH_VIDEOS, uniqueDownloadVideos, videoDownloadKey } from "../../services/batchVideoDownload";
import { ReportDashboard } from "./ReportDashboard";
import { buildReportModel } from "./ReportWorkspace";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ease, easeImage, fx, useCountUp, useDraw, useInView } from "./motion";

export type WorkspaceViewKey = PersonalRecordType | "summary" | "highlights" | "chat" | "explore";

export interface ContentWorkspaceProps {
  explore?: React.ReactNode;
  activeView: WorkspaceViewKey;
  records: PersonalRecordCollection;
  chatMessages?: ChatMessage[];
  chatConversations?: ChatConversationSummary[];
  chatConnected?: boolean;
  onToggleChatReception?: () => void;
  report: AnnualReport | LivingReport | null;
  sourceLabel: string;
  updatedAt: string | null;
  busy: boolean;
  chatBusy: boolean;
  status: CollectorStatus | null;
  onChangeView: (view: WorkspaceViewKey) => void;
  onOpenRecord: (url: string) => Promise<void>;
  onDownloadRecord?: (record: PersonalVideoRecord) => Promise<void>;
  onBatchDownloadActiveChange?: (active: boolean) => void;
  onLoadVideo?: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  downloadStates?: Record<string, RecordDownloadState>;
  onOpenSettings: () => void;
  onReplayStory: () => void;
  onSync: () => void;
  onTogglePrivacy: () => void;
  privacy: boolean;
  /** 整体风格：文案与纸纹装饰跟着走，配色本身由 workspaceTheme 的 CSS 变量切换 */
  appStyle?: AppStyle;
}

export type RecordDownloadState = "idle" | "queued" | "running" | "complete" | "failed";

type IconComponent = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
  fill?: string;
}>;

const navItems: Array<{ id: WorkspaceViewKey; label: string; icon: IconComponent; accent: string }> = [
  { id: "explore", label: "探索", icon: Search, accent: color.cyan },
  { id: "watch_history", label: "观看历史", icon: History, accent: color.cyan },
  { id: "liked_videos", label: "喜欢", icon: Heart, accent: color.accent },
  { id: "favorite_videos", label: "收藏", icon: Bookmark, accent: color.amber },
  { id: "chat", label: "聊天", icon: MessageCircle, accent: color.cyan },
  { id: "summary", label: "持续报告", icon: LayoutDashboard, accent: color.green },
  { id: "highlights", label: "变化线索", icon: Star, accent: color.cyan },
];


const webPointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;

// 侧栏收放是同一套版式在变窄：宽度做过渡，展开态的文字原地淡出并被侧栏裁掉，不换一套窄版面。
const COLLAPSE_MS = 380;
const collapseWidth = ease("width", COLLAPSE_MS);
const collapseCopy = ease("opacity", 220);

// ponytail: 包一层给全页默认正文字体（档案馆衬线 / 年志 Inter），比给上百条 style 逐个加 fontFamily 省
const bodyType = { fontFamily: font.body } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

export function ContentWorkspace({
  explore,
  activeView,
  records,
  chatMessages = [],
  chatConversations = [],
  chatConnected = false,
  onToggleChatReception,
  report,
  sourceLabel,
  updatedAt,
  busy,
  chatBusy,
  status,
  onChangeView,
  onOpenRecord,
  onDownloadRecord,
  onBatchDownloadActiveChange,
  onLoadVideo,
  commentsConnection,
  downloadStates = {},
  onOpenSettings,
  onReplayStory,
  onSync,
  onTogglePrivacy,
  privacy,
  appStyle = "archive",
}: ContentWorkspaceProps) {
  const { width } = useWindowDimensions();
  const mobile = width < 720;
  const trace = appStyle === "trace";
  const replayLabel = trace ? "重读内容年志" : "重看内容故事";
  const reportView = isReportView(activeView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 持续报告首次打开时自动收起；用户仍可用左上角按钮临时展开。
  const [reportAutoCollapsed, setReportAutoCollapsed] = useState(reportView);
  const previousReportViewRef = useRef(reportView);
  const responsiveSidebar = width >= 720 && width < 1080;
  const compactSidebar = width >= 720 && (responsiveSidebar || (reportView ? reportAutoCollapsed : sidebarCollapsed));
  const sidebarWidth = mobile ? 0 : compactSidebar ? 82 : 224;
  // root 的桌面内边距与 stage 边框会占掉 36px，使用同一个主区宽度供各内容页计算。
  const mainWidth = Math.max(0, width - (mobile ? 0 : 36) - sidebarWidth);
  const currentNav = navItems.find((item) => item.id === activeView) ?? navItems[0]!;
  const [reportUpdateNotice, setReportUpdateNotice] = useState(false);
  // 侧栏当前项的指示条：一根，随选中项滑动（各按钮 onLayout 报自己的 y）
  const [navTops, setNavTops] = useState<Record<string, number>>({});
  const reportNavTop = (id: string, y: number) => setNavTops((current) => (current[id] === y ? current : { ...current, [id]: y }));
  const seenUpdatedAtRef = useRef<string | null>(updatedAt);
  const totalRecords = records.watch_history.length + records.liked_videos.length + records.favorite_videos.length;
  const livingReport = report && isLivingReport(report) ? report : null;
  const model = useMemo(
    () => buildReportModel(records, chatMessages, report, chatConversations),
    [chatConversations, chatMessages, records, report],
  );
  const counts: Record<WorkspaceViewKey, number> = {
    explore: 0,
    watch_history: records.watch_history.length,
    liked_videos: records.liked_videos.length,
    favorite_videos: records.favorite_videos.length,
    chat: countChatMessages(chatMessages, chatConversations),
    summary: model.unique || totalRecords,
    highlights: livingReport
      ? livingReport.chapters.filter((chapter) => chapter.status === "ok").length
      : report && !isLivingReport(report)
        ? Object.values(report.highlights.data as AnnualHighlightsData).filter(Boolean).length
        : 0,
  };
  useEffect(() => {
    if (updatedAt && seenUpdatedAtRef.current && updatedAt !== seenUpdatedAtRef.current) setReportUpdateNotice(true);
    seenUpdatedAtRef.current = updatedAt;
  }, [updatedAt]);

  // 外部切换（例如从故事页进入大屏）也要在首帧前进入自动收起状态，避免先闪出展开侧栏。
  useLayoutEffect(() => {
    if (reportView && !previousReportViewRef.current) setReportAutoCollapsed(true);
    previousReportViewRef.current = reportView;
  }, [reportView]);

  const shownCount = useCountUp(counts[activeView]);
  const [ringRef, ringDrawn] = useDraw<View>();

  const changeView = (nextView: WorkspaceViewKey) => {
    if (isReportView(nextView) && !reportView) setReportAutoCollapsed(true);
    onChangeView(nextView);
  };

  const toggleSidebar = () => {
    if (reportView) {
      setReportAutoCollapsed((collapsed) => !collapsed);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  return (
    <View {...fx({ motion: "fade" })} testID="content-workspace" style={[styles.root, mobile && styles.rootMobile]}>
      <View style={[styles.stage, mobile && styles.stageMobile]}>
      {!mobile ? <SidebarToggle collapsed={compactSidebar} onPress={toggleSidebar} /> : null}
      {!mobile ? (
        <View testID="workspace-sidebar" style={[styles.sidebar, collapseWidth, compactSidebar && styles.sidebarCompact]}>
          <View style={styles.sidebarBody}>
          <View accessibilityRole="tablist" style={styles.sidebarNav}>
            {Platform.OS === "web" && navTops[activeView] !== undefined ? (
              <View pointerEvents="none" style={[styles.navGlider, ease("top,background-color", 380), { top: navTops[activeView]! + 14, backgroundColor: currentNav.accent }]} />
            ) : null}
            {navItems.map((item) => (
              <NavButton
                key={item.id}
                compact={compactSidebar}
                count={counts[item.id]}
                item={item}
                onLayoutTop={(y) => reportNavTop(item.id, y)}
                onPress={() => changeView(item.id)}
                selected={item.id === activeView}
              />
            ))}
          </View>
          <ActiveDays compact={compactSidebar} days={model.activeDays} drawn={ringDrawn} viewRef={ringRef} year={model.year} />
          </View>
          <View style={styles.sidebarFooter}>
            <Pressable
              accessibilityLabel={replayLabel}
              accessibilityRole="button"
              {...fx({ hover: "tint" })}
              disabled={!report || report.status === "empty"}
              onPress={onReplayStory}
              style={({ pressed }) => [
                styles.navButton,
                (!report || report.status === "empty") && styles.buttonDisabled,
                pressed && styles.buttonPressed,
                webPointer,
              ]}
            >
              <View style={styles.navIconWrap}><Sparkles color={color.accent} size={20} strokeWidth={2} /></View>
              <View style={[styles.navMeta, collapseCopy, compactSidebar && styles.sidebarCopyHidden]}>
                <Text numberOfLines={1} style={styles.navLabel}>{replayLabel}</Text>
              </View>
            </Pressable>
            <Pressable
              {...fx({ hover: "raise" })}
              accessibilityLabel="打开连接与采集设置"
              accessibilityRole="button"
              onPress={onOpenSettings}
              style={({ pressed }) => [styles.settingsButton, pressed && styles.buttonPressed, webPointer]}
            >
              <View style={styles.settingsIcon}><Settings2 color={color.textSecondary} size={19} strokeWidth={2} /></View>
              <Text numberOfLines={1} style={[styles.settingsButtonText, collapseCopy, compactSidebar && styles.sidebarCopyHidden]}>连接与采集</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={[styles.main, mobile && styles.mainMobile]}>
        <View testID="workspace-topbar" style={[styles.topbar, mobile && styles.topbarMobile]}>
          <View style={styles.topbarHeading}>
            <Text style={styles.topbarEyebrow}>{reportView ? "LIVING REPORT" : trace ? "CONTENT STREAMS" : "CONTENT ARCHIVE"}</Text>
            <View style={styles.topbarTitleRow}>
              <Text numberOfLines={1} style={[styles.topbarTitle, mobile && styles.topbarTitleMobile]}>{currentNav.label}</Text>
              {activeView !== "explore" ? <Text style={styles.topbarCount}>{shownCount.toLocaleString("zh-CN")}</Text> : null}
            </View>
          </View>
          <View style={styles.topbarActions}>
            {mobile ? (
              <Pressable
                accessibilityLabel={replayLabel}
                accessibilityRole="button"
                onPress={onReplayStory}
                style={({ pressed }) => [styles.toolbarButton, pressed && styles.buttonPressed, webPointer]}
              >
                <Sparkles color={color.accent} size={19} />
              </Pressable>
            ) : null}
            {activeView !== "explore" ? <Pressable
              accessibilityLabel={privacy ? "关闭隐私模式" : "开启隐私模式"}
              accessibilityRole="switch"
              accessibilityState={{ checked: privacy }}
              {...fx({ hover: "raise" })}
              onPress={onTogglePrivacy}
              style={({ pressed }) => [styles.toolbarButton, privacy && styles.toolbarButtonActive, pressed && styles.buttonPressed, webPointer]}
            >
              {privacy ? <EyeOff color={color.cyan} size={19} /> : <Eye color={color.textSecondary} size={19} />}
            </Pressable> : null}
            {activeView !== "explore" ? <Pressable
              accessibilityLabel="重新增量读取记录"
              accessibilityRole="button"
              disabled={busy}
              {...fx({ hover: "raise" })}
              onPress={onSync}
              style={({ pressed }) => [styles.toolbarButton, busy && styles.buttonDisabled, pressed && styles.buttonPressed, webPointer]}
            >
              {busy ? <ActivityIndicator color={color.cyan} size="small" /> : <RefreshCw color={color.textSecondary} size={19} />}
            </Pressable> : null}
            {mobile ? (
              <Pressable
                accessibilityLabel="打开连接与采集设置"
                accessibilityRole="button"
                onPress={onOpenSettings}
                style={({ pressed }) => [styles.toolbarButton, pressed && styles.buttonPressed, webPointer]}
              >
                <Settings2 color={color.textSecondary} size={19} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {reportView && reportUpdateNotice ? (
          <Pressable
            accessibilityRole="button"
            {...fx({ motion: "rise" })}
            accessibilityLabel="报告有更新，关闭提示"
            onPress={() => setReportUpdateNotice(false)}
            style={({ pressed }) => [styles.reportUpdateNotice, pressed && styles.buttonPressed, webPointer]}
          >
            <RefreshCw color={color.green} size={15} />
            <Text style={styles.reportUpdateNoticeText}>报告有更新 · 已保留当前阅读位置</Text>
          </Pressable>
        ) : null}

        {activeView === "explore" ? explore : activeView === "chat" ? (
          <ChatWorkspace
            busy={chatBusy}
            connected={chatConnected}
            status={status}
            onToggleReception={onToggleChatReception ?? onOpenSettings}
            sendConnection={commentsConnection}
            conversations={chatConversations}
            messages={chatMessages}
            mobile={mobile}
            onOpenRecord={onOpenRecord}
            onOpenSettings={onOpenSettings}
            privacy={privacy}
          />
        ) : activeView === "summary" ? (
          model.status === "empty"
            ? <SummaryEmpty />
            : <ReportDashboard mobile={mobile} model={model} onOpenRecord={onOpenRecord} privacy={privacy} width={mainWidth} />
        ) : activeView === "highlights" ? (
          livingReport
            ? <LivingHighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={livingReport} />
            : report && isLivingReport(report)
              ? <LivingHighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={report} />
              : <HighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={report} />
        ) : (
          <RecordsGallery
            activeType={activeView}
            downloadStates={downloadStates}
            mobile={mobile}
            onDownloadRecord={onDownloadRecord}
            onBatchDownloadActiveChange={onBatchDownloadActiveChange}
            onLoadVideo={onLoadVideo}
            commentsConnection={commentsConnection}
            onOpenRecord={onOpenRecord}
            onOpenSettings={onOpenSettings}
            privacy={privacy}
            records={records[activeView]}
            sourceLabel={sourceLabel}
            status={status}
            width={mainWidth}
          />
        )}
      </View>

      {Platform.OS === "web" && !trace ? (
        <>
          <View pointerEvents="none" style={styles.paperGrain}>
            <Image resizeMode="repeat" source={require("./assets/paper-grain.png")} style={styles.paperGrainImg} />
          </View>
          <View pointerEvents="none" style={styles.paperTint} />
          {!mobile ? (
            <View pointerEvents="none" style={styles.paperTint}>
              {[styles.cornerTL, styles.cornerTR, styles.cornerBL, styles.cornerBR].map((corner, index) => (
                <View key={index} style={[styles.corner, corner]} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {mobile ? (
        <View accessibilityRole="tablist" style={styles.bottomNav}>
          {Platform.OS === "web" ? (
            <View pointerEvents="none" style={[styles.bottomNavGlider, ease("left,background-color", 350), { left: `${(navItems.findIndex((item) => item.id === activeView) + 0.5) / navItems.length * 100}%`, backgroundColor: currentNav.accent }]} />
          ) : null}
          {navItems.map((item) => {
            const selected = item.id === activeView;
            const Icon = item.icon;
            return (
              <Pressable
                key={item.id}
                accessibilityLabel={item.id === "explore" ? item.label : `${item.label}，${counts[item.id]} 条`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => changeView(item.id)}
                style={({ pressed }) => [styles.bottomNavItem, pressed && styles.buttonPressed, webPointer]}
              >
                <Icon color={selected ? item.accent : color.textMuted} size={20} strokeWidth={selected ? 2.5 : 2} />
                <Text style={[styles.bottomNavLabel, selected && { color: item.accent }]}>{item.label === "观看历史" ? "历史" : item.label}</Text>
                {selected && Platform.OS !== "web" ? <View style={[styles.bottomNavIndicator, { backgroundColor: item.accent }]} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      </View>
    </View>
  );
}

function ActiveDays({ compact, days, drawn, viewRef, year }: { compact: boolean; days: number; drawn: number; viewRef: React.RefObject<View | null>; year: number }) {
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.min(1, days / 365) * drawn;
  return (
    <View ref={viewRef} style={styles.activeDays}>
      <View style={styles.navIconWrap}>
        <Svg height={34} viewBox="0 0 34 34" width={34}>
          <Circle cx={17} cy={17} fill="none" r={radius} stroke={color.border} strokeWidth={3} />
          <Circle cx={17} cy={17} fill="none" r={radius} stroke={color.cyan} strokeDasharray={`${filled} ${circumference}`} strokeWidth={3} transform="rotate(-90 17 17)" />
        </Svg>
      </View>
      <View style={[styles.navMeta, collapseCopy, compact && styles.sidebarCopyHidden]}>
        <Text numberOfLines={1} style={styles.activeDaysText}>
          {days ? `${year} 年有 ${days} 天留下记录` : `${year} 年还没有留下记录`}
        </Text>
      </View>
    </View>
  );
}

function SidebarToggle({ collapsed, onPress }: { collapsed: boolean; onPress: () => void }) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <Pressable
      testID="sidebar-collapse-toggle"
      accessibilityLabel={collapsed ? "展开侧栏" : "收起侧栏"}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.sidebarToggle, pressed && styles.buttonPressed, webPointer]}
    >
      <ToggleIcon color={color.textSecondary} size={17} strokeWidth={1.9} />
    </Pressable>
  );
}

function NavButton({
  compact,
  count,
  item,
  onLayoutTop,
  onPress,
  selected,
}: {
  compact: boolean;
  count: number;
  item: (typeof navItems)[number];
  onLayoutTop?: (y: number) => void;
  onPress: () => void;
  selected: boolean;
}) {
  const Icon = item.icon;
  return (
    <Pressable
      {...fx({ hover: "tint" })}
      testID={`workspace-nav-${item.id}`}
      accessibilityLabel={item.id === "explore" ? item.label : `${item.label}，${count} 条`}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onLayout={onLayoutTop ? (event) => onLayoutTop(event.nativeEvent.layout.y) : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.navButton,
        selected && styles.navButtonSelected,
        pressed && styles.buttonPressed,
        webPointer,
      ]}
    >
      <View style={[styles.navIconWrap, selected && { backgroundColor: alpha(item.accent, 0.13) }]}>
        <Icon color={selected ? item.accent : color.textMuted} size={20} strokeWidth={selected ? 2.5 : 2} />
      </View>
      <View style={[styles.navMeta, collapseCopy, compact && styles.sidebarCopyHidden]}>
        <Text numberOfLines={1} style={[styles.navLabel, selected && styles.navLabelSelected]}>{item.label}</Text>
        {item.id !== "explore" ? <Text style={[styles.navCount, selected && { color: item.accent }]}>{formatCompactNumber(count)}</Text> : null}
      </View>
      {selected && Platform.OS !== "web" ? <View style={[styles.navIndicator, { backgroundColor: item.accent }]} /> : null}
    </Pressable>
  );
}

function RecordsGallery({
  activeType,
  downloadStates,
  mobile,
  onDownloadRecord,
  onBatchDownloadActiveChange,
  onLoadVideo,
  commentsConnection,
  onOpenRecord,
  onOpenSettings,
  privacy,
  records,
  sourceLabel,
  status,
  width,
}: {
  activeType: PersonalRecordType;
  downloadStates: Record<string, RecordDownloadState>;
  mobile: boolean;
  onDownloadRecord?: (record: PersonalVideoRecord) => Promise<void>;
  onBatchDownloadActiveChange?: (active: boolean) => void;
  onLoadVideo?: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  onOpenRecord: (url: string) => Promise<void>;
  onOpenSettings: () => void;
  privacy: boolean;
  records: PersonalVideoRecord[];
  sourceLabel: string;
  status: CollectorStatus | null;
  width: number;
}) {
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [playingRecord, setPlayingRecord] = useState<PersonalVideoRecord | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRecords, setBatchRecords] = useState<PersonalVideoRecord[] | null>(null);
  useEffect(() => {
    onBatchDownloadActiveChange?.(batchRecords !== null);
    return () => onBatchDownloadActiveChange?.(false);
  }, [batchRecords, onBatchDownloadActiveChange]);
  useEffect(() => { setSelecting(false); setSelected(new Set()); }, [activeType, privacy]);
  useEffect(() => { setPlayingRecord(null); }, [activeType, privacy]);
  const columns = mobile ? 2 : width < 760 ? 3 : width < 1120 ? 4 : 5;
  const label = ({ watch_history: "观看历史", liked_videos: "喜欢", favorite_videos: "收藏" })[activeType];
  const sortedRecords = useMemo(() => records, [records]);
  const candidates = useMemo(() => uniqueDownloadVideos(records), [records]);
  const chosen = candidates.filter((record) => selected.has(videoDownloadKey(record)!));
  const selectionFor = (record: PersonalVideoRecord) => {
    if (!selecting) return undefined;
    const key = videoDownloadKey(record);
    return {
      checked: Boolean(key && selected.has(key)),
      disabled: !key || (chosen.length >= MAX_BATCH_VIDEOS && !selected.has(key)),
      toggle: () => {
        if (!key) return;
        setSelected((current) => {
          const next = new Set(chosen.map((item) => videoDownloadKey(item)!));
          if (current.has(key)) next.delete(key);
          else if (next.size < MAX_BATCH_VIDEOS) next.add(key);
          return next;
        });
      },
    };
  };

  return (
    <>
    {selecting ? <View style={styles.batchToolbar}>
      <Text style={styles.batchMeta}>已选 {chosen.length} / {candidates.length} 个可下载视频</Text>
      <View style={styles.batchActions}>
        <Pressable accessibilityRole="button" onPress={() => setSelected(new Set(candidates.slice(0, MAX_BATCH_VIDEOS).map((record) => videoDownloadKey(record)!)))} style={styles.batchButton}>
          <Text style={styles.batchButtonText}>{candidates.length > MAX_BATCH_VIDEOS ? "选择前 50 个" : "全选"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setSelected(new Set())} style={styles.batchButton}><Text style={styles.batchButtonText}>清空选择</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: chosen.length === 0 }} disabled={chosen.length === 0}
          onPress={() => { if (!commentsConnection) { onOpenSettings(); return; } setPlayingRecord(null); setBatchRecords(chosen); }}
          style={[styles.batchButton, styles.batchPrimary, chosen.length === 0 && styles.buttonDisabled]}>
          <Download size={14} color={color.buttonText} /><Text style={styles.batchPrimaryText}>下载所选（{chosen.length}）</Text>
        </Pressable>
      </View>
      <Text style={styles.batchHint}>每批最多 50 个；重复作品自动合并，图文、直播和无有效链接的记录不可选。</Text>
    </View> : null}
    <FlatList
      testID="record-grid"
      key={`${layout}:${columns}`}
      columnWrapperStyle={layout === "grid" ? styles.gridRow : undefined}
      contentContainerStyle={[styles.galleryContent, mobile && styles.galleryContentMobile, records.length === 0 && styles.galleryContentEmpty]}
      data={sortedRecords}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={(
        <View {...fx({ motion: "rise" })} style={styles.galleryHeader}>
          <View style={styles.galleryHeaderCopy}>
            <Text style={styles.galleryTitle}>{label}</Text>
            <Text style={styles.galleryMeta}>{sourceLabel} · {status?.message ?? `${records.length} 条本地记录`}</Text>
          </View>
          {Platform.OS === "web" && !privacy && candidates.length > 0 ? <Pressable accessibilityRole="button"
            onPress={() => { setSelecting(!selecting); setSelected(new Set()); }} style={styles.batchButton}>
            <Download size={15} color={color.textSecondary} /><Text style={styles.batchButtonText}>{selecting ? "退出多选" : "批量下载"}</Text>
          </Pressable> : null}
          <View accessibilityRole="tablist" style={styles.layoutSwitch}>
            <Pressable
              accessibilityLabel="网格视图"
              accessibilityRole="tab"
              accessibilityState={{ selected: layout === "grid" }}
              onPress={() => setLayout("grid")}
              style={({ pressed }) => [styles.layoutButton, layout === "grid" && styles.layoutButtonSelected, pressed && styles.buttonPressed, webPointer]}
            >
              <LayoutGrid color={layout === "grid" ? color.text : color.textMuted} size={18} />
            </Pressable>
            <Pressable
              accessibilityLabel="列表视图"
              accessibilityRole="tab"
              accessibilityState={{ selected: layout === "list" }}
              onPress={() => setLayout("list")}
              style={({ pressed }) => [styles.layoutButton, layout === "list" && styles.layoutButtonSelected, pressed && styles.buttonPressed, webPointer]}
            >
              <List color={layout === "list" ? color.text : color.textMuted} size={18} />
            </Pressable>
          </View>
        </View>
      )}
      ListEmptyComponent={(
        <View {...fx({ motion: "rise" })} style={styles.emptyState}>
          <View style={styles.emptyIcon}><Play color={color.cyan} fill={color.cyan} size={24} /></View>
          <Text style={styles.emptyTitle}>{label}还没有内容</Text>
          <Text style={styles.emptyDetail}>返回连接与采集页面读取本地记录。</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed, webPointer]}
          >
            <Settings2 color={color.black} size={18} />
            <Text style={styles.emptyButtonText}>连接与采集</Text>
          </Pressable>
        </View>
      )}
      numColumns={layout === "grid" ? columns : 1}
      renderItem={({ item }) => layout === "grid"
        ? <RecordTile
            selection={selectionFor(item)}
            downloadState={downloadStates[item.id] ?? "idle"}
            onDownloadRecord={onDownloadRecord}
            onPlayRecord={onLoadVideo && item.mediaType !== "image" && item.mediaType !== "live" ? setPlayingRecord : undefined}
            onOpenRecord={onOpenRecord}
            privacy={privacy}
            record={item}
            type={activeType}
          />
        : <RecordRow selection={selectionFor(item)} onOpenRecord={onOpenRecord} privacy={privacy} record={item} type={activeType} />}
      showsVerticalScrollIndicator={false}
    />
    {Platform.OS === "web" && playingRecord && !privacy && onLoadVideo ? (
      <RecordVideoPlayer record={playingRecord} records={sortedRecords} onLoadVideo={onLoadVideo} commentsConnection={commentsConnection} onOpenRecord={onOpenRecord} onClose={() => setPlayingRecord(null)} />
    ) : null}
    {batchRecords && commentsConnection ? <BatchVideoDownloadDialog records={batchRecords} connection={commentsConnection} privacy={privacy} onClose={() => setBatchRecords(null)} /> : null}
    </>
  );
}

type RecordSelection = { checked: boolean; disabled: boolean; toggle: () => void };

function SelectionMark({ selection }: { selection: RecordSelection }) {
  return <View pointerEvents="none" style={[styles.selectionMark, selection.checked && styles.selectionChecked, selection.disabled && styles.buttonDisabled]}>
    {selection.checked ? <Check size={16} color={color.buttonText} /> : null}
  </View>;
}

function RecordTile({
  selection,
  downloadState,
  onDownloadRecord,
  onPlayRecord,
  record,
  type,
  privacy,
  onOpenRecord,
}: {
  selection?: RecordSelection;
  downloadState: RecordDownloadState;
  onDownloadRecord?: (record: PersonalVideoRecord) => Promise<void>;
  onPlayRecord?: (record: PersonalVideoRecord) => void;
  record: PersonalVideoRecord;
  type: PersonalRecordType;
  privacy: boolean;
  onOpenRecord: (url: string) => Promise<void>;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const tileRef = useRef<View | null>(null);
  const [, inView] = useInView(tileRef);
  const focusCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accent = type === "liked_videos" ? color.accent : type === "favorite_videos" ? color.amber : color.cyan;
  const imageAvailable = Boolean(record.coverUrl && !privacy && !imageFailed);
  const downloading = downloadState === "queued" || downloadState === "running";
  const showActions = !selection && Platform.OS === "web" && Boolean(record.url) && !privacy && (hovered || focused);
  const downloadLabel = downloading
    ? "下载中"
    : downloadState === "complete"
      ? "已下载"
      : downloadState === "failed" ? "重试" : "下载";
  const markFocused = () => setFocused(true);
  const checkFocusBoundary = (event?: unknown) => {
    if (Platform.OS !== "web") {
      setFocused(false);
      return;
    }
    const eventLike = event as {
      nativeEvent?: { relatedTarget?: unknown };
      relatedTarget?: unknown;
    } | undefined;
    const relatedTarget = eventLike?.nativeEvent?.relatedTarget ?? eventLike?.relatedTarget;
    const relatedElement = relatedTarget as { closest?: (selector: string) => unknown } | null;
    if (relatedElement?.closest?.('[data-testid="record-tile-action"]')) return;
    if (focusCheckTimer.current) clearTimeout(focusCheckTimer.current);
    focusCheckTimer.current = setTimeout(() => {
      focusCheckTimer.current = null;
      const node = tileRef.current as unknown as { contains?: (value: unknown) => boolean } | null;
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      if (!node?.contains?.(activeElement)) setFocused(false);
    }, 0);
  };
  useEffect(() => () => {
    if (focusCheckTimer.current) clearTimeout(focusCheckTimer.current);
  }, []);
  return (
    <View
      {...fx({ reveal: inView, hover: "card" })}
      ref={tileRef}
      testID={`record-tile-${record.id}`}
      onFocus={markFocused}
      onBlur={checkFocusBoundary}
      {...(Platform.OS === "web"
        ? ({
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          } as Record<string, unknown>)
        : {})}
      style={styles.tile}
    >
      <Pressable
        accessibilityLabel={selection ? `${selection.disabled && !selection.checked ? "不可选择" : "选择视频"}：${record.title}` : `${privacy ? "已隐藏内容" : record.title}${record.url ? "，打开抖音视频" : ""}`}
        accessibilityRole={selection ? "checkbox" : record.url ? "link" : undefined}
        accessibilityState={selection ? { checked: selection.checked, disabled: selection.disabled } : undefined}
        aria-checked={selection?.checked}
        disabled={selection ? selection.disabled : !record.url}
        onFocus={markFocused}
        onPress={() => selection ? selection.toggle() : record.url && void onOpenRecord(record.url)}
        style={({ pressed }) => [styles.tileMain, pressed && styles.tilePressed, record.url && webPointer]}
      >
        <View style={[styles.tileVisual, { backgroundColor: fallbackColor(record.id) }]}>
          {selection ? <View style={styles.tileSelection}><SelectionMark selection={selection} /></View> : null}
          {imageAvailable ? (
            <ImageBackground
              accessibilityLabel={privacy ? "已隐藏的视频封面" : `${record.title}的视频封面`}
              imageStyle={[styles.tileImage, easeImage("transform", 900), hovered && styles.tileImageZoom]}
              onError={() => setImageFailed(true)}
              resizeMode="cover"
              source={{ uri: record.coverUrl! }}
              style={styles.tileImage}
            />
          ) : (
            <View style={styles.fallbackVisual}>
              <View style={[styles.fallbackDisc, { borderColor: accent }]}><Music2 color={accent} size={26} strokeWidth={1.8} /></View>
              <Text style={styles.fallbackIndex}>{String(hashString(record.id) % 99 + 1).padStart(2, "0")}</Text>
            </View>
          )}
          <View style={styles.tileTopMeta}>
            <View style={[styles.typeBadge, { backgroundColor: accent }]} />
            {record.durationSeconds ? <Text style={styles.durationBadge}>{formatDuration(record.durationSeconds)}</Text> : null}
          </View>
          <View style={styles.tileBottomMeta}>
            {record.watchProgress?.percent !== undefined && record.watchProgress.percent !== null ? (
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(2, Math.min(100, record.watchProgress.percent))}%`, backgroundColor: accent }]} /></View>
            ) : null}
            <View style={styles.tilePlayMeta}>
              <Play color={color.white} fill={color.white} size={12} />
              <Text style={styles.tilePlayText}>{record.stats?.playCount ? formatCompactNumber(record.stats.playCount) : "记录"}</Text>
            </View>
          </View>
        </View>
        <Text numberOfLines={2} style={styles.tileTitle}>{privacy ? "内容标题已隐藏" : record.title}</Text>
        <View style={styles.tileMetaRow}>
          <Text numberOfLines={1} style={styles.tileAuthor}>{privacy ? "创作者已隐藏" : record.author ?? "未知创作者"}</Text>
          <Text style={styles.tileDate}>{formatShortDate(record.occurredAt)}</Text>
        </View>
      </Pressable>
      {showActions ? (
        <View {...fx({ motion: "fade" })} pointerEvents="auto" style={styles.tileActionsOverlay}>
          {onPlayRecord ? (
            <Pressable
              testID="record-tile-action"
              accessibilityLabel="播放视频"
              accessibilityRole="button"
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={() => onPlayRecord(record)}
              style={({ pressed }) => [styles.tilePlayButton, pressed && styles.tileActionPressed, webPointer]}
            >
              <Play color={color.white} fill={color.white} size={28} style={{ marginLeft: 3 }} />
            </Pressable>
          ) : null}
          <View style={styles.tileActionsRow}>
            <Pressable
              testID="record-tile-action"
              accessibilityLabel="跳转到抖音视频"
              accessibilityRole="link"
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={() => record.url && void onOpenRecord(record.url)}
              style={({ pressed }) => [styles.tileAction, pressed && styles.tileActionPressed, webPointer]}
            >
              <ArrowUpRight color={color.white} size={14} strokeWidth={2.2} />
              <Text style={styles.tileActionText}>跳转</Text>
            </Pressable>
            <Pressable
              testID="record-tile-action"
              accessibilityLabel={downloading ? "视频正在下载" : `${downloadLabel}视频`}
              accessibilityRole="button"
              accessibilityState={{ disabled: downloading }}
              disabled={downloading || !onDownloadRecord}
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={() => onDownloadRecord && void onDownloadRecord(record)}
              style={({ pressed }) => [styles.tileAction, (downloading || !onDownloadRecord) && styles.tileActionDisabled, pressed && styles.tileActionPressed, webPointer]}
            >
              {downloading ? <ActivityIndicator color={color.white} size="small" /> : <Download color={color.white} size={14} strokeWidth={2.2} />}
              <Text style={styles.tileActionText}>{downloadLabel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function RecordRow({ record, type, privacy, onOpenRecord, selection }: { record: PersonalVideoRecord; type: PersonalRecordType; privacy: boolean; onOpenRecord: (url: string) => Promise<void>; selection?: RecordSelection }) {
  const [imageFailed, setImageFailed] = useState(false);
  const accent = type === "liked_videos" ? color.accent : type === "favorite_videos" ? color.amber : color.cyan;
  const imageAvailable = Boolean(record.coverUrl && !privacy && !imageFailed);
  return (
    <Pressable
      accessibilityLabel={selection ? `${selection.disabled && !selection.checked ? "不可选择" : "选择视频"}：${record.title}` : `${privacy ? "已隐藏内容" : record.title}${record.url ? "，打开抖音视频" : ""}`}
      accessibilityRole={selection ? "checkbox" : record.url ? "link" : undefined}
      accessibilityState={selection ? { checked: selection.checked, disabled: selection.disabled } : undefined}
      aria-checked={selection?.checked}
      disabled={selection ? selection.disabled : !record.url}
      onPress={() => selection ? selection.toggle() : record.url && void onOpenRecord(record.url)}
      {...fx({ hover: "tint" })}
      style={({ pressed }) => [styles.recordRow, pressed && styles.recordRowPressed, record.url && webPointer]}
    >
      {selection ? <SelectionMark selection={selection} /> : null}
      <View style={[styles.rowThumb, { backgroundColor: fallbackColor(record.id) }]}>
        {imageAvailable ? (
          <ImageBackground onError={() => setImageFailed(true)} resizeMode="cover" source={{ uri: record.coverUrl! }} style={styles.rowThumbImage} />
        ) : <Music2 color={accent} size={22} />}
      </View>
      <View style={styles.rowCopy}>
        <Text numberOfLines={2} style={styles.rowTitle}>{privacy ? "内容标题已隐藏" : record.title}</Text>
        <Text numberOfLines={1} style={styles.rowAuthor}>{privacy ? "创作者已隐藏" : record.author ?? "未知创作者"}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.rowMetaText}>{formatShortDate(record.occurredAt)}</Text>
          {record.durationSeconds ? <Text style={styles.rowMetaText}>{formatDuration(record.durationSeconds)}</Text> : null}
          {record.topics?.[0] ? <Text style={[styles.rowTopic, { color: accent }]}>#{privacy ? "话题" : record.topics[0]}</Text> : null}
        </View>
      </View>
      {record.url && !selection ? <ArrowUpRight color={color.textMuted} size={19} /> : null}
    </Pressable>
  );
}

function isReportView(view: WorkspaceViewKey): boolean {
  return view === "summary" || view === "highlights";
}

function isLivingReport(report: AnnualReport | LivingReport): report is LivingReport {
  return "currentWindow" in report;
}

function LivingHighlightsView({
  report,
  privacy,
  mobile,
  onOpenRecord,
}: {
  report: LivingReport;
  privacy: boolean;
  mobile: boolean;
  onOpenRecord: (url: string) => Promise<void>;
}) {
  const chapters = report.chapters.filter((chapter) => ["current", "shift", "profile", "kept"].includes(chapter.id));
  return (
    <ScrollView
      testID="living-changes-view"
      contentContainerStyle={[styles.highlightsContent, mobile && styles.summaryContentMobile]}
      showsVerticalScrollIndicator={false}
    >
      <View {...fx({ motion: "rise" })} style={[styles.highlightsHeader, mobile && styles.highlightsHeaderMobile]}>
        <View style={styles.dashboardHeaderCopy}>
          <Text style={styles.summaryEyebrow}>CHANGES · {formatLivingFreshness(report.freshness)}</Text>
          <Text style={[styles.summaryTitle, mobile && styles.summaryTitleMobile]}>变化线索</Text>
          <Text style={styles.summaryLead}>把最近发生的变化、稳定倾向和真实证据放在同一条线上。</Text>
        </View>
        <View style={[styles.highlightCountBlock, mobile && styles.dashboardPeriodMobile]}>
          <Text style={styles.highlightCountValue}>{chapters.filter((chapter) => chapter.status === "ok").length}</Text>
          <Text style={styles.dashboardPeriodMeta}>项当前线索</Text>
        </View>
      </View>
      <View style={styles.livingChangeList}>
        {chapters.map((chapter, index) => <LivingChangeCard chapter={chapter} index={index} key={chapter.id} onOpenRecord={onOpenRecord} privacy={privacy} />)}
      </View>
      <View style={styles.highlightsFootnote}>
        <Sparkles color={color.cyan} size={16} />
        <Text style={styles.highlightsFootnoteText}>线索来自当前本地样本；不足以判断的部分会保留为“尚在形成”。</Text>
      </View>
    </ScrollView>
  );
}

function LivingChangeCard({
  chapter,
  index,
  onOpenRecord,
  privacy,
}: {
  chapter: LivingChapter;
  index: number;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
}) {
  const accent = chapter.id === "shift" ? color.accent : chapter.id === "profile" ? color.green : color.cyan;
  const [cardRef, inView] = useInView<View>();
  return (
    <View {...fx({ reveal: inView, i: index + 1, hover: "lift" })} ref={cardRef} style={[styles.livingChangeCard, { borderTopColor: accent }]}>
      <View style={styles.livingChangeHeader}>
        <Text style={styles.livingChangeEyebrow}>{chapter.eyebrow}</Text>
        <Text style={[styles.livingChangeStatus, chapter.status !== "ok" && styles.livingChangeStatusMuted]}>{chapter.status === "ok" ? "已形成" : "尚在形成"}</Text>
      </View>
      <Text style={styles.livingChangeTitle}>{chapter.title}</Text>
      <Text style={styles.livingChangeNarrative}>{privacy ? privateLivingNarrative(chapter) : chapter.narrative}</Text>
      {chapter.signals.slice(0, 3).map((signal) => (
        <View key={signal.id} style={styles.livingChangeSignal}>
          <Text numberOfLines={1} style={styles.livingChangeSignalLabel}>{privacy ? "内容线索" : signal.label}</Text>
          <Text style={styles.livingChangeSignalValue}>{signal.value}</Text>
          <Text style={styles.livingChangeSignalDelta}>{formatLivingDelta(signal.delta)}</Text>
        </View>
      ))}
      {chapter.evidence.slice(0, 2).map((item, index) => {
        const title = privacy ? `内容 ${index + 1}` : item.title;
        const canOpen = Boolean(item.url && !privacy);
        return (
          <Pressable
            accessibilityLabel={`${title}${canOpen ? "，打开记录" : ""}`}
            accessibilityRole={canOpen ? "link" : undefined}
            disabled={!canOpen}
            key={`${item.videoId ?? item.title}:${index}`}
            onPress={() => item.url && void onOpenRecord(item.url)}
            style={({ pressed }) => [styles.livingChangeEvidence, pressed && styles.buttonPressed]}
          >
            <Text numberOfLines={1} style={styles.livingChangeEvidenceTitle}>{title}</Text>
            <Text style={styles.livingChangeEvidenceMeta}>{privacy ? "详情已隐藏" : item.author ?? "未知创作者"}</Text>
            {canOpen ? <ArrowUpRight color={color.textMuted} size={14} /> : null}
          </Pressable>
        );
      })}
      {chapter.notice ? <Text style={styles.panelNotice}>{chapter.notice}</Text> : null}
    </View>
  );
}

function privateLivingNarrative(chapter: LivingChapter): string {
  if (chapter.id === "current") return "最近一段时间里，内容线索已经出现轮廓。";
  if (chapter.id === "shift") return "近期内容线索的占比正在发生变化。";
  if (chapter.id === "profile") return "当前样本显示出一些行为倾向，但具体内容已隐藏。";
  if (chapter.id === "kept") return "列表之间存在可比较的交集，具体内容已隐藏。";
  return chapter.narrative;
}

function formatLivingFreshness(value: LivingReport["freshness"]): string {
  return value === "fresh" ? "刚更新" : value === "stale" ? "需要更新" : value === "partial" ? "部分采集" : "时间未知";
}

function formatLivingDelta(value: number | null): string {
  if (value === null) return "";
  const percent = Math.round(Math.abs(value) * 100);
  return value > 0.02 ? `+${percent}%` : value < -0.02 ? `-${percent}%` : "稳定";
}

const highlightDefinitions: Array<{
  key: keyof AnnualHighlightsData;
  label: string;
  rule: string;
  accent: string;
}> = [
  { key: "first", label: "首条记录", rule: "按可靠行为时间排序", accent: color.cyan },
  { key: "last", label: "末条记录", rule: "按可靠行为时间排序", accent: color.green },
  { key: "peakDay", label: "峰值日代表", rule: "活跃峰值日中的代表内容", accent: color.accent },
  { key: "longest", label: "最长内容", rule: "按可用时长字段排序", accent: color.amber },
  { key: "mostEngaged", label: "互动快照最高", rule: "按平台互动统计快照合计", accent: color.cyan },
];

function HighlightsView({
  report,
  privacy,
  mobile,
  onOpenRecord,
}: {
  report: AnnualReport | null;
  privacy: boolean;
  mobile: boolean;
  onOpenRecord: (url: string) => Promise<void>;
}) {
  if (!report || report.status === "empty") return <SummaryEmpty />;
  const highlights = report.highlights.data as AnnualHighlightsData;
  const availableCount = highlightDefinitions.filter(({ key }) => Boolean(highlights[key])).length;
  const highlightNotice = [
    report.highlights.status !== "ok" ? report.highlights.reason : null,
    ...report.highlights.notices,
  ].filter((notice, index, notices): notice is string => Boolean(notice) && notices.indexOf(notice) === index).join(" ");

  return (
    <ScrollView
      testID="highlights-view"
      contentContainerStyle={[styles.highlightsContent, mobile && styles.summaryContentMobile]}
      showsVerticalScrollIndicator={false}
    >
      <View {...fx({ motion: "rise" })} style={[styles.highlightsHeader, mobile && styles.highlightsHeaderMobile]}>
        <View style={styles.dashboardHeaderCopy}>
          <Text style={styles.summaryEyebrow}>HIGHLIGHTS · {report.periodLabel.toUpperCase()}</Text>
          <Text style={[styles.summaryTitle, mobile && styles.summaryTitleMobile]}>变化线索</Text>
          <Text style={styles.summaryLead}>从最近新增、偏好变化、回访模式和稳定倾向里，保留可被证据支持的线索。</Text>
        </View>
        <View style={[styles.highlightCountBlock, mobile && styles.dashboardPeriodMobile]}>
          <Text style={styles.highlightCountValue}>{availableCount}</Text>
          <Text style={styles.dashboardPeriodMeta}>项当前线索</Text>
        </View>
      </View>
      {highlightNotice ? <PanelNotice text={highlightNotice} /> : null}

      <View style={[styles.highlightsGrid, mobile && styles.highlightsGridMobile]}>
        {highlightDefinitions.map((definition, index) => (
          <HighlightCard
            key={definition.key}
            accent={definition.accent}
            index={index}
            item={highlights[definition.key]}
            label={definition.label}
            mobile={mobile}
            onOpenRecord={onOpenRecord}
            privacy={privacy}
            rule={definition.rule}
          />
        ))}
      </View>
      <View style={styles.highlightsFootnote}>
        <Star color={color.amber} size={16} />
        <Text style={styles.highlightsFootnoteText}>互动最高仅表示平台统计快照；首条、末条与峰值日仅使用可靠行为时间。</Text>
      </View>
    </ScrollView>
  );
}

function HighlightCard({
  accent,
  index,
  item,
  label,
  mobile,
  onOpenRecord,
  privacy,
  rule,
}: {
  accent: string;
  index: number;
  item: AnnualContentRef | null;
  label: string;
  mobile: boolean;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  rule: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [item?.coverUrl]);
  const [cardRef, inView] = useInView<View>();
  const imageAvailable = Boolean(item?.coverUrl && !privacy && !imageFailed);
  const canOpen = Boolean(item?.url && !privacy);
  const title = item ? (privacy ? "内容标题已隐藏" : item.title) : "暂无可确定内容";
  const author = item ? (privacy ? "创作者已隐藏" : item.author ?? "未知创作者") : "当前样本缺少对应记录";
  const detail = item ? (privacy ? "详情已替换" : formatHighlightDetail(item)) : "等待更多可靠数据";

  return (
    <Pressable
      {...fx({ reveal: inView, i: index + 1, hover: "card" })}
      ref={cardRef}
      accessibilityLabel={`${label}：${title}${canOpen ? "，打开抖音视频" : ""}`}
      accessibilityRole={canOpen ? "link" : undefined}
      disabled={!canOpen}
      onPress={() => item?.url && void onOpenRecord(item.url)}
      style={({ pressed }) => [
        styles.highlightCard,
        mobile && styles.highlightCardMobile,
        { borderTopColor: accent },
        !item && styles.highlightCardEmpty,
        pressed && styles.tilePressed,
        canOpen && webPointer,
      ]}
    >
      <View style={[styles.highlightVisual, { backgroundColor: fallbackColor(`${label}:${index}`) }]}>
        {imageAvailable ? (
          <ImageBackground
            accessibilityLabel={`${title}的视频封面`}
            onError={() => setImageFailed(true)}
            resizeMode="cover"
            source={{ uri: item!.coverUrl! }}
            style={styles.highlightImage}
          />
        ) : (
          <View style={styles.highlightFallback}>
            <Star color={accent} size={38} strokeWidth={1.7} />
            <Text style={styles.highlightIndex}>{String(index + 1).padStart(2, "0")}</Text>
          </View>
        )}
        <View style={[styles.highlightLabel, { borderColor: accent }]}><Text style={styles.highlightLabelText}>{label}</Text></View>
      </View>
      <View style={styles.highlightBody}>
        <Text numberOfLines={2} style={styles.highlightTitle}>{title}</Text>
        <Text numberOfLines={1} style={styles.highlightAuthor}>{author}</Text>
        <Text style={styles.highlightDetail}>{detail}</Text>
        <View style={styles.highlightRuleRow}>
          <Text style={styles.highlightRule}>{rule}</Text>
          {canOpen ? <ArrowUpRight color={color.textMuted} size={17} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function SummaryEmpty() {
  return (
    <View {...fx({ motion: "rise" })} style={styles.summaryEmpty}>
      <Sparkles color={color.green} size={30} />
      <Text style={styles.emptyTitle}>这一章还在形成</Text>
      <Text style={styles.emptyDetail}>完成一次读取并积累带可靠行为时间的记录后，持续报告会逐步生成当前主线、变化线索和行为画像。</Text>
    </View>
  );
}

function PanelNotice({ text }: { text: string }) {
  return <Text style={styles.panelNotice}>{text}</Text>;
}

function formatCompactNumber(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return value.toLocaleString("zh-CN");
}

function formatShortDate(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatHighlightDetail(item: AnnualContentRef): string {
  const parts: string[] = [];
  if (item.occurredAt) {
    const date = new Date(item.occurredAt);
    if (Number.isFinite(date.getTime())) {
      parts.push(date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }));
    }
  }
  if (item.durationSeconds !== null) parts.push(formatDuration(item.durationSeconds));
  if (item.interactionScore !== null) parts.push(`互动快照 ${formatCompactNumber(item.interactionScore)}`);
  return parts.join(" · ") || "时间与辅助字段不可确定";
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

function fallbackColor(value: string): string {
  return color.tints[hashString(value) % color.tints.length]!;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: "100%", padding: 18, backgroundColor: color.canvas },
  rootMobile: { padding: 0 },
  stage: { position: "relative", flex: 1, minHeight: 0, flexDirection: "row", overflow: "hidden", borderWidth: 1, borderColor: color.frame, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: color.shadow },
  stageMobile: { borderWidth: 0 },
  paperGrain: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, opacity: 0.3, zIndex: 40 },
  paperGrainImg: { width: "100%", height: "100%" },
  paperTint: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 41, backgroundColor: "rgba(38,32,24,0.05)" },
  corner: { position: "absolute", width: 26, height: 26, borderColor: color.frame, opacity: 0.9 },
  cornerTL: { left: 8, top: 8, borderLeftWidth: 1, borderTopWidth: 1 },
  cornerTR: { right: 8, top: 8, borderRightWidth: 1, borderTopWidth: 1 },
  cornerBL: { left: 8, bottom: 8, borderLeftWidth: 1, borderBottomWidth: 1 },
  cornerBR: { right: 8, bottom: 8, borderRightWidth: 1, borderBottomWidth: 1 },
  // 收起态只改宽度：内边距、图标位置、各行高度都不变，窄侧栏是宽侧栏被裁出来的。
  sidebar: { width: 224, flexShrink: 0, paddingHorizontal: 14, paddingBottom: 16, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border, backgroundColor: color.sidebar, overflow: "hidden" },
  sidebarCompact: { width: 82 },
  sidebarCopyHidden: { opacity: 0 },
  sidebarToggle: { position: "absolute", left: 14, top: 2, width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface, zIndex: 5 },
  sidebarBody: { flex: 1, paddingTop: 46 },
  sidebarNav: { gap: 4 },
  activeDays: { flexDirection: "row", alignItems: "center", minHeight: 44, marginTop: 26, paddingHorizontal: 8 },
  activeDaysText: { flex: 1, color: color.textMuted, fontSize: 10, marginLeft: 7 },
  navButton: { position: "relative", minHeight: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, borderRadius: radius.medium },
  // 展开态的文字块固定宽度：侧栏变窄时它被裁掉，而不是挤成省略号。
  navMeta: { width: 144, flexShrink: 0, flexDirection: "row", alignItems: "center" },
  navButtonSelected: { backgroundColor: color.surfaceRaised },
  navIconWrap: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.medium },
  navLabel: { flex: 1, color: color.textSecondary, fontSize: 13, fontWeight: "600", letterSpacing: 2, marginLeft: 7 },
  navLabelSelected: { color: color.text, fontWeight: "700" },
  navCount: { color: color.textMuted, fontSize: 11, fontFamily: font.didot, letterSpacing: 0.5, marginRight: 6 },
  navIndicator: { position: "absolute", left: -14, top: 14, bottom: 14, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  navGlider: { position: "absolute", left: -14, width: 3, height: 24, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  sidebarFooter: { gap: 8 },
  settingsButton: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 17, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  settingsIcon: { width: 19, height: 19 },
  settingsButtonText: { flexShrink: 0, color: color.textSecondary, fontSize: 12, fontWeight: "600", letterSpacing: 2 },
  main: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: "transparent" },
  mainMobile: { paddingBottom: 68 },
  topbar: { height: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: 28, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border, backgroundColor: "transparent" },
  topbarMobile: { height: 64, paddingHorizontal: 16 },
  topbarHeading: { flex: 1, minWidth: 0 },
  topbarEyebrow: { color: color.accent, fontSize: 9, fontWeight: "600", letterSpacing: 3.5, fontFamily: font.mono },
  topbarTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 9, marginTop: 3 },
  topbarTitle: { maxWidth: "80%", color: color.text, fontSize: 20, fontWeight: "600", letterSpacing: 3, fontFamily: font.serif },
  topbarTitleMobile: { fontSize: 17 },
  topbarCount: { color: color.textMuted, fontSize: 13, fontFamily: font.didot, letterSpacing: 1, fontVariant: ["tabular-nums"] },
  topbarActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  reportUpdateNotice: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 14, marginTop: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: color.green, borderRadius: radius.medium, backgroundColor: color.greenSoft },
  reportUpdateNoticeText: { color: color.green, fontSize: 10, fontWeight: "800" },
  toolbarButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  toolbarButtonActive: { borderColor: color.cyan, backgroundColor: color.cyanSoft },
  galleryContent: { paddingHorizontal: 28, paddingTop: 18, paddingBottom: 42 },
  galleryContentMobile: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 28 },
  galleryContentEmpty: { flexGrow: 1 },
  galleryHeader: { minHeight: 60, flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 },
  batchToolbar: { paddingHorizontal: 16, paddingVertical: 12, gap: 10, backgroundColor: color.surfaceRaised, borderBottomWidth: 1, borderBottomColor: color.border },
  batchMeta: { color: color.text, fontSize: 13 }, batchHint: { color: color.textMuted, fontSize: 11, lineHeight: 17 },
  batchActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  batchButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  batchButtonText: { color: color.textSecondary, fontSize: 12 }, batchPrimary: { backgroundColor: color.button, borderColor: color.button }, batchPrimaryText: { color: color.buttonText, fontSize: 12 },
  tileSelection: { position: "absolute", left: 10, top: 10, zIndex: 3 },
  selectionMark: { width: 26, height: 26, borderWidth: 1, borderColor: color.textMuted, borderRadius: 6, backgroundColor: color.surface, alignItems: "center", justifyContent: "center" },
  selectionChecked: { backgroundColor: color.button, borderColor: color.button },
  galleryHeaderCopy: { flex: 1, minWidth: 0 },
  galleryTitle: { color: color.text, fontSize: 16, fontWeight: "600", letterSpacing: 2.5, fontFamily: font.serif },
  galleryMeta: { color: color.textMuted, fontSize: 10, marginTop: 5 },
  layoutSwitch: { height: 42, flexDirection: "row", padding: 3, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.sidebar },
  layoutButton: { width: 40, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  layoutButtonSelected: { backgroundColor: color.surfaceMuted },
  gridRow: { gap: 12 },
  tile: { position: "relative", flex: 1, minWidth: 0, marginBottom: 22 },
  tileMain: { width: "100%" },
  tilePressed: { opacity: 0.74 },
  tileVisual: { position: "relative", width: "100%", aspectRatio: 0.76, overflow: "hidden", borderRadius: radius.small, backgroundColor: color.surface },
  tileImage: { width: "100%", height: "100%" },
  tileImageZoom: { transform: [{ scale: 1.06 }] },
  fallbackVisual: { flex: 1, alignItems: "center", justifyContent: "center" },
  fallbackDisc: { width: 62, height: 62, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 31, backgroundColor: color.scrim },
  fallbackIndex: { position: "absolute", right: 10, bottom: 8, color: color.text, opacity: 0.2, fontSize: 30, fontWeight: "900" },
  tileTopMeta: { position: "absolute", top: 9, right: 9, left: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  typeBadge: { width: 8, height: 8, borderRadius: 4 },
  durationBadge: { color: color.white, fontSize: 10, fontWeight: "800", paddingHorizontal: 6, paddingVertical: 3, borderRadius: radius.small, backgroundColor: color.scrim },
  tileBottomMeta: { position: "absolute", right: 0, bottom: 0, left: 0, padding: 9, backgroundColor: color.scrim },
  progressTrack: { height: 2, overflow: "hidden", marginBottom: 7, backgroundColor: "rgba(239,223,204,0.18)" },
  progressFill: { height: 2 },
  tilePlayMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
  tilePlayText: { color: color.white, fontSize: 10, fontWeight: "700" },
  tileTitle: { minHeight: 39, color: color.text, fontSize: 13, lineHeight: 19, fontWeight: "700", marginTop: 9 },
  tileMetaRow: { minHeight: 20, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
  tileAuthor: { flex: 1, color: color.textMuted, fontSize: 10 },
  tileDate: { color: color.textMuted, fontSize: 9 },
  tileActionsOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
    aspectRatio: 0.76,
    overflow: "hidden",
    justifyContent: "flex-end",
    padding: 10,
    borderRadius: radius.small,
    backgroundColor: "rgba(12,15,15,0.62)",
    zIndex: 2,
  },
  tileActionsRow: { flexDirection: "row", gap: 8 },
  tilePlayButton: {
    position: "absolute", top: "50%", left: "50%", marginTop: -30, marginLeft: -30,
    width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.85)", backgroundColor: "rgba(20,24,23,0.55)",
  },
  tileAction: {
    minHeight: 34,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: "rgba(239,223,204,0.42)",
    borderRadius: radius.small,
    backgroundColor: "rgba(20,24,23,0.84)",
  },
  tileActionText: { color: color.white, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  tileActionPressed: { backgroundColor: "rgba(239,223,204,0.18)" },
  tileActionDisabled: { opacity: 0.72 },
  recordRow: { minHeight: 112, flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  recordRowPressed: { backgroundColor: color.surface },
  rowThumb: { width: 72, height: 92, flexShrink: 0, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: radius.small },
  rowThumbImage: { width: "100%", height: "100%" },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  rowAuthor: { color: color.textSecondary, fontSize: 11, marginTop: 6 },
  rowMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 8 },
  rowMetaText: { color: color.textMuted, fontSize: 10 },
  rowTopic: { fontSize: 10, fontWeight: "700" },
  emptyState: { flex: 1, minHeight: 360, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  emptyIcon: { width: 58, height: 58, alignItems: "center", justifyContent: "center", borderRadius: 29, borderWidth: 1, borderColor: color.border },
  emptyTitle: { color: color.text, fontSize: 17, fontWeight: "600", letterSpacing: 3, marginTop: 16, fontFamily: font.serif },
  emptyDetail: { color: color.textMuted, fontSize: 12, lineHeight: 19, textAlign: "center", marginTop: 7 },
  emptyButton: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: color.cyan },
  emptyButtonText: { color: color.black, fontSize: 12, fontWeight: "900" },
  bottomNav: { position: "absolute", right: 0, bottom: 0, left: 0, height: 68, flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, backgroundColor: color.sidebar, zIndex: 20 },
  bottomNavItem: { position: "relative", flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 4 },
  bottomNavLabel: { color: color.textMuted, fontSize: 10, letterSpacing: 1.5 },
  bottomNavIndicator: { position: "absolute", top: 0, width: 28, height: 2 },
  bottomNavGlider: { position: "absolute", top: 0, width: 28, height: 2, marginLeft: -14 },
  summaryContentMobile: { padding: 12, paddingBottom: 86 },
  dashboardHeaderCopy: { flex: 1, minWidth: 0 },
  dashboardPeriodMobile: { width: "100%", alignItems: "flex-start", paddingLeft: 0, paddingTop: 14, borderTopWidth: 1, borderTopColor: color.border, borderLeftWidth: 0 },
  dashboardPeriodMeta: { color: color.textMuted, fontSize: 10, lineHeight: 16, letterSpacing: 0.8, marginTop: 6 },
  summaryEyebrow: { color: color.accent, fontSize: 10, fontWeight: "600", letterSpacing: 3.5, fontFamily: font.mono },
  summaryTitle: { maxWidth: 720, color: color.text, fontSize: 30, lineHeight: 40, fontWeight: "600", letterSpacing: 3, marginTop: 10, fontFamily: font.serif },
  summaryTitleMobile: { fontSize: 24, lineHeight: 32 },
  summaryLead: { color: color.textSecondary, fontSize: 12.5, lineHeight: 21, letterSpacing: 0.8, marginTop: 12 },
  panelNotice: { color: color.amber, fontSize: 9, lineHeight: 15, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: color.border },
  highlightsContent: { padding: 28, paddingBottom: 44 },
  highlightsHeader: { minHeight: 128, flexDirection: "row", alignItems: "center", gap: 28, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: color.border },
  highlightsHeaderMobile: { minHeight: 0, flexDirection: "column", alignItems: "stretch", gap: 16, paddingVertical: 16 },
  highlightCountBlock: { width: 180, alignItems: "flex-end", paddingLeft: 20, borderLeftWidth: 1, borderLeftColor: color.border },
  highlightCountValue: { color: color.text, fontSize: 40, lineHeight: 46, fontFamily: font.didot, fontVariant: ["tabular-nums"] },
  highlightsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 18 },
  highlightsGridMobile: { flexDirection: "column" },
  highlightCard: { width: "32%", minWidth: 260, minHeight: 338, overflow: "hidden", borderWidth: 1, borderTopWidth: 4, borderColor: color.border, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: color.shadow },
  highlightCardMobile: { width: "100%", minWidth: 0 },
  highlightCardEmpty: { opacity: 0.72 },
  highlightVisual: { position: "relative", height: 190, overflow: "hidden" },
  highlightImage: { width: "100%", height: "100%" },
  highlightFallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  highlightIndex: { position: "absolute", right: 14, bottom: 8, color: color.text, opacity: 0.2, fontSize: 34, fontWeight: "900" },
  highlightLabel: { position: "absolute", top: 12, left: 12, minHeight: 28, justifyContent: "center", paddingHorizontal: 9, borderWidth: 1, borderRadius: radius.small, backgroundColor: color.scrim },
  highlightLabelText: { color: color.white, fontSize: 9, fontWeight: "900" },
  highlightBody: { flex: 1, padding: 15 },
  highlightTitle: { minHeight: 42, color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "900" },
  highlightAuthor: { color: color.textSecondary, fontSize: 10, marginTop: 7 },
  highlightDetail: { color: color.textMuted, fontSize: 9, marginTop: 5 },
  highlightRuleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: "auto", paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  highlightRule: { flex: 1, color: color.textMuted, fontSize: 9, lineHeight: 14 },
  highlightsFootnote: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16, paddingHorizontal: 14, borderLeftWidth: 3, borderLeftColor: color.amber, backgroundColor: color.amberSoft },
  highlightsFootnoteText: { flex: 1, color: color.textSecondary, fontSize: 10, lineHeight: 16 },
  livingChangeList: { gap: 12, marginTop: 18 },
  livingChangeCard: { minHeight: 180, padding: 16, borderWidth: 1, borderTopWidth: 4, borderColor: color.border, borderRadius: radius.large, backgroundColor: color.surface, boxShadow: color.shadow },
  livingChangeHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  livingChangeEyebrow: { color: color.textMuted, fontSize: 9, fontWeight: "900", letterSpacing: 0.4 },
  livingChangeStatus: { color: color.green, fontSize: 9, fontWeight: "900" },
  livingChangeStatusMuted: { color: color.amber },
  livingChangeTitle: { color: color.text, fontSize: 18, lineHeight: 24, fontWeight: "900", marginTop: 7, fontFamily: font.serif },
  livingChangeNarrative: { color: color.textSecondary, fontSize: 12, lineHeight: 19, marginTop: 8 },
  livingChangeSignal: { minHeight: 27, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7, paddingHorizontal: 8, backgroundColor: color.surfaceRaised },
  livingChangeSignalLabel: { flex: 1, color: color.textSecondary, fontSize: 10, fontWeight: "800" },
  livingChangeSignalValue: { color: color.text, fontSize: 10, fontWeight: "900" },
  livingChangeSignalDelta: { width: 40, color: color.green, fontSize: 9, textAlign: "right" },
  livingChangeEvidence: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, paddingHorizontal: 8, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.sidebar },
  livingChangeEvidenceTitle: { flex: 1, color: color.textSecondary, fontSize: 9, fontWeight: "700" },
  livingChangeEvidenceMeta: { maxWidth: 80, color: color.textMuted, fontSize: 8 },
  summaryEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.38 },
});
