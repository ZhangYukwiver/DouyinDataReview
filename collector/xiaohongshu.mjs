import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { BrowserConnectionError } from "./browserConnection.mjs";
import { contentOptions, noteLink, readContent, readNoteDetail, site, upstreamError } from "./xiaohongshuContent.mjs";

const api = "https://edith.xiaohongshu.com";
export const XIAOHONGSHU_LISTS = {
  favorites: { label: "收藏", endpoint: "/api/sns/web/v2/note/collect/page" },
  likes: { label: "点赞", endpoint: "/api/sns/web/v1/note/like/page" },
};
const ACTIVE = new Set(["starting", "login", "reading"]);

export const XIAOHONGSHU_READS = ["feed", "search", "detail", "comments", "profile"];

/** 认不出的错误只取第一行放进提示，用户反馈时能带上原因 */
export const errorCause = error => String(error?.message ?? error).split("\n")[0].replace(/\u001b\[[0-9;]*m/gu, "").slice(0, 100);

function loginRequired() {
  return new BrowserConnectionError("xiaohongshu_login_required", "还没登录小红书，或登录已失效。先在工作台「小红书」页扫码登录（或调用 POST /v1/xiaohongshu/login），再重试。");
}

// 无头 Chrome 的 UA 带 HeadlessChrome，小红书直接跳「安全限制」页；第一次启动时量出本机版本换成普通 Chrome 的写法。
// ponytail: 进程内缓存一次，换了 Chrome 版本要重启采集器才会更新
let userAgent = null;
async function launchContext(directory) {
  for (const channel of ["chrome", "msedge"]) {
    try {
      const open = options => chromium.launchPersistentContext(directory, { channel, headless: true, viewport: { width: 1280, height: 800 }, ...options });
      if (!userAgent) {
        const probe = await open({});
        try { userAgent = (await (probe.pages()[0] ?? await probe.newPage()).evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome"); }
        finally { await probe.close(); }
      }
      return await open({ userAgent });
    } catch { /* 没装这个浏览器就试下一个 */ }
  }
  throw new BrowserConnectionError("xiaohongshu_browser_unavailable", "没有找到可用的 Chrome 或 Edge。小红书导出要用本机 Chrome（Windows 也可用 Edge），装好后重试。", 503);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writeJson(file, value, signal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx", signal });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** 打开首页：已登录直接返回；没登录就把登录框里的二维码交给 onQr，等用户用手机扫。不给 onQr（读取）时没登录直接报错。 */
async function signIn(page, { onQr, signal, timeoutMs }) {
  // 被风控时首页会跳到「安全限制」页，goto 会因为跳转中断而报错：交给下面的轮询按地址判断
  await page.goto(site + "/explore", { waitUntil: "domcontentloaded" }).catch(() => {});
  // 页面偶尔同时挂着两个登录框或两个「我」，多个匹配时 isVisible 会抛严格模式错误：一律取第一个
  const me = page.getByRole("link", { name: "我", exact: true }).first();
  const qr = page.locator(".login-container img.qrcode-img").first();
  // 二维码上的状态层：过期时是「二维码已过期 / 点击刷新」，扫了之后提示去手机上确认
  const status = page.locator(".login-container .qrcode .status").first();
  const refresh = status.locator(".refresh").first();
  // 全新的浏览器配置里首页有两个 #login-btn（实测），点看得见的那个
  const loginButton = page.locator("#login-btn").filter({ visible: true }).first();
  let deadline = Date.now() + 30_000;
  let waiting = false;
  for (;;) {
    signal.throwIfAborted();
    const url = new URL(page.url());
    if (url.pathname.startsWith("/website-login/error")) {
      throw new BrowserConnectionError("xiaohongshu_blocked", `小红书拒绝了这次访问：${url.searchParams.get("error_msg") || "安全限制"}。稍后再试，或换个网络。`, 502);
    }
    if (await me.isVisible()) break;
    if (!onQr && (await qr.isVisible() || await loginButton.isVisible())) throw loginRequired();
    if (await qr.isVisible()) {
      if (!waiting) { waiting = true; deadline = Date.now() + timeoutMs; }
      if (await refresh.isVisible()) await refresh.click({ timeout: 1000 }).catch(() => {});
      else onQr(await qr.getAttribute("src", { timeout: 1000 }).catch(() => null), await status.isVisible() ? (await status.innerText().catch(() => "")).replace(/\s+/gu, " ").trim() : "");
    } else if (await loginButton.isVisible()) {
      await loginButton.click({ timeout: 1000 }).catch(() => {});
    }
    if (Date.now() > deadline) {
      throw waiting ? new BrowserConnectionError("xiaohongshu_login_required", "等了 10 分钟没有扫码，登录已取消。需要时再点一次扫码登录。")
        : upstreamError("小红书首页没有正常打开，请检查网络后重试。");
    }
    await page.waitForTimeout(800);
  }
  const href = new URL(await me.getAttribute("href"), site);
  const uid = /^\/user\/profile\/([a-zA-Z0-9_-]+)\/?$/u.exec(href.pathname)?.[1];
  if (href.origin !== site || !uid) throw upstreamError("无法确认当前小红书账号的个人主页。");
  return { me, uid };
}

async function readList(page, uid, config, responses, onPage) {
  const matches = (response, cursor) => {
    const url = new URL(response.url());
    return url.origin === api && url.pathname === config.endpoint && url.searchParams.get("user_id") === uid
      && (url.searchParams.get("cursor") || "") === cursor;
  };
  await page.locator(".reds-tab-item").filter({ hasText: new RegExp(`^${config.label}$`, "u") }).first().click();
  const notes = new Map();
  const seenCursors = new Set();
  let cursor = "";
  for (;;) {
    let response = responses.get(config.endpoint).get(cursor);
    if (!response) {
      const pending = page.waitForResponse(item => matches(item, cursor), { timeout: 20_000 });
      // 等待与翻页一起开始，避免快速响应落在监听器之前。
      const scroll = cursor ? page.locator(".user-page").evaluate(element => {
        element.scrollTo(0, element.scrollHeight);
      }) : Promise.resolve();
      [response] = await Promise.all([pending, scroll]).catch(() => {
        throw upstreamError(`没有收到本人${config.label}列表的${cursor ? "下一页" : "首页"}，请稍后重试。`);
      });
    }
    const reply = await response.json().catch(() => null);
    const data = reply?.data;
    if (!response.ok() || reply?.success !== true || reply.code !== 0 || !Array.isArray(data?.notes) || typeof data.has_more !== "boolean") {
      throw upstreamError(`小红书未能返回有效的${config.label}列表（HTTP ${response.status()}）。`);
    }
    for (const note of data.notes) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(note?.note_id ?? "")) throw upstreamError("小红书列表中有无法识别的笔记 ID。");
      notes.set(note.note_id, note);
    }
    onPage(notes.size);
    if (!data.has_more) return [...notes.values()];
    if (!data.cursor || typeof data.cursor !== "string" || seenCursors.has(data.cursor)) {
      throw upstreamError(`小红书${config.label}列表的分页游标没有前进。`);
    }
    cursor = data.cursor;
    seenCursors.add(cursor);
    // 网络响应可能早于页面渲染；等这一页最后一张卡片挂载再滚动到底部。
    const lastId = data.notes.at(-1)?.note_id;
    if (lastId && !responses.get(config.endpoint).has(cursor)) {
      await page.locator(`.note-item a[href$="/${lastId}"], .note-item a[href*="/${lastId}?"]`).first().waitFor({ state: "attached" });
    }
  }
}

async function readBody(page, note) {
  try {
    return (await readNoteDetail(page, { id: note.note_id, url: noteLink(note.note_id, note.xsec_token, "pc_user") })).body;
  } catch {
    if (page.isClosed()) throw upstreamError("小红书导出窗口已关闭。");
    return null;
  }
}

/**
 * 小红书导出：同一时间一个后台任务。只登录（lists 为空）和导出走同一条流程：
 * 打开无头浏览器 → 没登录就透传二维码等扫码 → 读本人主页的收藏/点赞列表 → 逐篇读正文 → 写导出文件，并入 latest.json 给看板用。
 */
export function createXiaohongshu({ dataDirectory, openContext = launchContext, loginTimeoutMs = 10 * 60_000 }) {
  const directory = path.join(dataDirectory, "xiaohongshu");
  const file = name => path.join(directory, name);
  let job = null;
  let controller = null;
  // 上一个任务的浏览器关干净了才开下一个（同一个浏览器配置目录只能开一个）
  let running = Promise.resolve();

  async function run(current, signal) {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const context = await openContext(file("browser-profile"));
    const close = () => context.close().catch(() => {});
    signal.addEventListener("abort", close, { once: true });
    try {
      signal.throwIfAborted();
      const page = context.pages()[0] ?? await context.newPage();
      const { me, uid } = await signIn(page, {
        signal, timeoutMs: loginTimeoutMs,
        onQr: (qr, note) => { if (qr?.startsWith("data:image/")) Object.assign(current, { state: "login", qr, message: note || "用小红书 App 扫码登录" }); },
      });
      Object.assign(current, { state: "reading", qr: null, message: "已登录，正在打开个人主页…" });
      const responses = new Map(current.lists.map(key => [XIAOHONGSHU_LISTS[key].endpoint, new Map()]));
      page.on("response", response => {
        const url = new URL(response.url());
        if (url.origin === api && url.searchParams.get("user_id") === uid) {
          responses.get(url.pathname)?.set(url.searchParams.get("cursor") || "", response);
        }
      });
      await me.click();
      const nickname = (await page.locator(".user-page .user-name").first().innerText({ timeout: 10_000 })).trim();
      const account = { user_id: uid, nickname };
      await writeJson(file("account.json"), { ...account, checked_at: new Date().toISOString() }, signal);
      current.account = account;
      if (!current.lists.length) {
        Object.assign(current, { state: "done", message: `已登录小红书：${nickname}` });
        return;
      }

      const cards = new Map();
      for (const key of current.lists) {
        const { label } = XIAOHONGSHU_LISTS[key];
        current.message = `正在读取${label}列表…`;
        cards.set(key, await readList(page, uid, XIAOHONGSHU_LISTS[key], responses, count => {
          current.message = `正在读取${label}列表，已读到 ${count} 篇`;
        }));
      }
      const unique = new Map([...cards.values()].flat().map(note => [note.note_id, note]));
      const bodies = new Map();
      const detailPage = await context.newPage();
      for (const note of unique.values()) {
        signal.throwIfAborted();
        Object.assign(current, { message: "正在读取笔记正文", progress: { done: bodies.size, total: unique.size } });
        bodies.set(note.note_id, await readBody(detailPage, note));
      }
      current.progress = null;

      const exportedAt = new Date().toISOString();
      const output = { exported_at: exportedAt, account, lists: {} };
      for (const [key, notes] of cards) {
        output.lists[key] = {
          exported_at: exportedAt,
          notes: notes.map(note => ({
            note_id: note.note_id, title: note.display_title, type: note.type,
            author: note.user?.nickname ?? note.user?.nick_name, author_id: note.user?.user_id,
            cover: note.cover?.url_default || note.cover?.url_pre || note.cover?.url || null,
            body: bodies.get(note.note_id), url: noteLink(note.note_id, note.xsec_token, "pc_user"),
            liked_by_account: note.interact_info?.liked, liked_count: note.interact_info?.liked_count,
          })),
        };
      }
      signal.throwIfAborted();
      const saved = file(`notes-${exportedAt.replace(/[:.]/gu, "-")}.json`);
      await writeJson(saved, output, signal);
      // 看板看每类最近一次导出；换了账号就不留旧账号的另一类
      const previous = await readJson(file("latest.json"));
      const kept = previous?.account?.user_id === uid ? previous.lists ?? {} : {};
      await writeJson(file("latest.json"), { ...output, lists: { ...kept, ...output.lists } }, signal);
      const counts = Object.entries(output.lists).map(([key, list]) => `${XIAOHONGSHU_LISTS[key].label} ${list.notes.length} 篇`).join("、");
      Object.assign(current, { state: "done", file: saved, message: `导出完成：${counts}` });
    } finally {
      signal.removeEventListener("abort", close);
      await close();
    }
  }

  const busy = () => job && ACTIVE.has(job.state);
  const busyError = () => new BrowserConnectionError("xiaohongshu_busy", "小红书正在登录或导出，等它结束或先取消。");

  return {
    async status() {
      return { job: job && { ...job }, account: await readJson(file("account.json")) };
    },
    latest: () => readJson(file("latest.json")),
    /** lists 为空数组 = 只扫码登录 */
    start(lists) {
      if (!Array.isArray(lists) || lists.some(key => typeof key !== "string" || !Object.hasOwn(XIAOHONGSHU_LISTS, key))) {
        throw new BrowserConnectionError("invalid_request", "lists 应为由 favorites、likes 组成的数组。", 400);
      }
      if (busy()) throw busyError();
      const current = { id: randomUUID(), lists: [...new Set(lists)], state: "starting", message: "正在打开小红书…", qr: null, progress: null, account: null, file: null };
      job = current;
      controller = new AbortController();
      const { signal } = controller;
      const previous = running;
      running = previous.then(() => run(current, signal)).catch(error => {
        if (!signal.aborted && !(error instanceof BrowserConnectionError)) console.warn("[xiaohongshu]", error);
        Object.assign(current, signal.aborted
          ? { state: "cancelled", message: "已取消。" }
          : { state: "failed", message: error instanceof BrowserConnectionError ? error.message : `小红书${current.lists.length ? "导出" : "登录"}中断，请重试（${errorCause(error)}）。` });
      }).finally(() => { current.qr = null; current.progress = null; });
      return { ...current };
    },
    /** 推荐、搜索、详情、评论、主页：一次开一个无头浏览器读完就关，要先扫码登录过 */
    async read(action, body, signal) {
      if (!XIAOHONGSHU_READS.includes(action)) throw new BrowserConnectionError("invalid_request", "未知的小红书读取操作。", 400);
      const options = contentOptions(action, body);
      if (busy()) throw busyError();
      // ponytail: 每次读取都冷启动浏览器（约 5 秒）；要更快就留一个空闲一分钟再关的会话
      const task = running.then(async () => {
        signal.throwIfAborted();
        const profile = file("browser-profile");
        if (!await stat(profile).then(() => true, () => false)) throw loginRequired();
        const context = await openContext(profile);
        const close = () => context.close().catch(() => {});
        signal.addEventListener("abort", close, { once: true });
        try {
          const page = context.pages()[0] ?? await context.newPage();
          return await readContent(action, options, { page, ...await signIn(page, { signal, timeoutMs: 0 }) });
        } finally {
          signal.removeEventListener("abort", close);
          await close();
        }
      });
      running = task.catch(() => {});
      return task;
    },
    cancel() {
      controller?.abort();
      if (busy()) Object.assign(job, { state: "cancelled", message: "已取消。", qr: null, progress: null });
    },
    async logout() {
      if (busy()) throw busyError();
      await running;
      await rm(file("browser-profile"), { recursive: true, force: true });
      await rm(file("account.json"), { force: true });
      job = null;
    },
  };
}
