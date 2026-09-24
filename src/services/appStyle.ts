export type AppStyle = "archive" | "trace";

// 整体风格：采集器页、持续报告与报告本体共用同一个选择。
export const APP_STYLES: ReadonlyArray<{ key: AppStyle; label: string; detail: string }> = [
  { key: "archive", label: "档案馆", detail: "深色档案 · 应用内分页翻阅" },
  { key: "trace", label: "内容年志", detail: "纸面年志 · 穿卡入口" },
];

// 键名沿用“报告风格”时期的，用户之前保存的选择继续有效。
const STORAGE_KEY = "content-insights.report-style";
const FONTS_ID = "content-insights-trace-fonts";
// 与 public/story 两页同一组字体；只有选了内容年志才会去取。
const TRACE_FONTS_URL = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,300;1,9..144,400&family=Inter:wght@400;500;600;700&display=swap";

interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Native has no localStorage and private browsing may throw; both fall back to the default style.
export function loadAppStyle(storage: StyleStorage | undefined = globalThis.localStorage): AppStyle {
  try {
    return storage?.getItem(STORAGE_KEY) === "trace" ? "trace" : "archive";
  } catch {
    return "archive";
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
  if (style !== "trace" || doc.getElementById(FONTS_ID)) return;
  const link = doc.createElement("link");
  link.id = FONTS_ID;
  link.rel = "stylesheet";
  link.href = TRACE_FONTS_URL;
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
