import { describe, expect, it } from "vitest";
import { alignCutsToBeats, detectBeats, detectFlashes, detectShots, type FrameSample } from "./videoLook";

// 固定种子的随机数，测试每次跑出来一样
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 64;
const H = 36;
type Paint = (x: number, y: number) => number;

function frame(t: number, paint: Paint): FrameSample {
  const gray = new Uint8Array(W * H);
  let sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const value = Math.max(0, Math.min(255, Math.round(paint(x, y))));
    gray[y * W + x] = value;
    sum += value;
  }
  return { t, gray, mean: sum / gray.length };
}

// 几道低频正弦叠起来的平滑纹理，可以按小数像素平移
function texture(seed: number, contrast = 70, base = 128): Paint {
  const random = rng(seed);
  const waves = Array.from({ length: 5 }, () => ({
    fx: (random() - 0.5) * 0.5, fy: (random() - 0.5) * 0.5, phase: random() * Math.PI * 2, amp: contrast / 5 * (0.6 + random() * 0.8),
  }));
  return (x, y) => base + waves.reduce((sum, w) => sum + w.amp * Math.sin(w.fx * x + w.fy * y + w.phase), 0);
}

const flat = (value: number): Paint => () => value;
const noisy = (paint: Paint, random: () => number, amount: number): Paint => (x, y) => paint(x, y) + (random() - 0.5) * 2 * amount;
const times = (duration: number, fps: number) => Array.from({ length: Math.floor(duration * fps) }, (_, i) => Math.round((i / fps) * 1000) / 1000);
const cutsOf = (shots: { start: number; end: number }[]) => shots.slice(1).map((shot) => shot.start);
const shift = (paint: Paint, dx: number, dy: number): Paint => (x, y) => paint(x + dx, y + dy);
const zoom = (paint: Paint, scale: number): Paint => (x, y) => paint(32 + (x - 32) / scale, 18 + (y - 18) / scale);
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// 更像实拍的画面：1/f 叠起来的正弦加几个矩形（带硬边），按目标均值、对比度归一，可以平移
function scene(seed: number, mean = 120, std = 45): Paint {
  const random = rng(seed);
  const waves = Array.from({ length: 24 }, () => {
    const f = 0.03 + random() * 0.6;
    const angle = random() * Math.PI * 2;
    return { fx: f * Math.cos(angle), fy: f * Math.sin(angle), phase: random() * Math.PI * 2, amp: 1 / (f + 0.05) };
  });
  const rects = Array.from({ length: 5 }, () => ({ x: random() * 64, y: random() * 36, w: 4 + random() * 20, h: 3 + random() * 15, v: (random() - 0.5) * 24 }));
  const raw = (x: number, y: number) => {
    let sum = 0;
    for (const w of waves) sum += w.amp * Math.sin(w.fx * x + w.fy * y + w.phase);
    for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) sum += r.v;
    return sum;
  };
  let m = 0, m2 = 0, n = 0;
  for (let y = -20; y < 56; y += 6) for (let x = -40; x < 104; x += 6) { const v = raw(x, y); m += v; m2 += v * v; n++; }
  m /= n;
  const s = Math.sqrt(m2 / n - m * m);
  // 整数格点算一次记下来（画面外留一圈给平移用），小数坐标（平移、缩放）双线性插值：测试才跑得快
  const cache = new Float64Array(192 * 108).fill(NaN);
  const at = (x: number, y: number) => {
    const key = (y + 36) * 192 + x + 64;
    if (x < -64 || x >= 128 || y < -36 || y >= 72) return mean + ((raw(x, y) - m) / s) * std;
    if (Number.isNaN(cache[key]!)) cache[key] = mean + ((raw(x, y) - m) / s) * std;
    return cache[key]!;
  };
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    if (!fx && !fy) return at(x0, y0);
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
}

// found 和 truth 一一对上（每个真切点 within 内都有一个，且没有多余的）
function expectCutsMatch(found: number[], truth: number[], within: number) {
  expect(truth.filter((time) => !found.some((cut) => Math.abs(cut - time) <= within))).toEqual([]);
  expect(found.filter((cut) => !truth.some((time) => Math.abs(cut - time) <= within))).toEqual([]);
}

function expectCovers(shots: { start: number; end: number }[], duration: number) {
  expect(shots[0]!.start).toBe(0);
  expect(shots[shots.length - 1]!.end).toBe(duration);
  shots.forEach((shot, i) => {
    expect(shot.end).toBeGreaterThan(shot.start);
    if (i > 0) expect(shot.start).toBe(shots[i - 1]!.end);
  });
}

function expectCutsNear(found: number[], expected: number[], within: number) {
  expect(found).toHaveLength(expected.length);
  expected.forEach((time, i) => expect(Math.abs(found[i]! - time)).toBeLessThanOrEqual(within));
}

describe("detectShots", () => {
  it("finds hard cuts in calm footage, including two textures with the same brightness spread", () => {
    const random = rng(1);
    const a = texture(11);
    const b = texture(12);
    const content = (t: number) => (t < 3.2 ? flat(100) : t < 6.1 ? a : t < 9 ? b : flat(60));
    const samples = times(12, 4).map((t) => frame(t, noisy(content(t), random, 2)));
    const shots = detectShots(samples, 12);
    expectCovers(shots, 12);
    expectCutsNear(cutsOf(shots), [3.2, 6.1, 9], 0.25);
  });

  it("finds cuts in busy handheld footage without inventing extra ones", () => {
    const random = rng(2);
    const scenes = [texture(21, 90), texture(22, 90, 150), texture(23, 90, 100), texture(24, 90)];
    const cuts = [2.6, 5.3, 8.4];
    const samples = times(11, 5).map((t) => {
      const scene = scenes[cuts.filter((cut) => t >= cut).length]!;
      // 手持抖动 + 一个移动的亮块 + 逐像素噪声
      const dx = (random() - 0.5) * 6 + t * 3;
      const dy = (random() - 0.5) * 4;
      const bx = (t * 23) % W;
      return frame(t, noisy((x, y) => ((x - bx) ** 2 + (y - 18) ** 2 < 49 ? 235 : scene(x + dx, y + dy)), random, 15));
    });
    const shots = detectShots(samples, 11.37);
    expectCovers(shots, 11.37);
    expectCutsNear(cutsOf(shots), cuts, 0.2);
  });

  it("does not cut on a slow pan that starts and stops", () => {
    const random = rng(3);
    const scene = texture(31, 90);
    const samples = times(14, 4).map((t) => {
      const shift = Math.min(Math.max(t - 3, 0), 8) * 10; // 中间 8 秒以每秒 10 像素横移
      return frame(t, noisy((x, y) => scene(x + shift, y + shift * 0.3), random, 3));
    });
    expect(detectShots(samples, 14)).toEqual([{ start: 0, end: 14 }]);
  });

  it("does not turn a single flash frame into two cuts, but cuts once on a flash between two shots", () => {
    const random = rng(4);
    const a = texture(41);
    const b = texture(42, 70, 90);
    const single = times(6, 4).map((t) => frame(t, t === 2.5 ? flat(250) : noisy(a, random, 2)));
    expect(detectFlashes(single)).toEqual([2.5]);
    expect(detectShots(single, 6)).toEqual([{ start: 0, end: 6 }]);

    const transition = times(6, 4).map((t) => frame(t, t === 3 ? flat(252) : noisy(t < 3 ? a : b, random, 2)));
    expect(detectFlashes(transition)).toEqual([3]);
    expectCutsNear(cutsOf(detectShots(transition, 6)), [3], 0.01);
  });

  it("treats a fade through black and a dissolve as one cut each, and ignores flicker", () => {
    const random = rng(7);
    const a = texture(71, 80);
    const b = texture(72, 80, 90);
    const fade = times(10, 4).map((t) => {
      const gain = t < 3 ? 1 : t < 4 ? 4 - t : t < 5 ? t - 4 : 1;
      return frame(t, (x, y) => (t < 4 ? a : b)(x, y) * gain + (random() - 0.5) * 4);
    });
    expectCutsNear(cutsOf(detectShots(fade, 10)), [4], 0.25);

    const dissolve = times(10, 4).map((t) => {
      const mix = Math.min(1, Math.max(0, (t - 4.7) / 0.6));
      return frame(t, (x, y) => a(x, y) * (1 - mix) + b(x, y) * mix + (random() - 0.5) * 4);
    });
    expectCutsNear(cutsOf(detectShots(dissolve, 10)), [5], 0.3);

    // 频闪：整体亮度每帧随机跳 ±40，画面结构不变
    const flicker = times(8, 6).map((t) => {
      const offset = (random() - 0.5) * 80;
      return frame(t, (x, y) => a(x, y) + offset);
    });
    expect(detectShots(flicker, 8)).toHaveLength(1);
  });

  it("merges cuts closer than minShot", () => {
    const random = rng(5);
    const scenes = [texture(51), texture(52, 70, 170), texture(53, 70, 80)];
    // 中间那个镜头只有一帧（1/6 秒）
    const samples = times(6, 6).map((t) => frame(t, noisy(scenes[t < 3 ? 0 : t < 3.1 ? 1 : 2]!, random, 2)));
    expect(cutsOf(detectShots(samples, 6))).toHaveLength(1);
    expect(cutsOf(detectShots(samples, 6, { minShot: 0.1 }))).toHaveLength(2);
  });

  it("returns one shot for zero or one sample", () => {
    expect(detectShots([], 5)).toEqual([{ start: 0, end: 5 }]);
    expect(detectShots([frame(0, flat(30))], 5)).toEqual([{ start: 0, end: 5 }]);
  });
});

describe("detectShots regressions", () => {
  it("keeps every cut in 闪白快切 where each cut sits on one white frame", () => {
    const random = rng(5);
    const scenes = Array.from({ length: 30 }, (_, i) => scene(400 + i, 110 + ((i * 23) % 40), 40));
    const cuts = Array.from({ length: 18 }, (_, i) => 1 + i * 0.5);
    const samples = times(11, 6).map((t) => frame(t, noisy(cuts.some((cut) => Math.abs(t - cut) < 0.06) ? flat(250) : scenes[cuts.filter((cut) => t >= cut - 1e-9).length]!, random, 3)));
    // 闪光帧之后的正常画面不能再被当成一次「闪黑」
    expectCutsMatch(detectFlashes(samples), cuts, 0.05);
    expectCutsMatch(cutsOf(detectShots(samples, 11)), cuts, 1 / 6 + 0.01);
  });

  it("finds hard cuts when every shot is only one or two samples long", () => {
    const random = rng(99);
    const scenes = Array.from({ length: 12 }, (_, i) => scene(100 + i, 100 + ((i * 37) % 60), 40));
    const cuts: number[] = [];
    for (let t = 1.5; t < 9; t += 0.34) cuts.push(Math.round(t * 1000) / 1000);
    const samples = times(9.5, 6).map((t) => frame(t, noisy(scenes[cuts.filter((cut) => t >= cut).length % 12]!, random, 3)));
    expectCutsMatch(cutsOf(detectShots(samples, 9.5)), cuts, 1 / 6 + 0.01);

    // 长视频按 0.375 秒一帧取样，镜头 0.6 秒一换
    const long: FrameSample[] = [];
    const longCuts: number[] = [];
    for (let t = 0.6; t < 29.5; t += 0.6) longCuts.push(Math.round(t * 1000) / 1000);
    for (let t = 0; t < 30; t += 0.375) long.push(frame(t, noisy(scenes[longCuts.filter((cut) => t >= cut).length % 12]!, random, 3)));
    expectCutsMatch(cutsOf(detectShots(long, 30)), longCuts, 0.385);
  });

  it("cuts a short insert shot that returns to the first shot, and A/B shots alternating every half second", () => {
    for (const len of [0.4, 0.5]) {
      const random = rng(len * 10);
      const a = scene(4000, 120, 40);
      const b = scene(4100, 120, 40);
      const samples = times(6, 6).map((t) => frame(t, noisy(t >= 3 && t < 3 + len ? b : a, random, 3)));
      expectCutsMatch(cutsOf(detectShots(samples, 6)), [3, 3 + len], 1 / 6 + 0.01);
    }
    const random = rng(11);
    const a = scene(601, 120, 45);
    const b = scene(602, 120, 45);
    const cuts = Array.from({ length: 12 }, (_, i) => 1 + i * 0.5);
    const samples = times(8, 6).map((t) => frame(t, noisy(cuts.filter((cut) => t >= cut).length % 2 ? b : a, random, 3)));
    expectCutsMatch(cutsOf(detectShots(samples, 8)), cuts, 1 / 6 + 0.01);
  });

  it("treats bright and dark textured shots cut on the beat as shots, not flashes", () => {
    for (const [dark, bright] of [[70, 170], [35, 200]] as const) {
      const random = rng(dark);
      const cuts: number[] = [];
      const scenes = [scene(2000 + dark, dark, 30)];
      for (let i = 0; i < 8; i++) { cuts.push(Math.round((1 + i * 0.47) * 1000) / 1000); scenes.push(scene(2001 + dark + i, i % 2 === 0 ? bright : dark, 30)); }
      const samples = times(6, 6).map((t) => frame(t, noisy(scenes[cuts.filter((cut) => t >= cut).length]!, random, 3)));
      expect(detectFlashes(samples)).toEqual([]);
      expectCutsMatch(cutsOf(detectShots(samples, 6)), cuts, 1 / 6 + 0.01);
    }
  });

  it("does not cut on a short eased pan or a zoom transition", () => {
    {
      // 静止镜头里 3~4 秒缓起缓停地横移 16 像素（画面宽度的四分之一，再带一点竖移）
      const random = rng(16);
      const still = scene(9000, 120, 45);
      const samples = times(8, 6).map((t) => frame(t, noisy(shift(still, 16 * ease(t - 3), 4.8 * ease(t - 3)), random, 3)));
      expect(detectShots(samples, 8)).toEqual([{ start: 0, end: 8 }]);
    }
    // A 在 0.33 秒里推近到 2 倍，4 秒硬切到 B，B 再从 2 倍拉回来（带拖影）
    const blurred = (paint: Paint, from: number, to: number): Paint => (x, y) => [0, 1, 2, 3].reduce((sum, k) => sum + zoom(paint, from + ((to - from) * k) / 3)(x, y), 0) / 4;
    {
      const a = scene(7000, 120, 45);
      const b = scene(7100, 125, 45);
      const scaleA = (t: number) => (t < 3.67 ? 1 : 1 + (t - 3.67) / 0.33);
      const scaleB = (t: number) => (t > 4.33 ? 1 : 1 + (4.33 - t) / 0.33);
      const random = rng(0);
      const samples = times(8, 6).map((t) => frame(t, noisy(t < 4 ? blurred(a, scaleA(t - 0.08), scaleA(t)) : blurred(b, scaleB(t - 0.08), scaleB(t)), random, 3)));
      expectCutsMatch(cutsOf(detectShots(samples, 8)), [4], 1 / 6 + 0.01);
    }
    // 前后都静止的突然推近（跳切）还是算一刀
    const random = rng(3);
    const still = scene(7300, 120, 45);
    const punchIn = times(8, 6).map((t) => frame(t, noisy(t < 4 ? still : zoom(still, 1.4), random, 3)));
    expectCutsMatch(cutsOf(detectShots(punchIn, 8)), [4], 1 / 6 + 0.01);
  });

  it("finds cuts between dark, low-contrast night scenes", () => {
    for (const [mean, std, seed] of [[18, 5, 1], [22, 6, 0]] as const) {
      const random = rng(seed);
      const scenes = [0, 1, 2, 3, 4].map((i) => scene(1000 + seed * 10 + i, mean, std));
      const cuts = [2.1, 4.3, 6.4, 8.7];
      const samples = times(11, 6).map((t) => frame(t, noisy(scenes[cuts.filter((cut) => t >= cut).length]!, random, 2)));
      expectCutsMatch(cutsOf(detectShots(samples, 11)), cuts, 1 / 6 + 0.01);
    }
  });
});

describe("detectFlashes", () => {
  it("reports a black flash on a bright scene once and ignores a fade that stays bright", () => {
    const random = rng(6);
    const bright = texture(61, 40, 200);
    const black = times(5, 6).map((t) => frame(t, t >= 2 && t < 2.3 ? flat(5) : noisy(bright, random, 2)));
    expect(detectFlashes(black)).toHaveLength(1);
    expect(detectFlashes(black)[0]).toBeGreaterThanOrEqual(2);
    expect(detectFlashes(black)[0]).toBeLessThan(2.3);

    const fade = times(5, 6).map((t) => frame(t, flat(t < 2 ? 50 : Math.min(240, 50 + (t - 2) * 400))));
    expect(detectFlashes(fade)).toEqual([]);
  });
});

// ---------- 节拍 ----------

const RATE = 22050;

function clickTrack(options: { bpm: number; seconds: number; start?: number; noise?: number; skip?: number[]; accentEvery?: number; seed?: number }) {
  const { bpm, seconds, start = 0.3, noise = 0.05, skip = [], accentEvery = 0, seed = 7 } = options;
  const random = rng(seed);
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = (random() - 0.5) * 2 * noise;
  const truth: number[] = [];
  const accents: number[] = [];
  for (let k = 0; start + (k * 60) / bpm < seconds - 0.1; k++) {
    const time = start + (k * 60) / bpm;
    truth.push(time);
    if (skip.includes(k)) continue;
    const accent = accentEvery && k % accentEvery === 0;
    if (accent) accents.push(time);
    const amp = accent ? 0.9 : 0.4;
    const at = Math.round(time * RATE);
    // 30 ms 衰减的噪声脉冲，加一点 1 kHz 音头
    for (let i = 0; i < 0.03 * RATE && at + i < pcm.length; i++) {
      const env = Math.exp(-i / (0.008 * RATE));
      pcm[at + i] = pcm[at + i]! + amp * env * ((random() - 0.5) * 1.4 + 0.6 * Math.sin((2 * Math.PI * 1000 * i) / RATE));
    }
  }
  return { pcm, truth, accents };
}

// 简单的鼓组：底鼓 1、3 拍，军鼓 2、4 拍，八分音符踩镲，每拍一个贝斯音；可以叠一层「旁白」
function drumTrack(bpm: number, seconds: number, seed: number, voice = 0) {
  const random = rng(seed);
  const pcm = new Float32Array(Math.round(seconds * RATE));
  const add = (at: number, length: number, fn: (t: number) => number) => {
    const from = Math.round(at * RATE);
    for (let i = 0; i < length * RATE && from + i < pcm.length; i++) pcm[from + i] = pcm[from + i]! + fn(i / RATE);
  };
  const truth: number[] = [];
  const beat = 60 / bpm;
  for (let k = 0; 0.5 + k * beat < seconds - 0.1; k++) {
    const t = 0.5 + k * beat;
    truth.push(t);
    if (k % 2 === 0) add(t, 0.3, (s) => 0.5 * Math.exp(-s / 0.08) * Math.sin(2 * Math.PI * (50 * s + 3 * (1 - Math.exp(-s / 0.03)))));
    else add(t, 0.2, (s) => 0.3 * Math.exp(-s / 0.05) * ((random() - 0.5) * 1.6 + 0.5 * Math.sin(2 * Math.PI * 200 * s)));
    for (const half of [0, 0.5]) add(t + half * beat, 0.05, (s) => (0.06 + random() * 0.04) * Math.exp(-s / 0.015) * (random() - 0.5) * 2);
    add(t, beat * 0.95, (s) => 0.2 * Math.min(1, s / 0.01) * Math.exp(-s / 0.4) * Math.sin(2 * Math.PI * 55 * s));
  }
  for (let at = 0.2; voice && at < seconds;) {
    const length = 0.08 + random() * 0.17;
    const pitch = 120 + random() * 120;
    const amp = voice * (0.5 + random());
    add(at, length, (s) => amp * Math.sin((Math.PI * s) / length) * (Math.sin(2 * Math.PI * pitch * s) * 0.7 + (random() - 0.5) * 0.5));
    at += length + 0.05 + random() * 0.35;
  }
  return { pcm, truth };
}

const share = (from: number[], to: number[], within: number) =>
  from.filter((time) => to.some((other) => Math.abs(other - time) <= within)).length / from.length;

const note = (n: number) => 440 * 2 ** ((n - 69) / 12);
const rms = (pcm: Float32Array) => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);

// 每种声音只合成一次，之后按时间叠拷贝：测试才跑得快
const sounds = new Map<string, Float32Array>();
function sound(key: string, length: number, fn: (t: number) => number) {
  let buffer = sounds.get(key);
  if (!buffer) {
    buffer = new Float32Array(Math.round(length * RATE));
    for (let i = 0; i < buffer.length; i++) buffer[i] = fn(i / RATE);
    sounds.set(key, buffer);
  }
  return buffer;
}
function place(pcm: Float32Array, at: number, buffer: Float32Array, gain = 1) {
  const from = Math.round(at * RATE);
  for (let i = 0; i < buffer.length && from + i < pcm.length; i++) if (from + i >= 0) pcm[from + i] = pcm[from + i]! + buffer[i]! * gain;
}
const noiseOf = (seed: number) => { const random = rng(seed); return () => random() * 2 - 1; };

// 起音软的底鼓：正弦从 250Hz 扫到 50Hz，click 是开头那一下宽带噪声的比例（808 式底鼓几乎没有）
function kick(click: number) {
  const noise = noiseOf(1);
  let phase = 0;
  return sound(`kick${click}`, 0.35, (s) => {
    phase += (2 * Math.PI * (50 + 200 * Math.exp(-s / 0.02))) / RATE;
    return Math.exp(-s / 0.15) * Math.sin(phase) + click * Math.exp(-s / 0.004) * noise();
  });
}
// 高通噪声：拍手（衰减 70ms）、开镲（80ms）、闭镲（30ms）
function hiss(decay: number) {
  const noise = noiseOf(2);
  let previous = 0;
  return sound(`hiss${decay}`, decay * 6, (s) => { const n = noise(); const high = n - previous; previous = n; return Math.exp(-s / decay) * high; });
}
const snare = () => { const noise = noiseOf(3); return sound("snare", 0.25, (s) => Math.exp(-s / 0.08) * (noise() * 0.8 + 0.4 * Math.sin(2 * Math.PI * 190 * s))); };
const bass = (length: number, freq: number) =>
  sound(`bass${length}/${freq}`, length, (s) => Math.min(1, s / 0.005) * Math.min(1, (length - s) / 0.01) * (0.6 * (2 * ((s * freq) % 1) - 1) + 0.4 * Math.sin(2 * Math.PI * freq * s)));
const chord = (root: number) => sound(`chord${root}`, 1.2, (s) => Math.exp(-s / 0.4) * Math.min(1, s / 0.003) * [0, 4, 7].reduce((sum, n) => sum + Math.sin(2 * Math.PI * note(root + n) * s), 0) / 3);
const pad = (length: number, root: number) =>
  sound(`pad${length}/${root}`, length, (s) => Math.min(1, s / 0.3) * Math.min(1, (length - s) / 0.3) * [0, 4, 7].reduce((sum, n) => sum + Math.sin(2 * Math.PI * note(root + n) * s), 0) / 3);

// 四拍舞曲：每拍底鼓，2、4 拍拍手，反拍开镲和贝斯，每小节一个 pad。
// introBars 小节每拍一个安静的钢琴和弦，buildBars 小节铺垫（轻底鼓 + 越来越密的军鼓），之后是完整的 drop
function danceTrack(bpm: number, seconds: number, options: { click?: number; introBars?: number; buildBars?: number } = {}) {
  const { click = 0.4, introBars = 0, buildBars = 0 } = options;
  const pcm = new Float32Array(Math.round(seconds * RATE));
  const beat = 60 / bpm;
  const truth: number[] = [];
  const intro = introBars * 4;
  const build = intro + buildBars * 4;
  for (let k = 0; 0.25 + k * beat < seconds - 0.05; k++) {
    const t = 0.25 + k * beat;
    truth.push(t);
    const root = [45, 41, 48, 43][Math.floor(k / 4) % 4]!;
    if (k < intro) { place(pcm, t, chord(root + 12), 0.15); continue; }
    if (k < build) {
      place(pcm, t, kick(click), 0.35);
      const roll = (k - intro) / (build - intro) < 0.5 ? 2 : 4;
      for (let q = 0; q < roll; q++) place(pcm, t + (q * beat) / roll, snare(), 0.15 + (0.25 * (k - intro)) / (build - intro));
      continue;
    }
    place(pcm, t, kick(click), 0.95);
    if (k % 2) place(pcm, t, hiss(0.07), 0.4);
    place(pcm, t + beat / 2, hiss(0.08), 0.15);
    place(pcm, t + beat / 2, bass(Math.round((beat / 2 - 0.01) * 1000) / 1000, note(root - 12)), 0.2);
    if (k % 4 === 0) place(pcm, t, pad(Math.round(beat * 4 * 1000) / 1000, root + 12), 0.06);
  }
  return { pcm, truth, drop: 0.25 + build * beat, introEnd: 0.25 + intro * beat };
}

// 嘻哈 boom-bap：第 1、3 拍和第 2 拍后半（swing）底鼓，2、4 拍军鼓，swing 八分踩镲，贝斯
function boomBap(bpm: number, seconds: number) {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  const beat = 60 / bpm;
  const truth: number[] = [];
  for (let k = 0; 0.3 + k * beat < seconds - 0.05; k++) {
    const t = 0.3 + k * beat;
    truth.push(t);
    const pos = k % 4;
    if (pos === 0 || pos === 2) place(pcm, t, kick(0.4), 0.85);
    if (pos === 1) { place(pcm, t + 0.62 * beat, kick(0.4), 0.7); place(pcm, t, snare(), 0.55); }
    if (pos === 3) place(pcm, t, snare(), 0.55);
    place(pcm, t, hiss(0.03), 0.1);
    place(pcm, t + 0.62 * beat, hiss(0.03), 0.07);
    if (pos === 0 || pos === 2) place(pcm, t, bass(Math.round(beat * 1.5 * 1000) / 1000, note(pos ? 39 : 36)), 0.2);
  }
  return { pcm, truth };
}

// 旁白：一句一句说，音节长短、音高、共振峰随机（从一小批合成好的音节里挑），辅音带一下爆破噪声；按 RMS 比例垫在音乐下面
function voiceOver(music: Float32Array, ratio: number, seed: number, burst: number) {
  const random = rng(seed);
  const syllables = Array.from({ length: 16 }, (_, index) => {
    const length = 0.08 + random() * 0.18;
    const f0 = 110 + random() * 90;
    const f1 = 400 + random() * 500;
    const f2 = 1000 + random() * 1400;
    const consonant = random() < 0.5;
    const noise = noiseOf(seed * 100 + index);
    const partials: { freq: number; weight: number }[] = [];
    for (let h = 1; h * f0 < 3500; h++) {
      const weight = (Math.exp(-(((h * f0 - f1) / 150) ** 2)) + 0.5 * Math.exp(-(((h * f0 - f2) / 200) ** 2)) + 0.05) / Math.sqrt(h);
      if (weight > 0.04) partials.push({ freq: h * f0, weight });
    }
    return sound(`syllable${seed}/${index}/${burst}`, length, (s) =>
      Math.sin((Math.PI * s) / length) ** 0.7 * partials.reduce((sum, p) => sum + p.weight * Math.sin(2 * Math.PI * p.freq * s), 0) * 0.5 + (consonant && s < 0.03 ? noise() * burst : 0));
  });
  const voice = new Float32Array(music.length);
  const end = music.length / RATE;
  for (let at = 0.5; at < end;) {
    const phraseEnd = Math.min(end, at + 1 + random() * 2.5);
    while (at < phraseEnd) {
      const syllable = syllables[Math.floor(random() * syllables.length)]!;
      place(voice, at, syllable, 0.5 + random() * 0.6);
      at += syllable.length / RATE + 0.02 + random() * 0.12;
    }
    at += 0.2 + random() * 0.6;
  }
  const scale = (ratio * rms(voice)) / rms(music);
  return music.map((value, i) => value * scale + voice[i]!);
}

describe("detectBeats", () => {
  for (const bpm of [120, 95]) {
    it(`locks onto a noisy ${bpm} BPM click track with skipped clicks`, () => {
      const { pcm, truth } = clickTrack({ bpm, seconds: 20, skip: [5, 6, 17, 30], seed: bpm });
      const result = detectBeats(pcm, RATE)!;
      expect(result).not.toBeNull();
      expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(2);
      expect(result.duration).toBe(20);
      expect(share(truth, result.beats, 0.03)).toBeGreaterThan(0.9);
      expect(share(result.beats, truth, 0.03)).toBeGreaterThan(0.9);
      expect(result.beats).toEqual([...result.beats].sort((a, b) => a - b));
    });
  }

  for (const bpm of [70, 150]) {
    it(`does not double or halve a ${bpm} BPM track`, () => {
      const { pcm } = clickTrack({ bpm, seconds: 16, seed: bpm });
      const result = detectBeats(pcm, RATE)!;
      expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(2);
    });
  }

  it("keeps a slow drum groove with eighth-note hi-hats at its own tempo and survives a voice-over", () => {
    const slow = drumTrack(72, 16, 21);
    expect(Math.abs(detectBeats(slow.pcm, RATE)!.bpm - 72)).toBeLessThanOrEqual(2);

    const talky = drumTrack(118, 16, 22, 0.5);
    const result = detectBeats(talky.pcm, RATE)!;
    expect(Math.abs(result.bpm - 118)).toBeLessThanOrEqual(2);
    expect(share(talky.truth, result.beats, 0.03)).toBeGreaterThan(0.9);
  });

  it("marks the drop where the track gets much louder as strong", () => {
    const { pcm } = drumTrack(128, 20, 23);
    const drop = 0.5 + (16 * 60) / 128;
    for (let i = 0; i < Math.round(drop * RATE); i++) pcm[i] = pcm[i]! * (i >= Math.round((drop - 0.25) * RATE) ? 0.02 : 0.3);
    const result = detectBeats(pcm, RATE)!;
    expect(result.strong.some((time) => Math.abs(time - drop) <= 0.04)).toBe(true);
    expect(result.strong.every((time) => Math.abs(time - drop) <= 0.04)).toBe(true);
  });

  it("marks accented hits as strong and plain clicks as not", () => {
    const { pcm, accents, truth } = clickTrack({ bpm: 120, seconds: 16, accentEvery: 4, seed: 9 });
    const result = detectBeats(pcm, RATE)!;
    expect(result.strong.length).toBeGreaterThan(0);
    expect(result.strong.length).toBeLessThanOrEqual(40);
    expect(share(result.strong, accents, 0.04)).toBe(1);
    expect(share(accents, result.strong, 0.04)).toBeGreaterThan(0.8);
    expect(result.strong.length).toBeLessThan(truth.length / 2);
  });

  it("returns null for silence, too-short audio, white noise and speech-like bursts", () => {
    expect(detectBeats(new Float32Array(RATE * 10), RATE)).toBeNull();
    expect(detectBeats(clickTrack({ bpm: 120, seconds: 2 }).pcm, RATE)).toBeNull();

    // 白噪声：包络没有周期，自相关在噪声水平，直接判成没有节拍（返回 null，而不是给一个低置信的 BPM）
    const random = rng(10);
    const noise = new Float32Array(RATE * 15).map(() => (random() - 0.5) * 0.6);
    expect(detectBeats(noise, RATE)).toBeNull();

    // 像说话：长短不一的音节，间隔随机
    const speech = new Float32Array(RATE * 20);
    for (let at = 0.2 * RATE; at < speech.length;) {
      const length = (0.08 + random() * 0.17) * RATE;
      const pitch = 120 + random() * 120;
      const amp = 0.2 + random() * 0.4;
      for (let i = 0; i < length && at + i < speech.length; i++) {
        const env = Math.sin((Math.PI * i) / length);
        speech[at + i] = amp * env * (Math.sin((2 * Math.PI * pitch * i) / RATE) * 0.7 + (random() - 0.5) * 0.5);
      }
      at += length + (0.05 + random() * 0.35 + (random() < 0.1 ? 0.8 : 0)) * RATE;
    }
    expect(detectBeats(speech, RATE)).toBeNull();
  });

  it("handles three minutes of audio quickly", () => {
    const { pcm } = clickTrack({ bpm: 128, seconds: 180, seed: 12 });
    const started = performance.now();
    const result = detectBeats(pcm, RATE)!;
    // 空闲时约 0.3 秒；并行跑测试、Windows CI 会慢好几倍，上限只防退化成平方级
    expect(performance.now() - started).toBeLessThan(5000);
    expect(Math.abs(result.bpm - 128)).toBeLessThanOrEqual(1);
    expect(result.beats.length).toBeGreaterThan(370);
  });
});

describe("detectBeats regressions", () => {
  it("keeps the beats of a quiet piano intro and marks the drop after it as strong", () => {
    for (const [introBars, buildBars] of [[2, 2], [4, 0]] as const) {
      const song = danceTrack(128, 0.3 + (introBars + buildBars + 4) * 4 * (60 / 128), { introBars, buildBars });
      const result = detectBeats(song.pcm, RATE)!;
      expect(Math.abs(result.bpm - 128)).toBeLessThanOrEqual(2);
      expect(share(song.truth.filter((time) => time < song.introEnd - 0.01), result.beats, 0.03)).toBeGreaterThan(0.9);
      expect(result.strong.some((time) => Math.abs(time - song.drop) <= 0.05)).toBe(true);
    }
  });

  it("puts the beats on the downbeat of a soft 808-style kick under off-beat bass and hats", () => {
    for (const bpm of [128, 150]) {
      const { pcm, truth } = danceTrack(bpm, 12, { click: 0 });
      const result = detectBeats(pcm, RATE)!;
      expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(2);
      expect(share(truth, result.beats, 0.03)).toBeGreaterThan(0.9);
      expect(share(result.beats, truth, 0.03)).toBeGreaterThan(0.9);
    }
  });

  it("does not double a hip-hop groove because of a voice-over between the beats", () => {
    const { pcm, truth } = boomBap(90, 12);
    const result = detectBeats(voiceOver(pcm, 0.45, 101, 0.2), RATE)!;
    expect(Math.abs(result.bpm - 90)).toBeLessThanOrEqual(2);
    // 翻倍时只有一半拍点落在真拍上
    expect(share(result.beats, truth, 0.03)).toBeGreaterThan(0.8);
  });

  it("still finds the tempo of background music sitting about 10 dB under a voice-over", () => {
    const dance = danceTrack(120, 10);
    const under = detectBeats(voiceOver(dance.pcm, 0.3, 102, 0.8), RATE)!;
    expect(under).not.toBeNull();
    expect(Math.abs(under.bpm - 120)).toBeLessThanOrEqual(2);
    // 人声的起音偶尔会把个别拍点拽开几十毫秒，按卡点的容差算
    expect(share(dance.truth, under.beats, 0.08)).toBeGreaterThan(0.9);

    const groove = boomBap(90, 10);
    const hiphop = detectBeats(voiceOver(groove.pcm, 0.45, 103, 0.8), RATE)!;
    expect(hiphop).not.toBeNull();
    expect(Math.abs(hiphop.bpm - 90)).toBeLessThanOrEqual(2);
  });
});

describe("alignCutsToBeats", () => {
  it("counts cuts on the beat and reports the signed median offset", () => {
    expect(alignCutsToBeats([0.52, 0.97, 1.3, 2.08], [0, 0.5, 1, 1.5, 2])).toEqual({ onBeat: 3, total: 4, medianOffset: -0.005 });
    expect(alignCutsToBeats([0.52, 0.97, 1.3, 2.08], [2, 1.5, 1, 0.5, 0], 0.025)).toMatchObject({ onBeat: 1 });
    expect(alignCutsToBeats([], [1, 2])).toEqual({ onBeat: 0, total: 0, medianOffset: 0 });
    expect(alignCutsToBeats([1, 2], [])).toEqual({ onBeat: 0, total: 2, medianOffset: 0 });
  });
});
