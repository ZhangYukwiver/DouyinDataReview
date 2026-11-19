import { describe, expect, it } from "vitest";
import { noteTags, parseCount, summarizeXhs } from "./xiaohongshu";

describe("小红书看板汇总", () => {
  it("赞数和话题解析", () => {
    expect([parseCount("1.2万"), parseCount("10w+"), parseCount("3456"), parseCount(""), parseCount(undefined)]).toEqual([12000, 100000, 3456, 0, 0]);
    expect(noteTags("周末去露营 #露营[话题]# #户外 好玩 #露营")).toEqual(["露营", "户外"]);
  });

  it("两类按笔记去重，作者和话题按篇数排", () => {
    const note = (id: string, author: string, extra = {}) => ({ note_id: id, author, url: `u/${id}`, ...extra });
    const summary = summarizeXhs({
      exported_at: "", account: { user_id: "u", nickname: "我" },
      lists: {
        favorites: { exported_at: "", notes: [note("1", "甲", { body: "#猫" }), note("2", "乙", { type: "video", liked_count: "2万" })] },
        likes: { exported_at: "", notes: [note("2", "乙"), note("3", "乙", { body: "#猫 #狗", liked_count: "50" })] },
      },
    });
    expect(summary.counts).toEqual({ favorites: 2, likes: 2 });
    expect([summary.notes.length, summary.both, summary.video]).toEqual([3, 1, 1]);
    expect(summary.notes.find(item => item.note_id === "2")?.in).toEqual(["favorites", "likes"]);
    expect(summary.authors).toEqual([{ name: "乙", count: 2 }, { name: "甲", count: 1 }]);
    expect(summary.tags[0]).toEqual({ name: "猫", count: 2 });
    expect(summary.hottest.map(item => item.note_id).slice(0, 2)).toEqual(["2", "3"]);
  });
});
