import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { cancelBrowserLogin, confirmBrowserLogin, disconnectBrowserLogin, getBrowserLoginQrCode, getBrowserLoginSources, inspectBrowserLogin, LocalCollectorError, showBrowserLoginWindow,
  type BrowserLoginCandidate, type BrowserLoginSource, type CollectorAccountChange, type CollectorReadPermissions, type CollectorStatus } from "../../services/localCollector";
import { isDesktopApp } from "../../desktopRuntime";
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
  const [selected, setSelected] = useState<BrowserLoginSource["id"]>("app");
  const [candidate, setCandidate] = useState<BrowserLoginCandidate | null>(null);
  const [readPermissions, setReadPermissions] = useState<CollectorReadPermissions>({ videos: true, chat: false });
  const [adopt, setAdopt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<{ image: string; hint: string } | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const candidateRef = useRef<BrowserLoginCandidate | null>(null);
  const runningRef = useRef(false);
  const connectControllerRef = useRef<AbortController | null>(null);

  async function refresh() {
    try {
      // 应用内登录窗口只有桌面版能弹；浏览器里打开的工作台只列 Chrome/Edge/Comet
      const list = (await getBrowserLoginSources(baseUrl, token)).filter(item => item.id !== "app" || isDesktopApp());
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

  // 应用内登录的网页藏在后台，等登录期间把它的二维码搬到这里来扫；抖音大约一分钟换一张码，跟着取
  const waitingForScan = connecting && selected === "app";
  useEffect(() => {
    if (!waitingForScan) { setQrcode(null); return; }
    let stopped = false;
    const poll = () => getBrowserLoginQrCode(baseUrl, token).then(value => { if (!stopped) setQrcode(value); }, () => {});
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [waitingForScan, baseUrl, token]);

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
      setAdopt(true);
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
      change = await confirmBrowserLogin(baseUrl, token, candidate.id, readPermissions, status?.account?.id, candidate.adoptable && adopt);
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
  const inApp = selected === "app";
  const sourceLabel = (id: BrowserLoginSource["id"]) => sources.find(item => item.id === id)?.label ?? (id === "app" ? "应用内登录" : id);
  const disabled = busy || blocked;
  return (
    <View style={styles.panel} testID="browser-login-panel">
      <Text style={styles.title}>导入登录凭据</Text>
      <Text style={styles.detail}>登录抖音或连接浏览器后确认账号，分别选择读取视频和读取聊天。导入完成后只读取勾选的类型，并自动断开连接（浏览器里原有的标签页保留）；凭据失效或需要调整权限时，从这里重新导入。</Text>
      <Text style={styles.detail} accessibilityLiveRegion="polite" testID="browser-login-status">
        {status?.browserSource?.browser ? `${sourceLabel(status.browserSource.browser)} · ` : ""}
        {status?.browserSource?.credentials === "ready" ? (status.browserSource.browser === "app" ? "凭据已导入" : "凭据已导入，浏览器可关闭")
          : status?.browserSource?.credentials === "exporting" ? "正在导出凭据" : "请连接浏览器并导入凭据"}
      </Text>
      {status?.readPermissions && status.browserSource?.credentials === "ready" ? <Text style={styles.detail} testID="browser-read-permissions">当前账号：视频读取{status.readPermissions.videos ? "已开启" : "未开启"} · 聊天读取{status.readPermissions.chat ? "已开启" : "未开启"}</Text> : null}
      {candidate ? <>
        <Text style={styles.title} testID="browser-login-candidate">{inApp ? "扫码" : "浏览器"}登录的是「{candidate.nickname || "抖音账号"}」</Text>
        <Text style={styles.detail}>{candidate.adoptable && adopt ? "当前账号里已有的记录还没绑定抖音号，确认后会归到这个号名下，以后接着补读。"
          : candidate.newAccount ? "确认后添加这个账号，记录单独保存。" : "确认后更新这个账号的凭据和读取权限，保留已有记录及其他账号数据。"}</Text>
        {candidate.adoptable ? <View style={styles.actions}>
          <Pressable accessibilityRole="checkbox" accessibilityLabel="已有记录归到这个号" accessibilityState={{ checked: adopt, disabled }}
            aria-checked={adopt} disabled={disabled} onPress={() => setAdopt(current => !current)}
            style={[styles.option, adopt && styles.selected, disabled && styles.disabled]} testID="browser-login-adopt">
            <Text style={styles.text}>{adopt ? "✓ " : "○ "}已有记录就是这个号的</Text>
          </Pressable>
        </View> : null}
        <View style={styles.actions}>
          {(["videos", "chat"] as const).map(kind => <Pressable key={kind} accessibilityRole="checkbox"
            accessibilityLabel={kind === "videos" ? "读取视频" : "读取聊天"} accessibilityState={{ checked: readPermissions[kind], disabled }}
            aria-checked={readPermissions[kind]} disabled={disabled} onPress={() => setReadPermissions(current => ({ ...current, [kind]: !current[kind] }))}
            style={[styles.option, readPermissions[kind] && styles.selected, disabled && styles.disabled]} testID={kind === "videos" ? "browser-read-videos" : "browser-read-chat"}>
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
            <Text style={styles.text}>{item.id === "app" ? "在应用里登录" : `${item.label} · ${!item.available ? "未找到" : item.debugging ? "可连接" : "需开启调试"}`}</Text>
          </Pressable>)}
        </View>
        {inApp ? <Text style={styles.detail}>点“扫码登录”后这里会显示抖音的登录二维码，用抖音 App 扫一扫并在手机上确认，再核对账号导入凭据。登录状态只存在本应用里，不用打开浏览器调试。</Text> : <>
          {source ? <Text selectable style={styles.detail}>未开启调试时，点击“连接浏览器”会尝试自动打开 {source.label} 的调试设置页。勾选允许远程调试后再次连接；也可手动打开 {source.inspectUrl}。连接时请在浏览器中允许。</Text> : null}
          <Text style={styles.detail}>调试权限覆盖整个浏览器；工作台仅访问自己创建的抖音页面和抖音 Cookie。导出后可关闭调试开关，无需安装扩展。</Text>
        </>}
        <View style={styles.actions}>
          <Action label={busy ? "连接处理中…" : inApp ? "扫码登录" : "连接浏览器"} disabled={disabled || !source?.available} onPress={connect} testID="browser-login-connect" />
          <Action label="刷新检测" disabled={disabled} onPress={() => { void refresh(); }} testID="browser-login-refresh" />
          {status?.browserSource?.connected ? <Action label="断开连接" disabled={disabled} onPress={() => disconnect()} testID="browser-login-disconnect" /> : null}
        </View>
      </>}
      {waitingForScan ? <View style={styles.qrcode}>
        {qrcode ? <Image source={{ uri: qrcode.image }} style={styles.qrcodeImage} accessibilityLabel="抖音登录二维码" testID="browser-login-qrcode" />
          : <View style={[styles.qrcodeImage, styles.qrcodePending]}><ActivityIndicator size="small" color={color.accent} /></View>}
        <Text style={styles.detail} accessibilityLiveRegion="polite">{qrcode ? qrcode.hint || "用抖音 App 扫一扫" : "正在打开抖音登录…"}</Text>
        <Action label="在窗口里登录" disabled={false} onPress={() => { void showBrowserLoginWindow(baseUrl, token).catch(reason => setError(reason instanceof Error ? reason.message : "登录窗口打不开。")); }} testID="browser-login-show-window" />
      </View> : null}
      {busy ? <View style={styles.actions}>
        <ActivityIndicator size="small" color={color.accent} />
        <Text style={styles.detail} accessibilityLiveRegion="polite">{candidate ? (inApp ? "正在导出凭据，请稍等。抖音要求安全验证时会弹出窗口，在窗口里完成后会接着导入。" : "正在导出凭据，完成前请保持浏览器打开。")
          : inApp ? "打开抖音 App，点左上角的扫一扫扫码并在手机上确认。要做安全验证、或想用手机验证码登录时，点“在窗口里登录”。工作台会自动继续，最多等待 5 分钟。"
          : "请按提示开启调试或允许连接；进入抖音页面后完成登录或验证，未弹出登录框时可点击“登录”。工作台会自动继续，最多等待 5 分钟。"}</Text>
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
  qrcode: { alignItems: "flex-start", gap: 8 },
  qrcodeImage: { width: 180, height: 180, borderRadius: 6, backgroundColor: "#FFFFFF" },
  qrcodePending: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border },
});
