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

// 应用内登录的网页藏在后台：把抖音登录框里的二维码和盖在上面的提示（扫码成功、已失效之类）读给工作台显示。
// 密码或验证码登录后抖音可能弹「使用原设备扫码」的二次验证，那张码优先；二次验证不是扫码时把窗口亮出来让用户自己做。
// 抖音大约一分钟自己换一张码；真显示「已失效 / 点击刷新」时顺手点一下
export async function readLoginQrCode(page) {
  if (!page || page.isClosed()) return null;
  const value = await page.evaluate(() => {
    const verify = document.querySelector("#uc-second-verify");
    const container = verify ? verify.querySelector("#uc_verification_animate_qrcode_container")
      : document.querySelector("#douyin_login_comp_scan_code #animate_qrcode_container");
    const image = container?.querySelector('img[aria-label="二维码"]')?.getAttribute("src");
    if (!image) return verify ? { verifyWithoutCode: true } : null;
    const state = container.innerText.split(/\n+/u).map(line => line.trim()).filter(line => line && line !== "如何扫码").join(" ");
    if (/失效|过期|刷新/u.test(state)) [...container.querySelectorAll("*")].reverse().find(element => /刷新/u.test(element.textContent))?.click();
    const title = verify ? ["title", "desc"].map(name => verify.querySelector(`[class*=${name}]`)?.innerText.trim()).filter(Boolean).join("：") : "";
    return { image, hint: title || state, verify: Boolean(verify) };
  }).catch(() => null);
  if (value?.verifyWithoutCode) { page.reveal?.(); return null; }
  if (!value || typeof value.image !== "string" || value.image.length > 200_000
    || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value.image)) return null;
  return { image: value.image, hint: typeof value.hint === "string" ? value.hint.slice(0, 60) : "", verify: value.verify === true };
}
