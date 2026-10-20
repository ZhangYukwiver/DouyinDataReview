import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore, sessionDetail } from "./sessions.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-sessions-"));
  directories.push(directory);
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
    expect(sessions.list()[0]).toEqual({ id: first.id, title: "第一个", createdAt: first.createdAt, updatedAt: first.updatedAt, status: "idle", projectId: "p1", draftBox: null });

    const saved = JSON.parse(await readFile(path.join(directory, `${first.id}.json`), "utf8"));
    expect(saved.history).toEqual([{ role: "user", content: "hi" }]);
    expect(saved).not.toHaveProperty("streaming");
    expect(sessionDetail(first)).toMatchObject({ revision: 2, streaming: { text: "半句", actions: [] }, messages: [{ id: "m1" }] });
    expect(sessionDetail(first)).not.toHaveProperty("history");

    const reloaded = new SessionStore({ directory });
    await reloaded.load();
    expect(reloaded.get(first.id)).toMatchObject({ title: "第一个", revision: 2, streaming: null, history: [{ role: "user", content: "hi" }] });
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
