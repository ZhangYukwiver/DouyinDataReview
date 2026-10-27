import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DouyinCollector } from "./douyinCollector.mjs";
import { ExplorerBridge } from "./explorerBridge.mjs";
import { startCollectorServer } from "./server.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const exists = (target) => access(target).then(() => true, () => false);

// 只放进临时目录的合成记录，不碰真实数据
async function writeSyntheticRecords(directory) {
  await writeFile(path.join(directory, "records.json"), JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-10-01T00:00:00.000Z",
    records: {
      watch_history: [],
      liked_videos: [{ id: "liked_videos:1", title: "合成记录", author: null, occurredAt: null, url: "https://www.douyin.com/video/1" }],
      favorite_videos: [],
    },
    chatMessages: [],
    chatConversations: [],
    warnings: [],
  }));
}

async function startPaired(prefix, prepare) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dataDirectory);
  await prepare?.(dataDirectory);
  const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
  runtimes.push(runtime);
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
  }).then((response) => response.json());
  const call = async (pathname, method = "GET") => {
    const response = await fetch(`${runtime.baseUrl}${pathname}`, { method, headers: { Authorization: `Bearer ${paired.token}` } });
    return { status: response.status, body: await response.json() };
  };
  return { dataDirectory, runtime, call, headers: { Authorization: `Bearer ${paired.token}` } };
}

describe("collector accounts", () => {
  it("keeps each account's login and records apart and switches without deleting anything", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-switch-", async (directory) => {
      await writeSyntheticRecords(directory);
      await mkdir(path.join(directory, "direct-signer"), { recursive: true });
      await writeFile(path.join(directory, "direct-signer", "signer.js"), "// signer");
      await mkdir(path.join(directory, "backups"), { recursive: true });
      await writeFile(path.join(directory, "backups", "old.json"), "{}");
      await writeFile(path.join(directory, "launcher-error.txt"), "");
    });
    expect((await fetch(`${runtime.baseUrl}/v1/accounts`)).status).toBe(401);
    const initial = await call("/v1/accounts");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ activeId: "default", accounts: [{ id: "default", nickname: null, avatar: null, uid: null }] });
    expect(initial.body.accounts).toHaveLength(1);
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    const before = (await call("/v1/status")).body;
    expect(before.account).toEqual({ id: "default", nickname: null, avatar: null });

    // 工作台一直挂着状态长轮询；切换时它要直接拿到新账号的状态
    let settled = false;
    const polling = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${before.revision}`, { headers })
      .then((response) => response.json()).then((status) => { settled = true; return status; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);

    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const newId = created.body.activeId;
    expect(newId).toMatch(/^[0-9a-f]{12}$/u);
    expect(created.body.accounts.map((account) => account.id)).toEqual(["default", newId]);
    expect(created.body.status.account).toEqual({ id: newId, nickname: null, avatar: null });
    expect(created.body.status.revision).toBeGreaterThan(before.revision);
    const polled = await polling;
    expect(polled.account.id).toBe(newId);
    expect(polled.revision).toBeGreaterThan(before.revision);
    expect((await stat(path.join(dataDirectory, "accounts", newId))).isDirectory()).toBe(true);
    expect((await call("/v1/records")).body.records.liked_videos).toEqual([]);
    expect((await call("/v1/status")).body.account.id).toBe(newId);

    const back = await call("/v1/accounts/default/activate", "POST");
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ activeId: "default", status: { account: { id: "default" } } });
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    const again = await call("/v1/accounts/default/activate", "POST");
    expect(again.status).toBe(200);
    expect(again.body.status.revision).toBe(back.body.status.revision);

    const activeDelete = await call("/v1/accounts/default", "DELETE");
    expect(activeDelete.status).toBe(409);
    expect(activeDelete.body.error).toBe("account_active");

    const removed = await call(`/v1/accounts/${newId}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ activeId: "default", accounts: [{ id: "default" }] });
    expect(removed.body.accounts).toHaveLength(1);
    expect(await exists(path.join(dataDirectory, "accounts", newId))).toBe(false);
    for (const name of ["direct-signer/signer.js", "backups/old.json", "launcher-error.txt", "records.json"]) {
      expect(await exists(path.join(dataDirectory, name))).toBe(true);
    }
    expect((await call(`/v1/accounts/${newId}/activate`, "POST")).body.error).toBe("account_not_found");
  });

  it("deletes only the default account's own entries from the shared folder", async () => {
    const { dataDirectory, call } = await startPaired("accounts-default-", async (directory) => {
      await writeSyntheticRecords(directory);
      for (const name of ["browser-profile/Default", "direct-signer", "backups"]) await mkdir(path.join(directory, name), { recursive: true });
      for (const name of ["browser-profile/Default/Cookies", "records.json.123.tmp", "folders.json", "folders.json.123.tmp", "folders.json.broken-1792000000000", "direct-history-template.json", "direct-signer/signer.js", "backups/old.json", "launcher-error.txt", "notes.txt"]) {
        await writeFile(path.join(directory, name), "x");
      }
    });
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const removed = await call("/v1/accounts/default", "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ activeId: created.body.activeId, accounts: [{ id: created.body.activeId }] });
    expect((await readdir(dataDirectory)).sort()).toEqual(["accounts", "accounts.json", "backups", "direct-signer", "launcher-error.txt", "notes.txt"]);
    expect(await exists(path.join(dataDirectory, "direct-signer", "signer.js"))).toBe(true);
  });

  it("rejects malformed account ids without touching the file system", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-ids-", async (directory) => {
      await writeSyntheticRecords(directory);
      await mkdir(path.join(directory, "x"), { recursive: true });
      await writeFile(path.join(directory, "x", "keep.txt"), "keep");
    });
    const listing = (await readdir(dataDirectory)).sort();
    const registry = await readFile(path.join(dataDirectory, "accounts.json"), "utf8");
    for (const [pathname, method] of [
      ["/v1/accounts/..%2Fx", "DELETE"],
      ["/v1/accounts/..%2Fx/activate", "POST"],
      ["/v1/accounts/ABCDEF012345", "DELETE"],
      ["/v1/accounts/0123456789ab", "DELETE"],
      ["/v1/accounts/0123456789ab/activate", "POST"],
    ]) {
      const result = await call(pathname, method);
      expect(result.status, pathname).toBe(404);
      expect(result.body.error, pathname).toBe("account_not_found");
    }
    // ../ 和编码过的 %2E%2E 会被 URL 规整掉，到不了账号路由
    for (const pathname of ["/v1/accounts/../x", "/v1/accounts/%2E%2E", "/v1/accounts/%2e%2e/activate"]) {
      expect((await fetch(`${runtime.baseUrl}${pathname}`, { method: "DELETE", headers })).status, pathname).toBe(404);
    }
    expect((await readdir(dataDirectory)).sort()).toEqual(listing);
    expect(await readFile(path.join(dataDirectory, "x", "keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(dataDirectory, "accounts.json"), "utf8")).toBe(registry);
  });

  it("writes the nickname and avatar read from the page back to the account list", async () => {
    const opened = [];
    const initialize = DouyinCollector.prototype.initialize;
    const spy = vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () {
      opened.push(this);
      return initialize.call(this);
    });
    try {
      const { dataDirectory, call } = await startPaired("accounts-identity-");
      const avatar = "https://p3-pc-sign.douyinpic.com/aweme/100x100/me.jpeg";
      await opened.at(-1).assertAccountMatches({ evaluate: async () => ({ uid: "123456789012345", secUid: "MS4w-me", nickname: "我", avatar }) });
      // 状态里出现新昵称时，名单已经落盘
      await vi.waitFor(async () => expect((await call("/v1/status")).body.account).toEqual({ id: "default", nickname: "我", avatar }));
      expect((await call("/v1/accounts")).body.accounts[0]).toMatchObject({
        id: "default", nickname: "我", avatar, uid: "123456789012345",
      });
      // 重开采集服务也还认得
      const restarted = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      runtimes.push(restarted);
      expect(opened.at(-1).getStatus().account).toEqual({ id: "default", nickname: "我", avatar });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to switch while records are being read or another account operation runs", async () => {
    let finishRun;
    const runSync = vi.spyOn(DouyinCollector.prototype, "runDirectRecords").mockImplementation(() => new Promise((resolve) => { finishRun = resolve; }));
    try {
      const { call } = await startPaired("accounts-busy-");
      expect((await call("/v1/sync", "POST")).status).toBe(202);
      const refused = await call("/v1/accounts", "POST");
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: "collector_busy", message: expect.stringContaining("读取") });
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(1);
      finishRun();
      for (let attempt = 0; attempt < 50 && (await call("/v1/status")).body.syncMode !== null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // 同时点两次只建一个
      const [first, second] = await Promise.all([call("/v1/accounts", "POST"), call("/v1/accounts", "POST")]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect([first, second].find((result) => result.status === 409).body.error).toBe("collector_busy");
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(2);
    } finally {
      runSync.mockRestore();
    }
  });
});

describe("collector account switching edge cases", () => {
  it("stays on the current account with a reset status when the switch fails, and says which action failed", async () => {
    const opened = [];
    let failOpen = false;
    const initialize = DouyinCollector.prototype.initialize;
    const spy = vi.spyOn(DouyinCollector.prototype, "initialize").mockImplementation(async function () {
      opened.push(this);
      if (opened.length === 4 || failOpen) throw new Error("disk full");
      return initialize.call(this);
    });
    try {
      const { call } = await startPaired("accounts-switch-failed-", writeSyntheticRecords);
      const created = await call("/v1/accounts", "POST");
      expect(created.status).toBe(201);
      const newId = created.body.activeId;
      expect((await call("/v1/accounts/default/activate", "POST")).status).toBe(200);
      // 新建时初始化失败
      const failedAdd = await call("/v1/accounts", "POST");
      expect(failedAdd).toMatchObject({ status: 500, body: { error: "account_switch_failed", message: "没能添加账号，请稍后再试。" } });
      expect((await call("/v1/accounts")).body.accounts).toHaveLength(2);

      // 目标账号打不开；当前账号正在“接收”时被静默收掉，状态要复位
      failOpen = true;
      opened.at(-1).updateStatus({ state: "observing", message: "正在监听手动浏览", browserOpen: true });
      const failedSwitch = await call(`/v1/accounts/${newId}/activate`, "POST");
      expect(failedSwitch).toMatchObject({ status: 500, body: { error: "account_switch_failed", message: "没能切换账号，请稍后再试。" } });
      expect((await call("/v1/status")).body).toMatchObject({
        state: "idle", browserOpen: false, message: "没能切换账号，已留在原账号。", account: { id: "default" },
      });
      expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a paired session alive while it is used and expires it after 12 idle hours", async () => {
    const { call } = await startPaired("pairing-idle-");
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    try {
      for (const hours of [11, 22, 33]) {
        now.mockReturnValue(start + hours * 3_600_000);
        expect((await call("/v1/status")).status).toBe(200);
      }
      now.mockReturnValue(start + 45.5 * 3_600_000);
      expect((await call("/v1/status")).body.error).toBe("not_paired");
    } finally {
      now.mockRestore();
    }
  });

  it("leaves records alone when a stale window clears or merges for an account that is no longer active", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("accounts-stale-", writeSyntheticRecords);
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const newId = created.body.activeId;
    await writeSyntheticRecords(path.join(dataDirectory, "accounts", newId));
    await call(`/v1/accounts/default/activate`, "POST");
    // 另一个窗口切到了新账号，这个窗口还以为在用 default
    expect((await call(`/v1/accounts/${newId}/activate`, "POST")).status).toBe(200);

    const cleared = await call("/v1/records?account=default", "DELETE");
    expect(cleared).toMatchObject({ status: 409, body: { error: "account_changed" } });
    const merged = await fetch(`${runtime.baseUrl}/v1/records/import?account=default`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ records: {} }),
    });
    expect(merged.status).toBe(409);
    expect((await merged.json()).error).toBe("account_changed");
    expect((await call("/v1/records")).body.records.liked_videos).toHaveLength(1);

    // 带的是当前账号，或者老版本不带，都照常清
    expect((await call(`/v1/records?account=${newId}`, "DELETE")).status).toBe(200);
    expect((await call("/v1/records")).body.records.liked_videos).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "records.json"), "utf8")).records.liked_videos).toHaveLength(1);
  });

  it("does not merge an upload into the account that was switched to while it uploaded", async () => {
    const { runtime, call, headers } = await startPaired("accounts-import-");
    let upload;
    const body = new ReadableStream({ start(controller) { upload = controller; } });
    const importing = fetch(`${runtime.baseUrl}/v1/records/import`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body, duplex: "half",
    });
    upload.enqueue(new TextEncoder().encode('{"schemaVersion":2,'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await call("/v1/accounts", "POST")).status).toBe(201);
    upload.enqueue(new TextEncoder().encode('"records":{}}'));
    upload.close();
    const response = await importing;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("collector_busy");
  });
});

describe("collector record folders", () => {
  const emptyList = { folders: [], items: {} };
  const emptyLists = { lists: { watch_history: emptyList, liked_videos: emptyList, favorite_videos: emptyList } };
  const sample = { lists: {
    watch_history: { folders: [{ id: "f1k2m3", name: "学习" }], items: { "7300000000000000001": "f1k2m3", "7300000000000000002": "gone" } },
    other: { folders: [{ id: "x", name: "不认" }], items: {} },
  } };
  const saved = { lists: { ...emptyLists.lists, watch_history: { folders: [{ id: "f1k2m3", name: "学习" }], items: { "7300000000000000001": "f1k2m3" } } } };
  const postFolders = (runtime, headers, body, query = "") => fetch(`${runtime.baseUrl}/v1/folders${query}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  it("saves folders per account, behind pairing, and leaves them alone when the record cache is cleared", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("folders-routes-", writeSyntheticRecords);
    expect((await fetch(`${runtime.baseUrl}/v1/folders`)).status).toBe(401);
    expect((await fetch(`${runtime.baseUrl}/v1/folders`, { method: "POST", body: JSON.stringify(sample) })).status).toBe(401);
    expect(await call("/v1/folders")).toEqual({ status: 200, body: emptyLists });
    expect(await exists(path.join(dataDirectory, "folders.json"))).toBe(false);

    expect(await postFolders(runtime, headers, sample, "?account=default")).toEqual({ status: 200, body: { ok: true } });
    expect(await call("/v1/folders")).toEqual({ status: 200, body: saved });
    expect(JSON.parse(await readFile(path.join(dataDirectory, "folders.json"), "utf8"))).toMatchObject({ schemaVersion: 1, lists: saved.lists });

    // 坏请求、不是当前账号的请求都不改动
    expect(await postFolders(runtime, headers, '{"lists":')).toMatchObject({ status: 400, body: { error: "invalid_request", message: "文件夹数据无效。" } });
    expect(await postFolders(runtime, headers, {})).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await postFolders(runtime, headers, { lists: [] })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await postFolders(runtime, headers, emptyLists, "?account=0123456789ab")).toMatchObject({ status: 409, body: { error: "account_changed" } });
    expect((await call("/v1/folders")).body).toEqual(saved);

    // 清除本地缓存只清记录，文件夹还在
    expect((await call("/v1/records?account=default", "DELETE")).status).toBe(200);
    expect((await call("/v1/records")).body.records.liked_videos).toEqual([]);
    expect((await call("/v1/folders")).body).toEqual(saved);
    expect(await exists(path.join(dataDirectory, "folders.json"))).toBe(true);

    // 新账号是空的，存到它自己的目录；切回来还是原来的
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    const newId = created.body.activeId;
    expect(await call("/v1/folders")).toEqual({ status: 200, body: emptyLists });
    const other = { lists: { favorite_videos: { folders: [{ id: "g1", name: "收藏夹" }], items: { v9: "g1" } } } };
    expect((await postFolders(runtime, headers, other, `?account=${newId}`)).status).toBe(200);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "accounts", newId, "folders.json"), "utf8")).lists.favorite_videos.items).toEqual({ v9: "g1" });
    expect(JSON.parse(await readFile(path.join(dataDirectory, "folders.json"), "utf8")).lists).toEqual(saved.lists);
    expect((await call("/v1/accounts/default/activate", "POST")).status).toBe(200);
    expect((await call("/v1/folders")).body).toEqual(saved);

    // 删掉 default 账号，根目录的 folders.json 跟着删
    expect((await call(`/v1/accounts/${newId}/activate`, "POST")).status).toBe(200);
    expect((await call("/v1/accounts/default", "DELETE")).status).toBe(200);
    expect(await exists(path.join(dataDirectory, "folders.json"))).toBe(false);
    expect((await call("/v1/folders")).body.lists.favorite_videos.items).toEqual({ v9: "g1" });
  });

  it("says so when the folder file cannot be read or saved", async () => {
    // folders.json 是个目录：读和写都会失败，不能当成空的再盖过去
    const { dataDirectory, runtime, call, headers } = await startPaired("folders-broken-", async (directory) => {
      await mkdir(path.join(directory, "folders.json"));
    });
    expect(await call("/v1/folders")).toMatchObject({ status: 500, body: { error: "folders_read_failed" } });
    expect(await postFolders(runtime, headers, sample)).toEqual({
      status: 500, body: { error: "folders_save_failed", message: "文件夹没存上，请稍后再试。" },
    });
    expect((await stat(path.join(dataDirectory, "folders.json"))).isDirectory()).toBe(true);
  });

  it("does not save an upload into the account that was switched to while it uploaded", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("folders-switch-");
    let upload;
    const body = new ReadableStream({ start(controller) { upload = controller; } });
    const saving = fetch(`${runtime.baseUrl}/v1/folders`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body, duplex: "half",
    });
    upload.enqueue(new TextEncoder().encode('{"lists":'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const created = await call("/v1/accounts", "POST");
    expect(created.status).toBe(201);
    upload.enqueue(new TextEncoder().encode(JSON.stringify(sample.lists) + "}"));
    upload.close();
    const response = await saving;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("collector_busy");
    expect(await exists(path.join(dataDirectory, "folders.json"))).toBe(false);
    expect(await exists(path.join(dataDirectory, "accounts", created.body.activeId, "folders.json"))).toBe(false);
  });
});

describe("collector server runtime", () => {
  it("keeps explore tabs such as open comments for a playback job and an explore-page download, but not for other saved downloads", async () => {
    const close = vi.spyOn(ExplorerBridge.prototype, "close");
    try {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "playback-explore-"));
      temporaryDirectories.push(dataDirectory);
      const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      runtimes.push(runtime);
      const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
      }).then((response) => response.json());
      const post = (body) => fetch(`${runtime.baseUrl}/v1/downloads`, {
        method: "POST", headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await post({ url: "https://www.douyin.com/video/1234567890", playback: true })).status).toBe(202);
      expect(close).not.toHaveBeenCalled();
      await post({ url: "https://www.douyin.com/video/1234567891", keepExplore: true });
      expect(close).not.toHaveBeenCalled();
      await post({ url: "https://www.douyin.com/video/1234567892" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
  });

  it("keeps a chat failure out of the record-reading state and still accepts a direct read", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "chat-independent-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
    runtimes.push(runtime);
    const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
    }).then((response) => response.json());
    const headers = { Authorization: `Bearer ${paired.token}` };
    const readStatus = () => fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json());

    const started = await fetch(`${runtime.baseUrl}/v1/chat/observe`, { method: "POST", headers });
    expect(started.status).toBe(202);
    let status = await readStatus();
    for (let attempt = 0; attempt < 50 && status.chat.state !== "error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      status = await readStatus();
    }
    // 接收起不来只写它自己那份状态，工作台其他部分不该跟着进错误态
    expect(status.chat.state).toBe("error");
    expect(status.state).toBe("idle");

    const direct = await fetch(`${runtime.baseUrl}/v1/experimental/records-direct`, { method: "POST", headers });
    expect(direct.status).toBe(202);
    expect((await direct.json()).status.syncMode).toBe("direct_records");
  });

  it("waits for a status revision without polling, authenticates, and releases aborted clients", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "chat-live-status-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
    runtimes.push(runtime);
    const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
    }).then((response) => response.json());
    const headers = { Authorization: `Bearer ${paired.token}` };
    const initial = await fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json());
    expect(Number.isSafeInteger(initial.revision)).toBe(true);
    expect((await fetch(`${runtime.baseUrl}/v1/status?afterRevision=${initial.revision}`)).status).toBe(401);
    expect((await fetch(`${runtime.baseUrl}/v1/status?afterRevision=invalid`, { headers })).status).toBe(400);
    let settled = false;
    const pending = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${initial.revision}`, { headers })
      .then((response) => response.json()).then((status) => { settled = true; return status; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    // This server owns an empty temporary store; no real records are touched.
    await fetch(`${runtime.baseUrl}/v1/records`, { method: "DELETE", headers });
    const changed = await pending;
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(changed.message).toBe("本地记录已清除");
    const ahead = await fetch(`${runtime.baseUrl}/v1/status?afterRevision=999999`, { headers }).then((response) => response.json());
    expect(ahead.revision).toBe(changed.revision);
    const controller = new AbortController();
    const aborted = fetch(`${runtime.baseUrl}/v1/status?afterRevision=${changed.revision}`, { headers, signal: controller.signal });
    const rejected = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  });

  it("shuts down promptly while a client keeps long-polling the status", async () => {
    // 关浏览器要一会儿；这段时间里工作台会再发一次长轮询，关服务时它还挂着
    const closeCollector = DouyinCollector.prototype.close;
    const slowClose = vi.spyOn(DouyinCollector.prototype, "close").mockImplementation(async function () {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return closeCollector.call(this);
    });
    try {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "status-shutdown-"));
      temporaryDirectories.push(dataDirectory);
      const runtime = await startCollectorServer({ port: 0, dataDirectory, executablePath: process.execPath });
      const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
      }).then((response) => response.json());
      const headers = { Authorization: `Bearer ${paired.token}` };
      // 和工作台一样：一次长轮询回来就立刻发下一次，直到连不上为止
      const polling = (async () => {
        let revision = (await fetch(`${runtime.baseUrl}/v1/status`, { headers }).then((response) => response.json())).revision;
        for (;;) {
          const status = await fetch(`${runtime.baseUrl}/v1/status?afterRevision=${revision}`, { headers })
            .then((response) => response.json()).catch(() => null);
          if (!status) return;
          revision = status.revision;
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      await runtime.close();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await polling;
    } finally {
      slowClose.mockRestore();
    }
  }, 15_000);

  it("supports an ephemeral desktop port and pairing", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "content-insights-collector-"));
    temporaryDirectories.push(dataDirectory);
    const runtime = await startCollectorServer({
      port: 0,
      dataDirectory,
      executablePath: process.execPath,
    });
    runtimes.push(runtime);

    expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const health = await fetch(`${runtime.baseUrl}/v1/health`);
    await expect(health.json()).resolves.toEqual({ ok: true, version: 1 });

    const pairingCodeResponse = await fetch(`${runtime.baseUrl}/v1/pairing-code`);
    const pairingCodePayload = await pairingCodeResponse.json();
    expect(pairingCodeResponse.status).toBe(200);
    expect(pairingCodePayload).toEqual({ code: runtime.getPairingCode() });

    const pairingCode = pairingCodePayload.code;
    const pairing = await fetch(`${runtime.baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const payload = await pairing.json();
    expect(pairing.status).toBe(200);
    expect(payload.token).toHaveLength(43);
    expect(runtime.getPairingCode()).not.toBe(pairingCode);

    const stopSync = await fetch(`${runtime.baseUrl}/v1/sync/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    expect(stopSync.status).toBe(200);
    await expect(stopSync.json()).resolves.toMatchObject({
      stopped: false,
      status: { state: "idle" },
    });

    const unauthenticatedDownload = await fetch(`${runtime.baseUrl}/v1/downloads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://v.douyin.com/example/" }),
    });
    expect(unauthenticatedDownload.status).toBe(401);

    for (const operation of ["read", "interact"]) {
      const unauthorized = await fetch(`${runtime.baseUrl}/v1/explore/${operation}`, { method: "POST" });
      expect(unauthorized.status).toBe(401);
      const invalid = await fetch(`${runtime.baseUrl}/v1/explore/${operation}`, {
        method: "POST", headers: { Authorization: `Bearer ${payload.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "unsupported" }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_request" });
    }

    const invalidDownload = await fetch(`${runtime.baseUrl}/v1/downloads`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${payload.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/video/1" }),
    });
    expect(invalidDownload.status).toBe(400);
    await expect(invalidDownload.json()).resolves.toMatchObject({ error: "invalid_url" });

    const unknownDownload = await fetch(`${runtime.baseUrl}/v1/downloads/not-a-valid-job`, {
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    expect(unknownDownload.status).toBe(404);
    await expect(unknownDownload.json()).resolves.toMatchObject({ error: "download_job_not_found" });

    const releaseUrl = `${runtime.baseUrl}/v1/downloads/12345678-1234-1234-1234-123456789abc`;
    expect((await fetch(releaseUrl, { method: "DELETE" })).status).toBe(401);
    const release = await fetch(releaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${payload.token}` } });
    expect(release.status).toBe(200);
    await expect(release.json()).resolves.toEqual({ ok: true });
    // 送去拆片工坊只拿下好了的文件，没有这个任务就是 null
    expect(runtime.getDownloadFilePath("12345678-1234-1234-1234-123456789abc")).toBeNull();

    // <video> sends no session header: a stream is gated by its per-job key alone.
    const stream = await fetch(`${releaseUrl}/stream?key=guess`);
    expect(stream.status).toBe(404);
    await expect(stream.json()).resolves.toEqual({ error: "download_job_not_found" });
  });
});

describe("collector own-page guard", () => {
  it("won't hand out a pairing code, pair, or answer paired routes for pages opened on its own address", async () => {
    const { runtime, headers } = await startPaired("own-page-");
    const base = runtime.baseUrl;
    const port = new URL(base).port;
    // 采集器地址上打开的页面发来的请求：同源时浏览器自动带 same-origin（脚本改不了）；页面换个主机名打回来
    // （127.0.0.1 ↔ localhost）浏览器算 cross-site，但 Origin 的端口还是采集器的
    const ownPages = [
      { "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "cross-site", Origin: `http://127.0.0.1:${port}` },
      { "Sec-Fetch-Site": "cross-site", Origin: `http://localhost:${port}` },
    ];
    const pair = (extra) => fetch(`${base}/v1/pair`, { method: "POST", headers: { ...extra, "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) });

    const pairingCode = runtime.getPairingCode();
    for (const own of ownPages) {
      const code = await fetch(`${base}/v1/pairing-code`, { headers: own });
      expect(code.status).toBe(403);
      expect(await code.json()).not.toHaveProperty("code");
      // 页面拿不到配对码，也不能拿猜到的码一直试：拒掉的不占本机的尝试次数，应用随后照常能配对
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const refused = await pair(own);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "same_origin_not_allowed" });
      }
      // 带着合法 token 也不行
      const status = await fetch(`${base}/v1/status`, { headers: { ...headers, ...own } });
      expect(status.status).toBe(403);
      expect(await status.json()).toEqual({ error: "same_origin_not_allowed" });
    }
    expect(runtime.getPairingCode()).toBe(pairingCode);
    // 局域网地址、[::1] 这些主机名的页面本来就过不了来源检查
    for (const host of ["192.168.1.5", "[::1]"]) {
      const lan = { "Sec-Fetch-Site": "cross-site", Origin: `http://${host}:${port}` };
      expect((await fetch(`${base}/v1/pairing-code`, { headers: lan })).status).toBe(403);
      expect((await pair(lan)).status).toBe(403);
    }

    // 应用页面（47651 端口是 same-site，开发服务器的 localhost 是 cross-site）、地址栏直接打开（none）和 Node 客户端（不带头）照旧
    for (const site of [
      { "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:47651" },
      { "Sec-Fetch-Site": "cross-site", Origin: "http://localhost:8081" },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "none" }, {},
    ]) {
      const shown = await fetch(`${base}/v1/pairing-code`, { headers: site });
      expect(shown.status).toBe(200);
      expect(shown.headers.get("access-control-allow-origin")).toBe(site.Origin ?? null);
      expect(await shown.json()).toEqual({ code: runtime.getPairingCode() });
      expect((await fetch(`${base}/v1/status`, { headers: { ...headers, ...site } })).status).toBe(200);
    }
    const paired = await pair({ "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:47651" });
    expect(paired.status).toBe(200);
    expect((await paired.json()).token).toHaveLength(43);
  });
});

describe("推荐流过滤扩展接口", () => {
  const EXTENSION = "chrome-extension://phliimhdokpkdhmeofkpbcnkncknjkka";

  it("扩展按固定来源免配对码领令牌，只能拉设置、送记录、报已移除；应用改设置、看状态、叫扩展移除", async () => {
    const { runtime, headers } = await startPaired("feed-filter-");
    const code = runtime.getPairingCode();
    const fromExtension = (pathname, init = {}) => fetch(`${runtime.baseUrl}${pathname}`,
      { ...init, headers: { Origin: EXTENSION, "Content-Type": "application/json", ...init.headers } });

    const paired = await fromExtension("/v1/pair", { method: "POST", body: "{}" });
    expect(paired.status).toBe(200);
    expect(paired.headers.get("access-control-allow-origin")).toBe(EXTENSION);
    // 应用自己的配对码没被用掉
    expect(runtime.getPairingCode()).toBe(code);
    const auth = { Authorization: `Bearer ${(await paired.json()).token}` };

    const app = (pathname, init = {}) => fetch(`${runtime.baseUrl}${pathname}`, { ...init, headers: { ...headers, "Content-Type": "application/json" } })
      .then(async (response) => ({ status: response.status, body: await response.json() }));
    expect((await app("/v1/feed-filter")).body).toMatchObject({ mode: "observe", extension: { lastSeenAt: null, removing: false } });

    // 扩展后台发的 GET 不带 Origin：按令牌认出是扩展，照样只给那几个接口
    const bare = (pathname, init = {}) => fetch(`${runtime.baseUrl}${pathname}`, { ...init, headers: { ...auth, ...init.headers } });
    expect(await (await bare("/v1/feed-filter")).json()).toMatchObject({ mode: "observe", remove: false });
    expect((await app("/v1/feed-filter")).body.extension.lastSeenAt).toEqual(expect.any(Number));
    expect((await bare("/v1/records")).status).toBe(403);
    const event = { t: 1_790_000_000_000, id: "7000000000000000001", desc: "带货现场", author: "某人", matched: ["带货"], action: "hidden" };
    expect((await fromExtension("/v1/feed-filter/events", { method: "POST", headers: auth, body: JSON.stringify({ events: [event] }) })).status).toBe(200);
    for (const [pathname, method] of [["/v1/records", "GET"], ["/v1/feed-filter", "POST"], ["/v1/feed-filter/remove", "POST"], ["/v1/feed-filter/events", "GET"], ["/v1/feed-filter/events", "DELETE"], ["/v1/feed-filter/open-extensions", "POST"]])
      expect((await fromExtension(pathname, { method, headers: auth })).status).toBe(403);

    expect((await app("/v1/feed-filter", { method: "POST", body: JSON.stringify({ mode: "nope" }) })).status).toBe(400);
    expect((await app("/v1/feed-filter", { method: "POST", body: JSON.stringify({ rules: "营销号\nauthor:某人", mode: "dislike" }) })).body)
      .toMatchObject({ rules: "营销号\nauthor:某人", mode: "dislike" });
    expect((await app("/v1/feed-filter/events")).body.events).toEqual([event]);
    expect((await app("/v1/feed-filter/videos")).body.videos).toEqual([]);
    expect((await bare("/v1/feed-filter/videos")).status).toBe(403);
    expect((await app("/v1/feed-filter/open-extensions", { method: "POST", body: JSON.stringify({ browser: "app" }) })).body.error).toBe("browser_unsupported");

    // 点移除：扩展下次来时看到 remove，报一声再卸载自己；之后设置页显示没装
    expect((await app("/v1/feed-filter/remove", { method: "POST", body: JSON.stringify({ remove: true }) })).body.extension).toMatchObject({ removing: true });
    expect(await (await fromExtension("/v1/feed-filter", { headers: auth })).json()).toMatchObject({ mode: "dislike", remove: true });
    expect((await fromExtension("/v1/feed-filter/removed", { method: "POST", headers: auth, body: "{}" })).status).toBe(200);
    expect((await app("/v1/feed-filter")).body.extension).toEqual({ lastSeenAt: null, removing: false });
    expect((await app("/v1/feed-filter/events", { method: "DELETE" })).status).toBe(200);
    expect((await app("/v1/feed-filter/events")).body.events).toEqual([]);
  });

  it("别的扩展和网页来源连不上", async () => {
    const { runtime } = await startPaired("feed-filter-origin-");
    for (const origin of ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "https://www.douyin.com"]) {
      const response = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
    }
  });
});
