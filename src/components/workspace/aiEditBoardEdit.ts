import { MAX_BATCH_EDITS, type AiEditCatalogKind, type AiEditClipEdit, type AiEditEditCall, type EditAnimation, type EditMediaSegment, type EditProject, type EditSegment, type EditTimeRange, type EditTrack, type EditTransform } from "../../services/aiEdit";
import { clipLabel, IDENTITY_TRANSFORM, secondMark, US_PER_SECOND } from "./aiEditModel";

// 看板上手动剪的纯计算：轨道上挪动、裁剪换算成时间（带吸附），⌘B 切哪段、新工程进来后选中怎么跟，
// 画面上拖动、缩放换算成 transform，框选和图层求交。
// 算出来的值按 update_clip / move_clip / split_clip 的参数（秒）交给采集器，校验和报错都以采集器为准。
// 后面的轨道区、画面纯函数分别放 aiEditTimelineEdit.ts、aiEditStageEdit.ts。

/** 片段最短 0.1 秒。 */
export const MIN_CLIP_US = 100_000;
/** 拖到吸附目标这么多像素以内就贴过去。 */
export const SNAP_PX = 6;

const end = (range: EditTimeRange) => range.start_us + range.duration_us;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const seconds = (us: number) => us / US_PER_SECOND;

/** 同采集器 projectStore 的 pyRound：正好一半时取偶数。截取长度和时间线时长要按它对得上。 */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** value 离 targets 里最近的一个不超过 thresholdUs 就贴过去，否则原样。 */
export function snapTime(value: number, targets: readonly number[], thresholdUs: number): number {
  let best = value;
  let gap = thresholdUs;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= gap) { best = target; gap = distance; }
  }
  return best;
}

/** 吸附目标：同轨其他片段的两头、播放头、0。 */
export function snapTargets(siblings: readonly EditSegment[], playheadUs: number | null): number[] {
  const targets = [0];
  if (playheadUs !== null && Number.isFinite(playheadUs)) targets.push(playheadUs);
  for (const segment of siblings) targets.push(segment.timeline.start_us, end(segment.timeline));
  return targets;
}

export interface DragContext {
  /** 同一轨道上的其他片段 */
  siblings: readonly EditSegment[];
  playheadUs: number | null;
  /** 轨道上一像素是多少微秒 */
  usPerPx: number;
  /** 素材全长；拿不到时不限 */
  mediaDurationUs?: number | null;
}

/** 按住片段中间拖：新的开始时间。头或尾哪个离吸附目标近就贴哪个；不早于 0。 */
export function dragMoveStart(timeline: EditTimeRange, deltaUs: number, ctx: DragContext): number {
  const raw = Math.max(0, timeline.start_us + deltaUs);
  const threshold = SNAP_PX * ctx.usPerPx;
  let best = raw;
  let gap = threshold;
  for (const target of snapTargets(ctx.siblings, ctx.playheadUs)) {
    for (const candidate of [target, target - timeline.duration_us]) {
      if (candidate < 0) continue;
      const distance = Math.abs(candidate - raw);
      if (distance <= gap) { best = candidate; gap = distance; }
    }
  }
  return Math.round(best);
}

export type TrimEdge = "start" | "end";
export interface TrimResult { timeline: EditTimeRange; /** 视频、音频跟着改的截取区间；其他片段为 null */ source: EditTimeRange | null }

/** 视频、音频的截取要跟着改；图片的截取由采集器跟着时长走，按普通片段算 */
const hasSource = (segment: EditSegment): segment is EditMediaSegment => segment.kind === "video" || segment.kind === "audio";

/**
 * 拖片段的一头裁剪：左端动开始时间（尾巴不动），右端动时长。片段最短 0.1 秒，不压到同轨相邻的片段；
 * 视频、音频的截取跟着按倍速换算，截取不早于素材开头、不超出素材时长。截取长度取整数微秒，
 * 时间线时长再按采集器的规则（截取长度 ÷ 倍速，pyRound）倒算，两边才对得上。
 */
export function dragTrim(segment: EditSegment, edge: TrimEdge, deltaUs: number, ctx: DragContext): TrimResult {
  const { timeline } = segment;
  const start = timeline.start_us;
  const stop = end(timeline);
  const unchanged: TrimResult = { timeline: { ...timeline }, source: hasSource(segment) ? { ...segment.source } : null };
  const prevEnd = ctx.siblings.reduce((latest, other) => (end(other.timeline) <= start ? Math.max(latest, end(other.timeline)) : latest), 0);
  const nextStart = ctx.siblings.reduce((earliest, other) => (other.timeline.start_us >= stop ? Math.min(earliest, other.timeline.start_us) : earliest), Number.POSITIVE_INFINITY);
  const target = snapTime((edge === "start" ? start : stop) + deltaUs, snapTargets(ctx.siblings, ctx.playheadUs), SNAP_PX * ctx.usPerPx);
  const media = hasSource(segment) ? segment : null;
  const speed = media && media.speed > 0 ? media.speed : 1;
  const total = ctx.mediaDurationUs && ctx.mediaDurationUs > 0 ? ctx.mediaDurationUs : Number.POSITIVE_INFINITY;

  if (edge === "end") {
    const longest = Math.min(nextStart - start, media ? (total - media.source.start_us) / speed : Number.POSITIVE_INFINITY);
    if (longest < MIN_CLIP_US) return unchanged;
    const duration = clamp(target - start, MIN_CLIP_US, longest);
    if (!media) return { timeline: { start_us: start, duration_us: Math.round(duration) }, source: null };
    const room = Math.min(total - media.source.start_us, Math.floor((nextStart - start) * speed));
    let sourceDuration = Math.min(Math.round(duration * speed), room);
    // 取整差的那一微秒：短了补、压到下一段就退
    for (let guard = 0; guard < 64 && pyRound(sourceDuration / speed) < MIN_CLIP_US && sourceDuration < room; guard += 1) sourceDuration += 1;
    for (let guard = 0; guard < 64 && start + pyRound(sourceDuration / speed) > nextStart; guard += 1) sourceDuration -= 1;
    return {
      timeline: { start_us: start, duration_us: pyRound(sourceDuration / speed) },
      source: { start_us: media.source.start_us, duration_us: sourceDuration },
    };
  }

  const earliest = Math.max(prevEnd, media ? start - media.source.start_us / speed : 0, 0);
  const latest = stop - MIN_CLIP_US;
  if (latest < earliest) return unchanged;
  const nextStartUs = clamp(target, earliest, latest);
  if (!media) {
    const rounded = Math.round(nextStartUs);
    return { timeline: { start_us: rounded, duration_us: stop - rounded }, source: null };
  }
  const sourceEnd = end(media.source);
  let sourceStart = Math.max(0, Math.round(media.source.start_us + (nextStartUs - start) * speed));
  const startFor = (from: number) => stop - pyRound((sourceEnd - from) / speed);
  const floorUs = Math.ceil(earliest);
  for (let guard = 0; guard < 64 && startFor(sourceStart) < floorUs; guard += 1) sourceStart += 1;
  for (let guard = 0; guard < 64 && stop - startFor(sourceStart) < MIN_CLIP_US && sourceStart > 0; guard += 1) sourceStart -= 1;
  const duration = pyRound((sourceEnd - sourceStart) / speed);
  return {
    timeline: { start_us: stop - duration, duration_us: duration },
    source: { start_us: sourceStart, duration_us: sourceEnd - sourceStart },
  };
}

/** 裁剪结果换成 update_clip 的参数：左端带开始时间，右端只改时长；视频、音频带上截取和当前倍速，免得被当成变速。 */
export function trimArgs(segment: EditSegment, edge: TrimEdge, result: TrimResult): Record<string, unknown> {
  const args: Record<string, unknown> = { clip_id: segment.id };
  if (edge === "start") args.start = seconds(result.timeline.start_us);
  args.duration = seconds(result.timeline.duration_us);
  if (result.source && hasSource(segment)) {
    if (edge === "start") args.source_start = seconds(result.source.start_us);
    args.source_duration = seconds(result.source.duration_us);
    args.speed = segment.speed > 0 ? segment.speed : 1;
  }
  return args;
}

/** 播放头在片段中间时，从片段开头算起的切点（微秒）；离两头不到 0.1 秒或在片段外为 null，免得切出碎片。 */
export function splitOffset(segment: EditSegment, playheadUs: number): number | null {
  const offset = Math.round(playheadUs - segment.timeline.start_us);
  return offset >= MIN_CLIP_US && offset <= segment.timeline.duration_us - MIN_CLIP_US ? offset : null;
}

export interface SplitTarget { track: EditTrack; segment: EditSegment; offset: number }

/**
 * ⌘B 切哪段（一次只切一段，只存一份快照）：选中的片段里播放头在它中间的（primary 排在 ids 最前面传进来）；
 * 否则叠在最底层的视频轨上被播放头穿过的那段；再没有就从上层往下层（轨道列表越靠后越在上面）找，字幕轨不算。
 * 照 openfilm 的 splitTargets（studio/ui/src/lib/timeline-nav.ts），区别是选中的切不了时也往下找。only：只看传进来的这几段，切不了就是 null（详情卡上的切开按钮）。
 */
export function splitTarget(
  project: Pick<EditProject, "tracks"> | null | undefined, selectedIds: readonly string[], playheadUs: number, options: { only?: boolean } = {},
): SplitTarget | null {
  const tracks = project?.tracks ?? [];
  const hit = (track: EditTrack | undefined, only?: string): SplitTarget | null => {
    for (const segment of track?.segments ?? []) {
      if (only && segment.id !== only) continue;
      const offset = splitOffset(segment, playheadUs);
      if (offset !== null) return { track: track!, segment, offset };
    }
    return null;
  };
  for (const id of selectedIds) {
    const found = hit(tracks.find((track) => track.segments.some((segment) => segment.id === id)), id);
    if (found) return found;
  }
  if (options.only) return null;
  const base = hit(tracks.find((track) => track.track_type === "video"));
  if (base) return base;
  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    if (tracks[index]!.kind === "subtitle") continue;
    const found = hit(tracks[index]);
    if (found) return found;
  }
  return null;
}

/** 切开、粘贴后等着选中的那段：那条轨道上开头离 atUs 不到一帧的片段，找不到为 null。 */
export function expectedClip(project: Pick<EditProject, "tracks"> | null | undefined, target: { trackId: string; atUs: number }, frameUs: number): string | null {
  const track = project?.tracks.find((item) => item.id === target.trackId);
  let best: { id: string; gap: number } | null = null;
  for (const segment of track?.segments ?? []) {
    const gap = Math.abs(segment.timeline.start_us - target.atUs);
    if (gap < frameUs && (!best || gap < best.gap)) best = { id: segment.id, gap };
  }
  return best?.id ?? null;
}

/** ⌘A 全选：所有轨道上的片段，字幕轨除外（太密，选上也没法一起挪）。 */
export const selectableIds = (project: Pick<EditProject, "tracks"> | null | undefined): string[] =>
  (project?.tracks ?? []).filter((track) => track.kind !== "subtitle").flatMap((track) => track.segments.map((segment) => segment.id));

/** 看板上选中的片段：ids 按选上的先后，primary 是详情卡显示的那段 */
export interface Picked { ids: readonly string[]; primary: string | null }
/** 等着选中的那段（切开的右半段、粘贴出来的那段），revision 是发请求时的工程版本 */
export interface PendingSelect { trackId: string; atUs: number; revision: number }

/** 新工程进来后还在的选中；primary 不在了就换成剩下的最后一个。没变时原样返回同一个对象。 */
export function keepSelection(project: Pick<EditProject, "tracks"> | null | undefined, picked: Picked): Picked {
  if (!picked.ids.length) return picked;
  const known = new Set((project?.tracks ?? []).flatMap((track) => track.segments.map((segment) => segment.id)));
  const ids = picked.ids.filter((id) => known.has(id));
  if (ids.length === picked.ids.length) return picked;
  return { ids, primary: picked.primary && known.has(picked.primary) ? picked.primary : ids.at(-1) ?? null };
}

/**
 * 新工程进来时选中怎么变：有等着选中的，版本还没变就先什么都不动（不收卡片）；变了就选上那段，
 * 找不到就照常去掉不在了的。没有等着的就只去掉不在了的。
 */
export function settleSelection(project: Pick<EditProject, "tracks" | "revision"> | null | undefined, picked: Picked, waiting: PendingSelect | null, frameUs: number): { picked: Picked; waiting: PendingSelect | null } {
  if (waiting) {
    if (!project || project.revision === waiting.revision) return { picked, waiting };
    const id = expectedClip(project, waiting, frameUs);
    return { picked: id ? { ids: [id], primary: id } : keepSelection(project, picked), waiting: null };
  }
  return { picked: keepSelection(project, picked), waiting };
}

/** 上一步存档是什么：AI 的一整轮（turn）、看板改动（edit）还是退回（revert）。老采集器不给 kind 时按说法认 AI 那一轮。 */
export function undoKind(undo: { label: string; kind?: string | null } | null | undefined): "turn" | "edit" | "revert" | null {
  if (!undo) return null;
  if (undo.kind === "turn" || undo.kind === "edit" || undo.kind === "revert") return undo.kind;
  return undo.label.startsWith("AI 处理“") ? "turn" : undo.label === "退回" ? "revert" : "edit";
}

/** 一批改动超过采集器的上限时的提示（全选后删、挪、复制，一段一条）；没超为 null，不发请求、不分几批（分批就不是一步撤销了） */
export function tooManyEditsText(count: number, limit = MAX_BATCH_EDITS): string | null {
  return count > limit ? `一次最多能改 ${limit} 段，这次有 ${count} 段，少选一些再试` : null;
}

/**
 * 轨道区单击（没拖开）后交给 pick 的片段：按在刻度尺那一行上只挪播放头、选中不变，为 undefined，
 * 这样选中片段后点刻度尺就能定切点；按在片段上是它的 id，按在轨道空白处是 null（收起详情）。
 */
export function tapPick(clip: string | null, pointerY: number, ruler: { top: number; bottom: number }): string | null | undefined {
  return pointerY >= ruler.top && pointerY <= ruler.bottom ? undefined : clip;
}

// ---------- 画面上拖动、缩放 ----------

const MOTION_KEYS = new Set(["transform_x", "transform_y", "position_x", "position_y", "uniform_scale", "scale_x", "scale_y"]);

/** 片段有没有位置或缩放关键帧：有的话画面上不给拖，静态 transform 会被关键帧盖掉。 */
export const hasMotionKeyframes = (segment: { keyframes?: Array<{ property: string }> }) => Boolean(segment.keyframes?.some((item) => MOTION_KEYS.has(item.property)));

/** 片段现在的完整 transform（没设的项是默认值）。update_clip 的 transform 是整体替换，要发完整的。 */
export const fullTransform = (transform: EditTransform | null | undefined): EditTransform => ({ ...IDENTITY_TRANSFORM, ...(transform ?? {}) });

export interface StageDrag { dx: number; dy: number; ratio: number }

/** 在现有 transform 上挪 dx、dy（舞台像素）、等比缩放 ratio：位移以半个画布为单位、y 向上为正，位置限在 -1..1，缩放限在 0.05..20。 */
export function draggedTransform(base: EditTransform, drag: StageDrag, stage: { width: number; height: number }): EditTransform {
  const halfWidth = stage.width / 2 || 1;
  const halfHeight = stage.height / 2 || 1;
  return {
    ...base,
    transform_x: round4(clamp(base.transform_x + drag.dx / halfWidth, -1, 1)),
    transform_y: round4(clamp(base.transform_y - drag.dy / halfHeight, -1, 1)),
    scale_x: round4(clamp(base.scale_x * drag.ratio, 0.05, 20)),
    scale_y: round4(clamp(base.scale_y * drag.ratio, 0.05, 20)),
  };
}

/** 拖右下角缩放：以中心为准，鼠标位移投影到对角线方向上换成缩放比。 */
export function resizeRatio(box: { width: number; height: number }, dx: number, dy: number): number {
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  const length = halfWidth * halfWidth + halfHeight * halfHeight;
  if (!(length > 0)) return 1;
  return Math.max(0.01, (halfWidth * (halfWidth + dx) + halfHeight * (halfHeight + dy)) / length);
}

// ---------- 框选 ----------

export interface Rect { left: number; top: number; width: number; height: number }

/** 按下和松开两点围成的框，往哪个方向拖都行；再夹进舞台里。 */
export function dragRect(x0: number, y0: number, x1: number, y1: number, stage: { width: number; height: number }): Rect {
  const left = clamp(Math.min(x0, x1), 0, stage.width);
  const top = clamp(Math.min(y0, y1), 0, stage.height);
  const right = clamp(Math.max(x0, x1), 0, stage.width);
  const bottom = clamp(Math.max(y0, y1), 0, stage.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** 两个矩形有没有重叠的面积（只碰到边不算）。 */
export const intersects = (a: Rect, b: Rect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** 框里有哪些图层：和框有重叠的都算，按图层顺序、去重。 */
export function layersInRect(rect: Rect, layers: ReadonlyArray<{ id: string; rect: Rect }>): string[] {
  const ids: string[] = [];
  for (const layer of layers) if (intersects(rect, layer.rect) && !ids.includes(layer.id)) ids.push(layer.id);
  return ids;
}

export interface RegionBox { x: number; y: number; width: number; height: number }

/** 舞台像素的框换成相对画布的比例（0–1，从左上角量），太小（不到 minPx）为 null。 */
export function regionBox(rect: Rect, stage: { width: number; height: number }, minPx = 4): RegionBox | null {
  if (!(stage.width > 0 && stage.height > 0) || rect.width < minPx || rect.height < minPx) return null;
  const x = clamp(round4(rect.left / stage.width), 0, 1);
  const y = clamp(round4(rect.top / stage.height), 0, 1);
  const width = Math.min(round4(rect.width / stage.width), 1 - x);
  const height = Math.min(round4(rect.height / stage.height), 1 - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

const KIND_CALLS: Record<EditSegment["kind"], string> = { video: "视频", image: "图片", audio: "音频", text: "文字", sticker: "贴纸", track_effect: "特效", track_filter: "滤镜" };

/** 片段的口语称呼：视频“海边”、文字“周末去海边”、贴纸。 */
export function clipCallName(segment: EditSegment, mediaName?: string | null): string {
  if (segment.kind === "sticker") return "贴纸";
  const label = clipLabel(segment, mediaName);
  const short = label.length > 16 ? `${label.slice(0, 16)}…` : label;
  return short ? `${KIND_CALLS[segment.kind]}“${short}”` : KIND_CALLS[segment.kind];
}

// 左栏「剪映素材」：每种素材用哪个工具、套在哪种片段上；动画是入场、出场、组合（文字是循环）哪一种
type CatalogTarget = "visual" | "text" | "audio";
export type AnimationPhase = NonNullable<EditAnimation["phase"]>;
const CATALOG_EDITS: Record<AiEditCatalogKind, { tool: AiEditClipEdit; arg: string; on: CatalogTarget; phase?: AnimationPhase }> = {
  transition: { tool: "add_transition", arg: "transition_type", on: "visual" },
  filter: { tool: "add_filter", arg: "filter_type", on: "visual" },
  video_effect: { tool: "add_effect", arg: "effect_type", on: "visual" },
  video_intro: { tool: "add_animation", arg: "animation_type", on: "visual", phase: "in" },
  video_outro: { tool: "add_animation", arg: "animation_type", on: "visual", phase: "out" },
  video_group: { tool: "add_animation", arg: "animation_type", on: "visual", phase: "group" },
  mask: { tool: "add_mask", arg: "mask_type", on: "visual" },
  mix_mode: { tool: "set_mix_mode", arg: "mode", on: "visual" },
  text_intro: { tool: "add_animation", arg: "animation_type", on: "text", phase: "in" },
  text_outro: { tool: "add_animation", arg: "animation_type", on: "text", phase: "out" },
  text_loop: { tool: "add_animation", arg: "animation_type", on: "text", phase: "loop" },
  font: { tool: "update_clip", arg: "font_family", on: "text" },
  audio_effect: { tool: "add_effect", arg: "effect_type", on: "audio" },
};
const TARGET_NAMES: Record<CatalogTarget, string> = { visual: "视频或图片片段", text: "文字片段", audio: "音频片段" };
const targetOf = (segment: EditSegment): CatalogTarget | null =>
  segment.kind === "video" || segment.kind === "image" ? "visual" : segment.kind === "text" ? "text" : segment.kind === "audio" ? "audio" : null;

/** 这种剪映素材该套在哪种片段上（说法，给提示用）。 */
export const catalogTargetName = (kind: AiEditCatalogKind) => TARGET_NAMES[CATALOG_EDITS[kind].on];

const PHASE_ORDER: Record<AnimationPhase, number> = { in: 0, out: 1, group: 2, loop: 2 };
/** 采集器按剪映目录标的是哪一种；没标的当入场 */
export const phaseOf = (item: EditAnimation): AnimationPhase => item.phase ?? "in";

/**
 * 把这段的动画换成 list：只是在后面多加几个就直接加；不然先全去掉，再按入场、出场、组合/循环的顺序重新加
 * （剪映要求文字的循环动画最后加），留下的动画带着原来的时长。都写上是哪一种：入场和出场有上百个同名的。
 */
export function animationEdits(segment: EditSegment, list: readonly EditAnimation[]): AiEditEditCall[] {
  const existing = ("animations" in segment ? segment.animations : null) ?? [];
  const ordered = [...list].sort((a, b) => PHASE_ORDER[phaseOf(a)] - PHASE_ORDER[phaseOf(b)]);
  const add = (item: EditAnimation): AiEditEditCall => ({
    name: "add_animation",
    arguments: {
      clip_id: segment.id, animation_type: item.animation_type, phase: phaseOf(item),
      ...(item.duration_us ? { duration: Math.min(item.duration_us, segment.timeline.duration_us) / US_PER_SECOND } : {}),
    },
  });
  if (existing.every((item, index) => ordered[index] === item)) return ordered.slice(existing.length).map(add);
  return [{ name: "clear_clip_feature", arguments: { clip_id: segment.id, feature: "animations" } }, ...ordered.map(add)];
}

/**
 * 选中一段时点了素材换成的看板改动（一批，一步撤销）。和剪映一样同一种直接换掉：入场换入场、出场换出场，视频的组合动画和入场出场互相顶掉；
 * 滤镜、转场、音效、蒙版、混合模式、字体换成新的，原来的滤镜强度、转场时长照旧；画面特效是叠加的。
 * 素材名用目录里的成员名。这段放不了这种素材返回 null，已经是这个了返回空的。
 */
export function catalogEdits(kind: AiEditCatalogKind, name: string, segment: EditSegment): AiEditEditCall[] | null {
  const { tool, arg, on, phase } = CATALOG_EDITS[kind];
  if (targetOf(segment) !== on) return null;
  const clip_id = segment.id;
  const add = (extra: Record<string, unknown> = {}): AiEditEditCall => ({ name: tool, arguments: { clip_id, [arg]: name, ...extra } });
  const swap = (feature: string, had: boolean, extra: Record<string, unknown> = {}): AiEditEditCall[] =>
    [...(had ? [{ name: "clear_clip_feature" as const, arguments: { clip_id, feature } }] : []), add(extra)];
  if (phase) {
    const animations = ("animations" in segment ? segment.animations : null) ?? [];
    if (animations.some((item) => item.animation_type === name && phaseOf(item) === phase)) return [];
    const clash = (item: EditAnimation) => phaseOf(item) === phase || (on === "visual" && (phase === "group" || phaseOf(item) === "group"));
    return animationEdits(segment, [...animations.filter((item) => !clash(item)), { animation_type: name, phase }]);
  }
  if (segment.kind === "text") return segment.font_family === name ? [] : [add()];
  // 走到这里只剩视频、图片、音频（上面按 targetOf 挡过）
  const media = segment as EditMediaSegment;
  switch (kind) {
    case "transition": {
      const old = media.transition;
      return old?.transition_type === name ? [] : [add(old?.duration_us ? { duration: old.duration_us / US_PER_SECOND } : {})];
    }
    case "filter": {
      const filters = media.filters ?? [];
      if (filters.length === 1 && filters[0]!.filter_type === name) return [];
      const intensity = filters[0]?.intensity;
      return swap("filters", filters.length > 0, intensity === undefined ? {} : { intensity });
    }
    case "mask": return media.mask?.mask_type === name ? [] : swap("mask", Boolean(media.mask));
    case "mix_mode": return media.mix_mode?.mode === name ? [] : swap("mix_mode", Boolean(media.mix_mode));
    default: {
      const effects = media.effects ?? [];
      if (effects.some((item) => item.effect_type === name)) return [];
      // ponytail: 音效不分哪一类（场景音、音色、声音成曲）整个换掉，剪映里同一类只能有一个；要叠不同类的音效交给 AI
      return swap("effects", kind === "audio_effect" && effects.length > 0);
    }
  }
}

/** 输入框上方的框选提示。 */
export function regionHint(timeUs: number, labels: readonly string[]): string {
  const at = `在${secondMark(timeUs)}的画面上框了一块`;
  if (!labels.length) return `${at}空白位置`;
  return `${at}，里面有${labels.length <= 2 ? labels.join("、") : ` ${labels.length} 样东西：${labels.join("、")}`}`;
}

/** 用户消息气泡下面那行小字。 */
export function regionCaption(timeUs: number, labels: readonly string[] | null | undefined): string {
  const at = `带了框选：${secondMark(timeUs)}画面上的一块`;
  return labels?.length ? `${at}，框里有${labels.join("、")}` : `${at}空白位置`;
}
