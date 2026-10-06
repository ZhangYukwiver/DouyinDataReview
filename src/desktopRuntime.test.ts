import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopOpenAtLogin,
  getDesktopUpdateState,
  installDesktopUpdate,
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
