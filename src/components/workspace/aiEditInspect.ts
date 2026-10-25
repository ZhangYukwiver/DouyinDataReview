import type {
  AiEditCatalogKind, AiEditEditCall, AiEditHistoryStep, EditCanvas, EditMediaSegment, EditProject, EditSegment, EditStickerSegment, EditTextSegment, EditTransform,
} from "../../services/aiEdit";
import { animationEdits, fullTransform, MIN_CLIP_US, phaseOf, pyRound, undoKind, type AnimationPhase } from "./aiEditBoardEdit";
import { DEFAULT_FEATURE_US, findSegment, US_PER_SECOND } from "./aiEditModel";

// 详情卡里能拖、能输的数值框（规格 1B）：列哪些字段、能改到多少、打进去的字怎么读、拖一下走几步、改完换成哪个看板改动；
// 还有多选卡片的一句话说明和操作历史面板的纯计算（D4、D10）。
// parseFieldInput / applyFieldInput / snapToStep / scrubValue 搬自 openfilm（studio/ui/src/lib/field-input.ts、lib/inspect-scrub.ts，
// 时间码换算来自 lib/timecode.ts），MIT License，Copyright (c) 2026 OpenFilm contributors。
// 和 openfilm 不同：开头的 − 号不表示「减多少」，写 −200 就是 −200（位置以画面中心为 0）；另外认中文的秒、毫秒、帧、倍、度。

// ---------- 打进去的字怎么读 ----------

/** 打进去的是一个值，或者在现在的值上加、乘、除多少（开头写 +、*、/） */
export type FieldInput = { set: number } | { rel: "+" | "*" | "/"; by: number };

export interface FieldContext {
  /** 100% 是多少：一个数（左右位置是画面宽），或 self（字段本身就是百分比：缩放、不透明度）；不给就不认 % */
  percent?: number | "self";
  /** 时间（秒）：认 s、ms、f 和 分:秒:帧 这类时间码，光写数字是秒 */
  time?: boolean;
  /** f 和时间码按每秒几帧算 */
  fps?: number;
  /** 字段自己的单位，打进去时丢掉（°、倍） */
  units?: readonly string[];
}

type Token = { kind: "num"; value: number } | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

const DEFAULT_FPS = 30;
// 中文写法换成下面认得的；毫秒要在秒前面换
const SPOKEN: Array<[RegExp, string]> = [[/毫秒/gu, "ms"], [/秒/gu, "s"], [/帧/gu, "f"], [/％/gu, "%"], [/＋/gu, "+"], [/＊/gu, "*"], [/／/gu, "/"]];

/** 23.976、29.97 这类是整数帧率乘 1000/1001 */
function exactRate(fps: number): number {
  if (!(fps > 0) || !Number.isFinite(fps)) return DEFAULT_FPS;
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) > 0.001 && Math.abs(fps - (whole * 1000) / 1001) < 0.01) return (whole * 1000) / 1001;
  return fps;
}

const timecodeSeconds = (secs: number, frames: number, fps: number) => {
  const rate = exactRate(fps);
  return (Math.ceil(secs * rate - 1e-9) + frames) / rate;
};

/** 拆成数字和运算符，单位已经换算进数字里；有读不懂的地方返回 null */
function tokenize(raw: string, ctx: FieldContext, inScale: boolean): Token[] | null {
  const fps = ctx.fps ?? DEFAULT_FPS;
  const units = [...(ctx.units ?? [])].sort((a, b) => b.length - a.length);
  const out: Token[] = [];
  const text = raw.replace(/[−–]/gu, "-").replace(/,/gu, ".");
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (/\s/u.test(char)) { at += 1; continue; }
    if ("+-*/()".includes(char)) { out.push({ kind: "op", value: char as "+" }); at += 1; continue; }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?::\d+(?:\.\d*)?)*/u.exec(text.slice(at));
    if (!match) return null;
    at += match[0].length;
    // 数字和单位之间可以空一格（1.5 秒、45 °）
    const gap = /^\s*/u.exec(text.slice(at))![0].length;
    const rest = text.slice(at + gap);
    const unit = /^(px|ms|s|f|%)/iu.exec(rest)?.[1]?.toLowerCase() ?? units.find((item) => rest.toLowerCase().startsWith(item.toLowerCase()));
    if (unit) at += gap + unit.length;
    let value: number;
    if (match[0].includes(":")) {
      // 时间码：秒:帧、分:秒:帧、时:分:秒:帧
      if (!ctx.time || unit) return null;
      const parts = match[0].split(":").map(Number);
      if (parts.length > 4) return null;
      const frames = parts.pop()!;
      const [sec = 0, min = 0, hour = 0] = parts.reverse();
      value = timecodeSeconds(hour * 3600 + min * 60 + sec, frames, fps);
    } else {
      const number = Number(match[0]);
      if (unit === "px" || (unit && units.includes(unit))) value = number;
      else if (unit === "%") {
        // 乘除后面的 % 是比例（*50% 是一半）；其他时候是「100% 是多少」的几成
        if (inScale) value = number / 100;
        else if (ctx.percent === "self") value = number;
        else if (typeof ctx.percent === "number") value = (number / 100) * ctx.percent;
        else return null;
      } else if (unit === "s" || unit === "ms" || unit === "f") {
        if (!ctx.time) return null;
        value = unit === "s" ? number : unit === "ms" ? number / 1000 : number / exactRate(fps);
      } else value = number;
    }
    out.push({ kind: "num", value });
  }
  return out;
}

/** 加减乘除、括号、数字前面的正负号 */
function evaluate(tokens: Token[]): number | null {
  let at = 0;
  const isOp = (value: string) => { const token = tokens[at]; return token?.kind === "op" && token.value === value; };
  const factor = (): number | null => {
    const token = tokens[at];
    if (!token) return null;
    if (token.kind === "num") { at += 1; return token.value; }
    if (token.value === "-" || token.value === "+") {
      at += 1;
      const value = factor();
      return value === null ? null : token.value === "-" ? -value : value;
    }
    if (token.value === "(") {
      at += 1;
      const value = expr();
      if (value === null || !isOp(")")) return null;
      at += 1;
      return value;
    }
    return null;
  };
  const term = (): number | null => {
    let value = factor();
    while (value !== null && (isOp("*") || isOp("/"))) {
      const op = (tokens[at] as { value: string }).value;
      at += 1;
      const right = factor();
      if (right === null) return null;
      value = op === "*" ? value * right : right === 0 ? null : value / right;
    }
    return value;
  };
  const expr = (): number | null => {
    let value = term();
    while (value !== null && (isOp("+") || isOp("-"))) {
      const op = (tokens[at] as { value: string }).value;
      at += 1;
      const right = term();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const value = expr();
  return value !== null && at === tokens.length && Number.isFinite(value) ? value : null;
}

/** 读打进去的字；读不懂为 null。开头的 + * / 是在现在的值上改，开头的 − 是负数。 */
export function parseFieldInput(raw: string, ctx: FieldContext = {}): FieldInput | null {
  let text = raw.trim();
  for (const [from, to] of SPOKEN) text = text.replace(from, to);
  // 开头的 × 当乘号（×2），后面的 × 是倍速的单位（2×）
  text = text.replace(/^[×✕]/u, "*");
  if (!text) return null;
  const lead = /^[+*/]/u.exec(text)?.[0] as "+" | "*" | "/" | undefined;
  if (lead) {
    const tokens = tokenize(text.slice(1), ctx, lead !== "+");
    const by = tokens?.length ? evaluate(tokens) : null;
    if (by === null || (lead === "/" && by === 0)) return null;
    return { rel: lead, by };
  }
  const tokens = tokenize(text, ctx, false);
  const value = tokens?.length ? evaluate(tokens) : null;
  return value === null ? null : { set: value };
}

/** 打进去的字作用在 base 上得到的值 */
export function applyFieldInput(input: FieldInput, base: number): number {
  if ("set" in input) return input.set;
  return input.rel === "+" ? base + input.by : input.rel === "*" ? base * input.by : base / input.by;
}

// ---------- 什么时候算改不了 ----------

/** 页面上「上一个改动还没回来」的说法：AiEditWorkspace 的 notEditableReason，锁被占时 perform 也回这句 */
export const IN_FLIGHT_REASON = "上一个改动还没回来，稍等";

/**
 * 看板命令拦不拦、数值框和按钮置不置灰都按这个：上一个改动还在路上只是一眨眼的事，不算改不了，
 * 不然每提交一下整张卡片和按钮都要暗一下，刚 Tab 进下一个框打的字也会被吞掉；真在这时提交，perform 的锁会拦、看板提示稍等。
 * 先 flush 再发的命令也靠这个：请求刚回来、页面还没重渲染时，读到的原因还停在这一句上。
 */
export const lastingReason = (reason: string | null | undefined): string | null => (reason && reason !== IN_FLIGHT_REASON ? reason : null);

// ---------- 拖一下走几步 ----------

/** 横着拖这么多像素走一步 */
export const SCRUB_PX = 6;
/** 按下后挪不到这么多像素不算拖（松手就是点进去打字） */
export const SCRUB_SLOP_PX = 2;

export interface StepMods { shift?: boolean; alt?: boolean }

/** 一步多大：⇧ 大十倍、⌥ 细十倍，拖动和方向键一样 */
export const strideOf = (step: number, mods?: StepMods) => (mods?.shift ? step * 10 : mods?.alt ? step / 10 : step);

export function snapToStep(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const ticks = Math.round(value / step);
  const decimals = step >= 1 ? 2 : Math.min(4, (String(step).split(".")[1] ?? "00").length);
  return Number((ticks * step).toFixed(decimals));
}

/** 从 start 开始横着拖了 dx 像素以后的值（每 6 像素一步，落在步长上） */
export function scrubValue(start: number, dx: number, step: number, mods?: StepMods): number {
  const stride = strideOf(step, mods);
  return snapToStep(start + (dx / SCRUB_PX) * stride, stride);
}

// ---------- 详情卡列哪些字段 ----------

export type FieldKey = "start" | "duration" | "source_start" | "speed" | "x" | "y" | "scale" | "rotation" | "alpha" | "transition" | "filter" | `anim_${AnimationPhase}`;

export interface InspectField {
  key: FieldKey;
  /** 行首的字，也是拖动把手（位置那一行写「位置」，把手是框里的 X、Y） */
  label: string;
  /** 框里左边的小字，有它时拖动把手是它 */
  mark?: string;
  /** 读屏和悬停提示用的全称 */
  name: string;
  /** 数字后面的灰字 */
  unit: string;
  /** 现在的值，按显示的单位：秒、倍、画布像素、%、° */
  value: number;
  /** 拖一下、按一下 ↑↓ 走多少；时间是一帧 */
  step: number;
  /** 拖动、方向键、打字都夹在这中间（打字只有开始时间能跳出去，见 elsewhere） */
  min: number;
  max: number;
  /** 时间：落到帧上 */
  time: boolean;
  /** 最多显示几位小数 */
  digits: number;
  ctx: FieldContext;
  /** 改不了的原因（有关键帧动画、整段素材都用上了）；能改为 null */
  disabled: string | null;
  /** 这一项有关键帧动画：框里不写数（静态值会被动画盖掉，写出来会误导） */
  animated?: boolean;
  /** 框上的悬停提示：能怎么写 */
  hint: string;
  /** 只有开始时间有：打的值跳出了现在这个空当，看挪到别处放不放得下；放得下为 null，放不下是原因 */
  elsewhere?: (value: number) => string | null;
  /** 调的是套着的剪映效果（转场、动画多长，滤镜多强）：改完把这个效果试播一遍 */
  preview?: AiEditCatalogKind;
}

export interface InspectContext {
  canvas: Pick<EditCanvas, "width" | "height" | "fps">;
  /** 同一轨道上的其他片段 */
  siblings: readonly EditSegment[];
  /** 素材全长；拿不到时不限 */
  mediaDurationUs?: number | null;
}

const KEYED: Partial<Record<FieldKey, { properties: readonly string[]; name: string }>> = {
  x: { properties: ["transform_x", "position_x"], name: "左右位置" },
  y: { properties: ["transform_y", "position_y"], name: "上下位置" },
  scale: { properties: ["uniform_scale", "scale_x", "scale_y"], name: "缩放" },
  rotation: { properties: ["rotation"], name: "旋转" },
  alpha: { properties: ["alpha"], name: "不透明度" },
};

/** 这个字段有关键帧动画时改不了的原因：静态值会被动画盖掉；没有关键帧为 null */
export function keyedReason(segment: Pick<EditSegment, "keyframes">, key: FieldKey): string | null {
  const keyed = KEYED[key];
  if (!keyed || !segment.keyframes?.some((item) => keyed.properties.includes(item.property))) return null;
  return `这段的${keyed.name}有关键帧动画，在这里改会被动画盖掉，导进剪映后再调`;
}

const timeEnd = (segment: EditSegment) => segment.timeline.start_us + segment.timeline.duration_us;
const round = (value: number, digits: number) => { const scale = 10 ** digits; return Math.round(value * scale) / scale; };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const seconds = (us: number) => us / US_PER_SECOND;
const hasSource = (segment: EditSegment): segment is EditMediaSegment => segment.kind === "video" || segment.kind === "audio";
const hasTransform = (segment: EditSegment): segment is EditMediaSegment | EditTextSegment | EditStickerSegment =>
  segment.kind === "video" || segment.kind === "image" || segment.kind === "text" || segment.kind === "sticker";
const animationsOf = (segment: EditSegment) => ("animations" in segment ? segment.animations : null) ?? [];
const filtersOf = (segment: EditSegment) => ("filters" in segment ? segment.filters : null) ?? [];
/** 转场、动画实际多长：没写时长的按剪映目录里的默认 */
const spanUs = (item: { duration_us?: number | null; default_us?: number | null }) => item.duration_us || item.default_us || DEFAULT_FEATURE_US;
const PHASE_NAMES: Record<AnimationPhase, string> = { in: "入场", out: "出场", group: "组合", loop: "循环" };
const PHASE_PREVIEW: Record<AnimationPhase, AiEditCatalogKind> = { in: "video_intro", out: "video_outro", group: "video_group", loop: "text_loop" };

/** 片段最短能缩到多短：0.1 秒，也不能短过最后一个关键帧和淡入淡出加起来的长度（采集器会拒）。 */
export function shortestUs(segment: EditSegment): number {
  let floor = MIN_CLIP_US;
  for (const keyframe of segment.keyframes ?? []) floor = Math.max(floor, keyframe.offset_us);
  const fade = "fade" in segment ? segment.fade : null;
  if (fade) floor = Math.max(floor, fade.in_duration_us + fade.out_duration_us);
  return floor;
}

/** 放在 startUs、长 durationUs 时和同轨的片段有没有重叠（首尾正好相接不算），也不能早于 0 */
export function fitsTrack(siblings: readonly EditSegment[], startUs: number, durationUs: number): boolean {
  if (startUs < 0) return false;
  const stop = startUs + durationUs;
  return !siblings.some((other) => startUs < timeEnd(other) && other.timeline.start_us < stop);
}

/**
 * 详情卡上列的数值框：所有片段有开始、时长；视频、音频多素材起点和倍速；能摆在画面上的多位置、缩放、旋转、不透明度。
 * 开始时间拖动时只在现在这个空当里走，时长不压到下一段、不超出素材，倍速换算出的时长也一样；有关键帧的那项改不了。
 */
export function inspectFields(segment: EditSegment, ctx: InspectContext): InspectField[] {
  const fps = ctx.canvas.fps > 0 ? ctx.canvas.fps : DEFAULT_FPS;
  const time = {
    unit: "秒", step: 1 / fps, time: true, digits: 3, ctx: { time: true, fps } satisfies FieldContext, disabled: null,
    hint: "可以写 1.5、1.5s、500ms、12f；写 +0.5 是在现在的基础上加",
  };
  const { start_us: start, duration_us: duration } = segment.timeline;
  const stop = start + duration;
  const prevEnd = ctx.siblings.reduce((latest, other) => (timeEnd(other) <= start ? Math.max(latest, timeEnd(other)) : latest), 0);
  const nextStart = ctx.siblings.reduce((earliest, other) => (other.timeline.start_us >= stop ? Math.min(earliest, other.timeline.start_us) : earliest), Number.POSITIVE_INFINITY);
  const shortest = shortestUs(segment);
  const total = ctx.mediaDurationUs && ctx.mediaDurationUs > 0 ? ctx.mediaDurationUs : Number.POSITIVE_INFINITY;
  const media = hasSource(segment) ? segment : null;
  const speed = media && media.speed > 0 ? media.speed : 1;
  const longest = Math.min(nextStart - start, media && Number.isFinite(total) ? pyRound((total - media.source.start_us) / speed) : Number.POSITIVE_INFINITY);

  const fields: InspectField[] = [
    {
      key: "start", label: "开始", name: "开始时间", value: seconds(start), min: seconds(prevEnd), max: seconds(Math.max(start, nextStart - duration)), ...time,
      elsewhere: (value) => (fitsTrack(ctx.siblings, Math.round(value * US_PER_SECOND), duration) ? null : "这里放不下，会和这条轨道上别的片段叠在一起"),
    },
    { key: "duration", label: "时长", name: "时长", value: seconds(duration), min: seconds(Math.min(shortest, duration)), max: seconds(Math.max(longest, duration)), ...time },
  ];
  if (media) {
    const room = total - media.source.duration_us;
    fields.push({
      key: "source_start", label: "素材起点", name: "从素材的第几秒开始用", value: seconds(media.source.start_us), min: 0, max: seconds(Math.max(room, media.source.start_us)), ...time,
      disabled: room <= 0 && media.source.start_us <= 0 ? "整段素材都用上了，没有能挪的余地" : null,
    });
    // 倍速改的是时间线上的长度（截取不变）：不能长到压住下一段，也不能短过最短长度
    const sourceUs = media.source.duration_us;
    fields.push({
      key: "speed", label: "倍速", name: "倍速", unit: "倍", value: round(speed, 3), step: 0.1, time: false, digits: 3, ctx: { units: ["倍", "×", "x"] }, disabled: null,
      hint: "1 是原速，2 是快一倍；截取的素材不变，时间线上的长度跟着变",
      min: Math.min(speed, Math.max(0.1, sourceUs / (nextStart - start))), max: Math.max(speed, Math.min(100, sourceUs / shortest)),
    });
  }
  if (hasTransform(segment)) {
    const transform = fullTransform(segment.transform);
    const halfWidth = ctx.canvas.width / 2;
    const halfHeight = ctx.canvas.height / 2;
    const plain = (key: FieldKey) => {
      const reason = keyedReason(segment, key);
      return { key, time: false, step: 1, unit: "", disabled: reason, ...(reason ? { animated: true } : {}) };
    };
    fields.push(
      {
        ...plain("x"), label: "位置", mark: "X", name: "左右位置", value: round(transform.transform_x * halfWidth, 1), min: -halfWidth, max: halfWidth, digits: 1,
        ctx: { percent: ctx.canvas.width }, hint: "按画布像素算，画面中心是 0，往右为正；写 50% 是挪半个画面宽",
      },
      {
        ...plain("y"), label: "位置", mark: "Y", name: "上下位置", value: round(transform.transform_y * halfHeight, 1), min: -halfHeight, max: halfHeight, digits: 1,
        ctx: { percent: ctx.canvas.height }, hint: "按画布像素算，画面中心是 0，往上为正；写 50% 是挪半个画面高",
      },
      { ...plain("scale"), label: "缩放", name: "缩放", value: round(transform.scale_x * 100, 1), min: 5, max: 2000, digits: 1, unit: "%", ctx: { percent: "self" }, hint: "写 150 就是 150%，写 *2 是放大一倍" },
      { ...plain("rotation"), label: "旋转", name: "旋转角度", value: round(transform.rotation, 1), min: -360, max: 360, digits: 1, unit: "°", ctx: { units: ["°", "度"] }, hint: "顺时针为正，−360 到 360" },
      { ...plain("alpha"), label: "不透明度", name: "不透明度", value: Math.round(transform.alpha * 100), min: 0, max: 100, digits: 0, unit: "%", ctx: { percent: "self" }, hint: "0 是完全透明，100 是不透明" },
    );
  }
  // 套着的剪映效果：转场、各个动画多长（不能长过这段），第一个滤镜多强
  const span = (us: number) => ({ ...time, value: seconds(us), min: seconds(Math.min(MIN_CLIP_US, us)), max: seconds(Math.max(duration, us)) });
  if ("transition" in segment && segment.transition) {
    fields.push({ key: "transition", label: "转场时长", name: "转场时长", ...span(spanUs(segment.transition)), preview: "transition" });
  }
  for (const item of animationsOf(segment)) {
    const phase = phaseOf(item);
    if (fields.some((field) => field.key === `anim_${phase}`)) continue;
    fields.push({ key: `anim_${phase}`, label: `${PHASE_NAMES[phase]}时长`, name: `${PHASE_NAMES[phase]}动画时长`, ...span(spanUs(item)), preview: PHASE_PREVIEW[phase] });
  }
  const filter = filtersOf(segment)[0];
  if (filter) {
    fields.push({
      key: "filter", label: "滤镜强度", name: "滤镜强度", value: Math.round(filter.intensity ?? 100), min: 0, max: 100, step: 1, time: false, digits: 0, unit: "%",
      ctx: { percent: "self" }, disabled: null, hint: "0 到 100，100 是滤镜本来的样子", preview: "filter",
    });
  }
  return fields;
}

/** 数值框里显示的字：最多 digits 位小数，去掉末尾的 0 */
export function formatField(field: Pick<InspectField, "digits">, value: number): string {
  const shown = Number(value.toFixed(field.digits));
  return String(Object.is(shown, -0) ? 0 : shown);
}

/**
 * 拖完、打完以后真正要写的值：时间落到帧上，其他按显示的位数取整；再夹进 min..max。
 * typed：打字进来的开始时间可以跳出现在的空当，放得下就照写，放不下给原因（不替人另找位置）。
 */
export function settleField(field: InspectField, raw: number, typed = false): { value: number } | { refused: string } {
  if (!Number.isFinite(raw)) return { value: field.value };
  const value = field.time ? Math.round(Math.round(raw / field.step) * field.step * US_PER_SECOND) / US_PER_SECOND : round(raw, field.digits);
  if (value >= field.min - 1e-9 && value <= field.max + 1e-9) return { value: clamp(value, field.min, field.max) };
  if (typed && field.elsewhere && value >= 0) {
    const reason = field.elsewhere(value);
    return reason ? { refused: reason } : { value };
  }
  return { value: clamp(value, field.min, field.max) };
}

const sameTransform = (a: EditTransform, b: EditTransform) => (Object.keys(a) as Array<keyof EditTransform>).every((key) =>
  typeof a[key] === "number" ? Math.abs((a[key] as number) - (b[key] as number)) < 1e-6 : a[key] === b[key]);

/** 改了一个位置、缩放、旋转、不透明度以后的完整 transform（update_clip 的 transform 是整体替换） */
export function transformWith(base: EditTransform, key: FieldKey, value: number, canvas: Pick<EditCanvas, "width" | "height">): EditTransform {
  const next = { ...base };
  const r4 = (number: number) => round(number, 4);
  if (key === "x") next.transform_x = r4(clamp(value / (canvas.width / 2 || 1), -1, 1));
  else if (key === "y") next.transform_y = r4(clamp(value / (canvas.height / 2 || 1), -1, 1));
  else if (key === "rotation") next.rotation = round(clamp(value, -360, 360), 1);
  else if (key === "alpha") next.alpha = r4(clamp(value / 100, 0, 1));
  else if (key === "scale") {
    // 本来就是等比的两边一起改；横竖不一样时按同样的比例一起放大缩小，保持原来的长宽比
    const ratio = clamp(value / 100, 0.05, 20);
    next.scale_y = r4(Math.abs(base.scale_x - base.scale_y) < 1e-4 ? ratio : clamp(base.scale_y * (ratio / (base.scale_x || 1)), 0.05, 20));
    next.scale_x = r4(ratio);
  }
  return next;
}

/**
 * 数值框改完换成的看板改动；值没变、或者这类片段没有这一项为 null。开始时间走 move_clip，其余走 update_clip；
 * 剪映效果的时长、强度是一批：转场照原样再加一次，滤镜、动画全去掉再按原来的顺序加回来（剪映要求文字的循环动画最后加）。
 */
export function fieldEdit(segment: EditSegment, key: FieldKey, value: number, canvas: Pick<EditCanvas, "width" | "height">): AiEditEditCall | AiEditEditCall[] | null {
  const us = Math.round(value * US_PER_SECOND);
  const clip_id = segment.id;
  switch (key) {
    case "start":
      return us === segment.timeline.start_us ? null : { name: "move_clip", arguments: { clip_id, start: seconds(us) } };
    case "duration":
      return us === segment.timeline.duration_us ? null : { name: "update_clip", arguments: { clip_id, duration: seconds(us) } };
    case "source_start":
      return !hasSource(segment) || us === segment.source.start_us ? null : { name: "update_clip", arguments: { clip_id, source_start: seconds(us) } };
    case "speed":
      return !hasSource(segment) || Math.abs(value - (segment.speed > 0 ? segment.speed : 1)) < 1e-6 ? null : { name: "update_clip", arguments: { clip_id, speed: value } };
    case "transition": {
      const transition = "transition" in segment ? segment.transition : null;
      return !transition || us === spanUs(transition) ? null
        : [{ name: "add_transition", arguments: { clip_id, transition_type: transition.transition_type, duration: seconds(us) } }];
    }
    case "filter": {
      const filters = filtersOf(segment);
      const strength = Math.round(clamp(value, 0, 100));
      if (!filters.length || strength === Math.round(filters[0]!.intensity ?? 100)) return null;
      return [{ name: "clear_clip_feature", arguments: { clip_id, feature: "filters" } }, ...filters.map((item, index): AiEditEditCall => ({
        name: "add_filter", arguments: { clip_id, filter_type: item.filter_type, intensity: index ? item.intensity ?? 100 : strength },
      }))];
    }
    case "anim_in": case "anim_out": case "anim_group": case "anim_loop": {
      const animations = animationsOf(segment);
      const target = animations.find((item) => `anim_${phaseOf(item)}` === key);
      if (!target || us === spanUs(target)) return null;
      return animationEdits(segment, animations.map((item) => (item === target ? { ...item, duration_us: us } : item)));
    }
    default: {
      if (!hasTransform(segment)) return null;
      const base = fullTransform(segment.transform);
      const next = transformWith(base, key, value, canvas);
      return sameTransform(base, next) ? null : { name: "update_clip", arguments: { clip_id, transform: next } };
    }
  }
}

/**
 * 按工程里这段现在的样子换成看板改动：数值框提交前先 flush 了别处攒着的微调，位置、缩放这几项发的是整个 transform，
 * 按 flush 之前的样子算会把刚挪的位置写回去。这段不见了、值没变为 null。
 */
export function fieldEditNow(project: Pick<EditProject, "tracks" | "canvas"> | null | undefined, clipId: string, key: FieldKey, value: number, canvas: Pick<EditCanvas, "width" | "height">): AiEditEditCall | AiEditEditCall[] | null {
  const found = findSegment(project, clipId);
  return found ? fieldEdit(found.segment, key, value, project?.canvas ?? canvas) : null;
}

// 详情里和数值框重复的说明行：有了框就不再写一遍（音量、裁剪、效果、关键帧这些照旧留着）
// 剪映效果那几行（转场、动画、滤镜）留着：名字和去掉的 × 在那
const COVERED_ROWS: Partial<Record<FieldKey, readonly string[]>> = {
  start: ["时间线上"], duration: ["时长"], source_start: ["截取"], speed: ["速度"], x: ["位置"], y: ["位置"], scale: ["缩放"], rotation: ["旋转"], alpha: ["不透明度"],
};
export const coveredRows = (fields: readonly Pick<InspectField, "key">[]): Set<string> => new Set(fields.flatMap((field) => COVERED_ROWS[field.key] ?? []));

// ---------- 多选卡片 ----------

const KIND_NAMES: Record<EditSegment["kind"], string> = { video: "视频", image: "图片", audio: "音频", text: "文字", sticker: "贴纸", track_effect: "特效", track_filter: "滤镜" };

/** 多选时卡片上那句：「选中的是 2 段视频和 1 段文字」，按第一次出现的先后说。 */
export function selectionSummary(segments: readonly Pick<EditSegment, "kind">[]): string {
  const counts = new Map<string, number>();
  for (const segment of segments) counts.set(KIND_NAMES[segment.kind] ?? "片段", (counts.get(KIND_NAMES[segment.kind] ?? "片段") ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => `${count} 段${name}`);
  if (!parts.length) return "";
  return `选中的是 ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join("、")}和 ${parts.at(-1)}`}`;
}

// ---------- 操作历史面板（D10） ----------

/** 历史面板宽度 */
export const HISTORY_WIDTH = 268;
const HISTORY_EDGE = 8;

/** 面板放在按钮下面、右边和按钮对齐，左右夹进窗口；最高到窗口底下留 18px */
export function historyPanelPosition(
  anchor: { right: number; bottom: number; top?: number }, viewport: { width: number; height: number },
): { left: number; top?: number; bottom?: number; maxHeight: number } {
  const left = Math.max(HISTORY_EDGE, Math.min(anchor.right - HISTORY_WIDTH, viewport.width - HISTORY_WIDTH - HISTORY_EDGE));
  const top = anchor.bottom + 6;
  const below = viewport.height - top - 18;
  // 按钮在下半截（时间线工具栏）、下面放不下时往上开，底边贴着按钮上沿
  if (anchor.top !== undefined && below < 240 && anchor.top - 6 - 18 > below) {
    return { left, bottom: viewport.height - anchor.top + 6, maxHeight: Math.max(120, Math.min(440, anchor.top - 6 - 18)) };
  }
  return { left, top, maxHeight: Math.max(120, Math.min(440, below)) };
}

/**
 * 历史里一步的说法：存档的说法是「撤到哪」（AI 那一轮记的是「AI 处理“…”之前」），列在历史里要说「做了什么」。
 * 老采集器不给 kind 时按说法认。
 */
export function historyStepText(step: Pick<AiEditHistoryStep, "label"> & { kind?: AiEditHistoryStep["kind"] | null }): string {
  const kind = undoKind({ label: step.label, kind: step.kind ?? null });
  if (kind === "turn") return step.label.replace(/之前$/u, "");
  if (kind === "revert" && step.label === "退回") return "退回到某句话之前";
  return step.label;
}

/** 撤销成功后的提示：撤一步说撤了什么，撤好几步说回到了哪一步之前；step 是撤到的最早那一步 */
export function undoneText(step: Pick<AiEditHistoryStep, "label"> & { kind?: AiEditHistoryStep["kind"] | null }, count: number): string {
  return count > 1 ? `已撤销 ${count} 步，回到了「${historyStepText(step)}」之前` : `已撤销：${historyStepText(step)}`;
}

/** 重做成功后的提示；重做那一步只带说法，AI 那一轮按说法认 */
export const redoneText = (label: string): string => `已重做：${historyStepText({ label })}`;

/** 点了历史里第 index 行（0 是最新的）以后的确认说明：会连着撤掉几步、回到哪一步之前 */
export function historyConfirmText(steps: readonly Pick<AiEditHistoryStep, "label" | "kind">[], index: number): string {
  const step = steps[index];
  if (!step) return "";
  return `会连着撤销最近的 ${index + 1} 步，回到「${historyStepText(step)}」之前。之后没再改的话，按重做能一步步找回来。`;
}
