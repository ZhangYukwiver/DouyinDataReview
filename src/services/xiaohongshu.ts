import type { ExploreConnection } from "./explorer";
import { collectorFetch, LocalCollectorError } from "./localCollector";

// 小红书导出：采集器在本机用无头浏览器登录和读取，这里只发指令、轮询进度、取看板数据。见 collector/xiaohongshu.mjs

export type XhsListKey = "favorites" | "likes";
export type XhsConnection = ExploreConnection & { accountId?: string };
export const XHS_LIST_LABEL: Record<XhsListKey, string> = { favorites: "收藏", likes: "点赞" };

export interface XhsJob {
  id: string;
  lists: XhsListKey[];
  state: "starting" | "login" | "reading" | "done" | "failed" | "cancelled";
  message: string;
  qr: string | null;
  progress: { done: number; total: number } | null;
  account: XhsAccount | null;
  file: string | null;
}
export interface XhsAccount { user_id: string; nickname: string }
export interface XhsNote {
  note_id: string; title?: string; type?: string; author?: string; author_id?: string; cover?: string | null;
  body?: string | null; url: string; liked_by_account?: boolean; liked_count?: string | number;
}
export interface XhsExport { exported_at: string; account: XhsAccount; lists: Partial<Record<XhsListKey, { exported_at: string; notes: XhsNote[] }>> }

export const xhsJobActive = (job: XhsJob | null | undefined) => !!job && ["starting", "login", "reading"].includes(job.state);

async function request<T>(connection: XhsConnection, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    const scope = connection.accountId ? "?accountId=" + encodeURIComponent(connection.accountId) : "";
    response = await collectorFetch(connection, `/v1/xiaohongshu${path}${scope}`, {
      ...init, headers: init.body ? { "Content-Type": "application/json" } : undefined, signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new LocalCollectorError("xiaohongshu_unreachable", "采集器暂时没有响应，请检查连接后重试。");
  }
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) {
    if (response.status === 404) throw new LocalCollectorError("not_found", "这个版本的采集器还不能导出小红书，请更新应用。");
    if (body?.error === "loopback_only") throw new LocalCollectorError("loopback_only", "小红书导出只能在运行采集器的这台电脑上用。");
    throw new LocalCollectorError(body?.error ?? `http_${response.status}`, body?.message ?? "小红书接口暂时不可用，请重试。");
  }
  return body as T;
}

export const getXhsStatus = (connection: ExploreConnection, signal?: AbortSignal) =>
  request<{ job: XhsJob | null; account: (XhsAccount & { checked_at?: string }) | null }>(connection, "", { signal });
export const getXhsLatest = (connection: ExploreConnection, signal?: AbortSignal) =>
  request<{ latest: XhsExport | null }>(connection, "/latest", { signal }).then(reply => reply.latest);
export const startXhsLogin = (connection: ExploreConnection) => request<{ job: XhsJob }>(connection, "/login", { method: "POST" });
export const startXhsExport = (connection: ExploreConnection, lists: XhsListKey[]) =>
  request<{ job: XhsJob }>(connection, "/export", { method: "POST", body: JSON.stringify({ lists }) });
/** 推荐、搜索、主页里的一张笔记卡片 */
export interface XhsCard { note_id: string; title?: string; type?: string | null; author?: string | null; author_url?: string | null; cover?: string | null; liked_count?: string | number | null; url: string }
export interface XhsDetail { note_id: string; url: string; title: string; body: string; author: string | null; author_url: string | null; liked_count: string | null; collected_count: string | null; comment_count: string | null }
export interface XhsComment { comment_id: string; content: string; author?: string; liked_count?: string | number; create_time?: number; reply_count?: string | number }
export interface XhsProfile { user_id: string; nickname: string; description: string; stats: Array<{ label: string; value: string | null }>; has_more?: boolean; notes: XhsCard[] }
interface XhsReads {
  feed: [Record<string, never>, { notes: XhsCard[] }];
  search: [{ keyword: string }, { keyword: string; has_more?: boolean; notes: XhsCard[] }];
  detail: [{ url: string }, XhsDetail];
  comments: [{ url: string }, { note_id: string; has_more?: boolean; comments: XhsComment[] }];
  profile: [{ url?: string }, XhsProfile];
}
/** 每次读取采集器都要开一次无头浏览器，几秒到十几秒 */
export const readXhs = <K extends keyof XhsReads>(connection: ExploreConnection, action: K, body: XhsReads[K][0], signal?: AbortSignal) =>
  request<XhsReads[K][1]>(connection, `/${action}`, { method: "POST", body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(90_000) });
export const cancelXhs = (connection: ExploreConnection) => request<{ ok: true }>(connection, "/cancel", { method: "POST" });
export const logoutXhs = (connection: ExploreConnection) => request<{ ok: true }>(connection, "/logout", { method: "POST" });

/** 「1.2万」「3456」「10w+」这类赞数转成数字，认不出当 0 */
export function parseCount(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  const match = /^([\d.]+)\s*([万wW千kK])?/u.exec(value?.trim() ?? "");
  if (!match) return 0;
  const unit = match[2] ? ("万wW".includes(match[2]) ? 10_000 : 1_000) : 1;
  return Math.round(Number(match[1]) * unit) || 0;
}

/** 正文里的 #话题（网页正文里话题写成「#旅行攻略」，原始数据里可能带「[话题]」后缀） */
export function noteTags(body: string | null | undefined): string[] {
  const tags = new Set<string>();
  for (const match of (body ?? "").matchAll(/#([^\s#[\]]{1,30})/gu)) tags.add(match[1]!);
  return [...tags];
}

export interface XhsDashboard {
  notes: Array<XhsNote & { in: XhsListKey[] }>;
  counts: Record<XhsListKey, number>;
  both: number;
  video: number;
  authors: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
  hottest: Array<XhsNote & { in: XhsListKey[] }>;
}

/** 看板用的汇总：两类按笔记合并去重，作者和话题按出现篇数排 */
export function summarizeXhs(data: XhsExport): XhsDashboard {
  const byId = new Map<string, XhsNote & { in: XhsListKey[] }>();
  const counts = { favorites: 0, likes: 0 };
  for (const key of ["favorites", "likes"] as const) {
    for (const note of data.lists[key]?.notes ?? []) {
      counts[key] += 1;
      const seen = byId.get(note.note_id);
      if (seen) { seen.in.push(key); if (!seen.body && note.body) seen.body = note.body; }
      else byId.set(note.note_id, { ...note, in: [key] });
    }
  }
  const notes = [...byId.values()];
  const rank = (names: string[]) => {
    const tally = new Map<string, number>();
    for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
    return [...tally].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10);
  };
  return {
    notes, counts,
    both: notes.filter(note => note.in.length > 1).length,
    video: notes.filter(note => note.type === "video").length,
    authors: rank(notes.flatMap(note => (note.author ? [note.author] : []))),
    tags: rank(notes.flatMap(note => noteTags(note.body))),
    hottest: [...notes].sort((a, b) => parseCount(b.liked_count) - parseCount(a.liked_count)).slice(0, 5),
  };
}
