// 隔离环境里的中转：后台的词条交给页面里的 page.js，页面报上来的处置结果交给后台。两边只传字符串。
(function () {
  "use strict";
  let fresh = false;
  const deliver = (type, settings) => {
    // 应用里最新的先到了，就别让慢一步的旧存档盖回去
    if (!settings || (type === "cached" && fresh)) return;
    if (type === "settings") fresh = true;
    document.dispatchEvent(new CustomEvent("dyf:settings", { detail: JSON.stringify(settings) }));
  };
  // 扩展后台刚装上或正在起来时消息会落空，隔一秒再要，最多五次
  const ask = (type, retry = 0) => chrome.runtime.sendMessage({ type }).then((settings) => deliver(type, settings),
    () => { if (retry < 5) setTimeout(ask, 1000, type, retry + 1); });
  // 先要上次存下的（马上就有），再要应用里最新的（后台刚醒时连应用要几秒）
  ask("cached");
  ask("settings");
  // 在应用里改了词条，开着的抖音页一分钟内跟上
  setInterval(ask, 60_000, "settings");
  document.addEventListener("dyf:events", (event) => {
    let events;
    try { events = JSON.parse(event.detail); } catch { return; }
    if (Array.isArray(events)) chrome.runtime.sendMessage({ type: "events", events }).catch(() => undefined);
  });
})();
