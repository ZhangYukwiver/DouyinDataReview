import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { PlatformAccountRegistry } from "./platformAccounts.mjs";
import { migrateXhsExports } from "./xiaohongshuMigration.mjs";

it("按 UID 恢复同名账号，每类使用最新导出，重复启动保持账号与归属", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xhs-uid-"));
  const save = (file, obj) => writeFile(path.join(root, file), JSON.stringify(obj));
  const snapshot = (uid, day, list, note) => ({ account: { user_id: uid, nickname: "同名账号" }, exported_at: day,
    lists: { [list]: { notes: [{ note_id: note }] } } });
  try {
    await save("account.json", { user_id: "first", nickname: "同名账号" });
    await save("notes-a.json", snapshot("first", "2026-01-01", "likes", "1"));
    await save("notes-b.json", snapshot("second", "2026-02-01", "favorites", "2"));
    await save("latest.json", snapshot("second", "2026-03-01", "favorites", "3"));
    const registry = new PlatformAccountRegistry(root, "xiaohongshu");
    await registry.load();
    await migrateXhsExports(registry);
    const accounts = registry.list().accounts;
    expect(accounts.map(a => a.uid).sort()).toEqual(["first", "second"]);
    const read = async a => JSON.parse(await readFile(path.join(registry.directory(a), "latest.json"), "utf8"));
    expect((await read(registry.get("default"))).lists).toMatchObject({ likes: { notes: [{ note_id: "1" }] } });
    const second = accounts.find(a => a.uid === "second");
    expect((await read(second)).lists.favorites.notes[0].note_id).toBe("3");
    expect(await readFile(path.join(registry.directory(second), "notes-b.json"), "utf8")).toContain("second");
    await migrateXhsExports(registry);
    expect(registry.list().accounts).toEqual(accounts);
  } finally { await rm(root, { recursive: true, force: true }); }
});
