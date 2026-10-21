// 参考视频「看」工具的纯算法部分：镜头切分、闪白闪黑、音乐节拍、剪辑点卡拍统计。
// 模型收不了视频时，浏览器那边把视频解成小灰度帧和单声道 PCM 交给这里，算出数字再连同截图发给模型。
// 这里不碰 DOM，方便在 Node 里直接测。

export interface FrameSample { t: number; gray: Uint8Array | Uint8ClampedArray; mean: number }

const round2 = (value: number) => Math.round(value * 100) / 100;

function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const meanAbs = (a: Float32Array, b: Float32Array) => {
  const count = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < count; i++) sum += Math.abs(a[i]! - b[i]!);
  return count ? sum / count : 0;
};

// ---------- 镜头 ----------

// 缩略图逐行排列，调用方固定画成 16:9（64x36）；按这个比例推宽度，推不出来就当成一行
function frameWidth(length: number): number {
  const guess = Math.round(Math.sqrt((length * 16) / 9));
  for (let d = 0; d <= 4; d++) for (const width of [guess - d, guess + d]) if (width > 0 && length % width === 0) return width;
  return length;
}

const BINS = 16;
// 结构差先减均值、除以对比度再比，整体变亮变暗（渐黑、频闪、开灯）几乎不动它；换镜头一定动它
const STD_FLOOR = 8;
const STRUCTURE_MIN = 0.3;
// 对比度低到这个程度就是一张纯色画面（黑场、白场）
const BLANK_STD = 2;
// 闪黑、渐黑的过渡一般在半秒内；更长的纯色画面（纯色底的转场卡）算一个镜头
const BLANK_MAX = 0.5;
// 夜景这类低对比画面，像素差按对比度放大到和正常画面一个量级，不然换镜头也凑不够切点的门槛
const CONTRAST_REF = 40;
const CONTRAST_FLOOR = 8;
// 运镜补偿：半分辨率下左右各挪 2 格、上下各 1 格（原图 ±4 / ±2 像素）取最小差，慢摇、手持晃动不再像换镜头
const SHIFT_X = 2;
const SHIFT_Y = 1;

interface FrameFeature {
  small: Float32Array;
  // small 往右、往下、往右下挪半格的版本：运镜补偿能对到原图 1 像素，带硬边的画面慢摇时才对得齐
  halves: Float32Array[];
  z: Float32Array;
  width: number;
  height: number;
  mean: number;
  std: number;
}

function halfShifts(small: Float32Array, width: number, height: number): Float32Array[] {
  const at = (x: number, y: number) => small[Math.min(height - 1, y) * width + Math.min(width - 1, x)]!;
  const right = new Float32Array(small.length);
  const down = new Float32Array(small.length);
  const both = new Float32Array(small.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    right[i] = (at(x, y) + at(x + 1, y)) / 2;
    down[i] = (at(x, y) + at(x, y + 1)) / 2;
    both[i] = (at(x, y) + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1)) / 4;
  }
  return [small, right, down, both];
}

// 2x2 平均成半分辨率：压掉逐像素噪声，运镜补偿也只用挪一半的格子
function frameFeature(gray: Uint8Array | Uint8ClampedArray): FrameFeature {
  const fullWidth = frameWidth(gray.length);
  const fullHeight = Math.max(1, Math.floor(gray.length / fullWidth));
  const width = Math.max(1, fullWidth >> 1);
  const height = Math.max(1, fullHeight >> 1);
  const rows = fullHeight > 1 ? 2 : 1;
  const small = new Float32Array(width * height);
  let sum = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let cell = 0;
    for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < 2; dx++) cell += gray[(y * rows + dy) * fullWidth + x * 2 + dx] ?? 0;
    const value = cell / (rows * 2);
    small[y * width + x] = value;
    sum += value;
  }
  const count = small.length;
  const mean = sum / count;
  let spread = 0;
  for (let i = 0; i < count; i++) spread += (small[i]! - mean) ** 2;
  const std = Math.sqrt(spread / count);
  const z = new Float32Array(count);
  for (let i = 0; i < count; i++) z[i] = (small[i]! - mean) / Math.max(std, STD_FLOOR);
  return { small, halves: halfShifts(small, width, height), z, width, height, mean, std };
}

function shiftedDiff(a: Float32Array, b: Float32Array, width: number, height: number, dx: number, dy: number): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
    const rowA = y * width;
    const rowB = (y + dy) * width + dx;
    const from = Math.max(0, -dx);
    const to = Math.min(width, width - dx);
    for (let x = from; x < to; x++) sum += Math.abs(a[rowA + x]! - b[rowB + x]!);
    count += Math.max(0, to - from);
  }
  return count ? sum / count : 0;
}

interface Alignment { diff: number; dx: number; dy: number; b: Float32Array }

// 平移后最像的那个位置（bs 是同一帧挪过半格的几个版本）；画面太小挪不动就只比原位
function align(a: Float32Array, bs: Float32Array[], width: number, height: number): Alignment {
  let best: Alignment = { diff: shiftedDiff(a, bs[0]!, width, height, 0, 0), dx: 0, dy: 0, b: bs[0]! };
  const reachX = width > SHIFT_X * 4 ? SHIFT_X : 0;
  const reachY = height > SHIFT_Y * 4 ? SHIFT_Y : 0;
  for (const b of reachX || reachY ? bs : []) for (let dy = -reachY; dy <= reachY; dy++) for (let dx = -reachX; dx <= reachX; dx++) {
    const diff = shiftedDiff(a, b, width, height, dx, dy);
    if (diff < best.diff) best = { diff, dx, dy, b };
  }
  return best;
}

// 软分箱：平铺画面亮度动一两级不会整格跳到隔壁箱，否则一点曝光变化就像切了镜头
function addToHist(hist: Float32Array, value: number) {
  const pos = (Math.max(0, Math.min(255, value)) / 255) * (BINS - 1);
  const lo = Math.min(BINS - 2, Math.floor(pos));
  const weight = pos - lo;
  hist[lo] = hist[lo]! + 1 - weight;
  hist[lo + 1] = hist[lo + 1]! + weight;
}

// 只比两帧对齐后重叠的那部分的亮度分布：摇镜头时从边上进来的新内容不算进去
function overlapHistDiff(a: Float32Array, { dx, dy, b }: Alignment, width: number, height: number): number {
  const ha = new Float32Array(BINS);
  const hb = new Float32Array(BINS);
  let count = 0;
  for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
    for (let x = Math.max(0, -dx); x < Math.min(width, width - dx); x++) {
      addToHist(ha, a[y * width + x]!);
      addToHist(hb, b[(y + dy) * width + x + dx]!);
      count++;
    }
  }
  let sum = 0;
  for (let k = 0; k < BINS; k++) sum += Math.abs(ha[k]! - hb[k]!);
  return count ? sum / count / 2 : 0;
}

const sameShape = (a: FrameFeature, b: FrameFeature) => a.width === b.width && a.height === b.height;

// 以画面中心放大 scale 倍（双线性取样）
function magnify(image: Float32Array, width: number, height: number, scale: number): Float32Array {
  const out = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const at = (x: number, y: number) => image[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = cx + (x - cx) / scale;
    const sy = cy + (y - cy) / scale;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    out[y * width + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
  return out;
}

// 3x3 均值模糊：快运镜的帧本身带拖影，和清楚的帧比之前先一起糊一下
function soften(image: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < height && xx >= 0 && xx < width) { sum += image[yy * width + xx]!; count++; }
    }
    out[y * width + x] = sum / count;
  }
  return out;
}

// 快速推拉、甩镜头：挪一大截（原图 ±20/±6 像素）或放大缩小以后能和上一帧对上，剩下的差不到原来的三成
const MOVE_SHIFT_X = 10;
const MOVE_SHIFT_Y = 3;
const MOVE_SCALES = [1.1, 1.2, 1.32, 1.44, 1.6, 1.73, 2.07];
const MOVE_EXPLAINED = 0.3;

function cameraMove(a: FrameFeature, b: FrameFeature): boolean {
  if (!sameShape(a, b)) return false;
  const { width, height } = a;
  const softA = soften(a.small, width, height);
  const softB = soften(b.small, width, height);
  const enough = shiftedDiff(softA, softB, width, height, 0, 0) * MOVE_EXPLAINED;
  const reachX = Math.min(MOVE_SHIFT_X, width >> 2);
  const reachY = Math.min(MOVE_SHIFT_Y, height >> 2);
  for (let dy = -reachY; dy <= reachY; dy++) for (let dx = -reachX; dx <= reachX; dx++) {
    if (shiftedDiff(softA, softB, width, height, dx, dy) <= enough) return true;
  }
  for (const scale of MOVE_SCALES) {
    if (meanAbs(magnify(softA, width, height, scale), softB) <= enough || meanAbs(magnify(softB, width, height, scale), softA) <= enough) return true;
  }
  return false;
}

// 0~2：画面内容差（0~1，已扣掉运镜、按对比度放大）+ 亮度分布差（0~1）。手持晃动主要动前一项，换镜头两项一般都跳
function frameDistance(a: FrameFeature, b: FrameFeature): number {
  if (!sameShape(a, b)) return 2;
  const boost = Math.max(1, CONTRAST_REF / Math.max(a.std, b.std, CONTRAST_FLOOR));
  const best = align(a.small, b.halves, a.width, a.height);
  return Math.min(1, (best.diff * boost) / 255) + overlapHistDiff(a.small, best, a.width, a.height);
}

const structureDiff = (a: FrameFeature, b: FrameFeature) => (sameShape(a, b) ? align(a.z, [b.z], a.width, a.height).diff : Infinity);

// 是不是真换了画面：结构变了，或者两张纯色画面亮度差得多（纯色标题卡互切）
function contentChanged(a: FrameFeature, b: FrameFeature): boolean {
  if (a.std < BLANK_STD && b.std < BLANK_STD) return Math.abs(a.mean - b.mean) > 30;
  return structureDiff(a, b) >= STRUCTURE_MIN;
}

const FLASH_JUMP = 90;
const FLASH_MAX = 0.5;
// 本来就亮的画面闪白（或本来就暗的闪黑）跳不了 90：离饱和还剩多少，跳过其中六成也算，但至少 40
const FLASH_HEADROOM = 0.6;
const FLASH_MIN_JUMP = 40;
const flashJump = (level: number, sign: number) => Math.min(FLASH_JUMP, Math.max(FLASH_MIN_JUMP, FLASH_HEADROOM * (sign > 0 ? 255 - level : level)));
// 闪光帧要么接近纯色（白场、黑场），要么是白/黑叠在原画面上（结构和前后帧一样）；有自己纹理的亮帧是一个真镜头
const FLASH_STD = 12;

interface FlashRun { from: number; to: number; peak: number }

// 亮度一下子离开前一帧的水平（超过 flashJump），0.5 秒内又落回来，而且峰值也离开了落回后的水平
function findFlashRuns(samples: FrameSample[], features: FrameFeature[]): FlashRun[] {
  const runs: FlashRun[] = [];
  let i = 1;
  while (i < samples.length) {
    const before = samples[i - 1]!.mean;
    const jump = samples[i]!.mean - before;
    const sign = Math.sign(jump);
    const needed = flashJump(before, sign);
    if (Math.abs(jump) <= needed) { i++; continue; }
    let j = i;
    let peak = i;
    while (j < samples.length && sign * (samples[j]!.mean - before) > needed) {
      if (sign * (samples[j]!.mean - samples[peak]!.mean) > 0) peak = j;
      j++;
    }
    const after = samples[j];
    const brief = after && samples[j - 1]!.t - samples[i]!.t <= FLASH_MAX + 1e-6 && sign * (samples[peak]!.mean - after.mean) > flashJump(after.mean, sign);
    if (!brief) { i = j; continue; }
    let plain = true;
    for (let k = i; k < j && plain; k++) {
      const frame = features[k]!;
      plain = frame.std < FLASH_STD || structureDiff(frame, features[i - 1]!) < STRUCTURE_MIN || structureDiff(frame, features[j]!) < STRUCTURE_MIN;
    }
    if (plain) runs.push({ from: i, to: j - 1, peak });
    // 下一段从闪光后那一帧往后比，不能再拿闪光帧当基准，不然紧跟着的正常画面也像一次「闪黑」
    i = j + 1;
  }
  return runs;
}

export function detectFlashes(samples: FrameSample[]): number[] {
  const features = samples.map((sample) => frameFeature(sample.gray));
  return findFlashRuns(samples, features).map((run) => round2(samples[run.peak]!.t));
}

// 切点判定：比左右各 2 秒内变化量中位数里较大的那个高出一截。
// 取较大的一侧，是为了运镜刚开始/刚停的那一下不被当成切镜（另一侧还在动）。
const SHOT_WINDOW = 2;
const CUT_MIN = 0.06;
const CUT_RATIO = 2.5;
const CUT_MARGIN = 0.03;
const CUT_SURE = 0.6;
// 比两边至少一侧高出好几倍的尖峰先不算进背景：切得密时（一个镜头只有一两帧）中位数本身就是切点，门槛会被切点抬上去
const SPIKE_MIN = 0.15;
const SPIKE_RATIO = 4;
const TRANSIENT_MAX = 0.5;
// 中间那帧几乎落在前后两帧的连线上（叠化、渐变、甩镜头的拖影），连着的几下算一次转场
const GRADUAL = 0.8;

export function detectShots(samples: FrameSample[], duration: number, options: { minShot?: number } = {}): { start: number; end: number }[] {
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const minShot = options.minShot ?? 0.25;
  if (samples.length < 2 || end === 0) return [{ start: 0, end }];

  // 闪白闪黑、渐黑中间那一小段纯色帧先拿掉，两侧直接比：同一个镜头就不切，不同镜头只在中间切一刀
  const all = samples.map((sample) => frameFeature(sample.gray));
  const skip = new Array<boolean>(samples.length).fill(false);
  for (const run of findFlashRuns(samples, all)) for (let i = run.from; i <= run.to; i++) skip[i] = true;
  for (let i = 1; i < samples.length - 1; i++) {
    if (all[i]!.std >= BLANK_STD || all[i - 1]!.std < BLANK_STD) continue;
    let j = i;
    while (j < samples.length && all[j]!.std < BLANK_STD) j++;
    if (j < samples.length && samples[j - 1]!.t - samples[i]!.t <= BLANK_MAX + 1e-6) for (let k = i; k < j; k++) skip[k] = true;
    i = j - 1;
  }
  const kept: number[] = [];
  for (let i = 0; i < samples.length; i++) if (!skip[i]) kept.push(i);
  const features = kept.map((index) => all[index]!);
  const timeOf = (k: number) => samples[kept[k]!]!.t;

  const steps: { time: number; score: number }[] = [];
  for (let k = 1; k < kept.length; k++) {
    const a = kept[k - 1]!;
    const b = kept[k]!;
    const time = b - a > 1 ? (samples[a + 1]!.t + samples[b - 1]!.t) / 2 : (samples[a]!.t + samples[b]!.t) / 2;
    steps.push({ time, score: frameDistance(features[k - 1]!, features[k]!) });
  }

  const spike = steps.map((step, index) => {
    const lower = Math.min(steps[index - 1]?.score ?? Infinity, steps[index + 1]?.score ?? Infinity);
    return step.score >= SPIKE_MIN && step.score >= SPIKE_RATIO * lower;
  });
  const thresholds = steps.map((step, index) => {
    const side = (direction: -1 | 1) => {
      const scores: number[] = [];
      const calm: number[] = [];
      for (let j = index + direction; j >= 0 && j < steps.length && Math.abs(steps[j]!.time - step.time) <= SHOT_WINDOW; j += direction) {
        scores.push(steps[j]!.score);
        if (!spike[j]) calm.push(steps[j]!.score);
      }
      return median(calm.length ? calm : scores);
    };
    return Math.max(CUT_MIN, Math.max(side(-1), side(1)) * CUT_RATIO + CUT_MARGIN);
  });

  const picked: number[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const threshold = thresholds[index]!;
    if (step.score < CUT_SURE && step.score <= threshold) continue;
    // 明暗变了但画面结构没变（频闪、开灯、渐黑的一步）不算；叠化每一步结构变得少，所以也看半秒后的画面
    let later = index + 1;
    while (later + 1 < kept.length && timeOf(later + 1) - timeOf(index + 1) <= TRANSIENT_MAX + 1e-6) later++;
    if (!contentChanged(features[index]!, features[index + 1]!) && !contentChanged(features[index]!, features[later]!)) continue;
    // 前后一步也在大动、这一下又能用平移或推拉对上：是快运镜（推拉转场、甩镜头）的一段，不是切镜。
    // 前后都静止的那种突然放大（跳切式推近）照样算切点
    const moving = Math.max(steps[index - 1]?.score ?? 0, steps[index + 1]?.score ?? 0) >= threshold * 0.5;
    if (moving && cameraMove(features[index]!, features[index + 1]!)) continue;
    // 半秒内画面又回到切之前的样子：中间那段太短（不到 minShot 或只取到一帧）、或者自己就在乱动（遮挡、抖动特效），
    // 不算换镜头，连同中间那几下一起跳过；中间是一段稳定的别的画面，就是插进来的一个短镜头，照常切
    let back = -1;
    for (let k = index + 2; k < kept.length && timeOf(k) - timeOf(index + 1) <= TRANSIENT_MAX + 1e-6; k++) {
      const distance = frameDistance(features[index]!, features[k]!);
      if (distance <= threshold && distance < step.score * 0.4) { back = k; break; }
    }
    if (back >= 0) {
      let shaky = 0;
      for (let k = index + 1; k + 1 < back; k++) shaky = Math.max(shaky, frameDistance(features[k]!, features[k + 1]!));
      const short = back - index < 3 || timeOf(back) - timeOf(index + 1) < minShot;
      if (short || shaky >= step.score * 0.5) { index = back - 1; continue; }
    }
    picked.push(index);
  }

  const cuts: { time: number; score: number }[] = [];
  for (let p = 0; p < picked.length; p++) {
    const first = picked[p]!;
    let last = first;
    while (p + 1 < picked.length && picked[p + 1] === last + 1) {
      const a = features[last]!, mid = features[last + 1]!, b = features[last + 2]!;
      if (meanAbs(a.small, b.small) < GRADUAL * (meanAbs(a.small, mid.small) + meanAbs(mid.small, b.small))) break;
      last++;
      p++;
    }
    let score = 0;
    for (let k = first; k <= last; k++) score = Math.max(score, steps[k]!.score);
    cuts.push({ time: (steps[first]!.time + steps[last]!.time) / 2, score });
  }

  // 太近的切点只留变化最大的一个；离片头片尾太近的也并掉，免得出现一闪而过的镜头
  const merged: { time: number; score: number }[] = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.time - last.time < minShot) { if (cut.score > last.score) merged[merged.length - 1] = cut; continue; }
    merged.push(cut);
  }
  const bounds = [0];
  for (const cut of merged) {
    const time = round2(cut.time);
    if (time >= minShot && end - time >= minShot && time > bounds[bounds.length - 1]!) bounds.push(time);
  }
  bounds.push(end);
  return bounds.slice(1).map((stop, index) => ({ start: bounds[index]!, end: stop }));
}

// ---------- 节拍 ----------

export interface BeatResult { bpm: number; beats: number[]; strong: number[]; duration: number }

const MIN_BPM = 60;
const MAX_BPM = 200;

function fftTables(size: number) {
  const bits = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / size); sin[k] = -Math.sin((2 * Math.PI * k) / size); }
  return { reverse, cos, sin };
}

function fft(re: Float64Array, im: Float64Array, tables: ReturnType<typeof fftTables>) {
  const size = re.length;
  const { reverse, cos, sin } = tables;
  for (let i = 0; i < size; i++) {
    const j = reverse[i]!;
    if (j > i) {
      const r = re[i]!; re[i] = re[j]!; re[j] = r;
      const m = im[i]!; im[i] = im[j]!; im[j] = m;
    }
  }
  for (let span = 2; span <= size; span <<= 1) {
    const half = span >> 1;
    const stride = size / span;
    for (let start = 0; start < size; start += span) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride]!;
        const wi = sin[k * stride]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
}

// 对数频率分带：低于 150Hz 的三带是底鼓、贝斯，人声基频大多在这之上
const BAND_EDGES = [30, 60, 100, 150, 220, 330, 500, 750, 1100, 1700, 2600, 4000, 6000];
const LOW_BANDS = 3;

interface Onsets {
  // 各带对数幅度的正向变化量、各带等权相加：找拍子用，响度大小影响小。
  // 不按频点等权加：底鼓只占最低几个频点，反拍的镲和贝斯起音却点亮几百个频点，会把拍子拉到反拍上
  flux: Float32Array;
  // 只算最低三带的同一种变化：旁白盖住音乐时，低频里还是底鼓和贝斯
  low: Float32Array;
  // 线性幅度谱的正向变化量：重音、判快慢一倍要看真实的响度跳变
  punch: Float32Array;
  // 同样的线性跳变只算 150Hz 以下（底鼓的冲击）：盖着旁白时拿它代替 punch
  kick: Float32Array;
  // 每帧响度（RMS 量级），找 drop、副歌进来这种整段变响的地方
  loud: Float32Array;
  hopSec: number;
  // 第 f 帧对应的时间 = f * hopSec + offset
  offset: number;
}

function onsetEnvelope(pcm: Float32Array, sampleRate: number): Onsets | null {
  // 先降到 11 kHz 左右（相邻样本平均），三分钟音频的 FFT 才能压在一两百毫秒
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const rate = sampleRate / factor;
  const length = Math.floor(pcm.length / factor);
  const x = new Float32Array(length);
  let energy = 0;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += pcm[i * factor + k]!;
    const value = sum / factor;
    x[i] = value;
    energy += value * value;
  }
  const rms = Math.sqrt(energy / Math.max(1, length));
  if (!(rms > 1e-4)) return null;

  // 约 46 ms 汉宁窗、10 ms 一跳；整体按 RMS 归一，对数压缩的效果才不随音量变
  const size = 2 ** Math.floor(Math.log2(rate * 0.05));
  const hop = Math.max(1, Math.round(rate * 0.01));
  const frames = length >= size ? Math.floor((length - size) / hop) + 1 : 0;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)) / rms;
  const tables = fftTables(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const half = size / 2;
  // 每个频点归哪一带；超出范围的记 -1
  const binWidth = rate / size;
  const bandOf = new Int8Array(half).fill(-1);
  const bandSize = new Float64Array(BAND_EDGES.length - 1);
  for (let k = 1; k < half; k++) {
    const hz = k * binWidth;
    for (let b = 0; b + 1 < BAND_EDGES.length; b++) if (hz >= BAND_EDGES[b]! && hz < BAND_EDGES[b + 1]!) { bandOf[k] = b; bandSize[b]!++; }
  }
  const bands = bandSize.length;
  const bandSum = new Float64Array(bands);
  let prevBand = new Float64Array(bands);
  let nextBand = new Float64Array(bands);
  let prevLin = new Float32Array(half);
  let nextLin = new Float32Array(half);
  let prevLow = 0;
  const flux = new Float32Array(frames);
  const low = new Float32Array(frames);
  const kick = new Float32Array(frames);
  const punch = new Float32Array(frames);
  const loud = new Float32Array(frames);
  const norm = Math.sqrt(size * 0.375);

  const take = (frame: number, real: boolean) => {
    // 两帧实信号拼成一次复数 FFT，再按共轭对称拆开
    bandSum.fill(0);
    let total = 0;
    let lowEnergy = 0;
    for (let k = 1; k < half; k++) {
      const zr = re[k]!, zi = im[k]!, cr = re[size - k]!, ci = im[size - k]!;
      const magnitude = real ? Math.hypot(zr + cr, zi - ci) / 2 : Math.hypot(zi + ci, zr - cr) / 2;
      nextLin[k] = magnitude;
      const band = bandOf[k]!;
      if (band >= 0) bandSum[band] = bandSum[band]! + magnitude;
      if (band >= 0 && band < LOW_BANDS) lowEnergy += magnitude * magnitude;
      total += magnitude * magnitude;
    }
    for (let b = 0; b < bands; b++) nextBand[b] = bandSize[b] ? Math.log1p(bandSum[b]! / bandSize[b]!) : 0;
    const lowLevel = Math.sqrt(lowEnergy) / norm;
    loud[frame] = Math.sqrt(total) / norm;
    if (frame > 0) {
      let up = 0, upLow = 0, rise = 0;
      for (let b = 0; b < bands; b++) {
        const d = nextBand[b]! - prevBand[b]!;
        if (d > 0) { up += d; if (b < LOW_BANDS) upLow += d; }
      }
      for (let k = 1; k < half; k++) {
        const e = nextLin[k]! - prevLin[k]!;
        if (e > 0) rise += e;
      }
      flux[frame] = up;
      low[frame] = upLow;
      kick[frame] = Math.max(0, lowLevel - prevLow);
      punch[frame] = rise;
    }
    prevLow = lowLevel;
    [prevBand, nextBand] = [nextBand, prevBand];
    [prevLin, nextLin] = [nextLin, prevLin];
  };

  for (let f = 0; f < frames; f += 2) {
    const a = f * hop;
    const b = (f + 1) * hop;
    const second = f + 1 < frames;
    for (let i = 0; i < size; i++) {
      re[i] = x[a + i]! * window[i]!;
      im[i] = second ? x[b + i]! * window[i]! : 0;
    }
    fft(re, im, tables);
    take(f, true);
    if (second) take(f + 1, false);
  }
  // 对数压缩下，起音刚进窗口后半段变化量就最大，不是窗口中心；0.7 是拿点击、底鼓、拨弦实测校出来的
  return { flux, low, kick, punch, loud, hopSec: hop / rate, offset: (0.7 * size) / rate };
}

const tempoPrior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 113) / 0.9) ** 2);
const REPEATS = 4;

interface Tempo { period: number; steady: number; acf: Float64Array }

// 包络自相关在 60~200 BPM 里找峰，乘一个偏向 80~160 的温和权重，压掉快一倍/慢一倍的误判。
// 只看一拍间隔不够：说话的音节间隔也有个大概的数，一拍上的相关能到 0.2 以上。
// 真音乐隔 2、3、4 拍照样对得上，说话隔几个音节就散了，所以拿 1~4 拍的平均相关当节奏稳不稳的分数（steady）。
function estimatePeriod(flux: Float32Array, hopSec: number): Tempo | null {
  const n = flux.length;
  const lagMin = Math.floor(60 / MAX_BPM / hopSec);
  const lagMax = Math.ceil(60 / MIN_BPM / hopSec);
  if (n < lagMax * 3) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i]!;
  mean /= n;
  const centered = new Float64Array(n);
  let power = 0;
  for (let i = 0; i < n; i++) { const v = flux[i]! - mean; centered[i] = v; power += v * v; }
  power /= n;
  if (!(power > 0)) return null;
  const longest = Math.min(lagMax * REPEATS + 3, Math.floor(n / 2));
  const acf = new Float64Array(longest + 1);
  // 从半拍那么短的间隔就开始算：判要不要加倍时要看半拍上的相关
  for (let lag = Math.max(1, Math.floor(lagMin / 2) - 1); lag <= longest; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += centered[i]! * centered[i + lag]!;
    acf[lag] = sum / (n - lag) / power;
  }
  const near = (lag: number) => {
    let value = -Infinity;
    for (let d = -2; d <= 2; d++) { const at = Math.round(lag) + d; if (at >= lagMin - 1 && at <= longest) value = Math.max(value, acf[at]!); }
    return value;
  };
  let best: { period: number; steady: number; score: number } | null = null;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const left = acf[lag - 1]!, mid = acf[lag]!, right = acf[lag + 1]!;
    if (!(mid > 0 && mid > left && mid >= right)) continue;
    const curve = left - 2 * mid + right;
    const period = lag + (curve < 0 ? (0.5 * (left - right)) / curve : 0);
    const bpm = 60 / (period * hopSec);
    if (bpm < MIN_BPM - 1 || bpm > MAX_BPM + 1) continue;
    let steady = mid;
    let count = 1;
    for (let k = 2; k <= REPEATS && period * k + 2 <= longest; k++) { steady += near(period * k); count++; }
    steady /= count;
    const score = steady * tempoPrior(bpm);
    if (!best || score > best.score) best = { period, steady, score };
  }
  return best ? { period: best.period, steady: best.steady, acf } : null;
}

// 噪声的相关只有 1/√n 量级；模拟的说话（长短随机的音节）不到 0.1，叠了旁白的鼓点在低频那条上也有 0.25 以上
const STEADY_MIN = 0.18;
// 全频那条被人声搅乱（周期性不到低频那条的三分之二）时改用低频那条
const BASS_SWITCH = 1.5;
const HALF_STEADY = 0.8;

// 某个间隔上的「稳定度」：隔 1~4 个这样的间隔都对得上的程度
function steadyAt(acf: Float64Array, period: number): number {
  let sum = 0;
  let count = 0;
  for (let k = 1; k <= REPEATS; k++) {
    let value = -Infinity;
    for (let d = -2; d <= 2; d++) { const at = Math.round(period * k) + d; if (at > 0 && at < acf.length) value = Math.max(value, acf[at]!); }
    if (value > -Infinity) { sum += value; count++; }
  }
  return count ? sum / count : 0;
}

// 对数谱把踩镲也抬得和鼓一样响，八分音符的踩镲容易让速度翻倍；反过来军鼓落在反拍又会被听成慢一半。
// 用线性响度再核一次：隔一拍一强一弱差三倍以上就减半，拍与拍正中间也有接近拍点的重击就加倍。
// 加倍还要包络在半拍上本身就有周期性：旁白的音节随机落在两拍中间，能把中点的响度抬起来，但半拍上对不齐
function octaveFactor(punch: Float32Array, acf: Float64Array, period: number, phase: number, hopSec: number): number {
  const reach = period / 8;
  const peakNear = (pos: number) => {
    let value = 0;
    for (let i = Math.max(0, Math.ceil(pos - reach)); i <= Math.min(punch.length - 1, Math.floor(pos + reach)); i++) value = Math.max(value, punch[i]!);
    return value;
  };
  const beats: number[] = [];
  for (let pos = phase; pos < punch.length - 0.5; pos += period) beats.push(peakNear(pos));
  // 都跟相邻的拍比、再取中位数：安静前奏接响 drop 这种整段的响度差不会掺进来；几乎没声的地方不算
  const audible = median(beats) * 0.1;
  const lean: number[] = [];
  for (let k = 0; k + 1 < beats.length; k += 2) {
    const a = beats[k]!, b = beats[k + 1]!;
    if (Math.max(a, b) > audible) lean.push(Math.log(Math.max(a, 1e-9) / Math.max(b, 1e-9)));
  }
  const middle: number[] = [];
  for (let k = 0; k + 1 < beats.length; k++) {
    const side = (beats[k]! + beats[k + 1]!) / 2;
    if (side > audible) middle.push(peakNear(phase + (k + 0.5) * period) / side);
  }
  const bpm = 60 / (period * hopSec);
  if (bpm / 2 >= MIN_BPM - 1 && lean.length && Math.abs(median(lean)) >= Math.log(3)) return 2;
  const halfSteady = steadyAt(acf, period / 2) >= HALF_STEADY * steadyAt(acf, period);
  if (bpm * 2 <= MAX_BPM + 1 && middle.length && median(middle) >= 0.6 && halfSteady) return 0.5;
  return 1;
}

// 在 ±3% 的周期和全部相位里找一组网格，让网格点上的包络（稍微抹平）平均最大
function fitGrid(flux: Float32Array, period: number): { period: number; phase: number } {
  const n = flux.length;
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = flux[i]!;
    let weight = 1;
    for (const [d, w] of [[1, 0.5], [2, 0.25]] as const) {
      if (i - d >= 0) { sum += flux[i - d]! * w; weight += w; }
      if (i + d < n) { sum += flux[i + d]! * w; weight += w; }
    }
    smooth[i] = sum / weight;
  }
  let best = { period, phase: 0, score: -Infinity };
  for (let k = -30; k <= 30; k++) {
    const p = period * (1 + k * 0.001);
    for (let phase = 0; phase < p; phase += 0.5) {
      let sum = 0;
      let count = 0;
      for (let pos = phase; pos < n - 0.5; pos += p) { sum += smooth[Math.round(pos)]!; count++; }
      const score = count ? sum / count : 0;
      if (score > best.score) best = { period: p, phase, score };
    }
  }
  return best;
}

interface Snapped { pos: number; peak: number; sure: boolean }

// 「够高」跟前后约 4 秒比，不跟整首比：安静的前奏每拍都有起音，只是没有 drop 之后响，不能当成没音乐裁掉
const LOCAL_SPAN = 4;
// 但局部本身也得有起音：前后 4 秒的拍点比底噪高出的量不到整首的一成半，就是没音乐的空白
const LOCAL_MIN = 0.15;

// 每个网格点在 ±1/8 拍内找包络最高处；够高才吸过去，否则（漏拍、间奏）留在网格上
function snapGrid(flux: Float32Array, period: number, phase: number, hopSec: number): Snapped[] {
  const n = flux.length;
  const reach = period / 8;
  const beats: Snapped[] = [];
  for (let pos = phase; pos < n - 0.5; pos += period) {
    const lo = Math.max(0, Math.ceil(pos - reach));
    const hi = Math.min(n - 1, Math.floor(pos + reach));
    let at = Math.round(pos);
    let peak = -Infinity;
    for (let i = lo; i <= hi; i++) if (flux[i]! > peak) { peak = flux[i]!; at = i; }
    beats.push({ pos: at, peak, sure: false });
  }
  const typical = median(beats.map((beat) => beat.peak));
  const floor = median(flux);
  const span = LOCAL_SPAN / hopSec;
  // 底噪取局部中位数；隔 4 帧取一个样就够，三分钟的歌也不慢
  const localFloor = (pos: number) => {
    const values: number[] = [];
    for (let i = Math.max(0, Math.round(pos - span)); i <= Math.min(n - 1, Math.round(pos + span)); i += 4) values.push(flux[i]!);
    return median(values);
  };
  for (const beat of beats) {
    const near = beats.filter((other) => Math.abs(other.pos - beat.pos) <= span).map((other) => other.peak);
    const base = localFloor(beat.pos);
    const local = median(near);
    beat.sure = beat.peak > base && beat.peak - base >= 0.3 * (local - base) && local - base >= LOCAL_MIN * (typical - floor);
  }
  return beats.map((beat, index) => (beat.sure ? beat : { ...beat, pos: phase + index * period }));
}

// 拍点比底噪至少高这么多（按每个频带算）；只有持续嗡声的音频到不了
const MIN_ONSET = 0.25;
const DROP_LIFT = 1.6;
// 比整首平均响度低这么多算静音：后面再响也不叫 drop，是音乐刚开始
const SILENT_LEVEL = 0.05;
const QUIET_BEATS = 8;
const MAX_STRONG = 40;

export function detectBeats(samples: Float32Array, sampleRate: number): BeatResult | null {
  if (!(sampleRate > 0) || samples.length < sampleRate * 3) return null;
  const onsets = onsetEnvelope(samples, sampleRate);
  if (!onsets) return null;
  const { loud, hopSec, offset } = onsets;
  // 先用全频那条包络；旁白、说话盖住垫乐时它的周期性会塌，低频那条（底鼓、贝斯）还在，就换成低频那条
  const full = estimatePeriod(onsets.flux, hopSec);
  const bass = full && full.steady * BASS_SWITCH >= 1 ? null : estimatePeriod(onsets.low, hopSec);
  const useBass = !!bass && (!full || bass.steady > full.steady * BASS_SWITCH);
  const tempo = useBass ? bass : full;
  const flux = useBass ? onsets.low : onsets.flux;
  // 重音、快慢一倍也跟着换：盖着旁白时全频的响度跳变大多是人声音节
  const punch = useBass ? onsets.kick : onsets.punch;
  if (!tempo || tempo.steady < STEADY_MIN || tempo.steady * Math.sqrt(flux.length) < 6) return null;
  let { period, phase } = fitGrid(flux, tempo.period);
  const factor = octaveFactor(punch, tempo.acf, period, phase, hopSec);
  if (factor !== 1) ({ period, phase } = fitGrid(flux, period * factor));
  let grid = snapGrid(flux, period, phase, hopSec);

  // 用吸附上的拍子做一次直线拟合，周期和起点再校准一次：三分钟的歌差千分之一就会漂出去
  const sure = grid.map((beat, index) => ({ index, pos: beat.pos, sure: beat.sure })).filter((beat) => beat.sure);
  if (sure.length >= 4) {
    const count = sure.length;
    const meanIndex = sure.reduce((sum, beat) => sum + beat.index, 0) / count;
    const meanPos = sure.reduce((sum, beat) => sum + beat.pos, 0) / count;
    let cov = 0, varIndex = 0;
    for (const beat of sure) { cov += (beat.index - meanIndex) * (beat.pos - meanPos); varIndex += (beat.index - meanIndex) ** 2; }
    const fitted = varIndex > 0 ? cov / varIndex : period;
    if (Math.abs(fitted / period - 1) < 0.03) {
      period = fitted;
      phase = meanPos - meanIndex * fitted;
      while (phase - period >= -0.5) phase -= period;
      while (phase < -0.5) phase += period;
      grid = snapGrid(flux, period, phase, hopSec);
    }
  }

  // 整首都没有明显起音（例如只有持续底噪的嗡声）也不算有节拍
  const floor = median(flux);
  if (median(grid.map((beat) => beat.peak)) - floor < MIN_ONSET * (useBass ? LOW_BANDS : BAND_EDGES.length - 1)) return null;

  // 掐掉开头结尾没音乐的部分；中间连续 8 拍以上都没起音，当成音乐停了
  const keep = grid.map((beat) => beat.sure);
  const first = keep.indexOf(true);
  const last = keep.lastIndexOf(true);
  if (first < 0) return null;
  for (let i = first; i <= last;) {
    if (keep[i]) { i++; continue; }
    let j = i;
    while (j <= last && !keep[j]) j++;
    if (j - i < QUIET_BEATS) for (let k = i; k < j; k++) keep[k] = true;
    i = j;
  }
  const toTime = (pos: number) => pos * hopSec + offset;
  const beats: number[] = [];
  const beatPeaks: { time: number; pos: number; punch: number }[] = [];
  for (let i = first; i <= last; i++) {
    if (!keep[i]) continue;
    const time = round2(toTime(grid[i]!.pos));
    if (time < 0 || (beats.length && time <= beats[beats.length - 1]!)) continue;
    beats.push(time);
    const center = grid[i]!.pos;
    let best = 0;
    for (let f = Math.max(0, Math.ceil(center - period / 8)); f <= Math.min(punch.length - 1, Math.floor(center + period / 8)); f++) best = Math.max(best, punch[f]!);
    beatPeaks.push({ time, pos: center, punch: best });
  }

  // drop、副歌进来：后 2 秒的 RMS 比前 2 秒大六成以上，取前后 2 秒内变化最大的那一拍。
  // 前面那 2 秒直接看音频本身，不要求那里认出了拍子（安静的前奏、铺垫常常认不出来）；
  // 只要求前面有 2 秒、而且不是静音，后面至少 1 秒，不然片头第一下、片尾最后一下都会被当成变响
  const span = Math.round(2 / hopSec);
  const sums = new Float64Array(loud.length + 1);
  for (let f = 0; f < loud.length; f++) sums[f + 1] = sums[f]! + loud[f]!;
  const average = (from: number, to: number) => {
    const a = Math.max(0, Math.min(loud.length, Math.round(from)));
    const b = Math.max(0, Math.min(loud.length, Math.round(to)));
    return b > a ? (sums[b]! - sums[a]!) / (b - a) : 0;
  };
  const quiet = (sums[loud.length]! / Math.max(1, loud.length)) * SILENT_LEVEL;
  const lifts = beatPeaks.map((beat) => {
    if (beat.pos - span < 0 || beat.pos + span / 2 > loud.length) return 0;
    const before = average(beat.pos - span, beat.pos);
    return before > quiet ? average(beat.pos, beat.pos + span) / before : 0;
  });
  const accents: { time: number; ratio: number }[] = [];
  beatPeaks.forEach((beat, index) => {
    const lift = lifts[index]!;
    if (lift < DROP_LIFT) return;
    const rival = beatPeaks.some((other, j) => j !== index && Math.abs(other.time - beat.time) <= 2 && (lifts[j]! > lift || (lifts[j] === lift && j < index)));
    if (!rival) accents.push({ time: beat.time, ratio: 100 + lift });
  });

  // 重音：线性响度跳变比前后 3 秒内拍点的中位水平高出六成以上；只看有拍子的那一段，免得把音乐外的说话爆破音算进来
  const globalPunch = median(beatPeaks.map((beat) => beat.punch));
  const reach = Math.max(1, Math.round(0.15 / hopSec));
  const from = beats.length ? beats[0]! - 0.2 : Infinity;
  const to = beats.length ? beats[beats.length - 1]! + 0.2 : -Infinity;
  for (let f = 1; f < punch.length - 1; f++) {
    const value = punch[f]!;
    if (!(value > 0) || toTime(f) < from || toTime(f) > to) continue;
    let isPeak = true;
    for (let d = 1; d <= reach && isPeak; d++) {
      if ((f - d >= 0 && punch[f - d]! > value) || (f + d < punch.length && punch[f + d]! >= value)) isPeak = false;
    }
    if (!isPeak) continue;
    const time = toTime(f);
    const nearby = beatPeaks.filter((beat) => Math.abs(beat.time - time) <= 3).map((beat) => beat.punch);
    const reference = Math.max(nearby.length ? median(nearby) : globalPunch, globalPunch * 0.25);
    if (!(reference > 0)) continue;
    const ratio = value / reference;
    if (ratio >= 1.6 && !accents.some((accent) => Math.abs(accent.time - time) < 0.15)) accents.push({ time: round2(time), ratio });
  }
  // drop 排在最前，再按重音强弱取前 40 个
  const strong = accents.sort((a, b) => b.ratio - a.ratio).slice(0, MAX_STRONG).map((accent) => accent.time).sort((a, b) => a - b);

  const bpm = Math.round((60 / (period * hopSec)) * 10) / 10;
  return { bpm, beats, strong, duration: round2(samples.length / sampleRate) };
}

// ---------- 卡点 ----------

export function alignCutsToBeats(cuts: number[], beats: number[], tolerance = 0.08): { onBeat: number; total: number; medianOffset: number } {
  if (!cuts.length || !beats.length) return { onBeat: 0, total: cuts.length, medianOffset: 0 };
  const sorted = [...beats].sort((a, b) => a - b);
  const offsets = cuts.map((cut) => {
    let lo = 0, hi = sorted.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= cut) lo = mid; else hi = mid;
    }
    const a = cut - sorted[lo]!;
    const b = cut - sorted[hi]!;
    return Math.abs(a) <= Math.abs(b) ? a : b;
  });
  // 浮点误差别让正好卡在容差上的点算成没卡上
  const onBeat = offsets.filter((offset) => Math.abs(offset) <= tolerance + 1e-9).length;
  return { onBeat, total: cuts.length, medianOffset: Math.round(median(offsets) * 1000) / 1000 };
}
