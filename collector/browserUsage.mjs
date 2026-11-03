import WebSocket from "ws";
import { BrowserConnectionError, discoverBrowser, openBrowserDebuggingPage } from "./browserConnection.mjs";

export function isDouyinPage(target) {
  if (target?.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return ["https:", "http:"].includes(url.protocol) && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"));
  } catch { return false; }
}

// 独立于登录连接：只订阅 Target 元信息，不 attach 页面、不执行脚本、不读取请求/Cookie/内容。
// URL 只在内存中判断域名，保存的只有浏览器来源及使用时段。
export async function connectBrowserUsage(source, { onChange, onDisconnect, signal, openSettingsIfNeeded = true,
  discover = discoverBrowser, openDebugging = openBrowserDebuggingPage,
  socketFactory = endpoint => new WebSocket(endpoint, { maxPayload: 1024 * 1024 }), timeoutMs = 60_000,
} = {}) {
  const found = await discover(source);
  if (signal?.aborted) throw new BrowserConnectionError("usage_cancelled", "已取消连接。");
  if (!found.endpoint) {
    if (!found.available) throw new BrowserConnectionError("browser_unavailable", `未找到 ${source.label}，请先安装并打开该浏览器。`);
    if (openSettingsIfNeeded) await openDebugging(source);
    throw new BrowserConnectionError("browser_debugging_required", `${openSettingsIfNeeded ? `已打开 ${source.label} 的调试设置页。` : ""}请先允许远程调试，再在浏览器中允许连接。`);
  }
  const socket = socketFactory(found.endpoint);
  const tabs = new Set(), pending = new Map();
  let nextId = 0, initializing = true, deliberatelyClosed = false, stopped = false;
  let rejectOpened;
  const error = () => new BrowserConnectionError("browser_connection_failed", "浏览器连接已断开或未获允许，请重新连接。");
  const disconnect = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", abort);
    rejectOpened?.(error());
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error()); }
    pending.clear();
    if (!deliberatelyClosed) onDisconnect?.();
  };
  const abort = () => { deliberatelyClosed = true; disconnect(); socket.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  const changed = (target, reason = "left_site") => {
    if (!target?.targetId) return;
    const previous = tabs.size;
    if (isDouyinPage(target)) tabs.add(target.targetId); else tabs.delete(target.targetId);
    if (!initializing && tabs.size !== previous) onChange?.({ count: tabs.size, reason, startKind: "opened" });
  };
  socket.on("message", bytes => {
    let message;
    try { message = JSON.parse(String(bytes)); } catch { return; }
    if (message.id) {
      const wait = pending.get(message.id);
      if (!wait) return;
      pending.delete(message.id); clearTimeout(wait.timer);
      if (message.error) wait.reject(error()); else wait.resolve(message.result ?? {});
    } else if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
      changed(message.params?.targetInfo);
    } else if (message.method === "Target.targetDestroyed") {
      if (tabs.delete(message.params?.targetId) && !initializing) onChange?.({ count: tabs.size, reason: "closed", startKind: "opened" });
    }
  });
  socket.on("close", disconnect);
  socket.on("error", () => { disconnect(); socket.close(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (stopped) return reject(error());
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(error()); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { pending.delete(id); clearTimeout(timer); reject(error()); }
  });
  try {
    await new Promise((resolve, reject) => {
      rejectOpened = reject;
      const timer = setTimeout(() => reject(error()), timeoutMs);
      socket.once("open", () => { clearTimeout(timer); rejectOpened = null; resolve(); });
      socket.once("close", () => clearTimeout(timer));
      socket.once("error", () => clearTimeout(timer));
      if (signal?.aborted) abort();
    });
    await send("Target.setDiscoverTargets", { discover: true });
    const result = await send("Target.getTargets");
    tabs.clear();
    for (const target of result.targetInfos ?? []) if (isDouyinPage(target)) tabs.add(target.targetId);
    if (stopped || signal?.aborted) throw error();
    initializing = false;
    onChange?.({ count: tabs.size, reason: "closed", startKind: "observed" });
    return { close: abort };
  } catch (reason) { abort(); throw reason; }
}

export class BrowserUsageMonitor {
  constructor(sessions, sources, { connector = connectBrowserUsage } = {}) {
    this.sessions = sessions;
    this.sources = sources.filter(source => !source.inApp && !source.desktop && ["chrome", "edge", "comet"].includes(source.id));
    this.connector = connector;
    this.generation = 0;
    this.state = { state: "idle", browser: null, label: null, tabs: 0, error: null };
  }

  snapshot() { return { ...this.state }; }

  async start(id, { automatic = false } = {}) {
    const source = this.sources.find(item => item.id === id);
    if (!source) throw new BrowserConnectionError("browser_unsupported", "请选择当前电脑支持的浏览器。", 400);
    if (this.state.state === "connecting") throw new BrowserConnectionError("usage_connecting", "浏览器正在连接，请等待或取消。");
    const stopping = this.stop();
    const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.state = { state: "connecting", browser: source.id, label: source.label, tabs: 0, error: null };
    try {
      await stopping;
      if (generation !== this.generation) return this.snapshot();
      const connection = await this.connector(source, { signal: controller.signal, openSettingsIfNeeded: !automatic,
        onChange: ({ count, reason, startKind }) => {
          if (generation !== this.generation) return;
          this.state.tabs = count;
          void this.sessions.setActive(source.id, count > 0, { reason, startKind }).catch(() => {});
        },
        onDisconnect: () => {
          if (generation !== this.generation) return;
          this.state = { ...this.state, state: "disconnected", tabs: 0, error: "浏览器连接已断开，记录截止到最后一次确认时间。重新连接后继续记录。" };
          void this.sessions.setActive(source.id, false, { reason: "disconnected" }).catch(() => {});
        },
      });
      if (generation !== this.generation) { connection.close(); return this.snapshot(); }
      this.connection = connection;
      this.state.state = "connected";
      return this.snapshot();
    } catch (error) {
      if (generation === this.generation) this.state = { ...this.state, state: "error", tabs: 0, error: error.message };
      throw error;
    }
  }

  async stop() {
    ++this.generation;
    const source = this.state.browser;
    this.controller?.abort(); this.controller = null;
    this.connection?.close(); this.connection = null;
    this.state = { state: "idle", browser: null, label: null, tabs: 0, error: null };
    if (source) await this.sessions.setActive(source, false, { reason: "stopped" });
    return this.snapshot();
  }
}
