import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EditError, invalid } from "./errors.mjs";
import { MediaLibrary } from "./library.mjs";
import { TOOL_DEFINITIONS, TOOL_NAMES, buildContextMessage, buildSystemPrompt, createToolRunner, micros, timelineSummary } from "./tools.mjs";

// 按本机格式生成（Windows 上带盘符和反斜杠），和素材库 path.join 出来的路径对得上
const ROOT = path.resolve("/data/ai-edit/media");
const VIDEO_ID = "a".repeat(32);
const IMAGE_ID = "b".repeat(32);
const AUDIO_ID = "c".repeat(32);
const IMPORTING_ID = "d".repeat(32);

function library() {
  const media = new MediaLibrary({ directory: ROOT, probe: async () => ({}), kindOf: () => "video" });
  media.root = ROOT;
  const item = (id, kind, fields) => ({ id, kind, status: "ready", error: null, durationUs: null, width: null, height: null, hasAudio: false, size: 1, createdAt: "2026-10-19T00:00:00.000Z", source: { type: "local" }, file: `${id}.${kind === "audio" ? "mp3" : kind === "image" ? "png" : "mp4"}`, ...fields });
  media.items = [
    item(VIDEO_ID, "video", { name: "海边.mp4", durationUs: 10_000_000, width: 1080, height: 1920, hasAudio: true }),
    item(IMAGE_ID, "image", { name: "封面.png", width: 800, height: 600 }),
    item(AUDIO_ID, "audio", { name: "配乐.mp3", durationUs: 30_000_000 }),
    item(IMPORTING_ID, "video", { name: "下载中", status: "importing", source: { type: "douyin", url: "https://www.douyin.com/video/1" } }),
  ];
  return media;
}

function project() {
  return {
    id: "p".repeat(32),
    name: "旅行",
    canvas: { width: 1080, height: 1920, fps: 30 },
    created_at: "2026-10-19T00:00:00Z",
    updated_at: "2026-10-19T00:00:00Z",
    revision: 3,
    tracks: [
      {
        id: "t1", track_type: "video", name: "Video", mute: false,
        segments: [{
          id: "s1", kind: "video", path: path.join(ROOT, `${VIDEO_ID}.mp4`), timeline: { start_us: 0, duration_us: 4_000_000 },
          source: { start_us: 1_000_000, duration_us: 4_000_000 }, volume: 1, speed: 1, fit: "contain", transform: null,
          material_name: "海边.mp4", keyframes: [{ property: "alpha", offset_us: 500_000, value: 0.5 }], effects: [], filters: [],
          animations: [{ animation_type: "渐显", duration_us: null }], transition: { transition_type: "叠化", duration_us: 500_000 }, fade: null,
        }],
      },
      { id: "t2", track_type: "text", name: "Text", mute: false, segments: [{ id: "s2", kind: "text", text: "你好", timeline: { start_us: 1_000_000, duration_us: 2_000_000 } }] },
    ],
    markers: [{ time_us: 2_500_000, label: "高潮", color: "#FFFFFF" }],
    draft: null,
  };
}

/** 记下每次调用的假 ProjectStore：写方法回一个多了新片段的工程。 */
function recordingStore() {
  const calls = [];
  const base = project();
  const store = new Proxy({}, {
    get(_target, name) {
      if (name === "then") return undefined;
      return async (...args) => {
        calls.push({ name, args });
        if (name === "getProject") return structuredClone(base);
        if (name === "getSegment") return structuredClone(base.tracks[0].segments[0]);
        if (name === "listKeyframes") return { segment_id: args[1], keyframes: [{ property: "alpha", offset_us: 500_000, value: 0.5 }] };
        if (name === "listMarkers") return structuredClone(base.markers);
        const next = structuredClone(base);
        next.tracks[0].segments.push({ id: `new-${calls.length}`, kind: "video", path: path.join(ROOT, `${VIDEO_ID}.mp4`), timeline: { start_us: 4_000_000, duration_us: 1_000_000 }, source: { start_us: 0, duration_us: 1_000_000 } });
        if (name === "createTrack") next.tracks.push({ id: "t-new", track_type: "audio", name: "Audio", mute: false, segments: [] });
        return name === "splitSegment" ? { project: next, segments: [] } : next;
      };
    },
  });
  return { store, calls };
}

function runnerWith(overrides = {}) {
  const { store, calls } = recordingStore();
  const media = library();
  const run = createToolRunner({
    store, library: media, projectId: "p".repeat(32), getCollector: () => null,
    exportDraft: async () => ({ draftId: "D", draftName: "旅行", path: "/x", created: true }),
    ...overrides,
  });
  return { run, calls, media };
}

const SAMPLE_ARGS = {
  get_timeline: {},
  list_media: {},
  search_catalog: { kind: "transition", query: "叠化" },
  get_clip: { clip_id: "s1" },
  rename_project: { name: "新名字" },
  set_canvas: { fps: 60 },
  create_track: { track_type: "audio" },
  update_track: { track_id: "t1", mute: true },
  delete_track: { track_id: "t2" },
  reorder_tracks: { track_ids: ["t2", "t1"] },
  add_media_clip: { track_id: "t1", media_id: VIDEO_ID, start: 4, duration: 1 },
  add_text_clip: { track_id: "t2", text: "标题", start: 0, duration: 1.5, color: "#ff0000" },
  add_sticker_clip: { track_id: "t1", resource_id: "123", start: 0, duration: 1 },
  add_track_effect: { track_id: "t1", effect_type: "_1998", start: 0, duration: 1 },
  add_track_filter: { track_id: "t1", filter_type: "_1980", start: 0, duration: 1, intensity: 50 },
  update_clip: { clip_id: "s1", volume: 0.5 },
  move_clip: { clip_id: "s1", start: 1.25 },
  split_clip: { clip_id: "s1", offset: 2 },
  delete_clip: { clip_id: "s1" },
  add_keyframes: { clip_id: "s1", keyframes: [{ property: "alpha", offset: 0, value: 0 }, { property: "alpha", offset: 1.5, value: 1 }] },
  list_keyframes: { clip_id: "s1" },
  remove_keyframe: { clip_id: "s1", property: "alpha", offset: 0.5 },
  add_effect: { clip_id: "s1", effect_type: "_1998", params: [50] },
  add_filter: { clip_id: "s1", filter_type: "_1980" },
  add_animation: { clip_id: "s1", animation_type: "渐隐", duration: 0.8 },
  add_transition: { clip_id: "s1", transition_type: "叠化", duration: 0.5 },
  add_fade: { clip_id: "s1", fade_in: 0.3, fade_out: 0.4 },
  add_mask: { clip_id: "s1", mask_type: "圆形", size: 0.6 },
  add_chroma: { clip_id: "s1", color: "#00FF00FF" },
  add_background_filling: { clip_id: "s1", fill_type: "blur", blur: 0.2 },
  set_mix_mode: { clip_id: "s1", mode: "滤色" },
  clear_clip_feature: { clip_id: "s1", feature: "transition" },
  add_marker: { time: 3.5, label: "转折" },
  list_markers: {},
  remove_marker: { time: 2.5 },
  add_subtitles: { captions: [{ start: 0, end: 1.5, text: "第一句" }, { start: 61.25, end: 3725.004, text: "第二句" }] },
  remove_subtitles: { track_id: "t2" },
  export_to_jianying: {},
};

// ProjectStore 的全部编辑方法都得有工具能调到（createProject / deleteProject / listProjects / mediaInfos 由宿主自己用）
const EDIT_METHODS = [
  "updateProject", "setCanvas", "createTrack", "updateTrack", "deleteTrack", "reorderTracks", "addMediaSegment", "addTextSegment",
  "addStickerSegment", "addTrackEffectSegment", "addTrackFilterSegment", "updateSegment", "moveSegment", "deleteSegment", "splitSegment",
  "getSegment", "addKeyframes", "listKeyframes", "removeKeyframe", "addEffect", "addFilter", "addAnimation", "addTransition", "addFade",
  "clearFeature", "addMask", "addChroma", "addBackgroundFilling", "setMixMode", "addMarker", "listMarkers", "removeMarker",
  "addSrtSubtitles", "removeSubtitleGroup",
];

describe("AI edit tools", () => {
  it("cover every ProjectStore edit method and convert seconds and media ids", async () => {
    const { run, calls } = runnerWith();
    const offline = new Set(["search_my_records", "import_douyin_video", "search_douyin", "analyze_reference"]);
    expect(TOOL_NAMES.filter((name) => !offline.has(name)).sort()).toEqual(Object.keys(SAMPLE_ARGS).sort());
    for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
      const { result, action } = await run(name, JSON.stringify(args));
      expect(result, name).toMatchObject({ ok: true });
      expect(action.ok, name).toBe(true);
    }
    const called = new Set(calls.map((call) => call.name));
    expect(EDIT_METHODS.filter((method) => !called.has(method))).toEqual([]);
    const projectId = "p".repeat(32);
    const call = (name) => calls.find((item) => item.name === name).args;
    expect(call("addMediaSegment")).toEqual([projectId, "t1", {
      path: path.join(ROOT, `${VIDEO_ID}.mp4`), timeline: { start_us: 4_000_000, duration_us: 1_000_000 }, material_name: "海边.mp4",
    }]);
    expect(call("addTextSegment")).toEqual([projectId, "t2", { text: "标题", color: "#ff0000", timeline: { start_us: 0, duration_us: 1_500_000 } }]);
    expect(call("addTrackFilterSegment")[2]).toEqual({ filter_type: "_1980", intensity: 50, timeline: { start_us: 0, duration_us: 1_000_000 } });
    expect(call("moveSegment")).toEqual([projectId, "s1", 1_250_000]);
    expect(call("splitSegment")).toEqual([projectId, "s1", 2_000_000]);
    expect(call("addKeyframes")[2]).toEqual({ keyframes: [{ property: "alpha", value: 0, offset_us: 0 }, { property: "alpha", value: 1, offset_us: 1_500_000 }] });
    expect(call("removeKeyframe")).toEqual([projectId, "s1", "alpha", 500_000]);
    expect(call("addAnimation")[2]).toEqual({ animation_type: "渐隐", duration_us: 800_000 });
    expect(call("addTransition")[2]).toEqual({ transition_type: "叠化", duration_us: 500_000 });
    expect(call("addFade")[2]).toEqual({ in_duration_us: 300_000, out_duration_us: 400_000 });
    expect(call("addMarker")[1]).toEqual({ time_us: 3_500_000, label: "转折" });
    expect(call("removeMarker")).toEqual([projectId, 2_500_000]);
    expect(call("setCanvas")[1]).toEqual({ width: 1080, height: 1920, fps: 60 });
    expect(call("addSrtSubtitles")).toEqual([projectId, "1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:01:01,250 --> 01:02:05,004\n第二句", { groupId: expect.stringMatching(/^[0-9a-f]{32}$/u) }]);
    expect(call("clearFeature")).toEqual([projectId, "s1", "transition"]);
    expect(call("updateSegment")).toEqual([projectId, "s1", { volume: 0.5 }]);
  });

  it("fills in a media clip's start, length and source from the track and the media", async () => {
    const { run, calls } = runnerWith();
    await run("add_media_clip", { track_id: "t1", media_id: VIDEO_ID, source_start: 2, speed: 2 });
    expect(calls.find((call) => call.name === "addMediaSegment").args[2]).toEqual({
      path: path.join(ROOT, `${VIDEO_ID}.mp4`),
      // 接在轨道末尾（4 秒），素材剩下 8 秒，2 倍速占 4 秒
      timeline: { start_us: 4_000_000, duration_us: 4_000_000 },
      source: { start_us: 2_000_000, duration_us: 8_000_000 },
      speed: 2,
      material_name: "海边.mp4",
    });
    calls.length = 0;
    await run("add_media_clip", { track_id: "missing", media_id: IMAGE_ID, material_name: "图" });
    expect(calls.find((call) => call.name === "addMediaSegment").args[2]).toEqual({
      path: path.join(ROOT, `${IMAGE_ID}.png`), timeline: { start_us: 0, duration_us: 3_000_000 }, material_name: "图",
    });
  });

  it("keeps the rest of a clip's timing when only part of it changes", async () => {
    const { run, calls } = runnerWith();
    await run("update_clip", { clip_id: "s1", duration: 2.5, source_start: "1.5", media_id: AUDIO_ID });
    expect(calls.find((call) => call.name === "updateSegment").args[2]).toEqual({
      timeline: { start_us: 0, duration_us: 2_500_000 },
      source: { start_us: 1_500_000, duration_us: 4_000_000 },
      path: path.join(ROOT, `${AUDIO_ID}.mp3`),
      material_name: "配乐.mp3",
    });
    calls.length = 0;
    await run("update_clip", { clip_id: "s1", transform: null, speed: "1.5" });
    expect(calls.find((call) => call.name === "updateSegment").args[2]).toEqual({ transform: null, speed: 1.5 });
  });

  it("reports what was created", async () => {
    const { run } = runnerWith();
    expect((await run("create_track", { track_type: "audio" })).result).toEqual({ ok: true, track_id: "t-new", clip_id: expect.stringMatching(/^new-/u), total_duration: 5 });
    const { result, action } = await run("add_text_clip", { track_id: "t2", text: "一句很长很长很长很长的标题文字", duration: 1 });
    expect(result.clip_id).toMatch(/^new-/u);
    expect(action).toEqual({ name: "add_text_clip", summary: "加了文字「一句很长很长很长很长的标…」", ok: true });
    expect((await run("add_subtitles", { captions: [{ start: 0, end: 1, text: "a" }] })).action.summary).toBe("加了 1 条字幕");
  });

  it("hands errors back to the model and gives the page a Chinese note", async () => {
    const failing = new Proxy({}, { get: (_target, name) => name === "then" ? undefined : async () => {
      if (name === "getProject") return project();
      throw invalid("TIMELINE_OVERLAP", "Clips overlap on the track", { track_id: "t1" });
    } });
    const { run } = runnerWith({ store: failing });
    expect(await run("move_clip", { clip_id: "s1", start: 1 })).toEqual({
      result: { ok: false, code: "TIMELINE_OVERLAP", message: "Clips overlap on the track", details: { track_id: "t1" } },
      action: { name: "move_clip", summary: "移动了片段", ok: false, error: "和同一轨道上的片段时间重叠了" },
      changed: false,
    });
    const notFound = await run("delete_clip", { clip_id: "x" });
    expect(notFound.result.ok).toBe(false);

    const fresh = runnerWith();
    expect((await fresh.run("add_media_clip", { track_id: "t1", media_id: IMPORTING_ID })).result).toMatchObject({ ok: false, code: "media_not_ready" });
    expect((await fresh.run("add_media_clip", { track_id: "t1", media_id: "nope" })).result).toMatchObject({ ok: false, code: "media_not_found" });
    expect((await fresh.run("add_media_clip", "{bad json")).result).toMatchObject({ ok: false, code: "arguments_invalid" });
    expect((await fresh.run("add_media_clip", { track_id: "t1" })).result).toEqual({ ok: false, code: "arguments_invalid", message: "缺少参数：media_id。" });
    expect((await fresh.run("make_coffee", {})).result).toMatchObject({ ok: false, code: "unknown_tool" });
    expect((await fresh.run("add_subtitles", { captions: [{ start: 0, end: "x", text: "a" }] })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
    expect((await fresh.run("search_catalog", { kind: "stickers" })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
  });

  it("tells the model why a link cannot be imported", async () => {
    const { run } = runnerWith({ getCollector: () => ({ startVideoDownload() { throw new Error("should not download"); }, getSnapshot: () => ({ records: {} }) }) });
    for (const url of ["https://example.com/video/1", "https://www.douyin.com/user/abc"]) {
      const { result, action } = await run("import_douyin_video", { url });
      expect(result).toMatchObject({ ok: false, code: "invalid_url", message: expect.stringMatching(/抖音/u) });
      expect(action.error).toBe(result.message);
    }
  });

  it("finds Jianying names in the catalog", async () => {
    const { run } = runnerWith();
    const { result } = await run("search_catalog", { kind: "transition", query: "叠化" });
    expect(result.items.map((item) => item.name)).toContain("叠化");
    expect(result.items.find((item) => item.name === "叠化")).toMatchObject({ default_duration: expect.any(Number) });
    const effects = (await run("search_catalog", { kind: "video_effect", query: "1998", limit: 3 })).result;
    expect(effects.items[0]).toMatchObject({ name: "_1998", display: "1998", params: expect.arrayContaining(["effects_adjust_filter"]) });
    const fonts = (await run("search_catalog", { kind: "font" })).result;
    expect(fonts.items).toHaveLength(20);
    expect(fonts.total).toBeGreaterThan(20);
    expect(fonts.note).toBeTruthy();
  });

  it("searches the user's own records by keyword and source", async () => {
    const record = (id, fields) => ({ id, title: `视频${id}`, author: "某人", occurredAt: `2026-10-0${id}T00:00:00.000Z`, url: `https://www.douyin.com/video/${id}`, videoId: id, ...fields });
    const snapshot = {
      records: {
        liked_videos: [record("1", { title: "海边日落 vlog", topics: ["旅行"] }), record("2", { title: "猫", mediaType: "image" })],
        favorite_videos: [record("1", { title: "海边日落 vlog" }), record("3", { title: "城市夜景", author: "旅行家" })],
        watch_history: [record("4", { title: "直播", mediaType: "live" }), record("5", { title: "做饭" })],
      },
    };
    const { run } = runnerWith({ getCollector: () => ({ getSnapshot: () => snapshot }) });
    const travel = (await run("search_my_records", { query: "旅行" })).result;
    expect(travel.videos.map((video) => video.title)).toEqual(["城市夜景", "海边日落 vlog"]);
    expect(travel.videos[1]).toMatchObject({ url: "https://www.douyin.com/video/1", from: "点赞", topics: ["旅行"], date: "2026-10-01" });
    const all = (await run("search_my_records", { source: "liked" })).result;
    expect(all.videos.map((video) => video.title)).toEqual(["猫", "海边日落 vlog"]);
    expect(all.videos[0]).toMatchObject({ image_post: true });
    expect((await run("search_my_records", { query: "直播" })).result.total).toBe(0);
    const busy = runnerWith().run;
    expect((await busy("search_my_records", {})).result).toMatchObject({ ok: false, code: "collector_busy" });
  });

  it("describes the timeline and media in seconds for the system prompt", () => {
    const media = library();
    const summary = timelineSummary(project(), media);
    expect(summary.duration).toBe(4);
    expect(summary.tracks[0]).toMatchObject({ track_id: "t1", type: "video", layer: 1 });
    expect(summary.tracks[0].clips[0]).toEqual({
      clip_id: "s1", kind: "video", start: 0, duration: 4, end: 4, media_id: VIDEO_ID, name: "海边.mp4", source_start: 1, source_duration: 4,
      animations: ["渐显"], transition: { type: "叠化", duration: 0.5 }, keyframes: 1,
    });
    expect(summary.markers).toEqual([{ time: 2.5, label: "高潮" }]);
    const prompt = buildSystemPrompt({ project: project(), media: media.list(), library: media });
    expect(prompt).toContain("画布 1080×1920（竖屏），30 帧/秒。");
    expect(prompt).toContain(`- ${VIDEO_ID}｜视频｜海边.mp4｜10 秒｜1080×1920｜有声音`);
    expect(prompt).toContain("（还在导入）");
    expect(prompt).toContain("search_catalog");
    expect(prompt).toContain("先用 search_douyin 搜");
    expect(prompt).toContain("别人的视频只当参考，不要导入");
    expect(prompt).toContain("越靠后的轨道越在上层");
    expect(prompt).toContain("所有时间参数都用秒");
    expect(prompt).toContain("\"transform\": {\"transform_y\": -0.8}");
    // 每做一步都会变的总时长和时间线不放系统提示（否则接口的前缀缓存一轮里都命中不了），附在最后一条
    expect(prompt).not.toContain("当前总时长 4 秒");
    expect(prompt).not.toContain("\"clip_id\":\"s1\"");
    const changed = project();
    changed.tracks[0].segments[0].timeline.duration_us = 9_000_000;
    expect(buildSystemPrompt({ project: changed, media: media.list(), library: media })).toBe(prompt);
    const context = buildContextMessage({ project: project(), library: media });
    expect(context).toContain("当前总时长 4 秒");
    expect(context).toContain("\"clip_id\":\"s1\"");
    expect(context).toContain("不是用户说的话");
  });

  it("only uses plain JSON-schema tool definitions", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.type).toBe("function");
      expect(definition.function.parameters.type).toBe("object");
      expect(definition.function.name).toMatch(/^[a-z_]+$/u);
    }
    expect(micros(1.0000004)).toBe(1_000_000);
    expect(micros("2.5")).toBe(2_500_000);
    expect(micros("abc")).toBe("abc");
    expect(new EditError("X", "y")).toBeInstanceOf(Error);
  });
});

// 模块 B、C 在时：每个工具都对真实的工程库跑一遍，确认拼出来的请求体它都收
const HERE = path.dirname(fileURLToPath(import.meta.url));
describe.runIf(["projectStore.mjs", "media.mjs"].every((name) => existsSync(path.join(HERE, name))))("AI edit tools against the real project store", () => {
  it("drives every editing tool successfully", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-tools-"));
    try {
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
      await media.load();
      const fixtures = path.join(HERE, "../fixtures/ai-edit/media");
      const upload = async (name) => (await media.upload(createReadStream(path.join(fixtures, name)), name)).id;
      const clip = await upload("clip-720p.mp4");
      const still = await upload("still.png");
      const tone = await upload("tone.wav");
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
      const project = await store.createProject({ name: "工具全测", canvas: { width: 1080, height: 1920, fps: 30 } });
      const exported = [];
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => { exported.push(true); return { draftName: "工具全测", created: true }; } });
      const ok = async (name, args) => {
        const { result } = await run(name, args);
        expect(result, `${name} ${JSON.stringify(result)}`).toMatchObject({ ok: true });
        return result;
      };
      const video = (await ok("create_track", { track_type: "video", name: "主画面" })).track_id;
      const overlay = (await ok("create_track", { track_type: "video", name: "画中画" })).track_id;
      const audio = (await ok("create_track", { track_type: "audio", name: "配乐" })).track_id;
      const text = (await ok("create_track", { track_type: "text", name: "标题" })).track_id;
      const sticker = (await ok("create_track", { track_type: "sticker", name: "贴纸" })).track_id;
      const effects = (await ok("create_track", { track_type: "effect", name: "特效" })).track_id;
      const filters = (await ok("create_track", { track_type: "filter", name: "滤镜" })).track_id;
      const first = (await ok("add_media_clip", { track_id: video, media_id: clip, duration: 2, source_start: 0.5, fit: "cover" })).clip_id;
      const second = (await ok("add_media_clip", { track_id: video, media_id: still, duration: 1.5 })).clip_id;
      const pip = (await ok("add_media_clip", { track_id: overlay, media_id: clip, start: 0.5, speed: 2, transform: { scale_x: 0.4, scale_y: 0.4, transform_x: 0.5, transform_y: 0.5 } })).clip_id;
      const music = (await ok("add_media_clip", { track_id: audio, media_id: tone, start: 0, volume: 0.6 })).clip_id;
      const title = (await ok("add_text_clip", { track_id: text, text: "海边", start: 0, duration: 2, font_size: 12, color: "#FFCC00", bold: true, border: { color: "#000000", width: 30 }, shadow: { distance: 4 }, background: { color: "#00000080" } })).clip_id;
      await ok("add_sticker_clip", { track_id: sticker, resource_id: "7107531263325474341", start: 0, duration: 1 });
      await ok("add_track_effect", { track_id: effects, effect_type: "_1998", params: [50], start: 0, duration: 1 });
      await ok("add_track_filter", { track_id: filters, filter_type: "_1980", intensity: 60, start: 0, duration: 3.5 });
      await ok("update_clip", { clip_id: first, volume: 0.8, crop: { upper_left_x: 0.1, lower_left_x: 0.1 } });
      await ok("update_clip", { clip_id: title, text: "海边的一天", alignment: "left" });
      await ok("update_clip", { clip_id: second, duration: 2 });
      await ok("move_clip", { clip_id: pip, start: 1 });
      const halves = (await ok("split_clip", { clip_id: music, offset: 1 })).clip_ids;
      expect(halves).toHaveLength(2);
      await ok("delete_clip", { clip_id: halves[1] });
      await ok("add_keyframes", { clip_id: second, keyframes: [{ property: "uniform_scale", offset: 0, value: 1 }, { property: "uniform_scale", offset: 2, value: 1.3 }, { property: "alpha", offset: 1, value: 0.5 }] });
      expect((await ok("list_keyframes", { clip_id: second })).keyframes).toHaveLength(3);
      await ok("remove_keyframe", { clip_id: second, property: "alpha", offset: 1 });
      await ok("add_effect", { clip_id: first, effect_type: "_1998" });
      await ok("add_filter", { clip_id: first, filter_type: "_1980", intensity: 80 });
      await ok("add_animation", { clip_id: first, animation_type: (await ok("search_catalog", { kind: "video_intro", limit: 1 })).items[0].name, duration: 0.5 });
      await ok("add_animation", { clip_id: title, animation_type: (await ok("search_catalog", { kind: "text_intro", limit: 1 })).items[0].name });
      await ok("add_transition", { clip_id: first, transition_type: "叠化", duration: 0.4 });
      await ok("add_fade", { clip_id: halves[0], fade_in: 0.2, fade_out: 0.2 });
      await ok("add_mask", { clip_id: pip, mask_type: (await ok("search_catalog", { kind: "mask", query: "圆" })).items[0].name, size: 0.6, feather: 10 });
      await ok("add_chroma", { clip_id: second, color: "#00FF00FF", intensity: 30 });
      await ok("add_background_filling", { clip_id: first, fill_type: "blur", blur: 0.2 });
      await ok("set_mix_mode", { clip_id: pip, mode: (await ok("search_catalog", { kind: "mix_mode", limit: 1 })).items[0].name });
      await ok("clear_clip_feature", { clip_id: first, feature: "filters" });
      await ok("add_marker", { time: 1.5, label: "转折", color: "#FF0000" });
      expect((await ok("list_markers", {})).markers).toEqual([{ time: 1.5, label: "转折", color: "#FF0000" }]);
      await ok("remove_marker", { time: 1.5 });
      const subtitles = await ok("add_subtitles", { captions: [{ start: 0, end: 1.2, text: "第一句" }, { start: 1.2, end: 2.5, text: "第二句" }] });
      expect(subtitles.clip_count).toBe(2);
      await ok("remove_subtitles", { track_id: subtitles.track_id });
      await ok("update_track", { track_id: audio, mute: true, name: "背景音乐" });
      const timeline = await ok("get_timeline", {});
      await ok("reorder_tracks", { track_ids: [...timeline.tracks.map((track) => track.track_id)].reverse() });
      await ok("delete_track", { track_id: sticker });
      await ok("set_canvas", { width: 1920, height: 1080 });
      await ok("rename_project", { name: "工具全测改名" });
      expect((await ok("get_clip", { clip_id: pip })).clip).toMatchObject({ clip_id: pip, media_id: clip, timeline: { start: 1, duration: 1.5 }, speed: 2 });
      await ok("export_to_jianying", {});
      expect(exported).toHaveLength(1);

      const final = await store.getProject(project.id);
      expect(final).toMatchObject({ name: "工具全测改名", canvas: { width: 1920, height: 1080, fps: 30 } });
      expect(final.tracks.map((track) => track.name)).toEqual(["滤镜", "特效", "标题", "背景音乐", "画中画", "主画面"]);
      const summary = timelineSummary(final, media);
      expect(summary.duration).toBe(4);
      expect(summary.tracks.at(-1).clips[0]).toMatchObject({ media_id: clip, source_start: 0.5, fit: "cover", effects: ["_1998"], transition: { type: "叠化", duration: 0.4 }, background_filling: "blur", crop: true });
      // 改错了的调用要把原仓库的错误码回给模型
      const overlap = await run("add_media_clip", { track_id: video, media_id: clip, start: 0, duration: 1 });
      expect(overlap.result).toMatchObject({ ok: false, code: "TIMELINE_OVERLAP" });
      expect(overlap.action.error).toBe("和同一轨道上的片段时间重叠了");
      const wrongTrack = await run("add_media_clip", { track_id: video, media_id: tone });
      expect(wrongTrack.result).toMatchObject({ ok: false, code: "MEDIA_TRACK_MISMATCH" });
      const tooLong = await run("add_media_clip", { track_id: overlay, media_id: clip, start: 5, duration: 10 });
      expect(tooLong.result).toMatchObject({ ok: false, code: "SOURCE_RANGE_INVALID" });
      const bad = await run("add_text_clip", { track_id: text, text: "x", duration: -1 });
      expect(bad.result).toMatchObject({ ok: false, code: "VALIDATION_ERROR", details: { errors: expect.any(Array) } });
      const unknown = await run("add_filter", { clip_id: first, filter_type: "不存在的滤镜" });
      expect(unknown.result).toMatchObject({ ok: false, code: "DRAFT_FEATURE_INVALID" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("stops Jianying-only rule breaks at edit time, so the project still exports", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const { draftInputs, serializeDraft } = await import("./draft.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-tools-rules-"));
    try {
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
      await media.load();
      const fixtures = path.join(HERE, "../fixtures/ai-edit/media");
      const upload = async (name) => (await media.upload(createReadStream(path.join(fixtures, name)), name)).id;
      const [clip, still, tone] = [await upload("clip-720p.mp4"), await upload("still.png"), await upload("tone.wav")];
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
      const project = await store.createProject({ name: "规则", canvas: { width: 1080, height: 1920, fps: 30 } });
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => ({}) });
      const ok = async (name, args) => {
        const { result } = await run(name, args);
        expect(result, `${name} ${JSON.stringify(result)}`).toMatchObject({ ok: true });
        return result;
      };
      const refused = async (name, args, code) => {
        const { result, action } = await run(name, args);
        expect(result, `${name} ${JSON.stringify(result)}`).toMatchObject({ ok: false, code });
        return { result, action };
      };
      const video = (await ok("create_track", { track_type: "video" })).track_id;
      const audio = (await ok("create_track", { track_type: "audio" })).track_id;
      const text = (await ok("create_track", { track_type: "text" })).track_id;
      const first = (await ok("add_media_clip", { track_id: video, media_id: clip, duration: 2 })).clip_id;
      const picture = (await ok("add_media_clip", { track_id: video, media_id: still, duration: 1 })).clip_id;
      const sound = (await ok("add_media_clip", { track_id: audio, media_id: tone, start: 0 })).clip_id;
      const title = (await ok("add_text_clip", { track_id: text, text: "标题", duration: 2 })).clip_id;

      // 换动画不先去掉：同一种第二个、组合配入场、文字先循环后入场都要当场拦下
      await ok("add_animation", { clip_id: first, animation_type: "上下抖动" });
      const twice = await refused("add_animation", { clip_id: first, animation_type: "动感放大" }, "ANIMATION_EXISTS");
      expect(twice.result.message).toContain("clear_clip_feature");
      expect(twice.action.error).toBe("片段已经有同一种动画了，要先去掉");
      await refused("add_animation", { clip_id: first, animation_type: "三分割" }, "ANIMATION_CONFLICT");
      await ok("add_animation", { clip_id: first, animation_type: "渐隐" });
      await ok("add_animation", { clip_id: title, animation_type: "上弧" });
      await refused("add_animation", { clip_id: title, animation_type: (await ok("search_catalog", { kind: "text_intro", limit: 1 })).items[0].name }, "ANIMATION_ORDER");
      // 同类音效、视频上的音频特效
      await ok("add_effect", { clip_id: sound, effect_type: "台湾小哥" });
      await refused("add_effect", { clip_id: sound, effect_type: "圣诞精灵" }, "AUDIO_EFFECT_EXISTS");
      await ok("add_effect", { clip_id: sound, effect_type: "_8bit" });
      const voice = await refused("add_effect", { clip_id: first, effect_type: "台湾小哥" }, "EFFECT_CLIP_MISMATCH");
      expect(voice.action.error).toBe("这种片段不能用这个特效");
      await refused("add_effect", { clip_id: sound, effect_type: "_1998" }, "EFFECT_CLIP_MISMATCH");
      // 只有矩形蒙版能带圆角和宽度
      await refused("add_mask", { clip_id: picture, mask_type: "圆形", round_corner: 0 }, "MASK_PARAMS_INVALID");
      await ok("add_mask", { clip_id: picture, mask_type: "矩形", round_corner: 20, rect_width: 0.5 });
      // 字体要在剪映的字体目录里
      await refused("add_text_clip", { track_id: text, text: "x", duration: 1, font_family: "微软雅黑" }, "FONT_INVALID");
      await refused("update_clip", { clip_id: title, font_family: "微软雅黑" }, "FONT_INVALID");
      await ok("update_clip", { clip_id: title, font_family: "A1明朝" });
      // 图片在剪映里最长 3 小时
      await refused("update_clip", { clip_id: picture, duration: 3 * 3600 + 1 }, "IMAGE_TOO_LONG");
      await refused("add_media_clip", { track_id: video, media_id: still, duration: 3 * 3600 + 1 }, "IMAGE_TOO_LONG");

      // 剩下的都过了剪映那一关：草稿照样生成得出来
      const final = await store.getProject(project.id);
      expect(() => serializeDraft({ project: final, ...draftInputs(final), media: [] })).toThrow(expect.objectContaining({ code: "MEDIA_NOT_FOUND" }));
      const content = serializeDraft({ project: final, ...draftInputs(final), media: await store.mediaInfos(final) });
      expect(content).toContain("上弧");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses misplaced or unknown arguments, treats null as not given and styles subtitles as a group", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-tools-args-"));
    try {
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
      await media.load();
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
      const project = await store.createProject({ name: "参数", canvas: { width: 1080, height: 1920, fps: 30 } });
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => ({}) });
      const segment = async (id) => store.getSegment(project.id, id);

      // 可选参数给 null 当没给
      const text = (await run("create_track", { track_type: "text", name: null, mute: null })).result;
      expect(text).toMatchObject({ ok: true });
      const late = (await run("add_text_clip", { track_id: text.track_id, text: "后", start: 3, duration: 1 })).result.clip_id;
      const appended = await run("add_text_clip", { track_id: text.track_id, text: "接着", start: null, duration: 1, color: null, bold: null });
      expect(appended.result).toMatchObject({ ok: true });
      expect((await segment(appended.result.clip_id)).timeline.start_us).toBe(4_000_000);

      // 写错地方的参数不能悄悄丢掉、还回 ok
      const before = await store.getProject(project.id);
      const misplaced = await run("add_text_clip", { track_id: text.track_id, text: "底部字幕", duration: 2, transform_y: -0.8, font_color: "#FF0000" });
      expect(misplaced.result).toMatchObject({ ok: false, code: "arguments_invalid", message: expect.stringContaining("transform_y、font_color") });
      expect(misplaced.result.message).toContain("transform 对象里");
      expect(misplaced.result.message).toContain("color");
      expect(misplaced.action).toMatchObject({ ok: false, error: "参数写错了" });
      expect((await run("update_clip", { clip_id: late, scale: 2 })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
      expect((await run("update_clip", { clip_id: late, end: 5 })).result.message).toContain("duration");
      expect((await run("add_keyframes", { clip_id: late, keyframes: [{ property: "alpha", time: 0, value: 1 }] })).result)
        .toMatchObject({ ok: false, code: "arguments_invalid", message: expect.stringContaining("keyframes[0].time") });
      expect((await store.getProject(project.id)).revision).toBe(before.revision);
      // update_clip 的 transform 仍然可以用 null 清除
      await run("update_clip", { clip_id: late, transform: { transform_y: 0.5 } });
      expect((await run("update_clip", { clip_id: late, transform: null })).result).toMatchObject({ ok: true });
      expect((await segment(late)).transform).toBeNull();

      // 字幕默认整组放在画面下方，样式参数一次套到每一条
      const subtitles = (await run("add_subtitles", { captions: [{ start: 0, end: 1, text: "一" }, { start: 1, end: 2, text: "二" }, { start: 2, end: 3, text: "三" }] })).result;
      expect(subtitles).toMatchObject({ ok: true, clip_count: 3 });
      for (const id of subtitles.clip_ids) expect((await segment(id)).transform).toMatchObject({ transform_y: -0.8 });
      const styled = (await run("add_subtitles", { srt: "1\n00:00:00,000 --> 00:00:01,000\n大字", transform: { transform_y: -0.6 }, font_size: 12, color: "#FFCC00" })).result;
      expect(await segment(styled.clip_id)).toMatchObject({ transform: { transform_y: -0.6 }, font_size: 12, color: "#FFCC00" });
      const badStyle = await run("add_subtitles", { captions: [{ start: 0, end: 1, text: "x" }], font_size: 1000 });
      expect(badStyle.result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect((await store.getProject(project.id)).tracks.filter((track) => track.kind === "subtitle")).toHaveLength(2);
      // 字幕轨上不能单独加文字：告诉模型原因，而不是「轨道不存在」
      const locked = await run("add_text_clip", { track_id: subtitles.track_id, text: "第 5 秒再加一句", start: 5, duration: 1 });
      expect(locked.result).toMatchObject({ ok: false, code: "SUBTITLE_TRACK_LOCKED", message: expect.stringContaining("另建一条文字轨道") });
      expect(locked.action.error).toBe("字幕轨只能整组加字幕，单独的文字要另建文字轨道");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("fills in a sped-up clip's length the way the project store rounds it", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-tools-speed-"));
    try {
      // 真实素材的微秒数是任意值：5_000_001 ÷ 2 正好是 .5，Math.round 和 Python round 差 1 微秒
      const odd = async (filePath, options) => {
        const info = await probeMedia(filePath, options);
        return info.duration_us === 3_000_000 ? { ...info, duration_us: 5_000_001 } : info;
      };
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: odd, kindOf: mediaKind });
      await media.load();
      const fixtures = path.join(HERE, "../fixtures/ai-edit/media");
      const clip = (await media.upload(createReadStream(path.join(fixtures, "clip-720p.mp4")), "clip.mp4")).id;
      const fragmented = (await media.upload(createReadStream(path.join(fixtures, "fragmented.mp4")), "frag.mp4")).id;
      expect([media.get(clip).durationUs, media.get(fragmented).durationUs]).toEqual([5_000_001, 2_066_666]);
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: odd });
      const project = await store.createProject({ name: "倍速", canvas: { width: 1080, height: 1920, fps: 30 } });
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => ({}) });
      const track = (await run("create_track", { track_type: "video" })).result.track_id;
      for (const args of [{ media_id: clip, speed: 2 }, { media_id: clip, speed: 4 }, { media_id: fragmented, speed: 4, source_start: 0.5 }, { media_id: fragmented, speed: 2, source_start: 0.000003 }]) {
        const { result } = await run("add_media_clip", { track_id: track, ...args });
        expect(result, JSON.stringify(args)).toMatchObject({ ok: true });
      }
      const durations = (await store.getProject(project.id)).tracks[0].segments.map((segment) => segment.timeline.duration_us);
      // 2_500_000.5 → 2_500_000，1_250_000.25 → 1_250_000，391_666.5 → 391_666，1_033_331.5 → 1_033_332
      expect(durations).toEqual([2_500_000, 1_250_000, 391_666, 1_033_332]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("shows exact clip ends so the next clip can start right there", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-tools-ends-"));
    try {
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
      await media.load();
      const fixtures = path.join(HERE, "../fixtures/ai-edit/media");
      const fragmented = (await media.upload(createReadStream(path.join(fixtures, "fragmented.mp4")), "frag.mp4")).id;
      const still = (await media.upload(createReadStream(path.join(fixtures, "still.png")), "still.png")).id;
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
      const project = await store.createProject({ name: "接缝", canvas: { width: 1080, height: 1920, fps: 30 } });
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => ({}) });
      const track = (await run("create_track", { track_type: "video" })).result.track_id;
      const slowed = (await run("add_media_clip", { track_id: track, media_id: fragmented, speed: 0.7 })).result.clip_id;
      const shown = (await run("get_timeline", {})).result.tracks[0].clips[0];
      expect(shown).toMatchObject({ clip_id: slowed, start: 0, duration: 2.95238, end: 2.95238 });
      const next = await run("add_media_clip", { track_id: track, media_id: still, start: shown.end, duration: 1 });
      expect(next.result).toMatchObject({ ok: true, total_duration: 3.95238 });
      expect((await store.getProject(project.id)).tracks[0].segments[1].timeline.start_us).toBe(2_952_380);

      // 真重叠时把挨着的片段的精确起止告诉模型
      const overlap = await run("add_media_clip", { track_id: track, media_id: still, start: 2.952, duration: 1 });
      expect(overlap.result).toMatchObject({
        ok: false,
        code: "TIMELINE_OVERLAP",
        details: { track_id: track, nearby_clips: [{ clip_id: slowed, start: 0, end: 2.95238 }, { clip_id: next.result.clip_id, start: 2.95238, end: 3.95238 }] },
      });
      const moved = await run("move_clip", { clip_id: slowed, start: 1 });
      expect(moved.result.details.nearby_clips).toEqual([{ clip_id: next.result.clip_id, start: 2.95238, end: 3.95238 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe.runIf(["projectStore.mjs", "media.mjs"].every((name) => existsSync(path.join(HERE, name))))("AI edit tools: no silent speed changes", () => {
  // 10-19 真模型实测：3.5 秒的配乐截 3.5 秒、放 9.8 秒「铺满」，被自动放慢到 0.36 倍还变调
  it("refuses a clip whose source/duration ratio would silently retime it, but allows loops and explicit speed", async () => {
    const { ProjectStore } = await import("./projectStore.mjs");
    const { probeMedia, mediaKind } = await import("./media.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-speed-"));
    try {
      const media = new MediaLibrary({ directory: path.join(directory, "media"), probe: probeMedia, kindOf: mediaKind });
      await media.load();
      const tone = (await media.upload(createReadStream(path.join(HERE, "../fixtures/ai-edit/media/tone.mp3")), "tone.mp3")).id;
      const store = new ProjectStore({ directory: path.join(directory, "projects"), mediaRoots: [media.root], probe: probeMedia });
      const project = await store.createProject({ name: "配乐", canvas: { width: 1080, height: 1920, fps: 30 } });
      const run = createToolRunner({ store, library: media, projectId: project.id, getCollector: () => null, exportDraft: async () => ({}) });
      const call = async (name, args) => (await run(name, args)).result;
      const audio = (await call("create_track", { track_type: "audio", name: "配乐" })).track_id;

      const stretched = await call("add_media_clip", { track_id: audio, media_id: tone, start: 0, source_duration: 3.5, duration: 9.8 });
      expect(stretched).toMatchObject({ ok: false, code: "SPEED_IMPLIED" });
      expect(stretched.message).toContain("接着多放几段");
      expect((await store.getProject(project.id)).tracks[0].segments).toHaveLength(0);

      // 循环：同一素材接着放三段，最后一段截短
      const first = await call("add_media_clip", { track_id: audio, media_id: tone, start: 0 });
      await call("add_media_clip", { track_id: audio, media_id: tone });
      const last = await call("add_media_clip", { track_id: audio, media_id: tone, source_duration: 2.8, duration: 2.8 });
      expect([first.ok, last.ok]).toEqual([true, true]);
      expect(last.total_duration).toBeCloseTo(9.8, 1);

      // 明确给倍速照常放行；改时长又不给倍速时同样拦下
      expect(await call("add_media_clip", { track_id: audio, media_id: tone, start: 20, source_duration: 3.5, duration: 7, speed: 0.5 })).toMatchObject({ ok: true });
      expect(await call("update_clip", { clip_id: first.clip_id, source_duration: 3.5, duration: 1 })).toMatchObject({ ok: false, code: "SPEED_IMPLIED" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("reference videos", () => {
  const EDIT = { baseUrl: "https://ark.example.com/api/v3", apiKey: "edit-key", model: "doubao-seed-edit" };
  const LINK = "https://www.douyin.com/video/7123456789";
  const failure = (code, message = "原文") => Object.assign(new Error(message), { code });
  const explorerWith = (outcome) => {
    const calls = [];
    return {
      calls,
      run: async (input, operation) => {
        calls.push(["run", input, operation]);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      close: async (ids) => { calls.push(["close", ids]); },
    };
  };
  const answering = (content, sent = []) => async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  };

  it("searches Douyin through the explorer, keeps videos only and closes its page", async () => {
    const explorer = explorerWith({
      sessionId: "s-1",
      items: [
        { id: "explore:1", title: "热门转场", author: "阿明", url: "https://www.douyin.com/video/1", durationSeconds: 15, stats: { diggCount: 12_000 }, mediaType: "video" },
        { id: "explore:2", title: "图文", url: "https://www.douyin.com/note/2", mediaType: "image" },
        { id: "explore:3", title: "没点赞数", url: "https://www.douyin.com/video/3" },
      ],
    });
    const { run } = runnerWith({ getExplorer: () => explorer });
    const { result, action, changed } = await run("search_douyin", { query: "卡点 转场", limit: 5 });
    expect(result).toEqual({
      ok: true,
      total: 2,
      videos: [
        { url: "https://www.douyin.com/video/1", title: "热门转场", author: "阿明", likes: 12_000, duration: 15 },
        { url: "https://www.douyin.com/video/3", title: "没点赞数" },
      ],
      note: expect.stringContaining("analyze_reference"),
    });
    expect(action).toEqual({ name: "search_douyin", summary: "在抖音上搜了「卡点 转场」", ok: true });
    expect(changed).toBe(false);
    expect(explorer.calls).toEqual([["run", { kind: "videos", query: "卡点 转场" }, "read"], ["close", ["s-1"]]]);
  });

  it("tells the user to log in or pass verification when Douyin refuses the search", async () => {
    const search = (outcome) => runnerWith({ getExplorer: () => explorerWith(outcome) }).run("search_douyin", { query: "同款" });
    const reconnect = (cause) => Object.assign(failure("browser_reconnect_required", "导入的登录凭据已失效或不完整"), { cause });
    for (const error of [failure("login_required"), failure("direct_session_missing"), reconnect(failure("direct_session_missing"))]) {
      expect((await search(error)).result).toMatchObject({ ok: false, code: "login_required", message: expect.stringContaining("重新扫码登录") });
    }
    for (const error of [failure("verification_required"), reconnect(failure("verification_required"))]) {
      expect((await search(error)).result).toMatchObject({ ok: false, code: "verification_required", message: expect.stringContaining("安全验证") });
    }
    expect((await search(failure("collector_busy", "采集器正在执行任务"))).result).toMatchObject({ ok: false, code: "collector_busy", message: "采集器正在执行任务" });
    expect((await runnerWith().run("search_douyin", { query: "同款" })).result).toMatchObject({ ok: false, code: "collector_busy" });
  });

  it("downloads a Douyin link and watches it with the AI edit model, caching only inside AI edit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-reference-"));
    try {
      const file = path.join(directory, "v.mp4");
      await writeFile(file, "fake-mp4");
      const downloads = [];
      const collector = {
        startVideoDownload(url, options) { downloads.push([url, options]); return { id: "job", status: "queued" }; },
        getVideoDownloadJob: () => ({ id: "job", status: "complete", video: { title: "热门转场", author: "阿明", durationSeconds: 15 } }),
        getVideoDownloadFilePath: () => file,
      };
      const sent = [];
      const references = new Map();
      const runner = () => runnerWith({ getCollector: () => collector, config: EDIT, references, fetchImpl: answering("③ 0–2 秒｜硬切｜白字黑边", sent), pollMs: 1 }).run;
      const first = await runner()("analyze_reference", { url: LINK });
      expect(first.result).toEqual({
        ok: true,
        video: { title: "热门转场", author: "阿明", duration: 15 },
        analysis: "③ 0–2 秒｜硬切｜白字黑边",
        how_to_use: expect.stringContaining("不要把这条视频放进时间线"),
      });
      expect(first.changed).toBe(false);
      expect(downloads).toEqual([[LINK, { smallest: true }]]);
      expect(sent[0].model).toBe("doubao-seed-edit");
      expect(sent[0].messages[0].content[0].video_url.url).toBe(`data:video/mp4;base64,${Buffer.from("fake-mp4").toString("base64")}`);
      const prompt = sent[0].messages[0].content[1].text;
      expect(prompt).toContain("这次拆解还要给剪辑照着复刻");
      expect(prompt).toContain("我的创作方向：没有填写");

      // 解析过的直接用（别的会话也一样）：不再下载、不再问模型
      expect((await runner()("analyze_reference", { url: LINK })).result.analysis).toBe(first.result.analysis);
      expect(downloads).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect([...references.keys()]).toEqual([LINK]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("says plainly when the AI edit model cannot watch video", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-reference-"));
    try {
      const media = new MediaLibrary({ directory, probe: async () => ({}), kindOf: () => "video" });
      media.root = directory;
      media.items = [{ id: VIDEO_ID, kind: "video", status: "ready", name: "参考.mp4", file: `${VIDEO_ID}.mp4`, durationUs: 8_000_000, size: 8, source: { type: "local" } }];
      await writeFile(path.join(directory, `${VIDEO_ID}.mp4`), "fake-mp4");
      const watch = async (fetchImpl) => (await runnerWith({ library: media, config: EDIT, fetchImpl }).run("analyze_reference", { media_id: VIDEO_ID })).result;
      const rejected = await watch(async () => new Response(JSON.stringify({ error: { message: "unknown variant `video_url`, expected `text` or `image_url`" } }), { status: 400 }));
      expect(rejected).toMatchObject({ ok: false, code: "video_unsupported", message: expect.stringMatching(/^AI 剪辑配置的模型看不了视频，换一个支持视频输入的模型.*video_url/u) });
      expect(await watch(answering("抱歉，我无法直接查看视频内容，可以把画面用文字描述给我吗？"))).toMatchObject({ ok: false, code: "video_unsupported" });
      expect(await watch(answering("I can't watch videos, please describe it."))).toMatchObject({ ok: false, code: "video_unsupported" });
      // 正常的拆解（带表格）里提到“无法读取”也不算
      expect(await watch(answering("| 维度 | 发现 |\n|---|---|\n| 画面 | 无法读取视频里的小字 |"))).toMatchObject({ ok: true });
      expect(await watch(async () => new Response(JSON.stringify({ error: { message: "the API key is invalid" } }), { status: 401 })))
        .toMatchObject({ ok: false, code: "provider_error", message: expect.stringContaining("Key 不对") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends a local reference video straight to the AI edit model", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-reference-"));
    try {
      const media = new MediaLibrary({ directory, probe: async () => ({}), kindOf: () => "video" });
      media.root = directory;
      const local = { id: VIDEO_ID, kind: "video", status: "ready", name: "参考.mp4", file: `${VIDEO_ID}.mp4`, durationUs: 8_000_000, size: 8, source: { type: "local" } };
      const big = { ...local, id: AUDIO_ID, name: "大.mp4", file: `${AUDIO_ID}.mp4` };
      media.items = [local, big, { ...local, id: IMAGE_ID, kind: "image", name: "图.png", file: `${IMAGE_ID}.png` }];
      await writeFile(path.join(directory, `${VIDEO_ID}.mp4`), "fake-mp4");
      await writeFile(path.join(directory, `${AUDIO_ID}.mp4`), "");
      await truncate(path.join(directory, `${AUDIO_ID}.mp4`), 46 * 1024 * 1024);
      const sent = [];
      const { run } = runnerWith({ library: media, config: EDIT, references: new Map(), fetchImpl: answering("① 三段式", sent) });
      const { result, action } = await run("analyze_reference", { media_id: VIDEO_ID });
      expect(result).toMatchObject({ ok: true, video: { title: "参考.mp4", duration: 8 }, analysis: "① 三段式" });
      expect(action.summary).toBe("解析了参考视频「参考.mp4」");
      expect(sent[0].messages[0].content[1].text).toContain("时长：8 秒");

      expect((await run("analyze_reference", { media_id: IMAGE_ID })).result).toMatchObject({ ok: false, code: "not_video" });
      expect((await run("analyze_reference", {})).result).toMatchObject({ ok: false, code: "arguments_invalid" });
      expect((await run("analyze_reference", { media_id: VIDEO_ID, url: LINK })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
      expect((await run("analyze_reference", { url: "https://example.com/v/1" })).result).toMatchObject({ ok: false, code: "invalid_url" });
      expect((await run("analyze_reference", { media_id: AUDIO_ID })).result).toMatchObject({ ok: false, code: "video_too_large" });
      expect((await runnerWith().run("analyze_reference", { url: LINK })).result).toMatchObject({ ok: false, code: "collector_busy" });
      expect(sent).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
