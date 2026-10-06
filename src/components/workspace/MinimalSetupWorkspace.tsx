import React, { useCallback, useMemo, useState } from "react";
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
  type TextInputProps,
  type TextProps,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import {
  ArrowRight,
  Database,
  Eye,
  FileArchive,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  MessageCircle,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Unplug,
  UserRound,
  X,
} from "lucide-react-native";

import type { CollectorStatus } from "../../services/localCollector";
import type { SetupWorkspaceProps } from "./SourceWorkspace";
import { ease, useCountUp } from "./motion";
import {
  activeAccountLabel,
  deriveSetup,
  formatDate,
  formatDay,
  formatLongDay,
  formatWhen,
  hasAppUpdate,
  hourName,
  readActions,
  recordSummary,
  runReadCommand,
  tipNotes,
  type ReadAction,
  type ReadActionIcon,
  type ReadCommand,
  type SetupFlow,
  type SetupTip,
} from "./setupModel";
import { dayWindow, digestRecords, type RecordDigest, type SetupRecordKind } from "./setupSketch";
import { alpha, workspaceColors as color, workspaceFonts as font } from "./workspaceTheme";

// 极简风格的采集器页：白底、发丝线、一种系统字体；墨黑是主按钮和选中，蓝只给数据和可点的字，
// 绿只说「已连接」。和手绘版吃同一份 props、同一套规则（setupModel），一屏放下不滚动。
// 账号、导出、清除、应用更新收在设置里：顶栏的账号名和「有新版本」直接打开设置的对应一节。

const web = Platform.OS === "web";
const pointer = web ? ({ cursor: "pointer" } as object) : null;
const noOutline = web ? ({ outlineStyle: "none" } as object) : null;

type Size = { w: number; h: number };
type Icon = React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type PressState = { pressed: boolean; hovered?: boolean };
const hovered = (state: unknown) => Boolean((state as PressState).hovered);

function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[styles.base, style]} />;
}

function useSize(): [Size | null, (event: LayoutChangeEvent) => void] {
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous && Math.abs(previous.w - width) < 0.5 && Math.abs(previous.h - height) < 0.5 ? previous : { w: width, h: height }));
  }, []);
  return [size, onLayout];
}

const PAGE_MAX = 1640;
const READ_ICONS: Record<ReadActionIcon, Icon> = { play: Play, pause: Pause, refresh: RefreshCw, eye: Eye, message: MessageCircle };

export function MinimalSetupWorkspace({
  appUpdate,
  archive,
  accounts,
  autoSyncEnabled,
  busy,
  chatBusy,
  chatCollecting,
  chatCount,
  collectorUrl,
  connected,
  error,
  observing,
  onChangeCollectorUrl,
  onChangePairingCode,
  onCollectChatHistory,
  onConnect,
  onDisconnect,
  onEnterWorkspace,
  onMergeArchive,
  onOpenDashboard,
  onOpenPreferences,
  onPickArchive,
  onRemoveArchive,
  onStartChatObservation,
  onStartFullSync,
  onStartIncrementalSync,
  onStartObservation,
  onStopObservation,
  onStopSync,
  onToggleAutoSync,
  pairingCode,
  pickingArchive,
  records,
  snapshotSource,
  snapshotUpdatedAt,
  status,
  stoppingSync,
  switchingAccount,
}: SetupWorkspaceProps) {
  const { width, height } = useWindowDimensions();
  // 档位：矮窗口收紧上下间距，窄窗口收窄左栏、按钮排两行，又高又宽时字和留白放大
  const short = height < 700;
  const narrow = width < 1100;
  const tight = narrow || height < 660;
  const roomy = height >= 880 && width >= 1300;
  const leftW = narrow ? 312 : width >= 1600 ? 380 : 344;
  const gutter = narrow ? 20 : roomy ? 40 : 32;

  const counts = { watch: records.watch_history.length, liked: records.liked_videos.length, favorite: records.favorite_videos.length, chat: chatCount ?? 0 };
  const total = counts.watch + counts.liked + counts.favorite + counts.chat;
  const setup = deriveSetup({ connected, busy, observing, chatCollecting, status, snapshotSource, total });
  const [stoppingChat, setStoppingChat] = useState(false);
  const actions = readActions({ connected, busy, observing, chatCollecting, chatBusy, stoppingSync, switchingAccount, stoppingChat }, setup);
  const run = (command: ReadCommand) => runReadCommand(command, { onStartIncrementalSync, onStartFullSync, onStopSync, onStartObservation, onStopObservation, onStartChatObservation, onCollectChatHistory, setStoppingChat });
  const digest = useMemo(() => digestRecords(records, 24), [records]);
  // 用着导入文件时，下面档案卡的说明已经讲清楚怎么换回采集器，状态提示就不再重复这句
  const tips = tipNotes({ fromArchive: setup.fromArchive, connected, loginNeeded: setup.loginNeeded, syncing: setup.syncing, ready: setup.ready, autoSyncEnabled }, "minimal")
    .filter((tip) => !(archive && setup.fromArchive && tip.key === "tip"));
  const accountName = activeAccountLabel(connected, status, accounts);
  const statusMessage = switchingAccount ? "正在切换抖音账号，等旧账号的浏览器关好就换过去。" : status?.message?.trim() || null;
  const [rightSize, onRightLayout] = useSize();
  // 五个按钮一排要 5 × 120；放不下就排两行：读取三个一行、聊天两个一行
  const oneRow = (rightSize?.w ?? 0) >= 5 * 120 + 4 * 8 + (roomy ? 48 : tight ? 32 : 40);
  const pad = roomy ? styles.panelRoomy : tight ? styles.panelTight : null;
  const numberSize = roomy ? 34 : tight ? 26 : 30;

  return (
    <View testID="setup-workspace" style={styles.root}>
      <View style={styles.topbar}>
        {/* 顶栏内容和下面的页面同宽同边距，超宽窗口里左右对齐 */}
        <View style={[styles.topInner, { maxWidth: PAGE_MAX + gutter * 2, paddingHorizontal: gutter }, narrow && styles.topInnerNarrow]}>
          <Text numberOfLines={1} style={styles.brand}>内容数据工作台</Text>
          <View style={styles.topDivider} />
          <View style={styles.topStatus}>
            <View style={[styles.dot, connected && styles.dotOn]} />
            <Text numberOfLines={1} style={styles.statusText}>{setup.statusLine}</Text>
            {connected ? (
              <Pressable accessibilityLabel={`抖音账号：${accountName}，在设置里切换或添加`} accessibilityRole="button" onPress={() => onOpenPreferences("account")} style={(state) => [styles.account, hovered(state) && styles.accountHover, pointer, ease("background-color", 140)]} testID="account-button">
                {switchingAccount ? <View style={[styles.glyph, { width: 14, height: 14 }]}><ActivityIndicator color={color.textMuted} size={14} /></View> : <Glyph icon={UserRound} size={14} tint={color.textMuted} />}
                <Text numberOfLines={1} style={[styles.accountText, { maxWidth: narrow ? 96 : 160 }]}>{accountName}</Text>
              </Pressable>
            ) : null}
            {hasAppUpdate(appUpdate) ? (
              <Pressable accessibilityLabel={`有新版本${appUpdate?.version ? ` v${appUpdate.version}` : ""}，在设置里更新`} accessibilityRole="button" onPress={() => onOpenPreferences("about")} style={(state) => [styles.pill, hovered(state) && styles.pillHover, pointer, ease("background-color", 140)]} testID="update-pill">
                <View style={styles.pillDot} />
                <Text numberOfLines={1} style={styles.pillText}>有新版本</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.topActions}>
            <Button icon={Settings} label="设置" onPress={() => onOpenPreferences()} />
            <Button icon={LayoutDashboard} label="进入工作台" onPress={onOpenDashboard} />
            <Button disabled={!setup.ready || switchingAccount} icon={ArrowRight} iconAfter kind="primary" label="打开报告" onPress={onEnterWorkspace} />
          </View>
        </View>
      </View>

      {/* 整页锁在一屏里：两栏按剩下的高度伸缩，图表和提示按量到的空间决定画多少；ScrollView 只是兜底 */}
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingHorizontal: gutter }, short && styles.scrollShort, roomy && styles.scrollRoomy]} showsVerticalScrollIndicator={false} style={styles.scroll}>
        <View style={styles.page}>
          <View style={[styles.head, short && styles.headShort, roomy && styles.headRoomy]}>
            <View style={styles.flex}>
              {/* 标题里别出现「打开报告」四个字：脚本按全文找那个按钮 */}
              <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, roomy && styles.titleRoomy, tight && styles.titleTight]}>先连接数据，再看报告</Text>
              <Text numberOfLines={narrow ? 2 : 1} style={[styles.lead, roomy && styles.leadRoomy]}>连接本机的采集器，或者导入一份个人档案。数据只留在这台电脑上，不会上传。</Text>
            </View>
            <Stepper archive={setup.fromArchive} compact={narrow} flow={setup.flow} />
          </View>

          <View style={[styles.columns, narrow && styles.columnsNarrow, roomy && styles.columnsRoomy]}>
            {/* 左栏：数据从哪来 */}
            <View style={[styles.panel, pad, { width: leftW }]}>
              <PanelHead detail={short ? undefined : "本机采集器读取，不经过云端"} title="数据来源" />
              <Field accessibilityLabel="采集服务地址" autoCapitalize="none" autoCorrect={false} dim={connected} editable={!connected && !busy} inline={short} label="服务地址" onChangeText={onChangeCollectorUrl} placeholder="http://127.0.0.1:4765" value={collectorUrl} />
              {/* 配对码先挑出数字再截 8 位：粘贴带空格或前缀的也认得出来 */}
              {!connected ? <Field accessibilityLabel="8 位配对码" editable={!busy} icon={LockKeyhole} inline={short} keyboardType="number-pad" label="配对码" onChangeText={(value) => onChangePairingCode(value.replace(/\D/gu, "").slice(0, 8))} placeholder="连接时自动获取" value={pairingCode} /> : null}
              <Button busy={busy} disabled={busy} full icon={connected ? Unplug : Link2} kind={connected ? "secondary" : "primary"} label={connected ? "断开连接" : "连接采集器"} onPress={() => void (connected ? onDisconnect() : onConnect())} />
              {/* 状态、报错和提示共用按钮下面这块地方：报错先排，然后是采集器的原话（至少一行），剩下的再放提示 */}
              <FitSlot style={styles.slotMessages}>{(size) => <Messages error={error} size={size} status={statusMessage} tips={tips} />}</FitSlot>
              <View style={[styles.rule, short && styles.ruleShort]} />
              <View testID="archive-card">
                <View style={styles.archiveHead}>
                  <Text numberOfLines={1} style={styles.sectionTitle}>或者导入个人档案</Text>
                  {archive?.loaded ? <Text numberOfLines={1} style={styles.inUse}>正在使用</Text> : null}
                </View>
                {archive ? <Text numberOfLines={1} style={styles.archiveName}>{archive.name}</Text> : null}
                {/* 档案说明写全（最多 6 行）：上面的消息区是伸缩的，会自己让出高度 */}
                <Text numberOfLines={archive ? 6 : 2} style={styles.meta}>{archive?.detail ?? "JSON 或 ZIP，只在本次打开时读取"}</Text>
                <View style={styles.archiveActions}>
                  <Button busy={pickingArchive} compact={narrow} disabled={pickingArchive} icon={FileArchive} label={archive ? "重新选择" : "选择文件"} onPress={() => void onPickArchive()} size="small" />
                  {archive?.mergeable && !pickingArchive ? <Button compact={narrow} disabled={busy} icon={Database} label="并入本机记录" onPress={onMergeArchive} size="small" /> : null}
                  {archive && !pickingArchive ? <Button compact={narrow} icon={X} label="移除" onPress={onRemoveArchive} size="small" /> : null}
                </View>
              </View>
            </View>

            {/* 右栏：读到了什么、怎么读 */}
            <View onLayout={onRightLayout} style={[styles.panel, styles.right, pad]}>
              <View style={styles.recordHead}>
                <Text numberOfLines={1} style={styles.panelTitle}>内容记录</Text>
                <Text numberOfLines={1} style={[styles.meta, styles.flex]}>{recordSummary(total, digest.first)}</Text>
                {snapshotUpdatedAt && !narrow ? <Text numberOfLines={1} style={styles.fine}>更新于 {formatDate(snapshotUpdatedAt)}</Text> : null}
              </View>
              <View style={[styles.counts, short && styles.countsShort]}>
                <Count first label="观看历史" size={numberSize} value={counts.watch} />
                <Count label="喜欢" size={numberSize} value={counts.liked} />
                <Count label="收藏" size={numberSize} value={counts.favorite} />
                <Count label="聊天" size={numberSize} value={counts.chat} />
              </View>
              <FitSlot style={[styles.slotData, short && styles.slotDataShort]}>{(size) => <DataArea digest={digest} roomy={roomy} size={size} />}</FitSlot>
              <ChatProgress progress={setup.chatProgress} />
              <ReadButtons actions={actions} oneRow={oneRow} onRun={run} />
              <Text style={styles.hint}>完整读取和手动监听会先暂停接收聊天。</Text>
              <View style={[styles.rule, short && styles.ruleShort]} />
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: autoSyncEnabled }} aria-checked={autoSyncEnabled} onPress={onToggleAutoSync} style={(state) => [styles.auto, pointer, state.pressed && styles.autoPressed]}>
                <View style={styles.flex}>
                  <Text style={styles.strong}>自动补读新记录</Text>
                  {tight ? null : <Text numberOfLines={1} style={styles.fine}>应用回到前台时，自动读取新增的记录。</Text>}
                </View>
                <Text style={[styles.autoState, autoSyncEnabled && styles.autoStateOn]}>{autoSyncEnabled ? "已开启" : "已暂停"}</Text>
                <Switch on={autoSyncEnabled} />
              </Pressable>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------- 小部件 ----------

/** lucide 的裸 svg 在 RN-web 的 flex 里会被压没，外面套一个定宽定高的盒子 */
function Glyph({ icon: GlyphIcon, size = 16, tint }: { icon: Icon; size?: number; tint: string }) {
  return <View style={[styles.glyph, { width: size, height: size }]}><GlyphIcon color={tint} size={size} strokeWidth={1.75} /></View>;
}

function Button({ accessibilityLabel, active, busy, compact, disabled, full, icon, iconAfter, kind = "secondary", label, onPress, size = "medium", style, testID }: {
  accessibilityLabel?: string;
  active?: boolean;
  busy?: boolean;
  /** 窄栏里的小按钮：图标和左右留白收一点，三个能排一行 */
  compact?: boolean;
  disabled?: boolean;
  full?: boolean;
  icon: Icon;
  iconAfter?: boolean;
  kind?: "primary" | "secondary";
  label: string;
  onPress: () => void;
  size?: "medium" | "small";
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const primary = kind === "primary";
  const small = size === "small";
  const tint = primary ? color.buttonText : color.text;
  const glyphSize = small ? (compact ? 13 : 14) : 16;
  const glyph = busy
    ? <View style={[styles.glyph, { width: glyphSize, height: glyphSize }]}><ActivityIndicator color={tint} size={glyphSize} /></View>
    : <Glyph icon={icon} size={glyphSize} tint={tint} />;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      aria-busy={busy || undefined}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={(state) => [
        styles.button,
        small && styles.buttonSmall,
        small && compact && styles.buttonCompact,
        primary ? styles.primary : styles.secondary,
        active && styles.active,
        !disabled && hovered(state) && (primary ? styles.primaryHover : styles.secondaryHover),
        !disabled && state.pressed && (primary ? styles.primaryPressed : styles.secondaryPressed),
        disabled ? styles.disabled : pointer,
        full && styles.full,
        ease("background-color, border-color", 140),
        style,
      ]}
    >
      {iconAfter ? null : glyph}
      <Text numberOfLines={1} style={[styles.buttonText, small && styles.buttonTextSmall, { color: tint }]}>{label}</Text>
      {iconAfter ? glyph : null}
    </Pressable>
  );
}

/** 带标签的输入框；矮窗口里标签放到框的左边，省一行。聚焦时描边变成墨色（浏览器自带的外框关掉了） */
function Field({ dim, icon, inline, label, ...input }: Omit<TextInputProps, "style" | "onFocus" | "onBlur" | "placeholderTextColor"> & { dim?: boolean; icon?: Icon; inline?: boolean; label: string }) {
  const [focused, setFocused] = useState(false);
  const box = (
    <View style={[styles.field, inline && styles.fieldInline, input.editable === false && styles.fieldDisabled, focused && styles.fieldFocused, ease("border-color", 120)]}>
      {icon ? <Glyph icon={icon} size={14} tint={color.textMuted} /> : null}
      <TextInput {...input} onBlur={() => setFocused(false)} onFocus={() => setFocused(true)} placeholderTextColor={color.textMuted} style={[styles.input, noOutline, dim && styles.inputDisabled]} />
    </View>
  );
  return inline
    ? <View style={styles.fieldRow}><Text numberOfLines={1} style={[styles.label, styles.labelInline]}>{label}</Text>{box}</View>
    : <><Text style={styles.label}>{label}</Text>{box}</>;
}

function PanelHead({ detail, title }: { detail?: string; title: string }) {
  return (
    <View style={styles.panelHead}>
      <Text numberOfLines={1} style={styles.panelTitle}>{title}</Text>
      {detail ? <Text numberOfLines={1} style={styles.meta}>{detail}</Text> : null}
    </View>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <View style={[styles.switch, on && styles.switchOn, ease("background-color", 160)]}>
      <View style={[styles.knob, ease("transform", 160), on && styles.knobOn]} />
    </View>
  );
}

/** 占住剩下的高度，按量到的空间决定里面画多少；内容绝对定位，不会反过来把栏撑高。 */
function FitSlot({ children, style }: { children: (size: Size) => React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const [size, onLayout] = useSize();
  return (
    <View onLayout={onLayout} style={[styles.slot, style]}>
      {size && size.h > 4 ? <View style={[styles.slotInner, { width: size.w, height: size.h }]}>{children(size)}</View> : null}
    </View>
  );
}

// ---------- 数据流向 ----------

const STEPS = [
  { label: "抖音网页", archive: "档案文件" },
  { label: "本机采集器", archive: "本机解析" },
  { label: "本地记录", archive: "本地记录" },
  { label: "报告", archive: "报告" },
];

/** 四步走到哪了：做完的实心圆，当前这一步描边加粗、后面跟一句该做什么 */
function Stepper({ archive, compact, flow }: { archive: boolean; compact: boolean; flow: SetupFlow }) {
  const name = (index: number) => (archive ? STEPS[index]!.archive : STEPS[index]!.label);
  const noteTone = flow.note === "可以看了" ? styles.noteGood : flow.note === "要登录" ? styles.noteWarn : null;
  return (
    <View accessibilityLabel={`数据流向：${STEPS.map((_, index) => name(index)).join(" → ")}，现在在「${name(flow.step)}」这一步，${flow.note}`} style={styles.steps}>
      {STEPS.map((step, index) => {
        const current = index === flow.step;
        const done = !current && Boolean(flow.done[index]);
        return (
          <React.Fragment key={step.label}>
            {index > 0 ? <View style={[styles.stepLine, compact && styles.stepLineCompact, flow.done[index - 1] && styles.stepLineOn]} /> : null}
            <View style={styles.step}>
              <View style={[styles.stepDot, done && styles.stepDotDone, current && styles.stepDotCurrent]}>
                <Text style={[styles.stepNum, done && styles.stepNumDone, current && styles.stepNumCurrent]}>{index + 1}</Text>
              </View>
              <Text numberOfLines={1} style={[styles.stepLabel, (done || current) && styles.stepLabelOn, current && styles.stepLabelCurrent]}>{name(index)}</Text>
              {current && !compact ? <Text numberOfLines={1} style={[styles.stepNote, noteTone]}>{flow.note}</Text> : null}
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

// ---------- 状态、报错和提示 ----------

type Message = { key: string; tone: "status" | "error" | "inlineError" | "tip" | "note"; title?: string; body: string; lines: number; order: number };

// 估一段字要占几行：汉字和全角标点按一个字号宽，西文数字按 0.6 个；按宽度的 94% 折行，宁可估多
function lineCount(text: string, fontSize: number, width: number): number {
  let used = 0;
  for (const char of text) used += char.charCodeAt(0) < 0x2000 ? fontSize * 0.6 : fontSize;
  return Math.max(1, Math.ceil(used / Math.max(40, width * 0.94)));
}

const MESSAGE_GAP = 14;
// 每种消息除正文外占的高度（标题行 + 上下内边距）和正文的字号、行高
const LOOK = {
  status: { font: 13, line: 20, head: 0, pad: 0 },
  error: { font: 12, line: 18, head: 22, pad: 20 },
  inlineError: { font: 12, line: 18, head: 0, pad: 0 },
  tip: { font: 13, line: 20, head: 22, pad: 0 },
  note: { font: 12, line: 18, head: 20, pad: 0 },
} as const;

/**
 * 按剩下的高度挑着放：报错一定放（地方不够就缩成一行红字），其次是采集器的原话（至少留一行，常是「请登录」这类要用户动手的话），
 * 再是跟着状态走的提示，再有地方才放隐私和换电脑两条。行数是估的，Text 再用 numberOfLines 兜住，估少了只会省略、不会被切掉半行。
 */
function Messages({ error, size, status, tips }: { error: string | null; size: Size; status: string | null; tips: SetupTip[] }) {
  const shown: Message[] = [];
  let used = 0;
  const place = (item: Omit<Message, "lines">, mode: "full" | "shrink", height = size.h): boolean => {
    const look = LOOK[item.tone];
    const need = lineCount(item.body, look.font, size.w - (item.tone === "error" ? 24 : 0));
    const gap = shown.length ? MESSAGE_GAP : 0;
    const fit = Math.floor((height - used - gap - look.head - look.pad) / look.line);
    const lines = fit >= need ? need : mode === "shrink" && fit >= 1 ? fit : 0;
    if (!lines) return false;
    shown.push({ ...item, lines });
    used += gap + look.head + look.pad + lines * look.line;
    return true;
  };
  const tip = tips.find((item) => item.key === "tip");
  const rest = tips.filter((item) => item !== tip);
  // 报错先排，但给采集器的原话留出一行；实在挤不下才让报错用满
  const reserve = status ? MESSAGE_GAP + LOOK.status.head + LOOK.status.pad + LOOK.status.line : 0;
  if (error) {
    const box = { key: "error", tone: "error", title: "连接或读取失败", body: error, order: 1 } as const;
    const inline = { key: "error", tone: "inlineError", body: `连接或读取失败：${error}`, order: 1 } as const;
    if (!place(box, "shrink", size.h - reserve) && !place(inline, "shrink", size.h - reserve)) place(inline, "shrink");
  }
  if (status) place({ key: "status", tone: "status", body: status, order: 0 }, "shrink");
  if (tip) place({ key: tip.key, tone: "tip", title: tip.title, body: tip.body, order: 2 }, "shrink");
  for (const note of rest) place({ key: note.key, tone: "note", title: note.title, body: note.body, order: 3 }, "full");
  if (!shown.length) return null;
  return (
    <View style={styles.messages}>
      {shown.sort((a, b) => a.order - b.order).map((item) => item.tone === "error" ? (
        <View accessibilityRole="alert" key={item.key} style={styles.error}>
          <Text numberOfLines={1} style={styles.errorTitle}>{item.title}</Text>
          <Text numberOfLines={item.lines} style={styles.errorText}>{item.body}</Text>
        </View>
      ) : item.tone === "inlineError" ? (
        <Text accessibilityRole="alert" key={item.key} numberOfLines={item.lines} style={styles.errorInline}>{item.body}</Text>
      ) : item.tone === "status" ? (
        <Text key={item.key} numberOfLines={item.lines} style={styles.statusMessage}>{item.body}</Text>
      ) : (
        <View key={item.key}>
          <Text numberOfLines={1} style={item.tone === "tip" ? styles.tipTitle : styles.noteTitle}>{item.title}</Text>
          <Text numberOfLines={item.lines} style={item.tone === "tip" ? styles.tipBody : styles.noteBody}>{item.body}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------- 计数、进度、按钮 ----------

function Count({ first, label, size, value }: { first?: boolean; label: string; size: number; value: number }) {
  const shown = useCountUp(value);
  const digits = value.toLocaleString("zh-CN").length;
  const fontSize = digits <= 5 ? size : digits === 6 ? Math.round(size * 0.88) : Math.round(size * 0.78);
  return (
    <View style={[styles.count, !first && styles.countRule]}>
      <Text numberOfLines={1} style={styles.countLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.countValue, { fontSize, lineHeight: Math.round(size * 1.25) }]}>{shown.toLocaleString("zh-CN")}</Text>
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
      <View style={styles.track}><View style={[styles.trackFill, { width: `${percent ?? 35}%` }, percent === null && styles.trackFillUnknown, ease("width", 300)]} /></View>
      <Text numberOfLines={1} style={styles.progressValue}>{progress.total > 0 ? `会话 ${progress.current}/${progress.total}` : "正在读取会话列表"}</Text>
    </View>
  );
}

function ReadButtons({ actions, onRun, oneRow }: { actions: ReadAction[]; onRun: (command: ReadCommand) => void; oneRow: boolean }) {
  const rows = oneRow ? [actions] : [actions.slice(0, 3), actions.slice(3)];
  return (
    <View style={styles.actions}>
      {rows.map((row, index) => (
        <View key={index} style={styles.actionRow}>
          {row.map((action) => (
            <Button
              active={action.icon === "pause"}
              busy={action.busy}
              disabled={action.disabled}
              icon={READ_ICONS[action.icon]}
              key={action.key}
              label={action.label}
              onPress={() => onRun(action.command)}
              style={styles.action}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------- 图表与最近记录 ----------

/** 右栏中间的数据区：按天的柱图，地方够就加一条一天 24 小时的分布；宽的时候右边再列最近的记录。 */
function DataArea({ digest, roomy, size }: { digest: RecordDigest; roomy: boolean; size: Size }) {
  const withList = size.w >= 700;
  const listW = withList ? Math.round(Math.min(380, Math.max(260, size.w * 0.36))) : 0;
  const gap = withList ? (size.w >= 1000 ? 48 : 32) : 0;
  const chartW = size.w - listW - gap;
  return (
    <View style={[styles.dataArea, { width: size.w, height: size.h }]}>
      <Charts digest={digest} height={size.h} roomy={roomy} width={chartW} />
      {withList ? <View style={[styles.dataDivider, { marginHorizontal: gap / 2 - 0.5 }]} /> : null}
      {withList ? <RecentList digest={digest} height={size.h} roomy={roomy} width={listW} /> : null}
    </View>
  );
}

const HEAD_H = 22;
const AXIS_H = 18;

function Charts({ digest, height, roomy, width }: { digest: RecordDigest; height: number; roomy: boolean; width: number }) {
  const length = width >= 320 ? 30 : 14;
  const win = useMemo(() => dayWindow(digest, length), [digest, length]);
  // 高度够就在下面加一天 24 小时：很高时画成细柱，中等时是一条小方格，再矮就不画
  // 按天那张先保证柱子有 80px 上下，剩下的才给按小时那条
  const hourMode: "bars" | "strip" | null = height >= 300 ? "bars" : height >= 215 ? "strip" : null;
  const hourH = hourMode === "bars" ? Math.round(Math.min(roomy ? 180 : 150, (height - 24) * 0.36)) : hourMode === "strip" ? HEAD_H + 6 + 18 + AXIS_H : 0;
  const gap = hourMode ? 24 : 0;
  const dayH = height - hourH - gap;
  if (!win) {
    // 空的时候按小时那张只画一条浅灰方格，省下的高度都给上面的占位
    const text = digest.total ? "读到的记录都没有日期，画不出按天的条数。" : "还没有带日期的记录。读取之后，这里会按天画出条数。";
    const stripH = hourMode ? HEAD_H + 6 + 18 + AXIS_H + gap : 0;
    return (
      <View style={{ width, height }}>
        <EmptyBars count={length} height={height - stripH} text={text} title={`最近 ${length} 天每天的记录`} width={width} />
        {hourMode ? <View style={{ marginTop: gap }}><HourChart hours={null} mode="strip" width={width} /></View> : null}
      </View>
    );
  }
  const first = win.days[0]!.day;
  const mid = win.days[Math.floor(win.days.length / 2)]!.day;
  const last = win.days[win.days.length - 1]!.day;
  const summary = !win.sum ? "这段时间没有记录" : win.activeDays === win.days.length ? `${win.days.length} 天里天天都有记录` : `${win.days.length} 天里有 ${win.activeDays} 天有记录`;
  if (dayH < HEAD_H + AXIS_H + 40) {
    return height >= 20 ? <Text numberOfLines={2} style={[styles.meta, { width }]}>{`${summary}${win.max ? `，最多的一天 ${win.max} 条` : ""}。`}</Text> : null;
  }
  const title = win.endsToday ? `最近 ${win.days.length} 天每天的记录` : `到 ${formatLongDay(last)}为止的 ${win.days.length} 天`;
  return (
    <View style={{ width, height }}>
      <View style={[styles.chartHead, { width }]}>
        <Text numberOfLines={1} style={[styles.chartTitle, styles.flex]}>{title}</Text>
        <Text numberOfLines={1} style={styles.fine}>{width >= 380 ? summary : win.max ? `最多 ${win.max} 条` : summary}</Text>
      </View>
      <Bars height={dayH - HEAD_H - AXIS_H} highlight={win.max ? win.maxIndex : -1} today={win.endsToday ? win.days.length - 1 : -1} values={win.days.map((day) => day.count)} width={width} />
      <Axis count={win.days.length} marks={[[0, formatDay(first)], [Math.floor(win.days.length / 2), formatDay(mid)], [win.days.length - 1, win.endsToday ? "今天" : formatDay(last)]]} width={width} />
      {hourMode ? <View style={{ marginTop: gap }}><HourChart barsHeight={hourMode === "bars" ? hourH - HEAD_H - AXIS_H : 0} hours={digest.perHour} mode={hourMode} width={width} /></View> : null}
    </View>
  );
}

/** 一排细柱：灰色，最高那天和今天用蓝；最高那根头上写条数，零值不画。 */
function Bars({ height, highlight, today, values, width }: { height: number; highlight: number; today: number; values: number[]; width: number }) {
  const max = Math.max(1, ...values);
  const slot = width / values.length;
  const barW = Math.max(3, Math.min(14, Math.round(slot * 0.5)));
  const labelRoom = highlight >= 0 && height >= 60 ? 16 : 0;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.bars, { height, width }]}>
      {values.map((value, index) => {
        const on = index === highlight || (index === today && value > 0);
        const barH = value ? Math.max(2, Math.round(((height - labelRoom) * value) / max)) : 0;
        return (
          <View key={index} style={[styles.barSlot, { width: slot }]}>
            {index === highlight && labelRoom ? <Text numberOfLines={1} style={styles.barValue}>{value}</Text> : null}
            {barH ? <View style={[styles.bar, { width: barW, height: barH }, on && styles.barOn]} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** 刻度字对准各自那根柱子的中线；两头的字不出图表边 */
function Axis({ count, marks, width }: { count: number; marks: Array<[number, string]>; width: number }) {
  const slot = width / count;
  return (
    <View style={[styles.axis, { width }]}>
      {marks.map(([index, label]) => {
        // 估字宽：数字按 0.62 个字号，汉字一个字号，空格 0.3 个
        const textW = Array.from(label).reduce((sum, char) => sum + (char === " " ? 3.3 : char.charCodeAt(0) < 0x2000 ? 6.8 : 11), 0) + 6;
        const left = Math.max(0, Math.min(width - textW, index * slot + slot / 2 - textW / 2));
        return <Text key={`${index}-${label}`} numberOfLines={1} style={[styles.axisText, { left, width: textW }]}>{label}</Text>;
      })}
    </View>
  );
}

const HOUR_MARKS: Array<[number, string]> = [[0, "0 点"], [6, "6 点"], [12, "12 点"], [18, "18 点"], [23, "23 点"]];

/** 一天 24 小时：矮的时候是一条小方格（颜色越深条数越多），高的时候画成细柱；没有数据时是一条浅灰方格。 */
function HourChart({ barsHeight = 0, hours, mode, width }: { barsHeight?: number; hours: number[] | null; mode: "bars" | "strip"; width: number }) {
  const values = hours ?? Array.from({ length: 24 }, () => 0);
  const max = Math.max(0, ...values);
  const peak = max ? values.indexOf(max) : -1;
  return (
    <View style={{ width }}>
      <View style={styles.chartHead}>
        <Text numberOfLines={1} style={[styles.chartTitle, hours ? null : styles.chartTitleEmpty, styles.flex]}>一天里各个钟点的记录</Text>
        {peak >= 0 ? <Text numberOfLines={1} style={styles.fine}>{`${hourName(peak)}最多，${max} 条`}</Text> : null}
      </View>
      {mode === "bars" && max ? (
        <Bars height={barsHeight} highlight={peak} today={-1} values={values} width={width} />
      ) : (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.strip}>
          {values.map((value, index) => {
            // 最多的那个钟点用最深的一档，其余按比例落在浅蓝四档里
            const level = !max || !value ? 0 : index === peak ? 5 : Math.min(4, 1 + Math.floor((value / max) * 3.999));
            return <View key={index} style={[styles.cell, { backgroundColor: color.heat[level] }]} />;
          })}
        </View>
      )}
      <Axis count={24} marks={HOUR_MARKS} width={width} />
    </View>
  );
}

/** 没数据时的占位：一排很浅的灰柱，上面一句话说清楚这里会画什么。 */
function EmptyBars({ count, height, text, title, width }: { count: number; height: number; text: string; title: string; width: number }) {
  const barsH = Math.max(0, height - HEAD_H - AXIS_H);
  const slot = width / count;
  const barW = Math.max(3, Math.min(14, Math.round(slot * 0.5)));
  return (
    <View style={{ width, height }}>
      <View style={styles.chartHead}><Text numberOfLines={1} style={[styles.chartTitle, styles.chartTitleEmpty]}>{title}</Text></View>
      <View style={[styles.bars, { height: barsH, width }]}>
        {Array.from({ length: count }, (_, index) => (
          <View key={index} style={[styles.barSlot, { width: slot }]}>
            <View style={[styles.bar, styles.barGhost, { width: barW, height: Math.round(barsH * (0.16 + 0.14 * (1 + Math.sin(index * 0.62 + 0.8)) / 2)) }]} />
          </View>
        ))}
        {barsH >= 40 ? <View style={styles.emptyNote}><Text numberOfLines={2} style={styles.emptyText}>{text}</Text></View> : null}
      </View>
      <View style={styles.axis} />
      {barsH < 40 ? <Text numberOfLines={1} style={styles.meta}>{text}</Text> : null}
    </View>
  );
}

const KIND_LABEL: Record<SetupRecordKind, string> = { watch: "看过", liked: "喜欢", favorite: "收藏" };

/** 最近的几条记录：按发生时间倒序，放得下几条列几条，行间一道发丝线。 */
function RecentList({ digest, height, roomy, width }: { digest: RecordDigest; height: number; roomy: boolean; width: number }) {
  const rowH = roomy ? 32 : 29;
  const rows = Math.max(0, Math.floor((height - HEAD_H - 6) / rowH));
  const items = digest.recent.slice(0, rows);
  return (
    <View style={{ width, height }}>
      <View style={styles.chartHead}>
        <Text numberOfLines={1} style={[styles.chartTitle, styles.flex]}>最近的记录</Text>
        <Text numberOfLines={1} style={styles.fine}>按发生时间</Text>
      </View>
      <View style={styles.recentList}>
        {items.length ? items.map((item) => (
          <View accessibilityLabel={`${KIND_LABEL[item.kind]}：${item.title}`} key={item.id} style={[styles.recentRow, { height: rowH }]}>
            <Text numberOfLines={1} style={styles.recentKind}>{KIND_LABEL[item.kind]}</Text>
            <Text numberOfLines={1} style={styles.recentTitle}>{item.title}</Text>
            <Text numberOfLines={1} style={styles.recentTime}>{formatWhen(item.at)}</Text>
          </View>
        )) : <>
          <Text numberOfLines={2} style={[styles.meta, styles.recentEmpty]}>{digest.total ? "这些记录没有日期，排不出先后。" : "读到记录以后，最近的几条会列在这里。"}</Text>
          {Array.from({ length: Math.max(0, Math.min(6, rows - 2)) }, (_, index) => (
            <View key={index} style={[styles.recentRow, { height: rowH }]}>
              <View style={[styles.ghostLine, { width: 24 }]} />
              <View style={[styles.ghostLine, styles.flex, { maxWidth: `${46 + ((index * 23) % 34)}%` }]} />
              <View style={[styles.ghostLine, { width: 30, marginLeft: "auto" }]} />
            </View>
          ))}
        </>}
      </View>
    </View>
  );
}

// ---------- 样式 ----------

const sans = font.sans;
const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

const styles = StyleSheet.create({
  base: { fontFamily: sans, color: color.textSecondary },
  root: { flex: 1, minHeight: "100%", backgroundColor: color.canvas },
  flex: { flex: 1, minWidth: 0 },
  glyph: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", alignItems: "center", justifyContent: "center" },

  // 顶栏
  topbar: { height: 56, borderBottomWidth: 1, borderBottomColor: color.border, backgroundColor: color.canvas },
  topInner: { flex: 1, width: "100%", alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 14 },
  topInnerNarrow: { gap: 10 },
  brand: { flexShrink: 0, color: color.text, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  topDivider: { width: 1, height: 16, backgroundColor: color.border },
  topStatus: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.frame, flexShrink: 0 },
  dotOn: { backgroundColor: color.green },
  statusText: { flexShrink: 1, minWidth: 0, color: color.textMuted, fontSize: 13, lineHeight: 20 },
  account: { flexShrink: 0, height: 28, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, marginLeft: 2, borderRadius: 6 },
  accountHover: { backgroundColor: color.surfaceMuted },
  accountText: { color: color.text, fontSize: 13, lineHeight: 20, fontWeight: "500" },
  pill: { flexShrink: 0, height: 24, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 999, backgroundColor: color.cyanSoft },
  pillHover: { backgroundColor: alpha(color.accentAction, 0.14) },
  pillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accentAction },
  pillText: { color: color.accentAction, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  topActions: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8 },

  // 按钮：主 = 墨黑实底，次 = 白底发丝描边
  button: { height: 34, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  buttonSmall: { height: 30, gap: 5, paddingHorizontal: 10 },
  buttonCompact: { gap: 4, paddingHorizontal: 8 },
  primary: { backgroundColor: color.button, borderColor: color.button },
  primaryHover: { backgroundColor: color.accentPressed, borderColor: color.accentPressed },
  primaryPressed: { backgroundColor: color.accentPressed, borderColor: color.accentPressed },
  secondary: { backgroundColor: color.surface, borderColor: color.border },
  secondaryHover: { backgroundColor: color.surfaceMuted },
  secondaryPressed: { backgroundColor: color.accentSoft, borderColor: color.frame },
  active: { borderColor: color.text },
  disabled: { opacity: 0.4 },
  full: { alignSelf: "stretch" },
  buttonText: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  buttonTextSmall: { fontSize: 12, lineHeight: 16 },

  // 页面骨架
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { flexGrow: 1, paddingTop: 28, paddingBottom: 24 },
  scrollShort: { paddingTop: 18, paddingBottom: 18 },
  scrollRoomy: { paddingTop: 36, paddingBottom: 32 },
  page: { flex: 1, width: "100%", maxWidth: PAGE_MAX, alignSelf: "center" },
  head: { flexDirection: "row", alignItems: "flex-end", gap: 24, marginBottom: 22 },
  headShort: { marginBottom: 16 },
  headRoomy: { marginBottom: 28 },
  title: { color: color.text, fontSize: 22, lineHeight: 30, fontWeight: "600" },
  titleRoomy: { fontSize: 26, lineHeight: 34 },
  titleTight: { fontSize: 20, lineHeight: 28 },
  lead: { marginTop: 4, color: color.textMuted, fontSize: 13, lineHeight: 20 },
  leadRoomy: { fontSize: 14, lineHeight: 22 },

  // 流向
  steps: { flexShrink: 0, flexDirection: "row", alignItems: "center", paddingBottom: 2 },
  step: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: color.border, alignItems: "center", justifyContent: "center" },
  stepDotDone: { backgroundColor: color.text, borderColor: color.text },
  stepDotCurrent: { borderColor: color.text, borderWidth: 1.5 },
  stepNum: { color: color.textMuted, fontSize: 10, lineHeight: 12, fontWeight: "600", ...tabular },
  stepNumDone: { color: color.buttonText },
  stepNumCurrent: { color: color.text },
  stepLabel: { color: color.textMuted, fontSize: 13, lineHeight: 18 },
  stepLabelOn: { color: color.textSecondary },
  stepLabelCurrent: { color: color.text, fontWeight: "600" },
  stepNote: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  noteGood: { color: color.green },
  noteWarn: { color: color.amber },
  stepLine: { width: 20, height: 1, marginHorizontal: 8, backgroundColor: color.border },
  stepLineCompact: { width: 12, marginHorizontal: 5 },
  stepLineOn: { backgroundColor: color.textMuted },

  // 两栏
  columns: { flex: 1, minHeight: 0, flexDirection: "row", gap: 20 },
  columnsNarrow: { gap: 16 },
  columnsRoomy: { gap: 24 },
  panel: { minHeight: 0, padding: 20, borderWidth: 1, borderColor: color.border, borderRadius: 12, backgroundColor: color.surface },
  panelTight: { padding: 16 },
  panelRoomy: { padding: 24 },
  right: { flex: 1, minWidth: 0 },
  panelHead: { marginBottom: 14, gap: 2 },
  panelTitle: { flexShrink: 0, color: color.text, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  sectionTitle: { flexShrink: 1, color: color.text, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  label: { color: color.textSecondary, fontSize: 12, lineHeight: 18, fontWeight: "500", marginBottom: 6 },
  meta: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  fine: { flexShrink: 0, color: color.textMuted, fontSize: 12, lineHeight: 18, ...tabular },
  strong: { color: color.text, fontSize: 13, lineHeight: 20, fontWeight: "500" },
  rule: { height: 1, alignSelf: "stretch", backgroundColor: color.borderSoft, marginVertical: 16 },
  ruleShort: { marginVertical: 12 },

  // 输入框
  fieldRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  labelInline: { width: 52, flexShrink: 0, marginBottom: 0 },
  fieldInline: { flex: 1, minWidth: 0, marginBottom: 0 },
  field: { height: 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, marginBottom: 12, borderWidth: 1, borderColor: color.border, borderRadius: 8, backgroundColor: color.surface },
  fieldDisabled: { backgroundColor: color.surfaceRaised },
  fieldFocused: { borderColor: color.text },
  input: { flex: 1, minWidth: 0, alignSelf: "stretch", color: color.text, fontSize: 13, fontFamily: sans, backgroundColor: "transparent", borderWidth: 0, ...tabular },
  inputDisabled: { color: color.textMuted },

  // 状态、报错、提示
  slot: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, alignSelf: "stretch" },
  slotInner: { position: "absolute", left: 0, top: 0, overflow: "hidden" },
  slotMessages: { marginTop: 16 },
  messages: { gap: MESSAGE_GAP },
  statusMessage: { color: color.textSecondary, fontSize: 13, lineHeight: 20 },
  error: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: color.dangerSoft },
  errorTitle: { color: color.danger, fontSize: 13, lineHeight: 20, fontWeight: "600", marginBottom: 2 },
  errorText: { color: color.textSecondary, fontSize: 12, lineHeight: 18 },
  errorInline: { color: color.danger, fontSize: 12, lineHeight: 18 },
  tipTitle: { color: color.text, fontSize: 13, lineHeight: 20, fontWeight: "600", marginBottom: 2 },
  tipBody: { color: color.textMuted, fontSize: 13, lineHeight: 20 },
  noteTitle: { color: color.textSecondary, fontSize: 12, lineHeight: 18, fontWeight: "500", marginBottom: 2 },
  noteBody: { color: color.textMuted, fontSize: 12, lineHeight: 18 },

  // 档案
  archiveHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  inUse: { flexShrink: 0, color: color.green, fontSize: 12, lineHeight: 18 },
  archiveName: { color: color.text, fontSize: 13, lineHeight: 20, fontWeight: "500", marginBottom: 2 },
  archiveActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },

  // 内容记录
  recordHead: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  counts: { flexDirection: "row", marginTop: 16 },
  countsShort: { marginTop: 12 },
  count: { flex: 1, minWidth: 0, gap: 2 },
  countRule: { borderLeftWidth: 1, borderLeftColor: color.borderSoft, paddingLeft: 16 },
  countLabel: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  countValue: { color: color.text, fontWeight: "600", ...tabular },
  slotData: { marginTop: 22, marginBottom: 18 },
  slotDataShort: { marginTop: 16, marginBottom: 14 },
  dataArea: { flexDirection: "row" },
  dataDivider: { width: 1, alignSelf: "stretch", backgroundColor: color.borderSoft },
  chartHead: { height: HEAD_H, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  chartTitle: { color: color.textSecondary, fontSize: 12, lineHeight: 18, fontWeight: "500" },
  chartTitleEmpty: { color: color.textMuted },
  bars: { flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1, borderBottomColor: color.border },
  barSlot: { height: "100%", alignItems: "center", justifyContent: "flex-end" },
  bar: { borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: color.frame },
  barOn: { backgroundColor: color.accentAction },
  barGhost: { backgroundColor: color.surfaceMuted },
  barValue: { color: color.accentAction, fontSize: 11, lineHeight: 14, fontWeight: "600", marginBottom: 2, ...tabular },
  axis: { height: AXIS_H },
  axisText: { position: "absolute", bottom: 0, textAlign: "center", color: color.textMuted, fontSize: 11, lineHeight: 14, ...tabular },
  strip: { height: 18, marginTop: 6, flexDirection: "row", gap: 2 },
  cell: { flex: 1, borderRadius: 3 },
  emptyNote: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  emptyText: { color: color.textMuted, fontSize: 13, lineHeight: 20, textAlign: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: color.surface },
  recentList: { borderTopWidth: 1, borderTopColor: color.borderSoft },
  recentRow: { flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  recentKind: { width: 26, flexShrink: 0, color: color.textMuted, fontSize: 12, lineHeight: 18 },
  recentTitle: { flex: 1, minWidth: 0, color: color.textSecondary, fontSize: 13, lineHeight: 18 },
  recentTime: { flexShrink: 0, color: color.textMuted, fontSize: 12, lineHeight: 18, ...tabular },
  recentEmpty: { paddingVertical: 8 },
  ghostLine: { height: 8, borderRadius: 4, backgroundColor: color.surfaceMuted },

  // 聊天整理进度
  progress: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  track: { flex: 1, height: 4, borderRadius: 999, overflow: "hidden", backgroundColor: color.surfaceMuted },
  trackFill: { height: "100%", borderRadius: 999, backgroundColor: color.accentAction },
  trackFillUnknown: { opacity: 0.35 },
  progressValue: { flexShrink: 0, color: color.textSecondary, fontSize: 12, lineHeight: 18, fontWeight: "500", ...tabular },

  // 读取按钮与自动补读
  actions: { gap: 8 },
  actionRow: { flexDirection: "row", gap: 8 },
  action: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, paddingHorizontal: 8 },
  hint: { marginTop: 8, color: color.textMuted, fontSize: 12, lineHeight: 18 },
  auto: { flexDirection: "row", alignItems: "center", gap: 12 },
  autoPressed: { opacity: 0.7 },
  autoState: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  autoStateOn: { color: color.text },
  switch: { width: 32, height: 18, borderRadius: 999, backgroundColor: color.border, flexShrink: 0 },
  switchOn: { backgroundColor: color.button },
  knob: { position: "absolute", left: 2, top: 2, width: 14, height: 14, borderRadius: 7, backgroundColor: color.white },
  knobOn: { transform: [{ translateX: 14 }] },
});
