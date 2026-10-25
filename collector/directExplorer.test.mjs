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
  it("does not expand comment replies any more", async () => {
    const { value, api } = explorer(async () => ({ status_code: 0, comments: [{ cid: "1234567890", text: "评论" }], has_more: 0 }));
    const comments = await value.read({ kind: "comments", id });
    await expect(value.read({ kind: "replies", id, commentId: "1234567890", sessionId: comments.sessionId })).rejects.toMatchObject({ code: "invalid_request" });
    expect(api.request).toHaveBeenCalledTimes(1);
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
