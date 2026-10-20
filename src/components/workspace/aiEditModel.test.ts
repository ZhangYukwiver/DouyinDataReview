import { describe, expect, it } from "vitest";

import type { EditMediaSegment, EditProject, EditTextSegment, EditTrack } from "../../services/aiEdit";
import {
  activeFrame, blendMode, clipDetail, clipExtras, colorName, draftBoxReasonText, clipLabel, clipPosition, colorFilter, cropClipPath, cssTransform, effectiveTransform, fadeGain,
  featureName, filmstripCount, filmstripTimes, findSegment, fitBox, formatClock, formatDuration, formatTick, hasScaleKeyframes, IDENTITY_TRANSFORM, keyframeValue, layerBox, layerRect, maskCss, mediaIdFromPath,
  mediaThumbView, mediaVolume, nextSegmentAfter, pickTickStep, playbackRate, projectDuration, rgba, rulerTicks, secondMark, segmentAt, sourceTimeUs, spokenDuration, textCss,
  textFontPx, timeAtX, trackLabel, transitionReach, visibleExportNote,
} from "./aiEditModel";
import catalogJson from "../../../collector/aiEdit/catalog.json";

const S = 1_000_000;

function media(id: string, start: number, duration: number, extra: Partial<EditMediaSegment> = {}): EditMediaSegment {
  return {
    id, kind: "video", path: `/data/ai-edit/media/${id}.mp4`, timeline: { start_us: start, duration_us: duration },
    source: { start_us: 0, duration_us: duration }, volume: 1, speed: 1, fit: "contain", transform: null, crop: null,
    material_name: `${id}.mp4`, keyframes: [], effects: [], filters: [], animations: [], transition: null, fade: null, ...extra,
  };
}

function text(id: string, start: number, duration: number, extra: Partial<EditTextSegment> = {}): EditTextSegment {
  return { id, kind: "text", text: "你好", timeline: { start_us: start, duration_us: duration }, transform: null, font_size: 8, color: "#FFFFFF", alignment: "center", keyframes: [], ...extra };
}

const track = (id: string, track_type: EditTrack["track_type"], segments: EditTrack["segments"], extra: Partial<EditTrack> = {}): EditTrack =>
  ({ id, track_type, name: track_type[0]!.toUpperCase() + track_type.slice(1), mute: false, segments, ...extra });

const project = (tracks: EditTrack[]): EditProject => ({
  id: "p", name: "测试", canvas: { width: 1080, height: 1920, fps: 30 }, created_at: "", updated_at: "", revision: 1, tracks, markers: [],
});

describe("工程时长与活动片段", () => {
  const main = track("v1", "video", [media("a", 0, 2 * S), media("b", 2 * S, 3 * S)]);
  const overlay = track("v2", "video", [media("c", 1 * S, 1 * S, { kind: "image", path: "/m/c.png" })]);
  const music = track("a1", "audio", [media("m", 0, 6 * S, { kind: "audio", path: "/m/m.mp3" })]);
  const words = track("t1", "text", [text("t", 4 * S, 1 * S)]);
  const subtitles = track("s1", "text", [text("s", 6 * S, 1.5 * S)], { kind: "subtitle", name: "Subtitles" });
  const filter: EditTrack = track("f1", "filter", [{ id: "f", kind: "track_filter", filter_type: "黑白", intensity: 80, timeline: { start_us: 0, duration_us: S } }]);
  const p = project([main, overlay, music, words, subtitles, filter]);

  it("总时长取所有轨道（含字幕）里最晚的结尾", () => {
    expect(projectDuration(p)).toBe(7.5 * S);
    expect(projectDuration(project([]))).toBe(0);
    expect(projectDuration(null)).toBe(0);
  });

  it("片段区间左闭右开", () => {
    expect(segmentAt(main, 0)?.id).toBe("a");
    expect(segmentAt(main, 2 * S - 1)?.id).toBe("a");
    expect(segmentAt(main, 2 * S)?.id).toBe("b");
    expect(segmentAt(main, 5 * S)).toBeNull();
    expect(nextSegmentAfter(main, 0)?.id).toBe("b");
    expect(nextSegmentAfter(main, 2 * S)).toBeNull();
  });

  it("按轨道顺序叠放，音频和轨道滤镜分开", () => {
    const frame = activeFrame(p, 1.5 * S);
    expect(frame.visuals.map((layer) => layer.segment.id)).toEqual(["a", "c"]);
    expect(frame.visuals.map((layer) => layer.trackIndex)).toEqual([0, 1]);
    expect(frame.audios.map((layer) => layer.segment.id)).toEqual(["m"]);
    expect(activeFrame(p, 0.5 * S).overlays.map((layer) => layer.segment.id)).toEqual(["f"]);
    expect(activeFrame(p, 4.5 * S).visuals.map((layer) => layer.segment.id)).toEqual(["b", "t"]);
    expect(activeFrame(p, 6.2 * S).visuals.map((layer) => layer.segment.id)).toEqual(["s"]);
  });
});

describe("素材时间与倍速", () => {
  it("source.start + (t - timeline.start) × speed", () => {
    const segment = media("a", 10 * S, 2 * S, { source: { start_us: 3 * S, duration_us: 4 * S }, speed: 2 });
    expect(sourceTimeUs(segment, 10 * S)).toBe(3 * S);
    expect(sourceTimeUs(segment, 11 * S)).toBe(5 * S);
    // 夹在片段和素材区间里
    expect(sourceTimeUs(segment, 9 * S)).toBe(3 * S);
    expect(sourceTimeUs(segment, 30 * S)).toBe(7 * S);
  });

  it("playbackRate 夹在浏览器能放的范围", () => {
    expect(playbackRate(0.5)).toBe(0.5);
    expect(playbackRate(100)).toBe(16);
    expect(playbackRate(0.01)).toBe(0.0625);
    expect(playbackRate(Number.NaN)).toBe(1);
  });
});

describe("关键帧", () => {
  const keyframes = [
    { property: "alpha", offset_us: 0, value: 0 },
    { property: "alpha", offset_us: 2 * S, value: 1 },
    { property: "uniform_scale", offset_us: S, value: 2 },
    { property: "transform_x", offset_us: 0, value: -1 },
  ];

  it("两帧之间线性插值，两头取最近一帧", () => {
    expect(keyframeValue(keyframes, "alpha", S)).toBeCloseTo(0.5);
    expect(keyframeValue(keyframes, "alpha", -5)).toBe(0);
    expect(keyframeValue(keyframes, "alpha", 9 * S)).toBe(1);
    expect(keyframeValue(keyframes, "rotation", S)).toBeNull();
    expect(keyframeValue(undefined, "alpha", 0)).toBeNull();
  });

  it("关键帧覆盖静态变换，等比缩放同时改两个方向", () => {
    const transform = effectiveTransform({ transform: { ...IDENTITY_TRANSFORM, rotation: 30, transform_y: 0.5 }, keyframes }, S);
    expect(transform).toMatchObject({ alpha: 0.5, scale_x: 2, scale_y: 2, transform_x: -1, transform_y: 0.5, rotation: 30 });
    expect(effectiveTransform({ transform: null }, 0)).toEqual(IDENTITY_TRANSFORM);
  });

  it("亮度 / 对比度 / 饱和度换成 CSS filter", () => {
    expect(colorFilter([{ property: "brightness", offset_us: 0, value: 0.2 }, { property: "saturation", offset_us: 0, value: -1 }], 0)).toBe("brightness(1.2) saturate(0)");
    expect(colorFilter([], 0)).toBe("");
  });
});

describe("摆放", () => {
  const stage = { width: 108, height: 192 };

  it("contain / cover / stretch", () => {
    // 横屏素材进竖屏画布
    expect(fitBox(stage, { width: 1920, height: 1080 }, "contain")).toEqual({ width: 108, height: 60.75 });
    const cover = fitBox(stage, { width: 1920, height: 1080 }, "cover");
    expect(cover.width).toBeCloseTo(192 * 16 / 9);
    expect(cover.height).toBeCloseTo(192);
    expect(fitBox(stage, { width: 1920, height: 1080 }, "stretch")).toEqual(stage);
    // 比画布更窄更高的素材，cover 按宽铺满
    expect(fitBox(stage, { width: 100, height: 400 }, "cover")).toEqual({ width: 108, height: 432 });
    // 尺寸未知当作和画布同比例
    expect(fitBox(stage, null, "contain")).toEqual(stage);
  });

  it("有缩放关键帧的方向按 contain 框算，和草稿里关键帧是绝对缩放一致", () => {
    const landscape = { width: 1920, height: 1080 };
    const contain = fitBox(stage, landscape, "contain");
    const cover = fitBox(stage, landscape, "cover");
    const zoom = [{ property: "uniform_scale", offset_us: 0, value: 1 }, { property: "uniform_scale", offset_us: 3 * S, value: 1.2 }];
    // 没有缩放关键帧：照 fit
    expect(layerBox(stage, landscape, "cover", [])).toEqual(cover);
    expect(layerBox(stage, landscape, "cover", [{ property: "alpha", offset_us: 0, value: 0.5 }])).toEqual(cover);
    // cover + 缓慢放大 1.0→1.2：剪映里从 contain 大小开始放大
    expect(layerBox(stage, landscape, "cover", zoom)).toEqual(contain);
    const start = layerRect(stage, layerBox(stage, landscape, "cover", zoom), effectiveTransform({ keyframes: zoom }, 0));
    expect(start.width).toBeCloseTo(contain.width);
    const end = layerRect(stage, layerBox(stage, landscape, "cover", zoom), effectiveTransform({ keyframes: zoom }, 3 * S));
    expect(end.width).toBeCloseTo(contain.width * 1.2);
    // stretch 只有横向缩放关键帧：横向回到 contain，纵向仍拉满
    const stretchX = layerBox(stage, landscape, "stretch", [{ property: "scale_x", offset_us: 0, value: 1 }]);
    expect(stretchX).toEqual({ width: contain.width, height: stage.height });
    expect(layerBox(stage, landscape, "contain", zoom)).toEqual(contain);
    expect(hasScaleKeyframes(zoom)).toBe(true);
    expect(hasScaleKeyframes([{ property: "rotation", offset_us: 0, value: 10 }])).toBe(false);
    expect(hasScaleKeyframes(undefined)).toBe(false);
  });

  it("位移以半个画布为单位、y 向上为正", () => {
    const rect = layerRect(stage, { width: 108, height: 60 }, { ...IDENTITY_TRANSFORM, transform_x: 0.5, transform_y: 0.5, scale_x: 2, scale_y: 0.5, alpha: 1.4 });
    expect(rect.width).toBe(216);
    expect(rect.height).toBe(30);
    // 中心 (54 + 27, 96 - 48)
    expect(rect.left).toBe(81 - 108);
    expect(rect.top).toBe(48 - 15);
    expect(rect.opacity).toBe(1);
  });

  it("旋转与翻转", () => {
    expect(cssTransform({ rotation: 0, flipX: false, flipY: false })).toBe("none");
    expect(cssTransform({ rotation: 90, flipX: true, flipY: false })).toBe("rotate(90deg) scale(-1,1)");
  });

  it("裁剪四角换成 clip-path，没裁为 null", () => {
    expect(cropClipPath(null)).toBeNull();
    expect(cropClipPath({ upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 })).toBeNull();
    expect(cropClipPath({ upper_left_x: 0.1, upper_left_y: 0.2, upper_right_x: 0.9, upper_right_y: 0.2, lower_left_x: 0.1, lower_left_y: 0.8, lower_right_x: 0.9, lower_right_y: 0.8 }))
      .toBe("polygon(10% 20%, 90% 20%, 90% 80%, 10% 80%)");
  });

  it("混合模式", () => {
    expect(blendMode("滤色")).toBe("screen");
    expect(blendMode("线性加深")).toBe("multiply");
    expect(blendMode("不存在")).toBeNull();
    expect(blendMode(null)).toBeNull();
  });

  it("蒙版近似", () => {
    const element = { width: 200, height: 100 };
    const circle = maskCss({ mask_type: "圆形", size: 0.5 }, element, { width: 2000, height: 1000 });
    expect(circle?.maskImage).toBe("radial-gradient(circle 25px at 100px 50px, #000 100%, transparent 100%)");
    const inverted = maskCss({ mask_type: "圆形", size: 0.5, center_x: 500, center_y: 250, invert: true }, element, { width: 2000, height: 1000 });
    expect(inverted?.maskImage).toContain("at 150px 25px, transparent");
    // 矩形也走 mask-image（内嵌 SVG），不占 clip-path，裁剪和蒙版能同时生效
    const svgOf = (css: Record<string, string> | null) => decodeURIComponent(/^url\("data:image\/svg\+xml,(.*)"\)$/u.exec(css?.maskImage ?? "")?.[1] ?? "");
    const rect = maskCss({ mask_type: "矩形", size: 0.5, rect_width: 0.5 }, element, null);
    expect(rect?.clipPath).toBeUndefined();
    expect(rect?.WebkitMaskImage).toBe(rect?.maskImage);
    expect(rect?.maskSize).toBe("100% 100%");
    expect(svgOf(rect)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="50" y="25" width="100" height="50" rx="0" fill="#000"/></svg>');
    const fancy = svgOf(maskCss({ mask_type: "矩形", size: 0.5, rect_width: 0.5, round_corner: 50, rotation: 30, feather: 40, invert: true }, element, null));
    expect(fancy).toContain('rx="12.5"');
    expect(fancy).toContain('transform="rotate(30 100 50)"');
    expect(fancy).toContain('<feGaussianBlur stdDeviation="2.5"/>');
    expect(fancy).toContain('<mask id="m"');
    expect(fancy).toContain('fill="#000" mask="url(#m)"');
    expect(maskCss({ mask_type: "线性" }, element, null)?.maskImage).toBe("linear-gradient(0deg, transparent 50%, #000 50%)");
    expect(maskCss({ mask_type: "镜面", size: 0.4 }, element, null)?.maskImage).toBe("linear-gradient(0deg, transparent 30%, #000 30%, #000 70%, transparent 70%)");
    expect(maskCss({ mask_type: "爱心" }, element, null)).toBeNull();
    expect(maskCss(null, element, null)).toBeNull();
  });
});

describe("声音", () => {
  it("淡入淡出增益", () => {
    const segment = media("a", 0, 10 * S, { fade: { in_duration_us: 2 * S, out_duration_us: 4 * S } });
    expect(fadeGain(segment, 0)).toBe(0);
    expect(fadeGain(segment, S)).toBe(0.5);
    expect(fadeGain(segment, 5 * S)).toBe(1);
    expect(fadeGain(segment, 8 * S)).toBe(0.5);
    expect(fadeGain(media("b", 0, S), 0)).toBe(1);
  });

  it("音量：关键帧优先、浏览器最大 1、轨道静音", () => {
    expect(mediaVolume(media("a", 0, S, { volume: 0.5 }), { mute: false }, 0)).toEqual({ volume: 0.5, muted: false });
    expect(mediaVolume(media("a", 0, S, { volume: 1.8 }), { mute: false }, 0)).toEqual({ volume: 1, muted: false });
    expect(mediaVolume(media("a", 0, S), { mute: true }, 0).muted).toBe(true);
    expect(mediaVolume(media("a", 0, S, { volume: 0 }), { mute: false }, 0).muted).toBe(true);
    expect(mediaVolume(media("a", 0, S, { keyframes: [{ property: "volume", offset_us: 0, value: 0.3 }] }), { mute: false }, 0).volume).toBe(0.3);
  });
});

describe("文字", () => {
  it("字号按画布短边和舞台缩放换算", () => {
    // 真机：12 号字在竖屏 1080 宽约 75px/字，横屏 1920 宽约 133px/字
    expect(textFontPx(12, { width: 1080, height: 1920 }, 1)).toBeCloseTo(75);
    expect(textFontPx(12, { width: 1920, height: 1080 }, 1)).toBeCloseTo(133.3, 0);
    expect(textFontPx(15, { width: 1920, height: 1080 }, 0.25)).toBeCloseTo(15 * 6.25 * (1920 / 1080) * 0.25);
    expect(textFontPx(8, { width: 720, height: 1280 }, 0.5)).toBeCloseTo(8 * 6.25 * (720 / 1080) * 0.5);
  });

  it("颜色带透明度", () => {
    expect(rgba("#FF0000", 0.5)).toBe("rgba(255,0,0,0.5)");
    expect(rgba("#00000080")).toBe("rgba(0,0,0,0.502)");
    expect(rgba("坏的")).toBe("rgba(255,255,255,1)");
  });

  it("近似样式：粗体只到 600、竖排、描边、背景、阴影、换行宽度", () => {
    const css = textCss(text("t", 0, S, {
      font_size: 15, bold: true, vertical: true, alignment: "left", max_line_width: 0.5,
      border: { color: "#000000", width: 40 }, background: { color: "#FFFFFF80", round_radius: 0.5 },
      shadow: { color: "#000000", distance: 5, angle: 0, diffuse: 10 },
    }), { width: 1080, height: 1920 }, { width: 108, height: 192 });
    expect(css.fontSize).toBeCloseTo(9.38);
    expect(css.fontWeight).toBe(600);
    expect(css.writingMode).toBe("vertical-rl");
    expect(css.textAlign).toBe("left");
    expect(css.maxWidth).toBe(54);
    expect(css.WebkitTextStroke).toBe("0.94px rgba(0,0,0,1)");
    expect(css.backgroundColor).toBe("rgba(255,255,255,0.502)");
    expect(css.textShadow).toBe("0.94px 0px 0.94px rgba(0,0,0,1)");
    expect(textCss(text("t", 0, S, { auto_wrapping: false }), { width: 1080, height: 1920 }, { width: 108, height: 192 }).maxWidth).toBeUndefined();
  });
});

describe("轨道区与刻度", () => {
  it("片段像素位置，太短也至少 2px", () => {
    expect(clipPosition({ start_us: 5 * S, duration_us: 5 * S }, 20 * S, 400)).toEqual({ left: 100, width: 100 });
    expect(clipPosition({ start_us: 0, duration_us: 1 }, 20 * S, 400).width).toBe(2);
    expect(clipPosition({ start_us: 0, duration_us: S }, 0, 400)).toEqual({ left: 0, width: 0 });
  });

  it("点轨道区换算时间并夹在范围里", () => {
    expect(timeAtX(100, 400, 20 * S)).toBe(5 * S);
    expect(timeAtX(-10, 400, 20 * S)).toBe(0);
    expect(timeAtX(900, 400, 20 * S)).toBe(20 * S);
  });

  it("刻度间隔随密度变", () => {
    expect(pickTickStep(1000)).toBe(0.1);
    expect(pickTickStep(64)).toBe(1);
    expect(pickTickStep(20)).toBe(5);
    expect(pickTickStep(0.001)).toBe(3600);
    const ticks = rulerTicks(10 * S, 640);
    expect(ticks.map((tick) => tick.label)).toEqual(["0:00", "0:01", "0:02", "0:03", "0:04", "0:05", "0:06", "0:07", "0:08", "0:09", "0:10"]);
    expect(ticks[5]!.x).toBe(320);
    expect(rulerTicks(0, 640)).toEqual([]);
  });

  it("时间格式", () => {
    expect(formatClock(3_250_000)).toBe("0:03.2");
    expect(formatClock(3_725_400_000)).toBe("1:02:05.4");
    expect(formatDuration(200_000)).toBe("0:01");
    expect(formatDuration(24 * S)).toBe("0:24");
    expect(formatDuration(3_661 * S)).toBe("1:01:01");
    expect(formatTick(1_500_000, 0.5)).toBe("0:01.5");
    expect(formatTick(65 * S, 5)).toBe("1:05");
    expect(spokenDuration(500_000)).toBe("0.5 秒");
    expect(spokenDuration(80 * S)).toBe("1 分 20 秒");
    expect(spokenDuration(120 * S)).toBe("2 分钟");
  });
});

describe("名称", () => {
  it("从素材库路径取素材 id（Windows 路径也行）", () => {
    expect(mediaIdFromPath("/Users/x/ai-edit/media/abc123.mp4")).toBe("abc123");
    expect(mediaIdFromPath("C:\\data\\ai-edit\\media\\def.MOV")).toBe("def");
    expect(mediaIdFromPath("")).toBeNull();
  });

  it("默认英文轨道名换成中文，AI 起的名字照原样", () => {
    expect(trackLabel({ name: "Video", track_type: "video" })).toBe("视频");
    expect(trackLabel({ name: "Subtitles", track_type: "text", kind: "subtitle" })).toBe("字幕");
    expect(trackLabel({ name: "背景音乐", track_type: "audio" })).toBe("背景音乐");
  });

  it("片段块文字与附加信息", () => {
    expect(clipLabel(media("a", 0, S, { material_name: "旅行.mp4" }))).toBe("旅行");
    expect(clipLabel(media("a", 0, S), "抖音标题")).toBe("抖音标题");
    expect(clipLabel(text("t", 0, S, { text: "第一行\n第二行" }))).toBe("第一行 第二行");
    expect(clipLabel({ id: "f", kind: "track_filter", filter_type: "黑白", intensity: 60, timeline: { start_us: 0, duration_us: S } })).toBe("黑白 60%");
    expect(clipExtras(media("a", 0, S, {
      speed: 2, volume: 0, transition: { transition_type: "叠化", duration_us: 500_000 }, fade: { in_duration_us: 500_000, out_duration_us: 0 },
      keyframes: [{ property: "alpha", offset_us: 0, value: 1 }],
    }))).toEqual(["2 倍速", "静音", "转场 叠化", "淡入 0.5 秒", "1 个关键帧"]);
  });
});

describe("剪映效果名", () => {
  // 工程里存的是 pyJianYingDraft 枚举成员名；界面上要和剪映里看到的名字一致，逐个对照采集器的目录
  const catalog = catalogJson as unknown as { enums: Record<string, Array<{ name: string; meta: { name?: string; title?: string } }>> };
  const SHOWN = [
    "VideoSceneEffectType", "VideoCharacterEffectType", "FilterType", "TransitionType", "IntroType", "OutroType", "GroupAnimationType",
    "TextIntro", "TextOutro", "TextLoopAnim", "MaskType", "AudioSceneEffectType",
  ];
  const tidy = (value: string) => value.replace(/\s+/gu, " ").trim();

  it("成员名换成剪映里的显示名，已经是显示名的不动", () => {
    const wrong: string[] = [];
    for (const enumName of SHOWN) {
      for (const member of catalog.enums[enumName] ?? []) {
        const shown = tidy(member.meta.name ?? member.meta.title ?? member.name);
        if (featureName(member.name) !== shown) wrong.push(`${enumName}.${member.name} → ${featureName(member.name)}（应为 ${shown}）`);
        if (featureName(shown) !== shown) wrong.push(`${enumName} 显示名 ${shown} 被改成 ${featureName(shown)}`);
      }
    }
    expect(catalog.enums.FilterType?.length).toBeGreaterThan(1000);
    expect(wrong).toEqual([]);
  });

  it("片段块、提示文字里不露出 _1998、Lofi_II 这类原始名字", () => {
    const span = { start_us: 0, duration_us: S };
    expect(clipLabel({ id: "e", kind: "track_effect", effect_type: "_1998", timeline: span })).toBe("1998");
    expect(clipLabel({ id: "f", kind: "track_filter", filter_type: "Lofi_II", intensity: 60, timeline: span })).toBe("Lofi II 60%");
    expect(clipExtras(media("a", 0, S, {
      transition: { transition_type: "_3D空间", duration_us: 500_000 },
      effects: [{ effect_type: "彩虹_情人节" }], filters: [{ filter_type: "_1980" }], animations: [{ animation_type: "_2024" }],
    }))).toEqual(["转场 3D空间", "特效 彩虹-情人节", "滤镜 1980", "动画 2024"]);
    expect(featureName("叠化")).toBe("叠化");
    expect(featureName(null)).toBe("");
  });
});

describe("导入剪映的提示", () => {
  const ok = { revision: 7, tone: "ok" as const, text: "已更新剪映里的「旅行」，重新打开这份草稿就是最新的。" };

  it("工程还是导入时那一版才显示", () => {
    expect(visibleExportNote(ok, 7)).toBe(ok);
  });

  it("AI 之后又改过时间线，提示让位给「之后又改过」", () => {
    expect(visibleExportNote(ok, 10)).toBeNull();
    expect(visibleExportNote({ ...ok, tone: "warn" }, 8)).toBeNull();
  });

  it("没有提示、或者工程还没读到时不显示", () => {
    expect(visibleExportNote(null, 7)).toBeNull();
    expect(visibleExportNote(undefined, 7)).toBeNull();
    expect(visibleExportNote(ok, undefined)).toBeNull();
  });
});

describe("素材缩略图", () => {
  const cover = "https://p3-pc-sign.douyinpic.com/x.jpeg?x-expires=1700000000";
  const video = { status: "ready", kind: "video" as const, source: { cover } };

  it("有封面先用封面", () => {
    expect(mediaThumbView(video, true, null)).toEqual({ show: "cover", cover });
  });

  it("封面过期读不出来时改画本地文件的第一帧", () => {
    expect(mediaThumbView(video, true, cover)).toEqual({ show: "frame", cover: null });
    // 换了新封面地址就再试一次
    expect(mediaThumbView({ ...video, source: { cover: `${cover}&v=2` } }, true, cover).show).toBe("cover");
  });

  it("没就绪时封面读不出来就只留图标", () => {
    expect(mediaThumbView({ ...video, status: "importing" }, false, null)).toEqual({ show: "pending", cover });
    expect(mediaThumbView({ ...video, status: "importing" }, false, cover)).toEqual({ show: "pending", cover: null });
  });

  it("图片和音频不看封面", () => {
    expect(mediaThumbView({ ...video, kind: "image" }, true, null).show).toBe("image");
    expect(mediaThumbView({ ...video, kind: "audio" }, true, null).show).toBe("audio");
  });
});

describe("草稿箱状态", () => {
  it("原因码换成人话，不露出原始代码", () => {
    expect(draftBoxReasonText("index_not_found")).toBe("没找到剪映草稿箱：装好剪映、打开一次后再试。");
    expect(draftBoxReasonText("platform_unsupported")).toContain("Windows 和 macOS");
    expect(draftBoxReasonText("something_new")).toBe("没找到剪映草稿箱：装好剪映、打开一次后再试。");
    expect(draftBoxReasonText("剪映草稿箱被移走了")).toBe("剪映草稿箱被移走了");
    expect(draftBoxReasonText(null)).toContain("没找到剪映草稿箱");
  });
});

describe("片段详情", () => {
  const rows = (detail: { rows: Array<{ label: string; value: string }> }) => Object.fromEntries(detail.rows.map((row) => [row.label, row.value]));

  it("按 id 找片段和所在轨道", () => {
    const a = media("a", 0, S);
    const words = text("t", S, S);
    const p = project([track("v1", "video", [a]), track("t1", "text", [words])]);
    expect(findSegment(p, "t")).toEqual({ track: p.tracks[1], segment: words });
    expect(findSegment(p, "gone")).toBeNull();
    expect(findSegment(null, "a")).toBeNull();
    expect(findSegment(p, null)).toBeNull();
  });

  it("时间点说成第几秒", () => {
    expect(secondMark(0)).toBe("第 0 秒");
    expect(secondMark(1_500_000)).toBe("第 1.5 秒");
    expect(secondMark(65_000_000)).toBe("第 1 分 5 秒");
    expect(secondMark(120_000_000)).toBe("第 2 分 0 秒");
  });

  it("视频片段：截取区间、倍速、音量、适配、摆放、裁剪和挂着的效果都说成口语", () => {
    const segment = media("a", 2 * S, 3 * S, {
      material_name: "旅行.mp4", source: { start_us: 1.5 * S, duration_us: 1.5 * S }, speed: 0.5, change_pitch: false, volume: 0.6, fit: "cover",
      transform: { ...IDENTITY_TRANSFORM, transform_x: 0.5, transform_y: -0.2, scale_x: 1.2, scale_y: 1.2, rotation: -15, alpha: 0.8, flip_horizontal: true },
      crop: { upper_left_x: 0.1, upper_left_y: 0, upper_right_x: 0.9, upper_right_y: 0, lower_left_x: 0.1, lower_left_y: 1, lower_right_x: 0.9, lower_right_y: 1 },
      transition: { transition_type: "_3D空间", duration_us: 500_000 }, fade: { in_duration_us: 500_000, out_duration_us: S },
      effects: [{ effect_type: "_1998" }], filters: [{ filter_type: "Lofi_II", intensity: 80 }], animations: [{ animation_type: "渐显", duration_us: 500_000 }],
      mask: { mask_type: "圆形", feather: 20, invert: true }, chroma: { color: "#00FF00FF", intensity: 30 },
      background_filling: { fill_type: "blur", blur: 0.375 }, mix_mode: { mode: "滤色" },
      keyframes: [{ property: "alpha", offset_us: 0, value: 1 }, { property: "alpha", offset_us: S, value: 0 }, { property: "uniform_scale", offset_us: 500_000, value: 1.2 }],
    });
    const detail = clipDetail(segment, { mediaName: null, track: { name: "Video", track_type: "video", mute: true } });
    expect(detail.kind).toBe("视频");
    expect(detail.title).toBe("旅行");
    expect(rows(detail)).toEqual({
      所在轨道: "视频",
      时间线上: "第 2 秒到第 5 秒",
      时长: "3 秒",
      截取: "从素材第 1.5 秒截取 1.5 秒",
      速度: "放慢到 0.5 倍，声音不变调",
      音量: "60%（整条轨道已静音）",
      画面适配: "铺满画面",
      位置: "向右 25%、向下 10%（按画面宽高算）",
      缩放: "120%",
      旋转: "逆时针 15°",
      不透明度: "80%",
      翻转: "左右翻转",
      裁剪: "裁掉左边 10%、右边 10%",
      转场: "和下一段之间用「3D空间」，0.5 秒",
      淡入淡出: "开头淡入 0.5 秒，结尾淡出 1 秒",
      特效: "1998",
      滤镜: "Lofi II（强度 80%）",
      动画: "渐显（0.5 秒）",
      蒙版: "圆形，羽化 20%，反转",
      抠像: "抠掉接近绿色的部分，强度 30%",
      背景填充: "模糊背景，中度模糊",
      混合模式: "滤色",
      关键帧: "不透明度：第 2 秒、第 3 秒\n缩放：第 2.5 秒",
    });
    expect(detail.rows.find((row) => row.label === "抠像")?.swatch).toBe("rgba(0,255,0,1)");
  });

  it("原速、加快变调、静音和没变过的摆放", () => {
    expect(rows(clipDetail(media("a", 0, S)))).toEqual({ 时间线上: "第 0 秒到第 1 秒", 时长: "1 秒", 截取: "从素材第 0 秒截取 1 秒", 速度: "原速", 音量: "100%", 画面适配: "完整显示" });
    const fast = rows(clipDetail(media("a", 0, S, { speed: 2, change_pitch: true, volume: 0, fit: "stretch" })));
    expect(fast.速度).toBe("加快到 2 倍，声音跟着变调");
    expect(fast.音量).toBe("静音");
    expect(fast.画面适配).toBe("拉伸铺满");
    expect(clipDetail(media("a", 0, S, { crop: { upper_left_x: 0.1, upper_left_y: 0.1, upper_right_x: 0.9, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 } })).rows
      .find((row) => row.label === "裁剪")?.value).toBe("裁成了不规则的四边形");
  });

  it("图片不说截取和速度，音频不说画面", () => {
    const image = rows(clipDetail(media("p", 0, 3 * S, { kind: "image", path: "/m/p.png", material_name: "封面.png", background_filling: { fill_type: "color", color: "#112233FF" } })));
    expect(Object.keys(image)).toEqual(["时间线上", "时长", "画面适配", "背景填充"]);
    expect(image.背景填充).toBe("纯色背景，深蓝色");
    const audio = clipDetail(media("m", 0, 3 * S, { kind: "audio", path: "/m/m.mp3", material_name: "配乐.mp3", fade: { in_duration_us: 0, out_duration_us: 2 * S } }));
    expect(audio.kind).toBe("音频");
    expect(audio.title).toBe("配乐");
    expect(Object.keys(rows(audio))).toEqual(["时间线上", "时长", "截取", "速度", "音量", "淡入淡出"]);
    expect(rows(audio).淡入淡出).toBe("结尾淡出 2 秒");
  });

  it("文字片段：内容、字号、颜色、字体、描边、背景、阴影", () => {
    const detail = clipDetail(text("t", 0, 2.2 * S, {
      text: " 第一行\n第二行 ", font_size: 12, color: "#FFCC00", opacity: 0.5, font_family: "_3D_만화", bold: true, alignment: "left",
      letter_spacing: 2, border: { color: "#000000", alpha: 1, width: 40 }, background: { color: "#000000FF", alpha: 0.6, round_radius: 0.2 },
      shadow: { color: "#333333", alpha: 0.8, diffuse: 15, distance: 5, angle: -45 }, text_effect_id: "7296357486490144036",
      transform: { ...IDENTITY_TRANSFORM, transform_y: 0.6 }, animations: [{ animation_type: "冲屏位移", duration_us: null }],
    }), { track: { name: "片头标题", track_type: "text", mute: false } });
    expect(detail.kind).toBe("文字");
    expect(detail.title).toBe("第一行\n第二行");
    expect(rows(detail)).toEqual({
      所在轨道: "片头标题", 时间线上: "第 0 秒到第 2.2 秒", 时长: "2.2 秒", 字号: "12 号", 颜色: "黄色，不透明度 50%", 字体: "3D 만화",
      样式: "加粗、左对齐", 间距: "字间距 2", 描边: "黑色，粗细 40", 背景: "黑色，不透明度 60%，圆角", 阴影: "深灰色，不透明度 80%，距离 5，模糊 15",
      花字: "用了剪映的花字，导进剪映后能看到", 位置: "向上 30%（按画面宽高算）", 动画: "冲屏位移",
    });
    expect(detail.rows.find((row) => row.label === "颜色")?.swatch).toBe("rgba(255,204,0,0.5)");
    expect(rows(clipDetail(text("t", 0, S))).字体).toBe("默认字体");
    expect(rows(clipDetail(text("t", 0, S))).颜色).toBe("白色");
    // 颜色只说口语叫法，不露出 #FFFFFF 这类代码（色块照旧）
    expect(JSON.stringify(detail.rows.map((row) => row.value))).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it("颜色的口语叫法", () => {
    expect(["#FFFFFF", "#101010", "#000000", "#333333", "#808080", "#D0D0D0", "#FFFFFFFF"].map(colorName))
      .toEqual(["白色", "黑色", "黑色", "深灰色", "灰色", "浅灰色", "白色"]);
    expect(["#FF0000", "#FFC0CB", "#FF8800", "#8B4513", "#FFCC00", "#00FF00", "#00FFFF", "#2563EB", "#112233", "#ADD8E6", "#800080", "#FF00FF", "#C71585"].map(colorName))
      .toEqual(["红色", "粉色", "橙色", "棕色", "黄色", "绿色", "青色", "蓝色", "深蓝色", "浅蓝色", "深紫色", "紫色", "紫红色"]);
    // 读不出来的和色块一样按白色算
    expect(colorName("red")).toBe("白色");
    expect(colorName(null)).toBe("白色");
  });

  it("贴纸、轨道特效和轨道滤镜", () => {
    const sticker = clipDetail({ id: "s", kind: "sticker", resource_id: "123", timeline: { start_us: 0, duration_us: S }, transform: { ...IDENTITY_TRANSFORM, scale_x: 0.5, scale_y: 0.8 } });
    expect(sticker.kind).toBe("贴纸");
    expect(rows(sticker).缩放).toBe("横向 50%、纵向 80%");
    const effect = clipDetail({ id: "e", kind: "track_effect", effect_type: "X_Signal", timeline: { start_us: S, duration_us: S } });
    expect(effect).toMatchObject({ kind: "特效", title: "X-Signal" });
    expect(rows(effect).作用范围).toBe("这段时间里的整个画面");
    const filter = clipDetail({ id: "f", kind: "track_filter", filter_type: "黑白", intensity: 60, timeline: { start_us: 0, duration_us: S } });
    expect(filter.kind).toBe("滤镜");
    expect(rows(filter).强度).toBe("60%");
  });

  it("详情里不露出字段名和原始成员名", () => {
    const detail = clipDetail(media("a", 0, S, { transition: { transition_type: "_3D空间", duration_us: null }, keyframes: [{ property: "position_x", offset_us: 0, value: 0 }] }));
    const shown = JSON.stringify(detail);
    expect(shown).not.toMatch(/_us|source|speed|transform|position_x|_3D|fit|contain|cover/u);
    expect(rows(detail).转场).toBe("和下一段之间用「3D空间」，时长按剪映默认");
    expect(rows(detail).关键帧).toBe("左右位置：第 0 秒");
  });

  it("转场只有后面紧挨着下一段才说「和下一段之间」", () => {
    const fade = { transition_type: "色彩溶解", duration_us: 400_000 };
    const a = media("a", 0, 2 * S, { transition: fade });
    const b = media("b", 2 * S, S, { transition: fade });
    const c = media("c", 4 * S, S, { transition: fade });
    const main = track("v1", "video", [a, b, c]);
    expect(main.segments.map((segment) => transitionReach(main.segments, segment))).toEqual(["next", "gap", "last"]);
    // 差不到 1 毫秒的当成紧挨着
    expect(transitionReach([a, media("d", 2 * S + 500, S)], a)).toBe("next");
    expect(transitionReach(undefined, c)).toBe("next");
    expect(rows(clipDetail(a, { track: main })).转场).toBe("和下一段之间用「色彩溶解」，0.4 秒");
    expect(rows(clipDetail(b, { track: main })).转场).toBe("设了「色彩溶解」，但和下一段之间隔着空当，转场可能不会出现");
    expect(rows(clipDetail(c, { track: main })).转场).toBe("设了「色彩溶解」，但这是这条轨道的最后一段，后面没有片段，转场不会出现");
    expect(clipExtras(c, "last")).toEqual(["转场 色彩溶解（最后一段，不会出现）"]);
    expect(clipExtras(b, "gap")).toEqual(["转场 色彩溶解（后面隔着空当）"]);
  });
});

describe("片段缩略图取哪几帧", () => {
  it("片段越宽帧越多，有上限，太窄不放", () => {
    expect(filmstripCount(10)).toBe(0);
    expect(filmstripCount(20)).toBe(1);
    expect(filmstripCount(160)).toBe(4);
    expect(filmstripCount(5000)).toBe(12);
  });

  it("第 k 帧取 source.start + k/n × source.duration，按 0.25 秒取整，不取到末尾", () => {
    expect(filmstripTimes({ start_us: 0, duration_us: 4 * S }, 4)).toEqual([0, S, 2 * S, 3 * S]);
    // 从素材第 1.5 秒截取 1.5 秒（比如 3 秒的片段放慢到 0.5 倍）
    expect(filmstripTimes({ start_us: 1.5 * S, duration_us: 1.5 * S }, 3)).toEqual([1.5 * S, 2 * S, 2.5 * S]);
    expect(filmstripTimes({ start_us: 1.1 * S, duration_us: 0.2 * S }, 2)).toEqual([1.1 * S, 1.2 * S]);
    expect(filmstripTimes({ start_us: 0, duration_us: S }, 0)).toEqual([]);
  });
});
