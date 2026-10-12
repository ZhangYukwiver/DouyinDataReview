// SM3 compression, ported from Evil0ctal's Apache-2.0 native sm3.py.
// Portions Copyright (c) Evil0ctal. License: licenses/abogus-Apache-2.0.txt.
// Electron's crypto build omits SM3, so keep this portable implementation.
const rot = (value, bits) => (value << (bits % 32)) | (value >>> ((32 - bits % 32) % 32));
export function sm3Digest(value) {
  const input = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const size = Math.ceil((input.length + 9) / 64) * 64;
  const padded = Buffer.alloc(size); input.copy(padded); padded[input.length] = 128;
  padded.writeBigUInt64BE(BigInt(input.length) * 8n, size - 8);
  const state = [0x7380166f,0x4914b2b9,0x172442d7,0xda8a0600,0xa96f30bc,0x163138aa,0xe38dee4d,0xb0fb0e4e];
  for (let offset = 0; offset < size; offset += 64) {
    const w = new Uint32Array(68);
    for (let i = 0; i < 16; i += 1) w[i] = padded.readUInt32BE(offset + i * 4);
    for (let i = 16; i < 68; i += 1) {
      const x = w[i-16] ^ w[i-9] ^ rot(w[i-3],15);
      w[i] = x ^ rot(x,15) ^ rot(x,23) ^ rot(w[i-13],7) ^ w[i-6];
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let j = 0; j < 64; j += 1) {
      const ss1 = rot((rot(a,12) + e + rot(j < 16 ? 0x79cc4519 : 0x7a879d8a,j)) >>> 0,7);
      const ss2 = ss1 ^ rot(a,12);
      const ff = j < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = j < 16 ? e ^ f ^ g : (e & f) | (~e & g);
      const tt1 = (ff + d + ss2 + (w[j] ^ w[j+4])) >>> 0;
      const tt2 = (gg + h + ss1 + w[j]) >>> 0;
      [a,b,c,d,e,f,g,h] = [tt1,a,rot(b,9),c,tt2 ^ rot(tt2,9) ^ rot(tt2,17),e,rot(f,19),g];
    }
    for (const [index,item] of [a,b,c,d,e,f,g,h].entries()) state[index] = (state[index] ^ item) >>> 0;
  }
  const out = Buffer.alloc(32); state.forEach((item,index) => out.writeUInt32BE(item,index*4));
  return out;
}
