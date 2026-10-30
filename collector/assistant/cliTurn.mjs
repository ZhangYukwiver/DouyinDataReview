import { randomBytes } from "node:crypto";

import { LOCAL_RUNTIMES, LocalAiError } from "../localAi.mjs";
import { AssistantError, KEEP_RESULT, LIMIT_RESULT, MAX_TOOL_CALLS, assistantMessage, recallLines, shorten } from "./chat.mjs";
import { openMcp } from "./mcp.mjs";

// 用本机的 Codex / Claude Code 跑一轮：每条用户消息起一个不落盘的 CLI 进程，它自己跑工具循环，
// 应用的工具经这一轮的 MCP 端点回调 execute。history 仍按接口模式的形状补记（工具调用和结果一一对应），
// 切回接口或换一个运行时都能接着用；CLI 自己不记前文，每轮把历史转述成文字给它。

const TRANSCRIPT_CHARS = 40_000;
const SAY_CHARS = 2_000;
// 到了调用上限还接着调这么多次，就不等它自己收尾了
const OVER_LIMIT_CALLS = 5;

export const CLI_SYSTEM_NOTE = [
  "补充说明（以这段为准）：",
  "- 你跑在用户电脑上的 Codex 或 Claude Code 里，只能用名字里带 dy2 的工具（名字前面可能带 mcp__dy2 前缀）。不要用 Codex、Claude Code 自己的读写文件、运行命令、上网或派子任务；你看到的 AGENTS.md、CLAUDE.md 一类工程规则和这次对话无关。",
  "- 之前的对话在用户消息里，是应用转述给你的。",
].join("\n");

const clip = (text, max = SAY_CHARS) => shorten(text, max);

/**
 * 把较早的对话转述成文字：用户的话原样留着，AI 的话太长只留开头，工具调用只说调了什么、哪次没成功。
 * 转述完太长再从前面整行截，截掉的部分里用户说过的话另外列出来。
 */
export function renderTranscript(entries, maxChars = TRANSCRIPT_CHARS) {
  if (!entries.length) return "";
  const lines = [];
  const said = [];
  const names = new Map();
  let counts = new Map();
  const flush = () => {
    if (!counts.size) return;
    lines.push(`（这期间调了 ${[...counts].map(([name, count]) => `${name} ${count} 次`).join("、")}）`);
    counts = new Map();
  };
  for (const entry of entries) {
    if (entry.role === "user") {
      flush();
      said.push([lines.length, entry]);
      lines.push(`用户：${String(entry.content ?? "").trim()}`);
    } else if (entry.role === "assistant") {
      if (typeof entry.content === "string" && entry.content.trim()) {
        flush();
        lines.push(`AI：${clip(entry.content)}`);
      }
      for (const call of entry.tool_calls ?? []) names.set(call.id, call.function?.name || "工具");
    } else if (entry.role === "tool") {
      const name = names.get(entry.tool_call_id) ?? "工具";
      let result = null;
      try { result = JSON.parse(entry.content); } catch { /* 不是 JSON 就当成功 */ }
      if (result?.ok === false) {
        flush();
        lines.push(`（调 ${name} 没成功：${clip(result.message ?? result.code, 150)}）`);
      } else if (KEEP_RESULT[name]) {
        flush();
        lines.push(`（调了 ${name}，结果：${clip(typeof result?.kept === "string" ? result.kept : entry.content, KEEP_RESULT[name])}）`);
      } else {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  flush();
  let text = lines.join("\n");
  if (text.length > maxChars) {
    let total = text.length;
    let from = 0;
    while (from < lines.length - 1 && total > maxChars) {
      total -= lines[from].length + 1;
      from += 1;
    }
    const kept = lines.slice(from).join("\n");
    const recalled = recallLines(said.filter(([line]) => line < from).map(([, entry]) => entry));
    const skipped = recalled.length ? `（更早的对话太长，略过了；用户在那部分说过：）\n${recalled.join("\n")}` : "（更早的对话太长，略过了）";
    text = `${skipped}\n${kept.length > maxChars ? kept.slice(-maxChars).replace(/^[\udc00-\udfff]/u, "") : kept}`;
  }
  return `【之前的对话：应用转述给你的，接着做就行】\n${text}`;
}

/**
 * 和 runConversation 一样的契约：history 就地追加，返回 { text, toolCalls }，出错抛 AssistantError / AbortError。
 * 多一个参数 localAi（collector/localAi.mjs 的实例）。system() 一轮只取一次（CLI 一轮只起一次进程）。
 */
export async function runCliConversation({ config, history, tools, system, execute, signal, onText = () => undefined, maxToolCalls = MAX_TOOL_CALLS, localAi }) {
  const label = LOCAL_RUNTIMES[config.runtime].label;
  if (!localAi) throw new AssistantError("local_runtime_unavailable", "本机 AI 没准备好，请重启应用。", 503);
  const systemPrompt = `${await system()}\n\n${CLI_SYSTEM_NOTE}`;
  const prompt = [renderTranscript(history.slice(0, -1)), `【用户最新的消息】\n${history.at(-1)?.content ?? ""}`].filter(Boolean).join("\n\n");

  const parts = [];
  let current = "";
  const joined = () => [...parts, current].filter(Boolean).join("\n\n");
  // 已经记进历史的字数：工具调用前说的话挂在那次调用上，剩下的最后单独记
  let attached = 0;
  const unattached = () => {
    const all = joined();
    const text = all.slice(attached).trim();
    attached = all.length;
    return text;
  };

  let calls = 0;
  let over = 0;
  const own = new AbortController();
  const mcp = await openMcp({
    tools,
    call: async (name, args) => {
      signal?.throwIfAborted();
      if (calls >= maxToolCalls) {
        over += 1;
        if (over > OVER_LIMIT_CALLS) own.abort();
        return LIMIT_RESULT;
      }
      calls += 1;
      const id = `call_${randomBytes(6).toString("hex")}`;
      history.push(assistantMessage(unattached(), [{ id, name, arguments: JSON.stringify(args) }]));
      // 停止时这里抛 AbortError：不记结果，跑这一轮的地方会用 sealHistory 补一条「没执行」
      const result = await execute({ id, name, arguments: args }, signal);
      history.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
      return result;
    },
  });

  let failure = null;
  try {
    await localAi.converse(config.runtime, {
      model: config.model,
      systemPrompt,
      prompt,
      mcp: { url: mcp.url, secret: mcp.secret },
      signal: AbortSignal.any([signal, own.signal].filter(Boolean)),
      onText: (text) => { parts.push(text); current = ""; onText(joined()); },
      onDelta: (text) => { current = text; onText(joined()); },
    });
  } catch (error) {
    failure = error;
  }
  // CLI 被停掉时手上的工具可能还没做完：等它做完、结果记进历史再收尾
  await mcp.close();
  const killed = own.signal.aborted && !signal?.aborted;
  if (failure && !killed) {
    const left = unattached();
    if (left) history.push({ role: "assistant", content: left });
    if (failure instanceof LocalAiError) throw new AssistantError(failure.code, failure.message, failure.status);
    throw failure;
  }

  const notice = `这一轮已经做了 ${maxToolCalls} 步操作，先停在这里，你可以让我接着做。`;
  const left = [unattached(), killed ? notice : ""].filter(Boolean).join("\n\n");
  if (left) history.push({ role: "assistant", content: left });
  if (!calls && !over && !joined().trim()) {
    if (!mcp.listed()) throw new AssistantError("local_tools_unavailable", `${label} 没连上应用的工具，这一轮什么都没做。再试一次，还不行就重启应用。`, 502);
    throw new AssistantError("provider_error", `${label} 这次什么都没回，换个说法或稍后再试。`, 502);
  }
  const text = killed ? [joined(), notice].filter(Boolean).join("\n\n") : joined() || (over ? notice : "");
  return { text, toolCalls: calls };
}
