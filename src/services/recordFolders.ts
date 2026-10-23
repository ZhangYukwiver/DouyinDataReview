import type { PersonalRecordType, PersonalVideoRecord } from "../domain/personalRecords";
import type { ExploreConnection } from "./explorer";
import { LocalCollectorError, collectorFetch } from "./localCollector";

// 观看历史、喜欢、收藏各有一套文件夹，存在采集器当前账号目录的 folders.json 里。
// 按视频归档（videoId，没有才用记录 id）：观看历史里同一个视频看了几次一起走；清除缓存后重新读回来，还在原来的文件夹里。
// 一个视频在一个栏目里只放一个文件夹，没放的算「未分区」。

export interface RecordFolder { id: string; name: string }
export interface RecordFolderList {
  folders: RecordFolder[];
  /** 视频键 → 文件夹 id */
  items: Record<string, string>;
}
export type RecordFolders = Record<PersonalRecordType, RecordFolderList>;

/** 筛选用的两个特殊值；文件夹 id 不含冒号，不会撞上 */
export const ALL_FOLDERS = ":all";
export const UNFILED = ":none";

export const FOLDER_NAME_MAX = 20;
// 和采集器的上限一致
export const FOLDERS_MAX = 200;

const TYPES: PersonalRecordType[] = ["watch_history", "liked_videos", "favorite_videos"];

export function emptyRecordFolders(): RecordFolders {
  return { watch_history: { folders: [], items: {} }, liked_videos: { folders: [], items: {} }, favorite_videos: { folders: [], items: {} } };
}

export const folderKey = (record: PersonalVideoRecord): string => record.videoId || record.id;

export const newFolderId = (): string => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 这条记录在哪个文件夹；文件夹已经删了的旧归档当没放 */
export function folderOf(list: RecordFolderList, record: PersonalVideoRecord): RecordFolder | null {
  const id = list.items[folderKey(record)];
  return id ? list.folders.find((folder) => folder.id === id) ?? null : null;
}

/** keep 里的视频键照样留在结果里：在文件夹里把一条移走，它先原地待着，换了筛选再消失，免得后面的卡片整排错位重画 */
export function filterByFolder(records: PersonalVideoRecord[], list: RecordFolderList, filter: string, keep?: ReadonlySet<string>): PersonalVideoRecord[] {
  if (filter === ALL_FOLDERS) return records;
  const known = new Set(list.folders.map((folder) => folder.id));
  return records.filter((record) => {
    const key = folderKey(record);
    const id = list.items[key];
    const filed = id !== undefined && known.has(id) ? id : UNFILED;
    return filed === filter || Boolean(keep?.has(key));
  });
}

/** 每个文件夹（和「未分区」）里有几条：按记录条数算，和「全部」的条数口径一样 */
export function countByFolder(records: PersonalVideoRecord[], list: RecordFolderList): Map<string, number> {
  const known = new Set(list.folders.map((folder) => folder.id));
  const counts = new Map<string, number>();
  for (const record of records) {
    const id = list.items[folderKey(record)];
    const filed = id !== undefined && known.has(id) ? id : UNFILED;
    counts.set(filed, (counts.get(filed) ?? 0) + 1);
  }
  return counts;
}

/** 名字不行就返回原因，行就返回 null；改名时传自己的 id，和原名一样不算重名 */
export function folderNameProblem(list: RecordFolderList, name: string, renaming?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "给文件夹起个名字。";
  if (Array.from(trimmed).length > FOLDER_NAME_MAX) return `名字最多 ${FOLDER_NAME_MAX} 个字。`;
  const lower = trimmed.toLowerCase();
  if (list.folders.some((folder) => folder.id !== renaming && folder.name.toLowerCase() === lower)) return "已经有同名的文件夹了。";
  if (!renaming && list.folders.length >= FOLDERS_MAX) return `最多建 ${FOLDERS_MAX} 个文件夹。`;
  return null;
}

export function addFolder(list: RecordFolderList, name: string, id = newFolderId()): RecordFolderList {
  return { ...list, folders: [...list.folders, { id, name: name.trim() }] };
}

export function renameFolder(list: RecordFolderList, id: string, name: string): RecordFolderList {
  return { ...list, folders: list.folders.map((folder) => (folder.id === id ? { ...folder, name: name.trim() } : folder)) };
}

/** 删文件夹：里面的视频回到未分区，视频本身不动 */
export function removeFolder(list: RecordFolderList, id: string): RecordFolderList {
  return {
    folders: list.folders.filter((folder) => folder.id !== id),
    items: Object.fromEntries(Object.entries(list.items).filter(([, folder]) => folder !== id)),
  };
}

/** folderId 为 null 是移回未分区 */
export function moveToFolder(list: RecordFolderList, records: PersonalVideoRecord[], folderId: string | null): RecordFolderList {
  const items = { ...list.items };
  for (const record of records) {
    if (folderId) items[folderKey(record)] = folderId;
    else delete items[folderKey(record)];
  }
  return { ...list, items };
}

function normalize(value: unknown): RecordFolders {
  const lists = emptyRecordFolders();
  const source = value && typeof value === "object" ? (value as { lists?: unknown }).lists : null;
  if (!source || typeof source !== "object") return lists;
  for (const type of TYPES) {
    const list = (source as Record<string, unknown>)[type] as Partial<RecordFolderList> | undefined;
    if (!list || typeof list !== "object") continue;
    lists[type] = {
      folders: Array.isArray(list.folders) ? list.folders.filter((folder) => typeof folder?.id === "string" && typeof folder?.name === "string") : [],
      items: list.items && typeof list.items === "object" ? list.items : {},
    };
  }
  return lists;
}

async function request(connection: ExploreConnection, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await collectorFetch(connection, path, { ...init, headers: { "Content-Type": "application/json" } });
  } catch {
    throw new LocalCollectorError("folders_unreachable", init.method === "POST" ? "连不上本地采集器，文件夹没存上。" : "连不上本地采集器，文件夹没读到。");
  }
}

/** 采集器太旧、还不认识文件夹时返回 null，界面就不显示文件夹 */
export async function readRecordFolders(connection: ExploreConnection): Promise<RecordFolders | null> {
  const response = await request(connection, "/v1/folders");
  if (response.status === 404) return null;
  const value = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) throw new LocalCollectorError(value?.error ?? "folders_failed", value?.message ?? "文件夹没读到，请稍后再试。");
  return normalize(value);
}

export async function saveRecordFolders(connection: ExploreConnection, accountId: string | undefined, lists: RecordFolders): Promise<void> {
  const path = accountId ? `/v1/folders?account=${encodeURIComponent(accountId)}` : "/v1/folders";
  const response = await request(connection, path, { method: "POST", body: JSON.stringify({ lists }) });
  if (response.ok) return;
  const value = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  throw new LocalCollectorError(value?.error ?? "folders_save_failed", value?.message ?? "文件夹没存上，请稍后再试。");
}
