import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformAccountRegistry } from "./platformAccounts.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "platform-accounts-"));
  roots.push(value);
  return value;
}

const exists = file => access(file).then(() => true, () => false);

describe("PlatformAccountRegistry", () => {
  it("keeps the historical default files and migrates identity metadata", async () => {
    const directory = await root();
    const platform = path.join(directory, "xiaohongshu");
    await mkdir(path.join(platform, "browser-profile"), { recursive: true });
    await writeFile(path.join(platform, "account.json"), JSON.stringify({ user_id: "u1", nickname: "小明", checked_at: "2026-11-20T00:00:00.000Z" }));
    await writeFile(path.join(platform, "latest.json"), "{}");
    const registry = new PlatformAccountRegistry(platform, "xiaohongshu");
    await registry.load();
    expect(registry.list()).toMatchObject({
      platform: "xiaohongshu",
      activeId: "default",
      accounts: [{ id: "default", uid: "u1", nickname: "小明", loggedIn: true, lastSyncedAt: "2026-11-20T00:00:00.000Z" }],
    });
    expect(registry.directory("default")).toBe(platform);
    expect(JSON.parse(await readFile(path.join(platform, "accounts.json"))).accounts).toHaveLength(1);
  });

  it("isolates new accounts, rejects deleting the active one, and keeps root shared metadata", async () => {
    const platform = path.join(await root(), "xiaohongshu");
    const registry = new PlatformAccountRegistry(platform, "xiaohongshu");
    await registry.load();
    const second = await registry.create();
    await writeFile(path.join(platform, "shared.txt"), "keep");
    await expect(registry.remove("default")).rejects.toMatchObject({ code: "account_active", status: 409 });
    await registry.setActive(second.id);
    await registry.remove("default");
    expect(await exists(path.join(platform, "accounts", second.id))).toBe(true);
    expect(await exists(path.join(platform, "shared.txt"))).toBe(false);
    expect((await readdir(platform)).sort()).toEqual(["accounts", "accounts.json"]);
  });

  it("updates notes and preserves content when logging out", async () => {
    const platform = path.join(await root(), "xiaohongshu");
    const registry = new PlatformAccountRegistry(platform, "xiaohongshu");
    await registry.load();
    await registry.update("default", { uid: "u1", nickname: "甲", note: "主号", loggedIn: true });
    await registry.update("default", { loggedIn: false });
    expect(registry.list().accounts[0]).toMatchObject({ uid: "u1", nickname: "甲", note: "主号", loggedIn: false });
  });
});

