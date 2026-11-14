import { buildDataExport } from "./exportData";
import type { CollectorSnapshot } from "./localCollector";
import type { ChatConversationSummary, ChatMessage } from "../domain/chatRecords";

const pad = (value: number) => String(value).padStart(2, "0");
const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 文本是给人读的，按这台电脑的时区写；JSON 保留原始 UTC。 */
function localStamp(value: string | null): string {
  const date = new Date(value ?? NaN);
  if (!Number.isFinite(date.getTime())) return "时间未提供";
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Select by immutable conversation ID, never by nickname or visible list size.
 * 群聊的消息是调用方刚从抖音现读、按范围和成员挑好的（本机不存群消息），note 写明范围。
 */
export function buildConversationExport(conversation: ChatConversationSummary, messages: readonly ChatMessage[], note?: string) {
  const group = conversation.kind === "group";
  if (!group && conversation.kind !== "friend") throw new Error("仅支持导出好友和群聊的聊天记录。");
  const selected = messages.filter(message => message.conversationId === conversation.id && (group || message.conversationType !== "group"));
  if (!selected.length) throw new Error(group ? "这个范围里没有选中成员的消息。" : "这个好友还没有本地聊天记录。");
  const snapshot: CollectorSnapshot = {
    schemaVersion: 2, warnings: [],
    records: { watch_history: [], liked_videos: [], favorite_videos: [] },
    chatConversations: [{ ...conversation, messageCount: selected.length }],
    chatMessages: selected,
    updatedAt: null,
  };
  const data = buildDataExport(snapshot, { chat: true });
  data.warnings.push(note ?? "仅包含此好友已保存的本地消息，不保证完整历史；媒体保留链接，未下载媒体或执行语音转写。");
  return data;
}

export function conversationText(data: ReturnType<typeof buildConversationExport>, selfId: string | null): string {
  const group = data.chatConversations[0]?.kind === "group";
  const lines = [data.chatConversations[0]?.name ?? (group ? "群聊" : "好友聊天"), ...data.warnings, ""];
  for (const message of data.chatMessages) {
    const own = selfId && message.senderId === selfId;
    const sender = own ? "我" : message.senderName || (group ? "群成员" : "对方");
    lines.push(`[${localStamp(message.sentAt)}] ${sender}`);
    lines.push(message.text || `[${message.type}]`);
    if (message.share?.title) lines.push(message.share.title);
    if (message.share?.url) lines.push(message.share.url);
    if (message.mediaUrl) lines.push(message.mediaUrl);
    lines.push("");
  }
  return lines.join("\r\n");
}

export function conversationExportName(name: string | null, extension: "json" | "txt", fallback = "好友聊天"): string {
  const safe = (name || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 60) || fallback;
  return `抖音聊天_${safe}_${localDay(new Date())}.${extension}`;
}

export function saveConversationExport(data: ReturnType<typeof buildConversationExport>, selfId: string | null, format: "json" | "txt"): void {
  const text = format === "json" ? JSON.stringify(data, null, 2) : "\uFEFF" + conversationText(data, selfId);
  const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" }));
  try {
    const link = Object.assign(document.createElement("a"), { href: url, download: conversationExportName(data.chatConversations[0]?.name ?? null, format,
      data.chatConversations[0]?.kind === "group" ? "群聊" : "好友聊天") });
    document.body.append(link);
    link.click();
    link.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

/** 范围里每个发过言的人和条数，发得多的在前；名字取最近一条消息上的（改过群昵称以新的为准） */
export function groupSenders(messages: readonly ChatMessage[], selfId: string | null) {
  const senders = new Map<string, { id: string; name: string; count: number }>();
  for (const message of messages) {
    const id = message.senderId ?? "";
    const name = selfId && id === selfId ? "我" : message.senderName || (id ? "群成员" : "未知成员");
    const sender = senders.get(id);
    senders.set(id, { id, name: sender && !message.senderName ? sender.name : name, count: (sender?.count ?? 0) + 1 });
  }
  return [...senders.values()].sort((left, right) => right.count - left.count);
}
