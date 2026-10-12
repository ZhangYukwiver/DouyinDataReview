// JavaScript port of Evil0ctal/Douyin_TikTok_Download_API's native A-Bogus
// (commit 4f0bed8483c35a980315d9c7b3a1d4a1119ad2b2, Apache-2.0).
// Portions Copyright (c) Evil0ctal. Modified: portable SM3 and byte operations,
// browser identity supplied by the account session. License: licenses/abogus-Apache-2.0.txt.
import { sm3Digest } from "./sm3.mjs";

const S3 = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const S4 = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const ORDER = [34,44,56,61,73,29,70,45,35,49,38,66,51,68,28,48,64,47,30,71,26,55,31,69,59,40,62,63,27,72,41,74,57,52,42,39,33,67,53,43,65,46,36,24,60,32,79,80,84,85];
const EPOCH = 1_721_836_800_000;
const bytes = (text) => {
  const out = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 255) out.push(code >>> 8); out.push(code & 255);
  }
  return out;
};
const sm3 = (value) => [...sm3Digest(value)];
const digest = (value) => sm3(sm3(`${value}dhzx`));
function rc4(key, data) {
  const box = Array.from({ length: 256 }, (_, index) => 255 - index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j * box[i] + j + key[i % key.length]) % 256;
    [box[i], box[j]] = [box[j], box[i]];
  }
  let i = 0; j = 0;
  return data.map((byte) => {
    i = (i + 1) % 256; j = (j + box[i]) % 256;
    [box[i], box[j]] = [box[j], box[i]];
    return byte ^ box[(box[i] + box[j]) % 256];
  });
}
function encode(data, table) {
  let out = "";
  for (let offset = 0; offset < data.length; offset += 3) {
    const size = Math.min(3, data.length - offset);
    const block = (data[offset] << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    for (let digit = 0; digit <= size; digit += 1) out += table[(block >>> (18 - digit * 6)) & 63];
  }
  return out + "=".repeat((4 - out.length % 4) % 4);
}
function maskPair(pair, rng, low, high) {
  const noise = Math.floor(rng() * 65535);
  low ??= noise & 255; high ??= (noise >>> 8) & 255;
  return [(low & 170) | (pair[0] & 85), (low & 85) | (pair[0] & 170),
    (high & 170) | (pair[1] & 85), (high & 85) | (pair[1] & 170)];
}

export function nativeABogus(query, { body = "", userAgent, browserInfo = "1536|742|1536|864|1536|864|1536|864|MacIntel", now = Date.now(), rng = Math.random } = {}) {
  if (!Number.isSafeInteger(now) || now < EPOCH || typeof userAgent !== "string" || !userAgent) throw new Error("invalid_signature_input");
  const info = bytes(browserInfo), tail = bytes(`${(now + 3) % 256},`);
  const fields = {24:41,26:Math.floor((now-EPOCH)/1_209_600_000),27:6,28:3,35:1,36:0,38:33,39:0,66:3,
    79:info.length & 255,80:info.length >>> 8,84:tail.length & 255,85:tail.length >>> 8};
  const little = (start, value, size) => { for (let i = 0; i < size; i += 1) fields[start+i] = Math.floor(value/2**(8*i)) % 256; };
  little(29, now, 6); little(44, 14, 4); little(40, 0, 4); little(60, now-1, 6); little(67, 6241, 4); little(71, 6383, 4);
  for (const [input, slots, indices, sentinel] of [[digest(query),[48,49,51],[9,18],[3,11,12]],
    [digest(body),[52,53,55],[10,19],[4,8,9]], [sm3(encode(rc4([0,1,14],bytes(userAgent.trim())),S3)),[56,57,59],[11,21],[5,12,13]]]) {
    fields[slots[0]] = input[indices[0]]; fields[slots[1]] = input[indices[1]];
    fields[slots[2]] = input.slice(sentinel[0]).find((item) => item !== sentinel[1]) ?? sentinel[2];
  }
  const firstVersion = maskPair([1,0],rng);
  const noise = Math.floor(rng()*240), probe = noise > 109 ? noise + noise % 2 + 1 : noise;
  const tripwire = (Math.floor(rng()*255) & 77) | 178;
  const version = [...firstVersion,...maskPair([1,0],rng,probe,tripwire)];
  const values = ORDER.map((name) => fields[name]);
  const checksum = [...version,...values].reduce((sum,item) => sum ^ item,0);
  const plain = [...values,...info,...tail,checksum];
  const ua = userAgent.toLowerCase();
  const family = ["edg","huawei","firefox","chrome","safari"].find((name) => ua.includes(name));
  const band = { edg:125,huawei:170,firefox:40,chrome:0,safari:81 }[family] ?? 210;
  const header = maskPair([3,82],rng,undefined,(band+Math.floor(rng()*40)) & 255);
  const frame = [];
  for (let offset=0;offset<plain.length;offset+=3) {
    const group = plain.slice(offset,offset+3);
    if (group.length<3) { frame.push(group[0]); if(group[1])frame.push(group[1]); continue; }
    const pad = Math.floor(rng()*1000) & 255;
    frame.push((pad&145)|(group[0]&110),(pad&66)|(group[1]&189),(pad&44)|(group[2]&211),
      (group[0]&145)|(group[1]&66)|(group[2]&44));
  }
  return encode([...header,...rc4([211],[...version,...frame])],S4);
}

export function nativeSignedUrl(value, { userAgent, body = "" } = {}) {
  const url = new URL(value);
  const query = [...url.searchParams].map(([name,item]) => `${name}=${encodeURIComponent(item)}`).join("&");
  const width = Number(url.searchParams.get("screen_width")) || 1536;
  const height = Number(url.searchParams.get("screen_height")) || 864;
  const platform = url.searchParams.get("browser_platform") || (/Windows/u.test(userAgent) ? "Win32" : "MacIntel");
  const browserInfo = `${width}|${Math.max(1,height-122)}|${width}|${height}|${width}|${height}|${width}|${height}|${platform}`;
  const signature = nativeABogus(query,{body,userAgent,browserInfo});
  return `${url.origin}${url.pathname}?${query}&a_bogus=${encodeURIComponent(signature)}`;
}
