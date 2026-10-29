import { describe, expect, it, vi } from "vitest";
import { directApiFixture } from "./fixtures/directClient.mjs";
import { directWrite, signDirectRequest } from "./directWrites.mjs";

const id = "7654321098765432100";
describe("HTTP interactions", ()=>{
  it.each(["like", "collect", "comment", "deleteComment", "follow"])("uses a fresh CSRF token and sends %s exactly once", async action=>{
    const { api, fetch, signer } = directApiFixture((url,options)=>url.pathname==="/service/2/abtest_config/"
      ? { headers: { "x-ware-csrf-token": "1,fresh-csrf" } }
      : { payload: { status_code: 0 } });
    const dispatched = vi.fn();
    await directWrite(api,action,{awemeId:id,desired:true,text:"测试",commentId:"1234567890",uid:"456",secUid:`MS4w${"y".repeat(24)}`},{onDispatch:dispatched});
    expect(fetch).toHaveBeenCalledTimes(2); expect(dispatched).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[1];
    expect(new URL(url).origin).toBe('https://www-hj.douyin.com');
    expect(options.method).toBe("POST"); expect(options.maxRetries).toBe(0); expect(options.maxRedirects).toBe(0);
    expect(options.headers["x-secsdk-csrf-token"]).toBe("fresh-csrf");
    expect(options.headers["sec-fetch-site"]).toBe("same-site");
    expect(options.headers["sec-fetch-mode"]).toBe("cors");
    expect(options.headers["x-tt-session-dtrait"]).toMatch(/^1_/u);
    const guard = JSON.parse(Buffer.from(options.headers['bd-ticket-guard-client-data'], 'base64'));
    expect(guard.req_content).toBe('ticket,path,timestamp');
    expect(Buffer.from(guard.req_sign, 'base64')).toHaveLength(32);
    expect(options.headers.Referer).toBe('https://www.douyin.com/');
    expect(new URL(url).searchParams.get("uid")).toMatch(/^[a-f0-9]{32}$/u);
    expect(signer.mock.calls[0][1].body).toBe(action==="like" ? "" : options.data);
    if(action==="comment") expect(new URLSearchParams(options.data).get("text")).toBe("测试");
    await api.close();
  });
  it("reuses the operation token for a few minutes and drops it once Douyin refuses a write",async()=>{
    let status=0;
    const {api,fetch}=directApiFixture(url=>url.pathname==="/service/2/abtest_config/" ? {headers:{"x-ware-csrf-token":"1,csrf"}} : {payload:{status_code:status}});
    const csrf=()=>fetch.mock.calls.filter(([url])=>new URL(url).pathname==="/service/2/abtest_config/").length;
    await directWrite(api,"like",{awemeId:id,desired:true}); await directWrite(api,"like",{awemeId:id,desired:false});
    expect(csrf()).toBe(1);
    status=8; await directWrite(api,"collect",{awemeId:id,desired:true});
    status=0; await directWrite(api,"collect",{awemeId:id,desired:false});
    expect(csrf()).toBe(2); await api.close();
  });
  it("records a watched video on the main site with the author and video id",async()=>{
    const {api,fetch}=directApiFixture(url=>url.pathname==="/service/2/abtest_config/" ? {headers:{"x-ware-csrf-token":"1,csrf"}} : {payload:{status_code:0}});
    await expect(directWrite(api,"history",{awemeId:id,authorId:"x"})).rejects.toMatchObject({code:"invalid_request"});
    await directWrite(api,"history",{awemeId:id,authorId:"3723384264069184"});
    const [url, options] = fetch.mock.calls.at(-1);
    expect(new URL(url).origin+new URL(url).pathname).toBe("https://www.douyin.com/aweme/v1/web/history/write/");
    expect(Object.fromEntries(new URLSearchParams(options.data))).toEqual({author_id:"3723384264069184",aweme_id:id});
    expect(options.headers["bd-ticket-guard-client-data"]).toBeTruthy(); await api.close();
  });
  it("rejects missing credentials or invalid targets without any network request",async()=>{
    const {api,fetch}=directApiFixture(()=>({}));
    await expect(directWrite(api,"follow",{uid:"123",secUid:api.session.secUid,desired:true})).rejects.toMatchObject({code:"invalid_request"});
    await expect(directWrite(api,"comment",{awemeId:id,text:""})).rejects.toMatchObject({code:"invalid_request"});
    delete api.session.security;
    await expect(directWrite(api,"like",{awemeId:id,desired:true})).rejects.toMatchObject({code:"write_credentials_missing"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not retry a dispatched write when the connection fails",async()=>{
    const {api,fetch}=directApiFixture(url=>url.pathname==="/service/2/abtest_config/" ? {headers:{"x-ware-csrf-token":"1,csrf"}} : Promise.reject(new Error("connection closed")));
    const dispatched=vi.fn();
    await expect(directWrite(api,"like",{awemeId:id,desired:true},{onDispatch:dispatched})).rejects.toMatchObject({code:"request_failed"});
    expect(dispatched).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2); await api.close();
  });
  it("refuses missing CSRF and a signer pointing away from the allowed host",async()=>{
    const {api,fetch}=directApiFixture(()=>({})); const dispatched=vi.fn();
    await expect(directWrite(api,"collect",{awemeId:id,desired:true},{onDispatch:dispatched})).rejects.toMatchObject({code:"write_credentials_missing"});
    expect(dispatched).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
    api.signer=async()=>`https://example.com/?a_bogus=${"A".repeat(80)}`;
    await expect(signDirectRequest(api,new URL("https://www.douyin.com/aweme/v1/web/aweme/collect/"))).rejects.toMatchObject({code:"unsafe_url"});
    expect(fetch).toHaveBeenCalledOnce(); await api.close();
  });
});
