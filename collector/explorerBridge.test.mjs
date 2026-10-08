import { describe, expect, it, vi } from "vitest";
import { ExplorerBridge } from "./explorerBridge.mjs";

function originalCollector() {
  const state = { state: "complete", message: "原采集已完成", browserOpen: false };
  const collector = { context: null, syncPromise: null, observationPromise: null,
    hasActiveVideoDownload: () => false, getStatus: () => ({ ...state }), updateStatus: vi.fn((patch) => Object.assign(state, patch)),
    startSync: vi.fn(), startVideoDownload: vi.fn(), store: { save: vi.fn(), clear: vi.fn() } };
  const context = { close: vi.fn(async () => { collector.context = null; }), newPage: vi.fn(), on: vi.fn() };
  collector.ensureBrowser = vi.fn(async ({ headless }) => { collector.context = context; collector.contextHeadless = headless; state.state = "launching_browser"; return context; });
  collector.hasLoginSession = vi.fn(async () => true);
  return { collector, context };
}

describe("additive explorer adapter", () => {
  it("leaves original records and download jobs untouched", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    bridge.explorer.read = vi.fn(async () => ({ kind: "users", items: [] }));
    await bridge.run({ kind: "users", query: "建筑" });
    expect(collector.store.save).not.toHaveBeenCalled();
    expect(collector.store.clear).not.toHaveBeenCalled();
    expect(collector.startSync).not.toHaveBeenCalled();
    expect(collector.startVideoDownload).not.toHaveBeenCalled();
  });
  it("restores the existing status after opening its own browser", async () => {
    const { collector, context } = originalCollector(); const bridge = new ExplorerBridge(collector);
    await bridge.explorer.getContext();
    expect(collector.getStatus()).toMatchObject({ state: "complete", message: "原采集已完成" });
    await bridge.close();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
  it("closes its own browser once the download that was still using it finishes", async () => {
    const { collector, context } = originalCollector(); const bridge = new ExplorerBridge(collector);
    await bridge.explorer.getContext();
    // 探索页在下载还没跑完时离开：会话页关掉了，但下载在用这个浏览器，所以先留着
    collector.hasActiveVideoDownload = () => true;
    bridge.explorer.sessions.set("profile", { page: { close: vi.fn(async () => {}) } });
    await bridge.close(["profile"]);
    expect(context.close).not.toHaveBeenCalled();
    collector.afterVideoDownload(); await bridge.pending;
    expect(context.close).not.toHaveBeenCalled();
    collector.hasActiveVideoDownload = () => false;
    collector.afterVideoDownload(); await bridge.pending;
    expect(context.close).toHaveBeenCalledTimes(1);
  });
  it("leaves its browser alone after a download while an explore page is still open or chat is sharing it", async () => {
    const { collector, context } = originalCollector(); const bridge = new ExplorerBridge(collector);
    await bridge.explorer.getContext();
    bridge.explorer.sessions.set("profile", { page: { close: vi.fn(async () => {}) } });
    collector.afterVideoDownload(); await bridge.pending;
    expect(context.close).not.toHaveBeenCalled();
    bridge.explorer.sessions.clear(); collector.chatPromise = Promise.resolve();
    collector.afterVideoDownload(); await bridge.pending;
    expect(context.close).not.toHaveBeenCalled();
  });
  it("does not let a finished download close the browser while a read is still setting up its session", async () => {
    const { collector, context } = originalCollector(); const bridge = new ExplorerBridge(collector);
    let release; const gate = new Promise((resolve) => { release = resolve; });
    bridge.explorer.read = vi.fn(async () => {
      await bridge.explorer.getContext();
      await gate; // 已经拿到浏览器、还没建好会话
      bridge.explorer.sessions.set("profile", { page: { close: vi.fn(async () => {}) } });
      return { kind: "profile", items: [] };
    });
    const reading = bridge.run({ kind: "profile", id: "abc" });
    await vi.waitFor(() => expect(bridge.explorer.read).toHaveBeenCalled());
    collector.afterVideoDownload();
    release(); await reading; await bridge.pending;
    expect(context.close).not.toHaveBeenCalled();
    expect(bridge.explorer.sessions.has("profile")).toBe(true);
  });
  it("gives up on a browser that will not close instead of staying busy forever", async () => {
    vi.useFakeTimers();
    try {
      const { collector, context } = originalCollector(); const bridge = new ExplorerBridge(collector);
      await bridge.explorer.getContext();
      context.close = vi.fn(() => new Promise(() => {}));
      collector.afterVideoDownload();
      expect(bridge.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(bridge.busy).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("gives a browser it only borrowed back to the collector once the last explore page is closed", async () => {
    // 创作者页先把无头会话开起来，探索借用它（ownedContext 为空）；别的任务收尾时因为探索页还开着跳过了，探索关光后要补一次
    const { collector, context } = originalCollector();
    collector.context = context; collector.contextHeadless = true;
    let holdSeenByRelease = null;
    collector.releaseHeadlessContextIfIdle = vi.fn(async () => { holdSeenByRelease = collector.exploreHoldsContext(); });
    const bridge = new ExplorerBridge(collector);
    bridge.explorer.sessions.set("results", { page: { close: vi.fn(async () => {}), isClosed: () => false } });
    await bridge.close(["results"]);
    expect(context.close).not.toHaveBeenCalled();
    expect(collector.releaseHeadlessContextIfIdle).toHaveBeenCalledTimes(1);
    expect(holdSeenByRelease).toBe(false);
  });
  it("keeps new explore reads out while it is still releasing a borrowed browser", async () => {
    const { collector, context } = originalCollector();
    collector.context = context; collector.contextHeadless = true;
    let finish; const closing = new Promise((resolve) => { finish = resolve; });
    let busyDuringRelease = null, holdsDuringRelease = null, runDuringRelease = null;
    const bridge = new ExplorerBridge(collector);
    collector.releaseHeadlessContextIfIdle = vi.fn(async () => {
      busyDuringRelease = bridge.busy; holdsDuringRelease = collector.exploreHoldsContext();
      runDuringRelease = await bridge.run({ kind: "users", query: "x" }).then(() => "ran", (error) => error.code);
      await closing;
    });
    bridge.explorer.sessions.set("results", { page: { close: vi.fn(async () => {}), isClosed: () => false } });
    const closed = bridge.close(["results"]);
    await vi.waitFor(() => expect(collector.releaseHeadlessContextIfIdle).toHaveBeenCalled());
    // 关的时候新的读取要等：得到 collector_busy，而不是趁旧会话还没关完去起新的；但这个 pending 不算「探索还在用」
    expect(busyDuringRelease).toBe(true);
    expect(holdsDuringRelease).toBe(false);
    await vi.waitFor(() => expect(runDuringRelease).toBe("collector_busy"));
    finish(); await closed;
    expect(bridge.busy).toBe(false);
  });
  it("does not count an explore page whose browser tab is already gone as holding the browser", () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    bridge.explorer.sessions.set("dead", { page: { close: vi.fn(), isClosed: () => true } });
    expect(collector.exploreHoldsContext()).toBe(false);
    bridge.explorer.sessions.set("live", { page: { close: vi.fn(), isClosed: () => false } });
    expect(collector.exploreHoldsContext()).toBe(true);
  });
  it("tells the collector when explore pages are open so other tasks leave the shared browser alone", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    expect(collector.exploreHoldsContext()).toBe(false);
    bridge.explorer.sessions.set("results", { page: { close: vi.fn(async () => {}) } });
    expect(collector.exploreHoldsContext()).toBe(true);
    await bridge.close(["results"]);
    expect(collector.exploreHoldsContext()).toBe(false);
  });
  it("closes its own tabs without closing a borrowed original browser", async () => {
    const { collector, context } = originalCollector(); collector.context = context; collector.contextHeadless = false;
    const bridge = new ExplorerBridge(collector); await bridge.explorer.getContext();
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
    const page = { close: vi.fn(async () => {}) };
    bridge.explorer.sessions.set("new-tab", { page });
    await bridge.close(["new-tab"]);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });
  it("keeps another page's exploration sessions open", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    const own = { close: vi.fn(async () => {}) }, other = { close: vi.fn(async () => {}) };
    bridge.explorer.sessions.set("own", { page: own }); bridge.explorer.sessions.set("other", { page: other });
    await bridge.close(["own"]);
    expect(own.close).toHaveBeenCalledTimes(1); expect(other.close).not.toHaveBeenCalled();
    expect(bridge.explorer.sessions.has("other")).toBe(true);
  });
  it("starts headless only when needed and requires an existing login", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    await bridge.explorer.getContext();
    expect(collector.ensureBrowser).toHaveBeenCalledWith({ headless: true });
    collector.hasLoginSession = async () => false;
    await expect(bridge.explorer.getContext()).rejects.toMatchObject({ code: "login_required" });
  });
  it("refuses new exploration while an original workflow is running", async () => {
    const { collector } = originalCollector(); collector.syncPromise = Promise.resolve();
    const bridge = new ExplorerBridge(collector);
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "collector_busy" });
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
  });
  it("shares live chat's browser without closing its receiving context", async () => {
    const { collector, context } = originalCollector();
    const bridge = new ExplorerBridge(collector);
    await bridge.explorer.getContext();
    collector.observationPromise = Promise.resolve();
    collector.isChatReceiving = () => true;
    bridge.explorer.read = vi.fn(async () => ({ kind: "users", items: [] }));
    await expect(bridge.run({ kind: "users", query: "建筑" })).resolves.toMatchObject({ items: [] });
    await bridge.close();
    expect(context.close).not.toHaveBeenCalled();
  });
  it("reuses live chat without launching a second browser or copying its login", async () => {
    const { collector, context: chat } = originalCollector();
    collector.context = chat; collector.contextHeadless = true;
    collector.observationPromise = Promise.resolve(); collector.isChatReceiving = () => true;
    chat.storageState = vi.fn(async () => ({ cookies: [], origins: [] }));
    const bridge = new ExplorerBridge(collector);
    expect(await bridge.explorer.getContext()).toBe(chat);
    expect(await bridge.explorer.getContext()).toBe(chat);
    expect(chat.storageState).not.toHaveBeenCalled();
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
    await bridge.close();
    expect(chat.close).not.toHaveBeenCalled();
    expect(collector.context).toBe(chat);
  });
  it("searches during ready manual observation without interrupting it", async () => {
    const { collector, context } = originalCollector();
    collector.context = context; collector.contextHeadless = false;
    const observation = Promise.resolve(); collector.observationPromise = observation;
    collector.isManualObserving = () => true;
    collector.stopObservation = vi.fn();
    const bridge = new ExplorerBridge(collector);
    const page = { close: vi.fn(async () => {}) };
    bridge.explorer.read = vi.fn(async () => {
      expect(await bridge.explorer.getContext()).toBe(context);
      bridge.explorer.sessions.set("search", { page });
      return { kind: "users", items: [{ name: "离线测试" }] };
    });
    await expect(bridge.run({ kind: "users", query: "123" })).resolves.toMatchObject({ items: [{ name: "离线测试" }] });
    await bridge.close(["search"]);
    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
    expect(collector.stopObservation).not.toHaveBeenCalled();
    expect(collector.observationPromise).toBe(observation);
    expect(collector.store.save).not.toHaveBeenCalled();
  });
  it.each(["launching", "sync", "download"])("still blocks exploration during %s", async (operation) => {
    const { collector, context } = originalCollector();
    collector.context = context; collector.observationPromise = Promise.resolve();
    collector.isManualObserving = () => operation !== "launching";
    if (operation === "sync") collector.syncPromise = Promise.resolve();
    if (operation === "download") collector.hasActiveVideoDownload = () => true;
    const bridge = new ExplorerBridge(collector);
    bridge.explorer.read = vi.fn();
    await expect(bridge.run({ kind: "users", query: "123" })).rejects.toMatchObject({ code: "collector_busy" });
    expect(bridge.explorer.read).not.toHaveBeenCalled();
  });
  it("passes request cancellation through and releases the busy flag", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    const controller = new AbortController();
    bridge.explorer.read = vi.fn(async (_input, { signal }) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = bridge.run({ kind: "users", query: "建筑" }, "read", controller.signal);
    await Promise.resolve();
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(); await rejected;
    expect(bridge.busy).toBe(false);
  });
  it("waits for an explicit action to settle before cleaning up its tab", async () => {
    const { collector } = originalCollector(); const bridge = new ExplorerBridge(collector);
    let finish; bridge.explorer.interact = () => new Promise((resolve) => { finish = resolve; });
    const page = { close: vi.fn(async () => {}) }; bridge.explorer.sessions.set("action", { page });
    const action = bridge.run({}, "interact"); await Promise.resolve();
    const closing = bridge.close(["action"]); await Promise.resolve();
    expect(page.close).not.toHaveBeenCalled(); expect(bridge.busy).toBe(true);
    finish({ outcome: "confirmed" }); await action; await closing;
    expect(page.close).toHaveBeenCalledTimes(1); expect(bridge.busy).toBe(false);
  });
});
