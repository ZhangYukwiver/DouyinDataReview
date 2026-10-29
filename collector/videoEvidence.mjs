const CACHE_HEADERS = Object.freeze([
  "age",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "x-bdcdn-cache-status",
  "x-cache",
  "x-oss-cdn-auth",
  "x-response-cache",
  "x-swift-cachetime",
  "x-swift-savetime",
]);

export const VIDEO_EVIDENCE_LIMITATIONS = Object.freeze([
  "证据只记录本次进程观察到的详情与媒体响应，不代表平台的完整日志或授权证明。",
  "每次下载会按当前登录会话重新检查详情；这不要求作品在发布后三小时内下载。约 3/24 小时指报告样本中单条签名媒体地址的有效期估算，不是作品期限。",
  "详情拒绝、缺失或作品 ID 不匹配时停止；本实现不保存或复用旧签名地址，因此不支持作品变为不可访问后的应急取回。",
  "签名媒体地址、Cookie、认证头、Referer 和完整查询参数不会写入证据文件。",
  "过期时间仅按已识别的 expire 查询参数或 zjcdn 路径格式估算；其他格式可能无法识别。",
  "CDN 缓存响应头只能说明本次响应的观测值，不能单独证明源站行为、缓存层级或内容权限。",
]);

function asEpochSeconds(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d{9,11}$/u.test(text)) return null;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) && seconds >= 1_000_000_000 && seconds <= 9_999_999_999
    ? seconds
    : null;
}

function isoFromSeconds(seconds) {
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

/** Extract only bounded timestamps; never return the signed URL or its query. */
export function estimateMediaUrlLifetime(value) {
  try {
    const url = new URL(value);
    const issuedSeconds = asEpochSeconds(url.searchParams.get("dy_q"));
    const queryExpiry = asEpochSeconds(url.searchParams.get("expire"));
    let expiresSeconds = queryExpiry;
    let source = queryExpiry === null ? null : "query-expire";

    if (expiresSeconds === null && (url.hostname === "zjcdn.com" || url.hostname.endsWith(".zjcdn.com"))) {
      const pathSegments = url.pathname.split("/").filter(Boolean);
      const hex = pathSegments[1];
      if (hex && /^[\da-f]{8}$/iu.test(hex)) {
        const candidate = Number.parseInt(hex, 16);
        if (Number.isSafeInteger(candidate) && candidate >= 1_000_000_000) {
          expiresSeconds = candidate;
          source = "zjcdn-path-hex";
        }
      }
    }

    const lifetimeSeconds = issuedSeconds !== null && expiresSeconds !== null
      ? expiresSeconds - issuedSeconds
      : null;
    return {
      issuedAt: isoFromSeconds(issuedSeconds),
      expiresAt: isoFromSeconds(expiresSeconds),
      lifetimeSeconds: Number.isSafeInteger(lifetimeSeconds) && lifetimeSeconds > 0 ? lifetimeSeconds : null,
      source,
    };
  } catch {
    return { issuedAt: null, expiresAt: null, lifetimeSeconds: null, source: null };
  }
}

function safeText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 256);
}

export function pickVideoEvidenceHeaders(headers) {
  const picked = {};
  for (const name of CACHE_HEADERS) {
    const value = typeof headers?.get === "function"
      ? headers.get(name)
      : headers?.[name] ?? headers?.[name.toLowerCase()];
    if (value !== null && value !== undefined && String(value).trim()) picked[name] = safeText(value);
  }
  return picked;
}

function safeHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname.length <= 253 ? hostname : null;
  } catch {
    return null;
  }
}

function safeIso(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Build a URL-free, credential-free record suitable for a local evidence manifest. */
export function makeVideoMediaEvidence({
  mediaUrl,
  mediaSource,
  requestStartedAt,
  responseReceivedAt,
  responseStatus,
  responseHeaders,
  outcome,
  bytes,
  declaredBytes,
  sha256,
} = {}) {
  const times = estimateMediaUrlLifetime(mediaUrl);
  const started = safeIso(requestStartedAt);
  const received = safeIso(responseReceivedAt);
  const elapsedMs = started && received ? Math.max(0, Date.parse(received) - Date.parse(started)) : null;
  const status = Number.isSafeInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599
    ? responseStatus
    : null;
  const safeCount = (number) => Number.isSafeInteger(number) && number >= 0 ? number : null;
  return {
    kind: "media",
    observedAt: received ?? new Date().toISOString(),
    requestStartedAt: started,
    responseReceivedAt: received,
    elapsedMs,
    host: safeHost(mediaUrl),
    mediaSource: ["detail-json", "media-response", "video-current-src", "performance-resource"].includes(mediaSource)
      ? mediaSource
      : "unknown",
    status,
    outcome: safeText(outcome || "unknown"),
    headers: pickVideoEvidenceHeaders(responseHeaders),
    bytes: safeCount(bytes),
    declaredBytes: safeCount(declaredBytes),
    sha256: typeof sha256 === "string" && /^[\da-f]{64}$/iu.test(sha256) ? sha256.toLowerCase() : null,
    mediaIssuedAt: times.issuedAt,
    mediaExpiresAt: times.expiresAt,
    lifetimeSeconds: times.lifetimeSeconds,
    expirySource: times.source,
  };
}

export function makeVideoDetailEvidence({ observedAt, status, accessible, reason, businessStatus } = {}) {
  return {
    kind: "detail",
    observedAt: safeIso(observedAt) ?? new Date().toISOString(),
    host: "www.douyin.com",
    status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
    businessStatus: Number.isSafeInteger(businessStatus) ? businessStatus : null,
    accessible: typeof accessible === "boolean" ? accessible : null,
    outcome: accessible === true ? "accessible" : accessible === false ? "denied" : "unconfirmed",
    reason: ["detail_missing", "id_mismatch", "visibility_restricted", "request_failed", "detail_unconfirmed"].includes(reason)
      ? reason
      : null,
  };
}
