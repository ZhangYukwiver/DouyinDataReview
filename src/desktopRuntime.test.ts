import { describe, expect, it } from "vitest";

import {
  checkDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopUpdateState,
  installDesktopUpdate,
  subscribeDesktopUpdateState,
} from "./desktopRuntime";

describe("desktop update bridge", () => {
  it("is a no-op outside the Electron preload bridge", async () => {
    expect(await getDesktopUpdateState()).toBeNull();
    expect(await checkDesktopUpdates()).toBeNull();
    expect(await downloadDesktopUpdate()).toBeNull();
    expect(await installDesktopUpdate()).toBe(false);
    expect(() => subscribeDesktopUpdateState(() => undefined)).not.toThrow();
  });
});
