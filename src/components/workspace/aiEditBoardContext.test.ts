import { describe, expect, it } from "vitest";

import {
  createBoardRegistry, discardHeld, dispatchBoardKey, dispatchEscape, flushHeld, type BoardArea, type BoardKeyHandlers, type BoardRegistry,
} from "./aiEditBoardContext";
import { actionsOf } from "./aiEditKeymap";

// 不经过 React，直接往登记表里放：和 useBoardKeys 登记进去的一样
function register(registry: BoardRegistry, area: BoardArea, handlers: BoardKeyHandlers, enabled = true) {
  registry.keys.push({ area, handlers: { current: handlers }, enabled: { current: enabled } });
}
const press = (registry: BoardRegistry, combo: string, area: Parameters<typeof dispatchBoardKey>[3], repeat = false) =>
  dispatchBoardKey(registry, { repeat }, actionsOf(combo, true), area, (handler) => handler({} as KeyboardEvent));

describe("快捷键分给谁", () => {
  it("最后一次按在画面上：画面登记的方向键先问，它不管再落到播放头", () => {
    const registry = createBoardRegistry();
    const calls: string[] = [];
    let framed = true;
    register(registry, "board", { "frame-back": () => { calls.push("播放头"); } });
    register(registry, "stage", { "stage-left": () => { calls.push("画面"); return framed ? undefined : false; } });
    expect(press(registry, "ArrowLeft", "stage")).toBe(true);
    framed = false;
    expect(press(registry, "ArrowLeft", "stage")).toBe(true);
    // 最后一次按在轨道区：画面登记的整组不问
    expect(press(registry, "ArrowLeft", "timeline")).toBe(true);
    expect(calls).toEqual(["画面", "画面", "播放头", "播放头"]);
  });

  it("同一区域后登记的先问；没人管返回 false，看板不拦这个键", () => {
    const registry = createBoardRegistry();
    const calls: string[] = [];
    register(registry, "board", { copy: () => { calls.push("先登记"); } });
    register(registry, "board", { copy: () => { calls.push("后登记"); } });
    expect(press(registry, "mod+c", "board")).toBe(true);
    expect(calls).toEqual(["后登记"]);
    expect(press(registry, "mod+=", "board")).toBe(false);
  });

  it("按住连发：会改工程的只认第一下，后面的吃掉不执行；播放头可以连发", () => {
    const registry = createBoardRegistry();
    const calls: string[] = [];
    register(registry, "board", { undo: () => { calls.push("撤销"); }, "frame-forward": () => { calls.push("走一帧"); } });
    expect(press(registry, "mod+z", "board", true)).toBe(true);
    expect(press(registry, "ArrowRight", "board", true)).toBe(true);
    expect(calls).toEqual(["走一帧"]);
  });

  it("最后一次按在看板外面：只认标了 anywhere 的（撤销、删除），方向键、全选留给左栏", () => {
    const registry = createBoardRegistry();
    const calls: string[] = [];
    register(registry, "board", { undo: () => { calls.push("撤销"); }, "select-all": () => { calls.push("全选"); }, "frame-back": () => { calls.push("走一帧"); } });
    expect(press(registry, "mod+a", "outside")).toBe(false);
    expect(press(registry, "ArrowLeft", "outside")).toBe(false);
    expect(press(registry, "mod+z", "outside")).toBe(true);
    // 还没按过（刚打开页面）当在看板里
    expect(press(registry, "mod+a", null)).toBe(true);
    expect(calls).toEqual(["撤销", "全选"]);
  });

  it("关掉的那组跳过", () => {
    const registry = createBoardRegistry();
    register(registry, "board", { split: () => undefined }, false);
    expect(press(registry, "mod+b", "board")).toBe(false);
  });
});

describe("Esc 分层", () => {
  it("后登记的先问，吃掉了就停；都不吃返回 false 交给看板", () => {
    const registry = createBoardRegistry();
    const calls: string[] = [];
    registry.escapes.push({ handler: { current: () => { calls.push("框选"); return true; } } });
    registry.escapes.push({ handler: { current: () => { calls.push("改字"); return false; } } });
    expect(dispatchEscape(registry, {} as KeyboardEvent)).toBe(true);
    expect(calls).toEqual(["改字", "框选"]);
    expect(dispatchEscape(createBoardRegistry(), {} as KeyboardEvent)).toBe(false);
  });
});

describe("攒着没发的改动", () => {
  it("flush 等每一份都发出去、回来；discard 有一份丢了东西就算丢了", async () => {
    const registry = createBoardRegistry();
    const sent: string[] = [];
    let pending = true;
    registry.holds.push({ held: { current: { flush: async () => { await Promise.resolve(); sent.push("轨道微调"); }, discard: () => false } } });
    registry.holds.push({ held: { current: { flush: () => undefined, discard: () => { const had = pending; pending = false; return had; } } } });
    await flushHeld(registry);
    expect(sent).toEqual(["轨道微调"]);
    expect(discardHeld(registry)).toBe(true);
    expect(discardHeld(registry)).toBe(false);
  });
});
