import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserConnectionError, discoverBrowser } from "./browserConnection.mjs";

// 只检查本机端口，不在检查时连接 CDP。端口文件的更新时间区分重启后复用相同端口的浏览器。
export async function discoverUsageBrowser(source) {
  const found = await discoverBrowser(source);
  if (!found.endpoint) return null;
  const marker = await stat(path.join(source.directory, "DevToolsActivePort")).catch(() => null);
  return marker ? `${found.endpoint}:${marker.mtimeMs}` : null;
}

export class UsageAutoConnect {
  constructor(directory, monitor, { discover = discoverUsageBrowser, intervalMs = 5_000 } = {}) {
    this.file = path.join(directory, "usage-browser-settings.json");
    this.monitor = monitor;
    this.discover = discover;
    this.intervalMs = intervalMs;
    this.settings = { enabled: false, browser: monitor.sources[0]?.id ?? "chrome" };
    this.revision = 0;
    this.attempted = null;
    this.pauseNext = false;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  valid(value) {
    return value && typeof value.enabled === "boolean" && this.monitor.sources.some(source => source.id === value.browser);
  }

  async initialize() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (this.valid(value)) this.settings = { enabled: value.enabled, browser: value.browser };
    } catch { /* 缺失或无效设置不自动请求授权；用户可在设置中重新保存。 */ }
    return this;
  }

  snapshot() { return { ...this.settings }; }

  start() {
    clearInterval(this.timer);
    if (this.closed || !this.settings.enabled) return;
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
      this.timer.unref?.();
    }
    void this.check();
  }

  configure(value) {
    if (!this.valid(value)) return Promise.reject(new BrowserConnectionError("invalid_request", "请选择浏览器，并设置是否自动请求连接。", 400));
    const next = { enabled: value.enabled, browser: value.browser };
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error("usage_closed");
      if (next.enabled === this.settings.enabled && next.browser === this.settings.browser) return this.snapshot();
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(`${this.file}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      ++this.revision;
      clearInterval(this.timer);
      // 改浏览器或关闭开关时，撤销本功能发起的连接；手动连接仍由使用记录面板控制。
      if (this.ownsConnection) await this.monitor.stop();
      this.ownsConnection = false;
      this.settings = next;
      this.attempted = null;
      this.pauseNext = false;
      this.start();
      return this.snapshot();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  // 用户手动连接/停止优先，不能被正在进行的后台检查覆盖。
  manualAction() {
    ++this.revision;
    this.pauseNext = true;
    this.ownsConnection = false;
  }

  check() {
    if (this.checking) return this.checking;
    const work = this.probe().catch(() => {}).finally(() => { this.checking = null; });
    this.checking = work;
    return work;
  }

  async probe() {
    if (this.closed || !this.settings.enabled) return;
    const revision = this.revision;
    const source = this.monitor.sources.find(source => source.id === this.settings.browser);
    const instance = await this.discover(source);
    if (this.closed || revision !== this.revision) return;
    if (!instance) {
      this.attempted = null;
      this.pauseNext = false;
      return;
    }
    if (this.pauseNext) { this.attempted = instance; this.pauseNext = false; }
    if (["connecting", "connected"].includes(this.monitor.snapshot().state)) {
      // 旧连接的 close 事件可能比新进程的端口文件晚到，不能提前消耗新进程的请求机会。
      this.attempted ??= instance;
      return;
    }
    // 拒绝、超时或断线后不重复弹窗；浏览器重启或重新开关设置才自动再试。
    if (this.attempted === instance) return;
    this.attempted = instance;
    this.ownsConnection = true;
    await this.monitor.start(source.id, { automatic: true });
  }

  async close() {
    this.closed = true;
    ++this.revision;
    clearInterval(this.timer);
    await this.queue;
  }
}
