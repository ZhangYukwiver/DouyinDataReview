import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountRegistry, isAccountId } from "./accounts.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "collector-accounts-"));
  temporaryDirectories.push(root);
  return root;
}

const exists = (target) => access(target).then(() => true, () => false);
const readRegistry = async (root) => JSON.parse(await readFile(path.join(root, "accounts.json"), "utf8"));

describe("AccountRegistry", () => {
  it("starts with the existing data as the default account and saves the list privately", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "records.json"), "{}");
    const registry = new AccountRegistry(root);
    const listed = await registry.load();
    expect(listed).toMatchObject({ activeId: "default", accounts: [{ id: "default", nickname: null, avatar: null, uid: null }] });
    expect(registry.directory(registry.active())).toBe(root);
    expect(await readRegistry(root)).toMatchObject({ schemaVersion: 1, activeId: "default", accounts: [{ id: "default", dir: "" }] });
    if (process.platform !== "win32") expect((await stat(path.join(root, "accounts.json"))).mode & 0o777).toBe(0o600);
    // 再开一次读的是同一份
    expect(await new AccountRegistry(root).load()).toEqual(listed);
  });

  it("creates accounts in their own private directory and lists them oldest first", async () => {
    const root = await makeRoot();
    const registry = new AccountRegistry(root);
    await registry.load();
    const first = await registry.create();
    const second = await registry.create();
    expect(first.id).toMatch(/^[0-9a-f]{12}$/u);
    expect(first.dir).toBe(`accounts/${first.id}`);
    expect(registry.directory(first)).toBe(path.join(root, "accounts", first.id));
    if (process.platform !== "win32") expect((await stat(registry.directory(first))).mode & 0o777).toBe(0o700);
    expect(registry.list().accounts.map((account) => account.id)).toEqual(["default", first.id, second.id]);
    expect(registry.activeId).toBe("default");
    await registry.setActive(second.id);
    expect((await readRegistry(root)).activeId).toBe(second.id);
    await expect(registry.setActive("0123456789ab")).rejects.toMatchObject({ code: "account_not_found", status: 404 });
  });

  it("lists new accounts after the default one even when the clock is behind the folder time", async () => {
    const root = await makeRoot();
    const registry = new AccountRegistry(root);
    await registry.load();
    // 模拟 Windows 上程序时钟比文件系统时间慢
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    try {
      const first = await registry.create();
      const second = await registry.create();
      expect(registry.list().accounts.map((account) => account.id)).toEqual(["default", first.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes only that account's data and never the active one", async () => {
    const root = await makeRoot();
    for (const name of ["browser-profile/Default", "downloads", "direct-signer", "backups"]) await mkdir(path.join(root, name), { recursive: true });
    for (const name of ["records.json", "records.json.123.tmp", "direct-history-template.json", "launcher-error.txt", "direct-signer/signer.js", "backups/old.json"]) {
      await writeFile(path.join(root, name), "x");
    }
    const registry = new AccountRegistry(root);
    await registry.load();
    const other = await registry.create();
    await writeFile(path.join(registry.directory(other), "records.json"), "{}");

    await expect(registry.remove("default")).rejects.toMatchObject({ code: "account_active", status: 409 });
    await expect(registry.remove("../accounts")).rejects.toMatchObject({ code: "account_not_found" });
    await registry.setActive(other.id);
    await registry.remove("default");
    expect((await readdir(root)).sort()).toEqual(["accounts", "accounts.json", "backups", "direct-signer", "launcher-error.txt"]);
    expect(await exists(path.join(root, "direct-signer", "signer.js"))).toBe(true);
    expect(registry.list()).toMatchObject({ activeId: other.id, accounts: [{ id: other.id }] });

    const third = await registry.create();
    await registry.setActive(third.id);
    await registry.remove(other.id);
    expect(await exists(path.join(root, "accounts", other.id))).toBe(false);
    expect((await readRegistry(root)).accounts.map((account) => account.id)).toEqual([third.id]);
  });

  it("keeps known identity fields when a read misses some, and ignores removed accounts", async () => {
    const root = await makeRoot();
    const registry = new AccountRegistry(root);
    await registry.load();
    const other = await registry.create();
    // 昵称回写和新建可能同时发生，两边都要落盘
    await Promise.all([
      registry.updateIdentity("default", { uid: "111", nickname: "甲", avatar: "https://p3.douyinpic.com/a.jpeg" }),
      registry.create(),
    ]);
    await registry.updateIdentity("default", { uid: null, nickname: "甲改", avatar: null });
    const saved = await readRegistry(root);
    expect(saved.accounts).toHaveLength(3);
    expect(saved.accounts[0]).toMatchObject({ id: "default", uid: "111", nickname: "甲改", avatar: "https://p3.douyinpic.com/a.jpeg" });
    await registry.remove(other.id);
    await expect(registry.updateIdentity(other.id, { nickname: "乙" })).resolves.toBeNull();
  });

  it("keeps a broken list aside and rebuilds it from the account directories", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "records.json"), "{}");
    await mkdir(path.join(root, "accounts", "aaaaaaaaaaaa"), { recursive: true });
    await mkdir(path.join(root, "accounts", "not-an-account"), { recursive: true });
    await writeFile(path.join(root, "accounts.json"), "{ broken");
    const registry = new AccountRegistry(root);
    const listed = await registry.load();
    expect(await readFile(path.join(root, "accounts.json.broken"), "utf8")).toBe("{ broken");
    expect(listed).toMatchObject({ activeId: "default", accounts: [{ id: "default" }, { id: "aaaaaaaaaaaa" }] });
    expect(listed.accounts).toHaveLength(2);
  });

  it("finds existing account directories again when the list file is missing", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "records.json"), "{}");
    await mkdir(path.join(root, "accounts", "aaaaaaaaaaaa"), { recursive: true });
    const listed = await new AccountRegistry(root).load();
    expect(listed).toMatchObject({ activeId: "default", accounts: [{ id: "default" }, { id: "aaaaaaaaaaaa" }] });
    expect(listed.accounts).toHaveLength(2);
    expect(await exists(path.join(root, "accounts.json.broken"))).toBe(false);

    // default 早就删了：根目录没有数据，只认回子账号并设成当前
    const bare = await makeRoot();
    await mkdir(path.join(bare, "accounts", "cccccccccccc"), { recursive: true });
    expect(await new AccountRegistry(bare).load()).toMatchObject({ activeId: "cccccccccccc", accounts: [{ id: "cccccccccccc" }] });
    expect((await readRegistry(bare)).accounts).toHaveLength(1);
  });

  it("treats a list pointing outside its own directories as broken", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "accounts", "bbbbbbbbbbbb"), { recursive: true });
    await writeFile(path.join(root, "accounts.json"), JSON.stringify({
      schemaVersion: 1,
      activeId: "bbbbbbbbbbbb",
      accounts: [{ id: "bbbbbbbbbbbb", dir: "../../elsewhere", createdAt: "2026-10-01T00:00:00.000Z" }],
    }));
    const registry = new AccountRegistry(root);
    const listed = await registry.load();
    // 根目录没有账号数据，default 不出现
    expect(listed).toMatchObject({ activeId: "bbbbbbbbbbbb", accounts: [{ id: "bbbbbbbbbbbb" }] });
    expect(listed.accounts).toHaveLength(1);
    expect(await exists(path.join(root, "accounts.json.broken"))).toBe(true);
    expect(registry.directory(registry.active())).toBe(path.join(root, "accounts", "bbbbbbbbbbbb"));
  });

  it("only accepts default or a 12-digit lowercase hex id", () => {
    expect(isAccountId("default")).toBe(true);
    expect(isAccountId("0123456789ab")).toBe(true);
    for (const value of ["../x", "0123456789AB", "0123456789abc", "", null, "default/..", "accounts/0123456789ab"]) {
      expect(isAccountId(value)).toBe(false);
    }
  });
});
