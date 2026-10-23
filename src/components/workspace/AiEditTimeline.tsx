import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  BookmarkPlus, Captions, CaptionsOff, ChevronDown, Film, Magnet, MousePointer2, MoveHorizontal, Music2, Paperclip, Plus, Scissors, SeparatorVertical, Sparkles,
  SlidersHorizontal, SquareSplitHorizontal, Sticker, TextCursor, Trash2, Type, Volume2, VolumeX, ZoomIn, ZoomOut,
} from "lucide-react-native";
import type { AiEditMediaItem, EditProject, EditSegment, EditTimeRange, EditTrack } from "../../services/aiEdit";
import {
  clipExtras, clipLabel, featureName, filmstripCount, filmstripTimes, findSegment, formatClock, mediaIdFromPath, secondMark, spokenDuration, trackLabel, transitionReach,
  US_PER_SECOND, type TransitionReach,
} from "./aiEditModel";
import { SNAP_PX, splitOffset, trimArgs, type TrimEdge } from "./aiEditBoardEdit";
import { lastingReason } from "./aiEditInspect";
import { useBoard, useBoardKeys, useEscapeLayer, useHeldEdit, usePlaybackTime, usePreviewStore, type BoardEdit } from "./aiEditBoardContext";
import { HistoryControls } from "./AiEditHistory";
import { mainTrackOf, rippleEdits, type RippleIntent } from "./aiEditTimelineMagnet";
import { setTimelinePref, timelinePrefs, useTimelinePrefs, type TimelinePrefs } from "./aiEditTimelinePrefs";
import { IS_MAC, shortcutText } from "./aiEditKeymap";
import { useContextMenu, type MenuEntry } from "./AiEditMenu";
import {
  canvasExtentUs, clipBox, edgeScrollStep, MARQUEE_LIFT_PX, marqueeHits, MOVE_LIFT_PX, moveEdits, moveOrder, moveTip, NUDGE_WRITE_MS, nudgeStep, planDuplicate, planMove, planPaste, planTrim,
  snapTargetsOf, snapTo, toFrame, touchingEdges, TRIM_LIFT_PX, trackOrderWith, trackRows, trimHit, trimTip, trimToPlayhead, visibleTicks, ZOOM_STEP, zoomRange, zoomScroll,
  type CopyPlan, type HeldClip, type MoveSpec, type MovePlan, type TrimPlan,
} from "./aiEditTimelineEdit";
import { createFrameQueue, openVideoFrames } from "./aiEditFrames";
import { areaProps, clipTone, mediaTitle, web } from "./aiEditShared";
import { kit } from "./CreatorKit";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 看板下半部分的轨道区：顶上一条工具栏（分割、删除、缩放，和剪辑软件一样），刻度尺、每条轨道一行（左边轨道头带静音钮）、片段块（视频带缩略图）、播放头。
// 点片段只选中、不挪播放头；⌘ 点击加减、⇧ 点击追加，空白处拖出框来框选；按住中间拖是挪位置（上下拖能换到同类轨道，⌥ 拖是复制一份），
// 拖两头是裁剪；拖的时候只在这里预览，松手才发一次改动，肯定放不下的落点直接拦住不发。点刻度尺挪播放头，空白处单击挪播放头并取消选中。
// 轨道和剪映一样倒着画：越往上的行在画面上越靠上层（列表越靠后越在上层）。
// ⌘/Ctrl + 滚轮、⌘= ⌘− ⌘0 缩放，拖到左右边缘自动滚。右键片段、轨道头有菜单。规格见 openfilm-editor-spec.md 的 A、C7、C8、D4–D9、1B。

// 轨道上视频片段的缩略图：全页一条取帧队列，结果缓存在模块里，切走再回来不用重新解码
const frameQueue = createFrameQueue(openVideoFrames);

export const RULER = 22;
// 轨道行高：比对话气泡里的小字高一截，视频缩略图看得清，接近剪辑软件的轨道
export const ROW = 36;
/** 轨道区顶上工具栏的高度 */
export const TOOLS = 34;
export const HEAD = 92;

/** 轨道区按轨道数定高，最多占看板的四成；剩下的都给画面 */
/** 轨道区（连工具栏）多高：剪辑软件那样至少占看板三成，轨道多了往上长，最多四成二，再多就在里面滚 */
export const timelineHeight = (trackCount: number, boardHeight: number) => {
  const content = TOOLS + RULER + Math.max(1, trackCount) * ROW + 12;
  if (!boardHeight) return Math.max(content, 240);
  return Math.round(Math.max(130, Math.min(Math.max(content, boardHeight * 0.3), boardHeight * 0.42)));
};

const TRACK_ICON: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  video: Film, audio: Music2, text: Type, sticker: Sticker, effect: Sparkles, filter: SlidersHorizontal,
};

/** 看板自己的改动在路上时 notEditableReason 就是这句；只有这种不能改不打断拖动，松手后等它回来再发 */
const BUSY = "上一个改动还没回来，稍等";
/** 松手、粘贴、Q/W 时最多等看板自己在路上的改动这么久 */
const SETTLE_MS = 5_000;
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";
const HINT_EDIT = `点一下选中，${MOD} 点击多选；按住拖能挪位置，上下拖能换到别的轨道，拖两头能裁剪，按住 ${ALT} 拖是复制一份`;
const HINT_VIEW = "点一下选中，看详情";

/** 刻度尺和轨道头盖在滚动的片段上面，要不透明：主题的面板色可能是半透明的，底下垫一层黑 */
const solid: React.CSSProperties = { backgroundColor: color.black, backgroundImage: `linear-gradient(${color.surface}, ${color.surface})` };

/** 正在拖（或键盘微调攒着）的片段：跟着手走的位置，请求回来前一直留着，失败了撤掉就回原位。 */
interface Draft {
  kind: "drag" | "nudge";
  mode: "move" | TrimEdge;
  /** ⌥ 拖：原片段不动，画一个跟着手走的影子 */
  copy: boolean;
  items: ReadonlyArray<{ id: string; fromTrackId: string; trackId: string; timeline: EditTimeRange }>;
  /** 挪动时跟着指针上下漂的像素；松手后是落到的那一行 */
  offsetY: number;
  /** 指针下能放的另一条轨道（浅色底） */
  target: string | null;
  refused: string | null;
  snappedUs: number | null;
  /** 数值提示条，轨道内容里的坐标 */
  tip: { text: string; x: number; y: number; center: boolean } | null;
}

/** 一段片段在拖动中怎么画 */
interface ClipPlace { timeline: EditTimeRange; mode: Draft["mode"]; offsetY: number; refused: boolean; copy: boolean; floating: boolean }

interface Marquee { left: number; top: number; width: number; height: number; hits: ReadonlySet<string> }

/** 键盘微调（C7）：按开始攒时的位置记下这几段，delta 是攒到现在的位移，sent 是已经发出去、还在路上的那部分 */
interface Nudge { ids: string[]; held: HeldClip[]; delta: number; sent: number; timer: ReturnType<typeof setTimeout> | null; flight: Promise<boolean> | null }

interface FollowSpec {
  /** 过了阈值才算拖开 */
  lift: (dx: number, dy: number) => boolean;
  /** 拖开以后每帧算一次（自动滚动时也算）；stop() 放弃这次手势 */
  frame: (event: PointerEvent, stop: () => void) => void;
  /** 结束：event 为 null 是取消了（Esc、窗口失焦、指针被系统收走、中途不能改了） */
  end: (event: PointerEvent | null, dragged: boolean) => void;
  autoScroll?: boolean;
  /** 会改工程的手势：中途变成不能改（AI 开始剪了）就放弃 */
  edits?: boolean;
}

export function Timeline({ height }: { height: number }) {
  const board = useBoard();
  const { project, mediaById, mediaUrl, duration, editable, notEditableReason, selection, playback } = board;
  const time = usePlaybackTime();
  // 事件里读的最新值：播放头每帧都在变，不为它重挂监听
  const latest = useRef(board);
  latest.current = board;
  const tracks = useMemo(() => project?.tracks ?? [], [project]);
  // 从上往下画的行：列表倒过来，第一行是最上层；行号（rowAt、框选、拖动换行）都按这个算
  const rows = useMemo(() => trackRows(tracks), [tracks]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  // 时间线比例：null 是默认（成片占八成），缩放过就记住一像素多少微秒，工程变长变短时画面不跟着缩
  const [zoomPx, setZoomPx] = useState<number | null>(null);
  const zoom = zoomRange(duration, viewWidth);
  const pxPerUs = zoomPx === null ? zoom.fit : Math.min(zoom.max, Math.max(zoom.min, zoomPx));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // 剪贴板只存片段 id，粘贴时按片段当时的样子复制
  const clipboard = useRef<string[]>([]);
  const menu = useContextMenu();
  const view = useRef({ px: pxPerUs, width: viewWidth, rows });
  view.current = { px: pxPerUs, width: viewWidth, rows };
  const gesture = useRef<{ cancel: () => void; edits: boolean } | null>(null);
  const nudge = useRef<Nudge | null>(null);
  const blocked = editable ? null : notEditableReason ?? BUSY;
  const prefs = useTimelinePrefs();
  const previewStore = usePreviewStore();
  // 选择 / 分割工具（照 openfilm 的 ModePicker）：分割工具下点片段就在点的地方切开。不记住，每次进来都是选择
  const [mode, setMode] = useState<"select" | "split">("select");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // 预览轴的竖线、分割工具的刀线：跟着鼠标每次都动，直接改元素样式，不重渲染轨道
  const hoverRef = useRef<HTMLDivElement | null>(null);
  const bladeRef = useRef<HTMLDivElement | null>(null);
  // 打开着卡片的标记（时间），按住拖着的标记从哪拖到哪，鼠标停着的标记（画一条贯穿各轨道的虚线）
  const [markerCard, setMarkerCard] = useState<number | null>(null);
  const [markerDrag, setMarkerDrag] = useState<{ from: number; to: number } | null>(null);
  const [markerHover, setMarkerHover] = useState<number | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  const subtitleTrack = tracks.find((track) => track.kind === "subtitle") ?? null;
  const mainTrackId = useMemo(() => mainTrackOf(project)?.id ?? null, [project]);

  // ---------- 尺寸、滚动、缩放 ----------
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!web || !scroller) return undefined;
    const measure = () => setViewWidth(Math.max(0, scroller.clientWidth - HEAD));
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const dragReach = draft?.kind === "drag" ? Math.max(0, ...draft.items.map((item) => item.timeline.start_us + item.timeline.duration_us)) : 0;
  const extentUs = canvasExtentUs(duration, viewWidth, pxPerUs, dragReach);
  const trackPx = Math.max(viewWidth, Math.ceil(extentUs * pxPerUs));
  const ticks = useMemo(() => visibleTicks(pxPerUs, Math.max(0, scrollX - viewWidth), scrollX + 2 * viewWidth, extentUs), [pxPerUs, scrollX, viewWidth, extentUs]);

  // 缩放：视图里 anchor 那一点下面的时间不动（默认播放头在视图里就以播放头为准，不在就以中间为准）；新宽度画出来以后再滚过去
  const pendingScroll = useRef<number | null>(null);
  const zoomTo = (next: number | null, anchorClientX?: number) => {
    const scroller = scrollRef.current;
    const { px, width } = view.current;
    if (!scroller || !(px > 0) || gesture.current) return;
    const range = zoomRange(latest.current.duration, width);
    const to = next === null ? range.fit : Math.min(range.max, Math.max(range.min, next));
    if (Math.abs(to - px) < px * 1e-6) return;
    const playX = latest.current.playback.timeRef.current * px - scroller.scrollLeft;
    const anchor = anchorClientX !== undefined ? anchorClientX - scroller.getBoundingClientRect().left - HEAD : playX >= 0 && playX <= width ? playX : width / 2;
    pendingScroll.current = zoomScroll(px, to, scroller.scrollLeft, anchor);
    setZoomPx(next === null ? null : to);
  };
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (pendingScroll.current === null || !scroller) return;
    scroller.scrollLeft = Math.max(0, pendingScroll.current);
    pendingScroll.current = null;
    setScrollX(scroller.scrollLeft);
  });
  // ⌘/Ctrl + 滚轮（触控板捏合也是）以指针为中心缩放：要原生的非 passive 监听才拦得住浏览器自己的缩放；一帧只缩一次
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!web || !scroller) return undefined;
    let factor = 1;
    let anchor = 0;
    let frame = 0;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      factor *= Math.exp(-pixels / 180);
      anchor = event.clientX;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; const by = factor; factor = 1; zoomRef.current(view.current.px * by, anchor); });
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => { scroller.removeEventListener("wheel", onWheel); if (frame) cancelAnimationFrame(frame); };
  }, []);
  // 放大以后播放头走出视图就翻一页跟上
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!playback.playing || !scroller || gesture.current || !(pxPerUs > 0)) return;
    const x = time * pxPerUs;
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + viewWidth - 8) scroller.scrollLeft = Math.max(0, x - viewWidth * 0.1);
  }, [time, playback.playing, pxPerUs, viewWidth]);

  // 点了回复里的片段、时间，播放头跳走了：不在视图里就滚过去
  const revealSeq = board.revealSeq;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!revealSeq || !scroller || !(pxPerUs > 0)) return;
    const x = latest.current.playback.timeRef.current * pxPerUs;
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + viewWidth - 8) scroller.scrollLeft = Math.max(0, x - viewWidth * 0.3);
    // 只在又跳了一次时滚，缩放、改宽度不算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);

  // ---------- 坐标 ----------
  /** 指针下的时间（微秒，不早于 0）：按轨道内容现在的位置算，滚动过也对 */
  const usAt = (clientX: number) => {
    const left = (contentRef.current?.getBoundingClientRect().left ?? 0) + HEAD;
    return view.current.px > 0 ? Math.max(0, (clientX - left) / view.current.px) : 0;
  };
  /** 指针在第几行：在刻度尺上是 -1，在所有行下面是行数（不夹到最近的一行，免得在空白处拖出的框选到边上那行） */
  const rowAt = (clientY: number) => {
    const scroller = scrollRef.current?.getBoundingClientRect();
    const content = contentRef.current?.getBoundingClientRect();
    const count = view.current.rows.length;
    if (!scroller || !content || clientY < scroller.top + RULER) return -1;
    if (clientY > scroller.bottom) return count;
    const row = Math.floor((clientY - content.top - RULER) / ROW);
    return row < 0 ? -1 : Math.min(row, count);
  };
  const contentY = (clientY: number) => clientY - (contentRef.current?.getBoundingClientRect().top ?? 0);

  // ---------- 手势 ----------
  /**
   * 按下以后跟着指针：过了阈值才算拖开（这时才接管指针，经过视频画面也收得到移动），move 只记坐标、一帧算一次；
   * 拖到左右边缘自动滚；Esc（捕获阶段拿走，看板不会跟着收起详情卡）、窗口失焦、指针被系统收走都取消；拖动中改光标、不选字。
   */
  const follow = (start: PointerEvent, spec: FollowSpec) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    gesture.current?.cancel();
    const id = start.pointerId;
    const body = document.body.style;
    const before = { cursor: body.cursor, select: body.userSelect };
    let dragged = false;
    let last: PointerEvent | null = null;
    let frame = 0;
    let edge = 0;
    let done = false;
    const run = () => { frame = 0; if (last && !done) spec.frame(last, cancel); };
    const scroll = () => {
      edge = 0;
      if (done || !last) return;
      const rect = scroller.getBoundingClientRect();
      const step = edgeScrollStep(last.clientX, rect.left + HEAD, rect.right);
      const next = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + step));
      if (!step || next === scroller.scrollLeft) return;
      scroller.scrollLeft = next;
      // 指针停着不动时滚过的距离也算进拖动里
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      spec.frame(last, cancel);
      edge = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      if (!dragged) {
        if (!spec.lift(event.clientX - start.clientX, event.clientY - start.clientY)) return;
        dragged = true;
        body.userSelect = "none";
        try { scroller.setPointerCapture(id); } catch { /* 元素已经不在了 */ }
      }
      last = event;
      if (!frame) frame = requestAnimationFrame(run);
      if (!edge && spec.autoScroll) edge = requestAnimationFrame(scroll);
    };
    const finish = (event: PointerEvent | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      if (frame) cancelAnimationFrame(frame);
      if (edge) cancelAnimationFrame(edge);
      try { if (scroller.hasPointerCapture(id)) scroller.releasePointerCapture(id); } catch { /* 同上 */ }
      if (gesture.current?.cancel === cancel) gesture.current = null;
      // 松手时先把最后一步算完；算的时候会再设一次光标，所以光标放在它后面还原
      let stopped = false;
      if (event && dragged) spec.frame(event, () => { stopped = true; });
      body.cursor = before.cursor;
      body.userSelect = before.select;
      spec.end(stopped ? null : event, dragged);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === id) finish(event); };
    const lost = (event: PointerEvent) => { if (event.pointerId === id) finish(null); };
    const cancel = () => finish(null);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragged) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    gesture.current = { cancel, edits: Boolean(spec.edits) };
  };
  // 拖到一半变成不能改（AI 开始剪了、在导入）：直接放弃这次拖动。看板自己的改动在路上不算（常是这次按下引起的，
  // 比如画面攒着的微调换选中时发了出去），照常拖，松手后等它回来再发
  const lockedOut = !editable && notEditableReason !== BUSY;
  useEffect(() => { if (lockedOut && gesture.current?.edits) gesture.current.cancel(); }, [lockedOut]);
  /** 等看板自己在路上的改动回来（AI 在剪、在导入不等，最多等 SETTLE_MS）；能改了返回 true，不然弹原因 */
  const untilEditable = async (): Promise<boolean> => {
    for (const stop = Date.now() + SETTLE_MS; !latest.current.editable;) {
      const reason = latest.current.notEditableReason;
      if (reason !== BUSY || Date.now() > stop) { latest.current.toast(reason ?? BUSY); return false; }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return true;
  };

  /** 刻度尺：按下就挪播放头，按住拖是拖播放头，选中不变（选好片段再点刻度尺定切点） */
  const scrub = (event: PointerEvent) => {
    if (!(latest.current.duration > 0)) return;
    latest.current.playback.seek(usAt(event.clientX));
    follow(event, { lift: () => true, autoScroll: true, frame: (moved) => latest.current.playback.seek(usAt(moved.clientX)), end: () => undefined });
  };

  /** 联动时有的片段本该跟着走、但那里有别的片段挡着，留在了原处：说一声 */
  const stuckNote = (stuck: number) => { if (stuck) latest.current.toast(`有 ${stuck} 段跟着走会压到别的片段，留在了原处`); };

  // ---------- 标记 ----------
  /**
   * 按在标记上：点一下跳过去、打开卡片（改名字、颜色、删除）；按住拖是挪（吸到片段边和播放头，不吸别的标记），
   * 松手发「删旧的、在新地方加」一批，一步撤销。照 openfilm 的 TimelineMarkers。
   */
  const pressMarker = (event: PointerEvent, timeUs: number) => {
    if (!latest.current.project?.markers?.some((one) => one.time_us === timeUs)) return;
    const pressUs = usAt(event.clientX);
    let to = timeUs;
    follow(event, {
      lift: (dx) => Math.abs(dx) >= MOVE_LIFT_PX,
      autoScroll: true,
      edits: true,
      frame: (moved, stop) => {
        const now = latest.current;
        if (!now.editable && now.notEditableReason !== BUSY) { now.toast(now.notEditableReason ?? BUSY); stop(); return; }
        const raw = timeUs + usAt(moved.clientX) - pressUs;
        const targets = snapTargetsOf({ tracks: now.project?.tracks ?? [], markers: [] }, { playheadUs: now.playback.timeRef.current });
        const snapped = timelinePrefs().snap ? snapTo(raw, targets, SNAP_PX / view.current.px) : { value: raw, snapped: null };
        to = Math.max(0, snapped.snapped === null ? toFrame(raw, now.frameUs) : snapped.value);
        setMarkerDrag({ from: timeUs, to });
        document.body.style.cursor = "ew-resize";
      },
      end: (released, dragged) => {
        if (!released || (dragged && to === timeUs)) { setMarkerDrag(null); return; }
        if (!dragged) { setMarkerDrag(null); latest.current.playback.seek(timeUs); setMarkerCard(timeUs); return; }
        setMarkerCard(null);
        void (async () => {
          try {
            if (!(await settle())) return;
            // 等前面的改动（比如卡片里刚改的名字）回来再读，别拿按下时的旧名字覆盖
            const marker = latest.current.project?.markers?.find((one) => one.time_us === timeUs);
            if (!marker) return;
            if (latest.current.project?.markers?.some((one) => one.time_us === to)) { latest.current.toast("那里已经有一个标记了"); return; }
            await latest.current.runEdits([
              { name: "remove_marker", arguments: { time: timeUs / US_PER_SECOND } },
              { name: "add_marker", arguments: { time: to / US_PER_SECOND, label: marker.label, color: marker.color ?? MARKER_COLORS[0]!.value } },
            ], `挪动标记“${shortLabel(marker.label)}”`);
          } finally { setMarkerDrag(null); }
        })();
      },
    });
  };
  /** M：在播放头处加标记；这一帧已经有了就打开它的卡片（照 openfilm 的 addMarkerHere） */
  const addMarker = () => {
    const now = latest.current;
    if (!(now.duration > 0)) { now.toast("时间线还是空的"); return; }
    const at = toFrame(now.playback.timeRef.current, now.frameUs);
    const near = now.project?.markers?.find((one) => Math.abs(one.time_us - at) < now.frameUs / 2);
    if (near) { setMarkerCard(near.time_us); return; }
    const label = `标记 ${(now.project?.markers?.length ?? 0) + 1}`;
    void (async () => {
      if (!(await settle())) return;
      if (await latest.current.runEdit("add_marker", { time: at / US_PER_SECOND, label, color: MARKER_COLORS[0]!.value })) setMarkerCard(at);
    })();
  };
  /** 改标记的名字或颜色：同一时间再加一次就是替换；等前面的改动回来再读标记，不拿旧的覆盖 */
  const saveMarker = (timeUs: number, changes: { label?: string; color?: string }) => {
    void (async () => {
      if (!(await settle())) return;
      const marker = latest.current.project?.markers?.find((one) => one.time_us === timeUs);
      if (!marker) return;
      const label = (changes.label ?? marker.label).trim();
      if (!label || (label === marker.label && (changes.color ?? marker.color) === marker.color)) return;
      await latest.current.runEdit("add_marker", { time: timeUs / US_PER_SECOND, label, color: changes.color ?? marker.color ?? MARKER_COLORS[0]!.value });
    })();
  };
  const removeMarker = (timeUs: number) => {
    setMarkerCard(null);
    void (async () => { if (await settle()) await latest.current.runEdit("remove_marker", { time: timeUs / US_PER_SECOND }); })();
  };
  /** ⇧M / ⌥M：跳到下一个、上一个标记 */
  const jumpMarker = (direction: 1 | -1) => {
    const now = latest.current;
    const at = now.playback.timeRef.current;
    const times = (now.project?.markers ?? []).map((one) => one.time_us).sort((a, b) => a - b);
    const next = direction > 0 ? times.find((time) => time > at + now.frameUs / 2) : [...times].reverse().find((time) => time < at - now.frameUs / 2);
    if (next === undefined) { now.toast(times.length ? (direction > 0 ? "后面没有标记了" : "前面没有标记了") : "还没有标记，按 M 在播放头处加一个"); return; }
    now.playback.seek(next);
  };

  // ---------- 工具栏的开关 ----------
  /** 打开主轨磁吸：主轨上的空隙一次合拢（一步撤销）；关掉不动时间线 */
  const packMain = async () => {
    const plan = rippleEdits(latest.current.project, { kind: "pack" }, { magnet: true, linkage: timelinePrefs().linkage });
    if (!plan) return;
    if ("refused" in plan) { latest.current.toast(plan.refused); return; }
    if (plan.edits.length && (await settle())) await latest.current.runEdits(plan.edits, plan.label);
  };
  const togglePref = (key: keyof TimelinePrefs, fromKey = false) => {
    const next = !timelinePrefs()[key];
    setTimelinePref(key, next);
    // 按快捷键切的看不到按钮，说一声现在是开是关
    if (fromKey) latest.current.toast(`${PREF_TEXT[key].name} · ${next ? PREF_TEXT[key].on : PREF_TEXT[key].off}`);
    if (key === "magnet" && next) void packMain();
  };

  // ---------- 字幕：在播放头处补一条 ----------
  /** 字幕轨的「+」、没有字幕时刻度尺左边的「+ 字幕」：在播放头处加一条「新字幕」，长 2 秒，碰到下一条就截短 */
  const addSubtitle = (trackId: string | null) => {
    const now = latest.current;
    const at = toFrame(now.playback.timeRef.current, now.frameUs);
    const lines = trackId ? now.project?.tracks.find((one) => one.id === trackId)?.segments ?? [] : [];
    if (lines.some((line) => line.timeline.start_us <= at && at < line.timeline.start_us + line.timeline.duration_us)) { now.toast("播放头这里已经有字幕了，挪开一点再加"); return; }
    const next = Math.min(Number.POSITIVE_INFINITY, ...lines.filter((line) => line.timeline.start_us > at).map((line) => line.timeline.start_us));
    const length = Math.min(2 * US_PER_SECOND, next - at);
    if (length < 0.1 * US_PER_SECOND) { now.toast("这里放不下字幕"); return; }
    void (async () => {
      if (!(await settle())) return;
      if (trackId) latest.current.expectSelect({ trackId, atUs: at });
      await latest.current.runEdit("add_subtitle_line", { ...(trackId ? { track_id: trackId } : {}), start: at / US_PER_SECOND, duration: length / US_PER_SECOND, text: "新字幕" });
    })();
  };

  // ---------- 预览轴、刀线：跟着鼠标走 ----------
  const hideHover = () => {
    if (hoverRef.current) hoverRef.current.style.display = "none";
    if (bladeRef.current) bladeRef.current.style.display = "none";
    previewStore.set(null);
  };
  const onHover = (event: React.PointerEvent<HTMLDivElement>) => {
    const content = contentRef.current?.getBoundingClientRect();
    const now = latest.current;
    const idle = !gesture.current && event.buttons === 0 && Boolean(content);
    const line = hoverRef.current;
    if (line) {
      if (timelinePrefs().previewAxis && idle && !now.playback.playing && now.duration > 0 && !(event.target as Element).closest?.("[data-track-head], [data-ruler-head]")) {
        const at = Math.min(Math.max(0, now.duration - 1), toFrame(usAt(event.clientX), now.frameUs));
        line.style.display = "block";
        line.style.left = `${HEAD + at * view.current.px}px`;
        previewStore.set(at);
      } else if (line.style.display !== "none") { line.style.display = "none"; previewStore.set(null); }
    }
    const blade = bladeRef.current;
    if (blade && content) {
      const clip = modeRef.current === "split" && idle ? (event.target as Element).closest?.("[data-clip]") : null;
      if (clip) {
        const rect = clip.getBoundingClientRect();
        Object.assign(blade.style, { display: "block", left: `${event.clientX - content.left}px`, top: `${rect.top - content.top}px`, height: `${rect.height}px` });
      } else blade.style.display = "none";
    }
  };
  // 关了预览轴、开始播放：画面回到播放头
  useEffect(() => { if (!prefs.previewAxis || playback.playing) hideHover(); }, [prefs.previewAxis, playback.playing]);
  useEffect(() => () => previewStore.set(null), [previewStore]);

  /** 轨道空白处：拖满 5px 是框选（⇧ / ⌘ 是往已选的上加），单击是挪播放头、取消选中（松手时才挪，框选不会把播放头甩到框的起点） */
  const pressEmpty = (event: PointerEvent) => {
    const additive = event.shiftKey || (IS_MAC ? event.metaKey : event.ctrlKey);
    const base = additive ? [...latest.current.selection.ids] : [];
    const fromUs = usAt(event.clientX);
    const fromRow = rowAt(event.clientY);
    const fromY = contentY(event.clientY);
    const hitsAt = (moved: PointerEvent) => marqueeHits(view.current.rows, { fromUs, toUs: usAt(moved.clientX), fromRow, toRow: rowAt(moved.clientY) });
    // 框到的没变就沿用上一帧那份，轨道行不用跟着重画
    let hits: ReadonlySet<string> = new Set(base);
    follow(event, {
      lift: (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy)) >= MARQUEE_LIFT_PX,
      autoScroll: true,
      frame: (moved) => {
        const toUs = usAt(moved.clientX);
        const toY = contentY(moved.clientY);
        const px = view.current.px;
        const next = new Set([...base, ...hitsAt(moved)]);
        if (next.size !== hits.size || [...next].some((one) => !hits.has(one))) hits = next;
        setMarquee({ left: HEAD + Math.min(fromUs, toUs) * px, width: Math.abs(toUs - fromUs) * px, top: Math.min(fromY, toY), height: Math.abs(toY - fromY), hits });
      },
      end: (released, dragged) => {
        setMarquee(null);
        if (!released) return;
        const pick = latest.current.selection;
        if (dragged) {
          const ids = [...new Set([...base, ...hitsAt(released)])];
          if (ids.length) pick.set(ids, pick.primary && ids.includes(pick.primary) ? pick.primary : undefined);
          else pick.clear();
          return;
        }
        if (additive) return;
        pick.clear();
        latest.current.playback.seek(fromUs);
      },
    });
  };

  /**
   * 按在片段上：按下就选中（⌘ 点击加减、⇧ 点击追加），不挪播放头。按住中间拖是挪（选了一组就整组挪，上下拖换轨道，⌥ 拖复制），
   * 按住两头是裁剪。点在一组里的某段，松手时没拖开才收成只选它。
   */
  const pressClip = (event: PointerEvent, id: string, edge: string | null | undefined) => {
    const start = latest.current;
    const found = findSegment(start.project, id);
    if (!found) return;
    const pick = start.selection;
    const inGroup = pick.ids.includes(id);
    // 分割工具：在点的地方切开这一段（不吸附，照 openfilm）；⌘ 点、⇧ 点在这个工具下不起作用
    if (modeRef.current === "split") {
      pick.set([id], id);
      if (!start.editable) { start.toast(start.notEditableReason ?? BUSY); return; }
      void start.split(id, toFrame(usAt(event.clientX), start.frameUs));
      return;
    }
    if (IS_MAC ? event.metaKey : event.ctrlKey) { pick.toggle(id); return; }
    const mode: Draft["mode"] = edge === "start" || edge === "end" ? edge : "move";
    const copy = mode === "move" && event.altKey;
    let group = [id];
    if (mode === "move" && event.shiftKey && !inGroup) { pick.add(id); group = [...pick.ids, id]; }
    else if (inGroup) { pick.add(id); if (mode === "move") group = [...pick.ids]; }
    else pick.set([id], id);
    const collapse = inGroup && !event.shiftKey && pick.ids.length > 1;
    const lift = mode === "move" ? (dx: number, dy: number) => Math.max(Math.abs(dx), Math.abs(dy)) >= MOVE_LIFT_PX : (dx: number) => Math.abs(dx) >= TRIM_LIFT_PX;
    const collapseOnClick = (released: PointerEvent | null, dragged: boolean) => { if (released && !dragged && collapse) latest.current.selection.set([id], id); };
    const px = view.current.px;
    // 不能改（AI 在剪、上一个改动还没回来）或者键盘微调还没发完：只选中，拖开时说一声为什么
    if (!start.editable || nudge.current || !(px > 0)) {
      follow(event, { lift, frame: (_moved, stop) => { if (!nudge.current) latest.current.toast(latest.current.notEditableReason ?? BUSY); stop(); }, end: collapseOnClick });
      return;
    }
    const before = start.project;
    const reachUs = SNAP_PX / px;
    // 工具栏关了吸附：不吸，但压到邻居一点点照样推到贴住；主轨磁吸开着时落到主轨是插进去、拖主轨片段的边是波纹裁剪
    const toggles = timelinePrefs();
    const snapUs = toggles.snap ? reachUs : 0;
    const mainId = mainTrackOf(before)?.id ?? null;
    const pressUs = usAt(event.clientX);
    const pressY = contentY(event.clientY);
    const homeRow = view.current.rows.findIndex((track) => track.id === found.track.id);
    const item = "path" in found.segment ? start.mediaById.get(mediaIdFromPath(found.segment.path) ?? "") : undefined;
    const edgeOf = (range: EditTimeRange) => (mode === "start" ? range.start_us : range.start_us + range.duration_us);
    // 最后一帧算落点用的参数：松手时工程变了，按它在新工程上重新算
    let moveSpec: MoveSpec | null = null;
    let trimCtx: Parameters<typeof planTrim>[4] | null = null;
    let moved: MovePlan | null = null;
    let trimmed: TrimPlan | null = null;
    let shown: Draft | null = null;
    /**
     * 松手后发：先把各区域攒着的发掉、等看板自己在路上的改动回来（画面攒着的微调、详情卡里改的数），
     * 工程变了 build 就按画出来的落点在新工程上重新算。落点一直画着，回来或失败才撤掉。
     */
    const submit = (held: Draft, build: (base: EditProject | null) => BoardEdit[] | { edits: BoardEdit[]; label: string }) => {
      setDraft(held);
      void (async () => {
        try {
          if (!(await settle())) return;
          const built = build(latest.current.project);
          const { edits, label } = Array.isArray(built) ? { edits: built, label: undefined } : built;
          if (edits.length) await latest.current.runEdits(edits, label);
        } finally { setDraft((value) => (value === held ? null : value)); }
      })();
    };
    follow(event, {
      lift,
      autoScroll: true,
      edits: true,
      frame: (pointer, stop) => {
        const now = latest.current;
        if (!now.editable && now.notEditableReason !== BUSY) { stop(); return; }
        const deltaUs = usAt(pointer.clientX) - pressUs;
        const playheadUs = now.playback.timeRef.current;
        if (mode === "move") {
          const row = rowAt(pointer.clientY);
          const inside = row >= 0 && row < view.current.rows.length;
          moveSpec = { ids: group, lead: id, deltaUs, rowDelta: inside ? row - homeRow : null, copy, playheadUs, reachUs, snapUs, insertTrackId: toggles.magnet ? mainId : null, frameUs: now.frameUs };
          moved = planMove(before, moveSpec);
          if (!moved) { stop(); return; }
          const lead = moved.items.find((one) => one.id === id)!;
          const offsetY = contentY(pointer.clientY) - pressY;
          shown = {
            kind: "drag", mode, copy, items: moved.items, offsetY, target: !moved.refused && inside && row !== homeRow ? view.current.rows[row]!.id : null, refused: moved.refused, snappedUs: moved.snappedUs,
            tip: { text: moved.refused ?? moveTip(lead.timeline.start_us, copy), x: HEAD + lead.timeline.start_us * px, y: RULER + homeRow * ROW + 3 + offsetY - 21, center: false },
          };
          document.body.style.cursor = moved.refused ? "not-allowed" : copy ? "copy" : "grabbing";
        } else {
          trimCtx = { playheadUs, reachUs, snapUs, ripple: toggles.magnet && found.track.id === mainId, frameUs: now.frameUs, mediaDurationUs: item?.durationUs ?? null };
          trimmed = planTrim(before, found.segment, mode, deltaUs, trimCtx);
          shown = {
            kind: "drag", mode, copy: false, items: [{ id, fromTrackId: found.track.id, trackId: found.track.id, timeline: trimmed.timeline }], offsetY: 0, target: null, refused: null, snappedUs: trimmed.snappedUs,
            tip: {
              text: trimTip(found.segment.timeline.duration_us, trimmed.timeline.duration_us, trimmed.sourceEnd, trimmed.floorHit),
              x: HEAD + edgeOf(trimmed.timeline) * px, y: RULER + homeRow * ROW + 3 - 21, center: true,
            },
          };
          document.body.style.cursor = "ew-resize";
        }
        setDraft(shown);
      },
      end: (released, dragged) => {
        collapseOnClick(released, dragged);
        const last = shown;
        if (!released || !dragged || !last) { setDraft(null); return; }
        if (mode === "move") {
          const plan = moved as MovePlan | null;
          const spec = moveSpec as MoveSpec | null;
          // 放不下：不发请求，片段回原位
          if (!plan || !spec || plan.refused) { setDraft(null); if (plan?.refused) latest.current.toast(plan.refused); return; }
          if (!moveEdits(plan, before, copy).length) { setDraft(null); return; }
          const lead = plan.items.find((one) => one.id === id)!;
          // 松手后停在落点等新工程进来：换了轨道就落进那一行
          submit({ ...last, offsetY: (view.current.rows.findIndex((track) => track.id === lead.trackId) - homeRow) * ROW, target: null, snappedUs: null, tip: null }, (base) => {
            const now = base === before ? found : findSegment(base, id);
            const final = base === before ? plan : now ? planMove(base, { ...spec, deltaUs: lead.timeline.start_us - now.segment.timeline.start_us }) : null;
            if (!final || final.refused) { if (final?.refused) latest.current.toast(final.refused); return []; }
            const items = final.items.map((one) => ({ id: one.id, trackId: one.trackId, start_us: one.timeline.start_us }));
            const hand_us = pressUs + spec.deltaUs;
            const ripple = rippleEdits(base, copy ? { kind: "copy", items, hand_us } : { kind: "move", items, hand_us }, timelinePrefs());
            if (ripple && "refused" in ripple) { latest.current.toast(ripple.refused); return []; }
            if (ripple) { stuckNote(ripple.stuck); return { edits: ripple.edits, label: ripple.label }; }
            const edits = moveEdits(final, base, copy);
            const landed = final.items.find((one) => one.id === id)!;
            if (copy && edits.length) latest.current.expectSelect({ trackId: landed.trackId, atUs: landed.timeline.start_us });
            return edits;
          });
          return;
        }
        const plan = trimmed as TrimPlan | null;
        const ctx = trimCtx as Parameters<typeof planTrim>[4] | null;
        const was = found.segment.timeline;
        if (!plan || !ctx || (plan.timeline.start_us === was.start_us && plan.timeline.duration_us === was.duration_us)) { setDraft(null); return; }
        submit({ ...last, snappedUs: null, tip: null }, (base) => {
          const now = base === before ? found : findSegment(base, id);
          if (!now) return [];
          const final = base === before ? plan : planTrim(base, now.segment, mode, edgeOf(plan.timeline) - edgeOf(now.segment.timeline), ctx);
          const at = now.segment.timeline;
          if (final.timeline.start_us === at.start_us && final.timeline.duration_us === at.duration_us) return [];
          const args = trimArgs(now.segment, mode, final);
          const ripple = rippleEdits(base, { kind: "trim", id, timeline: final.timeline, source: final.source, args }, timelinePrefs());
          if (ripple && "refused" in ripple) { latest.current.toast(ripple.refused); return []; }
          if (ripple) { stuckNote(ripple.stuck); return { edits: ripple.edits, label: ripple.label }; }
          return [{ name: "update_clip", arguments: args }];
        });
      },
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    // Mac 上 Control+点击是右键：交给 onContextMenu，不当成按下（不然松手时会把选中收成一段、挪播放头）
    if (event.button !== 0 || (IS_MAC && event.ctrlKey)) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest("[data-track-head]") || target.closest("[data-ruler-head]")) return;
    const pin = target.closest("[data-marker]");
    if (pin) { pressMarker(event, Number(pin.getAttribute("data-marker"))); return; }
    if (target.closest("[data-ruler]")) { scrub(event); return; }
    const clip = target.closest("[data-clip]");
    if (clip) { pressClip(event, clip.getAttribute("data-clip") ?? "", target.closest("[data-edge]")?.getAttribute("data-edge")); return; }
    if (target.closest("[data-rows]")) pressEmpty(event);
  };

  // ---------- 键盘微调（C7）：停手 350ms 才合成一次挪动，请求在路上时接着攒，回来再发下一批 ----------
  const showNudge = (held: Nudge, delta: number) => setDraft({
    kind: "nudge", mode: "move", copy: false, offsetY: 0, target: null, refused: null, snappedUs: null, tip: null,
    items: held.held.map((one) => ({ id: one.id, fromTrackId: one.trackId, trackId: one.trackId, timeline: { start_us: one.timeline.start_us + delta, duration_us: one.timeline.duration_us } })),
  });
  const dropNudge = () => {
    if (nudge.current?.timer) clearTimeout(nudge.current.timer);
    nudge.current = null;
    setDraft((value) => (value?.kind === "nudge" ? null : value));
  };
  const sendNudge = (held: Nudge): Promise<boolean> => {
    held.sent = held.delta;
    // 排好先后（采集器一条条查重叠）；只排发出去的这份，held.held 的顺序不动，nudgeStep 拿第一段当带头的
    const edits = moveOrder(held.held, held.sent).map((one) => ({ name: "move_clip" as const, arguments: { clip_id: one.id, start: (one.timeline.start_us + held.sent) / US_PER_SECOND } }));
    const flight = latest.current.runEdits(edits).then((ok) => {
      held.flight = null;
      if (nudge.current !== held) return ok;
      if (!ok) { dropNudge(); return false; }
      // 回来了：在路上又按的那几下，按新位置接着攒
      held.held = held.held.map((one) => ({ ...one, timeline: { ...one.timeline, start_us: one.timeline.start_us + held.sent } }));
      held.delta -= held.sent;
      held.sent = 0;
      if (!held.delta) dropNudge();
      else if (!held.timer) void sendNudge(held);
      return true;
    });
    held.flight = flight;
    return flight;
  };
  /** 立刻把攒着的发出去，等都回来；发出去过（工程会变）返回 true */
  const flushNudge = async (): Promise<boolean> => {
    let sent = false;
    for (let held = nudge.current; held; held = nudge.current) {
      if (held.timer) { clearTimeout(held.timer); held.timer = null; }
      if (held.flight) { sent = (await held.flight) || sent; continue; }
      if (held.delta === held.sent) { dropNudge(); break; }
      sent = (await sendNudge(held)) || sent;
    }
    return sent;
  };
  /** ⌘Z 时还有没发出去的：丢掉本地预览就当撤销了这一下（在路上的那部分照常落地） */
  const discardNudge = () => {
    const held = nudge.current;
    if (!held || held.delta === held.sent) return false;
    if (held.timer) { clearTimeout(held.timer); held.timer = null; }
    if (held.flight) { held.delta = held.sent; showNudge(held, held.sent); return true; }
    dropNudge();
    return true;
  };
  const nudgeBy = (direction: 1 | -1, big: boolean): boolean | void => {
    const now = latest.current;
    let held = nudge.current;
    // 换了选中、上一组还在发：这一下先不算
    if (held && held.ids.join(",") !== now.selection.ids.join(",")) return undefined;
    if (!held) {
      if (!now.editable) { now.toast(now.notEditableReason ?? BUSY); return undefined; }
      // 主轨磁吸开着：主轨上首尾相接，不能一帧帧挪（照 openfilm），拖动来重排
      const mainId = timelinePrefs().magnet ? mainTrackOf(now.project)?.id : null;
      if (mainId && now.selection.ids.some((one) => findSegment(now.project, one)?.track.id === mainId)) { now.toast("主轨磁吸开着，主轨上的片段不能微移，拖动来重排"); return undefined; }
      const clips = now.selection.ids.flatMap((one): HeldClip[] => {
        const found = findSegment(now.project, one);
        return found ? [{ id: one, trackId: found.track.id, timeline: found.segment.timeline }] : [];
      });
      if (!clips.length) return false;
      held = { ids: [...now.selection.ids], held: clips, delta: 0, sent: 0, timer: null, flight: null };
      nudge.current = held;
    }
    held.delta = nudgeStep(now.project, held.held, held.delta, direction * (big ? 10 : 1), now.canvas.fps);
    showNudge(held, held.delta);
    if (held.timer) clearTimeout(held.timer);
    const waiting = held;
    waiting.timer = setTimeout(() => {
      waiting.timer = null;
      if (nudge.current !== waiting || waiting.flight) return;
      if (waiting.delta === waiting.sent) dropNudge();
      else void sendNudge(waiting);
    }, NUDGE_WRITE_MS);
    return undefined;
  };
  const flushRef = useRef(flushNudge);
  flushRef.current = flushNudge;
  useHeldEdit({ flush: () => flushRef.current(), discard: () => discardNudge() });
  // 换选中、按下任何地方（点按钮、开始拖）之前，攒着的先发出去
  const selectionKey = selection.ids.join(",");
  useEffect(() => {
    const held = nudge.current;
    if (held && held.ids.join(",") !== selectionKey) void flushRef.current();
  }, [selectionKey]);
  useEffect(() => {
    if (!web) return undefined;
    const down = () => { if (nudge.current) void flushRef.current(); };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);
  // 刚把微调发出去、接着要按新位置算（粘贴、⌘D、Q/W）：等新工程画出来
  const rendered = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    for (const resolve of rendered.current) resolve();
    rendered.current.clear();
  }, [project]);
  /**
   * 自己发改动（粘贴、⌘D、Q/W、拖完松手）之前：时间线和画面攒着的微调都先发掉，等看板按回来的新工程画完，
   * 再按新位置算（画面上刚挪的一段紧接着 ⌘D，副本才带着挪过的样子）。等不到能改返回 false（已经弹过原因）。
   */
  const settle = async (): Promise<boolean> => {
    const revision = latest.current.project?.revision;
    const sent = await flushNudge();
    await latest.current.flushHeld();
    if (sent && latest.current.project?.revision === revision) await new Promise<void>((resolve) => { rendered.current.add(resolve); setTimeout(resolve, 500); });
    return untilEditable();
  };

  const projectId = project?.id ?? null;
  useEffect(() => {
    gesture.current?.cancel();
    dropNudge();
    setDraft(null);
    setMarquee(null);
    setZoomPx(null);
    setMarkerCard(null);
    setMarkerDrag(null);
  }, [projectId]);

  // ---------- 命令：复制粘贴（D6）、Q/W（C8）、静音（D8）、层级（D9） ----------
  const copyClips = (ids: readonly string[]) => {
    const { project: now, toast } = latest.current;
    const usable = ids.filter((one) => { const found = findSegment(now, one); return found && found.track.kind !== "subtitle"; });
    if (!usable.length) { toast("字幕不能单独复制"); return; }
    clipboard.current = usable;
    toast(`复制了${usable.length > 1 ? ` ${usable.length} 段` : "这一段"}，按 ${shortcutText("paste")} 粘到播放头处`);
  };
  const putCopies = async (make: () => CopyPlan): Promise<boolean> => {
    if (!(await settle())) return false;
    const plan = make();
    if ("refused" in plan) { latest.current.toast(plan.refused); return false; }
    latest.current.expectSelect(plan.lead);
    return latest.current.runEdits(plan.edits);
  };
  const paste = () => putCopies(() => planPaste(latest.current.project, clipboard.current, latest.current.playback.timeRef.current));
  const duplicate = (ids: readonly string[]) => putCopies(() => planDuplicate(latest.current.project, ids));
  /** 一段裁到播放头要发什么：播放头不在中间是 null，被关键帧、淡入淡出卡住是 refused */
  const trimAtPlayhead = (id: string, edge: TrimEdge) => {
    const now = latest.current;
    const found = findSegment(now.project, id);
    const item = found && "path" in found.segment ? now.mediaById.get(mediaIdFromPath(found.segment.path) ?? "") : undefined;
    return found ? trimToPlayhead(now.project, found.segment, edge, now.playback.timeRef.current, item?.durationUs ?? null) : null;
  };
  /** 选中的几段里播放头在中间的，开头（Q）或结尾（W）裁到播放头；一批发，一步撤销 */
  const trimClips = (ids: readonly string[], edge: TrimEdge) => {
    if (!ids.length) { latest.current.toast("先选中要裁的片段"); return; }
    void (async () => {
      if (!(await settle())) return;
      const now = latest.current;
      const results = ids.map((one) => trimAtPlayhead(one, edge));
      const edits = results.flatMap((result) => (result && "args" in result ? [{ name: "update_clip" as const, arguments: result.args }] : []));
      const refused = results.find((result) => result && "refused" in result);
      if (!edits.length) {
        now.toast(refused && "refused" in refused ? refused.refused : ids.length > 1 ? "播放头不在选中的片段中间，裁不了" : "播放头不在这段中间，裁不了");
        return;
      }
      // 只裁一段时，主轨磁吸、联动照波纹裁剪算（后面的跟上、跟着它的跟着走）
      if (edits.length === 1) {
        const args = edits[0]!.arguments;
        const found = findSegment(now.project, String(args.clip_id));
        if (found) {
          const start = args.start === undefined ? found.segment.timeline.start_us : Math.round(Number(args.start) * US_PER_SECOND);
          const source = args.source_duration === undefined ? null : {
            start_us: args.source_start === undefined && "source" in found.segment ? found.segment.source.start_us : Math.round(Number(args.source_start) * US_PER_SECOND),
            duration_us: Math.round(Number(args.source_duration) * US_PER_SECOND),
          };
          const intent: RippleIntent = { kind: "trim", id: found.segment.id, timeline: { start_us: start, duration_us: Math.round(Number(args.duration) * US_PER_SECOND) }, source, args };
          const ripple = rippleEdits(now.project, intent, timelinePrefs());
          if (ripple && "refused" in ripple) { now.toast(ripple.refused); return; }
          if (ripple) { if (await now.runEdits(ripple.edits, ripple.label)) stuckNote(ripple.stuck); return; }
        }
      }
      // 选了几段、有的被关键帧卡住：能裁的照裁，再说一声
      if (await now.runEdits(edits) && refused && "refused" in refused) now.toast(`有的片段没裁：${refused.refused}`);
    })();
  };
  const toggleMute = useCallback((trackId: string) => {
    void (async () => {
      await latest.current.flushHeld();
      const track = latest.current.project?.tracks.find((one) => one.id === trackId);
      if (track) await latest.current.runEdit("update_track", { track_id: trackId, mute: !track.mute });
    })();
  }, []);
  const moveTrack = (trackId: string, place: "top" | "bottom") => {
    void (async () => {
      await latest.current.flushHeld();
      const order = trackOrderWith(latest.current.project?.tracks ?? [], trackId, place);
      if (order) await latest.current.runEdit("reorder_tracks", { track_ids: order });
    })();
  };

  useBoardKeys({
    copy: () => (latest.current.selection.ids.length ? copyClips(latest.current.selection.ids) : false),
    paste: () => { if (!clipboard.current.length) return false; void paste(); return undefined; },
    duplicate: () => { const ids = latest.current.selection.ids; if (!ids.length) return false; void duplicate(ids); return undefined; },
    "trim-start": () => trimClips(latest.current.selection.ids, "start"),
    "trim-end": () => trimClips(latest.current.selection.ids, "end"),
    "nudge-back": (event) => nudgeBy(-1, event.shiftKey),
    "nudge-forward": (event) => nudgeBy(1, event.shiftKey),
  });
  useBoardKeys({
    "select-mode": () => setMode("select"),
    "split-mode": () => setMode("split"),
    "add-marker": () => addMarker(),
    "next-marker": () => jumpMarker(1),
    "prev-marker": () => jumpMarker(-1),
    "toggle-snap": () => togglePref("snap", true),
    "toggle-magnet": () => togglePref("magnet", true),
    "toggle-linkage": () => togglePref("linkage", true),
    "toggle-preview-axis": () => togglePref("previewAxis", true),
  });
  // 缩放只在最后一次按在轨道区时接，别处的 ⌘= ⌘0 照旧
  useBoardKeys({
    "zoom-in": () => zoomTo(view.current.px * ZOOM_STEP),
    "zoom-out": () => zoomTo(view.current.px / ZOOM_STEP),
    "zoom-reset": () => zoomTo(null),
  }, { area: "timeline" });

  // ---------- 右键菜单 ----------
  const orderItems = (trackId: string, reason: string | null): MenuEntry[] => {
    const all = latest.current.project?.tracks ?? [];
    return [
      { id: "top", label: "整条轨道移到最上层", disabled: reason ?? (trackOrderWith(all, trackId, "top") ? null : "这条轨道已经在最上层了"), onSelect: () => moveTrack(trackId, "top") },
      { id: "bottom", label: "整条轨道移到最下层", disabled: reason ?? (trackOrderWith(all, trackId, "bottom") ? null : "这条轨道已经在最下层了"), onSelect: () => moveTrack(trackId, "bottom") },
    ];
  };
  const pasteItem = (reason: string | null): MenuEntry => ({
    id: "paste", label: "粘贴到播放头处", shortcut: "paste", disabled: reason ?? (clipboard.current.length ? null : "还没有复制过片段"), onSelect: () => { void paste(); },
  });
  const clipMenu = (id: string, ids: readonly string[]): MenuEntry[] => {
    const now = latest.current;
    const found = findSegment(now.project, id);
    if (!found) return [];
    const { segment, track } = found;
    const reason = now.editable ? null : now.notEditableReason ?? BUSY;
    const many = ids.length > 1;
    const cut = splitOffset(segment, now.playback.timeRef.current) === null;
    const trimRefusal = (edge: TrimEdge) => {
      const result = trimAtPlayhead(id, edge);
      return !result ? "播放头不在这段中间，裁不了" : "refused" in result ? result.refused : null;
    };
    const media = segment.kind === "video" || segment.kind === "audio" ? segment : null;
    const noCopy = ids.every((one) => findSegment(now.project, one)?.track.kind === "subtitle") ? "字幕不能单独复制" : null;
    const entries: MenuEntry[] = [
      { id: "split", label: "在播放头处切开", shortcut: "split", disabled: reason ?? (cut ? "播放头不在这段中间，切不开" : null), onSelect: () => { void now.split(id); } },
      { id: "trim-start", label: "裁掉播放头前面", shortcut: "trim-start", disabled: reason ?? trimRefusal("start"), onSelect: () => trimClips([id], "start") },
      { id: "trim-end", label: "裁掉播放头后面", shortcut: "trim-end", disabled: reason ?? trimRefusal("end"), onSelect: () => trimClips([id], "end") },
    ];
    if (media && media.speed !== 1) {
      const stop = segment.timeline.start_us + media.source.duration_us;
      const crowded = track.segments.some((other) => other.id !== id && other.timeline.start_us >= segment.timeline.start_us + segment.timeline.duration_us - 1_000 && other.timeline.start_us < stop);
      entries.push({
        id: "speed", label: "恢复原速", disabled: reason ?? (crowded ? "恢复原速后会变长，压到后面的片段" : null),
        onSelect: () => { void now.flushHeld().then(() => latest.current.runEdit("update_clip", { clip_id: id, speed: 1, duration: media.source.duration_us / US_PER_SECOND, source_duration: media.source.duration_us / US_PER_SECOND })); },
      });
    }
    if (segment.kind !== "audio" && segment.kind !== "track_effect" && segment.kind !== "track_filter") {
      entries.push({
        id: "reset", label: "重置位置大小", disabled: reason ?? (segment.transform ? null : "这段没调过位置和大小"),
        // 画面上还攒着这段的方向键微调时先发出去，不然它晚到会把重置盖掉
        onSelect: () => { void now.flushHeld().then(() => latest.current.runEdit("update_clip", { clip_id: id, transform: null })); },
      });
    }
    entries.push(
      { id: "seek", label: "播放头移到这段开头", onSelect: () => now.playback.seek(segment.timeline.start_us) },
      { id: "refer", label: many ? `把选中的 ${ids.length} 段引用到对话` : "引用到对话", onSelect: () => now.refer(ids.map((one) => ({ kind: "clip" as const, clipId: one }))) },
      { id: "sep-copy", separator: true },
      { id: "copy", label: many ? `复制选中的 ${ids.length} 段` : "复制", shortcut: "copy", disabled: noCopy, onSelect: () => copyClips(ids) },
      pasteItem(reason),
      { id: "duplicate", label: many ? `把选中的 ${ids.length} 段复制一份` : "复制一份", shortcut: "duplicate", disabled: reason ?? noCopy, onSelect: () => { void duplicate(ids); } },
      { id: "sep-track", separator: true },
      ...orderItems(track.id, reason),
      { id: "sep-delete", separator: true },
      { id: "delete", label: many ? `删除选中的 ${ids.length} 段` : "删除", shortcut: "remove", danger: true, disabled: reason, onSelect: () => { void now.removeSelected(); } },
    );
    return entries;
  };
  const trackMenu = (trackId: string): MenuEntry[] => {
    const now = latest.current;
    const track = now.project?.tracks.find((one) => one.id === trackId);
    if (!track) return [];
    const reason = now.editable ? null : now.notEditableReason ?? BUSY;
    const sounds = track.track_type === "video" || track.track_type === "audio";
    return [
      ...(sounds ? [{ id: "mute", label: track.mute ? "取消静音" : "这条轨道静音", disabled: reason, onSelect: () => toggleMute(trackId) }, { id: "sep-mute", separator: true as const }] : []),
      pasteItem(reason),
      { id: "sep-track", separator: true },
      ...orderItems(trackId, reason),
    ];
  };
  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const clipId = target.closest?.("[data-clip]")?.getAttribute("data-clip");
    const trackId = target.closest?.("[data-track-head]")?.getAttribute("data-track-head") ?? target.closest?.("[data-lane]")?.getAttribute("data-lane");
    if (!clipId && !trackId) return;
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    if (clipId) {
      // 右键先选中它（在已选的一组里就保留这一组），免得菜单删错片段
      const pick = latest.current.selection;
      const ids = pick.ids.includes(clipId) ? [...pick.ids] : [clipId];
      if (pick.ids.includes(clipId)) pick.add(clipId);
      else pick.set([clipId], clipId);
      menu.open(at, clipMenu(clipId, ids));
    } else if (trackId) menu.open(at, trackMenu(trackId));
  };

  // ---------- 画 ----------
  const pick = useCallback((id: string) => latest.current.selection.set([id], id), []);
  const ringed = useMemo(() => marquee?.hits ?? new Set(selection.ids), [marquee, selection.ids]);
  const places = useMemo(() => {
    const out = new Map<string, Map<string, ClipPlace>>();
    if (!draft) return out;
    for (const item of draft.items) {
      const row = out.get(item.fromTrackId) ?? new Map<string, ClipPlace>();
      row.set(item.id, { timeline: item.timeline, mode: draft.mode, offsetY: draft.mode === "move" ? draft.offsetY : 0, refused: Boolean(draft.refused), copy: draft.copy, floating: draft.kind === "drag" && draft.mode === "move" });
      out.set(item.fromTrackId, row);
    }
    return out;
  }, [draft]);
  const inView = (x: number) => x >= scrollX - 1 && x <= scrollX + viewWidth + 1;
  const playheadX = Math.min(time, duration) * pxPerUs;
  const guideX = draft?.snappedUs !== null && draft?.snappedUs !== undefined ? draft.snappedUs * pxPerUs : null;

  const lasting = lastingReason(board.notEditableReason);
  const tool = (label: string, title: string, blocked: string | null, onClick: () => void, icon: React.ReactNode, pressed?: boolean) => <button
    type="button"
    // 按下的开关靠主题的 on 画（墨底白图标），行内底色会被主题盖掉
    data-ws={pressed ? "btn square on" : "btn square"}
    aria-label={label}
    aria-disabled={blocked ? true : undefined}
    aria-pressed={pressed}
    title={blocked ?? title}
    // 点完焦点还留在原处，接着按快捷键照样管用
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => { if (!blocked) onClick(); }}
    style={{ ...toolButton, cursor: blocked ? "default" : "pointer", opacity: blocked ? 0.4 : 1, ...(pressed ? toolPressed : null) }}
  >{icon}</button>;
  /** 开关：开着是强调色底；悬停说现在开着会怎样、关着会怎样 */
  const toggle = (key: Exclude<keyof TimelinePrefs, "captions">, Icon: React.ComponentType<{ size?: number; color?: string }>) => {
    const on = prefs[key];
    const text = PREF_TEXT[key];
    return tool(text.name, `${text.name}（${shortcutText(PREF_KEYS[key])}）\n${on ? text.on : text.off}`, null, () => togglePref(key), <Icon size={15} color={on ? color.buttonText : color.text} />, on);
  };
  const markers = project?.markers ?? [];
  const markerAt = (time: number) => (markerDrag?.from === time ? markerDrag.to : time);
  const markerGuide = markerDrag ? markerDrag.to : markerHover;
  const cardMarker = markerCard === null ? null : markers.find((one) => one.time_us === markerCard) ?? null;
  // 卡片对着的标记没了（拖走、撤销、AI 改了）就关掉，免得以后那一刻又有标记时卡片自己弹回来抢焦点；刚加的标记还没进工程时不算
  const cardShown = useRef<number | null>(null);
  useEffect(() => {
    if (cardMarker) cardShown.current = cardMarker.time_us;
    else if (markerCard !== null && cardShown.current === markerCard) { cardShown.current = null; setMarkerCard(null); }
  }, [cardMarker, markerCard]);
  // 缩放滑条：按对数走（openfilm 的 zoomToSlider），最窄一屏 1 秒、最宽成片的 4 倍；工具栏窄了先藏它
  const zoomSpan = zoom.max > zoom.min ? Math.log(zoom.max / zoom.min) : 0;
  const sliderValue = zoomSpan > 0 ? Math.log(pxPerUs / zoom.min) / zoomSpan : 0;

  return <View {...areaProps("timeline", "e-box", "ai-panel")} style={[styles.timeline, { height }]}>
    {/* 工具栏照 openfilm 的时间线排：选择/分割工具 · 撤销重做历史 · 加标记 · 分割 · 删除 …… 磁吸 吸附 联动 预览轴 · 缩放 · 字幕 */}
    <div role="toolbar" aria-label="时间线工具" style={toolbar} ref={(node) => { if (node && node.clientWidth !== toolbarWidth) setToolbarWidth(node.clientWidth); }}>
      <ModePicker mode={mode} onPick={setMode} />
      <span aria-hidden style={toolSeparator} />
      <HistoryControls compact />
      {tool("添加标记", `在播放头处加标记（${shortcutText("add-marker")}）；${shortcutText("next-marker")} / ${shortcutText("prev-marker")} 跳到下一个、上一个。标记只在这里用，不会带进剪映`, duration ? lasting : "时间线还是空的", addMarker, <BookmarkPlus size={15} color={color.text} />)}
      {tool("分割", `在播放头处切开选中的片段，没选就切播放头下面那段（${shortcutText("split")}）`, lasting, () => { void board.split(); }, <Scissors size={15} color={color.text} />)}
      {tool("删除", `删除选中的片段（${shortcutText("remove")}）`, lasting ?? (selection.ids.length ? null : "先点选要删的片段"), () => { void board.removeSelected(); }, <Trash2 size={15} color={color.text} />)}
      <span style={{ flex: 1 }} />
      {selection.ids.length > 1 ? <span style={{ color: color.textMuted, fontFamily: font.body, fontSize: 11.5, marginRight: 6, whiteSpace: "nowrap" }}>选了 {selection.ids.length} 段</span> : null}
      {toggle("magnet", Magnet)}
      {toggle("snap", SeparatorVertical)}
      {toggle("linkage", Paperclip)}
      {toggle("previewAxis", TextCursor)}
      <span aria-hidden style={toolSeparator} />
      {tool("缩小时间线", `缩小（${shortcutText("zoom-out")}）`, duration ? null : "时间线还是空的", () => zoomTo(view.current.px / ZOOM_STEP), <ZoomOut size={15} color={color.text} />)}
      {toolbarWidth >= 640 ? <input
        type="range" min={0} max={1} step={0.001} aria-label="缩放" title={`缩放：${Math.round((pxPerUs / zoom.fit) * 80)}%`}
        value={sliderValue} disabled={!duration || !(zoomSpan > 0)}
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => zoomTo(zoom.min * Math.exp(Number(event.currentTarget.value) * zoomSpan))}
        style={{ width: 78, flexShrink: 0, margin: "0 2px", accentColor: color.accent, cursor: duration ? "pointer" : "default" }}
      /> : null}
      {tool("放大时间线", `放大（${shortcutText("zoom-in")}）`, duration ? null : "时间线还是空的", () => zoomTo(view.current.px * ZOOM_STEP), <ZoomIn size={15} color={color.text} />)}
      {tool("适应宽度", `整条放进视图（${shortcutText("zoom-reset")}）`, duration ? null : "时间线还是空的", () => zoomTo(null), <MoveHorizontal size={15} color={color.text} />)}
      {tool("字幕", subtitleTrack ? (prefs.captions ? "画面上显示字幕（只影响这里的预览，导出照样带字幕）；点一下隐藏" : "画面上隐藏了字幕；点一下显示") : "",
        subtitleTrack ? null : "还没有字幕，在刻度尺左边点「+ 字幕」加一条", () => setTimelinePref("captions", !prefs.captions),
        prefs.captions || !subtitleTrack ? <Captions size={16} color={prefs.captions && subtitleTrack ? color.buttonText : color.text} /> : <CaptionsOff size={16} color={color.text} />, Boolean(subtitleTrack) && prefs.captions)}
    </div>
    <div
      ref={scrollRef}
      onPointerDown={(event) => onPointerDown(event.nativeEvent)}
      onPointerMove={onHover}
      onPointerLeave={hideHover}
      onContextMenu={onContextMenu}
      onScroll={(event) => setScrollX(event.currentTarget.scrollLeft)}
      style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: TOOLS, overflow: "auto", scrollbarWidth: "thin" }}
    >
      <div ref={contentRef} style={{ position: "relative", display: "flex", flexDirection: "column", width: HEAD + trackPx, minWidth: "100%", minHeight: "100%" }}>
        {/* 刻度尺：上下滚时钉在顶上；左上角那格左右滚时也钉住 */}
        <div style={{ position: "sticky", top: 0, zIndex: 7, display: "flex", flexShrink: 0, height: RULER, boxSizing: "border-box", borderBottom: `1px solid ${color.border}`, ...solid }}>
          <div data-ruler-head style={{ position: "sticky", left: 0, zIndex: 3, width: HEAD, flexShrink: 0, display: "flex", alignItems: "center", gap: 4, paddingLeft: 8, paddingRight: 4, boxSizing: "border-box", borderRight: `1px solid ${color.border}`, ...solid }}>
            <span title={tracks.length > 1 ? "上面的轨道在画面上盖住下面的" : undefined} style={{ flex: 1, minWidth: 0, color: color.textMuted, fontFamily: font.body, fontSize: 10, whiteSpace: "nowrap" }}>{tracks.length ? `${tracks.length} 条轨道` : ""}</span>
            {/* 还没有字幕：在这里起一条字幕轨（openfilm 的字幕行表头那个「+」） */}
            {!subtitleTrack && duration > 0 ? <button
              type="button" aria-label="在播放头处添加字幕" title={blocked ?? "在播放头处添加字幕：新建一条字幕轨"} aria-disabled={blocked ? true : undefined}
              onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!blocked) addSubtitle(null); }}
              style={{ ...miniButton, opacity: blocked ? 0.45 : 1, cursor: blocked ? "default" : "pointer" }}
            ><Plus size={10} color={color.textSecondary} /><span>字幕</span></button> : null}
          </div>
          <div data-ruler title="点一下或按住拖，挪播放头" style={{ position: "relative", width: trackPx, flexShrink: 0, cursor: "pointer" }}>
            {ticks.map((tick) => <div key={tick.us} style={{ position: "absolute", left: tick.x, top: 0, bottom: 0, display: "flex", alignItems: "center", paddingLeft: 3, borderLeft: `1px solid ${color.borderSoft}`, pointerEvents: "none" }}>
              <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 9.5, whiteSpace: "nowrap" }}>{tick.label}</span>
            </div>)}
            {pxPerUs > 0 ? markers.map((marker) => {
              const at = markerAt(marker.time_us);
              return <div
                key={marker.time_us}
                data-marker={marker.time_us}
                role="button"
                aria-label={`标记“${marker.label}”，${secondMark(at)}`}
                title={`${marker.label} · ${formatClock(at)}\n点一下跳过去、改名字和颜色，按住拖能挪`}
                onPointerEnter={() => setMarkerHover(marker.time_us)}
                onPointerLeave={() => setMarkerHover((value) => (value === marker.time_us ? null : value))}
                style={{ position: "absolute", left: at * pxPerUs - 7, bottom: 0, width: 14, height: 15, zIndex: 2, display: "flex", alignItems: "flex-end", justifyContent: "center", cursor: "ew-resize" }}
              >
                <span style={{
                  width: 10, height: 12, backgroundColor: markerColor(marker.color), clipPath: "polygon(0 0, 100% 0, 100% 62%, 50% 100%, 0 62%)",
                  boxShadow: markerCard === marker.time_us ? `0 0 0 1.5px ${color.text}` : undefined, opacity: markerDrag?.from === marker.time_us ? 0.85 : 1,
                }} />
              </div>;
            }) : null}
          </div>
        </div>
        <div data-rows style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column" }}>
          {rows.length ? rows.map((track) => {
            const row = places.get(track.id) ?? null;
            return <TrackRow key={track.id} track={track} pxPerUs={pxPerUs} width={trackPx} mediaById={mediaById} mediaUrl={mediaUrl} editable={editable} blocked={blocked}
              selectedIds={ringed} places={row} target={draft?.target === track.id} lifted={Boolean(row) && draft?.kind === "drag" && draft.mode === "move"} onMute={toggleMute} onPick={pick}
              blade={mode === "split"} main={track.id === mainTrackId && prefs.magnet} onAddSubtitle={addSubtitle} />;
          }) : <View style={styles.timelineEmpty}><Text style={kit.muted}>时间线还是空的，AI 加了片段会出现在这里。</Text></View>}
        </div>
        {marquee ? <div style={{
          position: "absolute", left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height, zIndex: 4, pointerEvents: "none", boxSizing: "border-box",
          border: `1px solid ${color.accent}`, backgroundColor: alpha(color.accent, 0.18), borderRadius: 2,
        }} /> : null}
        {/* 吸附参考线、播放头：贯穿刻度尺和所有轨道；滚出视图时不画（不然会盖到左边的轨道头上） */}
        {guideX !== null && inView(guideX) ? <div style={{ ...line, left: HEAD + guideX, width: 1, backgroundColor: color.accent }} /> : null}
        {markerGuide !== null && pxPerUs > 0 && inView(markerGuide * pxPerUs) ? <div style={{
          ...line, left: HEAD + markerGuide * pxPerUs, width: 0, borderLeft: `1px dashed ${markerColor(markers.find((one) => one.time_us === (markerDrag?.from ?? markerGuide))?.color)}`, opacity: markerDrag ? 1 : 0.6,
        }} /> : null}
        {/* 预览轴（鼠标在时间线上划过时那一刻）和分割工具的刀线：位置直接写样式 */}
        <div ref={hoverRef} aria-hidden style={{ ...line, display: "none", width: 1, backgroundColor: color.textMuted, zIndex: 7 }} />
        <div ref={bladeRef} aria-hidden style={{ position: "absolute", display: "none", width: 1, zIndex: 9, pointerEvents: "none", backgroundColor: color.white, boxShadow: `0 0 0 1px ${alpha(color.black, 0.55)}` }} />
        {duration > 0 && pxPerUs > 0 && inView(playheadX) ? <div style={{ ...line, left: HEAD + playheadX - 0.75, width: 1.5, backgroundColor: color.danger }} /> : null}
        {draft?.tip ? <div style={{
          position: "absolute", left: draft.tip.x, top: Math.max(0, draft.tip.y), transform: draft.tip.center ? "translateX(-50%)" : undefined, zIndex: 60, pointerEvents: "none",
          whiteSpace: "nowrap", padding: "2px 6px", borderRadius: 4, backgroundColor: draft.refused ? color.danger : color.accent, color: color.surface,
          fontFamily: font.body, fontSize: 10.5, lineHeight: "15px", fontVariantNumeric: "tabular-nums",
        }}>{draft.tip.text}</div> : null}
      </div>
    </div>
    {cardMarker && pxPerUs > 0 ? <MarkerCard
      key={cardMarker.time_us}
      marker={cardMarker}
      left={Math.max(4, Math.min(HEAD + cardMarker.time_us * pxPerUs - scrollX - 8, viewWidth + HEAD - MARKER_CARD_WIDTH - 4))}
      blocked={blocked}
      onSave={(changes) => saveMarker(cardMarker.time_us, changes)}
      onRemove={() => removeMarker(cardMarker.time_us)}
      onClose={() => setMarkerCard(null)}
    /> : null}
    {menu.element}
  </View>;
}

const line: React.CSSProperties = { position: "absolute", top: 0, bottom: 0, zIndex: 8, pointerEvents: "none" };
const toolbar: React.CSSProperties = {
  position: "absolute", left: 0, right: 0, top: 0, height: TOOLS, display: "flex", alignItems: "center", gap: 2, padding: "0 6px", boxSizing: "border-box",
  borderBottom: `1px solid ${color.borderSoft}`,
};
const toolButton: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, flexShrink: 0, padding: 0, borderRadius: radius.small, border: "1px solid transparent", backgroundColor: "transparent",
};
const toolPressed: React.CSSProperties = { backgroundColor: color.accent, borderColor: color.accent };
const toolSeparator: React.CSSProperties = { width: 1, height: 16, flexShrink: 0, margin: "0 3px", backgroundColor: color.borderSoft };
const rowButton: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, flexShrink: 0, padding: 0, borderRadius: radius.small, border: "1px solid transparent", backgroundColor: "transparent",
};
const miniButton: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 2, height: 16, flexShrink: 0, padding: "0 4px", borderRadius: radius.small, border: `1px solid ${color.borderSoft}`, backgroundColor: "transparent",
  color: color.textSecondary, fontFamily: font.body, fontSize: 9.5, lineHeight: "14px",
};

/** 工具栏开关的名字和开关说明（照 openfilm 的文案） */
const PREF_TEXT: Record<keyof TimelinePrefs, { name: string; on: string; off: string }> = {
  snap: { name: "吸附", on: "开：拖动时吸附到片段边缘、播放头和标记", off: "关：松手在哪就放在哪" },
  magnet: { name: "主轨磁吸", on: "开：主轨（最下面的视频轨）上的片段自动首尾相接，不留空隙", off: "关：主轨上的片段放在哪就在哪" },
  linkage: { name: "联动", on: "开：字幕、画中画、声音跟着下面的主轨片段一起移动、删除", off: "关：编辑主轨时只动主轨" },
  previewAxis: { name: "预览轴", on: "开：鼠标在时间线上移动，画面跟着走", off: "关：画面停在播放头处" },
  captions: { name: "字幕", on: "开：画面上显示字幕", off: "关：画面上隐藏字幕" },
};
const PREF_KEYS = { snap: "toggle-snap", magnet: "toggle-magnet", linkage: "toggle-linkage", previewAxis: "toggle-preview-axis" } as const;

/** 标记的六种颜色（照 openfilm），第一种是默认 */
const MARKER_COLORS = [
  { name: "蓝色", value: "#4C8DFF" }, { name: "绿色", value: "#3FBF6F" }, { name: "黄色", value: "#F2C94C" },
  { name: "橙色", value: "#F2994A" }, { name: "红色", value: "#EB5757" }, { name: "紫色", value: "#9B51E0" },
] as const;
/** AI 加的标记默认是白色，浅色主题上看不见：白色按强调色画 */
const markerColor = (value: string | null | undefined) => (!value || /^#f{6}$/iu.test(value) ? color.accent : value);
const shortLabel = (text: string) => [...text].slice(0, 12).join("");
const MARKER_CARD_WIDTH = 236;

/** 选择 / 分割工具：主按钮切到另一个，旁边的小箭头打开菜单（照 openfilm 的 ModePicker） */
function ModePicker({ mode, onPick }: { mode: "select" | "split"; onPick: (mode: "select" | "split") => void }) {
  const menu = useContextMenu();
  const other = mode === "split" ? "select" : "split";
  const names = { select: "选择", split: "分割：点哪切哪" } as const;
  const Icon = mode === "split" ? SquareSplitHorizontal : MousePointer2;
  return <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
    <button
      type="button" data-ws={mode === "split" ? "btn square on" : "btn square"} aria-label={`切到${names[other]}`} title={`现在是${names[mode]}；点一下切到${names[other]}（${shortcutText(other === "split" ? "split-mode" : "select-mode")}）`}
      onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(other)}
      style={{ ...toolButton, cursor: "pointer", ...(mode === "split" ? toolPressed : null) }}
    ><Icon size={15} color={mode === "split" ? color.buttonText : color.text} /></button>
    <button
      type="button" aria-label="选择工具" aria-haspopup="menu" aria-expanded={menu.isOpen} title="选择或分割工具"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        menu.open({ x: rect.left - 28, y: rect.bottom + 4 }, [
          { id: "select", label: mode === "select" ? "✓ 选择" : "选择", shortcut: "select-mode", onSelect: () => onPick("select") },
          { id: "split", label: mode === "split" ? "✓ 分割：点哪切哪" : "分割：点哪切哪", shortcut: "split-mode", onSelect: () => onPick("split") },
        ]);
      }}
      style={{ ...toolButton, width: 14, cursor: "pointer" }}
    ><ChevronDown size={11} color={color.textMuted} /></button>
    {menu.element}
  </span>;
}

/** 标记的卡片：改名字（回车、失焦保存，Esc 放弃）、换颜色、删除；按在外面或 Esc 关掉 */
function MarkerCard({ marker, left, blocked, onSave, onRemove, onClose }: {
  marker: { time_us: number; label: string; color?: string }; left: number; blocked: string | null;
  onSave: (changes: { label?: string; color?: string }) => void; onRemove: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState(marker.label);
  // 上次存下的名字（失焦存过一次，回车、按在外面不再重发）；Esc 放弃以后什么都不存
  const saved = useRef(marker.label);
  const cancelled = useRef(false);
  const save = () => {
    const next = text.trim();
    if (cancelled.current || !next || next === saved.current) return;
    saved.current = next;
    onSave({ label: next });
  };
  const cancel = () => { cancelled.current = true; onClose(); };
  useEscapeLayer(() => { cancel(); return true; }, true);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.("[data-marker]")) return;
      save();
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });
  return <div ref={ref} role="dialog" aria-label={`标记“${marker.label}”`} data-board-area="outside" style={{
    position: "absolute", left, top: TOOLS + RULER + 4, width: MARKER_CARD_WIDTH, zIndex: 70, boxSizing: "border-box", padding: 10, display: "flex", flexDirection: "column", gap: 8,
    borderRadius: radius.small, border: `1px solid ${color.border}`, backgroundColor: color.surface, boxShadow: `0 6px 24px ${alpha(color.black, 0.28)}`, fontFamily: font.body,
  }}>
    <input
      autoFocus value={text} maxLength={80} aria-label="标记名称" disabled={Boolean(blocked)}
      onChange={(event) => setText(event.currentTarget.value)}
      onKeyDown={(event) => {
        // 键不往看板走（空格、M 是打字）；Esc 就在这里放弃，看板收不到它
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); cancel(); } else if (event.key === "Enter") { save(); onClose(); }
      }}
      onBlur={save}
      style={{ height: 26, padding: "0 8px", borderRadius: radius.small, border: `1px solid ${color.border}`, backgroundColor: color.surfaceMuted, color: color.text, fontSize: 12, outline: "none" }}
    />
    <div role="radiogroup" aria-label="颜色" style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {MARKER_COLORS.map((one) => {
        const on = (marker.color ?? "").toUpperCase() === one.value || (!marker.color && one === MARKER_COLORS[0]);
        return <button
          key={one.value} type="button" role="radio" aria-checked={on} aria-label={one.name} title={one.name} disabled={Boolean(blocked)}
          // 不抢输入框的焦点：名字和颜色一起存一次
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const next = text.trim();
            if (next && !cancelled.current) saved.current = next;
            onSave({ label: next || marker.label, color: one.value });
          }}
          style={{ width: 18, height: 18, padding: 0, borderRadius: 999, cursor: "pointer", backgroundColor: one.value, border: `2px solid ${on ? color.text : "transparent"}` }}
        />;
      })}
      <span style={{ flex: 1 }} />
      <span style={{ color: color.textMuted, fontSize: 10.5, fontFamily: font.mono }}>{formatClock(marker.time_us)}</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ flex: 1, color: color.textMuted, fontSize: 10.5, lineHeight: "15px" }}>标记只在这里用，不会带进剪映</span>
      <button type="button" disabled={Boolean(blocked)} onClick={onRemove} title={blocked ?? "删除这个标记"} style={{
        height: 24, padding: "0 8px", borderRadius: radius.small, border: `1px solid ${color.border}`, backgroundColor: "transparent", color: color.danger, fontSize: 11.5, cursor: "pointer",
      }}>删除标记</button>
    </div>
  </div>;
}

const TrackRow = memo(function TrackRow({ track, pxPerUs, width, mediaById, mediaUrl, editable, blocked, selectedIds, places, target, lifted, onMute, onPick, blade, main, onAddSubtitle }: {
  track: EditTrack; pxPerUs: number; width: number; mediaById: ReadonlyMap<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null; editable: boolean;
  /** 不能改时的原因（静音钮的悬停提示） */
  blocked: string | null;
  selectedIds: ReadonlySet<string>;
  /** 这一行里正在拖的片段 */
  places: ReadonlyMap<string, ClipPlace> | null;
  /** 拖着的片段能放进这一行：浅色底 */
  target: boolean;
  /** 被拖的片段在这一行：整行提到上面，飘起来的片段不被下面的行盖住 */
  lifted: boolean;
  onMute: (trackId: string) => void;
  onPick: (id: string) => void;
  /** 分割工具：片段上是十字光标，没有裁剪把手 */
  blade: boolean;
  /** 主轨磁吸开着、这条是主轨：轨道头上标一下 */
  main: boolean;
  onAddSubtitle: (trackId: string) => void;
}) {
  const Icon = TRACK_ICON[track.track_type] ?? Film;
  const label = trackLabel(track);
  const sounds = track.track_type === "video" || track.track_type === "audio";
  const touching = useMemo(() => touchingEdges(track.segments, pxPerUs), [track.segments, pxPerUs]);
  // 转场接不接得到下一段：拖动时这一行每帧重画，先算好，不每段都扫一遍整条轨道
  const reaches = useMemo(() => new Map(track.segments.flatMap((segment) => ("transition" in segment && segment.transition ? [[segment.id, transitionReach(track.segments, segment)] as const] : []))), [track.segments]);
  const muteTitle = blocked ?? (track.mute ? "这条轨道静音了，点一下恢复声音" : "点一下把这条轨道静音");
  return <div style={{ position: "relative", zIndex: lifted ? 50 : undefined, display: "flex", flexShrink: 0, height: ROW, boxSizing: "border-box", borderBottom: `1px solid ${color.borderSoft}` }}>
    <div data-track-head={track.id} title={`${label}${main ? " · 主轨（主轨磁吸开着，片段首尾相接）" : ""}：右键可以调整层级${sounds ? "、静音" : ""}`} style={{
      position: "sticky", left: 0, zIndex: 5, width: HEAD, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, paddingLeft: 8, paddingRight: 4, boxSizing: "border-box",
      borderRight: `1px solid ${color.border}`, ...solid,
    }}>
      <Icon size={12} color={color.textMuted} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: color.textSecondary, fontFamily: font.body, fontSize: 11 }}>{label}</span>
      {main ? <Magnet size={10} color={color.accent} /> : null}
      {track.kind === "subtitle" ? <button
        type="button"
        aria-label="在播放头处添加字幕"
        aria-disabled={blocked ? true : undefined}
        title={blocked ?? "在播放头处添加字幕"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (!blocked) onAddSubtitle(track.id); }}
        style={{ ...rowButton, cursor: blocked ? "default" : "pointer", opacity: blocked ? 0.45 : 1 }}
      ><Plus size={12} color={color.textMuted} /></button> : null}
      {sounds ? <button
        type="button"
        aria-label={track.mute ? `取消“${label}”的静音` : `把“${label}”静音`}
        aria-pressed={track.mute}
        aria-disabled={blocked ? true : undefined}
        title={muteTitle}
        // 点完焦点还留在原处，接着按快捷键照样管用
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onMute(track.id)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, flexShrink: 0, padding: 0, borderRadius: radius.small, cursor: blocked ? "default" : "pointer",
          border: `1px solid ${track.mute ? color.border : "transparent"}`, backgroundColor: track.mute ? color.surfaceMuted : "transparent", opacity: blocked ? 0.45 : 1,
        }}
      >
        {track.mute ? <VolumeX size={12} color={color.text} /> : <Volume2 size={12} color={color.textMuted} />}
      </button> : null}
    </div>
    <div data-lane={track.id} style={{ position: "relative", width, flexShrink: 0, backgroundColor: target ? color.accentSoft : undefined }}>
      {pxPerUs > 0 ? track.segments.map((segment) => {
        const place = places?.get(segment.id) ?? null;
        const reach = reaches.get(segment.id) ?? "next";
        const common = { segment, pxPerUs, mediaById, mediaUrl, reach, selected: selectedIds.has(segment.id), editable: editable && !blade, blade, touchStart: touching.has(`${segment.id}:start`), touchEnd: touching.has(`${segment.id}:end`), onPick };
        // ⌥ 拖复制：原片段留在原处，另画一个跟着手走的影子
        return <React.Fragment key={segment.id}>
          <Clip {...common} place={place?.copy ? null : place} />
          {place?.copy ? <Clip {...common} place={place} ghost /> : null}
        </React.Fragment>;
      }) : null}
    </div>
  </div>;
});

/** 视频片段里按时间均匀取的几帧：排进全页的取帧队列，卸载（切剪辑、片段没了）时撤掉还没取的。 */
function useFilmstrip(mediaId: string | null, url: string | null, times: number[]): Array<string | null> {
  const signature = times.join(",");
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!web || !mediaId || !url || !signature) return undefined;
    const controller = new AbortController();
    for (const time of signature.split(",").map(Number)) {
      if (frameQueue.peek(mediaId, time)) continue;
      void frameQueue.request(mediaId, url, time, controller.signal).then((frame) => {
        if (frame && !controller.signal.aborted) setLoaded((current) => ({ ...current, [`${mediaId}@${time}`]: frame }));
      });
    }
    return () => controller.abort();
  }, [mediaId, url, signature]);
  return times.map((time) => (mediaId ? loaded[`${mediaId}@${time}`] ?? frameQueue.peek(mediaId, time) ?? null : null));
}

// 拖动、框选时轨道行每帧都重画，没变的片段靠 memo 跳过
const Clip = memo(function Clip({ segment, pxPerUs, mediaById, mediaUrl, reach, selected, editable, blade = false, touchStart, touchEnd, place, ghost = false, onPick }: {
  segment: EditSegment; pxPerUs: number; mediaById: ReadonlyMap<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null;
  /** 转场能不能接到下一段：轨道最后一段或后面隔着空当时不画转场菱形 */
  reach: TransitionReach; selected: boolean;
  /** 能拖动、裁剪 */
  editable: boolean;
  /** 分割工具：十字光标 */
  blade?: boolean;
  /** 这一头和同轨邻居首尾相接：把手缩在片段里面 */
  touchStart: boolean; touchEnd: boolean;
  /** 正在拖：按跟手的位置画 */
  place: ClipPlace | null;
  /** ⌥ 拖复制时跟着手走的影子：点不中、没有把手 */
  ghost?: boolean;
  onPick: (id: string) => void;
}) {
  // 拖动中按跟手的位置画，缩略图仍按原来的宽度取帧，不在拖的时候反复解码
  const shown = place?.timeline ?? segment.timeline;
  const box = clipBox(shown, pxPerUs);
  const settled = clipBox(segment.timeline, pxPerUs);
  const tone = clipTone(segment);
  const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
  const label = clipLabel(segment, item ? mediaTitle(item) : null);
  const extras = clipExtras(segment, reach);
  const span = shown.duration_us;
  const fade = "fade" in segment ? segment.fade : null;
  const transition = "transition" in segment ? segment.transition : null;
  const hint = editable ? HINT_EDIT : HINT_VIEW;
  const title = [label, `${formatClock(segment.timeline.start_us)} 起，${spokenDuration(segment.timeline.duration_us)}`, ...extras, hint].join("\n");
  // 画面：视频取几帧缩略图，图片平铺；取不到就留现在的纯色块
  const pictureUrl = web && item?.status === "ready" && (segment.kind === "video" || segment.kind === "image") ? mediaUrl(item.id) : null;
  // 带透明的网页片段底下是 PNG 编码的 MOV，浏览器解不了，不取缩略图
  const count = segment.kind === "video" && pictureUrl && !(item?.source.type === "page" && item.source.transparent) ? filmstripCount(settled.width) : 0;
  const source = segment.kind === "video" ? segment.source : null;
  const times = useMemo(() => (source ? filmstripTimes(source, count) : []), [source, count]);
  const frames = useFilmstrip(count ? item?.id ?? null : null, count ? pictureUrl : null, times);
  const tiled = segment.kind === "image" && pictureUrl;
  const pictured = Boolean(tiled) || frames.some(Boolean);
  const floating = Boolean(place?.floating);
  const refused = Boolean(place?.refused);
  const hit = trimHit(box.width);
  const cursor = ghost ? undefined : blade ? "crosshair" : floating ? (refused ? "not-allowed" : place?.copy ? "copy" : "grabbing") : place && place.mode !== "move" ? "ew-resize" : editable ? "grab" : "pointer";
  return <div
    data-clip={ghost ? undefined : segment.id}
    role={ghost ? undefined : "button"}
    tabIndex={ghost ? -1 : 0}
    aria-hidden={ghost || undefined}
    aria-pressed={ghost ? undefined : selected}
    aria-label={ghost ? undefined : `${label}，${secondMark(segment.timeline.start_us)}开始，${hint}`}
    title={ghost ? undefined : title}
    onKeyDown={ghost ? undefined : (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onPick(segment.id);
    }}
    style={{
      position: "absolute", left: box.left, width: box.width, top: 3, bottom: 3, cursor, pointerEvents: ghost ? "none" : undefined,
      transform: place?.offsetY ? `translateY(${place.offsetY}px)` : undefined, zIndex: place ? 3 : selected ? 1 : undefined,
      opacity: refused ? 0.5 : ghost ? 0.75 : floating ? 0.85 : undefined,
    }}
  >
    {/* 内容在里层裁剪，外层不裁：选中时裁剪把手要伸到片段外面 */}
    <div style={{
      position: "absolute", inset: 0, overflow: "hidden", boxSizing: "border-box", borderRadius: 4, display: "flex", alignItems: "center", paddingLeft: 5, paddingRight: 5,
      border: refused ? `1px dashed ${color.danger}` : ghost ? `1px dashed ${color.text}` : selected ? `2px solid ${color.text}` : `1px solid ${alpha(tone, 0.6)}`,
      backgroundColor: alpha(tone, selected ? 0.3 : 0.16), outline: selected && !refused ? `2px solid ${color.accent}` : undefined, outlineOffset: 1,
    }}>
      {tiled ? <span aria-hidden style={{ ...clipPicture, backgroundImage: `url(${JSON.stringify(pictureUrl)})`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x", backgroundPosition: "left center" }} /> : null}
      {count ? <span aria-hidden style={{ ...clipPicture, display: "flex" }}>
        {frames.map((frame, index) => <span key={index} style={{
          flex: 1, minWidth: 0, backgroundImage: frame ? `url(${JSON.stringify(frame)})` : undefined, backgroundSize: "cover", backgroundPosition: "center",
          borderLeft: index && frame ? `1px solid ${alpha(color.black, 0.35)}` : undefined,
        }} />)}
      </span> : null}
      {box.width > 18 ? <span style={{
        position: "relative", maxWidth: "100%", boxSizing: "border-box", fontSize: 10.5, lineHeight: "14px", color: color.text, fontFamily: font.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        // 有画面时名字收成一个小标签，给缩略图多留点地方；设置项数在详情卡里看
        ...(pictured ? { maxWidth: "70%", backgroundColor: alpha(color.surface, 0.82), borderRadius: 3, paddingLeft: 4, paddingRight: 4 } : null),
      }}>
        {label}{extras.length && box.width > 90 && !pictured ? <span style={{ color: color.textMuted }}> · {extras.length} 项设置</span> : null}
      </span> : null}
      {fade?.in_duration_us ? <span style={{ position: "absolute", left: 0, top: 0, height: 2, width: `${(fade.in_duration_us / span) * 100}%`, backgroundColor: tone }} /> : null}
      {fade?.out_duration_us ? <span style={{ position: "absolute", right: 0, top: 0, height: 2, width: `${(fade.out_duration_us / span) * 100}%`, backgroundColor: tone }} /> : null}
      {(segment.keyframes ?? []).map((keyframe, index) => <span key={index} style={{
        position: "absolute", bottom: 1, left: `calc(${(keyframe.offset_us / span) * 100}% - 2px)`, width: 4, height: 4, transform: "rotate(45deg)", backgroundColor: color.text, opacity: 0.7,
      }} />)}
      {transition && reach === "next" ? <span title={`转场 ${featureName(transition.transition_type)}`} style={{
        position: "absolute", right: 1, top: "50%", width: 7, height: 7, marginTop: -3.5, transform: "rotate(45deg)", backgroundColor: color.text, border: `1px solid ${color.surface}`,
      }} /> : null}
      {/* 选中：文字色边框里再描一圈底色、外面再套一圈强调色，盖在缩略图上面，哪种风格、什么画面都认得出来。
          内圈用边框不用 box-shadow：海报风格把 box-shadow 全清掉了 */}
      {selected ? <span aria-hidden style={{ ...clipPicture, boxSizing: "border-box", borderRadius: 2, border: `2px solid ${color.surface}` }} /> : null}
    </div>
    {/* 两头是裁剪把手（片段宽过 6px 才有），按下时轨道区靠 data-edge 认出拖的是哪一头 */}
    {editable && !ghost && !floating && box.width > 6 ? <>
      <TrimHandle edge="start" hit={hit} straddle={selected && !touchStart} />
      <TrimHandle edge="end" hit={hit} straddle={selected && !touchEnd} />
    </> : null}
  </div>;
});

/**
 * 裁剪把手：宽 trimHit，选中、而且这一头没贴着邻居时跨在边上（里外各一半），人去抓边时抓在外面一点点也是裁剪，不会把整段挪走；
 * 贴着邻居时缩回片段里面，各管各的边。鼠标放上去时露出一根竖条，不然看不出能拉。
 */
function TrimHandle({ edge, hit, straddle }: { edge: TrimEdge; hit: number; straddle: boolean }) {
  const [hover, setHover] = useState(false);
  const start = edge === "start";
  return <span
    data-edge={edge}
    aria-hidden
    onPointerEnter={() => setHover(true)}
    onPointerLeave={() => setHover(false)}
    style={{ position: "absolute", top: 0, bottom: 0, zIndex: 2, cursor: "ew-resize", width: straddle ? hit * 2 : hit, ...(start ? { left: straddle ? -hit : 0 } : { right: straddle ? -hit : 0 }) }}
  >
    {hover ? <span style={{
      position: "absolute", top: 3, bottom: 3, width: 3, borderRadius: 2, backgroundColor: color.accent, opacity: 0.9, pointerEvents: "none",
      ...(start ? (straddle ? { right: hit } : { left: 1 }) : (straddle ? { left: hit } : { right: 1 })),
    }} /> : null}
  </span>;
}

const clipPicture: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };

const styles = StyleSheet.create({
  timeline: { position: "relative", overflow: "hidden", userSelect: "none", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surface },
  timelineEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 10 },
});
