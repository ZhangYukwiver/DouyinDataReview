import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MediaLibrary } from "./library.mjs";
import { mergeCaptions, parseTranscript, placeLines, transcribePrompt } from "./transcribe.mjs";
import { createToolRunner } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "../fixtures/ai-edit/media");
const S = 1_000_000;

describe("parseTranscript", () => {
  it("reads the asked format, SRT blocks, clock times and code fences", () => {
    expect(parseTranscript("```\n1.2 --> 3.5 | 大家好\n3.6 --> 5 | “这家店”\n```", 10)).toEqual([
      { start: 1.2, end: 3.5, text: "大家好" },
      { start: 3.6, end: 5, text: "这家店" },
    ]);
    expect(parseTranscript("1\n00:00:01,200 --> 00:00:02,500\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句", 0)).toEqual([
      { start: 1.2, end: 2.5, text: "第一句" },
      { start: 3, end: 4, text: "第二句" },
    ]);
    // 分秒写法、全角竖线、乱序；超过视频长度的截到结尾，开头就超了的不要
    expect(parseTranscript("0:05.0 --> 0:06.5 ｜ 后一句\n0:01 --> 0:02 | 前一句\n9.5 --> 12 | 收尾\n13 --> 14 | 多出来的", 10)).toEqual([
      { start: 1, end: 2, text: "前一句" },
      { start: 5, end: 6.5, text: "后一句" },
      { start: 9.5, end: 10, text: "收尾" },
    ]);
  });

  it("knows silence, a model that cannot see or hear and an answer in the wrong shape", () => {
    for (const silent of ["NO_SPEECH", "NO_SPEECH。", "`NO_SPEECH`", "**NO_SPEECH**"]) expect(parseTranscript(silent)).toEqual([]);
    for (const blind of ["NO_VIDEO.", "NO_AUDIO", "抱歉，我听不到视频里的声音，只能看到画面。"]) {
      expect(() => parseTranscript(blind)).toThrow(expect.objectContaining({ code: "video_unsupported" }));
    }
    expect(() => parseTranscript("这段视频讲的是做菜。")).toThrow(expect.objectContaining({ code: "transcribe_unreadable" }));
    // 台词里出现 NO_SPEECH 这个词不算
    expect(parseTranscript("1 --> 2 | 他说 NO_SPEECH 是什么")).toEqual([{ start: 1, end: 2, text: "他说 NO_SPEECH 是什么" }]);
  });

  it("tolerates numbering, missing bars, units and bold, but never drops a timed line silently", () => {
    expect(parseTranscript("1. 1.2 --> 3.5 | 大家好\n2、3.6s --> 5.0s：这家店\n**5.1～6.0** 好吃\n- 6.1秒 -> 7秒 | 真的")).toEqual([
      { start: 1.2, end: 3.5, text: "大家好" },
      { start: 3.6, end: 5, text: "这家店" },
      { start: 5.1, end: 6, text: "好吃" },
      { start: 6.1, end: 7, text: "真的" },
    ]);
    // 看着像时间行却认不出来、一行写了两句：整份按没按格式写处理，不出一组缺句的字幕
    expect(() => parseTranscript("1.2 --> 3.5 | 大家好\n(3.6 --> 5.0) 这家店")).toThrow(expect.objectContaining({ code: "transcribe_unreadable" }));
    expect(() => parseTranscript("1.2 --> 3.5 | 第一句 3.6 --> 5.0 | 第二句")).toThrow(expect.objectContaining({ code: "transcribe_unreadable" }));
  });

  it("leaves out lines it could not make out and counts them", () => {
    const lines = parseTranscript("1 --> 2 | 你好\n2.5 --> 3 | （听不清）");
    expect([...lines]).toEqual([{ start: 1, end: 2, text: "你好" }]);
    expect(lines.unclear).toBe(1);
  });

  it("asks for one sentence per line with times from the start of the video", () => {
    const prompt = transcribePrompt(12.5);
    expect(prompt).toContain("开始 --> 结束 | 台词");
    expect(prompt).toContain("视频总长约 12.5 秒");
    expect(prompt).toContain("NO_SPEECH");
  });
});

describe("placing lines on the timeline", () => {
  it("keeps what the clip shows, follows the speed and drops sentences cut down to a sliver", () => {
    const segment = { timeline: { start_us: 10 * S, duration_us: 2 * S }, source: { start_us: 4 * S, duration_us: 4 * S }, speed: 2 };
    expect(placeLines([
      { start: 1, end: 3, text: "截掉了" },
      { start: 3.5, end: 5, text: "前半截被剪" },
      { start: 5, end: 7, text: "整句" },
      { start: 7.8, end: 9, text: "只剩一点" },
    ], segment)).toEqual([
      { start: 10, end: 10.5, text: "前半截被剪" },
      { start: 10.5, end: 11.5, text: "整句" },
    ]);
    // 整句都在片段里的短句不管多短都留下（3.3 - 3.0 浮点上略小于 0.3 也不算剪过）
    const whole = { timeline: { start_us: 0, duration_us: 10 * S }, source: { start_us: 0, duration_us: 10 * S }, speed: 1 };
    expect(placeLines([{ start: 3, end: 3.2, text: "对" }, { start: 3, end: 3.3, text: "好" }], whole).map((line) => line.text)).toEqual(["对", "好"]);
  });

  it("trims overlaps where clips meet and drops what gets too short", () => {
    expect(mergeCaptions([
      { start: 2, end: 3, text: "b" },
      { start: 0, end: 2.5, text: "a" },
      { start: 2.1, end: 4, text: "c" },
    ])).toEqual([
      { start: 0, end: 2, text: "a" },
      { start: 2.1, end: 4, text: "c" },
    ]);
  });
});

describe("transcribe_subtitles against the real project store", () => {
  async function setup({ answer = "0.2 --> 1.0 | 第一句\n1.2 --> 2.0 | 第二句\n2.2 --> 2.9 | 第三句", config = {} } = {}) {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-transcribe-"));
    const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
    await media.load();
    const upload = async (name) => (await media.upload(createReadStream(path.join(FIXTURES, name)), name)).id;
    const clip = await upload("clip-720p.mp4");
    const tone = await upload("tone.wav");
    const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
    const project = await store.createProject({ name: "转写", canvas: { width: 1080, height: 1920, fps: 30 } });
    const requests = [];
    const answers = Array.isArray(answer) ? [...answer] : [answer];
    const fetchImpl = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const next = answers.length > 1 ? answers.shift() : answers[0];
      const [content, finish] = Array.isArray(next) ? next : [next, "stop"];
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { headers: { "content-type": "application/json" } });
    };
    const busy = [];
    const ctx = {
      store, library: media, projectId: project.id, getCollector: () => null, fetchImpl, references: new Map(),
      config: { baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "doubao-seed-2-1-lite", ...config },
      onGenerating: (text) => busy.push(text),
    };
    const run = createToolRunner(ctx);
    const ok = async (name, args) => {
      const { result } = await run(name, args);
      expect(result, `${name} ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      return result;
    };
    const video = (await ok("create_track", { track_type: "video", name: "主画面" })).track_id;
    const audio = (await ok("create_track", { track_type: "audio", name: "配乐" })).track_id;
    return { directory, store, project, run, ok, requests, busy, clip, tone, video, audio };
  }

  it("hears the clip once, maps lines into the cut and builds one subtitle group", async () => {
    const { directory, store, project, run, ok, requests, busy, clip, tone, video, audio } = await setup();
    try {
      // 截取 0.5–2.5 秒、放在时间线 1 秒处；同一素材再放一段 2.0–2.8 秒（同一份转写，不再问模型）
      const first = (await ok("add_media_clip", { track_id: video, media_id: clip, start: 1, source_start: 0.5, duration: 2 })).clip_id;
      const second = (await ok("add_media_clip", { track_id: video, media_id: clip, start: 3, source_start: 1.1, duration: 0.9 })).clip_id;
      const music = (await ok("add_media_clip", { track_id: audio, media_id: tone, start: 0, duration: 1 })).clip_id;
      const { result, action } = await run("transcribe_subtitles", { clip_ids: [first, second, music] });
      expect(result).toMatchObject({ ok: true, track_id: expect.any(String), note: expect.stringContaining("转写了 3 句台词") });
      expect(result.note).toContain("是音频，现在只能转写视频里的声音");
      expect(action.summary).toBe("把 3 段视频里的台词转写成字幕");
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://ark.example.com/api/v3/chat/completions");
      const content = requests[0].body.messages[0].content;
      expect(content[0]).toMatchObject({ type: "video_url", video_url: { url: expect.stringMatching(/^data:video\/mp4;base64,/u) } });
      expect(content[1].text).toContain("开始 --> 结束 | 台词");
      expect(busy).toEqual([expect.stringContaining("正在听"), null]);
      const subtitles = (await store.getProject(project.id)).tracks.find((track) => track.id === result.track_id);
      expect(subtitles.kind).toBe("subtitle");
      // 第一段：第一句只剩 0.5–1.0（一半以上，留下）→ 1.0–1.5；第二句 → 1.7–2.5；第三句剩 0.3 秒、不到一半，丢掉；
      // 第二段：1.1–2.0 只盖到第二句 1.2–2.0 → 3.1–3.9
      expect(subtitles.segments.map((segment) => [segment.text, segment.timeline.start_us / S, (segment.timeline.start_us + segment.timeline.duration_us) / S])).toEqual([
        ["第一句", 1, 1.5],
        ["第二句", 1.7, 2.5],
        ["第二句", 3.1, 3.9],
      ]);
      expect(subtitles.segments[0].transform).toMatchObject({ transform_y: -0.8 });
      // 剪过以后再转写：用记住的那份
      await run("transcribe_subtitles", { clip_ids: [first] });
      expect(requests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("says so when nobody speaks, hears again next time, and refuses models that cannot hear", async () => {
    const silent = await setup({ answer: ["NO_SPEECH", "0.2 --> 1.5 | 其实有人说话"] });
    try {
      const id = (await silent.ok("add_media_clip", { track_id: silent.video, media_id: silent.clip, duration: 2 })).clip_id;
      const { result, action } = await silent.run("transcribe_subtitles", { clip_ids: [id] });
      expect(result).toMatchObject({ ok: true, note: expect.stringContaining("没听到有人说话") });
      expect(result).not.toHaveProperty("summary");
      expect(action).toMatchObject({ ok: true, summary: "没听到这些片段里的台词，没加字幕" });
      expect((await silent.store.getProject(silent.project.id)).tracks.some((track) => track.kind === "subtitle")).toBe(false);
      // 没听到的不记：再转写会重新问模型
      expect((await silent.run("transcribe_subtitles", { clip_ids: [id] })).result.note).toContain("转写了 1 句台词");
      expect(silent.requests).toHaveLength(2);
      // 记住了的，fresh 也能强制重听
      await silent.run("transcribe_subtitles", { clip_ids: [id], fresh: true });
      expect(silent.requests).toHaveLength(3);
      expect((await silent.run("transcribe_subtitles", { clip_ids: ["nope"] })).result).toMatchObject({ ok: false, code: "clip_not_found" });
    } finally {
      await rm(silent.directory, { recursive: true, force: true });
    }
    for (const config of [{ videoInput: false }, { runtime: "codex" }]) {
      const blind = await setup({ config });
      try {
        const id = (await blind.ok("add_media_clip", { track_id: blind.video, media_id: blind.clip, duration: 2 })).clip_id;
        expect((await blind.run("transcribe_subtitles", { clip_ids: [id] })).result).toMatchObject({ ok: false, code: "video_unsupported", message: expect.stringContaining("doubao-seed-2-1-lite") });
        expect(blind.requests).toEqual([]);
      } finally {
        await rm(blind.directory, { recursive: true, force: true });
      }
    }
  });
});

describe("transcribe_subtitles when things go partly wrong", () => {
  async function setup(answer) {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-transcribe-partly-"));
    const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
    await media.load();
    const clip = (await media.upload(createReadStream(path.join(FIXTURES, "clip-720p.mp4")), "clip-720p.mp4")).id;
    const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
    const project = await store.createProject({ name: "转写", canvas: { width: 1080, height: 1920, fps: 30 } });
    const requests = [];
    const answers = [...answer];
    const fetchImpl = async () => {
      const [content, finish] = answers.length > 1 ? answers.shift() : answers[0];
      requests.push(content);
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { headers: { "content-type": "application/json" } });
    };
    const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, fetchImpl, references: new Map(), config: { baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "seed" } });
    const video = (await run("create_track", { track_type: "video", name: "主画面" })).result.track_id;
    const id = (await run("add_media_clip", { track_id: video, media_id: clip, duration: 3 })).result.clip_id;
    return { directory, store, project, run, id, requests, video, clip };
  }

  it("drops the half-written last line of a cut-off answer, says how far it got and hears again next time", async () => {
    const cut = await setup([["0.2 --> 1.0 | 第一句\n1.2 --> 2.0 | 第二句\n2.2 --> 2.9", "length"], ["0.2 --> 1.0 | 第一句\n1.2 --> 2.0 | 第二句\n2.2 --> 2.9 | 第三句", "stop"]]);
    try {
      const { result } = await cut.run("transcribe_subtitles", { clip_ids: [cut.id] });
      expect(result.note).toContain("转写了 2 句台词");
      expect(result.note).toContain("只转写到素材第 0:02.0");
      const texts = (await cut.store.getProject(cut.project.id)).tracks.find((track) => track.kind === "subtitle").segments.map((segment) => segment.text);
      expect(texts).toEqual(["第一句", "第二句"]);
      // 截断的不记：再转写重新听，拿到完整的
      expect((await cut.run("transcribe_subtitles", { clip_ids: [cut.id] })).result.note).toContain("转写了 3 句台词");
      expect(cut.requests).toHaveLength(2);
    } finally {
      await rm(cut.directory, { recursive: true, force: true });
    }
  });

  it("names the clip when the model answers in the wrong shape, and says why nothing was added when the lines fall outside the cut", async () => {
    const messy = await setup([["这段视频里主持人在介绍美食。", "stop"]]);
    try {
      const { result } = await messy.run("transcribe_subtitles", { clip_ids: [messy.id] });
      expect(result).toMatchObject({ ok: true, note: expect.stringContaining("没转写的：视频“clip-720p.mp4”：模型有台词没按格式写出时间") });
    } finally {
      await rm(messy.directory, { recursive: true, force: true });
    }
    const outside = await setup([["0.1 --> 0.4 | 开场白", "stop"]]);
    try {
      const { run, video, clip } = outside;
      // 只截 1.5–2.5 秒那段：台词在 0.1–0.4 秒，被剪掉了
      const trimmed = (await run("add_media_clip", { track_id: video, media_id: clip, start: 4, source_start: 1.5, duration: 1 })).result.clip_id;
      const { result } = await run("transcribe_subtitles", { clip_ids: [trimmed] });
      expect(result.note).toContain("都不在这些片段截取的范围里");
      expect(result.note).not.toContain("听不到声音");
    } finally {
      await rm(outside.directory, { recursive: true, force: true });
    }
  });
});
