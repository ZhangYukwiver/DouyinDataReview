import { setTimeout as delay } from "node:timers/promises";

import { isLocalRuntime, parseLocalConfig } from "../localAi.mjs";
import { modelFetch } from "../systemProxy.mjs";

// 对话循环：OpenAI 兼容的 /chat/completions + function calling，流式读回答，
// 模型要调工具就执行完把结果回给它，直到它不再调工具为止。接口 Key 每次随请求带来，不落盘。
// 从拆出去之前的 AI 剪辑搬回来的（collector/aiEdit/chat.mjs），去掉了贴图那一套。

export class AssistantError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
    this.status = status;
  }
}

// 一轮最多调几次工具：只防模型原地打转
export const MAX_TOOL_CALLS = 60;
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
  message: "这次回答写到了长度上限，这个工具调用的参数被截断了，没有执行。把操作拆小一点再做。",
};

/**
 * 接口地址常见两种填法错误：只填域名（中转站根路径回的是网页），或粘了整条 …/chat/completions。
 * 前者补上 OpenAI 兼容的版本路径（方舟 /api/v3，其余 /v1），后者去掉末尾。
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

/** 请求体里的接口配置：信任边界，地址只认 http(s)，各项限长。 */
export function parseAssistantConfig(value) {
  // 本机的 Codex / Claude Code：不要地址和 Key（collector/localAi.mjs）
  if (isLocalRuntime(value?.runtime)) return parseLocalConfig(value, (message) => new AssistantError("invalid_config", message));
  const text = (item, max) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  const baseUrl = apiBaseUrl(text(value?.baseUrl, 300));
  const apiKey = text(value?.apiKey, 400);
  const model = text(value?.model, 120);
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AssistantError("invalid_config", "接口地址要以 https:// 开头。");
  if (!apiKey || !model) throw new AssistantError("invalid_config", "先在设置的「AI」页里填好 Key 和模型。");
  return { baseUrl, apiKey, model };
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
 * 发一次模型请求，网络断了悄悄重发：还没收到文字、10 秒内连接就断马上重发一次；
 * 回答已经开始又被掐断（中转站或代理节点不稳）歇一下再发，最多两次。
 * 请求本身没有副作用（工具要等整段回答收完才执行），重发是安全的。网络错误交给 fail 换成调用方自己的报错。
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

/**
 * 接口回非 2xx（或流里报错）时给用户看的话：原因 + 接口原文；网关的错误页是整页 HTML，不往里塞。
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

// 中转站在回答流里回过「Upstream HTTP/2 stream failed」：它和上游之间断了，重发多半就好
const TRANSIENT = /stream (failed|error|closed|reset)|HTTP\/2|timed? ?out|connection (reset|closed|refused|error)|\bEOF\b|disconnected|overloaded|temporarily|try again|retry later|bad gateway|gateway time-?out|service unavailable/iu;

/** 接口这次的报错是不是临时的（重发多半就好）：网关 502/504/520/522、过载 529，或者 500/503、流里报错（status 0）说的是断流、超时这类。 */
export function transientFailure(status, body) {
  return [502, 504, 520, 522, 529].includes(status) || ([0, 500, 503].includes(status) && TRANSIENT.test(String(body ?? "")));
}

function isArk(baseUrl) {
  try { return /(?:^|\.)volces\.com$/iu.test(new URL(baseUrl).hostname); } catch { return false; }
}

function providerError(status, body) {
  return Object.assign(new AssistantError("provider_error", providerMessage(status, body, {
    400: "接口不接受这次请求（模型可能不支持工具调用）",
    413: "请求太大，接口收不下",
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
    fail: ({ text, dropped }) => Object.assign(new AssistantError("provider_unreachable", text, 502), { dropped }),
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
      // 方舟的 seed 模型默认会先深度思考，查数据、点功能用不上，还慢
      ...(isArk(config.baseUrl) ? { thinking: { type: "disabled" } } : {}),
    }),
  });
  if (!response.ok) throw providerError(response.status, await response.text().catch(() => ""));
  let text = "";
  let finish = null;
  const calls = [];
  if (!String(response.headers.get("content-type") ?? "").includes("event-stream")) {
    // 不支持流式的接口会直接回整段 JSON
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 下面报错 */ }
    if (!body || typeof body !== "object") {
      throw new AssistantError("provider_error", `接口回的内容看不懂（不是 JSON），检查一下接口地址是不是 OpenAI 兼容的地址（一般以 /v1 或 /api/v3 结尾）。这次请求的是 ${config.baseUrl}/chat/completions。`, 502);
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

const size = (message) => (typeof message.content === "string" ? message.content.length : 0) + JSON.stringify(message.tool_calls ?? "").length;

const COMPACT_ENTRY_CHARS = 300;
const OMITTED = "较早的内容，细节已省略；还要用就用同样的参数再调一次";
const OMITTED_ARGUMENTS = "较早的参数，细节已省略";
// 这几个工具的结果后面还用得上（会话 id、作品 id、账号）：压缩和本机 CLI 转述时都留开头这么多字
export const KEEP_RESULT = { app_overview: 1_500, list_conversations: 1_500, douyin_read: 1_500, search_records: 1_000 };

// 截断时别把 emoji 劈成半个（孤立的代理项放进 JSON 发给接口可能被拒）
export const shorten = (text, max) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max).replace(/[\ud800-\udbff]$/u, "")}…` : value;
};

/** 长的工具结果只留成没成功和报错原因（KEEP_RESULT 里的工具再留开头），长的工具参数只留开头；短的不动（反复压也不会变）。 */
function compactEntry(entry, name) {
  if (entry.role === "tool" && typeof entry.content === "string" && entry.content.length > COMPACT_ENTRY_CHARS) {
    let result = null;
    try { result = JSON.parse(entry.content); } catch { /* 不是 JSON 就只留省略说明 */ }
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
    return compacted.content.length < entry.content.length ? compacted : entry;
  }
  const long = (call) => typeof call?.function?.arguments === "string" && call.function.arguments.length > COMPACT_ENTRY_CHARS;
  if (entry.role === "assistant" && entry.tool_calls?.some(long)) {
    return {
      ...entry,
      // 还得是合法 JSON：有的中转站转成别家格式时会解析历史里的参数
      tool_calls: entry.tool_calls.map((call) => (long(call) ? { ...call, function: { ...call.function, arguments: JSON.stringify({ omitted: `${OMITTED_ARGUMENTS}：${shorten(call.function.arguments, 80)}` }) } } : call)),
    };
  }
  return entry;
}

/**
 * 历史超出预算时就地压缩：从最早的消息起，把长的工具结果和参数换成一句省略说明，用户的话和模型的文字回答原样留着，
 * 消息结构不变。一次压到预算的一半，前缀缓存只在压的那次失效。最近一轮不压。
 */
export function compactHistory(history, maxChars = MAX_HISTORY_CHARS) {
  let total = history.reduce((sum, entry) => sum + size(entry), 0);
  if (total <= maxChars) return;
  const last = history.findLastIndex((entry) => entry.role === "user");
  const names = new Map();
  for (let index = 0; index < last && total > maxChars / 2; index += 1) {
    for (const call of history[index].tool_calls ?? []) names.set(call.id, call.function?.name);
    const compacted = compactEntry(history[index], names.get(history[index].tool_call_id));
    total += size(compacted) - size(history[index]);
    history[index] = compacted;
  }
}

/** 压缩后还是太长，就从最早的整轮（以用户消息开头）开始丢，工具调用和结果不会被拆开。 */
export function trimHistory(history, maxChars = MAX_HISTORY_CHARS) {
  let total = 0;
  let start = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    total += size(history[index]);
    if (history[index].role === "user") {
      if (total > maxChars && start < history.length) break;
      start = index;
    }
  }
  return start < history.length ? history.slice(start) : history;
}

const RECALL_EACH = 200;
const RECALL_TOTAL = 3_000;

/** 被丢掉的那些用户原话，一条一行：每条截到 200 字、合计不超过 3000 字，放不下时留离现在近的。 */
export function recallLines(entries) {
  const lines = [];
  let total = 0;
  for (const entry of [...entries].reverse()) {
    if (entry?.role !== "user") continue;
    const words = shorten(String(entry.content ?? "").replace(/\s+/gu, " "), RECALL_EACH);
    if (!words) continue;
    if (total + words.length > RECALL_TOTAL) break;
    total += words.length;
    lines.unshift(`- ${words}`);
  }
  return lines;
}

/** 这次请求带上的历史：超预算丢掉了更早的整轮时，把丢掉的用户原话附在留下的第一条用户消息前面（只进这次请求）。 */
export function requestHistory(history, maxChars = MAX_HISTORY_CHARS) {
  const kept = trimHistory(history, maxChars);
  if (kept.length === history.length) return history;
  const lines = recallLines(history.slice(0, history.length - kept.length));
  if (!lines.length) return kept;
  const [first, ...rest] = kept;
  return [{ ...first, content: `【应用自动附上】更早的对话已经省略，用户之前说过：\n${lines.join("\n")}\n【用户这次说的话】\n${first.content ?? ""}` }, ...rest];
}

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
 * 跑一轮对话：history 是原始消息（最后一条是用户刚说的话），会被就地追加（太长时旧消息就地压缩）。
 * system() 每次请求前重新生成；execute(call) 执行一个工具并返回给模型的结果对象；
 * onText(累计文字) 用于流式显示；返回 { text: 这一轮所有文字, toolCalls: 调用次数 }。
 */
export async function runConversation({ config, history, tools, system, execute, signal, fetchImpl = modelFetch, onText = () => undefined, maxToolCalls = MAX_TOOL_CALLS }) {
  let calls = 0;
  let limited = false;
  const parts = [];
  const joined = (current = "") => [...parts, current].filter(Boolean).join("\n\n");
  for (;;) {
    signal?.throwIfAborted();
    compactHistory(history);
    const messages = [{ role: "system", content: await system() }, ...requestHistory(history)];
    let streamed = "";
    let reply;
    try {
      reply = await requestCompletion({
        config, messages, tools, signal, fetchImpl,
        // 用完次数后最后再问一次，只让它用文字收尾
        toolChoice: limited ? "none" : "auto",
        onText: (text) => { streamed = text; onText(joined(text)); },
      });
    } catch (error) {
      // 停止时把已经说出来的半句留在历史里，下一轮模型知道自己说到哪了
      if (streamed.trim()) history.push({ role: "assistant", content: streamed });
      if (error?.dropped || error?.transient) error.message += "可以发「继续」接着做。";
      throw error;
    }
    if (reply.finishReason === "content_filter") {
      throw new AssistantError("provider_error", "这次回答被接口的内容审核拦下了，换个说法再试。", 502);
    }
    const text = reply.text.trim();
    const toolCalls = limited ? [] : reply.toolCalls;
    if (!text && !toolCalls.length && !limited && !calls && !parts.length) {
      throw new AssistantError("provider_error", "接口这次什么都没回，换个说法或稍后再试。", 502);
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
    // 写到长度上限时最后一个工具调用的参数多半没写完：不执行，告诉模型拆小再做
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
