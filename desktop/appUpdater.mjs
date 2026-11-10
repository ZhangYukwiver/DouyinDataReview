import { DOWNLOAD_PAGE } from "../docs/downloadSources.mjs";

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 1_000;
const MAX_RELEASE_TEXT_LENGTH = 4_000;
const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);

export const UPDATE_PHASES = Object.freeze([
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "up-to-date",
  "error",
  "unsupported",
]);

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function releaseNotes(value) {
  if (typeof value === "string") return value.slice(0, MAX_RELEASE_TEXT_LENGTH);
  if (!Array.isArray(value)) return null;
  const notes = value
    .map((entry) => typeof entry === "string" ? entry : entry && typeof entry.note === "string" ? entry.note : "")
    .filter(Boolean)
    .join("\n\n");
  return notes ? notes.slice(0, MAX_RELEASE_TEXT_LENGTH) : null;
}

function releaseInfo(info) {
  if (!info || typeof info !== "object") return {};
  const candidate = info;
  return {
    version: text(candidate.version) || null,
    releaseName: text(candidate.releaseName) || null,
    releaseDate: text(candidate.releaseDate) || null,
    releaseNotes: releaseNotes(candidate.releaseNotes),
  };
}

function errorText(error) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? text(error.message)
      : text(error);
  return (message || "未知错误").replace(/\s+/gu, " ").slice(0, 320);
}

function baseState(currentVersion) {
  return {
    phase: "idle",
    currentVersion,
    version: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    message: "应用已就绪。",
    error: null,
    checkedAt: null,
    manualDownload: false,
  };
}

function scheduleUnref(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * Keeps electron-updater behind a small, testable state machine. The renderer
 * receives snapshots only; it never gets access to the updater instance.
 */
export function createAppUpdateController(options = {}) {
  const {
    updater = null,
    isPackaged = false,
    platform = process.platform,
    currentVersion = "0.0.0",
    emit = () => undefined,
    beforeInstall = async () => undefined,
    openDownloadPage = null,
    schedule = (callback, delay) => setTimeout(callback, delay),
    clearSchedule = (timer) => clearTimeout(timer),
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    now = () => new Date(),
  } = options;

  // ponytail: 只有 Windows 在应用里下载安装。Mac 没有开发者签名装不上；Linux 先和 Mac 一样提示后去下载页。
  // 要让 AppImage 自己更新，先确认打 deb 时写进 resources 的 package-type 没跟着进 AppImage（electron-updater 靠它选更新器）
  const manualDownload = platform !== "win32";
  let manualUrl = DOWNLOAD_PAGE;
  let state = { ...baseState(currentVersion), manualDownload };
  let checkPromise = null;
  let installInFlight = false;
  let timer = null;
  let disposed = false;

  const supported = Boolean(updater) && isPackaged && SUPPORTED_PLATFORMS.has(platform);
  const listeners = [];

  if (updater && supported) {
    // Keep bandwidth and restart decisions under the user's control. The
    // renderer receives an "available" state and explicitly starts download.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
  }

  function publish(patch) {
    state = { ...state, ...patch, currentVersion };
    emit({ ...state });
    return state;
  }

  function infoPatch(info) {
    return releaseInfo(info);
  }

  function on(event, listener) {
    if (!supported || !updater || typeof updater.on !== "function") return;
    updater.on(event, listener);
    listeners.push([event, listener]);
  }

  function clearTimer() {
    if (timer === null) return;
    clearSchedule(timer);
    timer = null;
  }

  function scheduleNext(delay = checkIntervalMs) {
    if (disposed || !supported || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void check();
    }, delay);
    scheduleUnref(timer);
  }

  on("checking-for-update", () => {
    publish({ phase: "checking", message: "正在检查应用更新…", error: null, progress: null });
  });
  on("checking-update-source", (source) => {
    publish({ phase: "checking", message: `正在通过 ${source} 检查更新…`, error: null });
  });
  on("update-available", (info) => {
    const details = infoPatch(info);
    manualUrl = info.manualInstallerUrl || DOWNLOAD_PAGE;
    const manual = manualDownload || Boolean(info.manualInstallerUrl);
    publish({
      ...details,
      phase: "available",
      manualDownload: manual,
      message: manual
        ? `发现新版本${details.version ? ` v${details.version}` : ""}，可手动下载安装包。`
        : details.version ? `发现新版本 v${details.version}，可以下载。` : "发现新版本，可以下载。",
      error: null,
      progress: 0,
      bytesPerSecond: null,
      transferred: 0,
      total: null,
    });
  });
  on("download-progress", (progress) => {
    const candidate = progress && typeof progress === "object" ? progress : {};
    const percent = Number.isFinite(candidate.percent) ? Math.max(0, Math.min(100, candidate.percent)) : null;
    publish({
      phase: "downloading",
      message: percent === null ? "正在下载更新。" : `正在下载更新 ${Math.round(percent)}%。`,
      progress: percent,
      bytesPerSecond: Number.isFinite(candidate.bytesPerSecond) ? candidate.bytesPerSecond : null,
      transferred: Number.isFinite(candidate.transferred) ? candidate.transferred : null,
      total: Number.isFinite(candidate.total) ? candidate.total : null,
      error: null,
    });
  });
  on("update-downloaded", (info) => {
    const details = infoPatch(info);
    publish({
      ...details,
      phase: "downloaded",
      message: details.version ? `v${details.version} 已下载，重启应用即可安装。` : "更新已下载，重启应用即可安装。",
      progress: 100,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      error: null,
    });
  });
  on("update-not-available", (info) => {
    const details = infoPatch(info);
    publish({
      ...details,
      phase: "up-to-date",
      message: "当前已经是最新版本。",
      progress: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      error: null,
      checkedAt: now().toISOString(),
    });
  });
  on("error", (error) => {
    if (checkPromise) return; // check() publishes the final failure after all sources finish.
    publish({
      phase: "error",
      message: "检查或接收更新失败。",
      error: errorText(error),
      progress: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      checkedAt: now().toISOString(),
    });
  });

  async function check() {
    if (disposed) return state;
    if (!isPackaged) return publish({ phase: "unsupported", message: "开发模式不会检查应用更新。", error: null });
    if (!SUPPORTED_PLATFORMS.has(platform)) return publish({ phase: "unsupported", message: "当前平台暂不支持自动更新。", error: null });
    if (!updater || typeof updater.checkForUpdates !== "function") {
      return publish({ phase: "unsupported", message: "当前安装包未启用自动更新。", error: null });
    }
    if (state.phase === "available" || state.phase === "downloaded" || state.phase === "downloading") return state;
    if (checkPromise) return checkPromise;

    clearTimer();
    manualUrl = DOWNLOAD_PAGE;
    publish({ ...baseState(currentVersion), phase: "checking", manualDownload, message: "正在检查应用更新…" });
    checkPromise = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then(() => state)
      .catch((error) => disposed ? state : publish({
        phase: "error",
        message: "暂时无法检查更新，可重试或手动下载。",
        manualDownload: typeof openDownloadPage === "function",
        error: errorText(error),
        checkedAt: now().toISOString(),
      }))
      .finally(() => {
        checkPromise = null;
        scheduleNext();
      });
    return checkPromise;
  }

  async function download() {
    if (disposed || !supported) return state;
    if ((state.phase === "available" || state.phase === "error") && state.manualDownload) {
      if (!openDownloadPage) return state;
      try {
        await openDownloadPage(manualUrl);
      } catch (error) {
        publish({ error: `打开下载链接失败：${errorText(error)}` });
      }
      return state;
    }
    if (state.phase !== "available" || typeof updater.downloadUpdate !== "function") return state;
    publish({ phase: "downloading", message: "正在下载更新。", error: null, progress: 0 });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      publish({ phase: "error", message: "检查或接收更新失败。", error: errorText(error), checkedAt: now().toISOString() });
    }
    return state;
  }

  async function install() {
    if (disposed || !supported || state.phase !== "downloaded" || !updater || typeof updater.quitAndInstall !== "function") return false;
    if (installInFlight) return false;
    installInFlight = true;
    try {
      await beforeInstall();
      if (disposed) return false;
      const result = updater.quitAndInstall(false, true);
      if (result === false) {
        publish({ phase: "error", message: "安装更新失败。", error: "更新安装器未能启动。" });
        return false;
      }
      return true;
    } catch (error) {
      publish({ phase: "error", message: "安装更新前无法安全关闭应用。", error: errorText(error) });
      return false;
    } finally {
      installInFlight = false;
    }
  }

  function start() {
    if (disposed) return;
    if (!isPackaged || !SUPPORTED_PLATFORMS.has(platform) || !updater) return;
    scheduleNext(initialDelayMs);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    for (const [event, listener] of listeners.splice(0)) {
      if (typeof updater?.removeListener === "function") updater.removeListener(event, listener);
    }
  }

  return {
    check,
    download,
    install,
    start,
    dispose,
    getState: () => ({ ...state }),
    isSupported: supported,
  };
}
