import { readFile, stat } from "node:fs/promises";

import { isLocalRuntime } from "../localAi.mjs";
import { modelFetch } from "../systemProxy.mjs";
import { AnalysisError, TRUNCATED_NOTE, requestAnalysis } from "../videoAnalysis.mjs";
import { AiEditError } from "./library.mjs";
import { CANT_SEE_VIDEO, videoRefused } from "./look.mjs";

// 转写字幕：视频素材整段发给解析视频用的模型（和解析参考视频同一条路），让它按句写出台词和起止时间，
// 再按片段在时间线上的位置和倍速换成字幕时间。时间是模型听出来的，精度零点几秒，比专门的语音识别粗；
// 只看画面、听不到声音的模型转写不了。

// 和解析参考视频一样：base64 后接口收得下的上限，超过就让页面先压一份小的
const WHOLE_BYTES = 45 * 1024 * 1024;
// 页面压缩前要把整个文件取回去解码，浏览器里最多 200MB（aiEditLook.ts 的 MAX_BYTES）
const PAGE_DECODE_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 15 * 60_000;
const US = 1_000_000;
// 片段把一句剪掉了大半：剩下不到这么长（秒）或不到一半就不要了
const SHORTEST = 0.3;
const MAX_TEXT = 60;
// 秒数比较的浮点余量
const EPSILON = 1e-6;

export const MODEL_HINT = "到 AI 剪辑设置的「服务商」里给「解析视频」连一个能看视频、听得到音轨的模型，比如方舟 doubao-seed-2-1-lite";

export function transcribePrompt(seconds) {
  return [
    "只做一件事：把这段视频里人说的话（对白、旁白、口播，能听清的唱词也算）按句转写成字幕，写出每句的开始和结束时间。",
    `时间从视频开头算，单位是秒，保留一位小数；以声音为准：开始是这句第一个字出声的时刻，结束是最后一个字说完的时刻。${seconds > 0 ? `视频总长约 ${seconds} 秒，时间不要超过它。` : ""}`,
    "一条一句，每条不超过 16 个字；长句在语气停顿处拆成几条，各自写时间。",
    "照原话写，不改写、不总结；口误和重复照写；方言按听到的写成通用汉字。整句听不清就不写这一条；个别字听不清按最可能的字写，不加标注。句末不加句号。",
    "背景音乐、音效和画面上的文字都不写（除非有人在念）。",
    "只输出下面这种格式，每行一条，不要表格、不要编号、不要别的话：",
    "开始 --> 结束 | 台词",
    "例如：",
    "1.2 --> 3.5 | 大家好今天带你们去吃",
    "3.6 --> 5.0 | 这家店我排了两个小时",
    "整段视频没有人说话，只回答一行：NO_SPEECH",
    "只看得到画面、听不到声音，只回答一行：NO_AUDIO（不要照口型或画面上的字幕猜台词）",
    "看不到视频，只回答一行：NO_VIDEO",
  ].join("\n");
}

// 时间可以带 s / 秒；两个时间之间各种箭头、破折号、波浪号都认；台词前可以是竖线、冒号或只是空格
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:s|秒)?`;
const LINE = new RegExp(String.raw`^\[?${TIME}\s*(?:-->|->|→|–|—|~|～|〜|-)\s*${TIME}\]?\s*(?:(?:[|｜:：]|\s)\s*(.*))?$`, "u");
// 看着像时间行（数字、箭头、数字）：认不出来的算没按格式写，不悄悄丢句
const ARROW = /\d\s*(?:s|秒)?\s*(?:-->|->|→|～|〜)\s*\d/u;
// 模型整句听不清时偶尔还是写一条标记
const UNCLEAR = /^[（(]\s*听不[清到见]\s*[）)]$/u;
// 只看画面的模型不知道该回标记时，常常直接说一句听不到
const CANT_HEAR = /听不[到见清][^。\n]{0,6}(声音|音频|音轨|语音)|无法(听|获取|识别|处理|访问)[^。\n]{0,6}(音频|音轨|声音|语音)|没有(音频|音轨|声音)(输入|信息|数据)|只能看到画面|can(?:no|')t\s+hear|no audio/iu;

/** 1.5、01:02.5、00:01:02,500 都换成秒。 */
function toSeconds(value) {
  return value.replace(",", ".").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** 一行是不是某个标记：去掉首尾的标点、反引号、星号再比（「NO_SPEECH。」「`NO_SPEECH`」都算）。 */
const isMark = (row, word) => row.replace(/^[`*_"'“「\s]+|[`*_"'”」。．.!！\s]+$/gu, "").toUpperCase() === word;

/**
 * 模型的回答换成按开始时间排好的 [{ start, end, text }]（素材自己的秒数）。认「开始 --> 结束 | 台词」，带编号、
 * 没写竖线、照着 SRT 写（时间一行、台词下一行）也认。NO_SPEECH 是空数组；有像时间行却认不出来的，或者一句都认不出来，
 * 算没按格式写。整句「（听不清）」的不进字幕，条数挂在返回值的 unclear 上。
 */
export function parseTranscript(answer, seconds = 0) {
  const rows = String(answer ?? "").replace(/```[a-z]*/giu, "").replace(/\*\*|`/gu, "").split(/\r?\n/u)
    // 行首的圆点，以及后面紧跟时间的编号（「1. 」「1、」「1)」；「1.2 --> 」里的 1. 不算）
    .map((row) => row.trim().replace(/^(?:[-*•·]\s*|\d{1,3}(?:\.\s+|[、)）]\s*)(?=\[?\d))/u, ""));
  const hearsNothing = rows.some((row) => isMark(row, "NO_AUDIO"));
  if (hearsNothing || rows.some((row) => isMark(row, "NO_VIDEO"))) {
    throw new AiEditError("video_unsupported", `解析视频用的模型${hearsNothing ? "听不到视频里的声音" : "看不到视频"}，转写不了字幕：${MODEL_HINT}。`, 422);
  }
  if (rows.some((row) => isMark(row, "NO_SPEECH"))) return [];
  const lines = [];
  let pending = null;
  let missed = 0;
  for (const row of rows) {
    if (!row || /^\d+$/u.test(row)) continue;
    const match = LINE.exec(row);
    if (match) {
      const [, from, to, text] = match;
      pending = { start: toSeconds(from), end: toSeconds(to) };
      if (text?.trim()) {
        lines.push({ ...pending, text: text.trim() });
        pending = null;
      }
    } else if (ARROW.test(row)) {
      missed += 1;
    } else if (pending) {
      lines.push({ ...pending, text: row });
      pending = null;
    }
  }
  const limit = seconds > 0 ? seconds : Infinity;
  const clean = lines
    .map(({ start, end, text }) => ({ start, end: Math.min(end, limit), text: text.replace(/^["“「]|["”」]$/gu, "").trim().slice(0, MAX_TEXT) }))
    .filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.start >= 0 && line.end - line.start >= 0.1 && line.text)
    .sort((a, b) => a.start - b.start);
  // 一行写了两句（台词里还夹着时间和箭头）也算没按格式写
  missed += clean.filter((line) => ARROW.test(line.text)).length;
  if (!clean.length && rows.some((row) => CANT_HEAR.test(row) || CANT_SEE_VIDEO.test(row))) {
    throw new AiEditError("video_unsupported", `解析视频用的模型说它听不到视频里的声音，转写不了字幕：${MODEL_HINT}。`, 422);
  }
  if (!clean.length || missed) throw new AiEditError("transcribe_unreadable", "模型有台词没按格式写出时间，再试一次；一直这样就换个模型。", 502);
  const heard = clean.filter((line) => !UNCLEAR.test(line.text));
  return heard.length === clean.length ? heard : Object.assign(heard, { unclear: clean.length - heard.length });
}

/**
 * 素材整段转写一次（不缓存，调用方记住）。回 [{ start, end, text }]，没人说话是空数组；
 * 回答写到长度上限时去掉最后一句（可能只写了一半），返回值挂上 cutAt（只转写到素材第几秒）。
 */
export async function transcribeMedia(ctx, item) {
  if (isLocalRuntime(ctx.config?.runtime)) {
    throw new AiEditError("video_unsupported", `本机 Codex / Claude 听不了视频里的声音，转写不了字幕：${MODEL_HINT}（接口模式）。`, 422);
  }
  if (ctx.config?.videoInput === false) throw new AiEditError("video_unsupported", `解析视频用的模型看不了视频，转写不了字幕：${MODEL_HINT}。`, 422);
  const file = ctx.library.readyPath(item.id);
  const { size } = await stat(file);
  let bytes;
  if (size <= WHOLE_BYTES) {
    bytes = await readFile(file);
  } else {
    if (size > PAGE_DECODE_BYTES) throw new AiEditError("video_too_large", "这个视频超过 200MB，应用里压不了，转写不了：先把素材剪短一点再转写。", 413);
    if (!ctx.askLook) throw new AiEditError("look_unavailable", "这个视频超过 45MB，要开着应用先压一份小的才能转写。", 409);
    const squeezed = await ctx.askLook({ kind: "squeeze", url: `/v1/ai-edit/media/${item.id}/file`, name: item.name, bytes: WHOLE_BYTES });
    bytes = squeezed.video;
    if (!bytes?.length || bytes.length > WHOLE_BYTES) throw new AiEditError("video_too_large", "视频压过以后还是超过 45MB，模型接口收不下：先把素材剪短一点再转写。", 413);
    if (!squeezed.audio) throw new AiEditError("no_audio", "这个视频压缩时没能带上声音，转写不了：先把素材剪短到 45MB 以内再转写。", 422);
  }
  const seconds = item.durationUs ? Math.round(item.durationUs / 100_000) / 10 : 0;
  let status = 0;
  const fetchImpl = async (...args) => {
    const response = await (ctx.fetchImpl ?? modelFetch)(...args);
    status = response.status;
    return response;
  };
  ctx.onGenerating?.(`正在听“${item.name}”里的台词，一般要半分钟到两分钟…`);
  let answer;
  try {
    answer = await requestAnalysis({
      config: ctx.config,
      prompt: transcribePrompt(seconds),
      videoBase64: bytes.toString("base64"),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean)),
      fetchImpl,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof AnalysisError) {
      const refused = error.code === "provider_error" && videoRefused(status, error.message);
      throw new AiEditError(refused ? "video_unsupported" : error.code, refused ? `解析视频用的模型看不了视频，转写不了字幕（${error.message}）：${MODEL_HINT}。` : error.message, error.status);
    }
    throw new AiEditError("transcribe_failed", error?.name === "TimeoutError" ? "模型太久没转写完，稍后重试。" : "台词没转写成功，稍后重试。");
  } finally {
    ctx.onGenerating?.(null);
  }
  const cut = answer.endsWith(TRUNCATED_NOTE);
  // 截断时连最后一行（可能只写了一半，或者只写了时间）一起去掉
  const lines = parseTranscript(cut ? answer.slice(0, -TRUNCATED_NOTE.length).replace(/[^\n]*$/u, "") : answer, seconds);
  return cut ? Object.assign(lines, { cutAt: lines.at(-1)?.end ?? 0 }) : lines;
}

/**
 * 一段片段截取到的台词换成时间线上的字幕时间：只要落在截取区间里的，按倍速换算；被剪掉大半的句子不要。
 * segment 是 ProjectStore 的媒体片段（timeline、source 都是微秒）。
 */
export function placeLines(lines, segment) {
  const speed = segment.speed > 0 ? segment.speed : 1;
  const from = segment.source.start_us / US;
  const to = from + segment.source.duration_us / US;
  const at = segment.timeline.start_us / US;
  return lines.flatMap((line) => {
    const start = Math.max(line.start, from);
    const end = Math.min(line.end, to);
    if (end - start <= EPSILON) return [];
    // 被片段截过的才按「剩太短或不到一半就不要」判；整句都在里面的短句（「对」「嗯」）照留
    const cut = start > line.start + EPSILON || end < line.end - EPSILON;
    if (cut && end - start < Math.max(SHORTEST, (line.end - line.start) / 2) - EPSILON) return [];
    return [{ start: at + (start - from) / speed, end: at + (end - from) / speed, text: line.text }];
  });
}

/** 几段片段的字幕拼在一起：按开始排好，前一句盖到后一句时截到后一句开始，太短的不要。 */
export function mergeCaptions(captions) {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const caption of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.end > caption.start) {
      previous.end = caption.start;
      if (previous.end - previous.start < 0.2) merged.pop();
    }
    merged.push({ ...caption });
  }
  return merged;
}
