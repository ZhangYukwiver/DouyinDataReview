import { describe, expect, it } from "vitest";

import type { EditProject, EditSegment, EditTrack } from "../../services/aiEdit";
import type { BoardEdit } from "./aiEditBoardContext";
import { mainTrackOf, rippleEdits, ridersOf } from "./aiEditTimelineMagnet";

const S = 1_000_000;
const clip = (id: string, start: number, duration: number, extra: Partial<EditSegment> = {}): EditSegment => ({
  id, kind: "video", path: `/m/${id}.mp4`, timeline: { start_us: start * S, duration_us: duration * S },
  source: { start_us: 0, duration_us: duration * S }, speed: 1, volume: 1, ...extra,
} as EditSegment);
const track = (id: string, segments: EditSegment[], extra: Partial<EditTrack> = {}): EditTrack => ({ id, track_type: "video", name: id, mute: false, segments, ...extra } as EditTrack);
const project = (tracks: EditTrack[]): Pick<EditProject, "tracks"> => ({ tracks });

/** 把改动一条条套到工程上，每一步都查同轨重叠（字幕轨不查），和采集器一样 */
function replay(base: Pick<EditProject, "tracks">, edits: readonly BoardEdit[]) {
  const tracks = base.tracks.map((one) => ({ ...one, segments: one.segments.map((segment) => ({ ...segment, timeline: { ...segment.timeline } })) }));
  const find = (id: string) => { for (const one of tracks) { const segment = one.segments.find((item) => item.id === id); if (segment) return { track: one, segment }; } throw new Error(`no ${id}`); };
  const check = (one: (typeof tracks)[number]) => {
    if (one.kind === "subtitle") return;
    const sorted = [...one.segments].sort((a, b) => a.timeline.start_us - b.timeline.start_us);
    sorted.forEach((segment, index) => {
      const next = sorted[index + 1];
      if (next && segment.timeline.start_us + segment.timeline.duration_us > next.timeline.start_us) throw new Error(`overlap ${segment.id}/${next.id} on ${one.id}`);
    });
  };
  let copies = 0;
  for (const { name, arguments: args } of edits) {
    const id = String(args.clip_id);
    if (name === "delete_clip") { const { track: from } = find(id); from.segments = from.segments.filter((item) => item.id !== id); continue; }
    if (name === "duplicate_clip") {
      const { segment, track: from } = find(id);
      const to = args.track_id ? tracks.find((item) => item.id === args.track_id)! : from;
      copies += 1;
      to.segments.push({ ...segment, id: `${id}-copy${copies}`, timeline: { start_us: Math.round(Number(args.start) * S), duration_us: segment.timeline.duration_us } });
      check(to);
      continue;
    }
    const { segment, track: from } = find(id);
    if (name === "update_clip") {
      segment.timeline = { start_us: Math.round(Number(args.start) * S), duration_us: Math.round(Number(args.duration) * S) };
      check(from);
      continue;
    }
    if (name !== "move_clip") throw new Error(name);
    segment.timeline.start_us = Math.round(Number(args.start) * S);
    if (args.track_id) {
      from.segments = from.segments.filter((item) => item.id !== id);
      const to = tracks.find((item) => item.id === args.track_id)!;
      to.segments.push(segment);
      check(to);
    } else check(from);
  }
  const layout = Object.fromEntries(tracks.map((one) => [one.id, [...one.segments].sort((a, b) => a.timeline.start_us - b.timeline.start_us).map((segment) => [segment.id, segment.timeline.start_us / S, segment.timeline.duration_us / S])]));
  return layout;
}

const plan = (base: Pick<EditProject, "tracks">, ...args: Parameters<typeof rippleEdits> extends [unknown, ...infer R] ? R : never) => {
  const result = rippleEdits(base, ...args);
  if (!result || "refused" in result) throw new Error(`no plan: ${JSON.stringify(result)}`);
  return result;
};

describe("main track magnet and linkage", () => {
  // 主轨：a 0–2、空 1 秒、b 3–5、c 5–6；上面一条字幕跟着 b，一条背景乐横跨全片
  const base = () => project([
    track("main", [clip("a", 0, 2), clip("b", 3, 2), clip("c", 5, 1)]),
    track("pip", [clip("p", 3.5, 1)]),
    track("music", [clip("bgm", 0, 6, { kind: "audio" } as Partial<EditSegment>)], { track_type: "audio" }),
    track("subs", [clip("s1", 3.2, 1, { kind: "text" } as Partial<EditSegment>)], { kind: "subtitle", track_type: "text" }),
  ]);

  it("finds the main track and what rides on its clips", () => {
    expect(mainTrackOf(base())?.id).toBe("main");
    expect(mainTrackOf(project([track("t", [], { track_type: "text" })]))).toBeNull();
    // 背景乐跨过好几个剪切点，不跟；画中画和字幕开头落在 b 里，跟 b
    expect(Object.fromEntries(ridersOf(base()))).toEqual({ b: ["p", "s1"] });
  });

  it("closes the main track's gaps when the magnet is turned on, carrying riders", () => {
    const result = plan(base(), { kind: "pack" }, { magnet: true, linkage: true });
    expect(result.label).toBe("合拢了主轨（联动 2 段）");
    // b 往前挪了 1 秒，跟着它的画中画和字幕也挪 1 秒；横跨全片的背景乐不动
    expect(replay(base(), result.edits)).toEqual({ main: [["a", 0, 2], ["b", 2, 2], ["c", 4, 1]], pip: [["p", 2.5, 1]], music: [["bgm", 0, 6]], subs: [["s1", 2.2, 1]] });
    expect(plan(base(), { kind: "pack" }, { magnet: true, linkage: false }).label).toBe("合拢了主轨");
  });

  it("ripples a delete on the main track and deletes what rides on it", () => {
    const result = plan(base(), { kind: "delete", ids: ["a"] }, { magnet: true, linkage: true });
    const after = replay(base(), result.edits);
    expect(after.main).toEqual([["b", 0, 2], ["c", 2, 1]]);
    // b 往前挪了 3 秒，跟着它的画中画和字幕也挪 3 秒；背景乐不动
    expect(after.pip).toEqual([["p", 0.5, 1]]);
    expect(after.subs).toEqual([["s1", 0.2, 1]]);
    expect(after.music).toEqual([["bgm", 0, 6]]);
    expect(result.label).toBe("删了 1 段并合拢主轨（联动 2 段）");

    const gone = replay(base(), plan(base(), { kind: "delete", ids: ["b"] }, { magnet: false, linkage: true }).edits);
    expect(gone).toMatchObject({ main: [["a", 0, 2], ["c", 5, 1]], pip: [], subs: [] });
    // 不碰主轨、两个开关都关：照普通的做
    expect(rippleEdits(base(), { kind: "delete", ids: ["p"] }, { magnet: true, linkage: true })).toBeNull();
    expect(rippleEdits(base(), { kind: "delete", ids: ["a"] }, { magnet: false, linkage: false })).toBeNull();
  });

  it("reorders on the main track by where the clip is dropped, parking clips that block each other", () => {
    const packed = () => project([track("main", [clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 1)])]);
    // c 拖到 a 的前半截：插到最前面
    const first = plan(packed(), { kind: "move", items: [{ id: "c", trackId: "main", start_us: 0.5 * S }] }, { magnet: true, linkage: false });
    expect(replay(packed(), first.edits).main).toEqual([["c", 0, 1], ["a", 1, 2], ["b", 3, 2]]);
    // a 拖到 b 的后半截：换到 b 后面（两段互相挡着，要先暂放）
    const swap = plan(packed(), { kind: "move", items: [{ id: "a", trackId: "main", start_us: 3.5 * S }] }, { magnet: true, linkage: false });
    expect(replay(packed(), swap.edits).main).toEqual([["b", 0, 2], ["a", 2, 2], ["c", 4, 1]]);
    expect(swap.label).toBe("在主轨上重排");
  });

  it("parks only clips that block another, so uneven reorders finish", () => {
    // a 拖过 c：三段长短不一，以前总是暂放排在最前的 b，一直挪不完
    const three = () => project([track("main", [clip("a", 0, 1.5), clip("b", 1.5, 1), clip("c", 2.5, 1)])]);
    const past = plan(three(), { kind: "move", items: [{ id: "a", trackId: "main", start_us: 3.2 * S }] }, { magnet: true, linkage: false });
    expect(replay(three(), past.edits).main).toEqual([["b", 0, 1], ["c", 1, 1], ["a", 2, 1.5]]);
    // 选中 b、c 一起拖到最前面
    const four = () => project([track("main", [clip("a", 0, 3), clip("b", 3, 0.5), clip("c", 3.5, 1), clip("d", 4.5, 2.5)])]);
    const front = plan(four(), { kind: "move", items: [{ id: "b", trackId: "main", start_us: 0 }, { id: "c", trackId: "main", start_us: 0.5 * S }] }, { magnet: true, linkage: false });
    expect(replay(four(), front.edits).main).toEqual([["b", 0, 0.5], ["c", 0.5, 1], ["a", 1.5, 3], ["d", 4.5, 2.5]]);
  });

  it("inserts a group drag as one block where the hand is", () => {
    const packed = () => project([track("main", [clip("a", 0, 1), clip("b", 1, 1), clip("c", 2, 2), clip("d", 4, 2)])]);
    // a、b 一起往后拖 2.5 秒，手在 b 上（3.7 秒，过了 c 的中点）：两段连在一起插到 c 后面
    const result = plan(packed(), { kind: "move", items: [{ id: "a", trackId: "main", start_us: 2.5 * S }, { id: "b", trackId: "main", start_us: 3.5 * S }], hand_us: 3.7 * S }, { magnet: true, linkage: false });
    expect(replay(packed(), result.edits).main).toEqual([["c", 0, 2], ["a", 2, 1], ["b", 3, 1], ["d", 4, 2]]);
  });

  it("keeps riders where they were when putting one back makes another clash", () => {
    // b 往后挪 2 秒：p1、p2 都跟着 b；p2 会压到 w 留下，p1 再挪就压到留下的 p2，也留下
    const base = () => project([track("main", [clip("b", 0, 3)]), track("pip", [clip("p1", 0, 1), clip("p2", 2, 0.8), clip("w", 4.5, 1.5)])]);
    const result = plan(base(), { kind: "move", items: [{ id: "b", trackId: "main", start_us: 2 * S }] }, { magnet: false, linkage: true });
    expect(result.stuck).toBe(2);
    expect(replay(base(), result.edits)).toEqual({ main: [["b", 2, 3]], pip: [["p1", 0, 1], ["p2", 2, 0.8], ["w", 4.5, 1.5]] });
  });

  it("carries the riders of main clips a copy pushes out", () => {
    const base = () => project([track("main", [clip("a", 0, 2), clip("b", 2, 2)]), track("subs", [clip("s", 2.5, 1, { kind: "text" } as Partial<EditSegment>)], { kind: "subtitle", track_type: "text" })]);
    const result = plan(base(), { kind: "copy", items: [{ id: "a", trackId: "main", start_us: 0.2 * S }], hand_us: 0.5 * S }, { magnet: true, linkage: true });
    expect(replay(base(), result.edits)).toEqual({ main: [["a-copy1", 0, 2], ["a", 2, 2], ["b", 4, 2]], subs: [["s", 4.5, 1]] });
    // 不开磁吸：复制不挤开谁，联动没事可做
    expect(rippleEdits(base(), { kind: "copy", items: [{ id: "a", trackId: "main", start_us: 5 * S }] }, { magnet: false, linkage: true })).toBeNull();
  });

  it("keeps riders in place when the head of an image on the main track is trimmed", () => {
    const base = () => project([track("main", [clip("img", 2, 4, { kind: "image", source: undefined } as Partial<EditSegment>)]), track("pip", [clip("r", 3, 1)])]);
    const result = plan(base(), { kind: "trim", id: "img", timeline: { start_us: 3 * S, duration_us: 3 * S }, source: null, args: { clip_id: "img", start: 3, duration: 3 } }, { magnet: false, linkage: true });
    expect(replay(base(), result.edits)).toEqual({ main: [["img", 3, 3]], pip: [["r", 3, 1]] });
    expect(result.carried).toBe(0);
  });

  it("takes clips moved off the main track out of the row and closes the hole", () => {
    const two = () => project([track("main", [clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 1)]), track("over", [])]);
    const result = plan(two(), { kind: "move", items: [{ id: "b", trackId: "over", start_us: 1 * S }] }, { magnet: true, linkage: false });
    expect(replay(two(), result.edits)).toEqual({ main: [["a", 0, 2], ["c", 2, 1]], over: [["b", 1, 2]] });
  });

  it("ripple-trims: shortening pulls the rest in, lengthening pushes it out", () => {
    const packed = () => project([track("main", [clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 1)]), track("pip", [clip("p", 2.5, 1)])]);
    const shorter = plan(packed(), { kind: "trim", id: "a", timeline: { start_us: 0, duration_us: 1 * S }, source: { start_us: 0, duration_us: 1 * S }, args: { clip_id: "a", start: 0, duration: 1, source_start: 0, source_duration: 1, speed: 1 } }, { magnet: true, linkage: true });
    expect(replay(packed(), shorter.edits)).toEqual({ main: [["a", 0, 1], ["b", 1, 2], ["c", 3, 1]], pip: [["p", 1.5, 1]] });
    expect(shorter.label).toBe("波纹裁剪（联动 1 段）");
    const longer = plan(packed(), { kind: "trim", id: "a", timeline: { start_us: 0, duration_us: 3 * S }, source: { start_us: 0, duration_us: 3 * S }, args: { clip_id: "a", start: 0, duration: 3, source_start: 0, source_duration: 3, speed: 1 } }, { magnet: true, linkage: false });
    expect(replay(packed(), longer.edits).main).toEqual([["a", 0, 3], ["b", 3, 2], ["c", 5, 1]]);
    // 裁掉开头：开头还在原地，截取往后挪，跟着的片段按画面里那一刻往前挪
    const head = plan(packed(), {
      kind: "trim", id: "b", timeline: { start_us: 2.5 * S, duration_us: 1.5 * S }, source: { start_us: 0.5 * S, duration_us: 1.5 * S },
      args: { clip_id: "b", start: 2.5, duration: 1.5, source_start: 0.5, source_duration: 1.5, speed: 1 },
    }, { magnet: true, linkage: true });
    expect(replay(packed(), head.edits)).toEqual({ main: [["a", 0, 2], ["b", 2, 1.5], ["c", 3.5, 1]], pip: [["p", 2, 1]] });
  });

  it("inserts copies dropped on the main track, pushing the rest out", () => {
    const packed = () => project([track("main", [clip("a", 0, 2), clip("b", 2, 2)])]);
    const result = plan(packed(), { kind: "copy", items: [{ id: "b", trackId: "main", start_us: 0.2 * S }] }, { magnet: true, linkage: true });
    expect(replay(packed(), result.edits).main).toEqual([["b-copy1", 0, 2], ["a", 2, 2], ["b", 4, 2]]);
    expect(result.edits.at(-1)).toEqual({ name: "duplicate_clip", arguments: { clip_id: "b", start: 0 } });
  });

  it("leaves riders in place when following would land on another clip", () => {
    const crowded = () => project([track("main", [clip("a", 0, 2), clip("b", 3, 2)]), track("pip", [clip("x", 0.5, 1), clip("p", 3.2, 1)])]);
    const result = plan(crowded(), { kind: "delete", ids: ["a"] }, { magnet: true, linkage: true });
    // a 被删、x 跟着删；p 跟着 b 挪到 0.2，原来那里已经空了
    expect(replay(crowded(), result.edits)).toEqual({ main: [["b", 0, 2]], pip: [["p", 0.2, 1]] });
    const blocked = () => project([track("main", [clip("a", 0, 2), clip("b", 3, 2)]), track("pip", [clip("y", 0, 0.5), clip("p", 3.2, 1)])]);
    // y 开头和 a 一样、算跟着 a；不删 a，只是把 b 往前合拢：p 想挪到 2.2，那里空着，照挪
    const packedPlan = plan(blocked(), { kind: "move", items: [{ id: "b", trackId: "main", start_us: 2 * S }] }, { magnet: false, linkage: true });
    expect(replay(blocked(), packedPlan.edits).pip).toEqual([["y", 0, 0.5], ["p", 2.2, 1]]);
    const wall = () => project([track("main", [clip("a", 0, 2), clip("b", 3, 2)]), track("pip", [clip("w", 2, 0.6), clip("p", 3.2, 1)])]);
    const stuck = plan(wall(), { kind: "move", items: [{ id: "b", trackId: "main", start_us: 2 * S }] }, { magnet: false, linkage: true });
    expect(stuck.stuck).toBe(1);
    expect(replay(wall(), stuck.edits).pip).toEqual([["w", 2, 0.6], ["p", 3.2, 1]]);
    // 字幕轨采集器不查重叠，这里照样不让两句字幕叠在一起
    const lines = () => project([track("main", [clip("a", 0, 2), clip("b", 3, 2)]), track("subs", [clip("free", 2, 1, { kind: "text" } as Partial<EditSegment>), clip("rides", 3.2, 1, { kind: "text" } as Partial<EditSegment>)], { kind: "subtitle", track_type: "text" })]);
    const kept = plan(lines(), { kind: "move", items: [{ id: "b", trackId: "main", start_us: 2 * S }] }, { magnet: false, linkage: true });
    expect(kept.stuck).toBe(1);
    expect(replay(lines(), kept.edits).subs).toEqual([["free", 2, 1], ["rides", 3.2, 1]]);
  });

  it("refuses when the plan needs more steps than one batch allows", () => {
    const many = project([track("main", Array.from({ length: 250 }, (_, index) => clip(`c${index}`, index * 2, 1)))]);
    expect(rippleEdits(many, { kind: "pack" }, { magnet: true, linkage: false })).toEqual({ refused: expect.stringContaining("超过一次能改的 200 步") });
  });
});
