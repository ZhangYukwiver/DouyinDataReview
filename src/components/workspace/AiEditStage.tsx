import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Pause, Play, Quote, RotateCcw, Scissors, SquareDashed, Sticker, Trash2, Type } from "lucide-react-native";
import { pageOf, type AiEditMediaItem, type EditCanvas, type EditMediaSegment, type EditSegment, type EditTextSegment, type EditTrack, type EditTransform } from "../../services/aiEdit";
import {
  activeFrame, blendMode, clipLabel, colorFilter, cropClipPath, cssTransform, effectiveTransform, featureLook, featureName, findSegment, formatClock, hasScaleKeyframes,
  layerBox, layerRect, maskCss, mediaIdFromPath, mediaVolume, nextSegmentAfter, overlayFilter, playbackRate, rgba, sourceTimeUs, textCss, US_PER_SECOND,
  type MaskSpec, type Size,
} from "./aiEditModel";
import { dragRect, fullTransform, layersInRect, regionBox, SNAP_PX, splitOffset, type Rect } from "./aiEditBoardEdit";
import {
  addNudge, arrowDelta, CORNERS, DRAG_PX, doubleClickAim, EDGES, frameAabb, frameOf, gestureStep, HANDLE_ANGLE, HANDLE_AT, HANDLE_BOX_MIN, insideFrame, isDefaultPlacement,
  isIdentityTransform, keepPress, keyframeLocks, lockNote, NUDGE_WRITE_MS, nudgedTransform, pickHit, resetPlacement, resizeCursor, ROTATE_AT, rotateCursor, sameGuides,
  sameTransform, stageHits, stagePoint, stageScale,
  type FrameCorner, type FrameEdge, type HeldNudge, type Point, type Press, type StageFrame, type StageGesture, type StageGestureKind, type StageGuide, type StageHitLayer,
} from "./aiEditStageEdit";
import { lastingReason } from "./aiEditInspect";
import { useBoard, useBoardKeys, useHeldEdit, usePlaybackTime, usePreviewStore, usePreviewTime } from "./aiEditBoardContext";
import { useTimelinePrefs } from "./aiEditTimelinePrefs";
import { IS_MAC, typingInto } from "./aiEditKeymap";
import { snapToFrame } from "./aiEditRefs";
import { useContextMenu, type MenuEntry, type MenuItem } from "./AiEditMenu";
import { areaProps, mediaTitle, web, WebTitle, webPointer } from "./aiEditShared";
import { kit } from "./CreatorKit";
import { ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 看板上半部分的画面：按播放头画出这一刻的各个图层（视频、图片、文字、贴纸）。
// 画面上铺一层统一接指针：点哪段选哪段（叠在一起时小的、上层的优先，Alt+点击往下轮），按住拖动挪位置（吸到画布和别的片段），
// 四角缩放、拖边拉伸、角外旋转，双击文字（或选中后按回车）直接在画面上改字，右键弹菜单；方向键微调先攒着，停手 350ms 才提交一次。
// 拖的时候只在本地预览，松手才发一次 update_clip；框选（问 AI）打开时在画面上拖出一个框。下面一行是播放按钮、时间和框选开关（PlayerBar）。

/** 画面上能选中、拖动的片段 */
const FRAMED_KINDS = new Set<EditSegment["kind"]>(["video", "image", "text", "sticker"]);
/** 能拖成不等比、有四条边的（文字永远等比） */
const STRETCHABLE = new Set<EditSegment["kind"]>(["video", "image", "sticker"]);
const BUSY_TEXT = "上一个改动还没回来，稍等";
const transformOf = (segment: EditSegment): EditTransform | null | undefined => ("transform" in segment ? segment.transform : null);
const withTransform = (segment: EditSegment, transform: EditTransform) => ({ ...segment, transform }) as EditSegment;
const stickerSide = (stage: Size) => Math.min(stage.width, stage.height) * 0.22;

/** 此刻画面上看得见、能点的一段：框、此刻生效的 transform */
interface FramedLayer extends StageHitLayer { segment: EditSegment; transform: EditTransform }
/** 本地预览的一段 transform */
interface Draft { id: string; transform: EditTransform }
/**
 * 已经提交、还没回来的改动的预览：sent 是真正发出去时的工程版本（还在排队是 null）。
 * 版本一变（新工程进来）就不再用它，失败了立刻撤掉，免得新工程还没进来时框闪回原位。
 */
interface Sent<T> { id: string; value: T; sent: number | null }

const NO_HOVER: { id: string | null; grab: boolean } = { id: null, grab: false };
const NO_GUIDES: StageGuide[] = [];
const NO_SIZES: ReadonlyMap<string, Size> = new Map();

/** 画面里各图层（带 data-layer-id 的根元素）相对舞台的外接框；看不见的（藏起来、全透明、没有大小）不算。框选给 AI 看的大致范围用它。 */
function stageLayers(stage: HTMLElement): Array<{ id: string; rect: Rect }> {
  const box = stage.getBoundingClientRect();
  const list: Array<{ id: string; rect: Rect }> = [];
  for (const node of Array.from(stage.querySelectorAll<HTMLElement>("[data-layer-id]"))) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    list.push({ id: node.getAttribute("data-layer-id") ?? "", rect: { left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height } });
  }
  return list;
}

/** 文字排出来的大小（不含缩放、旋转）：按 DOM 量 */
function textSizesIn(stage: HTMLElement | null): Map<string, Size> {
  const sizes = new Map<string, Size>();
  for (const node of Array.from(stage?.querySelectorAll<HTMLElement>('[data-layer-kind="text"]') ?? [])) {
    const id = node.getAttribute("data-layer-id");
    if (id && node.offsetWidth > 0 && node.offsetHeight > 0) sizes.set(id, { width: node.offsetWidth, height: node.offsetHeight });
  }
  return sizes;
}

const sameSizes = (a: ReadonlyMap<string, Size>, b: ReadonlyMap<string, Size>) => a.size === b.size
  && [...a].every(([id, size]) => b.get(id)?.width === size.width && b.get(id)?.height === size.height);

/** 主题色在网页上是 CSS 变量，画进光标（data URI 里的 SVG）要先取出真正的颜色 */
function cssColor(token: string, fallback: string): string {
  const name = /^var\((--[\w-]+)/u.exec(token)?.[1];
  if (!name) return token;
  const value = globalThis.document ? getComputedStyle(globalThis.document.documentElement).getPropertyValue(name).trim() : "";
  return value || fallback;
}

/** 工具栏关了字幕（CC）：画面上不画字幕轨，只影响看板预览 */
const withCaptions = (frame: ReturnType<typeof activeFrame>, captions: boolean) => (captions ? frame
  : { ...frame, visuals: frame.visuals.filter((layer) => layer.track.kind !== "subtitle") });

/** 停在结尾时显示最后一帧 */
const shownTimeOf = (time: number, duration: number) => (duration > 0 ? Math.min(time, duration - 1) : 0);

/** 画面：占满给它的地方，按画布比例居中。 */
export function Stage() {
  const board = useBoard();
  const latest = useRef(board);
  latest.current = board;
  const { project, canvas, mediaById, mediaUrl, filmUrl, duration, running, editable, notEditableReason, selection, selected, regionMode, region, playback } = board;
  const playheadTime = usePlaybackTime();
  // 预览轴：鼠标在时间线上划过时画面停在那一刻（播放头、时钟和声音不动）；播放时、在画面上改字时不跟（改字是从预览的那一刻进来的，进来时播放头先挪过去）
  const previewStore = usePreviewStore();
  const previewTime = usePreviewTime();
  const [editingText, setEditingText] = useState<string | null>(null);
  const time = previewTime !== null && !playback.playing && !editingText ? previewTime : playheadTime;
  const { captions } = useTimelinePrefs();
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const scale = stageScale(box, canvas);
  const stage = useMemo(() => ({ width: Math.floor(canvas.width * scale), height: Math.floor(canvas.height * scale) }), [canvas.width, canvas.height, scale]);
  const shownTime = shownTimeOf(time, duration);
  const frame = useMemo(() => withCaptions(activeFrame(project, shownTime), captions), [project, shownTime, captions]);
  const stageRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();

  // ---------- 本地预览 ----------
  // draft：正在拖、方向键攒着还没提交的；sentMove / sentText：提交了还没回来的
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [sentMove, setSentMove] = useState<Sent<EditTransform> | null>(null);
  const [sentText, setSentText] = useState<Sent<string> | null>(null);
  const revision = project?.revision ?? null;
  const valid = <T,>(item: Sent<T> | null) => (item && (item.sent === null || item.sent === revision) ? item : null);
  const shownMove = valid(sentMove);
  const shownText = valid(sentText);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sentRef = useRef(shownMove);
  sentRef.current = shownMove;
  const setDraft = useCallback((next: Draft | null) => { draftRef.current = next; setDraftState(next); }, []);
  /** 这段现在该按哪个 transform 画：拖着的、发出去的，都没有就是 null（按工程里的） */
  const overrideOf = (id: string): EditTransform | null => (draft?.id === id ? draft.transform : shownMove?.id === id ? shownMove.value : null);

  const [drawing, setDrawing] = useState<Rect | null>(null);
  // stage 是这次拖动开始时的舞台大小：参考线、数值提示按它的像素记，画的时候换算到现在的舞台
  const [gesture, setGesture] = useState<{ kind: StageGestureKind; cursor: string; stage: Size } | null>(null);
  const [guides, setGuides] = useState<StageGuide[]>(NO_GUIDES);
  const [hint, setHint] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hover, setHover] = useState(NO_HOVER);
  const editingRef = useRef(editingText);
  editingRef.current = editingText;
  // 素材读到真实尺寸时图层自己重渲染，不经过这里：靠它让框跟着重算
  const [, bumpSizes] = useReducer((count: number) => count + 1, 0);
  const [textSizes, setTextSizes] = useState(NO_SIZES);

  // ---------- 每段的框 ----------
  const materialOf = (segment: EditMediaSegment): Size | null => {
    const item = mediaById.get(mediaIdFromPath(segment.path) ?? "");
    const url = item?.status === "ready" ? mediaUrl(item.id) : null;
    return url ? naturalSizes.get(url) ?? null : item?.width && item.height ? { width: item.width, height: item.height } : null;
  };
  /** 此刻画面上的各段和它们的框（拖动中的那段按预览算）；文字的大小要按 DOM 量 */
  const layoutFrames = (textSize: (id: string) => Size | null): FramedLayer[] => {
    const list: FramedLayer[] = [];
    for (const { segment: original, trackIndex } of frame.visuals) {
      if (!FRAMED_KINDS.has(original.kind)) continue;
      const override = overrideOf(original.id);
      const segment = override ? withTransform(original, override) : original;
      const transform = effectiveTransform(segment as EditMediaSegment, Math.max(0, shownTime - segment.timeline.start_us));
      const base = segment.kind === "text" ? textSize(segment.id)
        : segment.kind === "sticker" ? { width: stickerSide(stage), height: stickerSide(stage) }
          : segment.kind === "video" || segment.kind === "image" ? layerBox(stage, materialOf(segment), segment.fit ?? "contain", segment.keyframes) : null;
      if (!base) continue;
      const crop = segment.kind === "video" || segment.kind === "image" ? segment.crop : null;
      list.push({ id: original.id, trackIndex, segment: original, transform, alpha: Math.min(1, Math.max(0, transform.alpha)), frame: frameOf(stage, base, transform, crop) });
    }
    return list;
  };
  const frames = layoutFrames((id) => textSizes.get(id) ?? null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  // 事件里用：当场量一次文字，播放中没量过的也算得出来
  const framesNow = useRef(() => frames);
  framesNow.current = () => {
    const measured = textSizesIn(stageRef.current);
    return layoutFrames((id) => measured.get(id) ?? textSizes.get(id) ?? null);
  };
  const textIds = frame.visuals.filter((layer) => layer.segment.kind === "text").map((layer) => layer.segment.id).join("|");
  const measureTexts = useCallback(() => {
    const next = textSizesIn(stageRef.current);
    setTextSizes((current) => (sameSizes(current, next) ? current : next));
  }, []);
  useLayoutEffect(() => { if (!playback.playing) measureTexts(); });
  // 字体晚到、改字时字块变大小，不一定经过重渲染
  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measureTexts());
    for (const item of Array.from(node.querySelectorAll('[data-layer-kind="text"]'))) observer.observe(item);
    return () => observer.disconnect();
  }, [textIds, editingText, scale > 0, measureTexts]);

  // ---------- 发改动：自己的改动排队一个一个发 ----------
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const [sending, setSending] = useState(false);
  const renderWaiters = useRef<Array<() => void>>([]);
  // 上一个改动回来以后看板渲染过没有
  const rendered = useRef(true);
  useEffect(() => {
    rendered.current = true;
    if (!renderWaiters.current.length) return;
    const waiting = renderWaiters.current;
    renderWaiters.current = [];
    for (const resolve of waiting) resolve();
  });
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const after = pending.current > 0 || !rendered.current;
    pending.current += 1;
    setSending(true);
    const run = async () => {
      // 前一个刚回来时看板还没按新状态重渲染（还当是锁着），等它渲染一次再发
      if (after) await new Promise<void>((resolve) => { renderWaiters.current.push(resolve); setTimeout(resolve, 200); });
      try { return await job(); } finally {
        pending.current -= 1;
        rendered.current = false;
        if (!pending.current) setSending(false);
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);
  /** 能不能动手：看板能改，或者只是自己上一个改动还在路上、刚回来看板还没重渲染（排在它后面发） */
  const canTouch = () => latest.current.editable || pending.current > 0 || !rendered.current;
  /** 手柄、抓手照常画：别处的改动还在路上只是一眨眼的事，不藏（真在这时去拖，canTouch 会拦下提示稍等） */
  const showsTools = (b: { editable: boolean; notEditableReason: string | null }) => b.editable || !lastingReason(b.notEditableReason);
  const refuse = () => latest.current.toast(latest.current.notEditableReason ?? BUSY_TEXT);

  /** 提交一个 transform：预览先换上，排队发出去；发出时记下工程版本，失败就撤掉预览 */
  const sendTransform = useCallback((id: string, transform: EditTransform, args?: Record<string, unknown>) => {
    const item: Sent<EditTransform> = { id, value: transform, sent: null };
    sentRef.current = item;
    setSentMove(item);
    return enqueue(async () => {
      const sent = latest.current.project?.revision ?? -1;
      setSentMove((current) => (current?.value === transform ? { ...current, sent } : current));
      const ok = await latest.current.runEdit("update_clip", args ?? { clip_id: id, transform });
      if (!ok) setSentMove((current) => (current?.value === transform ? null : current));
      return ok;
    });
  }, [enqueue]);
  const sendText = useCallback((id: string, text: string) => {
    setSentText({ id, value: text, sent: null });
    void enqueue(async () => {
      const sent = latest.current.project?.revision ?? -1;
      setSentText((current) => (current && current.id === id && current.value === text ? { ...current, sent } : current));
      const ok = await latest.current.runEdit("update_clip", { clip_id: id, text });
      if (!ok) setSentText((current) => (current && current.id === id && current.value === text ? null : current));
    });
  }, [enqueue]);

  /** 接着改这段时的起点：拖着的、发出去还没回来的，都没有就是工程里的 */
  const baseOf = (segment: EditSegment) => {
    const moving = draftRef.current;
    const sent = sentRef.current;
    return moving?.id === segment.id ? moving.transform : sent?.id === segment.id ? sent.value : fullTransform(transformOf(segment));
  };

  // ---------- 方向键微调（C7）：先在本地攒着，停手 350ms 合成一次提交 ----------
  const held = useRef<{ nudge: HeldNudge; timer: ReturnType<typeof setTimeout>; projectId: string | null } | null>(null);
  const dropHeld = useCallback(() => {
    const current = held.current;
    if (current) clearTimeout(current.timer);
    held.current = null;
    return current;
  }, []);
  const flushNudge = useCallback((): Promise<unknown> => {
    const current = dropHeld();
    if (!current) return queue.current;
    if (draftRef.current?.id === current.nudge.id) setDraft(null);
    if (current.projectId !== (latest.current.project?.id ?? null)) return queue.current;
    const transform = nudgedTransform(current.nudge, latest.current.canvas);
    if (sameTransform(transform, current.nudge.base)) return queue.current;
    return sendTransform(current.nudge.id, transform);
  }, [dropHeld, setDraft, sendTransform]);
  const discardNudge = useCallback(() => {
    const current = dropHeld();
    if (!current) return false;
    if (draftRef.current?.id === current.nudge.id) setDraft(null);
    return true;
  }, [dropHeld, setDraft]);
  useHeldEdit({ flush: flushNudge, discard: discardNudge });

  const projectId = project?.id ?? null;
  // 换了工程（或看板收起）：攒着的、预览的都丢掉（放在换选中的 flush 前面，免得把旧工程的微调发到新工程上）
  useEffect(() => {
    setDraft(null);
    setSentMove(null);
    setSentText(null);
    setDrawing(null);
    setEditingText(null);
    setGuides(NO_GUIDES);
    setHint(null);
    setHover(NO_HOVER);
    return () => { dropHeld(); };
  }, [projectId, dropHeld, setDraft]);
  useEffect(() => { if (!regionMode) setDrawing(null); }, [regionMode]);
  // 换了选中：别的那段攒着的微调先发掉；改字的那段不再选中就收起（收起时照样提交）
  const primary = selection.primary;
  useEffect(() => {
    if (held.current && held.current.nudge.id !== primary) void flushNudge();
    setEditingText((current) => (current && current !== primary ? null : current));
  }, [primary, flushNudge]);

  const singleId = () => (latest.current.selection.ids.length === 1 ? latest.current.selection.primary : null);
  const pointAt = (event: { clientX: number; clientY: number }): Point | null => {
    const node = stageRef.current;
    if (!node) return null;
    const origin = node.getBoundingClientRect();
    return { x: event.clientX - origin.left, y: event.clientY - origin.top };
  };

  const arrow = (direction: "left" | "right" | "up" | "down") => (event: KeyboardEvent) => {
    const b = latest.current;
    if (b.playback.playing || b.regionMode || editingRef.current) return false;
    const id = singleId();
    const layer = id ? framesNow.current().find((item) => item.id === id) : undefined;
    if (!layer) return false;
    if (!canTouch()) { refuse(); return undefined; }
    const locks = keyframeLocks(layer.segment);
    if (locks.move) { b.toast(lockNote(locks) ?? ""); return undefined; }
    if (held.current && held.current.nudge.id !== layer.id) void flushNudge();
    const current = held.current;
    if (current) clearTimeout(current.timer);
    const step = arrowDelta(direction, event.shiftKey);
    const nudge = addNudge(current?.nudge ?? null, layer.id, baseOf(layer.segment), step.x, step.y);
    held.current = { nudge, timer: setTimeout(() => { void flushNudge(); }, NUDGE_WRITE_MS), projectId: b.project?.id ?? null };
    setDraft({ id: layer.id, transform: nudgedTransform(nudge, b.canvas) });
    return undefined;
  };
  useBoardKeys({ "stage-left": arrow("left"), "stage-right": arrow("right"), "stage-up": arrow("up"), "stage-down": arrow("down") }, { area: "stage" });

  // ---------- 在画面上改字（1B） ----------
  const startTextEdit = useCallback((id: string): boolean => {
    const b = latest.current;
    const layer = framesNow.current().find((item) => item.id === id);
    if (!layer || layer.segment.kind !== "text") return false;
    if (!canTouch()) { refuse(); return true; }
    if (held.current) void flushNudge();
    b.playback.pause();
    const previewing = previewStore.get();
    if (previewing !== null) b.playback.seek(previewing);
    if (b.selection.ids.length !== 1 || b.selection.primary !== id) b.selection.set([id], id);
    setHover(NO_HOVER);
    setEditingText(id);
    return true;
  }, [flushNudge, previewStore]);
  const finishTextEdit = useCallback((id: string, value: string | null) => {
    setEditingText((current) => (current === id ? null : current));
    if (value === null) return;
    const found = findSegment(latest.current.project, id);
    const original = found?.segment.kind === "text" ? found.segment.text : null;
    // 空的、没变的当放弃
    if (original === null || !value.trim() || value === original) return;
    sendText(id, value);
  }, [sendText]);
  useBoardKeys({
    "edit-text": () => {
      const b = latest.current;
      if (b.selection.ids.length !== 1 || b.selected?.segment.kind !== "text" || b.regionMode) return false;
      // 用 Tab 移到按钮上时回车是按那个按钮
      const active = globalThis.document?.activeElement as HTMLElement | null;
      if (active?.closest?.('button, [role="button"], a[href]')) return false;
      return startTextEdit(b.selected.segment.id) ? undefined : false;
    },
  });

  // ---------- 拖动 ----------
  const beginGesture = (kind: StageGestureKind, layer: FramedLayer, start: Point, at: FrameCorner | FrameEdge = "se"): StageGesture | null => {
    const b = latest.current;
    if (!canTouch()) { refuse(); return null; }
    const locks = keyframeLocks(layer.segment);
    if ((kind === "move" && locks.move) || (kind === "scale" && locks.scale) || (kind === "rotate" && locks.rotate)) { b.toast(lockNote(locks) ?? ""); return null; }
    if (held.current) void flushNudge();
    const others = kind === "move" ? framesNow.current().filter((item) => item.id !== layer.id && item.alpha > 0).map((item) => frameAabb(item.frame)) : [];
    return {
      kind, id: layer.id, base: baseOf(layer.segment), frame0: layer.frame, handle: HANDLE_AT[at], stage, start, canvas: b.canvas,
      // 片段自己的中心（裁剪过时和框的中心不在一处）：旋转、对角缩放都按它算
      center0: { x: stage.width / 2 + (layer.transform.transform_x * stage.width) / 2, y: stage.height / 2 - (layer.transform.transform_y * stage.height) / 2 },
      // 吸附目标：画布排第一（距离一样时它胜出），后面是别的看得见的片段
      targets: kind === "move" ? [{ x: 0, y: 0, w: stage.width, h: stage.height }, ...others] : [],
      stretchable: STRETCHABLE.has(layer.segment.kind),
      pivotLocked: locks.move,
    };
  };

  /**
   * 跟一次按下：threshold 像素以内松手算点击（click），过了就开始拖（begin 给出这次拖动，给 null 就不拖）。
   * pointermove 只记坐标，rAF 里算一次；松手（或 pointercancel、丢了 capture）按最后的位置提交一次；Esc、窗口失焦取消，回到原样。
   * 开始拖以后画面可能变大小、挪位置（刚选中时详情卡出来）：指针每次按舞台此刻的位置量，再换回开始时的舞台像素。
   */
  const track = (event: React.PointerEvent<HTMLElement>, options: { threshold: number; cursor: string; begin: () => StageGesture | null; click?: () => void }) => {
    const node = stageRef.current;
    if (!node || !web) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    let active: StageGesture | null = null;
    // 开始时的舞台像素 / 现在的屏幕像素：吸附范围跟着换算，屏幕上仍是 SNAP_PX
    let ratio = 1;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const rect = (stageRef.current ?? node).getBoundingClientRect();
      ratio = active && rect.width > 0 ? active.stage.width / rect.width : 1;
      return stagePoint(e, rect, active?.stage);
    };
    const start = local(event);
    let last = { point: start, shift: event.shiftKey, alt: event.altKey };
    let raf = 0;
    let over = false;
    const body = globalThis.document?.body ?? null;
    const saved = body ? { cursor: body.style.cursor, userSelect: body.style.userSelect } : null;
    const paint = () => {
      raf = 0;
      if (!active || over) return;
      const step = gestureStep(active, last.point, last, SNAP_PX * ratio);
      setDraft({ id: active.id, transform: step.transform });
      setGuides((current) => (sameGuides(current, step.guides) ? current : step.guides.length ? step.guides : NO_GUIDES));
      setHint({ x: last.point.x, y: last.point.y, text: step.text });
    };
    const lift = (): boolean => {
      active = options.begin();
      if (!active) return false;
      setGesture({ kind: active.kind, cursor: options.cursor, stage: active.stage });
      setHover(NO_HOVER);
      if (body) { body.style.cursor = options.cursor; body.style.userSelect = "none"; }
      return true;
    };
    const finish = (commit: boolean) => {
      if (over) return;
      over = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onEnd);
      element.removeEventListener("lostpointercapture", onEnd);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (raf) cancelAnimationFrame(raf);
      try { if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId); } catch { /* 元素已经不在了 */ }
      if (body && saved) { body.style.cursor = saved.cursor; body.style.userSelect = saved.userSelect; }
      const gestureNow = active as StageGesture | null;
      if (!gestureNow) { if (commit) options.click?.(); return; }
      setGesture(null);
      setGuides(NO_GUIDES);
      setHint(null);
      const step = gestureStep(gestureNow, last.point, last, SNAP_PX * ratio);
      setDraft(null);
      if (commit && !sameTransform(step.transform, gestureNow.base)) void sendTransform(gestureNow.id, step.transform);
    };
    const onMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      last = { point: local(next), shift: next.shiftKey, alt: next.altKey };
      if (!active) {
        if (Math.hypot(last.point.x - start.x, last.point.y - start.y) < options.threshold) return;
        if (!lift()) { finish(false); return; }
      }
      // 拖到一半不能改了（AI 开始剪了）：放弃这次拖动
      if (!canTouch()) { finish(false); return; }
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onUp = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      last = { point: local(next), shift: next.shiftKey, alt: next.altKey };
      finish(true);
    };
    const onEnd = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true); };
    const onKey = (next: KeyboardEvent) => {
      if (!active) return;
      if (next.type === "keydown" && next.key === "Escape") { next.preventDefault(); next.stopPropagation(); finish(false); return; }
      // 拖着不动时按下、松开 Shift / Alt 也要重算（锁轴、关吸附、对角缩放）
      if (next.key === "Shift" || next.key === "Alt") {
        last = { ...last, shift: next.shiftKey, alt: next.altKey };
        if (!raf) raf = requestAnimationFrame(paint);
      }
    };
    const onBlur = () => finish(false);
    try { element.setPointerCapture(pointerId); } catch { /* 不支持就靠 window 上的监听 */ }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onEnd);
    element.addEventListener("lostpointercapture", onEnd);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    if (options.threshold <= 0 && !lift()) finish(false);
  };

  // 画面上按下（B1）：按在选中的框里拖满 4px 就挪它，没动满就当点击、重新命中（能点到框底下的文字）；
  // 按在别处松手时选中排第一的（Alt 往下轮），没有就取消选中；拖满 4px 先选中排第一的再挪它。
  // 双击的第二下点选照第一下的位置算：第一下可能打开了详情卡、画面挪了，不然选中会先跳到别处（或被取消）再跳回来
  const presses = useRef<Press[]>([]);
  const onStageDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (IS_MAC && event.ctrlKey)) return;
    const b = latest.current;
    const at = pointAt(event);
    if (b.regionMode || editingRef.current || !at || !scale) return;
    event.preventDefault();
    // 点画面本该让焦点离开别处的按钮（按下被拦住了就自己让它失焦），不然回车按的是那个按钮
    const focused = globalThis.document?.activeElement as HTMLElement | null;
    if (focused && focused !== globalThis.document?.body && !typingInto(focused)) focused.blur?.();
    if (b.playback.playing) b.playback.pause();
    presses.current = keepPress(presses.current, { x: at.x / scale, y: at.y / scale, clientX: event.clientX, clientY: event.clientY, at: event.timeStamp });
    const aim = doubleClickAim(presses.current, event.timeStamp);
    const pickAt = aim ? { x: aim.x * scale, y: aim.y * scale } : at;
    const list = framesNow.current();
    const currentId = singleId();
    const current = list.find((layer) => layer.id === currentId) ?? null;
    const insideSelected = Boolean(current && insideFrame(current.frame, at.x, at.y));
    const alt = event.altKey;
    track(event, {
      threshold: DRAG_PX,
      cursor: "grabbing",
      begin: () => {
        const layer = insideSelected ? current : list.find((item) => item.id === stageHits(list, at.x, at.y)[0]) ?? null;
        if (!layer) return null;
        if (layer.id !== currentId) b.selection.set([layer.id], layer.id);
        return beginGesture("move", layer, at);
      },
      click: () => {
        const id = pickHit(stageHits(list, pickAt.x, pickAt.y), currentId, alt);
        if (!id) { if (latest.current.selection.ids.length) b.selection.clear(); return; }
        if (id !== currentId) b.selection.set([id], id);
      },
    });
  };

  const onHandle = (event: React.PointerEvent<HTMLDivElement>, kind: "scale" | "rotate", at: FrameCorner | FrameEdge) => {
    const start = pointAt(event);
    const id = singleId();
    const layer = id ? framesNow.current().find((item) => item.id === id) : undefined;
    if (!start || !layer) return;
    const r = layer.frame.r;
    const cursor = kind === "rotate" ? rotateCursor(ROTATE_AT[at as FrameCorner] + r, cssColor(color.white, "#ffffff"), cssColor(color.black, "#000000")) : resizeCursor(HANDLE_ANGLE[at] + r);
    track(event, { threshold: 0, cursor, begin: () => beginGesture(kind, layer, start, at) });
  };

  // 悬停预示（B1）：rAF 里算一次命中，给排第一的（已选中的除外）画个细框；指针在选中的框里、能挪时换成抓手
  const hoverAt = useRef<Point | null>(null);
  const hoverFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);
  const onStageMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture || regionMode || playback.playing || editingText) return;
    hoverAt.current = pointAt(event);
    if (hoverFrame.current) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const at = hoverAt.current;
      if (!at) return;
      const list = framesRef.current;
      const currentId = singleId();
      const first = stageHits(list, at.x, at.y)[0] ?? null;
      const current = list.find((layer) => layer.id === currentId);
      const grab = Boolean(current && showsTools(latest.current) && insideFrame(current.frame, at.x, at.y) && !keyframeLocks(current.segment).move);
      const next = first && first !== currentId ? first : null;
      setHover((value) => (value.id === next && value.grab === grab ? value : { id: next, grab }));
    });
  };
  const onStageLeave = () => { hoverAt.current = null; setHover(NO_HOVER); };

  // 双击文字改字：位置用第一下按下时记的画布坐标（第一下会打开详情卡、画面跟着缩小）
  const onStageDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (latest.current.regionMode || editingRef.current) return;
    const aim = doubleClickAim(presses.current, event.timeStamp);
    const at = aim ? { x: aim.x * scale, y: aim.y * scale } : pointAt(event);
    if (!at) return;
    const list = framesNow.current();
    const hits = stageHits(list, at.x, at.y);
    const isText = (id: string | null | undefined) => Boolean(id && list.find((layer) => layer.id === id)?.segment.kind === "text");
    const currentId = singleId();
    const id = currentId && hits.includes(currentId) && isText(currentId) ? currentId : isText(hits[0]) ? hits[0]! : null;
    if (id) startTextEdit(id);
  };

  // ---------- 右键菜单（1B） ----------
  // 只重置位置、大小和角度，不透明度和翻转留着；全回到默认时清掉整个 transform
  const resetTransform = (id: string) => {
    const found = findSegment(latest.current.project, id);
    if (!found) return;
    if (held.current?.nudge.id === id) discardNudge();
    const next = resetPlacement(baseOf(found.segment));
    void sendTransform(id, next, isIdentityTransform(next) ? { clip_id: id, transform: null } : undefined);
  };
  const menuItems = (layer: FramedLayer | null): MenuEntry[] => {
    const b = latest.current;
    const blocked = canTouch() ? null : b.notEditableReason ?? BUSY_TEXT;
    const ask: MenuItem = {
      id: "region", label: "在这里框一块问 AI", icon: <SquareDashed size={14} color={color.text} />, disabled: b.duration ? null : "还没有画面",
      onSelect: () => b.startRegionSelect(),
    };
    if (!layer) return [ask];
    const { segment } = layer;
    const id = segment.id;
    const entries: MenuEntry[] = [{
      id: "split", label: "在播放头处切开", shortcut: "split", icon: <Scissors size={14} color={color.text} />,
      disabled: blocked ?? (splitOffset(segment, b.playback.timeRef.current) === null ? "播放头不在这段中间，切不开" : null),
      onSelect: () => { void b.split(id); },
    }];
    if (segment.kind === "text") entries.push({ id: "edit-text", label: "编辑文字", shortcut: "edit-text", icon: <Type size={14} color={color.text} />, disabled: blocked, onSelect: () => { startTextEdit(id); } });
    entries.push(
      { id: "reset", label: "重置位置、大小和角度", icon: <RotateCcw size={14} color={color.text} />, disabled: blocked ?? (isDefaultPlacement(baseOf(segment)) ? "位置、大小和角度本来就是原样" : null), onSelect: () => resetTransform(id) },
      { id: "sep-ask", separator: true },
      { id: "refer", label: "引用到对话", icon: <Quote size={14} color={color.text} />, onSelect: () => b.refer([{ kind: "clip", clipId: id }]) },
      ask,
      { id: "sep-delete", separator: true },
      { id: "delete", label: "删除", danger: true, shortcut: "remove", icon: <Trash2 size={14} color={color.danger} />, disabled: blocked, onSelect: () => { void b.removeSelected(); } },
    );
    return entries;
  };
  // 右键先选中下面那段（按在选中的框里、它的缩放角和拉伸条上就是它），菜单不会删错；角外看不见的旋转区照常往下找
  const onStageMenu = (event: React.MouseEvent<HTMLDivElement>, onSelected = false) => {
    event.preventDefault();
    const b = latest.current;
    const at = pointAt(event);
    if (b.regionMode || editingRef.current || !at) return;
    if (b.playback.playing) b.playback.pause();
    const list = framesNow.current();
    const currentId = singleId();
    const current = list.find((layer) => layer.id === currentId) ?? null;
    const layer = current && (onSelected || insideFrame(current.frame, at.x, at.y)) ? current : list.find((item) => item.id === stageHits(list, at.x, at.y)[0]) ?? null;
    if (layer && layer.id !== currentId) b.selection.set([layer.id], layer.id);
    menu.open({ x: event.clientX, y: event.clientY }, menuItems(layer));
  };

  // ---------- 框选（问 AI） ----------
  const beginRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    const node = stageRef.current;
    if (event.button !== 0 || !node) return;
    event.preventDefault();
    const bounds = node.getBoundingClientRect();
    const size = { width: bounds.width, height: bounds.height };
    const x0 = event.clientX - bounds.left;
    const y0 = event.clientY - bounds.top;
    const at = shownTime;
    let rect = dragRect(x0, y0, x0, y0, size);
    setDrawing(rect);
    const move = (next: PointerEvent) => {
      rect = dragRect(x0, y0, next.clientX - bounds.left, next.clientY - bounds.top, size);
      setDrawing(rect);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrawing(null);
      const ratios = regionBox(rect, size);
      // 只点了一下、框太小就当没框，框选还开着
      if (!ratios) return;
      // 采集器最多收 30 个片段
      const clipIds = layersInRect(rect, stageLayers(node)).slice(0, 30);
      const labels = clipIds.map((id) => {
        const found = findSegment(project, id);
        return found ? board.callName(found.segment) : "";
      }).filter(Boolean);
      board.setRegion({ time_us: Math.round(at), ...ratios, clip_ids: clipIds, labels });
      board.stopRegionSelect();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // 只挂载当前和下一段的媒体元素：同一个片段从「预加载」变成「正在放」时 key 不变，元素不重建
  const layers = useMemo(() => {
    const list: Array<{ layer: { track: EditTrack; trackIndex: number; segment: EditSegment }; active: boolean }> = [];
    const active = new Set([...frame.visuals, ...frame.audios].map((layer) => layer.segment.id));
    (project?.tracks ?? []).forEach((track, trackIndex) => {
      for (const layer of [...frame.visuals, ...frame.audios]) if (layer.trackIndex === trackIndex) list.push({ layer, active: true });
      const next = nextSegmentAfter(track, shownTime);
      if (next && (next.kind === "video" || next.kind === "audio") && next.timeline.start_us - shownTime < 4 * US_PER_SECOND && !active.has(next.id)) {
        list.push({ layer: { track, trackIndex, segment: next }, active: false });
      }
    });
    return list;
  }, [frame, project, shownTime]);

  // 选中框：只选了一段、它此刻在画面上、没在播放、没在框选、没在改字时画；手柄按关键帧分别禁用（B6）
  const single = selection.ids.length === 1 && selected ? selected.segment : null;
  const target = single && !playback.playing && !regionMode && editingText !== single.id ? frames.find((layer) => layer.id === single.id) ?? null : null;
  const locks = target ? keyframeLocks(target.segment) : null;
  const note = locks ? lockNote(locks) : null;
  const handles = target && locks && (sending || showsTools({ editable, notEditableReason })) ? { scale: !locks.scale, rotate: !locks.rotate, edges: !locks.scale && STRETCHABLE.has(target.segment.kind) } : null;
  const cursorColors = handles?.rotate ? { light: cssColor(color.white, "#ffffff"), dark: cssColor(color.black, "#000000") } : null;
  const hovered = hover.id && !gesture && !regionMode && !playback.playing && !editingText ? frames.find((layer) => layer.id === hover.id) ?? null : null;
  const captionTop = target ? (() => { const aabb = frameAabb(target.frame); return Math.min(Math.max(4, aabb.y + aabb.h + 4), stage.height - 26); })() : 0;
  const shownRegion = drawing ?? (region && stage.width ? { left: region.x * stage.width, top: region.y * stage.height, width: region.width * stage.width, height: region.height * stage.height } : null);
  const ready = Boolean(project && duration);
  // 参考线、数值提示记的是拖动开始时的舞台像素，换算到现在的舞台
  const gx = gesture && gesture.stage.width > 0 ? stage.width / gesture.stage.width : 1;
  const gy = gesture && gesture.stage.height > 0 ? stage.height / gesture.stage.height : 1;

  return <View {...areaProps("stage")} style={styles.stageBox} onLayout={(event: LayoutChangeEvent) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
    {scale > 0 ? <div style={{ position: "relative", width: stage.width, height: stage.height }}>
      <div ref={stageRef} aria-label="画面预览" style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: color.black, isolation: "isolate", borderRadius: 2, filter: overlayFilter(frame.overlays.map((layer) => layer.segment), shownTime) || undefined }}>
        {layers.map(({ layer, active }) => <Layer key={layer.segment.id} layer={layer} active={active} canvas={canvas} stage={stage}
          time={shownTime} playing={playback.playing} mediaById={mediaById} mediaUrl={mediaUrl} filmUrl={filmUrl} onNatural={bumpSizes}
          override={overrideOf(layer.segment.id)}
          text={shownText?.id === layer.segment.id ? shownText.value : null}
          editing={editingText === layer.segment.id} onEditDone={finishTextEdit} />)}
        {!ready ? <div style={stageNote}>{running ? "AI 正在搭时间线…" : "还没有画面"}</div> : null}
      </div>
      {ready ? <div
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerLeave={onStageLeave}
        onDoubleClick={onStageDoubleClick}
        onContextMenu={onStageMenu}
        style={{ position: "absolute", inset: 0, zIndex: 1, touchAction: "none", pointerEvents: editingText || regionMode ? "none" : "auto", cursor: gesture?.cursor ?? (hover.grab ? "grab" : "default") }}
      /> : null}
      {hovered ? <div style={{ ...frameStyle(hovered.frame), zIndex: 2, boxSizing: "border-box", border: `1px solid ${color.accent}`, pointerEvents: "none" }} /> : null}
      {target ? <SelectionFrame frame={target.frame} handles={handles} moving={gesture?.kind === "move"} colors={cursorColors} onHandle={onHandle} onMenu={onStageMenu} /> : null}
      {guides.map((guide) => <div key={`${guide.axis}:${guide.at}`} style={guide.axis === "x"
        ? { ...guideLine, left: Math.min(Math.max(0, guide.at * gx - 0.5), stage.width - 1), top: 0, width: 1, height: stage.height }
        : { ...guideLine, top: Math.min(Math.max(0, guide.at * gy - 0.5), stage.height - 1), left: 0, height: 1, width: stage.width }} />)}
      {target && note ? <div style={{ ...stageCaption, top: captionTop }}>{note}</div> : null}
      {hint ? <div style={{
        ...hintStyle,
        ...(hint.x * gx + 150 > stage.width ? { right: Math.max(0, stage.width - hint.x * gx + 14) } : { left: hint.x * gx + 14 }),
        top: hint.y * gy + 40 > stage.height ? Math.max(0, hint.y * gy - 34) : hint.y * gy + 16,
      }}>{hint.text}</div> : null}
      {regionMode ? <div aria-label="在画面上按住拖出一个框" onPointerDown={beginRegion} style={{ position: "absolute", inset: 0, zIndex: 6, cursor: "crosshair" }} /> : null}
      {shownRegion ? <div style={{
        position: "absolute", left: shownRegion.left, top: shownRegion.top, width: shownRegion.width, height: shownRegion.height, boxSizing: "border-box", zIndex: 6, pointerEvents: "none",
        border: `2px dashed ${color.accent}`, backgroundColor: alpha(color.accent, 0.12),
      }} /> : null}
    </div> : null}
    {menu.element}
  </View>;
}

/** 按框的中心、宽高、角度摆一个 div（没转之前的位置 + rotate） */
const frameStyle = (frame: StageFrame): React.CSSProperties => ({
  position: "absolute", left: frame.cx - frame.w / 2, top: frame.cy - frame.h / 2, width: frame.w, height: frame.h, transform: frame.r ? `rotate(${frame.r}deg)` : undefined,
});

const CORNER_AT: Record<FrameCorner, { x: 0 | 1; y: 0 | 1 }> = { nw: { x: 0, y: 0 }, ne: { x: 1, y: 0 }, se: { x: 1, y: 1 }, sw: { x: 0, y: 1 } };

/**
 * 选中框（B2、B3、1B）：按中心、宽高、角度画，手柄都在转过的框上；东西太小时手柄放在至少 28px 的外圈上，边框仍按真实大小。
 * 四角 14×14 的命中区里画 8×8 的小方块（缩放），角外 20×20 的隐形区是旋转，视频、图片、贴纸的四条边能拉伸。框本身不接指针，点击交给下面那层。
 * 手柄上右键也弹画面菜单：缩放角、拉伸条算在选中的这段上，旋转区照常按下面是什么算。
 * 摆法照 openfilm 的 StageTransformFrame（studio/ui/src/components/StageTransformFrame.tsx），MIT License，Copyright (c) 2026 OpenFilm contributors。
 */
function SelectionFrame({ frame, handles, moving, colors, onHandle, onMenu }: {
  frame: StageFrame; handles: { scale: boolean; rotate: boolean; edges: boolean } | null; moving: boolean; colors: { light: string; dark: string } | null;
  onHandle: (event: React.PointerEvent<HTMLDivElement>, kind: "scale" | "rotate", at: FrameCorner | FrameEdge) => void;
  onMenu: (event: React.MouseEvent<HTMLDivElement>, onSelected: boolean) => void;
}) {
  const w = Math.max(frame.w, 1);
  const h = Math.max(frame.h, 1);
  const hw = Math.max(w, HANDLE_BOX_MIN);
  const hh = Math.max(h, HANDLE_BOX_MIN);
  // 边上的拉伸条两头给角让出地方
  const insetX = Math.min(8, hw / 4);
  const insetY = Math.min(8, hh / 4);
  const press = (kind: "scale" | "rotate", at: FrameCorner | FrameEdge) => (event: React.PointerEvent<HTMLDivElement>) => {
    // Mac 上 Ctrl+点击是右键，交给菜单
    if (event.button !== 0 || (IS_MAC && event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    onHandle(event, kind, at);
  };
  const onFrameMenu = (event: React.MouseEvent<HTMLDivElement>) => onMenu(event, true);
  const onTurnMenu = (event: React.MouseEvent<HTMLDivElement>) => onMenu(event, false);
  return <div style={{ position: "absolute", left: frame.cx - hw / 2, top: frame.cy - hh / 2, width: hw, height: hh, zIndex: 3, pointerEvents: "none", transform: frame.r ? `rotate(${frame.r}deg)` : undefined }}>
    <div style={{
      position: "absolute", left: (hw - w) / 2, top: (hh - h) / 2, width: w, height: h, boxSizing: "border-box",
      border: `1.5px solid ${color.accent}`, outline: `1px solid ${alpha(color.black, 0.45)}`, backgroundColor: moving ? alpha(color.accent, 0.06) : undefined,
    }} />
    {handles?.edges ? EDGES.map((edge) => <div key={edge} aria-hidden onPointerDown={press("scale", edge)} onContextMenu={onFrameMenu} style={{
      position: "absolute", pointerEvents: "auto", cursor: resizeCursor(HANDLE_ANGLE[edge] + frame.r),
      ...(edge === "n" ? { left: insetX, right: insetX, top: -4, height: 8 } : edge === "s" ? { left: insetX, right: insetX, bottom: -4, height: 8 }
        : edge === "w" ? { top: insetY, bottom: insetY, left: -4, width: 8 } : { top: insetY, bottom: insetY, right: -4, width: 8 }),
    }} />) : null}
    {handles?.rotate && colors ? CORNERS.map((corner) => {
      const at = CORNER_AT[corner];
      return <div key={`turn-${corner}`} aria-hidden onPointerDown={press("rotate", corner)} onContextMenu={onTurnMenu} style={{
        position: "absolute", width: 20, height: 20, pointerEvents: "auto", cursor: rotateCursor(ROTATE_AT[corner] + frame.r, colors.light, colors.dark),
        left: at.x ? undefined : -20, right: at.x ? -20 : undefined, top: at.y ? undefined : -20, bottom: at.y ? -20 : undefined,
      }} />;
    }) : null}
    {handles?.scale ? CORNERS.map((corner) => {
      const at = CORNER_AT[corner];
      return <div key={corner} aria-label="拖动缩放" onPointerDown={press("scale", corner)} onContextMenu={onFrameMenu} style={{
        position: "absolute", width: 14, height: 14, left: `calc(${at.x * 100}% - 7px)`, top: `calc(${at.y * 100}% - 7px)`,
        display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto", cursor: resizeCursor(HANDLE_ANGLE[corner] + frame.r),
      }}>
        <span style={{ display: "block", width: 8, height: 8, boxSizing: "border-box", backgroundColor: color.white, border: `1px solid ${color.accent}` }} />
      </div>;
    }) : null}
  </div>;
}

/** 画面下面那一行：播放、时间、框选开关，右边写此刻生效的滤镜、特效、动画。 */
export function PlayerBar() {
  const { project, canvas, duration, playback, regionMode, startRegionSelect, stopRegionSelect, refer } = useBoard();
  const time = usePlaybackTime();
  const shownTime = shownTimeOf(time, duration);
  const frame = useMemo(() => activeFrame(project, shownTime), [project, shownTime]);
  const names = useMemo(() => {
    const items: string[] = [];
    for (const { segment } of frame.overlays) items.push(segment.kind === "track_effect" ? `特效 ${featureName(segment.effect_type)}` : segment.kind === "track_filter" ? `滤镜 ${featureName(segment.filter_type)}` : "");
    for (const { segment } of frame.visuals) {
      if ("filters" in segment) for (const item of segment.filters ?? []) items.push(`滤镜 ${featureName(item.filter_type)}`);
      if ("effects" in segment) for (const item of segment.effects ?? []) items.push(`特效 ${featureName(item.effect_type)}`);
      if ("animations" in segment) for (const item of segment.animations ?? []) items.push(`动画 ${featureName(item.animation_type)}`);
    }
    return [...new Set(items.filter(Boolean))];
  }, [frame]);
  const toggleRegion = useCallback(() => (regionMode ? stopRegionSelect() : startRegionSelect()), [regionMode, startRegionSelect, stopRegionSelect]);
  // 播放中读到的播放头不在帧上，落到整帧再引用
  const referMoment = useCallback(() => refer([{ kind: "time", timeUs: Math.min(duration, snapToFrame(playback.timeRef.current, canvas.fps)) }]), [refer, duration, playback.timeRef, canvas.fps]);

  // 照剪辑软件的播放器：时间码在左、播放钮居中、框选在右
  return <View style={styles.controls}>
    <View style={styles.controlsSide}>
      <Text style={styles.clock}>{formatClock(time)} <Text style={kit.muted}>/ {formatClock(duration)}</Text></Text>
    </View>
    <Pressable {...ws("btn square")} accessibilityRole="button" accessibilityLabel={playback.playing ? "暂停" : "播放"} disabled={!duration} onPress={playback.toggle} style={[styles.playButton, !duration && styles.disabled, webPointer]}>
      {playback.playing ? <Pause size={15} color={color.text} /> : <Play size={15} color={color.text} />}
    </Pressable>
    <View style={[styles.controlsSide, styles.controlsEnd]}>
      <Text numberOfLines={1} style={[kit.muted, { flexShrink: 1, minWidth: 0, textAlign: "right" }]}>
        {regionMode ? "在画面上按住拖出一个框，发消息时 AI 只改框里的东西" : names.length ? `此刻生效（近似预览）：${names.join("、")}` : ""}
      </Text>
      {/* 只画图标（版式角色仍用 small：square 会被风格放大到 32–40）：选中片段弹出详情卡时这半边只剩 90 左右，带字的两个按钮会往左压到播放钮上 */}
      <WebTitle title={regionMode ? "框选（再点一下取消）" : "框选：在画面上框一块，让 AI 只改那里"}>
        <Pressable
          {...ws("btn small", regionMode && "on")}
          accessibilityRole="button"
          accessibilityLabel="框选"
          accessibilityState={{ selected: regionMode, disabled: !duration }}
          disabled={!duration}
          onPress={toggleRegion}
          style={[styles.chip, styles.chipSquare, regionMode && styles.chipOn, !duration && styles.disabled, webPointer]}
        >
          <SquareDashed size={13} color={regionMode ? color.accent : color.text} />
        </Pressable>
      </WebTitle>
      <WebTitle title="引用这一刻：把播放头这一刻引用到对话">
        <Pressable
          {...ws("btn small")}
          accessibilityRole="button"
          accessibilityLabel="引用这一刻"
          accessibilityState={{ disabled: !duration }}
          disabled={!duration}
          onPress={referMoment}
          style={[styles.chip, styles.chipSquare, !duration && styles.disabled, webPointer]}
        >
          <Quote size={13} color={color.text} />
        </Pressable>
      </WebTitle>
    </View>
  </View>;
}

const guideLine: React.CSSProperties = { position: "absolute", zIndex: 4, pointerEvents: "none", backgroundColor: color.accent };

const hintStyle: React.CSSProperties = {
  position: "absolute", zIndex: 5, pointerEvents: "none", whiteSpace: "nowrap", padding: "2px 6px", borderRadius: 4,
  backgroundColor: alpha(color.black, 0.9), color: color.white, fontFamily: font.mono, fontSize: 10.5, lineHeight: "15px", fontVariantNumeric: "tabular-nums",
};

const stageCaption: React.CSSProperties = {
  position: "absolute", left: 6, right: 6, zIndex: 5, textAlign: "center", pointerEvents: "none", padding: "3px 8px", borderRadius: 4,
  color: color.white, backgroundColor: alpha(color.black, 0.62), fontSize: 11, lineHeight: "16px", fontFamily: font.body,
};

const stageNote: React.CSSProperties = {
  position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 12,
  color: alpha(color.white, 0.55), fontSize: 12, fontFamily: font.body,
};

// 元素自己读到的画面尺寸（按 url 记，同一素材换片段不用再等）。素材库的宽高只按 mp4/mov 的旋转信息转正过，
// 不管照片的 EXIF 方向和其他容器；浏览器给的 videoWidth / naturalWidth 都已经转正，以它为准。
const naturalSizes = new Map<string, Size>();

function useNaturalSize(url: string | null, onChange?: () => void): [Size | null, (width: number, height: number) => void] {
  const [, setSeen] = useState<Size | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const report = useCallback((width: number, height: number) => {
    if (!url || !(width > 0 && height > 0)) return;
    const before = naturalSizes.get(url);
    naturalSizes.set(url, { width, height });
    // 每个图层自己记一份，尺寸变了才重渲染；同一素材的另一个图层先读到时这里也能跟上
    setSeen((seen) => seen && seen.width === width && seen.height === height ? seen : { width, height });
    if (!before || before.width !== width || before.height !== height) changed.current?.();
  }, [url]);
  return [url ? naturalSizes.get(url) ?? null : null, report];
}

/**
 * 画面里的一个图层；根元素带 data-layer-id（片段 id），框选按它量位置。
 * override 是拖动时的临时 transform，text 是改完字还没回来时的新字，editing 时文字图层变成能直接打字的。
 */
function Layer({ layer, active, canvas, stage, time, playing, mediaById, mediaUrl, filmUrl, override, text, editing = false, onEditDone, onNatural }: {
  layer: { track: EditTrack; trackIndex: number; segment: EditSegment }; active: boolean; canvas: EditCanvas; stage: Size; time: number; playing: boolean;
  mediaById: ReadonlyMap<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null; filmUrl: (path: string) => string | null; override?: EditTransform | null; text?: string | null;
  editing?: boolean; onEditDone?: (id: string, value: string | null) => void; onNatural?: () => void;
}) {
  const { track } = layer;
  const segment = override && FRAMED_KINDS.has(layer.segment.kind) ? withTransform(layer.segment, override) : layer.segment;
  const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
  // 网页片段：看板上直接开它的网页、按时间画（底下渲好的视频留给剪映和出片用）
  const page = segment.kind === "video" && item?.status === "ready" ? pageOf(item) : null;
  const pageAddress = page ? filmUrl(`pages/${page}`) : null;
  // 网页改写后重渲的还是同一个素材：地址带上渲染时间，iframe 才会重新加载
  const pageUrl = pageAddress && item?.source.renderedAt ? `${pageAddress}?v=${item.source.renderedAt}` : pageAddress;
  const url = item?.status === "ready" && !pageUrl ? mediaUrl(item.id) : null;
  const [natural, reportSize] = useNaturalSize(segment.kind === "audio" ? null : url, onNatural);
  const offset = Math.max(0, time - segment.timeline.start_us);
  if (segment.kind === "text") {
    return active ? <TextLayer segment={text != null ? { ...segment, text } : segment} canvas={canvas} stage={stage} offset={offset} editing={editing} onEditDone={onEditDone} /> : null;
  }
  if (segment.kind === "sticker") {
    if (!active) return null;
    const transform = effectiveTransform(segment, offset);
    const side = stickerSide(stage);
    const rect = layerRect(stage, { width: side, height: side }, transform);
    return <div data-layer-id={segment.id} title="贴纸（导进剪映后能看到）" style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, opacity: rect.opacity, transform: cssTransform(rect), border: `1px dashed ${alpha(color.white, 0.6)}`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: alpha(color.white, 0.75) }}>
      <Sticker size={Math.max(12, side * 0.4)} color={alpha(color.white, 0.75)} />
    </div>;
  }
  if (segment.kind !== "video" && segment.kind !== "image" && segment.kind !== "audio") return null;
  if (segment.kind === "audio") return url ? <MediaElement kind="audio" url={url} segment={segment} track={track} time={time} playing={playing} active={active} style={{ display: "none" }} /> : null;

  const transform = effectiveTransform(segment, offset);
  const fit = segment.fit ?? "contain";
  // 有地址时只信元素读到的尺寸；没读到之前框按画布比例、让浏览器按 fit 自己摆，不拉伸。
  // 素材还没就绪时只画占位框，素材库的宽高够用
  const material = url ? natural : item?.width && item.height ? { width: item.width, height: item.height } : null;
  const box = layerBox(stage, material, fit, segment.keyframes);
  const rect = layerRect(stage, box, transform);
  const mask = maskCss(segment.mask as MaskSpec | null | undefined, { width: rect.width, height: rect.height }, material);
  // 剪映的转场、动画、滤镜、特效：近似画出来（看得出加上了），以剪映为准
  const look = featureLook(segment, offset, track.segments);
  const turned = cssTransform(rect);
  const style: React.CSSProperties = {
    position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    objectFit: material || (fit === "stretch" && !hasScaleKeyframes(segment.keyframes)) ? "fill" : fit === "cover" && !hasScaleKeyframes(segment.keyframes) ? "cover" : "contain",
    transform: [look.transform, turned === "none" ? "" : turned].filter(Boolean).join(" ") || "none", opacity: active ? rect.opacity * look.opacity : 0,
    filter: [colorFilter(segment.keyframes, offset), look.filter].filter(Boolean).join(" ") || undefined,
    mixBlendMode: (blendMode(segment.mix_mode?.mode) ?? undefined) as React.CSSProperties["mixBlendMode"],
    clipPath: cropClipPath(segment.crop) ?? undefined,
    pointerEvents: "none",
    ...(mask as React.CSSProperties | null),
  };
  const fill = active && segment.background_filling ? <div style={{ position: "absolute", inset: 0, backgroundColor: segment.background_filling.fill_type === "color" ? rgba(segment.background_filling.color ?? "#000000") : color.black, overflow: "hidden" }}>
    {segment.background_filling.fill_type === "blur" && segment.kind === "image" && url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: `blur(${Math.round(4 + (segment.background_filling.blur ?? 0.0625) * 60)}px)`, transform: "scale(1.1)" }} /> : null}
  </div> : null;
  if (pageUrl && item?.width && item.height) {
    return <PageLayer url={pageUrl} layerId={segment.id} active={active} seconds={sourceTimeUs(segment as EditMediaSegment, time) / US_PER_SECOND}
      page={{ width: item.width, height: item.height }} style={{ ...style, opacity: active ? rect.opacity * look.opacity : 0 }} rect={rect} />;
  }
  if (!url) return active ? <>{fill}<div data-layer-id={segment.id} style={{ ...style, objectFit: undefined, opacity: rect.opacity, backgroundColor: alpha(color.white, 0.08), border: `1px solid ${alpha(color.white, 0.18)}`, display: "flex", alignItems: "center", justifyContent: "center", color: alpha(color.white, 0.6), fontSize: 11, fontFamily: font.body, textAlign: "center", padding: 6, boxSizing: "border-box" }}>
    {item?.status === "importing" ? "素材还在导入" : clipLabel(segment, item ? mediaTitle(item) : null)}
  </div></> : null;
  if (segment.kind === "image") return active ? <>{fill}<img data-layer-id={segment.id} src={url} alt="" draggable={false} style={style}
    onLoad={(event) => reportSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /></> : null;
  return <>{fill}<MediaElement kind="video" url={url} segment={segment} track={track} time={time} playing={playing} active={active} style={style} onSize={reportSize} layerId={segment.id} /></>;
}

/**
 * 网页片段（openfilm 的页面）：iframe 按网页自己的大小排版，再缩到片段在画面上的框里。时间变了就把素材里的秒数发给页面
 * （采集器在页面里放了桥，按 window.film.frame(t) 画；画着的时候又来新的只画最后一个）。点、拖都落在外层，iframe 不接鼠标。
 */
function PageLayer({ url, layerId, active, seconds, page, style, rect }: {
  url: string; layerId: string; active: boolean; seconds: number; page: Size; style: React.CSSProperties; rect: { width: number; height: number };
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const origin = useMemo(() => { try { return new URL(url).origin; } catch { return "*"; } }, [url]);
  useEffect(() => { setLoaded(false); }, [url]);
  useEffect(() => {
    if (loaded && active) ref.current?.contentWindow?.postMessage({ film: "frame", t: Math.max(0, seconds) }, origin);
  }, [loaded, active, seconds, origin]);
  const { objectFit: _fit, ...box } = style;
  return <div data-layer-id={layerId} style={{ ...box, overflow: "hidden" }}>
    <iframe ref={ref} src={url} title="网页片段" tabIndex={-1} scrolling="no" sandbox="allow-scripts allow-same-origin" onLoad={() => setLoaded(true)}
      style={{ position: "absolute", left: 0, top: 0, width: page.width, height: page.height, border: 0, background: "transparent", pointerEvents: "none",
        transformOrigin: "0 0", transform: `scale(${rect.width / page.width},${rect.height / page.height})` }} />
  </div>;
}

function MediaElement({ kind, url, segment, track, time, playing, active, style, onSize, layerId }: {
  kind: "video" | "audio"; url: string; segment: EditMediaSegment; track: EditTrack; time: number; playing: boolean; active: boolean; style: React.CSSProperties;
  onSize?: (width: number, height: number) => void; layerId?: string;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // 最后想停在哪：seek 还没完时来的新位置（预览轴划得快）不能丢，seek 完了再补一次
  const want = useRef(0);
  // 每次渲染都校准：偏差超过 0.15 秒（暂停时 0.03 秒）才 seek，倍速、音量、静音跟着片段走
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!active) {
      if (!element.paused) element.pause();
      const start = segment.source.start_us / US_PER_SECOND;
      want.current = start;
      if (!element.seeking && Math.abs(element.currentTime - start) > 0.15) element.currentTime = start;
      element.muted = true;
      return;
    }
    const target = sourceTimeUs(segment, time) / US_PER_SECOND;
    want.current = target;
    const rate = playbackRate(segment.speed);
    if (element.playbackRate !== rate) element.playbackRate = rate;
    (element as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = !segment.change_pitch;
    const sound = mediaVolume(segment, track, time - segment.timeline.start_us);
    element.volume = sound.volume;
    element.muted = sound.muted;
    if (!element.seeking && Math.abs(element.currentTime - target) > (playing ? 0.15 : 0.03)) element.currentTime = target;
    if (playing && element.paused) void element.play().catch(() => undefined);
    if (!playing && !element.paused) element.pause();
  });
  useEffect(() => () => ref.current?.pause(), []);
  const onSeeked = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget;
    if (element.paused && !element.seeking && Math.abs(element.currentTime - want.current) > 0.03) element.currentTime = want.current;
  };
  return kind === "audio"
    ? <audio ref={ref} src={url} preload="auto" style={style} onSeeked={onSeeked} />
    : <video ref={ref} data-layer-id={layerId} src={url} preload="auto" playsInline muted style={style} onSeeked={onSeeked}
      onLoadedMetadata={(event) => onSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
      onResize={(event) => onSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />;
}

// 能打字的元素优先只收纯文字（粘贴进来也不带格式），老浏览器退回普通可编辑
const PLAINTEXT_ONLY = (() => {
  if (!web || typeof document === "undefined") return false;
  try {
    const probe = document.createElement("div");
    probe.contentEditable = "plaintext-only";
    return probe.contentEditable === "plaintext-only";
  } catch {
    return false;
  }
})();

/**
 * 文字图层。editing 时变成能直接打字的（1B）：进来就全选；回车提交、Shift+回车换行、Esc 放弃、失焦算提交；
 * 被收起（选中换了、换了工程）时也算提交。按键不往外传，看板的快捷键不会抢。退出时换一个 key 重建元素，免得留着打了一半的字。
 */
function TextLayer({ segment, canvas, stage, offset, editing, onEditDone }: {
  segment: EditTextSegment; canvas: EditCanvas; stage: Size; offset: number; editing: boolean; onEditDone?: (id: string, value: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onEditDone);
  done.current = onEditDone;
  const finished = useRef(true);
  const id = segment.id;
  const finish = useCallback((node: HTMLElement | null, commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    done.current?.(id, commit && node ? (node.innerText ?? node.textContent ?? "").replace(/\n$/u, "") : null);
  }, [id]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!editing || !node) return undefined;
    finished.current = false;
    node.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(node);
    const picked = window.getSelection();
    picked?.removeAllRanges();
    picked?.addRange(range);
    return () => finish(node, true);
  }, [editing, finish]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); finish(event.currentTarget, false); }
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finish(event.currentTarget, true); }
  };
  const transform = effectiveTransform(segment, offset);
  const look = featureLook(segment, offset);
  const css = textCss(segment, canvas, stage) as React.CSSProperties;
  const flipX = transform.flip_horizontal ? -1 : 1;
  const flipY = transform.flip_vertical ? -1 : 1;
  return <div
    key={editing ? "edit" : "view"}
    ref={ref}
    data-layer-id={segment.id}
    data-layer-kind="text"
    contentEditable={editing ? (PLAINTEXT_ONLY ? "plaintext-only" : true) : undefined}
    suppressContentEditableWarning={editing || undefined}
    spellCheck={editing ? false : undefined}
    role={editing ? "textbox" : undefined}
    aria-label={editing ? "改文字，回车保存，Esc 放弃" : undefined}
    aria-multiline={editing || undefined}
    onKeyDown={editing ? onKeyDown : undefined}
    onBlur={editing ? (event) => finish(event.currentTarget, true) : undefined}
    style={{
      position: "absolute",
      left: stage.width / 2 + transform.transform_x * stage.width / 2,
      top: stage.height / 2 - transform.transform_y * stage.height / 2,
      width: "max-content",
      transform: `translate(-50%,-50%) ${look.transform} rotate(${transform.rotation}deg) scale(${transform.scale_x * flipX},${transform.scale_y * flipY})`,
      opacity: Math.min(1, Math.max(0, transform.alpha)) * look.opacity,
      filter: look.filter || undefined,
      fontFamily: font.body,
      pointerEvents: editing ? "auto" : "none",
      ...css,
      ...(editing ? { cursor: "text", caretColor: color.accent, outline: `1px dashed ${color.accent}`, outlineOffset: 2, userSelect: "text", WebkitUserSelect: "text", minWidth: 8 } : null),
    }}
  >{segment.text}</div>;
}

const styles = StyleSheet.create({
  // 手柄、旋转区会伸出画面外一点：画面四周留了 STAGE_PAD，在这块地方里能点，不压到旁边的详情卡和播放栏
  stageBox: { flex: 1, minWidth: 0, minHeight: 0, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  controls: { flexDirection: "row", alignItems: "center", gap: 10, height: 30 },
  controlsSide: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  controlsEnd: { justifyContent: "flex-end" },
  playButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  clock: { color: color.text, fontFamily: font.mono, fontSize: 12, fontVariant: ["tabular-nums"] },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  chipSquare: { width: 28, height: 26, paddingHorizontal: 0, paddingVertical: 0, justifyContent: "center" },
  chipOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  disabled: { opacity: 0.45 },
});
