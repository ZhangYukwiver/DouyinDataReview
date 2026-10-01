/*
 * 故事页导出：把当前这一页存成一个双击就能打开的 .html。
 * 页面源码原样留着（动效、翻页都在），数据、共用脚本和本地图片塞进同一个文件；
 * 页面看到 window.__STORY_EXPORT__ 就直接用里面的数据，不再读 localStorage。
 * 封面和头像是抖音的链接，过一阵会失效；字体仍从 Google Fonts 取，离线时退回系统字体。
 */
(function () {
  "use strict";

  // 页面上标了 data-private 的都来自这些字段
  const PRIVATE_TEXT = new Set(["title", "author", "name", "nickname", "both", "sharedOnly", "likedOnly"]);
  const PRIVATE_LINK = new Set(["url", "coverUrl", "avatarUrl"]);
  // 话题词：档案馆当隐私，海报和内容年志开着隐私也照常显示；聊天里的高频词三个页面都当隐私
  const TOPIC_ZONES = new Set(["topics", "topTopic", "lexicon"]);
  const TOPIC_WORDS = new Set(["name", "both", "sharedOnly", "likedOnly"]);
  const SHARED_SCRIPTS = ["story-glide.js", "story-card.js"];

  // 抹成同样长的 ■（和页面上的遮挡一样）。页面还要拿这些词比对、去重（词场连线、配乐去掉榜首），
  // 所以同一个词（按页面的比法：去掉开头的 #、去空格、不分大小写）始终抹成同一串，
  // 字数一样的不同词在后面补看不见的零宽字符区分开。
  function masker() {
    const tags = new Map(), used = new Map();
    return (text) => {
      const key = text.replace(/^#/u, "").trim().toLowerCase();
      let tag = tags.get(key);
      if (tag === undefined) {
        const shape = key.replace(/\S/gu, "■");
        const n = used.get(shape) || 0;
        used.set(shape, n + 1);
        tag = n ? n.toString(2).replace(/0/gu, "\u200b").replace(/1/gu, "\u200c") : "";
        tags.set(key, tag);
      }
      return text.replace(/[^\s#]/gu, "■") + tag;
    };
  }

  // 隐私开着时导出：名字、标题、作者抹掉，封面、头像、链接去掉，文件里就没有原文。
  // 称号（profile）是按习惯生成的说法，不含名字，原样留着。
  function scrub(data, { privateTopics = true } = {}) {
    const mask = masker();
    const walk = (value, key, topicZone) => {
      if (key === "profile") return value;
      if (PRIVATE_LINK.has(key)) return null;
      if (Array.isArray(value)) return value.map((item) => walk(item, key, topicZone));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, k !== "chat" && (topicZone || TOPIC_ZONES.has(k)))]));
      }
      if (typeof value !== "string" || !PRIVATE_TEXT.has(key)) return value;
      return topicZone && !privateTopics && TOPIC_WORDS.has(key) ? value : mask(value);
    };
    return walk(data);
  }

  // 内联进 <script> 时，「</」会提前结束标签，行分隔符在老引擎里是语法错误
  const inlineJson = (value) => JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  const inlineCode = (code) => code.replace(/<\/script/giu, "<\\/script");

  // 替换都用函数形式：数据和脚本里的 $& $$ 之类不能被当成替换模式
  function build(source, { data, privacy, assets, scripts }) {
    let html = source.replace(/<script src="story-export\.js"><\/script>\n?/u, () => "");
    for (const [name, code] of Object.entries(scripts)) html = html.replace(`<script src="${name}"></script>`, () => `<script>${inlineCode(code)}</script>`);
    const payload = `<script>window.__STORY_EXPORT__ = ${inlineJson({ data, privacy, assets })};</script>`;
    return html.replace(/<head[^>]*>/iu, (head) => `${head}\n${payload}`);
  }

  async function fetchOk(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${url} → ${response.status}`);
    return response;
  }
  const asDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  async function save({ data, privacy = false, privateTopics = true, images = [], fileName }) {
    const source = await (await fetchOk(location.pathname)).text();
    const scripts = {};
    for (const name of SHARED_SCRIPTS) {
      if (source.includes(`<script src="${name}"></script>`)) scripts[name] = await (await fetchOk(name)).text();
    }
    const assets = {};
    for (const name of images) assets[name] = await asDataUrl(await (await fetchOk(`story-images/${name}.jpg`)).blob());
    const html = build(source, { data: privacy ? scrub(data, { privateTopics }) : data, privacy, assets, scripts });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // 导航上的「导出」：点的那一刻才读隐私开关，所以 options 是个函数
  function wire(button, options) {
    const label = button.textContent;
    button.hidden = false;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "导出中…";
      try {
        await save(options());
        button.textContent = label;
      } catch (error) {
        console.error("[StoryExport]", error);
        button.textContent = "导出失败";
        setTimeout(() => { button.textContent = label; }, 2400);
      } finally {
        button.disabled = false;
      }
    });
  }

  window.StoryExport = { build, scrub, save, wire };
})();
