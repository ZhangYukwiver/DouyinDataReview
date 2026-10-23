import { MAX_BATCH_EDITS, type EditProject, type EditTimeRange, type EditTrack } from "../../services/aiEdit";
import type { BoardEdit } from "./aiEditBoardContext";
import { US_PER_SECOND } from "./aiEditModel";

// 主轨磁吸和联动（时间线工具栏的两个开关），规则照 openfilm（studio/ui/src/lib/timeline-edit.ts 的 mainTrackOf、ridesOn、carry、
// planRemove / planMove / planRippleTrim、planCloseMainGaps），MIT License，Copyright (c) 2026 OpenFilm contributors。
// 采集器没有主轨和联动的概念，这里先在前端把每段最后落在哪算好，再排成一串能逐条执行的 move_clip / update_clip / delete_clip /
// duplicate_clip：采集器一条条查重叠，排不开（两段换位置）时先把挡路的挪到时间线最后面的空处暂放，再挪到位。

/** 起点差 1 毫秒内也算落在主轨片段里 */
const TOUCH_US = 1_000;
/** 暂放的片段之间、和最后一段之间空一点，免得首尾相接被当成重叠 */
const PARK_GAP_US = 1_000_000;

const end = (range: EditTimeRange) => range.start_us + range.duration_us;
const seconds = (us: number) => us / US_PER_SECOND;

/** 主轨：最下面那条视频轨（列表里第一条视频轨，字幕轨不算）。没有视频轨是 null。 */
export function mainTrackOf(project: Pick<EditProject, "tracks"> | null | undefined): EditTrack | null {
  return project?.tracks.find((track) => track.track_type === "video" && track.kind !== "subtitle") ?? null;
}

/**
 * 跟着主轨片段走的片段（联动）：别的轨道上开头落在某段主轨片段里、跨过的主轨剪切点不超过一个的（字幕、贴纸、画中画、音效跟着走，
 * 横跨好几个镜头的背景音乐不跟）。回 主轨片段 id → 跟着它的片段 id。
 */
export function ridersOf(project: Pick<EditProject, "tracks"> | null | undefined, main: EditTrack | null = mainTrackOf(project)): Map<string, string[]> {
  const riders = new Map<string, string[]>();
  if (!main) return riders;
  const cuts = [...new Set(main.segments.flatMap((segment) => [segment.timeline.start_us, end(segment.timeline)]))];
  for (const track of project?.tracks ?? []) {
    if (track.id === main.id) continue;
    for (const segment of track.segments) {
      const start = segment.timeline.start_us;
      const host = main.segments.find((one) => one.timeline.start_us - TOUCH_US <= start && start < end(one.timeline));
      if (!host) continue;
      const crossed = cuts.filter((cut) => cut > start + TOUCH_US && cut < end(segment.timeline) - TOUCH_US).length;
      if (crossed > 1) continue;
      riders.set(host.id, [...(riders.get(host.id) ?? []), segment.id]);
    }
  }
  return riders;
}

export type RippleIntent =
  /** 打开磁吸：主轨上的空隙一次合拢 */
  | { kind: "pack" }
  | { kind: "delete"; ids: readonly string[] }
  /** 拖着挪（不是复制）：每段落到哪条轨道、什么时候开始；hand_us 是松手时手在哪（磁吸插进主轨按它定插在哪两段之间） */
  | { kind: "move"; items: ReadonlyArray<{ id: string; trackId: string; start_us: number }>; hand_us?: number }
  /** 裁剪：裁完的时间和截取；args 是普通裁剪要发的 update_clip 参数（秒） */
  | { kind: "trim"; id: string; timeline: EditTimeRange; source: EditTimeRange | null; args: Record<string, unknown> }
  /** ⌥ 拖、粘贴复制：从哪段复制、放到哪条轨道的什么时候 */
  | { kind: "copy"; items: ReadonlyArray<{ id: string; trackId: string; start_us: number }>; hand_us?: number };

export interface RipplePlan {
  edits: BoardEdit[];
  /** 撤销按钮上的说法 */
  label: string;
  /** 跟着主轨片段挪了或删了几段 */
  carried: number;
  /** 本该跟着走、但那里放不下而留在原处的几段 */
  stuck: number;
}

interface Place { trackId: string; start: number; duration: number }

/**
 * 磁吸 / 联动打开时，一次改动牵动主轨和跟着它的片段要发的整串改动。改动不碰主轨、两个开关都没起作用时是 null（照普通的做）；
 * 步数超过一批的上限时是 refused。
 */
export function rippleEdits(
  project: Pick<EditProject, "tracks"> | null | undefined,
  intent: RippleIntent,
  prefs: { magnet: boolean; linkage: boolean },
): RipplePlan | { refused: string } | null {
  const main = mainTrackOf(project);
  if (!project || !main) return null;
  const trackOf = new Map<string, EditTrack>();
  const now = new Map<string, Place>();
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      trackOf.set(segment.id, track);
      now.set(segment.id, { trackId: track.id, start: segment.timeline.start_us, duration: segment.timeline.duration_us });
    }
  }
  const onMain = (id: string) => trackOf.get(id)?.id === main.id;
  const touched = intent.kind === "pack" ? true
    : intent.kind === "delete" ? intent.ids.some(onMain)
      : intent.kind === "trim" ? onMain(intent.id)
        : intent.items.some((item) => onMain(item.id) || item.trackId === main.id);
  const magnet = prefs.magnet && touched;
  // 联动管主轨片段被挪、被删、被裁、合拢（跟着的随它走）；复制出来的还不是宿主，不带跟着的，只有磁吸把主轨片段挤开了才有得跟
  const linkage = prefs.linkage && touched && (intent.kind !== "copy" || magnet);
  if (!magnet && !linkage) return null;

  const final = new Map([...now].map(([id, place]) => [id, { ...place }]));
  const deleted = new Set<string>();
  const explicit = new Set<string>();
  // 复制出来的还不存在：先按占位算，最后才发 duplicate_clip
  const copies: Array<{ key: string; from: string; place: Place }> = [];
  if (intent.kind === "delete") for (const id of intent.ids) { deleted.add(id); explicit.add(id); }
  if (intent.kind === "move") {
    for (const item of intent.items) {
      const place = final.get(item.id);
      if (place) Object.assign(place, { trackId: item.trackId, start: item.start_us });
      explicit.add(item.id);
    }
  }
  if (intent.kind === "trim") {
    const place = final.get(intent.id);
    if (place) Object.assign(place, { start: intent.timeline.start_us, duration: intent.timeline.duration_us });
    explicit.add(intent.id);
  }
  if (intent.kind === "copy") {
    intent.items.forEach((item, index) => {
      const from = now.get(item.id);
      if (from) copies.push({ key: `copy:${index}`, from: item.id, place: { trackId: item.trackId, start: item.start_us, duration: from.duration } });
    });
  }

  // ---- 磁吸：主轨按顺序首尾相接，从 0 开始 ----
  if (magnet) {
    const all = new Map<string, Place>([...final, ...copies.map((copy) => [copy.key, copy.place] as const)]);
    const arriving = new Set<string>([
      ...(intent.kind === "move" ? intent.items.filter((item) => item.trackId === main.id).map((item) => item.id) : []),
      ...copies.filter((copy) => copy.place.trackId === main.id).map((copy) => copy.key),
    ]);
    // 留在主轨上的按原来的先后排；挪进来的按落点先后连成一整块插一次：手落在某段前半截插到它前面，后半截插到后面
    const staying = [...all].filter(([id, place]) => place.trackId === main.id && !deleted.has(id) && !arriving.has(id))
      .sort(([a], [b]) => now.get(a)!.start - now.get(b)!.start).map(([id]) => id);
    const block = [...arriving].sort((a, b) => all.get(a)!.start - all.get(b)!.start);
    const hand = (intent.kind === "move" || intent.kind === "copy") && intent.hand_us !== undefined ? intent.hand_us : block.length ? all.get(block[0]!)!.start : 0;
    const before = staying.filter((other) => now.get(other)!.start + now.get(other)!.duration / 2 <= hand).length;
    const order = [...staying.slice(0, before), ...block, ...staying.slice(before)];
    let cursor = 0;
    for (const id of order) {
      const place = all.get(id)!;
      place.start = cursor;
      cursor += place.duration;
    }
  }

  // ---- 联动：跟着的片段跟着主轨片段上的那一刻走 ----
  let carried = 0;
  let stuck = 0;
  if (linkage) {
    for (const [hostId, riders] of ridersOf(project, main)) {
      const free = riders.filter((id) => !explicit.has(id) && !deleted.has(id));
      if (!free.length) continue;
      if (deleted.has(hostId)) {
        for (const id of free) { deleted.add(id); carried += 1; }
        continue;
      }
      const was = now.get(hostId)!;
      const is = final.get(hostId)!;
      // 裁开头时画面里那一刻在片段里往前挪了多少（时间线微秒）：有截取的看截取的变化，没有截取的（图片）就是开头挪了多少
      const host = main.segments.find((one) => one.id === hostId);
      const speed = host && "speed" in host && host.speed > 0 ? host.speed : 1;
      const oldSource = host && "source" in host && host.source ? host.source.start_us : null;
      const trimmed = intent.kind === "trim" && intent.id === hostId ? intent : null;
      const headShift = !trimmed ? 0 : trimmed.source && oldSource !== null ? (trimmed.source.start_us - oldSource) / speed : trimmed.timeline.start_us - was.start;
      for (const id of free) {
        const rider = final.get(id)!;
        const at = is.start + (now.get(id)!.start - was.start) - headShift;
        // 那一刻被裁掉了：留在原处
        if (at < is.start - TOUCH_US || at >= is.start + is.duration) continue;
        if (Math.round(at) === rider.start) continue;
        rider.start = Math.max(0, Math.round(at));
        carried += 1;
      }
    }
    // 跟着挪过去压到别的片段（含复制出来的）的，留在原处（字幕轨采集器不查重叠，这里照样查：两句字幕叠在一起没法看）。
    // 留回原处可能又压到别的跟着挪的，查到不再有变化为止；原来的排布不重叠，所以一定停得下来
    const taken = () => [...final, ...copies.map((copy) => [copy.key, copy.place] as const)];
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, place] of final) {
        if (explicit.has(id) || deleted.has(id) || trackOf.get(id)?.id === main.id || place.start === now.get(id)!.start) continue;
        const clash = taken().some(([other, there]) => other !== id && !deleted.has(other) && there.trackId === place.trackId
          && place.start < there.start + there.duration && there.start < place.start + place.duration);
        if (clash || place.start < 0) { place.start = now.get(id)!.start; carried -= 1; stuck += 1; changed = true; }
      }
    }
  }

  // ---- 排成能逐条执行的改动 ----
  const edits: BoardEdit[] = [...deleted].filter((id) => now.has(id)).map((id) => ({ name: "delete_clip" as const, arguments: { clip_id: id } }));
  const current = new Map([...now].filter(([id]) => !deleted.has(id)).map(([id, place]) => [id, { ...place }]));
  const subtitle = new Set(project.tracks.filter((track) => track.kind === "subtitle").map((track) => track.id));
  const fits = (id: string, place: Place) => subtitle.has(place.trackId) || ![...current].some(([other, there]) => other !== id && there.trackId === place.trackId
    && place.start < there.start + there.duration && there.start < place.start + place.duration);
  const trimId = intent.kind === "trim" ? intent.id : null;
  const pending = [...final].filter(([id, place]) => {
    if (deleted.has(id)) return false;
    const was = now.get(id)!;
    return place.trackId !== was.trackId || place.start !== was.start || place.duration !== was.duration;
  });
  const editFor = (id: string, place: Place): BoardEdit => (id === trimId && intent.kind === "trim"
    ? { name: "update_clip", arguments: { ...intent.args, start: seconds(place.start) } }
    : { name: "move_clip", arguments: { clip_id: id, start: seconds(place.start), ...(place.trackId !== now.get(id)!.trackId ? { track_id: place.trackId } : {}) } });
  const parkFrom = Math.max(0, ...[...current.values(), ...final.values(), ...copies.map((copy) => copy.place)].map((place) => place.start + place.duration)) + PARK_GAP_US;
  let park = parkFrom;
  const tooMany = () => ({ refused: `这一下要挪 ${edits.length} 步，超过一次能改的 ${MAX_BATCH_EDITS} 步，先关掉主轨磁吸或联动再改` });
  while (pending.length) {
    if (edits.length > MAX_BATCH_EDITS) return tooMany();
    // 往前挪的从前往后、往后挪的从后往前，能直接落下的先落
    pending.sort(([a, pa], [b, pb]) => {
      const da = pa.start - now.get(a)!.start;
      const db = pb.start - now.get(b)!.start;
      return da <= 0 && db <= 0 ? pa.start - pb.start : da > 0 && db > 0 ? pb.start - pa.start : da <= 0 ? -1 : 1;
    });
    const index = pending.findIndex(([id, place]) => fits(id, place));
    if (index >= 0) {
      const [[id, place]] = pending.splice(index, 1) as [[string, Place]];
      edits.push(editFor(id, place));
      current.set(id, { ...place });
      continue;
    }
    // 互相挡着：挑一段挡着别的落位、还没暂放过的，先挪到最后面暂放（还在原来的轨道上），腾出地方。
    // 暂放处在所有落点后面，放过去就不再挡谁，每段最多暂放一次；挑不出来就是被不动的片段挡着，排不开
    const blocker = pending.find(([id]) => {
      const here = current.get(id)!;
      return here.start < parkFrom && pending.some(([other, target]) => other !== id && target.trackId === here.trackId
        && target.start < here.start + here.duration && here.start < target.start + target.duration);
    });
    if (!blocker) return { refused: "这一下排不开，先关掉主轨磁吸或联动再改" };
    const [id] = blocker;
    const here = current.get(id)!;
    edits.push({ name: "move_clip", arguments: { clip_id: id, start: seconds(park) } });
    current.set(id, { ...here, start: park });
    park += here.duration + PARK_GAP_US;
  }
  for (const copy of copies) {
    edits.push({ name: "duplicate_clip", arguments: { clip_id: copy.from, start: seconds(copy.place.start), ...(copy.place.trackId !== now.get(copy.from)!.trackId ? { track_id: copy.place.trackId } : {}) } });
  }
  if (edits.length > MAX_BATCH_EDITS) return tooMany();
  const label = intent.kind === "pack" ? "合拢了主轨"
    : intent.kind === "delete" ? `删了 ${intent.ids.length} 段${magnet ? "并合拢主轨" : ""}`
      : intent.kind === "trim" ? (magnet ? "波纹裁剪" : "裁剪")
        : intent.kind === "copy" ? `插入了 ${intent.items.length} 段`
          : magnet ? "在主轨上重排" : `挪动了 ${intent.items.length} 段`;
  return { edits, label: carried > 0 ? `${label}（联动 ${carried} 段）` : label, carried, stuck };
}
