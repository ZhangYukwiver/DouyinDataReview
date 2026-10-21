import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sealHistory } from "./chat.mjs";
import { renameRetrying } from "./rename.mjs";

// AI 剪辑的会话：一个会话对应一个剪辑工程。页面看到的是 messages（对话气泡），
// 发给模型的原始消息历史另存在 history 里，不发给页面。每个会话一个文件 ai-edit/sessions/<id>.json。

const SESSION_ID = /^[0-9a-f]{32}$/u;
const INTERRUPTED = { code: "interrupted", message: "上次 AI 还在处理时采集器关掉了，这一轮没做完，可以接着说。" };

export const isSessionId = (value) => typeof value === "string" && SESSION_ID.test(value);

export function sessionSummary(session) {
  const { id, title, createdAt, updatedAt, status, projectId, draftBox } = session;
  return { id, title, createdAt, updatedAt, status, projectId, draftBox: draftBox ? { ...draftBox } : null };
}

export function sessionDetail(session) {
  return {
    ...sessionSummary(session),
    goal: session.goal,
    revision: session.revision,
    error: session.error ? { ...session.error } : null,
    messages: session.messages.map((item) => ({ ...item, ...(item.actions ? { actions: item.actions.map((action) => ({ ...action })) } : {}) })),
    streaming: session.streaming ? {
      text: session.streaming.text,
      actions: session.streaming.actions.map((action) => ({ ...action })),
      // 要页面在浏览器里帮忙拆视频（截图、节拍）时挂在这里，页面做完交回
      ...(session.streaming.look ? { look: { ...session.streaming.look } } : {}),
    } : null,
  };
}

export class SessionStore {
  constructor({ directory, now = () => new Date(), newId = () => randomBytes(16).toString("hex") }) {
    this.directory = directory;
    this.now = now;
    this.newId = newId;
    this.sessions = new Map();
    this.waiters = new Map();
    this.writes = new Map();
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSessionId(id)) continue;
      let session;
      try { session = JSON.parse(await readFile(path.join(this.directory, name), "utf8")); } catch { continue; }
      if (session?.id !== id || typeof session.projectId !== "string") continue;
      session.messages = Array.isArray(session.messages) ? session.messages : [];
      session.history = Array.isArray(session.history) ? session.history.filter((entry) => entry && typeof entry === "object") : [];
      session.revision = Number.isSafeInteger(session.revision) ? session.revision : 1;
      // 加目标之前存的会话没有这个字段
      session.goal = typeof session.goal === "string" ? session.goal : "";
      // arrange_grid 排过的格子（片段 id → 位置），换画布时重排用
      session.grids = session.grids && typeof session.grids === "object" && !Array.isArray(session.grids) ? session.grids : {};
      session.streaming = null;
      this.sessions.set(id, session);
      // 一轮进行中也会存盘（比如导入剪映后），那时 history 里可能有还没回结果的工具调用；
      // 采集器被强杀后不补齐，下一轮接口会因为调用和结果对不上一直报 400
      const length = session.history.length;
      sealHistory(session.history, "采集器关掉了，这个工具没有执行。");
      if (session.status === "running") {
        Object.assign(session, { status: "failed", error: { ...INTERRUPTED } });
        this.touch(session);
        await this.save(session);
      } else if (session.history.length !== length) {
        await this.save(session);
      }
    }
  }

  list() {
    return [...this.sessions.values()]
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map(sessionSummary);
  }

  get(id) { return isSessionId(id) ? this.sessions.get(id) ?? null : null; }

  async create({ title, projectId }) {
    const now = this.now().toISOString();
    const session = {
      id: this.newId(),
      title,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      projectId,
      draftBox: null,
      goal: "",
      grids: {},
      revision: 1,
      error: null,
      messages: [],
      history: [],
      streaming: null,
    };
    this.sessions.set(session.id, session);
    await this.save(session);
    return session;
  }

  /**
   * 会话有变化：revision +1，挂着的长轮询立刻返回。persist 时顺带存盘（流式文字只改内存）；
   * quiet 只叫醒页面、不算一次更新（比如素材库变了），不改 updatedAt，免得“最近的剪辑”乱跳。
   */
  touch(session, { persist = false, quiet = false } = {}) {
    session.revision += 1;
    if (!quiet) session.updatedAt = this.now().toISOString();
    for (const finish of [...(this.waiters.get(session.id) ?? [])]) finish();
    return persist ? this.save(session) : Promise.resolve();
  }

  save(session) {
    const { streaming: _streaming, ...stored } = session;
    const data = JSON.stringify(stored);
    const file = path.join(this.directory, `${session.id}.json`);
    // 同一个会话的写入排队，后写的覆盖先写的
    const previous = this.writes.get(session.id) ?? Promise.resolve();
    const write = previous.then(async () => {
      if (!this.sessions.has(session.id)) return;
      await writeFile(`${file}.tmp`, data, { mode: 0o600 });
      await renameRetrying(`${file}.tmp`, file);
    }).catch((error) => console.error("AI 剪辑会话保存失败:", error));
    this.writes.set(session.id, write);
    return write;
  }

  async remove(id) {
    const session = this.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await this.writes.get(id);
    this.writes.delete(id);
    await rm(path.join(this.directory, `${id}.json`), { force: true });
    await rm(path.join(this.directory, `${id}.json.tmp`), { force: true });
    for (const finish of [...(this.waiters.get(id) ?? [])]) finish();
    return true;
  }

  /** 长轮询：revision 和 afterRevision 不同就立刻返回，否则最多等 timeoutMs；signal 断开时清理。 */
  wait(id, afterRevision, { timeoutMs = 8_000, signal } = {}) {
    const session = this.get(id);
    if (!session || session.revision !== afterRevision || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      let timer;
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        if (!set.size && this.waiters.get(id) === set) this.waiters.delete(id);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      set.add(finish);
      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** 关服务时让所有长轮询立刻返回。 */
  wakeAll() {
    for (const set of [...this.waiters.values()]) for (const finish of [...set]) finish();
  }

  async flush() {
    await Promise.all([...this.writes.values()]);
  }
}
