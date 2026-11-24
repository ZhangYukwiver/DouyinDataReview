import React, { useEffect, useRef, useState } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ExploreConnection } from "../../services/explorer";
import { callBilibiliProtocol, type BilibiliProtocolInputs } from "../../services/bilibili";
import { playLiveStream } from "../../services/livePlayback";
import { BilibiliVideoDetail } from "./BilibiliVideoDetail";
import { contentStyles, SearchField } from "./ContentWorkspaceControls";
import { Empty, ErrorLine, kit, Loading, Panel, SmallButton, Tabs } from "./CreatorKit";
import { workspaceColors as color, workspaceRadii as radius } from "./workspaceTheme";

type Session = { connection: ExploreConnection; accountId: string };
type Protocol = keyof BilibiliProtocolInputs;
type BiliRecord = Record<string, unknown>;
type Video = { bvid: string; title: string; author?: string; cover?: string };
type Selection = { kind: "video" | "author" | "live"; id: string };

const object = (value: unknown): BiliRecord => typeof value === "object" && value !== null && !Array.isArray(value) ? value as BiliRecord : {};
const rows = (value: unknown): BiliRecord[] => Array.isArray(value) ? value.map(object) : [];
const stringId = (value: unknown): string => {
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^[1-9]\d*$/u.test(id) ? id : "";
};
const plain = (value: unknown) => typeof value === "string"
  ? value.replace(/<\/?em\b[^>]*>/giu, "").replace(/&(?:amp|quot);/gu, entity => entity === "&amp;" ? "&" : '"').trim()
  : "";
const coverUrl = (value: unknown) => {
  const raw = plain(value);
  if (/^\/\//u.test(raw)) return `https:${raw}`;
  return /^https:\/\//u.test(raw) ? raw : undefined;
};

export function bilibiliVideos(value: unknown): Video[] {
  const result: Video[] = [];
  const seen = new Set<string>();
  for (const item of rows(value)) {
    const bvid = plain(item.bvid ?? item.bv_id);
    if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid) || seen.has(bvid) || item.goto === "ad" || item.isAd === true || item.business_info) continue;
    seen.add(bvid);
    result.push({
      bvid, title: plain(item.title) || bvid,
      author: plain(object(item.owner).name ?? item.author ?? item.uname) || undefined,
      cover: coverUrl(item.pic ?? item.cover),
    });
  }
  return result;
}

export function useBilibiliRead<K extends Protocol>(session: Session, operation: K, input: BilibiliProtocolInputs[K] | null) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; value?: unknown; error?: string }>();
  const key = JSON.stringify([session.connection.baseUrl, session.connection.token, session.accountId, operation, input, revision]);
  useEffect(() => {
    if (!input) return;
    const controller = new AbortController();
    void callBilibiliProtocol(session.connection, session.accountId, operation, input, controller.signal).then(
      response => { if (!controller.signal.aborted) setResult({ key, value: response.data }); },
      error => { if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "读取 B 站失败。" }); },
    );
    return () => controller.abort();
  }, [key]);
  const current = result?.key === key ? result : undefined;
  return { result: current, reload: () => setRevision(value => value + 1) };
}

type ReadState = ReturnType<typeof useBilibiliRead>;
function ReadResult({ state, label, children }: { state: ReadState; label: string; children: (data: unknown) => React.ReactNode }) {
  if (!state.result) return <Loading label={label} />;
  if (state.result.error) return <ErrorLine text={state.result.error} onRetry={state.reload} />;
  return <>{children(state.result.value)}</>;
}

function ResultRow({ title, subtitle, cover, label, onPress }: { title: string; subtitle?: string; cover?: string; label?: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} onPress={onPress}
    style={({ pressed }) => [contentStyles.entry, pressed && styles.pressed]}>
    {cover ? <Image source={{ uri: cover }} style={styles.cover} resizeMode="cover" /> : null}
    <View style={styles.resultText}>
      <Text numberOfLines={2} style={contentStyles.title}>{title}</Text>
      {subtitle ? <Text style={kit.muted}>{subtitle}</Text> : null}
    </View>
  </Pressable>;
}

export function BilibiliVideoList({ videos, onOpen, empty = "暂无视频。" }: { videos: Video[]; onOpen: (bvid: string) => void; empty?: string }) {
  return videos.length ? <View>{videos.map(video => <ResultRow key={video.bvid} title={video.title} subtitle={video.author}
    cover={video.cover} label={`查看 B 站视频：${video.title}`} onPress={() => onOpen(video.bvid)} />)}</View> : <Empty text={empty} />;
}

function PageButtons({ page, next, onChange }: { page: number; next: boolean; onChange: (page: number) => void }) {
  return <View style={kit.row}>
    <SmallButton label="上一页" disabled={page <= 1} onPress={() => onChange(page - 1)} />
    <Text style={kit.muted}>第 {page} 页</Text>
    <SmallButton label="下一页" disabled={!next || page >= 1000} onPress={() => onChange(page + 1)} />
  </View>;
}

function AuthorProfile({ session, id, onVideo }: { session: Session; id: string; onVideo: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const source = useBilibiliRead(session, "profile", { mid: id, page });
  return <ScrollView contentContainerStyle={contentStyles.page}>
    <ReadResult state={source} label="正在读取 UP 主主页">{value => {
      const data = object(value);
      const profile = object(data.profile);
      const videos = object(data.videos);
      const uploads = bilibiliVideos(object(videos.list).vlist);
      const count = Number(object(videos.page).count);
      return <>
        <Panel title={plain(profile.name) || "UP 主主页"} subtitle={`UID ${id}`}>
          {plain(profile.sign) ? <Text style={kit.body}>{plain(profile.sign)}</Text> : null}
          <SmallButton label="在 B 站打开主页" onPress={() => void Linking.openURL(`https://space.bilibili.com/${id}`).catch(() => undefined)} />
        </Panel>
        <Panel title="投稿">
          <BilibiliVideoList videos={uploads} onOpen={onVideo} />
          {uploads.length > 0 || page > 1 ? <PageButtons page={page} next={Number.isFinite(count) ? page * 20 < count : uploads.length >= 20} onChange={setPage} /> : null}
        </Panel>
      </>;
    }}</ReadResult>
  </ScrollView>;
}

function SelectedContent({ session, selected, onOpen, onBack, navigation }: { session: Session; selected: Selection;
  onOpen: (item: Selection) => void; onBack: () => void; navigation?: React.ReactNode }) {
  return <View style={styles.fill}>
    {selected.kind !== "video" || navigation ? <View style={[kit.row, styles.detailToolbar]}>
      {selected.kind !== "video" ? <SmallButton label="返回" onPress={onBack} /> : null}
      {navigation}
    </View> : null}
    {selected.kind === "video" ? <BilibiliVideoDetail key={selected.id} {...session} bvid={selected.id} onBack={onBack}
      onOpenAuthor={id => onOpen({ kind: "author", id })} />
      : selected.kind === "author" ? <AuthorProfile key={selected.id} session={session} id={selected.id} onVideo={id => onOpen({ kind: "video", id })} />
        : <BilibiliLivePlayer key={selected.id} session={session} roomId={selected.id} />}
  </View>;
}

export function BilibiliFeedWorkspace(session: Session) {
  const [cursor, setCursor] = useState(1);
  const [selection, setSelection] = useState<Selection[]>([]);
  const selected = selection.at(-1);
  const feed = useBilibiliRead(session, "feed", { cursor, pageSize: 20 });
  const videos = bilibiliVideos(object(feed.result?.value).item);
  const open = (item: Selection) => setSelection(current => [...current, item]);
  const openVideo = (id: string) => open({ kind: "video", id });
  const selectedIndex = selected?.kind === "video" ? videos.findIndex(video => video.bvid === selected.id) : -1;
  const switchVideo = (video: Video | undefined) => {
    if (video) setSelection(current => [...current.slice(0, -1), { kind: "video", id: video.bvid }]);
  };
  if (selected) return <SelectedContent session={session} selected={selected} onOpen={open} onBack={() => setSelection(current => current.slice(0, -1))}
    navigation={selectedIndex >= 0 ? <>
      <SmallButton label="上一条" disabled={selectedIndex === 0} onPress={() => switchVideo(videos[selectedIndex - 1])} />
      <SmallButton label="下一条" disabled={selectedIndex + 1 >= videos.length} onPress={() => switchVideo(videos[selectedIndex + 1])} />
    </> : undefined} />;
  return <ScrollView testID="bilibili-feed-workspace" contentContainerStyle={contentStyles.page}>
    <Panel title="推荐" extra={<SmallButton label="换一批" disabled={!feed.result || cursor >= 1000} onPress={() => setCursor(value => value + 1)} />}>
      <ReadResult state={feed} label="正在读取 B 站推荐">{() => <BilibiliVideoList videos={videos} onOpen={openVideo} />}</ReadResult>
    </Panel>
  </ScrollView>;
}

type SearchKind = "video" | "bili_user" | "live_room";
type ExploreMode = "search" | "hot" | "popular" | "ranking";
const searchKinds = [{ value: "video", label: "作品" }, { value: "bili_user", label: "用户" }, { value: "live_room", label: "直播间" }] as const;
const exploreModes = [{ value: "hot", label: "热搜" }, { value: "popular", label: "热门视频" }, { value: "ranking", label: "排行榜" }] as const;

export function BilibiliExploreWorkspace({ initialAuthor, onUseInitialAuthor, ...session }: Session & { initialAuthor?: string | null; onUseInitialAuthor?: () => void }) {
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState<SearchKind>("video");
  const [mode, setMode] = useState<ExploreMode>("hot");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection[]>(() => initialAuthor ? [{ kind: "author", id: initialAuthor }] : []);
  useEffect(() => { if (initialAuthor) onUseInitialAuthor?.(); }, [initialAuthor, onUseInitialAuthor]);
  const selected = selection.at(-1);
  const search = useBilibiliRead(session, "search", mode === "search" && keyword ? { keyword, type: kind, page } : null);
  const hot = useBilibiliRead(session, "hot", mode === "search" ? null : { kind: mode === "hot" ? "search" : mode, page });
  const open = (item: Selection) => setSelection(current => [...current, item]);
  const openVideo = (id: string) => open({ kind: "video", id });
  const submit = (value: string) => {
    const query = value.trim().slice(0, 300);
    if (!query) return;
    if (mode === "search" && page === 1 && keyword === query) search.reload();
    setDraft(query); setKeyword(query); setPage(1); setMode("search");
  };
  if (selected) return <SelectedContent session={session} selected={selected} onOpen={open} onBack={() => setSelection(current => current.slice(0, -1))} />;
  return <ScrollView testID="bilibili-explore-workspace" contentContainerStyle={contentStyles.page} keyboardShouldPersistTaps="handled">
    <Panel title="探索">
      <View style={kit.row}>
        <SearchField label="搜索 B 站视频、用户或直播间" value={draft} onChange={setDraft} onSubmit={() => submit(draft)} />
        <SmallButton label="搜索" disabled={!draft.trim()} onPress={() => submit(draft)} />
      </View>
      <Tabs<SearchKind> options={[...searchKinds]} value={kind} onChange={value => { setKind(value); setPage(1); }} />
      <View style={kit.row}>{exploreModes.map(item => <SmallButton key={item.value} label={item.label} done={mode === item.value}
        onPress={() => { setMode(item.value); setPage(1); }} />)}</View>
    </Panel>
    {mode === "search" ? <Panel title="搜索结果" subtitle={keyword}>
      <ReadResult state={search} label="正在搜索 B 站">{value => {
        const data = object(value);
        const items = rows(data.result);
        const numPages = Number(data.numPages);
        return <>
          {kind === "video" ? <BilibiliVideoList videos={bilibiliVideos(items)} onOpen={openVideo} empty="没有匹配的作品。" />
            : items.length ? items.map(item => {
              const id = stringId(kind === "bili_user" ? item.mid : item.roomid ?? item.room_id);
              if (!id) return null;
              const title = plain(kind === "bili_user" ? item.uname : item.title) || id;
              return <ResultRow key={id} title={title} subtitle={plain(kind === "bili_user" ? item.usign : item.uname)}
                cover={coverUrl(kind === "bili_user" ? item.upic : item.cover)} onPress={() => open({ kind: kind === "bili_user" ? "author" : "live", id })} />;
            }) : <Empty text="没有匹配的结果。" />}
          {items.length || page > 1 ? <PageButtons page={page} next={Number.isFinite(numPages) ? page < numPages : items.length >= 20} onChange={setPage} /> : null}
        </>;
      }}</ReadResult>
    </Panel> : <Panel title={exploreModes.find(item => item.value === mode)?.label}>
      <ReadResult state={hot} label="正在读取 B 站榜单">{value => {
        const data = object(value);
        if (mode === "hot") {
          const words = rows(object(data.trending).list ?? data.list).map(item => plain(item.keyword ?? item.show_name)).filter(Boolean);
          return words.length ? <View style={kit.row}>{[...new Set(words)].map(word => <SmallButton key={word} label={word}
            onPress={() => { setKind("video"); submit(word); }} />)}</View> : <Empty text="当前没有热搜。" />;
        }
        const videos = bilibiliVideos(data.list);
        return <>
          <BilibiliVideoList videos={videos} onOpen={openVideo} />
          {mode === "popular" && (videos.length > 0 || page > 1) ? <PageButtons page={page} next={data.no_more !== true && videos.length > 0} onChange={setPage} /> : null}
        </>;
      }}</ReadResult>
    </Panel>}
  </ScrollView>;
}

function hlsSource(value: unknown) {
  const playInfo = object(object(value).playurl_info);
  for (const stream of rows(object(playInfo.playurl).stream)) {
    if (stream.protocol_name !== "http_hls") continue;
    for (const format of rows(stream.format)) {
      const codecs = rows(format.codec);
      const codec = codecs.find(item => item.codec_name === "avc") ?? codecs[0];
      const base = plain(codec?.base_url);
      if (!base.startsWith("/")) continue;
      for (const url of rows(codec?.url_info)) {
        try {
          const host = new URL(plain(url.host));
          if (host.protocol !== "https:" || !/(^|\.)(bilivideo\.com|bilivideo\.cn)$/u.test(host.hostname)) continue;
          const parsed = new URL(`${base}${plain(url.extra)}`, host);
          if (parsed.origin === host.origin) return parsed.href;
        } catch { /* 当前流地址无效，继续找下一条。 */ }
      }
    }
  }
  return undefined;
}

function BilibiliHls({ url }: { url: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (element) return playLiveStream(element, url, { onError: () => setError(true), onAutoplayMuted: () => {} }, { autoplay: false });
  }, [url]);
  return <View>
    <video ref={video} controls playsInline preload="none"
      aria-label="B 站直播播放器" style={{ display: "block", width: "100%", maxHeight: "70vh", aspectRatio: "16 / 9", backgroundColor: "black" }} />
    {error ? <Text style={kit.muted}>当前直播流加载失败，可以在 B 站打开直播间。</Text> : null}
  </View>;
}

export function BilibiliLivePlayer({ session, roomId }: { session: Session; roomId: string }) {
  const stream = useBilibiliRead(session, "live/playback", { roomId });
  return <ScrollView contentContainerStyle={contentStyles.page}>
    <Panel title="直播间" subtitle={roomId} extra={<SmallButton label="在 B 站打开" onPress={() => void Linking.openURL(`https://live.bilibili.com/${roomId}`).catch(() => undefined)} />}>
      <ReadResult state={stream} label="正在读取直播流">{value => {
        const url = hlsSource(value);
        return url && Platform.OS === "web" ? <BilibiliHls key={url} url={url} /> : <Empty text="当前没有可在工作台播放的直播流。" />;
      }}</ReadResult>
    </Panel>
  </ScrollView>;
}

type OnlineKind = "history" | "likes" | "following" | "liveHistory";
type Cursor = { max?: string; viewAt?: string };

export function BilibiliOnlineRecords({ session, kind, onVideo, onRoom }: { session: Session; kind: OnlineKind;
  onVideo: (bvid: string) => void; onRoom: (roomId: string) => void }) {
  const [historyStack, setHistoryStack] = useState<Cursor[]>([{}]);
  const [followingPage, setFollowingPage] = useState(1);
  const cursor = historyStack.at(-1);
  const isVideoHistory = kind === "history";
  const isLiveHistory = kind === "liveHistory";
  const history = useBilibiliRead(session, "history/read", isVideoHistory || isLiveHistory ? { kind: isVideoHistory ? "archive" : "live", ...cursor } : null);
  const favorites = useBilibiliRead(session, "likes/recent", kind === "likes" ? {} : null);
  const following = useBilibiliRead(session, "live/following", kind === "following" ? { page: followingPage } : null);
  const state = kind === "likes" ? favorites : kind === "following" ? following : history;
  return <ReadResult state={state} label="正在读取 B 站记录">{value => {
    const item = object(value);
    if (kind === "likes") return <BilibiliVideoList videos={bilibiliVideos(Array.isArray(value) ? value : item.list)} onOpen={onVideo} empty="近期没有可读取的点赞记录。" />;
    const list = rows(kind === "following" ? item.rooms ?? item.list : item.list);
    const nextCursor = object(item.cursor);
    const next = { max: stringId(nextCursor.max) || undefined, viewAt: stringId(nextCursor.view_at) || undefined };
    const hasNext = list.length > 0 && Boolean(next.max || next.viewAt) && (next.max !== cursor?.max || next.viewAt !== cursor?.viewAt);
    const videos = isVideoHistory ? bilibiliVideos(list.map(entry => ({
      ...entry, bvid: object(entry.history).bvid || entry.bvid, author: entry.author_name || entry.author,
    }))) : [];
    const rooms = isVideoHistory ? [] : list.flatMap(entry => {
      if (kind === "following" && entry.live_status != null && Number(entry.live_status) !== 1) return [];
      const id = stringId(entry.room_id ?? entry.roomid ?? object(entry.history).oid);
      return id ? [{ id, title: plain(entry.title ?? entry.uname) || `直播间 ${id}`,
        subtitle: plain(entry.uname ?? entry.author_name), cover: coverUrl(entry.cover ?? entry.face) }] : [];
    });
    return <>
      {isVideoHistory ? <BilibiliVideoList videos={videos} onOpen={onVideo} empty="没有更多视频记录。" />
        : rooms.length ? rooms.map((room, index) => <ResultRow key={`${room.id}-${index}`} title={room.title} subtitle={room.subtitle}
          cover={room.cover} label={`打开 B 站直播间：${room.title}`} onPress={() => onRoom(room.id)} />)
          : <Empty text={kind === "following" ? "暂时没有正在直播的关注账号。" : "没有更多直播记录。"} />}
      {kind === "following" ? (list.length || followingPage > 1 ? <PageButtons page={followingPage}
        next={item.totalPage == null ? list.length >= 9 : followingPage < Number(item.totalPage)} onChange={setFollowingPage} /> : null)
        : hasNext || historyStack.length > 1 ? <PageButtons page={historyStack.length} next={hasNext}
          onChange={page => setHistoryStack(current => page > current.length ? [...current, next] : current.slice(0, -1))} /> : null}
    </>;
  }}</ReadResult>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pressed: { backgroundColor: color.surfaceMuted },
  cover: { width: 112, height: 63, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  resultText: { gap: 3, flex: 1 },
  detailToolbar: { paddingHorizontal: 20, paddingVertical: 8 },
});
