import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function readExport(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return typeof data?.account?.user_id === "string" && data.account.user_id && data.lists ? data : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

function latestLists(previous, incoming) {
  const lists = { ...previous?.lists };
  for (const key of ["favorites", "likes"]) {
    const list = incoming.lists[key];
    if (!Array.isArray(list?.notes)) continue;
    const at = list.exported_at || incoming.exported_at || "";
    if (!lists[key] || at >= (lists[key].exported_at || "")) lists[key] = { ...list, exported_at: at };
  }
  const newest = previous?.exported_at > incoming.exported_at ? previous : incoming;
  return { exported_at: newest.exported_at, account: newest.account, lists };
}

// Before per-account profiles, only the UID in each export identified its
// owner. Install destination snapshots before relocating source archives so
// an interrupted migration can be resumed with the same account IDs.
export async function migrateXhsExports(registry) {
  const root = registry.root;
  const marker = path.join(root, "export-migration-v1.json");
  try { await stat(marker); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const latestFile = path.join(root, "latest.json");
  const latest = await readExport(latestFile);
  const grouped = new Map();
  const archives = [];
  for (const name of (await readdir(root)).filter(name => /^notes-[^/]+\.json$/u.test(name)).sort()) {
    const data = await readExport(path.join(root, name));
    if (!data) continue;
    const uid = data.account.user_id;
    grouped.set(uid, latestLists(grouped.get(uid), data));
    archives.push({ uid, name });
  }
  if (latest) grouped.set(latest.account.user_id, latestLists(grouped.get(latest.account.user_id), latest));
  const initial = registry.get("default");
  const defaultUid = initial?.uid || latest?.account.user_id ||
    [...grouped.values()].sort((a, b) => String(b.exported_at).localeCompare(String(a.exported_at)))[0]?.account.user_id;
  const byUid = new Map(registry.list().accounts.filter(a => a.uid).map(a => [a.uid, a]));
  const staged = [];
  for (const [uid, data] of grouped) {
    const account = byUid.get(uid) ?? (uid === defaultUid && initial ? initial : await registry.create());
    const target = registry.directory(account);
    const prior = await readExport(path.join(target, "latest.json"));
    const merged = latestLists(prior?.account?.user_id === uid ? prior : null, data);
    await registry.update(account.id, { uid, nickname: account.nickname || merged.account.nickname, lastSyncedAt: merged.exported_at });
    byUid.set(uid, account);
    staged.push({ target, data: merged });
  }
  for (const row of staged.filter(row => row.target !== root)) await writeJson(path.join(row.target, "latest.json"), row.data);
  if (latest && registry.directory(byUid.get(latest.account.user_id)) !== root) {
    const owner = registry.directory(byUid.get(latest.account.user_id));
    await rename(latestFile, path.join(owner, "notes-recovered-" + randomUUID() + ".json"));
  }
  for (const row of staged.filter(row => row.target === root)) await writeJson(latestFile, row.data);
  for (const { uid, name } of archives) {
    const target = registry.directory(byUid.get(uid));
    if (target === root) continue;
    let destination = path.join(target, name);
    try {
      await stat(destination);
      destination = path.join(target, "notes-recovered-" + randomUUID() + ".json");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(path.join(root, name), destination);
  }
  await writeJson(marker, { version: 1 });
}
