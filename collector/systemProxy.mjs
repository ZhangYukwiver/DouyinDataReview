import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

// 浏览器走系统代理（Clash 这类），Node 的 fetch 不读系统代理、直连：国内直连挂在 Cloudflare 后面的中转站，
// HTTPS 握手时快时慢，慢的一次超过 10 秒就报连接超时。所以请求模型接口时跟浏览器一样走系统代理。
// 只管模型请求，抖音那边的请求不动；只认 HTTP 代理（Clash、v2rayN 的混合端口都是），SOCKS 和 PAC 不管。

const run = promisify(execFile);
const CACHE_MS = 15_000;
const LOCAL = /^(localhost|::1|(127|10)(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2})$/u;

function envProxy(env) {
  const url = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!url || !/^https?:\/\//iu.test(url)) return null;
  return { url, bypass: String(env.NO_PROXY || env.no_proxy || "").split(/[,;\s]+/u).filter(Boolean) };
}

/** Windows：`reg query` 出来的 Internet Settings。ProxyServer 是 "127.0.0.1:7897" 或 "http=…;https=…;socks=…"。 */
export function parseWindowsProxy(text) {
  const value = (name) => String(text).match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "imu"))?.[1]?.trim() ?? "";
  if (!/^0x0*1$/iu.test(value("ProxyEnable"))) return null;
  const entries = Object.fromEntries(value("ProxyServer").split(";").filter(Boolean)
    .map((part) => (part.includes("=") ? part.split("=", 2) : ["", part]).map((item) => item.trim().toLowerCase())));
  const server = entries.https || entries[""] || entries.http;
  if (!server) return null;
  return { url: /^https?:\/\//u.test(server) ? server : `http://${server}`, bypass: value("ProxyOverride").split(";").filter(Boolean) };
}

/** macOS：`scutil --proxy`。 */
export function parseMacProxy(text) {
  const field = (name) => String(text).match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "mu"))?.[1]?.trim();
  if (field("HTTPSEnable") !== "1" || !field("HTTPSProxy")) return null;
  const list = String(text).match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/u)?.[1] ?? "";
  return { url: `http://${field("HTTPSProxy")}:${field("HTTPSPort") ?? 80}`, bypass: [...list.matchAll(/^\s*\d+\s*:\s*(.+)$/gmu)].map((match) => match[1].trim()) };
}

/** 本机、局域网地址和代理设置里的例外不走代理。规则写法：example.com（含子域名）、.example.com、*.example.com、10.*、<local>（不带点的主机名）。 */
export function bypassed(hostname, bypass = []) {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (LOCAL.test(host) || host.endsWith(".local")) return true;
  return bypass.some((raw) => {
    const rule = raw.trim().toLowerCase().replace(/:\d+$/u, "");
    if (rule === "<local>") return !host.includes(".");
    const bare = rule.replace(/^\*?\./u, "");
    if (!bare.includes("*")) return host === bare || host.endsWith(`.${bare}`);
    return new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(host);
  });
}

let cached = { at: 0, value: null };

async function systemProxy() {
  if (Date.now() - cached.at < CACHE_MS) return cached.value;
  let value = envProxy(process.env);
  try {
    if (!value && process.platform === "win32") {
      value = parseWindowsProxy((await run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { timeout: 3_000, windowsHide: true })).stdout);
    } else if (!value && process.platform === "darwin") {
      value = parseMacProxy((await run("scutil", ["--proxy"], { timeout: 3_000 })).stdout);
    }
  } catch { value = null; }
  cached = { at: Date.now(), value };
  return value;
}

const agents = new Map();

// ponytail: Node 没公开走代理用的 dispatcher，借 setGlobalProxyFromEnv 造一个、马上还原全局设置，只给模型请求用。
// 依赖 undici 的全局 dispatcher 符号；Node 没有这个函数（24 以前）或造不出来时返回 null，退回直连。
function proxyAgent(url) {
  if (!agents.has(url)) {
    const key = Symbol.for("undici.globalDispatcher.1");
    const original = globalThis[key];
    let agent = null;
    try {
      const restore = http.setGlobalProxyFromEnv({ HTTP_PROXY: url, HTTPS_PROXY: url });
      agent = globalThis[key] === original ? null : globalThis[key];
      restore();
    } catch { agent = null; }
    // 代理地址格式不对时这个函数可能换了全局设置才报错，还原回去，抖音那边的请求不能被带去走代理。
    // 进程里还没用过 fetch 时原值是空的，不能写回空值（之后的 fetch 都会坏），只能靠上面的 restore
    if (original !== undefined) globalThis[key] = original;
    agents.set(url, agent);
  }
  return agents.get(url);
}

/** 请求模型接口用的 fetch：跟浏览器一样走系统代理。连接出错时在错误上记下走的代理，报错能说清楚。 */
export async function modelFetch(url, init) {
  const proxy = typeof http.setGlobalProxyFromEnv === "function" ? await systemProxy() : null;
  const agent = proxy && !bypassed(new URL(url).hostname, proxy.bypass) ? proxyAgent(proxy.url) : null;
  if (!agent) return fetch(url, init);
  try {
    return await fetch(url, { ...init, dispatcher: agent });
  } catch (error) {
    if (error instanceof TypeError) error.proxy = new URL(proxy.url).host;  // 只留主机和端口，代理账号密码不进报错
    throw error;
  }
}
