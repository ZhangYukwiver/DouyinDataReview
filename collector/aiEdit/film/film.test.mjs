import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { probeMedia } from "../media.mjs";
import { boxOf, filmToPlan, projectToFilm, transformOf } from "./filmFile.mjs";
import { openMovie } from "./mp4.mjs";
import { createFilmFiles } from "./serve.mjs";

const temp = () => mkdtemp(path.join(tmpdir(), "film-"));

describe("film", () => {
  it("writes movies the collector's probe reads back", async () => {
    const dir = await temp();
    const file = path.join(dir, "page.mov");
    const movie = await openMovie(file, { container: "mov" });
    for (let index = 0; index < 45; index += 1) await movie.writeVideo(Buffer.from([index, 1, 2, 3]), { duration: 1000 });
    await movie.close({ codec: "png ", width: 1080, height: 1920, timescale: 30_000, alpha: true });
    expect(await probeMedia(file, { roots: [dir] })).toMatchObject({ kind: "video", width: 1080, height: 1920, duration_us: 1_500_000, audio: false });

    const mp4 = path.join(dir, "film.mp4");
    const film = await openMovie(mp4);
    const avcC = Buffer.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xce]);
    for (let index = 0; index < 60; index += 1) await film.writeVideo(Buffer.from([index]), { key: index % 30 === 0, duration: 1000 });
    for (let index = 0; index < 94; index += 1) await film.writeAudio(Buffer.from([index]), 1024);
    await film.close({ codec: "avc1", width: 720, height: 1280, timescale: 30_000, description: avcC }, { sampleRate: 48_000, channels: 2, bitrate: 192_000, description: Buffer.from([0x11, 0x90]) });
    const probed = await probeMedia(mp4, { roots: [dir] });
    expect(probed).toMatchObject({ kind: "video", width: 720, height: 1280, audio: true });
    // 94 帧 AAC 比画面多出半帧
    expect(Math.abs(probed.duration_us - (94 * 1024 * 1e6) / 48_000)).toBeLessThan(2);
  });

  it("turns a place on the canvas into a film.html box and back", () => {
    const stage = { width: 1080, height: 1920 };
    const media = { width: 1920, height: 1080 };
    const transform = { scale_x: 0.5, scale_y: 0.5, transform_x: 0.25, transform_y: -0.5, rotation: 15 };
    const box = boxOf(stage, media, "contain", transform);
    // contain 横屏：宽 1080，高 607.5；缩到一半，中心挪到 (675, 1440)
    expect(box).toEqual({ x: 405, y: 1288.125, w: 540, h: 303.75, r: 15 });
    expect(transformOf(stage, media, box)).toEqual({ ...transform });
    // 只写了宽：高按素材比例补
    expect(transformOf(stage, media, { x: 0, y: 0, w: 1080 })).toMatchObject({ scale_x: 1, scale_y: 1, transform_y: round3(1 - 607.5 / 1920) });
  });

  it("exports a project to film.html and reads it back as tracks", async () => {
    const media = new Map([
      ["/m/a.mp4", { name: "海边.mp4", width: 1920, height: 1080, source: { type: "local" } }],
      ["/m/p.mov", { name: "标题", width: 1080, height: 1920, source: { type: "page", page: "abc/index.html", transparent: true } }],
      ["/m/m.mp3", { name: "配乐.mp3", source: { type: "local" } }],
    ]);
    const segment = (id, kind, filePath, start, length, extra = {}) => ({ id, kind, path: filePath, timeline: { start_us: start * 1e6, duration_us: length * 1e6 }, ...extra });
    const project = {
      name: "旅行", canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        { id: "v", track_type: "video", segments: [segment("s1", "video", "/m/a.mp4", 0, 4, { source: { start_us: 2e6, duration_us: 8e6 }, speed: 2, volume: 0.5, fit: "cover", effects: [{ effect_type: "x" }] })] },
        { id: "a", track_type: "audio", mute: true, segments: [segment("s2", "audio", "/m/m.mp3", 0, 4, { source: { start_us: 0, duration_us: 4e6 } })] },
        { id: "p", track_type: "video", segments: [segment("s3", "video", "/m/p.mov", 1, 2, { source: { start_us: 0, duration_us: 2e6 }, fade: { in_duration_us: 3e5, out_duration_us: 0 } })] },
        { id: "t", track_type: "text", segments: [{ id: "s4", kind: "text", text: "周末", timeline: { start_us: 0, duration_us: 15e5 }, font_size: 12 }] },
        { id: "k", track_type: "sticker", segments: [{ id: "s5", kind: "sticker", timeline: { start_us: 0, duration_us: 1e6 } }] },
      ],
    };
    const { html, texts, dropped } = projectToFilm(project, {
      mediaOf: (filePath) => media.get(filePath), srcFor: (item) => `assets/${item.name}`, pageSrc: (rel) => `pages/${rel}`, textSrc: (seg) => `text/${seg.id}.html`,
    });
    expect(dropped).toEqual({ 特效: 1, 贴纸: 1 });
    expect(texts).toHaveLength(1);
    expect(texts[0].html).toContain("周末");
    // 最上层的文字轨在最前面；静音的轨道写成 muted
    expect(html.indexOf("text/s4.html")).toBeLessThan(html.indexOf("pages/abc/index.html"));
    expect(html).toContain('<section muted>');
    expect(html).toContain('src="assets/海边.mp4#t=2,10" speed="2" volume="0.5"');

    const dir = await temp();
    const plan = filmToPlan(html, dir);
    expect(plan.canvas).toEqual({ width: 1080, height: 1920 });
    // 反过来：最后一条在最上层
    expect(plan.tracks.map((track) => track.type)).toEqual(["video", "audio", "video", "video"]);
    expect(plan.tracks[0].clips[0]).toMatchObject({ kind: "video", file: path.join(dir, "assets/海边.mp4"), time: [2, 10], speed: 2, volume: 0.5 });
    expect(plan.tracks[1].clips[0]).toMatchObject({ kind: "sound", volume: 0 });
    expect(plan.tracks[2].clips[0]).toMatchObject({ kind: "page", at: 1, time: [0, 2], fade: [0.3, 0] });
    expect(plan.tracks[3].clips[0]).toMatchObject({ kind: "page", file: path.join(dir, "text/s4.html") });
  });

  it("ends a clip where the next one on its track starts (openfilm films overlap pages by a few ms)", () => {
    const html = `<meta name="viewport" content="width=1920, height=1080"><section>
      <iframe id="b" src="verse.html" at="7.479"></iframe><iframe id="a" src="intro.html"></iframe><iframe id="c" src="pre.html" at="26.168"></iframe>
    </section><section><audio id="song" src="song.mp3"></audio></section>`;
    const plan = filmToPlan(html, "/f");
    expect(plan.tracks.map((track) => track.type)).toEqual(["audio", "video"]);
    expect(plan.tracks[1].clips.map((clip) => [clip.name, clip.at, clip.until])).toEqual([["intro.html", 0, 7.479], ["verse.html", 7.479, 26.168], ["pre.html", 26.168, undefined]]);
  });

  it("serves pages with the host prelude, only under its key and areas", async () => {
    const root = await temp();
    await mkdir(path.join(root, "pages", "p1"), { recursive: true });
    await writeFile(path.join(root, "pages", "p1", "index.html"), "<html><head></head><body><script>window.film={frame(){}}</script></body></html>");
    await writeFile(path.join(root, "secret.json"), "{}");
    const files = createFilmFiles({ root });
    const server = http.createServer(async (request, response) => {
      if (!(await files.handle(request, response, new URL(request.url, "http://x")))) response.writeHead(418).end();
    }).listen(0, "127.0.0.1");
    await new Promise((done) => server.once("listening", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(files.urlFor(origin, "pages/p1/index.html"));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const text = await page.text();
      expect(text.indexOf("window.filmHost")).toBeLessThan(text.indexOf("window.film={frame"));
      expect(await (await fetch(`${files.urlFor(origin, "pages/p1/index.html")}?film-host=0`)).text()).not.toContain("filmHost");
      expect((await fetch(files.urlFor(origin, "secret.json"))).status).toBe(404);
      expect((await fetch(`${origin}/v1/ai-edit/film/wrong/pages/p1/index.html`)).status).toBe(404);
      expect((await fetch(`${files.urlFor(origin, "pages")}/..%2Fsecret.json`)).status).toBe(404);
      expect(await (await fetch(files.urlFor(origin, "renders/x/__film/timeline.mjs"))).text()).toBe(await readFile(new URL("./vendor/timeline.mjs", import.meta.url), "utf8"));
    } finally {
      server.close();
    }
  });
});

function round3(value) { return Math.round(value * 1000) / 1000; }
