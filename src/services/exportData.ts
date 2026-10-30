import { createEmptyPersonalRecords, type PersonalRecordType } from "../domain/personalRecords";
import type { CollectorSnapshot } from "./localCollector";
import { collectorFetch, LocalCollectorError } from "./localCollector";
import type { ChatMessage } from "../domain/chatRecords";
import type { ChatSendConnection } from "./chatSend";

export type DataExportSelection = Record<PersonalRecordType | "chat", boolean>;

export function buildDataExport(snapshot: CollectorSnapshot, selection: DataExportSelection, exportedAt = new Date().toISOString()) {
  const parts = (Object.keys(selection) as Array<keyof DataExportSelection>).filter(part => selection[part]);
  if (!parts.length) throw new Error("请至少选择一部分数据。");
  const records = createEmptyPersonalRecords();
  for (const part of ["watch_history", "liked_videos", "favorite_videos"] as const) {
    if (selection[part]) records[part] = snapshot.records[part];
  }
  return { schemaVersion: 2 as const, exportedAt, source: "collector", parts, updatedAt: snapshot.updatedAt,
    records, chatConversations: selection.chat ? snapshot.chatConversations : [], chatMessages: selection.chat ? snapshot.chatMessages.map(portableMessage) : [],
    // Collection warnings can mention data outside the selected parts.
    warnings: [] as string[] };
}

function portableMessage(message: ChatMessage): ChatMessage {
  // Defensive even when the caller bypasses parseCollectorSnapshot: local audio
  // resource identifiers and decryption keys never belong in the export.
  const { voiceResource: _resource, ...portable } = message as ChatMessage & { voiceResource?: unknown };
  return portable;
}

export async function buildDataExportWithVoice(snapshot: CollectorSnapshot, selection: DataExportSelection, options: {
  connection: ChatSendConnection | null; accountId: string | null; signal: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
}) {
  const data = buildDataExport(snapshot, selection);
  const voices = data.chatMessages.filter(message => message.type === "voice");
  let completed = 0;
  let connectionFailure: LocalCollectorError | null = null;
  options.onProgress?.({ completed, total: voices.length });
  for (const message of voices) {
    options.signal.throwIfAborted();
    if (message.voiceTranscription?.status !== "done" || !message.text?.trim()) {
      try {
        if (connectionFailure) throw connectionFailure;
        if (!options.connection || !options.accountId)
          throw new LocalCollectorError("voice_resource_missing", "请连接原账号后重新导出语音文字。");
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 40_000);
        try {
          const response = await collectorFetch(options.connection, `/v1/chat/voice/transcribe?account=${encodeURIComponent(options.accountId)}`, {
            method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: message.id }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new LocalCollectorError(result?.error ?? "voice_transcription_failed", result?.message ?? "抖音语音转写失败。");
          if (result?.id !== message.id || typeof result?.text !== "string" || !result.text.trim() || result.text.length > 16_000)
            throw new LocalCollectorError("voice_text_unavailable", "抖音未返回有效的语音文字。");
          message.text = result.text.trim();
          message.voiceTranscription = { status: "done" };
        } finally { clearTimeout(timeout); options.signal.removeEventListener("abort", abort); }
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof LocalCollectorError && ["account_changed", "account_mismatch"].includes(error.code)) throw error;
        const unavailable = error instanceof LocalCollectorError && ["voice_resource_missing", "voice_text_unavailable", "voice_not_found"].includes(error.code);
        if (!(error instanceof LocalCollectorError) || ["login_required", "direct_session_missing", "write_credentials_missing", "browser_reconnect_required", "session_rejected", "verification_required", "rate_limited", "chat_read_disabled", "not_paired"].includes(error.code)) {
          connectionFailure = error instanceof LocalCollectorError ? error
            : new LocalCollectorError("unreachable", "转写超时或连接中断，请稍后重新导出。");
        }
        message.voiceTranscription = { status: unavailable ? "unavailable" : "failed",
          reason: error instanceof LocalCollectorError ? error.message : "转写超时或连接中断，请稍后重新导出。" };
        message.text ||= "[语音未转写]";
      }
    }
    options.onProgress?.({ completed: ++completed, total: voices.length });
  }
  options.signal.throwIfAborted();
  const missing = voices.filter(message => message.voiceTranscription?.status !== "done").length;
  if (missing) data.warnings.push(`${missing} 条语音未转写，已保留原消息并注明原因。`);
  return data;
}
