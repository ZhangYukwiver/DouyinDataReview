import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENE_THRESHOLD = 0.35;
const MIN_FRAME_INTERVAL_SECONDS = 0.5;
const FRAME_BUDGET = 300;
const MAX_DIAGNOSTIC_BYTES = 1_000_000;

export class VideoAnalysisMediaError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "VideoAnalysisMediaError";
    this.code = code;
  }
}

function binaryName(kind) {
  return process.platform === "win32" ? `${kind}.exe` : kind;
}

function existsFile(filePath) {
  return stat(filePath).then((value) => value.isFile()).catch(() => false);
}

async function resolveTool(kind) {
  const binary = binaryName(kind);
  const target = `${process.platform}-${process.arch}`;
  const resources = process.resourcesPath;
  if (resources) {
    const bundled = join(resources, "media-tools", target, binary);
    if (await existsFile(bundled)) return bundled;
    if (projectDirectory.endsWith(".asar") || projectDirectory === join(resources, "app"))
      throw new VideoAnalysisMediaError("tool_missing", `安装包缺少 ${binary}，请重新安装桌面应用。`);
  }
  const staged = join(projectDirectory, "build", "media-tools", target, binary);
  return await existsFile(staged) ? staged : binary;
}

function abortError() {
  return new VideoAnalysisMediaError("aborted", "视频解析已取消。");
}

function runTool(command, args, { signal, onStderr } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let aborted = false;
    let stderr = "";
    let stdout = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolvePromise(result);
    };
    const stop = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 1500);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => finish(aborted ? abortError() : new VideoAnalysisMediaError("tool_failed", "媒体工具启动失败。", error)));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
      onStderr?.(chunk);
    });
    child.on("close", (code, signalName) => {
      if (settled) return;
      if (aborted) return finish(abortError());
      if (code === 0) return finish(null, { stdout, stderr });
      finish(new VideoAnalysisMediaError("tool_failed", `媒体工具执行失败（${signalName || code}）。`, new Error(stderr.slice(-1200))));
    });
  });
}

function ensurePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} 必须是文件路径。`);
  return resolve(value);
}

export async function inspectVideo(filePath, signal) {
  const inputPath = ensurePath(filePath, "filePath");
  const probe = await resolveTool("ffprobe");
  let result;
  try {
    result = await runTool(probe, [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type",
      "-of", "json", inputPath,
    ], { signal });
  } catch (error) {
    if (error instanceof VideoAnalysisMediaError) throw error;
    throw new VideoAnalysisMediaError("probe_failed", "无法读取视频信息。", error);
  }
  let metadata;
  try { metadata = JSON.parse(result.stdout); }
  catch (error) { throw new VideoAnalysisMediaError("probe_invalid", "视频信息格式无效。", error); }
  const durationSeconds = Number(metadata?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new VideoAnalysisMediaError("probe_invalid", "视频没有有效时长。");
  }
  return {
    durationMs: Math.round(durationSeconds * 1000),
    hasAudio: Array.isArray(metadata?.streams) && metadata.streams.some((stream) => stream?.codec_type === "audio"),
  };
}

export async function extractAudio(filePath, outputPath, signal, metadata) {
  const inputPath = ensurePath(filePath, "filePath");
  const destination = ensurePath(outputPath, "outputPath");
  const info = metadata ?? await inspectVideo(inputPath, signal);
  if (!info.hasAudio) return { silent: true };
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const ffmpeg = await resolveTool("ffmpeg");
  await runTool(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", destination,
  ], { signal });
  const volume = await runTool(ffmpeg, [
    "-hide_banner", "-i", destination, "-af", "volumedetect", "-f", "null", "-",
  ], { signal });
  const match = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/u.exec(volume.stderr);
  const silent = match?.[1] === "-inf" || (match && Number(match[1]) <= -60);
  return { silent: Boolean(silent) };
}

function parseShowinfoTimestamps(stderr) {
  const timestamps = [];
  for (const line of stderr.split(/\r?\n/u)) {
    const match = /showinfo.*?pts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/u.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0) timestamps.push(Math.round(value * 1000));
  }
  return timestamps;
}

export async function extractFrames(filePath, outputDirectory, signal, metadata) {
  const inputPath = ensurePath(filePath, "filePath");
  const directory = ensurePath(outputDirectory, "outputDirectory");
  const info = metadata ?? await inspectVideo(inputPath, signal);
  if (info.durationMs <= 0) return [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) {
    if (/^frame-\d{6}\.jpg$/u.test(name)) await rm(join(directory, name), { force: true });
  }
  const ffmpeg = await resolveTool("ffmpeg");
  const durationSeconds = info.durationMs / 1000;
  const sceneGapSeconds = Math.max(MIN_FRAME_INTERVAL_SECONDS, durationSeconds / FRAME_BUDGET);
  const periodicGapSeconds = Math.max(7, sceneGapSeconds);
  const tailFrameStartSeconds = Math.max(0, durationSeconds - 0.75);
  const filter = `select='isnan(prev_selected_t)+gt(scene\\,${SCENE_THRESHOLD})*gte(t-prev_selected_t\\,${sceneGapSeconds})+gte(t-prev_selected_t\\,${periodicGapSeconds})+gte(t\\,${tailFrameStartSeconds})*lt(prev_selected_t\\,${tailFrameStartSeconds})',showinfo`;
  const result = await runTool(ffmpeg, [
    "-hide_banner", "-loglevel", "info", "-i", inputPath,
    "-map", "0:v:0", "-an", "-vf", filter, "-fps_mode", "passthrough",
    "-q:v", "3", join(directory, "frame-%06d.jpg"),
  ], { signal });
  const files = (await readdir(directory))
    .filter((name) => /^frame-\d{6}\.jpg$/u.test(name))
    .sort()
    .map((name) => join(directory, name));
  if (files.length === 0) return [];
  const timestamps = parseShowinfoTimestamps(result.stderr);
  if (timestamps.length !== files.length) {
    throw new VideoAnalysisMediaError("frame_timestamps_missing", "无法为画面帧对齐原片时间。", new Error(`frames=${files.length}, timestamps=${timestamps.length}`));
  }
  return files.map((framePath, index) => ({ timeMs: timestamps[index], filePath: framePath }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

/** 取原片某一刻的一帧存成 JPEG（学习笔记的配图），长边不超过 960。 */
export async function extractFrameAt(filePath, outputPath, timeMs, signal) {
  const ffmpeg = await resolveTool("ffmpeg");
  await runTool(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", (timeMs / 1000).toFixed(3), "-i", ensurePath(filePath, "filePath"),
    "-map", "0:v:0", "-an", "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))'",
    "-q:v", "4", "-update", "1", ensurePath(outputPath, "outputPath"),
  ], { signal });
}

export const mediaToolNames = Object.freeze({ ffmpeg: binaryName("ffmpeg"), ffprobe: binaryName("ffprobe") });

