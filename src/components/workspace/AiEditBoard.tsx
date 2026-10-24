import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Download, FolderInput, X } from "lucide-react-native";
import {
  editAiEditClip, editAiEditClips, redoAiEdit, setAiEditCanvas, undoAiEdit,
  type AiEditDraftBoxStatus, type AiEditExportMode, type AiEditMediaItem, type AiEditSession, type EditCanvas, type EditProject, type EditSegment,
} from "../../services/aiEdit";
import {
  cutPoints, draftBoxReasonText, findSegment, formatDuration, mediaIdFromPath, nextCut, projectDuration, stepFrame, US_PER_SECOND, type ExportNote,
} from "./aiEditModel";
import { clipCallName, selectableIds, settleSelection, splitOffset, splitTarget, tooManyEditsText, undoKind, type PendingSelect, type Picked } from "./aiEditBoardEdit";
import {
  BoardContext, BoardPreviewContext, BoardRegistryContext, BoardTimeContext, createBoardRegistry, createPreviewTimeStore, discardHeld, dispatchBoardKey, dispatchEscape, flushHeld, useRegistryEscape, useRegistryKeys,
  type BoardArea, type BoardContextValue, type BoardEdit, type BoardJump, type BoardPlayback, type BoardRef, type BoardSelection, type EditCall, type EditPerformer, type PointerArea, type ToastTone,
} from "./aiEditBoardContext";
import { IN_FLIGHT_REASON, lastingReason, redoneText, undoneText } from "./aiEditInspect";
import { composing, inMenuOrDialog, readBoardKey, typingInto } from "./aiEditKeymap";
import { ClipCard } from "./AiEditClipCard";
import { rippleEdits } from "./aiEditTimelineMagnet";
import { timelinePrefs } from "./aiEditTimelinePrefs";
import { useContextMenu } from "./AiEditMenu";
import { PlayerBar, Stage } from "./AiEditStage";
import { Timeline, timelineHeight } from "./AiEditTimeline";
import { areaProps, CANVAS_OPTIONS, CANVASES, canvasPreset, mediaTitle, pressableDisabled, shortTime, web, WebTitle, webPointer, type BoardRegion } from "./aiEditShared";
import { kit, Segmented, SmallButton } from "./CreatorKit";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 剪辑页的剪辑看板，照剪辑软件排：顶栏（剪辑切换、画面比例、撤销、导入剪映），中间三块面板
// （左边对话和素材由页面传进来、中间播放器、右边属性），底下是整宽的轨道区。
// 这里管看板的公共状态（播放、选中、提示气泡、框选开关），把改动命令和它们一起放进 BoardContext；
// 快捷键、Esc 分层、焦点归还都在这里统一接（规格 C1–C6），各区域只登记自己的处理。

const DEFAULT_CANVAS: EditCanvas = { width: 1080, height: 1920, fps: 30 };
const BUSY_TEXT = IN_FLIGHT_REASON;
const TOAST_MS = 4000;
const NO_SELECTION: Picked = { ids: [], primary: null };

export interface BoardProps {
  session: AiEditSession | null;
  project: EditProject | null;
  media: AiEditMediaItem[];
  mediaUrl: (id: string) => string | null;
  draftBox: AiEditDraftBoxStatus | null;
  exporting: boolean;
  exportNote: ExportNote | null;
  /** 草稿在剪映里被改过时那句说明：等用户选另存一份还是覆盖 */
  exportConflict: string | null;
  running: boolean;
  /** 能不能手动改（有工程、AI 没在剪、没在导入、上一个改动已经回来） */
  editable: boolean;
  /** 不能改时的原因；上一个改动还没回来时是 IN_FLIGHT_REASON */
  notEditableReason: string | null;
  region: BoardRegion | null;
  /** 页面那一层的请求：一次只飞一个，回来的会话和工程由它换上 */
  perform: EditPerformer;
  onRegion: (region: BoardRegion) => void;
  /** 引用到对话（右键菜单、详情卡、播放器的「引用这一刻」） */
  onRefer: (refs: readonly BoardRef[]) => void;
  /** 页面请看板跳过去：点了回复里的片段、时间 */
  jump?: BoardJump | null;
  /** 导入剪映；mode 是草稿在剪映里被改过以后选的另存或覆盖。上一个改动还没回来、没开始导入时返回 false */
  onExport: (mode?: AiEditExportMode) => boolean;
  /** 草稿被改过时选了取消 */
  onDismissConflict: () => void;
  /** 出 MP4、导出 openfilm 工程（film.html）、停下、收起结果 */
  onOutput: (kind: "mp4" | "film" | "cancel" | "dismiss") => void;
  filmUrl: (path: string, download?: boolean) => string | null;
  /** 顶栏最左边：剪辑切换（页面给），宽度和左边面板对齐 */
  headStart?: React.ReactNode;
  /** 中间一排最左边的面板：AI 对话和素材（页面给） */
  side?: React.ReactNode;
  /** 左边面板多宽：属性面板放不放得下按它算 */
  sideWidth?: number;
}

/** 属性面板的宽度；中间一排除去左边面板还剩这么多（够画面 + 属性）才常驻，不然选中片段时才弹出来 */
const INSPECTOR = 272;
const ROOMY = 640;

export function Board(props: BoardProps) {
  const { session, project, media, mediaUrl, filmUrl, draftBox, exporting, exportNote, exportConflict, running, editable, notEditableReason, region, onDismissConflict, headStart, side, sideWidth = 0 } = props;
  const duration = projectDuration(project);
  const canvas = project?.canvas ?? DEFAULT_CANVAS;
  const frameUs = US_PER_SECOND / (canvas.fps > 0 ? canvas.fps : 30);
  const playback = usePlayback(duration, project?.id ?? null, frameUs);
  // 预览轴：时间线上划过的时刻，只给画面用
  const [preview] = useState(createPreviewTimeStore);
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  const registry = useMemo(createBoardRegistry, []);
  const rootRef = useRef<View>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // ---------- 选中 ----------
  // 新工程进来时：等着选中的（切开后的右半段）先选上；选中的片段不见了就去掉，都不见了详情卡就收起
  const [picked, setPicked] = useState<Picked>(NO_SELECTION);
  const [waiting, setWaiting] = useState<PendingSelect | null>(null);
  const [seenProject, setSeenProject] = useState(project);
  if (seenProject !== project) {
    setSeenProject(project);
    const next = settleSelection(project, picked, waiting, frameUs);
    if (next.picked !== picked) setPicked(next.picked);
    if (next.waiting !== waiting) setWaiting(next.waiting);
  }
  const setSelection = useCallback((ids: readonly string[], primary?: string | null) => {
    const unique = [...new Set(ids)];
    setPicked(unique.length ? { ids: unique, primary: primary && unique.includes(primary) ? primary : unique.at(-1)! } : NO_SELECTION);
  }, []);
  const toggleSelected = useCallback((id: string) => setPicked((current) => {
    if (!current.ids.includes(id)) return { ids: [...current.ids, id], primary: id };
    const ids = current.ids.filter((item) => item !== id);
    return ids.length ? { ids, primary: current.primary === id ? ids.at(-1)! : current.primary } : NO_SELECTION;
  }), []);
  const addSelected = useCallback((id: string) => setPicked((current) => ({ ids: current.ids.includes(id) ? current.ids : [...current.ids, id], primary: id })), []);
  const clearSelection = useCallback(() => setPicked(NO_SELECTION), []);
  const selection = useMemo<BoardSelection>(() => ({ ids: picked.ids, primary: picked.primary, set: setSelection, toggle: toggleSelected, add: addSelected, clear: clearSelection }),
    [picked, setSelection, toggleSelected, addSelected, clearSelection]);
  const selected = useMemo(() => findSegment(project, picked.primary), [project, picked.primary]);
  const splitHint = selected && splitOffset(selected.segment, playback.time) === null ? "播放头不在这段中间，切不开" : null;

  // ---------- 提示气泡（E1） ----------
  const [toastState, setToastState] = useState<{ text: string; tone: ToastTone; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((text: string, tone: ToastTone = "info") => {
    setToastState((current) => ({ text, tone, key: (current?.key ?? 0) + 1 }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // ---------- 框选（问 AI） ----------
  const [regionMode, setRegionMode] = useState(false);
  const projectId = project?.id ?? null;
  useEffect(() => { setRegionMode(false); }, [projectId]);

  // 命令里读的最新值：回调本身不变，memo 过的详情卡、按钮不用跟着重渲染
  const latest = useRef({ session, project, picked, notEditableReason, duration, canvas, playback, mediaById });
  latest.current = { session, project, picked, notEditableReason, duration, canvas, playback, mediaById };

  // ---------- 改动命令 ----------
  /**
   * 不能改就在气泡里说原因。「上一个改动还没回来」不在这里拦：先 flush 再发的命令（微调完马上 ⌘B、Delete、静音）
   * 跑到这里时请求刚回来、页面还没重渲染，读到的还是在路上那次的原因；锁真被占着时 perform 回 busy，request 照样提示稍等。
   */
  const guard = useCallback((): boolean => {
    const reason = lastingReason(latest.current.notEditableReason);
    if (reason) toast(reason);
    return !reason;
  }, [toast]);
  const request = useCallback(async (call: EditCall, fallback: string): Promise<boolean> => {
    const outcome = await propsRef.current.perform(call, fallback);
    if (!outcome.ok) toast(outcome.busy ? BUSY_TEXT : outcome.message, outcome.busy ? "info" : "error");
    // 紧接着的命令（先 flush 再切开）要按回来的工程算，等不到下一次渲染
    else latest.current = { ...latest.current, session: outcome.state.session, project: outcome.state.project };
    return outcome.ok;
  }, [toast]);
  const flushPending = useCallback(() => flushHeld(registry), [registry]);
  const expectSelect = useCallback((target: { trackId: string; atUs: number } | null) => {
    setWaiting(target ? { ...target, revision: latest.current.project?.revision ?? -1 } : null);
  }, []);
  const runEdits = useCallback(async (edits: readonly BoardEdit[], label?: string): Promise<boolean> => {
    if (!edits.length) return false;
    if (!guard()) { setWaiting(null); return false; }
    // 全选以后删、挪、复制是一段一条：超过采集器一批的上限就别发了，说清楚是选多了
    const tooMany = tooManyEditsText(edits.length);
    if (tooMany) { toast(tooMany); setWaiting(null); return false; }
    const [first] = edits;
    const ok = await request(edits.length === 1 && !label ? (connection, id) => editAiEditClip(connection, id, first!.name, first!.arguments) : (connection, id) => editAiEditClips(connection, id, edits, label),
      "这一下没改成，请稍后重试。");
    if (!ok) setWaiting(null);
    return ok;
  }, [guard, request, toast]);
  const runEdit = useCallback((name: BoardEdit["name"], args: Record<string, unknown>) => runEdits([{ name, arguments: args }]), [runEdits]);
  const undo = useCallback(async (to?: string): Promise<boolean> => {
    if (!guard()) return false;
    await flushPending();
    const current = latest.current.session;
    const history = current?.history ?? [];
    const index = to ? history.findIndex((item) => item.id === to) : 0;
    if (index < 0) { toast("这一步已经找不到了。", "error"); return false; }
    const step = to ? history[index] : current?.undo;
    if (!step) { toast("没有能撤销的改动了。"); return false; }
    const ok = await request((connection, id) => undoAiEdit(connection, id, to), "没撤销成功，请稍后重试。");
    if (ok) toast(undoneText(step, index + 1));
    return ok;
  }, [guard, request, toast, flushPending]);
  const redo = useCallback(async (): Promise<boolean> => {
    if (!guard()) return false;
    await flushPending();
    const label = latest.current.session?.redo?.label;
    if (!label) { toast("没有能重做的改动了。"); return false; }
    const ok = await request(redoAiEdit, "没重做成功，请稍后重试。");
    if (ok) toast(redoneText(label));
    return ok;
  }, [guard, request, toast, flushPending]);
  // 切开（A9）：一次只切一段；切完等新工程进来选中右半段，播放头不动，挪一下接着按 ⌘B。atUs 是分割工具点下去的地方
  const split = useCallback(async (clipId?: string, atUs?: number): Promise<boolean> => {
    if (!guard()) return false;
    await flushPending();
    const { project: current, picked: chosen, playback: player } = latest.current;
    const time = atUs ?? player.timeRef.current;
    const order = chosen.primary ? [chosen.primary, ...chosen.ids.filter((id) => id !== chosen.primary)] : chosen.ids;
    const target = clipId ? splitTarget(current, [clipId], time, { only: true }) : splitTarget(current, order, time);
    if (!target) { toast(atUs !== undefined ? "离这段两头太近了，切不开" : clipId ? "播放头不在这段中间，切不开" : "播放头下面没有能切的片段"); return false; }
    expectSelect({ trackId: target.track.id, atUs: target.segment.timeline.start_us + target.offset });
    return runEdit("split_clip", { clip_id: target.segment.id, offset: target.offset / US_PER_SECOND });
  }, [guard, toast, expectSelect, runEdit, flushPending]);
  const removeSelected = useCallback(async (): Promise<boolean> => {
    await flushPending();
    const { project: current, picked: chosen } = latest.current;
    const ids = chosen.ids.filter((id) => findSegment(current, id));
    if (!ids.length) return false;
    // 主轨磁吸、联动：删主轨片段时后面的合拢、跟着它的一起删
    const ripple = rippleEdits(current, { kind: "delete", ids }, timelinePrefs());
    if (ripple && "refused" in ripple) { toast(ripple.refused); return false; }
    if (ripple) return runEdits(ripple.edits, ripple.label);
    return runEdits(ids.map((id) => ({ name: "delete_clip" as const, arguments: { clip_id: id } })));
  }, [runEdits, flushPending, toast]);
  const selectAll = useCallback(() => {
    const { project: current, picked: chosen } = latest.current;
    const ids = selectableIds(current);
    if (ids.length) setSelection(ids, chosen.primary && ids.includes(chosen.primary) ? chosen.primary : ids[0]);
  }, [setSelection]);
  const callName = useCallback((segment: EditSegment) => {
    const item = "path" in segment ? latest.current.mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
    return clipCallName(segment, item ? mediaTitle(item) : null);
  }, []);
  const changeCanvas = async (next: EditCanvas) => {
    if (!guard()) return;
    await flushPending();
    await request((connection, id) => setAiEditCanvas(connection, id, { width: next.width, height: next.height }), "画面比例没换成，请稍后重试。");
  };
  // 导入（含草稿被改过后选另存、覆盖）前先把攒着的微调发出去，导进剪映的才带着这一下（C7）
  const startExport = (mode?: AiEditExportMode) => {
    void flushPending().then(() => { if (!propsRef.current.onExport(mode)) toast("上一个改动还没回来，稍等再导入"); });
  };
  // 详情卡数值框 flush 完以后按这个重新取工程（Board 的 latest 在请求回来时就换了，不等重渲染）
  const projectNow = useCallback(() => latest.current.project, []);
  const refer = useCallback((refs: readonly BoardRef[]) => propsRef.current.onRefer(refs), []);
  const setRegion = useCallback((value: BoardRegion) => propsRef.current.onRegion(value), []);
  const startRegionSelect = useCallback(() => { latest.current.playback.pause(); setRegionMode(true); }, []);
  const stopRegionSelect = useCallback(() => setRegionMode(false), []);

  // ---------- 页面让跳过去（回复里的片段、时间）：片段选中它、播放头放到开头；轨道区跟着滚到播放头 ----------
  const [revealSeq, setRevealSeq] = useState(0);
  const jump = props.jump ?? null;
  const jumped = useRef(0);
  useEffect(() => {
    if (!jump || jump.seq === jumped.current) return;
    jumped.current = jump.seq;
    const { project: current, playback: player } = latest.current;
    player.pause();
    if ("clipId" in jump) {
      const found = findSegment(current, jump.clipId);
      if (!found) { toast("这段已经不在时间线上了"); return; }
      setSelection([jump.clipId], jump.clipId);
      player.seek(found.segment.timeline.start_us);
    } else player.seek(jump.timeUs);
    setRevealSeq((value) => value + 1);
  }, [jump, toast, setSelection]);

  // ---------- 键盘、Esc、焦点（C1–C6） ----------
  const lastArea = useRef<PointerArea | null>(null);
  const lastPointerArea = useCallback(() => lastArea.current, []);
  // 焦点是不是用 Tab 移过去的（按 Tab 记 true、按下指针记 false）：空格要不要留给那个按钮
  const tabbed = useRef(false);
  useEffect(() => {
    if (!web) return undefined;
    const root = rootRef.current as unknown as HTMLElement | null;
    const areaOf = (target: EventTarget | null): PointerArea => {
      const node = target as Element | null;
      if (!root || !node || !root.contains(node)) return "outside";
      return (node.closest?.("[data-board-area]")?.getAttribute("data-board-area") as BoardArea | null) ?? "board";
    };
    const onDown = (event: PointerEvent) => {
      tabbed.current = false;
      const target = event.target as Element | null;
      // 点菜单项不算按到看板外面：点完接着按方向键还归看板
      if (!target?.closest?.('[role="menu"]')) lastArea.current = areaOf(target);
      // 焦点还在文字框里、又按在看板上别处时让它失焦，不然接着按 Delete 删的是字（C5）
      const active = globalThis.document?.activeElement as HTMLElement | null;
      if (lastArea.current !== "outside" && typingInto(active) && !typingInto(target)) active?.blur?.();
    };
    // Tab 移进看板也算；移出去（到左栏的输入框、菜单）不改，点了才算
    const onFocus = (event: FocusEvent) => { const area = areaOf(event.target); if (area !== "outside") lastArea.current = area; };
    const hasTextSelection = () => { const picked = globalThis.getSelection?.(); return Boolean(picked && !picked.isCollapsed && picked.toString()); };
    const dispatch = (event: KeyboardEvent, actions: Parameters<typeof dispatchBoardKey>[2]) =>
      dispatchBoardKey(registry, event, actions, lastArea.current, (handler, action) => (action === "copy" && hasTextSelection() ? false : handler(event)));
    // 空格在捕获阶段先问：焦点停在鼠标点过的按钮上时，RN-web 的 Pressable 会在冒泡前把空格当成按它，播放就没反应了
    const onKeyCapture = (event: KeyboardEvent) => {
      if (event.key === "Tab") tabbed.current = true;
      if (event.defaultPrevented) return;
      const read = readBoardKey(event, globalThis.document?.activeElement);
      if (read?.combo !== "Space" || !dispatch(event, read.actions)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (composing(event)) return;
        if (dispatchEscape(registry, event)) { event.preventDefault(); return; }
        if (typingInto(event.target) || inMenuOrDialog(event.target) || !latest.current.picked.ids.length) return;
        event.preventDefault();
        clearSelection();
        return;
      }
      const read = readBoardKey(event, globalThis.document?.activeElement);
      // 空格已经在捕获阶段问过了；有文字被选中时 ⌘C 照旧复制文字
      if (!read || read.combo === "Space") return;
      if (dispatch(event, read.actions)) event.preventDefault();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("focusin", onFocus, true);
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [registry, clearSelection]);

  useRegistryEscape(registry, () => { setRegionMode(false); return true; }, regionMode);

  // 看板自己的键：切开、删除、撤销、重做、全选、播放和播放头
  const seekBy = (to: (time: number) => number | null) => () => {
    const { duration: total, playback: player } = latest.current;
    if (!total) return false;
    const next = to(player.timeRef.current);
    player.pause();
    if (next !== null) player.seek(next);
    return undefined;
  };
  const frames = (count: number) => seekBy((time) => stepFrame(time, latest.current.canvas.fps, count));
  useRegistryKeys(registry, {
    split: () => { void split(); },
    remove: () => {
      if (!latest.current.picked.ids.length) return false;
      if (guard()) void removeSelected();
      return undefined;
    },
    // 还有没发出去的微调：丢掉本地预览就当撤销了这一下（C7）。键盘 ⌘Z 不撤 AI 剪的一整轮，免得按住 ⌘Z 一路撤过头；撤销按钮照撤（C9）
    undo: () => {
      if (discardHeld(registry)) return undefined;
      const last = latest.current.session?.undo;
      if (!last) return false;
      if (undoKind(last) === "turn") toast("上一步是 AI 剪的一整轮，要撤销请点撤销按钮");
      else void undo();
      return undefined;
    },
    redo: () => {
      if (!latest.current.session?.redo) return false;
      void redo();
      return undefined;
    },
    "select-all": () => {
      if (!selectableIds(latest.current.project).length) return false;
      selectAll();
      return undefined;
    },
    // 焦点在鼠标点过的按钮上时先让它失焦再播放；用 Tab 移过去的按钮，空格照旧按它（C5）
    "play-pause": () => {
      const active = globalThis.document?.activeElement as HTMLElement | null;
      if (active?.closest?.('button, [role="button"], a[href]')) {
        if (tabbed.current) return false;
        active.blur();
      }
      if (!latest.current.duration) return false;
      latest.current.playback.toggle();
      return undefined;
    },
    "frame-back": frames(-1),
    "frame-forward": frames(1),
    "jump-back": frames(-10),
    "jump-forward": frames(10),
    "prev-cut": seekBy((time) => nextCut(cutPoints(latest.current.project), time, -1)),
    "next-cut": seekBy((time) => nextCut(cutPoints(latest.current.project), time, 1)),
    start: seekBy(() => 0),
    end: seekBy(() => latest.current.duration),
  });

  // ---------- 给各区域的 context ----------
  const playbackApi = useMemo<BoardPlayback>(() => ({ playing: playback.playing, timeRef: playback.timeRef, toggle: playback.toggle, seek: playback.seek, pause: playback.pause }),
    [playback.playing, playback.timeRef, playback.toggle, playback.seek, playback.pause]);
  const value = useMemo<BoardContextValue>(() => ({
    session, project, canvas, frameUs, duration, mediaById, mediaUrl, filmUrl, running, editable, notEditableReason, playback: playbackApi, selection, selected, splitHint, callName,
    expectSelect, runEdit, runEdits, toast, undo, redo, split, removeSelected, flushHeld: flushPending, selectAll, refer, revealSeq, regionMode, startRegionSelect, stopRegionSelect, region, setRegion,
    lastPointerArea,
  }), [session, project, canvas, frameUs, duration, mediaById, mediaUrl, filmUrl, running, editable, notEditableReason, playbackApi, selection, selected, splitHint, callName,
    expectSelect, runEdit, runEdits, toast, undo, redo, split, removeSelected, flushPending, selectAll, refer, revealSeq, regionMode, startRegionSelect, stopRegionSelect, region, setRegion,
    lastPointerArea]);

  const [height, setHeight] = useState(0);
  const [rowWidth, setRowWidth] = useState(0);
  const canvasBlocked = !project ? "还没有时间线" : !editable ? notEditableReason : null;
  // 上一个改动还在路上不置灰：点了先 flush，等它回来再导
  const exportBlocked = !project || !duration ? "时间线还是空的，先让 AI 剪一版" : lastingReason(notEditableReason);
  const conflictBlocked = Boolean(lastingReason(notEditableReason));
  const output = session?.output ?? null;
  const outputBlocked = exportBlocked ?? (output?.state === "running" ? "上一个导出还没做完" : null);
  const outputMenu = useContextMenu();
  const openOutputMenu = (event: { nativeEvent: unknown }) => {
    const target = (event.nativeEvent as { target?: Element } | null)?.target;
    const rect = target?.closest?.("[data-output-menu]")?.getBoundingClientRect();
    outputMenu.open(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 }, [
      { id: "mp4", label: "导出成 MP4（不经剪映，在本机直接出片）", icon: <Download size={14} color={color.text} />, disabled: outputBlocked, onSelect: () => props.onOutput("mp4") },
      { id: "film", label: "导出网页工程（打成 zip）", icon: <FolderInput size={14} color={color.text} />, disabled: outputBlocked, onSelect: () => props.onOutput("film") },
    ]);
  };
  const status = exporting ? { tone: "muted" as const, text: "正在写进剪映草稿箱…" }
    : exportNote ? { tone: exportNote.tone, text: exportNote.text }
      : draftBox?.status === "unavailable" ? { tone: "warn" as const, text: draftBoxReasonText(draftBox.reason) }
        : draftBox?.jianyingRunning ? { tone: "warn" as const, text: "剪映正在运行，导入前先退出剪映。" }
          : session?.draftBox ? { tone: "muted" as const, text: `${shortTime(session.draftBox.exportedAt)}放进过剪映，名字是「${session.draftBox.draftName}」${project && project.revision !== session.draftBox.exportedRevision ? "，之后又改过，再导入会更新同一份草稿" : ""}。` }
            : { tone: "muted" as const, text: "做好后放进剪映草稿箱，在剪映里接着精修、导出。" };
  // 顶栏只在有新消息时说话（导入中、导入结果、剪映没装或开着、放进过剪映）；平常那句说明放在属性面板的草稿参数里
  const loud = exporting || exportNote || draftBox?.status === "unavailable" || draftBox?.jianyingRunning || session?.draftBox;

  return <BoardContext.Provider value={value}>
    <BoardRegistryContext.Provider value={registry}>
      <BoardTimeContext.Provider value={playback.time}>
       <BoardPreviewContext.Provider value={preview}>
        <View ref={rootRef} {...areaProps("board")} style={styles.board} onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height)}>
          <View style={styles.boardHead}>
            {headStart}
            <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.status, status.tone === "warn" && { color: color.danger }, status.tone === "ok" && { color: color.green }]}>{loud ? status.text : ""}</Text>
            {project ? <WebTitle title={canvasBlocked ?? "画面比例"}>
              <View pointerEvents={canvasBlocked ? "none" : "auto"} style={canvasBlocked ? styles.disabled : null}>
                <Segmented small options={CANVAS_OPTIONS} value={canvasPreset(project.canvas)} onChange={(label) => {
                  const preset = CANVASES.find((item) => item.label === label);
                  if (preset && label !== canvasPreset(project.canvas)) void changeCanvas(preset.canvas);
                }} />
              </View>
            </WebTitle> : null}
            {output && output.kind !== "import" ? <OutputChip output={output} filmUrl={filmUrl} onOutput={props.onOutput} /> : null}
            {web ? <WebTitle title={outputBlocked ?? "不经剪映直接出 MP4，或者导出成网页工程"}>
              <div data-output-menu="" style={{ flexShrink: 0 }}>
                <Pressable
                  {...ws("btn")}
                  accessibilityRole="button"
                  accessibilityLabel="导出"
                  accessibilityState={{ expanded: outputMenu.isOpen }}
                  {...pressableDisabled(outputBlocked)}
                  onPress={(event) => { if (!outputBlocked) openOutputMenu(event); }}
                  style={[styles.outputButton, outputBlocked ? styles.disabled : webPointer]}
                >
                  <Download size={15} color={color.text} />
                  <Text numberOfLines={1} style={styles.outputText}>导出</Text>
                </Pressable>
              </div>
            </WebTitle> : null}
            {outputMenu.element}
            <WebTitle title={exportBlocked ?? "放进剪映草稿箱，在剪映里接着精修、导出"}>
              <Pressable
                {...ws("btn-solid")}
                accessibilityRole="button"
                accessibilityLabel="导入剪映草稿箱"
                {...pressableDisabled(exportBlocked)}
                onPress={() => { if (!exportBlocked) startExport(); }}
                style={[styles.exportButton, exportBlocked ? styles.disabled : webPointer]}
              >
                {exporting ? <ActivityIndicator size="small" color={color.buttonText} /> : <FolderInput size={15} color={color.buttonText} />}
                <Text style={styles.exportText}>导入剪映草稿箱</Text>
              </Pressable>
            </WebTitle>
          </View>
          {exportConflict && !exporting ? <View {...ws("e-box")} accessibilityRole="alert" style={styles.conflict}>
            <Text style={styles.conflictText}>{exportConflict}另存一份新草稿不会动剪映里那份；选覆盖的话，在剪映里做的改动会丢掉。</Text>
            <View style={styles.conflictActions}>
              <Pressable {...ws("btn-solid")} accessibilityRole="button" disabled={conflictBlocked} onPress={() => startExport("new")} style={[styles.conflictPrimary, conflictBlocked && styles.disabled, webPointer]}>
                <Text style={styles.exportText}>另存一份新草稿</Text>
              </Pressable>
              <SmallButton label="覆盖剪映里的改动" disabled={conflictBlocked} onPress={() => startExport("update")} />
              <SmallButton label="取消" onPress={onDismissConflict} />
            </View>
          </View> : null}

          <View style={styles.work} onLayout={(event: LayoutChangeEvent) => setRowWidth(event.nativeEvent.layout.width)}>
            {side}
            <View {...ws("e-box", "ai-panel", "ai-player")} style={styles.player}>
              <Stage />
              <PlayerBar />
            </View>
            {/* 放得下就常驻一块属性面板（没选片段时是草稿参数）；放不下时选中片段才在画面右边弹出详情卡 */}
            {rowWidth - sideWidth >= ROOMY
              ? <View style={{ width: INSPECTOR, minHeight: 0, flexDirection: "row" }}>{selected ? <ClipCard width={INSPECTOR} projectNow={projectNow} /> : <DraftPanel project={project} duration={duration} status={status.text} />}</View>
              : <ClipCard width={Math.round(Math.min(280, Math.max(196, (rowWidth - sideWidth) * 0.42)))} projectNow={projectNow} />}
          </View>
          <Timeline height={timelineHeight(project?.tracks.length ?? 0, height)} />
          {toastState && web ? <BoardToast key={toastState.key} text={toastState.text} tone={toastState.tone} /> : null}
        </View>
       </BoardPreviewContext.Provider>
      </BoardTimeContext.Provider>
    </BoardRegistryContext.Provider>
  </BoardContext.Provider>;
}

const OUTPUT_NAMES = { mp4: "出片", film: "导出工程", import: "导入工程" } as const;

/** 顶栏上导出的进度和结果：做着显示百分比和停止；做好了给下载链接，没带过去的东西写在悬停提示里 */
function OutputChip({ output, filmUrl, onOutput }: {
  output: NonNullable<AiEditSession["output"]>; filmUrl: (path: string, download?: boolean) => string | null; onOutput: (kind: "cancel" | "dismiss") => void;
}) {
  const name = OUTPUT_NAMES[output.kind];
  const close = <Pressable accessibilityRole="button" accessibilityLabel="收起" hitSlop={6} onPress={() => onOutput("dismiss")} style={webPointer}><X size={13} color={color.textMuted} /></Pressable>;
  if (output.state === "running") {
    return <View style={styles.outputChip} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={color.textMuted} />
      <Text style={styles.outputChipText}>{name}中 {Math.round((output.progress ?? 0) * 100)}%</Text>
      <Pressable accessibilityRole="button" onPress={() => onOutput("cancel")} style={webPointer}><Text style={styles.outputLink}>停止</Text></Pressable>
    </View>;
  }
  if (output.state === "done" && output.file) {
    const href = filmUrl(output.file, true);
    const size = output.size ? `${Math.max(0.1, Math.round(output.size / 1024 / 1024 * 10) / 10)}MB` : "";
    return <WebTitle title={[`「${output.name}」${size ? `，${size}` : ""}`, output.note].filter(Boolean).join("\n")}>
      <View style={[styles.outputChip, styles.outputDone]}>
        <Text numberOfLines={1} style={[styles.outputChipText, { color: color.green }]}>{output.kind === "mp4" ? "片子出好了" : "工程包好了"}{output.note ? "（有没带过去的）" : ""}</Text>
        {href && web ? <a href={href} download={output.name} style={{ color: color.accent, fontFamily: font.body, fontSize: 12, fontWeight: 600, textDecoration: "none" }}>下载</a> : null}
        {close}
      </View>
    </WebTitle>;
  }
  return <WebTitle title={output.error ?? ""}>
    <View style={styles.outputChip}>
      <Text numberOfLines={1} style={[styles.outputChipText, output.state === "failed" && { color: color.danger }]}>{output.state === "cancelled" ? `${name}停了` : `${name}没成功：${output.error ?? "原因不明"}`}</Text>
      {close}
    </View>
  </WebTitle>;
}

/** 没选片段时属性面板里放草稿参数，和剪辑软件一样；剪映草稿的状态也在这儿说全 */
function DraftPanel({ project, duration, status }: { project: EditProject | null; duration: number; status: string }) {
  const clips = project?.tracks.reduce((sum, track) => sum + track.segments.length, 0) ?? 0;
  const rows: Array<[string, string]> = project ? [
    ["名称", project.name || "未命名"],
    ["画面", `${project.canvas.width}×${project.canvas.height}${canvasPreset(project.canvas) ? `（${canvasPreset(project.canvas)}）` : ""}`],
    ["帧率", `${project.canvas.fps} 帧/秒`],
    ["时长", formatDuration(duration)],
    ["轨道", `${project.tracks.length} 条，${clips} 段`],
  ] : [];
  return <View {...ws("e-box", "ai-panel")} style={styles.draft}>
    <Text style={styles.draftTitle}>草稿参数</Text>
    {project ? rows.map(([label, value]) => <View key={label} style={styles.draftRow}>
      <Text style={styles.draftLabel}>{label}</Text>
      <Text selectable numberOfLines={2} style={styles.draftValue}>{value}</Text>
    </View>) : <Text style={kit.muted}>还没有时间线，在左边跟 AI 说想剪成什么样。</Text>}
    <View style={styles.draftRow}>
      <Text style={styles.draftLabel}>剪映</Text>
      <Text style={styles.draftValue}>{status}</Text>
    </View>
    {project ? <Text style={[kit.muted, styles.draftHint]}>点时间线上的片段，这里能改它的开始、时长、位置和大小。</Text> : null}
  </View>;
}

/** 看板底部中间的小药丸：普通提示 role=status，出错 role=alert、红字；不挡下面的点击。 */
function BoardToast({ text, tone }: { text: string; tone: ToastTone }) {
  return <div style={{ position: "absolute", left: 0, right: 0, bottom: 22, zIndex: 30, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
    <div role={tone === "error" ? "alert" : "status"} data-motion="fade" style={{
      maxWidth: "80%", padding: "7px 14px", borderRadius: 999, border: `1px solid ${tone === "error" ? color.danger : color.border}`,
      backgroundColor: color.surfaceRaised, color: tone === "error" ? color.danger : color.text, fontFamily: font.body, fontSize: 12.5, lineHeight: "18px", textAlign: "center",
    }}>{text}</div>
  </div>;
}

// ---------- 播放 ----------

type Playback = BoardPlayback & { time: number };

/** 播放头按墙上时钟走（rAF），视频元素跟着它校准，不反过来。timeRef 在 seek 当下就更新，同一拍里接着读也是新值。 */
function usePlayback(duration: number, projectId: string | null, frameUs: number): Playback {
  const [time, setTimeState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef(0);
  const setTime = useCallback((next: number) => { timeRef.current = next; setTimeState(next); }, []);
  const anchor = useRef({ origin: 0, at: 0 });
  useEffect(() => { setPlaying(false); setTime(0); }, [projectId, setTime]);
  useEffect(() => { if (time > duration) setTime(duration); }, [duration, time, setTime]);
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    anchor.current = { origin: timeRef.current, at: performance.now() };
    const tick = (now: number) => {
      const next = anchor.current.origin + Math.max(0, now - anchor.current.at) * 1000;
      if (next >= duration) { setTime(duration); setPlaying(false); return; }
      setTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, setTime]);
  // 停着的播放头落在整帧上：切开、裁到播放头、粘贴、吸附都拿它当时间点，不在帧上的话导进剪映会差半帧
  const onFrame = useCallback((us: number) => Math.min(duration, Math.round(Math.round(us / frameUs) * frameUs)), [duration, frameUs]);
  const seek = useCallback((us: number) => {
    const next = onFrame(Math.min(Math.max(0, us), duration));
    anchor.current = { origin: next, at: performance.now() };
    setTime(next);
  }, [duration, onFrame, setTime]);
  const toggle = useCallback(() => {
    if (playing) { setPlaying(false); setTime(onFrame(timeRef.current)); return; }
    if (duration <= 0) return;
    if (timeRef.current >= duration) setTime(0);
    setPlaying(true);
  }, [playing, duration, onFrame, setTime]);
  const pause = useCallback(() => { setPlaying(false); setTime(onFrame(timeRef.current)); }, [onFrame, setTime]);
  return { time, playing, timeRef, toggle, seek, pause };
}

const styles = StyleSheet.create({
  board: { flex: 1, minWidth: 0, minHeight: 0, gap: 8, padding: 8, paddingTop: 0 },
  boardHead: { flexDirection: "row", alignItems: "center", gap: 10, height: 52 },
  status: { flex: 1, minWidth: 0, color: color.textMuted, fontFamily: font.body, fontSize: 11.5, lineHeight: 17, textAlign: "right" },
  work: { flex: 1, minHeight: 0, flexDirection: "row", gap: 8 },
  player: { flex: 1, minWidth: 0, minHeight: 0, gap: 6, padding: 10, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  draft: { flex: 1, gap: 9, padding: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  draftTitle: { color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600", marginBottom: 2 },
  draftRow: { flexDirection: "row", gap: 10 },
  draftLabel: { width: 34, color: color.textMuted, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  draftValue: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  draftHint: { marginTop: "auto" },
  conflict: { gap: 8, padding: 10, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  conflictText: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  conflictActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  conflictPrimary: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: 30, borderRadius: radius.small, backgroundColor: color.button },
  outputButton: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0, paddingHorizontal: 11, height: 34, borderRadius: radius.small, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  outputText: { color: color.text, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
  outputChip: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0, maxWidth: 260, height: 28, paddingHorizontal: 9, borderRadius: radius.small, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  outputDone: { borderColor: color.green },
  outputChipText: { flexShrink: 1, color: color.text, fontFamily: font.body, fontSize: 12 },
  outputLink: { color: color.accent, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  exportButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 13, height: 34, borderRadius: radius.small, backgroundColor: color.button },
  exportText: { color: color.buttonText, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
  disabled: { opacity: 0.45 },
});
