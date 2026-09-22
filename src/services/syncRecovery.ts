import type { CollectorStatus } from "./localCollector";

// These failures require a visible browser to log in or capture a fresh template.
const PAGE_SYNC_REQUIRED_CODES = new Set([
  "login_required",
  "template_missing",
  "template_invalid",
  "template_mismatch",
  "session_incomplete",
]);

export function createSyncRecovery() {
  // Also allow recovery when reconnecting to an already running collector.
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
