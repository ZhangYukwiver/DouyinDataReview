import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureDirectHistoryTemplate } from "./directHistory.mjs";
import { nativeSignedUrl } from "./nativeSignature.mjs";

// 抖音电脑客户端的采集来源：客户端是 Electron（8.x 起），主窗口就是 www.douyin.com，
// 登录态存在 Chromium 的 Cookie 库里。这里只读它的登录态，不驱动客户端、不开调试端口。
const runFile = promisify(execFile);
// Windows 版在 Network/Cookies；Mac 版（8.7）还放在数据目录根上
const COOKIE_FILES = [path.join("Network", "Cookies"), "Cookies"];
const LOCAL_STATE_FILE = "Local State";
const STORAGE_DIRECTORY = path.join("Local Storage", "leveldb");
// Chromium 130 起 Cookie 明文前置 32 字节 = SHA256(host_key)，解出来要先剥掉
const HOST_HASH_BYTES = 32;
// 客户端自己报的浏览器标识（Chrome 136）。本机验证过：用这份 UA 签名能通过接口身份校验。
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.59 Safari/537.36";
const SAME_SITE = { "-1": "Lax", 0: "None", 1: "Lax", 2: "Strict" };
// 观看历史模板要求的设备参数；客户端页面发的是同一套 web 参数
const WEB_PARAMETERS = {
  device_platform: "webapp", aid: "6383", channel: "channel_pc_web", pc_client_type: "1",
  version_code: "190500", version_name: "19.5.0", cookie_enabled: "true",
  screen_width: "1536", screen_height: "864", browser_language: "zh-CN", browser_platform: "Win32",
  browser_name: "Chrome", browser_version: "136.0.0.0", browser_online: "true",
  engine_name: "Blink", engine_version: "136.0.0.0", os_name: "Windows", os_version: "10",
  cpu_core_num: "12", device_memory: "8", platform: "PC", downlink: "10", effective_type: "4g",
  round_trip_time: "50",
};
const WEBID_PATTERN = /"webid"\s*:\s*"(\d{6,30})"/u;
const keyScriptPath = fileURLToPath(new URL("./desktopCookies.ps1", import.meta.url)).replace(
  `${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`,
);

export class DesktopClientError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

// 客户端的数据目录固定：Windows 是 %APPDATA%\douyin，macOS 是 ~/Library/Application Support/抖音。
// 只认这一个位置：Cookie 和密钥（或密钥的钥匙串条目）都跟着它
export function desktopDataDirectory({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "douyin");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "抖音");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "douyin");
}

async function cookieFile(directory, statFile = stat) {
  for (const name of COOKIE_FILES) {
    const file = path.join(directory, name);
    if (await statFile(file).then((value) => value.isFile(), () => false)) return file;
  }
  return null;
}

// 客户端装过、登录过就一定有数据目录；不看注册表也不启动进程
export async function discoverDesktopClient({ directory = desktopDataDirectory(), statFile = stat } = {}) {
  const available = await statFile(directory).then((value) => value.isDirectory(), () => false);
  if (!available) return { id: "desktop", label: "抖音桌面端", available: false, debugging: false, loggedIn: false };
  const cookies = Boolean(await cookieFile(directory, statFile));
  return { id: "desktop", label: "抖音桌面端", available: true, debugging: cookies, loggedIn: cookies };
}

// macOS：钥匙串「douyin Safe Storage」里的口令按 Chromium 的规则派生 AES-128 密钥。
// 第一次读会弹系统授权框，要等用户点「允许」
async function macDesktopKey(run) {
  let stdout;
  try {
    ({ stdout } = await run("/usr/bin/security", ["find-generic-password", "-w", "-s", "douyin Safe Storage", "-a", "douyin"],
      { timeout: 120_000, maxBuffer: 16 * 1024 }));
  } catch {
    throw new DesktopClientError("desktop_key_failed", "没能从钥匙串读到抖音桌面端的 Cookie 密钥。请在弹出的系统对话框里点「允许」；没弹框的话先打开客户端登录一次。");
  }
  const password = stdout.trim();
  if (!password) throw new DesktopClientError("desktop_key_failed", "钥匙串里抖音桌面端的 Cookie 密钥是空的，请先打开客户端登录一次。");
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

// Windows：Local State 里的 encrypted_key 用当前用户 DPAPI 解出 AES-256 密钥
export async function desktopKey(directory, { platform = process.platform, run = runFile } = {}) {
  if (platform === "darwin") return macDesktopKey(run);
  if (platform !== "win32")
    throw new DesktopClientError("desktop_unsupported", "抖音桌面端读取目前只支持 Windows 和 macOS 客户端。", 400);
  let stdout;
  try {
    ({ stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", keyScriptPath],
      { timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true }));
  } catch (error) {
    throw new DesktopClientError("desktop_key_failed", `没能解开抖音桌面端的 Cookie 密钥：${error?.message ?? "解密失败"}`);
  }
  const key = /^[0-9a-f]{64}$/u.test(stdout.trim()) ? Buffer.from(stdout.trim(), "hex") : null;
  if (!key) throw new DesktopClientError("desktop_key_failed", "抖音桌面端没有导出可用的 Cookie 密钥，请先打开客户端登录一次。");
  return key;
}

// v10 两种写法按密钥长度分：Windows 32 字节 = AES-256-GCM，nonce 12 字节跟随 payload，末尾 16 字节是 tag；
// macOS 16 字节 = AES-128-CBC，IV 固定是 16 个空格
export function decryptDesktopCookie(encrypted, key, hostKey) {
  const buffer = Buffer.from(encrypted ?? []);
  if (buffer.length < 3 + 16) return null;
  if (!["v10", "v11"].includes(buffer.subarray(0, 3).toString("latin1"))) return null;
  let plain;
  try {
    if (key.length === 16) {
      const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      plain = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    } else {
      const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(3, 15));
      decipher.setAuthTag(buffer.subarray(buffer.length - 16));
      plain = Buffer.concat([decipher.update(buffer.subarray(15, buffer.length - 16)), decipher.final()]);
    }
  } catch { return null; }
  const hash = createHash("sha256").update(hostKey, "utf8").digest();
  if (plain.length > HOST_HASH_BYTES && plain.subarray(0, HOST_HASH_BYTES).equals(hash))
    return plain.subarray(HOST_HASH_BYTES).toString("utf8");
  return plain.toString("utf8");
}

const cookieExpiry = (expiresUtc) => {
  const micros = Number(expiresUtc);
  // 会话 Cookie 在 Chromium 里是 0 或极大占位值
  if (!Number.isFinite(micros) || micros <= 0) return -1;
  const seconds = Math.floor(micros / 1_000_000) - 11_644_473_600;
  return seconds > 0 ? seconds : -1;
};

// 客户端跑着的时候 Cookie 库可能一时被独占，稍等再快照一次即可
async function snapshotCookies(directory, { attempts = 4, delay = 250 } = {}) {
  let lastError = null;
  for (let count = 0; count < attempts; count += 1) {
    try {
      const workspace = await mkdtemp(path.join(tmpdir(), "dy-desktop-"));
      const copy = path.join(workspace, "Cookies");
      // 两处都没有就照常报 ENOENT，落到下面的「没找到登录数据」
      await copyFile(await cookieFile(directory) ?? path.join(directory, COOKIE_FILES[0]), copy);
      return { workspace, copy };
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  if (lastError?.code === "ENOENT")
    throw new DesktopClientError("desktop_not_installed", "没有找到抖音桌面端的登录数据，请先安装并登录抖音电脑客户端。");
  throw new DesktopClientError("desktop_cookie_locked", "抖音桌面端正在写 Cookie，请稍等几秒再试，或把它退到托盘后重试。");
}

async function sqliteOpener() {
  const { DatabaseSync } = await import("node:sqlite");
  return (file) => new DatabaseSync(file, { readOnly: true });
}

// 读 Cookie 库：只留抖音域的登录态，返回 Playwright 的 Cookie 结构
export async function readDesktopCookies({ directory = desktopDataDirectory(), key, platform = process.platform, open } = {}) {
  // 先确认客户端的数据在，再解密钥：没装客户端时该报「没找到登录数据」，而不是密钥解不开
  const { workspace, copy } = await snapshotCookies(directory);
  try {
    const resolvedKey = key ?? await desktopKey(directory, { platform });
    const connect = open ?? await sqliteOpener();
    const db = connect(copy);
    let rows;
    try {
      // expires_utc 是微秒级，超出 JS 安全整数范围，取字符串再折算
      rows = db.prepare(
        "select host_key, name, value, encrypted_value, path, cast(expires_utc as text) as expires_text, is_secure, is_httponly, samesite from cookies order by host_key, name",
      ).all();
    } finally { db.close?.(); }
    const cookies = [];
    for (const row of rows) {
      const host = String(row.host_key ?? "");
      const bare = host.replace(/^\./u, "").toLowerCase();
      // 精确到 douyin.com 和它的子域，别让 evildouyin.com 这种后缀混进来
      if (bare !== "douyin.com" && !bare.endsWith(".douyin.com")) continue;
      const value = typeof row.value === "string" && row.value
        ? row.value
        : decryptDesktopCookie(row.encrypted_value, resolvedKey, host);
      if (!value || /[;\r\n]/u.test(value)) continue;
      cookies.push({
        name: String(row.name), value, domain: host, path: String(row.path || "/"),
        expires: cookieExpiry(row.expires_text), httpOnly: Number(row.is_httponly) === 1,
        secure: Number(row.is_secure) === 1, sameSite: SAME_SITE[String(row.samesite)] ?? "Lax",
      });
    }
    return cookies;
  } finally { await rm(workspace, { recursive: true, force: true }).catch(() => undefined); }
}

// webid 是请求签名的一部分，客户端页面把它放在 Local Storage 里；逐段扫 leveldb 的文本
export async function readDesktopWebId(directory, { list = readdir, read = readFile } = {}) {
  const root = path.join(directory, STORAGE_DIRECTORY);
  let names;
  try { names = await list(root); } catch { return null; }
  for (const name of names) {
    if (!/\.(?:ldb|log)$/u.test(name)) continue;
    try {
      const text = (await read(path.join(root, name))).toString("latin1");
      const webid = WEBID_PATTERN.exec(text)?.[1];
      if (webid) return webid;
    } catch { /* 正在写的文件读不到就跳过 */ }
  }
  return null;
}

const cookieValue = (cookies, name) => cookies.find((cookie) => cookie.name === name)?.value ?? "";

// 本地存的 webid 可能是旧的（新的落在 leveldb 压缩块里，按字节读不出来），点赞接口却要 webid 和当前 ttwid 配对，
// 对不上就回空响应。抖音首页 HTML 里服务端按当前 Cookie 给的 user_unique_id 就是配对的那个，网页自己发请求也用它
const USER_UNIQUE_ID_PATTERN = /user_unique_id(?:\\*"|%22)\s*(?::|%3A)\s*(?:\\*"|%22)(\d{6,30})/u;
export async function readServerWebId(cookies, { userAgent = DESKTOP_USER_AGENT, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl("https://www.douyin.com/", { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: {
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      "user-agent": userAgent, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9",
    } });
    if (!response.ok) return null;
    return USER_UNIQUE_ID_PATTERN.exec(await response.text())?.[1] ?? null;
  } catch { return null; }
}

// 观看历史模板的抓取需要一个「请求对象」：URL 带齐必需参数，UA 走客户端这份。
// 直接复用官方的模板校验和落盘逻辑，格式与浏览器导入完全一致。
export function desktopTemplateRequest({ cookies, webid, userAgent = DESKTOP_USER_AGENT }) {
  const url = new URL("https://www.douyin.com/aweme/v1/web/history/read/");
  for (const [name, value] of Object.entries(WEB_PARAMETERS)) url.searchParams.set(name, value);
  url.searchParams.set("count", "20");
  url.searchParams.set("max_cursor", "0");
  url.searchParams.set("directory", "0");
  url.searchParams.set("category", "0");
  url.searchParams.set("status", "-1");
  url.searchParams.set("webid", webid);
  for (const [name, cookie] of [["verifyFp", "s_v_web_id"], ["fp", "s_v_web_id"], ["uifid", "UIFID"]]) {
    const value = cookieValue(cookies, cookie);
    if (value) url.searchParams.set(name, value);
  }
  const signed = nativeSignedUrl(url.toString(), { userAgent });
  return {
    url: () => signed,
    headerValue: async (name) => name.toLowerCase() === "user-agent" ? userAgent
      : name.toLowerCase() === "accept-language" ? "zh-CN,zh;q=0.9" : null,
  };
}

// 用客户端这份登录态直接问接口「我是谁」：返回 uid、昵称、头像和 sec_uid
async function desktopFetch(pathname, cookies, { userAgent, query = {}, fetchImpl = fetch } = {}) {
  const url = new URL(pathname, "https://www.douyin.com");
  for (const [name, value] of Object.entries({ ...WEB_PARAMETERS, ...query })) url.searchParams.set(name, value);
  for (const [name, cookie] of [["verifyFp", "s_v_web_id"], ["fp", "s_v_web_id"], ["uifid", "UIFID"], ["msToken", "msToken"]]) {
    const value = cookieValue(cookies, cookie);
    if (value) url.searchParams.set(name, value);
  }
  const uifid = cookieValue(cookies, "UIFID");
  let response;
  try {
    response = await fetchImpl(nativeSignedUrl(url.toString(), { userAgent }), { headers: {
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      "user-agent": userAgent, accept: "application/json, text/plain, */*",
      referer: "https://www.douyin.com/", "accept-language": "zh-CN,zh;q=0.9",
      ...(uifid ? { uifid } : {}),
    } });
  } catch { throw new DesktopClientError("desktop_network_failed", "没能连上抖音接口，请检查网络后重试。"); }
  const text = await response.text();
  if (text.trim() === "blocked")
    throw new DesktopClientError("verification_required", "抖音要求安全验证，请先在桌面端里完成验证后重试。");
  if ([401, 403].includes(response.status))
    throw new DesktopClientError("desktop_login_required", "抖音桌面端的登录已失效，请在客户端重新登录。");
  if (!response.ok) throw new DesktopClientError("desktop_network_failed", `抖音接口返回 HTTP ${response.status}。`);
  try { return JSON.parse(text); }
  catch { throw new DesktopClientError("desktop_identity_failed", "抖音接口没有返回可识别的账号资料。"); }
}

export async function readDesktopIdentity(cookies, { userAgent = DESKTOP_USER_AGENT, fetchImpl } = {}) {
  if (!Array.isArray(cookies) || !cookies.length)
    throw new DesktopClientError("desktop_login_required", "抖音桌面端里还没有登录账号，先在客户端登录后再读取。");
  const payload = await desktopFetch("/aweme/v1/web/user/profile/self/", cookies, { userAgent, fetchImpl });
  const user = payload?.user;
  const uid = String(user?.uid ?? "");
  if (!/^[1-9]\d{0,29}$/u.test(uid))
    throw new DesktopClientError("desktop_login_required", "抖音桌面端的登录已失效，请在客户端重新登录。");
  const avatar = user.avatar_thumb?.url_list?.find((url) => /^https?:\/\//u.test(url)) ?? null;
  return { uid, nickname: typeof user.nickname === "string" ? user.nickname : null,
    secUid: /^MS4w[\w-]{10,200}$/u.test(user.sec_uid ?? "") ? user.sec_uid : null, avatar };
}

// 采集器要的东西：登录 Cookie、浏览器标识、webid 写进模板、以及是否拿到完整登录态
export async function readDesktopSession({
  directory = desktopDataDirectory(), platform = process.platform, key, readWebId = readDesktopWebId, serverWebId = readServerWebId,
} = {}) {
  const cookies = await readDesktopCookies({ directory, platform, key });
  if (!cookies.some((cookie) => ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"].includes(cookie.name)))
    throw new DesktopClientError("desktop_login_required", "抖音桌面端里还没有登录账号，先在客户端登录后再读取。");
  const webid = await serverWebId(cookies) ?? await readWebId(directory);
  if (!/^\d{6,30}$/u.test(webid ?? ""))
    throw new DesktopClientError("desktop_webid_missing", "抖音桌面端还没生成请求标识，先在客户端里打开一次抖音再试。");
  return { cookies, webid, userAgent: DESKTOP_USER_AGENT };
}

// 用客户端这份登录态写一份与「浏览器导入」格式完全一致的请求模板
export async function writeDesktopTemplate(dataDirectory, { cookies, webid, userAgent = DESKTOP_USER_AGENT },
  { capture = captureDirectHistoryTemplate } = {}) {
  const captured = await capture(dataDirectory, desktopTemplateRequest({ cookies, webid, userAgent }), userAgent);
  if (!captured)
    throw new DesktopClientError("desktop_template_failed", "没能从抖音桌面端的登录态生成请求参数，请重新登录客户端后重试。");
  return true;
}

export async function importDesktopCredentials({
  directory = desktopDataDirectory(), platform = process.platform, key, dataDirectory, readWebId = readDesktopWebId,
} = {}) {
  const session = await readDesktopSession({ directory, platform, key, readWebId });
  if (dataDirectory) await writeDesktopTemplate(dataDirectory, session);
  return session;
}

// 桌面端不弹浏览器窗口，也没有连接可断；这些字段让工作台照常显示「凭据已导入」
export async function ensureDesktopState({ directory = desktopDataDirectory(), mkdirDirectory = mkdir } = {}) {
  await mkdirDirectory(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  return directory;
}
