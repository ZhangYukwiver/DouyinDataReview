import type { ExploreConnection } from "./explorer";
import { LocalCollectorError, normalizeCollectorBaseUrl } from "./localCollector";

export interface LiveQuality { key: string; name: string; url: string }
export interface LiveRoomInfo {
  webRid: string; roomId: string; live: boolean; title: string;
  anchor: { name: string; avatar: string | null; secUid: string | null };
  cover: string | null; online: number | null; likes: number | null;
  qualities: LiveQuality[]; defaultQuality: string | null;
}
export interface LiveDanmaku { seq: number; user: string; text: string }
/** 关注的人里正在播的一位 */
export interface LiveFollowing {
  webRid: string; title: string; anchor: { name: string; avatar: string | null };
  cover: string | null; online: string | null; tag: string | null;
}
export interface LiveRoomState {
  id: string; room: LiveRoomInfo | null; online: number | null; likes: number | null;
  ended: boolean; cursor: number; messages: LiveDanmaku[];
}

async function request<T>(connection: ExploreConnection, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, init.timeoutMs ?? 15_000);
  try {
    init.signal?.throwIfAborted();
    const response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}${path}`, {
      ...init, signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
    });
    const value = await response.json();
    if (!response.ok) throw new LocalCollectorError(value.error ?? "live_failed", value.message ?? (response.status === 401
      ? "连接已过期，请重新连接采集器。" : response.status === 404 ? "采集器还不认识直播间，请重启应用。" : "直播间没打开，请稍后重试。"));
    return value as T;
  } catch (error) {
    init.signal?.throwIfAborted();
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("live_unreachable", "连不上本地采集器，请检查连接。");
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

/** 进房要开标签页、等抖音回直播间信息，冷启动浏览器或网络慢时要等上几十秒。 */
export const openLiveRoom = (connection: ExploreConnection, room: string, signal?: AbortSignal) =>
  request<LiveRoomState>(connection, "/v1/live/rooms", { method: "POST", body: JSON.stringify({ room }), signal, timeoutMs: 90_000 });
export const readLiveRoom = (connection: ExploreConnection, id: string, after: number, signal?: AbortSignal) =>
  request<LiveRoomState>(connection, `/v1/live/rooms/${encodeURIComponent(id)}?after=${after}`, { signal });
/** 采集器缓存 30 秒；refresh 跳过缓存。 */
export const readFollowingLive = (connection: ExploreConnection, refresh: boolean, signal?: AbortSignal) =>
  request<{ rooms: LiveFollowing[] }>(connection, `/v1/live/following${refresh ? "?refresh=1" : ""}`, { signal, timeoutMs: 45_000 }).then((value) => value.rooms);
export const closeLiveRoom = (connection: ExploreConnection, id: string) =>
  request<{ closed: boolean }>(connection, `/v1/live/rooms/${encodeURIComponent(id)}`, { method: "DELETE" });

/** 和采集器同一套规则：live.douyin.com 的链接或纯数字房间号。 */
export function liveRoomIdFrom(value: string): string | null {
  const text = value.trim();
  if (/^\d{1,20}$/u.test(text)) return text;
  try {
    const url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
    return url.hostname === "live.douyin.com" ? /^\/(\d{1,20})\/?$/u.exec(url.pathname)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

// ---- 弹幕设置 ----

export type DanmakuSpeed = "slow" | "normal" | "fast";
export interface DanmakuSettings {
  enabled: boolean;
  /** 0.1–1 */
  opacity: number;
  /** 字号，像素 */
  size: number;
  speed: DanmakuSpeed;
  /** 弹幕占画面上方的比例：1/4、半屏、3/4、满屏 */
  area: number;
  blocked: string[];
}
export const DEFAULT_DANMAKU: DanmakuSettings = { enabled: true, opacity: 0.9, size: 22, speed: "normal", area: 0.5, blocked: [] };
export const DANMAKU_AREAS = [0.25, 0.5, 0.75, 1] as const;
/** 匀速滚动的速度，像素/秒：所有弹幕一样快，同一条轨道上后一条就永远追不上前一条 */
export const DANMAKU_SPEED: Record<DanmakuSpeed, number> = { slow: 90, normal: 140, fast: 210 };

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function normalizeDanmakuSettings(value: unknown): DanmakuSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof DanmakuSettings, unknown>>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_DANMAKU.enabled,
    opacity: clamp(raw.opacity, 0.1, 1, DEFAULT_DANMAKU.opacity),
    size: Math.round(clamp(raw.size, 14, 36, DEFAULT_DANMAKU.size)),
    speed: raw.speed === "slow" || raw.speed === "fast" ? raw.speed : "normal",
    area: DANMAKU_AREAS.includes(raw.area as (typeof DANMAKU_AREAS)[number]) ? raw.area as number : DEFAULT_DANMAKU.area,
    blocked: Array.isArray(raw.blocked) ? [...new Set(raw.blocked.filter((word): word is string => typeof word === "string").map((word) => word.trim()).filter(Boolean))].slice(0, 50) : [],
  };
}

/** 屏蔽词用空格、逗号或顿号隔开。 */
export const parseBlockedWords = (text: string) => normalizeDanmakuSettings({ blocked: text.split(/[\s,，、]+/u) }).blocked;

export function isDanmakuBlocked(text: string, blocked: string[]): boolean {
  const lower = text.toLocaleLowerCase();
  return blocked.some((word) => lower.includes(word.toLocaleLowerCase()));
}

const SETTINGS_KEY = "dy2.liveDanmaku";
export function loadDanmakuSettings(): DanmakuSettings {
  try {
    return normalizeDanmakuSettings(JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return DEFAULT_DANMAKU;
  }
}
export function saveDanmakuSettings(settings: DanmakuSettings) {
  try { globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 存不了就只管这一次 */ }
}
