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
  /** 近七天（含今天）：每天的观看 / 聊天 / 留存条数，这周常聊的人、常看的博主，和这周发了新视频的博主。 */
  week: {
    days: Array<{ label: string; watch: number; chat: number; kept: number }>;
    contacts: WeekPerson[];
    creators: WeekPerson[];
    updates: Array<{ name: string; avatarUrl: string | null; videos: Array<{ title: string; coverUrl: string | null; url: string | null; publishedAt: string }> }>;
  };
}

export interface WeekPerson { id: string; name: string; avatarUrl: string | null; count: number }

/** 持续报告里那些「看得见的东西」：常聊的人、常用表情、最近的封面、创作者头像、留下来的封面、近七天。 */
export function buildDashboardExtras(
  records: PersonalRecordCollection,
  chatMessages: readonly ChatMessage[],
  chatConversations: readonly ChatConversationSummary[],
  now = Date.now(),
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
  const keyOf = (record: PersonalRecordCollection["watch_history"][number]) => record.videoId ?? record.id;
  const newest = [...records.watch_history].sort((left, right) => time(right.occurredAt) - time(left.occurredAt));
  const distinct = (list: typeof newest) => {
    const seen = new Set<string>();
    return list.filter((record) => !seen.has(keyOf(record)) && Boolean(seen.add(keyOf(record))));
  };
  const coverRecords = distinct(newest.filter((record) => record.coverUrl)).slice(0, 6);
  const covers = coverRecords.map((record) => ({ title: record.title, coverUrl: record.coverUrl!, url: record.url }));

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

  // 按本地日历日分桶：从六天前的零点到现在；用 setDate 逐日推，夏令时那天也不会错位
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return { label: index === 6 ? "今天" : `${day.getMonth() + 1}/${day.getDate()}`, watch: 0, chat: 0, kept: 0 };
  });
  const dayOf = (value: string | null) => {
    const at = time(value);
    if (at < start.getTime() || at > now) return -1;
    const day = new Date(at);
    day.setHours(0, 0, 0, 0);
    return Math.round((day.getTime() - start.getTime()) / 86_400_000);
  };
  const count = (value: string | null, kind: "watch" | "chat" | "kept") => {
    const index = dayOf(value);
    if (index >= 0 && index < 7) days[index]![kind] += 1;
    return index >= 0;
  };
  // 这周常聊：和报告模型一样只数单聊（群聊正文不落盘）
  const conversations = new Map(chatConversations.map((conversation) => [conversation.id, conversation]));
  const chatsBy = new Map<string, WeekPerson>();
  for (const message of chatMessages) {
    const conversation = message.conversationId ? conversations.get(message.conversationId) : undefined;
    if (message.conversationType === "group" || conversation?.kind === "group" || !count(message.sentAt, "chat") || !message.conversationId) continue;
    const entry = chatsBy.get(message.conversationId)
      ?? { id: message.conversationId, name: conversation?.name ?? message.conversationName ?? "", avatarUrl: conversation?.avatarUrl ?? null, count: 0 };
    entry.count += 1;
    chatsBy.set(message.conversationId, entry);
  }
  for (const record of [...records.liked_videos, ...records.favorite_videos]) count(record.occurredAt, "kept");

  // 这周常看的博主
  const creatorsBy = new Map<string, WeekPerson>();
  for (const record of records.watch_history) {
    if (!count(record.occurredAt, "watch") || !record.author) continue;
    const id = record.authorId ?? record.author;
    const entry = creatorsBy.get(id) ?? { id, name: record.author, avatarUrl: null, count: 0 };
    entry.avatarUrl ??= record.authorAvatarUrl ?? null;
    entry.count += 1;
    creatorsBy.set(id, entry);
  }

  // 博主更新：发布时间落在这七天里的视频，按博主归拢。只认得出看过、点过赞或收藏过的那些，
  // ponytail: 关注列表里没刷到的新作看不到，要全量得另去拉关注的人的作品流
  type Update = DashboardExtras["week"]["updates"][number];
  const updatesBy = new Map<string, Update>();
  const seenVideos = new Set<string>();
  for (const record of [...newest, ...records.liked_videos, ...records.favorite_videos]) {
    const published = time(record.publishedAt ?? null);
    if (!record.author || published < start.getTime() || published > now || seenVideos.has(keyOf(record))) continue;
    seenVideos.add(keyOf(record));
    const id = record.authorId ?? record.author;
    const entry = updatesBy.get(id) ?? { name: record.author, avatarUrl: null, videos: [] };
    entry.avatarUrl ??= record.authorAvatarUrl ?? null;
    entry.videos.push({ title: record.title, coverUrl: record.coverUrl ?? null, url: record.url, publishedAt: record.publishedAt! });
    updatesBy.set(id, entry);
  }
  const latest = (update: Update) => Math.max(...update.videos.map((video) => time(video.publishedAt)));
  const updates = [...updatesBy.values()]
    .sort((left, right) => right.videos.length - left.videos.length || latest(right) - latest(left))
    .slice(0, 4)
    .map((update) => ({ ...update, videos: update.videos.sort((left, right) => time(right.publishedAt) - time(left.publishedAt)) }));
  const top = (people: Map<string, WeekPerson>) => [...people.values()].sort((left, right) => right.count - left.count).slice(0, 4);

  return { contacts, emojis, covers, creatorAvatars, keptCovers: [...new Set(keptCovers)].slice(0, 4), week: { days, contacts: top(chatsBy), creators: top(creatorsBy), updates } };
}
