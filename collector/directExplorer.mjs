import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DouyinExplorer, ExploreError, validateExploreRequest, ingestExploreResponse, ingestExploreReplies, normalizeExploreComment, normalizeExploreVideo, playableAweme } from "./explorer.mjs";
import { directWrite } from "./directWrites.mjs";
import "../extension/filter.js";

// 屏蔽词条的匹配和浏览器扩展共用一份，filter.js 挂在 globalThis.DYF 上
const { compileRules, fieldsOf, filterFeed, match } = globalThis.DYF;
const hitsRules = (session, aweme) => match(session.rules, fieldsOf(aweme)).score >= 1;
const ROUTES = { users: "/aweme/v1/web/discover/search/", videos: "/aweme/v1/web/search/item/",
  profile: "/aweme/v1/web/aweme/post/", detail: "/aweme/v1/web/aweme/detail/", comments: "/aweme/v1/web/comment/list/",
  feed: "/aweme/v1/web/tab/feed/" };
const hasMore = (value) => [true, 1, "1"].includes(value) ? true : [false, 0, "0"].includes(value) ? false : null;
// 推荐没有游标，按网页的做法每刷一屏 refresh_index 加一
const cursorOf = (payload, kind, cursor) => kind === "feed" ? String(Number(cursor) + 1) : String(payload[kind === "profile" ? "max_cursor" : "cursor"] ?? "");
const searchQuery = (channel, keyword, offset, count, searchId) => ({ search_channel: channel, keyword, search_source: "switch_tab", query_correct_type: "1",
  is_filter_search: "0", from_group_id: "", disable_rs: "0", offset, count, need_filter_settings: "0", list_type: "single", ...(searchId ? { search_id: searchId } : {}) });

// 抖音翻到后面会整页塞推荐里的视频（网页上一样：「露营」第 36 条起全是我的世界、三角洲），接口不做任何标记，只能按内容认。
// ponytail: 按字面认，连着三个以上的汉字拆成两两一组，整页没一条沾边才算跑偏；靠字幕/语义匹配的整页结果会被误停，真遇到再加字段
const termsOf = (query) => (query.toLowerCase().match(/\p{Script=Han}+|[^\p{Script=Han}\s\p{P}\p{S}]+/gu) ?? [])
  .flatMap((run) => /\p{Script=Han}{3}/u.test(run) ? Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)) : [run]);
export function offTopic(query, raws) {
  const terms = termsOf(query);
  return raws.length >= 3 && terms.length > 0 && !raws.some((raw) => {
    const text = [raw?.desc, raw?.nickname, raw?.unique_id, raw?.signature, raw?.author?.nickname, raw?.music?.title].join(" ").toLowerCase().replace(/\s+/gu, "");
    return terms.some((term) => text.includes(term));
  });
}
const searchRaws = (kind, payload) => (kind === "users" ? payload?.user_list?.map((entry) => entry.user_info ?? entry)
  : payload?.data?.flatMap((entry) => entry.aweme_info ? [entry.aweme_info] : entry.aweme_list ?? [])) ?? [];

// 想看的词条混进推荐：每 pickEvery 条推荐（设置里选，默认 3）后面插一条词条搜出来的视频，词条轮着来、各翻各的页；
// pickEvery 为 0 是只看词条：整批推荐换成词条视频，一条都没搜到才照常给推荐。
// ponytail: 一批只搜一轮（和推荐请求同时发，接下来四轮要用的词里队列空了的各搜一页），搜不到就少插几条，下一批再补
const PICK_AHEAD = 4, PICK_RETRY_MS = 5 * 60_000;
const pickState = (session, word) => {
  if (!session.picks.has(word)) {
    // 上次翻到哪、推过哪些接着用，不然搜索第一页每次都一样，每次打开推的都是同一批
    const saved = session.pickHistory[word];
    session.picks.set(word, { offset: 0, resumeAt: saved?.offset ?? 0, shown: new Set(saved?.ids), searchId: null, hasMore: true, retryAt: 0, queue: [] });
  }
  return session.picks.get(word);
};
export async function searchWord(api, session, word, state, signal) {
  try {
    const payload = await api.request(ROUTES.videos, { query: searchQuery("aweme_video_web", word, String(state.offset), "10", state.searchId),
      referer: "https://www.douyin.com/search/", signal });
    // 要验证或报错就先歇几分钟，别每批都去撞
    if (payload?.status_code !== 0 || !Array.isArray(payload.data)
      || [payload.search_nil_info?.search_nil_type, payload.search_nil_info?.search_nil_item].includes("verify_check")) { state.retryAt = Date.now() + PICK_RETRY_MS; return; }
    // 翻到抖音开始塞推荐了就当这个词搜到底，别把不相干的标成「来自词条」插进去
    if (state.offset && offTopic(word, searchRaws("videos", payload))) { state.hasMore = false; return; }
    const found = searchRaws("videos", payload).filter(playableAweme);
    const kept = found.filter((aweme) => !hitsRules(session, aweme));
    // 排队时留原始数据：词条改了，插入前还要再查一遍
    state.queue.push(...kept.filter((aweme) => !state.shown?.has(String(aweme.aweme_id))));
    // 整页都命中屏蔽词条也歇一会，和网页一样，别每批都去搜
    if (found.length && !kept.length) state.retryAt = Date.now() + PICK_RETRY_MS;
    const next = Number(payload.cursor);
    state.hasMore = hasMore(payload.has_more) === true && Number.isSafeInteger(next) && next > state.offset;
    // 第一页照常搜（拿新的 search_id，实测不带它直接翻页被要求过验证），下一页跳回上次的位置
    if (state.hasMore) state.offset = Math.max(next, state.resumeAt ?? 0);
    state.searchId ??= payload.log_pb?.impr_id;
  } catch {
    signal?.throwIfAborted();
    state.retryAt = Date.now() + PICK_RETRY_MS;
  }
}
// 第一页常常全是推过的，这时再搜一页（已经跳回上次的位置），别让这一批插不上
async function searchUnseen(api, session, word, state, signal) {
  await searchWord(api, session, word, state, signal);
  if (!state.queue.length && state.hasMore && state.retryAt <= Date.now()) await searchWord(api, session, word, state, signal);
}
function searchAhead(api, session, signal) {
  const turn = session.pickTurn ?? 0;
  // 一批推荐 10 条，插得密时要用的词更多，也得提前搜到；只看词条时剩得不够一批就接着搜
  const every = session.pickEvery, low = every ? 1 : 10;
  const words = new Set(Array.from({ length: Math.max(PICK_AHEAD, Math.ceil(10 / (every || 1))) }, (_, index) => session.words[(turn + index) % session.words.length]));
  return Promise.all([...words].map((word) => [word, pickState(session, word)])
    .filter(([, state]) => state.queue.length < low && state.hasMore && state.retryAt <= Date.now()).map(([word, state]) => searchUnseen(api, session, word, state, signal)));
}
async function mixWords(session, known, ahead) {
  await ahead;
  const fresh = [...session.items.values()].filter((item) => !known.has(item.id));
  // 首屏常只有一两条、或整批都是直播广告，也插一条
  const every = session.pickEvery, wanted = Math.max(1, every ? Math.ceil(fresh.length / every) : fresh.length), turn = session.pickTurn ?? 0;
  const order = Array.from({ length: wanted }, (_, index) => session.words[(turn + index) % session.words.length]);
  session.pickTurn = (turn + wanted) % session.words.length;
  // 只看词条时这批推荐会整批换掉，撞上这批的候选要留下，不然两头都没了
  const taken = every ? session.items : known;
  const picks = [];
  for (const word of order) {
    const state = pickState(session, word), queue = state.queue;
    while (queue.length) {
      const aweme = queue.shift(), item = normalizeExploreVideo(aweme);
      if (item && !hitsRules(session, aweme) && !taken.has(item.id) && !picks.some((pick) => pick.id === item.id)) { picks.push({ ...item, pickedFor: word }); state.shown.add(String(aweme.aweme_id)); break; }
    }
  }
  if (!picks.length) return;
  for (const item of fresh) session.items.delete(item.id);
  if (!every) { for (const pick of picks) session.items.set(pick.id, pick); return; }
  fresh.forEach((item, index) => {
    session.items.set(item.id, item);
    if (index % every === every - 1 && picks.length) { const pick = picks.shift(); session.items.set(pick.id, pick); }
  });
  for (const pick of picks) session.items.set(pick.id, pick);
}

// 这批没轮到的词原样留着；搜到底的词不留，下次从头来，只有这时才会重复
function pickHistoryOf(session) {
  return Object.fromEntries(session.words.flatMap((word) => {
    const state = session.picks.get(word), saved = session.pickHistory[word];
    if (!state) return saved ? [[word, saved]] : [];
    return state.hasMore ? [[word, { offset: Math.max(state.offset, state.resumeAt), ids: [...state.shown] }]] : [];
  }));
}

// Reuse the existing response normalizers and API contracts for HTTP reads and
// writes. Credential bootstrap belongs to the collector's login session.
/** 播放器离开一条时报的：看到第几毫秒、多长、看没看完 */
function watchedItem(value) {
  const awemeId = String(value?.awemeId ?? ""), { durationMs, positionMs, finished } = value ?? {};
  return /^\d{5,30}$/u.test(awemeId) && Number.isSafeInteger(durationMs) && durationMs > 0 && Number.isSafeInteger(positionMs)
    && positionMs >= 0 && typeof finished === "boolean" ? { awemeId, durationMs, positionMs: Math.min(positionMs, durationMs), finished } : false;
}

export class DirectExplorer extends DouyinExplorer {
  constructor(getContext, getApi, getChat) { super(getContext); this.getApi = getApi; this.getChat = getChat; }
  async read(input, { signal } = {}) {
    if (input?.kind === "sharees") return this.readDirectSharees(input, signal);
    const validated = validateExploreRequest(input);
    signal?.throwIfAborted();
    if (validated.kind === "replies") return this.readDirectReplies({ ...validated, sessionId: input.sessionId }, signal);
    const previous = input.sessionId ? this.sessions.get(input.sessionId) : null;
    if (input.sessionId && (!previous || !previous.direct || previous.kind !== validated.kind || previous.id !== validated.id || previous.query !== validated.query))
      throw new ExploreError("session_expired", "此页面已过期，请重新搜索或打开。", 410);
    if (previous && (previous.hasMore === false || previous.items.size >= 500)) return this.snapshot(previous);
    const session = previous ? { ...previous, items: new Map(previous.items), cursors: new Set(previous.cursors) }
      : { ...validated, key: randomUUID(), direct: true, items: new Map(), hasMore: null, received: false, revision: 0, cursor: "0", cursors: new Set() };
    // 词条每批跟着请求来，设置里改了下一批就用新的；各词翻到哪页留着
    if (session.kind === "feed") Object.assign(session, { words: validated.words, pickEvery: validated.pickEvery, rules: compileRules(input.rules), pickHistory: input.pickHistory ?? {},
      picks: new Map([...(previous?.picks ?? [])].map(([word, state]) => [word, { ...state, queue: [...state.queue], shown: new Set(state.shown) }])) });
    if (session.cursors.has(session.cursor)) throw new ExploreError("pagination_stalled", "分页游标重复，已加载的内容仍保留。");
    const api = await this.getApi({ signal });
    signal?.throwIfAborted();
    let query;
    switch (session.kind) {
      case "users": case "videos": query = searchQuery(session.kind === "users" ? "aweme_user_web" : "aweme_video_web", session.query, session.cursor, "20", session.searchId); break;
      case "profile": query = { sec_user_id: session.id, max_cursor: session.cursor, count: "18", publish_video_strategy_type: "2" }; break;
      case "detail": query = { aweme_id: session.id }; break;
      case "comments": query = { aweme_id: session.id, cursor: session.cursor, count: "20", item_type: "0" }; break;
      case "feed": query = { count: "10", refresh_index: String(Number(session.cursor) + 1), pull_type: session.cursor === "0" ? "0" : "2",
        video_type_select: "1", aweme_pc_rec_raw_data: JSON.stringify({ is_client: false }) }; break;
    }
    const pathname = ROUTES[session.kind];
    const referer = session.kind === "profile" ? `https://www.douyin.com/user/${session.id}`
      : ["detail", "comments"].includes(session.kind) ? `https://www.douyin.com/video/${session.id}`
      : session.kind === "feed" ? "https://www.douyin.com/?recommend=1" : "https://www.douyin.com/search/";
    const ahead = session.kind === "feed" && session.words.length ? searchAhead(api, session, signal) : null;
    ahead?.catch(() => {});
    const reads = [api.request(pathname, { query, referer, signal })];
    if (session.kind === "profile" && !session.profile) reads.push(api.request("/aweme/v1/web/user/profile/other/", { query: { sec_user_id: session.id }, referer, signal }));
    const results = await Promise.allSettled(reads);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const payload = results[0].value;
    if (results[1]) {
      ingestExploreResponse(session, "/aweme/v1/web/user/profile/other/", results[1].value);
      if (session.profile) session.profile.self = session.id === api.secUid || (api.session?.uid && String(results[1].value.user?.uid) === api.session.uid) || false;
    }
    // 屏蔽词条：「只记录」不动推荐；「隐藏并反馈」在这里只隐藏，替用户点不感兴趣这个写操作只有扩展在做
    const hide = input.mode === "hide" || input.mode === "dislike";
    const hits = session.kind === "feed" && (hide || input.mode === "observe") ? filterFeed(payload, session.rules, hide) : [];
    const known = new Set(session.items.keys());
    if (["users", "videos"].includes(session.kind) && session.items.size && offTopic(session.query, searchRaws(session.kind, payload))) {
      Object.assign(session, { hasMore: false, offTopic: true });
      this.sessions.set(session.key, session);
      return { ...this.snapshot(session), offTopic: true };
    }
    ingestExploreResponse(session, pathname, payload);
    if (session.error) throw session.error;
    if (!session.received || (session.kind === "profile" && !session.profile) || (session.kind === "detail" && !session.video))
      throw new ExploreError("schema_changed", "接口数据不完整，已加载的内容仍保留。");
    const more = session.kind === "detail" ? false : hasMore(payload.has_more);
    const next = cursorOf(payload, session.kind, session.cursor);
    if (more === null || (more && (!/^\d{1,20}$/u.test(next) || next === session.cursor)))
      throw new ExploreError("pagination_stalled", "接口未返回有效分页，已加载的内容仍保留。");
    signal?.throwIfAborted();
    session.cursors.add(session.cursor); session.cursor = next; session.hasMore = more;
    // 照网页来：翻页一直带第一页的 search_id，不换成每页新的 impr_id
    session.searchId ??= payload.log_pb?.impr_id;
    if (ahead) await mixWords(session, known, ahead);
    this.sessions.set(session.key, session);
    if (this.sessions.size > 6) {
      const oldest = this.sessions.values().next().value; this.sessions.delete(oldest.key);
      await oldest.page?.close().catch(() => {});
    }
    // filtered 由 server 记进处置记录、pickHistory 由 server 存盘，都不发给页面
    return { ...this.snapshot(session), ...(ahead ? { pickHistory: pickHistoryOf(session) } : {}), ...(hits.length ? { filtered: hits.map((hit) => ({ ...hit, t: Date.now(), action: hide || hit.isAd ? "hidden" : "observed" })) } : {}) };
  }
  async readDirectSharees(input, signal) {
    const validated = validateExploreRequest(input);
    const previous = input.sessionId ? this.sessions.get(input.sessionId) : null;
    if (input.sessionId && (!previous?.direct || previous.kind !== "sharees" || previous.id !== validated.id))
      throw new ExploreError("session_expired", "分享名单已过期，请重新打开。", 410);
    const chat = await this.getChat?.({ signal });
    if (!chat) throw new ExploreError("not_receiving", "请先初始化聊天会话再打开分享名单。");
    const session = previous || { ...validated, direct: true, key: randomUUID(), items: new Map(), hasMore: false, profile: null, video: null };
    const own = chat.api.session.uid;
    const previousItems = session.items;
    session.shareTargets = new Map(); session.items = new Map();
    for (const conversation of chat.conversations.values()) {
      const id = conversation.type === 1 ? conversation.id.split(":").findLast(value=>/^\d+$/u.test(value)&&value!==own) : conversation.shortId;
      if (!id || id === own) continue;
      session.shareTargets.set(id, conversation.id);
      session.items.set(id, { id, name: conversation.name || (conversation.type === 2 ? "群聊" : "抖音用户"), avatar: conversation.avatarUrl || null,
        group: conversation.type === 2, shared: previousItems.get(id)?.shared === true });
    }
    this.sessions.set(session.key, session);
    if (this.sessions.size > 6) this.sessions.delete(this.sessions.keys().next().value);
    return this.snapshot(session);
  }
  /** 在工作台里刷到的视频写进抖音观看历史，和网页进入一条视频时一样 */
  // 和网页切下一条时一样：刚离开的那条是长视频就先存续播点，再记进入的这条，顺带说上一条看没看完。
  // 关掉播放器时没有下一条，只存续播点。
  async seen(input) {
    const awemeId = input?.awemeId == null ? null : String(input.awemeId), authorId = String(input?.authorId ?? "");
    const previous = input?.previous == null ? null : watchedItem(input.previous);
    if (previous === false || (awemeId === null ? !previous : !/^\d{5,30}$/u.test(awemeId) || !/^\d{1,30}$/u.test(authorId)))
      throw new ExploreError("invalid_request", "作品或作者标识无效。", 400);
    const api = await this.getApi({ security: true });
    // ponytail: 网页实测只给几分钟以上的长视频存续播点，三分钟是按抖音历史里出现续播点的最短时长定的
    if (previous && previous.durationMs >= 180_000) await directWrite(api, "progress", previous).catch(() => null);
    if (!awemeId) return { ok: true };
    const acknowledgement = await directWrite(api, "history", { awemeId, authorId, preItemId: previous?.awemeId, preItemSeen: previous?.finished });
    if (acknowledgement.status_code !== 0) throw new ExploreError("platform_rejected", "抖音没有记下这条观看记录。");
    return { ok: true };
  }
  /** 播放器里的点赞 / 收藏、创作者中心里的评论 / 回复：只发一个写请求，不开详情会话、不先读后读；抖音回执成功就算数 */
  async react(input) {
    const awemeId = String(input?.awemeId ?? "");
    const comment = input?.action === "comment";
    if (!/^\d{5,30}$/u.test(awemeId) || !["like", "collect", "comment"].includes(input?.action) || (!comment && typeof input?.desired !== "boolean"))
      throw new ExploreError("invalid_request", "点赞或收藏请求无效。", 400);
    const text = comment && typeof input.text === "string" ? input.text.replace(/\s+/gu, " ").trim() : "";
    if (comment && (!text || text.length > 500)) throw new ExploreError("invalid_request", "评论需为 1–500 字。", 400);
    const api = await this.getApi({ security: true });
    let dispatched = false;
    try {
      const acknowledgement = await directWrite(api, input.action, comment ? { awemeId, text, replyTo: input.replyTo, replyToReply: input.replyToReply }
        : { awemeId, desired: input.desired }, { onDispatch: () => { dispatched = true; } });
      if (acknowledgement.status_code === 8) throw new ExploreError("login_required", "抖音登录已失效，请在登录窗口重新登录后再试。");
      if (acknowledgement.status_code !== 0) throw new ExploreError("platform_rejected", "抖音没有接收这次操作，请稍后再试。");
      if (comment) {
        const posted = normalizeExploreComment(acknowledgement.comment);
        return posted?.id && posted.text === text ? { outcome: "confirmed", message: input.replyTo ? "回复已发送" : "评论已发送", comment: posted }
          : { outcome: "unknown", message: "没等到抖音的确认，刷新评论看看再决定要不要重发。" };
      }
    } catch (error) {
      // 已经发出去却没拿到回执：可能成了也可能没成，不能当失败退回
      if (dispatched && !(error instanceof ExploreError)) return { outcome: "unknown", message: "结果没确认，稍后在抖音里看一眼。" };
      throw error;
    }
    const label = input.action === "like" ? "点赞" : "收藏";
    return { outcome: "confirmed", value: input.desired, message: input.desired ? `已${label}` : `已取消${label}` };
  }
  async readDirectReplies({ sessionId, id, commentId }, signal) {
    const session = this.sessions.get(sessionId);
    if (!session?.direct || session.kind !== "comments" || session.id !== id || !session.items.has(commentId))
      throw new ExploreError("session_expired", "请从已加载的评论展开回复。", 410);
    session.replyThreads ??= new Map();
    const previous = session.replyThreads.get(commentId);
    const thread = previous ? { ...previous, items: new Map(previous.items), cursors: new Set(previous.cursors) }
      : { items: new Map(), hasMore: null, received: false, revision: 0, cursor: "0", cursors: new Set() };
    const snapshot = () => ({ sessionId, kind: "replies", commentId, items: [...thread.items.values()], profile: null, video: null, hasMore: thread.hasMore, limited: thread.items.size >= 500 });
    if (thread.hasMore === false || thread.items.size >= 500) return snapshot();
    if (thread.cursors.has(thread.cursor)) throw new ExploreError("pagination_stalled", "回复分页游标重复。");
    const api = await this.getApi({ signal });
    // 和网页一样先露 3 条；之后每点一次「展开更多」要 10 条，少点几次（每次都要起一回签名器，1~2 秒）
    const payload = await api.request("/aweme/v1/web/comment/list/reply/", { query: { item_id: id, comment_id: commentId,
      cut_version: "1", cursor: thread.cursor, count: thread.cursor === "0" ? "3" : "10", item_type: "0" }, referer: `https://www.douyin.com/video/${id}`, signal });
    const more = hasMore(payload.has_more), next = String(payload.cursor ?? "");
    if (more === null || (more && (!/^\d{1,20}$/u.test(next) || next === thread.cursor))) throw new ExploreError("pagination_stalled", "回复接口未返回有效分页。");
    const staged = { ...session, replyThreads: new Map(session.replyThreads) }; staged.replyThreads.set(commentId, thread);
    ingestExploreReplies(staged, commentId, payload);
    if (thread.error) throw thread.error;
    signal?.throwIfAborted();
    thread.cursors.add(thread.cursor); thread.cursor = next; thread.hasMore = more;
    session.replyThreads.set(commentId, thread);
    return snapshot();
  }
  async interact(input) {
    const session = this.sessions.get(input?.sessionId);
    if (!/^[\w-]{16,80}$/u.test(input?.requestId ?? "") || !["like", "collect", "follow", "comment", "share"].includes(input?.action))
      throw new ExploreError("invalid_request", "互动请求无效。", 400);
    const fingerprint = JSON.stringify([input.sessionId, input.action, input.desired, input.text, input.replyTo, input.targetId]);
    const previous = this.actions.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ExploreError("invalid_request", "请重新确认本次操作。", 400);
      return previous.promise || previous.result;
    }
    if (!session?.direct) throw new ExploreError("session_expired", "请重新打开作品或用户资料。", 410);
    const kinds = { follow: ["profile"], comment: ["detail", "comments"], share: ["sharees"] }[input.action] || ["detail"];
    if (!kinds.includes(session.kind)) throw new ExploreError("invalid_request", "操作与当前页面不匹配。", 400);
    const content = typeof input.text === "string" ? input.text.replace(/\s+/gu, " ").trim() : "";
    if (input.action === "comment" ? !content || content.length > 500 || (input.replyTo != null && !/^\d{5,30}$/u.test(input.replyTo))
      : input.action === "share" ? !session.shareTargets?.has(input.targetId) : typeof input.desired !== "boolean")
      throw new ExploreError("invalid_request", "评论或目标状态无效。", 400);
    // 回复对象：读到的评论、展开过的回复，或者在这个评论区刚发出去的那几条
    if (input.replyTo && !session.items.has(input.replyTo) && !session.posted?.has(input.replyTo)
      && ![...(session.replyThreads?.values() || [])].some(t=>t.items.has(input.replyTo)))
      throw new ExploreError("comment_unavailable", "请从已加载的评论选择回复对象。");
    if (this.actions.size >= 1_000) throw new ExploreError("action_limit", "本次会话操作数量已达上限，请重启采集器。");
    const action = { fingerprint, result: { outcome: "unknown", message: "操作结果尚未确认，请查看抖音后再决定是否重试。" } };
    let resolve, reject;
    action.promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    action.promise.catch(()=>{});
    this.actions.set(input.requestId, action);
    let dispatched = false;
    try {
      const api = await this.getApi({ security: true });
      if (input.action === "share") {
        const chat = await this.getChat();
        const detail = (await api.request(ROUTES.detail, { query: { aweme_id: session.id } })).aweme_detail;
        if (!detail || String(detail.aweme_id) !== session.id) throw new ExploreError("schema_changed", "作品资料不完整，请重新打开后再分享。");
        const cover = detail.video?.cover || detail.images?.[0] || {};
        const card = { aweType: 800, awemeType: detail.aweme_type || 0, itemId: session.id, content_title: detail.desc || "",
          content_name: detail.author?.nickname || "", uid: api.session.uid, secUID: detail.author?.sec_uid || "",
          content_thumb: cover, cover_url: cover, cover_width: detail.video?.width || 0, cover_height: detail.video?.height || 0,
          share_id: `${api.session.uid}_${Date.now()}_${session.id}`, share_with_timestamp: 0,
          is_aigc: detail.is_aigc === true || detail.is_aigc === 1,
          ai_ext: typeof detail.ai_ext === "string" ? detail.ai_ext : JSON.stringify(detail.ai_ext || {}) };
        // The chat sender keeps dispatch ambiguity; the request id is also the IM client id.
        action.result = await chat.send({ requestId: input.requestId, conversationId: session.shareTargets.get(input.targetId), text: "分享作品" },
          { content: card, messageType: 8, onDispatch: () => { dispatched = true; } });
        if (action.result.outcome === "confirmed") { session.items.get(input.targetId).shared = true; action.result = { outcome: "confirmed", value: true, message: "已分享" }; }
        return action.result;
      }
      let user;
      const refresh = async () => {
        const payload = await api.request(input.action === "follow" ? "/aweme/v1/web/user/profile/other/" : ROUTES.detail,
          { query: input.action === "follow" ? { sec_user_id: session.id } : { aweme_id: session.id } });
        user = payload.user;
        ingestExploreResponse(session, input.action === "follow" ? "/aweme/v1/web/user/profile/other/" : ROUTES.detail, payload);
        return input.action === "follow" ? session.profile?.followed : input.action === "like" ? session.video?.liked : session.video?.collected;
      };
      if (input.action !== "comment") {
        const before = await refresh();
        if (typeof before !== "boolean") throw new ExploreError("state_unknown", "未能确认当前操作状态，请刷新后重试。");
        if (before === input.desired) return action.result = { outcome: "confirmed", value: before, message: "状态已符合所选目标" };
      }
      const acknowledgement = await directWrite(api, input.action, { awemeId: session.id, uid: String(user?.uid || ""), secUid: session.id,
        desired: input.desired, text: content, replyTo: input.replyTo }, { onDispatch: () => { dispatched = true; } });
      if (acknowledgement.status_code !== 0) return action.result = { outcome: "rejected", code: acknowledgement.status_code === 8 ? "login_required" : "platform_rejected",
        message: acknowledgement.status_code === 8 ? "抖音登录已失效，请在登录窗口重新登录后再试。" : "抖音没有接收本次操作，请检查登录或验证提示。" };
      if (input.action === "comment") {
        const comment = normalizeExploreComment(acknowledgement.comment);
        if (comment?.id && comment.text === content && (!comment.videoId || comment.videoId === session.id)) {
          action.result = { outcome: "confirmed", message: input.replyTo ? "回复已发送" : "评论已发送", comment };
          (session.posted ??= new Set()).add(comment.id);
        }
      } else {
        // Detail/profile state can lag a successful receipt. Poll only reads;
        // the original write is never repeated while waiting for confirmation.
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const after = await refresh();
          if (after === input.desired) {
            action.result = { outcome: "confirmed", value: after, message: input.action === "follow" ? after ? "已关注" : "已取消关注"
              : input.action === "like" ? after ? "已点赞" : "已取消点赞" : after ? "已收藏" : "已取消收藏" };
            break;
          }
          if (attempt < 5) await delay(500);
        }
      }
      return action.result;
    } catch (error) {
      if (dispatched) { action.result.code = error.code || "request_failed"; return action.result; }
      this.actions.delete(input.requestId); reject(error); throw error;
    } finally {
      resolve(action.result); delete action.promise;
    }
  }
  async clear() {
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    this.actions.clear();
    await Promise.allSettled(sessions.filter((session) => session.page).map((session) => session.page.close()));
  }
}
