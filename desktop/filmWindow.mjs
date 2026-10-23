// 桌面版给 AI 剪辑渲染网页片段的浏览器：Electron 自己的隐藏窗口，用 webContents.debugger 说 CDP（不开远程调试端口，
// 也不用另装 Chrome）。接口同 collector/aiEdit/film/browser.mjs 的 chromeProvider：newTarget() → { send, on, close }。
// 窗口用单独的 session，不带应用和抖音的 cookie。

export function electronFilmProvider({ BrowserWindow, partition = "dy2-film" }) {
  const windows = new Set();
  return {
    async newTarget() {
      const window = new BrowserWindow({
        show: false, width: 640, height: 360, paintWhenInitiallyHidden: true, skipTaskbar: true,
        webPreferences: { partition, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
      });
      windows.add(window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.setAudioMuted(true);
      // 先开个空白页把渲染进程起起来：空窗口直接发 CDP 命令会一直没回音
      await window.loadURL("data:text/html;charset=utf-8,").catch(() => undefined);
      const debug = window.webContents.debugger;
      debug.attach("1.3");
      const listeners = new Map();
      debug.on("message", (_event, method, params) => { for (const listener of listeners.get(method) ?? []) listener(params); });
      return {
        send: (method, params = {}) => debug.sendCommand(method, params),
        on: (method, listener) => { listeners.set(method, [...(listeners.get(method) ?? []), listener]); },
        close: async () => {
          windows.delete(window);
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
    async close() {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      windows.clear();
    },
  };
}
