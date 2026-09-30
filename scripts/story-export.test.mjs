import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadExporter() {
  const window = {};
  vm.runInNewContext(await readFile(path.join(root, "prototype", "story-export.js"), "utf8"), { window });
  return window.StoryExport;
}

const data = {
  version: 1,
  year: 2026,
  recent: [{ title: "#猫 笑死", author: "胶片老周", coverUrl: "https://p3.douyinpic.com/c.jpeg", url: "https://www.douyin.com/video/1", kind: "liked" }],
  topCreator: { name: "胶片老周", unique: 12, avatarUrl: "https://p3.douyinpic.com/a.jpeg" },
  topics: [{ name: "露营", count: 3, share: 0.1 }],
  chat: { top: [{ name: "小满", kind: "friend", messageCount: 3 }], share: { title: "分享的", author: "阿杰", url: "https://v.douyin.com/x" } },
  lexicon: { contrast: { both: ["装修"], sharedOnly: [], likedOnly: ["编程"] } },
  media: [{ label: "视频", share: 0.8 }],
  days: [["2026-01-01", 3]],
  profile: { title: "夜里 · 寻常", name: "夜行的货郎", reading: "这一年的多数时候在夜里。" },
};

describe("story export", () => {
  it("leaves no name, title, topic or link in a file exported with privacy on", async () => {
    const { scrub } = await loadExporter();
    const text = JSON.stringify(scrub(data));
    for (const secret of ["胶片老周", "笑死", "小满", "阿杰", "分享的", "露营", "装修", "编程", "douyinpic", "douyin.com"]) expect(text).not.toContain(secret);
    const out = scrub(data);
    expect(out.recent[0]).toMatchObject({ title: "#■ ■■", author: "■■■■", coverUrl: null, url: null, kind: "liked" });
    // what the page generates about the viewer, the numbers and the labels stay
    expect(out.profile).toEqual(data.profile);
    expect(out.media).toEqual(data.media);
    expect(out.days).toEqual(data.days);
    expect(out.topics[0]).toEqual({ name: "■■", count: 3, share: 0.1 });
  });

  it("keeps equal words equal and different words different after masking, so the pages still match them up", async () => {
    const { scrub } = await loadExporter();
    const keyOf = (s) => String(s || "").replace(/^#/, "").trim().toLowerCase(); // the archive's own comparison
    const out = scrub({
      topics: [{ name: "装修" }, { name: "编程" }, { name: "Vlog" }],
      lexicon: { liked: { top: [{ name: "编程" }, { name: "#装修" }, { name: "vlog" }] }, contrast: { both: ["编程"] } },
      musics: [{ title: "稻香", author: "周杰伦" }, { title: "晴天", author: "周杰伦" }],
    });

    expect(out.topics[0].name).not.toBe(out.topics[1].name);
    expect(keyOf(out.topics[1].name)).toBe(keyOf(out.lexicon.liked.top[0].name));
    expect(keyOf(out.topics[0].name)).toBe(keyOf(out.lexicon.liked.top[1].name));
    expect(keyOf(out.topics[2].name)).toBe(keyOf(out.lexicon.liked.top[2].name));
    expect(out.lexicon.contrast.both[0]).toBe(out.topics[1].name);
    // a second song by the same singer is not mistaken for the top one
    expect(out.musics[1].title).not.toBe(out.musics[0].title);
    expect(out.musics[1].author).toBe(out.musics[0].author);
    // masks look the same length on screen: only zero-width characters tell them apart
    expect(out.topics[1].name.replace(/[\u200b-\u200d]/gu, "")).toBe("■■");
  });

  it("leaves topic words alone for pages that show them with privacy on, but never chat words", async () => {
    const { scrub } = await loadExporter();
    const out = scrub({
      topics: [{ name: "露营", card: { title: "#露营 一整天", author: "山野阿木" } }],
      topTopic: { name: "露营" },
      lexicon: { watch: { top: [{ name: "露营" }] }, chat: { top: [{ name: "晚安" }] }, contrast: { both: ["露营"] } },
    }, { privateTopics: false });

    expect(out.topics[0].name).toBe("露营");
    expect(out.topTopic.name).toBe("露营");
    expect(out.lexicon.watch.top[0].name).toBe("露营");
    expect(out.lexicon.contrast.both).toEqual(["露营"]);
    expect(out.topics[0].card).toMatchObject({ title: "#■■ ■■■", author: "■■■■" });
    expect(out.lexicon.chat.top[0].name).toBe("■■");
  });

  it("writes the data, assets and shared script into the page, safely", async () => {
    const { build } = await loadExporter();
    const source = [
      "<!doctype html><html><head>",
      '<script src="story-glide.js"></script>',
      '<script src="story-export.js"></script>',
      "<title>t</title></head><body></body></html>",
    ].join("\n");
    const tricky = { ...data, recent: [{ title: "</script><script>alert(1)</script> $& $$ $'" }] };

    const html = build(source, { data: tricky, privacy: false, assets: { "sky-s0-dawn": "data:image/jpeg;base64,AAAA" }, scripts: { "story-glide.js": "window.G = '</script>';" } });

    expect(html).not.toContain('src="story-export.js"');
    expect(html).not.toContain('src="story-glide.js"');
    expect(html).toContain("window.G = '<\\/script>';");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    // the payload is the first script in <head>, so the page sees it before its own code runs
    const payload = /<head>\n<script>window\.__STORY_EXPORT__ = (.*);<\/script>/u.exec(html);
    expect(JSON.parse(payload[1])).toEqual({ data: tricky, privacy: false, assets: { "sky-s0-dawn": "data:image/jpeg;base64,AAAA" } });
  });

  it("is wired into each story page and synced with them", async () => {
    const sync = await readFile(path.join(root, "scripts", "sync-story.mjs"), "utf8");
    expect(sync).toContain('"story-export.js"');
    for (const name of ["story-poster.html", "story-archive.html", "story-draft_副本.html"]) {
      const page = await readFile(path.join(root, "prototype", name), "utf8");
      expect(page).toContain('<script src="story-export.js"></script>');
      expect(page).toContain('id="navExport"');
      expect(page).toContain("window.__STORY_EXPORT__");
    }
  });
});
