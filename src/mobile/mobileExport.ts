import { StorageAccessFramework } from "expo-file-system/legacy";
import { COLLECTION_TYPES, personalRecords, type MobileSnapshot } from "./collectionData";

export async function exportMobileFile(name: string, mime: string, content: string): Promise<boolean> {
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return false;
  const uri = await StorageAccessFramework.createFileAsync(permission.directoryUri, name, mime);
  await StorageAccessFramework.writeAsStringAsync(uri, content);
  return true;
}
export function mobileBackup(snapshot: MobileSnapshot): string {
  // Same portable schema as the desktop export; no WebView cookies or request URLs.
  return JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), source: "collector",
    parts: COLLECTION_TYPES.map(item => item.id), updatedAt: snapshot.savedAt, records: personalRecords(snapshot),
    chatConversations: [], chatMessages: [], warnings: ["Android 本机累计采集，不代表完整历史。"],
  }, null, 2);
}
