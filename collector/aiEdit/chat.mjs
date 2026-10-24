import { isLocalRuntime, parseLocalConfig } from "../localAi.mjs";
import { modelFetch } from "../systemProxy.mjs";
import { apiBaseUrl, providerMessage, readJson, sendWithRetry, transientFailure } from "../videoAnalysis.mjs";
import { AiEditError } from "./library.mjs";

// 对话循环：OpenAI 兼容的 /chat/completions + function calling，流式读回答，
// 模型要调工具就执行完把结果回给它，直到它不再调工具为止。接口 Key 每次随请求带来，不落盘。

// 一轮最多调几次工具：40 个画面逐个改切点、加转场和关键帧就要一百多次，40 次常常做到一半被叫停（远端 DeepSeek 实测）。
// 只防模型原地打转；历史超预算时 trimHistory 只裁更早的轮次，这一轮整轮保留
export const MAX_TOOL_CALLS = 200;
const MAX_ANSWER_TOKENS = 16_000;
const MAX_HISTORY_CHARS = 120_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
export const LIMIT_RESULT = {
  ok: false,
  code: "tool_limit",
  message: `这一轮已经调用了 ${MAX_TOOL_CALLS} 次工具，到上限了。不要再调用工具，直接告诉用户做到了哪里、还差什么。`,
};
const TRUNCATED_RESULT = {
  ok: false,
  code: "output_truncated",
  message: "这次回答写到了长度上限，这个工具调用的参数被截断了，没有执行。把操作拆小一点再做（比如字幕分几批加、一次少加几个片段）。",
};

/** 请求体里的接口配置：信任边界，地址只认 http(s)，各项限长（同解析库的写法，但配置是 AI 剪辑自己的）。 */
export function parseEditConfig(value) {
  // 本机的 Codex / Claude Code：不要地址和 Key（collector/localAi.mjs）
  if (isLocalRuntime(value?.runtime)) return parseLocalConfig(value, (message) => new AiEditError("invalid_config", message));
  const text = (item, max) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  const baseUrl = apiBaseUrl(text(value?.baseUrl, 300));
  const apiKey = text(value?.apiKey, 400);
  const model = text(value?.model, 120);
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AiEditError("invalid_config", "接口地址要以 https:// 开头。");
  if (!apiKey || !model) throw new AiEditError("invalid_config", "先在 AI 剪辑的接口设置里填好 Key 和模型。");
  // 配置时测过能不能看视频（页面测完一起存）；没测过是 null，解析参考视频时先试整段视频
  return { baseUrl, apiKey, model, videoInput: typeof value?.videoInput === "boolean" ? value.videoInput : null };
}

function isArk(baseUrl) {
  try { return /(?:^|\.)volces\.com$/iu.test(new URL(baseUrl).hostname); } catch { return false; }
}

function providerError(status, body, withTools = true) {
  return Object.assign(new AiEditError("provider_error", providerMessage(status, body, {
    // 不带工具的请求（配置时测能不能看视频）被拒和工具调用无关
    400: withTools ? "接口不接受这次请求（模型可能不支持工具调用）" : "接口不接受这次请求",
    413: "请求太大，接口收不下（多半是图太多或太大）",
    524: "中转站等了两分钟左右，模型还没开始回答（524），换个反应快的模型或把要求拆小一点再试",
  }), 502), { transient: transientFailure(status, body), httpStatus: status });
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

/**
 * 工具调用的增量按 index 拼：每一片（包括带 id 和名字的第一片）的 arguments 都只拼一次。
 * 有的接口不给 index，就按 id 认，没有 id 就当作接着上一个。
 */
function mergeToolCallDeltas(calls, deltas) {
  for (const delta of deltas) {
    let index = Number.isInteger(delta?.index) && delta.index >= 0 ? delta.index : null;
    if (index === null) {
      const byId = delta?.id ? calls.findIndex((call) => call?.id === delta.id) : -1;
      index = byId >= 0 ? byId : delta?.id || !calls.length ? calls.length : calls.length - 1;
    }
    const call = calls[index] ??= { id: "", name: "", arguments: "" };
    if (delta?.id) call.id = delta.id;
    const name = delta?.function?.name;
    // 名字通常只在第一片；个别接口每片都重复完整名字，那就不再拼
    if (typeof name === "string" && name) call.name = call.name && !name.startsWith(call.name) ? call.name + name : name;
    const args = delta?.function?.arguments;
    if (typeof args === "string") call.arguments += args;
    else if (args && typeof args === "object") call.arguments += JSON.stringify(args);
  }
}

/** 发一次 /chat/completions（流式），返回这一轮的文字和工具调用。onText 收到累计的文字。 */
export async function requestCompletion(options) {
  let received = false;
  const onText = options.onText ?? (() => undefined);
  return sendWithRetry(() => completion({ ...options, onText: (text) => { received = true; onText(text); } }), {
    signal: options.signal,
    received: () => received,
    fail: ({ text, dropped }) => Object.assign(new AiEditError("provider_unreachable", text, 502), { dropped }),
  });
}

async function completion({ config, messages, tools, toolChoice, signal, fetchImpl = modelFetch, onText = () => undefined }) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      max_tokens: MAX_ANSWER_TOKENS,
      messages,
      ...(tools?.length ? { tools, tool_choice: toolChoice ?? "auto" } : {}),
      // 方舟的 seed 模型默认会先深度思考，剪辑指令用不上，还慢
      ...(isArk(config.baseUrl) ? { thinking: { type: "disabled" } } : {}),
    }),
  });
  if (!response.ok) throw providerError(response.status, await response.text().catch(() => ""), Boolean(tools?.length));
  let text = "";
  let finish = null;
  const calls = [];
  if (!String(response.headers.get("content-type") ?? "").includes("event-stream")) {
    // 不支持流式的接口会直接回整段 JSON
    const body = await readJson(response);
    if (!body || typeof body !== "object") {
      throw new AiEditError("provider_error", `接口回的内容看不懂（不是 JSON），检查一下接口地址是不是 OpenAI 兼容的地址（一般以 /v1 或 /api/v3 结尾）。这次请求的是 ${config.baseUrl}/chat/completions。`, 502);
    }
    if (body?.error) throw providerError(0, JSON.stringify(body));
    const choice = body?.choices?.[0];
    text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (text) onText(text);
    mergeToolCallDeltas(calls, (choice?.message?.tool_calls ?? []).map((call, index) => ({ index, ...call })));
    finish = choice?.finish_reason ?? null;
  } else {
    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk?.error) throw providerError(0, JSON.stringify(chunk));
      const choice = chunk?.choices?.[0];
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) {
        text += piece;
        onText(text);
      }
      if (Array.isArray(choice?.delta?.tool_calls)) mergeToolCallDeltas(calls, choice.delta.tool_calls);
      finish = choice?.finish_reason ?? finish;
    }
  }
  const toolCalls = calls.filter((call) => call?.name).map((call, index) => ({ ...call, id: call.id || `call_${Date.now().toString(36)}_${index}` }));
  return { text, toolCalls, finishReason: finish };
}

export function assistantMessage(text, toolCalls) {
  return {
    role: "assistant",
    content: text ?? "",
    ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) } : {}),
  };
}

// 用户贴的图不进历史正文（请求时才展开），发出去的每张按这么多字算长度
const IMAGE_CHARS = 2_000;
// 最近几条带图的用户消息才把图发过去，更早的只在文字里有名字（每次请求都重发，图多了又慢又贵）
const IMAGE_MESSAGES = 2;

const hasImages = (entry) => entry.role === "user" && Array.isArray(entry.attachments) && entry.attachments.length > 0;

/** 请求时会把图发出去的那几条消息的下标（最近 IMAGE_MESSAGES 条带图的用户消息）。 */
function imageIndices(history) {
  return new Set(history.flatMap((entry, index) => (hasImages(entry) ? [index] : [])).slice(-IMAGE_MESSAGES));
}

function size(message, withImages = false) {
  return (typeof message.content === "string" ? message.content.length : 0) + JSON.stringify(message.tool_calls ?? "").length
    + (withImages && Array.isArray(message.attachments) ? message.attachments.length * IMAGE_CHARS : 0);
}

const COMPACT_ENTRY_CHARS = 300;
// 告诉模型细节怎么找回；不点名哪个工具，免得它每轮先把时间线再拉一遍。参考解析的缓存只在内存里，重启过就得重新解析
const OMITTED = "较早的内容，细节已省略；还要用就用同样的参数再调一次（参考解析和节拍一般有缓存、马上返回，应用重启过就要重新解析，很慢，没必要别重调）；时间线和素材以工程现状和系统提示为准";
const OMITTED_ARGUMENTS = "较早的参数，细节已省略";
// 这几个工具的结果后面还用得上（链接、素材 id、拆解结论、技能说明和命令输出）：压缩和本机 CLI 转述时都留开头这么多字
export const KEEP_RESULT = {
  search_douyin: 1_500, search_my_records: 1_500, import_douyin_video: 1_500, analyze_reference: 6_000,
  read_skill: 6_000, run_skill_command: 2_000, skill_job: 1_500,
};

/** 长的工具结果只留成没成功和报错原因（KEEP_RESULT 里的工具再留开头），长的工具参数只留开头；短的不动（反复压也不会变）。 */
function compactEntry(entry, name) {
  if (entry.role === "tool" && typeof entry.content === "string" && entry.content.length > COMPACT_ENTRY_CHARS) {
    let result = null;
    try { result = JSON.parse(entry.content); } catch { /* 不是 JSON 就只留省略说明 */ }
    // 留着开头压过的：不再压一遍
    if (typeof result?.omitted === "string") return entry;
    const keep = result?.ok !== false ? KEEP_RESULT[name] : 0;
    const compacted = {
      ...entry,
      content: JSON.stringify({
        ok: result?.ok !== false,
        ...(typeof result?.code === "string" ? { code: result.code.slice(0, 60) } : {}),
        ...(typeof result?.message === "string" ? { message: shorten(result.message, 120) } : {}),
        ...(keep ? { kept: shorten(entry.content, keep) } : {}),
        omitted: OMITTED,
      }),
    };
    // 本来就没比要留的长多少：压了反而更长（转义），不动
    return compacted.content.length < entry.content.length ? compacted : entry;
  }
  const long = (call) => typeof call?.function?.arguments === "string" && call.function.arguments.length > COMPACT_ENTRY_CHARS;
  if (entry.role === "assistant" && entry.tool_calls?.some(long)) {
    return {
      ...entry,
      // 还得是合法 JSON：有的中转站转成别家格式时会解析历史里的参数（截的时候也别把 emoji 劈成半个）
      tool_calls: entry.tool_calls.map((call) => (long(call) ? { ...call, function: { ...call.function, arguments: JSON.stringify({ omitted: `${OMITTED_ARGUMENTS}：${shorten(call.function.arguments, 80)}` }) } } : call)),
    };
  }
  return entry;
}

/**
 * 历史超出预算时就地压缩：从最早的消息起，把长的工具结果和参数换成一句省略说明，用户的话和模型的文字回答原样留着，
 * 消息结构不变（工具调用和结果照样一一对应）。一次压到预算的一半，之后好一阵不用再压，前缀缓存只在压的那次失效。
 * 最近一轮不压，这一轮的工具结果模型还要接着用。
 */
export function compactHistory(history, maxChars = MAX_HISTORY_CHARS) {
  const sent = imageIndices(history);
  let total = history.reduce((sum, entry, index) => sum + size(entry, sent.has(index)), 0);
  if (total <= maxChars) return;
  const last = history.findLastIndex((entry) => entry.role === "user");
  // 工具结果里只有调用 id，工具名从前面的助手消息里查
  const names = new Map();
  for (let index = 0; index < last && total > maxChars / 2; index += 1) {
    for (const call of history[index].tool_calls ?? []) names.set(call.id, call.function?.name);
    const compacted = compactEntry(history[index], names.get(history[index].tool_call_id));
    total += size(compacted, sent.has(index)) - size(history[index], sent.has(index));
    history[index] = compacted;
  }
}

/** 压缩后还是太长，就从最早的整轮（以用户消息开头）开始丢，工具调用和结果不会被拆开。 */
export function trimHistory(history, maxChars = MAX_HISTORY_CHARS) {
  // 只给真发出去的图记长度；丢的都是更早的轮次，留下来的那段里发图的还是这几条
  const sent = imageIndices(history);
  let total = 0;
  let start = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    total += size(history[index], sent.has(index));
    if (history[index].role === "user") {
      if (total > maxChars && start < history.length) break;
      start = index;
    }
  }
  return start < history.length ? history.slice(start) : history;
}

const APP_NOTE = "【应用自动附上，不是用户说的话】";
const SAID = "【用户这次说的话】";
const RECALL_EACH = 200;
const RECALL_TOTAL = 3_000;

// 截断时别把 emoji 劈成半个（孤立的代理项放进 JSON 发给接口可能被拒）
export const shorten = (text, max) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max).replace(/[\ud800-\udbff]$/u, "")}…` : value;
};

/** 用户真正说的话：前面带着应用附上的说明时，只取「【用户这次说的话】」后面那段。 */
function userWords(content) {
  const text = typeof content === "string" ? content : "";
  const at = text.startsWith(APP_NOTE) ? text.indexOf(SAID) : -1;
  return (at >= 0 ? text.slice(at + SAID.length) : text).trim();
}

/** 被丢掉的那些用户原话，一条一行：每条截到 200 字、合计不超过 3000 字，放不下时留离现在近的。 */
export function recallLines(entries) {
  const lines = [];
  let total = 0;
  for (const entry of [...entries].reverse()) {
    if (entry?.role !== "user") continue;
    const words = shorten(userWords(entry.content).replace(/\s+/gu, " "), RECALL_EACH);
    if (!words) continue;
    if (total + words.length > RECALL_TOTAL) break;
    total += words.length;
    lines.unshift(`- ${words}`);
  }
  return lines;
}

/**
 * 这次请求带上的历史：超预算丢掉了更早的整轮时，把丢掉的用户原话附在留下的第一条用户消息前面
 * （只进这次请求，不写回历史）。trimmed 说明这次真丢了东西。
 */
export function requestHistory(history, maxChars = MAX_HISTORY_CHARS) {
  const kept = trimHistory(history, maxChars);
  if (kept.length === history.length) return { entries: history, trimmed: false };
  const lines = recallLines(history.slice(0, history.length - kept.length));
  if (!lines.length) return { entries: kept, trimmed: true };
  const [first, ...rest] = kept;
  const content = typeof first.content === "string" ? first.content : "";
  // 原来就带着应用附上的说明就并成一段；原来只是用户的话，标出哪段是这次说的
  const body = content.startsWith(`${APP_NOTE}\n`) ? content.slice(APP_NOTE.length + 1) : `${SAID}\n${content}`;
  return { entries: [{ ...first, content: `${APP_NOTE}更早的对话已经省略，用户之前说过：\n${lines.join("\n")}\n${body}` }, ...rest], trimmed: true };
}

// 接口拒收带图的请求一般回 400/415/422；流里或 200 正文里报错时要说的是图
const IMAGE_WORDS = /image|图片|图像|multimodal|多模态|vision|视觉|unknown variant|content type/iu;
// 请求体太大（中转站常见的 nginx 默认只收 1MB）：413，或者流里、200 正文里这么说
const TOO_LARGE_WORDS = /too large|body size|请求体?(?:太|过)大/iu;

// 模型说自己看不了用户贴的图：要么是「我…看不到…图片」、句首直接说「无法查看图片」，要么指着「你发的图」「这张图」，
// 要么说自己是纯文本模型。按分句判断，提到时间线、画面这些的分句说的是工程里的东西，不算
const SEE_NOT = "(?:无法|不能|没法|没办法|没有办法)(?:直接)?(?:查看|看到|看|读取|识别|解析|理解|接收|打开|处理)|看不[到了见清]|读不了|打不开|收不到|没(?:有)?(?:收到|看到)";
const PICTURE = "(?:图片|图像|截图|照片)";
// 「看不到图片里有字」「看不到图片了」「图片素材」说的是图里的东西或工程里的图；「我看不到图片中的内容」还是在说自己
const NOT_INSIDE = "(?![里中上的了]|素材|格式|水印)";
const NOT_INSIDE_MINE = "(?![里中上]有|了|素材|格式|水印)";
const YOUR_PICTURE = `(?:你|您)(?:发|上传|附|贴|提供|分享|给)(?:来|过来)?的[^，。\\n]{0,4}(?:${PICTURE}|图)`;
const CANT_SEE_IMAGES = new RegExp([
  `我(?:目前|暂时|现在|这边|这里)?还?(?:${SEE_NOT})[^，。\\n]{0,8}${PICTURE}${NOT_INSIDE_MINE}`,
  `^(?:抱歉|很抱歉|不好意思|对不起)?\\s*(?:目前|暂时|现在)?还?(?:${SEE_NOT})[^，。\\n]{0,8}${PICTURE}${NOT_INSIDE}`,
  `(?:${SEE_NOT})[^，。\\n]{0,4}(?:${YOUR_PICTURE}|(?:这|那)(?:张|些|几张|两张)(?:${PICTURE}|图))`,
  `${YOUR_PICTURE}[^，。\\n]{0,6}(?:${SEE_NOT})`,
  "纯(?:文本|文字)模型|不支持(?:图片|图像|多模态|视觉)(?:输入|理解|识别|内容)|不支持多模态",
  "\\b(?:I\\s+(?:can(?:no|['’])t|am\\s+(?:unable|not\\s+able)\\s+to)|unable\\s+to|not\\s+able\\s+to)\\s+(?:view|see|process|read|access|open|analy[sz]e)[^.\\n]{0,30}(?:image|picture|photo|screenshot)",
].join("|"), "iu");
const PROJECT_WORDS = /时间线|轨道|素材库|画面|画布|剪映|草稿|片段|timeline|track|canvas/iu;

export function saysCantSeeImages(text) {
  return String(text).slice(0, 300).split(/[，,；;。！？!?\n]/u).some((clause) => !PROJECT_WORDS.test(clause) && CANT_SEE_IMAGES.test(clause.trim()));
}

// 试过看不了图的模型（接口地址|模型），进程内记着，之后只写文字
const BLIND_MODELS = new Set();
// 带图请求太大被拒过的（接口地址|模型）：之后只发用户最新一条消息自己的图，而且总量有上限
const OVERSIZED = new Set();
const OVERSIZED_IMAGE_CHARS = 900_000;

const withoutAttachments = ({ attachments: _attachments, ...message }) => message;

function refusedImages(error) {
  if (error?.code !== "provider_error") return false;
  return [400, 415, 422].includes(error.httpStatus) || ([0, 200].includes(error.httpStatus) && IMAGE_WORDS.test(error.message));
}

function tooLarge(error) {
  if (error?.code !== "provider_error") return false;
  return error.httpStatus === 413 || ([0, 200].includes(error.httpStatus) && TOO_LARGE_WORDS.test(error.message));
}

/**
 * 最近两条带图的用户消息展开成「文字 + 图」；一张图都没读到就回 null（照纯文字发）。
 * tight：接口嫌大过，只展开最后一条用户消息自己的图，加起来不超过 OVERSIZED_IMAGE_CHARS（放不下的只留名字）。
 */
async function withImages(entries, read, tight = false) {
  const withAny = entries.flatMap((entry, index) => (hasImages(entry) ? [index] : []));
  const latest = entries.findLastIndex((entry) => entry.role === "user");
  const picked = tight ? withAny.filter((index) => index === latest) : withAny.slice(-IMAGE_MESSAGES);
  let count = 0;
  let chars = 0;
  const messages = [];
  for (const [index, entry] of entries.entries()) {
    const message = withoutAttachments(entry);
    let urls = picked.includes(index) ? (await Promise.all(entry.attachments.map(read))).filter(Boolean) : [];
    if (tight) urls = urls.filter((url) => (chars += url.length) <= OVERSIZED_IMAGE_CHARS);
    count += urls.length;
    messages.push(urls.length ? { ...message, content: [{ type: "text", text: message.content }, ...urls.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } }))] } : message);
  }
  return count ? messages : null;
}

export const SEE_IMAGES_ACTION = { name: "see_images", summary: "这个模型看不了图片，只告诉了它图片的名字", ok: false };
const TOO_LARGE_ACTION = { ...SEE_IMAGES_ACTION, summary: "图太大，接口收不下，这次只告诉了它图片的名字" };

/**
 * 补齐历史：最后一条带工具调用的助手消息如果有调用没收到结果（中途停止或出错），补一个“没执行”的结果，
 * 否则下一轮接口会因为工具调用和结果对不上而报错。
 */
export function sealHistory(history, message = "用户停止了这一轮，这个工具没有执行。") {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.role === "user") return;
    if (entry.role !== "assistant" || !entry.tool_calls?.length) continue;
    const answered = new Set(history.slice(index + 1).filter((item) => item.role === "tool").map((item) => item.tool_call_id));
    const missing = entry.tool_calls.filter((call) => !answered.has(call.id));
    let insertAt = index + 1;
    while (history[insertAt]?.role === "tool") insertAt += 1;
    history.splice(insertAt, 0, ...missing.map((call) => ({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, code: "stopped", message }) })));
    return;
  }
}

/** 参数是完整的 JSON 才算没被截断：截断了的 JSON 对象一定解析不了。 */
function complete(call) {
  try {
    JSON.parse(call.arguments || "{}");
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑一轮对话：history 是这个会话的原始消息（最后一条是用户刚说的话），会被就地追加（太长时旧消息就地压缩，见 compactHistory）。
 * system() 每次请求前重新生成，放不常变的内容；context() 可选，返回每次附在最后、不进历史的一条消息
 * （工程现状这类每步都变的内容：放在最后，前面的系统提示和历史在一轮里保持不变，接口的前缀缓存才命中得了）。
 * execute(call) 执行一个工具并返回给模型的结果对象。onText(累计文字) 用于流式显示；返回这一轮所有文字拼起来的结果。
 * 用户消息带着 attachments（贴的图）时，readAttachment(附图) 读出 data URL，最近两条带图的消息把图一起发过去；
 * 模型看不了图、或者带图的请求太大接口收不下，就去掉图重发，onAction(动作) 记一条进这一轮的动作列表。
 * onTrimmed() 在历史太长、丢掉了更早的整轮时调用。
 */
export async function runConversation({
  config, history, tools, system, context, execute, signal, fetchImpl = modelFetch, onText = () => undefined, maxToolCalls = MAX_TOOL_CALLS,
  readAttachment = async () => null, onAction = () => undefined, onTrimmed = () => undefined,
}) {
  let calls = 0;
  let limited = false;
  const parts = [];
  const joined = (current = "") => [...parts, current].filter(Boolean).join("\n\n");
  const model = `${config.baseUrl}|${config.model}`;
  const images = new Map();
  const read = (attachment) => {
    if (!images.has(attachment.id)) images.set(attachment.id, Promise.resolve().then(() => readAttachment(attachment)).catch(() => null));
    return images.get(attachment.id);
  };
  let noticed = false;
  const notice = (action) => {
    if (!noticed) onAction({ ...action });
    noticed = true;
  };
  const blind = () => {
    BLIND_MODELS.add(model);
    notice(SEE_IMAGES_ACTION);
  };
  // 用户这次贴了图：只在这一轮第一次回答时看它是不是说看不了图（之后的回答里说「看不到图片」多半指的是时间线）
  const fresh = Boolean(history.at(-1)?.attachments?.length);
  // 这一轮因为图太大去过一次图：剩下的步骤都只写名字，别每步都再撞一次
  let namesOnly = false;
  // 早就知道看不了图、用户这次又贴了图：也让用户知道模型只拿到了名字
  if (BLIND_MODELS.has(model) && fresh) blind();
  for (;;) {
    signal?.throwIfAborted();
    const extra = context ? await context() : "";
    compactHistory(history);
    const { entries, trimmed } = requestHistory(history);
    if (trimmed) onTrimmed();
    const head = [{ role: "system", content: await system() }];
    const tail = extra ? [{ role: "user", content: extra }] : [];
    const plain = () => [...head, ...entries.map(withoutAttachments), ...tail];
    const rich = BLIND_MODELS.has(model) || namesOnly ? null : await withImages(entries, read, OVERSIZED.has(model));
    let streamed = "";
    let reply;
    const send = (messages) => requestCompletion({
      config, messages, tools, signal, fetchImpl,
      // 用完次数后最后再问一次，只让它用文字收尾
      toolChoice: limited ? "none" : "auto",
      onText: (text) => { streamed = text; onText(joined(text)); },
    });
    // 去掉图再发一次：带图时说过的话不留
    const again = () => {
      streamed = "";
      onText(joined());
      return send(plain());
    };
    try {
      if (!rich) reply = await send(plain());
      else {
        let pictured = true;
        try {
          reply = await send([...head, ...rich, ...tail]);
        } catch (error) {
          pictured = false;
          if (tooLarge(error)) {
            // 图太大不是看不了图：这次去掉图重发，之后带图收紧，不记成看不了图
            reply = await again();
            OVERSIZED.add(model);
            namesOnly = true;
            notice(TOO_LARGE_ACTION);
          } else if (refusedImages(error)) {
            // 400 也可能是别的原因：去掉图这次成了，才记下这个模型看不了图
            reply = await again();
            blind();
          } else {
            throw error;
          }
        }
        if (pictured && fresh && !calls && !parts.length && !reply.toolCalls.length && saysCantSeeImages(reply.text)) {
          blind();
          reply = await again();
        }
      }
    } catch (error) {
      // 停止时把已经说出来的半句留在历史里，下一轮模型知道自己说到哪了
      if (streamed.trim()) history.push({ role: "assistant", content: streamed });
      // 断线或中转站临时出错、自动重发也没好：待会儿发「继续」就行（只在对话里这么说，设置里测模型时不说）
      if (error?.dropped || error?.transient) error.message += "可以发「继续」接着做。";
      throw error;
    }
    if (reply.finishReason === "content_filter") {
      throw new AiEditError("provider_error", "这次回答被接口的内容审核拦下了，换个说法再试。", 502);
    }
    const text = reply.text.trim();
    const toolCalls = limited ? [] : reply.toolCalls;
    // 这一轮什么都还没做、接口又什么都没回：别悄悄结束，让用户知道
    if (!text && !toolCalls.length && !limited && !calls && !parts.length) {
      throw new AiEditError("provider_error", "接口这次什么都没回，换个说法或稍后再试。", 502);
    }
    if (text) parts.push(text);
    // 内容为空、也没有工具调用的助手消息不进历史：有的接口不收这种消息，之后每一轮都会报错
    if (text || toolCalls.length) history.push(assistantMessage(reply.text, toolCalls));
    if (!toolCalls.length) {
      let answer = joined();
      if (reply.finishReason === "length") answer = `${answer}\n\n（回答写到了长度上限，后面的没写完。）`.trim();
      if (limited && !answer) answer = `这一轮已经做了 ${maxToolCalls} 步操作，先停在这里，你可以让我接着做。`;
      return { text: answer, toolCalls: calls };
    }
    // 写到长度上限时最后一个工具调用的参数多半没写完：不执行，告诉模型拆小再做（也算一次调用，免得反复截断停不下来）
    const truncated = reply.finishReason === "length";
    for (const call of toolCalls) {
      let result;
      if (calls >= maxToolCalls) {
        limited = true;
        result = LIMIT_RESULT;
      } else if (truncated && !complete(call)) {
        calls += 1;
        result = TRUNCATED_RESULT;
      } else {
        calls += 1;
        signal?.throwIfAborted();
        result = await execute(call, signal);
      }
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (calls >= maxToolCalls) limited = true;
  }
}
