import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowUp, Check, CircleAlert, Download, ShieldAlert, Square, SquarePen, X } from "lucide-react-native";
import {
  answerAssistantConfirm, assistantConfigReady, isLocalAiRuntime, loadAssistantConfig, resetAssistant, sendAssistantMessage, stopAssistant,
  type AssistantAction, type AssistantConfirm, type AssistantView,
} from "../../services/assistant";
import type { ExploreConnection } from "../../services/explorer";
import { runtimeProblem } from "./AiRuntimeField";
import { kit, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { ease, ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 助手的对话页。对话状态由 App 长轮询采集器拿到后传进来（view），这里只管画和发。

type Props = {
  connection: ExploreConnection | null;
  view: AssistantView | null;
  onOpenSettings: () => void;
  onOpenLink: (url: string) => void;
  onSaveDownload: (id: string, fileName: string | null) => Promise<void>;
};

const SUGGESTIONS = [
  "我最近一个月最常看谁的作品？",
  "我一般几点刷抖音最多？",
  "把喜欢里和做饭有关的放进一个叫「做饭」的文件夹",
  "关注的人里谁正在直播？",
];

const web = Platform.OS === "web";
const pointer = web ? ({ cursor: "pointer" } as object) : null;
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export function AssistantWorkspace({ connection, view, onOpenSettings, onOpenLink, onSaveDownload }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const config = loadAssistantConfig();
  const ready = assistantConfigReady(config);
  const busy = Boolean(view?.busy) || sending;
  const shown = view?.messages ?? [];

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
    return <View style={styles.root}><View style={styles.gate}>
      <Text style={styles.gateTitle}>先连上采集器</Text>
      <Text style={kit.muted}>AI 助手读的是采集器里的数据，到采集器页连上以后再来。</Text>
    </View></View>;
  }

  const error = localError ?? view?.error ?? null;
  return <View style={styles.root} testID="assistant-workspace">
    <View style={styles.head}>
      <View style={{ flex: 1 }}>
        <Text style={kit.muted}>{ready ? `用的是 ${isLocalAiRuntime(config.runtime) ? (config.runtime === "codex" ? "本机 Codex" : "本机 Claude Code") : config.model}` : "还没配模型"}</Text>
      </View>
      <SmallButton label="设置" onPress={onOpenSettings} />
      <SmallButton label="新对话" disabled={busy || !shown.length} onPress={() => act(resetAssistant(connection))}>
        <SquarePen color={color.textSecondary} size={13} strokeWidth={1.9} />
      </SmallButton>
    </View>
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.list}>
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
    <View style={styles.composer}>
      <TextInput
        accessibilityLabel="给 AI 助手的话"
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
        placeholder={ready ? "问点什么，或者让我做点什么（回车发送，Shift+回车换行）" : "先在设置里配好用哪个 AI"}
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
      <Text style={kit.muted}>用的是你自己的抖音号，别人看得到。不点的话 15 分钟后自动作罢。</Text>
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
  floating: { position: "absolute", right: 20, bottom: 20, width: 360, maxWidth: "90%", gap: 10, zIndex: 50 },
  card: { gap: 8, padding: 14, borderRadius: radius.medium, borderWidth: 1, borderColor: alpha(color.amber, 0.5), backgroundColor: color.surface },
  cardFloating: { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 6 } },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  cardText: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, padding: 10, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  cardButtons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  allow: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.small, backgroundColor: color.button },
  allowText: { color: color.buttonText, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
});
