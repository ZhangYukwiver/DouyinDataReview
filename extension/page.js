// 扩展装进抖音页面自己的环境（MAIN world，document_start，网页脚本运行之前），排在 filter.js 后面。
// 同时拦截 XHR 和 fetch：在页面读到响应之前把命中的视频从 aweme_list 里拿掉。
// 词条和模式由应用定，经 bridge.js 以 dyf:settings 事件送来；处置结果用 dyf:events 事件交回去，最后存进应用。
(function () {
  "use strict";
  if (location.hostname !== "www.douyin.com" || window.__dyfInstalled) return;
  window.__dyfInstalled = true;

  const DYF = globalThis.DYF;
  // 首页推荐是 tab/feed，精选页是 module/feed；关注、朋友这些流不碰
  const FEED = /^\/aweme\/v\d+\/web\/(?:tab|module)\/feed\/?$/u;
  const DETAIL = /^\/aweme\/v\d+\/web\/aweme\/detail\/?$/u;
  const DISLIKE_PATH = "/aweme/v1/web/commit/dislike/item/";
  const PER_MINUTE = 6;
  let settings = null;
  let warned = false;
  const seen = new Set();
  const pending = [];
  const diagnostic = { installedAt: Date.now(), settingsReceived: 0, mode: null, ruleCount: 0,
    xhrRequests: 0, fetchRequests: 0, recognizedRequests: 0, responsesRead: 0, videosRead: 0,
    matchedVideos: 0, eventsEmitted: 0, readFailures: 0, requests: [], resources: [], lastResponse: null };

  function apiPath(value) {
    try {
      const url = new URL(String(value), location.href);
      return ["www.douyin.com", "www-hj.douyin.com"].includes(url.hostname) && url.pathname.startsWith("/aweme/")
        ? { host: url.hostname, path: url.pathname } : null;
    } catch { return null; }
  }

  function countPath(list, value, transport, recognized = false) {
    const path = apiPath(value);
    if (!path) return;
    const existing = list.find((item) => item.host === path.host && item.path === path.path && item.transport === transport);
    if (existing) { existing.count += 1; existing.recognized ||= recognized; }
    else {
      if (list.length === 12) list.shift();
      list.push({ ...path, transport, recognized, count: 1 });
    }
  }

  function readResponse(json, transport, type) {
    const owner = Array.isArray(json?.aweme_list) ? json : json?.data;
    const videos = Array.isArray(owner?.aweme_list) ? owner.aweme_list.length : json?.aweme_detail || json?.data?.aweme_detail ? 1 : 0;
    diagnostic.responsesRead += 1;
    diagnostic.videosRead += videos;
    diagnostic.lastResponse = { transport, type, videos, keys: json && typeof json === "object" ? Object.keys(json).slice(0, 16) : [] };
  }

  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) countPath(diagnostic.resources, entry.name, entry.initiatorType);
    });
    observer.observe({ type: "resource", buffered: true });
  }

  document.addEventListener("dyf:probe", () => {
    const status = { ...diagnostic, pendingPages: pending.length,
      xhrResponseHook: String(Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response")?.get).includes("__dyfFeed"),
      fetchHook: String(window.fetch).includes("isFeed") };
    document.dispatchEvent(new CustomEvent("dyf:diagnostics", { detail: JSON.stringify(status) }));
  });

  document.addEventListener("dyf:settings", (event) => {
    try {
      const value = JSON.parse(event.detail);
      if (!value || !["off", "observe", "hide", "dislike"].includes(value.mode) || typeof value.rules !== "string") return;
      settings = { mode: value.mode, rules: DYF.compileRules(value.rules) };
      diagnostic.settingsReceived += 1;
      diagnostic.mode = settings.mode;
      diagnostic.ruleCount = settings.rules.length;
      // 回包比词条先到时页面已经读过它，只能补记，不能再报成「已隐藏」。
      for (const json of pending.splice(0)) filter(json, true);
      inspectInitial();
    } catch { /* 坏消息不换掉手上的词条 */ }
  });

  const emit = (events) => {
    diagnostic.eventsEmitted += events.length;
    document.dispatchEvent(new CustomEvent("dyf:events", { detail: JSON.stringify(events) }));
  };

  function isRecommendationPage() {
    return /^\/(?:recommend\/?|jingxuan(?:\/.*)?|video\/\d+\/?|note\/\d+\/?)?$/u.test(location.pathname);
  }

  function isFeed(url) {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.origin === location.origin && (FEED.test(parsed.pathname) || (DETAIL.test(parsed.pathname) && isRecommendationPage()));
    } catch { return false; }
  }

  function rememberCommon(url) {
    try {
      const query = new URL(String(url), location.href).searchParams;
      if (query.get("aid")) common = new URLSearchParams([...query].filter(([name]) => COMMON.has(name)));
    } catch { /* 留着上一份 */ }
  }

  function unreadable() {
    diagnostic.readFailures += 1;
    // 一页只报一次；坏回包保留原样，不能让拦截器影响页面自身的请求处理。
    if (!warned) emit([{ t: Date.now(), id: "", desc: "", author: "", matched: [], action: "unreadable" }]);
    warned = true;
  }

  // 两种请求共用匹配、处置和去重。重复的视频仍要隐藏，只对处置记录去重。
  function filter(json, recordOnly = false) {
    if (!settings) {
      // 设置正常从本地缓存很快送到；后台尚未启动时也只暂存最近八页。
      if (pending.length === 8) pending.shift();
      pending.push(json);
      return undefined;
    }
    if (settings.mode === "off" || !settings.rules.length) return undefined;
    const detail = json?.aweme_detail ?? json?.data?.aweme_detail;
    // 详情是已选中作品，删成 null 会破坏播放器；和已送进页面的首屏一样只补记。
    const observe = recordOnly || Boolean(detail) || settings.mode === "observe";
    const all = DYF.filterFeed(detail ? { aweme_list: [detail] } : json, settings.rules, !observe);
    const action = observe ? "observed" : settings.mode;
    const hits = all.filter((hit) => {
      const key = `${hit.id}:${action}`;
      if (!hit.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    diagnostic.matchedVideos += hits.length;
    if (!observe && settings.mode === "dislike") hits.forEach((hit) => queue.push(hit)), drain();
    else if (hits.length) emit(hits.map((hit) => ({ ...hit, t: Date.now(), action: observe ? "observed" : "hidden" })));
    return observe || !all.length ? undefined : JSON.stringify(json);
  }

  // 第一屏随 HTML/路由缓存到达，不一定再请求 feed。只读这些已加载的数据，不改路由或页面状态。
  function inspectInitial() {
    if (!settings || settings.mode === "off" || !settings.rules.length || !isRecommendationPage()) return;
    const roots = [window._ROUTER_DATA, window.__MODERN_ROUTER_DATA__, window.__INITIAL_STATE__];
    const raw = document.getElementById?.("RENDER_DATA")?.textContent;
    if (raw && raw.length <= 8 * 1024 * 1024) {
      try { roots.push(JSON.parse(raw)); } catch {
        try { roots.push(JSON.parse(decodeURIComponent(raw))); } catch { /* 不是可读的首屏数据 */ }
      }
    }
    const visited = new Set();
    while (roots.length && visited.size < 5000) {
      const node = roots.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);
      const props = Object.getOwnPropertyDescriptors(node);
      // 只读普通数据字段，不调用页面对象上的 getter。
      if (Array.isArray(props.aweme_list?.value) || props.aweme_detail?.value) filter({
        aweme_list: props.aweme_list?.value, aweme_detail: props.aweme_detail?.value,
      }, true);
      for (const descriptor of Object.values(props).slice(0, 1000)) {
        if (descriptor.value && typeof descriptor.value === "object") roots.push(descriptor.value);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", inspectInitial, { once: true });

  // 网页有 application/protobuf 和 application/x-protobuf 两种写法，统一要求 JSON。
  function jsonHeader(name, value) {
    if (settings?.mode !== "off" && /^(?:accept|content-type)$/iu.test(name) && /\b(?:x-)?protobuf\b/iu.test(value))
      return /^accept$/iu.test(name) ? "application/json, text/plain, */*" : "application/json";
    return value;
  }

  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const setRequestHeader = proto.setRequestHeader;
  const textGetter = Object.getOwnPropertyDescriptor(proto, "responseText").get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, "response").get;

  proto.open = function (method, url) {
    this.__dyfFeed = isFeed(url);
    if (apiPath(url)) diagnostic.xhrRequests += 1;
    countPath(diagnostic.requests, url, "xhr", this.__dyfFeed);
    if (this.__dyfFeed) diagnostic.recognizedRequests += 1;
    if (this.__dyfFeed) rememberCommon(url);
    this.__dyfDone = false;
    this.__dyfText = undefined;
    this.__dyfOut = undefined;
    return open.apply(this, arguments);
  };

  // 推荐接口有时要二进制（protobuf）格式，那样读不了。把 Accept 改回 JSON，页面自己也认 JSON 回包
  proto.setRequestHeader = function (name, value) {
    return setRequestHeader.call(this, name, this.__dyfFeed ? jsonHeader(name, value) : value);
  };

  // 每个请求只改一次；返回改过的 JSON 文本，没改就是 undefined
  function rewrite(xhr) {
    if (xhr.__dyfDone) return xhr.__dyfText;
    xhr.__dyfDone = true;
    if (settings && (settings.mode === "off" || !settings.rules.length)) return undefined;
    const type = xhr.responseType;
    if (type && type !== "text" && type !== "arraybuffer" && type !== "json") return undefined;
    let json;
    try {
      if (type === "json") json = responseGetter.call(xhr);
      else {
        const text = type === "arraybuffer" ? new TextDecoder().decode(responseGetter.call(xhr)) : textGetter.call(xhr);
        // 抖音的 Service Worker 有时回空包，没东西可滤，也不算读不了
        if (!text.trim()) return undefined;
        json = JSON.parse(text);
      }
      if (!json) return undefined;
      readResponse(json, "xhr", type || "text");
      xhr.__dyfText = filter(json);
      return xhr.__dyfText;
    } catch {
      unreadable();
      return undefined;
    }
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

  const fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : input;
    const recognized = isFeed(url);
    if (apiPath(url)) diagnostic.fetchRequests += 1;
    countPath(diagnostic.requests, url, "fetch", recognized);
    if (!recognized) return fetch.apply(this, arguments);
    diagnostic.recognizedRequests += 1;
    rememberCommon(url);
    const headers = new Headers(init?.headers === undefined ? input?.headers : init.headers);
    let changed = false;
    for (const name of ["accept", "content-type"]) {
      const before = headers.get(name);
      const after = jsonHeader(name, before);
      if (before !== after) { headers.set(name, after); changed = true; }
    }
    return fetch.call(this, input, changed ? { ...init, headers } : init).then(async (response) => {
      if (settings && (settings.mode === "off" || !settings.rules.length)) return response;
      try {
        // 用副本检查，未命中、只记录和无法读取时，页面仍收到原响应及其未消费的 body。
        const text = await response.clone().text();
        if (!text.trim()) return response;
        const json = JSON.parse(text);
        readResponse(json, "fetch", "text");
        const rewritten = filter(json);
        if (rewritten === undefined) return response;
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.set("content-type", "application/json; charset=utf-8");
        // 新建 Response 的 url/type/redirected 默认会丢掉，clone 后也要保留它们。
        const metadata = (copy) => Object.defineProperties(copy, {
          url: { value: response.url }, type: { value: response.type }, redirected: { value: response.redirected },
          clone: { value() { return metadata(Response.prototype.clone.call(this)); } },
        });
        return metadata(new Response(rewritten, { status: response.status, statusText: response.statusText, headers }));
      } catch {
        unreadable();
        return response;
      }
    });
  };

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
