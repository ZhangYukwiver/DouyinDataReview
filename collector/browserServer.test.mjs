import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollectorServer } from "./server.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { saveDirectSession } from "./directApi.mjs";
import { DIRECT_SIGNER_COMMIT } from "./directHistory.mjs";
import { directSessionFingerprint } from "./directCredentials.mjs";
import { directSessionFixture } from "./fixtures/directClient.mjs";

const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "cdp-server-")); cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const identity = { uid: "123456", nickname: "合成账号", secUid: null, avatar: null };
  const cookies = [{ name: "sessionid", value: "synthetic", domain: ".douyin.com", path: "/", expires: -1 }];
  const page = { goto: vi.fn(), isClosed: () => false, evaluate: vi.fn(async fn => fn.toString().includes("navigator.userAgent") ? directSessionFixture().userAgent : { ...identity }),
    getByRole: () => ({ count: async () => 0 }) };
  const context = new EventEmitter();
  Object.assign(context, { externalBrowser: true, cookies: vi.fn(async () => cookies), newPage: vi.fn(async () => page), pages: () => [page] });
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
  const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath,
    browserSources: [{ id: "chrome", label: "Chrome", directory: dataDirectory, inspectUrl: "chrome://inspect/#remote-debugging" }], browserConnector });
  cleanups.push(() => runtime.close());
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(response => response.json());
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  const call = async (route, method = "GET", body) => {
    const response = await fetch(`${runtime.baseUrl}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, call, dataDirectory, connections, browserConnector, identity, bootstrap };
}

describe("browser login HTTP handshake", () => {
  it("requires pairing, confirms before saving credentials, and detaches while retaining records and source", async () => {
    const { runtime, call, dataDirectory, connections } = await fixture();
    expect((await fetch(`${runtime.baseUrl}/v1/browser/sources`)).status).toBe(401);
    const inspected = await call("/v1/browser/connect?account=default", "POST", { browser: "chrome" });
    expect(inspected.status).toBe(200); expect(inspected.body.candidate).toMatchObject({ uid: "123456", nickname: "合成账号", accountId: "default", newAccount: false });
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    const before = (await call("/v1/records")).body;
    const confirmed = await call("/v1/browser/confirm?account=default", "POST", { id: inspected.body.candidate.id });
    expect(confirmed.status).toBe(200); expect(confirmed.body.status.browserSource).toEqual({ mode: "cdp", browser: "chrome", connected: false, credentials: "ready" });
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(confirmed.body.accounts[0].uid).toBe("123456");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "external-browser.json"), "utf8"))).toEqual({ browser: "chrome" });
    expect((await call("/v1/browser/disconnect?account=default", "POST")).body.status.browserSource.connected).toBe(false);
    expect(connections[0].disconnect).toHaveBeenCalledOnce(); expect((await call("/v1/records")).body).toEqual(before);
    expect((await call("/v1/status")).body.browserSource.mode).toBe("cdp");
    expect((await call("/v1/browser/independent?account=default", "POST")).status).toBe(404);
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").then(() => true, () => false)).toBe(true);
  });
  it("reports a failed first export as requiring reconnection and never reports imported credentials", async () => {
    const { call, dataDirectory, connections, bootstrap } = await fixture();
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    bootstrap.mockRejectedValueOnce(new Error("export failed"));
    const result = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(result.status).toBe(500);
    expect((await call("/v1/status")).body.browserSource).toMatchObject({ credentials: "reconnect_required", connected: false });
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect(connections[0].disconnect).toHaveBeenCalled();
  });
  it("rejects an account changing between preview and confirmation, without writing a session", async () => {
    const { call, identity, dataDirectory, connections } = await fixture();
    const inspected = await call("/v1/browser/connect", "POST", { browser: "chrome" }); identity.uid = "789";
    const confirmed = await call("/v1/browser/confirm", "POST", { id: inspected.body.candidate.id });
    expect(confirmed.status).toBe(409); expect(confirmed.body.error).toBe("account_mismatch");
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8").catch(() => null)).toBeNull();
    expect((await call("/v1/accounts")).body.accounts[0].uid).toBeNull();
  });
  it("keeps a different account's records separate and reuses the existing matching account", async () => {
    const { call, identity, dataDirectory } = await fixture();
    const first = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    await call("/v1/browser/confirm", "POST", { id: first.body.candidate.id });
    identity.uid = "789"; identity.nickname = "另一个合成账号";
    const next = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    expect(next.body.candidate.newAccount).toBe(true);
    const changed = await call("/v1/browser/confirm", "POST", { id: next.body.candidate.id });
    expect(changed.status).toBe(200); expect(changed.body.activeId).not.toBe("default"); expect(changed.body.accounts).toHaveLength(2);
    const otherId = changed.body.activeId;
    expect(JSON.parse(await readFile(path.join(dataDirectory, "direct-session.json"), "utf8")).uid).toBe("123456");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "accounts", otherId, "direct-session.json"), "utf8")).uid).toBe("789");
    identity.uid = "123456";
    const back = await call("/v1/browser/connect", "POST", { browser: "chrome" });
    expect(back.body.candidate).toMatchObject({ accountId: "default", newAccount: false });
    expect((await call("/v1/browser/confirm", "POST", { id: back.body.candidate.id })).body.activeId).toBe("default");
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
