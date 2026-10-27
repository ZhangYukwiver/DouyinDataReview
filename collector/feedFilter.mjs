import { copyFile, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { normalizeAweme, normalizeRecord } from "./normalizer.mjs";

// 推荐流控制的词条、模式、处置记录和浏览器扩展的状态。不分账号：浏览器里登的号不一定是应用里正用的那个。
// 扩展的固定 ID 来自 extension/manifest.json 里的 key；Edge 上扩展页地址是 extension:// 开头，两种都认
export const FEED_FILTER_EXTENSION_ID = "phliimhdokpkdhmeofkpbcnkncknjkka";
export const FEED_FILTER_ORIGINS = [`chrome-extension://${FEED_FILTER_EXTENSION_ID}`, `extension://${FEED_FILTER_EXTENSION_ID}`];
export const FEED_FILTER_MODES = ["off", "observe", "hide", "dislike"];
const ACTIONS = new Set(["observed", "hidden", "disliked", "dislike_failed", "unreadable"]);
const MAX_RULES_CHARACTERS = 20_000;
const MAX_EVENTS = 500;
// 内容库「推荐流挡掉的」那一栏：每个作品留最近一次，一条约 1KB
const MAX_VIDEOS = 1000;
const VIDEO_ACTIONS = new Set(["observed", "hidden", "disliked", "dislike_failed"]);

const DEFAULT_RULES = ["# 一行一条。词条 / desc:文案词 / author:昵称或数字号 / tag:话题或分类 / /正则/i / 词条@权重", "# 示例，换成你自己的", "营销号", "带货"].join("\n");

const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

function sanitizeEvent(value) {
  if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) return null;
  const id = typeof value.id === "string" && /^\d{5,30}$/u.test(value.id) ? value.id : "";
  if (!id && value.action !== "unreadable") return null;
  const t = Number.isFinite(value.t) && value.t > 0 ? Math.round(value.t) : Date.now();
  return { t, id, desc: text(value.desc, 120), author: text(value.author, 40), matched: sanitizeMatched(value.matched), action: value.action };
}

const sanitizeMatched = (value) => (Array.isArray(value) ? value : []).filter((item) => typeof item === "string").slice(0, 5).map((item) => item.slice(0, 60));

// 和观看记录同一个格式（同一个校验），再带上命中的词条和处置结果
function sanitizeVideo(value) {
  const record = normalizeRecord(value);
  if (!record?.videoId || !record.id.startsWith("feed_filtered:") || !VIDEO_ACTIONS.has(value?.feedFilter?.action)) return null;
  return { ...record, feedFilter: { action: value.feedFilter.action, matched: sanitizeMatched(value.feedFilter.matched) } };
}

// 扩展送来的命中视频：用观看记录同一套转换（normalizeAweme），时间记成在推荐流里碰到它的那一刻
function videoFromEvent(event) {
  if (!event || typeof event !== "object" || !VIDEO_ACTIONS.has(event.action) || !event.aweme || typeof event.aweme !== "object"
    || String(event.aweme.aweme_id) !== event.id) return null;
  const record = normalizeAweme(event.aweme, "feed_filtered");
  if (!record) return null;
  const at = Number.isFinite(event.t) && event.t > 0 ? event.t : Date.now();
  return sanitizeVideo({ ...record, occurredAt: new Date(at).toISOString(), occurredAtSource: "platform_action", feedFilter: { action: event.action, matched: event.matched } });
}

// 磁盘上的文件和请求体都不可信，逐项过一遍
export function sanitizeFeedFilter(value) {
  const rules = typeof value?.rules === "string" ? value.rules.slice(0, MAX_RULES_CHARACTERS) : DEFAULT_RULES;
  const mode = FEED_FILTER_MODES.includes(value?.mode) ? value.mode : "observe";
  const events = (Array.isArray(value?.events) ? value.events : []).map(sanitizeEvent).filter(Boolean).slice(-MAX_EVENTS);
  const videos = (Array.isArray(value?.videos) ? value.videos : []).map(sanitizeVideo).filter(Boolean).slice(-MAX_VIDEOS);
  // 扩展最近一次来对接的时间（没装或已移除是 null）；remove = 用户点了移除、等扩展下次来时自己卸载
  const lastSeenAt = Number.isFinite(value?.lastSeenAt) ? value.lastSeenAt : null;
  const remove = value?.remove === true;
  return { rules, mode, events, videos, lastSeenAt, remove };
}

export class FeedFilterStore {
  constructor(directory) {
    this.filePath = path.join(directory, "feed-filter.json");
    this.cached = null;
    this.queue = Promise.resolve();
  }

  // 读改写排在一条队列上，扩展送记录和应用改词条同时来也不会互相盖掉
  update(change, persist = true) {
    const run = this.queue.then(async () => {
      this.cached ??= await this.load();
      const next = sanitizeFeedFilter(change(this.cached));
      if (persist) await this.save(next);
      this.cached = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  read() {
    return this.update((current) => current, false);
  }

  async load() {
    let content;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return sanitizeFeedFilter(null);
      throw error;
    }
    try {
      return sanitizeFeedFilter(JSON.parse(content));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 半截文件先留底再当空的用，免得下次存盘把它盖掉
      const broken = `${this.filePath}.broken-${Date.now()}`;
      await rename(this.filePath, broken).catch(() => copyFile(this.filePath, broken)).catch(() => { throw error; });
      return sanitizeFeedFilter(null);
    }
  }

  async save(value) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, this.filePath);
  }

  setSettings({ rules, mode }) {
    return this.update((current) => ({ ...current, ...(typeof rules === "string" ? { rules } : {}), ...(FEED_FILTER_MODES.includes(mode) ? { mode } : {}) }));
  }

  // 处置记录照旧只留文字；带着视频信息的另外存成记录，同一个作品只留最近一次
  addEvents(events) {
    const videos = events.map(videoFromEvent).filter(Boolean);
    const fresh = new Set(videos.map((video) => video.videoId));
    return this.update((current) => ({ ...current, events: [...current.events, ...events],
      videos: [...current.videos.filter((video) => !fresh.has(video.videoId)), ...videos] }));
  }

  // 扩展每分钟来对一次，记下时间，设置页据此说「已装好」
  touch() {
    return this.update((current) => ({ ...current, lastSeenAt: Date.now() }));
  }

  requestRemove(remove) {
    return this.update((current) => ({ ...current, remove }));
  }

  // 扩展收到移除、卸载自己之前来报一声
  removed() {
    return this.update((current) => ({ ...current, remove: false, lastSeenAt: null }));
  }

  // 清空处置记录时，内容库那一栏一起清：两边是同一批命中
  clearEvents() {
    return this.update((current) => ({ ...current, events: [], videos: [] }));
  }
}
