import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { SmallButton, kit } from "./CreatorKit";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import type { ExploreConnection } from "../../services/explorer";
import { workspaceRequest } from "../../services/contentWorkspace";

/** Only display a response for the connection and filters that requested it. */
export function useWorkspaceRead<T>(connection: ExploreConnection | null, path: string | null, revision = 0) {
  const [result, setResult] = useState<{ key: string; value?: T; error?: string }>();
  const key = JSON.stringify([connection?.baseUrl, connection?.token, path]);
  useEffect(() => {
    if (!connection || !path) return;
    const controller = new AbortController();
    workspaceRequest<T>(connection, path, { signal: controller.signal }).then(
      value => { if (!controller.signal.aborted) setResult({ key, value }); },
      error => { if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "读取失败。" }); },
    );
    return () => controller.abort();
  }, [key, revision]);
  return result?.key === key ? result : undefined;
}

export function SearchField({ label, placeholder, value, onChange, onSubmit }: {
  label: string; placeholder?: string; value: string; onChange: (text: string) => void; onSubmit?: () => void;
}) {
  return <TextInput accessibilityLabel={label} placeholder={placeholder ?? label} placeholderTextColor={color.textMuted}
    style={contentStyles.input} value={value} onChangeText={onChange} onSubmitEditing={onSubmit} />;
}

export function ConnectLibrary({ onConnect }: { onConnect: () => void }) {
  return <View style={contentStyles.page}><Text style={kit.subhead}>连接本机采集器</Text>
    <Text style={kit.body}>连接后即可查看这台电脑保存的账号、内容和专题。</Text>
    <View style={kit.row}><SmallButton label="连接与采集" onPress={onConnect} /></View></View>;
}

export const contentStyles = StyleSheet.create({
  page: { padding: 20, paddingBottom: 84, gap: 16, maxWidth: 1100, width: "100%", alignSelf: "center" },
  input: { flexGrow: 1, minWidth: 120, paddingHorizontal: 12, paddingVertical: 10, color: color.text, fontFamily: font.body, fontSize: 14,
    backgroundColor: color.surfaceRaised, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small },
  entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  title: { color: color.text, fontFamily: font.body, fontWeight: "600", fontSize: 15, lineHeight: 23 },
  label: { fontFamily: font.body, fontSize: 12, color: color.textSecondary, fontWeight: "600" },
  switcher: { paddingHorizontal: 16, paddingVertical: 8, gap: 10, flexDirection: "row", alignItems: "center", flexWrap: "wrap",
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft },
});
