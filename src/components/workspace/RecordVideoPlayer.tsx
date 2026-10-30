import React, { memo, useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { ArrowUp, ArrowUpRight, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Forward, Heart, Link, Maximize, MessageCircle, Music2, Pause, Play, Search, Smile, Volume2, VolumeX, X } from "lucide-react-native";
import { CHAT_EMOJI, splitChatEmoji } from "../../domain/chatEmoji";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreComment, ExploreConnection, ExploreOutcome, ExplorePage, ExploreSharee, WatchedItem } from "../../services/explorer";
import { buildVideoFeed, createVideoCommentsSession, createVideoShareSession, createVideoWheelGesture, reactVideo, waitForCollector } from "../../services/videoFeed";
import { LocalCollectorError, type PlaybackMedia } from "../../services/localCollector";
import type { RecordDownloadState } from "./LegacyContentWorkspace";
import "./RecordVideoPlayer.css";

/** Resolves to a stream URL (or an image post's pictures) that stays valid until `signal` aborts. */
export type RecordVideoLoader = (record: PersonalVideoRecord, signal: AbortSignal, onProgress?: (message: string) => void) => Promise<PlaybackMedia>;
export const count = (value?: number | null) => value == null ? "—" : value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/u, "")}万` : value.toLocaleString("zh-CN");
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN") : "";
// 评论和文案里的小表情以 [捂脸] 这样的文字代码传输，用聊天页同一份字典换成行内小图，没收录的原样显示。
export const EmojiText = ({ text }: { text: string }) => <>{splitChatEmoji(text).map((part, index) => "emoji" in part
  ? <img className="rv-emoji" key={index} src={part.url} alt={part.emoji} title={part.emoji} referrerPolicy="no-referrer" draggable={false} />
  : part.text)}</>;

type Props = {
  record: PersonalVideoRecord;
  records?: PersonalVideoRecord[];
  onLoadVideo: RecordVideoLoader;
  commentsConnection?: ExploreConnection | null;
  onOpenRecord?: (url: string) => Promise<void>;
  /** 嵌在页面里（工作台「刷视频」）时不传：不弹窗、没有关闭钮，Esc 只收评论和分享 */
  onClose?: () => void;
  /** 推荐流：快到末尾时要下一批，records 里新来的接在后面 */
  onReachEnd?: () => void;
  /** 顶栏「工作台」后面那几个字 */
  title?: string;
  /** 一条视频开始播放时调用，带上刚离开那条看到哪（推荐流用它记抖音观看历史）；关播放器时 record 为空、只报上一条 */
  onSeen?: (record: PersonalVideoRecord | null, previous: WatchedItem | null) => void;
  /** 推荐流上一批没要到时的原因，播放器里显示并给重试 */
  feedError?: string | null;
  /** 右侧操作列的「下载」；没给就不显示 */
  onDownload?: (record: PersonalVideoRecord) => void;
  downloadStates?: Record<string, RecordDownloadState>;
};

// 往回翻时还留着的条数：画面和视频地址都在，翻回来直接放
const KEEP_BEHIND = 3;
const DOWNLOAD_LABEL: Record<RecordDownloadState, string> = { idle: "下载", queued: "下载中", running: "下载中", complete: "已下载", failed: "重试" };
const DOWNLOAD_SPOKEN: Record<RecordDownloadState, string> = { idle: "下载这条视频", queued: "正在下载", running: "正在下载", complete: "已下载，再下载一次", failed: "下载失败，重试" };

export function RecordVideoPlayer({ record, records, onLoadVideo, commentsConnection = null, onOpenRecord, onClose, onReachEnd, title = "当前列表", onSeen, feedError = null, onDownload, downloadStates }: Props) {
  const inline = !onClose;
  // Freeze the opened list so background collection cannot reorder a playing feed; a growing feed only appends.
  const [feed, setFeed] = useState(() => buildVideoFeed(records ?? [record], record));
  // 推荐流每来一批就接在后面；连着几批都没有能播的（全是直播、广告）就记下来，到 3 批先停，别一直空要
  const [emptyBatches, setEmptyBatches] = useState(0);
  const lastRecords = useRef(records);
  useEffect(() => {
    if (!onReachEnd || !records || records === lastRecords.current) return;
    lastRecords.current = records;
    const ids = new Set(feed.map((item) => item.id));
    const added = buildVideoFeed(records, record).filter((item) => !ids.has(item.id));
    setEmptyBatches((count) => added.length ? 0 : count + 1);
    if (added.length) setFeed((current) => [...current, ...added.filter((item) => !current.some((known) => known.id === item.id))]);
  }, [records]);
  const [index, setIndex] = useState(() => Math.max(0, feed.findIndex((item) => item.id === record.id)));
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  // 控制栏里的连播 / 清屏 / 倍速，换到下一条也保留
  const [prefs, setPrefs] = useState<PlayerPrefs>({ autoNext: false, clean: false, rate: 1 });
  const active = feed[index]!;
  // 离开的那条先记着，等下一条开播时一起报；关掉播放器时单独报（放到微任务里，等每条视频自己的收尾都跑完）
  const left = useRef<WatchedItem | null>(null);
  const seenRef = useRef(onSeen);
  seenRef.current = onSeen;
  const reportSeen = (item: PersonalVideoRecord | null) => {
    const previous = left.current;
    left.current = null;
    if (item || previous) seenRef.current?.(item, previous);
  };
  useEffect(() => () => queueMicrotask(() => reportSeen(null)), []);
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
  // 嵌在页面里时推荐要读几秒才挂上，这期间用户可能已经打开了设置之类的弹窗，别把焦点抢过来
  useEffect(() => { if (!inline || !document.activeElement?.closest('[role="dialog"],[aria-modal="true"]')) rootRef.current?.focus(); }, []);
  // 窗口收进托盘、看不见了就停下，别在后台接着出声
  useEffect(() => {
    const pause = () => { if (document.hidden) rootRef.current?.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => media.pause()); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  useEffect(() => { setShareOpen(false); }, [index]);
  // 剩不到 8 条就提前要下一批，来了还不够就接着要，一直补到前面有 8 条；出错或连着空了就停，等点重试
  const stalled = emptyBatches >= 3 || Boolean(feedError);
  useEffect(() => { if (!stalled && index >= feed.length - 8) onReachEnd?.(); }, [index, feed.length, records, stalled]);
  const retryFeed = () => { setEmptyBatches(0); onReachEnd?.(); };
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

  const dismiss = () => shareOpen ? toggleShare() : commentsOpen ? toggleComments() : onClose?.();
  const player = <div ref={rootRef} className={inline ? "rv-backdrop rv-inline" : "rv-backdrop"} tabIndex={-1} onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
      // 弹窗的 Esc 由 Modal 的 onRequestClose 接；嵌在页面里只能自己接，而且评论和分享面板会拦下冒泡，得在捕获阶段接
      onKeyDownCapture={inline ? (event) => { if (event.key === "Escape" && (shareOpen || commentsOpen)) { event.stopPropagation(); dismiss(); } } : undefined}
      onKeyDown={(event) => {
        if ((event.target as Element).closest("input,a,[data-comments-panel],[data-share-panel]")) return;
        if (["ArrowDown", "PageDown", "ArrowUp", "PageUp"].includes(event.key)) {
          event.preventDefault(); move(["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1);
        }
      }}>
      <div className="rv-layout" aria-label="视频播放器" role={inline ? "region" : "dialog"} aria-modal={inline ? undefined : true}>
        <div ref={viewerRef} className={`rv-viewer${prefs.clean ? " rv-clean" : ""}`}
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
          <DataStream />
          {/* The next video mounts hidden so it is resolved and buffering before the switch; the last three stay mounted so flicking back
              plays at once. Anything else unmounts and is released. */}
          {feed.slice(Math.max(0, index - KEEP_BEHIND), index + 2).map((item, slot) => { const offset = Math.max(0, index - KEEP_BEHIND) + slot - index; return <Playback key={item.id} active={offset === 0} record={item} onLoadVideo={onLoadVideo}
            muted={muted} onToggleMute={() => setMuted((value) => !value)} commentsOpen={commentsOpen} onToggleComments={toggleComments} onOpenRecord={onOpenRecord}
            shareOpen={shareOpen} onToggleShare={toggleShare} prefs={prefs} onPrefs={(patch) => setPrefs((value) => ({ ...value, ...patch }))} onEnded={() => move(1)} onSeen={onSeen ? reportSeen : undefined} onLeave={onSeen ? (watch) => { left.current = watch; } : undefined}
            commentsConnection={commentsConnection} title={title} onClose={onClose}
            onDownload={onDownload ? () => onDownload(item) : undefined} downloadState={downloadStates?.[item.id] ?? "idle"}
            position={`${index + offset + 1} / ${feed.length}`} />; })}
          {onReachEnd && stalled && index >= feed.length - 3 ? <div className="rv-feed-status" role="status">
            <span>{feedError ?? "暂时没有更多视频"}</span>
            <button className="rv-button" onClick={retryFeed}>重试</button>
          </div> : null}
          {/* 上下切换放在控制栏最右边；推荐流到底时点「下一个」再要一次，上一批没要到也能重试 */}
          <nav className="rv-navigation" aria-label="切换视频">
            <button className="rv-icon-button" aria-label="上一个视频" disabled={index === 0} onClick={() => move(-1)}><ChevronUp color="#fff" size={20} /></button>
            <button className="rv-icon-button" aria-label="下一个视频" disabled={index === feed.length - 1 && !onReachEnd}
              onClick={() => index === feed.length - 1 ? retryFeed() : move(1)}><ChevronDown color="#fff" size={20} /></button>
          </nav>
        </div>
      </div>
    </div>;
  return inline ? player : <Modal animationType="fade" transparent visible onRequestClose={dismiss}>{player}</Modal>;
}

const HEX = "0123456789abcdef";
const pick = (from: string) => from[Math.floor(Math.random() * from.length)]!;
type Drop = { x: number; head: number; speed: number; length: number; binary: boolean; tint: boolean; glyphs: string[] };
type Dump = { x: number; y: number; text: string; life: number };

// 播放器底下的黑底数据流：纯装饰。字压得很暗、越靠近画面越淡（遮罩在 CSS）。字本来就一行一行跳，12.5 帧一秒就够，减少动态时只画一帧不动。
function DataStream() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const COLUMN = 20, ROW = 15;
    let width = 0, height = 0, drops: Drop[] = [], dumps: Dump[] = [], frame = 0, last = 0;
    const glyph = (binary: boolean) => binary ? pick("01") : pick(HEX) + pick(HEX);
    const drop = (x: number, top = false): Drop => {
      const binary = Math.random() < 0.3;
      return { x, binary, tint: Math.random() < 0.05, head: top ? -Math.random() * 30 : Math.random() * height / ROW,
        speed: 0.1 + Math.random() * 0.35, length: 6 + Math.floor(Math.random() * 18),
        glyphs: Array.from({ length: 48 }, () => glyph(binary)) };
    };
    const resize = () => {
      // 只是暗底纹，按 1 倍像素画，字略软反而不抢眼，也省一大半填充
      width = canvas.width = canvas.clientWidth; height = canvas.height = canvas.clientHeight;
      // 画面正后方的列看不见，不画；其余每列两三股错开往下流：铺得密，但每个字都很暗
      const stage = Math.min(width, height * 9 / 16), left = (width - stage) / 2;
      const xs = Array.from({ length: Math.ceil(width / COLUMN) }, (_, i) => i * COLUMN + 3).filter((x) => x + COLUMN < left || x > left + stage);
      drops = Array.from({ length: Math.ceil(xs.length * 2.4) }, (_, i) => drop(xs[i % xs.length]!));
      dumps = [];
    };
    const draw = () => {
      context.fillStyle = "#050507"; context.fillRect(0, 0, width, height);
      context.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; context.textBaseline = "top";
      for (const [i, item] of drops.entries()) {
        item.head += item.speed;
        if ((item.head - item.length) * ROW > height) { drops[i] = drop(item.x, true); continue; }
        if (Math.random() < 0.03) item.glyphs[Math.floor(Math.random() * 48)] = glyph(item.binary);
        for (let k = 0; k < item.length; k += 1) {
          const row = Math.floor(item.head) - k;
          if (row < 0) break;
          const fade = 1 - k / item.length;
          context.fillStyle = k === 0 ? item.tint ? "rgba(120,210,255,.5)" : "rgba(225,230,238,.42)" : `rgba(200,206,216,${(0.19 * fade).toFixed(3)})`;
          context.fillText(item.glyphs[row % 48]!, item.x, row * ROW);
        }
      }
      // 偶尔横着打出一行内存转储，慢慢淡掉
      if (Math.random() < 0.05) dumps.push({ x: Math.random() * width * 0.7, y: Math.floor(Math.random() * height / ROW) * ROW, life: 1,
        text: `0x${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}  ${Array.from({ length: 6 + Math.floor(Math.random() * 10) }, () => glyph(false)).join(" ")}` });
      dumps = dumps.filter((line) => (line.life -= 0.02) > 0);
      for (const line of dumps) { context.fillStyle = `rgba(200,206,216,${(0.17 * line.life).toFixed(3)})`; context.fillText(line.text, line.x, line.y); }
    };
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last >= 80) { last = now; draw(); }
    };
    const observer = new ResizeObserver(() => { resize(); draw(); });
    observer.observe(canvas);
    if (!still) frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  // 遮罩单独一层紧跟在 canvas 后面，才会在画面底下而不是盖在画面上
  return <><canvas ref={ref} className="rv-stream" aria-hidden="true" /><div className="rv-stream rv-stream-veil" aria-hidden="true" /></>;
}

// 视频加载：抖音的红、青两段光沿播放三角的轮廓互相追，三角本身轻轻呼吸；不配文字
const PLAY_PATH = "M24 17.5 46 32 24 46.5Z";
const VideoLoader = () => <svg className="rv-loader" viewBox="0 0 64 64" aria-hidden="true">
  <path className="rv-loader-core" d={PLAY_PATH} />
  <path className="rv-loader-trail rv-loader-cyan" d={PLAY_PATH} pathLength={100} />
  <path className="rv-loader-trail" d={PLAY_PATH} pathLength={100} />
</svg>;

type PlayerPrefs = { autoNext: boolean; clean: boolean; rate: number };
const RATES = [1, 1.25, 1.5, 2, 0.75];
// 抖音电脑端那种标题：话题词单独上色；话题到空白、# 或标点为止（和采集器认话题的规则一样）
const Caption = ({ text }: { text: string }) => <>{text.split(/(#[^#\s,，。！？!?;；~～]+)/u).map((part, i) => part.startsWith("#")
  ? <span className="rv-tag" key={i}>{part}</span> : <EmojiText key={i} text={part} />)}</>;

function Playback({ active, record, onLoadVideo, muted, onToggleMute, commentsOpen, onToggleComments, shareOpen, onToggleShare, prefs, onPrefs, onEnded, onSeen, onLeave, commentsConnection, position, title, onClose, onOpenRecord, onDownload, downloadState }: {
  active: boolean; record: PersonalVideoRecord; onLoadVideo: RecordVideoLoader; muted: boolean; onToggleMute: () => void;
  commentsOpen: boolean; onToggleComments: () => void; shareOpen: boolean; onToggleShare: () => void; commentsConnection: ExploreConnection | null;
  prefs: PlayerPrefs; onPrefs: (patch: Partial<PlayerPrefs>) => void; onEnded: () => void; onSeen?: (record: PersonalVideoRecord) => void; onLeave?: (watch: WatchedItem) => void;
  position: string; title: string; onClose?: () => void; onOpenRecord?: (url: string) => Promise<void>;
  onDownload?: () => void; downloadState: RecordDownloadState;
}) {
  const [media, setMedia] = useState<PlaybackMedia | null>(null);
  const [slide, setSlide] = useState(0);
  const [readyToPlay, setReadyToPlay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [paused, setPaused] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const src = typeof media === "string" ? media : null;
  const album = typeof media === "object" ? media : null;
  const step = (direction: number) => { if (album) setSlide((value) => (value + direction + album.images.length) % album.images.length); };
  const loaderRef = useRef(onLoadVideo);
  loaderRef.current = onLoadVideo;
  // 真开始放了才算看过：每次切到这条、画面出来时记一次（和网页一样，重看也会刷新时间）
  const seenRef = useRef(onSeen);
  seenRef.current = onSeen;
  useEffect(() => { if (active && readyToPlay && !error) seenRef.current?.(record); }, [active, readyToPlay]);
  // 离开时报看到哪、看没看完：网页到过九成多就算看完（拖进度条过去也算），抖音据此标「已看完」、存续播点。
  // 要排在下面装载视频的 effect 前面：卸载时收尾按声明顺序跑，那边会把视频清空
  const reached = useRef(0);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    const video = videoRef.current;
    if (!active || !readyToPlay || error || !src || !video || !record.videoId) return;
    reached.current = 0;
    return () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      leaveRef.current?.({ awemeId: record.videoId!, positionMs: Math.round(video.currentTime * 1000), durationMs: Math.round(duration * 1000),
        finished: Math.max(reached.current, video.currentTime) >= duration * 0.9 });
    };
  }, [active, readyToPlay, error, src]);
  // 点赞 / 收藏：初始状态来自列表（推荐流、探索带着；内容库的「喜欢」「收藏」本来就是点过的）
  const initial = useRef({
    like: (record as { liked?: boolean | null }).liked ?? (record.id.startsWith("liked_videos:") ? true : null),
    collect: (record as { collected?: boolean | null }).collected ?? (record.id.startsWith("favorite_videos:") ? true : null),
  }).current;
  const [marks, setMarks] = useState(initial);
  const [acting, setActing] = useState<"like" | "collect" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 3_500); return () => clearTimeout(timer); }, [toast]);
  // 点下去立刻变色，后台只发一个请求；没成功就退回原样并说明原因，结果没确认就保持并提醒
  const act = (action: "like" | "collect") => {
    if (!commentsConnection || acting) return;
    const before = marks[action];
    const desired = !before;
    setMarks((value) => ({ ...value, [action]: desired }));
    setActing(action);
    void reactVideo(commentsConnection, record, action, desired, AbortSignal.timeout(60_000))
      .then((outcome) => { if (outcome.outcome !== "confirmed") setToast(outcome.message); })
      .catch((cause) => { setMarks((value) => ({ ...value, [action]: before })); setToast(cause instanceof Error ? cause.message : "操作没成功，请稍后再试。"); })
      .finally(() => setActing(null));
  };
  // 数字跟着自己的点赞 / 收藏加减一
  const tally = (base: number | null | undefined, action: "like" | "collect") =>
    base == null || marks[action] === initial[action] || marks[action] == null || initial[action] == null ? base : base + (marks[action] ? 1 : -1);
  useEffect(() => {
    const controller = new AbortController();
    const video = videoRef.current;
    const timeout = setTimeout(() => {
      setError("视频准备超时");
      controller.abort();
    }, 90_000);
    setMedia(null); setSlide(0); setReadyToPlay(false); setError(null); setPaused(true); setElapsed(0); setDuration(0);
    void (async () => {
      try {
        const next = await waitForCollector(() => loaderRef.current(record, controller.signal), controller.signal);
        if (controller.signal.aborted) return;
        setMedia(next);
        // 图文没有要缓冲的视频，拿到图片就开始：自动翻页、放配乐
        if (typeof next === "object") { setReadyToPlay(true); setPaused(false); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "视频暂时无法播放");
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
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = prefs.rate; }, [src, prefs.rate]);
  // 图文：配乐跟着播放和暂停走，每 4 秒翻一张，最后一张之后回到第一张（和视频循环一样）；划走就回到开头
  useEffect(() => {
    if (!album) return;
    if (!active) { setSlide(0); if (audioRef.current) audioRef.current.currentTime = 0; }
    if (active && !paused && !error) void audioRef.current?.play().catch(() => {});
    else audioRef.current?.pause();
  }, [album, active, paused, error]);
  useEffect(() => {
    if (!album || !active || paused || error) return;
    const timer = setTimeout(() => step(1), 4_000);
    return () => clearTimeout(timer);
  }, [album, active, paused, error, slide]);
  useEffect(() => {
    if (!album || !active) return;
    const turn = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key) || (event.target as Element).closest?.("input,textarea,[data-comments-panel],[data-share-panel]")) return;
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", turn);
    return () => window.removeEventListener("keydown", turn);
  }, [album, active]);
  useEffect(() => {
    if (!active || !src || readyToPlay || error) return;
    const timeout = setTimeout(() => setError("视频画面加载超时"), 15_000);
    return () => clearTimeout(timeout);
  }, [active, src, readyToPlay, error]);
  const toggle = () => {
    if (album) { if (!error) setPaused(!paused); return; }
    const video = videoRef.current;
    if (!src || !readyToPlay || error || !video) return;
    if (video.paused) void video.play().catch(() => setError("无法开始播放"));
    else video.pause();
  };

  return <>
    <div className="rv-stage" style={active ? undefined : { display: "none" }} data-testid={active ? "video-feed-stage" : undefined} data-loading={!readyToPlay && !error} onKeyDown={(event) => {
      if (event.code === "Space" && !(event.target as Element).closest("button,input,a")) { event.preventDefault(); toggle(); }
    }}>
      {album ? <div className="rv-album" role="img" aria-label={`${record.title}，第 ${slide + 1} 张，共 ${album.images.length} 张`} onClick={toggle}>
        {/* 实况照片翻到时放一遍它的短视频（静音，配乐照常），其余只显示图片；图片都先挂上，翻页不用等加载 */}
        {album.images.map((image, i) => image.live && i === slide && active
          ? <video key={`live${i}`} src={image.live} poster={image.url} autoPlay muted playsInline />
          : <img key={i} src={image.url} alt="" hidden={i !== slide} referrerPolicy="no-referrer" draggable={false} />)}
        {album.music ? <audio ref={audioRef} src={album.music} loop muted={muted} preload="auto" /> : null}
      </div> : <video ref={videoRef} aria-label={`${record.title}，视频播放`} src={src ?? undefined} poster={record.coverUrl ?? undefined}
        loop={!prefs.autoNext} playsInline muted={muted} preload="auto" onClick={toggle} tabIndex={0}
        onEnded={() => { if (active && prefs.autoNext) onEnded(); }}
        onLoadedData={() => setReadyToPlay(true)}
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={() => { const at = videoRef.current?.currentTime ?? 0; setElapsed(at); if (active) reached.current = Math.max(reached.current, at); }}
        onDurationChange={() => { const value = videoRef.current?.duration; setDuration(value && Number.isFinite(value) ? value : 0); }}
        onError={() => { if (src) setError("视频无法播放"); }} />}
      {(!readyToPlay || error) && record.coverUrl ? <img className="rv-loading-cover" src={record.coverUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <div className="rv-shade" aria-hidden="true" />
      {!readyToPlay || error ? <div className="rv-message" role={error ? "alert" : "status"} aria-label={error ? undefined : "视频加载中"}>
        {error ? <><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          {record.url && onOpenRecord ? <button className="rv-text-button" onClick={() => void onOpenRecord(record.url!)}>打开原视频</button> : null}</>
          : <VideoLoader />}
      </div> : paused ? <button className="rv-play-overlay" aria-label="开始播放" onClick={toggle}><Play color="#fff" fill="#fff" size={48} /></button> : null}
      <header className="rv-topbar">
        {onClose ? <button className="rv-icon-button" aria-label="关闭视频" onClick={onClose}><X color="#fff" size={24} /></button> : null}
        <span className="rv-heading">工作台<span>{title}</span></span>
        <span className="rv-position" aria-live="polite" aria-label="当前视频序号">{position}</span>
      </header>
      <aside className="rv-actions" aria-label="作品信息与操作">
        <div className="rv-avatar" aria-label={`作者：${record.author ?? "抖音用户"}`}>
          {record.authorAvatarUrl ? <img src={record.authorAvatarUrl} alt="" referrerPolicy="no-referrer" /> : <span>{(record.author ?? "抖").slice(0, 1)}</span>}
        </div>
        <button className={`rv-stat${marks.like ? " rv-selected" : ""}`} aria-label={marks.like ? "取消点赞" : "点赞"} aria-pressed={marks.like === true}
          disabled={!commentsConnection || acting !== null} onClick={() => act("like")}>
          <Heart color={marks.like ? "#fe2c55" : "#fff"} fill={marks.like ? "#fe2c55" : "#fff"} size={30} /><span>{count(tally(record.stats?.diggCount, "like"))}</span>
        </button>
        <button className={`rv-stat ${commentsOpen ? "rv-selected" : ""}`} aria-label="查看评论" aria-expanded={commentsOpen} onClick={onToggleComments}>
          <MessageCircle color={commentsOpen ? "#ff2c55" : "#fff"} fill={commentsOpen ? "#ff2c55" : "#fff"} size={30} /><span>{count(record.stats?.commentCount)}</span>
        </button>
        <button className={`rv-stat${marks.collect ? " rv-starred" : ""}`} aria-label={marks.collect ? "取消收藏" : "收藏"} aria-pressed={marks.collect === true}
          disabled={!commentsConnection || acting !== null} onClick={() => act("collect")}>
          <Bookmark color={marks.collect ? "#face15" : "#fff"} fill={marks.collect ? "#face15" : "#fff"} size={28} /><span>{count(tally(record.stats?.collectCount, "collect"))}</span>
        </button>
        <button className="rv-stat" data-share-toggle aria-label="分享给朋友" aria-expanded={shareOpen} onClick={onToggleShare}>
          <Forward color={shareOpen ? "#ff2c55" : "#fff"} fill={shareOpen ? "#ff2c55" : "#fff"} size={30} /><span>{count(record.stats?.shareCount)}</span>
        </button>
        {record.url && onDownload ? <button className="rv-stat" aria-label={DOWNLOAD_SPOKEN[downloadState]} disabled={downloadState === "queued" || downloadState === "running"} onClick={onDownload}>
          {downloadState === "queued" || downloadState === "running" ? <span className="rv-download-spin"><span className="rv-spinner" /></span>
            : downloadState === "complete" ? <Check color="#fff" size={30} /> : <Download color="#fff" size={30} />}<span>{DOWNLOAD_LABEL[downloadState]}</span>
        </button> : null}
      </aside>
      <div className="rv-caption">
        <strong>@{record.author ?? "抖音用户"}{record.publishedAt ? <small> · {date(record.publishedAt)}</small> : null}</strong>
        <p title={record.title}><Caption text={record.title} /></p>
        {record.music?.title ? <div className="rv-music"><Music2 color="#fff" size={14} /><span>{record.music.title}{record.music.author ? ` · ${record.music.author}` : ""}</span></div> : null}
      </div>
      {/* 底部控制栏：顶上一条细进度线，左边播放和时间，右边连播、清屏、倍速、声音、全屏 */}
      <div className="rv-controls" data-feed-controls>
        {album ? <div className="rv-album-dots">{album.images.map((_, i) => <button key={i} aria-label={`第 ${i + 1} 张`} aria-current={i === slide}
          className={i <= slide ? "rv-on" : undefined} onClick={() => setSlide(i)} />)}</div>
          : <input aria-label="视频进度" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(elapsed, duration || 1)} disabled={!duration}
            style={{ "--rv-played": `${duration ? Math.min(100, elapsed / duration * 100) : 0}%` } as React.CSSProperties}
            onChange={(event) => { if (videoRef.current) { videoRef.current.currentTime = Number(event.target.value); setElapsed(Number(event.target.value)); } }} />}
        <div className="rv-control-row">
          <button className="rv-icon-button" aria-label={`${paused ? "播放" : "暂停"}${album ? "图文" : "视频"}`} disabled={!readyToPlay || Boolean(error)} onClick={toggle}>
            {paused ? <Play color="#fff" fill="#fff" size={18} /> : <Pause color="#fff" fill="#fff" size={18} />}
          </button>
          {album ? <>
            <button className="rv-icon-button" aria-label="上一张" onClick={() => step(-1)}><ChevronLeft color="#fff" size={19} /></button>
            <span aria-live="polite">{slide + 1} / {album.images.length}</span>
            <button className="rv-icon-button" aria-label="下一张" onClick={() => step(1)}><ChevronRight color="#fff" size={19} /></button>
          </> : <span className="rv-time">{time(elapsed)} <i>/</i> {time(duration)}</span>}
          <span className="rv-control-spacer" />
          <button className="rv-toggle" aria-pressed={prefs.autoNext} onClick={() => onPrefs({ autoNext: !prefs.autoNext })}><i />连播</button>
          <button className="rv-toggle" aria-pressed={prefs.clean} onClick={() => onPrefs({ clean: !prefs.clean })}><i />清屏</button>
          {album ? null : <button className="rv-text-control" aria-label={`播放速度 ${prefs.rate} 倍，点一下换`} onClick={() => onPrefs({ rate: RATES[(RATES.indexOf(prefs.rate) + 1) % RATES.length]! })}>
            {prefs.rate === 1 ? "倍速" : `${prefs.rate}x`}</button>}
          <button className="rv-icon-button" aria-label={muted ? "开启声音" : "静音"} onClick={onToggleMute}>{muted ? <VolumeX color="#fff" size={20} /> : <Volume2 color="#fff" size={20} />}</button>
          <button className="rv-icon-button" aria-label="全屏" onClick={(event) => {
            const layout = event.currentTarget.closest<HTMLElement>(".rv-layout");
            void (document.fullscreenElement ? document.exitFullscreen() : layout?.requestFullscreen())?.catch(() => {});
          }}><Maximize color="#fff" size={18} /></button>
        </div>
      </div>
      {toast ? <p className="rv-toast" role="status">{toast}</p> : null}
      {active && shareOpen ? <VideoShare record={record} connection={commentsConnection} onClose={onToggleShare} /> : null}
    </div>
    {active && commentsOpen ? <VideoComments record={record} connection={commentsConnection} ready={Boolean(media || error)} onClose={onToggleComments} onOpenRecord={onOpenRecord} /> : null}
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
    <div className="rv-comment-list" tabIndex={0}>
      {!connection ? <p className="rv-comment-notice">连接采集器后可看评论</p> : null}
      {connection && (!ready || loading) ? <div className="rv-comment-notice" role="status" aria-label="评论加载中"><span className="rv-spinner" /></div> : null}
      {error ? <div className="rv-comment-notice" role="alert"><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div> : null}
      {threads.map((comment) => <article className="rv-comment" key={posted.has(comment.id) ? `mine:${comment.id}` : `${page!.sessionId}:${comment.id}`} data-comment-id={comment.id}>
        <CommentRow comment={comment} onReply={reply} />
        {mine.filter((item) => item.parentId === comment.id).map((item) => <article className="rv-reply rv-replies" key={item.id} data-reply-id={item.id}><CommentRow comment={item} onReply={reply} /></article>)}
        {comment.replies > 0 && sessionRef.current ? <CommentReplies comment={comment} session={sessionRef.current} hidden={posted} onReply={reply} onRefresh={() => setSessionVersion((value) => value + 1)} /> : null}
      </article>)}
      {page && !threads.length && !loading && !error ? <p className="rv-comment-notice">暂时没有评论</p> : null}
      {page?.limited ? <p className="rv-comment-notice">已显示 500 条</p> : page && page.hasMore !== false ?
        <button className="rv-more" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>{loading ? <span className="rv-spinner rv-spinner-small" /> : "更多评论"}</button> : null}
    </div>
    <footer className="rv-comments-footer">{connection ? <CommentComposer key={record.id} disabled={!page} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={send} />
      : record.url && onOpenRecord ? <button className="rv-more" onClick={() => void onOpenRecord(record.url!)}>在抖音参与讨论 <ArrowUpRight color="#ddd" size={15} /></button> : null}</footer>
  </section>;
});

function CommentRow({ comment, onReply }: { comment: ExploreComment; onReply?: (comment: ExploreComment) => void }) {
  return <div className="rv-comment-row">
    <div className="rv-comment-avatar">{comment.author?.avatar ? <img src={comment.author.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" /> : comment.name.slice(0, 1)}</div>
    <div className="rv-comment-body"><strong>{comment.name}{comment.replyToName ? <span className="rv-reply-to"> 回复 @{comment.replyToName}</span> : null}</strong>
      {comment.text ? <p><EmojiText text={comment.text} /></p> : !comment.images?.length ? <p>[图片]</p> : null}
      {comment.images?.map((url) => <img className="rv-comment-image" key={url} src={url} alt="评论图片或表情" referrerPolicy="no-referrer" loading="lazy" />)}
      <div className="rv-comment-meta"><small>{date(comment.publishedAt)}</small>
        {onReply ? <button className="rv-reply-action" aria-label={`回复 ${comment.name}`} onClick={() => onReply(comment)}>回复</button> : null}</div></div>
    <div className="rv-comment-likes" aria-label={`${count(comment.likes)} 个赞`}><Heart color="#929298" size={15} /><span>{count(comment.likes)}</span></div>
  </div>;
}

// 和抖音网页一样：点「展开 N 条回复」读第一页，之后「展开更多」接着翻；读过的收起再展开不重读
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
      if (current) setError({ message: cause instanceof Error ? cause.message : "回复没读出来",
        refresh: cause instanceof LocalCollectorError && ["session_expired", "comment_unavailable"].includes(cause.code) });
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [session, comment.id, attempt]);
  return <div className="rv-replies">
    <div id={`rv-replies-${comment.id}`} hidden={!expanded}>
      {(page?.items as ExploreComment[] | undefined)?.filter((reply) => !hidden.has(reply.id)).map((reply) => <article className="rv-reply" key={reply.id} data-reply-id={reply.id}><CommentRow comment={reply} onReply={onReply} /></article>)}
      {error ? <div className="rv-reply-notice" role="alert"><p>{error.message}</p><button className="rv-reply-toggle" onClick={error.refresh ? onRefresh : () => setAttempt((value) => value + 1)}>{error.refresh ? "刷新评论" : "重试"}</button></div> : null}
      {page && !page.items.length && !loading && !error ? <p className="rv-reply-notice">暂无回复</p> : null}
    </div>
    <div className="rv-reply-bar">
      {loading ? <span className="rv-spinner rv-spinner-small" role="status" aria-label="回复加载中" />
        : expanded && page?.hasMore !== false && !page?.limited && !error ? <button className="rv-reply-toggle" onClick={() => setAttempt((value) => value + 1)}>展开更多<ChevronDown size={14} color="#b6b6c0" /></button>
        : !expanded ? <button className="rv-reply-toggle" aria-expanded={false} aria-controls={`rv-replies-${comment.id}`} onClick={() => {
          setExpanded(true);
          if (!page) setAttempt((value) => value + 1);
        }}>展开 {count(comment.replies)} 条回复<ChevronDown size={14} color="#b6b6c0" /></button> : null}
      {expanded && !loading ? <button className="rv-reply-toggle" aria-expanded aria-controls={`rv-replies-${comment.id}`} onClick={() => setExpanded(false)}>收起<ChevronUp size={14} color="#b6b6c0" /></button> : null}
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
        placeholder={replyTo ? `回复 @${replyTo.name}` : "留下你的精彩评论吧"} aria-label={replyTo ? `回复 ${replyTo.name}` : "发表评论"}
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
      {!connection ? <p className="rv-share-notice">连接采集器后可分享</p>
        : error ? <div className="rv-share-notice" role="alert"><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
          : !page ? <div className="rv-share-notice" role="status" aria-label="朋友列表加载中"><span className="rv-spinner" /></div>
            : !shown.length ? <p className="rv-share-notice">{keyword ? "没有找到" : "暂无可分享的朋友"}</p> : null}
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
