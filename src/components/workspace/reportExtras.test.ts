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
});
