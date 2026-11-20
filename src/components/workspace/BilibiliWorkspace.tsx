import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CirclePlay, Video } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  BILIBILI_LIST_LABEL, bilibiliJobActive, cancelBilibiliJob, filterBilibiliItems, getBilibiliDetail,
  getBilibiliStatus, logoutBilibili, saveBilibiliItem, startBilibiliLogin, startBilibiliSync,
  type BilibiliFolder, type BilibiliItem, type BilibiliStatus,
} from "../../services/bilibili";
import { SaveContentControl } from "./SaveContentControl";
import { Empty, ErrorLine, kit, Loading, SmallButton, Tabs } from "./CreatorKit";
import { workspaceColors as color, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Props = { connection: ExploreConnection | null; accountId?: string; onOpenSettings: () => void; enabled?: boolean };
type Tab = "favorites" | "history";
type BilibiliDetailItem = BilibiliItem & { description?: string; pages?: Array<{ cid: number; part: string; durationSeconds: number | null }> };

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** 入口随当前采集器支持的平台而显示。 */
export function BilibiliWorkspace({ connection: given, accountId = "default", onOpenSettings, enabled = false }: Props) {
  const baseUrl = given?.baseUrl;
  const token = given?.token;
  const connection = useMemo(() => baseUrl && token ? { baseUrl, token } : null, [baseUrl, token]);
  const [status, setStatus] = useState<BilibiliStatus | null>(null);
  const [tab, setTab] = useState<Tab>("favorites");
  const [folderId, setFolderId] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<BilibiliItem | null>(null);
  const [detail, setDetail] = useState<BilibiliDetailItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [bvid, setBvid] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const viewGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);

  const reload = (expectedGeneration = viewGeneration.current) => {
    if (!connection) return Promise.resolve();
    const controller = new AbortController();
    return getBilibiliStatus(connection, accountId, controller.signal).then(value => {
      if (expectedGeneration === viewGeneration.current) { setStatus(value); setError(""); }
      return value;
    }, cause => {
      if (expectedGeneration === viewGeneration.current && !controller.signal.aborted) setError(message(cause, "读取 B 站状态失败。"));
      throw cause;
    }).finally(() => controller.abort());
  };
  useEffect(() => {
    const generation = ++viewGeneration.current;
    detailGeneration.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setStatus(null); setSelected(null); setDetail(null); setDetailLoading(false); setDetailError(""); setFolderId("all"); setError("");
    if (connection) void reload(generation).catch(() => undefined);
    return () => detailAbort.current?.abort();
  }, [connection, accountId]);
  useEffect(() => {
    if (!connection || !bilibiliJobActive(status?.job)) return undefined;
    const timer = setInterval(() => { void reload(viewGeneration.current).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [connection, accountId, status?.job?.id, status?.job?.state]);

  if (!enabled) return <View style={styles.root}><View style={styles.gate} {...ws("e-empty")}>
    <Video size={34} color={color.accent} /><Text style={styles.gateTitle}>当前采集器已关闭 B 站接入</Text>
  </View></View>;
  if (!connection) return <View style={styles.root}><View style={styles.gate} {...ws("e-empty")}>
    <Video size={34} color={color.accent} /><Text style={styles.gateTitle}>连接采集器后使用 B 站</Text>
    <Text style={kit.body}>登录和读取都通过本机独立浏览器会话完成。</Text><SmallButton label="前往连接" onPress={onOpenSettings} />
  </View></View>;

  const account = status?.account?.isLogin ? status.account : null;
  const folders = status?.snapshot?.folders ?? [];
  const folderNames = new Map(folders.map(folder => [folder.id, folder.title]));
  const tabItems = filterBilibiliItems(status?.snapshot?.items ?? [], query, tab);
  const items = tabItems.filter(item => tab !== "favorites" || folderId === "all" || item.folderIds.includes(folderId));
  const active = bilibiliJobActive(status?.job);
  const run = (operation: () => Promise<unknown>) => {
    const generation = viewGeneration.current;
    setBusy(true); setError("");
    void operation().then(() => reload(generation).then(() => undefined).catch(() => undefined), cause => {
      if (generation === viewGeneration.current) setError(message(cause, "B 站操作失败，请重试。"));
    }).finally(() => { if (generation === viewGeneration.current) setBusy(false); });
  };
  const clearDetail = () => {
    detailGeneration.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setSelected(null); setDetail(null); setDetailLoading(false); setDetailError("");
  };
  const openDetail = (item: BilibiliItem) => {
    const request = ++detailGeneration.current;
    const generation = viewGeneration.current;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setSelected(item); setDetail(null); setDetailLoading(true); setDetailError("");
    void getBilibiliDetail(connection, accountId, item.bvid, controller.signal).then(value => {
      if (request === detailGeneration.current && generation === viewGeneration.current) { setDetail(value); setDetailLoading(false); }
    }, cause => {
      if (request === detailGeneration.current && generation === viewGeneration.current && !controller.signal.aborted) { setDetailError(message(cause, "视频详情读取失败。")); setDetailLoading(false); }
    });
  };
  const save = () => {
    const value = bvid.trim();
    if (!value) return;
    run(() => saveBilibiliItem(connection, accountId, { bvid: value }));
    setBvid("");
  };

  return <ScrollView testID="bilibili-workspace" style={styles.root} contentContainerStyle={styles.content}>
    <View style={kit.between}>
      <View style={{ gap: 5 }}><Text accessibilityRole="header" style={styles.title}>B 站</Text><Text style={kit.muted}>收藏夹和观看历史按账号独立保存，可加入跨平台内容库和专题。</Text></View>
      <View style={kit.row}>{account ? <Text style={styles.account}>{account.uname}</Text> : null}<SmallButton label="刷新" disabled={busy || active} onPress={() => run(reload)} /></View>
    </View>
    <View style={styles.toolbar}>
      {account ? <><Text style={kit.muted}>已登录 · 上次读取 {when(status?.snapshot?.fetchedAt)}</Text><SmallButton label="同步收藏和历史" disabled={busy || active} onPress={() => run(() => startBilibiliSync(connection, accountId))} /><SmallButton label="退出登录" disabled={busy || active} onPress={() => run(() => logoutBilibili(connection, accountId))} /></>
        : <><Text style={kit.muted}>{status?.snapshot ? "已退出登录 · 本地收藏和历史仍可查看" : "还没有登录 B 站"}</Text><SmallButton label="打开登录窗口" disabled={busy || active} onPress={() => run(() => startBilibiliLogin(connection, accountId))} /></>}
      {active ? <SmallButton label="取消" onPress={() => run(() => cancelBilibiliJob(connection, accountId, status!.job!.id))} /> : null}
    </View>
    {status?.job ? <Text style={kit.muted} accessibilityLiveRegion="polite">{status.job.message}</Text> : null}
    {error ? <ErrorLine text={error} onRetry={() => void reload().catch(() => undefined)} /> : null}
    <View style={styles.saveBox}><Text style={kit.subhead}>手动保存视频</Text><TextInput value={bvid} onChangeText={setBvid} onSubmitEditing={save} placeholder="粘贴 BVID 或视频链接" placeholderTextColor={color.textMuted} style={styles.input} accessibilityLabel="BVID" /><SmallButton label="保存到内容库" disabled={!bvid.trim() || busy} onPress={save} /></View>
    <Tabs options={[{ label: "收藏夹", value: "favorites" }, { label: "观看历史", value: "history" }]} value={tab} onChange={value => { setTab(value); setFolderId("all"); clearDetail(); }} />
    {folders.length && tab === "favorites" ? <Tabs value={folderId} options={[{ value: "all", label: `全部收藏（${tabItems.length}）` }, ...folders.map((folder: BilibiliFolder) => ({ value: folder.id, label: `${folder.title}（${folder.mediaCount}）` }))]} onChange={value => { setFolderId(value); clearDetail(); }} /> : null}
    {!status?.snapshot && !account && !active ? <Empty lines={["登录后同步 B 站收藏夹和观看历史。", "登录窗口使用本应用独立浏览器配置，不读取其他浏览器账号。"]} /> : items.length ? <View style={{ gap: 4 }}>{items.map(item => <BiliRow key={item.key} item={item} folderNames={folderNames} selected={selected?.key === item.key} onPress={() => openDetail(item)} />)}</View> : <Empty lines={[`还没有${BILIBILI_LIST_LABEL[tab]}记录。`, "同步后会按 BVID 去重，重复同步不会增加重复项。"]} />}
    {selected ? <BiliDetail connection={connection} accountId={accountId} item={detail ?? selected} loading={detailLoading} error={detailError} onRetry={() => openDetail(selected)} onOpen={() => void Linking.openURL(selected.url).catch(() => undefined)} /> : null}
  </ScrollView>;
}

function BiliRow({ item, selected, onPress, folderNames }: { item: BilibiliItem; selected: boolean; onPress: () => void; folderNames: Map<string, string> }) {
  const folders = item.folderIds.map(id => folderNames.get(id)).filter((name): name is string => Boolean(name));
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看 B 站视频：${item.title}`} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: color.surfaceMuted }, Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null]}>
    {item.cover ? <Image source={{ uri: item.cover }} style={styles.cover} /> : <View style={[styles.cover, styles.coverFallback]}><CirclePlay size={20} color={color.textMuted} /></View>}
    <View style={{ flex: 1, gap: 4 }}><Text style={kit.body} numberOfLines={2}>{item.title}</Text><Text style={kit.muted} numberOfLines={1}>{[item.author, item.sources.includes("favorite") ? "收藏" : "", item.sources.includes("history") ? "看过" : "", ...folders].filter(Boolean).join(" · ")}</Text></View>
    {folders.length ? <Text style={styles.badge} numberOfLines={1}>{folders.join("、")}</Text> : null}
  </Pressable>;
}

function BiliDetail({ connection, accountId, item, loading, error, onRetry, onOpen }: { connection: ExploreConnection; accountId: string; item: BilibiliDetailItem; loading: boolean; error: string; onRetry: () => void; onOpen: () => void }) {
  return <View style={styles.detail}>
    <View style={kit.between}><Text style={kit.subhead}>视频详情</Text><SmallButton label="打开 B 站" onPress={onOpen} /></View>
    <Text style={kit.body}>{item.title}</Text>
    <Text style={kit.muted}>{[item.bvid, item.author, item.publishedAt ? `发布于 ${when(item.publishedAt)}` : ""].filter(Boolean).join(" · ")}</Text>
    {loading ? <Loading label="正在读取视频详情" /> : error ? <ErrorLine text={error} onRetry={onRetry} /> : item.description ? <Text style={kit.body} selectable>{item.description}</Text> : <Text style={kit.muted}>这个视频没有可显示的简介。</Text>}
    {item.pages?.length ? <Text style={kit.muted}>分 P：{item.pages.map(page => page.part || `P${page.cid}`).join(" · ")}</Text> : null}
    <SaveContentControl connection={connection} item={{ platform: "bilibili", accountId, contentId: item.bvid, title: item.title, body: item.description ?? null, author: item.author, url: item.url, coverUrl: item.cover, mediaType: "video" }} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { maxWidth: 1100, width: "100%", alignSelf: "center", padding: 28, gap: 18 },
  gate: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  gateTitle: { color: color.text, fontSize: 18, fontWeight: "700" },
  title: { color: color.text, fontSize: 28, fontWeight: "800" },
  account: { color: color.text, fontWeight: "700" },
  toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  saveBox: { gap: 8, padding: 14, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  input: { minHeight: 38, paddingHorizontal: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, color: color.text, backgroundColor: color.canvas },
  row: { minHeight: 74, flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.small },
  cover: { width: 110, height: 62, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  coverFallback: { alignItems: "center", justifyContent: "center" },
  badge: { color: color.accent, fontSize: 12 },
  detail: { gap: 9, padding: 16, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
});

