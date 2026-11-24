import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CirclePlay, Video } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  BILIBILI_LIST_LABEL, bilibiliJobActive, cancelBilibiliJob, filterBilibiliItems,
  getBilibiliStatus, logoutBilibili, saveBilibiliItem, startBilibiliLogin, startBilibiliSync,
  type BilibiliFolder, type BilibiliItem, type BilibiliStatus,
} from "../../services/bilibili";
import { BilibiliLivePlayer, BilibiliOnlineRecords } from "./BilibiliDiscovery";
import { BilibiliVideoDetail } from "./BilibiliVideoDetail";
import { Empty, ErrorLine, kit, Panel, SmallButton, Tabs } from "./CreatorKit";
import { workspaceColors as color, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Props = { connection: ExploreConnection | null; accountId?: string; onOpenSettings: () => void; enabled?: boolean;
  onAccountChanged?: () => void; onOpenAuthor?: (mid: string) => void };
type Tab = "favorites" | "history" | "likes" | "live";
const tabs: Array<{ label: string; value: Tab }> = [
  { label: "观看历史", value: "history" }, { label: "直播", value: "live" }, { label: "喜欢", value: "likes" }, { label: "收藏夹", value: "favorites" },
];

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** 入口随当前采集器支持的平台而显示。 */
export function BilibiliWorkspace({ connection: given, accountId = "default", onOpenSettings, enabled = false, onAccountChanged, onOpenAuthor }: Props) {
  const baseUrl = given?.baseUrl;
  const token = given?.token;
  const connection = useMemo(() => baseUrl && token ? { baseUrl, token } : null, [baseUrl, token]);
  const [status, setStatus] = useState<BilibiliStatus | null>(null);
  const [tab, setTab] = useState<Tab>("favorites");
  const [historyView, setHistoryView] = useState<"local" | "online">("local");
  const [liveView, setLiveView] = useState<"following" | "liveHistory">("following");
  const [folderId, setFolderId] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [bvid, setBvid] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const viewGeneration = useRef(0);
  const previousLogin = useRef<boolean | undefined>(undefined);

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
    previousLogin.current = undefined;
    setStatus(null); setSelected(null); setRoom(null); setFolderId("all"); setError("");
    if (connection) void reload(generation).catch(() => undefined);
    return () => { viewGeneration.current += 1; };
  }, [connection, accountId]);
  useEffect(() => {
    if (!connection || !bilibiliJobActive(status?.job)) return undefined;
    const timer = setInterval(() => { void reload(viewGeneration.current).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [connection, accountId, status?.job?.id, status?.job?.state]);
  useEffect(() => {
    if (!status) return;
    const loggedIn = status.account?.isLogin === true;
    if (previousLogin.current !== undefined && previousLogin.current !== loggedIn) onAccountChanged?.();
    previousLogin.current = loggedIn;
  }, [status]);

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
  const tabItems = filterBilibiliItems(status?.snapshot?.items ?? [], "", tab === "favorites" ? "favorites" : "history");
  const items = tabItems.filter(item => tab !== "favorites" || folderId === "all" || item.folderIds.includes(folderId));
  const active = bilibiliJobActive(status?.job);
  const run = (operation: () => Promise<unknown>) => {
    const generation = viewGeneration.current;
    setBusy(true); setError("");
    void operation().then(() => reload(generation).then(() => undefined).catch(() => undefined), cause => {
      if (generation === viewGeneration.current) setError(message(cause, "B 站操作失败，请重试。"));
    }).finally(() => { if (generation === viewGeneration.current) setBusy(false); });
  };
  const save = () => {
    const value = bvid.trim();
    if (!value) return;
    run(async () => {
      await saveBilibiliItem(connection, accountId, { bvid: value, url: value });
      setBvid(current => current.trim() === value ? "" : current);
    });
  };

  const session = { connection, accountId };
  if (selected) return <BilibiliVideoDetail key={selected} {...session} bvid={selected} onBack={() => setSelected(null)} onOpenAuthor={onOpenAuthor} />;
  if (room) return <View style={styles.root}>
    <View style={styles.back}><SmallButton label="返回记录" onPress={() => setRoom(null)} /></View>
    <BilibiliLivePlayer session={session} roomId={room} />
  </View>;

  const online = tab === "likes" ? "likes" : tab === "live" ? liveView : tab === "history" && historyView === "online" ? "history" : null;

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
    <Tabs options={tabs} value={tab} onChange={setTab} />
    {tab === "history" ? <Tabs value={historyView} options={[{ value: "local", label: "本地记录" }, { value: "online", label: "在线历史" }]} onChange={setHistoryView} /> : null}
    {tab === "live" ? <Tabs value={liveView} options={[{ value: "following", label: "关注开播" }, { value: "liveHistory", label: "直播历史" }]} onChange={setLiveView} /> : null}
    {folders.length && tab === "favorites" ? <Tabs value={folderId} options={[{ value: "all", label: `全部收藏（${tabItems.length}）` }, ...folders.map((folder: BilibiliFolder) => ({ value: folder.id, label: `${folder.title}（${folder.mediaCount}）` }))]} onChange={setFolderId} /> : null}
    {online ? <Panel title={tab === "likes" ? "近期喜欢" : undefined}>
      {account ? <BilibiliOnlineRecords key={online} session={session} kind={online} onVideo={setSelected} onRoom={setRoom} /> : <Empty text="登录 B 站后可读取在线记录。" />}
    </Panel> : items.length ? <View style={{ gap: 4 }}>{items.map(item => <BiliRow key={item.key} item={item} folderNames={folderNames} onPress={() => setSelected(item.bvid)} />)}</View>
      : <Empty text={`还没有${BILIBILI_LIST_LABEL[tab === "favorites" ? "favorites" : "history"]}记录${account ? "，可以先同步。" : "，登录后可同步。"}`} />}
  </ScrollView>;
}

function BiliRow({ item, onPress, folderNames }: { item: BilibiliItem; onPress: () => void; folderNames: Map<string, string> }) {
  const folders = item.folderIds.map(id => folderNames.get(id)).filter((name): name is string => Boolean(name));
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看 B 站视频：${item.title}`} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.surfaceMuted }, Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null]}>
    {item.cover ? <Image source={{ uri: item.cover }} style={styles.cover} /> : <View style={[styles.cover, styles.coverFallback]}><CirclePlay size={20} color={color.textMuted} /></View>}
    <View style={{ flex: 1, gap: 4 }}><Text style={kit.body} numberOfLines={2}>{item.title}</Text><Text style={kit.muted} numberOfLines={1}>{[item.author, item.sources.includes("favorite") ? "收藏" : "", item.sources.includes("history") ? "看过" : "", ...folders].filter(Boolean).join(" · ")}</Text></View>
    {folders.length ? <Text style={styles.badge} numberOfLines={1}>{folders.join("、")}</Text> : null}
  </Pressable>;
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
  back: { alignItems: "flex-start", paddingHorizontal: 20, paddingTop: 12 },
});

