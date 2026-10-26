import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { MENU_EDGE, menuPosition, menuStep } from "./ContextMenu";

describe("右键菜单放在哪", () => {
  const viewport = { width: 1000, height: 800 };

  it("默认往右下长", () => {
    expect(menuPosition({ x: 100, y: 100 }, { width: 200, height: 300 }, viewport)).toEqual({ left: 100, top: 100 });
  });

  it("右边放不下往左翻；下面放不下、上面更宽敞时往上翻", () => {
    expect(menuPosition({ x: 900, y: 700 }, { width: 200, height: 300 }, viewport)).toEqual({ left: 700, top: 400 });
  });

  it("两边都放不下就贴边留 8px；还没量出大小时先放在指针处", () => {
    expect(menuPosition({ x: 500, y: 300 }, { width: 200, height: 900 }, viewport).top).toBe(MENU_EDGE);
    expect(menuPosition({ x: 2, y: 2 }, { width: 200, height: 100 }, viewport)).toEqual({ left: MENU_EDGE, top: MENU_EDGE });
    expect(menuPosition({ x: 900, y: 700 }, { width: 0, height: 0 }, viewport)).toEqual({ left: 900, top: 700 });
  });
});

describe("菜单里的方向键", () => {
  it("还没用过键盘时 ↓ 落第一项、↑ 落最后一项；到头绕回去", () => {
    expect(menuStep(-1, 1, 4)).toBe(0);
    expect(menuStep(-1, -1, 4)).toBe(3);
    expect(menuStep(3, 1, 4)).toBe(0);
    expect(menuStep(0, -1, 4)).toBe(3);
    expect(menuStep(-1, 1, 0)).toBe(-1);
  });
});
