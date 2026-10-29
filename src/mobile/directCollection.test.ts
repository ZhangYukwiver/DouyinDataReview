import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTION_TYPES, mergeCollectionPage, parseCollectionPage, type CollectionPage, type MobileSnapshot } from "./collectionData";

const bridge = vi.hoisted(() => ({ prepare: vi.fn(), request: vi.fn() }));
vi.mock("./nativeBridge", () => ({ nativeBridge: bridge }));
import { syncAllContent } from "./directCollection";

const account = { id: "12345", nickname: "合成测试账号" };
const makePage = (recordType: CollectionPage["recordType"]) => parseCollectionPage({
  account, recordType, cursor: "0", hasMore: false, nextCursor: null,
  records: [{ id: "98765", title: "合成测试作品", author: "测试作者", watchedAt: "2026-01-01T10:00:00.000Z" }],
});
function baseline() {
  let snapshot: MobileSnapshot | null = null;
  for (const { id } of COLLECTION_TYPES) {
    snapshot = mergeCollectionPage(snapshot, makePage(id));
    snapshot.collections[id].incrementalReady = true;
  }
  return snapshot!;
}
function handlers(initial = baseline()) {
  let snapshot = initial;
  return {
    getSnapshot: () => snapshot,
    savePage: async (page: CollectionPage) => { snapshot = mergeCollectionPage(snapshot, page); },
    saveState: async (value: MobileSnapshot) => { snapshot = value; },
    progress: vi.fn(),
  };
}
const content = (more = true, id = "98765") => ({ status_code: 0, has_more: more ? 1 : 0, max_cursor: "20", cursor: "20",
  aweme_date: { [id]: 1767261600 }, aweme_list: [{ aweme_id: id, desc: "合成测试作品", author: { nickname: "测试作者" }, video: { duration: 30000 } }] });
const contentCalls = () => bridge.request.mock.calls.filter(([value]) => !/profile\/self|query\/user/u.test(value));
beforeEach(() => {
  bridge.prepare.mockReset(); bridge.request.mockReset();
  bridge.prepare.mockImplementation(async (path, query) => ({ url: `https://www.douyin.com${path}?${new URLSearchParams(JSON.parse(query))}`, userAgent: "Mozilla/5.0 Chrome/151.0.0.0" }));
  bridge.request.mockImplementation(async value => JSON.stringify(value.includes("profile/self")
    ? { status_code: 0, user: { uid: account.id, nickname: account.nickname, sec_uid: "MS4wLjABAAAA123456789" } }
    : value.includes("query/user") ? { status_code: 0, user_uid: account.id } : content()));
});

describe("native incremental collection", () => {
  it("updates all three types and stops each completed baseline at an existing event", async () => {
    const store = handlers();
    expect(await syncAllContent("incremental", new AbortController().signal, store)).toEqual({ watch_history: 0, liked_videos: 0, favorite_videos: 0 });
    expect(contentCalls()).toHaveLength(3);
    expect(contentCalls().find(([value]) => value.includes("listcollection"))?.[1]).toBe("count=10&cursor=0");
    for (const { id } of COLLECTION_TYPES) expect(store.getSnapshot().collections[id]).toMatchObject({ incrementalReady: true, hasMore: false, nextCursor: null });
  });

  it("invalidates an interrupted baseline so the next run reads past already saved pages", async () => {
    const store = handlers(), controller = new AbortController();
    const savePage = store.savePage;
    store.savePage = async page => { await savePage(page); controller.abort(); };
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (value, body) => value.includes("history/read") ? JSON.stringify(content(true, "98766")) : request(value, body));
    await expect(syncAllContent("incremental", controller.signal, store)).rejects.toThrow("cancelled");
    expect(store.getSnapshot().collections.watch_history.incrementalReady).toBe(false);
    store.savePage = savePage; bridge.request.mockClear();
    bridge.request.mockImplementation(async (value, body) => value.includes("history/read")
      ? JSON.stringify(content(new URL(value).searchParams.get("max_cursor") === "0", "98766")) : request(value, body));
    await syncAllContent("incremental", new AbortController().signal, store);
    expect(contentCalls().filter(([value]) => value.includes("history/read"))).toHaveLength(2);
    expect(store.getSnapshot().collections.watch_history.records).toHaveLength(2);
  });

  it("rejects an account change before saving its content", async () => {
    const store = handlers(), request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (value, body) => value.includes("query/user")
      ? JSON.stringify({ status_code: 0, user_uid: "99999" }) : request(value, body));
    await expect(syncAllContent("incremental", new AbortController().signal, store)).rejects.toThrow("account");
    expect(store.getSnapshot().collections.watch_history.records).toEqual(makePage("watch_history").records);
    expect(contentCalls()).toHaveLength(1);
  });
});
