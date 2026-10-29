import { VERIFICATION_PAGE } from "./verificationLink";

// Only decode the official page's visible verification QR after an explicit tap.
// No camera, screenshot export, fetch, storage, or authentication confirmation.
const VERIFY = String.raw`async function(requestId, verificationPage) {
  const send = (message) => window.ReactNativeWebView.postMessage(JSON.stringify({ requestId, ...message }));
  const fail = (code) => { throw new Error(code); };
  try {
    if (window.top !== window || location.origin !== "https://www.douyin.com") fail("invalid");
    const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const images = [...document.querySelectorAll("img.uc-ui-verify_qr-verify_main_qr-img")].filter(visible);
    if (!images.length) fail("missing");
    if (images.length !== 1) fail("invalid");
    const img = images[0];
    if (img.parentElement && img.parentElement.innerText.includes("二维码失效")) fail("expired");
    if (!img.complete || !img.naturalWidth) fail("missing");
    const imageSource = img.currentSrc || img.src;
    if (typeof BarcodeDetector !== "function" || !(await BarcodeDetector.getSupportedFormats()).includes("qr_code")) fail("unsupported");
    const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(img);
    if (codes.length !== 1) fail("invalid");
    const link = codes[0].rawValue;
    if (typeof link !== "string" || link.length > 8192 || /[\s\\]/.test(link)) fail("invalid");
    const url = new URL(link);
    if (url.origin + url.pathname !== verificationPage || url.username || url.password || url.hash
      || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")
      || url.searchParams.getAll("verify_ticket").length > 1) fail("invalid");
    // Discard a decode if the QR disappeared, expired, or refreshed while awaiting it.
    if (!img.isConnected || !visible(img)) fail("missing");
    if ((img.currentSrc || img.src) !== imageSource) fail("expired");
    if (img.parentElement && img.parentElement.innerText.includes("二维码失效")) fail("expired");
    send({ type: "verification-link", link });
  } catch (error) {
    const code = error && error.message;
    send({ type: "verification-error", code: ["missing", "expired", "unsupported", "invalid"].includes(code) ? code : "invalid" });
  }
}`;

export function buildVerificationScript(requestId: string): string {
  return `(${VERIFY})(${JSON.stringify(requestId)},${JSON.stringify(VERIFICATION_PAGE)});true;`;
}
