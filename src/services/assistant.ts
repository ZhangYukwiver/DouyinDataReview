import type { ExploreConnection } from "./explorer";
import { collectorFetch, LocalCollectorError } from "./localCollector";

// AI 助手：对话和确认卡片都在采集器上（collector/assistant/）。
// 模型配置存在这台电脑的 localStorage，接口 Key 每次随请求带过去，采集器不落盘。

export type AiRuntime = "api" | "codex" | "claude";
export type LocalAiRuntime = Exclude<AiRuntime, "api">;

export interface AssistantConfig {
  /** 没有就是接口 */
  runtime?: AiRuntime;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AssistantVideo {
  readonly videoId: string | null;
  readonly title: string;
  readonly author: string | null;
}

export interface AssistantAction {
  label: string;
  ok: boolean;
  running?: boolean;
  /** 没成功时的原因 */
  note?: string;
  /** 下载好的作品：对话里出「保存」 */
  download?: { id: string; fileName: string | null };
}

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
  actions?: AssistantAction[];
}

export interface AssistantConfirm {
  id: string;
  /** 「发私信」「点赞」这样的一句 */
  action: string;
  target?: string;
  text?: string;
  /** app 应用内对话；mcp 用户自己的 AI 客户端 */
  source: "app" | "mcp";
  /** 点了允许以后，同样的操作（换了对象也算）这一轮里不再问 */
  covers?: boolean;
  expiresAt: number;
}

export interface AssistantView {
  revision: number;
  busy: boolean;
  messages: AssistantMessage[];
  streaming: { text: string; actions: AssistantAction[] } | null;
  error: string | null;
  confirms: AssistantConfirm[];
  foldersRevision?: string | null;
  ui: { type: "open_view"; view: string; seq: number } | null;
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

const CONFIG_KEY = "dy2.assistantConfig";
// 方舟默认模型；用户也可以填任何 OpenAI 兼容的中转
export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = { runtime: "api", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", model: "doubao-seed-2-1-lite-260915" };

export const isLocalAiRuntime = (runtime: AiRuntime | undefined): runtime is LocalAiRuntime => runtime === "codex" || runtime === "claude";

export function loadAssistantConfig(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): AssistantConfig {
  try {
    const saved = JSON.parse(storage?.getItem(CONFIG_KEY) ?? "null") as Partial<AssistantConfig> | null;
    if (!saved || typeof saved !== "object") return DEFAULT_ASSISTANT_CONFIG;
    const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
    return {
      runtime: saved.runtime === "codex" || saved.runtime === "claude" ? saved.runtime : "api",
      baseUrl: text(saved.baseUrl, DEFAULT_ASSISTANT_CONFIG.baseUrl),
      apiKey: text(saved.apiKey, ""),
      model: text(saved.model, DEFAULT_ASSISTANT_CONFIG.model),
    };
  } catch {
    return DEFAULT_ASSISTANT_CONFIG;
  }
}

export function saveAssistantConfig(config: AssistantConfig, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不了就只在这次用 */ }
}

/**
 * 分镜脚本另配的视频模型（可选）：上面那个模型收不了视频时，另指一个能看整段视频的接口模型。
 * 地址和 Key 留空就沿用上面接口的；存在这台电脑的 localStorage，和对话模型一样随请求带给采集器。
 */
export type VideoModelConfig = Pick<AssistantConfig, "baseUrl" | "apiKey" | "model">;
const VIDEO_MODEL_KEY = "dy2.videoModelConfig";
const NO_VIDEO_MODEL: VideoModelConfig = { baseUrl: "", apiKey: "", model: "" };

export function loadVideoModelConfig(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): VideoModelConfig {
  try {
    const saved = JSON.parse(storage?.getItem(VIDEO_MODEL_KEY) ?? "null") as Partial<VideoModelConfig> | null;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return saved && typeof saved === "object" ? { baseUrl: text(saved.baseUrl), apiKey: text(saved.apiKey), model: text(saved.model) } : NO_VIDEO_MODEL;
  } catch {
    return NO_VIDEO_MODEL;
  }
}

export function saveVideoModelConfig(config: VideoModelConfig, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(VIDEO_MODEL_KEY, JSON.stringify(config)); } catch { /* 存不了就只在这次用 */ }
}

/** 发给采集器的视频模型：没填模型名，或者凑不齐地址和 Key（留空又没有接口可沿用），就是没配。 */
export function resolveVideoModel(video: VideoModelConfig, main: AssistantConfig): VideoModelConfig | undefined {
  const inherit = (own: string, shared: string) => own.trim() || (isLocalAiRuntime(main.runtime) ? "" : shared.trim());
  const resolved = { baseUrl: inherit(video.baseUrl, main.baseUrl), apiKey: inherit(video.apiKey, main.apiKey), model: video.model.trim() };
  return resolved.baseUrl && resolved.apiKey && resolved.model ? resolved : undefined;
}

/** 配好了才能发：接口要地址、Key、模型都在；本机 CLI 模型可以留空。 */
export const assistantConfigReady = (config: AssistantConfig): boolean => isLocalAiRuntime(config.runtime) || Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.model.trim());

/** 发给采集器的配置：本机 CLI 只带运行时和模型，Key 不出门。 */
const requestConfig = (config: AssistantConfig) => (isLocalAiRuntime(config.runtime) ? { runtime: config.runtime, model: config.model.trim() } : config);

async function request<T>(connection: ExploreConnection, path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const response = await collectorFetch(connection, path, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) {
    if (response.status === 404 && body?.error === "not_found") throw new LocalCollectorError("not_found", "这个版本的采集器还没有 AI 助手，请更新应用。");
    throw new LocalCollectorError(body?.error ?? `http_${response.status}`, body?.message ?? "AI 助手没响应，请稍后再试。");
  }
  return body as T;
}

/** 长轮询：版本号没变时采集器最多等 8 秒才回。 */
export const getAssistant = (connection: ExploreConnection, afterRevision: number | null, signal?: AbortSignal) =>
  request<AssistantView>(connection, `/v1/assistant${afterRevision === null ? "" : `?afterRevision=${afterRevision}`}`, { signal }, 20_000);

export const sendAssistantMessage = (connection: ExploreConnection, text: string, config: AssistantConfig, currentVideo: AssistantVideo | null) =>
  request<AssistantView>(connection, "/v1/assistant/messages", { method: "POST", body: JSON.stringify({ text, config: requestConfig(config), currentVideo }) });

export const stopAssistant = (connection: ExploreConnection) => request<AssistantView>(connection, "/v1/assistant/stop", { method: "POST" });

export const resetAssistant = (connection: ExploreConnection) => request<AssistantView>(connection, "/v1/assistant", { method: "DELETE" });

export const answerAssistantConfirm = (connection: ExploreConnection, id: string, allow: boolean) =>
  request<AssistantView>(connection, `/v1/assistant/confirm/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ allow }) });

export async function getAiRuntimes(connection: ExploreConnection, fresh = false): Promise<AiRuntimeStatus[]> {
  const value = await request<{ runtimes?: AiRuntimeStatus[] }>(connection, `/v1/assistant/runtimes${fresh ? "?fresh=1" : ""}`, {}, 40_000);
  return Array.isArray(value?.runtimes) ? value.runtimes : [];
}

export type McpClient = { command: string; args: string[]; env: Record<string, string> };

export const getMcpClient = (connection: ExploreConnection) => request<McpClient>(connection, "/v1/assistant/mcp");

/** 设置 → AI 里给用户复制的接入写法：Claude Code、Codex 的命令，其他客户端的 JSON 配置。 */
export function mcpCommands({ command, args, env }: McpClient) {
  const run = [command, ...args].map((part) => `"${part}"`).join(" ");
  const flags = (flag: string) => Object.entries(env).map(([key, value]) => `${flag} ${key}=${/\s/u.test(value) ? `"${value}"` : value} `).join("");
  return {
    claude: `claude mcp add dy2 ${flags("-e")}-- ${run}`,
    codex: `codex mcp add dy2 ${flags("--env")}-- ${run}`,
    json: JSON.stringify({ mcpServers: { dy2: { command, args, env } } }, null, 2),
  };
}
