import { EventEmitter } from "node:events";
import { readFile, readlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { sessionCookies } from "./directApi.mjs";
import { installDirectCredentialCapture } from "./directCredentials.mjs";
import { discoverDesktopClient } from "./desktopClient.mjs";
import { prepareReadOnlyPage } from "./readOnlyPage.mjs";

const COOKIE_URLS = ["https://www.douyin.com/", "https://www-hj.douyin.com/", "https://imapi.douyin.com/"];
const runFile = promisify(execFile);
const debuggingScriptPath = fileURLToPath(new URL("./openBrowserDebugging.ps1", import.meta.url)).replace(
  `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`,
);

export class BrowserConnectionError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

export function browserDirectories({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const root = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const entries = platform === "darwin" ? [["chrome", "Chrome", "Google/Chrome"], ["edge", "Edge", "Microsoft Edge"], ["comet", "Comet", "Comet"]]
    : platform === "win32" ? [["chrome", "Chrome", "Google/Chrome/User Data"], ["edge", "Edge", "Microsoft/Edge/User Data"]]
      : [["chrome", "Chrome", "google-chrome"], ["edge", "Edge", "microsoft-edge"]];
  return entries.map(([id, label, directory]) => ({ id, label, directory: path.join(root, ...directory.split("/")), inspectUrl: `${id}://inspect/#remote-debugging` }));
}

// Never accept a URL supplied by a remote caller. Discover only a local browser's
// own endpoint file, then validate it again immediately before connecting.
export function localBrowserEndpoint(port, route) {
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535
    || !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/u.test(route))
    throw new BrowserConnectionError("browser_endpoint_invalid", "浏览器调试地址无效，请重新开启远程调试。");
  return `ws://127.0.0.1:${Number(port)}${route}`;
}

export async function endpointListening(endpoint) {
  const url = new URL(endpoint);
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(url.port) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(800);
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.once("timeout", () => finish(false));
  });
}

// Chromium's opt-in servers reuse the same port and /devtools/browser route.
// A live port can therefore belong to a different browser than a stale file.
// Check local process ownership without requesting a CDP connection or data.
export async function endpointOwnedByBrowser(source, endpoint, { platform = process.platform, run = runFile, lock = readlink } = {}) {
  const port = Number(new URL(endpoint).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    if (platform === "win32") {
      const name = { chrome: "chrome", edge: "msedge" }[source.id];
      if (!name) return false;
      const script = `$ids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | Select-Object -ExpandProperty OwningProcess -Unique); @($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p.ProcessName -eq '${name}') { $c = Get-CimInstance Win32_Process -Filter "ProcessId = $_"; [pscustomobject]@{ name=$p.ProcessName; commandLine=$c.CommandLine } } }) | ConvertTo-Json -Compress`;
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true });
      const value = JSON.parse(stdout || "[]");
      const entries = Array.isArray(value) ? value : [value];
      return entries.some(entry => {
        if (entry?.name !== name || typeof entry.commandLine !== "string") return false;
        const custom = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s"]+))/u.exec(entry.commandLine);
        if (!custom) return !entry.commandLine.includes("--user-data-dir");
        return path.win32.resolve(custom[1] || custom[2]).toLowerCase() === path.win32.resolve(source.directory).toLowerCase();
      });
    }
    const marker = await lock(path.join(source.directory, "SingletonLock"));
    const pid = /-([1-9]\d*)$/u.exec(marker)?.[1];
    if (!pid) return false;
    if (platform === "linux") {
      const { stdout } = await run("ss", ["-ltnp", `sport = :${port}`], { timeout: 3000, maxBuffer: 64 * 1024 });
      return new RegExp(`\\bpid=${pid}(?:,|\\))`, "u").test(stdout);
    }
    if (platform !== "darwin") return false;
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", "+c", "0", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 3000, maxBuffer: 64 * 1024 });
    const name = { chrome: "Google Chrome", edge: "Microsoft Edge", comet: "Comet" }[source.id];
    const processes = stdout.split(/\np(?=\d)/u).map(block => {
      const lines = block.replace(/^p/u, "").trim().split(/\r?\n/u);
      return { pid: lines[0], name: lines.find(line => line.startsWith("c"))?.slice(1) };
    });
    return processes.some(entry => entry.pid === pid && entry.name === name);
  } catch { return false; }
}

export async function discoverBrowser(source, listening = endpointListening, ownsEndpoint = endpointOwnedByBrowser) {
  const available = await stat(source.directory).then(value => value.isDirectory(), () => false);
  let endpoint = null;
  if (available) {
    try {
      const content = await readFile(path.join(source.directory, "DevToolsActivePort"), "utf8");
      if (content.length <= 512) {
        const [port, route] = content.trim().split(/\r?\n/u);
        const candidate = localBrowserEndpoint(port, route);
        if (await listening(candidate) && await ownsEndpoint(source, candidate)) endpoint = candidate;
      }
    } catch { /* A stale or malformed file is not an active debugging session. */ }
  }
  return { ...source, available, debugging: Boolean(endpoint), endpoint };
}

export async function listBrowserSources(sources = browserDirectories()) {
  return Promise.all(sources.map(async source => {
    // 应用内登录窗口不用找浏览器目录，也不用开调试
    if (source.inApp) return { id: source.id, label: source.label, available: true, debugging: true };
    // 抖音桌面端：只读本机客户端的登录态，没有调试端口这回事
    if (source.desktop) {
      const state = await discoverDesktopClient({ directory: source.directory });
      return { id: source.id, label: source.label, available: state.available, debugging: state.loggedIn, desktop: true };
    }
    const { directory: _directory, endpoint: _endpoint, ...publicSource } = await discoverBrowser(source);
    return publicSource;
  }));
}

export async function openBrowserDebuggingPage(source, {
  platform = process.platform, env = process.env, run = runFile,
  fileExists = file => stat(file).then(value => value.isFile(), () => false),
} = {}) {
  const applications = {
    chrome: { mac: "Google Chrome", windows: ["Google", "Chrome", "Application", "chrome.exe"] },
    edge: { mac: "Microsoft Edge", windows: ["Microsoft", "Edge", "Application", "msedge.exe"] },
    comet: { mac: "Comet" },
  };
  if (!Object.hasOwn(applications, source.id) || (source.id === "comet" && platform !== "darwin"))
    throw new BrowserConnectionError("browser_unsupported", "请选择 Chrome、Edge 或受支持的 Comet。", 400);
  const application = applications[source.id];
  // Both the browser and URL are fixed locally, never supplied by an API caller.
  const inspectUrl = `${source.id}://inspect/#remote-debugging`;
  try {
    if (platform === "darwin") {
      const script = `tell application "${application.mac}"
  activate
  set settingsWindow to make new window
  set URL of active tab of settingsWindow to "${inspectUrl}"
  return URL of active tab of settingsWindow
end tell`;
      const { stdout } = await run("/usr/bin/osascript", ["-e", script], { timeout: 15_000, maxBuffer: 16 * 1024 });
      if (stdout.trim() !== inspectUrl) throw new Error("settings_page_not_opened");
      return;
    }
    if (platform === "win32") {
      const roots = [env.LOCALAPPDATA, env.ProgramW6432, env.ProgramFiles, env.PROGRAMFILES, env["ProgramFiles(x86)"], env["PROGRAMFILES(X86)"]].filter(Boolean);
      const executable = application.windows.at(-1);
      const candidates = [...new Set(roots.map(root => path.win32.join(root, ...application.windows)))];
      const openSettings = async file => {
        const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", debuggingScriptPath, "-Browser", source.id, "-Executable", file], { timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true });
        if (stdout.trim() !== "debugging_page_opened") throw new Error("settings_page_not_opened");
      };
      for (const file of candidates) {
        if (await fileExists(file)) { await openSettings(file); return; }
      }
      // App Paths also covers installations outside the standard directories.
      for (const hive of ["HKCU", "HKLM"]) {
        try {
          const { stdout } = await run("reg.exe", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`, "/ve"], { timeout: 3000, maxBuffer: 16 * 1024, windowsHide: true });
          const registered = /^\s*[^\r\n]+?\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)$/mu.exec(stdout)?.[1].trim().replace(/^"|"$/gu, "");
          const file = registered?.replace(/%([^%]+)%/gu, (match, key) => env[key] ?? match);
          if (file && path.win32.isAbsolute(file) && path.win32.basename(file).toLowerCase() === executable && await fileExists(file)) {
            await openSettings(file); return;
          }
        } catch { /* Missing registry entries are normal for per-user installs. */ }
      }
    }
  } catch { /* Fall back to an actionable manual URL instead of OS diagnostics. */ }
  throw new BrowserConnectionError("browser_debugging_disabled", `未能自动打开 ${source.label} 的调试设置页。请在 ${source.label} 中打开 ${inspectUrl}，勾选允许远程调试后再连接。`);
}

// This facade exposes only tabs created by the workbench. It deliberately has
// no global route/cache/cookie-write APIs and never exposes the user's tabs.
export class BorrowedContext extends EventEmitter {
  constructor(raw) { super(); this.raw = raw; this.ownedPages = new Set(); this.externalBrowser = true; }
  pages() { return [...this.ownedPages].filter(page => !page.isClosed()); }
  browser() { return null; }
  async close() { /* Feature cleanup must not close or disconnect a borrowed browser. */ }
  async newPage() {
    const page = await this.raw.newPage();
    this.ownedPages.add(page);
    page.on("close", () => this.ownedPages.delete(page));
    page.on("request", request => {
      try {
        const url = new URL(request.url()), token = url.searchParams.get("msToken");
        if (COOKIE_URLS.some(value => new URL(value).hostname === url.hostname) && /^[A-Za-z0-9+/_=-]{100,1024}$/u.test(token || "")) this.directMsToken = token;
      } catch { /* Non-HTTP resources carry no token. */ }
      this.emit("request", request);
    });
    page.on("response", response => this.emit("response", response));
    try {
      await page.addInitScript(installDirectCredentialCapture);
      await prepareReadOnlyPage(page);
      return page;
    } catch (error) { await page.close().catch(() => {}); throw error; }
  }
  async newCDPSession(page) {
    if (!this.ownedPages.has(page)) throw new BrowserConnectionError("browser_page_not_owned", "只能访问工作台创建的抖音页面。");
    return this.raw.newCDPSession(page);
  }
  async cookies(urls = COOKIE_URLS) {
    const requested = Array.isArray(urls) ? urls : [urls];
    if (!requested.length || requested.some(value => !COOKIE_URLS.includes(value)))
      throw new BrowserConnectionError("browser_cookie_scope", "只允许读取抖音登录态。");
    const page = this.pages()[0] || await this.newPage();
    const session = await this.newCDPSession(page);
    try {
      // CDP omits sameSite for unspecified Cookies; Playwright's HTTP storage
      // state requires it. Export only its cookie schema, never CDP metadata.
      return sessionCookies((await session.send("Network.getCookies", { urls: requested })).cookies).map(cookie => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        expires: cookie.expires ?? -1, httpOnly: cookie.httpOnly === true, secure: cookie.secure === true,
        sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : "Lax",
      }));
    }
    finally { await session.detach().catch(() => {}); }
  }
}

export async function connectExternalBrowser(source, { connect = (endpoint, options) => chromium.connectOverCDP(endpoint, options), listening, ownsEndpoint, openDebuggingPage = openBrowserDebuggingPage } = {}) {
  const discovered = await discoverBrowser(source, listening, ownsEndpoint);
  if (!discovered.endpoint) {
    if (!discovered.available) throw new BrowserConnectionError("browser_unavailable", `未找到 ${source.label} 的用户目录，请先安装并打开该浏览器，再刷新检测。`);
    await openDebuggingPage(source);
    throw new BrowserConnectionError("browser_debugging_required", `已打开 ${source.label} 的调试设置页。请勾选允许远程调试，然后再次点击“连接浏览器”。`);
  }
  let browser;
  try { browser = await connect(discovered.endpoint, { timeout: 60_000, noDefaults: true }); }
  catch { throw new BrowserConnectionError("browser_connection_failed", "浏览器连接未获允许或已关闭，请在浏览器确认框中允许后重试。"); }
  const raw = browser.contexts()[0];
  if (!raw) { await browser.close().catch(() => {}); throw new BrowserConnectionError("browser_context_missing", "没有可用的浏览器登录会话。"); }
  const context = new BorrowedContext(raw);
  let closed = false;
  browser.on("disconnected", () => { closed = true; context.emit("close"); });
  return {
    browser: source.id, label: source.label, context,
    get connected() { return !closed && browser.isConnected(); },
    async disconnect() {
      if (closed) return;
      // Playwright's attached CDP Browser.close disconnects its transport. We
      // never close the default BrowserContext or send CDP Browser.close.
      try { await Promise.allSettled(context.pages().map(page => page.close())); }
      finally { closed = true; await browser.close().catch(() => {}); context.emit("close"); }
    },
  };
}
