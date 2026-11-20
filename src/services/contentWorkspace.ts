import type { ExploreConnection } from "./explorer";
import { collectorFetch } from "./localCollector";

export const platformLabels = { douyin: "抖音", xiaohongshu: "小红书", bilibili: "B 站" } as const;
export type ContentPlatform = keyof typeof platformLabels;
export type PlatformAccount = {
  id: string; uid: string | null; nickname: string | null; avatar: string | null;
  note: string | null; loggedIn: boolean; lastSyncedAt: string | null;
};
export type AccountGroup = { activeId: string | null; accounts: PlatformAccount[] };
export type PlatformDirectory = Record<ContentPlatform, AccountGroup>;
export const accountLabel = (a: PlatformAccount) => a.note || a.nickname || (a.uid ? `用户 ${a.uid}` : a.id === "default" ? "默认账号" : `账号 ${a.id.slice(-4)}`);
export function accountChoiceLabel(account: PlatformAccount, group: PlatformAccount[]) {
  const name = accountLabel(account);
  return group.some(other => other.id !== account.id && accountLabel(other) === name)
    ? `${name} · ${account.uid || account.id}` : name;
}

export const signalLabels = { watched: "看过", liked: "喜欢", favorited: "收藏", saved: "手动保存" } as const;
export type LibrarySignal = keyof typeof signalLabels;
export type LibraryItem = {
  key: string; platform: ContentPlatform; contentId: string; title: string; author: string | null; url: string | null;
  body?: string | null; coverUrl?: string | null; contentType?: string; mediaType?: string; snippet?: string | null;
  materials?: { kind: string; title: string | null; text: string }[];
  sourceAccounts: { accountId: string; accountName?: string | null; signals: string[] }[];
};
export type LibraryTopic = { id: string; name: string; items: string[] };
export type LibraryAnswer = { answer: string; sources: { entryKey: string; platform: ContentPlatform; title: string; url: string | null; quote: string; citation: string }[] };

export type ManualContent = Pick<LibraryItem, "platform" | "contentId" | "title" | "author" | "url"> & {
  accountId: string; body?: string | null; coverUrl?: string | null; mediaType?: string | null;
};

export async function workspaceRequest<T>(connection: ExploreConnection, path: string, options: {
  method?: string; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await collectorFetch(connection, path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    ...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }),
    signal: options.signal,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.message || (response.status === 401 ? "请重新连接本机采集器。" : "工作台读取失败，请重试。"));
  return value as T;
}

export type LibraryFilter = { platform: ContentPlatform | ""; accountId: string };
const FILTER_KEY = "content-workspace.library-filter.v1";
export function loadLibraryFilter(): LibraryFilter {
  try {
    const value = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
    if (value && Object.hasOwn(platformLabels, value.platform) && typeof value.accountId === "string") return value;
  } catch { /* 浏览器未开放本地存储时仍能浏览。 */ }
  return { platform: "", accountId: "" };
}
export function saveLibraryFilter(value: LibraryFilter) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(value)); } catch { /* 仅当前会话保留筛选。 */ }
}
