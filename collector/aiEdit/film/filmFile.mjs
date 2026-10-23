import path from "node:path";

import { FILM_FILE, clipKind, filmHtml, readFilmFile, srcHref } from "./vendor/film-doc.mjs";

// 剪辑工程 ↔ openfilm 的 film.html（协议 0.1，见 vendor/film-doc.mjs）。
// film.html 只说片段在什么时候、放在哪（left/top/width/height/rotate）、透明度、音量、倍速和淡入淡出；剪映的特效、滤镜、转场、
// 动画、蒙版、关键帧、贴纸说不了，导出时数出来告诉用户。文字没有对应的片段，各写成一个透明的小网页。
// 轨道顺序相反：我们越靠后越在上层，film.html 第一个 <section> 在最上层。

const US = 1_000_000;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const round3 = (value) => Math.round(value * 1000) / 1000;
const seconds = (us) => round3(us / US);

/** 素材按 fit 铺进画布后的大小（同页面上的 fitBox）。 */
export function fitBox(stage, media, fit = "contain") {
  const width = media?.width > 0 ? media.width : stage.width;
  const height = media?.height > 0 ? media.height : stage.height;
  if (fit === "stretch") return { width: stage.width, height: stage.height };
  const scale = fit === "cover" ? Math.max(stage.width / width, stage.height / height) : Math.min(stage.width / width, stage.height / height);
  return { width: width * scale, height: height * scale };
}

/** 片段在画布上的框（同页面上的 layerRect）：先按 fit 定大小，再乘缩放、按位移挪中心（y 向上为正）。 */
export function boxOf(stage, media, fit, transform = {}) {
  const base = fitBox(stage, media, fit);
  const width = base.width * (transform.scale_x ?? 1);
  const height = base.height * (transform.scale_y ?? 1);
  const centerX = stage.width / 2 + (transform.transform_x ?? 0) * stage.width / 2;
  const centerY = stage.height / 2 - (transform.transform_y ?? 0) * stage.height / 2;
  return { x: round3(centerX - width / 2), y: round3(centerY - height / 2), w: round3(width), h: round3(height), ...(transform.rotation ? { r: round3(transform.rotation) } : {}) };
}

/** boxOf 反过来：film.html 的框 → contain 下的位移和缩放。没写宽高的按素材比例补。 */
export function transformOf(stage, media, box) {
  if (!box) return null;
  const base = fitBox(stage, media, "contain");
  const ratio = media?.width > 0 && media?.height > 0 ? media.width / media.height : stage.width / stage.height;
  const own = { width: media?.width > 0 ? media.width : stage.width, height: media?.height > 0 ? media.height : stage.height };
  const width = box.w ?? (box.h ? box.h * ratio : own.width);
  const height = box.h ?? (box.w ? box.w / ratio : own.height);
  const centerX = box.x + width / 2;
  const centerY = box.y + height / 2;
  return {
    scale_x: round3(width / base.width), scale_y: round3(height / base.height),
    transform_x: round3((centerX - stage.width / 2) / (stage.width / 2)), transform_y: round3(-(centerY - stage.height / 2) / (stage.height / 2)),
    ...(box.r ? { rotation: round3(box.r) } : {}),
  };
}

const css = (value) => String(value).replace(/[<>"]/gu, "");
const hexColor = (hex, alpha = 1) => {
  const value = /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(hex ?? "") ? hex : "#FFFFFF";
  const own = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  return `rgba(${r},${g},${b},${round3(Math.min(1, Math.max(0, own * alpha)))})`;
};
const escapeHtml = (text) => String(text).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** 文字片段写成的小网页：透明底、画布大小，样式照看板上的 textCss（剪映 12 号字 ≈ 画布宽 6.9%）。 */
export function textPage(segment, stage) {
  const t = { scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, ...(segment.transform ?? {}) };
  const font = Math.max(1, (segment.font_size ?? 8) * 6.25 * (stage.width / 1080));
  const rules = [
    `font-size:${round3(font)}px`, `line-height:${round3(Math.min(4, Math.max(0.8, 1.25 + (segment.line_spacing ?? 0) * 0.05)))}`,
    `letter-spacing:${round3(Math.min(2, Math.max(-0.5, (segment.letter_spacing ?? 0) * 0.05)))}em`,
    `color:${hexColor(segment.color ?? "#FFFFFF", segment.opacity ?? 1)}`, `text-align:${css(segment.alignment ?? "center")}`,
    `font-weight:${segment.bold ? 700 : 400}`, `font-style:${segment.italic ? "italic" : "normal"}`, `text-decoration:${segment.underline ? "underline" : "none"}`,
    `white-space:${segment.auto_wrapping === false ? "pre" : "pre-wrap"}`, "overflow-wrap:anywhere",
    ...(segment.auto_wrapping !== false ? [`max-width:${round3(stage.width * (segment.max_line_width ?? 0.82))}px`] : []),
    ...(segment.vertical ? ["writing-mode:vertical-rl"] : []),
    ...(segment.border ? [`-webkit-text-stroke:${round3((font * (segment.border.width ?? 40)) / 400)}px ${hexColor(segment.border.color ?? "#000000", segment.border.alpha ?? 1)}`, "paint-order:stroke fill"] : []),
    ...(segment.background ? [`background:${hexColor(segment.background.color, segment.background.alpha ?? 1)}`, `padding:${round3(font * 0.12)}px ${round3(font * 0.3)}px`, `border-radius:${round3(font * (segment.background.round_radius ?? 0))}px`] : []),
  ];
  if (segment.shadow) {
    const angle = ((segment.shadow.angle ?? -45) * Math.PI) / 180;
    const distance = (font * (segment.shadow.distance ?? 5)) / 50;
    rules.push(`text-shadow:${round3(Math.cos(angle) * distance)}px ${round3(-Math.sin(angle) * distance)}px ${round3((font * (segment.shadow.diffuse ?? 15)) / 100)}px ${hexColor(segment.shadow.color ?? "#000000", segment.shadow.alpha ?? 1)}`);
  }
  const left = stage.width / 2 + t.transform_x * stage.width / 2;
  const top = stage.height / 2 - t.transform_y * stage.height / 2;
  const flip = `${t.flip_horizontal ? -1 : 1},${t.flip_vertical ? -1 : 1}`;
  const place = `position:absolute;left:${round3(left)}px;top:${round3(top)}px;width:max-content;opacity:${round3(Math.min(1, Math.max(0, t.alpha)))};`
    + `transform:translate(-50%,-50%) rotate(${round3(t.rotation)}deg) scale(${round3(t.scale_x)},${round3(t.scale_y)}) scale(${flip})`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=${stage.width}, height=${stage.height}">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
p{margin:0;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;${place};${rules.join(";")}}</style></head>
<body><p>${escapeHtml(segment.text ?? "")}</p>
<script>window.film = { frame() {} };</script>
</body></html>
`;
}

const FEATURE_NAMES = {
  effects: "特效", filters: "滤镜", animations: "动画", transition: "转场", mask: "蒙版", chroma: "抠像", background_filling: "背景填充",
  mix_mode: "混合模式", keyframes: "关键帧", crop: "裁剪", bubble: "文字气泡", text_effect_id: "花字",
};
const TRACK_DROPS = { sticker: "贴纸", effect: "特效轨", filter: "滤镜轨" };

/**
 * 工程 → film.html。mediaOf(path) 回素材库里的素材（width/height/source）；srcFor(item, path) 和 pageSrc(rel) 回 film.html 里写的相对地址；
 * textSrc(segment) 回文字小网页的地址。回 { html, texts: [{ src, html }], dropped: { 名称: 次数 } }。
 */
export function projectToFilm(project, { mediaOf, srcFor, pageSrc, textSrc }) {
  const stage = { width: project.canvas.width, height: project.canvas.height };
  const dropped = {};
  const drop = (name, count = 1) => { dropped[name] = (dropped[name] ?? 0) + count; };
  const texts = [];
  const tracks = [];
  for (const track of [...project.tracks].reverse()) {
    if (TRACK_DROPS[track.track_type]) {
      if (track.segments?.length) drop(TRACK_DROPS[track.track_type], track.segments.length);
      continue;
    }
    const clips = [];
    for (const segment of track.segments ?? []) {
      for (const [key, name] of Object.entries(FEATURE_NAMES)) {
        const value = segment[key];
        if (Array.isArray(value) ? value.length : value) drop(name);
      }
      const at = seconds(segment.timeline.start_us);
      const length = seconds(segment.timeline.duration_us);
      const fade = segment.fade ? [seconds(segment.fade.in_duration_us), seconds(segment.fade.out_duration_us)] : null;
      const overrides = fade && fade[0] + fade[1] > 0 && fade[0] + fade[1] <= length ? [{ fade }] : undefined;
      const transform = segment.transform ?? {};
      const look = [];
      if ((transform.alpha ?? 1) < 1) look.push(`opacity: ${round3(Math.max(0, transform.alpha))}`);
      if (transform.flip_horizontal || transform.flip_vertical) drop("翻转");
      if (segment.kind === "text") {
        const src = textSrc(segment);
        texts.push({ src, html: textPage(segment, stage) });
        clips.push({ id: segment.id, src, at, time: [0, length], ...(overrides ? { overrides } : {}) });
        continue;
      }
      if (!["video", "image", "audio"].includes(segment.kind)) continue;
      const item = mediaOf(segment.path);
      const page = item?.source?.type === "page" ? item.source.page : null;
      let speed = segment.speed ?? 1;
      if (segment.kind !== "image" && (speed < SPEED_MIN || speed > SPEED_MAX)) {
        drop(`超出 0.25–4 倍的倍速`);
        speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
      }
      if (page && Math.abs(speed - 1) > 1e-9) drop("网页片段的倍速");
      const from = segment.source ? seconds(segment.source.start_us) : 0;
      const to = segment.source ? seconds(segment.source.start_us + segment.source.duration_us) : length;
      const volume = segment.volume ?? 1;
      if (segment.kind === "audio") {
        clips.push({ id: segment.id, src: srcFor(item, segment.path), at, time: [from, to], ...(volume !== 1 ? { volume } : {}),
          ...(Math.abs(speed - 1) > 1e-9 ? { speed: round3(speed) } : {}), ...(overrides ? { overrides } : {}) });
        continue;
      }
      const media = item?.width ? { width: item.width, height: item.height } : null;
      const fit = segment.fit ?? "contain";
      const box = boxOf(stage, media, fit, transform);
      if (fit === "stretch") look.push("object-fit: fill");
      const style = look.length ? look.join("; ") : undefined;
      if (page) {
        const size = media && (media.width !== stage.width || media.height !== stage.height) ? { w: media.width, h: media.height } : undefined;
        // 网页片段的名字记在 title 上（film.html 留着不管），导回来还叫这个名字
        clips.push({ id: segment.id, src: pageSrc(page), at, time: [from, to], box, ...(size ? { size } : {}), ...(style ? { style } : {}), ...(overrides ? { overrides } : {}),
          ...(item.name ? { attrs: { title: String(item.name).slice(0, 200) } } : {}) });
      } else if (segment.kind === "image") {
        clips.push({ id: segment.id, src: srcFor(item, segment.path), at, time: [0, length], box, ...(style ? { style } : {}), ...(overrides ? { overrides } : {}) });
      } else {
        clips.push({ id: segment.id, src: srcFor(item, segment.path), at, time: [from, to], box, ...(volume !== 1 ? { volume } : {}),
          ...(Math.abs(speed - 1) > 1e-9 ? { speed: round3(speed) } : {}), ...(style ? { style } : {}), ...(overrides ? { overrides } : {}) });
      }
    }
    if (clips.length) tracks.push({ clips, ...(track.mute ? { muted: true } : {}) });
  }
  return { html: filmHtml({ stage: { w: stage.width, h: stage.height }, tracks }), texts, dropped };
}

/** 导出时说没带过去的：「剪映的 特效 3 处、转场 2 处 没带过去」。 */
export function droppedText(dropped) {
  const parts = Object.entries(dropped).map(([name, count]) => `${name} ${count} 处`);
  return parts.length ? `film.html 只记位置、大小、透明度、音量、倍速和淡入淡出，${parts.join("、")}没带过去。` : "";
}

/** 素材库里叫什么：文件名；网页叫 index.html 的用它的文件夹名 */
function clipName(clip) {
  const parts = srcHref(clip.src).split("/").filter(Boolean);
  const file = parts.at(-1) ?? clip.id;
  if (clip.attrs?.title) return clip.attrs.title;
  return /^index\.html?$/iu.test(file) && parts.length > 1 ? parts.at(-2) : file;
}

/**
 * 读 film.html，排成要建的轨道（我们的顺序：最后一条在最上层）。每个 <section> 拆成画面轨和声音轨。
 * 回 { canvas, tracks: [{ type: "video"|"audio", clips: [{ kind, file, at, time, box, volume, speed, fade, opacity, page }] }], skipped }；
 * 读不懂抛错，带 film.html 的问题列表。folder 是 film.html 所在的文件夹。
 */
export function filmToPlan(text, folder) {
  const read = readFilmFile(text);
  if (!read.doc) {
    const error = new Error(read.problems.slice(0, 5).join("\n"));
    error.problems = read.problems;
    throw error;
  }
  const { stage, tracks } = read.doc;
  const skipped = {};
  const skip = (name) => { skipped[name] = (skipped[name] ?? 0) + 1; };
  const plan = [];
  for (const track of [...tracks].reverse()) {
    if (track.hidden) { skip("隐藏的轨道"); continue; }
    const picture = [];
    const sound = [];
    for (const clip of track.clips) {
      const kind = clipKind(clip.src);
      if (/^[a-z][a-z0-9+.-]*:/iu.test(clip.src)) { skip("网上的文件"); continue; }
      const file = path.resolve(folder, srcHref(clip.src));
      const own = (clip.overrides ?? []).find((entry) => entry.at === undefined);
      if ((clip.overrides ?? []).some((entry) => entry.at !== undefined)) skip("网页里元素的手动改动");
      if (clip.class) skip("CSS 类名样式");
      const opacity = /(?:^|;)\s*opacity\s*:\s*([\d.]+)/u.exec(clip.style ?? "")?.[1];
      const entry = {
        kind: clip.sound ? "sound-of-video" : kind, file, at: clip.at ?? 0, time: clip.time ?? null, box: clip.box ?? null,
        volume: track.muted ? 0 : clip.volume ?? 1, speed: clip.speed ?? 1, fade: own?.fade ?? null,
        ...(opacity !== undefined ? { opacity: Math.min(1, Number(opacity)) } : {}), size: clip.size ?? null, name: clipName(clip),
      };
      if (entry.kind === "sound-of-video") { skip("单独用视频里的声音"); continue; }
      (kind === "sound" ? sound : picture).push(entry);
    }
    // openfilm 的片子里同一轨道前后两段常差几毫秒地叠着（网页按自己的时长放），剪映不许重叠：前一段截到后一段开头
    for (const list of [picture, sound]) {
      list.sort((a, b) => a.at - b.at);
      list.forEach((clip, index) => { if (list[index + 1]) clip.until = list[index + 1].at; });
    }
    if (picture.length) plan.push({ type: "video", clips: picture });
    if (sound.length) plan.push({ type: "audio", clips: sound });
  }
  return { canvas: { width: stage.w, height: stage.h }, tracks: plan, skipped };
}

export { FILM_FILE };
