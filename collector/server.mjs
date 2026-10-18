#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { AccountRegistry, isAccountId } from "./accounts.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { BrowserConnectionError, browserDirectories, connectExternalBrowser, listBrowserSources } from "./browserConnection.mjs";
import { BROWSER_LOGIN_TIMEOUT_MS, waitForBrowserLogin } from "./browserLogin.mjs";
import { importedReadPermissions, parseReadPermissions, readPermissionForRequest } from "./readPermissions.mjs";
import { ExplorerBridge } from "./explorerBridge.mjs";
import { ChatSendError } from "./chatSender.mjs";
import { DirectHistoryError } from "./directHistory.mjs";
import { CreatorCenterError } from "./creatorCenter.mjs";
import { LiveRoomError } from "./liveRoom.mjs";
import { CollectorStore } from "./store.mjs";
import { AnalysisError, AnalysisLibrary, parseAnalysisConfig, startAnalysis } from "./videoAnalysis.mjs";
import { VideoDownloadError, fetchMediaStream } from "./videoDownloader.mjs";

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
    // 闲置 12 小时才过期：托盘常驻每 3 小时补读一次，用着就一直有效
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
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
    "Content-Type": safeName.endsWith(".zip") ? "application/zip" : "video/mp4",
    "Content-Length": file.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "no-store",
  });
  const stream = createReadStream(filePath);
  stream.once("error", () => response.destroy());
  stream.pipe(response);
}

async function proxyMediaStream(request, response, stream) {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  const range = request.headers.range;
  try {
    const upstream = await fetchMediaStream({ ...stream, range: /^bytes=\d*-\d*$/u.test(range ?? "") ? range : undefined, signal: controller.signal });
    const type = upstream.headers.get("content-type") ?? "";
    response.writeHead(upstream.status, Object.fromEntries([
      ["Content-Type", /^(?:video|audio)\//iu.test(type) ? type : "video/mp4"],
      ["Accept-Ranges", "bytes"],
      ["Content-Length", upstream.headers.get("content-length")],
      ["Content-Range", upstream.headers.get("content-range")],
    ].filter(([, value]) => value)));
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    if (!response.headersSent) sendJson(response, 502, { error: "media_unavailable" });
    else response.destroy();
  }
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
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
  browserSources = browserDirectories(),
  browserConnector = connectExternalBrowser,
} = {}) {
  const options = { lan, port, origins };
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const accounts = new AccountRegistry(dataDirectory);
  await accounts.load();
  // 每个账号一个采集器，各用自己目录里的登录态和记录；同一时间只开当前这一个
  const openCollector = async (account) => {
    const directory = accounts.directory(account);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const next = new DouyinCollector({
      dataDirectory: directory,
      signerDirectory,
      store: new CollectorStore(directory),
      account: { id: account.id, nickname: account.nickname, avatar: account.avatar, uid: account.uid },
      onAccountIdentity: (identity) => accounts.updateIdentity(account.id, identity).catch(() => undefined),
    });
    await next.initialize();
    return next;
  };
  let collector = await openCollector(accounts.active());
  let explorer = new ExplorerBridge(collector);
  // 解析库不分账号，放在根数据目录
  const analyses = new AnalysisLibrary(path.join(dataDirectory, "analyses.json"));
  await analyses.load();
  // 账号操作（切换、新建、删除）一次只做一个；切换期间旧采集器在关、新的还没接上
  let accountWork = null;
  let switching = false;
  let browserWork = null;
  let browserLoginController = null;
  let pendingBrowser = null;
  const clearPendingBrowser = async (id) => {
    if (!pendingBrowser || (id && pendingBrowser.id !== id)) return;
    const pending = pendingBrowser; pendingBrowser = null;
    clearTimeout(pending.timer);
    await pending.connection.disconnect();
  };
  const browserIdentity = async (connection, page, options = { timeoutMs: 15_000 }) => {
    options.signal?.throwIfAborted();
    if (!connection.connected) throw new BrowserConnectionError("browser_disconnected", "浏览器已断开，请重新连接。");
    if (page.isClosed()) throw new BrowserConnectionError("browser_page_closed", "抖音登录页面已关闭，请重新连接浏览器。");
    await page.goto("https://www.douyin.com/user/self", { waitUntil: "domcontentloaded", timeout: 30_000 });
    return waitForBrowserLogin(connection, page, (context, loginPage) => collector.hasLoginSession(context, loginPage), options);
  };
  // 当前账号有记录却没绑定抖音号（旧版或先并入了备份）：存着的凭据要么没有、要么就是浏览器里这个号的，才让用户归进来
  const canAdopt = async (identity) => {
    const active = accounts.active();
    if (active.uid) return false;
    let storedUid = null;
    try { storedUid = JSON.parse(await readFile(path.join(accounts.directory(active), "direct-session.json"), "utf8"))?.uid ?? null; }
    catch { /* 没存过凭据 */ }
    return !storedUid || storedUid === identity.uid;
  };
  const browserTarget = (identity) => {
    const existing = accounts.list().accounts.find(account => account.uid === identity.uid);
    if (existing) return existing;
    const active = accounts.active();
    const snapshot = collector.getSnapshot();
    if (!active.uid && !Object.values(snapshot.records).some(items => items.length) && !snapshot.chatMessages.length && !snapshot.chatConversations.length) return active;
    return null;
  };
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

  const rejectWhileSwitching = (response) => {
    if (!switching) return false;
    sendJson(response, 409, { error: "collector_busy", message: "正在切换账号，请稍等。" });
    return true;
  };

  // 清除、并入这类改记录的请求会带上界面以为的当前账号（?account=）：另一个窗口已经切走了就不动，免得清错、并错
  const rejectStaleAccount = (response, url) => {
    const expected = url.searchParams.get("account");
    if (!expected || expected === accounts.activeId) return false;
    sendJson(response, 409, { error: "account_changed", message: "采集器已经换到另一个账号了，这次没有改动记录。界面已换成那个账号，看一眼再操作。" });
    return true;
  };

  const accountBusyMessage = () => {
    if (accountWork) return "上一个账号操作还没做完，请稍等。";
    if (collector.syncPromise) return "正在读取记录，先停下再切换账号。";
    if (collector.hasSavingVideoDownload()) return "正在下载视频，等下载完再切换账号。";
    if (explorer.busy) return "正在搜索或打开作品，等它结束再切换账号。";
    return null;
  };

  const runAccountWork = (work) => {
    const promise = work().finally(() => {
      if (accountWork === promise) accountWork = null;
    });
    accountWork = promise;
    return promise;
  };

  // 切到另一个账号：收掉当前账号的浏览器和任务，换上那个账号目录的采集器，正在长轮询的状态请求直接拿新状态返回
  // 新采集器先建好再记成当前账号，中途失败时旧的还留着能用
  const switchTo = async (account) => {
    await clearPendingBrowser();
    await explorer.close();
    await collector.shutdown();
    let next;
    try {
      next = await openCollector(account);
      await accounts.setActive(account.id);
    } catch (error) {
      // 没换过去就留在原账号：静默停下的任务不改状态，这里复位，别还显示“正在接收”、浏览器开着
      collector.updateStatus({ state: "idle", phase: null, progress: null, message: "没能切换账号，已留在原账号。", browserOpen: Boolean(collector.context) });
      throw error;
    }
    next.statusRevision = collector.statusRevision + 1;
    collector = next;
    explorer = new ExplorerBridge(next);
    const status = next.getStatus();
    for (const finish of [...statusWaiters]) finish(status);
    return status;
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

    const streamMatch = request.method === "GET" ? url.pathname.match(/^\/v1\/downloads\/([0-9a-f-]{20,})\/stream$/iu) : null;
    if (streamMatch) {
      const stream = collector.playbackStream(streamMatch[1], url.searchParams.get("key"), url.searchParams.get("live"));
      if (stream) await proxyMediaStream(request, response, stream);
      else sendJson(response, 404, { error: "download_job_not_found" });
      return;
    }

    if (!pairing.authorize(request.headers.authorization)) {
      sendJson(response, 401, { error: "not_paired" });
      return;
    }

    // 切换账号时只放行读状态和账号列表
    if (!(request.method === "GET" && (url.pathname === "/v1/status" || url.pathname === "/v1/accounts")) && rejectWhileSwitching(response)) return;

    const readPermission = readPermissionForRequest(request.method, url.pathname);
    if (readPermission) {
      try { collector.assertReadPermission(readPermission); }
      catch (error) { sendJson(response, error.status, { error: error.code, message: error.message }); return; }
    }

    if (request.method === "POST" && ["/v1/sync", "/v1/experimental/records-direct", "/v1/chat/observe", "/v1/downloads"].includes(url.pathname)) {
      if (explorer.busy) {
        sendJson(response, 409, { error: "collector_busy", message: "请等待当前探索操作完成后继续。" });
        return;
      }
      // Release only the adapter's tabs before invoking an original workflow.
      // Downloads decide after reading the body: playback only opens its own tab, so open comments survive a prefetch.
      // A download started from an explore page (keepExplore) does the same, so its profile tab can still page on.
      if (url.pathname !== "/v1/downloads") await explorer.close();
      if (rejectWhileSwitching(response)) return;
    }

    if (url.pathname.startsWith("/v1/browser/")) {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: "loopback_only", message: "浏览器登录只能在当前电脑连接。" });
        return;
      }
      try {
        if (request.method === "GET" && url.pathname === "/v1/browser/sources") {
          sendJson(response, 200, { sources: await listBrowserSources(browserSources), status: collector.getStatus() });
          return;
        }
        if (!["POST", "DELETE"].includes(request.method)) { sendJson(response, 404, { error: "not_found" }); return; }
        const body = await readJsonBody(request);
        if (rejectWhileSwitching(response) || rejectStaleAccount(response, url)) return;
        const cancel = url.pathname === "/v1/browser/pending" && request.method === "DELETE";
        if (cancel) {
          if (typeof body.id !== "string") throw new BrowserConnectionError("browser_candidate_invalid", "连接确认已过期，请重新连接。", 400);
          await clearPendingBrowser(body.id);
          sendJson(response, 200, { status: collector.getStatus() }); return;
        }
        const busy = accountBusyMessage() || (collector.chatSendPromise ? "正在发送消息，请等待完成。" : null);
        if (busy) throw new BrowserConnectionError("collector_busy", busy);
        if (request.method !== "POST" || !["/v1/browser/connect", "/v1/browser/confirm", "/v1/browser/disconnect"].includes(url.pathname)) {
          sendJson(response, 404, { error: "not_found" }); return;
        }
        switching = true;
        let finishBrowserWork;
        browserWork = new Promise(resolve => { finishBrowserWork = resolve; });
        const loginController = url.pathname === "/v1/browser/connect" ? new AbortController() : null;
        const cancelLogin = () => { if (!response.writableEnded) loginController?.abort(); };
        if (loginController) {
          browserLoginController = loginController;
          response.once("close", cancelLogin);
        }
        try {
          if (url.pathname === "/v1/browser/connect") {
            const source = browserSources.find(item => item.id === body.browser);
            if (!source) throw new BrowserConnectionError("browser_unsupported", "请选择 Chrome、Edge 或受支持的 Comet。", 400);
            await clearPendingBrowser();
            const connection = await browserConnector(source);
            try {
              loginController.signal.throwIfAborted();
              const page = await connection.context.newPage();
              await page.bringToFront?.();
              const identity = await browserIdentity(connection, page, { signal: loginController.signal, timeoutMs: BROWSER_LOGIN_TIMEOUT_MS });
              loginController.signal.throwIfAborted();
              const id = randomUUID();
              const timer = setTimeout(() => { void clearPendingBrowser(id); }, 2 * 60_000); timer.unref();
              pendingBrowser = { id, connection, page, identity, timer };
              const target = browserTarget(identity);
              let readPermissions = { videos: true, chat: false };
              if (target) {
                try { readPermissions = importedReadPermissions(JSON.parse(await readFile(path.join(accounts.directory(target), "external-browser.json"), "utf8"))); }
                catch { /* A first import starts with video reading selected. */ }
              }
              const adoptable = !target && await canAdopt(identity);
              sendJson(response, 200, { candidate: { id, browser: connection.browser, nickname: identity.nickname, uid: identity.uid,
                accountId: target?.id ?? null, newAccount: !target, adoptable, readPermissions } });
            } catch (error) { await connection.disconnect(); throw error; }
          } else if (url.pathname === "/v1/browser/confirm") {
            const readPermissions = parseReadPermissions(body.readPermissions);
            const pending = pendingBrowser;
            if (!pending || pending.id !== body.id) throw new BrowserConnectionError("browser_candidate_expired", "连接确认已过期，请重新连接。");
            const identity = await browserIdentity(pending.connection, pending.page);
            if (identity.uid !== pending.identity.uid) { await clearPendingBrowser(); throw new BrowserConnectionError("account_mismatch", "浏览器里的账号已经变化，请重新连接并确认。"); }
            // Transfer ownership out of the pending slot before switching. The
            // switch shuts down only the old collector's connection.
            clearTimeout(pending.timer); pendingBrowser = null;
            let created = null;
            try {
              const existing = browserTarget(identity);
              const adopt = !existing && body.adopt === true && await canAdopt(identity);
              const target = existing ?? (adopt ? accounts.active() : (created = await accounts.create()));
              if (target.id !== accounts.activeId) await runAccountWork(() => switchTo(target));
              else { await explorer.close(); await collector.shutdown(); }
              if (adopt) await collector.keepLocalLists();
              await collector.attachExternalBrowser(pending.connection, identity, pending.page, readPermissions);
              // 已有账号重新导入只补新增；没读完过的分类 runDirectRecords 会自己退回整份读取
              if (readPermissions.videos) collector.startSync({ mode: created ? "full_records" : "direct_records" });
              sendJson(response, 200, { ...accounts.list(), status: collector.getStatus() });
            } catch (error) {
              await pending.connection.disconnect();
              // Keep a newly active account recoverable; do not delete its data.
              if (created && created.id !== accounts.activeId) await accounts.remove(created.id).catch(() => {});
              throw error;
            }
          } else {
            await clearPendingBrowser();
            await collector.disconnectExternalBrowser();
            sendJson(response, 200, { ...accounts.list(), status: collector.getStatus() });
          }
        } finally {
          response.off("close", cancelLogin);
          browserLoginController = null;
          switching = false; finishBrowserWork(); browserWork = null;
        }
      } catch (error) {
        const known = error instanceof BrowserConnectionError || error instanceof DirectHistoryError;
        if (!response.headersSent && !response.destroyed) sendJson(response, known ? error.status || 409 : 500, { error: known ? error.code : "browser_connection_failed",
          message: known ? error.message : "浏览器连接没有完成，请检查登录和远程调试设置后重试。" });
      }
      return;
    }

    const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)(\/activate)?$/u);
    if (url.pathname === "/v1/accounts" || accountMatch) {
      const account = accountMatch ? accounts.get(accountMatch[1]) : null;
      if (request.method === "GET" && !accountMatch) {
        sendJson(response, 200, accounts.list());
      } else if (accountMatch && (!isAccountId(accountMatch[1]) || !account)) {
        // 请求里的 id 先过格式校验再到列表里查，绝不拿来拼路径
        sendJson(response, 404, { error: "account_not_found", message: "没有这个账号。" });
      } else if (request.method === "DELETE" && accountMatch && !accountMatch[2]) {
        if (account.id === accounts.activeId) {
          sendJson(response, 409, { error: "account_active", message: "正在用的账号不能删除，先切换到别的账号。" });
        } else if (accountWork) {
          sendJson(response, 409, { error: "collector_busy", message: accountBusyMessage() });
        } else {
          try {
            await runAccountWork(() => accounts.remove(account.id));
            sendJson(response, 200, accounts.list());
          } catch (error) {
            sendJson(response, error?.status ?? 500, {
              error: error?.code ?? "account_remove_failed",
              message: error?.status ? error.message : "没删干净，请稍后再试。",
            });
          }
        }
      } else if (request.method === "POST" && (!accountMatch || accountMatch[2])) {
        if (account && account.id === accounts.activeId) {
          sendJson(response, 200, { ...accounts.list(), status: collector.getStatus() });
          return;
        }
        const busy = accountBusyMessage();
        if (busy) {
          sendJson(response, 409, { error: "collector_busy", message: busy });
          return;
        }
        try {
          const status = await runAccountWork(async () => {
            switching = true;
            let created = null;
            try {
              return await switchTo(account ?? (created = await accounts.create()));
            } catch (error) {
              // 新建的号没切过去就别留个空壳在列表里
              if (created) await accounts.remove(created.id).catch(() => undefined);
              throw error;
            } finally {
              switching = false;
            }
          });
          sendJson(response, account ? 200 : 201, { ...accounts.list(), status });
        } catch {
          sendJson(response, 500, { error: "account_switch_failed", message: account ? "没能切换账号，请稍后再试。" : "没能添加账号，请稍后再试。" });
        }
      } else {
        sendJson(response, 404, { error: "not_found" });
      }
      return;
    }

    if (request.method === "POST" && ["/v1/explore/read", "/v1/explore/interact", "/v1/explore/video", "/v1/explore/close"].includes(url.pathname)) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once("close", abort);
      try {
        const body = await readJsonBody(request);
        if (rejectWhileSwitching(response)) return;
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
        if (body?.playback !== true && body?.keepExplore !== true) await explorer.close();
        if (rejectWhileSwitching(response)) return;
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
    } else if (url.pathname === "/v1/analyses" || /^\/v1\/analyses\/[0-9a-f-]{36}$/u.test(url.pathname)) {
      // 解析库：GET 全部，POST 开始解析一条（带链接和接口配置），DELETE 删一条
      try {
        if (request.method === "GET" && url.pathname === "/v1/analyses") sendJson(response, 200, { analyses: analyses.list() });
        else if (request.method === "POST" && url.pathname === "/v1/analyses") {
          const body = await readJsonBody(request, 16 * 1024);
          if (explorer.busy) { sendJson(response, 409, { error: "collector_busy", message: "请等待当前探索操作完成后继续。" }); return; }
          if (rejectWhileSwitching(response)) return;
          sendJson(response, 202, { analysis: startAnalysis({ library: analyses, collector, url: body?.url, config: parseAnalysisConfig(body?.config) }) });
        } else if (request.method === "DELETE" && url.pathname !== "/v1/analyses") sendJson(response, 200, { removed: await analyses.remove(url.pathname.split("/").at(-1)) });
        else sendJson(response, 405, { error: "method_not_allowed" });
      } catch (error) {
        const known = error instanceof AnalysisError || error instanceof VideoDownloadError;
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        if (!response.headersSent) sendJson(response, known ? (error.code === "collector_busy" ? 409 : error.status ?? 400) : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "analysis_failed",
          message: known ? error.message : malformed ? "请求无效，请重试。" : "解析没开始，请稍后重试。",
        });
      }
    } else if (url.pathname === "/v1/creator/read") {
      // 创作者中心的数据：工作台一次传一批白名单里的查询，原样带回抖音的结果（只读）
      try {
        if (request.method !== "POST") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
        const requests = (await readJsonBody(request))?.requests;
        if (rejectWhileSwitching(response)) return;
        sendJson(response, 200, { results: await collector.creatorCenter.read(requests) });
      } catch (error) {
        const known = error instanceof CreatorCenterError;
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        if (!response.headersSent) sendJson(response, known ? error.status : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "creator_failed",
          message: known ? error.message : malformed ? "请求无效，请重试。" : "没读到创作者中心的数据，请稍后重试。",
        });
      }
    } else if (url.pathname === "/v1/live/following" || url.pathname === "/v1/live/rooms" || /^\/v1\/live\/rooms\/[0-9a-f-]{36}$/u.test(url.pathname)) {
      // 直播间：POST 进房（换台会收掉上一个），GET 取新弹幕，DELETE 退出；following 是关注的人谁在播
      const id = url.pathname.split("/")[4];
      try {
        if (request.method === "GET" && url.pathname === "/v1/live/following") sendJson(response, 200, { rooms: await collector.liveRooms.following({ refresh: url.searchParams.get("refresh") === "1" }) });
        else if (request.method === "POST" && url.pathname === "/v1/live/rooms") {
          // 先读完请求体再取采集器：读的时候账号可能换了，不能在旧账号的浏览器里进房
          const room = (await readJsonBody(request))?.room;
          if (rejectWhileSwitching(response)) return;
          sendJson(response, 200, await collector.liveRooms.open(room));
        }
        else if (request.method === "GET" && id) sendJson(response, 200, collector.liveRooms.read(id, Number(url.searchParams.get("after") ?? -1)));
        else if (request.method === "DELETE" && id) sendJson(response, 200, { closed: await collector.liveRooms.close(id) });
        else sendJson(response, 404, { error: "not_found" });
      } catch (error) {
        const known = error instanceof LiveRoomError;
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        if (!response.headersSent) sendJson(response, known ? error.status : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "live_failed",
          message: known ? error.message : malformed ? "请求无效，请重试。" : id || request.method === "POST" ? "直播间没打开，请稍后重试。" : "没读到关注的人的直播，请稍后重试。",
        });
      }
    } else if (request.method === "GET" && url.pathname === "/v1/status") {
      const requestedRevision = url.searchParams.get("afterRevision");
      if (requestedRevision === null) sendJson(response, 200, collector.getStatus());
      else if (!/^\d+$/u.test(requestedRevision) || !Number.isSafeInteger(Number(requestedRevision))) {
        sendJson(response, 400, { error: "invalid_revision" });
      } else waitForStatus(response, Number(requestedRevision));
    } else if (request.method === "GET" && url.pathname === "/v1/records") {
      sendJson(response, 200, url.searchParams.get("part") === "chat" ? collector.getChatSnapshot() : collector.getSnapshot());
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
    } else if (request.method === "POST" && url.pathname === "/v1/chat/observe") {
      const started = collector.startChatObservation();
      sendJson(response, started ? 202 : 200, { started, status: collector.getStatus() });
    } else if (request.method === "POST" && url.pathname === "/v1/chat/send") {
      try {
        // 16000 characters of worst-case JSON escaping fit well inside this.
        const body = await readJsonBody(request, 128 * 1024);
        sendJson(response, 200, await collector.sendChatMessage(body));
      } catch (error) {
        const known = error instanceof ChatSendError || error instanceof DirectHistoryError;
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        sendJson(response, known ? error.status || 409 : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "chat_send_failed",
          message: known ? error.message : malformed ? "发送请求无效，请重试。" : "消息没发出去，请稍后再试。",
        });
      }
    } else if ((request.method === "POST" && url.pathname === "/v1/chat/messages") || (request.method === "GET" && url.pathname === "/v1/chat/streaks")) {
      try {
        const result = url.pathname.endsWith("/streaks") ? await collector.readChatStreaks() : await collector.readChatMessages(await readJsonBody(request));
        sendJson(response, 200, result);
      } catch (error) {
        const known = error instanceof ChatSendError || error instanceof DirectHistoryError;
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        sendJson(response, known ? error.status || 409 : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "chat_read_failed",
          message: known ? error.message : malformed ? "请求无效，请重试。" : "暂时读不到，请稍后再试。",
        });
      }
    } else if (request.method === "POST" && url.pathname === "/v1/chat/observe/stop") {
      const stopped = await collector.stopChatObservation();
      sendJson(response, 200, { stopped, status: collector.getStatus() });
    } else if (request.method === "DELETE" && url.pathname === "/v1/records") {
      if (rejectStaleAccount(response, url)) return;
      sendJson(response, 200, await collector.clearRecords());
    } else if (request.method === "POST" && url.pathname === "/v1/records/import") {
      try {
        // 和应用里导入本应用导出文件的上限一致
        const target = collector;
        const body = await readJsonBody(request, 256 * 1024 * 1024);
        // 上传期间换了账号就不并了，免得并进另一个账号
        if (rejectWhileSwitching(response) || rejectStaleAccount(response, url)) return;
        if (collector !== target) {
          sendJson(response, 409, { error: "collector_busy", message: "账号已切换，请重新并入。" });
          return;
        }
        sendJson(response, 200, await target.importRecords(body));
      } catch (error) {
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        sendJson(response, error?.status ?? (malformed ? 400 : 500), {
          error: error?.code ?? (malformed ? "invalid_request" : "import_failed"),
          message: error?.status ? error.message : malformed ? "文件内容无效或超过 256 MB。" : "并入失败，请稍后再试。",
        });
      }
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
    browserLoginController?.abort();
    for (const finish of statusWaiters) finish();
    try {
      // 正在切换就等它换完，关掉的才是最后接上的那个采集器
      await accountWork?.catch(() => undefined);
      await browserWork;
      await clearPendingBrowser();
      await explorer.close();
      await collector.close();
    } finally {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // 页面一直在长轮询状态，不掐断的话 close 会一直等下去，退出应用就卡住
      server.closeAllConnections();
      await closed;
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
  console.log(`本地数据仅保存在: ${runtime.dataDirectory}`);

  process.once("SIGINT", () => void runtime.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void runtime.close().then(() => process.exit(0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "采集服务启动失败。");
    process.exitCode = 1;
  });
}
