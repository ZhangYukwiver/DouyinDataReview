import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bvidFromUrl, mergeItems, normalizeAccount, normalizeFolder, normalizeItem, normalizeBvid } from "./bilibili.mjs";
import { createBilibili } from "./bilibili.mjs";

describe("bilibili normalization", () => {
  it("accepts canonical BVIDs and derives them from Bilibili links", () => {
    expect(normalizeBvid("BV1abCDefGHi")).toBe("BV1abCDefGHi");
    expect(bvidFromUrl("https://www.bilibili.com/video/BV1abCDefGHi/?spm_id_from=333")).toBe("BV1abCDefGHi");
    expect(bvidFromUrl("https://example.com/video/BV1abCDefGHi")).toBeNull();
    expect(normalizeBvid("av123")).toBeNull();
  });

  it("normalizes account and folder metadata", () => {
    expect(normalizeAccount({ code: 0, data: { isLogin: true, mid: 42, uname: "小明", face: "http://img" } }, "abc")).toMatchObject({
      accountId: "abc", mid: "42", uname: "小明", avatar: "http://img", isLogin: true,
    });
    expect(normalizeFolder({ id: 123, title: "教程", media_count: 4 })).toEqual({ id: "123", title: "教程", mediaCount: 4, isDefault: false });
  });

  it("keeps one item per BVID while retaining all folders and sources", () => {
    const first = normalizeItem({ bvid: "BV1ABCDEFGHI", title: "标题", pic: "//cover", author: { name: "作者", mid: 7 } }, { accountId: "default", source: "favorite", folderId: "10" });
    const second = normalizeItem({ bvid: "BV1ABCDEFGHI", title: "更新标题", view_at: 1_700_000_000 }, { accountId: "default", source: "history", folderId: "11" });
    expect(mergeItems([first, second])).toEqual([expect.objectContaining({
      key: "bilibili:BV1ABCDEFGHI", bvid: "BV1ABCDEFGHI", title: "更新标题", sources: ["favorite", "history"], folderIds: ["10", "11"],
    })]);
  });
});

function fakeContext({ fail = false, mid = 123, loggedIn = true, favoritePageOne = 40, favoritePageTwo = 6, historyRows = 20 } = {}) {
  const ok = body => ({ status: 200, body });
  const page = {
    async goto() {},
    async evaluate(_callback, target) {
      if (fail && target.includes("/fav/")) throw new Error("temporary upstream failure");
      if (target.includes("/x/web-interface/nav")) return ok({ code: 0, data: { isLogin: loggedIn, mid, uname: "测试账号" } });
      if (target.includes("/fav/folder/created/list-all")) return ok({ code: 0, data: { list: [{ id: 10, title: "教程", media_count: favoritePageOne + favoritePageTwo }] } });
      if (target.includes("/fav/resource/list")) {
        const pageNumber = new URL(target).searchParams.get("pn");
        return ok({ code: 0, data: pageNumber === "1"
          ? { has_more: favoritePageTwo > 0, medias: Array.from({ length: favoritePageOne }, (_, index) => ({ bvid: `BV1${String(index).padStart(9, "0")}`, title: `教程 ${index}` })) }
          : { has_more: false, medias: Array.from({ length: favoritePageTwo }, (_, index) => ({ bvid: `BV1${String(index + favoritePageOne).padStart(9, "0")}`, title: `教程 ${index + favoritePageOne}` })) } });
      }
      if (target.includes("/x/v2/history")) {
        const pageNumber = new URL(target).searchParams.get("pn");
        return ok({ code: 0, data: pageNumber === "1" ? Array.from({ length: historyRows }, (_, index) => ({ history: { bvid: `BV2${String(index).padStart(9, "0")}`, title: `历史 ${index}`, view_at: 1_700_000_000 } })) : [] });
      }
      throw new Error(`unexpected ${target}`);
    },
  };
  return { pages: () => [page], newPage: async () => page, close: async () => {} };
}

async function waitForJob(service, accountId, id) {
  for (let index = 0; index < 100; index += 1) {
    const status = await service.status(accountId);
    if (status.job?.id === id && !["starting", "login", "syncing"].includes(status.job.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Bilibili job did not finish in time");
}

describe("bilibili sync safety", () => {
  it("reads all paginated folders and history, rejects identity changes, and preserves cache on retryable errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bilibili-sync-"));
    let context = fakeContext();
    try {
      const service = createBilibili({ dataDirectory: directory, openContext: async () => context });
      const first = service.startSync("default", { expectedMid: "123" });
      const done = await waitForJob(service, "default", first.id);
      expect(done.job.state).toBe("done");
      expect(done.snapshot.items).toHaveLength(66);
      expect(done.snapshot.folders).toHaveLength(1);

      const cachedKeys = done.snapshot.items.map(item => item.key);
      context = fakeContext({ fail: true });
      const failed = service.startSync("default", { expectedMid: "123" });
      const failedStatus = await waitForJob(service, "default", failed.id);
      expect(failedStatus.job.error).toBe("bilibili_failed");
      expect((await service.status("default")).snapshot.items.map(item => item.key)).toEqual(cachedKeys);

      context = fakeContext({ mid: 456 });
      const mismatch = service.startSync("default", { expectedMid: "123" });
      const mismatchStatus = await waitForJob(service, "default", mismatch.id);
      expect(mismatchStatus.job.error).toBe("bilibili_account_mismatch");
      expect((await service.status("default")).snapshot.items.map(item => item.key)).toEqual(cachedKeys);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("marks an expired slot logged out without changing its cached records or sync time", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bilibili-auth-state-"));
    let context = fakeContext();
    const identities = [];
    try {
      const service = createBilibili({ dataDirectory: directory, openContext: async () => context, onAccountIdentity: value => identities.push(value) });
      const initial = service.startSync("default", { expectedMid: "123" });
      const seeded = await waitForJob(service, "default", initial.id);
      const before = seeded.snapshot;
      context = fakeContext({ mid: 456 });
      await expect(service.getDetail("default", before.items[0].bvid, { expectedMid: "123" })).rejects.toMatchObject({ code: "bilibili_account_mismatch" });
      const mismatched = (await service.status("default")).snapshot;
      expect(mismatched.account).toMatchObject({ mid: "123", isLogin: false });
      expect(mismatched.fetchedAt).toBe(before.fetchedAt);
      context = fakeContext({ loggedIn: false });
      const expired = service.startSync("default", { expectedMid: "123" });
      const failed = await waitForJob(service, "default", expired.id);
      const after = (await service.status("default")).snapshot;
      expect(failed.job.error).toBe("bilibili_login_required");
      expect(after.account).toMatchObject({ mid: "123", isLogin: false });
      expect(after.fetchedAt).toBe(before.fetchedAt);
      expect(after.items.map(item => item.key)).toEqual(before.items.map(item => item.key));
      expect(identities.at(-1)).toMatchObject({ accountId: "default", loggedIn: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not delete a profile during a running sync and can retry after it finishes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bilibili-retry-"));
    let release;
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    let evaluations = 0;
    const context = { pages: () => [{ goto: async () => {}, evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) { startedResolve(); return await new Promise(resolve => { release = resolve; }); }
      return { status: 200, body: { code: 0, data: [] } };
    } }], close: async () => {} };
    try {
      const service = createBilibili({ dataDirectory: directory, openContext: async () => context });
      const job = service.startSync("default", { lists: ["history"] });
      await started;
      await expect(service.logout("default")).rejects.toMatchObject({ code: "bilibili_busy" });
      release({ status: 200, body: { code: 0, data: { isLogin: true, mid: 123, uname: "测试账号" } } });
      await waitForJob(service, "default", job.id);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("closes by aborting and awaiting active jobs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bilibili-close-"));
    let release;
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const context = { pages: () => [{ goto: async () => {}, evaluate: async (_callback, target) => {
      if (target.includes("/x/web-interface/nav")) {
        startedResolve();
        return await new Promise(resolve => { release = resolve; });
      }
      return { status: 200, body: { code: 0, data: [] } };
    } }], close: async () => {} };
    try {
      const service = createBilibili({ dataDirectory: directory, openContext: async () => context });
      const job = service.startSync("default", { lists: ["history"] });
      await started;
      const closing = service.close();
      release({ status: 200, body: { code: 0, data: { isLogin: true, mid: 123, uname: "测试账号" } } });
      await closing;
      expect((await service.status("default")).job).toMatchObject({ id: job.id, state: "cancelled" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("replaces only requested sources and keeps the previous cache on a repeated page", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bilibili-replace-"));
    let context = fakeContext();
    try {
      const service = createBilibili({ dataDirectory: directory, openContext: async () => context });
      const initial = service.startSync("default");
      const first = await waitForJob(service, "default", initial.id);
      expect(first.job.state).toBe("done");
      expect(first.snapshot.items).toHaveLength(66);

      context = fakeContext({ favoritePageOne: 1, favoritePageTwo: 0 });
      const favoritesOnly = service.startSync("default", { lists: ["favorites"] });
      const replaced = await waitForJob(service, "default", favoritesOnly.id);
      expect(replaced.job.state).toBe("done");
      expect(replaced.snapshot.items.filter(item => item.sources.includes("history"))).toHaveLength(20);
      expect(replaced.snapshot.items.filter(item => item.sources.includes("favorite"))).toHaveLength(1);
      expect(replaced.snapshot.items.some(item => item.bvid === "BV1000000001")).toBe(false);

      const cachedKeys = replaced.snapshot.items.map(item => item.key);
      context = {
        pages: () => [{ goto: async () => {}, evaluate: async (_callback, target) => {
          if (target.includes("/x/web-interface/nav")) return { status: 200, body: { code: 0, data: { isLogin: true, mid: 123, uname: "测试账号" } } };
          if (target.includes("/fav/folder/created/list-all")) return { status: 200, body: { code: 0, data: { list: [{ id: 10, title: "教程", media_count: 2 }] } } };
          if (target.includes("/fav/resource/list")) return { status: 200, body: { code: 0, data: { has_more: true, medias: [{ bvid: "BV1999999999", title: "重复页" }] } } };
          throw new Error(`unexpected ${target}`);
        } }], close: async () => {},
      };
      const repeated = service.startSync("default", { lists: ["favorites"] });
      const failed = await waitForJob(service, "default", repeated.id);
      expect(failed.job.error).toBe("bilibili_pagination_incomplete");
      expect((await service.status("default")).snapshot.items.map(item => item.key)).toEqual(cachedKeys);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

