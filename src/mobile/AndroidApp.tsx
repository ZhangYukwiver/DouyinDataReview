import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, FlatList, Image, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Svg, { Circle, Defs, Rect, RadialGradient, Stop } from "react-native-svg";
import { ChartColumn, ChevronRight, FileDown, House, Library, LogIn, RefreshCw, Search, ShieldCheck, Square, X } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { PersonalRecordType } from "../domain/personalRecords";
import { COLLECTION_TYPES, type CollectionPage, type MobileRecord, type MobileSnapshot } from "./collectionData";
import { loadCollections, saveCollectionPage, saveCollectionState } from "./collectionStorage";
import { SessionBrowser } from "./SessionBrowser";
import { nativeBridge } from "./nativeBridge";
import { directErrorMessage, syncAllContent } from "./directCollection";
import { StoryScreen, storyDataFor, type StoryStyle } from "./StoryScreen";
import { ReportScreen } from "./ReportScreen";
import { reportFor } from "./mobileReport";
import { exportMobileFile, mobileBackup } from "./mobileExport";
import { Button, C, STREAM, Segmented, serif, ui } from "./mobileUi";

type Tab = "home" | "library" | "report";
const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "home", label: "概览", icon: House }, { id: "library", label: "内容", icon: Library }, { id: "report", label: "报告", icon: ChartColumn },
];
const zone = { timeZone: "Asia/Shanghai" } as const;
function when(iso: string) {
  const date = new Date(iso), day = (value: Date) => value.toLocaleDateString("zh-CN", zone);
  const time = date.toLocaleTimeString("zh-CN", { ...zone, hour: "2-digit", minute: "2-digit", hour12: false });
  if (day(date) === day(new Date())) return `今天 ${time}`;
  if (day(date) === day(new Date(Date.now() - 86_400_000))) return `昨天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { ...zone, month: "numeric", day: "numeric" })} ${time}`;
}

const Row = memo(function Row({ item, type, onOpen }: { item: MobileRecord; type: PersonalRecordType; onOpen: (id: string) => void }) {
  const [broken, setBroken] = useState(false);
  const meta = [item.author, item.durationSeconds ? `${Math.round(item.durationSeconds)} 秒` : ""].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="link" onPress={() => onOpen(item.id)} android_ripple={{ color: "rgba(243,238,227,0.06)" }}
    style={{ flexDirection: "row", gap: 14, paddingVertical: 12, paddingHorizontal: 20 }}>
    <View style={{ width: 60, height: 80, borderRadius: 10, overflow: "hidden", backgroundColor: C.raised, alignItems: "center", justifyContent: "center" }}>
      {item.coverUrl && !broken ? <Image source={{ uri: item.coverUrl }} onError={() => setBroken(true)} resizeMode="cover" style={{ width: 60, height: 80 }} />
        : <Text style={{ fontFamily: serif, fontSize: 22, color: STREAM[type] }}>{(item.author || item.title).slice(0, 1)}</Text>}
    </View>
    <View style={{ flex: 1, gap: 4, justifyContent: "center" }}>
      <Text numberOfLines={2} style={{ color: C.text, fontSize: 15, lineHeight: 21 }}>{item.title || "（无标题）"}</Text>
      {meta ? <Text numberOfLines={1} style={ui.meta}>{meta}</Text> : null}
      <Text numberOfLines={1} style={[ui.meta, { color: item.topics.length ? "rgba(240,162,78,0.75)" : C.faint }]}>
        {item.watchedAt ? when(item.watchedAt) : type === "watch_history" ? "平台未提供观看时间" : ""}
        {item.topics.length ? `${item.watchedAt || type === "watch_history" ? "  " : ""}${item.topics.slice(0, 3).map(value => `#${value}`).join(" ")}` : ""}
      </Text>
    </View>
  </Pressable>;
});

function Working() {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(x, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start(); return () => loop.stop();
  }, [x]);
  return <View style={{ height: 3, borderRadius: 2, backgroundColor: C.raised, overflow: "hidden" }}>
    <Animated.View style={{ width: "40%", height: 3, borderRadius: 2, backgroundColor: C.accent,
      transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] }) }] }} />
  </View>;
}

function Glow() {
  return <Svg style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} width="100%" height="100%">
    <Defs><RadialGradient id="g" cx="0.85" cy="0.1" r="0.8">
      <Stop offset="0" stopColor="#f0a24e" stopOpacity="0.32" /><Stop offset="0.55" stopColor="#f0a24e" stopOpacity="0.04" /><Stop offset="1" stopColor="#f0a24e" stopOpacity="0" />
    </RadialGradient></Defs>
    <Rect width="100%" height="100%" fill="url(#g)" />
    <Circle cx="86%" cy="18%" r="62" stroke="#f3eee3" strokeOpacity={0.12} strokeDasharray="1 5" fill="none" />
  </Svg>;
}

function MobileWorkspace() {
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const current = useRef<MobileSnapshot | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [storageFailed, setStorageFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [type, setType] = useState<PersonalRecordType>("watch_history");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("正在恢复本机记录…");
  const [exporting, setExporting] = useState(false);
  const [session, setSession] = useState<{ interactive: boolean } | null>(null);
  const sessionResult = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const syncAbort = useRef<AbortController | null>(null);
  const [story, setStory] = useState<{ snapshot: MobileSnapshot; style: StoryStyle } | null>(null);
  const collection = snapshot?.collections[type];
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const all = collection?.records ?? [];
    const filtered = needle ? all.filter(item => `${item.title} ${item.author} ${item.topics.join(" ")}`.toLocaleLowerCase().includes(needle)) : all;
    return [...filtered].sort((left, right) => (Date.parse(right.watchedAt ?? "") || 0) - (Date.parse(left.watchedAt ?? "") || 0));
  }, [collection, query]);
  const total = snapshot ? COLLECTION_TYPES.reduce((sum, item) => sum + snapshot.collections[item.id].records.length, 0) : 0;

  useEffect(() => {
    let mounted = true;
    loadCollections().then(({ snapshot: saved, warning }) => {
      if (!mounted) return;
      current.current = saved; setSnapshot(saved);
      setNotice(warning ?? (saved ? "已恢复本机记录，内容和报告都能离线看。" : "登录自己的抖音账号，开始把内容留在手机里。"));
    }).catch(error => {
      if (mounted) { setStorageFailed(true); setNotice(error instanceof Error ? error.message : "本机文件无法读取，已有文件已保留。"); }
    }).finally(() => { if (mounted) setRestoring(false); });
    const appState = AppState.addEventListener("change", state => {
      if (state === "background" && syncAbort.current && !sessionResult.current) syncAbort.current.abort();
    });
    return () => { mounted = false; appState.remove(); syncAbort.current?.abort(); };
  }, []);
  // Precompute the story and the first report while nothing else happens, so opening them is instant.
  useEffect(() => {
    if (!snapshot || syncing) return;
    const timers = [setTimeout(() => storyDataFor(snapshot), 900), setTimeout(() => reportFor(snapshot, "summary"), 1500)];
    return () => timers.forEach(clearTimeout);
  }, [snapshot, syncing]);

  function login(interactive: boolean) {
    return new Promise<void>((resolve, reject) => {
      sessionResult.current = { resolve, reject }; setSession({ interactive });
    });
  }
  async function saveState(next: MobileSnapshot) {
    const saved = await saveCollectionState(next); current.current = saved; setSnapshot(saved);
  }
  async function startSync(mode: "incremental" | "full") {
    if (syncAbort.current || restoring || storageFailed || session) return;
    const controller = new AbortController(); syncAbort.current = controller; setSyncing(true); setStopping(false);
    setNotice("正在准备采集会话…");
    try {
      if (!await nativeBridge.hasContext()) {
        setNotice("正在复用原有登录状态，初始化无头采集…");
        await login(false);
      }
      const added = await syncAllContent(mode, controller.signal, { getSnapshot: () => current.current, savePage, saveState, progress: setNotice });
      setNotice(`采集完成：新增观看 ${added.watch_history}、喜欢 ${added.liked_videos}、收藏 ${added.favorite_videos} 条，报告已更新。`);
    } catch (error) { setNotice(directErrorMessage(error)); }
    finally { syncAbort.current = null; setSyncing(false); setStopping(false); }
  }
  function stopSync() {
    syncAbort.current?.abort(); setStopping(true); setNotice("正在停止采集，已保存的内容会保留…");
    if (sessionResult.current) { sessionResult.current.reject(new Error("cancelled")); sessionResult.current = null; setSession(null); }
  }
  function openStory(style: StoryStyle) {
    if (current.current) setStory({ snapshot: current.current, style });
  }
  function openType(id: PersonalRecordType) { setType(id); setQuery(""); setTab("library"); }
  const openVideo = useCallback((id: string) => {
    void Linking.openURL(`https://www.douyin.com/video/${id}`).catch(() => setNotice("无法打开原作品，请稍后重试。"));
  }, []);

  async function savePage(page: CollectionPage) {
    const saved = await saveCollectionPage(current.current, page);
    current.current = saved; setSnapshot(saved);
    return saved.collections[page.recordType].records.length;
  }
  async function exportData() {
    if (!snapshot || exporting) return;
    setExporting(true);
    try {
      const saved = await exportMobileFile(`DouyinDataReview-records-${Date.now()}.json`, "application/json", mobileBackup(snapshot));
      setNotice(saved ? "已导出 JSON 到所选文件夹，可以导入桌面版查看。" : "已取消导出。");
    } catch { setNotice("导出失败，请选择可写入的文件夹后重试。本机数据仍保留。"); }
    finally { setExporting(false); }
  }

  const home = <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
    <View style={[ui.row, { paddingTop: 6 }]}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.accentSoft, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(240,162,78,0.4)" }}>
        <Text style={{ fontFamily: serif, color: C.accent, fontSize: 18 }}>{snapshot?.account.nickname.slice(0, 1) ?? "年"}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[ui.title, { fontSize: 16 }]}>{snapshot?.account.nickname ?? "内容年志"}</Text>
        <Text numberOfLines={1} style={ui.meta}>{snapshot ? `账号 ${snapshot.account.id}` : "本机采集 · 不上传"}</Text>
      </View>
      {snapshot ? <View style={[ui.row, { gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line }]}>
        <ShieldCheck size={13} color={C.sub} /><Text style={{ color: C.sub, fontSize: 11 }}>只采此账号</Text>
      </View> : null}
    </View>

    <View style={{ borderRadius: 26, overflow: "hidden", backgroundColor: C.surface, borderWidth: 1, borderColor: C.line }}>
      <Glow />
      <View style={{ padding: 22, gap: 18 }}>
        <View style={{ gap: 4 }}>
          <Text style={ui.eyebrow}>LOCAL ARCHIVE · 本机存档</Text>
          <Text style={[ui.number, { fontSize: 64, lineHeight: 74, fontWeight: "300", letterSpacing: -2 }]}>{total.toLocaleString("zh-CN")}</Text>
          <Text style={ui.body}>{snapshot ? "条记录留在这台手机上" : restoring ? "正在读取本机记录…" : "还没有记录，先做一次采集"}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {COLLECTION_TYPES.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`查看${item.label}`} onPress={() => openType(item.id)}
            android_ripple={{ color: "rgba(243,238,227,0.08)" }}
            style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, backgroundColor: "rgba(11,13,18,0.55)", borderWidth: 1, borderColor: C.line, gap: 8, overflow: "hidden" }}>
            <View style={{ width: 18, height: 3, borderRadius: 2, backgroundColor: STREAM[item.id] }} />
            <Text style={[ui.number, { fontSize: 22, lineHeight: 26 }]}>{(snapshot?.collections[item.id].records.length ?? 0).toLocaleString("zh-CN")}</Text>
            <Text style={ui.meta}>{item.label}</Text>
          </Pressable>)}
        </View>
        {snapshot ? <Text style={ui.meta}>最近保存 · {when(snapshot.savedAt)}</Text> : null}
      </View>
    </View>

    <View style={ui.card}>
      <View style={[ui.row, { justifyContent: "space-between" }]}>
        <Text style={ui.title}>{syncing ? "正在采集" : "更新记录"}</Text>
        <Text style={ui.meta}>观看 · 喜欢 · 收藏</Text>
      </View>
      {syncing || restoring ? <Working /> : null}
      <Text accessibilityLiveRegion="polite" style={[ui.body, { fontSize: 13, lineHeight: 20, color: syncing ? C.text : C.sub }]}>{notice}</Text>
      <Button label={stopping ? "正在停止…" : syncing ? "停止采集" : "一键增量采集"} icon={syncing ? Square : RefreshCw} kind={syncing ? "ghost" : "primary"}
        onPress={syncing ? stopSync : () => { void startSync("incremental"); }} disabled={restoring || storageFailed || stopping || !syncing && Boolean(session)} />
      <View style={ui.row}>
        <Button label="完整采集" kind="ghost" grow onPress={() => { void startSync("full"); }} disabled={restoring || storageFailed || syncing || Boolean(session)} />
        <Button label="登录 / 验证" kind="ghost" icon={LogIn} grow disabled={restoring || syncing || Boolean(session)}
          onPress={() => { void login(true).then(() => setNotice("登录会话已更新，可以直接增量采集。")).catch(() => setNotice("已返回，原有数据和登录缓存都保留。")); }} />
      </View>
      <Text style={ui.meta}>登录有效时不用打开网页；第一次或上次中断时，会先补齐没读完的部分。采集时请留在应用里。</Text>
    </View>

    {snapshot ? <Pressable accessibilityRole="button" onPress={() => openStory("trace")} style={({ pressed }) => [{ borderRadius: 24, overflow: "hidden", transform: [{ scale: pressed ? 0.985 : 1 }] }]}>
      <Svg style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} width="100%" height="100%">
        <Defs>
          <RadialGradient id="s" cx="0.78" cy="0.7" r="0.75"><Stop offset="0" stopColor="#eea44e" stopOpacity="0.55" /><Stop offset="1" stopColor="#152033" stopOpacity="1" /></RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#s)" />
      </Svg>
      <View style={{ padding: 22, gap: 6, flexDirection: "row", alignItems: "flex-end" }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={[ui.eyebrow, { color: "#eea44e" }]}>TRACE · ANNUAL</Text>
          <Text style={{ fontFamily: serif, color: "#f6f1e4", fontSize: 24, lineHeight: 32 }}>打开你的年度故事</Text>
          <Text style={{ color: "rgba(246,241,228,0.72)", fontSize: 13 }}>内容年志、档案馆、海报，三种看法</Text>
        </View>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(246,241,228,0.14)", alignItems: "center", justifyContent: "center" }}>
          <ChevronRight size={20} color="#f6f1e4" />
        </View>
      </View>
    </Pressable> : null}

    {snapshot ? <Pressable accessibilityRole="button" onPress={exportData} disabled={exporting} android_ripple={{ color: "rgba(243,238,227,0.06)" }}
      style={[ui.card, ui.row, { paddingVertical: 14, gap: 14, opacity: exporting ? 0.5 : 1, overflow: "hidden" }]}>
      <FileDown size={20} color={C.sub} />
      <View style={{ flex: 1 }}><Text style={[ui.title, { fontSize: 15 }]}>{exporting ? "正在导出…" : "导出内容 JSON"}</Text><Text style={ui.meta}>备份到文件夹，也能导入桌面版</Text></View>
      <ChevronRight size={18} color={C.faint} />
    </Pressable> : null}
  </ScrollView>;

  const libraryHeader = <View style={{ gap: 14, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 }}>
    <View style={{ gap: 6 }}>
      <Text style={ui.eyebrow}>LIBRARY · 只在本机</Text>
      <Text style={ui.heading}>内容</Text>
    </View>
    <Segmented items={COLLECTION_TYPES.map(item => ({ id: item.id, label: item.label, count: snapshot?.collections[item.id].records.length ?? 0, dot: STREAM[item.id] }))}
      value={type} onChange={value => { setType(value); setQuery(""); }} />
    <View style={[ui.row, { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, gap: 8 }]}>
      <Search size={17} color={C.faint} />
      <TextInput accessibilityLabel="搜索已采集内容" placeholder="搜索标题、作者或话题" value={query} onChangeText={setQuery}
        placeholderTextColor={C.faint} selectionColor={C.accent} style={{ flex: 1, paddingVertical: 12, color: C.text, fontSize: 15 }} />
      {query ? <Pressable accessibilityRole="button" accessibilityLabel="清空搜索" onPress={() => setQuery("")} hitSlop={10}><X size={17} color={C.sub} /></Pressable> : null}
    </View>
    <Text style={ui.meta}>{query ? `找到 ${rows.length} 条` : `${rows.length.toLocaleString("zh-CN")} 条，点一下打开原作品`}</Text>
  </View>;

  return <SafeAreaView edges={["top", "left", "right"]} style={ui.screen}>
    <StatusBar style="light" />
    <View style={{ flex: 1 }}>
      {tab === "home" ? home : null}
      {tab === "library" ? <FlatList data={rows} keyExtractor={item => `${item.id}:${item.watchedAt ?? "unknown"}`} contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled" ListHeaderComponent={libraryHeader} initialNumToRender={10} windowSize={9} maxToRenderPerBatch={10} removeClippedSubviews
        ListEmptyComponent={!restoring ? <Text style={ui.empty}>{query ? "没有找到匹配的内容，换个关键词试试。" : "这里还空着。\n采集之后会出现在这里。"}</Text> : null}
        renderItem={({ item }) => <Row item={item} type={type} onOpen={openVideo} />} /> : null}
      {/* stays mounted so a computed report survives tab switches; computes only while visible */}
      <View style={{ flex: 1, display: tab === "report" ? "flex" : "none" }}>
        <ReportScreen snapshot={snapshot} active={tab === "report"} onCollect={() => setTab("home")} onStory={openStory} />
      </View>
    </View>
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: C.bg, borderTopWidth: 1, borderColor: C.line, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 12 }}>
      {TABS.map(({ id, label, icon: Icon }) => {
        const on = tab === id;
        return <Pressable key={id} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={() => setTab(id)}
          style={{ flex: 1, alignItems: "center", gap: 3, paddingVertical: 6 }}>
          <View style={{ paddingHorizontal: 18, paddingVertical: 4, borderRadius: 999, backgroundColor: on ? C.accentSoft : "transparent" }}>
            <Icon size={21} color={on ? C.accent : C.faint} strokeWidth={on ? 2.2 : 1.8} />
          </View>
          <Text style={{ color: on ? C.text : C.faint, fontSize: 11, fontWeight: on ? "600" : "400" }}>{label}</Text>
        </Pressable>;
      })}
    </View>
    {story ? <StoryScreen snapshot={story.snapshot} style={story.style} onClose={() => setStory(null)} /> : null}
    {session ? <SessionBrowser accountId={snapshot?.account.id} interactive={session.interactive}
      onReady={() => { sessionResult.current?.resolve(); sessionResult.current = null; setSession(null); }}
      onCancel={() => { sessionResult.current?.reject(new Error("cancelled")); sessionResult.current = null; setSession(null); }} /> : null}
  </SafeAreaView>;
}
export default function AndroidApp() {
  return <SafeAreaProvider><MobileWorkspace /></SafeAreaProvider>;
}
