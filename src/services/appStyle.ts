export type AppStyle = "archive" | "trace" | "poster";

// 整体风格：持续报告与报告本体共用同一个选择（采集器页只有一套样式，不跟它走）。默认内容年志。
export const DEFAULT_APP_STYLE: AppStyle = "trace";
export const APP_STYLES: ReadonlyArray<{ key: AppStyle; label: string; detail: string }> = [
  { key: "trace", label: "内容年志", detail: "墨夜玻璃 · 穿卡入口" },
  { key: "archive", label: "档案馆", detail: "暗室星图卷宗 · 点击翻页" },
  { key: "poster", label: "海报", detail: "黑橙新闻纸 · 硬切长卷" },
];

// 键名沿用“报告风格”时期的，用户之前保存的选择继续有效。
const STORAGE_KEY = "content-insights.report-style";
// 各风格与自己的故事页同一组字体；选到哪套才去取哪套，取过一次不再重复。
const FONTS: Partial<Record<AppStyle, string>> = {
  // 年志的巨大数字用 Fraunces 200 斜体，所以正斜两套都取整段字重（可变字体，一个文件）
  trace: "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,100..900;1,9..144,100..900&family=Inter:wght@300;400;500;600;700&display=swap",
  poster: "https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700;900&display=swap",
  // 档案馆：Cormorant Garamond 细衬线做数字和英文，宋体做中文，黑体只留给很小的注释
  archive: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600&family=Noto+Serif+SC:wght@400;500;600;700;900&family=Noto+Sans+SC:wght@400;500&display=swap",
};
const STORED: ReadonlySet<string> = new Set(APP_STYLES.map((item) => item.key));

interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Native has no localStorage and private browsing may throw; both fall back to the default style.
// 显式选过的风格照用，其余情况（没选过 / 存了旧值）都用默认的内容年志。
export function loadAppStyle(storage: StyleStorage | undefined = globalThis.localStorage): AppStyle {
  try {
    const stored = storage?.getItem(STORAGE_KEY) ?? "";
    return STORED.has(stored) ? stored as AppStyle : DEFAULT_APP_STYLE;
  } catch {
    return DEFAULT_APP_STYLE;
  }
}

export function saveAppStyle(style: AppStyle, storage: StyleStorage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, style);
  } catch {
    // Nothing to persist to; the in-memory choice still applies for this session.
  }
}

interface StyleDocument {
  documentElement: { dataset: Record<string, string | undefined> };
  head: { appendChild(node: unknown): unknown };
  getElementById(id: string): unknown;
  createElement(tag: "link"): { id: string; rel: string; href: string };
}

// Web only: the style rides on <html data-style>, and the CSS-variable theme in workspaceTheme follows it.
export function applyAppStyle(style: AppStyle, doc: StyleDocument | undefined = globalThis.document as StyleDocument | undefined): void {
  if (!doc) return;
  doc.documentElement.dataset.style = style;
  const href = FONTS[style];
  const id = `content-insights-${style}-fonts`;
  if (!href || doc.getElementById(id)) return;
  const link = doc.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  doc.head.appendChild(link);
}

export interface StoryEntryCounts {
  watch: number;
  liked: number;
  favorite: number;
  chat: number | null;
}

export interface StoryEntryOptions {
  /** The in-app reading surface is an explicitly interactive experience. */
  motion?: "full";
}

// The entry card reads these query params; the story page behind it reads the aggregated snapshot from localStorage.
export function buildStoryEntryUrl(
  counts: StoryEntryCounts,
  year = new Date().getFullYear(),
  options: StoryEntryOptions = {},
): string {
  const params = new URLSearchParams({ watch: String(counts.watch), liked: String(counts.liked), favorite: String(counts.favorite), year: String(year) });
  if (counts.chat !== null) params.set("chat", String(counts.chat));
  if (options.motion === "full") params.set("motion", "full");
  return `/story/story-entry.html?${params.toString()}`;
}

// 海报风格没有入口卡：故事页自己就是封面，数字全从 localStorage 的快照里读。
export function buildPosterStoryUrl(options: StoryEntryOptions = {}): string {
  return `/story/story-poster.html${options.motion === "full" ? "?motion=full" : ""}`;
}

// 档案馆（web）同样是 /story 下的静态页，一页一屏、点击翻页；native 仍走应用内的分页报告。
export function buildArchiveStoryUrl(options: StoryEntryOptions = {}): string {
  return `/story/story-archive.html${options.motion === "full" ? "?motion=full" : ""}`;
}
