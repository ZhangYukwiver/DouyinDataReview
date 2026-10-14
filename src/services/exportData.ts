import { createEmptyPersonalRecords, type PersonalRecordType } from "../domain/personalRecords";
import type { CollectorSnapshot } from "./localCollector";

export type DataExportSelection = Record<PersonalRecordType | "chat", boolean>;

export function buildDataExport(snapshot: CollectorSnapshot, selection: DataExportSelection, exportedAt = new Date().toISOString()) {
  const parts = (Object.keys(selection) as Array<keyof DataExportSelection>).filter(part => selection[part]);
  if (!parts.length) throw new Error("请至少选择一部分数据。");
  const records = createEmptyPersonalRecords();
  for (const part of ["watch_history", "liked_videos", "favorite_videos"] as const) {
    if (selection[part]) records[part] = snapshot.records[part];
  }
  return { schemaVersion: 2 as const, exportedAt, source: "collector", parts, updatedAt: snapshot.updatedAt,
    records, chatConversations: selection.chat ? snapshot.chatConversations : [], chatMessages: selection.chat ? snapshot.chatMessages : [],
    // Collection warnings can mention data outside the selected parts.
    warnings: [] as string[] };
}
