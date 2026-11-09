import { buildDataExport } from "./exportData";
import type { CollectorSnapshot } from "./localCollector";
import type { ChatConversationSummary, ChatMessage } from "../domain/chatRecords";

/** Select by immutable conversation ID, never by nickname or visible list size. */
export function buildConversationExport(conversation: ChatConversationSummary, messages: readonly ChatMessage[]) {
  if (conversation.kind !== "friend") throw new Error("仅支持导出好友的本地聊天记录。");
  const selected = messages.filter(message => message.conversationId === conversation.id && message.conversationType !== "group");
  if (!selected.length) throw new Error("这个好友还没有本地聊天记录。");
  const snapshot: CollectorSnapshot = {
    schemaVersion: 2, warnings: [],
    records: { watch_history: [], liked_videos: [], favorite_videos: [] },
    chatConversations: [{ ...conversation, messageCount: selected.length }],
    chatMessages: selected,
    updatedAt: null,
  };
  const data = buildDataExport(snapshot, { chat: true });
  data.warnings.push("仅包含此好友已保存的本地消息，不保证完整历史；媒体保留链接，未下载媒体或执行语音转写。");
  return data;
}

export function conversationText(data: ReturnType<typeof buildConversationExport>, selfId: string | null): string {
  const lines = [data.chatConversations[0]?.name ?? "好友聊天", ...data.warnings, ""];
  for (const message of data.chatMessages) {
    const own = selfId && message.senderId === selfId;
    const sender = own ? "我" : message.senderName || "对方";
    lines.push(`[${message.sentAt ?? "时间未提供"}] ${sender}`);
    lines.push(message.text || `[${message.type}]`);
    if (message.share?.title) lines.push(message.share.title);
    if (message.share?.url) lines.push(message.share.url);
    if (message.mediaUrl) lines.push(message.mediaUrl);
    lines.push("");
  }
  return lines.join("\r\n");
}

export function conversationExportName(name: string | null, extension: "json" | "txt"): string {
  const safe = (name || "好友聊天").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 60) || "好友聊天";
  return `抖音聊天_${safe}_${new Date().toISOString().slice(0, 10)}.${extension}`;
}

export function saveConversationExport(data: ReturnType<typeof buildConversationExport>, selfId: string | null, format: "json" | "txt"): void {
  const text = format === "json" ? JSON.stringify(data, null, 2) : "\uFEFF" + conversationText(data, selfId);
  const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" }));
  try {
    const link = Object.assign(document.createElement("a"), { href: url, download: conversationExportName(data.chatConversations[0]?.name ?? null, format) });
    document.body.append(link);
    link.click();
    link.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}
