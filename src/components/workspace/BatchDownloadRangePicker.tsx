import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import { videoDownloadKey } from "../../services/batchVideoDownload";
import { ws } from "./motion";
import { workspaceColors as color, workspaceRadii as radius } from "./workspaceTheme";

function RangeButton({ label, onPress, disabled = false, expanded }: {
  label: string; onPress: () => void; disabled?: boolean; expanded?: boolean;
}) {
  return <Pressable {...ws("btn")} accessibilityRole="button" accessibilityState={{ disabled, expanded }}
    disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.label}>{label}</Text>
  </Pressable>;
}

export function BatchDownloadRangePicker({ candidates, onSelect, skipSaved = false }: {
  candidates: PersonalVideoRecord[]; onSelect: (keys: Set<string>) => void; skipSaved?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState(String(candidates.length));
  const count = candidates.length;
  const first = Number(start);
  const last = Number(end);
  const valid = /^\d+$/u.test(start) && /^\d+$/u.test(end) && first >= 1 && first <= last && last <= count;
  function select(from: number, to: number) {
    onSelect(new Set(candidates.slice(from - 1, to).map((record) => videoDownloadKey(record)!)));
  }
  return <View style={styles.picker}>
    <View style={styles.row}>
      {[10, 50, 100].filter((size) => size < count).map((size) =>
        <RangeButton key={size} label={`前 ${size} 个`} onPress={() => select(1, size)} />)}
      <RangeButton label={skipSaved ? "全选未保存" : "全选"} disabled={!count} onPress={() => select(1, count)} />
      <RangeButton label="自定义范围" expanded={custom} disabled={!count} onPress={() => setCustom(!custom)} />
    </View>
    {custom && count > 0 ? <>
      <Text style={styles.hint}>{skipSaved ? "未保存的可下载视频" : "可下载视频"}按列表顺序编号 1–{count}，起止两项都计入。</Text>
      <View style={styles.row}>
        <TextInput accessibilityLabel="起始序号" keyboardType="number-pad" style={styles.input} value={start} onChangeText={setStart} />
        <Text style={styles.label}>至</Text>
        <TextInput accessibilityLabel="结束序号" keyboardType="number-pad" placeholder={String(count)} placeholderTextColor={color.textMuted}
          style={styles.input} value={end} onChangeText={setEnd} onSubmitEditing={() => { if (valid) select(first, last); }} />
        <RangeButton label="选中范围" disabled={!valid} onPress={() => select(first, last)} />
      </View>
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  picker: { gap: 8 }, row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  button: { borderWidth: 1, borderColor: color.border, borderRadius: radius.small, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: color.surface },
  label: { color: color.textSecondary, fontSize: 12 }, hint: { color: color.textMuted, fontSize: 12 },
  input: { width: 72, paddingVertical: 7, paddingHorizontal: 8, color: color.text, fontSize: 13, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border, borderRadius: radius.small },
  disabled: { opacity: 0.45 },
});
