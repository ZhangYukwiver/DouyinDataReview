import { type AssistantConfig, isLocalAiRuntime } from "./assistant";
import type { ExploreConnection } from "./explorer";
import { collectorFetch, LocalCollectorError } from "./localCollector";
import type { VideoAnalysisKind } from "./videoAnalysis";

// 知识库：视频解析的结果都在这里检索、提问。切段、BM25、语义向量同轻阅网页端，见 collector/knowledgeBase.mjs

/** 和采集器、轻阅网页端一致的模型签名；换模型或算法时向量要整份重算 */
export const KNOWLEDGE_MODEL = "bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781:cls-window-mean-v1:fp32";
const MODEL_FILES = ["config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"];

export interface KnowledgeDocument { id: string; videoId: string; kind: VideoAnalysisKind; title: string; model: string; createdAt: string; chars: number; chunks: number }
export interface KnowledgeView { documents: KnowledgeDocument[]; chunks: number; embedded: number; unique: number }
export interface KnowledgeHit { id: string; documentId: string; videoId: string; kind: VideoAnalysisKind; title: string; label: string; quote: string; citation?: string }
export interface KnowledgeAnswer { answer: string; sources: KnowledgeHit[]; notice?: string; citationWarning?: string }
export interface KnowledgeModelState { status: "idle" | "downloading" | "ready" | "failed"; received: number; total: number; message: string }

async function request<T>(connection: ExploreConnection, path: string, accountId: string | null, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const query = accountId ? `${path.includes("?") ? "&" : "?"}account=${encodeURIComponent(accountId)}` : "";
  let response: Response;
  try {
    response = await collectorFetch(connection, `${path}${query}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new LocalCollectorError("knowledge_unreachable", "知识库暂时没有响应，请检查采集器连接后重试。");
  }
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) {
    if (response.status === 404 && body?.error === "not_found") throw new LocalCollectorError("not_found", "这个版本的采集器还没有知识库，请更新应用。");
    throw new LocalCollectorError(body?.error ?? `http_${response.status}`, body?.message ?? "知识库暂时不可用，请重试。");
  }
  return body as T;
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", body: JSON.stringify(body), signal });
const vectorBody = (vector: Float32Array | null) => (vector ? { vector: Array.from(vector), signature: KNOWLEDGE_MODEL } : {});

export const getKnowledge = (connection: ExploreConnection, accountId: string | null, signal?: AbortSignal) =>
  request<KnowledgeView>(connection, `/v1/knowledge?signature=${encodeURIComponent(KNOWLEDGE_MODEL)}`, accountId, { signal });

export const pendingPassages = (connection: ExploreConnection, accountId: string | null, signal?: AbortSignal) =>
  request<{ items: Array<{ hash: string; text: string }> }>(connection, `/v1/knowledge/pending?signature=${encodeURIComponent(KNOWLEDGE_MODEL)}`, accountId, { signal });

export const saveVectors = (connection: ExploreConnection, accountId: string | null, items: Array<{ hash: string; vector: Float32Array }>, signal?: AbortSignal) =>
  request<{ saved: number }>(connection, "/v1/knowledge/vectors", accountId, post({ signature: KNOWLEDGE_MODEL, items: items.map(item => ({ hash: item.hash, vector: packVector(item.vector) })) }, signal));

export const searchKnowledge = (connection: ExploreConnection, accountId: string | null, query: string, vector: Float32Array | null, signal?: AbortSignal) =>
  request<{ hits: KnowledgeHit[] }>(connection, "/v1/knowledge/search", accountId, post({ query, ...vectorBody(vector) }, signal));

/** 本机 Codex / Claude 可能要几分钟才答完 */
export const askKnowledge = (connection: ExploreConnection, accountId: string | null, question: string, vector: Float32Array | null, config: AssistantConfig, signal?: AbortSignal) =>
  request<KnowledgeAnswer>(connection, "/v1/knowledge/ask", accountId,
    post({ question, ...vectorBody(vector), config: isLocalAiRuntime(config.runtime) ? { runtime: config.runtime, model: config.model.trim() } : config }, signal), 11 * 60_000);

export const getKnowledgeModel = (connection: ExploreConnection, signal?: AbortSignal) => request<KnowledgeModelState>(connection, "/v1/knowledge/model", null, { signal });
export const prepareKnowledgeModel = (connection: ExploreConnection) => request<KnowledgeModelState>(connection, "/v1/knowledge/model", null, { method: "POST" });

/** 小端 float32 的 base64，和采集器、轻阅存的格式一样 */
export function packVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 页面里的语义模型：Worker 跑 public/knowledge/embedding-worker.js，模型文件从采集器取来交给它 */
export class KnowledgeEmbedder {
  private worker: Worker | null = null;
  private next = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  static async load(connection: ExploreConnection, signal: AbortSignal): Promise<KnowledgeEmbedder> {
    const files: Record<string, ArrayBuffer> = {};
    for (const name of MODEL_FILES) {
      const response = await collectorFetch(connection, `/v1/knowledge/model/${name}`, { signal });
      if (!response.ok) throw new LocalCollectorError("model_unavailable", "语义模型读取失败，请重试。");
      files[name] = await response.arrayBuffer();
    }
    const embedder = new KnowledgeEmbedder();
    try {
      await embedder.call({ type: "init", files }, Object.values(files));
    } catch (error) { embedder.close(); throw error; }
    return embedder;
  }

  private call(message: object, transfer: Transferable[] = []): Promise<unknown> {
    if (!this.worker) {
      // 地址先放进变量：Metro 见到 new Worker(new URL(...)) 会当成要打包的模块，这个 Worker 是 public/ 里的静态文件
      const script = new URL("/knowledge/embedding-worker.js", globalThis.location.href);
      this.worker = new Worker(script, { type: "module" });
      this.worker.onmessage = event => {
        const { id, result, error } = event.data as { id: number; result?: unknown; error?: string };
        const request = this.pending.get(id);
        this.pending.delete(id);
        if (error) request?.reject(new Error(error)); else request?.resolve(result);
      };
      this.worker.onerror = () => this.close("本机语义模型加载失败，先用关键词检索。");
    }
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }

  embed(text: string, query = false): Promise<Float32Array> {
    return this.call({ type: "embed", text, query }) as Promise<Float32Array>;
  }

  close(message = "本机语义模型已停止"): void {
    this.worker?.terminate();
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }
}
