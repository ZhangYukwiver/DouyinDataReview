import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleAndroidStories } from "./android-story.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("bundleAndroidStories", () => {
  it("clears stale story files like story-archive.html and copies only active story assets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dy-android-story-"));
    dirs.push(root);
    mkdirSync(path.join(root, "prototype"), { recursive: true });
    mkdirSync(path.join(root, "jimeng", "story-images"), { recursive: true });
    const target = path.join(root, "android", "app", "src", "main", "assets", "story");
    mkdirSync(path.join(target, "story-images"), { recursive: true });

    writeFileSync(path.join(target, "story-archive.html"), "stale archive");
    writeFileSync(path.join(target, "story-images", "old-unused.jpg"), "stale image");

    for (const name of ["story-entry.html", "story-draft_副本.html", "story-poster.html", "story-glide.js", "story-export.js", "story-card.js"]) {
      writeFileSync(path.join(root, "prototype", name), `content:${name}`);
    }
    writeFileSync(path.join(root, "jimeng", "story-images", "sky-s0-dawn-m.jpg"), "img");
    writeFileSync(path.join(root, "jimeng", "story-images", "entry-textures.js"), "ignored on android");

    bundleAndroidStories(root);

    expect(readdirSync(target).sort()).toEqual([
      "story-card.js",
      "story-draft_副本.html",
      "story-entry.html",
      "story-export.js",
      "story-glide.js",
      "story-images",
      "story-poster.html",
    ]);
    expect(readdirSync(path.join(target, "story-images"))).toEqual(["sky-s0-dawn-m.jpg"]);
  });
});
