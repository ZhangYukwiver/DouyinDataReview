import type { AssistantConfig, VideoModelConfig } from "./assistant";
import type { ExploreConnection } from "./explorer";
import { collectorFetch, LocalCollectorError } from "./localCollector";

export type VideoAnalysisKind = "transcript" | "script" | "notes";
export type VideoAnalysisEngine = "bcut" | "qwen";
export type VideoAnalysisJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface VideoAnalysisEntry {
  startMs: number;
  endMs?: number;
  title?: string;
  text: string;
  /** 学习笔记这一章的配图（原片截图的 data URI） */
  figure?: string;
}

export interface VideoAnalysisResult {
  key: string;
  kind: VideoAnalysisKind;
  engine: VideoAnalysisEngine;
  withFrames: boolean;
  model: string | null;
  createdAt: string;
  entries: VideoAnalysisEntry[];
  markdown: string;
  /** 分镜脚本是模型看整段视频拆的；没有就是按关键帧拆的 */
  source?: "video";
  article?: { title: string; overview: string; summary: string; sourceUrl: string };
}

export interface VideoAnalysisJob {
  id: string;
  status: VideoAnalysisJobStatus;
  stage: string;
  message: string;
  kind: VideoAnalysisKind;
  engine: VideoAnalysisEngine;
  withFrames: boolean;
  errorCode?: string;
  resultKey?: string;
  /** 首选的 Qwen3-ASR 没转写成功、改用了必剪时的一句说明；这时 engine 和 resultKey 已经是必剪的 */
  note?: string;
}

export interface VideoAnalysisResponse {
  job: VideoAnalysisJob | null;
  results: VideoAnalysisResult[];
}

export type SavedVideoNote = Pick<VideoAnalysisResult, "key" | "engine" | "withFrames" | "model" | "createdAt"> & { videoId: string; title: string };

export interface StartVideoAnalysisInput {
  kind: VideoAnalysisKind;
  title?: string;
  engine: VideoAnalysisEngine;
  withFrames: boolean;
  config?: AssistantConfig | Pick<AssistantConfig, "runtime" | "model">;
  /** 分镜脚本另配的视频模型（设置 → AI 里填了才有） */
  videoConfig?: VideoModelConfig;
}

/** 批量解析的一条：采集器排着队一条一条做，页面关了也接着跑 */
export interface VideoAnalysisBatchItem {
  videoId: string;
  title: string;
  status: "waiting" | VideoAnalysisJobStatus;
  /** 正在做的是当前进度，失败的是原因，完成的是换了转写服务之类的说明 */
  message: string;
}

export interface VideoAnalysisBatch {
  id: string;
  kind: VideoAnalysisKind;
  status: "running" | "done";
  items: VideoAnalysisBatchItem[];
}

function route(videoId: string, accountId?: string | null): string {
  const value = videoId.trim();
  if (!value) throw new LocalCollectorError("invalid_video", "缺少视频编号，暂时不能解析。");
  const account = accountId?.trim();
  return `/v1/video-analysis/${encodeURIComponent(value)}${account ? `?account=${encodeURIComponent(account)}` : ""}`;
}

function readAnalysis(value: Partial<VideoAnalysisResponse> | null): VideoAnalysisResponse {
  if (!value || !Array.isArray(value.results)) throw new LocalCollectorError("invalid_response", "视频解析返回的数据格式无效，请更新应用。");
  return { job: value.job ?? null, results: value.results as VideoAnalysisResult[] };
}

async function request<T>(connection: ExploreConnection, videoId: string, read: (value: Partial<VideoAnalysisResponse> & { notes?: SavedVideoNote[]; batch?: VideoAnalysisBatch | null } | null) => T, init: RequestInit, signal?: AbortSignal, accountId?: string | null): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 120_000);
  try {
    signal?.throwIfAborted();
    const response = await collectorFetch(connection, route(videoId, accountId), {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new LocalCollectorError(value?.error ?? `video_analysis_${response.status}`, value?.message ?? "视频解析失败，请稍后重试。");
    return read(value);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("video_analysis_unreachable", "解析服务暂时没有响应，请检查采集器连接后重试。");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function getVideoAnalysis(connection: ExploreConnection, videoId: string, signal?: AbortSignal, accountId?: string | null): Promise<VideoAnalysisResponse> {
  return request(connection, videoId, readAnalysis, {}, signal, accountId);
}

export function getSavedVideoNotes(connection: ExploreConnection, signal: AbortSignal, accountId: string): Promise<SavedVideoNote[]> {
  return request(connection, "notes", value => {
    if (!Array.isArray(value?.notes)) throw new LocalCollectorError("invalid_response", "无法读取已保存笔记，请更新采集器。");
    return value.notes;
  }, {}, signal, accountId);
}

export function startVideoAnalysis(connection: ExploreConnection, videoId: string, input: StartVideoAnalysisInput, signal?: AbortSignal, accountId?: string | null): Promise<VideoAnalysisResponse> {
  return request(connection, videoId, readAnalysis, { method: "POST", body: JSON.stringify(input) }, signal, accountId);
}

export function cancelVideoAnalysis(connection: ExploreConnection, videoId: string, signal?: AbortSignal, accountId?: string | null): Promise<VideoAnalysisResponse> {
  return request(connection, videoId, readAnalysis, { method: "DELETE" }, signal, accountId);
}

/**
 * 批量那一队：不带 body 是看现在这批（没有就是 null）；带 items 开一批；带 retry 把没成的重新排上
 * （true 是全部，视频编号是单独一条）；stop 是停掉整批。
 */
export function videoAnalysisBatch(connection: ExploreConnection, action: "stop" | { retry: string | true } | (StartVideoAnalysisInput & { items: Pick<VideoAnalysisBatchItem, "videoId" | "title">[] }) | null,
  signal?: AbortSignal, accountId?: string | null): Promise<VideoAnalysisBatch | null> {
  return request(connection, "batch", value => {
    if (!value || !("batch" in value)) throw new LocalCollectorError("invalid_response", "这个版本的采集器还不能批量解析，请更新应用。");
    return value.batch ?? null;
  }, action === null ? {} : action === "stop" ? { method: "DELETE" } : { method: "POST", body: JSON.stringify(action) }, signal, accountId);
}
