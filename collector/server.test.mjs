import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startCollectorServer } from "./server.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("collector server runtime", () => {
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
  });
});
