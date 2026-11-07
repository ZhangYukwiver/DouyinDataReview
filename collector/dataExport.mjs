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
 * @param {(ids: string[]) => Promise<Array<{ id: string, text?: string, error?: string, message?: string }>>} transcribe
 * @param {{ signal?: AbortSignal, onProgress?: (progress: { completed: number, total: number }) => void }} options
 */
export async function transcribeExportVoices(data, transcribe, { signal, onProgress } = {}) {
  const voices = data.chatMessages.filter(message => message.type === "voice");
  const pending = voices.filter(message => message.voiceTranscription?.status !== "done" || !message.text?.trim());
  // 和 collector/chatVoice.mjs 的 VOICE_BATCH_SIZE 一致（这个文件也打进网页，不引那边的 node 代码）
  const batches = [];
  for (let index = 0; index < pending.length; index += 10) batches.push(pending.slice(index, index + 10));
  let completed = voices.length - pending.length;
  let missing = 0;
  let next = 0;
  let connectionFailure;
  onProgress?.({ completed, total: voices.length });
  const transcribeBatch = async batch => {
    signal?.throwIfAborted();
    let results;
    try {
      if (connectionFailure) throw connectionFailure;
      results = await transcribe(batch.map(message => message.id));
    } catch (error) {
      signal?.throwIfAborted();
      if (["account_changed", "account_mismatch"].includes(error?.code)) {
        next = batches.length; // 其余并发的别再领新批次
        throw error;
      }
      const known = typeof error?.code === "string" && typeof error.message === "string";
      if (!known || connectionErrors.has(error.code)) connectionFailure = error;
      results = batch.map(message => ({ id: message.id, error: known ? error.code : "unreachable",
        message: known ? error.message : "转写超时或连接中断，请稍后重新导出。" }));
    }
    for (const message of batch) {
      const result = Array.isArray(results) ? results.find(item => item?.id === message.id) : null;
      if (typeof result?.text === "string" && result.text.trim() && result.text.length <= 16_000) {
        message.text = result.text.trim();
        message.voiceTranscription = { status: "done" };
        continue;
      }
      const failure = typeof result?.error === "string" && typeof result.message === "string" ? result
        : { error: "voice_text_unavailable", message: "抖音未返回有效的语音文字。" };
      message.voiceTranscription = { status: unavailableErrors.has(failure.error) ? "unavailable" : "failed", reason: failure.message };
      message.text ||= "[语音未转写]";
      missing++;
    }
    completed += batch.length;
    onProgress?.({ completed, total: voices.length });
  };
  // 10 条一批：一批只核对一次账号、发一次请求。先单独转第一批确认登录还有效（失效就不必让并发请求都撞一遍），
  // 其余几批一起转。ponytail: 固定 4 路，抖音开始限流（rate_limited）再调小
  if (batches.length) await transcribeBatch(batches[next++]);
  const worker = async () => { while (next < batches.length) await transcribeBatch(batches[next++]); };
  await Promise.all(Array.from({ length: 4 }, worker));
  signal?.throwIfAborted();
  if (missing) data.warnings.push(`${missing} 条语音未转写，已保留原消息并注明原因。`);
  return data;
}
