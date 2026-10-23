// 把浏览器 WebCodecs 编出来的 H.264（avcC 格式）和 AAC 装进一个普通 mp4：ftyp、mdat、moov 依次排，每个样本单独一个 chunk。
// 只给解析库「压一份小的发给模型」用。ponytail: 不写编辑列表、不写 ctts（编码用 baseline，不出 B 帧），要装 B 帧再补 ctts

type Buffer = Uint8Array<ArrayBuffer>;

export interface MuxSample { data: Buffer; timestamp: number; duration: number; key: boolean }
export type MuxTrack =
  | { kind: "video"; width: number; height: number; description: Uint8Array; samples: MuxSample[] }
  | { kind: "audio"; sampleRate: number; channels: number; description: Uint8Array; samples: MuxSample[] };

type Bytes = Uint8Array | number[];

const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const zeros = (count: number) => new Array<number>(count).fill(0);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);

function concat(parts: Bytes[]): Buffer {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const box = (type: string, ...parts: Bytes[]) => {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
};
const full = (type: string, version: number, flags: number, ...parts: Bytes[]) => box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
// esds 里的描述符：长度一律写成 4 字节的变长形式
const descriptor = (tag: number, body: number[]) => [tag, 0x80, 0x80, 0x80, body.length, ...body];

function sampleEntry(track: MuxTrack): Uint8Array {
  if (track.kind === "video") {
    return box("avc1", zeros(6), u16(1), zeros(16), u16(track.width), u16(track.height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
      box("avcC", track.description));
  }
  const config = descriptor(4, [0x40, 0x15, ...zeros(11), ...descriptor(5, Array.from(track.description))]);
  return box("mp4a", zeros(6), u16(1), zeros(8), u16(track.channels), u16(16), zeros(4), u32(track.sampleRate * 65536),
    full("esds", 0, 0, descriptor(3, [...u16(0), 0, ...config, ...descriptor(6, [2])])));
}

function trak(track: MuxTrack, id: number, offsets: number[]): { box: Uint8Array; ms: number } {
  const video = track.kind === "video";
  const scale = video ? 90_000 : track.sampleRate;
  const tick = (us: number) => Math.round((us * scale) / 1_000_000);
  const times = track.samples.map((sample) => tick(sample.timestamp));
  const last = track.samples.at(-1);
  const end = last ? tick(last.timestamp + last.duration) : 0;
  // 每个样本的时长按相邻时间戳算，取整不累积误差；连续相同的并成一条
  const runs: [number, number][] = [];
  times.forEach((time, index) => {
    const delta = Math.max(0, (times[index + 1] ?? end) - time);
    const run = runs.at(-1);
    if (run && run[1] === delta) run[0] += 1;
    else runs.push([1, delta]);
  });
  const ms = Math.round((end * 1000) / scale);
  const keys = track.samples.flatMap((sample, index) => (sample.key ? [index + 1] : []));
  const stbl = box("stbl",
    full("stsd", 0, 0, u32(1), sampleEntry(track)),
    full("stts", 0, 0, u32(runs.length), runs.flatMap(([count, delta]) => [...u32(count), ...u32(delta)])),
    ...(video ? [full("stss", 0, 0, u32(keys.length), keys.flatMap(u32))] : []),
    full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full("stsz", 0, 0, u32(0), u32(track.samples.length), track.samples.flatMap((sample) => u32(sample.data.length))),
    full("stco", 0, 0, u32(offsets.length), offsets.flatMap(u32)));
  const minf = box("minf",
    video ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4)),
    box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
    stbl);
  const mdia = box("mdia",
    full("mdhd", 0, 0, u32(0), u32(0), u32(scale), u32(end), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), ascii(video ? "vide" : "soun"), zeros(12), ascii(video ? "VideoHandler" : "SoundHandler"), [0]),
    minf);
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(ms), zeros(8), u16(0), u16(0), u16(video ? 0 : 0x100), u16(0), MATRIX,
    u32(video ? track.width * 65536 : 0), u32(video ? track.height * 65536 : 0));
  return { box: box("trak", tkhd, mdia), ms };
}

/** 返回文件的各段（直接拼成 Blob，不再复制一遍样本）。 */
export function muxMp4(tracks: MuxTrack[]): Buffer[] {
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41"));
  const samples = tracks.flatMap((track) => track.samples.map((sample) => sample.data));
  const size = samples.reduce((sum, data) => sum + data.length, 0);
  let offset = ftyp.length + 8;
  const traks = tracks.map((track, index) => trak(track, index + 1, track.samples.map((sample) => {
    const at = offset;
    offset += sample.data.length;
    return at;
  })));
  const ms = Math.max(0, ...traks.map((item) => item.ms));
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(ms), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
  return [ftyp, concat([u32(size + 8), ascii("mdat")]), ...samples, box("moov", mvhd, ...traks.map((item) => item.box))];
}
