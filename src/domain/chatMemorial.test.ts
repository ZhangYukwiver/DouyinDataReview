import { describe, expect, it } from "vitest";
import { buildChatMemorial, scrubMemorial } from "./chatMemorial";
import type { ChatMessage } from "./chatRecords";
import type { Spark } from "./chatSparks";

const ME = "me";
let seq = 0;
function msg(sender: string, local: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`, conversationId: "c", conversationName: "小周", senderId: sender, senderName: null,
    sentAt: new Date(local).toISOString(), type: "text", text: "在吗", mediaUrl: null, share: null, callDurationSeconds: null, ...patch,
  };
}
const friend = (messages: ChatMessage[]) => ({ id: "c", kind: "friend" as const, name: "小周", messages, messageCount: messages.length, ownMessageCount: 0 });
const now = new Date("2026-10-04T15:00:00");

describe("buildChatMemorial", () => {
  it("counts both sides, mutual days and the longest run of days both sent", () => {
    const messages = [
      msg(ME, "2026-09-01T10:00:00", { text: "第一句话 [捂脸]" }),
      msg("ta", "2026-09-01T11:00:00", { text: "哈哈哈哈 [捂脸]" }),
      msg(ME, "2026-09-02T10:00:00", { type: "share", text: null }),
      msg("ta", "2026-09-02T22:00:00"),
      msg("ta", "2026-09-03T09:00:00"),
      msg(ME, "2026-09-05T10:00:00"),
      msg("ta", "2026-09-05T10:01:00"),
      msg("sys", "2026-09-05T10:02:00", { type: "system" }),
    ];
    const memorial = buildChatMemorial(friend(messages), ME, null, now);
    expect(memorial).toMatchObject({ total: 7, mine: 3, theirs: 4, activeDays: 4, mutualDays: 3, sinceDays: 34, sample: null });
    expect(memorial.longestRun).toEqual({ days: 2, start: "2026-09-01", end: "2026-09-02" });
    expect(memorial.days.map((day) => day.who)).toEqual(["both", "both", "theirs", "both"]);
    expect(memorial.firstLine).toMatchObject({ text: "第一句话 [捂脸]", mine: true });
    expect(memorial.topEmoji).toEqual([{ code: "[捂脸]", count: 2 }]);
    expect(memorial.shares).toEqual({ mine: 1, theirs: 0 });
    expect(memorial.peakHour).toBe(10);
    expect(memorial.busiestDay).toEqual({ date: "2026-09-01", count: 2 });
  });

  it("treats anything before 5am as later than midnight", () => {
    const memorial = buildChatMemorial(friend([msg(ME, "2026-09-01T23:50:00"), msg("ta", "2026-09-02T02:10:00"), msg(ME, "2026-09-02T05:30:00")]), ME, null, now);
    expect(new Date(memorial.latest!).getHours()).toBe(2);
  });

  it("keeps words that repeat and drops filler words", () => {
    const memorial = buildChatMemorial(friend([
      msg(ME, "2026-09-01T10:00:00", { text: "周末去爬山吧 就是 就是" }),
      msg("ta", "2026-09-01T11:00:00", { text: "爬山好啊，周末见" }),
      msg("ta", "2026-09-01T12:00:00", { text: "https://www.douyin.com/video/123 周末" }),
    ]), ME, null, now);
    expect(memorial.topWords[0]).toEqual({ word: "周末", count: 3 });
    expect(memorial.topWords.map((word) => word.word)).not.toContain("就是");
    expect(memorial.topWords.map((word) => word.word)).not.toContain("douyin");
  });

  it("only shows sparks that are lit, reigniting or recently broken", () => {
    const spark = (patch: Partial<Spark>): Spark => ({ id: "c", state: "done", days: 2, brokeOn: null, today: "both", recent: [], ...patch });
    const messages = [msg(ME, "2026-10-04T10:00:00"), msg("ta", "2026-10-04T11:00:00")];
    expect(buildChatMemorial(friend(messages), ME, spark({}), now).spark).toBeNull();
    expect(buildChatMemorial(friend(messages), ME, spark({ days: 5 }), now).spark).toMatchObject({ days: 5, text: "5", official: false });
    expect(buildChatMemorial(friend(messages), ME, spark({ state: "recover", days: 789, official: "重燃中 2/3" }), now).spark).toMatchObject({ text: "重燃中 2/3", official: true });
  });

  it("uses the collected totals for groups and keeps other people's words off the card", () => {
    const live = [msg("a", "2026-10-04T21:00:00", { text: "周末周末" }), msg(ME, "2026-10-04T21:05:00", { text: "周末周末" })];
    const memorial = buildChatMemorial({ id: "g", kind: "group", name: "视频鉴赏", messages: live, messageCount: 3366, ownMessageCount: 5 }, ME, null, now);
    expect(memorial).toMatchObject({ total: 3366, mine: 5, theirs: 3361, sample: 2, peakHour: 21, firstAt: null, sinceDays: null, activeDays: null, topWords: [], firstLine: null, days: [], busiestDay: null });
  });

  it("never lets the collected group totals fall below what was just read live", () => {
    const live = [msg(ME, "2026-10-04T21:00:00"), msg(ME, "2026-10-04T21:01:00"), msg("a", "2026-10-04T21:02:00")];
    expect(buildChatMemorial({ id: "g", kind: "group", name: "群", messages: live, messageCount: 0, ownMessageCount: 0 }, ME, null, now)).toMatchObject({ total: 3, mine: 2, theirs: 1 });
  });

  it("does not count a message without a sender as the other side talking", () => {
    const memorial = buildChatMemorial(friend([msg(ME, "2026-10-03T10:00:00"), msg("", "2026-10-03T11:00:00", { senderId: null, type: "unknown" })]), ME, null, now);
    expect(memorial.days).toEqual([{ date: "2026-10-03", who: "mine", count: 2 }]);
    expect(memorial.mutualDays).toBe(0);
  });

  it("carries who already talked today onto the spark", () => {
    const spark: Spark = { id: "c", state: "pending", days: 9, brokeOn: null, today: "mine", recent: [] };
    expect(buildChatMemorial(friend([msg(ME, "2026-10-04T10:00:00")]), ME, spark, now).spark).toMatchObject({ today: "mine", days: 9 });
  });

  it("returns empty stats instead of crashing on a conversation with no usable messages", () => {
    const memorial = buildChatMemorial(friend([msg(ME, "2026-09-01T10:00:00", { sentAt: null }), msg("ta", "2026-09-01T10:00:00", { sentAt: "not a date" })]), ME, null, now);
    expect(memorial).toMatchObject({ total: 2, mine: 1, hours: null, peakHour: null, latest: null, firstAt: null, sinceDays: null, longestRun: null });
  });

  it("falls back to the collector's own-message count when it cannot tell who I am", () => {
    const messages = [msg("a", "2026-09-01T10:00:00"), msg("b", "2026-09-01T10:01:00"), msg("b", "2026-09-01T10:02:00"), msg("b", "2026-09-01T10:03:00")];
    expect(buildChatMemorial({ ...friend(messages), ownMessageCount: 1 }, null, null, now)).toMatchObject({ mine: 1, theirs: 3, selfKnown: true });
    // 全局把话多的对方认成了我，这个会话的条数对不上就改过来
    expect(buildChatMemorial({ ...friend([...messages, ...messages.slice(1), msg("a", "2026-09-01T11:00:00")]), ownMessageCount: 2 }, "b", null, now)).toMatchObject({ mine: 2, theirs: 6 });
    // 摘要比本机多一条（撤回之类）时，照旧信 selfId
    expect(buildChatMemorial({ ...friend(messages), ownMessageCount: 4 }, "b", null, now)).toMatchObject({ mine: 3, selfKnown: true });
    // 两个发送者离那个数一样近，就不猜：条数用采集器数的，第一句不说是谁
    const unknown = buildChatMemorial({ ...friend(messages), ownMessageCount: 2 }, null, null, now);
    expect(unknown).toMatchObject({ mine: 2, theirs: 2, selfKnown: false });
    expect(unknown.firstLine?.mine).toBeNull();
  });

  it("scrubs names and message text for privacy mode", () => {
    const memorial = scrubMemorial(buildChatMemorial(friend([msg(ME, "2026-09-01T10:00:00", { text: "周末 周末" })]), ME, null, now));
    expect(memorial).toMatchObject({ name: "好友", topWords: [], firstLine: null });
  });
});
