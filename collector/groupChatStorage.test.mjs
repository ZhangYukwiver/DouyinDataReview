import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorStore } from "./store.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { startCollectorServer } from "./server.mjs";
import { createEmptyRecords } from "./normalizer.mjs";
import { buildDataExport } from "./dataExport.mjs";
import { GroupChatStorage, parseGroupConversationIds } from "./groupChatStorage.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "dy2-group-allowlist-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const conversations = ["101", "202"].map(id => ({ id, name: `群${id}`, kind: "group", type: 2, shortId: "1", messageCount: 1, ownMessageCount: 0 }));
const message = (id, conversationId = "101", conversationType = "group") => ({ id, conversationId, conversationType, type: "text", text: `合成消息${id}`, senderId: "9", sentAt: "2026-11-01T12:00:00Z" });

describe("group storage authorization and deletion", () => {
  it("defaults to no group bodies, including an unknown-type message in a known group", async () => {
    const store = new CollectorStore(await directory());
    const saved = await store.save(createEmptyRecords(), [], { chatConversations: conversations,
      chatMessages: [message("1"), message("2", "202", "unknown"), message("3", "303", "friend")] });
    expect(saved.chatMessages.map(item => item.id)).toEqual(["3"]);
    expect(await readFile(store.filePath, "utf8")).not.toContain("合成消息1");
  });

  it("persists only an allowed group, deduplicates, survives restart and deletes history after removal", async () => {
    const dir = await directory();
    let store = new CollectorStore(dir);
    await store.load();
    await store.groupChatStorage.save(["101"]);
    let saved = await store.save(createEmptyRecords(), [], { chatConversations: conversations,
      chatMessages: [message("1"), message("1"), message("2", "202")] });
    expect(saved.chatMessages.map(item => item.id)).toEqual(["1"]);
    expect(buildDataExport(saved, { chat: true }).chatMessages).toHaveLength(1);
    store = new CollectorStore(dir);
    saved = await store.load();
    expect(saved.chatMessages[0].text).toBe("合成消息1");
    await store.groupChatStorage.save([]);
    saved = await store.save(saved.records, [], { ...saved, chatMessages: [...saved.chatMessages,
      message("4"), { ...message("1"), text: "不能替换存档" }, message("1", "202")] });
    expect(saved.chatMessages).toEqual([]);
    expect(buildDataExport(saved, { chat: true }).chatMessages).toEqual([]);
    expect((await new CollectorStore(dir).load()).chatMessages).toEqual([]);
    expect(await readFile(store.filePath, "utf8")).not.toContain("合成消息1");
    expect((await new CollectorStore(await directory()).load()).chatMessages).toEqual([]);
  });

  it("does not rewrite stored data when the authorization file is corrupt", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101"]);
    await store.save(createEmptyRecords(), [], { chatConversations: conversations, chatMessages: [message("1")] });
    const before = await readFile(store.filePath, "utf8");
    await writeFile(path.join(dir, "group-chat-storage.json"), "broken");
    await expect(new CollectorStore(dir).load()).rejects.toThrow();
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  it("validates IDs and keeps account directories isolated", async () => {
    expect(() => parseGroupConversationIds(["*"])).toThrow();
    expect(() => parseGroupConversationIds("101")).toThrow();
    const first = new GroupChatStorage(await directory()), second = new GroupChatStorage(await directory());
    await first.save(["101", "101"]);
    await second.load();
    expect(first.conversationIds).toEqual(["101"]);
    expect(second.conversationIds).toEqual([]);
  });
});

describe("group chat collection", () => {
  it("deletes a disabled group's history and cache without stopping reception or resurrecting it on later pushes", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101", "202"]);
    await store.save(createEmptyRecords(), [], { chatConversations: conversations,
      chatMessages: [message("deleted"), message("kept", "202"), message("friend", "303", "friend")] });
    const collector = new DouyinCollector({ dataDirectory: dir, store });
    await collector.initialize();
    const client = {
      conversations: new Map(conversations.map(item => [item.id, item])),
      messagePages: new Map([["101", { messages: [message("deleted")], hasMore: false }], ["202", { messages: [message("kept", "202")], hasMore: false }]]),
      initialize: vi.fn(async ({ onPayload }) => onPayload({ conversations, messages: [] })),
      connect: vi.fn(async ({ onConnection }) => onConnection("connected")), close: vi.fn(async () => {}),
      messages: vi.fn(async ({ conversationId }) => ({ pageMessages: [message("new-history", conversationId)], hasMore: false })),
    };
    collector.ensureDirectApi = vi.fn(async () => ({ session: { uid: "9" }, chatClient: client }));
    collector.startChatObservation();
    cleanups.push(() => collector.stopChatObservation({ silent: true }));
    await vi.waitFor(() => expect(collector.chat?.historyReady).toBe(true));
    const receiving = collector.chat;
    await expect(collector.setGroupChatStorage(["202"])).rejects.toMatchObject({ code: "group_history_confirmation_required" });
    expect(collector.snapshot.chatMessages.some(item => item.id === "deleted")).toBe(true);
    await collector.setGroupChatStorage(["202"], { deleteConversationIds: ["101"] });
    expect(collector.chat).toBe(receiving);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.messagePages.has("101")).toBe(false);
    expect(collector.snapshot.chatMessages.map(item => item.id).sort()).toEqual(["friend", "kept"]);
    expect(collector.snapshot.chatConversations.find(item => item.id === "101").messageCount).toBe(1);
    await collector.chat.acceptRead({ messages: [message("later-push"), message("kept-push", "202")], conversations: [] });
    expect((await new CollectorStore(dir).load()).chatMessages.some(item => item.conversationId === "101")).toBe(false);
    await collector.setGroupChatStorage(["101", "202"]);
    await vi.waitFor(() => expect(collector.snapshot.chatMessages.some(item => item.id === "new-history")).toBe(true));
    expect(collector.snapshot.chatMessages.some(item => ["deleted", "later-push"].includes(item.id))).toBe(false);
    expect(client.messages).toHaveBeenCalledWith({ conversationId: "101" }, expect.anything());
    await collector.stopChatObservation({ silent: true });
    expect((await new CollectorStore(dir).load()).chatMessages.some(item => item.id === "deleted")).toBe(false);
  });

  it("keeps the whitelist and local history when writing the deletion fails", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101"]);
    await store.save(createEmptyRecords(), [], { chatConversations: conversations, chatMessages: [message("kept")] });
    const collector = new DouyinCollector({ dataDirectory: dir, store });
    await collector.initialize();
    const failedSave = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk failure"));
    await expect(collector.setGroupChatStorage([], { deleteConversationIds: ["101"] })).rejects.toThrow("disk failure");
    failedSave.mockRestore();
    expect(collector.getGroupChatStorage().conversationIds).toEqual(["101"]);
    expect((await new CollectorStore(dir).load()).chatMessages.map(item => item.id)).toEqual(["kept"]);
  });

  it("clears old non-whitelisted group bodies on startup", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "group-chat-storage.json"), JSON.stringify({ conversationIds: ["101"], retainedConversationIds: ["101", "202"] }));
    await writeFile(path.join(dir, "records.json"), JSON.stringify({ schemaVersion: 2, records: createEmptyRecords(), warnings: [],
      chatConversations: conversations, chatMessages: [message("kept"), message("old-archive", "202")] }));
    const loaded = await new CollectorStore(dir).load();
    expect(loaded.chatMessages.map(item => item.id)).toEqual(["kept"]);
    expect(await readFile(path.join(dir, "records.json"), "utf8")).not.toContain("old-archive");
  });

  it("authorizes already fetched group messages without interrupting reception or fetching them again", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    const collector = new DouyinCollector({ dataDirectory: dir, store });
    await collector.initialize();
    const cached = message("preview");
    const client = {
      conversations: new Map(conversations.map(item => [item.id, item])),
      messagePages: new Map([["101", { messages: [cached], hasMore: false }]]),
      initialize: vi.fn(async ({ onPayload }) => onPayload({ conversations, messages: [] })),
      connect: vi.fn(async ({ onConnection }) => onConnection("connected")), close: vi.fn(async () => {}),
      messages: vi.fn(async ({ conversationId }) => ({ pageMessages: [message("refetched", conversationId)], hasMore: false })),
    };
    collector.ensureDirectApi = vi.fn(async () => ({ session: { uid: "9" }, chatClient: client }));
    collector.startChatObservation();
    cleanups.push(() => collector.stopChatObservation({ silent: true }));
    await vi.waitFor(() => expect(collector.chat?.historyReady).toBe(true));
    const receiving = collector.chat;
    await collector.setGroupChatStorage(["101"]);
    expect(client.close).not.toHaveBeenCalled();
    expect(collector.chat).toBe(receiving);
    expect(collector.isChatReceiving()).toBe(true);
    expect(collector.snapshot.chatMessages.map(item => item.id)).toContain("preview");
    expect(client.messages).not.toHaveBeenCalled();
    await collector.setGroupChatStorage(["101", "202"]);
    await vi.waitFor(() => expect(collector.snapshot.chatMessages.some(item => item.conversationId === "202")).toBe(true));
    expect(client.messages).toHaveBeenCalledTimes(1);
    expect(client.messages.mock.calls[0][0]).toEqual({ conversationId: "202" });
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("keeps a connecting reception running when settings change", async () => {
    const dir = await directory(), collector = new DouyinCollector({ dataDirectory: dir, store: new CollectorStore(dir) });
    await collector.initialize();
    collector.runChatObservation = vi.fn(async (_runId, observation) => observation.stopPromise);
    collector.startChatObservation();
    cleanups.push(() => collector.stopChatObservation({ silent: true }));
    const connecting = collector.chat;
    await collector.setGroupChatStorage(["101"]);
    expect(collector.chat).toBe(connecting);
    expect(collector.chat?.active).toBe(true);
    expect(collector.runChatObservation).toHaveBeenCalledTimes(1);
  });

  it("saves cached previews while paused without starting reception", async () => {
    const dir = await directory(), collector = new DouyinCollector({ dataDirectory: dir, store: new CollectorStore(dir) });
    await collector.initialize();
    collector.snapshot.chatConversations = conversations;
    collector.directApi = { chatClient: { messagePages: new Map([["101", { messages: [message("paused-preview")], hasMore: false }]]) } };
    await collector.setGroupChatStorage(["101"]);
    expect(collector.snapshot.chatMessages.map(item => item.id)).toEqual(["paused-preview"]);
    expect(collector.chatPromise).toBeNull();
  });

  it("saves manually fetched pages only for allowlisted groups", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101"]);
    const collector = new DouyinCollector({ dataDirectory: dir, store });
    await collector.initialize();
    collector.snapshot.chatConversations = conversations;
    collector.chatClientForReading = () => ({ messages: async ({ conversationId }) => ({ messages: [message(conversationId, conversationId)], pageMessages: [message(conversationId, conversationId)], hasMore: false }) });
    await collector.readChatMessages({ conversationId: "101" });
    await collector.readChatMessages({ conversationId: "101" });
    await collector.readChatMessages({ conversationId: "202" });
    expect((await new CollectorStore(dir).load()).chatMessages.map(item => item.conversationId)).toEqual(["101"]);
  });

  it("hydrates allowed group history and receives allowed pushes while keeping other groups metadata-only", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101"]);
    const collector = new DouyinCollector({ dataDirectory: dir, store });
    await collector.initialize();
    collector.progressPersistIntervalMs = 0;
    collector.chatHistoryPageLimit = 2;
    let push;
    const client = {
      conversations: new Map(conversations.map(item => [item.id, item])),
      initialize: vi.fn(async ({ onPayload }) => onPayload({ conversations, messages: [message("unlisted", "202")] })),
      connect: vi.fn(async ({ onPayload }) => { push = onPayload; }), close: vi.fn(async () => {}),
      messages: vi.fn(async ({ conversationId, older }) => ({ pageMessages: [message(older ? "old" : "new", conversationId)], hasMore: !older })),
    };
    collector.ensureDirectApi = vi.fn(async () => ({ session: { uid: "9" }, chatClient: client }));
    let release;
    const observation = { active: true, stop: () => release(), stopPromise: new Promise(resolve => { release = resolve; }) };
    collector.chatRunId = 1;
    const run = collector.runDirectChatObservation(1, observation);
    try {
      await vi.waitFor(() => expect(observation.historyReady).toBe(true));
      expect(client.messages.mock.calls.map(([input]) => input.conversationId)).toEqual(["101", "101"]);
      collector.chat = observation;
      collector.chatClientForReading = () => client;
      client.messages.mockResolvedValueOnce({ pageMessages: [message("manual-history")], messages: [message("manual-history")], hasMore: false });
      await collector.readChatMessages({ conversationId: "101", older: true });
      await push({ messages: [message("push"), message("push"), message("denied", "202")], conversations: [] });
      expect(collector.snapshot.chatMessages.map(item => item.id).sort()).toEqual(["manual-history", "new", "old", "push"]);
      expect(collector.snapshot.chatConversations.map(item => item.id)).toContain("202");
    } finally { observation.active = false; observation.stop(); await run; }
    expect((await new CollectorStore(dir).load()).chatMessages).toHaveLength(4);
  });
});

describe("settings API and MCP", () => {
  it("reports whitelist status and local counts through MCP after deleting a group's history", async () => {
    const dir = await directory(), store = new CollectorStore(dir);
    await store.groupChatStorage.save(["101", "202", "303"]);
    const groups = ["101", "202", "303", "404"].map(id => ({ ...conversations[0], id, name: `群${id}`, messageCount: 999 }));
    await store.save(createEmptyRecords(), [], { chatConversations: groups, chatMessages: [message("1"), message("2", "202")] });
    await store.groupChatStorage.save(["101", "303"]);
    const runtime = await startCollectorServer({ port: 0, dataDirectory: dir, browserSources: [], desktopSupported: false });
    cleanups.push(() => runtime.close());
    await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", body: "{}" });
    const secret = (await readFile(path.join(dir, "mcp-token"), "utf8")).trim();
    async function tool(name, args = {}) {
      const response = await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }).then(r => r.json());
      return JSON.parse(response.result.content[0].text);
    }
    const listed = await tool("list_conversations");
    expect(listed.ok).toBe(true);
    expect(listed.items.map(({ conversationId, group, storageEnabled, localMessageCount, messages }) =>
      ({ conversationId, group, storageEnabled, localMessageCount, messages })).sort((a, b) => a.conversationId.localeCompare(b.conversationId))).toEqual([
      { conversationId: "101", group: true, storageEnabled: true, localMessageCount: 1, messages: 999 },
      { conversationId: "202", group: true, storageEnabled: false, localMessageCount: 0, messages: 999 },
      { conversationId: "303", group: true, storageEnabled: true, localMessageCount: 0, messages: 999 },
      { conversationId: "404", group: true, storageEnabled: false, localMessageCount: 0, messages: 999 },
    ]);
    const live = vi.spyOn(DouyinCollector.prototype, "readChatMessages").mockImplementation(async ({ conversationId }) =>
      ({ messages: [message(`live-${conversationId}`, conversationId)], hasMore: false }));
    cleanups.push(() => live.mockRestore());
    expect(await tool("read_chat", { conversationId: "101" })).toMatchObject({ ok: true, total: 1, items: [{ id: "1" }] });
    expect(live).not.toHaveBeenCalled();
    for (const conversationId of ["202", "303", "404"]) {
      const result = await tool("read_live_chat", { conversationId });
      expect(result).toMatchObject({ messages: [{ id: `live-${conversationId}` }] });
    }
    expect(live.mock.calls.map(([args]) => args.conversationId)).toEqual(["202", "303", "404"]);
  });

  it("requires pairing/account binding, reads stored groups offline, and exports only currently allowed groups", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "records.json"), JSON.stringify({ schemaVersion: 2, records: createEmptyRecords(), chatMessages: [], chatConversations: conversations, warnings: [] }));
    const runtime = await startCollectorServer({ port: 0, dataDirectory: dir, browserSources: [], desktopSupported: false });
    cleanups.push(() => runtime.close());
    const { token } = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(r => r.json());
    async function settings(method = "GET", body, account = "default", auth = token) {
      const r = await fetch(`${runtime.baseUrl}/v1/settings/group-chat-storage?account=${account}`, { method, headers: auth ? { Authorization: `Bearer ${auth}` } : {},
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json() };
    }
    expect((await settings("GET", null, "default", "")).status).toBe(401);
    expect((await settings()).body.conversationIds).toEqual([]);
    expect((await settings("POST", { conversationIds: ["101"] }, "other")).status).toBe(409);
    expect((await settings("POST", { conversationIds: ["*"] })).status).toBe(400);
    expect((await settings("POST", { conversationIds: ["101"] })).body.conversationIds).toEqual(["101"]);
    const imported = await fetch(`${runtime.baseUrl}/v1/records/import?account=default`, { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ records: createEmptyRecords(), chatConversations: conversations, chatMessages: [message("1"), message("2", "202")],
        // 外来文件携带的授权元数据不能把未勾选的群带进来。
        groupChatStorage: { conversationIds: ["101", "202"], retainedConversationIds: ["101", "202"] } }) });
    expect(imported.status).toBe(200);
    // 通过实际 MCP 工具回读；不登录、不请求抖音。
    await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", body: "{}" });
    const secret = (await readFile(path.join(dir, "mcp-token"), "utf8")).trim();
    async function tool(name, args) {
      const r = await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }).then(r => r.json());
      return JSON.parse(r.result.content[0].text);
    }
    expect(await tool("read_chat", { conversationId: "101" })).toMatchObject({ ok: true, total: 1, items: [{ text: "合成消息1" }] });
    expect(await tool("read_chat", { conversationId: "202" })).toMatchObject({ ok: true, total: 0 });
    expect(await tool("export_chat", { conversationId: "202" })).toMatchObject({ ok: false, code: "group_not_stored" });
    const exported = await tool("export_chat", { conversationId: "101" });
    expect(exported).toMatchObject({ ok: true, total: 1 });
    expect(JSON.parse(await readFile(exported.filePath, "utf8")).chatMessages[0].text).toBe("合成消息1");
    expect((await settings("POST", { conversationIds: [] })).status).toBe(409);
    expect(await tool("read_chat", { conversationId: "101" })).toMatchObject({ ok: true, total: 1 });
    expect((await settings("POST", { conversationIds: [], deleteConversationIds: ["101"] })).status).toBe(200);
    expect(await tool("read_chat", { conversationId: "101" })).toMatchObject({ ok: true, total: 0 });
    expect((await tool("list_conversations", { query: "群101" })).items[0]).toMatchObject({ storageEnabled: false, localMessageCount: 0 });
    expect(await tool("export_chat", { conversationId: "101" })).toMatchObject({ ok: false, code: "group_not_stored" });
    expect(await tool("export_chat", { conversationId: "all" })).toMatchObject({ ok: true, total: 0 });
  });
});
