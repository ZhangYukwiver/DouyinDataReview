import { describe, expect, it } from "vitest";

import { applyAppStyle, buildPosterStoryUrl, buildStoryEntryUrl, loadAppStyle, saveAppStyle } from "./appStyle";

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
  it("defaults to the trace style and keeps an explicit archive choice", () => {
    const storage = memoryStorage();
    expect(loadAppStyle(storage)).toBe("trace");
    expect(loadAppStyle(undefined)).toBe("trace");
    saveAppStyle("archive", storage);
    expect(loadAppStyle(storage)).toBe("archive");
    expect(loadAppStyle(memoryStorage({ "content-insights.report-style": "garbage" }))).toBe("trace");
    saveAppStyle("poster", storage);
    expect(loadAppStyle(storage)).toBe("poster");
  });

  it("survives a storage that throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadAppStyle(broken)).toBe("trace");
    expect(() => saveAppStyle("trace", broken)).not.toThrow();
  });

  it("stamps the style on <html> and loads the trace fonts once", () => {
    const doc = fakeDocument();
    applyAppStyle("archive", doc);
    expect(doc.documentElement.dataset.style).toBe("archive");
    expect(doc.nodes.size).toBe(0);
    applyAppStyle("trace", doc);
    applyAppStyle("trace", doc);
    expect(doc.documentElement.dataset.style).toBe("trace");
    expect(doc.nodes.size).toBe(1);
    expect([...doc.nodes.values()][0]?.href).toContain("fonts.googleapis.com");
    expect(() => applyAppStyle("trace", undefined)).not.toThrow();
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
