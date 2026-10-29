import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDirectories, connectExternalBrowser, discoverBrowser, endpointOwnedByBrowser, listBrowserSources, localBrowserEndpoint, openBrowserDebuggingPage } from "./browserConnection.mjs";
import { closeContextWithin, DouyinCollector } from "./douyinCollector.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
async function source() {
  const directory = await mkdtemp(path.join(tmpdir(), "cdp-source-")); directories.push(directory);
  await writeFile(path.join(directory, "DevToolsActivePort"), "9222\n/devtools/browser/test-id\n");
  return { id: "chrome", label: "Chrome", directory, inspectUrl: "chrome://inspect/#remote-debugging" };
}
function fakeBrowser() {
  const userPage = { close: vi.fn(), addInitScript: vi.fn() };
  const sessions = [];
  const raw = { pages: () => [userPage], cookies: vi.fn(), close: vi.fn(), addInitScript: vi.fn(), newCDPSession: vi.fn(async () => {
    const session = new EventEmitter();
    session.send = vi.fn(async method => method === "Network.getCookies" ? { cookies: [
      { name: "sessionid", value: "synthetic", domain: ".douyin.com", path: "/", expires: -1 },
      { name: "other", value: "never-retain", domain: "example.org", path: "/", expires: -1 },
    ] } : {});
    session.detach = vi.fn(async () => {}); sessions.push(session); return session;
  }), newPage: vi.fn(async () => {
    const page = new EventEmitter(); let closed = false;
    page.isClosed = () => closed;
    page.context = () => raw;
    page.close = vi.fn(async () => { closed = true; page.emit("close"); });
    page.addInitScript = vi.fn(); return page;
  }) };
  const browser = new EventEmitter(); let connected = true;
  browser.contexts = () => [raw]; browser.isConnected = () => connected;
  browser.close = vi.fn(async () => { connected = false; browser.emit("disconnected"); });
  return { browser, raw, userPage, sessions };
}

describe("local CDP source discovery", () => {
  it("rejects remote hosts, credentials, malformed paths and ports", () => {
    for (const [port, route] of [["0", "/devtools/browser/id"], ["65536", "/devtools/browser/id"], ["9222@evil.org", "/devtools/browser/id"], ["9222", "//evil.org"], ["9222", "/devtools/browser/id?token=x"], ["9222", "/devtools/page/id"]]) {
      expect(() => localBrowserEndpoint(port, route)).toThrow();
    }
    expect(localBrowserEndpoint("9222", "/devtools/browser/id")).toBe("ws://127.0.0.1:9222/devtools/browser/id");
  });
  it("does not treat a stale endpoint file as enabled and hides paths from the API", async () => {
    const item = await source();
    expect(await discoverBrowser(item, async () => false)).toMatchObject({ available: true, debugging: false, endpoint: null });
    const [publicSource] = await listBrowserSources([{ ...item, directory: path.join(item.directory, "missing") }]);
    expect(publicSource).toMatchObject({ available: false, debugging: false });
    expect(publicSource).not.toHaveProperty("directory"); expect(publicSource).not.toHaveProperty("endpoint");
  });
  it("rejects a stale file when its live port belongs to another browser or profile", async () => {
    const item = await source();
    expect(await discoverBrowser(item, async () => true, async () => false)).toMatchObject({ debugging: false, endpoint: null });
    const endpoint = "ws://127.0.0.1:9222/devtools/browser";
    const run = vi.fn(async () => ({ stdout: "p123\ncGoogle Chrome\nf53\n" }));
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "darwin", run, lock: async () => "host-123" })).toBe(true);
    expect(await endpointOwnedByBrowser({ ...item, id: "comet" }, endpoint, { platform: "darwin", run, lock: async () => "host-456" })).toBe(false);
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "darwin", run, lock: async () => "host-456" })).toBe(false);
  });
  it("checks Windows process identity and rejects a separate user-data directory", async () => {
    const item = { id: "chrome", directory: "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data" };
    const endpoint = "ws://127.0.0.1:9222/devtools/browser";
    const run = vi.fn(async () => ({ stdout: JSON.stringify([{ name: "chrome", commandLine: '"C:\\Chrome\\chrome.exe" --profile-directory="Profile 1"' }]) }));
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "win32", run })).toBe(true);
    run.mockResolvedValue({ stdout: JSON.stringify([{ name: "chrome", commandLine: 'chrome.exe --user-data-dir="C:\\isolated"' }]) });
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "win32", run })).toBe(false);
    run.mockResolvedValue({ stdout: JSON.stringify([{ name: "msedge", commandLine: "msedge.exe" }]) });
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "win32", run })).toBe(false);
    run.mockRejectedValue(new Error("process check unavailable"));
    expect(await endpointOwnedByBrowser(item, endpoint, { platform: "win32", run })).toBe(false);
  });
  it("does not ask another browser to authorize a connection through a stale endpoint", async () => {
    const item = await source(), connect = vi.fn(), openDebuggingPage = vi.fn();
    await expect(connectExternalBrowser(item, { connect, openDebuggingPage, listening: async () => true, ownsEndpoint: async () => false })).rejects.toMatchObject({ code: "browser_debugging_required" });
    expect(connect).not.toHaveBeenCalled();
    expect(openDebuggingPage).toHaveBeenCalledExactlyOnceWith(item);
  });
  it("resolves Chrome/Edge default profiles on macOS, Windows and Linux", () => {
    expect(browserDirectories({ platform: "darwin", home: "/Users/test", env: {} }).map(item => item.directory)).toEqual([
      path.join("/Users/test", "Library", "Application Support", "Google", "Chrome"), path.join("/Users/test", "Library", "Application Support", "Microsoft Edge"), path.join("/Users/test", "Library", "Application Support", "Comet"),
    ]);
    expect(browserDirectories({ platform: "win32", home: "/users/test", env: { LOCALAPPDATA: "/local" } }).map(item => item.directory)).toEqual([path.join("/local", "Google", "Chrome", "User Data"), path.join("/local", "Microsoft", "Edge", "User Data")]);
    expect(browserDirectories({ platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "/config" } })[0].directory).toBe(path.join("/config", "google-chrome"));
  });
});

describe("opening the selected browser's debugging settings", () => {
  it.each([
    ["chrome", "C:\\local\\Google\\Chrome\\Application\\chrome.exe"],
    ["edge", "C:\\programs-x86\\Microsoft\\Edge\\Application\\msedge.exe"],
  ])("opens %s directly on Windows even when it is not the default browser", async (id, executable) => {
    const run = vi.fn(async () => ({ stdout: "debugging_page_opened\r\n" }));
    await openBrowserDebuggingPage({ id, label: id, inspectUrl: "https://untrusted.example/" }, {
      platform: "win32", env: { LOCALAPPDATA: "C:\\local", "ProgramFiles(x86)": "C:\\programs-x86" },
      fileExists: async file => file === executable, run,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", expect.stringMatching(/[\\/]collector[\\/]openBrowserDebugging\.ps1$/u),
      "-Browser", id, "-Executable", executable,
    ], expect.objectContaining({ windowsHide: true }));
  });
  it("uses a registered Windows installation path with spaces as a single argument", async () => {
    const executable = "D:\\Browser Apps\\Chrome\\chrome.exe";
    const run = vi.fn(async command => ({ stdout: command === "reg.exe" ? `\r\n    (默认)    REG_SZ    ${executable}\r\n` : "debugging_page_opened\r\n" }));
    await openBrowserDebuggingPage({ id: "chrome", label: "Chrome" }, {
      platform: "win32", env: {}, fileExists: async file => file === executable, run,
    });
    expect(run.mock.calls[0][1]).toEqual(["query", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe", "/ve"]);
    expect(run.mock.calls[1][0]).toBe("powershell.exe");
    expect(run.mock.calls[1][1].slice(-4)).toEqual(["-Browser", "chrome", "-Executable", executable]);
  });
  it.each([["chrome", "Google Chrome"], ["edge", "Microsoft Edge"], ["comet", "Comet"]])("targets %s by application name on macOS", async (id, application) => {
    const run = vi.fn(async () => ({ stdout: `${id}://inspect/#remote-debugging\n` }));
    await openBrowserDebuggingPage({ id, label: application }, { platform: "darwin", run });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("/usr/bin/osascript");
    expect(run.mock.calls[0][1][1]).toContain(`tell application "${application}"`);
    expect(run.mock.calls[0][1][1]).toContain(`set URL of active tab of settingsWindow to "${id}://inspect/#remote-debugging"`);
  });
  it("provides a manual URL when the platform has no supported settings opener", async () => {
    const run = vi.fn();
    await expect(openBrowserDebuggingPage({ id: "edge", label: "Edge" }, { platform: "linux", run })).rejects.toMatchObject({
      code: "browser_debugging_disabled", message: expect.stringContaining("edge://inspect/#remote-debugging"),
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("provides the manual settings URL if an executable cannot be found or launched", async () => {
    const run = vi.fn(async () => ({ stdout: "    (Default)    REG_SZ    C:\\other\\msedge.exe\r\n" }));
    await expect(openBrowserDebuggingPage({ id: "chrome", label: "Chrome" }, {
      platform: "win32", env: {}, fileExists: async () => true, run,
    })).rejects.toMatchObject({ code: "browser_debugging_disabled", message: expect.stringContaining("chrome://inspect/#remote-debugging") });
    expect(run.mock.calls.every(([command]) => command === "reg.exe")).toBe(true);
    await expect(openBrowserDebuggingPage({ id: "edge", label: "Edge" }, {
      platform: "darwin", run: vi.fn().mockRejectedValue(new Error("missing application")),
    })).rejects.toMatchObject({ code: "browser_debugging_disabled", message: expect.stringContaining("edge://inspect/#remote-debugging") });
  });
  it.each(["darwin", "win32"])("does not report success on %s until the helper confirms the settings page", async platform => {
    const run = vi.fn(async () => ({ stdout: "" }));
    await expect(openBrowserDebuggingPage({ id: "chrome", label: "Chrome" }, {
      platform, env: { LOCALAPPDATA: "C:\\local" }, fileExists: async () => true, run,
    })).rejects.toMatchObject({ code: "browser_debugging_disabled" });
  });
  it("rejects unsupported browsers before launching any application", async () => {
    const run = vi.fn();
    for (const id of ["__proto__", "ws://evil.example/", "comet"]) {
      await expect(openBrowserDebuggingPage({ id }, { platform: "win32", run })).rejects.toMatchObject({ code: "browser_unsupported" });
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("borrowed browser ownership and cookie scope", () => {
  it("initializes only its own tabs, reads bounded Douyin cookies and disconnects without closing the browser context", async () => {
    const item = await source(); const fake = fakeBrowser(); const connect = vi.fn(async () => fake.browser), openDebuggingPage = vi.fn();
    const connection = await connectExternalBrowser(item, { connect, openDebuggingPage, listening: async () => true, ownsEndpoint: async () => true });
    expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/browser/test-id", { timeout: 60_000, noDefaults: true });
    expect(openDebuggingPage).not.toHaveBeenCalled();
    const page = await connection.context.newPage();
    expect(connection.context.pages()).toEqual([page]);
    expect(page.addInitScript).toHaveBeenCalledTimes(2);
    expect(fake.userPage.addInitScript).not.toHaveBeenCalled(); expect(fake.raw.addInitScript).not.toHaveBeenCalled();
    expect(await connection.context.cookies()).toEqual([expect.objectContaining({ domain: ".douyin.com", sameSite: "Lax", secure: false, httpOnly: false })]);
    const cookieSession = fake.sessions.at(-1);
    expect(cookieSession.send).toHaveBeenCalledWith("Network.getCookies", { urls: ["https://www.douyin.com/", "https://www-hj.douyin.com/", "https://imapi.douyin.com/"] });
    expect(fake.raw.cookies).not.toHaveBeenCalled();
    await expect(connection.context.cookies("https://example.org/")).rejects.toMatchObject({ code: "browser_cookie_scope" });
    await expect(connection.context.newCDPSession(fake.userPage)).rejects.toMatchObject({ code: "browser_page_not_owned" });
    await closeContextWithin(connection.context);
    expect(connection.connected).toBe(true); expect(page.close).not.toHaveBeenCalled();
    await connection.disconnect(); await connection.disconnect();
    expect(page.close).toHaveBeenCalledOnce(); expect(fake.userPage.close).not.toHaveBeenCalled(); expect(fake.raw.close).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalledOnce(); expect(connection.connected).toBe(false);
    expect(fake.sessions.flatMap(session => session.send.mock.calls.map(([method]) => method))).not.toContain("Browser.close");
  });
  it("opens settings when debugging is disabled and waits for the user's opt-in", async () => {
    const item = await source(), connect = vi.fn(), openDebuggingPage = vi.fn();
    await expect(connectExternalBrowser(item, { connect, openDebuggingPage, listening: async () => false })).rejects.toMatchObject({
      code: "browser_debugging_required", message: expect.stringContaining("再次点击“连接浏览器”"),
    });
    expect(connect).not.toHaveBeenCalled();
    expect(openDebuggingPage).toHaveBeenCalledExactlyOnceWith(item);
  });
  it("does not launch a browser when its user directory is unavailable", async () => {
    const item = await source(), connect = vi.fn(), openDebuggingPage = vi.fn();
    await expect(connectExternalBrowser({ ...item, directory: path.join(item.directory, "missing") }, { connect, openDebuggingPage })).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(connect).not.toHaveBeenCalled(); expect(openDebuggingPage).not.toHaveBeenCalled();
  });
  it("never launches an independent browser or falls back to page scrolling for an external source", async () => {
    const store = { recordsRevision: 0 };
    const collector = new DouyinCollector({ executablePath: "unused", dataDirectory: "/unused", store });
    collector.externalSource = { browser: "chrome" };
    expect(() => collector.ensureImportBrowser()).toThrowError(expect.objectContaining({ code: "browser_reconnect_required" }));
    await expect(collector.ensureDirectApi()).rejects.toMatchObject({ code: "browser_reconnect_required" });
    const context = { externalBrowser: true };
    collector.externalConnection = { connected: true, context }; collector.context = context;
    expect(await collector.ensureImportBrowser()).toBe(context); expect(await collector.ensureImportBrowser()).toBe(context);
    collector.ensureImportBrowser = vi.fn(); collector.runDirectRecords = vi.fn(async () => { throw new Error("template failed"); });
    await expect(collector.runSync(0)).rejects.toThrow("template failed");
    expect(collector.runDirectRecords).toHaveBeenCalledWith(0, { full: true }); expect(collector.ensureImportBrowser).not.toHaveBeenCalled();
  });
});
