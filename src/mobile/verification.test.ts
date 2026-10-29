import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isVerificationLink, parseVerificationMessage, verificationIntent, VERIFICATION_PAGE } from "./verificationLink";
import { buildVerificationScript } from "./verificationScript";

// Matches the real QR shape: the platform may leave verify_ticket empty.
const link = `${VERIFICATION_PAGE}?token=synthetic-token&verify_ticket=&source_extra=a%2Bb%26c&source=original`;

describe("same-phone verification boundary", () => {
  it("passes the original QR URL unchanged to the explicit Lite handler", () => {
    const intent = verificationIntent(link);
    expect(intent.packageName).toBe("com.ss.android.ugc.aweme.lite");
    expect(intent.className).toBe("com.ss.android.ugc.aweme.app.DeepLinkHandlerActivity");
    const target = new URL(intent.data);
    expect(target.protocol).toBe("snssdk2329:");
    expect(target.hostname).toBe("webview");
    expect([...target.searchParams.keys()]).toEqual(["url"]);
    expect(target.searchParams.get("url")).toBe(link);
  });

  it("rejects foreign URLs, altered destinations, malformed tickets, and oversized input", () => {
    for (const bad of [null, {}, "", link.replace("https:", "http:"), link.replace("api.amemv.com", "api.amemv.com.evil.test"),
      link.replace("api.amemv.com", "api.amemv.com:8443"), link.replace("api.amemv.com", "user@api.amemv.com"),
      link.replace("index.html?", "other.html?"), link + "#fragment", link + "&token=duplicate", link + "&verify_ticket=duplicate", link.replace("synthetic-token", ""),
      link.replace("token=", "missing="), link + "&extra=" + "x".repeat(8192), link + " ", link + "\\"]) {
      expect(isVerificationLink(bad)).toBe(false);
      expect(() => verificationIntent(bad as string)).toThrow();
    }
  });

  it("ignores canceled, stale, cross-origin and unrelated messages", () => {
    const message = { type: "verification-link", requestId: "current", link };
    expect(parseVerificationMessage(message, "https://www.douyin.com", "current")?.link).toBe(link);
    for (const requestId of [null, "previous"]) expect(parseVerificationMessage(message, "https://www.douyin.com", requestId)).toBeNull();
    expect(parseVerificationMessage(message, "https://api.amemv.com", "current")).toBeNull();
    expect(parseVerificationMessage({ ...message, type: "page" }, "https://www.douyin.com", "current")).toBeNull();
    expect(parseVerificationMessage({ ...message, link: "https://evil.test" }, "https://www.douyin.com", "current")?.link).toBeNull();
  });
});

type Case = { missing?: boolean; hidden?: boolean; expired?: boolean; unsupported?: boolean; noQrSupport?: boolean;
  invalid?: boolean; refresh?: boolean; duplicate?: boolean; foreignOrigin?: boolean; iframe?: boolean; detached?: boolean };
async function execute(options: Case = {}) {
  let resolveMessage!: (value: Record<string, unknown>) => void;
  const message = new Promise<Record<string, unknown>>(resolve => { resolveMessage = resolve; });
  const img = { getClientRects: () => options.hidden ? [] : [{}], complete: true, naturalWidth: 160,
    parentElement: { innerText: options.expired ? "二维码失效点击刷新" : "" }, src: "data:image/png;synthetic", isConnected: true };
  let calls = 0;
  const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (value: string) => resolveMessage(JSON.parse(value)) } };
  window.top = options.iframe ? {} : window;
  const detector = class {
    static async getSupportedFormats() { return options.noQrSupport ? [] : ["qr_code"]; }
    async detect(input: unknown) {
      expect(input).toBe(img); calls++;
      if (options.refresh) img.src = "data:image/png;refreshed";
      if (options.detached) img.isConnected = false;
      return [{ rawValue: options.invalid ? "https://evil.test" : link }];
    }
  };
  runInNewContext(buildVerificationScript("test-verify"), {
    window, location: { origin: options.foreignOrigin ? "https://evil.test" : "https://www.douyin.com" }, URL,
    document: { querySelectorAll: () => options.missing ? [] : options.duplicate ? [img, img] : [img] },
    getComputedStyle: () => ({ visibility: "visible" }), BarcodeDetector: options.unsupported ? undefined : detector,
  });
  return { message: await message, calls };
}

describe("WebView QR decoding", () => {
  it("decodes only the visible official QR without network, storage, or camera APIs", async () => {
    expect(await execute()).toEqual({ calls: 1, message: { requestId: "test-verify", type: "verification-link", link } });
  });
  it.each([
    [{ missing: true }, "missing", 0], [{ hidden: true }, "missing", 0], [{ expired: true }, "expired", 0],
    [{ unsupported: true }, "unsupported", 0], [{ noQrSupport: true }, "unsupported", 0],
    [{ invalid: true }, "invalid", 1], [{ refresh: true }, "expired", 1], [{ detached: true }, "missing", 1],
    [{ duplicate: true }, "invalid", 0], [{ foreignOrigin: true }, "invalid", 0], [{ iframe: true }, "invalid", 0],
  ] as const)("fails closed for %j", async (options, code, calls) => {
    expect(await execute(options)).toEqual({ calls, message: { requestId: "test-verify", type: "verification-error", code } });
  });
});
