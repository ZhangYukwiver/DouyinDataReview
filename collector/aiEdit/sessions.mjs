import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { sealHistory } from "./chat.mjs";
import { renameRetrying } from "./rename.mjs";

// AI 剪辑的会话：一个会话对应一个剪辑工程。页面看到的是 messages（对话气泡），
// 发给模型的原始消息历史另存在 history 里，不发给页面。每个会话一个文件 ai-edit/sessions/<id>.json。
// 撤销、退回用的工程存档每份一个文件，放在 ai-edit/checkpoints/<会话 id>/ 下；重做用的快照也放在这里，id 是同一种。
// 对话里贴的图（页面生成的小预览）放在 ai-edit/attachments/<会话 id>/ 下，会话删了一起删。

const SESSION_ID = /^[0-9a-f]{32}$/u;
const CHECKPOINT_ID = /^[0-9a-f]{16}$/u;
const ATTACHMENT_ID = /^[0-9a-f]{16}$/u;
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// 存档（撤销、退回用）最多留这么多份，再多删最旧的；重做栈也最多这么多
export const MAX_CHECKPOINTS = 50;
const INTERRUPTED = { code: "interrupted", message: "上次 AI 还在处理时采集器关掉了，这一轮没做完，可以接着说。" };

export const isSessionId = (value) => typeof value === "string" && SESSION_ID.test(value);

export function sessionSummary(session) {
  const { id, title, createdAt, updatedAt, status, projectId, draftBox } = session;
  return { id, title, createdAt, updatedAt, status, projectId, draftBox: draftBox ? { ...draftBox } : null };
}

/**
 * 退回到第 i 句之前用哪份存档：这句话发出之后（或正好是这一轮开跑前）存的第一份。
 * 同一下标上的手动改动存档是这句话发出前、那次手动改动之前的样子，不算；
 * 更早的存档删掉过（i <= checkpointsTrimmedAt）就找不准了。
 */
export const revertTarget = (session, i) => (i >= 0 && i > (session.checkpointsTrimmedAt ?? -1)
  ? (session.checkpoints ?? []).find((item) => item.messageIndex > i || (item.messageIndex === i && item.kind === "turn")) ?? null
  : null);

export function sessionDetail(session) {
  const checkpoints = session.checkpoints ?? [];
  return {
    ...sessionSummary(session),
    goal: session.goal,
    // 历史太长、更早的对话 AI 已经记不全了
    trimmed: Boolean(session.trimmed),
    revision: session.revision,
    error: session.error ? { ...session.error } : null,
    messages: session.messages.map((item) => ({
      ...item,
      ...(item.actions ? { actions: item.actions.map((action) => ({ ...action })) } : {}),
      ...(item.region ? { region: structuredClone(item.region) } : {}),
      ...(item.refs ? { refs: item.refs.map((ref) => ({ ...ref })) } : {}),
      ...(item.attachments ? { attachments: item.attachments.map((attachment) => ({ ...attachment })) } : {}),
    })),
    undo: checkpoints.length ? { label: checkpoints.at(-1).label, kind: checkpoints.at(-1).kind } : null,
    redo: session.redo?.length ? { label: session.redo.at(-1).label } : null,
    // 操作历史：新的在前，点哪一步就撤到那一步之前
    history: checkpoints.slice(-MAX_CHECKPOINTS).reverse().map(({ id, kind, label, at }) => ({ id, kind, label, at })),
    revertible: session.messages.flatMap((item, index) => (item.role === "user" && revertTarget(session, index) ? [item.id] : [])),
    streaming: session.streaming ? {
      text: session.streaming.text,
      actions: session.streaming.actions.map((action) => ({ ...action })),
      // 要页面在浏览器里帮忙拆视频（截图、节拍）时挂在这里，页面做完交回
      ...(session.streaming.look ? { look: { ...session.streaming.look } } : {}),
    } : null,
  };
}

export class SessionStore {
  constructor({
    directory, checkpointDirectory = path.join(path.dirname(directory), "checkpoints"), attachmentDirectory = path.join(path.dirname(directory), "attachments"),
    now = () => new Date(), newId = () => randomBytes(16).toString("hex"),
  }) {
    this.directory = directory;
    this.checkpointDirectory = checkpointDirectory;
    this.attachmentDirectory = attachmentDirectory;
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
      // 加「历史被裁过」之前存的会话没有这个字段
      session.trimmed = session.trimmed === true;
      // arrange_grid 排过的格子（片段 id → 位置），换画布时重排用
      session.grids = session.grids && typeof session.grids === "object" && !Array.isArray(session.grids) ? session.grids : {};
      // 加撤销、退回和看板手动改之前存的会话没有这几个字段
      const checkpoints = Array.isArray(session.checkpoints)
        ? session.checkpoints.filter((item) => typeof item?.id === "string" && CHECKPOINT_ID.test(item.id) && Number.isSafeInteger(item.messageIndex))
        : [];
      session.checkpointsTrimmedAt = Number.isSafeInteger(session.checkpointsTrimmedAt) ? session.checkpointsTrimmedAt : -1;
      // 删了存档文件、还没存会话文件时采集器被强杀，会留下没有文件的条目，丢掉。排在最后的是撤销或一轮收尾时删的，
      // 丢掉就是把那次删除做完；后面还有存档的是超出上限删的，按删掉过记，免得退回落到更晚的存档上
      session.checkpoints = [];
      let pruned = false;
      for (const item of checkpoints.reverse()) {
        if (await stat(this.#checkpointFile(session, item.id)).then(() => true, () => false)) {
          session.checkpoints.unshift(item);
          continue;
        }
        pruned = true;
        if (session.checkpoints.length) session.checkpointsTrimmedAt = Math.max(session.checkpointsTrimmedAt, item.messageIndex);
      }
      // 加重做之前存的会话没有重做栈；文件没了的条目同样丢掉
      const redo = Array.isArray(session.redo)
        ? session.redo.filter((item) => typeof item?.id === "string" && CHECKPOINT_ID.test(item.id) && Number.isSafeInteger(item.messageIndex) && typeof item.label === "string")
        : [];
      session.redo = [];
      for (const item of redo) {
        if (await stat(this.#checkpointFile(session, item.id)).then(() => true, () => false)) session.redo.push(item);
        else pruned = true;
      }
      session.pendingNotes = Array.isArray(session.pendingNotes) ? session.pendingNotes.filter((note) => typeof note === "string") : [];
      session.streaming = null;
      this.sessions.set(id, session);
      // 一轮进行中也会存盘（比如导入剪映后），那时 history 里可能有还没回结果的工具调用；
      // 采集器被强杀后不补齐，下一轮接口会因为调用和结果对不上一直报 400
      const length = session.history.length;
      sealHistory(session.history, "采集器关掉了，这个工具没有执行。");
      if (session.status === "running") {
        Object.assign(session, { status: "failed", error: { ...INTERRUPTED } });
        // 这一轮可能已经改过工程，和一轮收尾一样按改了算，撤掉的不能再重做
        await this.clearRedo(session);
        this.touch(session);
        await this.save(session);
      } else if (session.history.length !== length || pruned) {
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
      trimmed: false,
      grids: {},
      checkpoints: [],
      checkpointsTrimmedAt: -1,
      redo: [],
      pendingNotes: [],
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
    await rm(path.join(this.checkpointDirectory, id), { recursive: true, force: true });
    await rm(path.join(this.attachmentDirectory, id), { recursive: true, force: true });
    for (const finish of [...(this.waiters.get(id) ?? [])]) finish();
    return true;
  }

  #checkpointFile(session, checkpointId) {
    if (!CHECKPOINT_ID.test(checkpointId)) throw new Error("bad checkpoint id");
    return path.join(this.checkpointDirectory, session.id, `${checkpointId}.json`);
  }

  /**
   * 存一份整个工程的样子 snapshot（{ project: { name, canvas, tracks, markers }, grids }），记在 session.checkpoints 最后。
   * 不存会话文件，调用方改完再 touch。超过上限删最旧的，记下删到了第几句，再往前就退不回去了。
   */
  async addCheckpoint(session, { kind, label, snapshot, messageIndex = session.messages.length }) {
    const entry = { id: randomBytes(8).toString("hex"), kind, messageIndex, label, at: this.now().toISOString() };
    const file = this.#checkpointFile(session, entry.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
    await renameRetrying(`${file}.tmp`, file);
    session.checkpoints.push(entry);
    while (session.checkpoints.length > MAX_CHECKPOINTS) {
      const oldest = session.checkpoints.shift();
      session.checkpointsTrimmedAt = oldest.messageIndex;
      await rm(this.#checkpointFile(session, oldest.id), { force: true });
    }
    return entry;
  }

  async readCheckpoint(session, checkpointId) {
    return JSON.parse(await readFile(this.#checkpointFile(session, checkpointId), "utf8"));
  }

  async dropCheckpoint(session, checkpointId) {
    session.checkpoints = session.checkpoints.filter((item) => item.id !== checkpointId);
    await rm(this.#checkpointFile(session, checkpointId), { force: true });
  }

  /**
   * 撤销时把撤掉那一步做完以后的样子 snapshot 推进重做栈，kind、label、messageIndex 是被撤的那份存档的。
   * 读文件还是用 readCheckpoint。超过上限删最早推进去的（离现在最远的那步）。
   */
  async addRedo(session, { kind, label, messageIndex, snapshot }) {
    const id = randomBytes(8).toString("hex");
    const file = this.#checkpointFile(session, id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
    await renameRetrying(`${file}.tmp`, file);
    return this.#pushRedo(session, { id, kind, label, messageIndex });
  }

  /** 一次撤好几步时，前面那步做完的样子就是后一步之前存的那份存档：文件不动，条目从存档挪进重做栈，记上前面那步的说法。 */
  checkpointToRedo(session, checkpointId, { kind, label, messageIndex }) {
    session.checkpoints = session.checkpoints.filter((item) => item.id !== checkpointId);
    return this.#pushRedo(session, { id: checkpointId, kind, label, messageIndex });
  }

  async #pushRedo(session, { id, kind, label, messageIndex }) {
    const entry = { id, kind, label, messageIndex, at: this.now().toISOString() };
    session.redo.push(entry);
    while (session.redo.length > MAX_CHECKPOINTS) await rm(this.#checkpointFile(session, session.redo.shift().id), { force: true });
    return entry;
  }

  async dropRedo(session, redoId) {
    session.redo = session.redo.filter((item) => item.id !== redoId);
    await rm(this.#checkpointFile(session, redoId), { force: true });
  }

  /** 手动改了、换了比例、退回了或者 AI 改了工程：撤销掉的就不能再重做了，连文件删。 */
  async clearRedo(session) {
    const dropped = session.redo;
    session.redo = [];
    for (const item of dropped) await rm(this.#checkpointFile(session, item.id), { force: true });
  }

  #attachmentFile(session, attachmentId, mime) {
    const extension = IMAGE_EXTENSIONS[mime];
    if (!ATTACHMENT_ID.test(attachmentId) || !extension) throw new Error("bad attachment");
    return path.join(this.attachmentDirectory, session.id, `${attachmentId}.${extension}`);
  }

  /** 存一张对话里贴的图（mime 是 image/jpeg、png 或 webp），回它的 id。 */
  async saveAttachment(session, { mime, bytes }) {
    const id = randomBytes(8).toString("hex");
    const file = this.#attachmentFile(session, id, mime);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, bytes, { mode: 0o600 });
    await renameRetrying(`${file}.tmp`, file);
    return id;
  }

  /** 读回一张贴的图给模型看（data URL）；文件没了或记录不对回 null。 */
  async readAttachment(session, { id, mime }) {
    try {
      return `data:${mime};base64,${(await readFile(this.#attachmentFile(session, id, mime))).toString("base64")}`;
    } catch {
      return null;
    }
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
