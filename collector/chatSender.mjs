import { setTimeout as delay } from "node:timers/promises";
import { normalizeChatPayload } from "./chatNormalizer.mjs";
import { pageNeedsVerification } from "./readOnlyPage.mjs";

// Type into the website's own composer and let it send: the site owns signing,
// tickets and the transport. Hooks verified on www.douyin.com/chat 2026-09-17;
// the public auto-reply tools use the same ones.
const EDITOR = '[data-e2e="msg-input"] [contenteditable="true"]';
const SEND_BUTTON = '[data-e2e="msg-input"] .e2e-send-msg-btn';
const SELECT_ALL = process.platform === "darwin" ? "Meta+A" : "Control+A";
// The site's composer refuses blank text and more than 16000 UTF-16 units.
export const CHAT_TEXT_LIMIT = 16_000;
// flightStatus of the web IM SDK message model: Succeeded 3, Received 4,
// Failed -1, Rejected -2, SelfVisible -3 (held by moderation, only the sender sees it).
const DELIVERED = new Set([3, 4]);

export class ChatSendError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

export function validateChatSend(input) {
  if (typeof input?.requestId !== "string" || !/^[\w-]{16,80}$/u.test(input.requestId))
    throw new ChatSendError("invalid_request", "发送请求无效，请重试。", 400);
  if (typeof input.conversationId !== "string" || !/^[\w:.-]{1,200}$/u.test(input.conversationId))
    throw new ChatSendError("invalid_request", "请先选一个好友会话。", 400);
  const text = typeof input.text === "string" ? input.text.replace(/\r\n?/gu, "\n") : "";
  if (!text.trim()) throw new ChatSendError("invalid_request", "不能发送空白消息。", 400);
  if (text.length > CHAT_TEXT_LIMIT) throw new ChatSendError("invalid_request", "消息太长了，分几条发吧。", 400);
  return { requestId: input.requestId, conversationId: input.conversationId, text };
}

// The three helpers below run inside the page.
export function openConversation(id) {
  const store = globalThis.conversationStore;
  const item = store?.conversationMap?.get(id) ?? store?.strangerConversationMap?.get(id);
  if (!item) return { state: "missing" };
  // Groups use the same composer; type 1 is a one-to-one chat.
  const group = item.type !== 1;
  if (store.curConversationId === id) return { state: "ok", group };
  store.setCurConversation(item);
  return { state: store.curConversationId === id ? "switched" : "failed", group };
}

function ownMessages(id) {
  const conversation = globalThis.conversationStore?.curConversation;
  if (!conversation || conversation.id !== id) return null;
  const textOf = (content) => {
    try { const value = JSON.parse(content)?.text; return typeof value === "string" ? value : null; } catch { return null; }
  };
  // The SDK keeps a bounded ring buffer per conversation, so this list stays small.
  return conversation.getMessageList(() => true).filter((message) => message.isFromMe).map((message) => ({
    clientId: String(message.clientId ?? ""),
    serverId: String(message.serverId ?? ""),
    status: message.flightStatus,
    text: textOf(message.content),
    sender: String(message.sender ?? ""),
    sentAt: Number(message.createdAt) || null,
    check: typeof message.ext?.["s:send_response_check_msg"] === "string" ? message.ext["s:send_response_check_msg"] : "",
  }));
}

// Every line carries a zero-width placeholder.
function editorText(element) {
  return [...element.querySelectorAll(".ace-line")].map((line) => line.textContent.replace(/\u200b/gu, "")).join("\n");
}

const rejected = (message) => ({ outcome: "rejected", message });

export async function sendChatText(page, { conversationId, text }, { timeoutMs = 20_000, settleMs = 3_000, pollMs = 250, switchMs = 800 } = {}) {
  const { state: opened, group } = await page.evaluate(openConversation, conversationId);
  if (opened === "missing") throw new ChatSendError("conversation_unavailable", "抖音网页里暂时找不到这个会话，请稍后再试。", 410);
  if (opened === "failed") throw new ChatSendError("control_unavailable", "没能打开这个会话，请稍后再试。");
  // The old conversation's composer lingers until the site re-renders.
  if (opened === "switched") await delay(switchMs);
  const editor = page.locator(EDITOR);
  const button = page.locator(SEND_BUTTON);
  await editor.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  if (await editor.count() !== 1 || await button.count() !== 1) {
    throw await pageNeedsVerification(page)
      ? new ChatSendError("verification_required", "抖音要求先完成安全验证。请用「手动监听」打开抖音，验证完再回来发送。")
      : new ChatSendError("control_unavailable", "没找到抖音的输入框，请稍后再试。");
  }
  const before = await page.evaluate(ownMessages, conversationId);
  if (!before) throw new ChatSendError("control_unavailable", "会话刚被切走了，请重新发送。");
  const clear = async () => {
    await editor.click({ timeout: 3_000 });
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.press("Backspace");
  };
  // Replace whatever is in the box: a draft the site restored would go out too.
  await clear();
  for (const [index, line] of text.split("\n").entries()) {
    if (index) await page.keyboard.press("Shift+Enter");
    if (line) await page.keyboard.insertText(line);
  }
  const typed = await editor.evaluate(editorText);
  const current = await page.evaluate(() => globalThis.conversationStore?.curConversationId);
  if (typed !== text || current !== conversationId) {
    await clear().catch(() => {});
    throw new ChatSendError("input_mismatch", "输入框里的内容和要发的对不上，这次没有发送。");
  }

  // From the click on, never throw: the message may already be on its way.
  const known = new Set(before.map((message) => message.clientId));
  await button.click({ timeout: 3_000 }).catch(() => {});
  const started = Date.now();
  let sent = null;
  while (Date.now() - started < timeoutMs) {
    const own = await page.evaluate(ownMessages, conversationId).catch(() => null);
    sent = own?.findLast((message) => !known.has(message.clientId) && message.text?.trim() === text.trim()) ?? sent;
    if (sent && DELIVERED.has(sent.status) && /^[1-9]\d*$/u.test(sent.serverId)) {
      return { outcome: "confirmed", message: "已发送", chatMessage: sentChatMessage(conversationId, text, sent, group) };
    }
    if (sent?.status === -3) return rejected("这条消息没通过抖音审核，只有你自己能看到。");
    if (sent?.status === -2) return rejected(sent.check || "抖音没有接收这条消息。");
    if (sent?.status === -1) return rejected("消息没发出去，可能是网络或登录状态有问题，稍后再试。");
    // The site empties the box before sending; text still there means it never started.
    if (!sent && Date.now() - started >= settleMs && await editor.evaluate(editorText).catch(() => null) === text) {
      await clear().catch(() => {});
      return rejected("抖音没有响应发送，这条消息没发出去。");
    }
    await delay(pollMs);
  }
  return { outcome: "unknown", message: "还没确认到发送结果，先在手机上看一眼，再决定要不要重发。" };
}

// A group message is typed as such so the store keeps its rule of never saving group text.
function sentChatMessage(conversationId, text, sent, group) {
  return normalizeChatPayload({ msgs: [{
    server_id: sent.serverId,
    sender_uid: sent.sender || null,
    type_code: 7,
    created_at: sent.sentAt ?? Date.now(),
    content_json: { text, aweType: 700 },
  }] }, { conversationId, conversationType: group ? 2 : 1 }).messages[0] ?? null;
}
