import { describe, expect, it } from "vitest";

import type { EditTransform } from "../../services/aiEdit";
import { IDENTITY_TRANSFORM } from "./aiEditModel";
import {
  addNudge, arrowDelta, doubleClickAim, frameAabb, frameOf, gestureStep, insideFrame, isDefaultPlacement, isIdentityTransform, keepPress, keyframeLocks, lockNote, moveDelta,
  moveHint, movedTransform, nearestAnchor, nudgedTransform, pickHit, pivotCenter, resetPlacement, resizeCursor, resizedSize, rotateCursor, sameGuides, sameTransform,
  scaledTransform, scaleHint, snapMove, STAGE_PAD, stageHits, stagePoint, stageScale, turnedRotation, turnHint, visibleFrame, wrapDeg, type StageFrame, type StageGesture,
} from "./aiEditStageEdit";

const stage = { width: 400, height: 800 };
const canvas = { width: 1080, height: 2160 };
const t = (extra: Partial<EditTransform> = {}): EditTransform => ({ ...IDENTITY_TRANSFORM, ...extra });
const close = (value: number, expected: number, digits = 6) => expect(value).toBeCloseTo(expected, digits);

describe("框按中心、宽高、角度算", () => {
  it("中心跟着位移走（y 向上为正），宽高乘缩放", () => {
    expect(frameOf(stage, { width: 200, height: 100 }, t({ transform_x: 0.5, transform_y: 0.25, scale_x: 2, scale_y: 0.5, rotation: 30 })))
      .toEqual({ cx: 300, cy: 300, w: 400, h: 50, r: 30 });
  });

  it("裁剪过的按留下的部分画，偏移先翻转再跟着转", () => {
    const frame: StageFrame = { cx: 100, cy: 100, w: 200, h: 100, r: 0 };
    // 只留右半边
    const crop = { upper_left_x: 0.5, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0.5, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 };
    expect(visibleFrame(frame, crop)).toEqual({ cx: 150, cy: 100, w: 100, h: 100, r: 0 });
    // 左右翻转后留下的那半边在左边
    expect(visibleFrame(frame, crop, true)).toEqual({ cx: 50, cy: 100, w: 100, h: 100, r: 0 });
    // 转 90° 后往右的偏移变成往下
    const turned = visibleFrame({ ...frame, r: 90 }, crop);
    close(turned.cx, 100);
    close(turned.cy, 150);
    // 没裁就是原框
    expect(visibleFrame(frame, { ...crop, upper_left_x: 0, lower_left_x: 0 })).toBe(frame);
  });

  it("画面四周留出手柄的地方：竖屏工程按高度定、上下各让 STAGE_PAD，放不下时不画", () => {
    // 1000×800 的地方放 1080×1920：按高度 (800 − 40) / 1920
    const scale = stageScale({ width: 1000, height: 800 }, { width: 1080, height: 1920 });
    close(scale, 760 / 1920);
    expect(1920 * scale + 2 * STAGE_PAD).toBeCloseTo(800, 6);
    // 横屏工程按宽度定，左右各让 STAGE_PAD
    close(stageScale({ width: 640, height: 600 }, { width: 1920, height: 1080 }), 600 / 1920);
    expect(stageScale({ width: 40, height: 600 }, { width: 1080, height: 1920 })).toBe(0);
    expect(stageScale({ width: 0, height: 0 }, { width: 1080, height: 1920 })).toBe(0);
  });

  it("insideFrame 按转过的框判断", () => {
    const frame: StageFrame = { cx: 100, cy: 100, w: 200, h: 20, r: 0 };
    expect(insideFrame(frame, 190, 105)).toBe(true);
    expect(insideFrame(frame, 100, 130)).toBe(false);
    const upright = { ...frame, r: 90 };
    expect(insideFrame(upright, 190, 105)).toBe(false);
    expect(insideFrame(upright, 105, 190)).toBe(true);
    // 45° 的细长条：对角线方向上的点在里面，同样远的水平方向不在
    const diagonal = { ...frame, r: 45 };
    expect(insideFrame(diagonal, 160, 160)).toBe(true);
    expect(insideFrame(diagonal, 185, 100)).toBe(false);
  });

  it("外接框包住转过的框", () => {
    const box = frameAabb({ cx: 0, cy: 0, w: 100, h: 0, r: 90 });
    close(box.w, 0);
    close(box.h, 100);
    close(box.y, -50);
  });
});

describe("点选", () => {
  const layers = [
    { id: "bg", trackIndex: 0, frame: { cx: 200, cy: 400, w: 400, h: 800, r: 0 }, alpha: 1 },
    { id: "title", trackIndex: 1, frame: { cx: 200, cy: 200, w: 100, h: 40, r: 0 }, alpha: 1 },
    { id: "logo", trackIndex: 2, frame: { cx: 200, cy: 200, w: 100, h: 40, r: 0 }, alpha: 1 },
    { id: "ghost", trackIndex: 3, frame: { cx: 200, cy: 200, w: 10, h: 10, r: 0 }, alpha: 0 },
  ];

  it("小的排前面，一样大时上层的排前面，看不见的不算", () => {
    expect(stageHits(layers, 200, 200)).toEqual(["logo", "title", "bg"]);
    expect(stageHits(layers, 20, 700)).toEqual(["bg"]);
    expect(stageHits(layers, 500, 700)).toEqual([]);
  });

  it("Alt 从现在选中的往下轮，到底回到第一个", () => {
    const hits = ["logo", "title", "bg"];
    expect(pickHit(hits, "bg", false)).toBe("logo");
    expect(pickHit(hits, "logo", true)).toBe("title");
    expect(pickHit(hits, "bg", true)).toBe("logo");
    expect(pickHit(hits, "other", true)).toBe("logo");
    expect(pickHit([], "bg", true)).toBeNull();
  });
});

describe("画面吸附", () => {
  const canvasBox = { x: 0, y: 0, w: 400, h: 800 };

  it("最近的边或中线在范围里才吸，距离一样时画布胜出", () => {
    expect(nearestAnchor([197], "x", [canvasBox], 6)).toEqual({ delta: 3, at: 200 });
    expect(nearestAnchor([190], "x", [canvasBox], 6)).toBeNull();
    // 另一个片段的左边也在 200：一样近时排在前面的画布胜出（at 一样，看 delta 也一样，所以比较对象）
    const other = { x: 203, y: 0, w: 50, h: 50 };
    expect(nearestAnchor([200], "x", [canvasBox, other], 6)).toEqual({ delta: 0, at: 200 });
    expect(nearestAnchor([201.5], "x", [canvasBox, other], 6)).toEqual({ delta: -1.5, at: 200 });
  });

  it("两个轴分开吸，给的是补正量和参考线", () => {
    const hit = snapMove({ x: 148, y: 310, w: 100, h: 100 }, [canvasBox], 6);
    // 中线 198 → 200，横向没东西可吸
    expect(hit).toEqual({ dx: 2, dy: 0, guides: [{ axis: "x", at: 200 }] });
    expect(sameGuides(hit.guides, [{ axis: "x", at: 200 }])).toBe(true);
    expect(sameGuides(hit.guides, [])).toBe(false);
  });

  it("转过角度的不吸，Alt 临时不吸，Shift 只沿一个轴挪", () => {
    const frame: StageFrame = { cx: 100, cy: 100, w: 100, h: 100, r: 0 };
    expect(moveDelta(frame, { x: 97, y: 0 }, { shift: false, alt: false }, [canvasBox])).toEqual({ dx: 100, dy: 0, guides: [{ axis: "x", at: 200 }] });
    expect(moveDelta({ ...frame, r: 10 }, { x: 97, y: 0 }, { shift: false, alt: false }, [canvasBox]).dx).toBe(97);
    expect(moveDelta(frame, { x: 97, y: 0 }, { shift: false, alt: true }, [canvasBox]).dx).toBe(97);
    // Shift：横着挪得多就锁住上下，上下那个轴也不跟着吸
    const locked = moveDelta(frame, { x: 97, y: 30 }, { shift: true, alt: false }, [canvasBox]);
    expect(locked).toEqual({ dx: 100, dy: 0, guides: [{ axis: "x", at: 200 }] });
  });
});

describe("换算回 transform", () => {
  it("挪动：以半个画布为单位，往下拖 transform_y 变小，限在 -1..1", () => {
    expect(movedTransform(t(), 100, 200, stage)).toMatchObject({ transform_x: 0.5, transform_y: -0.5 });
    expect(movedTransform(t({ transform_x: 0.9 }), 100, 0, stage).transform_x).toBe(1);
  });

  it("拖角的比例 k = (w·w0 + h·h0) / (w0² + h0²)，以中心时位移算两倍", () => {
    const frame: StageFrame = { cx: 200, cy: 400, w: 200, h: 100, r: 0 };
    const se = { hx: 1, hy: 1 } as const;
    // 对角不动：右下角往右拖 20 → w=220, h=100，k = (220·200 + 100·100) / (200² + 100²) = 1.08
    const pivot = resizedSize(frame, se, { x: 20, y: 0 }, { proportional: true, fromCenter: false });
    close(pivot.w, 216);
    close(pivot.h, 108);
    // 以中心：同样拖 20，两边一起动
    const center = resizedSize(frame, se, { x: 20, y: 0 }, { proportional: true, fromCenter: true });
    close(center.w / frame.w, 1.16);
    // 框转了 90°：屏幕上往下拖是框自己的往右
    const turned = resizedSize({ ...frame, r: 90 }, se, { x: 0, y: 20 }, { proportional: true, fromCenter: false });
    close(turned.w, 216);
    // 不等比：只拉一个轴
    expect(resizedSize(frame, { hx: 1, hy: 0 }, { x: 20, y: 50 }, { proportional: false, fromCenter: false })).toEqual({ w: 220, h: 100 });
  });

  it("pivotCenter：对角不动时中心往拖的方向挪一半", () => {
    const frame: StageFrame = { cx: 200, cy: 400, w: 200, h: 100, r: 0 };
    expect(pivotCenter(frame, { w: 220, h: 110 }, { hx: -1, hy: -1 })).toEqual({ x: 210, y: 405 });
    const turned = pivotCenter({ ...frame, r: 90 }, { w: 220, h: 110 }, { hx: -1, hy: -1 });
    close(turned.x, 195);
    close(turned.y, 410);
  });

  it("以中心缩放只改缩放；对角不动时位置跟着挪（y 向上），缩放夹在 0.05..20", () => {
    const frame: StageFrame = { cx: 200, cy: 400, w: 200, h: 100, r: 0 };
    const drag = { base: t(), frame0: frame, center0: { x: 200, y: 400 }, handle: { hx: 1, hy: 1 } as const, stage };
    const centered = scaledTransform(drag, { x: 20, y: 0 }, { proportional: true, fromCenter: true });
    expect(centered.transform).toMatchObject({ scale_x: 1.16, scale_y: 1.16, transform_x: 0, transform_y: 0 });
    // 对角不动：新中心 (208, 404) → transform_x = 8/200，transform_y = -4/400
    const pinned = scaledTransform(drag, { x: 20, y: 0 }, { proportional: true, fromCenter: false });
    expect(pinned.transform).toMatchObject({ scale_x: 1.08, scale_y: 1.08, transform_x: 0.04, transform_y: -0.01 });
    // 往里拖过头：等比时两个轴一起夹
    const tiny = scaledTransform({ ...drag, base: t({ scale_x: 0.1, scale_y: 1 }) }, { x: -500, y: -500 }, { proportional: true, fromCenter: true });
    expect(tiny.transform.scale_x).toBe(0.05);
    expect(tiny.transform.scale_y).toBe(0.5);
    // 裁剪过：片段中心在框中心左边 50，对角缩放时这段偏移也跟着放大
    const cropped = scaledTransform({ ...drag, center0: { x: 150, y: 400 } }, { x: 20, y: 0 }, { proportional: true, fromCenter: false });
    expect(cropped.transform.transform_x).toBe(round4((208 - 54 - 200) / 200));
  });

  it("旋转：跟着指针转过的角度走，Shift 吸 15°，规整到 ±180", () => {
    const center = { x: 0, y: 0 };
    close(turnedRotation(center, { x: 10, y: 0 }, { x: 0, y: 10 }, 0, false), 90);
    expect(turnedRotation(center, { x: 10, y: 0 }, { x: 10, y: 2 }, 0, true)).toBe(15);
    expect(turnedRotation(center, { x: 10, y: 0 }, { x: -10, y: 1 }, 100, false)).toBeCloseTo(-85.7, 1);
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-180)).toBe(-180);
    expect(wrapDeg(400)).toBe(40);
    expect(wrapDeg(-0.01)).toBe(0);
    expect(wrapDeg(12.345)).toBe(12.3);
  });
});

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

describe("一次拖动", () => {
  const frame0: StageFrame = { cx: 200, cy: 400, w: 200, h: 100, r: 0 };
  const gesture = (extra: Partial<StageGesture> = {}): StageGesture => ({
    kind: "move", id: "a", base: t(), frame0, center0: { x: 200, y: 400 }, handle: { hx: 1, hy: 1 }, stage, start: { x: 200, y: 400 },
    targets: [{ x: 0, y: 0, w: 400, h: 800 }], canvas, stretchable: true, pivotLocked: false, ...extra,
  });

  it("挪动带吸附和数值提示（画布像素，往上为正）", () => {
    const step = gestureStep(gesture(), { x: 302, y: 300 }, { shift: false, alt: false });
    // 左边挪到 202 → 吸到画布中线 200（右边 402 → 400 一样近，先找到的胜出）
    expect(step.transform.transform_x).toBe(0.5);
    expect(step.guides).toEqual([{ axis: "x", at: 200 }]);
    expect(step.text).toBe("左右 +270 · 上下 +270");
  });

  it("吸附范围可以换算：范围比离中线的距离小就不吸", () => {
    expect(gestureStep(gesture(), { x: 302, y: 300 }, { shift: false, alt: false }, 1).guides).toEqual([]);
    expect(gestureStep(gesture(), { x: 302, y: 300 }, { shift: false, alt: false }, 1).transform.transform_x).toBe(0.51);
    expect(gestureStep(gesture(), { x: 302, y: 300 }, { shift: false, alt: false }, 3).guides).toEqual([{ axis: "x", at: 200 }]);
  });

  it("拖到一半画面挪了位置、变了大小（详情卡出来），片段仍跟着指针", () => {
    // 按下时舞台在屏幕 (300, 0)、400×800，按在片段中心
    const before = { left: 300, top: 0, width: 400, height: 800 };
    const start = stagePoint({ clientX: 500, clientY: 400 }, before);
    expect(start).toEqual({ x: 200, y: 400 });
    const drag = gesture({ start });
    const free = { shift: false, alt: true };
    // 竖屏：舞台大小不变、整体左移 145
    const shifted = { ...before, left: 155 };
    const p1 = stagePoint({ clientX: 400, clientY: 400 }, shifted, stage);
    const t1 = gestureStep(drag, p1, free).transform;
    const f1 = frameOf(stage, { width: 200, height: 100 }, t1);
    close(shifted.left + f1.cx, 400);
    // 横屏：舞台缩成 300×600、挪到 (50, 100)：按开始时的像素算，画到新舞台上中心正好在指针下面
    const shrunk = { left: 50, top: 100, width: 300, height: 600 };
    const p2 = stagePoint({ clientX: 290, clientY: 460 }, shrunk, stage);
    expect(p2).toEqual({ x: 320, y: 480 });
    const t2 = gestureStep(drag, p2, free).transform;
    const f2 = frameOf({ width: 300, height: 600 }, { width: 150, height: 75 }, t2);
    close(shrunk.left + f2.cx, 290);
    close(shrunk.top + f2.cy, 460);
  });

  it("拖角默认以中心等比，Shift 不等比；文字永远等比；有位置关键帧时 Alt 不对角", () => {
    const scale = gesture({ kind: "scale", start: { x: 300, y: 450 } });
    const even = gestureStep(scale, { x: 320, y: 450 }, { shift: false, alt: false });
    expect(even.transform).toMatchObject({ scale_x: 1.16, scale_y: 1.16, transform_x: 0 });
    expect(even.text).toBe("116%");
    const loose = gestureStep(scale, { x: 320, y: 450 }, { shift: true, alt: false });
    expect(loose.transform).toMatchObject({ scale_x: 1.2, scale_y: 1 });
    expect(loose.text).toBe("宽 120% · 高 100%");
    expect(gestureStep({ ...scale, stretchable: false }, { x: 320, y: 450 }, { shift: true, alt: false }).transform.scale_y).toBe(1.16);
    expect(gestureStep(scale, { x: 320, y: 450 }, { shift: false, alt: true }).transform.transform_x).toBe(0.04);
    expect(gestureStep({ ...scale, pivotLocked: true }, { x: 320, y: 450 }, { shift: false, alt: true }).transform.transform_x).toBe(0);
  });

  it("拖边默认只拉一个轴，Shift 等比", () => {
    const edge = gesture({ kind: "scale", handle: { hx: 1, hy: 0 }, start: { x: 300, y: 400 } });
    expect(gestureStep(edge, { x: 320, y: 420 }, { shift: false, alt: false }).transform).toMatchObject({ scale_x: 1.2, scale_y: 1 });
    expect(gestureStep(edge, { x: 320, y: 420 }, { shift: true, alt: false }).transform).toMatchObject({ scale_x: 1.2, scale_y: 1.2 });
  });

  it("旋转显示整数度数", () => {
    const step = gestureStep(gesture({ kind: "rotate", start: { x: 300, y: 400 } }), { x: 200, y: 300 }, { shift: false, alt: false });
    expect(step.transform.rotation).toBe(-90);
    expect(step.text).toBe("−90°");
    expect(turnHint(15.4)).toBe("15°");
  });
});

describe("提示文字", () => {
  it("挪动、缩放", () => {
    expect(moveHint(t({ transform_x: -0.25, transform_y: 0 }), canvas)).toBe("左右 −135 · 上下 0");
    expect(scaleHint(t({ scale_x: 1.2, scale_y: 1.2 }))).toBe("120%");
  });
});

describe("关键帧挡住的手势", () => {
  it("按属性分开挡，写一句原因", () => {
    expect(keyframeLocks({ keyframes: [{ property: "position_x" }] })).toEqual({ move: true, scale: false, rotate: false });
    expect(keyframeLocks({ keyframes: [{ property: "uniform_scale" }, { property: "rotation" }, { property: "alpha" }] })).toEqual({ move: false, scale: true, rotate: true });
    expect(keyframeLocks({})).toEqual({ move: false, scale: false, rotate: false });
    expect(lockNote({ move: true, scale: false, rotate: false })).toBe("这段的位置有关键帧动画，画面上不能直接拖，导进剪映后再调");
    expect(lockNote({ move: false, scale: false, rotate: true })).toBe("这段的角度有关键帧动画，画面上不能直接转，导进剪映后再调");
    expect(lockNote({ move: true, scale: true, rotate: true })).toBe("这段的位置、大小和角度有关键帧动画，画面上不能直接改，导进剪映后再调");
    expect(lockNote({ move: false, scale: false, rotate: false })).toBeNull();
  });
});

describe("方向键微调", () => {
  it("连按先在本地累加，停手后一次换算成 transform；换了一段从头记", () => {
    let held = null as ReturnType<typeof addNudge> | null;
    for (let index = 0; index < 20; index += 1) held = addNudge(held, "a", t(), arrowDelta("right", false).x, 0);
    held = addNudge(held, "a", t({ transform_x: 0.9 }), 0, arrowDelta("up", true).y);
    expect(held).toEqual({ id: "a", base: t(), dx: 20, dy: -10 });
    // 画布 1080×2160：右 20 像素是 20/540，上 10 像素是 10/1080
    expect(nudgedTransform(held!, canvas)).toMatchObject({ transform_x: round4(20 / 540), transform_y: round4(10 / 1080) });
    expect(addNudge(held, "b", t(), -1, 0)).toEqual({ id: "b", base: t(), dx: -1, dy: 0 });
  });
});

describe("其他", () => {
  it("transform 比较和是不是原样", () => {
    expect(sameTransform(t({ transform_x: 0.10001 }), t({ transform_x: 0.1 }))).toBe(true);
    expect(sameTransform(t({ flip_horizontal: true }), t())).toBe(false);
    expect(isIdentityTransform(null)).toBe(true);
    expect(isIdentityTransform(t({ rotation: 5 }))).toBe(false);
  });

  it("重置位置、大小和角度：不透明度和翻转留着；只调过这两样的不算要重置", () => {
    const moved = t({ transform_x: 0.3, transform_y: -0.2, scale_x: 1.5, scale_y: 0.8, rotation: 30, alpha: 0.4, flip_horizontal: true });
    expect(resetPlacement(moved)).toEqual(t({ alpha: 0.4, flip_horizontal: true }));
    expect(isDefaultPlacement(moved)).toBe(false);
    expect(isDefaultPlacement(t({ rotation: 5 }))).toBe(false);
    // 只调过不透明度、翻转：没东西可重置，菜单项置灰
    expect(isDefaultPlacement(t({ alpha: 0.5, flip_vertical: true }))).toBe(true);
    expect(isDefaultPlacement(null)).toBe(true);
    // 重置完还带着不透明度、翻转的要发新的 transform；全是默认的才清掉
    expect(isIdentityTransform(resetPlacement(moved))).toBe(false);
    expect(isIdentityTransform(resetPlacement(t({ scale_x: 2, scale_y: 2 })))).toBe(true);
    expect(resetPlacement(null)).toEqual(t());
  });

  it("缩放光标按角度挑，转过 90° 上边变成左右拖；旋转光标按 15° 缓存", () => {
    expect(resizeCursor(45)).toBe("nwse-resize");
    expect(resizeCursor(90)).toBe("ns-resize");
    expect(resizeCursor(90 + 90)).toBe("ew-resize");
    expect(resizeCursor(135 - 180)).toBe("nesw-resize");
    const cursor = rotateCursor(10, "#fff", "#000");
    expect(cursor).toBe(rotateCursor(14, "#fff", "#000"));
    expect(decodeURIComponent(cursor)).toContain("rotate(15 12 12)");
    expect(cursor.endsWith(", crosshair")).toBe(true);
  });

  it("双击瞄第一下按的位置：屏幕上同一处、画面挪了也认", () => {
    let presses = keepPress([], { x: 10, y: 10, clientX: 10, clientY: 10, at: 0 });
    presses = keepPress(presses, { x: 50, y: 50, clientX: 500, clientY: 300, at: 1000 });
    // 第一下打开了详情卡、画面左移：第二下在屏幕上没动，落在画布上却是另一处
    presses = keepPress(presses, { x: 180, y: 50, clientX: 502, clientY: 301, at: 1200 });
    expect(presses).toHaveLength(2);
    const first = { x: 50, y: 50, clientX: 500, clientY: 300, at: 1000 };
    expect(doubleClickAim(presses, 1300)).toEqual(first);
    // 第二下刚按下时也认得出（点选照第一下的位置算）
    expect(doubleClickAim(presses, 1200)).toEqual(first);
    expect(doubleClickAim(presses, 1800)).toBeNull();
    expect(doubleClickAim(presses.slice(-1), 1300)).toBeNull();
    // 很快地先后点了屏幕上两处：不是双击
    const apart = keepPress(presses.slice(0, 1), { x: 180, y: 50, clientX: 540, clientY: 300, at: 1200 });
    expect(doubleClickAim(apart, 1200)).toBeNull();
  });
});
