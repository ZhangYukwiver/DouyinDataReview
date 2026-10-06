export type AppStyle = "minimal" | "archive" | "trace" | "poster";
/** 有自己报告页（/story 下的故事页）的风格；极简只换采集器和工作台，报告借用其中一套。 */
export type StoryStyle = Exclude<AppStyle, "minimal">;

// 整体风格：采集器页、工作台、报告共用同一个选择。默认极简：白底细线、系统字体，没有自己的报告页。
// 采集器页在极简下是极简版式，其余三种风格下仍是那套手绘纸面（不跟风格换皮）。
export const DEFAULT_APP_STYLE: AppStyle = "minimal";
export const APP_STYLES: ReadonlyArray<{ key: AppStyle; label: string; detail: string }> = [
  { key: "minimal", label: "极简", detail: "白底细线 · 系统字体" },
  { key: "trace", label: "内容年志", detail: "墨夜玻璃 · 穿卡入口" },
  { key: "archive", label: "档案馆", detail: "暗室星图卷宗 · 点击翻页" },
  { key: "poster", label: "海报", detail: "黑橙新闻纸 · 硬切长卷" },
];

// 极简下「打开报告」用哪套故事页，默认内容年志；另外三种风格各用自己的。
export const DEFAULT_STORY_STYLE: StoryStyle = "trace";
export const STORY_STYLES = APP_STYLES.filter((item): item is { key: StoryStyle; label: string; detail: string } => item.key !== "minimal");

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
const STORY_STORAGE_KEY = "content-insights.story-style";
const STORED: ReadonlySet<string> = new Set(APP_STYLES.map((item) => item.key));
const STORED_STORY: ReadonlySet<string> = new Set(STORY_STYLES.map((item) => item.key));

interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function load<T extends string>(key: string, allowed: ReadonlySet<string>, fallback: T, storage: StyleStorage | undefined): T {
  try {
    const stored = storage?.getItem(key) ?? "";
    return allowed.has(stored) ? stored as T : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string, storage: StyleStorage | undefined): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Nothing to persist to; the in-memory choice still applies for this session.
  }
}

// Native has no localStorage and private browsing may throw; both fall back to the default style.
// 显式选过的风格照用（老用户选过年志/档案馆/海报的不变），其余情况（没选过 / 存了旧值）都用默认的极简。
export function loadAppStyle(storage: StyleStorage | undefined = globalThis.localStorage): AppStyle {
  return load(STORAGE_KEY, STORED, DEFAULT_APP_STYLE, storage);
}

export function saveAppStyle(style: AppStyle, storage: StyleStorage | undefined = globalThis.localStorage): void {
  save(STORAGE_KEY, style, storage);
}

export function loadStoryStyle(storage: StyleStorage | undefined = globalThis.localStorage): StoryStyle {
  return load(STORY_STORAGE_KEY, STORED_STORY, DEFAULT_STORY_STYLE, storage);
}

export function saveStoryStyle(style: StoryStyle, storage: StyleStorage | undefined = globalThis.localStorage): void {
  save(STORY_STORAGE_KEY, style, storage);
}

// 「自动补读新记录」开关（设置面板 / 采集器页）：以前不存，每次启动都回到开启；现在记住用户的选择
const AUTO_SYNC_KEY = "content-insights.auto-sync";
const AUTO_SYNC_VALUES: ReadonlySet<string> = new Set(["on", "off"]);

export function loadAutoSync(storage: StyleStorage | undefined = globalThis.localStorage): boolean {
  return load(AUTO_SYNC_KEY, AUTO_SYNC_VALUES, "on", storage) === "on";
}

export function saveAutoSync(enabled: boolean, storage: StyleStorage | undefined = globalThis.localStorage): void {
  save(AUTO_SYNC_KEY, enabled ? "on" : "off", storage);
}

/** 报告（故事页、分享图、纪念卡）实际用哪套：极简借用单独选的那套，其余风格就是自己。 */
export function resolveStoryStyle(appStyle: AppStyle, storyStyle: StoryStyle): StoryStyle {
  return appStyle === "minimal" ? storyStyle : appStyle;
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
