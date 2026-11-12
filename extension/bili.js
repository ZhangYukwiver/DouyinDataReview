// B 站首页推荐：和 page.js 同一套词条、过滤方式和处置记录，只是接口和字段换成 B 站的。
// 装进页面自己的环境（MAIN world，document_start），排在 filter.js 后面；经 bridge.js 收设置、交记录。
// 后续推荐走 api.bilibili.com 的 top/feed/rcmd，回包 data.item；首屏十来条写在 window.__pinia 里不走接口，用样式藏卡片。
(function () {
  "use strict";
  if (location.hostname !== "www.bilibili.com" || window.__dyfBiliInstalled) return;
  window.__dyfBiliInstalled = true;

  const DYF = globalThis.DYF;
  const FEED = /^\/x\/web-interface\/(?:wbi\/)?index\/top\/feed\/rcmd\/?$/u;
  const DISLIKE_URL = "https://api.bilibili.com/x/web-interface/feedback/dislike";
  const PER_MINUTE = 6;
  let settings = null;
  const picks = DYF.createPicks({ search: searchWord, site: siteOf(),
    blocked: (item) => Boolean(settings?.rules.length && DYF.match(settings.rules, fieldsOf(item)).score >= 1) });
  const seen = new Set();
  const pending = [];

  function isFeed(url) {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.hostname === "api.bilibili.com" && FEED.test(parsed.pathname);
    } catch { return false; }
  }

  // 首屏数据和接口回包字段不一样：首屏用 author/aid/isAd，接口用 owner/id/business_info
  function fieldsOf(item) {
    const owner = item?.owner ?? item?.author;
    const fields = { desc: DYF.normalize(item?.title), author: DYF.normalize([owner?.name, owner?.mid].filter((value) => value != null).join(" ")),
      tag: DYF.normalize(item?.rcmd_reason?.content ?? item?.rcmdReason?.content), music: "" };
    fields.any = [fields.desc, fields.author, fields.tag].join(" ");
    return fields;
  }

  function hitOf(item) {
    const result = DYF.match(settings.rules, fieldsOf(item));
    const isAd = item?.goto === "ad" || Boolean(item?.business_info) || item?.isAd === true;
    if (isAd) { result.score += 1; result.matched.unshift("广告标识"); }
    if (result.score < 1) return null;
    const owner = item?.owner ?? item?.author;
    return { site: "bilibili", id: String(item?.id ?? item?.aid ?? ""), bvid: typeof item?.bvid === "string" ? item.bvid : "",
      desc: String(item?.title ?? "").slice(0, 120), author: String(owner?.name ?? "").slice(0, 40), matched: result.matched.slice(0, 5),
      isAd, goto: String(item?.goto ?? "av"), mid: String(owner?.mid ?? 0), trackId: String(item?.track_id ?? "") };
  }

  const emit = (events) => document.dispatchEvent(new CustomEvent("dyf:events", { detail: JSON.stringify(events) }));

  // 处置记录只记一次；广告的作品号常是 0，也照样拿掉
  function record(hits, action) {
    const fresh = hits.filter((hit) => {
      const key = `${hit.id}:${action}`;
      if (!/^\d{5,30}$/u.test(hit.id) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // 广告只在本地隐藏，不发「不感兴趣」
    if (action === "dislike") {
      queue.push(...fresh.filter((hit) => !hit.isAd));
      drain();
      emitHits(fresh.filter((hit) => hit.isAd), "hidden");
    } else emitHits(fresh, action);
  }

  const emitHits = (hits, action) => {
    if (hits.length) emit(hits.map(({ isAd, goto, mid, trackId, ...hit }) => ({ ...hit, t: Date.now(), action })));
  };

  // 返回 true 表示改过 json（命中的已拿掉、词条视频已插进去）
  function filter(json, recordOnly = false) {
    const items = json?.data?.item;
    if (!Array.isArray(items)) return false;
    if (!settings) {
      if (pending.length === 8) pending.shift();
      pending.push(json);
      return false;
    }
    picks.rememberPage(json);
    void picks.prefetch();
    let changed = false;
    if (settings.mode !== "off") {
      const observe = recordOnly || settings.mode === "observe";
      const hits = [];
      const kept = items.filter((item) => {
        const hit = hitOf(item);
        if (hit) hits.push(hit);
        return !hit || observe;
      });
      record(hits, observe ? "observed" : settings.mode === "dislike" ? "dislike" : "hidden");
      if (!observe && kept.length !== items.length) { json.data.item = kept; changed = true; }
    }
    // 页面已经读过的回包只补记，不再插
    if (!recordOnly && picks.mix(json, emit)) changed = true;
    if (changed) relayout();
    return changed;
  }

  // ---------- 想看的词条：搜 B 站视频，转成首页推荐的格式插进去（每几条插一条、轮换、去重、存进度都在 picks.js） ----------
  // 视频搜索不用签名，带着页面的 Cookie 搜，和用户自己在 B 站搜一样；搜不了 picks 会歇五分钟
  function searchWord(word, offset) {
    const params = new URLSearchParams({ search_type: "video", keyword: word, page: String(offset + 1) });
    return fetch.call(window, `https://api.bilibili.com/x/web-interface/search/type?${params}`, { credentials: "include" }).then((response) => response.json());
  }

  function siteOf() {
    const plain = (html) => String(html ?? "").replace(/<[^>]*>/gu, "")
      .replace(/&(amp|lt|gt|quot|#39);/gu, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[name]);
    const count = (value) => Number(value) || 0;
    // 搜索结果的时长是「4:20」「1:02:03」
    const seconds = (text) => String(text ?? "").split(":").reduce((sum, part) => sum * 60 + count(part), 0);
    const toItem = (result) => ({ id: count(result.aid), bvid: result.bvid, cid: 0, goto: "av", uri: `https://www.bilibili.com/video/${result.bvid}`,
      pic: String(result.pic ?? "").replace(/^\/\//u, "https://"), pic_4_3: "", title: plain(result.title), duration: seconds(result.duration),
      pubdate: count(result.pubdate), owner: { mid: count(result.mid), name: String(result.author ?? ""), face: String(result.upic ?? "") },
      stat: { view: count(result.play), like: count(result.like), danmaku: count(result.danmaku ?? result.video_review), vt: 0 },
      av_feature: null, is_followed: 0, rcmd_reason: null, show_info: 0, track_id: "", pos: 0, room_info: null, ogv_info: null,
      business_info: null, is_stock: 0, enable_vt: 0, vt_display: "", dislike_switch: 0, dislike_switch_pc: 0 });
    return {
      historyKey: "__dyf_bili_pick_history",
      id: (item) => item?.id,
      playable: (item) => item?.goto === "av" && /^\d{5,30}$/u.test(String(item?.id ?? "")) && !item.business_info,
      parse(payload) {
        if (payload?.code !== 0 || !Array.isArray(payload.data?.result)) throw new Error("search_unavailable");
        const page = count(payload.data.page);
        return { items: payload.data.result.filter((result) => result?.type === "video" && /^BV\w{10}$/u.test(result.bvid)).map(toItem),
          more: page < count(payload.data.numPages), next: page };
      },
      // 搜索结果不带 cid，卡片悬停预览要用；一条条补，补不上的不插
      async prepare(items) {
        const ready = [];
        for (const item of items) {
          try {
            const json = await fetch.call(window, `https://api.bilibili.com/x/player/pagelist?bvid=${item.bvid}`, { credentials: "include" }).then((response) => response.json());
            const cid = count(json?.data?.[0]?.cid);
            if (cid) ready.push({ ...item, cid });
          } catch { /* 这条不插 */ }
        }
        return ready;
      },
      describe: (item) => ({ site: "bilibili", bvid: item.bvid, author: String(item.owner?.name ?? "").slice(0, 40), desc: String(item.title ?? "").slice(0, 120) }),
      page(json) {
        const items = json?.data?.item;
        if (json?.code !== 0 || !Array.isArray(items) || !items.length) return null;
        return { items, set: (next) => { json.data.item = next; } };
      },
      shown: (json) => (Array.isArray(json?.data?.item) ? json.data.item : []),
    };
  }

  // 两处版面要补：①首屏藏掉卡片后，后面的卡片挪进前两行还带着第三行起的上边距（B 站按位置加的 40px），挪上来的清掉；
  // ②一批被拿掉几条就变短了，B 站只在滚动时看底部要不要加载，底部占位卡片会空着等用户再滚——补一次滚动事件让它接着要，铺满就停。
  // B 站每次加载至少占 500ms，这期间的滚动不算数，所以等 800ms 再推
  function relayout() {
    setTimeout(() => {
      let index = 0;
      for (const card of document.querySelector(".recommended-container_floor-aside .container")?.children ?? []) {
        card.style.removeProperty("margin-top");
        if (getComputedStyle(card).display === "none") continue;
        if (index++ < 7 && parseFloat(getComputedStyle(card).marginTop) > 0) card.style.setProperty("margin-top", "0px", "important");
      }
    }, 300);
    setTimeout(() => window.dispatchEvent(new Event("scroll")), 800);
  }

  // 首屏卡片是服务端直接渲染的，数据已经交给页面了：按视频号用样式藏，换一换、重排后也跟着内容走
  const style = document.createElement("style");
  function inspectInitial() {
    if (!settings || location.pathname !== "/" || !window.__pinia || typeof window.__pinia !== "object") return;
    const items = [];
    const nodes = [window.__pinia];
    const visited = new Set();
    while (nodes.length && visited.size < 5000) {
      const node = nodes.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);
      if (typeof node.bvid === "string" && /^BV\w{10}$/u.test(node.bvid) && typeof node.title === "string") items.push(node);
      for (const value of Object.values(node).slice(0, 1000)) if (value && typeof value === "object") nodes.push(value);
    }
    // 首屏这十来条也算见过：词条搜到同一条时不再往下面插，不然一页里出现两次
    picks.rememberPage({ data: { item: items.map((item) => ({ id: item.id ?? item.aid })) } });
    if (settings.mode === "off") { if (style.textContent) { style.textContent = ""; relayout(); } return; }
    const hits = items.map(hitOf).filter(Boolean);
    const hide = settings.mode === "hide" || settings.mode === "dislike";
    // 首屏这批页面已经拿到了，「不感兴趣」也照发：和后续推荐的处置一致
    record(hits, !hide ? "observed" : settings.mode === "dislike" ? "dislike" : "hidden");
    style.textContent = (hide ? hits.filter((hit) => hit.bvid) : []).map((hit) => hit.bvid).map((bvid) => `:is(.feed-card,.bili-feed-card,.bili-video-card):has(a[href*="/video/${bvid}"]){display:none!important}`).join("\n");
    if (!style.isConnected) (document.head ?? document.documentElement)?.append(style);
    relayout();
  }
  document.addEventListener("DOMContentLoaded", inspectInitial, { once: true });

  document.addEventListener("dyf:settings", (event) => {
    try {
      const value = JSON.parse(event.detail);
      if (!value || !["off", "observe", "hide", "dislike"].includes(value.mode) || typeof value.rules !== "string") return;
      settings = { mode: value.mode, rules: DYF.compileRules(value.rules) };
      picks.configure(typeof value.words === "string" ? value.words : "", value.webPicks === true, value.pickEvery);
      // 首页先把候选搜好，第一批推荐回来就能插
      if (location.pathname === "/") void picks.prefetch();
      // 回包比设置先到时页面已经读过它，只能补记
      for (const json of pending.splice(0)) filter(json, true);
      inspectInitial();
    } catch { /* 坏消息不换掉手上的词条 */ }
  });

  // ---------- XHR ----------
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const textGetter = Object.getOwnPropertyDescriptor(proto, "responseText").get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, "response").get;

  proto.open = function (method, url) {
    this.__dyfFeed = isFeed(url);
    this.__dyfDone = false;
    this.__dyfText = undefined;
    this.__dyfOut = undefined;
    return open.apply(this, arguments);
  };

  // 每个请求只改一次；返回改过的 JSON 文本，没改就是 undefined
  function rewrite(xhr) {
    if (xhr.__dyfDone) return xhr.__dyfText;
    xhr.__dyfDone = true;
    const type = xhr.responseType;
    try {
      // json 类型拿到的就是页面要用的那个对象，原地改完就行
      if (type === "json") { filter(responseGetter.call(xhr)); return undefined; }
      if (type && type !== "text") return undefined;
      const text = textGetter.call(xhr);
      if (!text.trim()) return undefined;
      const json = JSON.parse(text);
      if (filter(json)) xhr.__dyfText = JSON.stringify(json);
    } catch { /* 读不了就原样放过，不能影响页面自己的请求 */ }
    return xhr.__dyfText;
  }

  Object.defineProperty(proto, "responseText", { configurable: true, enumerable: true, get() {
    const value = textGetter.call(this);
    if (!this.__dyfFeed || this.readyState !== 4) return value;
    return rewrite(this) ?? value;
  } });

  Object.defineProperty(proto, "response", { configurable: true, enumerable: true, get() {
    if (this.__dyfFeed && this.readyState === 4) {
      const text = rewrite(this);
      if (text !== undefined) return text;
    }
    return responseGetter.call(this);
  } });

  // ---------- fetch ----------
  const fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : input;
    if (!isFeed(url)) return fetch.apply(this, arguments);
    return fetch.apply(this, arguments).then(async (response) => {
      try {
        const text = await response.clone().text();
        if (!text.trim()) return response;
        const json = JSON.parse(text);
        if (!filter(json)) return response;
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
      } catch {
        return response;
      }
    });
  };

  // ---------- 「不感兴趣」：和首页卡片菜单里「内容不感兴趣」发的同一个请求 ----------
  // 表单照抄页面（reason_id 1 = 内容不感兴趣），csrf 是 cookie 里的 bili_jct；没登录就没有，算没成功
  function dislike(hit) {
    const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(document.cookie)?.[1];
    if (!csrf) return Promise.resolve(false);
    const body = new URLSearchParams({ app_id: "100", platform: "5", from_spmid: "", spmid: "333.1007.0.0", goto: hit.goto, id: hit.id,
      mid: hit.mid, track_id: hit.trackId, feedback_page: "1", reason_id: "1", csrf });
    return fetch.call(window, DISLIKE_URL, { method: "POST", credentials: "include", body })
      .then((response) => response.json()).then((json) => json?.code === 0, () => false);
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
          action = (await dislike(hit)) ? "disliked" : "dislike_failed";
          // 一条一条来，中间停一下，别一口气连发
          await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));
        }
        const { isAd, goto, mid, trackId, ...event } = hit;
        emit([{ ...event, t: Date.now(), action }]);
      }
    } finally {
      draining = false;
    }
  }
})();
