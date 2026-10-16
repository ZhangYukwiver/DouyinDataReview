import { splitChatEmoji } from "../../domain/chatEmoji";
import type { ChatConversationSummary, ChatMessage } from "../../domain/chatRecords";
import type { PersonalRecordCollection } from "../../domain/personalRecords";

export interface DashboardExtras {
  /** 单聊里消息最多的几位。 */
  contacts: Array<{ id: string; name: string; avatarUrl: string | null; messages: number; own: number }>;
  /** 聊天文字里出现最多的抖音小表情。 */
  emojis: Array<{ code: string; url: string; count: number }>;
  /** 最近看过、带封面的几条（同一个视频只留一次）。 */
  covers: Array<{ title: string; coverUrl: string; url: string | null }>;
  /** 作者名 → 头像地址，取第一次见到的那张。 */
  creatorAvatars: Record<string, string>;
  /** 又点赞又收藏的视频封面，不够再用点赞、收藏补。 */
  keptCovers: string[];
}

/** 持续报告里那些「看得见的东西」：常聊的人、常用表情、最近的封面、创作者头像、留下来的封面。 */
export function buildDashboardExtras(
  records: PersonalRecordCollection,
  chatMessages: readonly ChatMessage[],
  chatConversations: readonly ChatConversationSummary[],
): DashboardExtras {
  const contacts = chatConversations
    .filter((conversation) => conversation.kind === "friend" && conversation.messageCount > 0)
    .sort((left, right) => right.messageCount - left.messageCount)
    .slice(0, 5)
    .map((conversation) => ({
      id: conversation.id,
      name: conversation.name ?? "",
      avatarUrl: conversation.avatarUrl ?? null,
      messages: conversation.messageCount,
      own: conversation.ownMessageCount,
    }));

  const emojiCounts = new Map<string, { code: string; url: string; count: number }>();
  for (const message of chatMessages) {
    if (!message.text || !message.text.includes("[")) continue;
    for (const part of splitChatEmoji(message.text)) {
      if (!("emoji" in part)) continue;
      const entry = emojiCounts.get(part.emoji) ?? { code: part.emoji, url: part.url, count: 0 };
      entry.count += 1;
      emojiCounts.set(part.emoji, entry);
    }
  }
  const emojis = [...emojiCounts.values()].sort((left, right) => right.count - left.count).slice(0, 12);

  const time = (value: string | null) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const seen = new Set<string>();
  const covers = records.watch_history
    .filter((record) => record.coverUrl)
    .sort((left, right) => time(right.occurredAt) - time(left.occurredAt))
    .filter((record) => {
      const key = record.videoId ?? record.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6)
    .map((record) => ({ title: record.title, coverUrl: record.coverUrl!, url: record.url }));

  const creatorAvatars: Record<string, string> = {};
  for (const record of records.watch_history) {
    if (record.author && record.authorAvatarUrl && !creatorAvatars[record.author]) creatorAvatars[record.author] = record.authorAvatarUrl;
  }

  const favorites = new Set(records.favorite_videos.map((record) => record.videoId).filter(Boolean));
  const keptCovers = [
    ...records.liked_videos.filter((record) => record.videoId && favorites.has(record.videoId)),
    ...records.liked_videos,
    ...records.favorite_videos,
  ].map((record) => record.coverUrl).filter((url): url is string => Boolean(url));

  return { contacts, emojis, covers, creatorAvatars, keptCovers: [...new Set(keptCovers)].slice(0, 4) };
}
