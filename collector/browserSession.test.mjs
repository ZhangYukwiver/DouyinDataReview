import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DouyinCollector } from "./douyinCollector.mjs";
import { CollectorStore } from "./store.mjs";
import { loadDirectSession, saveDirectSession } from "./directApi.mjs";
import { DIRECT_SIGNER_COMMIT, DirectHistoryError, fetchDirectHistoryPage } from "./directHistory.mjs";
import { directApiFixture, directSessionFixture, testCookie } from "./fixtures/directClient.mjs";

const cleanup = [];
afterEach(async () => { vi.restoreAllMocks(); for (const work of cleanup.splice(0).reverse()) await work(); });

async function fixture({ session = directSessionFixture(), sourceMarker = true, handler = () => ({ payload: { status_code: 0, user_uid: "123" } }) } = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-imported-session-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  await saveDirectSession(dataDirectory, session);
  if (sourceMarker) await writeFile(path.join(dataDirectory, "external-browser.json"), '{"browser":"chrome"}\n');
  await writeFile(path.join(dataDirectory, "direct-history-template.json"), JSON.stringify({
    version: 1, signerCommit: DIRECT_SIGNER_COMMIT, capturedAt: new Date().toISOString(),
    parameterOrder: ["count", "max_cursor", "verifyFp", "fp", "uifid", "device_platform", "aid", "webid"],
    values: { ...session.values, count: "20", max_cursor: "0", device_platform: "webapp", aid: "6383" },
    headers: { "user-agent": session.userAgent },
  }));
  const collector = new DouyinCollector({ executablePath: "unused", dataDirectory, store: new CollectorStore(dataDirectory),
    account: { id: "default", uid: "123", nickname: "合成账号" } });
  await collector.initialize();
  cleanup.push(() => collector.shutdown());
  const http = directApiFixture(handler);
  http.api.dataDirectory = dataDirectory;
  http.api.onSessionError = error => collector.externalSessionError(error);
  collector.directApi = http.api;
  const browser = (collector.ensureBrowser = vi.fn()).mockRejectedValue(new Error("must not launch browser"));
  return { collector, http, browser, dataDirectory };
}

describe("imported credentials without a running browser", () => {
  it("reuses an older complete cache without a source marker", async () => {
    const { collector, browser, dataDirectory } = await fixture({ sourceMarker: false });
    expect(collector.getStatus().browserSource).toEqual({ mode: "cdp", browser: null, connected: false, credentials: "ready" });
    await expect(collector.ensureDirectApi({ history: true, security: true })).resolves.toBeTruthy();
    expect(browser).not.toHaveBeenCalled();
    expect(await readFile(path.join(dataDirectory, "external-browser.json")).then(() => true, () => false)).toBe(false);
  });
  it("restores a complete imported session after restart and reads HTTP lists without connecting or launching a browser", async () => {
    const { collector, http, browser } = await fixture({ handler: url => ({ payload: url.pathname.includes("/query/user/")
      ? { status_code: 0, user_uid: "123" } : { status_code: 0, aweme_list: [], has_more: 0, max_cursor: "0", cursor: "0" } }) });
    expect(collector.getStatus().browserSource).toEqual({ mode: "cdp", browser: "chrome", connected: false, credentials: "ready" });
    const api = await collector.ensureDirectApi({ history: true, security: true });
    for (const type of ["liked_videos", "favorite_videos"]) await api.collectRecordPages(type, () => false);
    expect(http.fetch).toHaveBeenCalledTimes(3);
    expect(browser).not.toHaveBeenCalled(); expect(collector.context).toBeNull();
  });
  it("keeps HTTP tasks alive when the external transport is explicitly detached", async () => {
    const { collector, http } = await fixture();
    const context = new EventEmitter();
    const connection = { context, disconnect: vi.fn(async () => context.emit("close")) };
    collector.externalConnection = connection; collector.context = context;
    const close = vi.spyOn(http.api, "close");
    const stop = vi.spyOn(collector, "stopSync");
    await collector.disconnectExternalBrowser();
    expect(connection.disconnect).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(collector.getStatus().browserSource).toMatchObject({ connected: false, credentials: "ready" });
    await expect(collector.ensureDirectApi()).resolves.toBe(http.api);
  });
  it("stops on a server login rejection during a list read and requires explicit reconnection without launching a fallback", async () => {
    const { collector, http, browser } = await fixture({ handler: url => ({ payload: url.pathname.includes("/query/user/")
      ? { status_code: 0, user_uid: "123" } : { status_code: 8 } }) });
    const api = await collector.ensureDirectApi();
    await expect(api.collectRecordPages("liked_videos", () => false)).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(collector.getStatus().browserSource.credentials).toBe("reconnect_required");
    await expect(collector.ensureDirectApi()).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(http.fetch).toHaveBeenCalledTimes(2); expect(browser).not.toHaveBeenCalled();
  });
  it.each([401, 403])("requires reconnection when the identity check is rejected with HTTP %s", async status => {
    const { collector, browser } = await fixture({ handler: () => ({ status }) });
    await expect(collector.ensureDirectApi()).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(collector.getStatus().browserSource.credentials).toBe("reconnect_required"); expect(browser).not.toHaveBeenCalled();
  });
  it("requires reconnection when history paging receives a login rejection after a successful identity check", async () => {
    const { collector, browser, dataDirectory } = await fixture();
    const api = await collector.ensureDirectApi();
    const before = JSON.stringify(collector.getSnapshot());
    const requestFactory = { newContext: vi.fn(async () => ({
      get: vi.fn(async url => ({ status: () => 200, url: () => url, headers: () => ({}), body: async () => Buffer.from('{"status_code":8}'), dispose: async () => {} })),
      dispose: async () => {},
    })) };
    await expect(fetchDirectHistoryPage({ context: api, currentUserAgent: api.currentUserAgent, dataDirectory, requestFactory,
      signer: async url => `${url}&a_bogus=${"A".repeat(80)}` })).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(collector.getStatus().browserSource.credentials).toBe("reconnect_required");
    expect(JSON.stringify(collector.getSnapshot())).toBe(before); expect(browser).not.toHaveBeenCalled();
  });
  it.each(["expired", "missing"])("restores a cache with a %s short token when the platform still accepts its login", async token => {
    const session = directSessionFixture(); session.browserBoundSession = true;
    if (token === "expired") session.cookies.push({ ...testCookie("x_tt_token", "expired"), expires: (Date.now() - 1_000) / 1000 });
    const { collector, http, browser } = await fixture({ session, handler: url => ({ payload: url.pathname.includes("/query/user/")
      ? { status_code: 0, user_uid: "123" } : { status_code: 0, aweme_list: [], has_more: 0, max_cursor: "0", cursor: "0" } }) });
    expect(collector.getStatus().browserSource).toMatchObject({ credentials: "ready", connected: false });
    const api = await collector.ensureDirectApi({ history: true, security: true });
    for (const type of ["liked_videos", "favorite_videos"]) await api.collectRecordPages(type, () => false);
    expect(http.fetch).toHaveBeenCalledTimes(3);
    expect(collector.getStatus().browserSource.credentials).toBe("ready");
    expect(browser).not.toHaveBeenCalled(); expect(collector.context).toBeNull();
  });
  it.each([401, 403, "logout", "account_mismatch"])("requires reconnection for an expired short token only after platform rejection %s", async rejection => {
    const session = directSessionFixture(); session.browserBoundSession = true;
    const { collector, http, browser, dataDirectory } = await fixture({ session, handler: () => typeof rejection === "number"
      ? { status: rejection } : { payload: rejection === "logout" ? { status_code: 8 } : { status_code: 0, user_uid: "456" } } });
    const before = await loadDirectSession(dataDirectory);
    const snapshot = collector.getSnapshot();
    expect(collector.getStatus().browserSource.credentials).toBe("ready");
    await expect(collector.ensureDirectApi({ security: true })).rejects.toMatchObject({ code: "browser_reconnect_required" });
    expect(collector.getStatus().browserSource.credentials).toBe("reconnect_required");
    expect(http.fetch).toHaveBeenCalledOnce(); expect(browser).not.toHaveBeenCalled();
    expect(await loadDirectSession(dataDirectory)).toMatchObject({ uid: before.uid, cookies: before.cookies,
      security: before.security, browserBoundSession: before.browserBoundSession });
    expect(collector.getSnapshot()).toEqual(snapshot);
  });
  it("keeps an expired-token cache usable after network failures rather than treating them as expired credentials", async () => {
    const session = directSessionFixture(); session.browserBoundSession = true;
    const { collector, browser } = await fixture({ session, handler: () => { throw new Error("offline"); } });
    await expect(collector.ensureDirectApi()).rejects.toMatchObject({ code: "request_failed" });
    expect(collector.getStatus().browserSource.credentials).toBe("ready"); expect(browser).not.toHaveBeenCalled();
  });
  it("reimports an expired account, clears the reconnect requirement, and detaches the new transport", async () => {
    const { collector, dataDirectory, browser } = await fixture();
    const template = await readFile(path.join(dataDirectory, "direct-history-template.json"));
    collector.externalSessionError(new DirectHistoryError("login_required", "expired"));
    const context = Object.assign(new EventEmitter(), { externalBrowser: true });
    const connection = { context, browser: "chrome", label: "Chrome", connected: true, disconnect: vi.fn(async () => context.emit("close")) };
    vi.spyOn(collector, "cacheDirectSession").mockImplementation(async () => saveDirectSession(dataDirectory, directSessionFixture()));
    vi.spyOn(collector, "ensureDirectApi").mockImplementation(async () => {
      expect(collector.externalSessionState).toBe("exporting");
      await writeFile(path.join(dataDirectory, "direct-history-template.json"), template);
      return {};
    });
    await collector.attachExternalBrowser(connection, { uid: "123", nickname: "合成账号" }, {});
    expect(collector.getStatus().browserSource).toMatchObject({ credentials: "ready", connected: false });
    expect(connection.disconnect).toHaveBeenCalledOnce(); expect(browser).not.toHaveBeenCalled();
  });
  it("restores the previous usable import and records if refreshing it fails", async () => {
    const { collector, dataDirectory } = await fixture();
    const files = ["direct-session.json", "direct-history-template.json", "external-browser.json"];
    const before = await Promise.all(files.map(name => readFile(path.join(dataDirectory, name), "utf8")));
    const records = JSON.stringify(collector.getSnapshot());
    const context = Object.assign(new EventEmitter(), { externalBrowser: true });
    const connection = { context, browser: "chrome", label: "Chrome", connected: true, disconnect: vi.fn(async () => context.emit("close")) };
    vi.spyOn(collector, "cacheDirectSession").mockResolvedValue({});
    vi.spyOn(collector, "ensureDirectApi").mockRejectedValue(new DirectHistoryError("request_failed", "offline"));
    await expect(collector.attachExternalBrowser(connection, { uid: "123", nickname: "合成账号" }, {})).rejects.toMatchObject({ code: "request_failed" });
    expect(await Promise.all(files.map(name => readFile(path.join(dataDirectory, name), "utf8")))).toEqual(before);
    expect(collector.getStatus().browserSource).toMatchObject({ credentials: "ready", connected: false });
    expect(JSON.stringify(collector.getSnapshot())).toBe(records); expect(connection.disconnect).toHaveBeenCalled();
  });
});
