import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

const pointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;

/** 登录失效时挂在每个页面顶上。采集器那边已经把搜索、下载、读取都拦下了，不提示的话只会在各处看到零散的报错 */
export function CredentialBanner({ onDismiss, onLogin }: { onDismiss: () => void; onLogin: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.bar} testID="credential-banner">
      <View style={styles.dot} />
      <Text style={styles.text}>抖音登录失效了，搜索、下载和读取暂时都用不了，重新登录一下就好。</Text>
      <Pressable accessibilityRole="button" onPress={onLogin} style={[styles.button, styles.primary, pointer]} testID="credential-banner-login">
        <Text style={[styles.label, { color: color.buttonText }]}>重新登录</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onDismiss} style={[styles.button, pointer]} testID="credential-banner-dismiss">
        <Text style={styles.label}>稍后</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.border, backgroundColor: color.amberSoft },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.danger },
  text: { flex: 1, fontFamily: font.sans, fontSize: 13, lineHeight: 18, color: color.text },
  button: { minHeight: 28, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  primary: { borderColor: color.button, backgroundColor: color.button },
  label: { fontFamily: font.sans, fontSize: 13, lineHeight: 18, fontWeight: "500", color: color.text },
});
