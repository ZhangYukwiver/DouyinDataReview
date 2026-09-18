export type ChatMessageType =
  | "text"
  | "image"
  | "sticker"
  | "share"
  | "comment"
  | "call"
  | "system"
  | "voice"
  | "video"
  | "unknown";

export type ChatConversationKind = "friend" | "group" | "unknown";

export interface ChatShare {
  title: string | null;
  author: string | null;
  coverUrl: string | null;
  url: string | null;
}

/** A video comment forwarded into a conversation; its author is not the sender. */
export interface ChatComment {
  id: string | null;
  author: string | null;
  text: string | null;
  mediaUrl: string | null;
  mediaType: "image" | "sticker" | "video" | null;
  sourceType?: "video" | "image" | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string | null;
  /** 群聊正文不会落盘；该字段用于把群聊和好友对话分开。 */
  conversationType?: ChatConversationKind;
  conversationName: string | null;
  senderId: string | null;
  senderName: string | null;
  /** 联系人资料中的头像地址；可选，旧消息快照不会有该字段。 */
  senderAvatarUrl?: string | null;
  sentAt: string | null;
  type: ChatMessageType;
  text: string | null;
  mediaUrl: string | null;
  share: ChatShare | null;
  /** Comment-specific fields, absent in older snapshots. `share` holds the source video. */
  comment?: ChatComment | null;
  /** 通话时长（秒）；接口未提供时保持 null，不从相邻消息时间推断。 */
  callDurationSeconds: number | null;
}

export interface ChatConversationSummary {
  id: string;
  kind: ChatConversationKind;
  name: string | null;
  /** 联系人/群聊头像地址；旧快照可能没有该字段。 */
  avatarUrl?: string | null;
  /** 抖音在线状态按这个 id 下发，只有单聊才有。 */
  secUid?: string | null;
  /** 对方最后活跃的时刻，来自抖音自己的在线状态接口；旧快照没有。 */
  lastActiveAt?: string | null;
  messageCount: number;
  ownMessageCount: number;
}

/**
 * A share card is useful only when the collector found at least one piece of
 * share-specific metadata.  Some IM payloads carry a generic `title` next to
 * an `aweType`; treating that title alone as a share creates a misleading
 * video card for an ordinary text message.
 */
export function hasChatShareEvidence(share: ChatShare | null | undefined): boolean {
  return Boolean(share?.author || share?.coverUrl || share?.url);
}

export function countChatMessages(messages: readonly ChatMessage[], conversations: readonly ChatConversationSummary[] = []): number {
  const groupIds = new Set(conversations.filter((conversation) => conversation.kind === "group").map((conversation) => conversation.id));
  const groupCount = conversations
    .filter((conversation) => conversation.kind === "group")
    .reduce((total, conversation) => total + conversation.messageCount, 0);
  return messages.filter((message) => message.conversationType !== "group" && (!message.conversationId || !groupIds.has(message.conversationId))).length + groupCount;
}

export function formatChatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "通话时长未提供";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return minutes > 0 ? `${minutes}分${remaining}秒` : `${remaining}秒`;
}
