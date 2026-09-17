import { Zip, ZipPassThrough } from "fflate";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import type { ExploreConnection } from "./explorer";
import { fetchCollectorVideoFile, getCollectorVideoDownload, LocalCollectorError, startCollectorVideoDownload, type VideoDownloadFile } from "./localCollector";

export const MAX_BATCH_VIDEOS = 50;
export const MAX_BATCH_BYTES = 500 * 1024 * 1024;
export type BatchItem = {
  record: PersonalVideoRecord;
  status: "pending" | "running" | "complete" | "failed";
  file?: VideoDownloadFile;
  error?: string;
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

export function uniqueDownloadVideos(records: PersonalVideoRecord[]): PersonalVideoRecord[] {
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

export async function loadBatchVideoFile(connection: ExploreConnection, record: PersonalVideoRecord, remainingBytes: number, signal: AbortSignal): Promise<VideoDownloadFile> {
  signal.throwIfAborted();
  if (remainingBytes <= 0) throw new LocalCollectorError("batch_size_limit", "本批已达到 500 MB 上限，请保存后开启下一批。");
  const deadline = Date.now() + 15 * 60 * 1000;
  let job = await startCollectorVideoDownload(connection.baseUrl, connection.token, record.url!, signal);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) throw new LocalCollectorError("timeout", "视频下载超时，请稍后重试。");
    await wait(signal);
    job = await getCollectorVideoDownload(connection.baseUrl, connection.token, job.id, signal);
  }
  signal.throwIfAborted();
  if (job.status !== "complete") throw new LocalCollectorError(job.errorCode ?? "download_failed", job.error ?? "视频下载失败，请稍后重试。");
  if (job.bytes !== null && job.bytes > remainingBytes) throw new LocalCollectorError("batch_size_limit", "超出本批 500 MB 上限，请单独下载此视频。");
  const file = await fetchCollectorVideoFile(connection.baseUrl, connection.token, job.id, Math.max(1, deadline - Date.now()), signal);
  if (file.blob.size > remainingBytes) throw new LocalCollectorError("batch_size_limit", "超出本批 500 MB 上限，请单独下载此视频。");
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
      if (file.blob.size > MAX_BATCH_BYTES - bytes) throw new Error("超出本批 500 MB 上限，请单独下载此视频。");
      bytes += file.blob.size;
      next[index] = { record: item.record, status: "complete", file };
    } catch (error) {
      next[index] = { record: item.record, status: "failed", error: error instanceof Error ? error.message : "视频下载失败，请重试。" };
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
