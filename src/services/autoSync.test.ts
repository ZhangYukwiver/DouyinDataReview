import { describe, expect, it } from "vitest";

import { shouldAutoSync, shouldSuppressBrowserLoginAutoSync } from "./autoSync";

const ready = {
  enabled: true,
  connected: true,
  source: "collector" as const,
  busy: false,
  inFlight: false,
  switchingAccount: false,
  stoppingSync: false,
  state: "complete" as const,
};

describe("shouldAutoSync", () => {
  it("allows an idle foreground refresh", () => {
    expect(shouldAutoSync({ ...ready, state: "idle" })).toBe(true);
    expect(shouldAutoSync({ ...ready, state: null })).toBe(true);
  });

  it("blocks disabled, archive, busy and duplicate refreshes", () => {
    expect(shouldAutoSync({ ...ready, enabled: false })).toBe(false);
    expect(shouldAutoSync({ ...ready, source: "archive" })).toBe(false);
    expect(shouldAutoSync({ ...ready, busy: true })).toBe(false);
    expect(shouldAutoSync({ ...ready, inFlight: true })).toBe(false);
  });

  it("does not interrupt active collection or account changes", () => {
    expect(shouldAutoSync({ ...ready, state: "collecting" })).toBe(false);
    expect(shouldAutoSync({ ...ready, state: "observing" })).toBe(false);
    expect(shouldAutoSync({ ...ready, switchingAccount: true })).toBe(false);
    expect(shouldAutoSync({ ...ready, stoppingSync: true })).toBe(false);
  });
});

describe("browser login auto-sync suppression", () => {
  it("suppresses automatic reads after import while allowing a manual read", () => {
    expect(shouldSuppressBrowserLoginAutoSync(true, false)).toBe(true);
    expect(shouldSuppressBrowserLoginAutoSync(true, true)).toBe(false);
    expect(shouldSuppressBrowserLoginAutoSync(false, false)).toBe(false);
  });
});
