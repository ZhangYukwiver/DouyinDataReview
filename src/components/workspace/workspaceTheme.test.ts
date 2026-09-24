import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { alpha, palettes, themeCss, workspaceColors, workspaceRadii } from "./workspaceTheme";
import { posterCss } from "./posterCss";
import { fx, ws } from "./motion";

describe("workspace theme", () => {
  it("exposes every token as a CSS variable on web", () => {
    expect(workspaceColors.canvas).toBe("var(--ws-canvas)");
    expect(workspaceColors.textSecondary).toBe("var(--ws-text-secondary)");
    expect(workspaceColors.heat[3]).toBe("var(--ws-heat-3)");
    expect(workspaceRadii.pill).toBe("var(--ws-radius-pill)");
    expect(Object.keys(palettes.trace.colors)).toEqual(Object.keys(palettes.archive.colors));
    expect(Object.keys(palettes.poster.colors)).toEqual(Object.keys(palettes.archive.colors));
  });

  it("writes both palettes so <html data-style> can switch them", () => {
    const css = themeCss();
    expect(css).toContain(`:root{--ws-canvas:${palettes.trace.colors.canvas}`);
    expect(css).toContain(`:root[data-style="archive"]{--ws-canvas:${palettes.archive.colors.canvas}`);
    expect(css).toContain(`:root[data-style="poster"]{--ws-canvas:${palettes.poster.colors.canvas}`);
    expect(css).toContain("--ws-font-serif:Anton");
    expect(css).toContain("--ws-heat-5:#B07E40");
    expect(css).toContain("--ws-radius-pill:50px");
    expect(css).toContain("--ws-font-body:Inter");
  });

  it("ships the poster layout layer, scoped so archive and trace never match it", () => {
    const css = themeCss();
    expect(css).toContain(posterCss);
    // 海报层之前的部分（三套令牌 + 通用动效）不认识 data-ws
    expect(css.slice(0, css.indexOf(posterCss))).not.toContain("data-ws");
    // 海报层里每条规则的选择器都挂在 :root[data-style="poster"] 下（@keyframes 的百分比帧除外）
    const selectors = [...posterCss.matchAll(/([^{};]+)\{[^{}]*\}/gu)].map((match) => match[1]!.trim());
    expect(selectors.length).toBeGreaterThan(100);
    for (const group of selectors) {
      if (/^(?:[\d.]+%\s*,?\s*)+$|^(?:from|to)$/u.test(group)) continue;
      for (const selector of group.split(",")) expect(selector.trim().startsWith(':root[data-style="poster"]')).toBe(true);
    }
    expect(posterCss).toContain('[data-ws~="btn"]');
    expect(posterCss).toContain("--ws-swarm:off");
    expect(posterCss).toContain("steps(3,end)");
  });

  it("marks layout roles with data-ws only, next to the motion flags", () => {
    expect(ws("btn", false, "on")).toEqual({ dataSet: { ws: "btn on" } });
    expect(ws(null, undefined)).toEqual({ dataSet: {} });
    expect(fx({ hover: "raise", ws: "btn-sig" })).toEqual({ dataSet: { hover: "raise", ws: "btn-sig" } });
    expect(fx({ motion: "rise", i: 2 })).toEqual({ dataSet: { motion: "rise", i: "2" } });
  });

  it("keeps alpha colours in the form RN-web forwards untouched", () => {
    expect(alpha(workspaceColors.accent, 0.13)).toBe("var(--ws-unset, color-mix(in srgb, var(--ws-accent) 13%, transparent))");
  });
});
