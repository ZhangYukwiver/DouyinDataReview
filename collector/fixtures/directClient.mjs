import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { DirectApiClient } from "../directApi.mjs";
import { directSessionFingerprint, directCryptCookieFingerprint } from "../directCredentials.mjs";
import { encodeProto, protoNumber as n, protoString as s, protoMessage as m } from "../directProto.mjs";

export const clientKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const serverKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const traitKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPoint = key=>key.export({ type: "spki", format: "der" }).subarray(-65).toString("base64");
export const testCookie = (name, value)=>({ name, value, domain: ".douyin.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
export function directSessionFixture() {
  const session = { version: 1, uid: "123", secUid: `MS4w${"x".repeat(24)}`,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    cookies: [testCookie("sessionid", "fake-session"), testCookie("UIFID", "fake-uifid"), testCookie("s_v_web_id", "verify-id"),
      testCookie("bd_ticket_guard_ts_sign_id", "marker"), testCookie("_bd_ticket_crypt_cookie", "paired")],
    values: { webid: "1234567890123456789", browser_language: "zh-CN" } };
  session.security = { sessionFingerprint: directSessionFingerprint(session), privateKey: clientKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
    clientCert: `pub.${publicPoint(clientKeys.publicKey)}`, serverCert: `pub.${publicPoint(serverKeys.publicKey)}`,
    ticket: "fake-ticket", tsSign: "ts.1.paired-ticket", sdkPairVerified: true, cryptCookieFingerprint: directCryptCookieFingerprint(session), csrfToken: "fake-csrf", msToken: "A".repeat(176),
    dtrait: { blob: "fake-device-trait", publicKey: traitKeys.publicKey.export({ type: "spki", format: "pem" }), version: "1", sdkVersion: "1.0.0.381" } };
  return session;
}
export function directApiFixture(handler) {
  const session = directSessionFixture();
  const fetch = vi.fn(async (url, options)=>{
    const result = await handler(new URL(url), options);
    return { status: ()=>result.status ?? 200, headers: ()=>result.headers || {}, dispose: async()=>{},
      body: async()=>result.buffer || Buffer.from(JSON.stringify(result.payload || {})) };
  });
  const requestFactory = { newContext: vi.fn(async options=>({ fetch, storageState: async()=>options.storageState, dispose: vi.fn(async()=>{}) })) };
  const signer = vi.fn(async url=>`${url}&a_bogus=${"A".repeat(80)}`);
  const api = new DirectApiClient(session, { requestFactory, signer });
  return { api, fetch, requestFactory, signer };
}
export const imResponse = (command, section, status = 0)=>encodeProto([n(1, command), n(2, 10001), n(3, status), s(4, "OK"), m(6, [m(command, section)])]);
export const imConversation = (id = "0:1:123:456", type = 1, extra = [])=>[
  s(1, id), n(2, "7654321098765432100"), n(3, type), s(4, "fake-conversation-ticket"), m(50, [s(5, type===1 ? "好友" : "群聊"), ...extra]),
];
export const imMessage = (id, { conversationId = "0:1:123:456", type = 1, text = "测试消息", sender = "456", time = 1_791_700_000_000_000n } = {})=>[
  s(1, conversationId), n(2, type), n(3, id), n(6, 7), n(7, sender), s(8, JSON.stringify({ text })), n(10, time),
];
