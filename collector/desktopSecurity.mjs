import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DirectHistoryError } from "./directHistory.mjs";
import { directCryptCookieFingerprint, directSessionFingerprint, validateDirectCredentials } from "./directCredentials.mjs";

// 收发私信要的 ticket-guard 材料，抖音电脑客户端自己也存着：
// - 私钥、client_cert、服务端证书、dtrait 公钥在 Local Storage 的 security-sdk/* 里
// - ticket / ts_sign 是每次登录轮换的，最新一份在 IndexedDB 里
// 两处都是 leveldb，值可能落在 snappy 压缩的 SSTable 块里，所以要解压再按 encoding 解码。

const LOGIN_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"];
const validMsToken = (value) => /^[A-Za-z0-9+/_=-]{100,1024}$/u.test(value ?? "");

// 部分客户端不落盘 msToken；从同设备近期缓存请求 URL 补读，不扫描响应正文。
function readCachedMsToken(directory, cookies, createdAt) {
  const uifid = cookies.find((cookie) => cookie.name === "UIFID")?.value;
  if (!uifid) return "";
  const root = path.join(directory, "Cache", "Cache_Data");
  let files;
  try { files = readdirSync(root).filter((name) => /^[a-f0-9]{16}_0$/u.test(name)); } catch { return ""; }
  const cutoff = Math.max(Date.now() - 2 * 60 * 60_000, (Number(createdAt) || 0) * 1000);
  let latest = cutoff, token = "";
  for (const name of files) {
    let fd;
    try {
      const file = path.join(root, name), modified = statSync(file).mtimeMs;
      if (modified <= latest) continue;
      fd = openSync(file, "r");
      const header = Buffer.alloc(24);
      if (readSync(fd, header, 0, 24, 0) !== 24 || header.subarray(0, 8).toString("hex") !== "305c72a71b6dfbfc" || header.readUInt32LE(8) !== 5) continue;
      const length = header.readUInt32LE(12);
      if (!length || length > 16_384) continue;
      const key = Buffer.alloc(length);
      if (readSync(fd, key, 0, length, 24) !== length) continue;
      const url = new URL(key.toString("utf8").match(/https:\/\/[^\u0000]+$/u)?.[0] ?? "");
      if (!["www.douyin.com", "www-hj.douyin.com"].includes(url.hostname) || url.username || url.password || url.hash
        || url.searchParams.get("aid") !== "6383" || url.searchParams.get("uifid") !== uifid) continue;
      const value = url.searchParams.get("msToken");
      if (validMsToken(value)) { token = value; latest = modified; }
    } catch { /* 正在写入或不同格式的缓存直接跳过。 */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return token;
}

export class DesktopSecurityError extends DirectHistoryError {
  constructor(code, message) {
    super(code, message);
    this.name = "DesktopSecurityError";
  }
}

const ascii = (byte) => byte >= 0x20 && byte <= 0x7e;

// snappy 的裸格式：先 varint 解出期望长度，再按 tag 低两位分 literal / copy
export function snappyDecompress(input) {
  let index = 0, size = 0, shift = 0;
  while (index < input.length) {
    const byte = input[index];
    index += 1;
    size += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new DesktopSecurityError("desktop_security_unsupported", "客户端存储的压缩格式认不出来。");
  }
  const output = Buffer.alloc(size);
  let cursor = 0;
  while (index < input.length) {
    const tag = input[index];
    index += 1;
    const kind = tag & 3;
    if (kind === 0) {
      let length = tag >> 2;
      if (length < 60) length += 1;
      else {
        const extra = length - 59;
        length = 0;
        for (let part = 0; part < extra; part += 1) { length += input[index] * 2 ** (8 * part); index += 1; }
        length += 1;
      }
      input.copy(output, cursor, index, index + length);
      index += length; cursor += length;
      continue;
    }
    let length, offset;
    if (kind === 1) { length = 4 + ((tag >> 2) & 0x7); offset = ((tag >> 5) << 8) | input[index]; index += 1; }
    else if (kind === 2) { length = 1 + (tag >> 2); offset = input[index] | (input[index + 1] << 8); index += 2; }
    else { length = 1 + (tag >> 2); offset = input[index] | (input[index + 1] << 8) | (input[index + 2] << 16) | (input[index + 3] << 24); index += 4; }
    if (offset === 0 || offset > cursor) throw new DesktopSecurityError("desktop_security_unsupported", "客户端存储的压缩数据不完整。");
    for (let step = 0; step < length; step += 1) { output[cursor] = output[cursor - offset]; cursor += 1; }
  }
  return output.subarray(0, cursor);
}

function readVarint(buffer, offset) {
  let value = 0, shift = 0, index = offset;
  while (index < buffer.length) {
    const byte = buffer[index];
    value += (byte & 0x7f) * 2 ** shift;
    index += 1;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
}

function readBlock(buffer, handle) {
  const raw = buffer.subarray(handle.offset, handle.offset + handle.size);
  const type = buffer[handle.offset + handle.size];
  if (type === 0) return raw;
  if (type === 1) return snappyDecompress(raw);
  throw new DesktopSecurityError("desktop_security_unsupported", "客户端存储的块压缩方式不认识。");
}

function blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - restarts * 4;
  const entries = [];
  let offset = 0, previous = Buffer.alloc(0);
  while (offset < limit) {
    const shared = readVarint(block, offset); if (!shared) break; offset = shared.next;
    const unshared = readVarint(block, offset); if (!unshared) break; offset = unshared.next;
    const valueLength = readVarint(block, offset); if (!valueLength) break; offset = valueLength.next;
    const key = Buffer.concat([previous.subarray(0, shared.value), block.subarray(offset, offset + unshared.value)]);
    offset += unshared.value;
    const value = block.subarray(offset, offset + valueLength.value);
    offset += valueLength.value;
    previous = key;
    entries.push({ key, value });
  }
  return entries;
}

// leveldb 的 SSTable：footer 里找 index block，再沿 index 读每个 data block
export function readTablePairs(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 48) return [];
  const footer = buffer.subarray(buffer.length - 48);
  const metaOffset = readVarint(footer, 0);
  const metaSize = metaOffset ? readVarint(footer, metaOffset.next) : null;
  const indexOffset = metaSize ? readVarint(footer, metaSize.next) : null;
  const indexSize = indexOffset ? readVarint(footer, indexOffset.next) : null;
  if (!indexSize) return [];
  const pairs = [];
  for (const entry of blockEntries(readBlock(buffer, { offset: indexOffset.value, size: indexSize.value }))) {
    const offset = readVarint(entry.value, 0);
    const size = offset ? readVarint(entry.value, offset.next) : null;
    if (!size) continue;
    for (const pair of blockEntries(readBlock(buffer, { offset: offset.value, size: size.value }))) pairs.push(pair);
  }
  return pairs;
}

// Local Storage 的 key 是 _<origin>\x00\x01<name>，value 首字节是编码标记
function decodeLocalStorageValue(value) {
  if (!value?.length) return null;
  const encoding = value[0];
  const body = value.subarray(1);
  if (encoding === 0) return body.toString("utf16le");
  if (encoding === 1) return body.toString("latin1");
  return null;
}

function listStorageFiles(directory) {
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter((name) => name.endsWith(".ldb") || name.endsWith(".log")).map((name) => path.join(directory, name));
}

// 同一键在多个文件里有历史副本，按出现顺序留最后写入的（文件名递增即写入顺序）
export function readLocalStorage(directory) {
  const entries = new Map();
  for (const file of listStorageFiles(directory).sort()) {
    let pairs;
    if (file.endsWith(".ldb")) { try { pairs = readTablePairs(file); } catch { continue; } }
    else pairs = readLogPairs(file);
    for (const pair of pairs) {
      const key = pair.key.toString("latin1");
      const marker = key.indexOf("\u0001");
      if (!key.startsWith("_https://") || marker === -1) continue;
      const value = decodeLocalStorageValue(pair.value);
      if (value) entries.set(`${key.slice(1, marker - 1)}|${key.slice(marker + 1)}`, value);
    }
  }
  return entries;
}

// .log 是 WriteBatch：tag(1) + varint(keyLen) + key + varint(valueLen) + value。
// 键名后面紧跟的长度字节可能正好是可打印字符，所以从最长可见串往回退，找第一个长度和编码都自洽的位置。
function readLogPairs(file) {
  const buffer = readFileSync(file);
  const pairs = [];
  const marker = Buffer.from("_https://", "latin1");
  let index = buffer.indexOf(marker);
  while (index !== -1) {
    const separator = buffer.indexOf(Buffer.from([0x00, 0x01]), index);
    if (separator > index && separator - index < 80) {
      let visibleEnd = separator + 2;
      while (visibleEnd < buffer.length && ascii(buffer[visibleEnd])) visibleEnd += 1;
      for (let keyEnd = visibleEnd; keyEnd > separator + 2; keyEnd -= 1) {
        const length = readVarint(buffer, keyEnd);
        if (!length || length.value < 2 || length.next + length.value > buffer.length) continue;
        const encoding = buffer[length.next];
        if (encoding !== 0 && encoding !== 1) continue;
        pairs.push({ key: buffer.subarray(index, keyEnd),
          value: buffer.subarray(length.next, length.next + length.value) });
        break;
      }
    }
    index = buffer.indexOf(marker, index + 1);
  }
  return pairs;
}

// IndexedDB 里存的是序列化后的字符串，密钥材料以 JSON 文本出现
export function readIndexedDbTexts(directory) {
  const texts = [];
  for (const file of listStorageFiles(directory)) {
    let size;
    try { size = statSync(file).size; } catch { continue; }
    if (size > 64 * 1024 * 1024) continue;
    if (file.endsWith(".log")) { texts.push(readFileSync(file).toString("latin1")); continue; }
    try {
      for (const pair of readTablePairs(file)) texts.push(pair.value.toString("latin1"));
    } catch { /* 读不动的块跳过 */ }
  }
  return texts;
}

const pickValue = (entries, origin, name) => {
  for (const [id, value] of entries) {
    const [entryOrigin, entryName] = id.split("|");
    if (entryOrigin === origin && entryName?.includes(name)) return value;
  }
  return null;
};

const unwrapData = (raw) => {
  if (!raw) return null;
  const outer = JSON.parse(raw);
  return typeof outer?.data === "string" ? JSON.parse(outer.data) : outer;
};

// 客户端交给接口的那一层请求签名材料，形状与「浏览器导入」导出的 security 一致
export async function readDesktopSecurity({ directory, cookies, uid, userAgent } = {}) {
  if (!directory) throw new DesktopSecurityError("desktop_security_missing", "没有找到抖音桌面端的数据目录。");
  if (!cookies?.some((cookie) => LOGIN_COOKIE_NAMES.includes(cookie.name)))
    throw new DesktopSecurityError("desktop_login_required", "抖音桌面端里还没有登录账号，先在客户端登录后再读取。");

  const storage = readLocalStorage(path.join(directory, "Local Storage", "leveldb"));
  const origin = "https://www.douyin.com";
  const crypt = unwrapData(pickValue(storage, origin, "security-sdk/s_sdk_crypt_sdk"));
  const certificate = JSON.parse(pickValue(storage, origin, "security-sdk/s_sdk_cert_key") ?? "null");
  const serverCertificate = JSON.parse(pickValue(storage, origin, "security-sdk/s_sdk_server_cert_key") ?? "null");
  const traitRaw = pickValue(storage, origin, "dtrait-sdk/s_sdk_server_cert_key");
  const trait = traitRaw ? JSON.parse(Buffer.from(traitRaw, "base64").toString("utf8")) : null;
  const traitBlob = pickValue(storage, origin, "SLARDARuc_dtrait_sdk");

  if (!crypt?.ec_privateKey || !certificate?.data)
    throw new DesktopSecurityError("desktop_security_missing", "抖音桌面端还没生成操作证书，先在客户端里打开一次抖音再试。");

  // 部分客户端不保存签名 id Cookie；此时用 ticket = hash.SHA256(登录 Cookie)
  // 和同一份客户端证书核对归属。已有签名 id 对不上时不能降级接受旧票据。
  const signIds = cookies.filter((cookie) => cookie.name === "bd_ticket_guard_ts_sign_id" && cookie.value).map((cookie) => cookie.value);
  const loginTickets = new Set(cookies.filter((cookie) => ["sessionid", "sessionid_ss", "sid_tt"].includes(cookie.name) && cookie.value)
    .map((cookie) => `hash.${createHash("sha256").update(cookie.value).digest("base64")}`));
  const candidates = [];
  try { candidates.push(unwrapData(pickValue(storage, origin, "security-sdk/s_sdk_sign_data_key/web_protect"))); }
  catch { /* Local Storage 的旧副本损坏时仍可读取 IndexedDB。 */ }
  for (const text of readIndexedDbTexts(path.join(directory, "IndexedDB", "https_www.douyin.com_0.indexeddb.leveldb"))) {
    for (const match of text.replace(/\\"/gu, "\"").matchAll(/\{[^{}]*"ticket"\s*:[^{}]*\}/gu)) {
      try { candidates.push(JSON.parse(match[0])); } catch { /* 跳过不完整的写入。 */ }
    }
  }
  const matched = candidates.filter((value) => value && /^hash\.[A-Za-z0-9+/=]+$/u.test(value.ticket ?? "")
    && /^ts\.[12]\.[A-Za-z0-9]+$/u.test(value.ts_sign ?? "") && value.client_cert === certificate.data
    && (signIds.length ? signIds.some((id) => value.ts_sign.startsWith(id)) : loginTickets.has(value.ticket)))
    .sort((left, right) => (Number(right.create_time) || 0) - (Number(left.create_time) || 0))[0];
  if (!matched)
    throw new DesktopSecurityError("desktop_security_missing", "没找到与当前登录匹配的抖音桌面端操作票据，请在客户端里重新进入一次抖音后再试。");
  const { ticket, ts_sign: tsSign } = matched;
  const msToken = [pickValue(storage, origin, "msToken"), cookies.find((cookie) => cookie.name === "msToken")?.value].find(validMsToken)
    || readCachedMsToken(directory, cookies, matched.create_time);

  const session = { version: 1, uid: String(uid ?? ""), userAgent, cookies, values: {}, requestHeaders: {} };
  const security = validateDirectCredentials({
    sessionFingerprint: directSessionFingerprint(session),
    cryptCookieFingerprint: directCryptCookieFingerprint(session),
    sdkPairVerified: false,
    privateKey: crypt.ec_privateKey, clientCert: certificate.data,
    ticket, tsSign,
    serverCert: serverCertificate?.cert ?? "", serverSn: "",
    msToken: msToken ?? "",
    csrfToken: "",
    // dtrait 的 AES 密钥用 centralRsaPub 加密，blob 是客户端缓存里的设备特征串
    dtrait: traitBlob && trait?.centralRsaPub ? { blob: traitBlob, sdkVersion: trait.urlVersion, version: trait.centralVersion,
      publicKey: Buffer.from(trait.centralRsaPub, "base64").toString("utf8") } : null,
  }, session);
  if (!security)
    throw new DesktopSecurityError("desktop_security_missing", "抖音桌面端的操作凭据和当前登录不一致，请在客户端重新进入一次抖音后再试。");
  return security;
}
