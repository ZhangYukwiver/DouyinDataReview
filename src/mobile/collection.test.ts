import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildReaderScript } from "./readerScript";
import { mergeCollectionPage, migrateProof, parseCollectionPage, parseMobileSnapshot, personalRecords, type CollectionPage } from "./collectionData";
import { buildMobileReport, reportHtml } from "./mobileReport";

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
      if (disk.failWrite) { disk.files.set(this.name, "{partial"); throw new Error("interrupted"); }
      disk.files.set(this.name, value);
    }
  },
}));
import { loadCollections, saveCollectionPage } from "./collectionStorage";

const account = { id: "12345", nickname: "合成测试账号" };
const page = (change: Partial<CollectionPage> = {}): CollectionPage => parseCollectionPage({ account,
  recordType: "watch_history", cursor: "0", nextCursor: "20", hasMore: true,
  records: [{ id: "98765", title: "合成测试作品", author: "测试作者", watchedAt: "2026-01-01T10:00:00.000Z", topics: ["测试"] }], ...change });

async function read(type: CollectionPage["recordType"], next = "456", expectedAccount = "12345") {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let resolve!: (value: Record<string, unknown>) => void;
  const message = new Promise<Record<string, unknown>>(done => { resolve = done; });
  const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (raw: string) => resolve(JSON.parse(raw)) } };
  window.top = window;
  const fetch = async (raw: string, init: RequestInit) => {
    const url = new URL(raw); requests.push({ url, init });
    return { status: 200, url: raw, headers: { get: () => null }, text: async () => JSON.stringify(url.pathname.includes("profile/self")
      ? { status_code: 0, user: { uid: "12345", sec_uid: "MS4wLjABAAAA123456789", nickname: "合成测试账号" } }
      : { status_code: 0, has_more: 1, max_cursor: next, cursor: next, aweme_date: { "98765": 1767261600 },
        aweme_list: [{ aweme_id: "98765", desc: "合成测试作品", create_time: 1700000000, play_progress: { last_modified_time: 1767261600 },
          author: { uid: "8888", nickname: "测试作者" }, cha_list: [{ cha_name: "测试" }], video: { duration: 30000 } }] }) };
  };
  runInNewContext(buildReaderScript("test", { recordType: type, cursor: "123", accountId: expectedAccount }), {
    window, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, location: { origin: "https://www.douyin.com" },
    performance: { getEntriesByType: () => [{ name: "https://www.douyin.com/aweme/v1/web/history/read/?aid=6383&webid=123&msToken=secret" }] },
  });
  return { message: await message, requests };
}

describe("Android collection boundaries", () => {
  it("resumes history, uses the owner's likes, and sends collection pagination as a POST form", async () => {
    for (const type of ["watch_history", "liked_videos", "favorite_videos"] as const) {
      const result = await read(type);
      const parsed = parseCollectionPage(result.message);
      expect(parsed).toMatchObject({ cursor: "123", nextCursor: "456", recordType: type, hasMore: true });
      const request = result.requests.find(item => !item.url.pathname.includes("profile/self"))!;
      if (type === "favorite_videos") {
        expect(request.init).toMatchObject({ method: "POST", body: "count=10&cursor=123" });
      } else expect(request.url.searchParams.get("max_cursor")).toBe("123");
      if (type === "liked_videos") expect(request.url.searchParams.get("sec_user_id")).toBe("MS4wLjABAAAA123456789");
      expect(parsed.records[0]?.watchedAt !== null).toBe(type === "watch_history");
      expect(parsed.records[0]?.durationSeconds).toBe(30);
      expect(JSON.stringify(result.message)).not.toContain("secret");
    }
  });

  it("stops on a repeated cursor and refuses another account before reading content", async () => {
    expect((await read("watch_history", "123")).message).toMatchObject({ type: "error", code: "pagination" });
    const wrong = await read("watch_history", "456", "99999");
    expect(wrong.message).toMatchObject({ type: "error", code: "account" });
    expect(wrong.requests).toHaveLength(1);
  });

  it("migrates the old page, deduplicates refreshes, keeps repeat view events, and isolates accounts", () => {
    const old = migrateProof({ version: 1, revision: 3, account, savedAt: "2026-01-01T12:00:00.000Z", hasMore: true,
      records: [{ id: "98765", title: "旧版合成作品", author: "测试作者", watchedAt: null }] });
    let saved = mergeCollectionPage(old, page());
    saved = mergeCollectionPage(saved, page());
    expect(saved.collections.watch_history.records).toHaveLength(1);
    saved = mergeCollectionPage(saved, page({ cursor: "20", nextCursor: null, hasMore: false,
      records: [{ ...page().records[0]!, watchedAt: "2026-01-02T10:00:00.000Z" }] }));
    expect(saved.collections.watch_history.records).toHaveLength(2);
    expect(parseMobileSnapshot(JSON.stringify(saved))).toEqual(saved);
    expect(personalRecords(saved).watch_history.map(item => item.id)).toHaveLength(2);
    expect(() => mergeCollectionPage(saved, page({ account: { id: "67890", nickname: "另一合成账号" } }))).toThrow("账号");
  });

  it("retains the last saved page and cursor through an interrupted write and cold reload", async () => {
    disk.files.clear(); disk.failWrite = false;
    const first = await saveCollectionPage(null, page());
    disk.failWrite = true;
    await expect(saveCollectionPage(first, page({ cursor: "20", nextCursor: "40" }))).rejects.toThrow("interrupted");
    const restored = await loadCollections();
    expect(restored.snapshot).toEqual(first);
    expect(restored.snapshot?.collections.watch_history.nextCursor).toBe("20");
    expect(restored.warning).toContain("恢复");
    disk.failWrite = false;
  });

  it("migrates a legacy file without overwriting it", async () => {
    disk.files.clear();
    const legacy = JSON.stringify({ version: 1, revision: 1, account, savedAt: "2026-01-01T12:00:00.000Z", hasMore: true,
      records: [{ id: "98765", title: "合成作品", author: "作者", watchedAt: null }] });
    disk.files.set("page-1.json", legacy);
    const loaded = await loadCollections();
    expect(loaded.snapshot?.collections.watch_history.records).toHaveLength(1);
    expect(disk.files.get("page-1.json")).toBe(legacy);
    expect((await loadCollections()).snapshot).toEqual(loaded.snapshot);
  });

  it("builds offline reports from the same records without inventing years and escapes exported text", () => {
    const saved = mergeCollectionPage(null, page({ recordType: "liked_videos",
      records: [{ ...page().records[0]!, title: "<script>alert(1)</script>", author: "<合成作者>" }] }));
    expect(buildMobileReport(saved, "annual").years).toEqual([]);
    const summary = buildMobileReport(saved, "summary");
    expect(summary.coverage).toContain("0 条有可靠行为时间");
    expect(summary.sections.find(item => item.title === "创作者宇宙")?.bars[0]?.label).toBe("<合成作者>");
    expect(reportHtml(summary)).toContain("&lt;合成作者&gt;");
    expect(reportHtml(summary)).not.toContain("<script>");
    expect(buildMobileReport(saved, "living").sections).toHaveLength(6);
  });
});

it("estimates watch progress from the gap to the next viewing, like the desktop app", () => {
  const row = (id: string, at: string) => ({ id, title: `合成 ${id}`, author: "测试作者", watchedAt: at, topics: [], durationSeconds: 60, mediaType: "video" });
  const snapshot = mergeCollectionPage(null, parseCollectionPage({ account, recordType: "watch_history", cursor: "0", hasMore: false, records: [
    row("101", "2026-01-01T10:00:00.000Z"), row("102", "2026-01-01T10:00:15.000Z"), row("103", "2026-01-01T10:01:15.001Z"), row("104", "2026-01-01T10:01:15.003Z"),
  ] }));
  const byId = new Map(personalRecords(snapshot).watch_history.map(item => [item.videoId, item.watchProgress]));
  expect(byId.get("101")).toEqual({ watchedSeconds: 15, percent: 25 }); // 15 s on screen before the next one
  expect(byId.get("103")).toEqual({ watchedSeconds: 60, percent: 100 }); // the next record 2 ms later = left after finishing
  expect(byId.get("104")).toBeNull(); // newest: nothing after it yet
});
