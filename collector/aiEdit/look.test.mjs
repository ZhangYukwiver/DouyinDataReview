import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLookDesk, cutsOnBeats, parseLookResult } from "./look.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const frame = (fill = "A") => `data:image/jpeg;base64,${fill.repeat(8)}`;

describe("parseLookResult", () => {
  it("keeps what the page measured and drops anything malformed", () => {
    const result = parseLookResult({
      duration: 8.004, width: 1080, height: 1920, audio: true, extra: "丢掉",
      shots: [{ start: 2, end: 5, frame: frame("B") }, { start: 0, end: 2, frame: frame() }, { start: 5, end: 4 }, { start: 5, end: 8, frame: "javascript:alert(1)" }],
      flashes: [2.001, -1, "x", 99],
      beats: { bpm: 120.04, beats: [1, 0.5, 9], strong: [1] },
    }, "reference");
    expect(result).toEqual({
      duration: 8, width: 1080, height: 1920, audio: true,
      shots: [{ start: 0, end: 2, frame: frame() }, { start: 2, end: 5, frame: frame("B") }, { start: 5, end: 8, frame: null }],
      flashes: [2],
      beats: { bpm: 120, times: [0.5, 1], strong: [1] },
    });
    expect(parseLookResult({ duration: 30, audio: true, beats: { bpm: 1000, beats: [1] } }, "beats")).toEqual({ duration: 30, audio: true, beats: null });
    expect(parseLookResult({ error: " 解码失败 " }, "reference")).toEqual({ error: "解码失败" });
    expect(() => parseLookResult({ shots: [] }, "reference")).toThrow("视频信息不完整");
    expect(() => parseLookResult({ duration: 5, shots: [] }, "reference")).toThrow("切出镜头");
  });

  it("keeps at most 40 screenshots, picked evenly", () => {
    const shots = Array.from({ length: 100 }, (_, index) => ({ start: index, end: index + 1, frame: frame() }));
    const result = parseLookResult({ duration: 100, shots }, "reference");
    expect(result.shots).toHaveLength(100);
    const framed = result.shots.filter((shot) => shot.frame);
    expect(framed).toHaveLength(40);
    expect(framed[0].start).toBe(0);
    expect(framed.at(-1).start).toBeGreaterThan(90);
  });
});

// 和 AI 剪辑接线一样：活儿挂在这一轮的 streaming 上
const holderOf = (session, touch = () => {}) => ({
  id: session.id,
  live: () => Boolean(session.streaming),
  get: () => session.streaming?.look ?? null,
  set: (look) => { if (session.streaming) session.streaming.look = look; },
  touch: () => touch(session),
});

describe("look desk", () => {
  const setup = (options = {}) => {
    const touched = [];
    const desk = createLookDesk(options);
    const session = { id: "s".repeat(32), streaming: { text: "", actions: [] } };
    const holder = holderOf(session, (current) => touched.push(current.streaming?.look?.id ?? null));
    return { desk, session, holder, touched };
  };

  it("hangs the job on the running turn and resolves when the page answers", async () => {
    const { desk, session, holder, touched } = setup();
    const pending = desk.ask(holder, { kind: "beats", url: "/v1/ai-edit/media/x/file", name: "配乐.mp3" });
    const look = session.streaming.look;
    expect(look).toMatchObject({ kind: "beats", url: "/v1/ai-edit/media/x/file", name: "配乐.mp3" });
    expect(touched).toEqual([look.id]);
    expect(() => desk.answer("o".repeat(32), look.id, {})).toThrow("已经结束");
    desk.answer(session.id, look.id, { duration: 12, audio: true, beats: { bpm: 90, beats: [0.66, 1.33], strong: [] } });
    await expect(pending).resolves.toEqual({ duration: 12, audio: true, beats: { bpm: 90, times: [0.66, 1.33], strong: [] } });
    expect(session.streaming.look).toBeNull();
    expect(() => desk.answer(session.id, look.id, {})).toThrow("已经结束");
  });

  it("keeps waiting while the page reports progress, marks it claimed, and says why when it runs out", async () => {
    const touched = [];
    const session = { id: "s".repeat(32), streaming: { text: "", actions: [] } };
    const holder = holderOf(session, () => touched.push(session.streaming.look?.claimed ?? false));
    const desk = createLookDesk({ timeoutMs: 60, maxMs: 2_000 });
    const pending = desk.ask(holder, { kind: "reference", url: "/x" });
    const id = session.streaming.look.id;
    await new Promise((resolve) => setTimeout(resolve, 40));
    desk.answer(session.id, id, { progress: true });
    expect(session.streaming.look.claimed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    desk.answer(session.id, id, { progress: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 已经过了 120 毫秒，超过一次 timeoutMs，但一直在报进度
    desk.answer(session.id, id, { duration: 3, audio: false, beats: null, shots: [{ start: 0, end: 3 }] });
    await expect(pending).resolves.toMatchObject({ duration: 3 });
    expect(touched).toEqual([false, true, false]);
    // 接手的页面断了心跳：先撤掉「已接手」再挂一轮，还是没人就说页面断了
    const dropped = desk.ask(holder, { kind: "reference", url: "/x" });
    desk.answer(session.id, session.streaming.look.id, { progress: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(session.streaming.look.claimed).toBe(false);
    await expect(dropped).rejects.toMatchObject({ code: "look_dropped", message: expect.stringContaining("断了") });
  });

  it("gives up on a page that keeps reporting progress but never finishes", async () => {
    const session = { id: "s".repeat(32), streaming: { text: "", actions: [] } };
    const desk = createLookDesk({ timeoutMs: 60, maxMs: 150 });
    const slow = desk.ask(holderOf(session), { kind: "reference", url: "/x" });
    const id = session.streaming.look.id;
    const heartbeat = setInterval(() => { try { desk.answer(session.id, id, { progress: true }); } catch { /* 已经结束 */ } }, 30);
    await expect(slow).rejects.toMatchObject({ code: "look_slow", message: expect.stringContaining("太久") });
    clearInterval(heartbeat);
  });

  it("gives up with a clear message when no page picks it up, and stops with the turn", async () => {
    const { desk, session, holder } = setup({ timeoutMs: 20 });
    await expect(desk.ask(holder, { kind: "reference", url: "/x" })).rejects.toMatchObject({ code: "look_unavailable", message: expect.stringContaining("打开应用，再让 AI 解析一次") });
    expect(session.streaming.look).toBeNull();
    const controller = new AbortController();
    const stopped = desk.ask(holder, { kind: "reference", url: "/x" }, { signal: controller.signal });
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    await expect(desk.ask(holderOf({ id: session.id, streaming: null }), { kind: "beats", url: "/x" })).rejects.toMatchObject({ code: "look_unavailable" });
  });

  it("reports what the page could not do, and rejects malformed answers", async () => {
    const { desk, session, holder } = setup();
    const failed = desk.ask(holder, { kind: "reference", url: "/x" });
    desk.answer(session.id, session.streaming.look.id, { error: "这个格式解不开" });
    await expect(failed).rejects.toMatchObject({ code: "look_failed", message: expect.stringContaining("这个格式解不开") });
    const broken = desk.ask(holder, { kind: "reference", url: "/x" });
    expect(() => desk.answer(session.id, session.streaming.look.id, { duration: 3, shots: [] })).toThrow("切出镜头");
    await expect(broken).rejects.toMatchObject({ code: "look_invalid" });
  });

  it("serves a downloaded reference video by token, with ranges, until it expires", async () => {
    let clock = 0;
    const { desk } = setup({ now: () => clock });
    const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-look-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "ref.mp4");
    await writeFile(file, "0123456789");
    const url = desk.offerFile(file);
    expect(url).toMatch(/^\/v1\/ai-edit\/look\/[0-9a-f]{32}\/file$/u);
    const token = url.split("/")[4];
    const server = createServer((request, response) => void desk.sendFile(request, response, request.url.slice(1)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const whole = await fetch(`${base}/${token}`);
    expect([whole.status, await whole.text(), whole.headers.get("content-type")]).toEqual([200, "0123456789", "video/mp4"]);
    const part = await fetch(`${base}/${token}`, { headers: { Range: "bytes=2-4" } });
    expect([part.status, await part.text(), part.headers.get("content-range")]).toEqual([206, "234", "bytes 2-4/10"]);
    expect((await fetch(`${base}/${token}`, { headers: { Range: "bytes=20-" } })).status).toBe(416);
    expect((await fetch(`${base}/${"f".repeat(32)}`)).status).toBe(404);
    clock = 31 * 60_000;
    expect((await fetch(`${base}/${token}`)).status).toBe(404);
  });
});

describe("cutsOnBeats", () => {
  const beats = Array.from({ length: 40 }, (_, index) => index * 0.5);  // 120 BPM
  const shotsAt = (cuts) => [{ start: 0 }, ...cuts.map((start) => ({ start }))];

  it("calls cutting on the beat only when it beats chance", () => {
    expect(cutsOnBeats(shotsAt([1.01, 2.0, 3.49, 5.02]), beats)).toEqual({ onBeat: 4, total: 4, medianDistance: 0.01, chance: 0.32, verdict: "synced" });
    // 垫了背景音乐的口播：切点和拍子无关，碰上的比例和随便切差不多
    const loose = shotsAt([0.37, 1.81, 2.63, 4.12, 5.29, 6.9, 7.44, 9.18, 10.71, 12.05]);
    expect(cutsOnBeats(loose, beats)).toMatchObject({ verdict: "none" });
    // 10 刀里 7 刀卡在拍上：明显比随便切多，但不到八成
    expect(cutsOnBeats(shotsAt([1.0, 2.0, 3.0, 4.0, 5.5, 6.0, 7.5, 8.23, 9.31, 10.17]), beats)).toMatchObject({ onBeat: 7, verdict: "partly" });
    // 6 刀里 3 刀碰上：随便切也常有，不算
    expect(cutsOnBeats(shotsAt([1.0, 2.0, 3.0, 4.23, 5.31, 6.12]), beats)).toMatchObject({ onBeat: 3, verdict: "none" });
    expect(cutsOnBeats(shotsAt([1.0, 2.0]), beats)).toMatchObject({ verdict: "few" });
    expect(cutsOnBeats([{ start: 0 }], beats)).toBeNull();
    expect(cutsOnBeats(shotsAt([1, 2]), undefined)).toBeNull();
    expect(cutsOnBeats(shotsAt([1]), [1])).toBeNull();
  });
});
