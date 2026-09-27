import { afterEach, describe, expect, it, vi } from "vitest";

import { DouyinCollector } from "./douyinCollector.mjs";
import { CHAT_TEXT_LIMIT, sendChatText, validateChatSend } from "./chatSender.mjs";

const CONVERSATION = "0:1:111:222";
const fast = { timeoutMs: 300, settleMs: 60, pollMs: 5, switchMs: 0 };

// A stand-in for www.douyin.com/chat: page functions run here against a fake
// conversationStore, and the composer keeps its lines the way the site does.
function fakeChat({ type = 1, draft = "", onSend, dropText = false, editors = 1 } = {}) {
  const messages = [];
  const conversation = { id: CONVERSATION, type, getMessageList: (filter) => messages.filter(filter) };
  const store = {
    conversationMap: new Map([[CONVERSATION, conversation]]),
    curConversationId: null,
    get curConversation() { return this.curConversationId === CONVERSATION ? conversation : null; },
    setCurConversation(item) { this.curConversationId = item.id; },
  };
  let lines = [draft];
  let selected = false;
  const element = { querySelectorAll: () => lines.map((line) => ({ textContent: `${line}\u200b` })) };
  const editor = {
    first: () => editor,
    waitFor: async () => {},
    count: async () => editors,
    click: vi.fn(async () => {}),
    evaluate: async (fn) => fn(element),
  };
  const button = {
    count: async () => 1,
    click: vi.fn(async () => {
      const text = lines.join("\n");
      onSend?.({ text, messages, clearBox: () => { lines = [""]; } });
    }),
  };
  const page = {
    evaluate: async (fn, arg) => fn(arg),
    locator: (selector) => selector === "body" ? { innerText: async () => "" } : selector.includes("send-msg-btn") ? button : editor,
    title: async () => "抖音",
    frames: () => [],
    isClosed: () => false,
    keyboard: {
      press: async (key) => {
        if (key.endsWith("+A")) selected = true;
        else if (key === "Backspace" && selected) { lines = [""]; selected = false; }
        else if (key === "Shift+Enter") lines.push("");
      },
      insertText: async (text) => { lines[lines.length - 1] += dropText ? text.slice(1) : text; },
    },
  };
  globalThis.conversationStore = store;
  return { page, messages, store, button, box: () => lines.join("\n") };
}

// The SDK creates the message, then flips its status once the server answers.
const sdkSend = (finalStatus, extra = {}) => ({ text, messages, clearBox }) => {
  clearBox();
  const message = { isFromMe: true, clientId: `c-${messages.length}`, serverId: "", flightStatus: 2,
    content: JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text }), sender: "111", createdAt: new Date("2026-09-17T12:00:00Z"), ext: {} };
  messages.push(message);
  setTimeout(() => Object.assign(message, { flightStatus: finalStatus }, extra), 15);
};

afterEach(() => { delete globalThis.conversationStore; });

describe("chat send validation", () => {
  it("accepts one friend message and normalizes line endings", () => {
    expect(validateChatSend({ requestId: "request-0000000001", conversationId: CONVERSATION, text: "早\r\n安" }))
      .toEqual({ requestId: "request-0000000001", conversationId: CONVERSATION, text: "早\n安" });
  });
  it("rejects blank, oversized and unidentified requests", () => {
    const base = { requestId: "request-0000000001", conversationId: CONVERSATION };
    expect(() => validateChatSend({ ...base, text: " \n " })).toThrow("不能发送空白消息");
    expect(() => validateChatSend({ ...base, text: "字".repeat(CHAT_TEXT_LIMIT + 1) })).toThrow("太长");
    expect(() => validateChatSend({ ...base, requestId: "short", text: "hi" })).toThrow("发送请求无效");
    expect(() => validateChatSend({ ...base, conversationId: "", text: "hi" })).toThrow("好友会话");
  });
});

describe("sending through the site's composer", () => {
  it("types lines, replaces a restored draft and confirms once the server assigns an id", async () => {
    const chat = fakeChat({ draft: "旧草稿", onSend: sdkSend(3, { serverId: "7550000000000000001" }) });
    const result = await sendChatText(chat.page, { conversationId: CONVERSATION, text: "第一行[微笑]\n第二行" }, fast);
    expect(result).toMatchObject({ outcome: "confirmed", message: "已发送" });
    expect(result.chatMessage).toMatchObject({
      id: "7550000000000000001", conversationId: CONVERSATION, conversationType: "friend",
      senderId: "111", type: "text", text: "第一行[微笑]\n第二行", sentAt: "2026-09-17T12:00:00.000Z",
    });
    expect(chat.store.curConversationId).toBe(CONVERSATION);
    expect(chat.button.click).toHaveBeenCalledOnce();
  });

  it("does not take an older identical message for the new one", async () => {
    const chat = fakeChat({ onSend: ({ clearBox }) => clearBox() });
    chat.messages.push({ isFromMe: true, clientId: "old", serverId: "7550000000000000000", flightStatus: 4, content: JSON.stringify({ text: "在吗" }), sender: "111", createdAt: new Date() });
    await expect(sendChatText(chat.page, { conversationId: CONVERSATION, text: "在吗" }, fast)).resolves.toMatchObject({ outcome: "unknown" });
  });

  it.each([
    [-3, {}, "只有你自己能看到"],
    [-2, { ext: { "s:send_response_check_msg": "对方暂时不接收消息" } }, "对方暂时不接收消息"],
    [-1, {}, "没发出去"],
  ])("reports status %i as not delivered", async (status, extra, text) => {
    const chat = fakeChat({ onSend: sdkSend(status, extra) });
    const result = await sendChatText(chat.page, { conversationId: CONVERSATION, text: "晚安" }, fast);
    expect(result.outcome).toBe("rejected");
    expect(result.message).toContain(text);
  });

  it("calls it unsent when the site ignores the click and clears the box", async () => {
    const chat = fakeChat();
    const result = await sendChatText(chat.page, { conversationId: CONVERSATION, text: "你好" }, fast);
    expect(result).toMatchObject({ outcome: "rejected" });
    expect(chat.box()).toBe("");
  });

  it("stays uncertain while the message is still in flight", async () => {
    const chat = fakeChat({ onSend: sdkSend(2) });
    await expect(sendChatText(chat.page, { conversationId: CONVERSATION, text: "你好" }, fast)).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("refuses before clicking when the box does not hold exactly the text", async () => {
    const chat = fakeChat({ dropText: true });
    await expect(sendChatText(chat.page, { conversationId: CONVERSATION, text: "你好" }, fast)).rejects.toMatchObject({ code: "input_mismatch" });
    expect(chat.button.click).not.toHaveBeenCalled();
    expect(chat.box()).toBe("");
  });

  it("sends to a group as a group message, refuses unknown conversations and a missing composer", async () => {
    const group = fakeChat({ type: 2, onSend: sdkSend(3, { serverId: "7000000000000000001" }) });
    const sent = await sendChatText(group.page, { conversationId: CONVERSATION, text: "hi" }, fast);
    expect(sent).toMatchObject({ outcome: "confirmed", chatMessage: { conversationType: "group" } });
    await expect(sendChatText(fakeChat().page, { conversationId: "0:1:111:999", text: "hi" }, fast)).rejects.toMatchObject({ code: "conversation_unavailable" });
    const hidden = fakeChat({ editors: 0 });
    await expect(sendChatText(hidden.page, { conversationId: CONVERSATION, text: "hi" }, fast)).rejects.toMatchObject({ code: "control_unavailable" });
    expect(hidden.button.click).not.toHaveBeenCalled();
  });
});

describe("collector send gate", () => {
  function receivingCollector(page, overrides = {}) {
    const collector = new DouyinCollector({ executablePath: "chrome", dataDirectory: ".test", store: {} });
    collector.contextHeadless = true;
    collector.status = { ...collector.status, chat: { ...collector.status.chat, state: "observing", connection: "connected" } };
    collector.chat = { active: true, mode: "chat", page, historyReady: true, acceptSent: vi.fn(), ...overrides };
    return collector;
  }
  const input = { requestId: "request-0000000001", conversationId: CONVERSATION, text: "早安" };

  it("sends once per request id and stores the confirmed message", async () => {
    const chat = fakeChat({ onSend: sdkSend(3, { serverId: "7550000000000000002" }) });
    const collector = receivingCollector(chat.page);
    const [first, repeat] = await Promise.all([collector.sendChatMessage(input), collector.sendChatMessage(input)]);
    expect(first).toMatchObject({ outcome: "confirmed" });
    expect(repeat).toBe(first);
    expect(chat.button.click).toHaveBeenCalledOnce();
    expect(collector.chat.acceptSent).toHaveBeenCalledWith(expect.objectContaining({ id: "7550000000000000002", text: "早安" }));
    await expect(collector.sendChatMessage({ ...input, text: "改了" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(collector.chatSendPromise).toBeNull();
  });

  it.each([
    [{ historyReady: false }, {}, "collector_busy"],
    [{ stopping: true }, {}, "not_receiving"],
    [{}, { connection: "reconnecting" }, "not_connected"],
    [{}, { state: "idle" }, "not_receiving"],
  ])("waits for a ready connection (%o %o)", async (observation, chatStatus, code) => {
    const chat = fakeChat();
    const collector = receivingCollector(chat.page, observation);
    collector.status = { ...collector.status, chat: { ...collector.status.chat, ...chatStatus } };
    await expect(collector.sendChatMessage(input)).rejects.toMatchObject({ code });
    expect(chat.button.click).not.toHaveBeenCalled();
  });

  it("lets the same request run again when it failed before the click", async () => {
    const chat = fakeChat({ dropText: true });
    const collector = receivingCollector(chat.page);
    await expect(collector.sendChatMessage(input)).rejects.toMatchObject({ code: "input_mismatch" });
    expect(collector.chatSends.has(input.requestId)).toBe(false);
  });
});
