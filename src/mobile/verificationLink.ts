import { isDouyinPage } from "./proofData";

export const VERIFICATION_PAGE = "https://api.amemv.com/ucenter_web/app/aweme/scan_login/index/douyin_scan_code_login/cn/app/index.html";
export const VERIFICATION_ERRORS: Record<string, string> = {
  missing: "当前没有身份验证二维码。请先在下方网页完成登录步骤。",
  expired: "二维码已失效，请在官方网页刷新后重试。",
  unsupported: "系统 WebView 暂不支持识别二维码，请更新 Android System WebView 后重试。",
  invalid: "未识别到支持的抖音身份验证链接，请使用官方网页提供的其他验证方式。",
  timeout: "识别超时，请等待二维码加载完成后重试。",
};

export function isVerificationLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}` === VERIFICATION_PAGE && !url.username && !url.password && !url.hash
      && url.searchParams.getAll("token").length === 1 && Boolean(url.searchParams.get("token"))
      // The official QR observed on-device includes an empty verify_ticket.
      && url.searchParams.getAll("verify_ticket").length <= 1;
  } catch { return false; }
}

// Bind to the installed Lite app's exported deep-link handler. An implicit scheme
// could hand this short-lived verification link to another installed application.
export function verificationIntent(link: string) {
  if (!isVerificationLink(link)) throw new Error(VERIFICATION_ERRORS.invalid);
  return {
    packageName: "com.ss.android.ugc.aweme.lite",
    className: "com.ss.android.ugc.aweme.app.DeepLinkHandlerActivity",
    data: `snssdk2329://webview?url=${encodeURIComponent(link)}`,
    category: "android.intent.category.BROWSABLE",
  };
}

export function parseVerificationMessage(message: Record<string, unknown>, source: string, requestId: string | null) {
  if (!requestId || message.requestId !== requestId || !isDouyinPage(source)) return null;
  if (message.type === "verification-error") {
    const code = typeof message.code === "string" && Object.hasOwn(VERIFICATION_ERRORS, message.code) ? message.code : "invalid";
    return { error: VERIFICATION_ERRORS[code]!, link: null };
  }
  if (message.type !== "verification-link") return null;
  return isVerificationLink(message.link)
    ? { error: null, link: message.link }
    : { error: VERIFICATION_ERRORS.invalid!, link: null };
}
