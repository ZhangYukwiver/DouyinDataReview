import { describe, expect, it } from "vitest";

import type { PersonalVideoRecord } from "../domain/personalRecords";
import { earliestRecordDate, searchRecords } from "./recordSearch";

const record = (id: string, fields: Partial<PersonalVideoRecord>): PersonalVideoRecord => ({
  id,
  title: "",
  author: null,
  occurredAt: null,
  url: null,
  ...fields,
});

const records = [
  record("a", { title: "雪地里的小猫", author: "阿雪", topics: ["萌宠"], occurredAt: "2026-09-03T10:00:00.000Z" }),
  record("b", { title: "雪山徒步", author: "Trail Lab", music: { title: "Snow Song", author: "Ann" }, occurredAt: "2026-08-09T01:00:00.000Z" }),
  record("c", { title: "今天吃什么", author: "猫饭", topics: ["美食"] }),
];

describe("searchRecords", () => {
  it("returns every record for an empty query", () => {
    expect(searchRecords(records, "  ")).toBe(records);
  });

  it("requires every space-separated term to match", () => {
    expect(searchRecords(records, "雪地 猫").map((item) => item.id)).toEqual(["a"]);
    expect(searchRecords(records, "猫").map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("matches author, topics with or without #, and music case-insensitively", () => {
    expect(searchRecords(records, "trail").map((item) => item.id)).toEqual(["b"]);
    expect(searchRecords(records, "#美食").map((item) => item.id)).toEqual(["c"]);
    expect(searchRecords(records, "snow ANN").map((item) => item.id)).toEqual(["b"]);
  });

  it("does not match a term that only exists across two fields", () => {
    expect(searchRecords(records, "小猫阿雪")).toEqual([]);
  });
});

describe("earliestRecordDate", () => {
  it("ignores records without a time", () => {
    expect(earliestRecordDate(records)).toBe("2026-08-09T01:00:00.000Z");
    expect(earliestRecordDate(records.slice(2))).toBeNull();
  });
});
