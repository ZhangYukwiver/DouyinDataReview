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

const articleAnswer = source => ({ title: "如何验证想法", overview: "用实验找出问题。", summary: "根据证据做取舍。",
  chapters: [{ source, title: "先做实验", text: "### 验证方法\n\n先用真实样本检查假设，再决定是否继续。" }] });

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
  const model = vi.fn(async (_, init) => {
    const { messages } = JSON.parse(init.body);
    if (typeof messages[1].content === "string") return answer(articleAnswer(1));
    expect(messages[1].content.filter(item => item.type === "image_url")).toHaveLength(1);
    imageCalls++;
    if (imageCalls === 2) return Response.json({ error: { message: "Model does not support images" } }, { status: 400 });
    return answer({ scene: "图示", screenText: "下一步" });
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
  expect(imageCalls).toBe(3);
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
  expect(model).toHaveBeenCalledTimes(4);
  for (const work of [deps.download, deps.media.extractFrames, deps.media.extractAudio, deps.transcribe])
    expect(work).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(deps.directory, "video-analysis/123/results", script.key + ".json"), "utf8")).not.toContain(config.apiKey);
});

it("keeps silent frames useful without calling ASR and preserves the empty timed transcript", async () => {
  const { service, deps } = await setup(false);
  vi.stubGlobal("fetch", () => answer({ scene: "录屏", screenText: "保存" }));
  const transcript = await run(service, { kind: "transcript", engine: "qwen" });
  expect(transcript.results[0].entries).toEqual([]);
  expect(deps.media.extractFrames).not.toHaveBeenCalled();
  const script = await run(service, input("script"));
  expect(script.results.find(r => r.kind === "script").entries[0].text).toContain("原声台词：\n");
  expect(deps.transcribe).not.toHaveBeenCalled();
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
