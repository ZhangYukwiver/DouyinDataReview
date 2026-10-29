import { createEmptyPersonalRecords, PERSONAL_RECORD_TYPES, type PersonalRecordCollection, type PersonalRecordType } from "../domain/personalRecords";
import { estimateWatchProgress } from "../domain/watchProgress";
import { parsePage, type ProofRecord, type ProofSnapshot } from "./proofData";

export const COLLECTION_TYPES = PERSONAL_RECORD_TYPES.map(item => ({ ...item,
  label: item.id === "liked_videos" ? "喜欢" : item.id === "favorite_videos" ? "收藏" : item.label,
}));
export const MAX_COLLECTION_BYTES = 50_000_000;
export const MAX_RECORDS_PER_TYPE = 50_000;
export interface MobileRecord extends ProofRecord {
  authorId: string | null;
  topics: string[];
  durationSeconds: number | null;
  music: { title: string; author: string } | null;
  coverUrl?: string | null;
  publishedAt?: string | null;
  mediaType?: "video" | "image" | "live" | "unknown";
  stats?: { diggCount?: number | null; commentCount?: number | null; shareCount?: number | null; collectCount?: number | null };
  watchProgress?: { watchedSeconds?: number | null; percent?: number | null };
}
export interface CollectionProgress {
  records: MobileRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  pages: number;
  updatedAt: string | null;
  incrementalReady?: boolean;
}
export interface MobileSnapshot {
  version: 2;
  revision: number;
  savedAt: string;
  account: ProofSnapshot["account"];
  collections: Record<PersonalRecordType, CollectionProgress>;
}
export interface CollectionPage {
  account: ProofSnapshot["account"];
  recordType: PersonalRecordType;
  cursor: string;
  nextCursor: string | null;
  hasMore: boolean;
  records: MobileRecord[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("记录格式无效，已有数据已保留。");
  return value as Record<string, unknown>;
}
function cursor(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) throw new Error("分页位置无效，请从头采集。");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || value.length > 30 || !Number.isFinite(Date.parse(value))) throw new Error("保存时间无效。");
  return value;
}
function shortText(value: unknown, limit = 100): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function imageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["douyin.com", "douyinpic.com", "douyinvod.com", "byteimg.com", "ibytedtos.com", "snssdk.com"]
        .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? value : null;
  } catch { return null; }
}
function number(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
function record(value: unknown, account: ProofSnapshot["account"], type: PersonalRecordType): MobileRecord {
  const row = object(value);
  const base = parsePage({ account, records: [row], hasMore: false }).records[0]!;
  const music = row.music && typeof row.music === "object" ? object(row.music) : null;
  const stats = row.stats && typeof row.stats === "object" ? object(row.stats) : {};
  const progress = row.watchProgress && typeof row.watchProgress === "object" ? object(row.watchProgress) : {};
  return { ...base, watchedAt: type === "watch_history" ? base.watchedAt : null,
    authorId: typeof row.authorId === "string" && /^[1-9]\d{0,29}$/u.test(row.authorId) ? row.authorId : null,
    topics: Array.isArray(row.topics) ? [...new Set(row.topics.filter((item): item is string => typeof item === "string")
      .map(item => item.trim().slice(0, 100)).filter(Boolean))].slice(0, 30) : [],
    durationSeconds: typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds)
      && row.durationSeconds > 0 && row.durationSeconds <= 86400 ? row.durationSeconds : null,
    music: music && shortText(music.title) ? { title: shortText(music.title), author: shortText(music.author) } : null,
    coverUrl: imageUrl(row.coverUrl),
    publishedAt: typeof row.publishedAt === "string" && Number.isFinite(Date.parse(row.publishedAt)) ? row.publishedAt : null,
    mediaType: ["video", "image", "live"].includes(String(row.mediaType)) ? row.mediaType as MobileRecord["mediaType"] : "unknown",
    stats: { diggCount: number(stats.diggCount, Number.MAX_SAFE_INTEGER), commentCount: number(stats.commentCount, Number.MAX_SAFE_INTEGER),
      shareCount: number(stats.shareCount, Number.MAX_SAFE_INTEGER), collectCount: number(stats.collectCount, Number.MAX_SAFE_INTEGER) },
    watchProgress: { watchedSeconds: number(progress.watchedSeconds, 86400), percent: number(progress.percent, 100) },
  };
}
export function parseCollectionPage(value: unknown): CollectionPage {
  const input = object(value);
  const base = parsePage(input);
  const type = COLLECTION_TYPES.find(item => item.id === input.recordType)?.id;
  if (!type) throw new Error("采集类型无效。");
  const current = cursor(input.cursor);
  const next = base.hasMore ? cursor(input.nextCursor) : null;
  if (base.hasMore && current === next) throw new Error("平台返回重复分页，已停止；已保存的记录仍可查看。");
  return { account: base.account, recordType: type, cursor: current, nextCursor: next, hasMore: base.hasMore,
    records: (input.records as unknown[]).map(item => record(item, base.account, type)) };
}
export function emptyCollections(): MobileSnapshot["collections"] {
  const empty = (): CollectionProgress => ({ records: [], nextCursor: null, hasMore: true, pages: 0, updatedAt: null, incrementalReady: false });
  return { watch_history: empty(), liked_videos: empty(), favorite_videos: empty() };
}
export function migrateProof(previous: ProofSnapshot): MobileSnapshot {
  const collections = emptyCollections();
  collections.watch_history = { records: previous.records.map(item => record(item, previous.account, "watch_history")),
    nextCursor: null, hasMore: previous.hasMore, pages: 1, updatedAt: previous.savedAt, incrementalReady: false };
  return { version: 2, revision: 1, savedAt: previous.savedAt, account: previous.account, collections };
}
export function parseMobileSnapshot(raw: string): MobileSnapshot {
  if (raw.length > MAX_COLLECTION_BYTES) throw new Error("本机记录超过容量限制。");
  const input = object(JSON.parse(raw));
  if (input.version !== 2 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new Error("本机数据版本无效。");
  const account = parsePage({ account: input.account, records: [], hasMore: false }).account;
  const source = object(input.collections);
  const collections = emptyCollections();
  for (const { id } of COLLECTION_TYPES) {
    const item = object(source[id]);
    if (!Array.isArray(item.records) || item.records.length > MAX_RECORDS_PER_TYPE || typeof item.hasMore !== "boolean"
      || !Number.isSafeInteger(item.pages) || Number(item.pages) < 0) throw new Error("本机采集记录无效。");
    collections[id] = { records: item.records.map(row => record(row, account, id)),
      nextCursor: item.nextCursor === null ? null : cursor(item.nextCursor), hasMore: item.hasMore,
      pages: Number(item.pages), updatedAt: item.updatedAt === null ? null : date(item.updatedAt),
      incrementalReady: typeof item.incrementalReady === "boolean" ? item.incrementalReady : !item.hasMore && Boolean(item.updatedAt) };
  }
  return { version: 2, revision: Number(input.revision), savedAt: date(input.savedAt), account, collections };
}
export function mergeCollectionPage(previous: MobileSnapshot | null, page: CollectionPage, now = new Date().toISOString()): MobileSnapshot {
  if (previous && previous.account.id !== page.account.id) throw new Error("当前登录账号与本机记录不同，请登录原账号后采集。已有记录已保留。");
  const collections = { ...(previous?.collections ?? emptyCollections()) };
  const old = collections[page.recordType];
  const key = (item: MobileRecord) => page.recordType === "watch_history" ? `${item.id}:${item.watchedAt ?? "unknown"}` : item.id;
  const records = new Map(old.records.map(item => [key(item), item]));
  for (const item of page.records) {
    if (page.recordType === "watch_history") {
      if (item.watchedAt) records.delete(`${item.id}:unknown`);
      else if ([...records.values()].some(existing => existing.id === item.id && existing.watchedAt)) continue;
    }
    const existing = records.get(key(item));
    records.set(key(item), { ...item, topics: item.topics.length ? item.topics : existing?.topics ?? [],
      music: item.music ?? existing?.music ?? null, durationSeconds: item.durationSeconds ?? existing?.durationSeconds ?? null,
      coverUrl: item.coverUrl ?? existing?.coverUrl ?? null, publishedAt: item.publishedAt ?? existing?.publishedAt ?? null });
  }
  if (records.size > MAX_RECORDS_PER_TYPE) throw new Error("此类记录已达 5 万条上限，已保存的数据仍可查看和导出。");
  collections[page.recordType] = { records: [...records.values()], nextCursor: page.nextCursor, hasMore: page.hasMore,
    pages: (page.cursor === "0" ? 0 : old.pages) + 1, updatedAt: now, incrementalReady: false };
  return { version: 2, revision: (previous?.revision ?? 0) + 1, savedAt: now, account: page.account, collections };
}
export function personalRecords(snapshot: MobileSnapshot): PersonalRecordCollection {
  const result = createEmptyPersonalRecords();
  for (const { id: type } of COLLECTION_TYPES) result[type] = snapshot.collections[type].records.map(item => ({
    id: type === "watch_history" && item.watchedAt ? `${type}:${item.id}:${item.watchedAt}` : `${type}:${item.id}`,
    videoId: item.id, title: item.title, author: item.author, authorId: item.authorId,
    occurredAt: item.watchedAt, occurredAtSource: item.watchedAt ? "platform_action" : "unknown",
    url: `https://www.douyin.com/video/${item.id}`, topics: item.topics, music: item.music, durationSeconds: item.durationSeconds,
    coverUrl: item.coverUrl, publishedAt: item.publishedAt, mediaType: item.mediaType, stats: item.stats,
    // an empty {null, null} would read as "progress known" and stop the estimate below
    watchProgress: item.watchProgress?.watchedSeconds != null || item.watchProgress?.percent != null ? item.watchProgress : null,
  }));
  // The API rarely carries progress; like the desktop app, time each viewing from the next one.
  estimateWatchProgress(result.watch_history);
  return result;
}
