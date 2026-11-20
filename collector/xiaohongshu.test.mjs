import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXiaohongshu } from "./xiaohongshu.mjs";

const api = "https://edith.xiaohongshu.com";
const endpoints = { 收藏: "/api/sns/web/v2/note/collect/page", 点赞: "/api/sns/web/v1/note/like/page" };
const note = (id, extra = {}) => ({ note_id: id, display_title: `标题${id}`, type: "normal", user: { nickname: "作者A", user_id: "a1" }, xsec_token: "tok", interact_info: { liked_count: "1.2万" }, ...extra });

/** 假的无头浏览器：没登录时出二维码，scan() 之后算登录；点主页页签就把对应列表作为接口响应发出去 */
function fakeBrowser({ uid = "u1", notes }) {
  let loggedIn = false;
  let url = "about:blank";
  let release = () => {};
  const listeners = [];
  const el = ({ visible = () => true, attr = () => null, click = () => {}, text = "", value } = {}) => ({
    isVisible: async () => visible(), getAttribute: async () => attr(), click: async () => click(), waitFor: async () => {},
    innerText: async () => text, evaluate: async () => value, first() { return this; }, filter() { return this; }, locator() { return el({ visible: () => false }); },
  });
  const page = {
    url: () => url,
    goto: async next => { url = next; },
    getByRole: () => el({ visible: () => loggedIn, attr: () => `/user/profile/${uid}` }),
    locator: selector => {
      if (selector.includes("qrcode-img")) return el({ visible: () => !loggedIn, attr: () => "data:image/png;base64,QR" });
      if (selector === ".user-page .user-name") return el({ text: " 小明 " });
      if (selector === ".note-container") return el({ value: { title: "标题", body: "正文 #旅行 #露营", liked_count: "1.2万" } });
      if (selector === ".reds-tab-item") return { filter: ({ hasText }) => el({ click: () => {
        const label = hasText.test("收藏") ? "收藏" : "点赞";
        const response = { url: () => `${api}${endpoints[label]}?user_id=${uid}&cursor=`, ok: () => true, status: () => 200,
          json: async () => ({ success: true, code: 0, data: { notes: notes[label], has_more: false } }) };
        for (const listener of listeners) listener(response);
      } }) };
      return el({ visible: () => false });
    },
    // 等扫码时每轮都卡在这里，测试里 scan() 放行
    waitForTimeout: () => (loggedIn ? Promise.resolve() : new Promise(resolve => { release = resolve; })),
    on: (_, listener) => listeners.push(listener),
    isClosed: () => false,
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => { release(); } };
  return { openContext: async () => context, scan: () => { loggedIn = true; release(); } };
}

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function until(xhs, check, accountId) {
  for (let i = 0; i < 200; i++) {
    const status = await xhs.status(accountId);
    if (check(status.job)) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("timeout: " + JSON.stringify((await xhs.status()).job));
}

describe("小红书导出任务", () => {
  it("同步时切换同名账号、退出再扫码时保持原导出的归属", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "xhs-two-"));
    dirs.push(dataDirectory);
    const first = fakeBrowser({ uid: "user-one", notes: { 收藏: [note("first-note")] } });
    const second = fakeBrowser({ uid: "user-two", notes: { 收藏: [note("second-note")] } });
    const profiles = new Set();
    let primaryBrowser = first;
    const xhs = createXiaohongshu({ dataDirectory, openContext: directory => {
      profiles.add(directory);
      return (directory.includes(path.sep + "accounts" + path.sep) ? second : primaryBrowser).openContext();
    } });
    const other = await xhs.createAccount();
    xhs.start(["favorites"], "default");
    await until(xhs, job => job?.state === "login", "default");
    await xhs.activateAccount(other.id);
    expect((await xhs.status(other.id)).job).toBeNull();
    first.scan();
    expect((await until(xhs, job => job?.state === "done", "default")).account.user_id).toBe("user-one");
    second.scan();
    xhs.start(["favorites"], other.id);
    await until(xhs, job => job?.state === "done", other.id);
    expect(profiles.size).toBe(2);
    expect((await xhs.accounts()).accounts.map(a => a.nickname)).toEqual(["小明", "小明"]);
    await xhs.logout("default");
    expect((await xhs.status("default")).account).toBeNull();
    primaryBrowser = second;
    xhs.start(["favorites"], "default");
    expect((await until(xhs, job => job?.state === "failed", "default")).job.message).toMatch(/不一致/u);
    primaryBrowser = first;
    xhs.start([], "default");
    expect((await until(xhs, job => job?.state === "done", "default")).account.user_id).toBe("user-one");
    expect((await xhs.latest("default")).lists.favorites.notes[0].note_id).toBe("first-note");
    expect((await xhs.latest(other.id)).lists.favorites.notes[0].note_id).toBe("second-note");
    expect((await xhs.accounts()).activeId).toBe(other.id);
  });

  it("透传二维码，扫码后导出两类，再单导一类时另一类留在看板数据里", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "xhs-"));
    dirs.push(dataDirectory);
    const browser = fakeBrowser({ notes: { 收藏: [note("n1"), note("n2", { type: "video" })], 点赞: [note("n2")] } });
    const xhs = createXiaohongshu({ dataDirectory, openContext: browser.openContext });

    expect(() => xhs.start(["comments"])).toThrow(/favorites/u);
    xhs.start(["favorites", "likes"]);
    const waiting = await until(xhs, job => job.state === "login");
    expect(waiting.job.qr).toBe("data:image/png;base64,QR");
    expect(() => xhs.start(["likes"])).toThrow(/正在登录或导出/u);
    browser.scan();
    const done = await until(xhs, job => job.state === "done");
    expect(done.job.message).toBe("导出完成：收藏 2 篇、点赞 1 篇");
    expect(done.account).toMatchObject({ user_id: "u1", nickname: "小明" });

    const latest = await xhs.latest();
    expect(latest.lists.favorites.notes[1]).toMatchObject({ note_id: "n2", type: "video", author: "作者A", body: "正文 #旅行 #露营", liked_count: "1.2万",
      url: "https://www.xiaohongshu.com/explore/n2?xsec_token=tok&xsec_source=pc_user" });
    expect(JSON.parse(await readFile(done.job.file, "utf8")).lists.likes.notes).toHaveLength(1);

    // 已登录：直接导出，不出二维码；收藏那份留着
    xhs.start(["likes"]);
    await until(xhs, job => job.state === "done" && job.lists.length === 1);
    const merged = await xhs.latest();
    expect(Object.keys(merged.lists).sort()).toEqual(["favorites", "likes"]);
    expect((await readdir(path.join(dataDirectory, "xiaohongshu"))).filter(name => name.startsWith("notes-"))).toHaveLength(2);
  });

  it("等扫码时可以取消，退出登录清掉账号", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "xhs-"));
    dirs.push(dataDirectory);
    const browser = fakeBrowser({ notes: { 收藏: [], 点赞: [] } });
    const xhs = createXiaohongshu({ dataDirectory, openContext: browser.openContext });
    xhs.start([]);
    await until(xhs, job => job.state === "login");
    xhs.cancel();
    const status = await until(xhs, job => job.state === "cancelled");
    expect(status.job.qr).toBeNull();

    xhs.start([]);
    await until(xhs, job => job.state === "login");
    browser.scan();
    expect((await until(xhs, job => job.state === "done")).account.nickname).toBe("小明");
    await xhs.logout();
    expect(await xhs.status()).toEqual({ job: null, account: null });
  });

  it("读取要先登录：没登录过不开浏览器，登录页出现就报未登录，登录后读详情", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "xhs-"));
    dirs.push(dataDirectory);
    const launch = vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(new Error("no chrome"));
    try {
      const real = createXiaohongshu({ dataDirectory });
      const signal = new AbortController().signal;
      await expect(real.read("feed", {}, signal)).rejects.toMatchObject({ code: "xiaohongshu_login_required" });
      expect(launch).not.toHaveBeenCalled();
      await expect(real.read("search", {}, signal)).rejects.toMatchObject({ status: 400 });
      await mkdir(path.join(dataDirectory, "xiaohongshu", "browser-profile"), { recursive: true });
      await expect(real.read("feed", {}, signal)).rejects.toMatchObject({ code: "xiaohongshu_browser_unavailable" });
      expect(launch).toHaveBeenCalledWith(path.join(dataDirectory, "xiaohongshu", "browser-profile"), expect.objectContaining({ headless: true }));
    } finally { launch.mockRestore(); }

    const browser = fakeBrowser({ notes: { 收藏: [], 点赞: [] } });
    const xhs = createXiaohongshu({ dataDirectory, openContext: browser.openContext });
    const url = "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(xhs.read("detail", { url }, new AbortController().signal)).rejects.toMatchObject({ code: "xiaohongshu_login_required" });
    browser.scan();
    expect(await xhs.read("detail", { url: url + "?xsec_token=t&xsec_source=pc_feed" }, new AbortController().signal)).toMatchObject({
      note_id: "aaaaaaaaaaaaaaaaaaaaaaaa", url: url + "?xsec_token=t&xsec_source=pc_feed", body: "正文 #旅行 #露营" });
  });

  it("认不出的错误把第一行原因带进提示", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "xhs-"));
    dirs.push(dataDirectory);
    const browser = fakeBrowser({ notes: { 收藏: [], 点赞: [] } });
    const context = await browser.openContext();
    const page = context.pages()[0];
    page.getByRole = () => ({ first: () => ({ isVisible: async () => { throw new Error("\u001b[2mlocator.isVisible: strict mode violation\u001b[22m\n  call log"); } }) });
    const xhs = createXiaohongshu({ dataDirectory, openContext: async () => context });
    xhs.start([]);
    const status = await until(xhs, job => job.state === "failed");
    expect(status.job.message).toBe("小红书登录中断，请重试（locator.isVisible: strict mode violation）。");
  });
});
