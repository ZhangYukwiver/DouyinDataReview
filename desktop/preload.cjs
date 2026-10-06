const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  getCollectorConfig: () => ipcRenderer.invoke("desktop:get-collector-config"),
  getAppUpdateState: () => ipcRenderer.invoke("desktop:get-app-update-state"),
  checkForAppUpdates: () => ipcRenderer.invoke("desktop:check-for-app-updates"),
  downloadAppUpdate: () => ipcRenderer.invoke("desktop:download-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("desktop:install-app-update"),
  onAppUpdateState: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:app-update-state", handler);
    return () => ipcRenderer.removeListener("desktop:app-update-state", handler);
  },
  onBackgroundSync: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event, options) => listener(options?.manual === true);
    ipcRenderer.on("desktop:background-sync", handler);
    return () => ipcRenderer.removeListener("desktop:background-sync", handler);
  },
  isWindowVisible: () => ipcRenderer.invoke("desktop:is-window-visible"),
  onWindowVisibility: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event, visible) => listener(visible === true);
    ipcRenderer.on("desktop:window-visibility", handler);
    return () => ipcRenderer.removeListener("desktop:window-visibility", handler);
  },
  notifyBackgroundSyncBlocked: (message) => ipcRenderer.send("desktop:background-sync-blocked", String(message ?? "")),
  getOpenAtLogin: () => ipcRenderer.invoke("desktop:get-open-at-login"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("desktop:set-open-at-login", enabled === true),
}));
