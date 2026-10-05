import { eachDay, f, fill, H, n, put, W, type FontSpec, type SparkCardLines, type SparkCardStat, type SparkCardTheme } from "./sparkCard";

/*
 * 火花纪念卡 · 内容年志：年度分享图 trace 那张的姊妹篇——墨夜、积云里透出的琥珀光、半色调网点、光尘、夜色玻璃面板，
 * Fraunces 斜体细线的巨大数字和标题（中文落到思源宋体）、Inter + 苹方黑体的小字、宽字距等宽小戳。
 * 没有同源的天空画：夜空、云团、网点、光尘都在一张离屏 canvas 上现画，玻璃面板里再把它糊开重画一遍。
 * 火花亮着：云里是琥珀火光，数字带火、往上飘火星；没亮：冷月色的云，数字不带光。
 * 版面按内容伸缩：缺的块不画，面板贴底按内容定高；挤的时候依次少折行、少一行词、压矮日历，
 * 空的时候先放大主角数字和右边的光盘，再分一部分给面板里的数据格。
 */

type Ctx = CanvasRenderingContext2D;
type Rgb = readonly [number, number, number];

const CREAM = "#F6F1E4";
const AMBER = "#EEA44E";
const WARM = "#FBE3BB";
const ICE = "#B4D2E4";
const SOFT = "rgba(246,241,228,.78)";
const FAINT = "rgba(246,241,228,.58)";
const LINE = "rgba(246,241,228,.2)";
const SERIF = 'Fraunces,"Noto Serif SC","Songti SC",serif';
// 小字跟年度分享图一样用黑体：宋体 18px 在深底上偏碎
const TEXT = 'Inter,"PingFang SC","Noto Sans SC",sans-serif';
const F = {
  s3: f(`300 # ${SERIF}`),
  it: f(`italic 200 # ${SERIF}`),
  it3: f(`italic 300 # ${SERIF}`),
  txt: f(`500 # ${TEXT}`),
  mono: f('400 # "SFMono-Regular",ui-monospace,Menlo,Consolas,monospace'),
};
const M = 88;
const CW = W - 2 * M;
// 玻璃面板比正文宽一点，里面再留边
const PX = 58;
const PW = W - 2 * PX;
const PAD = 30;
const IX = PX + PAD;
const IW = PW - 2 * PAD;

const track = (ctx: Ctx, value: string) => { ctx.letterSpacing = value; };
function measure(ctx: Ctx, text: string, font: FontSpec, size: number, spacing = "0px"): number {
  track(ctx, spacing);
  ctx.font = font(size);
  return ctx.measureText(text).width;
}
/** 放得下的最大字号（不截断）。 */
function fit(ctx: Ctx, text: string, font: FontSpec, size: number, min: number, width: number, spacing = "0px"): number {
  const w = measure(ctx, text, font, size, spacing);
  if (w <= width) return size;
  let s = Math.max(min, Math.floor((size * width) / w));
  while (s > min && measure(ctx, text, font, s, spacing) > width) s -= 1;
  return s;
}
/** 折行：中文逐字、英文按词；返回全部行，不截断。 */
function breakLines(ctx: Ctx, text: string, font: FontSpec, size: number, width: number): string[] {
  track(ctx, "0px");
  ctx.font = font(size);
  const tokens = text.match(/[A-Za-z0-9@#'’.\-_]+|\s+|./gu) ?? [];
  const rows: string[] = [];
  let row = "";
  for (const token of tokens) {
    const next = row + token;
    if (row && ctx.measureText(next).width > width) {
      rows.push(row.trimEnd());
      row = token.trimStart();
    } else row = next;
  }
  if (row.trim()) rows.push(row.trim());
  return rows;
}
/** 最多 max 行，多出来的截在最后一行加 …（tail 是行尾还要接的字，比如后引号）。 */
function clampLines(ctx: Ctx, rows: string[], max: number, font: FontSpec, size: number, width: number, tail = ""): string[] {
  if (rows.length <= max) return rows;
  const out = rows.slice(0, max);
  ctx.font = font(size);
  let last = `${out[max - 1] ?? ""}…`;
  while (Array.from(last).length > 1 && ctx.measureText(last + tail).width > width) last = `${Array.from(last).slice(0, -2).join("")}…`;
  out[max - 1] = last;
  return out;
}

/** 折成不超过 max 行时让各行长短匀一点，免得最后一行只剩一个字。 */
function balancedLines(ctx: Ctx, text: string, font: FontSpec, size: number, width: number, max: number): string[] {
  const rows = breakLines(ctx, text, font, size, width);
  if (rows.length < 2 || rows.length > max) return rows;
  let lo = width * 0.4;
  let hi = width;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (breakLines(ctx, text, font, size, mid).length > rows.length) lo = mid;
    else hi = mid;
  }
  return breakLines(ctx, text, font, size, Math.ceil(hi) + 1);
}
/** 叙事句优先在逗号、句号后面断行；某一分句本身就放不下时退回逐字折行。 */
function clauseLines(ctx: Ctx, text: string, font: FontSpec, size: number, width: number, max: number): string[] {
  const clauses = text.match(/[^，。；！？]+[，。；！？]?/gu) ?? [text];
  const w = (t: string) => measure(ctx, t, font, size);
  const rows: string[] = [];
  let row = "";
  for (const clause of clauses) {
    const next = row + clause;
    if (row && w(next.trim()) > width) { rows.push(row.trim()); row = clause; } else row = next;
  }
  if (row.trim()) rows.push(row.trim());
  if (rows.length <= max && rows.every((r) => w(r) <= width)) return rows;
  return balancedLines(ctx, text, font, size, width, max);
}

// 固定种子：每次存出来的一样
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: Rgb, alpha: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha.toFixed(3)})`;

function glowDot(ctx: Ctx, x: number, y: number, r: number, color: string, blur: number) {
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
}
function hairline(ctx: Ctx, x: number, y: number, w: number, color = LINE) { fill(ctx, x, y, w, 1, color); }

// ---------------- 夜空：底色、积云、网点、光尘 ----------------

type Rect = readonly [number, number, number, number];
interface SkyOptions {
  /** 这一段竖向区间里不铺半色调网点（日历在这儿，两套点阵叠在一起会花），边上渐隐。 */
  quiet: readonly [number, number] | null;
  /** 主云堤的天际线（云顶）大概在哪一条。 */
  skyline: number;
  /** 云顶压平在 skyline 以下、亮边减弱（日历压在云上时）。 */
  flat: boolean;
  /** 光尘不落进这些文字框，免得像多出来的标点。 */
  avoid: Rect[];
  /** 主云堤的云团（连亮边）不越过这些框往上鼓：主角说明压在云顶上时，琥珀亮边别从字后面穿过去。 */
  press: Rect[];
}

/** 光源 (sx, sy) 藏在主角下方的云里；horizon 以下是压暗的云脚（被玻璃面板盖住，只透出糊开的颜色）。 */
function paintSky(lit: boolean, sx: number, sy: number, horizon: number, opts: SkyOptions): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d")!;
  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, lit ? "#0c1527" : "#0b1424");
  base.addColorStop(0.55, "#0a1120");
  base.addColorStop(1, "#05070d");
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 640);
  if (lit) {
    glow.addColorStop(0, "rgba(246,176,96,.34)");
    glow.addColorStop(0.3, "rgba(196,128,70,.13)");
    glow.addColorStop(1, "rgba(60,48,60,0)");
  } else {
    glow.addColorStop(0, "rgba(140,170,200,.15)");
    glow.addColorStop(0.4, "rgba(80,108,140,.05)");
    glow.addColorStop(1, "rgba(40,60,90,0)");
  }
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // 积云：先在底下铺一层亮边（每团云放大一圈涂成光色），再盖上不透明的云身，
  // 云身互相挡住，亮边只在整片云的天际线上露出来——光从云后面透出来；每团云上亮下暗，鼓包就分得出
  const rnd = rng(lit ? 7 : 19);
  const rimC = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const bodyC = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const rc = rimC.getContext("2d")!;
  const bc = bodyC.getContext("2d")!;
  const rimRgb: Rgb = lit ? [255, 198, 120] : [176, 200, 224];
  const bodyTop: Rgb = lit ? [62, 60, 92] : [44, 58, 86];
  const bodyLow: Rgb = lit ? [20, 24, 44] : [16, 24, 42];
  const near = (x: number, y: number, sigma: number) => Math.exp(-(((x - sx) ** 2) / (2 * sigma ** 2) + ((y - sy) ** 2) / (2 * (sigma * 0.7) ** 2)));
  const bank = (cx: number, top: number, width: number, depth: number, count: number, rMin: number, rMax: number, rimA: number, bodyA: number, sigma: number, flat = false, press: Rect[] = []) => {
    const list: Array<[number, number, number, number]> = [];
    for (let i = 0; i < count; i++) {
      const t = rnd() * 2 - 1;
      const x = cx + t * width / 2;
      // 中间鼓、两头低
      const hump = 1 - t * t;
      const r = rMin + rnd() * (rMax - rMin) * (0.45 + 0.55 * hump);
      const raw = top + r * (0.7 + rnd() * 0.5) + rnd() * depth * (0.3 + 0.7 * rnd()) - hump * depth * 0.35;
      // flat：云顶不越过 top（底下有日历抬头这类小字时，亮边不能顶到字上）
      let y = flat ? Math.max(raw, top + r * (0.94 + 0.06 * rnd())) : raw;
      // press：碰到文字框的云团整团往下沉，圆顶（连糊开的亮边）刚好停在框下沿；按水平距离算，云顶是圆滑地让开的
      for (const [x0, , x1, y1] of press) {
        const reach = r * 1.08 + 16;
        const dx = Math.max(x0 - x, 0, x - x1);
        if (dx < reach) y = Math.max(y, y1 + 10 + Math.sqrt(reach * reach - dx * dx));
      }
      list.push([x, y, r, near(x, y - r, sigma)]);
    }
    // 上面的先画，下面的盖在前面
    list.sort((a, b) => a[1] - b[1]);
    for (const [x, y, r, k] of list) {
      rc.fillStyle = rgba(rimRgb, rimA * (0.18 + 0.82 * k));
      rc.beginPath(); rc.arc(x, y - r * 0.04, r * 1.04, 0, Math.PI * 2); rc.fill();
    }
    for (const [x, y, r, k] of list) {
      const gr = bc.createLinearGradient(0, y - r, 0, y + r * 0.6);
      gr.addColorStop(0, rgba(mix(bodyTop, rimRgb, (lit ? 0.22 : 0.12) * k), bodyA));
      gr.addColorStop(1, rgba(bodyLow, bodyA));
      bc.fillStyle = gr;
      bc.beginPath(); bc.arc(x, y, r, 0, Math.PI * 2); bc.fill();
    }
  };
  // 远处两片小云：淡、小、在上面
  bank(W * 0.86, sy - 330, 380, 70, 16, 26, 70, lit ? 0.35 : 0.22, 0.5, 300);
  bank(W * 0.14, sy - 250, 340, 60, 14, 24, 62, lit ? 0.35 : 0.22, 0.45, 300);
  // 主云堤：顶在光源附近，往下一直铺进面板后面
  const rimA = (lit ? 0.95 : 0.5) * (opts.flat ? 0.6 : 1);
  bank(sx, opts.skyline, 1240, 120, 74, 40, 120, rimA, 0.94, 260, opts.flat, opts.press);
  bank(sx, opts.skyline + 110, 1400, 160, 60, 60, 150, rimA * 0.5, 0.96, 300, opts.flat, opts.press);
  g.filter = "blur(7px)";
  g.drawImage(rimC, 0, 0);
  g.filter = "blur(1.5px)";
  g.drawImage(bodyC, 0, 0);
  g.filter = "none";
  const p = rc;
  // 云脚复用亮边那张画布
  const puff = (x: number, y: number, r: number, k: number, alpha: number) => {
    const gr = p.createRadialGradient(x, y - r * 0.3, 0, x, y, r);
    gr.addColorStop(0, rgba(mix(bodyTop, rimRgb, 0.3 * k), 0.5 * alpha));
    gr.addColorStop(1, rgba(bodyLow, 0));
    p.fillStyle = gr;
    p.beginPath();
    p.arc(x, y, r, 0, Math.PI * 2);
    p.fill();
  };
  const puffs = rimC;

  // 云脚：一道暗云压住下半截，顶上一点回光
  p.clearRect(0, 0, W, H);
  for (let i = 0; i < 26; i++) puff(rnd() * W, horizon - 60 + rnd() * 50, 60 + rnd() * 90, lit ? 0.35 : 0.2, 0.7);
  for (let i = 0; i < 70; i++) {
    const r = 90 + rnd() * 160;
    const gr = p.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, "rgba(6,9,17,.8)");
    gr.addColorStop(1, "rgba(6,9,17,0)");
    const x = rnd() * (W + 200) - 100;
    const y = horizon - 20 + rnd() * (H - horizon + 80);
    p.save();
    p.translate(x, y);
    p.fillStyle = gr;
    p.beginPath();
    p.arc(0, 0, r, 0, Math.PI * 2);
    p.fill();
    p.restore();
  }
  g.filter = "blur(14px)";
  g.drawImage(puffs, 0, 0);
  g.filter = "none";

  // 半色调网点：入口卡那层探照灯网点，光源附近最密最亮；日历那一带渐隐留空
  const quiet = opts.quiet;
  for (let y = 6; y < horizon + 120; y += 12) {
    const fade = quiet ? Math.min(1, Math.max(0, Math.max(quiet[0] - y, y - quiet[1]) / 36)) : 1;
    if (fade <= 0) continue;
    for (let x = 6; x < W; x += 12) {
      const k = Math.exp(-(((x - sx) ** 2) / (2 * 440 ** 2) + ((y - sy) ** 2) / (2 * 320 ** 2)));
      const alpha = (0.03 + 0.17 * k) * fade;
      if (alpha < 0.045) continue;
      g.fillStyle = lit && k > 0.3 ? `rgba(251,227,187,${alpha.toFixed(3)})` : `rgba(226,232,236,${(alpha * 0.8).toFixed(3)})`;
      g.beginPath();
      g.arc(x, y, 1.05, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 光尘：固定种子；落进文字框的那颗不画（随机数照样取，别的光尘位置不变）
  const inside = (x: number, y: number) => opts.avoid.some(([x0, y0, x1, y1]) => x > x0 - 10 && x < x1 + 10 && y > y0 - 10 && y < y1 + 10);
  for (let i = 0; i < 110; i++) {
    const y = rnd() * horizon;
    const alpha = 0.2 + rnd() * 0.6;
    const x = rnd() * W;
    const r = 0.6 + rnd() * 1.6;
    const warm = lit && rnd() < 0.45;
    if (inside(x, y)) continue;
    g.globalAlpha = alpha;
    glowDot(g, x, y, r, warm ? WARM : CREAM, 6);
  }
  g.globalAlpha = 1;

  const vig = g.createRadialGradient(W / 2, H * 0.4, H * 0.28, W / 2, H * 0.5, H * 0.86);
  vig.addColorStop(0, "rgba(3,5,10,0)");
  vig.addColorStop(1, "rgba(3,5,10,.66)");
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
  return canvas;
}

/** 夜色玻璃：把夜空糊开重画在面板里，再压一层夜色、琥珀→蓝的淡渐变和顶上的反光。 */
function glass(ctx: Ctx, sky: HTMLCanvasElement, x: number, y: number, w: number, h: number, r: number, lit: boolean) {
  if (lit) {
    ctx.save();
    ctx.shadowColor = "rgba(238,164,78,.22)";
    ctx.shadowBlur = 90;
    ctx.fillStyle = "rgba(9,13,24,.01)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  ctx.filter = "blur(28px) saturate(1.35)";
  ctx.drawImage(sky, 0, 0);
  ctx.filter = "none";
  fill(ctx, x, y, w, h, "rgba(9,13,24,.6)");
  const tint = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  tint.addColorStop(0, lit ? "rgba(238,164,78,.15)" : "rgba(238,164,78,.06)");
  tint.addColorStop(0.42, "rgba(210,154,78,.07)");
  tint.addColorStop(0.78, "rgba(47,84,128,.12)");
  tint.addColorStop(1, "rgba(254,255,252,.03)");
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, w, h);
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, "rgba(255,255,255,.07)");
  sheen.addColorStop(0.18, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);
  // 内发光
  ctx.filter = "blur(18px)";
  ctx.strokeStyle = "rgba(254,255,252,.07)";
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
  ctx.filter = "none";
  ctx.restore();
  ctx.strokeStyle = "rgba(254,255,252,.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.stroke();
}

// ---------------- 火苗 ----------------

function flamePath(ctx: Ctx, x: number, y: number, h: number, lean = 0.08) {
  const w = h * 0.62;
  const tx = x + w * lean;
  ctx.beginPath();
  ctx.moveTo(tx, y - h);
  ctx.bezierCurveTo(tx + w * 0.08, y - h * 0.72, x + w * 0.64, y - h * 0.56, x + w * 0.5, y - h * 0.26);
  ctx.bezierCurveTo(x + w * 0.42, y - h * 0.05, x + w * 0.22, y, x, y);
  ctx.bezierCurveTo(x - w * 0.22, y, x - w * 0.42, y - h * 0.05, x - w * 0.5, y - h * 0.26);
  ctx.bezierCurveTo(x - w * 0.62, y - h * 0.5, tx - w * 0.16, y - h * 0.7, tx, y - h);
  ctx.closePath();
}
/** 亮着的火苗：外焰琥珀、内焰近白，带一圈光。 */
function flame(ctx: Ctx, x: number, y: number, h: number) {
  ctx.save();
  ctx.shadowColor = "rgba(238,150,64,.95)";
  ctx.shadowBlur = h * 0.55;
  const outer = ctx.createRadialGradient(x, y - h * 0.22, h * 0.04, x, y - h * 0.38, h * 0.8);
  outer.addColorStop(0, "#FFF8E8");
  outer.addColorStop(0.3, "#FCD592");
  outer.addColorStop(0.62, "#EE9A46");
  outer.addColorStop(1, "rgba(206,92,36,.9)");
  flamePath(ctx, x, y, h);
  ctx.fillStyle = outer;
  ctx.fill();
  ctx.shadowBlur = 0;
  const core = ctx.createRadialGradient(x, y - h * 0.18, 0, x, y - h * 0.2, h * 0.36);
  core.addColorStop(0, "rgba(255,255,255,.95)");
  core.addColorStop(1, "rgba(255,246,226,0)");
  flamePath(ctx, x, y - h * 0.03, h * 0.52, 0.02);
  ctx.fillStyle = core;
  ctx.fill();
  ctx.restore();
}
/**
 * 熄了的火苗：一笔空心轮廓，上面一缕烟。
 * wisp 是烟的长度（占 h 的比例）；小图标用短烟、火苗尖往一边弯，免得看着像一颗水滴。
 */
function ember(ctx: Ctx, x: number, y: number, h: number, wisp = 0.56, lean = 0.05) {
  ctx.save();
  ctx.strokeStyle = "rgba(246,241,228,.5)";
  ctx.lineWidth = Math.max(1.5, h / 26);
  ctx.lineJoin = "round";
  flamePath(ctx, x, y, h * 0.8, lean);
  ctx.stroke();
  // 里面再勾一道内焰（跟亮着的火苗一样分内外焰），一眼看得出是火苗，不是水滴
  ctx.strokeStyle = "rgba(246,241,228,.3)";
  ctx.lineWidth = Math.max(1.2, h / 34);
  flamePath(ctx, x, y - h * 0.07, h * 0.42, lean * 0.6);
  ctx.stroke();
  if (wisp > 0) {
    // 烟从（弯过去的）火苗尖上冒出来，先往外甩一下再回卷
    const tx = x + h * 0.8 * 0.62 * lean;
    const top = y - h * 0.8 - h * 0.04;
    const k = wisp / 0.56;
    ctx.strokeStyle = wisp < 0.4 ? "rgba(180,210,228,.5)" : "rgba(180,210,228,.32)";
    ctx.lineWidth = Math.max(1.3, h / 34);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tx, top);
    ctx.bezierCurveTo(tx + h * 0.22 * k, top - h * 0.18 * k, tx - h * 0.2 * k, top - h * 0.34 * k, tx + h * 0.06 * k, top - wisp * h);
    ctx.stroke();
  }
  ctx.restore();
  glowDot(ctx, x, y - h * 0.1, Math.max(1.6, h / 28), "rgba(238,164,78,.55)", 6);
}

// ---------------- 24 小时光盘 ----------------

function dial(ctx: Ctx, cx: number, cy: number, R: number, hours: number[], peak: number | null, lit: boolean) {
  const max = Math.max(1, ...hours);
  const r0 = R * 0.44;
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
  halo.addColorStop(0, lit ? "rgba(238,164,78,.2)" : "rgba(180,210,228,.12)");
  halo.addColorStop(1, "rgba(238,164,78,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(7,10,18,.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(246,241,228,.24)";
  ctx.lineWidth = 1;
  for (const r of [r0, R]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  // 外圈 24 个小刻度
  for (let h = 0; h < 24; h++) {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const l = h % 6 === 0 ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * (R + l), cy + Math.sin(a) * (R + l));
    ctx.stroke();
  }
  ctx.lineCap = "round";
  hours.forEach((v, h) => {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const len = 5 + (R - r0 - 14) * Math.sqrt(v / max);
    const pk = h === peak;
    ctx.strokeStyle = pk ? AMBER : `rgba(246,241,228,${(0.26 + 0.6 * (v / max)).toFixed(3)})`;
    ctx.lineWidth = pk ? Math.max(6, R * 0.065) : Math.max(3.5, R * 0.036);
    if (pk) { ctx.shadowColor = "rgba(238,164,78,.95)"; ctx.shadowBlur = 22; }
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r0 + 7), cy + Math.sin(a) * (r0 + 7));
    ctx.lineTo(cx + Math.cos(a) * (r0 + 7 + len), cy + Math.sin(a) * (r0 + 7 + len));
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  });
  ctx.lineCap = "butt";
  for (const h of [0, 6, 12, 18]) {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const d = R + 26;
    put(ctx, String(h), cx + Math.cos(a) * d, cy + Math.sin(a) * d + 7, { font: F.mono, size: 18, color: FAINT, align: "center" });
  }
  if (peak !== null) {
    put(ctx, String(peak).padStart(2, "0"), cx, cy + r0 * 0.12, { font: F.s3, size: Math.round(r0 * 0.8), color: WARM, align: "center", glow: "rgba(238,164,78,.7)" });
    put(ctx, "PEAK", cx + 1, cy + r0 * 0.64, { font: F.mono, size: 18, color: AMBER, align: "center", spacing: "2px" });
  }
}

/** 没有钟点数据时主角右边的徽记：圈、网点、火苗（或熄了的火苗）。 */
function emblem(ctx: Ctx, cx: number, cy: number, R: number, lit: boolean) {
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
  halo.addColorStop(0, lit ? "rgba(238,164,78,.3)" : "rgba(180,210,228,.1)");
  halo.addColorStop(1, "rgba(238,164,78,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2);
  ctx.fill();
  // 网点和天空那层半色调同一套 12px 网格、同一个原点：圈里像是被光照亮的那一片网点，不会叠出双点和摩尔纹
  const SKY_DOT = 12;
  const snap = (v: number) => Math.ceil((v - 6) / SKY_DOT) * SKY_DOT + 6;
  for (let y = snap(cy - R); y <= cy + R; y += SKY_DOT) {
    for (let x = snap(cx - R); x <= cx + R; x += SKY_DOT) {
      const d = Math.hypot(x - cx, y - cy) / R;
      if (d > 0.94) continue;
      ctx.fillStyle = lit ? `rgba(251,227,187,${(0.36 * (1 - d)).toFixed(3)})` : `rgba(220,230,236,${(0.24 * (1 - d)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = "rgba(246,241,228,.24)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([2, 7]);
  ctx.beginPath(); ctx.arc(cx, cy, R + 16, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  if (lit) flame(ctx, cx, cy + R * 0.5, R * 1.05);
  else ember(ctx, cx, cy + R * 0.42, R * 0.95, 0.56, 0.12);
}

// ---------------- 主角 ----------------

interface Side { cx: number; cy: number; R: number; top: number }
/** 右栏半径的普通上限（没有日历时）。 */
const SIDE_CAP = 132;

/** 右栏：24 小时光盘（没有钟点时换成徽记），从 top 一直可以占到主角区底部；cap 是半径上限。 */
function planSide(L: SparkCardLines, heroBottom: number, top: number, cap: number): Side {
  const note = L.hours && L.hoursNote ? 46 : 0;
  const room = heroBottom - top;
  const R = Math.round(Math.max(80, Math.min(cap, (room - 70 - note) / 2)));
  const used = 2 * R + 70 + note;
  const cy = top + 36 + R + Math.max(0, (room - used) / 2);
  return { cx: W - M - R - 22, cy, R, top };
}

/**
 * 主角区：默认数字在左、光盘（徽记）在右并排；主角区很高、并排时数字被光盘挤窄的时候，
 * 改成叠放——光盘升到名字旁边，数字贴着主角区底部用满整行，字号能明显变大才这么摆。
 */
/** 并排：徽记想长大（cap）时，只在不挤小主角数字的前提下长大，数字被挤小 4% 以上就退回普通大小。 */
function planBeside(ctx: Ctx, L: SparkCardLines, upperTop: number, heroBottom: number, sideTop: number, cap: number): { side: Side; hero: HeroPlan } {
  const at = (c: number) => {
    const side = planSide(L, heroBottom, sideTop, c);
    return { side, hero: planHero(ctx, L, upperTop, heroBottom, side.cx - side.R - 58 - M) };
  };
  const big = at(cap);
  if (cap <= SIDE_CAP) return big;
  const plain = at(SIDE_CAP);
  return big.hero.size >= plain.hero.size * 0.96 ? big : plain;
}

function planUpper(ctx: Ctx, L: SparkCardLines, upperTop: number, heroBottom: number, sideTop: number, cap: number): { side: Side; hero: HeroPlan; stacked: boolean } {
  const { side, hero: beside } = planBeside(ctx, L, upperTop, heroBottom, sideTop, cap);
  const note = L.hours && L.hoursNote ? 46 : 0;
  for (let most = Infinity; ;) {
    const hero = planHero(ctx, L, upperTop, heroBottom, CW, 1, most);
    if (hero.size < beside.size + 40) break;
    // 光盘最低的一点要高过数字顶 22px：光盘连 0/6/12/18 刻度和底下小字，徽记只算圈和外面那道虚线圈
    const limit = hero.base - hero.size * 0.72 - 22;
    const R = Math.floor(Math.min(cap, L.hours ? (limit - sideTop - 70 - note) / 2 : (limit - sideTop - 52) / 1.76));
    if (R >= (L.hours ? 96 : 104)) {
      const lo = sideTop + 36 + (L.hours ? R : R * 0.88);
      const hi = limit - (L.hours ? R + 34 + note : R * 0.88 + 16);
      return { side: { cx: W - M - R - 22, cy: (lo + Math.max(lo, hi)) / 2, R, top: sideTop }, hero, stacked: true };
    }
    most = hero.size - 8;
  }
  return { side, hero: beside, stacked: false };
}

function drawSide(ctx: Ctx, L: SparkCardLines, side: Side) {
  const { cx, cy, R } = side;
  if (L.hours) {
    dial(ctx, cx, cy, R, L.hours, L.peakHour, L.hero.lit);
    if (L.hoursNote) put(ctx, L.hoursNote, cx, cy + R + 72, { font: F.txt, size: 18, width: 2 * Math.min(R + 80, W - M + 20 - cx), color: FAINT, align: "center" });
  } else emblem(ctx, cx, cy, R * 0.88, L.hero.lit);
}

/** 字形墨迹的左右边：斜体数字的 advance 和看得见的笔画差得多（斜体 1 尤其明显）。 */
function ink(ctx: Ctx, text: string, font: FontSpec, size: number): { l: number; r: number } {
  track(ctx, "0px");
  ctx.font = font(size);
  const m = ctx.measureText(text);
  return { l: m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight };
}

interface HeroPlan {
  size: number;
  unitSize: number;
  /** 数字的书写起点：让墨迹左缘正好落在正文左边线 M 上。 */
  x0: number;
  /** 数字墨迹的右缘，单位紧跟在它后面。 */
  inkR: number;
  unitX: number;
  unitW: number;
  labelY: number;
  base: number;
  /** 说明的起点和字号：平常在数字下面另起一行；主角区太矮时接在单位后面、和数字同一条基线。 */
  noteX: number;
  noteY: number;
  noteSize: number;
  room: number;
  /** 标签 / 数字 / 说明这一整块的高度。 */
  block: number;
  /** 标签、说明用大一号的字。 */
  big: boolean;
}

/** room：数字加单位能占的宽；lift：块在区间里的竖向位置（0 顶、1 贴底）；most：字号上限（叠放时试小一点的字号用）。 */
function planHero(ctx: Ctx, L: SparkCardLines, top: number, bottom: number, room: number, lift = 0.58, most = Infinity): HeroPlan {
  const { hero } = L;
  const zone = bottom - top;
  const unitSizeOf = (s: number) => Math.max(44, Math.round(s * 0.27));
  const need = (s: number) => {
    const b = ink(ctx, hero.value, F.it, s);
    return b.l + b.r + s * 0.06 + measure(ctx, hero.unit, F.s3, unitSizeOf(s));
  };
  // 有日历时主角让一点（只有一两位的数字横向空得多，可以再大些）；没有日历、数字又短（三位以内）时可以放得很大
  const chars = Array.from(hero.value).length;
  const cap = L.calendar ? (chars <= 2 ? 320 : 250) : chars <= 2 ? 460 : chars <= 3 ? 400 : 300;
  // 一两位数字在日历卡上放大（超过 250）时，上下至少还留 30px 透气，别把名字、标签、数字挤成一摞
  const tall = L.calendar && chars <= 2 ? Math.max(250, Math.round((zone - 150) / 0.72)) : Infinity;
  // 没有日历的卡主角区宽裕：标签和说明大一号、离数字远一点
  const roomyHero = !L.calendar;
  const gapUp = roomyHero ? 30 : 22;
  const gapDown = roomyHero ? 66 : 58;
  const noteSize = roomyHero ? 25 : 23;
  let size = Math.max(84, Math.min(cap, most, tall, Math.round((zone - 120) / 0.72)));
  while (size > 84 && need(size) > room) size -= 2;
  // 主角区太矮（数字被压到 200 以下）：说明接到单位后面同一行，省下的一行高度换成更大的数字
  let inline = false;
  if (size < 200) {
    const noteW = measure(ctx, hero.note, F.txt, noteSize);
    let s2 = Math.max(84, Math.min(cap, most, Math.round((zone - 30 - gapUp - 30) / 0.72)));
    while (s2 > 84 && need(s2) + 32 + noteW > room) s2 -= 2;
    if (s2 >= size + 24) { size = s2; inline = true; }
  }
  const b = ink(ctx, hero.value, F.it, size);
  const unitSize = unitSizeOf(size);
  const unitW = measure(ctx, hero.unit, F.s3, unitSize);
  const x0 = M + b.l;
  const unitX = x0 + b.r + size * 0.06;
  const block = 30 + gapUp + size * 0.72 + (inline ? 30 : gapDown + 4);
  // 留白上面略多一点：名字底下透口气，说明和下面的云、面板挨得紧些
  const y0 = top + Math.max(0, (zone - block) * lift);
  const labelY = y0 + 30;
  const base = labelY + gapUp + size * 0.72;
  const noteX = inline ? unitX + unitW + 32 : M;
  return { size, unitSize, x0, inkR: x0 + b.r, unitX, unitW, labelY, base, noteX, noteY: inline ? base : base + gapDown, noteSize, room, block, big: roomyHero };
}

/** text：火星不落进这些字框（名字、主角标签），随机数照取，别的火星位置不变。 */
function drawHero(ctx: Ctx, L: SparkCardLines, h: HeroPlan, text: Rect[]) {
  const { hero } = L;
  const { size, x0, base, labelY, noteY, room } = h;

  if (hero.lit) flame(ctx, M + 13, labelY + 6, 38);
  else ember(ctx, M + 13, labelY + 4, 38, 0.24, 0.2);
  const labelW = put(ctx, hero.label, M + 40, labelY, { font: F.txt, size: h.big ? 28 : 26, min: 20, width: room - 40, color: hero.lit ? WARM : SOFT });
  const keepOut: Rect[] = [...text, [M - 10, labelY - 40, M + 40 + labelW, labelY + 8]];

  const inkW = h.inkR - M;
  if (hero.lit) {
    // 数字后面一团暖光：画成整圆，不再用比渐变半径窄的方块去填（个位数时会露出竖直的边）
    const hx = M + inkW * 0.5;
    const hy = base - size * 0.36;
    const rg = Math.max(inkW * 0.7, size * 0.9);
    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, rg);
    halo.addColorStop(0, "rgba(238,150,64,.2)");
    halo.addColorStop(0.6, "rgba(238,150,64,.07)");
    halo.addColorStop(1, "rgba(238,150,64,0)");
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(41, 41, W - 82, H - 82, 35);
    ctx.clip();
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(hx, hy, rg, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // 火星：从数字顶上往上飘，越高越稀越小
    const rnd = rng(31);
    const rise = Math.min(170, size * 0.75);
    for (let i = 0; i < 64; i++) {
      const t = rnd();
      const x = M + size * 0.08 + rnd() * (inkW * 0.95 + size * 0.1 - size * 0.08);
      const y = base - size * 0.66 - t * t * rise + rnd() * 26;
      const alpha = 0.35 + (1 - t) * 0.6;
      const r = 0.9 + rnd() * 2.4 * (1 - t * 0.6);
      const color = rnd() < 0.55 ? WARM : AMBER;
      // 连光晕一起躲开字框；也不飘进抬头那一行
      if (y < 152 || keepOut.some(([a, b, c, d]) => x > a - 8 && x < c + 8 && y > b - 8 && y < d + 8)) continue;
      ctx.globalAlpha = alpha;
      glowDot(ctx, x, y, r, color, 12);
    }
    ctx.globalAlpha = 1;
    const grad = ctx.createLinearGradient(0, base - size * 0.72, 0, base);
    grad.addColorStop(0, "#FFF8EA");
    grad.addColorStop(0.55, "#FCDFAE");
    grad.addColorStop(1, "#F2A856");
    track(ctx, "0px");
    ctx.font = F.it(size);
    ctx.textAlign = "left";
    ctx.fillStyle = grad;
    ctx.shadowColor = "rgba(238,150,64,.8)";
    ctx.shadowBlur = size * 0.3;
    ctx.fillText(hero.value, x0, base);
    ctx.shadowColor = "rgba(255,214,150,.85)";
    ctx.shadowBlur = size * 0.06;
    ctx.fillText(hero.value, x0, base);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  } else {
    put(ctx, hero.value, x0, base, { font: F.it, size, color: "rgba(240,242,240,.92)", glow: "rgba(180,210,228,.3)" });
  }
  put(ctx, hero.unit, h.unitX, base, { font: F.s3, size: h.unitSize, color: hero.lit ? WARM : SOFT });
  put(ctx, hero.note, h.noteX, noteY, { font: F.txt, size: h.noteSize, min: 18, width: M + room + 10 - h.noteX, color: hero.lit ? "rgba(251,227,187,.9)" : SOFT });
}

// ---------------- 日历：每一天一颗光点 ----------------

interface CalPlan {
  /** strip：三周以内一排；month：每月一行、按日号对齐；grid：按周排的 7 行网格（跨一年多只画最近 52 周）。 */
  mode: "strip" | "month" | "grid";
  days: string[];
  offset: number;
  cols: number;
  pitch: number;
  /** 行距：放不下时比列距小一点，压矮整块。 */
  rowPitch: number;
  /** month 模式下的月份（年 * 12 + 月），一月一行。 */
  months: number[];
  cropped: boolean;
  h: number;
}
const dotDate = (iso: string) => iso.replace(/-/gu, ".");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthKey = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const CAL_HEAD = 34;
/** month 模式左边月份名那一栏。 */
const MONTH_LABEL_W = 70;

function planCalendar(cal: NonNullable<SparkCardLines["calendar"]>, pitchMax: number): CalPlan {
  let days = eachDay(cal.start, cal.end);
  if (days.length <= 21) {
    const pitch = Math.min(120, CW / days.length);
    return { mode: "strip", days, offset: 0, cols: days.length, pitch, rowPitch: pitch, months: [], cropped: false, h: CAL_HEAD + 30 + 15 + 40 };
  }
  let cropped = false;
  const weekday = (iso: string) => (new Date(`${iso}T12:00:00`).getDay() + 6) % 7;
  let offset = weekday(days[0] ?? cal.start);
  let cols = Math.floor((days.length - 1 + offset) / 7) + 1;
  // 跨了一年多：只画最近 52 周
  if (cols > 64) {
    days = days.slice(-364);
    cropped = true;
    offset = weekday(days[0] ?? cal.start);
    cols = Math.floor((days.length - 1 + offset) / 7) + 1;
  }
  const k0 = monthKey(days[0] ?? cal.start);
  const k1 = monthKey(days[days.length - 1] ?? cal.end);
  if (k1 - k0 < 6) {
    // 半年以内：周网格铺不满一行，改成一月一行、按日号对齐，横向铺满
    const months = Array.from({ length: k1 - k0 + 1 }, (_, i) => k0 + i);
    const pitch = (CW - MONTH_LABEL_W) / 31;
    const rowPitch = Math.max(20, Math.min(pitch, pitchMax + 6, 200 / months.length));
    return { mode: "month", days, offset: 0, cols: 31, pitch, rowPitch, months, cropped, h: CAL_HEAD + 12 + months.length * rowPitch + 8 + 22 };
  }
  // 七个月以上按周排；列少时列距放宽（行距不变），让网格横向铺满
  const pitch = Math.min(40, CW / cols);
  const rowPitch = Math.min(pitch, pitchMax);
  return { mode: "grid", days, offset, cols, pitch, rowPitch, months: [], cropped, h: CAL_HEAD + 12 + 7 * rowPitch + 8 + 22 };
}

function drawCalendar(ctx: Ctx, L: SparkCardLines, plan: CalPlan, top: number) {
  const cal = L.calendar;
  if (!cal) return;
  const who = new Map(cal.days.map((d) => [d.date, d.who]));
  const me = L.balance?.mineLabel ?? "我";
  const them = L.balance?.theirsLabel ?? "TA";
  const HALF_ME = "rgba(238,164,78,.5)";
  const HALF_THEM = "rgba(180,210,228,.6)";
  const first = plan.days[0] ?? cal.start;
  const last = plan.days[plan.days.length - 1] ?? cal.end;
  // 一行抬头：小标题、图例在左，起止日期在右
  const lw = put(ctx, L.labels.calendar, M, top + 24, { font: F.txt, size: 21, color: SOFT });
  let lx = M + lw + 40;
  for (const [text, color] of [[`${me} & ${them}`, AMBER], [me, HALF_ME], [them, HALF_THEM]] as const) {
    if (color === AMBER) glowDot(ctx, lx, top + 18, 5, AMBER, 10);
    else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx, top + 18, 4.5, 0, Math.PI * 2); ctx.fill(); }
    lx += 13 + put(ctx, text, lx + 13, top + 24, { font: F.txt, size: 18, color: FAINT }) + 26;
  }
  const span = plan.cropped ? "LAST 52 WEEKS" : `${n(plan.days.length)} DAYS`;
  const range = `${dotDate(first)} — ${dotDate(last)}`;
  const room = W - M - lx;
  const full = `${range} · ${span}`;
  put(ctx, measure(ctx, full, F.mono, 18, "2px") <= room ? full : range, W - M, top + 24, { font: F.mono, size: 18, min: 18, width: Math.max(room, 120), color: FAINT, align: "right", spacing: "2px" });
  const disc = (x: number, y: number, r: number, color: string) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  const ring = (x: number, y: number, r: number, color: string, lw = 1) => { ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); };
  const paint = (x: number, y: number, kind: string | undefined, r: number) => {
    if (kind === "both") glowDot(ctx, x, y, r, AMBER, r * 2.2);
    else if (kind === "mine") disc(x, y, r * 0.8, HALF_ME);
    else if (kind === "theirs") disc(x, y, r * 0.8, HALF_THEM);
    else if (kind === "one") disc(x, y, r * 0.8, "rgba(246,241,228,.42)");
    // 没聊的日子：一个很淡的空心小圈，和背景里实心的网点分得开
    else ring(x, y, Math.max(2.4, r * 0.4), "rgba(246,241,228,.26)");
  };
  const tick = (text: string, x: number, y: number, align: CanvasTextAlign = "center") =>
    put(ctx, text, x, y, { font: F.mono, size: 18, color: FAINT, align, spacing: "1px" });

  if (plan.mode === "strip") {
    const y = top + CAL_HEAD + 30;
    const r = Math.min(15, plan.pitch * 0.26);
    const x0 = M + plan.pitch / 2;
    hairline(ctx, x0, y, plan.pitch * (plan.days.length - 1), "rgba(246,241,228,.16)");
    // 连着都互发的日子用一道暖光串起来
    ctx.save();
    ctx.shadowColor = "rgba(238,164,78,.8)";
    ctx.shadowBlur = 10;
    plan.days.forEach((iso, i) => {
      const next = plan.days[i + 1];
      if (next && who.get(iso) === "both" && who.get(next) === "both") fill(ctx, x0 + i * plan.pitch, y - 1, plan.pitch, 2, "rgba(238,164,78,.75)");
    });
    ctx.restore();
    plan.days.forEach((iso, i) => {
      const x = x0 + i * plan.pitch;
      const kind = who.get(iso);
      if (kind) paint(x, y, kind, r);
      else ring(x, y, r * 0.5, "rgba(246,241,228,.32)", 1.2);
      put(ctx, String(Number(iso.slice(8, 10))), x, y + 15 + 32, { font: F.mono, size: 18, color: kind ? SOFT : FAINT, align: "center" });
    });
    return;
  }

  const gy = top + CAL_HEAD + 12;
  const r = Math.min(plan.pitch, plan.rowPitch) * 0.34;
  const bottom = gy + (plan.mode === "month" ? plan.months.length : 7) * plan.rowPitch;
  if (plan.mode === "month") {
    const gx = M + MONTH_LABEL_W;
    const row = new Map(plan.months.map((k, i) => [k, i]));
    plan.months.forEach((k, i) => {
      const cy = gy + i * plan.rowPitch + plan.rowPitch / 2;
      tick(MONTHS[k % 12] ?? "", M, cy + 6, "left");
    });
    plan.days.forEach((iso) => {
      const i = row.get(monthKey(iso)) ?? 0;
      const d = Number(iso.slice(8, 10));
      paint(gx + (d - 1) * plan.pitch + plan.pitch / 2, gy + i * plan.rowPitch + plan.rowPitch / 2, who.get(iso), r);
    });
    // 底下一排日号刻度
    for (const d of [1, 5, 10, 15, 20, 25, 31]) tick(String(d), gx + (d - 1) * plan.pitch + plan.pitch / 2, bottom + 8 + 18);
    return;
  }

  const gx = M;
  plan.days.forEach((iso, i) => {
    const k = i + plan.offset;
    paint(gx + Math.floor(k / 7) * plan.pitch + plan.pitch / 2, gy + (k % 7) * plan.rowPitch + plan.rowPitch / 2, who.get(iso), r);
  });
  // 网格底下标月份：每月 1 号所在的那一列；第一列总标起始月，离下一个太近就让给下一个
  const marks: Array<{ x: number; text: string }> = [];
  plan.days.forEach((iso, i) => {
    if (i === 0 || iso.slice(8, 10) === "01") marks.push({ x: gx + Math.floor((i + plan.offset) / 7) * plan.pitch, text: MONTHS[monthKey(iso) % 12] ?? "" });
  });
  const labelW = measure(ctx, "MMM", F.mono, 18, "1px") + 14;
  const second = marks[1];
  if (second && marks[0] && second.x - marks[0].x < labelW) marks.shift();
  let lastX = -Infinity;
  for (const mark of marks) {
    if (mark.x - lastX < labelW || mark.x + labelW - 14 > W - M) continue;
    tick(mark.text, mark.x + 1, bottom + 8 + 18, "left");
    lastX = mark.x;
  }
}

// ---------------- 面板里的各块 ----------------

interface Block { h: number; draw: (y: number) => void }
/** 面板下半是一张账：左边一列小标题，右边是内容。 */
const LC = 150;
const CX = IX + LC;
const CWID = IW - LC;

const EMPTY = "—";
/** 「—」占位格太多时，数据格最多再撑高这么多：缺的数据照常占位，但不该被撑大成视觉重点。 */
const SPARSE_EXTRA = 22;
/** 每一行实际能多拿的高度：一行里一半以上是「—」，或者全卡三分之一以上是「—」，就只给一点点。 */
function rowExtra(stats: SparkCardStat[], row: SparkCardStat[], extra: number): number {
  const empty = (list: SparkCardStat[]) => list.filter((st) => st.v === EMPTY).length;
  const sparse = empty(row) * 2 > row.length || empty(stats) * 3 > stats.length;
  return sparse ? Math.min(extra, SPARSE_EXTRA) : extra;
}

/** extra：版面富余时每行多留的高度，字整体往下挪一半（「—」多的行只拿一点）。 */
function statsBlocks(ctx: Ctx, stats: SparkCardStat[], big: boolean, extra = 0): Block[] {
  const rows: SparkCardStat[][] = [];
  for (let i = 0; i < stats.length; i += 3) rows.push(stats.slice(i, i + 3));
  const extras = rows.map((row) => rowExtra(stats, row, extra));
  // 每一行都富余很多时数字才放大一号（各行字号一致），多出来的高度不全是空的
  const vSize = (big ? 46 : 38) + (rows.length && Math.min(...extras) >= 36 ? 8 : 0);
  // 同一句说明在面板里只写一次（群里没样本时，钟点和最晚一次的说明是同一句）
  const seen = new Set<string>();
  return rows.map((row, r) => {
    const ex = extras[r] ?? 0;
    const cw = IW / row.length;
    const cells = row.map((st, i) => {
      const pad = i ? 22 : 0;
      const inner = cw - pad - 8;
      const said = seen.has(st.s);
      if (st.s) seen.add(st.s);
      const s = st.s && !said ? clampLines(ctx, clauseLines(ctx, st.s, F.txt, 18, inner, 2), 2, F.txt, 18, inner) : [];
      return { st, x: IX + i * cw, pad, inner, s };
    });
    const lines = Math.max(0, ...cells.map((c) => c.s.length));
    const vy = 30 + vSize + 6;
    const h = vy + 12 + lines * 26 + (big ? 12 : 0) + ex;
    return {
      h,
      draw: (top: number) => {
        const y = top + ex / 2;
        cells.forEach(({ st, x, pad, inner, s }, i) => {
          if (i) fill(ctx, x, top + 14, 1, h - 28, LINE);
          put(ctx, st.k, x + pad, y + 30, { font: F.txt, size: 20, min: 18, width: inner, color: SOFT });
          put(ctx, st.v, x + pad, y + vy, { font: F.s3, size: vSize, min: 24, width: inner, color: st.v === "—" ? FAINT : CREAM });
          s.forEach((line, j) => put(ctx, line, x + pad, y + vy + 30 + j * 26, { font: F.txt, size: 18, color: FAINT }));
        });
      },
    };
  });
}

function ledgerLabel(ctx: Ctx, text: string, y: number) {
  put(ctx, text, IX, y, { font: F.txt, size: 20, min: 18, width: LC - 14, color: SOFT });
}

/** 我 vs TA 的比例条：比例照实画，只给太细的一边留 3px 看得见。 */
function ratioBar(ctx: Ctx, mine: number, theirs: number, bx: number, by: number, bw: number, t: number) {
  const total = mine + theirs;
  if (bw <= 20 || total <= 0) return;
  let mw = (mine / total) * bw;
  if (mine > 0 && mw < 3) mw = 3;
  if (theirs > 0 && bw - mw < 3) mw = bw - 3;
  const gap = mine > 0 && theirs > 0 ? 3 : 0;
  ctx.fillStyle = "rgba(246,241,228,.08)";
  ctx.beginPath(); ctx.roundRect(bx, by - t / 2, bw, t, t / 2); ctx.fill();
  if (theirs > 0) {
    ctx.fillStyle = "rgba(180,210,228,.6)";
    ctx.beginPath(); ctx.roundRect(bx + mw + gap, by - t / 2, bw - mw - gap, t, t / 2); ctx.fill();
  }
  if (mine > 0) {
    ctx.save();
    ctx.shadowColor = "rgba(238,164,78,.9)";
    ctx.shadowBlur = 14;
    ctx.fillStyle = AMBER;
    ctx.beginPath(); ctx.roundRect(bx, by - t / 2, mw, t, t / 2); ctx.fill();
    ctx.restore();
  }
}

/** big：面板内容少的卡（群、没有词和第一句的）把比例做成两行：数字在上、整宽的粗条在下。 */
function balanceBlock(ctx: Ctx, L: SparkCardLines, big: boolean): Block | null {
  const b = L.balance;
  if (!b) return null;
  if (big) {
    return {
      h: 100,
      draw: (y) => {
        const base = y + 44;
        ledgerLabel(ctx, L.labels.balance, base);
        let x = CX;
        x += put(ctx, b.mineLabel, x, base, { font: F.txt, size: 21, color: SOFT }) + 12;
        put(ctx, n(b.mine), x, base + 3, { font: F.it3, size: 44, min: 26, width: CWID / 2 - 60, color: WARM, glow: "rgba(238,164,78,.5)" });
        const rx = IX + IW - put(ctx, b.theirsLabel, IX + IW, base, { font: F.txt, size: 21, color: SOFT, align: "right" }) - 12;
        put(ctx, n(b.theirs), rx, base + 3, { font: F.it3, size: 44, min: 26, width: CWID / 2 - 60, color: CREAM, align: "right" });
        ratioBar(ctx, b.mine, b.theirs, CX, y + 74, IX + IW - CX, 10);
      },
    };
  }
  return {
    h: 54,
    draw: (y) => {
      const base = y + 35;
      ledgerLabel(ctx, L.labels.balance, base);
      let x = CX;
      x += put(ctx, b.mineLabel, x, base, { font: F.txt, size: 20, color: SOFT }) + 10;
      x += put(ctx, n(b.mine), x, base + 2, { font: F.it3, size: 34, min: 24, width: 180, color: WARM, glow: "rgba(238,164,78,.5)" });
      let rx = IX + IW;
      rx -= put(ctx, b.theirsLabel, rx, base, { font: F.txt, size: 20, color: SOFT, align: "right" }) + 10;
      rx -= put(ctx, n(b.theirs), rx, base + 2, { font: F.it3, size: 34, min: 24, width: 180, color: CREAM, align: "right" });
      ratioBar(ctx, b.mine, b.theirs, x + 22, base - 10, rx - 22 - (x + 22), 8);
    },
  };
}

interface Chip { text: string; count: string; w: number; tw: number; row: number; x: number }
const CHIP_H = 42;
const CHIP_GAP = 10;
/** 胶囊的字号和内边距：放不下全部词条时整行换紧凑的一套（字小一号、边距收窄）再排一次。 */
interface ChipStyle { text: number; count: number; padL: number; padM: number; padR: number; gap: number }
const CHIP: ChipStyle = { text: 21, count: 23, padL: 16, padM: 9, padR: 18, gap: 12 };
const CHIP_TIGHT: ChipStyle = { text: 19, count: 21, padL: 13, padM: 7, padR: 14, gap: 8 };
function chipLayout(ctx: Ctx, items: Array<{ text: string; count: string }>, width: number, maxRows: number, st: ChipStyle): { chips: Chip[]; rows: number; st: ChipStyle } {
  const chips: Chip[] = [];
  let row = 0;
  let x = 0;
  for (const item of items) {
    const cwid = measure(ctx, item.count, F.it3, st.count);
    const tw = Math.min(measure(ctx, item.text, F.txt, st.text), width - cwid - (st.padL + st.padM + st.padR));
    const w = st.padL + tw + st.padM + cwid + st.padR;
    if (x > 0 && x + w > width) { row += 1; x = 0; }
    if (row >= maxRows) break;
    chips.push({ ...item, w, tw, row, x });
    x += w + st.gap;
  }
  return { chips, rows: chips.length ? (chips[chips.length - 1]?.row ?? 0) + 1 : 0, st };
}

function chipBlock(ctx: Ctx, label: string, items: Array<{ text: string; count: string }>, maxRows: number): Block | null {
  if (!items.length) return null;
  let layout = chipLayout(ctx, items, CWID, maxRows, CHIP);
  // 排不下全部词条：紧凑的一套能多放下至少一个才换，词条照原来的顺序，不跳着挑短的
  if (layout.chips.length < items.length) {
    const tight = chipLayout(ctx, items, CWID, maxRows, CHIP_TIGHT);
    if (tight.chips.length > layout.chips.length) layout = tight;
  }
  const { st } = layout;
  return {
    h: 10 + layout.rows * (CHIP_H + CHIP_GAP) - CHIP_GAP + 10,
    draw: (y) => {
      ledgerLabel(ctx, label, y + 10 + 28);
      layout.chips.forEach((chip, i) => {
        const cx = CX + chip.x;
        const cy = y + 10 + chip.row * (CHIP_H + CHIP_GAP);
        const first = i === 0;
        ctx.fillStyle = first ? "rgba(238,164,78,.1)" : "rgba(7,10,18,.34)";
        ctx.strokeStyle = first ? "rgba(238,164,78,.62)" : "rgba(254,255,252,.26)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(cx + 0.5, cy + 0.5, chip.w - 1, CHIP_H - 1, CHIP_H / 2); ctx.fill(); ctx.stroke();
        put(ctx, chip.text, cx + st.padL, cy + 28, { font: F.txt, size: st.text, min: st.text, width: chip.tw + 1, color: CREAM });
        put(ctx, chip.count, cx + st.padL + chip.tw + st.padM, cy + 28, { font: F.it3, size: st.count, color: AMBER });
      });
    },
  };
}

function firstLineBlock(ctx: Ctx, L: SparkCardLines, maxLines: number): Block | null {
  const first = L.firstLine;
  if (!first) return null;
  const tx = CX + 40;
  const tw = IX + IW - tx - 24;
  const rows = clampLines(ctx, balancedLines(ctx, first.text, F.s3, 28, tw, maxLines), maxLines, F.s3, 28, tw, "”");
  const lastW = measure(ctx, rows[rows.length - 1] ?? "", F.s3, 28) + measure(ctx, "”", F.it3, 32) + 8;
  const byW = measure(ctx, first.by, F.txt, 18);
  const byInline = lastW + 40 + byW <= tw;
  const lh = 42;
  return {
    h: 10 + rows.length * lh + (byInline ? 0 : 30) + 8,
    draw: (y) => {
      const b0 = y + 10 + 28;
      // 小标题按引文首行的视觉中心对齐（28px 宋体比 20px 黑体高出一截），跟上面几块胶囊行里的标签一样居中
      ledgerLabel(ctx, L.labels.firstLine, b0 - 4);
      put(ctx, "“", CX - 2, b0 + 30, { font: F.it3, size: 78, color: AMBER, glow: "rgba(238,164,78,.6)" });
      rows.forEach((row, i) => {
        const w = put(ctx, row, tx, b0 + i * lh, { font: F.s3, size: 28, color: CREAM });
        if (i === rows.length - 1) put(ctx, "”", tx + w + 4, b0 + i * lh + 4, { font: F.it3, size: 32, color: AMBER });
      });
      const byY = byInline ? b0 + (rows.length - 1) * lh : b0 + rows.length * lh - 6;
      put(ctx, first.by, IX + IW, byY, { font: F.txt, size: 18, min: 18, width: tw, color: FAINT, align: "right" });
    },
  };
}

// ---------------- 整张 ----------------

const sumBlocks = (list: Block[]) => list.reduce((s, b) => s + b.h, 0) + 10 * Math.max(0, list.length - 1) + 12 + 10;

const WHO_BASE = 200;
interface WhoPlan { rows: string[]; size: number; lh: number; bottom: number }
/** 抬头的名字：整行放得下（≥46px）就一行，否则均分成两行，字号不低于 44，再放不下才截断。 */
function planWho(ctx: Ctx, text: string): WhoPlan {
  const one = fit(ctx, text, F.s3, 58, 46, CW);
  if (measure(ctx, text, F.s3, one) <= CW) return { rows: [text], size: one, lh: 0, bottom: WHO_BASE };
  let size = 58;
  while (size > 44 && balancedLines(ctx, text, F.s3, size, CW, 2).length > 2) size -= 2;
  const rows = clampLines(ctx, balancedLines(ctx, text, F.s3, size, CW, 2), 2, F.s3, size, CW);
  const lh = Math.round(size * 1.16);
  return { rows, size, lh, bottom: WHO_BASE + lh };
}

function draw(ctx: Ctx, L: SparkCardLines) {
  const lit = L.hero.lit;

  // 落款：底部两行以内，品牌靠右
  const brandW = measure(ctx, L.brand, F.mono, 18, "2px");
  const footW = CW - brandW - 26 - 40;
  const footRows = clampLines(ctx, clauseLines(ctx, L.footer, F.txt, 18, footW, 3), 3, F.txt, 18, footW);
  const lastBase = H - 74;
  const footTop = lastBase - (footRows.length - 1) * 27 - 18;
  const panelBottom = footTop - 30;
  const statRows = Math.ceil(L.stats.length / 3);
  const roomy = !L.calendar && !L.firstLine && !L.words.length;
  // 右栏半径上限：没有日历时光盘让一点宽给主角数字；没有钟点时换成徽记，上面空得多，徽记跟着长大
  const sideCap = L.calendar ? 128 : L.hours ? SIDE_CAP : 165;

  // 面板贴底、按内容定高；放不下时依次让第一句话少折行、词少一行、日历格子变小
  // 第一句话至少留两行：再挤就只缩主角数字
  const tries: Array<[number, number, number]> = [[3, 2, 22], [2, 2, 22], [2, 2, 13], [2, 1, 13]];
  const arrange = (upperTop: number, firstMax: number, wordRows: number, pitch: number, extra: number) => {
    const blocks = [
      ...statsBlocks(ctx, L.stats, roomy, extra),
      balanceBlock(ctx, L, roomy),
      chipBlock(ctx, L.labels.emoji, L.emoji.map((e) => ({ text: e.code, count: `×${n(e.count)}` })), 1),
      chipBlock(ctx, L.labels.words, L.words.map((w) => ({ text: w.word, count: n(w.count) })), wordRows),
      firstLineBlock(ctx, L, firstMax),
    ].filter((b): b is Block => b !== null);
    const panelTop = panelBottom - sumBlocks(blocks);
    const plan = L.calendar ? planCalendar(L.calendar, pitch) : null;
    const calTop = plan ? panelTop - 22 - plan.h : panelTop;
    const heroBottom = plan ? calTop - 12 : panelTop - 26;
    return { blocks, panelTop, plan, calTop, heroBottom, upperTop };
  };
  /** low：光盘压到名字下面（名字长、要用满整行时）；否则光盘可以升到名字旁边。 */
  const compose = (who: WhoPlan, low: boolean) => {
    const upperTop = who.bottom + 22;
    const upperOf = (heroBottom: number) => planUpper(ctx, L, upperTop, heroBottom, low ? who.bottom + 34 : 154, sideCap);
    let layout = arrange(upperTop, 3, 2, 22, 0);
    for (const [firstMax, wordRows, pitch] of tries) {
      layout = arrange(upperTop, firstMax, wordRows, pitch, 0);
      if (layout.heroBottom - upperTop >= 250) {
        // 内容少、上面空得多：主角块上面留一段、下面留一段就够，再多的分给面板里的数据格
        const { hero } = planBeside(ctx, L, upperTop, layout.heroBottom, low ? who.bottom + 34 : 154, sideCap);
        const keep = L.calendar ? 112 : 104;
        const spare = layout.heroBottom - upperTop - hero.block - keep;
        if (spare > 0 && statRows) layout = arrange(upperTop, firstMax, wordRows, pitch, Math.min(72, Math.floor(spare / statRows)));
        break;
      }
    }
    const { side, hero } = upperOf(layout.heroBottom);
    const note = L.hours && L.hoursNote ? 46 : 0;
    const ok = layout.heroBottom - upperTop >= 250 && (!low || layout.heroBottom - side.top >= 2 * 96 + 70 + note);
    return { ...layout, side, hero, ok, who, low };
  };
  // 名字：短的放在光盘旁边；长的用满整行（必要时折两行），光盘挪到名字下面；
  // 实在挤（名字很长、下面还有日历）就让光盘留在旁边，名字缩到 40px、放不下的截断
  const whoFull = planWho(ctx, L.who);
  let pick: ReturnType<typeof compose> | null = null;
  if (whoFull.rows.length === 1) {
    const high = compose(whoFull, false);
    const besideW = high.side.cx - high.side.R - 48 - M;
    if (high.side.cy - high.side.R - 40 >= WHO_BASE + 12 || measure(ctx, L.who, F.s3, whoFull.size) <= besideW) pick = high;
  }
  if (!pick) {
    const low = compose(whoFull, true);
    if (low.ok) pick = low;
  }
  if (!pick) pick = compose({ rows: [L.who], size: 0, lh: 0, bottom: WHO_BASE }, false);
  const { blocks, panelTop, plan, calTop, heroBottom, side, hero } = pick;
  const whoW = pick.low || side.cy - side.R - 40 >= WHO_BASE + 12 ? CW : side.cx - side.R - 48 - M;
  const who: WhoPlan = pick.who.size ? pick.who : { ...pick.who, size: fit(ctx, L.who, F.s3, 58, 40, whoW) };

  // 光尘要躲开的文字框
  const nameW = Math.max(...who.rows.map((row) => Math.min(whoW, measure(ctx, row, F.s3, who.size))));
  const nameBox: Rect = [M, WHO_BASE - who.size * 0.9, M + nameW, who.bottom + 14];
  const noteBox: Rect = [hero.noteX, hero.noteY - 26, Math.min(M + hero.room + 10, hero.noteX + measure(ctx, L.hero.note, F.txt, hero.noteSize)), hero.noteY + 8];
  const unitBox: Rect = [hero.unitX, hero.base - hero.unitSize * 0.86, hero.unitX + hero.unitW, hero.base + 8];
  const avoid: Rect[] = [
    [M, 84, W - M, 126],
    nameBox,
    [M, hero.labelY - 30, M + hero.room, hero.labelY + 10],
    [hero.unitX, hero.base - hero.unitSize, hero.unitX + hero.unitW, hero.base + 12],
    [hero.noteX, hero.noteY - 26, M + hero.room + 10, hero.noteY + 10],
  ];
  if (plan) avoid.push([0, calTop, W, calTop + plan.h]);
  // 光盘连同 0/6/12/18 刻度和底下的小字
  avoid.push([side.cx - side.R - 46, side.cy - side.R - 46, side.cx + side.R + 46, side.cy + side.R + (L.hours && L.hoursNote ? 80 : 46)]);
  // 云顶：有日历时压在日历抬头下面（光点落在云上），没有时贴着主角说明下面
  const skyline = plan ? calTop + 38 : heroBottom - 16;
  const sky = paintSky(lit, M + 380, skyline + 10, panelTop + 40, { quiet: plan ? [calTop - 4, calTop + plan.h + 4] : null, avoid, skyline, flat: !!plan, press: plan ? [] : [noteBox, unitBox] });
  ctx.drawImage(sky, 0, 0);
  ctx.strokeStyle = "rgba(254,255,252,.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(40, 40, W - 80, H - 80, 36); ctx.stroke();

  // 抬头
  put(ctx, L.title, M, 116, { font: F.s3, size: 34, color: CREAM, spacing: "6px" });
  put(ctx, `TRACE · ${L.stamp}`, W - M, 114, { font: F.mono, size: 18, color: SOFT, align: "right", spacing: "5px" });
  hairline(ctx, M, 140, 40, "rgba(238,164,78,.75)");
  who.rows.forEach((row, i) => put(ctx, row, M, WHO_BASE + i * who.lh, { font: F.s3, size: who.size, min: who.size, width: whoW, color: CREAM }));

  drawSide(ctx, L, side);
  drawHero(ctx, L, hero, [nameBox]);
  if (plan) drawCalendar(ctx, L, plan, calTop);

  const panelH = panelBottom - panelTop;
  glass(ctx, sky, PX, panelTop, PW, panelH, 28, lit);
  let y = panelTop + 12;
  blocks.forEach((block, i) => {
    if (i) hairline(ctx, IX, y - 5, IW);
    block.draw(y);
    y += block.h + 10;
  });

  glowDot(ctx, M + 6, footTop + 12, 5, lit ? AMBER : ICE, 12);
  footRows.forEach((row, i) => put(ctx, row, M + 26, footTop + 18 + i * 27, { font: F.txt, size: 18, color: FAINT }));
  put(ctx, L.brand, W - M, lastBase, { font: F.mono, size: 18, color: SOFT, align: "right", spacing: "2px" });
}

export const trace: SparkCardTheme = {
  fontCss: "family=Fraunces:ital,opsz,wght@0,9..144,100..700;1,9..144,100..700&family=Inter:wght@400;500&family=Noto+Sans+SC:wght@400;500&family=Noto+Serif+SC:wght@200;300;500",
  fonts: [F.s3(40), F.it(40), F.it3(40), F.txt(20), f(`400 # ${TEXT}`)(20)],
  draw,
};
