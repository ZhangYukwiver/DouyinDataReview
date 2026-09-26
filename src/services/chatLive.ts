import type { ChatMessage } from "../domain/chatRecords";
import type { OfficialStreak } from "../domain/chatSparks";
import type { ChatSendConnection } from "./chatSend";
import { LocalCollectorError, normalizeCollectorBaseUrl } from "./localCollector";

// 群消息和抖音自己的火花天数都是从采集器里开着的抖音网页现读的，不落盘。
async function call<T>(connection: ChatSendConnection, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  // 往上翻一页最多要滚十来次，留足时间
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
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

export async function loadLiveMessages(connection: ChatSendConnection, conversationId: string, older = false): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const value = await call<{ messages?: unknown; hasMore?: unknown }>(connection, "/v1/chat/messages", { conversationId, older });
  return { messages: Array.isArray(value?.messages) ? value.messages as ChatMessage[] : [], hasMore: value?.hasMore === true };
}
