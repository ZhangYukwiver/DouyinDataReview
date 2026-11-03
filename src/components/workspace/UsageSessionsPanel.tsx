import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Clock, X } from "lucide-react-native";
import { isDesktopApp } from "../../desktopRuntime";
import { getBrowserLoginSources, type BrowserLoginSource } from "../../services/localCollector";
import { readUsageSessions, startUsageBrowser, stopUsageBrowser, usageDurationLabel, usageSourceLabels,
  type UsageConnection, type UsageEndReason, type UsageSnapshot, type UsageSource } from "../../services/usageSessions";
import { workspaceColors as color } from "./workspaceTheme";

const reasons: Record<UsageEndReason, string> = { closed: "已关闭", hidden: "已收起", left_site: "已离开抖音", suspended: "睡眠或锁屏",
  stopped: "停止记录", disconnected: "连接中断 · 最后确认时间", interrupted: "异常结束 · 最后确认时间" };
const externalBrowser = (source: BrowserLoginSource): source is BrowserLoginSource & { id: Exclude<UsageSource, "app"> } => ["chrome", "edge", "comet"].includes(source.id);

export function UsageSessionsButton({ connection, compact = false, privacy = false }: { connection: UsageConnection | null; compact?: boolean; privacy?: boolean }) {
  const [visible, setVisible] = useState(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="使用记录" testID="usage-sessions-open" disabled={!connection}
      onPress={() => setVisible(true)} style={[styles.open, !connection && styles.disabled]}>
      <Clock color={color.textSecondary} size={19} />
      {!compact ? <Text style={styles.buttonText}>使用记录</Text> : null}
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      {visible && connection ? <UsageSessionsPanel connection={connection} privacy={privacy} onClose={() => setVisible(false)} /> : null}
    </Modal>
  </>;
}

export function UsageSessionsPanel({ connection, privacy = false, onClose }: { connection: UsageConnection; privacy?: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [sources, setSources] = useState<BrowserLoginSource[]>([]);
  const [selected, setSelected] = useState<Exclude<UsageSource, "app">>("chrome");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const refresh = useCallback(async () => { setSnapshot(await readUsageSessions(connection, offset)); }, [connection.baseUrl, connection.token, offset]);

  useEffect(() => {
    let disposed = false;
    const load = () => readUsageSessions(connection, offset).then(value => { if (!disposed) setSnapshot(value); }, reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "读取使用记录失败。");
    });
    void load(); const timer = setInterval(() => { void load(); }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [connection.baseUrl, connection.token, offset]);

  useEffect(() => {
    let disposed = false;
    void getBrowserLoginSources(connection.baseUrl, connection.token).then(items => {
      if (disposed) return;
      const external = items.filter(externalBrowser); setSources(external);
      const first = external.find(item => item.available);
      if (first) setSelected(first.id);
    }, () => {});
    return () => { disposed = true; };
  }, [connection.baseUrl, connection.token]);

  const run = async (stop: boolean) => {
    if (busy && !stop) return;
    const id = ++operation.current;
    setBusy(true); setError(null);
    try { if (stop) await stopUsageBrowser(connection); else await startUsageBrowser(connection, selected); if (id === operation.current) await refresh(); }
    catch (reason) { if (id === operation.current) setError(reason instanceof Error ? reason.message : "浏览器连接失败。"); }
    finally { if (id === operation.current) setBusy(false); }
  };
  const recording = snapshot?.browser.state === "connected";
  const connecting = busy || snapshot?.browser.state === "connecting";
  const dateLabel = (time: number) => privacy ? "已隐藏" : new Date(time).toLocaleString("zh-CN", { hour12: false });

  return <View style={styles.overlay}>
    <View style={styles.dialog} testID="usage-sessions-panel">
      <View style={styles.header}>
        <View style={styles.flex}><Text style={styles.title}>使用记录</Text><Text style={styles.muted}>记录这台电脑每次使用的开始、结束和时长</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭使用记录" onPress={onClose} style={styles.close}><X color={color.textSecondary} size={22} /></Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <View style={styles.summary}>
          <Text style={styles.muted}>今日记录时长</Text><Text style={styles.total}>{snapshot ? usageDurationLabel(snapshot.today.durationMs) : "—"}</Text>
          <Text style={styles.muted}>重叠时段只计一次 · {snapshot?.today.count ?? 0} 段</Text>
        </View>
        <View style={styles.section}>
          <View style={styles.row}><Text style={styles.heading}>软件窗口</Text><Text style={styles.status}>{snapshot?.activeSources.includes("app") ? "正在记录" : "未在计时"}</Text></View>
          <Text style={styles.muted}>{isDesktopApp() ? "显示窗口时自动计时；最小化、收起到托盘或锁屏时暂停。" : "软件窗口计时在桌面版自动运行。"}</Text>
        </View>
        <View style={styles.section}>
          <View style={styles.row}><Text style={styles.heading}>浏览器中的抖音网页</Text>
            <Text style={styles.status}>{recording ? `${snapshot.browser.label} · ${snapshot.browser.tabs} 个页面` : connecting ? "正在连接…" : "未连接"}</Text></View>
          <Text style={styles.muted}>无需扩展。打开第一个抖音页面开始，关闭最后一个或离开抖音结束。</Text>
          <Text style={styles.muted}>包含页面留在后台的时间；软件收起到托盘后仍可记录。</Text>
          <View style={styles.controls}>
            {sources.filter(externalBrowser).map(source => <Pressable key={source.id} accessibilityRole="button" accessibilityLabel={`选择 ${source.label}`}
              disabled={!source.available || recording || connecting} onPress={() => setSelected(source.id)}
              style={[styles.choice, selected === source.id && styles.selected, (!source.available || recording || connecting) && styles.disabled]}>
              <Text style={styles.buttonText}>{source.label}</Text>
            </Pressable>)}
            <Pressable accessibilityRole="button" accessibilityLabel={recording || connecting ? "停止网页记录" : "开始网页记录"}
              disabled={!recording && !connecting && !sources.some(source => source.id === selected && source.available)}
              onPress={() => { void run(Boolean(recording || connecting)); }} style={[styles.action, !sources.length && styles.disabled]}>
              {connecting ? <ActivityIndicator color={color.buttonText} size="small" /> : null}
              <Text style={styles.actionText}>{recording || connecting ? "停止记录" : "开始记录"}</Text>
            </Pressable>
          </View>
          <Text style={styles.muted}>每次重新连接需在浏览器允许调试连接。可在「设置 → 读取」开启自动请求。</Text>
          <Text style={styles.muted}>完全退出采集程序后停止记录；手动停止后，本次浏览器运行期间不再自动请求。</Text>
          <Text style={styles.muted}>连接前已经打开的页面，从连接时刻开始计时。</Text>
        </View>
        {error || snapshot?.error || snapshot?.browser.error ? <Text accessibilityRole="alert" style={styles.error}>{error || snapshot?.error || snapshot?.browser.error}</Text> : null}
        <View style={styles.row}><Text style={styles.heading}>每次使用</Text><Text style={styles.muted}>共 {snapshot?.total ?? 0} 段</Text></View>
        {!snapshot ? <ActivityIndicator color={color.cyan} /> : !snapshot.sessions.length ? <Text style={styles.empty}>还没有使用记录。开始记录后会自动保存在这台电脑。</Text> : snapshot.sessions.map(row => <View key={row.id} style={styles.record}>
          <View style={styles.row}><Text style={styles.heading}>{usageSourceLabels[row.source]}</Text><Text style={styles.duration}>{usageDurationLabel(row.durationMs)}</Text></View>
          <Text style={styles.recordTime}>开始　{dateLabel(row.startedAt)}{row.startKind === "observed" ? "（连接时已打开）" : row.startKind === "resumed" ? "（恢复记录）" : ""}</Text>
          <Text style={styles.recordTime}>结束　{row.endedAt === null ? "进行中" : dateLabel(row.endedAt)}</Text>
          {row.endReason ? <Text style={styles.muted}>{reasons[row.endReason]}</Text> : null}
        </View>)}
        {snapshot && (offset > 0 || snapshot.hasMore) ? <View style={styles.controls}>
          <Pressable accessibilityRole="button" disabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - 50))} style={[styles.choice, offset === 0 && styles.disabled]}><Text style={styles.buttonText}>较新记录</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={!snapshot.hasMore} onPress={() => setOffset(offset + 50)} style={[styles.choice, !snapshot.hasMore && styles.disabled]}><Text style={styles.buttonText}>更早记录</Text></Pressable>
        </View> : null}
      </ScrollView>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  open: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 38, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: color.borderSoft },
  disabled: { opacity: 0.45 }, buttonText: { color: color.textSecondary, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: color.scrim, alignItems: "center", justifyContent: "center", padding: 20 },
  dialog: { width: "100%", maxWidth: 740, maxHeight: "92%", backgroundColor: color.surface, borderRadius: 18, borderWidth: 1, borderColor: color.borderSoft, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 22, borderBottomWidth: 1, borderColor: color.borderSoft },
  title: { color: color.text, fontSize: 22, fontWeight: "700", marginBottom: 5 }, flex: { flex: 1 }, close: { padding: 8 },
  scroll: { width: "100%", minWidth: 0 }, body: { width: "100%", minWidth: 0, padding: 22, gap: 18 },
  muted: { color: color.textMuted, fontSize: 12, lineHeight: 19, flexShrink: 1, maxWidth: "100%" },
  summary: { backgroundColor: color.surfaceMuted, padding: 18, borderRadius: 12, gap: 5 }, total: { color: color.text, fontSize: 30, fontWeight: "700" },
  section: { gap: 10, width: "100%", minWidth: 0 }, row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  heading: { color: color.text, fontSize: 14, fontWeight: "600" }, status: { color: color.cyan, fontSize: 12 },
  controls: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }, choice: { borderWidth: 1, borderColor: color.borderSoft, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 8 },
  selected: { borderColor: color.cyan, backgroundColor: color.cyanSoft }, action: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: color.button, borderRadius: 8 },
  actionText: { color: color.buttonText, fontSize: 13, fontWeight: "600" }, error: { color: color.danger, fontSize: 13, lineHeight: 20 },
  record: { gap: 6, borderTopWidth: 1, borderColor: color.borderSoft, paddingTop: 14 }, duration: { color: color.cyan, fontSize: 15, fontWeight: "600" },
  recordTime: { color: color.textSecondary, fontSize: 12, lineHeight: 19 }, empty: { color: color.textMuted, textAlign: "center", padding: 24 },
});
