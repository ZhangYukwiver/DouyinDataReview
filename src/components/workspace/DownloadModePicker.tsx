import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import downloadModes from "../../../collector/downloadModes.json";
import type { DownloadMode } from "../../services/localCollector";
import { isDesktopApp } from "../../desktopRuntime";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

export function DownloadModePicker({ value, onChange, disabled }: {
  value: DownloadMode; onChange: (mode: DownloadMode) => void; disabled?: boolean;
}) {
  return <label style={{ display: "flex", alignItems: "center", gap: 12, color: color.textSecondary, fontFamily: font.body, fontSize: 14 }}>
    下载方式
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value as DownloadMode)}
      style={{ padding: "7px 10px", borderRadius: radius.small, border: `1px solid ${color.border}`, background: color.surface, color: color.text, font: "inherit" }}>
      {Object.entries(downloadModes).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
    </select>
  </label>;
}

export function SingleDownloadDialog({ title, onDownload, onClose }: {
  title?: string; onDownload: (mode: DownloadMode) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<DownloadMode>("combined");
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <Text accessibilityRole="header" style={styles.heading}>下载视频</Text>
        {title ? <Text numberOfLines={2} style={styles.hint}>{title}</Text> : null}
        <DownloadModePicker value={mode} onChange={setMode} />
        {mode === "split" ? <Text style={styles.hint}>{isDesktopApp() ? "分别保存无声 MP4 和 M4A 音频。" : "下载一个 ZIP，包含无声 MP4 和 M4A 音频。"}</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>取消</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => onDownload(mode)} style={[styles.button, styles.primary]}>
            <Text style={[styles.buttonText, styles.primaryText]}>开始下载</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16, backgroundColor: color.scrim },
  dialog: { width: "100%", maxWidth: 420, padding: 20, gap: 14, backgroundColor: color.surface, borderColor: color.border, borderWidth: 1, borderRadius: radius.medium },
  heading: { fontFamily: font.body, fontSize: 20, fontWeight: "600", color: color.text },
  hint: { fontFamily: font.body, fontSize: 12, lineHeight: 19, color: color.textSecondary },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.small, borderWidth: 1, borderColor: color.border },
  buttonText: { fontFamily: font.body, fontSize: 14, color: color.text },
  primary: { backgroundColor: color.button, borderColor: color.button }, primaryText: { color: color.buttonText },
});
