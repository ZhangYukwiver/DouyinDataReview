/** @typedef {import("../src/services/localCollector").CollectorSnapshot} CollectorSnapshot */
/** @typedef {import("../src/domain/chatRecords").ChatMessage} ChatMessage */
/** @typedef {import("../src/domain/personalRecords").PersonalRecordType | "chat"} ExportPart */

/** @param {CollectorSnapshot} snapshot @param {Partial<Record<ExportPart, boolean>>} selection */
export function buildDataExport(snapshot, selection, exportedAt = new Date().toISOString()) {
  const parts = /** @type {ExportPart[]} */ (Object.keys(selection)).filter(part => selection[part]);
  if (!parts.length) throw new Error("请至少选择一部分数据。");
  return {
    schemaVersion: /** @type {const} */ (2), exportedAt, source: "collector", parts, updatedAt: snapshot.updatedAt,
    records: {
      watch_history: selection.watch_history ? snapshot.records.watch_history : [],
      liked_videos: selection.liked_videos ? snapshot.records.liked_videos : [],
      favorite_videos: selection.favorite_videos ? snapshot.records.favorite_videos : [],
    },
    chatConversations: selection.chat ? snapshot.chatConversations : [],
    chatMessages: selection.chat ? snapshot.chatMessages.map(portableMessage) : [],
    warnings: /** @type {string[]} */ ([]),
  };
}

/** @param {ChatMessage & { voiceResource?: unknown }} message @returns {ChatMessage} */
function portableMessage({ voiceResource, ...message }) {
  // 本地音频资源含解密资料，导出只带可移植的消息字段。
  return message;
}

const connectionErrors = new Set(["login_required", "direct_session_missing", "write_credentials_missing",
  "browser_reconnect_required", "session_rejected", "verification_required", "rate_limited", "chat_read_disabled", "not_paired"]);
const unavailableErrors = new Set(["voice_resource_missing", "voice_text_unavailable", "voice_not_found"]);

/**
 * @param {ReturnType<typeof buildDataExport>} data
 * @param {(id: string) => Promise<{ id: string, text: string }>} transcribe
 * @param {{ signal?: AbortSignal, onProgress?: (progress: { completed: number, total: number }) => void }} options
 */
export async function transcribeExportVoices(data, transcribe, { signal, onProgress } = {}) {
  const voices = data.chatMessages.filter(message => message.type === "voice");
  let completed = 0;
  let missing = 0;
  let connectionFailure;
  onProgress?.({ completed, total: voices.length });
  for (const message of voices) {
    signal?.throwIfAborted();
    if (message.voiceTranscription?.status !== "done" || !message.text?.trim()) {
      try {
        if (connectionFailure) throw connectionFailure;
        const result = await transcribe(message.id);
        if (result?.id !== message.id || typeof result.text !== "string" || !result.text.trim() || result.text.length > 16_000)
          throw Object.assign(new Error("抖音未返回有效的语音文字。"), { code: "voice_text_unavailable" });
        message.text = result.text.trim();
        message.voiceTranscription = { status: "done" };
      } catch (error) {
        signal?.throwIfAborted();
        if (["account_changed", "account_mismatch"].includes(error?.code)) throw error;
        const known = typeof error?.code === "string" && typeof error.message === "string";
        if (!known || connectionErrors.has(error.code)) connectionFailure = error;
        message.voiceTranscription = {
          status: unavailableErrors.has(error?.code) ? "unavailable" : "failed",
          reason: known ? error.message : "转写超时或连接中断，请稍后重新导出。",
        };
        message.text ||= "[语音未转写]";
        missing++;
      }
    }
    onProgress?.({ completed: ++completed, total: voices.length });
  }
  signal?.throwIfAborted();
  if (missing) data.warnings.push(`${missing} 条语音未转写，已保留原消息并注明原因。`);
  return data;
}
