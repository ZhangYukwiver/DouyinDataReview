import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readStory(name) {
  return readFile(path.join(root, "prototype", name), "utf8");
}

describe("story motion preference handoff", () => {
  it("keeps reduced-motion rules scoped away from the explicit full-motion mode", async () => {
    for (const name of ["story-entry.html", "story-draft_副本.html"]) {
      const source = await readStory(name);
      expect(source).toContain("html:not(.motion-full)");
      expect(source).toContain('get("motion") === "full"');
      expect(source).not.toContain("@media (prefers-reduced-motion: reduce) {\n      *, *::before");
    }
  });

  it("passes full motion from the app entry through to the long-form page", async () => {
    const entry = await readStory("story-entry.html");
    expect(entry).toContain('motionFull ? "&motion=full" : ""');
    const app = await readFile(path.join(root, "App.tsx"), "utf8");
    expect(app).toContain('}, story.year, { motion: "full" })');
    const story = await readStory("story-draft_副本.html");
    // the page behind the card starts white (the card's whitening) and develops into the night
    expect(story).toContain('get("from") === "card"');
  });

  it("hands the framed story back to the workspace", async () => {
    const story = await readStory("story-draft_副本.html");
    expect(story).toContain('postMessage({ type: "trace:open-dashboard" }');
    expect(story).toContain('event.key === "Escape"');
  });
});
