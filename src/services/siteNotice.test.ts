import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadDismissedNotices, parseSiteNotices, saveDismissedNotices } from "./siteNotice";

describe("parseSiteNotices", () => {
  it("accepts the file published on the download site", () => {
    expect(parseSiteNotices(JSON.parse(readFileSync("docs/notice.json", "utf8")), "1.37.0").notices).toEqual(expect.any(Array));
  });

  it("drops malformed entries and non-https links, and hides issues already fixed in this version", () => {
    const parsed = parseSiteNotices({
      feedbackUrl: "javascript:alert(1)",
      notices: [
        { id: "a", text: " 线路 2 暂时不能用 ", url: "https://example.com/a" },
        { id: "b", text: "Mac 读取卡住", fixedIn: "1.37.0" },
        { id: "c", text: "旧问题", fixedIn: "1.36.9", url: "http://example.com" },
        { id: "d", text: "新问题", fixedIn: "1.37.10" },
        { id: "", text: "没有编号" },
        { id: "e", text: "  " },
        null,
      ],
    }, "1.37.0");
    expect(parsed).toEqual({
      feedbackUrl: null,
      notices: [
        { id: "a", text: "线路 2 暂时不能用", url: "https://example.com/a" },
        { id: "d", text: "新问题", url: null },
      ],
    });
    expect(parseSiteNotices({ notices: [{ id: "b", text: "x", fixedIn: "1.37.0" }] }, "").notices).toHaveLength(1);
    expect(parseSiteNotices({ feedbackUrl: "https://wj.qq.com/s2/1" }, "1.0.0").feedbackUrl).toBe("https://wj.qq.com/s2/1");
    expect(parseSiteNotices("坏掉的文件", "1.0.0")).toEqual({ feedbackUrl: null, notices: [] });
  });
});

describe("dismissed notices", () => {
  it("round-trips ids and survives garbage or a throwing storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    saveDismissedNotices(["a", "b"], storage);
    expect(loadDismissedNotices(storage)).toEqual(["a", "b"]);
    values.set("content-insights.dismissed-notices", "{oops");
    expect(loadDismissedNotices(storage)).toEqual([]);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadDismissedNotices(broken)).toEqual([]);
    expect(() => saveDismissedNotices(["a"], broken)).not.toThrow();
  });
});
