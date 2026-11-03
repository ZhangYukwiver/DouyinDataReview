import { collectorFetch, LocalCollectorError } from "./localCollector";

export type UsageSource = "app" | "chrome" | "edge" | "comet";
export const usageSourceLabels: Record<UsageSource, string> = { app: "软件窗口", chrome: "Chrome 网页", edge: "Edge 网页", comet: "Comet 网页" };
export type UsageEndReason = "closed" | "hidden" | "left_site" | "suspended" | "stopped" | "disconnected" | "interrupted";
export interface UsageSession {
  id: string; source: UsageSource; startedAt: number; lastSeenAt: number; endedAt: number | null;
  durationMs: number; startKind: "opened" | "observed" | "resumed"; endReason: UsageEndReason | null;
}
export interface UsageBrowserState {
  state: "idle" | "connecting" | "connected" | "disconnected" | "error";
  browser: Exclude<UsageSource, "app"> | null; label: string | null; tabs: number; error: string | null;
}
export interface UsageSnapshot {
  sessions: UsageSession[]; total: number; offset: number; hasMore: boolean; updatedAt: number; error: string | null;
  activeSources: UsageSource[]; browser: UsageBrowserState;
  today: { durationMs: number; count: number; bySource: Record<UsageSource, number> };
}
export interface UsageConnection { baseUrl: string; token: string }
export interface UsageAutoSettings { enabled: boolean; browser: Exclude<UsageSource, "app"> }

async function request(connection: UsageConnection, route: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await collectorFetch(connection, `/v1/usage/${route}`, { ...init, signal: controller.signal,
      headers: { "Content-Type": "application/json", ...init.headers } });
    const value = await response.json();
    if (!response.ok) throw new LocalCollectorError(value.error ?? "usage_failed", value.message ?? (response.status === 404
      ? "当前采集器尚未加载使用记录，请重启应用或采集服务。" : "使用记录请求失败，请重试。"));
    return value;
  } catch (error) {
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("usage_unreachable", "无法连接使用记录服务，请检查采集器是否正在运行。");
  } finally { clearTimeout(timer); }
}

export async function readUsageSessions(connection: UsageConnection, offset = 0): Promise<UsageSnapshot> {
  const value = await request(connection, `sessions?offset=${Math.max(0, Math.floor(offset))}`) as UsageSnapshot;
  if (!value || !Array.isArray(value.sessions) || !value.browser || !value.today || !Number.isFinite(value.today.durationMs)
    || !Number.isSafeInteger(value.total) || !Array.isArray(value.activeSources)
    || !value.sessions.every(row => row && typeof row.id === "string" && Object.hasOwn(usageSourceLabels, row.source)
      && Number.isFinite(row.startedAt) && Number.isFinite(row.durationMs) && row.durationMs >= 0
      && (row.endedAt === null || Number.isFinite(row.endedAt))))
    throw new LocalCollectorError("invalid_response", "使用记录格式无效，请更新采集器。");
  return value;
}

export async function startUsageBrowser(connection: UsageConnection, browser: Exclude<UsageSource, "app">): Promise<void> {
  await request(connection, "browser", { method: "POST", body: JSON.stringify({ browser }) }, 70_000);
}

export async function stopUsageBrowser(connection: UsageConnection): Promise<void> {
  await request(connection, "browser", { method: "DELETE" });
}

export async function usageAutoSettings(connection: UsageConnection, settings?: UsageAutoSettings): Promise<UsageAutoSettings> {
  const value = await request(connection, "settings", settings ? { method: "POST", body: JSON.stringify(settings) } : {}) as { settings?: UsageAutoSettings };
  if (!value?.settings || typeof value.settings.enabled !== "boolean" || !["chrome", "edge", "comet"].includes(value.settings.browser))
    throw new LocalCollectorError("invalid_response", "自动连接设置格式无效，请更新采集器。");
  return value.settings;
}

export function usageDurationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时 ${minutes}分` : minutes ? `${minutes}分 ${seconds % 60}秒` : `${seconds}秒`;
}
