export interface DesktopCollectorConfig {
  baseUrl: string;
  pairingCode: string;
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  version: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  progress: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  message: string;
  error: string | null;
  checkedAt: string | null;
}

interface DesktopRuntimeBridge {
  getCollectorConfig(): Promise<unknown>;
  getAppUpdateState(): Promise<unknown>;
  checkForAppUpdates(): Promise<unknown>;
  downloadAppUpdate(): Promise<unknown>;
  installAppUpdate(): Promise<unknown>;
  onAppUpdateState(listener: (value: unknown) => void): () => void;
}

declare global {
  interface Window {
    desktopRuntime?: DesktopRuntimeBridge;
  }
}

export async function getDesktopCollectorConfig(): Promise<DesktopCollectorConfig | null> {
  if (typeof window === "undefined" || !window.desktopRuntime) return null;
  try {
    const value = await window.desktopRuntime.getCollectorConfig();
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.baseUrl === "string" && /^\d{8}$/u.test(String(candidate.pairingCode))
      ? { baseUrl: candidate.baseUrl, pairingCode: String(candidate.pairingCode) }
      : null;
  } catch {
    return null;
  }
}

function parseDesktopUpdateState(value: unknown): DesktopUpdateState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const phases: DesktopUpdatePhase[] = ["idle", "checking", "available", "downloading", "downloaded", "up-to-date", "error", "unsupported"];
  if (typeof candidate.phase !== "string" || !phases.includes(candidate.phase as DesktopUpdatePhase)) return null;
  if (typeof candidate.currentVersion !== "string" || typeof candidate.message !== "string") return null;
  const nullableString = (key: string): string | null => typeof candidate[key] === "string" ? candidate[key] as string : null;
  const nullableNumber = (key: string): number | null => typeof candidate[key] === "number" && Number.isFinite(candidate[key]) ? candidate[key] as number : null;
  return {
    phase: candidate.phase as DesktopUpdatePhase,
    currentVersion: candidate.currentVersion,
    version: nullableString("version"),
    releaseName: nullableString("releaseName"),
    releaseDate: nullableString("releaseDate"),
    releaseNotes: nullableString("releaseNotes"),
    progress: nullableNumber("progress"),
    bytesPerSecond: nullableNumber("bytesPerSecond"),
    transferred: nullableNumber("transferred"),
    total: nullableNumber("total"),
    message: candidate.message,
    error: nullableString("error"),
    checkedAt: nullableString("checkedAt"),
  };
}

function getDesktopRuntime(): DesktopRuntimeBridge | null {
  return typeof window === "undefined" || !window.desktopRuntime ? null : window.desktopRuntime;
}

export async function getDesktopUpdateState(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.getAppUpdateState());
  } catch {
    return null;
  }
}

export function subscribeDesktopUpdateState(listener: (state: DesktopUpdateState) => void): () => void {
  const runtime = getDesktopRuntime();
  if (!runtime) return () => undefined;
  try {
    const unsubscribe = runtime.onAppUpdateState((value) => {
      const state = parseDesktopUpdateState(value);
      if (state) listener(state);
    });
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  } catch {
    return () => undefined;
  }
}

export async function checkDesktopUpdates(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.checkForAppUpdates());
  } catch {
    return null;
  }
}

export async function downloadDesktopUpdate(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.downloadAppUpdate());
  } catch {
    return null;
  }
}

export async function installDesktopUpdate(): Promise<boolean> {
  const runtime = getDesktopRuntime();
  if (!runtime) return false;
  try {
    return (await runtime.installAppUpdate()) === true;
  } catch {
    return false;
  }
}
