import { describe, expect, it, vi } from "vitest";

// 只测从 AiEditWorkspace 导出的纯函数；整页依赖的 react-native、图标在 Node 里换成 RN-web 和空组件，好把文件加载进来
// @ts-expect-error -- react-native-web 没给 .d.ts
vi.mock("react-native", async () => await import("react-native-web"));
vi.mock("lucide-react-native", () => new Proxy({}, { has: () => true, get: (_target, key) => (key === "then" ? undefined : () => null) }));

import { SKILL_TOOLS } from "../../services/aiEditSkills";
import { boardBuilding } from "./AiEditWorkspace";

const action = (name: string) => ({ name, summary: name, ok: true });

describe("看板空画面上的「AI 正在搭时间线…」", () => {
  it("刚开始还没动作、动了时间线时说；没在跑不说", () => {
    expect(boardBuilding(true, { text: "" })).toBe(true);
    expect(boardBuilding(true, { text: "", actions: [action("see_images"), action("add_media_clip")] })).toBe(true);
    expect(boardBuilding(false, { text: "" })).toBe(false);
    expect(boardBuilding(false, undefined)).toBe(false);
  });

  it("正在跑技能命令、生成图片视频时（采集器挂着一句状态）不说", () => {
    expect(boardBuilding(true, { text: "", generating: "正在运行技能命令…" })).toBe(false);
    expect(boardBuilding(true, { text: "", actions: [action("add_media_clip")], generating: "正在生成图片…" })).toBe(false);
  });

  it("只看了图、用了技能这类不动时间线的事时不说", () => {
    expect(boardBuilding(true, { text: "", actions: [action("see_images"), ...[...SKILL_TOOLS].map(action)] })).toBe(false);
  });
});
