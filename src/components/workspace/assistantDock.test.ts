import { describe, expect, it } from "vitest";
import { clampSpot, dockPlacement, loadDockSpot } from "./assistantDock";

describe("assistant dock placement", () => {
  it("opens up and to the left from the default bottom-right corner", () => {
    const place = dockPlacement({ right: 20, bottom: 20 }, 1280, 800);
    expect(place.style).toMatchObject({ right: 20, bottom: 20, alignItems: "flex-end", flexDirection: "column" });
    expect(place.panelWidth).toBe(400);
    expect(place.panelHeight).toBe(640);
  });

  it("opens down and to the right when dragged to the top-left", () => {
    const place = dockPlacement({ right: 1280 - 48 - 30, bottom: 800 - 48 - 40 }, 1280, 800);
    expect(place.style).toMatchObject({ left: 30, top: 40, alignItems: "flex-start", flexDirection: "column-reverse" });
    // 下面剩 800 - 40 - 48 = 712，减去间距和边距
    expect(place.panelHeight).toBe(640);
  });

  it("shrinks the panel to the room left on that side", () => {
    // 圆钮顶在 314（下半边）→ 往上开，上面只剩 314 减间距和边距
    expect(dockPlacement({ right: 20, bottom: 250 }, 900, 612).panelHeight).toBe(314 - 12 - 12);
    // 圆钮顶在 264（上半边）→ 往下开
    expect(dockPlacement({ right: 20, bottom: 300 }, 900, 612).panelHeight).toBe(612 - 264 - 48 - 12 - 12);
  });

  it("keeps the side it started with while dragging", () => {
    // 起拖时在右下（往上开），拖到上半边也还往上开，只是变矮
    const place = dockPlacement({ right: 20, bottom: 500 }, 1280, 800, undefined, { onLeft: false, onTop: false });
    expect(place.style).toMatchObject({ bottom: 500, flexDirection: "column" });
    expect(place.panelHeight).toBe(800 - 500 - 48 - 24);
    expect(dockPlacement({ right: 20, bottom: 500 }, 1280, 800).side).toEqual({ onLeft: false, onTop: true });
  });

  it("stays on the last side after a drop while the panel still fits there", () => {
    // 圆钮拖到左半边，但面板往左展开仍放得下 → 不翻
    expect(dockPlacement({ right: 700, bottom: 20, onLeft: false, onTop: false }, 1280, 800).side).toEqual({ onLeft: false, onTop: false });
    // 往左只剩 1280 - 900 - 12 = 368 < 400 → 换到右边
    expect(dockPlacement({ right: 900, bottom: 20, onLeft: false, onTop: false }, 1280, 800).side.onLeft).toBe(true);
  });

  it("uses the size the user dragged to, but never more than the room on that side", () => {
    expect(dockPlacement({ right: 20, bottom: 20 }, 1280, 800, { width: 560, height: 420 })).toMatchObject({ panelWidth: 560, panelHeight: 420 });
    expect(dockPlacement({ right: 20, bottom: 20 }, 900, 612, { width: 1200, height: 900 })).toMatchObject({ panelWidth: 900 - 20 - 12, panelHeight: 612 - 20 - 48 - 24 });
  });

  it("keeps the button on screen after the window shrinks", () => {
    expect(clampSpot({ right: 2000, bottom: -50 }, 900, 612)).toEqual({ right: 900 - 48 - 12, bottom: 12 });
  });

  it("falls back to the corner when nothing usable is saved", () => {
    expect(loadDockSpot({ getItem: () => "{\"right\":\"x\"}" })).toEqual({ right: 20, bottom: 20 });
    expect(loadDockSpot({ getItem: () => "{\"right\":100,\"bottom\":200,\"onLeft\":true}" })).toEqual({ right: 100, bottom: 200, onLeft: true });
  });
});
