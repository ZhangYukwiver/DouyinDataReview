import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const ACCOUNT_ID_PATTERN = /^(default|[0-9a-f]{12})$/u;
const NESTED_ID_PATTERN = /^[0-9a-f]{12}$/u;

export function isPlatformAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

function accountDirectory(id) {
  return id === "default" ? "" : `accounts/${id}`;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountError(code, message, status = 404) {
  return Object.assign(new Error(message), { code, status });
}

function newAccount(id, createdAt = new Date().toISOString()) {
  return {
    id,
    dir: accountDirectory(id),
    platform: null,
    nickname: null,
    avatar: null,
    uid: null,
    note: null,
    loggedIn: false,
    lastSyncedAt: null,
    createdAt,
  };
}

function normalizeAccount(value) {
  if (!isPlatformAccountId(value?.id) || value.dir !== accountDirectory(value.id)) return null;
  return {
    ...newAccount(value.id, optionalText(value.createdAt) ?? new Date().toISOString()),
    platform: optionalText(value.platform),
    nickname: optionalText(value.nickname),
    avatar: optionalText(value.avatar),
    uid: optionalText(value.uid),
    note: optionalText(value.note),
    loggedIn: value.loggedIn === true,
    lastSyncedAt: optionalText(value.lastSyncedAt),
  };
}

function parseRegistry(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.accounts)) return null;
  const accounts = value.accounts.map(normalizeAccount);
  if (accounts.some((item) => !item) || new Set(accounts.map((item) => item.id)).size !== accounts.length) return null;
  if (!isPlatformAccountId(value.activeId) || !accounts.some((item) => item.id === value.activeId)) return null;
  return { schemaVersion: SCHEMA_VERSION, activeId: value.activeId, accounts };
}

/**
 * A platform-local account registry. The default account keeps the historical
 * files at the platform root so existing installations remain readable. New
 * accounts live below accounts/<id> and never share a browser profile.
 */
export class PlatformAccountRegistry {
  constructor(root, platform) {
    this.root = root;
    this.platform = platform;
    this.filePath = path.join(root, "accounts.json");
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let parsed = null;
    try {
      parsed = parseRegistry(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      // A missing or malformed registry is rebuilt from the platform directory.
    }
    if (!parsed) {
      const existing = await readFile(path.join(this.root, "account.json"), "utf8").then(text => JSON.parse(text)).catch(() => null);
      const nested = (await readdir(path.join(this.root, "accounts"), { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory() && NESTED_ID_PATTERN.test(entry.name));
      const accounts = [];
      if (existing?.user_id || nested.length === 0) {
        const identity = existing && typeof existing === "object" ? existing : {};
        const account = newAccount("default", await this.createdAt(this.root));
        account.platform = this.platform;
        account.uid = optionalText(identity.user_id);
        account.nickname = optionalText(identity.nickname);
        account.avatar = optionalText(identity.avatar);
        account.loggedIn = Boolean(account.uid && await this.hasProfile(this.root));
        account.lastSyncedAt = optionalText(identity.checked_at);
        accounts.push(account);
      }
      for (const entry of nested) {
        const account = newAccount(entry.name, await this.createdAt(path.join(this.root, "accounts", entry.name)));
        account.platform = this.platform;
        const identity = await readFile(path.join(this.root, "accounts", entry.name, "account.json"), "utf8")
          .then(text => JSON.parse(text)).catch(() => null);
        account.uid = optionalText(identity?.user_id);
        account.nickname = optionalText(identity?.nickname);
        account.avatar = optionalText(identity?.avatar);
        account.loggedIn = Boolean(account.uid && await this.hasProfile(path.join(this.root, "accounts", entry.name)));
        account.lastSyncedAt = optionalText(identity?.checked_at);
        accounts.push(account);
      }
      if (!accounts.length) {
        const account = newAccount("default");
        account.platform = this.platform;
        accounts.push(account);
      }
      accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      parsed = { schemaVersion: SCHEMA_VERSION, activeId: accounts[0].id, accounts };
      if (await readFile(this.filePath, "utf8").catch(() => null) !== null) {
        await rename(this.filePath, `${this.filePath}.broken`).catch(() => undefined);
      }
      await this.commit(parsed);
    } else {
      parsed.accounts = parsed.accounts.map(item => ({ ...item, platform: item.platform ?? this.platform }));
      this.data = parsed;
      // Keep metadata added by newer versions without making a migration mandatory.
      if (parsed.accounts.some(item => item.platform !== this.platform)) {
        parsed.accounts = parsed.accounts.map(item => ({ ...item, platform: this.platform }));
        await this.commit(parsed);
      }
    }
    return this.list();
  }

  async createdAt(directory) {
    const info = await stat(directory).catch(() => null);
    return new Date(info ? (info.birthtimeMs || info.mtimeMs) : Date.now()).toISOString();
  }

  async hasProfile(directory) {
    return stat(path.join(directory, "browser-profile")).then(() => true, () => false);
  }

  async commit(next) {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    this.data = next;
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get activeId() {
    return this.data?.activeId ?? "default";
  }

  get(id) {
    if (!isPlatformAccountId(id)) return null;
    const account = this.data?.accounts.find(item => item.id === id);
    return account ? { ...account } : null;
  }

  active() {
    return this.get(this.activeId);
  }

  directory(accountOrId) {
    const id = typeof accountOrId === "string" ? accountOrId : accountOrId?.id;
    if (!isPlatformAccountId(id)) throw accountError("account_not_found", "没有这个平台账号。");
    return path.join(this.root, accountDirectory(id));
  }

  list() {
    return {
      platform: this.platform,
      activeId: this.activeId,
      accounts: [...(this.data?.accounts ?? [])]
        .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
        .map(({ id, platform, nickname, avatar, uid, note, loggedIn, lastSyncedAt, createdAt }) => ({
          id, platform: platform ?? this.platform, nickname, avatar, uid, note, loggedIn, lastSyncedAt, createdAt,
        })),
    };
  }

  async ensureLoaded() {
    if (!this.data) await this.load();
    return this.data;
  }

  create() {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      let id;
      do id = randomBytes(6).toString("hex"); while (this.get(id));
      const latest = Math.max(0, ...this.data.accounts.map(item => Date.parse(item.createdAt ?? "") || 0));
      const account = newAccount(id, new Date(Math.max(Date.now(), latest + 1)).toISOString());
      account.platform = this.platform;
      await mkdir(this.directory(account), { recursive: true, mode: 0o700 });
      await this.commit({ ...this.data, accounts: [...this.data.accounts, account] });
      return { ...account };
    });
  }

  setActive(id) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.get(id)) throw accountError("account_not_found", "没有这个平台账号。");
      if (id !== this.data.activeId) await this.commit({ ...this.data, activeId: id });
      return this.active();
    });
  }

  remove(id) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const account = this.get(id);
      if (!account) throw accountError("account_not_found", "没有这个平台账号。");
      if (id === this.data.activeId) throw accountError("account_active", "正在使用的平台账号不能删除，请先切换账号。", 409);
      if (id === "default") {
        // The historical default account owns the platform root. Preserve the
        // registry and nested accounts while removing only its local data.
        const entries = await readdir(this.root).catch(() => []);
        for (const name of entries) {
          if (name === "accounts" || name === "accounts.json") continue;
          await rm(path.join(this.root, name), { recursive: true, force: true });
        }
      } else {
        await rm(this.directory(account), { recursive: true, force: true });
      }
      await this.commit({ ...this.data, accounts: this.data.accounts.filter(item => item.id !== id) });
      return this.list();
    });
  }

  update(id, patch) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const current = this.get(id);
      if (!current) throw accountError("account_not_found", "没有这个平台账号。");
      const next = {
        ...current,
        ...(patch && Object.hasOwn(patch, "nickname") ? { nickname: optionalText(patch.nickname) } : {}),
        ...(patch && Object.hasOwn(patch, "avatar") ? { avatar: optionalText(patch.avatar) } : {}),
        ...(patch && Object.hasOwn(patch, "uid") ? { uid: optionalText(patch.uid) } : {}),
        ...(patch && Object.hasOwn(patch, "note") ? { note: optionalText(patch.note) } : {}),
        ...(patch && Object.hasOwn(patch, "loggedIn") ? { loggedIn: patch.loggedIn === true } : {}),
        ...(patch && Object.hasOwn(patch, "lastSyncedAt") ? { lastSyncedAt: optionalText(patch.lastSyncedAt) } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await this.commit({ ...this.data, accounts: this.data.accounts.map(item => item.id === id ? next : item) });
      }
      return this.get(id);
    });
  }
}

