import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pageNeedsVerification, prepareReadOnlyPage } from "./readOnlyPage.mjs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 90;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const DEFAULT_PAGE_TIMEOUT_MS = 45_000;
const DEFAULT_MEDIA_WAIT_MS = 25_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;

const PAGE_HOSTS = [
  "douyin.com",
  "iesdouyin.com",
];

const MEDIA_HOSTS = [
  "douyinvod.com",
  "ibytedtos.com",
  "byteimg.com",
  "snssdk.com",
];

const DETAIL_PATH_PATTERN = /\/aweme\/v1\/web\/aweme\/detail\//iu;
const VIDEO_ID_PATTERN = /\/(?:video|note|share\/(?:video|note|item))\/(\d+)/iu;

export class VideoDownloadError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "VideoDownloadError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isHostInList(hostname, suffixes) {
  const host = String(hostname ?? "").toLocaleLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function invalidSource(message = "请输入有效的抖音视频链接。") {
  return new VideoDownloadError("invalid_url", message, { retryable: false });
}

/**
 * Accept only HTTPS Douyin share/page URLs. This is also the SSRF boundary for
 * the local download API; media URLs are validated separately below.
 */
export function normalizeDouyinVideoUrl(value) {
  if (typeof value !== "string") throw invalidSource();
  const text = value.trim();
  if (!text || text.length > MAX_SOURCE_URL_LENGTH) throw invalidSource();

  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalidSource();
  }
  if (url.protocol !== "https:" || !isHostInList(url.hostname, PAGE_HOSTS) || (url.port && url.port !== "443") || url.username || url.password) {
    throw invalidSource("只支持 HTTPS 抖音视频链接。");
  }

  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const shortHost = /^(?:v|m)\.douyin\.com$/iu.test(url.hostname)
    || /^(?:v|m)\.iesdouyin\.com$/iu.test(url.hostname);
  const concretePath = /^\/(?:video|note|share\/(?:video|note|item))\/\d+/iu.test(pathname);
  const modalVideo = url.hostname.endsWith("douyin.com")
    && /^\/$/u.test(pathname)
    && /^\d+$/u.test(url.searchParams.get("modal_id") ?? "");
  if (!shortHost && !concretePath && !modalVideo) {
    throw invalidSource("链接不是可识别的抖音视频页面。");
  }

  url.hash = "";
  return url.toString();
}

export function isAllowedMediaUrl(value) {
  if (typeof value !== "string" || value.length > MAX_SOURCE_URL_LENGTH * 2) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && isHostInList(url.hostname, MEDIA_HOSTS)
      && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

function isLikelyMediaUrl(value, contentType = "") {
  if (!isAllowedMediaUrl(value)) return false;
  const lowerUrl = value.toLocaleLowerCase();
  if (/cover|poster|thumbnail|avatar|logo/iu.test(lowerUrl)) return false;
  const lowerType = String(contentType).toLocaleLowerCase();
  return lowerType.startsWith("video/")
    || lowerType.startsWith("audio/")
    || /\/aweme\/v1\/play\//iu.test(value)
    || /media-(?:video|audio)-/iu.test(value)
    || /\.(?:mp4|m4s|webm)(?:[?#]|$)/iu.test(value);
}

function isBlockedMediaPath(value) {
  return /cover|poster|thumbnail|avatar|logo/iu.test(String(value ?? ""));
}

function mediaTypeForUrl(value, contentType = "", pathHint = "") {
  const lowerUrl = String(value).toLocaleLowerCase();
  const lowerType = String(contentType).toLocaleLowerCase();
  const lowerHint = String(pathHint).toLocaleLowerCase();
  if (lowerType.startsWith("audio/") || /media-audio-|audio/iu.test(`${lowerUrl} ${lowerHint}`)) return "audio";
  if (/media-video-/iu.test(lowerUrl)) return "video";
  return "video+audio";
}

function numberOrZero(value) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pushCandidate(candidates, candidate) {
  if (!candidate || !isAllowedMediaUrl(candidate.url)) return;
  const url = String(candidate.url).replaceAll("\\u0026", "&");
  const trustedDetailCandidate = candidate.source === "detail-json";
  if (isBlockedMediaPath(url) || (!trustedDetailCandidate && !isLikelyMediaUrl(url, candidate.contentType))) return;
  const normalized = {
    url,
    type: candidate.type ?? mediaTypeForUrl(url, candidate.contentType, candidate.pathHint),
    width: numberOrZero(candidate.width),
    height: numberOrZero(candidate.height),
    fps: numberOrZero(candidate.fps),
    bitrate: numberOrZero(candidate.bitrate),
    totalBytes: numberOrZero(candidate.totalBytes),
    source: candidate.source ?? "unknown",
  };
  const existing = candidates.find((item) => item.url === normalized.url);
  if (!existing) {
    candidates.push(normalized);
    return;
  }
  for (const key of ["width", "height", "fps", "bitrate", "totalBytes"]) {
    existing[key] = Math.max(existing[key] ?? 0, normalized[key] ?? 0);
  }
  if (existing.type === "audio" && normalized.type !== "audio") existing.type = normalized.type;
}

/** Collect URLs from the detail response without retaining the full payload. */
export function collectDouyinMediaCandidates(payload, candidates = []) {
  const detail = payload?.aweme_detail ?? payload;
  const video = detail?.video;
  if (!video || typeof video !== "object") return candidates;

  const seen = new Set();
  const walk = (node, inherited = {}, pathParts = [], depth = 0) => {
    if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);
    const pathText = pathParts.join(".");
    if (/cover|poster|thumbnail|avatar|dynamic_cover|origin_cover/iu.test(pathText)) return;
    const metadata = {
      width: numberOrZero(node.width ?? inherited.width),
      height: numberOrZero(node.height ?? inherited.height),
      fps: numberOrZero(node.fps ?? node.FPS ?? node.video_fps ?? inherited.fps),
      bitrate: numberOrZero(node.bit_rate ?? node.bitrate ?? inherited.bitrate),
      totalBytes: numberOrZero(node.data_size ?? node.file_size ?? inherited.totalBytes),
    };
    const urlList = node.url_list ?? node.urlList ?? node.urls;
    if (Array.isArray(urlList)) {
      for (const rawUrl of urlList) {
        if (typeof rawUrl !== "string") continue;
        pushCandidate(candidates, {
          url: rawUrl,
          type: mediaTypeForUrl(rawUrl, "", pathText),
          ...metadata,
          pathHint: pathText,
          source: "detail-json",
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "url_list" || key === "urlList" || key === "urls") continue;
      if (Array.isArray(child)) {
        for (const item of child) walk(item, metadata, [...pathParts, key], depth + 1);
      } else if (child && typeof child === "object") {
        walk(child, metadata, [...pathParts, key], depth + 1);
      }
    }
  };
  walk(video, {
    width: numberOrZero(video.width),
    height: numberOrZero(video.height),
  }, ["video"]);
  return candidates;
}

export function extractDouyinMetadata(payload, canonicalUrl = "") {
  const detail = payload?.aweme_detail ?? payload;
  if (!detail || typeof detail !== "object") return {};
  const author = detail.author && typeof detail.author === "object" ? detail.author : {};
  const statistics = detail.statistics && typeof detail.statistics === "object" ? detail.statistics : {};
  const videoId = String(detail.aweme_id ?? detail.item_id ?? "").trim()
    || canonicalUrl.match(VIDEO_ID_PATTERN)?.[1]
    || null;
  const title = String(detail.desc ?? "").trim().slice(0, MAX_TITLE_LENGTH);
  const duration = numberOrZero(detail.duration ?? detail.video?.duration);
  const createTime = numberOrZero(detail.create_time);
  return {
    videoId,
    title,
    author: String(author.nickname ?? "").trim().slice(0, MAX_TITLE_LENGTH) || null,
    // The web detail payload reports duration in milliseconds; a few older
    // responses use seconds. Values at or above one second in the millisecond
    // range are normalized here while keeping ordinary short second values.
    durationSeconds: duration >= 1_000 ? Math.round(duration / 1_000) : Math.round(duration),
    publishedAt: createTime > 0 ? new Date(createTime * 1_000).toISOString() : null,
    stats: {
      playCount: numberOrZero(statistics.play_count ?? statistics.vv),
      diggCount: numberOrZero(statistics.digg_count ?? statistics.digg),
      commentCount: numberOrZero(statistics.comment_count),
      shareCount: numberOrZero(statistics.share_count ?? statistics.share),
      collectCount: numberOrZero(statistics.collect_count),
    },
  };
}

function candidateScore(candidate) {
  return [
    candidate.type === "video+audio" ? 1 : 0,
    (candidate.width || 0) * (candidate.height || 0),
    candidate.bitrate || 0,
    candidate.fps || 0,
    candidate.totalBytes || 0,
  ];
}

export function selectDouyinMediaCandidate(candidates) {
  const playable = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.type !== "audio" && isAllowedMediaUrl(candidate?.url));
  playable.sort((left, right) => {
    const a = candidateScore(left);
    const b = candidateScore(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index];
    }
    return 0;
  });
  return playable[0] ?? null;
}

async function runtimeMediaCandidates(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  return page.evaluate(() => {
    const values = [];
    const add = (url, source, totalBytes = 0) => {
      if (typeof url !== "string" || !url) return;
      values.push({ url, source, totalBytes });
    };
    for (const element of document.querySelectorAll("video")) {
      add(element.currentSrc || element.src, "video-current-src");
    }
    for (const entry of performance.getEntriesByType("resource")) {
      add(entry.name, "performance-resource", entry.encodedBodySize || entry.transferSize || 0);
    }
    return values;
  }).catch(() => []);
}

function bodyText(page) {
  const locator = page?.locator?.("body");
  if (!locator || typeof locator.innerText !== "function") return Promise.resolve("");
  return locator.innerText({ timeout: 3_000 }).catch(() => "");
}

/**
 * Resolve one share/page URL to a fresh playable media URL using the supplied
 * persistent browser context. No private API signature is generated here.
 */
export async function discoverDouyinVideo(context, sourceUrl, {
  pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  mediaWaitMs = DEFAULT_MEDIA_WAIT_MS,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const normalizedSourceUrl = normalizeDouyinVideoUrl(sourceUrl);
  if (!context || typeof context.newPage !== "function") {
    throw new VideoDownloadError("browser_unavailable", "无头浏览器当前不可用。");
  }

  const page = await context.newPage();
  const abort = () => { void page.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const candidates = [];
  const pending = new Set();
  let detailMeta = {};
  const add = (candidate) => pushCandidate(candidates, candidate);
  const onResponse = (response) => {
    const task = (async () => {
      const responseUrl = response.url();
      const headers = typeof response.headers === "function" ? response.headers() : {};
      const contentType = headers?.["content-type"] ?? "";
      if (DETAIL_PATH_PATTERN.test(responseUrl) && response.ok()) {
        const declaredLength = numberOrZero(headers?.["content-length"]);
        if (declaredLength <= 24 * 1024 * 1024) {
          const payload = await response.json().catch(() => null);
          if (payload) {
            collectDouyinMediaCandidates(payload, candidates);
            detailMeta = { ...detailMeta, ...extractDouyinMetadata(payload, page.url()) };
          }
        }
      }
      if (isLikelyMediaUrl(responseUrl, contentType)) {
        add({
          url: responseUrl,
          contentType,
          type: mediaTypeForUrl(responseUrl, contentType),
          totalBytes: numberOrZero(headers?.["content-length"]),
          source: "media-response",
        });
      }
    })();
    pending.add(task);
    task.catch(() => undefined).finally(() => pending.delete(task));
  };

  page.on("response", onResponse);
  try {
    await prepareReadOnlyPage(page);
    signal?.throwIfAborted();
    try {
      await page.goto(normalizedSourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: pageTimeoutMs,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === "TimeoutError") {
        throw new VideoDownloadError("page_timeout", "抖音视频页面加载超时，请稍后重试。");
      }
      throw new VideoDownloadError("page_load_failed", "抖音视频页面加载失败，请检查网络后重试。");
    }
    let landingUrl;
    try {
      landingUrl = new URL(page.url());
    } catch {
      throw new VideoDownloadError("page_redirect_blocked", "抖音页面跳转到了无法识别的地址。", { retryable: false });
    }
    if (landingUrl.protocol !== "https:" || !isHostInList(landingUrl.hostname, PAGE_HOSTS) || (landingUrl.port && landingUrl.port !== "443")) {
      throw new VideoDownloadError("page_redirect_blocked", "抖音页面跳转到了不受支持的域名。", { retryable: false });
    }

    const deadline = Date.now() + mediaWaitMs;
    let firstCandidateAt = null;
    while (Date.now() < deadline) {
      if (candidates.length > 0) {
        firstCandidateAt ??= Date.now();
        if (Date.now() - firstCandidateAt >= 1_500) break;
      }
      await delay(250, undefined, { signal });
    }
    await Promise.allSettled([...pending]);
    signal?.throwIfAborted();

    for (const candidate of await runtimeMediaCandidates(page)) add(candidate);
    const canonicalUrl = page.url();
    const selected = selectDouyinMediaCandidate(candidates);
    if (!selected) {
      const text = await bodyText(page);
      if (await pageNeedsVerification(page)) {
        throw new VideoDownloadError("verification_required", "抖音要求完成安全验证，请稍后重试或先在浏览器中验证。", { retryable: true });
      }
      if (/作品不存在|视频不见了|已删除|暂无权限|私密作品/iu.test(text)) {
        throw new VideoDownloadError("content_unavailable", "该抖音作品不存在、已删除或当前不可访问。", { retryable: false });
      }
      throw new VideoDownloadError("media_not_found", "没有捕获到可下载的抖音视频媒体地址，请稍后重试。");
    }

    return {
      sourceUrl: normalizedSourceUrl,
      canonicalUrl,
      videoId: detailMeta.videoId || canonicalUrl.match(VIDEO_ID_PATTERN)?.[1] || null,
      title: detailMeta.title || (await page.title().catch(() => "")) || "抖音视频",
      author: detailMeta.author ?? null,
      durationSeconds: detailMeta.durationSeconds || null,
      publishedAt: detailMeta.publishedAt ?? null,
      stats: detailMeta.stats ?? null,
      media: selected,
      candidates: candidates.map((candidate) => ({ ...candidate })),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    page.off("response", onResponse);
    await page.close().catch(() => undefined);
  }
}

function truncateFileSegment(value, maxLength) {
  let result = "";
  for (const character of value.toWellFormed()) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function cleanFileSegment(value, fallback = "抖音视频") {
  const cleaned = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .trim();
  return truncateFileSegment(cleaned, MAX_TITLE_LENGTH) || fallback;
}

export function makeVideoFileName({ title, videoId, sourceUrl } = {}) {
  const safeTitle = cleanFileSegment(title);
  const safeId = truncateFileSegment(cleanFileSegment(videoId, "").replace(/[^\p{L}\p{N}._-]/gu, ""), 40);
  const digest = createHash("sha256").update(String(sourceUrl ?? "")).digest("hex").slice(0, 10);
  return `${safeTitle}-${safeId || digest}.mp4`;
}

async function hasVideoSignature(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return true;
    return bytesRead >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function cookieHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && typeof cookie.name === "string" && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function fetchCookieHeader(context, url) {
  if (!context || typeof context.cookies !== "function") return "";
  return cookieHeader(await context.cookies(url).catch(() => []));
}

/** Stream one selected media URL to a private, atomically-renamed local file. */
export async function downloadMediaFile({
  context,
  media,
  outputDirectory,
  fileName,
  referer = "https://www.douyin.com/",
  userAgent,
  signal,
  onProgress,
  maxBytes = MAX_MEDIA_BYTES,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (!media || !isAllowedMediaUrl(media.url)) {
    throw new VideoDownloadError("invalid_media_url", "抖音媒体地址不在允许范围内。", { retryable: false });
  }
  if (!outputDirectory || !fileName) {
    throw new VideoDownloadError("invalid_output", "下载目录或文件名无效。", { retryable: false });
  }
  const safeName = (() => {
    const basename = path.basename(String(fileName));
    const cleaned = basename.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").trim();
    return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "douyin-video.mp4";
  })();
  const finalPath = path.join(outputDirectory, safeName);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    const existing = await stat(finalPath);
    if (existing.size > 0 && await hasVideoSignature(finalPath)) {
      return { filePath: finalPath, fileName: safeName, bytes: existing.size, skipped: true };
    }
  } catch {
    // The file does not exist yet.
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason ?? new Error("download_aborted"));
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("download_timeout")), timeoutMs);
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.part`;
  let bytes = 0;
  try {
    const cookies = await fetchCookieHeader(context, media.url);
    const response = await fetch(media.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        Referer: referer,
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        ...(cookies ? { Cookie: cookies } : {}),
      },
    });
    if (!response.ok || !response.body) {
      throw new VideoDownloadError("media_http_error", `抖音媒体地址返回 HTTP ${response.status}。`);
    }
    const resolvedMediaUrl = response.url || media.url;
    if (!isAllowedMediaUrl(resolvedMediaUrl)) {
      throw new VideoDownloadError("media_redirect_blocked", "抖音媒体地址重定向到了不受支持的域名。", { retryable: false });
    }
    const declaredLength = numberOrZero(response.headers.get("content-length"));
    if (declaredLength > maxBytes) {
      throw new VideoDownloadError("media_too_large", "视频文件超过本地安全大小限制。", { retryable: false });
    }

    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          callback(new VideoDownloadError("media_too_large", "视频文件超过本地安全大小限制。", { retryable: false }));
          return;
        }
        onProgress?.(bytes);
        callback(null, chunk, encoding);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    if (!(await hasVideoSignature(temporaryPath))) {
      throw new VideoDownloadError("invalid_media", "下载结果不是可识别的视频文件。", { retryable: false });
    }
    await rm(finalPath, { force: true });
    await rename(temporaryPath, finalPath);
    return { filePath: finalPath, fileName: safeName, bytes, skipped: false };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof VideoDownloadError) throw error;
    if (controller.signal.aborted) {
      const code = controller.signal.reason?.message === "download_timeout" ? "download_timeout" : "download_aborted";
      throw new VideoDownloadError(code, code === "download_timeout" ? "视频下载超时，请稍后重试。" : "视频下载已取消。");
    }
    throw new VideoDownloadError("media_download_failed", "视频文件下载失败，请稍后重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function downloadDouyinVideo({
  context,
  sourceUrl,
  outputDirectory,
  signal,
  onProgress,
  pageTimeoutMs,
  mediaWaitMs,
  timeoutMs,
} = {}) {
  const parsed = await discoverDouyinVideo(context, sourceUrl, { pageTimeoutMs, mediaWaitMs, signal });
  signal?.throwIfAborted();
  const fileName = makeVideoFileName({
    title: parsed.title,
    videoId: parsed.videoId,
    sourceUrl: parsed.sourceUrl,
  });
  const downloaded = await downloadMediaFile({
    context,
    media: parsed.media,
    outputDirectory,
    fileName,
    referer: parsed.canonicalUrl || "https://www.douyin.com/",
    signal,
    onProgress,
    timeoutMs,
  });
  return { ...parsed, ...downloaded };
}

export const videoDownloadLimits = Object.freeze({
  maxSourceUrlLength: MAX_SOURCE_URL_LENGTH,
  maxMediaBytes: MAX_MEDIA_BYTES,
  defaultPageTimeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
  defaultMediaWaitMs: DEFAULT_MEDIA_WAIT_MS,
  defaultDownloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
});
