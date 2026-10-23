import { open, rm } from "node:fs/promises";

// 最小的 MP4 / MOV 封装：浏览器（WebCodecs）编好的 H.264 + AAC 装成 MP4；带透明的网页片段逐帧 PNG 装成 MOV
// （剪映认 PNG 编码的 MOV 的透明，VP9 webm 的透明它显示成黑底，openfilm 实测过）。不带 ffmpeg。
// 样本边收边写进 mdat，只在内存里记大小和位置，收尾时写 moov。
// ponytail: 音频样本整段排在视频后面、不交错；本机播放和剪映都不在乎，要边下边播再改成按秒交错

const u8 = (value) => Buffer.from([value & 0xff]);
const u16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value & 0xffff); return buffer; };
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value >>> 0); return buffer; };
const u64 = (value) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(value)); return buffer; };
const ascii = (text) => Buffer.from(text, "latin1");
const zeros = (count) => Buffer.alloc(count);

function box(type, ...parts) {
  const body = Buffer.concat(parts.flat());
  return Buffer.concat([u32(body.length + 8), ascii(type), body]);
}
const full = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);

const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** MPEG-4 描述符的长度：4 字节的 7 位变长写法。 */
const descriptor = (tag, ...parts) => {
  const body = Buffer.concat(parts.flat());
  const size = body.length;
  return Buffer.concat([u8(tag), u8(0x80 | ((size >> 21) & 0x7f)), u8(0x80 | ((size >> 14) & 0x7f)), u8(0x80 | ((size >> 7) & 0x7f)), u8(size & 0x7f), body]);
};

function esds(config, bitrate) {
  return full("esds", 0, 0, descriptor(0x03, u16(1), u8(0),
    descriptor(0x04, u8(0x40), u8(0x15), Buffer.from([0, 0, 0]), u32(bitrate), u32(bitrate), descriptor(0x05, config)),
    descriptor(0x06, u8(0x02))));
}

function visualEntry({ codec, width, height, description, alpha, mov }) {
  const name = Buffer.alloc(32);
  const label = { avc1: "AVC Coding", "png ": "PNG", jpeg: "Photo - JPEG" }[codec] ?? codec;
  name[0] = label.length;
  name.write(label, 1, "latin1");
  // MOV 的样本描述照 ffmpeg 写的填时间和空间质量（0x200），MP4 这几位都是 0
  const quality = mov ? Buffer.concat([zeros(8), u32(0x200), u32(0x200)]) : zeros(16);
  return box(codec, zeros(6), u16(1), quality, u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), name,
    u16(alpha ? 32 : 24), u16(0xffff), codec === "avc1" ? box("avcC", description) : []);
}

function audioEntry({ sampleRate, channels, description, bitrate }) {
  return box("mp4a", zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds(description, bitrate));
}

/** 时长相同的样本合成一条 stts。 */
function stts(durations) {
  const runs = [];
  for (const duration of durations) {
    const last = runs.at(-1);
    if (last && last[1] === duration) last[0] += 1;
    else runs.push([1, duration]);
  }
  return full("stts", 0, 0, u32(runs.length), runs.map(([count, duration]) => Buffer.concat([u32(count), u32(duration)])));
}

function sampleTable(track, entry) {
  const large = track.offsets.some((offset) => offset > 0xffffffff);
  return box("stbl",
    full("stsd", 0, 0, u32(1), entry),
    stts(track.durations),
    track.keys && track.keys.length < track.sizes.length ? full("stss", 0, 0, u32(track.keys.length), track.keys.map((index) => u32(index + 1))) : [],
    full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full("stsz", 0, 0, u32(0), u32(track.sizes.length), track.sizes.map(u32)),
    large ? full("co64", 0, 0, u32(track.offsets.length), track.offsets.map(u64)) : full("stco", 0, 0, u32(track.offsets.length), track.offsets.map(u32)));
}

// MOV 的 hdlr 名字是带长度前缀的字符串，MP4 的是 \0 结尾
const handler = (component, type, name, mov) => full("hdlr", 0, 0, component ? ascii(component) : u32(0), ascii(type), zeros(12),
  mov ? Buffer.concat([u8(name.length), ascii(name)]) : ascii(`${name}\0`));

function trak({ id, track, entry, timescale, sound, width = 0, height = 0, mov }) {
  const media = track.durations.reduce((sum, value) => sum + value, 0);
  const movie = Math.round((media / timescale) * 1000);
  return box("trak",
    full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movie), zeros(8), u16(0), u16(sound ? 1 : 0), u16(sound ? 0x0100 : 0), u16(0), MATRIX,
      u32(width * 65536), u32(height * 65536)),
    box("mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(media), u16(0x55c4), u16(0)),
      handler(mov ? "mhlr" : null, sound ? "soun" : "vide", sound ? "SoundHandler" : "VideoHandler", mov),
      box("minf",
        sound ? full("smhd", 0, 0, u16(0), u16(0)) : full("vmhd", 0, 1, zeros(8)),
        mov ? handler("dhlr", "url ", "DataHandler", mov) : [],
        box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
        sampleTable(track, entry))));
}

/**
 * 开一个影片文件往里写样本。container："mp4" 或 "mov"。
 * writeVideo(data, { key }) / writeAudio(data, samples) 按到达顺序追加；close(...) 写 moov，abort() 删掉半成品。
 */
export async function openMovie(file, { container = "mp4" } = {}) {
  const handle = await open(file, "w", 0o600);
  const mov = container === "mov";
  const ftyp = mov ? box("ftyp", ascii("qt  "), u32(0x200), ascii("qt  ")) : box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41"));
  // mdat 用 64 位长度（size=1 + largesize），收尾时回填
  const mdatAt = ftyp.length;
  await handle.write(Buffer.concat([ftyp, u32(1), ascii("mdat"), u64(0)]), 0, undefined, 0);
  let position = mdatAt + 16;
  const video = { sizes: [], offsets: [], durations: [], keys: [] };
  const audio = { sizes: [], offsets: [], durations: [] };
  let queue = Promise.resolve();
  const append = (data, track) => {
    const offset = position;
    position += data.length;
    track.sizes.push(data.length);
    track.offsets.push(offset);
    queue = queue.then(() => handle.write(data, 0, data.length, offset));
    return queue;
  };
  return {
    writeVideo(data, { key = true, duration = 1 } = {}) {
      if (key) video.keys.push(video.sizes.length);
      video.durations.push(duration);
      return append(data, video);
    },
    writeAudio(data, samples) {
      audio.durations.push(samples);
      return append(data, audio);
    },
    /** videoConfig：{ codec: "avc1"|"png "|"jpeg", width, height, timescale, description?, alpha? }；audioConfig 同 AudioEncoder 的输出配置。 */
    async close(videoConfig, audioConfig = null) {
      await queue;
      if (!video.sizes.length) throw new Error("影片里一帧都没有");
      const tracks = [trak({ id: 1, track: video, entry: visualEntry({ ...videoConfig, mov }), timescale: videoConfig.timescale, width: videoConfig.width, height: videoConfig.height, mov })];
      if (audioConfig && audio.sizes.length) {
        tracks.push(trak({ id: 2, track: audio, entry: audioEntry(audioConfig), timescale: audioConfig.sampleRate, sound: true, mov }));
      }
      const seconds = video.durations.reduce((sum, value) => sum + value, 0) / videoConfig.timescale;
      const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
      const moov = box("moov", mvhd, ...tracks);
      await handle.write(moov, 0, moov.length, position);
      await handle.write(u64(position - mdatAt), 0, 8, mdatAt + 8);
      await handle.close();
    },
    async abort() {
      await queue.catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(file, { force: true });
    },
  };
}
