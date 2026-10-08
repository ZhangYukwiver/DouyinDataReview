import { createDecipheriv } from "node:crypto";

// 抖音指数（创作者平台 creator_count 微应用）的接口，响应头带 x-encrypted 时，
// 外层 {"data":"<base64>"} 里的 data 是 AES-128-CBC + PKCS7 的密文。
// key/iv 是官方前端（count-fe）打包文件里写死的应用级常量：不随账号变，页面自己也是用同一组在浏览器里解的。
// 10-07 实抓线上用的是第一组；第二组是前端里还留着的另一组，解不开第一组时再试。
// 官方换了加密方式的话两组都会解不开——调用方要把它当成「抖音指数暂时读不了」，不要当成没有数据。
const KEYS = [
  ["SjXbYTJb7zXoUToSicUL3A==", "OekMLjghRg8vlX/PemLc+Q=="],
  ["kbSjOqn9O7APLqUZxdCkTQ==", "JuhL1cOV5JH9ojzt2g2EPg=="],
].map(([key, iv]) => [Buffer.from(key, "base64"), Buffer.from(iv, "base64")]);

/** 把密文还原成 JSON 文本；解不开返回 null。 */
export function decryptIndexData(data) {
  if (typeof data !== "string" || !data) return null;
  // 页面的解密函数同时接受 base64 和 base64url，补齐 =
  const normalized = data.replace(/-/gu, "+").replace(/_/gu, "/");
  const encrypted = Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
  if (!encrypted.length || encrypted.length % 16 !== 0) return null;
  for (const [key, iv] of KEYS) {
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      const text = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      // 用错 key 时偶尔也能凑出合法填充，所以还要看是不是 JSON 对象/数组
      if (/^\s*[{[]/u.test(text)) return text;
    } catch {
      // 换下一组
    }
  }
  return null;
}
