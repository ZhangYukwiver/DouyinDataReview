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
  ShieldCheck,
  Trash2,
  Unplug,
  UserRoundCog,
  X,
} from "lucide-react-native";

import type { PersonalRecordCollection } from "../../domain/personalRecords";
import type { DesktopUpdateState } from "../../desktopRuntime";
import type { CollectorStatus } from "../../services/localCollector";
import { APP_STYLES, DEFAULT_APP_STYLE, type AppStyle } from "../../services/appStyle";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ease, fx, useCountUp, ws } from "./motion";

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

const pointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;

// 各风格各说各的话：档案馆是观测档案，年志是一张通往这一年的入口卡，海报是一叠印好的海报
const COPY: Record<AppStyle, { brand: string; brandMeta: string; eyebrow: string; title: [string, string]; lead: string; seal: string }> = {
  archive: { brand: "内容宇宙", brandMeta: "LOCAL OBSERVATORY", eyebrow: "OBSERVATION DOSSIER · 01", title: ["先建立证据，", "再打开你的内容宇宙。"], lead: "连接本地采集器，或导入一份个人档案。数据只留在这台设备上。", seal: "LOCAL · PRIVATE" },
  trace: { brand: "内容年志", brandMeta: "TRACE · ANNUAL", eyebrow: "TRACE · PERSONAL SIGNALS", title: ["先把这一年的光，", "收进一张卡。"], lead: "连接本地采集器，或导入一份个人档案。卡片的另一边是你的一年，每个数字都有出处，也都只留在这台设备上。", seal: "LOCAL · PRIVATE" },
  poster: { brand: "内容年志", brandMeta: "POSTER · EDITION", eyebrow: "FIG. 00 · PERSONAL SIGNALS", title: ["一整年的记录，", "印成一叠海报。"], lead: "连接本地采集器，或导入一份个人档案。每个数字都有出处，也都只留在这台设备上。", seal: "LOCAL · PRIVATE" },
};

// ponytail: 正文字体跟风格走（档案馆系统无衬线 / 年志 Inter），包一层比逐条 style 加 fontFamily 省
const bodyType = { fontFamily: font.sans } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
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
  const { width } = useWindowDimensions();
  const mobile = width < 900;
  const phone = width < 560;
  const copy = COPY[appStyle];
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
      <View {...ws("s-top g-ink")} style={[styles.topbar, phone && styles.topbarPhone]}>
        <View style={styles.brand}><View {...ws("s-mark")} style={styles.brandSeal}><Database color={color.accent} size={19} /></View><View><Text {...ws("s-brand")} style={styles.brandName}>{copy.brand}</Text><Text {...ws("stamp-sig s-brandmeta")} style={styles.brandMeta}>{copy.brandMeta}</Text></View></View>
        <View style={styles.topStatus}><View {...fx({ motion: connected ? "pulse" : null, ws: connected ? "dot on" : "dot" })} style={[styles.statusDot, connected && styles.statusDotReady]} /><Text {...ws("s-status")} numberOfLines={1} style={styles.statusText}>{busy && ready && snapshotSource === "collector" ? `${source} · 采集中，报告用采集前的数据` : source}</Text></View>
        <View style={[styles.topActions, phone && styles.topActionsPhone]}>
          <Pressable {...fx({ hover: "raise", ws: "btn s-enter" })} accessibilityRole="button" onPress={onOpenDashboard} style={({ pressed }) => [styles.enter, styles.dashboardEntry, phone && styles.enterPhone, pressed && styles.pressed, pointer]}><LayoutDashboard color={color.accent} size={17} /><Text style={[styles.enterText, styles.dashboardEntryText]}>进入工作台</Text></Pressable>
          <Pressable {...fx({ hover: "raise", ws: "btn-sig s-enter" })} accessibilityRole="button" disabled={!ready} onPress={onEnterWorkspace} style={({ pressed }) => [styles.enter, phone && styles.enterPhone, !ready && styles.disabled, pressed && styles.pressed, pointer]}><Text style={styles.enterText}>打开报告</Text><ArrowRight color={color.buttonText} size={17} /></Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.scrollContent, mobile && styles.scrollContentMobile]} showsVerticalScrollIndicator={false}>
        <View {...ws("s-layout")} style={[styles.layout, mobile && styles.layoutMobile]}>
          <View {...ws("s-intro g-sig")} style={[styles.intro, mobile && styles.introMobile]}>
            <Text {...fx({ motion: "rise", i: 1, ws: "stamp" })} style={styles.eyebrow}>{copy.eyebrow}</Text>
            <Text {...fx({ motion: "rise", i: 2, ws: "s-title" })} style={[styles.title, phone && styles.titlePhone]}>{copy.title[0]}{phone ? "\n" : ""}{copy.title[1]}</Text>
            <Text {...fx({ motion: "rise", i: 3, ws: "s-lead" })} style={styles.lead}>{copy.lead}</Text>
            <View {...fx({ motion: "rise", i: 4, ws: "s-seal g-ink" })} style={styles.seal}><ShieldCheck color={color.accent} size={31} strokeWidth={1.2} /><Text {...ws("s-sealtext")} style={styles.sealText}>{copy.seal}</Text><Text {...ws("s-year")} style={styles.sealYear}>{new Date().getFullYear()}</Text></View>
            <View {...fx({ motion: "rise", i: 5, ws: "rule-t" })} style={styles.steps}><Step index="01" label="连接数据源" detail={connected ? "本地服务已连接" : "点击连接后自动获取配对码"} done={connected} /><Step index="02" label="读取内容记录" detail={total ? `${total.toLocaleString("zh-CN")} 条记录已准备` : "观看、喜欢与收藏"} done={ready} /></View>
            {Platform.OS === "web" ? <View {...fx({ motion: "rise", i: 6, ws: "rule-t" })} testID="app-style" style={styles.styleBlock}><Text {...ws("s-steplabel")} style={styles.stepLabel}>03 · 整体风格</Text><Text style={styles.stepDetail}>采集器、报告与持续报告共用的版式</Text><View style={styles.styleRow}>{APP_STYLES.map((item) => <Pressable {...fx({ hover: "tint", ws: appStyle === item.key ? "s-opt on" : "s-opt" })} key={item.key} accessibilityRole="radio" aria-checked={appStyle === item.key} onPress={() => onChangeAppStyle(item.key)} style={({ pressed }) => [styles.styleOption, appStyle === item.key && styles.styleOptionOn, pressed && styles.pressed, pointer]}><Text {...ws("s-optlabel")} style={[styles.styleLabel, appStyle === item.key && styles.styleLabelOn]}>{item.label}</Text><Text style={styles.styleMeta}>{item.detail}{item.key === DEFAULT_APP_STYLE ? " · 默认" : ""}</Text></Pressable>)}</View></View> : null}
          </View>

          <View {...ws("s-ops")} style={styles.operations}>
            <View {...fx({ motion: "rise", i: 1, ws: "s-head" })} style={styles.operationHead}><View><Text {...ws("stamp-sig")} style={styles.operationKicker}>CURRENT SAMPLE</Text><Text {...ws("s-optitle")} style={styles.operationTitle}>{connected ? "采集器已就绪" : "等待连接数据源"}</Text><Text style={styles.operationMeta}>{status?.message ?? "所有操作均在本机执行"}</Text></View><View {...ws("s-ready", ready && "on")} style={[styles.readyPill, ease("background-color,border-color", 350), ready && styles.readyPillReady]}><View {...fx({ motion: ready ? "pulse" : null, ws: ready ? "dot on" : "dot" })} style={[styles.readyDot, ready && styles.statusDotReady]} /><Text {...ws("mono")} style={styles.readyText}>{ready ? "已就绪" : "待完成"}</Text></View></View>

            <ChatProgress progress={chatProgress} />

            <View {...fx({ motion: "rise", i: 2 })} style={[styles.connection, mobile && styles.connectionMobile]}>
              <View style={styles.connectionCopy}><View style={styles.iconTitle}><View {...ws("s-icon")} style={styles.iconBox}><Link2 color={color.signal} size={19} /></View><View><Text {...ws("s-cardtitle")} style={styles.cardTitle}>本地采集器</Text><Text style={styles.cardMeta}>专用浏览器会话 · 不上传云端</Text></View></View><Text style={styles.inputLabel}>服务地址</Text><TextInput accessibilityLabel="采集服务地址" autoCapitalize="none" autoCorrect={false} editable={!connected && !busy} onChangeText={onChangeCollectorUrl} placeholder="http://127.0.0.1:4765" placeholderTextColor={color.textMuted} {...ws("s-input")} style={[styles.input, connected && styles.inputDisabled]} value={collectorUrl} />{!connected ? <><Text style={styles.inputLabel}>配对码（自动获取）</Text><View {...ws("s-input")} style={styles.codeWrap}><LockKeyhole color={color.textMuted} size={17} /><TextInput accessibilityLabel="8 位配对码" editable={!busy} keyboardType="number-pad" maxLength={8} onChangeText={(value) => onChangePairingCode(value.replace(/\D/gu, ""))} placeholder="点击连接后自动获取" placeholderTextColor={color.textMuted} style={styles.codeInput} value={pairingCode} /></View></> : null}</View>
              <View {...ws("s-action g-ink")} style={styles.connectionAction}><Text {...ws("stamp-sig")} style={styles.actionKicker}>{connected ? "CONNECTION READY" : "AUTO PAIR LOCAL SERVICE"}</Text><Text {...ws("s-actionvalue")} style={styles.actionValue}>{connected ? "连接正常" : "等待连接"}</Text><Text style={styles.actionMeta}>{connected ? collectorUrl : "连接后会读取现有本地快照，不会自动上传。"}</Text><Pressable {...fx({ hover: "raise", ws: "btn-sig" })} accessibilityRole="button" disabled={busy} onPress={() => void (connected ? onDisconnect() : onConnect())} style={({ pressed }) => [styles.primary, busy && styles.disabled, pressed && styles.pressed, pointer]}>{busy ? <ActivityIndicator color={color.buttonText} size="small" /> : connected ? <Unplug color={color.buttonText} size={17} /> : <Link2 color={color.buttonText} size={17} />}<Text style={styles.primaryText}>{connected ? "断开连接" : "连接采集器"}</Text></Pressable></View>
            </View>

            <View {...fx({ motion: "rise", i: 3, ws: "rule-t" })} style={styles.dataCard}><View style={styles.dataHead}><View><Text {...ws("stamp")} style={styles.cardKicker}>02 · CONTENT RECORDS</Text><Text {...ws("s-cardtitle big")} style={styles.cardTitle}>读取内容记录</Text></View><Text {...ws("mono")} style={styles.updated}>{snapshotUpdatedAt ? `更新于 ${formatDate(snapshotUpdatedAt)}` : "尚未生成快照"}</Text></View><View {...ws("s-counts")} style={[styles.counts, mobile && styles.countsMobile]}><Count label="观看历史" value={counts.watch} icon={History} /><Count label="喜欢" value={counts.liked} icon={Play} /><Count label="收藏" value={counts.favorite} icon={BookmarkIcon} /><Count label="聊天" value={counts.chat} icon={MessageCircle} /></View><View {...ws("s-actions")} style={[styles.actionGrid, mobile && styles.actionGridMobile]}><ActionButton disabled={!connected || (busy && !syncing) || visibleBusy} icon={Play} label={syncing ? "正在读取" : "增量读取"} onPress={syncing ? () => void onStopSync() : onStartIncrementalSync} busy={syncing ? stoppingSync : busy && !observing} /><ActionButton disabled={!connected || busy || visibleBusy} icon={RefreshCw} label="完整读取" onPress={onStartFullSync} /><ActionButton disabled={!connected || busy} icon={observing ? Pause : Eye} label={observing ? "停止监听" : "手动监听"} onPress={() => void (observing ? onStopObservation() : onStartObservation())} /><ActionButton disabled={!connected || chatBusy || (!chatCollecting && (visibleBusy || busy))} icon={chatCollecting ? Pause : MessageCircle} label={chatCollecting ? "暂停接收" : "开始接收"} onPress={() => void (chatCollecting ? onStopObservation() : onStartChatObservation())} /></View><Text style={styles.chatPolicy}>连接后自动开始接收聊天，历史整理完成后继续接收新消息；可随时暂停。增量读取和下载视频时接收照常进行，只有要弹出浏览器窗口的完整读取和手动监听才会先停下接收。群聊保存群名和消息统计，好友对话保存在本机。</Text><Pressable {...ws("s-auto")} accessibilityRole="switch" accessibilityState={{ checked: autoSyncEnabled }} onPress={onToggleAutoSync} style={({ pressed }) => [styles.autoSync, pressed && styles.pressed, pointer]}><View {...ws("s-switch", autoSyncEnabled && "on")} style={[styles.switch, ease("background-color", 250), autoSyncEnabled && styles.switchOn]}><View style={[styles.switchThumb, ease("transform,background-color", 250), autoSyncEnabled && styles.switchThumbOn]} /></View><View style={styles.flex}><Text style={styles.autoTitle}>前台自动增量读取（仅视频记录）</Text><Text style={styles.autoMeta}>回到前台时读取新视频记录，读到一条就存一条，接收消息不受影响。</Text></View><Text {...ws("mono")} style={[styles.autoState, autoSyncEnabled && styles.autoStateOn]}>{autoSyncEnabled ? "已开启" : "已暂停"}</Text></Pressable>{error ? <View {...ws("s-error")} style={styles.error}><Text style={styles.errorTitle}>连接或读取失败</Text><Text style={styles.errorText}>{error}</Text></View> : null}</View>

            <View {...fx({ motion: "rise", i: 4, ws: "rule-t" })} testID="archive-card" style={[styles.archive, mobile && styles.archiveMobile]}><View {...ws("s-icon")} style={styles.archiveIcon}>{archive?.loaded ? <Check color={color.accent} size={20} /> : <FileArchive color={color.accent} size={20} />}</View><View style={styles.archiveCopy}><Text {...ws("s-cardtitle")} style={styles.cardTitle}>{archive?.name ?? "备用档案导入"}</Text><Text style={styles.cardMeta}>{archive?.detail ?? "读取 JSON / ZIP；仅在当前会话处理"}</Text></View><View style={styles.archiveActions}><Pressable {...fx({ hover: "raise", ws: "btn" })} accessibilityRole="button" disabled={pickingArchive} onPress={() => void onPickArchive()} style={({ pressed }) => [styles.archiveButton, pickingArchive && styles.disabled, pressed && styles.pressed, pointer]}>{pickingArchive ? <ActivityIndicator color={color.accent} size="small" /> : <FileArchive color={color.accent} size={17} />}<Text style={styles.archiveButtonText}>{archive ? "重新选择" : "选择文件"}</Text></Pressable>{archive?.mergeable && !pickingArchive ? <Pressable {...fx({ hover: "raise", ws: "btn" })} accessibilityRole="button" disabled={busy} onPress={onMergeArchive} style={({ pressed }) => [styles.archiveButton, busy && styles.disabled, pressed && styles.pressed, pointer]}><Database color={color.accent} size={17} /><Text style={styles.archiveButtonText}>并入本机记录</Text></Pressable> : null}{archive && !pickingArchive ? <Pressable {...fx({ hover: "raise", ws: "btn" })} accessibilityRole="button" onPress={onRemoveArchive} style={({ pressed }) => [styles.archiveButton, pressed && styles.pressed, pointer]}><X color={color.accent} size={17} /><Text style={styles.archiveButtonText}>移除</Text></Pressable> : null}</View></View>

            <View {...fx({ motion: "rise", i: 5 })} style={styles.utility}><Pressable {...fx({ hover: "tint", ws: "btn small" })} disabled={!connected || busy || switchingAccount} onPress={onSwitchAccount} style={({ pressed }) => [styles.utilityButton, pressed && styles.pressed, pointer]}><UserRoundCog color={color.textMuted} size={16} /><Text style={styles.utilityText}>切换账号</Text></Pressable>{Platform.OS === "web" ? <Pressable {...fx({ hover: "tint", ws: "btn small" })} disabled={!connected} onPress={onExportData} style={({ pressed }) => [styles.utilityButton, pressed && styles.pressed, pointer]}><Download color={color.textMuted} size={16} /><Text style={styles.utilityText}>导出数据</Text></Pressable> : null}<Pressable {...fx({ hover: "tint", ws: "btn small" })} disabled={!total || busy} onPress={onClearCache} style={({ pressed }) => [styles.utilityButton, pressed && styles.pressed, pointer]}><Trash2 color={color.textMuted} size={16} /><Text style={styles.utilityText}>清除本地记录</Text></Pressable><Text {...ws("mono")} style={styles.utilityNote}>Cookie 与记录只保存在当前设备</Text></View>
            {appUpdate ? <AppUpdatePanel busy={busy || observing} onCheck={onCheckAppUpdate} onDownload={onDownloadAppUpdate} onInstall={onInstallAppUpdate} state={appUpdate} /> : null}
          </View>
        </View>
      </ScrollView>
      <View {...fx({ motion: "rise", i: 6, ws: "s-foot g-ink" })} style={styles.chatCollectFooter}>
        <ActionButton
          disabled={!connected || chatBusy || visibleBusy || (busy && !chatCollecting)}
          icon={RefreshCw}
          label="采集聊天记录"
          onPress={() => void onCollectChatHistory()}
          busy={chatBusy}
        />
      </View>
    </View>
  );
}

function ChatProgress({ progress }: { progress: CollectorStatus["progress"] }) {
  if (!progress) return null;
  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;
  return (
    <View
      accessibilityLabel="聊天全量读取进度"
      accessibilityRole="progressbar"
      accessibilityValue={progress.total > 0 ? { min: 0, max: progress.total, now: progress.current } : undefined}
      {...ws("s-progress")}
      style={chatProgressStyles.container}
    >
      <View style={chatProgressStyles.head}>
        <Text style={chatProgressStyles.label}>聊天历史整理</Text>
        <Text style={chatProgressStyles.value}>
          {progress.total > 0 ? `会话 ${progress.current}/${progress.total}` : "正在读取会话列表"}
        </Text>
      </View>
      <View style={chatProgressStyles.track}>
        {progress.total > 0
          ? <View style={[chatProgressStyles.fill, ease("width", 500), { width: `${percent}%` }]} />
          : <View {...fx({ motion: "slide" })} style={[chatProgressStyles.fill, { width: "35%" }]} />}
      </View>
    </View>
  );
}

function AppUpdatePanel({
  busy,
  onCheck,
  onDownload,
  onInstall,
  state,
}: {
  busy: boolean;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  state: DesktopUpdateState;
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
    <View {...fx({ motion: "rise", i: 6, ws: "rule-t" })} style={styles.updatePanel}>
      <View {...ws("s-icon")} style={styles.updateIcon}><Download color={color.signal} size={18} /></View>
      <View style={styles.flex}>
        <View style={styles.updateHead}>
          <Text style={styles.updateTitle}>应用更新</Text>
          <Text style={styles.updateVersion}>当前 v{state.currentVersion}</Text>
        </View>
        <Text numberOfLines={2} style={styles.updateMessage}>{state.message}</Text>
        {state.version && state.phase !== "up-to-date" ? <Text numberOfLines={1} style={styles.updateTarget}>目标版本 v{state.version}{state.releaseName ? ` · ${state.releaseName}` : ""}</Text> : null}
        {state.error ? <Text numberOfLines={2} style={styles.updateError}>{state.error}</Text> : null}
        {percent !== null && (downloading || state.phase === "downloaded") ? <View accessibilityLabel={`更新下载进度 ${percent}%`} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.updateTrack}><View style={[styles.updateFill, { width: `${percent}%` }]} /></View> : null}
      </View>
      {action ? <Pressable accessibilityLabel={action.label} accessibilityRole="button" accessibilityState={{ busy: checking || downloading, disabled: action.disabled }} disabled={action.disabled} onPress={() => void action.onPress()} {...ws("btn")} style={({ pressed }) => [styles.updateAction, action.disabled && styles.disabled, pressed && styles.pressed, pointer]}>{checking || downloading ? <ActivityIndicator color={color.accent} size="small" /> : <action.icon color={color.accent} size={16} />}<Text style={styles.updateActionText}>{action.label}</Text></Pressable> : null}
    </View>
  );
}

const chatProgressStyles = StyleSheet.create({
  container: { marginTop: 12, padding: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.cyanSoft },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: color.green, fontSize: 10, fontWeight: "800" },
  value: { color: color.signal, fontSize: 10, fontWeight: "800" },
  track: { height: 5, justifyContent: "center", marginTop: 9, overflow: "hidden", borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  fill: { height: "100%", backgroundColor: color.signal },
});

function Step({ done, detail, index, label }: { done: boolean; detail: string; index: string; label: string }) { return <View style={styles.step}><View {...ws("s-stepindex", done && "on")} style={[styles.stepIndex, ease("background-color,border-color", 350), done && styles.stepIndexDone]}>{done ? <View {...fx({ motion: "pop" })}><Check color={color.buttonText} size={14} strokeWidth={3} /></View> : <Text {...ws("mono")} style={styles.stepIndexText}>{index}</Text>}</View><View style={styles.flex}><Text {...ws("s-steplabel")} style={styles.stepLabel}>{label}</Text><Text style={styles.stepDetail}>{detail}</Text></View></View>; }
function Count({ icon: CountIcon, label, value }: { icon: React.ComponentType<{ color?: string; size?: number }>; label: string; value: number }) { const shown = useCountUp(value); return <View {...ws("s-count")} style={styles.count}><CountIcon color={color.accent} size={18} /><View><Text {...ws("s-countvalue")} style={styles.countValue}>{shown.toLocaleString("zh-CN")}</Text><Text {...ws("s-countlabel")} style={styles.countLabel}>{label}</Text></View></View>; }
function ActionButton({ busy, disabled, icon: ActionIcon, label, onPress }: { busy?: boolean; disabled: boolean; icon: React.ComponentType<{ color?: string; size?: number }>; label: string; onPress: () => void }) { return <Pressable {...fx({ hover: "raise", ws: "btn" })} accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed, pointer]}>{busy ? <ActivityIndicator color={color.accent} size="small" /> : <ActionIcon color={color.textSecondary} size={17} />}<Text style={styles.actionText}>{label}</Text></Pressable>; }
function BookmarkIcon({ color: iconColor, size }: { color?: string; size?: number }) { return <Bookmark color={iconColor} size={size} />; }
function formatDate(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : value; }

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: "100%", backgroundColor: color.canvas }, flex: { flex: 1, minWidth: 0 },
  topbar: { height: 70, flexDirection: "row", alignItems: "center", paddingHorizontal: 22, borderBottomWidth: 1, borderBottomColor: color.borderSoft, backgroundColor: color.sidebar }, topbarPhone: { height: "auto", flexWrap: "wrap", rowGap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  brand: { minWidth: 195, flexDirection: "row", alignItems: "center", gap: 10 }, brandSeal: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.frame, borderRadius: 19 }, brandName: { color: color.text, fontSize: 15, fontWeight: "800" }, brandMeta: { color: color.textMuted, fontSize: 8, letterSpacing: 1.2, marginTop: 2, fontFamily: font.setupMono },
  topStatus: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.textMuted }, statusDotReady: { backgroundColor: color.signal }, statusText: { flexShrink: 1, color: color.textMuted, fontSize: 11 },
  topActions: { flexDirection: "row", gap: 8 }, topActionsPhone: { width: "100%" },
  enter: { minWidth: 120, minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 15, borderRadius: radius.pill, backgroundColor: color.button }, enterText: { color: color.buttonText, fontSize: 12, fontWeight: "800" },
  enterPhone: { flex: 1, minWidth: 0 }, dashboardEntry: { borderWidth: 1, borderColor: color.frame, backgroundColor: color.surface }, dashboardEntryText: { color: color.accent },
  scrollContent: { flexGrow: 1, padding: 32 }, scrollContentMobile: { padding: 14, paddingBottom: 30 }, layout: { width: "100%", maxWidth: 1380, alignSelf: "center", flexDirection: "row", overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.large, backgroundColor: color.sidebar, boxShadow: color.shadow }, layoutMobile: { flexDirection: "column", borderWidth: 0 },
  intro: { width: 330, padding: 34, borderRightWidth: 1, borderRightColor: color.border }, introMobile: { width: "100%" }, eyebrow: { color: color.signal, fontSize: 9, letterSpacing: 1.3, fontWeight: "900", fontFamily: font.setupMono }, title: { color: color.text, fontSize: 31, lineHeight: 42, marginTop: 18, fontFamily: font.serif }, titlePhone: { fontSize: 27, lineHeight: 36 }, lead: { color: color.textMuted, fontSize: 12, lineHeight: 20, marginTop: 15 }, seal: { width: 156, height: 156, alignItems: "center", justifyContent: "center", alignSelf: "center", marginTop: 44, borderRadius: 78, borderWidth: 1, borderColor: color.frame, backgroundColor: color.surface }, sealText: { color: color.accent, fontSize: 8, letterSpacing: 1.1, marginTop: 8, fontFamily: font.setupMono }, sealYear: { color: color.textMuted, fontSize: 10, marginTop: 3, fontFamily: font.setupMono }, steps: { gap: 16, marginTop: 44, paddingTop: 21, borderTopWidth: 1, borderTopColor: color.border }, step: { flexDirection: "row", gap: 11 }, stepIndex: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: color.border }, stepIndexDone: { borderColor: color.signal, backgroundColor: color.signal }, stepIndexText: { color: color.textMuted, fontSize: 9 }, stepLabel: { color: color.text, fontSize: 11, fontWeight: "800" }, stepDetail: { color: color.textMuted, fontSize: 10, lineHeight: 15, marginTop: 3 },
  operations: { flex: 1, minWidth: 0, padding: 34 }, operationHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }, operationKicker: { color: color.signal, fontSize: 8, letterSpacing: 1.2, fontWeight: "900", fontFamily: font.setupMono }, operationTitle: { color: color.text, fontSize: 21, marginTop: 6, fontFamily: font.serif }, operationMeta: { color: color.textMuted, fontSize: 10, marginTop: 4 }, readyPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: color.border, borderRadius: radius.pill }, readyPillReady: { borderColor: color.signal, backgroundColor: color.cyanSoft }, readyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.textMuted }, readyText: { color: color.textMuted, fontSize: 9 },
  connection: { flexDirection: "row", gap: 18, marginTop: 23 }, connectionMobile: { flexDirection: "column" }, connectionCopy: { flex: 1.15 }, connectionAction: { flex: 0.85, minWidth: 230, justifyContent: "flex-end", padding: 18, borderLeftWidth: 3, borderLeftColor: color.signal, borderRadius: radius.medium, backgroundColor: color.surface }, iconTitle: { minHeight: 43, flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 14 }, iconBox: { width: 39, height: 39, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: color.cyanSoft }, cardTitle: { color: color.text, fontSize: 13, fontWeight: "800" }, cardMeta: { color: color.textMuted, fontSize: 10, lineHeight: 16, marginTop: 3 }, inputLabel: { color: color.textSecondary, fontSize: 10, fontWeight: "700", marginBottom: 6, marginTop: 8 }, input: { width: "100%", height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, color: color.text, backgroundColor: color.canvas, fontSize: 14, fontFamily: font.sans }, inputDisabled: { color: color.textMuted, backgroundColor: color.surfaceRaised }, codeWrap: { height: 44, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.canvas }, codeInput: { flex: 1, color: color.text, fontSize: 15, fontFamily: font.sans }, actionKicker: { color: color.signal, fontSize: 8, letterSpacing: 1.1, fontWeight: "900", fontFamily: font.setupMono }, actionValue: { color: color.text, fontSize: 23, marginTop: 7, fontFamily: font.serif }, actionMeta: { color: color.textMuted, fontSize: 10, lineHeight: 16, marginTop: 6, marginBottom: 14 }, primary: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: radius.pill, backgroundColor: color.button }, primaryText: { color: color.buttonText, fontSize: 11, fontWeight: "800" },
  dataCard: { marginTop: 24, paddingTop: 22, borderTopWidth: 1, borderTopColor: color.border }, dataHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }, cardKicker: { color: color.signal, fontSize: 8, letterSpacing: 1.1, fontWeight: "900", fontFamily: font.setupMono }, updated: { color: color.textMuted, fontSize: 9 }, counts: { flexDirection: "row", marginTop: 16, overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface }, countsMobile: { flexWrap: "wrap" }, count: { flex: 1, minWidth: 128, minHeight: 72, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, borderRightWidth: 1, borderRightColor: color.border }, countValue: { color: color.text, fontSize: 21, fontFamily: font.serif }, countLabel: { color: color.textMuted, fontSize: 9, marginTop: 3 }, actionGrid: { flexDirection: "row", gap: 7, marginTop: 14 }, actionGridMobile: { flexWrap: "wrap" }, action: { flex: 1, minWidth: 122, minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderColor: color.border, borderRadius: radius.pill, backgroundColor: color.surface }, actionText: { color: color.textSecondary, fontSize: 10, fontWeight: "700" }, autoSync: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, padding: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.cyanSoft }, switch: { width: 29, height: 17, justifyContent: "center", padding: 2, borderRadius: 9, backgroundColor: color.surfaceMuted }, switchOn: { backgroundColor: color.signal }, switchThumb: { width: 13, height: 13, borderRadius: 7, backgroundColor: color.textMuted }, switchThumbOn: { transform: [{ translateX: 12 }], backgroundColor: color.white }, autoTitle: { color: color.textSecondary, fontSize: 10, fontWeight: "800" }, autoMeta: { color: color.textMuted, fontSize: 9, marginTop: 3 }, autoState: { color: color.textMuted, fontSize: 9 }, autoStateOn: { color: color.signal }, error: { marginTop: 13, padding: 12, borderLeftWidth: 3, borderLeftColor: color.danger, borderRadius: radius.small, backgroundColor: color.dangerSoft }, errorTitle: { color: color.danger, fontSize: 10, fontWeight: "800" }, errorText: { color: color.textSecondary, fontSize: 10, lineHeight: 16, marginTop: 4 },
  archive: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 11, marginTop: 24, paddingTop: 20, borderTopWidth: 1, borderTopColor: color.border }, archiveMobile: { alignItems: "flex-start" }, archiveCopy: { flex: 1, minWidth: 180 }, archiveActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, archiveIcon: { width: 37, height: 37, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.frame, borderRadius: radius.small }, archiveButton: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, borderWidth: 1, borderColor: color.frame, borderRadius: radius.pill }, archiveButtonText: { color: color.accent, fontSize: 10, fontWeight: "800" }, utility: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 9, marginTop: 18 }, utilityButton: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.pill }, utilityText: { color: color.textMuted, fontSize: 9 }, utilityNote: { flex: 1, minWidth: 150, color: color.textMuted, fontSize: 9, textAlign: "right" },
  updatePanel: { flexDirection: "row", alignItems: "center", gap: 11, marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: color.border }, updateIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.frame, borderRadius: radius.small }, updateHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, updateTitle: { color: color.textSecondary, fontSize: 10, fontWeight: "800" }, updateVersion: { color: color.textMuted, fontSize: 9 }, updateMessage: { color: color.textMuted, fontSize: 9, lineHeight: 15, marginTop: 4 }, updateTarget: { color: color.signal, fontSize: 9, marginTop: 3 }, updateError: { color: color.danger, fontSize: 9, lineHeight: 14, marginTop: 3 }, updateTrack: { height: 4, marginTop: 7, overflow: "hidden", borderRadius: radius.small, backgroundColor: color.surfaceMuted }, updateFill: { height: "100%", backgroundColor: color.signal }, updateAction: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: color.frame, borderRadius: radius.pill }, updateActionText: { flexShrink: 1, color: color.accent, fontSize: 9, fontWeight: "800" },
  styleBlock: { marginTop: 18, paddingTop: 18, borderTopWidth: 1, borderTopColor: color.border }, styleRow: { flexDirection: "row", gap: 8, marginTop: 10 }, styleOption: { flex: 1, minHeight: 52, justifyContent: "center", paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium }, styleOptionOn: { borderColor: color.accent, backgroundColor: color.accentSoft }, styleLabel: { color: color.textSecondary, fontSize: 11, fontWeight: "800" }, styleLabelOn: { color: color.text }, styleMeta: { color: color.textMuted, fontSize: 9, marginTop: 3 },
  pressed: { opacity: 0.72, transform: [{ translateY: 1 }] }, disabled: { opacity: 0.34 },
  chatPolicy: { color: color.textMuted, fontSize: 9, lineHeight: 15, marginTop: 9 }, chatCollectFooter: { flexDirection: "row", alignItems: "center", paddingHorizontal: 32, paddingVertical: 10, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.sidebar },
});
