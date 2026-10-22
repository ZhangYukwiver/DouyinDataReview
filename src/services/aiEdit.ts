import { LocalCollectorError, collectorFetch, normalizeCollectorBaseUrl } from "./localCollector";
import type { ExploreConnection } from "./explorer";

// AI 剪辑：对话、工程、素材库都在采集器（collector/aiEdit/），页面只负责发消息、长轮询会话、上传素材和展示。
// 接口配置存在本机 localStorage，和解析库的配置完全分开，每次随消息带过去，采集器不保存 Key。

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
  animations?: Array<{ animation_type: string; duration_us?: number | null }>;
  transition?: { transition_type: string; duration_us: number | null } | null;
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
  animations?: Array<{ animation_type: string; duration_us?: number | null }>;
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
}

export interface AiEditAction { name: string; summary: string; ok: boolean; error?: string }

export interface AiEditChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  actions?: AiEditAction[];
}

export interface AiEditSession extends AiEditSessionSummary {
  /** 用户给这条片子定的目标：每次请求都写进系统提示，对话再长被裁掉也还在；空字符串表示没定 */
  goal?: string;
  revision: number;
  error: { code: string; message: string } | null;
  messages: AiEditChatItem[];
  /** 正在进行的这一轮：已经吐出来的文字和已经做完的步骤；look 是要页面在浏览器里帮忙拆的视频 */
  streaming: { text: string; actions?: AiEditAction[]; look?: AiEditLookJob } | null;
}

export interface AiEditSessionState { session: AiEditSession; project: EditProject }

/** 采集器没有解码器，参考视频的镜头截图、闪白和配乐节拍由页面在浏览器里拆好交回。url 是采集器上的路径，访问时带素材 key。 */
export interface AiEditLookJob { id: string; kind: "reference" | "beats"; url: string; name?: string; claimed?: boolean }

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
  source: { type: "douyin" | "local"; url?: string; videoId?: string; title?: string; author?: string; cover?: string };
}

export interface AiEditDraftBoxStatus { status: "available" | "unavailable"; reason: string | null; platform: string; jianyingRunning: boolean }

export interface AiEditExportResult { draftId: string; draftName: string; path: string; created: boolean }

export const sessionRunning = (session: Pick<AiEditSession, "status" | "streaming"> | null | undefined): boolean =>
  Boolean(session && (session.status === "running" || session.streaming));

// ---------- 请求 ----------

const UPLOAD_LIMIT = 4 * 1024 ** 3;

function failure(status: number, value: any, fallback: string): LocalCollectorError {
  return new LocalCollectorError(value?.error ?? `http_${status}`, value?.message ?? (
    status === 401 ? "连接已过期，请重新连接采集器。"
      : status === 404 ? "当前采集器还没有 AI 剪辑功能，请重启应用。"
        : fallback));
}

async function request(connection: ExploreConnection, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
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

export async function sendAiEditMessage(connection: ExploreConnection, id: string, text: string, config: AiEditConfig): Promise<AiEditSession> {
  return (await request(connection, `${sessionPath(id)}/messages`, { method: "POST", body: JSON.stringify({ text, config: aiRequestConfig(config) }) })).session;
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

export async function exportAiEditSession(connection: ExploreConnection, id: string): Promise<{ session: AiEditSession; result: AiEditExportResult }> {
  // 第一次要把素材克隆进草稿目录，大文件会久一点
  const value = await request(connection, `${sessionPath(id)}/export`, { method: "POST", body: "{}", timeoutMs: 180_000 });
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

export async function listAiEditMedia(connection: ExploreConnection): Promise<{ media: AiEditMediaItem[]; key: string }> {
  const value = await request(connection, "/v1/ai-edit/media");
  return { media: Array.isArray(value?.media) ? value.media : [], key: typeof value?.key === "string" ? value.key : "" };
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
  const path = `/v1/ai-edit/media/upload?name=${encodeURIComponent(file.name)}`;
  return new Promise<AiEditMediaItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${normalizeCollectorBaseUrl(connection.baseUrl)}${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${connection.token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let value: any = null;
      try { value = JSON.parse(xhr.responseText); } catch { /* 非 JSON 按失败处理 */ }
      if (xhr.status >= 200 && xhr.status < 300 && value?.item) { onProgress(1); resolve(value.item); return; }
      if (xhr.status === 401 && value?.error === "not_paired") {
        collectorFetch(connection, path, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" }, signal })
          .then(async (response) => {
            const retried = await response.json().catch(() => null);
            if (!response.ok || !retried?.item) throw failure(response.status, retried, "文件没传上去，请稍后重试。");
            onProgress(1);
            resolve(retried.item);
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
