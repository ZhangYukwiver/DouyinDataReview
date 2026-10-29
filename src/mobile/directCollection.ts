import { nativeSignedUrl } from "../../collector/nativeSignature.mjs";
import type { PersonalRecordType } from "../domain/personalRecords";
import { COLLECTION_TYPES, parseCollectionPage, type CollectionPage, type MobileRecord, type MobileSnapshot } from "./collectionData";
import { nativeBridge } from "./nativeBridge";

const paths = { watch_history: "/aweme/v1/web/history/read/", liked_videos: "/aweme/v1/web/aweme/favorite/", favorite_videos: "/aweme/v1/web/aweme/listcollection/" };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("format");
  return value as Record<string, any>;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric < 1e10 ? numeric * 1000 : numeric) : new Date(String(value));
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100 ? date.toISOString() : null;
}
function bounded(value: unknown, max = 86400): number | null {
  const numeric = value == null ? NaN : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= max ? numeric : null;
}
export function normalizeDirectPage(raw: unknown, account: CollectionPage["account"], type: PersonalRecordType, cursor: string): CollectionPage {
  const response = object(raw), data = Array.isArray(response.aweme_list) ? response : object(response.data);
  if (!Array.isArray(data.aweme_list) || ![0, 1, false, true, "0", "1"].includes(data.has_more)) throw new Error("format");
  return parseCollectionPage({ account, recordType: type, cursor, hasMore: [1, "1", true].includes(data.has_more),
    nextCursor: String(data[type === "favorite_videos" ? "cursor" : "max_cursor"] ?? response[type === "favorite_videos" ? "cursor" : "max_cursor"] ?? ""),
    records: data.aweme_list.map((item: Record<string, any>) => {
      const id = String(item.aweme_id ?? ""), history = item.history_info ?? {};
      const watchedAt = type === "watch_history" ? [(data.aweme_date ?? response.aweme_date ?? {})[id], history.view_time, history.watch_time,
        history.history_time, item.view_time, item.watch_time, item.history_time, item.last_view_time].map(timestamp).find(Boolean) ?? null : null;
      const title = String(item.desc || item.caption || "未命名作品").slice(0, 500);
      const duration = bounded(Number(item.video?.duration ?? item.duration) / 1000);
      // same fields as the desktop normalizer (collector/normalizer.mjs normalizeProgress)
      const playback = item.play_progress && typeof item.play_progress === "object" ? item.play_progress : {};
      const watched = bounded(Number(history.watched_duration ?? history.watch_duration ?? history.view_duration ?? playback.play_progress) / 1000);
      const percent = bounded(history.play_progress ?? history.progress ?? history.percent ?? history.watch_percent, 100)
        ?? (watched !== null && duration ? Math.min(100, watched / duration * 100) : null);
      const tags = [...(Array.isArray(item.cha_list) ? item.cha_list.map((row: any) => row?.cha_name) : []),
        ...(Array.isArray(item.text_extra) ? item.text_extra.map((row: any) => row?.hashtag_name) : []), ...(title.match(/#[^\s#]+/gu) ?? []).map(tag => tag.slice(1))];
      return { id, title, author: String(item.author?.nickname ?? "未知作者").slice(0, 100), authorId: String(item.author?.uid ?? ""), watchedAt,
        durationSeconds: duration, topics: tags, music: item.music?.title ? { title: String(item.music.title), author: String(item.music.author ?? "") } : null,
        coverUrl: (item.video?.cover ?? item.video?.origin_cover ?? item.cover)?.url_list?.[0] ?? null,
        publishedAt: timestamp(item.create_time), mediaType: item.images?.length ? "image" : item.video ? "video" : "unknown",
        stats: { diggCount: bounded(item.statistics?.digg_count, Number.MAX_SAFE_INTEGER), commentCount: bounded(item.statistics?.comment_count, Number.MAX_SAFE_INTEGER),
          shareCount: bounded(item.statistics?.share_count, Number.MAX_SAFE_INTEGER), collectCount: bounded(item.statistics?.collect_count, Number.MAX_SAFE_INTEGER) },
        watchProgress: { watchedSeconds: watched, percent },
      };
    }) });
}
export const recordKey = (type: PersonalRecordType, item: MobileRecord) => type === "watch_history" ? `${item.id}:${item.watchedAt ?? "unknown"}` : item.id;
export function reachesKnownPage(type: PersonalRecordType, page: CollectionPage, known: ReadonlySet<string>): boolean {
  return page.records.some(item => known.has(recordKey(type, item)));
}
export function directErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/u.test(message)) return "采集已停止，已读取的记录保留。下次会补齐未完成的部分。";
  if (/context_missing|login|verification/u.test(message)) return "登录状态需要刷新或平台要求验证，请点「登录 / 验证」完成后再采集。";
  if (/account/u.test(message)) return "当前网页登录账号与本机记录不同，请登录原账号；已有记录已保留。";
  if (/limited/u.test(message)) return "平台暂时限制读取，已停止，请稍后再试。";
  if (/format|pagination/u.test(message)) return "接口返回的记录或分页格式异常，已停止，已有记录保留。";
  if (/rejected/u.test(message)) return "平台拒绝了本次请求，请在「登录 / 验证」检查提示后重试。";
  return "采集未完成，请检查网络或登录状态后重试；已经保存的内容仍可查看。";
}
async function request(path: string, query: Record<string, string> = {}, body: string | null = null): Promise<Record<string, any>> {
  const prepared = await nativeBridge.prepare(path, JSON.stringify(query));
  const signed = nativeSignedUrl(prepared.url, { userAgent: prepared.userAgent, body: body ?? "" });
  const raw = await nativeBridge.request(signed, body);
  let result: Record<string, any>;
  try { result = object(JSON.parse(raw)); } catch { throw new Error(raw.trim() === "blocked" ? "verification" : "format"); }
  if ([result.search_nil_info?.search_nil_type, result.search_nil_info?.search_nil_item].includes("verify_check")) throw new Error("verification");
  if ([8, 2190008, 10008].includes(Number(result.status_code))) throw new Error("login");
  if (result.status_code !== undefined && result.status_code !== 0) throw new Error("rejected");
  return result;
}
async function identity(expectedId?: string) {
  const data = await request("/aweme/v1/web/user/profile/self/");
  const user = data.user ?? data.data?.user;
  if (!user || !/^[1-9]\d{0,29}$/u.test(String(user.uid))) throw new Error("login");
  if (expectedId && String(user.uid) !== expectedId) throw new Error("account");
  return { id: String(user.uid), nickname: String(user.nickname ?? "抖音用户").slice(0, 100), secUid: String(user.sec_uid ?? "") };
}
interface SyncHandlers {
  getSnapshot: () => MobileSnapshot | null;
  savePage: (page: CollectionPage) => Promise<unknown>;
  saveState: (snapshot: MobileSnapshot) => Promise<void>;
  progress: (message: string) => void;
}
// Matching the desktop boundary: a completed baseline can stop at known events.
// Mark it incomplete before saving any new page, so interruption cannot hide an unsaved gap.
export async function syncAllContent(mode: "incremental" | "full", signal: AbortSignal, handlers: SyncHandlers): Promise<Record<PersonalRecordType, number>> {
  const check = () => { if (signal.aborted) throw new Error("cancelled"); };
  const added = { watch_history: 0, liked_videos: 0, favorite_videos: 0 };
  check();
  const account = await identity(handlers.getSnapshot()?.account.id);
  for (const { id: type, label } of COLLECTION_TYPES) {
    check();
    const before = handlers.getSnapshot();
    const old = before?.collections[type];
    const incremental = mode === "incremental" && old?.incrementalReady === true;
    const known = new Set((incremental ? old.records : []).map(item => recordKey(type, item)));
    const original = new Set((old?.records ?? []).map(item => recordKey(type, item)));
    const discovered = new Set<string>();
    if (before) await handlers.saveState({ ...before, collections: { ...before.collections,
      [type]: { ...old!, incrementalReady: false, hasMore: true, nextCursor: "0" } } });
    let cursor = "0", pages = 0;
    const cursors = new Set<string>();
    while (true) {
      check();
      if (cursors.has(cursor) || pages >= 5000) throw new Error("pagination");
      cursors.add(cursor);
      handlers.progress(`正在${incremental ? "增量" : "完整"}采集${label} · 第 ${pages + 1} 页 · 新增 ${added[type]} 条`);
      const query: Record<string, string> = type === "watch_history" ? { count: "20", max_cursor: cursor, directory: "0", category: "0", status: "-1" }
        : type === "liked_videos" ? { sec_user_id: account.secUid, count: "18", max_cursor: cursor, min_cursor: "0", whale_cut_token: "", cut_version: "1", publish_video_strategy_type: "2" }
        : { publish_video_strategy_type: "2" };
      if (type === "liked_videos" && !/^MS4w[\w-]{10,200}$/u.test(account.secUid)) throw new Error("format");
      const raw = await request(paths[type], query, type === "favorite_videos" ? `count=10&cursor=${cursor}` : null);
      check();
      const verified = await request("/aweme/v1/web/query/user/", { publish_video_strategy_type: "2" });
      if (String(verified.user_uid) !== account.id) throw new Error("account");
      check();
      const page = normalizeDirectPage(raw, { id: account.id, nickname: account.nickname }, type, cursor);
      if (page.hasMore && cursors.has(page.nextCursor!)) throw new Error("pagination");
      for (const item of page.records) { const key = recordKey(type, item); if (!original.has(key)) discovered.add(key); }
      await handlers.savePage(page);
      pages++; added[type] = discovered.size;
      const complete = !page.hasMore || incremental && reachesKnownPage(type, page, known);
      if (complete) {
        const current = handlers.getSnapshot()!;
        await handlers.saveState({ ...current, collections: { ...current.collections,
          [type]: { ...current.collections[type], incrementalReady: true, hasMore: false, nextCursor: null } } });
        break;
      }
      cursor = page.nextCursor!;
      await new Promise<void>(resolve => setTimeout(resolve, 400));
    }
  }
  check();
  return added;
}
