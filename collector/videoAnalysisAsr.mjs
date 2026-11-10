import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const BCUT_BASE_URL = "https://member.bilibili.com/x/bcut/rubick-interface";
const BCUT_CREATE_RESOURCE_URL = `${BCUT_BASE_URL}/resource/create`;
const BCUT_COMPLETE_RESOURCE_URL = `${BCUT_BASE_URL}/resource/create/complete`;
const BCUT_CREATE_TASK_URL = `${BCUT_BASE_URL}/task`;
const BCUT_RESULT_URL = `${BCUT_BASE_URL}/task/result`;

const QWEN_SPACE_URL = "https://qwen-qwen3-asr.hf.space";
const QWEN_API = `${QWEN_SPACE_URL}/gradio_api`;

const BCUT_POLL_INTERVAL_MS = 1_000;
const BCUT_MAX_POLLS = 180;
const ASR_REQUEST_TIMEOUT_MS = 180_000;
const MAX_QWEN_SEGMENT_DURATION_MS = 30_000;
const MAX_QWEN_SEGMENT_TEXT_LENGTH = 80;
const QWEN_PAUSE_SPLIT_MS = 900;

const BCUT_HEADERS = Object.freeze({
  "User-Agent": "Bilibili/1.0.0 (https://www.bilibili.com)",
  "Content-Type": "application/json",
});

export class VideoAnalysisAsrError extends Error {
  constructor(code, message, { retryable = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "VideoAnalysisAsrError";
    this.code = code;
    this.retryable = retryable;
  }
}

const validEngine = (engine) => engine === "bcut" || engine === "qwen";

function checkSignal(signal) {
  if (signal?.aborted) {
    if (signal.reason) throw signal.reason;
    throw Object.assign(new Error("视频转写已取消。"), { name: "AbortError" });
  }
}

function report(onProgress, stage, detail = {}) {
  if (typeof onProgress !== "function") return;
  onProgress(typeof detail.message === "string" && detail.message ? detail.message : stage);
}

function responseMessage(payload, fallback = "云端转写服务返回了错误。") {
  const safeFallback = String(fallback ?? "").trim();
  const usableFallback = safeFallback && safeFallback !== "null" && safeFallback !== "undefined"
    ? safeFallback
    : "云端转写服务返回了空错误。";
  if (!payload || typeof payload !== "object") return usableFallback;
  for (const value of [payload.message, payload.msg, payload.error, payload.detail]) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text !== "null" && text !== "undefined") return text;
  }
  return usableFallback;
}

async function responseJson(response, description) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    throw new VideoAnalysisAsrError("asr_http_error", `${description}失败（HTTP ${response.status}）：${responseMessage(body, text.slice(0, 240))}`, { retryable: response.status >= 500 || response.status === 429 });
  }
  if (!body || typeof body !== "object") throw new VideoAnalysisAsrError("asr_invalid_response", `${description}返回了无法解析的结果。`);
  return body;
}

async function abortableDelay(ms, signal) {
  checkSignal(signal);
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback(value);
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const abort = () => finish(reject, signal?.reason ?? Object.assign(new Error("视频转写已取消。"), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function numeric(value) {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

function audioMimeType(fileName) {
  const extension = path.extname(fileName).toLocaleLowerCase();
  return {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
  }[extension] ?? "application/octet-stream";
}

function normalizeSegment(startMs, endMs, text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return null;
  const start = numeric(startMs);
  const end = numeric(endMs);
  if (start == null || end == null || start < 0 || end < start) return null;
  return { startMs: Math.round(start), endMs: Math.round(end), text: value };
}

function normalizeBcutSegments(result) {
  let payload = result;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!Array.isArray(payload?.utterances)) throw new VideoAnalysisAsrError("bcut_invalid_result", "必剪没有返回可读取的分句结果，请重试。");
  return payload.utterances.filter(item => item?.transcript?.trim()).map(item => {
    const row = normalizeSegment(item.start_time, item.end_time, item.transcript);
    if (!row) throw new VideoAnalysisAsrError("bcut_invalid_result", "必剪返回的分句缺少有效的起止时间，请重试。");
    return row;
  });
}

function qwenTimestamps(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return null;
    const text = typeof item.text === "string" ? item.text : typeof item.word === "string" ? item.word : "";
    const start = numeric(item.start_time ?? item.start ?? item.startTime);
    const end = numeric(item.end_time ?? item.end ?? item.endTime);
    if (!text || start == null || end == null || start < 0 || end < start) return null;
    return { text, startMs: Math.round(start * 1_000), endMs: Math.round(end * 1_000) };
  }).filter(Boolean);
}

function alignQwenText(items, fullText) {
  const source = typeof fullText === "string" ? fullText : "";
  if (!source) return items;

  // Qwen's aligner normally omits punctuation, while the full transcript keeps
  // it. Match each timed token in order and attach the intervening source text
  // (spaces and punctuation) to the preceding token so it keeps that token's
  // valid time range.
  const aligned = [];
  let cursor = 0;
  for (const item of items) {
    const token = item.text;
    const index = source.indexOf(token, cursor);
    if (index < cursor) return items;
    if (index > cursor && aligned.length) aligned[aligned.length - 1].text += source.slice(cursor, index);
    aligned.push({ ...item, text: index > cursor && !aligned.length ? source.slice(0, index) + token : token });
    cursor = index + token.length;
  }
  if (aligned.length && cursor < source.length) aligned[aligned.length - 1].text += source.slice(cursor);
  return aligned;
}

/** Merge Qwen's Chinese character timestamps into replayable sentence ranges. */
export function mergeQwenTimestamps(timestampItems, fallbackText = "") {
  const items = qwenTimestamps(timestampItems);
  const sourceText = typeof fallbackText === "string" ? fallbackText : "";
  if (!items.length) {
    if (!sourceText.trim()) return [];
    throw new VideoAnalysisAsrError("qwen_timing_missing", "Qwen3-ASR 返回了文字，但没有可用的时间戳。", { retryable: true });
  }

  const segments = [];
  const alignedItems = alignQwenText(items, sourceText);
  let current = null;
  for (const item of alignedItems) {
    const pause = current ? item.startMs - current.endMs : 0;
    const duration = current ? item.endMs - current.startMs : 0;
    const wouldExceedBounds = current && (duration >= MAX_QWEN_SEGMENT_DURATION_MS || current.text.length >= MAX_QWEN_SEGMENT_TEXT_LENGTH);
    if (current && (pause >= QWEN_PAUSE_SPLIT_MS || wouldExceedBounds)) {
      segments.push(current);
      current = null;
    }
    if (!current) current = { startMs: item.startMs, endMs: item.endMs, text: item.text };
    else {
      current.endMs = Math.max(current.endMs, item.endMs);
      current.text += item.text;
    }
    if (/[。！？!?；;]$/u.test(item.text)
      || current.text.length >= MAX_QWEN_SEGMENT_TEXT_LENGTH
      || current.endMs - current.startMs >= MAX_QWEN_SEGMENT_DURATION_MS) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return segments.map((item) => normalizeSegment(item.startMs, item.endMs, item.text)).filter(Boolean);
}

function qwenQueueError(event) {
  const detail = [event.output?.title, event.title, event.output?.error, event.message]
    .filter(value => typeof value === "string" && value.trim()).join(" ");
  if (/ZeroGPU quota/i.test(detail)) {
    const seconds = /(\d+(?:\.\d+)?)s requested vs\.?\s*(\d+(?:\.\d+)?)s left/i.exec(detail);
    const balance = seconds ? `（本次需要 ${seconds[1]} 秒，剩余 ${seconds[2]} 秒）` : "";
    return new VideoAnalysisAsrError("qwen_quota", `Qwen3-ASR 公共服务的 GPU 配额不足${balance}，等配额恢复后可以再用。`);
  }
  return new VideoAnalysisAsrError("qwen_failed", `Qwen3-ASR 转写失败：${event.output?.error || event.message || event.title || "公共服务未提供具体原因，请稍后重试。"}`);
}

// Gradio 的简化 call 接口会把配额等错误压成 null，队列事件保留了服务端的原因。
async function readQwenResult(response, eventId) {
  if (!response.ok) throw new VideoAnalysisAsrError("qwen_result_http_error", `Qwen3-ASR 结果请求失败（HTTP ${response.status}）。`);
  if (!response.body) throw new VideoAnalysisAsrError("qwen_incomplete", "Qwen3-ASR 没有返回任务结果。");
  const input = Readable.fromWeb(response.body);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5));
      if (!event || (event.event_id && event.event_id !== eventId)) continue;
      if (event.msg === "close_stream") break;
      if (event.msg === "unexpected_error" || event.msg === "server_stopped") throw qwenQueueError(event);
      if (event.msg !== "process_completed") continue;
      if (!event.success || event.output?.error) throw qwenQueueError(event);
      const result = event.output?.data;
      if (!Array.isArray(result) || typeof result[1] !== "string") {
        throw new VideoAnalysisAsrError("qwen_invalid_result", "Qwen3-ASR 返回了无法识别的结果。");
      }
      return mergeQwenTimestamps(result[2], result[1]);
    }
    throw new VideoAnalysisAsrError("qwen_incomplete", "Qwen3-ASR 没有返回完整结果，请稍后重试。");
  } finally {
    lines.close();
    input.destroy();
  }
}

async function transcribeQwen(audioPath, { signal, onProgress, fetchImpl = globalThis.fetch } = {}) {
  checkSignal(signal);
  const bytes = await readFile(audioPath);
  if (!bytes.length) throw new VideoAnalysisAsrError("audio_empty", "音频文件为空。", { retryable: false });
  const fileName = path.basename(audioPath) || "audio.wav";
  const config = await responseJson(await fetchImpl(`${QWEN_SPACE_URL}/config`, { signal }), "Qwen3-ASR 接口配置");
  const fnIndex = config.dependencies?.find(item => item.api_name === "transcribe")?.id;
  if (!Number.isInteger(fnIndex)) throw new VideoAnalysisAsrError("qwen_unavailable", "Qwen3-ASR 公共服务当前未提供转写接口。");
  report(onProgress, "uploading", { message: "正在上传音频到 Qwen3-ASR。" });
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: audioMimeType(fileName) }), fileName);
  const uploadResponse = await fetchImpl(`${QWEN_API}/upload`, { method: "POST", body: form, signal });
  const uploadPayload = await responseJson(uploadResponse, "Qwen3-ASR 音频上传");
  const upload = Array.isArray(uploadPayload) ? uploadPayload[0] : uploadPayload;
  const remotePath = typeof upload === "string" ? upload : upload?.path;
  if (typeof remotePath !== "string" || !remotePath) {
    throw new VideoAnalysisAsrError("qwen_upload_invalid", "Qwen3-ASR 没有返回可用的音频文件。", { retryable: true });
  }

  checkSignal(signal);
  report(onProgress, "transcribing", { message: "Qwen3-ASR 正在识别音频。" });
  const sessionHash = randomUUID();
  const callResponse = await fetchImpl(`${QWEN_API}/queue/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn_index: fnIndex, session_hash: sessionHash, data: [{ path: remotePath, orig_name: fileName, meta: { _type: "gradio.FileData" } }, "Chinese", true] }),
    signal,
  });
  const callPayload = await responseJson(callResponse, "Qwen3-ASR 任务创建");
  const eventId = typeof callPayload.event_id === "string" ? callPayload.event_id : "";
  if (!eventId) throw new VideoAnalysisAsrError("qwen_task_invalid", "Qwen3-ASR 没有返回任务编号。", { retryable: true });

  const response = await fetchImpl(`${QWEN_API}/queue/data?session_hash=${sessionHash}`, { signal, headers: { Accept: "text/event-stream" } });
  const segments = await readQwenResult(response, eventId);
  report(onProgress, "complete", { message: "Qwen3-ASR 转写完成。" });
  return segments;
}

async function bcutRequest(fetchImpl, url, init, description, { signal } = {}) {
  checkSignal(signal);
  const response = await fetchImpl(url, { ...init, signal });
  const payload = await responseJson(response, description);
  if (payload?.code != null && Number(payload.code) !== 0) {
    throw new VideoAnalysisAsrError("bcut_service_error", `${description}失败：${responseMessage(payload)}`, { retryable: Number(payload.code) >= 500 || Number(payload.code) === 429 });
  }
  return payload;
}

async function transcribeBcut(audioPath, { signal, onProgress, fetchImpl = globalThis.fetch, pollIntervalMs = BCUT_POLL_INTERVAL_MS, maxPolls = BCUT_MAX_POLLS } = {}) {
  checkSignal(signal);
  const bytes = await readFile(audioPath);
  if (!bytes.length) throw new VideoAnalysisAsrError("audio_empty", "音频文件为空。", { retryable: false });
  const fileName = path.basename(audioPath) || "audio.mp3";

  report(onProgress, "uploading", { message: "正在上传音频到必剪。" });
  const resource = await bcutRequest(fetchImpl, BCUT_CREATE_RESOURCE_URL, {
    method: "POST", headers: BCUT_HEADERS,
    body: JSON.stringify({ type: 2, name: fileName, size: bytes.byteLength, ResourceFileType: "mp3", model_id: "8" }),
  }, "必剪音频上传申请", { signal });
  const data = resource.data;
  const uploadUrls = Array.isArray(data?.upload_urls) ? data.upload_urls : [];
  const perSize = Number(data?.per_size);
  if (!data?.in_boss_key || !data?.resource_id || !data?.upload_id || !uploadUrls.length || !Number.isFinite(perSize) || perSize <= 0) {
    throw new VideoAnalysisAsrError("bcut_upload_invalid", "必剪返回的上传信息不完整，请稍后重试。", { retryable: true });
  }

  const etags = [];
  for (let index = 0; index < uploadUrls.length; index += 1) {
    checkSignal(signal);
    const start = index * perSize;
    const end = Math.min((index + 1) * perSize, bytes.length);
    const response = await fetchImpl(uploadUrls[index], { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes.subarray(start, end), signal });
    if (!response.ok) throw new VideoAnalysisAsrError("bcut_upload_failed", `必剪第 ${index + 1} 个分片上传失败（HTTP ${response.status}）。`, { retryable: response.status >= 500 || response.status === 429 });
    const etag = typeof response.headers?.get === "function"
      ? response.headers.get("etag") ?? response.headers.get("Etag") ?? ""
      : response.headers?.etag ?? response.headers?.Etag ?? "";
    if (!etag) throw new VideoAnalysisAsrError("bcut_upload_invalid", "必剪没有返回音频分片校验值，请稍后重试。", { retryable: true });
    etags.push(etag.replace(/^"|"$/gu, ""));
    report(onProgress, "uploading", { current: end, total: bytes.length, message: `正在上传音频（${Math.round(end / bytes.length * 100)}%）。` });
  }

  const completedResource = await bcutRequest(fetchImpl, BCUT_COMPLETE_RESOURCE_URL, {
    method: "POST", headers: BCUT_HEADERS,
    body: JSON.stringify({ InBossKey: data.in_boss_key, ResourceId: data.resource_id, Etags: etags.join(","), UploadId: data.upload_id, model_id: "8" }),
  }, "必剪音频上传提交", { signal });
  const downloadUrl = completedResource.data?.download_url ?? data.download_url;
  if (!downloadUrl) throw new VideoAnalysisAsrError("bcut_upload_invalid", "必剪没有返回可识别的音频地址，请稍后重试。", { retryable: true });

  const task = await bcutRequest(fetchImpl, BCUT_CREATE_TASK_URL, {
    method: "POST", headers: BCUT_HEADERS,
    body: JSON.stringify({ resource: downloadUrl, model_id: "8" }),
  }, "必剪转写任务创建", { signal });
  const taskId = task.data?.task_id;
  if (!taskId) throw new VideoAnalysisAsrError("bcut_task_invalid", "必剪没有返回转写任务编号，请稍后重试。", { retryable: true });

  report(onProgress, "transcribing", { message: "必剪正在识别音频。" });
  let result = null;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    checkSignal(signal);
    const response = await bcutRequest(fetchImpl, `${BCUT_RESULT_URL}?model_id=7&task_id=${encodeURIComponent(taskId)}`, { headers: BCUT_HEADERS }, "必剪转写结果查询", { signal });
    result = response.data ?? null;
    if (result?.state === 4) break;
    if (result?.state === 3) throw new VideoAnalysisAsrError("bcut_failed", "必剪转写任务失败，请稍后重试。", { retryable: true });
    report(onProgress, "transcribing", { current: attempt + 1, total: maxPolls, message: "必剪正在识别音频。" });
    await abortableDelay(pollIntervalMs, signal);
  }
  if (result?.state !== 4) throw new VideoAnalysisAsrError("bcut_timeout", "必剪转写等待超时，请稍后重试。", { retryable: true });
  const segments = normalizeBcutSegments(result.result);
  report(onProgress, "complete", { message: "必剪转写完成。" });
  return segments;
}

function createOperationSignal(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new VideoAnalysisAsrError("asr_timeout", "视频转写等待超时，请稍后重试。", { retryable: true })), ASR_REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal?.reason ?? Object.assign(new Error("视频转写已取消。"), { name: "AbortError" }));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

export async function transcribeAudio({ engine = "bcut", audioPath, signal, onProgress, ...options } = {}) {
  if (!validEngine(engine)) throw new VideoAnalysisAsrError("invalid_engine", "不支持的转写引擎。", { retryable: false });
  if (typeof audioPath !== "string" || !audioPath.trim()) throw new VideoAnalysisAsrError("invalid_audio", "缺少待转写的音频文件。", { retryable: false });
  checkSignal(signal);
  const operation = createOperationSignal(signal);
  try {
    const result = engine === "bcut"
      ? await transcribeBcut(audioPath, { ...options, signal: operation.signal, onProgress })
      : await transcribeQwen(audioPath, { ...options, signal: operation.signal, onProgress });
    return result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (operation.signal.aborted && operation.signal.reason instanceof VideoAnalysisAsrError) throw operation.signal.reason;
    if (error instanceof VideoAnalysisAsrError || error?.name === "AbortError") throw error;
    throw new VideoAnalysisAsrError("asr_failed", `${engine === "bcut" ? "必剪" : "Qwen3-ASR"} 转写失败：${error?.message ?? "未知错误"}`, { retryable: true, cause: error });
  } finally {
    operation.cleanup();
  }
}

