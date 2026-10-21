import { useEffect } from "react";
import { answerAiEditLook, listPendingAiEditLooks, type AiEditLookJob } from "../../services/aiEdit";
import type { ExploreConnection } from "../../services/explorer";
import { normalizeCollectorBaseUrl } from "../../services/localCollector";
import { answerAnalysisLook, listPendingAnalysisLooks } from "../../services/videoAnalysis";
import { detectBeats, detectFlashes, detectShots, type FrameSample } from "../../services/videoLook";

// AI 剪辑请页面帮忙「看」视频：采集器不带解码器，模型又看不了视频时，在浏览器里把参考视频拆成镜头截图、
// 闪白位置和音乐节拍交回采集器；给配乐测节拍也走这里。只用浏览器自带的解码（<video> 和 Web Audio），不装任何东西。

const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 36;
// ponytail: 按时间跳着取帧，最多 480 次、最密每秒 6 次；快闪里比 1/6 秒还短的镜头会漏，要更准再改成边播边取
const MAX_SAMPLES = 480;
const MAX_RATE = 6;
const FRAME_WIDTH = 384;
const MAX_FRAMES = 40;
const MAX_BYTES = 200 * 1024 * 1024;
// 切点细化最多做前 150 刀（每刀多跳 3 次）
const MAX_REFINED = 150;
const SAMPLE_RATE = 22_050;

export interface LookAnswer {
  duration: number;
  width?: number;
  height?: number;
  audio: boolean;
  shots?: { start: number; end: number; frame: string | null }[];
  flashes?: number[];
  beats: { bpm: number; beats: number[]; strong: number[] } | null;
}

class LookError extends Error {}

/** 整个文件取到内存里解音轨（参考视频一般几 MB；太大的不解，免得把页面撑爆）。 */
async function decodeAudio(url: string, signal?: AbortSignal): Promise<AudioBuffer | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new LookError(`取不到视频文件（${response.status}）`);
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new LookError("文件超过 200MB，浏览器里解不了");
  const bytes = await response.arrayBuffer();
  const Offline = globalThis.OfflineAudioContext ?? (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  try {
    // 解码时按这个采样率重采样，测节拍够用
    return await new Offline(1, SAMPLE_RATE, SAMPLE_RATE).decodeAudioData(bytes);
  } catch {
    return null;  // 没有音轨或格式不认
  }
}

function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < out.length; index += 1) out[index] = (out[index] ?? 0) + (data[index] ?? 0) / buffer.numberOfChannels;
  }
  return out;
}

function openVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const fail = (message: string) => { video.removeAttribute("src"); video.load(); reject(new LookError(message)); };
    const timer = setTimeout(() => fail("视频加载超时"), 20_000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); fail("已停止"); }, { once: true });
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = () => { clearTimeout(timer); fail("浏览器解不开这个视频"); };
    video.onloadeddata = () => { clearTimeout(timer); resolve(video); };
    video.src = url;
  });
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.04));
  if (Math.abs(video.currentTime - target) < 0.005 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { video.onseeked = null; reject(new LookError("视频跳转超时")); }, 10_000);
    video.onseeked = () => {
      clearTimeout(timer);
      video.onseeked = null;
      // 服务器不支持分段读取时浏览器跳不过去、停在原地，取到的全是同一帧
      if (Math.abs(video.currentTime - target) > 0.5) reject(new LookError("这个视频没法跳着读，拆不了镜头"));
      else resolve();
    };
    video.currentTime = target;
  });
}

type Thumb = (t: number) => Promise<FrameSample>;

/** 跳到某个时间取一张 64×36 的小灰度图。 */
function thumbnailer(video: HTMLVideoElement, signal?: AbortSignal): Thumb {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new LookError("浏览器画不了画面");
  return async (t) => {
    if (signal?.aborted) throw new LookError("已停止");
    await seek(video, t);
    context.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const { data } = context.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const gray = new Uint8ClampedArray(THUMB_WIDTH * THUMB_HEIGHT);
    let sum = 0;
    for (let index = 0; index < gray.length; index += 1) {
      const value = 0.299 * (data[index * 4] ?? 0) + 0.587 * (data[index * 4 + 1] ?? 0) + 0.114 * (data[index * 4 + 2] ?? 0);
      gray[index] = value;
      sum += value;
    }
    return { t: Math.round(t * 1000) / 1000, gray, mean: sum / gray.length };
  };
}

/** 按时间均匀取小灰度图，给切镜和闪白判断用。 */
async function sampleFrames(video: HTMLVideoElement, thumb: Thumb): Promise<FrameSample[]> {
  const step = Math.max(1 / MAX_RATE, video.duration / MAX_SAMPLES);
  const samples: FrameSample[] = [];
  for (let t = 0; t < video.duration; t += step) samples.push(await thumb(t));
  return samples;
}

const distance = (a: FrameSample["gray"], b: FrameSample["gray"]) => {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  return sum / a.length;
};

/**
 * 切点本来只精确到两个采样之间（每秒 6 次，最多差 0.08 秒），判断是不是踩着拍点切不够准：
 * 在前后两个采样之间对半跳三次，看中间那帧更像前面还是后面，误差缩到 0.01 秒左右。
 */
async function refineCuts(samples: FrameSample[], cuts: number[], thumb: Thumb): Promise<number[]> {
  const refined: number[] = [];
  for (const [index, cut] of cuts.entries()) {
    const after = samples.findIndex((sample) => sample.t > cut);
    const left = samples[after - 1];
    const right = samples[after];
    if (index >= MAX_REFINED || !left || !right) { refined.push(cut); continue; }
    let lo = left.t;
    let hi = right.t;
    for (let step = 0; step < 3; step += 1) {
      const middle = await thumb((lo + hi) / 2);
      if (distance(middle.gray, right.gray) < distance(middle.gray, left.gray)) hi = middle.t;
      else lo = middle.t;
    }
    // 某一帧显示的是这个时间点之前最近的那一帧：新镜头从 hi 开始
    refined.push(hi);
  }
  return refined;
}

/** 每个镜头中间截一张图（镜头多时均匀挑 40 个）。 */
async function grabFrames(video: HTMLVideoElement, shots: { start: number; end: number }[], signal?: AbortSignal) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, FRAME_WIDTH / Math.max(1, video.videoWidth));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  const picked = new Set(shots.length <= MAX_FRAMES ? shots.map((_, index) => index)
    : Array.from({ length: MAX_FRAMES }, (_, index) => Math.floor((index * shots.length) / MAX_FRAMES)));
  const result: { start: number; end: number; frame: string | null }[] = [];
  for (const [index, shot] of shots.entries()) {
    let frame: string | null = null;
    if (picked.has(index) && context) {
      if (signal?.aborted) throw new LookError("已停止");
      await seek(video, (shot.start + shot.end) / 2);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frame = canvas.toDataURL("image/jpeg", 0.7);
    }
    result.push({ start: shot.start, end: shot.end, frame });
  }
  return result;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * kind=reference：镜头、截图、闪白、节拍；kind=beats：只测节拍。url 是带 key 的采集器文件地址。
 * 出错时抛的 Error 文案是给用户看的。
 */
export async function lookAtVideo(url: string, kind: "reference" | "beats", signal?: AbortSignal): Promise<LookAnswer> {
  try {
    const audio = await decodeAudio(url, signal);
    // ponytail: 节拍检测在主线程同步跑，一分钟以内的参考视频几十毫秒；三分钟的配乐在慢电脑上会卡一下，要更顺再挪进 Web Worker
    const beats = audio ? detectBeats(mono(audio), audio.sampleRate) : null;
    const tempo = beats ? { bpm: beats.bpm, beats: beats.beats, strong: beats.strong } : null;
    if (kind === "beats") {
      if (!audio) throw new LookError("这个文件里没解出声音");
      return { duration: round(audio.duration), audio: true, beats: tempo };
    }
    const video = await openVideo(url, signal);
    try {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : audio?.duration ?? 0;
      if (!duration) throw new LookError("读不出视频时长");
      const thumb = thumbnailer(video, signal);
      const samples = await sampleFrames(video, thumb);
      const rough = detectShots(samples, duration);
      const cuts = await refineCuts(samples, rough.slice(1).map((shot) => shot.start), thumb);
      const bounds = [0, ...cuts.map(round), round(duration)];
      const shots = bounds.slice(0, -1).map((start, index) => ({ start, end: bounds[index + 1] ?? start })).filter((shot) => shot.end > shot.start);
      return {
        duration: round(duration),
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        audio: Boolean(audio),
        shots: await grabFrames(video, shots, signal),
        flashes: detectFlashes(samples).map(round),
        beats: tempo,
      };
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  } catch (error) {
    if (error instanceof LookError) throw error;
    if ((error as { name?: string })?.name === "AbortError") throw new LookError("已停止");
    throw new LookError("浏览器里没能拆开这个视频");
  }
}

// 整个页面只排这一张表：切到别的视图再回来、或者开着两个工作台，同一个活儿都只接一次
const running = new Map<string, { sessionId: string; controller: AbortController }>();
const HEARTBEAT_MS = 30_000;

/**
 * 接手采集器挂出来的活儿：先报一声接手（采集器据此延长等待、标上已接手），拆的时候每 30 秒报一次进度，做完交回。
 * report 把东西交给采集器；回 look_not_found 说明这一轮已经停了或别处交过了，就不拆了。
 */
export function runLookJob(sessionId: string, job: AiEditLookJob, url: string, report: (body: unknown) => Promise<void>): void {
  if (running.has(job.id) || job.claimed) return;
  const controller = new AbortController();
  running.set(job.id, { sessionId, controller });
  const ping = () => report({ progress: true }).catch((reason: { code?: string }) => { if (reason?.code === "look_not_found") controller.abort(); });
  void (async () => {
    const heartbeat = setInterval(() => void ping(), HEARTBEAT_MS);
    try {
      await ping();
      if (controller.signal.aborted) return;
      let body: unknown;
      try {
        body = await lookAtVideo(url, job.kind, controller.signal);
      } catch (reason) {
        if (controller.signal.aborted) return;
        body = { error: reason instanceof Error ? reason.message : "浏览器里没能拆开这个视频" };
      }
      if (!controller.signal.aborted) await report(body).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      running.delete(job.id);
    }
  })();
}

/** 这个会话上挂着的活儿换了或没了（用户点了停止、超时、这一轮结束）：别的还在拆的就停下。 */
export function dropLookJobs(sessionId: string, keepId: string | null): void {
  for (const [id, entry] of running) if (entry.sessionId === sessionId && id !== keepId) entry.controller.abort();
}

const POLL_MS = 3_000;

/**
 * 挂在应用最外层：只要连着采集器，不管当前在哪个页面，每 3 秒问一次有没有要拆的视频（AI 剪辑、解析库），有就接。
 * 页面里各自的快速通道照旧（AI 剪辑长轮询一看到就接），同一个活儿只接一次；停掉的活儿由心跳回执发现后自己停。
 */
export function usePendingLooks(baseUrl: string | null, token: string | null, analysis: boolean): void {
  useEffect(() => {
    if (!baseUrl || !token) return undefined;
    const connection: ExploreConnection = { baseUrl, token };
    const root = normalizeCollectorBaseUrl(baseUrl);
    let stopped = false;
    const tick = async () => {
      const [edits, analyses] = await Promise.allSettled([
        listPendingAiEditLooks(connection),
        analysis ? listPendingAnalysisLooks(connection) : Promise.resolve([]),
      ]);
      if (stopped) return;
      if (edits.status === "fulfilled") {
        for (const { sessionId, look } of edits.value) runLookJob(sessionId, look, `${root}${look.url}`, (body) => answerAiEditLook(connection, sessionId, look.id, body));
      }
      if (analyses.status === "fulfilled") {
        for (const { id, look } of analyses.value) runLookJob(id, look, `${root}${look.url}`, (body) => answerAnalysisLook(connection, id, look.id, body));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [baseUrl, token, analysis]);
}
