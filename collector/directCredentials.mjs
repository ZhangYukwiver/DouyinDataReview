import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign, randomBytes, publicEncrypt, createCipheriv, constants } from "node:crypto";
import { DirectHistoryError } from "./directHistory.mjs";

const LOGIN_NAMES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const text = (value, limit = 20_000) => typeof value === "string" && value.length <= limit && !/[\r\n]/u.test(value) ? value : "";

// Bind every security export to the account, UA and actual login Cookies. A
// refresh of msToken/CSRF Cookies does not change the login session.
export function directSessionFingerprint(session) {
  const login = (session.cookies ?? []).filter((cookie) => LOGIN_NAMES.has(cookie.name))
    .map(({ domain, path, name, value }) => [domain, path, name, value]).sort();
  return createHash("sha256").update(JSON.stringify([session.uid, session.userAgent, login])).digest("hex");
}
export function directCryptCookieFingerprint(session) {
  const cookies = (session.cookies ?? []).filter((cookie) => cookie.name === "_bd_ticket_crypt_cookie")
    .map(({ domain, path, value }) => [domain, path, value]).sort();
  return cookies.length ? createHash("sha256").update(JSON.stringify(cookies)).digest("hex") : "";
}

export function validateDirectCredentials(value, session) {
  if (!value || value.sessionFingerprint !== directSessionFingerprint(session)) return null;
  const privateKey = typeof value.privateKey === "string" && value.privateKey.length < 4_000 ? value.privateKey : "";
  let key;
  try {
    key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
  } catch { return null; }
  const ticket = text(value.ticket), tsSign = text(value.tsSign), clientCert = text(value.clientCert);
  if (!ticket || !tsSign || !clientCert) return null;
  const signIds = (session.cookies ?? []).filter((cookie) => cookie.name === "bd_ticket_guard_ts_sign_id").map((cookie) => cookie.value);
  const sdkPaired = value.sdkPairVerified === true && value.cryptCookieFingerprint
    && value.cryptCookieFingerprint === directCryptCookieFingerprint(session);
  if (signIds.length && !signIds.some((id) => tsSign.startsWith(id)) && !sdkPaired) return null;
  if (clientCert.startsWith("pub.") && !createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-65).equals(Buffer.from(clientCert.slice(4), "base64"))) return null;
  const blob = text(value.dtrait?.blob, 200_000);
  const publicKey = typeof value.dtrait?.publicKey === "string" && value.dtrait.publicKey.length < 8_000 ? value.dtrait.publicKey : "";
  const version = text(value.dtrait?.version, 40), sdkVersion = text(value.dtrait?.sdkVersion, 50);
  let dtrait = null;
  if (blob && publicKey && /^[\w.-]+$/u.test(version) && /^[\w.-]+$/u.test(sdkVersion)) {
    try { if (createPublicKey(publicKey).asymmetricKeyType === "rsa") dtrait = { blob, publicKey, version, sdkVersion }; } catch { /* incomplete export */ }
  }
  return { sessionFingerprint: value.sessionFingerprint, privateKey, ticket, tsSign, clientCert,
    sdkPairVerified: Boolean(sdkPaired), cryptCookieFingerprint: sdkPaired ? value.cryptCookieFingerprint : "",
    serverCert: typeof value.serverCert === "string" && value.serverCert.length < 20_000 ? value.serverCert : "",
    serverSn: text(value.serverSn, 200), csrfToken: text(value.csrfToken, 500), dtrait,
    msToken: /^[A-Za-z0-9+/_=-]{100,1024}$/u.test(value.msToken || "") ? value.msToken : "",
    capturedAt: text(value.capturedAt, 100) };
}

export function requireDirectCredentials(session) {
  const security = validateDirectCredentials(session.security, session);
  if (!security?.dtrait || !security.msToken) throw new DirectHistoryError("write_credentials_missing", "当前登录会话缺少配套写操作凭据，请打开登录窗口完成初始化后重试。");
  if (security.clientCert.startsWith("pub.") && !security.serverCert)
    throw new DirectHistoryError("write_credentials_missing", "当前会话缺少服务端签名证书，请重新初始化登录凭据。");
  return security;
}

function serverPublicKey(certificate) {
  const prefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d03010703420004", "hex");
  let point;
  if (certificate.startsWith("pub.")) point = Buffer.from(certificate.slice(4), "base64");
  else {
    const der = Buffer.from(certificate.replace(/-----[^-]+-----|\s/gu, ""), "base64");
    const offset = der.indexOf(prefix);
    if (offset < 0) throw new Error("invalid certificate");
    point = Buffer.concat([Buffer.from([4]), der.subarray(offset + prefix.length, offset + prefix.length + 64)]);
  }
  if (point.length !== 65 || point[0] !== 4) throw new Error("invalid certificate");
  return createPublicKey({ key: Buffer.concat([prefix.subarray(0, -1), point]), format: "der", type: "spki" });
}

// Protocol references: DouYin_Spider utils/bd_ticket.py and utils/dtrait.py.
// Each request gets a fresh timestamp and path-bound signature and trait header.
export function directSecurityHeaders(session, pathname, { signed = true, timestamp = Math.floor(Date.now() / 1000), iv = randomBytes(16), key = randomBytes(16) } = {}) {
  const security = requireDirectCredentials(session);
  const privateKey = createPrivateKey(security.privateKey);
  const point = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-65);
  const hmac = security.clientCert.startsWith("pub.");
  const headers = { "bd-ticket-guard-ree-public-key": point.toString("base64"), "bd-ticket-guard-version": "2",
    "bd-ticket-guard-web-version": security.tsSign.startsWith("ts.1") ? "1" : "2", "bd-ticket-guard-web-sign-type": hmac ? "1" : "0" };
  if (signed) {
    const content = Buffer.from(`ticket=${security.ticket}&path=${pathname}&timestamp=${timestamp}`);
    let signature;
    if (hmac) {
      const shared = diffieHellman({ privateKey, publicKey: serverPublicKey(security.serverCert) });
      const signingKey = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(32), Buffer.alloc(0), 32));
      signature = createHmac("sha256", signingKey).update(content).digest();
    } else signature = sign("sha256", content, privateKey);
    const data = { ts_sign: security.tsSign, req_content: "ticket,path,timestamp", req_sign: signature.toString("base64"), timestamp };
    if (session.cookies.some((cookie) => cookie.name === "_bd_ticket_crypt_cookie" && cookie.value)) data.t_trust = 1;
    headers["bd-ticket-guard-client-data"] = Buffer.from(JSON.stringify(data)).toString("base64");
  }
  const trait = security.dtrait;
  const encryptedKey = publicEncrypt({ key: trait.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key.toString("hex")));
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const payload = JSON.stringify({ dtrait: trait.blob, timestamp, sdkVersion: trait.sdkVersion, path: pathname });
  const encrypted = Buffer.concat([iv, cipher.update(payload, "utf8"), cipher.final()]);
  headers["x-tt-session-dtrait"] = `${trait.version}_${encryptedKey.toString("base64")}_${encrypted.toString("base64")}`;
  if (security.csrfToken) headers["x-secsdk-csrf-token"] = security.csrfToken;
  return headers;
}

// Runs only during login/session bootstrap. Observe serialization without
// altering its return value, outgoing payloads, or any verification challenge.
export function installDirectCredentialCapture() {
  if (location.origin !== "https://www.douyin.com" || globalThis.__dyCredentialCapture) return;
  const state = { trait: null };
  Object.defineProperty(globalThis, "__dyCredentialCapture", { value: state, configurable: true });
  const original = JSON.stringify;
  JSON.stringify = function (value, ...args) {
    const result = Reflect.apply(original, this, [value, ...args]);
    if (value && typeof value === "object" && typeof value.dtrait === "string" && value.dtrait.length < 200_000
      && typeof value.sdkVersion === "string" && typeof value.path === "string")
      state.trait = { blob: value.dtrait, sdkVersion: value.sdkVersion };
    return result;
  };
}

export async function readDirectCredentialMaterial() {
  if (location.origin !== "https://www.douyin.com") return null;
  const result = { ...globalThis.__dyCredentialCapture, ticket: "", tsSign: "", clientCert: "", privateKey: "" };
  const inspect = (item, depth = 0) => {
    if (depth > 4) return;
    if (typeof item === "string" && item.length < 100_000) { try { inspect(JSON.parse(item), depth + 1); } catch { /* non-JSON storage */ } return; }
    if (!item || typeof item !== "object") return;
    for (const [name, value] of Object.entries(item)) {
      if (["ticket", "ts_sign", "client_cert", "ec_privateKey"].includes(name) && typeof value === "string")
        result[{ ticket: "ticket", ts_sign: "tsSign", client_cert: "clientCert", ec_privateKey: "privateKey" }[name]] = value;
      else if (name === "data") inspect(value, depth + 1);
    }
  };
  for (const name of Object.keys(localStorage)) if (/security|ticket|crypt/iu.test(name)) inspect(localStorage.getItem(name));
  // Recent SDKs prioritize the secure store/OPFS cache over localStorage.
  // Its accessor processes the current server Cookies before returning one
  // paired key/ticket bundle. A stale localStorage copy must not win.
  try {
    const sdk = globalThis.securitySDK?.cryptoSDK;
    const keys = await sdk?.getKeysInfoWithOrigin({ certType: "header", scene: "web_protect" });
    if (keys?.sign?.ticket && keys?.crypt?.ec_privateKey) {
      result.ticket = keys.sign.ticket; result.tsSign = keys.sign.ts_sign;
      result.clientCert = keys.sign.client_cert; result.privateKey = keys.crypt.ec_privateKey;
      const check = await sdk.checkSignData({ cryptData: keys.cryptData || JSON.stringify(keys.crypt), cert: keys.cert, serverData: keys.serverData || JSON.stringify(keys.sign) });
      result.sdkPairVerified = check?.match_md5_local === "1" || check?.match_md5_iframe === "1";
      result.serverCert = typeof sdk.getServerCert === "function" ? await sdk.getServerCert() : "";
    }
  } catch { /* validate the fallback against the current login Cookies */ }
  try {
    const server = JSON.parse(localStorage.getItem("security-sdk/s_sdk_server_cert_key") || "null");
    result.serverCert ||= server?.cert || "";
    result.serverSn = String(server?.sn || "");
  } catch { /* SDK cache has not initialized */ }
  return result;
}

// 已登录的个人页不一定发出 passport 请求，设备信息也就一直不会经过捕获钩子。
// 在当前登录页面内调用同一个凭据初始化接口，让官方 SDK 完成处理后再导出。
export async function initializeDirectCredentialMaterial() {
  if (location.origin !== "https://www.douyin.com" || !globalThis.securitySDK?.cryptoSDK || !globalThis.DTraitSDK) return false;
  const cookies = Object.fromEntries(document.cookie.split(";").map(value => {
    const separator = value.indexOf("=");
    return [value.slice(0, separator).trim(), value.slice(separator + 1)];
  }));
  try {
    await fetch("/passport/ticket_guard/get_client_cert/?aid=6383&type=trait&sdk_version=1.0.0.381&is_from_ttaccountsdk=1", {
      method: "POST", credentials: "include", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded",
        "x-tt-passport-csrf-token": cookies.passport_csrf_token || cookies.passport_csrf_token_default || "" },
      body: "server_data=1&need_session_dtrait=1",
    });
  } catch { /* 保留登录/验证流程，由导出期限统一报告仍缺少的材料；不反复请求。 */ }
  return true;
}

export async function refreshDirectCsrf(api) {
  const response = await api.raw("https://www.douyin.com/service/2/abtest_config/", { method: "HEAD", allowErrorStatus: true,
    headers: { "x-secsdk-csrf-request": "1", "x-secsdk-csrf-version": "1.2.22" } });
  const token = response.headers?.["x-ware-csrf-token"]?.split(",")[1];
  if (!text(token, 500)) throw new DirectHistoryError("write_credentials_missing", "未能获取当前会话的操作令牌，请重新登录初始化后重试。");
  api.session.security.csrfToken = token;
  await api.persistSession();
  return token;
}

export async function completeDirectCredentialExport(api, material) {
  if (!material?.ticket || !material.tsSign || !material.privateKey || !material.clientCert || !material.trait?.blob)
    throw new DirectHistoryError("write_credentials_missing", "登录页面尚未提供完整操作凭据，请完成登录或验证后重试。");
  const sessionFingerprint = directSessionFingerprint(api.session);
  const cryptCookieFingerprint = directCryptCookieFingerprint(api.session);
  const url = new URL("https://www.douyin.com/passport/ticket_guard/get_client_cert/");
  url.search = new URLSearchParams({ aid: "6383", type: "trait", sdk_version: "1.0.0.381", is_from_ttaccountsdk: "1" }).toString();
  const response = await api.raw(url.toString(), { method: "POST", body: "server_data=1&need_session_dtrait=1",
    headers: { "x-tt-passport-csrf-token": api.cookie("passport_csrf_token") || api.cookie("passport_csrf_token_default"), Origin: "https://www.douyin.com" } });
  let payload;
  try { payload = JSON.parse(response.text); } catch { throw new DirectHistoryError("invalid_response", "设备凭据初始化没有返回有效响应。"); }
  const data = payload.data || {};
  const value = { sessionFingerprint, privateKey: material.privateKey,
    sdkPairVerified: material.sdkPairVerified === true, cryptCookieFingerprint,
    ticket: material.ticket, tsSign: material.tsSign, clientCert: material.clientCert,
    msToken: material.msToken || api.cookie("msToken"),
    serverCert: data.server_cert || material.serverCert || "", serverSn: data.server_sn || material.serverSn || "", capturedAt: new Date().toISOString(),
    dtrait: { blob: material.trait.blob, sdkVersion: material.trait.sdkVersion,
      publicKey: Buffer.from(data["x-tt-session-dtrait-pk1"] || "", "base64").toString("utf8"),
      version: data["x-tt-session-dtrait-pk1-version"] || "" } };
  const security = validateDirectCredentials(value, api.session);
  if (!security?.dtrait || (security.clientCert.startsWith("pub.") && !security.serverCert))
    throw new DirectHistoryError("write_credentials_missing", "配套操作凭据不完整或与当前登录不一致，请重新初始化。");
  api.session.security = security;
  await refreshDirectCsrf(api);
  requireDirectCredentials(api.session);
  return security;
}
