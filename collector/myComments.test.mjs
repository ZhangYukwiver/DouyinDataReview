import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MyCommentStore, collectMyComments, readNotice, sentComment } from "./myComments.mjs";

const VIDEO = "7689353274332740022";
const THREAD = "7689869047429825317";
const aweme = { aweme_id: VIDEO, desc: "别人的视频\n#话题", author: { nickname: "作者" }, video: { cover: { url_list: ["https://p3.douyinpic.com/cover.jpg"] } } };
const notice = (type, cid, at, extra = {}) => ({
  create_time: at,
  comment: {
    comment_type: type, parent_id: THREAD, aweme,
    comment: { cid, aweme_id: VIDEO, text: `回复${cid}`, user: { uid: "42", nickname: "网友", avatar_thumb: { url_list: ["https://p3.douyinpic.com/a.jpg"] } }, reply_to_username: "" },
    ...extra,
  },
});

// 假的抖音：通知按页给，评论区按 insert_ids 把楼主顶上来
function fakeApi(pages, root = { cid: THREAD, text: "我的楼主评论", create_time: 1790000000, digg_count: 3 }) {
  const calls = [];
  return {
    calls,
    async request(pathname, { query }) {
      calls.push({ pathname, query });
      if (pathname === "/aweme/v1/web/comment/list/") return { status_code: 0, comments: root ? [root] : [] };
      const index = calls.filter((call) => call.pathname === pathname).length - 1;
      return { status_code: 0, notice_list_v2: pages[index] ?? [], has_more: index < pages.length - 1 ? 1 : 0, max_time: String(1790000000 - index) };
    },
  };
}

describe("my comments", () => {
  it("keeps replies to my comments and replies in my thread, leaves out comments on my own works", () => {
    expect(readNotice(notice(1, "1001", 1790000100))).toBeNull();
    expect(readNotice(notice(11, "1002", 1790000100, { reply_comment: { text: "别人" } }))).toBeNull();
    expect(readNotice(notice(2, "1003", 1790000100, { reply_comment: { text: "我说的" } }))).toMatchObject({ mine: "我说的", threadId: THREAD, videoId: VIDEO, reply: { id: "1003", user: { name: "网友" } } });
    const inThread = readNotice(notice(12, "1004", 1790000100, { reply_comment: { text: "楼里别人说的" }, comment: { ...notice(12, "1004", 0).comment.comment, reply_to_username: "路人" } }));
    expect(inThread).toMatchObject({ mine: null, reply: { replyToName: "路人", quote: "楼里别人说的" } });
  });

  it("groups replies under my comment, fills in the thread root once, never marks notices read and adds nothing twice", async () => {
    const pages = [[
      notice(12, "2003", 1790000300, { reply_comment: { text: "楼里别人说的" } }),
      notice(1, "2002", 1790000200),
      notice(2, "2001", 1790000100, { reply_comment: { text: "我的楼主评论" } }),
    ]];
    const api = fakeApi(pages);
    const first = await collectMyComments(api, [], { pause: 0 });
    expect(first.added).toBe(2);
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0]).toMatchObject({ id: THREAD, text: "我的楼主评论", likes: 3, video: { title: "别人的视频", author: "作者" } });
    expect(first.comments[0].replies.map((reply) => reply.id)).toEqual(["2003", "2001"]);
    expect(api.calls.filter((call) => call.pathname === "/aweme/v1/web/comment/list/")).toHaveLength(1);
    expect(api.calls.every((call) => call.pathname !== "/aweme/v1/web/notice/" || call.query.is_mark_read === "0")).toBe(true);

    const again = fakeApi(pages);
    const second = await collectMyComments(again, first.comments, { pause: 0 });
    expect(second.added).toBe(0);
    expect(second.comments).toEqual(first.comments);
    expect(again.calls.map((call) => call.pathname)).toEqual(["/aweme/v1/web/notice/"]);
  });

  it("keeps my reply inside someone else's thread as its own comment, and hangs later replies on comments sent from the app", async () => {
    const sent = sentComment("7000000000000000001", { id: "3000", text: "从应用里发的", publishedAt: "2026-10-31T01:00:00.000Z" });
    // 回复我在应用里发的楼主评论：楼就是那条评论自己
    const toApp = notice(2, "3002", 1790000200, { reply_comment: { text: "从应用里发的" }, parent_id: "3000", aweme: null });
    toApp.comment.comment.aweme_id = "7000000000000000001";
    const pages = [[toApp, notice(2, "3001", 1790000100, { reply_comment: { text: "我在别人楼里的回复" } })]];
    const { comments } = await collectMyComments(fakeApi(pages, { cid: THREAD, text: "别人的楼主评论" }), [sent], { pause: 0 });
    const app = comments.find((comment) => comment.id === "3000");
    expect(app.replies.map((reply) => reply.id)).toEqual(["3002"]);
    const inOther = comments.find((comment) => comment.text === "我在别人楼里的回复");
    expect(inOther).toMatchObject({ threadId: THREAD, at: null });
    expect(inOther.id).toMatch(/^t[0-9a-f]{16}$/u);
  });

  it("keeps replies on works that are gone and to comments that are only an emoji", async () => {
    const gone = notice(2, "5001", 1790000200, { reply_comment: { text: "我说的" }, aweme: null });
    gone.comment.comment.aweme_id = undefined;
    const emoji = notice(2, "5002", 1790000100, { reply_comment: { text: "" } });
    emoji.comment.comment.text = "";
    const api = fakeApi([[gone, emoji]], null);
    const { comments } = await collectMyComments(api, [], { pause: 0 });
    expect(comments.find((comment) => comment.text === "我说的")).toMatchObject({ videoId: null, video: null, replies: [{ id: "5001" }] });
    expect(comments.find((comment) => comment.text === "[表情]")).toMatchObject({ videoId: VIDEO, replies: [{ id: "5002", text: "[表情]" }] });
    // 没有作品编号就不去评论区补楼主
    expect(api.calls.filter((call) => call.pathname === "/aweme/v1/web/comment/list/")).toHaveLength(1);
  });

  it("stores to disk, keeps a broken file aside and ignores the same sent comment twice", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dy-my-comments-"));
    try {
      await writeFile(path.join(directory, "my-comments.json"), "{\"comments\": [");
      const store = new MyCommentStore(directory);
      expect(await store.read()).toEqual([]);
      expect((await readdir(directory)).some((name) => name.startsWith("my-comments.json.broken-"))).toBe(true);
      const sent = sentComment(VIDEO, { id: "4000", text: "一条" });
      await store.addSent(sent);
      await store.addSent(sent);
      expect(await new MyCommentStore(directory).read()).toMatchObject([{ id: "4000", source: "app", text: "一条" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
