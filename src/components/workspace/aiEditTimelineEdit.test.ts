import { describe, expect, it } from "vitest";

import type { EditMediaSegment, EditProject, EditSegment, EditTextSegment, EditTrack } from "../../services/aiEdit";
import type { BoardEdit } from "./aiEditBoardContext";
import {
  canvasExtentUs, clipBox, edgeScrollStep, marqueeHits, moveEdits, moveOrder, moveTip, nudgeDelta, nudgeStep, placeMove, planDuplicate, planMove, planPaste, planTrim,
  snapTargetsOf, snapTo, toFrame, touchingEdges, trackOrderWith, trackRefusal, trackRows, trimHit, trimTip, trimToPlayhead, visibleTicks, zoomRange, zoomScroll,
} from "./aiEditTimelineEdit";

const S = 1_000_000;
const FRAME = S / 30;

function video(id: string, start: number, duration: number, extra: Partial<EditMediaSegment> = {}): EditMediaSegment {
  return { id, kind: "video", path: `/m/${id}.mp4`, timeline: { start_us: start, duration_us: duration }, source: { start_us: 0, duration_us: duration }, volume: 1, speed: 1, ...extra };
}
const audio = (id: string, start: number, duration: number): EditMediaSegment => ({ ...video(id, start, duration), kind: "audio", path: `/m/${id}.mp3` });
const text = (id: string, start: number, duration: number): EditTextSegment => ({ id, kind: "text", text: "标题", timeline: { start_us: start, duration_us: duration } });
const track = (id: string, track_type: EditTrack["track_type"], segments: EditSegment[], extra: Partial<EditTrack> = {}): EditTrack => ({ id, track_type, name: id, mute: false, segments, ...extra });
const project = (tracks: EditTrack[], markers: EditProject["markers"] = []): Pick<EditProject, "tracks" | "markers"> => ({ tracks, markers });
const range = (start: number, duration: number) => ({ start_us: start, duration_us: duration });

// 一像素 1 万微秒：吸附范围 6 像素 = 6 万微秒
const REACH = 60_000;
const spec = (ids: string[], deltaUs: number, extra: Partial<Parameters<typeof planMove>[1]> = {}) =>
  ({ ids, lead: ids[0]!, deltaUs, rowDelta: 0, playheadUs: null, reachUs: REACH, frameUs: FRAME, ...extra });

/** 照采集器逐条执行 move_clip：每条都和目标轨道上此刻的别的片段查重叠（首尾相接不算），压到就停在第几步 */
function runMoves(tracks: readonly EditTrack[], edits: readonly BoardEdit[]): number | null {
  const lanes = new Map(tracks.map((one) => [one.id, one.segments.map((segment) => ({ id: segment.id, start: segment.timeline.start_us, stop: segment.timeline.start_us + segment.timeline.duration_us }))]));
  for (const [index, edit] of edits.entries()) {
    const args = edit.arguments as { clip_id: string; start: number; track_id?: string };
    const [fromId, from] = [...lanes].find(([, list]) => list.some((one) => one.id === args.clip_id))!;
    const clip = from.find((one) => one.id === args.clip_id)!;
    const start = Math.round(args.start * S);
    const stop = start + clip.stop - clip.start;
    const to = lanes.get(args.track_id ?? fromId)!;
    if (to.some((other) => other.id !== clip.id && start < other.stop && other.start < stop)) return index + 1;
    from.splice(from.indexOf(clip), 1);
    to.push({ id: clip.id, start, stop });
  }
  return null;
}

describe("落点和邻居：差一点推到贴住，差得多就拒绝", () => {
  const neighbors = [range(0, 2 * S), range(5 * S, 2 * S)];
  it("没压到邻居就原样", () => {
    expect(placeMove(2.5 * S, S, neighbors, REACH)).toEqual({ start: 2.5 * S, snappedUs: null, refused: false });
    // 首尾正好相接不算压
    expect(placeMove(2 * S, 3 * S, neighbors, REACH).refused).toBe(false);
  });
  it("压到前一段尾巴一点点：往右推到贴住", () => {
    expect(placeMove(2 * S - 30_000, S, neighbors, REACH)).toEqual({ start: 2 * S, snappedUs: 2 * S, refused: false });
  });
  it("压到后一段开头一点点：往左推到贴住", () => {
    expect(placeMove(4 * S + 40_000, S, neighbors, REACH)).toEqual({ start: 4 * S, snappedUs: 5 * S, refused: false });
  });
  it("压得多就拒绝", () => {
    expect(placeMove(1.5 * S, S, neighbors, REACH).refused).toBe(true);
  });
  it("推过去还压着（两段之间放不下）也拒绝", () => {
    expect(placeMove(2 * S - 20_000, 3.1 * S, neighbors, REACH).refused).toBe(true);
  });
  it("首尾相接的几段当成一整块，推到整块后面", () => {
    expect(placeMove(4 * S - 50_000, S, [range(2 * S, S), range(3 * S, S)], REACH)).toEqual({ start: 4 * S, snappedUs: 4 * S, refused: false });
  });
  it("不推到 0 前面", () => {
    // 往左贴要推到 -0.04 秒，不行；往右又太远
    expect(placeMove(10_000, 1_040_000, [range(S, S)], REACH).refused).toBe(true);
    // 往左推到正好 0 可以
    expect(placeMove(20_000, S, [range(S, S)], REACH)).toEqual({ start: 0, snappedUs: S, refused: false });
  });
});

describe("吸附目标", () => {
  const tracks = [
    track("v1", "video", [video("a", 0, 2 * S), video("b", 2 * S, 3 * S)]),
    track("t1", "text", [text("t", 1.5 * S, S)]),
    track("sub", "text", [text("s", 3.3 * S, 0.4 * S)], { kind: "subtitle" }),
  ];
  it("所有轨道的两头、标记、播放头、0，字幕轨不算", () => {
    const targets = snapTargetsOf(project(tracks, [{ time_us: 4.2 * S, label: "高潮" }]), { playheadUs: 0.7 * S });
    expect(targets.slice(0, 3)).toEqual([0, 0.7 * S, 4.2 * S]);
    expect(targets).toContain(1.5 * S);
    expect(targets).toContain(2.5 * S);
    expect(targets).not.toContain(3.3 * S);
  });
  it("排除正在拖的片段", () => {
    expect(snapTargetsOf(project(tracks), { exclude: ["t"] })).not.toContain(2.5 * S);
  });
  it("裁剪时去掉被拖那条边现在的位置（首尾相接的邻居不会卡住）", () => {
    expect(snapTargetsOf(project(tracks), { exclude: ["b"], edgeUs: 2 * S })).not.toContain(2 * S);
  });
  it("一样近时前面的胜出", () => {
    expect(snapTo(1_000_000, [1_030_000, 970_000], REACH).value).toBe(1_030_000);
    expect(snapTo(1_000_000, [2_000_000], REACH)).toEqual({ value: 1_000_000, snapped: null });
  });
});

describe("挪动", () => {
  const tracks = () => [
    track("v1", "video", [video("a", 0, 2 * S), video("b", 3 * S, 2 * S)]),
    track("v2", "video", [video("c", 0, S)]),
    track("t1", "text", [text("t", 6 * S, S)]),
    track("a1", "audio", [audio("m", 0, 8 * S)]),
    track("sub", "text", [text("s", 0, S)], { kind: "subtitle" }),
  ];

  it("没吸上落在帧上；吸上的不再取整", () => {
    const free = planMove(project(tracks()), spec(["b"], 0.512_345 * S))!;
    expect(free.items[0]!.timeline.start_us).toBe(toFrame(3.512_345 * S, FRAME));
    expect(free.snappedUs).toBeNull();
    // 尾巴贴到另一条轨道上文字的开头（6 秒）
    const snapped = planMove(project(tracks()), spec(["b"], 0.98 * S))!;
    expect(snapped.items[0]!.timeline.start_us).toBe(4 * S);
    expect(snapped.snappedUs).toBe(6 * S);
  });

  it("压到邻居一点点推到贴住，压得多不放", () => {
    const pushed = planMove(project(tracks()), spec(["b"], -1.03 * S))!;
    // 头吸到 2 秒（a 的尾巴）
    expect(pushed.items[0]!.timeline.start_us).toBe(2 * S);
    const refused = planMove(project(tracks()), spec(["b"], -2 * S))!;
    expect(refused.refused).toBe("这里放不下");
  });

  it("整组位移一样，最早的一段不早于 0；有一段放不下整组都不放", () => {
    const group = planMove(project(tracks()), spec(["b", "t"], 0.5 * S))!;
    expect(group.refused).toBeNull();
    expect(group.items.map((item) => item.timeline.start_us)).toEqual([3.5 * S, 6.5 * S]);
    const floor = planMove(project(tracks()), spec(["b", "c"], -5 * S))!;
    expect(floor.items.map((item) => item.timeline.start_us)).toEqual([3 * S, 0]);
    // b 往左压到 a，整组都不放（整组不推）
    expect(planMove(project(tracks()), spec(["b", "t"], -1.5 * S))!.refused).toBe("这里放不下");
  });

  it("跨轨道：同类轨道能去，类型不合、字幕轨进出、所有行外面都拒绝", () => {
    // 轨道区从上往下是 sub、a1、t1、v2、v1：往上一行是列表里往后一条
    const up = planMove(project(tracks()), spec(["b"], 0, { rowDelta: -1 }))!;
    expect(up.refused).toBeNull();
    expect(up.items[0]).toMatchObject({ fromTrackId: "v1", trackId: "v2" });
    expect(planMove(project(tracks()), spec(["b"], 0, { rowDelta: 1 }))!.refused).toBe("这里没有能放的轨道");
    expect(planMove(project(tracks()), spec(["b"], 0, { rowDelta: -2 }))!.refused).toBe("视频和图片只能放在视频轨道上");
    expect(planMove(project(tracks()), spec(["t"], 0, { rowDelta: -2 }))!.refused).toBe("字幕轨上只放整组字幕");
    expect(planMove(project(tracks()), spec(["s"], 0, { rowDelta: 2 }))!.refused).toBe("字幕只能留在字幕轨上");
    expect(planMove(project(tracks()), spec(["b"], 0, { rowDelta: null }))!.refused).toBe("这里没有能放的轨道");
    // 被拒时照样画在原来那行
    expect(planMove(project(tracks()), spec(["b"], 0, { rowDelta: -2 }))!.items[0]!.trackId).toBe("v1");
  });

  it("⌥ 拖复制：原片段还在，压到原片段也算放不下", () => {
    expect(planMove(project(tracks()), spec(["b"], 0.5 * S, { copy: true }))!.refused).toBe("这里放不下");
    const copy = planMove(project(tracks()), spec(["b"], 2 * S, { copy: true }))!;
    expect(copy.items[0]!.timeline.start_us).toBe(5 * S);
    expect(moveEdits(copy, project(tracks()), true)).toEqual([{ name: "duplicate_clip", arguments: { clip_id: "b", start: 5 } }]);
  });

  it("⌥ 拖复制跳过字幕；抓着的是字幕就不放", () => {
    const alone = planMove(project(tracks()), spec(["s"], 2 * S, { copy: true }))!;
    expect(alone.refused).toBe("字幕不能单独复制");
    expect(planMove(project(tracks()), spec(["s", "b"], 3 * S, { copy: true }))!.refused).toBe("字幕不能单独复制");
    const mixed = planMove(project(tracks()), spec(["b", "s"], 2 * S, { copy: true }))!;
    expect(mixed.refused).toBeNull();
    expect(moveEdits(mixed, project(tracks()), true)).toEqual([{ name: "duplicate_clip", arguments: { clip_id: "b", start: 5 } }]);
    // 不复制时字幕照常能在字幕轨上挪
    expect(planMove(project(tracks()), spec(["s"], 2 * S))!.refused).toBeNull();
  });

  it("换成改动：没变的不发，换了轨道才带 track_id", () => {
    const plan = planMove(project(tracks()), spec(["b"], 0, { rowDelta: -1 }))!;
    expect(moveEdits(plan, project(tracks()))).toEqual([{ name: "move_clip", arguments: { clip_id: "b", start: 3, track_id: "v2" } }]);
    expect(moveEdits(planMove(project(tracks()), spec(["b"], 0))!, project(tracks()))).toEqual([]);
  });
});

describe("整组挪动的发送顺序：每一步都落进已经腾空的地方", () => {
  const sameRow = () => [track("v1", "video", [video("a", 0, 2 * S), video("b", 2 * S, 2 * S), video("c", 6 * S, S)])];
  const ids = (edits: BoardEdit[]) => edits.map((edit) => (edit.arguments as { clip_id: string }).clip_id);

  it("首尾相接的两段往后挪：后面的先发，不管选中先后", () => {
    for (const order of [["a", "b"], ["b", "a"]]) {
      const plan = planMove(project(sameRow()), spec(order, 0.5 * S, { lead: "a" }))!;
      expect(plan.refused).toBeNull();
      const edits = moveEdits(plan, project(sameRow()));
      expect(ids(edits)).toEqual(["b", "a"]);
      expect(runMoves(sameRow(), edits)).toBeNull();
    }
    // 按选中先后发会在第 1 步压到还没挪的 b（采集器回的就是这个）
    expect(runMoves(sameRow(), [
      { name: "move_clip", arguments: { clip_id: "a", start: 0.5 } }, { name: "move_clip", arguments: { clip_id: "b", start: 2.5 } },
    ])).toBe(1);
  });

  it("往前挪：前面的先发", () => {
    const tracksNow = () => [track("v1", "video", [video("a", S, 2 * S), video("b", 3 * S, 2 * S)])];
    const plan = planMove(project(tracksNow()), spec(["b", "a"], -0.5 * S))!;
    const edits = moveEdits(plan, project(tracksNow()));
    expect(ids(edits)).toEqual(["a", "b"]);
    expect(runMoves(tracksNow(), edits)).toBeNull();
  });

  it("上下两行一起换一行：目标行上的同组片段先走", () => {
    // 轨道区从上往下 v3、v2、v1；c、d 叠着，一起往下挪一行，c 要落到 d 现在的位置
    const stacked = () => [track("v1", "video", []), track("v2", "video", [video("d", 0, 2 * S)]), track("v3", "video", [video("c", 0, 2 * S)])];
    for (const order of [["c", "d"], ["d", "c"]]) {
      const down = planMove(project(stacked()), spec(order, 0, { lead: "c", rowDelta: 1 }))!;
      expect(down.refused).toBeNull();
      const edits = moveEdits(down, project(stacked()));
      expect(edits).toEqual([
        { name: "move_clip", arguments: { clip_id: "d", start: 0, track_id: "v1" } }, { name: "move_clip", arguments: { clip_id: "c", start: 0, track_id: "v2" } },
      ]);
      expect(runMoves(stacked(), edits)).toBeNull();
    }
    // 往上挪一行同理（先腾 v2、v3 上面的）
    const lifted = () => [track("v1", "video", [video("e", 0, 2 * S)]), track("v2", "video", [video("f", 0, 2 * S)]), track("v3", "video", [])];
    const up = planMove(project(lifted()), spec(["e", "f"], 0.3 * S, { rowDelta: -1 }))!;
    const upEdits = moveEdits(up, project(lifted()));
    expect(ids(upEdits)).toEqual(["f", "e"]);
    expect(runMoves(lifted(), upEdits)).toBeNull();
  });

  it("键盘微调一样排：往后先发后面的、往前先发前面的，原来的顺序不动", () => {
    const held = [{ id: "a", trackId: "v1", timeline: range(0, 2 * S) }, { id: "b", trackId: "v1", timeline: range(2 * S, 2 * S) }];
    const asEdits = (shift: number) => moveOrder(held, shift).map((one) => ({ name: "move_clip" as const, arguments: { clip_id: one.id, start: (one.timeline.start_us + shift) / S } }));
    const right = nudgeDelta(project(sameRow()), held, FRAME);
    expect(right).toBe(FRAME);
    expect(ids(asEdits(right))).toEqual(["b", "a"]);
    expect(runMoves(sameRow(), asEdits(right))).toBeNull();
    expect(held.map((one) => one.id)).toEqual(["a", "b"]);
    const back = [{ id: "a", trackId: "v1", timeline: range(S, S) }, { id: "b", trackId: "v1", timeline: range(2 * S, S) }];
    expect(moveOrder(back, -FRAME).map((one) => one.id)).toEqual(["a", "b"]);
    expect(moveOrder([...back].reverse(), -FRAME).map((one) => one.id)).toEqual(["a", "b"]);
  });
});

describe("track 兼容", () => {
  it("同一条轨道总能放", () => {
    expect(trackRefusal({ kind: "audio" }, { id: "x", track_type: "audio" }, { id: "x", track_type: "audio" })).toBeNull();
    expect(trackRefusal({ kind: "image" }, { id: "x", track_type: "video" }, { id: "y", track_type: "video" })).toBeNull();
    expect(trackRefusal({ kind: "audio" }, { id: "x", track_type: "audio" }, { id: "y", track_type: "video" })).toBe("音频只能放在音频轨道上");
  });
});

describe("裁剪", () => {
  const tracks = () => [
    track("v1", "video", [video("a", 0, 2 * S), video("b", 2 * S, 2 * S, { source: { start_us: S, duration_us: 2 * S } })]),
    track("t1", "text", [text("t", 4.5 * S, S)]),
  ];
  const ctx = { playheadUs: null, reachUs: REACH, frameUs: FRAME, mediaDurationUs: 5 * S };

  it("拖右边吸到别的轨道上的边", () => {
    const plan = planTrim(project(tracks()), tracks()[0]!.segments[1]!, "end", 0.47 * S, ctx);
    expect(plan.timeline).toEqual(range(2 * S, 2.5 * S));
    expect(plan.snappedUs).toBe(4.5 * S);
    expect(plan.source).toEqual(range(S, 2.5 * S));
  });

  it("没吸上的边落在帧上", () => {
    const plan = planTrim(project(tracks()), tracks()[0]!.segments[1]!, "end", 0.21 * S, ctx);
    expect(plan.timeline.start_us + plan.timeline.duration_us).toBe(toFrame(4.21 * S, FRAME));
    expect(plan.snappedUs).toBeNull();
  });

  it("首尾相接的邻居不把左边卡在原地；左边拉不进前一段", () => {
    const shrink = planTrim(project(tracks()), tracks()[0]!.segments[1]!, "start", 0.03 * S, ctx);
    expect(shrink.timeline.start_us).toBe(toFrame(2.03 * S, FRAME));
    const grow = planTrim(project(tracks()), tracks()[0]!.segments[1]!, "start", -0.5 * S, ctx);
    expect(grow.timeline.start_us).toBe(2 * S);
    expect(grow.snappedUs).toBeNull();
  });

  it("隔着空当往左拉，停在前一段的尾巴上画参考线", () => {
    const gap = video("b", 2.5 * S, 2 * S, { source: { start_us: S, duration_us: 2 * S } });
    const plan = planTrim(project([track("v1", "video", [video("a", 0, 2 * S), gap])]), gap, "start", -0.8 * S, ctx);
    expect(plan.timeline).toEqual(range(2 * S, 2.5 * S));
    expect(plan.source).toEqual(range(0.5 * S, 2.5 * S));
    expect(plan.snappedUs).toBe(2 * S);
  });

  it("拉到素材尾巴就停，说明素材到头了", () => {
    const plan = planTrim(project([track("v1", "video", [video("b", 0, 2 * S, { source: { start_us: S, duration_us: 2 * S } })])]), video("b", 0, 2 * S, { source: { start_us: S, duration_us: 2 * S } }), "end", 3 * S, ctx);
    expect(plan.timeline.duration_us).toBe(4 * S);
    expect(plan.sourceEnd).toBe(true);
    expect(trimTip(2 * S, 4 * S, true)).toBe("拉长 2.00 秒 · 现在 4.00 秒 · 素材到头了");
    expect(trimTip(2 * S, 1.6 * S, false)).toBe("缩短 0.40 秒 · 现在 1.60 秒");
    expect(moveTip(2.4 * S)).toBe("2.40 秒开始");
  });

  it("Q / W 裁到播放头，播放头不在中间时不裁", () => {
    const tracksNow = tracks();
    const clip = tracksNow[0]!.segments[1]!;
    expect(trimToPlayhead(project(tracksNow), clip, "start", 2.5 * S, 5 * S)).toEqual({ args: { clip_id: "b", start: 2.5, duration: 1.5, source_start: 1.5, source_duration: 1.5, speed: 1 } });
    expect(trimToPlayhead(project(tracksNow), clip, "end", 2.5 * S, 5 * S)).toEqual({ args: { clip_id: "b", duration: 0.5, source_duration: 0.5, speed: 1 } });
    expect(trimToPlayhead(project(tracksNow), clip, "end", 2.05 * S, 5 * S)).toBeNull();
    expect(trimToPlayhead(project(tracksNow), clip, "end", 6 * S, 5 * S)).toBeNull();
  });

  it("不短过最后一个关键帧：从哪头往里裁都停住", () => {
    const zoom: EditTextSegment = { ...text("k", 0, 3 * S), keyframes: [{ property: "uniform_scale", offset_us: 0, value: 1 }, { property: "uniform_scale", offset_us: 3 * S, value: 1.2 }] };
    const lone = project([track("t1", "text", [zoom])]);
    for (const [edge, delta] of [["end", -S], ["start", S]] as const) {
      const plan = planTrim(lone, zoom, edge, delta, ctx);
      expect(plan.timeline).toEqual(range(0, 3 * S));
      expect(plan.floorHit).toBe("关键帧");
    }
    expect(trimTip(3 * S, 3 * S, false, "关键帧")).toBe("现在 3.00 秒 · 再短就放不下关键帧了");
    // Q / W 不裁到别处去，说原因
    expect(trimToPlayhead(lone, zoom, "start", 1.2 * S)).toEqual({ refused: "裁到播放头就放不下关键帧了" });
    // 关键帧在 2 秒：往里裁到 2 秒为止
    const early: EditTextSegment = { ...zoom, keyframes: [{ property: "uniform_scale", offset_us: 2 * S, value: 1 }] };
    expect(planTrim(project([track("t1", "text", [early])]), early, "end", -2 * S, ctx).timeline).toEqual(range(0, 2 * S));
    expect(planTrim(project([track("t1", "text", [early])]), early, "start", 0.5 * S, ctx)).toMatchObject({ timeline: range(0.5 * S, 2.5 * S), floorHit: null });
  });

  it("不短过淡入加淡出", () => {
    const faded = video("f", 0, 3 * S, { source: { start_us: 0, duration_us: 3 * S }, fade: { in_duration_us: 0.5 * S, out_duration_us: S } });
    const lone = project([track("v1", "video", [faded])]);
    expect(planTrim(lone, faded, "end", -2 * S, ctx)).toMatchObject({ timeline: range(0, 1.5 * S), source: range(0, 1.5 * S), floorHit: "淡入淡出" });
    expect(planTrim(lone, faded, "start", 2 * S, ctx)).toMatchObject({ timeline: range(1.5 * S, 1.5 * S), source: range(1.5 * S, 1.5 * S), floorHit: "淡入淡出" });
    expect(trimToPlayhead(lone, faded, "end", S, 5 * S)).toEqual({ refused: "裁到播放头就放不下淡入淡出了" });
    expect(trimToPlayhead(lone, faded, "end", 2 * S, 5 * S)).toEqual({ args: { clip_id: "f", duration: 2, source_duration: 2, speed: 1 } });
  });
});

describe("键盘微调", () => {
  const tracks = [track("v1", "video", [video("a", 0, 2 * S), video("b", 3 * S, S), video("c", 4_100_000, S)])];
  const held = [{ id: "b", trackId: "v1", timeline: range(3 * S, S) }];
  it("碰到同轨邻居就贴住停下", () => {
    expect(nudgeDelta(project(tracks), held, 0.5 * S)).toBe(100_000);
    expect(nudgeDelta(project(tracks), held, -2 * S)).toBe(-S);
  });
  it("不早于 0", () => {
    expect(nudgeDelta(project([track("v1", "video", [video("b", 0.2 * S, S)])]), [{ id: "b", trackId: "v1", timeline: range(0.2 * S, S) }], -S)).toBe(-0.2 * S);
  });
  it("按帧走、攒着往上加", () => {
    const one = nudgeStep(project(tracks), held, 0, 1, 30);
    expect(one).toBe(Math.round(FRAME * 90 + FRAME) - 3 * S);
    const two = nudgeStep(project(tracks), held, one, 1, 30);
    expect(two).toBe(Math.round(FRAME * 92) - 3 * S);
    // 再往右顶到 c 就不动了
    expect(nudgeStep(project(tracks), held, 0, 10, 30)).toBe(100_000);
  });
});

describe("复制粘贴", () => {
  const tracks = () => [
    track("v1", "video", [video("a", 0, 2 * S), video("b", 3 * S, S)]),
    track("t1", "text", [text("t", 3.5 * S, S)]),
    track("sub", "text", [text("s", 0, S)], { kind: "subtitle" }),
  ];
  it("粘到播放头处、原来的轨道上，间距不变", () => {
    const plan = planPaste(project(tracks()), ["t", "b"], 6 * S);
    expect(plan).toEqual({
      edits: [{ name: "duplicate_clip", arguments: { clip_id: "b", start: 6 } }, { name: "duplicate_clip", arguments: { clip_id: "t", start: 6.5 } }],
      lead: { trackId: "v1", atUs: 6 * S },
    });
  });
  it("放不下、不在了、字幕都不粘", () => {
    expect(planPaste(project(tracks()), ["b"], 1.5 * S)).toEqual({ refused: "这里放不下" });
    expect(planPaste(project(tracks()), ["gone"], 0)).toEqual({ refused: "复制的片段已经不在了" });
    expect(planPaste(project(tracks()), ["s"], 9 * S)).toEqual({ refused: "字幕不能单独复制" });
  });
  it("⌘D 紧接在后面；后面放不下就放到这条轨道最后", () => {
    expect(planDuplicate(project(tracks()), ["b"])).toMatchObject({ edits: [{ name: "duplicate_clip", arguments: { clip_id: "b", start: 4 } }], lead: { trackId: "v1", atUs: 4 * S } });
    expect(planDuplicate(project(tracks()), ["a"])).toMatchObject({ edits: [{ arguments: { clip_id: "a", start: 4 } }] });
    // 整组：整组接在整组后面
    expect(planDuplicate(project(tracks()), ["b", "t"])).toMatchObject({ edits: [{ arguments: { clip_id: "b", start: 4.5 } }, { arguments: { clip_id: "t", start: 5 } }] });
  });
});

describe("框选", () => {
  const tracks = [track("v1", "video", [video("a", 0, 2 * S), video("b", 3 * S, S)]), track("t1", "text", [text("t", 1.5 * S, S)])];
  it("相交就算、按行算，行外面没有片段", () => {
    expect(marqueeHits(tracks, { fromUs: 1.8 * S, toUs: 3.1 * S, fromRow: 0, toRow: 0 })).toEqual(["a", "b"]);
    expect(marqueeHits(tracks, { fromUs: 2.9 * S, toUs: 1.9 * S, fromRow: 1, toRow: 0 })).toEqual(["a", "t"]);
    expect(marqueeHits(tracks, { fromUs: 0, toUs: 9 * S, fromRow: -1, toRow: -1 })).toEqual([]);
    expect(marqueeHits(tracks, { fromUs: 2 * S, toUs: 3 * S, fromRow: 0, toRow: 0 })).toEqual([]);
  });
});

describe("轨道层级", () => {
  const tracks = [{ id: "v1" }, { id: "t1" }, { id: "a1" }];
  it("最上层是列表最后，已经在那儿了不动", () => {
    expect(trackOrderWith(tracks, "v1", "top")).toEqual(["t1", "a1", "v1"]);
    expect(trackOrderWith(tracks, "a1", "bottom")).toEqual(["a1", "v1", "t1"]);
    expect(trackOrderWith(tracks, "a1", "top")).toBeNull();
    expect(trackOrderWith(tracks, "v1", "bottom")).toBeNull();
  });
  it("轨道区倒着画：移到最上层的那条出现在第一行，最下层的在最后一行", () => {
    expect(trackRows(tracks).map((one) => one.id)).toEqual(["a1", "t1", "v1"]);
    const top = trackOrderWith(tracks, "v1", "top")!.map((id) => ({ id }));
    expect(trackRows(top)[0]!.id).toBe("v1");
    const bottom = trackOrderWith(tracks, "a1", "bottom")!.map((id) => ({ id }));
    expect(trackRows(bottom).at(-1)!.id).toBe("a1");
    expect(trackRows(tracks)).not.toBe(tracks);
  });
});

describe("缩放和画法", () => {
  it("默认成片占八成，最宽看四倍、最窄看 1 秒", () => {
    const zoom = zoomRange(10 * S, 800);
    expect(zoom.fit * 10 * S).toBeCloseTo(640);
    expect(zoom.min * 40 * S).toBeCloseTo(800);
    expect(zoom.max * S).toBeCloseTo(800);
    expect(zoomRange(0, 800).fit * 30 * S).toBeCloseTo(800);
  });
  it("缩放时锚点下面的时间不动", () => {
    // 原来 0.0001 px/µs，滚了 200px，锚点在视图 100px 处：那里是 3 秒
    const next = zoomScroll(0.0001, 0.0002, 200, 100);
    expect((next + 100) / 0.0002).toBeCloseTo(3 * S);
  });
  it("轨道至少一屏，拖动时延长到被拖片段后面再留一截", () => {
    expect(canvasExtentUs(10 * S, 800, 0.000064)).toBeCloseTo(12.5 * S);
    expect(canvasExtentUs(10 * S, 800, 0.000064, 12 * S)).toBeCloseTo(12 * S + 6.25 * S);
  });
  it("拖到边缘自动滚，越靠外越快", () => {
    expect(edgeScrollStep(500, 100, 900)).toBe(0);
    expect(edgeScrollStep(100, 100, 900)).toBe(-24);
    expect(edgeScrollStep(880, 100, 900)).toBe(Math.ceil(6 + 18 * (28 / 48)));
  });
  it("片段边缘取整到像素、少画 1px；把手不超过四分之一", () => {
    expect(clipBox(range(1.234 * S, S), 0.0001)).toEqual({ left: 123, width: 99 });
    expect(trimHit(100)).toBe(8);
    expect(trimHit(12)).toBe(3);
    expect(trimHit(4)).toBe(2);
  });
  it("首尾相接的边记下来，隔开的不算", () => {
    const edges = touchingEdges([video("b", 2 * S, S), video("a", 0, 2 * S), video("c", 3.5 * S, S)], 0.0001);
    expect([...edges]).toEqual(["a:end", "b:start"]);
  });
  it("刻度只出范围里的", () => {
    const ticks = visibleTicks(0.0001, 1000, 1300, 60 * S);
    expect(ticks.map((tick) => tick.us)).toEqual([10 * S, 11 * S, 12 * S, 13 * S]);
    expect(ticks[0]!.x).toBe(1000);
  });
});
