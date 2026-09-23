import { describe, expect, it } from "vitest";

import { isSameOriginUrl, isStoryUrl } from "./windowPolicy.mjs";

const appUrl = "http://127.0.0.1:42123";

describe("desktop window policy", () => {
  it("keeps story pages and their local navigation in the app origin", () => {
    expect(isStoryUrl(`${appUrl}/story/story-entry.html?year=2026`, appUrl)).toBe(true);
    expect(isStoryUrl(`${appUrl}/story/story-draft_%E5%89%AF%E6%9C%AC.html#chapter`, appUrl)).toBe(true);
    expect(isSameOriginUrl(`${appUrl}/`, appUrl)).toBe(true);
  });

  it.each([
    "http://127.0.0.1:42124/story/story-entry.html",
    "http://127.0.0.1:421230/story/story-entry.html",
    "http://localhost:42123/story/story-entry.html",
    "http://127.0.0.1:42123.example.com/story/story-entry.html",
    "https://example.com/story/story-entry.html",
    "file:///story/story-entry.html",
    "javascript:alert(1)",
    "not a URL",
    `${appUrl}/`,
    `${appUrl}/story-other/story-entry.html`,
    `${appUrl}/story/../index.html`,
    `${appUrl}/story/%2e%2e%2findex.html`,
    `${appUrl}/story/%2e%2e%5cindex.html`,
    `${appUrl}/story/%invalid`,
    "http://user:password@127.0.0.1:42123/story/story-entry.html",
  ])("does not allow %s in a story window", (value) => {
    expect(isStoryUrl(value, appUrl)).toBe(false);
  });
});
