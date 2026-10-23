import { copyFile, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const LIST_NAMES = ["watch_history", "liked_videos", "favorite_videos"];
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/u;
const MAX_NAME_CHARACTERS = 40;
const MAX_FOLDERS = 200;
const MAX_ITEMS = 200_000;
const MAX_KEY_LENGTH = 300;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeList(value) {
  const list = isPlainObject(value) ? value : {};
  const folders = [];
  const ids = new Set();
  for (const folder of Array.isArray(list.folders) ? list.folders : []) {
    if (folders.length >= MAX_FOLDERS) break;
    const id = folder?.id;
    if (typeof id !== "string" || !FOLDER_ID_PATTERN.test(id) || ids.has(id)) continue;
    const name = typeof folder.name === "string" ? folder.name.trim() : "";
    // 按字符数算，一个 emoji 算一个
    const length = Array.from(name).length;
    if (length < 1 || length > MAX_NAME_CHARACTERS) continue;
    ids.add(id);
    folders.push({ id, name });
  }
  const items = [];
  for (const [key, folderId] of isPlainObject(list.items) ? Object.entries(list.items) : []) {
    if (items.length >= MAX_ITEMS) break;
    // 指向已删文件夹的条目丢掉，不然视频会挂在一个看不见的文件夹里
    if (key.length < 1 || key.length > MAX_KEY_LENGTH || !ids.has(folderId)) continue;
    items.push([key, folderId]);
  }
  // fromEntries 才能原样留下 "__proto__" 这种键，直接赋值会被吞掉
  return { folders, items: Object.fromEntries(items) };
}

// 请求体和磁盘上的文件都不可信：只留三个栏目，名字、id、条目逐个过一遍
export function sanitizeRecordFolders(value) {
  const lists = isPlainObject(value?.lists) ? value.lists : {};
  return { lists: Object.fromEntries(LIST_NAMES.map((name) => [name, sanitizeList(lists[name])])) };
}

export class RecordFolderStore {
  constructor(directory) {
    this.filePath = path.join(directory, "folders.json");
    this.cached = null;
    // 读和写走同一条队列：读到一半来了写，旧内容不会回头盖掉缓存
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load() {
    let text;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return sanitizeRecordFolders(null);
      throw error;
    }
    try {
      return sanitizeRecordFolders(JSON.parse(text));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 半截文件先留底再当空的用；留不了底就报错，免得下次存盘把它盖掉
      const broken = `${this.filePath}.broken-${Date.now()}`;
      await rename(this.filePath, broken).catch(() => copyFile(this.filePath, broken)).catch(() => { throw error; });
      return sanitizeRecordFolders(null);
    }
  }

  // 只在队列里调用
  async ensureLoaded() {
    this.cached ??= await this.load();
    return this.cached;
  }

  async read() {
    return this.cached ?? this.enqueue(() => this.ensureLoaded());
  }

  write(value) {
    const { lists } = sanitizeRecordFolders(value);
    return this.enqueue(async () => {
      // 没读过就先读一次：坏文件得先留了底，不能直接被这次写盖掉
      await this.ensureLoaded();
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      const file = await open(temporaryPath, "w", 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), lists })}\n`);
        // 先落盘再改名，断电也不会留下改名成功、内容却是半截的文件
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      this.cached = { lists };
      return this.cached;
    });
  }
}
