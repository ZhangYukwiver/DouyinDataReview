import { describe, expect, it } from "vitest";

import { createSpendDesk } from "./spend.mjs";

// 和 AI 剪辑接线一样：问题挂在这一轮的 streaming 上
const holderOf = (session, touched) => ({
  id: session.id,
  live: () => Boolean(session.streaming),
  get: () => session.streaming?.spend ?? null,
  set: (spend) => {
    if (!session.streaming) return;
    if (spend) session.streaming.spend = spend;
    else delete session.streaming.spend;
  },
  touch: () => touched.push(session.streaming?.spend?.id ?? null),
});

const SPEC = { kind: "video", provider: "火山方舟 Seedance", model: "doubao-seedance-2-0-260128", seconds: 5, resolution: "720p", ratio: "9:16", audio: false, prompt: "海边日落", estimate: 4.97 };

describe("spend desk", () => {
  const setup = (options = {}) => {
    const touched = [];
    const desk = createSpendDesk({ now: () => 1_000, ...options });
    const session = { id: "s".repeat(32), streaming: { text: "", actions: [] } };
    return { desk, session, touched, holder: holderOf(session, touched) };
  };

  it("hangs the question on the turn and goes on once the page says yes", async () => {
    const { desk, session, touched, holder } = setup();
    const asking = desk.ask(holder, SPEC);
    const spend = session.streaming.spend;
    expect(spend).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/u), ...SPEC, expiresAt: 1_000 + 15 * 60_000 });
    expect(touched).toEqual([spend.id]);
    expect(desk.answer(session.id, spend.id, true)).toBe(true);
    await expect(asking).resolves.toBeUndefined();
    expect(session.streaming.spend).toBeUndefined();
    expect(touched).toEqual([spend.id, null]);
    // 答过的再答一次就找不到了
    expect(() => desk.answer(session.id, spend.id, false)).toThrow(expect.objectContaining({ code: "spend_not_found", status: 404 }));
  });

  it("tells the model the user said no", async () => {
    const { desk, session, holder } = setup();
    const asking = desk.ask(holder, SPEC);
    desk.answer(session.id, session.streaming.spend.id, false);
    await expect(asking).rejects.toMatchObject({ code: "spend_denied", message: expect.stringContaining("一分钱没花") });
    expect(session.streaming.spend).toBeUndefined();
  });

  it("gives up when nobody answers in time", async () => {
    const { desk, session, holder } = setup({ timeoutMs: 20 });
    await expect(desk.ask(holder, SPEC)).rejects.toMatchObject({ code: "spend_timeout", message: expect.stringContaining("没人点确认") });
    expect(session.streaming.spend).toBeUndefined();
  });

  it("stops with the turn and when the collector closes", async () => {
    const { desk, session, holder } = setup();
    const controller = new AbortController();
    const asking = desk.ask(holder, SPEC, { signal: controller.signal });
    const { id } = session.streaming.spend;
    controller.abort();
    await expect(asking).rejects.toMatchObject({ name: "AbortError" });
    expect(session.streaming.spend).toBeUndefined();
    expect(() => desk.answer(session.id, id, true)).toThrow(expect.objectContaining({ code: "spend_not_found" }));
    // 一开始就停了：不挂出来
    const stopped = new AbortController();
    stopped.abort();
    await expect(desk.ask(holder, SPEC, { signal: stopped.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(session.streaming.spend).toBeUndefined();

    const closing = desk.ask(holder, SPEC);
    desk.close();
    await expect(closing).rejects.toMatchObject({ code: "interrupted" });
    expect(session.streaming.spend).toBeUndefined();
  });

  it("only takes answers for its own session, and refuses after the turn ended", async () => {
    const { desk, session, holder } = setup();
    const asking = desk.ask(holder, SPEC);
    const { id } = session.streaming.spend;
    expect(() => desk.answer("x".repeat(32), id, true)).toThrow(expect.objectContaining({ code: "spend_not_found", status: 404 }));
    expect(() => desk.answer(session.id, "0".repeat(16), true)).toThrow(expect.objectContaining({ code: "spend_not_found" }));
    expect(session.streaming.spend.id).toBe(id);
    desk.answer(session.id, id, true);
    await asking;
    session.streaming = null;
    await expect(desk.ask(holder, SPEC)).rejects.toMatchObject({ code: "spend_unavailable" });
  });
});
