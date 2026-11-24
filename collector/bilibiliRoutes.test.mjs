import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createBilibiliRoutes } from "./bilibiliRoutes.mjs";

async function root() { return mkdtemp(path.join(tmpdir(), "bilibili-routes-")); }

const BVID = "BV1abCDefGHi";
const nav = {
  isLogin: true, mid: 123,
  wbi_img: { img_url: `https://i0.hdslb.com/${"a".repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${"b".repeat(32)}.png` },
};

function protocolContext(upstream) {
  return {
    request: {
      fetch: vi.fn(async (url, options) => {
        const target = new URL(url);
        const { status = 200, data, body = JSON.stringify({ code: 0, data }) } = await upstream(target, options);
        return { status: () => status, text: async () => body, dispose: async () => {} };
      }),
    },
    cookies: async () => [{ name: "bili_jct", value: "test-only-csrf" }],
    close: vi.fn(async () => {}),
  };
}

const request = (routes, route, body, options) => routes.handle({ method: "POST", pathname: `/v1/bilibili${route}`, body, ...options });

describe("bilibili route adapter", () => {
  it("keeps the normal entry closed until explicitly enabled", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: true })).toMatchObject({ status: 404, body: { error: "bilibili_not_released" } });
      expect(await routes.handle({ method: "GET", pathname: "/v1/health", loopback: true })).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("restricts every matching route to the local machine", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: false })).toMatchObject({ status: 403, body: { error: "loopback_only" } });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: true })).toMatchObject({ status: 200, body: { account: null, snapshot: null, job: null } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects unsafe unregistered ids and retries a failed content-library callback", async () => {
    const directory = await root();
    let attempts = 0;
    try {
      const routes = createBilibiliRoutes({
        dataDirectory: directory,
        enabled: true,
        contentLibrary: { manualSave: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary library failure"); } },
      });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", searchParams: new URLSearchParams("account=../escape"), loopback: true })).toMatchObject({ status: 400, body: { error: "invalid_account" } });
      await routes.service.save("default", { bvid: "BV1abCDefGHi", title: "手动保存" });
      expect(attempts).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not let one account cancel another account's task", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true });
      routes.service.jobs.set("other-account-job", { accountId: "other", controller: { abort() {} } });
      expect(await routes.handle({ method: "POST", pathname: "/v1/bilibili/cancel", body: { account: "default", jobId: "other-account-job" }, loopback: true })).toMatchObject({
        status: 409, body: { error: "bilibili_account_mismatch" },
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses the registry platform root directly for the profile and snapshot", async () => {
    const directory = await root();
    const registry = {
      activeId: "default",
      get: id => id === "default" ? { id, platform: "bilibili" } : null,
      directory: account => path.join(directory, account.id === "default" ? "" : path.join("accounts", account.id)),
    };
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, accountRegistry: registry, enabled: true });
      await routes.service.save("default", { bvid: "BV1abCDefGHi", title: "手动保存" });
      await expect(access(path.join(directory, "snapshot.json"))).resolves.toBeUndefined();
      await expect(access(path.join(directory, "bilibili", "snapshot.json"))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("validates before opening a profile and reads through signed, fixed platform routes", async () => {
    const directory = await root();
    const context = protocolContext(target => {
      if (target.pathname === "/x/web-interface/nav") return { data: nav };
      if (target.pathname === "/x/web-interface/wbi/search/type") return { data: { result: [] } };
      if (target.pathname === "/x/web-interface/wbi/search/square") return { data: { trending: { list: [] } } };
      throw new Error(`unexpected ${target.pathname}`);
    });
    const openContext = vi.fn(async () => context);
    const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true, openContext });
    try {
      expect(await request(routes, "/search", { keyword: "", url: "https://example.com" })).toMatchObject({ status: 400 });
      expect(await request(routes, "/feed", [], {})).toMatchObject({ status: 400 });
      expect(await request(routes, "/feed", {}, { loopback: false })).toMatchObject({ status: 403 });
      expect(await request(routes, "/feed", {}, { accountChanging: true })).toMatchObject({ status: 409 });
      expect(await request(routes, "/interact", { action: "like", bvid: BVID, enabled: true })).toMatchObject({ status: 400 });
      expect(openContext).not.toHaveBeenCalled();

      expect(await request(routes, "/search", { keyword: "教程 & 音乐", type: "bili_user", page: 2 })).toEqual({
        status: 200, body: { accountId: "default", data: { result: [] } },
      });
      const [url, options] = context.request.fetch.mock.calls[1];
      const target = new URL(url);
      expect(target.origin).toBe("https://api.bilibili.com");
      expect(Object.fromEntries(target.searchParams)).toMatchObject({
        keyword: "教程 & 音乐", search_type: "bili_user", page: "2", w_rid: expect.stringMatching(/^[a-f0-9]{32}$/u),
      });
      expect(options).toMatchObject({ method: "GET", maxRedirects: 0, maxRetries: 0 });
      expect(await request(routes, "/hot", {})).toMatchObject({ status: 200, body: { data: { trending: { list: [] } } } });
    } finally { await routes.service.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("binds writes to the linked account and sends the CSRF token only to the upstream request", async () => {
    const directory = await root();
    let mid = 456;
    const registry = { activeId: "default", get: id => ({ id, uid: "123" }), directory: () => directory };
    const context = protocolContext(target => {
      if (target.pathname === "/x/web-interface/nav") return { data: { ...nav, mid } };
      if (target.pathname === "/x/web-interface/view") return { data: { aid: 987 } };
      if (target.pathname === "/x/v2/reply/add") return { body: '{"code":0,"data":{"rpid":90071992547409931}}' };
      throw new Error(`unexpected ${target.pathname}`);
    });
    const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true, accountRegistry: registry, openContext: async () => context });
    const body = { accountId: "default", action: "comment", bvid: BVID, root: "111", text: "测试评论" };
    try {
      expect(await request(routes, "/interact", body)).toMatchObject({ status: 409, body: { error: "bilibili_account_mismatch" } });
      expect(context.request.fetch).toHaveBeenCalledTimes(1);
      mid = 123;
      expect(await request(routes, "/interact", body)).toEqual({ status: 200, body: { accountId: "default", data: { rpid: "90071992547409931" } } });
      expect(context.request.fetch.mock.lastCall).toMatchObject([
        "https://api.bilibili.com/x/v2/reply/add",
        { method: "POST", form: { oid: "987", type: "1", root: "111", parent: "111", message: "测试评论", csrf: "test-only-csrf" } },
      ]);
    } finally { await routes.service.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("loads subtitle cues from a returned B 站 CDN track only", async () => {
    const directory = await root();
    const cues = [{ from: 0, to: 2.5, content: "测试字幕" }];
    const cdnFetch = vi.fn(async () => new Response(JSON.stringify({ body: cues }), { status: 200 }));
    let subtitleUrl = "//aisubtitle.hdslb.com/bfs/ai_subtitle/a.json";
    const context = protocolContext(target => {
      if (target.pathname === "/x/web-interface/nav") return { data: nav };
      if (target.pathname === "/x/player/wbi/v2") return { data: { subtitle: { subtitles: [{ lan: "zh-CN", subtitle_url: subtitleUrl }] } } };
      throw new Error(`unexpected ${target.pathname}`);
    });
    const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true, openContext: async () => context });
    vi.stubGlobal("fetch", cdnFetch);
    try {
      const body = { bvid: BVID, cid: "678", language: "zh-CN" };
      expect(await request(routes, "/subtitles", body)).toMatchObject({ status: 200, body: { data: { cues } } });
      expect(String(cdnFetch.mock.lastCall[0])).toBe(`https:${subtitleUrl}`);
      expect(cdnFetch.mock.lastCall[1].redirect).toBe("error");
      subtitleUrl = "http://127.0.0.1/bfs/ai_subtitle/a.json";
      expect(await request(routes, "/subtitles", body)).toMatchObject({ status: 502, body: { error: "bilibili_upstream_failed" } });
      expect(cdnFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await routes.service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes a profile while letting another account read, then releases it after throttling", async () => {
    const directory = await root();
    const firstRead = Promise.withResolvers();
    const releaseFirst = Promise.withResolvers();
    const otherId = "abcdef123456";
    const openContext = vi.fn(async profile => protocolContext(async target => {
      if (target.pathname === "/x/web-interface/nav") return { data: nav };
      if (target.pathname !== "/x/space/like/video") throw new Error(`unexpected ${target.pathname}`);
      if (path.basename(path.dirname(profile)) === otherId) return { data: [] };
      firstRead.resolve();
      await releaseFirst.promise;
      return { status: 412, body: "" };
    }));
    const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true, openContext });
    try {
      const first = request(routes, "/likes/recent", { accountId: "default" });
      await firstRead.promise;
      const second = request(routes, "/likes/recent", { accountId: "default" });
      const other = await request(routes, "/likes/recent", { accountId: otherId });
      expect(other).toEqual({ status: 200, body: { accountId: otherId, data: [] } });
      expect(routes.service.busy("default")).toBe(true);
      expect(openContext).toHaveBeenCalledTimes(2);
      releaseFirst.resolve();
      expect(await first).toMatchObject({ status: 429, body: { error: "bilibili_rate_limited" } });
      expect(await second).toMatchObject({ status: 429 });
      expect(routes.service.busy("default")).toBe(false);
    } finally {
      releaseFirst.resolve();
      await routes.service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

