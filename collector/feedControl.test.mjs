import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { FeedControl, pageScript } from "./feedControl.mjs";

// 假的浏览器调试连接：按方法名回话，记下发过的每条命令
class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.scripts = 0;
    this.drain = {};
    setImmediate(() => this.emit("open"));
  }
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    const result = message.method === "Target.attachToTarget" ? { sessionId: `s-${message.params.targetId}` }
      : message.method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `script-${++this.scripts}` }
        : message.method === "Runtime.evaluate" && message.params.expression.includes("__dyfDrain")
          ? { result: { value: JSON.stringify(this.drain[message.sessionId]?.splice(0) ?? []) } } : {};
    setImmediate(() => this.emit("message", JSON.stringify({ id: message.id, result })));
  }
  close() { this.readyState = 3; this.emit("close"); }
  event(method, params) { this.emit("message", JSON.stringify({ method, params })); }
  calls(method) { return this.sent.filter((message) => message.method === method); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const controls = [];
afterEach(() => controls.splice(0).forEach((control) => control.dispose()));

function start(onEvents = () => {}) {
  const browser = new FakeBrowser();
  const control = new FeedControl({ sources: [{ id: "chrome", label: "Chrome" }], onEvents, createSocket: () => browser, openDebuggingPage: async () => {},
    discover: async () => ({ available: true, endpoint: "ws://127.0.0.1:9222/devtools/browser/x" }) });
  controls.push(control);
  return { browser, control };
}

describe("推荐流控制", () => {
  it("只附着抖音标签页，装上带词条的页面脚本；别的网站和后台线程不碰", async () => {
    const { browser, control } = start();
    control.update({ rules: "营销号", mode: "hide" });
    expect((await control.connect("chrome")).state).toBe("connected");
    expect(browser.calls("Target.setDiscoverTargets")).toHaveLength(1);

    browser.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", url: "https://www.douyin.com/?recommend=1" } });
    browser.event("Target.targetCreated", { targetInfo: { targetId: "b", type: "page", url: "https://example.com/" } });
    browser.event("Target.targetCreated", { targetInfo: { targetId: "c", type: "page", url: "https://www.douyin.com.evil.test/" } });
    browser.event("Target.targetCreated", { targetInfo: { targetId: "d", type: "service_worker", url: "https://www.douyin.com/sw.js" } });
    await settle();

    expect(browser.calls("Target.attachToTarget").map((message) => message.params.targetId)).toEqual(["a"]);
    const [script] = browser.calls("Page.addScriptToEvaluateOnNewDocument");
    expect(script.sessionId).toBe("s-a");
    expect(script.params.source).toContain("营销号");
    // 已经开着的这一页也立刻装上
    expect(browser.calls("Runtime.evaluate").some((message) => message.sessionId === "s-a" && message.params.expression.includes("dyf:settings"))).toBe(true);
    expect(control.status()).toMatchObject({ state: "connected", browser: "chrome", label: "Chrome", tabs: 1 });
  });

  it("定时取回命中记录；改词条换掉旧脚本；标签页离开抖音马上放手", async () => {
    const received = [];
    const { browser, control } = start((events) => received.push(...events));
    control.update({ rules: "营销号", mode: "hide" });
    await control.connect("chrome");
    browser.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", url: "https://www.douyin.com/" } });
    await settle();

    browser.drain["s-a"] = [{ t: 1, id: "7000000000000000001", action: "hidden" }];
    await control.tick();
    expect(received).toEqual([{ t: 1, id: "7000000000000000001", action: "hidden" }]);

    control.update({ rules: "带货", mode: "dislike" });
    await settle();
    expect(browser.calls("Page.removeScriptToEvaluateOnNewDocument")).toEqual([expect.objectContaining({ sessionId: "s-a", params: { identifier: "script-1" } })]);
    expect(browser.calls("Page.addScriptToEvaluateOnNewDocument").at(-1).params.source).toContain("带货");

    browser.event("Target.targetInfoChanged", { targetInfo: { targetId: "a", type: "page", url: "https://example.com/" } });
    await settle();
    expect(browser.calls("Target.detachFromTarget")).toEqual([expect.objectContaining({ params: { sessionId: "s-a" } })]);
    expect(control.status().tabs).toBe(0);
  });

  it("断开前让开着的抖音页停手；浏览器关了就等着重连，用户断开就不再连", async () => {
    const { browser, control } = start();
    control.update({ rules: "营销号", mode: "hide" });
    await control.connect("chrome");
    browser.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", url: "https://www.douyin.com/" } });
    await settle();

    browser.close();
    expect(control.status()).toMatchObject({ state: "waiting", browser: "chrome", tabs: 0 });

    const again = start();
    again.control.update({ rules: "营销号", mode: "hide" });
    await again.control.connect("chrome");
    again.browser.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", url: "https://www.douyin.com/" } });
    await settle();
    expect(again.control.disconnect()).toMatchObject({ state: "off", browser: null });
    await settle();
    expect(again.browser.calls("Runtime.evaluate").at(-1).params.expression).toContain('\\"mode\\":\\"off\\"');
    expect(again.browser.readyState).toBe(3);
  });

  it("没开调试时打开调试设置页、记着等它；没装这个浏览器就不等", async () => {
    let opened = 0;
    const waiting = new FeedControl({ sources: [{ id: "chrome", label: "Chrome" }], openDebuggingPage: async () => { opened += 1; },
      discover: async () => ({ available: true, endpoint: null }) });
    controls.push(waiting);
    await expect(waiting.connect("chrome")).rejects.toMatchObject({ code: "browser_debugging_required" });
    expect(opened).toBe(1);
    expect(waiting.status()).toMatchObject({ state: "waiting", browser: "chrome" });

    const missing = new FeedControl({ sources: [{ id: "edge", label: "Edge" }], discover: async () => ({ available: false, endpoint: null }) });
    controls.push(missing);
    await expect(missing.connect("edge")).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(missing.status()).toMatchObject({ state: "off", browser: null });
    await expect(missing.connect("firefox")).rejects.toMatchObject({ code: "browser_unsupported" });
  });

  it("词条里有引号、反斜杠、反引号也拼不坏注入的代码", () => {
    expect(() => new Function(pageScript({ rules: "a\"b\\c`${x}`</script> d", mode: "hide" }))).not.toThrow();
  });
});
