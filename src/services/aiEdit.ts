import { LocalCollectorError, collectorFetch, normalizeCollectorBaseUrl } from "./localCollector";
import type { ExploreConnection } from "./explorer";
import type { AiEditCommandAsk } from "./aiEditSkills";

// AI 剪辑：对话、工程、素材库都在采集器（collector/aiEdit/），页面只负责发消息、长轮询会话、上传素材和展示。
// 接口配置存在本机 localStorage，每次随消息带过去，采集器不保存 Key。剪辑模型单独存；看视频用的「解析视频」服务就是解析库那份配置。

/** 用哪个 AI：接口（自己填地址和 Key），或者这台电脑上登录好的 Codex / Claude Code（走用户自己的订阅）。 */
export type AiRuntime = "api" | "codex" | "claude";
export type LocalAiRuntime = Exclude<AiRuntime, "api">;

export interface AiEditConfig {
  /** 没有就是接口 */
  runtime?: AiRuntime;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 本机 CLI 的模型和接口的分开存（选填，留空用 CLI 自己的默认），免得把方舟的模型名发给 Codex */
  localModels?: Partial<Record<LocalAiRuntime, string>>;
  /** 保存时测过：模型能不能直接看视频（看不了的话，参考视频改由页面拆成截图和节拍再给它看）；没测过是 null */
  videoInput?: boolean | null;
  /** 测的是哪个接口地址和模型，换了就要重测 */
  videoProbe?: string;
}

export const videoProbeKey = (config: Pick<AiEditConfig, "baseUrl" | "model">): string => `${config.baseUrl.trim()}|${config.model.trim()}`;

export const aiRuntimeOf = (value: unknown): AiRuntime => (value === "codex" || value === "claude" ? value : "api");
export const isLocalAiRuntime = (runtime: AiRuntime | undefined): runtime is LocalAiRuntime => runtime === "codex" || runtime === "claude";

/** 存下来的本机模型名：只留字符串。 */
export function pickLocalModels(value: unknown): Partial<Record<LocalAiRuntime, string>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const models = Object.fromEntries((["codex", "claude"] as const).flatMap((key) => {
    const model = (value as Record<string, unknown>)[key];
    return typeof model === "string" ? [[key, model]] : [];
  }));
  return Object.keys(models).length ? models : undefined;
}

/** 能不能开始用：接口要地址、Key、模型都填了；本机 CLI 不用填（装没装、登没登录由采集器检测）。 */
export const aiConfigReady = (config: Pick<AiEditConfig, "runtime" | "baseUrl" | "apiKey" | "model">): boolean =>
  isLocalAiRuntime(config.runtime) || Boolean(config.apiKey.trim() && config.model.trim() && config.baseUrl.trim());

/** 剪辑模型存进去的样子：测视频的结果交给外面按地址和模型决定沿不沿用，字段去掉首尾空格。 */
export function tidyAiEditConfig(draft: AiEditConfig): AiEditConfig {
  const { videoInput: _input, videoProbe: _probe, localModels, ...rest } = draft;
  const models = localModels ? Object.fromEntries(Object.entries(localModels).map(([key, model]) => [key, (model ?? "").trim()])) : undefined;
  return { ...rest, runtime: aiRuntimeOf(draft.runtime), apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), ...(models ? { localModels: models } : {}) };
}

/** 两份剪辑模型设置存进去是不是一样（不管首尾空格和测视频的结果）。 */
export function sameAiEditConfig(left: AiEditConfig, right: AiEditConfig): boolean {
  const [a, b] = [tidyAiEditConfig(left), tidyAiEditConfig(right)];
  return a.runtime === b.runtime && a.apiKey === b.apiKey && a.model === b.model && a.baseUrl === b.baseUrl
    && JSON.stringify(a.localModels ?? {}) === JSON.stringify(b.localModels ?? {});
}

/** 随请求发给采集器的配置：本机 CLI 只发运行时和模型，存着的 Key 和地址不带过去。 */
export function aiRequestConfig(config: AiEditConfig): Record<string, unknown> {
  const { runtime, localModels, videoProbe: _probe, ...api } = config;
  return isLocalAiRuntime(runtime) ? { runtime, model: localModels?.[runtime]?.trim() ?? "" } : api;
}

export const DEFAULT_AI_EDIT_CONFIG: AiEditConfig = {
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey: "",
  model: "doubao-seed-2-1-lite-260915",
};

const CONFIG_KEY = "dy2.aiEditConfig";

export function loadAiEditConfig(): AiEditConfig {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(CONFIG_KEY) ?? "{}") as Partial<AiEditConfig> | null;
    const pick = (key: "baseUrl" | "apiKey" | "model"): string => { const value = saved?.[key]; return typeof value === "string" ? value : DEFAULT_AI_EDIT_CONFIG[key]; };
    const config: AiEditConfig = { baseUrl: pick("baseUrl"), apiKey: pick("apiKey"), model: pick("model") };
    // 只有存过才带上，没选过的老配置读出来和以前一样
    if (saved?.runtime !== undefined) config.runtime = aiRuntimeOf(saved.runtime);
    const localModels = pickLocalModels(saved?.localModels);
    if (localModels) config.localModels = localModels;
    // 测的不是现在这个模型就当没测过
    if (typeof saved?.videoInput === "boolean" && saved.videoProbe === videoProbeKey(config)) Object.assign(config, { videoInput: saved.videoInput, videoProbe: saved.videoProbe });
    return config;
  } catch {
    return DEFAULT_AI_EDIT_CONFIG;
  }
}

export function saveAiEditConfig(config: AiEditConfig): void {
  try { globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不了就只管这一次 */ }
}

// ---------- 生成图片和视频（可选，按服务商另外计费） ----------

/** 一项生成服务的接口地址、Key、模型 */
export interface AiEditGenerateService { baseUrl: string; apiKey: string; model: string }
/** 方舟 Seedance 多一个开关 borrow：Key 留空时借不借方舟的 Key（AI 剪辑的，其次解析库的）；用户勾了才借，默认不借 */
export interface AiEditGenerateVideoService extends AiEditGenerateService { borrow: boolean }
/** 生成视频能用的几家 */
export type AiEditVideoProvider = "seedance" | "jimeng" | "xyq" | "libtv";
/** 配置里存服务的几项：image 是 OpenAI，video 是方舟 Seedance（老名字不改，存着的配置照读），另外三家各一项 */
export type AiEditGenerateSlot = "image" | "video" | "jimeng" | "xyq" | "libtv";
export const VIDEO_PROVIDER_SLOT: Record<AiEditVideoProvider, AiEditGenerateSlot> = { seedance: "video", jimeng: "jimeng", xyq: "xyq", libtv: "libtv" };
export const GENERATE_SLOTS: AiEditGenerateSlot[] = ["image", "video", "jimeng", "xyq", "libtv"];

/** 每家一项各存各的 Key；use 记图片、视频各用哪家（null 不生成），用的那家没连上（没填 Key）也是不生成 */
export interface AiEditGenerateConfig {
  image: AiEditGenerateService;
  video: AiEditGenerateVideoService;
  jimeng: AiEditGenerateService;
  xyq: AiEditGenerateService;
  libtv: AiEditGenerateService;
  use: { image: "openai" | null; video: AiEditVideoProvider | null };
}
/** 随消息发给采集器的那份：只带要用、也连上了的那家；视频带上是哪家 */
export interface AiEditGenerationRequest {
  image?: AiEditGenerateService;
  video?: AiEditGenerateService & { provider: AiEditVideoProvider };
}

export const DEFAULT_AI_EDIT_GENERATE_CONFIG: AiEditGenerateConfig = {
  image: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-image-2.5-flare" },
  video: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", model: "doubao-seedance-2-0-260128", borrow: false },
  // 即梦、小云雀、LibTV 没有 Key：走这台电脑上登录好的官方命令行，连上时 apiKey 记成 LOCAL_CLI，地址只是占位
  jimeng: { baseUrl: "https://jimeng.jianying.com", apiKey: "", model: "seedance2.0fast" },
  xyq: { baseUrl: "https://xyq.jianying.com", apiKey: "", model: "Seedance_2.0_mini" },
  libtv: { baseUrl: "https://www.liblib.tv", apiKey: "", model: "Seedance 2.0 VIP" },
  // 老配置没有这一项：照原来的规矩，图片填了 Key 就用，视频走方舟
  use: { image: "openai", video: "seedance" },
};

/** 即梦、小云雀、LibTV 连上的记号（它们不用 Key，采集器调本机的 dreamina、pippit-tool-cli、libtv 命令行） */
export const LOCAL_CLI = "cli";
const CLI_SLOTS: AiEditGenerateSlot[] = ["jimeng", "xyq", "libtv"];

const GENERATE_CONFIG_KEY = "dy2.aiEditGenerateConfig";
const VIDEO_PROVIDERS = Object.keys(VIDEO_PROVIDER_SLOT) as AiEditVideoProvider[];

export function loadAiEditGenerateConfig(): AiEditGenerateConfig {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(GENERATE_CONFIG_KEY) ?? "{}") as Record<string, unknown> | null;
    const text = (slot: AiEditGenerateSlot, key: string): string => {
      const stored = saved?.[slot] as Record<string, unknown> | null | undefined;
      const value = stored && typeof stored === "object" ? stored[key] : undefined;
      return typeof value === "string" ? value : (DEFAULT_AI_EDIT_GENERATE_CONFIG[slot] as unknown as Record<string, string>)[key]!;
    };
    const service = (slot: AiEditGenerateSlot): AiEditGenerateService => {
      const apiKey = text(slot, "apiKey");
      // 即梦、小云雀原来填的是 Key，现在改走命令行：老 Key 不再用，要重新连一次
      return { baseUrl: text(slot, "baseUrl"), apiKey: CLI_SLOTS.includes(slot) && apiKey !== LOCAL_CLI ? "" : apiKey, model: text(slot, "model") };
    };
    const use = (saved?.use ?? {}) as { image?: unknown; video?: unknown };
    return {
      image: service("image"),
      // 借 Key 只认存着的 true：没有这一项的老配置读出来是不借
      video: { ...service("video"), borrow: (saved?.video as { borrow?: unknown } | undefined)?.borrow === true },
      // 原来火山引擎接口的模型名（jimeng_ti2v_v30_pro 这类 req_key）命令行不认，换回默认
      jimeng: { ...service("jimeng"), ...(/^seedance/iu.test(text("jimeng", "model").trim()) ? {} : { model: DEFAULT_AI_EDIT_GENERATE_CONFIG.jimeng.model }) },
      xyq: service("xyq"),
      libtv: service("libtv"),
      use: {
        image: use.image === null ? null : "openai",
        video: use.video === null ? null : VIDEO_PROVIDERS.includes(use.video as AiEditVideoProvider) ? use.video as AiEditVideoProvider : "seedance",
      },
    };
  } catch {
    return DEFAULT_AI_EDIT_GENERATE_CONFIG;
  }
}

export function saveAiEditGenerateConfig(config: AiEditGenerateConfig): void {
  try { globalThis.localStorage?.setItem(GENERATE_CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不了就只管这一次 */ }
}

/** 各项在报错里的叫法 */
export const GENERATE_SLOT_LABELS: Record<AiEditGenerateSlot, string> = { image: "OpenAI", video: "火山方舟 Seedance", jimeng: "即梦", xyq: "小云雀", libtv: "LibTV" };
/** 「某某的」：英文名后面空一格 */
const whose = (names: string) => `${names}${/[A-Za-z0-9]$/u.test(names) ? " " : ""}的`;

/**
 * 保存前查一遍接口地址：留空，或者是 http:// / https:// 开头的完整地址才行（和采集器的规矩一样）。
 * 填错了采集器会拒收每一条消息，所以不合格的不让存；没问题回 null。
 */
export function generateConfigProblem(config: AiEditGenerateConfig, slots: AiEditGenerateSlot[] = GENERATE_SLOTS): string | null {
  const bad = slots.find((slot) => badGenerateUrl(config[slot].baseUrl));
  return bad ? `${whose(GENERATE_SLOT_LABELS[bad])}接口地址要以 https:// 开头，像 ${DEFAULT_AI_EDIT_GENERATE_CONFIG[bad].baseUrl} 这样。` : null;
}

/** 留空不算错；填了就得是 http:// 或 https:// 开头的完整地址 */
function badGenerateUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return false;
  try { return !["https:", "http:"].includes(new URL(url).protocol); } catch { return true; }
}

/**
 * 没点保存就关掉设置时替用户存的那份：接口地址填得不对的那项只把地址退回存着的（存着的也不对就留空、用默认），
 * Key、模型、借 Key 照存，免得一个地址填错整页改动都丢掉。problem 是给人看的一句说明，地址都合格时为 null。
 */
export function keepValidGenerateUrls(draft: AiEditGenerateConfig, stored: AiEditGenerateConfig): { config: AiEditGenerateConfig; problem: string | null } {
  const dropped: string[] = [];
  const config = { ...draft };
  for (const slot of GENERATE_SLOTS) {
    if (!badGenerateUrl(draft[slot].baseUrl)) continue;
    dropped.push(GENERATE_SLOT_LABELS[slot]);
    (config as Record<AiEditGenerateSlot, AiEditGenerateService>)[slot] = { ...draft[slot], baseUrl: badGenerateUrl(stored[slot].baseUrl) ? "" : stored[slot].baseUrl };
  }
  return { config, problem: dropped.length ? `${whose(dropped.join("、"))}接口地址要以 https:// 开头，刚才填的没存，还用原来的。` : null };
}

/** 是不是火山方舟的地址（volces.com 下的域名）；不是合法地址的也算不是 */
export function isArkUrl(value: string): boolean {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return host === "volces.com" || host.endsWith(".volces.com");
  } catch {
    return false;
  }
}

/** 能借出方舟 Key 的配置：AI 剪辑的、视频解析的（只用到这三项） */
type ArkKeyHolder = { runtime?: AiRuntime; baseUrl: unknown; apiKey: unknown };

/**
 * 方舟 Seedance 的 Key 留空时借哪一把方舟 Key：先看 AI 剪辑的，再看视频解析的。
 * 只借走接口、地址是方舟的那把；选了本机 Codex / Claude 时存着的 Key 不拿出来用（和 aiRequestConfig 一样）。
 */
export function borrowArkKey(aiConfig: ArkKeyHolder, analysisConfig?: ArkKeyHolder | null): { from: "edit" | "analysis"; apiKey: string } | null {
  const keyOf = (config: ArkKeyHolder | null | undefined): string => {
    if (!config || isLocalAiRuntime(config.runtime) || typeof config.apiKey !== "string" || typeof config.baseUrl !== "string") return "";
    return isArkUrl(config.baseUrl) ? config.apiKey.trim() : "";
  };
  const edit = keyOf(aiConfig);
  if (edit) return { from: "edit", apiKey: edit };
  const analysis = keyOf(analysisConfig);
  return analysis ? { from: "analysis", apiKey: analysis } : null;
}

/**
 * 这一项连没连上，连上了用哪把 Key（去掉首尾空格）；没连上回 ""。
 * 方舟 Seedance 的 Key 留空时，用户勾了借 Key 才借方舟的 Key，而且只在地址也是方舟时借，免得把方舟 Key 发给别家。
 */
export function generateKey(generate: AiEditGenerateConfig, slot: AiEditGenerateSlot, aiConfig: ArkKeyHolder, analysisConfig?: ArkKeyHolder | null): string {
  const own = generate[slot].apiKey.trim();
  if (own || slot !== "video" || generate.video.borrow !== true) return own;
  return isArkUrl(generate.video.baseUrl.trim() || DEFAULT_AI_EDIT_GENERATE_CONFIG.video.baseUrl) ? borrowArkKey(aiConfig, analysisConfig)?.apiKey ?? "" : "";
}

/**
 * 随消息发给采集器的生成配置：只带要用、也连上了的那家，都没有就是 undefined（请求里不带）。地址、模型留空用默认的。
 * 没勾借 Key 就不借：生成要花钱，不能因为别处碰巧填过方舟 Key 就替用户打开。
 */
export function generationForRequest(generate: AiEditGenerateConfig, aiConfig: ArkKeyHolder, analysisConfig?: ArkKeyHolder | null): AiEditGenerationRequest | undefined {
  const service = (slot: AiEditGenerateSlot, apiKey: string): AiEditGenerateService => ({
    baseUrl: generate[slot].baseUrl.trim() || DEFAULT_AI_EDIT_GENERATE_CONFIG[slot].baseUrl,
    apiKey,
    model: generate[slot].model.trim() || DEFAULT_AI_EDIT_GENERATE_CONFIG[slot].model,
  });
  const imageKey = generate.use.image ? generateKey(generate, "image", aiConfig, analysisConfig) : "";
  const provider = generate.use.video;
  const slot = provider ? VIDEO_PROVIDER_SLOT[provider] : null;
  const videoKey = slot ? generateKey(generate, slot, aiConfig, analysisConfig) : "";
  const video = provider && slot && videoKey
    ? { provider, ...service(slot, videoKey) }
    : null;
  if (!imageKey && !video) return undefined;
  return { ...(imageKey ? { image: service("image", imageKey) } : {}), ...(video ? { video } : {}) };
}

// ---------- 工程（与 JianYingAPI 的 Project 同形，字段保持 snake_case） ----------

export type EditFit = "contain" | "cover" | "stretch";
export type EditTrackType = "video" | "audio" | "text" | "sticker" | "effect" | "filter";

export interface EditCanvas { width: number; height: number; fps: number }
export interface EditTimeRange { start_us: number; duration_us: number }
export interface EditTransform {
  scale_x: number; scale_y: number; transform_x: number; transform_y: number;
  rotation: number; alpha: number; flip_horizontal: boolean; flip_vertical: boolean;
}
export interface EditCrop {
  upper_left_x: number; upper_left_y: number; upper_right_x: number; upper_right_y: number;
  lower_left_x: number; lower_left_y: number; lower_right_x: number; lower_right_y: number;
}
export interface EditKeyframe { property: string; offset_us: number; value: number }

interface EditSegmentBase { id: string; timeline: EditTimeRange; keyframes?: EditKeyframe[] }

/** phase、default_us 是采集器给看板预览补的（按剪映目录查）：入场 in、出场 out、组合 group、文字循环 loop，没写时长时按的默认时长 */
export interface EditAnimation { animation_type: string; duration_us?: number | null; phase?: "in" | "out" | "group" | "loop"; default_us?: number | null }

export interface EditMediaSegment extends EditSegmentBase {
  kind: "video" | "image" | "audio";
  path: string;
  source: EditTimeRange;
  volume: number;
  speed: number;
  change_pitch?: boolean;
  fit?: EditFit;
  transform?: EditTransform | null;
  crop?: EditCrop | null;
  material_name?: string | null;
  effects?: Array<{ effect_type: string; params?: number[] | null }>;
  filters?: Array<{ filter_type: string; intensity?: number }>;
  animations?: EditAnimation[];
  transition?: { transition_type: string; duration_us: number | null; default_us?: number | null } | null;
  fade?: { in_duration_us: number; out_duration_us: number } | null;
  mask?: { mask_type: string; [key: string]: unknown } | null;
  chroma?: { color: string; [key: string]: unknown } | null;
  background_filling?: { fill_type: "blur" | "color"; blur?: number; color?: string } | null;
  mix_mode?: { mode: string } | null;
}

export interface EditTextBorder { color?: string; alpha?: number; width?: number }
export interface EditTextBackground {
  color: string; style?: number; alpha?: number; round_radius?: number;
  height?: number; width?: number; horizontal_offset?: number; vertical_offset?: number;
}
export interface EditTextShadow { color?: string; alpha?: number; diffuse?: number; distance?: number; angle?: number }

export interface EditTextSegment extends EditSegmentBase {
  kind: "text";
  text: string;
  transform?: EditTransform | null;
  font_size?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
  font_family?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  opacity?: number;
  vertical?: boolean;
  letter_spacing?: number;
  line_spacing?: number;
  auto_wrapping?: boolean;
  max_line_width?: number;
  border?: EditTextBorder | null;
  background?: EditTextBackground | null;
  shadow?: EditTextShadow | null;
  bubble?: { effect_id: string; resource_id: string } | null;
  text_effect_id?: string | null;
  animations?: EditAnimation[];
}

export interface EditStickerSegment extends EditSegmentBase { kind: "sticker"; resource_id: string; transform?: EditTransform | null }
export interface EditTrackEffectSegment extends EditSegmentBase { kind: "track_effect"; effect_type: string; params?: number[] | null }
export interface EditTrackFilterSegment extends EditSegmentBase { kind: "track_filter"; filter_type: string; intensity?: number }

export type EditSegment = EditMediaSegment | EditTextSegment | EditStickerSegment | EditTrackEffectSegment | EditTrackFilterSegment;

export interface EditTrack {
  id: string;
  track_type: EditTrackType;
  name: string;
  mute: boolean;
  segments: EditSegment[];
  /** SRT 字幕组是一条 kind=subtitle 的文字轨道 */
  kind?: "subtitle";
}

export interface EditMarker { time_us: number; label: string; color?: string }

export interface EditProject {
  id: string;
  name: string;
  canvas: EditCanvas;
  created_at: string;
  updated_at: string;
  revision: number;
  tracks: EditTrack[];
  markers: EditMarker[];
  draft?: unknown;
}

// ---------- 会话与素材 ----------

export interface AiEditDraftLink { draftId: string; draftName: string; exportedAt: string; exportedRevision: number }

export interface AiEditSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** "running" 表示 AI 正在回答或改时间线 */
  status: string;
  projectId: string;
  draftBox: AiEditDraftLink | null;
  /** 这一轮停下来等用户确认要不要花钱生成视频（老采集器没有这一项，当成没在等） */
  awaitingSpend?: boolean;
  /** 这一轮停下来等用户确认要不要运行技能里的命令 */
  awaitingCommand?: boolean;
}

export interface AiEditAction { name: string; summary: string; ok: boolean; error?: string }

/** 在画面上框的一块：x/y/width/height 是相对画布的比例（0–1，从左上角量），clip_ids 是框里的片段。 */
export interface AiEditRegion { time_us: number; x: number; y: number; width: number; height: number; clip_ids: string[] }

/** 发消息时引用的东西：时间线上的一段、某一刻、素材库里的一个素材（最多 10 个） */
export type AiEditRefRequest = { kind: "clip"; clip_id: string } | { kind: "time"; time_us: number } | { kind: "media"; media_id: string };
/** 存在用户消息上的引用；label 是给页面显示的说法（视频“海边”、第 3.2 秒、素材“logo”） */
export interface AiEditMessageRef { kind: "clip" | "time" | "media"; clip_id?: string; time_us?: number; media_id?: string; label: string }
/** 对话框里附的图：素材库里的那张，加一份给模型看的小预览（data URL，最多 4 张） */
export interface AiEditAttachmentRequest { media_id: string; preview: string }
export const MAX_MESSAGE_REFS = 10;
export const MAX_MESSAGE_ATTACHMENTS = 4;

export interface AiEditChatItem {
  id: string;
  /** note 是应用记的一行说明（比如退回到某句话之前），不是谁说的话 */
  role: "user" | "assistant" | "note";
  text: string;
  at: string;
  actions?: AiEditAction[];
  /** 用户发这句时带的框选；labels 是框里片段的称呼 */
  region?: AiEditRegion & { labels?: string[] };
  /** 用户这句引用的片段、时刻、素材 */
  refs?: AiEditMessageRef[];
  /** 用户这句附的图（素材库里的） */
  attachments?: Array<{ media_id: string; name: string }>;
}

export interface AiEditSession extends AiEditSessionSummary {
  /** 用户给这条片子定的目标：每次请求都写进系统提示，对话再长被裁掉也还在；空字符串表示没定 */
  goal?: string;
  revision: number;
  error: { code: string; message: string } | null;
  messages: AiEditChatItem[];
  /** 正在进行的这一轮：已经吐出来的文字和已经做完的步骤；look 是要页面在浏览器里帮忙拆的视频，spend 是等用户点头的花钱生成 */
  /** generating：正在生成图片、视频（或运行技能命令）时的一句状态；command 是等用户点头的技能命令 */
  streaming: { text: string; actions?: AiEditAction[]; look?: AiEditLookJob; spend?: AiEditSpendAsk; command?: AiEditCommandAsk; generating?: string } | null;
  /** 能撤销的上一步（最后一份存档的说法和种类）；没有时为 null */
  undo?: { label: string; kind: AiEditStepKind } | null;
  /** 能重做的那一步（刚撤销掉的）；没有时为 null */
  redo?: { label: string } | null;
  /** 操作历史：最近的存档，新的在前（最多 50 份）；撤销时带上某一份的 id 就一次撤到那一步之前 */
  history?: AiEditHistoryStep[];
  /** 能「退回到这句之前」的用户消息 id */
  revertible?: string[];
  /** 对话太长，更早的几轮已经没整段带给 AI（只附上了用户当时的原话） */
  trimmed?: boolean;
  /** 导出 MP4、导出工程、导入工程的进度和结果；采集器重启后没有 */
  output?: AiEditOutput | null;
}

/** 一步存档是什么：AI 剪的一整轮、看板上的手动改动（含换画面比例）、退回到某句话之前 */
export type AiEditStepKind = "turn" | "edit" | "revert";
export interface AiEditHistoryStep { id: string; kind: AiEditStepKind; label: string; at: string }

export interface AiEditSessionState { session: AiEditSession; project: EditProject }

/**
 * 采集器没有解码器，参考视频的镜头截图、闪白和配乐节拍由页面在浏览器里拆好交回；解析库的视频太大发不出去时也由页面压一份小的（squeeze，压到 bytes 以内）。
 * url 是采集器上的路径，访问时带素材 key。
 */
export interface AiEditLookJob { id: string; kind: "reference" | "beats" | "squeeze"; url: string; name?: string; bytes?: number; claimed?: boolean }

/**
 * 生成视频要花钱，模型不能自己批准：AI 要生成时这一轮先停下，把要生成的东西挂在这里，
 * 用户在页面上点「生成」才去调服务商；点「不生成」、停止、到 expiresAt 还没点，都不生成。
 */
export interface AiEditSpendAsk {
  id: string;
  kind: "video";
  /** 服务商的说法（「火山方舟 Seedance」「即梦」「小云雀」「LibTV」） */
  provider: string;
  model: string;
  /** 时长（秒）；0 或 -1 是让模型自己定 */
  seconds: number;
  resolution: "480p" | "720p" | "1080p";
  /** 画面比例（「9:16」，adaptive 是由模型定） */
  ratio: string;
  /** 带不带声音；null 是这家没法指定（小云雀） */
  audio: boolean | null;
  /** 提示词的前 200 字 */
  prompt: string;
  /** 按官方价估的人民币（元）；认不出的模型是 null */
  estimate: number | null;
  /** 毫秒时间戳，过了这一刻还没点就算不生成。按的是采集器的钟（它可能在别的电脑上），页面不拿来比，到点由采集器撤掉这一问 */
  expiresAt: number;
}

export interface AiEditMediaItem {
  id: string;
  name: string;
  kind: "video" | "image" | "audio";
  status: "ready" | "importing" | "failed";
  error: string | null;
  durationUs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  size: number | null;
  createdAt: string;
  /**
   * page：AI 写的网页片段或导入工程里的网页（openfilm 的页面），page 是它的 HTML 在采集器 pages/ 下的路径；
   * generated：AI 调生成服务做的图片或视频，provider 是哪家、prompt 是提示词前 200 字、key 是采集器认重复用的；
   * skill：技能跑出来的文件，skill 是技能的名字
   */
  source: {
    type: "douyin" | "local" | "page" | "generated" | "skill"; skill?: string; url?: string; videoId?: string; title?: string; author?: string; cover?: string; page?: string; pageId?: string; transparent?: boolean; renderedAt?: number;
    provider?: "openai" | "seedance"; model?: string; prompt?: string; key?: string;
  };
}

/** 素材是网页片段时回它的 HTML 路径（采集器 pages/ 下），不是回 null。 */
export const pageOf = (item: Pick<AiEditMediaItem, "source"> | null | undefined): string | null =>
  item?.source.type === "page" && typeof item.source.page === "string" ? item.source.page : null;

/** 导出成 MP4（mp4）、导出 film.html 工程包（film）、导入工程排时间线（import）的进度和结果 */
export interface AiEditOutput {
  kind: "mp4" | "film" | "import";
  state: "running" | "done" | "failed" | "cancelled";
  progress?: number;
  /** 做好的文件在采集器 renders/ 下的路径，用 aiEditFilmUrl 拼下载地址 */
  file?: string;
  name?: string;
  size?: number;
  /** 没带过去 / 没导进来的东西 */
  note?: string;
  error?: string;
  added?: number;
}

export interface AiEditDraftBoxStatus { status: "available" | "unavailable"; reason: string | null; platform: string; jianyingRunning: boolean }

export interface AiEditExportResult { draftId: string; draftName: string; path: string; created: boolean }

export const sessionRunning = (session: Pick<AiEditSession, "status" | "streaming"> | null | undefined): boolean =>
  Boolean(session && (session.status === "running" || session.streaming));

// ---------- 请求 ----------

const UPLOAD_LIMIT = 4 * 1024 ** 3;

function failure(status: number, value: any, fallback: string): LocalCollectorError {
  // 采集器一般回 { error: 代号, message }；也认 { error: { code, message } } 这种写法
  const nested = value?.error && typeof value.error === "object" ? value.error : null;
  return new LocalCollectorError((nested ? nested.code : value?.error) ?? `http_${status}`, value?.message ?? nested?.message ?? (
    status === 401 ? "连接已过期，请重新连接采集器。"
      : status === 404 ? "当前采集器还没有 AI 剪辑功能，请重启应用。"
        : fallback));
}

/** AI 剪辑的接口都走这里（技能那几个在 aiEditSkills.ts） */
export async function request(connection: ExploreConnection, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const { timeoutMs = 20_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await collectorFetch(connection, path, {
      ...rest,
      headers: { "Content-Type": "application/json", ...rest.headers as Record<string, string> },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LocalCollectorError("ai_edit_unreachable", "采集器没连上，请检查连接后重试。");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw failure(response.status, value, "AI 剪辑请求没成功，请稍后重试。");
  return value;
}

const sessionPath = (id: string) => `/v1/ai-edit/sessions/${encodeURIComponent(id)}`;

export async function listAiEditSessions(connection: ExploreConnection): Promise<AiEditSessionSummary[]> {
  const value = await request(connection, "/v1/ai-edit/sessions");
  return Array.isArray(value?.sessions) ? value.sessions : [];
}

export async function createAiEditSession(connection: ExploreConnection, options: { title?: string; canvas?: EditCanvas } = {}): Promise<AiEditSessionState> {
  const value = await request(connection, "/v1/ai-edit/sessions", { method: "POST", body: JSON.stringify(options) });
  return { session: value.session, project: value.project };
}

/** 带 afterRevision 时是长轮询：采集器最多挂 8 秒，会话一变立刻返回。 */
export async function getAiEditSession(connection: ExploreConnection, id: string, afterRevision?: number, signal?: AbortSignal): Promise<AiEditSessionState> {
  const query = afterRevision === undefined ? "" : `?afterRevision=${afterRevision}`;
  const value = await request(connection, `${sessionPath(id)}${query}`, { signal, timeoutMs: afterRevision === undefined ? 20_000 : 30_000 });
  return { session: value.session, project: value.project };
}

export async function deleteAiEditSession(connection: ExploreConnection, id: string): Promise<void> {
  await request(connection, sessionPath(id), { method: "DELETE" });
}

/** 一句话随带的东西：画面上框的一块、引用的片段/时刻/素材、附的图；没有的不发 */
export interface AiEditMessageExtras {
  region?: AiEditRegion | null;
  refs?: readonly AiEditRefRequest[];
  attachments?: readonly AiEditAttachmentRequest[];
  /** 剪辑页勾了「只看免费」：这一轮 AI 不用会员效果 */
  freeOnly?: boolean;
  /** 生成图片和视频的接口（generationForRequest 算好的）：和 config 平级，本机 CLI 模式下也带得过去；没配就不带 */
  generation?: AiEditGenerationRequest;
  /** 「解析视频」服务（解析库那份配置）：单独连了才带，采集器看参考视频、转写字幕用它；不带就用剪辑模型 */
  analysis?: AiEditConfig | null;
}

export async function sendAiEditMessage(connection: ExploreConnection, id: string, text: string, config: AiEditConfig, extras: AiEditMessageExtras = {}): Promise<AiEditSession> {
  const { region, refs, attachments, freeOnly, generation, analysis } = extras;
  // 本机 CLI 只带运行时和模型，存着的 Key 和地址不发
  const body = {
    text, config: aiRequestConfig(config),
    ...(analysis ? { analysis: aiRequestConfig(analysis) } : {}),
    ...(region ? { region } : {}),
    ...(refs?.length ? { refs } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(freeOnly ? { freeOnly: true } : {}),
    ...(generation && (generation.image || generation.video) ? { generation } : {}),
  };
  // 带图时请求体有几百 KB，给它多一点时间
  return (await request(connection, `${sessionPath(id)}/messages`, { method: "POST", body: JSON.stringify(body), timeoutMs: attachments?.length ? 60_000 : 20_000 })).session;
}

/**
 * 看板上能手动做的改动，参数和 AI 的同名工具一样（时间按秒）：move_clip { clip_id, start, track_id? }、update_clip、split_clip、
 * delete_clip、duplicate_clip { clip_id, start, track_id? }、update_track { track_id, mute }、reorder_tracks（全部轨道的完整顺序）。
 */
export type AiEditClipEdit = "move_clip" | "update_clip" | "split_clip" | "delete_clip" | "duplicate_clip" | "update_track" | "reorder_tracks"
  | "add_marker" | "remove_marker" | "add_subtitle_line"
  // 左栏「剪映素材」点了直接套上、属性卡里去掉
  | "add_transition" | "add_filter" | "add_effect" | "add_animation" | "add_mask" | "set_mix_mode" | "clear_clip_feature";
export interface AiEditEditCall { name: AiEditClipEdit; arguments: Record<string, unknown> }

/** 看板上手动剪一下（挪、裁、切、删、复制、改文字和位置大小、静音、调轨道层级）；AI 正在剪或别的改动没做完时采集器会拒绝。 */
export async function editAiEditClip(connection: ExploreConnection, id: string, name: AiEditClipEdit, args: Record<string, unknown>): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/edit`, { method: "POST", body: JSON.stringify({ name, arguments: args }) });
}

/** 一批最多几条改动：和采集器的 MAX_BATCH_EDITS 一样，超了采集器整批拒（too_many_edits） */
export const MAX_BATCH_EDITS = 200;

/** 一批改动一起做（1–MAX_BATCH_EDITS 条）：采集器只存一份存档，撤销一次全回来；任何一条没做成整批回滚，说明里写第几步为什么。 */
/** 一批改动；label 是撤销按钮和操作历史上的说法（「合拢了主轨」），不给就由采集器按改动拼 */
export async function editAiEditClips(connection: ExploreConnection, id: string, edits: readonly AiEditEditCall[], label?: string): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/edit`, { method: "POST", body: JSON.stringify({ edits, ...(label ? { label } : {}) }) });
}

/** 撤销上一步（手动改的、AI 一轮改的、换画面比例、退回都算一步）；带 to（操作历史里某一步的 id）时一次撤到那一步之前。 */
export async function undoAiEdit(connection: ExploreConnection, id: string, to?: string): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/undo`, { method: "POST", body: JSON.stringify(to ? { to } : {}) });
}

/** 重做刚撤销掉的那一步；没有能重做的时采集器回 409 nothing_to_redo。 */
export async function redoAiEdit(connection: ExploreConnection, id: string): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/redo`, { method: "POST", body: "{}" });
}

/** 把时间线退回到这句话发出之前的样子（退回本身也能撤销）。 */
export async function revertAiEdit(connection: ExploreConnection, id: string, messageId: string): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/revert`, { method: "POST", body: JSON.stringify({ messageId }) });
}

/** 看板上换画面比例（AI 正在剪时采集器会拒绝）。 */
export async function setAiEditCanvas(connection: ExploreConnection, id: string, canvas: Pick<EditCanvas, "width" | "height">): Promise<AiEditSessionState> {
  return request(connection, `${sessionPath(id)}/canvas`, { method: "POST", body: JSON.stringify(canvas) });
}

export async function setAiEditGoal(connection: ExploreConnection, id: string, goal: string): Promise<AiEditSession> {
  return (await request(connection, `${sessionPath(id)}/goal`, { method: "POST", body: JSON.stringify({ goal }) })).session;
}

export async function stopAiEditSession(connection: ExploreConnection, id: string): Promise<AiEditSession> {
  return (await request(connection, `${sessionPath(id)}/stop`, { method: "POST", body: "{}" })).session;
}

/**
 * 导入剪映：auto 是有草稿就原位更新，但草稿在剪映里被打开或改过时报 draft_changed（不写任何东西）；
 * new 另存一份新草稿，update 直接覆盖剪映里的改动。
 */
export type AiEditExportMode = "auto" | "new" | "update";

export async function exportAiEditSession(connection: ExploreConnection, id: string, mode?: AiEditExportMode): Promise<{ session: AiEditSession; result: AiEditExportResult }> {
  // 第一次要把素材克隆进草稿目录，大文件会久一点
  const value = await request(connection, `${sessionPath(id)}/export`, { method: "POST", body: JSON.stringify(mode ? { mode } : {}), timeoutMs: 180_000 });
  return { session: value.session, result: value.result };
}

export async function getAiEditDraftBox(connection: ExploreConnection): Promise<AiEditDraftBoxStatus> {
  return request(connection, "/v1/ai-edit/draft-box");
}

/** 配置时测一下模型能不能直接看视频（采集器发一段 3 秒的小视频问画面上写的数字）。 */
export async function probeAiEditVideo(connection: ExploreConnection, config: AiEditConfig): Promise<{ videoInput: boolean; answer: string }> {
  const value = await request(connection, "/v1/ai-edit/probe-video", { method: "POST", body: JSON.stringify({ config }), timeoutMs: 130_000 });
  return { videoInput: value?.videoInput === true, answer: typeof value?.answer === "string" ? value.answer : "" };
}

export interface AiRuntimeStatus {
  id: LocalAiRuntime;
  label: string;
  /** ready 能用；missing 没找到；broken 启动不了；logged_out 没登录；expired 登录过期；unsupported 版本对不上 */
  state: "ready" | "missing" | "broken" | "logged_out" | "expired" | "unsupported";
  version: string | null;
  /** 给用户看的整句话 */
  message: string;
}

/** 这台电脑上的 Codex / Claude Code 装没装、登没登录（不花额度）。旧版采集器没有这个接口时返回 null。 */
export async function getAiRuntimes(connection: ExploreConnection, fresh = false): Promise<AiRuntimeStatus[] | null> {
  try {
    const value = await request(connection, `/v1/ai-edit/runtimes${fresh ? "?fresh=1" : ""}`, { timeoutMs: 40_000 });
    return Array.isArray(value?.runtimes) ? value.runtimes : [];
  } catch (error) {
    // 404 那句「当前采集器还没有 AI 剪辑功能」在这里不对，交给调用方说
    // 旧版采集器的 AI 剪辑路由对不认识的路径回 { error: "not_found" }
    if (error instanceof LocalCollectorError && (error.code === "not_found" || error.code === "http_404")) return null;
    throw error;
  }
}

/** 各会话这一轮挂着的拆视频任务（url 已带素材 key），应用开着就接，不管当前在哪个页面。 */
export async function listPendingAiEditLooks(connection: ExploreConnection): Promise<{ sessionId: string; look: AiEditLookJob }[]> {
  const value = await request(connection, "/v1/ai-edit/looks");
  return Array.isArray(value?.looks) ? value.looks : [];
}

/** 把页面拆好的结果（或拆不了的原因）交回给采集器。 */
export async function answerAiEditLook(connection: ExploreConnection, sessionId: string, lookId: string, body: unknown): Promise<void> {
  await request(connection, `${sessionPath(sessionId)}/look/${encodeURIComponent(lookId)}`, { method: "POST", body: JSON.stringify(body), timeoutMs: 60_000 });
}

/** 用户在卡片上点了「生成」（allow）或「不生成」。这一问已经结束（超时、停止、别的窗口答过）时采集器回 404 spend_not_found。 */
export async function answerAiEditSpend(connection: ExploreConnection, sessionId: string, askId: string, allow: boolean): Promise<void> {
  await request(connection, `${sessionPath(sessionId)}/spend/${encodeURIComponent(askId)}`, { method: "POST", body: JSON.stringify({ allow }) });
}

export type AiEditCatalogKind = "transition" | "filter" | "video_effect" | "video_intro" | "video_outro" | "video_group"
  | "text_intro" | "text_outro" | "text_loop" | "font" | "audio_effect" | "mask" | "mix_mode";
/** cover：剪映缓存里的预览图（在剪映里打开过那一栏素材才有）；preview：动画类的动图，鼠标移上去才播 */
export interface AiEditCatalogItem { name: string; display?: string; vip?: boolean; default_duration?: number; cover?: string; preview?: string }

/** 剪映内置的转场、滤镜、特效、动画、字体……就是 AI 能写进草稿的那份目录；free 只要不用会员的。 */
export async function searchAiEditCatalog(connection: ExploreConnection, kind: AiEditCatalogKind, query: string, free: boolean): Promise<{ total: number; items: AiEditCatalogItem[] }> {
  const value = await request(connection, `/v1/ai-edit/catalog?kind=${kind}&q=${encodeURIComponent(query)}${free ? "&free=1" : ""}`);
  return { total: Number(value?.total) || 0, items: Array.isArray(value?.items) ? value.items : [] };
}

export async function listAiEditMedia(connection: ExploreConnection): Promise<{ media: AiEditMediaItem[]; key: string; filmKey: string }> {
  const value = await request(connection, "/v1/ai-edit/media");
  return { media: Array.isArray(value?.media) ? value.media : [], key: typeof value?.key === "string" ? value.key : "", filmKey: typeof value?.filmKey === "string" ? value.filmKey : "" };
}

/** 出 MP4、导出 film.html 工程包；cancel 停下正在做的，dismiss 收起做完的结果。 */
export async function startAiEditOutput(connection: ExploreConnection, id: string, kind: "mp4" | "film" | "cancel" | "dismiss"): Promise<AiEditSession> {
  return (await request(connection, `/v1/ai-edit/sessions/${encodeURIComponent(id)}/output`, { method: "POST", body: JSON.stringify({ kind }) })).session;
}

/** 网页片段、film.html 和做好的文件的地址：key 在路径里，iframe 和下载链接直接用。 */
export function aiEditFilmUrl(baseUrl: string, filmKey: string, path: string, download = false): string {
  return `${normalizeCollectorBaseUrl(baseUrl)}/v1/ai-edit/film/${encodeURIComponent(filmKey)}/${path.split("/").map(encodeURIComponent).join("/")}${download ? "?download=1" : ""}`;
}

export interface DouyinMediaRequest { url: string; title?: string; author?: string; cover?: string; videoId?: string; durationSeconds?: number }

export async function importDouyinMedia(connection: ExploreConnection, input: DouyinMediaRequest): Promise<AiEditMediaItem> {
  return (await request(connection, "/v1/ai-edit/media/douyin", { method: "POST", body: JSON.stringify(input) })).item;
}

export async function deleteAiEditMedia(connection: ExploreConnection, id: string): Promise<void> {
  await request(connection, `/v1/ai-edit/media/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 素材文件地址：不带 Bearer，靠素材库的 key，<video>/<img> 可以直接用（支持 Range）。 */
/** 请页面拆视频时，采集器给的是路径，这里补上根地址和素材 key。 */
export function aiEditLookUrl(baseUrl: string, path: string, key: string): string {
  return `${normalizeCollectorBaseUrl(baseUrl)}${path}?key=${encodeURIComponent(key)}`;
}

export function aiEditMediaUrl(baseUrl: string, id: string, key: string): string {
  return `${normalizeCollectorBaseUrl(baseUrl)}/v1/ai-edit/media/${encodeURIComponent(id)}/file?key=${encodeURIComponent(key)}`;
}

/**
 * 上传本机文件：请求体就是文件字节，采集器流式落盘。fetch 拿不到上传进度，所以用 XMLHttpRequest。
 * 配对过期（401 not_paired）时退回 collectorFetch 重发一次，它会自动续配，代价是这一次没有进度。
 */
export function uploadAiEditMedia(connection: ExploreConnection, file: File, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<AiEditMediaItem> {
  if (file.size > UPLOAD_LIMIT) return Promise.reject(new LocalCollectorError("media_too_large", "文件超过 4GB，放不进素材库。"));
  return uploadBody(connection, `/v1/ai-edit/media/upload?name=${encodeURIComponent(file.name)}`, file, onProgress, signal, (value) => value?.item);
}

/** 导入 openfilm 工程：film.html 所在文件夹打的 zip。采集器建一个新剪辑，在后台把片段排上时间线（进度在 session.output）。 */
export function importAiEditFilm(connection: ExploreConnection, file: File, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<AiEditSessionState> {
  if (file.size > UPLOAD_LIMIT) return Promise.reject(new LocalCollectorError("film_too_large", "工程超过 4GB 了。"));
  return uploadBody(connection, `/v1/ai-edit/film-import?name=${encodeURIComponent(file.name)}`, file, onProgress, signal, (value) => (value?.session && value?.project ? value : null));
}

function uploadBody<T>(connection: ExploreConnection, path: string, file: File, onProgress: (ratio: number) => void, signal: AbortSignal | undefined, pick: (value: any) => T | null | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${normalizeCollectorBaseUrl(connection.baseUrl)}${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${connection.token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let value: any = null;
      try { value = JSON.parse(xhr.responseText); } catch { /* 非 JSON 按失败处理 */ }
      const picked = xhr.status >= 200 && xhr.status < 300 ? pick(value) : null;
      if (picked) { onProgress(1); resolve(picked); return; }
      if (xhr.status === 401 && value?.error === "not_paired") {
        collectorFetch(connection, path, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" }, signal })
          .then(async (response) => {
            const retried = await response.json().catch(() => null);
            const again = response.ok ? pick(retried) : null;
            if (!again) throw failure(response.status, retried, "文件没传上去，请稍后重试。");
            onProgress(1);
            resolve(again);
          })
          .catch(reject);
        return;
      }
      reject(failure(xhr.status, value, "文件没传上去，请稍后重试。"));
    };
    xhr.onerror = () => reject(new LocalCollectorError("ai_edit_unreachable", "采集器没连上，文件没传上去。"));
    xhr.onabort = () => reject(new LocalCollectorError("upload_aborted", "已取消上传。"));
    if (signal) {
      if (signal.aborted) { reject(new LocalCollectorError("upload_aborted", "已取消上传。")); return; }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
