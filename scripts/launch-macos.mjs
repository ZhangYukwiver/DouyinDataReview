#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR_PORT = 4765;
const WEB_PORT = 8081;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const localDataDirectory = path.join(projectDirectory, ".local-data");
const errorFile = path.join(localDataDirectory, "launcher-error.txt");
const expoCli = path.join(projectDirectory, "node_modules", "expo", "bin", "cli");
const distDirectory = path.join(projectDirectory, "dist");

let collectorProcess = null;
let exportProcess = null;
let webServer = null;
let currentPairingCode = null;
let shuttingDown = false;
let collectorError = "";
let appMonitor = null;

function tail(value, limit = 2_000) {
  return value.length > limit ? value.slice(-limit) : value;
}

async function assertPortAvailable(port, label) {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`${label}端口 ${port} 已被占用，请先关闭旧实例。`, { cause: error })));
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

async function runExport() {
  await access(expoCli);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [expoCli, "export", projectDirectory, "--platform", "web"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        CI: "1",
        EXPO_NO_TELEMETRY: "1",
        EXPO_PUBLIC_COLLECTOR_BASE_URL: `http://127.0.0.1:${COLLECTOR_PORT}`,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exportProcess = child;
    let output = "";
    let killTimer = null;
    const capture = (chunk) => { output = tail(output + chunk.toString("utf8")); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, 120_000);
    const finish = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (exportProcess === child) exportProcess = null;
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      finish();
      if (code === 0) resolve();
      else reject(new Error(`Web 构建失败（${signal ?? code ?? "unknown"}）。${output ? `\n${output.trim()}` : ""}`));
    });
  });
}

function startCollector() {
  let lineBuffer = "";
  let resolveFirstCode;
  const firstCode = new Promise((resolve) => { resolveFirstCode = resolve; });
  collectorProcess = spawn(process.execPath, [path.join(projectDirectory, "collector", "server.mjs")], {
    cwd: projectDirectory,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  collectorProcess.stdout.on("data", (chunk) => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split(/\r?\n/u);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const code = /^(?:新的)?配对码: (\d{8})$/u.exec(line)?.[1] ?? null;
      if (!code) continue;
      currentPairingCode = code;
      resolveFirstCode(code);
    }
  });
  collectorProcess.stderr.on("data", (chunk) => {
    collectorError = tail(collectorError + chunk.toString("utf8"));
  });
  collectorProcess.once("error", (error) => void fail(`采集器启动失败：${error.message}`));
  collectorProcess.once("exit", (code, signal) => {
    if (!shuttingDown) {
      void fail(`采集器意外退出（${signal ?? code ?? "unknown"}）。${collectorError ? `\n${collectorError.trim()}` : ""}`);
    }
  });
  return Promise.race([
    firstCode,
    new Promise((_, reject) => setTimeout(() => reject(new Error("采集器启动超时。")), 30_000)),
  ]);
}

function contentType(filePath) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  })[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function serveStatic(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", `http://127.0.0.1:${WEB_PORT}`).pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(distDirectory, relativePath);
  if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("not_file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": file.size,
      "Content-Type": contentType(filePath),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not Found");
  }
}

async function startWebServer() {
  webServer = createHttpServer((request, response) => void serveStatic(request, response));
  await new Promise((resolve, reject) => {
    webServer.once("error", (error) => reject(new Error(`网页端口 ${WEB_PORT} 无法启动。`, { cause: error })));
    webServer.listen(WEB_PORT, "127.0.0.1", resolve);
  });
}

function openPage() {
  if (!currentPairingCode || shuttingDown) return;
  const child = spawn("/usr/bin/open", [`http://127.0.0.1:${WEB_PORT}/#pair=${currentPairingCode}`], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

async function waitForExit(child, milliseconds) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      resolve(false);
    }, milliseconds);
    child.once("exit", finish);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!await waitForExit(child, 10_000)) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }
}

async function stopServices() {
  if (appMonitor) {
    clearInterval(appMonitor);
    appMonitor = null;
  }
  if (exportProcess) {
    const child = exportProcess;
    exportProcess = null;
    await stopChild(child);
  }
  if (webServer) {
    const server = webServer;
    webServer = null;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await stopChild(collectorProcess);
}

async function fail(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  await mkdir(localDataDirectory, { recursive: true });
  await writeFile(errorFile, message.trim(), { encoding: "utf8", mode: 0o600 });
  await chmod(errorFile, 0o600);
  await stopServices();
  process.exit(1);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopServices();
  process.exit(0);
}

async function main() {
  process.title = "抖音年度回顾";
  const launcherAppPID = Number.parseInt(process.env.DOUYIN_LAUNCHER_APP_PID ?? "", 10);
  if (Number.isSafeInteger(launcherAppPID) && launcherAppPID > 1) {
    appMonitor = setInterval(() => {
      try {
        process.kill(launcherAppPID, 0);
      } catch {
        void shutdown();
      }
    }, 2_000);
  }
  await mkdir(localDataDirectory, { recursive: true });
  await writeFile(errorFile, "", { encoding: "utf8", mode: 0o600 });
  await chmod(errorFile, 0o600);
  await assertPortAvailable(COLLECTOR_PORT, "采集器");
  await assertPortAvailable(WEB_PORT, "网页");
  await runExport();
  await startCollector();
  await startWebServer();
  openPage();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.on("SIGUSR1", openPage);
process.once("uncaughtException", (error) => void fail(error instanceof Error ? error.message : "启动器发生未知错误。"));
process.once("unhandledRejection", (error) => void fail(error instanceof Error ? error.message : "启动器发生未知错误。"));

main().catch((error) => void fail(error instanceof Error ? error.message : "启动器启动失败。"));
