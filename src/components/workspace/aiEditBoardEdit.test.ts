import { describe, expect, it } from "vitest";

import type { EditMediaSegment, EditProject, EditSegment, EditTextSegment, EditTrack } from "../../services/aiEdit";
import {
  clipCallName, dragMoveStart, dragRect, draggedTransform, dragTrim, expectedClip, fullTransform, hasMotionKeyframes, intersects, keepSelection, layersInRect, MIN_CLIP_US, pyRound,
  regionBox, regionCaption, regionHint, resizeRatio, selectableIds, settleSelection, snapTime, splitOffset, splitTarget, tapPick, tooManyEditsText, trimArgs, undoKind,
} from "./aiEditBoardEdit";
import { IDENTITY_TRANSFORM, timeAtX } from "./aiEditModel";

const S = 1_000_000;

function video(id: string, start: number, duration: number, extra: Partial<EditMediaSegment> = {}): EditMediaSegment {
  return {
    id, kind: "video", path: `/data/ai-edit/media/${id}.mp4`, timeline: { start_us: start, duration_us: duration },
    source: { start_us: 0, duration_us: duration }, volume: 1, speed: 1, material_name: `${id}.mp4`, ...extra,
  };
}

const text = (id: string, start: number, duration: number): EditTextSegment => ({ id, kind: "text", text: "周末去海边", timeline: { start_us: start, duration_us: duration } });

// 轨道 1000px 宽、10 秒：一像素 1 万微秒，吸附范围 6 万微秒
const ctx = (extra: Partial<Parameters<typeof dragTrim>[3]> = {}) => ({ siblings: [], playheadUs: null, usPerPx: 10_000, ...extra });

describe("吸附", () => {
  it("离得最近、又在范围里的目标才贴过去", () => {
    expect(snapTime(1_030_000, [0, 1_000_000, 1_050_000], 60_000)).toBe(1_050_000);
    expect(snapTime(1_100_000, [0, 1_000_000], 60_000)).toBe(1_100_000);
  });

  it("挪动时头或尾贴到相邻片段、播放头、0", () => {
    const left = video("a", 0, 2 * S);
    // 头贴到前一段的尾巴
    expect(dragMoveStart({ start_us: 3 * S, duration_us: S }, -0.96 * S, ctx({ siblings: [left] }))).toBe(2 * S);
    // 尾巴贴到播放头
    expect(dragMoveStart({ start_us: 3 * S, duration_us: S }, 0.95 * S, ctx({ playheadUs: 5 * S }))).toBe(4 * S);
    // 0 附近贴到 0，拖过头也不早于 0
    expect(dragMoveStart({ start_us: 3 * S, duration_us: S }, -2.95 * S, ctx())).toBe(0);
    expect(dragMoveStart({ start_us: 3 * S, duration_us: S }, -8 * S, ctx())).toBe(0);
    // 超出 6 像素不吸
    expect(dragMoveStart({ start_us: 3 * S, duration_us: S }, -0.9 * S, ctx({ siblings: [left] }))).toBe(2.1 * S);
  });
});

describe("裁剪", () => {
  it("左端拖过头：文字裁到 0 为止", () => {
    expect(dragTrim(text("t", 2 * S, S), "start", -5 * S, ctx()).timeline).toEqual({ start_us: 0, duration_us: 3 * S });
  });

  it("左端拖过头：截取不能早于素材开头", () => {
    const clip = video("a", 5 * S, 2 * S, { source: { start_us: S, duration_us: 2 * S } });
    expect(dragTrim(clip, "start", -10 * S, ctx())).toEqual({ timeline: { start_us: 4 * S, duration_us: 3 * S }, source: { start_us: 0, duration_us: 3 * S } });
  });

  it("右端拖过头：不超出素材时长；拿不到素材时长就不限", () => {
    const clip = video("a", 0, 2 * S, { source: { start_us: S, duration_us: 2 * S } });
    expect(dragTrim(clip, "end", 10 * S, ctx({ mediaDurationUs: 4 * S }))).toEqual({ timeline: { start_us: 0, duration_us: 3 * S }, source: { start_us: S, duration_us: 3 * S } });
    expect(dragTrim(clip, "end", 10 * S, ctx()).timeline.duration_us).toBe(12 * S);
  });

  it("2 倍速：时间线挪 1 秒，截取挪 2 秒", () => {
    const clip = video("a", 2 * S, 3 * S, { speed: 2, source: { start_us: 4 * S, duration_us: 6 * S } });
    expect(dragTrim(clip, "start", S, ctx())).toEqual({ timeline: { start_us: 3 * S, duration_us: 2 * S }, source: { start_us: 6 * S, duration_us: 4 * S } });
    expect(dragTrim(clip, "end", -S, ctx())).toEqual({ timeline: { start_us: 2 * S, duration_us: 2 * S }, source: { start_us: 4 * S, duration_us: 4 * S } });
    // 素材 12 秒：截取最多到 12 秒，时间线最多 4 秒
    expect(dragTrim(clip, "end", 5 * S, ctx({ mediaDurationUs: 12 * S }))).toEqual({ timeline: { start_us: 2 * S, duration_us: 4 * S }, source: { start_us: 4 * S, duration_us: 8 * S } });
  });

  it("不整除的倍速：截取长度和时间线时长按采集器的取整对得上，尾巴不动", () => {
    const clip = video("a", 1 * S, 2_500_000, { speed: 0.8, source: { start_us: 500_000, duration_us: 2_000_000 } });
    for (const delta of [-333_333, -77_777, 12_345, 654_321, 1_111_111]) {
      for (const edge of ["start", "end"] as const) {
        const { timeline, source } = dragTrim(clip, edge, delta, ctx({ usPerPx: 1 }));
        expect(pyRound(source!.duration_us / 0.8)).toBe(timeline.duration_us);
        expect(Number.isInteger(source!.start_us) && Number.isInteger(source!.duration_us)).toBe(true);
        if (edge === "start") expect(timeline.start_us + timeline.duration_us).toBe(1 * S + 2_500_000);
        else expect(timeline.start_us).toBe(S);
      }
    }
  });

  it("最短 0.1 秒，不压到相邻片段", () => {
    const clip = video("a", 2 * S, 2 * S, { source: { start_us: 0, duration_us: 2 * S } });
    expect(dragTrim(clip, "end", -5 * S, ctx()).timeline.duration_us).toBe(MIN_CLIP_US);
    expect(dragTrim(clip, "start", 5 * S, ctx()).timeline).toEqual({ start_us: 4 * S - MIN_CLIP_US, duration_us: MIN_CLIP_US });
    const neighbors = [video("l", 0, 1.5 * S), video("r", 5 * S, S)];
    expect(dragTrim(clip, "end", 4 * S, ctx({ siblings: neighbors })).timeline).toEqual({ start_us: 2 * S, duration_us: 3 * S });
    expect(dragTrim(clip, "start", -4 * S, ctx({ siblings: neighbors, usPerPx: 1 })).timeline.start_us).toBeGreaterThanOrEqual(1.5 * S);
  });

  it("裁剪换成 update_clip 参数：右端只改时长，视频带上截取和倍速", () => {
    const clip = video("a", 2 * S, 3 * S, { speed: 2, source: { start_us: 4 * S, duration_us: 6 * S } });
    expect(trimArgs(clip, "start", dragTrim(clip, "start", S, ctx()))).toEqual({ clip_id: "a", start: 3, duration: 2, source_start: 6, source_duration: 4, speed: 2 });
    expect(trimArgs(clip, "end", dragTrim(clip, "end", -S, ctx()))).toEqual({ clip_id: "a", duration: 2, source_duration: 4, speed: 2 });
    const words = text("t", S, S);
    expect(trimArgs(words, "end", dragTrim(words, "end", S, ctx()))).toEqual({ clip_id: "t", duration: 2 });
  });

  it("播放头在片段中间才能切，离两头不到 0.1 秒不切", () => {
    const clip = video("a", 2 * S, 3 * S);
    expect(splitOffset(clip, 3.5 * S)).toBe(1.5 * S);
    expect(splitOffset(clip, 2 * S)).toBeNull();
    expect(splitOffset(clip, 5 * S)).toBeNull();
    expect(splitOffset(clip, 8 * S)).toBeNull();
    expect(splitOffset(clip, 2 * S + MIN_CLIP_US - 1)).toBeNull();
    expect(splitOffset(clip, 2 * S + MIN_CLIP_US)).toBe(MIN_CLIP_US);
    expect(splitOffset(clip, 5 * S - MIN_CLIP_US)).toBe(3 * S - MIN_CLIP_US);
    expect(splitOffset(clip, 5 * S - MIN_CLIP_US + 1)).toBeNull();
  });

  it("选中片段后单击刻度尺：选中不变，播放头挪进片段中间就能切；点轨道空白处才收起", () => {
    // 片段 2–5 秒；轨道 1000px 宽、10 秒；刻度尺那一行的 y 在 100–122
    const clip = video("a", 2 * S, 3 * S);
    const ruler = { top: 100, bottom: 122 };
    // 在刻度尺上点 3.5 秒处：不交给 pick，选中留着；播放头到了片段中间，能切
    expect(tapPick(null, 110, ruler)).toBeUndefined();
    expect(tapPick(null, ruler.top, ruler)).toBeUndefined();
    expect(tapPick(null, ruler.bottom, ruler)).toBeUndefined();
    expect(splitOffset(clip, timeAtX(350, 1000, 10 * S))).toBe(1.5 * S);
    // 点轨道空白处照旧收起，点片段照旧选它
    expect(tapPick(null, 150, ruler)).toBeNull();
    expect(tapPick("a", 150, ruler)).toBe("a");
  });

  it("pyRound 正好一半时取偶数", () => {
    expect([pyRound(2.5), pyRound(3.5), pyRound(2.4), pyRound(2.6)]).toEqual([2, 4, 2, 3]);
  });
});

describe("切开、选中", () => {
  const track = (id: string, segments: EditSegment[], extra: Partial<EditTrack> = {}): EditTrack => ({ id, track_type: "video", name: id, mute: false, segments, ...extra });
  const project = (tracks: EditTrack[], revision = 1): Pick<EditProject, "tracks" | "revision"> => ({ tracks, revision });
  // 底层视频轨 v1（0–4 秒），上面一条视频轨 v2（1–3 秒），再上面文字轨，最上面字幕轨
  const tracks = [
    track("v1", [video("base", 0, 4 * S)]),
    track("v2", [video("pip", S, 2 * S)]),
    track("t1", [text("title", 0, 6 * S)], { track_type: "text" }),
    track("sub", [text("line", 0, 8 * S)], { track_type: "text", kind: "subtitle" }),
  ];

  it("全选以后一批改动超过采集器上限：不发，说清楚是选多了", () => {
    expect(tooManyEditsText(50)).toBeNull();
    expect(tooManyEditsText(1)).toBeNull();
    expect(tooManyEditsText(62)).toBe("一次最多能改 50 段，这次有 62 段，少选一些再试");
    expect(tooManyEditsText(4, 3)).toBe("一次最多能改 3 段，这次有 4 段，少选一些再试");
  });

  it("⌘B 先切选中的、播放头在它中间的那段", () => {
    expect(splitTarget(project(tracks), ["pip"], 2 * S)).toMatchObject({ segment: { id: "pip" }, track: { id: "v2" }, offset: S });
    // 选了好几段：按传进来的顺序（primary 在前）找第一段切得开的
    expect(splitTarget(project(tracks), ["title", "pip"], 2 * S)?.segment.id).toBe("title");
  });

  it("选中的切不开就切最底层视频轨上的；再没有从上层往下找，字幕轨不算", () => {
    expect(splitTarget(project(tracks), ["pip"], 3.5 * S)?.segment.id).toBe("base");
    expect(splitTarget(project(tracks), [], 2 * S)?.segment.id).toBe("base");
    // 底层视频轨到 4 秒就没了：从上往下找，跳过字幕轨，落到文字轨
    expect(splitTarget(project(tracks), [], 5 * S)?.segment.id).toBe("title");
    // 只剩字幕轨压着播放头：没有能切的
    expect(splitTarget(project(tracks), [], 7 * S)).toBeNull();
    // 离片段两头不到 0.1 秒不算压着
    expect(splitTarget(project(tracks), [], 4 * S - 50_000)?.segment.id).toBe("title");
  });

  it("详情卡上的切开只看那一段", () => {
    expect(splitTarget(project(tracks), ["pip"], 3.5 * S, { only: true })).toBeNull();
    expect(splitTarget(project(tracks), ["pip"], 2 * S, { only: true })?.segment.id).toBe("pip");
  });

  it("切开后等新工程进来选中右半段：开头离切点不到一帧的那段", () => {
    const after = project([track("v1", [video("left", 0, 1.5 * S), video("right", 1.5 * S, 2.5 * S)])], 2);
    expect(expectedClip(after, { trackId: "v1", atUs: 1.5 * S + 10_000 }, 33_333)).toBe("right");
    expect(expectedClip(after, { trackId: "v1", atUs: 1.6 * S }, 33_333)).toBeNull();
    expect(expectedClip(after, { trackId: "other", atUs: 1.5 * S }, 33_333)).toBeNull();
  });

  it("新工程进来：等着的先不收卡片，版本变了选上右半段；没等着的只去掉不在了的", () => {
    const picked = { ids: ["base"], primary: "base" };
    const waiting = { trackId: "v1", atUs: 1.5 * S, revision: 1 };
    const before = project(tracks, 1);
    // 版本还没变（长轮询带回的同一版）：原封不动
    expect(settleSelection(before, picked, waiting, 33_333)).toEqual({ picked, waiting });
    const after = project([track("v1", [video("left", 0, 1.5 * S), video("right", 1.5 * S, 2.5 * S)])], 2);
    expect(settleSelection(after, picked, waiting, 33_333)).toEqual({ picked: { ids: ["right"], primary: "right" }, waiting: null });
    // 没等着：切掉了的那段不在了，选中清空
    expect(settleSelection(after, picked, null, 33_333)).toEqual({ picked: { ids: [], primary: null }, waiting: null });
  });

  it("选中的片段有的不在了：留下还在的，primary 不在了换成最后一个；都在时原样返回", () => {
    const picked = { ids: ["base", "pip", "title"], primary: "pip" };
    expect(keepSelection(project(tracks), picked)).toBe(picked);
    const fewer = project([tracks[0]!, tracks[2]!]);
    expect(keepSelection(fewer, picked)).toEqual({ ids: ["base", "title"], primary: "title" });
    expect(keepSelection(fewer, { ids: ["base", "pip"], primary: "base" })).toEqual({ ids: ["base"], primary: "base" });
  });

  it("⌘A 选所有轨道上的片段，字幕轨除外", () => {
    expect(selectableIds(project(tracks))).toEqual(["base", "pip", "title"]);
    expect(selectableIds(null)).toEqual([]);
  });

  it("上一步是不是 AI 的一整轮：有 kind 看 kind，老采集器按说法认", () => {
    expect(undoKind({ label: "挪动视频“海边”", kind: "edit" })).toBe("edit");
    expect(undoKind({ label: "AI 处理“剪成 30 秒”之前", kind: "turn" })).toBe("turn");
    expect(undoKind({ label: "AI 处理“剪成 30 秒”之前" })).toBe("turn");
    expect(undoKind({ label: "退回" })).toBe("revert");
    expect(undoKind({ label: "删掉文字“标题”" })).toBe("edit");
    expect(undoKind(null)).toBeNull();
  });
});

describe("画面上拖动和缩放", () => {
  const stage = { width: 270, height: 480 };

  it("位移以半个画布为单位、往下拖 y 变小，限在 -1..1", () => {
    const moved = draggedTransform(IDENTITY_TRANSFORM, { dx: 67.5, dy: 120, ratio: 1 }, stage);
    expect([moved.transform_x, moved.transform_y]).toEqual([0.5, -0.5]);
    const far = draggedTransform({ ...IDENTITY_TRANSFORM, transform_x: 0.8, transform_y: -0.9 }, { dx: 500, dy: 500, ratio: 1 }, stage);
    expect([far.transform_x, far.transform_y]).toEqual([1, -1]);
  });

  it("缩放两个方向同乘，限在 0.05..20，其余项照旧", () => {
    const base = { ...IDENTITY_TRANSFORM, scale_x: 2, scale_y: 1.5, rotation: 30, alpha: 0.5, flip_horizontal: true };
    expect(draggedTransform(base, { dx: 0, dy: 0, ratio: 1.5 }, stage)).toEqual({ ...base, scale_x: 3, scale_y: 2.25 });
    expect(draggedTransform(base, { dx: 0, dy: 0, ratio: 100 }, stage)).toMatchObject({ scale_x: 20, scale_y: 20 });
    expect(draggedTransform(base, { dx: 0, dy: 0, ratio: 0.001 }, stage)).toMatchObject({ scale_x: 0.05, scale_y: 0.05 });
  });

  it("右下角往外拖一倍半边长就放大一倍，往里拖缩小", () => {
    expect(resizeRatio({ width: 100, height: 60 }, 50, 30)).toBeCloseTo(2);
    expect(resizeRatio({ width: 100, height: 60 }, -25, -15)).toBeCloseTo(0.5);
    expect(resizeRatio({ width: 100, height: 60 }, -500, -500)).toBe(0.01);
  });

  it("没设 transform 的片段补默认值；有位置或缩放关键帧的不给拖", () => {
    expect(fullTransform(null)).toEqual(IDENTITY_TRANSFORM);
    expect(fullTransform({ ...IDENTITY_TRANSFORM, transform_y: -0.8 }).transform_y).toBe(-0.8);
    expect(hasMotionKeyframes({ keyframes: [{ property: "uniform_scale" }] })).toBe(true);
    expect(hasMotionKeyframes({ keyframes: [{ property: "alpha" }] })).toBe(false);
    expect(hasMotionKeyframes({})).toBe(false);
  });
});

describe("框选", () => {
  const stage = { width: 200, height: 400 };

  it("往左上反着拖也是同一个框，拖出舞台的部分夹回来", () => {
    expect(dragRect(150, 300, 50, 100, stage)).toEqual({ left: 50, top: 100, width: 100, height: 200 });
    expect(dragRect(150, 300, 260, -40, stage)).toEqual({ left: 150, top: 0, width: 50, height: 300 });
  });

  it("换成相对画布的比例；太小不算", () => {
    expect(regionBox({ left: 20, top: 40, width: 60, height: 100 }, stage)).toEqual({ x: 0.1, y: 0.1, width: 0.3, height: 0.25 });
    expect(regionBox({ left: 20, top: 40, width: 3, height: 100 }, stage)).toBeNull();
    const edge = regionBox({ left: 133.33, top: 0, width: 66.67, height: 400 }, stage)!;
    expect(edge.x + edge.width).toBeLessThanOrEqual(1);
  });

  it("和框有重叠的图层才算，只碰到边不算，按顺序去重", () => {
    const box = { left: 50, top: 50, width: 100, height: 100 };
    expect(intersects(box, { left: 150, top: 60, width: 20, height: 20 })).toBe(false);
    expect(layersInRect(box, [
      { id: "bg", rect: { left: 0, top: 0, width: 200, height: 400 } },
      { id: "side", rect: { left: 150, top: 60, width: 20, height: 20 } },
      { id: "title", rect: { left: 60, top: 140, width: 50, height: 30 } },
      { id: "bg", rect: { left: 0, top: 0, width: 200, height: 400 } },
    ])).toEqual(["bg", "title"]);
  });

  it("提示和气泡小字都是口语", () => {
    expect(clipCallName(video("a", 0, S), "海边日落")).toBe("视频“海边日落”");
    expect(clipCallName(text("t", 0, S))).toBe("文字“周末去海边”");
    expect(regionHint(3.2 * S, ["视频“a”", "文字“标题”"])).toBe("在第 3.2 秒的画面上框了一块，里面有视频“a”、文字“标题”");
    expect(regionHint(3.2 * S, ["视频“a”", "文字“标题”", "贴纸"])).toBe("在第 3.2 秒的画面上框了一块，里面有 3 样东西：视频“a”、文字“标题”、贴纸");
    expect(regionHint(0, [])).toBe("在第 0 秒的画面上框了一块空白位置");
    expect(regionCaption(3.2 * S, ["视频“a”"])).toBe("带了框选：第 3.2 秒画面上的一块，框里有视频“a”");
    expect(regionCaption(3.2 * S, [])).toBe("带了框选：第 3.2 秒画面上的一块空白位置");
  });
});
