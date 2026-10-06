import { LocalCollectorError, normalizeCollectorBaseUrl } from "./localCollector";
import type { ExploreConnection } from "./explorer";

// 创作者中心：工作台把一批查询交给采集器，采集器在 creator.douyin.com 同源页里读完原样带回。
// key 和参数名必须在 collector/creatorCenter.mjs 的白名单里。

export type CreatorKey =
  "user_info" | "author_upgrade" | "diagnosis" | "contribution_top" | "dashboard" | "dashboard_mix" | "dashboard_fans" | "mix_list" | "live_dashboard" | "live_trends" | "live_gift_billboard" | "live_watch_billboard" | "live_fans_source" | "fans_summary" | "work_list" | "item_list" | "item_mget" | "item_summarize" | "item_compare" | "item_trend" | "item_realtime" | "item_progress" | "item_bullet" | "item_chapter" | "item_play_source" | "item_search_keyword" | "item_portrait" | "item_audience" | "comment_hotwords" | "comment_list" | "comment_replies" | "comment_list_old" | "comment_replies_old";
export interface CreatorQuery { key: CreatorKey; params?: Record<string, string | number> }
/** 抖音原样的 JSON；读失败的那一项是 null */
export type CreatorData = Record<string, any> | null;

export async function readCreator(connection: ExploreConnection, queries: CreatorQuery[], signal?: AbortSignal): Promise<CreatorData[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 45000);
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}/v1/creator/read`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ requests: queries }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new LocalCollectorError(value?.error ?? "creator_failed", value?.message ?? (
      response.status === 401 ? "连接已过期，请重新连接采集器。" : response.status === 404 ? "当前采集器还没有创作者中心模块，请重启应用。" : "没读到创作者中心的数据，请稍后重试。"));
    const results = value?.results;
    if (!Array.isArray(results) || results.length !== queries.length) throw new LocalCollectorError("invalid_response", "创作者中心数据格式不对，请更新应用。");
    return results.map((item) => (item?.ok && item.data && typeof item.data === "object" ? item.data : null));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("creator_unreachable", "读取超时或采集器没连上，请检查连接后重试。");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
