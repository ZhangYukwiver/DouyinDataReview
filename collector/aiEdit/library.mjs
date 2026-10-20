import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeDouyinVideoUrl } from "../videoDownloader.mjs";

// AI 剪辑的素材库：放在采集器根数据目录的 ai-edit/media/ 下，不分抖音账号。
// 文件名固定成 <id><后缀>，工程里存的是它的绝对路径；页面用 /v1/ai-edit/media/:id/file?key= 取文件。

export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
const MAX_ITEMS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DURATION_US = 86_400_000_000;
const MEDIA_ID = /^[0-9a-f]{32}$/u;

const CONTENT_TYPES = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
};

/** AI 剪辑自己的错误：snake_case 码 + 给用户看的中文，路由层原样回给页面。 */
export class AiEditError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AiEditError";
    this.code = code;
    this.status = status;
  }
}

export const isMediaId = (value) => typeof value === "string" && MEDIA_ID.test(value);

export function mediaContentType(fileName) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

function cleanName(value, max = 200) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim() : "";
  return text.slice(0, max);
}

function optionalText(value, max) {
  const text = cleanName(value, max);
  return text || undefined;
}

export class MediaLibrary {
  /**
   * probe(absPath, { roots }) 和 kindOf(fileName) 由媒体探测模块提供（测试里可以换成桩）；
   * getCollector() 返回当前采集器，正在切换账号时返回 null。
   */
  constructor({ directory, probe, kindOf, getCollector = () => null, busyReason = () => null, pollMs = 1_000, maxUploadBytes = MAX_UPLOAD_BYTES, now = () => new Date() }) {
    this.directory = directory;
    this.probe = probe;
    this.kindOf = kindOf;
    this.getCollector = getCollector;
    this.busyReason = busyReason;
    this.pollMs = pollMs;
    this.maxUploadBytes = maxUploadBytes;
    this.now = now;
    this.items = [];
    this.key = randomBytes(24).toString("base64url");
    this.saving = Promise.resolve();
    this.closed = false;
    this.listeners = new Set();
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // 工程里存的是规范化后的真实路径（macOS 临时目录会多一层 /private），这里用同一套
    this.root = await realpath(this.directory);
    let items = [];
    let indexRead = false;
    try {
      items = JSON.parse(await readFile(path.join(this.root, "index.json"), "utf8"));
      indexRead = Array.isArray(items);
    } catch { /* 第一次用或文件坏了都从空库开始 */ }
    this.items = Array.isArray(items) ? items.filter((item) => isMediaId(item?.id) && typeof item.file === "string") : [];
    await this.removeLeftovers({ orphans: indexRead });
    let changed = false;
    for (const item of this.items) {
      if (item.status !== "importing") continue;
      Object.assign(item, { status: "failed", error: "上次导入到一半采集器关掉了，请重新添加。" });
      changed = true;
    }
    if (changed) await this.save();
  }

  /**
   * 清掉上次没收尾的文件：上传或导入到一半被强退留下的 <id>.<后缀>.part，和索引里没有的 <id>.<后缀>
   * （文件已落盘、索引还没写就退出了）。索引没读出来时不认孤儿文件，免得把整个素材库当孤儿删掉。
   */
  async removeLeftovers({ orphans }) {
    let names = [];
    try { names = await readdir(this.root); } catch { return; }
    const known = new Set(this.items.map((item) => item.file));
    for (const name of names) {
      const match = /^[0-9a-f]{32}\.[a-z0-9]{1,10}(\.part)?$/u.exec(name);
      if (!match || (!match[1] && (!orphans || known.has(name)))) continue;
      await rm(path.join(this.root, name), { force: true }).catch(() => undefined);
    }
  }

  /** 素材变了（导入完成、失败、删除）时通知会话，让页面的长轮询醒过来。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* 监听出错不影响素材库 */ }
    }
  }

  list() { return this.items.map(publicItem); }

  get(id) { return this.items.find((item) => item.id === id) ?? null; }

  filePath(item) { return path.join(this.root, item.file); }

  /** 工程片段里的绝对路径 → 素材 id（不是素材库里的文件就是 null）。 */
  idForPath(filePath) {
    if (typeof filePath !== "string" || path.dirname(filePath) !== this.root) return null;
    const id = path.basename(filePath, path.extname(filePath));
    return this.get(id) ? id : null;
  }

  /** 给模型用：只认就绪的素材，返回绝对路径。 */
  readyPath(id) {
    const item = isMediaId(id) ? this.get(id) : null;
    if (!item) throw new AiEditError("media_not_found", `素材库里没有 ${String(id).slice(0, 40)} 这个素材，先用 list_media 看看有哪些。`, 404);
    if (item.status === "importing") throw new AiEditError("media_not_ready", "这个素材还在导入，等它就绪再用。", 409);
    if (item.status !== "ready") throw new AiEditError("media_failed", `这个素材没导入成功：${item.error ?? "原因不明"}`, 409);
    return this.filePath(item);
  }

  checkKey(key) {
    const expected = Buffer.from(this.key);
    const given = Buffer.from(String(key ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async put(item) {
    // 不再按条数挤掉旧素材：挤掉的文件既删不掉也看不到，正被工程用着时预览也会坏。满了在新增前就拒绝（assertRoom）。
    this.items = [item, ...this.items.filter((entry) => entry.id !== item.id)];
    await this.save();
    this.notify();
    return item;
  }

  assertRoom() {
    if (this.items.length >= MAX_ITEMS) {
      throw new AiEditError("library_full", `素材库已经有 ${MAX_ITEMS} 个素材了，先移除一些不用的再添加。`, 409);
    }
  }

  /**
   * Windows 的剪映草稿直接引用素材库里的文件（Mac 会拷进草稿自己的目录）。记下每份草稿用到哪些素材：
   * 存在素材库索引里，不随会话删除；同一份草稿再次导入时按这次用到的素材重记。
   */
  async recordDraft({ draftId, draftName, path: draftPath }, filePaths) {
    if (typeof draftId !== "string" || typeof draftPath !== "string") return;
    const used = new Set(filePaths.map((filePath) => this.idForPath(filePath)).filter(Boolean));
    let changed = false;
    for (const item of this.items) {
      const current = Array.isArray(item.drafts) ? item.drafts : [];
      const kept = current.filter((ref) => ref?.id !== draftId);
      const next = used.has(item.id) ? [...kept, { id: draftId, name: String(draftName ?? ""), path: draftPath }] : kept;
      if (JSON.stringify(next) === JSON.stringify(current)) continue;
      if (next.length) item.drafts = next;
      else delete item.drafts;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** 还直接用着这个素材文件的剪映草稿（草稿目录已经不在的不算）。 */
  async draftUsing(item) {
    for (const ref of Array.isArray(item.drafts) ? item.drafts : []) {
      if (typeof ref?.path !== "string") continue;
      if (await stat(ref.path).then((info) => info.isDirectory(), () => false)) return ref;
    }
    return null;
  }

  save() {
    const data = JSON.stringify(this.items);
    const file = path.join(this.root, "index.json");
    this.saving = this.saving.then(async () => {
      await writeFile(`${file}.tmp`, data, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }).catch((error) => console.error("AI 剪辑素材库保存失败:", error));
    return this.saving;
  }

  newItem(fields) {
    return {
      id: randomBytes(16).toString("hex"),
      name: "",
      kind: "video",
      status: "importing",
      error: null,
      durationUs: null,
      width: null,
      height: null,
      hasAudio: false,
      size: null,
      createdAt: this.now().toISOString(),
      file: "",
      ...fields,
    };
  }

  async describe(item) {
    const target = this.filePath(item);
    let info;
    try {
      info = await this.probe(target, { roots: [this.root] });
    } catch {
      throw new AiEditError("media_unreadable", "读不出这个文件的时长和画面尺寸，可能文件坏了或格式不受支持。", 422);
    }
    const { size } = await stat(target);
    // 给模型和页面看转正后的宽高：手机竖拍常是编码横屏 + 转 90 度，按编码宽高会被当成横屏素材
    const turned = info.rotation === 90 || info.rotation === 270;
    return {
      kind: info.kind,
      durationUs: info.kind === "image" || info.duration_us >= IMAGE_DURATION_US ? null : info.duration_us,
      width: (turned ? info.height : info.width) ?? null,
      height: (turned ? info.width : info.height) ?? null,
      hasAudio: Boolean(info.audio),
      size,
    };
  }

  /** 页面上传的本机文件：请求体就是文件字节，边收边写盘，超过上限立刻停。 */
  async upload(stream, rawName, { contentLength } = {}) {
    const name = cleanName(path.basename(String(rawName ?? "").replace(/\\/gu, "/")));
    const extension = path.extname(name).toLowerCase();
    try { this.kindOf(`media${extension}`); }
    catch { throw new AiEditError("media_type_unsupported", "这种文件格式不能当素材，支持常见的视频、图片和音频。", 422); }
    if (Number(contentLength) > this.maxUploadBytes) throw new AiEditError("media_too_large", "文件超过 4GB，放不进素材库。", 413);
    this.assertRoom();
    const item = this.newItem({ name: name || `素材${extension}`, kind: this.kindOf(`media${extension}`), file: "", source: { type: "local" } });
    item.file = `${item.id}${extension}`;
    const target = this.filePath(item);
    const partial = `${target}.part`;
    let received = 0;
    const limit = this.maxUploadBytes;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > limit) callback(new AiEditError("media_too_large", "文件超过 4GB，放不进素材库。", 413));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
      if (received === 0) throw new AiEditError("media_empty", "文件是空的。", 422);
      await rename(partial, target);
      Object.assign(item, await this.describe(item), { status: "ready" });
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      if (error instanceof AiEditError) throw error;
      throw new AiEditError("upload_failed", "文件没传完，请重试。", 400);
    }
    await this.put(item);
    return publicItem(item);
  }

  /** 从内容库导入一条抖音视频：采集器下载完后复制进素材库。同一条链接导入过就直接用那条。 */
  async importDouyin(input) {
    let url;
    try {
      url = normalizeDouyinVideoUrl(input?.url);
    } catch (error) {
      // 换成自己的错误：模型调工具时才能拿到原因自己改，而不是笼统的“工具出错了”
      throw new AiEditError(error?.code ?? "invalid_url", error?.message || "请输入有效的抖音视频链接。", 400);
    }
    if (input?.mediaType === "image") throw new AiEditError("not_video", "图文作品暂不能当素材。", 422);
    const existing = this.items.find((item) => item.source?.type === "douyin" && item.source.url === url);
    if (existing && existing.status !== "failed") return publicItem(existing);
    if (!existing) this.assertRoom();
    const busy = this.busyReason();
    const collector = this.getCollector();
    if (busy || !collector) throw new AiEditError("collector_busy", busy ?? "正在切换账号，请稍等。", 409);
    let job;
    try {
      job = collector.startVideoDownload(url);
    } catch (error) {
      throw new AiEditError(error?.code ?? "download_start_failed", error?.message || "视频没开始下载，请稍后重试。", error?.status ?? 409);
    }
    const title = optionalText(input?.title, 200);
    const item = existing ?? this.newItem({});
    Object.assign(item, {
      name: title ?? (item.name || "抖音视频"),
      kind: "video",
      status: "importing",
      error: null,
      file: `${item.id}.mp4`,
      source: {
        type: "douyin",
        url,
        videoId: optionalText(input?.videoId, 64),
        title,
        author: optionalText(input?.author, 120),
        cover: optionalText(input?.cover, 2_048),
      },
    });
    if (Number.isFinite(input?.durationSeconds) && input.durationSeconds > 0) item.durationUs = Math.round(input.durationSeconds * 1e6);
    await this.put(item);
    void this.finishDouyin(item, collector, job.id);
    return publicItem(item);
  }

  async finishDouyin(item, collector, jobId) {
    const target = this.filePath(item);
    try {
      const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
      let job = collector.getVideoDownloadJob(jobId);
      while (job?.status === "queued" || job?.status === "running") {
        if (this.closed) return;
        if (Date.now() > deadline) throw new AiEditError("download_timeout", "视频下载太久了，请稍后重试。");
        await delay(this.pollMs);
        job = collector.getVideoDownloadJob(jobId);
      }
      if (this.closed) return;
      if (job?.status !== "complete") throw new AiEditError("download_failed", job?.error || "视频没下载下来，请稍后重试。");
      const source = collector.getVideoDownloadFilePath(jobId);
      if (!source) throw new AiEditError("download_failed", "下载的文件找不到了，请重新添加。");
      if (!source.toLowerCase().endsWith(".mp4")) throw new AiEditError("not_video", "图文作品暂不能当素材。", 422);
      if (!this.get(item.id)) return;
      // 下载任务半小时后会被清理掉，先复制一份；APFS 上是克隆，不占额外空间
      await copyFile(source, `${target}.part`, constants.COPYFILE_FICLONE);
      await rename(`${target}.part`, target);
      const described = await this.describe(item);
      const video = job.video ?? {};
      if (!this.get(item.id)) { await rm(target, { force: true }); return; }
      Object.assign(item, described, { status: "ready", error: null });
      const title = optionalText(video.title, 200);
      if (title && !item.source.title) Object.assign(item, { name: title, source: { ...item.source, title } });
      for (const [key, value] of [["author", optionalText(video.author, 120)], ["videoId", optionalText(video.videoId, 64)], ["cover", optionalText(video.cover, 2_048)]]) {
        if (value && !item.source[key]) item.source = { ...item.source, [key]: value };
      }
    } catch (error) {
      await rm(`${target}.part`, { force: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      Object.assign(item, { status: "failed", error: error instanceof AiEditError ? error.message : "没导入进素材库，请稍后重试。" });
    }
    if (this.get(item.id)) {
      await this.save();
      this.notify();
    }
  }

  /** 等素材导入结束（就绪或失败），给模型的 import_douyin_video 用。 */
  async waitFor(id, { timeoutMs = 3 * 60_000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const item = this.get(id);
      if (!item || item.status !== "importing") return item ? publicItem(item) : null;
      if (Date.now() > deadline) throw new AiEditError("import_timeout", "视频还在下载，过一会儿再用 list_media 看看。", 504);
      signal?.throwIfAborted();
      await delay(Math.min(this.pollMs, 500), undefined, { signal });
    }
  }

  async remove(id) {
    const item = this.get(id);
    if (!item) return false;
    this.items = this.items.filter((entry) => entry.id !== id);
    await this.save();
    await rm(this.filePath(item), { force: true }).catch(() => undefined);
    // 还在导入的素材可能有没写完的 .part
    await rm(`${this.filePath(item)}.part`, { force: true }).catch(() => undefined);
    this.notify();
    return true;
  }

  /** 按 Range 回文件：没有 Range 回 200 全量，有就回 206，越界 416。 */
  async send(request, response, item) {
    const target = this.filePath(item);
    let size;
    try { size = (await stat(target)).size; } catch {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "media_not_found", message: "素材文件找不到了。" }));
      return;
    }
    const headers = { "Content-Type": mediaContentType(item.file), "Accept-Ranges": "bytes" };
    const match = /^bytes=(\d*)-(\d*)$/u.exec(String(request.headers.range ?? "").trim());
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (match && (match[1] || match[2])) {
      partial = true;
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(match[2]));
        if (Number(match[2]) === 0) start = size;
      }
      if (start >= size || start > end) {
        response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
        response.end();
        return;
      }
    }
    response.writeHead(partial ? 206 : 200, {
      ...headers,
      "Content-Length": size === 0 ? 0 : end - start + 1,
      ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (size === 0) { response.end(); return; }
    await pipeline(createReadStream(target, { start, end }), response).catch(() => response.destroy());
  }

  close() { this.closed = true; }
}

export function publicItem(item) {
  const { file: _file, drafts: _drafts, ...rest } = item;
  return { ...rest, source: { ...(item.source ?? { type: "local" }) } };
}
