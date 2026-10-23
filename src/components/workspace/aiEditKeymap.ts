// 看板的键位：一张表管所有快捷键，按键分发、按钮的悬停提示和右键菜单右边写的快捷键都读它（规格 C1）。
// comboOf / comboText / typingInto 的做法搬自 openfilm（studio/ui/src/lib/keymap.ts、lib/timeline-keys.ts、
// components/typing-target.ts），MIT License，Copyright (c) 2026 OpenFilm contributors。
//
// 组合键写成「修饰键按固定顺序 + 键名」，用 + 连起来：mod+shift+z。mod 在 Mac 上是 ⌘、别的系统是 Ctrl；
// Mac 上的 Control 单独记作 ctrl（所以 Mac 上按 Control+Z 不会撤销）；Windows 键不算快捷键。
// 字母按打出来的字读（跟着键盘布局走），打不出拉丁字母的布局（俄文、韩文）按它在美式键盘上的位置读。

export interface BoardKeySpec {
  /** 动作的中文叫法 */
  label: string;
  /** 默认的键；第一个是提示里写的那个 */
  keys: readonly string[];
  /** 不是 Mac 时改用这一组（Windows 上重做多一个 Ctrl+Y，删除的提示写 Delete） */
  other?: readonly string[];
  /** 会改工程：按住不放的连发只认第一下（C3） */
  edits?: boolean;
  /** 最后一次按在看板外面（左栏）时也响应；没标的要最后一次按在看板里才响应，免得抢左栏的方向键、空格和全选 */
  anywhere?: boolean;
}

const KEYS = {
  split: { label: "在播放头处切开", keys: ["mod+b"], edits: true, anywhere: true },
  remove: { label: "删除", keys: ["Backspace", "Delete"], other: ["Delete", "Backspace"], edits: true, anywhere: true },
  undo: { label: "撤销", keys: ["mod+z"], edits: true, anywhere: true },
  redo: { label: "重做", keys: ["mod+shift+z"], other: ["mod+shift+z", "mod+y"], edits: true, anywhere: true },
  copy: { label: "复制", keys: ["mod+c"] },
  paste: { label: "粘贴", keys: ["mod+v"], edits: true },
  duplicate: { label: "复制一份", keys: ["mod+d"], edits: true },
  "select-all": { label: "全选", keys: ["mod+a"] },
  "play-pause": { label: "播放 / 暂停", keys: ["Space"] },
  "frame-back": { label: "播放头往前一帧", keys: ["ArrowLeft"] },
  "frame-forward": { label: "播放头往后一帧", keys: ["ArrowRight"] },
  "jump-back": { label: "播放头往前十帧", keys: ["shift+ArrowLeft"] },
  "jump-forward": { label: "播放头往后十帧", keys: ["shift+ArrowRight"] },
  "prev-cut": { label: "跳到上一个剪切点", keys: ["ArrowUp"] },
  "next-cut": { label: "跳到下一个剪切点", keys: ["ArrowDown"] },
  start: { label: "跳到开头", keys: ["Home"] },
  end: { label: "跳到结尾", keys: ["End"] },
  "trim-start": { label: "裁掉播放头前面", keys: ["q"], edits: true },
  "trim-end": { label: "裁掉播放头后面", keys: ["w"], edits: true },
  // 片段在轨道上挪：带 ⇧ 是十帧，处理时看 event.shiftKey；连发允许，由处理方合并成一次提交（C7）
  "nudge-back": { label: "片段往前挪一帧", keys: ["alt+ArrowLeft", "alt+shift+ArrowLeft"] },
  "nudge-forward": { label: "片段往后挪一帧", keys: ["alt+ArrowRight", "alt+shift+ArrowRight"] },
  // 最后一次按在画面上、又选中了画面里的片段时，方向键是在画面上挪它（带 ⇧ 是 10 像素），否则落到上面的播放头动作
  "stage-left": { label: "在画面上往左挪", keys: ["ArrowLeft", "shift+ArrowLeft"] },
  "stage-right": { label: "在画面上往右挪", keys: ["ArrowRight", "shift+ArrowRight"] },
  "stage-up": { label: "在画面上往上挪", keys: ["ArrowUp", "shift+ArrowUp"] },
  "stage-down": { label: "在画面上往下挪", keys: ["ArrowDown", "shift+ArrowDown"] },
  "edit-text": { label: "编辑文字", keys: ["Enter"] },
  "zoom-in": { label: "放大时间线", keys: ["mod+=", "mod++"] },
  "zoom-out": { label: "缩小时间线", keys: ["mod+-"] },
  "zoom-reset": { label: "时间线回到默认大小", keys: ["mod+0"] },
  // 时间线工具栏（照 openfilm 的默认键位）
  "select-mode": { label: "选择工具", keys: ["a", "v"] },
  "split-mode": { label: "分割工具：点哪切哪", keys: ["b"] },
  "add-marker": { label: "在播放头处加标记", keys: ["m"], edits: true },
  "next-marker": { label: "跳到下一个标记", keys: ["shift+m"] },
  "prev-marker": { label: "跳到上一个标记", keys: ["alt+m"] },
  "toggle-snap": { label: "吸附", keys: ["n"] },
  "toggle-magnet": { label: "主轨磁吸", keys: ["p"] },
  "toggle-linkage": { label: "联动", keys: ["`"] },
  "toggle-preview-axis": { label: "预览轴", keys: ["s"] },
} satisfies Record<string, BoardKeySpec>;

export type BoardAction = keyof typeof KEYS;
export const BOARD_KEYS: Readonly<Record<BoardAction, BoardKeySpec>> = KEYS;
const ACTIONS = Object.keys(KEYS) as BoardAction[];

/** 这台机器是不是 Mac（决定 mod 是 ⌘ 还是 Ctrl）。 */
export const IS_MAC = (() => {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return /mac|iphone|ipad|ipod/iu.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "");
})();

export const keysOf = (action: BoardAction, mac = IS_MAC): readonly string[] => {
  const spec = BOARD_KEYS[action];
  return !mac && spec.other ? spec.other : spec.keys;
};

const indexes = new Map<boolean, Map<string, BoardAction[]>>();
/** 按下这个组合键对应的所有动作（同一个键在不同区域可以是不同动作，比如方向键）。 */
export function actionsOf(combo: string, mac = IS_MAC): BoardAction[] {
  let index = indexes.get(mac);
  if (!index) {
    index = new Map();
    for (const action of ACTIONS) for (const key of keysOf(action, mac)) index.set(key, [...(index.get(key) ?? []), action]);
    indexes.set(mac, index);
  }
  return index.get(combo) ?? [];
}

// ---------- 读按键 ----------

export interface KeyPress { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

const MODIFIERS = ["ctrl", "mod", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

// 标点和数字按在美式键盘上的位置读，带 ⇧ 打出来的符号还原成那个键
const CODE_KEYS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
};
const PUNCTUATION = new Set(Object.values(CODE_KEYS).filter((key) => !/\d/u.test(key)));
const SHIFTED: Record<string, string> = {
  "~": "`", _: "-", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "OS", "Fn", "Hyper", "Super", "AltGraph"]);

function letterOf(event: Pick<KeyPress, "key" | "code">): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (/^[a-z]$/u.test(key)) return key;
  const code = /^Key([A-Z])$/u.exec(event.code ?? "")?.[1];
  return code ? code.toLowerCase() : key;
}

function keyName(event: Pick<KeyPress, "key" | "code" | "shiftKey" | "altKey">): string {
  if (event.key === " " || event.code === "Space") return "Space";
  const letter = letterOf(event);
  if (/^[a-z]$/u.test(letter)) return letter;
  if (event.key === "+") return "+";
  if (event.key.length === 1 && !event.shiftKey && !event.altKey && PUNCTUATION.has(event.key)) return event.key;
  const byCode = CODE_KEYS[event.code ?? ""];
  if (byCode) return byCode;
  if (event.key.length === 1) return SHIFTED[event.key] ?? event.key.toLowerCase();
  return event.key === "Esc" ? "Escape" : event.key;
}

/** 一次按键是哪个组合键；只按了修饰键、或者按的是另一个系统的修饰键（不是 Mac 时的 Windows 键）为 null。 */
export function comboOf(event: KeyPress, mac = IS_MAC): string | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === "Dead" || event.key === "Unidentified" || !event.key) return null;
  if (!mac && event.metaKey) return null;
  const key = keyName(event);
  const mods = new Set<Modifier>();
  if (mac && event.ctrlKey) mods.add("ctrl");
  if (mac ? event.metaKey : event.ctrlKey) mods.add("mod");
  if (event.altKey) mods.add("alt");
  // ⌘+ 在美式键盘上是 ⌘⇧=，带不带 ⇧ 都算 +
  if (event.shiftKey && key !== "+") mods.add("shift");
  return [...MODIFIERS.filter((item) => mods.has(item)), key].join("+");
}

// ---------- 写成提示 ----------

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  ArrowLeft: ["←", "←"], ArrowRight: ["→", "→"], ArrowUp: ["↑", "↑"], ArrowDown: ["↓", "↓"],
  Backspace: ["⌫", "Backspace"], Delete: ["⌦", "Delete"], Escape: ["Esc", "Esc"], Enter: ["↵", "Enter"],
  Space: ["Space", "Space"], Tab: ["Tab", "Tab"], "-": ["−", "−"],
};
const MOD_LABELS: Record<Modifier, [mac: string, other: string]> = { ctrl: ["⌃", "Ctrl"], mod: ["⌘", "Ctrl"], alt: ["⌥", "Alt"], shift: ["⇧", "Shift"] };

/** 组合键写成按键提示：Mac 上连写（⌘⇧Z、⌫），别的系统用 + 连（Ctrl+Shift+Z、Delete）。 */
export function comboText(combo: string, mac = IS_MAC): string {
  const match = /^((?:(?:ctrl|mod|alt|shift)\+)*)(.*)$/u.exec(combo);
  if (!match) return combo;
  const mods = new Set(match[1]!.split("+").filter(Boolean) as Modifier[]);
  // 不是 Mac 时 Control 就是 mod
  if (!mac && mods.delete("ctrl")) mods.add("mod");
  const key = match[2]!;
  const pick = (labels: [string, string]) => labels[mac ? 0 : 1];
  const caps = MODIFIERS.filter((item) => mods.has(item)).map((item) => pick(MOD_LABELS[item]));
  const known = KEY_LABELS[key];
  if (key) caps.push(known ? pick(known) : key.length === 1 ? key.toUpperCase() : key);
  return caps.join(mac ? "" : "+");
}

/** 动作的快捷键提示（它的第一个键），比如 ⌘B、Ctrl+B。 */
export const shortcutText = (action: BoardAction, mac = IS_MAC): string => comboText(keysOf(action, mac)[0] ?? "", mac);

// ---------- 什么时候看板不接键 ----------

type ElementLike = { nodeType?: number; tagName?: string; type?: string; isContentEditable?: boolean; parentElement?: ElementLike | null; closest?: (selector: string) => ElementLike | null };

function elementOf(target: unknown): ElementLike | null {
  if (!target || typeof target !== "object" || !("nodeType" in target)) return null;
  const node = target as ElementLike;
  return node.nodeType === 1 ? node : node.nodeType === 3 ? node.parentElement ?? null : null;
}

// 拖完滑块、点过颜色或勾选框后焦点还留在上面，这些不算在打字，不然空格、⌘Z、Delete 全都没反应
const NON_TEXT_INPUTS = new Set(["range", "color", "checkbox", "radio", "button", "submit", "reset", "file", "image"]);

/** 焦点在能打字的地方（文字输入框、多行框、下拉框、可编辑的元素）：看板的快捷键不管。不用 instanceof 判断（C2）。 */
export function typingInto(target: unknown): boolean {
  const element = elementOf(target);
  if (!element) return false;
  const field = typeof element.closest === "function" ? element.closest("input, textarea, select") : null;
  if (field) return !(field.tagName === "INPUT" && typeof field.type === "string" && NON_TEXT_INPUTS.has(field.type));
  return Boolean(element.isContentEditable);
}

/** 在对话框或菜单里：键是它们的，看板不接。 */
export function inMenuOrDialog(target: unknown): boolean {
  const element = elementOf(target);
  return Boolean(element && typeof element.closest === "function" && element.closest('[role="dialog"], [role="menu"]'));
}

/** 输入法正在选字。 */
export const composing = (event: { isComposing?: boolean; keyCode?: number }) => Boolean(event.isComposing) || event.keyCode === 229;

/**
 * 看板该不该接这一下键：输入法选字、焦点在输入框里、在对话框或菜单里都不接，返回 null；
 * 否则返回组合键和它对应的动作（可能是空数组）。active 是 document.activeElement。
 */
export function readBoardKey(
  event: KeyPress & { isComposing?: boolean; keyCode?: number; target?: unknown },
  active: unknown,
  mac = IS_MAC,
): { combo: string; actions: BoardAction[] } | null {
  if (composing(event) || typingInto(event.target) || typingInto(active) || inMenuOrDialog(event.target) || inMenuOrDialog(active)) return null;
  const combo = comboOf(event, mac);
  return combo ? { combo, actions: actionsOf(combo, mac) } : null;
}

/**
 * 详情卡文字框里的键：⌘↵ 保存，Esc 还原；输入法选字时都不算。
 * RN-web 的 TextInput 在 keydown 上就 stopPropagation，看板的 Esc 分层收不到，只能在框自己的 onKeyPress 里接。
 */
export function textBoxKey(event: KeyPress & { isComposing?: boolean; keyCode?: number }, mac = IS_MAC): "save" | "revert" | null {
  if (composing(event)) return null;
  if (event.key === "Escape") return "revert";
  return comboOf(event, mac) === "mod+Enter" ? "save" : null;
}
