import { type AiEditLookJob, type AiRuntime, type LocalAiRuntime, aiRequestConfig, aiRuntimeOf, isLocalAiRuntime, pickLocalModels, videoProbeKey } from "./aiEdit";
import { LocalCollectorError, collectorFetch, normalizeCollectorBaseUrl } from "./localCollector";
import type { ExploreConnection } from "./explorer";

// 解析库：工作台把视频链接和接口配置交给采集器，采集器下载视频、调用 AI、存结果（collector/videoAnalysis.mjs）。
// 接口配置存在本机 localStorage，每次随请求带过去，采集器不保存 Key。

export interface AnalysisConfig {
  /** 没有就是接口；也可以用这台电脑上登录好的 Codex / Claude Code */
  runtime?: AiRuntime;
  /** 本机 CLI 的模型（选填），和接口的分开存 */
  localModels?: Partial<Record<LocalAiRuntime, string>>;
  baseUrl: string;
  apiKey: string;
  model: string;
  direction: string;
  /** 保存时测过：模型能不能直接看视频（看不了的话由解析库页面把视频拆成截图和节拍再给它）；没测过是 null */
  videoInput?: boolean | null;
  /** 测的是哪个接口地址和模型，换了就要重测 */
  videoProbe?: string;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiKey: "",
  // 10-09 实测比 2.0 mini 细得多（原话、时间戳、10 个维度都答全），代价是一条要几分钟
  model: "doubao-seed-2-1-lite-260915",
  direction: "",
};

export interface AnalysisVideo {
  videoId: string | null; title: string | null; author: string | null; durationSeconds: number | null;
  publishedAt: string | null; tags?: string[]; cover?: string | null;
  stats?: { playCount?: number; diggCount?: number; commentCount?: number; shareCount?: number; collectCount?: number } | null;
}

export interface VideoAnalysis {
  id: string;
  sourceUrl: string;
  status: "running" | "complete" | "failed";
  stage: "downloading" | "analyzing" | "looking" | null;
  /** 模型看不了视频时，采集器请这个页面在浏览器里拆视频（截图、节拍） */
  look?: AiEditLookJob;
  video: AnalysisVideo | null;
  model: string;
  markdown: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONFIG_KEY = "dy2.analysisConfig";
export function loadAnalysisConfig(): AnalysisConfig {
  try {
    const config: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, ...JSON.parse(globalThis.localStorage?.getItem(CONFIG_KEY) ?? "{}") };
    if (config.runtime !== undefined) config.runtime = aiRuntimeOf(config.runtime);
    const localModels = pickLocalModels(config.localModels);
    if (localModels) config.localModels = localModels;
    else delete config.localModels;
    // 测的不是现在这个模型就当没测过
    if (typeof config.videoInput !== "boolean" || config.videoProbe !== videoProbeKey(config)) {
      delete config.videoInput;
      delete config.videoProbe;
    }
    return config;
  } catch {
    return DEFAULT_ANALYSIS_CONFIG;
  }
}
export function saveAnalysisConfig(config: AnalysisConfig) {
  try { globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* 存不了就只管这一次 */ }
}

async function request(connection: ExploreConnection, path: string, init: RequestInit = {}): Promise<any> {
  let response: Response;
  try {
    response = await collectorFetch(connection, `${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new LocalCollectorError("analysis_unreachable", "采集器没连上，请检查连接后重试。");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new LocalCollectorError(value?.error ?? "analysis_failed", value?.message ?? (
    response.status === 401 ? "连接已过期，请重新连接采集器。" : response.status === 404 ? "当前采集器还没有解析功能，请重启应用。" : "解析请求失败，请稍后重试。"));
  return value;
}

export async function listAnalyses(connection: ExploreConnection): Promise<VideoAnalysis[]> {
  const value = await request(connection, "/v1/analyses");
  return Array.isArray(value?.analyses) ? value.analyses : [];
}

export async function startAnalysis(connection: ExploreConnection, url: string, config: AnalysisConfig): Promise<VideoAnalysis> {
  // 本机 CLI 只带运行时、模型和创作方向
  const sent = isLocalAiRuntime(config.runtime) ? { ...aiRequestConfig(config), direction: config.direction } : aiRequestConfig(config);
  return (await request(connection, "/v1/analyses", { method: "POST", body: JSON.stringify({ url, config: sent }) })).analysis;
}

export async function deleteAnalysis(connection: ExploreConnection, id: string): Promise<void> {
  await request(connection, `/v1/analyses/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// 只认 AI 回答里会出现的几种写法：标题、表格、列表、引用、分隔线、**加粗**。
export type MarkdownBlock = { kind: "h"; level: number; text: string } | { kind: "p" | "quote"; text: string } | { kind: "li"; marker: string; text: string } | { kind: "table"; rows: string[][] } | { kind: "hr" };

// 模型有时照抄提示词里的“维度｜具体发现｜…”，整张表只用全角竖线、行首也不带竖线
const isRow = (line: string) => /^[|｜]/u.test(line.trim()) || (line.match(/｜/gu)?.length ?? 0) >= 2;
const cells = (line: string) => line.trim().replace(/^[|｜]|[|｜]$/gu, "").split(/[|｜]/u).map((cell) => cell.trim().replace(/<br\s*\/?>/giu, "\n"));

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "p", text: paragraph.join("\n") }); paragraph = []; };
  const lines = text.replace(/\r/gu, "").split("\n");
  const at = (index: number) => (lines[index] ?? "").trim();
  for (let index = 0; index < lines.length; index += 1) {
    const line = at(index);
    let match: RegExpMatchArray | null;
    if (!line || line.startsWith("```")) { flush(); continue; }
    if (isRow(line)) {
      flush();
      const rows: string[][] = [];
      // 表头下面那行 |---|---| 不算内容
      for (; index < lines.length && isRow(at(index)); index += 1) if (!/^[|｜:\s-]+$/u.test(at(index))) rows.push(cells(at(index)));
      index -= 1;
      blocks.push({ kind: "table", rows });
    } else if ((match = line.match(/^(#{1,6})\s+(.*)$/u))) { flush(); blocks.push({ kind: "h", level: match[1]!.length, text: match[2]! }); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/u.test(line)) { flush(); blocks.push({ kind: "hr" }); }
    else if ((match = line.match(/^>\s?(.*)$/u))) { flush(); blocks.push({ kind: "quote", text: match[1]! }); }
    else if ((match = line.match(/^([-*+]|\d+[.)、])\s+(.*)$/u))) { flush(); blocks.push({ kind: "li", marker: /\d/u.test(match[1]!) ? match[1]! : "•", text: match[2]! }); }
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** 把解析库页面拆好的截图和节拍（或接手、进度回执、拆不了的原因）交回采集器。 */
export async function answerAnalysisLook(connection: ExploreConnection, id: string, lookId: string, body: unknown): Promise<void> {
  await request(connection, `/v1/analyses/${encodeURIComponent(id)}/look/${encodeURIComponent(lookId)}`, { method: "POST", body: JSON.stringify(body) });
}

/** 采集器给的是路径（里面的随机串就是凭证），补上根地址。 */
export const analysisLookUrl = (baseUrl: string, path: string): string => `${normalizeCollectorBaseUrl(baseUrl)}${path}`;

/** 解析库挂着的拆视频任务（只有任务，不带整份结果），应用开着就接。 */
export async function listPendingAnalysisLooks(connection: ExploreConnection): Promise<{ id: string; look: AiEditLookJob }[]> {
  const value = await request(connection, "/v1/analyses/looks");
  return Array.isArray(value?.looks) ? value.looks : [];
}
