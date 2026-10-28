import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { loadDirectHistoryTemplate } from "./directHistory.mjs";
import {
  DESKTOP_USER_AGENT,
  decryptDesktopCookie,
  discoverDesktopClient,
  desktopDataDirectory,
  desktopKey,
  desktopTemplateRequest,
  readDesktopCookies,
  readDesktopSession,
  readDesktopWebId,
  writeDesktopTemplate,
} from "./desktopClient.mjs";

const cleanup = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });

const KEY = Buffer.from("3364ce5eee3891e9cca916fbf5e389fb72867e78486215226152a5841bcd5299", "hex");

// 客户端写进去的是 v10：3 字节前缀 + 12 字节 nonce + 密文 + 16 字节 tag，明文前 32 字节是域哈希
function encrypt(value, host, { key = KEY, prefix = true } = {}) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const head = prefix ? createHash("sha256").update(host).digest() : Buffer.alloc(0);
  const body = Buffer.concat([cipher.update(Buffer.concat([head, Buffer.from(value, "utf8")])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, cipher.getAuthTag()]);
}

async function clientFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-desktop-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "Network"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "Network", "Cookies"));
  db.exec(`create table cookies (host_key text, name text, value text, encrypted_value blob, path text,
    expires_utc integer, is_secure integer, is_httponly integer, samesite integer)`);
  const insert = db.prepare("insert into cookies values (?,?,?,?,?,?,?,?,?)");
  // 会话 Cookie（expires_utc = 0）和带到期时间的都要认
  insert.run(".douyin.com", "sessionid", "", encrypt("session-value-32-chars-x", ".douyin.com"), "/", 0, 1, 1, -1);
  insert.run(".douyin.com", "ttwid", "", encrypt("ttwid-value", ".douyin.com"), "/", 13_469_117_729_057_546, 1, 1, -1);
  insert.run(".douyin.com", "plain", "kept-as-is", Buffer.alloc(0), "/", 0, 0, 0, 2);
  // 别的域名不能进采集器的 Cookie 罐
  insert.run(".example.com", "sessionid", "", encrypt("other-domain", ".example.com"), "/", 0, 1, 1, -1);
  // 只是后缀像抖音的域名也不行
  insert.run(".evildouyin.com", "sessionid", "", encrypt("lookalike", ".evildouyin.com"), "/", 0, 1, 1, -1);
  // 解不开的（别的密钥）直接丢掉
  insert.run(".douyin.com", "broken", "", encrypt("wrong-key", ".douyin.com", { key: randomBytes(32) }), "/", 0, 1, 1, -1);
  db.close();
  return directory;
}

it("decrypts v10 cookies and strips the host hash prefix", () => {
  expect(decryptDesktopCookie(encrypt("hello", ".douyin.com"), KEY, ".douyin.com")).toBe("hello");
  expect(decryptDesktopCookie(encrypt("legacy", ".douyin.com", { prefix: false }), KEY, ".douyin.com")).toBe("legacy");
  expect(decryptDesktopCookie(encrypt("hello", ".douyin.com"), randomBytes(32), ".douyin.com")).toBeNull();
  expect(decryptDesktopCookie(Buffer.from("v20garbage"), KEY, ".douyin.com")).toBeNull();
});

const MAC_KEY = pbkdf2Sync("keychain-password", "saltysalt", 1003, 16, "sha1");

// Mac 版写的 v10：3 字节前缀 + AES-128-CBC 密文（IV 是 16 个空格），明文同样前置域哈希
function encryptMac(value, host, key = MAC_KEY) {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const head = createHash("sha256").update(host).digest();
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(Buffer.concat([head, Buffer.from(value, "utf8")])), cipher.final()]);
}

it("reads the mac client: Cookies at the data root, CBC with a keychain-derived key", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-desktop-mac-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, "Cookies"));
  db.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer)");
  const insert = db.prepare("insert into cookies values (?,?,?,?,?,?,?,?,?)");
  insert.run(".douyin.com", "sessionid", "", encryptMac("mac-session-value", ".douyin.com"), "/", 0, 1, 1, -1);
  insert.run(".douyin.com", "broken", "", encryptMac("wrong-key", ".douyin.com", Buffer.alloc(16, 7)), "/", 0, 1, 1, -1);
  db.close();

  const calls = [];
  const key = await desktopKey(directory, { platform: "darwin",
    run: async (file, args) => { calls.push([file, ...args]); return { stdout: "keychain-password\n" }; } });
  expect(key.equals(MAC_KEY)).toBe(true);
  expect(calls).toEqual([["/usr/bin/security", "find-generic-password", "-w", "-s", "douyin Safe Storage", "-a", "douyin"]]);
  const cookies = await readDesktopCookies({ directory, key });
  expect(cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([["sessionid", "mac-session-value"]]);
  expect(await discoverDesktopClient({ directory })).toMatchObject({ available: true, loggedIn: true });
  // 用户在钥匙串弹框里点了拒绝
  await expect(desktopKey(directory, { platform: "darwin", run: async () => { throw new Error("User canceled the operation."); } }))
    .rejects.toMatchObject({ code: "desktop_key_failed" });
});

it("keeps only douyin cookies and maps them to the session shape", async () => {
  const directory = await clientFixture();
  const cookies = await readDesktopCookies({ directory, key: KEY });
  expect(cookies.map((cookie) => cookie.name).sort()).toEqual(["plain", "sessionid", "ttwid"]);
  const sessionid = cookies.find((cookie) => cookie.name === "sessionid");
  expect(sessionid).toMatchObject({ value: "session-value-32-chars-x", domain: ".douyin.com", path: "/",
    expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
  // 微秒级时间戳折算成秒；示例值在 2027 年之后
  expect(cookies.find((cookie) => cookie.name === "ttwid").expires).toBeGreaterThan(1_700_000_000);
  expect(cookies.find((cookie) => cookie.name === "plain").sameSite).toBe("Strict");
});

it("reads the webid the client page leaves in local storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-webid-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const leveldb = path.join(directory, "Local Storage", "leveldb");
  await mkdir(leveldb, { recursive: true });
  await writeFile(path.join(leveldb, "000003.log"), 'x\x00"webid":"7272714522396821031"\x00y');
  await writeFile(path.join(leveldb, "LOCK"), "ignored");
  expect(await readDesktopWebId(directory)).toBe("7272714522396821031");
  expect(await readDesktopWebId(path.join(directory, "missing"))).toBeNull();
});

it("builds a request template the direct reader itself accepts", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "dy-template-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const cookies = [{ name: "s_v_web_id", value: "verify-fp-value" }, { name: "UIFID", value: "uifid-value" }];
  expect(await writeDesktopTemplate(dataDirectory, { cookies, webid: "7272714522396821031" })).toBe(true);
  const template = await loadDirectHistoryTemplate(dataDirectory);
  expect(template.values).toMatchObject({ aid: "6383", device_platform: "webapp", webid: "7272714522396821031" });
  expect(template.headers["user-agent"]).toBe(DESKTOP_USER_AGENT);
  // verifyFp/fp/uifid 由请求里的 Cookie 带过去，模板只保留设备参数
  expect(template.parameterOrder).toEqual(expect.arrayContaining(["count", "max_cursor", "verifyFp", "fp", "uifid", "webid"]));
  const request = desktopTemplateRequest({ cookies, webid: "7272714522396821031" });
  expect(new URL(request.url()).searchParams.get("a_bogus")).toMatch(/^[A-Za-z0-9+/_=-]{64,512}$/u);
  expect(await request.headerValue("User-Agent")).toBe(DESKTOP_USER_AGENT);
  expect(await request.headerValue("accept")).toBeNull();
});

it("refuses to import when the client is not logged in or has no webid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-nologin-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "Network"), { recursive: true });
  const db = new DatabaseSync(path.join(directory, "Network", "Cookies"));
  db.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer)");
  db.prepare("insert into cookies values (?,?,?,?,?,?,?,?,?)").run(".douyin.com", "ttwid", "", encrypt("t", ".douyin.com"), "/", 0, 1, 1, -1);
  db.close();
  await expect(readDesktopSession({ directory, key: KEY, readWebId: async () => "7272714522396821031" }))
    .rejects.toMatchObject({ code: "desktop_login_required" });

  const loggedIn = await clientFixture();
  await expect(readDesktopSession({ directory: loggedIn, key: KEY, readWebId: async () => null }))
    .rejects.toMatchObject({ code: "desktop_webid_missing" });
  await expect(readDesktopSession({ directory: loggedIn, key: KEY, readWebId: async () => "7272714522396821031" }))
    .resolves.toMatchObject({ webid: "7272714522396821031", userAgent: DESKTOP_USER_AGENT });
});

it("points at the douyin client data directory per platform", () => {
  expect(desktopDataDirectory({ platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me" }))
    .toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "douyin"));
  expect(desktopDataDirectory({ platform: "darwin", env: {}, home: "/Users/me" }))
    .toBe(path.join("/Users/me", "Library", "Application Support", "抖音"));
});
