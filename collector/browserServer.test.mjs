import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollectorServer } from "./server.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { saveDirectSession } from "./directApi.mjs";
import { DIRECT_SIGNER_COMMIT, DirectHistoryError } from "./directHistory.mjs";
import { directSessionFingerprint } from "./directCredentials.mjs";
import { directSessionFixture } from "./fixtures/directClient.mjs";

const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture({ isLoggedIn = () => true } = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "cdp-server-")); cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const identity = { uid: "123456", nickname: "合成账号", secUid: null, avatar: null };
  const cookies = [{ name: "sessionid", value: "synthetic", domain: ".douyin.com", path: "/", expires: -1 }];
  const loginButton = { click: vi.fn(async () => {}) };
  const page = { goto: vi.fn(), bringToFront: vi.fn(), isClosed: () => false,
    evaluate: vi.fn(async fn => fn.toString().includes("navigator.userAgent") ? directSessionFixture().userAgent : isLoggedIn() ? { ...identity } : null),
    getByRole: () => ({ count: async () => isLoggedIn() ? 0 : 1, nth: () => ({ isVisible: async () => true, click: loginButton.click }) }) };
  const context = new EventEmitter();
  Object.assign(context, { externalBrowser: true, cookies: vi.fn(async () => isLoggedIn() ? cookies : []), newPage: vi.fn(async () => page), pages: () => [page] });
  const connections = [];
  const browserConnector = vi.fn(async () => {
    const borrowed = Object.assign(new EventEmitter(), { externalBrowser: true, cookies: context.cookies, newPage: context.newPage, pages: context.pages });
    const connection = { browser: "chrome", label: "Chrome", connected: true, context: borrowed,
      disconnect: vi.fn(async () => { connection.connected = false; borrowed.emit("close"); }) };
    connections.push(connection); return connection;
  });
  const bootstrap = vi.spyOn(DouyinCollector.prototype, "ensureDirectApi").mockImplementation(async function (options) {
    expect(options).toEqual({ history: true, security: true });
    expect(this.externalConnection.connected).toBe(true);
    const session = { ...directSessionFixture(), uid: this.accountUid };
    session.security.sessionFingerprint = directSessionFingerprint(session);
    await saveDirectSession(this.dataDirectory, session);
    await writeFile(path.join(this.dataDirectory, "direct-history-template.json"), JSON.stringify({
      version: 1, signerCommit: DIRECT_SIGNER_COMMIT, capturedAt: new Date().toISOString(),
      parameterOrder: ["count", "max_cursor", "verifyFp", "fp", "uifid", "device_platform", "aid", "webid"],
      values: { ...session.values, count: "20", max_cursor: "0", device_platform: "webapp", aid: "6383" },
      headers: { "user-agent": session.userAgent },
    }));
    return {};
  });
  const readRecords = vi.spyOn(DouyinCollector.prototype, "runDirectRecords").mockImplementation(async function () {
    this.updateStatus({ state: "complete", phase: null, progress: null, message: "已完成合成记录读取" });
  });
  const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath,
    browserSources: [{ id: "chrome", label: "Chrome", directory: dataDirectory, inspectUrl: "chrome://inspect/#remote-debugging" }], browserConnector });
  cleanups.push(() => runtime.close());
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(response => response.json());
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  const call = async (route, method = "GET", body) => {
    const response = await fetch(`${runtime.baseUrl}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, call, headers, dataDirectory, connections, browserConnector, identity, loginButton, bootstrap, readRecords };
}

describe("browser login HTTP handshake", () => {
  it("requires pairing, confirms before saving credentials, and detaches while retaining records and source", async () => {
    const { runtime, call, dataDirectory, connections, readRecords } = await fixture();
    expect((await fetch(`${runtime.baseUrl}/v1/browser/sources`)).status).toBe(401);
    const inspected = await call("/v1/browser/connect?account=default", "POST", { browser: "chrome" });
    expect(inspected.status).toBe(200); expect(inspected.body.candidate).toMatchObject({ uid: "123456", nickname: "合成账号", accountId: "default", newAccount: false });
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect(readRecords).not.toHaveBeenCalled();
    const before = (await call("/v1/records")).body;
    const confirmed = await call("/v1/browser/confirm?account=default", "POST", { id: inspected.body.candidate.id });
    expect(confirmed.status).toBe(200); expect(confirmed.body.status.browserSource).toEqual({ mode: "cdp", browser: "chrome", connected: false, credentials: "ready" });
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { full: true });
    expect(confirmed.body.accounts[0].uid).toBe("123456");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "external-browser.json"), "utf8"))).toEqual({ browser: "chrome" });
    expect((await call("/v1/browser/disconnect?account=default", "POST")).body.status.browserSource.connected).toBe(false);
    expect(connections[0].disconnect).toHaveBeenCalledOnce(); expect((await call("/v1/records")).body).toEqual(before);
    expect((await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id })).body.error).toBe("browser_candidate_expired");
    expect(readRecords).toHaveBeenCalledOnce();
    expect((await call("/v1/status")).body.browserSource.mode).toBe("cdp");
    expect((await call("/v1/browser/independent?account=default", "POST")).status).toBe(404);
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").then(() => true, () => false)).toBe(true);
  });
  it("starts a full read after detaching, reports progress, and supports stopping without duplicate reads", async () => {
    const { call, connections, readRecords } = await fixture();
    let finishRead;
    readRecords.mockImplementationOnce(function () {
      expect(connections[0].disconnect).toHaveBeenCalledOnce();
      expect(this.getStatus().browserSource).toMatchObject({ credentials: "ready", connected: false });
      return new Promise(resolve => { finishRead = resolve; });
    });
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    const confirmed = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(confirmed).toMatchObject({ status: 200, body: { status: {
      state: "collecting", syncFull: true, syncMode: "direct_records", browserOpen: false,
    } } });
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { full: true });
    expect((await call("/v1/sync", "POST")).body.started).toBe(false);
    expect((await call("/v1/experimental/records-direct", "POST")).body.started).toBe(false);
    expect((await call("/v1/status")).body.syncFull).toBe(true);
    expect((await call("/v1/sync/stop", "POST")).body.stopped).toBe(true);
    finishRead();
    await vi.waitFor(async () => expect((await call("/v1/status")).body).toMatchObject({ state: "idle", syncMode: null }));
    expect(readRecords).toHaveBeenCalledOnce();
  });
  it("keeps an imported session ready and reports an automatic read failure through collector status", async () => {
    const { call, readRecords } = await fixture();
    readRecords.mockRejectedValueOnce(new DirectHistoryError("request_failed", "合成读取失败"));
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    expect((await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id })).status).toBe(200);
    await vi.waitFor(async () => expect((await call("/v1/status")).body).toMatchObject({
      state: "error", code: "request_failed", message: "合成读取失败",
      browserSource: { credentials: "ready", connected: false },
    }));
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { full: true });
  });
  it("keeps the browser open until a later login, then returns the account for confirmation", async () => {
    let loggedIn = false;
    const { call, connections, browserConnector, loginButton, readRecords } = await fixture({ isLoggedIn: () => loggedIn });
    let settled = false;
    const inspectedRequest = call("/v1/browser/connect", "POST", { browser: "chrome" }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(browserConnector).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(connections[0].disconnect).not.toHaveBeenCalled();
    expect(loginButton.click).toHaveBeenCalledOnce();

    loggedIn = true;
    const inspected = await inspectedRequest;
    expect(inspected).toMatchObject({ status: 200, body: { candidate: { uid: "123456", nickname: "合成账号" } } });
    expect(connections[0].disconnect).not.toHaveBeenCalled();
    await call("/v1/browser/pending", "DELETE", { id: inspected.body.candidate.id });
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(readRecords).not.toHaveBeenCalled();
  });
  it("disconnects the temporary browser when the login wait is cancelled", async () => {
    let loggedIn = false;
    const { runtime, headers, connections, browserConnector } = await fixture({ isLoggedIn: () => loggedIn });
    const controller = new AbortController();
    const request = fetch(`${runtime.baseUrl}/v1/browser/connect`, {
      method: "POST", headers,
      body: JSON.stringify({ browser: "chrome" }), signal: controller.signal,
    });
    await vi.waitFor(() => expect(browserConnector).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(connections[0].disconnect).toHaveBeenCalledOnce());
    expect(loggedIn).toBe(false);
  });
  it("reports a failed first export as requiring reconnection and never reports imported credentials", async () => {
    const { call, dataDirectory, connections, bootstrap, readRecords } = await fixture();
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    bootstrap.mockRejectedValueOnce(new Error("export failed"));
    const result = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(result.status).toBe(500);
    expect((await call("/v1/status")).body.browserSource).toMatchObject({ credentials: "reconnect_required", connected: false });
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect(connections[0].disconnect).toHaveBeenCalled();
    expect(readRecords).not.toHaveBeenCalled();
  });
  it.each([
    ["write_credentials_missing", "当前会话缺少服务端签名证书。"],
    ["template_missing", "无法从观看历史请求建立增量读取配置。"],
  ])("preserves the %s import failure and accepts a fresh connection afterwards", async (code, message) => {
    const { call, bootstrap, connections, dataDirectory, readRecords } = await fixture();
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    bootstrap.mockImplementationOnce(async function () {
      throw this.externalSessionError(new DirectHistoryError(code, message));
    });
    const failed = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(failed).toMatchObject({ status: 409, body: { error: "browser_import_failed", message: expect.stringContaining(message) } });
    expect(connections[0].disconnect).toHaveBeenCalled();
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect((await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id })).body.error).toBe("browser_candidate_expired");
    expect(readRecords).not.toHaveBeenCalled();
    const retry = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    const confirmed = await call("/v1/browser/confirm", "POST", { id: retry.body.candidate.id });
    expect(confirmed).toMatchObject({ status: 200, body: { status: { browserSource: { credentials: "ready", connected: false } } } });
    expect(readRecords).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { full: true });
  });
  it("rejects an account changing between preview and confirmation, without writing a session", async () => {
    const { call, identity, dataDirectory, connections, readRecords } = await fixture();
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" }); identity.uid = "789";
    const confirmed = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(confirmed.status).toBe(409); expect(confirmed.body.error).toBe("account_mismatch");
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect((await call("/v1/accounts")).body.accounts[0].uid).toBeNull();
    expect(readRecords).not.toHaveBeenCalled();
  });
  it("keeps a different account's records separate and reuses the existing matching account", async () => {
    const { call, identity, dataDirectory, readRecords } = await fixture();
    const first = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    await call("/v1/browser/confirm", "POST", { id: first.body.candidate.id });
    identity.uid = "789"; identity.nickname = "另一个合成账号";
    const next = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    expect(next.body.candidate.newAccount).toBe(true);
    const changed = await call("/v1/browser/confirm", "POST", { id: next.body.candidate.id });
    expect(changed.status).toBe(200); expect(changed.body.activeId).not.toBe("default"); expect(changed.body.accounts).toHaveLength(2);
    const otherId = changed.body.activeId;
    expect(readRecords.mock.contexts.map(collector => collector.getStatus().account.id)).toEqual(["default", otherId]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8")).uid).toBe("123456");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "accounts", otherId, "direct-session.json"), "utf8")).uid).toBe("789");
    identity.uid = "123456";
    const back = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    expect(back.body.candidate).toMatchObject({ accountId: "default", newAccount: false });
    expect((await call("/v1/browser/confirm", "POST", { id: back.body.candidate.id })).body.activeId).toBe("default");
    expect(readRecords.mock.contexts.map(collector => collector.getStatus().account.id)).toEqual(["default", otherId, "default"]);
    expect(readRecords.mock.calls.every(([, options]) => options.full === true)).toBe(true);
  });
  it("rejects unsupported sources, stale accounts, stale confirmations and busy collection", async () => {
    const { call, browserConnector } = await fixture();
    expect((await call("/v1/browser/connect", "POST", { browser: "ws://evil.example/" })).body.error).toBe("browser_unsupported");
    expect((await call("/v1/browser/connect?account=0123456789ab", "POST", { browser: "chrome" })).body.error).toBe("account_changed");
    expect((await call("/v1/browser/confirm", "POST", { id: "expired" })).body.error).toBe("browser_candidate_expired");
    expect(browserConnector).not.toHaveBeenCalled();
    const initialize = DouyinCollector.prototype.initialize;
    // A separate runtime exercises the ordinary collector busy gate.
    vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () { await initialize.call(this); this.syncPromise = new Promise(() => {}); });
    const second = await fixture();
    expect((await second.call("/v1/browser/connect", "POST", { browser: "chrome" })).body.error).toBe("collector_busy");
  });
});
