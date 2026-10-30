import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { CREATOR_ENDPOINTS } from "../creatorCenter.mjs";

// AI 助手能用的工具：读本机数据的直接在进程里查采集器的内存快照（一次整份 ~20MB，不能交给模型），
// 用功能的一律调采集器自己的 HTTP 接口（ctx.api），读取权限、换号中、互动开关、requestId 去重这些关卡和工作台点按钮时一样。
// 对外动作（私信、点赞、收藏、关注、评论、分享、推荐流「不感兴趣」）先 ctx.confirm 等用户在应用里点「允许」，参数里没有确认字段。
// 不给 AI：登录/扫码/短信验证、互动开关本身、清除记录、删账号、导入、装卸扩展、把作品记进抖音观看历史。

const LISTS = { watch_history: "观看历史", liked_videos: "喜欢", favorite_videos: "收藏" };
const LIST_NAMES = Object.keys(LISTS);
const MAX_ROWS = 50;
const MAX_RESULT_CHARS = 30_000;
const DOWNLOAD_WAIT_MS = 5 * 60_000;
const LIVE_LISTEN_MS = 5_000;
const VIEWS = ["summary", "highlights", "watch_history", "liked_videos", "favorite_videos", "live", "feed_filtered", "chat", "explore", "creator", "assistant", "settings"];

const fail = (code, message) => ({ ok: false, code, message });
const requestId = () => randomBytes(12).toString("hex");
const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const clampInt = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** 时间按这台电脑的时区写成「2026-10-30 14:05」，模型和用户都好读。 */
export function localTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** since/until 收 "2026-10-01" 或完整时间；只写日期的 until 算到那天结束。 */
function timeRange({ since, until }) {
  const parse = (value, end) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value.trim());
    const time = new Date(dateOnly ? `${value.trim()}T${end ? "23:59:59.999" : "00:00:00"}` : value).getTime();
    return Number.isNaN(time) ? null : time;
  };
  return { from: parse(since, false), to: parse(until, true) };
}

function listsOf(list) {
  if (list === undefined || list === "all") return LIST_NAMES;
  return LIST_NAMES.includes(list) ? [list] : null;
}

/** 本地记录的筛选：搜索词照工作台搜索框（每个词都要出现在标题、作者、音乐或词条里），再按作者、时间、文件夹。 */
export function filterRecords(snapshot, args, folders = null) {
  const lists = listsOf(args.list);
  if (!lists) return null;
  const terms = text(args.query, 100).toLowerCase().split(/\s+/u).filter(Boolean);
  const author = text(args.author, 60).toLowerCase();
  const { from, to } = timeRange(args);
  const folderName = text(args.folder, 40);
  const rows = [];
  for (const list of lists) {
    let inFolder = null;
    if (folderName) {
      const doc = folders?.lists?.[list];
      const folder = doc?.folders.find((item) => item.name === folderName);
      inFolder = new Set(folder ? Object.entries(doc.items).filter(([, id]) => id === folder.id).map(([key]) => key) : []);
    }
    for (const record of snapshot?.records?.[list] ?? []) {
      if (author && !String(record.author ?? "").toLowerCase().includes(author)) continue;
      const time = record.occurredAt ? new Date(record.occurredAt).getTime() : NaN;
      if ((from !== null || to !== null) && Number.isNaN(time)) continue;
      if (from !== null && time < from) continue;
      if (to !== null && time > to) continue;
      if (inFolder && !inFolder.has(record.videoId || record.id)) continue;
      if (terms.length) {
        const haystack = [record.title, record.author, record.music?.title, record.music?.author, ...(record.topics ?? [])].join(" ").toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
      }
      rows.push({ list, record, time });
    }
  }
  return rows;
}

/**
 * 私信会话按最近一条消息排：存下来的会话自己的 lastActiveAt 常常是空的（工作台聊天页也是拿最新消息的时间），
 * 所以和聊天页一样从消息里算，没有消息才退回 lastActiveAt。
 */
export function listConversations(snapshot, args) {
  const latest = new Map();
  for (const message of snapshot?.chatMessages ?? []) {
    const time = new Date(message.sentAt).getTime();
    if (Number.isNaN(time) || (latest.get(message.conversationId)?.time ?? -Infinity) >= time) continue;
    latest.set(message.conversationId, { time, message });
  }
  const query = text(args.query, 60).toLowerCase();
  const { from } = timeRange({ since: args.since });
  const items = (snapshot?.chatConversations ?? []).map((conversation) => {
    const last = latest.get(conversation.id);
    const fallback = new Date(conversation.lastActiveAt ?? NaN).getTime();
    return { conversation, last: last?.message ?? null, time: last?.time ?? (Number.isNaN(fallback) ? null : fallback) };
  })
    .filter(({ conversation, time }) => (!query || String(conversation.name ?? "").toLowerCase().includes(query)) && (from === null || (time !== null && time >= from)))
    .sort((left, right) => (right.time ?? -Infinity) - (left.time ?? -Infinity));
  return {
    total: items.length,
    items: items.slice(0, clampInt(args.limit, 1, MAX_ROWS, 30)).map(({ conversation, last, time }) => ({
      conversationId: conversation.id, name: conversation.name ?? "抖音用户", group: conversation.kind === "group",
      messages: conversation.messageCount ?? 0, mine: conversation.ownMessageCount ?? 0, lastActive: time === null ? null : localTime(time),
      ...(last ? { lastMessage: `${last.senderName ?? "对方"}：${String(last.text || (last.share?.title ? `分享了《${last.share.title}》` : `[${last.type ?? "消息"}]`)).slice(0, 40)}` } : {}),
    })),
  };
}

const row = ({ list, record }) => ({
  list: LISTS[list],
  videoId: record.videoId ?? null,
  title: record.title || "（没有标题）",
  author: record.author ?? null,
  authorId: record.authorId ?? null,
  time: localTime(record.occurredAt),
  url: record.url ?? (record.videoId ? `https://www.douyin.com/video/${record.videoId}` : null),
  ...(record.durationSeconds ? { seconds: record.durationSeconds } : {}),
  ...(record.topics?.length ? { topics: record.topics.slice(0, 6) } : {}),
  ...(record.music?.title ? { music: record.music.title } : {}),
  ...(record.stats?.diggCount ? { likes: record.stats.diggCount } : {}),
  ...(record.mediaType && record.mediaType !== "video" ? { kind: record.mediaType } : {}),
  ...(typeof record.watchCompleted === "boolean" ? { watchedToEnd: record.watchCompleted } : {}),
});

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 按某个维度数条数，取前 top 个。 */
export function countBy(rows, by, top) {
  const counts = new Map();
  const add = (key) => { if (key) counts.set(key, (counts.get(key) ?? 0) + 1); };
  for (const { record, time } of rows) {
    const date = Number.isNaN(time) ? null : new Date(time);
    if (by === "author") add(record.author);
    else if (by === "topic") for (const topic of new Set(record.topics ?? [])) add(topic);
    else if (by === "music") add(record.music?.title);
    else if (!date) continue;
    else if (by === "month") add(localTime(date).slice(0, 7));
    else if (by === "day") add(localTime(date).slice(0, 10));
    else if (by === "weekday") add(WEEKDAYS[date.getDay()]);
    else if (by === "hour") add(`${String(date.getHours()).padStart(2, "0")} 点`);
  }
  const sorted = [...counts].sort((left, right) => (["month", "day", "hour"].includes(by) ? left[0].localeCompare(right[0]) : right[1] - left[1]));
  // 时间类按时间顺序给全（月份、小时本来就不多；天数太多时留最近的），其余按条数取前几
  const picked = by === "day" ? sorted.slice(-top) : ["month", "hour", "weekday"].includes(by) ? sorted : sorted.slice(0, top);
  return { distinct: counts.size, items: picked.map(([key, count]) => ({ key, count })) };
}

// 探索读回来的条目带一堆图片地址，模型用不上
const HEAVY_KEY = /cover|avatar|thumb|image|urlList|url_list|animated|dynamic|playAddr/iu;
function lean(value, depth = 0) {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => lean(item, depth + 1));
  if (!value || typeof value !== "object" || depth > 4) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !HEAVY_KEY.test(key) && item !== null && item !== "").map(([key, item]) => [key, lean(item, depth + 1)]));
}

function capped(result) {
  const json = JSON.stringify(result);
  return json.length <= MAX_RESULT_CHARS ? result : { ok: true, truncated: true, text: `${json.slice(0, MAX_RESULT_CHARS)}…（太长，后面略了，缩小范围再查）` };
}

const fn = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: "object", properties, required, additionalProperties: false } });
const listParam = { type: "string", enum: ["all", ...LIST_NAMES], description: "watch_history 观看历史 / liked_videos 喜欢 / favorite_videos 收藏 / all 全部（默认）" };
const rangeParams = {
  since: { type: "string", description: "起始日期，如 2026-10-01" },
  until: { type: "string", description: "截止日期，如 2026-10-31（含当天）" },
};

/**
 * 工具表：{ kind: read | local | external, def: OpenAI function 的 function 部分, run(ctx, args) }。
 * ctx：{ api(method, path, body?) → { ok, status, body }, collector(), accounts(), writesEnabled(), confirm(spec), ui(event), seen: Map }
 */
export const TOOLS = [
  {
    kind: "read",
    def: fn("app_overview", "应用当前状况：现在几点、当前登录的抖音账号和所有账号、各类记录条数和时间范围、聊天会话数、正在读取什么、哪些读取权限开着、互动开关。每次对话先调一次。"),
    async run(ctx) {
      const collector = ctx.collector();
      const status = collector.getStatus();
      const snapshot = collector.snapshot;
      const range = (list) => {
        const times = (snapshot.records?.[list] ?? []).map((record) => new Date(record.occurredAt).getTime()).filter((time) => !Number.isNaN(time));
        return times.length ? { count: snapshot.records[list].length, from: localTime(Math.min(...times)), to: localTime(Math.max(...times)) } : { count: snapshot.records?.[list]?.length ?? 0 };
      };
      const accounts = ctx.accounts();
      return {
        ok: true,
        now: localTime(Date.now()),
        account: status.account?.nickname ?? null,
        accounts: accounts.accounts.map((account) => ({ id: account.id, nickname: account.nickname ?? "未命名", active: account.id === accounts.activeId })),
        records: Object.fromEntries(LIST_NAMES.map((list) => [LISTS[list], range(list)])),
        chat: { conversations: snapshot.chatConversations?.length ?? 0, messages: snapshot.chatMessages?.length ?? 0, receiving: ["launching_browser", "observing"].includes(status.chat?.state), state: status.chat?.message ?? null },
        reading: { state: status.state, message: status.message },
        readPermissions: status.readPermissions,
        interactionsEnabled: ctx.writesEnabled(),
      };
    },
  },
  {
    kind: "read",
    def: fn("search_records", "在本机的观看历史、喜欢、收藏里找作品，按时间从新到旧。每次最多 50 条，用 offset 翻页。", {
      list: listParam,
      query: { type: "string", description: "搜索词，空格隔开的每个词都要出现在标题、作者、音乐或词条里" },
      author: { type: "string", description: "作者昵称（包含即可）" },
      ...rangeParams,
      folder: { type: "string", description: "只看这个文件夹里的（文件夹名）" },
      sort: { type: "string", enum: ["newest", "oldest", "most_liked"], description: "默认 newest" },
      limit: { type: "integer", description: "默认 20，最多 50" },
      offset: { type: "integer" },
    }),
    async run(ctx, args) {
      const collector = ctx.collector();
      collector.assertReadPermission("videos");
      const folders = args.folder ? (await ctx.api("GET", "/v1/folders")).body : null;
      const rows = filterRecords(collector.snapshot, args, folders);
      if (!rows) return fail("invalid_list", "list 只能是 watch_history、liked_videos、favorite_videos 或 all。");
      const sort = args.sort ?? "newest";
      rows.sort(sort === "most_liked" ? (left, right) => (right.record.stats?.diggCount ?? 0) - (left.record.stats?.diggCount ?? 0)
        : sort === "oldest" ? (left, right) => left.time - right.time : (left, right) => right.time - left.time);
      const offset = clampInt(args.offset, 0, 1e9, 0);
      const limit = clampInt(args.limit, 1, MAX_ROWS, 20);
      return { ok: true, total: rows.length, offset, items: rows.slice(offset, offset + limit).map(row) };
    },
  },
  {
    kind: "read",
    def: fn("record_stats", "统计本机记录：按作者、词条、音乐、月份、日期、星期几、几点钟数条数。回答「最常看谁」「什么时候刷得多」这类问题用它，比翻记录快。", {
      list: listParam,
      by: { type: "string", enum: ["author", "topic", "music", "month", "day", "weekday", "hour"] },
      query: { type: "string", description: "先按搜索词筛（同 search_records）" },
      author: { type: "string" },
      ...rangeParams,
      top: { type: "integer", description: "取前几个，默认 20，最多 50" },
    }, ["by"]),
    async run(ctx, args) {
      const collector = ctx.collector();
      collector.assertReadPermission("videos");
      if (!["author", "topic", "music", "month", "day", "weekday", "hour"].includes(args.by)) return fail("invalid_by", "by 不对。");
      const rows = filterRecords(collector.snapshot, args);
      if (!rows) return fail("invalid_list", "list 只能是 watch_history、liked_videos、favorite_videos 或 all。");
      return { ok: true, total: rows.length, ...countBy(rows, args.by, clampInt(args.top, 1, MAX_ROWS, 20)) };
    },
  },
  {
    kind: "read",
    def: fn("list_folders", "本机内容库里用户自己建的文件夹，以及每个文件夹里有几条。"),
    async run(ctx) {
      const { body } = await ctx.api("GET", "/v1/folders");
      return {
        ok: true,
        lists: Object.fromEntries(LIST_NAMES.map((list) => {
          const doc = body?.lists?.[list] ?? { folders: [], items: {} };
          const counts = new Map();
          for (const id of Object.values(doc.items)) counts.set(id, (counts.get(id) ?? 0) + 1);
          return [LISTS[list], doc.folders.map((folder) => ({ name: folder.name, count: counts.get(folder.id) ?? 0 }))];
        })),
      };
    },
  },
  {
    kind: "local",
    def: fn("organize_folders", "整理本机内容库的文件夹：新建、改名、删除文件夹，把作品放进某个文件夹或移出。只改本机，不影响抖音。", {
      list: { type: "string", enum: LIST_NAMES },
      create: { type: "array", items: { type: "string" }, description: "要新建的文件夹名" },
      rename: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
      remove: { type: "array", items: { type: "string" }, description: "要删的文件夹名（里面的作品回到未归档）" },
      move: { type: "array", items: { type: "object", properties: { videoIds: { type: "array", items: { type: "string" } }, folder: { type: ["string", "null"], description: "文件夹名；null 表示移出文件夹" } }, required: ["videoIds"] } },
    }, ["list"]),
    async run(ctx, args) {
      if (!LIST_NAMES.includes(args.list)) return fail("invalid_list", "list 只能是 watch_history、liked_videos 或 favorite_videos。");
      const read = await ctx.api("GET", "/v1/folders");
      if (!read.ok) return fail(read.body?.error ?? "folders_read_failed", read.body?.message ?? "文件夹没读出来。");
      // 接口是整份替换：三栏都带上，只改这一栏
      const doc = structuredClone(read.body);
      const list = doc.lists[args.list];
      const byName = (name) => list.folders.find((folder) => folder.name === name);
      const done = [];
      for (const name of (args.create ?? []).map((item) => text(item, 40)).filter(Boolean)) {
        if (byName(name)) continue;
        list.folders.push({ id: randomBytes(6).toString("hex"), name });
        done.push(`新建「${name}」`);
      }
      for (const { from, to } of args.rename ?? []) {
        const folder = byName(text(from, 40));
        if (!folder || !text(to, 40)) return fail("folder_not_found", `没有叫「${from}」的文件夹。`);
        folder.name = text(to, 40);
        done.push(`「${from}」改名为「${folder.name}」`);
      }
      for (const name of args.remove ?? []) {
        const folder = byName(text(name, 40));
        if (!folder) return fail("folder_not_found", `没有叫「${name}」的文件夹。`);
        list.folders = list.folders.filter((item) => item !== folder);
        for (const [key, id] of Object.entries(list.items)) if (id === folder.id) delete list.items[key];
        done.push(`删除「${folder.name}」`);
      }
      const known = new Set((ctx.collector().snapshot.records?.[args.list] ?? []).map((record) => record.videoId || record.id));
      for (const { videoIds = [], folder: name = null } of args.move ?? []) {
        const folder = name === null ? null : byName(text(name, 40));
        if (name !== null && !folder) return fail("folder_not_found", `没有叫「${name}」的文件夹，先新建。`);
        const ids = videoIds.map(String).filter((id) => known.has(id));
        for (const id of ids) {
          if (folder) list.items[id] = folder.id;
          else delete list.items[id];
        }
        done.push(folder ? `${ids.length} 条放进「${folder.name}」` : `${ids.length} 条移出文件夹`);
      }
      if (!done.length) return { ok: true, message: "没有要改的。" };
      const saved = await ctx.api("POST", `/v1/folders?account=${encodeURIComponent(ctx.accounts().activeId)}`, doc);
      if (!saved.ok) return fail(saved.body?.error ?? "folders_save_failed", saved.body?.message ?? "文件夹没存上。");
      return { ok: true, done };
    },
  },
  {
    kind: "read",
    def: fn("list_conversations", "本机存的私信会话（好友和群），按最近一条消息的时间从新到旧，带最后一句。群聊消息本机不存，群的时间和最后一句是空的，要知道就用 read_live_chat。", {
      query: { type: "string", description: "按会话名筛" },
      since: { type: "string", description: "只要这个时间以后还有消息的，如 2026-10-29" },
      limit: { type: "integer", description: "默认 30，最多 50" },
    }),
    async run(ctx, args) {
      const collector = ctx.collector();
      collector.assertReadPermission("chat");
      return { ok: true, ...listConversations(collector.snapshot, args) };
    },
  },
  {
    kind: "read",
    def: fn("read_chat", "读本机存的某个私信会话的消息（按时间从旧到新，默认最近 50 条）。群聊的消息本机不存，用 read_live_chat。", {
      conversationId: { type: "string" },
      before: { type: "string", description: "只看这个时间以前的，用来往前翻" },
      limit: { type: "integer", description: "默认 50，最多 100" },
    }, ["conversationId"]),
    async run(ctx, args) {
      const collector = ctx.collector();
      collector.assertReadPermission("chat");
      const before = args.before ? new Date(args.before).getTime() : Infinity;
      const all = (collector.snapshot.chatMessages ?? [])
        .filter((message) => message.conversationId === args.conversationId && !(new Date(message.sentAt).getTime() >= before))
        .sort((left, right) => String(left.sentAt).localeCompare(String(right.sentAt)));
      const picked = all.slice(-clampInt(args.limit, 1, 100, 50));
      return {
        ok: true,
        total: all.length,
        items: picked.map((message) => ({
          id: message.id, time: localTime(message.sentAt), sender: message.senderName ?? "对方",
          ...(message.text ? { text: message.text } : {}),
          ...(message.type && message.type !== "text" ? { kind: message.type } : {}),
          ...(message.share?.title ? { shared: message.share.title } : {}),
          ...(message.callDurationSeconds ? { callSeconds: message.callDurationSeconds } : {}),
        })),
      };
    },
  },
  {
    kind: "read",
    def: fn("read_live_chat", "从抖音现读某个会话（包括群聊）的消息，一次一页，older=true 往前翻。要先在接收聊天（start_reading kind=chat）。", {
      conversationId: { type: "string" },
      older: { type: "boolean" },
    }, ["conversationId"]),
    run: (ctx, args) => passThrough(ctx, "POST", "/v1/chat/messages", { conversationId: args.conversationId, older: args.older === true }),
  },
  {
    kind: "read",
    def: fn("chat_streaks", "各个会话的抖音火花（连续聊天天数）。要先在接收聊天。"),
    run: (ctx) => passThrough(ctx, "GET", "/v1/chat/streaks"),
  },
  {
    kind: "read",
    def: fn("transcribe_voice", "把一条语音私信转成文字（用抖音自带的转写）。", { messageId: { type: "string" } }, ["messageId"]),
    run: (ctx, args) => passThrough(ctx, "POST", `/v1/chat/voice/transcribe?account=${encodeURIComponent(ctx.accounts().activeId)}`, { messageId: args.messageId }),
  },
  {
    kind: "read",
    def: fn("douyin_read", "从抖音读：users 搜用户、videos 搜作品、profile 某人主页和作品（id 是 sec_uid）、detail 作品详情、comments 作品评论、replies 某条评论的回复、feed 推荐流。翻下一页时把上次返回的 sessionId 原样带上，只返回新的那页。", {
      kind: { type: "string", enum: ["users", "videos", "profile", "detail", "comments", "replies", "feed"] },
      query: { type: "string", description: "users / videos 的搜索词" },
      id: { type: "string", description: "profile 用 sec_uid；detail / comments / replies 用作品 id" },
      commentId: { type: "string", description: "replies 要展开的评论 id（要先用 comments 读到这条）" },
      sessionId: { type: "string", description: "翻页时带上次的；replies 带 comments 那次的" },
    }, ["kind"]),
    async run(ctx, args) {
      const result = await ctx.api("POST", "/v1/explore/read", { kind: args.kind, query: args.query, id: args.id, commentId: args.commentId, sessionId: args.sessionId });
      if (!result.ok) return apiFailure(result);
      const { sessionId, items = [], profile, video, hasMore } = result.body;
      // 同一个会话翻页时接口回的是累计的全部条目：只给这次新的
      const key = `${sessionId}:${args.kind}:${args.commentId ?? ""}`;
      const from = ctx.seen.get(key) ?? 0;
      ctx.seen.set(key, items.length);
      return capped({ ok: true, sessionId, hasMore, total: items.length, ...(profile ? { profile: lean(profile) } : {}), ...(video ? { video: lean(video) } : {}), items: lean(items.slice(from, from + 30)) });
    },
  },
  {
    kind: "read",
    def: fn("creator_read", "读用户自己的抖音创作者中心数据（作品数据、粉丝、直播数据、评论、达人指数等，只读）。一次最多 24 个查询。", {
      requests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: Object.keys(CREATOR_ENDPOINTS) },
            params: { type: "object", description: "这个查询要的参数，比如 recent_days、item_id、count" },
          },
          required: ["key"],
        },
      },
    }, ["requests"]),
    async run(ctx, args) {
      const requests = (Array.isArray(args.requests) ? args.requests : []).slice(0, 24).map((item) => ({ key: item?.key, params: item?.params ?? {} }));
      const result = await ctx.api("POST", "/v1/creator/read", { requests });
      if (!result.ok) return apiFailure(result);
      return capped({ ok: true, results: (result.body.results ?? []).map((item, index) => ({ key: requests[index].key, ...lean(item) })) });
    },
  },
  {
    kind: "read",
    def: fn("live_following", "关注的人里谁正在直播。", { refresh: { type: "boolean", description: "不用 30 秒内的缓存" } }),
    run: (ctx, args) => passThrough(ctx, "GET", `/v1/live/following${args.refresh ? "?refresh=1" : ""}`),
  },
  {
    kind: "read",
    def: fn("live_room", "进一个直播间听 5 秒弹幕再出来，返回直播信息和这几秒的弹幕。会替换掉应用里正在看的直播间。", {
      room: { type: "string", description: "live.douyin.com 链接或房间号" },
    }, ["room"]),
    async run(ctx, args) {
      const opened = await ctx.api("POST", "/v1/live/rooms", { room: args.room });
      if (!opened.ok) return apiFailure(opened);
      const id = opened.body?.id;
      try {
        await delay(LIVE_LISTEN_MS);
        const read = id ? await ctx.api("GET", `/v1/live/rooms/${id}?after=-1`) : opened;
        const { messages = [], ...room } = read.ok ? read.body : opened.body;
        return capped({ ok: true, room: lean(room), messages: messages.slice(-50).map((message) => lean(message)) });
      } finally {
        if (id) await ctx.api("DELETE", `/v1/live/rooms/${id}`).catch(() => undefined);
      }
    },
  },
  {
    kind: "read",
    def: fn("feed_filter_read", "推荐流控制的设置（过滤词条、处理方式）、最近被挡掉的作品和处置记录。"),
    async run(ctx) {
      const [settings, videos, events] = await Promise.all([ctx.api("GET", "/v1/feed-filter"), ctx.api("GET", "/v1/feed-filter/videos"), ctx.api("GET", "/v1/feed-filter/events")]);
      if (!settings.ok) return apiFailure(settings);
      return capped({
        ok: true, rules: settings.body.rules, mode: settings.body.mode, extensionInstalled: Boolean(settings.body.extension?.lastSeenAt),
        recentlyFiltered: (videos.body?.videos ?? []).slice(-20).map((video) => ({ title: video.title, author: video.author, matched: video.feedFilter?.matched, action: video.feedFilter?.action })),
        events: (events.body?.events ?? []).length,
      });
    },
  },
  {
    kind: "local",
    def: fn("feed_filter_set", "改推荐流控制：rules 是过滤词条（一行一条，整份替换）；mode 是 off 关 / observe 只记录 / hide 隐藏 / dislike 隐藏并告诉抖音不感兴趣（dislike 会先问用户）。", {
      rules: { type: "string" },
      mode: { type: "string", enum: ["off", "observe", "hide", "dislike"] },
    }),
    async run(ctx, args) {
      if (args.mode === "dislike") await ctx.confirm({ action: "把推荐流改成「不感兴趣」", target: "浏览器里命中词条的推荐作品", text: "以后刷到命中词条的作品，扩展会替你告诉抖音「不感兴趣」。" });
      return passThrough(ctx, "POST", "/v1/feed-filter", { ...(typeof args.rules === "string" ? { rules: args.rules } : {}), ...(args.mode ? { mode: args.mode } : {}) });
    },
  },
  {
    kind: "local",
    def: fn("start_reading", "开始读取：new 补读新记录、full 从头重读全部记录（慢）、chat 开始接收私信（读群聊、发私信、看火花前要先开）。", {
      kind: { type: "string", enum: ["new", "full", "chat"] },
    }, ["kind"]),
    run: (ctx, args) => passThrough(ctx, "POST", { new: "/v1/experimental/records-direct", full: "/v1/sync", chat: "/v1/chat/observe" }[args.kind] ?? "/v1/experimental/records-direct", {}),
  },
  {
    kind: "local",
    def: fn("stop_reading", "停下：records 停止读取记录，chat 停止接收私信。", { kind: { type: "string", enum: ["records", "chat"] } }, ["kind"]),
    run: (ctx, args) => passThrough(ctx, "POST", args.kind === "chat" ? "/v1/chat/observe/stop" : "/v1/sync/stop", {}),
  },
  {
    kind: "local",
    def: fn("download_video", "把一条抖音作品下载到本机（等下完再返回，最多 5 分钟）。下完用户可以在对话里点「保存」存到自己的文件夹。", {
      url: { type: "string", description: "作品链接；只有作品 id 时写成 https://www.douyin.com/video/<id>" },
    }, ["url"]),
    async run(ctx, args, signal) {
      const started = await ctx.api("POST", "/v1/downloads", { url: args.url });
      if (!started.ok) return apiFailure(started);
      const deadline = Date.now() + DOWNLOAD_WAIT_MS;
      let job = started.body.job;
      while (!["complete", "failed"].includes(job?.status) && Date.now() < deadline) {
        await delay(1_000, undefined, { signal });
        const read = await ctx.api("GET", `/v1/downloads/${job.id}`);
        if (!read.ok) return apiFailure(read);
        job = read.body.job;
      }
      if (job?.status === "failed") return fail(job.errorCode ?? "download_failed", job.error ?? "没下载下来。");
      if (job?.status !== "complete") return fail("download_slow", "5 分钟还没下完，还在后台下着，过会儿再看。");
      return { ok: true, downloadId: job.id, fileName: job.fileName, megabytes: job.bytes ? Math.round(job.bytes / 1e5) / 10 : null };
    },
  },
  {
    kind: "local",
    def: fn("switch_account", "切换到应用里的另一个抖音账号（id 从 app_overview 来）。切换后读到的都是那个账号的数据。", { id: { type: "string" } }, ["id"]),
    run: (ctx, args) => passThrough(ctx, "POST", `/v1/accounts/${encodeURIComponent(String(args.id))}/activate`, {}),
  },
  {
    kind: "local",
    def: fn("open_view", "把应用切到某一页给用户看：summary 报告、highlights 精选、watch_history 观看历史、liked_videos 喜欢、favorite_videos 收藏、live 看过的直播、feed_filtered 推荐流挡掉的、chat 私信、explore 探索、creator 创作者中心、assistant 回到对话、settings 设置。", {
      view: { type: "string", enum: VIEWS },
    }, ["view"]),
    async run(ctx, args) {
      if (!VIEWS.includes(args.view)) return fail("invalid_view", "没有这一页。");
      ctx.ui({ type: "open_view", view: args.view });
      return { ok: true, message: "应用开着的话已经切过去了。" };
    },
  },
  {
    kind: "external",
    def: fn("send_chat_message", "以用户的身份给一个会话发一条私信（每条都会先弹卡片让用户确认）。要先在接收聊天。用户点名或说清楚范围的几个人，就一个会话调一次。", {
      conversationId: { type: "string" },
      text: { type: "string", description: "要发的原文，最多 2000 字" },
    }, ["conversationId", "text"]),
    async run(ctx, args) {
      const message = String(args.text ?? "").trim();
      if (!message || message.length > 2_000) return fail("invalid_text", "要发的内容不能为空，最多 2000 字。");
      const collector = ctx.collector();
      if (!["launching_browser", "observing"].includes(collector.getStatus().chat?.state)) return fail("not_receiving", "还没在接收聊天，先调 start_reading（kind=chat），等它开始接收再发。");
      const conversation = collector.snapshot.chatConversations?.find((item) => item.id === args.conversationId);
      await ctx.confirm({ action: "发私信", target: conversation?.name ?? "这个会话", text: message });
      return passThrough(ctx, "POST", "/v1/chat/send", { requestId: requestId(), conversationId: args.conversationId, text: message });
    },
  },
  {
    kind: "external",
    def: fn("douyin_interact", "以用户的身份在抖音上操作（每次都会先弹卡片让用户确认）：like/unlike 点赞、collect/uncollect 收藏（videoId）；follow/unfollow 关注（userId 是 sec_uid）；comment 评论（videoId + text，回复某条评论再带 replyToCommentId 和读评论那次的 sessionId）；share 把作品分享给一个私信会话（videoId + shareTo 会话名，要先在接收聊天）。", {
      action: { type: "string", enum: ["like", "unlike", "collect", "uncollect", "follow", "unfollow", "comment", "share"] },
      videoId: { type: "string" },
      userId: { type: "string" },
      text: { type: "string", description: "评论原文，最多 500 字" },
      replyToCommentId: { type: "string" },
      sessionId: { type: "string" },
      shareTo: { type: "string", description: "分享给哪个会话（名字）" },
    }, ["action"]),
    run: interact,
  },
];

const PUBLIC = new Set(["like", "unlike", "collect", "uncollect", "follow", "unfollow", "comment"]);

async function interact(ctx, args) {
  const { action } = args;
  if (PUBLIC.has(action) && !ctx.writesEnabled()) {
    return fail("writes_disabled", "应用设置里「允许在抖音上操作」关着。请用户自己到「设置 → 隐私」打开，你不能替用户打开。");
  }
  if (["like", "unlike", "collect", "uncollect"].includes(action)) {
    const kind = action.endsWith("like") ? "like" : "collect";
    const desired = !action.startsWith("un");
    const detail = await ctx.api("POST", "/v1/explore/read", { kind: "detail", id: args.videoId });
    if (!detail.ok) return apiFailure(detail);
    await ctx.confirm({ action: `${desired ? "" : "取消"}${kind === "like" ? "点赞" : "收藏"}`, target: workName(detail.body.video) });
    return passThrough(ctx, "POST", "/v1/explore/react", { awemeId: String(args.videoId), action: kind, desired });
  }
  if (action === "follow" || action === "unfollow") {
    const profile = await ctx.api("POST", "/v1/explore/read", { kind: "profile", id: args.userId });
    if (!profile.ok) return apiFailure(profile);
    const name = profile.body.profile?.name ?? "这个用户";
    await ctx.confirm({ action: action === "follow" ? "关注" : "取消关注", target: name });
    return passThrough(ctx, "POST", "/v1/explore/interact", { sessionId: profile.body.sessionId, requestId: requestId(), action: "follow", desired: action === "follow" });
  }
  if (action === "comment") {
    const comment = String(args.text ?? "").replace(/\s+/gu, " ").trim();
    if (!comment || comment.length > 500) return fail("invalid_text", "评论不能为空，最多 500 字。");
    let sessionId = args.sessionId;
    let video = null;
    if (args.replyToCommentId) {
      if (!sessionId) return fail("session_required", "回复评论要带上读这条评论时（douyin_read kind=comments）返回的 sessionId。");
    } else {
      const detail = await ctx.api("POST", "/v1/explore/read", { kind: "detail", id: args.videoId });
      if (!detail.ok) return apiFailure(detail);
      ({ sessionId, video } = detail.body);
    }
    await ctx.confirm({ action: args.replyToCommentId ? "回复评论" : "发评论", target: video ? workName(video) : "这条评论", text: comment });
    return passThrough(ctx, "POST", "/v1/explore/interact", { sessionId, requestId: requestId(), action: "comment", text: comment, ...(args.replyToCommentId ? { replyTo: String(args.replyToCommentId) } : {}) });
  }
  if (action === "share") {
    const sharees = await ctx.api("POST", "/v1/explore/read", { kind: "sharees", id: args.videoId });
    if (!sharees.ok) return apiFailure(sharees);
    const wanted = text(args.shareTo, 60);
    const matches = (sharees.body.items ?? []).filter((item) => item.name === wanted);
    if (matches.length !== 1) {
      const close = (sharees.body.items ?? []).filter((item) => wanted && String(item.name).includes(wanted)).slice(0, 8).map((item) => item.name);
      return fail("target_not_found", matches.length ? `有 ${matches.length} 个会话都叫「${wanted}」，先问用户是哪个。` : `私信会话里没有叫「${wanted}」的。${close.length ? `名字像的有：${close.join("、")}` : ""}`);
    }
    const detail = await ctx.api("POST", "/v1/explore/read", { kind: "detail", id: args.videoId });
    await ctx.confirm({ action: "分享作品", target: matches[0].name, text: detail.ok ? workName(detail.body.video) : `作品 ${args.videoId}` });
    return passThrough(ctx, "POST", "/v1/explore/interact", { sessionId: sharees.body.sessionId, requestId: requestId(), action: "share", targetId: matches[0].id });
  }
  return fail("invalid_action", "不支持这个操作。");
}

const workName = (video) => (video ? `${video.author ?? ""}的作品《${String(video.title ?? "").slice(0, 40) || "无标题"}》` : "这个作品");

function apiFailure(result) {
  return fail(result.body?.error ?? `http_${result.status}`, result.body?.message ?? "这一步没成功。");
}

async function passThrough(ctx, method, path, body) {
  const result = await ctx.api(method, path, body);
  return result.ok ? capped({ ok: true, ...lean(result.body) }) : apiFailure(result);
}

/** OpenAI 形状的工具定义。 */
export const toolDefinitions = () => TOOLS.map((tool) => ({ type: "function", function: tool.def }));

export const toolNamed = (name) => TOOLS.find((tool) => tool.def.name === name) ?? null;
