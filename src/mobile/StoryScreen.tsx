import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, Text, View } from "react-native";
import { ChevronLeft, Download } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { buildReportModel } from "../components/workspace/ReportWorkspace";
import { buildPersonalSummary } from "../domain/annualReport";
import { buildStoryData, type StoryData } from "../services/storyData";
import { personalRecords, type MobileSnapshot } from "./collectionData";
import { exportMobileFile } from "./mobileExport";
import { STORY_PAGES, storyDocument, type StoryPage } from "./storyDocument";
import { C, mono, ui } from "./mobileUi";

export type StoryStyle = "trace" | "archive" | "poster";
export const STORY_STYLES: Array<{ id: StoryStyle; label: string; en: string }> = [
  { id: "trace", label: "内容年志", en: "TRACE" }, { id: "archive", label: "档案馆", en: "ARCHIVE" }, { id: "poster", label: "海报", en: "POSTER" },
];
// The heaviest computation in the app (~10× slower on Hermes than in a desktop browser). Snapshots are immutable,
// so it runs once per saved snapshot; AndroidApp warms it while idle so opening a story does not freeze the tap.
const stories = new WeakMap<MobileSnapshot, StoryData>();
export function storyDataFor(snapshot: MobileSnapshot): StoryData {
  let result = stories.get(snapshot);
  if (result) return result;
  const records = personalRecords(snapshot);
  const summary = buildPersonalSummary(records, { source: "collector", partial: Object.values(snapshot.collections).some(item => !item.incrementalReady) });
  result = buildStoryData(buildReportModel(records, [], summary, []), {
    records, chatMessages: [], chatConversations: [], source: "collector", updatedAt: snapshot.savedAt, warnings: [],
  });
  result.counts.chat = null;
  stories.set(snapshot, result);
  return result;
}
export const hasStoryData = (snapshot: MobileSnapshot) => stories.has(snapshot);

export function StoryScreen({ snapshot, style, onClose }: { snapshot: MobileSnapshot; style: StoryStyle; onClose: () => void }) {
  const [page, setPage] = useState<StoryPage>(style === "archive" ? "story-archive.html" : style === "poster" ? "story-poster.html" : "story-entry.html");
  const [notice, setNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const browser = useRef<WebView>(null);
  const bridgeId = useRef(`story-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingExport = useRef<string | null>(null);
  const [data, setData] = useState<StoryData | undefined>(() => hasStoryData(snapshot) ? storyDataFor(snapshot) : undefined);
  useEffect(() => {
    if (hasStoryData(snapshot)) { setData(storyDataFor(snapshot)); return; }
    // Let the sheet slide in with its spinner before the JS thread is busy.
    const timer = setTimeout(() => setData(storyDataFor(snapshot)), 120);
    return () => clearTimeout(timer);
  }, [snapshot]);
  // Swap pages without unmounting the WebView: the entry card ends on white and the story opens on white,
  // so dropping to a dark spinner in between was a visible flash.
  const [source, setSource] = useState<{ html: string; baseUrl: string }>();
  useEffect(() => {
    let active = true;
    setNotice("");
    if (!data) return;
    storyDocument(page, data, { bridgeId: bridgeId.current })
      .then(html => { if (active) setSource({ html, baseUrl: `file:///android_asset/story/${page}?motion=full` }); })
      .catch(() => { if (active) setNotice("故事页加载失败，请返回后重试。"); });
    return () => { active = false; };
  }, [page, data]);
  useEffect(() => () => { if (exportTimer.current) clearTimeout(exportTimer.current); }, []);
  const html = source?.baseUrl.includes(`/${page}?`) ? source.html : undefined;
  function exportStory() {
    if (!browser.current || exporting) return;
    const id = `story-${Date.now()}`; pendingExport.current = id; setExporting(true);
    exportTimer.current = setTimeout(() => { pendingExport.current = null; setExporting(false); setNotice("导出超时，请稍后重试。"); }, 15000);
    // Read the visible privacy switch, and reuse the existing story's anonymizer.
    browser.current.injectJavaScript(`(()=>{const privacy=document.body.classList.contains('privacy-on');const data=privacy?window.StoryExport.scrub(window.__STORY_EXPORT__.data,{privateTopics:${page === "story-archive.html"}}):window.__STORY_EXPORT__.data;window.ReactNativeWebView.postMessage(JSON.stringify({type:'story-export',bridgeId:${JSON.stringify(bridgeId.current)},requestId:${JSON.stringify(id)},privacy,data}));})();true;`);
  }
  const label = page === "story-archive.html" ? "档案馆" : page === "story-poster.html" ? "海报" : "内容年志";
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={[ui.screen, { backgroundColor: "#0c1220" }]}>
    <View style={{ height: 52, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", backgroundColor: C.bg, borderBottomWidth: 1, borderColor: C.line }}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回报告" onPress={onClose} hitSlop={8}
        android_ripple={{ color: "rgba(243,238,227,0.1)", borderless: true }} style={{ flexDirection: "row", alignItems: "center", padding: 8, minWidth: 88 }}>
        <ChevronLeft size={22} color={C.text} /><Text style={{ color: C.text, fontSize: 15 }}>返回</Text>
      </Pressable>
      <Text style={{ flex: 1, textAlign: "center", color: C.sub, fontFamily: mono, fontSize: 11, letterSpacing: 2 }}>{label}</Text>
      <View style={{ minWidth: 88, alignItems: "flex-end" }}>
        {page !== "story-entry.html" ? <Pressable accessibilityRole="button" accessibilityLabel="导出故事" disabled={!html || exporting} onPress={exportStory} hitSlop={8}
          android_ripple={{ color: "rgba(243,238,227,0.1)", borderless: true }} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, opacity: !html || exporting ? 0.4 : 1 }}>
          <Download size={18} color={C.accent} /><Text style={{ color: C.accent, fontSize: 14, fontWeight: "600" }}>{exporting ? "导出中" : "导出"}</Text>
        </Pressable> : null}
      </View>
    </View>
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: C.text, backgroundColor: C.raised, paddingHorizontal: 16, paddingVertical: 10, fontSize: 13 }}>{notice}</Text> : null}
    {!source ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14 }}><ActivityIndicator color={C.accent} size="large" /><Text style={ui.meta}>正在装订你的{label}…</Text></View> : <WebView ref={browser} source={source} style={{ flex: 1, backgroundColor: page === "story-draft_副本.html" ? "#ffffff" : "#0c1220" }}
      originWhitelist={["*"]} javaScriptEnabled domStorageEnabled allowFileAccess allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false} mixedContentMode="never" webviewDebuggingEnabled={__DEV__}
      onShouldStartLoadWithRequest={request => {
        if (request.url === "about:blank") return true;
        try {
          const url = new URL(request.url);
          const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
          if (url.protocol === "file:" && url.pathname.startsWith("/android_asset/story/") && STORY_PAGES.includes(name as StoryPage)) {
            if (name !== page) { setPage(name as StoryPage); return false; }
            return true;
          }
          if (url.protocol === "https:" && ["www.douyin.com", "www.iesdouyin.com"].includes(url.hostname)) void Linking.openURL(request.url).catch(() => setNotice("无法打开原作品。"));
        } catch { /* reject unexpected navigation */ }
        return false;
      }}
      onMessage={event => {
        const origin = event.nativeEvent.url;
        if (!(origin.startsWith("file:///android_asset/story/") || ["file://", "null", "about:blank"].includes(origin)) || event.nativeEvent.data.length > 5000000) return;
        let message: { type?: string; bridgeId?: string; requestId?: string; privacy?: boolean; data?: StoryData };
        try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
        if (message.bridgeId !== bridgeId.current) return;
        if (message.type === "story-close") { onClose(); return; }
        if (message.type !== "story-export" || message.requestId !== pendingExport.current || !message.data || message.data.version !== 1) return;
        pendingExport.current = null; if (exportTimer.current) clearTimeout(exportTimer.current);
        void storyDocument(page, message.data, { offline: true, privacy: message.privacy === true })
          .then(document => exportMobileFile(`内容年志-${style}-${data?.year ?? ""}-${Date.now()}.html`, "text/html", document))
          .then(saved => setNotice(saved ? "故事页已导出，保留原有动效与当前隐私设置。" : "已取消导出。"))
          .catch(() => setNotice("故事页导出失败，本机数据仍保留。"))
          .finally(() => setExporting(false));
      }} onError={() => setNotice("故事页加载失败，请返回后重试。")}
      onRenderProcessGone={() => setNotice("系统回收了故事页，请返回后重新打开。")}
    />}
  </SafeAreaView></Modal>;
}
