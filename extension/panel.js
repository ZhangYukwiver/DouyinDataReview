// 在隔离环境里创建面板。网页脚本只能上报推荐数据，保存词条和下载都由面板直接发给后台。
(() => {
  "use strict";
  const hostId = "dyf-feed-panel";
  const validId = id => typeof id === "string" && /^\d{5,30}$/u.test(id);
  function linkId(href) {
    if (!URL.canParse(href, location.href)) return null;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return null;
    const modal = url.searchParams.get("modal_id");
    return validId(modal) ? modal : url.pathname.match(/^\/(?:video|note|jingxuan)\/(\d{5,30})\/?$/u)?.[1];
  }

  function currentVideoId() {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const activeSelector = '[data-e2e="feed-active-video"]';
    const activeCards = [...document.querySelectorAll(activeSelector)].filter(visible);
    const videos = [...document.querySelectorAll("video")].filter(visible);
    const playing = videos.filter(video => !video.paused && !video.ended);
    const video = playing.length === 1 ? playing[0] : videos.length === 1 ? videos[0] : null;
    const active = video?.closest(activeSelector) || (activeCards.length === 1 ? activeCards[0] : null);
    const attr = "[data-e2e-vid],[data-aweme-id],[data-item-id]";
    const card = video?.closest(attr);
    const fromNode = node => ["data-e2e-vid", "data-aweme-id", "data-item-id"].map(key => node?.getAttribute(key)).find(validId);
    // 弹层覆盖背景推荐；详情页也可能在下一条播放后才更新路由。
    const modal = new URL(location.href).searchParams.get("modal_id");
    if (validId(modal)) return modal;
    const id = fromNode(active?.closest(attr)) || (active?.contains(video) ? fromNode(card) : null);
    if (id) return id;
    if (active) {
      const ids = new Set([...active.querySelectorAll('a[href*="/video/"],a[href*="/note/"]')].map(a => linkId(a.href)).filter(Boolean));
      if (ids.size === 1) return [...ids][0];
    }
    return linkId(location.href) || fromNode(card);
  }

  globalThis.__dyfMountPanel = function (send) {
    document.getElementById(hostId)?.remove();
    const host = document.createElement("div");
    host.id = hostId;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all:initial !important; position:fixed !important; left:var(--dyf-left,auto) !important; top:var(--dyf-top,76px) !important; right:var(--dyf-right,16px) !important; z-index:2147483646 !important; }
        * { box-sizing:border-box }
        .wrap { font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; color:#f5f5f8; color-scheme:dark; text-align:left }
        [hidden] { display:none !important }
        button,textarea,select { font:inherit;color:inherit }
        button { cursor:pointer;border:0;background:none }
        button:disabled { cursor:default;opacity:.55 }
        button:focus-visible,textarea:focus-visible,select:focus-visible,a:focus-visible { outline:2px solid #88e6db;outline-offset:2px }
        .launcher,.panel { background:#202126;border:1px solid #484950;border-radius:15px;box-shadow:0 6px 26px #0005 }
        .launcher { display:flex;align-items:center;gap:8px;padding:8px 13px;font-weight:600;margin-left:auto }
        .mark { color:#80e2d4;font-size:16px;font-weight:750;letter-spacing:-1px }
        .panel { width:min(324px,calc(100vw - 32px));max-height:calc(100dvh - 90px);overflow:auto;padding:15px }
        header,.tabs,footer,.setting-head { display:flex;align-items:center }
        header { gap:9px;margin-bottom:13px;cursor:move;touch-action:none;user-select:none }
        strong { font-size:16px }
        .close { margin-left:auto;color:#c3c4cb;font-size:21px;line-height:24px;width:30px;height:30px }
        .tabs { padding:3px;background:#15161a;border-radius:9px;gap:3px;margin-bottom:14px }
        .tabs button { flex:1;padding:6px 2px;color:#b6b7c0;font-size:13px;border-radius:6px }
        .tabs button[aria-pressed=true] { background:#383941;color:white;font-weight:600 }
        .setting-head { justify-content:space-between;gap:8px;margin:10px 0 5px }
        label { font-weight:600 }
        small,.note,.status,.meta { font-size:12px;color:#b6b8c2 }
        textarea { width:100%;min-height:58px;resize:vertical;max-height:160px;border-radius:7px;border:1px solid #51525b;background:#17181c;padding:8px 10px;line-height:1.45 }
        .note { margin:3px 0 10px }
        .save,.download { border-radius:8px;padding:7px 12px;font-weight:600 }
        .save { background:#3b3d45 }
        footer { border-top:1px solid #404148;margin-top:14px;padding-top:12px;flex-direction:column;align-items:stretch }
        .quality { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px }
        .quality select { background:#17181c;border:1px solid #51525b;border-radius:7px;padding:4px 8px }
        .download { background:#8fe7d9;color:#102820;width:100% }
        .status:not(:empty) { margin-top:7px;overflow-wrap:anywhere }
        .list { list-style:none;margin:0;padding:0;max-height:290px;overflow:auto;overscroll-behavior:contain }
        li { padding:9px 0;border-bottom:1px solid #383940 } li:last-child {border:0}
        a { color:#f5f5f8;text-decoration:none;display:block;overflow-wrap:anywhere } a:hover { text-decoration:underline }
        .meta { margin-top:3px;overflow-wrap:anywhere }
      </style>
      <div class="wrap">
        <button class="launcher" aria-expanded="false" aria-controls="feed-panel"><span class="mark" aria-hidden="true">≋</span>推荐助手</button>
        <section class="panel" id="feed-panel" aria-label="推荐助手" hidden>
          <header tabindex="-1"><span class="mark" aria-hidden="true">≋</span><strong>推荐助手</strong><button class="close" aria-label="收起悬浮窗">×</button></header>
          <nav class="tabs" aria-label="推荐助手视图"><button data-tab="settings">词条</button><button data-tab="inserted">已插入</button><button data-tab="blocked">已屏蔽</button></nav>
          <div class="editor">
            <div class="setting-head"><label for="words">想看的词条</label><small id="pick-mode"></small></div>
            <textarea id="words" rows="2" maxlength="2000" placeholder="露营&#10;手冲咖啡"></textarea>
            <div class="note">一行一个，最多 20 个，每个 30 字。</div>
            <div class="setting-head"><label for="rules">屏蔽词条</label><small id="filter-mode"></small></div>
            <textarea id="rules" rows="3" maxlength="20000" placeholder="一行一条屏蔽规则"></textarea>
            <button class="save">保存词条</button><div class="status" id="save-status" role="status"></div>
          </div>
          <div class="history" hidden><ul class="list"></ul><div class="status" id="history-status" role="status"></div></div>
          <footer><label class="quality">下载清晰度<select id="quality"><option value="auto">自动（最高可用）</option></select></label>
            <div class="note" id="quality-hint" hidden>缺少所选档位时优先选较低档，只有更高档时选其中最低档。</div>
            <label class="quality">下载方式<select id="download-mode"><option value="combined">音画合一（默认）</option></select></label>
            <button class="download">下载当前视频</button><div class="status" id="download-status" role="status"></div></footer>
        </section>
      </div>`;
    const $ = selector => root.querySelector(selector);
    const launcher = $(".launcher"), panel = $(".panel"), words = $("#words"), rules = $("#rules");
    const save = $(".save"), download = $(".download");
    const quality = $("#quality"), downloadMode = $("#download-mode");
    quality.onchange = () => { $("#quality-hint").hidden = quality.value === "auto"; };
    let tab = "settings", base = null, saving = false, disposed = false;
    let historyRequest = 0, historyTimer, progressTimer, drag = null;
    const request = async message => {
      try { return await send(message) || { error: "扩展连接已断开，请刷新抖音页。" }; }
      catch { return { error: "扩展连接已断开，请刷新抖音页。" }; }
    };
    function editState() {
      words.disabled = rules.disabled = !base || saving;
      save.disabled = !base || saving || (words.value === base.words && rules.value === base.rules);
    }
    function showSettings(settings) {
      // 外部设置更新只替换未编辑的字段。
      if (!base || JSON.stringify(settings.downloadQualities) !== JSON.stringify(base.downloadQualities)) {
        const choices = settings.downloadQualities ?? { auto: "自动（最高可用）" };
        const selected = quality.value;
        quality.replaceChildren(...Object.entries(choices).map(([key, label]) => new Option(label, key)));
        quality.value = Object.hasOwn(choices, selected) ? selected : "auto";
        quality.onchange();
      }
      if (!base || words.value === base.words) words.value = settings.words;
      if (!base || JSON.stringify(settings.downloadModes) !== JSON.stringify(base.downloadModes)) {
        const choices = settings.downloadModes ?? { combined: "音画合一（默认）" };
        const selected = downloadMode.value;
        downloadMode.replaceChildren(...Object.entries(choices).map(([key, label]) => new Option(label, key)));
        downloadMode.value = Object.hasOwn(choices, selected) ? selected : "combined";
      }
      if (!base || rules.value === base.rules) rules.value = settings.rules;
      base = settings;
      $("#pick-mode").textContent = settings.webPicks ? "网页插入已开启" : "网页插入已关闭";
      $("#filter-mode").textContent = ({ off:"过滤已关闭", observe:"仅记录命中", hide:"命中时隐藏", dislike:"隐藏并反馈" })[settings.mode];
      editState();
    }
    function onStorage(changes, area) {
      if (area === "local" && changes.settings?.newValue) showSettings(changes.settings.newValue);
    }
    chrome.storage.onChanged.addListener(onStorage);
    async function loadHistory() {
      const sequence = ++historyRequest;
      const value = await request({ type:"panel:history" });
      if (disposed || panel.hidden || sequence !== historyRequest || tab === "settings") return;
      const list = $(".list"), seen = new Set();
      const rows = [];
      for (const event of (value.events ?? []).sort((a,b) => b.t - a.t)) {
        if ((event.action === "inserted") !== (tab === "inserted") || !validId(event.id) || seen.has(event.id)) continue;
        seen.add(event.id);
        const row = document.createElement("li"), link = document.createElement("a"), meta = document.createElement("div");
        link.href = "https://www.douyin.com/video/" + event.id;
        link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = event.desc || "作品 " + event.id;
        meta.className = "meta";
        meta.textContent = [event.author && "@" + event.author, ...(Array.isArray(event.matched) ? event.matched : [])].filter(Boolean).join(" · ");
        row.append(link, meta); rows.push(row);
      }
      list.replaceChildren(...rows);
      $("#history-status").textContent = value.error || value.warning || (rows.length ? "" : tab === "inserted" ? "还没有插入视频。" : "还没有屏蔽视频。");
      historyTimer = setTimeout(loadHistory, 8000);
    }
    function select(next) {
      clearTimeout(historyTimer); ++historyRequest;
      tab = next;
      for (const item of root.querySelectorAll("[data-tab]")) item.setAttribute("aria-pressed", String(item.dataset.tab === tab));
      $(".editor").hidden = tab !== "settings";
      $(".history").hidden = tab === "settings";
      if (tab !== "settings") {
        $(".list").replaceChildren(); $("#history-status").textContent = "正在读取记录…";
        loadHistory();
      }
    }
    function close() {
      clearTimeout(historyTimer);
      panel.hidden = true; launcher.hidden = false;
      launcher.setAttribute("aria-expanded","false"); launcher.focus();
    }
    // 跨 Shadow DOM 的按键若继续冒泡，空格和方向键会同时控制抖音播放器。
    for (const type of ["keydown","keyup","keypress","wheel","click","pointerdown"]) root.addEventListener(type, event => {
      if (type === "keydown" && event.key === "Escape" && !panel.hidden && !event.isComposing) close();
      event.stopPropagation();
    });
    launcher.onclick = async () => {
      launcher.hidden = true; panel.hidden = false; launcher.setAttribute("aria-expanded","true");
      select(tab); $(".close").focus(); fit();
      const value = await request({ type:"panel:settings" });
      if (disposed) return;
      if (value.settings) showSettings(value.settings);
      $("#save-status").textContent = value.error || (value.offline ? "应用离线，打开 DouyinDataReview 后可保存。" : "");
    };
    $(".close").onclick = close;
    for (const item of root.querySelectorAll("[data-tab]")) item.onclick = () => select(item.dataset.tab);
    for (const field of [words,rules]) field.oninput = () => { editState(); $("#save-status").textContent = ""; };
    save.onclick = async event => {
      if (!event.isTrusted || saving || !base) return;
      const change = {};
      if (words.value !== base.words) change.words = words.value;
      if (rules.value !== base.rules) change.rules = rules.value;
      saving = true; editState(); $("#save-status").textContent = "正在保存…";
      const value = await request({ type:"panel:save", ...change });
      saving = false;
      if (value.settings) showSettings(value.settings);
      $("#save-status").textContent = value.error || "已保存，下一批推荐生效。";
      editState();
    };
    async function progress(id) {
      const { job, error } = await request({ type:"panel:progress", id });
      if (disposed) return;
      const status = $("#download-status");
      if (job?.status === "queued" || job?.status === "running") {
        status.textContent = job.status === "queued" ? "已加入下载队列。" : "应用正在下载…";
        progressTimer = setTimeout(() => progress(id), 1500);
      } else {
        status.textContent = job?.status === "complete" ? "已存入视频下载目录 · " + (job.fileNames ?? [job.fileName]).join("、") : job?.error || error || "下载失败。";
        download.disabled = quality.disabled = downloadMode.disabled = false;
      }
    }
    download.onclick = async event => {
      if (!event.isTrusted || download.disabled) return;
      const id = currentVideoId(), status = $("#download-status");
      if (!id) { status.textContent = "未识别到当前视频，请打开作品详情后重试。"; return; }
      download.disabled = quality.disabled = downloadMode.disabled = true; status.textContent = "正在连接应用…";
      const value = await request({ type:"panel:download", id, quality: quality.value, mode: downloadMode.value });
      if (value.job) { progress(value.job.id); return; }
      status.textContent = value.error || "下载未启动。"; download.disabled = quality.disabled = downloadMode.disabled = false;
    };
    function position(left, top) {
      const rect = host.getBoundingClientRect();
      host.style.setProperty("--dyf-left", Math.max(0, Math.min(left, innerWidth - rect.width)) + "px");
      host.style.setProperty("--dyf-top", Math.max(0, Math.min(top, innerHeight - rect.height)) + "px");
      host.style.setProperty("--dyf-right", "auto");
    }
    function fit() { if (host.style.getPropertyValue("--dyf-left")) { const r = host.getBoundingClientRect(); position(r.left,r.top); } }
    const header = $("header");
    header.onpointerdown = event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      header.focus({ preventScroll: true });
      const r = host.getBoundingClientRect();
      drag = [event.clientX-r.left, event.clientY-r.top]; header.setPointerCapture(event.pointerId);
    };
    header.onpointermove = event => { if (drag) position(event.clientX-drag[0], event.clientY-drag[1]); };
    header.onlostpointercapture = () => { drag = null; };
    window.addEventListener("resize", fit);
    document.documentElement.append(host); editState();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => {
      disposed = true; clearTimeout(historyTimer); clearTimeout(progressTimer); observer.disconnect();
      try { chrome.storage.onChanged.removeListener(onStorage); } catch { /* 旧 runtime 已失效 */ }
      window.removeEventListener("resize", fit); host.remove();
    };
  };
})();
