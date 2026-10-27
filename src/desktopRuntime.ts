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
  // 比上面晚加的：旧版外壳没有这几个，用前先看在不在
  getOpenAtLogin?(): Promise<unknown>;
  setOpenAtLogin?(enabled: boolean): Promise<unknown>;
  sendToReelLab?(request: ReelLabHandoff): Promise<unknown>;
  startExtensionDrag?(): void;
}

/** 交给拆片工坊的一条视频：jobId 是采集器里已经下好的下载任务，文件由桌面外壳复制过去 */
export interface ReelLabHandoff {
  jobId: string;
  title: string;
  author: string | null;
  url: string | null;
  description: string | null;
  durationSeconds: number | null;
}

// wakeFailed：文件已经放进收件箱，只是没能叫醒拆片工坊，用户手动打开它就能看到
export type ReelLabSendResult = { status: "sent"; wakeFailed?: boolean } | { status: "not_installed" } | { status: "failed"; message: string };

/** 拆片工坊的下载页：没装时提示用户去这里下 */
export const REELLAB_DOWNLOAD_URL = "https://github.com/ZhangYukwiver/ReelLab/releases/latest";

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

/** 能不能「送去拆片工坊」：只有带这个接口的桌面版外壳能，浏览器里打开时没有这个按钮 */
/** 桌面版才能把推荐流过滤扩展从设置页拖到浏览器扩展页 */
export function canDragDesktopExtension(): boolean {
  return typeof getDesktopRuntime()?.startExtensionDrag === "function";
}

/** 在拖动开始那一刻调用：把扩展文件夹交给系统拖放 */
export function startDesktopExtensionDrag(): void {
  getDesktopRuntime()?.startExtensionDrag?.();
}

export function canSendToReelLab(): boolean {
  return typeof getDesktopRuntime()?.sendToReelLab === "function";
}

/** 把下好的视频交给拆片工坊；没装时答 not_installed，别的问题都收成 failed，不抛错 */
export async function sendDesktopToReelLab(handoff: ReelLabHandoff): Promise<ReelLabSendResult> {
  const runtime = getDesktopRuntime();
  if (typeof runtime?.sendToReelLab !== "function") return { status: "failed", message: "只有桌面版能送去拆片工坊。" };
  try {
    const value = await runtime.sendToReelLab(handoff) as { status?: unknown; message?: unknown; wakeFailed?: unknown } | null;
    if (value?.status === "sent") return value.wakeFailed === true ? { status: "sent", wakeFailed: true } : { status: "sent" };
    if (value?.status === "not_installed") return { status: "not_installed" };
    return { status: "failed", message: typeof value?.message === "string" && value.message ? value.message : "没送过去，请稍后重试。" };
  } catch {
    return { status: "failed", message: "没送过去，请稍后重试。" };
  }
}
