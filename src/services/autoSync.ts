import type { CollectorState } from "./localCollector";

export interface AutoSyncGuard {
  enabled: boolean;
  connected: boolean;
  source: "collector" | "archive" | null;
  busy: boolean;
  inFlight: boolean;
  switchingAccount: boolean;
  stoppingSync: boolean;
  state: CollectorState | null;
}

const BLOCKED_STATES = new Set<CollectorState>([
  "launching_browser",
  "awaiting_login",
  "observing",
  "collecting",
]);

export function shouldAutoSync(guard: AutoSyncGuard): boolean {
  // Foreground refreshes update video records. App pauses and resumes live
  // chat reception when the refresh needs the same browser.
  return guard.enabled
    && guard.connected
    && guard.source === "collector"
    && !guard.busy
    && !guard.inFlight
    && !guard.switchingAccount
    && !guard.stoppingSync
    && !BLOCKED_STATES.has(guard.state ?? "idle");
}

export function shouldSuppressBrowserLoginAutoSync(
  pendingBrowserLogin: boolean,
  manual: boolean,
): boolean {
  return pendingBrowserLogin && !manual;
}
