import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { lookMaterials, seesNoImages, seesNoVideo, videoRefused } from "./aiEdit/look.mjs";
import { LOCAL_RUNTIMES, LocalAiError, isLocalRuntime, parseLocalConfig, runtimeLabel } from "./localAi.mjs";
import { modelFetch } from "./systemProxy.mjs";
import { normalizeDouyinVideoUrl } from "./videoDownloader.mjs";

// 解析库：采集器把视频（最低一档清晰度）下到本地，整段视频连同拆解提示词发给用户自己配的 OpenAI 兼容接口
// （默认火山方舟 doubao-seed-2-1-lite，能听音轨），答案存进数据目录的 analyses.json，不分账号。
// 接口 Key 每次随请求带来、用完即丢，不落盘。

export const ANALYSIS_PROMPT = `请从创作者角度拆解我提供的视频，目标是提炼可复用的创作方法，帮助我设计下一条内容。

请分析以下维度：
1. 视频档案：标题、封面、时长、作者、发布时间、词条；缺失信息标注“未知”。
2. 选题与受众：讲什么、可能面向谁、回应什么痛点或欲望、承诺给观众什么收益、切入角度有什么特点。
3. 开头钩子：首个画面、开头原话、吸引注意的具体机制，以及它制造了什么期待。
4. 内容结构：段落顺序、信息递进、冲突、悬念、转折、论据，以及何时兑现开头的承诺。
5. 人物与表达：人物身份、角色关系、口吻、表演方式，以及可信度来自哪里。
6. 画面与声音：场景、景别、镜头运动、素材、字幕、旁白、音乐和音效分别起什么作用。
7. 节奏与情绪：剪辑节点、停顿、信息密度、情绪变化、高潮位置，以及可能影响观看体验的片段。
8. 记忆与传播：金句、标志性画面、实用信息、潜在收藏点、分享理由和讨论点。
9. 结尾与行动：如何收尾、引导观众做什么、关注理由是什么，是否有产品或服务承接。
10. 创作复用：可复用的结构和手法、依赖的特殊资源、制作难点，以及适合我创作方向的改编方式。

拆解画面时不要只写画面里有什么，还要说明为什么这样做：场景为什么这样选和布置、人物站在哪里怎么走位、对话怎么说、动作和表情怎么安排、镜头为什么这样拍、为什么从上一个画面这样接过来，以及其他你看得出用意的处理；各自是为了交代什么、引导观众看哪里、带出什么情绪，或者给后面做什么铺垫。

请按以下顺序输出：
① 用三句话概括选题、观看收益和主要创作机制。
② 用“维度｜具体发现｜时间戳或原话证据｜创作启示”的表格展开分析。
③ 按实际内容段落生成时间轴表：“起止时间｜台词/字幕摘要｜画面与声音｜为什么这样拍｜段落作用｜创作手法”。
④ 提炼一个可填空的脚本结构模板，并给出三个适合我方向的改编选题。
⑤ 提出下一条视频最值得测试的一个变量，说明假设、修改方式和验证指标；没有数据时标注待验证。

关键判断必须对应具体片段或原话。清楚区分“可观察事实”和“分析假设”：目标受众、传播理由、创作意图属于推测；完播、留存、涨粉和成交只能使用已提供的数据。用具体表现解释“节奏好”“有共鸣”等评价。

如果无法读取视频，请说明当前能读取哪些材料、还缺什么；仅依据实际可见内容分析，不编造画面、台词、时间戳或效果数据。`;

/** 回答写到长度上限时接在末尾的一句（转写字幕认它，知道后面没写完）。 */
export const TRUNCATED_NOTE = "\n\n> 回答写到了长度上限，后面的内容没写完。";

const MAX_ITEMS = 500;
const MAX_ANSWER_TOKENS = 16_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MODEL_TIMEOUT_MS = 15 * 60_000;

export class AnalysisError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 接口地址常见两种填法错误：只填域名（中转站根路径回的是网页），或粘了整条 …/chat/completions。
 * 前者补上 OpenAI 兼容的版本路径（方舟 /api/v3，其余 /v1），后者去掉末尾。AI 剪辑的接口设置也用这个。
 */
export function apiBaseUrl(value) {
  const base = value.replace(/\/+$/u, "");
  const stripped = base.replace(/\/chat\/completions$/iu, "");
  if (stripped !== base) return stripped;
  try {
    const url = new URL(base);
    if (url.pathname === "/" && !url.search && !url.hash) return `${base}${/(?:^|\.)volces\.com$/iu.test(url.hostname) ? "/api/v3" : "/v1"}`;
  } catch { /* 调用方统一报错 */ }
  return base;
}

const CERT_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/u;
const DROPPED = new Set(["UND_ERR_SOCKET", "ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_CLOSED"]);
const QUICK_RETRY_MS = 10_000;
const DROP_RETRIES = 2;
const DROP_PAUSE_MS = 500;

/**
 * fetch 的网络错误（undici 抛的 TypeError：连接时 "fetch failed"，读回答时 "terminated"）按底层原因说清楚，
 * 不是网络错误返回 null。retry：连接被断，快的话可以悄悄重发一次；dropped：回答已经开始了又断，
 * 重新来一次多半就好，下一步怎么做由调用方补。
 */
export function networkFailure(error, waitedMs = 0) {
  if (!(error instanceof TypeError) || !(error.cause || ["fetch failed", "terminated"].includes(error.message))) return null;
  const code = typeof error.cause?.code === "string" ? error.cause.code : "";
  const shown = code || error.cause?.message || error.message;
  if (error.proxy && code === "ECONNREFUSED") return { text: `连不上系统代理 ${error.proxy}（${shown}），代理软件可能没开着。` };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { text: `找不到接口地址的域名（${shown}），检查一下地址有没有写错、这台电脑能不能上网。` };
  if (code === "ECONNREFUSED") return { text: `接口地址拒绝连接（${shown}），检查一下地址和端口。` };
  if (CERT_ERROR.test(code)) return { text: `接口的 HTTPS 证书校验不通过（${shown}），可能被代理或网络拦下了。` };
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return { text: `连接接口超时（${shown}），检查一下网络或代理。` };
  // Node 的 fetch 默认 5 分钟收不到响应头、或两段数据之间隔了 5 分钟，就自己断开
  if (code === "UND_ERR_HEADERS_TIMEOUT") return { text: `接口 ${Math.round(waitedMs / 1000)} 秒都没开始回答，这边先断开了（${shown}）。`, dropped: true };
  if (code === "UND_ERR_BODY_TIMEOUT") return { text: `接口太久没有新内容，这边先断开了（${shown}）。`, dropped: true };
  if (error.message === "terminated") {
    const waited = Math.round(waitedMs / 1000);
    return { text: `${waited >= 30 ? `等了 ${waited} 秒后，` : ""}接口连接中途断开了（${shown}）。`, retry: true, dropped: true };
  }
  // 还没收到回答连接就断了：可能是复用了一条已被断掉的连接（重发就好），也可能是被代理或网络拦下
  if (DROPPED.has(code)) return { text: `连接还没建立好就被断开了（${shown}），检查一下网络、代理和地址。`, retry: true };
  if (error.proxy) return { text: `系统代理 ${error.proxy} 没能连上接口（${shown}），看看代理软件的节点或规则。` };
  return { text: `连不上接口地址（${shown}），检查一下网络和地址。` };
}

/**
 * 发一次模型请求，网络断了悄悄重发：还没收到文字、10 秒内连接就断（多半复用了一条已被中间网络断掉的连接）马上重发一次；
 * 回答已经开始又被掐断（中转站或代理节点不稳，远端实测 21 秒、47 秒都断过）歇一下再发，最多两次。
 * 请求本身没有副作用（工具要等整段回答收完才执行），重发是安全的。流到一半的字不清：新回答一来自然替换，重发全失败时半句还留着。
 * 网络错误交给 fail 换成调用方自己的报错。
 */
export async function sendWithRetry(send, { signal, received = () => false, fail }) {
  let drops = 0;
  // 歇的时候到了超时：抛信号自己的原因（TimeoutError），别让 timers 的 AbortError 冒充用户停止
  const pause = () => delay(DROP_PAUSE_MS, undefined, { signal }).catch((reason) => { signal?.throwIfAborted(); throw reason; });
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    try {
      return await send();
    } catch (error) {
      const waited = Date.now() - started;
      // 中转站回了临时性的错（和上游之间的流断了、网关出错）：和连接被掐一样歇一下重发，共用「最多两次」
      if (error?.transient && !signal?.aborted) {
        if (drops < DROP_RETRIES) {
          drops += 1;
          await pause();
          continue;
        }
        error.message = `${error.message.replace(/。$/u, "")}，自动重发了 ${drops} 次还是这样。`;
        throw error;
      }
      const failure = signal?.aborted ? null : networkFailure(error, waited);
      if (!failure) throw error;
      // 断过一次之后，重发时连接没建好就被重置也算同一回事，一起占「最多两次」
      const again = failure.dropped || drops ? drops < DROP_RETRIES : attempt === 1 && waited < QUICK_RETRY_MS && !received();
      if (failure.retry && again) {
        if (failure.dropped || drops) {
          drops += 1;
          await pause();
        }
        continue;
      }
      throw fail(drops ? { ...failure, dropped: true, text: failure.text.replace(/。$/u, `，自动重发了 ${drops} 次还是断开。`) } : failure);
    }
  }
}

/** 读整段 JSON 回答：读的时候断网、超时照常抛出（交给上面分类和重发），只有读完了解析不了才算不是 JSON。 */
export async function readJson(response) {
  const raw = await response.text();
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * 接口回非 2xx（或流里报错）时给用户看的话：原因 + 接口原文；网关的错误页是整页 HTML，不往里塞。
 * extra 是调用方自己的状态码说法（比如 524 该怎么办，对话和解析库不一样）。
 */
export function providerMessage(status, body, extra = {}) {
  let detail = String(body ?? "").trim();
  let code = "";
  try {
    const parsed = JSON.parse(detail);
    code = String(parsed?.error?.code ?? parsed?.code ?? "");
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch { /* 不是 JSON 就用原文 */ }
  detail = /^</u.test(detail) ? "" : String(detail).slice(0, 240);
  // new-api / one-api 这类中转站：模型名写错或分组没开通这个模型时回 503 + model_not_found，等多久都不会好
  const noChannel = status === 503 && (code === "model_not_found" || /无可用渠道|no available channel/iu.test(detail));
  const reason = noChannel ? "中转站里没有能用的这个模型，检查一下模型名有没有写错，或者到中转站后台看看开通了没有"
    : status === 401 || status === 403 ? "接口 Key 不对或没有权限"
      : status === 404 ? "接口地址或模型名不对，或者模型还没开通"
        : status === 429 ? "接口限流或额度用完了，稍后再试"
          : extra[status] ?? ([502, 503, 504, 520, 522].includes(status) ? `接口服务暂时出了问题（${status}）`
            : status ? `接口返回 ${status}` : "接口报错");
  return detail ? `${reason}：${detail}` : `${reason}。`;
}

/** 请求体里的接口配置：信任边界，地址只认 http(s)，各项限长。 */
export function parseAnalysisConfig(value) {
  const text = (item, max) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  // 本机的 Codex / Claude Code：不要地址和 Key，看不了视频，一律拆截图（collector/localAi.mjs）
  if (isLocalRuntime(value?.runtime)) {
    return { ...parseLocalConfig(value, (message) => new AnalysisError("invalid_config", message)), direction: text(value?.direction, 600) };
  }
  const baseUrl = apiBaseUrl(text(value?.baseUrl, 300));
  const apiKey = text(value?.apiKey, 400);
  const model = text(value?.model, 120);
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AnalysisError("invalid_config", "接口地址要以 https:// 开头。");
  if (!apiKey || !model) throw new AnalysisError("invalid_config", "先在解析库的接口设置里填好 Key 和模型。");
  // videoInput：页面配置时测过模型能不能看视频；看不了就由开着的应用页面把视频拆成截图和节拍再给它
  return { baseUrl, apiKey, model, direction: text(value?.direction, 600), videoInput: typeof value?.videoInput === "boolean" ? value.videoInput : null };
}

/** 提示词后面附上抖音页面读到的公开信息和创作方向，提示词要求“只能使用已提供的数据”。focus 是调用方追加的要求（AI 剪辑参考视频时用）。 */
export function analysisPrompt(video, direction = "", focus = "") {
  const stats = video?.stats ?? {};
  const counts = [["点赞", stats.diggCount], ["评论", stats.commentCount], ["收藏", stats.collectCount], ["分享", stats.shareCount], ["播放", stats.playCount]]
    .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  const published = video?.publishedAt ? new Date(video.publishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
  return [
    // AI 剪辑带着自己的要求来（focus 里写了看不到时只回一个标记），去掉「无法读取请说明缺什么」，不然模型照做反而像没看到
    focus ? ANALYSIS_PROMPT.replace("如果无法读取视频，请说明当前能读取哪些材料、还缺什么；", "") : ANALYSIS_PROMPT,
    "",
    "---",
    "下面是从抖音页面读到的这条视频的信息，可以当作“已提供的数据”：",
    `标题：${video?.title || "未知"}`,
    `作者：${video?.author || "未知"}`,
    `发布时间：${published}`,
    `时长：${video?.durationSeconds ? `${video.durationSeconds} 秒` : "未知"}`,
    `词条：${video?.tags?.length ? video.tags.map((tag) => `#${tag}`).join(" ") : "未知"}`,
    "封面：没有一起提供",
    `公开互动数据（读取时）：${counts.length ? counts.join("，") : "未知"}`,
    `我的创作方向：${direction || "没有填写，请按这条视频所在的领域给出改编建议"}`,
    "",
    // 不加这句，小模型常常挑着答：随机漏掉整个维度，括号里的小问也只答一两个
    "格式要求：第②部分的表格固定 10 行，按维度 1 到 10 的顺序各占一行，每行的“具体发现”要逐个回答该维度列出的所有小问（例如第 4 项要分别写段落顺序、信息递进、冲突、悬念、转折、论据、兑现承诺的时间点），看不出来的写“未知”或“视频里没有”，不能省略。第③部分每一行的“为什么这样拍”都要写，说清这一段里有用意的处理（场景、站位、对话、动作之类，看得出哪个写哪个），不能只重复画面内容。②③两张表都用标准 Markdown 表格输出（半角竖线 | 分隔，带表头分隔行）。",
    ...(focus ? [focus] : []),
  ].join("\n");
}

function providerError(status, body) {
  return Object.assign(new AnalysisError("provider_error", providerMessage(status, body, {
    413: "视频太大，接口收不下",
    524: "中转站等太久没等到回答（524），视频越长越慢，换个短一点的视频或反应快的模型再试",
  }), 502), { transient: transientFailure(status, body) });
}

// 远端中转站在回答流里回过「Upstream HTTP/2 stream failed」：它和上游之间断了，重发多半就好
// OpenRouter 流里断了回「Provider disconnected unexpectedly」，方舟内部错误 500 让「Please retry later」
const TRANSIENT = /stream (failed|error|closed|reset)|HTTP\/2|timed? ?out|connection (reset|closed|refused|error)|\bEOF\b|disconnected|overloaded|temporarily|try again|retry later|bad gateway|gateway time-?out|service unavailable/iu;

/**
 * 接口这次的报错是不是临时的（重发多半就好）：网关 502/504/520/522、过载 529，或者 500/503、回答流里报错（status 0），
 * 正文说的是上游断流、超时、网关这类。参数不对、Key 不对、没开通模型（503 model_not_found）、限流都不算。
 */
export function transientFailure(status, body) {
  return [502, 504, 520, 522, 529].includes(status) || ([0, 500, 503].includes(status) && TRANSIENT.test(String(body ?? "")));
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** 发给 OpenAI 兼容的 /chat/completions，流式读完（百炼 Qwen-Omni 只认流式，长回答也不会卡超时）。 */
export async function requestAnalysis(options) {
  if (isLocalRuntime(options.config?.runtime)) return localAnalysis(options);
  return sendWithRetry(() => analysis(options), {
    signal: options.signal,
    fail: ({ text, dropped }) => Object.assign(new AnalysisError("provider_unreachable", text, 502), { dropped }),
  });
}

/**
 * 本机 CLI 看截图：一次性、不带工具。不自动重发（重发白花订阅额度）。
 * localAi 是 collector/localAi.mjs 的实例，由调用方带来。
 */
async function localAnalysis({ config, video, parts, signal, localAi }) {
  const label = LOCAL_RUNTIMES[config.runtime].label;
  if (!parts) throw new AnalysisError("video_unsupported", `${label} 看不了整段视频，要开着应用先拆成截图。`, 422);
  if (!localAi) throw new AnalysisError("local_runtime_unavailable", "本机 AI 没准备好，请重启应用。", 503);
  let markdown;
  try {
    markdown = await localAi.ask(config.runtime, { model: config.model, parts, prompt: analysisPrompt(video, config.direction, config.focus), signal });
  } catch (error) {
    if (error instanceof LocalAiError) throw new AnalysisError(error.code, error.message, error.status);
    throw error;
  }
  if (!markdown.trim()) throw new AnalysisError("empty_answer", `${label} 这次什么都没回，稍后再试。`, 502);
  return markdown;
}

/**
 * parts：不发整段视频时换成别的内容（AI 剪辑给看不了视频的模型发截图和测出来的数字），提示词照旧接在最后。
 * prompt：换掉整份拆解提示词（AI 剪辑转写字幕用）。
 */
async function analysis({ config, video, videoBase64, parts, prompt, signal, fetchImpl = modelFetch }) {
  const send = (effort) => fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      // 方舟默认只答 4k，表格一多就截断
      max_tokens: MAX_ANSWER_TOKENS,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{
        role: "user",
        content: [
          ...(parts ?? [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${videoBase64}` } }]),
          { type: "text", text: prompt ?? analysisPrompt(video, config.direction, config.focus) },
        ],
      }],
    }),
  });
  // 截图版的镜头、节拍都是测好的，让推理模型少想一会儿：想太久，套着 Cloudflare 的中转站 100 秒没回第一个字就断（524）。
  // 不认这个参数的接口回 400/422，说法各家不一（OpenAI 点名参数，Ollama 说模型 does not support thinking），所以不看正文：
  // 去掉再发一次，真是别的错（比如图片太大）第二次照样报出来
  let response = await send(parts ? "low" : null);
  if (parts && (response.status === 400 || response.status === 422)) {
    await response.text().catch(() => "");
    response = await send(null);
  }
  if (!response.ok) throw providerError(response.status, await response.text().catch(() => ""));
  let text = "";
  let finish = null;
  if (!String(response.headers.get("content-type") ?? "").includes("event-stream")) {
    // 不支持流式的接口会直接回整段 JSON
    const body = await readJson(response);
    if (!body || typeof body !== "object") {
      throw new AnalysisError("provider_error", `接口回的内容看不懂（不是 JSON），检查一下接口地址是不是 OpenAI 兼容的地址（一般以 /v1 或 /api/v3 结尾）。这次请求的是 ${config.baseUrl}/chat/completions。`, 502);
    }
    if (body.error) throw providerError(0, JSON.stringify(body));
    const choice = body.choices?.[0];
    text = choice?.message?.content ?? "";
    finish = choice?.finish_reason ?? null;
  } else {
    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk?.error) throw providerError(0, JSON.stringify(chunk));
      const choice = chunk?.choices?.[0];
      text += choice?.delta?.content ?? "";
      finish = choice?.finish_reason ?? finish;
    }
  }
  if (!text.trim()) throw new AnalysisError("empty_answer", "接口没有返回内容，换个模型或稍后再试。", 502);
  return finish === "length" ? text + TRUNCATED_NOTE : text;
}

export class AnalysisLibrary {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.saving = Promise.resolve();
  }

  async load() {
    let items = [];
    try { items = JSON.parse(await readFile(this.file, "utf8")); } catch { /* 第一次用或文件坏了都从空库开始 */ }
    this.items = Array.isArray(items) ? items.filter((item) => typeof item?.id === "string") : [];
    for (const item of this.items) {
      if (item.status === "running") Object.assign(item, { status: "failed", stage: null, error: "上次解析到一半采集器关掉了，请重新解析。" });
    }
  }

  list() { return this.items; }

  put(entry) {
    this.items = [entry, ...this.items.filter((item) => item.id !== entry.id)].slice(0, MAX_ITEMS);
    return this.save();
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return before === this.items.length ? Promise.resolve(false) : this.save().then(() => true);
  }

  save() {
    // look 是挂给页面拆视频的活儿，只在内存里
    const data = JSON.stringify(this.items.map(({ look: _look, ...item }) => item));
    this.saving = this.saving.then(async () => {
      await writeFile(`${this.file}.tmp`, data, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    }).catch((error) => console.error("解析库保存失败:", error));
    return this.saving;
  }
}

/** 开始解析一条视频：同一链接再解析就覆盖原来那条（解析中的直接返回）。下载出错会同步抛出（比如采集器正忙）。 */
export function startAnalysis({ library, collector, url, config, looks, localAi, fetchImpl = modelFetch, pollMs = 1_000 }) {
  const sourceUrl = normalizeDouyinVideoUrl(url);
  const existing = library.list().find((item) => item.sourceUrl === sourceUrl);
  if (existing?.status === "running") return existing;
  const job = collector.startVideoDownload(sourceUrl, { smallest: true });
  const now = new Date().toISOString();
  const entry = {
    id: existing?.id ?? randomUUID(),
    sourceUrl,
    status: "running",
    stage: "downloading",
    video: existing?.video ?? null,
    model: isLocalRuntime(config.runtime) ? runtimeLabel(config.runtime, config.model) : config.model,
    // 重新解析失败时留着上一次的结果
    markdown: existing?.markdown ?? null,
    error: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  void library.put(entry);
  void runAnalysis({ library, entry, collector, jobId: job.id, config, looks, localAi, fetchImpl, pollMs });
  return entry;
}

// 看不了视频的模型：页面在浏览器里拆出来的镜头截图、镜头表和节拍
const LOOK_FOCUS = "上面不是原视频，是应用把这条视频拆出来的材料：镜头表、闪白位置、音乐节拍是程序测出来的，可以直接用；截图是镜头中间的一帧（镜头很多时只挑了一部分）。材料来源上面已经说明了，开头不用再写缺了原视频、音轨或台词，直接按①到⑤输出；听不到的项（台词、旁白、音效、歌词）写「听不到」，不要编。第③部分的时间轴按镜头表的分段写。如果你看不到截图，不要写拆解，只回答一行：NO_IMAGES。";
const VIDEO_FOCUS = "如果你其实看不到视频画面（只拿到了文字信息），不要写拆解，只回答一行：NO_VIDEO。";
const LOOK_NOTE = "> 这个模型看不了视频，下面是按应用拆出的镜头截图、镜头表和音乐节拍写的，听不到台词和旁白。\n\n";

// 整段视频转成 base64 塞进一个请求，接口一般限请求体 64MB（方舟、中转站超了回 413）：文件超过 45MB 先让应用页面重编一份小的再发；
// 压完还超，或者接口照样回 413，就把目标减半、从原片重压，最多压 3 次
const WHOLE_BYTES = 45 * 1024 * 1024;
const MAX_SQUEEZES = 3;

/** 挂给应用页面的活儿记在这一条解析上（不存盘），页面轮询 /v1/analyses/looks 看到就接。 */
const lookHolder = (entry) => ({
  id: entry.id,
  live: () => entry.status === "running",
  get: () => entry.look ?? null,
  set: (job) => { if (job) entry.look = job; else delete entry.look; },
  touch: () => { entry.updatedAt = new Date().toISOString(); },
});

/** 整段视频发给模型；模型看不了（接口拒收、回答说没看到）就返回 null，改拆截图。 */
async function watchWhole({ config, entry, filePath, looks, fetchImpl, update }) {
  let bytes = await readFile(filePath);
  let limit = WHOLE_BYTES;
  let ask = WHOLE_BYTES;
  let squeezes = 0;
  for (;;) {
    if (bytes.length > limit) {
      if (squeezes === MAX_SQUEEZES) throw new AnalysisError("video_too_large", `视频压缩了 ${MAX_SQUEEZES} 次还是太大，接口收不下，换一条短一点的视频再试。`, 413);
      ask = Math.min(ask, limit);
      await update({ stage: "squeezing" });
      try {
        ({ video: bytes } = await looks.ask(lookHolder(entry), { kind: "squeeze", url: looks.offerFile(filePath), name: entry.video?.title, bytes: ask }));
      } catch (error) {
        // 浏览器编不了（没有 WebCodecs 之类）：退回拆截图，起码还能解析
        if (error?.code === "look_failed") return null;
        throw error;
      }
      await update({ stage: "analyzing" });
      squeezes += 1;
      ask = Math.floor(ask / 2);
      continue;
    }
    let status = 0;
    const watched = async (...args) => {
      const response = await fetchImpl(...args);
      status = response.status;
      return response;
    };
    try {
      const markdown = await requestAnalysis({ config: { ...config, focus: VIDEO_FOCUS }, video: entry.video, videoBase64: bytes.toString("base64"), signal: AbortSignal.timeout(MODEL_TIMEOUT_MS), fetchImpl: watched });
      return seesNoVideo(markdown) ? null : markdown;
    } catch (error) {
      if (status === 413 && squeezes < MAX_SQUEEZES) { limit = Math.floor(bytes.length / 2); continue; }
      if (error instanceof AnalysisError && error.code === "provider_error" && videoRefused(status, error.message)) return null;
      throw error;
    }
  }
}

async function lookAt({ entry, config, filePath, looks, localAi, fetchImpl, update }) {
  await update({ stage: "looking" });
  const look = await looks.ask(lookHolder(entry), { kind: "reference", url: looks.offerFile(filePath), name: entry.video?.title });
  await update({ stage: "analyzing" });
  const markdown = await requestAnalysis({ config: { ...config, focus: LOOK_FOCUS }, video: entry.video, parts: lookMaterials(look).parts, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS), fetchImpl, localAi });
  if (seesNoImages(markdown)) throw new AnalysisError("images_unsupported", "解析库配置的模型连截图也没看到，换一个能看图片的模型再试。", 502);
  return LOOK_NOTE + markdown;
}

async function runAnalysis({ library, entry, collector, jobId, config, looks, localAi, fetchImpl, pollMs }) {
  const update = (patch) => {
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    return library.save();
  };
  try {
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let job = collector.getVideoDownloadJob(jobId);
    while (job?.status === "queued" || job?.status === "running") {
      if (Date.now() > deadline) throw new AnalysisError("download_timeout", "视频下载太久了，请稍后重试。");
      await delay(pollMs);
      job = collector.getVideoDownloadJob(jobId);
    }
    if (job?.status !== "complete") throw new AnalysisError("download_failed", job?.error ?? "视频没下载下来，请稍后重试。");
    const filePath = collector.getVideoDownloadFilePath(jobId);
    if (!filePath?.toLowerCase().endsWith(".mp4")) throw new AnalysisError("not_video", "图文作品暂时不能解析，只支持视频。");
    await update({ stage: "analyzing", video: job.video ?? entry.video });
    // 配置时测出看不了视频就直接拆截图；能看或没测过先整段发，模型看不了再拆
    let markdown = config.videoInput === false || !looks ? null : await watchWhole({ config, entry, filePath, looks, fetchImpl, update });
    if (markdown === null && !looks) markdown = await requestAnalysis({ config, video: entry.video, videoBase64: (await readFile(filePath)).toString("base64"), signal: AbortSignal.timeout(MODEL_TIMEOUT_MS), fetchImpl, localAi });
    if (markdown === null) markdown = await lookAt({ entry, config, filePath, looks, localAi, fetchImpl, update });
    await update({ status: "complete", stage: null, markdown, error: null });
  } catch (error) {
    // 关应用时本机 CLI 被强杀（local_closed）也算采集器关掉
    const message = error?.code === "interrupted" || error?.code === "local_closed" ? "上次解析到一半采集器关掉了，请重新解析。"
      : error instanceof AnalysisError ? `${error.message}${error.dropped ? "点「重新解析」再试一次。" : ""}`
      : typeof error?.code === "string" && error.code.startsWith("look_") ? error.message
      : error?.name === "TimeoutError" ? "接口太久没答完，请稍后重试。"
      : "解析失败，请稍后重试。";
    await update({ status: "failed", stage: null, error: message });
  }
}
