import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// Ship the same responsive sources; do not maintain an Android fork of the stories.
export function bundleAndroidStories(root) {
  const target = path.join(root, "android/app/src/main/assets/story");
  // android/ 是 prebuild --no-clean 留着的：先清空，删掉的页面才不会跟着旧目录留在 APK 里（同 sync-story.mjs）
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.join(target, "story-images"), { recursive: true });
  for (const name of ["story-entry.html", "story-draft_副本.html", "story-poster.html", "story-glide.js", "story-export.js", "story-card.js"]) {
    copyFileSync(path.join(root, "prototype", name), path.join(target, name));
  }
  for (const name of readdirSync(path.join(root, "jimeng/story-images"))) {
    if (/^(sky-s\d-[a-z]+|entry-night|entry-mix)(-m)?\.jpg$/u.test(name)) copyFileSync(path.join(root, "jimeng/story-images", name), path.join(target, "story-images", name));
  }
}
