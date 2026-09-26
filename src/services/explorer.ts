import type { PersonalVideoRecord } from "../domain/personalRecords";
import { LocalCollectorError, normalizeCollectorBaseUrl } from "./localCollector";

export interface ExploreUser {
  id: string; name: string; handle: string; bio: string; avatar: string | null; url: string;
  followers: number | null; following: number | null; likes: number | null; posts: number | null; followed: boolean | null;
}
export interface ExploreVideo extends PersonalVideoRecord {
  authorProfile: ExploreUser | null; liked: boolean | null; collected: boolean | null; images: string[];
}
export interface ExploreComment {
  id: string; text: string; name: string; author: ExploreUser | null; likes: number | null; replies: number; publishedAt: string | null;
  images?: string[];
  parentId?: string | null; replyToName?: string | null;
}
/** Someone in the site's "分享给朋友" list; groups share the same id space as people. */
export interface ExploreSharee { id: string; name: string; avatar: string | null; group: boolean | null; shared: boolean }
export type ExploreKind = "users" | "videos" | "profile" | "detail" | "comments" | "replies" | "sharees";
export interface ExploreQuery { kind: ExploreKind; query?: string; id?: string; sessionId?: string; commentId?: string }
export interface ExplorePage {
  sessionId: string; kind: ExploreKind; items: Array<ExploreUser | ExploreVideo | ExploreComment | ExploreSharee>;
  profile: ExploreUser | null; video: ExploreVideo | null; hasMore: boolean | null; limited: boolean;
  commentId?: string;
}
export interface ExploreAction {
  sessionId: string; requestId: string; action: "like" | "collect" | "follow" | "comment" | "share"; desired?: boolean; text?: string;
  replyTo?: string; targetId?: string;
}
export interface ExploreOutcome { outcome: "confirmed" | "unknown" | "rejected"; value?: boolean; message: string; comment?: ExploreComment }
export interface ExploreConnection { baseUrl: string; token: string }

async function request(connection: ExploreConnection, route: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, route === "read" ? 50000 : 55000);
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}/v1/explore/${route}`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new LocalCollectorError(value.error ?? "explore_failed", value.message ?? (response.status === 401 ? "连接已过期，请重新连接采集器。" : response.status === 404 ? "当前采集器尚未加载探索模块，请重启应用或本地采集服务。" : "探索请求失败，请重试。"));
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("explore_unreachable", route === "interact"
      ? "未能收到操作结果，请在抖音原页核验后再操作。" : "读取超时或服务未连接，请检查采集器连接。");
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
export async function readExplore(connection: ExploreConnection, query: ExploreQuery, signal?: AbortSignal): Promise<ExplorePage> {
  const result = await request(connection, "read", query, signal) as ExplorePage;
  if (!result || typeof result.sessionId !== "string" || result.kind !== query.kind || !Array.isArray(result.items) ||
    (query.kind === "replies" && (result.commentId !== query.commentId || result.sessionId !== query.sessionId)))
    throw new LocalCollectorError("invalid_response", "探索数据格式无效，请更新采集器。");
  return result;
}
export async function interactExplore(connection: ExploreConnection, action: ExploreAction): Promise<ExploreOutcome> {
  const result = await request(connection, "interact", action) as ExploreOutcome;
  if (!result || !["confirmed", "unknown", "rejected"].includes(result.outcome))
    throw new LocalCollectorError("invalid_response", "操作结果待核验，请查看抖音原页。");
  return result;
}

export async function closeExplore(connection: ExploreConnection, sessionIds: string[]): Promise<void> {
  await request(connection, "close", { sessionIds });
}

export async function loadExploreVideo(connection: ExploreConnection, sessionId: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}/v1/explore/video`, {
    method: "POST", signal, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new LocalCollectorError(value?.error ?? "playback_failed", value?.message ?? "播放准备失败，请重新打开作品或在抖音原页播放。");
  }
  const video = await response.blob();
  signal.throwIfAborted();
  return video;
}
