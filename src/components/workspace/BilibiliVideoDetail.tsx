import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, ExternalLink, Heart, MessageCircle, Play, RefreshCw, Send, UserRound } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  callBilibiliProtocol,
  getBilibiliDetail,
  type BilibiliProtocolInputs,
  type BilibiliItem,
} from "../../services/bilibili";
import { SaveContentControl } from "./SaveContentControl";
import { Empty, ErrorLine, kit, Loading, Panel, SmallButton, Tabs } from "./CreatorKit";
import { workspaceColors as color, workspaceRadii as radius } from "./workspaceTheme";

type BilibiliDetailItem = BilibiliItem & {
  description?: string;
  pages?: BilibiliPage[];
};
type BilibiliPage = { cid: number; part: string; durationSeconds: number | null };

export type BilibiliVideoDetailProps = {
  connection: ExploreConnection;
  accountId: string;
  bvid: string;
  onOpenAuthor?: (mid: string) => void;
  onBack?: () => void;
};

type JsonRecord = Record<string, unknown>;
type PlaybackData = JsonRecord;
type SubtitleTrack = { lan: string; lanDoc: string };
type SubtitleCue = { from: number; to: number; content: string };
type VideoComment = {
  id: string;
  mid: string | null;
  uname: string;
  message: string;
  like: number;
  replyCount: number;
  time: string;
};

const PAGE_SIZE = 10;

const recordOf = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const arrayOf = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const textOf = (value: unknown, fallback = "") => typeof value === "string" ? value : value == null ? fallback : String(value);
const numberOf = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : Number(value) || fallback;
const idOf = (value: unknown) => value == null ? null : String(value);
const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const isAbortError = (error: unknown) => Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");

function detailPages(detail: BilibiliDetailItem | null) {
  return detail?.pages ?? [];
}

function streamUrl(data: PlaybackData | null): string | null {
  if (!data) return null;
  // DASH exposes separate audio/video tracks and must stay in the official
  // player. Only a single progressive DURL is safe to hand to <video>.
  const segments = arrayOf(data.durl).map(value => recordOf(value));
  if (segments.length !== 1) return null;
  const candidates = [segments[0]?.url, ...arrayOf(segments[0]?.backup_url)].map(value => textOf(value));
  return candidates.find(isBilibiliCdnUrl) ?? null;
}

function officialPlayerUrl(bvid: string, page: number) {
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=${page + 1}&high_quality=1&autoplay=0`;
}

function isBilibiliCdnUrl(value: string): value is string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && [".bilivideo.com", ".bilivideo.cn", ".hdslb.com"].some(suffix => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function subtitleTracks(data: unknown): SubtitleTrack[] {
  const body = recordOf(data);
  return arrayOf(body.tracks).map(value => {
    const item = recordOf(value);
    return {
      lan: textOf(item.lan),
      lanDoc: textOf(item.lan_doc, textOf(item.lan)),
    };
  }).filter(track => track.lan);
}

function subtitleCues(data: unknown): SubtitleCue[] {
  const body = recordOf(data);
  return arrayOf(body.cues).map(value => {
    const item = recordOf(value);
    return { from: numberOf(item.from), to: numberOf(item.to), content: textOf(item.content) };
  }).filter(cue => cue.content);
}

function commentsFrom(data: unknown): VideoComment[] {
  const body = recordOf(data);
  return arrayOf(body.replies).map(value => {
    const item = recordOf(value);
    const member = recordOf(item.member);
    const content = recordOf(item.content);
    const timestamp = numberOf(item.ctime);
    return {
      id: idOf(item.rpid) ?? `${textOf(member.mid)}:${timestamp}:${textOf(content.message)}`,
      mid: idOf(member.mid ?? item.mid),
      uname: textOf(member.uname, "匿名用户"),
      message: textOf(content.message, textOf(item.message, "（无内容）")),
      like: numberOf(item.like),
      replyCount: numberOf(item.rcount),
      time: timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN") : "",
    };
  });
}

function seconds(value: number) {
  const minute = Math.floor(Math.max(0, value) / 60);
  const second = Math.floor(Math.max(0, value) % 60);
  return `${minute}:${String(second).padStart(2, "0")}`;
}

function DetailHeader({ title, meta, sourceUrl, authorId, onBack, onOpenAuthor }: {
  title: string; meta: string; sourceUrl: string; authorId?: string | null;
  onBack?: () => void; onOpenAuthor?: (mid: string) => void;
}) {
  return <View style={kit.between}>
    <View style={kit.row}>
      {onBack ? <SmallButton label="返回" onPress={onBack}><ArrowLeft size={14} color={color.text} /></SmallButton> : null}
      <View style={{ gap: 4 }}><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={kit.muted}>{meta}</Text></View>
    </View>
    <View style={kit.row}>
      <SmallButton label="打开 B 站" onPress={() => void Linking.openURL(sourceUrl).catch(() => undefined)}><ExternalLink size={14} color={color.text} /></SmallButton>
      {authorId && onOpenAuthor ? <SmallButton label="查看作者" onPress={() => onOpenAuthor(authorId)}><UserRound size={14} color={color.text} /></SmallButton> : null}
    </View>
  </View>;
}

function PlaybackPanel({ title, cover, pages, selectedPart, page, playback, loading, error, directStream, directPlaybackFailed, playerUrl, onSelectPart, onReload, onDirectError }: {
  title: string; cover: string | null; pages: BilibiliPage[]; selectedPart: number; page: BilibiliPage | null;
  playback: PlaybackData | null; loading: boolean; error: string; directStream: string | null; directPlaybackFailed: boolean;
  playerUrl: string; onSelectPart: (value: number) => void; onReload: () => void; onDirectError: () => void;
}) {
  const stream = directPlaybackFailed ? null : directStream;
  return <Panel title="播放" subtitle={page ? `当前 ${page.part || `P${selectedPart + 1}`}` : "没有可播放的分 P"}
    extra={<SmallButton label="重新读取播放地址" disabled={loading || !page} onPress={onReload}><RefreshCw size={14} color={color.text} /></SmallButton>}>
    {pages.length > 1 ? <Tabs value={String(selectedPart)} options={pages.map((part, index) => ({ value: String(index), label: part.part || `P${index + 1}` }))} onChange={value => onSelectPart(Number(value))} /> : null}
    {loading ? <Loading label="正在读取当前分 P 的播放地址" /> : error ? <ErrorLine text={error} onRetry={onReload} /> : stream
      ? <video aria-label={`${title}，视频播放`} controls playsInline poster={cover ?? undefined} src={stream} style={videoStyle} onError={onDirectError} />
      : Platform.OS === "web" ? <iframe title="B 站官方播放器" src={playerUrl} allowFullScreen style={frameStyle} />
      : <View style={styles.playerFallback}><Play size={22} color={color.accent} /><Text style={kit.body}>当前播放地址需要 B 站官方播放器，请点击“打开 B 站”。</Text></View>}
    {playback && (!directStream || directPlaybackFailed) ? <Text style={kit.muted}>{directPlaybackFailed ? "直链播放失败，已切换到 B 站官方播放器。" : "使用 B 站官方播放器。"}</Text> : null}
  </Panel>;
}

function SubtitlePanel({ tracks, selectedLanguage, cues, loading, error, hasPage, onLoad, onSelect }: {
  tracks: SubtitleTrack[] | null; selectedLanguage: string | null; cues: SubtitleCue[]; loading: boolean; error: string;
  hasPage: boolean; onLoad: (language?: string) => void; onSelect: (language: string) => void;
}) {
  return <Panel title="字幕" subtitle={tracks?.length ? `${tracks.length} 条轨道` : undefined}
    extra={<SmallButton label="读取字幕" disabled={loading || !hasPage} onPress={() => onLoad()} />}>
    {error ? <ErrorLine text={error} onRetry={() => onLoad(selectedLanguage ?? undefined)} /> : null}
    {loading ? <Loading label="正在读取字幕" /> : tracks?.length ? <View style={styles.trackList}>{tracks.map(track => <View key={track.lan} style={styles.trackRow}>
      <View style={{ flex: 1, gap: 2 }}><Text style={kit.body}>{track.lanDoc}</Text><Text style={kit.muted}>{track.lan}</Text></View>
      <SmallButton label={selectedLanguage === track.lan ? "已选择" : "读取时间轴"} disabled={loading} onPress={() => onSelect(track.lan)} />
    </View>)}</View> : tracks ? <Text style={kit.muted}>当前分 P 没有可读取的字幕。</Text> : null}
    {selectedLanguage ? <View style={styles.cueList}>{cues.length ? cues.map((cue, index) => <View key={`${cue.from}:${index}`} style={styles.cueRow}>
      <Text style={styles.cueTime}>{seconds(cue.from)}</Text><Text style={kit.body}>{cue.content}</Text>
    </View>) : <Empty text="这条字幕轨道没有可显示的时间轴。" small />}</View> : null}
  </Panel>;
}

function CommentRow({ comment, expanded, replies, loading, onReplies }: {
  comment: VideoComment; expanded: boolean; replies?: VideoComment[]; loading: boolean; onReplies: () => void;
}) {
  return <View style={styles.comment}>
    <View style={kit.between}><Text style={kit.strong}>{comment.uname}</Text><Text style={kit.muted}>{comment.time}</Text></View>
    <Text selectable style={kit.body}>{comment.message}</Text>
    <View style={kit.row}><Text style={kit.muted}>赞 {comment.like.toLocaleString("zh-CN")}</Text>
      {comment.replyCount ? <SmallButton label={`${expanded ? "收起" : "查看"} ${comment.replyCount} 条回复`} disabled={loading} onPress={onReplies}><MessageCircle size={14} color={color.text} /></SmallButton> : null}
    </View>
    {expanded ? <View style={styles.replies}>{replies?.length ? replies.map(reply => <View key={reply.id} style={styles.reply}>
      <Text style={kit.strong}>{reply.uname}</Text><Text style={kit.body}>{reply.message}</Text>
    </View>) : <Text style={kit.muted}>{loading ? "正在读取楼中楼…" : "暂无楼中楼。"}</Text>}</View> : null}
  </View>;
}

function CommentsPanel({ comments, commentsPage, commentsTotal, sort, loading, error, expandedComment, replies, repliesLoading, commentText, writeBusy, onSort, onRefresh, onRetry, onPage, onReplies, onText, onSubmit }: {
  comments: VideoComment[]; commentsPage: number; commentsTotal: number; sort: "hot" | "time"; loading: boolean; error: string;
  expandedComment: string | null; replies: Record<string, VideoComment[]>; repliesLoading: string | null; commentText: string; writeBusy: boolean;
  onSort: (value: "hot" | "time") => void; onRefresh: () => void; onRetry: () => void; onPage: (page: number) => void;
  onReplies: (comment: VideoComment) => void; onText: (value: string) => void; onSubmit: () => void;
}) {
  return <Panel title="评论" subtitle={commentsTotal ? `共 ${commentsTotal.toLocaleString("zh-CN")} 条` : undefined}
    extra={<View style={kit.row}><Tabs value={sort} options={[{ value: "hot", label: "最热" }, { value: "time", label: "最新" }]} onChange={onSort} /><SmallButton label="刷新评论" disabled={loading} onPress={onRefresh} /></View>}>
    {error ? <ErrorLine text={error} onRetry={onRetry} /> : null}
    {loading ? <Loading label="正在读取评论" /> : comments.length ? <View style={styles.commentList}>{comments.map(comment => <CommentRow key={comment.id} comment={comment}
      expanded={expandedComment === comment.id} replies={replies[comment.id]} loading={repliesLoading === comment.id} onReplies={() => onReplies(comment)} />)}</View> : <Empty text="暂时没有读取到评论。" small />}
    {commentsTotal > PAGE_SIZE ? <View style={kit.between}><SmallButton label="上一页" disabled={commentsPage <= 1 || loading} onPress={() => onPage(commentsPage - 1)} /><Text style={kit.muted}>第 {commentsPage} 页</Text><SmallButton label="下一页" disabled={loading || commentsPage * PAGE_SIZE >= commentsTotal} onPress={() => onPage(commentsPage + 1)} /></View> : null}
    <View style={styles.commentComposer}><TextInput value={commentText} onChangeText={onText} placeholder="写一条评论" placeholderTextColor={color.textMuted} style={styles.commentInput} multiline accessibilityLabel="B 站评论内容" />
      <SmallButton label={writeBusy ? "发送中…" : "发表评论"} disabled={!commentText.trim() || writeBusy} onPress={onSubmit}><Send size={14} color={color.text} /></SmallButton>
    </View>
  </Panel>;
}

function InteractionPanel({ stats, authorId, liked, followed, busy, error, onLike, onFollow }: {
  stats: BilibiliItem["stats"]; authorId: string | null; liked: boolean | null; followed: boolean | null; busy: boolean; error: string;
  onLike: () => void; onFollow: () => void;
}) {
  const likeLabel = liked === true ? "已点赞（撤销）" : liked === false ? "点赞" : "点赞（状态未知）";
  const followLabel = followed === true ? "已关注（取消）" : followed === false ? "关注作者" : "关注作者（状态未知）";
  return <Panel title="互动" subtitle="点赞、关注会调用当前 B 站登录账号；只有点击按钮时才写入">
    <View style={kit.row}><SmallButton label={likeLabel} disabled={busy} onPress={onLike}><Heart size={14} color={liked === true ? color.accent : color.text} fill={liked === true ? color.accent : "transparent"} /></SmallButton>
      {authorId ? <SmallButton label={followLabel} disabled={busy} onPress={onFollow}><UserRound size={14} color={followed === true ? color.accent : color.text} /></SmallButton> : null}
      <Text style={kit.muted}>视频赞 {stats.likeCount == null ? "—" : stats.likeCount.toLocaleString("zh-CN")} · 评论 {stats.commentCount == null ? "—" : stats.commentCount.toLocaleString("zh-CN")}</Text>
    </View>
    {error ? <ErrorLine text={error} /> : null}
  </Panel>;
}

export function BilibiliVideoDetail({ connection, accountId, bvid, onOpenAuthor, onBack }: BilibiliVideoDetailProps) {
  const [detail, setDetail] = useState<BilibiliDetailItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [selectedPart, setSelectedPart] = useState(0);
  const [playback, setPlayback] = useState<PlaybackData | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [tracks, setTracks] = useState<SubtitleTrack[] | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [subtitleLoading, setSubtitleLoading] = useState(false);
  const [subtitleError, setSubtitleError] = useState("");
  const [comments, setComments] = useState<VideoComment[]>([]);
  const [commentsPage, setCommentsPage] = useState(1);
  const [commentsTotal, setCommentsTotal] = useState(0);
  const [commentsSort, setCommentsSort] = useState<"hot" | "time">("hot");
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState("");
  const [expandedComment, setExpandedComment] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, VideoComment[]>>({});
  const [repliesLoading, setRepliesLoading] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [writeBusy, setWriteBusy] = useState<"like" | "follow" | "comment" | null>(null);
  const [liked, setLiked] = useState<boolean | null>(null);
  const [followed, setFollowed] = useState<boolean | null>(null);
  const [writeError, setWriteError] = useState("");
  const requestsRef = useRef<Set<AbortController>>(new Set());
  const playbackRequestRef = useRef<AbortController | null>(null);
  const playbackKeyRef = useRef("");
  const subtitleRequestRef = useRef<AbortController | null>(null);
  const subtitleKeyRef = useRef("");
  const [directPlaybackFailed, setDirectPlaybackFailed] = useState(false);

  const pages = detailPages(detail);
  const page = pages[selectedPart] ?? null;
  const sourceUrl = detail?.url || `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
  const directStream = streamUrl(playback);
  const playerUrl = officialPlayerUrl(detail?.bvid || bvid, selectedPart);
  const currentPartKey = `${detail?.bvid || bvid}:${page?.cid ?? "none"}`;

  const runWithController = useCallback(async <T,>(controller: AbortController, task: (signal: AbortSignal) => Promise<T>) => {
    requestsRef.current.add(controller);
    try {
      return await task(controller.signal);
    } finally {
      requestsRef.current.delete(controller);
    }
  }, []);
  const runRead = useCallback(async <T,>(task: (signal: AbortSignal) => Promise<T>) => runWithController(new AbortController(), task), [runWithController]);

  useEffect(() => {
    setDetail(null); setDetailLoading(true); setDetailError(""); setSelectedPart(0);
    setPlayback(null); setPlaybackError(""); setTracks(null); setCues([]); setSelectedLanguage(null);
    setComments([]); setCommentsPage(1); setCommentsTotal(0); setCommentsError(""); setReplies({});
    playbackRequestRef.current?.abort(); playbackRequestRef.current = null;
    subtitleRequestRef.current?.abort(); subtitleRequestRef.current = null;
    setDirectPlaybackFailed(false); setLiked(null); setFollowed(null); setWriteError("");
    void runRead(signal => getBilibiliDetail(connection, accountId, bvid, signal)).then(value => {
      setDetail(value as BilibiliDetailItem); setDetailLoading(false);
    }, error => {
      if (isAbortError(error)) return;
      setDetailError(messageOf(error, "视频详情读取失败，请重试。")); setDetailLoading(false);
    });
    return () => {
      playbackRequestRef.current?.abort(); playbackRequestRef.current = null;
      subtitleRequestRef.current?.abort(); subtitleRequestRef.current = null;
      for (const controller of requestsRef.current) controller.abort();
    };
  }, [accountId, bvid, connection, runRead]);

  const loadPlayback = useCallback(() => {
    if (!page) return;
    const partKey = `${detail?.bvid || bvid}:${page.cid}`;
    playbackRequestRef.current?.abort();
    const controller = new AbortController();
    playbackRequestRef.current = controller;
    playbackKeyRef.current = partKey;
    setPlaybackLoading(true); setPlaybackError(""); setPlayback(null);
    setDirectPlaybackFailed(false);
    void runWithController(controller, signal => callBilibiliProtocol(connection, accountId, "playback", { bvid: detail?.bvid || bvid, cid: page.cid }, signal)).then(result => {
      if (playbackRequestRef.current !== controller || playbackKeyRef.current !== partKey) return;
      setPlayback(recordOf(result.data)); setPlaybackLoading(false);
    }, error => {
      if (isAbortError(error) || playbackRequestRef.current !== controller || playbackKeyRef.current !== partKey) return;
      setPlaybackError(messageOf(error, "当前分 P 的播放地址读取失败。")); setPlaybackLoading(false);
    }).finally(() => {
      if (playbackRequestRef.current === controller) playbackRequestRef.current = null;
    });
  }, [accountId, bvid, connection, detail?.bvid, page, runWithController]);

  useEffect(() => {
    playbackRequestRef.current?.abort(); playbackRequestRef.current = null;
    subtitleRequestRef.current?.abort(); subtitleRequestRef.current = null;
    playbackKeyRef.current = currentPartKey;
    subtitleKeyRef.current = currentPartKey;
    setDirectPlaybackFailed(false);
    if (!detail || !page) return;
    setPlayback(null); setPlaybackError(""); setTracks(null); setCues([]); setSelectedLanguage(null); setSubtitleError("");
    loadPlayback();
  }, [currentPartKey, detail, page, loadPlayback]);

  const loadComments = useCallback((nextPage = 1, sort = commentsSort) => {
    setCommentsLoading(true); setCommentsError("");
    void runRead(signal => callBilibiliProtocol(connection, accountId, "comments", { bvid: detail?.bvid || bvid, page: nextPage, pageSize: PAGE_SIZE, sort }, signal)).then(result => {
      const body = recordOf(result.data);
      setComments(commentsFrom(body));
      setCommentsTotal(numberOf(body.total, numberOf(recordOf(body.page).count)));
      setCommentsPage(nextPage);
      setCommentsLoading(false);
    }, error => {
      if (isAbortError(error)) return;
      setCommentsError(messageOf(error, "评论读取失败，请重试。")); setCommentsLoading(false);
    });
  }, [accountId, bvid, commentsSort, connection, detail?.bvid, runRead]);

  useEffect(() => {
    if (detail) loadComments(1, commentsSort);
  }, [detail?.bvid, commentsSort, loadComments]);

  const loadSubtitles = useCallback((language?: string) => {
    if (!page) return;
    const subtitleKey = `${detail?.bvid || bvid}:${page.cid}:${language ?? "tracks"}`;
    subtitleRequestRef.current?.abort();
    const controller = new AbortController();
    subtitleRequestRef.current = controller;
    subtitleKeyRef.current = subtitleKey;
    setSubtitleLoading(true); setSubtitleError("");
    if (!language) { setSelectedLanguage(null); setCues([]); }
    const input = { bvid: detail?.bvid || bvid, cid: page.cid, ...(language ? { language } : {}) };
    void runWithController(controller, signal => callBilibiliProtocol(connection, accountId, "subtitles", input, signal)).then(result => {
      if (subtitleRequestRef.current !== controller || subtitleKeyRef.current !== subtitleKey) return;
      const nextTracks = subtitleTracks(result.data);
      setTracks(nextTracks);
      if (language) { setSelectedLanguage(language); setCues(subtitleCues(result.data)); }
      setSubtitleLoading(false);
    }, error => {
      if (isAbortError(error) || subtitleRequestRef.current !== controller || subtitleKeyRef.current !== subtitleKey) return;
      setSubtitleError(messageOf(error, "字幕读取失败，请重试。")); setSubtitleLoading(false);
    }).finally(() => {
      if (subtitleRequestRef.current === controller) subtitleRequestRef.current = null;
    });
  }, [accountId, bvid, connection, detail?.bvid, page, runWithController]);

  const loadReplies = (comment: VideoComment) => {
    if (!comment.id || repliesLoading) return;
    if (expandedComment === comment.id) { setExpandedComment(null); return; }
    setExpandedComment(comment.id); setRepliesLoading(comment.id);
    void runRead(signal => callBilibiliProtocol(connection, accountId, "comment-replies", {
      bvid: detail?.bvid || bvid, root: comment.id, page: 1, pageSize: PAGE_SIZE,
    }, signal)).then(result => {
      setReplies(current => ({ ...current, [comment.id]: commentsFrom(result.data) })); setRepliesLoading(null);
    }, error => {
      if (isAbortError(error)) return;
      setCommentsError(messageOf(error, "楼中楼读取失败，请重试。")); setRepliesLoading(null);
    });
  };

  const interact = async (action: "like" | "follow" | "comment", input: Record<string, unknown>) => {
    if (writeBusy) return;
    setWriteBusy(action); setWriteError("");
    try {
      await callBilibiliProtocol(connection, accountId, "interact", { action, ...input } as BilibiliProtocolInputs["interact"]);
      if (action === "like") setLiked(Boolean(input.enabled));
      if (action === "follow") setFollowed(Boolean(input.enabled));
      if (action === "comment") { setCommentText(""); loadComments(1, commentsSort); }
    } catch (error) { setWriteError(messageOf(error, "操作没有完成，请重试。")); }
    finally { setWriteBusy(null); }
  };

  const saveItem = useMemo(() => ({
    platform: "bilibili" as const,
    accountId,
    contentId: detail?.bvid || bvid,
    title: detail?.title || bvid,
    body: detail?.description ?? null,
    author: detail?.author ?? null,
    url: sourceUrl,
    coverUrl: detail?.cover ?? null,
    mediaType: "video",
  }), [accountId, bvid, detail, sourceUrl]);

  const header = <DetailHeader
    title={detail?.title || bvid}
    meta={detail ? [detail.bvid, detail.author, detail.publishedAt ? `发布于 ${new Date(detail.publishedAt).toLocaleDateString("zh-CN")}` : ""].filter(Boolean).join(" · ") : bvid}
    sourceUrl={sourceUrl}
    authorId={detail?.authorId}
    onBack={onBack}
    onOpenAuthor={onOpenAuthor}
  />;
  const retryDetail = () => {
    setDetailLoading(true); setDetailError("");
    void runRead(signal => getBilibiliDetail(connection, accountId, bvid, signal)).then(value => {
      setDetail(value as BilibiliDetailItem); setDetailLoading(false);
    }, error => {
      if (isAbortError(error)) return;
      setDetailError(messageOf(error, "视频详情读取失败，请重试。")); setDetailLoading(false);
    });
  };

  if (detailLoading) return <View style={[styles.root, styles.stateRoot]}>{header}<Loading label="正在读取 B 站视频详情" /></View>;
  if (detailError || !detail) return <View style={[styles.root, styles.stateRoot]}>{header}<ErrorLine text={detailError || "没有找到这个视频。"} onRetry={retryDetail} /></View>;

  return <ScrollView testID="bilibili-video-detail" style={styles.root} contentContainerStyle={styles.content}>
    {header}

    <View style={styles.hero}>
      {detail.cover ? <Image source={{ uri: detail.cover }} style={styles.cover} resizeMode="cover" /> : null}
      <View style={styles.heroCopy}><Text style={kit.body}>{detail.description || "这个视频没有可显示的简介。"}</Text><Text style={kit.muted}>视频源：{sourceUrl}</Text><SaveContentControl connection={connection} item={saveItem} /></View>
    </View>

    <PlaybackPanel title={detail.title} cover={detail.cover} pages={pages} selectedPart={selectedPart} page={page} playback={playback}
      loading={playbackLoading} error={playbackError} directStream={directStream} directPlaybackFailed={directPlaybackFailed} playerUrl={playerUrl}
      onSelectPart={setSelectedPart} onReload={loadPlayback} onDirectError={() => setDirectPlaybackFailed(true)} />
    <SubtitlePanel tracks={tracks} selectedLanguage={selectedLanguage} cues={cues} loading={subtitleLoading} error={subtitleError} hasPage={Boolean(page)} onLoad={loadSubtitles} onSelect={loadSubtitles} />
    <CommentsPanel comments={comments} commentsPage={commentsPage} commentsTotal={commentsTotal} sort={commentsSort} loading={commentsLoading} error={commentsError}
      expandedComment={expandedComment} replies={replies} repliesLoading={repliesLoading} commentText={commentText} writeBusy={writeBusy === "comment"}
      onSort={setCommentsSort} onRefresh={() => loadComments(commentsPage, commentsSort)} onRetry={() => loadComments(commentsPage, commentsSort)} onPage={nextPage => loadComments(nextPage, commentsSort)}
      onReplies={loadReplies} onText={setCommentText} onSubmit={() => void interact("comment", { bvid: detail.bvid, text: commentText.trim() })} />
    <InteractionPanel stats={detail.stats} authorId={detail.authorId} liked={liked} followed={followed} busy={Boolean(writeBusy)} error={writeError}
      onLike={() => void interact("like", { bvid: detail.bvid, enabled: liked !== true })} onFollow={() => void interact("follow", { mid: detail.authorId, enabled: followed !== true })} />
  </ScrollView>;
}

const videoStyle = { display: "block", width: "100%", height: "min(65vh, 520px)", backgroundColor: "#000", objectFit: "contain" } as const;
const frameStyle = { border: 0, display: "block", width: "100%", height: "min(65vh, 520px)", background: "#000" } as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  stateRoot: { padding: 28, gap: 18 },
  content: { maxWidth: 1100, width: "100%", alignSelf: "center", padding: 28, gap: 18 },
  title: { color: color.text, fontSize: 22, fontWeight: "700", maxWidth: 760 },
  hero: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: 16, padding: 16, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  cover: { width: 260, height: 146, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  heroCopy: { flex: 1, minWidth: 280, gap: 10 },
  playerFallback: { minHeight: 260, alignItems: "center", justifyContent: "center", gap: 10, padding: 22, backgroundColor: color.surfaceRaised },
  trackList: { gap: 4 },
  trackRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  cueList: { marginTop: 10, maxHeight: 340, overflow: "scroll" as const, borderTopWidth: 1, borderTopColor: color.borderSoft },
  cueRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  cueTime: { width: 48, color: color.accent, fontSize: 12, fontVariant: ["tabular-nums"] },
  commentList: { gap: 2 },
  comment: { gap: 7, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  replies: { gap: 8, marginLeft: 20, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: color.border },
  reply: { gap: 3, paddingVertical: 5 },
  commentComposer: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: 12 },
  commentInput: { flex: 1, minHeight: 42, maxHeight: 120, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, color: color.text, backgroundColor: color.canvas },
});
