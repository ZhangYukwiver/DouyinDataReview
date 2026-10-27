import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

// 和页面里一样，把 feedFilterRules.js 当普通脚本跑一遍，拿它挂在 globalThis 上的 DYF
const context = {};
vm.runInNewContext(readFileSync(new URL("./feedFilterRules.js", import.meta.url), "utf8"), context);
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
    expect(hits).toEqual([{ id: "7000000000000000002", desc: "沉浸式 带 货 现场", author: "别人", matched: ["/带\\s*货/g"], score: 1 }]);
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

  it("没有词条或回包里没有 aweme_list 时原样不动", () => {
    const json = { aweme_list: [aweme("7000000000000000001")] };
    expect(filterFeed(json, compileRules("# 只有注释"), true)).toEqual([]);
    expect(filterFeed({ status_code: 0 }, compileRules("火锅"), true)).toEqual([]);
    expect(json.aweme_list).toHaveLength(1);
  });
});
