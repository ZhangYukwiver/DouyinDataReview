import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import electronUpdater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startCollectorServer } from "../collector/server.mjs";
import { createAppUpdateController } from "./appUpdater.mjs";
import { startStaticServer } from "./staticServer.mjs";
import { isSameOriginUrl, isStoryUrl } from "./windowPolicy.mjs";

const APP_ID = "com.zhangyukwiver.contentinsights";
const APP_NAME = "内容数据工作台";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

let mainWindow = null;
let desktopRuntime = null;
let appUpdateController = null;
let updateInstallRequested = false;
let shutdownStarted = false;
const storyWindows = new Set();

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

function openExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") void shell.openExternal(url.toString());
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function openStoryWindow(url, appUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "内容年志",
    icon: path.join(projectDirectory, "build", "icon.png"),
    webPreferences: {
      session: mainWindow.webContents.session,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  storyWindows.add(window);
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isStoryUrl(target, appUrl)) openStoryWindow(target, appUrl);
    else openExternalUrl(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (isStoryUrl(target, appUrl)) return;
    event.preventDefault();
    openExternalUrl(target);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => storyWindows.delete(window));
  void window.loadURL(url);
}

function createMainWindow(appUrl) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: path.join(projectDirectory, "build", "icon.png"),
    backgroundColor: "#F4F5F6",
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isStoryUrl(url, appUrl)) openStoryWindow(url, appUrl);
    else openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isSameOriginUrl(url, appUrl)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = null;
    for (const storyWindow of storyWindows) storyWindow.destroy();
  });
  void window.loadURL(appUrl);
  return window;
}

async function startDesktopRuntime() {
  const collector = await startCollectorServer({
    port: 0,
    dataDirectory: path.join(app.getPath("userData"), "collector"),
    signerDirectory: app.isPackaged ? path.join(process.resourcesPath, "direct-signer") : undefined,
  });
  try {
    const web = await startStaticServer({ rootDirectory: path.join(projectDirectory, "dist") });
    return { collector, web };
  } catch (error) {
    await collector.close();
    throw error;
  }
}

async function stopDesktopRuntime() {
  if (!desktopRuntime) return;
  const runtime = desktopRuntime;
  desktopRuntime = null;
  await Promise.allSettled([runtime.web.close(), runtime.collector.close()]);
}

async function launch() {
  // macOS needs an app menu for ⌘Q and ⌘C/⌘V in text fields; Windows keeps no menu bar.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  desktopRuntime = await startDesktopRuntime();
  // electron-updater must be created after Electron is ready. In development
  // we intentionally do not touch its singleton, so `npm run desktop` never
  // tries to read a missing app-update.yml.
  const updater = app.isPackaged && (process.platform === "win32" || process.platform === "darwin")
    ? electronUpdater.autoUpdater
    : null;
  appUpdateController = createAppUpdateController({
    updater,
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    emit: (state) => {
      if (state.phase === "error") updateInstallRequested = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:app-update-state", state);
    },
    openDownloadPage: process.platform === "darwin"
      ? () => openExternalUrl("https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest")
      : null,
    beforeInstall: async () => {
      // The updater schedules app.quit() only after it has accepted the
      // downloaded installer. Stop the local services from before-quit so a
      // failed installer launch leaves the current session usable.
      updateInstallRequested = true;
    },
  });
  ipcMain.handle("desktop:get-collector-config", () => ({
    baseUrl: desktopRuntime?.collector.baseUrl,
    pairingCode: desktopRuntime?.collector.getPairingCode(),
  }));
  ipcMain.handle("desktop:get-app-update-state", () => appUpdateController?.getState() ?? null);
  ipcMain.handle("desktop:check-for-app-updates", () => appUpdateController?.check() ?? null);
  ipcMain.handle("desktop:download-app-update", () => appUpdateController?.download() ?? null);
  ipcMain.handle("desktop:install-app-update", () => appUpdateController?.install() ?? false);
  mainWindow = createMainWindow(desktopRuntime.web.url);
  appUpdateController.start();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : "应用启动失败。");
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shutdownStarted || !desktopRuntime) return;
  event.preventDefault();
  shutdownStarted = true;
  appUpdateController?.dispose();
  void stopDesktopRuntime().finally(() => {
    if (updateInstallRequested) app.quit();
    else app.exit(0);
  });
});
