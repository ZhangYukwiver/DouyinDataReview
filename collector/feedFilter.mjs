import { copyFile, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

// 推荐流控制的词条、模式、处置记录和浏览器扩展的状态。不分账号：浏览器里登的号不一定是应用里正用的那个。
// 扩展的固定 ID 来自 extension/manifest.json 里的 key；Edge 上扩展页地址是 extension:// 开头，两种都认
export const FEED_FILTER_EXTENSION_ID = "phliimhdokpkdhmeofkpbcnkncknjkka";
export const FEED_FILTER_ORIGINS = [`chrome-extension://${FEED_FILTER_EXTENSION_ID}`, `extension://${FEED_FILTER_EXTENSION_ID}`];
export const FEED_FILTER_MODES = ["off", "observe", "hide", "dislike"];
const ACTIONS = new Set(["observed", "hidden", "disliked", "dislike_failed", "unreadable"]);
const MAX_RULES_CHARACTERS = 20_000;
const MAX_EVENTS = 500;

const DEFAULT_RULES = ["# 一行一条。词条 / desc:文案词 / author:昵称或数字号 / tag:话题或分类 / /正则/i / 词条@权重", "# 示例，换成你自己的", "营销号", "带货"].join("\n");

const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

function sanitizeEvent(value) {
  if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) return null;
  const id = typeof value.id === "string" && /^\d{5,30}$/u.test(value.id) ? value.id : "";
  if (!id && value.action !== "unreadable") return null;
  const t = Number.isFinite(value.t) && value.t > 0 ? Math.round(value.t) : Date.now();
  const matched = (Array.isArray(value.matched) ? value.matched : []).filter((item) => typeof item === "string").slice(0, 5).map((item) => item.slice(0, 60));
  return { t, id, desc: text(value.desc, 120), author: text(value.author, 40), matched, action: value.action };
}

// 磁盘上的文件和请求体都不可信，逐项过一遍
export function sanitizeFeedFilter(value) {
  const rules = typeof value?.rules === "string" ? value.rules.slice(0, MAX_RULES_CHARACTERS) : DEFAULT_RULES;
  const mode = FEED_FILTER_MODES.includes(value?.mode) ? value.mode : "observe";
  const events = (Array.isArray(value?.events) ? value.events : []).map(sanitizeEvent).filter(Boolean).slice(-MAX_EVENTS);
  // 扩展最近一次来对接的时间（没装或已移除是 null）；remove = 用户点了移除、等扩展下次来时自己卸载
  const lastSeenAt = Number.isFinite(value?.lastSeenAt) ? value.lastSeenAt : null;
  const remove = value?.remove === true;
  return { rules, mode, events, lastSeenAt, remove };
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

  addEvents(events) {
    return this.update((current) => ({ ...current, events: [...current.events, ...events] }));
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

  clearEvents() {
    return this.update((current) => ({ ...current, events: [] }));
  }
}
