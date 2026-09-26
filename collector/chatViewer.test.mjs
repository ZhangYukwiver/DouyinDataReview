import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChatMessages, normalizeStreaks } from "./chatViewer.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";

const GROUP = "7329103166266475045";
const fast = { wheelMs: 1, attempts: 5, switchMs: 0 };
const window = (state, days, text, start = 1_790_352_000) => ({ start, end: start + 86_400, days, real_days: days, state, text });

// Page functions run here against a fake of the site's chat store; wheeling the list up pages in older messages like the site does.
function fakeChatPage({ total = 120, pageSize = 50, loaded = 20 } = {}) {
  const all = Array.from({ length: total }, (_, index) => ({
    serverId: String(7_000_000_000_000_000_000n + BigInt(index)), sender: index % 2 ? "111" : "222", secSender: index % 2 ? "sec-111" : "sec-222",
    createdAt: new Date(Date.UTC(2026, 8, 1) + index * 60_000), type: 7, content: JSON.stringify({ text: `消息${index}`, aweType: 700 }), indexInConversation: 1_000 + index,
  }));
  let from = total - loaded;
  const conversation = { id: GROUP, type: 2, minIndex: 1_000, getMessageList: () => all.slice(from), getParticipantList: () => [{ userId: "111", alias: "群里的昵称" }, { userId: "222", alias: "" }] };
  const store = { conversationMap: new Map([[GROUP, conversation]]), curConversationId: null, setCurConversation: vi.fn(function (item) { this.curConversationId = item.id; from = Math.max(0, from - pageSize); }) };
  globalThis.conversationStore = store;
  globalThis.userInfoStore = { getUserBySecUid: (sec) => ({ nickname: sec === "sec-222" ? "用户资料里的名字" : "不该用到", avatar_thumb: { url_list: ["https://p3.douyinpic.com/a.jpeg"] } }) };
  const page = { evaluate: async (fn, arg) => fn(arg), mouse: { move: vi.fn(async () => {}), wheel: vi.fn(async () => { from = Math.max(0, from - pageSize); }) } };
  globalThis.document = { querySelectorAll: () => [{ scrollHeight: 5_000, clientHeight: 700, getBoundingClientRect: () => ({ left: 320, top: 60, width: 900, height: 700 }) }] };
  globalThis.getComputedStyle = () => ({ overflowY: "auto" });
  return { page, store };
}
afterEach(() => { delete globalThis.conversationStore; delete globalThis.userInfoStore; delete globalThis.document; delete globalThis.getComputedStyle; });

describe("official streaks", () => {
  it("keeps valid day windows and drops what it cannot read", () => {
    const rows = [[GROUP, JSON.stringify({ flame_infos: [window(3, 789, "重燃中 2/3"), window(9, 1, "x"), { start: 5, end: 1 }] })], ["bad id\"]", "{}"], ["7091970798369407526", "not json"]];
    expect(normalizeStreaks(rows)).toEqual([{ conversationId: GROUP, windows: [{ start: 1_790_352_000, end: 1_790_438_400, days: 789, state: 3, text: "重燃中 2/3" }] }]);
  });
});

describe("group messages", () => {
  it("reads what the site already holds without opening the conversation", async () => {
    const { page, store } = fakeChatPage();
    const result = await loadChatMessages(page, { conversationId: GROUP }, fast);
    expect(result.messages).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(store.setCurConversation).not.toHaveBeenCalled();
    expect(result.messages.find((message) => message.senderId === "111")).toMatchObject({ senderName: "群里的昵称", conversationType: "group" });
    expect(result.messages.find((message) => message.senderId === "222")).toMatchObject({ senderName: "用户资料里的名字" });
  });
  it("pages older only when asked and stops at the start of the history", async () => {
    const { page, store } = fakeChatPage();
    expect((await loadChatMessages(page, { conversationId: GROUP, older: true }, fast)).messages).toHaveLength(70);
    expect(store.setCurConversation).toHaveBeenCalledTimes(1);
    const last = await loadChatMessages(page, { conversationId: GROUP, older: true }, fast);
    expect(last).toMatchObject({ hasMore: false });
    expect(last.messages).toHaveLength(120);
    await loadChatMessages(page, { conversationId: GROUP, older: true }, fast);
    expect(page.mouse.wheel).toHaveBeenCalledTimes(1);
  });
});

describe("collector gate", () => {
  it("reads only while receiving and never pages older during a send", async () => {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    await expect(collector.readChatMessages({ conversationId: GROUP })).rejects.toMatchObject({ code: "not_receiving" });
    collector.contextHeadless = true;
    collector.status = { ...collector.status, chat: { ...collector.status.chat, state: "observing", connection: "connected" } };
    const { page } = fakeChatPage();
    collector.chat = { active: true, mode: "chat", page: { ...page, isClosed: () => false }, historyReady: true };
    collector.chatSendPromise = new Promise(() => {});
    await expect(collector.readChatMessages({ conversationId: GROUP, older: true })).rejects.toMatchObject({ code: "collector_busy" });
    await expect(collector.readChatMessages({ conversationId: GROUP })).resolves.toMatchObject({ hasMore: true });
    await expect(collector.readChatStreaks()).resolves.toEqual({ streaks: [] });
  });
});
