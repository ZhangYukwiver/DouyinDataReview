import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const ACCOUNT_ID_PATTERN = /^(default|[0-9a-f]{12})$/u;
const NESTED_ID_PATTERN = /^[0-9a-f]{12}$/u;
// 根目录本身就是 default 账号；删它时只动这几样，direct-signer、backups 这些是全局共用的
const ROOT_ACCOUNT_ENTRIES = ["browser-profile", "records.json", "direct-history-template.json", "downloads"];
const RECORDS_TEMPORARY_PATTERN = /^records\.json\..+\.tmp$/u;

export function isAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

// 目录只按 id 推出来，绝不信文件里或请求里给的路径
function accountDirectory(id) {
  return id === "default" ? "" : `accounts/${id}`;
}

function accountError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function optionalText(value) {
  return typeof value === "string" && value ? value : null;
}

function parseRegistry(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.accounts)) return null;
  const accounts = [];
  for (const item of value.accounts) {
    if (!isAccountId(item?.id) || item.dir !== accountDirectory(item.id) || accounts.some((account) => account.id === item.id)) return null;
    accounts.push({
      id: item.id,
      dir: item.dir,
      nickname: optionalText(item.nickname),
      avatar: optionalText(item.avatar),
      uid: optionalText(item.uid),
      createdAt: optionalText(item.createdAt),
    });
  }
  if (!accounts.some((account) => account.id === value.activeId)) return null;
  return { schemaVersion: SCHEMA_VERSION, activeId: value.activeId, accounts };
}

function newAccount(id, createdAt = new Date().toISOString()) {
  return { id, dir: accountDirectory(id), nickname: null, avatar: null, uid: null, createdAt };
}

async function createdAtOf(directory) {
  const info = await stat(directory).catch(() => null);
  const time = info ? info.birthtimeMs || info.mtimeMs : Date.now();
  return new Date(time).toISOString();
}

export class AccountRegistry {
  constructor(root) {
    this.root = root;
    this.filePath = path.join(root, "accounts.json");
    this.data = null;
    // 写操作排队：识别到的昵称头像随时会回写，可能和增删撞在一起
    this.queue = Promise.resolve();
  }

  async load() {
    let text = null;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") text = "";
    }
    // 没有名单也按目录重建：名单被误删时 accounts/ 下已有的账号不能变成孤儿；全新安装重建出来只有 default
    if (text === null) {
      await this.commit(await this.rebuild());
      return this.list();
    }
    let parsed = null;
    try {
      parsed = parseRegistry(JSON.parse(text));
    } catch {
      // 按损坏处理
    }
    if (parsed) {
      this.data = parsed;
      return this.list();
    }
    // 坏文件留底，再按磁盘上的目录重建；昵称头像丢了没关系，下次登录会重新识别
    await rename(this.filePath, `${this.filePath}.broken`).catch(() => undefined);
    await this.commit(await this.rebuild());
    return this.list();
  }

  async rebuild() {
    const nested = await readdir(path.join(this.root, "accounts"), { withFileTypes: true }).catch(() => []);
    const accounts = [];
    for (const entry of nested) {
      if (!entry.isDirectory() || !NESTED_ID_PATTERN.test(entry.name)) continue;
      accounts.push(newAccount(entry.name, await createdAtOf(path.join(this.root, "accounts", entry.name))));
    }
    accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const rootEntries = await readdir(this.root).catch(() => []);
    if (accounts.length === 0 || rootEntries.some((name) => ROOT_ACCOUNT_ENTRIES.includes(name) || RECORDS_TEMPORARY_PATTERN.test(name))) {
      // default 一定是最早的那个，排序编号才和原来一致
      const rootCreatedAt = await createdAtOf(this.root);
      const createdAt = accounts[0] && accounts[0].createdAt <= rootCreatedAt
        ? new Date(Date.parse(accounts[0].createdAt) - 1).toISOString()
        : rootCreatedAt;
      accounts.unshift(newAccount("default", createdAt));
    }
    return { schemaVersion: SCHEMA_VERSION, activeId: accounts[0].id, accounts };
  }

  async commit(next) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    this.data = next;
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get activeId() {
    return this.data.activeId;
  }

  list() {
    return {
      activeId: this.data.activeId,
      accounts: [...this.data.accounts]
        .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
        .map(({ id, nickname, avatar, uid, createdAt }) => ({ id, nickname, avatar, uid, createdAt })),
    };
  }

  get(id) {
    if (!isAccountId(id)) return null;
    const account = this.data.accounts.find((item) => item.id === id);
    return account ? { ...account } : null;
  }

  active() {
    return this.get(this.data.activeId);
  }

  directory(account) {
    return path.join(this.root, accountDirectory(account.id));
  }

  create() {
    return this.enqueue(async () => {
      let id;
      do id = randomBytes(6).toString("hex");
      while (this.data.accounts.some((account) => account.id === id));
      // 默认账号的时间取自文件夹的创建时间，和程序时钟不是一个来源（Windows 上能差几毫秒）；
      // 新账号一律排在已有账号之后，「按创建先后」才不会乱
      const latest = Math.max(0, ...this.data.accounts.map((account) => Date.parse(account.createdAt ?? "") || 0));
      const account = newAccount(id, new Date(Math.max(Date.now(), latest + 1)).toISOString());
      await mkdir(this.directory(account), { recursive: true, mode: 0o700 });
      await this.commit({ ...this.data, accounts: [...this.data.accounts, account] });
      return { ...account };
    });
  }

  setActive(id) {
    return this.enqueue(async () => {
      if (!this.get(id)) throw accountError("account_not_found", "没有这个账号。", 404);
      if (this.data.activeId !== id) await this.commit({ ...this.data, activeId: id });
    });
  }

  remove(id) {
    return this.enqueue(async () => {
      const account = this.get(id);
      if (!account) throw accountError("account_not_found", "没有这个账号。", 404);
      if (this.data.activeId === id) throw accountError("account_active", "正在用的账号不能删除，先切换到别的账号。", 409);
      // 先删文件再改列表：删到一半失败时账号还在列表里，可以再删一次
      if (account.dir) {
        await rm(this.directory(account), { recursive: true, force: true });
      } else {
        const temporary = (await readdir(this.root).catch(() => [])).filter((name) => RECORDS_TEMPORARY_PATTERN.test(name));
        for (const name of [...ROOT_ACCOUNT_ENTRIES, ...temporary]) {
          await rm(path.join(this.root, name), { recursive: true, force: true });
        }
      }
      await this.commit({ ...this.data, accounts: this.data.accounts.filter((item) => item.id !== id) });
    });
  }

  // 读不到的字段沿用旧值；账号已经删了就什么都不做
  updateIdentity(id, identity) {
    return this.enqueue(async () => {
      const account = this.get(id);
      if (!account) return null;
      const next = {
        ...account,
        nickname: optionalText(identity?.nickname) ?? account.nickname,
        avatar: optionalText(identity?.avatar) ?? account.avatar,
        uid: optionalText(identity?.uid) ?? account.uid,
      };
      if (next.nickname !== account.nickname || next.avatar !== account.avatar || next.uid !== account.uid) {
        await this.commit({ ...this.data, accounts: this.data.accounts.map((item) => item.id === id ? next : item) });
      }
      return next;
    });
  }
}
