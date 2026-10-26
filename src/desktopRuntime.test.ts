import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canSendToReelLab,
  checkDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopOpenAtLogin,
  getDesktopUpdateState,
  installDesktopUpdate,
  sendDesktopToReelLab,
  setDesktopOpenAtLogin,
  subscribeDesktopUpdateState,
} from "./desktopRuntime";

// 测试跑在 node 里，没有 window；要模拟 Electron 预加载桥时临时挂一个
function withBridge(bridge: Record<string, unknown>) {
  vi.stubGlobal("window", { desktopRuntime: bridge });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop update bridge", () => {
  it("is a no-op outside the Electron preload bridge", async () => {
    expect(await getDesktopUpdateState()).toBeNull();
    expect(await checkDesktopUpdates()).toBeNull();
    expect(await downloadDesktopUpdate()).toBeNull();
    expect(await installDesktopUpdate()).toBe(false);
    expect(() => subscribeDesktopUpdateState(() => undefined)).not.toThrow();
  });
});

describe("open at login bridge", () => {
  it("answers null outside the desktop app", async () => {
    expect(await getDesktopOpenAtLogin()).toBeNull();
    expect(await setDesktopOpenAtLogin(true)).toBeNull();
  });

  it("answers null when an older desktop shell has no login item methods", async () => {
    withBridge({});
    expect(await getDesktopOpenAtLogin()).toBeNull();
    expect(await setDesktopOpenAtLogin(false)).toBeNull();
  });

  it("reads and writes through the bridge and returns the state the system reports", async () => {
    let enabled = false;
    const setOpenAtLogin = vi.fn(async (next: boolean) => { enabled = next; return enabled; });
    withBridge({ getOpenAtLogin: async () => enabled, setOpenAtLogin });

    expect(await getDesktopOpenAtLogin()).toBe(false);
    expect(await setDesktopOpenAtLogin(true)).toBe(true);
    expect(setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(await getDesktopOpenAtLogin()).toBe(true);
  });

  it("treats a non-boolean answer or a rejected call as unknown instead of throwing", async () => {
    withBridge({ getOpenAtLogin: async () => null, setOpenAtLogin: async () => { throw new Error("ipc failed"); } });
    expect(await getDesktopOpenAtLogin()).toBeNull();
    await expect(setDesktopOpenAtLogin(true)).resolves.toBeNull();

    withBridge({ getOpenAtLogin: () => { throw new Error("sync throw"); }, setOpenAtLogin: async () => "yes" });
    expect(await getDesktopOpenAtLogin()).toBeNull();
    expect(await setDesktopOpenAtLogin(true)).toBeNull();
  });
});

describe("send to ReelLab bridge", () => {
  const handoff = { jobId: "12345678-1234-1234-1234-123456789abc", title: "标题", author: null, url: "https://example.com/v/1", description: null, durationSeconds: 8 };

  it("has no button outside the desktop app or on an older shell", async () => {
    expect(canSendToReelLab()).toBe(false);
    expect(await sendDesktopToReelLab(handoff)).toMatchObject({ status: "failed" });
    withBridge({});
    expect(canSendToReelLab()).toBe(false);
  });

  it("passes the handoff through and keeps only the answers it knows", async () => {
    const sendToReelLab = vi.fn(async () => ({ status: "sent" }));
    withBridge({ sendToReelLab });
    expect(canSendToReelLab()).toBe(true);
    expect(await sendDesktopToReelLab(handoff)).toEqual({ status: "sent" });
    expect(sendToReelLab).toHaveBeenCalledWith(handoff);

    withBridge({ sendToReelLab: async () => ({ status: "sent", wakeFailed: true }) });
    expect(await sendDesktopToReelLab(handoff)).toEqual({ status: "sent", wakeFailed: true });
    withBridge({ sendToReelLab: async () => ({ status: "not_installed" }) });
    expect(await sendDesktopToReelLab(handoff)).toEqual({ status: "not_installed" });
    withBridge({ sendToReelLab: async () => ({ status: "failed", message: "只能送视频，图文作品送不过去。" }) });
    expect(await sendDesktopToReelLab(handoff)).toEqual({ status: "failed", message: "只能送视频，图文作品送不过去。" });
    withBridge({ sendToReelLab: async () => "weird" });
    expect(await sendDesktopToReelLab(handoff)).toMatchObject({ status: "failed", message: expect.any(String) });
    withBridge({ sendToReelLab: async () => { throw new Error("ipc failed"); } });
    expect(await sendDesktopToReelLab(handoff)).toMatchObject({ status: "failed" });
  });
});
