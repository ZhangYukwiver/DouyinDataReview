import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { alpha, palettes, themeCss, workspaceColors, workspaceRadii } from "./workspaceTheme";
import { HEAVY_WEIGHT_HASHES, minimalCss } from "./minimalCss";
import { posterCss } from "./posterCss";
import { traceCss } from "./traceCss";
import { fx, ws } from "./motion";

// RN-web 自己的样式编译器：拿它现算字重原子类的类名，和 minimalCss 里写死的哈希核对（内部模块，没有类型声明）
// @ts-expect-error -- react-native-web 没给 StyleSheet/compiler 出 .d.ts
import { atomic as atomicUntyped } from "react-native-web/dist/cjs/exports/StyleSheet/compiler";
const atomic = atomicUntyped as (style: Record<string, unknown>) => [Record<string, unknown>, unknown];

describe("workspace theme", () => {
  it("exposes every token as a CSS variable on web", () => {
    expect(workspaceColors.canvas).toBe("var(--ws-canvas)");
    expect(workspaceColors.textSecondary).toBe("var(--ws-text-secondary)");
    expect(workspaceColors.heat[3]).toBe("var(--ws-heat-3)");
    expect(workspaceRadii.pill).toBe("var(--ws-radius-pill)");
    expect(Object.keys(palettes.trace.colors)).toEqual(Object.keys(palettes.minimal.colors));
    expect(Object.keys(palettes.poster.colors)).toEqual(Object.keys(palettes.minimal.colors));
    for (const key of ["heat", "slices", "avatars", "tints"] as const) {
      expect(palettes.trace.colors[key]).toHaveLength(palettes.minimal.colors[key].length);
      expect(palettes.poster.colors[key]).toHaveLength(palettes.minimal.colors[key].length);
    }
  });

  it("writes every palette so <html data-style> can switch them, minimal as the bare default", () => {
    const css = themeCss();
    expect(css).toContain(`:root{--ws-canvas:${palettes.minimal.colors.canvas}`);
    expect(css).toContain(`:root[data-style="trace"]{--ws-canvas:${palettes.trace.colors.canvas}`);
    expect(css).toContain(`:root[data-style="poster"]{--ws-canvas:${palettes.poster.colors.canvas}`);
    expect(css).not.toContain('data-style="archive"');
    expect(css).toContain("--ws-font-serif:Anton");
    expect(css).toContain("--ws-heat-5:#FF4A1C");
    expect(css).toContain("--ws-radius-pill:50px");
    expect(css).toContain("--ws-font-body:Inter");
  });

  it("ships the poster layout layer, scoped so minimal and trace never match it", () => {
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
    expect(posterCss).toContain("--ws-swarm:on");
    expect(posterCss).not.toContain('[data-testid="report-tile-swarm"]{display:none');
    expect(posterCss).toContain("steps(3,end)");
  });

  it("ships the minimal layout layer between poster and trace, scoped so the other two never match it", () => {
    const css = themeCss();
    expect(css).toContain(minimalCss);
    expect(css.indexOf(minimalCss)).toBeGreaterThan(css.indexOf(posterCss));
    expect(css.indexOf(minimalCss)).toBeLessThan(css.indexOf(traceCss));
    const rules = [...minimalCss.matchAll(/([^{};]+)\{([^{}]*)\}/gu)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    expect(rules.length).toBeGreaterThan(100);
    // 按括号深度切逗号：:where(a, b:not(c)) 里的逗号不算分隔
    const split = (selector: string) => {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < selector.length; index += 1) {
        const char = selector[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === "," && depth === 0) {
          parts.push(selector.slice(start, index));
          start = index + 1;
        }
      }
      return [...parts, selector.slice(start)];
    };
    for (const { selector } of rules) {
      if (/^(?:[\d.]+%\s*,?\s*)+$|^(?:from|to)$/u.test(selector)) continue;
      for (const part of split(selector)) expect(part.trim().startsWith(':root[data-style="minimal"]')).toBe(true);
    }
    // 极简的语言：不发光、不铺渐变，投影只有 none、描边用的 inset 1px 和主区白面板那一圈环境投影，字重不超过 500
    expect(minimalCss).not.toMatch(/gradient\(/u);
    expect(minimalCss).not.toContain("text-shadow");
    // 只看声明：选择器里认行内重字重的 [style*="font-weight: 700"] 不算
    expect(rules.map(({ body }) => body).join(";")).not.toMatch(/font-weight:\s*(?:[6-9]00|bold)/u);
    for (const [, value] of minimalCss.matchAll(/box-shadow:([^;!}]+)/gu)) expect(value!.trim()).toMatch(/^(?:none|inset 0 0 0 1px #[0-9A-F]{6}|0 0 48px rgba\(0,0,0,\.04\),0 0 12px rgba\(0,0,0,\.05\))$/u);
    // 为衬线调的 700–900 字重在工作台里收成 500：RN-web 打包版的类名只有 r-<哈希>，不带属性名，
    // 所以按哈希段认，开发版和打包版两种类名都要写；RN-web 升级后哈希变了，这里会先报错
    for (const weight of ["700", "800", "900", "bold"] as const) {
      const className = String(atomic({ fontWeight: weight })[0].fontWeight);
      const hash = className.slice(className.lastIndexOf("-") + 1);
      expect(HEAVY_WEIGHT_HASHES[weight]).toBe(hash);
      expect(minimalCss).toContain(`.r-${hash}`);
      expect(minimalCss).toContain(`.r-fontWeight-${hash}`);
    }
    expect(minimalCss).not.toContain('[class*="r-');
    // 装饰性的英文小标、编号水印收掉；采集器页和设置面板各有自己的样式，这里不碰
    expect(minimalCss).toMatch(/\[data-ws~="d-en"\],:root\[data-style="minimal"\] \[data-ws~="d-latin"\]\{display:none/u);
    expect(minimalCss).toContain('[data-ws~="w-bignum"]{display:none');
    expect(minimalCss).not.toContain("setup-workspace");
  });

  it("gives the minimal style the same token names as trace and poster, grey-green ground and one quiet grey for missing covers", () => {
    const { colors, fonts, radii } = palettes.minimal;
    expect(Object.keys(colors)).toEqual(Object.keys(palettes.trace.colors));
    for (const key of ["heat", "slices", "avatars", "tints"] as const) expect(colors[key]).toHaveLength(palettes.trace.colors[key].length);
    expect(Object.keys(fonts)).toEqual(Object.keys(palettes.trace.fonts));
    expect(Object.keys(radii)).toEqual(Object.keys(palettes.trace.radii));
    expect(colors.canvas).toBe("#F2F4F2");
    expect(colors.surface).toBe("#FFFFFF");
    expect(colors.shadow).toBe("none");
    expect(new Set(colors.tints)).toEqual(new Set(["#EFF1EF"]));
    // 图表分类色不用墨黑（正文、选中），也不借状态绿 / 琥珀 / 红；创作者中心的图表接的就是这一组
    for (const reserved of [colors.accent, colors.green, colors.amber, colors.danger]) expect(colors.slices).not.toContain(reserved);
    expect(minimalCss).toContain("--ws-chart-0:var(--ws-slices-0)");
  });

  it("ships the trace layout layer last, scoped so minimal and poster never match it", () => {
    const css = themeCss();
    expect(css.endsWith(traceCss)).toBe(true);
    expect(css.indexOf(traceCss)).toBeGreaterThan(css.indexOf(posterCss));
    const selectors = [...traceCss.matchAll(/([^{};]+)\{[^{}]*\}/gu)].map((match) => match[1]!.trim());
    expect(selectors.length).toBeGreaterThan(100);
    for (const group of selectors) {
      if (/^(?:[\d.]+%\s*,?\s*)+$|^(?:from|to)$/u.test(group)) continue;
      for (const selector of group.split(/,(?![^(]*\))/u)) expect(selector.trim().startsWith(':root[data-style="trace"]')).toBe(true);
    }
    // 墨夜底是一张固定层，不用 background-attachment:fixed，也不给大面积上毛玻璃
    expect(traceCss).toContain("/story/story-images/entry-night.jpg");
    expect(traceCss).not.toContain("background-attachment");
    expect(traceCss).not.toContain("backdrop-filter");
    // 呼吸光晕只动 opacity
    expect(traceCss).toMatch(/@keyframes tc-breathe\{from\{opacity:[\d.]+\}to\{opacity:[\d.]+\}\}/u);
    expect(traceCss).toContain('[data-ws~="btn"]');
  });

  it("gives the trace style a night palette: see-through canvas, cream text, blue actions, amber light", () => {
    const { colors, radii } = palettes.trace;
    expect(colors.canvas).toBe("transparent");
    expect(colors.text).toBe("#F6F1E4");
    expect(colors.buttonText).toBe("#41A1CF");
    expect(colors.signal).toBe("#EEA44E");
    expect(radii.large).toBe(24);
    expect(radii.pill).toBe(50);
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
