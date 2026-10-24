import { createHash, createHmac } from "node:crypto";

// 火山引擎 OpenAPI 的 AccessKey 签名（HMAC-SHA256），照官方《签名方法》（volcengine.com/docs/6369/67269）一步步算，只用 node:crypto。
// 即梦 AI 走这个：服务 cv、地域 cn-north-1，签 content-type;host;x-content-sha256;x-date（同官方视觉 HTTP 示例）。

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text, "utf8").digest();
// RFC3986：encodeURIComponent 不编 !'()*，补上
const rfc3986 = (text) => encodeURIComponent(text).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** UTC 时间写成 YYYYMMDDTHHMMSSZ */
export const xDate = (date = new Date()) => date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");

/**
 * 算 Authorization 头。headers 是要参与签名的头（必须有 Host 和 X-Date），body 是要发出去的原文（签名和发送用同一个字符串）。
 * SK 直接当 UTF-8 字符串做 HMAC 的密钥，不做 base64 解码。
 */
export function volcSign({ method, path = "/", query, headers, body = "", accessKeyId, secretKey, region, service }) {
  const date = headers["X-Date"] ?? headers["x-date"];
  const day = date.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((key) => `${rfc3986(key)}=${rfc3986(String(query[key]))}`).join("&");
  const signed = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()]).sort(([left], [right]) => (left < right ? -1 : 1));
  const signedHeaders = signed.map(([key]) => key).join(";");
  const canonicalRequest = [method.toUpperCase(), path, canonicalQuery, signed.map(([key, value]) => `${key}:${value}\n`).join(""), signedHeaders, sha256Hex(body)].join("\n");
  const scope = `${day}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(secretKey, day), region), service), "request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return { canonicalQuery, authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** 即梦（视觉智能）的一次 POST：回 fetch 用的地址和 init。baseUrl 默认 https://visual.volcengineapi.com */
export function jimengRequest({ baseUrl, action, version = "2022-08-31", payload, accessKeyId, secretKey, date = new Date() }) {
  const url = new URL(baseUrl);
  const body = JSON.stringify(payload);
  const stamp = xDate(date);
  const contentSha = sha256Hex(body);
  const headers = { "Content-Type": "application/json", Host: url.host, "X-Content-Sha256": contentSha, "X-Date": stamp };
  const signed = volcSign({ method: "POST", path: url.pathname || "/", query: { Action: action, Version: version }, headers, body, accessKeyId, secretKey, region: "cn-north-1", service: "cv" });
  return {
    url: `${url.origin}${url.pathname || "/"}?${signed.canonicalQuery}`,
    init: { method: "POST", body, headers: { "Content-Type": "application/json", "X-Date": stamp, "X-Content-Sha256": contentSha, Authorization: signed.authorization } },
  };
}
