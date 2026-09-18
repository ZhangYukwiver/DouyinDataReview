import type { ChatMessage } from "./chatRecords";

/** 某一天谁发过消息：both 双方都发过；mine / theirs 只有一方；one 只有一方但认不出是谁。 */
export type SparkDay = "both" | "mine" | "theirs" | "one" | "none";

export interface Spark {
  id: string;
  /** done：今天已续上；pending：连到昨天、今天还没续；broken：最近 7 天内断掉。 */
  state: "done" | "pending" | "broken";
  /** 连续互发的天数；broken 时是断掉之前那一段。 */
  days: number;
  /** broken 时没接上的那一天（本地日期 YYYY-MM-DD）。 */
  brokeOn: string | null;
  today: SparkDay;
  /** 最近 14 天，最早的在前。 */
  recent: SparkDay[];
}

// ponytail: 抖音没公开火花算法，这里按第三方整理的说法估算——同一天双方都发过消息算一天、
// 连续 3 天点亮、断一天清零。官方口径变了只需改这里。
export const SPARK_LIT_DAYS = 3;
const RECENT_DAYS = 14;
const BROKEN_WINDOW_DAYS = 7;

export function buildSparks(
  conversations: ReadonlyArray<{ id: string; messages: readonly ChatMessage[] }>,
  selfId: string | null,
  now: Date = new Date(),
): Spark[] {
  const sparks: Spark[] = [];
  for (const { id, messages } of conversations) {
    const spark = sparkFor(id, messages, selfId, now);
    if (spark) sparks.push(spark);
  }
  return sparks.sort((left, right) => right.days - left.days || left.id.localeCompare(right.id));
}

function sparkFor(id: string, messages: readonly ChatMessage[], selfId: string | null, now: Date): Spark | null {
  const sendersByDay = new Map<string, Set<string>>();
  for (const message of messages) {
    const sender = message.senderId?.trim();
    const sentAt = message.sentAt ? new Date(message.sentAt) : null;
    if (!sender || message.type === "system" || !sentAt || Number.isNaN(sentAt.getTime())) continue;
    const key = sparkDayKey(sentAt);
    sendersByDay.set(key, (sendersByDay.get(key) ?? new Set<string>()).add(sender));
  }

  // 一对一会话里出现两个不同的发送者就是双方都发过；认不认得出自己只影响单方那天的说法。
  const mutual = (day: Date) => (sendersByDay.get(sparkDayKey(day))?.size ?? 0) >= 2;
  const describe = (day: Date): SparkDay => {
    const senders = sendersByDay.get(sparkDayKey(day));
    if (!senders) return "none";
    if (senders.size >= 2) return "both";
    if (!selfId) return "one";
    return senders.has(selfId) ? "mine" : "theirs";
  };
  const runEndingAt = (day: Date) => {
    let days = 0;
    for (let cursor = day; mutual(cursor); cursor = shiftDay(cursor, -1)) days += 1;
    return days;
  };

  const today = shiftDay(now, 0);
  const base = {
    id,
    today: describe(today),
    recent: Array.from({ length: RECENT_DAYS }, (_, index) => describe(shiftDay(today, index - RECENT_DAYS + 1))),
  };
  if (mutual(today)) return { ...base, state: "done", days: runEndingAt(today), brokeOn: null };
  const yesterday = shiftDay(today, -1);
  if (mutual(yesterday)) return { ...base, state: "pending", days: runEndingAt(yesterday), brokeOn: null };

  // 只列出最近 7 天内断掉、而且之前点亮过的，偶尔聊过一两天的不算。
  for (let back = 2; back <= BROKEN_WINDOW_DAYS + 1; back += 1) {
    const last = shiftDay(today, -back);
    if (!mutual(last)) continue;
    const days = runEndingAt(last);
    return days >= SPARK_LIT_DAYS ? { ...base, state: "broken", days, brokeOn: sparkDayKey(shiftDay(last, 1)) } : null;
  }
  return null;
}

/** 本地日期；取正午做日期加减，避开夏令时切换那一小时。 */
export function shiftDay(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);
}

export function sparkDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
