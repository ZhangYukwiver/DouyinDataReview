import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startStaticServer } from "./staticServer.mjs";
import { startStaticServer as startSourceStaticServer } from "../staticServer.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "content-insights-static-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Desktop fixture</title>");
  await writeFile(path.join(directory, "assets", "app.js"), "console.log('fixture');");
  return directory;
}

describe("desktop static server", () => {
  it("serves exported assets with security headers", async () => {
    const runtime = await startStaticServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const response = await fetch(`${runtime.url}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    await expect(response.text()).resolves.toContain("fixture");
  });

  it("falls back to the app shell only for HTML navigation", async () => {
    const runtime = await startStaticServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const navigation = await fetch(`${runtime.url}/annual/2025`, { headers: { Accept: "text/html" } });
    expect(navigation.status).toBe(200);
    await expect(navigation.text()).resolves.toContain("Desktop fixture");

    const missingAsset = await fetch(`${runtime.url}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
  });

  it.each([
    ["desktop", "/", startStaticServer],
    ["desktop", "/annual/2025", startStaticServer],
    ["source", "/", startSourceStaticServer],
    ["source", "/annual/2025", startSourceStaticServer],
  ])("allows collector media, images and video blobs for %s at %s", async (_entry, pathname, startServer) => {
    const runtime = await startServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const response = await fetch(`${runtime.url}${pathname}`, { headers: { Accept: "text/html" } });
    const directives = response.headers.get("content-security-policy").split(";").map((value) => value.trim().split(/\s+/u));
    expect(directives.find(([name]) => name === "media-src")).toEqual([
      "media-src", "'self'", "https:", "blob:", "http://127.0.0.1:*", "http://localhost:*",
    ]);
    // AI 剪辑素材库的图片和缩略图直接从采集器取（素材文件地址靠 key，不带 Bearer）
    expect(directives.find(([name]) => name === "img-src")).toEqual([
      "img-src", "'self'", "data:", "https:", "http://127.0.0.1:*", "http://localhost:*",
    ]);
    // HLS 播放器以 XHR 读直播清单和分片；只放行抖音直播 CDN。
    expect(directives.find(([name]) => name === "connect-src")).toEqual([
      "connect-src", "'self'", "http://127.0.0.1:*", "http://localhost:*", "https://douyincdn.com", "https://*.douyincdn.com",
    ]);
    expect(directives.find(([name]) => name === "script-src")).not.toContain("blob:");
  });
});

describe("story pages", () => {
  it("relaxes the policy only under /story so the inline prototype scripts run", async () => {
    const directory = await fixture();
    await mkdir(path.join(directory, "story"));
    await writeFile(path.join(directory, "story", "story-entry.html"), "<!doctype html><script>document.title = 1</script>");
    const runtime = await startStaticServer({ rootDirectory: directory });
    runtimes.push(runtime);

    const story = await fetch(`${runtime.url}/story/story-entry.html`);
    expect(story.status).toBe(200);
    expect(story.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(story.headers.get("content-security-policy")).toContain("fonts.googleapis.com");
    // 内容年志在应用内以同源 iframe 承载
    expect(story.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(story.headers.get("cache-control")).toBe("no-cache");

    const app = await fetch(`${runtime.url}/assets/app.js`);
    expect(app.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(app.headers.get("content-security-policy")).not.toContain("unsafe-inline';");
    // 整体风格选“内容年志”时应用本身也要取同一组 Google 字体
    expect(app.headers.get("content-security-policy")).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(app.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
