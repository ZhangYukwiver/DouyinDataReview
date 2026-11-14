import type { ChatMessage } from "../domain/chatRecords";
import type { OfficialStreak } from "../domain/chatSparks";
import type { ChatSendConnection } from "./chatSend";
import { LocalCollectorError, collectorFetch } from "./localCollector";

// 群消息和抖音自己的火花天数都是从采集器里开着的抖音网页现读的，不落盘。
async function call<T>(connection: ChatSendConnection, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  // 往上翻一页最多要滚十来次，留足时间
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await collectorFetch(connection, `${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      throw new LocalCollectorError(value?.error ?? `http_${response.status}`, value?.message
        ?? (response.status === 404 ? "当前采集器还不支持，请重启应用。" : "暂时读不到，请稍后再试。"));
    }
    return value as T;
  } catch (error) {
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("unreachable", "暂时连不上采集器，请稍后再试。");
  } finally { clearTimeout(timeout); }
}

export async function loadChatStreaks(connection: ChatSendConnection): Promise<OfficialStreak[]> {
  const value = await call<{ streaks?: unknown }>(connection, "/v1/chat/streaks");
  return Array.isArray(value?.streaks) ? value.streaks as OfficialStreak[] : [];
}

export interface LivePage { messages: ChatMessage[]; hasMore: boolean; cursor: string | null }

/** before 不给就拿最新一批；给了就从这个位置往前翻一页（位置用上一页回的 cursor）。 */
export async function loadLiveMessages(connection: ChatSendConnection, conversationId: string, before: string | null = null): Promise<LivePage> {
  const value = await call<{ messages?: unknown; hasMore?: unknown; cursor?: unknown }>(connection, "/v1/chat/messages", before ? { conversationId, before } : { conversationId });
  const cursor = typeof value?.cursor === "string" && value.cursor ? value.cursor : null;
  return { messages: Array.isArray(value?.messages) ? value.messages as ChatMessage[] : [], hasMore: value?.hasMore === true && cursor !== null, cursor };
}

export interface LiveHistory { messages: ChatMessage[]; cursor: string | null; complete: boolean }

const sentMs = (message: ChatMessage) => Date.parse(message.sentAt ?? "") || 0;

/** 从最新往前一页页翻，翻到比 sinceMs 更早或抖音说到头为止；接着上次的 history 翻，换更长的范围不用重读。 */
export async function extendLiveHistory(load: (before: string | null) => Promise<LivePage>, history: LiveHistory | null, sinceMs: number,
  { signal, onPage }: { signal?: AbortSignal; onPage?: (history: LiveHistory) => void } = {}): Promise<LiveHistory> {
  let current = history;
  // 没时间的消息排在最前，按第一条有时间的算翻到了哪天
  const oldest = (messages: ChatMessage[]) => sentMs(messages.find((message) => sentMs(message) > 0) ?? messages[0] ?? { sentAt: null } as ChatMessage);
  while (!current || (!current.complete && (!current.messages.some((message) => sentMs(message) > 0) || oldest(current.messages) >= sinceMs))) {
    signal?.throwIfAborted();
    const page = await load(current?.cursor ?? null);
    signal?.throwIfAborted();
    const byId = new Map((current?.messages ?? []).map((message) => [message.id, message]));
    for (const message of page.messages) byId.set(message.id, message);
    current = { messages: [...byId.values()].sort((left, right) => sentMs(left) - sentMs(right)), cursor: page.cursor, complete: !page.hasMore };
    onPage?.(current);
  }
  return current;
}
