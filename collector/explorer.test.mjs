import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DouyinExplorer, ingestExploreReplies, ingestExploreResponse, isExploreApiUrl, normalizeExploreComment, normalizeExploreUser, normalizeExploreVideo, validateExploreRequest } from "./explorer.mjs";

const author = { sec_uid: "test-public-author", nickname: "离线测试作者", follower_count: 0, follow_status: 0 };
const aweme = (id) => ({ aweme_id: id, desc: "离线测试作品", author, create_time: 1788912000, user_digged: 0, collect_status: 1, statistics: { digg_count: 0 } });
function session(kind = "videos") { return { kind, id: "", items: new Map(), received: false, revision: 0, hasMore: null }; }

function searchPage(navigate = async () => {}) {
  const page = new EventEmitter();
  let closed = false;
  Object.assign(page, {
    context: () => ({ newCDPSession: async () => ({ on() {}, send: async () => {} }) }), addInitScript: vi.fn(async () => {}),
    goto: vi.fn(navigate), isClosed: () => closed,
    close: vi.fn(async () => { closed = true; page.emit("close"); }),
    title: async () => "抖音搜索", frames: () => [],
    locator: () => ({ innerText: async () => "" }),
  });
  return page;
}
const pendingForever = () => new Promise(() => {});
const searchInput = { kind: "users", query: "离线测试" };
describe("bounded and cancellable exploration", () => {
  it("bounds a stalled browser connection before creating a page", async () => {
    const explorer = new DouyinExplorer(pendingForever);
    await expect(explorer.read(searchInput, { timeoutMs: 20 })).rejects.toMatchObject({ code: "explore_timeout" });
    expect(explorer.sessions.size).toBe(0);
  });
  it("times out a stalled navigation and removes its page", async () => {
    const page = searchPage(pendingForever);
    const explorer = new DouyinExplorer(async () => ({ newPage: async () => page }));
    await expect(explorer.read(searchInput, { timeoutMs: 20 })).rejects.toMatchObject({ code: "explore_timeout" });
    expect(page.close).toHaveBeenCalledOnce();
    expect(explorer.sessions.size).toBe(0);
    expect(page.listenerCount("crash")).toBe(0);
  });
  it("cancels navigation and permits a clean successful retry", async () => {
    const controller = new AbortController();
    const first = searchPage(() => { controller.abort(); return pendingForever(); });
    const next = searchPage(async () => next.emit("response", {
      url: () => `https://www.douyin.com/aweme/v1/web/discover/search/?keyword=${encodeURIComponent(searchInput.query)}`,
      json: async () => ({ user_list: [author], has_more: 0 }),
    }));
    const newPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const explorer = new DouyinExplorer(async () => ({ newPage }));
    await expect(explorer.read(searchInput, { signal: controller.signal })).rejects.toMatchObject({ code: "request_cancelled" });
    expect(first.close).toHaveBeenCalledOnce();
    await expect(explorer.read(searchInput)).resolves.toMatchObject({ items: [expect.objectContaining({ name: author.nickname })] });
    expect(explorer.sessions.size).toBe(1);
    expect(next.close).not.toHaveBeenCalled();
    await explorer.clear();
  });
  it("cleans up a page that finishes creation after cancellation", async () => {
    let resolvePage;
    const newPage = vi.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const explorer = new DouyinExplorer(async () => ({ newPage }));
    const controller = new AbortController();
    const result = explorer.read(searchInput, { signal: controller.signal });
    await vi.waitFor(() => expect(newPage).toHaveBeenCalled());
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "request_cancelled" });
    const page = searchPage(); resolvePage(page);
    await vi.waitFor(() => expect(page.close).toHaveBeenCalledOnce());
    expect(page.goto).not.toHaveBeenCalled();
    expect(explorer.sessions.size).toBe(0);
  });
  it("reports a crashed page immediately and removes the failed session", async () => {
    const page = searchPage(() => { page.emit("crash"); return pendingForever(); });
    const explorer = new DouyinExplorer(async () => ({ newPage: async () => page }));
    await expect(explorer.read(searchInput)).rejects.toMatchObject({ code: "page_crashed" });
    expect(explorer.sessions.size).toBe(0);
    expect(page.close).toHaveBeenCalledOnce();
  });
  it("keeps the verification page and reuses it after the user completes verification", async () => {
    const page = searchPage(); page.title = async () => "验证码中间页";
    page.bringToFront = vi.fn(async () => {});
    const newPage = vi.fn(async () => page);
    const explorer = new DouyinExplorer(async () => ({ newPage }));
    await expect(explorer.read(searchInput, { timeoutMs: 500 })).rejects.toMatchObject({ code: "verification_required" });
    expect(page.close).not.toHaveBeenCalled();
    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(explorer.sessions.size).toBe(1);
    await expect(explorer.read(searchInput)).rejects.toMatchObject({ code: "verification_required" });
    expect(newPage).toHaveBeenCalledOnce();
    page.title = async () => "抖音搜索";
    const state = [...explorer.sessions.values()][0];
    ingestExploreResponse(state, "/aweme/v1/web/discover/search/", { user_list: [author], has_more: 0 });
    await expect(explorer.read(searchInput)).resolves.toMatchObject({ items: [expect.objectContaining({ name: author.nickname })] });
    expect(newPage).toHaveBeenCalledOnce();
    await explorer.clear();
  });
  it("does not show an empty result when the platform opens a verification frame", async () => {
    const page = searchPage(async () => {
      page.emit("response", { url: () => `https://www.douyin.com/aweme/v1/web/discover/search/?keyword=${encodeURIComponent(searchInput.query)}`,
        json: async () => ({ user_list: [], has_more: 0 }) });
      setTimeout(() => page.emit("request", { url: () => "https://rmc.bytedance.com/verifycenter/captcha/v2", resourceType: () => "document" }), 50);
    });
    const explorer = new DouyinExplorer(async () => ({ newPage: async () => page }));
    await expect(explorer.read(searchInput)).rejects.toMatchObject({ code: "verification_required" });
    expect(page.close).not.toHaveBeenCalled();
    await explorer.clear();
  });
  it("retries the same page when verification was requested but no challenge appeared", async () => {
    let calls = 0;
    const page = searchPage(async () => page.emit("response", {
      url: () => `https://www.douyin.com/aweme/v1/web/discover/search/?keyword=${encodeURIComponent(searchInput.query)}`,
      json: async () => ++calls === 1
        ? { user_list: [], status_code: 0, search_nil_info: { search_nil_type: "verify_check" } }
        : { user_list: [author], has_more: 0 },
    }));
    const newPage = vi.fn(async () => page);
    const explorer = new DouyinExplorer(async () => ({ newPage }));
    await expect(explorer.read(searchInput)).rejects.toMatchObject({ code: "verification_required" });
    await expect(explorer.read(searchInput)).resolves.toMatchObject({ items: [expect.objectContaining({ name: author.nickname })] });
    expect(newPage).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledTimes(2);
    await explorer.clear();
  });
  it("reports navigation failure without retaining a dead session", async () => {
    const page = searchPage(async () => { throw Object.assign(new Error("navigation timed out"), { name: "TimeoutError" }); });
    const explorer = new DouyinExplorer(async () => ({ newPage: async () => page }));
    await expect(explorer.read(searchInput)).rejects.toMatchObject({ code: "page_load_failed", status: 504 });
    expect(page.goto).toHaveBeenCalledWith(expect.any(String), { waitUntil: "domcontentloaded", timeout: 20000 });
    expect(explorer.sessions.size).toBe(0);
  });
});

describe("explore data boundaries and pagination", () => {
  it("recognizes the regional Douyin response host while keeping the API scope narrow", () => {
    for (const host of ["www.douyin.com", "www-hj.douyin.com"]) {
      expect(isExploreApiUrl(new URL(`https://${host}/aweme/v1/web/comment/list/?aweme_id=123456789`))).toBe(true);
    }
    for (const address of ["https://douyin.com.example.org/aweme/v1/web/comment/list/", "https://example.org/aweme/v1/web/comment/list/", "https://www-hj.douyin.com/other/", "http://www.douyin.com/aweme/v1/web/comment/list/"]) {
      expect(isExploreApiUrl(new URL(address))).toBe(false);
    }
  });
  it("keeps zero distinct from missing metrics and unknown interaction states", () => {
    expect(normalizeExploreUser(author)).toMatchObject({ followers: 0, likes: null, followed: false });
    expect(normalizeExploreUser({ ...author, follow_status: 99 })).toMatchObject({ followed: null });
    expect(normalizeExploreVideo(aweme("12345678901234567"))).toMatchObject({ occurredAt: null, liked: false, collected: true, stats: { diggCount: 0 } });
  });
  it("does not discard one-character comments or preserve arbitrary image URLs", () => {
    expect(normalizeExploreComment({ cid: "c1", text: "好", user: author, digg_count: 0 })).toMatchObject({ text: "好", likes: 0 });
    expect(normalizeExploreUser({ ...author, avatar_thumb: { url_list: ["https://example.invalid/a.png"] } }).avatar).toBeNull();
  });
  it("keeps sticker-only comments visible and filters untrusted comment images", () => {
    expect(normalizeExploreComment({ cid: "sticker", text: "", sticker: { animate_url: { url_list: ["https://p3.douyinpic.com/sticker.webp"] } },
      image_list: [{ origin_url: { url_list: ["https://example.invalid/image.png"] } }], user: author,
    })).toMatchObject({ text: "", images: ["https://p3.douyinpic.com/sticker.webp"] });
  });
  it("merges subsequent pages and trusts an explicit end marker", () => {
    const state = session();
    const pathname = "/aweme/v1/web/search/item/";
    ingestExploreResponse(state, pathname, { status_code: 0, data: [{ aweme_info: aweme("12345678901234567") }], has_more: 1 });
    expect(state.hasMore).toBe(true);
    ingestExploreResponse(state, pathname, { status_code: 0, data: [{ aweme_info: aweme("12345678901234567") }, { aweme_info: aweme("22345678901234567") }], has_more: 0 });
    expect([...state.items.values()]).toHaveLength(2);
    expect(state.hasMore).toBe(false);
    expect(state.revision).toBe(2);
  });
  it("distinguishes an empty page from unrecognized data", () => {
    const empty = session("users");
    ingestExploreResponse(empty, "/aweme/v1/web/discover/search/", { user_list: [], has_more: 0 });
    expect(empty.received).toBe(true); expect(empty.error).toBeUndefined();
    const changed = session("users");
    ingestExploreResponse(changed, "/aweme/v1/web/search/user/", { user_list: [{ unexpected: true }] });
    expect(changed.error.code).toBe("schema_changed");
  });
  it("recognizes platform verification even when HTTP and status_code report success", () => {
    const state = session("users");
    ingestExploreResponse(state, "/aweme/v1/web/discover/search/", {
      status_code: 0, user_list: [], has_more: 0,
      search_nil_info: { search_nil_type: "verify_check", search_nil_item: "verify_check", text_type: 9 },
    });
    expect(state.received).toBe(false);
    expect(state.error.code).toBe("verification_required");
    ingestExploreResponse(state, "/aweme/v1/web/discover/search/", { status_code: 0, user_list: [author], has_more: 0 });
    expect(state.error).toBeUndefined();
    expect(state.received).toBe(true);
    expect(state.items.size).toBe(1);
  });
  it("treats an empty first response as platform risk control, not a missing page", () => {
    const state = session("users");
    ingestExploreResponse(state, "/aweme/v1/web/ab/params/", null);
    expect(state.error).toBeUndefined();
    ingestExploreResponse(state, "/aweme/v1/web/discover/search/", null);
    expect(state.error.code).toBe("platform_error");
  });
  it("disables remote autoplay before navigating comment and search pages", async () => {
    const page = { context: () => ({ newCDPSession: async () => ({ on() {}, send: async () => {} }) }), addInitScript: vi.fn(async () => {}), on: vi.fn(), goto: vi.fn(async () => {}),
      locator: () => ({ evaluateAll: async () => {}, count: async () => 0 }) };
    const explorer = new DouyinExplorer(async () => ({ newPage: async () => page }));
    await explorer.create({ kind: "comments", id: "123456789" });
    expect(page.addInitScript.mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
  });
  it("requires a supported kind and a concrete search or identifier", () => {
    for (const input of [{ kind: "unknown" }, { kind: "users", query: " " }, { kind: "detail", id: "invalid" }, { kind: "profile", id: "x" }]) expect(() => validateExploreRequest(input)).toThrow();
    expect(validateExploreRequest({ kind: "users", query: "  建筑  " })).toMatchObject({ query: "建筑" });
  });
  it("does not turn an expired pagination session into a new first page", async () => {
    const context = vi.fn(); const explorer = new DouyinExplorer(context);
    await expect(explorer.read({ kind: "users", query: "建筑", sessionId: "expired" })).rejects.toMatchObject({ code: "session_expired" });
    expect(context).not.toHaveBeenCalled();
  });
});

describe("comment reply threads", () => {
  const workId = "123456789";
  const parentId = "222222222";
  const reply = (id, parent = parentId) => ({ cid: id, text: "公开回复", reply_id: parent, aweme_id: workId, user: author });
  function replySession() {
    return { ...session("comments"), key: "comments-session", id: workId, items: new Map([[parentId, { id: parentId }], ["333333333", { id: "333333333" }]]),
      replyThreads: new Map([parentId, "333333333"].map((id) => [id, { items: new Map(), received: false, revision: 0, hasMore: null }])) };
  }
  it("requires both an existing page and a concrete parent identifier", () => {
    for (const input of [{ kind: "replies", id: workId, commentId: parentId },
      { kind: "replies", id: workId, commentId: '12345"]', sessionId: "comments-session" }]) expect(() => validateExploreRequest(input)).toThrow();
    expect(validateExploreRequest({ kind: "replies", id: workId, commentId: parentId, sessionId: "comments-session" })).toMatchObject({ kind: "replies", commentId: parentId });
  });
  it("preserves the parent and the person being replied to", () => {
    expect(normalizeExploreComment({ ...reply("444444444"), reply_to_username: "上一位读者" })).toMatchObject({ parentId, replyToName: "上一位读者" });
  });
  it("merges reply pages without changing the parent list or another thread", () => {
    const state = replySession();
    ingestExploreReplies(state, parentId, { status_code: 0, comments: [reply("444444444")], has_more: 1 });
    ingestExploreReplies(state, parentId, { status_code: 0, comments: [reply("444444444"), reply("555555555"), reply("666666666", "333333333"), null], has_more: 0 });
    expect([...state.replyThreads.get(parentId).items.keys()]).toEqual(["444444444", "555555555"]);
    expect(state.replyThreads.get(parentId).hasMore).toBe(false);
    expect(state.replyThreads.get("333333333").items.size).toBe(0);
    expect(state.items.size).toBe(2);
    expect(state.revision).toBe(0);
  });
  it("retains loaded replies after a failed page and accepts an explicit empty end", () => {
    const state = replySession();
    ingestExploreReplies(state, parentId, { status_code: 0, comments: [reply("444444444")], has_more: 1 });
    ingestExploreReplies(state, parentId, null);
    expect(state.replyThreads.get(parentId).error.code).toBe("platform_error");
    expect(state.replyThreads.get(parentId).items.size).toBe(1);
    ingestExploreReplies(state, parentId, { status_code: 0, status_msg: "blocked" });
    expect(state.replyThreads.get(parentId).error.code).toBe("platform_error");
    ingestExploreReplies(state, parentId, { status_code: 0, comments: null, has_more: 0 });
    expect(state.replyThreads.get(parentId)).toMatchObject({ error: null, hasMore: false, received: true });
  });
  it("rejects stale or mismatched pages before any browser action", async () => {
    const explorer = new DouyinExplorer(vi.fn());
    explorer.sessions.set("comments-session", { ...replySession(), page: { isClosed: () => false } });
    const input = { kind: "replies", id: workId, commentId: parentId, sessionId: "comments-session" };
    await expect(explorer.read({ ...input, sessionId: "expired" })).rejects.toMatchObject({ code: "session_expired" });
    await expect(explorer.read({ ...input, id: "987654321" })).rejects.toMatchObject({ code: "session_expired" });
    await expect(explorer.read({ ...input, commentId: "999999999" })).rejects.toMatchObject({ code: "comment_unavailable" });
  });
});

function interactionPage(initial, clickFailure = false) {
  let pressed = initial;
  const button = { count: async () => 1, evaluate: async () => pressed,
    click: vi.fn(async () => { pressed = !pressed; if (clickFailure) throw new Error("ack lost after click"); }) };
  return { button, pressed: () => pressed, isClosed: () => false, url: () => "https://www.douyin.com/video/12345678901234567", locator: () => button };
}
function interactionExplorer(page) {
  const explorer = new DouyinExplorer(vi.fn());
  explorer.sessions.set("detail-session", { kind: "detail", key: "detail-session", id: "12345678901234567", page, url: page.url() });
  page.reload = async () => { explorer.sessions.get("detail-session").video = { liked: page.pressed(), collected: false }; };
  return explorer;
}
const action = { sessionId: "detail-session", requestId: "one-explicit-user-request", action: "like", desired: true };
describe("single user-directed interactions", () => {
  it("does not toggle an already satisfied state", async () => {
    const page = interactionPage(true);
    await expect(interactionExplorer(page).interact(action)).resolves.toMatchObject({ outcome: "confirmed", value: true });
    expect(page.button.click).not.toHaveBeenCalled();
  });
  it("checks state after a click and deduplicates the same request", async () => {
    const page = interactionPage(false); const explorer = interactionExplorer(page);
    await expect(explorer.interact(action)).resolves.toMatchObject({ outcome: "confirmed", value: true });
    await explorer.interact(action);
    expect(page.button.click).toHaveBeenCalledTimes(1);
  });
  it("keeps a click with a lost acknowledgement pending without a retry", async () => {
    const page = interactionPage(false, true); const explorer = interactionExplorer(page);
    await expect(explorer.interact(action)).resolves.toMatchObject({ outcome: "unknown" });
    await explorer.interact(action);
    expect(page.button.click).toHaveBeenCalledTimes(1);
  });
  it("refuses an unknown state without clicking", async () => {
    const page = interactionPage(null);
    await expect(interactionExplorer(page).interact(action)).resolves.toMatchObject({ outcome: "rejected" });
    expect(page.button.click).not.toHaveBeenCalled();
  }, 12000);
  it("does not let a reused request id target another action", async () => {
    const explorer = interactionExplorer(interactionPage(true));
    await explorer.interact(action);
    await expect(explorer.interact({ ...action, desired: false })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
