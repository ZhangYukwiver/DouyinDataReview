import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreConnection } from "../../services/explorer";
import { createVideoBatchZip, loadBatchVideoFile, runVideoBatch, type BatchItem } from "../../services/batchVideoDownload";
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
  const [items, setItems] = useState<BatchItem[]>(() => records.map((record) => ({ record, status: "pending" })));
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [packing, setPacking] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const stop = useRef(false);
  const savedRecords = useRef<PersonalVideoRecord[]>([]);
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
  const failed = items.filter((item) => item.status === "failed").length;
  const pending = items.filter((item) => item.status === "pending").length;
  const bytes = items.reduce((total, item) => total + (item.file?.blob.size ?? 0), 0);
  // 本批装满后再点「继续」只会把被拒的那个视频白下一遍，该做的是先存 ZIP、下一批再选
  const full = items.some((item) => item.status === "failed" && item.code === "batch_size_limit");
  async function start() {
    if (active.current) return;
    active.current = true;
    stop.current = false;
    controller.current = new AbortController();
    setRunning(true); setStopping(false); setError(""); setSaved(false);
    try {
      await runVideoBatch(items, {
        load: (record, remaining) => loadBatchVideoFile(connection, record, remaining, controller.current!.signal, keepExplore),
        shouldStop: () => stop.current,
        onUpdate: (next) => { if (mounted.current) setItems(next); },
      });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "批量下载失败。"); }
    finally { active.current = false; if (mounted.current) { setRunning(false); setStopping(false); } }
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
      const authors = new Set(records.map((record) => record.author));
      const author = !privacy && authors.size === 1 ? Array.from(([...authors][0] ?? "").replace(/[\\/\u0000-\u001f<>:"|?*\s]+/gu, "_").replace(/^_+|_+$/gu, "")).slice(0, 30).join("") : "";
      anchor.download = `抖音视频_${author ? `${author}_` : ""}${new Date().toISOString().slice(0, 10)}_${complete}个.zip`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      savedRecords.current = items.filter((item) => item.status === "complete").map((item) => item.record);
      setSaved(true);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "打包失败，请重试。"); }
    finally { active.current = false; if (mounted.current) setPacking(false); }
  }
  const stopQueue = () => { stop.current = true; setStopping(true); };
  return <Modal transparent visible animationType="fade" onRequestClose={() => { if (!running && !packing) onClose(savedRecords.current); }}>
    <View style={styles.backdrop}>
      <View {...ws("w-dialog")} accessibilityViewIsModal style={styles.dialog} testID="batch-download-dialog">
        <Text accessibilityRole="header" style={styles.title}>批量下载视频</Text>
        <Text accessibilityLiveRegion="polite" style={styles.meta}>共 {items.length} 个 · 已完成 {complete} · 失败 {failed} · 待下载 {pending}</Text>
        <Text style={styles.hint}>每批最多 50 个、合计 500 MB。下载完成后保存 ZIP；请保持此页面打开。</Text>
        <View accessibilityRole="progressbar" accessibilityLabel="批量下载进度" accessibilityValue={{ min: 0, max: items.length, now: complete + failed }} aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={complete + failed} style={styles.progress}>
          <View style={[styles.progressFill, { width: `${(complete + failed) / items.length * 100}%` }]} />
        </View>
        <ScrollView style={styles.list}>
          {items.map((item, index) => <View key={item.record.id} style={styles.item}>
            <View style={styles.itemCopy}><Text numberOfLines={2} style={styles.itemTitle}>{index + 1}. {privacy ? "内容标题已隐藏" : item.record.title}</Text>
              {item.error ? <Text style={styles.error}>{item.error}</Text> : null}</View>
            {item.status === "running" ? <ActivityIndicator size="small" color={color.cyan} /> : null}
            <Text style={styles.hint}>{({ pending: "待下载", running: "下载中", complete: "已完成", failed: "失败" })[item.status]}</Text>
          </View>)}
        </ScrollView>
        {stopping ? <Text accessibilityLiveRegion="polite" style={styles.hint}>正在完成当前视频，之后停止；已完成的视频仍可保存。</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {saved ? <Text accessibilityLiveRegion="polite" style={styles.meta}>已发起 ZIP 保存，请在浏览器下载列表中查看。</Text> : null}
        <View style={styles.actions}>
          {running ? <Button label={stopping ? "正在停止…" : "停止后续下载"} disabled={stopping} onPress={stopQueue} /> : (pending || failed) && !full ? <Button label={complete || failed ? (pending ? "继续未完成" : "重试失败项") : "开始下载"} disabled={packing} onPress={() => void start()} primary /> : null}
          {complete > 0 ? <Button label={packing ? "正在打包…" : `保存 ZIP（${complete} 个 · ${(bytes / 1024 / 1024).toFixed(1)} MB）`} disabled={running || packing} onPress={() => void save()} primary /> : null}
          <Button label="关闭" disabled={running || packing} onPress={() => onClose(savedRecords.current)} />
        </View>
        {full && !running ? <Text style={styles.hint}>本批已装满，先保存 ZIP，再关闭窗口，把剩下的放到下一批。</Text> : null}
        {complete > 0 && !saved ? <Text style={styles.hint}>关闭前请保存 ZIP，关闭后将释放本批文件。</Text> : null}
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
