import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronRight, Heart, MessageCircle, Play, Search, UserRound, Users, X } from "lucide-react-native";
import { closeExplore, interactExplore, readExplore, type ExploreAction, type ExploreComment, type ExploreConnection, type ExplorePage, type ExploreQuery, type ExploreUser, type ExploreVideo } from "../../services/explorer";
import { loadCollectorVideo } from "../../services/localCollector";
import { RecordVideoPlayer } from "./RecordVideoPlayer";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

const count = (value?: number | null) => value === undefined || value === null ? "—" : value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/u, "")}万` : value.toLocaleString("zh-CN");
const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN") : "";
type ActionIntent = { action: ExploreAction["action"]; label: string; desired?: boolean; text?: string };
type Props = { connection: ExploreConnection | null; collectorBusy: boolean; onOpenSettings: () => void; onOpenRecord: (url: string) => Promise<void> };

function Button({ label, onPress, disabled = false, primary = false, children }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; children?: React.ReactNode }) {
  return <Pressable {...ws(primary ? "btn-solid" : "btn")} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.button, primary && styles.primary, disabled && styles.disabled]}>
    {children}<Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
  </Pressable>;
}
function Avatar({ user, size = 52 }: { user: ExploreUser | null; size?: number }) {
  return user?.avatar ? <Image accessibilityLabel={`${user.name}的头像`} source={{ uri: user.avatar }} style={{ width: size, height: size, borderRadius: size / 2 }} />
    : <View {...ws("c-avatar")} style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}><UserRound size={size * 0.44} color={color.textMuted} /></View>;
}
function Metric({ value, label }: { value?: number | null; label: string }) {
  return <View style={styles.metric}><Text {...ws("d-num big")} style={styles.metricValue}>{count(value)}</Text><Text style={styles.muted}>{label}</Text></View>;
}

export function ExploreWorkspace({ connection, collectorBusy, onOpenSettings, onOpenRecord }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 760;
  const [mode, setMode] = useState<"users" | "videos">("users");
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState<ExploreQuery | null>(null);
  const [results, setResults] = useState<ExplorePage | null>(null);
  const [profile, setProfile] = useState<ExplorePage | null>(null);
  const [detail, setDetail] = useState<ExplorePage | null>(null);
  const [comments, setComments] = useState<ExplorePage | null>(null);
  const [commentText, setCommentText] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [intent, setIntent] = useState<ActionIntent | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [playing, setPlaying] = useState<ExploreVideo | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const sessions = useRef(new Set<string>());
  const generation = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    generation.current += 1; requestRef.current?.abort(); locked.current = false;
    setResults(null); setProfile(null); setDetail(null); setComments(null); setLoading(null); setPending([]); setError(null); setNotice(null);
    setIntent(null); setPlaying(null); setCommentText("");
    return () => {
      generation.current += 1; requestRef.current?.abort();
      const ids = [...sessions.current]; sessions.current.clear();
      if (connection) void closeExplore(connection, ids).catch(() => {});
    };
  }, [connection?.baseUrl, connection?.token]);
  const busy = Boolean(loading || sending);
  const user = profile?.profile ?? null;
  const video = detail?.video ?? null;
  const page = detail ?? profile ?? results;
  const pendingKey = (action: string) => `${action === "follow" ? profile?.sessionId : detail?.sessionId}:${action}`;

  async function load(input: ExploreQuery, target: "results" | "profile" | "detail" | "comments", more = false) {
    if (!connection || locked.current) return;
    locked.current = true;
    const current = ++generation.current;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timeout = setTimeout(() => {
      if (current !== generation.current) return;
      setError("读取超时，已停止等待，请稍后重试。");
      controller.abort();
    }, 50000);
    setLoading(more ? "more" : target); setError(null); setNotice(null);
    try {
      const next = await readExplore(connection, input, controller.signal);
      if (current !== generation.current) return;
      sessions.current.add(next.sessionId);
      if (target === "results") { setResults(next); setSearchQuery({ ...input, sessionId: undefined }); setProfile(null); setDetail(null); setComments(null); }
      if (target === "profile") { setProfile(next); setDetail(null); setComments(null); }
      if (target === "detail") { setDetail(next); setComments(null); setCommentText(""); }
      if (target === "comments") setComments(next);
      if (!more && target !== "comments") requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败，请重试。");
    } finally {
      clearTimeout(timeout);
      if (current === generation.current) { setLoading(null); locked.current = false; }
    }
  }
  function cancelLoad() {
    generation.current += 1;
    requestRef.current?.abort();
    locked.current = false; setLoading(null); setNotice("已取消读取，可以重新搜索。");
  }
  function search() {
    const candidate = query.trim();
    if (!candidate) return;
    const profileMatch = /^https:\/\/(?:www\.)?douyin\.com\/user\/([\w-]+)/u.exec(candidate);
    const videoMatch = /^https:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/(\d+)/u.exec(candidate);
    if (profileMatch?.[1]) void load({ kind: "profile", id: profileMatch[1] }, "profile");
    else if (videoMatch?.[1] || /^\d{15,30}$/u.test(candidate)) void load({ kind: "detail", id: videoMatch?.[1] ?? candidate }, "detail");
    else void load({ kind: mode, query: candidate }, "results");
  }
  function back() { setError(null); setNotice(null); setComments(null); if (detail) setDetail(null); else setProfile(null); scrollRef.current?.scrollTo({ y: 0, animated: false }); }
  async function commitAction() {
    const session = intent?.action === "follow" ? profile : detail;
    if (!connection || !intent || !session || locked.current) return;
    locked.current = true; setSending(true); setNotice(null); setError(null);
    const action = intent; const key = pendingKey(action.action); const current = generation.current;
    setIntent(null);
    try {
      const outcome = await interactExplore(connection, { ...action, sessionId: session.sessionId, requestId: crypto.randomUUID() });
      if (current !== generation.current) return;
      setNotice(outcome.message);
      if (outcome.outcome === "unknown") setPending((values) => [...values, key]);
      if (outcome.outcome === "confirmed") {
        if (action.action === "follow") setProfile((value) => value?.profile ? { ...value, profile: { ...value.profile, followed: outcome.value ?? null } } : value);
        if (action.action === "like" || action.action === "collect") setDetail((value) => value?.video ? { ...value, video: { ...value.video, [action.action === "like" ? "liked" : "collected"]: outcome.value ?? null } } : value);
        if (action.action === "comment") {
          setCommentText("");
          if (outcome.comment) setComments((value) => value ? { ...value, items: [outcome.comment!, ...value.items.filter((item) => item.id !== outcome.comment!.id)] } : value);
        }
      }
    } catch (cause) {
      if (current === generation.current) { setPending((values) => [...values, key]); setError(cause instanceof Error ? cause.message : "操作结果待核验，请查看抖音原页。"); }
    } finally { setSending(false); locked.current = false; }
  }
  function moreButton(data: ExplorePage | null, input: ExploreQuery, target: "results" | "profile" | "comments") {
    if (!data) return null;
    return <View style={styles.pagination}>{data.limited ? <Text style={styles.muted}>已展示 500 条，请缩小搜索范围或在原页继续查看。</Text>
      : data.hasMore === false ? <Text style={styles.muted}>已显示全部已返回内容</Text>
        : <Button label={loading === "more" ? "正在加载…" : target === "comments" ? "加载更多评论" : "加载更多"} disabled={busy} onPress={() => void load({ ...input, sessionId: data.sessionId }, target, true)} />}</View>;
  }
  const openProfile = (author: ExploreUser) => void load({ kind: "profile", id: author.id }, "profile");
  function videoCards(data: ExplorePage) {
    const columns = gridWidth >= 860 ? 4 : gridWidth >= 570 ? 3 : 2;
    const cardWidth = gridWidth ? Math.floor((gridWidth - 16 * (columns - 1)) / columns) : "47%";
    return <View onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)} style={styles.grid}>{(data.items as ExploreVideo[]).map((item) => <View {...ws("e-box")} key={item.id} style={[styles.videoCard, { width: cardWidth }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看作品：${item.title}`} disabled={busy} onPress={() => void load({ kind: "detail", id: item.videoId! }, "detail")} style={styles.cover}>
        {item.coverUrl ? <Image source={{ uri: item.coverUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Play color={color.textMuted} size={30} />}
        <View {...ws("stamp e-badge")} style={styles.coverBadge}><Text style={styles.coverText}>{item.mediaType === "image" ? "图文" : "视频"}{item.durationSeconds ? ` · ${Math.floor(item.durationSeconds / 60)}:${String(Math.floor(item.durationSeconds % 60)).padStart(2, "0")}` : ""}</Text></View>
      </Pressable>
      <View style={styles.cardBody}><Pressable accessibilityRole="button" disabled={busy} onPress={() => void load({ kind: "detail", id: item.videoId! }, "detail")}><Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看作者：${item.author ?? "抖音用户"}`} disabled={busy || !item.authorProfile} onPress={() => item.authorProfile && openProfile(item.authorProfile)}><Text numberOfLines={1} style={styles.muted}>@{item.author ?? "抖音用户"}</Text></Pressable>
        <View style={styles.between}><Text style={styles.muted}>{date(item.publishedAt)}</Text><View style={styles.row}><Heart size={13} color={color.textMuted} /><Text style={styles.muted}>{count(item.stats?.diggCount)}</Text></View></View>
      </View>
    </View>)}</View>;
  }

  return <ScrollView ref={scrollRef} testID="explore-workspace" style={styles.root} contentContainerStyle={[styles.content, narrow && styles.contentNarrow]} keyboardShouldPersistTaps="handled">
    <View style={styles.between}><Text {...ws("stamp-sig")} style={styles.eyebrow}>EXPLORE · 在线探索</Text><Text {...ws("mono")} style={styles.muted}>{connection ? "本地会话已连接" : "等待连接"}</Text></View>
    <Text {...ws("e-title")} accessibilityRole="header" style={[styles.title, narrow && styles.titleNarrow]}>寻找感兴趣的人与作品</Text>
    <Text {...ws("e-sub")} style={styles.subtitle}>从一个名字、一段内容出发，看看创作者的更多表达。</Text>
    <View {...ws("e-panel")} style={styles.searchPanel}>
      <View {...ws("e-tabs")} accessibilityRole="tablist" style={styles.tabs}>{(["users", "videos"] as const).map((value) => <Pressable {...ws("e-tab", mode === value && "on")} key={value} accessibilityRole="tab" accessibilityState={{ selected: mode === value }} disabled={busy} onPress={() => { setMode(value); setResults(null); setProfile(null); setDetail(null); setSearchQuery(null); setError(null); setNotice(null); }} style={[styles.tab, mode === value && styles.tabSelected]}>
        {value === "users" ? <Users size={17} color={mode === value ? color.text : color.textMuted} /> : <Play size={17} color={mode === value ? color.text : color.textMuted} />}<Text style={[styles.tabText, mode === value && styles.selectedText]}>{value === "users" ? "搜索用户" : "搜索内容"}</Text>
      </Pressable>)}</View>
      <View {...ws("e-searchrow")} style={styles.searchRow}><Search size={19} color={color.textMuted} /><TextInput accessibilityLabel="搜索关键词或抖音链接" value={query} onChangeText={setQuery} onSubmitEditing={search} editable={!busy} maxLength={300} placeholder={mode === "users" ? "昵称、抖音号或用户主页链接" : "内容关键词、作品链接或作品 ID"} placeholderTextColor={color.textMuted} returnKeyType="search" style={styles.searchInput} />
        <Button label="搜索" primary disabled={!query.trim() || busy || !connection} onPress={search} />
      </View>
    </View>
    {!connection ? <View {...ws("e-empty")} style={styles.empty}><Search size={34} color={color.cyan} /><Text {...ws("w-emptytitle")} style={styles.sectionTitle}>连接抖音，开始探索</Text><Text style={styles.emptyText}>连接本地采集器后即可搜索，无需先导入历史记录。</Text><Button label="前往连接" primary onPress={onOpenSettings} /></View> : null}
    {collectorBusy ? <View {...ws("stamp-bar")} style={styles.banner}><Text style={styles.bannerText}>采集器正在处理任务。手动监听就绪后可直接搜索；同步或下载期间请等待任务完成。</Text><Button label="采集设置" onPress={onOpenSettings} /></View> : null}
    {error ? <View {...ws("s-error")} accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{error}</Text><Button label="连接设置" onPress={onOpenSettings} /></View> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
    {loading || sending ? <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={color.cyan} /><Text style={styles.muted}>{sending ? "正在提交并核验操作…" : "正在读取抖音页面…"}</Text>{loading && !sending ? <Button label="取消读取" onPress={cancelLoad} /> : null}</View> : null}
    {detail || profile ? <View style={styles.breadcrumb}><Button label={detail && profile ? "返回用户作品" : "返回搜索结果"} disabled={busy} onPress={back}><ArrowLeft color={color.text} size={16} /></Button><ChevronRight size={14} color={color.textMuted} /><Text numberOfLines={1} style={[styles.muted, { flex: 1 }]}>{video ? "作品详情" : user?.name}</Text><Button label="刷新" disabled={busy} onPress={() => video ? void load({ kind: "detail", id: video.videoId! }, "detail") : user && void load({ kind: "profile", id: user.id }, "profile")} /></View> : null}

    {user && !detail ? <>
      <View {...ws("e-box")} style={[styles.profile, narrow && styles.profileNarrow]}><Avatar user={user} size={86} /><View style={styles.profileCopy}><Text {...ws("e-name")} accessibilityRole="header" style={styles.profileName}>{user.name}</Text><Text style={styles.muted}>抖音号：{user.handle || "未提供"}</Text><Text style={styles.bio}>{user.bio || "还没有个人简介"}</Text><View style={styles.metrics}><Metric value={user.followers} label="粉丝" /><Metric value={user.following} label="关注" /><Metric value={user.likes} label="获赞" /><Metric value={user.posts} label="作品" /></View></View>
        <View style={styles.actions}><Button label={pending.includes(pendingKey("follow")) ? "关注待核验" : user.followed ? "已关注" : "关注"} disabled={busy || pending.includes(pendingKey("follow"))} primary={!user.followed} onPress={() => setIntent({ action: "follow", label: user.followed ? "取消关注" : "关注", desired: !user.followed })} />
          <Button label="抖音主页" onPress={() => void onOpenRecord(user.url)}><ArrowUpRight size={15} color={color.text} /></Button></View>
      </View>
      <View style={styles.between}><Text {...ws("e-section")} style={styles.sectionTitle}>TA 的作品</Text><Text style={styles.muted}>已加载 {profile?.items.length ?? 0} 条</Text></View>
      {profile?.items.length ? videoCards(profile) : !loading ? <Text style={styles.emptyText}>暂无可查看的公开作品。</Text> : null}
      {moreButton(profile, { kind: "profile", id: user.id }, "profile")}
    </> : null}

    {video ? <View style={[styles.detailLayout, width < 1080 && styles.detailStack]}>
      <View style={[styles.mediaColumn, width < 1080 && { width: "100%" }]}>
        {video.images.length ? <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.imageGallery}>{video.images.map((uri, i) => <Image key={uri} accessibilityLabel={`作品图片 ${i + 1}`} source={{ uri }} style={[styles.workImage, { width: narrow ? 260 : 360 }]} resizeMode="contain" />)}</ScrollView>
          : <Pressable accessibilityRole="button" accessibilityLabel="播放当前作品" disabled={!connection || busy || !detail} onPress={() => detail && setPlaying(video)} style={styles.detailCover}>
            {video.coverUrl ? <Image source={{ uri: video.coverUrl }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : null}<View style={styles.play}><Play size={28} color="#fff" fill="#fff" /></View><Text style={styles.playLabel}>播放视频</Text>
          </Pressable>}
        <Button label="在抖音打开作品" onPress={() => video.url && void onOpenRecord(video.url)}><ArrowUpRight size={16} color={color.text} /></Button>
      </View>
      <View style={styles.detailCopy}><Text {...ws("e-name")} accessibilityRole="header" style={styles.detailTitle}>{video.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="查看作者主页" disabled={busy || !video.authorProfile} onPress={() => video.authorProfile && openProfile(video.authorProfile)} style={styles.authorLine}><Avatar user={video.authorProfile} size={34} /><Text style={styles.cardTitle}>{video.author ?? "抖音用户"}</Text><ChevronRight color={color.textMuted} size={15} /></Pressable>
        <Text style={styles.muted}>{date(video.publishedAt)}{video.music?.title ? ` · ${video.music.title}` : ""}</Text>
        <View style={styles.metrics}><Metric value={video.stats?.diggCount} label="获赞" /><Metric value={video.stats?.collectCount} label="收藏" /><Metric value={video.stats?.commentCount} label="评论" /><Metric value={video.stats?.shareCount} label="分享" /></View>
        <View style={styles.actionsRow}>{(["like", "collect"] as const).map((action) => {
          const selected = action === "like" ? video.liked : video.collected;
          const label = action === "like" ? "点赞" : "收藏";
          return <Button key={action} label={pending.includes(pendingKey(action)) ? `${label}待核验` : selected ? `已${label}` : label} disabled={busy || pending.includes(pendingKey(action))} onPress={() => setIntent({ action, label: selected ? `取消${label}` : label, desired: !selected })}>
            {action === "like" ? <Heart size={17} fill={selected ? color.accent : "none"} color={color.accent} /> : <Bookmark size={17} fill={selected ? color.accent : "none"} color={color.accent} />}
          </Button>;
        })}</View>
        <View style={styles.commentHeader}><Text {...ws("e-section")} style={styles.sectionTitle}>评论</Text><Button label={comments ? "刷新评论" : "读取评论"} disabled={busy} onPress={() => void load({ kind: "comments", id: video.videoId! }, "comments")} /></View>
        <View {...ws("e-box")} style={styles.composer}><TextInput accessibilityLabel="评论内容" multiline value={commentText} onChangeText={setCommentText} maxLength={500} editable={!busy} placeholder="说说你的想法…" placeholderTextColor={color.textMuted} style={styles.commentInput} /><View style={styles.between}><Text style={styles.muted}>{commentText.length}/500</Text><Button label={pending.includes(pendingKey("comment")) ? "发送结果待核验" : "发表评论"} primary disabled={busy || !commentText.trim() || pending.includes(pendingKey("comment"))} onPress={() => setIntent({ action: "comment", label: "发表评论", text: commentText.trim() })} /></View></View>
        {comments ? <>{(comments.items as ExploreComment[]).map((comment) => <View key={comment.id} style={styles.comment}>
          <Pressable accessibilityRole="button" accessibilityLabel={`查看评论作者：${comment.name}`} disabled={busy || !comment.author} onPress={() => comment.author && openProfile(comment.author)}><Avatar user={comment.author} size={32} /></Pressable>
          <View style={styles.commentBody}><Text style={styles.commentName}>{comment.name}</Text><Text style={styles.bio}>{comment.text}</Text><Text style={styles.muted}>{date(comment.publishedAt)} · {count(comment.likes)} 赞{comment.replies ? ` · ${comment.replies} 条回复（原页查看）` : ""}</Text></View>
        </View>)}{!comments.items.length ? <Text style={styles.emptyText}>暂时没有评论。</Text> : null}{moreButton(comments, { kind: "comments", id: video.videoId! }, "comments")}</> : <View style={styles.commentEmpty}><MessageCircle size={24} color={color.textMuted} /><Text style={styles.muted}>点击“读取评论”查看大家的讨论</Text></View>}
      </View>
    </View> : null}

    {results && !profile && !detail ? <>
      <View style={styles.between}><Text {...ws("e-section")} style={styles.sectionTitle}>“{searchQuery?.query}”的{results.kind === "users" ? "用户" : "内容"}</Text><Text style={styles.muted}>已加载 {results.items.length} 条</Text></View>
      {results.kind === "users" ? <View style={styles.userList}>{(results.items as ExploreUser[]).map((author) => <Pressable key={author.id} accessibilityRole="button" accessibilityLabel={`查看用户：${author.name}`} disabled={busy} onPress={() => openProfile(author)} {...ws("e-box e-user")} style={[styles.userCard, narrow && styles.userCardNarrow]}>
        <Avatar user={author} /><View style={styles.userCopy}><Text {...ws("e-name small")} numberOfLines={1} style={styles.userName}>{author.name}</Text><Text style={styles.muted}>抖音号：{author.handle || "未提供"}</Text><Text numberOfLines={2} style={styles.userBio}>{author.bio || "还没有个人简介"}</Text></View><View style={styles.userNumbers}><Text style={styles.cardTitle}>{count(author.followers)}</Text><Text style={styles.muted}>粉丝</Text></View><ChevronRight color={color.textMuted} size={18} />
      </Pressable>)}</View> : videoCards(results)}
      {!results.items.length ? <View style={styles.empty}><Search size={30} color={color.textMuted} /><Text {...ws("e-section")} style={styles.sectionTitle}>没有找到相关结果</Text><Text style={styles.emptyText}>换一个更具体的名字或关键词试试。</Text></View> : null}
      {searchQuery ? moreButton(results, searchQuery, "results") : null}
    </> : null}
    {connection && !page && !loading ? <View {...ws("e-empty")} style={styles.empty}><View {...ws("w-emptyicon")} style={styles.emptyIcon}><Search size={32} color={color.cyan} /></View><Text {...ws("w-emptytitle")} style={styles.sectionTitle}>下一次发现，从这里开始</Text><Text style={styles.emptyText}>搜索用户，浏览 TA 的公开作品；或搜索内容，打开详情与评论。</Text><Text style={styles.muted}>也可以粘贴抖音用户主页或作品链接。</Text></View> : null}

    <Modal transparent visible={Boolean(intent)} animationType="fade" onRequestClose={() => setIntent(null)}>
      <View style={styles.modalBackdrop}><View {...ws("e-box e-modal")} accessibilityViewIsModal style={styles.modal}>
        <View style={styles.between}><Text {...ws("e-section")} style={styles.sectionTitle}>确认{intent?.label}</Text><Pressable accessibilityRole="button" accessibilityLabel="取消操作" onPress={() => setIntent(null)}><X size={22} color={color.text} /></Pressable></View>
        <Text style={styles.bio}>将使用当前登录的抖音账号{intent?.label}：</Text><Text numberOfLines={3} style={styles.cardTitle}>{intent?.action === "follow" ? user?.name : video?.title}</Text>
        {intent?.text ? <Text style={styles.commentPreview}>{intent.text}</Text> : null}
        <View style={styles.modalActions}><Button label="取消" onPress={() => setIntent(null)} /><Button label={intent?.action === "comment" ? "确认发送" : "确认操作"} primary onPress={() => void commitAction()}><Check size={16} color={color.buttonText} /></Button></View>
      </View></View>
    </Modal>
    {playing && connection ? <RecordVideoPlayer record={playing} records={(profile?.items ?? (results?.kind === "videos" ? results.items : [])) as ExploreVideo[]}
      commentsConnection={connection} onOpenRecord={onOpenRecord}
      onLoadVideo={(item, signal, onProgress) => loadCollectorVideo(connection.baseUrl, connection.token, item.url!, signal, onProgress)} onClose={() => setPlaying(null)} /> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas }, content: { padding: 32, gap: 22, paddingBottom: 70 }, contentNarrow: { padding: 16, gap: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 }, between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  eyebrow: { color: color.cyan, fontFamily: font.body, fontSize: 10, letterSpacing: 2 }, title: { color: color.text, fontFamily: font.body, fontSize: 32, fontWeight: "600", marginTop: 5 }, titleNarrow: { fontSize: 25 }, subtitle: { color: color.textMuted, fontFamily: font.body, fontSize: 14, lineHeight: 23, marginTop: -12 },
  muted: { color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 18 }, button: { minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface }, buttonText: { fontFamily: font.body, fontSize: 12, color: color.text, fontWeight: "600" }, primary: { backgroundColor: color.button, borderColor: color.button }, primaryText: { color: color.buttonText }, disabled: { opacity: 0.45 },
  searchPanel: { borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, borderRadius: radius.medium, overflow: "hidden" }, tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: color.borderSoft, paddingHorizontal: 14, gap: 20 }, tab: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 15, borderBottomWidth: 2, borderBottomColor: "transparent" }, tabSelected: { borderBottomColor: color.cyan }, tabText: { fontFamily: font.body, fontSize: 13, color: color.textMuted }, selectedText: { color: color.text, fontWeight: "600" }, searchRow: { padding: 14, flexDirection: "row", alignItems: "center", gap: 10 }, searchInput: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 14, minHeight: 40 },
  empty: { alignItems: "center", paddingVertical: 50, paddingHorizontal: 20, gap: 16 }, emptyIcon: { width: 74, height: 74, borderWidth: 1, borderColor: color.borderSoft, backgroundColor: color.surface, borderRadius: 22, alignItems: "center", justifyContent: "center", marginBottom: 6 }, sectionTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" }, emptyText: { color: color.textMuted, fontFamily: font.body, fontSize: 13, lineHeight: 22, textAlign: "center", paddingVertical: 10 },
  banner: { padding: 15, gap: 12, backgroundColor: color.surfaceRaised, borderWidth: 1, borderColor: color.border, borderRadius: radius.small }, bannerText: { fontFamily: font.body, fontSize: 12, lineHeight: 20, color: color.textSecondary }, error: { padding: 15, gap: 10, backgroundColor: color.dangerSoft, borderRadius: radius.small }, errorText: { fontFamily: font.body, color: color.danger, fontSize: 13, lineHeight: 22 }, notice: { fontFamily: font.body, color: color.cyan, fontSize: 13, lineHeight: 22 }, loading: { flexDirection: "row", alignItems: "center", gap: 10 }, breadcrumb: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { alignItems: "center", justifyContent: "center", backgroundColor: color.surfaceMuted }, userList: { gap: 10 }, userCard: { flexDirection: "row", alignItems: "center", gap: 18, backgroundColor: color.surface, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, padding: 22 }, userCardNarrow: { gap: 10, padding: 14 }, userCopy: { flex: 1, gap: 5, minWidth: 0 }, userName: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" }, userBio: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, lineHeight: 20 }, userNumbers: { alignItems: "flex-end", gap: 4 },
  profile: { flexDirection: "row", alignItems: "flex-start", gap: 24, padding: 26, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface }, profileNarrow: { flexWrap: "wrap", gap: 15, padding: 18 }, profileCopy: { flex: 1, minWidth: 190, gap: 9 }, profileName: { fontFamily: font.body, color: color.text, fontSize: 25, fontWeight: "600" }, bio: { fontFamily: font.body, color: color.textSecondary, fontSize: 13, lineHeight: 23 }, metrics: { flexDirection: "row", gap: 22, flexWrap: "wrap", marginVertical: 12 }, metric: { gap: 5 }, metricValue: { fontFamily: font.body, color: color.text, fontSize: 20, fontWeight: "600" }, actions: { gap: 10 }, actionsRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 16 }, videoCard: { borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, overflow: "hidden", backgroundColor: color.surface }, cover: { width: "100%", aspectRatio: 0.78, backgroundColor: color.surfaceMuted, alignItems: "center", justifyContent: "center" }, coverBadge: { position: "absolute", left: 9, bottom: 9, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.65)" }, coverText: { fontSize: 10, color: "#fff", fontFamily: font.body }, cardBody: { padding: 13, gap: 9 }, cardTitle: { fontFamily: font.body, color: color.text, fontSize: 13, lineHeight: 21, fontWeight: "600" }, pagination: { alignItems: "center", padding: 20 },
  detailLayout: { flexDirection: "row", gap: 28, alignItems: "flex-start" }, detailStack: { flexDirection: "column" }, mediaColumn: { width: "43%", gap: 12 }, detailCover: { width: "100%", aspectRatio: 0.72, maxHeight: 630, backgroundColor: "#101212", alignItems: "center", justifyContent: "center", borderRadius: radius.medium, overflow: "hidden" }, play: { width: 65, height: 65, borderRadius: 33, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.65)" }, playLabel: { color: "#fff", backgroundColor: "rgba(0,0,0,0.65)", padding: 8, marginTop: 12, fontFamily: font.body, fontSize: 12 }, detailCopy: { flex: 1, width: "100%", gap: 15 }, detailTitle: { fontFamily: font.body, color: color.text, fontSize: 21, lineHeight: 33, fontWeight: "600" }, authorLine: { flexDirection: "row", alignItems: "center", gap: 9 }, imageGallery: { gap: 10 }, workImage: { height: 460, backgroundColor: color.surfaceMuted },
  commentHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: color.borderSoft, paddingTop: 22, marginTop: 8 }, composer: { borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface, padding: 12, gap: 10 }, commentInput: { fontFamily: font.body, color: color.text, fontSize: 13, lineHeight: 22, minHeight: 65, textAlignVertical: "top" }, comment: { flexDirection: "row", gap: 10, borderBottomWidth: 1, borderBottomColor: color.borderSoft, paddingVertical: 14 }, commentBody: { flex: 1, gap: 7 }, commentName: { fontFamily: font.body, fontSize: 12, color: color.text, fontWeight: "600" }, commentEmpty: { alignItems: "center", padding: 28, gap: 12 },
  modalBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.scrim, padding: 22 }, modal: { width: "100%", maxWidth: 450, padding: 24, gap: 20, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface }, modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 }, commentPreview: { fontFamily: font.body, fontSize: 14, lineHeight: 24, color: color.text, padding: 15, backgroundColor: color.surfaceRaised, borderRadius: radius.small },
});
