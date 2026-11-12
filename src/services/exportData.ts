import { buildDataExport, transcribeExportVoices } from "../../collector/dataExport.mjs";
import type { PersonalRecordType } from "../domain/personalRecords";
import type { ChatSendConnection } from "./chatSend";
import { collectorFetch, LocalCollectorError, type CollectorSnapshot } from "./localCollector";
import type { RecordFolders } from "./recordFolders";

export { buildDataExport };
export type DataExportSelection = Record<PersonalRecordType | "chat", boolean>;

export async function buildDataExportWithVoice(snapshot: CollectorSnapshot, selection: DataExportSelection, options: {
  connection: ChatSendConnection | null; accountId: string | null; signal: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** 只导这个时间之后的观看历史和聊天 */
  since?: string | null;
  /** 记录带上所在文件夹 */
  folders?: RecordFolders | null;
}) {
  const data = buildDataExport(snapshot, selection, { since: options.since, folders: options.folders });
  return transcribeExportVoices(data, async messageIds => {
    if (!options.connection || !options.accountId)
      throw new LocalCollectorError("voice_resource_missing", "请连接原账号后重新导出语音文字。");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 40_000);
    try {
      const response = await collectorFetch(options.connection, `/v1/chat/voice/transcribe?account=${encodeURIComponent(options.accountId)}`, {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIds }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new LocalCollectorError(result?.error ?? "voice_transcription_failed", result?.message ?? "抖音语音转写失败。");
      return result?.results;
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    }
  }, options);
}
