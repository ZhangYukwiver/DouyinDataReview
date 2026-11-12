import { describe, expect, it } from "vitest";

import { CHAT_EMOJI } from "../../domain/chatEmoji";
import type { ChatConversationSummary, ChatMessage } from "../../domain/chatRecords";
import type { PersonalVideoRecord } from "../../domain/personalRecords";
import { buildDashboardExtras } from "./reportExtras";

const video = (id: string, extra: Partial<PersonalVideoRecord> = {}): PersonalVideoRecord =>
  ({ id, title: `视频${id}`, author: null, occurredAt: null, url: null, ...extra }) as PersonalVideoRecord;
const message = (text: string | null): ChatMessage => ({ text } as ChatMessage);
const conversation = (id: string, kind: "friend" | "group", messageCount: number): ChatConversationSummary =>
  ({ id, kind, name: id, messageCount, ownMessageCount: 1 }) as ChatConversationSummary;

describe("持续报告的头像、表情和封面", () => {
  const [smile, color] = [CHAT_EMOJI[0]![0], CHAT_EMOJI[1]![0]];

  it("常聊只看单聊、按消息数排；表情按出现次数排", () => {
    const extras = buildDashboardExtras(
      { watch_history: [], liked_videos: [], favorite_videos: [] },
      [message(`${smile}${smile}好`), message(`${color}`), message(`${smile} [不存在的表情]`), message(null)],
      [conversation("a", "friend", 3), conversation("g", "group", 99), conversation("b", "friend", 8), conversation("z", "friend", 0)],
    );
    expect(extras.contacts.map((contact) => contact.id)).toEqual(["b", "a"]);
    expect(extras.emojis.map((emoji) => [emoji.code, emoji.count])).toEqual([[smile, 3], [color, 1]]);
  });

  it("封面按时间倒序、同一视频只留一次；留下的封面先取又赞又藏的", () => {
    const extras = buildDashboardExtras(
      {
        watch_history: [
          video("1", { videoId: "v1", coverUrl: "c1", occurredAt: "2026-01-01T00:00:00Z", author: "甲", authorAvatarUrl: "a1" }),
          video("2", { videoId: "v2", coverUrl: "c2", occurredAt: "2026-03-01T00:00:00Z", author: "甲", authorAvatarUrl: "a2" }),
          video("3", { videoId: "v1", coverUrl: "c1", occurredAt: "2026-02-01T00:00:00Z" }),
          video("4", { occurredAt: "2026-04-01T00:00:00Z" }),
        ],
        liked_videos: [video("l1", { videoId: "x", coverUrl: "only-liked" }), video("l2", { videoId: "y", coverUrl: "both" })],
        favorite_videos: [video("f1", { videoId: "y", coverUrl: "both" })],
      },
      [],
      [],
    );
    expect(extras.covers.map((cover) => cover.coverUrl)).toEqual(["c2", "c1"]);
    expect(extras.creatorAvatars).toEqual({ 甲: "a1" });
    expect(extras.keptCovers).toEqual(["both", "only-liked"]);
  });

  it("近七天：按本地日分桶，七天前和群聊不算；常聊、常看按这周的次数排；博主更新按发布时间归拢", () => {
    const now = new Date(2026, 10, 11, 12).getTime();
    const chat = (sentAt: string, conversationId: string, conversationType?: "group") => ({ sentAt, conversationId, conversationType } as ChatMessage);
    const extras = buildDashboardExtras(
      {
        watch_history: [
          video("1", { videoId: "v1", occurredAt: "2026-11-05T00:30:00", author: "甲", publishedAt: "2026-11-09T10:00:00" }),
          video("2", { videoId: "v1", occurredAt: "2026-11-11T09:00:00", author: "甲", publishedAt: "2026-11-09T10:00:00" }),
          video("3", { videoId: "v2", occurredAt: "2026-11-10T09:00:00", author: "乙", authorAvatarUrl: "a乙", publishedAt: "2026-11-10T08:00:00" }),
          video("4", { videoId: "v3", occurredAt: "2026-11-04T23:59:00", author: "乙", publishedAt: "2026-10-01T08:00:00" }),
          video("5", { videoId: "v4", occurredAt: null, author: "乙" }),
        ],
        liked_videos: [video("l1", { videoId: "v5", occurredAt: "2026-11-11T08:00:00", author: "甲", publishedAt: "2026-11-11T07:00:00" })],
        favorite_videos: [],
      },
      [
        chat("2026-11-10T20:00:00", "a"), chat("2026-11-09T20:00:00", "b"), chat("2026-11-10T22:00:00", "b"),
        chat("2026-11-10T21:00:00", "g", "group"), chat("2026-11-01T20:00:00", "a"),
      ],
      [conversation("a", "friend", 5), { ...conversation("b", "friend", 5), name: "小雨", avatarUrl: "a小雨" } as ChatConversationSummary],
      now,
    );
    expect(extras.week.days.map((day) => day.label)).toEqual(["11/5", "11/6", "11/7", "11/8", "11/9", "11/10", "今天"]);
    expect(extras.week.days.map((day) => [day.watch, day.chat, day.kept])).toEqual([[1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0], [1, 2, 0], [1, 0, 1]]);
    expect(extras.week.contacts.map((person) => [person.name, person.avatarUrl, person.count])).toEqual([["小雨", "a小雨", 2], ["a", null, 1]]);
    expect(extras.week.creators.map((person) => [person.name, person.count])).toEqual([["甲", 2], ["乙", 1]]);
    expect(extras.week.updates.map((update) => [update.name, update.videos.map((item) => item.title)])).toEqual([["甲", ["视频l1", "视频2"]], ["乙", ["视频3"]]]);
  });
});
