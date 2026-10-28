import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("./background.js", import.meta.url), "utf8");
const version = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")).version;

function setup({ tabs = [], response = null } = {}) {
  const storage = {};
  let listener;
  const browserTabs = { query: vi.fn(async () => tabs), sendMessage: vi.fn(async () => response), reload: vi.fn() };
  const scripting = { executeScript: vi.fn(async () => []) };
  const context = vm.createContext({ URL, chrome: {
    tabs: browserTabs, scripting,
    storage: { local: {
      get: async key => ({ [key]: storage[key] }),
      set: async change => Object.assign(storage, change),
    } },
    alarms: { get: async () => ({}), onAlarm: { addListener() {} } },
    runtime: { getManifest: () => ({ version }), onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(value) { listener = value; } } },
  } });
  vm.runInContext(script, context);
  return { storage, browserTabs, scripting, restore: () => vm.runInContext("restoreOpenPages()", context),
    async receive(message, sender = { url: "https://www.douyin.com/?private=secret", tab: { id: 1 } }) {
    listener(message, sender, () => {});
    await vm.runInContext("chain", context);
  } };
}

describe("推荐流本机诊断", () => {
  it("只存预定字段，剥掉参数及原始内容，版本来自扩展自己", async () => {
    const { storage, receive } = setup();
    await receive({ type: "diagnostics", diagnostics: {
      installedAt: 1793116040014, ruleCount: 2, mode: "observe", version: "fake", cookies: "secret", desc: "secret", matchedVideos: 3,
      requests: [{ host: "www.douyin.com", path: "/aweme/v1/web/tab/feed/?msToken=secret", transport: "fetch", count: 1 }],
      lastResponse: { videos: 3, keys: ["aweme_list", "sessionid=secret"] },
    }, bridge: { eventsReceived: 3, forwardFailures: 0 } });
    expect(storage.feedDiagnostics[1]).toMatchObject({ installedAt: 1793116040014, version, path: "/", mode: "observe", ruleCount: 2,
      matchedVideos: 3, bridgeEventsReceived: 3, requests: [{ path: "/aweme/v1/web/tab/feed/" }],
      lastResponse: { keys: ["aweme_list"] } });
    expect(JSON.stringify(storage)).not.toContain("secret");
    expect(JSON.stringify(storage)).not.toContain("fake");
  });

  it("只接受抖音网页的内容脚本，最多保留八个页面", async () => {
    const { storage, receive } = setup();
    const message = { type: "diagnostics", diagnostics: { mode: "observe" } };
    await receive(message, { url: "https://example.com/", tab: { id: 1 } });
    await receive(message, { url: "https://www.douyin.com/" });
    expect(storage.feedDiagnostics).toBeUndefined();
    for (let id = 0; id < 10; id += 1) await receive(message, { url: "https://www.douyin.com/", tab: { id } });
    expect(Object.keys(storage.feedDiagnostics)).toHaveLength(8);
  });
});

describe("已打开抖音页的连接恢复", () => {
  it.each([null, { version: "1.2.4", ready: true }, { version, ready: false }])("中转不存在、过期或未就绪时补注入：%j", async response => {
    const { restore, scripting, browserTabs, storage } = setup({ response, tabs: [
      { id: 1, url: "https://www.douyin.com/?recommend=1" }, { id: 2, url: "https://example.com/" },
    ] });
    await restore();
    expect(scripting.executeScript.mock.calls.map(([request]) => request)).toEqual([
      { target: { tabId: 1 }, world: "MAIN", files: ["filter.js", "page.js"] },
      { target: { tabId: 1 }, world: "ISOLATED", files: ["bridge.js"] },
    ]);
    expect(storage.pageAttachment).toMatchObject({ pages: 1, restored: 1, failed: 0 });
    expect(browserTabs.reload).not.toHaveBeenCalled();
  });

  it("同版中转已连上时保持原样", async () => {
    const { restore, scripting, storage } = setup({ tabs: [{ id: 1, url: "https://www.douyin.com/" }], response: { version, ready: true } });
    await restore();
    expect(scripting.executeScript).not.toHaveBeenCalled();
    expect(storage.pageAttachment).toMatchObject({ connected: 1, restored: 0 });
  });

  it("一个标签已关闭不会影响其他页面的恢复", async () => {
    const { restore, scripting, storage } = setup({ tabs: [
      { id: 1, url: "https://www.douyin.com/" }, { id: 2, url: "https://www.douyin.com/" },
    ] });
    scripting.executeScript.mockImplementation(async ({ target }) => { if (target.tabId === 1) throw new Error("Tab closed"); return []; });
    await restore();
    expect(storage.pageAttachment).toMatchObject({ pages: 2, restored: 1, failed: 1 });
    expect(scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 2 }, world: "ISOLATED", files: ["bridge.js"] });
  });
});
