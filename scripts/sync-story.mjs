// Copies the story prototypes (TRACE entry card + story page + the paintings they use, and the POSTER page)
// into public/story so `expo start --web` serves it and `expo export` ships it in dist/.
// Source of truth stays in prototype/ and jimeng/story-images; rerun after editing them.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "public", "story");
// story-poster.html：海报风格的报告本体（自带封面，不走入口卡）
const PAGES = ["story-entry.html", "story-draft_副本.html", "story-poster.html"];
const IMAGE = /^(sky-s\d-[a-z]+|entry-night|entry-mix)\.jpg$|^entry-textures\.js$/u;

rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, "story-images"), { recursive: true });
for (const page of PAGES) copyFileSync(path.join(root, "prototype", page), path.join(target, page));
const images = readdirSync(path.join(root, "jimeng", "story-images")).filter((name) => IMAGE.test(name));
for (const name of images) copyFileSync(path.join(root, "jimeng", "story-images", name), path.join(target, "story-images", name));
console.log(`synced ${PAGES.length} pages + ${images.length} assets -> public/story`);
