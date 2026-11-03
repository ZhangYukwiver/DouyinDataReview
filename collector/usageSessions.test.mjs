import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UsageSessions, unionDuration } from "./usageSessions.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-usage-")); directories.push(directory);
  let at = new Date(2026, 10, 3, 10).getTime();
  const store = await new UsageSessions(directory, { now: () => at, heartbeatMs: 0 }).initialize();
  return { directory, store, advance: ms => { at += ms; }, now: () => at };
}

describe("usage sessions", () => {
  it("persists exact start/end, keeps repeated open notifications in one session, and paginates history", async () => {
    const { directory, store, advance, now } = await setup();
    const start = now();
    await store.setActive("app", true); advance(1000); await store.setActive("app", true);
    advance(9000); await store.setActive("app", false, { reason: "hidden" });
    advance(2000); await store.setActive("app", true); advance(3000); await store.close();
    const snapshot = await store.snapshot({ limit: 1 });
    expect(snapshot.total).toBe(2); expect(snapshot.hasMore).toBe(true);
    expect(snapshot.today.durationMs).toBe(13_000);
    expect((await store.snapshot({ offset: 1 })).sessions[0]).toMatchObject({ startedAt: start, endedAt: start + 10000, durationMs: 10000, endReason: "hidden" });
    const reopened = await new UsageSessions(directory, { now, heartbeatMs: 0 }).initialize();
    expect((await reopened.snapshot()).sessions).toHaveLength(2);
    expect((await readFile(path.join(directory, "usage-sessions.json"), "utf8"))).not.toContain("token");
  });

  it("deduplicates overlapping sources and clips sessions to today's boundary", async () => {
    const { store, advance } = await setup();
    await store.setActive("app", true); advance(10000);
    await store.setActive("chrome", true); advance(10000);
    await store.setActive("app", false); advance(10000);
    await store.setActive("chrome", false);
    const { today } = await store.snapshot();
    expect(today.durationMs).toBe(30000);
    expect(today.bySource).toMatchObject({ app: 20000, chrome: 20000 });
    expect(unionDuration([[1, 5], [2, 3], [5, 7], [10, 14]])).toBe(10);
    advance(14 * 60 * 60 * 1000 - 31000);
    await store.setActive("app", true); advance(4000); await store.setActive("app", false);
    expect((await store.snapshot()).today.durationMs).toBe(3000);
  });

  it("recovers an unclosed session at its last durable heartbeat, not the next launch", async () => {
    const { directory, store, advance, now } = await setup();
    await store.setActive("chrome", true, { startKind: "observed" }); advance(30000); await store.tick();
    advance(60 * 60 * 1000);
    const recovered = await new UsageSessions(directory, { now, heartbeatMs: 0 }).initialize();
    expect((await recovered.snapshot()).sessions[0]).toMatchObject({ durationMs: 30000, endReason: "interrupted", startKind: "observed" });
    expect((await recovered.snapshot()).activeSources).toEqual([]);
  });

  it("does not count sleep, and ends lost browser connections at the last confirmed time", async () => {
    const { store, advance } = await setup();
    await store.setActive("app", true); await store.setActive("chrome", true);
    advance(10000); await store.setSuspended(true); advance(60 * 60 * 1000);
    await store.setSuspended(false); advance(30000); await store.tick(); advance(4000);
    await store.setActive("chrome", false, { reason: "disconnected" }); await store.setActive("app", false);
    const snapshot = await store.snapshot();
    expect(snapshot.today.durationMs).toBe(44000);
    expect(snapshot.sessions.find(row => row.source === "chrome" && row.startKind === "resumed")).toMatchObject({ durationMs: 30000, endReason: "disconnected" });
  });

  it("bounds a missed sleep event and preserves a corrupt file without replacing it", async () => {
    const { directory, store, advance } = await setup();
    await store.setActive("app", true); advance(30000); await store.tick(); advance(180000); await store.tick();
    advance(5000); await store.close();
    expect((await store.snapshot()).today.durationMs).toBe(35000);
    const file = path.join(directory, "usage-sessions.json"); await writeFile(file, "broken");
    const blocked = await new UsageSessions(directory, { heartbeatMs: 0 }).initialize();
    await blocked.setActive("app", true); await blocked.close();
    expect((await blocked.snapshot()).error).toContain("保留原文件"); expect(await readFile(file, "utf8")).toBe("broken");
  });
});
