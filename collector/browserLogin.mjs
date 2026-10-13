import { BrowserConnectionError } from "./browserConnection.mjs";
import { openLoginDialog, readLoginIdentity } from "./douyinCollector.mjs";

export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

function waitForPoll(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function waitForBrowserLogin(connection, page, hasLoginSession, {
  signal, timeoutMs = BROWSER_LOGIN_TIMEOUT_MS,
} = {}) {
  const assertOpen = () => {
    signal?.throwIfAborted();
    if (!connection.connected) throw new BrowserConnectionError("browser_disconnected", "浏览器已断开，请重新连接。");
    if (page.isClosed()) throw new BrowserConnectionError("browser_page_closed", "抖音登录页面已关闭，请重新连接浏览器。");
  };
  const deadline = Date.now() + timeoutMs;
  let prompted = false;
  while (Date.now() < deadline) {
    assertOpen();
    const identity = await readLoginIdentity(page);
    const loggedIn = identity?.uid && await hasLoginSession(connection.context, page);
    assertOpen();
    if (loggedIn) return identity;
    if (!prompted) {
      prompted = true;
      await openLoginDialog(page);
    }
    await waitForPoll(Math.min(500, Math.max(0, deadline - Date.now())), signal);
  }
  assertOpen();
  throw new BrowserConnectionError("browser_login_timeout", "等待抖音登录已超时，请重新连接，并在打开的页面完成登录或验证。");
}
