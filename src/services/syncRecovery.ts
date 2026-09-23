import type { CollectorStatus } from "./localCollector";

// These failures need a visible browser once to log in or capture a fresh template.
const PAGE_SYNC_REQUIRED_CODES = new Set([
  "login_required",
  "template_missing",
  "template_invalid",
  "template_mismatch",
  "session_incomplete",
]);

export function createSyncRecovery() {
  // A reconnect can observe an already-running incremental job, so keep the
  // initial recovery opportunity until a matching error is actually seen.
  let fallbackAvailable = true;

  return {
    begin(incremental: boolean) {
      fallbackAvailable = incremental;
    },
    takeFallback(status: Pick<CollectorStatus, "state" | "code">): boolean {
      if (!fallbackAvailable || status.state !== "error" || !PAGE_SYNC_REQUIRED_CODES.has(status.code ?? "")) {
        return false;
      }
      fallbackAvailable = false;
      return true;
    },
  };
}
