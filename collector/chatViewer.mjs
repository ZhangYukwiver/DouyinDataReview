import { setTimeout as delay } from "node:timers/promises";
import { normalizeChatPayload } from "./chatNormalizer.mjs";
import { ChatSendError, openConversation } from "./chatSender.mjs";

// Read what the site's chat page already holds. Streaks come from each conversation's
// server ext; messages from the SDK's own list, which the site pages by itself when its
// message list is scrolled up (about 50 per page). Nothing here is written to disk.

// Runs in the page.
function readStreakData() {
  const rows = [];
  for (const conversation of globalThis.conversationStore?.conversationMap?.values() ?? []) {
    const raw = conversation?.coreInfo?.ext?.["a:consecutive_chat_data"];
    if (typeof raw === "string" && raw.length < 20_000) rows.push([String(conversation.id), raw]);
  }
  return rows;
}

const STREAK_STATES = new Set([1, 2, 3, 4]);
const clean = (value, limit = 40) => typeof value === "string" ? value.trim().slice(0, limit) : "";

/** One entry per conversation: the site's day windows (unix seconds), state 1 lit, 2 gray (not renewed yet), 3 reigniting, 4 gone. */
export function normalizeStreaks(rows) {
  const streaks = [];
  for (const [conversationId, raw] of Array.isArray(rows) ? rows.slice(0, 2_000) : []) {
    if (typeof conversationId !== "string" || !/^[\w:.-]{1,200}$/u.test(conversationId)) continue;
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const windows = (Array.isArray(data?.flame_infos) ? data.flame_infos : []).slice(0, 30).flatMap((info) => {
      const start = Number(info?.start), end = Number(info?.end), days = Number(info?.real_days ?? info?.days), state = Number(info?.state);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(days) || days < 0 || !STREAK_STATES.has(state)) return [];
      return [{ start, end, days: Math.min(Math.round(days), 100_000), state, text: clean(info.text) }];
    });
    if (windows.length) streaks.push({ conversationId, windows });
  }
  return streaks;
}

// Runs in the page: group nicknames come from the member list, the rest from the site's user cache.
function readLoadedMessages(id) {
  const conversation = globalThis.conversationStore?.conversationMap?.get(id);
  if (!conversation) return null;
  const aliases = new Map((conversation.getParticipantList?.() ?? []).map((member) => [String(member.userId), member.alias || ""]));
  const users = globalThis.userInfoStore;
  const list = conversation.getMessageList(() => true);
  const messages = list.slice(-1_000).map((message) => {
    let user = null;
    try { user = message.secSender ? users?.getUserBySecUid?.(message.secSender) : null; } catch { user = null; }
    let content = null;
    try { content = JSON.parse(message.content); } catch { content = null; }
    return {
      server_id: String(message.serverId ?? ""),
      sender_uid: String(message.sender ?? ""),
      sender_name: aliases.get(String(message.sender)) || user?.remark_name || user?.nickname || null,
      sender_avatar_url: user?.avatar_thumb?.url_list?.[0] ?? null,
      created_at: Number(message.createdAt) || null,
      type_code: message.type,
      content_json: content,
    };
  });
  const oldest = Number(list[0]?.indexInConversation);
  const floor = Number(conversation.minIndex);
  return { messages, group: conversation.type !== 1, hasMore: Number.isFinite(oldest) && Number.isFinite(floor) ? oldest > floor : false };
}

// Runs in the page: the tallest scrollable area right of the conversation list is the message list.
function messageListBox() {
  const nodes = [...document.querySelectorAll("div")].filter((node) => node.scrollHeight > node.clientHeight + 50
    && /auto|scroll/u.test(getComputedStyle(node).overflowY) && node.getBoundingClientRect().left > 200);
  const list = nodes.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
  if (!list) return null;
  const rect = list.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, height: list.scrollHeight };
}

export async function readChatStreaks(page) {
  return normalizeStreaks(await page.evaluate(readStreakData));
}

/**
 * Latest: the messages the site already holds (it keeps the newest ~20 per conversation), no switching.
 * Older: open the conversation in the site and wheel its list up like a person would, until one more page arrives.
 */
export async function loadChatMessages(page, { conversationId, older = false }, { wheelMs = 600, attempts = 10, switchMs = 800 } = {}) {
  if (typeof conversationId !== "string" || !/^[\w:.-]{1,200}$/u.test(conversationId)) throw new ChatSendError("invalid_request", "请先选一个会话。", 400);
  let loaded = await page.evaluate(readLoadedMessages, conversationId);
  if (!loaded) throw new ChatSendError("conversation_unavailable", "抖音网页里暂时找不到这个会话，请稍后再试。", 410);
  if (older && loaded.hasMore) {
    const before = loaded.messages.length;
    const { state } = await page.evaluate(openConversation, conversationId);
    if (state === "failed") throw new ChatSendError("control_unavailable", "没能打开这个会话，请稍后再试。");
    if (state === "switched") await delay(switchMs);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      loaded = await page.evaluate(readLoadedMessages, conversationId) ?? loaded;
      if (loaded.messages.length > before || !loaded.hasMore) break;
      const box = await page.evaluate(messageListBox);
      if (!box) { await delay(wheelMs); continue; }
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel(0, -(box.height + 2_000));
      await delay(wheelMs);
    }
  }
  const messages = normalizeChatPayload({ msgs: loaded.messages }, { conversationId, conversationType: loaded.group ? 2 : 1 }).messages;
  return { conversationId, messages, hasMore: loaded.hasMore };
}
