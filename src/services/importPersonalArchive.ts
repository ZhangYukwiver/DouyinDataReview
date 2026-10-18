import type { DocumentPickerAsset } from "expo-document-picker";
import { strFromU8 } from "fflate";
import { Platform } from "react-native";

import {
  MAX_ARCHIVE_BYTES,
  parsePersonalArchiveBytes,
  PersonalArchiveError,
} from "../domain/personalArchiveParser";
import type { PersonalArchiveData } from "../domain/personalRecords";
import { parseExportedSnapshot } from "./localCollector";

async function readWebFile(asset: DocumentPickerAsset): Promise<Uint8Array> {
  if (!asset.file) {
    throw new PersonalArchiveError("unsupported_format", "浏览器没有提供可读取的文件。");
  }

  return new Uint8Array(await asset.file.arrayBuffer());
}

async function readNativeFile(asset: DocumentPickerAsset): Promise<Uint8Array> {
  const { File } = await import("expo-file-system");
  return new File(asset.uri).bytes();
}

async function releaseTemporaryFile(asset: DocumentPickerAsset): Promise<void> {
  if (Platform.OS === "web") {
    if (asset.uri.startsWith("blob:")) URL.revokeObjectURL(asset.uri);
    return;
  }

  try {
    const { File } = await import("expo-file-system");
    new File(asset.uri).delete();
  } catch {
    // The picker cache may already have released the temporary copy.
  }
}

// 本应用自己的导出文件记录一多就几十上百 MB；官方档案在 parsePersonalArchiveBytes 里仍按 32 MB 拦
const MAX_EXPORT_FILE_BYTES = 8 * MAX_ARCHIVE_BYTES;

export async function importPersonalArchive(asset: DocumentPickerAsset): Promise<PersonalArchiveData> {
  if (asset.size !== undefined && asset.size > MAX_EXPORT_FILE_BYTES) {
    throw new PersonalArchiveError("too_large", "文件超过 256 MB。可以导出时只勾一部分类别，分几次导出再分别导入。");
  }

  try {
    const bytes = Platform.OS === "web" ? await readWebFile(asset) : await readNativeFile(asset);
    return parseExportedFile(bytes) ?? parsePersonalArchiveBytes(bytes, asset.name);
  } finally {
    await releaseTemporaryFile(asset);
  }
}

// 本应用导出的文件原样读回：重复观看不合并，聊天也一起带上；其他文件交给官方档案解析器
export function parseExportedFile(bytes: Uint8Array): PersonalArchiveData | null {
  if (bytes[0] !== 0x7b) return null; // 导出文件以 { 开头，ZIP 不用再解一遍 JSON
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(bytes));
  } catch {
    return null;
  }
  const snapshot = parseExportedSnapshot(value);
  if (!snapshot) return null;
  const { records, chatMessages, chatConversations, warnings, updatedAt } = snapshot;
  const fromCollector = (value as { source?: unknown }).source === "collector";
  return { format: "json", records, chatMessages, chatConversations, warnings, updatedAt, fromCollector, parsedFileCount: 1, ignoredFileCount: 0 };
}

export function describePersonalArchiveError(error: unknown): string {
  if (error instanceof PersonalArchiveError) return error.message;
  return "文件读取失败，请确认它来自抖音官方个人信息下载并重试。";
}
