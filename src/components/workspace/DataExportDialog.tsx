import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { CollectorSnapshot } from "../../services/localCollector";
import type { DataExportSelection } from "../../services/exportData";
import { ease, useCountUp } from "./motion";
import { workspaceColors as color } from "./workspaceTheme";

export function DataExportDialog({ snapshot, onClose, onExport, progress = null }: {
  snapshot: CollectorSnapshot;
  onClose: () => void;
  onExport: (selection: DataExportSelection) => void;
  progress?: { completed: number; total: number } | null;
}) {
  const [selection, setSelection] = useState<DataExportSelection>({ watch_history: true, liked_videos: true, favorite_videos: true, chat: false });
  const parts = [
    { key: "watch_history", label: "观看历史", count: snapshot.records.watch_history.length, detail: `${snapshot.records.watch_history.length} 条记录` },
    { key: "liked_videos", label: "喜欢的视频", count: snapshot.records.liked_videos.length, detail: `${snapshot.records.liked_videos.length} 条记录` },
    { key: "favorite_videos", label: "收藏的视频", count: snapshot.records.favorite_videos.length, detail: `${snapshot.records.favorite_videos.length} 条记录` },
    { key: "chat", label: "聊天数据", count: snapshot.chatMessages.length, detail: `${snapshot.chatMessages.length} 条好友消息 · ${snapshot.chatConversations.length} 个会话（含群聊统计）` },
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
            onPress={() => onExport(selection)} style={[styles.button, styles.selected, (empty || exporting) && { opacity: 0.4 }]} testID="data-export-confirm"><Text style={styles.text}>{exporting ? "正在导出…" : empty ? "导出所选数据" : `导出 ${total.toLocaleString("zh-CN")} 条`}</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 20 },
  dialog: { width: "100%", maxWidth: 460, padding: 24, gap: 12, borderRadius: 12, backgroundColor: color.surface },
  title: { color: color.text, fontSize: 18, fontWeight: "600" },
  text: { color: color.text, fontSize: 14 },
  detail: { color: color.textSecondary, fontSize: 12, lineHeight: 19 },
  option: { borderWidth: 1, borderColor: color.border, padding: 12, gap: 5, borderRadius: 6 },
  selected: { borderColor: color.accent, backgroundColor: color.surfaceMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  button: { borderWidth: 1, borderColor: color.border, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6 },
});
