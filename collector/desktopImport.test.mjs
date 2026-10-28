import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DESKTOP_USER_AGENT } from "./desktopClient.mjs";
import { startCollectorServer } from "./server.mjs";

const cleanup = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });

async function pair(runtime) {
  const value = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: runtime.getPairingCode() }) }).then((response) => response.json());
  return { Authorization: `Bearer ${value.token}`, "Content-Type": "application/json" };
}

it("lists the douyin desktop client as a login source without any browser", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-desktop-server-"));
  const desktopDirectory = await mkdtemp(path.join(tmpdir(), "dy-desktop-client-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  cleanup.push(() => rm(desktopDirectory, { recursive: true, force: true }));
  const runtime = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: true, desktopDirectory });
  cleanup.push(() => runtime.close());
  const headers = await pair(runtime);

  const sources = await fetch(`${runtime.baseUrl}/v1/browser/sources`, { headers }).then((response) => response.json());
  expect(sources.sources).toEqual([{ id: "desktop", label: "抖音桌面端", available: true, debugging: false, desktop: true }]);
});

it("identifies the desktop account and waits for confirmation like a browser import", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-desktop-connect-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const calls = [];
  const runtime = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: true,
    desktopConnector: async (source) => {
      calls.push(source.id);
      return { cookies: [{ name: "sessionid", value: "session-value", domain: ".douyin.com", path: "/" }],
        webid: "7272714522396821031", userAgent: DESKTOP_USER_AGENT,
        identity: { uid: "607350412292247", nickname: "桌面端账号", avatar: null, secUid: null } };
    } });
  cleanup.push(() => runtime.close());
  const headers = await pair(runtime);

  const connected = await fetch(`${runtime.baseUrl}/v1/browser/connect`, { method: "POST", headers,
    body: JSON.stringify({ browser: "desktop" }) }).then(async (response) => ({ status: response.status, body: await response.json() }));
  expect(connected.status).toBe(200);
  expect(calls).toEqual(["desktop"]);
  expect(connected.body.candidate).toMatchObject({ browser: "desktop", uid: "607350412292247", nickname: "桌面端账号",
    accountId: "default", newAccount: false, adoptable: false });
  expect(connected.body.candidate.id).toMatch(/^[0-9a-f-]{36}$/u);

  // 过期的确认 id 不会动到任何账号数据
  const stale = await fetch(`${runtime.baseUrl}/v1/browser/confirm`, { method: "POST", headers,
    body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", readPermissions: { videos: true, chat: false } }) });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "browser_candidate_expired" });

  // 取消待确认的桌面端导入不会报错，也不留连接
  const cancelled = await fetch(`${runtime.baseUrl}/v1/browser/pending`, { method: "DELETE", headers,
    body: JSON.stringify({ id: connected.body.candidate.id }) });
  expect(cancelled.status).toBe(200);
});

it("reports a readable message when the desktop client has no login data", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-desktop-missing-"));
  const desktopDirectory = await mkdtemp(path.join(tmpdir(), "dy-desktop-empty-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  cleanup.push(() => rm(desktopDirectory, { recursive: true, force: true }));
  const runtime = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: true, desktopDirectory });
  cleanup.push(() => runtime.close());
  const headers = await pair(runtime);
  const connected = await fetch(`${runtime.baseUrl}/v1/browser/connect`, { method: "POST", headers,
    body: JSON.stringify({ browser: "desktop" }) }).then(async (response) => ({ status: response.status, body: await response.json() }));
  // 客户端没装、没登录或正在写登录数据时，都要给出能照着做的提示
  expect(connected.status).toBe(409);
  expect(["desktop_not_installed", "desktop_key_failed", "desktop_cookie_locked", "desktop_login_required"]).toContain(connected.body.error);
});
