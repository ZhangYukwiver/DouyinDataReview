import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatConversationSummary, ChatMessage } from "../../domain/chatRecords";
import { extendLiveHistory, loadLiveMessages, type LiveHistory } from "../../services/chatLive";
import type { ChatSendConnection } from "../../services/chatSend";
import { buildConversationExport, groupSenders, saveConversationExport } from "../../services/conversationExport";
import type { CollectorSnapshot } from "../../services/localCollector";
import type { DataExportSelection } from "../../services/exportData";
import { ease, useCountUp } from "./motion";
import { workspaceColors as color } from "./workspaceTheme";

const RANGES = [{ label: "全部", days: 0 }, { label: "近一年", days: 365 }, { label: "近 30 天", days: 30 }, { label: "近 7 天", days: 7 }] as const;

export function DataExportDialog({ snapshot, onClose, onExport, progress = null }: {
  snapshot: CollectorSnapshot;
  onClose: () => void;
  onExport: (selection: DataExportSelection, since: string | null) => void;
  progress?: { completed: number; total: number } | null;
}) {
  const [selection, setSelection] = useState<DataExportSelection>({ watch_history: true, liked_videos: true, favorite_videos: true, chat: false });
  const [days, setDays] = useState(0);
  // 时间范围只筛观看历史和聊天：喜欢、收藏抖音几乎不给时间
  const since = useMemo(() => (days ? new Date(Date.now() - days * 86_400_000).toISOString() : null), [days]);
  const [watchCount, messageCount] = useMemo(() => {
    const from = since ? Date.parse(since) : null;
    const inRange = (at: string | null | undefined) => from === null || (at ? Date.parse(at) >= from : false);
    return [snapshot.records.watch_history.filter(record => inRange(record.occurredAt)).length, snapshot.chatMessages.filter(message => inRange(message.sentAt)).length];
  }, [snapshot, since]);
  const parts = [
    { key: "watch_history", label: "观看历史", count: watchCount, detail: `${watchCount} 条记录` },
    { key: "liked_videos", label: "喜欢的视频", count: snapshot.records.liked_videos.length, detail: `${snapshot.records.liked_videos.length} 条记录${days ? " · 不分时间" : ""}` },
    { key: "favorite_videos", label: "收藏的视频", count: snapshot.records.favorite_videos.length, detail: `${snapshot.records.favorite_videos.length} 条记录${days ? " · 不分时间" : ""}` },
    { key: "chat", label: "聊天数据", count: messageCount, detail: `${messageCount} 条好友消息 · ${snapshot.chatConversations.length} 个会话（含群聊统计）` },
  ] as const;
  const empty = !Object.values(selection).some(Boolean);
  const exporting = progress !== null;
  // 勾选和导出按钮联动：按钮上直接写要导出多少条，勾一项数字滚一次
  const total = useCountUp(parts.reduce((sum, part) => sum + (selection[part.key] ? part.count : 0), 0), 360);
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View accessibilityViewIsModal style={styles.dialog} testID="data-export-dialog">
        <Text accessibilityRole="header" style={styles.title}>选择导出数据</Text>
        <Text style={styles.detail}>只导出勾选的本地数据。聊天中的语音会通过抖音转成文字，需要联网；未能转写的语音会保留原消息并注明原因。文件可重新导入。</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="时间范围" style={styles.ranges}>
          {RANGES.map(range => <Pressable key={range.days} accessibilityRole="radio" accessibilityState={{ checked: days === range.days, disabled: exporting }} aria-checked={days === range.days}
            disabled={exporting} onPress={() => setDays(range.days)} style={[styles.range, days === range.days && styles.selected, ease("background-color,border-color", 160)]} testID={`data-export-range-${range.days}`}>
            <Text style={[styles.text, days === range.days && { fontWeight: "600" }]}>{range.label}</Text>
          </Pressable>)}
        </View>
        {days ? <Text style={styles.detail}>时间范围只筛观看历史和聊天；抖音不给喜欢、收藏的时间，这两类照样全部导出。</Text> : null}
        {parts.map(({ key, label, detail }) => <Pressable key={key} accessibilityRole="checkbox" accessibilityLabel={label}
          accessibilityState={{ checked: selection[key], disabled: exporting }} aria-checked={selection[key]} disabled={exporting}
          onPress={() => setSelection(current => ({ ...current, [key]: !current[key] }))}
          style={[styles.option, selection[key] && styles.selected, ease("background-color,border-color", 160)]} testID={`data-export-${key}`}>
          <Text style={styles.text}>{selection[key] ? "✓ " : "○ "}{label}</Text><Text style={styles.detail}>{detail}</Text>
        </Pressable>)}
        {selection.chat ? <Text style={styles.detail}>聊天文件包含消息正文和会话信息，请确认保存位置。</Text> : null}
        {empty ? <Text style={styles.detail}>请至少选择一部分数据。</Text> : null}
        {progress ? <Text accessibilityLiveRegion="polite" style={styles.detail}>正在转写语音 {progress.completed} / {progress.total}…</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button} testID="data-export-cancel"><Text style={styles.text}>取消</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="导出所选数据" accessibilityState={{ disabled: empty || exporting }} disabled={empty || exporting}
            onPress={() => onExport(selection, since)} style={[styles.button, styles.selected, (empty || exporting) && { opacity: 0.4 }]} testID="data-export-confirm"><Text style={styles.text}>{exporting ? "正在导出…" : empty ? "导出所选数据" : `导出 ${total.toLocaleString("zh-CN")} 条`}</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const GROUP_RANGES = [{ label: "近 7 天", days: 7 }, { label: "近 30 天", days: 30 }, { label: "近 90 天", days: 90 }, { label: "全部", days: 0 }] as const;
const sentMs = (message: ChatMessage) => Date.parse(message.sentAt ?? "") || 0;
const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

// 群消息本机不存：打开时按范围从抖音往前翻，翻够了再挑成员导出。换更长的范围接着翻，不重读。
export function GroupExportDialog({ connection, conversation, selfId, onClose }: {
  connection: ChatSendConnection;
  conversation: ChatConversationSummary;
  selfId: string | null;
  onClose: () => void;
}) {
  const [days, setDays] = useState<number>(30);
  const sinceMs = useMemo(() => (days ? Date.now() - days * 86_400_000 : 0), [days]);
  const [history, setHistory] = useState<LiveHistory | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // 记没勾的人：后面翻出来的新成员默认就在里面
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const historyRef = useRef<LiveHistory | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    stopRef.current = stop;
    setReading(true);
    setError(null);
    extendLiveHistory((before) => loadLiveMessages(connection, conversation.id, before), historyRef.current, sinceMs, {
      signal: stop.signal, onPage: (next) => { historyRef.current = next; setHistory(next); },
    }).catch((reason) => { if (!stop.signal.aborted) setError(reason instanceof Error ? reason.message : "暂时读不到群消息，请稍后再试。"); })
      .finally(() => { if (!stop.signal.aborted) setReading(false); });
    return () => stop.abort();
  }, [sinceMs]);
  const stopReading = () => { stopRef.current?.abort(); setReading(false); };

  const inRange = useMemo(() => (history?.messages ?? []).filter((message) => !sinceMs || sentMs(message) >= sinceMs), [history, sinceMs]);
  const senders = useMemo(() => groupSenders(inRange, selfId), [inRange, selfId]);
  const chosen = inRange.filter((message) => !excluded.has(message.senderId ?? ""));
  const pickedPeople = senders.filter((sender) => !excluded.has(sender.id)).length;
  const oldest = history?.messages.find((message) => sentMs(message) > 0);
  const covered = Boolean(history && (history.complete || (oldest && sentMs(oldest) < sinceMs)));
  const status = reading ? `正在从抖音读取… 已读到 ${(history?.messages.length ?? 0).toLocaleString("zh-CN")} 条${oldest ? `，最早到 ${day(sentMs(oldest))}` : ""}`
    : error ? error
      : !history ? "已停止读取。"
        : covered ? history.complete && oldest && (!sinceMs || sentMs(oldest) >= sinceMs) ? `已读到抖音能给的最早一条（${day(sentMs(oldest))}），抖音最多给最近一年。` : "这个范围的消息都读到了。"
          : `只读到 ${oldest ? day(sentMs(oldest)) : "最新"} 之后的消息，导出就只有这些。`;
  const rangeLabel = GROUP_RANGES.find((range) => range.days === days)?.label ?? "全部";
  const exportAs = (format: "json" | "txt") => {
    try {
      const note = `群消息从抖音现读，本机不存。范围：${rangeLabel}${sinceMs ? `（${day(sinceMs)} 起）` : ""}；成员：${pickedPeople === senders.length ? "全部" : pickedPeople > 10 ? `${pickedPeople} 人` : senders.filter((sender) => !excluded.has(sender.id)).map((sender) => sender.name).join("、")}。`
        + `${covered ? "" : `只读到 ${oldest ? day(sentMs(oldest)) : "最新"} 之后。`}抖音最多给最近一年；媒体保留链接，语音未转写。`;
      const own = chosen.filter((message) => selfId && message.senderId === selfId).length;
      saveConversationExport(buildConversationExport({ ...conversation, kind: "group", ownMessageCount: own }, chosen, note), selfId, format);
      setDone(`已导出 ${chosen.length.toLocaleString("zh-CN")} 条`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导出失败，请重试。"); }
  };
  const toggle = (id: string) => setExcluded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const blocked = reading || chosen.length === 0;
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View accessibilityViewIsModal style={styles.dialog} testID="group-export-dialog">
        <Text accessibilityRole="header" style={styles.title}>导出群聊记录</Text>
        <Text style={styles.detail}>群消息本机不存，导出时现从抖音往前翻到所选范围，文件里包含消息正文和成员昵称，请确认保存位置。</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="时间范围" style={styles.ranges}>
          {GROUP_RANGES.map((range) => <Pressable key={range.days} accessibilityRole="radio" accessibilityState={{ checked: days === range.days }} aria-checked={days === range.days}
            onPress={() => { setDone(null); setDays(range.days); }} style={[styles.range, days === range.days && styles.selected, ease("background-color,border-color", 160)]} testID={`group-export-range-${range.days}`}>
            <Text style={[styles.text, days === range.days && { fontWeight: "600" }]}>{range.label}</Text>
          </Pressable>)}
        </View>
        <View style={styles.statusRow}>
          <Text accessibilityLiveRegion="polite" style={[styles.detail, { flex: 1 }]} testID="group-export-status">{status}</Text>
          {reading ? <Pressable accessibilityRole="button" onPress={stopReading} style={styles.range} testID="group-export-stop"><Text style={styles.text}>停止</Text></Pressable> : null}
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.text, { flex: 1 }]}>成员 {pickedPeople} / {senders.length}</Text>
          <Pressable accessibilityRole="button" onPress={() => setExcluded(new Set())} style={styles.range} testID="group-export-all"><Text style={styles.text}>全选</Text></Pressable>
          {selfId && senders.some((sender) => sender.id === selfId) ? <Pressable accessibilityRole="button" onPress={() => setExcluded(new Set(senders.filter((sender) => sender.id !== selfId).map((sender) => sender.id)))} style={styles.range} testID="group-export-self"><Text style={styles.text}>只选我</Text></Pressable> : null}
        </View>
        <ScrollView style={styles.members} contentContainerStyle={{ gap: 6 }}>
          {senders.map((sender) => {
            const checked = !excluded.has(sender.id);
            return <Pressable key={sender.id} accessibilityRole="checkbox" accessibilityLabel={sender.name} accessibilityState={{ checked }} aria-checked={checked}
              onPress={() => toggle(sender.id)} style={[styles.member, checked && styles.selected, ease("background-color,border-color", 160)]} testID={`group-export-member-${sender.id}`}>
              <Text numberOfLines={1} style={[styles.text, { flex: 1 }]}>{checked ? "✓ " : "○ "}{sender.name}</Text>
              <Text style={styles.detail}>{sender.count.toLocaleString("zh-CN")} 条</Text>
            </Pressable>;
          })}
          {!senders.length && !reading ? <Text style={styles.detail}>这个范围里没有消息。</Text> : null}
        </ScrollView>
        {done ? <Text accessibilityRole="alert" style={styles.detail}>{done}</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button} testID="group-export-cancel"><Text style={styles.text}>关闭</Text></Pressable>
          {(["txt", "json"] as const).map((format) => <Pressable key={format} accessibilityRole="button" accessibilityState={{ disabled: blocked }} disabled={blocked}
            onPress={() => exportAs(format)} style={[styles.button, format === "txt" && styles.selected, blocked && { opacity: 0.4 }]} testID={`group-export-${format}`}>
            <Text style={styles.text}>{format === "txt" ? `导出文本 ${chosen.length.toLocaleString("zh-CN")} 条` : "导出 JSON"}</Text>
          </Pressable>)}
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  members: { maxHeight: 240 },
  member: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: color.border, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 20 },
  dialog: { width: "100%", maxWidth: 460, padding: 24, gap: 12, borderRadius: 12, backgroundColor: color.surface },
  title: { color: color.text, fontSize: 18, fontWeight: "600" },
  text: { color: color.text, fontSize: 14 },
  detail: { color: color.textSecondary, fontSize: 12, lineHeight: 19 },
  option: { borderWidth: 1, borderColor: color.border, padding: 12, gap: 5, borderRadius: 6 },
  ranges: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  range: { borderWidth: 1, borderColor: color.border, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  selected: { borderColor: color.accent, backgroundColor: color.surfaceMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  button: { borderWidth: 1, borderColor: color.border, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6 },
});
