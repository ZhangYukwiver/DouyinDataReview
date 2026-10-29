import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { startActivityAsync } from "expo-intent-launcher";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { BROWSER_BOOTSTRAP_URL, HISTORY_PAGE, MAX_PROOF_BYTES, READER_ERRORS, isBootstrapSource, isDouyinPage, isLoginNavigation, parsePage, type ProofSnapshot } from "./proofData";
import { buildReaderScript } from "./readerScript";
import { loadProof, saveProof } from "./proofStorage";
import { parseVerificationMessage, verificationIntent, VERIFICATION_ERRORS } from "./verificationLink";
import { buildVerificationScript } from "./verificationScript";

const bootstrap = { html: "<!doctype html><html><body style='background:#faf9f6'></body></html>", baseUrl: BROWSER_BOOTSTRAP_URL };
const detectBrowser = "window.ReactNativeWebView.postMessage(JSON.stringify({type:'browser-ready',ua:navigator.userAgent}));true;";
const preparePage = "if(location.origin==='https://www.douyin.com')performance.setResourceTimingBufferSize(1500);true;";
const historySource = { uri: HISTORY_PAGE };
const loginHint = "在下方官网完成登录。若出现身份验证二维码，可点「在本机极速版验证」，完成后返回此页。";

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || pressed) && styles.dimmed]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

function ProofScreen() {
  const [snapshot, setSnapshot] = useState<ProofSnapshot | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [notice, setNotice] = useState("正在检查本机保存的记录…");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [agent, setAgent] = useState<string | undefined>();
  const [pageReady, setPageReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [browserNotice, setBrowserNotice] = useState(loginHint);
  const browser = useRef<WebView>(null);
  const pending = useRef<string | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVerification = useRef<string | null>(null);
  const verificationTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  function finishRead() {
    pending.current = null;
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    setBusy(false);
  }

  function finishVerification() {
    pendingVerification.current = null;
    if (verificationTimeout.current) clearTimeout(verificationTimeout.current);
    verificationTimeout.current = null;
    setVerifying(false);
  }

  useEffect(() => {
    let mounted = true;
    loadProof().then(({ snapshot: saved, warning }) => {
      if (!mounted) return;
      setSnapshot(saved);
      setNotice(warning ?? (saved ? "已从本机恢复。关闭应用后，这一页仍可离线查看。" : "尚未保存记录。先在本机登录并读取一页。"));
    }).catch(() => {
      if (mounted) setNotice("暂时无法读取本机文件，已有文件已保留。");
    }).finally(() => { if (mounted) setRestoring(false); });
    return () => {
      mounted = false;
      if (timeout.current) clearTimeout(timeout.current);
      if (verificationTimeout.current) clearTimeout(verificationTimeout.current);
      pendingVerification.current = null;
    };
  }, []);

  function openBrowser() {
    setPageReady(false);
    setAgent(undefined);
    setBrowserNotice(loginHint);
    setBrowserOpen(true);
  }

  function closeBrowser() {
    // Saving is short and must finish before its result can be discarded by a new read.
    if (busy && pending.current === null) return;
    finishRead();
    finishVerification();
    setBrowserOpen(false);
  }

  function readPage() {
    if (!pageReady || busy || verifying || !browser.current) return;
    const requestId = `${Date.now()}-${++sequence.current}`;
    pending.current = requestId;
    setBusy(true);
    setBrowserNotice("正在确认当前账号并读取一页观看历史…");
    timeout.current = setTimeout(() => {
      if (pending.current !== requestId) return;
      finishRead();
      setBrowserNotice(READER_ERRORS.timeout!);
    }, 40_000);
    browser.current.injectJavaScript(buildReaderScript(requestId));
  }

  function verifyOnPhone() {
    if (!pageReady || busy || verifying || !browser.current) return;
    const requestId = `verify-${Date.now()}-${++sequence.current}`;
    pendingVerification.current = requestId;
    setVerifying(true);
    setBrowserNotice("正在识别当前身份验证二维码…");
    verificationTimeout.current = setTimeout(() => {
      if (pendingVerification.current !== requestId) return;
      finishVerification();
      setBrowserNotice(VERIFICATION_ERRORS.timeout!);
    }, 10_000);
    browser.current.injectJavaScript(buildVerificationScript(requestId));
  }

  async function receiveMessage(event: WebViewMessageEvent) {
    const { data, url } = event.nativeEvent;
    if (data.length > MAX_PROOF_BYTES) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (!message || typeof message !== "object") return;
    if (!agent && message.type === "browser-ready" && isBootstrapSource(url)) {
      const version = typeof message.ua === "string" && message.ua.match(/Chrome\/(\d{2,3}\.\d+\.\d+\.\d+)/u)?.[1];
      if (!version) { setBrowserNotice("无法识别系统 WebView，请更新 Android System WebView 后重试。"); return; }
      // Request the full desktop site using the installed WebView's actual Chromium version.
      setAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`);
      return;
    }
    const verification = parseVerificationMessage(message, url, pendingVerification.current);
    if (verification) {
      finishVerification();
      if (verification.error || !verification.link) {
        setBrowserNotice(verification.error ?? VERIFICATION_ERRORS.invalid!);
        return;
      }
      setBrowserNotice("请在极速版中查看官方验证结果；如需确认，请由本人操作。随后切回此页等待登录结果，再打开观看历史。");
      setVerifying(true);
      try {
        // Never persist the QR link or infer authentication from the Intent result.
        await startActivityAsync("android.intent.action.VIEW", verificationIntent(verification.link));
      } catch {
        setBrowserNotice("无法打开本机极速版验证。请确认已安装并登录抖音极速版，或使用官方页面的其他验证方式。");
      } finally { setVerifying(false); }
      return;
    }
    if (!isDouyinPage(url) || !pending.current || message.requestId !== pending.current) return;
    if (message.type !== "error" && message.type !== "page") return;
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    pending.current = null;
    try {
      if (message.type === "error") {
        const code = typeof message.code === "string" && Object.hasOwn(READER_ERRORS, message.code) ? message.code : "format";
        setBrowserNotice(READER_ERRORS[code]!);
        return;
      }
      const page = parsePage(message);
      setBrowserNotice("正在保存到本机并校验…");
      const saved = await saveProof(page);
      setSnapshot(saved);
      setNotice(saved.records.length ? "已读取并保存。现在可以关闭应用、断网重开，验证本机恢复。" : "读取成功，抖音返回的这一页没有记录。空页也已保存到本机。");
      setBrowserOpen(false);
    } catch (error) {
      setBrowserNotice(error instanceof Error ? error.message : "保存失败，上一份记录已保留。");
    } finally { setBusy(false); }
  }

  return <SafeAreaView style={styles.screen}>
    <StatusBar style="dark" />
    <FlatList data={snapshot?.records ?? []} keyExtractor={(record, index) => `${record.id}:${record.watchedAt}:${index}`}
      contentContainerStyle={styles.content} ListHeaderComponent={<>
        <Text style={styles.eyebrow}>DOUYIN DATA REVIEW · ANDROID</Text>
        <Text style={styles.heading}>把一页记录，留在手机里。</Text>
        <Text style={styles.description}>独立运行验证版 · 仅观看历史</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>登录 → 读取 → 保存 → 重启恢复</Text>
          <Text style={styles.body}>登录和请求在本机的抖音网页内完成。每次最多保存 20 条；本版保留最近读取的一页，不代表完整历史。</Text>
          <Button label={snapshot ? "重新登录 / 读取一页" : "登录并读取一页"} onPress={openBrowser} disabled={restoring} />
        </View>
        <View accessibilityLiveRegion="polite" style={styles.notice}>
          {restoring ? <ActivityIndicator color="#205c45" /> : null}
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
        {snapshot ? <View style={styles.account}>
          <Text style={styles.cardTitle}>{snapshot.account.nickname}</Text>
          <Text selectable style={styles.meta}>账号 {snapshot.account.id}</Text>
          <Text style={styles.meta}>{snapshot.records.length} 条 · {snapshot.hasMore ? "平台还有后续页，本版未读取" : "平台返回已到末页"}</Text>
          <Text style={styles.meta}>保存于 {new Date(snapshot.savedAt).toLocaleString()}</Text>
        </View> : null}
      </>}
      ListEmptyComponent={!restoring ? <Text style={styles.empty}>{snapshot ? "这一页没有观看记录。" : "这里将显示你实际读取的记录。"}</Text> : null}
      renderItem={({ item, index }) => <View style={styles.record}>
        <Text style={styles.number}>{String(index + 1).padStart(2, "0")}</Text>
        <View style={styles.recordBody}>
          <Text style={styles.recordTitle}>{item.title}</Text>
          <Text style={styles.meta}>{item.author}</Text>
          <Text style={styles.meta}>观看时间：{item.watchedAt ? new Date(item.watchedAt).toLocaleString() : "平台未提供"}</Text>
          <Text selectable style={styles.meta}>作品 {item.id}</Text>
        </View>
      </View>} />
    <Modal visible={browserOpen} animationType="slide" onRequestClose={closeBrowser}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.browserHeader}>
          <View style={styles.browserButtons}>
            <Button label="返回记录" secondary onPress={closeBrowser} disabled={busy && pending.current === null} />
            <Button label={busy ? "读取中…" : "读取并保存一页"} onPress={readPage} disabled={!pageReady || busy || verifying} />
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.browserHint}>{browserNotice}</Text>
          <Button label={verifying ? "正在打开验证…" : "在本机极速版验证"} secondary onPress={verifyOnPhone} disabled={!pageReady || busy || verifying} />
          <Pressable accessibilityRole="button" disabled={!agent || busy || verifying} accessibilityState={{ disabled: !agent || busy || verifying }}
            style={styles.historyLink} onPress={() => browser.current?.injectJavaScript(`window.location.assign(${JSON.stringify(HISTORY_PAGE)});true;`)}>
            <Text style={styles.historyLinkText}>打开我的观看历史 →</Text>
          </Pressable>
        </View>
        {browserOpen ? <WebView ref={browser} style={styles.webview} source={agent ? historySource : bootstrap} userAgent={agent}
          originWhitelist={["*"]} onShouldStartLoadWithRequest={request => {
            if (!agent && isBootstrapSource(request.url)) return true;
            const allowed = isLoginNavigation(request.url);
            if (!allowed) setBrowserNotice("此验证版仅在应用内打开抖音登录相关网页。请使用网页的登录方式。");
            return allowed;
          }}
          injectedJavaScriptBeforeContentLoaded={preparePage} injectedJavaScript={agent ? preparePage : detectBrowser}
          onMessage={receiveMessage} javaScriptEnabled domStorageEnabled thirdPartyCookiesEnabled webviewDebuggingEnabled
          setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false}
          allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never" mediaPlaybackRequiresUserAction
          onLoadStart={() => { setPageReady(false); finishVerification(); }}
          onLoadEnd={event => setPageReady(Boolean(agent && isDouyinPage(event.nativeEvent.url)))}
          onError={() => { setPageReady(false); setBrowserNotice("网页加载失败，请返回记录后重新打开。已有记录仍可查看。"); }}
          onRenderProcessGone={() => { finishRead(); finishVerification(); setPageReady(false); setBrowserNotice("系统关闭了网页，请返回记录后重新打开。"); }}
        /> : null}
      </SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

export default function AndroidProof() {
  return <SafeAreaProvider><ProofScreen /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#faf9f6" },
  content: { padding: 22, paddingBottom: 40 },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: "#5c655f", marginTop: 12, marginBottom: 14 },
  heading: { fontSize: 30, lineHeight: 40, fontWeight: "700", color: "#182c22", maxWidth: 330 },
  description: { color: "#647067", fontSize: 14, marginTop: 12, marginBottom: 24 },
  card: { backgroundColor: "#fff", borderColor: "#dce2dc", borderWidth: 1, padding: 18, borderRadius: 16, gap: 14 },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#203a2a" },
  body: { fontSize: 14, lineHeight: 23, color: "#59655b" },
  button: { backgroundColor: "#205c45", borderRadius: 10, minHeight: 48, justifyContent: "center", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 },
  secondary: { backgroundColor: "#edf0eb" },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  secondaryText: { color: "#205c45" },
  dimmed: { opacity: 0.5 },
  notice: { flexDirection: "row", gap: 10, paddingVertical: 18 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 21, color: "#526456" },
  account: { borderTopWidth: 1, borderTopColor: "#dce2dc", paddingVertical: 16, gap: 5 },
  meta: { color: "#6b746d", fontSize: 12, lineHeight: 19 },
  empty: { color: "#7a837c", textAlign: "center", paddingVertical: 36, fontSize: 14 },
  record: { flexDirection: "row", gap: 14, paddingVertical: 16, borderTopWidth: 1, borderTopColor: "#e4e7e0" },
  number: { color: "#8c9b8e", fontSize: 13, paddingTop: 2, minWidth: 22 },
  recordBody: { flex: 1, gap: 5 },
  recordTitle: { fontSize: 15, lineHeight: 23, fontWeight: "500", color: "#28382d" },
  browserHeader: { padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: "#dce2dc" },
  browserButtons: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  browserHint: { color: "#526456", fontSize: 12, lineHeight: 18 },
  historyLink: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  historyLinkText: { fontSize: 13, color: "#205c45", fontWeight: "600" },
  webview: { flex: 1, backgroundColor: "#fff" },
});
