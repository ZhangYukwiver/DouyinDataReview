import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./videoAnalysis";

describe("parseMarkdown", () => {
  it("reads the shapes the analysis answer uses", () => {
    const blocks = parseMarkdown([
      "① 这条视频是**趣味演示**。",
      "",
      "② 表格分析",
      "| 维度 | 具体发现 | 时间戳/证据 | 创作启示 |",
      "|------|----------|------------|----------|",
      "| 开头钩子 | 像素角色<br>惊讶表情 | 0-2秒 | 反差感 |",
      "|13-15秒 | 加特效 | 全程 |",
      "### ④ 模板",
      "1. 美食短视频",
      "- 假设：换风格",
      "> 回答写到了长度上限",
    ].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["p", "p", "table", "h", "li", "li", "quote"]);
    const table = blocks[2] as { rows: string[][] };
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(["维度", "具体发现", "时间戳/证据", "创作启示"]);
    expect(table.rows[1]![1]).toBe("像素角色\n惊讶表情");
    expect(blocks[4]).toMatchObject({ marker: "1.", text: "美食短视频" });
  });

  it("takes rows split only by full-width bars as a table", () => {
    const blocks = parseMarkdown(["### ② 维度分析表", "维度｜具体发现｜时间戳或原话证据｜创作启示", "1.视频档案｜标题《80后》｜0-410秒｜明确基础信息", "普通一句话｜只有一个竖线"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["h", "table", "p"]);
    expect((blocks[1] as { rows: string[][] }).rows[1]).toEqual(["1.视频档案", "标题《80后》", "0-410秒", "明确基础信息"]);
  });
});
