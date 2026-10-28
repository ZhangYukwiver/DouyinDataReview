import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { DouyinCollector } from "./douyinCollector.mjs";
import { CollectorStore } from "./store.mjs";
import { startCollectorServer } from "./server.mjs";

const cleanup = [];
afterEach(async () => { vi.restoreAllMocks(); for (const work of cleanup.splice(0).reverse()) await work(); });

it("never launches a browser when credentials are missing across all API entry points", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-cdp-only-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  await mkdir(path.join(dataDirectory, "browser-profile"));
  const profileFile = path.join(dataDirectory, "browser-profile", "preserve");
  await writeFile(profileFile, "old profile");
  const launch = vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(new Error("must not launch"));
  const collector = new DouyinCollector({ dataDirectory, store: new CollectorStore(dataDirectory) });
  await collector.initialize(); cleanup.push(() => collector.shutdown());
  const before = collector.getSnapshot();
  for (const mode of ["full_records", "direct_records"]) {
    expect(collector.startSync({ mode })).toBe(true); await collector.syncPromise;
    expect(collector.getStatus()).toMatchObject({ state: "error", code: "browser_reconnect_required" });
  }
  const recordsState = collector.getStatus().state;
  expect(collector.startChatObservation()).toBe(true); await collector.chatPromise;
  expect(collector.getStatus().chat).toMatchObject({ state: "error", code: "browser_reconnect_required" });
  expect(collector.getStatus().state).toBe(recordsState);
  await expect(collector.creatorCenter.read([{ key: "user_info" }])).rejects.toMatchObject({ code: "browser_reconnect_required" });
  await expect(collector.liveRooms.following()).rejects.toMatchObject({ code: "browser_reconnect_required" });
  await expect(collector.liveRooms.open("123")).rejects.toMatchObject({ code: "browser_reconnect_required" });
  const job = collector.startVideoDownload("https://www.douyin.com/video/1234567890");
  await collector.videoDownloadQueue;
  expect(collector.getVideoDownloadJob(job.id)).toMatchObject({ status: "failed", errorCode: "browser_reconnect_required" });
  expect(collector.getSnapshot()).toEqual(before); expect(collector.context).toBeNull();
  expect(await readFile(profileFile, "utf8")).toBe("old profile"); expect(launch).not.toHaveBeenCalled();
});

it("starts without a browser executable and rejects removed routes without altering records", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-no-browser-server-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const runtime = await startCollectorServer({ port: 0, dataDirectory, browserSources: [], desktopSupported: true });
  cleanup.push(() => runtime.close());
  const pair = await fetch(runtime.baseUrl + "/v1/pair", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(response => response.json());
  const headers = { Authorization: "Bearer " + pair.token, "Content-Type": "application/json" };
  const before = await fetch(runtime.baseUrl + "/v1/records", { headers }).then(response => response.json());
  for (const route of ["/v1/observe", "/v1/observe/stop", "/v1/browser/independent", "/v1/browser/close"]) {
    const response = await fetch(runtime.baseUrl + route, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: "not_found" });
  }
  expect(await fetch(runtime.baseUrl + "/v1/records", { headers }).then(response => response.json())).toEqual(before);
  // 没有浏览器可连时列表里只剩抖音桌面端：它读的是本机客户端，和浏览器无关
  const sources = await fetch(runtime.baseUrl + "/v1/browser/sources", { headers }).then((response) => response.json());
  expect(sources.sources.map((item) => item.id)).toEqual(["desktop"]);
  expect(sources).toMatchObject({ status: { browserSource: { mode: "cdp", credentials: "reconnect_required" } } });
});
