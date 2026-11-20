import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BookHeart } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  cancelXhs, getXhsLatest, getXhsStatus, logoutXhs, parseCount, readXhs, startXhsExport, startXhsLogin, summarizeXhs, xhsJobActive, XHS_LIST_LABEL,
  type XhsAccount, type XhsCard, type XhsComment, type XhsDetail, type XhsExport, type XhsJob, type XhsListKey, type XhsProfile,
} from "../../services/xiaohongshu";
import { BarList } from "./CreatorCharts";
import { Empty, ErrorLine, kit, Loading, MetricTile, Panel, Segmented, SmallButton, Tabs } from "./CreatorKit";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";
import { SaveContentControl } from "./SaveContentControl";
import type { XhsConnection } from "../../services/xiaohongshu";

type Props = { connection: ExploreConnection | null; accountId?: string; onOpenSettings: () => void; panes?: readonly Pane[] };
type Choice = XhsListKey | "both";
type Row = XhsCard & { body?: string | null; in?: XhsListKey[] };
type Pane = "board" | "feed" | "search" | "profile";

const CHOICES: Array<{ label: string; value: Choice }> = [{ label: "收藏", value: "favorites" }, { label: "点赞", value: "likes" }, { label: "两类一起", value: "both" }];
const PAGE = 50;
const PANES: Array<{ label: string; value: Pane }> = [{ label: "看板", value: "board" }, { label: "推荐", value: "feed" }, { label: "搜索", value: "search" }, { label: "主页", value: "profile" }];
const ALL_PANES: readonly Pane[] = PANES.map(pane => pane.value);
const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

// 工作台把这一页拆开挂在几个功能下面：内容库只要看板（登录和导出），刷视频要推荐，探索要搜索；主页是点作者进去的，跟着推荐和搜索走
export function XiaohongshuWorkspace({ connection: given, accountId, onOpenSettings, panes = ALL_PANES }: Props) {
  // 外壳每次重渲染都会新建连接对象：按地址和令牌认，不然轮询会被反复重启
  const baseUrl = given?.baseUrl, token = given?.token;
  const connection = useMemo(() => (baseUrl && token ? { baseUrl, token, accountId } : null), [baseUrl, token, accountId]);
  const [job, setJob] = useState<XhsJob | null>(null);
  const [account, setAccount] = useState<XhsAccount | null>(null);
  const [latest, setLatest] = useState<XhsExport | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Choice>("both");
  const [revision, refresh] = useState(0);
  const [view, setView] = useState<Pane>(panes[0]!);
  const [seen, setSeen] = useState<ReadonlySet<Pane>>(() => new Set([panes[0]!]));
  const board = panes.includes("board");
  const [profileUrl, setProfileUrl] = useState<string | undefined>(undefined);
  const active = xhsJobActive(job);
  const show = (next: Pane) => { setView(next); setSeen(prev => new Set(prev).add(next)); };

  useEffect(() => {
    if (!connection) return undefined;
    const controller = new AbortController();
    setError("");
    Promise.all([getXhsStatus(connection, controller.signal), getXhsLatest(connection, controller.signal)]).then(([status, data]) => {
      setJob(status.job); setAccount(status.account); setLatest(data);
    }, cause => { if (!controller.signal.aborted) setError(message(cause, "读取小红书导出状态失败。")); });
    return () => controller.abort();
  }, [connection, revision]);

  // 登录或导出进行中：每秒拉一次进度（二维码也从这里来）；结束了刷新账号和看板
  useEffect(() => {
    if (!connection || !active) return undefined;
    let stopped = false;
    const timer = setInterval(() => {
      getXhsStatus(connection).then(status => {
        if (stopped) return;
        setJob(status.job); setAccount(status.account);
        if (!xhsJobActive(status.job) && status.job?.state === "done" && status.job.lists.length) void getXhsLatest(connection).then(setLatest, () => undefined);
      }, () => undefined);
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, active]);

  if (!connection) return <View style={styles.root}><View style={[styles.content, styles.gate]} {...ws("e-empty")}>
    <BookHeart size={34} color={color.accent} /><Text style={styles.gateTitle}>连接采集器后导出小红书</Text>
    <Text style={kit.body}>小红书的登录和读取都由本机采集器完成。</Text><SmallButton label="前往连接" onPress={onOpenSettings} />
  </View></View>;

  const act = (run: () => Promise<{ job: XhsJob } | unknown>) => {
    setError("");
    void run().then(reply => { if (reply && typeof reply === "object" && "job" in reply) setJob((reply as { job: XhsJob }).job); else refresh(v => v + 1); },
      cause => setError(message(cause, "操作失败，请重试。")));
  };
  const lists: XhsListKey[] = choice === "both" ? ["favorites", "likes"] : [choice];
  const who = job?.account ?? account;

  return <ScrollView testID="xiaohongshu-workspace" style={styles.root} contentContainerStyle={styles.content}>
    {board ? <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={styles.title}>小红书</Text>
      <Text style={kit.muted}>扫码登录后导出自己收藏和点赞的笔记，也能在这里看推荐、搜笔记、翻主页和评论。数据都只存在这台电脑上。</Text>
    </View> : null}

    {/* 推荐、搜索页登录好了就不占这一大块；没登录时照样在这里扫码 */}
    {board || !who || active ? <View {...ws("e-box")} style={styles.panel}>
      <View style={styles.loginSide}>
        {job?.state === "login" && job.qr ? <View style={styles.qrBox} testID="xhs-login-qr">
          <Image source={{ uri: job.qr }} style={styles.qr} accessibilityLabel="小红书登录二维码" />
          <Text style={kit.body}>打开小红书 App，扫一扫登录</Text>
          <SmallButton label="取消" onPress={() => act(() => cancelXhs(connection))} />
        </View> : job?.state === "starting" ? <View style={{ alignItems: "center", gap: 8 }}><Loading label={job.message} /><SmallButton label="取消" onPress={() => act(() => cancelXhs(connection))} /></View>
          : who ? <View style={{ gap: 8 }}>
            <Text style={kit.muted}>小红书账号</Text>
            <Text style={styles.nickname} numberOfLines={1}>{who.nickname}</Text>
            {!active ? <View style={kit.row}>
              <SmallButton label="重新扫码登录" onPress={() => act(() => startXhsLogin(connection))} />
              <SmallButton label="退出登录" onPress={() => act(() => logoutXhs(connection))} />
            </View> : null}
          </View> : <View style={{ gap: 10 }}>
            <Text style={kit.subhead}>还没登录小红书</Text>
            <Text style={kit.muted}>在这里扫码，不用另开浏览器。</Text>
            <SmallButton label="扫码登录" disabled={active} onPress={() => act(() => startXhsLogin(connection))} />
          </View>}
      </View>
      {board ? <View style={styles.exportSide}>
        <Text style={kit.subhead}>导出哪些</Text>
        <Segmented options={CHOICES} value={choice} onChange={setChoice} />
        <View style={kit.row}>
          <SmallButton label={active && job?.lists.length ? "导出中…" : "开始导出"} disabled={active} onPress={() => act(() => startXhsExport(connection, lists))} />
          {job?.state === "reading" ? <SmallButton label="取消" onPress={() => act(() => cancelXhs(connection))} /> : null}
        </View>
        {job?.state === "reading" ? <View style={{ gap: 6 }} accessibilityLiveRegion="polite">
          <Text style={kit.body}>{job?.message}{job?.progress ? ` ${job.progress.done} / ${job.progress.total}` : ""}</Text>
          {job?.progress ? <View style={styles.track}><View style={[styles.fill, { width: `${job.progress.total ? (job.progress.done / job.progress.total) * 100 : 0}%` }]} /></View> : null}
        </View> : null}
        {!active && !account && !job ? <Text style={kit.muted}>没登录时点导出，会先在左边出二维码。</Text> : null}
        {job?.state === "done" && job.file ? <Text style={kit.muted} selectable>{job.message}。文件：{job.file}</Text> : null}
        {job?.state === "failed" ? <ErrorLine text={job.message} onRetry={() => act(() => (job.lists.length ? startXhsExport(connection, job.lists) : startXhsLogin(connection)))} /> : null}
        {error ? <ErrorLine text={error} onRetry={() => refresh(v => v + 1)} /> : null}
      </View> : null}
    </View> : null}

    {panes.length > 1 ? <Tabs options={PANES.filter(pane => panes.includes(pane.value))} value={view} onChange={show} /> : null}
    {/* 切走的页签只藏起来，回来时列表还在；推荐和主页第一次打开才去读 */}
    {board ? <View style={view === "board" ? null : styles.hidden}>
      {latest === undefined ? (error ? null : <Loading label="正在读取导出数据" />)
        : latest ? <Dashboard data={latest} />
        : <Empty lines={["还没有导出过。", "扫码登录后选收藏、点赞或两类一起，导出完这里会出看板。"]} />}
    </View> : null}
    {(["feed", "search", "profile"] as const).map(key => seen.has(key) && panes.includes(key) ? <View key={key} style={view === key ? null : styles.hidden}>
      {!who ? <Empty lines={["先在上面扫码登录小红书。", "推荐、搜索和主页都用登录的账号去读。"]} />
        : <Browse kind={key} connection={connection} blocked={active} profileUrl={key === "profile" ? profileUrl : undefined}
          onOpenAuthor={url => { setProfileUrl(url); show("profile"); }} />}
    </View> : null)}
  </ScrollView>;
}

function Dashboard({ data }: { data: XhsExport }) {
  const summary = useMemo(() => summarizeXhs(data), [data]);
  const [tab, setTab] = useState<"all" | XhsListKey>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const exported = (["favorites", "likes"] as const).filter(key => data.lists[key]);
  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    return summary.notes.filter(note => (tab === "all" || note.in.includes(tab))
      && (!text || [note.title, note.author, note.body].some(field => field?.toLowerCase().includes(text))));
  }, [summary, tab, query]);
  const top = (items: Array<{ name: string; count: number }>) => items.map(item => ({ label: item.name, ratio: item.count, value: `${item.count} 篇` }));

  return <View style={{ gap: 18 }} testID="xhs-dashboard">
    <View style={kit.between}>
      <Text style={styles.section}>看板</Text>
      <Text style={kit.muted}>{data.account.nickname} · {exported.map(key => `${XHS_LIST_LABEL[key]} ${when(data.lists[key]?.exported_at)} 导出`).join(" · ")}</Text>
    </View>
    <View style={kit.grid}>
      <MetricTile label="收藏" value={data.lists.favorites ? String(summary.counts.favorites) : "—"} unit="篇" note={data.lists.favorites ? null : "还没导出"} />
      <MetricTile label="点赞" value={data.lists.likes ? String(summary.counts.likes) : "—"} unit="篇" note={data.lists.likes ? null : "还没导出"} />
      <MetricTile label="又赞又藏" value={String(summary.both)} unit="篇" note={exported.length < 2 ? "两类都导出后才准" : null} />
      <MetricTile label="视频笔记" value={summary.notes.length ? `${Math.round((summary.video / summary.notes.length) * 100)}` : "0"} unit="%" note={`${summary.video} / ${summary.notes.length} 篇`} />
    </View>
    <View style={kit.columns}>
      <View style={kit.column}><Panel title="常看的作者" tip="收藏和点赞合在一起，按笔记篇数排">
        {summary.authors.length ? <BarList rows={top(summary.authors)} /> : <Empty small text="没有作者信息" />}
      </Panel></View>
      <View style={kit.column}><Panel title="常见话题" tip="从笔记正文里的 #话题 统计">
        {summary.tags.length ? <BarList rows={top(summary.tags)} /> : <Empty small text="正文里没有读到话题" />}
      </Panel></View>
    </View>
    {summary.hottest.length ? <Panel title="最热的几篇" tip="按笔记当前的点赞数">
      {summary.hottest.map(note => <NoteRow key={note.note_id} note={note} />)}
    </Panel> : null}
    <Panel title={`笔记（${rows.length}）`} extra={<Tabs options={[{ label: "全部", value: "all" }, ...exported.map(key => ({ label: XHS_LIST_LABEL[key], value: key }))]} value={tab} onChange={value => { setTab(value); setShown(PAGE); }} />}>
      <TextInput accessibilityLabel="搜索笔记" placeholder="搜标题、作者或正文" placeholderTextColor={color.textMuted} style={styles.input}
        value={query} onChangeText={text => { setQuery(text); setShown(PAGE); }} />
      {rows.length ? rows.slice(0, shown).map(note => <NoteRow key={note.note_id} note={note} />) : <Empty small text="没有对得上的笔记" />}
      {rows.length > shown ? <SmallButton label={`再显示 ${Math.min(PAGE, rows.length - shown)} 篇`} onPress={() => setShown(v => v + PAGE)} /> : null}
    </Panel>
  </View>;
}

/** 没给 onPress 就在浏览器里打开笔记 */
function NoteRow({ note, onPress, selected }: { note: Row; onPress?: () => void; selected?: boolean }) {
  const [broken, setBroken] = useState(false);
  const likes = parseCount(note.liked_count ?? undefined);
  return <Pressable accessibilityRole={onPress ? "button" : "link"} accessibilityState={{ selected }} accessibilityLabel={`${onPress ? "查看" : "在小红书打开"}：${note.title || "无标题笔记"}`}
    onPress={onPress ?? (() => void Linking.openURL(note.url).catch(() => undefined))}
    style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: color.surfaceMuted }, Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null]}>
    <View style={styles.cover}>
      {/* 小红书图床认来源页，网页上不带 Referer 才取得到 */}
      {Platform.OS === "web" && note.cover && !broken
        ? <img src={note.cover} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : <Text style={styles.coverText}>{note.type === "video" ? "视频" : note.type ? "图文" : ""}</Text>}
    </View>
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={kit.body} numberOfLines={1}>{note.title || note.body?.slice(0, 40) || "无标题笔记"}</Text>
      <Text style={kit.muted} numberOfLines={1}>{[note.author, note.type === "video" ? "视频" : note.type ? "图文" : "", likes ? `♥ ${note.liked_count}` : ""].filter(Boolean).join(" · ")}</Text>
    </View>
    {note.in?.map(key => <Text key={key} style={styles.badge}>{XHS_LIST_LABEL[key]}</Text>)}
  </Pressable>;
}

/** 一次读取的状态：新的一次开始会打断上一次（采集器那边会关掉上一次的浏览器） */
function useRead<T>() {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: false });
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const run = useCallback((load: (signal: AbortSignal) => Promise<T>) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState(prev => ({ data: prev.data, loading: true }));
    load(controller.signal).then(data => { if (!controller.signal.aborted) setState({ data, loading: false }); },
      cause => { if (!controller.signal.aborted) setState(prev => ({ data: prev.data, error: message(cause, "读取失败，请重试。"), loading: false })); });
  }, []);
  return [state, run] as const;
}

const SLOW = "每次读取都要在后台打开一次小红书，要等几秒。";

/** 推荐、搜索、主页三个页签：上面是列表，点一篇在上方展开详情和评论 */
function Browse({ kind, connection, blocked, profileUrl, onOpenAuthor }: {
  kind: "feed" | "search" | "profile"; connection: ExploreConnection; blocked: boolean; profileUrl?: string; onOpenAuthor: (url: string) => void;
}) {
  const [list, runList] = useRead<{ notes: XhsCard[]; has_more?: boolean; profile?: XhsProfile }>();
  const [keyword, setKeyword] = useState("");
  const [opened, setOpened] = useState<XhsCard | null>(null);
  const load = useCallback((url?: string) => {
    setOpened(null);
    if (kind === "feed") runList(signal => readXhs(connection, "feed", {}, signal));
    else if (kind === "profile") runList(signal => readXhs(connection, "profile", url ? { url } : {}, signal).then(profile => ({ notes: profile.notes, has_more: profile.has_more, profile })));
  }, [kind, connection, runList]);
  // 推荐和主页一打开就读；从详情点作者会带着作者主页链接过来
  useEffect(() => { if (!blocked) load(profileUrl); }, [load, profileUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = () => {
    const text = keyword.trim();
    if (!text) return;
    setOpened(null);
    runList(signal => readXhs(connection, "search", { keyword: text }, signal));
  };
  const profile = list.data?.profile;

  return <View style={{ gap: 16 }} testID={`xhs-${kind}`}>
    {kind === "search" ? <View style={kit.row}>
      <TextInput accessibilityLabel="搜索小红书笔记" placeholder="搜小红书笔记" placeholderTextColor={color.textMuted} style={[styles.input, { flex: 1, minWidth: 220 }]}
        value={keyword} onChangeText={setKeyword} onSubmitEditing={search} maxLength={100} />
      <SmallButton label={list.loading ? "搜索中…" : "搜索"} disabled={!keyword.trim() || list.loading || blocked} onPress={search} />
    </View> : <View style={kit.between}>
      <Text style={kit.muted}>{kind === "feed" ? "登录账号首页现在的推荐，按页面顺序。" : profile ? `${profile.nickname} 的主页` : "主页"}</Text>
      <View style={kit.row}>
        {kind === "profile" && profileUrl ? <SmallButton label="回到我的主页" disabled={list.loading || blocked} onPress={() => onOpenAuthor("")} /> : null}
        <SmallButton label={list.loading ? "读取中…" : "刷新"} disabled={list.loading || blocked} onPress={() => load(profileUrl)} />
      </View>
    </View>}
    {blocked ? <Text style={kit.muted}>正在登录或导出，结束后才能读取。</Text> : null}
    {list.error ? <ErrorLine text={list.error} onRetry={kind === "search" ? search : () => load(profileUrl)} /> : null}
    {profile ? <Panel>
      <Text style={styles.nickname}>{profile.nickname}</Text>
      {profile.description ? <Text style={kit.body} selectable>{profile.description}</Text> : null}
      <View style={kit.row}>{profile.stats.map(stat => <Text key={stat.label} style={kit.muted}>{stat.label} <Text style={kit.strong}>{stat.value ?? "—"}</Text></Text>)}</View>
    </Panel> : null}
    {list.loading && !list.data ? <Loading label={`正在读取。${SLOW}`} />
      : list.data ? <Panel title={kind === "profile" ? "发布的笔记" : kind === "search" ? "搜索结果" : "推荐"} subtitle={`${list.data.notes.length} 篇${list.data.has_more ? "（只读了第一批）" : ""}`}>
        {/* 点开的那篇就地展开在它下面 */}
        {list.data.notes.length ? list.data.notes.map(card => <React.Fragment key={card.note_id}>
          <NoteRow note={card} selected={opened?.note_id === card.note_id} onPress={() => setOpened(opened?.note_id === card.note_id ? null : card)} />
          {opened?.note_id === card.note_id ? <NoteDetail card={card} connection={connection} blocked={blocked} onClose={() => setOpened(null)} onOpenAuthor={onOpenAuthor} /> : null}
        </React.Fragment>)
          : <Empty small text={kind === "search" ? "没有搜到笔记" : "没有读到笔记"} />}
      </Panel>
      : kind === "search" && !list.error ? <Empty small text={`输入关键词搜笔记。${SLOW}`} /> : null}
  </View>;
}

function NoteDetail({ card, connection, blocked, onClose, onOpenAuthor }: {
  card: XhsCard; connection: XhsConnection; blocked: boolean; onClose: () => void; onOpenAuthor: (url: string) => void;
}) {
  const [detail, runDetail] = useRead<XhsDetail>();
  const [comments, runComments] = useRead<{ comments: XhsComment[]; has_more?: boolean }>();
  useEffect(() => { if (!blocked) runDetail(signal => readXhs(connection, "detail", { url: card.url }, signal)); }, [card.url]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = detail.data;
  const authorUrl = data?.author_url ?? card.author_url;
  const counts = data ? [["赞", data.liked_count], ["收藏", data.collected_count], ["评论", data.comment_count]].filter(([, value]) => value).map(([label, value]) => `${label} ${value}`).join(" · ") : "";
  return <Panel title={data?.title || card.title || "笔记"} extra={<View style={kit.row}>
    <SmallButton label="在小红书打开" onPress={() => void Linking.openURL(card.url).catch(() => undefined)} />
    <SmallButton label="收起" onPress={onClose} />
  </View>}>
    <View style={kit.row}>
      {authorUrl ? <Text style={styles.link} onPress={() => onOpenAuthor(authorUrl)}>{data?.author ?? card.author ?? "作者"} 的主页</Text>
        : <Text style={kit.muted}>{data?.author ?? card.author ?? ""}</Text>}
      {counts ? <Text style={kit.muted}>{counts}</Text> : null}
    </View>
    {detail.loading ? <Loading label="正在读取正文" /> : detail.error ? <ErrorLine text={detail.error} onRetry={() => runDetail(signal => readXhs(connection, "detail", { url: card.url }, signal))} />
      : data ? <Text style={kit.body} selectable>{data.body || "（没有正文）"}</Text> : null}
    {connection.accountId && <SaveContentControl key={card.note_id} connection={connection} item={{ platform: "xiaohongshu", accountId: connection.accountId,
      contentId: card.note_id, title: data?.title || card.title || "小红书笔记", body: data?.body, author: data?.author ?? card.author ?? null,
      url: card.url, coverUrl: card.cover, mediaType: card.type }} />}
    {comments.data ? <View style={{ gap: 10 }}>
      <Text style={kit.subhead}>评论{comments.data.has_more ? "（第一批）" : ""}</Text>
      {comments.data.comments.length ? comments.data.comments.map(item => <View key={item.comment_id} style={styles.comment}>
        <Text style={kit.muted}>{[item.author, item.liked_count ? `♥ ${item.liked_count}` : "", Number(item.reply_count) ? `${item.reply_count} 条回复` : ""].filter(Boolean).join(" · ")}</Text>
        <Text style={kit.body} selectable>{item.content}</Text>
      </View>) : <Empty small text="还没有评论" />}
    </View> : comments.error ? <ErrorLine text={comments.error} onRetry={() => runComments(signal => readXhs(connection, "comments", { url: card.url }, signal))} />
      : <SmallButton label={comments.loading ? "正在读取评论…" : "看评论"} disabled={comments.loading || detail.loading || blocked}
        onPress={() => runComments(signal => readXhs(connection, "comments", { url: card.url }, signal))} />}
  </Panel>;
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
  link: { color: color.accent, fontFamily: font.body, fontSize: 12 },
  comment: { gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderColor: color.borderSoft },
  root: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 32, gap: 20, paddingBottom: 70, maxWidth: 1080, width: "100%", alignSelf: "center" },
  gate: { alignItems: "center", gap: 14, paddingVertical: 60 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  title: { color: color.text, fontFamily: font.body, fontSize: 24, fontWeight: "600" },
  section: { color: color.text, fontFamily: font.body, fontSize: 18, fontWeight: "600" },
  panel: { flexDirection: "row", flexWrap: "wrap", gap: 28, padding: 20, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  loginSide: { width: 220, minHeight: 120, justifyContent: "center" },
  exportSide: { flex: 1, minWidth: 280, gap: 12 },
  qrBox: { alignItems: "center", gap: 10 },
  qr: { width: 176, height: 176, borderRadius: radius.small, backgroundColor: "#fff" },
  nickname: { color: color.text, fontFamily: font.body, fontSize: 18, fontWeight: "600" },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: color.surfaceMuted, overflow: "hidden" },
  fill: { height: 6, backgroundColor: color.accent },
  input: { paddingHorizontal: 12, paddingVertical: 9, backgroundColor: color.surfaceRaised, color: color.text, fontFamily: font.body,
    fontSize: 14, borderWidth: 1, borderRadius: radius.small, borderColor: color.borderSoft },
  row: { minHeight: 64, paddingVertical: 8, paddingHorizontal: 4, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderColor: color.borderSoft },
  cover: { width: 44, height: 56, borderRadius: radius.small, overflow: "hidden", backgroundColor: color.surfaceMuted, alignItems: "center", justifyContent: "center" },
  coverText: { color: color.textMuted, fontFamily: font.body, fontSize: 10 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: "hidden",
    color: color.textSecondary, backgroundColor: alpha(color.accent, 0.12), fontFamily: font.body, fontSize: 11 },
});
