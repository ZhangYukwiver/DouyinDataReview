import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextProps,
  useWindowDimensions,
  View,
} from "react-native";
import {
  ArrowRight,
  Bookmark,
  Check,
  Database,
  Download,
  Eye,
  FileArchive,
  History,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  MessageCircle,
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

// 采集器页只有这一套样式：浅灰底、白面板、墨黑主按钮、一种蓝做点缀，系统无衬线。
// 不跟整体风格走（整体风格只管报告和工作台），所以这里不用主题 token，也不打 data-ws 角色。
const C = {
  canvas: "#F4F5F7", panel: "#FFFFFF", sunken: "#F6F7F9", hover: "#F1F3F5", line: "#E5E7EB", lineStrong: "#D5D9DF",
  text: "#111827", text2: "#374151", muted: "#6B7280", faint: "#9CA3AF",
  ink: "#111827", inkText: "#FFFFFF", blue: "#2563EB", green: "#16A34A", red: "#DC2626",
};
const SANS = web ? "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" : undefined;

// ponytail: 包一层统一字体，比逐条 style 加 fontFamily 省
const bodyType = { fontFamily: SANS } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

// RN-web 的 Pressable 会把 hovered 传进 style 回调，类型里没有
type PressState = { pressed: boolean; hovered?: boolean };

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
  const { width, height } = useWindowDimensions();
  // 一屏放下：矮窗口收紧间距，窄窗口按钮收小；最窄最矮时几段动态说明只留几行
  const short = height < 780;
  const narrow = width < 1100;
  const tight = narrow || height < 660;
  const counts = { watch: records.watch_history.length, liked: records.liked_videos.length, favorite: records.favorite_videos.length, chat: chatCount ?? 0 };
  const total = counts.watch + counts.liked + counts.favorite + counts.chat;
  const ready = total > 0 || status?.state === "complete" || snapshotSource === "archive";
  const syncing = connected && !observing && ["launching_browser", "awaiting_login", "collecting"].includes(status?.state ?? "");
  // 完整读取要独占可见浏览器；增量读取走无头，接收和下载照常
  const visibleBusy = observing || status?.syncMode === "page";
  const chatProgress = status?.chat.progress ?? null;
  const source = snapshotSource === "archive" ? "备用文件导入" : connected ? "本地采集器" : "尚未连接";

  return (
    <View testID="setup-workspace" style={styles.root}>
      <View style={[styles.topbar, narrow && styles.topbarNarrow]}>
        <View style={styles.brand}><View style={styles.mark}><Database color={C.text} size={16} /></View><Text style={styles.brandName}>内容数据工作台</Text></View>
        <View style={styles.topStatus}><View style={[styles.dot, connected && styles.dotOn]} /><Text numberOfLines={1} style={styles.statusText}>{busy && ready && snapshotSource === "collector" ? `${source} · 采集中，报告用采集前的数据` : source}</Text></View>
        <View style={styles.row8}>
          <Pressable accessibilityRole="button" onPress={onOpenDashboard} style={(state) => [styles.button, styles.outline, hovered(state) && styles.outlineHover, state.pressed && styles.pressed, pointer]}><LayoutDashboard color={C.text2} size={15} /><Text style={styles.outlineText}>进入工作台</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={!ready} onPress={onEnterWorkspace} style={(state) => [styles.button, styles.ink, hovered(state) && styles.inkHover, !ready && styles.disabled, state.pressed && styles.pressed, pointer]}><Text style={styles.inkText}>打开报告</Text><ArrowRight color={C.inkText} size={15} /></Pressable>
        </View>
      </View>

      {/* 标题行 + 状态条 + 三张卡（连接 / 内容记录 / 档案与维护），整页锁在一屏里；ScrollView 只是兜底 */}
      <ScrollView contentContainerStyle={[styles.scrollContent, short && styles.scrollContentShort, narrow && styles.scrollContentNarrow]} showsVerticalScrollIndicator={false} style={styles.scroll}>
        <View style={[styles.page, short && styles.pageShort]}>
          <View style={styles.header}>
            <View style={styles.flex}>
              <Text style={styles.title}>先连接数据，再打开报告。</Text>
              <Text numberOfLines={1} style={styles.meta}>连接本地采集器，或导入一份个人档案；数据只留在这台设备上。</Text>
            </View>
            {web ? (
              <View testID="app-style" style={styles.styleBlock}>
                <Text style={styles.meta}>报告风格</Text>
                <View accessibilityRole="radiogroup" style={styles.segments}>
                  {APP_STYLES.map((item) => {
                    const on = appStyle === item.key;
                    return <Pressable key={item.key} accessibilityLabel={`${item.label}：${item.detail}`} accessibilityRole="radio" aria-checked={on} onPress={() => onChangeAppStyle(item.key)} style={(state) => [styles.segment, hovered(state) && !on && styles.segmentHover, on && styles.segmentOn, pointer]}><Text style={[styles.segmentText, on && styles.segmentTextOn]}>{item.label}</Text></Pressable>;
                  })}
                </View>
              </View>
            ) : null}
          </View>

          <View style={[styles.statusBar, narrow && styles.statusBarNarrow]}>
            <View style={[styles.dot, ready && styles.dotOn]} />
            <Text style={styles.statusTitle}>{connected ? "采集器已就绪" : "等待连接数据源"}</Text>
            <Text numberOfLines={tight ? 1 : 2} style={[styles.meta, styles.flex]}>{status?.message ?? "所有操作均在本机执行"}</Text>
            <ChatProgress progress={chatProgress} />
          </View>

          <View style={[styles.cards, narrow && styles.cardsNarrow]}>
            {/* 01 连接 */}
            <View style={[styles.card, short && styles.cardShort, narrow && styles.cardNarrow]}>
              <CardHead index="01" done={connected} title="连接数据源" detail="本地采集器，不上传云端" />
              <Text style={styles.label}>服务地址</Text>
              <TextInput accessibilityLabel="采集服务地址" autoCapitalize="none" autoCorrect={false} editable={!connected && !busy} onChangeText={onChangeCollectorUrl} placeholder="http://127.0.0.1:4765" placeholderTextColor={C.faint} style={[styles.input, short && styles.inputShort, connected && styles.inputDisabled]} value={collectorUrl} />
              {!connected ? <>
                <Text style={styles.label}>配对码</Text>
                <View style={[styles.input, styles.codeWrap, short && styles.inputShort]}><LockKeyhole color={C.faint} size={14} /><TextInput accessibilityLabel="8 位配对码" editable={!busy} keyboardType="number-pad" maxLength={8} onChangeText={(value) => onChangePairingCode(value.replace(/\D/gu, ""))} placeholder="连接时自动获取" placeholderTextColor={C.faint} style={styles.codeInput} value={pairingCode} /></View>
              </> : null}
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => void (connected ? onDisconnect() : onConnect())} style={(state) => [styles.button, connected ? styles.outline : styles.ink, short && styles.buttonShort, hovered(state) && (connected ? styles.outlineHover : styles.inkHover), busy && styles.disabled, state.pressed && styles.pressed, pointer]}>{busy ? <ActivityIndicator color={connected ? C.text2 : C.inkText} size="small" /> : connected ? <Unplug color={C.text2} size={15} /> : <Link2 color={C.inkText} size={15} />}<Text style={connected ? styles.outlineText : styles.inkText}>{connected ? "断开连接" : "连接采集器"}</Text></Pressable>
              {error ? <View style={styles.error}><Text style={styles.errorTitle}>连接或读取失败</Text><Text numberOfLines={tight ? 3 : undefined} style={styles.errorText}>{error}</Text></View> : null}
            </View>

            {/* 02 内容记录 */}
            <View style={[styles.card, short && styles.cardShort, narrow && styles.cardNarrow]}>
              <CardHead index="02" done={ready} title="读取内容记录" detail={total ? `共 ${total.toLocaleString("zh-CN")} 条` : "观看、喜欢、收藏与聊天"} aside={snapshotUpdatedAt ? `更新于 ${formatDate(snapshotUpdatedAt)}` : undefined} />
              <View style={styles.counts}>
                <Count label="观看历史" value={counts.watch} icon={History} small={narrow} />
                <Count label="喜欢" value={counts.liked} icon={Play} small={narrow} />
                <Count label="收藏" value={counts.favorite} icon={BookmarkIcon} small={narrow} />
                <Count label="聊天" value={counts.chat} icon={MessageCircle} small={narrow} />
              </View>
              <View style={styles.actions}>
                <ActionButton compact={narrow} disabled={!connected || (busy && !syncing) || visibleBusy} icon={Play} label={syncing ? "正在读取" : "增量读取"} onPress={syncing ? () => void onStopSync() : onStartIncrementalSync} busy={syncing ? stoppingSync : busy && !observing} />
                <ActionButton compact={narrow} disabled={!connected || busy || visibleBusy} icon={RefreshCw} label="完整读取" onPress={onStartFullSync} />
                <ActionButton compact={narrow} disabled={!connected || busy} icon={observing ? Pause : Eye} label={observing ? "停止监听" : "手动监听"} onPress={() => void (observing ? onStopObservation() : onStartObservation())} />
                <ActionButton compact={narrow} disabled={!connected || chatBusy || (!chatCollecting && (visibleBusy || busy))} icon={chatCollecting ? Pause : MessageCircle} label={chatCollecting ? "暂停接收" : "开始接收"} onPress={() => void (chatCollecting ? onStopObservation() : onStartChatObservation())} />
                <ActionButton compact={narrow} disabled={!connected || chatBusy || visibleBusy || (busy && !chatCollecting)} icon={RefreshCw} label="采集聊天记录" onPress={() => void onCollectChatHistory()} busy={chatBusy} />
              </View>
              <Text style={styles.hint}>完整读取和手动监听会先暂停接收聊天。</Text>
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: autoSyncEnabled }} onPress={onToggleAutoSync} style={(state) => [styles.auto, state.pressed && styles.pressed, pointer]}>
                <Text style={[styles.strong, styles.flex]}>回到前台时自动增量读取</Text>
                <Text style={[styles.fine, autoSyncEnabled && styles.fineOn]}>{autoSyncEnabled ? "已开启" : "已暂停"}</Text>
                <View style={[styles.switch, ease("background-color", 250), autoSyncEnabled && styles.switchOn]}><View style={[styles.switchThumb, ease("transform", 250), autoSyncEnabled && styles.switchThumbOn]} /></View>
              </Pressable>
            </View>

            {/* 档案与维护 */}
            <View style={[styles.card, short && styles.cardShort, narrow && styles.cardNarrow]}>
              <View testID="archive-card">
                <CardHead icon={archive?.loaded ? Check : FileArchive} done={Boolean(archive?.loaded)} title={archive?.name ?? "导入个人档案"} detail={archive?.detail ?? "JSON 或 ZIP，只在本次打开时读取"} detailLines={tight ? 3 : 4} />
                <View style={styles.smallRow}>
                  <SmallButton compact={narrow} disabled={pickingArchive} busy={pickingArchive} icon={FileArchive} label={archive ? "重新选择" : "选择文件"} onPress={() => void onPickArchive()} />
                  {archive?.mergeable && !pickingArchive ? <SmallButton compact={narrow} disabled={busy} icon={Database} label="并入本机记录" onPress={onMergeArchive} /> : null}
                  {archive && !pickingArchive ? <SmallButton compact={narrow} icon={X} label="移除" onPress={onRemoveArchive} /> : null}
                </View>
              </View>
              <View style={[styles.section, short && styles.sectionShort]}>
                <View style={styles.smallRow}>
                  <SmallButton compact={narrow} disabled={!connected || busy || switchingAccount} icon={UserRoundCog} label="切换账号" onPress={onSwitchAccount} />
                  {web ? <SmallButton compact={narrow} disabled={!connected} icon={Download} label="导出数据" onPress={onExportData} /> : null}
                  <SmallButton compact={narrow} disabled={!total || busy} icon={Trash2} label="清除本地记录" onPress={onClearCache} />
                </View>
              </View>
              {appUpdate ? <AppUpdatePanel busy={busy || observing} compact={narrow} onCheck={onCheckAppUpdate} onDownload={onDownloadAppUpdate} onInstall={onInstallAppUpdate} short={short} state={appUpdate} tight={tight} /> : null}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// 卡头：序号圈（完成后是勾）或图标 + 标题 + 一行说明，右边可挂一条小字
function CardHead({ aside, detail, detailLines, done, icon: HeadIcon, index, title }: { aside?: string; detail: string; detailLines?: number; done: boolean; icon?: Icon; index?: string; title: string }) {
  return (
    <View style={styles.cardHead}>
      <View style={[styles.badge, ease("background-color,border-color", 300), done && styles.badgeDone]}>
        {done ? <Check color={C.inkText} size={13} strokeWidth={3} /> : HeadIcon ? <HeadIcon color={C.muted} size={14} /> : <Text style={styles.badgeText}>{index}</Text>}
      </View>
      <View style={styles.flex}>
        <View style={styles.cardTitleRow}><Text numberOfLines={2} style={styles.cardTitle}>{title}</Text>{aside ? <Text style={styles.fine}>{aside}</Text> : null}</View>
        <Text numberOfLines={detailLines} style={styles.meta}>{detail}</Text>
      </View>
    </View>
  );
}


function hovered(state: unknown): boolean {
  return Boolean((state as PressState).hovered);
}

function ChatProgress({ progress }: { progress: CollectorStatus["progress"] }) {
  if (!progress) return null;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  return (
    <View
      accessibilityLabel="聊天全量读取进度"
      accessibilityRole="progressbar"
      accessibilityValue={progress.total > 0 ? { min: 0, max: progress.total, now: progress.current } : undefined}
      style={styles.progress}
    >
      <View style={styles.progressHead}>
        <Text style={styles.meta}>聊天历史整理</Text>
        <Text style={styles.progressValue}>{progress.total > 0 ? `会话 ${progress.current}/${progress.total}` : "正在读取会话列表"}</Text>
      </View>
      {/* ponytail: 会话总数未知时画一段静止的条，不做来回滑动 */}
      <View style={styles.track}><View style={[styles.fill, ease("width", 500), { width: progress.total > 0 ? `${percent}%` : "35%" }]} /></View>
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
    ? { label: "下载更新", icon: Download, onPress: onDownload, disabled: false }
    : state.phase === "downloaded"
      ? { label: busy ? "采集完成后安装" : "重启并安装", icon: RefreshCw, onPress: onInstall, disabled: busy }
      : state.phase === "unsupported"
        ? null
        : { label: state.phase === "error" ? "重试检查" : "检查更新", icon: RefreshCw, onPress: onCheck, disabled: checking || downloading };
  const percent = state.progress === null ? null : Math.round(Math.max(0, Math.min(100, state.progress)));
  return (
    <View style={[styles.section, short && styles.sectionShort]}>
      <View style={styles.updateHead}>
        <View style={styles.flex}><Text style={styles.strong}>应用更新</Text><Text style={styles.fine}>当前 v{state.currentVersion}</Text></View>
        {action ? <SmallButton accessibilityLabel={action.label} busy={checking || downloading} compact={compact} disabled={action.disabled} icon={action.icon} label={action.label} onPress={() => void action.onPress()} /> : null}
      </View>
      <Text numberOfLines={tight ? 1 : 2} style={styles.meta}>{state.message}</Text>
      {state.version && state.phase !== "up-to-date" ? <Text numberOfLines={1} style={styles.updateTarget}>目标版本 v{state.version}{state.releaseName ? ` · ${state.releaseName}` : ""}</Text> : null}
      {state.error ? <Text numberOfLines={tight ? 1 : 2} style={styles.updateError}>{state.error}</Text> : null}
      {percent !== null && (downloading || state.phase === "downloaded") ? <View accessibilityLabel={`更新下载进度 ${percent}%`} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.track}><View style={[styles.fill, { width: `${percent}%` }]} /></View> : null}
    </View>
  );
}

type Icon = React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

function Count({ icon: CountIcon, label, small, value }: { icon: Icon; label: string; small: boolean; value: number }) {
  const shown = useCountUp(value);
  return (
    <View style={styles.count}>
      <Text numberOfLines={1} style={[styles.countValue, small && styles.countValueSmall]}>{shown.toLocaleString("zh-CN")}</Text>
      <View style={styles.countLabel}><CountIcon color={C.faint} size={12} /><Text style={styles.meta}>{label}</Text></View>
    </View>
  );
}

function ActionButton({ busy, compact, disabled, icon: ActionIcon, label, onPress }: { busy?: boolean; compact: boolean; disabled: boolean; icon: Icon; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={(state) => [styles.button, styles.outline, styles.action, compact && styles.actionCompact, hovered(state) && !disabled && styles.outlineHover, disabled && styles.disabled, state.pressed && styles.pressed, pointer]}>
      {busy ? <ActivityIndicator color={C.text2} size="small" /> : <ActionIcon color={C.muted} size={compact ? 13 : 14} />}
      <Text numberOfLines={1} style={[styles.outlineText, compact && styles.textCompact]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ accessibilityLabel, busy, compact, disabled, icon: ButtonIcon, label, onPress }: { accessibilityLabel?: string; busy?: boolean; compact: boolean; disabled?: boolean; icon: Icon; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" accessibilityState={{ busy, disabled }} disabled={disabled} onPress={onPress} style={(state) => [styles.small, compact && styles.smallCompact, hovered(state) && !disabled && styles.outlineHover, disabled && styles.disabled, state.pressed && styles.pressed, pointer]}>
      {busy ? <ActivityIndicator color={C.text2} size="small" /> : <ButtonIcon color={C.muted} size={13} />}
      <Text style={[styles.smallText, compact && styles.smallTextCompact]}>{label}</Text>
    </Pressable>
  );
}

function BookmarkIcon({ color: iconColor, size }: { color?: string; size?: number }) { return <Bookmark color={iconColor} size={size} />; }
function formatDate(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : value; }

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: "100%", backgroundColor: C.canvas }, flex: { flex: 1, minWidth: 0 }, row8: { flexDirection: "row", gap: 8 },
  // 字：标题 / 正文粗 / 说明 / 细则 四档
  strong: { color: C.text, fontSize: 13, fontWeight: "600" }, meta: { color: C.muted, fontSize: 12, lineHeight: 18 }, fine: { color: C.faint, fontSize: 11, lineHeight: 16, fontVariant: ["tabular-nums"] }, fineOn: { color: C.green },
  topbar: { height: 56, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel }, topbarNarrow: { height: 52, paddingHorizontal: 14 },
  brand: { minWidth: 180, flexDirection: "row", alignItems: "center", gap: 10 }, mark: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: C.sunken, borderWidth: 1, borderColor: C.line }, brandName: { color: C.text, fontSize: 14, fontWeight: "600" },
  topStatus: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, statusText: { flexShrink: 1, color: C.muted, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.faint }, dotOn: { backgroundColor: C.green },
  // 按钮只有两种：墨黑主按钮、描边次按钮
  button: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: "transparent" }, buttonShort: { minHeight: 34 },
  ink: { backgroundColor: C.ink }, inkHover: { backgroundColor: "#2B3342" }, inkText: { color: C.inkText, fontSize: 13, fontWeight: "600" },
  outline: { borderColor: C.lineStrong, backgroundColor: C.panel }, outlineHover: { backgroundColor: C.hover }, outlineText: { flexShrink: 1, color: C.text2, fontSize: 13, fontWeight: "500" },
  scroll: { flex: 1, minHeight: 0 }, scrollContent: { flexGrow: 1, padding: 24 }, scrollContentShort: { paddingHorizontal: 20, paddingVertical: 16 }, scrollContentNarrow: { padding: 12 },
  page: { flex: 1, width: "100%", maxWidth: 1440, alignSelf: "center", gap: 14 }, pageShort: { gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 16 },
  title: { color: C.text, fontSize: 20, lineHeight: 28, fontWeight: "600" },
  styleBlock: { flexDirection: "row", alignItems: "center", gap: 10 },
  segments: { flexDirection: "row", padding: 3, gap: 2, borderRadius: 9, backgroundColor: C.hover, borderWidth: 1, borderColor: C.line },
  segment: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6 }, segmentHover: { backgroundColor: C.sunken }, segmentOn: { backgroundColor: C.panel, boxShadow: "0 1px 2px rgba(17,24,39,.08)" },
  segmentText: { color: C.muted, fontSize: 12, fontWeight: "500" }, segmentTextOn: { color: C.text, fontWeight: "600" },
  statusBar: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel }, statusBarNarrow: { gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  statusTitle: { color: C.text, fontSize: 14, fontWeight: "600" },
  progress: { width: 220, flexShrink: 1, gap: 6 }, progressHead: { flexDirection: "row", justifyContent: "space-between", gap: 8 }, progressValue: { color: C.blue, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  track: { height: 4, overflow: "hidden", borderRadius: 2, backgroundColor: C.line }, fill: { height: "100%", borderRadius: 2, backgroundColor: C.blue },
  // 三张卡同一套骨架：卡头 + 内容，卡与卡等高
  cards: { flex: 1, minHeight: 0, flexDirection: "row", gap: 12 }, cardsNarrow: { gap: 8 },
  card: { flex: 1, minWidth: 0, padding: 20, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel }, cardShort: { paddingHorizontal: 18, paddingVertical: 16 }, cardNarrow: { paddingHorizontal: 12, paddingVertical: 14 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 14 },
  badge: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panel }, badgeDone: { borderColor: C.green, backgroundColor: C.green }, badgeText: { color: C.muted, fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] },
  cardTitleRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }, cardTitle: { flexShrink: 1, color: C.text, fontSize: 15, lineHeight: 21, fontWeight: "600" },
  label: { color: C.text2, fontSize: 12, fontWeight: "500", marginBottom: 6 },
  input: { height: 38, marginBottom: 12, paddingHorizontal: 11, borderRadius: 8, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panel, color: C.text, fontSize: 13, fontFamily: SANS }, inputShort: { height: 34, marginBottom: 10 }, inputDisabled: { color: C.muted, backgroundColor: C.sunken, borderColor: C.line },
  codeWrap: { flexDirection: "row", alignItems: "center", gap: 8 }, codeInput: { flex: 1, minWidth: 0, color: C.text, fontSize: 13, fontFamily: SANS },
  error: { marginTop: 14, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: C.red }, errorTitle: { color: C.red, fontSize: 12, fontWeight: "600" }, errorText: { color: C.text2, fontSize: 12, lineHeight: 18, marginTop: 2 },
  counts: { flexDirection: "row", flexWrap: "wrap", rowGap: 12, marginBottom: 14 }, count: { width: "50%" },
  countValue: { color: C.text, fontSize: 22, lineHeight: 28, fontWeight: "600", fontVariant: ["tabular-nums"] }, countValueSmall: { fontSize: 18, lineHeight: 24 }, countLabel: { flexDirection: "row", alignItems: "center", gap: 5 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, action: { flexGrow: 1, flexBasis: "40%", minHeight: 34, paddingHorizontal: 8 }, actionCompact: { minHeight: 32, gap: 5, paddingHorizontal: 5 }, textCompact: { fontSize: 12 },
  hint: { color: C.faint, fontSize: 11, lineHeight: 16, marginTop: 8 },
  auto: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.line },
  switch: { width: 30, height: 18, justifyContent: "center", padding: 2, borderRadius: 9, backgroundColor: C.lineStrong }, switchOn: { backgroundColor: C.green }, switchThumb: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.panel }, switchThumbOn: { transform: [{ translateX: 12 }] },
  smallRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  small: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 7, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.panel }, smallCompact: { minHeight: 28, gap: 4, paddingHorizontal: 6 }, smallTextCompact: { fontSize: 11 }, smallText: { color: C.text2, fontSize: 12, fontWeight: "500" },
  section: { gap: 8, marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.line }, sectionShort: { marginTop: 12, paddingTop: 12 },
  updateHead: { flexDirection: "row", alignItems: "center", gap: 8 }, updateTarget: { color: C.blue, fontSize: 11 }, updateError: { color: C.red, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.8 }, disabled: { opacity: 0.4 },
});
