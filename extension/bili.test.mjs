import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { sanitizeFeedFilter } from "../collector/feedFilter.mjs";

const filterScript = readFileSync(new URL("./filter.js", import.meta.url), "utf8");
const picksScript = readFileSync(new URL("./picks.js", import.meta.url), "utf8");
const biliScript = readFileSync(new URL("./bili.js", import.meta.url), "utf8");
const feedUrl = "//api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?ps=12";
const feed = () => ({ code: 0, data: { item: [
  { id: 115000000000001, bvid: "BV1aaaaaaaaa", goto: "av", title: "王者荣耀上分", owner: { mid: 1, name: "甲" }, track_id: "t1" },
  { id: 115000000000002, bvid: "BV1bbbbbbbbb", goto: "av", title: "日常记录", owner: { mid: 2, name: "乙" } },
  { id: 0, bvid: "", goto: "ad", title: "限时优惠", business_info: { id: 9 } },
] } });

function setup({ mode = "hide", pinia, picks = {}, fetchImpl = async () => new Response(JSON.stringify({ code: 0 })) } = {}) {
  class XHR {
    responseType = "";
    readyState = 0;
    open(method, url) { this.url = url; }
    respond(value) { this.text = JSON.stringify(value); this.readyState = 4; }
    get responseText() { return this.text ?? ""; }
    get response() { return this.text; }
  }
  const document = new EventTarget();
  const head = { append: vi.fn() };
  Object.assign(document, { head, documentElement: head, cookie: "bili_jct=csrf123", createElement: () => ({ textContent: "", isConnected: false }), querySelector: () => null });
  const events = [];
  document.addEventListener("dyf:events", (event) => events.push(...JSON.parse(event.detail)));
  const nativeFetch = vi.fn(fetchImpl);
  const context = { XMLHttpRequest: XHR, document, CustomEvent, URL, URLSearchParams, Request, Response, Headers, fetch: nativeFetch,
    location: new URL("https://www.bilibili.com/"), setTimeout: (fn) => fn(), __pinia: pinia, Event, dispatchEvent: vi.fn() };
  context.window = context;
  vm.runInNewContext(filterScript, context);
  vm.runInNewContext(picksScript, context);
  vm.runInNewContext(biliScript, context);
  document.dispatchEvent(new CustomEvent("dyf:settings", { detail: JSON.stringify({ mode, rules: "王者荣耀", ...picks }) }));
  return { context, document, events, nativeFetch, head, XHR };
}

describe("B 站首页推荐过滤", () => {
  it("隐藏：拿掉命中和广告，记 B 站来源；只记录：原样放过", () => {
    for (const mode of ["hide", "observe"]) {
      const { XHR, events, context } = setup({ mode });
      const xhr = new XHR();
      xhr.open("GET", feedUrl);
      xhr.respond(feed());
      const titles = JSON.parse(xhr.responseText).data.item.map((item) => item.title);
      expect(titles).toEqual(mode === "hide" ? ["日常记录"] : ["王者荣耀上分", "日常记录", "限时优惠"]);
      // 广告的 id 是 0，照样拿掉但不进记录
      expect(events).toEqual([expect.objectContaining({ site: "bilibili", id: "115000000000001", bvid: "BV1aaaaaaaaa", matched: ["王者荣耀"],
        action: mode === "hide" ? "hidden" : "observed" })]);
      expect(sanitizeFeedFilter({ events }).events[0].site).toBe("bilibili");
      // 拿掉了条目就补一次滚动，让 B 站接着加载
      expect(context.dispatchEvent).toHaveBeenCalledTimes(mode === "hide" ? 1 : 0);
    }
  });

  it("不感兴趣：带 csrf 发表单，首屏卡片按视频号藏掉", async () => {
    const pinia = { home: { data: { recommend: { item: [feed().data.item[0], feed().data.item[1]] } } } };
    const { document, events, nativeFetch, head } = setup({ mode: "dislike", pinia });
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(events.map((event) => event.action)).toEqual(["disliked"]));
    const [url, init] = nativeFetch.mock.calls[0];
    expect(url).toBe("https://api.bilibili.com/x/web-interface/feedback/dislike");
    expect(Object.fromEntries(init.body)).toMatchObject({ id: "115000000000001", goto: "av", mid: "1", reason_id: "1", csrf: "csrf123", track_id: "t1" });
    const style = head.append.mock.calls[0][0];
    expect(style.textContent).toContain('a[href*="/video/BV1aaaaaaaaa"]');
    expect(style.textContent).not.toContain("BV1bbbbbbbbb");
  });

  it("想看的词条：搜到的视频补上 cid、转成推荐格式按频率插进去，命中屏蔽词的不插", async () => {
    const result = (aid, bvid, title) => ({ type: "video", aid: String(aid), bvid, title, author: "丙", mid: "3", pic: "//i0.hdslb.com/a.jpg", duration: "1:02:03", play: "12", like: "3", pubdate: "1700000000" });
    const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes("/search/type")
      ? { code: 0, data: { page: 1, numPages: 5, result: [result(116000000000001, "BV1ccccccccc", "<em class=\"keyword\">猫</em>&amp;狗"), result(116000000000002, "BV1ddddddddd", "王者荣耀猫")] } }
      : { code: 0, data: [{ cid: 777 }] }));
    const { XHR, events, nativeFetch } = setup({ picks: { webPicks: true, words: "猫", pickEvery: 1 }, fetchImpl });
    await vi.waitFor(() => expect(nativeFetch.mock.calls.some(([url]) => String(url).includes("/pagelist"))).toBe(true));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(String(nativeFetch.mock.calls[0][0])).toContain("keyword=%E7%8C%AB&page=1");
    const xhr = new XHR();
    xhr.open("GET", feedUrl);
    xhr.respond(feed());
    const items = JSON.parse(xhr.responseText).data.item;
    // 命中「王者荣耀」的推荐和广告拿掉，「日常记录」后面插一条；命中屏蔽词的候选不插
    expect(items.map((item) => item.title)).toEqual(["日常记录", "猫&狗"]);
    expect(items[1]).toMatchObject({ id: 116000000000001, bvid: "BV1ccccccccc", cid: 777, goto: "av", duration: 3723, pic: "https://i0.hdslb.com/a.jpg", owner: { name: "丙", mid: 3 } });
    expect(events.find((event) => event.action === "inserted")).toMatchObject({ site: "bilibili", id: "116000000000001", bvid: "BV1ccccccccc", matched: ["猫"], desc: "猫&狗" });
  });

  it("首屏已经有的视频，词条搜到了也不再插，免得一页出现两次", async () => {
    const result = (aid, bvid, title) => ({ type: "video", aid: String(aid), bvid, title, author: "丙", mid: "3", pic: "", duration: "1:00", play: "1", like: "1", pubdate: "1" });
    const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes("/search/type")
      ? { code: 0, data: { page: 1, numPages: 5, result: [result(116000000000001, "BV1ccccccccc", "首屏那条猫"), result(116000000000003, "BV1eeeeeeeee", "另一条猫")] } }
      : { code: 0, data: [{ cid: 777 }] }));
    const pinia = { home: { head: { recommend: [{ aid: 116000000000001, bvid: "BV1ccccccccc", title: "首屏那条猫", author: { name: "丙", mid: 3 } }] } } };
    const { XHR, document, nativeFetch } = setup({ mode: "observe", pinia, picks: { webPicks: true, words: "猫", pickEvery: 1 }, fetchImpl });
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(nativeFetch.mock.calls.filter(([url]) => String(url).includes("/pagelist")).length).toBe(1));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const xhr = new XHR();
    xhr.open("GET", feedUrl);
    xhr.respond(feed());
    expect(JSON.parse(xhr.responseText).data.item.map((item) => item.title)).not.toContain("首屏那条猫");
    expect(JSON.parse(xhr.responseText).data.item.map((item) => item.title)).toContain("另一条猫");
  });
});
