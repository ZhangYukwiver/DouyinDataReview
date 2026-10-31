import { createHash } from "node:crypto";
import { copyFile, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 内容库「我的评论」：自己发出的评论和评论下面的回复。来源是抖音网页「通知 → 评论」那一栏（只读，不标已读），
// 外加在本应用里发出去的评论。抖音那一栏只留最近 100 条，所以每次读取都并进本机这份，按评论 id 去重。
export const NOTICE_PATH = "/aweme/v1/web/notice/";
const COMMENT_LIST_PATH = "/aweme/v1/web/comment/list/";
const MAX_COMMENTS = 2000;
const MAX_REPLIES = 200;
const MAX_PAGES = 10;
// comment_type（10-31 回评论区逐条核对过）：2 回复了你的评论，reply_comment 就是你那条；12 在你的评论楼里回复了别人，
// 楼主是你，原文不在通知里，要回评论区补；6 和 2 一样、只是作品已不可见。1 评论了你的作品、11 别人在你作品下互相回复，都不收
const TO_ME = new Set([2, 6]);
const IN_MY_THREAD = 12;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value, max = 3000) => (typeof value === "string" && value.trim() ? value.slice(0, max) : null);
const digits = (value) => (/^\d{1,30}$/u.test(String(value ?? "")) ? String(value) : null);
const seconds = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 4_102_444_800 ? new Date(Number(value) * 1000).toISOString() : null);
const image = (value) => {
  const url = Array.isArray(value?.url_list) ? value.url_list.find((item) => typeof item === "string" && item.startsWith("https://")) : null;
  return url ? url.slice(0, 2000) : null;
};
// 不知道评论 id 的那几条（自己在别人楼里的回复）按作品、楼和正文给个稳定的 id，下次读到同一条能对上
const textId = (videoId, threadId, text) => `t${createHash("sha1").update(`${videoId ?? ""}|${threadId}|${text}`).digest("hex").slice(0, 16)}`;
// 只发了表情或图片的评论正文是空的
const body = (comment) => str(comment?.text) ?? (comment?.image_list ? "[图片]" : "[表情]");

function user(raw) {
  return { id: digits(raw?.uid), name: str(raw?.nickname, 100) ?? "抖音用户", avatarUrl: image(raw?.avatar_thumb ?? raw?.avatar_168x168) };
}

function video(aweme, videoId) {
  if (!isObject(aweme) || digits(aweme.aweme_id) !== videoId) return null;
  return { title: str(aweme.desc?.split("\n")[0], 200), author: str(aweme.author?.nickname, 100), coverUrl: image(aweme.video?.cover ?? aweme.video?.origin_cover) };
}

// 一条通知 → 回复本身，以及它挂在哪条「我的评论」下面；不是回复我的评论就是 null
export function readNotice(notice) {
  const block = notice?.comment;
  const type = Number(block?.comment_type);
  const theirs = block?.comment;
  // 作品删了或设成私密时通知里没有作品编号，评论和回复照样留着
  const id = digits(theirs?.cid), videoId = digits(theirs?.aweme_id) ?? digits(block?.aweme?.aweme_id), threadId = digits(block?.parent_id);
  if (!id || !threadId || (!TO_ME.has(type) && type !== IN_MY_THREAD)) return null;
  const quoted = isObject(block.reply_comment) ? body(block.reply_comment) : null;
  if (TO_ME.has(type) && !quoted) return null;
  const reply = {
    id, at: seconds(notice.create_time), text: body(theirs), user: user(theirs.user), label: str(block.label_text, 20),
    // 12：对方回的是楼里别人，记下回的是谁、那条说了什么
    ...(type === IN_MY_THREAD ? { replyToName: str(theirs.reply_to_username, 100), quote: quoted } : {}),
  };
  return { reply, videoId, threadId, mine: TO_ME.has(type) ? quoted : null, video: video(block.aweme, videoId) };
}

function latest(comment) {
  return [comment.at, ...comment.replies.map((reply) => reply.at)].filter(Boolean).sort().at(-1) ?? "";
}

function sortAndCap(comments) {
  return comments.sort((a, b) => latest(b).localeCompare(latest(a))).slice(0, MAX_COMMENTS);
}

function addReply(comment, item) {
  if (!comment.video && item.video) comment.video = item.video;
  if (comment.replies.some((reply) => reply.id === item.reply.id)) return false;
  comment.replies = [...comment.replies, item.reply].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, MAX_REPLIES);
  return true;
}

// 回复挂到哪条「我的评论」：2 按楼 + 我那条的正文找，12 找楼主那条（id 就是楼的 id）
function findComment(comments, item) {
  return item.mine
    ? comments.find((comment) => comment.threadId === item.threadId && comment.text === item.mine)
    : comments.find((comment) => comment.id === item.threadId);
}

// 楼主那条评论：评论区按 insert_ids 把它顶到第一条带回来
async function readThreadRoot(api, item) {
  if (!item.videoId) return null;
  const payload = await api.request(COMMENT_LIST_PATH, { query: { aweme_id: item.videoId, cursor: "0", count: "5", insert_ids: item.threadId, item_type: "0" } });
  const root = (Array.isArray(payload?.comments) ? payload.comments : []).find((comment) => String(comment?.cid) === item.threadId);
  return root ? { text: str(root.text), at: seconds(root.create_time), likes: Number.isFinite(root.digg_count) ? root.digg_count : null } : null;
}

function newComment(item, root) {
  const base = { videoId: item.videoId, threadId: item.threadId, video: item.video, source: "notice", replies: [] };
  // 我那条就是楼主：用楼的 id，带上发出时间和点赞
  if (!item.mine || root?.text === item.mine) return { ...base, id: item.threadId, text: root?.text ?? item.mine, at: root?.at ?? null, likes: root?.likes ?? null };
  return { ...base, id: textId(item.videoId, item.threadId, item.mine), text: item.mine, at: null, likes: null };
}

/**
 * 读「通知 → 评论」，新回复并进已有的「我的评论」，返回新的整份和这次新增的回复数。
 * ponytail: 抖音那边最多 100 条（5 页），每次读全、按评论 id 去重，不做增量；以前没认出来的通知下次也能补进来
 */
export async function collectMyComments(api, existing, { signal, pause = 400 } = {}) {
  const comments = structuredClone(existing);
  const items = [];
  let maxTime = "0";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    signal?.throwIfAborted();
    const payload = await api.request(NOTICE_PATH, { query: { is_new_notice: "1", is_mark_read: "0", notice_group: "2", count: "20", min_time: "0", max_time: maxTime } });
    const list = Array.isArray(payload?.notice_list_v2) ? payload.notice_list_v2 : [];
    items.push(...list.map(readNotice).filter(Boolean));
    if (!payload.has_more || !list.length) break;
    const next = digits(payload.max_time) ?? digits(list.at(-1)?.create_time);
    if (!next || next === maxTime) break;
    maxTime = next;
    await delay(pause);
  }
  let added = 0;
  // 旧的先挂，同一条评论第一次出现时才回评论区补楼主那条
  for (const item of items.reverse()) {
    let comment = findComment(comments, item);
    if (!comment) {
      signal?.throwIfAborted();
      const root = await readThreadRoot(api, item).catch(() => null);
      comment = newComment(item, root);
      comments.push(comment);
      await delay(pause);
    }
    if (addReply(comment, item)) added += 1;
  }
  return { comments: sortAndCap(comments), added };
}

// 在本应用里发出去的评论（播放器、创作者中心）：抖音回执确认过才记
export function sentComment(videoId, posted) {
  const id = digits(posted?.id), text = str(posted?.text);
  if (!digits(videoId) || !id || !text) return null;
  return { id, videoId: String(videoId), threadId: digits(posted.parentId) ?? id, text, at: posted.publishedAt ?? new Date().toISOString(), likes: null, video: null, source: "app", replies: [] };
}

// 磁盘上的文件不可信：逐条过一遍
function sanitizeReply(value) {
  if (!isObject(value) || !digits(value.id) || !str(value.text)) return null;
  const who = isObject(value.user) ? value.user : {};
  return {
    id: String(value.id), at: typeof value.at === "string" ? value.at.slice(0, 40) : null, text: str(value.text),
    user: { id: digits(who.id), name: str(who.name, 100) ?? "抖音用户", avatarUrl: typeof who.avatarUrl === "string" && who.avatarUrl.startsWith("https://") ? who.avatarUrl.slice(0, 2000) : null },
    label: str(value.label, 20),
    ...(Object.hasOwn(value, "quote") ? { replyToName: str(value.replyToName, 100), quote: str(value.quote) } : {}),
  };
}

export function sanitizeMyComments(value) {
  const seen = new Set();
  const comments = [];
  for (const item of Array.isArray(value?.comments) ? value.comments : []) {
    if (!isObject(item) || !/^(\d{1,30}|t[0-9a-f]{16})$/u.test(String(item.id)) || seen.has(item.id)) continue;
    seen.add(item.id);
    const clip = isObject(item.video) ? item.video : null;
    comments.push({
      id: String(item.id), videoId: digits(item.videoId), threadId: digits(item.threadId) ?? String(item.id), text: str(item.text),
      at: typeof item.at === "string" ? item.at.slice(0, 40) : null, likes: Number.isFinite(item.likes) ? item.likes : null,
      video: clip ? { title: str(clip.title, 200), author: str(clip.author, 100), coverUrl: typeof clip.coverUrl === "string" && clip.coverUrl.startsWith("https://") ? clip.coverUrl.slice(0, 2000) : null } : null,
      source: item.source === "app" ? "app" : "notice",
      replies: (Array.isArray(item.replies) ? item.replies : []).map(sanitizeReply).filter(Boolean).slice(0, MAX_REPLIES),
    });
  }
  return sortAndCap(comments);
}

export class MyCommentStore {
  constructor(directory) {
    this.filePath = path.join(directory, "my-comments.json");
    this.cached = null;
    // 读取流程和发评论都会写，走同一条队列
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async ensureLoaded() {
    if (this.cached) return this.cached;
    let text;
    try { text = await readFile(this.filePath, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return this.cached = []; throw error; }
    try { return this.cached = sanitizeMyComments(JSON.parse(text)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 半截文件先留底再当空的用，免得下次存盘把它盖掉
      const broken = `${this.filePath}.broken-${Date.now()}`;
      await rename(this.filePath, broken).catch(() => copyFile(this.filePath, broken)).catch(() => { throw error; });
      return this.cached = [];
    }
  }

  read() {
    return this.cached ?? this.enqueue(() => this.ensureLoaded());
  }

  // change 拿到当前整份，返回新的整份
  update(change) {
    return this.enqueue(async () => {
      const comments = sanitizeMyComments({ comments: await change(await this.ensureLoaded()) });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      const file = await open(temporaryPath, "w", 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), comments })}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      return this.cached = comments;
    });
  }

  addSent(comment) {
    return this.update((current) => current.some((item) => item.id === comment.id) ? current : [comment, ...current]);
  }
}
