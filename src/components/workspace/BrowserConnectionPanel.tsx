import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { cancelBrowserLogin, confirmBrowserLogin, disconnectBrowserLogin, getBrowserLoginQrCode, getBrowserLoginSources, getBrowserVerification, sendBrowserSmsVerify, type BrowserSmsVerify, inspectBrowserLogin, LocalCollectorError, showBrowserLoginWindow,
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
  /** 桌面版首屏用：少放说明文字 */
  compact?: boolean;
  /** 首屏点开二维码之前的那块，各版式自己画；文案和状态由这里算好 */
  renderStart?: (props: LoginStartProps) => React.ReactNode;
  /** 凭据没就绪：一挂上就在后台加载登录页、备好二维码，点「显示二维码」时直接亮出来 */
  preload?: boolean;
}

/** 首屏扫码那块：标题、一句说明，下面一个和二维码一样大的框——没点之前蒙着遮罩，点了遮罩消失、码在原地亮出来 */
export interface LoginStartProps {
  title: string;
  detail: string;
  /** 遮罩上的字 */
  label: string;
  busy: boolean;
  disabled: boolean;
  /** 已经登录、凭据可用 */
  done: boolean;
  /** 点开了：不再蒙遮罩 */
  revealed: boolean;
  /** 后台备好的二维码（data URL）；还没好是 null */
  image: string | null;
  /** 抖音弹出了身份验证（短信、密码、滑块之类）：方框换成「打开验证窗口」 */
  verify: boolean;
  /** 验证是「接收短信验证码」那一路时搬进工作台的东西；别的方式是 null，只给「打开验证窗口」 */
  sms: BrowserSmsVerify | null;
  /** 首屏上点的：选短信验证码、获取验证码、提交用户自己填的验证码 */
  onSms: (action: "choose" | "send" | "submit", code?: string) => void;
  onStart: () => void;
  /** 码下面那一行：点开后是「在窗口里登录」「取消」，没点开是「改用浏览器导入」的链接；也由版式画，颜色才跟页面一致 */
  actions: LoginStartAction[];
}

export interface LoginStartAction {
  kind: "window" | "cancel" | "other";
  label: string;
  onPress: () => void;
  testID: string;
}

export function BrowserConnectionPanel({ visible, baseUrl, token, status, blocked, onBusyChange, onChange, compact = false, renderStart, preload = false }: BrowserConnectionPanelProps) {
  const [sources, setSources] = useState<BrowserLoginSource[]>([]);
  const [selected, setSelected] = useState<BrowserLoginSource["id"]>("app");
  const [candidate, setCandidate] = useState<BrowserLoginCandidate | null>(null);
  const [readPermissions, setReadPermissions] = useState<CollectorReadPermissions>({ videos: true, chat: false });
  const [adopt, setAdopt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<{ image: string; hint: string; verify: boolean } | null>(null);
  // 首屏的紧凑版默认只给扫码，Chrome/Edge/Comet 收在一个链接后面
  const [showOther, setShowOther] = useState(false);
  // 预加载的二维码先藏着，用户点了才亮；revealedRef 给 connect 收尾时判断要不要报错
  const [revealed, setRevealed] = useState(false);
  const revealedRef = useRef(false); revealedRef.current = revealed;
  const preloadedRef = useRef(false);
  const renewRef = useRef(false);
  // 登录或导入时后台页面弹了身份验证没有：首屏要换成「去验证」，不能只剩一个转圈
  const [verifying, setVerifying] = useState(false);
  const [sms, setSms] = useState<BrowserSmsVerify | null>(null);
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

  // 抖音常在登录跳到主页后才弹身份验证，这时已认出账号、在等确认导入（不算 busy），也要接着查
  const watchVerify = compact && (busy || candidate !== null);
  useEffect(() => {
    if (!watchVerify) { setVerifying(false); setSms(null); return; }
    let stopped = false;
    const poll = () => getBrowserVerification(baseUrl, token).then(value => { if (!stopped) { setVerifying(value.verifying); setSms(value.sms); } }, () => {});
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [watchVerify, baseUrl, token]);
  const openVerifyWindow = () => { void showBrowserLoginWindow(baseUrl, token).catch(reason => setError(reason instanceof Error ? reason.message : "登录窗口打不开。")); };
  // 首屏上的短信验证码：只是替用户点后台页面里的同一个按钮、填同一个框；页面里找不到就请用户去窗口里做
  const onSms = (action: "choose" | "send" | "submit", code = "") => {
    setError(null);
    void sendBrowserSmsVerify(baseUrl, token, action, code).then(ok => {
      if (!ok) setError("没在验证页面里找到对应的按钮或输入框，请点「打开验证窗口」在窗口里完成。");
    }, reason => setError(reason instanceof Error ? reason.message : "没能交给验证页面，请在验证窗口里完成。"));
  };

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

  // fresh：换个号扫码。采集器会先关掉这个待确认的号，再清登录窗口里的登录状态
  const connect = (fresh = false) => run(async () => {
    const controller = new AbortController();
    connectControllerRef.current = controller; setConnecting(true);
    // 首屏换号时码直接亮出来，不再蒙遮罩
    if (fresh) { candidateRef.current = null; setCandidate(null); setRevealed(true); }
    try {
      const result = await inspectBrowserLogin(baseUrl, token, selected, status?.account?.id, controller.signal, fresh);
      if (controller.signal.aborted || !visibleRef.current) { await cancelBrowserLogin(baseUrl, token, result.id); return; }
      candidateRef.current = result; setCandidate(result);
      setReadPermissions(result.readPermissions ?? { videos: true, chat: false });
      setAdopt(true);
    } catch (reason) {
      // 首屏：抖音登录等了 5 分钟过期就自动续一张；上一次连接还没在采集器那边收完尾（刚取消、刚切回首屏）就稍等再来。
      // 点没点开都一样。别的失败没点开过就静悄悄收掉，点「显示二维码」时再加载
      if (compact && visibleRef.current && reason instanceof LocalCollectorError && ["browser_login_timeout", "collector_busy"].includes(reason.code)) {
        renewRef.current = true; return;
      }
      if (!controller.signal.aborted && (revealedRef.current || !compact)) throw reason;
    } finally {
      if (connectControllerRef.current === controller) connectControllerRef.current = null;
      // 要续的话「连接中」不落下，二维码那块原地转圈等新码，不闪回按钮
      if (!renewRef.current) { setConnecting(false); setRevealed(false); }
    }
  }).then(async () => {
    if (!renewRef.current) return;
    renewRef.current = false;
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (visibleRef.current && !connectControllerRef.current) void connect();
    else { setConnecting(false); setRevealed(false); }
  });
  useEffect(() => { if (!preload) preloadedRef.current = false; }, [preload]);
  useEffect(() => {
    if (!preload || !visible || blocked || preloadedRef.current || runningRef.current || candidateRef.current) return;
    if (selected !== "app" || !sources.some(item => item.id === "app")) return;
    preloadedRef.current = true;
    void connect();
  }, [preload, visible, blocked, selected, sources]);
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
  // 抖音桌面端：读本机客户端的登录态，没有调试端口也没有页面
  const desktopSource = selected === "desktop";
  const sourceLabel = (id: BrowserLoginSource["id"]) => sources.find(item => item.id === id)?.label ?? (id === "app" ? "应用内登录" : id);
  const disabled = busy || blocked;
  // 二次验证要扫的码（使用原设备扫码）已经透传过来了就照常显示码；别的验证（短信、密码、滑块）首屏换成「打开验证窗口」
  const verifyNeeded = verifying && !(waitingForScan && qrcode?.verify);
  if (compact && renderStart && inApp && verifyNeeded) {
    const after = candidate ? (busy ? "会接着导入凭据" : "回到这里确认导入") : "会接着登录";
    return (
      <View style={[styles.panel, styles.panelCompact]} testID="browser-login-panel">
        {renderStart({ title: "抖音要求身份验证", done: false, busy: false, revealed: false, image: null, verify: true, disabled: false, onStart: openVerifyWindow,
          label: "点击打开验证窗口", sms, onSms,
          actions: sms ? [{ kind: "window", label: "用其他方式验证", testID: "browser-login-show-window", onPress: openVerifyWindow }] : [],
          detail: sms
            ? `为保障账号安全，抖音要先确认是你本人。可以直接在这里收短信验证码，验证码由你自己填；也可以打开验证窗口换别的方式。完成后${after}。`
            : `为保障账号安全，抖音要先确认是你本人。点一下打开抖音的验证窗口，选一种方式完成验证（短信、密码都由你自己操作），完成后${after}。` })}
        {error ? <Text accessibilityLiveRegion="polite" style={styles.error} testID="browser-login-error">{error}</Text> : null}
      </View>
    );
  }
  // 首屏：二维码那块由版式画，没点之前蒙着遮罩（码其实已在后台备好），点了遮罩消失；改用浏览器导入时回到完整的选项
  if (compact && renderStart && !candidate && !showOther && inApp && (!busy || connecting)) {
    const loggedIn = status?.browserSource?.credentials === "ready";
    const name = status?.account?.nickname ? `「${status.account.nickname}」` : "";
    return (
      <View style={[styles.panel, styles.panelCompact]} testID="browser-login-panel">
        {renderStart({ title: "扫码登录抖音", done: loggedIn && !revealed, busy: false, revealed, verify: false, sms: null, onSms, image: waitingForScan ? qrcode?.image ?? null : null,
          disabled: (blocked && !connecting) || !source?.available,
          onStart: () => { setRevealed(true); if (!connecting) void connect(); },
          // 「改用别的方式导入」码亮着时也给，不用先取消
          actions: [
            ...(revealed ? [
              { kind: "window" as const, label: "在窗口里登录", testID: "browser-login-show-window", onPress: openVerifyWindow },
              { kind: "cancel" as const, label: "取消", testID: "browser-login-cancel-connect", onPress: () => connectControllerRef.current?.abort() },
            ] : []),
            ...(sources.length > 1 ? [{ kind: "other" as const, label: "改用 Chrome / Edge / Comet 或抖音桌面端导入", testID: "browser-login-other",
              onPress: () => { connectControllerRef.current?.abort(); setShowOther(true); } }] : []),
          ],
          label: loggedIn ? "点击重新扫码登录" : "点击显示二维码",
          detail: revealed ? qrcode?.hint || "打开抖音 App，点左上角的扫一扫，扫完在手机上确认。"
            : loggedIn ? `已登录${name}。凭据失效或要调整读取权限时，再扫一次就行。` : "用抖音 App 扫一扫，核对账号后自动开始读取。" })}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.detail} testID="browser-login-notice">{notice}</Text> : null}
        {error ? <Text accessibilityLiveRegion="polite" style={styles.error} testID="browser-login-error">{error}</Text> : null}
      </View>
    );
  }
  return (
    <View style={[styles.panel, compact && styles.panelCompact]} testID="browser-login-panel">
      <Text style={styles.title}>{compact ? "扫码登录抖音" : "导入登录凭据"}</Text>
      {compact ? null : <Text style={styles.detail}>登录抖音或连接浏览器后确认账号，分别选择读取视频和读取聊天。导入完成后只读取勾选的类型，并自动断开连接（浏览器里原有的标签页保留）；凭据失效或需要调整权限时，从这里重新导入。</Text>}
      {compact ? (status?.browserSource?.credentials === "ready" || status?.browserSource?.credentials === "exporting"
        ? <Text style={styles.detail} accessibilityLiveRegion="polite" testID="browser-login-status">
          {status.browserSource.credentials === "exporting" ? "正在导出凭据"
            : `已登录${status.account?.nickname ? `「${status.account.nickname}」` : ""}，凭据已导入。凭据失效或要调整读取权限时再扫一次。`}
        </Text> : null)
        : <Text style={styles.detail} accessibilityLiveRegion="polite" testID="browser-login-status">
          {status?.browserSource?.browser ? `${sourceLabel(status.browserSource.browser)} · ` : ""}
          {status?.browserSource?.credentials === "ready" ? (status.browserSource.browser === "app" ? "凭据已导入"
            : status.browserSource.browser === "desktop" ? "凭据已导入，读的是抖音电脑客户端的登录态"
            : "凭据已导入，浏览器可关闭")
            : status?.browserSource?.credentials === "exporting" ? "正在导出凭据" : "请连接浏览器并导入凭据"}
        </Text>}
      {status?.readPermissions && status.browserSource?.credentials === "ready" ? <Text style={styles.detail} testID="browser-read-permissions">当前账号：视频读取{status.readPermissions.videos ? "已开启" : "未开启"} · 聊天读取{status.readPermissions.chat ? "已开启" : "未开启"}</Text> : null}
      {candidate ? <>
        <Text style={styles.title} testID="browser-login-candidate">{inApp ? "扫码" : candidate.browser === "desktop" ? "抖音桌面端" : "浏览器"}登录的是「{candidate.nickname || "抖音账号"}」</Text>
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
        {candidate.browser === "desktop" ? <Text style={styles.detail}>抖音桌面端里存着收私信要用的操作证书，一起导入后聊天也能直接走接口；证书对不上时会在下一次打开客户端后自动补上。</Text> : null}
        {!readPermissions.videos && !readPermissions.chat ? <Text style={styles.error}>请至少选择一项读取权限。</Text> : null}
        <View style={styles.actions}>
          <Action label="确认导入" disabled={disabled || (!readPermissions.videos && !readPermissions.chat)} onPress={confirm} testID="browser-login-confirm" />
          <Action label="取消" disabled={disabled} onPress={cancel} testID="browser-login-cancel" />
          {candidate.browser === "app" ? <Action label="换个号扫码" disabled={disabled} onPress={() => connect(true)} testID="browser-login-switch" /> : null}
        </View>
      </> : <>
        {compact && !showOther ? null : <View accessibilityRole="radiogroup" accessibilityLabel="登录来源浏览器" style={styles.actions}>
          {sources.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label}
            accessibilityState={{ checked: item.id === selected, disabled: disabled || !item.available }} aria-checked={item.id === selected}
            disabled={disabled || !item.available} onPress={() => { setSelected(item.id); setNotice(null); setError(null); if (compact && item.id === "app") setShowOther(false); }}
            style={[styles.option, item.id === selected && styles.selected, !item.available && styles.disabled]} testID={`browser-login-${item.id}`}>
            <Text style={styles.text}>{item.id === "app" ? "在应用里登录"
              : item.id === "desktop" ? `抖音桌面端 · ${!item.available ? "未找到" : item.debugging ? "可读取" : "需在客户端登录"}`
              : `${item.label} · ${!item.available ? "未找到" : item.debugging ? "可连接" : "需开启调试"}`}</Text>
          </Pressable>)}
        </View>}
        {inApp ? compact ? null : <Text style={styles.detail}>点“扫码登录”后这里会显示抖音的登录二维码，用抖音 App 扫一扫并在手机上确认，再核对账号导入凭据。登录状态只存在本应用里，不用打开浏览器调试。</Text>
          : desktopSource ? <Text style={styles.detail}>直接读本机抖音电脑客户端里已登录的账号，不用开浏览器，也不用开调试端口。Mac 上会弹一次钥匙串授权，点「允许」即可。客户端正在写登录数据时等几秒再试；导入之后不打开客户端也能继续读取。</Text>
          : <>
          {source ? <Text selectable style={styles.detail}>未开启调试时，点击“连接浏览器”会尝试自动打开 {source.label} 的调试设置页。勾选允许远程调试后再次连接；也可手动打开 {source.inspectUrl}。连接时请在浏览器中允许。</Text> : null}
          <Text style={styles.detail}>调试权限覆盖整个浏览器；工作台仅访问自己创建的抖音页面和抖音 Cookie。导出后可关闭调试开关，无需安装扩展。</Text>
        </>}
        {compact && waitingForScan ? null : <View style={styles.actions}>
          <Action label={busy ? "连接处理中…" : inApp ? "扫码登录" : desktopSource ? "读取登录态" : "连接浏览器"} disabled={disabled || !source?.available} onPress={() => connect()} testID="browser-login-connect" />
          {compact && inApp ? null : <Action label="刷新检测" disabled={disabled} onPress={() => { void refresh(); }} testID="browser-login-refresh" />}
          {status?.browserSource?.connected ? <Action label="断开连接" disabled={disabled} onPress={() => disconnect()} testID="browser-login-disconnect" /> : null}
          {compact && sources.length > 1 ? <Action label={showOther ? "只用扫码" : "改用 Chrome / Edge / Comet"} disabled={disabled}
            onPress={() => { if (showOther) setSelected("app"); setShowOther(value => !value); }} testID="browser-login-other" /> : null}
        </View>}
      </>}
      {waitingForScan && !compact ? <View style={styles.qrcode}>
        {qrcode ? <Image source={{ uri: qrcode.image }} style={styles.qrcodeImage} accessibilityLabel="抖音登录二维码" testID="browser-login-qrcode" />
          : <View style={[styles.qrcodeImage, styles.qrcodePending]}><ActivityIndicator size="small" color={color.accent} /></View>}
        <Text style={styles.detail} accessibilityLiveRegion="polite">{qrcode ? qrcode.hint || "打开抖音 App，点左上角的扫一扫，扫完在手机上确认" : "正在打开抖音登录…"}</Text>
        <View style={styles.actions}>
          <Action label="在窗口里登录" disabled={false} onPress={openVerifyWindow} testID="browser-login-show-window" />
        </View>
      </View> : null}
      {busy && !(compact && waitingForScan) ? <View style={styles.actions}>
        <ActivityIndicator size="small" color={color.accent} />
        <Text style={styles.detail} accessibilityLiveRegion="polite">{candidate ? (inApp ? "正在导出凭据，请稍等。抖音要求安全验证时这里会提示，完成后会接着导入。" : "正在导出凭据，完成前请保持浏览器打开。")
          : inApp ? "打开抖音 App，点左上角的扫一扫扫码并在手机上确认。要做安全验证、或想用手机验证码登录时，点“在窗口里登录”。工作台会自动继续，最多等待 5 分钟。"
          : desktopSource ? "正在读抖音电脑客户端的登录态，完成后核对账号导入。"
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

export interface DesktopLogin {
  baseUrl: string;
  token: string | null;
  blocked: boolean;
  /** 首屏正在扫码登录或导入凭据：这时 App 的 switchingAccount 也是 true，但别写成「正在切换账号」 */
  loggingIn: boolean;
  onBusyChange: (busy: boolean) => void;
  onChange: (change: CollectorAccountChange) => Promise<void>;
}

/** 桌面版首屏：采集器在后台自己连，连上就在这里扫码登录，凭据没就绪时自动出码 */
export function FirstScreenLogin({ login, status, busy, onConnect, renderStart }: { login: DesktopLogin; status: CollectorStatus | null; busy: boolean; onConnect: () => void; renderStart: (props: LoginStartProps) => React.ReactNode }) {
  // 采集器在后台自己连，正常一两秒就好；连不上才让用户点一下重连
  if (!login.token) return (
    <View style={[styles.panel, styles.panelCompact]} testID="first-screen-login">
      {renderStart({ title: "扫码登录抖音", done: false, busy, disabled: busy, onStart: onConnect, revealed: false, verify: false, sms: null, onSms: () => {}, image: null, actions: [],
        label: busy ? "正在连接采集器…" : "点击重新连接采集器",
        detail: busy ? "应用自带的采集器正在启动，连上后就能扫码登录。" : "本机采集器还没连上，点下面重新连接。" })}
    </View>
  );
  const credentials = status?.browserSource?.credentials;
  return <BrowserConnectionPanel visible baseUrl={login.baseUrl} token={login.token} status={status} blocked={login.blocked}
    onBusyChange={login.onBusyChange} onChange={login.onChange} compact renderStart={renderStart}
    preload={status !== null && credentials !== "ready" && credentials !== "exporting"} />;
}

const styles = StyleSheet.create({
  panel: { gap: 12, paddingVertical: 18, borderTopWidth: 1, borderTopColor: color.border },
  panelCompact: { paddingVertical: 0, borderTopWidth: 0, gap: 10 },
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
