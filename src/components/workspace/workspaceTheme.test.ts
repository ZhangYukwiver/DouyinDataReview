import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { alpha, palettes, themeCss, workspaceColors, workspaceRadii } from "./workspaceTheme";

describe("workspace theme", () => {
  it("exposes every token as a CSS variable on web", () => {
    expect(workspaceColors.canvas).toBe("var(--ws-canvas)");
    expect(workspaceColors.textSecondary).toBe("var(--ws-text-secondary)");
    expect(workspaceColors.heat[3]).toBe("var(--ws-heat-3)");
    expect(workspaceRadii.pill).toBe("var(--ws-radius-pill)");
    expect(Object.keys(palettes.trace.colors)).toEqual(Object.keys(palettes.archive.colors));
  });

  it("writes both palettes so <html data-style> can switch them", () => {
    const css = themeCss();
    expect(css).toContain(`:root{--ws-canvas:${palettes.trace.colors.canvas}`);
    expect(css).toContain(`:root[data-style="archive"]{--ws-canvas:${palettes.archive.colors.canvas}`);
    expect(css).toContain("--ws-heat-5:#B07E40");
    expect(css).toContain("--ws-radius-pill:50px");
    expect(css).toContain("--ws-font-body:Inter");
  });

  it("keeps alpha colours in the form RN-web forwards untouched", () => {
    expect(alpha(workspaceColors.accent, 0.13)).toBe("var(--ws-unset, color-mix(in srgb, var(--ws-accent) 13%, transparent))");
  });
});
