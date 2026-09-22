import { describe, expect, it } from "vitest";

import { createSyncRecovery } from "./syncRecovery";

const missingTemplate = { state: "error" as const, code: "template_missing" };

describe("sync recovery", () => {
  it.each([
    "login_required",
    "template_missing",
    "template_invalid",
    "template_mismatch",
    "session_incomplete",
  ])("recovers %s once for an incremental read", (code) => {
    const recovery = createSyncRecovery();
    recovery.begin(true);

    expect(recovery.takeFallback({ state: "error", code })).toBe(true);
    expect(recovery.takeFallback({ state: "error", code })).toBe(false);
  });

  it("allows recovery again for a later incremental read", () => {
    const recovery = createSyncRecovery();
    recovery.begin(true);
    expect(recovery.takeFallback(missingTemplate)).toBe(true);

    recovery.begin(false);
    expect(recovery.takeFallback(missingTemplate)).toBe(false);

    recovery.begin(true);
    expect(recovery.takeFallback(missingTemplate)).toBe(true);
    expect(recovery.takeFallback(missingTemplate)).toBe(false);
  });

  it("does not restart a full read after a recoverable failure", () => {
    const recovery = createSyncRecovery();
    recovery.begin(false);

    expect(recovery.takeFallback(missingTemplate)).toBe(false);
    expect(recovery.takeFallback({ state: "error", code: "login_required" })).toBe(false);
  });

  it("ignores unrelated errors and non-error statuses without consuming recovery", () => {
    const recovery = createSyncRecovery();
    recovery.begin(true);

    expect(recovery.takeFallback({ state: "error", code: "rate_limited" })).toBe(false);
    expect(recovery.takeFallback({ state: "error" })).toBe(false);
    expect(recovery.takeFallback({ state: "error", code: null })).toBe(false);
    expect(recovery.takeFallback({ state: "complete", code: "template_missing" })).toBe(false);
    expect(recovery.takeFallback(missingTemplate)).toBe(true);
  });

  it("preserves one recovery opportunity when reconnecting to an existing run", () => {
    const recovery = createSyncRecovery();

    expect(recovery.takeFallback(missingTemplate)).toBe(true);
    expect(recovery.takeFallback(missingTemplate)).toBe(false);
  });
});
