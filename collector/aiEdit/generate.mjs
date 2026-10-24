import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { findCli, loginShellEnv, runFile, withoutHostVars } from "../localAi.mjs";
import { modelFetch } from "../systemProxy.mjs";
import { apiBaseUrl, networkFailure, providerMessage } from "../videoAnalysis.mjs";
import { AiEditError } from "./library.mjs";

// AI 剪辑里生成素材：generate_image 走 OpenAI 兼容的图片接口，generate_video 走用户选的那家视频服务的异步任务
// （火山方舟 Seedance、即梦、小云雀、LibTV，各家一个 VIDEO_APIS 适配器，排队、确认、轮询、后台、下载、去重共用一套）。
// 方舟和 OpenAI 的 Key 是用户在 AI 剪辑设置里填的（方舟也可以借用已填的方舟 Key），每次随消息带来，采集器不写盘、不写日志、不进任何报错；
// 即梦、小云雀、LibTV 不填 Key，用这台电脑上装好、登录好的官方命令行（dreamina、pippit-tool-cli、libtv）。
// 两边都按次扣费：创建请求只发一次、不自动重发；生成的文件下载进素材库（来源记成 generated），同样的说明再调直接回那一个。
// 视频要先经页面上用户点「生成」（ctx.askSpend，见 spend.mjs）才建任务。

export const IMAGE_DEFAULTS = { baseUrl: "https://api.openai.com/v1", model: "gpt-image-2.5-flare" };
export const VIDEO_DEFAULTS = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedance-2-0-260128" };
// 另外几家视频服务的默认地址和模型（和页面 DEFAULT_AI_EDIT_GENERATE_CONFIG 一致）
export const VIDEO_PROVIDER_DEFAULTS = {
  seedance: VIDEO_DEFAULTS,
  // 这三家不走接口，用本机的官方命令行；地址只是占位
  jimeng: { baseUrl: "https://jimeng.jianying.com", model: "seedance2.0fast" },
  xyq: { baseUrl: "https://xyq.jianying.com", model: "Seedance_2.0_mini" },
  libtv: { baseUrl: "https://www.liblib.tv", model: "Seedance 2.0 VIP" },
};

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

/** versioned：OpenAI、方舟这类只填域名时要补上版本路径（/v1、/api/v3）；别家地址原样留着，只去掉末尾的斜杠 */
function parseProvider(raw, defaults, label, { versioned = true } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const apiKey = text(raw.apiKey, 500);
  if (!apiKey) return null;
  const given = text(raw.baseUrl, 300).replace(/\/+$/u, "");
  const baseUrl = !given ? defaults.baseUrl : versioned ? apiBaseUrl(given.replace(ENDPOINT_TAIL, "")) : given;
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AiEditError("invalid_config", `${label}的接口地址要以 https:// 开头。`);
  return { baseUrl, apiKey, model: text(raw.model, 100) || defaults.model };
}

/** 生成视频那一项：provider 是哪家（老页面不带，当方舟）；用命令行的几家 apiKey 只是连上的记号 */
function parseVideo(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const provider = raw.provider ?? "seedance";
  if (!Object.hasOwn(VIDEO_PROVIDER_DEFAULTS, provider)) throw new AiEditError("invalid_config", "认不出生成视频用的是哪家服务，更新一下应用再试。");
  const parsed = parseProvider(raw, VIDEO_PROVIDER_DEFAULTS[provider], "生成视频", { versioned: provider === "seedance" });
  return parsed ? { provider, ...parsed } : null;
}

/** 请求体里的生成配置：信任边界。填了 Key 的那项才算配了，都没配回 null。 */
export function parseGenerateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const image = parseProvider(raw.image, IMAGE_DEFAULTS, "生成图片");
  const video = parseVideo(raw.video);
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

// ---------- 生成视频：几家共用的任务流程 ----------

// 每家一个适配器（VIDEO_APIS）：
//   name 说话用的短称（「还在方舟上生成」）、title 确认卡片上的服务商、findIt 关掉应用或建任务说不准时去哪儿找、linkHours 视频链接几小时有效；
//   plan(ctx, config, args, prompt) 校验参数（问用户之前）：回 { key, spend, notes, duration, audio, payload }，key 是认重复用的字段，
//     payload(ctx, config) 读参考图、拼请求（也在问之前，不合格的图别让用户白点一次确认）；
//   create(ctx, config, request) 建任务，只发一次、不自动重发，回任务号；说不准建没建上就抛 unclear；
//   query(ctx, config, taskId, signal) 查一次进度，回 { status, videoUrl, file, tokens, failure }：
//     status 是 queued / running / succeeded / failed / expired / cancelled，failure 是结束了却没做成时给模型的话（不扣费）；
//     file 是命令行已经下好、拷成素材库临时文件的视频（有就不再按 videoUrl 下）；queryMs 是查一次的时限（不写是 30 秒）；
//     断网、超时、限流、对方 5xx 抛带 transient 的错，轮询歇一下再试；
//   cancel(ctx, config, taskId) 取消还在排队的（不扣费），取消不了回 false；
//   cli 是用本机命令行的几家：命令名、官方安装位置、没装和没登录时的话。

/** 建任务出了岔子、又说不准对方建没建上：同样的说明再调时也不再建（job 记成 unknown）。 */
const unclear = (api, why) => Object.assign(new AiEditError("create_uncertain", `建任务时${why}，不知道任务建没建上，可能已经在生成并扣费：先别重试，到${api.findIt}看看。`, 502), { uncertain: true });

/**
 * 建任务的那一个请求：只发一次，不跟着「停止」断开（断在半路就不知道任务建没建，钱可能照扣、视频却拿不到）。
 * 连不上（域名、拒绝连接、证书、连接超时）说明请求没发出去、肯定没建；别的网络问题都说不准，抛 unclear。回 { status, raw }。
 */
async function sendOnce(ctx, api, url, init) {
  let status = 0;
  try {
    const response = await (ctx.fetchImpl ?? modelFetch)(url, { ...init, signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
    status = response.status;
    return { status, raw: await response.text() };
  } catch (error) {
    const failure = networkFailure(error);
    if (!status && failure && NOT_SENT.test(String(error.cause?.code ?? ""))) {
      throw new AiEditError("network_error", `${failure.text.replace(/。$/u, "")}。请求没发出去，任务没建上，没扣费。`, 502);
    }
    if (status) throw unclear(api, `${api.name}的答复读到一半连接断了`);
    if (error?.name === "TimeoutError") throw unclear(api, `${api.name} 2 分钟没回话`);
    throw unclear(api, `没收到${api.name}的答复（${error?.cause?.code || error?.message || "原因不明"}）`);
  }
}

/**
 * 查进度、取消、上传这类可以重发的请求：网络错误、超时标成 transient（查进度时歇一下再试）。
 * 回 { status, raw }；HTTP 报错交给各家自己认。
 */
async function sendQuery(ctx, api, url, init) {
  try {
    const response = await (ctx.fetchImpl ?? modelFetch)(url, init);
    return { status: response.status, raw: await response.text() };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const failure = error?.name === "TimeoutError" ? { text: `${api.name} 30 秒没回话` } : networkFailure(error);
    if (!failure) throw error;
    throw Object.assign(new AiEditError("network_error", failure.text, 502), { transient: true });
  }
}

const parseJson = (raw) => { try { return JSON.parse(raw || "{}"); } catch { return null; } };
/** 一时的问题（408、429、5xx）：查进度时歇一下再试 */
const transient = (error, yes = true) => Object.assign(error, { transient: yes });

/** 素材库里的首帧、尾帧、参考图：去重、限量，三种用法的搭配查一遍。 */
function frameArgs(args) {
  const first = typeof args.first_frame_media_id === "string" ? args.first_frame_media_id : null;
  const last = typeof args.last_frame_media_id === "string" ? args.last_frame_media_id : null;
  const refs = idList(args.reference_media_ids, MAX_VIDEO_REFS, "参考图");
  if (last && !first) throw new AiEditError("arguments_invalid", "给了尾帧就要同时给首帧。");
  if (first && refs.length) throw new AiEditError("arguments_invalid", "首帧尾帧和参考图是两种用法，不能同时给：要从某张图动起来就只给首帧（可加尾帧），要参考几张图的样子就只给参考图。");
  return { first, last, refs };
}

/** 时长：要的秒数（不填 5 秒）夹到 [shortest, longest]，夹过就记一句 */
function durationOf(args, shortest, longest, notes, who = "这个模型") {
  if (args.duration !== undefined && (typeof args.duration !== "number" || !Number.isFinite(args.duration))) throw new AiEditError("arguments_invalid", "时长要填秒数。");
  const asked = args.duration === undefined ? 5 : Math.round(args.duration);
  const duration = Math.min(longest, Math.max(shortest, asked));
  if (duration !== asked) notes.push(`${who}只能生成 ${shortest} 到 ${longest} 秒，按 ${duration} 秒生成的。`);
  return duration;
}

// ---------- 火山方舟 Seedance ----------

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

/** 发一次 GET 或 DELETE；网络错误、超时、408、429、5xx 标成 transient，别的 4xx 直接是方舟的报错。 */
async function arkRequest(ctx, config, url, { method = "GET", signal }) {
  const { status, raw } = await sendQuery(ctx, SEEDANCE, url, { method, headers: { Authorization: `Bearer ${config.apiKey}` }, signal });
  if (status >= 200 && status < 300) return parseJson(raw) ?? {};
  throw transient(arkError(status, raw, config), status === 408 || status === 429 || status >= 500);
}

const SEEDANCE = {
  name: "方舟",
  title: "火山方舟 Seedance",
  findIt: "火山方舟控制台的视频生成任务里",
  linkHours: 24,
  async plan(ctx, config, args, prompt) {
    const { model } = config;
    const notes = [];
    // 2.5 系列能生成 4–30 秒，其他 4–15 秒；超出就夹到范围里
    const duration = durationOf(args, 4, /^doubao-seedance-2-5/iu.test(model) ? 30 : 15, notes);
    const resolution = pick(args.resolution, RESOLUTIONS, "清晰度") ?? "720p";
    if (resolution === "1080p" && /^doubao-seedance-2-0-(fast|mini)/iu.test(model)) {
      throw new AiEditError("arguments_invalid", "用户设的视频模型（fast 或 mini）只能出 480p 或 720p，清晰度改成 720p。");
    }
    // 2.5 的 1080p 是 10 位色深的 H.265：剪映和看板（Chromium）在不少电脑上放不了，花了钱拿到黑屏
    if (resolution === "1080p" && /^doubao-seedance-2-5/iu.test(model)) {
      throw new AiEditError("arguments_invalid", "2.5 系列出的 1080p 视频是 10 位色深的 H.265 编码，剪映和这台电脑上可能放不了，清晰度改成 720p。");
    }
    const { first, last, refs } = frameArgs(args);
    // 给了首帧（或首尾帧）时画面比例跟着首帧走
    const ratio = first ? "adaptive" : pick(args.ratio, VIDEO_RATIOS, "画面比例") ?? await canvasRatio(ctx, VIDEO_RATIOS);
    const audio = args.with_audio === true;
    return {
      key: { kind: "video", model, prompt, ratio, duration, resolution, audio, first, last, refs },
      spend: { model, seconds: duration, resolution, ratio, audio, estimate: estimateVideoCost(model, duration, resolution) },
      notes, duration, audio,
      async payload() {
        const images = [];
        if (first) images.push(await arkImage(ctx, first, "first_frame"));
        if (last) images.push(await arkImage(ctx, last, "last_frame"));
        for (const id of refs) images.push(await arkImage(ctx, id, "reference_image"));
        if (images.reduce((total, image) => total + image.image_url.url.length, 0) > ARK_BODY_CHARS) {
          throw new AiEditError("image_too_large", "参考图加起来太大了，Seedance 一次收不下：少用几张，或者换小一点的图。");
        }
        return {
          model,
          content: [{ type: "text", text: prompt }, ...images],
          resolution, ratio, duration, generate_audio: audio, watermark: false,
          // 排队超过一小时就让方舟自己作废，别过两天突然做完扣费
          execution_expires_after: 3600,
        };
      },
    };
  },
  async create(ctx, config, body) {
    const { status, raw } = await sendOnce(ctx, this, tasksUrl(config), {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (status >= 200 && status < 300) {
      // 回了成功却没给任务号（不是 JSON、被中转站包了一层）：任务多半已经建上了
      const id = parseJson(raw)?.id;
      if (typeof id !== "string" || !id) throw unclear(this, "方舟回了成功，却没给任务编号");
      return id;
    }
    // 网关、中转站回的 5xx 和 408：可能上游已经建好了
    if (status >= 500 || status === 408) throw unclear(this, `方舟回了 ${status}`);
    throw arkError(status, raw, config);
  },
  async query(ctx, config, taskId, signal) {
    const task = await arkRequest(ctx, config, tasksUrl(config, taskId), { signal });
    const status = typeof task?.status === "string" ? task.status : "running";
    const failure = status === "failed" ? arkError(0, JSON.stringify({ error: task.error ?? {} }), config)
      : status === "expired" ? new AiEditError("generate_expired", "排队超过一小时还没轮到，任务过期了，没有扣费。稍后再试。", 504)
        : status === "cancelled" ? new AiEditError("generate_cancelled", "这个任务被取消了，没有扣费。", 409)
          : null;
    const tokens = task.usage?.completion_tokens;
    return { status, videoUrl: task.content?.video_url, tokens: Number.isFinite(tokens) ? tokens : null, failure };
  },
  async cancel(ctx, config, taskId) {
    await arkRequest(ctx, config, tasksUrl(config, taskId), { method: "DELETE", signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    return true;
  },
};

// ---------- 本机命令行（即梦、小云雀、LibTV） ----------

// 这三家都用用户自己装好、在终端里登录过一次的官方命令行，不填 Key：即梦 dreamina、小云雀 pippit-tool-cli、LibTV libtv。
// 按积分扣、估不出价钱，命令行也都没有取消。即梦、小云雀查进度时让命令行把做好的视频下到临时目录，拷进素材库，不再按链接下一遍。
const CLI_CHECK_MS = 60_000;
// 提交时命令行要先传参考图：留够五分钟，到点还没回就说不准建没建上
const CLI_CREATE_MS = 5 * 60_000;

/**
 * 找这家的命令行（api.cli）：登录 shell 的 PATH 和常见安装位置，再看官方安装脚本放的目录（dirs，相对用户目录）。
 * 测试里用 ctx.cli[命令名] 换成假的。
 */
async function localCli(ctx, api) {
  const { id, dirs, missing } = api.cli;
  if (ctx.cli?.[id]) return ctx.cli[id];
  const env = await loginShellEnv() ?? withoutHostVars(process.env);
  const found = await findCli(id, { env }) ?? await findCli(id, { env: { PATH: dirs.map((dir) => path.join(os.homedir(), dir)).join(path.delimiter) } });
  if (!found) throw new AiEditError("cli_missing", missing, 409);
  return { command: found.command, prefix: found.prefix, env: { ...env, ...found.env } };
}

/** 跑一次命令行，回 runFile 的 { code, stdout, stderr, error }：起不来是 code null + error，超时是 code null */
async function cliRun(ctx, api, args, { timeoutMs = CLI_CHECK_MS, signal } = {}) {
  const cli = await localCli(ctx, api);
  return runFile(cli.command, [...cli.prefix, ...args], { env: cli.env, timeoutMs, signal });
}

const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");

/** stdout 里的 JSON：命令行偶尔在前后多打几行字，取第一个 { 到最后一个 } */
function cliJson(stdout) {
  const text = plain(stdout);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? parseJson(text.slice(start, end + 1)) : null;
}

/** 命令行报错的最后一句原话（去掉 Error: 前缀），给人看 */
const cliReason = (run) => plain(run.stderr || run.error?.message || run.stdout).trim().split("\n").filter(Boolean).at(-1)?.replace(/^error:\s*/iu, "").slice(0, 240) ?? "";

/**
 * 命令行没成功时给人看的错。words 是各家认得出的说法 [正则, 错误码, 话（可以是 reason => 话）, 状态码]，没登录之后先比；
 * 都认不出时：提交那一步（submitting）当说不准建没建上，查进度时当一时的问题（歇一下再查）。
 */
function cliFailure(api, run, { submitting = false, words = [] } = {}) {
  const all = plain(`${run.stderr}\n${run.stdout}\n${run.error?.message ?? ""}`);
  const reason = cliReason(run);
  if (run.code === null && run.error) return new AiEditError("cli_missing", `${api.name}命令行起不来（${run.error.message}）${submitting ? "，任务没建上" : ""}。`, 502);
  if (api.cli.login.test(all)) {
    const still = submitting ? "" : `视频可能还在${api.name}上生成、照常扣积分，做完会在${api.findIt}。`;
    return new AiEditError("cli_login", `${api.cli.loginText}${still}`, 401);
  }
  const known = words.find(([pattern]) => pattern.test(all));
  if (known) return new AiEditError(known[1], typeof known[2] === "function" ? known[2](reason) : known[2], known[3] ?? 502);
  if (submitting) return unclear(api, run.code === null ? `${api.name}命令行 ${CLI_CREATE_MS / 60_000} 分钟没回话` : `${api.name}命令行报错（${reason || "原因不明"}）`);
  return transient(new AiEditError("provider_error", run.code === null ? `${api.name}命令行没回话` : `${api.name}命令行报错：${reason || "原因不明"}`, 502));
}

/**
 * 查一次进度：给命令行一个新的临时目录（dir => 参数），done(json) 说做好了就把它下进去的 mp4 拷成素材库里的临时文件（file），目录删掉。
 * 下视频可能要几分钟，所以这两家查一次的时限是 queryMs。
 */
async function cliQuery(ctx, api, args, signal, done) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dy2-video-"));
  try {
    const run = await cliRun(ctx, api, args(dir), { timeoutMs: api.queryMs, signal });
    const json = cliJson(run.stdout);
    let file = null;
    const name = done(json) ? (await readdir(dir, { recursive: true })).find((item) => /\.mp4$/iu.test(item)) : null;
    if (name) {
      file = tempFile(ctx, ".mp4");
      await copyFile(path.join(dir, name), file, constants.COPYFILE_FICLONE);
    }
    return { ...run, json, file };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** JSON 里随便哪一层的 key 字段里的第一个 http 链接；值是 JSON 字符串的也拆开看 */
function findUrl(value, key, depth = 0) {
  if (depth > 8 || !value) return undefined;
  if (typeof value === "string") return /^\s*[[{]/u.test(value) ? findUrl(parseJson(value), key, depth + 1) : undefined;
  if (typeof value !== "object") return undefined;
  if (typeof value[key] === "string" && /^https?:\/\//iu.test(value[key])) return value[key];
  for (const item of Object.values(value)) {
    const found = findUrl(item, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const CLI_QUOTA = [/积分|余额|credit/iu, "quota_exceeded"];
const CLI_REVIEW = [/审核|违规|sensitive|risk/iu, "moderation_blocked"];

// ---------- 即梦（dreamina 命令行） ----------

// 2.5 能生成 4–30 秒、1.0 fast 5–10 秒、1.5 pro 5–12 秒，其余（2.0 系列）4–15 秒
const DREAMINA_SECONDS = [[/2\.5/u, 4, 30], [/1\.0/u, 5, 10], [/1\.5/u, 5, 12]];
const DREAMINA_WORDS = [
  // 有的模型第一次用要先在网页上确认授权
  [/AigcComplianceConfirmationRequired/u, "compliance_required", "这个模型第一次用要先在即梦网页版上用它生成一次（确认授权），之后这边才能用：到即梦网页版选同一个模型生成一次再试。", 403],
  [CLI_QUOTA[0], CLI_QUOTA[1], "即梦的积分不够了，视频没生成：充值或开通会员后再试。", 402],
  [/会员|\bvip\b/iu, "vip_required", "这个模型要即梦会员才能用：开通会员，或者在 AI 剪辑设置里把即梦的模型换成 seedance2.0fast。", 402],
  [CLI_REVIEW[0], CLI_REVIEW[1], "说明或参考图没通过即梦的内容审核，视频没生成。改改说明或换一张图再试。", 422],
];
// 提交前命令行自己查出来的（参数不对、参考图没传上去）：任务肯定没建
const DREAMINA_SUBMIT_WORDS = [
  ...DREAMINA_WORDS,
  [/upload/iu, "upload_failed", (reason) => `参考图没传上去，任务没建上${reason ? `：${reason}` : ""}。`],
  [/is required|must be one of|not supported|unsupported|does not exist|unknown flag/iu, "arguments_invalid", (reason) => `即梦命令行没接这个任务，任务没建上${reason ? `：${reason}` : ""}。`, 422],
];
const DREAMINA_QUERY_WORDS = [[/not found/iu, "generate_expired", "即梦上找不到这个任务了，跟不上这段视频：到即梦网页版的生成记录里看看。", 404]];

/** 即梦说任务没做成（fail_reason）：给人看的话 */
function dreaminaFailure(reason) {
  const text = plain(reason).trim().slice(0, 240);
  const known = DREAMINA_WORDS.find(([pattern]) => pattern.test(text));
  if (known) return new AiEditError(known[1], known[2], known[3]);
  return new AiEditError("generate_failed", `视频没生成出来${text ? `：${text}` : "，原因即梦没说，换个说法再试。"}`, 502);
}

const JIMENG = {
  name: "即梦",
  title: "即梦",
  findIt: "即梦网页版的生成记录里",
  linkHours: 0,
  queryMs: DOWNLOAD_TIMEOUT_MS,
  cli: {
    id: "dreamina",
    // 官方安装脚本在 Windows 上装到 ~/bin，别的系统 ~/.local/bin（常见位置里已经有）
    dirs: ["bin"],
    missing: "这台电脑上没找到即梦命令行（dreamina）：在终端里运行 curl -fsSL https://jimeng.jianying.com/cli | bash 装好，再运行 dreamina login 登录一次。",
    login: /登录态|dreamina login|not logged in|login expired|login pending/iu,
    loginText: "即梦命令行还没登录或登录过期了：在终端里运行 dreamina login 登录后再试。",
  },
  async plan(ctx, config, args, prompt) {
    const { model } = config;
    const notes = [];
    const [, shortest, longest] = DREAMINA_SECONDS.find(([pattern]) => pattern.test(model)) ?? [null, 4, 15];
    const duration = durationOf(args, shortest, longest, notes);
    // 2.5 能出 480p、2.0 VIP 能出 1080p，其余固定 720p；2.5 的 1080p 是 10 位色深的 H.265，剪映和看板可能放不了，不让选
    const allowed = model === "seedance2.0_vip" ? ["720p", "1080p"] : /2\.5/u.test(model) ? ["480p", "720p"] : ["720p"];
    const asked = pick(args.resolution, RESOLUTIONS, "清晰度") ?? "720p";
    const resolution = allowed.includes(asked) ? asked : "720p";
    if (resolution !== asked) notes.push(`即梦这个模型出不了 ${asked}，按 720p 生成的。`);
    const { first, last, refs } = frameArgs(args);
    if (/1\.[05]/u.test(model) && !first) throw new AiEditError("arguments_invalid", `用户设的即梦模型（${model}）要给首帧才能生成。`);
    const command = first && last ? "frames2video" : first ? "image2video" : refs.length ? "multimodal2video" : "text2video";
    // 给了首帧（首尾帧）时比例跟着首帧走，命令行不收比例
    const ratio = first ? "adaptive" : pick(args.ratio, VIDEO_RATIOS, "画面比例") ?? await canvasRatio(ctx, VIDEO_RATIOS);
    if (args.with_audio === true) notes.push("即梦没法指定带不带声音，按它的默认生成。");
    return {
      key: { kind: "video", provider: "jimeng", model, prompt, ratio, duration, resolution, first, last, refs },
      spend: { model, seconds: duration, resolution, ratio, audio: null, estimate: null },
      notes, duration, audio: null,
      async payload() {
        // 图在本地查好（不合格的别让用户白点一次确认），交给命令行上传
        const file = async (id) => (await readReference(ctx, id, ARK_REF_BYTES, "即梦")) && ctx.library.readyPath(id);
        const images = first ? [`--${last ? "first" : "image"}=${await file(first)}`, ...(last ? [`--last=${await file(last)}`] : [])] : [];
        for (const id of refs) images.push(`--image=${await file(id)}`);
        return [command, `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--video_resolution=${resolution}`,
          ...(ratio === "adaptive" ? [] : [`--ratio=${ratio}`]), ...images];
      },
    };
  },
  async create(ctx, config, args) {
    // 不跟着「停止」断开：断在半路就不知道任务建没建
    const run = await cliRun(ctx, this, args, { timeoutMs: CLI_CREATE_MS });
    const result = cliJson(run.stdout);
    if (result?.gen_status === "fail") throw dreaminaFailure(result.fail_reason);
    const id = result?.submit_id;
    if ((typeof id === "string" && id) || Number.isFinite(id)) return String(id);
    if (run.code === 0) throw unclear(this, "即梦命令行回了成功，却没给任务编号");
    throw cliFailure(this, run, { submitting: true, words: DREAMINA_SUBMIT_WORDS });
  },
  async query(ctx, config, taskId, signal) {
    const run = await cliQuery(ctx, this, (dir) => ["query_result", `--submit_id=${taskId}`, `--download_dir=${dir}`], signal, (json) => json?.gen_status === "success");
    const result = run.json;
    if (!result?.gen_status) throw cliFailure(this, run, { words: DREAMINA_QUERY_WORDS });
    if (result.gen_status === "fail") return { status: "failed", failure: dreaminaFailure(result.fail_reason) };
    if (result.gen_status !== "success") return { status: "running" };
    return { status: "succeeded", videoUrl: findUrl(result, "video_url"), file: run.file, tokens: null };
  },
  // 命令行没有取消
  async cancel() { return false; },
};

// ---------- 小云雀（pippit-tool-cli 命令行） ----------

const XYQ_REF_BYTES = 200 * 1024 ** 2;
const XYQ_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1"];
const XYQ_WORDS = [
  [/积分|余额|credit|11001/iu, CLI_QUOTA[1], "小云雀的积分不够了，视频没生成：充值或开通会员后再试。", 402],
  [/ret=(?:12004|12005|12006|12015)\b|审核|违规|sensitive|risk/iu, CLI_REVIEW[1], "说明或参考素材没通过小云雀的内容审核，视频没生成。改改说明或换一张图再试。", 422],
];
// 小云雀自己说没接的（参考图没传上去、参数不对、限流、到上限）：任务肯定没建；它回的 5xx、断网说不准
const XYQ_SUBMIT_WORDS = [
  [/未提交生成/u, "upload_failed", (reason) => `参考图没传上去，任务没建上${reason ? `：${reason}` : ""}。`],
  [/ret=(?:10|16010)\b/u, "rate_limited", "小云雀那边请求太频繁了，过一分钟再试。", 429],
  [/ret=15\b/u, "daily_limit", "小云雀今天的生成次数到上限了，明天再试。", 429],
  ...XYQ_WORDS,
  [/请求返回失败|缺少必填参数|不支持的/u, "provider_error", (reason) => `小云雀没接这个任务，任务没建上${reason ? `：${reason}` : ""}。`],
];

const XYQ = {
  name: "小云雀",
  title: "小云雀",
  findIt: "小云雀网页版的历史会话里",
  linkHours: 0,
  queryMs: DOWNLOAD_TIMEOUT_MS,
  cli: {
    id: "pippit-tool-cli",
    // npm 全局装的（npx @pippit-dev/cli@latest install），常见位置里都有
    dirs: [],
    missing: "这台电脑上没找到小云雀命令行（pippit-tool-cli）：在终端里运行 npx @pippit-dev/cli@latest install 装好，再运行 pippit-tool-cli login 登录一次。",
    login: /未登录|登录凭证|pippit-tool-cli login|HTTP 40[13]\b/u,
    loginText: "小云雀命令行还没登录或登录过期了：在终端里运行 pippit-tool-cli login 登录后再试。",
  },
  async plan(ctx, config, args, prompt) {
    const { model } = config;
    const notes = [];
    // 各模型能生成的秒数不一样（2.5 能到 30 秒），超出了小云雀自己会报错
    const duration = durationOf(args, 4, /2\.5/u.test(model) ? 30 : 15, notes);
    const resolution = pick(args.resolution, RESOLUTIONS, "清晰度") ?? "720p";
    const { first, last, refs } = frameArgs(args);
    // 2.5 的首尾帧比例跟着首帧走，不传比例
    const ratio = first && /2\.5/u.test(model) ? "adaptive" : pick(args.ratio, VIDEO_RATIOS, "画面比例") ?? await canvasRatio(ctx, XYQ_RATIOS);
    if (ratio !== "adaptive" && !XYQ_RATIOS.includes(ratio)) throw new AiEditError("arguments_invalid", `小云雀的画面比例只能是 ${XYQ_RATIOS.join("、")} 之一。`);
    if (args.with_audio === true) notes.push("小云雀没法指定带不带声音，按它的默认生成。");
    // 首帧（首尾帧）模式：图片按首帧、尾帧排；参考图模式让它参考图里的样子
    const ids = first ? [first, last].filter(Boolean) : refs;
    return {
      key: { kind: "video", provider: "xyq", model, prompt, ratio, duration, resolution, first, last, refs },
      spend: { model, seconds: duration, resolution, ratio, audio: null, estimate: null },
      notes, duration, audio: null,
      async payload() {
        // 图先在本地查好，交给命令行上传（命令行按后缀认图，素材库的文件名带着原后缀）
        const images = [];
        for (const id of ids) images.push(`--image=${(await readReference(ctx, id, XYQ_REF_BYTES, "小云雀")) && ctx.library.readyPath(id)}`);
        return ["generate-video", `--prompt=${prompt}`, `--model=${model}`, `--duration=${duration}`, `--resolution=${resolution}`,
          ...(ratio === "adaptive" ? [] : [`--ratio=${ratio}`]), ...images, ...(first ? ["--generate-type=1"] : refs.length ? ["--task-type=reference"] : [])];
      },
    };
  },
  async create(ctx, config, args) {
    const run = await cliRun(ctx, this, args, { timeoutMs: CLI_CREATE_MS });
    const result = cliJson(run.stdout);
    if (run.code === 0 && typeof result?.thread_id === "string" && result.thread_id && typeof result.run_id === "string" && result.run_id) return `${result.thread_id}/${result.run_id}`;
    if (run.code === 0) throw unclear(this, "小云雀命令行回了成功，却没给任务编号");
    throw cliFailure(this, run, { submitting: true, words: XYQ_SUBMIT_WORDS });
  },
  async query(ctx, config, taskId, signal) {
    const [threadId, runId] = taskId.split("/");
    // 报错也是退出码 0、写在 error_message 里；completed 是「结束了」，失败也算
    const done = (json) => json?.completed === true && !json.error_message;
    const run = await cliQuery(ctx, this, (dir) => ["query-result", `--thread-id=${threadId}`, `--run-id=${runId}`, `--download-dir=${dir}`], signal, done);
    const result = run.json;
    if (!result || typeof result.completed !== "boolean") throw cliFailure(this, run);
    const error = plain(result.error_message).trim();
    if (error && result.completed) {
      const known = XYQ_WORDS.find(([pattern]) => pattern.test(error));
      return { status: "failed", failure: known ? new AiEditError(known[1], known[2], known[3]) : new AiEditError("generate_failed", `视频没生成出来：${error.slice(0, 240)}`, 502) };
    }
    // 查的时候出错（断网、下载失败、登录过期）：登录过期直接说，别的歇一下再查
    if (error) throw cliFailure(this, { ...run, code: 1, stderr: error, stdout: "" });
    // ponytail: 命令行分不出排队、取消、等网页上补充信息，没结束都当在做；被取消的要跟满 3 小时才放弃
    if (!result.completed) return { status: "running" };
    const video = Array.isArray(result.videos) ? result.videos.find((item) => typeof item?.download_url === "string") : undefined;
    return { status: "succeeded", videoUrl: video?.download_url, file: run.file, tokens: null };
  },
  // 命令行没有取消
  async cancel() { return false; },
};

// ---------- LibTV（libtv 命令行） ----------

// LibTV 原来的 Access Key 接口（im.liblib.tv/openapi）2026 年已经下线，只回「已升级为 LibTV CLI」。这里照官方用法：
// project create 建一张画布（一个采集器进程只建一张）→ upload 传参考图 → node create … --run 生成，它一直阻塞到出结果，
// 官方说中途杀掉结果就写不回画布，所以起一个子进程让它自己跑完（采集器退出也不杀），query 只看它跑完没有。
// 任务号是「画布/节点名」。
const libtvRuns = new Map();
let libtvProject = null;

/** 跑一条很快就结束的 libtv 命令，回解析好的 stdout JSON；失败说清楚（没登录、没会员之类原样带上 stderr） */
async function libtvRun(ctx, args) {
  const { code, stdout, stderr, error } = await cliRun(ctx, LIBTV, args);
  const parsed = parseJson(stdout.trim());
  if (code === 0 && parsed) return parsed;
  throw libtvError(stderr || error?.message || stdout);
}

function libtvError(text) {
  const reason = String(text ?? "").trim().split("\n").filter(Boolean).at(-1)?.slice(0, 240) ?? "";
  if (/401|未登录|login/iu.test(reason)) return new AiEditError("libtv_login", "LibTV 命令行还没登录或登录过期了：在终端里运行 libtv login web 登录后再试。", 401);
  if (/会员|vip/iu.test(reason)) return new AiEditError("libtv_vip", `这个模型要 LibTV 会员才能用${reason ? `（${reason}）` : ""}：开通会员，或者在 AI 剪辑设置里换一个不要会员的模型（比如万相）。`, 402);
  if (/积分|余额|power/iu.test(reason)) return new AiEditError("quota_exceeded", "LibTV 的积分不够了，充值后再试。", 402);
  return new AiEditError("provider_error", `LibTV 没生成出来${reason ? `：${reason}` : ""}`, 502);
}

const LIBTV = {
  name: "LibTV",
  title: "LibTV",
  findIt: "LibTV 网页版的「AI 剪辑生成」画布里",
  linkHours: 0,
  cli: {
    id: "libtv",
    // 官方安装脚本装到 ~/.libtv
    dirs: [".libtv"],
    missing: "这台电脑上没找到 LibTV 命令行：到 liblib.tv/plugin 的「CLI」页装好，再在终端里运行 libtv login web 登录一次。",
  },
  async plan(ctx, config, args, prompt) {
    const { model } = config;
    const notes = [];
    const duration = durationOf(args, 4, 15, notes);
    const resolution = pick(args.resolution, RESOLUTIONS, "清晰度") ?? "720p";
    const { first, last, refs } = frameArgs(args);
    const ratio = first ? "adaptive" : pick(args.ratio, VIDEO_RATIOS, "画面比例") ?? await canvasRatio(ctx, VIDEO_RATIOS);
    const audio = args.with_audio === true;
    // 首尾帧、单图生视频、多图参考、文生视频
    const modeType = first && last ? "frames2video" : first ? "singleImage2video" : refs.length ? "image2video" : "text2video";
    const ids = first ? [first, last].filter(Boolean) : refs;
    return {
      key: { kind: "video", provider: "libtv", model, prompt, ratio, duration, resolution, audio, first, last, refs },
      spend: { model, seconds: duration, resolution, ratio, audio, estimate: null },
      notes, duration, audio,
      async payload() {
        // 图在本地查好，交给命令行上传
        const files = [];
        for (const id of ids) files.push({ id, file: (await readReference(ctx, id, ARK_REF_BYTES, "LibTV")) && ctx.library.readyPath(id) });
        const settings = { model, modeType, ratio, resolution, duration: String(duration), enableSound: audio ? "on" : "off", count: "1" };
        return { files, prompt, settings };
      },
    };
  },
  async create(ctx, config, { files, prompt, settings }) {
    // 画布和参考图都不花钱，失败了照常报（任务还没建）
    libtvProject ??= String((await libtvRun(ctx, ["project", "create", "AI 剪辑生成"])).uuid ?? "") || null;
    if (!libtvProject) throw new AiEditError("provider_error", "LibTV 建画布时没给编号，稍后再试。", 502);
    const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const left = [];
    for (const [index, { file }] of files.entries()) {
      const uploaded = await libtvRun(ctx, ["upload", `参考图-${stamp}-${index + 1}`, "-t", "image", "-f", file, "-p", libtvProject]);
      if (!uploaded.nodeKey) throw new AiEditError("provider_error", "LibTV 上传参考图时没给节点编号，稍后再试。", 502);
      left.push("--left", String(uploaded.nodeKey));
    }
    const node = `AI 剪辑-${stamp}`;
    const cli = await localCli(ctx, this);
    const args = ["node", "create", node, "-t", "video", "-p", libtvProject, "--prompt", prompt,
      ...Object.entries(settings).flatMap(([key, value]) => ["-s", `${key}=${value}`]), ...left, "--run"];
    const run = { done: false, code: null, stdout: "", stderr: "" };
    let child;
    try {
      // 不跟着采集器退出：中途杀掉结果写不回画布
      child = spawn(cli.command, [...cli.prefix, ...args], { env: cli.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      throw new AiEditError("cli_missing", `LibTV 命令行起不来（${error.message}），任务没建上。`, 502);
    }
    child.unref();
    const take = (current, chunk) => (current.length < 1_000_000 ? current + chunk : current);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { run.stdout = take(run.stdout, chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { run.stderr = take(run.stderr, chunk); });
    child.once("error", (error) => { Object.assign(run, { done: true, stderr: run.stderr || error.message }); });
    child.once("close", (code) => { Object.assign(run, { done: true, code }); });
    const taskId = `${libtvProject}/${node}`;
    libtvRuns.set(taskId, run);
    return taskId;
  },
  async query(ctx, config, taskId) {
    const run = libtvRuns.get(taskId);
    if (!run) return { status: "failed", failure: new AiEditError("generate_failed", `这边重启过，跟不上这段视频了：做完会在${LIBTV.findIt}，节点名 ${taskId.split("/").at(-1)}。`, 409) };
    if (!run.done) return { status: "running" };
    libtvRuns.delete(taskId);
    const result = parseJson(run.stdout.trim()) ?? {};
    const url = Array.isArray(result.data?.url) ? result.data.url[0] : Array.isArray(result.url) ? result.url[0] : undefined;
    if (run.code === 0 && url) return { status: "succeeded", videoUrl: url, tokens: null };
    // 命令行自己等了约 20 分钟还没终态（poll_timeout）：任务还在 LibTV 上跑，做完照样扣积分
    if (/poll_timeout/iu.test(run.stdout + run.stderr)) {
      return { status: "failed", failure: new AiEditError("generate_timeout", `LibTV 二十分钟还没做完，命令行不等了；做完会在${LIBTV.findIt}，照样扣积分，节点名 ${taskId.split("/").at(-1)}。`, 504) };
    }
    return { status: "failed", failure: libtvError(result.data?.taskInfo?.failedReason ?? result.failedReason ?? run.stderr) };
  },
  // 命令行没有取消
  async cancel() { return false; },
};

// ---------- 任务：建、轮询、下载、后台 ----------

/** 用户选的那家；老页面不带 provider，当方舟 */
const VIDEO_APIS = { seedance: SEEDANCE, jimeng: JIMENG, xyq: XYQ, libtv: LIBTV };
const apiOf = (config) => VIDEO_APIS[config.provider ?? "seedance"] ?? SEEDANCE;

/**
 * 现查一次任务（查不到回 null）。取消之前用它，不信 job.status：轮询连着失败时 job.status 停在上次查到的 queued，
 * 对方可能早就做完扣费了，对做好的任务取消会把任务记录删掉（方舟也回成功），钱扣了视频却再也找不回来。
 */
async function currentTask(ctx, api, config, job) {
  try {
    const task = await api.query(ctx, config, job.taskId, AbortSignal.any([job.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]));
    // 只是看一眼：命令行顺手下好的视频不留，轮询那边会再取一次
    if (task.file) await rm(task.file, { force: true }).catch(() => undefined);
    return task;
  } catch {
    return null;
  }
}

/** 对方说任务结束了却没做成（失败、过期、被取消，都不扣费）：给模型的话；还没结束或做成了回 null。 */
const endedError = (task) => (task && ["failed", "expired", "cancelled"].includes(task.status) ? task.failure ?? new AiEditError("generate_failed", "视频没生成出来，换个说法再试。", 502) : null);

/** 排队中的任务取消掉（不扣费）；已经开始做的、没有取消接口的回 false。只在刚查到还在排队时调。 */
async function cancelTask(ctx, api, config, taskId) {
  try {
    return await api.cancel(ctx, config, taskId);
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

/** 对方给的视频链接（不带 Key）：先写 .part，失败了歇一下再试，最多 5 次。 */
async function downloadVideo(ctx, api, url, signal, taskId) {
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
  const elsewhere = api.linkHours ? `，也可以到${api.findIt}按任务号下载（链接 ${api.linkHours} 小时内有效）` : `，也可以到${api.findIt}找到它下载`;
  throw new AiEditError("download_failed", `视频生成好了，但下载了 ${DOWNLOAD_ATTEMPTS} 次都没下下来（${reason}）。钱已经扣了，别换说法重新生成：用同样的参数再调一次 generate_video 会直接重新下载这一段，不会再扣钱，也不用用户再确认。${api.name}任务号 ${taskId}${elsewhere}。`, 502);
}

/** 后台跟到上限还没做完：放弃，带上任务号（对方做完可能照样扣费）。 */
const givenUp = (api, job, missed = "") => new AiEditError("generate_timeout", `跟了 3 小时视频还没做完${missed ? `（最后没查到进度：${missed.replace(/。$/u, "")}）` : ""}，这边不等了。${api.name}上做完可能照样扣费，到${api.findIt}按任务号 ${job.taskId} 找。`, 504);

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
async function runVideoJob(ctx, api, config, job, { request, name, source }) {
  if (!job.taskId) {
    job.taskId = await api.create(ctx, config, request);
    job.status = "queued";
    // 建任务的时候用户已经点了停止：刚建好肯定还在排队，取消掉；没取消成功（断网、限流）下面轮询时接着试
    if (job.stopped && await cancelTask(ctx, api, config, job.taskId)) return null;
  }
  // 正式环境 ctx.pollMs 是 1 秒，按 10 倍间隔查（10 秒后第一次，之后每 10 秒）；测试里调小
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
      task = await api.query(ctx, config, job.taskId, AbortSignal.any([job.signal, AbortSignal.timeout(api.queryMs ?? QUERY_TIMEOUT_MS)]));
      misses = 0;
      wait = every;
    } catch (error) {
      if (job.signal.aborted || !error?.transient) throw error;
      if (late) throw givenUp(api, job, error.message);
      // 断网、超时、限流、对方 5xx 都是一时的，任务还在对方那边跑，不能因为查不到就丢下：间隔翻倍往后退，最长一分钟
      misses += 1;
      wait = Math.min(every * 2 ** (misses - 1), every * 6);
      continue;
    }
    job.status = task.status ?? job.status;
    // 用户点了停止、刚查到还在排队：再试着取消（上一次碰上断网、限流没取消成功），跟着轮询的间隔一直试到它开跑
    if (job.stopped && task.status === "queued" && await cancelTask(ctx, api, config, job.taskId)) return null;
    if (task.status === "succeeded") break;
    const ended = endedError(task);
    if (ended) throw ended;
    if (late) throw givenUp(api, job);
  }
  const url = task.videoUrl;
  job.videoUrl = url ?? null;
  // 命令行自己下好的（即梦、小云雀）：是 mp4 就直接收，不再按链接下一遍
  let temp = task.file && await isMp4(task.file).catch(() => false) ? task.file : null;
  if (task.file && !temp) await rm(task.file, { force: true }).catch(() => undefined);
  if (!temp) {
    if (typeof url !== "string" || !/^https?:\/\//iu.test(url)) {
      throw new AiEditError("provider_error", `${api.name}说视频生成好了，但没给下载链接。钱已经扣了，别换说法重新生成：过一会儿用同样的参数再调一次会重新去取，不会再扣钱；也可以到${api.findIt}按任务号 ${job.taskId} 下载。`, 502);
    }
    temp = await downloadVideo(ctx, api, url, job.signal, job.taskId);
  }
  const item = await adopt(ctx, temp, { name, extension: ".mp4", source });
  return { item, tokens: task.tokens ?? null };
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
async function waitForVideo(ctx, api, config, job, status) {
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
    const fresh = job.taskId && job.status !== "succeeded" ? await currentTask(ctx, api, config, job) : null;
    if (fresh) job.status = fresh.status;
    if (fresh?.status === "queued" && await cancelTask(ctx, api, config, job.taskId)) {
      job.controller.abort();
      if (stopped) throw error;
      throw new AiEditError("generate_timeout", "排了 20 分钟队还没轮到，这边取消了，没有扣费。稍后再试。", 504);
    }
    // 对方那边已经结束了却没做成：不扣费，也不用再跟
    const ended = endedError(fresh);
    if (ended) {
      job.controller.abort();
      if (stopped) throw error;
      throw ended;
    }
    // 现查到已经做好了：叫醒轮询马上去下载，不用等下一次
    if (fresh?.status === "succeeded") job.wake?.();
    ctx.generated?.background?.push({ name: job.name, ...(job.taskId ? { taskId: job.taskId } : {}), phase: videoPhase(job), service: api.name, findIt: api.findIt });
    job.promise.catch((failure) => {
      if (failure?.name !== "AbortError") console.error("AI 剪辑转到后台的视频没放进素材库:", job.taskId ?? "任务没建上", failure?.code ?? failure?.name);
      else if (ctx.shutdown?.aborted && job.taskId) console.warn(`AI 剪辑关掉时视频还没做完，${api.name}任务号:`, job.taskId);
    });
    if (stopped) throw error;
    if (job.status === "succeeded") {
      const what = job.redownload ? "上次已经生成好了（不会再扣钱），还在重新下载" : `已经在${api.name}上生成好了（已经扣费），还在下载`;
      throw new AiEditError("generate_background", `视频${what}（任务号 ${job.taskId}），下完会自动放进素材库。别再生成一次，过几分钟用 list_media 找它。`, 202);
    }
    throw new AiEditError("generate_background", `视频还在${api.name}上生成${job.taskId ? `（任务号 ${job.taskId}）` : ""}，做完会自动放进素材库，照常扣费。别再生成一次，过几分钟用 list_media 找它。`, 202);
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

/**
 * 这一轮转到后台的视频（generated.background），回复末尾跟用户说清楚：按阶段说扣不扣费、会不会自己进素材库、关掉应用怎么办。
 * 一轮只用一家服务，用第一段记下的叫法（老记录没有，当方舟）。
 */
export function backgroundNote(background, { stopped = false } = {}) {
  if (!background?.length) return "";
  const service = background[0].service ?? SEEDANCE.name;
  const findIt = background[0].findIt ?? SEEDANCE.findIt;
  const named = ({ name, taskId }) => `“${name}”${taskId ? `（${service}任务号 ${taskId}）` : ""}`;
  const list = (phase) => background.filter((video) => video.phase === phase).map(named).join("、");
  const submitted = background.filter((video) => video.phase === "submitted");
  const lines = [
    list("generating") && `视频${list("generating")}还在${service}上生成${stopped ? "，停不下来" : ""}，做完会自动放进素材库，照常扣费。`,
    list("downloading") && `视频${list("downloading")}已经在${service}上生成好了，钱已经扣了，还在下载，下完会自动放进素材库。`,
    list("redownload") && `视频${list("redownload")}上次生成好了没下载下来，这次在重新下载，不会再扣钱，下完会自动放进素材库。`,
    submitted.length && `视频${list("submitted")}${submitted.every((video) => !video.taskId) ? `刚提交给${service}` : `已经提交给${service}`}，如果已经开始生成就停不下来，做完会自动放进素材库，照常扣费；还在排队的会取消，不扣费。`,
  ];
  const making = background.some((video) => video.phase === "generating" || video.phase === "submitted");
  const ids = background.some((video) => video.taskId);
  lines.push(`要开着应用等它${making ? "做完" : "下完"}；关掉的话，到${findIt}${ids ? "按任务号" : ""}下载。`);
  return lines.filter(Boolean).join("");
}

/** generate_video：先查重，再请用户确认，同意了才建任务。回 { item, note, reused?, tokens? }。 */
export async function generateVideo(ctx, args) {
  const config = ctx.generation?.video;
  if (!config) throw new AiEditError("generate_unavailable", "还没在 AI 剪辑设置里连上生成视频的服务，这个工具现在用不了。", 409);
  const api = apiOf(config);
  const prompt = promptOf(args.prompt, MAX_VIDEO_PROMPT);
  const name = nameOf(args.name, prompt);
  const plan = await api.plan(ctx, config, args, prompt);
  const { notes, duration, audio } = plan;
  const key = generationKey(plan.key);
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
      throw human(new AiEditError("generate_pending", `上一轮停止时这段视频刚提交给${api.name}：排队中的会被取消、不扣费；已经开始生成的停不下来，做完会自己放进素材库。过一会儿用 list_media 看看，没有的话再调 generate_video，会重新请用户确认。`, 409),
        `上一轮停止时视频“${name}”刚提交，这次没再生成`);
    }
    throw new AiEditError("generate_pending", `同样的这段视频还在${api.name}上生成，做完会自己放进素材库：过几分钟用 list_media 找它，别再生成一次。`, 409);
  }
  if (job?.status === "unknown") {
    throw new AiEditError("create_uncertain", `上次建这段视频的任务时没收到${api.name}的明确答复，不知道建没建上，可能已经在生成并扣费：先别重试，到${api.findIt}看看。用户看过确实没建上、还要这段，就把说明改一点再生成。`, 409);
  }
  const source = { type: "generated", provider: config.provider ?? "seedance", model: config.model, prompt: prompt.slice(0, 200), key };
  const finish = (result, extra = []) => {
    const seconds = result.item.durationUs ? Math.round(result.item.durationUs / 10_000) / 100 : duration;
    const sound = audio === null ? "" : audio ? "带声音" : "没有声音";
    return {
      item: result.item,
      ...(result.tokens !== null ? { tokens: result.tokens } : {}),
      note: [...notes, ...extra, `生成了 ${seconds} 秒${sound}的视频。`, VIDEO_NOTE].join(""),
    };
  };
  if (job?.status === "succeeded") {
    // 做好了、钱扣了，上次没下载下来：拿原任务重新查一次链接再下载，不问用户、不建任务
    job.name = name;
    armJob(job, ctx, { redownload: true });
    track(job, runVideoJob(ctx, api, config, job, { name, source }));
    return finish(await waitForVideo(ctx, api, config, job, `正在重新下载视频“${name}”…`), ["上次生成好了没下载下来，这次重新下载好了，没有再扣钱。"]);
  }
  if (ctx.generated && (ctx.generated.videos ?? 0) >= VIDEOS_PER_TURN) {
    throw human(new AiEditError("generate_limit", `这一轮已经请用户确认过 ${VIDEOS_PER_TURN} 段视频（没同意的也算），到上限了。先用已经有的素材，还要更多就跟用户说一声，等用户下一句话再生成。`, 429),
      `这一轮生成视频到上限了，“${name}”没生成`);
  }
  ctx.library.assertRoom();
  // 参考图在问用户之前查好：不合格的别让用户白点一次确认
  const request = await plan.payload();
  if (!ctx.askSpend) throw new AiEditError("spend_unavailable", "生成视频要用户在应用里点确认，要开着应用才能确认。", 409);
  // 问之前就算一段：用户没同意也算，免得模型一轮里反复弹确认
  if (ctx.generated) ctx.generated.videos = (ctx.generated.videos ?? 0) + 1;
  // 问之前先占上：确认最多挂 15 分钟，这期间别的剪辑同样的说明再调不再弹卡片；没同意、没人点、停止了就撤掉
  job = { slot, name, taskId: null, status: "asking", videoUrl: null, promise: null, at: Date.now() };
  videoJobs.set(slot, job);
  const release = () => { if (videoJobs.get(slot) === job) videoJobs.delete(slot); };
  try {
    await ctx.askSpend({ kind: "video", provider: api.title, ...plan.spend, prompt: prompt.slice(0, 200) });
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
  track(job, runVideoJob(ctx, api, config, job, { request, name, source }));
  return finish(await waitForVideo(ctx, api, config, job, `正在生成视频“${name}”，${api.name}一般要一到几分钟…`));
}
