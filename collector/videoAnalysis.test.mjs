import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VideoAnalysis } from "./videoAnalysis.mjs";
import { makeStudyNotes } from "./videoAnalysisModel.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const config = { baseUrl: "http://127.0.0.1:54321/v1", apiKey: "example-test-only", model: "test-model" };
const input = (kind, extra = {}) => ({ kind, engine: "bcut", config, ...extra });
async function setup(hasAudio = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "analysis-test-"));
  roots.push(directory);
  const source = path.join(directory, "sample.mp4");
  await writeFile(source, "fixture");
  const deps = { directory, download: vi.fn(async () => source),
    transcribe: vi.fn(async () => [{ startMs: 3800, endMs: 5500, text: "第二张图" }]),
    media: {
      inspectVideo: vi.fn(async () => ({ hasAudio, durationMs: 6000 })),
      extractAudio: vi.fn(async (_, dest) => { await writeFile(dest, "audio"); return { silent: false }; }),
      extractFrameAt: vi.fn(async (_, dest) => writeFile(dest, "jpg")),
      extractFrames: vi.fn(async (_, dir) => Promise.all([0, 3500].map(async timeMs => {
        const filePath = path.join(dir, timeMs + ".jpg");
        await writeFile(filePath, "frame");
        return { timeMs, filePath };
      }))),
    } };
  return { service: new VideoAnalysis(deps), deps };
}
async function run(service, request) {
  await service.start("123", request);
  await service.jobs.get("123").done;
  return service.view("123");
}
const answer = text => Response.json({ choices: [{ message: { content: JSON.stringify(text) } }] });
const frameTimes = init => JSON.parse(init.body).messages[1].content.flatMap(item => /原片位置 (\d+)/.exec(item.text ?? "")?.[1] ?? []).map(Number);
const frameAnswer = (init, scene, screenText = "") => answer({ frames: frameTimes(init).map(timeMs => ({ timeMs, scene, screenText })) });

const articleAnswer = source => ({ title: "如何验证想法", overview: "用实验找出问题。", summary: "根据证据做取舍。",
  chapters: [{ source, title: "先做实验", text: "### 验证方法\n\n先用真实样本检查假设，再决定是否继续。" }] });

it("uses WorkBuddy for voice-based study notes without an API key", async () => {
  const { service } = await setup();
  const converse = vi.fn(async (runtime, { onText }) => {
    expect(runtime).toBe("workbuddy");
    onText("正在整理素材。");
    onText(JSON.stringify(articleAnswer(0)));
  });
  service.localAi = { converse };
  const fetch = vi.fn(() => { throw new Error("must use the local runtime"); });
  vi.stubGlobal("fetch", fetch);
  const { job, results } = await run(service, input("notes", { config: { runtime: "workbuddy", model: "" }, withFrames: false }));
  expect(job.status).toBe("completed");
  expect(results.find(row => row.kind === "notes").article.title).toBe("如何验证想法");
  expect(converse).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("explains WorkBuddy's text-only limitation for keyframes without making an API request", async () => {
  const { service, deps } = await setup();
  const fetch = vi.fn(() => { throw new Error("must not use an API"); });
  vi.stubGlobal("fetch", fetch);
  const { job } = await run(service, input("script", { config: { runtime: "workbuddy", model: "" } }));
  expect(job).toMatchObject({ status: "failed", errorCode: "vision_unsupported", message: expect.stringContaining("WorkBuddy") });
  expect(deps.media.extractFrames).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("writes one article across long-video batches and corrects an invalid chapter citation", async () => {
  const evidence = [
    { startMs: 0, endMs: 500, text: "甲".repeat(32000) },
    { startMs: 500, endMs: 1500, text: "乙" },
  ];
  let drafts = 0;
  const converse = vi.fn(async (_, { outputSchema, onText, prompt }) => {
    onText("正在整理");
    if (outputSchema.properties.notes) {
      const batch = JSON.parse(prompt);
      onText(JSON.stringify({ notes: [{ source: batch[0].source, title: "材料", text: batch[0].text[0] }] }));
    } else {
      expect(JSON.parse(prompt).materials.map(row => row.text)).toEqual(["材料：甲", "材料：乙"]);
      onText(JSON.stringify(articleAnswer(drafts++ === 0 ? [0, 1] : 1)));
    }
  });
  const notes = await makeStudyNotes({ config: { runtime: "codex" }, evidence, localAi: { converse }, onProgress: vi.fn() });
  expect(notes.entries.map(row => row.startMs)).toEqual([500]);
  expect(drafts).toBe(2);
  expect(notes.title).toBe("如何验证想法");
});

it("attaches the keyframe files to Codex and saves descriptions only when they match the timestamps", async () => {
  const { deps } = await setup();
  let times = [3500, 0];
  const converse = vi.fn(async (runtime, { imagePaths, prompt, onText }) => {
    expect(runtime).toBe("codex");
    expect(imagePaths.map(file => path.basename(file))).toEqual(["0.jpg", "3500.jpg"]);
    expect(prompt).toContain("0、3500");
    onText(JSON.stringify(times.map(timeMs => ({ timeMs, scene: `画面 ${timeMs}`, screenText: "" }))));
  });
  const service = new VideoAnalysis({ ...deps, localAi: { converse } });
  const request = input("script", { config: { runtime: "codex", model: "" } });
  expect((await run(service, request)).job.errorCode).toBe("invalid_model_output");
  times = [0, 3500];
  const script = (await run(service, request)).results.find(r => r.kind === "script");
  expect(script.entries.map(e => e.startMs)).toEqual(times);
  expect(script.entries[1].text).toContain("画面 3500");
  expect(deps.transcribe).toHaveBeenCalledTimes(1);
});

it("keeps transcript and completed frames after an image request fails, and reuses them across outputs and restarts", async () => {
  const { service, deps } = await setup();
  let imageCalls = 0;
  let videoCalls = 0;
  const model = vi.fn(async (_, init) => {
    const { messages } = JSON.parse(init.body);
    if (typeof messages[1].content === "string") return answer(articleAnswer(1));
    if (messages[1].content.some(item => item.type === "video_url")) {
      videoCalls++;
      return Response.json({ error: { message: "video_url is not a valid content type" } }, { status: 400 });
    }
    imageCalls++;
    const times = frameTimes(init);
    expect(messages[1].content.filter(item => item.type === "image_url")).toHaveLength(times.length);
    if (times.length > 1) return Response.json({ error: { message: "too many images in one request" } }, { status: 400 });
    if (imageCalls === 3) return Response.json({ error: { message: "Model does not support images" } }, { status: 400 });
    if (imageCalls === 4) expect(times).toEqual([3500]);
    return frameAnswer(init, "图示", "下一步");
  });
  vi.stubGlobal("fetch", model);
  const failed = await run(service, input("script"));
  expect(failed.job.errorCode).toBe("vision_unsupported");
  expect(failed.results.map(r => r.kind)).toEqual(["transcript"]);
  const resumed = new VideoAnalysis(deps);
  const { results } = await run(resumed, input("script"));
  const script = results.find(r => r.kind === "script");
  expect(script.entries[1]).toMatchObject({ startMs: 3500, endMs: 6000 });
  expect(script.entries[1].text).toContain("第二张图");
  expect(imageCalls).toBe(4);
  const legacyKey = script.key.replace("script-", "notes-");
  const legacy = { ...script, kind: "notes", key: legacyKey, markdown: "旧版笔记" };
  const resultsDir = path.join(deps.directory, "video-analysis/123/results");
  await writeFile(path.join(resultsDir, legacyKey + ".json"), JSON.stringify(legacy));
  const notes = await run(resumed, input("notes", { withFrames: true }));
  const article = notes.results.find(r => r.article);
  expect(article.entries[0].startMs).toBe(3500);
  expect(article.markdown).toContain("[1. 先做实验](#1-先做实验)");
  expect(article.markdown).toContain("## 视频核心观点");
  expect(article.markdown).toContain("## AI 总结");
  expect(notes.results.find(r => r.key === legacyKey)).toEqual(legacy);
  const { notes: history } = await resumed.listNotes();
  expect(history.map(note => note.key).sort()).toEqual([legacyKey, article.key].sort());
  expect(history.find(note => note.key === article.key)).toMatchObject({ videoId: "123", title: article.article.title, withFrames: true });
  expect(history.find(note => note.key === legacyKey)?.title).toBe("");
  expect(history[0]).not.toHaveProperty("entries");
  await run(resumed, input("notes", { withFrames: true }));
  await run(resumed, input("script"));
  expect(videoCalls).toBe(2);
  expect(model).toHaveBeenCalledTimes(7);
  for (const work of [deps.download, deps.media.extractFrames, deps.media.extractAudio, deps.transcribe])
    expect(work).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(deps.directory, "video-analysis/123/results", script.key + ".json"), "utf8")).not.toContain(config.apiKey);
});

it("splits shots from the whole video when the model accepts it, replacing an earlier keyframe script", async () => {
  const { service, deps } = await setup();
  let sees = false;
  const model = vi.fn(async (_, init) => {
    const { content } = JSON.parse(init.body).messages[1];
    if (content[1].type !== "video_url") return frameAnswer(init, "关键帧");
    return answer({ shots: sees ? [{ start: 3.5, scene: "第二镜", screenText: "" }, { start: 0, scene: "开场", screenText: "标题" }] : [] });
  });
  vi.stubGlobal("fetch", model);
  const keyframes = (await run(service, input("script"))).results.find(r => r.kind === "script");
  expect(keyframes.source).toBeUndefined();
  expect(keyframes.entries[0].text).toContain("画面：关键帧");
  sees = true;
  const { results } = await run(new VideoAnalysis(deps), input("script"));
  const script = results.find(r => r.kind === "script");
  expect(results.filter(r => r.kind === "script")).toHaveLength(1);
  expect(script).toMatchObject({ key: keyframes.key, source: "video" });
  expect(script.entries.map(e => [e.startMs, e.endMs])).toEqual([[0, 3500], [3500, 6000]]);
  expect(script.entries[0].text).toContain("屏幕文字：标题");
  expect(script.entries[1].text).toContain("画面：第二镜\n原声台词：第二张图");
  expect(deps.media.extractFrames).toHaveBeenCalledTimes(1);
  expect(model).toHaveBeenCalledTimes(3);
});

it("sends the whole video to the separately configured video model and keeps the main model for the keyframe fallback", async () => {
  const { service, deps } = await setup();
  const videoConfig = { baseUrl: "http://127.0.0.1:54322/v1", apiKey: "video-test-only", model: "video-model" };
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    const video = body.messages[1].content.some(item => item.type === "video_url");
    calls.push([video ? "video" : "image", new URL(url).port, body.model, init.headers.Authorization]);
    if (!video) return frameAnswer(init, "关键帧");
    return body.model === "video-model" ? answer({ shots: [{ start: 0, scene: "开场", screenText: "" }] })
      : Response.json({ error: { message: "video input is not supported" } }, { status: 400 });
  });
  const watched = (await run(service, input("script", { videoConfig }))).results.find(r => r.kind === "script");
  expect(watched).toMatchObject({ source: "video", model: "video-model" });
  expect(calls).toEqual([["video", "54322", "video-model", "Bearer video-test-only"]]);
  expect(JSON.stringify(watched)).not.toContain("video-test-only");
  calls.length = 0;
  const { results } = await run(service, input("script", { videoConfig: { ...videoConfig, model: "blind-model" } }));
  const fallback = results.find(r => r.kind === "script" && r.key !== watched.key);
  expect(fallback.source).toBeUndefined();
  expect(fallback.model).toBe("test-model");
  expect(calls).toEqual([["video", "54322", "blind-model", "Bearer video-test-only"],
    ["image", "54321", "test-model", "Bearer example-test-only"]]);
  expect(deps.media.extractFrames).toHaveBeenCalledTimes(1);
});

it("illustrates only the chapters the model marks, and lets a note saved before figures be redone once", async () => {
  const { service, deps } = await setup();
  const model = vi.fn(async () => answer({ ...articleAnswer(0), chapters: [
    { source: 0, title: "看[图]", text: "图里是流程。", figure: true }, { source: 0, title: "观点", text: "只是口述。", figure: false }] }));
  vi.stubGlobal("fetch", model);
  const note = (await run(service, input("notes"))).results.find(r => r.article);
  expect(deps.media.extractFrameAt).toHaveBeenCalledTimes(1);
  expect(deps.media.extractFrameAt.mock.calls[0][2]).toBe(4650);
  const image = `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`;
  expect(note.entries.map(e => e.figure)).toEqual([image, undefined]);
  expect(note.figures).toBe(1);
  expect(note.markdown).toContain(`## 1. 看[图]\n\n![1. 看\\[图\\]](${image})\n\n图里是流程。\n\n## 2. 观点\n\n只是口述。`);
  await run(service, input("notes"));
  expect(model).toHaveBeenCalledTimes(1);
  const file = path.join(deps.directory, "video-analysis/123/results", note.key + ".json");
  const { figures, ...old } = note;
  await writeFile(file, JSON.stringify(old));
  await run(service, input("notes"));
  await run(service, input("notes"));
  expect(model).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(file, "utf8")).figures).toBe(1);
});

it("keeps silent frames useful without calling ASR and preserves the empty timed transcript", async () => {
  const { service, deps } = await setup(false);
  vi.stubGlobal("fetch", (_, init) => frameAnswer(init, "录屏", "保存"));
  const transcript = await run(service, { kind: "transcript", engine: "qwen" });
  expect(transcript.results[0].entries).toEqual([]);
  expect(deps.media.extractFrames).not.toHaveBeenCalled();
  const script = await run(service, input("script"));
  expect(script.results.find(r => r.kind === "script").entries[0].text).toContain("原声台词：\n");
  expect(deps.transcribe).not.toHaveBeenCalled();
});

it("falls back to Bcut when the preferred Qwen service fails, and files everything under Bcut", async () => {
  const { service, deps } = await setup();
  deps.transcribe.mockImplementation(async ({ engine }) => {
    if (engine === "qwen") throw Object.assign(new Error("配额不足"), { code: "qwen_quota" });
    return [{ startMs: 100, endMs: 900, text: "必剪听到的" }];
  });
  vi.stubGlobal("fetch", async () => answer(articleAnswer(0)));
  const { job, results } = await run(service, input("notes", { engine: "qwen" }));
  expect(deps.transcribe.mock.calls.map(([call]) => call.engine)).toEqual(["qwen", "bcut"]);
  expect(job).toMatchObject({ status: "completed", engine: "bcut", note: expect.stringContaining("配额不足") });
  expect(results.map(r => r.key).sort()).toEqual([job.resultKey, "transcript-bcut"].sort());
  expect(job.resultKey).toMatch(/^notes-bcut-voice-/u);
  expect(deps.media.extractAudio).toHaveBeenCalledTimes(1);
});

it("runs a batch one video at a time, keeps going after a failure, and can stop and retry what did not finish", async () => {
  const { service, deps } = await setup();
  let active = 0, peak = 0, broken = true;
  deps.transcribe.mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return [];
  });
  const download = deps.download.getMockImplementation();
  deps.download.mockImplementation(async id => {
    if (id === "222" && broken) throw Object.assign(new Error("没有取得原片。"), { code: "download_failed" });
    return download();
  });
  const request = { kind: "transcript", engine: "bcut" };
  const rows = () => service.batchView().batch.items.map(item => [item.videoId, item.status]);
  expect(() => service.startBatch({ ...request, items: [{ videoId: "x" }] })).toThrow("1 到 100");
  service.startBatch({ ...request, items: [{ videoId: "111", title: "甲" }, { videoId: "222" }, { videoId: "111" }, { videoId: "../3" }, { videoId: "333" }] });
  expect(() => service.startBatch({ ...request, items: [{ videoId: "444" }] })).toThrow("上一批");
  await service.batch.done;
  expect(service.batchView().batch).toMatchObject({ kind: "transcript", status: "done" });
  expect(rows()).toEqual([["111", "completed"], ["222", "failed"], ["333", "completed"]]);
  expect(service.batchView().batch.items[1].message).toBe("没有取得原片。");
  expect(peak).toBe(1);
  expect((await service.view("333")).results.map(r => r.key)).toEqual(["transcript-bcut"]);
  broken = false;
  service.startBatch({ retry: "222" });
  await service.batch.done;
  expect(rows()).toEqual([["111", "completed"], ["222", "completed"], ["333", "completed"]]);
  deps.transcribe.mockImplementation(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  service.startBatch({ ...request, engine: "qwen", items: [{ videoId: "555" }, { videoId: "666" }] });
  await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalledTimes(4));
  expect((await service.cancelBatch()).batch).toMatchObject({ status: "done", items: [{ status: "cancelled" }, { status: "cancelled" }] });
});

it("coalesces duplicate starts, cancels a running stage and retries without publishing partial data", async () => {
  const { service, deps } = await setup();
  deps.transcribe.mockImplementationOnce(({signal}) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await Promise.all([service.start("123", input("transcript")), service.start("123", input("transcript"))]);
  await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalledTimes(1));
  expect(() => service.start("123", input("notes"))).toThrow("正在解析");
  expect(await service.cancel("123")).toMatchObject({ job: { status: "cancelled" }, results: [] });
  expect((await run(service, input("transcript"))).job.status).toBe("completed");
  expect(deps.download).toHaveBeenCalledTimes(1);
});
