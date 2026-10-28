// 隔离环境里的中转：后台的词条交给页面里的 page.js，页面报上来的处置结果交给后台。两边只传字符串。
(function () {
  "use strict";
  const version = chrome.runtime.getManifest().version;
  const previous = globalThis.__dyfBridge;
  if (previous?.version === version && previous.active) { previous.refresh(); return; }
  previous?.dispose();

  let active = true;
  let fresh = false;
  let pageResponded = false;
  const timers = new Set();
  const bridge = { eventsReceived: 0, forwardFailures: 0 };
  const send = (message) => Promise.resolve().then(() => active ? chrome.runtime.sendMessage(message) : null).catch((error) => {
    if (/extension context invalidated/iu.test(String(error?.message ?? error))) dispose();
    throw error;
  });
  const deliver = (type, settings) => {
    // 应用里最新的先到了，就别让慢一步的旧存档盖回去
    if (!active || !settings || (type === "cached" && fresh)) return;
    if (type === "settings") fresh = true;
    document.dispatchEvent(new CustomEvent("dyf:settings", { detail: JSON.stringify(settings) }));
  };
  // 扩展后台刚装上或正在起来时消息会落空，隔一秒再要，最多五次
  const ask = (type, retry = 0) => send({ type }).then((settings) => deliver(type, settings), () => {
    if (active && retry < 5) {
      const timer = setTimeout(() => { timers.delete(timer); ask(type, retry + 1); }, 1000);
      timers.add(timer);
    }
  });
  const onEvents = (event) => {
    if (!active) return;
    let events;
    try { events = JSON.parse(event.detail); } catch { return; }
    if (Array.isArray(events)) {
      bridge.eventsReceived += events.length;
      send({ type: "events", events }).catch(() => { bridge.forwardFailures += 1; });
    }
  };
  const onDiagnostics = (event) => {
    if (!active) return;
    let diagnostics;
    try { diagnostics = JSON.parse(event.detail); } catch { return; }
    pageResponded = true;
    send({ type: "diagnostics", diagnostics, bridge })
      .catch(() => { bridge.forwardFailures += 1; });
  };
  const probe = () => {
    if (!active) return false;
    pageResponded = false;
    document.dispatchEvent(new CustomEvent("dyf:probe"));
    return pageResponded;
  };
  const onMessage = (message, _sender, respond) => {
    if (active && message?.type === "dyf:ping") respond({ version, ready: probe() });
    return false;
  };
  function dispose() {
    if (!active) return;
    active = false;
    for (const timer of timers) { clearInterval(timer); clearTimeout(timer); }
    timers.clear();
    document.removeEventListener("dyf:events", onEvents);
    document.removeEventListener("dyf:diagnostics", onDiagnostics);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* 旧 runtime 已失效 */ }
  }
  const refresh = () => { ask("cached"); ask("settings"); probe(); };
  globalThis.__dyfBridge = { version, get active() { return active; }, refresh, dispose };
  document.addEventListener("dyf:events", onEvents);
  document.addEventListener("dyf:diagnostics", onDiagnostics);
  chrome.runtime.onMessage.addListener(onMessage);
  // 先用本地缓存，再拉应用里的新设置；重复注入复用同一组监听与计时器。
  timers.add(setInterval(() => ask("settings"), 60_000));
  timers.add(setInterval(probe, 5000));
  refresh();
})();
