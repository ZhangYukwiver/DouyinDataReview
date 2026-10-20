import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DouyinCollector } from "./douyinCollector.mjs";
import { ExplorerBridge } from "./explorerBridge.mjs";
import { startCollectorServer } from "./server.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const exists = (target) => access(target).then(() => true, () => false);

// 只放进临时目录的合成记录，不碰真实数据
async function writeSyntheticRecords(directory) {
  await writeFile(path.join(directory, "records.json"), JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-10-01T00:00:00.000Z",
    records: {
      watch_history: [],
      liked_videos: [{ id: "liked_videos:1", title: "合成记录", author: null, occurredAt: null, url: "https://www.douyin.com/video/1" }],
      favorite_videos: [],
    },
    chatMessages: [],
    chatConversations: [],
    warnings: [],
  }));
}

async function startPaired(prefix, prepare) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dataDirectory);
  await prepare?.(dataDirectory);
  const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
  runtimes.push(runtime);
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
  }).then((response) => response.json());
  const call = async (pathname, method = "GET") => {
    const response = await fetch(`${runtime.baseUrl}${pathname}`, { method, headers: { Authorization: `Bearer ${paired.token}` } });
    return { status: response.status, body: await response.json() };
  };
  return { dataDirectory, runtime, call, headers: { Authorization: `Bearer ${paired.token}` } };
}

describe("collector accounts", () => {
  it("keeps each account's login and records apart and switches without deleting anything", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-switch-", async (directory) => {
      await writeSyntheticRecords(directory);
      await mkdir(path.join(directory, "direct-signer"), { recursive: true });
      await writeFile(path.join(directory, "direct-signer", "signer.js"), "// signer");
      await mkdir(path.join(directory, "backups"), { recursive: true });
      await writeFile(path.join(directory, "backups", "old.json"), "{}");
      await writeFile(path.join(directory, "launcher-error.txt"), "");
    });
    expect((await fetch(`${runtime.baseUrl}/v1/accounts`)).status).toBe(401);
    const initial = await call("/v1/accounts");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ activeId: "default", accounts: [{ id: "default", nickname: null, avatar: null, uid: null }] });
    expect(initial.body.accounts).toHaveLength(1);
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    const before = (await call("/v1/status")).body;
    expect(before.account).toEqual({ id: "default", nickname: null, avatar: null });

    // 工作台一直挂着状态长轮询；切换时它要直接拿到新账号的状态
    let settled = false;
    const polling = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${before.revision}`, { headers })
      .then((response) => response.json()).then((status) => { settled = true; return status; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);

    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const newId = created.body.activeId;
    expect(newId).toMatch(/^[0-9a-f]{12}$/u);
    expect(created.body.accounts.map((account) => account.id)).toEqual(["default", newId]);
    expect(created.body.status.account).toEqual({ id: newId, nickname: null, avatar: null });
    expect(created.body.status.revision).toBeGreaterThan(before.revision);
    const polled = await polling;
    expect(polled.account.id).toBe(newId);
    expect(polled.revision).toBeGreaterThan(before.revision);
    expect((await stat(path.join(dataDirectory, "accounts", newId))).isDirectory()).toBe(true);
    expect((await call("/v1/records")).body.records.liked_videos).toEqual([]);
    expect((await call("/v1/status")).body.account.id).toBe(newId);

    const back = await call("/v1/accounts/default/activate", "POST");
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ activeId: "default", status: { account: { id: "default" } } });
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    const again = await call("/v1/accounts/default/activate", "POST");
    expect(again.status).toBe(200);
    expect(again.body.status.revision).toBe(back.body.status.revision);

    const activeDelete = await call("/v1/accounts/default", "DELETE");
    expect(activeDelete.status).toBe(409);
    expect(activeDelete.body.error).toBe("account_active");

    const removed = await call(`/v1/accounts/${newId}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ activeId: "default", accounts: [{ id: "default" }] });
    expect(removed.body.accounts).toHaveLength(1);
    expect(await exists(path.join(dataDirectory, "accounts", newId))).toBe(false);
    for (const name of ["direct-signer/signer.js", "backups/old.json", "launcher-error.txt", "records.json"]) {
      expect(await exists(path.join(dataDirectory, name))).toBe(true);
    }
    expect((await call(`/v1/accounts/${newId}/activate`, "POST")).body.error).toBe("account_not_found");
  });

  it("deletes only the default account's own entries from the shared folder", async () => {
    const { dataDirectory, call } = await startPaired("accounts-default-", async (directory) => {
      await writeSyntheticRecords(directory);
      for (const name of ["browser-profile/Default", "direct-signer", "backups"]) await mkdir(path.join(directory, name), { recursive: true });
      for (const name of ["browser-profile/Default/Cookies", "records.json.123.tmp", "direct-history-template.json", "direct-signer/signer.js", "backups/old.json", "launcher-error.txt", "notes.txt"]) {
        await writeFile(path.join(directory, name), "x");
      }
    });
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const removed = await call("/v1/accounts/default", "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ activeId: created.body.activeId, accounts: [{ id: created.body.activeId }] });
    expect((await readdir(dataDirectory)).sort()).toEqual(["accounts", "accounts.json", "backups", "direct-signer", "launcher-error.txt", "notes.txt"]);
    expect(await exists(path.join(dataDirectory, "direct-signer", "signer.js"))).toBe(true);
  });

  it("rejects malformed account ids without touching the file system", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-ids-", async (directory) => {
      await writeSyntheticRecords(directory);
      await mkdir(path.join(directory, "x"), { recursive: true });
      await writeFile(path.join(directory, "x", "keep.txt"), "keep");
    });
    const listing = (await readdir(dataDirectory)).sort();
    const registry = await readFile(path.join(dataDirectory, "accounts.json"), "utf8");
    for (const [pathname, method] of [
      ["/v1/accounts/..%2Fx", "DELETE"],
      ["/v1/accounts/..%2Fx/activate", "POST"],
      ["/v1/accounts/ABCDEF012345", "DELETE"],
      ["/v1/accounts/0123456789ab", "DELETE"],
      ["/v1/accounts/0123456789ab/activate", "POST"],
    ]) {
      const result = await call(pathname, method);
      expect(result.status, pathname).toBe(404);
      expect(result.body.error, pathname).toBe("account_not_found");
    }
    // ../ 和编码过的 %2E%2E 会被 URL 规整掉，到不了账号路由
    for (const pathname of ["/v1/accounts/../x", "/v1/accounts/%2E%2E", "/v1/accounts/%2e%2e/activate"]) {
      expect((await fetch(`${runtime.baseUrl}${pathname}`, { method: "DELETE", headers })).status, pathname).toBe(404);
    }
    expect((await readdir(dataDirectory)).sort()).toEqual(listing);
    expect(await readFile(path.join(dataDirectory, "x", "keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(dataDirectory, "accounts.json"), "utf8")).toBe(registry);
  });

  it("writes the nickname and avatar read from the page back to the account list", async () => {
    const opened = [];
    const initialize = DouyinCollector.prototype.initialize;
    const spy = vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () {
      opened.push(this);
      return initialize.call(this);
    });
    try {
      const { dataDirectory, call } = await startPaired("accounts-identity-");
      const avatar = "https://p3-pc-sign.douyinpic.com/aweme/100x100/me.jpeg";
      await opened.at(-1).assertAccountMatches({ evaluate: async () => ({ uid: "123456789012345", secUid: "MS4w-me", nickname: "我", avatar }) });
      // 状态里出现新昵称时，名单已经落盘
      await vi.waitFor(async () => expect((await call("/v1/status")).body.account).toEqual({ id: "default", nickname: "我", avatar }));
      expect((await call("/v1/accounts")).body.accounts[0]).toMatchObject({
        id: "default", nickname: "我", avatar, uid: "123456789012345",
      });
      // 重开采集服务也还认得
      const restarted = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      runtimes.push(restarted);
      expect(opened.at(-1).getStatus().account).toEqual({ id: "default", nickname: "我", avatar });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to switch while records are being read or another account operation runs", async () => {
    let finishRun;
    const runSync = vi.spyOn(DouyinCollector.prototype, "runDirectRecords").mockImplementation(() => new Promise((resolve) => { finishRun = resolve; }));
    try {
      const { call } = await startPaired("accounts-busy-");
      expect((await call("/v1/sync", "POST")).status).toBe(202);
      const refused = await call("/v1/accounts", "POST");
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: "collector_busy", message: expect.stringContaining("读取") });
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(1);
      finishRun();
      for (let attempt = 0; attempt < 50 && (await call("/v1/status")).body.syncMode !== null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // 同时点两次只建一个
      const [first, second] = await Promise.all([call("/v1/accounts", "POST"), call("/v1/accounts", "POST")]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect([first, second].find((result) => result.status === 409).body.error).toBe("collector_busy");
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(2);
    } finally {
      runSync.mockRestore();
    }
  });
});

describe("collector account switching edge cases", () => {
  it("stays on the current account with a reset status when the switch fails, and says which action failed", async () => {
    const opened = [];
    let failOpen = false;
    const initialize = DouyinCollector.prototype.initialize;
    const spy = vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () {
      opened.push(this);
      if (opened.length === 4 || failOpen) throw new Error("disk full");
      return initialize.call(this);
    });
    try {
      const { call } = await startPaired("accounts-switch-failed-", writeSyntheticRecords);
      const created = await call("/v1/accounts", "POST");
      expect(created.status).toBe(201);
      const newId = created.body.activeId;
      expect((await call("/v1/accounts/default/activate", "POST")).status).toBe(200);
      // 新建时初始化失败
      const failedAdd = await call("/v1/accounts", "POST");
      expect(failedAdd).toMatchObject({ status: 500, body: { error: "account_switch_failed", message: "没能添加账号，请稍后再试。" } });
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(2);

      // 目标账号打不开；当前账号正在“接收”时被静默收掉，状态要复位
      failOpen = true;
      opened.at(-1).updateStatus({ state: "observing", message: "正在监听手动浏览", browserOpen: true });
      const failedSwitch = await call(`/v1/accounts/${newId}/activate`, "POST");
      expect(failedSwitch).toMatchObject({ status: 500, body: { error: "account_switch_failed", message: "没能切换账号，请稍后再试。" } });
      expect((await call("/v1/status")).body).toMatchObject({
        state: "idle", browserOpen: false, message: "没能切换账号，已留在原账号。", account: { id: "default" },
      });
      expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a paired session alive while it is used and expires it after 12 idle hours", async () => {
    const { call } = await startPaired("pairing-idle-");
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    try {
      for (const hours of [11, 22, 33]) {
        now.mockReturnValue(start + hours * 3_600_000);
        expect((await call("/v1/status")).status).toBe(200);
      }
      now.mockReturnValue(start + 45.5 * 3_600_000);
      expect((await call("/v1/status")).body.error).toBe("not_paired");
    } finally {
      now.mockRestore();
    }
  });

  it("leaves records alone when a stale window clears or merges for an account that is no longer active", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-stale-", writeSyntheticRecords);
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const newId = created.body.activeId;
    await writeSyntheticRecords(path.join(dataDirectory, "accounts", newId));
    await call(`/v1/accounts/default/activate`, "POST");
    // 另一个窗口切到了新账号，这个窗口还以为在用 default
    expect((await call(`/v1/accounts/${newId}/activate`, "POST")).status).toBe(200);

    const cleared = await call("/v1/records?account=default", "DELETE");
    expect(cleared).toMatchObject({ status: 409, body: { error: "account_changed" } });
    const merged = await fetch(`${runtime.baseUrl}/v1/records/import?account=default`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ records: {} }),
    });
    expect(merged.status).toBe(409);
    expect((await merged.json()).error).toBe("account_changed");
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);

    // 带的是当前账号，或者老版本不带，都照常清
    expect((await call(`/v1/records?account=${newId}`, "DELETE")).status).toBe(200);
    expect((await call("/v1/records")).body.records.liked_videos).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "records.json"), "utf8")).records.liked_videos).toHaveLength(1);
  });

  it("does not merge an upload into the account that was switched to while it uploaded", async () => {
    const { runtime, call, headers } = await startPaired("accounts-import-");
    let upload;
    const body = new ReadableStream({ start(controller) { upload = controller; } });
    const importing = fetch(`${runtime.baseUrl}/v1/records/import`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body, duplex: "half",
    });
    upload.enqueue(new TextEncoder().encode('{"schemaVersion":2,'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await call("/v1/accounts", "POST")).status).toBe(201);
    upload.enqueue(new TextEncoder().encode('"records":{}}'));
    upload.close();
    const response = await importing;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("collector_busy");
  });
});

describe("collector server runtime", () => {
  it("keeps explore tabs such as open comments for a playback job and an explore-page download, but not for other saved downloads", async () => {
    const close = vi.spyOn(ExplorerBridge.prototype, "close");
    try {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "playback-explore-"));
      temporaryDirectories.push(dataDirectory);
      const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      runtimes.push(runtime);
      const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
      }).then((response) => response.json());
      const post = (body) => fetch(`${runtime.baseUrl}/v1/downloads`, {
        method: "POST", headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await post({ url: "https://www.douyin.com/video/1234567890", playback: true })).status).toBe(202);
      expect(close).not.toHaveBeenCalled();
      await post({ url: "https://www.douyin.com/video/1234567891", keepExplore: true });
      expect(close).not.toHaveBeenCalled();
      await post({ url: "https://www.douyin.com/video/1234567892" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
  });

  it("keeps a chat failure out of the record-reading state and still accepts a direct read", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "chat-independent-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
    runtimes.push(runtime);
    const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
    }).then((response) => response.json());
    const headers = { Authorization: `Bearer ${paired.token}` };
    const readStatus = () => fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json());

    const started = await fetch(`${runtime.baseUrl}/v1/chat/observe`, { method: "POST", headers });
    expect(started.status).toBe(202);
    let status = await readStatus();
    for (let attempt = 0; attempt < 50 && status.chat.state !== "error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      status = await readStatus();
    }
    // 接收起不来只写它自己那份状态，工作台其他部分不该跟着进错误态
    expect(status.chat.state).toBe("error");
    expect(status.state).toBe("idle");

    const direct = await fetch(`${runtime.baseUrl}/v1/experimental/records-direct`, { method: "POST", headers });
    expect(direct.status).toBe(202);
    expect((await direct.json()).status.syncMode).toBe("direct_records");
  });

  it("waits for a status revision without polling, authenticates, and releases aborted clients", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "chat-live-status-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
    runtimes.push(runtime);
    const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
    }).then((response) => response.json());
    const headers = { Authorization: `Bearer ${paired.token}` };
    const initial = await fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json());
    expect(Number.isSafeInteger(initial.revision)).toBe(true);
    expect((await fetch(`${runtime.baseUrl}/v1/status?afterRevision=${initial.revision}`)).status).toBe(401);
    expect((await fetch(`${runtime.baseUrl}/v1/status?afterRevision=invalid`, { headers })).status).toBe(400);
    let settled = false;
    const pending = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${initial.revision}`, { headers })
      .then((response) => response.json()).then((status) => { settled = true; return status; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    // This server owns an empty temporary store; no real records are touched.
    await fetch(`${runtime.baseUrl}/v1/records`, { method: "DELETE", headers });
    const changed = await pending;
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(changed.message).toBe("本地记录已清除");
    const ahead = await fetch(`${runtime.baseUrl}/v1/status?afterRevision=999999`, { headers }).then((response) => response.json());
    expect(ahead.revision).toBe(changed.revision);
    const controller = new AbortController();
    const aborted = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${changed.revision}`, { headers, signal: controller.signal });
    const rejected = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  });

  it("shuts down promptly while a client keeps long-polling the status", async () => {
    // 关浏览器要一会儿；这段时间里工作台会再发一次长轮询，关服务时它还挂着
    const closeCollector = DouyinCollector.prototype.close;
    const slowClose = vi.spyOn(DouyinCollector.prototype, "close").mockImplementation(async function () {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return closeCollector.call(this);
    });
    try {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "status-shutdown-"));
      temporaryDirectories.push(dataDirectory);
      const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
      }).then((response) => response.json());
      const headers = { Authorization: `Bearer ${paired.token}` };
      // 和工作台一样：一次长轮询回来就立刻发下一次，直到连不上为止
      const polling = (async () => {
        let revision = (await fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json())).revision;
        for (;;) {
          const status = await fetch(`${runtime.baseUrl}/v1/status?afterRevision=${revision}`, { headers })
            .then((response) => response.json()).catch(() => null);
          if (!status) return;
          revision = status.revision;
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      await runtime.close();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await polling;
    } finally {
      slowClose.mockRestore();
    }
  }, 15_000);

  it("supports an ephemeral desktop port and pairing", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "content-insights-collector-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({
      port: 0,
      dataDirectory,
      executablePath: process.execPath,
    });
    runtimes.push(runtime);

    expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const health = await fetch(`${runtime.baseUrl}/v1/health`);
    await expect(health.json()).resolves.toEqual({ ok: true, version: 1 });

    const pairingCodeResponse = await fetch(`${runtime.baseUrl}/v1/pairing-code`);
    const pairingCodePayload = await pairingCodeResponse.json();
    expect(pairingCodeResponse.status).toBe(200);
    expect(pairingCodePayload).toEqual({ code: runtime.getPairingCode() });

    const pairingCode = pairingCodePayload.code;
    const pairing = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const payload = await pairing.json();
    expect(pairing.status).toBe(200);
    expect(payload.token).toHaveLength(43);
    expect(runtime.getPairingCode()).not.toBe(pairingCode);

    const stopSync = await fetch(`${runtime.baseUrl}/v1/sync/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    expect(stopSync.status).toBe(200);
    await expect(stopSync.json()).resolves.toMatchObject({
      stopped: false,
      status: { state: "idle" },
    });

    const unauthenticatedDownload = await fetch(`${runtime.baseUrl}/v1/downloads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://v.douyin.com/example/" }),
    });
    expect(unauthenticatedDownload.status).toBe(401);

    for (const operation of ["read", "interact"]) {
      const unauthorized = await fetch(`${runtime.baseUrl}/v1/explore/${operation}`, { method: "POST" });
      expect(unauthorized.status).toBe(401);
      const invalid = await fetch(`${runtime.baseUrl}/v1/explore/${operation}`, {
        method: "POST", headers: { Authorization: `Bearer ${payload.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "unsupported" }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_request" });
    }

    const invalidDownload = await fetch(`${runtime.baseUrl}/v1/downloads`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${payload.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/video/1" }),
    });
    expect(invalidDownload.status).toBe(400);
    await expect(invalidDownload.json()).resolves.toMatchObject({ error: "invalid_url" });

    const unknownDownload = await fetch(`${runtime.baseUrl}/v1/downloads/not-a-valid-job`, {
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    expect(unknownDownload.status).toBe(404);
    await expect(unknownDownload.json()).resolves.toMatchObject({ error: "download_job_not_found" });

    const releaseUrl = `${runtime.baseUrl}/v1/downloads/12345678-1234-1234-1234-123456789abc`;
    expect((await fetch(releaseUrl, { method: "DELETE" })).status).toBe(401);
    const release = await fetch(releaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${payload.token}` } });
    expect(release.status).toBe(200);
    await expect(release.json()).resolves.toEqual({ ok: true });

    // <video> sends no session header: a stream is gated by its per-job key alone.
    const stream = await fetch(`${releaseUrl}/stream?key=guess`);
    expect(stream.status).toBe(404);
    await expect(stream.json()).resolves.toEqual({ error: "download_job_not_found" });
  });
});

describe("collector AI edit routes", () => {
  const fixture = fileURLToPath(new URL("fixtures/ai-edit/media/clip-720p.mp4", import.meta.url));

  it("keeps AI edit behind pairing except key-protected media files, and stores everything under ai-edit/", async () => {
    // 草稿箱指到临时目录，不碰本机真实的剪映草稿
    vi.stubEnv("JY_JIANYING_DRAFTS_ROOT", await mkdtemp(path.join(tmpdir(), "ai-edit-drafts-")));
    temporaryDirectories.push(process.env.JY_JIANYING_DRAFTS_ROOT);
    try {
      const { dataDirectory, runtime, call, headers } = await startPaired("ai-edit-routes-");
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/sessions`)).status).toBe(401);
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/media`)).status).toBe(401);
      expect(await call("/v1/ai-edit/sessions")).toEqual({ status: 200, body: { sessions: [] } });

      const bytes = await readFile(fixture);
      const uploaded = await fetch(`${runtime.baseUrl}/v1/ai-edit/media/upload?name=clip.mp4`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes });
      expect(uploaded.status).toBe(201);
      const { item } = await uploaded.json();
      expect(item).toMatchObject({ kind: "video", status: "ready", durationUs: 3_000_000, width: 1280, height: 720, hasAudio: true });
      const { key } = (await call("/v1/ai-edit/media")).body;
      const fileUrl = `${runtime.baseUrl}/v1/ai-edit/media/${item.id}/file?key=${encodeURIComponent(key)}`;
      const file = await fetch(fileUrl, { headers: { Range: "bytes=0-9" } });
      expect(file.status).toBe(206);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes.subarray(0, 10));
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/media/${item.id}/file?key=nope`)).status).toBe(404);
      // 看板取缩略图用 <video crossOrigin="anonymous">：本机页面（开发服、打包版的静态服务）要拿到 CORS 头，画布才不被污染；
      // 别的来源照旧拒绝，也不回通配符
      const local = await fetch(fileUrl, { headers: { Origin: "http://127.0.0.1:8099", Range: "bytes=0-9" } });
      expect(local.status).toBe(206);
      expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8099");
      expect(local.headers.get("vary")).toBe("Origin");
      await local.arrayBuffer();
      const full = await fetch(fileUrl, { headers: { Origin: "http://localhost:8081" } });
      expect(full.status).toBe(200);
      expect(full.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
      await full.arrayBuffer();
      const foreign = await fetch(fileUrl, { headers: { Origin: "https://example.com" } });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
      await foreign.arrayBuffer();

      const created = await fetch(`${runtime.baseUrl}/v1/ai-edit/sessions`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "测试剪辑" }) });
      expect(created.status).toBe(201);
      const { session, project } = await created.json();
      expect(project).toMatchObject({ name: "测试剪辑", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [] });
      expect(await exists(path.join(dataDirectory, "ai-edit", "sessions", `${session.id}.json`))).toBe(true);
      expect(await exists(path.join(dataDirectory, "ai-edit", "media", `${item.id}.mp4`))).toBe(true);
      expect((await readdir(path.join(dataDirectory, "ai-edit", "projects"))).some((name) => name.startsWith(project.id))).toBe(true);
      expect((await call("/v1/ai-edit/draft-box")).body).toMatchObject({ status: expect.stringMatching(/^(?:available|unavailable)$/u), jianyingRunning: expect.any(Boolean) });
      expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, "POST")).body.error).toMatch(/^(?:project_empty|draft_box_unavailable)$/u);

      // 关服务时页面还挂着会话长轮询，也要马上关掉
      const polling = fetch(`${runtime.baseUrl}/v1/ai-edit/sessions/${session.id}?afterRevision=${session.revision}`, { headers }).then((response) => response.status).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const startedAt = Date.now();
      await runtime.close();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect([200, null]).toContain(await polling);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);

  it("keeps working while the account switches, but waits to download from Douyin", async () => {
    let releaseSwitch;
    const initialize = DouyinCollector.prototype.initialize;
    let calls = 0;
    const spy = vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () {
      calls += 1;
      if (calls === 2) await new Promise((resolve) => { releaseSwitch = resolve; });
      return initialize.call(this);
    });
    try {
      const { runtime, call, headers } = await startPaired("ai-edit-switch-");
      const switching = call("/v1/accounts", "POST");
      await vi.waitFor(() => expect(releaseSwitch).toBeTypeOf("function"));
      expect((await call("/v1/records")).body.error).toBe("collector_busy");
      expect((await call("/v1/ai-edit/sessions")).status).toBe(200);
      const download = await fetch(`${runtime.baseUrl}/v1/ai-edit/media/douyin`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://www.douyin.com/video/1234567890" }) });
      expect(download.status).toBe(409);
      expect(await download.json()).toMatchObject({ error: "collector_busy", message: "正在切换账号，请稍等。" });
      releaseSwitch();
      expect((await switching).status).toBe(201);
    } finally {
      releaseSwitch?.();
      spy.mockRestore();
    }
  });
});
