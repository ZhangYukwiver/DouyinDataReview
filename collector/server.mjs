#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access, chmod, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { DouyinCollector } from "./douyinCollector.mjs";
import { ExplorerBridge } from "./explorerBridge.mjs";
import { CollectorStore } from "./store.mjs";

const DEFAULT_PORT = 4765;
const MAX_BODY_BYTES = 4 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_JOB_ID_PATTERN = /^[0-9a-f-]{20,}$/iu;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

function parseArguments(argv) {
  const options = { lan: false, port: DEFAULT_PORT, origins: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--lan") options.lan = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--origin") options.origins.push(argv[++index]);
    else throw new Error(`未知参数: ${argument}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new Error("--port 必须是 1024 到 65535 之间的整数。");
  }
  if (options.origins.some((origin) => typeof origin !== "string" || !/^https?:\/\//u.test(origin))) {
    throw new Error("--origin 必须是完整的 http(s) 来源地址。");
  }
  return options;
}

function printHelp() {
  console.log(`用法: npm run collector -- [选项]

选项:
  --port <端口>       本地 API 端口，默认 ${DEFAULT_PORT}
  --lan               允许同一局域网内的手机连接
  --origin <地址>     允许的 Web 来源；可重复指定
  -h, --help          显示帮助

默认只监听 127.0.0.1。手机连接时使用 --lan，并在防火墙中仅允许专用网络。`);
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard browser location.
    }
  }
  return null;
}

// Any Chromium-based browser works: the collector drives it over CDP with its own profile.
// Preference order is Chrome, Edge (bundled with Windows), Brave, Chromium, then Playwright's cache.
const CHROMIUM_BROWSERS = {
  darwin: [
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Chromium.app/Contents/MacOS/Chromium",
    "Comet.app/Contents/MacOS/Comet",
  ],
  win32: [
    "Google/Chrome/Application/chrome.exe",
    "Microsoft/Edge/Application/msedge.exe",
    "BraveSoftware/Brave-Browser/Application/brave.exe",
    "Chromium/Application/chrome.exe",
  ],
  linux: ["google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser", "chromium", "chromium-browser"],
};

function browserRoots() {
  if (process.platform === "win32") return [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
  if (process.platform === "darwin") return ["/Applications", path.join(homedir(), "Applications")];
  return ["/usr/bin"];
}

async function findChromeExecutable() {
  const roots = browserRoots().filter(Boolean);
  const installed = (CHROMIUM_BROWSERS[process.platform] ?? []).flatMap((relative) => roots.map((root) => path.join(root, relative)));
  return firstExistingPath([process.env.DOUYIN_CHROME_PATH, ...installed, chromium.executablePath()]);
}

function localLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function isLoopbackAddress(value) {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function constantTimeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

class PairingManager {
  constructor() {
    this.sessions = new Map();
    this.code = this.createCode();
    this.attempts = new Map();
  }

  createCode() {
    return String(randomInt(10_000_000, 100_000_000));
  }

  displayCode() {
    return this.code;
  }

  allowAttempt(address) {
    const now = Date.now();
    const recent = (this.attempts.get(address) ?? []).filter((timestamp) => now - timestamp < 60_000);
    recent.push(now);
    this.attempts.set(address, recent);
    return recent.length <= 5;
  }

  pair(code) {
    if (!constantTimeStringEqual(code, this.code)) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    this.code = this.createCode();
    return token;
  }

  authorize(header) {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    const expiry = this.sessions.get(token);
    if (!expiry || expiry <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
}

function isAllowedOrigin(origin, explicitOrigins) {
  if (!origin) return true;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(origin)) return true;
  return explicitOrigins.includes(origin);
}

function applyHeaders(response, origin) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function sendVideoFile(response, filePath, fileName) {
  let file;
  try {
    file = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: "download_file_not_found" });
    return;
  }
  if (!file.isFile()) {
    sendJson(response, 404, { error: "download_file_not_found" });
    return;
  }
  const safeName = String(fileName || "douyin-video.mp4")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_")
    .slice(0, 180) || "douyin-video.mp4";
  response.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": file.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "no-store",
  });
  const stream = createReadStream(filePath);
  stream.once("error", () => response.destroy());
  stream.pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startCollectorServer({
  lan = false,
  port = DEFAULT_PORT,
  origins = [],
  dataDirectory = path.join(projectDirectory, ".local-data"),
  signerDirectory,
  executablePath: configuredExecutablePath,
} = {}) {
  const options = { lan, port, origins };
  const executablePath = configuredExecutablePath ?? await findChromeExecutable();
  if (!executablePath) {
    throw new Error("未找到 Chrome、Edge、Brave 或 Chromium 浏览器。可通过 DOUYIN_CHROME_PATH 指定浏览器路径。");
  }

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const store = new CollectorStore(dataDirectory);
  const collector = new DouyinCollector({ executablePath, dataDirectory, signerDirectory, store });
  const explorer = new ExplorerBridge(collector);
  await collector.initialize();
  const pairing = new PairingManager();
  const bindAddress = options.lan ? "0.0.0.0" : "127.0.0.1";
  const statusWaiters = new Set();

  const waitForStatus = (response, revision) => {
    let timer;
    let unsubscribe = () => undefined;
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      statusWaiters.delete(finish);
      response.off("close", cleanup);
    };
    const finish = (status = collector.getStatus()) => {
      cleanup();
      if (!response.destroyed && !response.writableEnded) sendJson(response, 200, status);
    };
    unsubscribe = collector.subscribeStatus(finish);
    statusWaiters.add(finish);
    response.once("close", cleanup);
    timer = setTimeout(finish, 8_000);
    const status = collector.getStatus();
    if (status.revision !== revision) finish(status);
  };

  const server = createServer(async (request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (!isAllowedOrigin(origin, options.origins)) {
      applyHeaders(response, "");
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    applyHeaders(response, origin);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      sendJson(response, 200, { ok: true, version: 1 });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/pairing-code") {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!isLoopbackAddress(remoteAddress)) {
        sendJson(response, 403, { error: "pairing_code_local_only" });
        return;
      }
      sendJson(response, 200, { code: pairing.displayCode() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pair") {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!pairing.allowAttempt(remoteAddress)) {
        sendJson(response, 429, { error: "too_many_attempts" });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const token = pairing.pair(body.code);
        if (!token) {
          sendJson(response, 401, { error: "invalid_pairing_code" });
          return;
        }
        sendJson(response, 200, { token, expiresInSeconds: SESSION_TTL_MS / 1000 });
        console.log(`新的配对码: ${pairing.displayCode()}`);
      } catch {
        sendJson(response, 400, { error: "invalid_request" });
      }
      return;
    }

    if (!pairing.authorize(request.headers.authorization)) {
      sendJson(response, 401, { error: "not_paired" });
      return;
    }

    if (request.method === "POST" && ["/v1/sync", "/v1/experimental/records-direct", "/v1/observe", "/v1/chat/observe", "/v1/downloads", "/v1/account/switch", "/v1/browser/close"].includes(url.pathname)) {
      if (explorer.busy) {
        sendJson(response, 409, { error: "collector_busy", message: "请等待当前探索操作完成后继续。" });
        return;
      }
      // Release only the adapter's tabs before invoking an original workflow.
      await explorer.close();
    }

    if (request.method === "POST" && ["/v1/explore/read", "/v1/explore/interact", "/v1/explore/video", "/v1/explore/close"].includes(url.pathname)) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once("close", abort);
      try {
        const body = await readJsonBody(request);
        const operation = url.pathname.split("/").at(-1);
        if (operation === "close") {
          if (!Array.isArray(body.sessionIds)) { sendJson(response, 400, { error: "invalid_request" }); return; }
          await explorer.close(body.sessionIds);
          sendJson(response, 200, { ok: true });
        } else {
          const result = await explorer.run(body, operation, controller.signal);
          if (operation === "video") {
            response.once("close", () => void result.dispose());
            if (controller.signal.aborted) await result.dispose();
            else await sendVideoFile(response, result.filePath, result.fileName);
          } else if (!response.destroyed) sendJson(response, 200, result);
        }
      } catch (error) {
        if (!response.destroyed) sendJson(response, error?.status ?? (error instanceof SyntaxError ? 400 : 409), {
          error: error?.code ?? "explore_failed",
          message: error?.code ? error.message : "页面读取失败，请检查抖音浏览器后重试。",
        });
      } finally { response.off("close", abort); }
    } else if (request.method === "POST" && url.pathname === "/v1/downloads") {
      try {
        const body = await readJsonBody(request);
        const job = collector.startVideoDownload(body?.url, { playback: body?.playback === true });
        sendJson(response, 202, { job });
      } catch (error) {
        const code = ["invalid_url", "collector_busy"].includes(error?.code) ? error.code : "download_start_failed";
        sendJson(response, code === "invalid_url" ? 400 : 409, {
          error: code,
          message: error instanceof Error ? error.message : "无法开始视频下载。",
        });
      }
    } else if (request.method === "DELETE" && /^\/v1\/downloads\/[0-9a-f-]{20,}$/iu.test(url.pathname)) {
      const released = collector.releaseVideoPlayback(url.pathname.split("/").at(-1));
      sendJson(response, released ? 200 : 409, released ? { ok: true } : { error: "not_playback_job" });
    } else if (request.method === "GET" && /^\/v1\/downloads\/[^/]+(?:\/file)?$/u.test(url.pathname)) {
      const match = url.pathname.match(/^\/v1\/downloads\/([^/]+)(\/file)?$/u);
      let jobId = "";
      try {
        jobId = match ? decodeURIComponent(match[1]) : "";
      } catch {
        sendJson(response, 404, { error: "download_job_not_found" });
        return;
      }
      if (!DOWNLOAD_JOB_ID_PATTERN.test(jobId)) {
        sendJson(response, 404, { error: "download_job_not_found" });
        return;
      }
      const job = collector.getVideoDownloadJob(jobId);
      if (!job) {
        sendJson(response, 404, { error: "download_job_not_found" });
      } else if (match?.[2] === "/file") {
        if (job.status !== "complete") {
          sendJson(response, 409, { error: "download_not_complete", job });
          return;
        }
        const filePath = collector.getVideoDownloadFilePath(jobId);
        if (!filePath) {
          sendJson(response, 404, { error: "download_file_not_found" });
          return;
        }
        await sendVideoFile(response, filePath, job.fileName);
      } else {
        sendJson(response, 200, { job });
      }
    } else if (request.method === "GET" && url.pathname === "/v1/status") {
      const requestedRevision = url.searchParams.get("afterRevision");
      if (requestedRevision === null) sendJson(response, 200, collector.getStatus());
      else if (!/^\d+$/u.test(requestedRevision) || !Number.isSafeInteger(Number(requestedRevision))) {
        sendJson(response, 400, { error: "invalid_revision" });
      } else waitForStatus(response, Number(requestedRevision));
    } else if (request.method === "GET" && url.pathname === "/v1/records") {
      sendJson(response, 200, collector.getSnapshot());
    } else if (request.method === "POST" && url.pathname === "/v1/sync") {
      const started = collector.startSync();
      sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/sync/stop") {
      const stopped = collector.stopSync();
      sendJson(response, 200, { stopped, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/experimental/records-direct") {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: "loopback_only" });
        return;
      }
      const started = collector.startDirectRecords();
      sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/observe") {
      const started = collector.startObservation();
      sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/chat/observe") {
      const started = collector.startChatObservation();
      sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/observe/stop") {
      const stopped = await collector.stopObservation();
      sendJson(response, 200, { stopped, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/chat/observe/stop") {
      const stopped = await collector.stopObservation();
      sendJson(response, 200, { stopped, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/account/switch") {
      try {
        const started = await collector.switchAccount();
        sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
      } catch {
        sendJson(response, 500, { error: "account_switch_failed" });
      }
    } else if (request.method === "DELETE" && url.pathname === "/v1/records") {
      sendJson(response, 200, await collector.clearRecords());
    } else if (request.method === "POST" && url.pathname === "/v1/browser/close") {
      await collector.close();
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { error: "not_found" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, bindAddress, resolve);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const finish of statusWaiters) finish();
    try {
      await explorer.close();
      await collector.close();
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };

  const address = server.address();
  if (!address || typeof address === "string") {
    await shutdown();
    throw new Error("采集服务未能分配 TCP 端口。");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDirectory,
    getPairingCode: () => pairing.displayCode(),
    close: shutdown,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runtime = await startCollectorServer(options);
  console.log(`本地采集服务: ${runtime.baseUrl}`);
  if (options.lan) {
    const port = new URL(runtime.baseUrl).port;
    for (const address of localLanAddresses()) console.log(`局域网地址: http://${address}:${port}`);
  }
  console.log(`配对码: ${runtime.getPairingCode()}`);
  console.log(`浏览器数据仅保存在: ${runtime.dataDirectory}`);

  process.once("SIGINT", () => void runtime.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void runtime.close().then(() => process.exit(0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "采集服务启动失败。");
    process.exitCode = 1;
  });
}
