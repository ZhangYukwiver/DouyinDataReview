import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { alpha, palettes, themeCss, webPalettes, workspaceColors, workspaceRadii } from "./workspaceTheme";
import { archiveCss } from "./archiveCss";
import { posterCss } from "./posterCss";
import { traceCss } from "./traceCss";
import { fx, ws } from "./motion";

describe("workspace theme", () => {
  it("exposes every token as a CSS variable on web", () => {
    expect(workspaceColors.canvas).toBe("var(--ws-canvas)");
    expect(workspaceColors.textSecondary).toBe("var(--ws-text-secondary)");
    expect(workspaceColors.heat[3]).toBe("var(--ws-heat-3)");
    expect(workspaceRadii.pill).toBe("var(--ws-radius-pill)");
    expect(Object.keys(palettes.trace.colors)).toEqual(Object.keys(palettes.archive.colors));
    expect(Object.keys(palettes.poster.colors)).toEqual(Object.keys(palettes.archive.colors));
    expect(Object.keys(webPalettes.archive.colors)).toEqual(Object.keys(palettes.archive.colors));
    for (const key of ["heat", "slices", "avatars", "tints"] as const) {
      expect(webPalettes.archive.colors[key]).toHaveLength(palettes.archive.colors[key].length);
    }
  });

  it("writes both palettes so <html data-style> can switch them", () => {
    const css = themeCss();
    expect(css).toContain(`:root{--ws-canvas:${palettes.trace.colors.canvas}`);
    expect(css).toContain(`:root[data-style="archive"]{--ws-canvas:${webPalettes.archive.colors.canvas}`);
    expect(css).toContain(`:root[data-style="poster"]{--ws-canvas:${palettes.poster.colors.canvas}`);
    expect(css).toContain("--ws-font-serif:Anton");
    // 档案馆的热力最深一档仍是原色板的暖金，海报是信号橙
    expect(css).toContain("--ws-heat-5:#B07E40");
    expect(css).toContain("--ws-heat-5:#FF4A1C");
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
    expect(posterCss).toContain("--ws-swarm:on");
    expect(posterCss).not.toContain('[data-testid="report-tile-swarm"]{display:none');
    expect(posterCss).toContain("steps(3,end)");
  });

  it("keeps the archive's own dark palette on web, only lifting what was too faint to read", () => {
    // native 没有 CSS 变量，拿的是 palettes.archive 的实色：这组值不能动
    expect(palettes.archive.colors.canvas).toBe("#0A0B0B");
    expect(palettes.archive.colors.accent).toBe("#C59861");
    expect(palettes.archive.colors.textMuted).toBe("#7C7266");
    expect(palettes.archive.fonts.serif).toContain("Georgia");
    // web：同一套近黑纸面 + 暖金 + 冷青，主题色块 / 热力 / 饼图一个不换；只把弱化字和报错字提亮到能读
    const { colors, fonts, radii } = webPalettes.archive;
    const changed = Object.keys(colors).filter((key) => JSON.stringify(colors[key as keyof typeof colors]) !== JSON.stringify(palettes.archive.colors[key as keyof typeof colors]));
    expect(changed.sort()).toEqual(["danger", "textMuted"]);
    expect(colors.textMuted).toBe("#A09383");
    // 和海报彻底分开：不再出现信号橙、新闻纸、灰纸
    const values = JSON.stringify(colors).toUpperCase();
    for (const posterColour of ["#FF4A1D", "#FF4A1C", "#F2EEE6", "#F1EEE6", "#A9A397"]) expect(values).not.toContain(posterColour);
    // 整页宋体，数字和英文眉题用 Cormorant Garamond；直角
    expect(fonts.serif).toContain("Noto Serif SC");
    expect(fonts.body).toContain("Noto Serif SC");
    expect(fonts.didot).toContain("Cormorant Garamond");
    expect(fonts.mono).toContain("Cormorant Garamond");
    expect(Object.values(radii).every((value) => value === 0)).toBe(true);
    expect(webPalettes.trace).toBe(palettes.trace);
    expect(webPalettes.poster).toBe(palettes.poster);
  });

  it("ships the archive layout layer between poster and trace, scoped so poster and trace never match it", () => {
    const css = themeCss();
    expect(css).toContain(archiveCss);
    expect(css.indexOf(archiveCss)).toBeGreaterThan(css.indexOf(posterCss));
    expect(css.indexOf(archiveCss)).toBeLessThan(css.indexOf(traceCss));
    const rules = [...archiveCss.matchAll(/([^{};]+)\{([^{}]*)\}/gu)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    // 档案馆的版式层只在原来的组件样式上往前推一步，条数比海报少
    expect(rules.length).toBeGreaterThan(60);
    for (const { selector } of rules) {
      if (/^(?:[\d.]+%\s*,?\s*)+$|^(?:from|to)$/u.test(selector)) continue;
      for (const part of selector.split(/,(?![^(]*\))/u)) expect(part.trim().startsWith(':root[data-style="archive"]')).toBe(true);
    }
    // 补位块留着，群点照常画，不是一块空框
    expect(archiveCss).toContain("--ws-swarm:on");
    expect(archiveCss).not.toContain("report-tile-swarm\"]{display:none");
    // 不借海报的语言：没有斜线填充、粗墨框、硬投影、压窄黑体数字、打字机戳，也没有海报的橙 / 新闻纸 / 灰纸
    expect(archiveCss).not.toContain("-45deg");
    expect(archiveCss).not.toMatch(/border(?:-\w+)*:\s*[2-9]px solid/u);
    expect(archiveCss).not.toMatch(/box-shadow:\s*\d+px \d+px 0/u);
    expect(archiveCss).not.toContain("font-stretch");
    expect(archiveCss).not.toContain("Space Mono");
    for (const posterColour of ["#FF4A1D", "#F2EEE6", "#A9A397", "#0A0A0A"]) expect(archiveCss.toUpperCase()).not.toContain(posterColour);
    // 自己的记号：四角角饰、四角星、细点线；没有数据的地方铺星尘并写明缺什么
    expect(archiveCss).toContain('content:"✦"');
    expect(archiveCss).toContain("Cormorant Garamond");
    const dusted = rules.filter(({ body }) => body.includes("radial-gradient(circle at"));
    expect(dusted.length).toBeGreaterThan(0);
    for (const { selector } of dusted) expect(selector).toMatch(/d-empty|e-empty|d-swarm|"void"/u);
  });

  it("ships the trace layout layer last, scoped so archive and poster never match it", () => {
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
