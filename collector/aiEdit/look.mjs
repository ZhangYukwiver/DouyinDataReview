import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { AiEditError } from "./library.mjs";

// 看不了视频的模型怎么「看」参考视频：采集器不带解码器（也不打包 ffmpeg），由开着的应用页面在浏览器里
// 把视频拆成镜头截图、闪白位置和音乐节拍交回来，再由采集器把截图和数字交给模型。这里管三件事：
// 给页面开临时的视频地址（下载下来的参考视频不在素材库里）、把活儿挂到正在跑的这一轮上等页面交回、核对交回来的东西。

export const LOOK_TIMEOUT_MS = 3 * 60_000;
const FILE_TTL_MS = 30 * 60_000;
const MAX_SHOTS = 400;
const MAX_FRAMES = 40;
const MAX_FRAME_CHARS = 400_000;
const MAX_POINTS = 2_000;
const FRAME_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/u;

// 应用页面开着就会接手（不管在哪个页面，见 src/components/workspace/aiEditLook.ts 的 usePendingLooks）；
// 重试的说法不同：AI 剪辑让 AI 再解析一次，解析库点「重新解析」
const lookTexts = (retry) => ({
  unavailable: `要靠应用在浏览器里处理这个视频，可是没有开着的应用页面来接手。打开应用，${retry}。`,
  dropped: `应用页面处理到一半断了（可能刷新或关掉了）。开着应用，${retry}。`,
  slow: "处理这个视频太久了，可能视频太长或者电脑太忙。换一条短一点的视频再试。",
});
const AI_EDIT_TEXTS = lookTexts("再让 AI 解析一次");
export const LIBRARY_TEXTS = lookTexts("再点「重新解析」");
export const LOOK_UNAVAILABLE = AI_EDIT_TEXTS.unavailable;
const LOOK_MAX_MS = 10 * 60_000;

const seconds = (value, max) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 100) / 100 : null);

function times(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_POINTS).map((value) => seconds(value, max)).filter((value) => value !== null).sort((a, b) => a - b);
}

/** 页面交回来的结果：信任边界，逐项核对、限量，不认识的字段丢掉。 */
export function parseLookResult(body, kind) {
  if (typeof body?.error === "string" && body.error.trim()) return { error: body.error.trim().slice(0, 300) };
  const duration = seconds(body?.duration, 6 * 3600);
  if (!duration) throw new AiEditError("look_invalid", "页面交回的视频信息不完整。", 422);
  if (kind === "squeeze") {
    const video = typeof body.video === "string" ? Buffer.from(body.video, "base64") : null;
    if (video?.toString("latin1", 4, 8) !== "ftyp") throw new AiEditError("look_invalid", "页面交回的压缩视频不是 mp4。", 422);
    return { duration, video, audio: body.audio === true };
  }
  const beats = body.beats && typeof body.beats === "object" ? {
    bpm: typeof body.beats.bpm === "number" && body.beats.bpm >= 30 && body.beats.bpm <= 300 ? Math.round(body.beats.bpm * 10) / 10 : null,
    times: times(body.beats.beats, duration),
    strong: times(body.beats.strong, duration),
  } : null;
  const result = { duration, beats: beats?.bpm && beats.times.length ? beats : null, audio: body.audio === true };
  if (kind === "beats") return result;
  const shots = (Array.isArray(body.shots) ? body.shots.slice(0, MAX_SHOTS) : []).map((shot) => {
    const start = seconds(shot?.start, duration);
    const end = seconds(shot?.end, duration);
    if (start === null || end === null || end <= start) return null;
    const frame = typeof shot.frame === "string" && shot.frame.length <= MAX_FRAME_CHARS && FRAME_URL.test(shot.frame) ? shot.frame : null;
    return { start, end, frame };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
  if (!shots.length) throw new AiEditError("look_invalid", "页面没能从视频里切出镜头。", 422);
  // 截图最多留 MAX_FRAMES 张，镜头多时均匀挑
  const framed = shots.filter((shot) => shot.frame);
  if (framed.length > MAX_FRAMES) {
    const keep = new Set(Array.from({ length: MAX_FRAMES }, (_, index) => framed[Math.floor((index * framed.length) / MAX_FRAMES)]));
    for (const shot of shots) if (shot.frame && !keep.has(shot)) shot.frame = null;
  }
  return {
    ...result,
    width: Number.isInteger(body.width) && body.width > 0 ? body.width : null,
    height: Number.isInteger(body.height) && body.height > 0 ? body.height : null,
    shots,
    flashes: times(body.flashes, duration),
  };
}

/**
 * filePath：给页面的临时视频地址前缀（AI 剪辑和解析库各开一个台子）。活儿挂在调用方给的 holder 上：
 * { id, live()?: 现在还能挂吗, get(): 当前挂着的, set(look): 挂上/摘下（不存盘）, touch(): 叫醒页面 }。
 */
export function createLookDesk({ filePath = "/v1/ai-edit/look", texts = AI_EDIT_TEXTS, timeoutMs = LOOK_TIMEOUT_MS, maxMs = LOOK_MAX_MS, now = () => Date.now() } = {}) {
  const files = new Map();
  const jobs = new Map();

  const sweep = () => {
    for (const [token, entry] of files) if (entry.expires <= now()) files.delete(token);
  };

  return {
    /** 下载下来的参考视频开一个临时地址，半小时后失效。 */
    offerFile(file) {
      sweep();
      const token = randomBytes(16).toString("hex");
      files.set(token, { file, expires: now() + FILE_TTL_MS });
      return `${filePath}/${token}/file`;
    },

    async sendFile(request, response, token) {
      sweep();
      const entry = /^[0-9a-f]{32}$/u.test(token) ? files.get(token) : null;
      let size = 0;
      try { size = entry ? (await stat(entry.file)).size : 0; } catch { size = 0; }
      if (!entry || !size) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "look_not_found", message: "这个视频地址已经失效了。" }));
        return;
      }
      // 页面先整段取来解码音轨、再按时间跳着取帧，支持 Range 就够用
      const match = /^bytes=(\d*)-(\d*)$/u.exec(String(request.headers.range ?? "").trim());
      let start = 0;
      let end = size - 1;
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        if (match[1] && match[2]) end = Math.min(Number(match[2]), size - 1);
        if (start >= size || start > end) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` });
          response.end();
          return;
        }
      }
      const partial = start !== 0 || end !== size - 1;
      response.writeHead(partial ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      await pipeline(createReadStream(entry.file, { start, end }), response).catch(() => response.destroy());
    },

    /**
     * 把活儿挂到 holder 上，页面轮询看到后在浏览器里做完交回。
     * kind：reference（镜头、截图、闪白、节拍）、beats（只要节拍）或 squeeze（重新编一份不超过 bytes 的 mp4）。
     */
    ask(holder, { kind, url, name, bytes }, { signal } = {}) {
      if (holder.live && !holder.live()) return Promise.reject(new AiEditError("look_unavailable", texts.unavailable, 409));
      const id = randomBytes(8).toString("hex");
      const mine = () => holder.get()?.id === id;
      return new Promise((resolve, reject) => {
        const finish = (settle, value) => {
          const job = jobs.get(id);
          if (!job) return;
          jobs.delete(id);
          clearTimeout(job.timer);
          clearTimeout(job.cap);
          signal?.removeEventListener("abort", job.abort);
          if (mine()) {
            holder.set(null);
            holder.touch();
          }
          settle(value);
        };
        const job = {
          holderId: holder.id,
          holder,
          kind,
          claimed: false,
          timer: null,
          // 页面接手后每隔一阵报一次进度，每报一次就从现在起再等 timeoutMs
          arm: () => {
            clearTimeout(job.timer);
            job.timer = setTimeout(() => {
              // 接手的页面断了心跳（刷新、关掉）：撤掉「已接手」再给一轮，刷新后的页面或别的窗口还能接
              if (job.claimed && !job.reoffered && mine()) {
                job.claimed = false;
                job.reoffered = true;
                holder.set({ ...holder.get(), claimed: false });
                holder.touch();
                job.arm();
                return;
              }
              finish(reject, job.claimed || job.reoffered
                ? new AiEditError("look_dropped", texts.dropped, 504)
                : new AiEditError("look_unavailable", texts.unavailable, 504));
            }, timeoutMs);
          },
          // 页面一直报进度却迟迟做不完：从挂出来算最多等 10 分钟
          cap: setTimeout(() => finish(reject, new AiEditError("look_slow", texts.slow, 504)), maxMs),
          abort: () => finish(reject, Object.assign(new Error("stopped"), { name: "AbortError" })),
          resolve: (value) => finish(resolve, value),
          reject: (error) => finish(reject, error),
        };
        job.arm();
        jobs.set(id, job);
        if (signal?.aborted) { job.abort(); return; }
        signal?.addEventListener("abort", job.abort, { once: true });
        holder.set({ id, kind, url, ...(name ? { name: String(name).slice(0, 80) } : {}), ...(bytes ? { bytes } : {}) });
        holder.touch();
      });
    },

    /** 页面交回结果（或做不了的原因）；{ progress: true } 是接手和进度回执。 */
    answer(holderId, jobId, body) {
      const job = jobs.get(jobId);
      if (!job || job.holderId !== holderId) throw new AiEditError("look_not_found", "这次解析已经结束了。", 404);
      if (body?.progress === true) {
        job.arm();
        if (!job.claimed) {
          job.claimed = true;
          // 标上已接手：同时开着的别的窗口就不再接
          if (job.holder.get()?.id === jobId) {
            job.holder.set({ ...job.holder.get(), claimed: true });
            job.holder.touch();
          }
        }
        return;
      }
      let result;
      try {
        result = parseLookResult(body, job.kind);
      } catch (error) {
        job.reject(error);
        throw error;
      }
      if (result.error) job.reject(new AiEditError("look_failed", `页面没能拆开这个视频：${result.error}`, 422));
      else job.resolve(result);
    },

    close() {
      for (const job of jobs.values()) job.reject(new AiEditError("interrupted", "采集器关掉了。", 503));
      files.clear();
    },
  };
}

// ---------- 模型到底看没看到：AI 剪辑看参考视频、解析库都用 ----------
const CANT_SEE_VIDEO = /(无法|不能|没法|没有办法|不支持)(直接)?(读取|查看|观看|看到|播放|处理|解析|理解|访问|打开|接收)[^。\n]{0,8}视频|看不[到了见][^。\n]{0,4}视频|(can(?:no|')t|unable to|not able to)\s+(view|watch|see|process|access|open|analy[sz]e)[^.\n]{0,30}video/iu;
const VIDEO_WORDS = /video|视频|multimodal|多模态|unknown variant|content type/iu;
// 提示词让模型看不到时只回一行标记；不听话的模型（远端实测过）会照样写一份全是「未知」的拆解，
// 开头交代「没有视频文件、只有页面文字信息」，第②部分十个维度大半写「未知」，这时也算没看到
const BLIND = /(没有|缺少|还缺|拿不到|未提供|没有提供|没有收到)[^。\n]{0,4}(视频文件|视频画面|视频本体|视频本身|可读取的?(视频|画面|链接)|可访问的?视频)|只有(页面)?(文字|标题|文本)信息|无法直接(观看|查看|读取)[^。\n]{0,4}视频|看不到视频(内容|画面)/u;
const NO_IMAGES = /^[^。\n]{0,40}(没有(收到|看到)?(任何)?(图片|截图)|看不到(任何)?(图片|截图)|未(收到|提供)(任何)?(图片|截图))(?![里中上])/u;

/** 第②部分维度表（「| 1. 视频档案 |」这样的行）一半以上写着「未知」：模型其实什么都没看到。 */
function mostlyUnknown(markdown) {
  const rows = markdown.split("\n").filter((line) => /^\s*\|\s*\d{1,2}\s*[.、]/u.test(line));
  return rows.length >= 5 && rows.filter((line) => line.includes("未知")).length * 2 >= rows.length;
}
const blind = (markdown) => /^\s*NO_VIDEO\b/u.test(markdown) || (BLIND.test(markdown.slice(0, 800)) && mostlyUnknown(markdown));
// 截图模式里听不到的项让模型写「听不到」，维度表大半还是「未知」又说没拿到材料，就是连截图也没看到
const blindToImages = (markdown) => /^\s*NO_IMAGES\b/u.test(markdown) || NO_IMAGES.test(markdown.slice(0, 200)) || blind(markdown);

/** 接口拒收视频：一般回 400/415/422，有的中转站回 200、错误写在正文或流里。strict（配置时探测）：400 也要说的是视频，免得把 Key 不对当成看不了。 */
export function videoRefused(status, message, { strict = false } = {}) {
  if (strict) return [400, 415, 422, 200].includes(status) && VIDEO_WORDS.test(message);
  return [400, 415, 422].includes(status) || (status === 200 && VIDEO_WORDS.test(message));
}

/** 整段视频发过去了，回答却说看不到（没有表格的直说，或者回标记，或者开头说没拿到、维度表大半「未知」）。 */
export const seesNoVideo = (markdown) => (!/\|\s*:?-{3,}/u.test(markdown) && CANT_SEE_VIDEO.test(markdown)) || blind(markdown);

/** 截图发过去了，回答说没看到图（听不到的项让模型写「听不到」，维度表大半还是「未知」又说没拿到材料，也算）。 */
export const seesNoImages = (markdown) => /^\s*NO_IMAGES\b/u.test(markdown) || NO_IMAGES.test(markdown.slice(0, 200)) || blind(markdown);

const SYNC_WORDS = { synced: "是踩着拍点剪的", partly: "有一部分切点卡在拍上", none: "不是卡点剪辑", few: "切点太少，看不出是不是卡点" };

/** 页面拆好的东西整理成交给模型的材料：镜头表、闪白、节拍、切点和拍点的关系，再接每个镜头一张截图。measured 给对话里的模型看个大概。 */
export function lookMaterials(look) {
  const span = (shot) => `${shot.start}–${shot.end}`;
  const align = cutsOnBeats(look.shots, look.beats?.times);
  const lines = [
    `视频时长 ${look.duration} 秒，${look.shots.length} 个镜头${look.width ? `，画面 ${look.width}×${look.height}` : ""}。`,
    "镜头表（序号｜起止秒｜时长）：",
    ...look.shots.map((shot, index) => `${index + 1}｜${span(shot)}｜${Math.round((shot.end - shot.start) * 100) / 100}`),
    look.flashes.length ? `闪白或闪黑：${look.flashes.join("、")} 秒。` : "没测到闪白或闪黑。",
    look.beats
      ? `音乐约 ${look.beats.bpm} BPM。拍点（秒）：${look.beats.times.slice(0, 240).join("、")}${look.beats.times.length > 240 ? " 等" : ""}。重拍：${look.beats.strong.join("、") || "没有特别突出的"}。`
      : look.audio ? "音轨里没测出稳定的节拍（可能是人声或环境声为主）。" : "这个视频没有音轨。",
    ...(align ? [`切镜和拍点：${align.total} 刀里有 ${align.onBeat} 刀离拍点不到 80 毫秒（这个速度随便切也有约 ${Math.round(align.chance * 100)}% 会碰上），离最近拍点的中位距离 ${align.medianDistance} 秒，${SYNC_WORDS[align.verdict]}。`] : []),
  ];
  const parts = [{ type: "text", text: lines.join("\n") }];
  look.shots.forEach((shot, index) => {
    // 截图只有 384 宽，按低清晰度算 token 几乎不丢细节，40 张少算四五倍，模型也回得快
    if (shot.frame) parts.push({ type: "text", text: `镜头 ${index + 1}（${span(shot)} 秒）` }, { type: "image_url", image_url: { url: shot.frame, detail: "low" } });
  });
  const measured = { shots: look.shots.length, ...(look.beats ? { bpm: look.beats.bpm } : {}), ...(align ? { cuts_on_beat: `${align.onBeat}/${align.total}`, beat_synced: SYNC_WORDS[align.verdict] } : {}) };
  return { parts, measured };
}

/** 随便切的话，n 刀里至少 k 刀碰上拍点的概率。 */
function binomialTail(n, k, p) {
  let term = (1 - p) ** n;
  let below = 0;
  for (let i = 0; i < k; i += 1) {
    below += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.max(0, 1 - below);
}

/**
 * 每一刀离最近的拍点多远，判断原片是不是踩着点剪的。随便切也会有一部分碰上拍点（拍子越密越多），
 * 所以带上随机基准 chance 再下结论：synced 卡点剪辑、partly 部分卡拍、none 不是卡点。
 */
export function cutsOnBeats(shots, beats, tolerance = 0.08) {
  const cuts = shots.slice(1).map((shot) => shot.start);
  if (!cuts.length || !Array.isArray(beats) || beats.length < 2) return null;
  const distances = cuts.map((cut) => Math.min(...beats.map((beat) => Math.abs(cut - beat)))).sort((a, b) => a - b);
  const gaps = beats.slice(1).map((beat, index) => beat - beats[index]).sort((a, b) => a - b);
  const interval = gaps[Math.floor(gaps.length / 2)];
  const onBeat = distances.filter((distance) => distance <= tolerance + 1e-9).length;
  const share = onBeat / cuts.length;
  const middle = distances.length / 2;
  const median = distances.length % 2 ? distances[Math.floor(middle)] : (distances[middle - 1] + distances[middle]) / 2;
  const medianDistance = Math.round(median * 1000) / 1000;
  const chance = Math.min(1, (2 * tolerance) / interval);
  // 比随便切碰上拍点的次数明显多才算卡点（单侧二项检验 p < 0.05）；刀数太少不下结论
  const significant = binomialTail(cuts.length, onBeat, chance) < 0.05;
  const verdict = cuts.length < 4 ? "few" : !significant ? "none" : share >= 0.8 ? "synced" : "partly";
  return { onBeat, total: cuts.length, medianDistance, chance: Math.round(chance * 100) / 100, verdict };
}
