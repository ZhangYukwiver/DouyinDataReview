import { LocalCollectorError } from "./localCollector";
import type { ExploreConnection } from "./explorer";
import { readCreatorResults, type CreatorQuery, type CreatorResult } from "./creatorCenter";
import {
  INDEX_RELATION_DAYS, indexOk, indexWindow, parseHotTopics, parseKeywordValid, parseLatestDay, parsePortrait, parseRelatedWords, parseRelationDay, parseScores, parseTrend, shiftDay,
  type HotTopics, type IndexPortrait, type IndexScores, type IndexTrend, type RelatedWord,
} from "../domain/douyinIndex";

type Read = (connection: ExploreConnection, queries: CreatorQuery[], signal?: AbortSignal) => Promise<CreatorResult[]>;

export type KeywordIndex =
  | { state: "no_data" }
  | { state: "ok"; keyword: string; latestDay: string; trend: IndexTrend; scores: IndexScores | null };
export interface KeywordExtras {
  related: RelatedWord[]; portrait: IndexPortrait | null; day: string;
  /** 官方这一半没读到（和「这个词没有」不是一回事），界面要说一声 */
  relatedMissing: boolean; portraitMissing: boolean;
}

const unavailable = () => new LocalCollectorError("index_unavailable", "没读到抖音指数，请稍后重试。");

/** 抖音官方改了响应的加密方式才会走到这里：和「这个词没数据」是两回事，要让人知道 */
function ensureReadable(items: CreatorResult[]): void {
  if (items.some((item) => item.reason === "undecryptable")) {
    throw new LocalCollectorError("index_undecryptable", "抖音指数的数据格式好像被官方改了，当前版本读不了，等应用更新。");
  }
}

// 同一个词十分钟内不重复读：从作品详情返回搜索结果时卡片会重新挂载
const CACHE_MS = 10 * 60_000;
const HOT_CACHE_MS = 3 * 60_000;
const cache = new Map<string, { at: number; value: KeywordIndex }>();
const extrasCache = new Map<string, { at: number; value: KeywordExtras }>();
export function clearKeywordIndexCache(): void { cache.clear(); extrasCache.clear(); }

/**
 * 搜索一个词的最小链路：最新日期 + 这个词有没有指数 → 综合/搜索指数序列 + 三项分数。
 * 全是只读查询；两批各一次往返。
 */
export async function loadKeywordIndex(connection: ExploreConnection, keyword: string, signal?: AbortSignal, read: Read = readCreatorResults, now = Date.now()): Promise<KeywordIndex> {
  const cacheKey = `${connection.baseUrl}\n${keyword}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const [dates, valid] = await read(connection, [{ key: "index_valid_date" }, { key: "index_keyword_valid", params: { keyword } }], signal);
  ensureReadable([dates!, valid!]);
  const latestDay = parseLatestDay(dates!.data);
  // 官方偶发的业务错误（BaseResp 不是 0）是「没读到」，不是「没有指数」：不能当成无数据缓存起来
  if (!latestDay || !valid!.data || !indexOk(valid!.data)) throw unavailable();
  const { hasData, validDay } = parseKeywordValid(valid!.data, keyword);
  if (!hasData) return remember(cacheKey, now, { state: "no_data" });
  const { start, end } = indexWindow(latestDay, validDay);
  const params = { keyword, start_date: start, end_date: end, app_name: "aweme" };
  const [trendResult, scoreResult] = await read(connection, [{ key: "index_hot_trend", params }, { key: "index_interpretation", params }], signal);
  ensureReadable([trendResult!, scoreResult!]);
  if (!trendResult!.data || !indexOk(trendResult!.data)) throw unavailable();
  const trend = parseTrend(trendResult!.data, keyword);
  if (!trend) return remember(cacheKey, now, { state: "no_data" });
  return remember(cacheKey, now, { state: "ok", keyword, latestDay, trend, scores: parseScores(scoreResult!.data, keyword) });
}

function remember(key: string, at: number, value: KeywordIndex): KeywordIndex {
  cache.set(key, { at, value });
  return value;
}

/** 关联词和人群：用户展开才读。官方只有 7 天窗口，最新日比关键词指数晚两天（T-3）。 */
export async function loadKeywordExtras(connection: ExploreConnection, keyword: string, signal?: AbortSignal, read: Read = readCreatorResults, now = Date.now()): Promise<KeywordExtras> {
  const cacheKey = `${connection.baseUrl}\n${keyword}`;
  const cached = extrasCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const [dayResult] = await read(connection, [{ key: "index_relation_valid_date" }], signal);
  ensureReadable([dayResult!]);
  const day = parseRelationDay(dayResult!.data);
  if (!day) throw new LocalCollectorError("index_unavailable", "关联词和人群这次都没读到，请稍后再点一次。");
  const params = { keyword, start_date: shiftDay(day, -INDEX_RELATION_DAYS), end_date: day, app_name: "aweme" };
  const [relation, portrait] = await read(connection, [{ key: "index_relation_word", params }, { key: "index_portrait", params }], signal);
  ensureReadable([relation!, portrait!]);
  const relatedOk = Boolean(relation!.data) && indexOk(relation!.data), portraitOk = Boolean(portrait!.data) && indexOk(portrait!.data);
  // 主指数已经显示了，这里的提示要说清楚是关联词和人群没读到
  if (!relatedOk && !portraitOk) throw new LocalCollectorError("index_unavailable", "关联词和人群这次都没读到，请稍后再点一次。");
  const value = { day, related: parseRelatedWords(relation!.data), portrait: parsePortrait(portrait!.data), relatedMissing: !relatedOk, portraitMissing: !portraitOk };
  // 只缓存完整的：缺了一半是临时没读到，不能让它卡住十分钟
  if (relatedOk && portraitOk) extrasCache.set(cacheKey, { at: now, value });
  return value;
}

// 榜单官方是几分钟一更；切回探索页时不重复读
const hotCache = new Map<string, { at: number; value: HotTopics }>();
export function clearHotTopicsCache(): void { hotCache.clear(); }

/** 创作者平台抖音指数首页的两个热点榜，一次请求。失败不缓存。 */
export async function loadHotTopics(connection: ExploreConnection, signal?: AbortSignal, read: Read = readCreatorResults, now = Date.now()): Promise<HotTopics> {
  const cached = hotCache.get(connection.baseUrl);
  if (cached && now - cached.at < HOT_CACHE_MS) return cached.value;
  const [result] = await read(connection, [{ key: "index_hot_topic" }], signal);
  ensureReadable([result!]);
  const value = result!.data ? parseHotTopics(result!.data) : null;
  if (!value) throw new LocalCollectorError("index_unavailable", "没读到抖音热点榜，请稍后重试。");
  hotCache.set(connection.baseUrl, { at: now, value });
  return value;
}
