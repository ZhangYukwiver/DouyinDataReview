import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserUsageMonitor } from "./browserUsage.mjs";
import { UsageAutoConnect } from "./usageAutoConnect.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup({ discover = async () => "browser-1", connector } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-auto-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessions = { setActive: vi.fn(async () => {}) };
  const close = vi.fn();
  const connect = vi.fn(connector ?? (async () => ({ close })));
  const monitor = new BrowserUsageMonitor(sessions, [{ id: "chrome", label: "Chrome" }, { id: "edge", label: "Edge" }], { connector: connect });
  const auto = await new UsageAutoConnect(directory, monitor, { discover, intervalMs: 0 }).initialize();
  cleanups.push(async () => { await auto.close(); await monitor.stop(); });
  return { directory, auto, monitor, connect, sessions, close };
}
const enable = { enabled: true, browser: "chrome" };

describe("automatic usage connection", () => {
  it("defaults off, persists opt-in, and requests again when the app restarts", async () => {
    const { directory, auto, monitor, connect } = await setup();
    auto.start(); await auto.check(); expect(connect).not.toHaveBeenCalled();
    await auto.configure(enable); await auto.check();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][1].openSettingsIfNeeded).toBe(false);
    expect(JSON.parse(await readFile(auto.file, "utf8"))).toEqual(enable);
    await auto.close(); await monitor.stop();
    const restarted = await new UsageAutoConnect(directory, monitor, { discover: async () => "browser-1", intervalMs: 0 }).initialize();
    cleanups.push(() => restarted.close());
    expect(restarted.snapshot()).toEqual(enable);
    restarted.start(); await restarted.check(); expect(connect).toHaveBeenCalledTimes(2);
  });

  it("waits for a browser and keeps one connection across page changes, then reconnects after browser restart", async () => {
    let instance = null, observer;
    const { auto, connect, sessions } = await setup({ discover: async () => instance,
      connector: async (_source, options) => { observer = options; return { close() {} }; } });
    await auto.configure(enable); await auto.check(); expect(connect).not.toHaveBeenCalled();
    instance = "browser-1"; await auto.check();
    observer.onChange({ count: 1, reason: "closed", startKind: "opened" });
    observer.onChange({ count: 0, reason: "closed", startKind: "opened" });
    observer.onChange({ count: 2, reason: "closed", startKind: "opened" });
    await auto.check(); expect(connect).toHaveBeenCalledOnce();
    expect(sessions.setActive).toHaveBeenLastCalledWith("chrome", true, { reason: "closed", startKind: "opened" });
    instance = "browser-2"; await auto.check(); expect(connect).toHaveBeenCalledOnce();
    observer.onDisconnect();
    await auto.check(); expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly prompt after denial, timeout or manual stop", async () => {
    let instance = "browser-1";
    const { auto, monitor, connect } = await setup({ discover: async () => instance,
      connector: async () => { throw new Error("denied"); } });
    await auto.configure(enable); await auto.check();
    await auto.check(); await auto.check(); expect(connect).toHaveBeenCalledOnce();
    instance = null; await auto.check(); instance = "browser-2";
    connect.mockImplementation(async () => ({ close() {} }));
    await auto.check(); expect(connect).toHaveBeenCalledTimes(2);
    auto.manualAction(); await monitor.stop(); await auto.check(); await auto.check();
    expect(connect).toHaveBeenCalledTimes(2);
    instance = "browser-3"; await auto.check(); expect(connect).toHaveBeenCalledTimes(3);
  });

  it("discards an in-flight discovery when disabled or manually stopped", async () => {
    let resolve;
    const { auto, connect } = await setup({ discover: () => new Promise(done => { resolve = done; }) });
    await auto.configure(enable);
    await auto.configure({ ...enable, enabled: false });
    resolve("browser-1"); await auto.check(); expect(connect).not.toHaveBeenCalled();
    await auto.configure(enable);
    auto.manualAction(); resolve("browser-1"); await auto.check(); expect(connect).not.toHaveBeenCalled();
    const pending = auto.check(); resolve("browser-1"); await pending; expect(connect).not.toHaveBeenCalled();
  });

  it("cancels a pending permission request on disable and ignores late browser events", async () => {
    let observer;
    const { auto, monitor, connect, sessions } = await setup({ connector: (_source, options) => {
      observer = options;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } });
    await auto.configure(enable);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await auto.configure({ ...enable, enabled: false }); await auto.check();
    expect(observer.signal.aborted).toBe(true);
    const calls = sessions.setActive.mock.calls.length;
    observer.onChange({ count: 1, reason: "closed", startKind: "opened" });
    expect(sessions.setActive).toHaveBeenCalledTimes(calls);
    expect(monitor.snapshot().state).toBe("idle");
  });

  it("switches the configured browser and rejects invalid settings", async () => {
    const { auto, connect, close } = await setup();
    await auto.configure(enable); await auto.check();
    await auto.configure({ enabled: true, browser: "edge" }); await auto.check();
    expect(close).toHaveBeenCalledOnce();
    expect(connect.mock.calls.map(([source]) => source.id)).toEqual(["chrome", "edge"]);
    await expect(auto.configure({ enabled: "true", browser: "chrome" })).rejects.toMatchObject({ status: 400 });
    await expect(auto.configure({ enabled: true, browser: "ws://evil.test" })).rejects.toMatchObject({ status: 400 });
    expect(auto.snapshot()).toEqual({ enabled: true, browser: "edge" });
  });
});
