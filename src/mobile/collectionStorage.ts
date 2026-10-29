import { Directory, File, Paths } from "expo-file-system";
import { loadProof } from "./proofStorage";
import { MAX_COLLECTION_BYTES, mergeCollectionPage, migrateProof, parseMobileSnapshot, type CollectionPage, type MobileSnapshot } from "./collectionData";

const directory = () => new Directory(Paths.document, "android-collections");
const slot = (index: number) => new File(directory(), `records-${index}.json`);

async function writeSnapshot(snapshot: MobileSnapshot): Promise<MobileSnapshot> {
  const raw = JSON.stringify(snapshot);
  if (raw.length * 3 > MAX_COLLECTION_BYTES) throw new Error("本机记录达到容量限制，已保存数据仍可查看和导出。");
  directory().create({ intermediates: true, idempotent: true });
  const target = slot(snapshot.revision % 2);
  // Keep the previous verified revision intact until the new file can be read back.
  target.write(raw);
  if (await target.text() !== raw) throw new Error("保存校验失败，上一份记录已保留。");
  return snapshot;
}
export async function loadCollections(): Promise<{ snapshot: MobileSnapshot | null; warning: string | null }> {
  const valid: MobileSnapshot[] = [];
  let damaged = false;
  for (const index of [0, 1]) {
    const file = slot(index);
    if (!file.exists) continue;
    try {
      if (file.size > MAX_COLLECTION_BYTES) throw new Error("oversize");
      valid.push(parseMobileSnapshot(await file.text()));
    } catch { damaged = true; }
  }
  valid.sort((a, b) => b.revision - a.revision);
  if (valid[0]) return { snapshot: valid[0], warning: damaged ? "最近一次保存不完整，已恢复上一份有效记录。" : null };
  if (damaged) throw new Error("本机记录文件无法读取，文件已保留；请先备份应用数据，避免覆盖。");
  const legacy = await loadProof();
  if (!legacy.snapshot) return { snapshot: null, warning: legacy.warning };
  const migrated = await writeSnapshot(migrateProof(legacy.snapshot));
  return { snapshot: migrated, warning: "已保留验证版的观看记录，可继续采集并生成报告。" };
}
export async function saveCollectionPage(previous: MobileSnapshot | null, page: CollectionPage): Promise<MobileSnapshot> {
  return writeSnapshot(mergeCollectionPage(previous, page));
}
export async function saveCollectionState(snapshot: MobileSnapshot): Promise<MobileSnapshot> {
  return writeSnapshot({ ...snapshot, revision: snapshot.revision + 1 });
}
