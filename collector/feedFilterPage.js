// 应用经远程调试注入到用户浏览器的抖音页面里（页面自己的环境，网页脚本运行之前），排在 feedFilterRules.js 后面。
// 推荐数据走 XHR：在页面读到响应之前把命中的视频从 aweme_list 里拿掉，页面根本拿不到这几条，也就不会播。
// 词条随注入的代码一起来（__dyfBoot），改词条时应用发 dyf:settings 事件；处置结果攒着，等应用来取（__dyfDrain）。
(function () {
  "use strict";
  const boot = globalThis.__dyfBoot;
  delete globalThis.__dyfBoot;
  // 注入是跟着标签页走的：标签页跳到别的网站时这里什么都不做
  if (location.hostname !== "www.douyin.com" || window.__dyfInstalled) return;
  window.__dyfInstalled = true;

  const DYF = globalThis.DYF;
  // 首页推荐是 tab/feed，精选页是 module/feed；关注、朋友这些流不碰
  const FEED = /^\/aweme\/v\d\/web\/(?:tab|module)\/feed\/$/u;
  const DISLIKE_PATH = "/aweme/v1/web/commit/dislike/item/";
  const PER_MINUTE = 6;
  let settings = null;
  let warned = false;
  const seen = new Set();
  const pending = [];

  const apply = (text) => {
    try {
      const value = JSON.parse(text);
      settings = { mode: value.mode, rules: DYF.compileRules(value.rules) };
    } catch { /* 坏消息不换掉手上的词条 */ }
  };
  if (typeof boot === "string") apply(boot);
  document.addEventListener("dyf:settings", (event) => apply(event.detail));

  // 应用定时来取；最多攒 300 条，应用断开太久就丢最旧的
  const emit = (events) => { pending.push(...events); pending.splice(0, Math.max(0, pending.length - 300)); };
  Object.defineProperty(window, "__dyfDrain", { value: () => JSON.stringify(pending.splice(0, 50)) });

  function isFeed(url) {
    try { return FEED.test(new URL(String(url), location.href).pathname); } catch { return false; }
  }

  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const setRequestHeader = proto.setRequestHeader;
  const textGetter = Object.getOwnPropertyDescriptor(proto, "responseText").get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, "response").get;

  proto.open = function (method, url) {
    this.__dyfFeed = isFeed(url);
    if (this.__dyfFeed) {
      try {
        const query = new URL(String(url), location.href).searchParams;
        if (query.get("aid")) common = new URLSearchParams([...query].filter(([name]) => COMMON.has(name)));
      } catch { /* 留着上一份 */ }
    }
    this.__dyfDone = false;
    this.__dyfText = undefined;
    this.__dyfOut = undefined;
    return open.apply(this, arguments);
  };

  // 推荐接口有时要二进制（protobuf）格式，那样读不了。把 Accept 改回 JSON，页面自己也认 JSON 回包
  proto.setRequestHeader = function (name, value) {
    if (this.__dyfFeed && settings?.mode !== "off" && /^(?:accept|content-type)$/iu.test(name) && /x-protobuf/iu.test(value))
      value = /^accept$/iu.test(name) ? "application/json, text/plain, */*" : "application/json";
    return setRequestHeader.call(this, name, value);
  };

  // 每个请求只改一次；返回改过的 JSON 文本，没改就是 undefined
  function rewrite(xhr) {
    if (xhr.__dyfDone) return xhr.__dyfText;
    xhr.__dyfDone = true;
    // ponytail: 词条还没从扩展后台到的那几百毫秒里，最早一页推荐照原样放过
    if (!settings || settings.mode === "off" || !settings.rules.length) return undefined;
    const type = xhr.responseType;
    if (type && type !== "text" && type !== "arraybuffer" && type !== "json") return undefined;
    let json;
    try {
      if (/protobuf/iu.test(xhr.getResponseHeader("content-type") || "")) throw new Error("protobuf");
      if (type === "json") json = responseGetter.call(xhr);
      else {
        const text = type === "arraybuffer" ? new TextDecoder().decode(responseGetter.call(xhr)) : textGetter.call(xhr);
        // 抖音的 Service Worker 有时回空包，没东西可滤，也不算读不了
        if (!text.trim()) return undefined;
        json = JSON.parse(text);
      }
      if (!json) return undefined;
    } catch {
      // 一页只报一次：读不了的回包（二进制格式、出错页）原样放过，记录里留个底好排查
      if (!warned) emit([{ t: Date.now(), id: "", desc: "", author: "", matched: [], action: "unreadable" }]);
      warned = true;
      return undefined;
    }
    const hits = DYF.filterFeed(json, settings.rules, settings.mode !== "observe").filter((hit) => {
      if (!hit.id || seen.has(hit.id)) return false;
      seen.add(hit.id);
      return true;
    });
    if (settings.mode === "dislike") hits.forEach((hit) => queue.push(hit)), drain();
    else if (hits.length) emit(hits.map((hit) => ({ ...hit, t: Date.now(), action: settings.mode === "observe" ? "observed" : "hidden" })));
    if (settings.mode === "observe") return undefined;
    xhr.__dyfText = JSON.stringify(json);
    return xhr.__dyfText;
  }

  Object.defineProperty(proto, "responseText", { configurable: true, enumerable: true, get() {
    const value = textGetter.call(this);
    if (!this.__dyfFeed || this.readyState !== 4) return value;
    return rewrite(this) ?? value;
  } });

  Object.defineProperty(proto, "response", { configurable: true, enumerable: true, get() {
    const value = responseGetter.call(this);
    if (!this.__dyfFeed || this.readyState !== 4) return value;
    const text = rewrite(this);
    if (text === undefined) return value;
    if (this.__dyfOut === undefined) {
      const type = this.responseType;
      this.__dyfOut = type === "arraybuffer" ? new TextEncoder().encode(text).buffer : type === "json" ? JSON.parse(text) : text;
    }
    return this.__dyfOut;
  } });

  // ---------- 「不感兴趣」：自己发 XHR，和页面点菜单时发的是同一个请求 ----------
  // 页面那一下是 POST 这个地址、表单里带 aweme_id；签名（a_bogus、msToken）由页面的安全组件统一挂在 XHR 上补，
  // 它对 www.douyin.com 的 POST 一律生效，所以自己发的这条和页面发的待遇一样。不去执行抖音打包的内部模块：
  // 分包没加载全时执行会抛错，还可能把半初始化的模块留在缓存里，连累页面自己的「不感兴趣」。
  // 公共参数（设备、浏览器、版本那些）照抄页面刚发过的推荐请求，名单和采集器直连时用的一样
  const COMMON = new Set(["device_platform", "aid", "channel", "update_version_code", "pc_client_type", "pc_libra_divert",
    "support_h265", "support_dash", "version_code", "version_name", "cookie_enabled", "screen_width", "screen_height",
    "browser_language", "browser_platform", "browser_name", "browser_version", "browser_online", "engine_name",
    "engine_version", "os_name", "os_version", "cpu_core_num", "device_memory", "platform", "downlink", "effective_type",
    "round_trip_time", "webid"]);
  let common = new URLSearchParams({ device_platform: "webapp", aid: "6383", channel: "channel_pc_web" });

  function dislike(id) {
    const params = new URLSearchParams(common);
    params.set("aweme_id", id);
    const uifid = /(?:^|;\s*)UIFID=([^;]+)/u.exec(document.cookie)?.[1];
    if (uifid) params.set("uifid", uifid);
    // 走当前原型链上的 open/send（安全组件后挂的钩子在最外层），别直接调存下的原生方法，不然签名补不上
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${DISLIKE_PATH}?${params}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      if (uifid) xhr.setRequestHeader("uifid", uifid);
      xhr.onloadend = () => {
        try { resolve(JSON.parse(xhr.responseText).status_code === 0); } catch { resolve(false); }
      };
      xhr.send(`aweme_id=${encodeURIComponent(id)}`);
    });
  }

  const queue = [];
  const stamps = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const hit = queue.shift();
        const now = Date.now();
        while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
        let action = "hidden";
        if (stamps.length < PER_MINUTE) {
          stamps.push(now);
          action = (await dislike(hit.id)) ? "disliked" : "dislike_failed";
          // 一条一条来，中间停一下，别一口气连发
          await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));
        }
        emit([{ ...hit, t: Date.now(), action }]);
      }
    } finally {
      draining = false;
    }
  }
})();
