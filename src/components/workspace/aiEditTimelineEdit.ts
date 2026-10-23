import type { EditMediaSegment, EditProject, EditSegment, EditTimeRange, EditTrack, EditTrackType } from "../../services/aiEdit";
import type { BoardEdit } from "./aiEditBoardContext";
import { MIN_CLIP_US, pyRound, SNAP_PX, splitOffset, trimArgs, type TrimEdge, type TrimResult } from "./aiEditBoardEdit";
import { shortestUs } from "./aiEditInspect";
import { formatTick, pickTickStep, stepFrame, US_PER_SECOND } from "./aiEditModel";

// 轨道区手动剪的纯计算：吸附、落点和邻居、跨轨道、整组挪、裁剪、键盘微调、复制粘贴、框选、时间线缩放。
// 只用现在的看板接口（move_clip / update_clip / duplicate_clip / update_track / reorder_tracks），校验和报错仍以采集器为准；
// 这里先把肯定会被拒的落点拦住，不等采集器报错再弹回。
// 吸附、推到贴住、裁剪、框选、微调、缩放和拖到边缘自动滚的做法搬自 openfilm（studio/ui/src/lib/timeline-drag.ts、timeline-nav.ts、
// timeline-layout.ts、components/useBlockDrag.ts），MIT License，Copyright (c) 2026 OpenFilm contributors。

/** 按住片段拖满这么多像素才算挪（上下也算，好拖到别的轨道） */
export const MOVE_LIFT_PX = 4;
/** 裁剪一动就跟 */
export const TRIM_LIFT_PX = 1;
/** 轨道空白处拖满这么多像素变框选，不然是点了一下 */
export const MARQUEE_LIFT_PX = 5;
/** 键盘微调停手这么久才合成一次提交 */
export const NUDGE_WRITE_MS = 350;
/** 默认比例：成片占轨道宽的八成，后面空两成好往后拖 */
export const ZOOM_DEFAULT = 0.8;
/** ⌘= / ⌘− 一下放大缩小多少 */
export const ZOOM_STEP = 1.6;
/** 拖到滚动区左右边缘这么近就自动滚 */
export const EDGE_SCROLL_PX = 48;
/** 差不到 1 毫秒算贴着 */
const TOUCH_US = 1_000;

const end = (range: EditTimeRange) => range.start_us + range.duration_us;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** 落到帧上：先换成第几帧再乘回去。 */
export const toFrame = (us: number, frameUs: number) => (frameUs > 0 ? Math.round(Math.round(us / frameUs) * frameUs) : Math.round(us));

// ---------- 吸附（A2） ----------

/**
 * 吸附目标：0、播放头、标记、所有轨道（字幕轨除外，太密）上每段的开头和结尾，按这个顺序排（距离一样时前面的胜出）。
 * exclude 是正在拖的片段，不吸自己；edgeUs 是裁剪时被拖那条边现在的位置，正好在那儿的目标去掉，不然首尾相接的邻居会把边卡住。
 */
export function snapTargetsOf(
  project: Pick<EditProject, "tracks" | "markers"> | null | undefined,
  options: { exclude?: Iterable<string>; playheadUs?: number | null; edgeUs?: number | null } = {},
): number[] {
  const skip = new Set(options.exclude ?? []);
  const targets = [0];
  if (options.playheadUs !== null && options.playheadUs !== undefined && Number.isFinite(options.playheadUs)) targets.push(options.playheadUs);
  for (const marker of project?.markers ?? []) targets.push(marker.time_us);
  for (const track of project?.tracks ?? []) {
    if (track.kind === "subtitle") continue;
    for (const segment of track.segments) if (!skip.has(segment.id)) targets.push(segment.timeline.start_us, end(segment.timeline));
  }
  const edge = options.edgeUs;
  return edge === null || edge === undefined ? targets : targets.filter((target) => Math.abs(target - edge) >= TOUCH_US);
}

/** 离 value 最近、又不超过 reachUs 的目标；一样近时取前面的。没吸上 snapped 为 null。 */
export function snapTo(value: number, targets: readonly number[], reachUs: number): { value: number; snapped: number | null } {
  let best: number | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= reachUs && distance < gap) { best = target; gap = distance; }
  }
  return best === null ? { value, snapped: null } : { value: best, snapped: best };
}

// ---------- 落点和邻居（A3） ----------

/** 邻居占的时间并成互不重叠的几段（首尾相接的也并起来，推到贴住时才不会推进下一段里） */
function busyRanges(occupied: readonly EditTimeRange[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const range of [...occupied].sort((a, b) => a.start_us - b.start_us)) {
    const last = out.at(-1);
    if (last && range.start_us <= last.end) last.end = Math.max(last.end, end(range));
    else out.push({ start: range.start_us, end: end(range) });
  }
  return out;
}

export interface Placement { start: number; /** 推到贴住时贴的那条边，画参考线用 */ snappedUs: number | null; refused: boolean }

/**
 * 一段放到 startUs 和同轨邻居重叠时：差一点（不超过 reachUs）就推到贴住，差得多就拒绝。
 * 候选是贴到每个挡路邻居的尾巴后面或开头前面，只留位移不超过 reachUs、不早于 0、推过去是空的那些，取位移最小的。
 * 首尾正好相接不算重叠，和采集器的 validatePlacement 一样。照 openfilm 的 flushShiftMs。
 */
export function placeMove(startUs: number, durUs: number, occupied: readonly EditTimeRange[], reachUs: number): Placement {
  const busy = busyRanges(occupied);
  const hits = busy.filter((range) => overlaps(range, { start: startUs, end: startUs + durUs }));
  if (!hits.length) return { start: startUs, snappedUs: null, refused: false };
  const tries = hits.flatMap((range) => [{ shift: range.end - startUs, edge: range.end }, { shift: range.start - durUs - startUs, edge: range.start }])
    .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift));
  for (const one of tries) {
    if (!one.shift || Math.abs(one.shift) > reachUs) continue;
    const at = startUs + one.shift;
    if (at < 0 || busy.some((range) => overlaps(range, { start: at, end: at + durUs }))) continue;
    return { start: at, snappedUs: one.edge, refused: false };
  }
  return { start: startUs, snappedUs: null, refused: true };
}

// ---------- 跨轨道（D5） ----------

const TRACK_FOR_KIND: Record<EditSegment["kind"], EditTrackType> = {
  video: "video", image: "video", audio: "audio", text: "text", sticker: "sticker", track_effect: "effect", track_filter: "filter",
};
const KIND_TEXT: Record<EditSegment["kind"], string> = {
  video: "视频和图片", image: "视频和图片", audio: "音频", text: "文字", sticker: "贴纸", track_effect: "特效", track_filter: "滤镜",
};
const TRACK_TEXT: Record<EditTrackType, string> = { video: "视频", audio: "音频", text: "文字", sticker: "贴纸", effect: "特效", filter: "滤镜" };

type TrackShape = Pick<EditTrack, "id" | "kind" | "track_type">;

/** 片段能不能从 from 挪到（或复制到）to：能是 null，不能是原因。规则同采集器的 checkTrackFits。 */
export function trackRefusal(segment: Pick<EditSegment, "kind">, from: TrackShape, to: TrackShape): string | null {
  if (from.id === to.id) return null;
  if (from.kind === "subtitle") return "字幕只能留在字幕轨上";
  if (to.kind === "subtitle") return "字幕轨上只放整组字幕";
  const wanted = TRACK_FOR_KIND[segment.kind];
  return wanted === to.track_type ? null : `${KIND_TEXT[segment.kind]}只能放在${TRACK_TEXT[wanted]}轨道上`;
}

// ---------- 挪动（单段、整组、跨轨、⌥ 复制） ----------

export interface MoveItem { id: string; fromTrackId: string; trackId: string; timeline: EditTimeRange }
export interface MovePlan {
  /** 每段落到哪（被拒时是跟着手的位置，照样画出来） */
  items: MoveItem[];
  snappedUs: number | null;
  /** 放不下的原因；能放是 null */
  refused: string | null;
}

export interface MoveSpec {
  /** 一起挪的片段（整组），lead 是手里抓着的那段 */
  ids: readonly string[];
  lead: string;
  deltaUs: number;
  /** 在轨道区里往下挪了几行（负数往上，轨道区是倒着画的，见 trackRows）；指针在所有行外面是 null */
  rowDelta: number | null;
  /** ⌥ 拖：原片段不动，复制一份放过去 */
  copy?: boolean;
  playheadUs: number | null;
  /** 压到邻居多近就推到贴住 */
  reachUs: number;
  /** 吸附多近才吸（工具栏关了吸附就是 0）；不给照 reachUs */
  snapUs?: number;
  /** 主轨磁吸开着：落到这条轨道上不查重叠，由 rippleEdits 插进去重排 */
  insertTrackId?: string | null;
  frameUs: number;
}

/**
 * 拖片段的落点。头和尾都试着吸附、取近的；没吸上就落在帧上；整组位移一样，最早的一段不早于 0（照 openfilm 的 applyDrag）。
 * 上下挪 rowDelta 行时每段都换到同样隔几行的轨道，类型不合、字幕轨进出都拒绝。
 * 单段压到邻居一点点就推到贴住；整组只要有一段放不下整组都不放（openfilm 的 groupLaneShift 也是这样）。
 * ⌥ 拖复制和 ⌘D 一样跳过字幕；抓着的就是字幕时整次不放。
 */
export function planMove(project: Pick<EditProject, "tracks" | "markers"> | null | undefined, spec: MoveSpec): MovePlan | null {
  const tracks = project?.tracks ?? [];
  const members: Array<{ segment: EditSegment; row: number }> = [];
  for (const id of new Set(spec.ids)) {
    const row = tracks.findIndex((track) => track.segments.some((segment) => segment.id === id));
    if (row < 0 || (spec.copy && id !== spec.lead && tracks[row]!.kind === "subtitle")) continue;
    members.push({ segment: tracks[row]!.segments.find((segment) => segment.id === id)!, row });
  }
  const lead = members.find((member) => member.segment.id === spec.lead);
  if (!lead) return null;
  const moving = new Set(members.map((member) => member.segment.id));
  const targets = snapTargetsOf(project, { exclude: spec.copy ? [] : moving, playheadUs: spec.playheadUs });
  const leadStart = lead.segment.timeline.start_us;
  const leadEnd = end(lead.segment.timeline);
  const snapUs = spec.snapUs ?? spec.reachUs;
  const head = snapTo(leadStart + spec.deltaUs, targets, snapUs);
  const tail = snapTo(leadEnd + spec.deltaUs, targets, snapUs);
  const headGap = head.snapped === null ? Number.POSITIVE_INFINITY : Math.abs(leadStart + spec.deltaUs - head.value);
  const tailGap = tail.snapped === null ? Number.POSITIVE_INFINITY : Math.abs(leadEnd + spec.deltaUs - tail.value);
  let shift = toFrame(leadStart + spec.deltaUs, spec.frameUs) - leadStart;
  let snappedUs: number | null = null;
  if (head.snapped !== null && headGap <= tailGap) { shift = head.value - leadStart; snappedUs = head.value; }
  else if (tail.snapped !== null) { shift = tail.value - leadEnd; snappedUs = tail.value; }
  const floor = Math.min(...members.map((member) => member.segment.timeline.start_us));
  if (shift < -floor) { shift = -floor; snappedUs = 0; }

  let refused: string | null = null;
  const items = members.map((member): MoveItem => {
    const from = tracks[member.row]!;
    // 轨道区往下一行是列表里往前一条
    const dest = spec.rowDelta === null ? undefined : tracks[member.row - spec.rowDelta];
    refused ??= spec.copy && from.kind === "subtitle" ? "字幕不能单独复制" : dest ? trackRefusal(member.segment, from, dest) : "这里没有能放的轨道";
    return { id: member.segment.id, fromTrackId: from.id, trackId: dest?.id ?? from.id, timeline: { start_us: Math.round(member.segment.timeline.start_us + shift), duration_us: member.segment.timeline.duration_us } };
  });
  // 放不下的照样跟着手画在原来那行上
  if (refused) return { items: items.map((item) => ({ ...item, trackId: item.fromTrackId })), snappedUs: null, refused };

  // 主轨磁吸：落到主轨上的是插进去，不算压到邻居
  const occupiedOn = (trackId: string) => (trackId === spec.insertTrackId ? [] : tracks.find((track) => track.id === trackId)?.segments ?? [])
    .filter((segment) => spec.copy || !moving.has(segment.id)).map((segment) => segment.timeline);
  if (items.length === 1) {
    const [item] = items as [MoveItem];
    const placed = placeMove(item.timeline.start_us, item.timeline.duration_us, occupiedOn(item.trackId), spec.reachUs);
    if (placed.refused) return { items, snappedUs: null, refused: "这里放不下" };
    return { items: [{ ...item, timeline: { ...item.timeline, start_us: placed.start } }], snappedUs: placed.snappedUs ?? snappedUs, refused: null };
  }
  // 整组：每段在自己要去的轨道上不能压到不跟着挪的片段（同一行来的落到同一行，彼此间距不变，不会互相压）
  const blocked = items.some((item) => occupiedOn(item.trackId).some((range) => overlaps({ start: range.start_us, end: end(range) }, { start: item.timeline.start_us, end: end(item.timeline) })));
  return blocked ? { items, snappedUs: null, refused: "这里放不下" } : { items, snappedUs, refused: null };
}

/**
 * 整组挪动一条条发出去的顺序。采集器逐条执行、每条单独查重叠，同组里还没挪的片段也算挡路，
 * 所以要让每一步都落进已经腾空的地方：换轨时先挪去的那一头的行（列表里往后换先挪靠后的，往前换先挪靠前的），
 * 同一行里往后挪先挪后面的，往前挪先挪前面的。整组位移一样，落点不压不跟着挪的片段已经由 planMove / nudgeDelta 保证。
 */
export function moveOrder<T extends { timeline: EditTimeRange }>(items: readonly T[], shiftUs: number, rowShift = 0, rowOf: (item: T) => number = () => 0): T[] {
  const byRow = Math.sign(rowShift);
  const byTime = Math.sign(shiftUs);
  return [...items].sort((a, b) => (rowOf(b) - rowOf(a)) * byRow || (b.timeline.start_us - a.timeline.start_us) * byTime);
}

/** 挪动的结果换成看板改动：挪动发 move_clip（按 moveOrder 排好），⌥ 拖发 duplicate_clip；换了轨道才带 track_id。没变的不发。 */
export function moveEdits(plan: MovePlan, original: Pick<EditProject, "tracks"> | null | undefined, copy = false): BoardEdit[] {
  const tracks = original?.tracks ?? [];
  const startOf = new Map(tracks.flatMap((track) => track.segments.map((segment) => [segment.id, segment.timeline.start_us] as const)));
  const rowOf = new Map(tracks.map((track, index) => [track.id, index]));
  const changed = plan.items.filter((item) => copy || item.trackId !== item.fromTrackId || item.timeline.start_us !== startOf.get(item.id));
  const [first] = changed;
  const ordered = copy || !first ? changed : moveOrder(
    changed, first.timeline.start_us - (startOf.get(first.id) ?? first.timeline.start_us),
    (rowOf.get(first.trackId) ?? 0) - (rowOf.get(first.fromTrackId) ?? 0), (item) => rowOf.get(item.fromTrackId) ?? 0,
  );
  return ordered
    .map((item) => ({
      name: copy ? "duplicate_clip" as const : "move_clip" as const,
      arguments: { clip_id: item.id, start: item.timeline.start_us / US_PER_SECOND, ...(item.trackId !== item.fromTrackId ? { track_id: item.trackId } : {}) },
    }));
}

// ---------- 裁剪（A2、A4、C8） ----------

/** 视频、音频的截取跟着改；图片的截取由采集器跟着时长走，按普通片段算 */
const hasSource = (segment: EditSegment): segment is EditMediaSegment => segment.kind === "video" || segment.kind === "audio";

export interface TrimPlan extends TrimResult {
  /** 吸上的目标或停住的邻居边，画参考线用 */
  snappedUs: number | null;
  /** 拉到素材头或尾了：边停在这里的原因 */
  sourceEnd: boolean;
  /** 停在最短长度上时是谁卡住的（「关键帧」「淡入淡出」）；没卡住是 null */
  floorHit: string | null;
}

/** 关键帧、淡入淡出要的最短长度卡住时怎么说：只有 0.1 秒的下限时不说 */
function floorText(segment: EditSegment, floor: number): string | null {
  if (floor <= MIN_CLIP_US) return null;
  return (segment.keyframes ?? []).some((keyframe) => keyframe.offset_us >= floor) ? "关键帧" : "淡入淡出";
}

/**
 * 把片段的一头裁到 wantUs：左端动开始时间（尾巴不动），右端动时长。最短 0.1 秒，也不短过最后一个关键帧、淡入加淡出
 * （shortestUs，采集器同样会拒），不压到同轨邻居；视频、音频的截取跟着按倍速换算，不早于素材开头、不超出素材时长。
 * 截取长度取整数微秒，时间线时长再按采集器的规则（截取长度 ÷ 倍速，pyRound）倒算，两边才对得上。
 * 被邻居、素材、最短长度卡住的边就停在卡住的地方。
 */
export function trimTo(segment: EditSegment, edge: TrimEdge, wantUs: number, ctx: { siblings: readonly EditSegment[]; mediaDurationUs?: number | null }): TrimResult & { sourceEnd: boolean; fenceUs: number | null; floorHit: string | null } {
  const { timeline } = segment;
  const start = timeline.start_us;
  const stop = end(timeline);
  const media = hasSource(segment) ? segment : null;
  const unchanged = { timeline: { ...timeline }, source: media ? { ...media.source } : null };
  const prevEnd = ctx.siblings.reduce((latest, other) => (end(other.timeline) <= start ? Math.max(latest, end(other.timeline)) : latest), 0);
  const nextStart = ctx.siblings.reduce((earliest, other) => (other.timeline.start_us >= stop ? Math.min(earliest, other.timeline.start_us) : earliest), Number.POSITIVE_INFINITY);
  const speed = media && media.speed > 0 ? media.speed : 1;
  const total = ctx.mediaDurationUs && ctx.mediaDurationUs > 0 ? ctx.mediaDurationUs : Number.POSITIVE_INFINITY;
  const floor = shortestUs(segment);
  const reason = floorText(segment, floor);

  if (edge === "end") {
    const fenceUs = Number.isFinite(nextStart) ? nextStart : null;
    const floorHit = wantUs - start < floor ? reason : null;
    const longest = Math.min(nextStart - start, media ? (total - media.source.start_us) / speed : Number.POSITIVE_INFINITY);
    if (longest < floor) return { ...unchanged, sourceEnd: Boolean(media && end(media.source) >= total), fenceUs, floorHit };
    const duration = clamp(wantUs - start, floor, longest);
    if (!media) return { timeline: { start_us: start, duration_us: Math.round(duration) }, source: null, sourceEnd: false, fenceUs, floorHit };
    const room = Math.min(total - media.source.start_us, Math.floor((nextStart - start) * speed));
    let sourceDuration = Math.min(Math.round(duration * speed), room);
    // 取整差的那一微秒：短了补、压到下一段就退
    for (let guard = 0; guard < 64 && pyRound(sourceDuration / speed) < floor && sourceDuration < room; guard += 1) sourceDuration += 1;
    for (let guard = 0; guard < 64 && start + pyRound(sourceDuration / speed) > nextStart; guard += 1) sourceDuration -= 1;
    return {
      timeline: { start_us: start, duration_us: pyRound(sourceDuration / speed) },
      source: { start_us: media.source.start_us, duration_us: sourceDuration },
      sourceEnd: media.source.start_us + sourceDuration >= total,
      fenceUs,
      floorHit,
    };
  }

  const fenceUs = prevEnd > 0 ? prevEnd : null;
  const earliest = Math.max(prevEnd, media ? start - media.source.start_us / speed : 0, 0);
  const latest = stop - floor;
  const floorHit = wantUs > latest ? reason : null;
  if (latest < earliest) return { ...unchanged, sourceEnd: Boolean(media && media.source.start_us <= 0), fenceUs, floorHit };
  const nextStartUs = clamp(wantUs, earliest, latest);
  if (!media) {
    const rounded = Math.round(nextStartUs);
    return { timeline: { start_us: rounded, duration_us: stop - rounded }, source: null, sourceEnd: false, fenceUs, floorHit };
  }
  const sourceEnd = end(media.source);
  let sourceStart = Math.max(0, Math.round(media.source.start_us + (nextStartUs - start) * speed));
  const startFor = (from: number) => stop - pyRound((sourceEnd - from) / speed);
  const floorUs = Math.ceil(earliest);
  for (let guard = 0; guard < 64 && startFor(sourceStart) < floorUs; guard += 1) sourceStart += 1;
  for (let guard = 0; guard < 64 && stop - startFor(sourceStart) < floor && sourceStart > 0; guard += 1) sourceStart -= 1;
  const duration = pyRound((sourceEnd - sourceStart) / speed);
  return {
    timeline: { start_us: stop - duration, duration_us: duration },
    source: { start_us: sourceStart, duration_us: sourceEnd - sourceStart },
    sourceEnd: sourceStart <= 0,
    fenceUs,
    floorHit,
  };
}

/**
 * 拖一头裁剪：被拖的边先吸附（所有轨道的边、标记、播放头，去掉它自己现在的位置），没吸上落在帧上，再按 trimTo 卡住。
 * 照 openfilm applyDrag 的 trim 分支：吸上的、或停在邻居边上的画参考线。
 */
export function planTrim(
  project: Pick<EditProject, "tracks" | "markers"> | null | undefined, segment: EditSegment, edge: TrimEdge, deltaUs: number,
  ctx: { playheadUs: number | null; reachUs: number; frameUs: number; mediaDurationUs?: number | null; snapUs?: number; ripple?: boolean },
): TrimPlan {
  const track = project?.tracks.find((item) => item.segments.some((other) => other.id === segment.id));
  // 波纹裁剪（主轨磁吸）：邻居跟着挪，不当边界
  const siblings = ctx.ripple ? [] : (track?.segments ?? []).filter((other) => other.id !== segment.id);
  const edgeUs = edge === "start" ? segment.timeline.start_us : end(segment.timeline);
  const targets = snapTargetsOf(project, { exclude: [segment.id], playheadUs: ctx.playheadUs, edgeUs });
  const raw = edgeUs + deltaUs;
  const snap = snapTo(raw, targets, ctx.snapUs ?? ctx.reachUs);
  const result = trimTo(segment, edge, snap.snapped === null ? toFrame(raw, ctx.frameUs) : snap.value, { siblings, mediaDurationUs: ctx.mediaDurationUs });
  const landed = edge === "start" ? result.timeline.start_us : end(result.timeline);
  const near = (value: number | null) => value !== null && Math.abs(landed - value) < 1;
  const snappedUs = near(snap.snapped) ? snap.snapped : near(result.fenceUs) && landed !== edgeUs ? result.fenceUs : null;
  return { timeline: result.timeline, source: result.source, snappedUs, sourceEnd: result.sourceEnd, floorHit: result.floorHit };
}

/**
 * Q / W：开头或结尾裁到播放头（不合拢后面的片段）。播放头不在这段中间（离两头不到 0.1 秒）时为 null；
 * 裁到播放头就短过关键帧、淡入淡出时不裁，refused 是原因（不裁到别处去）。
 */
export function trimToPlayhead(
  project: Pick<EditProject, "tracks"> | null | undefined, segment: EditSegment, edge: TrimEdge, playheadUs: number, mediaDurationUs?: number | null,
): { args: Record<string, unknown> } | { refused: string } | null {
  if (splitOffset(segment, playheadUs) === null) return null;
  const track = project?.tracks.find((item) => item.segments.some((other) => other.id === segment.id));
  const siblings = (track?.segments ?? []).filter((other) => other.id !== segment.id);
  const result = trimTo(segment, edge, Math.round(playheadUs), { siblings, mediaDurationUs });
  if (result.floorHit) return { refused: `裁到播放头就放不下${result.floorHit}了` };
  if (result.timeline.start_us === segment.timeline.start_us && result.timeline.duration_us === segment.timeline.duration_us) return null;
  return { args: trimArgs(segment, edge, result) };
}

// ---------- 键盘微调（C7） ----------

export interface HeldClip { id: string; trackId: string; timeline: EditTimeRange }

/**
 * 键盘微调：held 这几段（按开始攒的时候的位置）一起挪 wantUs，碰到同轨不跟着挪的片段就贴住停下，最早的一段不早于 0。
 * 照 openfilm 的 planNudge。
 */
export function nudgeDelta(project: Pick<EditProject, "tracks"> | null | undefined, held: readonly HeldClip[], wantUs: number): number {
  const moving = new Set(held.map((item) => item.id));
  let delta = wantUs;
  for (const item of held) {
    const others = (project?.tracks.find((track) => track.id === item.trackId)?.segments ?? []).filter((segment) => !moving.has(segment.id));
    const itemEnd = end(item.timeline);
    for (const other of others) {
      if (delta > 0 && other.timeline.start_us >= itemEnd - TOUCH_US) delta = Math.min(delta, Math.max(0, other.timeline.start_us - itemEnd));
      if (delta < 0 && end(other.timeline) <= item.timeline.start_us + TOUCH_US) delta = Math.max(delta, Math.min(0, end(other.timeline) - item.timeline.start_us));
    }
  }
  return Math.max(delta, -Math.min(...held.map((item) => item.timeline.start_us)));
}

/** 微调一下之后整组的位移：带头那段先按帧走 frames 帧（落在帧上），再按 nudgeDelta 碰到邻居就停。 */
export function nudgeStep(project: Pick<EditProject, "tracks"> | null | undefined, held: readonly HeldClip[], currentUs: number, frames: number, fps: number): number {
  const lead = held[0];
  if (!lead) return currentUs;
  const want = stepFrame(lead.timeline.start_us + currentUs, fps, frames) - lead.timeline.start_us;
  return nudgeDelta(project, held, want);
}

// ---------- 复制粘贴（D6） ----------

export type CopyPlan = { edits: BoardEdit[]; /** 复制出来的第一段在哪，好等新工程进来选中它 */ lead: { trackId: string; atUs: number } } | { refused: string };

/** 复制的片段现在的样子（剪贴板只存 id）：不在了的、字幕轨上的跳过，按开始时间排 */
function copyable(project: Pick<EditProject, "tracks"> | null | undefined, ids: readonly string[]): Array<{ track: EditTrack; segment: EditSegment }> {
  const out: Array<{ track: EditTrack; segment: EditSegment }> = [];
  for (const id of new Set(ids)) {
    for (const track of project?.tracks ?? []) {
      const segment = track.segments.find((item) => item.id === id);
      if (segment && track.kind !== "subtitle") out.push({ track, segment });
    }
  }
  return out.sort((a, b) => a.segment.timeline.start_us - b.segment.timeline.start_us);
}

/** 复制品放到 shift 之后能不能放下：不压原轨道上的任何片段（原片段还在），复制品之间也不压 */
function copiesFit(items: ReadonlyArray<{ track: EditTrack; segment: EditSegment }>, shift: number): boolean {
  const placed: Array<{ trackId: string; start: number; end: number }> = [];
  for (const { track, segment } of items) {
    const range = { start: segment.timeline.start_us + shift, end: end(segment.timeline) + shift };
    if (range.start < 0) return false;
    if (track.segments.some((other) => overlaps(range, { start: other.timeline.start_us, end: end(other.timeline) }))) return false;
    if (placed.some((other) => other.trackId === track.id && overlaps(range, other))) return false;
    placed.push({ trackId: track.id, ...range });
  }
  return true;
}

function copyEdits(items: ReadonlyArray<{ track: EditTrack; segment: EditSegment }>, shift: number): CopyPlan {
  const [first] = items;
  return {
    edits: items.map(({ segment }) => ({ name: "duplicate_clip" as const, arguments: { clip_id: segment.id, start: (segment.timeline.start_us + shift) / US_PER_SECOND } })),
    lead: { trackId: first!.track.id, atUs: first!.segment.timeline.start_us + shift },
  };
}

const NOTHING_TO_COPY = (ids: readonly string[], project: Pick<EditProject, "tracks"> | null | undefined) =>
  ids.some((id) => project?.tracks.some((track) => track.kind === "subtitle" && track.segments.some((segment) => segment.id === id))) ? "字幕不能单独复制" : "复制的片段已经不在了";

/** ⌘V：粘到播放头处、各自原来的轨道上，几段之间的间距不变（最早那段落在播放头）；放不下就不粘。 */
export function planPaste(project: Pick<EditProject, "tracks"> | null | undefined, ids: readonly string[], atUs: number): CopyPlan {
  const items = copyable(project, ids);
  if (!items.length) return { refused: NOTHING_TO_COPY(ids, project) };
  const shift = Math.round(Math.max(0, atUs)) - items[0]!.segment.timeline.start_us;
  return copiesFit(items, shift) ? copyEdits(items, shift) : { refused: "这里放不下" };
}

/** ⌘D：复制一份紧接在原片段（整组就是整组）后面；那里放不下就放到这几条轨道最后。 */
export function planDuplicate(project: Pick<EditProject, "tracks"> | null | undefined, ids: readonly string[]): CopyPlan {
  const items = copyable(project, ids);
  if (!items.length) return { refused: NOTHING_TO_COPY(ids, project) };
  const groupStart = items[0]!.segment.timeline.start_us;
  const after = Math.max(...items.map(({ segment }) => end(segment.timeline))) - groupStart;
  if (copiesFit(items, after)) return copyEdits(items, after);
  const trackEnd = Math.max(...items.map(({ track }) => Math.max(0, ...track.segments.map((segment) => end(segment.timeline)))));
  return copyEdits(items, Math.max(after, trackEnd - groupStart));
}

// ---------- 框选（D4） ----------

/** 框选到的片段：和框有重叠就算（不用整段在框里），按行算；行号超出范围的那几行没有片段。照 openfilm 的 marqueeHits。 */
export function marqueeHits(tracks: readonly Pick<EditTrack, "segments">[], box: { fromUs: number; toUs: number; fromRow: number; toRow: number }): string[] {
  const from = Math.min(box.fromUs, box.toUs);
  const to = Math.max(box.fromUs, box.toUs);
  const out: string[] = [];
  for (let row = Math.min(box.fromRow, box.toRow); row <= Math.max(box.fromRow, box.toRow); row += 1) {
    for (const segment of tracks[row]?.segments ?? []) if (segment.timeline.start_us < to && end(segment.timeline) > from) out.push(segment.id);
  }
  return out;
}

// ---------- 轨道（D9） ----------

/** 轨道区从上往下画的顺序：列表越靠后越在上层，和剪映、openfilm 一样画在越上面（第一行就是最上层） */
export const trackRows = <T>(tracks: readonly T[]): T[] => [...tracks].reverse();

/** 整条轨道移到最上层（列表最后）或最下层（列表最前）之后的完整顺序；已经在那儿了为 null。 */
export function trackOrderWith(tracks: readonly Pick<EditTrack, "id">[], trackId: string, place: "top" | "bottom"): string[] | null {
  const ids = tracks.map((track) => track.id);
  const index = ids.indexOf(trackId);
  if (index < 0 || (place === "top" ? index === ids.length - 1 : index === 0)) return null;
  const rest = ids.filter((id) => id !== trackId);
  return place === "top" ? [...rest, trackId] : [trackId, ...rest];
}

// ---------- 缩放、画法（1B） ----------

/** 最窄看 1 秒、最宽看成片的四倍；空工程按 30 秒铺 */
const VIEW_MIN_US = US_PER_SECOND;
const VIEW_EMPTY_US = 30 * US_PER_SECOND;

/** 轨道一像素多少微秒的倒数（px/µs）：默认（成片占八成）、最小、最大。照 openfilm 的 timeline-layout。 */
export function zoomRange(durationUs: number, viewPx: number): { fit: number; min: number; max: number } {
  if (!(viewPx > 0)) return { fit: 0, min: 0, max: 0 };
  if (!(durationUs > 0)) { const px = viewPx / VIEW_EMPTY_US; return { fit: px, min: px, max: px }; }
  const min = viewPx / Math.max(durationUs * 4, VIEW_MIN_US);
  const max = Math.max(min, viewPx / VIEW_MIN_US);
  return { fit: clamp((viewPx * ZOOM_DEFAULT) / durationUs, min, max), min, max };
}

/** 缩放后滚到哪：视图里 anchorX 那一点下面的时间不动。 */
export const zoomScroll = (fromPx: number, toPx: number, scrollLeft: number, anchorX: number) =>
  (fromPx > 0 ? ((scrollLeft + anchorX) / fromPx) * toPx - anchorX : 0);

/** 轨道铺多长（µs）：至少一屏；拖动时延长到被拖片段右边再加 max(半屏, 1 秒)，好接着往后拖。 */
export function canvasExtentUs(durationUs: number, viewPx: number, pxPerUs: number, dragReachUs = 0): number {
  const viewUs = pxPerUs > 0 ? viewPx / pxPerUs : 0;
  const base = Math.max(durationUs, viewUs);
  return dragReachUs > 0 ? Math.max(base, dragReachUs + Math.max(viewUs * 0.5, VIEW_MIN_US)) : base;
}

/** 拖到滚动区左右边缘 48px 以内时每帧滚多少像素（越靠外越快），不在边上为 0。 */
export function edgeScrollStep(x: number, left: number, right: number): number {
  if (x < left + EDGE_SCROLL_PX) return -Math.ceil(6 + 18 * Math.min(1, (left + EDGE_SCROLL_PX - x) / EDGE_SCROLL_PX));
  if (x > right - EDGE_SCROLL_PX) return Math.ceil(6 + 18 * Math.min(1, (x - (right - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX));
  return 0;
}

/** 片段在轨道上的像素位置：两头取整到像素，宽度再少画 1px，首尾相接的两段一眼看得出是两段，开头也和刻度对齐。 */
export function clipBox(timeline: EditTimeRange, pxPerUs: number): { left: number; width: number } {
  const left = Math.round(timeline.start_us * pxPerUs);
  return { left, width: Math.max(2, Math.round(end(timeline) * pxPerUs) - left - 1) };
}

/** 裁剪把手宽：最多 8px，最多占片段的四分之一，中间一半永远是挪动区。 */
export const trimHit = (width: number) => Math.min(8, Math.max(2, Math.floor(width / 4)));

/**
 * 同一轨道上首尾相接（屏幕上隔着不到 1px）的边，记成「id:start」「id:end」：这些边的裁剪把手缩回片段里面，
 * 不跨到外面去抢邻居的边。
 */
export function touchingEdges(segments: readonly EditSegment[], pxPerUs: number): Set<string> {
  const sorted = [...segments].sort((a, b) => a.timeline.start_us - b.timeline.start_us);
  const out = new Set<string>();
  for (let index = 1; index < sorted.length; index += 1) {
    const before = sorted[index - 1]!;
    const after = sorted[index]!;
    if ((after.timeline.start_us - end(before.timeline)) * pxPerUs <= 1) out.add(`${before.id}:end`).add(`${after.id}:start`);
  }
  return out;
}

/** fromPx..toPx（轨道内的横坐标）范围里的刻度，间隔至少 64px。 */
export function visibleTicks(pxPerUs: number, fromPx: number, toPx: number, extentUs: number): Array<{ us: number; x: number; label: string }> {
  if (!(pxPerUs > 0)) return [];
  const step = pickTickStep(pxPerUs * US_PER_SECOND);
  const stepUs = Math.round(step * US_PER_SECOND);
  const ticks: Array<{ us: number; x: number; label: string }> = [];
  const last = Math.min(extentUs, toPx / pxPerUs);
  for (let us = Math.max(0, Math.floor(fromPx / pxPerUs / stepUs)) * stepUs; us <= last; us += stepUs) ticks.push({ us, x: us * pxPerUs, label: formatTick(us, step) });
  return ticks;
}

// ---------- 拖动时的数值提示（A6） ----------

const secondsText = (us: number) => (us / US_PER_SECOND).toFixed(2);

export const moveTip = (startUs: number, copy = false) => (copy ? `复制到 ${secondsText(startUs)} 秒` : `${secondsText(startUs)} 秒开始`);

export function trimTip(beforeUs: number, afterUs: number, sourceEnd: boolean, floorHit: string | null = null): string {
  const change = afterUs - beforeUs;
  const head = Math.abs(change) < 5_000 ? `现在 ${secondsText(afterUs)} 秒` : `${change < 0 ? "缩短" : "拉长"} ${secondsText(Math.abs(change))} 秒 · 现在 ${secondsText(afterUs)} 秒`;
  return floorHit ? `${head} · 再短就放不下${floorHit}了` : sourceEnd ? `${head} · 素材到头了` : head;
}
