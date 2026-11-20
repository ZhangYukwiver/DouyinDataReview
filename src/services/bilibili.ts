import type { ExploreConnection } from "./explorer";
import { collectorFetch, LocalCollectorError } from "./localCollector";

export type BilibiliListKey = "favorites" | "history";
export const BILIBILI_LIST_LABEL: Record<BilibiliListKey, string> = { favorites: "收藏夹", history: "观看历史" };

export interface BilibiliAccount {
  platform: "bilibili";
  accountId: string;
  mid: string;
  uname: string;
  avatar: string | null;
  isLogin: boolean;
}

export interface BilibiliFolder {
  id: string;
  title: string;
  mediaCount: number;
  isDefault: boolean;
}

export interface BilibiliItem {
  platform: "bilibili";
  accountId: string;
  key: string;
  bvid: string;
  aid: string | null;
  title: string;
  author: string | null;
  authorId: string | null;
  cover: string | null;
  url: string;
  durationSeconds: number | null;
  publishedAt: string | null;
  watchedAt: string | null;
  progress: number | null;
  sources: string[];
  folderIds: string[];
  stats: { playCount: number | null; likeCount: number | null; commentCount: number | null };
  savedAt: string | null;
}

export interface BilibiliSnapshot {
  schemaVersion: 1;
  platform: "bilibili";
  account: BilibiliAccount | null;
  fetchedAt: string | null;
  folders: BilibiliFolder[];
  items: BilibiliItem[];
}

export interface BilibiliJob {
  id: string;
  accountId: string;
  type: "login" | "sync";
  state: "starting" | "login" | "syncing" | "done" | "failed" | "cancelled";
  message: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BilibiliStatus { account: BilibiliAccount | null; snapshot: BilibiliSnapshot | null; job: BilibiliJob | null }

const activeStates = new Set<BilibiliJob["state"]>(["starting", "login", "syncing"]);
export const bilibiliJobActive = (job: BilibiliJob | null | undefined) => Boolean(job && activeStates.has(job.state));

async function request<T>(connection: ExploreConnection, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await collectorFetch(connection, `/v1/bilibili${path}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init.headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new LocalCollectorError("bilibili_unreachable", "采集器暂时没有响应，请检查连接后重试。");
  }
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) {
    throw new LocalCollectorError(body?.error ?? `http_${response.status}`, body?.message ?? "B 站操作失败，请重试。");
  }
  return body as T;
}

const accountQuery = (accountId: string) => `?account=${encodeURIComponent(accountId)}`;

export const getBilibiliStatus = (connection: ExploreConnection, accountId: string, signal?: AbortSignal) =>
  request<BilibiliStatus>(connection, accountQuery(accountId), { signal });

export const startBilibiliLogin = (connection: ExploreConnection, accountId: string) =>
  request<{ job: BilibiliJob }>(connection, "/login", { method: "POST", body: JSON.stringify({ account: accountId }) });

export const startBilibiliSync = (connection: ExploreConnection, accountId: string, lists: BilibiliListKey[] = ["favorites", "history"]) =>
  request<{ job: BilibiliJob }>(connection, "/sync", { method: "POST", body: JSON.stringify({ account: accountId, lists }) });

export const cancelBilibiliJob = (connection: ExploreConnection, accountId: string, jobId: string) =>
  request<{ ok: true }>(connection, "/cancel", { method: "POST", body: JSON.stringify({ account: accountId, jobId }) });

export const logoutBilibili = (connection: ExploreConnection, accountId: string) =>
  request<{ ok: true }>(connection, "/logout", { method: "POST", body: JSON.stringify({ account: accountId }) });

export const getBilibiliFolders = (connection: ExploreConnection, accountId: string, signal?: AbortSignal) =>
  request<{ folders: BilibiliFolder[] }>(connection, `/folders${accountQuery(accountId)}`, { signal });

export const getBilibiliHistory = (connection: ExploreConnection, accountId: string, signal?: AbortSignal) =>
  request<{ items: BilibiliItem[] }>(connection, `/history${accountQuery(accountId)}`, { signal });

export const getBilibiliDetail = (connection: ExploreConnection, accountId: string, bvid: string, signal?: AbortSignal) =>
  request<BilibiliItem & { description?: string; pages?: Array<{ cid: number; part: string; durationSeconds: number | null }> }>(connection, "/detail", {
    method: "POST", body: JSON.stringify({ account: accountId, bvid }), signal,
  });

export const saveBilibiliItem = (connection: ExploreConnection, accountId: string, item: Partial<BilibiliItem> & { bvid: string }, signal?: AbortSignal) =>
  request<BilibiliItem>(connection, "/save", { method: "POST", body: JSON.stringify({ account: accountId, item }), signal });

/** Filter the local snapshot without losing the source or account metadata. */
export function filterBilibiliItems(items: readonly BilibiliItem[], query = "", source: "all" | BilibiliListKey = "all"): BilibiliItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (source === "all" || item.sources.includes(source === "favorites" ? "favorite" : "history"))
    && (!needle || [item.title, item.author, item.bvid].some(value => value?.toLocaleLowerCase().includes(needle))));
}

