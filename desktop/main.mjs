import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, session, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, writeFileSync } from "node:fs";
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
const ICON_PATH = path.join(projectDirectory, "build", "icon.png");
// 抖音网页只给最近一段观看历史，几天不开就会断档；托盘里隔几个小时读一次把它接上
const BACKGROUND_SYNC_MS = 3 * 60 * 60 * 1000;
// Windows 的开机启动项靠这个参数认出自己，读写登录项设置时也要带同一组参数
const HIDDEN_ARG = "--hidden";
const LOGIN_ITEM = { args: [HIDDEN_ARG] };

let mainWindow = null;
let desktopRuntime = null;
let appUpdateController = null;
let updateInstallRequested = false;
let shutdownStarted = false;
let quitting = false;
let tray = null;
let backgroundBlockedNotified = false;
// 后台启动时窗口还没建好就被点了图标，建好后要直接显示
let showRequested = false;
// 这次是不是开机后台启动：窗口还没 show/hide 过时，页面问「窗口在不在屏幕上」按它回答
let launchedHidden = false;
// 通知对象被回收后点它就没反应了，显示期间留着引用
const liveNotifications = new Set();
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
    icon: ICON_PATH,
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

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showRequested = true;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  syncWindowVisibility(mainWindow);
}

function isOnScreen(window) {
  return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
}

// 窗口收进托盘后页面的 visibilityState 不一定会变，直接告诉页面窗口在不在屏幕上。
// macOS 的 show/hide 事件跟着遮挡状态走：被盖住时会多发，被盖住后再收起又不发，
// 所以收起、叫回时自己同步一次，并且只在真变了的时候才发
let lastOnScreen = null;
function syncWindowVisibility(window) {
  if (window.isDestroyed()) return;
  const onScreen = isOnScreen(window);
  if (onScreen === lastOnScreen) return;
  lastOnScreen = onScreen;
  if (onScreen) backgroundBlockedNotified = false; // 用户看到窗口了，下次再出问题还要提醒
  window.webContents.send("desktop:window-visibility", onScreen);
}

function showNotification(body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: APP_NAME, body });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on("click", () => { release(); showMainWindow(); });
  notification.on("close", release);
  notification.on("failed", release);
  notification.show();
}

function requestBackgroundSync({ manual = false } = {}) {
  // 读不读由页面决定：它知道有没有连接、是不是正在下载，和窗口可见时的自动读取走同一套判断；
  // 托盘里手动点的那次不受「自动补读」开关限制
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:background-sync", { manual });
}

// 第一次关窗时说一声还在托盘里，不然会以为关不掉或者已经退出了
function noticeTrayOnce() {
  const marker = path.join(app.getPath("userData"), "tray-notice-shown");
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, "");
  } catch {
    return;
  }
  showNotification(`窗口收进${process.platform === "darwin" ? "菜单栏" : "托盘"}了，应用还在后台补读新记录。要完全退出，在图标菜单里点「退出」。`);
}

function openedAtLogin() {
  return process.argv.includes(HIDDEN_ARG)
    || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  const buildMenu = () => Menu.buildFromTemplate([
    { label: "打开工作台", click: showMainWindow },
    { label: "现在读取一次新记录", click: () => requestBackgroundSync({ manual: true }) },
    { type: "separator" },
    {
      label: "开机后在后台运行",
      type: "checkbox",
      checked: app.getLoginItemSettings(LOGIN_ITEM).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: item.checked });
        tray?.setContextMenu(buildMenu());
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(buildMenu());
  // macOS 点图标本来就弹菜单；Windows 习惯左键直接打开窗口
  if (process.platform === "win32") tray.on("click", showMainWindow);
}

function createMainWindow(appUrl, { hidden = false } = {}) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: ICON_PATH,
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
  if (!hidden) window.once("ready-to-show", () => window.show());
  for (const event of ["show", "hide", "minimize", "restore"]) window.on(event, () => syncWindowVisibility(window));
  const hideToTray = () => {
    window.hide();
    syncWindowVisibility(window);
  };
  // 关窗只是收进托盘，后台读取和聊天接收接着跑；真正退出走托盘菜单或 ⌘Q
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    // macOS 全屏时直接隐藏会留下一整块黑屏，先退出全屏再收起来
    if (window.isFullScreen()) {
      window.once("leave-full-screen", hideToTray);
      window.setFullScreen(false);
    } else {
      hideToTray();
    }
    noticeTrayOnce();
  });
  // Windows 关机、重启、注销时不能拦着关窗
  window.on("session-end", () => { quitting = true; });
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
  if (updater && process.platform === "win32") {
    // 国内直连 GitHub 下一百多兆的安装包经常断。版本信息和 sha512 仍从 GitHub
    // 直连读取，只把安装包改走加速线路，下完 electron-updater 会按 sha512 校验。
    // ponytail: 写死一条第三方线路，失效就换成 docs/index.html 里的下一条
    session.fromPartition("electron-updater", { cache: false }).webRequest.onBeforeRequest(
      { urls: ["https://github.com/ZhangYukwiver/DouyinDataReview/releases/download/*"] },
      ({ url }, callback) => callback(url.endsWith(".exe") ? { redirectURL: `https://gh-proxy.com/${url}` } : {}),
    );
  }
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
      ? () => openExternalUrl("https://zhangyukwiver.github.io/DouyinDataReview/")
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
  // 正常启动时页面挂载比窗口 show() 早，这时直接看 isVisible() 会答「不可见」，被当成后台启动
  ipcMain.handle("desktop:is-window-visible", () => lastOnScreen ?? !launchedHidden);
  // 后台读取碰到要重新登录、要可见浏览器的情况，不替用户弹浏览器，只提醒一次，等用户打开窗口再处理
  ipcMain.on("desktop:background-sync-blocked", (_event, message) => {
    if (isOnScreen(mainWindow) || backgroundBlockedNotified) return;
    backgroundBlockedNotified = true;
    showNotification(typeof message === "string" && message.trim() ? message.trim() : "后台读取暂停了，打开工作台看看。");
  });
  launchedHidden = openedAtLogin() && !showRequested;
  mainWindow = createMainWindow(desktopRuntime.web.url, { hidden: launchedHidden });
  createTray();
  // ponytail: 醒着时按固定间隔触发，睡眠唤醒后补一次，不记上次读取时间。平时多读一次只是增量；
  // 上一轮观看历史被打断过的话这一轮会整段重读（约等于第一次读的量），要省就记下中断时存的新记录只跳过它们
  setInterval(() => requestBackgroundSync(), BACKGROUND_SYNC_MS);
  powerMonitor.on("resume", () => setTimeout(() => requestBackgroundSync(), 60_000));
  appUpdateController.start();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  // macOS 点程序坞图标把收进托盘的窗口叫回来
  app.on("activate", showMainWindow);

  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : "应用启动失败。");
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownStarted || !desktopRuntime) return;
  event.preventDefault();
  shutdownStarted = true;
  appUpdateController?.dispose();
  void stopDesktopRuntime().finally(() => {
    if (updateInstallRequested) app.quit();
    else app.exit(0);
  });
});
