import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("collector server runtime", () => {
  it("keeps explore tabs such as open comments for a playback job, but not for a saved download", async () => {
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
      await post({ url: "https://www.douyin.com/video/1234567891" });
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
