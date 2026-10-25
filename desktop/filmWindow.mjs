// 桌面版给 AI 剪辑渲染网页片段的浏览器：Electron 自己的隐藏窗口，用 webContents.debugger 说 CDP（不开远程调试端口，
// 也不用另装 Chrome）。接口同 collector/aiEdit/film/browser.mjs 的 chromeProvider：newTarget() → { send, on, close }。
// 窗口用单独的 session，不带应用和抖音的 cookie。
// 用离屏渲染：Windows 上隐藏的普通窗口不出新帧，Page.captureScreenshot 会一直等不到（10-24 远端实测卡满 30 秒）；
// 离屏窗口照常出帧，透明通道和 WebCodecs 编码两个平台都实测正常。
// 但 Windows 上画 canvas 的网页会随机截到空白帧（10-25 远端实测：60 帧透明片段只有 12 帧有画面，关掉 2D canvas 的 GPU 加速才正常），
// 所以 Windows 只在找不到 Edge / Chrome 时才用它（见 main.mjs）。

export function electronFilmProvider({ BrowserWindow, partition = "dy2-film" }) {
  const windows = new Set();
  return {
    async newTarget() {
      const window = new BrowserWindow({
        show: false, width: 640, height: 360, skipTaskbar: true,
        webPreferences: { partition, offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
      });
      window.webContents.setFrameRate(60);
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
