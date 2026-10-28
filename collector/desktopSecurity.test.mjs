import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DESKTOP_USER_AGENT } from "./desktopClient.mjs";
import { readDesktopSecurity, readLocalStorage, snappyDecompress } from "./desktopSecurity.mjs";

const cleanup = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });

function varint(value) {
  const bytes = [];
  let rest = value;
  do { let byte = rest & 0x7f; rest = Math.floor(rest / 128); if (rest) byte |= 0x80; bytes.push(byte); } while (rest);
  return Buffer.from(bytes);
}

// 纯 literal 的 snappy 流：varint(长度) + tag(len-1)<<2 | 0 + 原始字节
function snappyLiteral(text) {
  const body = Buffer.from(text, "latin1");
  const head = body.length < 60 ? Buffer.from([(body.length - 1) << 2]) : null;
  if (head) return Buffer.concat([varint(body.length), head, body]);
  return Buffer.concat([varint(body.length), Buffer.from([59 << 2 | 0xf0]), varint(body.length - 1), body]);
}

function logEntry(origin, name, value) {
  const key = Buffer.from(`_${origin}\u0000\u0001${name}`, "latin1");
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from(value, "latin1")]);
  return Buffer.concat([key, varint(payload.length), payload]);
}

async function clientFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-security-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, "Local Storage", "leveldb");
  const indexed = path.join(directory, "IndexedDB", "https_www.douyin.com_0.indexeddb.leveldb");
  await mkdir(storage, { recursive: true });
  await mkdir(indexed, { recursive: true });

  // 造一套自洽的 EC 密钥与证书、dtrait 的 RSA 公钥
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const point = publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const signId = "ts.2.0123456789abcdef";
  const tsSign = `${signId}${"a".repeat(80)}`;
  const ticket = "hash.ZmFrZS10aWNrZXQtdmFsdWUtdGhhdC1pcy1sb25nLWVub3VnaA==";
  const msToken = `${"m".repeat(110)}=`;

  const entries = [
    logEntry("https://www.douyin.com", "security-sdk/s_sdk_crypt_sdk", JSON.stringify({ data: JSON.stringify({ ec_privateKey: pem }) })),
    logEntry("https://www.douyin.com", "security-sdk/s_sdk_cert_key", JSON.stringify({ data: `pub.${point}` })),
    logEntry("https://www.douyin.com", "security-sdk/s_sdk_server_cert_key", JSON.stringify({ cert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" })),
    logEntry("https://www.douyin.com", "dtrait-sdk/s_sdk_server_cert_key",
      Buffer.from(JSON.stringify({ centralRsaPub: Buffer.from(rsa).toString("base64"), centralVersion: "d1", urlVersion: "1.0.29" })).toString("base64")),
    logEntry("https://www.douyin.com", "SLARDARuc_dtrait_sdk", "eyJ1c2VySWQiOiIxMjMifQ=="),
    logEntry("https://www.douyin.com", "msToken", msToken),
  ];
  await writeFile(path.join(storage, "000001.log"), Buffer.concat(entries));

  // LevelDB 的块压缩：值放在 snappy 压缩的 SSTable 里也要能读出来（这里只验证解压函数）
  await writeFile(path.join(indexed, "000002.log"),
    `x"ticket":"${ticket}","ts_sign":"${tsSign}","client_cert":"pub.${point}"}y`);
  return { directory, signId, tsSign, ticket, msToken, point };
}

const cookiesOf = (fixture) => [
  { name: "sessionid", value: "session-value", domain: ".douyin.com", path: "/" },
  { name: "bd_ticket_guard_ts_sign_id", value: fixture.signId, domain: ".douyin.com", path: "/" },
];

it("decompresses snappy literals and copy instructions", () => {
  expect(snappyDecompress(snappyLiteral("hello world")).toString("latin1")).toBe("hello world");
  // 4 字节字面量 + 一条 copy 指令（1 字节 offset、长度 6、往回 4 字节）
  const copy = Buffer.concat([varint(10), Buffer.from([(3 << 2) | 0]), Buffer.from("abcd", "latin1"),
    Buffer.from([(2 << 2) | 1, 4])]);
  expect(snappyDecompress(copy).toString("latin1")).toBe("abcdabcdab");
});

it("reads local storage keys out of a leveldb write batch", async () => {
  const fixture = await clientFixture();
  const entries = readLocalStorage(path.join(fixture.directory, "Local Storage", "leveldb"));
  const ids = [...entries.keys()].map((id) => id.split("|")[1]);
  expect(ids).toContain("security-sdk/s_sdk_crypt_sdk");
  expect(entries.get("https://www.douyin.com|security-sdk/s_sdk_cert_key")).toContain("pub.");
  expect(entries.get("https://www.douyin.com|msToken")).toBe(fixture.msToken);
});

it("assembles the ticket-guard credentials the client stores", async () => {
  const fixture = await clientFixture();
  const security = await readDesktopSecurity({ directory: fixture.directory, cookies: cookiesOf(fixture),
    uid: "607350412292247", userAgent: DESKTOP_USER_AGENT });
  expect(security).toMatchObject({ ticket: fixture.ticket, tsSign: fixture.tsSign, clientCert: `pub.${fixture.point}` });
  expect(security.privateKey).toContain("BEGIN PRIVATE KEY");
  expect(security.msToken).toBe(fixture.msToken);
  expect(security.dtrait).toMatchObject({ version: "d1", sdkVersion: "1.0.29" });
  expect(security.sessionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
});

it("refuses when the client has no login or no matching ticket", async () => {
  const fixture = await clientFixture();
  await expect(readDesktopSecurity({ directory: fixture.directory, cookies: [], uid: "1", userAgent: DESKTOP_USER_AGENT }))
    .rejects.toMatchObject({ code: "desktop_login_required" });
  // Cookie 里的签名 id 与客户端票据对不上：不能拿旧票据去签名
  await expect(readDesktopSecurity({ directory: fixture.directory, uid: "607350412292247", userAgent: DESKTOP_USER_AGENT,
    cookies: cookiesOf({ ...fixture, signId: "ts.2.deadbeef" }) }))
    .rejects.toMatchObject({ code: "desktop_security_missing" });
});
