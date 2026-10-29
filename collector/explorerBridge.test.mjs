import { describe, expect, it, vi } from "vitest";
import { ExplorerBridge } from "./explorerBridge.mjs";
import { DirectHistoryError } from "./directHistory.mjs";

function fixture() {
  const api = { request: vi.fn(async () => ({ status_code: 0, user_list: [], has_more: 0, cursor: "0" })) };
  const collector = { ensureDirectApi: vi.fn(async () => api), getDirectChatClient: vi.fn(),
    syncPromise: null, hasActiveVideoDownload: () => false,
    store: { save: vi.fn(), clear: vi.fn() }, startSync: vi.fn() };
  return { collector, api, bridge: new ExplorerBridge(collector) };
}

describe("HTTP explorer adapter", () => {
  it("searches through imported credentials and leaves stored records untouched", async () => {
    const { collector, api, bridge } = fixture();
    expect(await bridge.run({ kind: "users", query: "建筑" })).toMatchObject({ kind: "users", items: [] });
    expect(api.request).toHaveBeenCalledWith("/aweme/v1/web/discover/search/", expect.objectContaining({
      query: expect.objectContaining({ keyword: "建筑" }),
    }));
    expect(collector.store.save).not.toHaveBeenCalled(); expect(collector.store.clear).not.toHaveBeenCalled();
    expect(collector.startSync).not.toHaveBeenCalled();
  });
  it("propagates credential expiry without falling back to a browser", async () => {
    const { collector, bridge } = fixture();
    collector.ensureDirectApi.mockRejectedValue(new DirectHistoryError("browser_reconnect_required", "请重新导入"));
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(bridge.busy).toBe(false);
  });
  it("lets feed pages, reactions and watch marks run beside video preparation and syncs the library afterwards", async () => {
    const { collector, api, bridge } = fixture();
    collector.hasActiveVideoDownload = () => true;
    collector.scheduleWatchHistoryRefresh = vi.fn(); collector.noteFeedWatch = vi.fn(); collector.syncInteraction = vi.fn(async () => {});
    bridge.explorer.read = vi.fn(async () => ({ kind: "feed" }));
    bridge.explorer.seen = vi.fn(async () => ({ ok: true }));
    bridge.explorer.react = vi.fn(async (input) => ({ outcome: "confirmed", value: input.desired }));
    api.request.mockResolvedValue({ aweme_detail: { aweme_id: "7654321098765432100" } });
    await expect(bridge.run({ kind: "feed" })).resolves.toEqual({ kind: "feed" });
    await bridge.run({ awemeId: "7654321098765432100", authorId: "1" }, "seen");
    expect(collector.scheduleWatchHistoryRefresh).toHaveBeenCalledOnce();
    expect(collector.noteFeedWatch).toHaveBeenCalledWith({ awemeId: "7654321098765432100", authorId: "1" });
    await bridge.run({ awemeId: "7654321098765432100", action: "collect", desired: true }, "react");
    await vi.waitFor(() => expect(collector.syncInteraction).toHaveBeenCalledWith("favorite_videos", { aweme_id: "7654321098765432100" }, true), { timeout: 3_000 });
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "collector_busy" });
    collector.syncPromise = Promise.resolve();
    await expect(bridge.run({ kind: "feed" })).rejects.toMatchObject({ code: "collector_busy" });
  });
  it("refuses overlapping searches and waits for a running interaction before clearing sessions", async () => {
    const { bridge } = fixture();
    let finish;
    bridge.explorer.interact = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    bridge.explorer.sessions.set("action", { direct: true });
    const action = bridge.run({}, "interact"); await Promise.resolve();
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "collector_busy" });
    const closing = bridge.close(["action"]); await Promise.resolve();
    expect(bridge.explorer.sessions.has("action")).toBe(true);
    finish({ outcome: "confirmed" }); await action; await closing;
    expect(bridge.explorer.sessions.has("action")).toBe(false); expect(bridge.busy).toBe(false);
  });
  it("blocks record reads and downloads while allowing independent chat reception", async () => {
    const { collector, bridge } = fixture();
    collector.syncPromise = Promise.resolve();
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "collector_busy" });
    collector.syncPromise = null; collector.hasActiveVideoDownload = () => true;
    await expect(bridge.run({ kind: "users", query: "建筑" })).rejects.toMatchObject({ code: "collector_busy" });
    collector.hasActiveVideoDownload = () => false; collector.chatPromise = Promise.resolve();
    await expect(bridge.run({ kind: "users", query: "建筑" })).resolves.toMatchObject({ kind: "users" });
  });
  it("rejects stale playback sessions before any HTTP request", async () => {
    const { collector, bridge } = fixture();
    await expect(bridge.run({ sessionId: "missing" }, "video")).rejects.toMatchObject({ code: "session_expired" });
    expect(collector.ensureDirectApi).not.toHaveBeenCalled();
  });
});
