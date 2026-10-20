import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { chromeUserAgent, createInAppBrowserConnector, isLoginUrl, LOGIN_PARTITION, maskDiagnostic } from "./inAppBrowser.mjs";

function fakeElectron({ saveDiagnostic } = {}) {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      const contents = new EventEmitter();
      contents.loadURL = vi.fn(async () => {});
      contents.getURL = () => "about:blank";
      contents.mainFrame = { url: "https://www.douyin.com/user/self", framesInSubtree: [], executeJavaScript: vi.fn(async () => "") };
      contents.executeJavaScript = vi.fn(async () => false);
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
      contents.debugger = Object.assign(new EventEmitter(), { attach: vi.fn(), sendCommand: vi.fn(async method => method === "Network.getCookies" ? { cookies: [
        { name: "sessionid", value: "synthetic", domain: ".douyin.com", path: "/", expires: -1 },
        { name: "other", value: "never-retain", domain: "example.org", path: "/", expires: -1 },
      ] } : {}) });
      this.webContents = contents;
    }
    static fromWebContents(contents) { return windows.find(item => item.webContents === contents); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const loginSession = { setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() };
  const session = { fromPartition: vi.fn(() => loginSession) };
  const focusApp = vi.fn();
  return { windows, loginSession, session, focusApp, connect: createInAppBrowserConnector({ BrowserWindow, session, focusApp, saveDiagnostic }) };
}

describe("in-app Douyin login window", () => {
  it("uses a real Chrome UA of the same major version without Electron or the app name", () => {
    expect(chromeUserAgent("darwin", "150.0.7871.12")).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
    expect(chromeUserAgent("win32", "150.0.7871.12")).toContain("(Windows NT 10.0; Win64; x64)");
    expect(chromeUserAgent()).not.toMatch(/Electron|DouyinDataReview/u);
  });

  it("masks digits and drops scripts, styles and image data in local verification snapshots", () => {
    const html = maskDiagnostic('<div>手机号 182****8686，验证码 123456</div><script>secret()</script><style>.a{}</style><img src="data:image/png;base64,AAAA">');
    expect(html).toBe('<div>手机号 ***********，验证码 ******</div><img src="data:…">');
  });

  it("finds the page showing Douyin verification, reveals it and saves a masked snapshot once", async () => {
    vi.useFakeTimers();
    try {
      const saveDiagnostic = vi.fn(async () => {});
      const { windows, connect } = fakeElectron({ saveDiagnostic });
      const connection = await connect({ id: "app", label: "应用内登录", inApp: true });
      await connection.context.newPage();
      const [window] = windows; window.show = vi.fn(); window.focus = vi.fn();
      expect(await connection.verification()).toBe(false);
      const frame = { url: "https://rmc.bytedance.com/verifycenter/authentication?mobile=18200008686", executeJavaScript: vi.fn(async () => "<div>验证码 123456</div>") };
      window.webContents.mainFrame.framesInSubtree = [frame];
      expect(await connection.verification()).toBe(true);
      expect(await connection.verification()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(saveDiagnostic).toHaveBeenCalledOnce();
      expect(saveDiagnostic.mock.calls[0]).toEqual(["<div>验证码 ******</div>", "https://rmc.bytedance.com/verifycenter/authentication?mobile=***********"]);
      // 内容没变不重复存；换到下一步（比如输短信验证码）就再存一份
      await connection.verification(); await vi.advanceTimersByTimeAsync(3000);
      expect(saveDiagnostic).toHaveBeenCalledOnce();
      frame.executeJavaScript.mockResolvedValue("<div>输入验证码</div>");
      await connection.verification(); await vi.advanceTimersByTimeAsync(3000);
      expect(saveDiagnostic).toHaveBeenCalledTimes(2);
      await connection.revealVerification();
      expect(window.show).toHaveBeenCalled();
      await connection.disconnect();
    } finally { vi.useRealTimers(); }
  });

  it("only navigates the top frame to Douyin and its login domains over HTTPS", () => {
    for (const url of ["https://www.douyin.com/user/self", "https://sso.douyin.com/", "https://open.weixin.qq.com/connect"]) expect(isLoginUrl(url)).toBe(true);
    for (const url of ["http://www.douyin.com/", "https://evil-douyin.com/", "https://douyin.com.example.org/", "https://www.qq.com/", "file:///etc/passwd", "not a url"])
      expect(isLoginUrl(url)).toBe(false);
  });

  it("opens guarded pages in the isolated partition, scopes cookies and closes everything on disconnect", async () => {
    const { windows, loginSession, session, focusApp, connect } = fakeElectron();
    const connection = await connect({ id: "app", label: "应用内登录", inApp: true });
    expect(session.fromPartition).toHaveBeenCalledWith(LOGIN_PARTITION);
    expect(loginSession.setUserAgent.mock.calls[0][0]).not.toMatch(/Electron/u);
    const deny = vi.fn(); loginSession.setPermissionRequestHandler.mock.calls[0][0](null, "notifications", deny);
    expect(deny).toHaveBeenCalledWith(false);

    const page = await connection.context.newPage();
    const [window] = windows, contents = window.webContents;
    expect(window.options).toMatchObject({ show: false });
    expect(window.options.webPreferences).toMatchObject({ session: loginSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false });
    expect(window.options.webPreferences.preload).toBeUndefined();
    const commands = contents.debugger.sendCommand.mock.calls.map(([method]) => method);
    expect(commands).toEqual(expect.arrayContaining(["Network.enable", "Page.addScriptToEvaluateOnNewDocument", "Fetch.enable"]));

    // 窗口一直藏着，只有用户要验证时才亮出来
    window.show = vi.fn(); window.focus = vi.fn();
    await page.bringToFront();
    expect(window.show).not.toHaveBeenCalled();
    page.reveal();
    expect(window.show).toHaveBeenCalledOnce();
    contents.emit("did-frame-navigate", {}, "https://rmc.bytedance.com/verifycenter/captcha/v2?from=web");
    expect(window.show).toHaveBeenCalledTimes(2);
    const closing = { preventDefault: vi.fn() }; window.hide = vi.fn();
    window.emit("close", closing);
    expect(closing.preventDefault).toHaveBeenCalled(); expect(window.hide).toHaveBeenCalled(); expect(page.isClosed()).toBe(false);
    // 认出登录后藏起亮着的窗口、切回工作台；本来就藏着就什么都不动
    window.hide = vi.fn(); window.isVisible = () => true;
    page.conceal();
    expect(window.hide).toHaveBeenCalledOnce(); expect(focusApp).toHaveBeenCalledOnce();
    window.isVisible = () => false;
    page.conceal();
    expect(focusApp).toHaveBeenCalledOnce();

    const blocked = { preventDefault: vi.fn(), url: "https://example.org/", isMainFrame: true };
    contents.emit("will-navigate", blocked);
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(contents.openHandler({ url: "https://example.org/" })).toEqual({ action: "deny" });
    expect(contents.openHandler({ url: "https://open.weixin.qq.com/connect" }).action).toBe("allow");
    await expect(page.goto("https://example.org/")).rejects.toThrow("只能打开抖音页面");

    // Network events feed msToken capture and waitForResponse, with headers from ExtraInfo.
    const token = "a".repeat(120), url = `https://www.douyin.com/aweme/v1/web/history/read/?msToken=${token}`;
    const waiting = page.waitForResponse(response => response.url() === url);
    contents.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "1", request: { url, method: "GET", headers: { "User-Agent": "UA" } } });
    contents.debugger.emit("message", {}, "Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { "Accept-Language": "zh-CN" } });
    contents.debugger.emit("message", {}, "Network.responseReceived", { requestId: "1", response: { url, status: 200 } });
    const request = (await waiting).request();
    expect(await request.headerValue("accept-language")).toBe("zh-CN");
    expect(await request.headerValue("user-agent")).toBe("UA");
    expect(connection.context.directMsToken).toBe(token);

    await expect(connection.context.cookies(["https://example.org/"])).rejects.toThrow("只允许读取抖音登录态");
    expect((await connection.context.cookies()).map(cookie => cookie.name)).toEqual(["sessionid"]);

    await connection.context.newPage();
    const closed = vi.fn(); connection.context.once("close", closed);
    await connection.disconnect();
    expect(windows.every(item => item.destroyed)).toBe(true);
    expect(connection.connected).toBe(false);
    expect(closed).toHaveBeenCalled();
    await expect(connection.context.newPage()).rejects.toThrow("登录窗口已关闭");
  });
});
