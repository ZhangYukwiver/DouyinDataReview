// 应用里的抖音登录，替代「在 Chrome/Edge 打开远程调试」这一步。抖音网页开在一个不显示的窗口里，
// 登录框的二维码交给工作台页面显示（collector/browserLogin.mjs 的 readLoginQrCode），要验证时才把窗口亮出来。
// 只实现导入凭据链路实际用到的那一小块 Playwright Page/Context 接口，外面照常套
// collector/browserConnection.mjs 的 BorrowedContext；不是通用兼容层。
// 不开 remote-debugging-port：CDP 只走每个窗口自己的 webContents.debugger。
import { EventEmitter } from "node:events";
import { BorrowedContext, BrowserConnectionError } from "../collector/browserConnection.mjs";

export const LOGIN_PARTITION = "persist:douyin-login";
// 顶层页面只许去抖音和登录相关的域；验证码这类子框架不拦
const LOGIN_HOSTS = ["douyin.com", "iesdouyin.com", "snssdk.com", "amemv.com", "bytedance.com", "zijieapi.com", "toutiao.com",
  "open.weixin.qq.com", "graph.qq.com", "ptlogin2.qq.com", "api.weibo.com", "passport.weibo.com"];

export function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LOGIN_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

// 和内核同一个大版本的真 Chrome UA，不带 Electron 和应用名
export function chromeUserAgent(platform = process.platform, chrome = process.versions.chrome) {
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(chrome).split(".")[0]}.0.0.0 Safari/537.36`;
}

// 在页面里近似 getByRole/getByLabel/getByTitle/getByText/locator(css)：只认导入链路用到的几种角色，
// 名字取 aria-label 或文字，exact 时整串相等、否则不分大小写包含
function domQuery({ query, index, action, name }) {
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const matches = (value, wanted, exact) => exact ? clean(value) === wanted : clean(value).toLowerCase().includes(String(wanted).toLowerCase());
  const roles = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", menuitem: "[role=menuitem]", tab: "[role=tab]" };
  let found;
  if (query.css) found = [...document.querySelectorAll(query.css)];
  else if (query.role) found = [...document.querySelectorAll(roles[query.role] ?? ":not(*)")]
    .filter(element => matches(element.getAttribute("aria-label") || element.textContent || element.value || element.title, query.name, query.exact));
  else if (query.label) found = [...document.querySelectorAll("[aria-label]")].filter(element => matches(element.getAttribute("aria-label"), query.label, query.exact));
  else if (query.title) found = [...document.querySelectorAll("[title]")].filter(element => matches(element.title, query.title, query.exact));
  else found = [...document.body.querySelectorAll("*")].filter(element => matches(element.textContent, query.text, query.exact)
    && ![...element.children].some(child => matches(child.textContent, query.text, query.exact)));
  if (query.hasText) found = found.filter(element => matches(element.textContent, query.hasText, false));
  if (action === "count") return found.length;
  const element = found[index];
  if (!element) return null;
  if (action === "attribute") return element.getAttribute(name);
  if (action === "text") return element.innerText;
  const box = element.getBoundingClientRect();
  if (action === "visible") return box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true });
  element.scrollIntoView({ block: "center", inline: "center" });
  const point = element.getBoundingClientRect();
  return { x: point.x + point.width / 2, y: point.y + point.height / 2 };
}

class Locator {
  constructor(page, query, index = 0) { this.page = page; this.query = query; this.index = index; }
  run(action, name) { return this.page.evaluate(domQuery, { query: this.query, index: this.index, action, name }); }
  filter({ hasText }) { return new Locator(this.page, { ...this.query, hasText }, this.index); }
  nth(index) { return new Locator(this.page, this.query, index); }
  count() { return this.run("count"); }
  async isVisible() { return await this.run("visible") === true; }
  getAttribute(name) { return this.run("attribute", name); }
  async innerText() {
    const text = await this.run("text");
    if (text === null) throw new Error("element_not_found");
    return text;
  }
  // 真实鼠标事件（isTrusted），和 Playwright 的 click 一样
  async click() {
    const point = await this.run("point");
    if (!point) throw new Error("element_not_found");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.page.send("Input.dispatchMouseEvent", { type, ...point, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
}

const lowerHeaders = headers => Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
const requestView = item => ({ url: () => item.url, method: () => item.method, headerValue: async name => item.headers[name.toLowerCase()] ?? null });

class InAppPage extends EventEmitter {
  constructor(window, raw, focusApp) {
    super();
    this.window = window; this.contents = window.webContents; this.raw = raw; this.focusApp = focusApp;
    this.sessions = new Set(); this.requests = new Map(); this.closed = false;
    window.once("closed", () => this.markClosed());
    this.contents.debugger.on("message", (_event, method, params) => this.receive(method, params));
  }

  async open() {
    await this.contents.loadURL("about:blank");
    this.contents.debugger.attach("1.3");
    await Promise.all(["Network.enable", "Page.enable"].map(method => this.send(method)));
    return this;
  }

  send(method, params = {}) { return this.contents.debugger.sendCommand(method, params); }

  receive(method, params) {
    for (const session of this.sessions) session.emit(method, params);
    const entry = id => this.requests.get(id) ?? this.requests.set(id, { headers: {} }).get(id);
    if (method === "Network.requestWillBeSent") {
      const item = entry(params.requestId);
      item.url = params.request.url; item.method = params.request.method;
      // 完整请求头（含 accept-language）在 ExtraInfo 里，可能先到
      item.headers = { ...lowerHeaders(params.request.headers), ...item.headers };
      this.emit("request", requestView(item));
    } else if (method === "Network.requestWillBeSentExtraInfo") Object.assign(entry(params.requestId).headers, lowerHeaders(params.headers));
    else if (method === "Network.responseReceived") {
      const item = entry(params.requestId);
      this.emit("response", { url: () => params.response.url, status: () => params.response.status, request: () => requestView(item) });
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") this.requests.delete(params.requestId);
  }

  cdpSession() {
    const session = new EventEmitter();
    session.send = (method, params) => this.send(method, params);
    session.detach = async () => { this.sessions.delete(session); };
    this.sessions.add(session);
    return session;
  }

  context() { return this.raw; }
  isClosed() { return this.closed; }
  url() { return this.closed ? "" : this.contents.getURL(); }
  async title() { return this.closed ? "" : this.contents.getTitle(); }
  frames() { return this.closed ? [] : this.contents.mainFrame.framesInSubtree.map(frame => ({ url: () => frame.url })); }
  // 窗口一直藏着，扫码在工作台里完成；碰到验证或想用验证码登录时，用户点了才 reveal
  async bringToFront() {}
  reveal() { if (!this.closed) { this.window.show(); this.window.focus(); } }
  // 认出登录后把亮着的窗口藏回去、切回工作台，用户直接在设置里确认账号
  conceal() {
    if (this.closed || !this.window.isVisible()) return;
    this.window.hide();
    this.focusApp?.();
  }
  async addInitScript(script) { await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${script})();` }); }

  async evaluate(script, argument) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(${script})(${argument === undefined ? "" : JSON.stringify(argument)})`, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "evaluate_failed");
    return result.value;
  }

  // 等到 DOMContentLoaded 就返回，和调用方的 waitUntil: "domcontentloaded" 一致
  async goto(url, { timeout = 30_000 } = {}) {
    if (!isLoginUrl(url)) throw new BrowserConnectionError("navigation_blocked", "登录窗口只能打开抖音页面。");
    let timer, ready;
    const loading = this.contents.loadURL(url);
    loading.catch(() => {});
    try {
      await Promise.race([
        loading,
        new Promise(resolve => { ready = resolve; this.contents.once("dom-ready", resolve); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`页面加载超过 ${timeout} 毫秒`), { name: "TimeoutError" })), timeout); }),
      ]);
    } finally { clearTimeout(timer); this.contents.off("dom-ready", ready); }
  }

  waitForResponse(predicate, { timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); this.off("response", check); this.off("close", closed); };
      const check = response => { if (predicate(response)) { stop(); resolve(response); } };
      const closed = () => { stop(); reject(new Error("page_closed")); };
      const timer = setTimeout(() => { stop(); reject(Object.assign(new Error("等待响应超时"), { name: "TimeoutError" })); }, timeout);
      this.on("response", check); this.once("close", closed);
    });
  }

  getByRole(role, { name, exact = false } = {}) { return new Locator(this, { role, name, exact }); }
  getByLabel(label, { exact = false } = {}) { return new Locator(this, { label, exact }); }
  getByTitle(title, { exact = false } = {}) { return new Locator(this, { title, exact }); }
  getByText(text, { exact = false } = {}) { return new Locator(this, { text, exact }); }
  locator(css) { return new Locator(this, { css }); }

  async close() {
    if (!this.closed && !this.window.isDestroyed()) this.window.destroy();
    this.markClosed();
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true; this.sessions.clear(); this.requests.clear();
    this.emit("close");
  }
}

export function createInAppBrowserConnector({ BrowserWindow, session, focusApp }) {
  let loginSession = null;
  // 第一次用时才建（要等 app ready）；登录态存在独立分区里，和工作台页面、其他账号目录都分开
  const prepare = () => {
    if (loginSession) return loginSession;
    loginSession = session.fromPartition(LOGIN_PARTITION);
    loginSession.setUserAgent(chromeUserAgent(), "zh-CN,zh");
    loginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    loginSession.setPermissionCheckHandler(() => false);
    loginSession.on("will-download", event => event.preventDefault());
    return loginSession;
  };

  return async function connectInAppBrowser(source, { fresh = false } = {}) {
    // 换号：清掉这个分区本地的 Cookie 和存储，抖音认不出上次的号就会给新二维码。不调抖音的退出接口，
    // 已导入账号的凭据存在各自的账号目录（direct-session.json），服务端会话照旧有效
    if (fresh) await prepare().clearStorageData();
    // 不显示的窗口照常跑计时器、页面也当自己可见，二维码轮询和安全组件初始化才不会被拖慢
    const preferences = { session: prepare(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
    const pages = new Set(), popups = new Set();
    let closed = false;
    const guard = contents => {
      const block = (event, url) => { if (event.isMainFrame !== false && !isLoginUrl(event.url ?? url)) event.preventDefault(); };
      contents.on("will-navigate", block);
      contents.on("will-redirect", block);
      // 抖音要安全验证时（验证框是 verifycenter/captcha 子框架）把窗口亮出来让用户自己做，登录和导入都接着等
      contents.on("did-frame-navigate", (_event, url) => { if (/\/(?:verifycenter|captcha)\//iu.test(url)) BrowserWindow.fromWebContents(contents)?.show(); });
      // 第三方登录弹窗用同一个分区，同样只许去登录相关的域
      contents.setWindowOpenHandler(({ url }) => isLoginUrl(url)
        ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: preferences } } : { action: "deny" });
      contents.on("did-create-window", child => {
        popups.add(child); child.once("closed", () => popups.delete(child));
        guard(child.webContents);
      });
    };
    const raw = {
      async newPage() {
        if (closed) throw new BrowserConnectionError("browser_disconnected", "登录窗口已关闭，请重新登录。");
        const window = new BrowserWindow({ width: 1080, height: 760, show: false, title: "登录抖音", autoHideMenuBar: true, webPreferences: preferences });
        guard(window.webContents);
        // 用户关掉亮出来的窗口只是藏回去，不打断登录；断开时 destroy 不走这里
        window.on("close", event => { event.preventDefault(); window.hide(); });
        const page = new InAppPage(window, raw, focusApp);
        pages.add(page); page.once("close", () => pages.delete(page));
        try { return await page.open(); }
        catch (error) { await page.close(); throw error; }
      },
      async newCDPSession(page) { return page.cdpSession(); },
    };
    const context = new BorrowedContext(raw);
    return {
      browser: source.id, label: source.label, context,
      get connected() { return !closed; },
      async disconnect() {
        if (closed) return;
        closed = true;
        for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
        await Promise.allSettled([...pages].map(page => page.close()));
        context.emit("close");
      },
    };
  };
}
