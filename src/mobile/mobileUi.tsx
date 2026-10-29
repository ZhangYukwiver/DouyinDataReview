import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import type { PersonalRecordType } from "../domain/personalRecords";

// Ink night + amber: the same world as the story's entry card, so opening a story feels like going deeper, not elsewhere.
export const C = {
  bg: "#0b0d12", surface: "#14171e", raised: "#1c2029", line: "rgba(243,238,227,0.08)", lineStrong: "rgba(243,238,227,0.16)",
  text: "#f3eee3", sub: "#aaa597", faint: "#6f6b63", accent: "#f0a24e", accentInk: "#1d1306", accentSoft: "rgba(240,162,78,0.14)",
  danger: "#ff8a7a",
};
export const STREAM: Record<PersonalRecordType, string> = { watch_history: "#9cc8e8", liked_videos: "#ff7a66", favorite_videos: "#f0a24e" };
export const serif = "serif", mono = "monospace";

export function Button({ label, onPress, disabled = false, kind = "primary", icon: Icon, grow = false }: {
  label: string; onPress: () => void; disabled?: boolean; kind?: "primary" | "ghost" | "quiet"; icon?: LucideIcon; grow?: boolean;
}) {
  const color = kind === "primary" ? C.accentInk : kind === "ghost" ? C.text : C.accent;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    android_ripple={{ color: kind === "primary" ? "rgba(0,0,0,0.12)" : "rgba(243,238,227,0.08)", borderless: false }}
    style={({ pressed }) => [ui.button, ui[kind], grow && { flex: 1 }, disabled && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
    {Icon ? <Icon size={17} color={color} strokeWidth={2} /> : null}
    <Text numberOfLines={1} style={[ui.buttonText, { color }]}>{label}</Text>
  </Pressable>;
}

export function Segmented<T extends string>({ items, value, onChange }: {
  items: Array<{ id: T; label: string; count?: number; dot?: string }>; value: T; onChange: (value: T) => void;
}) {
  return <View accessibilityRole="tablist" style={ui.segmented}>
    {items.map(item => {
      const on = item.id === value;
      return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(item.id)}
        style={[ui.segment, on && ui.segmentOn]}>
        {item.dot ? <View style={[ui.dot, { backgroundColor: item.dot, opacity: on ? 1 : 0.55 }]} /> : null}
        <Text numberOfLines={1} style={[ui.segmentText, on && { color: C.text }]}>{item.label}</Text>
        {item.count !== undefined ? <Text style={[ui.segmentCount, on && { color: C.sub }]}>{item.count.toLocaleString("zh-CN")}</Text> : null}
      </Pressable>;
    })}
  </View>;
}

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36, gap: 18 },
  eyebrow: { fontFamily: mono, fontSize: 10, letterSpacing: 2.2, color: C.faint },
  heading: { fontSize: 30, lineHeight: 38, fontWeight: "700", color: C.text, letterSpacing: -0.5 },
  card: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, padding: 18, borderRadius: 22, gap: 12 },
  title: { fontSize: 17, lineHeight: 24, fontWeight: "600", color: C.text },
  body: { fontSize: 14, lineHeight: 22, color: C.sub },
  meta: { color: C.faint, fontSize: 12, lineHeight: 18 },
  number: { fontFamily: serif, color: C.text, fontVariant: ["tabular-nums"] },
  button: { flexDirection: "row", gap: 8, borderRadius: 999, minHeight: 48, justifyContent: "center", alignItems: "center", paddingHorizontal: 18, overflow: "hidden" },
  primary: { backgroundColor: C.accent },
  ghost: { backgroundColor: C.raised, borderWidth: 1, borderColor: C.line },
  quiet: { backgroundColor: "transparent", minHeight: 40, paddingHorizontal: 10 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  segmented: { flexDirection: "row", backgroundColor: C.surface, borderRadius: 16, padding: 4, gap: 4, borderWidth: 1, borderColor: C.line },
  segment: { flex: 1, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", minHeight: 40, borderRadius: 12, paddingHorizontal: 6 },
  segmentOn: { backgroundColor: C.raised },
  segmentText: { color: C.faint, fontSize: 14, fontWeight: "600" },
  segmentCount: { color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  dot: { width: 7, height: 7, borderRadius: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  chipOn: { backgroundColor: C.accentSoft, borderColor: "rgba(240,162,78,0.45)" },
  chipText: { color: C.sub, fontSize: 13, fontWeight: "600" },
  empty: { color: C.faint, textAlign: "center", paddingVertical: 48, fontSize: 14, lineHeight: 24 },
});
