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
}));
