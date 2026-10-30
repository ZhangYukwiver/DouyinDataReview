import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLocalAi, isLocalRuntime, LOCAL_RUNTIMES } from "../localAi.mjs";
import { AssistantError, parseAssistantConfig, runConversation, sealHistory, trimHistory } from "./chat.mjs";
import { runCliConversation } from "./cliTurn.mjs";
import { createConfirmDesk } from "./confirm.mjs";
import { bearerMatches, mcpHandler } from "./mcp.mjs";
import { toolDefinitions, toolNamed } from "./tools.mjs";

// AI 助手：一条对话线程（存在数据目录根上的 assistant.json，「新对话」清空）、跑一轮、长轮询给页面看、
// 对外动作的确认卡片、让应用切页面的事件，以及给用户自己的 AI 客户端用的 /mcp（界面上不露，README 里写怎么接；
// 令牌第一次启动时生成在数据目录的 mcp-token 里，只有本机用户读得到）。
// ponytail: 只有一条线程，要多条对话再加列表

const STORED_HISTORY_CHARS = 600_000;
// 一轮里最多做几次别人看得到的操作（每次都还要用户点允许）；同续火花一次 10 位
const MAX_EXTERNAL_PER_TURN = 10;
const WAIT_MS = 8_000;
const SHOWN_MESSAGES = 200;

const SYSTEM_PROMPT = `你是「内容数据工作台」里的 AI 助手。这个桌面应用把用户自己的抖音观看历史、喜欢、收藏、私信读到这台电脑上，还能搜抖音、看直播、看创作者中心、下载作品。你可以用工具查询和统计这些数据，也可以替用户使用应用的功能。

规矩：
- 先用工具查再回答，数字以工具结果为准，不要编。对话里第一次用工具前先调 app_overview，知道现在几点、是哪个账号、有多少数据。
- 统计类问题（最常看谁、什么时候刷得多、喜欢什么话题）用 record_stats；找具体作品用 search_records。
- 发私信、点赞、收藏、关注、评论、分享会被别人看到：每一次工具都会先弹卡片让用户确认，你不用再问一遍。用户点名或说清楚范围的几个人（比如「这两天聊过的好友」），就先查出是谁、逐个去做；不要自己扩大范围，一轮最多 10 次。用户拒绝了某一个就跳过它，不要换个办法再试。
- 用简体中文，口语、简洁。回答里不要出现 videoId、conversationId、occurredAt 这种字段名或接口名，用普通说法；提到作品可以附上链接。可以用 Markdown 列表和表格。
- 工具报错时用一句话说清原因；能自己补救的（比如先开始接收聊天）就先补救。`;

// 动作列表里给用户看的说法（前面的勾、叉、转圈说明做没做成）
const LABELS = {
  app_overview: "看应用现状", search_records: "查记录", record_stats: "统计记录", list_folders: "看文件夹", organize_folders: "整理文件夹",
  list_conversations: "看私信会话", read_chat: "读私信", read_live_chat: "从抖音现读私信", chat_streaks: "看火花", transcribe_voice: "转写语音",
  creator_read: "读创作者中心", live_following: "看谁在直播", live_room: "进直播间听几秒", feed_filter_read: "看推荐流控制",
  feed_filter_set: "改推荐流控制", start_reading: "开始读取", stop_reading: "停止读取", download_video: "下载作品", switch_account: "切换账号",
  open_view: "切换页面", send_chat_message: "发私信", douyin_interact: "在抖音上操作",
};
const READ_KINDS = { users: "搜抖音用户", videos: "搜抖音作品", profile: "看抖音主页", detail: "看作品详情", comments: "看评论", replies: "看回复", feed: "刷推荐" };
// 这几种没做成的原因是写给模型看的（「别再试了」），给用户换一句
const NOTES = { confirm_denied: "你没同意，没有做", confirm_timeout: "15 分钟没人点，没有做", stopped: "停下了，没有做" };

function actionView(name, args, result) {
  const base = name === "douyin_read" ? READ_KINDS[args?.kind] ?? "读抖音" : LABELS[name] ?? name;
  const count = Number.isInteger(result?.total) ? ` · ${result.total} 条` : "";
  const failed = result?.ok === false;
  return {
    label: `${base}${count}`,
    ok: !failed,
    ...(failed ? { note: NOTES[result.code] ?? result.message ?? "没成功" } : {}),
    ...(result?.downloadId ? { download: { id: result.downloadId, fileName: result.fileName } } : {}),
  };
}

/** 工具出错时给模型的结果：认得的错误带原话，其余只说没成功。 */
function toolError(error) {
  if (error?.name === "AbortError") throw error;
  if (typeof error?.code === "string" && typeof error?.message === "string") return { ok: false, code: error.code, message: error.message };
  console.error("AI 助手工具出错:", error);
  return { ok: false, code: "tool_failed", message: "这个工具没执行成功。" };
}

/**
 * dataDirectory：数据目录根；baseUrl()：采集器自己的地址（工具调接口用）；pairing：采集器的配对管理（拿一个内部令牌）；
 * collector()、accounts()、writesEnabled()：当前的采集器、账号表、互动开关（换号会换采集器，所以都是取值函数）。
 */
export function createAssistant({ dataDirectory, baseUrl, pairing, collector, accounts, writesEnabled, localAi = createLocalAi({ dataDirectory }), fetchImpl }) {
  const historyFile = path.join(dataDirectory, "assistant.json");
  const mcpTokenFile = path.join(dataDirectory, "mcp-token");
  let history = [];
  let mcpToken = "";
  let revision = 0;
  let turn = null;
  let error = null;
  let ui = null;
  const waiters = new Set();
  let token = null;
  // douyin_read 翻页时记着每个会话已经给过模型几条
  const seen = new Map();

  const touch = () => {
    revision += 1;
    for (const wake of [...waiters]) wake();
  };
  const confirms = createConfirmDesk({ onChange: touch });

  const saveJson = async (file, value) => {
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  };
  // 存盘排成一队，关掉时等它写完
  let saving = Promise.resolve();
  const saveHistory = () => (saving = saving.then(() => saveJson(historyFile, { history: trimHistory(history, STORED_HISTORY_CHARS) }))
    .catch((problem) => console.error("AI 助手对话没存上:", problem)));

  /** 调采集器自己的接口：现有关卡全部照常生效。令牌闲置 12 小时会过期，401 时重拿一次。 */
  const api = async (method, pathname, body, signal) => {
    for (let attempt = 0; ; attempt += 1) {
      token ??= pairing.issue();
      const response = await (fetchImpl ?? fetch)(`${baseUrl()}${pathname}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = await response.json().catch(() => null);
      if (response.status === 401 && attempt === 0) { token = null; continue; }
      return { ok: response.ok, status: response.status, body: parsed };
    }
  };

  /** 执行一个工具。source：app 应用内对话、mcp 外部 AI 客户端（确认卡片上写清是谁要做）。 */
  const runTool = async (name, args, { signal, source }) => {
    const tool = toolNamed(name);
    if (!tool) return { ok: false, code: "unknown_tool", message: `没有 ${name} 这个工具。` };
    const ctx = {
      api: (method, pathname, body) => api(method, pathname, body, signal),
      collector, accounts, writesEnabled, seen,
      confirm: (spec) => confirms.ask({ ...spec, source }, { signal }),
      ui: (event) => { ui = { ...event, seq: (ui?.seq ?? 0) + 1 }; touch(); },
    };
    try {
      return (await tool.run(ctx, args && typeof args === "object" ? args : {}, signal)) ?? { ok: true };
    } catch (problem) {
      return toolError(problem);
    }
  };

  const view = () => {
    const messages = [];
    // 这一轮还在跑：它的话和动作由 streaming 给，历史里只取到用户刚说的那句，免得同一个动作出现两次
    const shown = turn ? history.slice(0, history.findLastIndex((entry) => entry.role === "user") + 1) : history;
    const results = new Map(shown.filter((entry) => entry.role === "tool").map((entry) => [entry.tool_call_id, entry.content]));
    for (const entry of shown) {
      if (entry.role === "user") messages.push({ role: "user", text: entry.content });
      else if (entry.role === "assistant") {
        const actions = (entry.tool_calls ?? []).map((call) => {
          let args = {};
          let result = null;
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* 参数坏了就不细说 */ }
          try { result = JSON.parse(results.get(call.id) ?? "null"); } catch { /* 同上 */ }
          return actionView(call.function.name, args, result);
        });
        const last = messages.at(-1);
        // 同一轮里连着的工具调用并成一组动作，说的话各自一段
        if (entry.content?.trim()) messages.push({ role: "assistant", text: entry.content.trim(), actions });
        else if (last?.role === "assistant" && !last.text) last.actions.push(...actions);
        else messages.push({ role: "assistant", text: "", actions });
      }
    }
    return {
      revision,
      busy: Boolean(turn),
      messages: messages.slice(-SHOWN_MESSAGES),
      streaming: turn ? { text: turn.text, actions: turn.actions } : null,
      error,
      confirms: confirms.pending(),
      ui,
    };
  };

  const ready = (async () => {
    try { history = JSON.parse(await readFile(historyFile, "utf8")).history ?? []; } catch { history = []; }
    mcpToken = (await readFile(mcpTokenFile, "utf8").catch(() => "")).trim();
    if (mcpToken.length < 32) {
      mcpToken = randomBytes(32).toString("base64url");
      await writeFile(mcpTokenFile, `${mcpToken}\n`, { mode: 0o600 }).catch((problem) => console.error("MCP 令牌没写上:", problem));
    }
  })();

  const send = async (text, rawConfig) => {
    await ready;
    const message = typeof text === "string" ? text.trim() : "";
    if (!message || message.length > 8_000) throw new AssistantError("invalid_message", "消息不能为空，最多 8000 字。");
    const config = parseAssistantConfig(rawConfig);
    if (turn) throw new AssistantError("assistant_busy", "上一句还在处理，等它说完或先停下。", 409);
    history.push({ role: "user", content: message });
    const controller = new AbortController();
    turn = { controller, text: "", actions: [], done: null, external: 0 };
    error = null;
    touch();
    void saveHistory();
    const execute = async (call, signal) => {
      let args = call.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args || "{}"); } catch { return { ok: false, code: "invalid_arguments", message: "参数不是合法 JSON。" }; }
      }
      if (toolNamed(call.name)?.kind === "external" && ++turn.external > MAX_EXTERNAL_PER_TURN) {
        return { ok: false, code: "external_limit", message: `这一轮已经做了 ${MAX_EXTERNAL_PER_TURN} 次别人看得到的操作，到上限了。停下来告诉用户做到了哪个，剩下的让用户再说一次。` };
      }
      const index = turn.actions.push({ ...actionView(call.name, args, null), running: true }) - 1;
      touch();
      const result = await runTool(call.name, args, { signal, source: "app" });
      turn.actions[index] = actionView(call.name, args, result);
      touch();
      return result;
    };
    const options = {
      config, history, tools: toolDefinitions(), system: async () => SYSTEM_PROMPT, execute, signal: controller.signal,
      onText: (value) => { turn.text = value; touch(); },
      ...(fetchImpl ? { fetchImpl } : {}),
    };
    turn.done = (isLocalRuntime(config.runtime) ? runCliConversation({ ...options, localAi }) : runConversation(options))
      .catch((problem) => {
        if (problem?.name !== "AbortError" && !controller.signal.aborted) {
          if (!problem?.code) console.error("AI 助手这一轮出错:", problem);
          error = problem?.code ? problem.message : "这一轮出错了，再试一次。";
        }
      })
      .finally(() => {
        sealHistory(history, controller.signal.aborted ? "用户停止了这一轮，这个工具没有执行。" : "这一轮出错了，这个工具没有执行。");
        turn = null;
        touch();
        void saveHistory();
      });
    return view();
  };

  const mcpHandle = mcpHandler({
    tools: toolDefinitions,
    call: (name, args) => runTool(name, args, { source: "mcp" }),
    authorized: (header) => mcpToken.length >= 32 && bearerMatches(header, mcpToken),
  });

  return {
    ready,
    send,
    stop() {
      turn?.controller.abort();
      return view();
    },
    async reset() {
      await ready;
      if (turn) throw new AssistantError("assistant_busy", "先停下这一轮再开新对话。", 409);
      history = [];
      error = null;
      seen.clear();
      touch();
      await saveHistory();
      return view();
    },
    answer(id, allow) {
      confirms.answer(id, allow);
      return view();
    },
    /** 长轮询：版本号变了就马上回，否则最多等 8 秒。 */
    async wait(after) {
      await ready;
      if (after !== null && after === revision) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, WAIT_MS);
          function done() { clearTimeout(timer); waiters.delete(done); resolve(); }
          waiters.add(done);
        });
      }
      return view();
    },
    runtimes: async (fresh) => ({ runtimes: await Promise.all(Object.keys(LOCAL_RUNTIMES).map((id) => localAi.status(id, { fresh }))) }),
    /** 用户自己的 AI 客户端发来的 /mcp 请求。 */
    async handleMcp(request, response) {
      await ready;
      mcpHandle(request, response);
    },
    async close() {
      const running = turn?.done;
      turn?.controller.abort();
      confirms.close();
      await running;
      await saving;
      for (const wake of [...waiters]) wake();
      await localAi.close();
    },
  };
}
