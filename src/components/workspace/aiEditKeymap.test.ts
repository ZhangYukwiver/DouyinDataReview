import { describe, expect, it } from "vitest";

import { actionsOf, BOARD_KEYS, comboOf, comboText, keysOf, readBoardKey, shortcutText, textBoxKey, typingInto, type KeyPress } from "./aiEditKeymap";

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });

// 假的 DOM 元素：closest 按标签名和 role 认，够 typingInto / inMenuOrDialog 用
function element(tagName: string, extra: { type?: string; isContentEditable?: boolean; role?: string; parent?: object | null } = {}) {
  const node: Record<string, unknown> = { nodeType: 1, tagName, type: extra.type, isContentEditable: extra.isContentEditable ?? false, parentElement: extra.parent ?? null };
  node.closest = (selector: string) => {
    for (let at: Record<string, unknown> | null = node; at; at = (at.parentElement as Record<string, unknown> | null) ?? null) {
      const tag = String(at.tagName).toLowerCase();
      if (selector.split(",").some((part) => part.trim() === tag || (at!.role && part.includes(`[role="${at!.role}"]`)))) return at;
    }
    return null;
  };
  if (extra.role) node.role = extra.role;
  return node;
}

describe("读按键", () => {
  it("Mac 上 ⌘ 是 mod，Control 单独记作 ctrl，Control+Z 不是撤销", () => {
    expect(comboOf(press("b", { metaKey: true }), true)).toBe("mod+b");
    expect(comboOf(press("z", { ctrlKey: true }), true)).toBe("ctrl+z");
    expect(actionsOf("ctrl+z", true)).toEqual([]);
    expect(comboOf(press("Z", { metaKey: true, shiftKey: true }), true)).toBe("mod+shift+z");
  });

  it("Windows 上 Ctrl 是 mod，Windows 键不算快捷键", () => {
    expect(comboOf(press("z", { ctrlKey: true }), false)).toBe("mod+z");
    expect(comboOf(press("z", { metaKey: true }), false)).toBeNull();
  });

  it("修饰键按固定顺序；空格、方向键、只按修饰键", () => {
    expect(comboOf(press("ArrowLeft", { altKey: true, shiftKey: true }), true)).toBe("alt+shift+ArrowLeft");
    expect(comboOf(press(" "), true)).toBe("Space");
    expect(comboOf(press("Shift", { shiftKey: true }), true)).toBeNull();
  });

  it("打不出拉丁字母的布局按美式键盘的位置读；⌘+ 带不带 ⇧ 都是 +", () => {
    expect(comboOf(press("и", { code: "KeyB", metaKey: true }), true)).toBe("mod+b");
    expect(comboOf(press("+", { code: "Equal", metaKey: true, shiftKey: true }), true)).toBe("mod++");
    expect(comboOf(press("=", { code: "Equal", metaKey: true }), true)).toBe("mod+=");
  });
});

describe("详情卡文字框自己接的键", () => {
  it("Esc 还原、⌘↵ 保存；输入法选字时都不算", () => {
    expect(textBoxKey(press("Escape"), true)).toBe("revert");
    expect(textBoxKey(press("Escape", { shiftKey: true }), true)).toBe("revert");
    expect(textBoxKey(press("Enter", { metaKey: true }), true)).toBe("save");
    expect(textBoxKey(press("Enter", { ctrlKey: true }), false)).toBe("save");
    expect(textBoxKey(press("Enter"), true)).toBeNull();
    expect(textBoxKey(press("a"), true)).toBeNull();
    expect(textBoxKey({ ...press("Escape"), isComposing: true }, true)).toBeNull();
    expect(textBoxKey({ ...press("Enter", { metaKey: true }), keyCode: 229 }, true)).toBeNull();
  });
});

describe("键位表", () => {
  it("重做：Mac 只有 ⌘⇧Z，Windows 多一个 Ctrl+Y", () => {
    expect(actionsOf("mod+shift+z", true)).toEqual(["redo"]);
    expect(actionsOf("mod+y", true)).toEqual([]);
    expect(actionsOf("mod+y", false)).toEqual(["redo"]);
  });

  it("同一个键在不同区域是不同动作：方向键既是播放头走一帧，也是画面上微调", () => {
    expect(actionsOf("ArrowLeft", true)).toEqual(["frame-back", "stage-left"]);
    expect(actionsOf("alt+shift+ArrowLeft", true)).toEqual(["nudge-back"]);
  });

  it("每个动作都有中文叫法和至少一个键；会改工程的都标了", () => {
    for (const [action, spec] of Object.entries(BOARD_KEYS)) {
      expect(spec.label, action).toMatch(/[一-龥]/u);
      expect(keysOf(action as keyof typeof BOARD_KEYS, true).length, action).toBeGreaterThan(0);
    }
    for (const action of ["split", "remove", "undo", "redo", "paste", "duplicate", "trim-start", "trim-end"] as const) expect(BOARD_KEYS[action].edits, action).toBe(true);
  });
});

describe("写成提示", () => {
  it("Mac 连写，别的系统用 + 连", () => {
    expect(comboText("mod+b", true)).toBe("⌘B");
    expect(comboText("mod+b", false)).toBe("Ctrl+B");
    expect(comboText("mod+shift+z", true)).toBe("⌘⇧Z");
    expect(comboText("mod+shift+z", false)).toBe("Ctrl+Shift+Z");
    expect(comboText("alt+ArrowLeft", true)).toBe("⌥←");
    expect(comboText("ctrl+z", false)).toBe("Ctrl+Z");
  });

  it("动作的提示：删除在 Mac 上写 ⌫、别的系统写 Delete", () => {
    expect(shortcutText("remove", true)).toBe("⌫");
    expect(shortcutText("remove", false)).toBe("Delete");
    expect(shortcutText("split", true)).toBe("⌘B");
    expect(shortcutText("edit-text", true)).toBe("↵");
    expect(shortcutText("trim-start", false)).toBe("Q");
  });
});

describe("什么时候看板不接键", () => {
  it("文字框、多行框、可编辑元素算在打字；滑块、勾选框、按钮不算", () => {
    expect(typingInto(element("INPUT", { type: "text" }))).toBe(true);
    expect(typingInto(element("TEXTAREA"))).toBe(true);
    expect(typingInto(element("DIV", { isContentEditable: true }))).toBe(true);
    expect(typingInto(element("INPUT", { type: "range" }))).toBe(false);
    expect(typingInto(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(typingInto(element("BUTTON"))).toBe(false);
    expect(typingInto(null)).toBe(false);
    // 文字节点按它的父元素算
    expect(typingInto({ nodeType: 3, parentElement: element("TEXTAREA") })).toBe(true);
  });

  it("输入法在选字、焦点在输入框、在菜单或对话框里都不接；其余给出组合键和动作", () => {
    const body = element("BODY");
    expect(readBoardKey({ ...press("Enter"), isComposing: true, target: body }, body, true)).toBeNull();
    expect(readBoardKey({ ...press("Enter"), keyCode: 229, target: body }, body, true)).toBeNull();
    expect(readBoardKey({ ...press("Backspace"), target: element("TEXTAREA") }, body, true)).toBeNull();
    expect(readBoardKey({ ...press("ArrowDown"), target: element("BUTTON", { parent: element("DIV", { role: "menu" }) }) }, body, true)).toBeNull();
    expect(readBoardKey({ ...press(" "), target: element("INPUT", { type: "range" }) }, body, true)).toEqual({ combo: "Space", actions: ["play-pause"] });
    expect(readBoardKey({ ...press("b", { metaKey: true }), target: body }, body, true)).toEqual({ combo: "mod+b", actions: ["split"] });
  });
});
