import { readFileSync } from "node:fs";
import WebSocket from "ws";

import { BrowserConnectionError, browserDirectories, discoverBrowser, openBrowserDebuggingPage } from "./browserConnection.mjs";

// 推荐流控制：经远程调试连着用户自己的浏览器，只附着到 www.douyin.com 的标签页，往里装 feedFilterPage.js，
// 在页面读到推荐数据之前按词条改掉。别的网站的标签页一概不附着，标签页一离开抖音就断开它。
// 用一条原生调试连接而不是 Playwright：Playwright 连上会给所有标签页开 Runtime 这些调试域，页面察觉得到；
// 这里只用 Target、Page.addScriptToEvaluateOnNewDocument 和 Runtime.evaluate，处置记录靠定时去页面里取。
const SCRIPTS = ["./feedFilterRules.js", "./feedFilterPage.js"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
const DOUYIN = /^https:\/\/www\.douyin\.com(?:[/?#]|$)/u;
const TICK_MS = 1500;
const RETRY_MS = 20_000;

// 词条整个当成字符串字面量塞进去，内容里有引号、反斜杠也拼不坏代码
export function pageScript(settings) {
  return `${SCRIPTS[0]}\n;globalThis.__dyfBoot = ${JSON.stringify(JSON.stringify(settings))};\n${SCRIPTS[1]}`;
}

export class FeedControl {
  constructor({ onEvents = () => {}, sources = browserDirectories(), discover = discoverBrowser, openDebuggingPage = openBrowserDebuggingPage,
    createSocket = (url) => new WebSocket(url, { perMessageDeflate: false }) } = {}) {
    Object.assign(this, { onEvents, sources, discover, openDebuggingPage, createSocket });
    this.settings = null;
    this.socket = null;
    this.source = null;
    // 用户想连的浏览器：断开（浏览器关了、调试开关没开）时隔一会儿自己再连；用户点断开或在浏览器里拒绝就清掉
    this.wanted = null;
    this.state = "off";
    this.message = null;
    this.tabs = new Map();
    this.calls = new Map();
    this.nextId = 1;
    this.lastTry = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  status() {
    return { state: this.state, browser: this.wanted, label: this.source?.label ?? null, tabs: [...this.tabs.values()].filter((tab) => tab.sessionId).length, message: this.message };
  }

  async connect(id, { quiet = false } = {}) {
    const source = this.sources.find((item) => item.id === id);
    if (!source) throw new BrowserConnectionError("browser_unsupported", "请选择 Chrome、Edge 或 Comet。", 400);
    this.close();
    Object.assign(this, { wanted: id, source, lastTry: Date.now() });
    const found = await this.discover(source);
    if (this.wanted !== id || this.socket) return this.status();
    if (!found.available) {
      // 没装这个浏览器：不用一直等着连
      Object.assign(this, { wanted: null, state: "off", message: null });
      throw new BrowserConnectionError("browser_unavailable", `没找到 ${source.label}，请先安装并打开它。`);
    }
    if (!found.endpoint) {
      this.state = "waiting";
      this.message = `${source.label} 没开或者没打开远程调试，打开后会自动连上。`;
      if (quiet) return this.status();
      await this.openDebuggingPage(source);
      throw new BrowserConnectionError("browser_debugging_required", `已经打开 ${source.label} 的调试设置页，勾选允许远程调试就会自动连上。`);
    }
    this.state = "connecting";
    this.message = `请在 ${source.label} 弹出的确认框里点允许。`;
    const socket = this.createSocket(found.endpoint);
    this.socket = socket;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 60_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
        socket.once("close", () => { clearTimeout(timer); reject(new Error("closed")); });
      });
    } catch {
      socket.terminate?.();
      if (this.socket === socket) Object.assign(this, { socket: null, wanted: null, state: "off", message: null });
      throw new BrowserConnectionError("browser_connection_failed", `${source.label} 没有允许连接，或者已经关了。`);
    }
    socket.on("message", (data) => this.receive(String(data)));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      for (const call of this.calls.values()) call.reject(new Error("closed"));
      this.calls.clear();
      this.tabs.clear();
      this.socket = null;
      this.state = this.wanted ? "waiting" : "off";
      this.message = this.wanted ? `${source.label} 关了或者断开了，重新打开后会自动连上。` : null;
    });
    Object.assign(this, { state: "connected", message: null });
    // 打开后浏览器会把已有的标签页也逐个报一遍（targetCreated）
    await this.send("Target.setDiscoverTargets", { discover: true });
    return this.status();
  }

  // 断开前先让开着的抖音页停手：不然页面里装好的那份会接着按旧词条拦，只是没人来取记录了
  disconnect() {
    this.wanted = null;
    const off = JSON.stringify(JSON.stringify({ mode: "off", rules: "" }));
    const tabs = [...this.tabs.values()].filter((tab) => tab.sessionId);
    Promise.allSettled(tabs.map((tab) => this.send("Runtime.evaluate",
      { expression: `document.dispatchEvent(new CustomEvent("dyf:settings", { detail: ${off} }))` }, tab.sessionId)))
      .finally(() => this.close());
    if (!tabs.length) this.close();
    return { ...this.status(), state: "off", tabs: 0, message: null };
  }

  close() {
    const socket = this.socket;
    Object.assign(this, { socket: null, state: this.wanted ? this.state : "off", message: this.wanted ? this.message : null });
    this.tabs.clear();
    socket?.close();
  }

  // 应用退出时调：停掉定时器，断开浏览器
  dispose() {
    clearInterval(this.timer);
    this.wanted = null;
    this.close();
  }

  update(settings) {
    this.settings = { rules: settings.rules, mode: settings.mode };
    for (const tab of this.tabs.values()) if (tab.sessionId) this.install(tab).catch(() => {});
  }

  send(method, params = {}, sessionId) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error("timeout")); }, 10_000);
      this.calls.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  receive(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id) {
      const call = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") this.track(message.params?.targetInfo);
    else if (message.method === "Target.targetDestroyed") this.tabs.delete(message.params?.targetId);
    else if (message.method === "Target.detachedFromTarget") {
      for (const [id, tab] of this.tabs) if (tab.sessionId === message.params?.sessionId) this.tabs.delete(id);
    }
  }

  track(info) {
    if (info?.type !== "page") return;
    const douyin = DOUYIN.test(info.url || "");
    const tab = this.tabs.get(info.targetId);
    if (douyin && !tab) this.attach(info.targetId);
    else if (!douyin && tab) {
      this.tabs.delete(info.targetId);
      if (tab.sessionId) this.send("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
    }
  }

  async attach(targetId) {
    const tab = { sessionId: null, scriptId: null };
    this.tabs.set(targetId, tab);
    try {
      const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
      // 附着的这一会儿标签页已经离开抖音了：马上放手
      if (this.tabs.get(targetId) !== tab) { await this.send("Target.detachFromTarget", { sessionId }); return; }
      tab.sessionId = sessionId;
      // 不开 Page 域的话，Chrome 有时在下一次刷新时不执行注册的脚本；Page.enable 只开页面事件，网页察觉不到
      await this.send("Page.enable", {}, sessionId);
      await this.install(tab);
    } catch {
      if (this.tabs.get(targetId) === tab) this.tabs.delete(targetId);
    }
  }

  // 以后每次打开、刷新都先于网页脚本装上；已经打开的这一页也立刻装上（装过的只换词条）
  async install(tab) {
    if (!this.settings) return;
    const source = pageScript(this.settings);
    const { identifier } = await this.send("Page.addScriptToEvaluateOnNewDocument", { source }, tab.sessionId);
    if (tab.scriptId) await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.scriptId }, tab.sessionId).catch(() => {});
    tab.scriptId = identifier;
    const detail = JSON.stringify(JSON.stringify(this.settings));
    await this.send("Runtime.evaluate", { expression: `${source}\n;document.dispatchEvent(new CustomEvent("dyf:settings", { detail: ${detail} }))` }, tab.sessionId);
  }

  async tick() {
    if (!this.socket) {
      if (this.wanted && this.state !== "connecting" && Date.now() - this.lastTry >= RETRY_MS) this.connect(this.wanted, { quiet: true }).catch(() => {});
      return;
    }
    if (this.draining) return;
    this.draining = true;
    try {
      for (const tab of [...this.tabs.values()]) {
        if (!tab.sessionId) continue;
        const result = await this.send("Runtime.evaluate", { expression: "typeof window.__dyfDrain === \"function\" ? window.__dyfDrain() : \"[]\"", returnByValue: true }, tab.sessionId).catch(() => null);
        let events;
        try { events = JSON.parse(result?.result?.value ?? "[]"); } catch { continue; }
        if (Array.isArray(events) && events.length) this.onEvents(events);
      }
    } finally {
      this.draining = false;
    }
  }
}
