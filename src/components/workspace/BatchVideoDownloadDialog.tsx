import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreConnection } from "../../services/explorer";
import { createVideoBatchZip, loadBatchVideoFile, MAX_BATCH_VIDEOS, nextVideoBatch, runVideoBatch } from "../../services/batchVideoDownload";
import { isDesktopApp } from "../../desktopRuntime";
import { noteAchievementWorks } from "./achievements";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

export function BatchVideoDownloadDialog({ records, connection, onClose, privacy, keepExplore = false }: {
  records: PersonalVideoRecord[];
  connection: ExploreConnection;
  /** 带上已经保存成 ZIP 的那些作品，调用方可以据此跳过它们 */
  onClose: (saved: PersonalVideoRecord[]) => void;
  privacy: boolean;
  /** 从探索页打开：下载期间不关探索会话 */
  keepExplore?: boolean;
}) {
  const [{ items, offset, part }, setBatch] = useState(() => ({ ...nextVideoBatch(records, 0), part: 1 }));
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [packing, setPacking] = useState(false);
  const [error, setError] = useState("");
  const [savedRecords, setSavedRecords] = useState(() => new Set<PersonalVideoRecord>());
  const stop = useRef(false);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  const complete = items.filter((item) => item.status === "complete").length;
  const failed = items.filter((item) => item.status === "failed" && item.code !== "batch_size_limit").length;
  const overflow = items.filter((item) => item.code === "batch_size_limit").length;
  const pending = items.filter((item) => item.status === "pending").length;
  const bytes = items.reduce((total, item) => total + (item.file?.blob.size ?? 0), 0);
  const saved = complete > 0 && items.every((item) => item.status !== "complete" || savedRecords.has(item.record));
  const full = overflow > 0;
  const hasNext = full || offset < records.length;
  const readyForNext = hasNext && (full || pending === 0);
  async function start(toDownload = items) {
    if (active.current) return;
    active.current = true;
    stop.current = false;
    controller.current = new AbortController();
    setRunning(true); setStopping(false); setError("");
    try {
      await runVideoBatch(toDownload, {
        load: (record, remaining) => loadBatchVideoFile(connection, record, remaining, controller.current!.signal, keepExplore),
        shouldStop: () => stop.current,
        onUpdate: (next) => { if (mounted.current) setBatch((current) => ({ ...current, items: next })); },
      });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "批量下载失败。"); }
    finally { active.current = false; if (mounted.current) { setRunning(false); setStopping(false); } }
  }
  function startNext() {
    if (active.current || (complete > 0 && !saved)) return;
    const next = nextVideoBatch(records, offset, items);
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setBatch({ ...next, part: part + 1 });
    void start(next.items);
  }
  async function save() {
    if (active.current) return;
    active.current = true;
    setPacking(true); setError("");
    try {
      const blob = await createVideoBatchZip(items);
      if (!mounted.current) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl.current;
      // 同一个作者的一批：名字放进文件名，分几次存的 ZIP 才分得清
      const authors = new Set(items.map((item) => item.record.author));
      const author = !privacy && authors.size === 1 ? Array.from(([...authors][0] ?? "").replace(/[\\/\u0000-\u001f<>:"|?*\s]+/gu, "_").replace(/^_+|_+$/gu, "")).slice(0, 30).join("") : "";
      const partName = part > 1 || hasNext ? `_第${part}包` : "";
      anchor.download = `抖音视频_${author ? `${author}_` : ""}${new Date().toISOString().slice(0, 10)}${partName}_${complete}个.zip`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      const completed = items.filter((item) => item.status === "complete").map((item) => item.record);
      setSavedRecords((current) => new Set([...current, ...completed]));
      noteAchievementWorks("download", completed.map((record) => record.videoId || record.id));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "打包失败，请重试。"); }
    finally { active.current = false; if (mounted.current) setPacking(false); }
  }
  const stopQueue = () => { stop.current = true; setStopping(true); };
  const close = () => { if (!active.current) onClose([...savedRecords]); };
  return <Modal transparent visible animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <View {...ws("w-dialog")} accessibilityViewIsModal style={styles.dialog} testID="batch-download-dialog">
        <Text accessibilityRole="header" style={styles.title}>批量下载视频</Text>
        <Text accessibilityLiveRegion="polite" style={styles.meta}>共选 {records.length} 个{savedRecords.size > 0 ? `，已保存 ${savedRecords.size} 个` : ""} · 第 {part} 包共 {items.length} 个 · 已完成 {complete} · 失败 {failed} · 待下载 {pending + overflow}</Text>
        <Text style={styles.hint}>每个 ZIP 最多 {MAX_BATCH_VIDEOS} 个视频、合计 500 MB。下载期间请保持此页面打开。</Text>
        <Text style={styles.hint}>下载时会重新检查当前详情；公开且仍可访问的旧作品不受“发布后三小时”限制。约 3/24 小时是单条签名地址的估算有效期。详情拒绝时会停止，不复用旧地址；请确认自己有权保存和使用这些内容。</Text>
        <Text style={styles.hint}>ZIP 会附带脱敏的请求证据 `evidence.json`，不含签名 URL 或 Cookie；作品变为不可访问后的应急取回不在本功能范围内。</Text>
        <View accessibilityRole="progressbar" accessibilityLabel="本包下载进度" accessibilityValue={{ min: 0, max: items.length, now: complete + failed }} aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={complete + failed} style={styles.progress}>
          <View style={[styles.progressFill, { width: `${(complete + failed) / items.length * 100}%` }]} />
        </View>
        <ScrollView style={styles.list}>
          {items.map((item, index) => <View key={item.record.id} style={styles.item}>
            <View style={styles.itemCopy}><Text numberOfLines={2} style={styles.itemTitle}>{index + 1}. {privacy ? "内容标题已隐藏" : item.record.title}</Text>
              {item.error ? <Text style={styles.error}>{item.error}</Text> : null}</View>
            {item.status === "running" ? <ActivityIndicator size="small" color={color.cyan} /> : null}
            <Text style={styles.hint}>{item.code === "batch_size_limit" ? "待下一包" : ({ pending: "待下载", running: "下载中", complete: "已完成", failed: "失败" })[item.status]}</Text>
          </View>)}
        </ScrollView>
        {stopping ? <Text accessibilityLiveRegion="polite" style={styles.hint}>正在完成当前视频，之后停止；已完成的视频仍可保存。</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {saved ? <Text accessibilityLiveRegion="polite" style={styles.meta}>{isDesktopApp() ? "ZIP 已存到视频下载位置（设置 → 数据里可以打开或更改）。" : "已发起 ZIP 保存，请在浏览器下载列表中查看。"}</Text> : null}
        <View style={styles.actions}>
          {running ? <Button label={stopping ? "正在停止…" : "停止后续下载"} disabled={stopping} onPress={stopQueue} /> : (pending || failed) && !full ? <Button label={complete || failed ? (pending ? "继续未完成" : "重试失败项") : "开始下载"} disabled={packing} onPress={() => void start()} primary /> : null}
          {complete > 0 ? <Button label={packing ? "正在打包…" : `保存 ZIP（${complete} 个 · ${(bytes / 1024 / 1024).toFixed(1)} MB）`} disabled={running || packing} onPress={() => void save()} primary /> : null}
          {!running && readyForNext ? <Button label={failed ? `跳过 ${failed} 个失败项，下载下一包` : "下载下一包"} disabled={packing || (complete > 0 && !saved)} onPress={startNext} primary /> : null}
          <Button label="关闭" disabled={running || packing} onPress={close} />
        </View>
        {!running && complete > 0 && !saved ? <Text style={styles.hint}>{readyForNext ? "保存本包 ZIP 后可继续下载下一包。" : "关闭前请保存 ZIP，关闭后将释放本包文件。"}</Text> : null}
      </View>
    </View>
  </Modal>;
}

function Button({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.scrim, justifyContent: "center", alignItems: "center", padding: 16 },
  dialog: { width: "100%", maxWidth: 620, maxHeight: "90%", backgroundColor: color.surface, borderRadius: radius.medium, borderWidth: 1, borderColor: color.border, padding: 20, gap: 14 },
  title: { fontFamily: font.body, color: color.text, fontWeight: "600", fontSize: 20 },
  meta: { fontFamily: font.body, color: color.textSecondary, fontSize: 13, lineHeight: 21 },
  hint: { fontFamily: font.body, color: color.textMuted, fontSize: 12, lineHeight: 19 },
  progress: { height: 5, backgroundColor: color.borderSoft, borderRadius: 3, overflow: "hidden" }, progressFill: { height: 5, backgroundColor: color.cyan },
  list: { maxHeight: 320, flexShrink: 1 }, item: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  itemCopy: { flex: 1, minWidth: 0, gap: 5 }, itemTitle: { fontFamily: font.body, color: color.text, fontSize: 13, lineHeight: 20 },
  error: { fontFamily: font.body, color: color.danger, fontSize: 12, lineHeight: 20 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { borderWidth: 1, borderColor: color.border, borderRadius: radius.small, paddingVertical: 10, paddingHorizontal: 13 }, buttonText: { fontFamily: font.body, fontSize: 12, color: color.text },
  primary: { backgroundColor: color.button, borderColor: color.button }, primaryText: { color: color.buttonText }, disabled: { opacity: 0.45 },
});
