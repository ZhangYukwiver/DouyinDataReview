import { describe, expect, it } from "vitest";

import { createEmptyPersonalRecords, type PersonalVideoRecord } from "../../domain/personalRecords";
import { dayWindow, digestRecords, hachure, roughEllipse, roughRect, seeded } from "./setupSketch";

const record = (id: string, occurredAt: string | null, title = `标题 ${id}`): PersonalVideoRecord => ({ id, title, author: null, occurredAt, url: null });

describe("手绘几何", () => {
  it("同一个种子每次画出同一笔，换种子就换一笔", () => {
    expect(roughRect(200, 80, "card")).toBe(roughRect(200, 80, "card"));
    expect(roughRect(200, 80, "card")).not.toBe(roughRect(200, 80, "other"));
    expect(roughEllipse(40, 20, 30, 12, "ring")).toBe(roughEllipse(40, 20, 30, 12, "ring"));
    const a = seeded("x");
    const b = seeded("x");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("描边抖动按像素算，不随尺寸放大", () => {
    // 左上角起笔点只跟种子有关：宽高变了，起笔位置不该跟着漂
    const start = (path: string) => path.match(/^M(-?[\d.]+) (-?[\d.]+)/)!.slice(1).map(Number);
    const [x1, y1] = start(roughRect(120, 40, "same"));
    const [x2, y2] = start(roughRect(900, 600, "same"));
    expect(Math.abs(x1! - x2!)).toBeLessThan(0.2);
    expect(Math.abs(y1! - y2!)).toBeLessThan(0.2);
  });

  it("斜线填充裁在矩形里，太小的矩形不画", () => {
    expect(hachure(0, 0, 0.2, 10, "h")).toBe("");
    const numbers = hachure(10, 20, 30, 40, "h").match(/-?[\d.]+/g)!.map(Number);
    for (let index = 0; index < numbers.length; index += 2) {
      expect(numbers[index]).toBeGreaterThanOrEqual(9.5);
      expect(numbers[index]).toBeLessThanOrEqual(40.5);
      expect(numbers[index + 1]).toBeGreaterThanOrEqual(19.5);
      expect(numbers[index + 1]).toBeLessThanOrEqual(60.5);
    }
  });
});

describe("记录摘要", () => {
  const now = new Date(2026, 8, 25, 12, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 30).toISOString();

  it("按本地日期、钟点计数，最近几条按时间倒序，没日期和未来的不算", () => {
    const records = createEmptyPersonalRecords();
    records.watch_history.push(record("w1", at(24, 21)), record("w2", at(24, 22)), record("w3", null), record("w4", at(30, 9)));
    records.liked_videos.push(record("l1", at(20, 8), "  "));
    records.favorite_videos.push(record("f1", at(25, 10)));
    const digest = digestRecords(records, 3, now);
    expect(digest.total).toBe(6);
    expect(digest.dated).toBe(4);
    expect(digest.perDay.get(new Date(2026, 8, 24).getTime())).toBe(2);
    expect(digest.perHour[21]).toBe(1);
    expect(digest.perHour[22]).toBe(1);
    expect(digest.recent.map((item) => item.id)).toEqual(["favorite:f1", "watch:w2", "watch:w1"]);
    expect(digestRecords(records, 5, now).recent.at(-1)?.title).toBe("（没有标题）");
    expect(new Date(digest.first!).getDate()).toBe(20);
  });

  it("数据是新的就画到今天，旧档案停在最后一条那天", () => {
    const fresh = createEmptyPersonalRecords();
    fresh.watch_history.push(record("a", at(23, 9)), record("b", at(23, 10)), record("c", at(10, 9)));
    const win = dayWindow(digestRecords(fresh, 5, now), 14, now)!;
    expect(win.endsToday).toBe(true);
    expect(win.days).toHaveLength(14);
    expect(win.days.at(-1)!.day).toBe(new Date(2026, 8, 25).getTime());
    expect(win.max).toBe(2);
    expect(win.days[win.maxIndex]!.day).toBe(new Date(2026, 8, 23).getTime());
    expect(win.activeDays).toBe(1);

    const old = createEmptyPersonalRecords();
    old.liked_videos.push(record("x", new Date(2025, 2, 3, 20).toISOString()));
    const oldWin = dayWindow(digestRecords(old, 5, now), 30, now)!;
    expect(oldWin.endsToday).toBe(false);
    expect(oldWin.days.at(-1)!.day).toBe(new Date(2025, 2, 3).getTime());
    expect(oldWin.sum).toBe(1);

    expect(dayWindow(digestRecords(createEmptyPersonalRecords(), 5, now), 30, now)).toBeNull();
  });
});
