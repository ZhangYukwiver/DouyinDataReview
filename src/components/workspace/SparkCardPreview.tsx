import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { ChatMemorial } from "../../domain/chatMemorial";
import { loadAppStyle, loadStoryStyle, resolveStoryStyle } from "../../services/appStyle";
import type { SparkCardStyle } from "./sparkCard";
import { renderSparkCard, saveSparkCard } from "./sparkCardThemes";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

const STYLES: ReadonlyArray<{ key: SparkCardStyle; label: string }> = [
  { key: "trace", label: "内容年志" },
  { key: "archive", label: "档案馆" },
  { key: "poster", label: "海报" },
];

/** 火花纪念卡预览：左边是画好的卡，右边换风格、存成 PNG。默认跟报告的风格（极简用设置里选的那套报告）。 */
export function SparkCardPreview({ memorial, onClose }: { memorial: ChatMemorial; onClose: () => void }) {
  const current = useRef(resolveStoryStyle(loadAppStyle(), loadStoryStyle())).current;
  const [style, setStyle] = useState<SparkCardStyle>(current);
  const [image, setImage] = useState<{ style: SparkCardStyle; url: string; canvas: HTMLCanvasElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { width, height } = useWindowDimensions();
  // 900×612 的窗口里也要整张放得下：右栏约 240，上下各留一点边
  const cardHeight = Math.max(320, Math.min(height - 80, (width - 340) * (4 / 3), 820));

  useEffect(() => {
    let live = true;
    setError(null);
    renderSparkCard(memorial, style)
      .then((canvas) => { if (live) setImage({ style, url: canvas.toDataURL("image/png"), canvas }); })
      .catch(() => { if (live) setError("这张卡没画出来，换个风格或稍后再试。"); });
    return () => { live = false; };
  }, [memorial, style]);

  const ready = image?.style === style;
  const save = () => {
    if (!ready) return;
    const name = memorial.kind === "group" ? memorial.name : `我和${memorial.name}`;
    void saveSparkCard(image.canvas, `火花纪念卡-${name}-${STYLES.find((item) => item.key === style)?.label}.png`).then(() => setSaved(true), () => setError("没存下来，请再试一次。"));
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="关闭纪念卡" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View {...ws("w-dialog")} accessibilityViewIsModal style={styles.dialog} testID="spark-card-preview">
          <View style={[styles.card, { width: cardHeight * 0.75, height: cardHeight }]}>
            {image ? <Image accessibilityLabel="火花纪念卡预览" resizeMode="contain" source={{ uri: image.url }} style={[styles.cardImage, !ready && styles.stale]} testID="spark-card-image" /> : null}
            {!ready && !error ? <ActivityIndicator color={color.textMuted} style={styles.spinner} /> : null}
          </View>
          <View style={styles.side}>
            <Text accessibilityRole="header" style={styles.title}>火花纪念卡</Text>
            <Text style={styles.hint}>把这段聊天的数字收成一张图，只在本机生成，存下来再决定发不发。</Text>
            <View accessibilityRole="radiogroup" style={styles.styles}>
              {STYLES.map((item) => (
                <Pressable
                  accessibilityRole="radio"
                  aria-checked={style === item.key}
                  key={item.key}
                  onPress={() => { setStyle(item.key); setSaved(false); }}
                  {...ws("btn small", style === item.key && "on")}
                  style={({ pressed }) => [styles.option, style === item.key && styles.optionOn, pressed && styles.pressed]}
                  testID={`spark-card-style-${item.key}`}
                >
                  <Text style={[styles.optionText, style === item.key && styles.optionTextOn]}>{item.label}</Text>
                  {item.key === current ? <Text style={styles.optionTag}>当前</Text> : null}
                </Pressable>
              ))}
            </View>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {saved ? <Text accessibilityLiveRegion="polite" style={styles.hint}>已经开始保存，没弹出保存窗口的话就去下载文件夹里找。</Text> : null}
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: !ready }} disabled={!ready} onPress={save} {...ws("btn-solid", ready && "on")}
                style={({ pressed }) => [styles.button, styles.primary, !ready && styles.disabled, pressed && styles.pressed]} testID="spark-card-save">
                <Text style={[styles.buttonText, styles.primaryText]}>存成 PNG</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={onClose} {...ws("btn small")} style={({ pressed }) => [styles.button, pressed && styles.pressed]} testID="spark-card-close">
                <Text style={styles.buttonText}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.scrim, justifyContent: "center", alignItems: "center", padding: 24 },
  dialog: { flexDirection: "row", alignItems: "stretch", gap: 22, padding: 18, backgroundColor: color.surface, borderRadius: radius.medium, borderWidth: 1, borderColor: color.border },
  card: { alignItems: "center", justifyContent: "center", borderRadius: radius.small, overflow: "hidden", backgroundColor: color.surfaceMuted },
  cardImage: { width: "100%", height: "100%" },
  stale: { opacity: 0.35 },
  spinner: { position: "absolute" },
  side: { width: 220, gap: 14 },
  title: { fontFamily: font.body, color: color.text, fontWeight: "600", fontSize: 20 },
  hint: { fontFamily: font.body, color: color.textMuted, fontSize: 12, lineHeight: 19 },
  styles: { gap: 8 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.small },
  optionOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  optionText: { fontFamily: font.body, color: color.textSecondary, fontSize: 13 },
  optionTextOn: { color: color.text, fontWeight: "600" },
  optionTag: { fontFamily: font.body, color: color.textMuted, fontSize: 11 },
  error: { fontFamily: font.body, color: color.danger, fontSize: 12, lineHeight: 19 },
  actions: { marginTop: "auto", gap: 8 },
  button: { alignItems: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, paddingVertical: 10, paddingHorizontal: 13 },
  buttonText: { fontFamily: font.body, fontSize: 13, color: color.text },
  primary: { backgroundColor: color.button, borderColor: color.button },
  primaryText: { color: color.buttonText, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
