import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const filterScript = readFileSync(new URL("./filter.js", import.meta.url), "utf8");
const pageScript = readFileSync(new URL("./page.js", import.meta.url), "utf8");
const feedUrl = "https://www.douyin.com/aweme/v1/web/tab/feed/?aid=6383";
const feed = () => ({ status_code: 0, aweme_list: [
  { aweme_id: "7000000000000000001", desc: "王者荣耀", author: { nickname: "甲" } },
  { aweme_id: "7000000000000000002", desc: "日常记录", author: { nickname: "乙" } },
] });

function setup({ mode = "hide", rules = "王者荣耀", initialSettings = true, bootstrap, renderData, fetch: fetchImpl = async () => new Response(JSON.stringify(feed()), {
  headers: { "content-type": "application/json" },
}) } = {}) {
  class XHR {
    responseType = "";
    readyState = 0;
    headers = {};
    open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader() { return this.contentType ?? "application/json"; }
    respond(value, type = "") {
      this.responseType = type;
      this.text = JSON.stringify(value);
      this.value = type === "json" ? value : type === "arraybuffer" ? new TextEncoder().encode(this.text).buffer : this.text;
      this.readyState = 4;
    }
    get responseText() {
      if (this.responseType && this.responseType !== "text") throw new DOMException("Invalid response type", "InvalidStateError");
      return this.text ?? "";
    }
    get response() { return this.value; }
  }
  const document = new EventTarget();
  document.getElementById = id => id === "RENDER_DATA" && renderData ? { textContent: renderData } : null;
  const events = [];
  document.addEventListener("dyf:events", event => events.push(...JSON.parse(event.detail)));
  const nativeFetch = vi.fn(fetchImpl);
  const context = { XMLHttpRequest: XHR, document, CustomEvent, URL, URLSearchParams, TextDecoder, TextEncoder,
    Request, Response, Headers, fetch: nativeFetch, location: new URL("https://www.douyin.com/"), setTimeout };
  context.window = context;
  if (bootstrap) context._ROUTER_DATA = bootstrap;
  vm.runInNewContext(filterScript, context);
  vm.runInNewContext(pageScript, context);
  const settings = change => document.dispatchEvent(new CustomEvent("dyf:settings", { detail: JSON.stringify({ mode, rules, ...change }) }));
  if (initialSettings) settings();
  return { context, document, events, nativeFetch, settings, XHR };
}

describe("推荐流请求拦截", () => {
  it.each(["", "text", "json", "arraybuffer"])("XHR %s 回包在页面读取前过滤，连续读取只记一次", type => {
    const { XHR, events } = setup();
    const xhr = new XHR();
    xhr.open("GET", feedUrl);
    xhr.respond(feed(), type);
    const read = () => type === "json" ? xhr.response : JSON.parse(type === "arraybuffer" ? new TextDecoder().decode(xhr.response) : xhr.responseText);
    expect(read().aweme_list.map(item => item.aweme_id)).toEqual(["7000000000000000002"]);
    expect(read().aweme_list).toHaveLength(1);
    expect(events).toMatchObject([{ id: "7000000000000000001", action: "hidden", matched: ["王者荣耀"] }]);
  });

  it.each(["json", "text", "arrayBuffer"])("fetch 回包通过 %s 读取或 clone 后读取都已过滤", async method => {
    const { context, events } = setup();
    const response = await context.fetch(feedUrl);
    const cloned = await response.clone().json();
    const value = await response[method]();
    const json = method === "json" ? value : JSON.parse(method === "arrayBuffer" ? new TextDecoder().decode(value) : value);
    expect(json.aweme_list.map(item => item.aweme_id)).toEqual(["7000000000000000002"]);
    expect(cloned).toEqual(json);
    expect(events).toMatchObject([{ id: "7000000000000000001", action: "hidden" }]);
  });

  it("fetch 的 Request 输入、精选接口和没有末尾斜杠的地址也识别", async () => {
    const { context, events } = setup();
    const response = await context.fetch(new Request("https://www.douyin.com/aweme/v1/web/module/feed?aid=6383"));
    expect((await response.json()).aweme_list).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("fetch 只记录时保留回包，关闭时不记录，也不处理关注或其他站点", async () => {
    const response = new Response(JSON.stringify(feed()));
    const { context, events, settings, nativeFetch } = setup({ mode: "observe", fetch: async () => response });
    expect(await context.fetch(feedUrl)).toBe(response);
    expect(events).toMatchObject([{ action: "observed" }]);
    settings({ mode: "off" });
    expect(await context.fetch(feedUrl)).toBe(response);
    settings({ mode: "hide" });
    expect(await context.fetch("/aweme/v1/web/follow/feed/")).toBe(response);
    expect(await context.fetch("https://example.com/aweme/v1/web/tab/feed/")).toBe(response);
    expect(events).toHaveLength(1);
    expect(nativeFetch).toHaveBeenCalledTimes(4);
    expect(response.bodyUsed).toBe(false);
  });

  it("XHR 和 fetch 的 protobuf 请求头都改为 JSON，保留其他请求选项", async () => {
    const { XHR, context, nativeFetch } = setup();
    const xhr = new XHR();
    xhr.open("GET", feedUrl);
    xhr.setRequestHeader("Accept", "application/protobuf");
    expect(xhr.headers.Accept).toContain("application/json");
    const signal = new AbortController().signal;
    await context.fetch(new Request(feedUrl, { headers: { Accept: "application/x-protobuf", "X-Request": "keep" } }), { credentials: "include", signal });
    const [, options] = nativeFetch.mock.calls[0];
    expect(new Headers(options.headers).get("Accept")).toContain("application/json");
    expect(new Headers(options.headers).get("X-Request")).toBe("keep");
    expect(options.credentials).toBe("include");
    expect(options.signal).toBe(signal);
  });

  it("重写 fetch 后保留响应元信息，清掉已失效的长度和编码", async () => {
    const original = new Response(JSON.stringify(feed()), { status: 200, statusText: "OK", headers: {
      "content-type": "application/json", "content-length": "99999", "content-encoding": "gzip", "x-feed": "keep",
    } });
    Object.defineProperties(original, { url: { value: feedUrl }, redirected: { value: true }, type: { value: "basic" } });
    const { context } = setup({ fetch: async () => original });
    const response = await context.fetch(feedUrl);
    for (const value of [response, response.clone()]) {
      expect(value.url).toBe(feedUrl);
      expect(value.redirected).toBe(true);
      expect(value.type).toBe("basic");
      expect(value.statusText).toBe("OK");
      expect(value.headers.get("x-feed")).toBe("keep");
      expect(value.headers.has("content-length")).toBe(false);
      expect(value.headers.has("content-encoding")).toBe(false);
    }
  });

  it("fetch 读不了时保留原响应，只留一条诊断；空回包不算失败", async () => {
    const { context, events } = setup({ fetch: async () => new Response("binary", { headers: { "content-type": "application/protobuf" } }) });
    expect(await (await context.fetch(feedUrl)).text()).toBe("binary");
    expect(await (await context.fetch(feedUrl)).text()).toBe("binary");
    expect(events).toMatchObject([{ action: "unreadable" }]);
    const empty = setup({ fetch: async () => new Response("") });
    expect(await (await empty.context.fetch(feedUrl)).text()).toBe("");
    expect(empty.events).toEqual([]);
  });

  it("重复视频仍被过滤，处置记录去重", async () => {
    const { context, events } = setup();
    expect((await (await context.fetch(feedUrl)).json()).aweme_list).toHaveLength(1);
    expect((await (await context.fetch(feedUrl)).json()).aweme_list).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("推荐页的视频详情回包也记录命中，不改详情回包或冒充已隐藏", async () => {
    const detail = { aweme_id: "7000000000000000003", desc: "游戏更新解析 #王者荣耀 #游戏" };
    const original = new Response(JSON.stringify({ aweme_detail: detail, status_code: 0 }));
    const { context, events } = setup({ fetch: async () => original });
    expect(await context.fetch("/aweme/v1/web/aweme/detail/?aweme_id=7000000000000000003")).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(events).toMatchObject([{ id: detail.aweme_id, action: "observed", matched: ["王者荣耀"] }]);
  });

  it("其他页面的详情不处理", async () => {
    const { context, events } = setup({ fetch: async () => new Response(JSON.stringify({ aweme_detail: feed().aweme_list[0] })) });
    context.location = new URL("https://www.douyin.com/follow");
    await context.fetch("/aweme/v1/web/aweme/detail/?aweme_id=7000000000000000001");
    expect(events).toEqual([]);
  });

  it.each(["fetch", "XHR"])("%s 回包先到、词条后到时补记命中", async transport => {
    const { context, events, settings, XHR } = setup({ initialSettings: false });
    if (transport === "fetch") {
      expect((await (await context.fetch(feedUrl)).json()).aweme_list).toHaveLength(2);
    } else {
      const xhr = new XHR();
      xhr.open("GET", feedUrl);
      xhr.respond(feed());
      expect(JSON.parse(xhr.responseText).aweme_list).toHaveLength(2);
    }
    expect(events).toEqual([]);
    settings();
    expect(events).toMatchObject([{ id: "7000000000000000001", action: "observed" }]);
  });

  it("首屏路由数据与 URL 编码的 RENDER_DATA 在词条到达后补记，循环引用不会卡住", () => {
    const bootstrap = { loaderData: { main: feed() } };
    bootstrap.self = bootstrap;
    const { events, context, document } = setup({ bootstrap, renderData: encodeURIComponent(JSON.stringify({ app: { aweme_detail: feed().aweme_list[0] } })) });
    expect(events).toMatchObject([{ id: "7000000000000000001", action: "observed" }]);
    expect(context._ROUTER_DATA.loaderData.main.aweme_list).toHaveLength(2);
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(events).toHaveLength(1);
  });

  it("词条先到、首屏数据后到时在 DOMContentLoaded 补记，其他页面不读首屏", () => {
    const { context, document, events, settings } = setup();
    context._ROUTER_DATA = { loaderData: { main: feed() } };
    context.location = new URL("https://www.douyin.com/follow");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(events).toEqual([]);
    context.location = new URL("https://www.douyin.com/");
    settings();
    expect(events).toHaveLength(1);
  });

  it("本机诊断能区分实际请求、识别、读取、匹配和上报，并去掉查询参数", async () => {
    const { context, document, XHR } = setup();
    let status;
    document.addEventListener("dyf:diagnostics", event => { status = JSON.parse(event.detail); });
    await context.fetch(feedUrl + "&msToken=secret");
    const xhr = new XHR();
    xhr.open("GET", "https://www-hj.douyin.com/aweme/v1/web/tab/feed/?msToken=secret");
    document.dispatchEvent(new CustomEvent("dyf:probe"));
    expect(status).toMatchObject({ settingsReceived: 1, mode: "hide", ruleCount: 1, fetchRequests: 1, xhrRequests: 1,
      recognizedRequests: 1, responsesRead: 1, videosRead: 2, matchedVideos: 1, eventsEmitted: 1,
      lastResponse: { videos: 2, keys: ["status_code", "aweme_list"] } });
    expect(status.requests).toMatchObject([
      { host: "www.douyin.com", path: "/aweme/v1/web/tab/feed/", recognized: true },
      { host: "www-hj.douyin.com", path: "/aweme/v1/web/tab/feed/", recognized: false },
    ]);
    expect(JSON.stringify(status)).not.toContain("secret");
  });
});
