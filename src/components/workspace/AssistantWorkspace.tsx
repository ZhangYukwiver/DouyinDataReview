import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowUp, Check, CircleAlert, Download, ShieldAlert, Sparkles, Square, SquarePen, X } from "lucide-react-native";
import {
  answerAssistantConfirm, assistantConfigReady, isLocalAiRuntime, loadAssistantConfig, resetAssistant, sendAssistantMessage, stopAssistant,
  type AssistantAction, type AssistantConfirm, type AssistantView,
} from "../../services/assistant";
import type { ExploreConnection } from "../../services/explorer";
import { runtimeProblem } from "./AiRuntimeField";
import { clampSpot, dockPlacement, loadDockSize, loadDockSpot, MIN_SIZE, saveDockSize, saveDockSpot, type DockSide } from "./assistantDock";
import { kit, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { ease, ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 助手的对话页。对话状态由 App 长轮询采集器拿到后传进来（view），这里只管画和发。
// 同一个对话也装在 AssistantDock 的浮动面板里（onClose 有值就是面板模式），任意页面都能打开。

type Props = {
  connection: ExploreConnection | null;
  view: AssistantView | null;
  onOpenSettings: () => void;
  onOpenLink: (url: string) => void;
  onSaveDownload: (id: string, fileName: string | null) => Promise<void>;
  onClose?: () => void;
};

const SUGGESTIONS = [
  "我最近一个月最常看谁的作品？",
  "我一般几点刷抖音最多？",
  "把喜欢里和做饭有关的放进一个叫「做饭」的文件夹",
  "关注的人里谁正在直播？",
];

const web = Platform.OS === "web";
const pointer = web ? ({ cursor: "pointer" } as object) : null;
const grab = web ? ({ cursor: "grab" } as object) : null;
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export function AssistantWorkspace({ connection, view, onOpenSettings, onOpenLink, onSaveDownload, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const config = loadAssistantConfig();
  const ready = assistantConfigReady(config);
  const busy = Boolean(view?.busy) || sending;
  const shown = view?.messages ?? [];
  const panel = Boolean(onClose);
  const close = onClose ? <Pressable accessibilityLabel="收起 AI 助手" accessibilityRole="button" onPress={onClose} style={[styles.close, pointer]} testID="assistant-panel-close">
    <X color={color.textSecondary} size={15} strokeWidth={2} />
  </Pressable> : null;

  // 有新内容就滚到底
  const tail = `${shown.length}:${view?.streaming?.text.length ?? 0}:${view?.streaming?.actions.length ?? 0}:${view?.confirms.length ?? 0}`;
  useEffect(() => { scrollRef.current?.scrollToEnd({ animated: false }); }, [tail]);

  const send = async (text = draft) => {
    const words = text.trim();
    if (!words || busy || !connection) return;
    if (!ready) { onOpenSettings(); return; }
    setLocalError(null);
    const problem = await runtimeProblem(connection, config.runtime);
    if (problem) { setLocalError(problem); return; }
    setSending(true);
    try {
      await sendAssistantMessage(connection, words, config);
      setDraft("");
    } catch (error) {
      setLocalError(message(error, "没发出去，请稍后再试。"));
    } finally {
      setSending(false);
    }
  };
  const act = (work: Promise<unknown>) => { work.catch((error: unknown) => setLocalError(message(error, "没成功，请稍后再试。"))); };

  if (!connection) {
    return <View style={styles.root}>{close ? <View style={[styles.head, styles.panelHead, grab]} testID="assistant-panel-head"><Text style={[styles.panelTitle, { flex: 1 }]}>AI 助手</Text>{close}</View> : null}<View style={styles.gate}>
      <Text style={styles.gateTitle}>先连上采集器</Text>
      <Text style={kit.muted}>AI 助手读的是采集器里的数据，到采集器页连上以后再来。</Text>
    </View></View>;
  }

  const error = localError ?? view?.error ?? null;
  return <View style={styles.root} testID="assistant-workspace">
    <View style={[styles.head, panel && styles.panelHead, panel && grab]} testID={panel ? "assistant-panel-head" : undefined}>
      <View style={{ flex: 1 }}>
        {panel ? <Text style={styles.panelTitle}>AI 助手</Text> : null}
        <Text numberOfLines={1} style={kit.muted}>{ready ? `用的是 ${isLocalAiRuntime(config.runtime) ? (config.runtime === "codex" ? "本机 Codex" : "本机 Claude Code") : config.model}` : "还没配模型"}</Text>
      </View>
      <SmallButton label="设置" onPress={onOpenSettings} />
      <SmallButton label="新对话" disabled={busy || !shown.length} onPress={() => act(resetAssistant(connection))}>
        <SquarePen color={color.textSecondary} size={13} strokeWidth={1.9} />
      </SmallButton>
      {close}
    </View>
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={[styles.list, panel && styles.panelPad]}>
      {!shown.length && !view?.streaming ? <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{ready ? "想知道点什么，或者想让我做点什么？" : "先配一下用哪个 AI"}</Text>
        <Text style={[kit.muted, { textAlign: "center" }]}>我能查你的观看记录、喜欢、收藏、私信和创作者数据，也能替你搜抖音、下载作品、整理文件夹。发私信、点赞、评论这类别人看得到的事，每次都会先问你。</Text>
        {ready ? <View style={styles.chips}>{SUGGESTIONS.map((item) => (
          <Pressable key={item} accessibilityRole="button" onPress={() => void send(item)} style={(state) => [styles.chip, (state as { hovered?: boolean }).hovered && styles.chipHover, pointer, ease("background-color", 140)]} {...ws("btn small")}>
            <Text style={styles.chipText}>{item}</Text>
          </Pressable>
        ))}</View> : <SmallButton label="去设置" onPress={onOpenSettings} />}
      </View> : null}
      {shown.map((item, index) => item.role === "user"
        ? <View key={index} style={styles.userRow}><View style={styles.user} {...ws("e-box")}><Text selectable style={styles.userText}>{item.text}</Text></View></View>
        : <View key={index} style={styles.ai}>
          <Actions actions={item.actions ?? []} onSaveDownload={onSaveDownload} />
          {item.text ? <Markdown compact text={item.text} onLink={onOpenLink} /> : null}
        </View>)}
      {view?.streaming ? <View style={styles.ai}>
        <Actions actions={view.streaming.actions} onSaveDownload={onSaveDownload} />
        {view.streaming.text ? <Markdown compact text={view.streaming.text} onLink={onOpenLink} /> : null}
        {!view.confirms.length ? <View style={styles.thinking}><ActivityIndicator size="small" color={color.cyan} /><Text style={kit.muted}>{view.streaming.actions.some((action) => action.running) ? "正在办…" : "正在想…"}</Text></View> : null}
      </View> : null}
      {view?.confirms.length ? <AssistantConfirmCards connection={connection} confirms={view.confirms} /> : null}
      {error ? <View style={styles.error}><CircleAlert color={color.danger} size={15} strokeWidth={1.9} /><Text style={styles.errorText}>{error}</Text></View> : null}
    </ScrollView>
    <View style={[styles.composer, panel && styles.panelComposer]}>
      <TextInput
        accessibilityLabel="给 AI 助手的话"
        autoFocus={panel}
        multiline
        onChangeText={setDraft}
        onKeyPress={(event) => {
          // 回车发送，Shift+回车换行；输入法正在上屏时不算
          const native = event.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
          if (native.key === "Enter" && !native.shiftKey && !native.isComposing && native.keyCode !== 229) {
            (event as unknown as { preventDefault: () => void }).preventDefault();
            void send();
          }
        }}
        placeholder={ready ? (panel ? "问点什么，或者让我做点什么" : "问点什么，或者让我做点什么（回车发送，Shift+回车换行）") : "先在设置里配好用哪个 AI"}
        placeholderTextColor={color.textMuted}
        style={styles.input}
        testID="assistant-input"
        value={draft}
      />
      {view?.busy ? <Pressable accessibilityLabel="停下" accessibilityRole="button" onPress={() => act(stopAssistant(connection))} style={[styles.send, styles.stop, pointer]} testID="assistant-stop">
        <Square color={color.text} fill={color.text} size={12} />
      </Pressable> : <Pressable accessibilityLabel="发送" accessibilityRole="button" disabled={!draft.trim() || busy} onPress={() => void send()}
        style={[styles.send, (!draft.trim() || busy) && { opacity: 0.35 }, pointer]} testID="assistant-send" {...ws("btn-solid")}>
        {sending ? <ActivityIndicator size="small" color={color.buttonText} /> : <ArrowUp color={color.buttonText} size={16} strokeWidth={2.2} />}
      </Pressable>}
    </View>
  </View>;
}

function Actions({ actions, onSaveDownload }: { actions: AssistantAction[]; onSaveDownload: Props["onSaveDownload"] }) {
  const [saving, setSaving] = useState<string | null>(null);
  if (!actions.length) return null;
  return <View style={styles.actions}>{actions.map((action, index) => (
    <View key={index} style={styles.action}>
      {action.running ? <ActivityIndicator size="small" color={color.textMuted} style={styles.actionIcon} />
        : action.ok ? <Check color={color.green} size={13} strokeWidth={2.2} style={styles.actionIcon} />
          : <X color={color.danger} size={13} strokeWidth={2.2} style={styles.actionIcon} />}
      <Text style={styles.actionText}>{action.label}{action.note ? `：${action.note}` : ""}</Text>
      {action.download ? <SmallButton label={saving === action.download.id ? "保存中…" : "保存"} disabled={saving === action.download.id}
        onPress={() => {
          const { id, fileName } = action.download!;
          setSaving(id);
          void onSaveDownload(id, fileName).finally(() => setSaving(null));
        }}>
        <Download color={color.textSecondary} size={12} strokeWidth={1.9} />
      </SmallButton> : null}
    </View>
  ))}</View>;
}

/** 等用户点头的对外动作。对话页里画在对话末尾；不在对话页时 App 把它浮在右下角。 */
export function AssistantConfirmCards({ connection, confirms, floating = false }: { connection: ExploreConnection; confirms: AssistantConfirm[]; floating?: boolean }) {
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const answer = (id: string, allow: boolean) => {
    setAnswered((current) => ({ ...current, [id]: true }));
    setFailure(null);
    answerAssistantConfirm(connection, id, allow).catch((error: unknown) => {
      // 已经结束（超时、停下）的就不用再说了
      if (!(error instanceof Error && /已经结束/u.test(error.message))) setFailure(message(error, "没交上去，请再点一次。"));
      setAnswered((current) => ({ ...current, [id]: false }));
    });
  };
  return <View style={floating ? styles.floating : styles.confirms} testID="assistant-confirms">{confirms.map((item) => (
    <View key={item.id} style={[styles.card, floating && styles.cardFloating]} {...ws("e-box")}>
      <View style={styles.cardHead}>
        <ShieldAlert color={color.amber} size={16} strokeWidth={1.9} />
        <Text style={styles.cardTitle}>{item.source === "mcp" ? "外部 AI 想" : "AI 想"}{item.action}{item.target ? `：${item.target}` : ""}</Text>
      </View>
      {item.text ? <Text selectable style={styles.cardText}>{item.text}</Text> : null}
      <Text style={kit.muted}>用的是你自己的抖音号，别人看得到。{item.covers ? (item.source === "mcp" ? "允许后 10 分钟内同样的操作不再问。" : "允许后这一轮里同样的操作（换了对象也算）不再问。") : ""}不点的话 15 分钟后自动作罢。</Text>
      <View style={styles.cardButtons}>
        <SmallButton label="不要" disabled={answered[item.id]} onPress={() => answer(item.id, false)} />
        <Pressable accessibilityRole="button" disabled={answered[item.id]} onPress={() => answer(item.id, true)} testID={`assistant-allow-${item.id}`}
          style={[styles.allow, answered[item.id] && { opacity: 0.4 }, pointer]} {...ws("btn-solid")}>
          <Text style={styles.allowText}>允许</Text>
        </Pressable>
      </View>
    </View>
  ))}{failure ? <Text style={styles.errorText}>{failure}</Text> : null}</View>;
}

/**
 * 任意页面右下角的 AI：圆钮点开浮动对话面板（⌘J / Ctrl+J 也行），和对话页是同一个对话。
 * 面板没开时，等确认的对外动作（含外部 AI 经 MCP 发起的）也浮在这里，叠在圆钮旁边。
 * 按住圆钮或面板标题栏能拖到别处，位置记在本机。
 */
export function AssistantDock({ open, button, onToggle, ...chat }: Props & { open: boolean; button: boolean; onToggle: () => void }) {
  const { width, height } = useWindowDimensions();
  const [spot, setSpot] = useState(loadDockSpot);
  const [size, setSize] = useState(loadDockSize);
  const [lock, setLock] = useState<DockSide | null>(null);
  const latest = useRef({ spot, size });
  latest.current = { spot, size };
  const dragged = useRef(false);

  // 按住圆钮或标题栏是挪位置，按住面板角上的把手是改大小
  useEffect(() => {
    if (!web) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const resize = Boolean(target?.closest?.('[data-testid="assistant-panel-resize"]'));
      const handle = resize || target?.closest?.('[data-testid="assistant-fab"]')
        || (!target?.closest?.('[role="button"],button,input,textarea') && target?.closest?.('[data-testid="assistant-panel-head"]'));
      if (event.button !== 0 || !handle) return;
      dragged.current = false;
      const from = latest.current;
      const at = dockPlacement(from.spot, window.innerWidth, window.innerHeight, from.size);
      const room = dockPlacement(from.spot, window.innerWidth, window.innerHeight, { width: Infinity, height: Infinity }, at.side);
      let commit = () => {};
      const body = document.body.style;
      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - event.clientX, dy = move.clientY - event.clientY;
        // 挪过 4px 才算拖，不然就是普通点击
        if (!dragged.current && Math.hypot(dx, dy) < 4) return;
        if (!dragged.current) {
          dragged.current = true;
          body.userSelect = "none"; body.cursor = resize ? resizeCursor(at.side) : "grabbing";
          setLock(at.side);
        }
        if (resize) {
          // 把手在离圆钮最远的角，往外拉就变大；最大到那一侧的空地
          const next = {
            width: Math.round(Math.max(MIN_SIZE.width, Math.min(room.panelWidth, at.panelWidth + (at.side.onLeft ? dx : -dx)))),
            height: Math.round(Math.max(MIN_SIZE.height, Math.min(room.panelHeight, at.panelHeight + (at.side.onTop ? dy : -dy)))),
          };
          setSize(next);
          commit = () => saveDockSize(next);
        } else {
          // 起拖时朝哪边展开，松手后只要还放得下就还朝那边
          const next = clampSpot({ ...at.side, right: from.spot.right - dx, bottom: from.spot.bottom - dy }, window.innerWidth, window.innerHeight);
          setSpot(next);
          commit = () => saveDockSpot(next);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!dragged.current) return;
        body.userSelect = ""; body.cursor = "";
        setLock(null);
        commit();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  useEffect(() => {
    if (!web || !button) return;
    // 捕获阶段接：RN-web 的输入框会拦住按键冒泡。ponytail: 年志在 iframe 里，焦点在里面时收不到，点圆钮就行
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") { event.preventDefault(); onToggle(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [button, onToggle]);
  const confirms = chat.view?.confirms ?? [];
  if (!button && !confirms.length) return null;
  const place = dockPlacement(spot, width, height, size, lock);
  const { onLeft, onTop } = place.side;
  return <View pointerEvents="box-none" style={[styles.dock, place.style]}>
    {button && open ? <View accessibilityLabel="AI 助手" style={[styles.panel, { width: place.panelWidth, height: place.panelHeight }]} testID="assistant-panel" {...ws("e-modal")}>
      <AssistantWorkspace {...chat} onClose={onToggle} />
      {web ? <View testID="assistant-panel-resize" style={[styles.resize, onLeft ? { right: 0 } : { left: 0 }, onTop ? { bottom: 0 } : { top: 0 }, { cursor: resizeCursor(place.side) } as object]}>
        <View style={[styles.resizeMark, onLeft ? { right: 5, borderRightWidth: 1.5 } : { left: 5, borderLeftWidth: 1.5 }, onTop ? { bottom: 5, borderBottomWidth: 1.5 } : { top: 5, borderTopWidth: 1.5 }]} />
      </View> : null}
    </View> : confirms.length && chat.connection ? <AssistantConfirmCards connection={chat.connection} confirms={confirms} floating /> : null}
    {button ? <Pressable accessibilityLabel={open ? "收起 AI 助手" : "打开 AI 助手（⌘J）"} accessibilityRole="button"
      onPress={() => { if (dragged.current) dragged.current = false; else onToggle(); }}
      style={(state) => [styles.fab, (state as { hovered?: boolean }).hovered && styles.fabHover, pointer, ease("transform", 160)]} testID="assistant-fab" {...ws("btn-solid")}>
      {open ? <X color={color.buttonText} size={20} strokeWidth={2.2} /> : <Sparkles color={color.buttonText} size={20} strokeWidth={2} />}
    </Pressable> : null}
  </View>;
}

// 左上/右下角是 ↖↘，另两个角是 ↗↙
const resizeCursor = ({ onLeft, onTop }: DockSide) => (onLeft === onTop ? "nwse-resize" : "nesw-resize");

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  gate: { alignItems: "center", gap: 10, paddingVertical: 80, paddingHorizontal: 24 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 28, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  scroll: { flex: 1 },
  list: { gap: 16, paddingHorizontal: 28, paddingVertical: 22, maxWidth: 860, width: "100%", alignSelf: "center" },
  empty: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 12 },
  emptyTitle: { color: color.text, fontFamily: font.body, fontSize: 16, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 6, maxWidth: 620 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderSoft, backgroundColor: color.surface },
  chipHover: { backgroundColor: color.surfaceRaised },
  chipText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12.5 },
  userRow: { alignItems: "flex-end" },
  user: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.medium, backgroundColor: alpha(color.accent, 0.1) },
  userText: { color: color.text, fontFamily: font.body, fontSize: 13.5, lineHeight: 21 },
  ai: { gap: 8 },
  actions: { gap: 4 },
  action: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionIcon: { width: 14 },
  actionText: { flexShrink: 1, color: color.textMuted, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8 },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: radius.small, backgroundColor: alpha(color.danger, 0.08) },
  errorText: { flex: 1, color: color.danger, fontFamily: font.body, fontSize: 12.5, lineHeight: 19 },
  // 输入框自己带边框：各风格的聚焦描边套在它身上，不会框里套框
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 28, paddingTop: 10, paddingBottom: 20, maxWidth: 916, alignSelf: "center", width: "100%" },
  input: { flex: 1, minHeight: 44, maxHeight: 160, color: color.text, fontFamily: font.body, fontSize: 13.5, lineHeight: 20, paddingVertical: 11, paddingHorizontal: 12,
    borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  send: { width: 40, height: 40, marginBottom: 2, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: color.button },
  stop: { backgroundColor: color.surfaceRaised, borderWidth: 1, borderColor: color.border },
  confirms: { gap: 10 },
  floating: { width: 360, maxWidth: "100%", gap: 10 },
  card: { gap: 8, padding: 14, borderRadius: radius.medium, borderWidth: 1, borderColor: alpha(color.amber, 0.5), backgroundColor: color.surface },
  cardFloating: { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 6 } },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  cardText: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, padding: 10, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  cardButtons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  allow: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.small, backgroundColor: color.button },
  allowText: { color: color.buttonText, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
  // 盖在年志（StoryFrame 100）上面，设置等 Modal 仍在它上面；面板用 e-modal 角色，内容年志里拿到不透明的底
  dock: { position: "absolute", gap: 12, zIndex: 200 },
  panel: { overflow: "hidden", borderRadius: radius.large, borderWidth: 1, borderColor: color.border, backgroundColor: color.canvas,
    shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 28, shadowOffset: { width: 0, height: 10 } },
  panelHead: { paddingHorizontal: 16, paddingVertical: 10 },
  panelTitle: { color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  panelPad: { paddingHorizontal: 16, paddingVertical: 16 },
  panelComposer: { paddingHorizontal: 14, paddingBottom: 14 },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  resize: { position: "absolute", width: 16, height: 16, zIndex: 2 },
  resizeMark: { position: "absolute", width: 7, height: 7, borderColor: color.textMuted, opacity: 0.6 },
  fab: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: color.button,
    shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
  fabHover: { transform: [{ scale: 1.06 }] },
});
