// 扩展后台：找到本机 DouyinDataReview 的采集器，拉应用定的词条和过滤方式、送处置记录；应用叫移除时把自己卸载掉。
// 采集器只认这个扩展的固定 ID（manifest 里的 key），给它的令牌也只够这几件事。
// 应用没开时按上次存下的词条照常过滤，记录先攒在这里，下次连上再补传。
"use strict";

// 桌面版固定用 47652；4765 是单独跑 npm run collector 时的默认端口
const PORTS = [47652, 4765];
const MAX_PENDING = 300;

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
async function call(path, init = {}) {
  let { base, token } = await chrome.storage.local.get(["base", "token"]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!base || !token) ({ base, token } = (await connect()) ?? {});
    if (!base) return null;
    try {
      const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
      if (response.status !== 401) return response.ok ? await response.json() : null;
    } catch { /* 应用关了或者换了端口 */ }
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
  const next = { rules: value.rules, mode: value.mode };
  await chrome.storage.local.set({ settings: next });
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

// 每分钟和应用对一次：应用能看到扩展还在，叫移除、有新版也在这时收到；刚装好、浏览器一启动就先对一次
const sync = () => serial(async () => { await refresh(); await flush(); });
chrome.alarms.get("sync").then((alarm) => alarm || chrome.alarms.create("sync", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
