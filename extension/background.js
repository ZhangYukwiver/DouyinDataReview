// 扩展后台：找到本机 DouyinDataReview 的采集器，拉应用定的词条和过滤方式、送处置记录；应用叫移除时把自己卸载掉。
// 采集器只认这个扩展的固定 ID（manifest 里的 key），给它的令牌也只够这几件事。
// 应用没开时按上次存下的词条照常过滤，记录先攒在这里，下次连上再补传。
"use strict";

// 桌面版固定用 47652；4765 是单独跑 npm run collector 时的默认端口
const PORTS = [47652, 4765];
const MAX_PENDING = 300;

// 排查真实页面：只留路径、计数和数据结构，不留请求参数、作品文案、Cookie 或令牌。
function diagnosticOf(value) {
  const count = (item) => Number.isFinite(item) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(item))) : 0;
  const clean = Object.fromEntries(["installedAt", "settingsReceived", "ruleCount", "xhrRequests", "fetchRequests", "recognizedRequests",
    "responsesRead", "videosRead", "matchedVideos", "eventsEmitted", "readFailures", "pendingPages", "pickWords", "picksQueued", "picksInserted", "pickSearches", "pickFailures"]
    .map((key) => [key, count(value?.[key])]));
  const paths = (items) => (Array.isArray(items) ? items : []).slice(-12).flatMap((item) => {
    if (!["www.douyin.com", "www-hj.douyin.com"].includes(item?.host) || typeof item.path !== "string" || !item.path.startsWith("/aweme/")) return [];
    return [{ host: item.host, path: item.path.split(/[?#]/u)[0].slice(0, 200),
      transport: ["xhr", "fetch", "xmlhttprequest"].includes(item.transport) ? item.transport : "other",
      recognized: item.recognized === true, count: count(item.count) }];
  });
  return { ...clean, picksEnabled: value?.picksEnabled === true, mode: ["off", "observe", "hide", "dislike"].includes(value?.mode) ? value.mode : null,
    xhrResponseHook: value?.xhrResponseHook === true, fetchHook: value?.fetchHook === true,
    requests: paths(value?.requests), resources: paths(value?.resources),
    lastResponse: value?.lastResponse ? { videos: count(value.lastResponse.videos),
      transport: value.lastResponse.transport === "xhr" ? "xhr" : "fetch",
      type: ["text", "json", "arraybuffer"].includes(value.lastResponse.type) ? value.lastResponse.type : "other",
      keys: (Array.isArray(value.lastResponse.keys) ? value.lastResponse.keys : []).filter((key) => typeof key === "string" && /^[\w]{1,80}$/u.test(key)).slice(0, 16) } : null };
}

// 扩展版本号是点分数字（1.2.0）
function isNewerVersion(candidate, current) {
  const a = String(candidate).split(".").map(Number);
  const b = String(current).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

let chain = Promise.resolve();
const serial = (task) => (chain = chain.then(task, task));

// 扩展重载会让旧的隔离脚本失去 runtime 连接，但网页和 MAIN 里的匹配器还在。
// 仅对已授权的抖音标签检查连接；缺失时补装中转脚本，页面自身无需重新加载。
async function restoreOpenPages() {
  const version = chrome.runtime.getManifest().version;
  const tabs = await chrome.tabs.query({ url: "https://www.douyin.com/*" });
  const targets = tabs.filter((tab) => {
    try { return Number.isInteger(tab.id) && new URL(tab.url).origin === "https://www.douyin.com"; } catch { return false; }
  });
  const results = await Promise.allSettled(targets.map(async (tab) => {
    const bridge = await chrome.tabs.sendMessage(tab.id, { type: "dyf:ping" }).catch(() => null);
    if (bridge?.version === version && bridge.ready === true) return "connected";
    // page.js 已有安装保护：沿用当前页面的匹配器，不叠加网络拦截。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["filter.js", "picks.js", "page.js"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED", files: ["panel.js", "bridge.js"] });
    return "restored";
  }));
  await chrome.storage.local.set({ pageAttachment: { version, checkedAt: Date.now(), pages: targets.length,
    restored: results.filter((result) => result.status === "fulfilled" && result.value === "restored").length,
    connected: results.filter((result) => result.status === "fulfilled" && result.value === "connected").length,
    failed: results.filter((result) => result.status === "rejected").length } });
}

async function connect() {
  for (const port of PORTS) {
    const base = `http://127.0.0.1:${port}`;
    try {
      if (!(await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok) continue;
      // 不用配对码：采集器按扩展的固定来源直接发令牌
      const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(3000) });
      if (!paired.ok) continue;
      const { token } = await paired.json();
      await chrome.storage.local.set({ base, token });
      return { base, token };
    } catch { /* 这个端口上没有应用，试下一个 */ }
  }
  return null;
}

// 没配过、配对过期（401）或者应用换了端口：重新找一次再试
async function call(path, init = {}, interactive = false) {
  let { base, token } = await chrome.storage.local.get(["base", "token"]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!base || !token) ({ base, token } = (await connect()) ?? {});
    if (!base) return null;
    try {
      const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
      if (response.ok) return await response.json();
      if (response.status !== 401) {
        if (!interactive) return null;
        const error = await response.json().catch(() => ({}));
        return { error: error.message || ([403, 404].includes(response.status) ? "请更新 DouyinDataReview 后再试。" : "操作失败，请稍后重试。") };
      }
    } catch {
      // 已提交的下载遇到断连，不能自动重发而创建第二个任务。
      if (interactive && init.method === "POST") return { error: "未收到应用回执，请检查应用状态。" };
    }
    base = token = null;
  }
  return null;
}

async function flush() {
  let { pending = [] } = await chrome.storage.local.get("pending");
  while (pending.length) {
    // 每条带着视频信息（一两 KB），一批 20 条
    const batch = pending.slice(0, 20);
    if (!(await call("/v1/feed-filter/events", { method: "POST", body: JSON.stringify({ events: batch }) }))) return;
    pending = pending.slice(batch.length);
    await chrome.storage.local.set({ pending });
  }
}

// 从应用拉最新的设置存下来；应用没开就是 null。应用叫移除：先告诉它一声，再卸载自己（不弹确认框）
async function refresh() {
  const value = await call("/v1/feed-filter");
  if (value?.remove === true) {
    await call("/v1/feed-filter/removed", { method: "POST", body: "{}" });
    await chrome.management.uninstallSelf({ showConfirmDialog: false });
    return null;
  }
  if (typeof value?.rules !== "string" || typeof value?.mode !== "string") return null;
  const next = await cacheSettings(value);
  // 应用带了更新的扩展、已经换进了浏览器加载的那个文件夹：重新加载一次就是新版。
  // 同一个版本只试一次：万一是从别的文件夹加载的，重载了还是旧版，不能每分钟重载一回
  if (typeof value.version === "string" && isNewerVersion(value.version, chrome.runtime.getManifest().version)) {
    const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
    if (reloadedFor !== value.version) {
      await chrome.storage.local.set({ reloadedFor: value.version });
      chrome.runtime.reload();
    }
  }
  return next;
}

async function cacheSettings(value) {
  const settings = { rules: value.rules, mode: value.mode, words: value.words ?? "", webPicks: value.webPicks === true,
    pickEvery: Number.isInteger(value.pickEvery) ? value.pickEvery : 3, downloadQualities: value.downloadQualities, downloadModes: value.downloadModes };
  await chrome.storage.local.set({ settings });
  return settings;
}

async function panelRequest(message) {
  const offline = "请打开 DouyinDataReview，再试一次。";
  if (message.type === "panel:settings") {
    const settings = await refresh();
    return { settings: settings ?? (await chrome.storage.local.get("settings")).settings, offline: !settings };
  }
  if (message.type === "panel:history") {
    const value = await call("/v1/feed-filter/events", {}, true);
    const { pending = [] } = await chrome.storage.local.get("pending");
    const events = [...(value?.events ?? []), ...pending].filter(event => event && !event.site && /^\d{5,30}$/u.test(event.id)
      && ["inserted", "hidden", "disliked", "dislike_failed"].includes(event.action))
      .map(({ id, t, desc, author, matched, action }) => ({ id, t, desc, author, matched, action }));
    return { events, warning: value?.error ?? (!value ? "应用离线，仅显示待同步记录。" : "") };
  }
  if (message.type === "panel:save") {
    const change = {};
    for (const key of ["words", "rules"]) if (typeof message[key] === "string") change[key] = message[key];
    if (!Object.keys(change).length) return { error: "请先修改词条。" };
    const value = await call("/v1/feed-filter", { method: "POST", body: JSON.stringify(change) }, true);
    if (typeof value?.rules !== "string") return { error: value?.error || offline };
    return { settings: await cacheSettings(value) };
  }
  let value;
  if (message.type === "panel:download" && typeof message.id === "string" && /^\d{5,30}$/u.test(message.id)) {
    value = await call("/v1/downloads", { method: "POST", body: JSON.stringify({ videoId: message.id, quality: message.quality, mode: message.mode }) }, true);
  } else if (message.type === "panel:progress" && typeof message.id === "string" && /^[0-9a-f-]{36}$/u.test(message.id)) {
    value = await call(`/v1/downloads/${message.id}`, {}, true);
  } else return { error: "无效的作品或下载任务。" };
  return value ?? { error: offline };
}

// 每分钟和应用对一次：应用能看到扩展还在，叫移除、有新版也在这时收到；刚装好、浏览器一启动就先对一次
const sync = () => serial(async () => {
  await restoreOpenPages().catch(() => undefined);
  await refresh();
  await flush();
});
chrome.alarms.get("sync").then((alarm) => alarm || chrome.alarms.create("sync", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message?.type === "string" && message.type.startsWith("panel:")) {
    if (!sender.url?.startsWith("https://www.douyin.com/") || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
    serial(() => panelRequest(message)).then(sendResponse, () => sendResponse({ error: "操作失败，请重试。" }));
    return true;
  }
  if (message?.type === "diagnostics") {
    let page;
    try { page = new URL(sender.url); } catch { return false; }
    if (page.origin !== "https://www.douyin.com" || !Number.isInteger(sender.tab?.id)) return false;
    const snapshot = { ...diagnosticOf(message.diagnostics), receivedAt: Date.now(), version: chrome.runtime.getManifest().version,
      path: page.pathname.slice(0, 200),
      bridgeEventsReceived: Number.isFinite(message.bridge?.eventsReceived) ? Math.max(0, Math.floor(message.bridge.eventsReceived)) : 0,
      bridgeForwardFailures: Number.isFinite(message.bridge?.forwardFailures) ? Math.max(0, Math.floor(message.bridge.forwardFailures)) : 0 };
    serial(async () => {
      const { feedDiagnostics = {} } = await chrome.storage.local.get("feedDiagnostics");
      const entries = Object.entries({ ...feedDiagnostics, [sender.tab.id]: snapshot })
        .sort((a, b) => b[1].receivedAt - a[1].receivedAt).slice(0, 8);
      await chrome.storage.local.set({ feedDiagnostics: Object.fromEntries(entries) });
    });
    return false;
  }
  // 上次存下的：马上就有，页面打开时先用它，免得等后台连应用的那几秒里第一批推荐漏过去
  if (message?.type === "cached") {
    chrome.storage.local.get("settings").then(({ settings }) => sendResponse(settings ?? null), () => sendResponse(null));
    return true;
  }
  // 应用里最新的；应用没开就回上次存下的
  if (message?.type === "settings") {
    serial(async () => {
      sendResponse((await refresh()) ?? (await chrome.storage.local.get("settings")).settings ?? null);
      await flush();
    }).catch(() => sendResponse(null));
    return true;
  }
  if (message?.type === "events" && Array.isArray(message.events)) {
    serial(async () => {
      const { pending = [] } = await chrome.storage.local.get("pending");
      await chrome.storage.local.set({ pending: [...pending, ...message.events].slice(-MAX_PENDING) });
      await flush();
    });
  }
  return false;
});
