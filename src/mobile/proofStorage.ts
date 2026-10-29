import { Directory, File, Paths } from "expo-file-system";
import { MAX_PROOF_BYTES, parseSnapshot, type ProofSnapshot } from "./proofData";

const directory = () => new Directory(Paths.document, "android-proof");
const slot = (index: number) => new File(directory(), `page-${index}.json`);

export async function loadProof(): Promise<{ snapshot: ProofSnapshot | null; warning: string | null }> {
  const valid: ProofSnapshot[] = [];
  let damaged = false;
  for (const index of [0, 1]) {
    const file = slot(index);
    if (!file.exists) continue;
    try {
      if (file.size > MAX_PROOF_BYTES) throw new Error("oversize");
      valid.push(parseSnapshot(await file.text()));
    } catch { damaged = true; }
  }
  valid.sort((a, b) => b.revision - a.revision);
  return { snapshot: valid[0] ?? null, warning: damaged
    ? valid.length ? "最近一次保存不完整，已恢复上一份有效记录。" : "本机记录无法读取，文件已保留，请重新读取一页。"
    : null };
}

export async function saveProof(page: Pick<ProofSnapshot, "account" | "records" | "hasMore">): Promise<ProofSnapshot> {
  const { snapshot: previous } = await loadProof();
  const next = parseSnapshot(JSON.stringify({ ...page, version: 1, revision: (previous?.revision ?? 0) + 1, savedAt: new Date().toISOString() }));
  directory().create({ intermediates: true, idempotent: true });
  // Alternate two files. A killed process or a partial write leaves the last valid page intact.
  const target = slot(next.revision % 2);
  target.write(JSON.stringify(next));
  const verified = parseSnapshot(await target.text());
  if (JSON.stringify(verified) !== JSON.stringify(next)) throw new Error("本机保存校验失败，上一份记录已保留。");
  return verified;
}
