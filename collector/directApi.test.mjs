import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectApiClient, loadDirectSession, saveDirectSession, signSecsdkUrl, needsDirectSessionRefresh } from "./directApi.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { DIRECT_SIGNER_COMMIT, DirectHistoryError, signDirectApiUrl } from "./directHistory.mjs";
import { CollectorStore } from "./store.mjs";
import { directApiFixture } from "./fixtures/directClient.mjs";

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const cookie = (name, value) => ({ name, value, domain: ".douyin.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
const session = () => ({ version: 1, uid: "123", secUid: `MS4w${"x".repeat(24)}`, userAgent,
  cookies: [cookie("sessionid", "private-session"), cookie("UIFID", "private-uifid"), cookie("s_v_web_id", "verify-id")],
  values: { aid: "6383", device_platform: "webapp", webid: "1234567890123456789" } });
const directories = [];
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "dy-direct-api-")); directories.push(value); return value; }
async function initializedDirectory() {
  const value = await directory(); await saveDirectSession(value, session());
  await writeTemplate(value);
  return value;
}
async function writeTemplate(value) {
  await writeFile(path.join(value, "direct-history-template.json"), JSON.stringify({
    version: 1, signerCommit: DIRECT_SIGNER_COMMIT, capturedAt: "2026-10-11T00:00:00.000Z",
    parameterOrder: ["count", "max_cursor", "directory", "category", "status", "device_platform", "aid", "webid", "verifyFp", "fp", "uifid"],
    values: session().values, headers: { "user-agent": userAgent },
  }));
}
afterEach(async () => { await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });
function client(handler, options = {}) {
  const context = { fetch: vi.fn(async (url, request) => {
    const result = await handler(new URL(url), request);
    return { status: () => result.status ?? 200, headers: () => result.headers ?? {},
      body: async () => Buffer.from(JSON.stringify(result.payload ?? result)), dispose: vi.fn(async () => {}) };
  }), storageState: vi.fn(async () => ({ cookies: session().cookies, origins: [] })), dispose: vi.fn(async () => {}) };
  const requestFactory = { newContext: vi.fn(async () => context) };
  const api = new DirectApiClient(session(), { requestFactory, ...options });
  return { api, context, requestFactory };
}

describe("direct HTTP signing and account session", () => {
  it("matches the upstream SecSDK vector, preserving spaces and punctuation on the wire", () => {
    const signed = signSecsdkUrl("https://www.douyin.com/aweme/v1/web/aweme/favorite/?keyword=%E7%8C%AB+%21%28%29&uifid=id%2B1&a_bogus=ab%2Fc%3D", "id+1", 1791684000);
    expect(signed).toBe("https://www.douyin.com/aweme/v1/web/aweme/favorite/?keyword=%E7%8C%AB%20!()&uifid=id%2B1&a_bogus=ab%2Fc%3D&timestamp=1791684000&x-secsdk-web-signature=92b7b2aa9a57d331cb11efd8628f122a");
    expect(signSecsdkUrl(signed, "id+1", 1791684000)).toBe(signed);
  });
  it("stores each account separately, removes unrelated/expired cookies and rejects a different uid", async () => {
    const first = await directory(), second = await directory();
    await saveDirectSession(first, { ...session(), cookies: [...session().cookies, { ...cookie("external", "secret"), domain: "example.com" }, { ...cookie("old", "secret"), expires: 1 }] });
    await saveDirectSession(second, { ...session(), uid: "456" });
    expect((await loadDirectSession(first, "123")).cookies).toHaveLength(3);
    expect((await loadDirectSession(second, "456")).uid).toBe("456");
    await expect(loadDirectSession(first, "456")).rejects.toMatchObject({ code: "account_mismatch" });
    expect((await stat(path.join(first, "direct-session.json"))).mode & 0o777).toBe(0o600);
  });
  it("refuses expired login cookies and never forwards cookies to an unrelated host", async () => {
    for(const expires of [0,1])expect(() => new DirectApiClient({ ...session(), cookies: [{ ...cookie("sessionid", "expired"), expires }] })).toThrowError(expect.objectContaining({ code: "direct_session_missing" }));
    const { api } = client(() => ({}));
    expect(await api.cookies("https://example.com/")).toEqual([]);
    expect(await api.cookies("https://www.douyin.com/")).toHaveLength(3);
    await api.close();
  });
  it("retains the browser binding when its short token expires and checks that token separately", async () => {
    const value = await directory(), now = Date.now();
    await saveDirectSession(value, { ...session(), cookies: [...session().cookies,
      { ...cookie("is_dbsc", "true"), expires: (now - 1_000) / 1000 },
      { ...cookie("x_tt_token", "expired-token"), expires: (now - 1_000) / 1000 }] });
    const expired = await loadDirectSession(value, "123");
    expect(expired.browserBoundSession).toBe(true);
    expect(needsDirectSessionRefresh(expired, now)).toBe(true);
    expect(needsDirectSessionRefresh({ ...expired, cookies: [...expired.cookies,
      { ...cookie("x_tt_token", "current-token"), expires: (now + 600_000) / 1000 }] }, now)).toBe(false);
    expect(needsDirectSessionRefresh(session(), now)).toBe(false);
  });
  it("uses the latest exported msToken for reads even without a msToken Cookie", async () => {
    const {api,fetch}=directApiFixture(()=>({payload:{status_code:0,user_uid:"123"}}));
    await api.request("/aweme/v1/web/query/user/");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("msToken")).toBe(api.session.security.msToken);
    await api.close();
  });
  it("exports only the actual browser identity headers and sends Fetch metadata on same-origin calls",async()=>{
    const candidate={...session(),requestHeaders:{"sec-ch-ua":"\"Chromium\";v=\"151\"","accept-language":"zh-CN",Cookie:"unsafe",Authorization:"unsafe","sec-ch-ua-platform":"bad\r\nheader"}};
    const factory={newContext:vi.fn(async options=>({fetch:vi.fn(async(_url,request)=>{
      expect(request.headers["sec-ch-ua"]).toBe(candidate.requestHeaders["sec-ch-ua"]);
      expect(request.headers["accept-language"]).toBe("zh-CN");
      expect(request.headers["sec-fetch-site"]).toBe("same-origin");
      expect(request.headers["sec-fetch-mode"]).toBe("cors");
      expect(request.headers.Cookie).toBeUndefined();expect(request.headers.Authorization).toBeUndefined();
      expect(request.headers["sec-ch-ua-platform"]).toBeUndefined();
      return {status:()=>200,headers:()=>({}),body:async()=>Buffer.from('{}'),dispose:async()=>{}};
    }),storageState:async()=>options.storageState,dispose:async()=>{}}))};
    const api=new DirectApiClient(candidate,{requestFactory:factory});
    await api.raw("https://www.douyin.com/aweme/v1/web/query/user/");await api.close();
  });
  it("checks the server's uid before reading account data", async () => {
    const { api, context } = client(() => ({ user_uid: "456", status_code: 0 }));
    await expect(api.verifyIdentity("123")).rejects.toMatchObject({ code: "account_mismatch" });
    expect(context.fetch).toHaveBeenCalledTimes(1);
    await api.close();
  });
  it("sends a browser root Referer so authenticated self profiles retain their user",async()=>{
    const {api}=client((url,request)=>({payload:url.pathname.includes("/query/user/")
      ? {status_code:0,user_uid:"123",user_uid_type:0}
      : {status_code:0,user:request.headers.Referer==="https://www.douyin.com/"?{uid:"123"}:null}}));
    await expect(api.verifyIdentity("123")).resolves.toEqual({uid:"123"});await api.close();
  });
  it("refreshes the HTTP Cookie jar without aborting an in-flight read or restoring its old Cookies",async()=>{
    const contexts=[];let release;
    const requestFactory={newContext:vi.fn(async options=>{
      const first=contexts.length===0;
      const context={fetch:vi.fn(async()=>{
        if(first)await new Promise(resolve=>{release=resolve;});
        return {status:()=>200,headers:()=>({}),body:async()=>Buffer.from('{"status_code":0}'),dispose:vi.fn(async()=>{})};
      }),storageState:async()=>options.storageState,dispose:vi.fn(async()=>{})};
      contexts.push(context);return context;
    })};
    const api=new DirectApiClient(session(),{requestFactory});
    const pending=api.raw("https://www.douyin.com/aweme/v1/web/query/user/");
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    api.replaceSession({...session(),cookies:[...session().cookies,cookie("x_tt_token","new-token")]});
    expect(contexts[0].dispose).not.toHaveBeenCalled();
    await api.raw("https://www.douyin.com/aweme/v1/web/query/user/");
    expect(contexts).toHaveLength(2);release();await pending;
    expect(contexts[0].dispose).toHaveBeenCalledTimes(1);
    expect(api.cookie("x_tt_token")).toBe("new-token");
    await api.close();expect(contexts[1].dispose).toHaveBeenCalledTimes(1);
  });
  it("recognizes the anonymous id returned after expiry without flagging an account switch",async()=>{
    const {api,context}=client(url=>({payload:url.pathname.includes("/query/user/")
      ? {status_code:0,user_uid:"7000000000000000",user_uid_type:0} : {status_code:0,user:null}}));
    await expect(api.verifyIdentity("123")).rejects.toMatchObject({code:"login_required"});
    expect(context.fetch).toHaveBeenCalledTimes(2);await api.close();
  });
  it("still refuses a different logged-in account and incomplete self profiles",async()=>{
    let profile={status_code:0,user:{uid:"456"}};
    const {api}=client(url=>({payload:url.pathname.includes("/query/user/")
      ? {status_code:0,user_uid:"456",user_uid_type:0} : profile}));
    await expect(api.verifyIdentity("123")).rejects.toMatchObject({code:"account_mismatch"});
    profile={status_code:0};await expect(api.verifyIdentity("123")).rejects.toMatchObject({code:"schema_changed"});
    await api.close();
  });
  it("rejects a signer returning another host before opening an HTTP client", async () => {
    const { api, requestFactory } = client(() => ({}), { signer: async () => `https://example.com/aweme/v1/web/aweme/detail/?a_bogus=${"A".repeat(80)}` });
    await expect(api.request("/aweme/v1/web/aweme/detail/", { query: { aweme_id: "12345" } })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });
  it("signs the supported 500-character Chinese comment while rejecting oversized bodies",async()=>{
    const url=new URL('https://www-hj.douyin.com/aweme/v1/web/comment/publish?aid=6383');
    const body=new URLSearchParams({aweme_id:'7654321098765432100',text:'字'.repeat(500),text_extra:'[]'}).toString();
    expect(body.length).toBeGreaterThan(4096);
    expect(new URL(await signDirectApiUrl(url,{userAgent,method:'POST',body})).searchParams.get('a_bogus')).toMatch(/^[A-Za-z0-9+/_=-]{64,512}$/u);
    await expect(signDirectApiUrl(url,{userAgent,method:'POST',body:'x'.repeat(8193)})).rejects.toMatchObject({code:'invalid_request'});
  });
  it("uses a cached, verified session without invoking Chromium", async () => {
    const dataDirectory = await directory(); await saveDirectSession(dataDirectory, session());
    const { api } = client(() => ({ user_uid: "123", status_code: 0 }));
    const collector = new DouyinCollector({ dataDirectory, executablePath: "unused", store: {}, account: { id: "default", uid: "123" } });
    collector.directApi = api; collector.ensureBrowser = vi.fn(() => { throw new Error("browser must not launch"); });
    expect(await collector.ensureDirectApi()).toBe(api);
    expect(collector.ensureBrowser).not.toHaveBeenCalled();
    await collector.close();
  });
  it.each(["security", "expired_binding"])("initializes %s credentials before checking the HTTP identity", async reason => {
    const value=await directory(), candidate=session();
    if(reason==="expired_binding")candidate.browserBoundSession=true;
    await saveDirectSession(value,candidate);
    const {api}=client(()=>({status_code:0,user_uid:"123"}));
    const collector=new DouyinCollector({dataDirectory:value,store:{},account:{id:"default",uid:"123"}});
    collector.directApi=api;let ready=false;
    collector.ensureDirectWriteCredentials=vi.fn(async()=>{ready=true;});
    api.verifyIdentity=vi.fn(async()=>{expect(ready).toBe(true);return {uid:"123"};});
    expect(await collector.ensureDirectApi({security:reason==="security"})).toBe(api);
    expect(collector.ensureDirectWriteCredentials).toHaveBeenCalledTimes(1);
    expect(api.verifyIdentity).toHaveBeenCalledTimes(1);await collector.close();
  });
  it("keeps in-flight HTTP work on a chat refresh, but replaces it after a new login", async () => {
    const dataDirectory = await directory(); const { api } = client(() => ({}));
    const close = vi.spyOn(api, "close");
    const collector = new DouyinCollector({ dataDirectory, store: {} }); collector.directApi = api;
    const page = { evaluate: async () => userAgent };
    await collector.cacheDirectSession({ cookies: async () => [...session().cookies, cookie("msToken", "refreshed")] }, page, { uid: "123" });
    expect(collector.directApi).toBe(api); expect(close).not.toHaveBeenCalled();
    await collector.cacheDirectSession({ cookies: async () => session().cookies.map(c => c.name === "sessionid" ? { ...c, value: "new-login" } : c) }, page, { uid: "123" });
    expect(collector.directApi).toBeNull(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("exports a same-account login rotation without discarding its active HTTP client", async () => {
    const dataDirectory = await directory(), { api } = directApiFixture(() => ({}));
    await saveDirectSession(dataDirectory, api.session);
    const collector = new DouyinCollector({ dataDirectory, store: {} }); collector.directApi = api;
    const close = vi.spyOn(api, "close");
    const cookies = api.session.cookies.map(cookie => cookie.name === "sessionid" ? { ...cookie, value: "new-login" } : cookie);
    const exported = await collector.cacheDirectSession({ cookies: async () => cookies }, { evaluate: async () => api.currentUserAgent }, { uid: "123" }, { updateApi: false });
    expect(exported.cookies.find(cookie => cookie.name === "sessionid").value).toBe("new-login");
    expect(exported.security).toBeUndefined();
    expect(collector.directApi).toBe(api); expect(close).not.toHaveBeenCalled();
    expect(api.cookie("sessionid")).toBe("fake-session");
    await collector.close();
  });
  it("completes paired credential bootstrap after the same account logs in again", async () => {
    let security;
    const { api } = directApiFixture(url => url.pathname.includes('get_client_cert')
      ? { payload: { data: { server_cert: security.serverCert, 'x-tt-session-dtrait-pk1': Buffer.from(security.dtrait.publicKey).toString('base64'), 'x-tt-session-dtrait-pk1-version': '1' } } }
      : { headers: { 'x-ware-csrf-token': '1,current-csrf' } });
    security = api.session.security;
    delete api.session.security;
    const dataDirectory = await directory(); api.dataDirectory = dataDirectory;
    await saveDirectSession(dataDirectory, api.session); await writeTemplate(dataDirectory);
    const collector = new DouyinCollector({ dataDirectory, store: {}, account: { id: 'default', uid: '123' } });
    collector.directApi = api;
    const cookies = api.session.cookies.map(cookie => cookie.name === 'sessionid' ? { ...cookie, value: 'new-login' } : cookie);
    const page = { goto: vi.fn(async () => {}), close: vi.fn(async () => {}), evaluate: vi.fn(async fn => fn.name === 'readDirectCredentialMaterial'
      ? { ...security, trait: { blob: security.dtrait.blob, sdkVersion: security.dtrait.sdkVersion } }
      : { uid: '123', secUid: api.secUid }) };
    collector.context = { newPage: async () => page, cookies: async () => cookies, directMsToken: security.msToken };
    await expect(collector.ensureDirectWriteCredentials(api)).resolves.toMatchObject({ sdkPairVerified: true, csrfToken: 'current-csrf' });
    expect(collector.directApi).toBe(api); expect(api.cookie('sessionid')).toBe('new-login');
    expect((await loadDirectSession(dataDirectory, '123')).security.sdkPairVerified).toBe(true);
    expect(page.close).toHaveBeenCalledOnce();
    collector.context = null; await collector.close();
  });
  it("routes initialized full reads through HTTP and opens login recovery after expiry", async () => {
    const dataDirectory = await initializedDirectory();
    const collector = new DouyinCollector({ dataDirectory, store: {}, account: { id: "default", uid: "123" } });
    collector.syncRunId = 1; collector.ensureDirectApi = vi.fn(async () => ({}));
    collector.runDirectRecords = vi.fn(async () => undefined);
    collector.ensureBrowser = vi.fn(async () => { throw new Error("login-recovery"); });
    await collector.runSync(1);
    expect(collector.runDirectRecords).toHaveBeenCalledWith(1, { full: true }); expect(collector.ensureBrowser).not.toHaveBeenCalled();
    collector.ensureDirectApi.mockRejectedValue(new DirectHistoryError("login_required", "expired"));
    await expect(collector.runSync(1)).rejects.toThrow("login-recovery"); expect(collector.ensureBrowser).toHaveBeenCalledTimes(1);
  });
  it("moves the first full read to HTTP immediately after login and template capture", async () => {
    const dataDirectory = await directory(), page = {};
    const collector = new DouyinCollector({ dataDirectory, store: {} }); collector.syncRunId = 1;
    collector.ensureBrowser = vi.fn(async () => ({})); collector.currentPage = vi.fn(async () => page);
    collector.visit = vi.fn(async () => {}); collector.waitForLogin = vi.fn(async () => {});
    collector.assertAccountMatches = vi.fn(async () => { await saveDirectSession(dataDirectory, session()); });
    collector.prepareDirectHistoryTemplate = vi.fn(async () => { await writeTemplate(dataDirectory); });
    collector.runDirectRecords = vi.fn(async () => {}); collector.collectPhase = vi.fn(() => { throw new Error("page scrolling must not run"); });
    await collector.runSync(1);
    expect(collector.prepareDirectHistoryTemplate).toHaveBeenCalledWith(expect.anything(), page, 1);
    expect(collector.runDirectRecords).toHaveBeenCalledWith(1, { full: true }); expect(collector.collectPhase).not.toHaveBeenCalled();
  });
  it("signs replies without UIFID/fingerprint fields, appending fingerprints after the signature", async () => {
    const signer = vi.fn(async (url) => { expect([...url.searchParams.keys()]).not.toContain("uifid"); expect(url.searchParams.has("fp")).toBe(false);
      return `${url}&a_bogus=${"A".repeat(80)}`; });
    const { api, context } = client(() => ({ status_code: 0, comments: [], has_more: 0 }), { signer });
    await api.request("/aweme/v1/web/comment/list/reply/", { query: { item_id: "12345", comment_id: "67890", count: "3" } });
    const url = new URL(context.fetch.mock.calls[0][0]); const names = [...url.searchParams.keys()];
    expect(names.indexOf("fp")).toBeGreaterThan(names.indexOf("a_bogus")); expect(url.searchParams.get("verifyFp")).toBe("verify-id");
    expect(url.searchParams.has("x-secsdk-web-signature")).toBe(false); await api.close();
  });
});

describe("direct list pagination", () => {
  it.each(["liked_videos", "favorite_videos"])("pages %s with the right verb, cursor and signed request body", async (type) => {
    const cursors = [], bodies = [];
    const signer = vi.fn(async (url, options) => { bodies.push(options.body); return `${url}&a_bogus=${"A".repeat(80)}`; });
    const { api, context } = client((url, request) => {
      const cursor = type === "liked_videos" ? url.searchParams.get("max_cursor") : new URLSearchParams(request.data).get("cursor");
      cursors.push(cursor);
      expect(url.searchParams.get("x-secsdk-web-signature")).toMatch(/^[0-9a-f]{32}$/u);
      expect(request.method).toBe(type === "liked_videos" ? "GET" : "POST");
      return { status_code: 0, aweme_list: [{ aweme_id: cursor === "0" ? "12345" : "67890" }], has_more: cursor === "0" ? 1 : 0, max_cursor: "10", cursor: "10" };
    }, { signer });
    const pages = [];
    expect(await api.collectRecordPages(type, (payload) => pages.push(payload))).toBe(2);
    expect(cursors).toEqual(["0", "10"]);
    expect(pages.flatMap((payload) => payload.aweme_list.map((item) => item.aweme_id))).toEqual(["12345", "67890"]);
    expect(bodies).toEqual(type === "liked_videos" ? ["", ""] : context.fetch.mock.calls.map(([, options]) => options.data));
    await api.close();
  });
  it("stops at the first known page and does not send a second request", async () => {
    const { api, context } = client(() => ({ status_code: 0, aweme_list: [], has_more: 1, max_cursor: "10" }));
    expect(await api.collectRecordPages("liked_videos", () => false)).toBe(1);
    expect(context.fetch).toHaveBeenCalledTimes(1); await api.close();
  });
  it("rejects a repeated cursor instead of looping", async () => {
    const { api, context } = client(() => ({ status_code: 0, aweme_list: [], has_more: 1, max_cursor: "0" }));
    await expect(api.collectRecordPages("liked_videos", () => true)).rejects.toMatchObject({ code: "pagination_stalled" });
    expect(context.fetch).toHaveBeenCalledTimes(1); await api.close();
  });
  it.each([403,429])("stops on HTTP %s without retrying or invoking the page callback", async (status) => {
    const { api, context } = client(() => ({ status, payload: {} })); const onPage = vi.fn();
    await expect(api.collectRecordPages("liked_videos", onPage)).rejects.toMatchObject({ code: status === 403 ? "session_rejected" : "rate_limited" });
    expect(context.fetch).toHaveBeenCalledTimes(1); expect(onPage).not.toHaveBeenCalled(); await api.close();
  });
  it("cancels only its isolated request and leaves the saved session untouched", async () => {
    const dataDirectory = await directory(); await saveDirectSession(dataDirectory, session());
    const before = await readFile(path.join(dataDirectory,"direct-session.json"));
    let reject; const { api, context } = client(() => new Promise((_,fail) => { reject = fail; }), { dataDirectory });
    context.dispose.mockImplementation(async () => { reject?.(new Error("request disposed")); });
    const controller = new AbortController(); const work = api.request("/aweme/v1/web/comment/list/", { query: { aweme_id: "12345" }, signal: controller.signal });
    const rejected = expect(work).rejects.toThrow("request disposed");
    await vi.waitFor(() => expect(context.fetch).toHaveBeenCalledTimes(1)); controller.abort(); await rejected;
    expect(await readFile(path.join(dataDirectory,"direct-session.json"))).toEqual(before);
    expect(context.dispose).toHaveBeenCalled(); await api.close();
  });
  it.each([false, true])("preserves history and uses full=%s to control stopping at known pages", async (full) => {
    const dataDirectory = await directory(), store = new CollectorStore(dataDirectory);
    const types = ["watch_history", "liked_videos", "favorite_videos"];
    const records = Object.fromEntries(types.map(type => [type, [{ id: `${type}:old`, videoId: "old", title: "旧记录", author: null, occurredAt: null, occurredAtSource: "unknown", url: null }]]));
    const snapshot = await store.save(records, [], { directSync: Object.fromEntries(types.map(type => [type, true])) });
    const { api, context } = client((url, request) => {
      if (url.pathname === "/webcast/feed/") {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ request_tag_from: "web", need_map: "1", source_key: "drawer_hot_live_history", live_id: "1", app_name: "douyin_web" });
        return { status_code: 0, data: [], extra: { has_more: false } };
      }
      const cursor = url.pathname.endsWith("/favorite/") ? url.searchParams.get("max_cursor") : new URLSearchParams(request.data).get("cursor");
      return { status_code: 0, aweme_list: [{ aweme_id: cursor === "0" ? "old" : "new" }], has_more: cursor === "0" ? 1 : 0, max_cursor: "10", cursor: "10" };
    });
    const collector = new DouyinCollector({ dataDirectory, store }); collector.snapshot = snapshot; collector.syncRunId = 1;
    collector.ensureDirectApi = vi.fn(async () => api); collector.ensureBrowser = vi.fn(() => { throw new Error("browser must not launch"); });
    collector.readDirectHistory = vi.fn(async (_api, cursor) => ({ status_code: 0, aweme_list: [{ aweme_id: cursor === "0" ? "old" : "new" }], has_more: cursor === "0" ? 1 : 0, max_cursor: "10" }));
    collector.readCompletedWatchTimes = vi.fn(async () => null);
    await collector.runDirectRecords(1, { full });
    for (const type of types) expect(collector.snapshot.records[type].map(r => r.videoId).sort()).toEqual(full ? ["new", "old"] : ["old"]);
    expect(collector.readDirectHistory).toHaveBeenCalledTimes(full ? 2 : 1);
    expect(context.fetch).toHaveBeenCalledTimes(full ? 5 : 3); expect(collector.ensureBrowser).not.toHaveBeenCalled();
    await api.close();
  });
});
