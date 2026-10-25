import type {
  AiEditCatalogKind, EditCanvas, EditFit, EditKeyframe, EditMediaSegment, EditProject, EditSegment, EditTextSegment, EditTimeRange, EditTrack, EditTransform,
} from "../../services/aiEdit";

// AI 剪辑看板的纯计算：时长、某一时刻该画哪些片段、素材摆放、刻度与时间格式。只管怎么画，手动改动的换算在 aiEditBoardEdit.ts。
// 坐标约定同剪映 / pyJianYingDraft：transform_x/y 以半个画布宽/高为单位，y 向上为正；rotation 顺时针为正。

export const US_PER_SECOND = 1_000_000;

export interface Size { width: number; height: number }

const end = (range: EditTimeRange) => range.start_us + range.duration_us;

/** 工程总时长：所有轨道（含字幕）里最靠后的片段结尾。 */
export function projectDuration(project: Pick<EditProject, "tracks"> | null | undefined): number {
  let latest = 0;
  for (const track of project?.tracks ?? []) for (const segment of track.segments ?? []) latest = Math.max(latest, end(segment.timeline));
  return latest;
}

export function segmentAt(track: EditTrack, timeUs: number): EditSegment | null {
  return track.segments.find((segment) => segment.timeline.start_us <= timeUs && timeUs < end(segment.timeline)) ?? null;
}

/** 这条轨道上 timeUs 之后最先开始的片段（预加载下一段用）。 */
export function nextSegmentAfter(track: EditTrack, timeUs: number): EditSegment | null {
  let next: EditSegment | null = null;
  for (const segment of track.segments) {
    if (segment.timeline.start_us > timeUs && (!next || segment.timeline.start_us < next.timeline.start_us)) next = segment;
  }
  return next;
}

/**
 * ↑ / ↓ 跳的剪切点：所有轨道（字幕轨除外，太密）上片段的开头和结尾，去重、从早到晚，差不到 1 毫秒的算一个。
 * 照 openfilm 的 cutPoints / nextCut（studio/ui/src/lib/timeline-nav.ts，MIT License，Copyright (c) 2026 OpenFilm contributors）。
 */
export function cutPoints(project: Pick<EditProject, "tracks"> | null | undefined): number[] {
  const points = (project?.tracks ?? []).filter((track) => track.kind !== "subtitle")
    .flatMap((track) => track.segments.flatMap((segment) => [segment.timeline.start_us, end(segment.timeline)]))
    .sort((a, b) => a - b);
  const kept: number[] = [];
  for (const point of points) if (!kept.length || point - kept.at(-1)! >= 1_000) kept.push(point);
  return kept;
}

/** 播放头之后（dir 为 1）或之前（-1）最近的剪切点；离播放头不到 1 毫秒的算播放头就在那，跳过；那边没有为 null。 */
export function nextCut(points: readonly number[], nowUs: number, dir: 1 | -1): number | null {
  if (dir > 0) return points.find((point) => point > nowUs + 1_000) ?? null;
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index]! < nowUs - 1_000) return points[index]!;
  return null;
}

/** 播放头按帧走：先换成帧号再加减，按帧号算回微秒，连按多少下误差都不累积。 */
export function stepFrame(timeUs: number, fps: number, frames: number): number {
  const rate = fps > 0 ? fps : 30;
  return Math.round(((Math.round((timeUs * rate) / US_PER_SECOND) + frames) * US_PER_SECOND) / rate);
}

export interface ActiveLayer { track: EditTrack; trackIndex: number; segment: EditSegment }

export interface ActiveFrame {
  /** 画面里的片段（视频、图片、贴纸、文字），按剪映的叠放顺序从下往上：轨道越靠后越在上面 */
  visuals: ActiveLayer[];
  /** 独立的音频片段（视频片段的声音由画面里的 <video> 自己出） */
  audios: ActiveLayer[];
  /** 此刻生效的轨道特效 / 滤镜片段 */
  overlays: ActiveLayer[];
}

const VISUAL = new Set(["video", "image", "sticker", "text"]);

export function activeFrame(project: Pick<EditProject, "tracks"> | null | undefined, timeUs: number): ActiveFrame {
  const frame: ActiveFrame = { visuals: [], audios: [], overlays: [] };
  (project?.tracks ?? []).forEach((track, trackIndex) => {
    const segment = segmentAt(track, timeUs);
    if (!segment) return;
    const layer = { track, trackIndex, segment };
    if (segment.kind === "audio") frame.audios.push(layer);
    else if (VISUAL.has(segment.kind)) frame.visuals.push(layer);
    else frame.overlays.push(layer);
  });
  return frame;
}

/** 片段在 timeUs 时对应的素材时间（微秒）：source.start + (t - timeline.start) × speed。 */
export function sourceTimeUs(segment: Pick<EditMediaSegment, "timeline" | "source" | "speed">, timeUs: number): number {
  const offset = Math.min(Math.max(0, timeUs - segment.timeline.start_us), segment.timeline.duration_us);
  const speed = segment.speed > 0 ? segment.speed : 1;
  return Math.min(segment.source.start_us + offset * speed, end(segment.source));
}

/** 浏览器 playbackRate 的可用范围是 1/16–16。 */
export const playbackRate = (speed: number) => Math.min(16, Math.max(0.0625, Number.isFinite(speed) && speed > 0 ? speed : 1));

// ---------- 关键帧 ----------

/** 某属性在片段内偏移 offsetUs 处的关键帧值：两帧之间线性插值，两头之外取最近一帧；没有这个属性的关键帧时为 null。 */
export function keyframeValue(keyframes: EditKeyframe[] | undefined, property: string, offsetUs: number): number | null {
  const points = (keyframes ?? []).filter((item) => item.property === property).sort((a, b) => a.offset_us - b.offset_us);
  if (!points.length) return null;
  if (offsetUs <= points[0]!.offset_us) return points[0]!.value;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    if (offsetUs <= right.offset_us) {
      const left = points[index - 1]!;
      const span = right.offset_us - left.offset_us;
      return span <= 0 ? right.value : left.value + (right.value - left.value) * ((offsetUs - left.offset_us) / span);
    }
  }
  return points[points.length - 1]!.value;
}

export const IDENTITY_TRANSFORM: EditTransform = {
  scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false,
};

/** 片段在 offsetUs 处实际生效的变换：静态 transform 叠上关键帧（关键帧值是绝对值，覆盖静态值）。 */
export function effectiveTransform(segment: { transform?: EditTransform | null; keyframes?: EditKeyframe[] }, offsetUs: number): EditTransform {
  const base = { ...IDENTITY_TRANSFORM, ...(segment.transform ?? {}) };
  const key = (property: string) => keyframeValue(segment.keyframes, property, offsetUs);
  const uniform = key("uniform_scale");
  return {
    ...base,
    transform_x: key("transform_x") ?? base.transform_x,
    transform_y: key("transform_y") ?? base.transform_y,
    scale_x: uniform ?? key("scale_x") ?? base.scale_x,
    scale_y: uniform ?? key("scale_y") ?? base.scale_y,
    rotation: key("rotation") ?? base.rotation,
    alpha: key("alpha") ?? base.alpha,
  };
}

/** 亮度 / 对比度 / 饱和度关键帧（-1..1）换成 CSS filter；都没有时为空串。 */
export function colorFilter(keyframes: EditKeyframe[] | undefined, offsetUs: number): string {
  const parts: string[] = [];
  const add = (property: string, css: string) => {
    const value = keyframeValue(keyframes, property, offsetUs);
    if (value !== null && value !== 0) parts.push(`${css}(${round(Math.max(0, 1 + value), 3)})`);
  };
  add("brightness", "brightness");
  add("contrast", "contrast");
  add("saturation", "saturate");
  return parts.join(" ");
}

// ---------- 摆放 ----------

/**
 * 素材按 fit 铺进画布后的大小（画布像素或舞台像素都行，同一单位进同一单位出）。
 * contain 等比放进、cover 等比铺满、stretch 拉满；素材尺寸未知时当作和画布同比例。
 */
export function fitBox(stage: Size, media: Partial<Size> | null | undefined, fit: EditFit = "contain"): Size {
  const width = media?.width && media.width > 0 ? media.width : stage.width;
  const height = media?.height && media.height > 0 ? media.height : stage.height;
  if (fit === "stretch") return { width: stage.width, height: stage.height };
  const scale = fit === "cover" ? Math.max(stage.width / width, stage.height / height) : Math.min(stage.width / width, stage.height / height);
  return { width: width * scale, height: height * scale };
}

const SCALE_KEYS = ["uniform_scale", "scale_x", "scale_y"];

/** 片段有没有缩放关键帧。 */
export const hasScaleKeyframes = (keyframes: EditKeyframe[] | undefined) => Boolean(keyframes?.some((item) => SCALE_KEYS.includes(item.property)));

/**
 * 视觉片段的基准框，再乘上 effectiveTransform 的缩放就是最终大小。
 * 草稿里 cover / stretch 的放大系数只乘进静态缩放，缩放关键帧照原值写，在剪映里是绝对缩放（1.0 = contain 的大小），
 * 所以哪个方向有缩放关键帧，那个方向就按 contain 框算，预览才和导进剪映后一致。
 */
export function layerBox(stage: Size, media: Partial<Size> | null | undefined, fit: EditFit = "contain", keyframes?: EditKeyframe[]): Size {
  const fitted = fitBox(stage, media, fit);
  if (fit === "contain" || !keyframes || !hasScaleKeyframes(keyframes)) return fitted;
  const has = (property: string) => keyframes.some((item) => item.property === property);
  const keyedX = has("uniform_scale") || has("scale_x");
  const keyedY = has("uniform_scale") || has("scale_y");
  const contain = fitBox(stage, media, "contain");
  return { width: keyedX ? contain.width : fitted.width, height: keyedY ? contain.height : fitted.height };
}

export interface LayerRect { left: number; top: number; width: number; height: number; rotation: number; flipX: boolean; flipY: boolean; opacity: number }

/** 片段在舞台上的矩形：先按 fit 定大小，再乘缩放、按位移挪中心（y 向上为正）。 */
export function layerRect(stage: Size, box: Size, transform: EditTransform): LayerRect {
  const width = box.width * transform.scale_x;
  const height = box.height * transform.scale_y;
  const centerX = stage.width / 2 + transform.transform_x * stage.width / 2;
  const centerY = stage.height / 2 - transform.transform_y * stage.height / 2;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
    rotation: transform.rotation,
    flipX: transform.flip_horizontal,
    flipY: transform.flip_vertical,
    opacity: Math.min(1, Math.max(0, transform.alpha)),
  };
}

/** 旋转 + 翻转的 CSS transform；什么都没有时为 "none"。 */
export function cssTransform(rect: Pick<LayerRect, "rotation" | "flipX" | "flipY">): string {
  const parts: string[] = [];
  if (rect.rotation) parts.push(`rotate(${round(rect.rotation, 3)}deg)`);
  if (rect.flipX || rect.flipY) parts.push(`scale(${rect.flipX ? -1 : 1},${rect.flipY ? -1 : 1})`);
  return parts.length ? parts.join(" ") : "none";
}

/** 裁剪的四个角（0–1）换成 clip-path；没裁时为 null。 */
export function cropClipPath(crop: EditMediaSegment["crop"]): string | null {
  if (!crop) return null;
  const point = (x: number, y: number) => `${round(x * 100, 3)}% ${round(y * 100, 3)}%`;
  const identity = crop.upper_left_x === 0 && crop.upper_left_y === 0 && crop.upper_right_x === 1 && crop.upper_right_y === 0
    && crop.lower_left_x === 0 && crop.lower_left_y === 1 && crop.lower_right_x === 1 && crop.lower_right_y === 1;
  if (identity) return null;
  return `polygon(${point(crop.upper_left_x, crop.upper_left_y)}, ${point(crop.upper_right_x, crop.upper_right_y)}, ${point(crop.lower_right_x, crop.lower_right_y)}, ${point(crop.lower_left_x, crop.lower_left_y)})`;
}

/** 剪映混合模式 → CSS mix-blend-mode（线性加深没有对应，近似成正片叠底）。 */
export function blendMode(mode: string | null | undefined): string | null {
  const table: Record<string, string> = {
    正片叠底: "multiply", 颜色减淡: "color-dodge", 颜色加深: "color-burn", 线性加深: "multiply", 柔光: "soft-light",
    强光: "hard-light", 滤色: "screen", 叠加: "overlay", 变亮: "lighten", 变暗: "darken",
  };
  return mode ? table[mode] ?? null : null;
}

export interface MaskSpec {
  mask_type: string; center_x?: number; center_y?: number; size?: number; rotation?: number;
  feather?: number; invert?: boolean; rect_width?: number | null; round_corner?: number | null;
}

/**
 * 蒙版的近似：圆形 / 镜面 / 线性用 mask-image 渐变，矩形用 mask-image 内嵌 SVG（都带羽化和反转）；
 * 爱心、星形不画。中心点以素材像素为单位、y 向上，大小以素材高度为比例（同 pyJianYingDraft）。
 * 一律走 mask-image，不占 clip-path：clip-path 留给裁剪，两者同时生效。
 */
export function maskCss(mask: MaskSpec | null | undefined, element: Size, material: Partial<Size> | null | undefined): Record<string, string> | null {
  if (!mask) return null;
  const materialWidth = material?.width && material.width > 0 ? material.width : element.width;
  const materialHeight = material?.height && material.height > 0 ? material.height : element.height;
  const cx = element.width / 2 + ((mask.center_x ?? 0) / materialWidth) * element.width;
  const cy = element.height / 2 - ((mask.center_y ?? 0) / materialHeight) * element.height;
  const size = (mask.size ?? 0.5) * element.height;
  const feather = Math.min(100, Math.max(0, mask.feather ?? 0)) / 100;
  const [inside, outside] = mask.invert ? ["transparent", "#000"] : ["#000", "transparent"];
  const px = (value: number) => `${round(value, 2)}px`;
  if (mask.mask_type === "圆形") {
    const radius = size / 2;
    const image = `radial-gradient(circle ${px(radius * (1 + feather))} at ${px(cx)} ${px(cy)}, ${inside} ${round((1 - feather) / (1 + feather) * 100, 2)}%, ${outside} 100%)`;
    return { maskImage: image, WebkitMaskImage: image };
  }
  if (mask.mask_type === "矩形") {
    const width = (mask.rect_width ?? mask.size ?? 0.5) * element.width;
    const radius = Math.min(width, size) / 2 * Math.min(100, Math.max(0, mask.round_corner ?? 0)) / 100;
    const blur = (feather * Math.min(width, size)) / 8;
    const n = (value: number) => String(round(value, 2));
    const [w, h] = [element.width, element.height];
    // 反转和羽化都要往画面外多铺一圈，不然模糊会把画面边缘也带虚
    const region = `x="${n(-w)}" y="${n(-h)}" width="${n(3 * w)}" height="${n(3 * h)}"`;
    const filter = blur > 0 ? `<filter id="f" filterUnits="userSpaceOnUse" ${region}><feGaussianBlur stdDeviation="${n(blur)}"/></filter>` : "";
    const shape = (fill: string) => `<rect x="${n(cx - width / 2)}" y="${n(cy - size / 2)}" width="${n(width)}" height="${n(size)}" rx="${n(radius)}"${mask.rotation ? ` transform="rotate(${n(mask.rotation)} ${n(cx)} ${n(cy)})"` : ""} fill="${fill}"${blur > 0 ? ` filter="url(#f)"` : ""}/>`;
    const body = mask.invert
      ? `<mask id="m" maskUnits="userSpaceOnUse" ${region}><rect ${region} fill="#fff"/>${shape("#000")}</mask><rect width="${n(w)}" height="${n(h)}" fill="#000" mask="url(#m)"/>`
      : shape("#000");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}">${filter}${body}</svg>`;
    const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    return { maskImage: image, WebkitMaskImage: image, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" };
  }
  if (mask.mask_type === "线性" || mask.mask_type === "镜面") {
    // 渐变方向垂直于蒙版线；线过 (cx, cy)，蒙版旋转 0° 时线是水平的，线性蒙版保留上半边
    const angle = mask.rotation ?? 0;
    const radians = (angle * Math.PI) / 180;
    const span = Math.abs(element.width * Math.sin(radians)) + Math.abs(element.height * Math.cos(radians));
    const along = (cx - element.width / 2) * Math.sin(radians) - (cy - element.height / 2) * Math.cos(radians);
    const at = (offset: number) => `${round(((span / 2 + along + offset) / span) * 100, 2)}%`;
    const soft = (feather * element.height) / 4;
    const image = mask.mask_type === "线性"
      ? `linear-gradient(${round(angle, 2)}deg, ${outside} ${at(-soft)}, ${inside} ${at(soft)})`
      : `linear-gradient(${round(angle, 2)}deg, ${outside} ${at(-size / 2 - soft)}, ${inside} ${at(-size / 2 + soft)}, ${inside} ${at(size / 2 - soft)}, ${outside} ${at(size / 2 + soft)})`;
    return { maskImage: image, WebkitMaskImage: image };
  }
  return null;
}

// ---------- 声音 ----------

/** 淡入淡出（剪映里是音量淡入淡出）在片段内 offsetUs 处的增益 0–1。 */
export function fadeGain(segment: { timeline: EditTimeRange; fade?: { in_duration_us: number; out_duration_us: number } | null }, offsetUs: number): number {
  const fade = segment.fade;
  if (!fade) return 1;
  let gain = 1;
  if (fade.in_duration_us > 0 && offsetUs < fade.in_duration_us) gain = Math.min(gain, Math.max(0, offsetUs / fade.in_duration_us));
  const left = segment.timeline.duration_us - offsetUs;
  if (fade.out_duration_us > 0 && left < fade.out_duration_us) gain = Math.min(gain, Math.max(0, left / fade.out_duration_us));
  return gain;
}

/** 媒体元素此刻的音量：片段音量（或音量关键帧）× 淡入淡出；轨道静音或音量为 0 时 muted。浏览器音量最大 1。 */
export function mediaVolume(segment: EditMediaSegment, track: Pick<EditTrack, "mute">, offsetUs: number): { volume: number; muted: boolean } {
  const level = keyframeValue(segment.keyframes, "volume", offsetUs) ?? segment.volume ?? 1;
  const volume = Math.min(1, Math.max(0, level * fadeGain(segment, offsetUs)));
  return { volume, muted: track.mute || volume <= 0 };
}

// ---------- 文字 ----------

/**
 * 剪映字号到画布像素：2026-10-19 在剪映 Mac 11.6 里实测，12 号字在 1080×1920 和 1920×1080 画布上
 * 每个汉字都约占画布宽度的 6.9%，也就是按画布宽度缩放、宽 1080 时每级字号约 6.25px。
 */
export const TEXT_PX_PER_SIZE = 6.25;

export function textFontPx(fontSize: number, canvas: Pick<EditCanvas, "width" | "height">, stageScale: number): number {
  return Math.max(1, fontSize * TEXT_PX_PER_SIZE * (canvas.width / 1080) * stageScale);
}

const hexToRgb = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) || 0) as [number, number, number];
/** #RRGGBB + 透明度 → rgba()；#RRGGBBAA 自带的透明度再乘上去。 */
export function rgba(hex: string | null | undefined, opacity = 1): string {
  const value = /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(hex ?? "") ? hex! : "#FFFFFF";
  const [r, g, b] = hexToRgb(value);
  const own = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${round(Math.min(1, Math.max(0, own * opacity)), 3)})`;
}

/**
 * 颜色的口语叫法（白色、深灰色、浅蓝色、粉色……），只粗分到能认出来，具体是哪种颜色看旁边的色块。
 * 读不出来的值和 rgba() 一样按白色算；#RRGGBBAA 的透明度不管。
 */
export function colorName(hex: string | null | undefined): string {
  const value = /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(hex ?? "") ? hex! : "#FFFFFF";
  const [r, g, b] = hexToRgb(value).map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  const light = (max + Math.min(r, g, b)) / 2;
  // 几乎没有色彩倾向的按深浅叫
  if (chroma < 0.1) return light >= 0.93 ? "白色" : light >= 0.7 ? "浅灰色" : light >= 0.4 ? "灰色" : light >= 0.15 ? "深灰色" : "黑色";
  const sector = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  const hue = sector * 60;
  const shade = light < 0.3 ? "深" : light > 0.72 ? "浅" : "";
  if (hue < 15 || hue >= 340) return light > 0.72 ? "粉色" : `${shade}红色`;
  if (hue < 45) return light < 0.35 ? "棕色" : `${shade}橙色`;
  if (hue < 70) return `${shade}黄色`;
  if (hue < 165) return `${shade}绿色`;
  if (hue < 190) return `${shade}青色`;
  if (hue < 255) return `${shade}蓝色`;
  if (hue < 315) return `${shade}紫色`;
  return light > 0.6 ? "粉色" : `${shade}紫红色`;
}

/** 文字片段的近似样式（舞台像素）。字重最多到 600。 */
export function textCss(segment: EditTextSegment, canvas: Pick<EditCanvas, "width" | "height">, stage: Size): Record<string, string | number> {
  const scale = stage.width / canvas.width;
  const fontPx = textFontPx(segment.font_size ?? 8, canvas, scale);
  const css: Record<string, string | number> = {
    fontSize: round(fontPx, 2),
    lineHeight: round(Math.min(4, Math.max(0.8, 1.25 + (segment.line_spacing ?? 0) * 0.05)), 3),
    letterSpacing: `${round(Math.min(2, Math.max(-0.5, (segment.letter_spacing ?? 0) * 0.05)), 3)}em`,
    color: rgba(segment.color ?? "#FFFFFF", segment.opacity ?? 1),
    textAlign: segment.alignment ?? "center",
    fontWeight: segment.bold ? 600 : 400,
    fontStyle: segment.italic ? "italic" : "normal",
    textDecorationLine: segment.underline ? "underline" : "none",
    whiteSpace: segment.auto_wrapping === false ? "pre" : "pre-wrap",
    overflowWrap: "anywhere",
  };
  if (segment.auto_wrapping !== false) css.maxWidth = round(stage.width * (segment.max_line_width ?? 0.82), 2);
  if (segment.vertical) css.writingMode = "vertical-rl";
  if (segment.border) {
    const width = Math.max(0, segment.border.width ?? 40);
    css.WebkitTextStroke = `${round((fontPx * width) / 400, 2)}px ${rgba(segment.border.color ?? "#000000", segment.border.alpha ?? 1)}`;
    css.paintOrder = "stroke fill";
  }
  if (segment.shadow) {
    const shadow = segment.shadow;
    const angle = ((shadow.angle ?? -45) * Math.PI) / 180;
    const distance = (fontPx * (shadow.distance ?? 5)) / 50;
    css.textShadow = `${round(Math.cos(angle) * distance, 2)}px ${round(-Math.sin(angle) * distance, 2)}px ${round((fontPx * (shadow.diffuse ?? 15)) / 100, 2)}px ${rgba(shadow.color ?? "#000000", shadow.alpha ?? 1)}`;
  }
  if (segment.background) {
    const background = segment.background;
    css.backgroundColor = rgba(background.color, background.alpha ?? 1);
    css.padding = `${round(fontPx * 0.12, 2)}px ${round(fontPx * 0.3, 2)}px`;
    css.borderRadius = round(fontPx * (background.round_radius ?? 0), 2);
  }
  return css;
}

// ---------- 轨道区 ----------

/** 片段在轨道里的像素位置；宽度至少 2px，免得极短的片段看不见。 */
export function clipPosition(timeline: EditTimeRange, durationUs: number, widthPx: number): { left: number; width: number } {
  if (durationUs <= 0 || widthPx <= 0) return { left: 0, width: 0 };
  const left = (timeline.start_us / durationUs) * widthPx;
  return { left, width: Math.max(2, (timeline.duration_us / durationUs) * widthPx) };
}

/** 轨道区里横坐标对应的时间（夹在 0..duration）。 */
export function timeAtX(x: number, widthPx: number, durationUs: number): number {
  if (widthPx <= 0 || durationUs <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, x / widthPx)) * durationUs);
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** 刻度间隔（秒）：相邻两个刻度至少隔 minGapPx。 */
export function pickTickStep(pxPerSecond: number, minGapPx = 64): number {
  if (!(pxPerSecond > 0)) return TICK_STEPS[TICK_STEPS.length - 1]!;
  return TICK_STEPS.find((step) => step * pxPerSecond >= minGapPx) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
}

export function rulerTicks(durationUs: number, widthPx: number, minGapPx = 64): Array<{ us: number; x: number; label: string }> {
  if (durationUs <= 0 || widthPx <= 0) return [];
  const step = pickTickStep(widthPx / (durationUs / US_PER_SECOND), minGapPx);
  const stepUs = Math.round(step * US_PER_SECOND);
  const ticks: Array<{ us: number; x: number; label: string }> = [];
  for (let us = 0; us <= durationUs; us += stepUs) ticks.push({ us, x: (us / durationUs) * widthPx, label: formatTick(us, step) });
  return ticks;
}

// ---------- 时间 ----------

const pad = (value: number) => String(value).padStart(2, "0");

/** 播放头时间：m:ss.d（满一小时 h:mm:ss.d）。 */
export function formatClock(us: number): string {
  const tenths = Math.floor(Math.max(0, us) / 100_000);
  const seconds = Math.floor(tenths / 10);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = `${pad(seconds % 60)}.${tenths % 10}`;
  return hours ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

/** 总时长：m:ss，不足一秒的部分进一位（0.2 秒的工程显示 0:01，不显示成 0:00）。 */
export function formatDuration(us: number): string {
  const seconds = Math.ceil(Math.max(0, us) / US_PER_SECOND);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** 刻度标签：间隔不到一秒时带一位小数。 */
export function formatTick(us: number, stepSeconds: number): string {
  if (stepSeconds < 1) {
    const tenths = Math.round(us / 100_000);
    const seconds = Math.floor(tenths / 10);
    return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}.${tenths % 10}`;
  }
  return formatDuration(Math.round(us / US_PER_SECOND) * US_PER_SECOND);
}

/** 秒数的口语写法：「4 秒」「2.5 秒」「1 分 20 秒」。 */
export function spokenDuration(us: number): string {
  const seconds = Math.round(us / 100_000) / 10;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  const whole = Math.round(seconds);
  return whole % 60 ? `${Math.floor(whole / 60)} 分 ${whole % 60} 秒` : `${whole / 60} 分钟`;
}

// ---------- 名称 ----------

/** 素材库文件存成 <素材 id>.<后缀>，从工程里的绝对路径取回素材 id。 */
export function mediaIdFromPath(path: string | null | undefined): string | null {
  const name = (path ?? "").split(/[\\/]/u).pop() ?? "";
  const id = name.replace(/\.[^.]*$/u, "");
  return id || null;
}

const TRACK_NAMES: Record<string, string> = { video: "视频", audio: "音频", text: "文字", sticker: "贴纸", effect: "特效", filter: "滤镜" };

/** 轨道名：原仓库默认名是英文类型名（Video、Subtitles），换成中文；AI 起的名字照原样。 */
export function trackLabel(track: Pick<EditTrack, "name" | "track_type" | "kind">): string {
  const name = (track.name ?? "").trim();
  if (track.kind === "subtitle" && (!name || name === "Subtitles")) return "字幕";
  const fallback = TRACK_NAMES[track.track_type] ?? "轨道";
  if (!name || name.toLowerCase() === track.track_type) return fallback;
  return name;
}

const stripExtension = (name: string) => name.replace(/\.(mp4|mov|m4v|webm|mkv|avi|png|jpe?g|webp|gif|bmp|wav|mp3|m4a|aac|flac|ogg)$/iu, "");

// 工程里的特效 / 滤镜 / 转场 / 动画名是 pyJianYingDraft 的枚举成员名（_1998、Lofi_II、_3D空间），
// 剪映里显示的是「1998」「Lofi II」「3D空间」。绝大多数只差下划线；对不上的这十几个单独列出，
// 单测拿 collector/aiEdit/catalog.json 逐个核对。模型直接给了显示名时原样不动。
const FEATURE_NAMES: Record<string, string> = {
  X_Signal: "X-Signal", 报纸_今日热门: "报纸:今日热门", 闪光灯_I: "闪光灯 Ⅰ", 假日闪闪_II: "假日闪闪 Ⅱ", 爱心烟花II: "爱心烟花Ⅱ",
  BOOM: "BOOM！", crash: "crash！", 变老_美颜: "变老-美颜", 有事吗: "有事吗？", 报纸拼贴II: "报纸拼贴Ⅱ", 叠叠乐_VI: "叠叠乐 Ⅵ",
  炸开_III: "炸开 Ⅲ", 彩虹_情人节: "彩虹-情人节", 彩虹_新年: "彩虹-新年", 彩虹_马卡龙: "彩虹-马卡龙",
};

/** 特效、滤镜、转场、动画、蒙版名换成剪映里显示的名字。 */
export function featureName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  return FEATURE_NAMES[name] ?? name.replace(/^_+/u, "").replace(/_/gu, " ").replace(/\s+/gu, " ").trim();
}

/** 片段块上显示的字：素材名 / 文字内容 / 特效名。mediaName 是素材库里的名字（抖音素材是标题）。 */
export function clipLabel(segment: EditSegment, mediaName?: string | null): string {
  switch (segment.kind) {
    case "text": return segment.text.replace(/\s+/gu, " ").trim();
    case "sticker": return "贴纸";
    case "track_effect": return featureName(segment.effect_type);
    case "track_filter": return segment.intensity !== undefined && segment.intensity !== 100 ? `${featureName(segment.filter_type)} ${Math.round(segment.intensity)}%` : featureName(segment.filter_type);
    default: return stripExtension(mediaName || segment.material_name || (segment.path.split(/[\\/]/u).pop() ?? "素材"));
  }
}

/**
 * 片段上的转场能不能出现：转场接在同一轨道上紧挨着的下一段，「next」能接上，「gap」后面隔着空当，「last」是轨道最后一段。
 * 不知道轨道上有哪些片段时按接得上算。
 */
export type TransitionReach = "next" | "gap" | "last";
const ADJACENT_US = 1_000;

export function transitionReach(segments: readonly EditSegment[] | null | undefined, segment: EditSegment): TransitionReach {
  if (!segments) return "next";
  const at = end(segment.timeline);
  let later = false;
  for (const other of segments) {
    if (other.id === segment.id) continue;
    if (Math.abs(other.timeline.start_us - at) <= ADJACENT_US) return "next";
    if (other.timeline.start_us > at) later = true;
  }
  return later ? "gap" : "last";
}

/** 片段身上挂的东西，给片段块的提示文字用（「转场 叠化 · 淡入 0.5 秒 · 2 个关键帧」）。 */
export function clipExtras(segment: EditSegment, reach: TransitionReach = "next"): string[] {
  const extras: string[] = [];
  if ("speed" in segment && segment.speed && Math.abs(segment.speed - 1) > 1e-6) extras.push(`${round(segment.speed, 2)} 倍速`);
  if ("volume" in segment && segment.kind !== "image" && segment.volume !== undefined && segment.volume !== 1) extras.push(segment.volume === 0 ? "静音" : `音量 ${Math.round(segment.volume * 100)}%`);
  if ("transition" in segment && segment.transition) {
    extras.push(`转场 ${featureName(segment.transition.transition_type)}${reach === "last" ? "（最后一段，不会出现）" : reach === "gap" ? "（后面隔着空当）" : ""}`);
  }
  if ("fade" in segment && segment.fade) {
    if (segment.fade.in_duration_us) extras.push(`淡入 ${spokenDuration(segment.fade.in_duration_us)}`);
    if (segment.fade.out_duration_us) extras.push(`淡出 ${spokenDuration(segment.fade.out_duration_us)}`);
  }
  if ("effects" in segment) for (const item of segment.effects ?? []) extras.push(`特效 ${featureName(item.effect_type)}`);
  if ("filters" in segment) for (const item of segment.filters ?? []) extras.push(`滤镜 ${featureName(item.filter_type)}`);
  if ("animations" in segment) for (const item of segment.animations ?? []) extras.push(`动画 ${featureName(item.animation_type)}`);
  if ("mask" in segment && segment.mask) extras.push(`蒙版 ${featureName(segment.mask.mask_type)}`);
  if ("chroma" in segment && segment.chroma) extras.push("抠像");
  if ("background_filling" in segment && segment.background_filling) extras.push(segment.background_filling.fill_type === "blur" ? "模糊背景" : "纯色背景");
  if ("mix_mode" in segment && segment.mix_mode) extras.push(`混合 ${segment.mix_mode.mode}`);
  if ("bubble" in segment && segment.bubble) extras.push("气泡");
  if ("text_effect_id" in segment && segment.text_effect_id) extras.push("花字");
  if (segment.keyframes?.length) extras.push(`${segment.keyframes.length} 个关键帧`);
  return extras;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------- 剪映效果的近似样子 ----------
// 转场、动画、滤镜、特效是剪映自己画的，看板画不出原样：按名字里的关键词近似成透明度、位移、缩放、旋转和颜色，
// 加上了看得出来、大概什么样（以剪映里为准）。

export interface FeatureLook { opacity: number; transform: string; filter: string }

interface Pose { opacity: number; x: number; y: number; scale: number; rotate: number; blur: number; bright: number }

const DEFAULT_FEATURE_US = 500_000;
const ease = (p: number) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 2;

/** 离开静止位置 k（0–1）时的样子。dir 1 是进来（入场、转场的后一段），-1 是出去；wobble（-1..1）给抖动用。认不出方式的按淡入淡出带一点缩放。 */
function pose(name: string, k: number, dir: 1 | -1, wobble: number, into: Pose) {
  if (k <= 0) return;
  let known = false;
  const has = (pattern: RegExp) => { const hit = pattern.test(name); known ||= hit; return hit; };
  if (has(/渐显|渐隐|淡|溶解|叠化|透明|消散/u)) into.opacity *= 1 - k;
  if (has(/放大|拉近|推近|变大/u)) into.scale *= 1 - dir * 0.35 * k;
  if (has(/缩小|拉远|变小/u)) into.scale *= 1 + dir * 0.35 * k;
  if (has(/向上|上移|上滑|上升|升起/u)) into.y += dir * 0.3 * k;
  if (has(/向下|下移|下滑|下降|下落|掉落/u)) into.y -= dir * 0.3 * k;
  if (has(/向左|左移|左滑/u)) into.x += dir * 0.3 * k;
  if (has(/向右|右移|右滑/u)) into.x -= dir * 0.3 * k;
  if (has(/旋转|转圈|翻转|翻页|滚/u)) into.rotate -= dir * 90 * k;
  if (has(/抖|震|晃|摇|弹|跳/u)) { if (/上下/u.test(name)) into.y += 0.05 * k * wobble; else into.x += 0.05 * k * wobble; }
  if (has(/模糊|虚化|失焦/u)) into.blur += 12 * k;
  if (has(/闪白|闪光|曝光|白场/u)) into.bright += 1.5 * k;
  if (has(/闪黑|黑场|变暗/u)) into.bright -= k;
  if (!known) { into.opacity *= 1 - k; into.scale *= 1 - dir * 0.08 * k; }
}

/** 剪映滤镜按名字近似成 CSS filter，s 是强度（0–1）；认不出来的给一点饱和和对比，看得出套了滤镜。 */
const FILTER_LOOKS: Array<[RegExp, (s: number) => string]> = [
  [/黑白|默片|灰|单色/u, (s) => `grayscale(${s})`],
  [/复古|胶片|怀旧|老|旧|港|年代|\d{4}/u, (s) => `sepia(${0.45 * s}) contrast(${1 + 0.05 * s})`],
  [/暖|日落|夕阳|金|黄|秋|橙|焦糖/u, (s) => `sepia(${0.25 * s}) saturate(${1 + 0.25 * s})`],
  [/冷|蓝|冬|雪|青/u, (s) => `saturate(${1 - 0.15 * s}) hue-rotate(${12 * s}deg) brightness(${1 + 0.03 * s})`],
  [/暗|夜|黑金|低调/u, (s) => `brightness(${1 - 0.15 * s}) contrast(${1 + 0.15 * s})`],
  [/粉|樱|奶|柔|甜|梦|白皙/u, (s) => `brightness(${1 + 0.06 * s}) saturate(${1 - 0.15 * s})`],
  [/鲜|艳|浓|亮丽|绚/u, (s) => `saturate(${1 + 0.4 * s}) contrast(${1 + 0.05 * s})`],
  [/清晰|锐|质感|高清/u, (s) => `contrast(${1 + 0.15 * s})`],
  [/绿|森|抹茶/u, (s) => `hue-rotate(${-12 * s}deg) saturate(${1 + 0.1 * s})`],
];
const filterLook = (name: string, s: number) =>
  (FILTER_LOOKS.find(([pattern]) => pattern.test(name))?.[1] ?? ((v: number) => `saturate(${1 + 0.15 * v}) contrast(${1 + 0.05 * v})`))(s);

/** 能近似的特效（模糊、闪、抖、黑白、复古、负片）；往画面上叠东西的（爱心、彩带、粒子）画不出来，只在「此刻生效」那行写名字。 */
function effectLook(name: string, seconds: number, into: Pose, filters: string[]) {
  if (/模糊|虚化|柔焦/u.test(name)) into.blur += 6;
  if (/闪白|闪光|曝光|频闪|闪烁/u.test(name)) into.bright += 0.6 * Math.max(0, Math.sin(seconds * Math.PI * 4));
  if (/抖|震|晃|摇/u.test(name)) into.x += 0.02 * Math.sin(seconds * Math.PI * 16);
  if (/黑白|褪色/u.test(name)) filters.push("grayscale(1)");
  if (/老电影|胶片|复古|录像|VHS|DV|怀旧/iu.test(name)) filters.push("sepia(0.5) contrast(1.1)");
  if (/负片|反色/u.test(name)) filters.push("invert(1)");
}

function lookOf(into: Pose, filters: string[]): FeatureLook {
  const x = round(into.x * 100, 2);
  const y = round(into.y * 100, 2);
  const transform = [
    x || y ? `translate(${x}%,${y}%)` : "",
    into.scale !== 1 ? `scale(${round(into.scale, 4)})` : "",
    into.rotate ? `rotate(${round(into.rotate, 2)}deg)` : "",
  ].filter(Boolean).join(" ");
  if (into.blur > 0) filters.push(`blur(${round(into.blur, 2)}px)`);
  if (into.bright !== 1) filters.push(`brightness(${round(Math.max(0, into.bright), 3)})`);
  return { opacity: Math.min(1, Math.max(0, into.opacity)), transform, filter: filters.join(" ") };
}

const touching = (before: EditSegment, after: EditSegment) => Math.abs(end(before.timeline) - after.timeline.start_us) <= ADJACENT_US;
const transitionUs = (owner: EditMediaSegment) => owner.transition?.duration_us || owner.transition?.default_us || DEFAULT_FEATURE_US;

/**
 * 片段此刻（offsetUs 是片段里的时间）近似的样子：入场 / 出场 / 组合动画、滤镜、特效，转场是自己的在结尾半段出去、
 * 上一段的在开头半段进来（同一轨道上紧挨着才有，siblings 是这条轨道的片段）。和剪映一样不改片段本身的位置大小。
 */
export function featureLook(segment: EditSegment, offsetUs: number, siblings: readonly EditSegment[] = []): FeatureLook {
  const into: Pose = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, blur: 0, bright: 1 };
  const filters: string[] = [];
  const length = segment.timeline.duration_us;
  const seconds = offsetUs / US_PER_SECOND;
  const wobble = Math.sin(seconds * Math.PI * 12);
  for (const item of "animations" in segment ? segment.animations ?? [] : []) {
    const name = featureName(item.animation_type);
    const span = Math.min(length, item.duration_us || item.default_us || DEFAULT_FEATURE_US);
    if (item.phase === "group" || item.phase === "loop") pose(name, 0.15 * (1 - Math.cos((seconds * Math.PI * 2) / 1.6)), 1, wobble, into);
    else if (item.phase === "out") pose(name, ease((offsetUs - (length - span)) / span), -1, wobble, into);
    else pose(name, 1 - ease(offsetUs / span), 1, wobble, into);
  }
  if ("transition" in segment && segment.transition && siblings.some((other) => other.id !== segment.id && touching(segment, other))) {
    const half = transitionUs(segment) / 2;
    pose(featureName(segment.transition.transition_type), ease((offsetUs - (length - half)) / half), -1, wobble, into);
  }
  const prev = siblings.find((other) => other.id !== segment.id && touching(other, segment));
  if (prev && "transition" in prev && prev.transition) {
    const half = transitionUs(prev) / 2;
    pose(featureName(prev.transition.transition_type), 1 - ease(offsetUs / half), 1, wobble, into);
  }
  if ("filters" in segment) for (const item of segment.filters ?? []) filters.push(filterLook(featureName(item.filter_type), (item.intensity ?? 100) / 100));
  if ("effects" in segment) for (const item of segment.effects ?? []) effectLook(featureName(item.effect_type), seconds, into, filters);
  return lookOf(into, filters);
}

const PREVIEW_PAD_US = 300_000;

/**
 * 剪映素材刚加到片段上时试播的那一段（整条时间线上的微秒）：入场放开头、出场放结尾、转场放接缝前后，
 * 其余（滤镜、特效、组合动画、蒙版、字体……）放片段开头两秒。片段上没有对应的转场时为 null。
 */
export function featurePreviewRange(kind: AiEditCatalogKind, segment: EditSegment, siblings: readonly EditSegment[] = []): { from: number; to: number } | null {
  const start = segment.timeline.start_us;
  const stop = end(segment.timeline);
  const animations = "animations" in segment ? segment.animations ?? [] : [];
  const span = (phase: "in" | "out") => {
    const item = [...animations].reverse().find((entry) => (entry.phase ?? "in") === phase);
    return Math.min(segment.timeline.duration_us, item?.duration_us || item?.default_us || DEFAULT_FEATURE_US);
  };
  if (kind === "transition") {
    if (!("transition" in segment) || !segment.transition) return null;
    const half = transitionUs(segment) / 2;
    const next = siblings.find((other) => other.id !== segment.id && touching(segment, other));
    return { from: Math.max(start, stop - half - PREVIEW_PAD_US), to: next ? Math.min(end(next.timeline), stop + half + PREVIEW_PAD_US) : stop };
  }
  if (kind === "video_intro" || kind === "text_intro") return { from: start, to: Math.min(stop, start + span("in") + PREVIEW_PAD_US) };
  if (kind === "video_outro" || kind === "text_outro") return { from: Math.max(start, stop - span("out") - PREVIEW_PAD_US), to: stop };
  return { from: start, to: Math.min(stop, start + 2 * US_PER_SECOND) };
}

/** 轨道上的滤镜、特效片段（盖在下面所有画面上）此刻近似成的 CSS filter；没有时为空串。 */
export function overlayFilter(overlays: readonly EditSegment[], timeUs: number): string {
  const into: Pose = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, blur: 0, bright: 1 };
  const filters: string[] = [];
  for (const segment of overlays) {
    if (segment.kind === "track_filter") filters.push(filterLook(featureName(segment.filter_type), (segment.intensity ?? 100) / 100));
    else if (segment.kind === "track_effect") effectLook(featureName(segment.effect_type), (timeUs - segment.timeline.start_us) / US_PER_SECOND, into, filters);
  }
  return lookOf(into, filters).filter;
}

// ---------- 片段详情卡片 ----------

/** 按片段 id 找片段和它所在的轨道；不在这个工程里时为 null。 */
export function findSegment(project: Pick<EditProject, "tracks"> | null | undefined, id: string | null | undefined): { track: EditTrack; segment: EditSegment } | null {
  if (!id) return null;
  for (const track of project?.tracks ?? []) {
    const segment = track.segments.find((item) => item.id === id);
    if (segment) return { track, segment };
  }
  return null;
}

export interface ClipDetailRow {
  label: string; value: string;
  /** 颜色小方块（文字颜色、描边、纯色背景这类），rgba() 写法 */
  swatch?: string;
  /** 挂着的效果：clear_clip_feature 的 feature，详情卡上给一个「去掉」 */
  feature?: string;
}
export interface ClipDetail { kind: string; title: string; rows: ClipDetailRow[] }

const KIND_NAMES: Record<EditSegment["kind"], string> = {
  video: "视频", image: "图片", audio: "音频", text: "文字", sticker: "贴纸", track_effect: "特效", track_filter: "滤镜",
};
const FIT_NAMES: Record<EditFit, string> = { contain: "完整显示", cover: "铺满画面", stretch: "拉伸铺满" };
const KEYFRAME_NAMES: Record<string, string> = {
  transform_x: "左右位置", position_x: "左右位置", transform_y: "上下位置", position_y: "上下位置", uniform_scale: "缩放", scale_x: "横向缩放",
  scale_y: "纵向缩放", rotation: "旋转", alpha: "不透明度", volume: "音量", brightness: "亮度", contrast: "对比度", saturation: "饱和度",
};

const trim = (value: number, digits = 2) => String(round(value, digits));
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** 时间点的口语写法：「第 1.5 秒」「第 1 分 5 秒」。 */
export function secondMark(us: number): string {
  const seconds = Math.round(Math.max(0, us) / 100_000) / 10;
  if (seconds < 60) return `第 ${trim(seconds, 1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `第 ${minutes} 分 ${trim(seconds - minutes * 60, 1)} 秒`;
}

function transformRows(transform: EditTransform | null | undefined): ClipDetailRow[] {
  if (!transform) return [];
  const rows: ClipDetailRow[] = [];
  const moves: string[] = [];
  // 位移以半个画布为单位，换成占画面宽 / 高的百分比
  if (Math.abs(transform.transform_x) > 1e-4) moves.push(`向${transform.transform_x > 0 ? "右" : "左"} ${percent(Math.abs(transform.transform_x) / 2)}`);
  if (Math.abs(transform.transform_y) > 1e-4) moves.push(`向${transform.transform_y > 0 ? "上" : "下"} ${percent(Math.abs(transform.transform_y) / 2)}`);
  if (moves.length) rows.push({ label: "位置", value: `${moves.join("、")}（按画面宽高算）` });
  const { scale_x: x, scale_y: y } = transform;
  if (Math.abs(x - 1) > 1e-4 || Math.abs(y - 1) > 1e-4) rows.push({ label: "缩放", value: Math.abs(x - y) < 1e-4 ? percent(x) : `横向 ${percent(x)}、纵向 ${percent(y)}` });
  if (Math.abs(transform.rotation) > 1e-4) rows.push({ label: "旋转", value: `${transform.rotation > 0 ? "顺时针" : "逆时针"} ${trim(Math.abs(transform.rotation), 1)}°` });
  if (transform.alpha < 1) rows.push({ label: "不透明度", value: percent(Math.max(0, transform.alpha)) });
  if (transform.flip_horizontal || transform.flip_vertical) {
    rows.push({ label: "翻转", value: transform.flip_horizontal && transform.flip_vertical ? "左右、上下都翻转" : transform.flip_horizontal ? "左右翻转" : "上下翻转" });
  }
  return rows;
}

function cropText(crop: EditMediaSegment["crop"]): string | null {
  if (!cropClipPath(crop) || !crop) return null;
  const square = crop.upper_left_x === crop.lower_left_x && crop.upper_right_x === crop.lower_right_x
    && crop.upper_left_y === crop.upper_right_y && crop.lower_left_y === crop.lower_right_y;
  if (!square) return "裁成了不规则的四边形";
  const sides = [["左边", crop.upper_left_x], ["右边", 1 - crop.upper_right_x], ["上边", crop.upper_left_y], ["下边", 1 - crop.lower_left_y]] as const;
  const cut = sides.filter(([, value]) => value > 1e-4).map(([side, value]) => `${side} ${percent(value)}`);
  return cut.length ? `裁掉${cut.join("、")}` : null;
}

const featureList = (items: Array<{ name: string; extra?: string | null }>) => items.map((item) => item.extra ? `${item.name}（${item.extra}）` : item.name).join("、");

function featureRows(segment: EditSegment, reach: TransitionReach): ClipDetailRow[] {
  const rows: ClipDetailRow[] = [];
  if ("transition" in segment && segment.transition) {
    const { transition_type: type, duration_us: duration } = segment.transition;
    const name = `「${featureName(type)}」`;
    rows.push({
      label: "转场",
      feature: "transition",
      value: reach === "last" ? `设了${name}，但这是这条轨道的最后一段，后面没有片段，转场不会出现`
        : reach === "gap" ? `设了${name}，但和下一段之间隔着空当，转场可能不会出现`
          : `和下一段之间用${name}，${duration ? spokenDuration(duration) : "时长按剪映默认"}`,
    });
  }
  if ("fade" in segment && segment.fade) {
    const parts = [
      segment.fade.in_duration_us ? `开头淡入 ${spokenDuration(segment.fade.in_duration_us)}` : "",
      segment.fade.out_duration_us ? `结尾淡出 ${spokenDuration(segment.fade.out_duration_us)}` : "",
    ].filter(Boolean);
    if (parts.length) rows.push({ label: "淡入淡出", value: parts.join("，"), feature: "fade" });
  }
  if ("effects" in segment && segment.effects?.length) rows.push({ label: "特效", value: featureList(segment.effects.map((item) => ({ name: featureName(item.effect_type) }))), feature: "effects" });
  if ("filters" in segment && segment.filters?.length) {
    rows.push({ label: "滤镜", value: featureList(segment.filters.map((item) => ({ name: featureName(item.filter_type), extra: `强度 ${Math.round(item.intensity ?? 100)}%` }))), feature: "filters" });
  }
  if ("animations" in segment && segment.animations?.length) {
    rows.push({ label: "动画", value: featureList(segment.animations.map((item) => ({ name: featureName(item.animation_type), extra: item.duration_us ? spokenDuration(item.duration_us) : null }))), feature: "animations" });
  }
  if ("mask" in segment && segment.mask) {
    const mask = segment.mask as MaskSpec;
    const feather = Math.round(mask.feather ?? 0);
    rows.push({ label: "蒙版", value: [featureName(mask.mask_type), feather > 0 ? `羽化 ${feather}%` : "", mask.invert ? "反转" : ""].filter(Boolean).join("，"), feature: "mask" });
  }
  if ("chroma" in segment && segment.chroma) {
    const intensity = typeof segment.chroma.intensity === "number" ? Math.round(segment.chroma.intensity) : 20;
    rows.push({ label: "抠像", value: `抠掉接近${colorName(segment.chroma.color)}的部分，强度 ${intensity}%`, swatch: rgba(segment.chroma.color), feature: "chroma" });
  }
  if ("background_filling" in segment && segment.background_filling) {
    const fill = segment.background_filling;
    if (fill.fill_type === "blur") {
      const blur = fill.blur ?? 0.0625;
      rows.push({ label: "背景填充", value: `模糊背景，${blur <= 0.07 ? "轻度" : blur <= 0.4 ? "中度" : blur <= 0.8 ? "较重" : "最重"}模糊`, feature: "background_filling" });
    } else rows.push({ label: "背景填充", value: `纯色背景，${colorName(fill.color ?? "#000000")}`, swatch: rgba(fill.color ?? "#000000"), feature: "background_filling" });
  }
  if ("mix_mode" in segment && segment.mix_mode) rows.push({ label: "混合模式", value: featureName(segment.mix_mode.mode), feature: "mix_mode" });
  return rows;
}

/** 关键帧按属性归在一起，时间换成时间线上的第几秒（和轨道上的小菱形对得上）。 */
function keyframeRow(segment: EditSegment): ClipDetailRow | null {
  const groups = new Map<string, number[]>();
  for (const keyframe of segment.keyframes ?? []) {
    const name = KEYFRAME_NAMES[keyframe.property] ?? "其他";
    groups.set(name, [...(groups.get(name) ?? []), segment.timeline.start_us + keyframe.offset_us]);
  }
  if (!groups.size) return null;
  const lines = [...groups].map(([name, times]) => `${name}：${[...new Set(times)].sort((a, b) => a - b).map(secondMark).join("、")}`);
  return { label: "关键帧", value: lines.join("\n") };
}

function textRows(segment: EditTextSegment): ClipDetailRow[] {
  const rows: ClipDetailRow[] = [];
  rows.push({ label: "字号", value: `${trim(segment.font_size ?? 8, 1)} 号` });
  const opacity = segment.opacity ?? 1;
  rows.push({ label: "颜色", value: `${colorName(segment.color ?? "#FFFFFF")}${opacity < 1 ? `，不透明度 ${percent(opacity)}` : ""}`, swatch: rgba(segment.color ?? "#FFFFFF", opacity) });
  rows.push({ label: "字体", value: segment.font_family ? featureName(segment.font_family) : "默认字体" });
  const looks = [
    segment.bold && "加粗", segment.italic && "斜体", segment.underline && "下划线", segment.vertical && "竖排",
    segment.alignment === "left" && "左对齐", segment.alignment === "right" && "右对齐",
  ].filter(Boolean);
  if (looks.length) rows.push({ label: "样式", value: looks.join("、") });
  const spacing = [
    segment.letter_spacing ? `字间距 ${trim(segment.letter_spacing, 1)}` : "",
    segment.line_spacing ? `行间距 ${trim(segment.line_spacing, 1)}` : "",
  ].filter(Boolean);
  if (spacing.length) rows.push({ label: "间距", value: spacing.join("，") });
  if (segment.border) {
    const alphaText = (segment.border.alpha ?? 1) < 1 ? `，不透明度 ${percent(segment.border.alpha ?? 1)}` : "";
    rows.push({ label: "描边", value: `${colorName(segment.border.color ?? "#000000")}，粗细 ${Math.round(segment.border.width ?? 40)}${alphaText}`, swatch: rgba(segment.border.color ?? "#000000", segment.border.alpha ?? 1) });
  }
  if (segment.background) {
    const background = segment.background;
    rows.push({
      label: "背景",
      value: [colorName(background.color), `不透明度 ${percent(background.alpha ?? 1)}`, background.round_radius ? "圆角" : ""].filter(Boolean).join("，"),
      swatch: rgba(background.color, background.alpha ?? 1),
    });
  }
  if (segment.shadow) {
    const shadow = segment.shadow;
    rows.push({
      label: "阴影",
      value: `${colorName(shadow.color ?? "#000000")}，不透明度 ${percent(shadow.alpha ?? 1)}，距离 ${Math.round(shadow.distance ?? 5)}，模糊 ${Math.round(shadow.diffuse ?? 15)}`,
      swatch: rgba(shadow.color ?? "#000000", shadow.alpha ?? 1),
    });
  }
  if (segment.bubble) rows.push({ label: "气泡", value: "用了剪映的气泡样式，导进剪映后能看到" });
  if (segment.text_effect_id) rows.push({ label: "花字", value: "用了剪映的花字，导进剪映后能看到" });
  return rows;
}

/**
 * 点轨道上的片段时弹出的详情：按片段类型列出时间、截取、倍速、音量、摆放、文字样式和挂着的效果。
 * 给用户看的都是口语，不出现字段名；效果名换成剪映里的显示名。
 */
export function clipDetail(
  segment: EditSegment,
  options: {
    mediaName?: string | null; track?: Pick<EditTrack, "name" | "track_type" | "kind" | "mute"> & { segments?: readonly EditSegment[] };
    /** 素材是网页片段（openfilm 的页面）：透明底的叠在下面的轨道上 */
    page?: { transparent: boolean } | null;
  } = {},
): ClipDetail {
  const { track } = options;
  const rows: ClipDetailRow[] = [];
  if (options.page) rows.push({ label: "网页片段", value: options.page.transparent ? "透明底，叠在下面的画面上；看板上实时画，导入剪映用渲好的视频" : "整屏画面；看板上实时画，导入剪映用渲好的视频" });
  if (track) rows.push({ label: "所在轨道", value: trackLabel(track) });
  rows.push({ label: "时间线上", value: `${secondMark(segment.timeline.start_us)}到${secondMark(end(segment.timeline))}` });
  rows.push({ label: "时长", value: spokenDuration(segment.timeline.duration_us) });
  let title = clipLabel(segment, options.mediaName);

  switch (segment.kind) {
    case "video": case "audio": case "image": {
      if (segment.kind !== "image") {
        rows.push({ label: "截取", value: `从素材${secondMark(segment.source.start_us)}截取 ${spokenDuration(segment.source.duration_us)}` });
        const speed = segment.speed > 0 ? segment.speed : 1;
        rows.push({
          label: "速度",
          value: Math.abs(speed - 1) < 1e-6 ? "原速" : `${speed < 1 ? "放慢" : "加快"}到 ${trim(speed)} 倍，${segment.change_pitch ? "声音跟着变调" : "声音不变调"}`,
        });
        const volume = segment.volume ?? 1;
        rows.push({ label: "音量", value: `${volume <= 0 ? "静音" : percent(volume)}${track?.mute ? "（整条轨道已静音）" : ""}` });
      }
      if (segment.kind !== "audio") {
        rows.push({ label: "画面适配", value: FIT_NAMES[segment.fit ?? "contain"] });
        rows.push(...transformRows(segment.transform));
        const crop = cropText(segment.crop);
        if (crop) rows.push({ label: "裁剪", value: crop });
      }
      break;
    }
    case "text":
      title = segment.text.trim() || "（空文字）";
      rows.push(...textRows(segment), ...transformRows(segment.transform));
      break;
    case "sticker":
      rows.push({ label: "画面", value: "预览里只画了个占位框，贴纸本身导进剪映后能看到" }, ...transformRows(segment.transform));
      break;
    case "track_effect":
      rows.push({ label: "作用范围", value: "这段时间里的整个画面" });
      break;
    case "track_filter":
      rows.push({ label: "强度", value: `${Math.round(segment.intensity ?? 100)}%` }, { label: "作用范围", value: "这段时间里的整个画面" });
      break;
  }
  rows.push(...featureRows(segment, transitionReach(track?.segments, segment)));
  const keyframes = keyframeRow(segment);
  if (keyframes) rows.push(keyframes);
  return { kind: KIND_NAMES[segment.kind] ?? "片段", title, rows };
}

// ---------- 片段里的画面缩略图 ----------

/** 片段块里放几帧缩略图：每帧约 tilePx 宽，片段越宽越多，最多 max 帧；太窄（不到 16px）就不放。 */
export function filmstripCount(widthPx: number, tilePx = 40, max = 12): number {
  if (!(widthPx >= 16)) return 0;
  return Math.min(max, Math.max(1, Math.round(widthPx / tilePx)));
}

/**
 * 第 k 帧取素材里的哪一刻：source.start + k/n × source.duration（截取区间和倍速都已经算在 source 里），
 * 按 stepUs 取整好让缓存命中；不取到区间最末尾那一刻，那里常常解不出画面。
 */
export function filmstripTimes(source: EditTimeRange, count: number, stepUs = 250_000): number[] {
  if (count <= 0) return [];
  const last = Math.max(source.start_us, end(source) - 100_000);
  return Array.from({ length: count }, (_, k) => {
    const snapped = Math.round((source.start_us + (k / count) * source.duration_us) / stepUs) * stepUs;
    return Math.min(last, Math.max(source.start_us, snapped));
  });
}

/** 草稿箱不可用的原因码换成人话；采集器已经给了中文就原样用。 */
export function draftBoxReasonText(reason: string | null | undefined): string {
  const missing = "没找到剪映草稿箱：装好剪映、打开一次后再试。";
  const table: Record<string, string> = {
    platform_unsupported: "这台电脑的系统写不了剪映草稿箱，目前只支持 Windows 和 macOS。",
    index_permission_denied: "剪映草稿箱读不了，检查一下草稿文件夹的权限。",
    home_unavailable: missing,
    local_app_data_unavailable: missing,
    drafts_root_unavailable: missing,
    index_not_found: missing,
  };
  if (!reason) return missing;
  if (table[reason]) return table[reason]!;
  return /^[a-z0-9_]+$/iu.test(reason) ? missing : reason;
}

/** 某个会话最近一次点「导入剪映草稿箱」的结果；revision 是那次导入对应的工程版本。 */
export interface ExportNote { revision: number | null; tone: "ok" | "warn"; text: string }

/**
 * 导入结果只在工程还是那一版时显示：AI 之后又改过时间线，这句就过时了，
 * 让位给「之后又改过，再导入会更新同一份草稿」和剪映是否在运行的提醒。
 */
export function visibleExportNote(note: ExportNote | null | undefined, revision: number | null | undefined): ExportNote | null {
  return note && note.revision === (revision ?? null) ? note : null;
}

/**
 * 素材栏缩略图画什么：抖音素材的封面地址会过期（x-expires），封面读不出来时，
 * 已就绪的视频改画本地文件的第一帧，没就绪的退回图标。failedCover 是已经读失败的那个封面地址。
 */
export function mediaThumbView(
  item: { status: string; kind: "video" | "image" | "audio"; source: { cover?: string } },
  hasUrl: boolean,
  failedCover: string | null,
): { show: "pending" | "audio" | "image" | "cover" | "frame"; cover: string | null } {
  const cover = item.source.cover && item.source.cover !== failedCover ? item.source.cover : null;
  if (item.status !== "ready" || !hasUrl) return { show: "pending", cover };
  if (item.kind === "audio") return { show: "audio", cover: null };
  if (item.kind === "image") return { show: "image", cover: null };
  return cover ? { show: "cover", cover } : { show: "frame", cover: null };
}
