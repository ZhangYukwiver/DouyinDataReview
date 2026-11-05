import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectExplorer } from "./directExplorer.mjs";
import { DouyinExplorer } from "./explorer.mjs";
import { directApiFixture } from "./fixtures/directClient.mjs";

const id = "7654321098765432100";
const userId = `MS4w${"x".repeat(24)}`;
const rawVideo = (videoId = id) => ({ aweme_id: videoId, desc: "作品", user_digged: 1, collect_status: 0 });
function explorer(handler) {
  const getContext = vi.fn(() => { throw new Error("browser must not launch"); });
  const api = { request: vi.fn(handler) };
  return { value: new DirectExplorer(getContext, async () => api), api, getContext };
}
afterEach(() => vi.restoreAllMocks());

describe("code-based exploration", () => {
  it("loads and paginates user search without a browser, retaining its search id", async () => {
    const { value, api, getContext } = explorer(async (_path, { query }) => ({ status_code: 0,
      user_list: [{ user_info: { sec_uid: query.offset === "0" ? userId : `MS4w${"y".repeat(24)}`, nickname: "用户" } }],
      cursor: "20", has_more: query.offset === "0" ? 1 : 0, log_pb: { impr_id: "123" } }));
    const first = await value.read({ kind: "users", query: "猫" });
    const second = await value.read({ kind: "users", query: "猫", sessionId: first.sessionId });
    expect(second.items).toHaveLength(2); expect(second.hasMore).toBe(false);
    expect(api.request.mock.calls[1][1].query).toMatchObject({ offset: "20", search_id: "123", search_channel: "aweme_user_web" });
    expect(getContext).not.toHaveBeenCalled(); await value.clear();
  });
  it("keeps a successfully loaded page and cursor when a later response is malformed", async () => {
    const { value } = explorer(async (_path, { query }) => ({ status_code: 0, data: [{ aweme_info: rawVideo() }],
      cursor: query.offset === "0" ? "20" : "invalid", has_more: 1 }));
    const first = await value.read({ kind: "videos", query: "猫" });
    const previous = value.sessions.get(first.sessionId);
    await expect(value.read({ kind: "videos", query: "猫", sessionId: first.sessionId })).rejects.toMatchObject({ code: "pagination_stalled" });
    expect(value.sessions.get(first.sessionId)).toBe(previous);
    expect(previous.cursor).toBe("20"); expect(previous.items.size).toBe(1);
  });
  it("loads profile and published works through independent endpoints", async () => {
    const { value, api, getContext } = explorer(async (pathname) => pathname.includes("profile")
      ? { status_code: 0, user: { sec_uid: userId, nickname: "用户" } }
      : { status_code: 0, aweme_list: [rawVideo()], has_more: 0 });
    const result = await value.read({ kind: "profile", id: userId });
    expect(result.profile.id).toBe(userId); expect(result.items[0].videoId).toBe(id);
    expect(result.profile.self).toBe(false);
    api.secUid = userId;
    expect((await value.read({ kind: "profile", id: userId })).profile.self).toBe(true);
    expect(api.request).toHaveBeenCalledTimes(4); expect(getContext).not.toHaveBeenCalled();
  });
  it("only accepts the requested detail and exposes confirmed liked/collected flags", async () => {
    const { value } = explorer(async () => ({ status_code: 0, aweme_detail: rawVideo() }));
    const result = await value.read({ kind: "detail", id });
    expect(result.video).toMatchObject({ videoId: id, liked: true, collected: false });
    await expect(value.read({ kind: "detail", id: "1234567890" })).rejects.toMatchObject({ code: "schema_changed" });
    expect(value.sessions.size).toBe(1);
  });
  it("pages the home feed by refresh index and leaves out lives and ads", async () => {
    const playable = (videoId, extra = {}) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } }, ...extra });
    const { value, api } = explorer(async (_path, { query }) => ({ status_code: 0, has_more: 1, aweme_list: [
      playable(`${query.refresh_index}000000000000000001`), playable(`${query.refresh_index}000000000000000002`, { is_ads: true }),
      { ...rawVideo(`${query.refresh_index}000000000000000003`), cell_room: {} }] }));
    const first = await value.read({ kind: "feed" });
    const second = await value.read({ kind: "feed", sessionId: first.sessionId });
    expect(second.items.map((item) => item.videoId)).toEqual(["1000000000000000001", "2000000000000000001"]);
    expect(api.request.mock.calls.map(([pathname, { query }]) => [pathname, query.refresh_index, query.pull_type]))
      .toEqual([["/aweme/v1/web/tab/feed/", "1", "0"], ["/aweme/v1/web/tab/feed/", "2", "2"]]);
    expect(second.hasMore).toBe(true);
  });
  it("mixes one video for the wanted words after every three recommendations, taking the words in turn", async () => {
    const playable = (videoId) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    const searched = [];
    const { value } = explorer(async (pathname, { query }) => {
      if (pathname.endsWith("/tab/feed/")) return { status_code: 0, has_more: 1, aweme_list: [1, 2, 3, 4].map((n) => playable(`${query.refresh_index}0000${n}`)) };
      searched.push([query.keyword, query.offset]);
      const base = `${query.keyword === "猫" ? 7 : 8}${query.offset}`;
      // 搜出来和推荐撞了的那条不再插
      return { status_code: 0, has_more: 1, cursor: Number(query.offset) + 10, data: [{ aweme_info: playable("100002") }, ...[1, 2].map((n) => ({ aweme_info: playable(`${base}000${n}`) }))] };
    });
    const first = await value.read({ kind: "feed", words: [" 猫 ", "狗", "猫", ""] });
    expect(first.items.map((item) => item.videoId)).toEqual(["100001", "100002", "100003", "700001", "100004", "800001"]);
    expect(first.items[3].pickedFor).toBe("猫");
    const second = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫", "狗"] });
    expect(second.items.slice(6).map((item) => item.videoId)).toEqual(["200001", "200002", "200003", "700002", "200004", "800002"]);
    const third = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫", "狗"] });
    expect(third.items.slice(12).map((item) => item.videoId)).toEqual(["300001", "300002", "300003", "7100001", "300004", "8100001"]);
    expect(searched).toEqual([["猫", "0"], ["狗", "0"], ["猫", "10"], ["狗", "10"]]);
  });
  it("mixes the words as often as the setting says", async () => {
    const playable = (videoId) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    const { value } = explorer(async (pathname, { query }) => pathname.endsWith("/tab/feed/")
      ? { status_code: 0, has_more: 1, aweme_list: [1, 2, 3].map((n) => playable(`${query.refresh_index}0000${n}`)) }
      : { status_code: 0, has_more: 0, data: [1, 2, 3, 4].map((n) => ({ aweme_info: playable(`70000${n}`) })) });
    const first = await value.read({ kind: "feed", words: ["猫"], pickEvery: 1 });
    expect(first.items.map((item) => item.videoId)).toEqual(["100001", "700001", "100002", "700002", "100003", "700003"]);
    expect((await value.read({ kind: "feed", words: ["猫"], pickEvery: 99 })).items.map((item) => item.videoId))
      .toEqual(["100001", "100002", "100003", "700001"]);
  });
  it("shows only the word videos when asked, and falls back to the feed when the words find nothing", async () => {
    const playable = (videoId) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    let found = true;
    const { value } = explorer(async (pathname, { query }) => pathname.endsWith("/tab/feed/")
      ? { status_code: 0, has_more: 1, aweme_list: [1, 2, 3].map((n) => playable(`${query.refresh_index}0000${n}`)) }
      : { status_code: 0, has_more: 1, cursor: Number(query.offset) + 10, data: found ? [1, 2, 3, 4].map((n) => ({ aweme_info: playable(`7${query.offset}000${n}`) })) : [] });
    const first = await value.read({ kind: "feed", words: ["猫"], pickEvery: 0 });
    expect(first.items.map((item) => item.videoId)).toEqual(["700001", "700002", "700003"]);
    // 队列只剩一条、不够一批，接着搜下一页
    const second = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫"], pickEvery: 0 });
    expect(second.items.slice(3).map((item) => item.videoId)).toEqual(["700004", "7100001", "7100002"]);
    found = false;
    const third = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫"], pickEvery: 0 });
    const fourth = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫"], pickEvery: 0 });
    expect(fourth.items.slice(6).map((item) => item.videoId)).toEqual(["7100003", "7100004", "400001", "400002", "400003"]);
    expect(third.items).toHaveLength(8);
  });
  it("keeps a word video that the replaced batch also recommended when showing only word videos", async () => {
    const playable = (videoId) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    const { value } = explorer(async (pathname) => pathname.endsWith("/tab/feed/")
      ? { status_code: 0, has_more: 1, aweme_list: ["100001", "100002", "100003"].map(playable) }
      : { status_code: 0, has_more: 0, data: ["100002", "700001", "700002"].map((videoId) => ({ aweme_info: playable(videoId) })) });
    const first = await value.read({ kind: "feed", words: ["猫"], pickEvery: 0 });
    expect(first.items.map((item) => [item.videoId, item.pickedFor])).toEqual([["100002", "猫"], ["700001", "猫"], ["700002", "猫"]]);
  });
  describe("屏蔽词条", () => {
    const playable = (videoId, desc = "作品") => ({ ...rawVideo(videoId), desc, video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    const feed = (search = []) => explorer(async (pathname) => pathname.endsWith("/tab/feed/")
      ? { status_code: 0, has_more: 1, aweme_list: [playable("100001"), playable("100002", "露营装备"), playable("100003")] }
      : { status_code: 0, has_more: 1, cursor: 10, data: search.map((aweme) => ({ aweme_info: aweme })) });
    const shown = (page) => page.items.map((item) => item.videoId);

    it("hides matching recommendations and reports them, whether or not feedback was asked for", async () => {
      for (const mode of ["hide", "dislike"]) {
        const page = await feed().value.read({ kind: "feed", rules: "露营", mode });
        expect(shown(page)).toEqual(["100001", "100003"]);
        expect(page.filtered).toEqual([expect.objectContaining({ id: "100002", action: "hidden", matched: ["露营"], t: expect.any(Number) })]);
      }
    });
    it("only reports matches when observing and leaves the feed alone when off", async () => {
      const observed = await feed().value.read({ kind: "feed", rules: "露营", mode: "observe" });
      expect(shown(observed)).toEqual(["100001", "100002", "100003"]);
      expect(observed.filtered).toEqual([expect.objectContaining({ id: "100002", action: "observed" })]);
      const off = await feed().value.read({ kind: "feed", rules: "露营", mode: "off" });
      expect(shown(off)).toEqual(["100001", "100002", "100003"]);
      expect(off.filtered).toBeUndefined();
    });
    it("never inserts a word video that matches, in any mode, and rests a word whose whole page matched", async () => {
      for (const mode of ["off", "observe", "hide"]) {
        const { value } = feed([playable("700001", "露营vlog"), playable("700002", "山里过夜")]);
        expect(shown(await value.read({ kind: "feed", words: ["露营"], rules: "露营", mode, pickEvery: 1 }))).toContain("700002");
        expect(shown(await value.read({ kind: "feed", words: ["露营"], rules: "露营", mode, pickEvery: 1 }))).not.toContain("700001");
      }
      const { value, api } = feed([playable("700001", "露营vlog")]);
      const first = await value.read({ kind: "feed", words: ["露营"], rules: "露营", mode: "hide" });
      await value.read({ kind: "feed", sessionId: first.sessionId, words: ["露营"], rules: "露营", mode: "hide" });
      expect(api.request.mock.calls.filter(([pathname]) => pathname.includes("search"))).toHaveLength(1);
    });
    it("checks queued word videos against the rules saved since they were found", async () => {
      const { value } = explorer(async (pathname, { query }) => pathname.endsWith("/tab/feed/")
        ? { status_code: 0, has_more: 1, aweme_list: [playable(`${query.refresh_index}00001`)] }
        : { status_code: 0, has_more: 0, data: [playable("700001", "新屏蔽"), playable("700002", "新屏蔽"), playable("700003")].map((aweme) => ({ aweme_info: aweme })) });
      const first = await value.read({ kind: "feed", words: ["猫"] });
      expect(shown(first)).toEqual(["100001", "700001"]);
      const second = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫"], rules: "新屏蔽", mode: "observe" });
      expect(shown(second)).toEqual(["100001", "700001", "200001", "700003"]);
    });
  });
  it("keeps the plain feed and stops searching for a while when a word search asks for verification", async () => {
    const playable = (videoId) => ({ ...rawVideo(videoId), video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/a.mp4"] } } });
    const { value, api } = explorer(async (pathname, { query }) => pathname.endsWith("/tab/feed/")
      ? { status_code: 0, has_more: 1, aweme_list: [playable(`${query.refresh_index}00001`)] }
      : { status_code: 0, search_nil_info: { search_nil_type: "verify_check" } });
    const first = await value.read({ kind: "feed", words: ["猫"] });
    const second = await value.read({ kind: "feed", sessionId: first.sessionId, words: ["猫"] });
    expect(second.items.map((item) => item.videoId)).toEqual(["100001", "200001"]);
    expect(api.request.mock.calls.filter(([pathname]) => pathname.includes("search"))).toHaveLength(1);
  });
  it("likes with a single write and never rolls back a write whose receipt was lost", async () => {
    const csrf = { headers: { "x-ware-csrf-token": "1,csrf" } };
    const { api, fetch } = directApiFixture((url) => url.pathname === "/service/2/abtest_config/" ? csrf : { payload: { status_code: 0 } });
    const value = new DirectExplorer(null, async () => api);
    await expect(value.react({ awemeId: id, action: "share", desired: true })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(value.react({ awemeId: id, action: "like", desired: true })).resolves.toEqual({ outcome: "confirmed", value: true, message: "已点赞" });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/service/2/abtest_config/", "/aweme/v1/web/commit/item/digg/"]);
    const lost = directApiFixture((url) => url.pathname === "/service/2/abtest_config/" ? csrf : Promise.reject(new Error("connection closed")));
    await expect(new DirectExplorer(null, async () => lost.api).react({ awemeId: id, action: "collect", desired: false })).resolves.toMatchObject({ outcome: "unknown" });
    await api.close(); await lost.api.close();
  });
  it("posts a creator-center reply to a reply without opening a comments session", async () => {
    const csrf = { headers: { "x-ware-csrf-token": "1,csrf" } };
    const { api, fetch } = directApiFixture((url) => url.pathname === "/service/2/abtest_config/" ? csrf
      : { payload: { status_code: 0, comment: { cid: "7000000000000000009", text: "谢谢 你", aweme_id: id } } });
    const value = new DirectExplorer(null, async () => api);
    await expect(value.react({ awemeId: id, action: "comment", text: "  " })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(value.react({ awemeId: id, action: "comment", text: "谢谢\n你", replyTo: "7000000000000000001", replyToReply: "7000000000000000002" }))
      .resolves.toMatchObject({ outcome: "confirmed", message: "回复已发送", comment: { id: "7000000000000000009" } });
    const [url, options] = fetch.mock.calls.at(-1);
    expect(new URL(url).pathname).toBe("/aweme/v1/web/comment/publish");
    expect(Object.fromEntries(new URLSearchParams(options.data))).toMatchObject({ aweme_id: id, text: "谢谢 你", reply_id: "7000000000000000001", reply_to_reply_id: "7000000000000000002" });
    await api.close();
  });
  it("reports the video just left like the site: resume point for long ones, then the finish flag with the next write", async () => {
    const csrf = { headers: { "x-ware-csrf-token": "1,csrf" } };
    const { api, fetch } = directApiFixture((url) => url.pathname === "/service/2/abtest_config/" ? csrf : { payload: { status_code: 0 } });
    const value = new DirectExplorer(null, async () => api);
    const writes = () => fetch.mock.calls.filter(([url]) => new URL(url).pathname !== "/service/2/abtest_config/")
      .map(([url, options]) => [new URL(url).pathname, Object.fromEntries(new URLSearchParams(options.data))]);
    const prev = "7654321098765432101";
    await value.seen({ awemeId: id, authorId: "123", previous: { awemeId: prev, positionMs: 1_308_033, durationMs: 1_337_089, finished: true } });
    expect(writes()).toEqual([
      ["/aweme/v1/web/play/progress/", { item_duration: "1337089", item_id: prev, item_progress: "1308033" }],
      ["/aweme/v1/web/history/write/", { author_id: "123", aweme_id: id, pre_item_id: prev, pre_item_seen: "1" }],
    ]);
    fetch.mockClear();
    await value.seen({ awemeId: id, authorId: "123", previous: { awemeId: prev, positionMs: 4_000, durationMs: 30_000, finished: false } });
    expect(writes()).toEqual([["/aweme/v1/web/history/write/", { author_id: "123", aweme_id: id, pre_item_id: prev, pre_item_seen: "0" }]]);
    fetch.mockClear();
    await value.seen({ previous: { awemeId: prev, positionMs: 600_000, durationMs: 1_430_466, finished: false } });
    expect(writes().map(([path]) => path)).toEqual(["/aweme/v1/web/play/progress/"]);
    await expect(value.seen({})).rejects.toMatchObject({ code: "invalid_request" });
    await expect(value.seen({ awemeId: id, authorId: "123", previous: { awemeId: prev, positionMs: -1, durationMs: 9, finished: true } })).rejects.toMatchObject({ code: "invalid_request" });
    await api.close();
  });
  it("loads replies for the selected parent and rejects comments from another thread", async () => {
    const commentId = "1234567890";
    const { value } = explorer(async (pathname) => pathname.endsWith("/reply/")
      ? { status_code: 0, comments: [{ cid: "2345678901", text: "回复", reply_id: commentId, aweme_id: id }], has_more: 0 }
      : { status_code: 0, comments: [{ cid: commentId, text: "评论" }], has_more: 0 });
    const comments = await value.read({ kind: "comments", id });
    const replies = await value.read({ kind: "replies", id, commentId, sessionId: comments.sessionId });
    expect(replies.items[0]).toMatchObject({ id: "2345678901", parentId: commentId });
    await expect(value.read({ kind: "replies", id, commentId: "3456789012", sessionId: comments.sessionId })).rejects.toMatchObject({ code: "session_expired" });
  });
  it("does not commit a response after the caller has cancelled", async () => {
    let resolve;
    const { value, api } = explorer(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const work = value.read({ kind: "detail", id }, { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(api.request).toHaveBeenCalled()); controller.abort();
    resolve({ status_code: 0, aweme_detail: rawVideo() }); await rejected;
    expect(value.sessions.size).toBe(0);
  });
  it("confirms an already-matching state without a browser or a write", async () => {
    const { value, getContext } = explorer(async () => ({ status_code: 0, aweme_detail: rawVideo() }));
    const result = await value.read({ kind: "detail", id });
    const send = vi.spyOn(DouyinExplorer.prototype, "interact");
    const input = { sessionId: result.sessionId, action: "like", desired: true, requestId: "request-1234567890" };
    expect(await value.interact(input)).toMatchObject({ outcome: "confirmed", value: true });
    expect(send).not.toHaveBeenCalled(); expect(value.sessions.get(result.sessionId).page).toBeUndefined();
    expect(getContext).not.toHaveBeenCalled();
  });
});

describe("direct exploration writes and ambiguity",()=>{
  function setup({fail=false,wrongComment=false,delayedReads=0}={}) {
    let liked=false,lagRemaining=0;
    const fixture=directApiFixture((url,options)=>{
      if(url.pathname==="/service/2/abtest_config/") return {headers:{"x-ware-csrf-token":"1,fresh-csrf"}};
      if(url.pathname.includes("/digg/")) { liked=new URLSearchParams(options.data).get("type")==="1"; lagRemaining=delayedReads; if(fail) throw new Error("closed after accepting"); return {payload:{status_code:0}}; }
      if(url.pathname.includes("/comment/publish")) return {payload:{status_code:0,comment:{cid:"1234567890123",text:wrongComment ? "different" : "测试评论"}}};
      const stale=lagRemaining>0;if(stale)lagRemaining-=1;
      return {payload:{status_code:0,aweme_detail:{...rawVideo(),user_digged:(stale?!liked:liked)?1:0}}};
    });
    const getContext=vi.fn(()=>{throw new Error("browser must not launch");});
    return {...fixture,value:new DirectExplorer(getContext,async()=>fixture.api),getContext};
  }
  it("confirms only after readback and deduplicates concurrent and completed requests",async()=>{
    const {value,api,fetch,getContext}=setup(); const page=await value.read({kind:"detail",id});
    const input={sessionId:page.sessionId,action:"like",desired:true,requestId:"request-1234567890"};
    const results=await Promise.all([value.interact(input),value.interact(input)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]).toMatchObject({outcome:"confirmed",value:true});
    expect(fetch.mock.calls.filter(([url])=>url.includes("/digg/"))).toHaveLength(1);
    expect(await value.interact(input)).toEqual(results[0]);
    await expect(value.interact({...input,desired:false})).rejects.toMatchObject({code:"invalid_request"});
    expect(getContext).not.toHaveBeenCalled(); await value.clear(); await api.close();
  });
  it("retains an unknown result after dispatch and never repeats the write",async()=>{
    const {value,api,fetch}=setup({fail:true}); const page=await value.read({kind:"detail",id});
    const input={sessionId:page.sessionId,action:"like",desired:true,requestId:"request-unknown-123"};
    const result=await value.interact(input); expect(result.outcome).toBe("unknown");
    expect(await value.interact(input)).toEqual(result);
    expect(fetch.mock.calls.filter(([url])=>url.includes("/digg/"))).toHaveLength(1);
    await value.clear(); await api.close();
  });
  it("confirms a delayed state through read polling without repeating the accepted write",async()=>{
    const {value,api,fetch}=setup({delayedReads:2});
    const page=await value.read({kind:'detail',id});
    expect(await value.interact({sessionId:page.sessionId,action:'like',desired:true,requestId:'request-delayed-123'})).toMatchObject({outcome:'confirmed',value:true});
    expect(fetch.mock.calls.filter(([url])=>url.includes('/digg/'))).toHaveLength(1);
    await value.clear();await api.close();
  });
  it("does not confirm a comment with a different text",async()=>{
    const {value,api}=setup({wrongComment:true}); const page=await value.read({kind:"detail",id});
    expect((await value.interact({sessionId:page.sessionId,action:"comment",text:"测试评论",requestId:"request-comment-123"})).outcome).toBe("unknown");
    await value.clear(); await api.close();
  });
  it("lets the comment just posted be replied to without reloading the list",async()=>{
    const {value,api}=setup(); const page=await value.read({kind:"detail",id});
    await expect(value.interact({sessionId:page.sessionId,action:"comment",text:"测试评论",replyTo:"9999999999",requestId:"request-reply-unknown"})).rejects.toMatchObject({code:"comment_unavailable"});
    expect((await value.interact({sessionId:page.sessionId,action:"comment",text:"测试评论",requestId:"request-comment-123"})).outcome).toBe("confirmed");
    expect((await value.interact({sessionId:page.sessionId,action:"comment",text:"测试评论",replyTo:"1234567890123",requestId:"request-reply-123"})).outcome).toBe("confirmed");
    await value.clear(); await api.close();
  });
  it("keeps share state on refresh and allows retry only after a pre-dispatch failure",async()=>{
    const {api}=directApiFixture(()=>({payload:{status_code:0,aweme_detail:{...rawVideo(),author:{uid:'789',sec_uid:userId,nickname:'作者'},is_aigc:true,ai_ext:{declared:true}}}}));
    const conversation={id:"0:1:123:456",shortId:"7654321098765432100",type:1,name:"好友"};
    const chat={api,conversations:new Map([[conversation.id,conversation]]),send:vi.fn(async(_request,{onDispatch})=>{onDispatch();return {outcome:"confirmed"};})};
    const getChat=vi.fn(async()=>chat);const value=new DirectExplorer(()=>{throw new Error("browser must not launch");},async()=>api,getChat);
    const page=await value.read({kind:"sharees",id});const input={sessionId:page.sessionId,action:"share",targetId:"456",requestId:"request-share-123456"};
    getChat.mockRejectedValueOnce(new Error("preflight failed"));
    await expect(value.interact(input)).rejects.toThrow("preflight failed"); expect(chat.send).not.toHaveBeenCalled();
    expect((await value.interact(input)).outcome).toBe("confirmed"); expect(chat.send).toHaveBeenCalledOnce();
    expect(chat.send.mock.calls[0][1].content).toMatchObject({uid:'123',secUID:userId,content_name:'作者',itemId:id,is_aigc:true,ai_ext:'{"declared":true}'});
    expect((await value.read({kind:"sharees",id,sessionId:page.sessionId})).items[0].shared).toBe(true);
    await value.clear(); await api.close();
  });
});
