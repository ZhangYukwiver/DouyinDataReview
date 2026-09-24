import { Platform } from "react-native";

import type { AppStyle } from "../../services/appStyle";
import { motionCss } from "./motion";
import { posterCss } from "./posterCss";

/**
 * 两套整体风格共用一份 token 名：
 * - 档案馆：暖金 + 冷青 + 近黑纸面（与 ReportWorkspace 十二章同源）
 * - 内容年志：故事页的纸面 / 墨色 / 信号蓝（prototype/story-draft_副本.html 的 :root）
 * web 上每个 token 是 CSS 变量，<html data-style> 一换整套界面跟着换（见 ensureThemeStyles / applyAppStyle）；
 * native 没有 CSS 变量，永远拿档案馆的实色。
 */
const archive = {
  canvas: "#0A0B0B",
  sidebar: "#0E1010",
  surface: "#131717",
  surfaceRaised: "#181B1A",
  surfaceMuted: "#242726",
  border: "#3A3228",
  borderSoft: "#2A2620",
  frame: "#6E5D49",
  text: "#EFDFCC",
  textSecondary: "#CFC1B0",
  textMuted: "#7C7266",
  accent: "#C59861",
  accentPressed: "#A87F4C",
  accentAction: "#B07E40",
  accentSoft: "#2A2114",
  figure: "#E3C8A6",
  cyan: "#6E8C8F",
  cyanSoft: "#182223",
  green: "#A9D0D3",
  greenSoft: "#16211F",
  amber: "#B68B57",
  amberSoft: "#241C12",
  danger: "#B4664F",
  dangerSoft: "#241817",
  white: "#EFE6D8",
  black: "#0A0B0B",
  scrim: "rgba(10,11,11,0.72)",
  // 实心主按钮（采集器页的“连接采集器 / 打开报告”）
  button: "#EFE6D8",
  buttonText: "#0A0B0B",
  // “已连接 / 读取中”这类活的信号色
  signal: "#70C3BF",
  // 图表里固定的几个配角色
  funnel0: "#3F5C5E",
  funnel1: "#4E787C",
  vennWatch: "#7FB0B4",
  vennFavorite: "#A8804F",
  shadow: "none",
  heat: ["#10171A", "#1A3133", "#27494B", "#406C72", "#8A6238", "#B07E40"],
  slices: ["#6E8C8F", "#C59861", "#4E787C", "#A8804F", "#8FA9AB", "#8A6238"],
  avatars: ["#4E7578", "#6E5D49", "#805B38", "#3E5254", "#5A4833", "#2B6C72"],
  tints: ["#1B2422", "#232019", "#1E1A16", "#182120", "#241E17", "#1C1F1E"],
};

export type WorkspacePalette = typeof archive;

const trace: WorkspacePalette = {
  canvas: "#F3F2EC",
  sidebar: "#FBFBF7",
  surface: "#FFFFFF",
  surfaceRaised: "#F9FAF7",
  surfaceMuted: "#ECEEE9",
  border: "#DEE2DE",
  borderSoft: "#E8EBE6",
  frame: "#D3D8D3",
  text: "#171717",
  textSecondary: "#444141",
  textMuted: "#6B6B69",
  accent: "#282834",
  accentPressed: "#1F1F29",
  accentAction: "#41A1CF",
  accentSoft: "#EAEAF0",
  figure: "#171717",
  cyan: "#41A1CF",
  cyanSoft: "#E7F3F9",
  green: "#0081C0",
  greenSoft: "#E3F1F9",
  amber: "#B8702F",
  amberSoft: "#FAF1E6",
  danger: "#C0554A",
  dangerSoft: "#FBE9E6",
  white: "#FFFFFF",
  black: "#171717",
  scrim: "rgba(31,31,41,0.72)",
  button: "#1F1F29",
  buttonText: "#FFFFFF",
  signal: "#0081C0",
  funnel0: "#C9DFE9",
  funnel1: "#8FC4E0",
  vennWatch: "#41A1CF",
  vennFavorite: "#B8702F",
  shadow: "rgba(0,0,0,0.08) 0 1px 1px, rgba(0,0,0,0.08) 0 4px 5px",
  heat: ["#F1F3F0", "#DCECF5", "#A9D3EA", "#6FB8DC", "#41A1CF", "#0081C0"],
  slices: ["#41A1CF", "#282834", "#8FC7E3", "#7C5468", "#0081C0", "#B4B8B4"],
  avatars: ["#41A1CF", "#7C5468", "#B8702F", "#282834", "#453E63", "#0081C0"],
  tints: ["#E8EEF5", "#F0E9EE", "#EAF1F3", "#F6EDE4", "#ECF0EA", "#F2EFE6"],
};

// 海报：与 public/story/story-poster.html 同一套——墨黑、新闻纸、信号橙，线一律实心黑
const poster: WorkspacePalette = {
  canvas: "#F1EEE6",
  sidebar: "#F1EEE6",
  surface: "#FFFFFF",
  surfaceRaised: "#F7F5EF",
  surfaceMuted: "#E4E0D4",
  border: "#0A0A0A",
  borderSoft: "#0A0A0A",
  frame: "#0A0A0A",
  text: "#0A0A0A",
  textSecondary: "#2A2A2A",
  textMuted: "#5E5A52",
  accent: "#FF4A1C",
  accentPressed: "#E03A10",
  accentAction: "#FF4A1C",
  accentSoft: "#FFE2D8",
  figure: "#0A0A0A",
  cyan: "#0A0A0A",
  cyanSoft: "#E4E0D4",
  green: "#0A0A0A",
  greenSoft: "#E4E0D4",
  amber: "#FF4A1C",
  amberSoft: "#FFE2D8",
  danger: "#B3001B",
  dangerSoft: "#F7D9D9",
  white: "#FFFFFF",
  black: "#0A0A0A",
  scrim: "rgba(10,10,10,0.82)",
  button: "#0A0A0A",
  buttonText: "#F1EEE6",
  signal: "#FF4A1C",
  funnel0: "#E4E0D4",
  funnel1: "#BDB8AB",
  vennWatch: "#0A0A0A",
  vennFavorite: "#FF4A1C",
  shadow: "none",
  heat: ["#E9E5DA", "#D6D1C4", "#A9A396", "#5E5A52", "#0A0A0A", "#FF4A1C"],
  // 第五片原来是浅橙，饼图里看着发粉；海报只用墨黑 / 信号橙 / 灰纸
  slices: ["#0A0A0A", "#FF4A1C", "#5E5A52", "#BDB8AB", "#E4E0D4", "#2A2A2A"],
  avatars: ["#0A0A0A", "#FF4A1C", "#2A2A2A", "#5E5A52", "#FF6A42", "#3A3A3A"],
  // 封面缺图时的底：只用新闻纸 / 纯白 / 灰纸 / 信号橙，出血编号一律墨黑印在上面
  tints: ["#F1EEE6", "#FFFFFF", "#E4E0D4", "#FF4A1C", "#F1EEE6", "#FFFFFF"],
};

const archiveFonts = {
  serif: "Georgia, 'Songti SC', 'STSong', 'SimSun', serif",
  didot: "Didot, 'Bodoni 72', Georgia, 'Songti SC', serif",
  // 内容库各页正文：档案馆整页衬线；采集器页正文：系统无衬线（与 RN-web 的 System 栈一致）
  body: "Georgia, 'Songti SC', 'STSong', 'SimSun', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  // 眉题 / 小标签：年志用等宽；档案馆里内容库沿用衬线、采集器页沿用无衬线，各自与改版前一致
  mono: "Georgia, 'Songti SC', 'STSong', 'SimSun', serif",
  setupMono: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};
const traceFonts: typeof archiveFonts = {
  serif: "Fraunces, 'Songti SC', 'STSong', 'Noto Serif SC', Georgia, serif",
  didot: "Fraunces, 'Songti SC', 'STSong', 'Noto Serif SC', Georgia, serif",
  body: "Inter, 'PingFang SC', 'Helvetica Neue', sans-serif",
  sans: "Inter, 'PingFang SC', 'Helvetica Neue', sans-serif",
  mono: "'SFMono-Regular', ui-monospace, 'Roboto Mono', monospace",
  setupMono: "'SFMono-Regular', ui-monospace, 'Roboto Mono', monospace",
};

const posterFonts: typeof archiveFonts = {
  serif: "Anton, 'Noto Sans SC', 'PingFang SC', sans-serif",
  didot: "Anton, 'Noto Sans SC', 'PingFang SC', sans-serif",
  body: "'Noto Sans SC', 'PingFang SC', 'Helvetica Neue', sans-serif",
  sans: "'Noto Sans SC', 'PingFang SC', 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'Roboto Mono', monospace",
  setupMono: "'JetBrains Mono', ui-monospace, 'Roboto Mono', monospace",
};

// 档案页面是直角的；年志的卡片 12–16、按钮是胶囊
const archiveRadii = { small: 0, medium: 0, large: 0, pill: 0 };
const traceRadii: typeof archiveRadii = { small: 8, medium: 12, large: 16, pill: 50 };

export const palettes: Record<AppStyle, { colors: WorkspacePalette; fonts: typeof archiveFonts; radii: typeof archiveRadii }> = {
  archive: { colors: archive, fonts: archiveFonts, radii: archiveRadii },
  trace: { colors: trace, fonts: traceFonts, radii: traceRadii },
  poster: { colors: poster, fonts: posterFonts, radii: archiveRadii },
};

const web = Platform.OS === "web";
const cssName = (key: string, index?: number) => `--ws-${key.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)}${index === undefined ? "" : `-${index}`}`;

function colorTokens(palette: WorkspacePalette): WorkspacePalette {
  if (!web) return palette;
  return Object.fromEntries(Object.entries(palette).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.map((_, index) => `var(${cssName(key, index)})`) : `var(${cssName(key)})`,
  ])) as WorkspacePalette;
}

export const workspaceColors = colorTokens(archive);

export const workspaceFonts: Record<keyof typeof archiveFonts, string | undefined> = web
  ? { serif: "var(--ws-font-serif)", didot: "var(--ws-font-didot)", body: "var(--ws-font-body)", sans: "var(--ws-font-sans)", mono: "var(--ws-font-mono)", setupMono: "var(--ws-font-setup-mono)" }
  : { serif: undefined, didot: undefined, body: undefined, sans: undefined, mono: undefined, setupMono: undefined };

export const workspaceRadii: Record<keyof typeof archiveRadii, number | string> = web
  ? { small: "var(--ws-radius-small)", medium: "var(--ws-radius-medium)", large: "var(--ws-radius-large)", pill: "var(--ws-radius-pill)" }
  : archiveRadii;

// 带透明度的 token。RN-web 只放行以 `var(` 开头的颜色字符串，所以借一个从不定义的变量的回退值把 color-mix 送进 CSS。
export function alpha(token: string, ratio: number): string {
  if (!web) return `${token}${Math.round(ratio * 255).toString(16).padStart(2, "0")}`;
  return `var(--ws-unset, color-mix(in srgb, ${token} ${Math.round(ratio * 100)}%, transparent))`;
}

function declarations(style: AppStyle): string {
  const { colors, fonts, radii } = palettes[style];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    if (Array.isArray(value)) value.forEach((item, index) => lines.push(`${cssName(key, index)}:${item}`));
    else lines.push(`${cssName(key)}:${value}`);
  }
  for (const [key, value] of Object.entries(fonts)) lines.push(`${cssName(`font-${key}`)}:${value}`);
  for (const [key, value] of Object.entries(radii)) lines.push(`--ws-radius-${key}:${value}px`);
  return lines.join(";");
}

export function themeCss(): string {
  // 默认内容年志：:root 直接发年志令牌，档案馆靠 data-style 覆盖。
  return `:root{${declarations("trace")}}\n:root[data-style="archive"]{${declarations("archive")}}\n:root[data-style="poster"]{${declarations("poster")}}\nhtml,body{background:var(--ws-canvas)}\n${motionCss}\n${posterCss}`;
}

const STYLE_ID = "content-insights-theme";

export function ensureThemeStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = themeCss();
  doc.head.appendChild(style);
}
