import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type MutableRefObject } from "react";
import type {
  AiEditCatalogKind, AiEditClipEdit, AiEditEditCall, AiEditMediaItem, AiEditSession, AiEditSessionState, EditCanvas, EditProject, EditSegment, EditTrack,
} from "../../services/aiEdit";
import type { ExploreConnection } from "../../services/explorer";
import { BOARD_KEYS, type BoardAction } from "./aiEditKeymap";
import type { ComposerRef } from "./aiEditRefs";
import type { BoardRegion } from "./aiEditShared";

// 看板的内部接口：<Board> 提供 BoardContext，轨道区、画面、详情卡、撤销按钮用 useBoard() 取工程、选中、改动命令；
// 每帧都在变的播放头单独放一个 context（usePlaybackTime），免得 memo 过的组件跟着每帧重渲染。
// 快捷键和 Esc 都由 <Board> 在 window 上统一接，各区域用 useBoardKeys / useEscapeLayer 登记自己的处理。
// 接口说明另见 scratchpad 里的 board-internal-api.md。

/** 看板里的区域：最后一次按下（或焦点移进）在哪个区域，决定方向键这类同一个键归谁（C6） */
export type BoardArea = "timeline" | "stage" | "board";
/** 最后一次按下的位置：看板外面（左栏、弹窗）是 outside，还没按过是 null */
export type PointerArea = BoardArea | "outside";
export type ToastTone = "info" | "error";

/** 看板上能引用到对话里的：一段、某一刻 */
export type BoardRef = Extract<ComposerRef, { kind: "clip" | "time" }>;
/** 页面请看板跳过去（点了回复里的片段、时间）：片段是选中它、播放头放到开头；seq 每次加一，同一处再点也会跳 */
export type BoardJump = ({ clipId: string } | { timeUs: number }) & { seq: number };

/** 一条看板改动，和 AI 的同名工具参数一样（时间按秒） */
export type BoardEdit = AiEditEditCall;

/** 请采集器做一件看板上的事（改动、撤销、重做、换画面比例）的结果；锁被占时 busy 为 true */
export type EditOutcome =
  | { ok: true; state: AiEditSessionState }
  | { ok: false; busy: boolean; message: string; code: string | null };
export type EditCall = (connection: ExploreConnection, sessionId: string) => Promise<AiEditSessionState>;
/** 页面那一层的「一次只飞一个」：锁、换上回来的会话和工程都在那里做 */
export type EditPerformer = (call: EditCall, fallback: string) => Promise<EditOutcome>;

export interface BoardSelection {
  /** 选中的片段 id，按选上的先后 */
  ids: readonly string[];
  /** 详情卡显示的那段；ids 为空时为 null，否则一定在 ids 里 */
  primary: string | null;
  /** 换成这几段；primary 不给（或不在 ids 里）时取最后一个 */
  set: (ids: readonly string[], primary?: string | null) => void;
  /** 有就去掉、没有就加上并设为 primary */
  toggle: (id: string) => void;
  /** 加上并设为 primary（已经有了只改 primary） */
  add: (id: string) => void;
  clear: () => void;
}

export interface BoardPlayback {
  playing: boolean;
  /** 最新的播放头（微秒），给事件处理里读；要按播放头画东西用 usePlaybackTime() */
  timeRef: { readonly current: number };
  toggle: () => void;
  /** 跳到某处（夹在 0 到总时长之间），不改播放状态 */
  seek: (us: number) => void;
  pause: () => void;
  /** 从 from 放到 to 停下（剪映素材加上后试播那一段）；暂停、拖播放头、切工程都会打断它 */
  playRange: (fromUs: number, toUs: number) => void;
}

export interface BoardContextValue {
  session: AiEditSession | null;
  project: EditProject | null;
  /** 工程的画布；还没有工程时按竖屏 1080×1920、30 帧 */
  canvas: EditCanvas;
  /** 一帧多少微秒 */
  frameUs: number;
  /** 工程总时长（微秒） */
  duration: number;
  mediaById: ReadonlyMap<string, AiEditMediaItem>;
  mediaUrl: (mediaId: string) => string | null;
  /** 采集器上网页片段、film.html 和做好的文件的地址（path 相对 ai-edit 根目录，比如 pages/<id>/index.html） */
  filmUrl: (path: string, download?: boolean) => string | null;
  /** AI 正在剪 */
  running: boolean;
  /** 能不能在看板上手动改：有工程、AI 没在剪、没在导入、上一个改动已经回来 */
  editable: boolean;
  /** 不能改时的原因（给 aria-disabled 的 title、提示气泡用）；能改时为 null */
  notEditableReason: string | null;
  playback: BoardPlayback;
  selection: BoardSelection;
  /** selection.primary 那段和它所在的轨道；没选时为 null */
  selected: { track: EditTrack; segment: EditSegment } | null;
  /** 选中那段现在切不开的原因（播放头不在它中间）；能切或没选时为 null。只在播放头跨过边界时变 */
  splitHint: string | null;
  /** 片段的口语称呼：视频“海边”、文字“标题”，给菜单、提示、引用用 */
  callName: (segment: EditSegment) => string;
  /**
   * 等下一个新工程进来时选中某段：那条轨道上开头离 atUs 不到一帧的片段（切开后选右半段、粘贴后选新的那段用）。
   * 发请求之前调；请求失败时 runEdit / runEdits 会自动撤掉；传 null 手动撤掉。
   */
  expectSelect: (target: { trackId: string; atUs: number } | null) => void;
  /** 发一个看板改动。一次只飞一个；不能改、锁被占、失败都会在提示气泡里说，返回 false；成功换上新工程返回 true */
  runEdit: (name: AiEditClipEdit, args: Record<string, unknown>) => Promise<boolean>;
  /** 一批改动一次发出：采集器整批只存一份存档（一步撤销），任何一条失败整批回滚。空数组直接返回 false；label 是撤销按钮上的说法 */
  runEdits: (edits: readonly BoardEdit[], label?: string) => Promise<boolean>;
  /** 看板底部的小提示，4 秒后消失；同样的话再来会重新弹一次 */
  toast: (text: string, tone?: ToastTone) => void;
  /** 撤销上一步；带 to（操作历史里某一步的 id）时一次撤到那一步之前。成功会弹「已撤销：…」 */
  undo: (to?: string) => Promise<boolean>;
  redo: () => Promise<boolean>;
  /** 切开（⌘B、详情卡按钮、右键菜单共用）：给 clipId 只切那段；不给按 A9 的规则找。切完选中右半段，播放头不动 */
  split: (clipId?: string, atUs?: number) => Promise<boolean>;
  /** 删掉选中的所有片段（多段一批发，一步撤销） */
  removeSelected: () => Promise<boolean>;
  /** 把各区域攒着没发的改动（键盘微调）立刻发出去，等它们都回来再 resolve；自己发改动之前先调（C7） */
  flushHeld: () => Promise<void>;
  /** 刚加上的剪映效果在这一段上试播一遍（按工程里最新的片段算范围，放不了就不动） */
  previewFeature: (segmentId: string, kind: AiEditCatalogKind) => void;
  /** 选中所有轨道上的片段（字幕轨除外） */
  selectAll: () => void;
  /** 引用到对话：加到左栏输入框上方，随下一句话发给 AI */
  refer: (refs: readonly BoardRef[]) => void;
  /** 页面让看板跳过去的次数：轨道区跟着把播放头滚进视图 */
  revealSeq: number;
  /** 画面上的框选（问 AI）开着 */
  regionMode: boolean;
  /** 打开框选：先暂停，然后在画面上按住拖出一个框 */
  startRegionSelect: () => void;
  stopRegionSelect: () => void;
  /** 已经框好、等着随下一句话发出去的那一块 */
  region: BoardRegion | null;
  setRegion: (region: BoardRegion) => void;
  /** 最后一次按下在哪个区域（捕获阶段记的，按下和焦点移进都算） */
  lastPointerArea: () => PointerArea | null;
}

export const BoardContext = createContext<BoardContextValue | null>(null);
export const BoardTimeContext = createContext(0);

export function useBoard(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard 只能在 <Board> 里面用");
  return value;
}

/** 播放头（微秒），每帧都变：只在要按它画东西的组件里用 */
export const usePlaybackTime = () => useContext(BoardTimeContext);

/**
 * 预览轴：鼠标在时间线上划过时画面要显示的时刻（微秒），没在划是 null。每次挪鼠标都会变，单独一个小仓库，
 * 只有画面订阅，看板别的部分不跟着重渲染。
 */
export interface PreviewTimeStore { get: () => number | null; set: (time: number | null) => void; subscribe: (listener: () => void) => () => void }
export function createPreviewTimeStore(): PreviewTimeStore {
  let time: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set: (next) => { if (next === time) return; time = next; for (const listener of listeners) listener(); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
const NO_PREVIEW: PreviewTimeStore = { get: () => null, set: () => undefined, subscribe: () => () => undefined };
export const BoardPreviewContext = createContext<PreviewTimeStore>(NO_PREVIEW);
export const usePreviewStore = () => useContext(BoardPreviewContext);
/** 画面该显示的预览时刻；没在划时间线、或者正在播放时是 null */
export function usePreviewTime(): number | null {
  const store = useContext(BoardPreviewContext);
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}

// ---------- 快捷键和 Esc 的登记 ----------

/** 处理一个动作；返回 false 表示这次不管（交给后面登记的、或者别的区域），其余都算处理了，看板会 preventDefault */
export type BoardKeyHandler = (event: KeyboardEvent) => boolean | void;
export type BoardKeyHandlers = Partial<Record<BoardAction, BoardKeyHandler>>;
/** Esc 的一层：返回 true 表示吃掉这次 Esc */
export type EscapeHandler = (event: KeyboardEvent) => boolean | void;

/**
 * 本地先攒着、还没发出去的改动（键盘微调停手 350ms 才合成一次提交，C7）：
 * flush 立刻发出去（先清掉自己攒的，再 runEdit），等请求回来再 resolve，没攒东西就直接返回；
 * discard 丢掉本地预览、不发请求，丢了东西返回 true（键盘 ⌘Z 时就当撤销了这一下）。
 */
export interface HeldEdit { flush: () => Promise<unknown> | void; discard: () => boolean }

interface KeyEntry { area: BoardArea; handlers: MutableRefObject<BoardKeyHandlers>; enabled: MutableRefObject<boolean> }
interface EscapeEntry { handler: MutableRefObject<EscapeHandler> }
interface HoldEntry { held: MutableRefObject<HeldEdit> }
export interface BoardRegistry { keys: KeyEntry[]; escapes: EscapeEntry[]; holds: HoldEntry[] }

export const createBoardRegistry = (): BoardRegistry => ({ keys: [], escapes: [], holds: [] });
export const BoardRegistryContext = createContext<BoardRegistry | null>(null);

/** useBoardKeys 的本体，<Board> 自己登记看板级的键时直接用 */
export function useRegistryKeys(registry: BoardRegistry | null, handlers: BoardKeyHandlers, options: { area?: BoardArea; enabled?: boolean } = {}) {
  const area = options.area ?? "board";
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabledRef = useRef(options.enabled ?? true);
  enabledRef.current = options.enabled ?? true;
  useEffect(() => {
    if (!registry) return undefined;
    const entry: KeyEntry = { area, handlers: handlersRef, enabled: enabledRef };
    registry.keys.push(entry);
    return () => { registry.keys.splice(registry.keys.indexOf(entry), 1); };
  }, [registry, area]);
}

/**
 * 登记这个区域的快捷键，键名是 BOARD_KEYS 的动作名。handlers 每次渲染都可以是新对象（只读最新的，不重新登记）。
 * area 是 timeline / stage 时只在最后一次按在那个区域时生效，而且比 board 的先问；不写是 board，看板里哪都生效。
 * 同一区域里后登记的先问。enabled 为 false 时整组跳过。
 */
export function useBoardKeys(handlers: BoardKeyHandlers, options: { area?: BoardArea; enabled?: boolean } = {}) {
  useRegistryKeys(useContext(BoardRegistryContext), handlers, options);
}

/** useEscapeLayer 的本体 */
export function useRegistryEscape(registry: BoardRegistry | null, handler: EscapeHandler, active: boolean) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!registry || !active) return undefined;
    const entry: EscapeEntry = { handler: handlerRef };
    registry.escapes.push(entry);
    return () => { registry.escapes.splice(registry.escapes.indexOf(entry), 1); };
  }, [registry, active]);
}

/**
 * Esc 的一层（C4）：active 时登记，后登记的先问，返回 true 吃掉这次 Esc（看板会 preventDefault），
 * 都不吃才轮到看板自己（取消选中、收起卡片）。拖动中的 Esc 不走这里：拖动自己在 window 捕获阶段拿走并 preventDefault；
 * 右键菜单也在捕获阶段拿走。焦点在输入框里时 Esc 照样会先问各层，看板自己那一步才跳过。
 */
export function useEscapeLayer(handler: EscapeHandler, active: boolean) {
  useRegistryEscape(useContext(BoardRegistryContext), handler, active);
}

/**
 * 登记一份本地攒着的改动（见 HeldEdit）：看板在切开、删除、撤销、重做、换画面比例之前先 flush 它，
 * 键盘 ⌘Z 时先 discard 它。换选中时要不要 flush 由登记的一方自己看着办。
 */
export function useHeldEdit(held: HeldEdit) {
  const registry = useContext(BoardRegistryContext);
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (!registry) return undefined;
    const entry: HoldEntry = { held: heldRef };
    registry.holds.push(entry);
    return () => { registry.holds.splice(registry.holds.indexOf(entry), 1); };
  }, [registry]);
}

export async function flushHeld(registry: BoardRegistry): Promise<void> {
  await Promise.all(registry.holds.map((entry) => entry.held.current.flush()));
}

export function discardHeld(registry: BoardRegistry): boolean {
  let dropped = false;
  for (const entry of registry.holds) dropped = entry.held.current.discard() || dropped;
  return dropped;
}

/**
 * 把一次按键分给登记的处理：先问最后一次按下的那个区域登记的（后登记的先问），再问 board 的；
 * 看板外面按的只认标了 anywhere 的动作；会改工程的动作按住连发时只认第一下（吃掉后面的，不再执行）。
 * 返回 true 表示处理了（调用方 preventDefault）。
 */
export function dispatchBoardKey(
  registry: BoardRegistry,
  event: { repeat?: boolean },
  actions: readonly BoardAction[],
  area: PointerArea | null,
  run: (handler: BoardKeyHandler, action: BoardAction) => boolean | void,
): boolean {
  if (!actions.length) return false;
  const outside = area === "outside";
  const ordered = [
    ...registry.keys.filter((entry) => entry.area !== "board" && entry.area === area).reverse(),
    ...registry.keys.filter((entry) => entry.area === "board").reverse(),
  ];
  for (const entry of ordered) {
    if (!entry.enabled.current) continue;
    for (const action of actions) {
      const handler = entry.handlers.current[action];
      if (!handler || (outside && !BOARD_KEYS[action].anywhere)) continue;
      if (event.repeat && BOARD_KEYS[action].edits) return true;
      if (run(handler, action) !== false) return true;
    }
  }
  return false;
}

/** 依次问 Esc 的各层（后登记的先问），有一层吃掉就返回 true */
export function dispatchEscape(registry: BoardRegistry, event: KeyboardEvent): boolean {
  for (const entry of [...registry.escapes].reverse()) if (entry.handler.current(event) === true) return true;
  return false;
}
