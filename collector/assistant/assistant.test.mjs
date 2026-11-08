import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DouyinCollector } from "../douyinCollector.mjs";
import { startCollectorServer } from "../server.mjs";
import { createConfirmDesk } from "./confirm.mjs";
import { countBy, filterRecords, listConversations, sendEach } from "./tools.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 只放进临时目录的合成记录，不碰真实数据
const RECORDS = {
  watch_history: [
    { id: "w1", videoId: "1001", title: "#城市散步 清晨路线", author: "示例创作者甲", occurredAt: "2026-10-03T01:10:00.000Z", topics: ["城市散步"], stats: { diggCount: 10 } },
    { id: "w2", videoId: "1002", title: "晚饭做什么", author: "示例创作者乙", occurredAt: "2026-10-04T12:10:00.000Z", topics: ["做饭"], stats: { diggCount: 99 } },
    { id: "w3", videoId: "1003", title: "#城市散步 夜景", author: "示例创作者甲", occurredAt: "2026-09-20T13:00:00.000Z", topics: ["城市散步", "夜景"] },
  ],
  liked_videos: [{ id: "l1", videoId: "1002", title: "晚饭做什么", author: "示例创作者乙", occurredAt: "2026-10-04T12:11:00.000Z" }],
  favorite_videos: [],
};

/** 假的 OpenAI 兼容接口：按剧本一问一答（不流式），记下每次收到的请求。 */
async function fakeModel(script) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      requests.push(JSON.parse(body));
      const step = script[Math.min(requests.length - 1, script.length - 1)];
      const message = typeof step === "string" ? { role: "assistant", content: step }
        : { role: "assistant", content: "", tool_calls: [{ id: `call_${requests.length}`, type: "function", function: { name: step.call, arguments: JSON.stringify(step.args ?? {}) } }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { requests, config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key", model: "fake" } };
}

async function start({ chatMessages = [], chatConversations = [] } = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "assistant-"));
  cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(path.join(dataDirectory, "records.json"), JSON.stringify({ schemaVersion: 2, updatedAt: "2026-10-05T00:00:00.000Z", records: RECORDS, chatMessages, chatConversations, warnings: [] }));
  const runtime = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: false });
  cleanups.push(() => runtime.close());
  const { token } = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) }).then((response) => response.json());
  const call = async (method, pathname, body) => {
    const response = await fetch(`${runtime.baseUrl}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const until = async (check) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const { body } = await call("GET", "/v1/assistant");
      if (check(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("等不到");
  };
  return { runtime, dataDirectory, call, until };
}

const toolResult = (request) => JSON.parse(request.messages.findLast((message) => message.role === "tool").content);

describe("searching and counting the local records", () => {
  const snapshot = { records: RECORDS };
  it("matches every search word and keeps to the date range", () => {
    expect(filterRecords(snapshot, { query: "城市散步 夜景" }).map(({ record }) => record.videoId)).toEqual(["1003"]);
    expect(filterRecords(snapshot, { list: "watch_history", since: "2026-10-01", until: "2026-10-03" }).map(({ record }) => record.videoId)).toEqual(["1001"]);
    expect(filterRecords(snapshot, { list: "nope" })).toBeNull();
    expect(filterRecords(snapshot, { list: "all", author: "乙" })).toHaveLength(2);
  });

  it("counts by author or topic, and gives months in order", () => {
    const rows = filterRecords(snapshot, { list: "watch_history" });
    expect(countBy(rows, "author", 5).items).toEqual([{ key: "示例创作者甲", count: 2 }, { key: "示例创作者乙", count: 1 }]);
    expect(countBy(rows, "topic", 1).items).toEqual([{ key: "城市散步", count: 2 }]);
    expect(countBy(rows, "month", 5).items.map((item) => item.key)).toEqual(["2026-09", "2026-10"]);
  });
});

describe("listing chat conversations", () => {
  // 存下来的会话 lastActiveAt 常常是空的：时间要从消息里算
  const snapshot = {
    chatConversations: [
      { id: "a", name: "老朋友", kind: "friend", lastActiveAt: null, messageCount: 2 },
      { id: "b", name: "新朋友", kind: "friend", lastActiveAt: null, messageCount: 1 },
      { id: "g", name: "家人群", kind: "group", lastActiveAt: null, messageCount: 0 },
    ],
    chatMessages: [
      { conversationId: "a", senderName: "老朋友", sentAt: "2026-10-01T02:00:00.000Z", text: "好久不见" },
      { conversationId: "a", senderName: "我", sentAt: "2026-10-20T02:00:00.000Z", text: "最近怎么样" },
      { conversationId: "b", senderName: "新朋友", sentAt: "2026-10-29T02:00:00.000Z", share: { title: "做饭教程" }, type: "share" },
    ],
  };

  it("orders by the newest message and says what it was, with groups last", () => {
    const { items } = listConversations(snapshot, {});
    expect(items.map((item) => [item.name, Boolean(item.lastActive)])).toEqual([["新朋友", true], ["老朋友", true], ["家人群", false]]);
    expect(items[0].lastMessage).toBe("新朋友：分享了《做饭教程》");
    expect(items[1].lastMessage).toBe("我：最近怎么样");
  });

  it("keeps only the ones still talking since a date", () => {
    expect(listConversations(snapshot, { since: "2026-10-15" }).items.map((item) => item.name)).toEqual(["新朋友", "老朋友"]);
    expect(listConversations(snapshot, { since: "2026-10-25" }).items.map((item) => item.name)).toEqual(["新朋友"]);
  });
});

describe("sending to several people after one yes", () => {
  const reply = (status, outcome, message) => async () => ({ ok: status < 300, status, body: { outcome, message } });
  const instant = { gap: () => 0 };

  it("goes through everyone in order and counts a send without a receipt as sent", async () => {
    const order = [];
    const items = ["甲", "乙", "丙"].map((name, index) => ({ name, send: async () => { order.push(name); return reply(200, index === 1 ? "unknown" : "confirmed")(); } }));
    const result = await sendEach(items, instant);
    expect(order).toEqual(["甲", "乙", "丙"]);
    expect(result).toMatchObject({ ok: true, total: 3 });
    expect(result.results[1]).toMatchObject({ name: "乙", ok: true, note: expect.stringContaining("别重发") });
  });

  it("stops after two failures in a row and says who was left out", async () => {
    const result = await sendEach([
      { name: "甲", send: reply(200, "confirmed") },
      { name: "乙", send: reply(200, "rejected", "被拒了") },
      { name: "丙", send: reply(409, undefined, "没在接收") },
      { name: "丁", send: reply(200, "confirmed") },
    ], instant);
    expect(result).toMatchObject({ ok: true, total: 1, notSent: ["丁"] });
    expect(result.results.map((item) => item.ok)).toEqual([true, false, false]);
  });

  it("waits between sends and can be stopped while waiting", async () => {
    const controller = new AbortController();
    const sending = sendEach([{ name: "甲", send: reply(200, "confirmed") }, { name: "乙", send: reply(200, "confirmed") }], { signal: controller.signal, gap: () => 5_000 });
    setTimeout(() => controller.abort(), 20);
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("the confirm desk", () => {
  it("lets only the answer through, and turns no, silence and stop into errors", async () => {
    const desk = createConfirmDesk({ timeoutMs: 50 });
    const allowed = desk.ask({ action: "发私信" });
    desk.answer(desk.pending()[0].id, true);
    await expect(allowed).resolves.toBeUndefined();
    const denied = desk.ask({ action: "发私信" });
    desk.answer(desk.pending()[0].id, false);
    await expect(denied).rejects.toMatchObject({ code: "confirm_denied" });
    await expect(desk.ask({ action: "点赞" })).rejects.toMatchObject({ code: "confirm_timeout" });
    const controller = new AbortController();
    const stopped = desk.ask({ action: "点赞" }, { signal: controller.signal });
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    expect(desk.pending()).toEqual([]);
    expect(() => desk.answer("0123456789abcdef", true)).toThrow(/已经结束/u);
  });

  it("asks once per kind of action in a scope: same thing to someone else goes through, anything else asks again", async () => {
    const desk = createConfirmDesk();
    const first = desk.ask({ action: "分享作品", target: "甲", text: "《做饭》" }, { scope: "turn1" });
    expect(desk.pending()[0]).toMatchObject({ covers: true });
    desk.answer(desk.pending()[0].id, true);
    await first;
    await expect(desk.ask({ action: "分享作品", target: "乙", text: "《做饭》" }, { scope: "turn1" })).resolves.toBeUndefined();
    expect(desk.pending()).toEqual([]);
    desk.ask({ action: "分享作品", target: "丙", text: "《别的》" }, { scope: "turn1" }).catch(() => undefined);
    desk.ask({ action: "分享作品", target: "丁", text: "《做饭》" }, { scope: "turn2" }).catch(() => undefined);
    desk.ask({ action: "分享作品", target: "戊", text: "《做饭》" }).catch(() => undefined);
    expect(desk.pending()).toHaveLength(3);
    desk.forget("turn1");
    desk.ask({ action: "分享作品", target: "己", text: "《做饭》" }, { scope: "turn1" }).catch(() => undefined);
    expect(desk.pending()).toHaveLength(4);
    desk.close();
  });

  it("lets one yes cover at most 9 more", async () => {
    const desk = createConfirmDesk();
    const first = desk.ask({ action: "点赞" }, { scope: "t" });
    desk.answer(desk.pending()[0].id, true);
    await first;
    for (let index = 0; index < 9; index += 1) await desk.ask({ action: "点赞" }, { scope: "t" });
    desk.ask({ action: "点赞" }, { scope: "t" }).catch(() => undefined);
    expect(desk.pending()).toHaveLength(1);
    desk.close();
  });
});

describe("talking to the assistant", () => {
  it("files unique works, publishes the saved revision, and rejects an invalid batch without changing the folder", async () => {
    const { call, until } = await start();
    const organize = (ids) => ({ call: "organize_folders", args: { list: "watch_history", create: ["模型"], move: [{ folder: "模型", videoIds: ids }] } });
    const model = await fakeModel([
      organize(["1001", "1001", "1003"]), organize(["1001"]), organize(["1002", "missing"]), { call: "list_folders" }, "整理结束。",
    ]);
    await call("POST", "/v1/assistant/messages", { text: "整理进模型文件夹", config: model.config });
    const view = await until((item) => !item.busy);
    expect(toolResult(model.requests[1]).done).toContain("2 个作品放进「模型」");
    expect(toolResult(model.requests[2]).done).toEqual(["0 个作品放进「模型」，1 个已在里面"]);
    expect(toolResult(model.requests[3])).toMatchObject({ ok: false, code: "unknown_video_ids" });
    expect(toolResult(model.requests[4]).lists["观看历史"]).toEqual([{ name: "模型", count: 2 }]);
    const doc = (await call("GET", "/v1/folders")).body;
    expect(view.foldersRevision).toBe(doc.revision);
    const [folder] = doc.lists.watch_history.folders;
    expect(doc.lists.watch_history.items).toEqual({ "1001": folder.id, "1003": folder.id });
    const actions = view.messages.flatMap((message) => message.actions ?? []);
    expect(actions).toContainEqual(expect.objectContaining({ label: "整理文件夹", ok: false }));
  });

  it("uses the message's playback for the confirmation and outgoing card even with an older tool argument", async () => {
    const { call, until } = await start();
    const current = { videoId: "7100000000000000001", author: "作者甲", title: "作品甲" };
    const other = { videoId: "7100000000000000002", author: "作者乙", title: "作品乙" };
    const api = { session: { uid: "123" }, request: vi.fn(async (_path, { query }) => {
      const video = [current, other].find((item) => item.videoId === query.aweme_id);
      return { aweme_detail: { aweme_id: video.videoId, desc: video.title, author: { nickname: video.author } } };
    }) };
    const friend = { id: "0:1:123:456", type: 1, name: "好友" };
    const send = vi.fn(async () => ({ outcome: "confirmed" }));
    const apiSpy = vi.spyOn(DouyinCollector.prototype, "ensureDirectApi").mockResolvedValue(api);
    const chatSpy = vi.spyOn(DouyinCollector.prototype, "getDirectChatClient").mockResolvedValue({ api, conversations: new Map([[friend.id, friend]]), send });
    cleanups.push(() => { apiSpy.mockRestore(); chatSpy.mockRestore(); });
    const share = (videoId) => ({ call: "douyin_interact", args: { action: "share", shareTo: [friend.name], videoId } });
    const model = await fakeModel([{ call: "app_overview" }, share(other.videoId), share("current"), "已分享。",
      share("current"), "请提供链接。", share(current.videoId), "已分享。"]);
    const submit = (text, currentVideo) => call("POST", "/v1/assistant/messages", { text, currentVideo, config: model.config });
    const approve = (card) => call("POST", `/v1/assistant/confirm/${card.id}`, { allow: true });

    await submit("把这个视频发给好友", current);
    const [card] = (await until((view) => view.confirms.length)).confirms;
    expect(toolResult(model.requests[1]).currentVideo).toEqual(current);
    expect(toolResult(model.requests[2]).code).toBe("wrong_current_video");
    expect(card.text).toContain(current.title);
    expect(send).not.toHaveBeenCalled();
    await approve(card);
    await until((view) => !view.busy);
    expect(send.mock.calls[0][1].content).toMatchObject({ itemId: current.videoId, content_title: current.title });

    await submit("把这个视频发给好友", null);
    await until((view) => !view.busy);
    expect(toolResult(model.requests[5]).code).toBe("no_current_video");
    expect(send).toHaveBeenCalledTimes(1);

    await submit("把第一条消息里的作品发给好友", other);
    const [explicit] = (await until((view) => view.confirms.length)).confirms;
    const messages = model.requests.at(-1).messages.filter((message) => message.role === "user");
    expect(messages.map(({ content }) => content)).toEqual([
      expect.stringContaining(current.videoId), expect.stringContaining("无可用 ID"), expect.stringContaining(other.videoId),
    ]);
    expect(explicit.text).toContain(current.title);
    await approve(explicit);
    await until((view) => !view.busy);
    expect(send.mock.calls[1][1].content.itemId).toBe(current.videoId);
  });

  it("answers from the user's records through a tool and shows what it did", async () => {
    const { call, until } = await start();
    const model = await fakeModel([{ call: "record_stats", args: { by: "author", list: "watch_history" } }, "你最常看示例创作者甲。"]);
    expect((await call("POST", "/v1/assistant/messages", { text: "我最常看谁？", config: model.config })).status).toBe(200);
    const done = await until((view) => !view.busy && view.messages.length >= 2);
    expect(done.error).toBeNull();
    expect(done.messages).toEqual([
      { role: "user", text: "我最常看谁？" },
      { role: "assistant", text: "", actions: [{ label: "统计记录 · 3 条", ok: true }] },
      { role: "assistant", text: "你最常看示例创作者甲。", actions: [] },
    ]);
    expect(toolResult(model.requests[1]).items[0]).toEqual({ key: "示例创作者甲", count: 2 });
  });

  it("waits for the user's yes before acting, and a no leaves things as they were", async () => {
    const { call, until, dataDirectory } = await start();
    const model = await fakeModel([{ call: "feed_filter_set", args: { mode: "dislike" } }, "好的。", { call: "feed_filter_set", args: { mode: "dislike" } }, "改好了。"]);
    await call("POST", "/v1/assistant/messages", { text: "推荐流改成不感兴趣", config: model.config });
    const asking = await until((view) => view.confirms.length === 1);
    expect(asking.confirms[0]).toMatchObject({ action: "把推荐流改成「不感兴趣」", source: "app" });
    // 这一轮的动作只在 streaming 里出现一次，历史只到用户这句
    expect(asking.messages.at(-1)).toEqual({ role: "user", text: "推荐流改成不感兴趣" });
    expect(asking.streaming.actions).toEqual([{ label: "改推荐流控制", ok: true, running: true }]);
    expect((await call("GET", "/v1/feed-filter")).body.mode).toBe("observe");
    await call("POST", `/v1/assistant/confirm/${asking.confirms[0].id}`, { allow: false });
    await until((view) => !view.busy);
    expect(toolResult(model.requests[1])).toMatchObject({ ok: false, code: "confirm_denied" });
    expect((await call("GET", "/v1/assistant")).body.messages[1].actions[0]).toEqual({ label: "改推荐流控制", ok: false, note: "你没同意，没有做" });
    expect((await call("GET", "/v1/feed-filter")).body.mode).toBe("observe");

    await call("POST", "/v1/assistant/messages", { text: "确定，改吧", config: model.config });
    const again = await until((view) => view.confirms.length === 1);
    await call("POST", `/v1/assistant/confirm/${again.confirms[0].id}`, { allow: true });
    await until((view) => !view.busy);
    expect((await call("GET", "/v1/feed-filter")).body.mode).toBe("dislike");
    // 对话存在数据目录里，接口 Key 不在里面
    const saved = await readFile(path.join(dataDirectory, "assistant.json"), "utf8");
    expect(saved).toContain("确定，改吧");
    expect(saved).not.toContain("test-key");
  });

  it("asks once for the same action in a turn, and again in the next turn", async () => {
    const { call, until } = await start();
    const dislike = { call: "feed_filter_set", args: { mode: "dislike" } };
    const model = await fakeModel([dislike, dislike, "好了。", dislike, "好了。"]);
    await call("POST", "/v1/assistant/messages", { text: "改两次", config: model.config });
    const asking = await until((view) => view.confirms.length === 1);
    await call("POST", `/v1/assistant/confirm/${asking.confirms[0].id}`, { allow: true });
    await until((view) => !view.busy);
    expect(toolResult(model.requests[2])).toMatchObject({ ok: true, mode: "dislike" });
    await call("POST", "/v1/assistant/messages", { text: "再改一次", config: model.config });
    const again = await until((view) => view.confirms.length === 1);
    await call("POST", `/v1/assistant/confirm/${again.confirms[0].id}`, { allow: false });
    await until((view) => !view.busy);
    expect(toolResult(model.requests[4])).toMatchObject({ code: "confirm_denied" });
  });

  it("stops a turn that is waiting on a card, without leaving the card or a half-done tool call behind", async () => {
    const { call, until } = await start();
    const model = await fakeModel([{ call: "feed_filter_set", args: { mode: "dislike" } }, "好的。"]);
    await call("POST", "/v1/assistant/messages", { text: "改", config: model.config });
    await until((view) => view.confirms.length === 1);
    await call("POST", "/v1/assistant/stop");
    const stopped = await until((view) => !view.busy);
    expect(stopped.confirms).toEqual([]);
    expect(stopped.error).toBeNull();
    expect((await call("GET", "/v1/feed-filter")).body.mode).toBe("observe");
    // 下一轮接得上：补过「没执行」的结果，接口不会因为调用和结果对不上而报错
    await call("POST", "/v1/assistant/messages", { text: "算了，看看我刷了多少", config: { ...model.config } });
    await until((view) => !view.busy);
    expect(model.requests.at(-1).messages.some((message) => message.role === "tool" && message.content.includes("stopped"))).toBe(true);
    expect((await call("DELETE", "/v1/assistant")).body.messages).toEqual([]);
  });

  it("stops after 10 actions others can see in one turn", async () => {
    const { call, until } = await start();
    // 没在接收聊天，每次发私信都会马上报错，不弹卡片；只看第 11 次是不是被上限挡下
    const model = await fakeModel([...Array.from({ length: 11 }, () => ({ call: "send_chat_message", args: { conversationId: "x", text: "在吗" } })), "停了。"]);
    await call("POST", "/v1/assistant/messages", { text: "给这些人都发一句", config: model.config });
    await until((view) => !view.busy && view.messages.length >= 2);
    expect(toolResult(model.requests[10])).toMatchObject({ code: "not_receiving" });
    expect(toolResult(model.requests[11])).toMatchObject({ code: "external_limit" });
  });

  it("refuses a config without a key", async () => {
    const { call } = await start();
    const missing = await call("POST", "/v1/assistant/messages", { text: "在吗", config: { baseUrl: "https://x.example/v1", model: "m" } });
    expect(missing).toMatchObject({ status: 400, body: { error: "invalid_config" } });
  });

  it("runs the same tools through a local CLI, which reaches them over MCP", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "assistant-cli-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    await writeFile(path.join(dataDirectory, "records.json"), JSON.stringify({ schemaVersion: 2, records: RECORDS, chatMessages: [], chatConversations: [], warnings: [] }));
    // 假的本机 CLI：经这一轮的 MCP 调一次 search_records，再说一句话
    const { createAssistant } = await import("./index.mjs");
    let found = null;
    let cliPrompt;
    const fakeLocalAi = {
      status: async (id) => ({ id, state: "ready" }),
      close: async () => undefined,
      async converse(id, { mcp, onText, prompt }) {
        cliPrompt = prompt;
        const reply = await fetch(mcp.url, { method: "POST", headers: { Authorization: `Bearer ${mcp.secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_records", arguments: { query: "夜景" } } }) }).then((response) => response.json());
        found = JSON.parse(reply.result.content[0].text);
        onText("找到一条夜景。");
      },
    };
    // 只验证 CLI 这条路：单独一个采集器和助手，读记录不经接口
    const { DouyinCollector } = await import("../douyinCollector.mjs");
    const { CollectorStore } = await import("../store.mjs");
    const collector = new DouyinCollector({ dataDirectory, store: new CollectorStore(dataDirectory) });
    await collector.initialize();
    cleanups.push(() => collector.close());
    const assistant = createAssistant({
      dataDirectory, baseUrl: () => "http://127.0.0.1:9", pairing: { issue: () => "unused" }, collector: () => collector,
      accounts: () => ({ activeId: "default", accounts: [] }), writesEnabled: () => false, localAi: fakeLocalAi,
    });
    cleanups.push(() => assistant.close());
    await assistant.send("找夜景", { runtime: "codex" }, { videoId: "7100000000000000003" });
    let view;
    for (let tries = 0; tries < 100 && (view = await assistant.wait(null)).busy; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(found).toMatchObject({ ok: true, total: 1, items: [{ videoId: "1003", title: "#城市散步 夜景" }] });
    expect(cliPrompt).toContain("7100000000000000003】\n找夜景");
    expect(view.messages[0]).toEqual({ role: "user", text: "找夜景" });
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", text: "找到一条夜景。" });
    expect(view.messages[1].actions[0]).toMatchObject({ label: "查记录 · 1 条", ok: true });
  });
});

describe("the MCP endpoint for the user's own AI client", () => {
  it("exports the requested conversation with native transcripts and per-message failures", async () => {
    const voice = { conversationId: "friend", conversationType: "friend", type: "voice" };
    const { runtime, dataDirectory } = await start({ chatMessages: [
      { ...voice, id: "102" },
      { ...voice, id: "101", voiceResource: { uri: "test-audio", skey: "local-only", secUid: "MS4wTest", conversationShortId: "1", messageType: 17 } },
      { ...voice, id: "103", text: "已有转写", voiceTranscription: { status: "done" } },
      { conversationId: "friend", id: "104", type: "text", text: "普通文字" },
      { conversationId: "another", id: "105", type: "text", text: "另一个会话" },
    ] });
    const request = vi.fn(async () => ({ recognition_results: [{ message_id: "101", text_result: "明天见。" }] }));
    const upstream = vi.spyOn(DouyinCollector.prototype, "ensureDirectApi").mockResolvedValue({ request, session: { values: {} } });
    cleanups.push(() => upstream.mockRestore());
    // MCP 在响应首个请求前会等令牌写入完成。
    await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", body: "{}" });
    const token = (await readFile(path.join(dataDirectory, "mcp-token"), "utf8")).trim();
    const response = await fetch(`${runtime.baseUrl}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "export_chat", arguments: { conversationId: "friend" } } }),
    });
    const { result } = await response.json();
    const exported = JSON.parse(result.content[0].text);
    expect(exported).toMatchObject({ ok: true, total: 4, warnings: [expect.stringContaining("1 条语音未转写")] });
    const contents = await readFile(exported.filePath, "utf8");
    expect(contents).not.toMatch(/voiceResource|local-only|另一个会话/);
    const { chatMessages, warnings, parts } = JSON.parse(contents);
    expect(parts).toEqual(["chat"]);
    expect(warnings).toEqual(exported.warnings);
    expect(chatMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "101", text: "明天见。", voiceTranscription: { status: "done" } }),
      expect.objectContaining({ id: "102", text: "[语音未转写]", voiceTranscription: { status: "unavailable", reason: expect.stringContaining("缺少语音转写资料") } }),
      expect.objectContaining({ id: "103", text: "已有转写" }),
      expect.objectContaining({ id: "104", text: "普通文字" }),
    ]));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers only the token kept in the data folder, and never a web page", async () => {
    const { runtime, dataDirectory } = await start();
    const post = (body, headers = {}) => fetch(`${runtime.baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const token = (await readFile(path.join(dataDirectory, "mcp-token"), "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer wrong" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...auth, Origin: "http://localhost:3000" })).status).toBe(403);
    const listed = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth)).json();
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search_records", "send_chat_message", "douyin_interact"]));
    const stats = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_stats", arguments: { by: "topic", list: "watch_history" } } }, auth)).json();
    expect(JSON.parse(stats.result.content[0].text).items[0]).toEqual({ key: "城市散步", count: 2 });
  });

  it("keeps the same token across restarts", async () => {
    const { runtime, dataDirectory } = await start();
    // 令牌是启动后写的：先请求一次，等它写完
    await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", body: "{}" });
    const first = await readFile(path.join(dataDirectory, "mcp-token"), "utf8");
    await runtime.close();
    const again = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: false });
    cleanups.push(() => again.close());
    await fetch(`${again.baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(await readFile(path.join(dataDirectory, "mcp-token"), "utf8")).toBe(first);
  });
});
