import type { PersonalRecordCollection } from "../../domain/personalRecords";

/**
 * 采集器页的两样纯函数：
 * 1. 手绘线条的几何——边框、直线、圈注、勾、箭头、斜线填充。随机抖动全部来自固定种子，
 *    同一个种子每次渲染画出同一笔；尺寸变了只是把同一笔拉伸，抖动幅度按像素算，不会越拉越歪。
 * 2. 从记录里算出页面上要画的数据：按天的条数、最早最晚的日期、最近的几条。
 */

// ---------- 种子随机数 ----------

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** mulberry32：同一个种子得到同一串 [0,1) 随机数。 */
export function seeded(seed: string): () => number {
  let state = hash(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const f = (value: number) => (Math.round(value * 10) / 10).toString();
const wobble = (rand: Rand, amount: number) => (rand() - 0.5) * 2 * amount;

// 一笔直线：两端各抖一点、略微出头，中间两个控制点往法线方向偏，像手腕带出的弧度
function stroke(rand: Rand, x1: number, y1: number, x2: number, y2: number, amp: number, move = true): string {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  // 越长的线手越晃：弯曲幅度随长度涨，封顶在 amp 的 2.2 倍；两端出头、错位也随 amp 走
  const bend = Math.min(amp * Math.min(2.2, 1 + length / 160), length / 10);
  const over = Math.min(1.5 + amp, length * 0.03);
  const drift = 0.35 + amp * 0.3;
  const sx = x1 - dx * over * rand() + wobble(rand, drift);
  const sy = y1 - dy * over * rand() + wobble(rand, drift);
  const ex = x2 + dx * over * rand() + wobble(rand, drift);
  const ey = y2 + dy * over * rand() + wobble(rand, drift);
  const b1 = wobble(rand, bend);
  const b2 = wobble(rand, bend);
  const t1 = 0.28 + rand() * 0.14;
  const t2 = 0.62 + rand() * 0.14;
  const c1x = x1 + (x2 - x1) * t1 - dy * b1;
  const c1y = y1 + (y2 - y1) * t1 + dx * b1;
  const c2x = x1 + (x2 - x1) * t2 - dy * b2;
  const c2y = y1 + (y2 - y1) * t2 + dx * b2;
  return `${move ? `M${f(sx)} ${f(sy)}` : ""}C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`;
}

/** 手绘直线（可多描几遍）。 */
export function roughLine(x1: number, y1: number, x2: number, y2: number, seed: string, options: { amp?: number; passes?: number } = {}): string {
  const rand = seeded(seed);
  const passes = options.passes ?? 1;
  let path = "";
  for (let pass = 0; pass < passes; pass += 1) path += stroke(rand, x1, y1, x2, y2, options.amp ?? 1.4);
  return path;
}

/** 手绘矩形描边：四条边各自一笔，角上出头交叉；passes=2 时再描一遍，像铅笔来回勾。 */
export function roughRect(width: number, height: number, seed: string, options: { inset?: number; amp?: number; passes?: number; x?: number; y?: number } = {}): string {
  const inset = options.inset ?? 1.5;
  const amp = options.amp ?? 1.6;
  const rand = seeded(seed);
  const l = (options.x ?? 0) + inset;
  const t = (options.y ?? 0) + inset;
  const r = Math.max(l + 1, (options.x ?? 0) + width - inset);
  const b = Math.max(t + 1, (options.y ?? 0) + height - inset);
  let path = "";
  for (let pass = 0; pass < (options.passes ?? 2); pass += 1) {
    path += stroke(rand, l, t, r, t, amp);
    path += stroke(rand, r, t, r, b, amp);
    path += stroke(rand, r, b, l, b, amp);
    path += stroke(rand, l, b, l, t, amp);
  }
  return path;
}

/** 手绘矩形的填充面：一条闭合的、四边微鼓的路径，和描边的抖动对得上。 */
export function roughShape(width: number, height: number, seed: string, options: { inset?: number; amp?: number; x?: number; y?: number } = {}): string {
  const inset = options.inset ?? 1.5;
  const amp = options.amp ?? 1.2;
  const rand = seeded(`${seed}:fill`);
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const l = x + inset + wobble(rand, 0.4);
  const t = y + inset + wobble(rand, 0.4);
  const r = Math.max(l + 1, x + width - inset + wobble(rand, 0.4));
  const b = Math.max(t + 1, y + height - inset + wobble(rand, 0.4));
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const bend = Math.min(amp, length / 14);
    const nx = -(y2 - y1) / length;
    const ny = (x2 - x1) / length;
    const b1 = wobble(rand, bend);
    const b2 = wobble(rand, bend);
    return `C${f(x1 + (x2 - x1) * 0.33 + nx * b1)} ${f(y1 + (y2 - y1) * 0.33 + ny * b1)} ${f(x1 + (x2 - x1) * 0.67 + nx * b2)} ${f(y1 + (y2 - y1) * 0.67 + ny * b2)} ${f(x2)} ${f(y2)}`;
  };
  return `M${f(l)} ${f(t)}${edge(l, t, r, t)}${edge(r, t, r, b)}${edge(r, b, l, b)}${edge(l, b, l, t)}Z`;
}

/** 手绘圈注：一圈多一点，起笔收笔不闭合，半径逐点抖动，用 Catmull-Rom 串成平滑曲线。 */
export function roughEllipse(cx: number, cy: number, rx: number, ry: number, seed: string, options: { turns?: number; jitter?: number } = {}): string {
  const rand = seeded(seed);
  const turns = options.turns ?? 1.12;
  const jitter = options.jitter ?? 0.06;
  const start = -Math.PI * (0.55 + rand() * 0.25);
  const steps = Math.max(10, Math.round(14 * turns));
  const points: Array<[number, number]> = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + (index / steps) * Math.PI * 2 * turns;
    // 收笔那段半径略缩，像笔往里带了一下
    const tail = index / steps > 0.85 ? 1 - (index / steps - 0.85) * 0.35 : 1;
    const scale = (1 + wobble(rand, jitter)) * tail;
    points.push([cx + Math.cos(angle) * rx * scale, cy + Math.sin(angle) * ry * scale]);
  }
  const at = (index: number): [number, number] => points[Math.max(0, Math.min(points.length - 1, index))]!;
  let path = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    path += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return path;
}

/** 手绘的勾：短的一撇接长的一挑。 */
export function roughCheck(x: number, y: number, size: number, seed: string): string {
  const rand = seeded(seed);
  const a: [number, number] = [x + size * 0.08 + wobble(rand, 0.6), y + size * 0.52 + wobble(rand, 0.6)];
  const m: [number, number] = [x + size * 0.4 + wobble(rand, 0.6), y + size * 0.84 + wobble(rand, 0.5)];
  const e: [number, number] = [x + size * 0.95 + wobble(rand, 0.8), y + size * 0.1 + wobble(rand, 0.8)];
  return `M${f(a[0])} ${f(a[1])}Q${f((a[0] + m[0]) / 2 + 1)} ${f((a[1] + m[1]) / 2 - 1)} ${f(m[0])} ${f(m[1])}Q${f(m[0] + (e[0] - m[0]) * 0.4 + wobble(rand, 1.2))} ${f(m[1] + (e[1] - m[1]) * 0.55)} ${f(e[0])} ${f(e[1])}`;
}

/** 手绘箭头：一笔带弧的杆 + 箭头两撇。 */
export function roughArrow(x1: number, y1: number, x2: number, y2: number, seed: string, options: { bend?: number; head?: number } = {}): string {
  const rand = seeded(seed);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  const bend = options.bend ?? Math.min(4, length / 6);
  const mx = (x1 + x2) / 2 - dy * bend;
  const my = (y1 + y2) / 2 + dx * bend;
  const head = options.head ?? Math.min(7, length / 3);
  // 箭头顺着杆末端的切线方向
  const tx = x2 - mx;
  const ty = y2 - my;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const wing = (sign: number) => {
    const angle = sign * (0.5 + wobble(rand, 0.08));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const wx = -(ux * cos - uy * sin) * head;
    const wy = -(ux * sin + uy * cos) * head;
    return `M${f(x2 + wx)} ${f(y2 + wy)}L${f(x2 + wobble(rand, 0.4))} ${f(y2 + wobble(rand, 0.4))}`;
  };
  return `M${f(x1 + wobble(rand, 0.6))} ${f(y1 + wobble(rand, 0.6))}Q${f(mx + wobble(rand, 1))} ${f(my + wobble(rand, 1))} ${f(x2)} ${f(y2)}${wing(1)}${wing(-1)}`;
}

/** 斜线填充（hachure）：45° 平行线裁在矩形里，每根带一点抖。 */
export function hachure(x: number, y: number, width: number, height: number, seed: string, gap = 3.2): string {
  if (width <= 0.5 || height <= 0.5) return "";
  const rand = seeded(seed);
  let path = "";
  for (let k = -height + gap * rand(); k < width; k += gap) {
    const t0 = Math.max(0, -k);
    const t1 = Math.min(height, width - k);
    if (t1 - t0 < 0.8) continue;
    const j = () => wobble(rand, 0.35);
    path += `M${f(x + k + t0 + j())} ${f(y + height - t0 + j())}L${f(x + k + t1 + j())} ${f(y + height - t1 + j())}`;
  }
  return path;
}

// ---------- 记录里的数据 ----------

export type SetupRecordKind = "watch" | "liked" | "favorite";
const KINDS: ReadonlyArray<[SetupRecordKind, keyof PersonalRecordCollection]> = [
  ["watch", "watch_history"],
  ["liked", "liked_videos"],
  ["favorite", "favorite_videos"],
];

export interface DayCount {
  /** 当天 0 点（本地时区）的时间戳 */
  day: number;
  count: number;
}

export interface RecordDigest {
  total: number;
  dated: number;
  first: number | null;
  last: number | null;
  /** 按天的条数（本地日期），键是当天 0 点 */
  perDay: Map<number, number>;
  /** 一天 24 个小时各有多少条（本地时间） */
  perHour: number[];
  recent: Array<{ id: string; kind: SetupRecordKind; title: string; author: string | null; at: number }>;
}

const DAY = 86_400_000;
function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 扫一遍记录：按天计数、最早最晚、最近的几条（按发生时间倒序）。 */
export function digestRecords(records: PersonalRecordCollection, recentLimit = 14, now = Date.now()): RecordDigest {
  const perDay = new Map<number, number>();
  const perHour = Array.from({ length: 24 }, () => 0);
  let first: number | null = null;
  let last: number | null = null;
  let dated = 0;
  let total = 0;
  const recent: RecordDigest["recent"] = [];
  const ceiling = now + DAY; // 时钟不准或数据带了未来时间，超过明天的一律不算
  for (const [kind, key] of KINDS) {
    for (const record of records[key]) {
      total += 1;
      const at = record.occurredAt ? Date.parse(record.occurredAt) : Number.NaN;
      if (!Number.isFinite(at) || at > ceiling) continue;
      dated += 1;
      if (first === null || at < first) first = at;
      if (last === null || at > last) last = at;
      const day = startOfDay(at);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      const hour = new Date(at).getHours();
      perHour[hour] = (perHour[hour] ?? 0) + 1;
      // 只留最新的 recentLimit 条：插入排序，数组很短
      if (recent.length < recentLimit || at > recent[recent.length - 1]!.at) {
        const item = { id: `${kind}:${record.id}`, kind, title: record.title?.trim() || "（没有标题）", author: record.author, at };
        let index = recent.length;
        while (index > 0 && recent[index - 1]!.at < at) index -= 1;
        recent.splice(index, 0, item);
        if (recent.length > recentLimit) recent.pop();
      }
    }
  }
  return { total, dated, first, last, perDay, perHour, recent };
}

export interface DayWindow {
  days: DayCount[];
  /** 窗口是不是一直画到今天（数据是新的） */
  endsToday: boolean;
  max: number;
  maxIndex: number;
  activeDays: number;
  sum: number;
}

/**
 * 画柱图用的一段连续日期。最后一条记录在两天以内，窗口就画到今天（最近几天没记录也要看得出来）；
 * 数据是旧的（比如导入的老档案），窗口就停在最后一条记录那天，免得整段都是空的。
 */
export function dayWindow(digest: RecordDigest, length: number, now = Date.now()): DayWindow | null {
  if (digest.last === null) return null;
  const today = startOfDay(now);
  const lastDay = startOfDay(digest.last);
  const endsToday = today - lastDay <= 2 * DAY;
  const end = endsToday ? today : lastDay;
  const days: DayCount[] = [];
  let max = 0;
  let maxIndex = -1;
  let activeDays = 0;
  let sum = 0;
  for (let index = length - 1; index >= 0; index -= 1) {
    // 跨夏令时的日子不是整 24 小时，按日历重新取 0 点
    const date = new Date(end);
    date.setDate(date.getDate() - index);
    const day = date.getTime();
    const count = digest.perDay.get(day) ?? 0;
    if (count > max) {
      max = count;
      maxIndex = days.length;
    }
    if (count > 0) activeDays += 1;
    sum += count;
    days.push({ day, count });
  }
  return { days, endsToday, max, maxIndex, activeDays, sum };
}
