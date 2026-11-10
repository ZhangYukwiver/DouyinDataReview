import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAssistantConfig } from "./assistant/chat.mjs";
import { transcribeAudio } from "./videoAnalysisAsr.mjs";
import { extractAudio, extractFrames, inspectVideo } from "./videoAnalysisMedia.mjs";
import { describeCodexFrames, describeFrame, makeStudyNotes } from "./videoAnalysisModel.mjs";

const titles = { transcript: "带时间戳的逐字稿", script: "原片分镜脚本", notes: "学习笔记" };
const engines = { bcut: "必剪", qwen: "Qwen3-ASR" };
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const clock = ms => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(Math.floor(ms % 1000 / 100))}`;
};

async function optional(operation, otherwise = null) {
  try { return await operation(); }
  catch (error) { if (error.code === "ENOENT") return otherwise; throw error; }
}
const readJson = file => optional(async () => JSON.parse(await readFile(file, "utf8")));
async function atomic(file, produce, signal) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${randomUUID()}${path.extname(file)}`);
  try {
    await produce(temp);
    signal.throwIfAborted();
    await rename(temp, file);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
const save = (file, value, signal) => atomic(file, temp => writeFile(temp, JSON.stringify(value), { mode: 0o600 }), signal);

function options(body) {
  if (!Object.hasOwn(titles, body?.kind) || !Object.hasOwn(engines, body?.engine))
    throw fail("invalid_request", "请选择支持的结果类型和转写服务。");
  const { kind, engine } = body;
  const withFrames = kind === "script" || (kind === "notes" && body.withFrames === true);
  const config = kind === "transcript" ? null : parseAssistantConfig(body.config);
  const modelId = config ? hash([config.runtime || "api", config.baseUrl || "", config.model]) : "";
  const model = config?.model || config?.runtime || "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 320) : "";
  return { kind, engine, withFrames, config, model, modelId, title,
    key: kind === "transcript" ? `transcript-${engine}` : `${kind}-${engine}-${withFrames ? "frames" : "voice"}-${modelId}${kind === "notes" ? "-article" : ""}` };
}

function result(request, entries, article) {
  const { key, kind, engine, withFrames, model } = request;
  const common = { key, kind, engine, withFrames, model, createdAt: new Date().toISOString(), entries };
  if (article) {
    const chapters = [{ title: "视频核心观点", text: article.overview }, ...entries.map((entry, i) =>
      ({ title: `${i + 1}. ${entry.title}`, text: entry.text })), { title: "AI 总结", text: article.summary }];
    const contents = chapters.map(({ title }) => {
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/ /gu, "-");
      return `- [${title.replace(/[[\]]/gu, "\\$&")}](#${slug})`;
    });
    const markdown = [`# ${article.title}`, `> 来源链接：${article.sourceUrl}`, "## 目录", contents.join("\n"),
      ...chapters.flatMap(({ title, text }) => [`## ${title}`, text])].join("\n\n");
    return { ...common, article, markdown };
  }
  const markdown = [`# ${titles[kind]}`, ...entries.map(entry =>
    `[${clock(entry.startMs)}${entry.endMs == null ? "" : `–${clock(entry.endMs)}`}] ${entry.title ? `**${entry.title}**\n\n` : ""}${kind === "script" ? entry.text.replaceAll("\n", "  \n") : entry.text}`)];
  if (!entries.length) markdown.push("未识别到人声。");
  return { ...common, markdown: markdown.join("\n\n") };
}

function scriptEntries(frames, segments, durationMs) {
  let nextSegment = 0;
  return frames.map((frame, index) => {
    const startMs = index === 0 ? 0 : frame.timeMs;
    const endMs = frames[index + 1]?.timeMs ?? durationMs;
    const lines = [];
    while (nextSegment < segments.length && (segments[nextSegment].startMs < endMs || index === frames.length - 1))
      lines.push(segments[nextSegment++].text);
    return { startMs, endMs, title: `分镜 ${index + 1}`, text: [
      `画面：${frame.scene}`, `原声台词：${lines.join(" ")}`, `屏幕文字：${frame.screenText}`,
    ].join("\n") };
  });
}

export class VideoAnalysis {
  constructor({ directory, download, localAi, media = { inspectVideo, extractAudio, extractFrames }, transcribe = transcribeAudio }) {
    this.root = path.join(directory, "video-analysis");
    this.download = download;
    this.localAi = localAi;
    this.media = media;
    this.transcribe = transcribe;
    this.jobs = new Map();
  }

  directory(videoId) {
    if (!/^\d{1,24}$/u.test(videoId)) throw fail("invalid_video", "解析需要有效的抖音作品编号。");
    return path.join(this.root, videoId);
  }

  async view(videoId) {
    const dir = path.join(this.directory(videoId), "results");
    const names = await optional(() => readdir(dir), []);
    const results = await Promise.all(names.filter(name => !name.startsWith(".") && name.endsWith(".json"))
      .map(name => readJson(path.join(dir, name))));
    return { job: this.jobs.get(videoId)?.view ?? null,
      results: results.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  async listNotes() {
    const notes = [];
    const videos = await optional(() => readdir(this.root, { withFileTypes: true }), []);
    for (const video of videos) {
      if (!video.isDirectory() || !/^\d{1,24}$/u.test(video.name)) continue;
      const resultsDirectory = path.join(this.root, video.name, "results");
      const files = await optional(() => readdir(resultsDirectory, { withFileTypes: true }), []);
      for (const file of files) {
        if (!file.isFile() || !file.name.startsWith("notes-") || !file.name.endsWith(".json")) continue;
        const result = await readJson(path.join(resultsDirectory, file.name));
        if (result?.kind !== "notes" || typeof result.key !== "string") continue;
        notes.push({
          videoId: video.name,
          key: result.key,
          title: typeof result.article?.title === "string" ? result.article.title : "",
          engine: typeof result.engine === "string" ? result.engine : "",
          withFrames: result.withFrames === true,
          model: typeof result.model === "string" ? result.model : "",
          createdAt: typeof result.createdAt === "string" ? result.createdAt : "",
        });
      }
    }
    return { notes: notes.sort((left, right) => {
      const time = (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
      return time || left.videoId.localeCompare(right.videoId) || left.key.localeCompare(right.key);
    }) };
  }

  async cachedSource(videoId) {
    if (!/^\d{1,24}$/u.test(videoId ?? "")) return null;
    const file = path.join(this.directory(videoId), "source.mp4");
    return (await optional(() => stat(file)))?.isFile() ? file : null;
  }

  start(videoId, body) {
    const dir = this.directory(videoId);
    const request = options(body);
    const existing = this.jobs.get(videoId);
    if (existing?.view.status === "running") {
      if (existing.view.resultKey !== request.key) throw fail("analysis_busy", "这条作品正在解析，可等待完成或先取消。", 409);
      return this.view(videoId);
    }
    for (const [key, item] of this.jobs) {
      if (this.jobs.size < 100) break;
      if (item.view.status !== "running") this.jobs.delete(key);
    }
    const controller = new AbortController();
    const view = { id: randomUUID(), kind: request.kind, engine: request.engine, withFrames: request.withFrames,
      resultKey: request.key, status: "running", stage: "prepare", message: "正在读取本机缓存" };
    const job = { controller, view };
    this.jobs.set(videoId, job);
    const signal = controller.signal;
    const update = (stage, message) => Object.assign(view, { stage, message });
    job.done = this.run(videoId, dir, request, signal, update).then(() => {
      Object.assign(view, { status: "completed", stage: "done", message: "解析完成" });
    }, error => {
      Object.assign(view, signal.aborted ? { status: "cancelled", message: "解析已取消" } :
        { status: "failed", errorCode: error.code || "analysis_failed", message: error.message || "解析失败，请重试。" });
    });
    return this.view(videoId);
  }

  async cancel(videoId) {
    const job = this.jobs.get(videoId);
    if (job?.view.status === "running") {
      job.controller.abort();
      await job.done;
    }
    return this.view(videoId);
  }

  async stop() {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map(job => job.done));
  }

  async run(videoId, dir, request, signal, update) {
    const output = key => path.join(dir, "results", `${key}.json`);
    if (await readJson(output(request.key))) return;
    signal.throwIfAborted();
    const source = path.join(dir, "source.mp4");
    if (!await optional(() => stat(source))) {
      update("download", "正在下载原片");
      const file = await this.download(videoId, signal);
      await atomic(source, async temp => {
        try { await link(file, temp); }
        catch (error) {
          if (!["EXDEV", "EPERM", "ENOTSUP", "EACCES"].includes(error.code)) throw error;
          await copyFile(file, temp);
        }
      }, signal);
    }
    const metadataFile = path.join(dir, "media.json");
    let media = await readJson(metadataFile);
    if (!media) {
      media = await this.media.inspectVideo(source, signal);
      await save(metadataFile, media, signal);
    }
    const transcriptRequest = options({ kind: "transcript", engine: request.engine });
    let transcript = await readJson(output(transcriptRequest.key));
    if (!transcript) {
      let entries = [];
      if (media.hasAudio) {
        const audio = path.join(dir, "audio.mp3");
        const info = path.join(dir, "audio.json");
        let audioInfo = await readJson(info);
        if (!audioInfo || (!audioInfo.silent && !await optional(() => stat(audio)))) {
          update("audio", "正在提取音轨");
          await atomic(audio, async temp => { audioInfo = await this.media.extractAudio(source, temp, signal, media); }, signal);
          await save(info, audioInfo, signal);
        }
        if (!audioInfo.silent) {
          update("asr", `正在使用${engines[request.engine]}转写音轨`);
          entries = await this.transcribe({ engine: request.engine, audioPath: audio, signal, onProgress: message => update("asr", message) });
          entries = entries.filter(row => row.text?.trim() && Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs < media.durationMs)
            .map(row => ({ startMs: Math.max(0, Math.round(row.startMs)), endMs: Math.min(media.durationMs, Math.max(0, Math.round(Math.max(row.startMs, row.endMs)))), text: row.text.trim() }))
            .sort((a, b) => a.startMs - b.startMs);
        }
      }
      transcript = result(transcriptRequest, entries);
      await save(output(transcript.key), transcript, signal);
    }
    if (request.kind === "transcript") return;
    let frames = [];
    if (request.withFrames) frames = await this.describe(dir, source, media, request, signal, update);
    let entries, article;
    if (request.kind === "script") entries = scriptEntries(frames, transcript.entries, media.durationMs);
    else {
      const evidence = [...transcript.entries, ...frames.map((frame, i) => ({
        startMs: frame.timeMs, endMs: frames[i + 1]?.timeMs ?? media.durationMs,
        text: `画面：${frame.scene}\n屏幕文字：${frame.screenText}`,
      }))].sort((a, b) => a.startMs - b.startMs);
      if (!evidence.length) throw fail("no_speech", "没有识别到口播，请勾选「结合画面」生成笔记。");
      const doc = await makeStudyNotes({ config: request.config, localAi: this.localAi, evidence, title: request.title, signal,
        onProgress: message => update("notes", message) });
      entries = doc.entries;
      article = { title: doc.title, overview: doc.overview, summary: doc.summary, sourceUrl: `https://www.douyin.com/video/${videoId}` };
    }
    await save(output(request.key), result(request, entries, article), signal);
  }

  async describe(dir, source, media, request, signal, update) {
    if (request.config.runtime === "claude")
      throw fail("vision_unsupported", "当前 Claude Code 接入仅支持文本。可改做口播笔记，或选择 Codex 或支持图片的接口模型。");
    const manifest = path.join(dir, "frames.json");
    const directory = path.join(dir, "frames");
    let frames = await readJson(manifest);
    if (!frames) {
      update("frames", "正在提取关键帧");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const extracted = await this.media.extractFrames(source, directory, signal, media);
      if (!extracted.length) throw fail("no_frames", "没有从原片中提取到可读取的画面。");
      frames = extracted.map(({ timeMs, filePath }) => ({ timeMs, file: path.relative(directory, filePath) }));
      await save(manifest, frames, signal);
    }
    const descriptions = [];
    const codex = request.config.runtime === "codex";
    const batchSize = codex ? 6 : 1;
    for (let start = 0; start < frames.length; start += batchSize) {
      signal.throwIfAborted();
      const batch = frames.slice(start, start + batchSize);
      update("vision", `正在识别画面 ${start + 1}${batch.length > 1 ? `–${start + batch.length}` : ""}/${frames.length}`);
      const entries = await Promise.all(batch.map(async frame => {
        const cached = path.join(dir, "descriptions", request.modelId, `${frame.timeMs}.json`);
        return { timeMs: frame.timeMs, filePath: path.join(directory, frame.file), cached, description: await readJson(cached) };
      }));
      const missing = entries.filter(entry => !entry.description);
      if (missing.length) {
        const fresh = codex
          ? await describeCodexFrames({ config: request.config, localAi: this.localAi, frames: missing, signal })
          : [await describeFrame({ config: request.config, frame: missing[0], signal })];
        for (const [i, entry] of missing.entries()) {
          entry.description = fresh[i];
          await save(entry.cached, entry.description, signal);
        }
      }
      for (const entry of entries) descriptions.push({ ...entry.description, timeMs: entry.timeMs });
    }
    return descriptions;
  }
}
