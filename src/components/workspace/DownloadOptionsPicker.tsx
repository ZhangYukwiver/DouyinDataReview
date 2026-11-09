import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import downloadQualities from "../../../collector/downloadQualities.json";
import downloadModes from "../../../collector/downloadModes.json";
import type { DownloadMode, DownloadQuality } from "../../services/localCollector";
import { isDesktopApp } from "../../desktopRuntime";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

function DownloadSelect<T extends string>({ label, choices, value, onChange, disabled }: {
  label: string; choices: Record<T, string>; value: T; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <label style={{ display: "flex", alignItems: "center", gap: 12, color: color.textSecondary, fontFamily: font.body, fontSize: 14 }}>
    <span style={{ minWidth: "5em" }}>{label}</span>
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value as T)}
      style={{ minWidth: 170, padding: "7px 10px", borderRadius: radius.small, border: `1px solid ${color.border}`, background: color.surface, color: color.text, font: "inherit" }}>
      {(Object.keys(choices) as T[]).map(key => <option key={key} value={key}>{choices[key]}</option>)}
    </select>
  </label>;
}

export type DownloadOptions = { quality: DownloadQuality; mode: DownloadMode };
export const defaultDownloadOptions: DownloadOptions = { quality: "auto", mode: "combined" };

export function DownloadOptionsPicker({ value, onChange, disabled }: {
  value: DownloadOptions; onChange: (value: DownloadOptions) => void; disabled?: boolean;
}) {
  return <View style={styles.field}>
    <DownloadSelect label="下载清晰度" choices={downloadQualities} value={value.quality} onChange={quality => onChange({ ...value, quality })} disabled={disabled} />
    {value.quality !== "auto" ? <Text style={styles.hint}>缺少所选档位时，优先选较低档中最清晰的。只有更高档时选其中最低档。</Text> : null}
    <DownloadSelect label="下载方式" choices={downloadModes} value={value.mode} onChange={mode => onChange({ ...value, mode })} disabled={disabled} />
  </View>;
}

export function SingleDownloadDialog({ title, onDownload, onClose }: {
  title?: string; onDownload: (options: DownloadOptions) => void; onClose: () => void;
}) {
  const [options, setOptions] = useState(defaultDownloadOptions);
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <Text accessibilityRole="header" style={styles.heading}>下载视频</Text>
        {title ? <Text numberOfLines={2} style={styles.hint}>{title}</Text> : null}
        <DownloadOptionsPicker value={options} onChange={setOptions} />
        {options.mode === "split" ? <Text style={styles.hint}>{isDesktopApp() ? "分别保存无声 MP4 和 M4A 音频。" : "下载一个 ZIP，包含无声 MP4 和 M4A 音频。"}</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>取消</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => onDownload(options)} style={[styles.button, styles.primary]}>
            <Text style={[styles.buttonText, styles.primaryText]}>开始下载</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16, backgroundColor: color.scrim },
  dialog: { width: "100%", maxWidth: 420, padding: 20, gap: 14, backgroundColor: color.surface, borderColor: color.border, borderWidth: 1, borderRadius: radius.medium },
  heading: { fontFamily: font.body, fontSize: 20, fontWeight: "600", color: color.text },
  hint: { fontFamily: font.body, fontSize: 12, lineHeight: 19, color: color.textSecondary },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.small, borderWidth: 1, borderColor: color.border },
  buttonText: { fontFamily: font.body, fontSize: 14, color: color.text },
  primary: { backgroundColor: color.button, borderColor: color.button }, primaryText: { color: color.buttonText },
});
