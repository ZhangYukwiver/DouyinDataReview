import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./chatRecords";
import { buildSparks, shiftDay, sparkDayKey } from "./chatSparks";

// 本地时间 9 月 17 日晚上 9 点
const now = new Date(2026, 8, 17, 21, 0);

let sequence = 0;
function sent(daysAgo: number, senderId: string | null, type: ChatMessage["type"] = "text", at?: Date): ChatMessage {
  sequence += 1;
  return {
    id: `m${sequence}`,
    conversationId: "c",
    conversationType: "friend",
    conversationName: null,
    senderId,
    senderName: null,
    sentAt: (at ?? new Date(2026, 8, 17 - daysAgo, 10 + (sequence % 8))).toISOString(),
    type,
    text: "在吗",
    mediaUrl: null,
    share: null,
    callDurationSeconds: null,
  };
}

const both = (...daysAgo: number[]) => daysAgo.flatMap((day) => [sent(day, "me"), sent(day, "friend")]);
const spark = (messages: ChatMessage[], selfId: string | null = "me") => buildSparks([{ id: "c", messages }], selfId, now)[0] ?? null;

describe("buildSparks", () => {
  it("counts a streak that already continued today", () => {
    expect(spark(both(0, 1, 2))).toMatchObject({ state: "done", days: 3, today: "both", brokeOn: null });
  });

  it("keeps yesterday's streak pending and knows who still has to send", () => {
    expect(spark([...both(1, 2, 3, 4), sent(0, "friend")])).toMatchObject({ state: "pending", days: 4, today: "theirs" });
    expect(spark([...both(1), sent(0, "me")])).toMatchObject({ state: "pending", days: 1, today: "mine" });
    expect(spark([...both(1), sent(0, "friend")], null)).toMatchObject({ state: "pending", today: "one" });
    expect(spark(both(1))).toMatchObject({ state: "pending", today: "none" });
  });

  it("lists a lit streak that broke within the last week with the day it broke", () => {
    expect(spark(both(3, 4, 5, 6, 7))).toMatchObject({ state: "broken", days: 5, brokeOn: "2026-09-15" });
  });

  it("drops breaks that were never lit or are older than a week, and one-sided streaks", () => {
    expect(spark(both(3, 4))).toBeNull();
    expect(spark(both(9, 10, 11, 12))).toBeNull();
    expect(spark([0, 1, 2, 3].map((day) => sent(day, "me")))).toBeNull();
  });

  it("ignores system notices and messages without a sender or a time", () => {
    const noise = [0, 1, 2].flatMap((day) => [sent(day, "me"), sent(day, "friend", "system"), sent(day, null)]);
    noise.push({ ...sent(0, "friend"), sentAt: null });
    expect(spark(noise)).toBeNull();
  });

  it("splits days at local midnight and reports the last two weeks oldest first", () => {
    // 23:30 和第二天 00:30 是两天，各只有一方发过
    expect(spark([sent(1, "me", "text", new Date(2026, 8, 16, 23, 30)), sent(0, "friend", "text", new Date(2026, 8, 17, 0, 30))])).toBeNull();

    const result = spark([...both(0), sent(13, "friend")]);
    expect(result?.recent).toHaveLength(14);
    expect(result?.recent[0]).toBe("theirs");
    expect(result?.recent[13]).toBe("both");
    expect(sparkDayKey(shiftDay(new Date(2026, 8, 1, 0, 5), -1))).toBe("2026-08-31");
  });

  it("puts the longest streaks first", () => {
    const sparks = buildSparks([
      { id: "short", messages: both(0) },
      { id: "long", messages: both(0, 1, 2, 3) },
    ], "me", now);
    expect(sparks.map((item) => [item.id, item.days])).toEqual([["long", 4], ["short", 1]]);
  });
});
