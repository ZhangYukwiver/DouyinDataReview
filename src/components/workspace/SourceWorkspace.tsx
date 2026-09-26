import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import {
  ArrowRight,
  BookOpen,
  Bookmark,
  Database,
  Download,
  Eye,
  FileArchive,
  Globe,
  HardDrive,
  Heart,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  MessageCircle,
  NotebookPen,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Unplug,
  UserRoundCog,
  X,
} from "lucide-react-native";

import type { PersonalRecordCollection } from "../../domain/personalRecords";
import type { DesktopUpdateState } from "../../desktopRuntime";
import type { CollectorStatus } from "../../services/localCollector";
import { APP_STYLES, type AppStyle } from "../../services/appStyle";
import { ease, useCountUp } from "./motion";
import {
  dayWindow,
  digestRecords,
  hachure,
  roughArrow,
  roughCheck,
  roughEllipse,
  roughLine,
  roughRect,
  roughShape,
  seeded,
  type RecordDigest,
  type SetupRecordKind,
} from "./setupSketch";

export interface SetupArchiveInfo {
  name: string;
  detail: string;
  loaded: boolean;
  mergeable: boolean;
}

export interface SetupWorkspaceProps {
  collectorUrl: string;
  pairingCode: string;
  connected: boolean;
  busy: boolean;
  observing: boolean;
  chatCollecting: boolean;
  chatBusy: boolean;
  stoppingSync: boolean;
  switchingAccount: boolean;
  status: CollectorStatus | null;
  error: string | null;
  records: PersonalRecordCollection;
  chatCount: number | null;
  snapshotSource: "collector" | "archive" | null;
  snapshotUpdatedAt: string | null;
  archive: SetupArchiveInfo | null;
  pickingArchive: boolean;
  onChangeCollectorUrl: (value: string) => void;
  onChangePairingCode: (value: string) => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onStartObservation: () => Promise<void>;
  onStartChatObservation: () => Promise<void>;
  onCollectChatHistory: () => Promise<void>;
  onStopObservation: () => Promise<void>;
  onStartIncrementalSync: () => void;
  onStartFullSync: () => void;
  onStopSync: () => Promise<void>;
  onSwitchAccount: () => void;
  onClearCache: () => void;
  onExportData: () => void;
  onPickArchive: () => Promise<void>;
  onRemoveArchive: () => void;
  onMergeArchive: () => void;
  onEnterWorkspace: () => void;
  onOpenDashboard: () => void;
  autoSyncEnabled: boolean;
  onToggleAutoSync: () => void;
  appStyle: AppStyle;
  onChangeAppStyle: (style: AppStyle) => void;
  appUpdate: DesktopUpdateState | null;
  onCheckAppUpdate: () => Promise<void>;
  onDownloadAppUpdate: () => Promise<void>;
  onInstallAppUpdate: () => Promise<void>;
}

const web = Platform.OS === "web";
const pointer = web ? ({ cursor: "pointer" } as object) : null;
// 圈注出现时像红笔现画一圈（CSS 描边动画，见 PAPER_CSS）；RN 的 View 类型里没有 dataSet，所以走展开
const DRAW: object = web ? { dataSet: { draw: "1" } } : {};

// 采集器页只有这一套样式：纸面、墨水笔、铅笔灰，红笔圈重点、黄色荧光笔划重点、便签纸写提示。
// 不跟整体风格走（整体风格只管报告和工作台），所以这里不用主题 token，也不打 data-ws 角色。
const C = {
  paper: "#F5EFE2", card: "#FFFDF6", sunken: "#F2ECDF", hover: "#FFF3C9",
  text: "#262A33", text2: "#484C55", muted: "#7A7466", faint: "#A39C8C",
  ink: "#262A33", inkHover: "#3B404C", inkText: "#FFFDF6", line: "#2E323C", pencil: "#A69F8F",
  red: "#CF4B2F", green: "#2E8753", blue: "#2F5EA6", highlight: "rgba(255,214,74,.5)", tape: "rgba(212,193,140,.6)",
  noteYellow: "#FFF1A6", noteBlue: "#E1EDFA", notePink: "#FBE3DC", noteInk: "#4A3F24",
};
const SANS = web ? "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" : undefined;
// 手写体：西文和数字用 Caveat，中文用马善政楷书（Caveat 没有汉字，浏览器逐字往后找）。
// 不用龙藏体：它的「采」小字号下像「乐」、「以」像「レ<」，「本机采集器」都认不出来。
// 离线时西文退到系统里的手写体（Bradley Hand / Segoe Print），中文退到楷体，再不行就是苹方/雅黑。
const HAND = web ? "'Caveat', 'Ma Shan Zheng', 'Bradley Hand', 'Segoe Print', 'Kaiti SC', 'STKaiti', 'KaiTi', 'PingFang SC', 'Microsoft YaHei', cursive" : undefined;
const HAND_FONTS = "https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Ma+Shan+Zheng&display=swap";
// 纸面：米色底 + 点阵 + 一层很淡的纸纹噪点（只在采集器页根节点上）
const NOISE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .33 0 0 0 0 .27 0 0 0 0 .18 0 0 0 .09 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";
const PAPER_CSS = `
[data-testid="setup-workspace"]{background-color:${C.paper};background-image:radial-gradient(rgba(84,70,44,.17) 1px,transparent 1.35px),${NOISE};background-size:22px 22px,160px 160px}
[data-testid="setup-workspace"] [data-draw] path{stroke-dasharray:420;stroke-dashoffset:420;animation:setup-draw 1s cubic-bezier(.3,.6,.3,1) .15s forwards}
@keyframes setup-draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){[data-testid="setup-workspace"] [data-draw] path{animation:none;stroke-dashoffset:0}}
`;

// 字体和纸面样式只注入一次；Electron 的 CSP 放行了 fonts.googleapis.com / fonts.gstatic.com 和内联样式
function useSetupDecor() {
  useEffect(() => {
    if (!web || typeof document === "undefined") return;
    if (!document.getElementById("setup-hand-fonts")) {
      const link = document.createElement("link");
      link.id = "setup-hand-fonts";
      link.rel = "stylesheet";
      link.href = HAND_FONTS;
      document.head.appendChild(link);
    }
    if (!document.getElementById("setup-paper")) {
      const style = document.createElement("style");
      style.id = "setup-paper";
      style.textContent = PAPER_CSS;
      document.head.appendChild(style);
    }
  }, []);
}

// ponytail: 包一层统一字体，比逐条 style 加 fontFamily 省
const bodyType = { fontFamily: SANS } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}
function Hand({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[styles.hand, style]} />;
}

// RN-web 的 Pressable 会把 hovered 传进 style 回调，类型里没有
type PressState = { pressed: boolean; hovered?: boolean };
type Size = { w: number; h: number };
type Icon = React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

function useSize(): [Size | null, (event: LayoutChangeEvent) => void] {
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous && Math.abs(previous.w - width) < 0.5 && Math.abs(previous.h - height) < 0.5 ? previous : { w: width, h: height }));
  }, []);
  return [size, onLayout];
}

export function SetupWorkspace({
  appStyle,
  archive,
  autoSyncEnabled,
  busy,
  chatCount,
  collectorUrl,
  connected,
  error,
  onChangeAppStyle,
  onChangeCollectorUrl,
  onChangePairingCode,
  onClearCache,
  onExportData,
  onConnect,
  onDisconnect,
  onEnterWorkspace,
  onOpenDashboard,
  onPickArchive,
  onRemoveArchive,
  onMergeArchive,
  onStartChatObservation,
  onCollectChatHistory,
  onStartFullSync,
  onStartIncrementalSync,
  onStartObservation,
  onStopObservation,
  onStopSync,
  onSwitchAccount,
  onToggleAutoSync,
  observing,
  chatCollecting,
  chatBusy,
  pairingCode,
  pickingArchive,
  records,
  snapshotSource,
  snapshotUpdatedAt,
  status,
  stoppingSync,
  switchingAccount,
  appUpdate,
  onCheckAppUpdate,
  onDownloadAppUpdate,
  onInstallAppUpdate,
}: SetupWorkspaceProps) {
  useSetupDecor();
  const { width, height } = useWindowDimensions();
  // 一屏放下：矮窗口收紧间距，窄窗口按钮收小；最窄最矮时几段动态说明只留几行；又高又宽时字和图放大
  const short = height < 780;
  const narrow = width < 1100;
  const tight = narrow || height < 660;
  const roomy = height >= 880 && width >= 1300;
  const counts = { watch: records.watch_history.length, liked: records.liked_videos.length, favorite: records.favorite_videos.length, chat: chatCount ?? 0 };
  const total = counts.watch + counts.liked + counts.favorite + counts.chat;
  const ready = total > 0 || status?.state === "complete" || snapshotSource === "archive";
  const syncing = connected && !observing && ["launching_browser", "awaiting_login", "collecting"].includes(status?.state ?? "");
  // 完整读取要独占可见浏览器；增量读取走无头，接收和下载照常
  const visibleBusy = observing || status?.syncMode === "page";
  const chatProgress = status?.chat.progress ?? null;
  const source = snapshotSource === "archive" ? "备用文件导入" : connected ? "本地采集器" : "尚未连接";
  const loginNeeded = status?.state === "awaiting_login" || status?.code === "login_required";
  const digest = useMemo(() => digestRecords(records, 24), [records]);
  const fromArchive = snapshotSource === "archive";

  // 数据流向图当前走到哪一步：0 抖音网页 → 1 本机采集器 → 2 本地记录 → 3 报告
  const flow = fromArchive
    ? { step: 3, done: [true, true, true], note: "可以看了" }
    : loginNeeded
      ? { step: 0, done: [false, connected, ready], note: "要登录" }
      : !connected
        ? { step: 1, done: [false, false, ready], note: "先连上" }
        : syncing
          ? { step: 2, done: [true, true, false], note: "读取中" }
          : ready
            ? { step: 3, done: [true, true, true], note: "可以看了" }
            : { step: 2, done: [true, true, false], note: "去读取" };

  const range = digest.first !== null ? `，最早到 ${formatLongDay(digest.first, true)}` : "";
  const recordDetail = total ? `一共 ${total.toLocaleString("zh-CN")} 条${range}。` : "观看、喜欢、收藏与聊天";
  const notes = tipNotes({ fromArchive, connected, loginNeeded, syncing, ready, autoSyncEnabled });
  const cardPad = narrow ? styles.cardNarrow : short ? styles.cardShort : roomy ? styles.cardRoomy : null;

  return (
    <View testID="setup-workspace" style={styles.root}>
      <View style={[styles.topbar, narrow && styles.topbarNarrow]}>
        <View style={styles.brand}>
          <SketchBox seed="brand-mark" fill={C.card} passes={2} amp={1} style={styles.mark}><NotebookPen color={C.ink} size={17} strokeWidth={1.8} /></SketchBox>
          <Hand style={[styles.brandName, narrow && styles.brandNameNarrow]}>内容数据工作台</Hand>
        </View>
        <View style={styles.topStatus}><View style={[styles.dot, connected && styles.dotOn]} /><Text numberOfLines={1} style={styles.statusText}>{busy && ready && snapshotSource === "collector" ? `${source} · 采集中，报告用采集前的数据` : source}</Text></View>
        <View style={styles.row8}>
          <SketchButton seed="top-dashboard" icon={LayoutDashboard} label="进入工作台" onPress={onOpenDashboard} />
          <SketchButton seed="top-report" disabled={!ready} icon={ArrowRight} iconAfter kind="ink" label="打开报告" onPress={onEnterWorkspace} />
        </View>
        <HRule seed="topbar-rule" style={styles.topRule} />
      </View>

      {/* 标题行 + 流向条 + 三张卡（连接 / 内容记录 / 档案与维护），整页锁在一屏里；ScrollView 只是兜底 */}
      <ScrollView contentContainerStyle={[styles.scrollContent, short && styles.scrollContentShort, narrow && styles.scrollContentNarrow]} showsVerticalScrollIndicator={false} style={styles.scroll}>
        <View style={[styles.page, short && styles.pageShort]}>
          <View style={styles.header}>
            <View style={styles.flex}>
              <View style={styles.titleRow}>
                {/* 荧光笔划的是「再打开报告」而不是「打开报告」：脚本按全文等于「打开报告」找按钮，这里别跟它重名 */}
                <Hand style={[styles.title, roomy && styles.titleRoomy, short && styles.titleShort, tight && styles.titleTight]}>先连接数据，</Hand>
                <Highlight seed="title-mark"><Hand style={[styles.title, roomy && styles.titleRoomy, short && styles.titleShort, tight && styles.titleTight]}>再打开报告</Hand></Highlight>
                <Hand style={[styles.title, roomy && styles.titleRoomy, short && styles.titleShort, tight && styles.titleTight]}>。</Hand>
              </View>
              <Text numberOfLines={1} style={styles.meta}>连接本地采集器，或导入一份个人档案；数据只留在这台设备上。</Text>
            </View>
            {web ? (
              <View testID="app-style" style={styles.styleBlock}>
                <View style={styles.styleLabel}>
                  <Hand style={styles.styleLabelText}>报告风格</Hand>
                  <Svg height={14} width={34}><Path d={roughArrow(2, 9, 31, 6, "style-arrow", { bend: 3, head: 6 })} fill="none" stroke={C.muted} strokeLinecap="round" strokeWidth={1.3} /></Svg>
                </View>
                <View accessibilityRole="radiogroup" style={styles.segments}>
                  {APP_STYLES.map((item) => (
                    <StyleOption key={item.key} detail={item.detail} kind={item.key} label={item.label} on={appStyle === item.key} onPress={() => onChangeAppStyle(item.key)} size={roomy ? "large" : tight ? "small" : "medium"} />
                  ))}
                </View>
              </View>
            ) : null}
          </View>

          <SketchBox seed="flow-strip" fill={C.card} stroke={C.pencil} passes={2} amp={1.8} style={[styles.statusBar, narrow && styles.statusBarNarrow]}>
            <FlowDiagram archive={fromArchive} compact={narrow} done={flow.done} note={flow.note} step={flow.step} />
            <VRule height={34} seed="flow-divider" />
            <View style={[styles.statusCopy, narrow && styles.statusCopyNarrow]}>
              {/* 窄窗口里流向图已经圈出了状态，标题让位给说明 */}
              {narrow ? null : <Hand numberOfLines={1} style={styles.statusTitle}>{fromArchive ? "正在用导入的文件" : connected ? "采集器已就绪" : "等待连接数据源"}</Hand>}
              <Text numberOfLines={2} style={[styles.meta, styles.flex]}>{status?.message ?? "所有操作均在本机执行"}</Text>
            </View>
          </SketchBox>

          <View style={[styles.cards, narrow && styles.cardsNarrow]}>
            {/* 01 连接 */}
            <SketchBox seed="card-connect" fill={C.card} style={[styles.card, cardPad]}>
              <Tape seed="tape-1" />
              <CardHead index="01" done={connected} title="连接数据源" detail="本地采集器，不上传云端" size={narrow ? "small" : roomy ? "large" : "medium"} />
              <Text style={styles.label}>服务地址</Text>
              <SketchBox seed="input-url" fill={connected ? C.sunken : "#FFFFFF"} stroke={C.pencil} passes={1} amp={1.3} style={[styles.inputBox, short && styles.inputShort]}>
                <TextInput accessibilityLabel="采集服务地址" autoCapitalize="none" autoCorrect={false} editable={!connected && !busy} onChangeText={onChangeCollectorUrl} placeholder="http://127.0.0.1:4765" placeholderTextColor={C.faint} style={[styles.input, connected && styles.inputDisabled]} value={collectorUrl} />
              </SketchBox>
              {!connected ? <>
                <Text style={styles.label}>配对码</Text>
                <SketchBox seed="input-code" fill="#FFFFFF" stroke={C.pencil} passes={1} amp={1.3} style={[styles.inputBox, styles.codeWrap, short && styles.inputShort]}>
                  <LockKeyhole color={C.faint} size={14} />
                  <TextInput accessibilityLabel="8 位配对码" editable={!busy} keyboardType="number-pad" maxLength={8} onChangeText={(value) => onChangePairingCode(value.replace(/\D/gu, ""))} placeholder="连接时自动获取" placeholderTextColor={C.faint} style={[styles.input, styles.codeInput]} value={pairingCode} />
                </SketchBox>
              </> : null}
              <SketchButton seed="connect" busy={busy} disabled={busy} full icon={connected ? Unplug : Link2} kind={connected ? "outline" : "ink"} label={connected ? "断开连接" : "连接采集器"} onPress={() => void (connected ? onDisconnect() : onConnect())} tall={!short} />
              {/* 报错和便签共用按钮下面这块地方：报错先写，能写几行写几行，剩下的再贴便签 */}
              <FitSlot style={styles.slotTop}>{(size) => <NoteStack error={error} notes={notes} size={size} roomy={roomy} />}</FitSlot>
            </SketchBox>

            {/* 02 内容记录 */}
            <SketchBox seed="card-records" fill={C.card} style={[styles.card, styles.cardWide, cardPad]}>
              <Tape seed="tape-2" />
              <CardHead index="02" done={ready} title="读取内容记录" detail={recordDetail} aside={snapshotUpdatedAt ? `更新于 ${formatDate(snapshotUpdatedAt)}` : undefined} size={narrow ? "small" : roomy ? "large" : "medium"} />
              <View style={styles.counts}>
                <Count label="观看历史" value={counts.watch} icon={Eye} size={narrow ? "small" : roomy ? "large" : "medium"} />
                <VRule height={32} seed="count-1" />
                <Count label="喜欢" value={counts.liked} icon={Heart} size={narrow ? "small" : roomy ? "large" : "medium"} />
                <VRule height={32} seed="count-2" />
                <Count label="收藏" value={counts.favorite} icon={BookmarkIcon} size={narrow ? "small" : roomy ? "large" : "medium"} />
                <VRule height={32} seed="count-3" />
                <Count label="聊天" value={counts.chat} icon={MessageCircle} size={narrow ? "small" : roomy ? "large" : "medium"} />
              </View>
              <FitSlot style={styles.slotChart}>{(size) => <RecordSketches digest={digest} roomy={roomy} size={size} />}</FitSlot>
              <ChatProgress progress={chatProgress} />
              <View style={styles.actions}>
                <ActionButton seed="act-incremental" compact={narrow} disabled={!connected || (busy && !syncing) || visibleBusy} icon={Play} label={syncing ? "正在读取" : "增量读取"} onPress={syncing ? () => void onStopSync() : onStartIncrementalSync} busy={syncing ? stoppingSync : busy && !observing} />
                <ActionButton seed="act-full" compact={narrow} disabled={!connected || busy || visibleBusy} icon={RefreshCw} label="完整读取" onPress={onStartFullSync} />
                <ActionButton seed="act-observe" compact={narrow} disabled={!connected || busy} icon={observing ? Pause : Eye} label={observing ? "停止监听" : "手动监听"} onPress={() => void (observing ? onStopObservation() : onStartObservation())} />
                <ActionButton seed="act-chat" compact={narrow} disabled={!connected || chatBusy || (!chatCollecting && (visibleBusy || busy))} icon={chatCollecting ? Pause : MessageCircle} label={chatCollecting ? "暂停接收" : "开始接收"} onPress={() => void (chatCollecting ? onStopObservation() : onStartChatObservation())} />
                <ActionButton seed="act-history" compact={narrow} disabled={!connected || chatBusy || visibleBusy || (busy && !chatCollecting)} icon={RefreshCw} label="采集聊天记录" onPress={() => void onCollectChatHistory()} busy={chatBusy} />
              </View>
              <Text style={styles.hint}>完整读取和手动监听会先暂停接收聊天。</Text>
              <HRule seed="auto-rule" color={C.pencil} style={[styles.rule, short && styles.ruleShort]} />
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: autoSyncEnabled }} aria-checked={autoSyncEnabled} onPress={onToggleAutoSync} style={(state) => [styles.auto, state.pressed && styles.pressed, pointer]}>
                <Text style={[styles.strong, styles.flex]}>回到前台时自动增量读取</Text>
                <Hand style={[styles.autoState, autoSyncEnabled && styles.autoStateOn]}>{autoSyncEnabled ? "已开启" : "已暂停"}</Hand>
                <SketchSwitch on={autoSyncEnabled} />
              </Pressable>
            </SketchBox>

            {/* 档案与维护 */}
            <SketchBox seed="card-archive" fill={C.card} style={[styles.card, cardPad]}>
              <Tape seed="tape-3" />
              <View testID="archive-card">
                <CardHead icon={archive?.loaded ? undefined : FileArchive} done={Boolean(archive?.loaded)} title={archive?.name ?? "导入个人档案"} plainTitle={Boolean(archive)} detail={archive?.detail ?? "JSON 或 ZIP，只在本次打开时读取"} detailLines={appUpdate ? (tight ? 3 : 4) : tight ? 6 : 8} size={narrow ? "small" : roomy ? "large" : "medium"} />
                <View style={styles.smallRow}>
                  <SketchButton seed="archive-pick" compact={narrow} disabled={pickingArchive} busy={pickingArchive} icon={FileArchive} kind="small" label={archive ? "重新选择" : "选择文件"} onPress={() => void onPickArchive()} />
                  {archive?.mergeable && !pickingArchive ? <SketchButton seed="archive-merge" compact={narrow} disabled={busy} icon={Database} kind="small" label="并入本机记录" onPress={onMergeArchive} /> : null}
                  {archive && !pickingArchive ? <SketchButton seed="archive-remove" compact={narrow} icon={X} kind="small" label="移除" onPress={onRemoveArchive} /> : null}
                </View>
              </View>
              <FitSlot style={styles.slotTop}>{(size) => <RecentList digest={digest} size={size} />}</FitSlot>
              <HRule seed="tools-rule" color={C.pencil} style={[styles.rule, short && styles.ruleShort]} />
              <View style={styles.smallRow}>
                <SketchButton seed="tool-account" compact={narrow} disabled={!connected || busy || switchingAccount} icon={UserRoundCog} kind="small" label="切换账号" onPress={onSwitchAccount} />
                {web ? <SketchButton seed="tool-export" compact={narrow} disabled={!connected} icon={Download} kind="small" label="导出数据" onPress={onExportData} /> : null}
                <SketchButton seed="tool-clear" compact={narrow} disabled={!total || busy} icon={Trash2} kind="small" label="清除本地记录" onPress={onClearCache} />
              </View>
              {appUpdate ? <AppUpdatePanel busy={busy || observing} compact={narrow} onCheck={onCheckAppUpdate} onDownload={onDownloadAppUpdate} onInstall={onInstallAppUpdate} short={short} state={appUpdate} tight={tight} /> : null}
            </SketchBox>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------- 手绘的底子：框、线、胶带、荧光笔 ----------

/** 带手绘边框和填充的容器；边框按自身尺寸现画，种子固定所以每次都是同一笔。 */
function SketchBox({ amp = 2.2, children, dash, fill, passes = 2, seed, stroke = C.line, strokeWidth = 1.4, style }: { amp?: number; children?: React.ReactNode; dash?: string; fill?: string; passes?: number; seed: string; stroke?: string; strokeWidth?: number; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  // 第一遍是实笔，第二遍细一点、淡一点，像铅笔回头又描了一道
  const paths = useMemo(() => (size ? {
    fill: fill ? roughShape(size.w, size.h, seed, { amp: amp * 0.6 }) : null,
    first: roughRect(size.w, size.h, seed, { amp, passes: 1 }),
    second: passes > 1 ? roughRect(size.w, size.h, `${seed}#2`, { amp: amp * 1.1, passes: 1 }) : null,
  } : null), [amp, fill, passes, seed, size]);
  return (
    <View onLayout={onLayout} style={style}>
      {size && paths ? (
        <Svg height={size.h} style={styles.under} width={size.w}>
          {paths.fill ? <Path d={paths.fill} fill={fill} /> : null}
          <Path d={paths.first} fill="none" stroke={stroke} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} />
          {paths.second ? <Path d={paths.second} fill="none" opacity={0.5} stroke={stroke} strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth * 0.7} /> : null}
        </Svg>
      ) : null}
      {children}
    </View>
  );
}

/** 横向手绘分隔线，宽度跟着容器走。 */
function HRule({ color = C.line, seed, style }: { color?: string; seed: string; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  const path = useMemo(() => (size ? roughLine(2, 3, size.w - 2, 3, seed, { amp: 1.2 }) : ""), [seed, size]);
  return (
    <View onLayout={onLayout} style={[styles.hrule, style]}>
      {size ? <Svg height={6} width={size.w}><Path d={path} fill="none" stroke={color} strokeLinecap="round" strokeWidth={1.2} /></Svg> : null}
    </View>
  );
}

function VRule({ height, seed }: { height: number; seed: string }) {
  const path = useMemo(() => roughLine(3, 2, 3, height - 2, seed, { amp: 1 }), [height, seed]);
  return <Svg height={height} width={6}><Path d={path} fill="none" stroke={C.pencil} strokeLinecap="round" strokeWidth={1.1} /></Svg>;
}

/** 卡片顶上斜贴的一截美纹纸胶带。 */
function Tape({ seed }: { seed: string }) {
  const [tilt, left] = useMemo(() => {
    const rand = seeded(seed);
    return [(rand() - 0.5) * 7, 28 + rand() * 44];
  }, [seed]);
  return <View style={[styles.tape, { left: `${left}%`, transform: [{ rotate: `${tilt.toFixed(1)}deg` }] }]} />;
}

/** 荧光笔划过文字下半截。 */
function Highlight({ children, seed }: { children: React.ReactNode; seed: string }) {
  const [size, onLayout] = useSize();
  const path = useMemo(() => (size ? roughLine(3, size.h * 0.66, size.w - 2, size.h * 0.62, seed, { amp: 1.5 }) : ""), [seed, size]);
  return (
    <View onLayout={onLayout}>
      {size ? <Svg height={size.h} style={styles.under} width={size.w}><Path d={path} fill="none" stroke={C.highlight} strokeLinecap="round" strokeWidth={size.h * 0.36} /></Svg> : null}
      {children}
    </View>
  );
}

/** 占住卡里剩下的高度，按量到的空间决定里面画多少；内容绝对定位，不会反过来把卡撑高。 */
function FitSlot({ children, style }: { children: (size: Size) => React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  return (
    <View onLayout={onLayout} style={[styles.slot, style]}>
      {size && size.h > 4 ? <View style={[styles.slotInner, { width: size.w, height: size.h }]}>{children(size)}</View> : null}
    </View>
  );
}

// ---------- 按钮 ----------

function SketchButton({ busy, compact, disabled, full, icon: ButtonIcon, iconAfter, kind = "outline", label, onPress, seed, tall, accessibilityLabel, style }: { busy?: boolean; compact?: boolean; disabled?: boolean; full?: boolean; icon: Icon; iconAfter?: boolean; kind?: "ink" | "outline" | "small"; label: string; onPress: () => void; seed: string; tall?: boolean; accessibilityLabel?: string; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  const ink = kind === "ink";
  const paths = useMemo(() => {
    if (!size) return null;
    const amp = kind === "small" ? 1 : 1.3;
    return {
      fill: roughShape(size.w, size.h, seed, { inset: 2.5, amp: amp * 0.8 }),
      first: roughRect(size.w, size.h, seed, { inset: 2.5, amp, passes: 1 }),
      second: ink ? null : roughRect(size.w, size.h, `${seed}#2`, { inset: 2.5, amp: amp * 1.2, passes: 1 }),
    };
  }, [ink, kind, seed, size]);
  const iconColor = ink ? C.inkText : C.text2;
  const iconSize = kind === "small" ? 13 : compact ? 13 : 15;
  const glyph = busy ? <ActivityIndicator color={iconColor} size="small" /> : <ButtonIcon color={iconColor} size={iconSize} strokeWidth={1.9} />;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onLayout={onLayout}
      onPress={onPress}
      style={(state) => [styles.button, kind === "small" && styles.small, kind === "small" && compact && styles.smallCompact, tall && styles.buttonTall, full && styles.full, !paths && (ink ? styles.inkFallback : styles.outlineFallback), disabled && styles.disabled, state.pressed && styles.pressed, pointer, style]}
    >
      {(state) => (
        <>
          {size && paths ? (
            <Svg height={size.h} style={styles.under} width={size.w}>
              <Path d={paths.fill} fill={ink ? (hovered(state) && !disabled ? C.inkHover : C.ink) : hovered(state) && !disabled ? C.hover : C.card} />
              <Path d={paths.first} fill="none" stroke={C.line} strokeLinecap="round" strokeLinejoin="round" strokeWidth={kind === "small" ? 1.2 : 1.4} />
              {paths.second ? <Path d={paths.second} fill="none" opacity={0.45} stroke={C.line} strokeLinecap="round" strokeLinejoin="round" strokeWidth={0.9} /> : null}
            </Svg>
          ) : null}
          {iconAfter ? null : glyph}
          <Text numberOfLines={1} style={[ink ? styles.inkText : styles.outlineText, kind === "small" && styles.smallText, kind === "small" && compact && styles.smallTextCompact, kind !== "small" && compact && styles.textCompact]}>{label}</Text>
          {iconAfter ? glyph : null}
        </>
      )}
    </Pressable>
  );
}

// 五个按钮排两行：读取三个一行、聊天两个一行。最窄 900 宽时一个按钮也有 95px，四个字放得下，省下的一行留给柱图
function ActionButton({ busy, compact, disabled, icon, label, onPress, seed }: { busy?: boolean; compact: boolean; disabled: boolean; icon: Icon; label: string; onPress: () => void; seed: string }) {
  return <SketchButton busy={busy} compact={compact} disabled={disabled} icon={icon} label={label} onPress={onPress} seed={seed} style={[styles.action, compact && styles.actionCompact]} />;
}

function SketchSwitch({ on }: { on: boolean }) {
  const track = useMemo(() => roughEllipse(19, 11, 16.5, 8.6, "switch-track", { turns: 1.06, jitter: 0.03 }), []);
  const knob = useMemo(() => roughEllipse(8, 8, 5.6, 5.6, "switch-knob", { turns: 1.1, jitter: 0.05 }), []);
  return (
    <View style={styles.switch}>
      <Svg height={22} style={styles.under} width={38}>
        <Path d={track} fill={on ? "#CDEBD7" : C.sunken} stroke={C.line} strokeLinecap="round" strokeWidth={1.2} />
      </Svg>
      <View style={[styles.switchKnob, ease("transform", 250), on && styles.switchKnobOn]}>
        <Svg height={16} width={16}><Path d={knob} fill={on ? C.green : C.pencil} stroke={C.line} strokeWidth={1.1} /></Svg>
      </View>
    </View>
  );
}

// ---------- 标题行里的报告风格 ----------

function StyleOption({ detail, kind, label, on, onPress, size }: { detail: string; kind: AppStyle; label: string; on: boolean; onPress: () => void; size: "small" | "medium" | "large" }) {
  const [box, onLayout] = useSize();
  const [w, h] = size === "large" ? [70, 44] : size === "small" ? [50, 31] : [60, 38];
  const ring = useMemo(() => (box ? roughEllipse(box.w / 2 + RING_X, box.h / 2 + RING_Y, (box.w / 2 + RING_X - 1) / 1.06, (box.h / 2 + RING_Y - 1) / 1.06, `ring-${kind}`, { turns: 1.14, jitter: 0.05 }) : ""), [box, kind]);
  return (
    <Pressable accessibilityLabel={`${label}：${detail}`} accessibilityRole="radio" aria-checked={on} onLayout={onLayout} onPress={onPress} style={(state) => [styles.segment, size === "small" && styles.segmentSmall, hovered(state) && !on && styles.segmentHover, state.pressed && styles.pressed, pointer]}>
      {on && box ? (
        <View key={kind} {...DRAW} style={[styles.ringLayer, { left: -RING_X, top: -RING_Y, width: box.w + RING_X * 2, height: box.h + RING_Y * 2 }]}>
          <Svg height={box.h + RING_Y * 2} width={box.w + RING_X * 2}><Path d={ring} fill="none" stroke={C.red} strokeLinecap="round" strokeWidth={1.8} /></Svg>
        </View>
      ) : null}
      <StylePreview h={h} kind={kind} w={w} />
      <Text numberOfLines={1} style={[styles.segmentText, on && styles.segmentTextOn]}>{label}</Text>
    </Pressable>
  );
}

// 三种报告风格的小样：内容年志是墨夜里一张斜插的卡，档案馆是暗室里的金色星图，海报是新闻纸上的黑块大标题
function StylePreview({ h, kind, w }: { h: number; kind: AppStyle; w: number }) {
  const art = useMemo(() => {
    const frame = roughShape(w, h, `pv-${kind}`, { inset: 1.5, amp: 0.7 });
    const border = roughRect(w, h, `pv-${kind}`, { inset: 1.5, amp: 0.8, passes: 1 });
    const block = (x: number, y: number, bw: number, bh: number, seed: string) => roughShape(bw * w, bh * h, seed, { inset: 0, amp: 0.5, x: x * w, y: y * h });
    if (kind === "trace") {
      const rand = seeded("pv-stars");
      const stars = Array.from({ length: 8 }, (_, index) => ({ key: index, cx: 5 + rand() * (w - 10), cy: 4 + rand() * h * 0.42, r: 0.55 + rand() * 0.55 }));
      return { bg: "#1E2437", frame, border, parts: [
        ...stars.map((star) => <Circle key={`s${star.key}`} cx={star.cx} cy={star.cy} fill="#F5E9C6" r={star.r} />),
        <Path key="card" d={tilted(w * 0.52, h * 0.6, w * 0.36, h * 0.5, -10)} fill="rgba(255,255,255,.14)" stroke="#EEA44E" strokeWidth={1.1} />,
        <Path key="line" d={roughLine(w * 0.42, h * 0.64, w * 0.6, h * 0.6, "pv-trace-line", { amp: 0.3 })} fill="none" stroke="#F5E9C6" strokeWidth={0.9} />,
      ] };
    }
    if (kind === "archive") {
      // 暗室里一张星图：金色刻度圈、一颗四角星、左边一行细金字
      const cx = w * 0.64, cy = h * 0.5, r = Math.min(w, h) * 0.3;
      const star = (x: number, y: number, s: number) => `M${x} ${y - s}C${x + s * 0.09} ${y - s * 0.16} ${x + s * 0.16} ${y - s * 0.09} ${x + s} ${y}C${x + s * 0.16} ${y + s * 0.09} ${x + s * 0.09} ${y + s * 0.16} ${x} ${y + s}C${x - s * 0.09} ${y + s * 0.16} ${x - s * 0.16} ${y + s * 0.09} ${x - s} ${y}C${x - s * 0.16} ${y - s * 0.09} ${x - s * 0.09} ${y - s * 0.16} ${x} ${y - s}Z`;
      return { bg: "#15181A", frame, border, parts: [
        <Circle key="ring" cx={cx} cy={cy} fill="none" r={r} stroke="#C59861" strokeWidth={0.9} />,
        <Circle key="dots" cx={cx} cy={cy} fill="none" r={r * 0.62} stroke="#6E8C8F" strokeDasharray="0.6 2.2" strokeLinecap="round" strokeWidth={1} />,
        <Path key="star" d={star(cx - r * 0.3, cy - r * 0.34, r * 0.34)} fill="#E3C8A6" />,
        <Path key="t1" d={roughLine(w * 0.12, h * 0.36, w * 0.36, h * 0.36, "pv-a-t1", { amp: 0.2 })} fill="none" stroke="#E3C8A6" strokeWidth={1.6} />,
        <Path key="t2" d={roughLine(w * 0.12, h * 0.5, w * 0.3, h * 0.5, "pv-a-t2", { amp: 0.2 })} fill="none" stroke="rgba(207,193,176,.55)" strokeWidth={0.9} />,
        <Path key="t3" d={roughLine(w * 0.12, h * 0.62, w * 0.26, h * 0.62, "pv-a-t3", { amp: 0.2 })} fill="none" stroke="rgba(207,193,176,.55)" strokeWidth={0.9} />,
      ] };
    }
    return { bg: "#EFE6D4", frame, border, parts: [
      <Path key="h1" d={block(0.1, 0.16, 0.54, 0.18, "pv-p-h1")} fill="#17130F" />,
      <Path key="h2" d={block(0.1, 0.4, 0.4, 0.12, "pv-p-h2")} fill="#17130F" />,
      <Path key="or" d={block(0.7, 0.16, 0.2, 0.36, "pv-p-or")} fill="#EF6A1E" />,
      ...[0.66, 0.76, 0.86].map((y, index) => <Path key={`l${index}`} d={roughLine(w * 0.1, h * y, w * (index === 2 ? 0.62 : 0.9), h * y, `pv-p-l${index}`, { amp: 0.3 })} fill="none" stroke="rgba(23,19,15,.55)" strokeWidth={0.9} />),
    ] };
  }, [h, kind, w]);
  return (
    <Svg height={h} width={w}>
      <Path d={art.frame} fill={art.bg} />
      {art.parts}
      <Path d={art.border} fill="none" stroke={C.line} strokeLinecap="round" strokeWidth={1.1} />
    </Svg>
  );
}

function tilted(cx: number, cy: number, w: number, h: number, degrees: number): string {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const).map(([x, y]) => `${(cx + x * cos - y * sin).toFixed(1)} ${(cy + x * sin + y * cos).toFixed(1)}`);
  return `M${corners.join("L")}Z`;
}

// ---------- 数据流向图 ----------

const FLOW_NODES: ReadonlyArray<{ label: string; archiveLabel: string; icon: Icon; archiveIcon: Icon }> = [
  { label: "抖音网页", archiveLabel: "档案文件", icon: Globe, archiveIcon: FileArchive },
  { label: "本机采集器", archiveLabel: "本机解析", icon: HardDrive, archiveIcon: HardDrive },
  { label: "本地记录", archiveLabel: "本地记录", icon: NotebookPen, archiveIcon: NotebookPen },
  { label: "报告", archiveLabel: "报告", icon: BookOpen, archiveIcon: BookOpen },
];

function FlowDiagram({ archive, compact, done, note, step }: { archive: boolean; compact: boolean; done: boolean[]; note: string; step: number }) {
  return (
    <View accessibilityLabel={`数据流向：${FLOW_NODES.map((node) => (archive ? node.archiveLabel : node.label)).join(" → ")}，现在在「${archive ? FLOW_NODES[step]?.archiveLabel : FLOW_NODES[step]?.label}」这一步，${note}`} style={styles.flow}>
      {FLOW_NODES.map((node, index) => {
        const reached = index <= step || Boolean(done[index]);
        return (
          <React.Fragment key={node.label}>
            {index > 0 ? <FlowArrow compact={compact} reached={Boolean(done[index - 1])} seed={`flow-arrow-${index}`} /> : null}
            <FlowNode compact={compact} current={index === step} done={Boolean(done[index])} icon={archive ? node.archiveIcon : node.icon} label={archive ? node.archiveLabel : node.label} note={note} reached={reached} seed={`flow-node-${index}`} />
          </React.Fragment>
        );
      })}
    </View>
  );
}

// 圈注比被圈的东西大一圈：圈画在一个向外扩出 RING_X / RING_Y 的层里，不占布局
const RING_X = 9;
const RING_Y = 6;

function FlowNode({ compact, current, done, icon: NodeIcon, label, note, reached, seed }: { compact: boolean; current: boolean; done: boolean; icon: Icon; label: string; note: string; reached: boolean; seed: string }) {
  const [size, onLayout] = useSize();
  const ring = useMemo(() => (size && current ? roughEllipse(size.w / 2 + RING_X, size.h / 2 + RING_Y, (size.w / 2 + RING_X - 1) / 1.07, (size.h / 2 + RING_Y - 1) / 1.07, `${seed}-ring`, { turns: 1.14, jitter: 0.05 }) : ""), [current, seed, size]);
  const check = useMemo(() => roughCheck(1, 1, 11, `${seed}-check`), [seed]);
  const color = reached ? C.text : C.faint;
  return (
    <View style={[styles.flowNode, compact && styles.flowNodeCompact]}>
      <View onLayout={onLayout} style={styles.flowNodeRow}>
        {current && size ? (
          <View key={note} {...DRAW} style={[styles.ringLayer, { left: -RING_X, top: -RING_Y, width: size.w + RING_X * 2, height: size.h + RING_Y * 2 }]}>
            <Svg height={size.h + RING_Y * 2} width={size.w + RING_X * 2}><Path d={ring} fill="none" stroke={C.red} strokeLinecap="round" strokeWidth={1.8} /></Svg>
          </View>
        ) : null}
        {compact ? null : <NodeIcon color={color} size={15} strokeWidth={1.8} />}
        <Hand numberOfLines={1} style={[styles.flowLabel, compact && styles.flowLabelCompact, { color }]}>{label}</Hand>
        {done ? <Svg height={13} width={13}><Path d={check} fill="none" stroke={C.green} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} /></Svg> : null}
      </View>
      {current && !compact ? <Hand numberOfLines={1} style={styles.flowNote}>{note}</Hand> : null}
    </View>
  );
}

function FlowArrow({ compact, reached, seed }: { compact: boolean; reached: boolean; seed: string }) {
  const w = compact ? 18 : 26;
  const path = useMemo(() => roughArrow(2, 8, w - 2, 7, seed, { bend: 2.5, head: 5 }), [seed, w]);
  return <Svg height={14} style={styles.flowArrow} width={w}><Path d={path} fill="none" stroke={reached ? C.line : C.pencil} strokeDasharray={reached ? undefined : "3 3"} strokeLinecap="round" strokeWidth={1.3} /></Svg>;
}

// ---------- 卡片内容 ----------

/** 报错：左边一道红笔竖线，像在页边批注。 */
function ErrorNote({ lines, text }: { lines?: number; text: string }) {
  const [size, onLayout] = useSize();
  const path = useMemo(() => (size ? roughLine(3, 2, 3, size.h - 2, "error-rule", { passes: 2, amp: 1.2 }) : ""), [size]);
  return (
    <View onLayout={onLayout} style={styles.error}>
      {size ? <Svg height={size.h} style={styles.errorRule} width={6}><Path d={path} fill="none" stroke={C.red} strokeLinecap="round" strokeWidth={1.6} /></Svg> : null}
      <Hand style={styles.errorTitle}>连接或读取失败</Hand>
      <Text numberOfLines={lines} style={styles.errorText}>{text}</Text>
    </View>
  );
}

// 卡头：手绘圈里写序号（完成后打勾）或图标 + 手写标题 + 一行说明，右边可挂一条小字
function CardHead({ aside, detail, detailLines, done, icon: HeadIcon, index, plainTitle, size, title }: { aside?: string; detail: string; detailLines?: number; done: boolean; icon?: Icon; index?: string; plainTitle?: boolean; size: "small" | "medium" | "large"; title: string }) {
  const circle = useMemo(() => roughEllipse(14, 14, 11.5, 11.5, `badge-${index ?? title}`, { turns: 1.12, jitter: 0.05 }), [index, title]);
  const check = useMemo(() => roughCheck(7, 7, 14, `badge-check-${index ?? title}`), [index, title]);
  return (
    <View style={styles.cardHead}>
      <View style={styles.badge}>
        <Svg height={28} style={styles.under} width={28}>
          <Path d={circle} fill={done ? "#DDF0E3" : "none"} stroke={done ? C.green : C.line} strokeLinecap="round" strokeWidth={1.4} />
          {done ? <Path d={check} fill="none" stroke={C.green} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} /> : null}
        </Svg>
        {done ? null : HeadIcon ? <HeadIcon color={C.text2} size={13} strokeWidth={1.8} /> : <Hand style={styles.badgeText}>{index}</Hand>}
      </View>
      <View style={styles.flex}>
        <View style={styles.cardTitleRow}>
          {plainTitle
            ? <Text numberOfLines={2} style={styles.cardTitlePlain}>{title}</Text>
            : <Hand numberOfLines={1} style={[styles.cardTitle, size === "small" && styles.cardTitleSmall, size === "large" && styles.cardTitleLarge]}>{title}</Hand>}
          {aside ? <Text numberOfLines={1} style={styles.fine}>{aside}</Text> : null}
        </View>
        <Text numberOfLines={detailLines} style={styles.meta}>{detail}</Text>
      </View>
    </View>
  );
}

// 位数多的数字缩一点字号，窄窗口里四个数并排也放得下
function digits(value: number, size: "small" | "medium" | "large"): { fontSize: number; lineHeight: number } | null {
  const length = value.toLocaleString("zh-CN").length;
  const base = size === "small" ? 27 : size === "large" ? 38 : 32;
  const scale = length <= 4 ? 1 : length === 5 ? (size === "small" ? 0.86 : 0.94) : size === "small" ? 0.74 : 0.84;
  return scale === 1 ? null : { fontSize: Math.round(base * scale), lineHeight: Math.round(base * 1.18) };
}

function Count({ icon: CountIcon, label, size, value }: { icon: Icon; label: string; size: "small" | "medium" | "large"; value: number }) {
  const shown = useCountUp(value);
  return (
    <View style={styles.count}>
      <Hand numberOfLines={1} style={[styles.countValue, size === "small" && styles.countValueSmall, size === "large" && styles.countValueLarge, digits(value, size)]}>{shown.toLocaleString("zh-CN")}</Hand>
      <View style={styles.countLabel}><CountIcon color={C.muted} size={12} strokeWidth={1.8} /><Text numberOfLines={1} style={styles.meta}>{label}</Text></View>
    </View>
  );
}

/** 一排手绘柱子：斜线填充，重点那根用红笔，零值在底线上点一下。 */
function BarSketch({ height, highlight, seed, top, values, width }: { height: number; highlight: number; seed: string; top: number; values: number[]; width: number }) {
  const paths = useMemo(() => {
    const max = Math.max(1, ...values);
    const slot = width / values.length;
    const barW = Math.max(3, Math.min(slot * 0.64, 18));
    let outline = "";
    let fill = "";
    let peak = "";
    let peakFill = "";
    let dots = "";
    values.forEach((value, index) => {
      const x = index * slot + (slot - barW) / 2;
      if (value === 0) {
        dots += roughLine(x + barW / 2 - 1.2, height - 1, x + barW / 2 + 1.2, height - 1.4, `${seed}-dot-${index}`, { amp: 0.2 });
        return;
      }
      const bh = Math.max(3, ((height - top) * value) / max);
      const y = height - bh;
      const box = roughRect(barW, bh, `${seed}-bar-${index}`, { inset: 0, amp: 0.7, passes: 1, x, y });
      const hatch = hachure(x + 0.8, y + 0.8, barW - 1.6, bh - 1.2, `${seed}-hatch-${index}`, 3);
      if (index === highlight) {
        peak += box;
        peakFill += hatch;
      } else {
        outline += box;
        fill += hatch;
      }
    });
    return { outline, fill, peak, peakFill, dots, base: roughLine(0, height, width, height, `${seed}-base`, { amp: 1 }) };
  }, [height, highlight, seed, top, values, width]);
  return (
    <Svg height={height + 2} width={width}>
      <Path d={paths.fill} fill="none" opacity={0.7} stroke={C.line} strokeWidth={0.9} />
      <Path d={paths.outline} fill="none" stroke={C.line} strokeLinejoin="round" strokeWidth={1.1} />
      <Path d={paths.peakFill} fill="none" opacity={0.85} stroke={C.red} strokeWidth={0.9} />
      <Path d={paths.peak} fill="none" stroke={C.red} strokeLinejoin="round" strokeWidth={1.3} />
      <Path d={paths.dots} fill="none" stroke={C.pencil} strokeLinecap="round" strokeWidth={1.2} />
      <Path d={paths.base} fill="none" stroke={C.line} strokeLinecap="round" strokeWidth={1.3} />
    </Svg>
  );
}

/** 带标题、红笔标注和日期刻度的一张小柱图。 */
function BarChart({ axis, height, highlight, note, peakLabel, seed, title, values, width }: { axis: string[]; height: number; highlight: number; note: string; peakLabel: string; seed: string; title: string; values: number[]; width: number }) {
  const barsH = height - CHART_HEAD - CHART_AXIS;
  const slot = width / values.length;
  const peakX = highlight * slot + slot / 2;
  // 柱子够高才把红字写在最高那根上面（要让出 18px）；矮的时候红字挪到标题行，柱子占满高度
  const labelAbove = highlight >= 0 && barsH >= 64;
  return (
    <View style={{ height, width }}>
      <View style={styles.chartHead}>
        <Text numberOfLines={1} style={[styles.chartTitle, styles.flex]}>{title}</Text>
        {/* 标题行里放不下三样时，先让出小字说明，保住标题和红字 */}
        {labelAbove || highlight < 0 || width >= 380 ? <Text numberOfLines={1} style={styles.fine}>{note}</Text> : null}
        {highlight >= 0 && !labelAbove ? <Hand numberOfLines={1} style={styles.peakInline}>{peakLabel}</Hand> : null}
      </View>
      <View style={{ height: barsH, width }}>
        <BarSketch height={barsH} highlight={highlight} seed={seed} top={labelAbove ? 18 : 2} values={values} width={width} />
        {labelAbove ? <Hand numberOfLines={1} style={[styles.peakLabel, { left: Math.max(0, Math.min(width - 110, peakX - 55)) }]}>{peakLabel}</Hand> : null}
      </View>
      <View style={styles.axis}>{axis.map((label, index) => <Hand key={`${label}-${index}`} style={styles.axisText}>{label}</Hand>)}</View>
    </View>
  );
}

const CHART_HEAD = 22;
const CHART_AXIS = 20;

/** 卡片中间的数据区：按天的柱图；地方够就再加一张「一天里几点最多」。空数据画一张铅笔虚线的草图占位。 */
function RecordSketches({ digest, roomy, size }: { digest: RecordDigest; roomy: boolean; size: Size }) {
  const length = size.w >= 320 ? 30 : 14;
  const win = useMemo(() => dayWindow(digest, length), [digest, length]);
  const hours = digest.perHour;
  const hourPeak = useMemo(() => hours.reduce((best, value, index) => (value > (hours[best] ?? 0) ? index : best), 0), [hours]);
  if (!win) {
    // 空的时候照着有数据时的版面打草稿：按天一张，地方够再加一张按钟点的
    const text = digest.total ? "读到的记录都没有日期，画不出按天的条数。" : "还没有带日期的记录。读取之后，这里会按天画出条数。";
    const ghostHourH = size.h >= 300 ? (roomy ? 150 : 124) : 0;
    const ghostDayH = Math.min(size.h - ghostHourH - (ghostHourH ? 22 : 0), roomy ? 300 : 250);
    return (
      <View style={[styles.sketches, { height: size.h }]}>
        <GhostChart height={ghostDayH} seed="chart-ghost" text={text} width={size.w} />
        {ghostHourH ? <View style={{ marginTop: 22 }}><GhostChart bars={24} height={ghostHourH} seed="hour-ghost" text={digest.total ? "也排不出一天里各个钟点的分布。" : "还会画出一天里各个钟点的记录。"} width={size.w} /></View> : null}
      </View>
    );
  }
  const firstDay = win.days[0]!.day;
  const midDay = win.days[Math.floor(win.days.length / 2)]!.day;
  const lastDay = win.days[win.days.length - 1]!.day;
  const title = win.endsToday ? `最近 ${win.days.length} 天每天的记录` : `到 ${formatLongDay(lastDay)}为止的 ${win.days.length} 天`;
  const summary = !win.sum ? "这段时间没有记录" : win.activeDays === win.days.length ? `${win.days.length} 天里天天都有记录` : `${win.days.length} 天里有 ${win.activeDays} 天有记录`;
  const minBars = 22;
  if (size.h < CHART_HEAD + CHART_AXIS + minBars) {
    return size.h >= 20 ? <Text numberOfLines={1} style={[styles.meta, styles.chartLine]}>{`${summary}${win.max ? `，最多的一天 ${win.max} 条` : ""}。`}</Text> : null;
  }
  const hourH = size.h >= 300 ? (roomy ? 150 : 124) : 0;
  const gap = hourH ? 22 : 0;
  const dayH = Math.min(size.h - hourH - gap, roomy ? 300 : 250);
  return (
    <View style={[styles.sketches, { height: size.h }]}>
      <BarChart axis={[formatDay(firstDay), formatDay(midDay), win.endsToday ? "今天" : formatDay(lastDay)]} height={dayH} highlight={win.max ? win.maxIndex : -1} note={summary} peakLabel={`最多 ${win.max} 条`} seed="day" title={title} values={win.days.map((day) => day.count)} width={size.w} />
      {hourH ? <View style={{ marginTop: gap }}><BarChart axis={["0 点", "6 点", "12 点", "18 点", "23 点"]} height={hourH} highlight={hours[hourPeak] ? hourPeak : -1} note={hours[hourPeak] ? `${hourName(hourPeak)}最多` : ""} peakLabel={`${hours[hourPeak] ?? 0} 条`} seed="hour" title="一天里各个钟点的记录" values={hours} width={size.w} /></View> : null}
    </View>
  );
}

function hourName(hour: number): string {
  if (hour < 6) return `凌晨 ${hour} 点`;
  if (hour < 12) return `上午 ${hour} 点`;
  if (hour === 12) return "中午 12 点";
  if (hour < 18) return `下午 ${hour - 12} 点`;
  return `晚上 ${hour - 12} 点`;
}

/** 空数据时的占位草图：铅笔淡淡打的几根柱子（还没上墨），上面贴一句说明。 */
function GhostChart({ bars, height: h, seed, text, width }: { bars?: number; height: number; seed: string; text: string; width: number }) {
  const paths = useMemo(() => {
    if (h < 50) return null;
    const rand = seeded(seed);
    const count = bars ?? (width >= 320 ? 14 : 9);
    const slot = width / count;
    let outline = "";
    let fill = "";
    for (let index = 0; index < count; index += 1) {
      // 起伏做成一条缓坡再加点抖，像随手打的草稿，不像真数据
      const bh = (0.3 + 0.35 * Math.sin(index * 0.7 + 1) ** 2 + rand() * 0.25) * (h - 14);
      const x = index * slot + slot * 0.2;
      outline += roughRect(slot * 0.6, bh, `${seed}-${index}`, { inset: 0, amp: 0.8, passes: 1, x, y: h - 2 - bh });
      fill += hachure(x + 1, h - 1 - bh, slot * 0.6 - 2, bh - 2, `${seed}-h-${index}`, 5);
    }
    return { outline, fill, base: roughLine(0, h - 1, width, h - 1, `${seed}-base`, { amp: 1 }) };
  }, [bars, h, seed, width]);
  if (!paths) return h >= 20 ? <Text numberOfLines={2} style={[styles.meta, styles.chartLine]}>{text}</Text> : null;
  return (
    <View style={[styles.ghost, { height: h }]}>
      <Svg height={h} style={styles.under} width={width}>
        <Path d={paths.fill} fill="none" opacity={0.28} stroke={C.pencil} strokeWidth={0.9} />
        <Path d={paths.outline} fill="none" opacity={0.55} stroke={C.pencil} strokeLinejoin="round" strokeWidth={1} />
        <Path d={paths.base} fill="none" stroke={C.pencil} strokeLinecap="round" strokeWidth={1.2} />
      </Svg>
      <SketchBox amp={1} fill={C.card} passes={1} seed={`${seed}-label`} stroke={C.pencil} style={styles.ghostLabel}><Text numberOfLines={3} style={styles.emptyText}>{text}</Text></SketchBox>
    </View>
  );
}

const KIND_META: Record<SetupRecordKind, { label: string; icon: Icon }> = {
  watch: { label: "看过", icon: Eye },
  liked: { label: "喜欢", icon: Heart },
  favorite: { label: "收藏", icon: BookmarkIcon },
};

/** 最近的几条记录：按发生时间倒序，放得下几条列几条。 */
function RecentList({ digest, size }: { digest: RecordDigest; size: Size }) {
  const headH = 30;
  const rowH = 25;
  if (!digest.recent.length) {
    return <GhostList seed="recent-ghost" size={size} text={digest.total ? "这些记录没有日期，排不出先后。" : "读到记录以后，最近的几条会列在这里。"} />;
  }
  const rows = Math.min(digest.recent.length, Math.floor((size.h - headH) / rowH));
  if (rows < 1) return null;
  return (
    <View style={styles.recent}>
      <View style={styles.recentHead}>
        <Hand style={styles.recentTitle}>最近的记录</Hand>
        <Text style={styles.fine}>按发生时间</Text>
      </View>
      {digest.recent.slice(0, rows).map((item) => {
        const meta = KIND_META[item.kind];
        const KindIcon = meta.icon;
        return (
          <View key={item.id} accessibilityLabel={`${meta.label}：${item.title}`} style={styles.recentRow}>
            <KindIcon color={C.muted} size={12} strokeWidth={1.8} />
            <Text numberOfLines={1} style={styles.recentText}>{item.title}</Text>
            <Hand numberOfLines={1} style={styles.recentTime}>{formatWhen(item.at)}</Hand>
          </View>
        );
      })}
    </View>
  );
}

/** 空列表的占位：几行铅笔涂的横线，上面贴一句说明。 */
function GhostList({ seed, size, text }: { seed: string; size: Size; text: string }) {
  const rows = Math.max(0, Math.min(12, Math.floor((size.h - 8) / 25)));
  const path = useMemo(() => {
    const rand = seeded(seed);
    let d = "";
    for (let index = 0; index < rows; index += 1) {
      const y = 14 + index * 25;
      d += roughEllipse(6, y, 3.4, 3.4, `${seed}-dot-${index}`, { turns: 1.05, jitter: 0.08 });
      d += roughLine(18, y, 18 + (0.35 + rand() * 0.5) * (size.w - 70), y, `${seed}-line-${index}`, { amp: 1.2 });
      d += roughLine(size.w - 34, y, size.w - 4, y, `${seed}-time-${index}`, { amp: 0.6 });
    }
    return d;
  }, [rows, seed, size.w]);
  if (rows < 2) return size.h >= 20 ? <Text numberOfLines={2} style={[styles.meta, styles.chartLine]}>{text}</Text> : null;
  return (
    <View style={[styles.ghost, { height: rows * 25 + 6 }]}>
      <Svg height={rows * 25 + 6} style={styles.under} width={size.w}><Path d={path} fill="none" opacity={0.5} stroke={C.pencil} strokeLinecap="round" strokeWidth={1.1} /></Svg>
      <SketchBox amp={1} fill={C.card} passes={1} seed={`${seed}-label`} stroke={C.pencil} style={styles.ghostLabel}><Text numberOfLines={3} style={styles.emptyText}>{text}</Text></SketchBox>
    </View>
  );
}

type Note = { key: string; title: string; body: string; color: string; tilt: number };

function tipNotes(state: { fromArchive: boolean; connected: boolean; loginNeeded: boolean; syncing: boolean; ready: boolean; autoSyncEnabled: boolean }): Note[] {
  const tip = state.fromArchive
    ? { title: "用的是导入的文件", body: state.connected ? "报告和工作台都用这份文件。想换回采集器的数据，点右边的「移除」就行。" : "报告和工作台都用这份文件，关掉应用后要重新导入。" }
    : state.loginNeeded
      ? { title: "要先登录抖音", body: "在弹出的浏览器窗口里登录，登录好以后回来点「增量读取」。" }
      : !state.connected
        ? { title: "第一次用？", body: "点「连接采集器」，配对码会自动填好。第一次连接会弹出一个浏览器窗口，在里面登录抖音就行。" }
        : state.syncing
          ? { title: "正在读取", body: "随时可以点「正在读取」停下，已经读到的会先存好；聊天照常接收。" }
          : state.ready
            ? { title: "可以打开报告了", body: state.autoSyncEnabled ? "右上角「打开报告」看这些记录。应用回到前台时会自动补读新的记录。" : "右上角「打开报告」看这些记录。自动读取已暂停，想更新就点「增量读取」。" }
            : { title: "连上了，下一步读取", body: "「增量读取」在后台读最近的记录，不弹窗口；「完整读取」会从头翻一遍，要久一些。" };
  return [
    { key: "tip", ...tip, color: C.noteYellow, tilt: -1.2 },
    { key: "privacy", title: "只存在这台电脑上", body: "采集器只在本机运行，读到的记录都存在这台电脑里，不上传。", color: C.noteBlue, tilt: 0.9 },
    { key: "carry", title: "换电脑怎么带走", body: "先「导出数据」存成文件，到新电脑上「选择文件」导入，再「并入本机记录」。", color: C.notePink, tilt: -0.6 },
  ];
}

/** 便签：按剩下的高度估算能贴几张（估行数：一行约放 宽÷字号 个字）。 */
function NoteStack({ error, notes, roomy, size }: { error: string | null; notes: Note[]; roomy: boolean; size: Size }) {
  const font = roomy ? 13 : 12.5;
  const line = roomy ? 20 : 19;
  const inner = size.w - 16 - 24;
  // 报错按剩下的高度决定写几行（汉字按 12px、西文数字按 7px 估宽），最多 8 行；写不下的才省略
  let errorLines = 0;
  if (error) {
    const textW = Array.from(error).reduce((sum, char) => sum + (char.charCodeAt(0) < 0x2000 ? 7 : 12), 0);
    const need = Math.ceil(textW / Math.max(60, size.w - 12));
    errorLines = Math.max(1, Math.min(need, 8, Math.floor((size.h - ERROR_HEAD) / 18)));
  }
  const sized = notes.map((note) => {
    const lines = Math.ceil((note.body.length * font) / Math.max(60, inner));
    return { note, lines, height: 16 + 26 + lines * line + 14 };
  });
  const shown: typeof sized = [];
  let used = error ? ERROR_HEAD + errorLines * 18 + 12 : 0;
  for (const item of sized) {
    const next = used + item.height + (shown.length ? 12 : 0);
    if (next > size.h - 8) break;
    shown.push(item);
    used = next;
  }
  if (!shown.length && !error) return null;
  return (
    <View>
      {error ? <ErrorNote lines={errorLines} text={error} /> : null}
      {shown.length ? (
        <View style={[styles.notes, error ? styles.notesAfterError : null]}>
          {shown.map(({ lines, note }, index) => (
            <View key={note.key} style={[styles.note, { backgroundColor: note.color, transform: [{ rotate: `${note.tilt}deg` }] }, index > 0 && styles.noteGap]}>
              <View style={styles.noteTape} />
              <Hand numberOfLines={1} style={styles.noteTitle}>{note.title}</Hand>
              <Text numberOfLines={lines + 1} style={[styles.noteBody, { fontSize: font, lineHeight: line }]}>{note.body}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// 报错块除正文外的高度：手写标题 22 + 间距
const ERROR_HEAD = 24;

function hovered(state: unknown): boolean {
  return Boolean((state as PressState).hovered);
}

// 手绘进度条：铅笔框 + 蓝笔斜线填到当前进度；总数未知时画一段静止的条，不做来回滑动
function SketchProgress({ percent, seed }: { percent: number | null; seed: string }) {
  const [size, onLayout] = useSize();
  const paths = useMemo(() => {
    if (!size) return null;
    const filled = Math.max(0, (size.w - 4) * ((percent ?? 35) / 100));
    return { box: roughRect(size.w, 10, seed, { inset: 1, amp: 0.6, passes: 1 }), fill: hachure(2, 2, filled, 6, `${seed}-fill`, 2.6) };
  }, [percent, seed, size]);
  return (
    <View onLayout={onLayout} style={styles.track}>
      {size && paths ? (
        <Svg height={10} width={size.w}>
          <Path d={paths.fill} fill="none" stroke={C.blue} strokeWidth={1.2} />
          <Path d={paths.box} fill="none" stroke={C.line} strokeLinecap="round" strokeWidth={1} />
        </Svg>
      ) : null}
    </View>
  );
}

function ChatProgress({ progress }: { progress: CollectorStatus["progress"] }) {
  if (!progress) return null;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;
  return (
    <View
      accessibilityLabel="聊天全量读取进度"
      accessibilityRole="progressbar"
      accessibilityValue={progress.total > 0 ? { min: 0, max: progress.total, now: progress.current } : undefined}
      style={styles.progress}
    >
      <Text numberOfLines={1} style={styles.meta}>聊天历史整理</Text>
      <View style={styles.flex}><SketchProgress percent={percent} seed="chat-progress" /></View>
      <Hand numberOfLines={1} style={styles.progressValue}>{progress.total > 0 ? `会话 ${progress.current}/${progress.total}` : "正在读取会话列表"}</Hand>
    </View>
  );
}

function AppUpdatePanel({
  busy,
  compact,
  onCheck,
  onDownload,
  onInstall,
  short,
  state,
  tight,
}: {
  busy: boolean;
  compact: boolean;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  short: boolean;
  state: DesktopUpdateState;
  tight: boolean;
}) {
  const checking = state.phase === "checking";
  const downloading = state.phase === "downloading";
  const action = state.phase === "available"
    ? { label: state.manualDownload ? "去下载" : "下载更新", icon: Download, onPress: onDownload, disabled: false }
    : state.phase === "downloaded"
      ? { label: busy ? "采集完成后安装" : "重启并安装", icon: RefreshCw, onPress: onInstall, disabled: busy }
      : state.phase === "unsupported"
        ? null
        : { label: state.phase === "error" ? "重试检查" : "检查更新", icon: RefreshCw, onPress: onCheck, disabled: checking || downloading };
  const percent = state.progress === null ? null : Math.round(Math.max(0, Math.min(100, state.progress)));
  const fresh = state.version && state.phase !== "up-to-date";
  return (
    <View style={[styles.update, short && styles.updateShort]}>
      <HRule seed="update-rule" color={C.pencil} style={styles.updateRule} />
      <View style={styles.updateHead}>
        <View style={styles.flex}>
          <View style={styles.updateTitleRow}><Hand style={styles.updateTitle}>应用更新</Hand>{fresh ? <Hand style={styles.updateBadge}>有新版!</Hand> : null}</View>
          <Text style={styles.fine}>当前 v{state.currentVersion}</Text>
        </View>
        {action ? <SketchButton accessibilityLabel={action.label} busy={checking || downloading} compact={compact} disabled={action.disabled} icon={action.icon} kind="small" label={action.label} onPress={() => void action.onPress()} seed="update-action" /> : null}
      </View>
      <Text numberOfLines={tight ? 1 : 2} style={styles.meta}>{state.message}</Text>
      {fresh ? <Text numberOfLines={1} style={styles.updateTarget}>目标版本 v{state.version}{state.releaseName ? ` · ${state.releaseName}` : ""}</Text> : null}
      {state.error ? <Text numberOfLines={tight ? 1 : 2} style={styles.updateError}>{state.error}</Text> : null}
      {percent !== null && (downloading || state.phase === "downloaded") ? <View accessibilityLabel={`更新下载进度 ${percent}%`} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}><SketchProgress percent={percent} seed="update-progress" /></View> : null}
    </View>
  );
}

function BookmarkIcon({ color: iconColor, size, strokeWidth }: { color?: string; size?: number; strokeWidth?: number }) { return <Bookmark color={iconColor} size={size} strokeWidth={strokeWidth} />; }
function formatDate(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : value; }
function formatDay(time: number): string {
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
// 「2025 年 8 月 1 日」；今年的日期省掉年份，除非明确要带
function formatLongDay(time: number, withYear = false): string {
  const date = new Date(time);
  const year = withYear || date.getFullYear() !== new Date().getFullYear() ? `${date.getFullYear()} 年 ` : "";
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
// 今天的写几点几分，昨天写「昨天」，今年的写月/日，更早的带上年份
function formatWhen(time: number): string {
  const date = new Date(time);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= today) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (time >= today - 86_400_000) return "昨天";
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: "100%", backgroundColor: C.paper },
  // 手绘底图垫在内容下面：RN-web 的 View 都是 z-index:0 的层叠上下文，-1 只会沉到兄弟元素（图标、输入框）底下，不会掉出卡片
  under: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: -1, pointerEvents: "none" }, flex: { flex: 1, minWidth: 0 }, row8: { flexDirection: "row", gap: 10 }, hidden: { opacity: 0 },
  hand: { fontFamily: HAND, color: C.text, fontWeight: "500", paddingHorizontal: 2 },
  // 字：手写标题 / 正文粗 / 说明 / 细则
  strong: { color: C.text, fontSize: 13, fontWeight: "600" }, meta: { color: C.muted, fontSize: 12, lineHeight: 18 }, fine: { color: C.faint, fontSize: 11, lineHeight: 16, fontVariant: ["tabular-nums"] },
  topbar: { height: 56, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 24 }, topbarNarrow: { height: 52, paddingHorizontal: 14 },
  topRule: { position: "absolute", left: 10, right: 10, bottom: -2 },
  brand: { minWidth: 180, flexDirection: "row", alignItems: "center", gap: 10 }, mark: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  brandName: { fontSize: 24, lineHeight: 30 }, brandNameNarrow: { fontSize: 21, lineHeight: 26 },
  topStatus: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, statusText: { flexShrink: 1, color: C.muted, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.faint }, dotOn: { backgroundColor: C.green },
  // 按钮只有两种：墨水填满的主按钮、手绘描边的次按钮（小号用在档案卡）
  button: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 15 }, buttonTall: { minHeight: 38 }, full: { alignSelf: "stretch" },
  inkFallback: { backgroundColor: C.ink, borderRadius: 6 }, outlineFallback: { backgroundColor: C.card, borderRadius: 6 },
  inkText: { color: C.inkText, fontSize: 13, fontWeight: "600" }, outlineText: { flexShrink: 1, color: C.text, fontSize: 13, fontWeight: "500" }, textCompact: { fontSize: 12 },
  scroll: { flex: 1, minHeight: 0 }, scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 18, paddingBottom: 22 }, scrollContentShort: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14 }, scrollContentNarrow: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  page: { flex: 1, width: "100%", maxWidth: 1640, alignSelf: "center", gap: 14 }, pageShort: { gap: 10 },
  header: { flexDirection: "row", alignItems: "center", gap: 16 },
  titleRow: { flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap" },
  title: { fontSize: 34, lineHeight: 42 }, titleRoomy: { fontSize: 40, lineHeight: 50 }, titleShort: { fontSize: 30, lineHeight: 38 }, titleTight: { fontSize: 27, lineHeight: 34 },
  styleBlock: { flexDirection: "row", alignItems: "center", gap: 6 },
  styleLabel: { alignItems: "flex-end" }, styleLabelText: { fontSize: 20, lineHeight: 22, color: C.text2 },
  segments: { flexDirection: "row", gap: 2 },
  segment: { alignItems: "center", gap: 3, paddingHorizontal: 10, paddingTop: 7, paddingBottom: 6 }, segmentSmall: { paddingHorizontal: 7, paddingTop: 5, paddingBottom: 4, gap: 2 }, segmentHover: { transform: [{ translateY: -2 }] },
  segmentText: { color: C.muted, fontSize: 12, lineHeight: 16, fontWeight: "500" }, segmentTextOn: { color: C.text, fontWeight: "700" },
  statusBar: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 8 }, statusBarNarrow: { gap: 8, paddingHorizontal: 10, paddingVertical: 6 },
  statusCopy: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }, statusCopyNarrow: { gap: 8 },
  statusTitle: { fontSize: 21, lineHeight: 26, flexShrink: 0 },
  flow: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  flowNode: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 }, flowNodeCompact: { paddingHorizontal: 10 },
  flowNodeRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  flowLabel: { fontSize: 19, lineHeight: 22 }, flowLabelCompact: { fontSize: 18, lineHeight: 22 },
  flowNote: { color: C.red, fontSize: 18, lineHeight: 20, marginLeft: 12, transform: [{ rotate: "-5deg" }] },
  ringLayer: { position: "absolute", zIndex: -1, pointerEvents: "none" },
  flowArrow: {},
  progress: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }, progressValue: { color: C.blue, fontSize: 17, lineHeight: 20 },
  track: { height: 10, alignSelf: "stretch" },
  // 三张卡同一套骨架：胶带 + 卡头 + 固定内容 + 一块按剩余高度伸缩的数据区 + 底部操作
  cards: { flex: 1, minHeight: 0, flexDirection: "row", gap: 14 }, cardsNarrow: { gap: 10 },
  card: { flex: 1, minWidth: 0, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 18 }, cardWide: { flex: 1.24 },
  cardShort: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14 }, cardNarrow: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12 }, cardRoomy: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 22 },
  tape: { position: "absolute", top: -9, width: 64, height: 18, marginLeft: -32, backgroundColor: C.tape, pointerEvents: "none" },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12 },
  badge: { width: 28, height: 28, alignItems: "center", justifyContent: "center" }, badgeText: { fontSize: 17, lineHeight: 20, color: C.text, fontWeight: "700" },
  cardTitleRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 24, lineHeight: 28 }, cardTitleSmall: { fontSize: 22, lineHeight: 26 }, cardTitleLarge: { fontSize: 27, lineHeight: 32 },
  cardTitlePlain: { flexShrink: 1, color: C.text, fontSize: 14, lineHeight: 20, fontWeight: "600", marginTop: 3 },
  label: { color: C.text2, fontSize: 12, fontWeight: "500", marginBottom: 5 },
  inputBox: { height: 38, marginBottom: 12, justifyContent: "center", paddingHorizontal: 11 }, inputShort: { height: 34, marginBottom: 10 },
  input: { flex: 1, minWidth: 0, color: C.text, fontSize: 13, fontFamily: SANS, backgroundColor: "transparent", borderWidth: 0 }, inputDisabled: { color: C.muted },
  codeWrap: { flexDirection: "row", alignItems: "center", gap: 8 }, codeInput: { alignSelf: "stretch" },
  error: { paddingLeft: 12 }, errorRule: { position: "absolute", left: 0, top: 0 }, errorTitle: { color: C.red, fontSize: 19, lineHeight: 22 }, errorText: { color: C.text2, fontSize: 12, lineHeight: 18, marginTop: 1 },
  slot: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, alignSelf: "stretch" }, slotInner: { position: "absolute", left: 0, top: 0, overflow: "hidden" },
  slotTop: { marginTop: 12 }, slotChart: { marginTop: 8, marginBottom: 12 },
  notes: { paddingHorizontal: 8, paddingTop: 10 }, notesAfterError: { marginTop: 12 },
  note: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12, boxShadow: "0 6px 12px -8px rgba(60,48,20,.45)" }, noteGap: { marginTop: 12 },
  noteTape: { position: "absolute", top: -8, left: "50%", marginLeft: -24, width: 48, height: 15, backgroundColor: C.tape, transform: [{ rotate: "-4deg" }], pointerEvents: "none" },
  noteTitle: { fontSize: 20, lineHeight: 24, color: C.noteInk, marginBottom: 2 }, noteBody: { color: C.noteInk },
  counts: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }, count: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, alignItems: "center" },
  // Caveat 是斜的，字形会探出字宽，左右留几像素免得被单行省略的 overflow 切掉
  countValue: { fontSize: 32, lineHeight: 38, fontWeight: "700", color: C.text, paddingHorizontal: 5 }, countValueSmall: { fontSize: 27, lineHeight: 33, paddingHorizontal: 3 }, countValueLarge: { fontSize: 38, lineHeight: 45 },
  countLabel: { flexDirection: "row", alignItems: "center", gap: 4 },
  sketches: { justifyContent: "center" }, chartHead: { flexDirection: "row", alignItems: "baseline", gap: 8, height: 22 }, chartTitle: { color: C.text2, fontSize: 12, fontWeight: "600" }, chartLine: { marginTop: 4 },
  peakLabel: { position: "absolute", top: -4, width: 110, textAlign: "center", color: C.red, fontSize: 17, lineHeight: 20 }, peakInline: { color: C.red, fontSize: 16, lineHeight: 18 },
  axis: { height: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }, axisText: { color: C.muted, fontSize: 15, lineHeight: 18 },
  ghost: { alignItems: "center", justifyContent: "center", marginTop: 2 }, ghostLabel: { maxWidth: "86%", paddingHorizontal: 14, paddingVertical: 9 }, emptyText: { color: C.muted, fontSize: 12, lineHeight: 18, textAlign: "center" },
  recent: { gap: 0 }, recentHead: { height: 30, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, recentTitle: { fontSize: 20, lineHeight: 24 },
  recentRow: { height: 25, flexDirection: "row", alignItems: "center", gap: 7 }, recentText: { flex: 1, minWidth: 0, color: C.text2, fontSize: 12.5 }, recentTime: { color: C.muted, fontSize: 15, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, action: { flexGrow: 1, flexBasis: "30%", minHeight: 36, paddingHorizontal: 8 }, actionCompact: { minHeight: 32, gap: 5, paddingHorizontal: 5 },
  hint: { color: C.faint, fontSize: 11, lineHeight: 16, marginTop: 7 },
  hrule: { height: 6, alignSelf: "stretch", pointerEvents: "none" }, rule: { marginTop: 10, marginBottom: 8 }, ruleShort: { marginTop: 8, marginBottom: 6 },
  auto: { flexDirection: "row", alignItems: "center", gap: 10 },
  autoState: { color: C.faint, fontSize: 17, lineHeight: 20 }, autoStateOn: { color: C.green },
  switch: { width: 38, height: 22, justifyContent: "center" }, switchKnob: { position: "absolute", left: 3, top: 3, width: 16, height: 16 }, switchKnobOn: { transform: [{ translateX: 16 }] },
  smallRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  small: { minHeight: 31, gap: 6, paddingHorizontal: 11 }, smallCompact: { minHeight: 29, gap: 4, paddingHorizontal: 7 }, smallTextCompact: { fontSize: 11 }, smallText: { color: C.text2, fontSize: 12, fontWeight: "500" },
  update: { gap: 6, marginTop: 4 }, updateShort: { gap: 4 }, updateRule: { marginVertical: 4 },
  updateHead: { flexDirection: "row", alignItems: "center", gap: 8 }, updateTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 8 }, updateTitle: { fontSize: 20, lineHeight: 23 }, updateBadge: { color: C.red, fontSize: 17, lineHeight: 20, transform: [{ rotate: "-4deg" }] },
  updateTarget: { color: C.blue, fontSize: 11 }, updateError: { color: C.red, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.8, transform: [{ translateY: 1 }] }, disabled: { opacity: 0.4 },
});
