// 抖音指数（创作者平台 creator_count，前身是巨量算数）：搜索一个词时用到的取数窗口、解析和展示格式。
// 字段规则来自 10-07 在登录态下对官方页面的实抓（接口和参数见 collector/creatorCenter.mjs 里的 index_*）。

type Raw = Record<string, any> | null | undefined;

/** 官方页面默认看最近 31 天（含首尾）；这个词上线更晚的话从它上线那天起 */
export const INDEX_SPAN_DAYS = 30;
/** 关联词和人群只有 7 天的窗口，页面也是这么发的 */
export const INDEX_RELATION_DAYS = 6;

/** 搜索框里的内容能不能拿去查指数：链接、作品 id 之类不是词，太长的官方也没有 */
export function indexKeyword(query: string | null | undefined): string | null {
  const text = (query ?? "").trim();
  if (!text || text.length > 30 || /[\u0000-\u001f]/u.test(text)) return null;
  if (/^https?:\/\//iu.test(text) || /^\d{15,}$/u.test(text)) return null;
  return text;
}

export function shiftDay(day: string, days: number): string {
  const year = Number(day.slice(0, 4)), month = Number(day.slice(4, 6)), date = Number(day.slice(6, 8));
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return `${moved.getUTCFullYear()}${String(moved.getUTCMonth() + 1).padStart(2, "0")}${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/** 两个 YYYYMMDD 相差几天（later 比 earlier 晚为正） */
export function dayGap(later: string, earlier: string): number {
  const at = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
  return Math.round((at(later) - at(earlier)) / 86_400_000);
}

/** 结束日取官方给的最新日（超过它官方会补零），开始日往前推，不早于这个词有数据的第一天 */
export function indexWindow(latestDay: string, earliestDay: string | null, span = INDEX_SPAN_DAYS): { start: string; end: string } {
  const start = shiftDay(latestDay, -span);
  return { start: earliestDay && earliestDay > start ? earliestDay : start, end: latestDay };
}

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{8}$/u.test(value);
const number = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
/** 业务错误放在 BaseResp.StatusCode 里，HTTP 仍是 200 */
export const indexOk = (data: Raw): boolean => Boolean(data) && Number(data?.BaseResp?.StatusCode ?? 0) === 0;

export function parseLatestDay(data: Raw): string | null {
  return indexOk(data) && isDay(data?.keyword_latest_day) ? data!.keyword_latest_day : null;
}
export function parseRelationDay(data: Raw): string | null {
  return indexOk(data) && isDay(data?.datetime) ? data!.datetime : null;
}

/** 响应是以关键词为键的对象；status 0 才有指数 */
export function parseKeywordValid(data: Raw, keyword: string): { hasData: boolean; validDay: string | null } {
  if (!indexOk(data)) return { hasData: false, validDay: null };
  const entry = data?.[keyword] ?? Object.values(data ?? {}).find((value) => value && typeof value === "object" && "status" in (value as object));
  const hasData = Number(entry?.status) === 0 && isDay(entry?.valid_day);
  return { hasData, validDay: hasData ? entry.valid_day : null };
}

export interface IndexTrend {
  keyword: string;
  days: string[];
  /** 综合指数（平台声量）逐日 */ comprehensive: number[];
  /** 搜索指数（用户搜索热度）逐日 */ search: number[];
  averages: { comprehensive: number; search: number };
  /** 比上一个等长区间的涨跌，小数；没有可比数据是 null */
  mom: { comprehensive: number | null; search: number | null };
  /** 比去年同期 */ yoy: { comprehensive: number | null; search: number | null };
  /** 增长最快的日子和最高的日子，按日期排；综合指数和搜索指数官方各给一份 */
  highlights: { comprehensive: IndexHighlights; search: IndexHighlights };
}
export interface IndexHighlights { rises: string[]; peaks: string[] }

/** top_point_list / search_top_point_list：style "0" 是飙升点，"1" 是波峰点 */
function parseHighlights(list: unknown): IndexHighlights {
  const points = (Array.isArray(list) ? list : []).filter((point: Raw) => isDay(point?.date)) as Array<{ date: string; style: unknown }>;
  const days = (style: string) => [...new Set(points.filter((point) => String(point.style) === style).map((point) => point.date))].sort();
  return { rises: days("0"), peaks: days("1") };
}

const ratio = (now: number, before: unknown): number | null => {
  const base = number(before);
  return base > 0 ? now / base - 1 : null;
};

/** 返回项的顺序不保证和请求一致，按词对号；没有指数的词 hot_list 是空的 */
export function parseTrend(data: Raw, keyword: string): IndexTrend | null {
  if (!indexOk(data) || !Array.isArray(data?.hot_list)) return null;
  const item = data!.hot_list.find((entry: Raw) => entry?.keyword === keyword) ?? data!.hot_list[0];
  const list: Array<{ datetime?: string; index?: string }> = Array.isArray(item?.hot_list) ? item.hot_list : [];
  if (!list.length) return null;
  const search: Array<{ datetime?: string; index?: string }> = Array.isArray(item?.search_hot_list) ? item.search_hot_list : [];
  const searchByDay = new Map(search.map((point) => [point.datetime, number(point.index)]));
  const days = list.map((point) => String(point.datetime)).filter(isDay).sort();
  const byDay = new Map(list.map((point) => [point.datetime, number(point.index)]));
  const averages = { comprehensive: number(item.average?.average), search: number(item.average?.search_average) };
  return {
    keyword: String(item.keyword ?? keyword),
    days,
    comprehensive: days.map((day) => byDay.get(day) ?? 0),
    search: days.map((day) => searchByDay.get(day) ?? 0),
    averages,
    mom: { comprehensive: ratio(averages.comprehensive, item.last_average?.average), search: ratio(averages.search, item.last_average?.search_average) },
    yoy: { comprehensive: ratio(averages.comprehensive, item.last_year_average?.average), search: ratio(averages.search, item.last_year_average?.search_average) },
    highlights: { comprehensive: parseHighlights(item.top_point_list), search: parseHighlights(item.search_top_point_list) },
  };
}

export interface IndexScores { content: number; spread: number; search: number }

/** 内容分、传播分、搜索分（官方「综合指数解读」）。三项全 0 说明这个词没有数据 */
export function parseScores(data: Raw, keyword: string): IndexScores | null {
  if (!indexOk(data) || !Array.isArray(data?.keyword_index_interpretations)) return null;
  const item = data!.keyword_index_interpretations.find((entry: Raw) => entry?.keyword === keyword) ?? data!.keyword_index_interpretations[0];
  if (!item?.overview) return null;
  const scores = { content: number(item.overview.content_index), spread: number(item.overview.consume_index), search: number(item.overview.search_index) };
  // 没数据的词官方回三个 0（环比同比是 -1 哨兵）
  return scores.content || scores.spread || scores.search ? scores : null;
}

export interface RelatedWord { word: string; /** 官方标了「新」的新进榜词 */ fresh: boolean }

/** 搜索关联词，按关联度名次排（数组本身不排序）。注意 correlation_change 不是「新」：实测它是「关联度没降」，老词也常为 true */
export function parseRelatedWords(data: Raw, limit = 12): RelatedWord[] {
  if (!indexOk(data) || !Array.isArray(data?.search_relation_word_list)) return [];
  const rows = (data!.search_relation_word_list as Array<Record<string, any>>)
    .filter((row) => typeof row?.relation_word === "string" && row.relation_word)
    .sort((a, b) => number(a.score_rank) - number(b.score_rank))
    .slice(0, limit);
  return rows.map((row) => ({ word: row.relation_word, fresh: row.score_rate === "新" }));
}

export interface PortraitRow { label: string; /** 占比 0–1 */ share: number }
export interface IndexPortrait { age: PortraitRow[]; gender: PortraitRow[]; provinces: PortraitRow[] }

/** 年龄、性别和占比最高的几个省；冷门词整个接口只回一个 BaseResp */
export function parsePortrait(data: Raw, provinceLimit = 5): IndexPortrait | null {
  if (!indexOk(data) || !Array.isArray(data?.data)) return null;
  const rows = (name: string): PortraitRow[] => {
    const group = (data!.data as Array<Record<string, any>>).find((entry) => entry?.name_en === name);
    return (Array.isArray(group?.label_list) ? group.label_list : [])
      .filter((label: Raw) => typeof label?.name_zh === "string")
      .map((label: Record<string, any>) => ({ label: label.name_zh as string, share: number(label.value) }));
  };
  const result = { age: rows("age"), gender: rows("gender"), provinces: rows("province").sort((a, b) => b.share - a.share).slice(0, provinceLimit) };
  return result.age.length || result.gender.length || result.provinces.length ? result : null;
}

/** 官方页面的数字习惯：≥1 万显示成「494.0 万」 */
export function formatIndex(value: number): string {
  return Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(Math.round(value));
}
export function formatChange(value: number | null): string {
  if (value === null) return "—";
  const percent = value * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(Math.abs(percent) >= 100 ? 0 : 1)}%`;
}
export function formatShare(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}
/** 20261006 → 10/06 */
export function shortDay(day: string): string {
  return `${day.slice(4, 6)}/${day.slice(6, 8)}`;
}

/** 去创作者平台看这个词的完整指数页 */
export function indexPageUrl(keyword: string): string {
  return `https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/analysis?source=creator&keyword=${encodeURIComponent(keyword)}&tab=heat_index&appName=aweme`;
}
