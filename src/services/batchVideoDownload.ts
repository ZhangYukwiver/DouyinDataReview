import { Zip, ZipPassThrough } from "fflate";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import type { ExploreConnection } from "./explorer";
import { fetchCollectorVideoFile, getCollectorVideoDownload, LocalCollectorError, startCollectorVideoDownload, type VideoDownloadFile } from "./localCollector";

export const MAX_BATCH_VIDEOS = 50;
export const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const BATCH_FULL = "本批已满 500 MB，请先保存 ZIP，剩下的放到下一批。";
const ALONE_ONLY = "这个视频超过 500 MB，请单独下载。";
// 单个视频自己超限只算它失败，后面的照常下；只有「本批已满」才是队列级的
const sizeLimit = (bytes: number) => bytes > MAX_BATCH_BYTES ? new LocalCollectorError("video_too_large", ALONE_ONLY) : new LocalCollectorError("batch_size_limit", BATCH_FULL);
// 这两种失败和某个视频本身无关，再往下排只会逐个失败（还会白白重下一遍），所以停队列等用户处理
const STOPS_QUEUE = new Set(["collector_busy", "batch_size_limit"]);
export type BatchItem = {
  record: PersonalVideoRecord;
  status: "pending" | "running" | "complete" | "failed";
  file?: VideoDownloadFile;
  error?: string;
  /** 失败原因的代码，弹窗据此判断本批是不是已经装满 */
  code?: string;
};

export function videoDownloadKey(record: PersonalVideoRecord): string | null {
  if (!record.url?.trim() || record.mediaType === "image" || record.mediaType === "live") return null;
  try {
    const url = new URL(record.url.trim());
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!["www.douyin.com", "douyin.com", "v.douyin.com", "m.douyin.com", "iesdouyin.com", "www.iesdouyin.com", "v.iesdouyin.com", "m.iesdouyin.com"].includes(url.hostname)) return null;
    const modalId = /^\d+$/u.test(url.searchParams.get("modal_id") ?? "") && /^\/*$/u.test(url.pathname) && url.hostname.endsWith("douyin.com") ? url.searchParams.get("modal_id") : null;
    const id = /^\/(?:video|share\/(?:video|item))\/(\d+)/u.exec(url.pathname)?.[1] ?? modalId;
    if (!id && !/^(?:v|m)\.(?:douyin|iesdouyin)\.com$/u.test(url.hostname)) return null;
    return record.videoId || id || `${url.origin}${url.pathname}`;
  } catch { return null; }
}

export function uniqueDownloadVideos<T extends PersonalVideoRecord>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = videoDownloadKey(record);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 800);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function loadBatchVideoFile(connection: ExploreConnection, record: PersonalVideoRecord, remainingBytes: number, signal: AbortSignal, keepExplore = false): Promise<VideoDownloadFile> {
  signal.throwIfAborted();
  if (remainingBytes <= 0) throw new LocalCollectorError("batch_size_limit", BATCH_FULL);
  const deadline = Date.now() + 15 * 60 * 1000;
  let job = await startCollectorVideoDownload(connection.baseUrl, connection.token, record.url!, signal, false, keepExplore);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) throw new LocalCollectorError("timeout", "视频下载超时，请稍后重试。");
    await wait(signal);
    job = await getCollectorVideoDownload(connection.baseUrl, connection.token, job.id, signal);
  }
  signal.throwIfAborted();
  if (job.status !== "complete") throw new LocalCollectorError(job.errorCode ?? "download_failed", job.error ?? "视频下载失败，请稍后重试。");
  if (job.bytes !== null && job.bytes > remainingBytes) throw sizeLimit(job.bytes);
  const file = await fetchCollectorVideoFile(connection.baseUrl, connection.token, job.id, Math.max(1, deadline - Date.now()), signal);
  if (file.blob.size > remainingBytes) throw sizeLimit(file.blob.size);
  return { ...file, fileName: file.fileName ?? job.fileName };
}

/** One active request at a time. A stop finishes the current file and preserves successes. */
export async function runVideoBatch(items: BatchItem[], options: {
  load: (record: PersonalVideoRecord, remainingBytes: number) => Promise<VideoDownloadFile>;
  shouldStop: () => boolean;
  onUpdate: (items: BatchItem[]) => void;
}): Promise<BatchItem[]> {
  if (items.length > MAX_BATCH_VIDEOS) throw new Error(`每批最多 ${MAX_BATCH_VIDEOS} 个视频。`);
  const next = items.map((item) => ({ ...item }));
  let bytes = next.reduce((total, item) => total + (item.file?.blob.size ?? 0), 0);
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index]!;
    if (item.status === "complete") continue;
    if (options.shouldStop()) break;
    next[index] = { record: item.record, status: "running" };
    options.onUpdate([...next]);
    try {
      const file = await options.load(item.record, MAX_BATCH_BYTES - bytes);
      if (file.blob.size > MAX_BATCH_BYTES - bytes) throw sizeLimit(file.blob.size);
      bytes += file.blob.size;
      next[index] = { record: item.record, status: "complete", file };
    } catch (error) {
      const code = error instanceof LocalCollectorError ? error.code : undefined;
      next[index] = { record: item.record, status: "failed", error: error instanceof Error ? error.message : "视频下载失败，请重试。", code };
      if (code && STOPS_QUEUE.has(code)) { options.onUpdate([...next]); break; }
    }
    options.onUpdate([...next]);
  }
  return next;
}

export async function createVideoBatchZip(items: BatchItem[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else parts.push(new Uint8Array(chunk).buffer);
  });
  for (const [index, item] of items.entries()) {
    if (item.status !== "complete" || !item.file) continue;
    const name = (item.file.fileName || `${item.record.title}.mp4`).replace(/[\\/\u0000-\u001f<>:"|?*]/gu, "_").slice(0, 160);
    // Prefixes preserve order and keep equal titles from overwriting one another.
    const entry = new ZipPassThrough(`${String(index + 1).padStart(3, "0")}_${name}`);
    zip.add(entry);
    const reader = item.file.blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.push(value, false);
        if (zipError) throw zipError;
      }
      entry.push(new Uint8Array(0), true);
    } finally { reader.releaseLock(); }
  }
  zip.end();
  if (zipError) throw zipError;
  return new Blob(parts, { type: "application/zip" });
}
