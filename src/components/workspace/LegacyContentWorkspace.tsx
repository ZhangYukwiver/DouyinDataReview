import React, { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  ImageBackground,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type CellRendererProps,
  type TextProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import {
  ArrowUpRight,
  Bookmark,
  ChartColumn,
  Check,
  Download,
  Eye,
  EyeOff,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Funnel,
  Heart,
  History,
  LayoutGrid,
  LibraryBig,
  LayoutDashboard,
  List,
  MessageCircle,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  Search,
  Send,
  Plug,
  Settings,
  Settings2,
  Sparkles,
  Bot,
  Star,
  Trash2,
  TvMinimalPlay,
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
import { collectorFeedFilteredVideos, type CollectorStatus } from "../../services/localCollector";
import type { ExploreConnection } from "../../services/explorer";
import { DEFAULT_APP_STYLE, DEFAULT_STORY_STYLE, resolveStoryStyle, type AppStyle, type StoryStyle } from "../../services/appStyle";
import Svg, { Circle } from "react-native-svg";
import { ChatWorkspace } from "./ChatWorkspace";
import { RecordVideoPlayer, type RecordVideoLoader } from "./RecordVideoPlayer";
import { LiveRoomPlayer, type LiveTarget } from "./LiveRoomPlayer";
import { liveRoomIdFrom, readFollowingLive, type LiveFollowing } from "../../services/liveRoom";
import { waitForCollector } from "../../services/videoFeed";
import { BatchVideoDownloadDialog } from "./BatchVideoDownloadDialog";
import { MAX_BATCH_VIDEOS, uniqueDownloadVideos, videoDownloadKey } from "../../services/batchVideoDownload";
import { earliestRecordDate, searchRecords } from "../../services/recordSearch";
import {
  ALL_FOLDERS,
  FOLDERS_MAX,
  UNFILED,
  addFolder,
  countByFolder,
  filterByFolder,
  folderKey,
  folderNameProblem,
  moveToFolder,
  newFolderId,
  readRecordFolders,
  removeFolder,
  renameFolder,
  saveRecordFolders,
  type RecordFolder,
  type RecordFolderList,
  type RecordFolders,
} from "../../services/recordFolders";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { BadgeShelf, PioneerBadge } from "./PioneerBadge";
import { ReportDashboard } from "./ReportDashboard";
import { buildReportModel } from "./ReportWorkspace";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ease, easeImage, fx, useCountUp, useDraw, useInView, ws } from "./motion";

export type WorkspaceViewKey = PersonalRecordType | "live" | "feed_filtered" | "summary" | "highlights" | "chat" | "feed" | "explore" | "creator" | "assistant";

export interface ContentWorkspaceProps {
  /** 刷视频：进工作台默认就是这一页 */
  feed?: React.ReactNode;
  explore?: React.ReactNode;
  creator?: React.ReactNode;
  /** AI 助手是可选功能：没装就不传，侧栏也不出这一项 */
  assistant?: React.ReactNode;
  activeView: WorkspaceViewKey;
  records: PersonalRecordCollection;
  /** 读取中这一轮新读到、还不在 records 里的记录：只进列表和侧栏计数，报告等读完拿到整份再算 */
  liveRecords?: PersonalRecordCollection | null;
  chatMessages?: ChatMessage[];
  chatConversations?: ChatConversationSummary[];
  chatConnected?: boolean;
  onToggleChatReception?: () => void;
  onCollectChatHistory?: () => void;
  report: AnnualReport | LivingReport | null;
  sourceLabel: string;
  updatedAt: string | null;
  busy: boolean;
  chatBusy: boolean;
  status: CollectorStatus | null;
  onChangeView: (view: WorkspaceViewKey) => void;
  onOpenRecord: (url: string) => Promise<void>;
  /** keepExplore：从播放器里下载时别关探索会话，评论面板还在用 */
  onDownloadRecord?: (record: PersonalVideoRecord, keepExplore?: boolean) => Promise<void>;
  /** 送去拆片工坊：采集器下好视频，再由桌面外壳放进拆片工坊的收件箱；只有桌面版给 */
  onSendToReelLab?: (record: PersonalVideoRecord) => void;
  onBatchDownloadActiveChange?: (active: boolean) => void;
  onLoadVideo?: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  downloadStates?: Record<string, RecordDownloadState>;
  /** 送去拆片工坊的进度，和下载一样按记录 id 记 */
  sendStates?: Record<string, RecordDownloadState>;
  onOpenSettings: () => void;
  onReplayStory: () => void;
  onSync: () => void;
  onTogglePrivacy: () => void;
  privacy: boolean;
  /** 整体风格：文案与纸纹装饰跟着走，配色本身由 workspaceTheme 的 CSS 变量切换 */
  appStyle?: AppStyle;
  /** 极简风格打开报告时借用的那套故事页（决定「重看」按钮叫什么） */
  storyStyle?: StoryStyle;
  /** 打开设置面板；不传就不显示侧栏的「设置」 */
  onOpenPreferences?: () => void;
}

export type RecordDownloadState = "idle" | "queued" | "running" | "complete" | "failed";

type IconComponent = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
  fill?: string;
}>;

type NavItem<Id extends string = WorkspaceViewKey> = { id: Id; label: string; icon: IconComponent; accent: string };

const navItems: NavItem[] = [
  { id: "feed", label: "刷视频", icon: TvMinimalPlay, accent: color.accent },
  { id: "explore", label: "探索", icon: Search, accent: color.cyan },
  { id: "creator", label: "创作者中心", icon: ChartColumn, accent: color.accent },
  { id: "assistant", label: "AI 助手", icon: Bot, accent: color.accent },
  { id: "watch_history", label: "观看历史", icon: History, accent: color.cyan },
  { id: "live", label: "直播", icon: Radio, accent: color.cyan },
  { id: "liked_videos", label: "喜欢", icon: Heart, accent: color.accent },
  { id: "favorite_videos", label: "收藏", icon: Bookmark, accent: color.amber },
  { id: "feed_filtered", label: "推荐流挡掉的", icon: Funnel, accent: color.green },
  { id: "chat", label: "聊天", icon: MessageCircle, accent: color.cyan },
  { id: "summary", label: "持续报告", icon: LayoutDashboard, accent: color.green },
  { id: "highlights", label: "变化线索", icon: Star, accent: color.cyan },
];


// 观看历史、直播、喜欢、收藏、推荐流挡掉的是同一种记录列表：侧栏只占「内容库」一项，进去用页签切换
const LIBRARY_VIEWS: readonly WorkspaceViewKey[] = ["watch_history", "live", "liked_videos", "favorite_videos", "feed_filtered"];
const isLibraryView = (view: WorkspaceViewKey) => LIBRARY_VIEWS.includes(view);
type SideKey = WorkspaceViewKey | "library";
const libraryItems = navItems.filter((item) => isLibraryView(item.id));
// 刷视频、探索、创作者中心和 AI 助手是工具页：不显示条数、隐私和重新读取
const toolView = (view: SideKey) => view === "feed" || view === "explore" || view === "creator" || view === "assistant";
const sideItem = (id: SideKey) => navItems.find((item) => item.id === id)!;
// 侧栏按功能分区：看视频 / 我的记录 / 报告 / 创作工具，区和区之间一道细线
const sideItems: NavItem<SideKey>[] = [
  sideItem("feed"), sideItem("explore"),
  { id: "library", label: "内容库", icon: LibraryBig, accent: color.cyan }, sideItem("chat"),
  sideItem("summary"), sideItem("highlights"),
  sideItem("creator"), sideItem("assistant"),
];
const SECTION_STARTS: ReadonlySet<SideKey> = new Set(["library", "summary", "creator"]);
const withoutAssistant = sideItems.filter((item) => item.id !== "assistant");

const webPointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;

const NO_RECORDS: PersonalVideoRecord[] = [];
// 直播记录存在观看历史里（mediaType live），侧栏单独一栏，观看历史只列视频，免得一条出现两次
const splitLive = (list: PersonalVideoRecord[]) => [
  list.filter((record) => record.mediaType !== "live"),
  list.filter((record) => record.mediaType === "live"),
] as const;

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
  feed,
  explore,
  creator,
  assistant,
  activeView,
  records,
  liveRecords = null,
  chatMessages = [],
  chatConversations = [],
  chatConnected = false,
  onToggleChatReception,
  onCollectChatHistory,
  report,
  sourceLabel,
  updatedAt,
  busy,
  chatBusy,
  status,
  onChangeView,
  onOpenRecord,
  onDownloadRecord,
  onSendToReelLab,
  onBatchDownloadActiveChange,
  onLoadVideo,
  commentsConnection,
  downloadStates = {},
  sendStates = {},
  onOpenSettings,
  onReplayStory,
  onSync,
  onTogglePrivacy,
  privacy,
  appStyle = DEFAULT_APP_STYLE,
  storyStyle = DEFAULT_STORY_STYLE,
  onOpenPreferences,
}: ContentWorkspaceProps) {
  const { width, height } = useWindowDimensions();
  const mobile = width < 720;
  // 只有档案馆的工作台铺纸纹；年志、海报、极简都不铺
  const archive = appStyle === "archive";
  const story = resolveStoryStyle(appStyle, storyStyle);
  const replayLabel = story === "poster" ? "重看年度海报" : story === "trace" ? "重读内容年志" : "重翻年度档案";
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
  const sideKey: SideKey = isLibraryView(activeView) ? "library" : activeView;
  const sides = assistant ? sideItems : withoutAssistant;
  // 点侧栏「内容库」回到上次看的那一栏
  const lastLibraryView = useRef<WorkspaceViewKey>(isLibraryView(activeView) ? activeView : "watch_history");
  if (isLibraryView(activeView)) lastLibraryView.current = activeView;
  const [reportUpdateNotice, setReportUpdateNotice] = useState(false);
  // 侧栏当前项的指示条：一根，随选中项滑动（各按钮 onLayout 报自己的 y）
  const [navTops, setNavTops] = useState<Record<string, number>>({});
  // 侧栏导航段：放得下时不设 overflow（年志选中项的外发光照旧溢出、像素同以前），放不下才变成滚动容器
  const sidebarBodyRef = useRef<View>(null);
  const [sidebarOverflow, setSidebarOverflow] = useState(false);
  const measureSidebar = () => {
    const body = sidebarBodyRef.current as unknown as HTMLElement | null;
    if (body && typeof body.scrollHeight === "number") setSidebarOverflow(body.scrollHeight > body.clientHeight + 1);
  };
  // 滚动时当前项被裁掉就把它滚进来（往下多滚半格，让下一项露个头）
  useEffect(() => {
    if (Platform.OS !== "web" || !sidebarOverflow) return;
    const body = sidebarBodyRef.current as unknown as HTMLElement | null;
    const item = body?.querySelector<HTMLElement>(`[data-testid="workspace-nav-${sideKey}"]`);
    if (!body || !item) return;
    const frame = body.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.top < frame.top) body.scrollTop += rect.top - frame.top;
    else if (rect.bottom > frame.bottom) body.scrollTop += rect.bottom - frame.bottom + 24;
  }, [sideKey, sidebarOverflow, height]);
  const reportNavTop = (id: string, y: number) => setNavTops((current) => (current[id] === y ? current : { ...current, [id]: y }));
  const seenUpdatedAtRef = useRef<string | null>(updatedAt);
  const totalRecords = records.watch_history.length + records.liked_videos.length + records.favorite_videos.length;
  const livingReport = report && isLivingReport(report) ? report : null;
  // 读聊天历史时每存一批就换一份聊天，报告模型一次要算两百毫秒，滚动跟着一顿一顿：读完再一次算齐，聊天页照常实时显示。
  // 记录换了（移除导入文件、切换账号）就是换了数据来源，聊天得跟着换，不能拿上一份的聊天配新的记录
  const reportChatsRef = useRef({ records, chatMessages, chatConversations });
  if (!status?.chat.progress || reportChatsRef.current.records !== records) reportChatsRef.current = { records, chatMessages, chatConversations };
  const reportChats = reportChatsRef.current;
  const model = useMemo(
    () => buildReportModel(records, reportChats.chatMessages, report, reportChats.chatConversations),
    [reportChats.chatConversations, reportChats.chatMessages, records, report],
  );
  const [watchedVideos, watchedLives] = useMemo(() => splitLive(records.watch_history), [records.watch_history]);
  const [incomingVideos, incomingLives] = useMemo(() => splitLive(liveRecords?.watch_history ?? NO_RECORDS), [liveRecords?.watch_history]);
  const folders = useRecordFolders(commentsConnection, status?.account?.id);
  const feedVideos = useFeedFilteredVideos(commentsConnection, activeView === "feed_filtered");
  const counts: Record<SideKey, number> = {
    feed: 0,
    explore: 0,
    creator: 0,
    assistant: 0,
    watch_history: watchedVideos.length + incomingVideos.length,
    live: watchedLives.length + incomingLives.length,
    liked_videos: records.liked_videos.length + (liveRecords?.liked_videos.length ?? 0),
    favorite_videos: records.favorite_videos.length + (liveRecords?.favorite_videos.length ?? 0),
    feed_filtered: feedVideos.length,
    library: 0,
    chat: countChatMessages(chatMessages, chatConversations),
    summary: model.unique || totalRecords,
    highlights: livingReport
      ? livingReport.chapters.filter((chapter) => chapter.status === "ok").length
      : report && !isLivingReport(report)
        ? Object.values(report.highlights.data as AnnualHighlightsData).filter(Boolean).length
        : 0,
  };
  counts.library = LIBRARY_VIEWS.reduce((sum, view) => sum + counts[view], 0);
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

  const changeView = (next: SideKey) => {
    const nextView = next === "library" ? lastLibraryView.current : next;
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

  // 极简：内容库的页签直接放进顶栏，替掉和选中页签重复的标题，少一行横条
  const tabsInTop = appStyle === "minimal" && !mobile;
  const libraryTabs = isLibraryView(activeView) ? (
    <View {...ws("w-libtabs")} accessibilityRole="tablist" style={[styles.libraryTabs, mobile && styles.libraryTabsMobile]}>
      {libraryItems.map((item) => {
        const on = item.id === activeView;
        const Icon = item.icon;
        return (
          <Pressable
            key={item.id}
            accessibilityLabel={`${item.label}，${counts[item.id]} 条`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            aria-selected={on}
            {...fx({ hover: "tint", ws: on ? "c-filter on" : "c-filter" })}
            onPress={() => changeView(item.id)}
            style={({ pressed }) => [styles.libraryTab, on && { backgroundColor: alpha(item.accent, 0.13) }, pressed && styles.buttonPressed, webPointer]}
            testID={`library-tab-${item.id}`}
          >
            <Icon color={on ? item.accent : color.textMuted} size={15} strokeWidth={on ? 2.4 : 2} />
            <Text numberOfLines={1} style={[styles.libraryTabText, on && styles.libraryTabTextOn]}>{item.label}</Text>
            <Text {...ws("mono")} style={[styles.libraryTabCount, on && { color: item.accent }]}>{formatCompactNumber(counts[item.id])}</Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;

  return (
    <View {...fx({ motion: "fade" })} testID="content-workspace" style={[styles.root, mobile && styles.rootMobile]}>
      <View {...ws("w-stage")} style={[styles.stage, mobile && styles.stageMobile]}>
      {!mobile ? <SidebarToggle collapsed={compactSidebar} onPress={toggleSidebar} /> : null}
      {!mobile ? (
        <View {...ws("w-side g-ink")} testID="workspace-sidebar" style={[styles.sidebar, collapseWidth, compactSidebar && styles.sidebarCompact]}>
          <View {...SIDENAV} onLayout={measureSidebar} ref={sidebarBodyRef} style={[styles.sidebarBody, sidebarOverflow && sidebarScroll]}>
          <View accessibilityRole="tablist" onLayout={measureSidebar} style={styles.sidebarNav}>
            {Platform.OS === "web" && navTops[sideKey] !== undefined ? (
              <View {...ws("w-glider")} pointerEvents="none" style={[styles.navGlider, ease("top,background-color", 380), { top: navTops[sideKey]! + 14, backgroundColor: currentNav.accent }]} />
            ) : null}
            {sides.map((item) => (
              <React.Fragment key={item.id}>
                {SECTION_STARTS.has(item.id) ? <View {...ws("w-navsep")} style={styles.navSection} /> : null}
                <NavButton
                  compact={compactSidebar}
                  count={counts[item.id]}
                  item={item}
                  onLayoutTop={(y) => reportNavTop(item.id, y)}
                  onPress={() => changeView(item.id)}
                  selected={item.id === sideKey}
                />
              </React.Fragment>
            ))}
          </View>
          <BadgeShelf><PioneerBadge /></BadgeShelf>
          <ActiveDays compact={compactSidebar} days={model.activeDays} drawn={ringDrawn} viewRef={ringRef} year={model.year} />
          </View>
          <View style={styles.sidebarFooter}>
            {onOpenPreferences ? (
              <Pressable
                accessibilityLabel="打开设置"
                accessibilityRole="button"
                {...fx({ hover: "tint", ws: "w-nav w-replay w-prefs" })}
                onPress={() => onOpenPreferences()}
                style={({ pressed }) => [styles.navButton, pressed && styles.buttonPressed, webPointer]}
                testID="workspace-preferences"
              >
                <View style={styles.navIconWrap}><Settings color={color.textSecondary} size={20} strokeWidth={2} /></View>
                <View style={[styles.navMeta, collapseCopy, compactSidebar && styles.sidebarCopyHidden]}>
                  <Text numberOfLines={1} style={styles.navLabel}>设置</Text>
                </View>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel={replayLabel}
              accessibilityRole="button"
              {...fx({ hover: "tint", ws: "w-nav w-replay" })}
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
              {...fx({ hover: "raise", ws: "btn w-settings" })}
              accessibilityLabel="打开连接与采集设置"
              accessibilityRole="button"
              onPress={onOpenSettings}
              style={({ pressed }) => [styles.settingsButton, pressed && styles.buttonPressed, webPointer]}
            >
              <View style={styles.settingsIcon}><Plug color={color.textSecondary} size={19} strokeWidth={2} /></View>
              <Text numberOfLines={1} style={[styles.settingsButtonText, collapseCopy, compactSidebar && styles.sidebarCopyHidden]}>连接与采集</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={[styles.main, mobile && styles.mainMobile]}>
        <View {...ws("w-top")} testID="workspace-topbar" style={[styles.topbar, mobile && styles.topbarMobile]}>
          <View style={styles.topbarHeading}>
            {tabsInTop && libraryTabs ? libraryTabs : <>
            {/* 极简不要装饰性的英文眉题 */}
            {appStyle !== "minimal" ? <Text {...ws("stamp-sig")} style={styles.topbarEyebrow}>{reportView ? "LIVING REPORT" : archive ? "CONTENT ARCHIVE" : "CONTENT STREAMS"}</Text> : null}
            <View style={styles.topbarTitleRow}>
              <Text {...ws("w-title")} numberOfLines={1} style={[styles.topbarTitle, mobile && styles.topbarTitleMobile]}>{currentNav.label}</Text>
              {!toolView(activeView) ? <Text {...ws("w-count")} style={styles.topbarCount}>{shownCount.toLocaleString("zh-CN")}</Text> : null}
            </View>
            </>}
          </View>
          <View style={styles.topbarActions}>
            {mobile ? (
              <Pressable
                {...ws("w-mbtn")}
                accessibilityLabel={replayLabel}
                accessibilityRole="button"
                onPress={onReplayStory}
                style={({ pressed }) => [styles.toolbarButton, pressed && styles.buttonPressed, webPointer]}
              >
                <Sparkles color={color.accent} size={19} />
              </Pressable>
            ) : null}
            {!toolView(activeView) ? <Pressable
              accessibilityLabel={privacy ? "关闭隐私模式" : "开启隐私模式"}
              accessibilityRole="switch"
              accessibilityState={{ checked: privacy }}
              {...fx({ hover: "raise", ws: privacy ? "btn square on" : "btn square" })}
              onPress={onTogglePrivacy}
              style={({ pressed }) => [styles.toolbarButton, privacy && styles.toolbarButtonActive, pressed && styles.buttonPressed, webPointer]}
            >
              {privacy ? <EyeOff color={color.cyan} size={19} /> : <Eye color={color.textSecondary} size={19} />}
            </Pressable> : null}
            {!toolView(activeView) ? <Pressable
              accessibilityLabel="重新增量读取记录"
              accessibilityRole="button"
              disabled={busy}
              {...fx({ hover: "raise", ws: "btn square" })}
              onPress={onSync}
              style={({ pressed }) => [styles.toolbarButton, busy && styles.buttonDisabled, pressed && styles.buttonPressed, webPointer]}
            >
              {busy ? <ActivityIndicator color={color.cyan} size="small" /> : <RefreshCw color={color.textSecondary} size={19} />}
            </Pressable> : null}
            {mobile ? (
              <Pressable
                {...ws("w-mbtn")}
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

        {tabsInTop ? null : libraryTabs}

        {reportView && reportUpdateNotice ? (
          <Pressable
            accessibilityRole="button"
            {...fx({ motion: "rise", ws: "stamp-bar" })}
            accessibilityLabel="报告有更新，关闭提示"
            onPress={() => setReportUpdateNotice(false)}
            style={({ pressed }) => [styles.reportUpdateNotice, pressed && styles.buttonPressed, webPointer]}
          >
            <RefreshCw color={color.green} size={15} />
            <Text style={styles.reportUpdateNoticeText}>报告有更新 · 已保留当前阅读位置</Text>
          </Pressable>
        ) : null}

        {activeView === "feed" ? feed : activeView === "explore" ? explore : activeView === "creator" ? creator : activeView === "assistant" ? assistant : activeView === "chat" ? (
          <ChatWorkspace
            busy={chatBusy}
            connected={chatConnected}
            status={status}
            onToggleReception={onToggleChatReception ?? onOpenSettings}
            onCollectHistory={onCollectChatHistory}
            sendConnection={commentsConnection}
            videoRecords={records}
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
            : <ReportDashboard chatConversations={reportChats.chatConversations} chatMessages={reportChats.chatMessages} mobile={mobile} model={model} onOpenRecord={onOpenRecord} privacy={privacy} records={records} width={mainWidth} />
        ) : activeView === "highlights" ? (
          livingReport
            ? <LivingHighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={livingReport} />
            : report && isLivingReport(report)
              ? <LivingHighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={report} />
              : <HighlightsView mobile={mobile} onOpenRecord={onOpenRecord} privacy={privacy} report={report} />
        ) : (
          <RecordsGallery
            activeType={activeView === "live" || activeView === "feed_filtered" ? "watch_history" : activeView}
            compactHeader={appStyle === "minimal"}
            live={activeView === "live"}
            feedFiltered={activeView === "feed_filtered"}
            onOpenPreferences={onOpenPreferences}
            folders={activeView === "live" || activeView === "feed_filtered" || Platform.OS !== "web" ? null : folders.lists?.[activeView] ?? null}
            folderError={activeView === "feed_filtered" ? null : folders.error}
            onChangeFolders={activeView === "live" || activeView === "feed_filtered" ? undefined : (update) => folders.change(activeView, update)}
            onRetryFolders={folders.retry}
            label={currentNav.label}
            downloadStates={downloadStates}
            sendStates={sendStates}
            mobile={mobile}
            onDownloadRecord={onDownloadRecord}
            onSendToReelLab={onSendToReelLab}
            onBatchDownloadActiveChange={onBatchDownloadActiveChange}
            onLoadVideo={onLoadVideo}
            commentsConnection={commentsConnection}
            onOpenRecord={onOpenRecord}
            onOpenSettings={onOpenSettings}
            privacy={privacy}
            records={activeView === "live" ? watchedLives : activeView === "feed_filtered" ? feedVideos : activeView === "watch_history" ? watchedVideos : records[activeView]}
            incoming={activeView === "live" ? incomingLives : activeView === "feed_filtered" ? undefined : activeView === "watch_history" ? incomingVideos : liveRecords?.[activeView]}
            sourceLabel={sourceLabel}
            status={status}
            width={mainWidth}
          />
        )}
      </View>

      {Platform.OS === "web" && archive ? (
        <>
          <View {...ws("w-grain")} pointerEvents="none" style={styles.paperGrain}>
            <Image resizeMode="repeat" source={require("./assets/paper-grain.png")} style={styles.paperGrainImg} />
          </View>
          <View {...ws("w-tint")} pointerEvents="none" style={styles.paperTint} />
          {!mobile ? (
            <View {...ws("w-corners")} pointerEvents="none" style={styles.paperTint}>
              {[styles.cornerTL, styles.cornerTR, styles.cornerBL, styles.cornerBR].map((corner, index) => (
                <View key={index} style={[styles.corner, corner]} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {mobile ? (
        <View {...ws("w-bottom g-ink")} accessibilityRole="tablist" style={styles.bottomNav}>
          {Platform.OS === "web" ? (
            <View pointerEvents="none" style={[styles.bottomNavGlider, ease("left,background-color", 350), { left: `${(sides.findIndex((item) => item.id === sideKey) + 0.5) / sides.length * 100}%`, backgroundColor: currentNav.accent }]} />
          ) : null}
          {sides.map((item) => {
            const selected = item.id === sideKey;
            const Icon = item.icon;
            return (
              <Pressable
                key={item.id}
                accessibilityLabel={toolView(item.id) ? item.label : `${item.label}，${counts[item.id]} 条`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => changeView(item.id)}
                style={({ pressed }) => [styles.bottomNavItem, pressed && styles.buttonPressed, webPointer]}
              >
                <Icon color={selected ? item.accent : color.textMuted} size={20} strokeWidth={selected ? 2.5 : 2} />
                <Text style={[styles.bottomNavLabel, selected && { color: item.accent }]}>{item.label === "创作者中心" ? "创作者" : item.label}</Text>
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
    <View {...ws("w-days")} ref={viewRef} style={styles.activeDays}>
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
      {...ws("btn square w-toggle g-ink")}
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
  item: NavItem<SideKey>;
  onLayoutTop?: (y: number) => void;
  onPress: () => void;
  selected: boolean;
}) {
  const Icon = item.icon;
  return (
    <Pressable
      {...fx({ hover: "tint", ws: selected ? "w-nav on" : "w-nav" })}
      testID={`workspace-nav-${item.id}`}
      accessibilityLabel={toolView(item.id) ? item.label : `${item.label}，${count} 条`}
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
      <View {...ws("w-navicon")} style={[styles.navIconWrap, selected && { backgroundColor: alpha(item.accent, 0.13) }]}>
        <Icon color={selected ? item.accent : color.textMuted} size={20} strokeWidth={selected ? 2.5 : 2} />
      </View>
      <View style={[styles.navMeta, collapseCopy, compact && styles.sidebarCopyHidden]}>
        <Text {...ws("w-navlabel")} numberOfLines={1} style={[styles.navLabel, selected && styles.navLabelSelected]}>{item.label}</Text>
        {!toolView(item.id) ? <Text {...ws("mono w-navcount")} style={[styles.navCount, selected && { color: item.accent }]}>{formatCompactNumber(count)}</Text> : null}
      </View>
      {selected && Platform.OS !== "web" ? <View style={[styles.navIndicator, { backgroundColor: item.accent }]} /> : null}
    </Pressable>
  );
}

/**
 * 文件夹跟着采集器的当前账号走：改动先在界面上生效，再按先后顺序整份存回采集器。
 * 存不上就退回上一次存好的样子并说明，排在后面的改动也一起作废，免得界面上看着放好了、其实没存。
 */
// 内容库「推荐流挡掉的」：浏览器扩展送进采集器的命中视频，新的在前。开着这一栏时隔半分钟刷一次，
// 别的时候只在连上采集器时读一次（侧栏要显示条数）
function useFeedFilteredVideos(connection: ExploreConnection | null | undefined, active: boolean) {
  const [videos, setVideos] = useState<PersonalVideoRecord[]>([]);
  const baseUrl = connection?.baseUrl, token = connection?.token;
  useEffect(() => {
    if (!baseUrl || !token) { setVideos([]); return undefined; }
    let alive = true;
    const load = () => collectorFeedFilteredVideos(baseUrl, token).then((list) => { if (alive) setVideos(list.reverse()); }, () => undefined);
    void load();
    const timer = active ? setInterval(load, 30_000) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [active, baseUrl, token]);
  return videos;
}

const FEED_ACTION_LABEL: Record<NonNullable<PersonalVideoRecord["feedFilter"]>["action"], string> = {
  observed: "只记录", hidden: "已隐藏", disliked: "已反馈", dislike_failed: "反馈没成功",
};

function useRecordFolders(connection: ExploreConnection | null | undefined, accountId: string | undefined) {
  const owner = connection ? `${connection.baseUrl}|${accountId ?? ""}` : null;
  const [state, setState] = useState<{ owner: string; lists: RecordFolders } | null>(null);
  // 读不到和存不上分开记：重读失败不能把「刚才没存上」盖掉
  const [error, setError] = useState<{ kind: "read" | "save"; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lists = state && state.owner === owner ? state.lists : null;
  const latest = useRef({ connection, accountId, owner, lists });
  latest.current = { connection, accountId, owner, lists };
  // 采集器那边确认过的最后一份：读到的、存成功的
  const confirmed = useRef<{ owner: string; lists: RecordFolders } | null>(null);
  const saving = useRef(Promise.resolve());
  // 每改一次加一：排队的保存发现后面还有更新的就不发，整份文档里已经带着它了
  const sequence = useRef(0);
  // 存失败一次加一：失败之前排上的保存都作废
  const generation = useRef(0);
  useEffect(() => { setError(null); }, [owner]);
  useEffect(() => {
    const current = latest.current.connection;
    if (!owner || !current) return;
    let alive = true;
    readRecordFolders(current)
      .then((value) => {
        if (!alive) return;
        confirmed.current = value ? { owner, lists: value } : null;
        setState(confirmed.current);
        setError((shown) => (shown?.kind === "read" ? null : shown));
      })
      .catch((cause) => {
        if (alive) setError((shown) => (shown?.kind === "save" ? shown : { kind: "read", message: cause instanceof Error ? cause.message : "文件夹没读到，请稍后再试。" }));
      });
    return () => { alive = false; };
  }, [owner, attempt]);
  const change = useCallback((type: PersonalRecordType, update: (list: RecordFolderList) => RecordFolderList) => {
    const { connection: target, accountId: account, owner: who, lists: current } = latest.current;
    if (!target || !who || !current) return;
    const next = { ...current, [type]: update(current[type]) };
    // 连着点两下时第二下要在第一下的结果上改，不等重渲染
    latest.current.lists = next;
    setState({ owner: who, lists: next });
    setError(null);
    const seq = ++sequence.current;
    const gen = generation.current;
    saving.current = saving.current.then(async () => {
      if (gen !== generation.current || seq !== sequence.current) return;
      try {
        await saveRecordFolders(target, account, next);
        if (latest.current.owner === who) confirmed.current = { owner: who, lists: next };
      } catch (cause) {
        if (latest.current.owner !== who) return;
        generation.current += 1;
        const reason = cause instanceof Error ? cause.message : "文件夹没存上。";
        setError({ kind: "save", message: `${reason}刚才的改动已经撤回。` });
        const back = confirmed.current?.owner === who ? confirmed.current : null;
        latest.current.lists = back?.lists ?? null;
        setState(back);
        // ponytail: 撤回后马上再读一遍对齐采集器；失败后几毫秒内又改的那一下可能被这次重读盖掉，概率很小先不管
        setAttempt((value) => value + 1);
      }
    });
  }, []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { lists, error: error?.message ?? null, change, retry };
}

type FolderDialogState =
  | { mode: "create"; move?: PersonalVideoRecord[] }
  | { mode: "rename"; folder: RecordFolder }
  | { mode: "delete"; folder: RecordFolder; count: number };

type MenuPoint = { x: number; y: number };

// 按钮点开的菜单从按钮下沿长出来；拿不到按钮位置（键盘回车）就用鼠标位置
function pointBelow(event: unknown): MenuPoint {
  const target = (event as { currentTarget?: { getBoundingClientRect?: () => { left: number; bottom: number } } } | null)?.currentTarget;
  const rect = target?.getBoundingClientRect?.();
  if (rect) return { x: rect.left, y: rect.bottom + 6 };
  const native = (event as { nativeEvent?: { clientX?: number; clientY?: number } } | null)?.nativeEvent;
  return { x: native?.clientX ?? 0, y: native?.clientY ?? 0 };
}

// RN 的类型里没有右键；网页上 View/Pressable 会把 onContextMenu 原样交给 DOM
function contextMenuProps(open: ((at: MenuPoint) => void) | undefined): object {
  if (Platform.OS !== "web" || !open) return {};
  return { onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => { event.preventDefault(); open({ x: event.clientX, y: event.clientY }); } };
}

function FolderChip({ label, count, on, onPress, onMenu }: { label: string; count: number; on: boolean; onPress: () => void; onMenu?: (at: MenuPoint) => void }) {
  return (
    <Pressable
      accessibilityLabel={`${label}，${count} 条`}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      aria-selected={on}
      {...fx({ hover: "tint", ws: on ? "c-filter on" : "c-filter" })}
      {...contextMenuProps(onMenu)}
      onPress={onPress}
      style={({ pressed }) => [styles.folderChip, on && styles.folderChipOn, pressed && styles.buttonPressed, webPointer]}
    >
      <Text numberOfLines={1} style={[styles.folderChipText, on && styles.folderChipTextOn]}>{label}</Text>
      <Text {...ws("mono")} style={[styles.folderChipCount, on && styles.folderChipTextOn]}>{count.toLocaleString("zh-CN")}</Text>
    </Pressable>
  );
}

function FolderBar({
  list,
  counts,
  total,
  active,
  privacy,
  error,
  nameOf,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onChipMenu,
}: {
  list: RecordFolderList;
  counts: Map<string, number>;
  total: number;
  active: string;
  privacy: boolean;
  error: string | null | undefined;
  nameOf: (folder: RecordFolder) => string;
  onSelect: (filter: string) => void;
  onCreate: () => void;
  onRename: (folder: RecordFolder) => void;
  onDelete: (folder: RecordFolder) => void;
  onChipMenu: (folder: RecordFolder, at: MenuPoint) => void;
}) {
  const current = list.folders.find((folder) => folder.id === active) ?? null;
  return (
    <View style={styles.folderBar} testID="record-folders">
      <View {...ws("c-filters")} style={styles.folderRow}>
        {/* 只有芯片算页签，「新建」「重命名」「删除」是按钮，放在页签组外面 */}
        <View accessibilityRole="tablist" style={styles.folderTabs}>
          <FolderChip count={total} label="全部" on={active === ALL_FOLDERS} onPress={() => onSelect(ALL_FOLDERS)} />
          {list.folders.length ? <FolderChip count={counts.get(UNFILED) ?? 0} label="未分区" on={active === UNFILED} onPress={() => onSelect(UNFILED)} /> : null}
          {list.folders.map((folder) => (
            <FolderChip
              count={counts.get(folder.id) ?? 0}
              key={folder.id}
              label={nameOf(folder)}
              on={active === folder.id}
              onMenu={privacy ? undefined : (at) => onChipMenu(folder, at)}
              onPress={() => onSelect(folder.id)}
            />
          ))}
        </View>
        {!privacy ? (
          <Pressable
            {...ws("btn small")}
            accessibilityLabel="新建文件夹"
            accessibilityRole="button"
            disabled={list.folders.length >= FOLDERS_MAX}
            onPress={onCreate}
            style={({ pressed }) => [styles.folderAction, list.folders.length >= FOLDERS_MAX && styles.buttonDisabled, pressed && styles.buttonPressed, webPointer]}
          >
            <FolderPlus color={color.textSecondary} size={14} />
            <Text style={styles.folderActionText}>新建文件夹</Text>
          </Pressable>
        ) : null}
        {current && !privacy ? (
          <View style={styles.folderManage}>
            <Pressable {...ws("btn small")} accessibilityLabel={`重命名「${current.name}」`} accessibilityRole="button" onPress={() => onRename(current)}
              style={({ pressed }) => [styles.folderAction, pressed && styles.buttonPressed, webPointer]}>
              <Pencil color={color.textSecondary} size={13} />
              <Text style={styles.folderActionText}>重命名</Text>
            </Pressable>
            <Pressable {...ws("btn small")} accessibilityLabel={`删除「${current.name}」`} accessibilityRole="button" onPress={() => onDelete(current)}
              style={({ pressed }) => [styles.folderAction, pressed && styles.buttonPressed, webPointer]}>
              <Trash2 color={color.textSecondary} size={13} />
              <Text style={styles.folderActionText}>删除</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.folderError}>{error}</Text> : null}
    </View>
  );
}

function FolderDialog({
  state,
  list,
  onCancel,
  onCreate,
  onRename,
  onDelete,
}: {
  state: FolderDialogState;
  list: RecordFolderList;
  onCancel: () => void;
  onCreate: (name: string, move?: PersonalVideoRecord[]) => void;
  onRename: (folder: RecordFolder, name: string) => void;
  onDelete: (folder: RecordFolder) => void;
}) {
  const [name, setName] = useState(state.mode === "rename" ? state.folder.name : "");
  const [tried, setTried] = useState(false);
  const problem = state.mode === "delete" ? null : folderNameProblem(list, name, state.mode === "rename" ? state.folder.id : undefined);
  // 空着的时候先不催，点了「新建」或者打了字再说哪里不行
  const shownProblem = problem && (tried || name.trim()) ? problem : null;
  const submit = () => {
    if (state.mode === "delete") { onDelete(state.folder); return; }
    setTried(true);
    if (problem) return;
    if (state.mode === "rename") onRename(state.folder, name);
    else onCreate(name, state.move);
  };
  const title = state.mode === "delete"
    ? `删除「${state.folder.name}」`
    : state.mode === "rename"
      ? "重命名文件夹"
      : state.move?.length === 1 ? "新建文件夹，把这条放进去"
      : state.move ? `新建文件夹，放进选中的 ${state.move.length} 条` : "新建文件夹";
  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible>
      <View style={styles.dialogBackdrop}>
        <View {...ws("w-dialog")} accessibilityViewIsModal style={styles.dialog} testID="folder-dialog">
          <Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text>
          {state.mode === "delete" ? (
            <Text style={styles.dialogText}>{state.count ? `里面的 ${state.count} 条会回到未分区，视频记录本身不会删掉。` : "这个文件夹还是空的，删掉不影响任何记录。"}</Text>
          ) : (
            <TextInput
              {...ws("c-input")}
              accessibilityLabel="文件夹名字"
              autoFocus
              maxLength={40}
              onChangeText={setName}
              onSubmitEditing={submit}
              placeholder="比如：学做菜、健身、以后再看"
              placeholderTextColor={color.textMuted}
              style={styles.dialogInput}
              value={name}
            />
          )}
          {shownProblem ? <Text accessibilityRole="alert" style={styles.dialogError}>{shownProblem}</Text> : null}
          <View style={styles.dialogActions}>
            <Pressable {...ws("btn")} accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.batchButton, pressed && styles.buttonPressed, webPointer]}>
              <Text style={styles.batchButtonText}>取消</Text>
            </Pressable>
            <Pressable {...ws("btn-solid")} accessibilityRole="button" onPress={submit} style={({ pressed }) => [styles.batchButton, styles.batchPrimary, pressed && styles.buttonPressed, webPointer]}>
              <Text style={styles.batchPrimaryText}>{state.mode === "delete" ? "删除文件夹" : state.mode === "rename" ? "保存" : "新建"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function RecordsGallery({
  activeType,
  compactHeader = false,
  live = false,
  feedFiltered = false,
  onOpenPreferences,
  folders,
  folderError,
  onChangeFolders,
  onRetryFolders,
  label,
  downloadStates,
  sendStates,
  mobile,
  onDownloadRecord,
  onSendToReelLab,
  onBatchDownloadActiveChange,
  onLoadVideo,
  commentsConnection,
  onOpenRecord,
  onOpenSettings,
  privacy,
  records: savedRecords,
  incoming,
  sourceLabel,
  status,
  width,
}: {
  activeType: PersonalRecordType;
  /** 极简：文件夹芯片和搜索、整理、下载并成一行；来源这句状态不再单占一行，只在搜索 / 文件夹里有话可说时出现 */
  compactHeader?: boolean;
  /** 直播一栏：卡片进直播间，页头能粘贴直播间链接 */
  live?: boolean;
  /** 「推荐流挡掉的」一栏：记录来自浏览器扩展，没有文件夹，空的时候指去设置 →「推荐流」 */
  feedFiltered?: boolean;
  onOpenPreferences?: () => void;
  /** 这一栏的文件夹；没连采集器（或采集器太旧）时为 null，不显示文件夹 */
  folders?: RecordFolderList | null;
  folderError?: string | null;
  onChangeFolders?: (update: (list: RecordFolderList) => RecordFolderList) => void;
  onRetryFolders?: () => void;
  label: string;
  downloadStates: Record<string, RecordDownloadState>;
  sendStates: Record<string, RecordDownloadState>;
  mobile: boolean;
  /** keepExplore：从播放器里下载时别关探索会话，评论面板还在用 */
  onDownloadRecord?: (record: PersonalVideoRecord, keepExplore?: boolean) => Promise<void>;
  onSendToReelLab?: (record: PersonalVideoRecord) => void;
  onBatchDownloadActiveChange?: (active: boolean) => void;
  onLoadVideo?: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  onOpenRecord: (url: string) => Promise<void>;
  onOpenSettings: () => void;
  privacy: boolean;
  records: PersonalVideoRecord[];
  /** 读取中这一轮新读到的，按读到的顺序排在 records 前面 */
  incoming?: PersonalVideoRecord[];
  sourceLabel: string;
  status: CollectorStatus | null;
  width: number;
}) {
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const columns = mobile ? 2 : width < 760 ? 3 : width < 1120 ? 4 : 5;
  // 网格每行的 key 是这一行几条记录的 id 拼起来的：插进不满一行的新记录，下面每一行都要整个重挂、封面重新加载。
  // 新读到的凑满整行才放上去，零头等下一页，读完整份刷新时一起出来
  const step = layout === "grid" ? columns : 1;
  const ready = incoming ? incoming.length - incoming.length % step : 0;
  const records = useMemo(() => (ready ? [...incoming!.slice(0, ready), ...savedRecords] : savedRecords), [incoming, ready, savedRecords]);
  // 刚放上来的那一批按读到的顺序错开升起；换栏目、换网格列表时已经在的不重放
  const batch = useRef({ activeType, step, from: 0, ready: 0 });
  if (batch.current.ready !== ready || batch.current.activeType !== activeType || batch.current.step !== step) {
    const grew = batch.current.activeType === activeType && batch.current.step === step && batch.current.ready < ready;
    batch.current = { activeType, step, from: grew ? batch.current.ready : ready, ready };
  }
  const enterFrom = batch.current.from;
  const enterOrder = useMemo(() => new Map((incoming ?? NO_RECORDS).slice(enterFrom, ready).map((record, index) => [record.id, index + 1])), [incoming, enterFrom, ready]);
  const [playingRecord, setPlayingRecord] = useState<PersonalVideoRecord | null>(null);
  const [liveTarget, setLiveTarget] = useState<LiveTarget | null>(null);
  const openLive = Platform.OS === "web" && !privacy
    ? (record: PersonalVideoRecord) => record.url && setLiveTarget({ room: record.url, title: record.title, anchor: record.author, cover: record.coverUrl })
    : undefined;
  // 多选有两种：批量下载（按作品去重、每批 50 个）和整理进文件夹（按记录选、不限条数）
  const [selectMode, setSelectMode] = useState<"download" | "folder" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRecords, setBatchRecords] = useState<PersonalVideoRecord[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeFolder, setActiveFolder] = useState(ALL_FOLDERS);
  // 在文件夹（或未分区）里移走的视频，换筛选之前先留在原处
  const [keptKeys, setKeptKeys] = useState<ReadonlySet<string>>(new Set());
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const menu = useContextMenu();
  useEffect(() => {
    onBatchDownloadActiveChange?.(batchRecords !== null);
    return () => onBatchDownloadActiveChange?.(false);
  }, [batchRecords, onBatchDownloadActiveChange]);
  useEffect(() => { setSelectMode(null); setSelected(new Set()); setFolderDialog(null); }, [label, privacy]);
  useEffect(() => { setActiveFolder(ALL_FOLDERS); }, [label]);
  // 换了搜索词、换了文件夹就重新选，免得之前选的、现在看不见的那些悄悄留在下载列表里
  useEffect(() => { setSelected(new Set()); }, [query, activeFolder]);
  useEffect(() => { setKeptKeys(new Set()); }, [label, activeFolder]);
  useEffect(() => { setPlayingRecord(null); setLiveTarget(null); setQuery(""); }, [label, privacy]);
  const list = Platform.OS === "web" && folders && onChangeFolders ? folders : null;
  // 文件夹读不到了（换账号、采集器出错），整理模式就没法用了，退出来，免得剩个没有出口的工具条
  useEffect(() => { if (!list && selectMode === "folder") setSelectMode(null); }, [list, selectMode]);
  const folderById = useMemo(() => new Map((list?.folders ?? []).map((folder) => [folder.id, folder])), [list]);
  // 当前文件夹删掉了、换账号读到的是另一份，就回到「全部」
  const folderFilter = !list
    ? ALL_FOLDERS
    : activeFolder === UNFILED ? (list.folders.length ? UNFILED : ALL_FOLDERS)
      : folderById.has(activeFolder) ? activeFolder : ALL_FOLDERS;
  // 回到「全部」要记下来，不然之后再建文件夹，视图会自己跳回原来那个筛选；文件夹还没读到时不动
  useEffect(() => { if (list && folderFilter !== activeFolder) setActiveFolder(folderFilter); }, [list, folderFilter, activeFolder]);
  const currentFolder = folderById.get(folderFilter) ?? null;
  // 隐私模式下文件夹名也是内容，按顺序叫「文件夹 1、2…」
  const nameOf = (folder: RecordFolder) => privacy ? `文件夹 ${list!.folders.indexOf(folder) + 1}` : folder.name;
  const folderRecords = useMemo(() => (list ? filterByFolder(records, list, folderFilter, keptKeys) : records), [records, list, folderFilter, keptKeys]);
  const folderCounts = useMemo(() => (list ? countByFolder(records, list) : null), [records, list]);
  const changeFolders = (update: (current: RecordFolderList) => RecordFolderList) => onChangeFolders?.(update);
  const keepInView = (targets: PersonalVideoRecord[]) => {
    if (folderFilter !== ALL_FOLDERS) setKeptKeys((current) => new Set([...current, ...targets.map(folderKey)]));
  };
  const moveRecords = (targets: PersonalVideoRecord[], folderId: string | null) => {
    keepInView(targets);
    changeFolders((current) => moveToFolder(current, targets, folderId));
  };
  const openFolderMenu = (targets: PersonalVideoRecord[], at: MenuPoint, done?: () => void) => {
    if (!list || targets.length === 0) return;
    const filedIn = (record: PersonalVideoRecord) => {
      const id = list.items[folderKey(record)];
      return id && folderById.has(id) ? id : null;
    };
    const allIn = (id: string | null) => targets.every((record) => filedIn(record) === id);
    const entries: MenuEntry[] = list.folders.map((folder) => ({
      id: folder.id,
      label: folder.name,
      icon: <Folder color={color.textSecondary} size={14} />,
      disabled: allIn(folder.id) ? "已经在这个文件夹里" : null,
      onSelect: () => { moveRecords(targets, folder.id); done?.(); },
    }));
    if (list.folders.length) {
      entries.push(
        { id: "remove", label: "移出文件夹", icon: <FolderMinus color={color.textSecondary} size={14} />, disabled: allIn(null) ? "还没放进文件夹" : null, onSelect: () => { moveRecords(targets, null); done?.(); } },
        { id: "separator", separator: true },
      );
    }
    entries.push({
      id: "create",
      label: "新建文件夹并放进去…",
      icon: <FolderPlus color={color.textSecondary} size={14} />,
      disabled: list.folders.length >= FOLDERS_MAX ? `最多建 ${FOLDERS_MAX} 个文件夹` : null,
      onSelect: () => setFolderDialog({ mode: "create", move: targets }),
    });
    menu.open(at, entries);
  };
  const openChipMenu = (folder: RecordFolder, at: MenuPoint) => menu.open(at, [
    { id: "rename", label: "重命名", icon: <Pencil color={color.textSecondary} size={14} />, onSelect: () => setFolderDialog({ mode: "rename", folder }) },
    { id: "delete", label: "删除文件夹", danger: true, icon: <Trash2 color={color.danger} size={14} />, onSelect: () => setFolderDialog({ mode: "delete", folder, count: folderCounts?.get(folder.id) ?? 0 }) },
  ]);
  const createFolder = (name: string, move?: PersonalVideoRecord[]) => {
    const id = newFolderId();
    if (move) keepInView(move);
    changeFolders((current) => {
      const added = addFolder(current, name, id);
      return move ? moveToFolder(added, move, id) : added;
    });
    if (move && selectMode === "folder") setSelected(new Set());
    setFolderDialog(null);
  };
  // 最后一行不满时 flex:1 会把卡片拉宽，限成一列宽（12 是 gridRow 的 gap）
  const cellStyle = useMemo(() => Platform.OS === "web" ? ({ maxWidth: `calc((100% - ${(columns - 1) * 12}px) / ${columns})` } as object) : null, [columns]);
  // 滚动条要按全部记录的总高度算才拖得动：没有 getItemLayout 时列表只把量过的行算进滚动范围，拖到底会一截截往外长。
  // 每行差不多一样高（封面宽高比固定、标题限两行），量第一行就能推出所有行的位置。只认第一行：海报、内容年志的列表行
  // 会差一两像素，谁挂上来都改一次的话，行高在几个值之间来回翻，滚动时渲染窗口算偏、整屏空白
  const [rowFrame, setRowFrame] = useState<{ start: number; length: number } | null>(null);
  // 列表在视口上下各渲染十屏，四五千个节点；一张封面加载完、一行新挂上，浏览器就要把这些行全部重排一遍，滚动掉到三十帧。
  // 量到行高以后挂上的行交给 content-visibility：不在屏幕附近就跳过排版和绘制，占位高度就是量到的行高，滚到时不会跳。
  // 它自带绘制隔离，悬停上浮的卡片和阴影会被行边裁掉，overflowClipMargin 留出余量
  const rowFrameRef = useRef(rowFrame);
  rowFrameRef.current = rowFrame;
  const RowCell = useMemo(() => function RowCell({ index, onLayout, children, style }: CellRendererProps<PersonalVideoRecord>) {
    const frame = rowFrameRef.current;
    const skip = Platform.OS === "web" && frame ? { contentVisibility: "auto", containIntrinsicSize: `auto ${frame.length}px`, overflowClipMargin: 24 } as object : null;
    return <View style={[style, skip]} onLayout={(event) => {
      onLayout?.(event);
      const { y, height } = event.nativeEvent.layout;
      const start = y - index * height;
      // 换风格后行高跟着变，这次重渲染整页卡片；放进 transition 分片做，不卡住正在播的转场动画
      if (index === 0 && height > 0) startTransition(() => setRowFrame((current) => current && Math.abs(current.start - start) < 1 && Math.abs(current.length - height) < 0.5 ? current : { start, length: height }));
    }}>{children}</View>;
  }, []);
  const getItemLayout = useMemo(() => rowFrame
    ? (_: unknown, index: number) => ({ index, length: rowFrame.length, offset: rowFrame.start + rowFrame.length * index })
    : undefined, [rowFrame]);
  // 卡片是 memo 的：读取、接收聊天时状态每变一次整页都要重渲染，几百张卡片跟着重画一遍要一两百毫秒。
  // 外面传进来的回调每次都是新函数，这里换成引用不变、调用时取最新那份的版本
  const latest = useRef({ onDownloadRecord, onSendToReelLab, onOpenRecord, openLive, openFolderMenu });
  latest.current = { onDownloadRecord, onSendToReelLab, onOpenRecord, openLive, openFolderMenu };
  const handlers = useMemo(() => ({
    download: (record: PersonalVideoRecord) => latest.current.onDownloadRecord!(record),
    send: (record: PersonalVideoRecord) => latest.current.onSendToReelLab!(record),
    open: (url: string) => latest.current.onOpenRecord(url),
    live: (record: PersonalVideoRecord) => { latest.current.openLive?.(record); },
    folder: (record: PersonalVideoRecord, at: MenuPoint) => latest.current.openFolderMenu([record], at),
  }), []);
  // 播放器的上一条/下一条和批量下载都跟着当前文件夹和搜索结果走
  const shownRecords = useMemo(() => searchRecords(folderRecords, query), [folderRecords, query]);
  const searching = query.trim().length > 0;
  // 喜欢和收藏的时间是上次播放的时间，不是点赞收藏的时间，拿来说「最早一条」会误导
  const earliest = useMemo(() => activeType === "watch_history" ? earliestRecordDate(records) : null, [activeType, records]);
  const candidates = useMemo(() => uniqueDownloadVideos(shownRecords), [shownRecords]);
  // 按钮按全部记录决定显不显示：跟着搜索结果来回出现会让搜索框左右跳，多选时还会找不到「退出多选」
  const hasDownloadable = useMemo(() => uniqueDownloadVideos(records).length > 0, [records]);
  // 一万多条逐条解析网址要好几毫秒，没勾的时候（绝大多数时候）别算；换风格、收消息时这页会整页重渲染
  const chosen = useMemo(() => selected.size ? candidates.filter((record) => selected.has(videoDownloadKey(record)!)) : [], [candidates, selected]);
  const chosenRecords = selectMode === "folder" ? shownRecords.filter((record) => selected.has(record.id)) : [];
  // 整理不限条数，常开着连勾几十条：同一条、勾选状态没变就给同一个对象，卡片的 memo 才拦得住，勾一下只重画那一张
  const folderSelections = useRef(new Map<string, RecordSelection>());
  useEffect(() => { folderSelections.current.clear(); }, [selectMode]);
  const selectionFor = (record: PersonalVideoRecord): RecordSelection | undefined => {
    if (!selectMode) return undefined;
    if (selectMode === "folder") {
      const checked = selected.has(record.id);
      const cacheKey = `${checked ? "1" : "0"}${record.id}`;
      let selection = folderSelections.current.get(cacheKey);
      if (!selection) {
        selection = {
          checked,
          disabled: false,
          toggle: () => setSelected((current) => {
            const next = new Set(current);
            if (!next.delete(record.id)) next.add(record.id);
            return next;
          }),
        };
        folderSelections.current.set(cacheKey, selection);
      }
      return selection;
    }
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

  const galleryMeta = searching
    ? `在 ${folderRecords.length} 条记录里找到 ${shownRecords.length} 条${earliest ? `，本机最早一条是 ${formatLongDate(earliest)}` : ""}`
    : currentFolder ? `「${nameOf(currentFolder)}」里放了 ${folderCounts?.get(currentFolder.id) ?? 0} 条，全部一共 ${records.length} 条`
    : folderFilter === UNFILED ? `还有 ${folderCounts?.get(UNFILED) ?? 0} 条没放进文件夹`
    : feedFiltered ? `浏览器扩展在抖音网页里碰到的 ${records.length} 条，新的在前`
    : `${sourceLabel} · ${status?.message ?? `${records.length} 条本地记录`}`;
  const folderBar = list && folderCounts && records.length > 0 ? (
    <FolderBar
      active={folderFilter}
      counts={folderCounts}
      error={folderError}
      list={list}
      nameOf={nameOf}
      onChipMenu={openChipMenu}
      onCreate={() => setFolderDialog({ mode: "create" })}
      onDelete={(folder) => setFolderDialog({ mode: "delete", folder, count: folderCounts.get(folder.id) ?? 0 })}
      onRename={(folder) => setFolderDialog({ mode: "rename", folder })}
      onSelect={setActiveFolder}
      privacy={privacy}
      total={records.length}
    />
  ) : null;
  const inlineFolders = compactHeader && folderBar !== null;

  return (
    <>
    {selectMode === "folder" ? <View {...ws("w-batch")} style={styles.batchToolbar}>
      <Text style={styles.batchMeta}>已选 {chosenRecords.length} 条</Text>
      <View style={styles.batchActions}>
        <Pressable {...ws("btn")} accessibilityRole="button" onPress={() => setSelected(new Set(shownRecords.map((record) => record.id)))} style={styles.batchButton}>
          <Text style={styles.batchButtonText}>全选这 {shownRecords.length} 条</Text>
        </Pressable>
        <Pressable {...ws("btn")} accessibilityRole="button" onPress={() => setSelected(new Set())} style={styles.batchButton}><Text style={styles.batchButtonText}>清空选择</Text></Pressable>
        <Pressable {...ws("btn-solid")} accessibilityRole="button" accessibilityState={{ disabled: chosenRecords.length === 0 }} disabled={chosenRecords.length === 0}
          onPress={(event) => openFolderMenu(chosenRecords, pointBelow(event), () => setSelected(new Set()))}
          style={[styles.batchButton, styles.batchPrimary, chosenRecords.length === 0 && styles.buttonDisabled]}>
          <FolderInput size={14} color={color.buttonText} /><Text style={styles.batchPrimaryText}>移到文件夹（{chosenRecords.length}）</Text>
        </Pressable>
      </View>
      <Text style={styles.batchHint}>勾选要整理的视频，再点「移到文件夹」{activeType === "watch_history" ? "；同一个视频看过几次，会一起移过去" : ""}。</Text>
    </View> : null}
    {selectMode === "download" ? <View {...ws("w-batch")} style={styles.batchToolbar}>
      <Text style={styles.batchMeta}>已选 {chosen.length} / {candidates.length} 个可下载视频</Text>
      <View style={styles.batchActions}>
        <Pressable {...ws("btn")} accessibilityRole="button" onPress={() => setSelected(new Set(candidates.slice(0, MAX_BATCH_VIDEOS).map((record) => videoDownloadKey(record)!)))} style={styles.batchButton}>
          <Text style={styles.batchButtonText}>{candidates.length > MAX_BATCH_VIDEOS ? "选择前 50 个" : "全选"}</Text>
        </Pressable>
        <Pressable {...ws("btn")} accessibilityRole="button" onPress={() => setSelected(new Set())} style={styles.batchButton}><Text style={styles.batchButtonText}>清空选择</Text></Pressable>
        <Pressable {...ws("btn-solid")} accessibilityRole="button" accessibilityState={{ disabled: chosen.length === 0 }} disabled={chosen.length === 0}
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
      contentContainerStyle={[styles.galleryContent, mobile && styles.galleryContentMobile, shownRecords.length === 0 && styles.galleryContentEmpty]}
      data={shownRecords}
      CellRendererComponent={RowCell}
      getItemLayout={getItemLayout}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={(
        <>
        <View {...fx({ motion: "rise", ws: "w-ghead" })} style={styles.galleryHeader}>
          {inlineFolders ? <View style={styles.galleryHeaderCopy}>{folderBar}</View> : (
            <View style={styles.galleryHeaderCopy}>
              <Text {...ws("w-gtitle")} style={styles.galleryTitle}>{label}</Text>
              <Text {...ws("mono")} style={styles.galleryMeta}>{galleryMeta}</Text>
            </View>
          )}
          {records.length > 0 && !privacy ? (
            <View {...ws("c-search")} style={styles.searchBox}>
              <Search size={14} color={color.textMuted} />
              <TextInput accessibilityLabel="搜索记录" onChangeText={setQuery} placeholder="搜标题、作者、话题或音乐"
                placeholderTextColor={color.textMuted} style={styles.searchInput} value={query} />
            </View>
          ) : null}
          {live && Platform.OS === "web" && !privacy ? <LiveRoomEntry onEnter={setLiveTarget} /> : null}
          {selectMode === "folder" || (list && !privacy && records.length > 0) ? <Pressable {...ws("btn")} accessibilityRole="button"
            onPress={() => { setSelectMode(selectMode === "folder" ? null : "folder"); setSelected(new Set()); }} style={styles.batchButton}>
            <FolderInput size={15} color={color.textSecondary} /><Text style={styles.batchButtonText}>{selectMode === "folder" ? "退出整理" : "整理"}</Text>
          </Pressable> : null}
          {Platform.OS === "web" && !privacy && (selectMode === "download" || hasDownloadable) ? <Pressable {...ws("btn")} accessibilityRole="button"
            onPress={() => { setSelectMode(selectMode === "download" ? null : "download"); setSelected(new Set()); }} style={styles.batchButton}>
            <Download size={15} color={color.textSecondary} /><Text style={styles.batchButtonText}>{selectMode === "download" ? "退出多选" : "批量下载"}</Text>
          </Pressable> : null}
          <View {...ws("w-switch")} accessibilityRole="tablist" style={styles.layoutSwitch}>
            <Pressable
              {...ws("w-lay", layout === "grid" && "on")}
              accessibilityLabel="网格视图"
              accessibilityRole="tab"
              accessibilityState={{ selected: layout === "grid" }}
              onPress={() => setLayout("grid")}
              style={({ pressed }) => [styles.layoutButton, layout === "grid" && styles.layoutButtonSelected, pressed && styles.buttonPressed, webPointer]}
            >
              <LayoutGrid color={layout === "grid" ? color.text : color.textMuted} size={18} />
            </Pressable>
            <Pressable
              {...ws("w-lay", layout === "list" && "on")}
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
        {inlineFolders && (searching || currentFolder || folderFilter === UNFILED) ? <Text {...ws("mono w-gmeta")} style={[styles.galleryMeta, styles.galleryMetaBelow]}>{galleryMeta}</Text> : null}
        {live && Platform.OS === "web" && !privacy && commentsConnection ? <FollowingLiveRow connection={commentsConnection} onEnter={setLiveTarget} /> : null}
        {folderBar ? (inlineFolders ? null : folderBar) : !list && folderError && onChangeFolders && Platform.OS === "web" && records.length > 0 ? (
          // 文件夹第一次就没读到：说一声，给个重读，不然文件夹整个不见了也不知道为什么
          <View style={[styles.folderBar, styles.folderRetry]}>
            <Text accessibilityRole="alert" style={styles.folderRetryText}>{folderError}</Text>
            {onRetryFolders ? (
              <Pressable {...ws("btn small")} accessibilityRole="button" onPress={onRetryFolders} style={({ pressed }) => [styles.folderAction, pressed && styles.buttonPressed, webPointer]}>
                <RefreshCw color={color.textSecondary} size={13} />
                <Text style={styles.folderActionText}>重新读取文件夹</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        </>
      )}
      ListEmptyComponent={searching ? (
        <View {...fx({ motion: "rise" })} style={styles.emptyState}>
          <View {...ws("w-emptyicon")} style={styles.emptyIcon}><Search color={color.cyan} size={24} /></View>
          <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>没找到「{query.trim()}」</Text>
          <Text style={styles.emptyDetail}>
            {currentFolder ? `现在只在「${nameOf(currentFolder)}」里找。` : folderFilter === UNFILED ? "现在只在没放进文件夹的记录里找。" : ""}
            换个词或少输几个词试试。只能搜到读进本机的记录{earliest ? `，最早一条是 ${formatLongDate(earliest)}` : ""}。
          </Text>
          <Pressable
            {...ws("btn-solid")}
            accessibilityRole="button"
            onPress={() => setQuery("")}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed, webPointer]}
          >
            <Text style={styles.emptyButtonText}>清空搜索</Text>
          </Pressable>
        </View>
      ) : folderFilter !== ALL_FOLDERS && records.length > 0 ? (
        <View {...fx({ motion: "rise" })} style={styles.emptyState} testID="record-folder-empty">
          <View {...ws("w-emptyicon")} style={styles.emptyIcon}><Folder color={color.cyan} size={24} /></View>
          <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>{currentFolder ? `「${nameOf(currentFolder)}」还是空的` : "都放进文件夹了"}</Text>
          <Text style={styles.emptyDetail}>
            {!currentFolder
              ? "每条记录都有自己的文件夹了。"
              : privacy ? "关掉隐私模式以后，才能往文件夹里放视频。"
              : layout === "grid" ? "回到「全部」，把鼠标移到视频上点右上角的文件夹按钮，或者右键视频，就能放进来；点「整理」可以一次勾好几条。"
              : "回到「全部」，右键视频就能放进来；点「整理」可以一次勾好几条。"}
          </Text>
          <Pressable
            {...ws("btn-solid")}
            accessibilityRole="button"
            onPress={() => setActiveFolder(ALL_FOLDERS)}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed, webPointer]}
          >
            <Text style={styles.emptyButtonText}>看全部</Text>
          </Pressable>
        </View>
      ) : feedFiltered ? (
        <View {...fx({ motion: "rise" })} style={styles.emptyState} testID="feed-filtered-empty">
          <View {...ws("w-emptyicon")} style={styles.emptyIcon}><Funnel color={color.cyan} size={24} /></View>
          <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>还没有挡掉的视频</Text>
          <Text style={styles.emptyDetail}>到设置里的「推荐流」装好浏览器扩展、写好词条，以后在抖音网页里命中的视频会出现在这里，和观看记录一样能播放、能下载。</Text>
          {onOpenPreferences ? (
            <Pressable
              {...ws("btn-solid")}
              accessibilityRole="button"
              onPress={onOpenPreferences}
              style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed, webPointer]}
            >
              <Settings color={color.black} size={18} />
              <Text style={styles.emptyButtonText}>打开设置</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View {...fx({ motion: "rise" })} style={styles.emptyState}>
          <View {...ws("w-emptyicon")} style={styles.emptyIcon}><Play color={color.cyan} fill={color.cyan} size={24} /></View>
          <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>{label}还没有内容</Text>
          <Text style={styles.emptyDetail}>返回连接与采集页面读取本地记录。</Text>
          <Pressable
            {...ws("btn-solid")}
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed, webPointer]}
          >
            <Plug color={color.black} size={18} />
            <Text style={styles.emptyButtonText}>连接与采集</Text>
          </Pressable>
        </View>
      )}
      numColumns={layout === "grid" ? columns : 1}
      renderItem={({ item }) => {
        const filedIn = list && !privacy ? folderById.get(list.items[folderKey(item)] ?? "")?.name : undefined;
        // 「全部」里标出放在哪个文件夹；文件夹（或未分区）里只给刚移走、还留在原处的那几条标出新去处
        const folderName = folderFilter === ALL_FOLDERS || !list || privacy ? filedIn
          : keptKeys.has(folderKey(item)) && (list.items[folderKey(item)] ?? UNFILED) !== folderFilter ? filedIn ?? "未分区"
          : undefined;
        const onFolderMenu = list && !privacy ? handlers.folder : undefined;
        return layout === "grid"
          ? <RecordTile
              cellStyle={cellStyle}
              selection={selectionFor(item)}
              downloadState={downloadStates[item.id] ?? "idle"}
              sendState={sendStates[item.id] ?? "idle"}
              filedIn={filedIn}
              folderName={folderName}
              onDownloadRecord={item.mediaType === "live" || !onDownloadRecord ? undefined : handlers.download}
              onSendToReelLab={item.mediaType === "live" || !onSendToReelLab ? undefined : handlers.send}
              onFolderMenu={onFolderMenu}
              onPlayRecord={item.mediaType === "live" ? openLive && handlers.live : onLoadVideo ? setPlayingRecord : undefined}
              onOpenRecord={handlers.open}
              privacy={privacy}
              record={item}
              type={activeType}
              enter={enterOrder.get(item.id)}
            />
          : <RecordRow enter={enterOrder.get(item.id)} folderName={folderName} onFolderMenu={onFolderMenu} selection={selectionFor(item)} onOpenRecord={handlers.open} privacy={privacy} record={item} type={activeType} />;
      }}
      // 上万条记录靠滚轮翻太慢，留一条常驻、能拖的滚动条（样式见 motionCss 的 data-scrollbar）
      {...{ dataSet: { scrollbar: "" } }}
    />
    {Platform.OS === "web" && playingRecord && !privacy && onLoadVideo ? (
      <RecordVideoPlayer record={playingRecord} records={shownRecords} onLoadVideo={onLoadVideo} commentsConnection={commentsConnection} onOpenRecord={onOpenRecord} onClose={() => setPlayingRecord(null)}
        onDownload={onDownloadRecord ? (record) => void onDownloadRecord(record, true) : undefined} downloadStates={downloadStates} />
    ) : null}
    {liveTarget && Platform.OS === "web" && !privacy ? (
      <LiveRoomPlayer target={liveTarget} connection={commentsConnection ?? null} onClose={() => setLiveTarget(null)} onOpenRecord={onOpenRecord} onOpenSettings={onOpenSettings} />
    ) : null}
    {batchRecords && commentsConnection ? <BatchVideoDownloadDialog records={batchRecords} connection={commentsConnection} privacy={privacy} onClose={() => setBatchRecords(null)} /> : null}
    {folderDialog && list ? (
      <FolderDialog
        list={list}
        onCancel={() => setFolderDialog(null)}
        onCreate={createFolder}
        onDelete={(folder) => { changeFolders((current) => removeFolder(current, folder.id)); setFolderDialog(null); }}
        onRename={(folder, name) => { changeFolders((current) => renameFolder(current, folder.id, name)); setFolderDialog(null); }}
        state={folderDialog}
      />
    ) : null}
    {menu.element}
    </>
  );
}

type RecordSelection = { checked: boolean; disabled: boolean; toggle: () => void };

function LiveRoomEntry({ onEnter }: { onEnter: (target: LiveTarget) => void }) {
  const [text, setText] = useState("");
  const room = liveRoomIdFrom(text);
  const enter = () => {
    if (!room) return;
    onEnter({ room });
    setText("");
  };
  return (
    <View style={styles.liveEntry}>
      <TextInput accessibilityLabel="直播间链接或房间号" onChangeText={setText} onSubmitEditing={enter} placeholder="粘贴直播间链接或房间号"
        placeholderTextColor={color.textMuted} {...ws("c-input")} style={styles.liveEntryInput} value={text} />
      <Pressable {...ws("btn")} accessibilityLabel="进入直播间" accessibilityRole="button" accessibilityState={{ disabled: !room }} disabled={!room} onPress={enter}
        style={({ pressed }) => [styles.batchButton, !room && styles.buttonDisabled, pressed && styles.buttonPressed, webPointer]}>
        <Radio size={15} color={color.textSecondary} /><Text style={styles.batchButtonText}>进入直播间</Text>
      </Pressable>
    </View>
  );
}

/** 关注的人谁在播：进直播页读一次（采集器缓存 30 秒），右边按钮强制刷新。 */
function FollowingLiveRow({ connection, onEnter }: { connection: ExploreConnection; onEnter: (target: LiveTarget) => void }) {
  const [rooms, setRooms] = useState<LiveFollowing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void waitForCollector(() => readFollowingLive(connection, attempt > 0, controller.signal), controller.signal)
      .then(setRooms)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "没读到关注的人的直播。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection.baseUrl, connection.token, attempt]);
  return (
    <View style={styles.followLive}>
      <View style={styles.followLiveHead}>
        <Text style={styles.followLiveTitle}>关注的人正在直播</Text>
        {rooms?.length ? <Text {...ws("mono")} style={styles.followLiveCount}>{rooms.length}</Text> : null}
        <Pressable accessibilityLabel="刷新关注的人的直播" accessibilityRole="button" disabled={loading} onPress={() => setAttempt((value) => value + 1)}
          style={({ pressed }) => [styles.followLiveRefresh, pressed && styles.buttonPressed, webPointer]}>
          {loading ? <ActivityIndicator color={color.cyan} size="small" /> : <RefreshCw color={color.textSecondary} size={14} />}
        </Pressable>
      </View>
      {error ? <Text style={styles.followLiveNote}>{error}</Text>
        : rooms === null ? <Text style={styles.followLiveNote}>正在看你关注的人谁在播…</Text>
        : rooms.length === 0 ? <Text style={styles.followLiveNote}>你关注的人现在都没在播。</Text>
        : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.followLiveList}>
            {rooms.map((room) => (
              <Pressable key={room.webRid} accessibilityLabel={`进入${room.anchor.name || "主播"}的直播间`} accessibilityRole="button"
                onPress={() => onEnter({ room: room.webRid, title: room.title, anchor: room.anchor.name, cover: room.cover })}
                {...fx({ hover: "card" })} style={({ pressed }) => [styles.followLiveCard, pressed && styles.buttonPressed, webPointer]}>
                <View style={styles.followLiveAvatar}>
                  {room.anchor.avatar ? <Image source={{ uri: room.anchor.avatar }} style={styles.followLiveAvatarImage} /> : <Radio color={color.accent} size={18} />}
                </View>
                <View style={styles.followLiveCopy}>
                  <Text numberOfLines={1} style={styles.followLiveName}>{room.anchor.name || "主播"}</Text>
                  <Text numberOfLines={1} style={styles.followLiveRoomTitle}>{room.title || "直播中"}</Text>
                  {room.online || room.tag ? <Text numberOfLines={1} style={styles.followLiveMeta}>{[room.online && `${room.online} 人在看`, room.tag].filter(Boolean).join(" · ")}</Text> : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
    </View>
  );
}

function SelectionMark({ selection }: { selection: RecordSelection }) {
  return <View {...ws("w-check", selection.checked && "on")} pointerEvents="none" style={[styles.selectionMark, selection.checked && styles.selectionChecked, selection.disabled && styles.buttonDisabled]}>
    {selection.checked ? <Check size={16} color={color.buttonText} /> : null}
  </View>;
}

const RecordTile = memo(function RecordTile({
  cellStyle,
  selection,
  downloadState,
  sendState,
  filedIn,
  folderName,
  onDownloadRecord,
  onSendToReelLab,
  onFolderMenu,
  onPlayRecord,
  record,
  type,
  privacy,
  onOpenRecord,
  enter,
}: {
  cellStyle?: object | null;
  selection?: RecordSelection;
  downloadState: RecordDownloadState;
  sendState: RecordDownloadState;
  /** 实际放在哪个文件夹，给文件夹按钮的读屏说明用 */
  filedIn?: string;
  /** 封面左上角标出的文件夹名 */
  folderName?: string;
  onDownloadRecord?: (record: PersonalVideoRecord) => Promise<void>;
  onSendToReelLab?: (record: PersonalVideoRecord) => void;
  /** 打开「放进文件夹」菜单：悬停时右上角的按钮、右键都走这里 */
  onFolderMenu?: (record: PersonalVideoRecord, at: MenuPoint) => void;
  onPlayRecord?: (record: PersonalVideoRecord) => void;
  record: PersonalVideoRecord;
  type: PersonalRecordType;
  privacy: boolean;
  onOpenRecord: (url: string) => Promise<void>;
  /** 读取中刚放上来的第几条，进场按它错开 */
  enter?: number;
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
  const sending = sendState === "queued" || sendState === "running";
  // 卡片上三颗按钮挤一行，字写短（和「跳转」「下载」一样两个字）；读屏说明写全
  const sendLabel = sending ? "送去中" : sendState === "complete" ? "已送达" : sendState === "failed" ? "重送" : "送去";
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
    // 焦点进了文件夹菜单也不收起操作层：菜单关上时焦点要回到这颗按钮
    if (relatedElement?.closest?.('[data-testid="record-tile-action"],[role="menu"]')) return;
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
      {...fx({ reveal: inView, hover: "card", ws: "w-tile", i: enter })}
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
      {...contextMenuProps(onFolderMenu && !selection ? (at) => onFolderMenu(record, at) : undefined)}
      style={[styles.tile, cellStyle]}
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
        <View {...ws("w-cover")} style={[styles.tileVisual, { backgroundColor: fallbackColor(record.id) }]}>
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
              <View {...ws("w-disc")} style={[styles.fallbackDisc, { borderColor: accent }]}><Music2 color={accent} size={26} strokeWidth={1.8} /></View>
              <Text {...ws("w-bignum")} style={styles.fallbackIndex}>{String(hashString(record.id) % 99 + 1).padStart(2, "0")}</Text>
            </View>
          )}
          <View style={styles.tileTopMeta}>
            <View style={[styles.tileTopLeft, selection && styles.tileTopLeftSelecting]}>
              <View {...ws("w-type")} style={[styles.typeBadge, { backgroundColor: accent }]} />
              {folderName ? <Text {...ws("stamp w-folder")} numberOfLines={1} style={[styles.durationBadge, styles.folderBadge]}>{folderName}</Text> : null}
              {record.feedFilter ? <Text {...ws("stamp")} numberOfLines={1} style={[styles.durationBadge, styles.folderBadge]}>{FEED_ACTION_LABEL[record.feedFilter.action]}</Text> : null}
            </View>
            {record.durationSeconds ? <Text {...ws("stamp")} style={styles.durationBadge}>{formatDuration(record.durationSeconds)}</Text> : null}
          </View>
          <View {...ws("w-tilebar")} style={styles.tileBottomMeta}>
            {record.watchProgress?.percent !== undefined && record.watchProgress.percent !== null ? (
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(2, Math.min(100, record.watchProgress.percent))}%`, backgroundColor: accent }]} /></View>
            ) : null}
            <View style={styles.tilePlayMeta}>
              <Play color={color.white} fill={color.white} size={12} />
              <Text {...ws("mono")} style={styles.tilePlayText}>{record.stats?.playCount ? formatCompactNumber(record.stats.playCount) : "记录"}</Text>
            </View>
          </View>
        </View>
        <Text {...ws("w-tiletitle")} numberOfLines={2} style={styles.tileTitle}>{privacy ? "内容标题已隐藏" : record.title}</Text>
        <View style={styles.tileMetaRow}>
          <Text numberOfLines={1} style={styles.tileAuthor}>{privacy ? "创作者已隐藏" : record.author ?? "未知创作者"}</Text>
          <Text {...ws("mono")} style={styles.tileDate}>{formatShortDate(record.occurredAt)}</Text>
        </View>
        {record.feedFilter?.matched.length ? (
          <Text numberOfLines={1} style={styles.tileFeedRule}>命中：{privacy ? "词条已隐藏" : record.feedFilter.matched.join("、")}</Text>
        ) : null}
      </Pressable>
      {showActions ? (
        <View {...fx({ motion: "fade", ws: "w-overlay" })} pointerEvents="auto" style={styles.tileActionsOverlay}>
          {onPlayRecord ? (
            <Pressable
              testID="record-tile-action"
              accessibilityLabel={record.mediaType === "live" ? "进入直播间" : record.mediaType === "image" ? "播放图文" : "播放视频"}
              accessibilityRole="button"
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={() => onPlayRecord(record)}
              {...ws("w-play")}
              style={({ pressed }) => [styles.tilePlayButton, pressed && styles.tileActionPressed, webPointer]}
            >
              <Play color={color.white} fill={color.white} size={28} style={{ marginLeft: 3 }} />
            </Pressable>
          ) : null}
          {onFolderMenu ? (
            <Pressable
              testID="record-tile-action"
              accessibilityLabel={filedIn ? `换文件夹，现在在「${filedIn}」` : "放进文件夹"}
              accessibilityRole="button"
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={(event) => onFolderMenu(record, pointBelow(event))}
              {...ws("btn-sig w-tileaction")}
              style={({ pressed }) => [styles.tileAction, styles.tileFolderButton, pressed && styles.tileActionPressed, webPointer]}
            >
              <FolderInput color={color.white} size={15} strokeWidth={2.2} />
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
              {...ws("btn-sig w-tileaction")}
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
              {...ws("btn-sig w-tileaction")}
              style={({ pressed }) => [styles.tileAction, (downloading || !onDownloadRecord) && styles.tileActionDisabled, pressed && styles.tileActionPressed, webPointer]}
            >
              {downloading ? <ActivityIndicator color={color.white} size="small" /> : <Download color={color.white} size={14} strokeWidth={2.2} />}
              <Text style={styles.tileActionText}>{downloadLabel}</Text>
            </Pressable>
            {onSendToReelLab && record.mediaType !== "image" ? <Pressable
              testID="record-tile-action"
              accessibilityLabel={sending ? "正在送去拆片工坊" : sendState === "complete" ? "已送到拆片工坊，再送一次" : sendState === "failed" ? "没送到拆片工坊，重送" : "送去拆片工坊"}
              accessibilityRole="button"
              accessibilityState={{ disabled: sending }}
              disabled={sending}
              onFocus={markFocused}
              onBlur={checkFocusBoundary}
              onPress={() => onSendToReelLab(record)}
              {...ws("btn-sig w-tileaction")}
              style={({ pressed }) => [styles.tileAction, sending && styles.tileActionDisabled, pressed && styles.tileActionPressed, webPointer]}
            >
              {sending ? <ActivityIndicator color={color.white} size="small" /> : <Send color={color.white} size={14} strokeWidth={2.2} />}
              <Text style={styles.tileActionText}>{sendLabel}</Text>
            </Pressable> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const RecordRow = memo(function RecordRow({ record, type, privacy, onOpenRecord, selection, folderName, onFolderMenu, enter }: {
  enter?: number;
  record: PersonalVideoRecord;
  type: PersonalRecordType;
  privacy: boolean;
  onOpenRecord: (url: string) => Promise<void>;
  selection?: RecordSelection;
  folderName?: string;
  onFolderMenu?: (record: PersonalVideoRecord, at: MenuPoint) => void;
}) {
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
      {...fx({ hover: "tint", ws: "w-row", motion: enter ? "rise" : null, i: enter })}
      {...contextMenuProps(onFolderMenu && !selection ? (at) => onFolderMenu(record, at) : undefined)}
      style={({ pressed }) => [styles.recordRow, pressed && styles.recordRowPressed, record.url && webPointer]}
    >
      {selection ? <SelectionMark selection={selection} /> : null}
      <View {...ws("w-thumb")} style={[styles.rowThumb, { backgroundColor: fallbackColor(record.id) }]}>
        {imageAvailable ? (
          <ImageBackground onError={() => setImageFailed(true)} resizeMode="cover" source={{ uri: record.coverUrl! }} style={styles.rowThumbImage} />
        ) : <Music2 color={accent} size={22} />}
      </View>
      <View style={styles.rowCopy}>
        <Text {...ws("w-rowtitle")} numberOfLines={2} style={styles.rowTitle}>{privacy ? "内容标题已隐藏" : record.title}</Text>
        <Text numberOfLines={1} style={styles.rowAuthor}>{privacy ? "创作者已隐藏" : record.author ?? "未知创作者"}</Text>
        <View style={styles.rowMeta}>
          <Text {...ws("mono")} style={styles.rowMetaText}>{formatShortDate(record.occurredAt)}</Text>
          {record.durationSeconds ? <Text {...ws("mono")} style={styles.rowMetaText}>{formatDuration(record.durationSeconds)}</Text> : null}
          {record.topics?.[0] ? <Text {...ws("stamp-sig")} style={[styles.rowTopic, { color: accent }]}>#{privacy ? "话题" : record.topics[0]}</Text> : null}
          {folderName ? <View style={styles.rowFolder}><Folder color={color.textMuted} size={11} /><Text numberOfLines={1} style={styles.rowMetaText}>{folderName}</Text></View> : null}
          {record.feedFilter ? (
            <Text numberOfLines={1} style={styles.rowMetaText}>
              {FEED_ACTION_LABEL[record.feedFilter.action]}{record.feedFilter.matched.length ? ` · 命中：${privacy ? "词条已隐藏" : record.feedFilter.matched.join("、")}` : ""}
            </Text>
          ) : null}
        </View>
      </View>
      {record.url && !selection ? <ArrowUpRight color={color.textMuted} size={19} /> : null}
    </Pressable>
  );
});

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
      <View {...fx({ motion: "rise", ws: "w-hhead" })} style={[styles.highlightsHeader, mobile && styles.highlightsHeaderMobile]}>
        <View style={styles.dashboardHeaderCopy}>
          <Text {...ws("stamp-sig")} style={styles.summaryEyebrow}>CHANGES · {formatLivingFreshness(report.freshness)}</Text>
          <Text {...ws("w-htitle")} style={[styles.summaryTitle, mobile && styles.summaryTitleMobile]}>变化线索</Text>
          <Text style={styles.summaryLead}>把最近发生的变化、稳定倾向和真实证据放在同一条线上。</Text>
        </View>
        <View {...ws("w-hcountblock")} style={[styles.highlightCountBlock, mobile && styles.dashboardPeriodMobile]}>
          <Text {...ws("w-hcount")} style={styles.highlightCountValue}>{chapters.filter((chapter) => chapter.status === "ok").length}</Text>
          <Text style={styles.dashboardPeriodMeta}>项当前线索</Text>
        </View>
      </View>
      <View style={styles.livingChangeList}>
        {chapters.map((chapter, index) => <LivingChangeCard chapter={chapter} index={index} key={chapter.id} onOpenRecord={onOpenRecord} privacy={privacy} />)}
      </View>
      <View {...ws("w-foot g-ink")} style={styles.highlightsFootnote}>
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
    <View {...fx({ reveal: inView, i: index + 1, hover: "lift", ws: "w-card" })} ref={cardRef} style={[styles.livingChangeCard, { borderTopColor: accent }]}>
      <View style={styles.livingChangeHeader}>
        <Text {...ws("stamp")} style={styles.livingChangeEyebrow}>{chapter.eyebrow}</Text>
        <Text style={[styles.livingChangeStatus, chapter.status !== "ok" && styles.livingChangeStatusMuted]}>{chapter.status === "ok" ? "已形成" : "尚在形成"}</Text>
      </View>
      <Text {...ws("w-cardtitle")} style={styles.livingChangeTitle}>{chapter.title}</Text>
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
      {chapter.notice ? <Text {...ws("w-notice")} style={styles.panelNotice}>{chapter.notice}</Text> : null}
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
      <View {...fx({ motion: "rise", ws: "w-hhead" })} style={[styles.highlightsHeader, mobile && styles.highlightsHeaderMobile]}>
        <View style={styles.dashboardHeaderCopy}>
          <Text {...ws("stamp-sig")} style={styles.summaryEyebrow}>HIGHLIGHTS · {report.periodLabel.toUpperCase()}</Text>
          <Text {...ws("w-htitle")} style={[styles.summaryTitle, mobile && styles.summaryTitleMobile]}>变化线索</Text>
          <Text style={styles.summaryLead}>从最近新增、偏好变化、回访模式和稳定倾向里，保留可被证据支持的线索。</Text>
        </View>
        <View {...ws("w-hcountblock")} style={[styles.highlightCountBlock, mobile && styles.dashboardPeriodMobile]}>
          <Text {...ws("w-hcount")} style={styles.highlightCountValue}>{availableCount}</Text>
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
      <View {...ws("w-foot g-ink")} style={styles.highlightsFootnote}>
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
      {...fx({ reveal: inView, i: index + 1, hover: "card", ws: item ? "w-card" : "w-card void" })}
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
      <View {...ws("w-hvisual")} style={[styles.highlightVisual, { backgroundColor: fallbackColor(`${label}:${index}`) }]}>
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
            <Text {...ws("w-bignum")} style={styles.highlightIndex}>{String(index + 1).padStart(2, "0")}</Text>
          </View>
        )}
        <View {...ws("w-hlabel")} style={[styles.highlightLabel, { borderColor: accent }]}><Text {...ws("w-hlabeltext")} style={styles.highlightLabelText}>{label}</Text></View>
      </View>
      <View style={styles.highlightBody}>
        <Text {...ws("w-cardtitle")} numberOfLines={2} style={styles.highlightTitle}>{title}</Text>
        <Text numberOfLines={1} style={styles.highlightAuthor}>{author}</Text>
        <Text style={styles.highlightDetail}>{detail}</Text>
        <View {...ws("w-hrule")} style={styles.highlightRuleRow}>
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
      <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>这一章还在形成</Text>
      <Text style={styles.emptyDetail}>完成一次读取并积累带可靠行为时间的记录后，持续报告会逐步生成当前主线、变化线索和行为画像。</Text>
    </View>
  );
}

function PanelNotice({ text }: { text: string }) {
  return <Text {...ws("w-notice")} style={styles.panelNotice}>{text}</Text>;
}

function formatCompactNumber(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return value.toLocaleString("zh-CN");
}

function formatShortDate(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return SHORT_DATE.format(date);
}

// 每张卡片都要格式化日期，toLocaleDateString 带参数每次新建格式器，建一次复用
const SHORT_DATE = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });

function formatLongDate(value: string): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${date.getFullYear()} 年 `}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
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

// 矮窗口（如 900×612）里导航项 + 活跃环放不下：让这一段自己滚，别压到底部的设置 / 重看 / 连接与采集。
// 横向必须 hidden：收起态文字只是透明、仍占宽度，auto 会让整列图标能被横着滚走。没滚到底时底边渐隐（motionCss 的 data-sidenav）
const sidebarScroll = (Platform.OS === "web" ? { overflowY: "auto", overflowX: "hidden", scrollbarWidth: "none" } : {}) as ViewStyle;
const SIDENAV: object = Platform.OS === "web" ? { dataSet: { sidenav: "1" } } : {};

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
  // 左右各伸出 14 再垫回来：导航能滚时，贴在侧栏左边缘的选中条（left:-14）不会被裁掉
  // 顶上 46 用 margin 而不是 padding：滚动时导航从折叠按钮下面滑过，而不是从它背后露出来
  sidebarBody: { flex: 1, marginTop: 46, marginHorizontal: -14, paddingHorizontal: 14 },
  sidebarNav: { gap: 4 },
  navSection: { height: StyleSheet.hairlineWidth, marginVertical: 2, marginHorizontal: 8, backgroundColor: color.border },
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
  galleryHeaderCopy: { flex: 1, minWidth: 180 },
  galleryMetaBelow: { marginTop: -6, marginBottom: 12 },
  liveEntry: { flexDirection: "row", alignItems: "center", gap: 8 },
  followLive: { gap: 10, marginBottom: 18 },
  followLiveHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  followLiveTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  followLiveCount: { color: color.accent, fontSize: 11 },
  followLiveRefresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  followLiveNote: { color: color.textMuted, fontSize: 12 },
  followLiveList: { gap: 10, paddingBottom: 2 },
  followLiveCard: { width: 236, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  followLiveAvatar: { width: 46, height: 46, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 2, borderColor: color.accent, borderRadius: 23, backgroundColor: color.sidebar },
  followLiveAvatarImage: { width: "100%", height: "100%" },
  followLiveCopy: { flex: 1, minWidth: 0, gap: 2 },
  followLiveName: { color: color.text, fontSize: 13, fontWeight: "600" },
  followLiveRoomTitle: { color: color.textSecondary, fontSize: 11 },
  followLiveMeta: { color: color.textMuted, fontSize: 10 },
  searchBox: { width: 240, height: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  searchInput: { flex: 1, minWidth: 0, height: 36, color: color.text, fontSize: 12, paddingRight: 11 },
  liveEntryInput: { width: 230, height: 38, color: color.text, fontSize: 12, paddingHorizontal: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
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
  tileFeedRule: { color: color.textMuted, fontSize: 10, marginTop: 1 },
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
  tileTopLeft: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0, marginRight: 6 },
  // 多选时左上角是勾选框，文件夹名让到它右边
  tileTopLeftSelecting: { marginLeft: 30 },
  folderBadge: { flexShrink: 1, maxWidth: 110 },
  tileFolderButton: { position: "absolute", top: 10, right: 10, width: 34, height: 34, minHeight: 34, paddingHorizontal: 0 },
  rowFolder: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 160 },
  // 文件夹芯片照聊天页的筛选芯片写（c-filters / c-filter），另外三种风格的样式都已经覆盖到
  folderBar: { marginBottom: 16 },
  // 内容库页签：顶栏下面一条，和文件夹小标签同一个路数，选中的用这一栏自己的颜色
  libraryTabs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 24, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  libraryTabsMobile: { paddingHorizontal: 12 },
  libraryTab: { height: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, borderRadius: radius.small },
  libraryTabText: { color: color.textMuted, fontSize: 13, fontWeight: "700" },
  libraryTabTextOn: { color: color.text },
  libraryTabCount: { color: color.textMuted, fontSize: 11, fontVariant: ["tabular-nums"] },
  folderRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  folderTabs: { flexShrink: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  folderRetry: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  folderRetryText: { color: color.danger, fontSize: 12, lineHeight: 18 },
  folderChip: { height: 30, maxWidth: 220, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderRadius: radius.small },
  folderChipOn: { backgroundColor: color.cyanSoft },
  folderChipText: { flexShrink: 1, color: color.textMuted, fontSize: 12, fontWeight: "800" },
  folderChipTextOn: { color: color.cyan },
  folderChipCount: { color: color.textMuted, fontSize: 10, fontVariant: ["tabular-nums"] },
  folderAction: { height: 30, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  folderActionText: { color: color.textSecondary, fontSize: 12 },
  folderManage: { flexDirection: "row", gap: 6, marginLeft: "auto" },
  folderError: { color: color.danger, fontSize: 12, lineHeight: 18, marginTop: 8 },
  dialogBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: color.scrim },
  dialog: { width: "100%", maxWidth: 420, gap: 14, padding: 20, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  dialogTitle: { color: color.text, fontSize: 18, fontWeight: "600" },
  dialogText: { color: color.textSecondary, fontSize: 13, lineHeight: 21 },
  dialogInput: { height: 40, color: color.text, fontSize: 13, paddingHorizontal: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surfaceMuted },
  dialogError: { color: color.danger, fontSize: 12, lineHeight: 18, marginTop: -6 },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
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
