import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_CHECKPOINTS, SessionStore, revertTarget, sessionDetail } from "./sessions.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(options = {}) {
  // 存档放在会话目录旁边的 checkpoints/（同采集器里 ai-edit/sessions 和 ai-edit/checkpoints）
  const base = await mkdtemp(path.join(tmpdir(), "ai-edit-sessions-"));
  directories.push(base);
  const directory = path.join(base, "sessions");
  let clock = Date.parse("2026-10-19T08:00:00.000Z");
  let counter = 0;
  const sessions = new SessionStore({
    directory,
    now: () => new Date(clock += 1_000),
    newId: () => String(++counter).padStart(32, "0"),
    ...options,
  });
  await sessions.load();
  return { sessions, directory };
}

describe("SessionStore", () => {
  it("persists sessions with their model history, but never the streaming text", async () => {
    const { sessions, directory } = await store();
    const first = await sessions.create({ title: "第一个", projectId: "p1" });
    const second = await sessions.create({ title: "第二个", projectId: "p2" });
    first.history.push({ role: "user", content: "hi" });
    first.messages.push({ id: "m1", role: "user", text: "hi", at: "2026-10-19T08:00:00.000Z" });
    first.streaming = { text: "半句", actions: [] };
    await sessions.touch(first, { persist: true });
    expect(sessions.list().map((item) => item.id)).toEqual([first.id, second.id]);
    expect(sessions.list()[0]).toEqual({ id: first.id, title: "第一个", createdAt: first.createdAt, updatedAt: first.updatedAt, status: "idle", projectId: "p1", draftBox: null, awaitingSpend: false, awaitingCommand: false });
    // 这一轮挂着花钱确认：会话菜单要标出来
    first.streaming.spend = { id: "a".repeat(16), kind: "video" };
    expect(sessions.list()[0].awaitingSpend).toBe(true);
    delete first.streaming.spend;
    // 技能命令等用户点：同样标出来，页面拿到的是一份拷贝
    first.streaming.command = { id: "b".repeat(16), kind: "command", skill: "示例", skill_id: "demo", command: ["node", "run.mjs"], cwd: "/x", background: false, expiresAt: 1 };
    expect(sessions.list()[0]).toMatchObject({ awaitingSpend: false, awaitingCommand: true });
    const shown = sessionDetail(first).streaming.command;
    expect(shown).toEqual(first.streaming.command);
    shown.command.push("--rm");
    expect(first.streaming.command.command).toEqual(["node", "run.mjs"]);
    delete first.streaming.command;

    const saved = JSON.parse(await readFile(path.join(directory, `${first.id}.json`), "utf8"));
    expect(saved.history).toEqual([{ role: "user", content: "hi" }]);
    expect(saved).not.toHaveProperty("streaming");
    expect(sessionDetail(first)).toMatchObject({ revision: 2, streaming: { text: "半句", actions: [] }, messages: [{ id: "m1" }] });
    // 给模型的历史不发给页面：页面上的 history 是操作历史（撤销用的存档）
    expect(sessionDetail(first).history).toEqual([]);

    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(first.id)).toMatchObject({ title: "第一个", revision: 2, streaming: null, history: [{ role: "user", content: "hi" }] });
  });

  it("keeps the goal across restarts, and gives sessions saved before goals an empty one", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    expect(sessionDetail(session).goal).toBe("");
    session.goal = "30 秒旅行卡点快闪";
    await sessions.touch(session, { persist: true });
    const old = await sessions.create({ title: "旧的", projectId: "q" });
    const { goal: _goal, ...stored } = old;
    await writeFile(path.join(directory, `${old.id}.json`), JSON.stringify(stored));
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(sessionDetail(reloaded.get(session.id)).goal).toBe("30 秒旅行卡点快闪");
    expect(sessionDetail(reloaded.get(old.id)).goal).toBe("");
  });

  it("marks a session that was running when the collector stopped as failed", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    session.status = "running";
    await sessions.save(session);
    await writeFile(path.join(directory, "junk.json"), "{");
    await writeFile(path.join(directory, `${"f".repeat(32)}.json`), "not json");
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    const restored = reloaded.get(session.id);
    expect(restored.status).toBe("failed");
    expect(restored.error).toEqual({ code: "interrupted", message: expect.stringContaining("采集器关掉了") });
    expect(restored.revision).toBe(session.revision + 1);
    expect(JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8")).status).toBe("failed");
    expect(reloaded.list()).toHaveLength(1);
  });

  it("drops the redo stack of a session that was running when the collector stopped: the turn may have changed the project", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const pushed = await sessions.addRedo(session, { kind: "edit", label: "挪动了片段", messageIndex: 0, snapshot: { project: { name: "x", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [], markers: [] }, grids: {} } });
    const file = path.join(path.dirname(directory), "checkpoints", session.id, `${pushed.id}.json`);
    session.status = "running";
    await sessions.save(session);
    expect(existsSync(file)).toBe(true);

    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(session.id)).toMatchObject({ status: "failed", redo: [] });
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8")).redo).toEqual([]);
  });

  it("answers tool calls left without results when the collector was killed mid-turn", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const calls = [{ id: "call_a", type: "function", function: { name: "get_timeline", arguments: "{}" } }, { id: "call_export", type: "function", function: { name: "export_to_jianying", arguments: "{}" } }];
    session.history.push({ role: "user", content: "导出" }, { role: "assistant", content: null, tool_calls: calls }, { role: "tool", tool_call_id: "call_a", content: "{\"ok\":true}" });
    session.status = "running";
    await sessions.save(session);
    // 正常结束的会话本来就是齐的，加载时不该改动
    const tidy = await sessions.create({ title: "y", projectId: "q" });
    tidy.history.push({ role: "user", content: "hi" }, { role: "assistant", content: "好" });
    await sessions.save(tidy);

    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    const sealed = { role: "tool", tool_call_id: "call_export", content: JSON.stringify({ ok: false, code: "stopped", message: "采集器关掉了，这个工具没有执行。" }) };
    expect(reloaded.get(session.id).history.map((entry) => entry.tool_call_id ?? entry.role)).toEqual(["user", "assistant", "call_a", "call_export"]);
    expect(reloaded.get(session.id).history.at(-1)).toEqual(sealed);
    expect(JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8")).history.at(-1)).toEqual(sealed);
    expect(reloaded.get(tidy.id).history).toEqual(tidy.history);
    expect(reloaded.get(tidy.id).revision).toBe(tidy.revision);
  });

  it("long-polls until the revision changes, times out, and lets go when the client leaves", async () => {
    const { sessions } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    // revision 不同立刻返回
    await sessions.wait(session.id, session.revision - 1);
    let woke = false;
    const waiting = sessions.wait(session.id, session.revision, { timeoutMs: 5_000 }).then(() => { woke = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(woke).toBe(false);
    void sessions.touch(session, { quiet: true });
    await waiting;
    expect(woke).toBe(true);

    const started = Date.now();
    await sessions.wait(session.id, session.revision, { timeoutMs: 50 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);

    const controller = new AbortController();
    const left = sessions.wait(session.id, session.revision, { timeoutMs: 5_000, signal: controller.signal });
    expect(sessions.waiters.get(session.id).size).toBe(1);
    controller.abort();
    await left;
    expect(sessions.waiters.has(session.id)).toBe(false);
  });

  it("quiet touches wake pages without reordering the recent list", async () => {
    const { sessions } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const { updatedAt, revision } = session;
    await sessions.touch(session, { quiet: true });
    expect(session).toMatchObject({ updatedAt, revision: revision + 1 });
  });

  it("keeps checkpoints as files beside the sessions, trims the oldest past the limit and removes them with the session", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    expect(sessionDetail(session)).toMatchObject({ undo: null, revertible: [] });
    const snapshot = (n) => ({ project: { name: `第 ${n} 版`, canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [], markers: [] }, grids: {} });
    const first = await sessions.addCheckpoint(session, { kind: "turn", label: "AI 处理“剪个片子”之前", snapshot: snapshot(0) });
    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/u), kind: "turn", messageIndex: 0, label: "AI 处理“剪个片子”之前", at: expect.any(String) });
    const folder = path.join(path.dirname(directory), "checkpoints", session.id);
    expect(await readdir(folder)).toEqual([`${first.id}.json`]);
    if (process.platform !== "win32") {
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(folder, `${first.id}.json`))).mode & 0o777).toBe(0o600);
    }
    expect(await sessions.readCheckpoint(session, first.id)).toEqual(snapshot(0));
    session.messages.push({ id: "u1", role: "user", text: "剪个片子", at: "2026-10-19T08:00:00.000Z" }, { id: "a1", role: "assistant", text: "好", at: "2026-10-19T08:00:01.000Z" });
    expect(sessionDetail(session)).toMatchObject({ undo: { label: "AI 处理“剪个片子”之前" }, revertible: ["u1"] });
    // 跟着会话存盘，重启后还在
    await sessions.touch(session, { persist: true });
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(session.id)).toMatchObject({ checkpoints: [first], checkpointsTrimmedAt: -1, pendingNotes: [] });

    for (let n = 1; n <= MAX_CHECKPOINTS; n += 1) await sessions.addCheckpoint(session, { kind: "edit", label: `改动 ${n}`, snapshot: snapshot(n) });
    expect(session.checkpoints).toHaveLength(MAX_CHECKPOINTS);
    expect(session.checkpoints[0]).toMatchObject({ label: "改动 1", messageIndex: 2 });
    // 最旧那份连文件一起删了；它是第一句话之前的样子，第一句话就退不回去了
    expect(session.checkpointsTrimmedAt).toBe(0);
    expect(await readdir(folder)).toHaveLength(MAX_CHECKPOINTS);
    expect(existsSync(path.join(folder, `${first.id}.json`))).toBe(false);
    expect(sessionDetail(session).revertible).toEqual([]);
    await sessions.dropCheckpoint(session, session.checkpoints.at(-1).id);
    expect(sessionDetail(session).undo).toEqual({ label: `改动 ${MAX_CHECKPOINTS - 1}`, kind: "edit" });
    expect(await readdir(folder)).toHaveLength(MAX_CHECKPOINTS - 1);
    await expect(sessions.readCheckpoint(session, "../../x")).rejects.toThrow();

    expect(await sessions.remove(session.id)).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });

  it("goes back to the moment a message was sent, not to before the board edits made ahead of it", async () => {
    const { sessions } = await store();
    const snapshot = { project: { name: "x", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [], markers: [] }, grids: {} };
    const talk = (session) => session.messages.push({ id: "u1", role: "user", text: "剪", at: "2026-10-19T08:00:00.000Z" }, { id: "a1", role: "assistant", text: "好", at: "2026-10-19T08:00:01.000Z" });
    // 发话前在看板上改过、这一轮 AI 没动工程：发话那一刻就是现在的样子，没东西可退
    const chatted = await sessions.create({ title: "x", projectId: "p" });
    await sessions.addCheckpoint(chatted, { kind: "edit", label: "挪动", snapshot });
    talk(chatted);
    expect(revertTarget(chatted, 0)).toBeNull();
    expect(sessionDetail(chatted).revertible).toEqual([]);
    // 之后又改了：改之前的样子就是这句话发出时的样子
    const later = await sessions.addCheckpoint(chatted, { kind: "edit", label: "删掉", snapshot });
    expect(revertTarget(chatted, 0)).toEqual(later);
    expect(sessionDetail(chatted).revertible).toEqual(["u1"]);

    // 同一下标上先有手动改动、再有这一轮开跑前的存档：用开跑前那份
    const edited = await sessions.create({ title: "y", projectId: "q" });
    await sessions.addCheckpoint(edited, { kind: "edit", label: "挪动", snapshot });
    const turn = await sessions.addCheckpoint(edited, { kind: "turn", label: "AI 处理“剪”之前", snapshot });
    talk(edited);
    expect(revertTarget(edited, 0)).toEqual(turn);
    expect(sessionDetail(edited).revertible).toEqual(["u1"]);
    edited.checkpointsTrimmedAt = 0;
    expect(revertTarget(edited, 0)).toBeNull();
    expect(revertTarget(edited, -1)).toBeNull();
  });

  it("drops checkpoint entries whose files are gone when loading, without letting revert land on a later one", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const snapshot = { project: { name: "x", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [], markers: [] }, grids: {} };
    const saved = [];
    for (const index of [0, 2, 4, 6]) {
      saved.push(await sessions.addCheckpoint(session, { kind: "turn", label: `第 ${index} 句之前`, snapshot }));
      session.messages.push({ id: `u${index}`, role: "user", text: "剪", at: "2026-10-19T08:00:00.000Z" }, { id: `a${index}`, role: "assistant", text: "好", at: "2026-10-19T08:00:01.000Z" });
    }
    await sessions.touch(session, { persist: true });
    expect(sessionDetail(session)).toMatchObject({ undo: { label: "第 6 句之前" }, revertible: ["u0", "u2", "u4", "u6"] });
    // 删了文件、还没存会话文件时被强杀：最后一份是撤销时删的，最前一份是超出上限删的
    const folder = path.join(path.dirname(directory), "checkpoints", session.id);
    await rm(path.join(folder, `${saved[3].id}.json`));
    await rm(path.join(folder, `${saved[0].id}.json`));
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    const restored = reloaded.get(session.id);
    expect(restored).toMatchObject({ checkpoints: [saved[1], saved[2]], checkpointsTrimmedAt: 0 });
    expect(sessionDetail(restored)).toMatchObject({ undo: { label: "第 4 句之前" }, revertible: ["u2", "u4"] });
    expect(JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8"))).toMatchObject({ checkpoints: [saved[1], saved[2]], checkpointsTrimmedAt: 0 });
  });

  it("gives sessions saved before checkpoints and board edits empty ones", async () => {
    const { sessions, directory } = await store();
    const old = await sessions.create({ title: "旧的", projectId: "q" });
    const { checkpoints: _checkpoints, checkpointsTrimmedAt: _trimmed, pendingNotes: _notes, ...stored } = old;
    await writeFile(path.join(directory, `${old.id}.json`), JSON.stringify({ ...stored, messages: [{ id: "u1", role: "user", text: "hi", at: "2026-10-19T08:00:00.000Z" }] }));
    const tampered = await sessions.create({ title: "坏的", projectId: "r" });
    tampered.checkpoints.push({ id: "../../etc", kind: "edit", messageIndex: 0, label: "x", at: "2026-10-19T08:00:00.000Z" }, { id: "a".repeat(16), kind: "edit", messageIndex: "0", label: "x", at: "" });
    tampered.pendingNotes.push("挪了片段", 3);
    await sessions.save(tampered);
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(old.id)).toMatchObject({ checkpoints: [], checkpointsTrimmedAt: -1, pendingNotes: [] });
    expect(sessionDetail(reloaded.get(old.id))).toMatchObject({ undo: null, revertible: [] });
    expect(reloaded.get(tampered.id)).toMatchObject({ checkpoints: [], pendingNotes: ["挪了片段"] });
  });

  it("lists the operation history newest first and keeps a redo stack of files beside the checkpoints", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const snapshot = (n) => ({ project: { name: `第 ${n} 版`, canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [], markers: [] }, grids: {} });
    expect(sessionDetail(session)).toMatchObject({ undo: null, redo: null, history: [] });
    const saved = [];
    for (let n = 1; n <= 3; n += 1) saved.push(await sessions.addCheckpoint(session, { kind: n === 2 ? "turn" : "edit", label: `改动 ${n}`, snapshot: snapshot(n) }));
    expect(sessionDetail(session).history).toEqual(saved.toReversed().map(({ id, kind, label, at }) => ({ id, kind, label, at })));
    expect(sessionDetail(session).undo).toEqual({ label: "改动 3", kind: "edit" });

    // 重做快照和存档在同一个目录、同一种 id
    const folder = path.join(path.dirname(directory), "checkpoints", session.id);
    const pushed = await sessions.addRedo(session, { kind: "edit", label: "改动 4", messageIndex: 0, snapshot: snapshot(4) });
    expect(pushed).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/u), kind: "edit", label: "改动 4", messageIndex: 0, at: expect.any(String) });
    expect(await sessions.readCheckpoint(session, pushed.id)).toEqual(snapshot(4));
    expect(await readdir(folder)).toHaveLength(4);
    // 存档挪进重做栈：文件不动，条目换个说法
    await sessions.checkpointToRedo(session, saved[2].id, { kind: saved[1].kind, label: saved[1].label, messageIndex: saved[1].messageIndex });
    expect(session.checkpoints).toEqual(saved.slice(0, 2));
    expect(session.redo.at(-1)).toMatchObject({ id: saved[2].id, kind: "turn", label: "改动 2" });
    expect(sessionDetail(session)).toMatchObject({ redo: { label: "改动 2" }, history: [{ label: "改动 2" }, { label: "改动 1" }] });
    expect(await readdir(folder)).toHaveLength(4);

    // 跟着会话存盘；文件没了的条目重启时丢掉
    await sessions.touch(session, { persist: true });
    let reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(session.id).redo).toEqual(session.redo);
    await rm(path.join(folder, `${pushed.id}.json`));
    reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(session.id).redo).toEqual([session.redo[1]]);
    expect(JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8")).redo).toEqual([session.redo[1]]);

    await sessions.dropRedo(session, saved[2].id);
    expect(existsSync(path.join(folder, `${saved[2].id}.json`))).toBe(false);
    expect(sessionDetail(session).redo).toEqual({ label: "改动 4" });
    // 最多 50 份，再多删最早推进去的（连文件）
    for (let n = 0; n < MAX_CHECKPOINTS; n += 1) await sessions.addRedo(session, { kind: "edit", label: `重做 ${n}`, messageIndex: 0, snapshot: snapshot(n) });
    expect(session.redo).toHaveLength(MAX_CHECKPOINTS);
    expect(session.redo[0].label).toBe("重做 0");
    expect(await readdir(folder)).toHaveLength(2 + MAX_CHECKPOINTS);
    await sessions.clearRedo(session);
    expect(session.redo).toEqual([]);
    expect((await readdir(folder)).sort()).toEqual(saved.slice(0, 2).map((item) => `${item.id}.json`).sort());

    // 操作历史最多列 50 步
    for (let n = 0; n < MAX_CHECKPOINTS + 5; n += 1) await sessions.addCheckpoint(session, { kind: "edit", label: `第 ${n} 步`, snapshot: snapshot(n) });
    const { history } = sessionDetail(session);
    expect(history).toHaveLength(MAX_CHECKPOINTS);
    expect(history[0].label).toBe(`第 ${MAX_CHECKPOINTS + 4} 步`);
    expect(history.at(-1).label).toBe("第 5 步");
  });

  it("gives sessions saved before redo an empty redo stack", async () => {
    const { sessions, directory } = await store();
    const old = await sessions.create({ title: "旧的", projectId: "q" });
    const { redo: _redo, ...stored } = old;
    await writeFile(path.join(directory, `${old.id}.json`), JSON.stringify(stored));
    const tampered = await sessions.create({ title: "坏的", projectId: "r" });
    tampered.redo.push({ id: "../../etc", kind: "edit", messageIndex: 0, label: "x" }, { id: "b".repeat(16), kind: "edit", messageIndex: 0, label: 3 });
    await sessions.save(tampered);
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(old.id).redo).toEqual([]);
    expect(sessionDetail(reloaded.get(old.id))).toMatchObject({ redo: null, history: [] });
    expect(reloaded.get(tampered.id).redo).toEqual([]);
  });

  it("removes a session file and wakes its waiters", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const waiting = sessions.wait(session.id, session.revision, { timeoutMs: 5_000 });
    expect(await sessions.remove(session.id)).toBe(true);
    await waiting;
    expect(await readdir(directory)).toEqual([]);
    expect(sessions.get(session.id)).toBeNull();
    expect(await sessions.remove(session.id)).toBe(false);
    expect(sessions.get("../../etc")).toBeNull();
  });
});

describe("SessionStore: trimmed history and pasted images", () => {
  it("remembers that old turns were dropped, and gives sessions saved before that a false", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    expect(sessionDetail(session).trimmed).toBe(false);
    session.trimmed = true;
    await sessions.touch(session, { persist: true });
    const old = await sessions.create({ title: "旧的", projectId: "q" });
    const { trimmed: _trimmed, ...stored } = old;
    await writeFile(path.join(directory, `${old.id}.json`), JSON.stringify(stored));
    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(sessionDetail(reloaded.get(session.id)).trimmed).toBe(true);
    expect(reloaded.get(old.id).trimmed).toBe(false);
    expect(sessionDetail(reloaded.get(old.id)).trimmed).toBe(false);
  });

  it("keeps pasted images as files beside the sessions, reads them back for the model and removes them with the session", async () => {
    const { sessions, directory } = await store();
    const session = await sessions.create({ title: "x", projectId: "p" });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const id = await sessions.saveAttachment(session, { mime: "image/jpeg", bytes });
    expect(id).toMatch(/^[0-9a-f]{16}$/u);
    const folder = path.join(path.dirname(directory), "attachments", session.id);
    expect(await readdir(folder)).toEqual([`${id}.jpg`]);
    if (process.platform !== "win32") expect((await stat(path.join(folder, `${id}.jpg`))).mode & 0o777).toBe(0o600);
    expect(await sessions.readAttachment(session, { id, mime: "image/jpeg" })).toBe(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    // 记录不对、文件没了都回 null，不往外抛
    expect(await sessions.readAttachment(session, { id: "../../etc/passwd", mime: "image/jpeg" })).toBeNull();
    expect(await sessions.readAttachment(session, { id, mime: "text/html" })).toBeNull();
    expect(await sessions.readAttachment(session, { id: "0".repeat(16), mime: "image/jpeg" })).toBeNull();
    await expect(sessions.saveAttachment(session, { mime: "image/gif", bytes })).rejects.toThrow();
    // 消息上的引用和附图原样给页面
    session.messages.push({ id: "u1", role: "user", text: "用这张", at: "2026-10-19T08:00:00.000Z", refs: [{ kind: "time", time_us: 0, label: "第 0 秒" }], attachments: [{ media_id: "a".repeat(32), name: "封面.jpg" }] });
    expect(sessionDetail(session).messages[0]).toMatchObject({ refs: [{ kind: "time", time_us: 0, label: "第 0 秒" }], attachments: [{ media_id: "a".repeat(32), name: "封面.jpg" }] });
    expect(sessionDetail(session).messages[0].refs).not.toBe(session.messages[0].refs);
    expect(await sessions.remove(session.id)).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });
});
