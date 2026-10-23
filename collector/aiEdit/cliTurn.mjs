import { randomBytes } from "node:crypto";

import { LOCAL_RUNTIMES, LocalAiError } from "../localAi.mjs";
import { KEEP_RESULT, LIMIT_RESULT, MAX_TOOL_CALLS, SEE_IMAGES_ACTION, assistantMessage, recallLines, shorten } from "./chat.mjs";
import { AiEditError } from "./library.mjs";
import { openMcp } from "./mcp.mjs";

// 用本机的 Codex / Claude Code 跑一轮剪辑：每条用户消息起一个不落盘的 CLI 进程，它自己跑工具循环，
// 剪辑工具经这一轮的 MCP 端点回调 execute。history 仍按接口模式的形状补记（工具调用和结果一一对应），
// 切回接口或换一个运行时都能接着用；CLI 自己不记前文，每轮把历史转述成文字给它。

const TRANSCRIPT_CHARS = 40_000;
const SAY_CHARS = 2_000;
// 到了调用上限还接着调这么多次，就不等它自己收尾了
const OVER_LIMIT_CALLS = 5;

export const CLI_SYSTEM_NOTE = [
  "补充说明（以这段为准）：",
  "- 你跑在用户电脑上的 Codex 或 Claude Code 里，只能用名字里带 dy2 的剪辑工具：上面说的 get_timeline、add_media_clip 这些就是它们（名字前面可能带 mcp__dy2 前缀）。不要读写文件、运行命令、上网或派子任务；你看到的 AGENTS.md、CLAUDE.md 一类工程规则和这次剪辑无关。",
  "- 上面「每次请求的最后一条消息是工程现状」那句在这里不适用：之前的对话和开工时的工程现状都在用户消息里，是应用转述给你的。时间线改过以后想看最新的就调 get_timeline。",
  "- 工具结果里带着 latest_goal 时，说明用户刚改了目标，从下一步起照新目标做。",
  "- 用户在对话里贴的图传不到这里，你只知道它的素材名和 media_id：图里是什么只能按名字和用户的话推断，没把握就在回复里说一声，别装作看过。",
].join("\n");

const clip = (text, max = SAY_CHARS) => shorten(text, max);

/**
 * 把较早的对话转述成文字：用户的话原样留着，AI 的话太长只留开头，工具调用只说调了什么、哪次没成功。
 * 不按原始字数先裁（工具结果的 JSON 很占字数，转述后只剩一行），转述完太长再从前面截，
 * 截掉的部分里用户说过的话另外列出来（和接口方式的 requestHistory 同一套规矩），并调 onTrimmed()。
 */
export function renderTranscript(entries, maxChars = TRANSCRIPT_CHARS, onTrimmed = () => undefined) {
  if (!entries.length) return "";
  const lines = [];
  // 用户的话在第几行，截掉开头时找得到哪些被截了
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
        // 接口方式压缩过的只剩开头（kept），转述那段就行
        lines.push(`（调了 ${name}，结果：${clip(typeof result?.kept === "string" ? result.kept : entry.content, KEEP_RESULT[name])}）`);
      } else {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  flush();
  let text = lines.join("\n");
  if (text.length > maxChars) {
    // 从前面整行丢，不从半句话、半个链接中间切
    let size = text.length;
    let from = 0;
    while (from < lines.length - 1 && size > maxChars) {
      size -= lines[from].length + 1;
      from += 1;
    }
    const kept = lines.slice(from).join("\n");
    const recalled = recallLines(said.filter(([line]) => line < from).map(([, entry]) => entry));
    const skipped = recalled.length ? `（更早的对话太长，略过了；用户在那部分说过：）\n${recalled.join("\n")}` : "（更早的对话太长，略过了）";
    text = `${skipped}\n${kept.length > maxChars ? kept.slice(-maxChars).replace(/^[\udc00-\udfff]/u, "") : kept}`;
    onTrimmed();
  }
  return `【之前的对话：应用转述给你的，接着做就行】\n${text}`;
}

/**
 * 和 runConversation 一样的契约：history 就地追加，返回 { text, toolCalls }，出错抛 AiEditError / AbortError。
 * 多两个参数：localAi（collector/localAi.mjs 的实例）、goal()（读最新的目标，一轮中途改了就捎带进下一个工具结果）。
 * system() 和 context() 一轮只取一次（CLI 一轮只起一次进程）。用户贴的图不传给 CLI，只在文字里写素材名和 media_id
 * （应用写进用户消息里了），onAction 记一条「看不了图」；onTrimmed 同 runConversation。
 */
export async function runCliConversation({
  config, history, tools, system, context, execute, signal, onText = () => undefined, maxToolCalls = MAX_TOOL_CALLS, localAi, goal = () => "",
  onAction = () => undefined, onTrimmed = () => undefined,
}) {
  const label = LOCAL_RUNTIMES[config.runtime].label;
  if (!localAi) throw new AiEditError("local_runtime_unavailable", "本机 AI 没准备好，请重启应用。", 503);
  const systemPrompt = `${await system()}\n\n${CLI_SYSTEM_NOTE}`;
  const extra = context ? await context() : "";
  const prompt = [renderTranscript(history.slice(0, -1), TRANSCRIPT_CHARS, onTrimmed), extra, `【用户最新的消息】\n${history.at(-1)?.content ?? ""}`].filter(Boolean).join("\n\n");
  if (history.at(-1)?.attachments?.length) onAction({ ...SEE_IMAGES_ACTION, summary: `${label} 这里看不了图片，只告诉了它图片的名字` });

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
  // 告诉过模型的目标：一轮中途改了就捎带进下一个工具结果（改回原样也要说）
  let told = goal();
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
      // 停止时这里抛 AbortError：不记结果，runTurn 里的 sealHistory 会补一条「没执行」
      const result = await execute({ id, name, arguments: args }, signal);
      history.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
      const now = goal();
      if (now === told) return result;
      told = now;
      return { ...result, latest_goal: now || "（用户把目标清空了）" };
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
  // CLI 被停掉时手上的工具可能还没做完：等它做完、结果记进历史再收尾（不然它做完以后才往历史里补，顺序就乱了）
  await mcp.close();
  // 到了上限是我们自己叫停的，照常收尾；其余的把已经说出来的半句留在历史里
  const killed = own.signal.aborted && !signal?.aborted;
  if (failure && !killed) {
    const left = unattached();
    if (left) history.push({ role: "assistant", content: left });
    if (failure instanceof LocalAiError) throw new AiEditError(failure.code, failure.message, failure.status);
    throw failure;
  }

  const notice = `这一轮已经做了 ${maxToolCalls} 步操作，先停在这里，你可以让我接着做。`;
  // 被我们叫停的，就算前面说过话也要告诉用户是到了上限
  const left = [unattached(), killed ? notice : ""].filter(Boolean).join("\n\n");
  if (left) history.push({ role: "assistant", content: left });
  if (!calls && !over && !joined().trim()) {
    if (!mcp.listed()) throw new AiEditError("local_tools_unavailable", `${label} 没连上应用的剪辑工具，这一轮没改时间线。再试一次，还不行就重启应用。`, 502);
    throw new AiEditError("provider_error", `${label} 这次什么都没回，换个说法或稍后再试。`, 502);
  }
  const text = killed ? [joined(), notice].filter(Boolean).join("\n\n") : joined() || (over ? notice : "");
  return { text, toolCalls: calls };
}
