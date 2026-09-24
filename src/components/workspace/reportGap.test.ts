import { describe, expect, it } from "vitest";

import { buildReportGapShape } from "./reportLayout";

describe("持续报告空当动画锚点", () => {
  it("把光点放进可见面积最深的台阶", () => {
    const shape = buildReportGapShape([220, 180, 120], 300, 300);

    expect(shape?.focus).toEqual({ x: 770, y: 90 });
  });
});
