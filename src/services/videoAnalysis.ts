import type { AssistantConfig } from "./assistant";
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

async function request<T>(connection: ExploreConnection, videoId: string, read: (value: Partial<VideoAnalysisResponse> & { notes?: SavedVideoNote[] } | null) => T, init: RequestInit, signal?: AbortSignal, accountId?: string | null): Promise<T> {
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
