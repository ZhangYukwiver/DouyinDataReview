import React, { memo, useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { ArrowUp, ArrowUpRight, Bookmark, ChevronDown, ChevronUp, Forward, Heart, Link, MessageCircle, Music2, Pause, Play, Search, Smile, Volume2, VolumeX, X } from "lucide-react-native";
import { CHAT_EMOJI, splitChatEmoji } from "../../domain/chatEmoji";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreComment, ExploreConnection, ExploreOutcome, ExplorePage, ExploreSharee } from "../../services/explorer";
import { buildVideoFeed, createVideoCommentsSession, createVideoShareSession, createVideoWheelGesture, waitForCollector } from "../../services/videoFeed";
import { LocalCollectorError } from "../../services/localCollector";
import "./RecordVideoPlayer.css";

/** Resolves to a stream URL that stays valid until `signal` aborts. */
export type RecordVideoLoader = (record: PersonalVideoRecord, signal: AbortSignal, onProgress?: (message: string) => void) => Promise<string>;
const count = (value?: number | null) => value == null ? "—" : value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/u, "")}万` : value.toLocaleString("zh-CN");
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN") : "";
// 评论和文案里的小表情以 [捂脸] 这样的文字代码传输，用聊天页同一份字典换成行内小图，没收录的原样显示。
const EmojiText = ({ text }: { text: string }) => <>{splitChatEmoji(text).map((part, index) => "emoji" in part
  ? <img className="rv-emoji" key={index} src={part.url} alt={part.emoji} title={part.emoji} referrerPolicy="no-referrer" draggable={false} />
  : part.text)}</>;

type Props = {
  record: PersonalVideoRecord;
  records?: PersonalVideoRecord[];
  onLoadVideo: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  onOpenRecord?: (url: string) => Promise<void>;
  onClose: () => void;
};

export function RecordVideoPlayer({ record, records, onLoadVideo, commentsConnection = null, onOpenRecord, onClose }: Props) {
  // Freeze the opened list so background collection cannot reorder a playing feed.
  const [feed] = useState(() => buildVideoFeed(records ?? [record], record));
  const [index, setIndex] = useState(() => Math.max(0, feed.findIndex((item) => item.id === record.id)));
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const active = feed[index]!;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; dragged: boolean } | null>(null);
  const suppressClick = useRef(false);
  const move = (direction: number) => setIndex((current) => Math.max(0, Math.min(feed.length - 1, current + direction)));
  const toggleComments = () => {
    setCommentsOpen(!commentsOpen);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(commentsOpen ? '[aria-label="查看评论"]' : '[aria-label="关闭评论"]')?.focus());
  };

  const toggleShare = () => {
    setShareOpen(!shareOpen);
    if (shareOpen) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("[data-share-toggle]")?.focus());
  };
  useEffect(() => { rootRef.current?.focus(); }, []);
  useEffect(() => { setShareOpen(false); }, [index]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const gesture = createVideoWheelGesture();
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        (event.target as Element).closest("[data-feed-controls],[data-comments-panel],[data-share-panel]")) return;
      event.preventDefault();
      const direction = gesture(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.clientHeight : 1), performance.now());
      if (direction) setIndex((current) => Math.max(0, Math.min(feed.length - 1, current + direction)));
    };
    viewer.addEventListener("wheel", wheel, { passive: false });
    return () => viewer.removeEventListener("wheel", wheel);
  }, [feed.length]);

  return <Modal animationType="fade" transparent visible onRequestClose={() => shareOpen ? toggleShare() : commentsOpen ? toggleComments() : onClose()}>
    <div ref={rootRef} className="rv-backdrop" tabIndex={-1} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if ((event.target as Element).closest("input,a,[data-comments-panel],[data-share-panel]")) return;
        if (["ArrowDown", "PageDown", "ArrowUp", "PageUp"].includes(event.key)) {
          event.preventDefault(); move(["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1);
        }
      }}>
      <div className="rv-layout" aria-label="视频播放器" role="dialog" aria-modal="true">
        <div ref={viewerRef} className="rv-viewer"
          onPointerDown={(event) => {
            swipe.current = null;
            suppressClick.current = false;
            const target = event.target as Element;
            if (!event.isPrimary || event.button !== 0 ||
              (target.closest("button,input,a,[data-feed-controls],[data-comments-panel],[data-share-panel]") && !target.closest(".rv-play-overlay"))) return;
            swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
          }}
          onPointerMove={(event) => {
            const start = swipe.current;
            if (!start || start.id !== event.pointerId) return;
            if (event.buttons === 0) { swipe.current = null; return; }
            const dx = event.clientX - start.x, dy = event.clientY - start.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > 10) start.dragged = true;
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.3) {
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }
          }}
          onPointerUp={(event) => {
            const start = swipe.current;
            if (!start || start.id !== event.pointerId) return;
            swipe.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            const dy = start.y - event.clientY;
            // A drag must not also click the video or its paused-play overlay.
            suppressClick.current = start.dragged;
            if (Math.abs(dy) >= 60 && Math.abs(dy) > Math.abs(start.x - event.clientX) * 1.3) {
              suppressClick.current = true;
              event.preventDefault();
              move(dy > 0 ? 1 : -1);
            }
          }}
          onPointerCancel={() => { swipe.current = null; }}
          onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) swipe.current = null;
          }}
          onDragStart={(event) => { if (swipe.current) event.preventDefault(); }}
          onClickCapture={(event) => {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            if (event.detail === 0) return;
            event.preventDefault();
            event.stopPropagation();
          }}>
          {active.coverUrl ? <div className="rv-ambient" style={{ backgroundImage: `url(${JSON.stringify(active.coverUrl)})` }} aria-hidden="true" /> : null}
          {/* The next video mounts hidden so it is resolved and buffering before the switch; anything else unmounts and is released. */}
          {feed.slice(index, index + 2).map((item, offset) => <Playback key={item.id} active={offset === 0} record={item} onLoadVideo={onLoadVideo}
            muted={muted} onToggleMute={() => setMuted((value) => !value)} commentsOpen={commentsOpen} onToggleComments={toggleComments} onOpenRecord={onOpenRecord}
            shareOpen={shareOpen} onToggleShare={toggleShare}
            commentsConnection={commentsConnection} position={`${index + offset + 1} / ${feed.length}`} onClose={onClose} />)}
          <nav className="rv-navigation" aria-label="切换视频">
            <button className="rv-icon-button" aria-label="上一个视频" disabled={index === 0} onClick={() => move(-1)}><ChevronUp color="#fff" size={24} /></button>
            <button className="rv-icon-button" aria-label="下一个视频" disabled={index === feed.length - 1} onClick={() => move(1)}><ChevronDown color="#fff" size={24} /></button>
            <span>{index === feed.length - 1 ? "已到最后" : "上下滑动"}</span>
          </nav>
        </div>
      </div>
    </div>
  </Modal>;
}

function Playback({ active, record, onLoadVideo, muted, onToggleMute, commentsOpen, onToggleComments, shareOpen, onToggleShare, commentsConnection, position, onClose, onOpenRecord }: {
  active: boolean; record: PersonalVideoRecord; onLoadVideo: RecordVideoLoader; muted: boolean; onToggleMute: () => void;
  commentsOpen: boolean; onToggleComments: () => void; shareOpen: boolean; onToggleShare: () => void; commentsConnection: ExploreConnection | null;
  position: string; onClose: () => void; onOpenRecord?: (url: string) => Promise<void>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [readyToPlay, setReadyToPlay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [paused, setPaused] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("正在准备视频…");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loaderRef = useRef(onLoadVideo);
  loaderRef.current = onLoadVideo;
  useEffect(() => {
    const controller = new AbortController();
    const video = videoRef.current;
    const timeout = setTimeout(() => {
      setError("视频准备超时，请重试或切换下一个视频。");
      controller.abort();
    }, 90_000);
    setSrc(null); setReadyToPlay(false); setError(null); setPaused(true); setElapsed(0); setDuration(0);
    setLoadingMessage("正在准备视频…");
    void (async () => {
      try {
        const url = await waitForCollector(() => loaderRef.current(record, controller.signal, (message) => {
          if (!controller.signal.aborted) setLoadingMessage(message);
        }), controller.signal);
        if (controller.signal.aborted) return;
        setLoadingMessage("正在载入画面…");
        setSrc(url);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "视频暂时无法播放，请稍后重试。");
      } finally { clearTimeout(timeout); }
    })();
    return () => {
      // Aborting releases the collector job; detaching the source stops the browser buffering it.
      clearTimeout(timeout); controller.abort();
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    };
  }, [record.id, record.url, attempt]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (active) void video.play().catch(() => {});
    else { video.pause(); video.currentTime = 0; }
  }, [src, active]);
  useEffect(() => { if (error) videoRef.current?.pause(); }, [error]);
  useEffect(() => {
    if (!active || !src || readyToPlay || error) return;
    const timeout = setTimeout(() => setError("视频画面加载超时，请重试或切换下一个视频。"), 15_000);
    return () => clearTimeout(timeout);
  }, [active, src, readyToPlay, error]);
  const toggle = () => {
    const video = videoRef.current;
    if (!src || !readyToPlay || error || !video) return;
    if (video.paused) void video.play().catch(() => setError("无法开始播放，请重试。"));
    else video.pause();
  };

  return <>
    <div className="rv-stage" style={active ? undefined : { display: "none" }} data-testid={active ? "video-feed-stage" : undefined} data-loading={!readyToPlay && !error} onKeyDown={(event) => {
      if (event.code === "Space" && !(event.target as Element).closest("button,input,a")) { event.preventDefault(); toggle(); }
    }}>
      <video ref={videoRef} aria-label={`${record.title}，视频播放`} src={src ?? undefined} poster={record.coverUrl ?? undefined}
        loop playsInline muted={muted} preload="auto" onClick={toggle} tabIndex={0}
        onLoadedData={() => setReadyToPlay(true)}
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={() => setElapsed(videoRef.current?.currentTime ?? 0)}
        onDurationChange={() => { const value = videoRef.current?.duration; setDuration(value && Number.isFinite(value) ? value : 0); }}
        onError={() => { if (src) setError("视频无法播放，请重试或打开抖音原视频。"); }} />
      {(!readyToPlay || error) && record.coverUrl ? <img className="rv-loading-cover" src={record.coverUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <div className="rv-shade" aria-hidden="true" />
      {!readyToPlay || error ? <div className="rv-message" role={error ? "alert" : "status"}>
        {error ? <><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试播放</button>
          {record.url && onOpenRecord ? <button className="rv-text-button" onClick={() => void onOpenRecord(record.url!)}>打开抖音原视频</button> : null}</>
          : <><span className="rv-spinner" /><p>{loadingMessage}</p><small>可随时上下滑动切换视频</small></>}
      </div> : paused ? <button className="rv-play-overlay" aria-label="开始播放" onClick={toggle}><Play color="#fff" fill="#fff" size={48} /></button> : null}
      <header className="rv-topbar">
        <button className="rv-icon-button" aria-label="关闭视频" onClick={onClose}><X color="#fff" size={24} /></button>
        <span className="rv-heading">工作台<span>当前列表</span></span>
        <span className="rv-position" aria-live="polite" aria-label="当前视频序号">{position}</span>
      </header>
      <aside className="rv-actions" aria-label="作品信息与操作">
        <div className="rv-avatar" aria-label={`作者：${record.author ?? "抖音用户"}`}>
          {record.authorAvatarUrl ? <img src={record.authorAvatarUrl} alt="" referrerPolicy="no-referrer" /> : <span>{(record.author ?? "抖").slice(0, 1)}</span>}
        </div>
        <div className="rv-stat" aria-label={`获赞 ${count(record.stats?.diggCount)}`}><Heart color="#fff" fill="#fff" size={31} /><span>{count(record.stats?.diggCount)}</span></div>
        <button className={`rv-stat ${commentsOpen ? "rv-selected" : ""}`} aria-label="查看评论" aria-expanded={commentsOpen} onClick={onToggleComments}>
          <MessageCircle color={commentsOpen ? "#ff2c55" : "#fff"} fill={commentsOpen ? "#ff2c55" : "#fff"} size={31} /><span>{count(record.stats?.commentCount)}</span>
        </button>
        <div className="rv-stat" aria-label={`收藏 ${count(record.stats?.collectCount)}`}><Bookmark color="#fff" fill="#fff" size={29} /><span>{count(record.stats?.collectCount)}</span></div>
        <button className="rv-stat" data-share-toggle aria-label="分享给朋友" aria-expanded={shareOpen} onClick={onToggleShare}>
          <Forward color={shareOpen ? "#ff2c55" : "#fff"} fill={shareOpen ? "#ff2c55" : "#fff"} size={30} /><span>{count(record.stats?.shareCount)}</span>
        </button>
        {record.url && onOpenRecord ? <button className="rv-stat" aria-label="打开抖音原视频" onClick={() => void onOpenRecord(record.url!)}><ArrowUpRight color="#fff" size={32} /><span>原视频</span></button> : null}
      </aside>
      <div className="rv-caption">
        <strong>@{record.author ?? "抖音用户"}</strong>
        <p title={record.title}><EmojiText text={record.title} /></p>
        {record.music?.title ? <div className="rv-music"><Music2 color="#fff" size={15} /><span>{record.music.title}{record.music.author ? ` · ${record.music.author}` : ""}</span></div> : null}
        {record.publishedAt ? <small>{date(record.publishedAt)}</small> : null}
      </div>
      <div className="rv-controls" data-feed-controls>
        <div className="rv-control-row">
          <button className="rv-icon-button" aria-label={paused ? "播放视频" : "暂停视频"} disabled={!readyToPlay || Boolean(error)} onClick={toggle}>
            {paused ? <Play color="#fff" fill="#fff" size={17} /> : <Pause color="#fff" fill="#fff" size={17} />}
          </button>
          <span>{time(elapsed)} / {time(duration)}</span><span className="rv-control-spacer" />
          <button className="rv-icon-button" aria-label={muted ? "开启声音" : "静音"} onClick={onToggleMute}>{muted ? <VolumeX color="#fff" size={21} /> : <Volume2 color="#fff" size={21} />}</button>
        </div>
        <input aria-label="视频进度" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(elapsed, duration || 1)} disabled={!duration}
          onChange={(event) => { if (videoRef.current) { videoRef.current.currentTime = Number(event.target.value); setElapsed(Number(event.target.value)); } }} />
      </div>
      {active && shareOpen ? <VideoShare record={record} connection={commentsConnection} onClose={onToggleShare} /> : null}
    </div>
    {active && commentsOpen ? <VideoComments record={record} connection={commentsConnection} ready={Boolean(src || error)} onClose={onToggleComments} onOpenRecord={onOpenRecord} /> : null}
  </>;
}

const VideoComments = memo(function VideoComments({ record, connection, ready, onClose, onOpenRecord }: {
  record: PersonalVideoRecord; connection: ExploreConnection | null; ready: boolean; onClose: () => void;
  onOpenRecord?: (url: string) => Promise<void>;
}) {
  const [page, setPage] = useState<ExplorePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sessionVersion, setSessionVersion] = useState(0);
  // Posted from this panel: shown at once, top-level first and replies inside their thread.
  const [mine, setMine] = useState<ExploreComment[]>([]);
  const [replyTo, setReplyTo] = useState<ExploreComment | null>(null);
  const sessionRef = useRef<ReturnType<typeof createVideoCommentsSession> | null>(null);
  useEffect(() => {
    const session = connection ? createVideoCommentsSession(connection, record) : null;
    sessionRef.current = session;
    setPage(null); setError(null); setReplyTo(null);
    return () => { session?.close(); sessionRef.current = null; };
  }, [connection?.baseUrl, connection?.token, record.id, sessionVersion]);
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !ready) return;
    let current = true;
    setLoading(true); setError(null);
    void session.read().then((next) => { if (current) setPage(next); }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : "评论读取失败，请稍后重试。");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [connection?.baseUrl, connection?.token, record.id, ready, attempt, sessionVersion]);
  const send = async (text: string): Promise<ExploreOutcome> => {
    const session = sessionRef.current;
    if (!session) throw new Error("评论还没加载好，请稍后再发。");
    const target = replyTo;
    try {
      const outcome = await session.comment(text, target?.id);
      if (outcome.outcome === "confirmed") {
        const posted = outcome.comment;
        // A reply lives in its top-level thread even when it answers another reply.
        if (posted) setMine((list) => [{ ...posted, parentId: target ? posted.parentId ?? target.parentId ?? target.id : null }, ...list]);
        setReplyTo(null);
      }
      return outcome;
    } catch (cause) {
      if (!(cause instanceof LocalCollectorError) || cause.code !== "session_expired") throw cause;
      setSessionVersion((value) => value + 1);
      throw new Error("评论页已经过期，已重新载入，请再发一次。");
    }
  };
  const posted = new Set(mine.map((item) => item.id));
  const threads = [...mine.filter((item) => !item.parentId), ...((page?.items as ExploreComment[] | undefined) ?? []).filter((item) => !posted.has(item.id))];
  const reply = connection && page ? setReplyTo : undefined;
  return <section className="rv-comments" data-comments-panel aria-label="视频评论" onKeyDown={(event) => event.stopPropagation()}>
    <header className="rv-comments-header"><h2>评论 <span>{count(record.stats?.commentCount)}</span></h2>
      <button className="rv-icon-button" aria-label="关闭评论" onClick={onClose}><X color="#fff" size={21} /></button></header>
    <p className="rv-comments-context" title={record.title}>@{record.author ?? "抖音用户"} · <EmojiText text={record.title} /></p>
    <div className="rv-comment-list" tabIndex={0}>
      {!connection ? <p className="rv-comment-notice">连接本地采集器后可查看评论。</p> : null}
      {connection && (!ready || loading) ? <div className="rv-comment-notice" role="status"><span className="rv-spinner" /><p>{ready ? "正在读取评论…" : "视频准备好后读取评论…"}</p></div> : null}
      {error ? <div className="rv-comment-notice" role="alert"><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试评论</button></div> : null}
      {threads.map((comment) => <article className="rv-comment" key={posted.has(comment.id) ? `mine:${comment.id}` : `${page!.sessionId}:${comment.id}`} data-comment-id={comment.id}>
        <CommentRow comment={comment} onReply={reply} />
        {mine.filter((item) => item.parentId === comment.id).map((item) => <article className="rv-reply rv-replies" key={item.id} data-reply-id={item.id}><CommentRow comment={item} onReply={reply} /></article>)}
        {comment.replies > 0 && sessionRef.current ? <CommentReplies comment={comment} session={sessionRef.current} hidden={posted} onReply={reply} onRefresh={() => setSessionVersion((value) => value + 1)} /> : null}
      </article>)}
      {page && !threads.length && !loading && !error ? <p className="rv-comment-notice">暂时没有评论</p> : null}
      {page?.limited ? <p className="rv-comment-notice">已展示 500 条，可在原页继续查看。</p> : page && page.hasMore !== false ?
        <button className="rv-more" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>{loading ? "正在加载…" : "加载更多评论"}</button> : page?.items.length ? <p className="rv-comment-end">已显示全部已返回评论</p> : null}
    </div>
    <footer className="rv-comments-footer">{connection ? <CommentComposer key={record.id} disabled={!page} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={send} />
      : record.url && onOpenRecord ? <button className="rv-more" onClick={() => void onOpenRecord(record.url!)}>在抖音参与讨论 <ArrowUpRight color="#ddd" size={15} /></button> : <span>评论来自抖音公开页面</span>}</footer>
  </section>;
});

function CommentRow({ comment, onReply }: { comment: ExploreComment; onReply?: (comment: ExploreComment) => void }) {
  return <div className="rv-comment-row">
    <div className="rv-comment-avatar">{comment.author?.avatar ? <img src={comment.author.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : comment.name.slice(0, 1)}</div>
    <div className="rv-comment-body"><strong>{comment.name}{comment.replyToName ? <span className="rv-reply-to"> 回复 @{comment.replyToName}</span> : null}</strong>
      {comment.text ? <p><EmojiText text={comment.text} /></p> : !comment.images?.length ? <p>图片或表情评论，请在原页查看</p> : null}
      {comment.images?.map((url) => <img className="rv-comment-image" key={url} src={url} alt="评论图片或表情" referrerPolicy="no-referrer" loading="lazy" />)}
      <div className="rv-comment-meta"><small>{date(comment.publishedAt)}</small>
        {onReply ? <button className="rv-reply-action" aria-label={`回复 ${comment.name}`} onClick={() => onReply(comment)}>回复</button> : null}</div></div>
    <div className="rv-comment-likes" aria-label={`${count(comment.likes)} 个赞`}><Heart color="#929298" size={15} /><span>{count(comment.likes)}</span></div>
  </div>;
}

function CommentReplies({ comment, session, hidden, onReply, onRefresh }: {
  comment: ExploreComment; session: ReturnType<typeof createVideoCommentsSession>; hidden: Set<string>;
  onReply?: (comment: ExploreComment) => void; onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<ExplorePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<{ message: string; refresh: boolean } | null>(null);
  useEffect(() => {
    if (!attempt) return;
    let current = true;
    setLoading(true); setError(null);
    void session.readReplies(comment.id).then((next) => { if (current) setPage(next); }).catch((cause) => {
      if (current) setError({ message: cause instanceof Error ? cause.message : "回复读取失败，请稍后重试。",
        refresh: cause instanceof LocalCollectorError && ["session_expired", "comment_unavailable"].includes(cause.code) });
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [session, comment.id, attempt]);
  return <div className="rv-replies">
    <button className="rv-reply-toggle" aria-expanded={expanded} aria-controls={`rv-replies-${comment.id}`} onClick={() => {
      setExpanded(!expanded);
      if (!expanded && !page && !loading) setAttempt((value) => value + 1);
    }}>
      {expanded ? <ChevronUp size={14} color="#b6b6c0" /> : <ChevronDown size={14} color="#b6b6c0" />}
      {expanded ? "收起回复" : `展开 ${count(comment.replies)} 条回复`}
    </button>
    <div id={`rv-replies-${comment.id}`} hidden={!expanded}>
      {(page?.items as ExploreComment[] | undefined)?.filter((reply) => !hidden.has(reply.id)).map((reply) => <article className="rv-reply" key={reply.id} data-reply-id={reply.id}><CommentRow comment={reply} onReply={onReply} /></article>)}
      {loading ? <p className="rv-reply-notice" role="status">正在读取回复…</p> : null}
      {error ? <div className="rv-reply-notice" role="alert"><p>{error.message}</p><button className="rv-reply-toggle" onClick={error.refresh ? onRefresh : () => setAttempt((value) => value + 1)}>{error.refresh ? "刷新评论" : "重试回复"}</button></div> : null}
      {page && !page.items.length && !loading && !error ? <p className="rv-reply-notice">暂时没有可展示的回复</p> : null}
      {page?.limited ? <p className="rv-reply-notice">已展示 500 条回复，可在原页继续查看。</p> : page && page.hasMore !== false ?
        <button className="rv-reply-toggle" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>加载更多回复</button> : null}
    </div>
  </div>;
}

// 抖音网页的评论框没有换行，回车就发送；粘贴进来的换行按空格处理。
function CommentComposer({ replyTo, disabled, onCancelReply, onSend }: {
  replyTo: ExploreComment | null; disabled: boolean; onCancelReply: () => void; onSend: (text: string) => Promise<ExploreOutcome>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "warn"; message: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (replyTo) inputRef.current?.focus(); }, [replyTo]);
  const content = text.replace(/\s+/gu, " ").trim();
  const send = async () => {
    if (!content || sending || disabled) return;
    setSending(true); setNotice(null); setEmojiOpen(false);
    try {
      const outcome = await onSend(content);
      if (outcome.outcome === "confirmed") setText("");
      else setNotice({ tone: outcome.outcome === "rejected" ? "error" : "warn", message: outcome.message });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setNotice({ tone: "warn", message: cause instanceof Error ? cause.message : "没收到结果，评论可能已经发出去了，先刷新评论看看。" });
    } finally { setSending(false); }
  };
  const insert = (code: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length, end = input?.selectionEnd ?? start;
    setText(text.slice(0, start) + code + text.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + code.length, start + code.length); });
  };
  return <div className="rv-composer">
    {replyTo ? <div className="rv-composer-target"><span>回复 @{replyTo.name}</span>
      <button aria-label="取消回复" onClick={onCancelReply}><X color="#a1a1aa" size={14} /></button></div> : null}
    {emojiOpen ? <div className="rv-emoji-panel" aria-label="表情">{CHAT_EMOJI.map(([code, url]) => <button key={code} aria-label={code} title={code} onClick={() => insert(code)}>
      <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" draggable={false} /></button>)}</div> : null}
    <div className="rv-composer-box">
      <textarea ref={inputRef} rows={1} value={text} maxLength={500} disabled={disabled} readOnly={sending}
        placeholder={disabled ? "评论加载好后就能发" : replyTo ? `回复 @${replyTo.name}` : "留下你的精彩评论吧"} aria-label={replyTo ? `回复 ${replyTo.name}` : "发表评论"}
        onChange={(event) => { setText(event.target.value); setNotice(null); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault(); void send();
        }} />
      <button className="rv-composer-icon" aria-label="表情" aria-expanded={emojiOpen} disabled={disabled} onClick={() => setEmojiOpen(!emojiOpen)}>
        <Smile color={emojiOpen ? "#fe2c55" : "#b8b8c1"} size={20} /></button>
      <button className="rv-composer-send" aria-label={replyTo ? "发送回复" : "发送评论"} disabled={!content || sending || disabled} onClick={() => void send()}>
        {sending ? <span className="rv-spinner rv-spinner-small" /> : <ArrowUp color="#fff" size={16} strokeWidth={3} />}</button>
    </div>
    {notice ? <p className={`rv-composer-notice rv-${notice.tone}`} role="alert">{notice.message}</p> : null}
  </div>;
}

// 和抖音网页的分享面板一样：搜索、分享给朋友（点一下就发私信卡片）、复制链接。
function VideoShare({ record, connection, onClose }: { record: PersonalVideoRecord; connection: ExploreConnection | null; onClose: () => void }) {
  const [page, setPage] = useState<ExplorePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<Record<string, "sending" | "done" | "failed" | "unknown">>({});
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<ReturnType<typeof createVideoShareSession> | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest("[data-share-panel],[data-share-toggle]")) closeRef.current(); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, []);
  useEffect(() => {
    if (!connection) return;
    const session = createVideoShareSession(connection, record);
    sessionRef.current = session;
    let current = true;
    setPage(null); setError(null);
    void session.read().then((next) => { if (current) setPage(next); }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : "朋友列表读取失败，请稍后重试。");
    });
    return () => { current = false; session.close(); sessionRef.current = null; };
  }, [connection?.baseUrl, connection?.token, record.id, attempt]);
  const share = async (person: ExploreSharee) => {
    const session = sessionRef.current;
    if (!session) return;
    setSent((value) => ({ ...value, [person.id]: "sending" })); setNotice(null);
    try {
      const outcome = await session.share(person.id);
      setSent((value) => ({ ...value, [person.id]: outcome.outcome === "confirmed" ? "done" : outcome.outcome === "rejected" ? "failed" : "unknown" }));
      setNotice(outcome.outcome === "confirmed" ? `已分享给 ${person.name}` : outcome.message);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      const expired = cause instanceof LocalCollectorError && cause.code === "session_expired";
      setSent(({ [person.id]: _, ...rest }) => expired ? rest : { ...rest, [person.id]: "unknown" });
      setNotice(expired ? "朋友列表过期了，已重新载入，请再点一次。" : cause instanceof Error ? cause.message : "没收到结果，可能已经分享出去了，先去聊天里看看。");
      if (expired) setAttempt((value) => value + 1);
    }
  };
  const copy = async () => {
    const url = record.url!;
    // 内嵌浏览器可能不给剪贴板权限，退回到选中文字再复制的老办法。
    const fallback = () => {
      const area = Object.assign(document.createElement("textarea"), { value: url });
      document.body.append(area); area.select();
      const copied = document.execCommand("copy"); area.remove();
      return copied;
    };
    const copied = await navigator.clipboard.writeText(url).then(() => true, fallback);
    setNotice(copied ? "链接已复制" : "没能复制，请在抖音原页复制链接。");
  };
  const people = (page?.items as ExploreSharee[] | undefined) ?? [];
  const keyword = query.trim().toLocaleLowerCase();
  const shown = keyword ? people.filter((person) => person.name.toLocaleLowerCase().includes(keyword)) : people;
  return <section className="rv-share" data-share-panel role="dialog" aria-label="分享给朋友" onKeyDown={(event) => event.stopPropagation()}>
    <label className="rv-share-search"><Search color="#8a8a94" size={15} />
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索朋友" /></label>
    <p className="rv-share-title">分享给朋友</p>
    <div className="rv-share-list">
      {!connection ? <p className="rv-share-notice">连接本地采集器后可以分享给朋友。</p>
        : error ? <div className="rv-share-notice" role="alert"><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
          : !page ? <div className="rv-share-notice" role="status"><span className="rv-spinner" /><p>正在读取朋友列表…</p></div>
            : !shown.length ? <p className="rv-share-notice">{keyword ? "没有搜索到朋友" : "暂时没有可以分享的朋友"}</p> : null}
      {shown.map((person) => {
        const state = sent[person.id] ?? (person.shared ? "done" : undefined);
        return <div className="rv-share-row" key={person.id}>
          <span className="rv-share-avatar">{person.avatar ? <img src={person.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : person.name.slice(0, 1)}</span>
          <span className="rv-share-name" title={person.name}>{person.name}</span>
          <button className={`rv-share-button${state === "done" || state === "unknown" ? " rv-share-muted" : ""}`} aria-label={`分享给 ${person.name}`}
            disabled={Boolean(state && state !== "failed")} onClick={() => void share(person)}>
            {state === "sending" ? "发送中" : state === "done" ? "已分享" : state === "unknown" ? "待确认" : state === "failed" ? "重试" : "分享"}</button>
        </div>;
      })}
    </div>
    {notice ? <p className="rv-share-status" role="status">{notice}</p> : null}
    <footer className="rv-share-footer"><button className="rv-share-copy" disabled={!record.url} onClick={() => void copy()}><Link color="#ddd" size={15} />复制链接</button></footer>
  </section>;
}
