import React, { memo, useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { ArrowUpRight, Bookmark, ChevronDown, ChevronUp, Heart, MessageCircle, Music2, Pause, Play, Volume2, VolumeX, X } from "lucide-react-native";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreComment, ExploreConnection, ExplorePage } from "../../services/explorer";
import { buildVideoFeed, createVideoCommentsSession, createVideoWheelGesture, waitForCollector } from "../../services/videoFeed";
import { LocalCollectorError } from "../../services/localCollector";
import "./RecordVideoPlayer.css";

/** Resolves to a stream URL that stays valid until `signal` aborts. */
export type RecordVideoLoader = (record: PersonalVideoRecord, signal: AbortSignal, onProgress?: (message: string) => void) => Promise<string>;
const count = (value?: number | null) => value == null ? "—" : value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/u, "")}万` : value.toLocaleString("zh-CN");
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN") : "";

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

  useEffect(() => { rootRef.current?.focus(); }, []);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const gesture = createVideoWheelGesture();
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        (event.target as Element).closest("[data-feed-controls],[data-comments-panel]")) return;
      event.preventDefault();
      const direction = gesture(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.clientHeight : 1), performance.now());
      if (direction) setIndex((current) => Math.max(0, Math.min(feed.length - 1, current + direction)));
    };
    viewer.addEventListener("wheel", wheel, { passive: false });
    return () => viewer.removeEventListener("wheel", wheel);
  }, [feed.length]);

  return <Modal animationType="fade" transparent visible onRequestClose={() => commentsOpen ? toggleComments() : onClose()}>
    <div ref={rootRef} className="rv-backdrop" tabIndex={-1} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if ((event.target as Element).closest("input,a,[data-comments-panel]")) return;
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
              (target.closest("button,input,a,[data-feed-controls],[data-comments-panel]") && !target.closest(".rv-play-overlay"))) return;
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

function Playback({ active, record, onLoadVideo, muted, onToggleMute, commentsOpen, onToggleComments, commentsConnection, position, onClose, onOpenRecord }: {
  active: boolean; record: PersonalVideoRecord; onLoadVideo: RecordVideoLoader; muted: boolean; onToggleMute: () => void;
  commentsOpen: boolean; onToggleComments: () => void; commentsConnection: ExploreConnection | null;
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
        {record.url && onOpenRecord ? <button className="rv-stat" aria-label="打开抖音原视频" onClick={() => void onOpenRecord(record.url!)}><ArrowUpRight color="#fff" size={32} /><span>原视频</span></button> : null}
      </aside>
      <div className="rv-caption">
        <strong>@{record.author ?? "抖音用户"}</strong>
        <p title={record.title}>{record.title}</p>
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
  const sessionRef = useRef<ReturnType<typeof createVideoCommentsSession> | null>(null);
  useEffect(() => {
    const session = connection ? createVideoCommentsSession(connection, record) : null;
    sessionRef.current = session;
    setPage(null); setError(null);
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
  return <section className="rv-comments" data-comments-panel aria-label="视频评论" onKeyDown={(event) => event.stopPropagation()}>
    <header className="rv-comments-header"><h2>评论 <span>{count(record.stats?.commentCount)}</span></h2>
      <button className="rv-icon-button" aria-label="关闭评论" onClick={onClose}><X color="#fff" size={21} /></button></header>
    <p className="rv-comments-context" title={record.title}>@{record.author ?? "抖音用户"} · {record.title}</p>
    <div className="rv-comment-list" tabIndex={0}>
      {!connection ? <p className="rv-comment-notice">连接本地采集器后可查看评论。</p> : null}
      {connection && (!ready || loading) ? <div className="rv-comment-notice" role="status"><span className="rv-spinner" /><p>{ready ? "正在读取评论…" : "视频准备好后读取评论…"}</p></div> : null}
      {error ? <div className="rv-comment-notice" role="alert"><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试评论</button></div> : null}
      {(page?.items as ExploreComment[] | undefined)?.map((comment) => <article className="rv-comment" key={`${page!.sessionId}:${comment.id}`} data-comment-id={comment.id}>
        <CommentRow comment={comment} />
        {comment.replies > 0 && sessionRef.current ? <CommentReplies comment={comment} session={sessionRef.current} onRefresh={() => setSessionVersion((value) => value + 1)} /> : null}
      </article>)}
      {page && !page.items.length && !loading && !error ? <p className="rv-comment-notice">暂时没有评论</p> : null}
      {page?.limited ? <p className="rv-comment-notice">已展示 500 条，可在原页继续查看。</p> : page && page.hasMore !== false ?
        <button className="rv-more" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>{loading ? "正在加载…" : "加载更多评论"}</button> : page?.items.length ? <p className="rv-comment-end">已显示全部已返回评论</p> : null}
    </div>
    <footer className="rv-comments-footer">{record.url && onOpenRecord ? <button className="rv-more" onClick={() => void onOpenRecord(record.url!)}>在抖音参与讨论 <ArrowUpRight color="#ddd" size={15} /></button> : <span>评论来自抖音公开页面</span>}</footer>
  </section>;
});

function CommentRow({ comment }: { comment: ExploreComment }) {
  return <div className="rv-comment-row">
    <div className="rv-comment-avatar">{comment.author?.avatar ? <img src={comment.author.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : comment.name.slice(0, 1)}</div>
    <div className="rv-comment-body"><strong>{comment.name}{comment.replyToName ? <span className="rv-reply-to"> 回复 @{comment.replyToName}</span> : null}</strong>
      {comment.text ? <p>{comment.text}</p> : !comment.images?.length ? <p>图片或表情评论，请在原页查看</p> : null}
      {comment.images?.map((url) => <img className="rv-comment-image" key={url} src={url} alt="评论图片或表情" referrerPolicy="no-referrer" loading="lazy" />)}
      <small>{date(comment.publishedAt)}</small></div>
    <div className="rv-comment-likes" aria-label={`${count(comment.likes)} 个赞`}><Heart color="#929298" size={15} /><span>{count(comment.likes)}</span></div>
  </div>;
}

function CommentReplies({ comment, session, onRefresh }: {
  comment: ExploreComment; session: ReturnType<typeof createVideoCommentsSession>; onRefresh: () => void;
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
      {(page?.items as ExploreComment[] | undefined)?.map((reply) => <article className="rv-reply" key={reply.id} data-reply-id={reply.id}><CommentRow comment={reply} /></article>)}
      {loading ? <p className="rv-reply-notice" role="status">正在读取回复…</p> : null}
      {error ? <div className="rv-reply-notice" role="alert"><p>{error.message}</p><button className="rv-reply-toggle" onClick={error.refresh ? onRefresh : () => setAttempt((value) => value + 1)}>{error.refresh ? "刷新评论" : "重试回复"}</button></div> : null}
      {page && !page.items.length && !loading && !error ? <p className="rv-reply-notice">暂时没有可展示的回复</p> : null}
      {page?.limited ? <p className="rv-reply-notice">已展示 500 条回复，可在原页继续查看。</p> : page && page.hasMore !== false ?
        <button className="rv-reply-toggle" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>加载更多回复</button> : null}
    </div>
  </div>;
}
