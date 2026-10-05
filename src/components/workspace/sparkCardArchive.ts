import { eachDay, f, fill, H, n, put, W, type FontSpec, type SparkCardLines, type SparkCardStat, type SparkCardTheme } from "./sparkCard";

/*
 * 火花纪念卡 · 档案馆：年度分享图档案馆那张的姊妹篇——冷近黑星图、羊皮纸字、金 / 青、1px 青铜细线、金色 L 角，
 * Cormorant 拉丁小戳（DIES / LIBRA / HORAE…）配思源宋体中文，大数字用思源宋体 200。
 * 火花亮着：金色八角星芒 + 光晕 + 实线星座，数字发金光；没亮：描边空心星、虚线星座，数字是羊皮纸色不发光。
 * 版面按内容伸缩：缺的块不画；先量出每块的高度，剩下的空间先让主角数字变大，再均分成块间距。
 */

const NIGHT = "#111315", PAPER = "#EFDFCC", PAPER2 = "#CFC1B0", MUTE = "#8C8172", SOFT = "#A09383";
const GOLD = "#C59861", GOLD_HI = "#E3C8A6", GOLD_LO = "#8A6238", TEAL = "#8FB3B6", LINE = "#3A3228", LINE2 = "#4A4034";
const SERIF = '"Noto Serif SC","Songti SC","STSong",serif';
const F = {
  s9: f(`900 # ${SERIF}`),
  s7: f(`700 # ${SERIF}`),
  s5: f(`500 # ${SERIF}`),
  // 数字用 Noto Serif SC 细体：Cormorant 默认是旧式数字，canvas 没法开 lining-nums
  num: f(`200 # ${SERIF}`),
  cap: f(`600 # "Cormorant Garamond",${SERIF}`),
  it: f(`italic 500 # "Cormorant Garamond",${SERIF}`),
};
const M = 96;
const CW = W - 2 * M;
const TAU = Math.PI * 2;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
type Ctx = CanvasRenderingContext2D;
type Part = { h: number; draw: (y: number) => void };

const track = (ctx: Ctx, value: string) => { (ctx as Ctx & { letterSpacing?: string }).letterSpacing = value; };
const hair = (ctx: Ctx, x: number, y: number, w: number, h = 1, color = LINE) => fill(ctx, x, y, w, h, color);
function measure(ctx: Ctx, text: string, font: string, spacing = "0px"): number {
  track(ctx, spacing);
  ctx.font = font;
  return ctx.measureText(text).width;
}
// 和 put 一样的缩字号算法，只算出字号不画：几处要先量好再用同一个字号画
function fitSize(ctx: Ctx, text: string, font: FontSpec, size: number, min: number, width: number, spacing = "0px"): number {
  const w0 = measure(ctx, text, font(size), spacing);
  if (w0 > width) size = Math.max(min, Math.floor((size * width) / w0));
  while (size > min && measure(ctx, text, font(size), spacing) > width) size--;
  return size;
}
function dot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}
// 八角星：长短芒交替，和年度分享图同一个
function star(ctx: Ctx, x: number, y: number, r: number, color: string, outline = false, lw = 1.25) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2, d = i % 2 ? r * 0.22 : r;
    ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  ctx.closePath();
  if (outline) { ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); }
}
const pct = (part: number, whole: number) => {
  const value = whole ? (part / whole) * 100 : 0;
  return `${(value > 0 && value < 1) || (value > 99 && value < 100) ? value.toFixed(1) : Math.round(value)}%`;
};
const titleCase = (text: string) => text.toLowerCase().replace(/\b[a-z]/gu, (c) => c.toUpperCase());
// 汉字后面紧跟数字时补一个空格（「我在2025 年」→「我在 2025 年」），和卡上别处「2026 年 10 月」的写法一致；已经有空格的不动
const spaced = (text: string) => text.replace(/(\p{Script=Han})(\d)/gu, "$1 $2");

// 小标题：拉丁小戳 · 中文小标题，金色宽字距
function caption(ctx: Ctx, latin: string, label: string, x: number, y: number, width = CW): number {
  return put(ctx, label ? `${latin} · ${label}` : latin, x, y, { font: F.cap, size: 20, min: 18, width, color: GOLD, spacing: "6px" });
}

// 折行：按词断（中文用 Intl.Segmenter 分词，「视频」「第一句」不会拆到两行；没有分词器就逐字），英文按词，
// 行首不留标点；超过 max 行在最后一行截断，tail（如收尾的引号）留在 … 后面
const CLOSING = /^[，。、！？：；」』）》…,.!?:;)]/u;
const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : null;
const LATIN = /^[A-Za-z0-9@#'’.,\-_]+$|^\s+$/u;
function words(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[A-Za-z0-9@#'’.,\-_]+|\s+|[^A-Za-z0-9@#'’.,\-_\s]+/gu) ?? []) {
    if (LATIN.test(run)) out.push(run);
    else if (segmenter) for (const piece of segmenter.segment(run)) out.push(piece.segment);
    else out.push(...Array.from(run));
  }
  return out;
}
// 切成词；比一行还宽的词再拆成字
function tokenize(ctx: Ctx, text: string, width: number): string[] {
  const out: string[] = [];
  for (const token of words(text)) {
    if (ctx.measureText(token).width > width) out.push(...Array.from(token));
    else out.push(token);
  }
  return out;
}
function breakLines(ctx: Ctx, text: string, width: number, max: number, tail = ""): string[] {
  track(ctx, "0px");
  const tokens = tokenize(ctx, `${text}${tail}`, width);
  const out: string[] = [];
  let row: string[] = [];
  const joined = () => row.join("");
  for (const token of tokens) {
    if (row.length && ctx.measureText(joined() + token).width > width) {
      // 标点不放行首：把上一行最后一个词带下来
      if (CLOSING.test(token) && row.length > 1) {
        const last = row.pop() ?? "";
        out.push(joined().trimEnd());
        row = [last, token];
      } else {
        out.push(joined().trimEnd());
        row = token.trim() ? [token.trimStart()] : [];
      }
    } else row.push(token);
  }
  if (joined().trim()) out.push(joined().trim());
  if (out.length <= max) return out;
  const kept = out.slice(0, max);
  let last = kept[max - 1] ?? "";
  while (Array.from(last).length > 1 && ctx.measureText(`${last}…${tail}`).width > width) last = Array.from(last).slice(0, -1).join("");
  kept[max - 1] = `${last}…${tail}`;
  return kept;
}

// 没截断时折出来的各行拼回去（去掉空白）和原文一模一样
const isCut = (rows: string[], text: string) => rows.join("").replace(/\s/gu, "") !== text.replace(/\s/gu, "");
// 均衡折行：行数不变，在所有能断的词缝里挑「最长一行最短」的断法，几行差不多长，不会剩一两个字单独一行；
// 下一行如果以夹在汉字中间的单字词开头（「同一 / 天都」），多半是把一个词组拆开了，按多一个字宽来罚
const OPENING = /[「『（《(“]$/u, HAN = /\p{Script=Han}$/u, HAN1 = /^\p{Script=Han}$/u;
function balanced(ctx: Ctx, text: string, width: number, max: number, tail = ""): string[] {
  const greedy = breakLines(ctx, text, width, max, tail), full = `${text}${tail}`;
  if (greedy.length < 2 || greedy.length > 3 || isCut(greedy, full)) return greedy;
  track(ctx, "0px");
  const t = tokenize(ctx, full, width), n = t.length, em = ctx.measureText("中").width;
  const memo = new Map<number, number>();
  const seg = (i: number, j: number) => t.slice(i, j).join("").trim();
  const wid = (i: number, j: number) => {
    let v = memo.get(i * 4096 + j);
    if (v === undefined) memo.set(i * 4096 + j, (v = ctx.measureText(seg(i, j)).width));
    return v;
  };
  const ok = (j: number) => !CLOSING.test(t[j] ?? "") && !OPENING.test(t[j - 1] ?? "") && seg(0, j) !== "" && seg(j, n) !== "";
  // 单字前后都紧挨着汉字才算拆了词组；后面跟着数字、空格、标点的（「里 / 有 1 条」）不罚
  const bad = (j: number) => (HAN1.test(t[j] ?? "") && HAN.test(t[j - 1] ?? "") && /^\p{Script=Han}/u.test(t[j + 1] ?? "") ? em * 1.2 : 0);
  let best: number[] | null = null, bestCost = Infinity;
  const consider = (cuts: number[]) => {
    const edges = [0, ...cuts, n];
    let widest = 0, cost = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const w = wid(edges[i] ?? 0, edges[i + 1] ?? n);
      if (w > width) return;
      widest = Math.max(widest, w);
    }
    for (const cut of cuts) cost += bad(cut);
    cost += widest;
    if (cost < bestCost) { bestCost = cost; best = cuts; }
  };
  for (let j = 1; j < n; j++) {
    if (!ok(j)) continue;
    if (greedy.length === 2) consider([j]);
    else for (let k = j + 1; k < n; k++) if (ok(k) && seg(j, k) !== "") consider([j, k]);
  }
  const cuts: number[] | null = best;
  if (!cuts) return greedy;
  const edges = [0, ...cuts, n];
  return edges.slice(0, -1).map((edge, i) => seg(edge, edges[i + 1] ?? n));
}

function backdrop(ctx: Ctx) {
  fill(ctx, 0, 0, W, H, NIGHT);
  const g = ctx.createRadialGradient(W * 0.55, H * 0.4, 80, W * 0.55, H * 0.4, H * 0.8);
  g.addColorStop(0, "rgba(27,31,32,.9)");
  g.addColorStop(1, "rgba(10,11,11,1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 页框 + 金色 L 角
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(48.5, 48.5, W - 97, H - 97);
  ctx.strokeStyle = GOLD_LO;
  for (const [x, y, dx, dy] of [[42, 42, 1, 1], [W - 42, 42, -1, 1], [42, H - 42, 1, -1], [W - 42, H - 42, -1, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5 * dx, y + 34 * dy);
    ctx.lineTo(x + 0.5 * dx, y + 0.5 * dy);
    ctx.lineTo(x + 34 * dx, y + 0.5 * dy);
    ctx.stroke();
  }
}

// 星尘：固定种子，每次存出来的都一样。等字和图都画完了再撒，撒之前看一眼那一点左右 42px、上下 34px 有没有画过东西，
// 有就跳过——不会落在字旁边像个多出来的标点（「· 9 月 30 日」「12°」）
function stardust(ctx: Ctx) {
  let px: Uint8ClampedArray | null = null;
  try { px = ctx.getImageData(0, 0, W, H).data; } catch { px = null; }
  const busy = (x: number, y: number) => {
    if (!px) return x > 48 && x < W - 48 && y > 48 && y < H - 48;
    for (let dy = -34; dy <= 34; dy += 2) for (let dx = -42; dx <= 42; dx += 2) {
      const xx = Math.round(x + dx), yy = Math.round(y + dy);
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const i = (yy * W + xx) * 4;
      if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) > 200) return true;
    }
    return false;
  };
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 180; i++) {
    const alpha = 0.1 + rnd() * 0.36, x = rnd() * W, y = rnd() * H, r = 0.5 + rnd() * 1.2, color = rnd() < 0.2 ? GOLD_HI : PAPER2;
    if (busy(x, y)) continue;
    ctx.globalAlpha = alpha;
    dot(ctx, x, y, r, color);
  }
  ctx.globalAlpha = 1;
}

// ---------------- 主角：火花星芒 ----------------
function spark(ctx: Ctx, cx: number, cy: number, r: number, lit: boolean) {
  const sats = ([[-1.5, 0.95, 0.2], [1.2, -1.2, 0.15], [1.55, 0.7, 0.11], [-0.8, -1.3, 0.09]] as const).map(([dx, dy, s]) => ({ x: cx + dx * r, y: cy + dy * r, s: s * r }));
  const [a, b, c, d] = sats;
  ctx.save();
  if (lit) {
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
    halo.addColorStop(0, "rgba(227,200,166,.26)");
    halo.addColorStop(0.35, "rgba(197,152,97,.1)");
    halo.addColorStop(1, "rgba(197,152,97,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, TAU);
    ctx.fill();
  }
  // 星座连线：亮着是实线，没亮是虚线
  ctx.lineWidth = 1;
  ctx.strokeStyle = lit ? "rgba(197,152,97,.6)" : "rgba(160,147,131,.6)";
  if (!lit) ctx.setLineDash([3, 6]);
  const link = (p: { x: number; y: number }, q: { x: number; y: number }, gapP: number, gapQ: number) => {
    const len = Math.hypot(q.x - p.x, q.y - p.y), ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
    ctx.beginPath();
    ctx.moveTo(p.x + ux * gapP, p.y + uy * gapP);
    ctx.lineTo(q.x - ux * gapQ, q.y - uy * gapQ);
    ctx.stroke();
  };
  const center = { x: cx, y: cy };
  if (a && b && c && d) {
    link(a, center, a.s + 6, r * 0.45);
    link(center, b, r * 0.45, b.s + 6);
    link(b, c, b.s + 6, c.s + 6);
    link(center, d, r * 0.45, d.s + 6);
  }
  ctx.setLineDash([]);
  if (lit) {
    // 十字星芒
    for (const [w, h] of [[r * 2.1, 0], [0, r * 2.1]] as const) {
      const lg = ctx.createLinearGradient(cx - w, cy - h, cx + w, cy + h);
      lg.addColorStop(0, "rgba(227,200,166,0)");
      lg.addColorStop(0.5, "rgba(247,234,214,.85)");
      lg.addColorStop(1, "rgba(227,200,166,0)");
      ctx.fillStyle = lg;
      if (w) ctx.fillRect(cx - w, cy - 0.75, w * 2, 1.5);
      else ctx.fillRect(cx - 0.75, cy - h, 1.5, h * 2);
    }
    ctx.shadowColor = "rgba(227,200,166,.85)";
    ctx.shadowBlur = r * 0.7;
    star(ctx, cx, cy, r, GOLD_HI);
    ctx.shadowBlur = r * 0.3;
    star(ctx, cx, cy, r * 0.42, "#FFF3E0");
    ctx.shadowBlur = 8;
    for (const s of sats) star(ctx, s.x, s.y, s.s, GOLD);
  } else {
    // 熄了的星：比亮着的大一号、不发光，只剩金色细线勾的空心轮廓，把主角这一行撑满
    star(ctx, cx, cy, r, "rgba(197,152,97,.8)", true, 1.5);
    star(ctx, cx, cy, r * 0.42, "rgba(197,152,97,.35)", true, 1);
    ctx.strokeStyle = SOFT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.09, 0, TAU);
    ctx.stroke();
    for (const s of sats) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2.5, s.s * 0.45), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 主角的尺寸都从目标字号 S 推出来：数字放不下时先把右边的星芒缩小（最小半径 48），还放不下再缩数字；
// 数字顶端、基线、说明行都按缩完的实际字号排，千分位逗号往下伸多少，说明行就往下让多少
type Hero = { S: number; size: number; us: number; r: number; art: number; base: number; noteOff: number; cy: number; h: number };
const unitSize = (size: number) => Math.max(40, Math.min(72, Math.round(size * 0.3)));
function heroMetrics(ctx: Ctx, L: SparkCardLines, S: number): Hero {
  const { value, unit } = L.hero;
  const rFull = Math.round(S * (L.hero.lit ? 0.3 : 0.36)), rMin = Math.min(rFull, 48);
  let size = S, r = rFull, us = unitSize(S);
  // 两遍：第一遍按 S 的单位字号算出数字字号，第二遍按数字的实际字号定单位字号再排一次
  for (let pass = 0; pass < 2; pass++) {
    if (pass) us = unitSize(size);
    const room = CW - (measure(ctx, unit, F.s7(us)) + 18) - 10, nw = measure(ctx, value, F.num(S));
    if (nw + rFull * 3.5 <= room) { size = S; r = rFull; }
    else if (nw + rMin * 3.5 <= room) { size = S; r = Math.floor((room - nw) / 3.5); }
    else { r = rMin; size = fitSize(ctx, value, F.num, S, 72, room - Math.round(rMin * 3.5)); }
  }
  track(ctx, "0px");
  ctx.font = F.num(size);
  const descent = Math.max(0, ctx.measureText(value).actualBoundingBoxDescent || 0);
  const base = 44 + Math.round(size * 0.72), noteOff = Math.max(48, Math.ceil(descent) + 36);
  const cy = 44 + Math.round(size * 0.34);
  return { S, size, us, r, art: Math.round(r * 3.5), base, noteOff, cy, h: Math.max(base + noteOff + 12, cy + Math.round(r * 1.3)) };
}

function hero(ctx: Ctx, L: SparkCardLines, y: number, m: Hero) {
  const { label, value, unit, note, lit } = L.hero;
  const base = y + m.base, cx = W - M - Math.round(m.r * 1.75);
  caption(ctx, unit === "天" ? "DIES" : "NUMERUS", label, M, y + 22, CW - m.art);
  spark(ctx, cx, y + m.cy, m.r, lit);
  let nw: number;
  if (lit) nw = put(ctx, value, M - 6, base, { font: F.num, size: m.size, color: GOLD_HI, glow: "rgba(227,200,166,.3)" });
  else {
    // 没亮：压暗的实心字外面一圈羊皮纸色细边，像熄了的灯丝；不发光，一眼看得出「没亮」，但分量还在。
    // 先描边再用不透明的暗色填上：字形里互相重叠的轮廓（「1」的脚、「4」的横）不会透出线来
    track(ctx, "0px");
    ctx.font = F.num(m.size);
    ctx.textAlign = "left";
    ctx.strokeStyle = PAPER2;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.strokeText(value, M - 6, base);
    ctx.fillStyle = "#615C55";
    ctx.fillText(value, M - 6, base);
    nw = ctx.measureText(value).width;
  }
  put(ctx, unit, M - 6 + nw + 18, base, { font: F.s7, size: m.us, color: lit ? PAPER : SOFT });
  put(ctx, spaced(note), M, base + m.noteOff, { font: F.s5, size: 26, min: 18, width: CW - m.art, color: lit ? PAPER2 : SOFT });
}

// ---------------- 六格 / 五格数据 ----------------
type Cell = { st: SparkCardStat; idx: number; x: number; pad: number; inner: number };
type Row = { cells: Cell[]; wrap: boolean; ornament: number | null };
type Stats = { rows: Row[]; vs: number };
// 带年份的日期（「2025 年 12 月 22 日」）一格放不下时，把「2025 年」挪到说明行开头，主值保持和别的格一样大
const YEAR = /^(\d{4}\s*年)\s*(.+)$/u;
function statRows(ctx: Ctx, stats: SparkCardStat[], elsewhere: string[] = []): Stats {
  const rows: Row[] = [], col = CW / 3;
  // 同一句说明在卡上只写一次（群卡上「最常聊的钟点」和「聊得最晚的一次」常是同一句「群消息不存本机…」），后面的格子留空；
  // 钟点图下面已经写了的那句（「按最近读到的 70 条算」），格子里也不再写
  const seen = new Set<string>(elsewhere.filter(Boolean).map(spaced));
  const clean = stats.map((raw) => {
    const s = spaced(raw.s);
    if (s && seen.has(s)) return { ...raw, s: "" };
    if (s) seen.add(s);
    return { ...raw, s };
  });
  for (let i = 0; i < clean.length; i += 3) {
    const slice = clean.slice(i, i + 3);
    // 不管这一行几格都按三列网格排，上下两行的竖线和罗马数字对齐；空出来的列放一颗装饰星
    const cells = slice.map((raw, j) => {
      const pad = j ? 28 : 0, inner = col - pad - (j < 2 ? 22 : 0);
      const year = raw.v.match(YEAR);
      let st = raw;
      if (year?.[1] && year[2] && measure(ctx, raw.v, F.s7(40)) > inner) {
        const joined = raw.s ? `${year[1]} · ${raw.s}` : year[1];
        st = { k: raw.k, v: year[2], s: measure(ctx, joined, F.s5(18)) <= inner ? joined : `${year[1]}\n${raw.s}` };
      }
      return { st, idx: i + j, x: M + j * col, pad, inner };
    });
    rows.push({ cells, wrap: cells.some((cell) => cell.st.s.includes("\n") || (cell.st.s !== "" && measure(ctx, cell.st.s, F.s5(18)) > cell.inner)), ornament: slice.length < 3 ? M + slice.length * col : null });
  }
  // 主值全卡一个字号：哪格放不下就大家一起缩，不会一格 28px 旁边 40px
  const vs = Math.min(40, ...rows.flatMap((row) => row.cells.map((cell) => fitSize(ctx, cell.st.v, F.s7, 40, 26, cell.inner))));
  return { rows, vs };
}
const ROW_H = 114, WRAP_H = 24;
function sub(ctx: Ctx, text: string, x: number, y: number, width: number) {
  if (!text) return;
  if (text.includes("\n")) {
    text.split("\n").forEach((line, i) => put(ctx, line, x, y + i * WRAP_H, { font: F.s5, size: 18, width, color: SOFT }));
    return;
  }
  for (const size of [19, 18]) if (measure(ctx, text, F.s5(size)) <= width) { put(ctx, text, x, y, { font: F.s5, size, color: SOFT }); return; }
  ctx.font = F.s5(18);
  balanced(ctx, text, width, 2).forEach((line, i) => put(ctx, line, x, y + i * WRAP_H, { font: F.s5, size: 18, color: SOFT }));
}
function drawRow(ctx: Ctx, row: Row, y: number, h: number, g: number, vs: number) {
  if (row.ornament !== null) {
    const x = row.ornament, cx = Math.round((x + M + CW) / 2), cy = Math.round(y + h / 2);
    hair(ctx, x, y + 12, 1, h - 22);
    hair(ctx, cx - 74, cy, 52, 1, LINE2);
    hair(ctx, cx + 22, cy, 52, 1, LINE2);
    dot(ctx, cx - 82, cy + 0.5, 2, GOLD_LO);
    dot(ctx, cx + 82, cy + 0.5, 2, GOLD_LO);
    star(ctx, cx, cy, 13, GOLD);
  }
  row.cells.forEach((cell, j) => {
    const x = cell.x + cell.pad;
    if (j) hair(ctx, cell.x, y + 12, 1, h - 22);
    put(ctx, ROMAN[cell.idx] ?? "", x + cell.inner, y + 30 + g * 0.3, { font: F.cap, size: 18, color: "rgba(197,152,97,.8)", align: "right", spacing: "2px" });
    put(ctx, cell.st.k, x, y + 30 + g * 0.3, { font: F.s5, size: 21, min: 18, width: cell.inner - 44, color: TEAL, spacing: "2px" });
    put(ctx, cell.st.v, x, y + 75 + g * 0.6, { font: F.s7, size: vs, min: 26, width: cell.inner, color: cell.st.v === "—" ? MUTE : PAPER });
    sub(ctx, cell.st.s, x, y + 104 + g * 0.8, cell.inner);
  });
}

// ---------------- 24 小时：细茎星点，最常聊的钟点是金星 ----------------
// 茎高按平方根比例：几条和十几条也看得出高低，不会只剩峰值一根、其余全是一样的短茎；刻度和茎都对在钟点正中
function hoursChart(ctx: Ctx, L: SparkCardLines, hours: number[], x: number, y: number, w: number, bh: number) {
  caption(ctx, "HORAE", L.labels.hours, x, y + 22, w);
  const max = Math.max(1, ...hours), top = y + 50, base = top + bh, pitch = w / 24;
  const peak = L.peakHour;
  const mid = (i: number) => Math.round(x + (i + 0.5) * pitch);
  hair(ctx, x, base, w, 1, LINE2);
  hours.forEach((v, i) => {
    const cx = mid(i);
    if (!v) { dot(ctx, cx, base - 5, 1.6, "rgba(160,147,131,.55)"); return; }
    const k = Math.sqrt(v / max), len = Math.max(7, Math.round(bh * k));
    if (i === peak) {
      fill(ctx, cx - 1, base - len, 3, len, GOLD_HI);
      ctx.save();
      ctx.shadowColor = "rgba(227,200,166,.9)";
      ctx.shadowBlur = 14;
      star(ctx, cx + 0.5, base - len, 11, GOLD_HI);
      ctx.restore();
    } else {
      const color = `rgba(207,193,176,${(0.3 + 0.55 * k).toFixed(2)})`;
      fill(ctx, cx - 1, base - len, 2, len, color);
      dot(ctx, cx, base - len, 3, color);
    }
  });
  const peakX = peak === null ? null : mid(peak);
  for (const t of [0, 6, 12, 18, 23]) {
    const tx = mid(t);
    hair(ctx, tx, base, 1, 6, LINE2);
    if (peakX !== null && t !== peak && Math.abs(peakX - tx) < 34) continue;
    if (t === peak) continue;
    put(ctx, String(t).padStart(2, "0"), tx, base + 26, { font: F.s5, size: 18, color: SOFT, align: "center" });
  }
  if (peakX !== null && peak !== null) {
    hair(ctx, peakX, base, 1, 6, GOLD);
    put(ctx, String(peak).padStart(2, "0"), peakX, base + 26, { font: F.s7, size: 19, color: GOLD_HI, align: "center" });
  }
  if (L.hoursNote) put(ctx, spaced(L.hoursNote), x, base + 56, { font: F.s5, size: 18, width: w, color: SOFT });
}
const hoursH = (L: SparkCardLines, bh: number) => 50 + bh + 32 + (L.hoursNote ? 30 : 0);

// ---------------- 谁说得多：一根分成两截的天平条 ----------------
function balanceBar(ctx: Ctx, b: NonNullable<SparkCardLines["balance"]>, label: string, x: number, y: number, w: number, big: boolean) {
  caption(ctx, "LIBRA", label, x, y + 22, w);
  const total = Math.max(1, b.mine + b.theirs);
  const ns = big ? 76 : 48, ls = big ? 26 : 22;
  const base = y + 46 + Math.round(ns * 0.72), half = w / 2 - 12;
  const lw = put(ctx, b.mineLabel, x, base, { font: F.s7, size: ls, color: GOLD });
  const rw = put(ctx, b.theirsLabel, x + w, base, { font: F.s7, size: ls, color: TEAL, align: "right" });
  // 两边各自放得下的最大字号取小的那个，同一个字号画，天平两头一样大
  const size = Math.min(fitSize(ctx, n(b.mine), F.num, ns, 24, half - lw - 10), fitSize(ctx, n(b.theirs), F.num, ns, 24, half - rw - 10));
  put(ctx, n(b.mine), x + lw + 10, base, { font: F.num, size, min: 24, width: half - lw - 10, color: GOLD_HI });
  put(ctx, n(b.theirs), x + w - rw - 10, base, { font: F.num, size, min: 24, width: half - rw - 10, color: TEAL, align: "right" });
  const by = base + (big ? 22 : 18), bh = big ? 8 : 6;
  hair(ctx, x, by + bh / 2, w, 1, LINE);
  const gap = b.mine && b.theirs ? 3 : 0;
  let mw = b.mine ? Math.max(2, Math.round((w * b.mine) / total)) : 0;
  if (b.theirs) mw = Math.min(mw, w - 2 - gap);
  if (mw) fill(ctx, x, by, mw, bh, GOLD);
  if (b.theirs) fill(ctx, x + mw + gap, by, w - mw - gap, bh, TEAL);
  put(ctx, pct(b.mine, total), x, by + bh + 26, { font: F.s5, size: 18, color: GOLD });
  put(ctx, pct(b.theirs, total), x + w, by + bh + 26, { font: F.s5, size: 18, color: TEAL, align: "right" });
}
const balanceH = (big: boolean) => 46 + Math.round((big ? 76 : 48) * 0.72) + (big ? 22 + 8 : 18 + 6) + 31;

// level：0 宽松（钟点图高一些）、1 一般、2 紧凑
function chartsBlock(ctx: Ctx, L: SparkCardLines, level: number): Part | null {
  const { hours, balance } = L;
  const bh = level === 0 ? 68 : level === 1 ? 60 : 54;
  if (hours && balance) {
    const bw = 318, hw = CW - bw - 64, h = Math.max(hoursH(L, bh), balanceH(false));
    return {
      h,
      draw: (y) => {
        hoursChart(ctx, L, hours, M, y, hw, bh);
        hair(ctx, M + hw + 32, y + 8, 1, h - 12);
        balanceBar(ctx, balance, L.labels.balance, M + hw + 64, y, bw, false);
      },
    };
  }
  if (hours) return { h: hoursH(L, bh), draw: (y) => hoursChart(ctx, L, hours, M, y, CW, bh) };
  if (balance) return { h: balanceH(true), draw: (y) => balanceBar(ctx, balance, L.labels.balance, M, y, CW, true) };
  return null;
}

// ---------------- 聊天的每一天：星图式日历格 ----------------
const CAL_BOTH = GOLD_HI, CAL_MINE = "rgba(197,152,97,.5)", CAL_THEIRS = "rgba(143,179,182,.55)";
const calColor = (who: string | undefined) => (who === "both" ? CAL_BOTH : who === "mine" ? CAL_MINE : who === "theirs" ? CAL_THEIRS : null);
const at = (iso: string) => new Date(`${iso}T12:00:00`);
// 一天一格：双方 / 我 / TA 是实心；认不出是谁的那天是羊皮纸色细描边的空心格（有消息，但说不准是谁）；没消息交给 empty
function calCell(ctx: Ctx, x: number, y: number, size: number, who: string | undefined, empty: () => void) {
  const color = calColor(who);
  if (color) fill(ctx, x, y, size, size, color);
  else if (who === "one") {
    const lw = size >= 20 ? 1.5 : 1;
    ctx.strokeStyle = "rgba(207,193,176,.85)";
    ctx.lineWidth = lw;
    ctx.strokeRect(x + lw / 2, y + lw / 2, size - lw, size - lw);
  } else empty();
}

// 图例：我 & TA / 我 / TA；有认不出是谁的日子时再补一个空心格配「?」
function legend(ctx: Ctx, L: SparkCardLines, right: number, y: number, unknown: boolean): number {
  const me = L.balance?.mineLabel ?? "我", them = L.balance?.theirsLabel ?? "TA";
  const items: Array<[string | null, string]> = [[CAL_BOTH, `${me} & ${them}`], [CAL_MINE, me], [CAL_THEIRS, them]];
  if (unknown) items.push([null, "?"]);
  const widths = items.map(([, text]) => 13 + 8 + measure(ctx, text, F.s5(18)));
  const total = widths.reduce((sum, value) => sum + value, 0) + 24 * (items.length - 1);
  let x = right - total;
  items.forEach(([color, text], i) => {
    if (color) fill(ctx, x, y - 13, 13, 13, color);
    else {
      ctx.strokeStyle = "rgba(207,193,176,.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y - 13 + 0.75, 11.5, 11.5);
    }
    put(ctx, text, x + 21, y, { font: F.s5, size: 18, color: PAPER2 });
    x += (widths[i] ?? 0) + 24;
  });
  return total;
}

// 拉丁小戳里夹数字：Cormorant 的数字是旧式的（比大写矮、往下沉，像下标），数字换成思源宋体的等高数字
type Seg = [string, FontSpec, string];
const segsWidth = (ctx: Ctx, segs: Seg[]) => segs.reduce((sum, [text, font, spacing]) => sum + measure(ctx, text, font(18), spacing), 0);
function drawSegs(ctx: Ctx, segs: Seg[], x: number, y: number, color: string) {
  for (const [text, font, spacing] of segs) x += put(ctx, text, x, y, { font, size: 18, color, spacing });
}

function calendarBlock(ctx: Ctx, L: SparkCardLines, level: number): Part | null {
  const cal = L.calendar;
  if (!cal) return null;
  const all = eachDay(cal.start, cal.end);
  const first = all[0];
  if (!first) return null;
  const who = new Map(cal.days.map((day) => [day.date, day.who] as const));
  const active = cal.days.length, unknown = cal.days.some((day) => day.who === "one");
  const head = (y: number, extra: Seg[]) => {
    const lw = legend(ctx, L, M + CW, y + 22, unknown);
    const cw = caption(ctx, "CALENDARIUM", L.labels.calendar, M, y + 22, CW - lw - 28);
    if (extra.length && cw + 24 + segsWidth(ctx, extra) < CW - lw - 28) drawSegs(ctx, extra, M + cw + 24, y + 22, SOFT);
  };
  // 右边有空就放「有消息的天数 / 总天数」；周格子右边空得不多时放紧凑的三行版
  const tally = (y: number, room: number, compact = false) => {
    const right = M + CW;
    if (room >= 230) {
      put(ctx, "DAYS ON RECORD", right, y, { font: F.cap, size: 18, color: GOLD, align: "right", spacing: "4px" });
      const tw = put(ctx, ` / ${n(all.length)}`, right, y + 58, { font: F.s5, size: 24, color: SOFT, align: "right" });
      put(ctx, n(active), right - tw, y + 58, { font: F.num, size: 60, min: 30, width: room - tw - 20, color: GOLD_HI, align: "right" });
    } else if (compact && room >= 80) {
      put(ctx, "DIES", right, y, { font: F.cap, size: 18, color: GOLD, align: "right", spacing: "4px" });
      put(ctx, n(active), right, y + 54, { font: F.num, size: 54, min: 30, width: room - 10, color: GOLD_HI, align: "right" });
      put(ctx, `/ ${n(all.length)}`, right, y + 86, { font: F.s5, size: 22, min: 18, width: room - 10, color: SOFT, align: "right" });
    }
  };

  if (all.length <= 21) {
    // 天数少：格子放大（最大 72），在左边留给格子的那段里铺开；格子和右边天数统计之间空得多，就拉一行目录式的引导点连过去
    const count = all.length, region = CW - 270;
    const cell = Math.min(72, Math.floor((region - 10 * (count - 1)) / count));
    const gap = count > 1 ? Math.max(10, Math.min(Math.round(cell * 0.3), Math.floor((region - count * cell) / (count - 1)))) : 0;
    const used = count * cell + (count - 1) * gap;
    return {
      h: 44 + Math.max(cell + 38, 84),
      draw: (y) => {
        head(y, []);
        const gy = y + 44;
        all.forEach((iso, i) => {
          const x = M + i * (cell + gap), date = at(iso);
          calCell(ctx, x, gy, cell, who.get(iso), () => { ctx.strokeStyle = LINE2; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, gy + 0.5, cell - 1, cell - 1); });
          const label = i === 0 || date.getDate() === 1 ? `${date.getMonth() + 1}.${date.getDate()}` : String(date.getDate());
          put(ctx, label, x + cell / 2, gy + cell + 28, { font: F.s5, size: 18, color: SOFT, align: "center" });
        });
        const from = M + used + 22, to = M + CW - 250, ly = gy + Math.round(cell / 2);
        if (to - from >= 60) for (let x = from; x <= to; x += 10) dot(ctx, x, ly, 1.3, "rgba(160,147,131,.5)");
        tally(gy + 18, CW - used - 40);
      },
    };
  }

  // 半年以内：一个月一行，像账簿那样按日排开，比周格子铺得满
  const months: Array<{ y: number; m: number; days: string[] }> = [];
  for (const iso of all) {
    const date = at(iso), last = months[months.length - 1];
    if (last && last.y === date.getFullYear() && last.m === date.getMonth()) last.days.push(iso);
    else months.push({ y: date.getFullYear(), m: date.getMonth(), days: [iso] });
  }
  if (months.length <= 6) {
    const labelW = 78, gap = 4, pitch = Math.floor((CW - labelW + gap) / 31), cell = pitch - gap;
    return {
      h: 44 + months.length * pitch - gap + 34,
      draw: (y) => {
        head(y, []);
        const gy = y + 44;
        months.forEach((month, r) => {
          const yy = gy + r * pitch;
          put(ctx, `${month.y}.${month.m + 1}`, M, yy + cell - 3, { font: F.s5, size: 18, color: SOFT });
          for (const iso of month.days) {
            const x = M + labelW + (at(iso).getDate() - 1) * pitch;
            calCell(ctx, x, yy, cell, who.get(iso), () => dot(ctx, x + cell / 2, yy + cell / 2, 1.4, "rgba(140,129,114,.45)"));
          }
        });
        for (const d of [1, 10, 20, 31]) put(ctx, String(d), M + labelW + (d - 1) * pitch + cell / 2, gy + months.length * pitch - gap + 28, { font: F.s5, size: 18, color: SOFT, align: "center" });
      },
    };
  }

  let off = (at(first).getDay() + 6) % 7, days = all, weeks = Math.ceil((off + days.length) / 7), cropped = false;
  if (weeks > 60) {
    // 太多周了：只画最近 52 周
    const endCol = Math.floor((off + days.length - 1) / 7);
    days = days.slice((endCol - 51) * 7 - off);
    off = 0;
    weeks = 52;
    cropped = true;
  }
  // 周数少（半年出头）：格子放大到右边刚好留出完整的天数统计；一般按 18px 排，右边留得出紧凑的天数统计就留着；
  // 留不出就把格子放大，铺满整栏，不在右边空一条
  let pitch = Math.max(6, Math.min(18, Math.floor((CW + 3) / weeks)));
  if (Math.floor((CW - 270 + 3) / weeks) > 18) pitch = Math.min(24, Math.floor((CW - 270 + 3) / weeks));
  else if (CW - (weeks * pitch - 3) - 40 < 80) pitch = Math.max(6, Math.min(21, Math.floor((CW + 3) / weeks)));
  // 紧凑版面：格子小一号，给别的块让出高度
  if (level >= 2) pitch = Math.max(6, pitch - 1);
  const gap = pitch >= 12 ? 3 : 2, cell = pitch - gap;
  const gridW = weeks * pitch - gap, gridH = 7 * pitch - gap;
  // 月份刻度只写月数字（最宽两位数，相邻月至少隔 4 列，不会互相挤掉）；年份另起一行，金色，标在第一个月和每个 1 月下面
  type Tick = { x: number; m: number; yr: number; w: number; partial: boolean };
  const ticks: Tick[] = [];
  days.forEach((iso, i) => {
    const date = at(iso);
    const left = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() - date.getDate() + 1;
    // 开头那个不完整的月，剩下的天数够两列才标
    if (date.getDate() !== 1 && !(i === 0 && left >= 14)) return;
    const m = date.getMonth() + 1, x = M + Math.floor((off + i) / 7) * pitch, w = measure(ctx, String(m), F.s5(18));
    if (x + w > M + CW) return;
    const prev = ticks[ticks.length - 1];
    if (prev && x < prev.x + prev.w + 8) {
      if (!prev.partial) return;
      ticks.pop();
    }
    ticks.push({ x, m, yr: date.getFullYear(), w, partial: date.getDate() !== 1 });
  });
  // 开头不满一个月的那个刻度，离下一个刻度近得放不下它的年份，就不标（不然「12 1」挤在一起，12 下面又没年份，像是下一年的 12 月）
  const [t0, t1] = ticks;
  if (t0?.partial && t1 && t1.x - t0.x < measure(ctx, String(t0.yr), F.s5(18)) + 16) ticks.shift();
  const years = ticks.filter((tick, i) => i === 0 || tick.m === 1);
  return {
    h: 44 + gridH + 58,
    draw: (y) => {
      head(y, cropped ? [["LAST ", F.cap, "4px"], ["52", F.s5, "1px"], [" WEEKS", F.cap, "4px"]] : []);
      const gy = y + 44;
      days.forEach((iso, i) => {
        const x = M + Math.floor((off + i) / 7) * pitch, yy = gy + ((off + i) % 7) * pitch;
        calCell(ctx, x, yy, cell, who.get(iso), () => dot(ctx, x + cell / 2, yy + cell / 2, Math.max(1, cell * 0.09), "rgba(140,129,114,.4)"));
      });
      for (const tick of ticks) put(ctx, String(tick.m), tick.x, gy + gridH + 26, { font: F.s5, size: 18, color: SOFT });
      let yearEnd = -Infinity;
      years.forEach((tick, i) => {
        const label = String(tick.yr), w = measure(ctx, label, F.s5(18)), next = years[i + 1];
        const x = Math.min(tick.x, M + CW - w);
        // 第一个月离下一个 1 月太近就让给 1 月
        if (x < yearEnd + 12 || (next && x + w + 12 > next.x)) return;
        put(ctx, label, x, gy + gridH + 50, { font: F.s5, size: 18, color: GOLD });
        yearEnd = x + w;
      });
      tally(gy + 18, CW - gridW - 40, true);
    },
  };
}

// ---------------- 表情、词、第一句话 ----------------
type Chip = { text: string; count: string; tw: number; cw: number; size: number };
const CHIP_GAP = 32;
const partGap = (level: number) => (level >= 2 ? 10 : 16);
// maxRows：紧凑版面只留前两行（词和表情都是按次数排好的，丢掉的是次数最少的几个）
function chipRows(ctx: Ctx, items: Array<{ text: string; count: string }>, w: number, maxRows = Infinity): Chip[][] {
  const rows: Chip[][] = [];
  let row: Chip[] = [], x = 0;
  for (const item of items) {
    let size = 24, tw = measure(ctx, item.text, F.s7(size));
    const cw = measure(ctx, item.count, F.s5(19));
    while (tw + 8 + cw > w && size > 18) tw = measure(ctx, item.text, F.s7(--size));
    tw = Math.min(tw, w - 8 - cw);
    const chipW = tw + 8 + cw;
    if (row.length && x + CHIP_GAP + chipW > w) { rows.push(row); row = []; x = 0; }
    x += (row.length ? CHIP_GAP : 0) + chipW;
    row.push({ text: item.text, count: item.count, tw, cw, size });
  }
  if (row.length) rows.push(row);
  return rows.slice(0, maxRows);
}
function chipSection(ctx: Ctx, latin: string, label: string, items: Array<{ text: string; count: string }>, w: number, level = 1) {
  const lh = level >= 2 ? 32 : 36, first = level >= 2 ? 54 : 60;
  const rows = chipRows(ctx, items, w, level >= 2 ? 2 : Infinity);
  return {
    h: first + (rows.length - 1) * lh + 8,
    draw: (x: number, y: number) => {
      caption(ctx, latin, label, x, y + 22, w);
      rows.forEach((row, r) => {
        let cx = x;
        const by = y + first + r * lh;
        row.forEach((chip, i) => {
          // 项与项之间一个金色间隔点（小星芒缩到这么小会看成加号）
          if (i) { dot(ctx, cx + CHIP_GAP / 2, by - 8, 2.4, "rgba(197,152,97,.8)"); cx += CHIP_GAP; }
          const tw = put(ctx, chip.text, cx, by, { font: F.s7, size: chip.size, min: chip.size, width: chip.tw + 0.5, color: PAPER });
          put(ctx, chip.count, cx + tw + 8, by, { font: F.s5, size: 19, color: GOLD });
          cx += tw + 8 + chip.cw;
        });
      });
    },
  };
}
// 只有表情或只有词、又没有第一句话时：居中大字。宽度按字形实际的墨迹量（字距会在最后一个字后面也加一份，不能算进去），
// 两头不超出左右内容边线
function signatureSection(ctx: Ctx, latin: string, label: string, items: Array<{ text: string; count: string }>): Part | null {
  const gap = 76, spacing = "4px";
  const ink = (text: string, size: number) => {
    track(ctx, spacing);
    ctx.font = F.s9(size);
    ctx.textAlign = "left";
    const m = ctx.measureText(text);
    return { l: m.actualBoundingBoxLeft, w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight };
  };
  const room = CW - 4 - gap * (items.length - 1);
  let size = Math.min(60, Math.floor((60 * room) / Math.max(1, items.reduce((sum, item) => sum + ink(item.text, 60).w, 0))));
  while (size > 36 && items.reduce((sum, item) => sum + ink(item.text, size).w, 0) > room) size--;
  if (size < 36) return null;
  const k = size / 60, base = 50 + Math.round(size * 0.86);
  return {
    h: base + 46,
    draw: (y) => {
      put(ctx, `${latin} · ${label}`, W / 2, y + 22, { font: F.cap, size: 20, color: GOLD, align: "center", spacing: "6px" });
      const inks = items.map((item) => ink(item.text, size));
      let x = W / 2 - (inks.reduce((a, b) => a + b.w, 0) + gap * (items.length - 1)) / 2;
      items.forEach((item, i) => {
        const { l, w } = inks[i] ?? { l: 0, w: 0 }, mid = x + w / 2;
        put(ctx, item.text, x + l, y + base, { font: F.s9, size, color: GOLD_HI, spacing, glow: "rgba(227,200,166,.18)" });
        put(ctx, item.count, mid, y + base + 38, { font: F.s5, size: 20, color: GOLD, align: "center" });
        x += w;
        if (i < items.length - 1) star(ctx, x + gap / 2, y + base - Math.round(size * 0.36), Math.max(10, Math.round(12 * k)), GOLD);
        x += gap;
      });
    },
  };
}
function firstSection(ctx: Ctx, L: SparkCardLines, line: NonNullable<SparkCardLines["firstLine"]>, w: number, maxH: number) {
  const inner = w - 26, text = `「${line.text}`;
  const layouts = [36, 34, 32, 30, 28, 26].map((size) => {
    ctx.font = F.s5(size);
    const rows = balanced(ctx, text, inner, 3, "」"), lh = Math.round(size * 1.5);
    const firstBase = 44 + size, byBase = firstBase + (rows.length - 1) * lh + 40;
    return { size, rows, lh, firstBase, byBase, h: byBase + 8, cut: isCut(rows, `${text}」`) };
  });
  // 放得下的字号里挑最大的（不超过旁边那栏的高度）；哪个字号都放不下就用最小的，多露几个字
  const whole = layouts.filter((layout) => !layout.cut);
  const pick = whole.find((layout) => layout.h <= maxH) ?? whole[whole.length - 1] ?? layouts[layouts.length - 1];
  if (!pick) return null;
  const { size, rows, lh, firstBase, byBase } = pick;
  return {
    h: pick.h,
    draw: (x: number, y: number) => {
      caption(ctx, "PRIMA VOX", L.labels.firstLine, x, y + 22, w);
      hair(ctx, x, y + 42, 2, byBase - 42 - 22, GOLD_LO);
      // 开头的「挂到行外半个字：字形本身右靠，不挂的话第一行看着像缩进了
      rows.forEach((row, i) => put(ctx, row, x + 26 - (row.startsWith("「") ? Math.round(size * 0.42) : 0), y + firstBase + i * lh, { font: F.s5, size, color: PAPER }));
      put(ctx, `— ${spaced(line.by)}`, x + 26, y + byBase, { font: F.s5, size: 19, min: 18, width: inner, color: TEAL });
    },
  };
}
function bottomBlock(ctx: Ctx, L: SparkCardLines, level: number): Part | null {
  const emo = L.emoji.map((item) => ({ text: item.code, count: `×${n(item.count)}` }));
  const wds = L.words.map((item) => ({ text: item.word, count: n(item.count) }));
  const fl = L.firstLine;
  const side = (w: number) => {
    const parts = [
      emo.length ? chipSection(ctx, "SIGNA", L.labels.emoji, emo, w, level) : null,
      wds.length ? chipSection(ctx, "VERBA", L.labels.words, wds, w, level) : null,
    ].filter((part): part is NonNullable<typeof part> => part !== null);
    return { parts, h: parts.reduce((sum, part) => sum + part.h, 0) + partGap(level) * Math.max(0, parts.length - 1) };
  };
  if (fl && (emo.length || wds.length)) {
    const lw = 396, rx = M + lw + 52, rw = CW - lw - 52;
    const left = side(lw), right = firstSection(ctx, L, fl, rw, Math.max(150, left.h));
    if (!right) return null;
    const h = Math.max(left.h, right.h);
    return {
      h,
      draw: (y) => {
        let yy = y;
        for (const part of left.parts) { part.draw(M, yy); yy += part.h + partGap(level); }
        hair(ctx, M + lw + 26, y + 8, 1, h - 12);
        right.draw(rx, y);
      },
    };
  }
  if (fl) {
    const one = firstSection(ctx, L, fl, CW, 170);
    return one ? { h: one.h, draw: (y) => one.draw(M, y) } : null;
  }
  if (emo.length && wds.length) {
    const w = (CW - 52) / 2, a = chipSection(ctx, "SIGNA", L.labels.emoji, emo, w, level), b = chipSection(ctx, "VERBA", L.labels.words, wds, w, level);
    const h = Math.max(a.h, b.h);
    return { h, draw: (y) => { a.draw(M, y); hair(ctx, M + w + 26, y + 8, 1, h - 12); b.draw(M + w + 52, y); } };
  }
  const solo = emo.length ? signatureSection(ctx, "SIGNA", L.labels.emoji, emo) : wds.length ? signatureSection(ctx, "VERBA", L.labels.words, wds) : null;
  if (solo) return solo;
  const only = side(CW);
  const part = only.parts[0];
  return part ? { h: part.h, draw: (y) => part.draw(M, y) } : null;
}

export const archive: SparkCardTheme = {
  fontCss: "family=Cormorant+Garamond:ital,wght@0,600;1,500&family=Noto+Serif+SC:wght@200;500;700;900",
  fonts: [F.s9(40), F.s7(40), F.s5(40), F.num(40), F.cap(20), F.it(20)],
  draw(ctx, L) {
    ctx.textBaseline = "alphabetic";
    backdrop(ctx);

    put(ctx, L.title, M, 118, { font: F.s7, size: 32, color: PAPER, spacing: "6px" });
    put(ctx, titleCase(L.stamp), W - M, 116, { font: F.it, size: 32, color: GOLD, align: "right" });
    hair(ctx, M, 140, CW);

    ctx.font = F.s5(18);
    const foot = breakLines(ctx, L.footer, CW, 2);
    const footRule = H - 124 - (foot.length - 1) * 24;
    hair(ctx, M, footRule, CW);
    foot.forEach((line, i) => put(ctx, line, M, footRule + 30 + i * 24, { font: F.s5, size: 18, color: SOFT }));
    put(ctx, L.brand.toUpperCase(), W - M, H - 66, { font: F.cap, size: 18, color: MUTE, align: "right", spacing: "4px" });

    // 先量：主角、数据格、其余各块
    const { rows, vs } = statRows(ctx, L.stats, L.hours ? [L.hoursNote] : []);
    // 名字太长缩了字号时，这一行占的高度跟着变矮
    const whoSize = fitSize(ctx, L.who, F.s9, 54, 30, CW), WHO_H = 58 - Math.round((54 - whoSize) * 0.86), top = 140;
    const statsH = (g: number) => rows.reduce((sum, row) => sum + ROW_H + (row.wrap ? WRAP_H : 0) + g, 0);
    const cache = new Map<number, Hero>();
    const hm = (S: number) => {
      let m = cache.get(S);
      if (!m) cache.set(S, (m = heroMetrics(ctx, L, S)));
      return m;
    };
    // 一种版面密度下的分配：间距先保到 20，不够就缩主角数字（最小 120）、再缩间距；够了先把间距撑到 28，
    // 再让主角变大（数字被宽度卡住长不动时，多出来的高度不占）、数据格变高，剩下的都匀给间距。
    // 只剩主角和数据格时（没有图表、日历这些块），主角和数据格多吃一些，卡底不空
    const plan = (level: number) => {
      const extras = [chartsBlock(ctx, L, level), calendarBlock(ctx, L, level), bottomBlock(ctx, L, level)].filter((part): part is Part => part !== null);
      const weights = [0.8, 0.45, 1, ...extras.map(() => 1), 0.9];
      const wsum = weights.reduce((sum, value) => sum + value, 0);
      const room = footRule - top - WHO_H - statsH(0) - extras.reduce((sum, part) => sum + part.h, 0);
      const bare = extras.length === 0;
      let gap = 20, g = 0, m = hm(168), free = room - m.h - gap * wsum;
      if (free < 0) {
        // 不够：主角先缩到 150，再把间距压到 16，还不够主角再缩到 120，最后才把间距压到底
        for (let S = 167; S >= 150 && free < 0; S--) { m = hm(S); free = room - m.h - gap * wsum; }
        if (free < 0) { gap = Math.max(16, gap + free / wsum); free = room - m.h - gap * wsum; }
        for (let S = m.S - 1; S >= (level >= 2 ? 112 : 120) && free < 0; S--) { m = hm(S); free = room - m.h - gap * wsum; }
      } else {
        const widen = Math.min(free, 8 * wsum);
        gap += widen / wsum;
        free -= widen;
        const start = m, budget = free * (bare ? 0.6 : 0.45);
        for (let S = 169; S <= (bare ? 300 : 278); S++) {
          const c = hm(S);
          if (c.h - start.h <= budget && (c.size > m.size || (c.size === m.size && c.h < m.h))) m = c;
        }
        free -= m.h - start.h;
        g = Math.round(Math.min(bare ? 40 : 22, (free * (bare ? 0.5 : 0.25)) / Math.max(1, rows.length)));
        free -= g * rows.length;
      }
      return { extras, weights, hero: m, g, gap: Math.max(10, gap + free / wsum) };
    };
    // 先按宽松版面排；主角得缩才放得下就换一般版面；主角要缩到 150 以下、或者间距得压到 20 以下，再换紧凑版面（词和表情最多两行、行距和格子小一号）
    let p = plan(0);
    if (p.hero.S < 168) {
      p = plan(1);
      if (p.hero.S < 150 || p.gap < 20) p = plan(2);
    }
    const { extras, weights, hero: hx, g, gap } = p;

    let y = top + gap * (weights[0] ?? 1);
    put(ctx, L.who, M, y + WHO_H - 8, { font: F.s9, size: whoSize, min: 30, width: CW, color: PAPER });
    y += WHO_H + gap * (weights[1] ?? 1);
    if (L.hero.lit) {
      // 亮着的火花在主角后面铺一层暖光
      const cx = W - M - Math.round(hx.r * 1.75), cy = y + hx.cy, R = hx.S * 2.2;
      const warm = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      warm.addColorStop(0, "rgba(197,152,97,.12)");
      warm.addColorStop(1, "rgba(197,152,97,0)");
      ctx.fillStyle = warm;
      ctx.fillRect(0, cy - R, W, R * 2);
    }
    hero(ctx, L, y, hx);
    y += hx.h;

    const rule = (yy: number) => hair(ctx, M, Math.round(yy), CW);
    rule(y + gap / 2);
    y += gap;
    rows.forEach((row, i) => {
      const h = ROW_H + (row.wrap ? WRAP_H : 0) + g;
      if (i) hair(ctx, M, Math.round(y), CW, 1, "#2C2620");
      drawRow(ctx, row, y, h, g, vs);
      y += h;
    });
    for (const part of extras) {
      rule(y + gap / 2);
      y += gap;
      part.draw(y);
      y += part.h;
    }
    // 块很少、卡底还空着一大段时（群里没读到消息又没有总数），在中间放一枚卷末花饰
    if (footRule - y > 120) {
      const cx = W / 2, cy = Math.round((y + footRule) / 2);
      hair(ctx, cx - 150, cy, 118, 1, LINE2);
      hair(ctx, cx + 32, cy, 118, 1, LINE2);
      dot(ctx, cx - 160, cy + 0.5, 2, GOLD_LO);
      dot(ctx, cx + 160, cy + 0.5, 2, GOLD_LO);
      star(ctx, cx, cy, 14, GOLD);
      star(ctx, cx - 24, cy, 5, GOLD_LO);
      star(ctx, cx + 24, cy, 5, GOLD_LO);
    }
    stardust(ctx);
  },
};
