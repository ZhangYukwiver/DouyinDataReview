import { describe, expect, it } from "vitest";
import type { ChatMemorial } from "../../domain/chatMemorial";
import { sparkCardLines } from "./sparkCard";

const base: ChatMemorial = {
  kind: "friend", name: "小周", spark: null, firstAt: "2026-09-01T10:00:00", lastAt: "2026-10-04T10:00:00", sinceDays: 34,
  total: 40, mine: 15, theirs: 25, selfKnown: true, sample: null, activeDays: 12, mutualDays: 8, longestRun: { days: 4, start: "2026-09-01", end: "2026-09-04" },
  hours: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? 9 : 1)), peakHour: 21, latest: "2026-09-02T02:10:00", busiestDay: { date: "2026-09-02", count: 11 },
  shares: { mine: 2, theirs: 3 }, stickers: 0, images: 0, topEmoji: [], topWords: [], firstLine: { text: "在吗", mine: false, at: "2026-09-01T10:00:00" },
  days: [{ date: "2026-09-01", who: "both", count: 3 }], at: "2026-10-04T20:00:00",
};
const spark = (patch: Partial<NonNullable<ChatMemorial["spark"]>>) => ({ days: 412, text: "412", official: true, state: "pending" as const, brokeOn: null, today: "none" as const, ...patch });
const stat = (m: ChatMemorial, k: string) => sparkCardLines(m).stats.find((item) => item.k === k);

describe("sparkCardLines", () => {
  it("tells who still has to talk today to keep the spark", () => {
    expect(sparkCardLines({ ...base, spark: spark({ today: "mine" }) }).hero.note).toBe("今天我说过了，等 TA 回一句就能接上");
    expect(sparkCardLines({ ...base, spark: spark({ today: "theirs" }) }).hero.note).toBe("TA 今天说过了，零点前回一句就能接上");
    expect(sparkCardLines({ ...base, spark: spark({ state: "done" }) }).hero).toMatchObject({ value: "412", note: "今天也续上了", lit: true });
  });

  it("separates reigniting from about-to-vanish sparks", () => {
    expect(sparkCardLines({ ...base, spark: spark({ state: "recover", text: "重燃中 2/3" }) }).hero.label).toBe("火花重燃中，之前连着");
    expect(sparkCardLines({ ...base, spark: spark({ state: "recover", text: "3天后消失" }) }).hero).toMatchObject({ label: "火花快要熄了，已经连着", note: "抖音上显示「3天后消失」，今天聊上就能留住" });
  });

  it("falls back to days chatted, and says when the local record is shorter than Douyin's spark", () => {
    expect(sparkCardLines(base).hero).toMatchObject({ label: "我们聊过", value: "12", note: "从 9 月 1 日算起的 34 天里", lit: false });
    expect(stat({ ...base, spark: spark({}) }, "互发消息的日子")?.s).toBe("这台电脑记下的日子里，最长连着互发了 4 天");
    expect(stat({ ...base, longestRun: { days: 1, start: "2026-09-01", end: "2026-09-01" } }, "互发消息的日子")?.s).toBe("还没有连着两天都互发过");
  });

  it("puts a small-hours message on the night before", () => {
    expect(stat(base, "聊得最晚的一次")).toEqual({ k: "聊得最晚的一次", v: "凌晨 2:10", s: "9 月 1 日夜里，已经过了零点" });
  });

  it("keeps percentages and ratios honest at the edges", () => {
    const group = (mine: number, total: number) => sparkCardLines({ ...base, kind: "group", name: "群", total, mine, theirs: total - mine, sample: 0, days: [] }).stats[1];
    expect(group(1, 3366)).toEqual({ k: "我说的话占多少", v: "不到 0.1%", s: "平均每 3,366 条里有 1 条是我说的" });
    expect(group(7, 10)).toMatchObject({ v: "70%", s: "每 10 条里有 7 条是我说的" });
    expect(group(996, 1000)).toMatchObject({ v: "99%", s: "差不多全是我说的" });
    expect(group(0, 130)).toMatchObject({ v: "0%", s: "采集到的消息里还没有我说的" });
  });

  it("does not say who wrote the first line when it cannot tell", () => {
    expect(sparkCardLines(base).firstLine?.by).toBe("TA 在 9 月 1 日说的");
    expect(sparkCardLines({ ...base, selfKnown: false, firstLine: { ...base.firstLine!, mine: null } }).firstLine?.by).toBe("9 月 1 日说的");
  });
});
