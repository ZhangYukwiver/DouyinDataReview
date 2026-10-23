import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// 把网页一帧帧画出来用的浏览器。桌面版传进来 Electron 的隐藏窗口（desktop/filmWindow.mjs），不用另装浏览器；
// 单独跑采集器（npm run collector）时用本机的 Chrome / Edge（playwright-core 启动无头模式）。
// 两边都只交出 CDP：newTarget() → { send(method, params), on(method, listener), close() }，下面的 openTab 只说 CDP。
// 等页面、画一帧、截图的做法照 openfilm 的 FilmPage（src/host.mjs，MIT）。

const READY_MS = 60_000;
const FILM_WAIT_MS = 10_000;
const FRAME_MS = 60_000;
const CAPTURE_MS = 30_000;
const IDLE_CLOSE_MS = 60_000;

export class FilmPageError extends Error {}

function inTime(work, ms, why) {
  let timer;
  const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new FilmPageError(why)), ms); });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** 本机的 Chrome / Edge / Chromium；DY2_FILM_BROWSER 可以指定。都没有回 null。 */
export function findBrowser({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const candidates = [env.DY2_FILM_BROWSER];
  if (platform === "darwin") {
    for (const root of ["/Applications", path.join(home, "Applications")]) {
      candidates.push(`${root}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${root}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`, `${root}/Chromium.app/Contents/MacOS/Chromium`);
    }
  } else if (platform === "win32") {
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"), path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return candidates.find((file) => file && exists(file)) ?? null;
}

/** 本机 Chrome / Edge 当渲染浏览器：第一次用时启动，闲置一分钟关掉。 */
export function chromeProvider({ executablePath = findBrowser(), launch } = {}) {
  let browser = null;
  let users = 0;
  let timer = null;
  const start = async () => {
    if (!executablePath) throw new FilmPageError("没找到能用来渲染网页的浏览器（Chrome 或 Edge），装一个再试，或者用桌面版应用。");
    const open = launch ?? ((options) => import("playwright-core").then(({ chromium }) => chromium.launch(options)));
    const args = ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--force-color-profile=srgb", "--ignore-gpu-blocklist",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])];
    const launched = await open({ executablePath, headless: true, args });
    launched.on?.("disconnected", () => { if (browser === pending) browser = null; });
    return launched;
  };
  let pending = null;
  return {
    async newTarget() {
      clearTimeout(timer);
      users += 1;
      try {
        browser ??= pending = start();
        const context = await (await browser).newContext();
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        let closed = false;
        return {
          send: (method, params) => cdp.send(method, params),
          on: (method, listener) => cdp.on(method, listener),
          close: async () => {
            if (closed) return;
            closed = true;
            await context.close().catch(() => undefined);
            users -= 1;
            if (!users) timer = setTimeout(() => void this.close(), IDLE_CLOSE_MS).unref?.();
          },
        };
      } catch (error) {
        users -= 1;
        browser = null;
        throw error;
      }
    },
    async close() {
      clearTimeout(timer);
      const current = browser;
      browser = null;
      await (await current?.catch(() => null))?.close().catch(() => undefined);
    },
  };
}

const evaluate = async (target, expression) => {
  const { result, exceptionDetails } = await target.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) {
    const said = exceptionDetails.exception?.description ?? exceptionDetails.text ?? "页面出错了";
    throw new FilmPageError(String(said).split("\n")[0].replace(/^Error: /u, ""));
  }
  return result?.value;
};

const wait = (target, method, ms) => new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new FilmPageError("页面一分钟都没打开")), ms);
  target.on(method, () => { clearTimeout(timer); done(); });
});

// 画一帧并等它真的上屏：页面里没等的视频跳帧也等到新画面出来，再等两帧让样式和图层画完（同 openfilm FilmPage.seek）
const SEEK = `(async (t) => {
  if (!window.film || typeof window.film.frame !== 'function') throw new Error('window.film.frame 不见了（页面重新加载了或者被换掉了）');
  window.filmHost?.time?.(t);
  await window.film.frame(t);
  window.filmHost?.settle?.(t);
  await Promise.all([...document.querySelectorAll('video')].map((v) => (v.seeking || v.readyState < 2)
    && v.networkState !== v.NETWORK_EMPTY && v.checkVisibility?.({ visibilityProperty: true }) !== false
    ? new Promise((r) => {
      const shown = () => (typeof v.requestVideoFrameCallback === 'function' ? (v.requestVideoFrameCallback(() => r()), setTimeout(r, 1000)) : r());
      v.addEventListener('seeked', shown, { once: true }); v.addEventListener('loadeddata', shown, { once: true }); setTimeout(r, 3000);
    })
    : null));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
})`;

/**
 * 打开一个网页片段（或 film.html），等 window.film 出现、ready 完成。
 * background：transparent 透明（带透明的片段）、black 黑底（成片）、不给就是页面自己的（没画的地方是白的）。
 * 回 { meta: { duration, width, height, sounds }, problems, seek(t), capture({ format, quality }), evaluate(expr), close() }。
 * plain：不是网页片段（编码页），不等 window.film。
 */
export async function openTab(provider, url, { width = 1920, height = 1080, background = null, plain = false } = {}) {
  const target = await provider.newTarget();
  const problems = [];
  const said = (text) => { if (problems.length < 20) problems.push(String(text).slice(0, 300)); };
  try {
    target.on("Runtime.exceptionThrown", (event) => said(event.exceptionDetails?.exception?.description?.split("\n")[0] ?? event.exceptionDetails?.text ?? "页面脚本出错"));
    target.on("Network.loadingFailed", (event) => {
      // 视频元素会取消区间请求，不算出错
      if (event.canceled || event.type === "Media" || event.errorText === "net::ERR_ABORTED") return;
      said(`加载失败：${event.errorText}`);
    });
    target.on("Network.responseReceived", (event) => {
      const { status, url: address } = event.response ?? {};
      if (status >= 400 && !String(address).endsWith("/favicon.ico")) said(`${status} ${String(address).replace(/^https?:\/\/[^/]+\/v1\/ai-edit\/film\/[^/]+\//u, "")}`);
    });
    await target.send("Page.enable");
    await target.send("Runtime.enable");
    await target.send("Network.enable");
    await target.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    if (background) await target.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: background === "transparent" ? 0 : 1 } });
    const loaded = wait(target, "Page.loadEventFired", READY_MS);
    await target.send("Page.navigate", { url });
    await loaded;
    // 编码页这种普通页面：开好就行
    if (plain) return { meta: { width, height }, problems, evaluate: (expression) => evaluate(target, expression), close: () => target.close() };
    const deadline = Date.now() + FILM_WAIT_MS;
    while (!(await evaluate(target, "Boolean(window.film && typeof window.film.frame === 'function')"))) {
      if (Date.now() > deadline) throw new FilmPageError(`页面 10 秒内没有定义 window.film.frame${problems.length ? `（${problems.join("；")}）` : ""}`);
      await new Promise((done) => setTimeout(done, 100));
    }
    // film.html 由 timeline 播放，片段多的时候加载慢：它报的进度在涨就一直等
    const ready = evaluate(target, `(async () => { const a = window.film; await (typeof a.ready === 'function' ? a.ready() : a.ready); await document.fonts?.ready;
      return { duration: a.duration ?? null, width: a.width ?? null, height: a.height ?? null, sounds: window.__filmSounds?.() ?? [] }; })()`);
    let last = null;
    let since = Date.now();
    for (;;) {
      const done = await Promise.race([ready.then(() => true, () => true), new Promise((go) => setTimeout(() => go(false), 1000))]);
      if (done) break;
      const progress = await inTime(evaluate(target, "window.__filmProgress?.() ?? null"), 1000, "").catch(() => null);
      if (progress != null && progress !== last) { last = progress; since = Date.now(); }
      if (Date.now() - since > READY_MS) throw new FilmPageError("页面一分钟都没准备好（film.ready 一直没完成）");
    }
    const meta = await ready.catch((error) => { throw new FilmPageError(`film.ready 出错：${error.message}`); });
    const size = { width: meta.width > 0 ? Math.round(meta.width) : width, height: meta.height > 0 ? Math.round(meta.height) : height };
    if (size.width !== width || size.height !== height) await target.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
    Object.assign(meta, size);
    return {
      meta,
      problems,
      evaluate: (expression) => evaluate(target, expression),
      async seek(t) {
        await inTime(evaluate(target, `${SEEK}(${JSON.stringify(t)})`), FRAME_MS, `画第 ${Math.round(t * 100) / 100} 秒那一帧超过一分钟`)
          .catch((error) => { throw new FilmPageError(`第 ${Math.round(t * 100) / 100} 秒：${error.message}`); });
      },
      async capture({ format = "jpeg", quality = 92 } = {}) {
        const { data } = await inTime(target.send("Page.captureScreenshot", {
          format, ...(format === "jpeg" ? { quality } : {}), clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }, fromSurface: true, optimizeForSpeed: true,
        }), CAPTURE_MS, "截图超过 30 秒没回来");
        return Buffer.from(data, "base64");
      },
      close: () => target.close(),
    };
  } catch (error) {
    await target.close();
    throw error;
  }
}

