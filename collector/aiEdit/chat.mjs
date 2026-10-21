import { modelFetch } from "../systemProxy.mjs";
import { apiBaseUrl, providerMessage, readJson, sendWithRetry } from "../videoAnalysis.mjs";
import { AiEditError } from "./library.mjs";

// 对话循环：OpenAI 兼容的 /chat/completions + function calling，流式读回答，
// 模型要调工具就执行完把结果回给它，直到它不再调工具为止。接口 Key 每次随请求带来，不落盘。

export const MAX_TOOL_CALLS = 40;
const MAX_ANSWER_TOKENS = 16_000;
const MAX_HISTORY_CHARS = 120_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const LIMIT_RESULT = {
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
  return new AiEditError("provider_error", providerMessage(status, body, {
    // 不带工具的请求（配置时测能不能看视频）被拒和工具调用无关
    400: withTools ? "接口不接受这次请求（模型可能不支持工具调用）" : "接口不接受这次请求",
    524: "中转站等了两分钟左右，模型还没开始回答（524），换个反应快的模型或把要求拆小一点再试",
  }), 502);
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
    fail: ({ text, dropped }) => new AiEditError("provider_unreachable", dropped ? `${text}可以发「继续」接着做。` : text, 502),
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

function assistantMessage(text, toolCalls) {
  return {
    role: "assistant",
    content: text ?? "",
    ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) } : {}),
  };
}

function size(message) {
  return (typeof message.content === "string" ? message.content.length : 0) + JSON.stringify(message.tool_calls ?? "").length;
}

/** 历史太长时从最早的整轮（以用户消息开头）开始丢，工具调用和结果不会被拆开。 */
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
 * 跑一轮对话：history 是这个会话的原始消息（最后一条是用户刚说的话），会被就地追加。
 * system() 每次请求前重新生成，放不常变的内容；context() 可选，返回每次附在最后、不进历史的一条消息
 * （工程现状这类每步都变的内容：放在最后，前面的系统提示和历史在一轮里保持不变，接口的前缀缓存才命中得了）。
 * execute(call) 执行一个工具并返回给模型的结果对象。onText(累计文字) 用于流式显示；返回这一轮所有文字拼起来的结果。
 */
export async function runConversation({ config, history, tools, system, context, execute, signal, fetchImpl = modelFetch, onText = () => undefined, maxToolCalls = MAX_TOOL_CALLS }) {
  let calls = 0;
  let limited = false;
  const parts = [];
  const joined = (current = "") => [...parts, current].filter(Boolean).join("\n\n");
  for (;;) {
    signal?.throwIfAborted();
    const extra = context ? await context() : "";
    const messages = [{ role: "system", content: await system() }, ...trimHistory(history), ...(extra ? [{ role: "user", content: extra }] : [])];
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
