import type { ChatMessage } from "../domain/chatRecords";
import { LocalCollectorError, normalizeCollectorBaseUrl } from "./localCollector";

export interface ChatSendConnection { baseUrl: string; token: string }
export interface ChatSendOutcome { outcome: "confirmed" | "unknown" | "rejected"; message: string; chatMessage?: ChatMessage | null }

// 发送结果拿不到时不能当成失败：消息可能已经发出去了。
export const CHAT_SEND_UNCONFIRMED = "chat_send_unconfirmed";

export async function sendChatMessage(connection: ChatSendConnection, conversationId: string, text: string): Promise<ChatSendOutcome> {
  const controller = new AbortController();
  // 采集器最多花约 35 秒（打开会话 8 秒 + 输入 + 等回执 20 秒）
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let value: Partial<ChatSendOutcome> & { error?: string } | null;
  let response: Response;
  try {
    response = await fetch(`${normalizeCollectorBaseUrl(connection.baseUrl)}/v1/chat/send`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ requestId: crypto.randomUUID(), conversationId, text }),
    });
    value = await response.json().catch(() => null);
  } catch {
    throw new LocalCollectorError(CHAT_SEND_UNCONFIRMED, "没等到发送结果，先在手机上看一眼，再决定要不要重发。");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new LocalCollectorError(value?.error ?? `http_${response.status}`, value?.message
      ?? (response.status === 401 ? "连接已过期，请重新连接采集器。"
        : response.status === 404 ? "当前采集器还不支持发送消息，请重启应用。" : "消息没发出去，请稍后再试。"));
  }
  if (!value || !["confirmed", "unknown", "rejected"].includes(value.outcome ?? "") || typeof value.message !== "string") {
    throw new LocalCollectorError(CHAT_SEND_UNCONFIRMED, "没等到发送结果，先在手机上看一眼，再决定要不要重发。");
  }
  return value as ChatSendOutcome;
}
