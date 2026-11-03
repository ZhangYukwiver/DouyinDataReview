import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCollectorServer } from "./server.mjs";
import { FEED_FILTER_ORIGINS } from "./feedFilter.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-api-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let observer;
  const close = vi.fn();
  const runtime = await startCollectorServer({ port: 0, dataDirectory: directory, desktopSupported: false,
    browserSources: [{ id: "chrome", label: "Chrome", directory }],
    usageBrowserConnector: async (_source, options) => { observer = options; options.onChange({ count: 2, reason: "closed", startKind: "observed" }); return { close }; },
    ...options,
  });
  cleanups.push(() => runtime.close());
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(response => response.json());
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  const call = async (route, method = "GET", body, overrides = {}) => {
    const response = await fetch(`${runtime.baseUrl}${route}`, { method, headers: { ...headers, ...overrides }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  return { runtime, directory, call, observer: () => observer, close };
}

describe("usage HTTP integration", () => {
  it("records native visibility, combines browser tabs into one session, and persists after stopping", async () => {
    const { runtime, directory, call, observer, close } = await setup();
    await runtime.setAppUsageActive(true);
    expect((await call("/v1/usage/sessions")).value.activeSources).toEqual(["app"]);
    await runtime.setAppUsageActive(false);
    expect((await call("/v1/usage/browser", "POST", { browser: "chrome" })).value.browser.state).toBe("connected");
    observer().onChange({ count: 1, reason: "closed", startKind: "opened" });
    let result = await call("/v1/usage/sessions");
    expect(result.value.total).toBe(2); expect(result.value.activeSources).toEqual(["chrome"]);
    expect(result.value.sessions[0].startKind).toBe("observed");
    observer().onChange({ count: 0, reason: "closed", startKind: "opened" });
    result = await call("/v1/usage/sessions");
    expect(result.value.sessions[0].endReason).toBe("closed");
    expect(result.value.activeSources).toEqual([]);
    await call("/v1/usage/browser", "DELETE"); expect(close).toHaveBeenCalledOnce();
    const disk = JSON.parse(await readFile(path.join(directory, "usage-sessions.json"), "utf8"));
    expect(disk.sessions).toHaveLength(2);
    expect(disk.sessions.every(row => row.endedAt !== null)).toBe(true);
  });

  it("requires app pairing and rejects extension tokens, invalid browsers, and invalid pagination", async () => {
    const { runtime, call } = await setup();
    expect((await call("/v1/usage/sessions", "GET", undefined, { Authorization: "" })).status).toBe(401);
    expect((await call("/v1/usage/sessions?offset=-1")).status).toBe(400);
    expect((await call("/v1/usage/browser", "POST", { browser: "app" })).status).toBe(400);
    expect((await call("/v1/usage/browser", "POST", { browser: "ws://evil.invalid" })).status).toBe(400);
    const extension = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { Origin: FEED_FILTER_ORIGINS[0] }, body: "{}" }).then(response => response.json());
    expect((await call("/v1/usage/sessions", "GET", undefined, { Authorization: `Bearer ${extension.token}` })).status).toBe(403);
    expect((await call("/v1/usage/settings", "POST", { enabled: true, browser: "chrome" }, { Authorization: `Bearer ${extension.token}` })).status).toBe(403);
  });

  it("ends app sessions on suspend and shutdown without changing browser-login behavior", async () => {
    const { runtime, call, directory } = await setup();
    await runtime.setAppUsageActive(true); await runtime.setUsageSuspended(true);
    expect((await call("/v1/usage/sessions")).value.sessions[0].endReason).toBe("suspended");
    await runtime.setUsageSuspended(false);
    expect((await call("/v1/usage/sessions")).value.sessions[0].startKind).toBe("resumed");
    await runtime.close();
    const disk = JSON.parse(await readFile(path.join(directory, "usage-sessions.json"), "utf8"));
    expect(disk.sessions.at(-1).endReason).toBe("stopped");
  });

  it("persists automatic connection settings and restores them on the next software startup", async () => {
    const { runtime, call, directory } = await setup({ usageBrowserDiscovery: async () => "browser-1" });
    expect((await call("/v1/usage/settings")).value.settings).toEqual({ enabled: false, browser: "chrome" });
    expect((await call("/v1/usage/settings", "POST", { enabled: "yes", browser: "chrome" })).status).toBe(400);
    expect((await call("/v1/usage/settings", "POST", { enabled: true, browser: "app" })).status).toBe(400);
    expect((await call("/v1/usage/settings", "POST", { enabled: true, browser: "chrome" }, { Authorization: "" })).status).toBe(401);
    const settings = { enabled: true, browser: "chrome" };
    expect((await call("/v1/usage/settings", "POST", settings)).value.settings).toEqual(settings);
    await vi.waitFor(async () => expect((await call("/v1/usage/sessions")).value.browser.state).toBe("connected"));
    expect(JSON.parse(await readFile(path.join(directory, "usage-browser-settings.json"), "utf8"))).toEqual(settings);
    await runtime.close();
    const connect = vi.fn(async () => ({ close() {} }));
    const restarted = await startCollectorServer({ port: 0, dataDirectory: directory, desktopSupported: false,
      browserSources: [{ id: "chrome", label: "Chrome", directory }], usageBrowserConnector: connect,
      usageBrowserDiscovery: async () => "browser-1" });
    cleanups.push(() => restarted.close());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  });
});
