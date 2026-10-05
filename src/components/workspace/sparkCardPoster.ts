import { eachDay, f, fill, H, n, put, W, type FontSpec, type SparkCardLines, type SparkCardStat, type SparkCardTheme } from "./sparkCard";

/*
 * 火花纪念卡 · 海报：和年度分享图海报版同一套——新闻纸、墨黑、信号橙，3px 粗黑线分栏，Anton 数字、思源黑 900 标题、JetBrains Mono 小戳。
 * 火花亮着：主角整条换成信号橙色块、实心墨黑大数字、实心火苗；没亮：留在纸上，空心描边数字、空心火苗。
 * 版面按内容伸缩：缺的块直接不画；放不下按顺序压，有富余先给主角（数字窄时不给太多，免得旁边空一大片），再给数据格和各块。
 */

type Ctx = CanvasRenderingContext2D;
const INK = "#0A0A0A";
const PAPER = "#F1EEE6";
const SIG = "#FF4A1C";
const MUTE = "rgba(10,10,10,.64)";
const CJK = '"Noto Sans SC","PingFang SC",sans-serif';
const F = {
  cjk9: f(`900 # ${CJK}`),
  cjk7: f(`700 # ${CJK}`),
  cjk5: f(`500 # ${CJK}`),
  num: f(`400 # Anton,${CJK}`),
  mono: f(`700 # "JetBrains Mono","PingFang SC",monospace`),
};
const M = 64;
const CW = W - 2 * M;
const RULE = 3;
/** 报头底边、名字下面那条线 */
const BAND = 92;
const WHO_RULE = 196;

const track = (ctx: Ctx, value: string) => { (ctx as Ctx & { letterSpacing?: string }).letterSpacing = value; };
function measure(ctx: Ctx, text: string, font: FontSpec, size: number, spacing = "0px"): number {
  track(ctx, spacing);
  ctx.font = font(size);
  return ctx.measureText(text).width;
}
/** 和 put 一样按宽度缩字号，只算不画，返回缩到的字号。 */
function fitSize(ctx: Ctx, text: string, font: FontSpec, size: number, min: number, width: number): number {
  track(ctx, "0px");
  ctx.font = font(size);
  const raw = ctx.measureText(text).width;
  if (raw > width) size = Math.max(min, Math.floor((size * width) / raw));
  ctx.font = font(size);
  while (size > min && ctx.measureText(text).width > width) ctx.font = font(--size);
  return size;
}

const OPENERS = /^[「『（《“‘(]/u;
/** 行首是左引号时，这个字形左半边是空的：返回这段留白，往左挪掉它，墨迹就和上下行对齐。 */
function hang(ctx: Ctx, row: string, font: FontSpec, size: number): number {
  if (!OPENERS.test(row)) return 0;
  track(ctx, "0px");
  ctx.font = font(size);
  ctx.textAlign = "left";
  return Math.max(0, -ctx.measureText(Array.from(row)[0] ?? "").actualBoundingBoxLeft);
}

const CLOSERS = /^[，。、！？；：」』）》,.!?;:)]$/u;
const SOFT = /[，、；：。！？]/u;
/**
 * 折行（中文逐字、英文按词）：行首不放句读；短的「引号」整段不拆；叠字（哈哈哈、嗯嗯）整组不拆；
 * 要断时优先断在逗号后面；超过 maxLines 行在最后一行末尾加 …。只算不画。
 */
function breakLines(ctx: Ctx, text: string, font: FontSpec, size: number, width: number, maxLines: number): string[] {
  track(ctx, "0px");
  ctx.font = font(size);
  const tokens = (text.match(/「[^「」]{1,10}」|[A-Za-z0-9@#'’.\-_,%/:]+|\s+|(\p{Script=Han})\1+|./gu) ?? [])
    .flatMap((token) => (ctx.measureText(token).width > width * 0.9 ? Array.from(token) : [token]));
  const rows: string[] = [];
  let row = "";
  let cut = false;
  for (const token of tokens) {
    const next = row + token;
    if (!row || ctx.measureText(next).width <= width) { row = next; continue; }
    if (rows.length === maxLines - 1) { cut = true; break; }
    const chars = Array.from(row);
    if (CLOSERS.test(token)) {
      // 句读不放行首：把上一行最后一个字一起带下来
      const carry = chars.pop() ?? "";
      rows.push(chars.join("").trimEnd());
      row = carry + token;
      continue;
    }
    let at = -1;
    for (let k = chars.length - 2; k >= Math.ceil(chars.length * 0.4); k -= 1) if (SOFT.test(chars[k] ?? "")) { at = k; break; }
    if (at >= 0) {
      rows.push(chars.slice(0, at + 1).join("").trimEnd());
      row = chars.slice(at + 1).join("").trimStart() + token;
    } else {
      rows.push(row.trimEnd());
      row = token.trimStart();
    }
  }
  if (row.trim()) rows.push(row.trim());
  if (cut) {
    let last = Array.from(rows[rows.length - 1] ?? "");
    while (last.length > 1 && ctx.measureText(`${last.join("")}…`).width > width) last = last.slice(0, -1);
    rows[rows.length - 1] = `${last.join("")}…`;
  }
  return rows;
}

/**
 * 折成多行时最后一行太短（不到最宽一行的 share）就收窄重排，让几行长短接近，不留一两个字的尾巴。
 * share 为 0 时只管单独掉下来一个字的情况。
 */
function balancedLines(ctx: Ctx, text: string, font: FontSpec, size: number, width: number, maxLines: number, share = 0.4): string[] {
  const rows = breakLines(ctx, text, font, size, width, maxLines);
  const lastRow = rows[rows.length - 1] ?? "";
  if (rows.length < 2 || lastRow.endsWith("…")) return rows;
  const widths = rows.map((row) => ctx.measureText(row).width);
  const orphan = Array.from(lastRow.replace(/[」』）》，。、！？；：,.!?;:)\s]/gu, "")).length <= 1;
  if (!orphan && (widths[widths.length - 1] ?? 0) >= Math.max(...widths) * share) return rows;
  let lo = width * 0.4;
  let hi = width;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    const test = breakLines(ctx, text, font, size, mid, maxLines);
    if (test.length === rows.length && !(test[test.length - 1] ?? "").endsWith("…")) hi = mid;
    else lo = mid;
  }
  return breakLines(ctx, text, font, size, hi, maxLines);
}

/** 墨黑底小标签（同工作台的 stamp），返回宽度。y 是标签顶边。 */
function tag(ctx: Ctx, text: string, x: number, y: number, maxWidth = CW): number {
  const size = 20;
  const w = Math.min(maxWidth, measure(ctx, text, F.cjk9, size, "1px") + 24);
  fill(ctx, x, y, w, 36, INK);
  put(ctx, text, x + 12, y + 26, { font: F.cjk9, size, min: 18, width: w - 24, color: PAPER, spacing: "1px" });
  return w;
}

/** 一团硬边火苗：外焰 + 内芯。lit 时实心，没亮时只描边。 */
function flame(ctx: Ctx, x: number, y: number, w: number, h: number, lit: boolean) {
  // 只描边时线有一半在路径外面，往里收一点，外沿才和右边线对齐
  if (!lit) { x += 2; y += 2; w -= 4; h -= 4; }
  const p = (u: number, v: number): [number, number] => [x + u * w, y + v * h];
  const curve = (a: [number, number], b: [number, number], c: [number, number]) => ctx.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
  const outer = () => {
    ctx.beginPath();
    ctx.moveTo(...p(0.56, 0));
    curve(p(0.62, 0.22), p(1, 0.34), p(1, 0.66));
    curve(p(1, 0.88), p(0.78, 1), p(0.5, 1));
    curve(p(0.22, 1), p(0, 0.88), p(0, 0.64));
    curve(p(0, 0.46), p(0.1, 0.34), p(0.22, 0.2));
    curve(p(0.24, 0.32), p(0.3, 0.4), p(0.38, 0.44));
    curve(p(0.34, 0.28), p(0.42, 0.12), p(0.56, 0));
    ctx.closePath();
  };
  const inner = () => {
    ctx.beginPath();
    ctx.moveTo(...p(0.52, 0.46));
    curve(p(0.58, 0.6), p(0.76, 0.68), p(0.76, 0.82));
    curve(p(0.76, 0.93), p(0.64, 1), p(0.5, 1));
    curve(p(0.36, 1), p(0.24, 0.93), p(0.24, 0.82));
    curve(p(0.24, 0.68), p(0.44, 0.62), p(0.52, 0.46));
    ctx.closePath();
  };
  if (lit) {
    outer();
    ctx.fillStyle = INK;
    ctx.fill();
    inner();
    ctx.fillStyle = PAPER;
    ctx.fill();
  } else {
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    outer();
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = MUTE;
    inner();
    ctx.stroke();
  }
}

/**
 * 计数的划记（四竖一斜）：主角不是火花（聊过多少天、一共多少条）时代替火苗，免得读成「火花灭了」。
 * 竖条实心墨黑，斜杠先描一圈底色再画，像压在竖条上面印的；斜杠两头往里收，粗线的角不出框。
 */
function tally(ctx: Ctx, x: number, y: number, w: number, h: number, bg: string) {
  const bw = Math.max(8, Math.round(w * 0.085));
  // 最后一根竖条贴住右边线，和亮着时的火苗右沿对齐
  const step = (w * 0.84 - bw) / 3;
  for (let i = 0; i < 4; i += 1) fill(ctx, Math.round(x + w * 0.16 + i * step), y, bw, h, INK);
  ctx.lineCap = "butt";
  const inset = bw * 0.8 + 6;
  const slash = () => { ctx.beginPath(); ctx.moveTo(x + inset, y + h * 0.78); ctx.lineTo(x + w - inset, y + h * 0.22); ctx.stroke(); };
  ctx.strokeStyle = bg;
  ctx.lineWidth = bw + 12;
  slash();
  ctx.strokeStyle = INK;
  ctx.lineWidth = bw;
  slash();
}

// ---------- 谁 ----------
/** 名字按缩完的实际字号，在报头和横线之间上下居中。 */
function drawWho(ctx: Ctx, who: string) {
  const size = fitSize(ctx, who, F.cjk9, 70, 36, CW);
  ctx.font = F.cjk9(size);
  const m = ctx.measureText(who);
  const base = Math.round(BAND + (WHO_RULE - BAND - m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 + m.actualBoundingBoxAscent);
  put(ctx, who, M, base, { font: F.cjk9, size, min: 36, width: CW, color: INK });
  fill(ctx, M, WHO_RULE, CW, RULE, INK);
}

// ---------- 主角 ----------
/** Anton 数字上沿高度占字号的比例，量一次。 */
function digitRatio(ctx: Ctx): number {
  track(ctx, "0px");
  ctx.font = F.num(100);
  return ctx.measureText("0123456789").actualBoundingBoxAscent / 100 || 0.74;
}
/** 一两位的数字很窄：主角不给太高，说明放在数字旁边那一栏。 */
const narrowHero = (L: SparkCardLines) => Array.from(L.hero.value).length <= 2;
const HERO_NOTE = 26;
function heroLayout(ctx: Ctx, L: SparkCardLines, top: number, h: number) {
  // 高的时候说明单独一行压在横线下；矮的（或数字窄）时挪到数字右边，把高度全留给数字
  const roomy = h >= 380 && !narrowHero(L);
  const labelBase = top + 62;
  const noteBase = top + h - 34;
  const numBase = roomy ? noteBase - 60 : top + h - 36;
  const digitRoom = numBase - (labelBase + 28);
  const flameH = Math.min(digitRoom + 8, roomy ? h * 0.6 : Math.max(250, h * 0.6));
  const flameW = flameH * 0.74;
  const unitSize = Math.min(84, Math.max(60, Math.round(digitRoom * 0.34)));
  const unitW = measure(ctx, L.hero.unit, F.cjk9, unitSize) + 16;
  const ratio = digitRatio(ctx);
  const full = Math.floor(digitRoom / ratio);
  ctx.font = F.num(full);
  const raw = ctx.measureText(L.hero.value).width;
  const fitTo = (room: number) => (raw > room ? Math.floor((full * room) / raw) : full);
  let size = fitTo(CW - flameW - 40 - unitW);
  if (!roomy) {
    // 说明尽量一行放在数字右边：数字缩得不多（不小于八成）就为它让位，否则说明折行
    const noteW = Math.min(measure(ctx, L.hero.note, F.cjk7, HERO_NOTE), 460) + 28;
    const oneLine = fitTo(CW - flameW - 40 - unitW - noteW);
    size = oneLine >= size * 0.8 ? oneLine : Math.min(size, fitTo(CW - flameW - 40 - unitW - 240));
  }
  ctx.font = F.num(size);
  const nw = ctx.measureText(L.hero.value).width;
  return { roomy, labelBase, noteBase, numBase, flameH, flameW, unitSize, unitW, size, nw, wasted: digitRoom - size * ratio };
}
/** 主角最多给多高：数字窄的封顶，宽的给到数字被宽度卡住、再高只会在上面空出来为止。 */
function heroMax(ctx: Ctx, L: SparkCardLines): number {
  if (narrowHero(L)) return 460;
  let best = 300;
  for (let h = 300; h <= 620; h += 10) if (heroLayout(ctx, L, 0, h).wasted <= 36) best = h;
  return best;
}
/** 主角是不是火花天数（亮着或已经断了）；不是的话是聊过的天数或总条数。 */
const sparkHero = (L: SparkCardLines) => L.hero.label.startsWith("火花");
function drawHero(ctx: Ctx, L: SparkCardLines, top: number, h: number) {
  const { lit } = L.hero;
  if (lit) fill(ctx, 0, top, W, h, SIG);
  const lay = heroLayout(ctx, L, top, h);
  put(ctx, L.hero.label, M, lay.labelBase, { font: F.cjk9, size: 34, min: 24, width: CW * 0.62, color: INK });
  const stamp = lit ? "● LIT" : sparkHero(L) ? "○ OUT" : `${L.hero.unit === "天" ? "DAYS" : "MESSAGES"} COUNTED`;
  put(ctx, stamp, W - M, lay.labelBase - 6, { font: F.mono, size: 20, color: INK, align: "right", spacing: "3px" });

  const value = L.hero.value;
  ctx.font = F.num(lay.size);
  track(ctx, "0px");
  ctx.textAlign = "left";
  // 亮着的火花和不是火花的计数都用实心数字；只有断了的火花用空心描边
  if (lit || !sparkHero(L)) {
    ctx.fillStyle = INK;
    ctx.fillText(value, M - 4, lay.numBase);
  } else {
    // 空心描边跟着字号加粗，几百像素的大字不至于像没上色的线稿
    ctx.lineJoin = "miter";
    ctx.lineWidth = Math.max(4, lay.size * 0.012);
    ctx.strokeStyle = INK;
    ctx.strokeText(value, M - 2, lay.numBase);
  }
  put(ctx, L.hero.unit, M + lay.nw + 14, lay.numBase, { font: F.cjk9, size: lay.unitSize, color: INK });
  const flameX = W - M - lay.flameW;
  if (sparkHero(L)) flame(ctx, flameX, lay.numBase - lay.flameH + 4, lay.flameW, lay.flameH, lit);
  else tally(ctx, flameX, lay.numBase - lay.flameH * 0.86, lay.flameW, lay.flameH * 0.86, lit ? SIG : PAPER);

  const noteColor = lit ? INK : MUTE;
  if (lay.roomy) {
    fill(ctx, M, lay.noteBase - 42, CW, lit ? RULE : 2, lit ? INK : MUTE);
    put(ctx, L.hero.note, M, lay.noteBase + 2, { font: F.cjk7, size: HERO_NOTE, min: 18, width: CW, color: noteColor });
  } else {
    // 数字和火苗之间的一栏，底边对齐数字基线
    const nx = M + lay.nw + 14 + lay.unitW + 28;
    const rows = balancedLines(ctx, L.hero.note, F.cjk7, HERO_NOTE, flameX - 28 - nx, 3);
    rows.forEach((row, i) => put(ctx, row, nx - hang(ctx, row, F.cjk7, HERO_NOTE), lay.numBase - 4 - (rows.length - 1 - i) * 36, { font: F.cjk7, size: HERO_NOTE, color: noteColor }));
  }
  if (!lit) fill(ctx, M, top + h, CW, RULE, INK);
}

// ---------- 数据格 ----------
function statRows(L: SparkCardLines): SparkCardStat[][] {
  return (L.group ? [L.stats.slice(0, 3), L.stats.slice(3)] : [L.stats.slice(0, 3), L.stats.slice(3, 6)]).filter((row) => row.length);
}
type StatCell = { st: SparkCardStat; x: number; w: number; pad: number; inner: number };
/**
 * 一行的格子都落在三栏网格上：三格各占一栏；两格时说明长的那格占两栏，竖线和上一行对齐。
 */
function rowCells(ctx: Ctx, row: SparkCardStat[]): StatCell[] {
  const col = CW / 3;
  let spans: number[];
  if (row.length === 2) {
    const a = row[0]?.s ? measure(ctx, row[0].s, F.cjk5, 19) : 0;
    const b = row[1]?.s ? measure(ctx, row[1].s, F.cjk5, 19) : 0;
    spans = b > a ? [1, 2] : [2, 1];
  } else if (row.length === 1) spans = [3];
  else spans = row.map(() => 3 / row.length);
  let x = M;
  return row.map((st, i) => {
    const w = (spans[i] ?? 1) * col;
    const pad = i ? 24 : 0;
    const cell = { st, x, w, pad, inner: w - pad - 20 };
    x += w;
    return cell;
  });
}
/** 说明先试 19px、18px 一行放下，放不下再折两行。 */
function statNote(ctx: Ctx, text: string, width: number): { size: number; lines: string[] } {
  for (const size of [19, 18]) if (measure(ctx, text, F.cjk5, size) <= width) return { size, lines: [text] };
  return { size: 18, lines: balancedLines(ctx, text, F.cjk5, 18, width, 2) };
}
/** 这一行说明最多要几行（1 或 2）。 */
function statLinesNeeded(ctx: Ctx, row: SparkCardStat[]): number {
  return Math.max(1, ...rowCells(ctx, row).map((c) => (c.st.s ? statNote(ctx, c.st.s, c.inner).lines.length : 1)));
}
const STAT_H = [132, 156];
const STAT_GROW = 96;
/** 一行里有值的格子占几成：多半是「—」的行不值得撑高（至少按两成算）。 */
const statWeight = (row: SparkCardStat[]) => Math.max(0.2, row.filter((st) => st.v !== "—").length / Math.max(1, row.length));
function drawStats(ctx: Ctx, L: SparkCardLines, top: number, heights: number[]) {
  let y = top;
  statRows(L).forEach((row, r) => {
    const rh = heights[r] ?? STAT_H[0]!;
    const lines = statLinesNeeded(ctx, row);
    // 多出来的高度一部分给大字（最大到年度分享图的 62px），其余上下均分；被压矮时上下各让一半
    const grow = rh - (STAT_H[lines - 1] ?? STAT_H[0]!);
    const vSize = Math.min(62, 42 + Math.max(0, Math.floor(grow / 4)));
    const kSize = Math.min(26, 22 + Math.max(0, Math.floor(grow / 24)));
    // 大字长高后千分位逗号往下伸得更多，说明跟着往下挪
    const noteGap = 34 + Math.round((vSize - 42) * 0.4);
    const kBase = y + 36 + (kSize - 22) + (grow - (vSize - 42) - (kSize - 22) - (noteGap - 32)) / 2;
    rowCells(ctx, row).forEach(({ st, x, pad, inner }, i) => {
      if (i) fill(ctx, x, y, RULE, rh, INK);
      put(ctx, st.k, x + pad, kBase, { font: F.cjk7, size: kSize, min: 18, width: inner, color: INK });
      const vBase = kBase + vSize + 8;
      put(ctx, st.v, x + pad, vBase, { font: F.cjk9, size: vSize, min: 26, width: inner, color: st.v === "—" ? MUTE : INK });
      if (st.s) {
        const note = statNote(ctx, st.s, inner);
        note.lines.forEach((line, li) => put(ctx, line, x + pad - hang(ctx, line, F.cjk5, note.size), vBase + noteGap + li * 24, { font: F.cjk5, size: note.size, color: MUTE }));
      }
    });
    y += rh;
    fill(ctx, M, y, CW, RULE, INK);
    y += RULE;
  });
}

// ---------- 谁说得多 ----------
type BalanceMode = "inline" | "stacked" | "large";
const BALANCE_H: Record<BalanceMode, number> = { inline: 64, stacked: 136, large: 220 };
/** 一边不到 1% 时两边都留一位小数，免得写成「0.1% : 100%」 */
function shares(b: NonNullable<SparkCardLines["balance"]>) {
  const total = Math.max(1, b.mine + b.theirs);
  const fine = b.mine && b.theirs && Math.min(b.mine, b.theirs) / total < 0.01;
  const pct = (v: number) => `${fine ? ((v / total) * 100).toFixed(1) : Math.round((v / total) * 100)}%`;
  return { mine: pct(b.mine), theirs: pct(b.theirs) };
}
/**
 * inline：标签和条一行；stacked：标签在上、条加粗；large（只给好友卡）：再加一对大号百分比。
 * 条数只写在条里，不再放大重复一遍。大号百分比不超过 pctMax（按主角字号算），免得比主角还抢眼。
 */
function drawBalance(ctx: Ctx, b: NonNullable<SparkCardLines["balance"]>, label: string, top: number, h: number, mode: BalanceMode, group: boolean, pctMax = 96) {
  const total = Math.max(1, b.mine + b.theirs);
  const mineText = `${b.mineLabel} ${n(b.mine)}`;
  const theirsText = `${n(b.theirs)} ${b.theirsLabel}`;
  const pct = shares(b);
  let barX = M;
  let barY: number;
  let barH: number;
  if (mode === "inline") {
    const tw = tag(ctx, label, M, top + (h - 36) / 2);
    barX = M + tw + 20;
    barH = 40;
    barY = top + (h - barH) / 2;
  } else if (mode === "stacked") {
    barH = Math.round(Math.min(72, 48 + (h - BALANCE_H.stacked) / 2));
    const blockH = 36 + 18 + barH;
    const y0 = top + (h - blockH) / 2;
    tag(ctx, label, M, y0);
    // 群卡的数据格里已经有「我说的话占多少」，这里不再写一遍比例
    if (!group) put(ctx, `${pct.mine} : ${pct.theirs}`, W - M, y0 + 26, { font: F.mono, size: 20, color: INK, align: "right", spacing: "2px" });
    barY = y0 + 36 + 18;
  } else {
    barH = 48;
    const numSize = Math.min(pctMax, Math.max(64, Math.min(132, Math.round((h - 36 - 48 - 104) / digitRatio(ctx)))));
    const capH = numSize * digitRatio(ctx);
    const blockH = 36 + 22 + capH + 22 + barH;
    const y0 = top + (h - blockH) / 2;
    tag(ctx, label, M, y0);
    const numBase = Math.round(y0 + 36 + 22 + capH);
    put(ctx, pct.mine, M - 2, numBase, { font: F.num, size: numSize, color: INK });
    put(ctx, pct.theirs, W - M + 2, numBase, { font: F.num, size: numSize, color: SIG, align: "right" });
    barY = numBase + 22;
  }
  const barW = W - M - barX;
  // 比例按实数画；只有一方不是 0 却窄得看不见时，给它留 4px
  let mineW = Math.round((b.mine / total) * barW);
  if (b.mine && mineW < 4) mineW = 4;
  if (b.theirs && barW - mineW < 4) mineW = barW - 4;
  fill(ctx, barX, barY, barW, barH, SIG);
  fill(ctx, barX, barY, mineW, barH, INK);
  const size = barH >= 56 ? 26 : 22;
  const base = barY + barH / 2 + size * 0.36;
  const mw = measure(ctx, mineText, F.cjk9, size);
  const thw = measure(ctx, theirsText, F.cjk9, size);
  // 段够宽就写在段里，太窄就写到对面的段上
  if (mineW >= mw + 28) put(ctx, mineText, barX + 14, base, { font: F.cjk9, size, color: PAPER });
  else put(ctx, mineText, barX + mineW + 12, base, { font: F.cjk9, size, color: INK });
  if (barW - mineW >= thw + 28) put(ctx, theirsText, W - M - 14, base, { font: F.cjk9, size, color: INK, align: "right" });
  else put(ctx, theirsText, barX + mineW - 12, base, { font: F.cjk9, size, color: PAPER, align: "right" });
}

// ---------- 24 小时 ----------
const peakText = (L: SparkCardLines) => `PEAK ${String(L.peakHour ?? 0).padStart(2, "0")}:00`;
/**
 * 柱区顶边离块顶多远：标签下方空 34px（峰值柱顶上要写数字），有说明再让一行；
 * 峰值数字（Anton 26px，上沿约在柱顶上方 26px）落在标签、PEAK 或说明正下方时，和它至少隔 20px。
 */
function barsOffset(ctx: Ctx, L: SparkCardLines, w: number): number {
  let off = 36 + 34 + (L.hoursNote ? 34 : 0);
  if (L.peakHour === null || !L.hours) return off;
  const above = [{ l: 0, r: Math.min(CW, measure(ctx, L.labels.hours, F.cjk9, 20, "1px") + 24), bottom: 36 }];
  above.push({ l: w - measure(ctx, peakText(L), F.mono, 20, "2px"), r: w, bottom: 28 });
  if (L.hoursNote) above.push({ l: 0, r: Math.min(w, measure(ctx, L.hoursNote, F.cjk5, 20)), bottom: 36 + 35 });
  const pitch = w / 24;
  const cx = L.peakHour * pitch + pitch / 2;
  const half = measure(ctx, n(L.hours[L.peakHour] ?? 0), F.num, 26) / 2 + 4;
  for (const o of above) if (cx + half > o.l && cx - half < o.r) off = Math.max(off, o.bottom + 20 + 26);
  return off;
}
const hoursNatural = (ctx: Ctx, L: SparkCardLines, bars: number, w: number) => barsOffset(ctx, L, w) + bars + 30;
function drawHours(ctx: Ctx, L: SparkCardLines, x: number, top: number, w: number, h: number) {
  const hours = L.hours;
  if (!hours) return;
  tag(ctx, L.labels.hours, x, top);
  if (L.peakHour !== null) put(ctx, peakText(L), x + w, top + 26, { font: F.mono, size: 20, color: INK, align: "right", spacing: "2px" });
  if (L.hoursNote) put(ctx, L.hoursNote, x, top + 36 + 30, { font: F.cjk5, size: 20, min: 18, width: w, color: MUTE });
  const barsTop = top + barsOffset(ctx, L, w);
  const pitch = w / 24;
  const bw = Math.max(4, pitch * 0.66);
  const base = top + h - 30;
  const bh = base - barsTop;
  const max = Math.max(1, ...hours);
  hours.forEach((v, i) => {
    const bx = x + i * pitch + (pitch - bw) / 2;
    const vh = v ? Math.max(4, (v / max) * bh) : 0;
    const peak = i === L.peakHour;
    if (vh) fill(ctx, bx, base - vh, bw, vh, peak ? SIG : INK);
    if (peak) put(ctx, n(v), bx + bw / 2, base - vh - 7, { font: F.num, size: 26, color: INK, align: "center" });
  });
  fill(ctx, x, base, w, RULE, INK);
  [0, 6, 12, 18, 23].forEach((hr) => put(ctx, String(hr).padStart(2, "0"), x + hr * pitch + pitch / 2, base + 26, { font: F.mono, size: 18, color: MUTE, align: "center" }));
}

// ---------- 第一句话 ----------
function firstLineLayout(ctx: Ctx, L: SparkCardLines, w: number, maxLines = 3) {
  if (!L.firstLine) return null;
  const lines = balancedLines(ctx, `「${L.firstLine.text}」`, F.cjk7, 28, w - 26, maxLines, 0);
  return { lines, natural: 36 + 26 + lines.length * 40 + 36 };
}
function drawFirstLine(ctx: Ctx, L: SparkCardLines, x: number, top: number, w: number, h: number, maxLines: number) {
  const fl = firstLineLayout(ctx, L, w, maxLines);
  if (!fl || !L.firstLine) return;
  tag(ctx, L.labels.firstLine, x, top);
  const textTop = top + 36 + 22;
  const blockH = fl.lines.length * 40 + 8;
  const offset = Math.max(0, (h - fl.natural) / 2);
  fill(ctx, x, textTop + offset, 8, blockH, SIG);
  fl.lines.forEach((line, i) => put(ctx, line, x + 26 - hang(ctx, line, F.cjk7, 28), textTop + offset + 32 + i * 40, { font: F.cjk7, size: 28, color: INK }));
  put(ctx, L.firstLine.by, x + 26, textTop + offset + blockH + 30, { font: F.cjk5, size: 19, min: 18, width: w - 26, color: MUTE });
}

// ---------- 表情 / 词 ----------
type Chip = { a: string; b: string };
type Placed = { chip: Chip; x: number; line: number; room: number };
const CHIP_A = 30;
const CHIP_B = 20;
const CHIP_LINE = 44;
/**
 * 一串「词 次数」从 x0 排到 xEnd，一行放不下折到下一行（最多 maxLines 行）；
 * 某个词一个人就占不下一行（极端长词）才缩字截断。只算不画。
 */
function placeChips(ctx: Ctx, chips: Chip[], x0: number, xEnd: number, maxLines: number): Placed[] {
  const out: Placed[] = [];
  let cx = x0;
  let line = 0;
  for (const chip of chips) {
    const need = measure(ctx, chip.a, F.cjk9, CHIP_A) + 8 + measure(ctx, chip.b, F.mono, CHIP_B, "1px");
    if (cx > x0 && cx + need > xEnd) {
      if (line === maxLines - 1) break;
      line += 1;
      cx = x0;
    }
    out.push({ chip, x: cx, line, room: xEnd - cx });
    cx += need + 32;
  }
  return out;
}
function drawChipList(ctx: Ctx, placed: Placed[], firstBase: number, pitch: number) {
  for (const { chip, x, line, room } of placed) {
    const base = firstBase + line * pitch;
    const bw = measure(ctx, chip.b, F.mono, CHIP_B, "1px");
    const shown = put(ctx, chip.a, x, base, { font: F.cjk9, size: CHIP_A, min: 22, width: room - bw - 8, color: INK });
    put(ctx, chip.b, x + shown + 8, base, { font: F.mono, size: CHIP_B, color: MUTE, spacing: "1px" });
  }
}
/** 标签右边接着排（整行版）。 */
function chipRow(ctx: Ctx, label: string, chips: Chip[], x: number, w: number) {
  const tw = measure(ctx, label, F.cjk9, 20, "1px") + 24;
  const placed = placeChips(ctx, chips, x + tw + 22, x + w, 2);
  const lines = 1 + Math.max(0, ...placed.map((p) => p.line));
  return { placed, lines, height: 36 + (lines - 1) * CHIP_LINE };
}
/** 标签下面一个一行（侧栏版）。 */
const LIST_PITCH = 48;
const listHeight = (count: number) => 36 + 50 + (count - 1) * LIST_PITCH;
function drawChipColumn(ctx: Ctx, label: string, chips: Chip[], x: number, top: number, w: number) {
  tag(ctx, label, x, top);
  drawChipList(ctx, chips.map((chip, i) => ({ chip, x, line: i, room: w })), top + 36 + 42, LIST_PITCH);
}

// ---------- 日历 ----------
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
type Who = "both" | "mine" | "theirs" | "one";
const WHO_COLOR: Record<Who | "none", string> = {
  both: SIG,
  mine: "rgba(10,10,10,.42)",
  theirs: "rgba(255,74,28,.55)",
  one: "rgba(10,10,10,.2)",
  none: "rgba(10,10,10,.07)",
};
type CalLayout = {
  mode: "strip" | "month" | "weeks";
  cells: Array<{ date: string; col: number; row: number }>;
  rows: number;
  /** 格子区左边；按月排时左边留一栏写月份 */
  left: number;
  pitchX: number;
  pitchY: number;
  gap: number;
  rowLabels: string[];
  ticks: Array<{ col: number; text: string }>;
  first: string;
  cut: boolean;
  gridH: number;
  ticksH: number;
};
const noon = (iso: string) => new Date(`${iso}T12:00:00`);
/**
 * 三种排法，横向都铺满整行（最后一列贴住右边线），格子尽量方：
 * 47 天以内按日期一排排大格子（写日期）；跨 7 个月以内一个月一行、31 列；再长按周排 7 行，超过 60 周只画最近 52 周。
 * scale 是格子高宽比（放不下时压到 0.85），ticks 是格子上面那行刻度。
 */
function calendarLayout(L: SparkCardLines, scale: number, ticksOn: boolean): CalLayout | null {
  const cal = L.calendar;
  if (!cal) return null;
  const all = eachDay(cal.start, cal.end);
  const first = all[0];
  const last = all[all.length - 1];
  if (!first || !last) return null;
  const gapOf = (pitch: number) => Math.max(2, Math.round(pitch * 0.16));
  if (all.length <= 47) {
    const rows = all.length <= 23 ? 1 : 2;
    const cols = Math.ceil(all.length / rows);
    const gap = gapOf(Math.min(CW / cols, 60));
    const pitchX = (CW + gap) / cols;
    const pitchY = Math.min(pitchX, 60) * scale;
    const cells = all.map((date, i) => ({ date, col: i % cols, row: Math.floor(i / cols) }));
    return { mode: "strip", cells, rows, left: M, pitchX, pitchY, gap, rowLabels: [], ticks: [], first, cut: false, gridH: rows * pitchY - gap, ticksH: 0 };
  }
  const s = noon(first);
  const e = noon(last);
  const monthIndex = (d: Date) => (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth();
  const months = monthIndex(e) + 1;
  if (months <= 7) {
    const labelW = 56;
    const gap = gapOf((CW - labelW) / 31);
    const pitchX = (CW - labelW + gap) / 31;
    const pitchY = pitchX * scale;
    const cells = all.map((date) => { const d = noon(date); return { date, col: d.getDate() - 1, row: monthIndex(d) }; });
    const rowLabels = Array.from({ length: months }, (_, r) => MONTHS[(s.getMonth() + r) % 12] ?? "");
    const ticks = ticksOn ? [1, 5, 10, 15, 20, 25, 31].map((d) => ({ col: d - 1, text: String(d) })) : [];
    return { mode: "month", cells, rows: months, left: M + labelW, pitchX, pitchY, gap, rowLabels, ticks, first, cut: false, gridH: months * pitchY - gap, ticksH: ticksOn ? 22 : 0 };
  }
  const weekday = (iso: string) => (noon(iso).getDay() + 6) % 7;
  let shown = all;
  let lead = weekday(first);
  let weeks = Math.ceil((all.length + lead) / 7);
  let cut = false;
  if (weeks > 60) {
    cut = true;
    shown = all.slice(-(51 * 7 + weekday(last) + 1));
    lead = 0;
    weeks = 52;
  }
  const gap = gapOf(CW / weeks);
  const pitchX = (CW + gap) / weeks;
  const pitchY = pitchX * scale;
  const cells = shown.map((date, i) => ({ date, col: Math.floor((i + lead) / 7), row: (i + lead) % 7 }));
  const ticks: CalLayout["ticks"] = [];
  if (ticksOn) {
    // 每个月第一天所在的那一列写月份；开头那个月只露出一两列时让给下一个整月，挨太近的跳过
    const marks = cells.filter((c, i) => !i || c.date.slice(8) === "01").map((c) => ({ col: c.col, text: MONTHS[Number(c.date.slice(5, 7)) - 1] ?? "" }));
    if (marks.length > 1 && ((marks[1]?.col ?? 0) - (marks[0]?.col ?? 0)) * pitchX < 52) marks.shift();
    let lastX = -Infinity;
    for (const mark of marks) {
      if (mark.col * pitchX - lastX < 52) continue;
      ticks.push(mark);
      lastX = mark.col * pitchX;
    }
  }
  const firstShown = shown[0] ?? first;
  return { mode: "weeks", cells, rows: 7, left: M, pitchX, pitchY, gap, rowLabels: [], ticks, first: firstShown, cut, gridH: 7 * pitchY - gap, ticksH: ticks.length ? 22 : 0 };
}
const CAL_HEAD = 36 + 16;
const calendarNatural = (lay: CalLayout | null) => (lay ? CAL_HEAD + lay.ticksH + lay.gridH : 0);
const dotted = (iso: string) => iso.replace(/-/gu, ".");
function drawCalendar(ctx: Ctx, L: SparkCardLines, top: number, h: number, lay: CalLayout) {
  const cal = L.calendar;
  if (!cal) return;
  const tw = tag(ctx, L.labels.calendar, M, top);
  // 图例：两人都说 / 只有我 / 只有对方（/ 认不出是谁），一律英文小戳
  const who = new Map(cal.days.map((d) => [d.date, d.who]));
  const theirs = /^[A-Z]+$/u.test(L.balance?.theirsLabel ?? "") ? L.balance!.theirsLabel : "TA";
  const legend: Array<[string, string]> = [["BOTH", WHO_COLOR.both], ["ME", WHO_COLOR.mine], [theirs, WHO_COLOR.theirs]];
  if (cal.days.some((d) => d.who === "one")) legend.push(["ONE", WHO_COLOR.one]);
  let lx = W - M;
  for (let i = legend.length - 1; i >= 0; i -= 1) {
    const [text, color] = legend[i]!;
    lx -= put(ctx, text, lx, top + 26, { font: F.mono, size: 18, color: INK, align: "right", spacing: "2px" }) + 8;
    fill(ctx, lx - 18, top + 9, 18, 18, color);
    lx -= 18 + 22;
  }
  const range = `${lay.cut ? "LAST 52 WEEKS · " : ""}${dotted(lay.first)} — ${dotted(cal.end)}`;
  const rangeX = M + tw + 18;
  const roomForRange = lx - rangeX - 10;
  put(ctx, range, rangeX, top + 26, { font: F.mono, size: 18, min: 18, width: roomForRange, color: INK, spacing: measure(ctx, range, F.mono, 18, "1px") <= roomForRange ? "1px" : "0px" });

  const gridTop = top + CAL_HEAD + lay.ticksH + Math.max(0, (h - calendarNatural(lay)) / 2);
  const { pitchX, pitchY, gap, left } = lay;
  const cellW = pitchX - gap;
  const cellH = pitchY - gap;
  // 刻度：按月排时是日期，按周排时是月份
  lay.ticks.forEach(({ col, text }) => {
    if (lay.mode === "month") put(ctx, text, left + col * pitchX + cellW / 2, gridTop - 8, { font: F.mono, size: 18, color: MUTE, align: "center" });
    else if (left + col * pitchX + measure(ctx, text, F.mono, 18, "1px") <= M + CW) put(ctx, text, left + col * pitchX, gridTop - 8, { font: F.mono, size: 18, color: MUTE, spacing: "1px" });
  });
  lay.rowLabels.forEach((text, r) => put(ctx, text, M, gridTop + r * pitchY + cellH / 2 + 7, { font: F.mono, size: 18, color: MUTE, spacing: "1px" }));
  const dayNums = lay.mode === "strip" && cellW >= 36 && cellH >= 34;
  for (const { date, col, row } of lay.cells) {
    const cx = left + col * pitchX;
    const cy = gridTop + row * pitchY;
    const w = who.get(date);
    fill(ctx, cx, cy, cellW, cellH, WHO_COLOR[w ?? "none"]);
    if (dayNums) put(ctx, String(Number(date.slice(8, 10))), cx + cellW / 2, cy + cellH / 2 + 7, { font: F.mono, size: 18, color: w ? INK : MUTE, align: "center" });
  }
}

// ---------- 整张 ----------
type Block = { natural: () => number; draw: (y: number, h: number) => void };

export const poster: SparkCardTheme = {
  fontCss: "family=Anton&family=JetBrains+Mono:wght@700&family=Noto+Sans+SC:wght@500;700;900",
  fonts: [F.cjk9(40), F.cjk7(40), F.cjk5(40), F.num(40), F.mono(20)],
  draw(ctx, L) {
    ctx.textBaseline = "alphabetic";
    fill(ctx, 0, 0, W, H, PAPER);

    // 报头 + 谁
    fill(ctx, 0, 0, W, BAND, INK);
    const tw = put(ctx, L.title, M, 62, { font: F.cjk9, size: 40, color: PAPER, spacing: "2px" });
    put(ctx, L.stamp, W - M, 58, { font: F.mono, size: 20, min: 18, width: CW - tw - 40, color: SIG, align: "right", spacing: "4px" });
    drawWho(ctx, L.who);
    const heroTop = WHO_RULE + RULE;

    // 底栏
    const bandTop = H - 60;
    const footerBase = bandTop - 24;
    const lowerEnd = footerBase - 40;

    const rows = statRows(L);
    const statBase = rows.map((row) => STAT_H[statLinesNeeded(ctx, row) - 1] ?? STAT_H[0]!);
    let statGrow = 0;
    /** 不按有值格数打折、每行一样多的那部分（只在下面各块都吃饱以后才给） */
    let statFlat = 0;
    let statTrim = 0;

    // 下半部分：有什么画什么。块的自然高度随下面几个可调的量变
    const knob = { pad: 14, calScale: 1, calTicks: true, bars: 110, flLines: 3, balance: "inline" as BalanceMode };
    const blocks: Block[] = [];
    const balance = L.balance;
    // 大号百分比按主角数字的字号封顶（主角高度定下来以后再算）
    let pctMax = 96;
    if (balance) blocks.push({ natural: () => BALANCE_H[knob.balance], draw: (y, h) => drawBalance(ctx, balance, L.labels.balance, y, h, knob.balance, L.group, pctMax) });
    const chips = {
      emoji: L.emoji.map((e) => ({ a: e.code, b: `×${n(e.count)}` })),
      words: L.words.map((w) => ({ a: w.word, b: n(w.count) })),
    };
    const SIDE_W = 372;
    let chipsInSide = false;
    if (L.hours) {
      // 钟点图右边一栏：第一句话；没有的话，只有一种（表情或词）且一个一行列得下就列在这里；其余放到最底下整行
      const chipCount = (chips.emoji.length ? 1 : 0) + (chips.words.length ? 1 : 0);
      const only = chipCount === 1 ? (chips.emoji.length ? chips.emoji : chips.words) : null;
      const asList = only !== null && listHeight(only.length) <= hoursNatural(ctx, L, knob.bars, CW - SIDE_W - 30);
      const sideKind = L.firstLine ? "first" : asList ? "chips" : null;
      chipsInSide = sideKind === "chips";
      const sideNatural = () => (sideKind === "first" ? firstLineLayout(ctx, L, SIDE_W - 10, knob.flLines)?.natural ?? 0 : sideKind === "chips" && only ? listHeight(only.length) : 0);
      const sideW = sideKind ? SIDE_W : 0;
      const hw = sideW ? CW - sideW - 30 : CW;
      blocks.push({
        natural: () => Math.max(hoursNatural(ctx, L, knob.bars, hw), sideNatural()) + 2 * knob.pad,
        draw: (y, h) => {
          const innerTop = y + knob.pad;
          const innerH = h - 2 * knob.pad;
          drawHours(ctx, L, M, innerTop, hw, innerH);
          if (!sideW) return;
          const sx = M + hw + 30;
          fill(ctx, sx - 16, y, RULE, h, INK);
          if (sideKind === "first") drawFirstLine(ctx, L, sx + 10, innerTop, sideW - 10, innerH, knob.flLines);
          else if (only) {
            const cy = innerTop + Math.max(0, (innerH - sideNatural()) / 2);
            drawChipColumn(ctx, chips.emoji.length ? L.labels.emoji : L.labels.words, only, sx + 10, cy, sideW - 10);
          }
        },
      });
    } else if (L.firstLine) {
      blocks.push({ natural: () => (firstLineLayout(ctx, L, CW, knob.flLines)?.natural ?? 0) + 2 * knob.pad, draw: (y, h) => drawFirstLine(ctx, L, M, y + knob.pad, CW, h - 2 * knob.pad, knob.flLines) });
    }
    if (L.calendar) {
      const lay = () => calendarLayout(L, knob.calScale, knob.calTicks);
      blocks.push({
        natural: () => calendarNatural(lay()) + 2 * knob.pad,
        draw: (y, h) => { const cl = lay(); if (cl) drawCalendar(ctx, L, y + knob.pad, h - 2 * knob.pad, cl); },
      });
    }
    const rowChips = chipsInSide ? [] : ([[L.labels.emoji, chips.emoji], [L.labels.words, chips.words]] as Array<[string, Chip[]]>)
      .filter(([, list]) => list.length)
      .map(([label, list]) => ({ label, ...chipRow(ctx, label, list, M, CW) }));
    if (rowChips.length) {
      const inner = rowChips.reduce((sum, r) => sum + r.height, 0) + (rowChips.length - 1) * 18;
      blocks.push({
        natural: () => inner + 2 * knob.pad,
        draw: (y, h) => {
          let cy = y + (h - inner) / 2;
          rowChips.forEach((r) => {
            tag(ctx, r.label, M, cy);
            drawChipList(ctx, r.placed, cy + 29, CHIP_LINE);
            cy += r.height + 18;
          });
        },
      });
    }

    // 分高度：放不下就按下面的顺序一点点压（主角、柱区、日历格子高宽比、留白、数据格、第一句话行数……），
    // 日历的月份刻度很靠后才关，主角最后才压到 240 以下
    const rules = rows.length * RULE + blocks.length * RULE + (L.hero.lit ? 0 : RULE);
    const weights = rows.map(statWeight);
    let heroH = 320;
    const rowH = (r: number) => (statBase[r] ?? STAT_H[0]!) + statGrow * (weights[r] ?? 1) + statFlat - statTrim;
    const spareNow = () => lowerEnd - heroTop - heroH - rows.reduce((sum, _, r) => sum + rowH(r), 0) - blocks.reduce((sum, block) => sum + block.natural(), 0) - rules;
    const heroTo = (min: number) => () => { if (heroH <= min) return false; heroH = Math.max(min, heroH + spareNow()); return true; };
    const squeeze: Array<() => boolean> = [
      heroTo(280),
      () => { if (knob.bars <= 96 || !L.hours) return false; knob.bars -= 2; return true; },
      () => { if (knob.calScale <= 0.92 || !L.calendar) return false; knob.calScale = Math.max(0.92, knob.calScale - 0.02); return true; },
      () => { if (knob.pad <= 10) return false; knob.pad -= 1; return true; },
      () => { if (statTrim >= 8) return false; statTrim += 2; return true; },
      heroTo(260),
      () => { if (knob.bars <= 84 || !L.hours) return false; knob.bars -= 2; return true; },
      () => { if (knob.flLines <= 2) return false; knob.flLines = 2; return true; },
      () => { if (knob.calScale <= 0.85 || !L.calendar) return false; knob.calScale = Math.max(0.85, knob.calScale - 0.01); return true; },
      heroTo(240),
      () => { if (knob.pad <= 8) return false; knob.pad -= 1; return true; },
      () => { if (!knob.calTicks || !L.calendar) return false; knob.calTicks = false; return true; },
      heroTo(200),
    ];
    for (const step of squeeze) while (spareNow() < 0 && step()) { /* 一步步压 */ }

    // 有富余：好友卡的对比条换大号（只有一两条消息、或主角没亮又是窄数字时不换，免得比主角抢眼；群卡和数据少的换加粗版）；
    // 主角长到够用为止；剩下的数据格和各块平分（多半是「—」的行少分，各块最多吃 BLOCK_SOAK）；
    // 还有剩说明下面没什么可画的：主角再长一点；再有剩，各块再吃一份，然后数据格每行平分，免得全堆成一块空白
    let spare = spareNow();
    if (balance) {
      const total = balance.mine + balance.theirs;
      if (!L.group && spare >= 260 && total >= 10 && (L.hero.lit || !narrowHero(L))) knob.balance = "large";
      else if (spare >= 150) knob.balance = "stacked";
      spare = spareNow();
    }
    const giveHero = Math.max(0, Math.min(spare * 0.7, heroMax(ctx, L) - heroH));
    heroH += giveHero;
    spare -= giveHero;
    const BLOCK_SOAK = 64;
    let extra = 0;
    if (spare > 0) {
      const share = spare / (rows.length + blocks.length);
      if (rows.length) statGrow = Math.min(STAT_GROW, share);
      extra = Math.min(BLOCK_SOAK, share);
      spare = spareNow() - extra * blocks.length;
    }
    if (spare > 0) {
      const more = Math.min(spare, Math.max(0, (narrowHero(L) ? 540 : Math.min(620, heroMax(ctx, L) + 20)) - heroH));
      heroH += more;
      spare -= more;
    }
    if (spare > 0 && blocks.length) {
      const more = Math.min(BLOCK_SOAK, spare / blocks.length);
      extra += more;
      spare -= more * blocks.length;
    }
    if (spare > 0 && rows.length) {
      statFlat = spare / rows.length;
      spare = 0;
    }
    if (spare > 0 && blocks.length) extra += spare / blocks.length;

    pctMax = Math.min(96, heroLayout(ctx, L, heroTop, heroH).size * 0.5);
    drawHero(ctx, L, heroTop, heroH);
    const statTop = heroTop + heroH + (L.hero.lit ? 0 : RULE);
    const statH = rows.map((_, r) => rowH(r));
    drawStats(ctx, L, statTop, statH);
    let y = statTop + statH.reduce((a, b) => a + b + RULE, 0);
    blocks.forEach((block) => {
      const h = block.natural() + extra;
      block.draw(y, h);
      y += h;
      fill(ctx, M, y, CW, RULE, INK);
      y += RULE;
    });

    put(ctx, L.footer, M, footerBase, { font: F.cjk5, size: 19, min: 18, width: CW, color: MUTE });
    fill(ctx, 0, bandTop, W, 60, INK);
    put(ctx, L.group ? "GROUP CHAT" : "ONE ON ONE", M, bandTop + 38, { font: F.mono, size: 18, color: SIG, spacing: "4px" });
    put(ctx, L.brand, W - M, bandTop + 38, { font: F.mono, size: 20, color: PAPER, align: "right", spacing: "2px" });
  },
};
