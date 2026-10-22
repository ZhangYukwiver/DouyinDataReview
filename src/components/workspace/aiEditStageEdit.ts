import type { EditCrop, EditTransform } from "../../services/aiEdit";
import { IDENTITY_TRANSFORM, type Size } from "./aiEditModel";
import { fullTransform, SNAP_PX } from "./aiEditBoardEdit";

// 画面上手动改的纯计算（规格 B1–B6、C7、1B）：选中框按「中心 + 宽高 + 角度」算，点在哪段上、叠在一起怎么轮，
// 挪动吸到画布和别的片段上，四角缩放、拖边、旋转换算回 transform，方向键微调先攒着再一次提交。
// 坐标都是舞台像素（左上角为原点、y 向下）；transform 的位置以画布中心为 0、单位是半个画布、y 向上为正。
// insideFrame、pivotCenter、wrapDeg、nearestAnchor、snapMove、resizedSize、光标和双击瞄点的做法搬自 openfilm
// （studio/ui/src/lib/stage-gesture.ts、lib/mg-transform.ts、lib/double-press.ts、components/StageTransformFrame.tsx），
// MIT License，Copyright (c) 2026 OpenFilm contributors。

/** 画面上一段的框：中心、没转之前的宽高、顺时针角度（度） */
export interface StageFrame { cx: number; cy: number; w: number; h: number; r: number }
export interface Point { x: number; y: number }
/** 不转的矩形（左上角 + 宽高），吸附目标用 */
export interface Box { x: number; y: number; w: number; h: number }
/** 舞台此刻在屏幕上的位置（getBoundingClientRect 的那几项） */
export interface ScreenRect { left: number; top: number; width: number; height: number }
/** 吸附参考线：x 是竖线、y 是横线，at 是它在舞台上的位置 */
export interface StageGuide { axis: "x" | "y"; at: number }
/** 手柄在框上的位置：每个轴 -1 / 0 / 1（-1, -1 是左上角，0 表示这个轴不动） */
export interface FramePivot { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }

/** 在框里按下，挪满这么多屏幕像素才算拖，不然是点击 */
export const DRAG_PX = 4;
/** 方向键停手这么久才合成一次提交 */
export const NUDGE_WRITE_MS = 350;
/** 东西太小时手柄放在至少这么大的外圈上，蓝边仍按真实大小画 */
export const HANDLE_BOX_MIN = 28;
/** 画面四周留的边：铺满画面的片段，角外 20×20 的旋转区、伸出框外的缩放角和拉伸条也点得到 */
export const STAGE_PAD = 20;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const radians = (deg: number) => (deg * Math.PI) / 180;
/** 绕原点顺时针转 deg 度（舞台 y 向下，所以正角度在屏幕上是顺时针） */
function turn(x: number, y: number, deg: number): Point {
  const a = radians(deg);
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}

// ---------- 框 ----------

/** 画面按画布比例放进 box，四周各让出 STAGE_PAD；放不下时为 0（先不画）。 */
export function stageScale(box: Size, canvas: Size): number {
  if (!(box.width > 2 * STAGE_PAD && box.height > 2 * STAGE_PAD && canvas.width > 0 && canvas.height > 0)) return 0;
  return Math.min((box.width - 2 * STAGE_PAD) / canvas.width, (box.height - 2 * STAGE_PAD) / canvas.height);
}

/**
 * 一段在舞台上的框：base 是缩放前的大小（视频、图片是按 fit 铺好的框，贴纸是那个方块，文字是排出来的字块），
 * 中心按位移算，宽高乘上缩放；裁剪过的按留下的那部分画。
 */
export function frameOf(stage: Size, base: Size, transform: EditTransform, crop?: EditCrop | null): StageFrame {
  const frame = {
    cx: stage.width / 2 + (transform.transform_x * stage.width) / 2,
    cy: stage.height / 2 - (transform.transform_y * stage.height) / 2,
    w: base.width * Math.abs(transform.scale_x),
    h: base.height * Math.abs(transform.scale_y),
    r: transform.rotation,
  };
  return crop ? visibleFrame(frame, crop, transform.flip_horizontal, transform.flip_vertical) : frame;
}

/** 裁剪后留下的那部分：按四个角的外接框算；裁剪在翻转、旋转之前，所以偏移先翻再转。 */
export function visibleFrame(frame: StageFrame, crop: EditCrop, flipX = false, flipY = false): StageFrame {
  const xs = [crop.upper_left_x, crop.upper_right_x, crop.lower_left_x, crop.lower_right_x].map((value) => clamp(value, 0, 1));
  const ys = [crop.upper_left_y, crop.upper_right_y, crop.lower_left_y, crop.lower_right_y].map((value) => clamp(value, 0, 1));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (!(x1 > x0 && y1 > y0) || (x0 === 0 && x1 === 1 && y0 === 0 && y1 === 1)) return frame;
  const offset = turn(((x0 + x1) / 2 - 0.5) * frame.w * (flipX ? -1 : 1), ((y0 + y1) / 2 - 0.5) * frame.h * (flipY ? -1 : 1), frame.r);
  return { cx: frame.cx + offset.x, cy: frame.cy + offset.y, w: (x1 - x0) * frame.w, h: (y1 - y0) * frame.h, r: frame.r };
}

/**
 * 屏幕上的一点换成舞台像素：rect 是舞台此刻的位置；给了 size（这次拖动开始时的舞台大小）就换算成那时的像素。
 * 刚选中时详情卡出来、画面让出宽度挪了位置，拖动照旧按开始时的像素算，算出的 transform 按比例画到新画面上仍跟着指针。
 */
export function stagePoint(client: { clientX: number; clientY: number }, rect: ScreenRect, size?: Size | null): Point {
  const kx = size && rect.width > 0 ? size.width / rect.width : 1;
  const ky = size && rect.height > 0 ? size.height / rect.height : 1;
  return { x: (client.clientX - rect.left) * kx, y: (client.clientY - rect.top) * ky };
}

/** 点在不在框里（框转了多少，点就反着转回去再比）。 */
export function insideFrame(f: StageFrame, x: number, y: number): boolean {
  const rad = radians(-f.r);
  const dx = x - f.cx;
  const dy = y - f.cy;
  return Math.abs(dx * Math.cos(rad) - dy * Math.sin(rad)) <= f.w / 2 && Math.abs(dx * Math.sin(rad) + dy * Math.cos(rad)) <= f.h / 2;
}

/** 框转过之后的外接矩形。 */
export function frameAabb(f: StageFrame): Box {
  const rad = radians(f.r);
  const w = Math.abs(f.w * Math.cos(rad)) + Math.abs(f.h * Math.sin(rad));
  const h = Math.abs(f.w * Math.sin(rad)) + Math.abs(f.h * Math.cos(rad));
  return { x: f.cx - w / 2, y: f.cy - h / 2, w, h };
}

// ---------- 点选 ----------

export interface StageHitLayer { id: string; trackIndex: number; frame: StageFrame; alpha: number }

/**
 * 点下去落在哪几段上：看得见（不透明度大于 0）、点在它转过的框里；面积小的排前面，
 * 一样大时轨道靠后（叠在上面）的排前面（照 openfilm 的 layersAt）。
 */
export function stageHits(layers: readonly StageHitLayer[], x: number, y: number): string[] {
  return layers
    .filter((layer) => layer.alpha > 0 && layer.frame.w > 0 && layer.frame.h > 0 && insideFrame(layer.frame, x, y))
    .sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h || b.trackIndex - a.trackIndex)
    .map((layer) => layer.id);
}

/** 点中哪一段：平常取排第一的；Alt+点击从现在选中的那段往下轮一个，轮到底回到第一个。 */
export function pickHit(hits: readonly string[], current: string | null, cycle: boolean): string | null {
  if (!hits.length) return null;
  const index = cycle && current ? hits.indexOf(current) : -1;
  return index < 0 ? hits[0]! : hits[(index + 1) % hits.length]!;
}

// ---------- 吸附 ----------

/** 一个轴上值得对齐的三处：两条边和中线。 */
const anchorsOf = (start: number, size: number): [number, number, number] => [start, start + size / 2, start + size];

/** mine（一个轴上的几处）离各目标的边和中线最近的那个，在 tolerance 以内才算；距离一样时列表里靠前的目标胜出。 */
export function nearestAnchor(mine: readonly number[], axis: "x" | "y", targets: readonly Box[], tolerance: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const target of targets) {
    const theirs = axis === "x" ? anchorsOf(target.x, target.w) : anchorsOf(target.y, target.h);
    for (const a of mine) {
      for (const b of theirs) {
        const delta = b - a;
        if (Math.abs(delta) > tolerance) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: b };
      }
    }
  }
  return best;
}

/** 挪到 moved 时该补多少才贴上最近的边或中线，两个轴分开算；返回的是补正量，不是位置。 */
export function snapMove(moved: Box, targets: readonly Box[], tolerance: number): { dx: number; dy: number; guides: StageGuide[] } {
  if (!(tolerance > 0)) return { dx: 0, dy: 0, guides: [] };
  const sx = nearestAnchor(anchorsOf(moved.x, moved.w), "x", targets, tolerance);
  const sy = nearestAnchor(anchorsOf(moved.y, moved.h), "y", targets, tolerance);
  const guides: StageGuide[] = [];
  if (sx) guides.push({ axis: "x", at: sx.at });
  if (sy) guides.push({ axis: "y", at: sy.at });
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides };
}

export const sameGuides = (a: readonly StageGuide[], b: readonly StageGuide[]) => a.length === b.length && a.every((guide, index) => guide.axis === b[index]!.axis && guide.at === b[index]!.at);

/**
 * 挪动的位移：Shift 只沿位移大的那个轴挪；没按 Alt、框也没转过时吸到目标上（targets 里画布排第一，距离一样时画布胜出）。
 * 转过角度的不吸：它的外接框不是它的样子。
 */
export function moveDelta(frame0: StageFrame, delta: Point, mods: { shift: boolean; alt: boolean }, targets: readonly Box[], tolerance = SNAP_PX): { dx: number; dy: number; guides: StageGuide[] } {
  let { x: dx, y: dy } = delta;
  const lockY = mods.shift && Math.abs(dx) >= Math.abs(dy);
  const lockX = mods.shift && !lockY;
  if (lockY) dy = 0;
  if (lockX) dx = 0;
  if (mods.alt || wrapDeg(frame0.r) !== 0) return { dx, dy, guides: [] };
  const box = frameAabb(frame0);
  const hit = snapMove({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, targets, tolerance);
  // Shift 锁住的那个轴不跟着吸，免得被吸离那条直线
  const guides = hit.guides.filter((guide) => (guide.axis === "x" ? !lockX : !lockY));
  return { dx: dx + (lockX ? 0 : hit.dx), dy: dy + (lockY ? 0 : hit.dy), guides };
}

// ---------- 换算回 transform ----------

/** 挪 dx、dy（size 的像素，舞台或画布都行）后的 transform：位置以半个画布为单位、y 向上为正，限在 -1..1。 */
export function movedTransform(base: EditTransform, dx: number, dy: number, size: Size): EditTransform {
  return {
    ...base,
    transform_x: round4(clamp(base.transform_x + dx / (size.width / 2 || 1), -1, 1)),
    transform_y: round4(clamp(base.transform_y - dy / (size.height / 2 || 1), -1, 1)),
  };
}

/**
 * 拖手柄后框的新宽高：指针位移先转进框自己的坐标系，手柄跟着手走；fromCenter 时两边一起动（位移算两倍）。
 * proportional：拖角时按对角线方向的投影定比例 k = (w·w0 + h·h0) / (w0² + h0²)，拖边时另一个轴跟着同比例。至少 2 像素。
 */
export function resizedSize(f: StageFrame, handle: FramePivot, delta: Point, mods: { proportional: boolean; fromCenter: boolean }): { w: number; h: number } {
  if (!(f.w > 0 && f.h > 0)) return { w: f.w, h: f.h };
  const local = turn(delta.x, delta.y, -f.r);
  const span = mods.fromCenter ? 2 : 1;
  let w = handle.hx ? Math.max(2, f.w + local.x * handle.hx * span) : f.w;
  let h = handle.hy ? Math.max(2, f.h + local.y * handle.hy * span) : f.h;
  if (mods.proportional) {
    const k = handle.hx && handle.hy ? Math.max(0.02, (w * f.w + h * f.h) / (f.w * f.w + f.h * f.h)) : handle.hx ? w / f.w : h / f.h;
    w = f.w * k;
    h = f.h * k;
  }
  return { w, h };
}

/** 框换成新的宽高、pivot 那一点不动时，新的中心在哪。 */
export function pivotCenter(frame: StageFrame, next: { w: number; h: number }, pivot: FramePivot): Point {
  const rad = radians(frame.r);
  const ux = { x: Math.cos(rad), y: Math.sin(rad) };
  const uy = { x: -Math.sin(rad), y: Math.cos(rad) };
  const ax = frame.cx + (ux.x * (pivot.hx * frame.w)) / 2 + (uy.x * (pivot.hy * frame.h)) / 2;
  const ay = frame.cy + (ux.y * (pivot.hx * frame.w)) / 2 + (uy.y * (pivot.hy * frame.h)) / 2;
  return {
    x: ax - (ux.x * (pivot.hx * next.w)) / 2 - (uy.x * (pivot.hy * next.h)) / 2,
    y: ay - (ux.y * (pivot.hx * next.w)) / 2 - (uy.y * (pivot.hy * next.h)) / 2,
  };
}

/** 舞台上的中心点换成 transform 的位置（以画布中心为 0、y 向上为正，限在 -1..1）。 */
export function centerToPosition(center: Point, stage: Size): { transform_x: number; transform_y: number } {
  const halfWidth = stage.width / 2 || 1;
  const halfHeight = stage.height / 2 || 1;
  return {
    transform_x: round4(clamp((center.x - stage.width / 2) / halfWidth, -1, 1)),
    transform_y: round4(clamp(-(center.y - stage.height / 2) / halfHeight, -1, 1)),
  };
}

export interface ScaleDrag {
  /** 要改的静态 transform */
  base: EditTransform;
  /** 按下时的框（裁剪过的是留下的那部分） */
  frame0: StageFrame;
  /** 按下时片段自己的中心（transform 的位置），裁剪过时和框的中心不在一处 */
  center0: Point;
  handle: FramePivot;
  stage: Size;
}

/**
 * 拖手柄缩放：默认以中心缩放，只改缩放、不改位置（只有位置关键帧时也能缩）；fromCenter 为 false 时对面那个角（边）不动，
 * 位置跟着挪。缩放每个轴限在 0.05..20，等比时两个轴一起夹。
 */
export function scaledTransform(drag: ScaleDrag, delta: Point, mods: { proportional: boolean; fromCenter: boolean }): { transform: EditTransform; kx: number; ky: number } {
  const { base, frame0, handle } = drag;
  const size = resizedSize(frame0, handle, delta, mods);
  const sx = Math.abs(base.scale_x) || 1;
  const sy = Math.abs(base.scale_y) || 1;
  let kx = frame0.w > 0 ? size.w / frame0.w : 1;
  let ky = frame0.h > 0 ? size.h / frame0.h : 1;
  if (mods.proportional) {
    const k = clamp(handle.hx ? kx : ky, Math.max(MIN_SCALE / sx, MIN_SCALE / sy), Math.min(MAX_SCALE / sx, MAX_SCALE / sy));
    kx = k;
    ky = k;
  } else {
    kx = clamp(sx * kx, MIN_SCALE, MAX_SCALE) / sx;
    ky = clamp(sy * ky, MIN_SCALE, MAX_SCALE) / sy;
  }
  const transform: EditTransform = { ...base, scale_x: round4(base.scale_x * kx), scale_y: round4(base.scale_y * ky) };
  if (mods.fromCenter) return { transform, kx, ky };
  const pivot: FramePivot = { hx: (-handle.hx || 0) as FramePivot["hx"], hy: (-handle.hy || 0) as FramePivot["hy"] };
  const frameCenter = pivotCenter(frame0, { w: frame0.w * kx, h: frame0.h * ky }, pivot);
  // 片段中心相对框中心的偏移在框自己的坐标系里跟着画面一起缩
  const offset = turn(drag.center0.x - frame0.cx, drag.center0.y - frame0.cy, -frame0.r);
  const moved = turn(offset.x * kx, offset.y * ky, frame0.r);
  return { transform: { ...transform, ...centerToPosition({ x: frameCenter.x + moved.x, y: frameCenter.y + moved.y }, drag.stage) }, kx, ky };
}

/** 角度规整到 -180..180、保留 0.1°（输入 400 就是画面上看到的 40）。 */
export function wrapDeg(r: number): number {
  const turned = Math.round((((((r + 180) % 360) + 360) % 360) - 180) * 10) / 10;
  return Object.is(turned, -0) ? 0 : turned;
}

/** 绕中心转：角度跟着指针相对中心转过的角度走；Shift 按 15° 一档。 */
export function turnedRotation(center: Point, from: Point, to: Point, base: number, shift: boolean): number {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  const a1 = Math.atan2(to.y - center.y, to.x - center.x);
  let r = base + ((a1 - a0) * 180) / Math.PI;
  if (shift) r = Math.round(r / 15) * 15;
  return wrapDeg(r);
}

// ---------- 一次拖动 ----------

export type StageGestureKind = "move" | "scale" | "rotate";

export interface StageGesture extends ScaleDrag {
  kind: StageGestureKind;
  id: string;
  /** 按下的位置（舞台像素） */
  start: Point;
  /** 挪动时吸附的目标：画布排第一，后面是别的看得见的片段 */
  targets: readonly Box[];
  canvas: Size;
  /** 能拖成不等比（视频、图片、贴纸）；文字永远等比 */
  stretchable: boolean;
  /** 有位置关键帧：Alt 对角缩放也不行，只能以中心缩放 */
  pivotLocked: boolean;
}

export interface GestureMods { shift: boolean; alt: boolean }

/**
 * 拖到 p 时这一段的 transform、吸上的参考线和指针旁边的数值提示。
 * tolerance 是吸附范围（gesture.stage 的像素）：拖到一半画面变了大小时，调用方按新旧比例换算，屏幕上仍是 SNAP_PX。
 */
export function gestureStep(gesture: StageGesture, p: Point, mods: GestureMods, tolerance = SNAP_PX): { transform: EditTransform; guides: StageGuide[]; text: string } {
  const delta = { x: p.x - gesture.start.x, y: p.y - gesture.start.y };
  if (gesture.kind === "move") {
    const moved = moveDelta(gesture.frame0, delta, mods, gesture.targets, tolerance);
    const transform = movedTransform(gesture.base, moved.dx, moved.dy, gesture.stage);
    return { transform, guides: moved.guides, text: moveHint(transform, gesture.canvas) };
  }
  if (gesture.kind === "rotate") {
    const rotation = turnedRotation(gesture.center0, gesture.start, p, gesture.base.rotation, mods.shift);
    return { transform: { ...gesture.base, rotation }, guides: [], text: turnHint(rotation) };
  }
  // 拖角默认等比（Shift 不等比），拖边默认只拉一个轴（Shift 等比）；Alt 对面不动，默认以中心
  const corner = Boolean(gesture.handle.hx && gesture.handle.hy);
  const proportional = !gesture.stretchable || (corner ? !mods.shift : mods.shift);
  const scaled = scaledTransform(gesture, delta, { proportional, fromCenter: !mods.alt || gesture.pivotLocked });
  return { transform: scaled.transform, guides: [], text: scaleHint(scaled.transform) };
}

// ---------- 提示文字 ----------

const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0");

/** 挪动时的数值：画布像素，以中心为 0、往右往上为正。 */
export const moveHint = (transform: EditTransform, canvas: Size) =>
  `左右 ${signed(Math.round((transform.transform_x * canvas.width) / 2))} · 上下 ${signed(Math.round((transform.transform_y * canvas.height) / 2))}`;

export function scaleHint(transform: EditTransform): string {
  const x = Math.round(Math.abs(transform.scale_x) * 100);
  const y = Math.round(Math.abs(transform.scale_y) * 100);
  return x === y ? `${x}%` : `宽 ${x}% · 高 ${y}%`;
}

export const turnHint = (rotation: number) => `${signed(Math.round(rotation)).replace(/^\+/u, "")}°`;

// ---------- 关键帧挡住哪些手势（B6） ----------

const POSITION_KEYS = new Set(["transform_x", "transform_y", "position_x", "position_y"]);
const SCALE_KEYS = new Set(["uniform_scale", "scale_x", "scale_y"]);

export interface StageLocks { move: boolean; scale: boolean; rotate: boolean }

/** 有位置关键帧不能挪（也不能对角缩放），有缩放关键帧不能缩，有旋转关键帧不能转：静态 transform 会被关键帧盖掉。 */
export function keyframeLocks(segment: { keyframes?: Array<{ property: string }> }): StageLocks {
  const keys = new Set((segment.keyframes ?? []).map((item) => item.property));
  return { move: [...POSITION_KEYS].some((key) => keys.has(key)), scale: [...SCALE_KEYS].some((key) => keys.has(key)), rotate: keys.has("rotation") };
}

/** 框下面那句原因；什么都没挡时为 null。 */
export function lockNote(locks: StageLocks): string | null {
  const parts = [locks.move && "位置", locks.scale && "大小", locks.rotate && "角度"].filter((part): part is string => Boolean(part));
  if (!parts.length) return null;
  const what = parts.length > 1 ? `${parts.slice(0, -1).join("、")}和${parts.at(-1)}` : parts[0];
  const verb = parts.length > 1 ? "改" : locks.move ? "拖" : locks.scale ? "缩放" : "转";
  return `这段的${what}有关键帧动画，画面上不能直接${verb}，导进剪映后再调`;
}

// ---------- 方向键微调（C7） ----------

/** 攒着还没发的方向键微调：在 base 上挪了 dx、dy 画布像素（y 向下） */
export interface HeldNudge { id: string; base: EditTransform; dx: number; dy: number }

/** 再按一下方向键：同一段接着累加，换了一段从头记（调用方先把旧的那段提交掉）。 */
export function addNudge(held: HeldNudge | null, id: string, base: EditTransform, dx: number, dy: number): HeldNudge {
  return held && held.id === id ? { ...held, dx: held.dx + dx, dy: held.dy + dy } : { id, base, dx, dy };
}

export const nudgedTransform = (held: HeldNudge, canvas: Size) => movedTransform(held.base, held.dx, held.dy, canvas);

/** 方向键挪多少画布像素：一下 1 像素，带 ⇧ 是 10。 */
export function arrowDelta(direction: "left" | "right" | "up" | "down", shift: boolean): Point {
  const step = shift ? 10 : 1;
  return { x: direction === "left" ? -step : direction === "right" ? step : 0, y: direction === "up" ? -step : direction === "down" ? step : 0 };
}

// ---------- transform 比较 ----------

const NUMBER_KEYS = ["scale_x", "scale_y", "transform_x", "transform_y", "rotation", "alpha"] as const;

/** 两个 transform 看起来一样（数值差不到万分之一、翻转相同）。 */
export function sameTransform(a: EditTransform, b: EditTransform): boolean {
  return NUMBER_KEYS.every((key) => Math.abs(a[key] - b[key]) < 1e-4) && a.flip_horizontal === b.flip_horizontal && a.flip_vertical === b.flip_vertical;
}

/** 整个 transform 都是默认的（连不透明度、翻转也是）：这时直接清掉 transform，不留一份全是默认值的。 */
export const isIdentityTransform = (transform: EditTransform | null | undefined) => sameTransform(fullTransform(transform), IDENTITY_TRANSFORM);

const PLACEMENT = { scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0 } as const;

/** 「重置位置、大小和角度」：这几项回到默认，不透明度和翻转留着。 */
export const resetPlacement = (transform: EditTransform | null | undefined): EditTransform => ({ ...fullTransform(transform), ...PLACEMENT });

/** 位置、大小、角度都还是默认的（不管不透明度和翻转）：没东西可重置。 */
export const isDefaultPlacement = (transform: EditTransform | null | undefined) => sameTransform(resetPlacement(transform), fullTransform(transform));

// ---------- 光标 ----------

/** 按方向角（手柄方向 + 框的角度）挑缩放光标：每 45° 一档，边界在 22.5° 处；转过 90° 后上边就是左右拖。 */
export function resizeCursor(angle: number): string {
  const a = ((angle % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

export type FrameCorner = "nw" | "ne" | "se" | "sw";
export type FrameEdge = "n" | "e" | "s" | "w";
export const CORNERS: readonly FrameCorner[] = ["nw", "ne", "se", "sw"];
export const EDGES: readonly FrameEdge[] = ["n", "e", "s", "w"];
export const HANDLE_AT: Record<FrameCorner | FrameEdge, FramePivot> = {
  nw: { hx: -1, hy: -1 }, ne: { hx: 1, hy: -1 }, se: { hx: 1, hy: 1 }, sw: { hx: -1, hy: 1 },
  n: { hx: 0, hy: -1 }, s: { hx: 0, hy: 1 }, e: { hx: 1, hy: 0 }, w: { hx: -1, hy: 0 },
};
/** 各手柄缩放方向的角度（加上框的角度再挑光标） */
export const HANDLE_ANGLE: Record<FrameCorner | FrameEdge, number> = { nw: 45, ne: 135, se: 45, sw: 135, n: 90, s: 90, e: 0, w: 0 };
/** 旋转光标是给右上角画的，别的角在这上面再转 */
export const ROTATE_AT: Record<FrameCorner, number> = { ne: 0, se: 90, sw: 180, nw: 270 };

const rotateCursors = new Map<string, string>();

/** 旋转光标：一段两头带箭头的四分之一圆弧（浏览器没有这种光标），light 描底、dark 画线；每 15° 缓存一份，不支持时回退到十字。 */
export function rotateCursor(angle: number, light: string, dark: string): string {
  const a = (((Math.round(angle / 15) * 15) % 360) + 360) % 360;
  const key = `${a}|${light}|${dark}`;
  const hit = rotateCursors.get(key);
  if (hit) return hit;
  const arc = "M5 8A11 11 0 0 1 16 19M8.2 4.8L5 8l3.2 3.2M12.8 15.8L16 19l3.2-3.2";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
    + `<g transform="rotate(${a} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${arc}" stroke="${light}" stroke-width="3.6"/><path d="${arc}" stroke="${dark}" stroke-width="1.5"/></g></svg>`;
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
  rotateCursors.set(key, css);
  return css;
}

// ---------- 双击 ----------

/** 画面上按下一次：位置（画布像素）、屏幕上的位置（clientX / clientY）和时间（事件的 timeStamp，毫秒） */
export interface Press { x: number; y: number; clientX: number; clientY: number; at: number }
export const DOUBLE_PRESS_MS = 500;
/** 两下在屏幕上离得比这远，就是先后点了两处，不算双击 */
export const DOUBLE_PRESS_SLOP = 6;

/** 只留最近两次按下：双击瞄的是它的第一下。 */
export const keepPress = (presses: readonly Press[], press: Press): Press[] => [...presses.slice(-1), press];

/**
 * 双击瞄的是哪一点：它的第一下。第一下会打开详情卡、画面跟着缩小，第二下就不在原来想点的地方了。
 * 是不是同一处按屏幕位置比（画面挪了，手没动）。最近两下不是这次双击的（隔太久、离太远）时为 null，那就只能用双击自己的位置。
 * 第二下按下时（now 就是它的时间）也用它：点选照第一下的位置算，选中不会先跳到别处再跳回来。
 */
export function doubleClickAim(presses: readonly Press[], now: number): Press | null {
  const [first, second] = presses.length >= 2 ? presses.slice(-2) : [];
  if (!first || !second) return null;
  const near = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) <= DOUBLE_PRESS_SLOP;
  return near && second.at - first.at < DOUBLE_PRESS_MS && now - second.at < DOUBLE_PRESS_MS ? first : null;
}
