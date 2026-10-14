import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { cancelBrowserLogin, confirmBrowserLogin, disconnectBrowserLogin, getBrowserLoginSources, inspectBrowserLogin, LocalCollectorError,
  type BrowserLoginCandidate, type BrowserLoginSource, type CollectorAccountChange, type CollectorReadPermissions, type CollectorStatus } from "../../services/localCollector";
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
  const [readPermissions, setReadPermissions] = useState<CollectorReadPermissions>({ videos: true, chat: false });
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const candidateRef = useRef<BrowserLoginCandidate | null>(null);
  const runningRef = useRef(false);
  const connectControllerRef = useRef<AbortController | null>(null);

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
      connectControllerRef.current?.abort();
      const previous = candidateRef.current; candidateRef.current = null; setCandidate(null);
      if (previous) void cancelBrowserLogin(baseUrl, token, previous.id).catch(() => {});
    }
    return () => {
      connectControllerRef.current?.abort();
      const previous = candidateRef.current; candidateRef.current = null;
      if (previous) void cancelBrowserLogin(baseUrl, token, previous.id).catch(() => {});
    };
  }, [visible, baseUrl, token]);

  async function run(work: () => Promise<void>) {
    if (runningRef.current || blocked) return;
    runningRef.current = true; setBusy(true); setError(null); setNotice(null); onBusyChange(true);
    try { await work(); }
    catch (reason) {
      if (reason instanceof LocalCollectorError && reason.code === "browser_debugging_required") setNotice(reason.message);
      else setError(reason instanceof Error ? reason.message : "浏览器连接没有完成，请重试。");
    }
    finally { runningRef.current = false; setBusy(false); onBusyChange(false); }
  }

  const connect = () => run(async () => {
    const controller = new AbortController();
    connectControllerRef.current = controller; setConnecting(true);
    try {
      const result = await inspectBrowserLogin(baseUrl, token, selected, status?.account?.id, controller.signal);
      if (controller.signal.aborted || !visibleRef.current) { await cancelBrowserLogin(baseUrl, token, result.id); return; }
      candidateRef.current = result; setCandidate(result);
      setReadPermissions(result.readPermissions ?? { videos: true, chat: false });
    } catch (reason) {
      if (!controller.signal.aborted) throw reason;
    } finally {
      if (connectControllerRef.current === controller) connectControllerRef.current = null;
      setConnecting(false);
    }
  });
  const confirm = () => run(async () => {
    if (!candidate || (!readPermissions.videos && !readPermissions.chat)) return;
    let change: CollectorAccountChange;
    try {
      change = await confirmBrowserLogin(baseUrl, token, candidate.id, readPermissions, status?.account?.id);
    } catch (reason) {
      // Confirmation consumes the server's pending connection even if export
      // fails. Return to connection controls instead of retrying a stale id.
      const previous = candidateRef.current;
      candidateRef.current = null; setCandidate(null);
      if (previous) void cancelBrowserLogin(baseUrl, token, previous.id).catch(() => {});
      throw reason;
    }
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
      <Text style={styles.detail}>连接浏览器后确认账号，分别选择读取视频和读取聊天。导入完成后只读取勾选的类型，并自动断开浏览器；凭据失效或需要调整权限时，从这里重新导入。原有标签页会保留。</Text>
      <Text style={styles.detail} accessibilityLiveRegion="polite" testID="browser-login-status">
        {status?.browserSource?.browser ? `${status.browserSource.browser} · ` : ""}
        {status?.browserSource?.credentials === "ready" ? "凭据已导入，浏览器可关闭"
          : status?.browserSource?.credentials === "exporting" ? "正在导出凭据" : "请连接浏览器并导入凭据"}
      </Text>
      {status?.readPermissions && status.browserSource?.credentials === "ready" ? <Text style={styles.detail} testID="browser-read-permissions">当前账号：视频读取{status.readPermissions.videos ? "已开启" : "未开启"} · 聊天读取{status.readPermissions.chat ? "已开启" : "未开启"}</Text> : null}
      {candidate ? <>
        <Text style={styles.title} testID="browser-login-candidate">浏览器登录的是「{candidate.nickname || "抖音账号"}」</Text>
        <Text style={styles.detail}>{candidate.newAccount ? "确认后添加这个账号，记录单独保存。" : "确认后更新这个账号的凭据和读取权限，保留已有记录及其他账号数据。"}</Text>
        <View style={styles.actions}>
          {(["videos", "chat"] as const).map(kind => <Pressable key={kind} accessibilityRole="checkbox"
            accessibilityLabel={kind === "videos" ? "读取视频" : "读取聊天"} accessibilityState={{ checked: readPermissions[kind], disabled }}
            aria-checked={readPermissions[kind]} disabled={disabled} onPress={() => setReadPermissions(current => ({ ...current, [kind]: !current[kind] }))}
            style={[styles.option, readPermissions[kind] && styles.selected, disabled && styles.disabled]} testID={`browser-read-${kind}`}>
            <Text style={styles.text}>{readPermissions[kind] ? "✓ " : "○ "}{kind === "videos" ? "读取视频" : "读取聊天"}</Text>
          </Pressable>)}
        </View>
        <Text style={styles.detail}>视频：观看历史、喜欢、收藏及视频相关联网读取。聊天：历史记录、实时接收及火花。勾选视频后自动完整读取一次，勾选聊天后自动整理历史并开始接收；未勾选的类型不能继续联网读取，已有本地数据仍可查看。</Text>
        {!readPermissions.videos && !readPermissions.chat ? <Text style={styles.error}>请至少选择一项读取权限。</Text> : null}
        <View style={styles.actions}>
          <Action label="确认导入" disabled={disabled || (!readPermissions.videos && !readPermissions.chat)} onPress={confirm} testID="browser-login-confirm" />
          <Action label="取消" disabled={disabled} onPress={cancel} testID="browser-login-cancel" />
        </View>
      </> : <>
        <View accessibilityRole="radiogroup" accessibilityLabel="登录来源浏览器" style={styles.actions}>
          {sources.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label}
            accessibilityState={{ checked: item.id === selected, disabled: disabled || !item.available }} aria-checked={item.id === selected}
            disabled={disabled || !item.available} onPress={() => { setSelected(item.id); setNotice(null); setError(null); }}
            style={[styles.option, item.id === selected && styles.selected, !item.available && styles.disabled]} testID={`browser-login-${item.id}`}>
            <Text style={styles.text}>{item.label} · {!item.available ? "未找到" : item.debugging ? "可连接" : "需开启调试"}</Text>
          </Pressable>)}
        </View>
        {source ? <Text selectable style={styles.detail}>未开启调试时，点击“连接浏览器”会尝试自动打开 {source.label} 的调试设置页。勾选允许远程调试后再次连接；也可手动打开 {source.inspectUrl}。连接时请在浏览器中允许。</Text> : null}
        <Text style={styles.detail}>调试权限覆盖整个浏览器；工作台仅访问自己创建的抖音页面和抖音 Cookie。导出后可关闭调试开关，无需安装扩展。</Text>
        <View style={styles.actions}>
          <Action label={busy ? "连接处理中…" : "连接浏览器"} disabled={disabled || !source?.available} onPress={connect} testID="browser-login-connect" />
          <Action label="刷新检测" disabled={disabled} onPress={() => { void refresh(); }} testID="browser-login-refresh" />
          {status?.browserSource?.connected ? <Action label="断开连接" disabled={disabled} onPress={() => disconnect()} testID="browser-login-disconnect" /> : null}
        </View>
      </>}
      {busy ? <View style={styles.actions}>
        <ActivityIndicator size="small" color={color.accent} />
        <Text style={styles.detail} accessibilityLiveRegion="polite">{candidate ? "正在导出凭据，完成前请保持浏览器打开。" : "请按提示开启调试或允许连接；进入抖音页面后完成登录或验证，未弹出登录框时可点击“登录”。工作台会自动继续，最多等待 5 分钟。"}</Text>
        {connecting ? <Action label="取消连接" disabled={false} onPress={() => connectControllerRef.current?.abort()} testID="browser-login-cancel-connect" /> : null}
      </View> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.detail} testID="browser-login-notice">{notice}</Text> : null}
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
