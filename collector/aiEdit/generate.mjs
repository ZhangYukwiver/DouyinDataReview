import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { modelFetch } from "../systemProxy.mjs";
import { apiBaseUrl, networkFailure, providerMessage } from "../videoAnalysis.mjs";
import { AiEditError } from "./library.mjs";

// AI 剪辑里生成素材：generate_image 走 OpenAI 兼容的图片接口，generate_video 走火山方舟 Seedance 的异步任务。
// Key 是用户在 AI 剪辑设置里开启生成时填的（视频也可以借用已填的方舟 Key），每次随消息带来，采集器不写盘、不写日志、不进任何报错。
// 两边都按次扣费：创建请求只发一次、不自动重发；生成的文件下载进素材库（来源记成 generated），同样的说明再调直接回那一个。
// 视频要先经页面上用户点「生成」（ctx.askSpend，见 spend.mjs）才建任务。

export const IMAGE_DEFAULTS = { baseUrl: "https://api.openai.com/v1", model: "gpt-image-2.5-flare" };
export const VIDEO_DEFAULTS = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedance-2-0-260128" };

const MAX_NAME = 30;
const MAX_IMAGE_PROMPT = 4_000;
const MAX_VIDEO_PROMPT = 2_000;
// 一轮最多发几次生图请求、问几段视频：按尝试算（失败的、用户没同意的也算），模型原地打转时别一口气花掉太多
export const IMAGES_PER_TURN = 6;
export const VIDEOS_PER_TURN = 2;
const MAX_IMAGE_REFS = 4;
const MAX_VIDEO_REFS = 9;
const IMAGE_TIMEOUT_MS = 5 * 60_000;
// OpenAI 参考图单张小于 50MB；方舟每张小于 30MB、宽高 300–6000、宽高比 0.4–2.5
const OPENAI_REF_BYTES = 50 * 1024 ** 2;
const ARK_REF_BYTES = 30 * 1024 ** 2;
const MAX_IMAGE_BYTES = 50 * 1024 ** 2;
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const CREATE_TIMEOUT_MS = 2 * 60_000;
const QUERY_TIMEOUT_MS = 30_000;
// 下面几个等待按 ctx.pollMs 算（正式环境 1 秒，测试里调小）。
// 前台（这一轮）从用户点「生成」起最多等 20 分钟，下载也算在里面；到点不放弃，转到后台接着等。
// 本机 CLI 的工具超时是 45 分钟：确认最多 15 分钟 + 前台 20 分钟 + 现查一次、取消排队各半分钟，够用
const VIDEO_WAIT_POLLS = 20 * 60;
// 后台从建任务起最多跟 3 小时：排队最多 1 小时（execution_expires_after），再留两小时生成和下载
const VIDEO_GIVE_UP_POLLS = 3 * 60 * 60;
const DOWNLOAD_ATTEMPTS = 5;
// 下载失败后歇多久再试：5 秒、20 秒、1 分钟、2 分钟，跨三分多钟，扛得过断网、切代理这类小波动
const DOWNLOAD_PAUSES = [5, 20, 60, 120];
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// 建任务结果不明的、做好了没下载下来的，同样的说明再调时还认（方舟的视频链接 24 小时有效）
const JOB_KEEP_MS = 24 * 60 * 60_000;
// 方舟整个请求体不超过 64MB：参考图转成 base64 后加起来留点余量
const ARK_BODY_CHARS = 60 * 1024 ** 2;
// 这些网络错误说明请求还没发出去（域名解析不了、拒绝连接、证书不对、连接超时），任务肯定没建
const NOT_SENT = /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/u;

// 生成视频的任务登记（素材库目录 + 去重 key → job）：同样的说明再调时先看这里，别再问一次、再建一个任务、再扣一次钱。
// job：{ slot, name, taskId, status, videoUrl, promise, at, stopped, redownload, controller, signal, wake }。
// status：asking（正在请用户确认，还没建任务）、creating（建任务的请求还在路上）、queued、running、succeeded（做好了，钱已扣）、
// unknown（建任务没收到明确答复）。asking 时就先占上：别的剪辑同样的说明再调，不再弹一张卡片、不再建一个任务。
// 还在跑的（promise 不为空）同样的说明再调回「还在生成」；入库了、取消了、失败了、用户没同意就撤掉；
// unknown 和做好了没下载下来的 succeeded 留 24 小时：前者直接回「先去控制台看看」，后者拿原任务重新下载，都不问、不建。
const videoJobs = new Map();

const IMAGE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
// gpt-image-2 起能自定义宽高（16 的倍数、约 130 万像素，同 openfilm）；别的模型只认三种标准尺寸
const CUSTOM_SIZES = { "16:9": "1536x864", "9:16": "864x1536", "1:1": "1024x1024", "4:3": "1344x1008", "3:4": "1008x1344", "3:2": "1536x1024", "2:3": "1024x1536" };
const STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const QUALITIES = ["low", "medium", "high"];
const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const RESOLUTIONS = ["480p", "720p", "1080p"];
// 估价用的像素数：方舟按 宽 × 高 × 24 帧 / 1024 算 token
const PIXELS = { "480p": 414_720, "720p": 921_600, "1080p": 2_073_600 };
// 方舟 2026-10 的官方价（元/百万 token，不含输入视频），按模型 id 前缀认；长的先比，2-0-fast、2-0-mini 才不会被当成 2-0
const VIDEO_PRICES = [
  ["doubao-seedance-2-5", { "480p": 70, "720p": 70, "1080p": 77 }],
  ["doubao-seedance-2-0-fast", { "480p": 37, "720p": 37 }],
  ["doubao-seedance-2-0-mini", { "480p": 23, "720p": 23 }],
  ["doubao-seedance-2-0", { "480p": 46, "720p": 46, "1080p": 51 }],
].sort(([left], [right]) => right.length - left.length);

const IMAGE_FORMATS = { png: ".png", jpeg: ".jpg", webp: ".webp" };
const REUSED = "之前用同样的说明生成过，直接用这个；要新的一版就改改说明。";
const IMAGE_NOTE = "还没放上时间线：用 add_media_clip 放进视频轨道（比例和画布不一样时用 fit cover 铺满，或者按需缩放）。";
const VIDEO_NOTE = "还没放上时间线：用 add_media_clip 放进视频轨道。";

// ---------- 配置 ----------

// 用户常把整条接口地址粘进来：去掉末尾的具体接口，只留版本路径
const ENDPOINT_TAIL = /\/(?:images\/(?:generations|edits)|contents\/generations\/tasks)$/iu;

function parseProvider(raw, defaults, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const apiKey = text(raw.apiKey, 500);
  if (!apiKey) return null;
  const given = text(raw.baseUrl, 300).replace(/\/+$/u, "").replace(ENDPOINT_TAIL, "");
  const baseUrl = given ? apiBaseUrl(given) : defaults.baseUrl;
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AiEditError("invalid_config", `${label}的接口地址要以 https:// 开头。`);
  return { baseUrl, apiKey, model: text(raw.model, 100) || defaults.model };
}

/** 请求体里的生成配置：信任边界。填了 Key 的那项才算配了，都没配回 null。 */
export function parseGenerateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const image = parseProvider(raw.image, IMAGE_DEFAULTS, "生成图片");
  const video = parseProvider(raw.video, VIDEO_DEFAULTS, "生成视频");
  if (!image && !video) return null;
  return { ...(image ? { image } : {}), ...(video ? { video } : {}) };
}

/** 估价（人民币元，两位小数）：秒数 × 像素数 × 24 / 1024 个 token × 单价；认不出的模型回 null。 */
export function estimateVideoCost(model, seconds, resolution) {
  const id = String(model ?? "").toLowerCase();
  const price = VIDEO_PRICES.find(([prefix]) => id.startsWith(prefix))?.[1][resolution];
  if (!price || !PIXELS[resolution]) return null;
  return Math.round(((seconds * PIXELS[resolution] * 24) / 1024) * (price / 1e6) * 100) / 100;
}

// ---------- 小工具 ----------

/** 接口原文偶尔会回显一截 Key（OpenAI 的「Incorrect API key provided: sk-…」），给人看之前抹掉。 */
function scrub(message, apiKey) {
  // 太短的不当 Key 抹（真 Key 都很长），免得把正常的字也抹掉
  const text = apiKey && apiKey.length >= 8 ? String(message).split(apiKey).join("***") : String(message);
  return text.replace(/\bsk-[A-Za-z0-9_*.-]{4,}/gu, "sk-***");
}

function promptOf(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AiEditError("arguments_invalid", "说明是空的：写清楚要生成什么画面。");
  if (text.length > max) throw new AiEditError("arguments_invalid", `说明太长了，写在 ${max} 字以内。`);
  return text;
}

function nameOf(value, prompt) {
  const clean = (text) => String(text).replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean(typeof value === "string" ? value : "").slice(0, MAX_NAME) || clean(prompt).slice(0, 15);
}

function pick(value, allowed, what) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new AiEditError("arguments_invalid", `${what}只能是 ${allowed.join("、")} 之一。`);
  return value;
}

const ratioOf = (text) => {
  const [width, height] = text.split(/[:x]/u).map(Number);
  return Math.log(width / height);
};

/** 离 width/height 最近的比例（按对数比，横竖对称）。 */
function closest(width, height, options) {
  const target = Math.log(width / height);
  return options.reduce((best, option) => (Math.abs(ratioOf(option) - target) < Math.abs(ratioOf(best) - target) ? option : best));
}

async function canvasRatio(ctx, options) {
  let canvas = null;
  try { canvas = (await ctx.store?.getProject(ctx.projectId))?.canvas; } catch { /* 工程读不出来就按竖屏 */ }
  return closest(canvas?.width || 1080, canvas?.height || 1920, options);
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** 素材库里的 media_id 列表：去重、限量。 */
function idList(value, max, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new AiEditError("arguments_invalid", `${what}要填素材库里图片素材的编号列表。`);
  const ids = [...new Set(value)];
  if (ids.length > max) throw new AiEditError("arguments_invalid", `${what}最多 ${max} 张。`);
  return ids;
}

/** 素材库里一张就绪的图片：读出字节，按文件头认格式。 */
async function readReference(ctx, id, maxBytes, who) {
  const file = ctx.library.readyPath(id);
  const item = ctx.library.get(id);
  if (item.kind !== "image") throw new AiEditError("not_image", `“${item.name}”不是图片，参考图只能用图片素材。`);
  if ((await stat(file)).size > maxBytes) throw new AiEditError("image_too_large", `“${item.name}”超过 ${maxBytes / 1024 ** 2}MB，${who}收不下，换一张小一点的图。`);
  const bytes = await readFile(file);
  const format = imageFormat(bytes);
  if (!format) throw new AiEditError("image_unsupported", `“${item.name}”不是 PNG、JPEG 或 WebP 图片，换一张。`);
  return { item, bytes, format };
}

const generationKey = (fields) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

/** 同样的说明和参数生成过、还在素材库里的那一个。 */
const generatedBefore = (library, key) => library.list().find((item) => item.source?.type === "generated" && item.source.key === key && item.status === "ready") ?? null;

/** 网络错误、超时换成人话；用户点了停止原样抛（AbortError）。 */
function requestFailure(error, signal, timeoutText) {
  if (signal?.aborted || error instanceof AiEditError) return error;
  if (error?.name === "TimeoutError") return new AiEditError("generate_timeout", timeoutText, 504);
  const failure = networkFailure(error);
  if (failure) return new AiEditError("network_error", `${failure.text.replace(/。$/u, "")}。没有自动重发（重发会重复扣费）。`, 502);
  return error;
}

/**
 * 给报错配一句给人看的话（userText，页面的步骤列表用它整句换掉「生成了视频…」），给模型的 message 不变。
 * declined：用户自己选了不生成，页面不画成失败。
 */
const human = (error, userText, { declined = false } = {}) => Object.assign(error, { userText, ...(declined ? { declined } : {}) });

/** 等 promise，用户点了停止就先抛 AbortError（promise 自己接着跑）。 */
function untilStopped(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** 文件挪进素材库（临时文件命名成 <32 位 hex>.<后缀>.part，崩溃后素材库启动时会清掉）。 */
async function adopt(ctx, temp, { name, extension, source }) {
  try {
    return await ctx.library.adopt(temp, { name, extension, source });
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const tempFile = (ctx, extension) => path.join(ctx.library.root, `${randomBytes(16).toString("hex")}${extension}.part`);

// ---------- 生成图片（OpenAI 兼容） ----------

function openaiError(status, raw, { edits, apiKey }) {
  let code = "";
  let detail = "";
  try {
    const parsed = JSON.parse(raw);
    code = `${parsed?.error?.code ?? parsed?.code ?? ""} ${parsed?.error?.type ?? ""}`;
    detail = String(parsed?.error?.message ?? parsed?.message ?? "");
  } catch { /* 网关的错误页之类，按状态码说 */ }
  const all = `${code} ${detail}`;
  const fail = (errorCode, text, httpStatus = 502) => new AiEditError(errorCode, scrub(text, apiKey), httpStatus);
  if (/moderation_blocked/iu.test(all)) return fail("moderation_blocked", "内容审核没通过，图片没生成。改改说明再试：别写真人名字、品牌标志、暴力或色情的内容。", 422);
  if (status === 401) return fail("generate_key_invalid", "生成图片的 Key 不对，到 AI 剪辑设置里检查一下。", 401);
  if (status === 403 && /verif/iu.test(all)) return fail("organization_unverified", "要先在 OpenAI 后台完成组织验证（Organization Verification）才能用这个图片模型，验证完可能要等十几分钟才生效。", 403);
  if (status === 403) return fail("generate_forbidden", "这个 Key 没有权限用这个图片模型，或者所在地区不支持。", 403);
  if (status === 429 && /insufficient_quota|credit|billing|spend_limit/iu.test(all)) return fail("quota_exceeded", "图片接口的余额或额度不够了，充值或调高额度后再试。", 402);
  if (status === 429) return fail("rate_limited", "生成图片太频繁了，稍后再试。", 429);
  // one-api 的改图接口直接回 501 api_not_implemented
  if (edits && (status === 404 || status === 501 || /not_implemented/iu.test(all))) return fail("references_unsupported", "这个接口不支持参考图，去掉参考图再试。", 422);
  // new-api / one-api 模型名写错、分组没开通时回 503 + model_not_found（或「无可用渠道」）：配置问题，等多久都不会好
  if (status === 503 && /model_not_found|无可用渠道|no available channel/iu.test(all)) return fail("provider_error", `图片没生成出来：${providerMessage(status, raw)}`, 502);
  if (status >= 500) return fail("provider_unavailable", `图片服务暂时不可用（${status}）${detail ? `，服务商说：${detail.slice(0, 240)}` : ""}。稍后再试。`, 502);
  if (status === 200) return fail("provider_error", `图片接口没回图片${detail ? `：${detail.slice(0, 240)}` : "，换个模型或稍后再试。"}`, 502);
  return fail("provider_error", `图片没生成出来：${providerMessage(status, raw)}`, 502);
}

/** signal 带着生图那 5 分钟的计时，stopped 是用户的停止：计时到了要报成超时，不能当停止原样抛。 */
async function downloadImage(fetchImpl, url, signal, stopped) {
  let response;
  let bytes;
  try {
    response = await fetchImpl(url, { signal });
    if (response.ok && !(Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES)) bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw requestFailure(error, stopped, "图已经生成了，但下载太久没下完；接口那边多半已经扣费，跟用户说一声再决定要不要重新生成。");
  }
  if (!response.ok) throw new AiEditError("download_failed", `生成的图片没下载下来（${response.status}），稍后再试。`, 502);
  if (!bytes || bytes.length > MAX_IMAGE_BYTES) throw new AiEditError("download_failed", "生成的图片太大了，下载不下来。", 502);
  return bytes;
}

/** 发一次生成请求（不重发），回图片字节和格式。 */
async function requestImage(ctx, config, { prompt, size, quality, transparent, refs }) {
  const fields = { model: config.model, prompt, size, quality, output_format: "png", n: 1, ...(transparent ? { background: "transparent" } : {}) };
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  let body;
  if (refs.length) {
    // 有参考图走 /images/edits：multipart，每张一个 image[] 字段；Content-Type 交给 fetch 带上 boundary
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    refs.forEach((ref, index) => body.append("image[]", new Blob([ref.bytes], { type: `image/${ref.format}` }), `reference-${index + 1}${IMAGE_FORMATS[ref.format]}`));
  } else {
    body = JSON.stringify(fields);
    headers["Content-Type"] = "application/json";
  }
  const fetchImpl = ctx.fetchImpl ?? modelFetch;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)].filter(Boolean));
  const timeoutText = "图片 5 分钟还没生成好，这边先断开了；接口那边可能已经扣费，过一会儿再试，或者把说明写简单点、清晰度调低。";
  let status;
  let raw;
  try {
    const response = await fetchImpl(`${config.baseUrl}/images/${refs.length ? "edits" : "generations"}`, { method: "POST", headers, body, signal });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    throw requestFailure(error, ctx.signal, timeoutText);
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 下面按没回图片处理 */ }
  const first = status >= 200 && status < 300 ? data?.data?.[0] : null;
  if (!first) throw openaiError(status >= 200 && status < 300 ? 200 : status, raw, { edits: refs.length > 0, apiKey: config.apiKey });
  let bytes;
  if (typeof first.b64_json === "string" && first.b64_json) bytes = Buffer.from(first.b64_json, "base64");
  // 有的中转站回链接：下载时不带 Key
  else if (typeof first.url === "string" && /^https?:\/\//iu.test(first.url)) bytes = await downloadImage(fetchImpl, first.url, signal, ctx.signal);
  else throw openaiError(200, raw, { edits: refs.length > 0, apiKey: config.apiKey });
  const format = imageFormat(bytes);
  if (!format) throw new AiEditError("provider_error", "图片接口回的不是 PNG、JPEG 或 WebP 图片。", 502);
  return { bytes, format };
}

/** generate_image：回 { item（素材库里的那一条）, note, reused? }，外层再换成给模型看的样子。 */
export async function generateImage(ctx, args) {
  const config = ctx.generation?.image;
  if (!config) throw new AiEditError("generate_unavailable", "还没在 AI 剪辑设置里填生成图片的 Key，这个工具现在用不了。", 409);
  const prompt = promptOf(args.prompt, MAX_IMAGE_PROMPT);
  const name = nameOf(args.name, prompt);
  const ratio = pick(args.ratio, IMAGE_RATIOS, "画面比例") ?? await canvasRatio(ctx, IMAGE_RATIOS);
  const size = /^gpt-image-2/iu.test(config.model) ? CUSTOM_SIZES[ratio] : closest(...ratio.split(":").map(Number), STANDARD_SIZES);
  const quality = pick(args.quality, QUALITIES, "画质") ?? "medium";
  const transparent = args.transparent === true;
  const refIds = idList(args.reference_media_ids, MAX_IMAGE_REFS, "参考图");
  const key = generationKey({ kind: "image", model: config.model, prompt, size, quality, transparent, refs: refIds });
  const existing = generatedBefore(ctx.library, key);
  if (existing) return { item: existing, reused: true, note: REUSED };
  if (ctx.generated && ctx.generated.images >= IMAGES_PER_TURN) {
    throw human(new AiEditError("generate_limit", `这一轮已经发了 ${IMAGES_PER_TURN} 次生成图片的请求（没成功的也算，接口那边可能已经扣费），到上限了。先用已经生成的，还要更多就跟用户说一声，等用户下一句话再生成。`, 429),
      `这一轮生成图片到上限了，“${name}”没生成`);
  }
  ctx.library.assertRoom();
  const refs = [];
  for (const id of refIds) refs.push(await readReference(ctx, id, OPENAI_REF_BYTES, "图片接口"));
  // 请求发出去就算一次：超时、断线、下载失败、回的不是图时接口那边都可能已经扣费
  if (ctx.generated) ctx.generated.images += 1;
  ctx.onGenerating?.(`正在生成图片“${name}”，一般要半分钟到两分钟…`);
  let generated;
  try {
    generated = await requestImage(ctx, config, { prompt, size, quality, transparent, refs });
  } finally {
    ctx.onGenerating?.(null);
  }
  const { bytes, format } = generated;
  const temp = tempFile(ctx, IMAGE_FORMATS[format]);
  await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  const item = await adopt(ctx, temp, {
    name, extension: IMAGE_FORMATS[format],
    source: { type: "generated", provider: "openai", model: config.model, prompt: prompt.slice(0, 200), key },
  });
  return { item, note: IMAGE_NOTE };
}

// ---------- 生成视频（火山方舟 Seedance） ----------

function arkError(status, raw, { apiKey, model }) {
  let code = "";
  let detail = "";
  try {
    const parsed = JSON.parse(raw);
    code = String(parsed?.error?.code ?? parsed?.code ?? "");
    detail = String(parsed?.error?.message ?? parsed?.message ?? "");
  } catch { /* 网关的错误页之类，按状态码说 */ }
  const fail = (errorCode, text, httpStatus = 502) => new AiEditError(errorCode, scrub(text, apiKey), httpStatus);
  if (/ModelNotOpen/iu.test(code)) return fail("model_not_open", `这个方舟账号还没开通 ${model}：到火山方舟控制台的「开通管理」里开通这个 Seedance 模型（开通要求账户余额不少于 200 元）。`, 403);
  if (/ServiceNotOpen/iu.test(code)) return fail("service_not_open", "这个方舟账号还没开通模型服务：到火山方舟控制台开通后再试。", 403);
  if (/AccountOverdue|ServiceOverdue/iu.test(code)) return fail("account_overdue", "方舟账户欠费了，充值后再试。", 402);
  if (/InvalidEndpointOrModel/iu.test(code)) return fail("model_not_found", `视频模型名 ${model} 不对，或者这个 Key 没有权限用它，到 AI 剪辑设置里检查一下。`, 404);
  if (/PrivacyInformation/iu.test(code)) return fail("real_face", "参考图里有真人脸，Seedance 不收这种图：换一张没有真人脸的图，或者不用参考图。", 422);
  if (/SensitiveContent/iu.test(code)) return fail("moderation_blocked", "内容审核没通过，视频没生成。改改说明或换一张参考图再试。", 422);
  if (status === 401) return fail("generate_key_invalid", "生成视频的 Key 不对，到 AI 剪辑设置里检查一下。", 401);
  // 方舟的 429 不全是限流：用量上限、额度、并发上限这几种等多久都不会好，要去控制台处理
  if (/SetLimitExceeded/iu.test(code)) return fail("usage_limit_reached", "这个方舟账号给模型设的用量上限到了，服务暂停了：到火山方舟控制台的「开通管理」里调高用量上限，或者关掉安心体验模式（模型名填的是接入点的话，到接入点详情页改）。", 402);
  if (/AccountQuotaExceeded/iu.test(code)) return fail("quota_exceeded", "方舟账户的额度不够了：到火山方舟控制台充值或调高额度后再试。", 402);
  if (/InflightBatchsizeExceeded/iu.test(code)) return fail("quota_exceeded", "方舟账户同时在做的任务数到上限了（上限跟充值金额挂钩）：等手头的任务做完再试，或者到火山方舟控制台充值提高上限。", 402);
  if (/QuotaExceeded/iu.test(code) && /free trial/iu.test(detail)) return fail("quota_exceeded", "这个模型的免费试用额度用完了：到火山方舟控制台的「开通管理」里开通模型服务后再用。", 402);
  if (status === 429) return fail("rate_limited", "方舟那边请求太频繁了，稍后再试。", 429);
  if (status >= 500) return fail("provider_unavailable", `方舟视频服务暂时不可用（${status}），稍后再试。`, 502);
  if (!status) return fail("generate_failed", `视频没生成出来${detail ? `：${detail.slice(0, 240)}` : "，原因方舟没说，换个说法再试。"}`, 502);
  return fail("provider_error", `视频没生成出来：${providerMessage(status, raw)}`, 502);
}

/** 方舟收的参考图：素材库里就绪的图片，查过大小、宽高和比例，转成 data URL。 */
async function arkImage(ctx, id, role) {
  const { item, bytes, format } = await readReference(ctx, id, ARK_REF_BYTES, "Seedance");
  const { width, height } = item;
  if (width && height) {
    if (Math.min(width, height) < 300 || Math.max(width, height) > 6000) {
      throw new AiEditError("image_size_invalid", `“${item.name}”是 ${width}×${height}，Seedance 要求宽和高都在 300 到 6000 像素之间，换一张。`);
    }
    if (width / height < 0.4 || width / height > 2.5) {
      throw new AiEditError("image_size_invalid", `“${item.name}”太细长了（${width}×${height}），Seedance 只收宽高比在 0.4 到 2.5 之间的图，换一张。`);
    }
  }
  return { type: "image_url", image_url: { url: `data:image/${format};base64,${bytes.toString("base64")}` }, role };
}

const tasksUrl = (config, id) => `${config.baseUrl}/contents/generations/tasks${id ? `/${encodeURIComponent(id)}` : ""}`;

/** 发一次 GET 或 DELETE；网络错误、超时、408、429、5xx 标成 transient（查进度时歇一下再试），别的 4xx 直接是方舟的报错。 */
async function arkRequest(ctx, config, url, { method = "GET", signal }) {
  let status;
  let raw;
  try {
    const response = await (ctx.fetchImpl ?? modelFetch)(url, { method, headers: { Authorization: `Bearer ${config.apiKey}` }, signal });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const failure = error?.name === "TimeoutError" ? { text: "方舟 30 秒没回话" } : networkFailure(error);
    if (!failure) throw error;
    throw Object.assign(new AiEditError("network_error", failure.text, 502), { transient: true });
  }
  if (status >= 200 && status < 300) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  throw Object.assign(arkError(status, raw, config), { transient: status === 408 || status === 429 || status >= 500 });
}

/**
 * 现查一次任务（查不到回 null）。取消之前用它，不信 job.status：轮询连着失败时 job.status 停在上次查到的 queued，
 * 方舟上可能早就做完扣费了，对做好的任务 DELETE 会把任务记录删掉（也回成功），钱扣了视频却再也找不回来。
 */
async function currentTask(ctx, config, job) {
  try {
    const task = await arkRequest(ctx, config, tasksUrl(config, job.taskId), { signal: AbortSignal.any([job.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]) });
    return typeof task?.status === "string" ? task : null;
  } catch {
    return null;
  }
}

/** 方舟说任务结束了却没做成（失败、过期、被取消，都不扣费）：换成给模型的话；还没结束或做成了回 null。 */
function endedError(task, config) {
  if (task?.status === "failed") return arkError(0, JSON.stringify({ error: task.error ?? {} }), config);
  if (task?.status === "expired") return new AiEditError("generate_expired", "排队超过一小时还没轮到，任务过期了，没有扣费。稍后再试。", 504);
  if (task?.status === "cancelled") return new AiEditError("generate_cancelled", "这个任务被取消了，没有扣费。", 409);
  return null;
}

/** 排队中的任务取消掉（不扣费）；已经开始做的取消不了，回 false。只在刚查到还在排队时调。 */
async function cancelTask(ctx, config, taskId) {
  try {
    await arkRequest(ctx, config, tasksUrl(config, taskId), { method: "DELETE", signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function isMp4(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return bytesRead >= 8 && buffer.toString("latin1", 4, 8) === "ftyp";
  } finally {
    await handle.close();
  }
}

/** 方舟给的视频链接（24 小时有效，不带 Key）：先写 .part，失败了歇一下再试，最多 5 次。 */
async function downloadVideo(ctx, url, signal, taskId) {
  const fetchImpl = ctx.fetchImpl ?? modelFetch;
  const unit = ctx.pollMs ?? 1_000;
  const temp = tempFile(ctx, ".mp4");
  let reason = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) });
      if (!response.ok || !response.body) throw new Error(`下载链接返回 ${response.status}`);
      if (Number(response.headers.get("content-length")) > MAX_VIDEO_BYTES) throw new Error("文件太大");
      let received = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received > MAX_VIDEO_BYTES ? new Error("文件太大") : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temp, { flags: "w", mode: 0o600 }));
      if (!(await isMp4(temp))) throw new Error("下载下来的不是 mp4");
      return temp;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      if (signal.aborted) throw error;
      reason = networkFailure(error)?.text?.replace(/。$/u, "") ?? (error?.name === "TimeoutError" ? "下载太久了" : error?.message ?? "原因不明");
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(DOWNLOAD_PAUSES[attempt - 1] * unit, undefined, { signal });
    }
  }
  // job 还留在登记里（做好了、钱扣了）：同样的说明再调就拿这个任务重新下载
  throw new AiEditError("download_failed", `视频生成好了，但下载了 ${DOWNLOAD_ATTEMPTS} 次都没下下来（${reason}）。钱已经扣了，别换说法重新生成：用同样的参数再调一次 generate_video 会直接重新下载这一段，不会再扣钱，也不用用户再确认。方舟任务号 ${taskId}，也可以到火山方舟控制台按任务号下载（链接 24 小时内有效）。`, 502);
}

/** 建任务出了岔子、又说不准方舟那边建没建上：同样的说明再调时也不再建（job 记成 unknown）。 */
const unclear = (why) => Object.assign(new AiEditError("create_uncertain", `建任务时${why}，不知道任务建没建上，可能已经在生成并扣费：先别重试，到火山方舟控制台的视频生成任务里看看。`, 502), { uncertain: true });

/** 建任务：只发一次、不自动重发，拿到任务号记进 job。 */
async function createTask(ctx, config, job, body) {
  let status = 0;
  let raw = "";
  try {
    const response = await (ctx.fetchImpl ?? modelFetch)(tasksUrl(config), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 建任务不跟着「停止」断开：断在半路就不知道任务建没建，钱可能照扣、视频却拿不到
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    const failure = networkFailure(error);
    // 连不上（域名、拒绝连接、证书、连接超时）：请求没发出去，肯定没建
    if (!status && failure && NOT_SENT.test(String(error.cause?.code ?? ""))) {
      throw new AiEditError("network_error", `${failure.text.replace(/。$/u, "")}。请求没发出去，任务没建上，没扣费。`, 502);
    }
    if (status) throw unclear("方舟的答复读到一半连接断了");
    if (error?.name === "TimeoutError") throw unclear("方舟 2 分钟没回话");
    throw unclear(`没收到方舟的答复（${error?.cause?.code || error?.message || "原因不明"}）`);
  }
  if (status >= 200 && status < 300) {
    let created = null;
    try { created = JSON.parse(raw); } catch { /* 下面按没给任务号处理 */ }
    // 回了成功却没给任务号（不是 JSON、被中转站包了一层）：任务多半已经建上了
    if (typeof created?.id !== "string" || !created.id) throw unclear("方舟回了成功，却没给任务编号");
    job.taskId = created.id;
    job.status = "queued";
    return;
  }
  // 网关、中转站回的 5xx 和 408：可能上游已经建好了
  if (status >= 500 || status === 408) throw unclear(`方舟回了 ${status}`);
  throw arkError(status, raw, config);
}

/** 后台跟到上限还没做完：放弃，带上任务号（方舟上做完可能照样扣费）。 */
const givenUp = (job, missed = "") => new AiEditError("generate_timeout", `跟了 3 小时视频还没做完${missed ? `（最后没查到进度：${missed.replace(/。$/u, "")}）` : ""}，这边不等了。方舟上做完可能照样扣费，到火山方舟控制台的视频生成任务里按任务号 ${job.taskId} 找。`, 504);

/** 轮询间歇：歇 ms，或者被 job.wake 叫醒（前台现查到任务有结果了，马上去收）。 */
function nap(job, ms) {
  const wake = new AbortController();
  job.wake = () => wake.abort();
  return delay(ms, undefined, { signal: AbortSignal.any([job.signal, wake.signal]) })
    .catch((error) => { if (job.signal.aborted) throw error; })
    .finally(() => { job.wake = null; });
}

/**
 * 建任务（job 已经有任务号就跳过：做好了没下载下来的重新下载）→ 轮询到结束 → 下载进素材库。
 * job 和外面共用：前台不等了（用户点停止、等满 20 分钟）时外面现查一次状态，决定取消还是让它在后台做完；
 * job.signal 是「放弃」（取消成功或采集器关掉），和前台等不等无关。回 { item, tokens }，取消了回 null。
 */
async function runVideoJob(ctx, config, job, { body, name, source }) {
  if (!job.taskId) {
    await createTask(ctx, config, job, body);
    // 建任务的时候用户已经点了停止：刚建好肯定还在排队，取消掉；没取消成功（断网、限流）下面轮询时接着试
    if (job.stopped && await cancelTask(ctx, config, job.taskId)) return null;
  }
  // 正式环境 ctx.pollMs 是 1 秒，方舟按 10 倍间隔查（10 秒后第一次，之后每 10 秒）；测试里调小
  const unit = ctx.pollMs ?? 1_000;
  const every = unit * 10;
  const giveUpAt = Date.now() + VIDEO_GIVE_UP_POLLS * unit;
  // 重新下载的任务早就做好了：马上查一次拿链接
  let wait = job.status === "succeeded" ? 0 : every;
  let misses = 0;
  let task = null;
  for (;;) {
    if (wait) await nap(job, wait);
    // 到了上限也先再查一次：做完了照常收，还没结束才放弃
    const late = Date.now() > giveUpAt;
    try {
      task = await arkRequest(ctx, config, tasksUrl(config, job.taskId), { signal: AbortSignal.any([job.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]) });
      misses = 0;
      wait = every;
    } catch (error) {
      if (job.signal.aborted || !error?.transient) throw error;
      if (late) throw givenUp(job, error.message);
      // 断网、超时、限流、方舟 5xx 都是一时的，任务还在方舟上跑，不能因为查不到就丢下：间隔翻倍往后退，最长一分钟
      misses += 1;
      wait = Math.min(every * 2 ** (misses - 1), every * 6);
      continue;
    }
    job.status = task?.status ?? job.status;
    // 用户点了停止、刚查到还在排队：再试着取消（上一次碰上断网、限流没取消成功），跟着轮询的间隔一直试到它开跑
    if (job.stopped && task?.status === "queued" && await cancelTask(ctx, config, job.taskId)) return null;
    if (task?.status === "succeeded") break;
    const ended = endedError(task, config);
    if (ended) throw ended;
    if (late) throw givenUp(job);
  }
  const url = task.content?.video_url;
  if (typeof url !== "string" || !/^https?:\/\//iu.test(url)) {
    throw new AiEditError("provider_error", `方舟说视频生成好了，但没给下载链接。钱已经扣了，别换说法重新生成：过一会儿用同样的参数再调一次会重新去取，不会再扣钱；也可以到火山方舟控制台按任务号 ${job.taskId} 下载。`, 502);
  }
  job.videoUrl = url;
  const temp = await downloadVideo(ctx, url, job.signal, job.taskId);
  const item = await adopt(ctx, temp, { name, extension: ".mp4", source });
  const tokens = task.usage?.completion_tokens;
  return { item, tokens: Number.isFinite(tokens) ? tokens : null };
}

/** 新开（或重新下载时重开）一次：放弃信号跟着采集器关掉走。redownload：做好了没下载下来、这次只是重新下载（不再扣钱）。 */
function armJob(job, ctx, { redownload = false } = {}) {
  job.stopped = false;
  job.redownload = redownload;
  job.controller = new AbortController();
  job.signal = AbortSignal.any([job.controller.signal, ctx.shutdown].filter(Boolean));
}

/** 登记 job、盯着它结束：入库了、取消了、失败了就撤掉；建任务结果不明的、做好了没下载下来的留着（见 videoJobs）。 */
function track(job, promise) {
  job.promise = promise;
  videoJobs.set(job.slot, job);
  const drop = () => { if (videoJobs.get(job.slot) === job) videoJobs.delete(job.slot); };
  promise.then(drop, (error) => {
    job.promise = null;
    job.at = Date.now();
    if (error?.uncertain) job.status = "unknown";
    else if (job.status !== "succeeded") drop();
  });
}

/**
 * 前台等 job 做完。用户点了停止、或者从点「生成」起等满 20 分钟，就不等了：现查一次，还在排队的取消掉（不扣费）；
 * 已经开始做的停不下来、照样扣费，留在后台做完、照样放进素材库，记进 generated.background（带上阶段），这一轮结尾告诉用户。
 */
async function waitForVideo(ctx, config, job, status) {
  const waited = AbortSignal.timeout(VIDEO_WAIT_POLLS * (ctx.pollMs ?? 1_000));
  const foreground = AbortSignal.any([ctx.signal, waited].filter(Boolean));
  ctx.onGenerating?.(status);
  try {
    return await untilStopped(job.promise, foreground);
  } catch (error) {
    if (!foreground.aborted) throw error;
    const stopped = Boolean(ctx.signal?.aborted);
    if (stopped) job.stopped = true;
    // 只有现查到还在排队才取消；查不到的、已经开始做的一律当停不下来，转到后台
    const fresh = job.taskId && job.status !== "succeeded" ? await currentTask(ctx, config, job) : null;
    if (fresh) job.status = fresh.status;
    if (fresh?.status === "queued" && await cancelTask(ctx, config, job.taskId)) {
      job.controller.abort();
      if (stopped) throw error;
      throw new AiEditError("generate_timeout", "排了 20 分钟队还没轮到，这边取消了，没有扣费。稍后再试。", 504);
    }
    // 方舟上已经结束了却没做成：不扣费，也不用再跟
    const ended = endedError(fresh, config);
    if (ended) {
      job.controller.abort();
      if (stopped) throw error;
      throw ended;
    }
    // 现查到已经做好了：叫醒轮询马上去下载，不用等下一次
    if (fresh?.status === "succeeded") job.wake?.();
    ctx.generated?.background?.push({ name: job.name, ...(job.taskId ? { taskId: job.taskId } : {}), phase: videoPhase(job) });
    job.promise.catch((failure) => {
      if (failure?.name !== "AbortError") console.error("AI 剪辑转到后台的视频没放进素材库:", job.taskId ?? "任务没建上", failure?.code ?? failure?.name);
      else if (ctx.shutdown?.aborted && job.taskId) console.warn("AI 剪辑关掉时视频还没做完，方舟任务号:", job.taskId);
    });
    if (stopped) throw error;
    if (job.status === "succeeded") {
      const what = job.redownload ? "上次已经生成好了（不会再扣钱），还在重新下载" : "已经在方舟上生成好了（已经扣费），还在下载";
      throw new AiEditError("generate_background", `视频${what}（任务号 ${job.taskId}），下完会自动放进素材库。别再生成一次，过几分钟用 list_media 找它。`, 202);
    }
    throw new AiEditError("generate_background", `视频还在方舟上生成${job.taskId ? `（任务号 ${job.taskId}）` : ""}，做完会自动放进素材库，照常扣费。别再生成一次，过几分钟用 list_media 找它。`, 202);
  } finally {
    ctx.onGenerating?.(null);
  }
}

/**
 * 转到后台时这段走到哪一步了（决定这一轮结尾怎么说）：
 * submitted 刚提交、或者点停止时还在排队却没取消成功（建好后、轮询时还会接着取消）；generating 已经开始生成，停不下来、照常扣费；
 * downloading 已经生成好、扣了费，还在下载；redownload 上次做好没下载下来，这次重新下载，不会再扣钱。
 */
function videoPhase(job) {
  if (job.redownload) return "redownload";
  if (job.status === "succeeded") return "downloading";
  if (!job.taskId || (job.stopped && job.status === "queued")) return "submitted";
  return "generating";
}

/** 这一轮转到后台的视频（generated.background），回复末尾跟用户说清楚：按阶段说扣不扣费、会不会自己进素材库、关掉应用怎么办。 */
export function backgroundNote(background, { stopped = false } = {}) {
  if (!background?.length) return "";
  const named = ({ name, taskId }) => `“${name}”${taskId ? `（方舟任务号 ${taskId}）` : ""}`;
  const list = (phase) => background.filter((video) => video.phase === phase).map(named).join("、");
  const submitted = background.filter((video) => video.phase === "submitted");
  const lines = [
    list("generating") && `视频${list("generating")}还在方舟上生成${stopped ? "，停不下来" : ""}，做完会自动放进素材库，照常扣费。`,
    list("downloading") && `视频${list("downloading")}已经在方舟上生成好了，钱已经扣了，还在下载，下完会自动放进素材库。`,
    list("redownload") && `视频${list("redownload")}上次生成好了没下载下来，这次在重新下载，不会再扣钱，下完会自动放进素材库。`,
    submitted.length && `视频${list("submitted")}${submitted.every((video) => !video.taskId) ? "刚提交给方舟" : "已经提交给方舟"}，如果已经开始生成就停不下来，做完会自动放进素材库，照常扣费；还在排队的会取消，不扣费。`,
  ];
  const making = background.some((video) => video.phase === "generating" || video.phase === "submitted");
  const ids = background.some((video) => video.taskId);
  lines.push(`要开着应用等它${making ? "做完" : "下完"}；关掉的话，到火山方舟控制台的视频生成任务里${ids ? "按任务号" : ""}下载。`);
  return lines.filter(Boolean).join("");
}

/** generate_video：先查重，再请用户确认，同意了才建任务。回 { item, note, reused?, tokens? }。 */
export async function generateVideo(ctx, args) {
  const config = ctx.generation?.video;
  if (!config) throw new AiEditError("generate_unavailable", "还没在 AI 剪辑设置里填生成视频的 Key，这个工具现在用不了。", 409);
  const { model } = config;
  const prompt = promptOf(args.prompt, MAX_VIDEO_PROMPT);
  const name = nameOf(args.name, prompt);
  const notes = [];
  // 2.5 系列能生成 4–30 秒，其他 4–15 秒；超出就夹到范围里
  const [shortest, longest] = /^doubao-seedance-2-5/iu.test(model) ? [4, 30] : [4, 15];
  if (args.duration !== undefined && (typeof args.duration !== "number" || !Number.isFinite(args.duration))) throw new AiEditError("arguments_invalid", "时长要填秒数。");
  const asked = args.duration === undefined ? 5 : Math.round(args.duration);
  const duration = Math.min(longest, Math.max(shortest, asked));
  if (duration !== asked) notes.push(`这个模型只能生成 ${shortest} 到 ${longest} 秒，按 ${duration} 秒生成的。`);
  const resolution = pick(args.resolution, RESOLUTIONS, "清晰度") ?? "720p";
  if (resolution === "1080p" && /^doubao-seedance-2-0-(fast|mini)/iu.test(model)) {
    throw new AiEditError("arguments_invalid", "用户设的视频模型（fast 或 mini）只能出 480p 或 720p，清晰度改成 720p。");
  }
  // 2.5 的 1080p 是 10 位色深的 H.265：剪映和看板（Chromium）在不少电脑上放不了，花了钱拿到黑屏
  if (resolution === "1080p" && /^doubao-seedance-2-5/iu.test(model)) {
    throw new AiEditError("arguments_invalid", "2.5 系列出的 1080p 视频是 10 位色深的 H.265 编码，剪映和这台电脑上可能放不了，清晰度改成 720p。");
  }
  const first = typeof args.first_frame_media_id === "string" ? args.first_frame_media_id : null;
  const last = typeof args.last_frame_media_id === "string" ? args.last_frame_media_id : null;
  const refIds = idList(args.reference_media_ids, MAX_VIDEO_REFS, "参考图");
  if (last && !first) throw new AiEditError("arguments_invalid", "给了尾帧就要同时给首帧。");
  if (first && refIds.length) throw new AiEditError("arguments_invalid", "首帧尾帧和参考图是两种用法，不能同时给：要从某张图动起来就只给首帧（可加尾帧），要参考几张图的样子就只给参考图。");
  // 给了首帧（或首尾帧）时画面比例跟着首帧走
  const ratio = first ? "adaptive" : pick(args.ratio, VIDEO_RATIOS, "画面比例") ?? await canvasRatio(ctx, VIDEO_RATIOS);
  const audio = args.with_audio === true;
  const key = generationKey({ kind: "video", model, prompt, ratio, duration, resolution, audio, first, last, refs: refIds });
  const existing = generatedBefore(ctx.library, key);
  if (existing) return { item: existing, reused: true, note: REUSED };
  const slot = `${ctx.library.root}\n${key}`;
  let job = videoJobs.get(slot) ?? null;
  if (job && !job.promise && Date.now() - job.at > JOB_KEEP_MS) {
    videoJobs.delete(slot);
    job = null;
  }
  // 别的剪辑正在请用户确认同样的这段（还没建任务）：不再弹一张卡片
  if (job?.status === "asking") {
    throw human(new AiEditError("generate_pending", "另一个剪辑正在请用户确认或生成同样的这段视频，这次没再生成，也没花钱：别再调了，过几分钟用 list_media 找它；没有的话再跟用户说。", 409),
      `另一个剪辑正在确认或生成同样的视频“${name}”，这次没再生成`);
  }
  if (job?.promise) {
    // 上一轮点停止时这段还在提交、排队：还在排队的会被取消，别说「做完会自己放进素材库」
    if (job.stopped && (job.status === "creating" || job.status === "queued")) {
      throw human(new AiEditError("generate_pending", "上一轮停止时这段视频刚提交给方舟：排队中的会被取消、不扣费；已经开始生成的停不下来，做完会自己放进素材库。过一会儿用 list_media 看看，没有的话再调 generate_video，会重新请用户确认。", 409),
        `上一轮停止时视频“${name}”刚提交，这次没再生成`);
    }
    throw new AiEditError("generate_pending", "同样的这段视频还在方舟上生成，做完会自己放进素材库：过几分钟用 list_media 找它，别再生成一次。", 409);
  }
  if (job?.status === "unknown") {
    throw new AiEditError("create_uncertain", "上次建这段视频的任务时没收到方舟的明确答复，不知道建没建上，可能已经在生成并扣费：先别重试，到火山方舟控制台的视频生成任务里看看。用户看过确实没建上、还要这段，就把说明改一点再生成。", 409);
  }
  const source = { type: "generated", provider: "seedance", model, prompt: prompt.slice(0, 200), key };
  const finish = (result, extra = []) => {
    const seconds = result.item.durationUs ? Math.round(result.item.durationUs / 10_000) / 100 : duration;
    return {
      item: result.item,
      ...(result.tokens !== null ? { tokens: result.tokens } : {}),
      note: [...notes, ...extra, `生成了 ${seconds} 秒${audio ? "带声音" : "没有声音"}的视频。`, VIDEO_NOTE].join(""),
    };
  };
  if (job?.status === "succeeded") {
    // 做好了、钱扣了，上次没下载下来：拿原任务重新查一次链接再下载，不问用户、不建任务
    job.name = name;
    armJob(job, ctx, { redownload: true });
    track(job, runVideoJob(ctx, config, job, { name, source }));
    return finish(await waitForVideo(ctx, config, job, `正在重新下载视频“${name}”…`), ["上次生成好了没下载下来，这次重新下载好了，没有再扣钱。"]);
  }
  if (ctx.generated && (ctx.generated.videos ?? 0) >= VIDEOS_PER_TURN) {
    throw human(new AiEditError("generate_limit", `这一轮已经请用户确认过 ${VIDEOS_PER_TURN} 段视频（没同意的也算），到上限了。先用已经有的素材，还要更多就跟用户说一声，等用户下一句话再生成。`, 429),
      `这一轮生成视频到上限了，“${name}”没生成`);
  }
  ctx.library.assertRoom();
  // 参考图在问用户之前查好：不合格的别让用户白点一次确认
  const images = [];
  if (first) images.push(await arkImage(ctx, first, "first_frame"));
  if (last) images.push(await arkImage(ctx, last, "last_frame"));
  for (const id of refIds) images.push(await arkImage(ctx, id, "reference_image"));
  if (images.reduce((total, image) => total + image.image_url.url.length, 0) > ARK_BODY_CHARS) {
    throw new AiEditError("image_too_large", "参考图加起来太大了，Seedance 一次收不下：少用几张，或者换小一点的图。");
  }
  if (!ctx.askSpend) throw new AiEditError("spend_unavailable", "生成视频要用户在应用里点确认，要开着应用才能确认。", 409);
  // 问之前就算一段：用户没同意也算，免得模型一轮里反复弹确认
  if (ctx.generated) ctx.generated.videos = (ctx.generated.videos ?? 0) + 1;
  // 问之前先占上：确认最多挂 15 分钟，这期间别的剪辑同样的说明再调不再弹卡片；没同意、没人点、停止了就撤掉
  job = { slot, name, taskId: null, status: "asking", videoUrl: null, promise: null, at: Date.now() };
  videoJobs.set(slot, job);
  const release = () => { if (videoJobs.get(slot) === job) videoJobs.delete(slot); };
  try {
    await ctx.askSpend({
      kind: "video", provider: "火山方舟 Seedance", model, seconds: duration, resolution, ratio, audio,
      prompt: prompt.slice(0, 200), estimate: estimateVideoCost(model, duration, resolution),
    });
  } catch (error) {
    release();
    if (error?.code === "spend_denied") throw human(error, `你选了不生成视频“${name}”`, { declined: true });
    if (error?.code === "spend_timeout") throw human(error, `视频“${name}”等了 15 分钟没人确认，没有生成`);
    throw error;
  }
  // 等用户点的这段时间里可能已经有了（登记被别处换掉、素材库里有了这段）：再查一次，有了就不建
  const made = generatedBefore(ctx.library, key);
  if (made || videoJobs.get(slot) !== job) {
    release();
    if (made) return { item: made, reused: true, note: REUSED };
    throw new AiEditError("generate_pending", "同样的这段视频已经在生成了，这次没再建任务，也没花钱：过几分钟用 list_media 找它，别再生成一次。", 409);
  }
  Object.assign(job, { status: "creating", at: Date.now() });
  armJob(job, ctx);
  track(job, runVideoJob(ctx, config, job, {
    body: {
      model,
      content: [{ type: "text", text: prompt }, ...images],
      resolution, ratio, duration, generate_audio: audio, watermark: false,
      // 排队超过一小时就让方舟自己作废，别过两天突然做完扣费
      execution_expires_after: 3600,
    },
    name,
    source,
  }));
  return finish(await waitForVideo(ctx, config, job, `正在生成视频“${name}”，方舟一般要一到几分钟…`));
}
