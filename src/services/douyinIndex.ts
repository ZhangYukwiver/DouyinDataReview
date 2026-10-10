import { LocalCollectorError } from "./localCollector";
import type { ExploreConnection } from "./explorer";
import { readCreatorResults, type CreatorQuery, type CreatorResult } from "./creatorCenter";
import {
  indexOk, parseDaren, parseDarenDay, parseFans, parseHotTopics, parseTopVideos, parseWorkAverages, pickDaren, shiftDay,
  type DarenDetail, type DarenVideo, type FanGroup, type HotTopics, type TopVideoOrder, type WorkAverages,
} from "../domain/douyinIndex";

type Read = (connection: ExploreConnection, queries: CreatorQuery[], signal?: AbortSignal) => Promise<CreatorResult[]>;

const unavailable = () => new LocalCollectorError("index_unavailable", "没读到达人详情，请稍后重试。");

/** 抖音官方改了响应的加密方式才会走到这里：和「没数据」是两回事，要让人知道 */
function ensureReadable(items: CreatorResult[]): void {
  if (items.some((item) => item.reason === "undecryptable")) {
    throw new LocalCollectorError("index_undecryptable", "抖音指数的数据格式好像被官方改了，当前版本读不了，等应用更新。");
  }
}

const CACHE_MS = 10 * 60_000;
const HOT_CACHE_MS = 3 * 60_000;

export type DarenResult =
  | { state: "none" }
  | { state: "ok"; detail: DarenDetail; latestDay: string;
    /** 作品分析、粉丝分析这几块读失败是 null，界面上单独说一声，不影响作者分析 */
    works: WorkAverages | null; videos: Record<TopVideoOrder, DarenVideo[]> | null; fans: FanGroup[] | null };

// 从作品详情返回主页时卡片会重新挂载，同一个人十分钟内不重复读
const darenCache = new Map<string, { at: number; value: DarenResult }>();
export function clearDarenCache(): void { darenCache.clear(); }

/**
 * 主页上这个人在抖音指数里的达人详情。两批往返：达人库最新日 + 按抖音号（没有就按昵称）搜达人 →
 * 基本信息、核心指标与逐日趋势、篇均、近 30 天作品、粉丝画像。全是只读查询。
 */
export async function loadDaren(connection: ExploreConnection, user: { id: string; handle: string; name: string }, signal?: AbortSignal, read: Read = readCreatorResults, now = Date.now()): Promise<DarenResult> {
  const cacheKey = `${connection.baseUrl}\n${user.id}`;
  const cached = darenCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const keyword = (user.handle.trim() || user.name.trim()).slice(0, 50);
  if (!keyword) return { state: "none" };
  const [dayResult, found] = await read(connection, [{ key: "daren_valid_date" }, { key: "daren_suggest", params: { keyword } }], signal);
  ensureReadable([dayResult!, found!]);
  const latestDay = parseDarenDay(dayResult!.data);
  // 业务错误（BaseResp 不是 0）是「没读到」，不是「不是达人」，不能当成没有缓存起来
  if (!latestDay || !found!.data || !indexOk(found!.data.data)) throw unavailable();
  const id = pickDaren(found!.data, user);
  if (!id) return remember(cacheKey, now, { state: "none" });
  const results = await read(connection, [
    { key: "daren_info", params: { user_id: id } }, { key: "daren_trend", params: { user_id: id } }, { key: "daren_work_average", params: { user_id: id } },
    { key: "daren_top_videos", params: { user_id: id, start_date: shiftDay(latestDay, -30), end_date: latestDay } }, { key: "daren_fans", params: { user_id: id } },
  ], signal);
  ensureReadable(results);
  const [info, trend, works, videos, fans] = results.map((item) => item.data);
  const detail = parseDaren(info, trend);
  if (!detail) throw unavailable();
  const value: DarenResult = { state: "ok", detail, latestDay, works: parseWorkAverages(works), videos: parseTopVideos(videos), fans: parseFans(fans) };
  // 只缓存完整的：缺一块多半是临时没读到，不能让它卡住十分钟
  return value.works && value.videos && value.fans ? remember(cacheKey, now, value) : value;
}

function remember(key: string, at: number, value: DarenResult): DarenResult {
  darenCache.set(key, { at, value });
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
