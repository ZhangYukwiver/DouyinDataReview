import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { cancelBrowserLogin, confirmBrowserLogin, disconnectBrowserLogin, getBrowserLoginSources, inspectBrowserLogin,
  type BrowserLoginCandidate, type BrowserLoginSource, type CollectorAccountChange, type CollectorStatus } from "../../services/localCollector";
import { workspaceColors as color } from "./workspaceTheme";

export interface BrowserConnectionPanelProps {
  visible: boolean;
  baseUrl: string;
  token: string;
  status: CollectorStatus | null;
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
  onChange: (change: CollectorAccountChange) => Promise<void>;
}

export function BrowserConnectionPanel({ visible, baseUrl, token, status, blocked, onBusyChange, onChange }: BrowserConnectionPanelProps) {
  const [sources, setSources] = useState<BrowserLoginSource[]>([]);
  const [selected, setSelected] = useState<BrowserLoginSource["id"]>("chrome");
  const [candidate, setCandidate] = useState<BrowserLoginCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const candidateRef = useRef<BrowserLoginCandidate | null>(null);
  const runningRef = useRef(false);

  async function refresh() {
    try {
      const list = await getBrowserLoginSources(baseUrl, token);
      if (!visibleRef.current) return;
      setSources(list);
      setSelected(current => list.some(item => item.id === current && item.available) ? current : list.find(item => item.debugging)?.id ?? list.find(item => item.available)?.id ?? "chrome");
      setError(null);
    } catch (reason) { if (visibleRef.current) setError(reason instanceof Error ? reason.message : "浏览器列表读取失败。"); }
  }

  useEffect(() => {
    if (visible) void refresh();
    else {
      const previous = candidateRef.current; candidateRef.current = null; setCandidate(null);
      if (previous) void cancelBrowserLogin(baseUrl, token, previous.id).catch(() => {});
    }
    return () => {
      const previous = candidateRef.current; candidateRef.current = null;
      if (previous) void cancelBrowserLogin(baseUrl, token, previous.id).catch(() => {});
    };
  }, [visible, baseUrl, token]);

  async function run(work: () => Promise<void>) {
    if (runningRef.current || blocked) return;
    runningRef.current = true; setBusy(true); setError(null); onBusyChange(true);
    try { await work(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "浏览器连接没有完成，请重试。"); }
    finally { runningRef.current = false; setBusy(false); onBusyChange(false); }
  }

  const connect = () => run(async () => {
    const result = await inspectBrowserLogin(baseUrl, token, selected, status?.account?.id);
    if (!visibleRef.current) { await cancelBrowserLogin(baseUrl, token, result.id); return; }
    candidateRef.current = result; setCandidate(result);
  });
  const confirm = () => run(async () => {
    if (!candidate) return;
    const change = await confirmBrowserLogin(baseUrl, token, candidate.id, status?.account?.id);
    candidateRef.current = null; setCandidate(null);
    await onChange(change);
  });
  const cancel = () => run(async () => {
    if (candidate) await cancelBrowserLogin(baseUrl, token, candidate.id);
    candidateRef.current = null; setCandidate(null);
  });
  const disconnect = () => run(async () => {
    const change = await disconnectBrowserLogin(baseUrl, token, status?.account?.id);
    await onChange(change);
  });
  const source = sources.find(item => item.id === selected);
  const disabled = busy || blocked;
  return (
    <View style={styles.panel} testID="browser-login-panel">
      <Text style={styles.title}>导入浏览器登录凭据</Text>
      <Text style={styles.detail}>连接一次，确认账号并导出凭据后自动断开。凭据有效时可关闭浏览器，失效后再从这里重新导入。原有标签页会保留。</Text>
      <Text style={styles.detail} accessibilityLiveRegion="polite" testID="browser-login-status">
        {status?.browserSource?.browser ? `${status.browserSource.browser} · ` : ""}
        {status?.browserSource?.credentials === "ready" ? "凭据已导入，浏览器可关闭"
          : status?.browserSource?.credentials === "exporting" ? "正在导出凭据" : "请连接浏览器并导入凭据"}
      </Text>
      {candidate ? <>
        <Text style={styles.title} testID="browser-login-candidate">浏览器登录的是「{candidate.nickname || "抖音账号"}」</Text>
        <Text style={styles.detail}>{candidate.newAccount ? "确认后添加这个账号并导出凭据，记录单独保存。" : "确认后导出这个账号的凭据，使用已有记录，保留其他账号数据。"}</Text>
        <View style={styles.actions}>
          <Action label="确认导入" disabled={disabled} onPress={confirm} testID="browser-login-confirm" />
          <Action label="取消" disabled={disabled} onPress={cancel} testID="browser-login-cancel" />
        </View>
      </> : <>
        <View accessibilityRole="radiogroup" accessibilityLabel="登录来源浏览器" style={styles.actions}>
          {sources.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label}
            accessibilityState={{ checked: item.id === selected, disabled: disabled || !item.available }} aria-checked={item.id === selected}
            disabled={disabled || !item.available} onPress={() => setSelected(item.id)}
            style={[styles.option, item.id === selected && styles.selected, !item.available && styles.disabled]} testID={`browser-login-${item.id}`}>
            <Text style={styles.text}>{item.label} · {!item.available ? "未找到" : item.debugging ? "可连接" : "需开启调试"}</Text>
          </Pressable>)}
        </View>
        {source ? <Text selectable style={styles.detail}>先登录抖音，再打开 {source.inspectUrl}，勾选允许远程调试。连接时请在浏览器中允许。</Text> : null}
        <Text style={styles.detail}>调试权限覆盖整个浏览器；工作台仅访问自己创建的抖音页面和抖音 Cookie。导出后可关闭调试开关，无需安装扩展。</Text>
        <View style={styles.actions}>
          <Action label={busy ? "连接处理中…" : "连接浏览器"} disabled={disabled || !source?.available} onPress={connect} testID="browser-login-connect" />
          <Action label="刷新检测" disabled={disabled} onPress={() => { void refresh(); }} testID="browser-login-refresh" />
          {status?.browserSource?.connected ? <Action label="断开连接" disabled={disabled} onPress={() => disconnect()} testID="browser-login-disconnect" /> : null}
        </View>
      </>}
      {busy ? <View style={styles.actions}><ActivityIndicator size="small" color={color.accent} /><Text style={styles.detail}>{candidate ? "正在导出凭据，完成前请保持浏览器打开。" : "请留意浏览器中的连接确认框。"}</Text></View> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error} testID="browser-login-error">{error}</Text> : null}
    </View>
  );
}

function Action({ label, disabled, onPress, testID }: { label: string; disabled: boolean; onPress: () => void; testID: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={[styles.option, disabled && styles.disabled]} testID={testID}><Text style={styles.text}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  panel: { gap: 12, paddingVertical: 18, borderTopWidth: 1, borderTopColor: color.border },
  title: { color: color.text, fontSize: 14, fontWeight: "600" },
  detail: { color: color.textSecondary, fontSize: 12, lineHeight: 19 },
  text: { color: color.text, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  option: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: color.border, borderRadius: 6 },
  selected: { borderColor: color.accent, backgroundColor: color.surfaceMuted },
  disabled: { opacity: 0.45 },
  error: { color: color.accent, fontSize: 12, lineHeight: 19 },
});
