import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeDouyinVideoUrl } from "./videoDownloader.mjs";

// 解析库：采集器把视频（最低一档清晰度）下到本地，整段视频连同拆解提示词发给用户自己配的 OpenAI 兼容接口
// （默认火山方舟 doubao-seed-2-1-lite，能听音轨），答案存进数据目录的 analyses.json，不分账号。
// 接口 Key 每次随请求带来、用完即丢，不落盘。

export const ANALYSIS_PROMPT = `请从创作者角度拆解我提供的视频，目标是提炼可复用的创作方法，帮助我设计下一条内容。

请分析以下维度：
1. 视频档案：标题、封面、时长、作者、发布时间、词条；缺失信息标注“未知”。
2. 选题与受众：讲什么、可能面向谁、回应什么痛点或欲望、承诺给观众什么收益、切入角度有什么特点。
3. 开头钩子：首个画面、开头原话、吸引注意的具体机制，以及它制造了什么期待。
4. 内容结构：段落顺序、信息递进、冲突、悬念、转折、论据，以及何时兑现开头的承诺。
5. 人物与表达：人物身份、角色关系、口吻、表演方式，以及可信度来自哪里。
6. 画面与声音：场景、景别、镜头运动、素材、字幕、旁白、音乐和音效分别起什么作用。
7. 节奏与情绪：剪辑节点、停顿、信息密度、情绪变化、高潮位置，以及可能影响观看体验的片段。
8. 记忆与传播：金句、标志性画面、实用信息、潜在收藏点、分享理由和讨论点。
9. 结尾与行动：如何收尾、引导观众做什么、关注理由是什么，是否有产品或服务承接。
10. 创作复用：可复用的结构和手法、依赖的特殊资源、制作难点，以及适合我创作方向的改编方式。

请按以下顺序输出：
① 用三句话概括选题、观看收益和主要创作机制。
② 用“维度｜具体发现｜时间戳或原话证据｜创作启示”的表格展开分析。
③ 按实际内容段落生成时间轴表：“起止时间｜台词/字幕摘要｜画面与声音｜段落作用｜创作手法”。
④ 提炼一个可填空的脚本结构模板，并给出三个适合我方向的改编选题。
⑤ 提出下一条视频最值得测试的一个变量，说明假设、修改方式和验证指标；没有数据时标注待验证。

关键判断必须对应具体片段或原话。清楚区分“可观察事实”和“分析假设”：目标受众、传播理由、创作意图属于推测；完播、留存、涨粉和成交只能使用已提供的数据。用具体表现解释“节奏好”“有共鸣”等评价。

如果无法读取视频，请说明当前能读取哪些材料、还缺什么；仅依据实际可见内容分析，不编造画面、台词、时间戳或效果数据。`;

const MAX_ITEMS = 500;
const MAX_ANSWER_TOKENS = 16_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MODEL_TIMEOUT_MS = 15 * 60_000;

export class AnalysisError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 请求体里的接口配置：信任边界，地址只认 http(s)，各项限长。 */
export function parseAnalysisConfig(value) {
  const text = (item, max) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  const baseUrl = text(value?.baseUrl, 300).replace(/\/+$/u, "");
  const apiKey = text(value?.apiKey, 400);
  const model = text(value?.model, 120);
  let protocol = "";
  try { protocol = new URL(baseUrl).protocol; } catch { /* 下面统一报错 */ }
  if (protocol !== "https:" && protocol !== "http:") throw new AnalysisError("invalid_config", "接口地址要以 https:// 开头。");
  if (!apiKey || !model) throw new AnalysisError("invalid_config", "先在解析库的接口设置里填好 Key 和模型。");
  return { baseUrl, apiKey, model, direction: text(value?.direction, 600) };
}

/** 提示词后面附上抖音页面读到的公开信息和创作方向，提示词要求“只能使用已提供的数据”。 */
export function analysisPrompt(video, direction = "") {
  const stats = video?.stats ?? {};
  const counts = [["点赞", stats.diggCount], ["评论", stats.commentCount], ["收藏", stats.collectCount], ["分享", stats.shareCount], ["播放", stats.playCount]]
    .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  const published = video?.publishedAt ? new Date(video.publishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
  return [
    ANALYSIS_PROMPT,
    "",
    "---",
    "下面是从抖音页面读到的这条视频的信息，可以当作“已提供的数据”：",
    `标题：${video?.title || "未知"}`,
    `作者：${video?.author || "未知"}`,
    `发布时间：${published}`,
    `时长：${video?.durationSeconds ? `${video.durationSeconds} 秒` : "未知"}`,
    `词条：${video?.tags?.length ? video.tags.map((tag) => `#${tag}`).join(" ") : "未知"}`,
    "封面：没有一起提供",
    `公开互动数据（读取时）：${counts.length ? counts.join("，") : "未知"}`,
    `我的创作方向：${direction || "没有填写，请按这条视频所在的领域给出改编建议"}`,
    "",
    // 不加这句，小模型常常挑着答：随机漏掉整个维度，括号里的小问也只答一两个
    "格式要求：第②部分的表格固定 10 行，按维度 1 到 10 的顺序各占一行，每行的“具体发现”要逐个回答该维度列出的所有小问（例如第 4 项要分别写段落顺序、信息递进、冲突、悬念、转折、论据、兑现承诺的时间点），看不出来的写“未知”或“视频里没有”，不能省略。②③两张表都用标准 Markdown 表格输出（半角竖线 | 分隔，带表头分隔行）。",
  ].join("\n");
}

function providerError(status, body) {
  let detail = String(body ?? "").trim();
  try {
    const parsed = JSON.parse(detail);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch { /* 不是 JSON 就用原文 */ }
  detail = String(detail).slice(0, 240);
  const reason = status === 401 || status === 403 ? "接口 Key 不对或没有权限"
    : status === 404 ? "接口地址或模型名不对，或者模型还没开通"
      : status === 413 ? "视频太大，接口收不下"
        : status === 429 ? "接口限流或额度用完了，稍后再试"
          : status ? `接口返回 ${status}` : "接口报错";
  return new AnalysisError("provider_error", detail ? `${reason}：${detail}` : `${reason}。`, 502);
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** 发给 OpenAI 兼容的 /chat/completions，流式读完（百炼 Qwen-Omni 只认流式，长回答也不会卡超时）。 */
export async function requestAnalysis({ config, video, videoBase64, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      // 方舟默认只答 4k，表格一多就截断
      max_tokens: MAX_ANSWER_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "video_url", video_url: { url: `data:video/mp4;base64,${videoBase64}` } },
          { type: "text", text: analysisPrompt(video, config.direction) },
        ],
      }],
    }),
  });
  if (!response.ok) throw providerError(response.status, await response.text().catch(() => ""));
  let text = "";
  let finish = null;
  if (!String(response.headers.get("content-type") ?? "").includes("event-stream")) {
    // 不支持流式的接口会直接回整段 JSON
    const choice = (await response.json().catch(() => null))?.choices?.[0];
    text = choice?.message?.content ?? "";
    finish = choice?.finish_reason ?? null;
  } else {
    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk?.error) throw providerError(0, JSON.stringify(chunk));
      const choice = chunk?.choices?.[0];
      text += choice?.delta?.content ?? "";
      finish = choice?.finish_reason ?? finish;
    }
  }
  if (!text.trim()) throw new AnalysisError("empty_answer", "接口没有返回内容，换个模型或稍后再试。", 502);
  return finish === "length" ? `${text}\n\n> 回答写到了长度上限，后面的内容没写完。` : text;
}

export class AnalysisLibrary {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.saving = Promise.resolve();
  }

  async load() {
    let items = [];
    try { items = JSON.parse(await readFile(this.file, "utf8")); } catch { /* 第一次用或文件坏了都从空库开始 */ }
    this.items = Array.isArray(items) ? items.filter((item) => typeof item?.id === "string") : [];
    for (const item of this.items) {
      if (item.status === "running") Object.assign(item, { status: "failed", stage: null, error: "上次解析到一半采集器关掉了，请重新解析。" });
    }
  }

  list() { return this.items; }

  put(entry) {
    this.items = [entry, ...this.items.filter((item) => item.id !== entry.id)].slice(0, MAX_ITEMS);
    return this.save();
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return before === this.items.length ? Promise.resolve(false) : this.save().then(() => true);
  }

  save() {
    const data = JSON.stringify(this.items);
    this.saving = this.saving.then(async () => {
      await writeFile(`${this.file}.tmp`, data, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    }).catch((error) => console.error("解析库保存失败:", error));
    return this.saving;
  }
}

/** 开始解析一条视频：同一链接再解析就覆盖原来那条（解析中的直接返回）。下载出错会同步抛出（比如采集器正忙）。 */
export function startAnalysis({ library, collector, url, config, fetchImpl = fetch, pollMs = 1_000 }) {
  const sourceUrl = normalizeDouyinVideoUrl(url);
  const existing = library.list().find((item) => item.sourceUrl === sourceUrl);
  if (existing?.status === "running") return existing;
  const job = collector.startVideoDownload(sourceUrl, { smallest: true });
  const now = new Date().toISOString();
  const entry = {
    id: existing?.id ?? randomUUID(),
    sourceUrl,
    status: "running",
    stage: "downloading",
    video: existing?.video ?? null,
    model: config.model,
    // 重新解析失败时留着上一次的结果
    markdown: existing?.markdown ?? null,
    error: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  void library.put(entry);
  void runAnalysis({ library, entry, collector, jobId: job.id, config, fetchImpl, pollMs });
  return entry;
}

async function runAnalysis({ library, entry, collector, jobId, config, fetchImpl, pollMs }) {
  const update = (patch) => {
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    return library.save();
  };
  try {
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let job = collector.getVideoDownloadJob(jobId);
    while (job?.status === "queued" || job?.status === "running") {
      if (Date.now() > deadline) throw new AnalysisError("download_timeout", "视频下载太久了，请稍后重试。");
      await delay(pollMs);
      job = collector.getVideoDownloadJob(jobId);
    }
    if (job?.status !== "complete") throw new AnalysisError("download_failed", job?.error ?? "视频没下载下来，请稍后重试。");
    const filePath = collector.getVideoDownloadFilePath(jobId);
    if (!filePath?.toLowerCase().endsWith(".mp4")) throw new AnalysisError("not_video", "图文作品暂时不能解析，只支持视频。");
    await update({ stage: "analyzing", video: job.video ?? entry.video });
    const videoBase64 = (await readFile(filePath)).toString("base64");
    const markdown = await requestAnalysis({ config, video: entry.video, videoBase64, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS), fetchImpl });
    await update({ status: "complete", stage: null, markdown, error: null });
  } catch (error) {
    const message = error instanceof AnalysisError ? error.message
      : error?.name === "TimeoutError" ? "接口太久没答完，请稍后重试。"
        : error instanceof TypeError ? "连不上接口地址，检查一下网络和地址。"
          : "解析失败，请稍后重试。";
    await update({ status: "failed", stage: null, error: message });
  }
}
