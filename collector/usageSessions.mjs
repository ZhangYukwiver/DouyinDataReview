import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const USAGE_SOURCES = Object.freeze({ app: "软件窗口", chrome: "Chrome 网页", edge: "Edge 网页", comet: "Comet 网页" });
const END_REASONS = new Set(["closed", "hidden", "left_site", "suspended", "stopped", "disconnected", "interrupted"]);
const START_KINDS = new Set(["opened", "observed", "resumed"]);
const validTime = value => Number.isSafeInteger(value) && value >= 946684800000;

function validSession(row) {
  return row && typeof row.id === "string" && Object.hasOwn(USAGE_SOURCES, row.source)
    && validTime(row.startedAt) && validTime(row.lastSeenAt) && row.lastSeenAt >= row.startedAt
    && START_KINDS.has(row.startKind) && (row.endedAt === null
      ? row.endReason === null
      : validTime(row.endedAt) && row.endedAt >= row.startedAt && END_REASONS.has(row.endReason));
}

// 软件窗口、不同浏览器可能同时打开；合计取时间段的并集，不把重叠时间重复相加。
export function unionDuration(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let total = 0, from = 0, to = 0;
  for (const [start, end] of sorted) {
    if (start > to) { total += to - from; from = start; to = end; }
    else to = Math.max(to, end);
  }
  return total + to - from;
}

export class UsageSessions {
  constructor(directory, { now = Date.now, heartbeatMs = 30_000 } = {}) {
    this.file = path.join(directory, "usage-sessions.json");
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.rows = [];
    this.active = new Map();
    this.wanted = new Map();
    this.suspended = false;
    this.closed = false;
    this.error = null;
    this.storageBlocked = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.sessions) || !value.sessions.every(validSession)) throw new Error("invalid_usage_store");
      this.rows = value.sessions;
      let recovered = false;
      for (const row of this.rows) {
        if (row.endedAt !== null) continue;
        // 上一次没有正常退出，只能确认到最后一次心跳，不能一直算到本次启动。
        row.endedAt = row.lastSeenAt; row.endReason = "interrupted"; recovered = true;
      }
      if (recovered) await this.persist();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.storageBlocked = true;
        this.error = "使用记录文件无法读取，已保留原文件并暂停计时。";
      }
    }
    this.lastTick = this.now();
    if (this.heartbeatMs > 0) {
      this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.heartbeatMs);
      this.timer.unref?.();
    }
    return this;
  }

  run(work) {
    const task = this.queue.then(async () => {
      if (this.storageBlocked) return;
      try { await work(); this.error = null; }
      catch (error) { this.error = "使用记录暂时无法保存，请检查本机存储空间。"; throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async persist() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: this.rows })}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  begin(source, at, startKind) {
    if (this.active.has(source)) return;
    const row = { id: randomUUID(), source, startedAt: at, lastSeenAt: at, endedAt: null, endReason: null, startKind };
    this.rows.push(row); this.active.set(source, row);
  }

  finish(source, at, reason) {
    const row = this.active.get(source);
    if (!row) return;
    row.endedAt = Math.max(row.startedAt, reason === "disconnected" || reason === "interrupted" ? row.lastSeenAt : at);
    row.lastSeenAt = row.endedAt; row.endReason = reason;
    this.active.delete(source);
  }

  setActive(source, enabled, { reason = "closed", startKind = "opened" } = {}) {
    if (!Object.hasOwn(USAGE_SOURCES, source) || typeof enabled !== "boolean" || !END_REASONS.has(reason) || !START_KINDS.has(startKind))
      return Promise.reject(new Error("invalid_usage_state"));
    const at = this.now();
    return this.run(async () => {
      if (this.closed) return;
      if (enabled) this.wanted.set(source, startKind); else this.wanted.delete(source);
      const hadSession = this.active.has(source);
      if (enabled && !this.suspended) this.begin(source, at, startKind);
      else if (!enabled) this.finish(source, at, reason);
      if (hadSession !== this.active.has(source)) await this.persist();
    });
  }

  tick() {
    const at = this.now();
    return this.run(async () => {
      if (this.closed) return;
      const dirty = this.active.size > 0;
      // 也覆盖独立采集器睡眠/进程停顿，没有收到桌面电源事件的情况。
      if (at - this.lastTick > Math.max(90_000, this.heartbeatMs * 3) || at < this.lastTick) {
        for (const source of [...this.active.keys()]) this.finish(source, at, "interrupted");
        if (!this.suspended) for (const source of this.wanted.keys()) this.begin(source, at, "resumed");
      }
      this.lastTick = at;
      for (const row of this.active.values()) row.lastSeenAt = Math.max(row.startedAt, at);
      if (dirty || this.active.size) await this.persist();
    });
  }

  setSuspended(suspended) {
    const at = this.now();
    return this.run(async () => {
      if (this.closed || this.suspended === suspended) return;
      this.suspended = suspended; this.lastTick = at;
      if (suspended) for (const source of [...this.active.keys()]) this.finish(source, at, "suspended");
      else for (const source of this.wanted.keys()) this.begin(source, at, "resumed");
      if (this.rows.length) await this.persist();
    });
  }

  async snapshot({ offset = 0, limit = 50 } = {}) {
    await this.queue;
    const at = this.now();
    const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
    const end = row => row.endedAt ?? Math.max(row.startedAt, Math.min(at, row.lastSeenAt + 90_000));
    const today = this.rows.filter(row => end(row) > midnight.getTime());
    const intervals = rows => rows.map(row => [Math.max(row.startedAt, midnight.getTime()), end(row)]);
    const sorted = [...this.rows].reverse();
    return {
      sessions: sorted.slice(offset, offset + limit).map(row => ({ ...row, durationMs: Math.max(0, end(row) - row.startedAt) })),
      total: this.rows.length, offset, hasMore: offset + limit < this.rows.length,
      today: { durationMs: unionDuration(intervals(today)), count: today.length,
        bySource: Object.fromEntries(Object.keys(USAGE_SOURCES).map(source => [source, unionDuration(intervals(today.filter(row => row.source === source)))])) },
      activeSources: [...this.active.keys()], updatedAt: at, error: this.error,
    };
  }

  close() {
    clearInterval(this.timer);
    const at = this.now();
    return this.run(async () => {
      if (this.closed) return;
      this.closed = true;
      const dirty = this.active.size > 0;
      for (const source of [...this.active.keys()]) this.finish(source, at, "stopped");
      this.wanted.clear();
      if (dirty) await this.persist();
    });
  }
}
