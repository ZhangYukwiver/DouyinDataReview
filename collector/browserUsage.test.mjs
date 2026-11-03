import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserUsageMonitor, connectBrowserUsage, isDouyinPage } from "./browserUsage.mjs";

class Socket extends EventEmitter {
  constructor(targets = []) { super(); this.targets = targets; this.commands = []; queueMicrotask(() => this.emit("open")); }
  send(text) {
    const command = JSON.parse(text); this.commands.push(command);
    queueMicrotask(() => this.emit("message", JSON.stringify({ id: command.id, result: command.method === "Target.getTargets" ? { targetInfos: this.targets } : {} })));
  }
  target(method, params) { this.emit("message", JSON.stringify({ method: `Target.${method}`, params })); }
  close() { this.emit("close"); }
}
const source = { id: "chrome", label: "Chrome", directory: "/unused" };
const page = (targetId, url = "https://www.douyin.com/") => ({ targetId, type: "page", url });
const discover = async () => ({ available: true, endpoint: "ws://127.0.0.1:9222/devtools/browser/test" });

describe("browser usage metadata observer", () => {
  it("counts existing and new Douyin tabs without reading content or closing the browser", async () => {
    const changes = [], disconnected = vi.fn(); let socket;
    const connection = await connectBrowserUsage(source, { discover, onChange: state => changes.push(state), onDisconnect: disconnected,
      socketFactory: () => (socket = new Socket([page("a"), page("foreign", "https://example.com/")])) });
    expect(changes).toEqual([{ count: 1, reason: "closed", startKind: "observed" }]);
    socket.target("targetCreated", { targetInfo: page("b", "https://www.douyin.com/video/123?secret=never-store") });
    socket.target("targetInfoChanged", { targetInfo: page("a", "https://www.douyin.com/search/a") });
    socket.target("targetDestroyed", { targetId: "a" });
    socket.target("targetInfoChanged", { targetInfo: page("b", "https://example.com/") });
    expect(changes.map(value => value.count)).toEqual([1, 2, 1, 0]);
    expect(changes.at(-1).reason).toBe("left_site");
    expect(JSON.stringify(changes)).not.toContain("secret");
    connection.close();
    expect(disconnected).not.toHaveBeenCalled();
    expect(socket.commands.map(value => value.method)).toEqual(["Target.setDiscoverTargets", "Target.getTargets"]);
  });

  it("ignores workers and deceptive hostnames and reports unexpected disconnection", async () => {
    expect(isDouyinPage(page("a", "https://douyin.com.evil.test"))).toBe(false);
    expect(isDouyinPage({ ...page("a"), type: "service_worker" })).toBe(false);
    expect(isDouyinPage(page("a", "https://live.douyin.com/123"))).toBe(true);
    let socket; const lost = vi.fn();
    await connectBrowserUsage(source, { discover, onDisconnect: lost, socketFactory: () => (socket = new Socket()) });
    socket.close(); socket.close(); expect(lost).toHaveBeenCalledOnce();
  });

  it("opens the existing opt-in setting only when explicitly starting an unavailable connection", async () => {
    const openDebugging = vi.fn(); const socketFactory = vi.fn();
    await expect(connectBrowserUsage(source, { discover: async () => ({ available: true }), openDebugging, socketFactory })).rejects.toMatchObject({ code: "browser_debugging_required" });
    expect(openDebugging).toHaveBeenCalledWith(source); expect(socketFactory).not.toHaveBeenCalled();
  });

  it("cancels a pending handshake without reporting a disconnect or leaving a live observer", async () => {
    const controller = new AbortController(), lost = vi.fn();
    const socket = new EventEmitter(); socket.close = vi.fn(() => socket.emit("close")); socket.send = vi.fn();
    const connecting = connectBrowserUsage(source, { discover, signal: controller.signal, onDisconnect: lost, socketFactory: () => socket });
    await Promise.resolve(); controller.abort();
    await expect(connecting).rejects.toBeInstanceOf(Error);
    expect(socket.close).toHaveBeenCalled(); expect(lost).not.toHaveBeenCalled();
  });

  it("never launches settings during an automatic retry if the browser closes before connecting", async () => {
    const openDebugging = vi.fn();
    await expect(connectBrowserUsage(source, { discover: async () => ({ available: true }), openDebugging,
      openSettingsIfNeeded: false })).rejects.toMatchObject({ code: "browser_debugging_required" });
    expect(openDebugging).not.toHaveBeenCalled();
  });

  it("does not start a second connection while the first is waiting for approval", async () => {
    let finish;
    const monitor = new BrowserUsageMonitor({ setActive: vi.fn(async () => {}) }, [source], {
      connector: () => new Promise(resolve => { finish = resolve; }),
    });
    const first = monitor.start("chrome");
    await expect(monitor.start("chrome")).rejects.toMatchObject({ code: "usage_connecting" });
    finish({ close() {} }); await first; await monitor.stop();
  });

  it("uses source-level sessions and rejects callbacks from a stopped connection", async () => {
    const sessions = { setActive: vi.fn(async () => {}) }; let callbacks;
    const close = vi.fn(); const monitor = new BrowserUsageMonitor(sessions, [source], {
      connector: async (_source, options) => { callbacks = options; return { close }; },
    });
    await monitor.start("chrome");
    callbacks.onChange({ count: 2, reason: "closed", startKind: "observed" });
    expect(sessions.setActive).toHaveBeenLastCalledWith("chrome", true, { reason: "closed", startKind: "observed" });
    await monitor.stop(); const calls = sessions.setActive.mock.calls.length;
    callbacks.onChange({ count: 1, reason: "closed", startKind: "opened" }); callbacks.onDisconnect();
    expect(sessions.setActive).toHaveBeenCalledTimes(calls); expect(close).toHaveBeenCalledOnce();
    expect(monitor.snapshot().state).toBe("idle");
  });
});
