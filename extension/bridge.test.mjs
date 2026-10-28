import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("./bridge.js", import.meta.url), "utf8");
const version = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")).version;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup() {
  const document = new EventTarget();
  document.addEventListener("dyf:probe", () => document.dispatchEvent(new CustomEvent("dyf:diagnostics", { detail: "{}" })));
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 0;
  const runtime = { getManifest: () => ({ version }),
    sendMessage: vi.fn(async message => ["cached", "settings"].includes(message.type) ? { mode: "observe", rules: "王者荣耀" } : null),
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
  };
  const timer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  const clear = id => timers.delete(id);
  const context = vm.createContext({ document, CustomEvent, chrome: { runtime }, setInterval: timer, setTimeout: timer, clearInterval: clear, clearTimeout: clear });
  return { document, runtime, timers, listeners, context, async inject() { vm.runInContext(script, context); await settle(); } };
}

describe("推荐流中转无需刷新重连", () => {
  it("重复注入复用监听和计时器，命中只转发一次", async () => {
    const { inject, document, runtime, timers, listeners } = setup();
    await inject();
    await inject();
    expect(timers.size).toBe(2);
    expect(listeners.size).toBe(1);
    runtime.sendMessage.mockClear();
    document.dispatchEvent(new CustomEvent("dyf:events", { detail: '[{"id":"7000000000000000001"}]' }));
    await settle();
    expect(runtime.sendMessage.mock.calls.filter(([message]) => message.type === "events")).toHaveLength(1);
  });

  it("后台可以直接检测中转版本及页面连接", async () => {
    const { inject, listeners } = setup();
    await inject();
    let result;
    [...listeners][0]({ type: "dyf:ping" }, {}, value => { result = value; });
    expect(result).toEqual({ version, ready: true });
  });

  it("扩展上下文失效后清掉旧监听和计时器，再注入能重新连接", async () => {
    const { inject, document, runtime, timers, listeners, context } = setup();
    await inject();
    const old = context.__dyfBridge;
    runtime.sendMessage.mockRejectedValue(new Error("Extension context invalidated."));
    document.dispatchEvent(new CustomEvent("dyf:events", { detail: "[]" }));
    await settle();
    expect(old.active).toBe(false);
    expect(timers.size).toBe(0);
    expect(listeners.size).toBe(0);
    runtime.sendMessage.mockClear();
    document.dispatchEvent(new CustomEvent("dyf:events", { detail: "[]" }));
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    runtime.sendMessage.mockResolvedValue({ mode: "observe", rules: "王者荣耀" });
    await inject();
    expect(context.__dyfBridge.active).toBe(true);
    expect(context.__dyfBridge).not.toBe(old);
    expect(timers.size).toBe(2);
    expect(listeners.size).toBe(1);
  });
});
