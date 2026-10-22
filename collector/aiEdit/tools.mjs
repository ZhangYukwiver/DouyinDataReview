import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { modelFetch } from "../systemProxy.mjs";
import { AnalysisError, requestAnalysis } from "../videoAnalysis.mjs";
import { normalizeDouyinVideoUrl } from "../videoDownloader.mjs";
import { members } from "./catalog.mjs";
import { requestCompletion } from "./chat.mjs";
import { EditError, invalid } from "./errors.mjs";
import { AiEditError } from "./library.mjs";
import { LOOK_UNAVAILABLE, lookMaterials, seesNoImages, seesNoVideo, videoRefused } from "./look.mjs";

// 给模型的工具（function calling）。工程 id 由会话决定，不让模型填；时间参数对模型一律用秒（可带小数），
// 这里换成整数微秒；素材用素材库的 media_id，这里换成素材文件的绝对路径。请求体字段保持原仓库的 snake_case，
// 校验全部交给 ProjectStore（和 JianYingAPI 一致），出错把 { ok:false, code, message } 回给模型让它自己改。
//
// 工具 ↔ ProjectStore 方法对照：
//   get_timeline            getProject（精简成时间线摘要）
//   rename_project          updateProject
//   set_canvas              setCanvas
//   create_track            createTrack
//   update_track            updateTrack
//   delete_track            deleteTrack
//   reorder_tracks          reorderTracks
//   add_media_clip          addMediaSegment
//   add_text_clip           addTextSegment
//   add_sticker_clip        addStickerSegment
//   add_track_effect        addTrackEffectSegment
//   add_track_filter        addTrackFilterSegment
//   update_clip             updateSegment（只改部分时间时先 getSegment 补齐）
//   move_clip               moveSegment
//   split_clip              splitSegment
//   delete_clip             deleteSegment
//   get_clip                getSegment
//   add_keyframes           addKeyframes
//   list_keyframes          listKeyframes
//   remove_keyframe         removeKeyframe
//   add_effect              addEffect
//   add_filter              addFilter
//   add_animation           addAnimation
//   add_transition          addTransition
//   add_fade                addFade
//   clear_clip_feature      clearFeature
//   add_mask                addMask
//   add_chroma              addChroma
//   add_background_filling  addBackgroundFilling
//   set_mix_mode            setMixMode
//   add_marker              addMarker
//   list_markers            listMarkers
//   remove_marker           removeMarker
//   add_subtitles           addSrtSubtitles（也接受逐条字幕，这里拼成 SRT）
//   remove_subtitles        removeSubtitleGroup
//   export_to_jianying      mediaInfos + 草稿箱 createDraft / repairDraft
// 宿主内部用、不给模型：createProject（新建会话）、deleteProject（删会话）、listProjects（不需要，会话就是工程列表）。
// 另外几个不碰工程的工具：list_media、search_my_records、import_douyin_video、search_catalog，
// 以及参考视频用的 search_douyin（探索的抖音搜索）和 analyze_reference（用 AI 剪辑自己的模型看视频，提示词借用解析库的）。

const MICROS = 1_000_000;
const DEFAULT_IMAGE_SECONDS = 3;
const IMPORT_TIMEOUT_MS = 3 * 60_000;
// 剪映的图片素材时长固定 3 小时（draft.mjs 的 PHOTO_DURATION）；ProjectStore 按 24 小时放行，这里先拦下。
const PHOTO_LIMIT_US = 10_800_000_000;
// 字幕默认放在画面下方，同 pyJianYingDraft import_srt 的 transform_y=-0.8。
const SUBTITLE_TRANSFORM = { transform_y: -0.8 };

const TRACK_TYPES = { video: "视频", audio: "音频", text: "文字", sticker: "贴纸", effect: "特效", filter: "滤镜" };
const KIND_NAMES = { video: "视频", image: "图片", audio: "音频", text: "文字", sticker: "贴纸", track_effect: "特效", track_filter: "滤镜" };

const CATALOG_KINDS = {
  video_effect: { enums: ["VideoSceneEffectType", "VideoCharacterEffectType"], label: "画面特效（片段特效和特效轨道都用）" },
  audio_effect: { enums: ["AudioSceneEffectType", "ToneEffectType", "SpeechToSongType"], label: "音频特效（变声、音色、唱歌）" },
  filter: { enums: ["FilterType"], label: "滤镜" },
  transition: { enums: ["TransitionType"], label: "转场" },
  mask: { enums: ["MaskType"], label: "蒙版" },
  mix_mode: { enums: ["MixModeType"], label: "混合模式" },
  font: { enums: ["FontType"], label: "字体" },
  video_intro: { enums: ["IntroType"], label: "视频/图片入场动画" },
  video_outro: { enums: ["OutroType"], label: "视频/图片出场动画" },
  video_group: { enums: ["GroupAnimationType"], label: "视频/图片组合动画" },
  text_intro: { enums: ["TextIntro"], label: "文字入场动画" },
  text_outro: { enums: ["TextOutro"], label: "文字出场动画" },
  text_loop: { enums: ["TextLoopAnim"], label: "文字循环动画" },
};

// 剪映（pyJianYingDraft）对片段动画、音效、蒙版、字体的规则只在生成草稿时检查；ProjectStore 照原仓库不查，
// 留到导入剪映才报错，模型就不知道该改哪一处了。工具层先按同一套规则拦下（规则见 draft/script.mjs）。
const VIDEO_EFFECT_ENUMS = ["VideoSceneEffectType", "VideoCharacterEffectType"];
const AUDIO_EFFECT_ENUMS = ["AudioSceneEffectType", "ToneEffectType", "SpeechToSongType"];
const AUDIO_EFFECT_GROUPS = { AudioSceneEffectType: "场景音", ToneEffectType: "音色", SpeechToSongType: "声音成曲" };
const VIDEO_ANIMATION_ENUMS = ["IntroType", "OutroType", "GroupAnimationType"];
const TEXT_ANIMATION_ENUMS = ["TextIntro", "TextOutro", "TextLoopAnim"];
const ANIMATION_SLOTS = { IntroType: "in", OutroType: "out", GroupAnimationType: "group", TextIntro: "in", TextOutro: "out", TextLoopAnim: "loop" };
const SLOT_NAMES = { in: "入场", out: "出场", group: "组合", loop: "循环" };

// ---------- 单位换算 ----------

const has = (object, key) => Object.hasOwn(object, key) && object[key] !== undefined;

function numeric(value) {
  if (typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/u.test(value)) return Number(value);
  return value;
}

/** 秒 → 整数微秒；不是数字就原样交给 ProjectStore 去报错。 */
export function micros(value) {
  const number = numeric(value);
  return typeof number === "number" && Number.isFinite(number) ? Math.round(number * MICROS) : number;
}

/** 整数微秒 → 秒。不四舍五入：模型常把上一段的 end 原样填成下一段的 start，丢了精度就会差几百微秒被判重叠。 */
export function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) ? value / MICROS : null;
}

/** Python round()（四舍六入五成双），和 ProjectStore 校验倍速时长时用的一致，否则正好 .5 时会差 1 微秒。 */
function pyRound(value) {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function pick(source, keys) {
  const picked = {};
  for (const key of keys) if (has(source, key)) picked[key] = source[key];
  return picked;
}

function trackEndUs(track) {
  return Math.max(0, ...(track?.segments ?? []).map((segment) => segment.timeline.start_us + segment.timeline.duration_us));
}

export function projectDurationUs(project) {
  return Math.max(0, ...project.tracks.map(trackEndUs));
}

/** 把工程里的对象换成模型看的样子：*_us 换成秒，素材路径换成 media_id。 */
function forModel(value, library) {
  if (Array.isArray(value)) return value.map((item) => forModel(item, library));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "path") result.media_id = library.idForPath(item) ?? "（不在素材库里）";
    else if (key === "id") result.clip_id = item;
    else if (key.endsWith("_us") && typeof item === "number") result[key.slice(0, -3)] = seconds(item);
    else result[key] = forModel(item, library);
  }
  return result;
}

// ---------- 时间线摘要（get_timeline 和系统提示都用） ----------

function clipSummary(segment, library) {
  const { start_us: start, duration_us: duration } = segment.timeline;
  const clip = { clip_id: segment.id, kind: segment.kind, start: seconds(start), duration: seconds(duration), end: seconds(start + duration) };
  if (["video", "image", "audio"].includes(segment.kind)) {
    clip.media_id = library.idForPath(segment.path) ?? "（不在素材库里）";
    if (segment.material_name) clip.name = segment.material_name;
    if (segment.kind !== "image" && segment.source) Object.assign(clip, { source_start: seconds(segment.source.start_us), source_duration: seconds(segment.source.duration_us) });
    if (segment.speed !== undefined && Math.abs(segment.speed - 1) > 1e-9) clip.speed = Math.round(segment.speed * 1000) / 1000;
    if (segment.volume !== undefined && segment.volume !== 1) clip.volume = segment.volume;
    if (segment.fit && segment.fit !== "contain") clip.fit = segment.fit;
  }
  if (segment.kind === "text") {
    clip.text = segment.text.length > 80 ? `${segment.text.slice(0, 80)}…` : segment.text;
    if (segment.font_family) clip.font = segment.font_family;
  }
  if (segment.kind === "sticker") clip.resource_id = segment.resource_id;
  if (segment.kind === "track_effect") clip.effect = segment.effect_type;
  if (segment.kind === "track_filter") Object.assign(clip, { filter: segment.filter_type, intensity: segment.intensity });
  if (segment.transform) clip.transform = segment.transform;
  if (segment.effects?.length) clip.effects = segment.effects.map((item) => item.effect_type);
  if (segment.filters?.length) clip.filters = segment.filters.map((item) => item.filter_type);
  if (segment.animations?.length) clip.animations = segment.animations.map((item) => item.animation_type);
  if (segment.transition) clip.transition = { type: segment.transition.transition_type, duration: seconds(segment.transition.duration_us) };
  if (segment.fade) clip.fade = { in: seconds(segment.fade.in_duration_us), out: seconds(segment.fade.out_duration_us) };
  if (segment.mask) clip.mask = segment.mask.mask_type;
  if (segment.chroma) clip.chroma = true;
  if (segment.background_filling) clip.background_filling = segment.background_filling.fill_type;
  if (segment.mix_mode) clip.mix_mode = segment.mix_mode.mode;
  if (segment.crop) clip.crop = true;
  if (segment.keyframes?.length) clip.keyframes = segment.keyframes.length;
  return clip;
}

/** 片段的人话称呼（给页面显示、也给模型看）：视频“海边.mp4”、文字“周末去海边”（前 16 个字）、贴纸、特效“闪白”。 */
export function clipLabel(segment) {
  const quote = (value, max = 40) => `“${[...String(value ?? "").replace(/\s+/gu, " ").trim()].slice(0, max).join("")}”`;
  switch (segment?.kind) {
    case "video":
    case "image":
    case "audio":
      return `${KIND_NAMES[segment.kind]}${quote(segment.material_name ?? String(segment.path ?? "").split(/[\\/]/u).at(-1))}`;
    case "text": return `文字${quote(segment.text, 16)}`;
    case "sticker": return "贴纸";
    case "track_effect": return `特效${quote(segment.effect_type)}`;
    case "track_filter": return `滤镜${quote(segment.filter_type)}`;
    default: return "片段";
  }
}

/** 轨道的人话称呼，同页面上的 trackLabel：原仓库的默认名是英文类型名（Video、Subtitles），换成中文。 */
export function trackLabel(track) {
  const name = String(track?.name ?? "").trim();
  if (track?.kind === "subtitle" && (!name || name === "Subtitles")) return "字幕";
  if (!name || name.toLowerCase() === track?.track_type) return TRACK_TYPES[track?.track_type] ?? "轨道";
  return name;
}

export function timelineSummary(project, library) {
  return {
    name: project.name,
    canvas: { ...project.canvas },
    duration: seconds(projectDurationUs(project)),
    tracks: project.tracks.map((track, index) => ({
      track_id: track.id,
      type: track.track_type,
      name: track.name,
      layer: index + 1,
      ...(track.mute ? { mute: true } : {}),
      ...(track.kind === "subtitle" ? { subtitles: true } : {}),
      clips: (track.segments ?? []).map((segment) => clipSummary(segment, library)),
    })),
    markers: (project.markers ?? []).map((marker) => ({ time: seconds(marker.time_us), label: marker.label })),
  };
}

function mediaForModel(item) {
  return {
    media_id: item.id,
    name: item.name,
    kind: item.kind,
    status: item.status,
    ...(item.status === "failed" ? { error: item.error } : {}),
    duration: item.kind === "image" ? null : seconds(item.durationUs),
    ...(item.width ? { size: `${item.width}×${item.height}` } : {}),
    ...(item.kind === "video" ? { has_audio: item.hasAudio } : {}),
    from: item.source?.type === "douyin" ? `抖音${item.source.author ? ` @${item.source.author}` : ""}` : "本机文件",
  };
}

// ---------- 系统提示 ----------

function mediaLine(item) {
  const kind = KIND_NAMES[item.kind] ?? item.kind;
  const length = item.kind === "image" ? "时长自定" : item.durationUs ? `${seconds(item.durationUs)} 秒` : "时长未知";
  const size = item.width ? `${item.width}×${item.height}` : "尺寸未知";
  const audio = item.kind === "video" ? (item.hasAudio ? "有声音" : "无声音") : "";
  const state = item.status === "ready" ? "" : item.status === "importing" ? "（还在导入）" : `（导入失败：${item.error ?? "原因不明"}）`;
  return `- ${item.id}｜${kind}｜${item.name}｜${length}｜${size}${audio ? `｜${audio}` : ""}${state}`;
}

/**
 * 系统提示只放一轮里基本不变的内容（规则、工程名和画布、素材清单）：方舟等接口按前缀缓存，
 * 系统提示一变后面整段历史都得重新算。总时长和当前时间线每做一步都会变，放在 buildContextMessage 里、每次请求附在最后。
 */
export function buildSystemPrompt({ project, media, goal = "" }) {
  const { width, height, fps } = project.canvas;
  const orientation = width === height ? "方形" : width > height ? "横屏" : "竖屏";
  const listed = media.slice(0, 120);
  return [
    "你是「AI 剪辑」助手：按用户的要求，用工具在这个剪辑工程里编排时间线（加素材、剪切、字幕、特效、转场、动画等），用户最后把它导入剪映草稿箱继续精修或导出。",
    "用户在右边的看板上也能自己动手：挪动（也能挪到别的轨道）、裁剪、切开、复制、删除片段，改文字内容，调位置和大小，给轨道静音，调轨道的上下层，还能撤销、重做。用户消息开头可能带着应用附上的说明（标着「应用自动附上，不是用户说的话」）：一是用户在看板上手动改过哪些地方，那些是用户自己的决定，以工程现状为准，别改回去，除非用户这次明说；二是用户在画面上框出的一块，用户说的「这里」「这块」「这个」指的就是框里的片段，只改它们，框外的别动。",
    "",
    `工程「${project.name}」：画布 ${width}×${height}（${orientation}），${fps} 帧/秒。`,
    // 目标写在系统提示里，对话历史太长被裁掉时也还在
    ...(goal ? [
      "",
      // 改目标不进对话历史，模型分不出它和历史里的话谁先谁后：目标就算最新的，只让用户最新一条消息压过它
      "用户给这条片子定的目标（用户随时会改，这里永远是最新的）：每一步都朝着它做，做完对照它检查一遍还差什么。对话里更早的要求和它冲突时以目标为准；只有用户最新一条消息明确要求不一样的做法时才照那条做，并提醒用户可以顺手改一下目标。",
      goal,
    ] : []),
    "每次请求的最后一条消息是应用自动附上的「工程现状」（当前总时长和时间线），以它为准；那条不是用户说的话，不用回应它。",
    "",
    "规则：",
    "- 所有时间参数都用秒（可以带小数）。片段的 start 是它在时间线上的开始时间，duration 是它在时间线上占多长；关键帧、分割用的 offset 是从片段开头算起的秒数。",
    "- 素材只能用素材库里的 media_id。用户想用抖音上的视频时，先用 search_my_records 在用户自己的点赞、收藏和观看记录里找，再用 import_douyin_video 导入；找不到合适的就直说，别编。",
    "- 用户说「参考 X 同款」「照着某条热门视频剪」时：先用 search_douyin 搜，挑一两条点赞多、时长合适的用 analyze_reference 解析，再按解析出的分段、每段时长、转场、字幕样式和配乐节奏，用素材库里用户自己的素材复刻。别人的视频只当参考，不要导入，也不要放进时间线当成片；用户的素材不够复刻时直说还缺什么。这两个工具返回 ok:false 时，把 message 里的原因转告用户，不要反复重试。",
    "- 轨道按列表顺序叠放：越靠后的轨道越在上层，会盖住前面的轨道。文字、贴纸、特效、滤镜轨道要放在视频轨道后面才看得见；画中画、叠加画面要另建一条视频轨道放在后面。需要调整层级用 reorder_tracks。",
    "- 视频和图片只能放视频轨道，音频只能放音频轨道，文字放文字轨道。同一条轨道上的片段不能重叠。轨道名字不要重复。",
    "- 背景音乐比成片短时，把同一段音乐在同一条音频轨道上接着多放几段来循环，最后一段截短；不要靠变速拉长（会变慢变调）。",
    "- 做卡点、快闪这类跟着音乐切的片子：先用 detect_beats 测配乐的节拍，再把每一刀、文字出现和转场放在拍点上（重拍适合放转场或闪白），不要凭感觉估。参考视频解析结果里写了切点和拍点的关系，照着那个节奏来。",
    "- 视频片段可以用 source_start / source_duration 截取素材里的一段；时间线上的时长 = 截取长度 ÷ 倍速，不能超出素材本身的长度。图片最长 3 小时，不能变速。",
    "- 工具参数里没有 end：时间线里的 end 只是给你看的结束时间，改时长用 duration。",
    "- 位置、缩放、旋转、不透明度都写在 transform 对象里，例如 \"transform\": {\"transform_y\": -0.8}。transform_x / transform_y 以画布中心为 0，单位是半个画布宽 / 高，x 向右为正，y 向上为正（字幕一般放在 -0.8 左右，add_subtitles 默认就放在这里）。",
    "- 分屏、宫格、拼图（七分屏、左右或上下分屏、九宫格等）：先把片段放上时间线，再用 arrange_grid 一次排好，不要自己算 transform 和蒙版。",
    "- 画布以上面写的为准，用户可能已经在界面上选好了比例，没被要求就别改。用户在对话里要横屏、竖屏、方形、16:9，或者说要发到 B 站、YouTube 这类横屏平台，先用 set_canvas 改好画布再排时间线；当前是竖屏而素材大多横拍时，在回复里提一句可以改成横屏。改了画布，用 arrange_grid 排过的分屏会自动按新画布重排。",
    "- add_subtitles 建的字幕轨（时间线里标着 subtitles: true）只能整组加、删；已有的字幕可以用 update_clip 逐条改，但不能往字幕轨上单独加片段，要加标题或单独一句文字就另建一条文字轨道。",
    "- 每个片段的入场、出场、组合（文字是循环）动画各只能有一个，视频的组合动画不能和入场、出场同时用；音频片段的同类音效只能有一个。要换掉就先用 clear_clip_feature 去掉那一类再加。",
    "- 特效、滤镜、转场、动画、蒙版、混合模式、字体只能用剪映内置的名称：先用 search_catalog 查到准确名称再用，不要自己编。尽量挑不需要会员的（vip 为 false）。",
    "- 工具返回 ok:false 时，读 message 和 details 改正参数再试（报错里带 _us 的字段是微秒，对应你给的秒数参数）；不要把同样的错误调用重复好几次。",
    "- 用户只是聊天或提问时不用动时间线。要求不清楚时先按最合理的理解做出来，再告诉用户可以怎么调。",
    "- 用户说导入剪映、导出、放进草稿箱时用 export_to_jianying；剪映开着的时候导不进去，要提醒用户先退出剪映。",
    "- export_to_jianying 返回 draft_changed（剪映里那份草稿在上次导入后被用户打开或改过）时，先问用户：另存一份新草稿，还是覆盖剪映里的改动（覆盖会丢掉用户在剪映里做的修改）。用户明确选了再带上 mode 重新调用（另存填 new，覆盖填 update），不要替用户选。",
    "- 工程名就是导入剪映后的草稿名。第一轮剪完后，如果工程名还是「未命名剪辑」或用户第一句话的开头，用 rename_project 起一个 15 字以内、看得出内容的名字；用户自己起过名就别改。",
    "- 做完后用一两句自然的中文告诉用户改了什么、现在总共多长。不要提字段名、id、英文参数名或工具名，不要贴 JSON，也不要用“已为您”这种客服腔。",
    "",
    `素材库（media_id｜类型｜名称｜时长｜尺寸）${listed.length ? "：" : "：还没有素材，用户可以在左边添加本机文件或从内容库添加。"}`,
    ...listed.map(mediaLine),
    ...(media.length > listed.length ? [`（还有 ${media.length - listed.length} 个更早的素材，用 list_media 查看）`] : []),
  ].join("\n");
}

/** 每次请求附在最后的工程现状（不进历史）：每做一步都会变，放在最后才不打断前面的前缀缓存。 */
export function buildContextMessage({ project, library }) {
  return [
    "【工程现状：应用自动附上，不是用户说的话】",
    `当前总时长 ${seconds(projectDurationUs(project))} 秒。当前时间线：`,
    JSON.stringify(timelineSummary(project, library)),
  ].join("\n");
}

// ---------- 参数模式 ----------

const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const choice = (values, description) => ({ type: "string", enum: values, description });
const obj = (properties, required = [], description) => ({
  type: "object", properties, ...(required.length ? { required } : {}), ...(description ? { description } : {}),
});

const TRACK_ID = str("轨道的 track_id（从时间线里看）");
// move_clip、duplicate_clip 换轨道时能去哪（规则在 ProjectStore 的 checkTrackFits）
const FITTING_TRACKS = "视频和图片只能放视频轨道，音频放音频轨道，文字放文字轨道（字幕轨除外），贴纸、特效、滤镜各放各的轨道；字幕轨上的字幕不能挪走或复制";
const CLIP_ID = str("片段的 clip_id（从时间线里看）");
const START = num("在时间线上的开始时间（秒）", { minimum: 0 });
const DURATION = num("在时间线上占多长（秒）", { exclusiveMinimum: 0 });
const COLOR = str("颜色，#RRGGBB");
const COLOR_ALPHA = str("颜色，#RRGGBBAA（最后两位是不透明度）");

const TRANSFORM = obj({
  scale_x: num("水平缩放，1 是原始大小", { exclusiveMinimum: 0, maximum: 100 }),
  scale_y: num("垂直缩放，1 是原始大小", { exclusiveMinimum: 0, maximum: 100 }),
  transform_x: num("水平位置，-1 到 1，0 是画布中心，向右为正", { minimum: -1, maximum: 1 }),
  transform_y: num("垂直位置，-1 到 1，0 是画布中心，向上为正", { minimum: -1, maximum: 1 }),
  rotation: num("旋转角度，-360 到 360", { minimum: -360, maximum: 360 }),
  alpha: num("不透明度，0 到 1", { minimum: 0, maximum: 1 }),
  flip_horizontal: bool("水平翻转"),
  flip_vertical: bool("垂直翻转"),
}, [], "位置、缩放、旋转、不透明度；没填的项用默认值");

const CROP = obj(Object.fromEntries(["upper_left", "upper_right", "lower_left", "lower_right"].flatMap((corner) => [
  [`${corner}_x`, num(`${corner} 角在原画面里的水平位置，0 到 1`, { minimum: 0, maximum: 1 })],
  [`${corner}_y`, num(`${corner} 角在原画面里的垂直位置，0 到 1`, { minimum: 0, maximum: 1 })],
])), [], "裁剪：四个角在原画面里的位置，默认是整幅画面");

const FIT = choice(["contain", "cover", "stretch"], "画面和画布比例不同时：contain 完整显示（默认），cover 铺满并裁掉多出的部分，stretch 拉伸铺满");

const TEXT_STYLE = {
  font_size: num("字号，1 到 100，默认 8", { minimum: 1, maximum: 100 }),
  color: COLOR,
  alignment: choice(["left", "center", "right"], "对齐方式"),
  font_family: str("剪映字体名（先用 search_catalog 查 font）"),
  bold: bool("加粗"),
  italic: bool("斜体"),
  underline: bool("下划线"),
  opacity: num("文字不透明度，0 到 1", { minimum: 0, maximum: 1 }),
  vertical: bool("竖排"),
  letter_spacing: int("字间距，-1000 到 1000"),
  line_spacing: int("行间距，-1000 到 1000"),
  auto_wrapping: bool("自动换行，默认开"),
  max_line_width: num("自动换行时一行最多占画布宽度的比例，0 到 1，默认 0.82", { exclusiveMinimum: 0, maximum: 1 }),
  border: obj({ color: COLOR, alpha: num("不透明度 0 到 1"), width: num("描边粗细 0 到 100，默认 40") }, [], "描边"),
  background: obj({
    color: COLOR_ALPHA,
    style: int("背景样式 1 或 2", { enum: [1, 2] }),
    alpha: num("不透明度 0 到 1"),
    round_radius: num("圆角 0 到 1"),
    height: num("高度 0 到 1"),
    width: num("宽度 0 到 1"),
    horizontal_offset: num("水平偏移 0 到 1，默认 0.5"),
    vertical_offset: num("垂直偏移 0 到 1，默认 0.5"),
  }, ["color"], "文字背景"),
  shadow: obj({ color: COLOR, alpha: num("不透明度 0 到 1"), diffuse: num("模糊 0 到 100"), distance: num("距离 0 到 100"), angle: num("角度 -360 到 360") }, [], "阴影"),
  bubble: obj({ effect_id: str("气泡的 effect_id"), resource_id: str("气泡的 resource_id") }, ["effect_id", "resource_id"], "剪映气泡（需要知道素材 id，一般不用）"),
  text_effect_id: str("剪映花字的 effect_id（需要知道素材 id，一般不用）"),
};

const MEDIA_FIELDS = {
  volume: num("音量，0 到 2，1 是原声", { minimum: 0, maximum: 2 }),
  speed: num("倍速，大于 0.05、不超过 100，默认按截取长度和时长算", { exclusiveMinimum: 0.05, maximum: 100 }),
  change_pitch: bool("变速时是否跟着变调"),
  fit: FIT,
  transform: TRANSFORM,
  crop: CROP,
  material_name: str("在剪映素材栏里显示的名字，默认用素材名"),
};

const SUBTITLE_STYLE = ["font_size", "color", "alignment", "font_family", "bold", "italic", "underline", "opacity",
  "letter_spacing", "line_spacing", "auto_wrapping", "max_line_width", "border", "background", "shadow"];

const FEATURES = ["effects", "filters", "animations", "transition", "fade", "mask", "chroma", "background_filling", "mix_mode", "crop", "border", "background", "shadow", "bubble", "text_effect"];

const KEYFRAME_PROPERTIES = ["transform_x", "transform_y", "scale_x", "scale_y", "uniform_scale", "rotation", "alpha", "volume", "brightness", "contrast", "saturation"];

// ---------- 工具 ----------

function srtTime(value) {
  const totalMs = Math.max(0, Math.round(Number(numeric(value)) * 1000));
  const pad = (number, length = 2) => String(number).padStart(length, "0");
  return `${pad(Math.floor(totalMs / 3_600_000))}:${pad(Math.floor(totalMs / 60_000) % 60)}:${pad(Math.floor(totalMs / 1000) % 60)},${pad(totalMs % 1000, 3)}`;
}

function captionsToSrt(captions) {
  if (!Array.isArray(captions) || !captions.length) throw new AiEditError("arguments_invalid", "captions 要是非空数组，每条带 start、end（秒）和 text。");
  return captions.map((caption, index) => {
    if (!Number.isFinite(Number(numeric(caption?.start))) || !Number.isFinite(Number(numeric(caption?.end)))) {
      throw new AiEditError("arguments_invalid", `第 ${index + 1} 条字幕的 start / end 要是秒数。`);
    }
    const text = String(caption?.text ?? "").trim();
    if (!text) throw new AiEditError("arguments_invalid", `第 ${index + 1} 条字幕是空的。`);
    return `${index + 1}\n${srtTime(caption.start)} --> ${srtTime(caption.end)}\n${text}`;
  }).join("\n\n");
}

function searchCatalog({ kind, query = "", limit = 20 }) {
  const config = CATALOG_KINDS[kind];
  if (!config) throw new AiEditError("arguments_invalid", `kind 只能是 ${Object.keys(CATALOG_KINDS).join("、")}。`);
  const key = (value) => String(value ?? "").replace(/[\s_]+/gu, "").toLowerCase();
  const wanted = key(query);
  const found = config.enums.flatMap((enumName) => members(enumName)).filter((member) => !wanted
    || key(member.name).includes(wanted) || key(member.meta.name ?? member.meta.title).includes(wanted));
  const size = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20));
  return {
    kind: config.label,
    total: found.length,
    items: found.slice(0, size).map((member) => {
      const display = member.meta.name ?? member.meta.title;
      return {
        name: member.name,
        ...(display && display !== member.name ? { display } : {}),
        ...(member.meta.is_vip ? { vip: true } : {}),
        ...(member.meta.params?.length ? { params: member.meta.params.map((param) => param.name) } : {}),
        ...(member.meta.default_duration ? { default_duration: seconds(member.meta.default_duration) } : {}),
        ...(member.meta.duration ? { default_duration: seconds(member.meta.duration) } : {}),
      };
    }),
    ...(found.length > size ? { note: "结果太多，只列了前面一部分，换个更具体的关键词再查。" } : {}),
  };
}

const RECORD_SOURCES = { liked: ["liked_videos", "点赞"], favorite: ["favorite_videos", "收藏"], history: ["watch_history", "观看记录"] };

function searchRecords(ctx, { query = "", source = "all", limit = 10 }) {
  const collector = ctx.getCollector();
  if (!collector) throw new AiEditError("collector_busy", "采集器正在切换账号，稍后再查。", 409);
  const snapshot = collector.getSnapshot();
  const sources = source === "all" || !RECORD_SOURCES[source] ? Object.keys(RECORD_SOURCES) : [source];
  const tokens = String(query).toLowerCase().split(/\s+/u).filter(Boolean);
  const seen = new Set();
  const matches = [];
  for (const name of sources) {
    const [field, label] = RECORD_SOURCES[name];
    for (const record of snapshot?.records?.[field] ?? []) {
      if (!record?.url || record.mediaType === "live") continue;
      const haystack = [record.title, record.author, ...(record.topics ?? [])].join(" ").toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      const key = record.videoId ?? record.url;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ record, label });
    }
  }
  matches.sort((left, right) => String(right.record.occurredAt ?? "").localeCompare(String(left.record.occurredAt ?? "")));
  const size = Math.min(30, Math.max(1, Number.isInteger(limit) ? limit : 10));
  const inLibrary = new Map(ctx.library.list().filter((item) => item.source?.url).map((item) => [item.source.url, item.id]));
  return {
    total: matches.length,
    videos: matches.slice(0, size).map(({ record, label }) => ({
      url: record.url,
      title: record.title,
      ...(record.author ? { author: record.author } : {}),
      ...(record.topics?.length ? { topics: record.topics.slice(0, 5) } : {}),
      ...(record.durationSeconds ? { duration: record.durationSeconds } : {}),
      from: label,
      ...(record.occurredAt ? { date: record.occurredAt.slice(0, 10) } : {}),
      ...(record.mediaType === "image" ? { image_post: true, note: "图文作品，不能当素材" } : {}),
      ...(inLibrary.has(record.url) ? { media_id: inLibrary.get(record.url) } : {}),
    })),
  };
}

function findRecord(ctx, url) {
  try {
    const snapshot = ctx.getCollector()?.getSnapshot();
    for (const field of ["liked_videos", "favorite_videos", "watch_history"]) {
      const record = snapshot?.records?.[field]?.find((item) => item?.url === url);
      if (record) return record;
    }
  } catch { /* 找不到就只用模型给的信息 */ }
  return null;
}

// ---------- 参考视频：搜抖音（探索的 DirectExplorer）、看视频（AI 剪辑自己的模型 + 解析库的提示词和请求格式） ----------
// 不碰解析库：不用它的接口配置，结果也不写进解析库，只在 AI 剪辑进程里缓存。

// ponytail: 方舟请求体上限 64MB，视频 base64 后要放得下；抖音链接下的是最低一档清晰度
const ANALYSIS_BYTES = 45 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ANALYSIS_TIMEOUT_MS = 15 * 60_000;
const ANALYSIS_CHARS = 12_000;
// ponytail: 进程内缓存，重启就没了；要跨重启再落盘到 ai-edit/
const REFERENCE_CACHE_SIZE = 50;
const NO_VIDEO = "AI 剪辑配置的模型看不了视频，换一个支持视频输入的模型（比如方舟 doubao-seed）再试。";
// 模型回答自己看不到视频（正常的拆解一定带 Markdown 表格）
const LOOK_FOCUS = "上面不是原视频，是应用把参考视频拆出来的材料：镜头表、闪白位置、音乐节拍是程序测出来的，可以直接用；截图是镜头中间的一帧（镜头很多时只挑了一部分）。材料来源上面已经说明了，开头不用再写缺了原视频、音轨或台词，直接按①到⑤输出，听不到的项写「听不到」；如果你看不到截图，不要写拆解，只回答一行：NO_IMAGES。这次拆解要给剪辑照着复刻：第③部分的时间轴表按镜头表逐个镜头写（画面连续的相邻镜头可以合并成一行，但起止时间要和镜头表对上），写清每段多长、怎么切过来的（从截图和闪白位置推断硬切、闪白、推拉等）、截图里看得到的字幕样式和位置、哪些切点落在拍点上。听不到人声和歌词，不要编台词。";
const REFERENCE_FOCUS = "如果你其实看不到视频画面（只拿到了文字信息），不要写拆解，只回答一行：NO_VIDEO。这次拆解还要给剪辑照着复刻：第③部分的时间轴表请按镜头切换细分，每行写清这一段多长、怎么切过来的（硬切还是叠化、推拉、闪白等转场）、字幕的样式和位置（大小、颜色、描边、出现方式）、配乐和音效在哪里卡点。";
const SEARCH_ERRORS = {
  login_required: "没法搜索：抖音还没登录或登录已经失效。到设置 → 账号里重新扫码登录（或连接浏览器导入登录）后再搜。",
  verification_required: "抖音这次要求安全验证，没搜到结果。到设置 → 账号里重新扫码登录或连接浏览器，按提示完成验证后再搜，别马上重试。",
};
// 采集器把登录失效和安全验证都包成 browser_reconnect_required，原来的原因在 cause 里
const LOGIN_CODES = new Set(["login_required", "direct_session_missing", "browser_reconnect_required"]);

async function searchDouyin(ctx, { query, limit = 10 }) {
  const explorer = ctx.getExplorer?.();
  if (!explorer) throw new AiEditError("collector_busy", "采集器正在切换账号，稍后再搜。", 409);
  let page;
  try {
    page = await explorer.run({ kind: "videos", query }, "read", ctx.signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const reason = [error?.code, error?.cause?.code].includes("verification_required") ? "verification_required"
      : LOGIN_CODES.has(error?.code) ? "login_required" : null;
    if (reason) throw new AiEditError(reason, SEARCH_ERRORS[reason]);
    if (!error?.code) console.error("AI 剪辑搜索抖音出错:", error);
    throw new AiEditError(error?.code ?? "search_failed", error?.code && error.message ? error.message : "抖音搜索出错了，稍后再试。");
  }
  // 搜完就关掉：探索最多留 6 个页面，别把用户在探索页开着的挤掉
  await explorer.close([page.sessionId]).catch(() => undefined);
  const size = Math.min(20, Math.max(1, Number.isInteger(limit) ? limit : 10));
  const videos = page.items.filter((item) => item.url && item.mediaType !== "image").slice(0, size);
  return {
    total: videos.length,
    videos: videos.map((item) => ({
      url: item.url,
      title: item.title,
      ...(item.author ? { author: item.author } : {}),
      ...(typeof item.stats?.diggCount === "number" ? { likes: item.stats.diggCount } : {}),
      ...(item.durationSeconds ? { duration: item.durationSeconds } : {}),
    })),
    ...(videos.length ? { note: "这些是别人的视频，只能用 analyze_reference 解析来参考，不能当素材。" } : {}),
  };
}

/** 抖音链接：让采集器下最低一档清晰度（下载任务的文件在采集器的 downloads 里，按保留期自动清掉）。 */
async function downloadReference(ctx, url) {
  const busy = ctx.library.busyReason?.();
  const collector = ctx.getCollector();
  if (busy || !collector) throw new AiEditError("collector_busy", busy ?? "采集器正在切换账号，稍后再解析。", 409);
  let job;
  try {
    job = collector.startVideoDownload(url, { smallest: true });
  } catch (error) {
    throw new AiEditError(error?.code ?? "download_failed", error?.message || "参考视频没下载下来，请稍后重试。", 409);
  }
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (job?.status === "queued" || job?.status === "running") {
    if (Date.now() > deadline) throw new AiEditError("download_timeout", "参考视频下载太久了，请稍后重试。");
    await delay(ctx.pollMs ?? 1_000, undefined, { signal: ctx.signal });
    job = collector.getVideoDownloadJob(job.id);
  }
  if (job?.status !== "complete") throw new AiEditError("download_failed", job?.error ?? "参考视频没下载下来，请稍后重试。");
  const file = collector.getVideoDownloadFilePath(job.id);
  if (!file?.toLowerCase().endsWith(".mp4")) throw new AiEditError("not_video", "图文作品不能当参考视频解析，只支持视频。");
  return { file, video: job.video };
}

/** 把整段视频连同拆解提示词发给 AI 剪辑配置的模型（请求格式同解析库）。 */
async function watchVideo(ctx, file, video) {
  if ((await stat(file)).size > ANALYSIS_BYTES) throw new AiEditError("video_too_large", "这个视频超过 45MB，模型接口收不下，换一个短一点或清晰度低一点的版本。");
  let status = 0;
  const fetchImpl = async (...args) => {
    const response = await (ctx.fetchImpl ?? modelFetch)(...args);
    status = response.status;
    return response;
  };
  let markdown;
  try {
    markdown = await requestAnalysis({
      config: { ...ctx.config, focus: REFERENCE_FOCUS },
      video,
      videoBase64: (await readFile(file)).toString("base64"),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)].filter(Boolean)),
      fetchImpl,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof AnalysisError) {
      // 收不了视频的模型一般回 400/415/422，或者流里报一句不认识视频
      const noVideo = error.code === "provider_error" && videoRefused(status, error.message);
      throw new AiEditError(noVideo ? "video_unsupported" : error.code, noVideo ? `${NO_VIDEO}（${error.message}）` : error.message, error.status);
    }
    throw new AiEditError("analysis_failed", error?.name === "TimeoutError" ? "模型太久没看完这个视频，请稍后重试。" : "参考视频没解析成功，请稍后重试。");
  }
  if (seesNoVideo(markdown)) {
    throw new AiEditError("video_unsupported", NO_VIDEO);
  }
  return markdown;
}


/** 看不了视频的模型：页面在浏览器里拆出镜头截图和节拍，连同镜头表一起交给模型。 */
async function lookAtVideo(ctx, { file, video, pageUrl }) {
  if (!ctx.askLook) throw new AiEditError("look_unavailable", LOOK_UNAVAILABLE, 409);
  const look = await ctx.askLook({ kind: "reference", url: pageUrl ?? ctx.offerLookFile(file), name: video?.title });
  const { parts, measured } = lookMaterials(look);
  let markdown;
  try {
    markdown = await requestAnalysis({
      config: { ...ctx.config, focus: LOOK_FOCUS },
      video,
      parts,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)].filter(Boolean)),
      fetchImpl: ctx.fetchImpl ?? modelFetch,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof AnalysisError) throw new AiEditError(error.code, error.message, error.status);
    throw new AiEditError("analysis_failed", error?.name === "TimeoutError" ? "模型太久没看完这些截图，请稍后重试。" : "参考视频没解析成功，请稍后重试。");
  }
  if (seesNoImages(markdown)) throw new AiEditError("images_unsupported", "AI 剪辑配置的模型连截图也没看到，换一个能看图片的模型再试。");
  return { markdown, look: measured };
}

/** 配置标了看不了视频就直接拆截图；标了能看或没测过就先整段发，模型说看不到再拆截图。 */
async function watchReference(ctx, { file, video, pageUrl }) {
  if (ctx.config?.videoInput !== false) {
    try {
      return { markdown: await watchVideo(ctx, file, video) };
    } catch (error) {
      // 模型看不了，或者视频太大发不过去（页面那边能解到 200MB）：都改拆截图
      if (error?.code !== "video_unsupported" && error?.code !== "video_too_large") throw error;
    }
  }
  return lookAtVideo(ctx, { file, video, pageUrl });
}

async function analyzeReference(ctx, args) {
  if (has(args, "media_id") === has(args, "url")) throw new AiEditError("arguments_invalid", "media_id 和 url 只给一个：素材库里的视频给 media_id，抖音链接给 url。");
  let key;
  let item = null;
  if (has(args, "media_id")) {
    ctx.library.readyPath(args.media_id);
    item = ctx.library.get(args.media_id);
    if (item.kind !== "video") throw new AiEditError("not_video", "只能解析视频素材。");
    key = `media:${item.id}`;
  } else {
    try {
      key = normalizeDouyinVideoUrl(args.url);
    } catch (error) {
      throw new AiEditError(error?.code ?? "invalid_url", error?.message || "请给有效的抖音视频链接。", 400);
    }
  }
  const cached = ctx.references?.get(key);
  // 截图版的结果记着是哪个模型写的：换成别的、不确定看不了视频的模型就重新看
  const by = `${ctx.config?.baseUrl}|${ctx.config?.model}`;
  if (cached && !(cached.look && cached.by !== by && ctx.config?.videoInput !== false)) return referenceResult(cached.markdown, cached.video, cached.look);
  let file;
  let video;
  if (item) {
    file = ctx.library.readyPath(item.id);
    video = { title: item.name, author: item.source?.author, durationSeconds: seconds(item.durationUs) };
  } else {
    ({ file, video } = await downloadReference(ctx, key));
  }
  const { markdown, look } = await watchReference(ctx, { file, video, pageUrl: item ? `/v1/ai-edit/media/${item.id}/file` : null });
  remember(ctx, key, { markdown, video, look, by });
  return referenceResult(markdown, video, look);
}

function remember(ctx, key, value) {
  if (!ctx.references) return;
  ctx.references.set(key, value);
  if (ctx.references.size > REFERENCE_CACHE_SIZE) ctx.references.delete(ctx.references.keys().next().value);
}

/** 测配乐节拍：页面在浏览器里解码音轨。时间是素材自己的时间（从素材开头算）。 */
async function detectBeats(ctx, { media_id: id }) {
  ctx.library.readyPath(id);
  const item = ctx.library.get(id);
  if (item.kind === "image" || !item.hasAudio) throw new AiEditError("no_audio", "这个素材没有声音，测不了节拍。");
  const key = `beats:${item.id}`;
  let beats = ctx.references?.get(key);
  if (!beats) {
    if (!ctx.askLook) throw new AiEditError("look_unavailable", LOOK_UNAVAILABLE, 409);
    const look = await ctx.askLook({ kind: "beats", url: `/v1/ai-edit/media/${item.id}/file`, name: item.name });
    beats = { duration: look.duration, ...(look.beats ? { bpm: look.beats.bpm, beats: look.beats.times, strong: look.beats.strong } : {}) };
    remember(ctx, key, beats);
  }
  if (!beats.bpm) return { duration: beats.duration, note: "没测出稳定的节拍（可能是人声或环境声为主），卡点就按画面节奏来。" };
  return {
    duration: beats.duration,
    bpm: beats.bpm,
    beats: beats.beats.slice(0, 600),
    strong: beats.strong,
    note: "时间从这段素材开头算：片段截取了 source_start 的话要先减掉，再加上片段在时间线上的 start。切点、文字出现放在拍点上，重拍适合放转场或闪白。",
  };
}

const PROBE_VIDEO = new URL("./probe-video.mp4", import.meta.url);

/** 配置时测一下模型能不能看视频：发一段 3 秒、画面中央写着 386 的小视频，答对才算能看。 */
export async function probeVideoInput({ config, fetchImpl = modelFetch, signal }) {
  let status = 0;
  const watched = async (...args) => {
    const response = await fetchImpl(...args);
    status = response.status;
    return response;
  };
  const video = `data:video/mp4;base64,${(await readFile(PROBE_VIDEO)).toString("base64")}`;
  try {
    const reply = await requestCompletion({
      config,
      signal,
      fetchImpl: watched,
      messages: [{ role: "user", content: [
        { type: "video_url", video_url: { url: video } },
        { type: "text", text: "视频画面中央写着一个数字，是多少？只回答这个数字。看不到视频画面就回答 none。" },
      ] }],
    });
    return { videoInput: /386/u.test(reply.text), answer: reply.text.trim().slice(0, 80) };
  } catch (error) {
    // 收不了视频的模型一般直接回 400/415/422；其他错误（Key 不对、连不上）交给页面照常报
    // 和 watchVideo 一个口径：有的中转站回 200，错误放在正文或流里
    if (error?.code === "provider_error" && videoRefused(status, error.message, { strict: true })) {
      return { videoInput: false, answer: error.message.slice(0, 200) };
    }
    throw error;
  }
}

function referenceResult(markdown, video, look) {
  return {
    video: {
      ...(video?.title ? { title: video.title } : {}),
      ...(video?.author ? { author: video.author } : {}),
      ...(video?.durationSeconds ? { duration: video.durationSeconds } : {}),
    },
    ...(look ? { seen_as: "模型看不了视频，这份拆解是按应用测出的镜头截图和节拍写的", measured: look } : {}),
    analysis: markdown.length > ANALYSIS_CHARS ? `${markdown.slice(0, ANALYSIS_CHARS)}\n…（后面略）` : markdown,
    how_to_use: "只当参考，不要把这条视频放进时间线。照着第③部分时间轴的分段、每段时长、转场、字幕样式和配乐卡点，用素材库里用户自己的素材复刻；剪映里的转场、字体、特效先用 search_catalog 查到准确名称再用。",
  };
}

/** add_media_clip 的请求体：没给时长就用素材剩下的长度（图片 3 秒），没给开始时间就接在轨道末尾。 */
async function mediaClipRequest(ctx, args) {
  const path = ctx.library.readyPath(args.media_id);
  const item = ctx.library.get(args.media_id);
  const project = await ctx.store.getProject(ctx.projectId);
  assertNotSubtitles(project, args.track_id);
  const track = project.tracks.find((entry) => entry.id === args.track_id);
  const speed = numeric(args.speed);
  const rate = typeof speed === "number" && speed > 0 ? speed : 1;
  const startUs = has(args, "start") ? micros(args.start) : trackEndUs(track);
  const sourceStartUs = has(args, "source_start") ? micros(args.source_start) : 0;
  let sourceDurationUs = has(args, "source_duration") ? micros(args.source_duration) : undefined;
  let durationUs = has(args, "duration") ? micros(args.duration) : undefined;
  if (durationUs === undefined) {
    if (sourceDurationUs === undefined && item.durationUs && typeof sourceStartUs === "number") sourceDurationUs = item.durationUs - sourceStartUs;
    durationUs = typeof sourceDurationUs === "number" ? pyRound(sourceDurationUs / rate) : DEFAULT_IMAGE_SECONDS * MICROS;
  }
  const request = { path, timeline: { start_us: startUs, duration_us: durationUs } };
  if (sourceDurationUs !== undefined || has(args, "source_start")) {
    request.source = { start_us: sourceStartUs, duration_us: sourceDurationUs ?? (typeof durationUs === "number" ? pyRound(durationUs * rate) : durationUs) };
  }
  Object.assign(request, pick(args, Object.keys(MEDIA_FIELDS)));
  if (has(args, "speed")) request.speed = speed;
  request.material_name ??= item.name.slice(0, 200);
  if (item.kind === "image") checkImageLength(durationUs, request.source);
  else if (!has(args, "speed")) checkImpliedSpeed(sourceDurationUs, durationUs, item);
  return request;
}

const IMPLIED_SPEED_RANGE = [0.8, 1.25];

/**
 * 原仓库的规则是「给了截取长度和时长、没给倍速，就按两者之比自动变速」。真模型（10-19 实测）会拿 3.5 秒的音乐
 * 截 3.5 秒、放 9.8 秒去「铺满」，结果被放慢到 0.36 倍还变了调。没明确给 speed 时，推出来的倍速明显不是 1
 * 就拦下来，告诉模型该怎么做；真想变速就明确给 speed。
 */
function checkImpliedSpeed(sourceDurationUs, durationUs, item) {
  if (typeof sourceDurationUs !== "number" || typeof durationUs !== "number" || sourceDurationUs <= 0 || durationUs <= 0) return;
  const implied = sourceDurationUs / durationUs;
  if (implied >= IMPLIED_SPEED_RANGE[0] && implied <= IMPLIED_SPEED_RANGE[1]) return;
  const whole = item.durationUs ? `素材本身 ${seconds(item.durationUs)} 秒，` : "";
  throw invalid(
    "SPEED_IMPLIED",
    `截取 ${seconds(sourceDurationUs)} 秒放进 ${seconds(durationUs)} 秒，会被${implied < 1 ? "放慢" : "加快"}到 ${Math.round(implied * 100) / 100} 倍速（声音也会变调）。${whole}`
      + "想让它铺满更长的时间，就把同一个素材在同一轨道上接着多放几段（背景音乐循环就这么做），最后一段截短；"
      + "想要缩短，就减少截取长度。确实要变速时请明确给 speed。",
    { implied_speed: implied },
  );
}

async function updateClipRequest(ctx, args) {
  const current = await ctx.store.getSegment(ctx.projectId, args.clip_id);
  const request = pick(args, [...Object.keys(MEDIA_FIELDS), ...Object.keys(TEXT_STYLE), "text"]);
  if (has(args, "speed")) request.speed = numeric(args.speed);
  if (has(args, "start") || has(args, "duration")) {
    request.timeline = {
      start_us: has(args, "start") ? micros(args.start) : current.timeline.start_us,
      duration_us: has(args, "duration") ? micros(args.duration) : current.timeline.duration_us,
    };
  }
  if (has(args, "source_start") || has(args, "source_duration")) {
    request.source = {
      start_us: has(args, "source_start") ? micros(args.source_start) : current.source?.start_us ?? 0,
      duration_us: has(args, "source_duration") ? micros(args.source_duration) : current.source?.duration_us,
    };
  }
  if (!has(args, "speed") && has(args, "duration") && has(args, "source_duration") && current.kind !== "image") {
    checkImpliedSpeed(micros(args.source_duration), micros(args.duration), has(args, "media_id") ? ctx.library.get(args.media_id) : {});
  }
  if (has(args, "media_id")) {
    request.path = ctx.library.readyPath(args.media_id);
    request.material_name ??= ctx.library.get(args.media_id).name.slice(0, 200);
  }
  const kind = has(args, "media_id") ? ctx.library.get(args.media_id)?.kind : current.kind;
  if (kind === "image") checkImageLength(request.timeline?.duration_us ?? current.timeline?.duration_us, request.source ?? current.source);
  return request;
}

const timelineRange = (args) => ({ start_us: micros(args.start ?? 0), duration_us: micros(args.duration) });

/** 新建的片段/轨道接在末尾：没给开始时间就接在这条轨道最后一个片段后面。 */
async function placed(ctx, args) {
  const project = await ctx.store.getProject(ctx.projectId);
  assertNotSubtitles(project, args.track_id);
  if (has(args, "start")) return timelineRange(args);
  return { start_us: trackEndUs(project.tracks.find((track) => track.id === args.track_id)), duration_us: micros(args.duration) };
}

// ---------- 剪映规则的提前检查（出错抛 EditError：模型拿到原因，页面显示 EDIT_ERROR_TEXT 里的中文） ----------

/** 同 draft.mjs 的 resolveMember：先在几个枚举里按成员名找，都没有再按显示名找。 */
function catalogMember(enumNames, raw) {
  if (typeof raw !== "string") return null;
  for (const pass of ["name", "display"]) {
    for (const enumName of enumNames) {
      const member = members(enumName).find((item) => (pass === "name" ? item.name === raw : (item.meta.name ?? item.meta.title) === raw));
      if (member) return { enumName, member };
    }
  }
  return null;
}

/** 字幕轨不能单独加片段：ProjectStore 只回「轨道不存在」，模型会以为 id 写错了。 */
function assertNotSubtitles(project, trackId) {
  if (project.tracks.some((track) => track.id === trackId && track.kind === "subtitle")) {
    throw invalid("SUBTITLE_TRACK_LOCKED", "这是 add_subtitles 建的字幕轨，只能用 add_subtitles / remove_subtitles 整组加、删，不能往上单独加片段（已有的字幕可以用 update_clip 逐条改）。要加标题或单独一句文字，用 create_track 另建一条文字轨道。");
  }
}

function checkFont(args) {
  if (typeof args.font_family === "string" && !catalogMember(["FontType"], args.font_family)) {
    throw invalid("FONT_INVALID", `剪映里没有「${args.font_family.slice(0, 40)}」这个字体，先用 search_catalog 查 font 找到准确的 name，或者不填用默认字体。`);
  }
}

/**
 * 分屏、宫格：画布按列、行等分，每个片段等比缩放铺满（cover）或放进（contain）自己那一格，cover 再套一个格子大小的矩形蒙版遮掉多出的部分。
 * 模型自己算 transform 常错（远端实测七分屏把「半个画布宽」当成整个画布宽，七格全挤在中间，还用不等比缩放把图压扁），所以交给应用算。
 * 按 contain 的基准算（剪映里缩放 1.0 = 等比放进画布，草稿和看板都按这个）；蒙版的高、宽分别按素材高、宽的比例。
 * 缩放和蒙版跟画布比例有关，排过的记在 ctx.grids 里，换画布时 rearrangeGrids 按新画布重排。
 */
async function arrangeGrid(ctx, args) {
  const columns = args.columns;
  const rows = args.rows ?? 1;
  // 先全部核对，免得改到一半才发现某一格不对
  const seen = new Set();
  const cells = [];
  for (const cell of Array.isArray(args.cells) ? args.cells : []) {
    const row = cell?.row ?? 1;
    if (!Number.isInteger(cell?.column) || !Number.isInteger(row) || cell.column < 1 || row < 1 || cell.column > columns || row > rows) {
      throw invalid("GRID_CELL_INVALID", `格子位置不对：一共 ${columns} 列 ${rows} 行，列和行都从 1 数。`);
    }
    if (seen.has(cell.clip_id)) throw invalid("GRID_CELL_INVALID", "一个片段只能放一格；同一段画面要放好几格，先多放几个片段。");
    seen.add(cell.clip_id);
    cells.push(await gridCell(ctx, cell.clip_id, cell.column, row));
  }
  if (!cells.length) throw invalid("GRID_CELL_INVALID", "cells 里至少放一个片段。");
  const keyed = cells.filter(({ segment }) => (segment.keyframes ?? []).some((keyframe) => GRID_KEYFRAMES.has(keyframe.property))).length;
  const records = await placeInGrid(ctx, cells, { columns, rows, fit: args.fit ?? "cover" });
  if (ctx.grids) for (const record of records) ctx.grids[record.id] = record;
  return {
    project: await ctx.store.getProject(ctx.projectId),
    ...(keyed ? { note: `有 ${keyed} 个片段原来带位置、缩放或旋转关键帧，会盖住排好的格子，已经去掉。` } : {}),
  };
}

// 位置、缩放、旋转的关键帧会盖住格子算好的静态 transform
const GRID_KEYFRAMES = new Set(["transform_x", "transform_y", "scale_x", "scale_y", "uniform_scale", "rotation"]);
const GRID_KEYS = ["scale_x", "scale_y", "transform_x", "transform_y"];

async function gridCell(ctx, id, column, row) {
  const segment = await ctx.store.getSegment(ctx.projectId, id);
  if (!segment || (segment.kind !== "video" && segment.kind !== "image")) throw invalid("GRID_CLIP_INVALID", "只有视频和图片片段能排进格子。");
  const item = ctx.library.get(ctx.library.idForPath(segment.path));
  return { id, column, row, segment, material: item?.width && item?.height ? { width: item.width, height: item.height } : null };
}

/** 把核对过的片段放进格子，返回每个片段的记录（格子位置和写进去的 transform）。 */
async function placeInGrid(ctx, cells, { columns, rows, fit }) {
  const { width, height } = (await ctx.store.getProject(ctx.projectId)).canvas;
  const [cellWidth, cellHeight] = [width / columns, height / rows];
  const round = (value) => Math.round(value * 10_000) / 10_000;
  const records = [];
  for (const { id, column, row, segment, material: known } of cells) {
    // 尺寸不知道就当和画布同比例
    const material = known ?? { width, height };
    const base = Math.min(width / material.width, height / material.height);
    const [baseWidth, baseHeight] = [material.width * base, material.height * base];
    const scale = (fit === "cover" ? Math.max : Math.min)(cellWidth / baseWidth, cellHeight / baseHeight);
    const transform = {
      ...(segment.transform ?? {}),
      scale_x: round(scale),
      scale_y: round(scale),
      transform_x: round(((column - 0.5) * cellWidth) / (width / 2) - 1),
      transform_y: round(1 - ((row - 0.5) * cellHeight) / (height / 2)),
      rotation: 0,
    };
    for (const keyframe of segment.keyframes ?? []) {
      if (GRID_KEYFRAMES.has(keyframe.property)) await ctx.store.removeKeyframe(ctx.projectId, id, keyframe.property, keyframe.offset_us);
    }
    await ctx.store.updateSegment(ctx.projectId, id, { fit: "contain", transform });
    if (segment.crop) await ctx.store.clearFeature(ctx.projectId, id, "crop");
    if (segment.mask) await ctx.store.clearFeature(ctx.projectId, id, "mask");
    const [maskHeight, maskWidth] = [cellHeight / (baseHeight * scale), cellWidth / (baseWidth * scale)];
    if (fit === "cover" && (maskHeight < 0.999 || maskWidth < 0.999)) {
      await ctx.store.addMask(ctx.projectId, id, { mask_type: "矩形", size: round(Math.min(1, maskHeight)), rect_width: round(Math.min(1, maskWidth)) });
    }
    records.push({ id, columns, rows, column, row, fit, transform: Object.fromEntries(GRID_KEYS.map((key) => [key, transform[key]])) });
  }
  return records;
}

/**
 * 画布换了比例（看板上点的或 set_canvas）：arrange_grid 排过、之后位置没被改过的片段按新画布重排；
 * 改过的（模型或用户有意调过）不动，记录作废。片段删了也作废。
 */
export async function rearrangeGrids(ctx, grids) {
  const layouts = new Map();
  for (const [id, record] of Object.entries(grids)) {
    const cell = await gridCell(ctx, id, record.column, record.row).catch(() => null);
    const current = cell?.segment.transform ?? {};
    if (!cell || !GRID_KEYS.every((key) => Math.abs((current[key] ?? Number.NaN) - record.transform[key]) < 1e-6)) {
      delete grids[id];
      continue;
    }
    const key = `${record.columns}|${record.rows}|${record.fit}`;
    if (!layouts.has(key)) layouts.set(key, { layout: { columns: record.columns, rows: record.rows, fit: record.fit }, cells: [] });
    layouts.get(key).cells.push(cell);
  }
  for (const { layout, cells } of layouts.values()) {
    for (const record of await placeInGrid(ctx, cells, layout)) grids[record.id] = record;
  }
}

function checkMask(args) {
  if (!has(args, "rect_width") && !has(args, "round_corner")) return;
  const found = catalogMember(["MaskType"], args.mask_type);
  if (found && found.member.name !== "矩形") {
    throw invalid("MASK_PARAMS_INVALID", "rect_width 和 round_corner 只有矩形蒙版能用，这个蒙版去掉这两个参数再加。");
  }
}

async function checkAnimation(ctx, args) {
  const clip = await ctx.store.getSegment(ctx.projectId, args.clip_id);
  const enums = clip?.kind === "text" ? TEXT_ANIMATION_ENUMS : VIDEO_ANIMATION_ENUMS;
  const slot = ANIMATION_SLOTS[catalogMember(enums, args.animation_type)?.enumName];
  // 片段类型或动画名称不对的，交给 ProjectStore 报
  if (!slot || !["video", "image", "text"].includes(clip?.kind)) return;
  const slots = (clip.animations ?? []).map((item) => ANIMATION_SLOTS[catalogMember(enums, item.animation_type)?.enumName]);
  const clear = "要换的话先用 clear_clip_feature 去掉 animations（会去掉这个片段的全部动画），再把要留的重新加上。";
  if (slots.includes(slot)) throw invalid("ANIMATION_EXISTS", `这个片段已经有${SLOT_NAMES[slot]}动画了，同一种只能有一个。${clear}`);
  if (clip.kind !== "text" && (slots.includes("group") || (slot === "group" && slots.length))) {
    throw invalid("ANIMATION_CONFLICT", `组合动画不能和入场、出场动画同时用。${clear}`);
  }
  if (clip.kind === "text" && slot !== "loop" && slots.includes("loop")) {
    throw invalid("ANIMATION_ORDER", "这段文字已经有循环动画了，剪映要求先加入场、出场，最后加循环：先用 clear_clip_feature 去掉 animations，再按入场、出场、循环的顺序加。");
  }
}

async function checkEffect(ctx, args) {
  const clip = await ctx.store.getSegment(ctx.projectId, args.clip_id);
  if (!["video", "image", "audio"].includes(clip?.kind)) return;
  const audio = clip.kind === "audio";
  const own = catalogMember(audio ? AUDIO_EFFECT_ENUMS : VIDEO_EFFECT_ENUMS, args.effect_type);
  if (!own) {
    // 两边都没有这个名称的，交给 ProjectStore 报「没有这个特效」
    if (!catalogMember(audio ? VIDEO_EFFECT_ENUMS : AUDIO_EFFECT_ENUMS, args.effect_type)) return;
    throw invalid("EFFECT_CLIP_MISMATCH", audio
      ? "这是画面特效，只能加在视频或图片片段上；音频片段用 search_catalog 查 audio_effect 找音效。"
      : "这是音频特效（变声、音色、唱歌），只能加在音频素材的片段上；视频片段只能加画面特效（video_effect），视频自带的声音不能单独加音效。");
  }
  if (audio && (clip.effects ?? []).some((item) => catalogMember(AUDIO_EFFECT_ENUMS, item.effect_type)?.enumName === own.enumName)) {
    throw invalid("AUDIO_EFFECT_EXISTS", `这个音频片段已经有一个「${AUDIO_EFFECT_GROUPS[own.enumName]}」类的音效了，同一类只能有一个。要换的话先用 clear_clip_feature 去掉 effects 再加。`);
  }
}

function checkImageLength(durationUs, source) {
  const end = typeof source?.start_us === "number" && typeof source?.duration_us === "number" ? source.start_us + source.duration_us : 0;
  if ((typeof durationUs === "number" && durationUs > PHOTO_LIMIT_US) || end > PHOTO_LIMIT_US) {
    throw invalid("IMAGE_TOO_LONG", "图片片段最长 3 小时（剪映里图片素材就这么长），把 duration 改短。");
  }
}

const quoted = (value, max = 12) => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text ? `「${text.length > max ? `${text.slice(0, max)}…` : text}」` : "";
};

/**
 * 每个工具：description、parameters 给模型；write 表示会改工程（执行完会话 revision +1），
 * label(args) 是给页面看的动作摘要，run(ctx, args) 执行。
 */
const TOOLS = [
  {
    name: "get_timeline",
    description: "查看当前时间线：画布、总时长、每条轨道（按层级从下到上）和上面的片段。",
    parameters: obj({}),
    label: () => "看了时间线",
    run: async (ctx) => timelineSummary(await ctx.store.getProject(ctx.projectId), ctx.library),
  },
  {
    name: "list_media",
    description: "列出素材库里的全部素材（media_id、类型、时长、尺寸、状态）。",
    parameters: obj({}),
    label: () => "看了素材库",
    run: async (ctx) => ({ media: ctx.library.list().map(mediaForModel) }),
  },
  {
    name: "search_my_records",
    description: "在用户自己的抖音内容库（点赞、收藏、观看记录）里按标题、作者、话题关键词找视频，返回链接，可以再用 import_douyin_video 导入成素材。",
    parameters: obj({
      query: str("关键词，空格分隔表示都要包含；留空就按时间列出最近的"),
      source: choice(["all", "liked", "favorite", "history"], "来源：全部、点赞、收藏、观看记录，默认全部"),
      limit: int("最多返回几条，默认 10，最多 30", { minimum: 1, maximum: 30 }),
    }),
    label: (args) => `在内容库里找${quoted(args.query) || "视频"}`,
    run: async (ctx, args) => searchRecords(ctx, args),
  },
  {
    name: "import_douyin_video",
    description: "把内容库里的一条抖音视频下载进素材库，等它就绪后返回 media_id（最多等 3 分钟）。图文作品不能导入。",
    parameters: obj({
      url: str("视频链接（search_my_records 返回的 url）"),
      title: str("视频标题，可选"),
      author: str("作者，可选"),
    }, ["url"]),
    media: true,
    label: (args) => `导入了抖音视频${quoted(args.title, 16)}`,
    run: async (ctx, args) => {
      const record = findRecord(ctx, args.url);
      const item = await ctx.library.importDouyin({
        url: args.url,
        title: args.title ?? record?.title,
        author: args.author ?? record?.author ?? undefined,
        cover: record?.coverUrl,
        videoId: record?.videoId,
        durationSeconds: record?.durationSeconds,
        mediaType: record?.mediaType,
      });
      const done = await ctx.library.waitFor(item.id, { timeoutMs: IMPORT_TIMEOUT_MS, signal: ctx.signal });
      if (!done) throw new AiEditError("import_failed", "素材在导入过程中被删掉了。");
      if (done.status === "failed") throw new AiEditError("import_failed", done.error ?? "没导入成功。");
      return { media: mediaForModel(done) };
    },
  },
  {
    name: "search_douyin",
    description: "按关键词搜抖音上的公开视频（找热门同款、参考视频时用），返回链接、标题、作者、点赞数和时长。搜到的是别人的视频，只能用 analyze_reference 解析来参考，不能导入当素材。",
    parameters: obj({
      query: str("搜索关键词，1 到 100 个字"),
      limit: int("最多返回几条，默认 10，最多 20", { minimum: 1, maximum: 20 }),
    }, ["query"]),
    label: (args) => `在抖音上搜了${quoted(args.query)}`,
    run: async (ctx, args) => searchDouyin(ctx, args),
  },
  {
    name: "analyze_reference",
    description: "看懂一条参考视频：返回分段时间轴、每段时长、转场、字幕风格和配乐卡点。模型能看视频就整段看；看不了时应用会先测出镜头、截图和节拍再拆解（要开着应用）。给素材库里视频的 media_id，或者给抖音链接（search_douyin 返回的 url），两个只给一个。第一次解析一条要一两分钟，解析过的马上返回。结果只当参考，不会放进时间线。",
    parameters: obj({
      media_id: str("素材库里视频的 media_id"),
      url: str("抖音视频链接"),
    }),
    label: (args, ctx) => `解析了参考视频${quoted(args.media_id ? ctx.library.get(args.media_id)?.name : "", 16)}`,
    run: async (ctx, args) => analyzeReference(ctx, args),
  },
  {
    name: "detect_beats",
    description: "测素材库里一段音乐（或视频自带声音）的节拍：返回 BPM、每一拍的时间和重拍。做卡点、快闪时先测配乐，再把切点和文字出现放在拍点上。要开着应用（在浏览器里解码）。",
    parameters: obj({ media_id: str("素材库里音频或视频的 media_id") }, ["media_id"]),
    label: (args, ctx) => `测了配乐节拍${quoted(ctx.library.get(args.media_id)?.name ?? "", 16)}`,
    run: async (ctx, args) => detectBeats(ctx, args),
  },
  {
    name: "search_catalog",
    description: "按种类和关键词查剪映内置的特效、滤镜、转场、动画、蒙版、混合模式、字体名称。用这些效果前必须先查到准确的 name。",
    parameters: obj({
      kind: choice(Object.keys(CATALOG_KINDS), Object.entries(CATALOG_KINDS).map(([key, value]) => `${key}=${value.label}`).join("，")),
      query: str("关键词（中文名的一部分，例如“闪白”“复古”“溶解”），留空列出前面一部分"),
      limit: int("最多返回几条，默认 20，最多 50", { minimum: 1, maximum: 50 }),
    }, ["kind"]),
    label: (args) => `查了剪映的${CATALOG_KINDS[args.kind]?.label ?? "效果"}${quoted(args.query)}`,
    run: async (_ctx, args) => searchCatalog(args),
  },
  {
    name: "get_clip",
    description: "查看一个片段的全部设置（时间、截取区间、变换、文字样式、效果、关键帧等）。",
    parameters: obj({ clip_id: CLIP_ID }, ["clip_id"]),
    label: () => "看了片段设置",
    run: async (ctx, args) => ({ clip: forModel(await ctx.store.getSegment(ctx.projectId, args.clip_id), ctx.library) }),
  },
  {
    name: "rename_project",
    description: "给这个剪辑工程改名（导入剪映后就是草稿名）。",
    parameters: obj({ name: str("新名字，1 到 200 个字") }, ["name"]),
    write: true,
    label: (args) => `把工程改名为${quoted(args.name, 20)}`,
    run: async (ctx, args) => {
      const project = await ctx.store.updateProject(ctx.projectId, pick(args, ["name"]));
      await ctx.onRename?.(project.name);
      return project;
    },
  },
  {
    name: "set_canvas",
    description: "改画布尺寸和帧率（竖屏常用 1080×1920，横屏 1920×1080）。没填的项保持不变。",
    parameters: obj({
      width: int("宽，16 到 7680", { minimum: 16, maximum: 7680 }),
      height: int("高，16 到 7680", { minimum: 16, maximum: 7680 }),
      fps: int("帧率，1 到 120", { minimum: 1, maximum: 120 }),
    }),
    write: true,
    label: () => "改了画布",
    run: async (ctx, args) => {
      const { canvas } = await ctx.store.getProject(ctx.projectId);
      await ctx.store.setCanvas(ctx.projectId, { ...canvas, ...pick(args, ["width", "height", "fps"]) });
      if (ctx.grids) await rearrangeGrids(ctx, ctx.grids);
      return ctx.store.getProject(ctx.projectId);
    },
  },
  {
    name: "create_track",
    description: "新建一条轨道，加在最上层（列表最后）。返回新轨道的 track_id。",
    parameters: obj({
      track_type: choice(Object.keys(TRACK_TYPES), "video 视频/图片，audio 音频，text 文字，sticker 贴纸，effect 特效，filter 滤镜"),
      name: str("轨道名字，不要和已有的重复"),
      mute: bool("静音"),
    }, ["track_type"]),
    write: true,
    label: (args) => `新建了${TRACK_TYPES[args.track_type] ?? ""}轨道`,
    run: async (ctx, args) => ctx.store.createTrack(ctx.projectId, pick(args, ["track_type", "name", "mute"])),
  },
  {
    name: "update_track",
    description: "给轨道改名或静音/取消静音。",
    parameters: obj({ track_id: TRACK_ID, name: str("新名字"), mute: bool("是否静音") }, ["track_id"]),
    write: true,
    label: (args) => args.mute === true ? "把一条轨道静音了" : args.mute === false ? "取消了轨道静音" : "改了轨道名",
    run: async (ctx, args) => ctx.store.updateTrack(ctx.projectId, args.track_id, pick(args, ["name", "mute"])),
  },
  {
    name: "delete_track",
    description: "删除一条轨道和上面所有片段。",
    parameters: obj({ track_id: TRACK_ID }, ["track_id"]),
    write: true,
    label: () => "删了一条轨道",
    run: async (ctx, args) => ctx.store.deleteTrack(ctx.projectId, args.track_id),
  },
  {
    name: "reorder_tracks",
    description: "调整轨道层级：按从下到上的顺序给出全部轨道的 track_id（每条正好一次），越靠后越在上层。",
    parameters: obj({ track_ids: { type: "array", items: { type: "string" }, description: "全部轨道的 track_id，从下层到上层" } }, ["track_ids"]),
    write: true,
    label: () => "调整了轨道层级",
    run: async (ctx, args) => ctx.store.reorderTracks(ctx.projectId, pick(args, ["track_ids"])),
  },
  {
    name: "add_media_clip",
    description: "把素材库里的视频、图片放到视频轨道，或把音频放到音频轨道。不给 start 就接在这条轨道末尾；不给 duration 就用素材剩下的全部长度（图片默认 3 秒）。",
    parameters: obj({
      track_id: TRACK_ID,
      media_id: str("素材库里的 media_id"),
      start: START,
      duration: DURATION,
      source_start: num("从素材的第几秒开始截取，默认 0", { minimum: 0 }),
      source_duration: num("从素材里截取多长（秒），默认 = duration × 倍速", { exclusiveMinimum: 0 }),
      ...MEDIA_FIELDS,
    }, ["track_id", "media_id"]),
    write: true,
    label: (args, ctx) => `加了${KIND_NAMES[ctx.library.get(args.media_id)?.kind] ?? "素材"}片段${quoted(ctx.library.get(args.media_id)?.name, 14)}`,
    run: async (ctx, args) => ctx.store.addMediaSegment(ctx.projectId, args.track_id, await mediaClipRequest(ctx, args)),
  },
  {
    name: "add_text_clip",
    description: "在文字轨道上加一段文字（标题、说明、贴字等）。不给 start 就接在这条轨道末尾。",
    parameters: obj({
      track_id: TRACK_ID,
      text: str("文字内容，可以换行"),
      start: START,
      duration: DURATION,
      transform: TRANSFORM,
      fit: FIT,
      ...TEXT_STYLE,
    }, ["track_id", "text", "duration"]),
    write: true,
    label: (args) => `加了文字${quoted(args.text)}`,
    run: async (ctx, args) => {
      checkFont(args);
      return ctx.store.addTextSegment(ctx.projectId, args.track_id, {
        ...pick(args, ["text", "transform", "fit", ...Object.keys(TEXT_STYLE)]),
        timeline: await placed(ctx, args),
      });
    },
  },
  {
    name: "add_sticker_clip",
    description: "在贴纸轨道上加剪映贴纸（需要贴纸的 resource_id，用户没给就别用）。",
    parameters: obj({ track_id: TRACK_ID, resource_id: str("剪映贴纸的 resource_id"), start: START, duration: DURATION, transform: TRANSFORM }, ["track_id", "resource_id", "duration"]),
    write: true,
    label: () => "加了贴纸",
    run: async (ctx, args) => ctx.store.addStickerSegment(ctx.projectId, args.track_id, {
      ...pick(args, ["resource_id", "transform"]),
      timeline: await placed(ctx, args),
    }),
  },
  {
    name: "add_track_effect",
    description: "在特效轨道上加一段作用于整个画面的特效（名称先用 search_catalog 查 video_effect）。",
    parameters: obj({
      track_id: TRACK_ID,
      effect_type: str("特效名称（search_catalog 返回的 name）"),
      params: { type: "array", items: { type: "number" }, description: "特效参数，按 search_catalog 给的 params 顺序，每个 0 到 100，可选" },
      start: START,
      duration: DURATION,
    }, ["track_id", "effect_type", "duration"]),
    write: true,
    label: (args) => `加了特效${quoted(args.effect_type)}`,
    run: async (ctx, args) => ctx.store.addTrackEffectSegment(ctx.projectId, args.track_id, {
      ...pick(args, ["effect_type", "params"]),
      timeline: await placed(ctx, args),
    }),
  },
  {
    name: "add_track_filter",
    description: "在滤镜轨道上加一段作用于整个画面的滤镜（名称先用 search_catalog 查 filter）。",
    parameters: obj({
      track_id: TRACK_ID,
      filter_type: str("滤镜名称（search_catalog 返回的 name）"),
      intensity: num("强度 0 到 100，默认 100", { minimum: 0, maximum: 100 }),
      start: START,
      duration: DURATION,
    }, ["track_id", "filter_type", "duration"]),
    write: true,
    label: (args) => `加了滤镜${quoted(args.filter_type)}`,
    run: async (ctx, args) => ctx.store.addTrackFilterSegment(ctx.projectId, args.track_id, {
      ...pick(args, ["filter_type", "intensity"]),
      timeline: await placed(ctx, args),
    }),
  },
  {
    name: "update_clip",
    description: "修改一个片段：时间、截取区间、换素材、倍速、音量、画面适配、变换、裁剪、文字内容和样式。只填要改的项；transform、bubble、text_effect_id 可以传 null 清除。",
    parameters: obj({
      clip_id: CLIP_ID,
      start: START,
      duration: DURATION,
      source_start: num("从素材的第几秒开始截取", { minimum: 0 }),
      source_duration: num("从素材里截取多长（秒）", { exclusiveMinimum: 0 }),
      media_id: str("换成素材库里的另一个素材"),
      ...MEDIA_FIELDS,
      text: str("文字内容"),
      ...TEXT_STYLE,
    }, ["clip_id"]),
    write: true,
    label: () => "改了片段",
    run: async (ctx, args) => {
      checkFont(args);
      return ctx.store.updateSegment(ctx.projectId, args.clip_id, await updateClipRequest(ctx, args));
    },
  },
  {
    name: "move_clip",
    description: `把片段移到时间线上新的开始时间（时长不变，不能和目标轨道上的其他片段重叠）。给 track_id 就挪到另一条轨道上：${FITTING_TRACKS}。`,
    parameters: obj({ clip_id: CLIP_ID, start: START, track_id: str("挪到哪条轨道的 track_id，不给就留在原轨道") }, ["clip_id", "start"]),
    write: true,
    label: () => "移动了片段",
    run: async (ctx, args) => ctx.store.moveSegment(ctx.projectId, args.clip_id, micros(args.start), ...(has(args, "track_id") ? [{ trackId: args.track_id }] : [])),
  },
  {
    name: "duplicate_clip",
    description: `复制一个片段放到 start 开始：关键帧、位置大小、淡入淡出、特效、滤镜、动画、转场、蒙版、截取、倍速、文字样式全都带上，返回新片段的 clip_id。不给 track_id 就放在原轨道，也可以放到另一条轨道：${FITTING_TRACKS}。不能和目标轨道上的片段重叠。`,
    parameters: obj({ clip_id: CLIP_ID, start: START, track_id: str("放到哪条轨道的 track_id，不给就放在原轨道") }, ["clip_id", "start"]),
    write: true,
    label: () => "复制了片段",
    run: async (ctx, args) => {
      const out = await ctx.store.duplicateSegment(ctx.projectId, args.clip_id, micros(args.start), has(args, "track_id") ? { trackId: args.track_id } : {});
      // 原片段排在分屏格子里的话，复制品原样带着格子的缩放和蒙版，换画布时也得一起重排
      if (ctx.grids?.[args.clip_id]) ctx.grids[out.segment.id] = { ...ctx.grids[args.clip_id], id: out.segment.id };
      return out;
    },
  },
  {
    name: "split_clip",
    description: "在片段内某个位置把它切成两段，返回两段的 clip_id。",
    parameters: obj({ clip_id: CLIP_ID, offset: num("切点：从片段开头算起的秒数，要在片段中间", { exclusiveMinimum: 0 }) }, ["clip_id", "offset"]),
    write: true,
    label: () => "分割了片段",
    run: async (ctx, args) => {
      const record = ctx.grids?.[args.clip_id];
      const out = await ctx.store.splitSegment(ctx.projectId, args.clip_id, micros(args.offset));
      // 切开的两段都是新 id，格子记录转给它们
      if (record) {
        for (const segment of out.segments) ctx.grids[segment.id] = { ...record, id: segment.id };
        delete ctx.grids[args.clip_id];
      }
      return out;
    },
  },
  {
    name: "delete_clip",
    description: "删除一个片段。",
    parameters: obj({ clip_id: CLIP_ID }, ["clip_id"]),
    write: true,
    label: () => "删了片段",
    run: async (ctx, args) => ctx.store.deleteSegment(ctx.projectId, args.clip_id),
  },
  {
    name: "add_keyframes",
    description: "给片段加关键帧做动画（位置、缩放、旋转、不透明度、音量、亮度/对比度/饱和度）。同一属性同一时间点会覆盖。uniform_scale 不能和 scale_x/scale_y 混用；音频只能用 volume。",
    parameters: obj({
      clip_id: CLIP_ID,
      keyframes: {
        type: "array",
        description: "关键帧列表",
        items: obj({
          property: choice(KEYFRAME_PROPERTIES, "属性：transform_x/transform_y 位置（-1 到 1），scale_x/scale_y/uniform_scale 缩放（0.01 到 100），rotation 旋转（-360 到 360），alpha 不透明度（0 到 1），volume 音量（0 到 2），brightness/contrast/saturation 亮度/对比度/饱和度（-1 到 1）"),
          offset: num("从片段开头算起的秒数", { minimum: 0 }),
          value: num("这个时间点的值"),
        }, ["property", "offset", "value"]),
      },
    }, ["clip_id", "keyframes"]),
    write: true,
    label: (args) => Array.isArray(args.keyframes) ? `加了 ${args.keyframes.length} 个关键帧` : "加了关键帧",
    run: async (ctx, args) => ctx.store.addKeyframes(ctx.projectId, args.clip_id, {
      keyframes: Array.isArray(args.keyframes)
        ? args.keyframes.map((item) => ({ ...pick(item ?? {}, ["property", "value"]), offset_us: micros(item?.offset) }))
        : args.keyframes,
    }),
  },
  {
    name: "list_keyframes",
    description: "列出片段上的关键帧。",
    parameters: obj({ clip_id: CLIP_ID }, ["clip_id"]),
    label: () => "看了关键帧",
    run: async (ctx, args) => forModel(await ctx.store.listKeyframes(ctx.projectId, args.clip_id), ctx.library),
  },
  {
    name: "remove_keyframe",
    description: "删除片段上某个属性在某个时间点的关键帧。",
    parameters: obj({ clip_id: CLIP_ID, property: choice(KEYFRAME_PROPERTIES, "属性"), offset: num("从片段开头算起的秒数", { minimum: 0 }) }, ["clip_id", "property", "offset"]),
    write: true,
    label: () => "删了一个关键帧",
    run: async (ctx, args) => ctx.store.removeKeyframe(ctx.projectId, args.clip_id, args.property, micros(args.offset)),
  },
  {
    name: "add_effect",
    description: "给视频/图片片段加画面特效（名称先用 search_catalog 查 video_effect），或给音频素材的片段加音频特效（查 audio_effect）。视频片段不能加音频特效；音频片段的同一类音效（场景音、音色、声音成曲）只能有一个。",
    parameters: obj({
      clip_id: CLIP_ID,
      effect_type: str("特效名称（search_catalog 返回的 name）"),
      params: { type: "array", items: { type: "number" }, description: "特效参数，按 search_catalog 给的 params 顺序，每个 0 到 100，可选" },
    }, ["clip_id", "effect_type"]),
    write: true,
    label: (args) => `加了特效${quoted(args.effect_type)}`,
    run: async (ctx, args) => {
      await checkEffect(ctx, args);
      return ctx.store.addEffect(ctx.projectId, args.clip_id, pick(args, ["effect_type", "params"]));
    },
  },
  {
    name: "add_filter",
    description: "给视频/图片片段加滤镜（名称先用 search_catalog 查 filter）。",
    parameters: obj({ clip_id: CLIP_ID, filter_type: str("滤镜名称"), intensity: num("强度 0 到 100，默认 100", { minimum: 0, maximum: 100 }) }, ["clip_id", "filter_type"]),
    write: true,
    label: (args) => `加了滤镜${quoted(args.filter_type)}`,
    run: async (ctx, args) => ctx.store.addFilter(ctx.projectId, args.clip_id, pick(args, ["filter_type", "intensity"])),
  },
  {
    name: "add_animation",
    description: "给视频/图片或文字片段加入场、出场或组合/循环动画（名称先用 search_catalog 查 video_intro/video_outro/video_group 或 text_intro/text_outro/text_loop）。每个片段的入场、出场、组合（文字是循环）各只能有一个；视频的组合动画不能和入场、出场同时用；文字要先加入场、出场，最后加循环。要换动画先用 clear_clip_feature 去掉 animations（会去掉全部动画）再加。",
    parameters: obj({ clip_id: CLIP_ID, animation_type: str("动画名称"), duration: num("动画时长（秒），默认用动画自带的时长，不能超过片段", { exclusiveMinimum: 0 }) }, ["clip_id", "animation_type"]),
    write: true,
    label: (args) => `加了动画${quoted(args.animation_type)}`,
    run: async (ctx, args) => {
      await checkAnimation(ctx, args);
      return ctx.store.addAnimation(ctx.projectId, args.clip_id, {
        ...pick(args, ["animation_type"]),
        ...(has(args, "duration") ? { duration_us: micros(args.duration) } : {}),
      });
    },
  },
  {
    name: "add_transition",
    description: "给视频/图片片段加转场，转场出现在这个片段和同一轨道上紧接着的下一个片段之间（名称先用 search_catalog 查 transition）。",
    parameters: obj({ clip_id: CLIP_ID, transition_type: str("转场名称"), duration: num("转场时长（秒），默认 0.5 秒，不能超过片段", { exclusiveMinimum: 0 }) }, ["clip_id", "transition_type"]),
    write: true,
    label: (args) => `加了转场${quoted(args.transition_type)}`,
    run: async (ctx, args) => ctx.store.addTransition(ctx.projectId, args.clip_id, {
      ...pick(args, ["transition_type"]),
      ...(has(args, "duration") ? { duration_us: micros(args.duration) } : {}),
    }),
  },
  {
    name: "add_fade",
    description: "给视频、图片或音频片段的声音加淡入淡出（两项至少一项大于 0，加起来不能超过片段时长）。",
    parameters: obj({ clip_id: CLIP_ID, fade_in: num("淡入秒数", { minimum: 0 }), fade_out: num("淡出秒数", { minimum: 0 }) }, ["clip_id"]),
    write: true,
    label: () => "加了淡入淡出",
    run: async (ctx, args) => ctx.store.addFade(ctx.projectId, args.clip_id, {
      ...(has(args, "fade_in") ? { in_duration_us: micros(args.fade_in) } : {}),
      ...(has(args, "fade_out") ? { out_duration_us: micros(args.fade_out) } : {}),
    }),
  },
  {
    name: "add_mask",
    description: "给视频/图片片段加蒙版（名称先用 search_catalog 查 mask）。每个片段只能有一个，换之前先 clear_clip_feature。",
    parameters: obj({
      clip_id: CLIP_ID,
      mask_type: str("蒙版名称"),
      center_x: num("中心水平位置，单位是像素，0 是素材中心"),
      center_y: num("中心垂直位置，单位是像素，0 是素材中心"),
      size: num("大小，占素材高度的比例，0 到 1，默认 0.5", { exclusiveMinimum: 0, maximum: 1 }),
      rotation: num("旋转角度"),
      feather: num("羽化 0 到 100", { minimum: 0, maximum: 100 }),
      invert: bool("反转"),
      rect_width: num("只有矩形蒙版能用：宽度，占素材宽度的比例，0 到 1", { exclusiveMinimum: 0, maximum: 1 }),
      round_corner: num("只有矩形蒙版能用：圆角 0 到 100", { minimum: 0, maximum: 100 }),
    }, ["clip_id", "mask_type"]),
    write: true,
    label: (args) => `加了蒙版${quoted(args.mask_type)}`,
    run: async (ctx, args) => {
      checkMask(args);
      return ctx.store.addMask(ctx.projectId, args.clip_id, pick(args, ["mask_type", "center_x", "center_y", "size", "rotation", "feather", "invert", "rect_width", "round_corner"]));
    },
  },
  {
    name: "arrange_grid",
    description: "把视频/图片片段排成分屏、宫格（七分屏、左右或上下分屏、九宫格等）：当前画布按几列几行等分，每个片段放进指定的格子。位置、等比缩放和遮住格子外部分的矩形蒙版都由应用算好，不要自己算 transform。片段原来的蒙版、裁剪和位置/缩放/旋转关键帧会被换掉；之后换画布会自动按新画布重排。一个片段只能放一格。",
    parameters: obj({
      columns: int("横向分几列，1 到 12", { minimum: 1, maximum: 12 }),
      rows: int("纵向分几行，1 到 12，默认 1", { minimum: 1, maximum: 12 }),
      cells: {
        type: "array",
        description: "每个片段放哪一格；同一时刻可以放满所有格子，也可以只放一部分",
        items: obj({
          clip_id: CLIP_ID,
          column: int("第几列，从 1 数，最左边是 1", { minimum: 1, maximum: 12 }),
          row: int("第几行，从 1 数，最上面是 1，默认 1", { minimum: 1, maximum: 12 }),
        }, ["clip_id", "column"]),
      },
      fit: choice(["cover", "contain"], "cover 等比铺满格子、多出的部分遮掉（默认）；contain 完整放进格子，空出的地方露出下层画面"),
    }, ["columns", "cells"]),
    write: true,
    label: (args) => `排成了 ${args.columns ?? "?"} 列${args.rows > 1 ? ` ${args.rows} 行` : ""}的分屏`,
    run: arrangeGrid,
  },
  {
    name: "add_chroma",
    description: "给视频/图片片段做色度抠像（抠掉绿幕等颜色）。",
    parameters: obj({
      clip_id: CLIP_ID,
      color: COLOR_ALPHA,
      intensity: num("强度 0 到 100，默认 20", { minimum: 0, maximum: 100 }),
      shadow: num("阴影 0 到 100", { minimum: 0, maximum: 100 }),
      edge_smooth: num("边缘平滑 0 到 100", { minimum: 0, maximum: 100 }),
      spill: num("去溢色 0 到 100", { minimum: 0, maximum: 100 }),
    }, ["clip_id", "color"]),
    write: true,
    label: () => "做了抠像",
    run: async (ctx, args) => ctx.store.addChroma(ctx.projectId, args.clip_id, pick(args, ["color", "intensity", "shadow", "edge_smooth", "spill"])),
  },
  {
    name: "add_background_filling",
    description: "画面没铺满画布时给空白处加背景：模糊原画面或纯色。",
    parameters: obj({
      clip_id: CLIP_ID,
      fill_type: choice(["blur", "color"], "blur 模糊，color 纯色"),
      blur: num("模糊程度 0 到 1，默认 0.0625", { minimum: 0, maximum: 1 }),
      color: COLOR_ALPHA,
    }, ["clip_id", "fill_type"]),
    write: true,
    label: (args) => args.fill_type === "color" ? "加了纯色背景" : "加了模糊背景",
    run: async (ctx, args) => ctx.store.addBackgroundFilling(ctx.projectId, args.clip_id, pick(args, ["fill_type", "blur", "color"])),
  },
  {
    name: "set_mix_mode",
    description: "设置视频/图片片段和下层画面的混合模式（名称先用 search_catalog 查 mix_mode）。",
    parameters: obj({ clip_id: CLIP_ID, mode: str("混合模式名称") }, ["clip_id", "mode"]),
    write: true,
    label: (args) => `设了混合模式${quoted(args.mode)}`,
    run: async (ctx, args) => ctx.store.setMixMode(ctx.projectId, args.clip_id, pick(args, ["mode"])),
  },
  {
    name: "clear_clip_feature",
    description: "去掉片段上的某一类设置。",
    parameters: obj({
      clip_id: CLIP_ID,
      feature: choice(FEATURES, "effects 特效，filters 滤镜，animations 动画，transition 转场，fade 淡入淡出，mask 蒙版，chroma 抠像，background_filling 背景填充，mix_mode 混合模式，crop 裁剪，border 描边，background 文字背景，shadow 阴影，bubble 气泡，text_effect 花字"),
    }, ["clip_id", "feature"]),
    write: true,
    label: () => "去掉了片段上的一项效果",
    run: async (ctx, args) => ctx.store.clearFeature(ctx.projectId, args.clip_id, args.feature),
  },
  {
    name: "add_marker",
    description: "在时间线上加一个标记（同一时间点已有就替换）。",
    parameters: obj({ time: num("时间（秒）", { minimum: 0 }), label: str("标记文字"), color: COLOR }, ["time", "label"]),
    write: true,
    label: (args) => `加了标记${quoted(args.label)}`,
    run: async (ctx, args) => ctx.store.addMarker(ctx.projectId, { time_us: micros(args.time), ...pick(args, ["label", "color"]) }),
  },
  {
    name: "list_markers",
    description: "列出时间线上的标记。",
    parameters: obj({}),
    label: () => "看了标记",
    run: async (ctx) => ({ markers: forModel(await ctx.store.listMarkers(ctx.projectId), ctx.library) }),
  },
  {
    name: "remove_marker",
    description: "删除某个时间点的标记。",
    parameters: obj({ time: num("标记所在的时间（秒）", { minimum: 0 }) }, ["time"]),
    write: true,
    label: () => "删了一个标记",
    run: async (ctx, args) => ctx.store.removeMarker(ctx.projectId, micros(args.time)),
  },
  {
    name: "add_subtitles",
    description: "加一组字幕（新建一条字幕轨道，在最上层）。给 captions（逐条的开始、结束秒数和文字）或者完整的 SRT 文本二选一。默认放在画面下方（transform_y -0.8）、白色 8 号字；位置和字体样式可以用 transform 和样式参数给整组一起设。",
    parameters: obj({
      captions: {
        type: "array",
        description: "逐条字幕",
        items: obj({ start: num("开始（秒）", { minimum: 0 }), end: num("结束（秒）"), text: str("字幕文字") }, ["start", "end", "text"]),
      },
      srt: str("完整的 SRT 字幕文本"),
      transform: { ...TRANSFORM, description: "整组字幕的位置、缩放等，默认 {\"transform_y\": -0.8}（画面下方）；要放正中就给 {\"transform_y\": 0}" },
      ...pick(TEXT_STYLE, SUBTITLE_STYLE),
    }),
    write: true,
    label: (args) => Array.isArray(args.captions) ? `加了 ${args.captions.length} 条字幕` : "加了字幕",
    run: async (ctx, args) => {
      const srt = has(args, "captions") ? captionsToSrt(args.captions) : args.srt;
      if (typeof srt !== "string" || !srt.trim()) throw new AiEditError("arguments_invalid", "captions 和 srt 至少给一个。");
      checkFont(args);
      const group = randomBytes(16).toString("hex");
      let project = await ctx.store.addSrtSubtitles(ctx.projectId, srt, { groupId: group });
      // ProjectStore 建的字幕都在画面正中；整组套上位置和样式，不占模型的工具调用次数
      const style = { transform: has(args, "transform") ? args.transform : SUBTITLE_TRANSFORM, ...pick(args, SUBTITLE_STYLE) };
      const clips = project?.tracks?.find((track) => track.id === group)?.segments ?? [];
      for (const [index, clip] of clips.entries()) {
        try {
          project = await ctx.store.updateSegment(ctx.projectId, clip.id, style);
        } catch (error) {
          // 样式不对时第一条就会报错：整组撤掉，不留一组没套上样式的字幕
          if (index === 0) await ctx.store.removeSubtitleGroup(ctx.projectId, group).catch(() => undefined);
          throw error;
        }
      }
      return project;
    },
  },
  {
    name: "remove_subtitles",
    description: "删除一组用 add_subtitles 加的字幕（给字幕轨道的 track_id）。",
    parameters: obj({ track_id: str("字幕轨道的 track_id") }, ["track_id"]),
    write: true,
    label: () => "删了一组字幕",
    run: async (ctx, args) => ctx.store.removeSubtitleGroup(ctx.projectId, args.track_id),
  },
  {
    name: "export_to_jianying",
    description: "把当前时间线导入剪映草稿箱：第一次新建一份草稿，之后更新同一份。剪映必须先退出。那份草稿在上次导入后被用户在剪映里打开或改过时会返回 draft_changed，先问用户另存还是覆盖，再带 mode 重新调用。",
    parameters: obj({
      mode: choice(["auto", "new", "update"], "auto（默认）：草稿在剪映里被改过就先停下；new：另存一份新草稿，旧的不动；update：覆盖旧草稿（会丢掉用户在剪映里的改动），用户明确同意覆盖才用"),
    }),
    exporting: true,
    label: (args) => (args.mode === "new" ? "另存了一份剪映草稿" : args.mode === "update" ? "覆盖了剪映里的草稿" : "导入了剪映草稿箱"),
    run: async (ctx, args) => {
      const result = await ctx.exportDraft(args.mode);
      return { draft_name: result.draftName, created: result.created };
    },
  },
];

export const TOOL_DEFINITIONS = TOOLS.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------- 错误 ----------

const EDIT_ERROR_TEXT = {
  PROJECT_NOT_FOUND: "工程找不到了",
  TRACK_NOT_FOUND: "找不到这条轨道",
  SEGMENT_NOT_FOUND: "找不到这个片段",
  TIMELINE_OVERLAP: "和同一轨道上的片段时间重叠了",
  SPEED_IMPLIED: "这样放会被自动变速，换了个做法",
  MEDIA_TRACK_MISMATCH: "素材类型和轨道对不上",
  TRACK_TYPE_MISMATCH: "轨道类型不对",
  SOURCE_RANGE_INVALID: "截取的区间超出了素材长度",
  MEDIA_DURATION_MISMATCH: "时长和倍速对不上",
  SPEED_INVALID: "图片不能变速",
  SEGMENT_FIELD_MISMATCH: "这种片段不支持这项设置",
  SEGMENT_KIND_INVALID: "这个片段不能这样改",
  SEGMENT_UPDATE_INVALID: "这项设置不能清空",
  DRAFT_FEATURE_INVALID: "剪映里没有这个名称",
  EFFECT_INVALID: "剪映里没有这个特效",
  EFFECT_PARAMS_INVALID: "特效参数太多了",
  ANIMATION_INVALID: "动画名称或时长不对",
  TRANSITION_INVALID: "转场比片段还长",
  FADE_INVALID: "淡入淡出的设置不对",
  FEATURE_EXISTS: "片段已经有这项设置了，要先去掉",
  FEATURE_INVALID: "没有这一类设置",
  KEYFRAME_OFFSET_INVALID: "关键帧的时间超出了片段",
  KEYFRAME_VALUE_INVALID: "关键帧的值超出范围",
  KEYFRAME_PROPERTY_INVALID: "这个片段不支持这种关键帧",
  KEYFRAME_PROPERTY_CONFLICT: "整体缩放和单向缩放的关键帧不能同时用",
  KEYFRAME_NOT_FOUND: "没有这个关键帧",
  SPLIT_OFFSET_INVALID: "切点要在片段中间",
  TRACK_ORDER_INVALID: "轨道顺序要包含全部轨道",
  TRACK_UPDATE_INVALID: "轨道设置不对",
  PROJECT_UPDATE_INVALID: "工程名不对",
  MARKER_NOT_FOUND: "没有这个标记",
  SRT_EMPTY: "字幕是空的",
  SRT_INVALID: "字幕格式不对",
  SRT_TOO_LARGE: "字幕太长了",
  SUBTITLE_NOT_FOUND: "找不到这组字幕",
  SUBTITLE_EXISTS: "这组字幕已经有了",
  PROJECT_CONFLICT: "工程刚被改过，请重试",
  MEDIA_NOT_FOUND: "素材文件找不到了",
  MEDIA_TYPE_UNSUPPORTED: "素材格式不支持",
  VALIDATION_ERROR: "参数不对",
  // 工具层按剪映规则提前拦下的
  SUBTITLE_TRACK_LOCKED: "字幕轨只能整组加字幕，单独的文字要另建文字轨道",
  SUBTITLE_CLIP_LOCKED: "字幕轨上的字幕不能单独挪到别的轨道，也不能复制",
  FONT_INVALID: "剪映里没有这个字体",
  MASK_PARAMS_INVALID: "只有矩形蒙版能设宽度和圆角",
  ANIMATION_EXISTS: "片段已经有同一种动画了，要先去掉",
  ANIMATION_CONFLICT: "组合动画不能和入场、出场动画一起用",
  ANIMATION_ORDER: "文字要先加入场、出场动画，最后加循环动画",
  EFFECT_CLIP_MISMATCH: "这种片段不能用这个特效",
  AUDIO_EFFECT_EXISTS: "音频已经有同一类音效了，要先去掉",
  IMAGE_TOO_LONG: "图片片段最长 3 小时",
};

/** 工具出错时：给模型的原样信息（码 + 原文 + details），给页面的中文说明。 */
export function describeToolError(error) {
  if (error instanceof AiEditError) return { code: error.code, message: error.message, text: error.message };
  if (error instanceof EditError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}),
      text: EDIT_ERROR_TEXT[error.code] ?? (error.code?.startsWith("PATH_") || error.code?.startsWith("MEDIA_") ? "素材文件有问题" : "参数不对"),
    };
  }
  if (error?.name === "AbortError") throw error;
  console.error("AI 剪辑工具执行出错:", error);
  return { code: "tool_failed", message: "工具执行出错了，换个做法试试。", text: "执行出错了" };
}

/** 重叠时把同一轨道上离得最近的几个片段（起止秒数不丢精度）告诉模型，让它能自己挪开。 */
async function overlapDetails(ctx, args, name) {
  const project = await ctx.store.getProject(ctx.projectId);
  const track = project.tracks.find((entry) => entry.id === args.track_id)
    ?? project.tracks.find((entry) => entry.segments?.some((segment) => segment.id === args.clip_id));
  const self = track?.segments?.find((segment) => segment.id === args.clip_id);
  // 复制时原片段还在原地，常常正是被压到的那段，不能当成「自己」排除
  const others = (track?.segments ?? []).filter((segment) => name === "duplicate_clip" || segment !== self);
  if (!others.length) return null;
  const startOf = (segment) => segment.timeline.start_us;
  const anchor = has(args, "start") && typeof micros(args.start) === "number" ? micros(args.start) : self ? startOf(self) : trackEndUs(track);
  const nearest = [...others].sort((left, right) => Math.abs(startOf(left) - anchor) - Math.abs(startOf(right) - anchor)).slice(0, 8);
  return {
    track_id: track.id,
    nearby_clips: nearest.sort((left, right) => startOf(left) - startOf(right))
      .map((segment) => ({ clip_id: segment.id, start: seconds(startOf(segment)), end: seconds(startOf(segment) + segment.timeline.duration_us) })),
  };
}

function idsOf(project) {
  const tracks = new Set();
  const clips = new Set();
  for (const track of project?.tracks ?? []) {
    tracks.add(track.id);
    for (const segment of track.segments ?? []) clips.add(segment.id);
  }
  return { tracks, clips };
}

// 模型常把参数写错地方或用错名字；不认识的键不能悄悄丢掉（工具会照样回 ok，模型以为改好了）。
const TRANSFORM_HINT = "位置、缩放、旋转、不透明度要写在 transform 对象里，例如 \"transform\": {\"transform_y\": -0.8}";
const ARGUMENT_HINTS = {
  ...Object.fromEntries(Object.keys(TRANSFORM.properties).map((key) => [key, TRANSFORM_HINT])),
  x: TRANSFORM_HINT, y: TRANSFORM_HINT, scale: TRANSFORM_HINT, position: TRANSFORM_HINT,
  end: "没有 end 参数：时长用 duration（秒）",
  end_time: "没有 end_time 参数：开始时间用 start，时长用 duration（秒）",
  start_time: "开始时间用 start（秒）",
  font: "字体用 font_family（先用 search_catalog 查 font）",
  font_color: "文字颜色用 color",
  text_color: "文字颜色用 color",
  size: "字号用 font_size",
};

/** 按参数模式找出不认识的键（带路径，例如 transform.y、keyframes[0].time）。 */
function unknownKeys(schema, value, prefix = "") {
  if (Array.isArray(value)) {
    return schema?.type === "array" && schema.items ? value.flatMap((item, index) => unknownKeys(schema.items, item, `${prefix}[${index}]`)) : [];
  }
  if (!value || typeof value !== "object" || schema?.type !== "object" || !schema.properties) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const where = prefix ? `${prefix}.${key}` : key;
    return Object.hasOwn(schema.properties, key) ? unknownKeys(schema.properties[key], item, where) : [where];
  });
}

// 只有这几项可以用 null 表示清除；别的可选参数模型填 null 就当没给（ProjectStore 会把 null 当成错误的值）。
const NULL_CLEARS = { update_clip: new Set(["transform", "bubble", "text_effect_id"]) };

function dropNulls(value, keep) {
  if (Array.isArray(value)) return value.map((item) => dropNulls(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => item !== null || keep?.has(key))
    .map(([key, item]) => [key, dropNulls(item)]));
}

/**
 * 工具执行器。ctx：{ store, library, projectId, getCollector, exportDraft, onRename, signal }，
 * 参考视频另外用 getExplorer、config（AI 剪辑的接口配置，看视频也用它）、references（解析结果缓存）、fetchImpl、pollMs。
 * 返回 { result（回给模型）, action（给页面的动作摘要）, changed（工程或素材有变化） }。
 */
export function createToolRunner(ctx) {
  return async function run(name, rawArguments) {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return { result: { ok: false, code: "unknown_tool", message: `没有 ${String(name).slice(0, 60)} 这个工具。` }, action: { name: String(name), summary: "调用了不存在的工具", ok: false, error: "没有这个工具" }, changed: false };
    }
    let args;
    try {
      args = typeof rawArguments === "string" ? JSON.parse(rawArguments.trim() || "{}") : rawArguments ?? {};
    } catch { args = null; }
    const summary = (value) => {
      try { return tool.label(value ?? {}, ctx); } catch { return name; }
    };
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { result: { ok: false, code: "arguments_invalid", message: "参数不是合法的 JSON 对象，重新组织一下参数。" }, action: { name, summary: summary({}), ok: false, error: "参数格式不对" }, changed: false };
    }
    args = dropNulls(args, NULL_CLEARS[name]);
    const unknown = unknownKeys(tool.parameters, args);
    if (unknown.length) {
      const shown = unknown.slice(0, 10);
      const hintFor = (key) => (Object.hasOwn(ARGUMENT_HINTS, key) ? ARGUMENT_HINTS[key] : null);
      const hints = [...new Set(shown.map((where) => hintFor(where.split(".").at(-1))).filter(Boolean))];
      const message = `不认识的参数：${shown.join("、")}${unknown.length > shown.length ? " 等" : ""}。${hints.length ? `${hints.join("；")}。` : ""}这次没有执行，按工具说明里的参数名改了再试。`;
      return { result: { ok: false, code: "arguments_invalid", message }, action: { name, summary: summary(args), ok: false, error: "参数写错了" }, changed: false };
    }
    const missing = (tool.parameters.required ?? []).filter((key) => !has(args, key));
    if (missing.length) {
      return { result: { ok: false, code: "arguments_invalid", message: `缺少参数：${missing.join("、")}。` }, action: { name, summary: summary(args), ok: false, error: "缺少参数" }, changed: false };
    }
    try {
      const before = tool.write ? idsOf(await ctx.store.getProject(ctx.projectId)) : null;
      const output = await tool.run({ ...ctx }, args);
      let result;
      if (tool.write) {
        const project = output?.project ?? output;
        const after = idsOf(project);
        const newTracks = [...after.tracks].filter((id) => !before.tracks.has(id));
        const newClips = [...after.clips].filter((id) => !before.clips.has(id));
        result = {
          ok: true,
          ...(newTracks.length === 1 ? { track_id: newTracks[0] } : {}),
          ...(newClips.length === 1 ? { clip_id: newClips[0] } : {}),
          ...(newClips.length > 1 ? { clip_ids: newClips.slice(0, 50), clip_count: newClips.length } : {}),
          total_duration: seconds(projectDurationUs(project)),
          ...(typeof output?.note === "string" ? { note: output.note } : {}),
        };
      } else {
        result = { ok: true, ...output };
      }
      return { result, action: { name, summary: summary(args), ok: true }, changed: Boolean(tool.write || tool.media || tool.exporting) };
    } catch (error) {
      const { text, ...info } = describeToolError(error);
      if (info.code === "TIMELINE_OVERLAP") {
        const nearby = await overlapDetails(ctx, args, name).catch(() => null);
        if (nearby) info.details = { ...info.details, ...nearby };
      }
      if (info.code === "draft_changed") {
        info.message = `${info.message}先问用户是另存一份新草稿（mode 填 new），还是覆盖剪映里的改动（mode 填 update，会丢掉用户在剪映里做的修改）；用户明确说了再带上 mode 重新调用，别替用户选。`;
      }
      return { result: { ok: false, ...info }, action: { name, summary: summary(args), ok: false, error: text }, changed: false };
    }
  };
}

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);
