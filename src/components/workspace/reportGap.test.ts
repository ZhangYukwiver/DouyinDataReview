import { describe, expect, it } from "vitest";

import { buildReportGapShape } from "./reportLayout";

describe("持续报告空当动画锚点", () => {
  it("把光点放进可见面积最深的台阶", () => {
    const shape = buildReportGapShape([220, 180, 120], 300, 300);

    expect(shape?.focus).toEqual({ x: 770, y: 90 });
  });
});

describe("海报风格的直角空当", () => {
  it("radius 为 0 时轮廓只经过台阶的角点，不切圆角", () => {
    const shape = buildReportGapShape([220, 180, 120], 300, 300, 0);
    const numbers = (shape?.path.match(/-?\d+(\.\d+)?/gu) ?? []).map(Number);
    const points = new Set<string>();
    for (let index = 0; index < numbers.length; index += 2) points.add(`${numbers[index]},${numbers[index + 1]}`);
    const corners = new Set(["0,100", "305,100", "305,60", "615,60", "615,0", "920,0", "920,180", "0,180"]);
    expect([...points].sort()).toEqual([...corners].sort());
  });

  it("默认仍是 14px 圆角", () => {
    expect(buildReportGapShape([220, 180, 120], 300, 300)?.path).toContain("Q0.0 100.0 14.0 100.0");
  });
});
