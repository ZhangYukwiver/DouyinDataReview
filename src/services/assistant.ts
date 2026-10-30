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

export const sendAssistantMessage = (connection: ExploreConnection, text: string, config: AssistantConfig) =>
  request<AssistantView>(connection, "/v1/assistant/messages", { method: "POST", body: JSON.stringify({ text, config: requestConfig(config) }) });

export const stopAssistant = (connection: ExploreConnection) => request<AssistantView>(connection, "/v1/assistant/stop", { method: "POST" });

export const resetAssistant = (connection: ExploreConnection) => request<AssistantView>(connection, "/v1/assistant", { method: "DELETE" });

export const answerAssistantConfirm = (connection: ExploreConnection, id: string, allow: boolean) =>
  request<AssistantView>(connection, `/v1/assistant/confirm/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ allow }) });

export async function getAiRuntimes(connection: ExploreConnection, fresh = false): Promise<AiRuntimeStatus[]> {
  const value = await request<{ runtimes?: AiRuntimeStatus[] }>(connection, `/v1/assistant/runtimes${fresh ? "?fresh=1" : ""}`, {}, 40_000);
  return Array.isArray(value?.runtimes) ? value.runtimes : [];
}
