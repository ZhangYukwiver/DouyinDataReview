import React, { useEffect, useRef, useState } from "react";
import { BackHandler, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { startActivityAsync } from "expo-intent-launcher";
import { BROWSER_BOOTSTRAP_URL, HISTORY_PAGE, MAX_PROOF_BYTES, READER_ERRORS, isBootstrapSource, isDouyinPage, isLoginNavigation, parsePage } from "./proofData";
import { buildSessionScript } from "./readerScript";
import { parseVerificationMessage, verificationIntent, VERIFICATION_ERRORS } from "./verificationLink";
import { buildVerificationScript } from "./verificationScript";
import { nativeBridge, type DirectContext } from "./nativeBridge";
import { Button, C, ui } from "./mobileUi";

const bootstrap = { html: "<!doctype html><html><body></body></html>", baseUrl: BROWSER_BOOTSTRAP_URL };
const detect = "window.ReactNativeWebView.postMessage(JSON.stringify({type:'browser-ready',ua:navigator.userAgent}));true;";
const prepare = "if(location.origin==='https://www.douyin.com')performance.setResourceTimingBufferSize(1500);true;";
const historySource = { uri: HISTORY_PAGE };

// Used only for login/verification or one-time migration of the old WebView session.
// Once configured, syncAllContent never mounts this component and uses native HTTP.
export function SessionBrowser({ accountId, interactive, onReady, onCancel }: {
  accountId?: string; interactive: boolean; onReady: () => void; onCancel: () => void;
}) {
  const [visible, setVisible] = useState(interactive);
  const [agent, setAgent] = useState<string>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState("请在官网完成登录，打开观看历史后点「登录完成，继续」。");
  const browser = useRef<WebView>(null);
  const pending = useRef<string | null>(null);
  const verification = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => { onCancel(); return true; });
    const reveal = setTimeout(() => {
      if (mounted.current) { setVisible(true); setNotice("还未取得有效登录会话，请在官网确认登录后继续。"); }
    }, 35_000);
    return () => { mounted.current = false; back.remove(); clearTimeout(reveal); if (timer.current) clearTimeout(timer.current); if (retry.current) clearTimeout(retry.current); };
  }, []);
  function finish() {
    pending.current = null; verification.current = null;
    if (timer.current) clearTimeout(timer.current);
    setBusy(false); setVerifying(false);
  }
  function capture() {
    if (!browser.current || pending.current || verification.current) return;
    const id = `session-${Date.now()}-${++sequence.current}`;
    pending.current = id; setBusy(true); attempts.current++;
    timer.current = setTimeout(() => { finish(); setVisible(true); setNotice("确认登录超时，请检查网页后重试。"); }, 40_000);
    browser.current.injectJavaScript(buildSessionScript(id, accountId));
  }
  function verifyOnPhone() {
    if (!browser.current || busy || verifying) return;
    const id = `verify-${Date.now()}-${++sequence.current}`;
    verification.current = id; setVerifying(true);
    timer.current = setTimeout(() => { finish(); setNotice(VERIFICATION_ERRORS.timeout!); }, 10_000);
    browser.current.injectJavaScript(buildVerificationScript(id));
  }
  async function receive(event: WebViewMessageEvent) {
    const { data, url } = event.nativeEvent;
    if (!mounted.current || data.length > MAX_PROOF_BYTES) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (!agent && message.type === "browser-ready" && isBootstrapSource(url)) {
      const version = typeof message.ua === "string" && message.ua.match(/Chrome\/(\d{2,3}\.\d+\.\d+\.\d+)/u)?.[1];
      if (!version) { setVisible(true); setNotice("无法识别系统 WebView，请更新后重试。"); return; }
      setAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`);
      return;
    }
    const result = parseVerificationMessage(message, url, verification.current);
    if (result) {
      finish();
      if (result.error || !result.link) { setNotice(result.error ?? VERIFICATION_ERRORS.invalid!); return; }
      setVerifying(true); setNotice("请在极速版由本人确认身份，再返回继续。");
      try { await startActivityAsync("android.intent.action.VIEW", verificationIntent(result.link)); }
      catch { if (mounted.current) setNotice("无法打开极速版，请使用官网登录页的其他验证方式。"); }
      finally { if (mounted.current) setVerifying(false); }
      return;
    }
    if (!isDouyinPage(url) || !pending.current || message.requestId !== pending.current) return;
    if (message.type !== "error" && message.type !== "session") return;
    finish();
    if (message.type === "error") {
      if (message.code === "template" && attempts.current < 15 && !visible) {
        retry.current = setTimeout(capture, 1500); return;
      }
      setVisible(true);
      setNotice(message.code === "account" ? "请登录与本机记录一致的原账号，再继续。"
        : typeof message.code === "string" && Object.hasOwn(READER_ERRORS, message.code) ? READER_ERRORS[message.code]! : READER_ERRORS.format!);
      return;
    }
    try {
      const account = parsePage({ account: message.account, records: [], hasMore: false }).account;
      if (accountId && account.id !== accountId) throw new Error("account");
      const context = message.context as DirectContext;
      if (!context || context.userAgent !== agent || typeof context.values !== "object") throw new Error("context");
      setBusy(true);
      await nativeBridge.configure(JSON.stringify(context));
      if (mounted.current) onReady();
    } catch {
      if (mounted.current) { setBusy(false); setVisible(true); setNotice("无法保存采集会话，请确认当前账号后重试。原有数据已保留。"); }
    }
  }
  return <View pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: visible ? 100 : -1, opacity: visible ? 1 : 0, backgroundColor: C.bg }}>
    <SafeAreaView style={ui.screen}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 10, borderBottomWidth: 1, borderColor: C.line }}>
        <View style={ui.row}>
          <Button label="返回" kind="ghost" onPress={onCancel} />
          <Button label={busy ? "确认中…" : "登录完成，继续"} grow onPress={capture} disabled={!ready || busy || verifying} />
        </View>
        <Text accessibilityLiveRegion="polite" style={[ui.meta, { color: C.sub }]}>{notice}</Text>
        <View style={ui.row}>
          <Button label="本机极速版验证" kind="ghost" grow onPress={verifyOnPhone} disabled={!ready || busy || verifying} />
          <Button label="打开观看历史" kind="ghost" grow disabled={!agent || busy || verifying}
            onPress={() => browser.current?.injectJavaScript(`window.location.assign(${JSON.stringify(HISTORY_PAGE)});true;`)} />
        </View>
      </View>
      <WebView ref={browser} style={{ flex: 1 }} source={agent ? historySource : bootstrap} userAgent={agent}
        originWhitelist={["*"]} onShouldStartLoadWithRequest={request => !agent && isBootstrapSource(request.url) || isLoginNavigation(request.url)}
        injectedJavaScriptBeforeContentLoaded={prepare} injectedJavaScript={agent ? prepare : detect}
        onMessage={receive} javaScriptEnabled domStorageEnabled thirdPartyCookiesEnabled webviewDebuggingEnabled={__DEV__}
        setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never" mediaPlaybackRequiresUserAction
        onLoadStart={() => { setReady(false); finish(); if (retry.current) clearTimeout(retry.current); }}
        onLoadEnd={event => {
          const loaded = Boolean(agent && isDouyinPage(event.nativeEvent.url)); setReady(loaded);
          if (loaded && !interactive && !visible) retry.current = setTimeout(capture, 1000);
        }}
        onError={() => { setReady(false); finish(); setVisible(true); setNotice("网页加载失败，请返回后重试。"); }}
        onRenderProcessGone={() => { setReady(false); finish(); setVisible(true); setNotice("系统关闭了网页，请返回后重试。"); }} />
    </SafeAreaView>
  </View>;
}
