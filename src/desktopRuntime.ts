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
  manualDownload: boolean;
}

interface DesktopRuntimeBridge {
  getCollectorConfig(): Promise<unknown>;
  getAppUpdateState(): Promise<unknown>;
  checkForAppUpdates(): Promise<unknown>;
  downloadAppUpdate(): Promise<unknown>;
  installAppUpdate(): Promise<unknown>;
  onAppUpdateState(listener: (value: unknown) => void): () => void;
  onBackgroundSync(listener: (manual: boolean) => void): () => void;
  isWindowVisible(): Promise<unknown>;
  onWindowVisibility(listener: (visible: boolean) => void): () => void;
  notifyBackgroundSyncBlocked(message: string): void;
  // 比上面晚加的：旧版外壳没有这两个，用前先看在不在
  getOpenAtLogin?(): Promise<unknown>;
  setOpenAtLogin?(enabled: boolean): Promise<unknown>;
  takeInstallChoice?(): Promise<unknown>;
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
    manualDownload: candidate.manualDownload === true,
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

export function isDesktopApp(): boolean {
  return getDesktopRuntime() !== null;
}

/** 托盘里的定时读取（manual = 用户在托盘菜单里点的）：只有桌面版有，浏览器里打开时什么也不做 */
export function subscribeDesktopBackgroundSync(listener: (manual: boolean) => void): () => void {
  const unsubscribe = getDesktopRuntime()?.onBackgroundSync(listener);
  return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
}

let desktopWindowHidden = false;

/** 桌面版窗口收在托盘里（开机后台启动时一开始就是）；浏览器里打开时恒为 false */
export function isDesktopWindowHidden(): boolean {
  return desktopWindowHidden;
}

export function trackDesktopWindowVisibility(onShow: () => void, onHiddenStart: () => void): () => void {
  const runtime = getDesktopRuntime();
  if (!runtime) return () => undefined;
  void runtime.isWindowVisible().then((visible) => {
    desktopWindowHidden = visible === false;
    if (desktopWindowHidden) onHiddenStart();
  }, () => undefined);
  return runtime.onWindowVisibility((visible) => {
    desktopWindowHidden = !visible;
    if (visible) onShow();
  });
}

export function notifyDesktopBackgroundSyncBlocked(message: string): void {
  getDesktopRuntime()?.notifyBackgroundSyncBlocked(message);
}

/** 「开机后在后台运行」现在开没开；浏览器里、旧版外壳或不支持登录项的系统上是 null（设置面板就不显示这一行） */
export async function getDesktopOpenAtLogin(): Promise<boolean | null> {
  const runtime = getDesktopRuntime();
  if (typeof runtime?.getOpenAtLogin !== "function") return null;
  try {
    const value = await runtime.getOpenAtLogin();
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** 打开或关掉「开机后在后台运行」，答的是改完以后系统里实际的状态；没改成或没有这个接口时是 null */
export async function setDesktopOpenAtLogin(enabled: boolean): Promise<boolean | null> {
  const runtime = getDesktopRuntime();
  if (typeof runtime?.setOpenAtLogin !== "function") return null;
  try {
    const value = await runtime.setOpenAtLogin(enabled);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** 安装时选没选「视频解析」（Windows 安装向导勾选、Mac 第一次打开时问）；只在装完第一次打开时有，之后和浏览器里是 null */
export async function takeDesktopAnalysisChoice(): Promise<boolean | null> {
  const runtime = getDesktopRuntime();
  if (typeof runtime?.takeInstallChoice !== "function") return null;
  try {
    const value = await runtime.takeInstallChoice() as { analysis?: unknown } | null;
    return typeof value?.analysis === "boolean" ? value.analysis : null;
  } catch {
    return null;
  }
}
