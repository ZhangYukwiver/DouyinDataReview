import { describe, expect, it } from "vitest";

import { APP_STYLES, applyAppStyle, buildArchiveStoryUrl, buildPosterStoryUrl, buildStoryEntryUrl, loadAnalysisInstalled, loadAppStyle, loadAutoSync, loadStoryStyle, resolveStoryStyle, saveAnalysisInstalled, saveAppStyle, saveAutoSync, saveStoryStyle, STORY_STYLES } from "./appStyle";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

function fakeDocument() {
  const nodes = new Map<string, { id: string; rel: string; href: string }>();
  return {
    documentElement: { dataset: {} as Record<string, string | undefined> },
    head: { appendChild: (node: unknown) => nodes.set((node as { id: string }).id, node as { id: string; rel: string; href: string }) },
    getElementById: (id: string) => nodes.get(id) ?? null,
    createElement: () => ({ id: "", rel: "", href: "" }),
    nodes,
  };
}

describe("app style", () => {
  it("defaults to the minimal style and keeps an explicit earlier choice", () => {
    const storage = memoryStorage();
    expect(loadAppStyle(storage)).toBe("minimal");
    expect(loadAppStyle(undefined)).toBe("minimal");
    saveAppStyle("archive", storage);
    expect(loadAppStyle(storage)).toBe("archive");
    expect(loadAppStyle(memoryStorage({ "content-insights.report-style": "garbage" }))).toBe("minimal");
    expect(loadAppStyle(memoryStorage({ "content-insights.report-style": "trace" }))).toBe("trace");
    saveAppStyle("poster", storage);
    expect(loadAppStyle(storage)).toBe("poster");
    saveAppStyle("minimal", storage);
    expect(loadAppStyle(storage)).toBe("minimal");
    expect(APP_STYLES[0]?.key).toBe("minimal");
  });

  it("lets the minimal style borrow one of the three story pages", () => {
    const storage = memoryStorage();
    expect(STORY_STYLES.map((item) => item.key)).toEqual(["trace", "archive", "poster"]);
    expect(loadStoryStyle(storage)).toBe("trace");
    saveStoryStyle("poster", storage);
    expect(loadStoryStyle(storage)).toBe("poster");
    // 不认识的值（包括 minimal 自己）退回内容年志
    expect(loadStoryStyle(memoryStorage({ "content-insights.story-style": "minimal" }))).toBe("trace");
    expect(resolveStoryStyle("minimal", "archive")).toBe("archive");
    expect(resolveStoryStyle("poster", "archive")).toBe("poster");
  });

  it("remembers the auto-sync switch, on by default", () => {
    const storage = memoryStorage();
    expect(loadAutoSync(storage)).toBe(true);
    saveAutoSync(false, storage);
    expect(loadAutoSync(storage)).toBe(false);
    saveAutoSync(true, storage);
    expect(loadAutoSync(storage)).toBe(true);
    expect(loadAutoSync(undefined)).toBe(true);
  });

  it("keeps video analysis uninstalled until chosen", () => {
    const storage = memoryStorage();
    expect(loadAnalysisInstalled(storage)).toBe(false);
    saveAnalysisInstalled(true, storage);
    expect(loadAnalysisInstalled(storage)).toBe(true);
    saveAnalysisInstalled(false, storage);
    expect(loadAnalysisInstalled(storage)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadAppStyle(broken)).toBe("minimal");
    expect(loadStoryStyle(broken)).toBe("trace");
    expect(() => saveAppStyle("trace", broken)).not.toThrow();
    expect(() => saveStoryStyle("trace", broken)).not.toThrow();
  });

  it("needs no web font for the minimal style", () => {
    const doc = fakeDocument();
    applyAppStyle("minimal", doc);
    expect(doc.documentElement.dataset.style).toBe("minimal");
    expect(doc.nodes.size).toBe(0);
  });

  it("stamps the style on <html> and loads the trace fonts once", () => {
    const doc = fakeDocument();
    applyAppStyle("archive", doc);
    expect(doc.documentElement.dataset.style).toBe("archive");
    expect(doc.nodes.get("content-insights-archive-fonts")?.href).toContain("family=Cormorant+Garamond");
    applyAppStyle("trace", doc);
    applyAppStyle("trace", doc);
    expect(doc.documentElement.dataset.style).toBe("trace");
    expect(doc.nodes.size).toBe(2);
    expect(doc.nodes.get("content-insights-trace-fonts")?.href).toContain("fonts.googleapis.com");
    expect(() => applyAppStyle("trace", undefined)).not.toThrow();
  });

  it("describes the trace style as the night entry card and loads Fraunces with its italics", () => {
    expect(APP_STYLES.find((item) => item.key === "trace")?.detail).toBe("墨夜玻璃 · 穿卡入口");
    const doc = fakeDocument();
    applyAppStyle("trace", doc);
    const href = doc.nodes.get("content-insights-trace-fonts")?.href ?? "";
    expect(href).toContain("family=Fraunces:ital,opsz,wght@0,9..144,100..900;1,9..144,100..900");
    expect(href).toContain("family=Inter");
  });

  it("loads the poster fonts on their own link, once", () => {
    const doc = fakeDocument();
    applyAppStyle("poster", doc);
    applyAppStyle("poster", doc);
    applyAppStyle("trace", doc);
    expect(doc.documentElement.dataset.style).toBe("trace");
    expect([...doc.nodes.keys()]).toEqual(["content-insights-poster-fonts", "content-insights-trace-fonts"]);
    expect(doc.nodes.get("content-insights-poster-fonts")?.href).toContain("family=Anton");
  });

  it("points the archive style at its paged story page", () => {
    expect(buildArchiveStoryUrl()).toBe("/story/story-archive.html");
    expect(buildArchiveStoryUrl({ motion: "full" })).toBe("/story/story-archive.html?motion=full");
  });

  it("points the poster style straight at its story page", () => {
    expect(buildPosterStoryUrl()).toBe("/story/story-poster.html");
    expect(buildPosterStoryUrl({ motion: "full" })).toBe("/story/story-poster.html?motion=full");
  });

  it("builds the entry card url with counts and omits chat when unknown", () => {
    expect(buildStoryEntryUrl({ watch: 1144, liked: 8, favorite: 6, chat: 42 }, 2026)).toBe("/story/story-entry.html?watch=1144&liked=8&favorite=6&year=2026&chat=42");
    expect(buildStoryEntryUrl({ watch: 0, liked: 0, favorite: 0, chat: null }, 2026)).not.toContain("chat=");
  });

  it("marks the in-app story as an explicitly interactive surface", () => {
    expect(buildStoryEntryUrl({ watch: 1, liked: 2, favorite: 3, chat: null }, 2026, { motion: "full" }))
      .toBe("/story/story-entry.html?watch=1&liked=2&favorite=3&year=2026&motion=full");
  });
});
