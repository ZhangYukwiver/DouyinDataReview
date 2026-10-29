import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildReaderScript } from "./readerScript";
import { isBootstrapSource, isDouyinPage, isLoginNavigation, parsePage, parseSnapshot } from "./proofData";

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), failWrite: false }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "private://app" },
  Directory: class { create() {} },
  File: class {
    name: string;
    constructor(_directory: unknown, name: string) { this.name = name; }
    get exists() { return disk.files.has(this.name); }
    get size() { return disk.files.get(this.name)?.length ?? 0; }
    async text() { return disk.files.get(this.name) ?? ""; }
    write(value: string) {
      if (disk.failWrite) { disk.files.set(this.name, "{partial"); throw new Error("disk interrupted"); }
      disk.files.set(this.name, value);
    }
  },
}));
import { loadProof, saveProof } from "./proofStorage";

const sample = () => ({ account: { id: "12345", nickname: "合成测试账号" },
  records: [{ id: "98765", title: "合成测试作品", author: "测试作者", watchedAt: null }], hasMore: true });

describe("Android one-page proof", () => {
  it("accepts Android's origin-only bootstrap messages as well as legacy full URLs", () => {
    for (const source of ["https://localhost.invalid", "https://localhost.invalid/", "about:blank"]) {
      expect(isBootstrapSource(source)).toBe(true);
    }
    for (const source of ["https://localhost.invalid.evil.test", "http://localhost.invalid/", "https://user@localhost.invalid/", "https://localhost.invalid/other", "https://localhost.invalid/?remote=1", "null"]) {
      expect(isBootstrapSource(source)).toBe(false);
    }
  });

  it("rejects wrong origins and invalid payloads, and never persists additional credential fields", () => {
    expect(isDouyinPage("https://www.douyin.com/user/self")).toBe(true);
    for (const url of ["http://www.douyin.com", "https://www.douyin.com.evil.test", "https://evil@www.douyin.com", "file:///tmp/file"]) {
      expect(isDouyinPage(url)).toBe(false);
      expect(isLoginNavigation(url)).toBe(false);
    }
    expect(isLoginNavigation("https://sso.douyin.com/")).toBe(true);
    const page = sample();
    expect(parsePage({ ...page, cookies: "secret", token: "secret" })).toEqual(page);
    expect(() => parsePage({ ...page, records: Array(21).fill(page.records[0]) })).toThrow();
    expect(() => parsePage({ ...page, account: { id: "0", nickname: "匿名" } })).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ ...page, version: 1, revision: 1, savedAt: "invalid" }))).toThrow();
  });

  it("restores a verified page after restart and keeps the previous page if a write is interrupted", async () => {
    disk.files.clear(); disk.failWrite = false;
    expect((await loadProof()).snapshot).toBeNull();
    const first = await saveProof(sample());
    expect((await loadProof()).snapshot).toEqual(first);
    disk.failWrite = true;
    await expect(saveProof({ ...sample(), records: [] })).rejects.toThrow("disk interrupted");
    expect((await loadProof()).snapshot).toEqual(first);
    expect((await loadProof()).warning).toContain("恢复");
    disk.failWrite = false;
    const second = await saveProof({ ...sample(), records: [] });
    expect(second.revision).toBe(first.revision + 1);
    expect((await loadProof()).snapshot?.records).toEqual([]);
  });
});

type ReaderCase = { status?: number; history?: unknown; finalUid?: string; noTemplate?: boolean; abort?: boolean; historyResponseUrl?: string };
async function executeReader(options: ReaderCase = {}) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let profiles = 0;
  let resolveMessage!: (value: Record<string, unknown>) => void;
  const message = new Promise<Record<string, unknown>>(resolve => { resolveMessage = resolve; });
  const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (value: string) => resolveMessage(JSON.parse(value)) } };
  window.top = window;
  const fetch = async (raw: string, init: RequestInit) => {
    const url = new URL(raw); requests.push({ url, init });
    if (options.abort) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const profile = url.pathname.includes("profile/self");
    if (profile) profiles++;
    return { status: options.status ?? 200, url: profile ? raw : options.historyResponseUrl ?? raw, headers: { get: () => null }, text: async () => JSON.stringify(profile
      ? { status_code: 0, user: { uid: profiles > 1 ? options.finalUid ?? "12345" : "12345", nickname: "合成测试账号" } }
      : options.history ?? { status_code: 0, has_more: 1, aweme_list: [{ aweme_id: "98765", desc: "合成测试作品", create_time: 1700000000, author: { nickname: "测试作者" } }] }) };
  };
  runInNewContext(buildReaderScript("proof-test"), { window, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: { origin: "https://www.douyin.com" }, performance: { getEntriesByType: () => options.noTemplate ? [] : [{
      name: "https://www.douyin.com/aweme/v1/web/history/read/?aid=6383&device_platform=webapp&webid=123&max_cursor=999&msToken=secret&a_bogus=secret",
    }] } });
  return { message: await message, requests };
}

describe("script executed in the WebView", () => {
  it("accepts the SDK's first-party history routing without accepting unrelated response origins or paths", async () => {
    const path = "/aweme/v1/web/history/read/";
    const routed = await executeReader({ historyResponseUrl: `https://www-hj.douyin.com${path}` });
    expect(routed.message).toEqual({ requestId: "proof-test", type: "page", ...sample() });
    expect(routed.requests).toHaveLength(3);
    for (const historyResponseUrl of [
      `https://www-hj.douyin.com.evil.test${path}`, `http://www-hj.douyin.com${path}`,
      `https://user@www-hj.douyin.com${path}`, `https://www-hj.douyin.com:444${path}`,
      "https://www-hj.douyin.com/other/",
    ]) {
      const result = await executeReader({ historyResponseUrl });
      expect(result.message).toEqual({ requestId: "proof-test", type: "error", code: "format" });
      expect(result.requests).toHaveLength(2);
    }
  });

  it("reads exactly one first page with SDK fetch and checks the account before and after", async () => {
    const { message, requests } = await executeReader();
    expect(message).toEqual({ requestId: "proof-test", type: "page", ...sample() });
    expect(requests).toHaveLength(3);
    expect(requests[1]?.url.searchParams.get("max_cursor")).toBe("0");
    expect(requests[1]?.url.searchParams.get("count")).toBe("20");
    expect(requests.every(request => request.init.credentials === "include" && request.init.redirect === "error")).toBe(true);
    expect(requests.every(request => !request.url.searchParams.has("msToken") && !request.url.searchParams.has("a_bogus"))).toBe(true);
    expect(JSON.stringify(message)).not.toContain("secret");
    // Publishing time must never be presented as the user's viewing time.
    expect(parsePage(message).records[0]?.watchedAt).toBeNull();
  });

  it.each([
    [{ status: 403 }, "login"], [{ status: 429 }, "limited"], [{ noTemplate: true }, "template"],
    [{ finalUid: "45678" }, "account"], [{ abort: true }, "timeout"],
    [{ history: { status_code: 8 } }, "login"], [{ history: { status_code: 0, has_more: 0 } }, "format"],
  ] as const)("keeps failure %j distinct from a successful empty page", async (options, code) => {
    expect((await executeReader(options)).message).toEqual({ requestId: "proof-test", type: "error", code });
  });

  it("accepts a genuinely empty page and keeps the platform's watch timestamp", async () => {
    expect((await executeReader({ history: { status_code: 0, has_more: 0, aweme_list: [] } })).message)
      .toMatchObject({ type: "page", records: [], hasMore: false });
    const { message } = await executeReader({ history: { status_code: 0, has_more: 0, aweme_date: { "98765": 1700000000 }, aweme_list: [{ aweme_id: "98765" }] } });
    expect(parsePage(message).records[0]?.watchedAt).toBe("2023-11-14T22:13:20.000Z");
  });
});
