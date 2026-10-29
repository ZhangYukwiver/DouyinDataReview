import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { expect, it, vi } from "vitest";
import type { StoryData } from "../services/storyData";

vi.mock("./nativeBridge", () => ({ nativeBridge: { readStoryAsset: async (name: string) => {
  const file = name.startsWith("story-images/") ? `jimeng/${name}` : `prototype/${name}`;
  return name.endsWith(".jpg") ? `data:image/jpeg;base64,${readFileSync(file).toString("base64")}` : readFileSync(file, "utf8");
} } }));
import { STORY_PAGES, storyDocument, storyExportScript } from "./storyDocument";

it("uses the real story sources with safely embedded data and self-contained offline scripts", async () => {
  const data = { version: 1, year: 2026, counts: { watch: 31, liked: 2, favorite: 1 }, testTitle: "合成测试 </script> $& $$" } as unknown as StoryData;
  for (const page of STORY_PAGES) {
    const html = await storyDocument(page, data, { offline: true });
    expect(html).toContain("window.__STORY_EXPORT__=");
    expect(html).not.toContain("这台电脑");
    expect(html).toContain("\\u003c/script> $& $$");
    expect(/^[ \t]*<script src=/mu.test(html)).toBe(false);
    for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) expect(() => new Script(source!)).not.toThrow();
    if (page === "story-entry.html") expect(html).toContain("LOCAL SNAPSHOT");
    if (page === "story-draft_副本.html") expect(html).toContain('"sky-s0-dawn":"data:image/jpeg;base64,');
  }
});

it("exports the visible privacy state and preserves escaped bridge identifiers as data", () => {
  const bridgeId = 'story-</SCRIPT>\u2028"\\', requestId = "request-\u2029'\n";
  const data = { title: "本机内容" }, scrubbed = { title: "匿名内容" };
  for (const page of ["story-archive.html", "story-poster.html"] as const) {
    for (const privacy of [false, true]) {
      const scrub = vi.fn(() => scrubbed), postMessage = vi.fn();
      const script = storyExportScript(page, bridgeId, requestId);
      expect(script).not.toMatch(/<\/script|\u2028|\u2029/iu);
      new Script(script).runInNewContext({
        document: { body: { classList: { contains: () => privacy } } },
        window: { StoryExport: { scrub }, __STORY_EXPORT__: { data }, ReactNativeWebView: { postMessage } },
      });
      expect(JSON.parse(postMessage.mock.calls[0]![0])).toEqual({ type: "story-export", bridgeId, requestId, privacy, data: privacy ? scrubbed : data });
      if (privacy) expect(scrub).toHaveBeenCalledWith(data, { privateTopics: page === "story-archive.html" });
      else expect(scrub).not.toHaveBeenCalled();
    }
  }
});
