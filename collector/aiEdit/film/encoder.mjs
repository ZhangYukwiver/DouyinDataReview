import { openMovie } from "./mp4.mjs";

// 编码在渲染浏览器里做（WebCodecs：H.264 + AAC），不带 ffmpeg。截好的帧（JPEG）用 base64 送进编码页，
// 编好的数据块再取回来，由 mp4.mjs 装进文件。混音也在编码页里：OfflineAudioContext 按 film.html 的声音片段摆好再编 AAC。
// 编码页要在安全上下文（127.0.0.1）里才有 WebCodecs，所以和网页片段一起从采集器的 film 地址发出去。

export const ENCODER_PAGE = `<!doctype html><meta charset="utf-8"><title>encoder</title><script>
const b64 = (bytes) => new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).slice(String(reader.result).indexOf(',') + 1)); reader.readAsDataURL(new Blob([bytes])); });
const bytesOf = async (chunk) => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); return b64(data); };
let video = null, out = [], config = null, failure = null, fps = 30, W = 0, H = 0;
window.enc = {
  async start({ width, height, fps: rate, bitrate }) {
    fps = rate; W = width; H = height; out = []; config = null; failure = null;
    const codec = width * height > 2097152 ? 'avc1.640033' : 'avc1.640028';
    const settings = { codec, width, height, bitrate, framerate: rate, avc: { format: 'avc' } };
    if (!(await VideoEncoder.isConfigSupported(settings)).supported) throw new Error('这个浏览器编不了 H.264 视频');
    video = new VideoEncoder({ output: (chunk, meta) => { if (meta?.decoderConfig?.description) config = meta.decoderConfig.description; out.push(chunk); }, error: (e) => { failure = e; } });
    video.configure(settings);
  },
  async frame(data, index, key) {
    if (failure) throw failure;
    const bitmap = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + data)).blob(), 0, 0, W, H);
    const frame = new VideoFrame(bitmap, { timestamp: Math.round(index * 1e6 / fps), duration: Math.round(1e6 / fps) });
    video.encode(frame, { keyFrame: key });
    frame.close(); bitmap.close();
    while (video.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 5));
    return this.take();
  },
  async take() {
    const chunks = out.splice(0);
    return Promise.all(chunks.map(async (c) => ({ data: await bytesOf(c), key: c.type === 'key', ts: c.timestamp })));
  },
  async finish() {
    await video.flush();
    if (failure) throw failure;
    const chunks = await this.take();
    video.close();
    return { chunks, description: config ? await b64(config) : null };
  },
  async audio({ duration, sounds }) {
    const rate = 48000;
    const settings = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate: 192000 };
    if (!sounds.length || !(await AudioEncoder.isConfigSupported(settings)).supported) return null;
    const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * rate)), rate);
    const buffers = new Map();
    const skipped = [];
    for (const s of sounds) {
      if (!buffers.has(s.src)) buffers.set(s.src, fetch(s.src).then((r) => r.arrayBuffer()).then((data) => context.decodeAudioData(data)).catch(() => null));
      const buffer = await buffers.get(s.src);
      if (!buffer) { skipped.push(s.src); continue; }
      const speed = s.speed ?? 1, from = s.from ?? 0, to = Math.min(s.to ?? buffer.duration, buffer.duration), at = s.at ?? 0, volume = s.volume ?? 1;
      if (!(to > from)) continue;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = speed;
      const gain = context.createGain();
      const length = (to - from) / speed;
      const [fadeIn, fadeOut] = Array.isArray(s.fade) ? s.fade : [0, 0];
      gain.gain.setValueAtTime(fadeIn > 0 ? 0 : volume, at);
      if (fadeIn > 0) gain.gain.linearRampToValueAtTime(volume, at + fadeIn);
      if (fadeOut > 0) { gain.gain.setValueAtTime(volume, Math.max(at, at + length - fadeOut)); gain.gain.linearRampToValueAtTime(0, at + length); }
      node.connect(gain).connect(context.destination);
      node.start(at, from, to - from);
    }
    const mixed = await context.startRendering();
    const chunks = [];
    let described = null, broken = null;
    const encoder = new AudioEncoder({ output: (chunk, meta) => { if (meta?.decoderConfig?.description) described = meta.decoderConfig.description; chunks.push(chunk); }, error: (e) => { broken = e; } });
    encoder.configure(settings);
    const left = mixed.getChannelData(0), right = mixed.getChannelData(1), step = 4800;
    for (let start = 0; start < mixed.length; start += step) {
      const count = Math.min(step, mixed.length - start);
      const planes = new Float32Array(count * 2);
      planes.set(left.subarray(start, start + count), 0);
      planes.set(right.subarray(start, start + count), count);
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: count, numberOfChannels: 2, timestamp: Math.round(start * 1e6 / rate), data: planes });
      encoder.encode(data);
      data.close();
    }
    await encoder.flush();
    encoder.close();
    if (broken) throw broken;
    return { sampleRate: rate, channels: 2, bitrate: 192000, description: described ? await b64(described) : null, skipped,
      chunks: await Promise.all(chunks.map(async (c) => ({ data: await bytesOf(c), samples: Math.round((c.duration ?? 21333) * rate / 1e6) }))) };
  },
};
</script>`;

const FRAMES_PER_KEY = 2; // 秒

/**
 * 一路视频（+ 混音）编进 MP4。frames(i) 按顺序给第 i 帧的 JPEG；sounds 是 film.html 的声音片段（timeline 的 __filmSounds）。
 * encoderTab 是 openTab 打开的编码页。回音频里没解出声音的文件。
 */
export async function encodeMp4({ encoderTab, file, width, height, fps, count, frame, sounds = [], onProgress = () => undefined, signal }) {
  // H.264 宽高要是偶数
  const evenWidth = width - (width % 2);
  const evenHeight = height - (height % 2);
  const movie = await openMovie(file, { container: "mp4" });
  try {
    const bitrate = Math.min(40e6, Math.max(2e6, evenWidth * evenHeight * fps * 0.15));
    await encoderTab.evaluate(`enc.start(${JSON.stringify({ width: evenWidth, height: evenHeight, fps, bitrate })})`);
    const timescale = fps * 1000;
    const write = async (chunks) => { for (const chunk of chunks) await movie.writeVideo(Buffer.from(chunk.data, "base64"), { key: chunk.key, duration: 1000 }); };
    // 编这一帧的时候已经在画下一帧（截图和编码在不同的标签页，互不等）
    let next = frame(0);
    for (let index = 0; index < count; index += 1) {
      signal?.throwIfAborted();
      const data = (await next).toString("base64");
      next = index + 1 < count ? frame(index + 1) : null;
      next?.catch(() => undefined);
      await write(await encoderTab.evaluate(`enc.frame(${JSON.stringify(data)}, ${index}, ${index % (fps * FRAMES_PER_KEY) === 0})`));
      onProgress((index + 1) / count);
    }
    const { chunks, description } = await encoderTab.evaluate("enc.finish()");
    await write(chunks);
    if (!description) throw new Error("编码器没给出 H.264 的参数");
    const audio = sounds.length ? await encoderTab.evaluate(`enc.audio(${JSON.stringify({ duration: count / fps, sounds })})`) : null;
    if (audio?.chunks.length) for (const chunk of audio.chunks) await movie.writeAudio(Buffer.from(chunk.data, "base64"), chunk.samples);
    await movie.close(
      { codec: "avc1", width: evenWidth, height: evenHeight, timescale, description: Buffer.from(description, "base64") },
      audio?.chunks.length && audio.description ? { ...audio, description: Buffer.from(audio.description, "base64") } : null,
    );
    return { silent: sounds.length > 0 && !audio?.chunks.length, skipped: audio?.skipped ?? [] };
  } catch (error) {
    await movie.abort();
    throw error;
  }
}

/** 带透明的网页片段：逐帧 PNG 装进 MOV（剪映认它的透明）。 */
export async function writePngMov({ file, width, height, fps, count, frame, onProgress = () => undefined, signal }) {
  const movie = await openMovie(file, { container: "mov" });
  try {
    for (let index = 0; index < count; index += 1) {
      signal?.throwIfAborted();
      await movie.writeVideo(await frame(index), { key: true, duration: 1000 });
      onProgress((index + 1) / count);
    }
    await movie.close({ codec: "png ", width, height, timescale: fps * 1000, alpha: true });
  } catch (error) {
    await movie.abort();
    throw error;
  }
}
