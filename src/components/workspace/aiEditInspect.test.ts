import { describe, expect, it } from "vitest";

import type { EditMediaSegment, EditProject, EditTextSegment, EditTrackEffectSegment } from "../../services/aiEdit";
import { clipDetail } from "./aiEditModel";
import {
  applyFieldInput, coveredRows, IN_FLIGHT_REASON, lastingReason, fieldEdit, fieldEditNow, fitsTrack, formatField, historyConfirmText, historyPanelPosition, historyStepText, inspectFields, keyedReason,
  parseFieldInput, redoneText, scrubValue, selectionSummary, settleField, shortestUs, snapToStep, strideOf, transformWith, undoneText, type FieldKey, type InspectField,
} from "./aiEditInspect";

const S = 1_000_000;
const canvas = { width: 1080, height: 1920, fps: 30 };

function video(id: string, start: number, duration: number, extra: Partial<EditMediaSegment> = {}): EditMediaSegment {
  return { id, kind: "video", path: `/m/${id}.mp4`, timeline: { start_us: start, duration_us: duration }, source: { start_us: 0, duration_us: duration }, volume: 1, speed: 1, ...extra };
}
const text = (id: string, start: number, duration: number, extra: Partial<EditTextSegment> = {}): EditTextSegment =>
  ({ id, kind: "text", text: "标题", timeline: { start_us: start, duration_us: duration }, ...extra });
const field = (fields: InspectField[], key: FieldKey) => fields.find((item) => item.key === key)!;
const value = (input: ReturnType<typeof parseFieldInput>, base: number) => (input ? applyFieldInput(input, base) : null);

describe("打进去的字怎么读", () => {
  const time = { time: true, fps: 30 };

  it("时间认秒、毫秒、帧和在现在的值上加", () => {
    expect(parseFieldInput("1.5", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("1.5s", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("500ms", time)).toEqual({ set: 0.5 });
    expect(parseFieldInput("12f", time)).toEqual({ set: 0.4 });
    expect(value(parseFieldInput("+0.5", time), 2)).toBe(2.5);
    expect(parseFieldInput("1.5 秒", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("300毫秒", time)).toEqual({ set: 0.3 });
    expect(parseFieldInput("15帧", time)).toEqual({ set: 0.5 });
  });

  it("时间码按秒:帧读；不是时间的字段不认时间单位", () => {
    expect(parseFieldInput("1:15", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("0:01:15", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("1s", {})).toBeNull();
    expect(parseFieldInput("1:15", {})).toBeNull();
  });

  it("开头的负号是负数，不是减多少", () => {
    expect(parseFieldInput("-200", { percent: 1080 })).toEqual({ set: -200 });
    expect(parseFieldInput("−200", { percent: 1080 })).toEqual({ set: -200 });
    expect(value(parseFieldInput("-200", {}), 50)).toBe(-200);
  });

  it("位置认画面宽的百分比，缩放认乘几倍", () => {
    expect(parseFieldInput("50%", { percent: 1080 })).toEqual({ set: 540 });
    expect(parseFieldInput("50%", {})).toBeNull();
    expect(value(parseFieldInput("*2", { percent: "self" }), 100)).toBe(200);
    expect(value(parseFieldInput("×2", { percent: "self" }), 100)).toBe(200);
    expect(value(parseFieldInput("*50%", { percent: "self" }), 100)).toBe(50);
    expect(parseFieldInput("150%", { percent: "self" })).toEqual({ set: 150 });
  });

  it("算式、单位和读不懂的", () => {
    expect(parseFieldInput("1440/2", {})).toEqual({ set: 720 });
    expect(parseFieldInput("(1+2)*3", {})).toEqual({ set: 9 });
    expect(parseFieldInput("2倍", { units: ["倍", "×", "x"] })).toEqual({ set: 2 });
    expect(parseFieldInput("2×", { units: ["倍", "×", "x"] })).toEqual({ set: 2 });
    expect(parseFieldInput("45°", { units: ["°", "度"] })).toEqual({ set: 45 });
    expect(parseFieldInput("1,5", time)).toEqual({ set: 1.5 });
    expect(parseFieldInput("", time)).toBeNull();
    expect(parseFieldInput("abc", time)).toBeNull();
    expect(parseFieldInput("/0", {})).toBeNull();
    expect(parseFieldInput("2*", {})).toBeNull();
  });
});

describe("什么时候算改不了", () => {
  it("上一个改动还在路上不算，AI 在剪、在导入、没有时间线算", () => {
    expect(lastingReason(IN_FLIGHT_REASON)).toBeNull();
    expect(lastingReason("AI 正在剪，等它做完再改")).toBe("AI 正在剪，等它做完再改");
    expect(lastingReason(null)).toBeNull();
  });
});

describe("拖一下走几步", () => {
  it("每 6 像素一步，⇧ 大十倍、⌥ 细十倍", () => {
    expect(scrubValue(10, 18, 1)).toBe(13);
    expect(scrubValue(10, 18, 1, { shift: true })).toBe(40);
    expect(scrubValue(10, 18, 1, { alt: true })).toBe(10.3);
    expect(scrubValue(10, -6, 1)).toBe(9);
    expect(strideOf(0.1, { shift: true })).toBe(1);
  });

  it("落在步长上，不出现浮点尾巴", () => {
    expect(snapToStep(0.30000000000000004, 0.1)).toBe(0.3);
    expect(snapToStep(1.04, 0.1)).toBe(1);
  });
});

describe("详情卡列哪些字段", () => {
  it("视频有时间、素材、倍速和画面四项；文字没有素材和倍速；特效只有时间", () => {
    const keys = (segment: Parameters<typeof inspectFields>[0]) => inspectFields(segment, { canvas, siblings: [] }).map((item) => item.key);
    expect(keys(video("a", 0, 2 * S))).toEqual(["start", "duration", "source_start", "speed", "x", "y", "scale", "rotation", "alpha"]);
    expect(keys(text("t", 0, S))).toEqual(["start", "duration", "x", "y", "scale", "rotation", "alpha"]);
    const effect: EditTrackEffectSegment = { id: "e", kind: "track_effect", effect_type: "闪白", timeline: { start_us: 0, duration_us: S } };
    expect(keys(effect)).toEqual(["start", "duration"]);
  });

  it("位置按画布像素、以中心为 0、往上为正；缩放和不透明度是百分比", () => {
    const fields = inspectFields(text("t", 0, S, { transform: { scale_x: 1.5, scale_y: 1.5, transform_x: 0.5, transform_y: -0.25, rotation: 30, alpha: 0.6, flip_horizontal: false, flip_vertical: false } }), { canvas, siblings: [] });
    expect(field(fields, "x").value).toBe(270);
    expect(field(fields, "y").value).toBe(-240);
    expect(field(fields, "scale").value).toBe(150);
    expect(field(fields, "rotation").value).toBe(30);
    expect(field(fields, "alpha").value).toBe(60);
  });

  it("开始时间拖动时只在现在的空当里走；时长不压到下一段、不超出素材", () => {
    const siblings = [video("p", 0, S), video("n", 5 * S, S)];
    const clip = video("a", 2 * S, 2 * S, { source: { start_us: S, duration_us: 2 * S } });
    const fields = inspectFields(clip, { canvas, siblings, mediaDurationUs: 3.5 * S });
    expect([field(fields, "start").min, field(fields, "start").max]).toEqual([1, 3]);
    // 下一段在 5 秒、素材从 1 秒用起只剩 2.5 秒：取小的那个
    expect(field(fields, "duration").max).toBe(2.5);
    expect(field(fields, "source_start").max).toBe(1.5);
  });

  it("倍速换算出的时长也不压到下一段、不短过最短长度", () => {
    const clip = video("a", 0, 2 * S);
    const speed = field(inspectFields(clip, { canvas, siblings: [video("n", 4 * S, S)] }), "speed");
    expect(speed.min).toBe(0.5);
    expect(speed.max).toBe(20);
    expect(speed.unit).toBe("倍");
  });

  it("最短长度不短过最后一个关键帧和淡入淡出", () => {
    expect(shortestUs(video("a", 0, 3 * S))).toBe(100_000);
    expect(shortestUs(video("a", 0, 3 * S, { keyframes: [{ property: "alpha", offset_us: 1.2 * S, value: 1 }] }))).toBe(1.2 * S);
    expect(shortestUs(video("a", 0, 3 * S, { fade: { in_duration_us: 0.5 * S, out_duration_us: 1 * S } }))).toBe(1.5 * S);
  });

  it("整段素材都用上了，素材起点改不了", () => {
    expect(field(inspectFields(video("a", 0, 2 * S), { canvas, siblings: [], mediaDurationUs: 2 * S }), "source_start").disabled).toContain("整段素材都用上了");
    expect(field(inspectFields(video("a", 0, 2 * S), { canvas, siblings: [] }), "source_start").disabled).toBeNull();
  });

  it("有关键帧的那一项改不了，写明原因；别的项照常", () => {
    const clip = video("a", 0, 2 * S, { keyframes: [{ property: "transform_x", offset_us: 0, value: 0 }, { property: "uniform_scale", offset_us: 0, value: 1 }] });
    const fields = inspectFields(clip, { canvas, siblings: [] });
    expect(field(fields, "x").disabled).toBe("这段的左右位置有关键帧动画，在这里改会被动画盖掉，导进剪映后再调");
    expect(field(fields, "y").disabled).toBeNull();
    expect(field(fields, "scale").disabled).toContain("缩放有关键帧动画");
    expect(field(fields, "rotation").disabled).toBeNull();
    // 有动画的那一项框里不写数（静态值会被动画盖掉）
    expect(field(fields, "x").animated).toBe(true);
    expect(field(fields, "y").animated).toBeUndefined();
    expect(keyedReason({ keyframes: [{ property: "rotation", offset_us: 0, value: 0 }] }, "rotation")).toContain("旋转");
    expect(keyedReason({ keyframes: [{ property: "volume", offset_us: 0, value: 0 }] }, "alpha")).toBeNull();
  });
});

describe("拖完、打完以后写什么值", () => {
  const fields = inspectFields(video("a", 2 * S, 2 * S), { canvas, siblings: [video("p", 0, S), video("n", 5 * S, S)] });

  it("时间落到帧上，再夹进范围里", () => {
    expect(settleField(field(fields, "start"), 1.51)).toEqual({ value: 1.5 });
    expect(settleField(field(fields, "start"), 0.2)).toEqual({ value: 1 });
    expect(settleField(field(fields, "duration"), 9)).toEqual({ value: 3 });
  });

  it("打进去的开始时间可以挪到别的空当里，放不下就说原因，不替人另找位置", () => {
    expect(settleField(field(fields, "start"), 6.5, true)).toEqual({ value: 6.5 });
    expect(settleField(field(fields, "start"), 4.5, true)).toEqual({ refused: "这里放不下，会和这条轨道上别的片段叠在一起" });
    // 拖动、方向键不跳出去，夹在空当里
    expect(settleField(field(fields, "start"), 6.5)).toEqual({ value: 3 });
  });

  it("其他字段按显示的位数取整、夹进范围", () => {
    expect(settleField(field(fields, "scale"), 5000)).toEqual({ value: 2000 });
    expect(settleField(field(fields, "alpha"), 55.4)).toEqual({ value: 55 });
    expect(settleField(field(fields, "x"), -1000)).toEqual({ value: -540 });
  });

  it("显示的字去掉末尾的 0", () => {
    expect(formatField({ digits: 3 }, 2.5)).toBe("2.5");
    expect(formatField({ digits: 3 }, 1 / 30)).toBe("0.033");
    expect(formatField({ digits: 1 }, -0.01)).toBe("0");
  });

  it("放不放得下：首尾正好相接不算重叠，不能早于 0", () => {
    const siblings = [video("p", 0, S)];
    expect(fitsTrack(siblings, S, S)).toBe(true);
    expect(fitsTrack(siblings, 0.5 * S, S)).toBe(false);
    expect(fitsTrack(siblings, -1, S)).toBe(false);
  });
});

describe("改完换成哪个看板改动", () => {
  const clip = video("a", 2 * S, 2 * S, { speed: 1, source: { start_us: S, duration_us: 2 * S } });

  it("开始时间走挪动，时长、素材起点、倍速走改片段；没变就不发", () => {
    expect(fieldEdit(clip, "start", 3, canvas)).toEqual({ name: "move_clip", arguments: { clip_id: "a", start: 3 } });
    expect(fieldEdit(clip, "start", 2, canvas)).toBeNull();
    expect(fieldEdit(clip, "duration", 1.5, canvas)).toEqual({ name: "update_clip", arguments: { clip_id: "a", duration: 1.5 } });
    expect(fieldEdit(clip, "source_start", 0.5, canvas)).toEqual({ name: "update_clip", arguments: { clip_id: "a", source_start: 0.5 } });
    expect(fieldEdit(clip, "speed", 2, canvas)).toEqual({ name: "update_clip", arguments: { clip_id: "a", speed: 2 } });
    expect(fieldEdit(clip, "speed", 1, canvas)).toBeNull();
    expect(fieldEdit(text("t", 0, S), "speed", 2, canvas)).toBeNull();
  });

  it("位置大小发完整的 transform，换回半个画布为单位、往上为正", () => {
    const edit = fieldEdit(clip, "y", 480, canvas);
    expect(edit?.name).toBe("update_clip");
    expect(edit?.arguments.transform).toEqual({ scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0.5, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false });
    expect(fieldEdit(clip, "x", 0, canvas)).toBeNull();
  });

  it("缩放：等比的两边一起改；横竖不一样时保持长宽比", () => {
    const base = { scale_x: 2, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false };
    expect(transformWith(base, "scale", 100, canvas)).toMatchObject({ scale_x: 1, scale_y: 0.5 });
    expect(transformWith({ ...base, scale_x: 1 }, "scale", 150, canvas)).toMatchObject({ scale_x: 1.5, scale_y: 1.5 });
    expect(transformWith(base, "alpha", 40, canvas)).toMatchObject({ alpha: 0.4 });
    expect(transformWith(base, "rotation", 400, canvas)).toMatchObject({ rotation: 360 });
  });

  it("先 flush 了微调再提交：按回来的工程算，刚挪的位置不会被写回去", () => {
    const moved = { scale_x: 1, scale_y: 1, transform_x: 0.1, transform_y: -0.05, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false };
    const fresh = (transform: EditMediaSegment["transform"]): Pick<EditProject, "tracks" | "canvas"> => ({
      canvas, tracks: [{ id: "v1", track_type: "video", name: "v1", mute: false, segments: [video("a", 0, 2 * S, { transform })] }],
    });
    // 详情卡渲染时这段还在原位；方向键挪过以后，改缩放带上的是挪过的位置
    const edit = fieldEditNow(fresh(moved), "a", "scale", 150, canvas);
    expect(edit?.arguments.transform).toMatchObject({ transform_x: 0.1, transform_y: -0.05, scale_x: 1.5, scale_y: 1.5 });
    // 打的值正好是挪过以后的值：不发
    expect(fieldEditNow(fresh(moved), "a", "x", 54, canvas)).toBeNull();
    // 这段已经不在了（AI 删了、撤销没了）：不发
    expect(fieldEditNow(fresh(moved), "gone", "scale", 150, canvas)).toBeNull();
    expect(fieldEditNow(null, "a", "scale", 150, canvas)).toBeNull();
  });

  it("有了数值框，详情里重复的说明行不再写", () => {
    const fields = inspectFields(clip, { canvas, siblings: [] });
    const covered = coveredRows(fields);
    const rows = clipDetail(video("a", 0, 2 * S, { speed: 2, transform: { scale_x: 1.5, scale_y: 1.5, transform_x: 0.2, transform_y: 0, rotation: 10, alpha: 0.5, flip_horizontal: false, flip_vertical: false } })).rows.map((row) => row.label);
    // 数值框盖住的说明行都真的出现在详情里（详情改了说法时这里会报）
    for (const label of covered) expect(rows).toContain(label);
    expect(covered.has("音量")).toBe(false);
  });
});

describe("多选卡片和操作历史", () => {
  it("多选时按种类说选中了什么", () => {
    expect(selectionSummary([{ kind: "video" }, { kind: "text" }, { kind: "video" }])).toBe("选中的是 2 段视频和 1 段文字");
    expect(selectionSummary([{ kind: "audio" }])).toBe("选中的是 1 段音频");
    expect(selectionSummary([{ kind: "video" }, { kind: "text" }, { kind: "audio" }])).toBe("选中的是 1 段视频、1 段文字和 1 段音频");
  });

  it("历史里 AI 那一轮说做了什么，不说「之前」", () => {
    expect(historyStepText({ label: "AI 处理“把开头剪短”之前", kind: "turn" })).toBe("AI 处理“把开头剪短”");
    expect(historyStepText({ label: "AI 处理“加字幕”之前" })).toBe("AI 处理“加字幕”");
    expect(historyStepText({ label: "退回", kind: "revert" })).toBe("退回到某句话之前");
    expect(historyStepText({ label: "挪动了 3 段", kind: "edit" })).toBe("挪动了 3 段");
  });

  it("撤销、重做的提示说做了什么：AI 那一轮不带「之前」，不会说成「之前”之前」", () => {
    expect(undoneText({ label: "AI 处理“把开头剪短”之前", kind: "turn" }, 1)).toBe("已撤销：AI 处理“把开头剪短”");
    expect(undoneText({ label: "AI 处理“加字幕”之前", kind: "turn" }, 3)).toBe("已撤销 3 步，回到了「AI 处理“加字幕”」之前");
    expect(undoneText({ label: "删了 2 段", kind: "edit" }, 1)).toBe("已撤销：删了 2 段");
    expect(undoneText({ label: "挪动了 3 段", kind: "edit" }, 2)).toBe("已撤销 2 步，回到了「挪动了 3 段」之前");
    // 重做那一步只带说法
    expect(redoneText("AI 处理“加字幕”之前")).toBe("已重做：AI 处理“加字幕”");
    expect(redoneText("切开了 1 段")).toBe("已重做：切开了 1 段");
  });

  it("点更早的一行先说会连着撤几步", () => {
    const steps = [{ label: "删了 2 段", kind: "edit" as const }, { label: "AI 处理“剪短”之前", kind: "turn" as const }];
    expect(historyConfirmText(steps, 1)).toBe("会连着撤销最近的 2 步，回到「AI 处理“剪短”」之前。之后没再改的话，按重做能一步步找回来。");
    expect(historyConfirmText(steps, 5)).toBe("");
  });

  it("面板放在按钮下面、右边对齐，夹进窗口", () => {
    expect(historyPanelPosition({ right: 900, bottom: 60 }, { width: 1200, height: 800 })).toEqual({ left: 632, top: 66, maxHeight: 440 });
    expect(historyPanelPosition({ right: 100, bottom: 60 }, { width: 1200, height: 300 })).toEqual({ left: 8, top: 66, maxHeight: 216 });
    expect(historyPanelPosition({ right: 1300, bottom: 60 }, { width: 1200, height: 800 }).left).toBe(924);
    // 时间线工具栏上的按钮在下半截：往上开，底边贴着按钮
    expect(historyPanelPosition({ right: 400, top: 600, bottom: 628 }, { width: 1200, height: 800 })).toEqual({ left: 132, bottom: 206, maxHeight: 440 });
    expect(historyPanelPosition({ right: 400, top: 100, bottom: 128 }, { width: 1200, height: 800 })).toEqual({ left: 132, top: 134, maxHeight: 440 });
  });
});
