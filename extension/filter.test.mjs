import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

// 和页面里一样，把 filter.js 当普通脚本跑一遍，拿它挂在 globalThis 上的 DYF
const context = {};
vm.runInNewContext(readFileSync(new URL("./filter.js", import.meta.url), "utf8"), context);
const { compileRules, filterFeed } = context.DYF;

const aweme = (id, overrides = {}) => ({
  aweme_id: id, desc: "今天去吃火锅 #美食", author: { nickname: "小王", uid: "97119340507" },
  text_extra: [{ hashtag_name: "美食" }], video_tag: [{ tag_name: "生活" }], music: { title: "@小王创作的原声" }, ...overrides,
});

describe("推荐流词条", () => {
  it("注释和空行不算词条，字段前缀、正则、权重都认", () => {
    const rules = compileRules("# 注释\n\n营销号\nauthor:小王\n/带\\s*货/gi\n擦边@0.5");
    expect(rules.map((rule) => [rule.field, rule.weight, Boolean(rule.re), rule.value])).toEqual([
      ["any", 1, false, "营销号"], ["author", 1, false, "小王"], ["any", 1, true, null], ["any", 0.5, false, "擦边"],
    ]);
  });

  it("拿掉命中的视频，留下其余的，报出命中的那几条", () => {
    const json = { aweme_list: [aweme("7000000000000000001"), aweme("7000000000000000002", { desc: "沉浸式 带 货 现场", author: { nickname: "别人", uid: "1" } })] };
    const hits = filterFeed(json, compileRules("/带\\s*货/g"), true);
    expect(json.aweme_list.map((item) => item.aweme_id)).toEqual(["7000000000000000001"]);
    expect(hits).toMatchObject([{ id: "7000000000000000002", desc: "沉浸式 带 货 现场", author: "别人", matched: ["/带\\s*货/g"], score: 1 }]);
    // 去掉了 g：连着判两次结果一样
    expect(filterFeed({ aweme_list: [aweme("1", { desc: "带货" }), aweme("2", { desc: "带货" })] }, compileRules("/带货/g"), true)).toHaveLength(2);
  });

  it("字段限定只看那一栏；作者能按抖音号拦；话题和作品分类都算 tag", () => {
    const count = (text) => filterFeed({ aweme_list: [aweme("7000000000000000001")] }, compileRules(text), true).length;
    expect(count("desc:小王")).toBe(0);
    expect(count("author:小王")).toBe(1);
    expect(count("author:97119340507")).toBe(1);
    expect(count("tag:生活")).toBe(1);
    expect(count("music:火锅")).toBe(0);
    // 全角、大小写不影响
    expect(filterFeed({ aweme_list: [aweme("7000000000000000001", { desc: "今晚 HOT 推荐" })] }, compileRules("ｈｏｔ"), true)).toHaveLength(1);
  });

  it("权重凑够 1 才命中；只记录时一条不拿", () => {
    const json = { aweme_list: [aweme("7000000000000000001")] };
    expect(filterFeed(json, compileRules("火锅@0.5"), true)).toHaveLength(0);
    expect(filterFeed(json, compileRules("火锅@0.5\n美食@0.5"), true)).toHaveLength(1);
    const kept = { aweme_list: [aweme("7000000000000000001")] };
    expect(filterFeed(kept, compileRules("火锅"), false)).toHaveLength(1);
    expect(kept.aweme_list).toHaveLength(1);
  });

  it("按作者抖音号、短号以及作品标题匹配", () => {
    const item = aweme("7000000000000000001", { desc: "", item_title: "王者荣耀", caption: "游戏日常",
      author: { nickname: "小王", uid: "97119340507", unique_id: "game.creator", short_id: "123456" } });
    for (const rule of ["author:game.creator", "author:123456", "desc:王者荣耀", "游戏日常"]) {
      expect(filterFeed({ aweme_list: [item] }, compileRules(rule), true), rule).toHaveLength(1);
    }
  });

  it("命中的视频带上记录要用的字段，播放地址这些不带", () => {
    const full = aweme("7000000000000000009", {
      desc: "营销号带货", share_url: "https://www.iesdouyin.com/share/video/7000000000000000009/?x=1", create_time: 1_790_000_000, aweme_type: 0,
      author: { nickname: "甲", uid: "9", sec_uid: "MS4w", avatar_thumb: { url_list: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"] }, signature: "长签名" },
      video: { duration: 15000, cover: { url_list: ["https://c/1.jpg"] }, play_addr: { url_list: ["https://v/1.mp4"] }, bit_rate: [{}] },
      statistics: { digg_count: 5, comment_count: 1, share_count: 2, collect_count: 3, play_count: 0, admire_count: 9 },
      text_extra: [{ hashtag_name: "好物" }, { user_id: "1" }], music: { id_str: "77", title: "原声", author: "甲", play_url: { url_list: ["https://m/1.mp3"] } },
    });
    const [hit] = filterFeed({ aweme_list: [full] }, compileRules("营销号"), true);
    expect(JSON.parse(JSON.stringify(hit.aweme))).toEqual({
      aweme_id: "7000000000000000009", desc: "营销号带货", aweme_type: 0, create_time: 1_790_000_000,
      share_url: "https://www.iesdouyin.com/share/video/7000000000000000009/?x=1",
      author: { nickname: "甲", uid: "9", sec_uid: "MS4w", avatar_thumb: { url_list: ["https://a/1.jpg", "https://a/2.jpg"] } },
      video: { duration: 15000, cover: { url_list: ["https://c/1.jpg"] } },
      music: { id: "77", title: "原声", author: "甲" },
      text_extra: [{ hashtag_name: "好物" }],
      statistics: { play_count: 0, digg_count: 5, comment_count: 1, share_count: 2, collect_count: 3 },
    });
  });

  it("没有词条或回包里没有 aweme_list 时原样不动", () => {
    const json = { aweme_list: [aweme("7000000000000000001")] };
    expect(filterFeed(json, compileRules("# 只有注释"), true)).toEqual([]);
    expect(filterFeed({ status_code: 0 }, compileRules("火锅"), true)).toEqual([]);
    expect(json.aweme_list).toHaveLength(1);
  });

  it("推荐列表放在 data 里面时仍匹配和过滤，保留其他回包字段", () => {
    const json = { status_code: 0, data: { has_more: 1, aweme_list: [aweme("7000000000000000001")] } };
    expect(filterFeed(json, compileRules("火锅"), true)).toHaveLength(1);
    expect(json).toEqual({ status_code: 0, data: { has_more: 1, aweme_list: [] } });
  });
});
