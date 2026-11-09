import { Zip, ZipPassThrough } from "fflate";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import type { ExploreConnection } from "./explorer";
import { fetchCollectorVideoFiles, getCollectorVideoDownload, LocalCollectorError, startCollectorVideoDownload, type DownloadMode, type DownloadQuality, type VideoDownloadFile, type VideoEvidenceEntry } from "./localCollector";

export const MAX_BATCH_VIDEOS = 50;
export const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const BATCH_FULL = "本批已满 500 MB，请先保存 ZIP，剩下的放到下一批。";
const ALONE_ONLY = "这个视频超过 500 MB，请单独下载。";
const VIDEO_EVIDENCE_LIMITATIONS = [
  "证据只记录本次进程观察到的详情与媒体响应，不代表平台的完整日志或授权证明。",
  "每次下载会按当前登录会话重新检查详情；这不要求作品在发布后三小时内下载。约 3/24 小时指报告样本中单条签名媒体地址的有效期估算，不是作品期限。",
  "详情拒绝、缺失或作品 ID 不匹配时停止；本实现不保存或复用旧签名地址，因此不支持作品变为不可访问后的应急取回。",
  "签名媒体地址、Cookie、认证头、Referer 和完整查询参数不会写入证据文件。",
  "过期时间仅按已识别的 expire 查询参数或 zjcdn 路径格式估算；其他格式可能无法识别。",
  "CDN 缓存响应头只能说明本次响应的观测值，不能单独证明源站行为、缓存层级或内容权限。",
];
// 单个视频自己超限只算它失败，后面的照常下；只有「本批已满」才是队列级的
const sizeLimit = (bytes: number) => bytes > MAX_BATCH_BYTES ? new LocalCollectorError("video_too_large", ALONE_ONLY) : new LocalCollectorError("batch_size_limit", BATCH_FULL);
// 这两种失败和某个视频本身无关，再往下排只会逐个失败（还会白白重下一遍），所以停队列等用户处理
const STOPS_QUEUE = new Set(["collector_busy", "batch_size_limit"]);
type DownloadedWork = { files: VideoDownloadFile[]; evidence?: VideoEvidenceEntry[] };
export const downloadBytes = (work?: DownloadedWork) => work?.files.reduce((sum, file) => sum + file.blob.size, 0) ?? 0;

export type BatchItem = {
  record: PersonalVideoRecord;
  status: "pending" | "running" | "complete" | "failed";
  download?: DownloadedWork;
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

/** Already queued overflow goes first, followed by selections that have never been queued. */
export function nextVideoBatch(records: PersonalVideoRecord[], offset: number, previous: BatchItem[] = []) {
  const carry = previous.filter((item) => item.status === "pending" || item.code === "batch_size_limit");
  const added = records.slice(offset, offset + MAX_BATCH_VIDEOS - carry.length);
  const items: BatchItem[] = [...carry.map((item) => item.record), ...added].map((record) => ({ record, status: "pending" }));
  return { items, offset: offset + added.length };
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 800);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function loadBatchVideoFiles(connection: ExploreConnection, record: PersonalVideoRecord, remainingBytes: number, signal: AbortSignal, keepExplore = false, mode: DownloadMode = "combined", quality: DownloadQuality = "auto"): Promise<DownloadedWork> {
  signal.throwIfAborted();
  if (remainingBytes <= 0) throw new LocalCollectorError("batch_size_limit", BATCH_FULL);
  const deadline = Date.now() + 15 * 60 * 1000;
  let job = await startCollectorVideoDownload(connection.baseUrl, connection.token, record.url!, signal, false, keepExplore, mode, quality);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) throw new LocalCollectorError("timeout", "视频下载超时，请稍后重试。");
    await wait(signal);
    job = await getCollectorVideoDownload(connection.baseUrl, connection.token, job.id, signal);
  }
  signal.throwIfAborted();
  if (job.status !== "complete") throw new LocalCollectorError(job.errorCode ?? "download_failed", job.error ?? "视频下载失败，请稍后重试。");
  if (job.bytes !== null && job.bytes > remainingBytes) throw sizeLimit(job.bytes);
  const files = await fetchCollectorVideoFiles(connection.baseUrl, connection.token, job, deadline, signal);
  const download = { files, evidence: job.evidence ?? [] };
  const bytes = downloadBytes(download);
  if (bytes > remainingBytes) throw sizeLimit(bytes);
  return download;
}

/** One active request at a time. A stop finishes the current file and preserves successes. */
export async function runVideoBatch(items: BatchItem[], options: {
  load: (record: PersonalVideoRecord, remainingBytes: number) => Promise<DownloadedWork>;
  shouldStop: () => boolean;
  onUpdate: (items: BatchItem[]) => void;
}): Promise<BatchItem[]> {
  if (items.length > MAX_BATCH_VIDEOS) throw new Error(`每批最多 ${MAX_BATCH_VIDEOS} 个视频。`);
  const next = items.map((item) => ({ ...item }));
  let bytes = next.reduce((total, item) => total + downloadBytes(item.download), 0);
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index]!;
    if (item.status === "complete") continue;
    if (options.shouldStop()) break;
    next[index] = { record: item.record, status: "running" };
    options.onUpdate([...next]);
    try {
      const download = await options.load(item.record, MAX_BATCH_BYTES - bytes);
      const size = downloadBytes(download);
      if (size > MAX_BATCH_BYTES - bytes) throw sizeLimit(size);
      bytes += size;
      next[index] = { record: item.record, status: "complete", download };
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
  const entries = items.flatMap(({ status, download, record }, index) => {
    if (status !== "complete" || !download) return [];
    return download.files.map(file => ({
      blob: file.blob,
      fileName: `${String(index + 1).padStart(3, "0")}_${file.fileName ?? record.title + ".mp4"}`,
    }));
  });
  const downloads = items.flatMap(({ status, download }) => status === "complete" && download?.evidence?.length
    ? [{ fileName: download.files[0]?.fileName, ...(download.files.length > 1 ? { fileNames: download.files.map(file => file.fileName) } : {}),
      bytes: downloadBytes(download), evidence: download.evidence }] : []);
  if (downloads.length) {
    const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), limitations: VIDEO_EVIDENCE_LIMITATIONS, downloads };
    entries.push({ fileName: "evidence.json", blob: new Blob([JSON.stringify(manifest, null, 2)]) });
  }
  return zipVideoFiles(entries);
}

export async function zipVideoFiles(files: VideoDownloadFile[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else parts.push(new Uint8Array(chunk).buffer);
  });
  for (const file of files) {
    const name = (file.fileName || "抖音视频.mp4").replace(/[\\/\u0000-\u001f<>:"|?*]/gu, "_").slice(0, 170);
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    const reader = file.blob.stream().getReader();
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
