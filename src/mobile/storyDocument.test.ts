import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { expect, it, vi } from "vitest";
import type { StoryData } from "../services/storyData";

vi.mock("./nativeBridge", () => ({ nativeBridge: { readStoryAsset: async (name: string) => {
  const file = name.startsWith("story-images/") ? `jimeng/${name}` : `prototype/${name}`;
  return name.endsWith(".jpg") ? `data:image/jpeg;base64,${readFileSync(file).toString("base64")}` : readFileSync(file, "utf8");
} } }));
import { STORY_PAGES, storyDocument } from "./storyDocument";

it("uses the real story sources with safely embedded data and self-contained offline scripts", async () => {
  const data = { version: 1, year: 2026, counts: { watch: 31, liked: 2, favorite: 1 }, testTitle: "合成测试 </script> $& $$" } as unknown as StoryData;
  for (const page of STORY_PAGES) {
    const html = await storyDocument(page, data, { offline: true });
    expect(html).toContain("window.__STORY_EXPORT__=");
    expect(html).not.toContain("这台电脑");
    expect(html).toContain("\\u003c/script> $& $$");
    expect(/^[ \t]*<script src=/mu.test(html)).toBe(false);
    for (const [, source] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gu)) expect(() => new Script(source!)).not.toThrow();
    if (page === "story-entry.html") expect(html).toContain("LOCAL SNAPSHOT");
    if (page === "story-draft_副本.html") expect(html).toContain('"sky-s0-dawn":"data:image/jpeg;base64,');
  }
});
