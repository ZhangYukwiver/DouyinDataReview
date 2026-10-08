import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptIndexData } from "./indexCrypto.mjs";

// 官方前端里的两组常量（见 indexCrypto.mjs），测试自己加密再解开，证明算法和填充没写错
const CURRENT = ["SjXbYTJb7zXoUToSicUL3A==", "OekMLjghRg8vlX/PemLc+Q=="];
const LEFTOVER = ["kbSjOqn9O7APLqUZxdCkTQ==", "JuhL1cOV5JH9ojzt2g2EPg=="];
const encrypt = (text, [key, iv]) => {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "base64"), Buffer.from(iv, "base64"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
};

describe("decryptIndexData", () => {
  const json = JSON.stringify({ hot_list: [{ keyword: "咖啡", hot_list: [{ datetime: "20261006", index: "4940000" }] }], BaseResp: { StatusCode: 0 } });

  it("decrypts the current key and falls back to the leftover one", () => {
    expect(decryptIndexData(encrypt(json, CURRENT))).toBe(json);
    expect(decryptIndexData(encrypt(json, LEFTOVER))).toBe(json);
  });

  it("accepts base64url without padding like the page does", () => {
    const url = encrypt(json, CURRENT).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expect(decryptIndexData(url)).toBe(json);
  });

  it("returns null for anything it cannot decrypt instead of throwing", () => {
    expect(decryptIndexData("")).toBeNull();
    expect(decryptIndexData(undefined)).toBeNull();
    expect(decryptIndexData("not base64 at all !!")).toBeNull();
    expect(decryptIndexData(Buffer.from("0123456789abcdef").toString("base64"))).toBeNull();
    // 能解开但不是 JSON 的，当成没解开
    expect(decryptIndexData(encrypt("plain words", CURRENT))).toBeNull();
  });
});
