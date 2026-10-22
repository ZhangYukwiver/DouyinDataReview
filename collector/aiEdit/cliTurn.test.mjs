import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalAi } from "../localAi.mjs";
import { parseEditConfig, runConversation, sealHistory } from "./chat.mjs";
import { CLI_SYSTEM_NOTE, renderTranscript, runCliConversation } from "./cliTurn.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/local-ai/fake-cli.mjs");
const tool = (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const TOOLS = ["add_text_clip", "get_timeline", "analyze_reference"].map(tool);

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeAi(plan) {
  const directory = await mkdtemp(path.join(tmpdir(), "cli-turn-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const planFile = path.join(directory, "plan.json");
  const recordFile = path.join(directory, "record.jsonl");
  await writeFile(planFile, JSON.stringify(plan));
  const ai = createLocalAi({
    dataDirectory: directory,
    resolve: async (id) => ({ command: process.execPath, prefix: [FAKE, id], env: {}, path: FAKE }),
    shellEnv: async () => ({ ...process.env, FAKE_PLAN: planFile, FAKE_RECORD: recordFile }),
    proxy: async () => null,
  });
  cleanups.push(() => ai.close());
  const records = async () => (await readFile(recordFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ai, records, setPlan: (next) => writeFile(planFile, JSON.stringify(next)) };
}

const turn = (overrides) => ({
  config: { runtime: "codex", model: "", videoInput: false },
  tools: TOOLS,
  system: async () => "系统提示",
  context: async () => "【工程现状：应用自动附上，不是用户说的话】\n当前总时长 0 秒。",
  execute: async (call) => ({ ok: true, done: call.name }),
  ...overrides,
});

describe("talking a local CLI through a turn", () => {
  it("parses a local runtime config without a key", () => {
    expect(parseEditConfig({ runtime: "claude", model: "sonnet", apiKey: "old-key", baseUrl: "https://x" })).toEqual({ runtime: "claude", model: "sonnet", videoInput: false });
    expect(() => parseEditConfig({ runtime: "nope", baseUrl: "https://x" })).toThrow(/Key/u);
  });

  for (const runtime of ["codex", "claude"]) {
    it(`${runtime}: records each tool call and its result like the API does, with what was said before it`, async () => {
      const { ai, records } = await fakeAi({ steps: [{ say: "先加一行字" }, { call: "add_text_clip", arguments: { text: "测试" } }, { call: "get_timeline" }, { say: "加好了，总共 2 秒。" }] });
      const history = [
        { role: "user", content: "先剪一版" },
        { role: "assistant", content: "", tool_calls: [{ id: "old", type: "function", function: { name: "analyze_reference", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "old", content: JSON.stringify({ ok: true, analysis: "开头三秒抛悬念" }) },
        { role: "assistant", content: "剪好了" },
        { role: "user", content: "在开头加一行字" },
      ];
      const executed = [];
      const shown = [];
      const result = await runCliConversation(turn({
        config: { runtime, model: "", videoInput: false }, history, localAi: ai,
        execute: async (call) => { executed.push(call); return { ok: true, done: call.name }; },
        onText: (text) => shown.push(text),
      }));
      expect(result).toEqual({ text: "先加一行字\n\n加好了，总共 2 秒。", toolCalls: 2 });
      expect(executed.map((call) => [call.name, call.arguments])).toEqual([["add_text_clip", { text: "测试" }], ["get_timeline", {}]]);
      expect(shown.at(-1)).toBe("先加一行字\n\n加好了，总共 2 秒。");
      const added = history.slice(5);
      expect(added.map((entry) => entry.role)).toEqual(["assistant", "tool", "assistant", "tool", "assistant"]);
      expect(added[0]).toMatchObject({ content: "先加一行字", tool_calls: [{ type: "function", function: { name: "add_text_clip", arguments: JSON.stringify({ text: "测试" }) } }] });
      expect(added[1].tool_call_id).toBe(added[0].tool_calls[0].id);
      expect(added[2].content).toBe("");
      expect(added[3].tool_call_id).toBe(added[2].tool_calls[0].id);
      expect(added[4]).toEqual({ role: "assistant", content: "加好了，总共 2 秒。" });
      const [record] = await records();
      expect(record.system).toBe(`系统提示\n\n${CLI_SYSTEM_NOTE}`);
      const prompt = runtime === "claude" ? JSON.parse(record.stdin).message.content[0].text : record.stdin;
      expect(prompt).toContain("用户：先剪一版");
      expect(prompt).toContain("开头三秒抛悬念");
      expect(prompt).toContain("AI：剪好了");
      expect(prompt).toContain("当前总时长 0 秒");
      expect(prompt.endsWith("【用户最新的消息】\n在开头加一行字")).toBe(true);
    });
  }

  it("leaves a history the API can carry on from", async () => {
    const { ai } = await fakeAi({ steps: [{ call: "add_text_clip" }, { say: "好了" }] });
    const history = [{ role: "user", content: "加字" }];
    await runCliConversation(turn({ history, localAi: ai }));
    history.push({ role: "user", content: "再快一点" });
    const bodies = [];
    const fetchImpl = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    await runConversation({ config: { baseUrl: "https://api.example/v1", apiKey: "k", model: "m" }, history, tools: TOOLS, fetchImpl, system: async () => "s", execute: async () => ({ ok: true }) });
    const sent = bodies[0].messages;
    const call = sent.find((message) => message.tool_calls)?.tool_calls[0];
    expect(sent.find((message) => message.role === "tool").tool_call_id).toBe(call.id);
  });

  it("stops at the tool limit and ends in words", async () => {
    const { ai, records } = await fakeAi({ steps: Array.from({ length: 9 }, () => ({ call: "get_timeline" })) });
    const history = [{ role: "user", content: "每段都加转场" }];
    const result = await runCliConversation(turn({ history, localAi: ai, maxToolCalls: 2 }));
    expect(result).toEqual({ text: "这一轮已经做了 2 步操作，先停在这里，你可以让我接着做。", toolCalls: 2 });
    expect(history.filter((entry) => entry.role === "tool")).toHaveLength(2);
    // 第 3 次起回「到上限」，再接着调就被叫停，9 次没跑完
    const { results } = (await records())[0];
    expect(JSON.parse(results[2].content[0].text)).toMatchObject({ code: "tool_limit" });
    expect(results.length).toBeLessThan(9);
  });

  it("on stop leaves the unanswered call for sealHistory and refuses what comes after", async () => {
    const { ai } = await fakeAi({ steps: [{ say: "我来测节拍" }, { call: "get_timeline" }, { say: "不该出现" }] });
    const controller = new AbortController();
    const history = [{ role: "user", content: "卡点" }];
    const running = runCliConversation(turn({
      history, localAi: ai, signal: controller.signal,
      // 看停止信号的工具（比如等页面测节拍）：一停就抛
      execute: async (_call, signal) => {
        controller.abort();
        signal.throwIfAborted();
      },
    }));
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(history.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(history[1].content).toBe("我来测节拍");
    sealHistory(history);
    expect(JSON.parse(history[2].content)).toMatchObject({ code: "stopped" });
  });

  it("passes a goal changed mid-turn to the model but not into the history", async () => {
    const { ai, records } = await fakeAi({ steps: [{ call: "get_timeline" }, { call: "get_timeline" }] });
    let goal = "30 秒以内";
    const history = [{ role: "user", content: "剪" }];
    await runCliConversation(turn({ history, localAi: ai, goal: () => goal, execute: async () => { goal = "15 秒以内"; return { ok: true }; } }));
    const [record] = await records();
    expect(JSON.parse(record.results[0].content[0].text)).toEqual({ ok: true, latest_goal: "15 秒以内" });
    expect(history.filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content))).toEqual([{ ok: true }, { ok: true }]);
  });

  it("says so when the CLI never reached the tools, and turns CLI failures into AI edit errors", async () => {
    let { ai } = await fakeAi({ skipTools: true });
    await expect(runCliConversation(turn({ history: [{ role: "user", content: "剪" }], localAi: ai }))).rejects.toMatchObject({ name: "AiEditError", code: "local_tools_unavailable" });
    ({ ai } = await fakeAi({ loggedIn: false }));
    await expect(runCliConversation(turn({ history: [{ role: "user", content: "剪" }], localAi: ai }))).rejects.toMatchObject({ name: "AiEditError", code: "local_logged_out", message: expect.stringContaining("codex login") });
    ({ ai } = await fakeAi({ steps: [{ say: "说了一半" }, { fail: { text: "You've hit your usage limit." } }] }));
    const history = [{ role: "user", content: "剪" }];
    await expect(runCliConversation(turn({ history, localAi: ai }))).rejects.toMatchObject({ code: "local_rate_limit" });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "说了一半" });
  });
});

describe("review fixes", () => {
  it("says it hit the limit even when it talked first", async () => {
    const { ai } = await fakeAi({ steps: [{ say: "我先看看时间线" }, ...Array.from({ length: 12 }, () => ({ call: "get_timeline" }))] });
    const history = [{ role: "user", content: "每段都加转场" }];
    const result = await runCliConversation(turn({ history, localAi: ai, maxToolCalls: 2 }));
    expect(result.text).toBe("我先看看时间线\n\n这一轮已经做了 2 步操作，先停在这里，你可以让我接着做。");
    expect(history.at(-1)).toEqual({ role: "assistant", content: "这一轮已经做了 2 步操作，先停在这里，你可以让我接着做。" });
  });

  it("tells the model when the goal goes back to what it was", async () => {
    const { ai, records } = await fakeAi({ steps: [{ call: "get_timeline" }, { call: "get_timeline" }, { call: "get_timeline" }] });
    const goals = ["15 秒以内", "30 秒以内", "30 秒以内"];
    let goal = "30 秒以内";
    await runCliConversation(turn({ history: [{ role: "user", content: "剪" }], localAi: ai, goal: () => goal, execute: async () => { goal = goals.shift(); return { ok: true }; } }));
    const [record] = await records();
    expect(record.results.map((result) => JSON.parse(result.content[0].text).latest_goal)).toEqual(["15 秒以内", "30 秒以内", undefined]);
  });

  it("keeps earlier turns and long user messages when retelling, however big the tool results were", () => {
    const call = (id) => ({ id, type: "function", function: { name: "get_timeline", arguments: "{}" } });
    const subtitles = Array.from({ length: 120 }, (_, index) => `${index + 1} 第 ${index + 1} 句字幕`).join("\n");
    const text = renderTranscript([
      { role: "user", content: `全程黑白，字幕如下：\n${subtitles}` },
      { role: "assistant", content: "好" },
      { role: "user", content: "再快一点" },
      ...Array.from({ length: 6 }, (_, index) => [
        { role: "assistant", content: "", tool_calls: [call(`t${index}`)] },
        { role: "tool", tool_call_id: `t${index}`, content: JSON.stringify({ ok: true, timeline: "x".repeat(10_000) }) },
      ]).flat(),
    ]);
    expect(text).toContain("全程黑白");
    expect(text).toContain("120 第 120 句字幕");
    expect(text).toContain("（这期间调了 get_timeline 6 次）");
  });

  it("on stop waits for the tool in hand and records its result before finishing", async () => {
    const { ai } = await fakeAi({ steps: [{ call: "add_text_clip" }, { say: "不该出现" }] });
    const controller = new AbortController();
    const history = [{ role: "user", content: "加字幕" }];
    // 不看停止信号、要做一会儿的工具（比如一次加上百条字幕）
    const running = runCliConversation(turn({
      history, localAi: ai, signal: controller.signal,
      execute: async () => { controller.abort(); await new Promise((resolve) => setTimeout(resolve, 300)); return { ok: true, added: 120 }; },
    }));
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(history.map((entry) => entry.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.parse(history[2].content)).toEqual({ ok: true, added: 120 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(history).toHaveLength(3);
  });
});

describe("retelling earlier turns", () => {
  it("keeps the words, counts plain tool calls, spells out failures and keeps reference results", () => {
    const call = (id, name) => ({ id, type: "function", function: { name, arguments: "{}" } });
    const text = renderTranscript([
      { role: "user", content: "做一条卡点" },
      { role: "assistant", content: "", tool_calls: [call("a", "add_text_clip")] },
      { role: "tool", tool_call_id: "a", content: JSON.stringify({ ok: true }) },
      { role: "assistant", content: "", tool_calls: [call("b", "add_text_clip"), call("c", "get_timeline")] },
      { role: "tool", tool_call_id: "b", content: JSON.stringify({ ok: true }) },
      { role: "tool", tool_call_id: "c", content: JSON.stringify({ ok: false, code: "x", message: "片段重叠了" }) },
      { role: "assistant", content: "", tool_calls: [call("d", "analyze_reference")] },
      { role: "tool", tool_call_id: "d", content: JSON.stringify({ ok: true, analysis: "前三秒卡在重拍上" }) },
      { role: "assistant", content: "做好了" },
    ]);
    expect(text).toBe([
      "【之前的对话：应用转述给你的，接着做就行】",
      "用户：做一条卡点",
      "（这期间调了 add_text_clip 2 次）",
      "（调 get_timeline 没成功：片段重叠了）",
      `（调了 analyze_reference，结果：${JSON.stringify({ ok: true, analysis: "前三秒卡在重拍上" })}）`,
      "AI：做好了",
    ].join("\n"));
    expect(renderTranscript([])).toBe("");
    const long = renderTranscript([{ role: "user", content: "字".repeat(5_000) }, { role: "assistant", content: "好" }], 1_000);
    expect(long.length).toBeLessThan(1_200);
    // 太长时从前面整行丢：留下的第一行是完整的一句
    const many = renderTranscript(Array.from({ length: 40 }, (_, index) => ({ role: "user", content: `第 ${index} 句😀${"字".repeat(80)}` })), 1_000);
    const kept = many.split("\n").slice(2);
    expect(kept.every((line) => line.startsWith("用户：第 "))).toBe(true);
    expect(many).toContain("用户：第 39 句");
    expect(many).not.toContain("用户：第 0 句");
  });
});
