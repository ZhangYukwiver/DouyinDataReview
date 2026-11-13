import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAssistantConfig } from "./assistant/chat.mjs";
import { transcribeAudio } from "./videoAnalysisAsr.mjs";
import { extractAudio, extractFrameAt, extractFrames, inspectVideo } from "./videoAnalysisMedia.mjs";
import { describeCodexFrames, describeFrames, describeVideo, makeStudyNotes } from "./videoAnalysisModel.mjs";
import { runtimeLabel } from "./localAi.mjs";

const titles = { transcript: "带时间戳的逐字稿", script: "原片分镜脚本", notes: "学习笔记" };
const engines = { bcut: "必剪", qwen: "Qwen3-ASR" };
// ponytail: 一批最多 100 条；每条要几分钟，再多也是排到明天，真有人要再放开
const MAX_BATCH = 100;
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
  // 分镜脚本另配的视频模型（可选，只认接口）：整段视频交给它，收不了再退回上面的模型看关键帧
  const videoConfig = kind === "script" && body.videoConfig ? parseAssistantConfig({ ...body.videoConfig, runtime: undefined }) : null;
  const videoId = videoConfig ? hash([videoConfig.baseUrl, videoConfig.model]) : "";
  return { kind, engine, withFrames, config, model, modelId, title, videoConfig, videoId,
    key: kind === "transcript" ? `transcript-${engine}` : `${kind}-${engine}-${withFrames ? "frames" : "voice"}-${modelId}${videoId && `-${videoId}`}${kind === "notes" ? "-article" : ""}` };
}

function result(request, entries, article) {
  const { key, kind, engine, withFrames, model } = request;
  const common = { key, kind, engine, withFrames, model, createdAt: new Date().toISOString(), entries };
  if (article) {
    const chapters = [{ title: "视频核心观点", text: article.overview }, ...entries.map((entry, i) =>
      ({ title: `${i + 1}. ${entry.title}`, text: entry.text, figure: entry.figure })), { title: "AI 总结", text: article.summary }];
    const contents = chapters.map(({ title }) => {
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/ /gu, "-");
      return `- [${title.replace(/[\\[\]]/gu, "\\$&")}](#${slug})`;
    });
    const markdown = [`# ${article.title}`, `> 来源链接：${article.sourceUrl}`, "## 目录", contents.join("\n"),
      ...chapters.flatMap(({ title, text, figure }) => [`## ${title}`, ...(figure ? [`![${title.replace(/[\\[\]]/gu, "\\$&")}](${figure})`] : []), text])].join("\n\n");
    return { ...common, article, figures: entries.filter(entry => entry.figure).length, markdown };
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
  constructor({ directory, download, localAi, media = { inspectVideo, extractAudio, extractFrames, extractFrameAt }, transcribe = transcribeAudio }) {
    this.root = path.join(directory, "video-analysis");
    this.download = download;
    this.localAi = localAi;
    this.media = media;
    this.transcribe = transcribe;
    this.jobs = new Map();
    // 这次运行里试过、收不了视频的模型：后面的作品直接走关键帧，不再白传一遍
    this.blind = new Set();
    // 一次收不了多张关键帧（拒收或数不对）的模型：本次运行改回一张一问
    this.oneImage = new Set();
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
    const update = (stage, message, patch) => Object.assign(view, { stage, message }, patch);
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
    if (this.batch) this.batch.stopped = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all([...jobs.map(job => job.done), this.batch?.done]);
  }

  /**
   * 批量解析：排成一队，一条做完再做下一条（公共转写服务和模型接口都经不起一起挤），页面关了也接着跑。
   * 同一时间只留一批；每条还是走 start()，结果存在各自视频名下，做过的会直接算完成。
   * body 带 retry 就是把这一批里没成的重新排上：true 是全部，视频编号是单独一条。
   */
  startBatch(body) {
    if (body?.retry !== undefined) {
      if (!this.batch) throw fail("no_batch", "没有可以重试的批量解析。", 404);
      for (const item of this.batch.items)
        if ((item.status === "failed" || item.status === "cancelled") && (body.retry === true || body.retry === item.videoId))
          Object.assign(item, { status: "waiting", message: "" });
      if (this.batch.status !== "running") this.batch.done = this.drain(this.batch);
      return this.batchView();
    }
    if (this.batch?.status === "running") throw fail("batch_busy", "上一批还没解析完，可以等它完成或先停止。", 409);
    const { items: rows, ...request } = body ?? {};
    const { kind } = options(request);
    const seen = new Set();
    const items = (Array.isArray(rows) ? rows : []).flatMap(row => {
      const videoId = typeof row?.videoId === "string" ? row.videoId : "";
      if (!/^\d{1,24}$/u.test(videoId) || seen.has(videoId)) return [];
      seen.add(videoId);
      return [{ videoId, title: typeof row.title === "string" ? row.title.trim().slice(0, 320) : "", status: "waiting", message: "" }];
    });
    if (!items.length || items.length > MAX_BATCH) throw fail("invalid_request", `一次选 1 到 ${MAX_BATCH} 条视频。`);
    this.batch = { id: randomUUID(), kind, items, request };
    this.batch.done = this.drain(this.batch);
    return this.batchView();
  }

  async drain(batch) {
    Object.assign(batch, { status: "running", stopped: false });
    for (let item; !batch.stopped && (item = batch.items.find(row => row.status === "waiting"));) {
      item.status = "running";
      try {
        await this.start(item.videoId, { ...batch.request, title: item.title });
        const { done, view } = this.jobs.get(item.videoId);
        await done;
        Object.assign(item, { status: view.status, message: view.status === "completed" ? view.note ?? "" : view.message });
      } catch (error) {
        Object.assign(item, { status: "failed", message: error.message || "解析失败，请重试。" });
      }
    }
    batch.status = "done";
  }

  async cancelBatch() {
    const batch = this.batch;
    if (batch?.status === "running") {
      batch.stopped = true;
      for (const item of batch.items) if (item.status === "waiting") item.status = "cancelled";
      const current = batch.items.find(item => item.status === "running");
      if (current) await this.cancel(current.videoId);
      await batch.done;
    }
    return this.batchView();
  }

  batchView() {
    const batch = this.batch;
    return { batch: batch ? { id: batch.id, kind: batch.kind, status: batch.status, items: batch.items.map(item => ({ ...item,
      message: item.status === "running" ? this.jobs.get(item.videoId)?.view.message ?? "" : item.message })) } : null };
  }

  async run(videoId, dir, request, signal, update) {
    const output = key => path.join(dir, "results", `${key}.json`);
    const saved = await readJson(output(request.key));
    // 分镜脚本优先让模型看整段视频：另配了视频模型就用它，没配就试上面的模型（本机 Codex / Claude Code 收不了）；
    // 以前按关键帧拆的不拦着重拆
    const watch = request.kind === "script" && (request.videoConfig || !request.config.runtime) && !this.blind.has(request.videoId || request.modelId);
    // 加配图之前写的笔记没有 figures，同样可以重做一次
    const redo = watch ? saved?.source !== "video" : request.kind === "notes" && saved?.article && saved.figures === undefined;
    if (saved && !redo) return;
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
          try {
            entries = await this.transcribe({ engine: request.engine, audioPath: audio, signal, onProgress: message => update("asr", message) });
          } catch (error) {
            // Qwen3-ASR 是首选，但它是公共服务，额度用完或连不上时改用必剪：
            // 整件事按必剪重跑（原片、音轨都已在本机），结果记在必剪名下，面板按 resultKey 跟过去
            if (request.engine !== "qwen" || signal.aborted) throw error;
            const fallback = { ...request, engine: "bcut", key: request.key.replace("-qwen", "-bcut") };
            update("asr", "Qwen3-ASR 这次没转写成功，改用必剪", { engine: "bcut", resultKey: fallback.key,
              note: `Qwen3-ASR 这次没转写成功，改用了必剪。原因：${error.message || "未知错误"}` });
            return this.run(videoId, dir, fallback, signal, update);
          }
          entries = entries.filter(row => row.text?.trim() && Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs < media.durationMs)
            .map(row => ({ startMs: Math.max(0, Math.round(row.startMs)), endMs: Math.min(media.durationMs, Math.max(0, Math.round(Math.max(row.startMs, row.endMs)))), text: row.text.trim() }))
            .sort((a, b) => a.startMs - b.startMs);
        }
      }
      transcript = result(transcriptRequest, entries);
      await save(output(transcript.key), transcript, signal);
    }
    if (request.kind === "transcript") return;
    const shots = watch ? await this.watch(source, media, request, signal, update) : null;
    if (watch && !shots && saved) return;
    let frames = shots ?? [];
    if (!shots && request.withFrames) frames = await this.describe(dir, source, media, request, signal, update);
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
      entries = [];
      for (const { figure, ...entry } of doc.entries) {
        if (figure) {
          update("figures", "正在截取配图");
          entry.figure = await this.figure(dir, source, entry, media.durationMs, signal);
        }
        entries.push(entry);
      }
      article = { title: doc.title, overview: doc.overview, summary: doc.summary, sourceUrl: `https://www.douyin.com/video/${videoId}` };
    }
    await save(output(request.key), { ...result(request, entries, article), ...(shots && { source: "video", model: (request.videoConfig ?? request.config).model }) }, signal);
  }

  /**
   * 截这一章引用的那段原片中间的一帧当配图；截不到就不配，笔记照出。
   * ponytail: 图以 data URI 存在结果里，导出的 Markdown 自带图片，也不用另开带鉴权的图片接口；
   * 一篇配图很多时结果会到几 MB，嫌大再改成存文件 + 接口。
   */
  async figure(dir, source, { startMs, endMs }, durationMs, signal) {
    const file = path.join(dir, `.figure-${randomUUID()}.jpg`);
    try {
      // 片尾最后半秒可能已经没有画面帧
      await this.media.extractFrameAt(source, file, Math.max(0, Math.min(Math.round((startMs + endMs) / 2), durationMs - 500)), signal);
      return `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`;
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    } finally { await rm(file, { force: true }).catch(() => {}); }
  }

  /** 整段视频交给模型拆镜头；收不了（原片太大、接口拒收、答非所问）返回 null，改用关键帧。 */
  async watch(source, media, request, signal, update) {
    // ponytail: 接口请求体一般限 64MB，原片超过 45MB 直接走关键帧；自带的 ffmpeg 没编视频的编码器，要压小再发得先加上
    if ((await stat(source)).size > 45 * 1024 * 1024) return null;
    const config = request.videoConfig ?? request.config;
    update("video", `正在把整段视频交给 ${config.model} 拆镜头`);
    try { return await describeVideo({ config, videoPath: source, durationMs: media.durationMs, signal }); }
    catch (error) {
      if (error.code === "video_unsupported") this.blind.add(request.videoId || request.modelId);
      else if (error.code !== "invalid_model_output") throw error;
      return null;
    }
  }

  async describe(dir, source, media, request, signal, update) {
    if (request.config.runtime === "claude" || request.config.runtime === "workbuddy")
      throw fail("vision_unsupported", `当前 ${runtimeLabel(request.config.runtime, request.config.model)} 接入仅支持文本。可改做口播笔记，或选择 Codex 或支持图片的接口模型。`);
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
    for (let start = 0; start < frames.length;) {
      signal.throwIfAborted();
      const batch = frames.slice(start, start + (this.oneImage.has(request.modelId) ? 1 : 6));
      update("vision", `正在识别画面 ${start + 1}${batch.length > 1 ? `–${start + batch.length}` : ""}/${frames.length}`);
      const entries = await Promise.all(batch.map(async frame => {
        const cached = path.join(dir, "descriptions", request.modelId, `${frame.timeMs}.json`);
        return { timeMs: frame.timeMs, filePath: path.join(directory, frame.file), cached, description: await readJson(cached) };
      }));
      const missing = entries.filter(entry => !entry.description);
      if (missing.length) {
        let fresh;
        try {
          fresh = codex
            ? await describeCodexFrames({ config: request.config, localAi: this.localAi, frames: missing, signal })
            : await describeFrames({ config: request.config, frames: missing, signal });
        } catch (error) {
          // 接口拒收多张（Key、限流、网络以外的拒绝）或回答数不对：这批从头一张一张问
          const split = error.code === "invalid_model_output" ||
            error.code === "provider_error" && !error.transient && ![401, 403, 404, 429].includes(error.httpStatus);
          if (codex || missing.length === 1 || !split) throw error;
          this.oneImage.add(request.modelId);
          continue;
        }
        for (const [i, entry] of missing.entries()) {
          entry.description = fresh[i];
          await save(entry.cached, entry.description, signal);
        }
      }
      for (const entry of entries) descriptions.push({ ...entry.description, timeMs: entry.timeMs });
      start += batch.length;
    }
    return descriptions;
  }
}
