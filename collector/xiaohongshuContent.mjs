import { BrowserConnectionError } from "./browserConnection.mjs";

export const site = "https://www.xiaohongshu.com";
const edith = "https://edith.xiaohongshu.com";
const searchEndpoints = new Set([
  edith + "/api/sns/web/v1/search/notes",
  "https://so.xiaohongshu.com/api/sns/web/v2/search/notes",
]);
const notePath = /^\/(?:explore|discovery\/item|search_result(?:_ai)?|user\/profile\/[\w-]+)\/([a-f\d]{24})\/?$/iu;
const userPath = /^\/user\/profile\/([a-f\d]{24})\/?$/iu;

export function upstreamError(message) {
  return new BrowserConnectionError("xiaohongshu_read_failed", message, 502);
}

function invalid(message) {
  throw new BrowserConnectionError("invalid_request", message, 400);
}

export function noteLink(id, token, source) {
  const link = new URL("/explore/" + id, site);
  if (token) {
    link.searchParams.set("xsec_token", token);
    link.searchParams.set("xsec_source", source);
  }
  return link.href;
}

function parseTarget(value, profile) {
  let url;
  try { url = new URL(value); } catch { /* 统一返回参数错误 */ }
  const id = (profile ? userPath : notePath).exec(url?.pathname)?.[1];
  if (!url || !id || url.origin !== site || url.username || url.password) {
    invalid(profile ? "请传入小红书用户主页的完整链接。" : "请传入小红书笔记的完整网页链接。");
  }
  const link = new URL(profile ? "/user/profile/" + id : "/explore/" + id, site);
  for (const key of ["xsec_token", "xsec_source"]) {
    if (url.searchParams.has(key)) link.searchParams.set(key, url.searchParams.get(key));
  }
  return { id, url: link.href };
}

export function contentOptions(action, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("请求体应为 JSON 对象。");
  if (action === "search") {
    const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) invalid("请输入笔记搜索关键词 keyword。");
    return { keyword };
  }
  if (action === "detail" || action === "comments") return parseTarget(body.url, false);
  if (action === "profile") return body.url === undefined ? {} : parseTarget(body.url, true);
  if (action === "feed") return {};
  invalid("未知的小红书读取操作。");
}

async function readResponse(page, matches, navigate, label) {
  // 先订阅，再执行网页动作，以便读到当前查询对应的第一批数据。
  const [response] = await Promise.all([
    page.waitForResponse(response => matches(new URL(response.url()), response.request()), { timeout: 20_000 }),
    navigate(),
  ]).catch(() => { throw upstreamError(`未收到${label}，请检查小红书页面是否可访问。`); });
  const result = await response.json().catch(() => null);
  if (!response.ok() || result?.code !== 0 || result.success !== true || !result.data) {
    throw upstreamError(`小红书没有返回有效的${label}（HTTP ${response.status()}）。`);
  }
  return result.data;
}

function card(raw, id, token, source) {
  if (typeof id !== "string" || !id) throw upstreamError("小红书笔记列表缺少笔记 ID。");
  const user = raw.user;
  const userId = user?.user_id ?? user?.userId;
  let authorUrl = null;
  if (userId) {
    const url = new URL("/user/profile/" + userId, site);
    const authorToken = user.xsec_token ?? user.xsecToken;
    if (authorToken) {
      url.searchParams.set("xsec_token", authorToken);
      url.searchParams.set("xsec_source", source);
    }
    authorUrl = url.href;
  }
  return { note_id: id, title: raw.display_title ?? raw.displayTitle ?? "", type: raw.type ?? null,
    author: user?.nickname ?? user?.nick_name ?? user?.nickName ?? null, author_url: authorUrl,
    cover: raw.cover?.url_default ?? raw.cover?.urlDefault ?? raw.cover?.url_pre ?? raw.cover?.urlPre ?? null,
    liked_count: raw.interact_info?.liked_count ?? raw.interactInfo?.likedCount ?? null, url: noteLink(id, token, source) };
}

async function publishedNotes(page, userId, navigate) {
  const network = readResponse(page, url => url.origin === edith && url.pathname === "/api/sns/web/v1/user_posted"
    && url.searchParams.get("user_id") === userId && !url.searchParams.get("cursor"), navigate, "用户发布的笔记")
    .then(data => {
      if (!Array.isArray(data.notes)) throw upstreamError("小红书主页响应缺少笔记列表。");
      return { has_more: data.has_more, notes: data.notes.map(n => card(n, n.note_id, n.xsec_token, "pc_user")) };
    });
  // 公开主页有时随 HTML 下发第一批笔记，浏览器首次请求 user_posted 时已经是第二页。
  const rendered = page.waitForFunction(id => {
    if (location.pathname.replace(/\/$/, "") !== "/user/profile/" + id) return false;
    const state = window.__INITIAL_STATE__?.user;
    const unwrap = value => value?.value ?? value?._value ?? value;
    const query = unwrap(state?.noteQueries)?.[0];
    const notes = unwrap(state?.notes)?.[0];
    if (query?.userId !== id || typeof query.hasMore !== "boolean" || !Array.isArray(notes)) return false;
    if (!notes.length && (query.hasMore || unwrap(state?.userNoteFetchingStatus)?.[0] !== "success")) return false;
    return { more: query.hasMore, items: notes.map(n => ({ id: n.id, token: n.xsecToken, note: {
      type: n.noteCard.type, displayTitle: n.noteCard.displayTitle, user: n.noteCard.user, interactInfo: n.noteCard.interactInfo, cover: n.noteCard.cover,
    } })) };
  }, userId, { timeout: 20_000 }).then(async handle => {
    try {
      const data = await handle.jsonValue();
      return { has_more: data.more, notes: data.items.map(n => card(n.note, n.id, n.token, "pc_user")) };
    } finally { await handle.dispose(); }
  });
  return Promise.any([network, rendered]).catch(error => { throw error.errors[0]; });
}

async function homeFeed(page) {
  // 首屏推荐可以由服务端直接渲染。读取当前首页的卡片可保留用户看到的顺序。
  await page.locator(".note-item a.cover[href]").first().waitFor({ timeout: 15_000 });
  const cards = await page.locator(".note-item").evaluateAll(elements => elements.flatMap(element => {
    const cover = element.querySelector("a.cover[href]");
    if (!cover) return [];
    const author = element.querySelector("a.author");
    return [{ href: cover.href, title: element.querySelector(".title")?.innerText ?? "", cover: cover.querySelector("img")?.src ?? null,
      author: author?.querySelector(".name")?.innerText ?? author?.innerText ?? null,
      author_url: author?.href ?? null, liked_count: element.querySelector(".like-wrapper .count")?.innerText ?? null }];
  }));
  const notes = [];
  for (const entry of cards) {
    const link = new URL(entry.href);
    const id = notePath.exec(link.pathname)?.[1];
    if (link.origin === site && id) notes.push({ note_id: id, title: entry.title, author: entry.author,
      author_url: entry.author_url, liked_count: entry.liked_count, cover: entry.cover, url: entry.href });
  }
  if (!notes.length) throw upstreamError("首页没有可识别的推荐笔记。");
  return { notes };
}

export async function readNoteDetail(page, target) {
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const container = page.locator(".note-container").first();
  await container.locator("#detail-title, #detail-desc").first().waitFor({ timeout: 10_000 });
  const current = new URL(page.url());
  if (current.origin !== site || !current.pathname.endsWith("/" + target.id)) throw upstreamError("未能打开指定笔记。");
  const detail = await container.evaluate((element, id) => {
    const author = element.querySelector(".author-wrapper a.name");
    // 互动栏的选择器对不上时，用页面首屏数据里的 interactInfo
    const unwrap = value => value?.value ?? value?._value ?? value;
    const info = unwrap(window.__INITIAL_STATE__?.note?.noteDetailMap)?.[id]?.note?.interactInfo ?? {};
    const count = (selector, key) => element.querySelector(".interact-container " + selector + " .count")?.innerText ?? info[key] ?? null;
    return { title: element.querySelector("#detail-title")?.innerText ?? "",
      body: element.querySelector("#detail-desc")?.innerText ?? "", author: author?.innerText ?? null,
      author_url: author?.href ?? null, liked_count: count(".like-wrapper", "likedCount"),
      collected_count: count(".collect-wrapper", "collectedCount"), comment_count: count(".chat-wrapper", "commentCount") };
  }, target.id);
  return { note_id: target.id, url: target.url, ...detail };
}

export async function readContent(action, options, { page, me, uid }) {
  if (action === "feed") return homeFeed(page);
  if (action === "detail") return readNoteDetail(page, options);
  if (action === "search") {
    const input = page.locator("#search-input:visible, #search-input-ai:visible, #search-input-in-feeds:visible").first();
    const data = await readResponse(page, (url, request) => {
      if (request.method() !== "POST" || !searchEndpoints.has(url.origin + url.pathname)) return false;
      const query = request.postDataJSON();
      return query?.keyword === options.keyword && Number(query.page) === 1;
    }, async () => { await input.fill(options.keyword); await input.press("Enter"); }, "笔记搜索结果");
    if (!Array.isArray(data.items)) throw upstreamError("小红书搜索结果缺少列表。");
    return { keyword: options.keyword, has_more: data.has_more,
      notes: data.items.filter(item => item.model_type === "note" && item.note_card)
        .map(item => card(item.note_card, item.id, item.xsec_token, "pc_search")) };
  }
  if (action === "comments") {
    const data = await readResponse(page, url => url.origin === edith && url.pathname === "/api/sns/web/v2/comment/page"
      && url.searchParams.get("note_id") === options.id && !url.searchParams.get("cursor"),
    () => page.goto(options.url, { waitUntil: "domcontentloaded" }), "笔记评论");
    if (!Array.isArray(data.comments)) throw upstreamError("小红书评论响应缺少列表。");
    return { note_id: options.id, has_more: data.has_more, comments: data.comments.map(item => ({
      comment_id: item.id, content: item.content, author: item.user_info?.nickname,
      liked_count: item.like_count, create_time: item.create_time, reply_count: item.sub_comment_count,
    })) };
  }
  const userId = options.id ?? uid;
  const published = await publishedNotes(page, userId,
    () => options.url ? page.goto(options.url, { waitUntil: "domcontentloaded" }) : me.click());
  const info = page.locator(".user-page .user-info").first();
  await info.locator(".user-name").waitFor();
  const user = await info.evaluate(element => ({
    nickname: element.querySelector(".user-name").innerText, description: element.querySelector(".user-desc")?.innerText ?? "",
    stats: Array.from(element.querySelectorAll(".user-interactions .shows"), label => ({
      label: label.innerText, value: label.parentElement.querySelector(".count")?.innerText ?? null })),
  }));
  return { user_id: userId, ...user, ...published };
}
