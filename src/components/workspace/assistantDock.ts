// 右下角 AI 圆钮拖到哪儿：存离窗口右边、下边的距离，窗口变了也贴着原来那个角。
// 面板朝哪边展开：上次在哪边就还在哪边，那边放不下了才换到空地多的一边（第一次就按空地多的一边）；
// 拖动途中（hold）一律不换，不然面板会翻到另一边、从手底下跳走。
// 面板大小用户可以拉（离圆钮最远的那个角），超出那一侧的空地就按空地缩。

export type DockSide = { onLeft: boolean; onTop: boolean };
export type DockSpot = { right: number; bottom: number } & Partial<DockSide>;
export type DockSize = { width: number; height: number };

export const FAB = 48;
const EDGE = 12;
const GAP = 12;
export const MIN_SIZE: DockSize = { width: 300, height: 280 };
export const DEFAULT_SPOT: DockSpot = { right: 20, bottom: 20 };
export const DEFAULT_SIZE: DockSize = { width: 400, height: 640 };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function clampSpot(spot: DockSpot, width: number, height: number): DockSpot {
  return { ...spot, right: clamp(spot.right, EDGE, width - FAB - EDGE), bottom: clamp(spot.bottom, EDGE, height - FAB - EDGE) };
}

export function dockPlacement(spot: DockSpot, width: number, height: number, size: DockSize = DEFAULT_SIZE, hold?: DockSide | null) {
  const { right, bottom } = clampSpot(spot, width, height);
  const left = width - right - FAB;
  const top = height - bottom - FAB;
  // 往右/往下展开时（true）和往左/往上展开时各有多少地方
  const roomX = (onLeft: boolean) => (onLeft ? width - left : width - right) - EDGE;
  const roomY = (onTop: boolean) => (onTop ? height - top - FAB : top) - GAP - EDGE;
  const pick = (last: boolean | undefined, room: (side: boolean) => number, want: number) =>
    typeof last === "boolean" && room(last) >= want ? last : room(true) > room(false);
  const onLeft = hold ? hold.onLeft : pick(spot.onLeft, roomX, size.width);
  const onTop = hold ? hold.onTop : pick(spot.onTop, roomY, size.height);
  return {
    side: { onLeft, onTop },
    style: {
      ...(onLeft ? { left } : { right }),
      ...(onTop ? { top, flexDirection: "column-reverse" as const } : { bottom, flexDirection: "column" as const }),
      alignItems: onLeft ? ("flex-start" as const) : ("flex-end" as const),
    },
    // ponytail: 拖动中贴边时面板只缩不躲，最小 240×160，松手后放不下才换边
    panelWidth: Math.max(240, Math.min(size.width, roomX(onLeft))),
    panelHeight: Math.max(160, Math.min(size.height, roomY(onTop))),
  };
}

/** 读存下来的位置或大小：fallback 里的每个数字项都得是数字，不然整个用 fallback。 */
function load<T extends object>(key: string, fallback: T, storage: Pick<Storage, "getItem"> | undefined): T {
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? "null") as Record<string, unknown> | null;
    const ok = saved && Object.entries(fallback).every(([name, value]) => typeof value !== "number" || Number.isFinite(saved[name]));
    return ok ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: object, storage: Pick<Storage, "setItem"> | undefined): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* 存不了就只在这次有效 */ }
}

const SPOT_KEY = "dy2.assistantDock";
const SIZE_KEY = "dy2.assistantPanelSize";
export const loadDockSpot = (storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage) => load(SPOT_KEY, DEFAULT_SPOT, storage);
export const saveDockSpot = (spot: DockSpot, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) => save(SPOT_KEY, spot, storage);
export const loadDockSize = (storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage) => load(SIZE_KEY, DEFAULT_SIZE, storage);
export const saveDockSize = (size: DockSize, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) => save(SIZE_KEY, size, storage);
