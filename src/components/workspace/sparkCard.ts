import type { ChatMemorial } from "../../domain/chatMemorial";

/*
 * 火花纪念卡：一个会话的聊天统计画成 3:4 的图（1080×1440），存成 PNG。
 * 和年度分享图一样直接在 canvas 上排字，不放头像（隐私，而且抖音 CDN 的图会污染 canvas，导不出来）。
 * 卡上写什么只在 sparkCardLines 里定，三种风格（sparkCardPoster / Archive / Trace）只管怎么摆。
 */

export const W = 1080;
export const H = 1440;
export type SparkCardStyle = "poster" | "archive" | "trace";

export interface SparkCardStat {
  /** 小标题，如「最常聊的钟点」。 */
  k: string;
  /** 主值，短：「晚上 7 点」「345 条」；没有数据时是「—」。 */
  v: string;
  /** 一句说明，叙事句；可能为空串。 */
  s: string;
}

export interface SparkCardLines {
  title: string;
  /** 英文小戳，风格可用可不用。 */
  stamp: string;
  /** 「我和小周」或群名。 */
  who: string;
  group: boolean;
  /** 卡的主角：火花天数；没火花时是聊过的天数，群里是总条数。 */
  hero: { label: string; value: string; unit: string; note: string; lit: boolean };
  /** 固定顺序的几格数据，好友 6 格、群 5 格。 */
  stats: SparkCardStat[];
  /** 两边各发了多少，画对比条用；群里 theirs 是其他群友加起来。 */
  balance: { mine: number; theirs: number; mineLabel: string; theirsLabel: string } | null;
  /** 0–23 点每个钟点的条数；没有带时间的消息时为 null。 */
  hours: number[] | null;
  peakHour: number | null;
  /** 群里钟点等只来自最近读到的一批，这是给钟点图配的一句说明；好友为空串。 */
  hoursNote: string;
  /** 从第一天到统计那天的日历格；群聊为 null。who：both 双方、mine 只有我、theirs 只有对方、one 认不出是谁。 */
  calendar: { start: string; end: string; days: Array<{ date: string; who: "both" | "mine" | "theirs" | "one"; count: number }> } | null;
  emoji: Array<{ code: string; count: number }>;
  words: Array<{ word: string; count: number }>;
  firstLine: { text: string; by: string } | null;
  /** 各块的小标题，三种风格共用。 */
  labels: { balance: string; hours: string; calendar: string; emoji: string; words: string; firstLine: string };
  /** 卡底的一句落款（叙事句）。 */
  footer: string;
  brand: string;
}

const nf = new Intl.NumberFormat("zh-CN");
export const n = (value: number) => nf.format(Math.round(Number(value) || 0));
const part = (hour: number) => (hour < 5 ? "凌晨" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : "晚上");
export const clock = (hour: number, minute?: number) => `${part(hour)} ${hour > 12 ? hour - 12 : hour}${minute === undefined ? " 点" : `:${String(minute).padStart(2, "0")}`}`;

/** 本地日期：「8 月 28 日」，不是统计那年的带上年份。 */
export function day(value: string | Date, thisYear: number): string {
  const date = typeof value === "string" ? (/^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)) : value;
  return `${date.getFullYear() !== thisYear ? `${date.getFullYear()} 年 ` : ""}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function sparkCardLines(m: ChatMemorial): SparkCardLines {
  const at = new Date(m.at);
  const year = at.getFullYear();
  const group = m.kind === "group";
  const other = group ? "群友" : "TA";
  const spark = m.spark;
  const pendingNote = group ? "今天还没续上，零点前聊几句就能接上"
    : spark?.today === "mine" ? "今天我说过了，等 TA 回一句就能接上"
      : spark?.today === "theirs" ? "TA 今天说过了，零点前回一句就能接上"
        : "今天还没续，零点前两个人都说句话就能接上";
  const hero: SparkCardLines["hero"] = spark && (spark.state === "done" || spark.state === "pending")
    ? { label: "火花已经连着", value: n(spark.days), unit: "天", note: spark.state === "pending" ? pendingNote : "今天也续上了", lit: true }
    : spark?.state === "recover"
      // 抖音的「重燃中」和「N 天后消失」是同一个状态，说法不一样
      ? spark.text.includes("重燃")
        ? { label: "火花重燃中，之前连着", value: n(spark.days), unit: "天", note: `抖音上显示「${spark.text}」`, lit: true }
        : { label: "火花快要熄了，已经连着", value: n(spark.days), unit: "天", note: spark.text.includes("消失") ? `抖音上显示「${spark.text}」，今天聊上就能留住` : "今天聊上就能留住", lit: true }
      : spark?.state === "broken"
        ? { label: "火花曾经连着", value: n(spark.days), unit: "天", note: spark.brokeOn ? `${day(spark.brokeOn, year)}那天断了` : "最近断了", lit: false }
        : group
          ? { label: "群里一共说了", value: n(m.total), unit: "条", note: "是从采集到的消息里数出来的", lit: false }
          : !m.total
            ? { label: "我们还没聊过", value: "0", unit: "条", note: "这台电脑上还没存下你们的聊天记录", lit: false }
            : m.activeDays && m.firstAt
              ? { label: "我们聊过", value: n(m.activeDays), unit: "天", note: m.sinceDays === 1 ? "今天刚开始聊" : `从 ${day(m.firstAt, year)}算起的 ${n(m.sinceDays ?? 0)} 天里`, lit: false }
              : { label: "我们聊了", value: n(m.total), unit: "条", note: "这些消息都没有记下时间", lit: false };

  const latest = m.latest ? new Date(m.latest) : null;
  const sharedTotal = m.shares.mine + m.shares.theirs;
  const sampleNote = group ? (m.sample ? `按最近读到的 ${n(m.sample)} 条算` : "群消息不存本机，打开群聊读到消息后才有") : "";
  const run = m.longestRun;
  const runNote = !m.total ? "" : !m.hours ? "消息都没有记下时间，算不出是哪天" : !run ? "还没有两个人同一天都说话的时候" : run.days < 2 ? "还没有连着两天都互发过"
    // 抖音的火花比本机记录长时，说清楚这是本机记下的那一段
    : spark?.official && spark.days > run.days ? `这台电脑记下的日子里，最长连着互发了 ${n(run.days)} 天` : `最长连着互发了 ${n(run.days)} 天`;
  const stats: SparkCardStat[] = group ? [
    { k: "我说了", v: `${n(m.mine)} 条`, s: m.mine ? `群友说了 ${n(m.theirs)} 条` : "采集到的消息里还没有我说的" },
    { k: "我说的话占多少", v: m.total ? percent(m.mine, m.total) : "—", s: m.total ? groupShare(m.mine, m.total) : "" },
    { k: "最常聊的钟点", v: m.peakHour === null ? "—" : clock(m.peakHour), s: sampleNote },
    { k: "最近聊得最晚的一次", v: latest ? clock(latest.getHours(), latest.getMinutes()) : "—", s: latest ? nightOf(latest, year) : sampleNote },
    { k: "最近分享的视频", v: sharedTotal ? `${n(sharedTotal)} 个` : "—", s: !m.sample ? "" : sharedTotal ? `最近读到的 ${n(m.sample)} 条里，我分享了 ${n(m.shares.mine)} 个` : `最近读到的 ${n(m.sample)} 条里没有分享` },
  ] : [
    { k: "一共聊了", v: `${n(m.total)} 条`, s: m.total ? `我发了 ${n(m.mine)} 条，TA 发了 ${n(m.theirs)} 条` : "" },
    { k: "互发消息的日子", v: m.mutualDays ? `${n(m.mutualDays)} 天` : "—", s: runNote },
    { k: "最常聊的钟点", v: m.peakHour === null ? "—" : clock(m.peakHour), s: m.peakHour === null ? (m.total ? "消息都没有记下时间" : "") : `这个钟点一共发了 ${n(m.hours?.[m.peakHour] ?? 0)} 条` },
    { k: "聊得最晚的一次", v: latest ? clock(latest.getHours(), latest.getMinutes()) : "—", s: latest ? nightOf(latest, year) : "" },
    { k: "最热闹的一天", v: m.busiestDay ? day(m.busiestDay.date, year) : "—", s: m.busiestDay ? `那天一共聊了 ${n(m.busiestDay.count)} 条` : "" },
    { k: "互相分享的视频", v: sharedTotal ? `${n(sharedTotal)} 个` : "—", s: !m.total ? "" : !sharedTotal ? "还没互相分享过视频" : m.selfKnown ? `我分享了 ${n(m.shares.mine)} 个，TA 分享了 ${n(m.shares.theirs)} 个` : "" },
  ];

  const footer = [
    `统计到 ${year} 年 ${at.getMonth() + 1} 月 ${at.getDate()} 日`,
    group ? "群消息正文不存本机，总数是采集时数下来的" : "只算这台电脑上存下的聊天记录",
    spark ? (spark.official ? "火花天数来自抖音" : "火花天数是按双方都发消息的日子估算的") : "",
  ].filter(Boolean).join("，") + "。";

  return {
    title: "火花纪念卡",
    stamp: "SPARK MEMORIAL",
    who: group ? m.name : `我和${m.name}`,
    group,
    hero,
    stats,
    balance: m.total ? { mine: m.mine, theirs: m.theirs, mineLabel: "我", theirsLabel: other } : null,
    hours: m.hours,
    peakHour: m.peakHour,
    hoursNote: sampleNote,
    calendar: m.days.length ? { start: m.days[0]!.date, end: localDate(at), days: m.days } : null,
    emoji: m.topEmoji,
    words: m.topWords,
    firstLine: m.firstLine ? { text: m.firstLine.text, by: `${m.firstLine.mine === null ? "" : m.firstLine.mine ? "我在 " : "TA 在 "}${day(m.firstLine.at, year)}说的` } : null,
    labels: { balance: "谁说得多", hours: "一天里什么时候聊", calendar: "聊天的每一天", emoji: "最常用的表情", words: "聊得最多的词", firstLine: "第一句话" },
    footer,
    brand: "DouyinDataReview · 非官方",
  };
}

/** 卡上会出现的所有字，交给 document.fonts.load：思源字体按 unicode-range 分片，页面上没出现过的字不会自己加载。 */
export function sparkCardText(lines: SparkCardLines): string {
  return [
    lines.title, lines.stamp, lines.who, lines.hero.label, lines.hero.value, lines.hero.unit, lines.hero.note,
    ...lines.stats.flatMap((stat) => [stat.k, stat.v, stat.s]), lines.hoursNote, lines.footer, lines.brand,
    ...lines.emoji.map((item) => `${item.code}${item.count}`), ...lines.words.map((item) => `${item.word}${item.count}`),
 ...Object.values(lines.labels),
    lines.firstLine?.text ?? "", lines.firstLine?.by ?? "", "我TA群友0123456789：，。×次天条个点日月年—「」…凌晨早上上午中午下午晚上",
  ].join("");
}

export type FontSpec = (size: number) => string;
/** `f("700 # \"Noto Sans SC\",sans-serif")(40)` → 把 # 换成字号。 */
export const f = (spec: string): FontSpec => (size) => spec.replace("#", `${size}px`);

export interface PutOptions {
  font: FontSpec;
  size: number;
  /** 缩到这个字号还放不下就截断加 … */
  min?: number;
  width?: number;
  color: string;
  align?: CanvasTextAlign;
  spacing?: string;
  glow?: string | null;
}

// 先按宽度缩字号，缩到底还放不下就截断加 …；返回实际画出的宽度
export function put(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, { font, size, min = size, width, color, align = "left", spacing = "0px", glow = null }: PutOptions): number {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = spacing;
  ctx.font = font(size);
  const measured = ctx.measureText(text).width;
  if (width && measured > width) size = Math.max(min, Math.floor((size * width) / measured));
  ctx.font = font(size);
  // 字宽不完全随字号线性变化，差一点的再一号一号往下缩
  while (width && size > min && ctx.measureText(text).width > width) ctx.font = font(--size);
  let shown = text;
  if (width) while (Array.from(shown).length > 1 && ctx.measureText(shown).width > width) shown = `${Array.from(shown).slice(0, -2).join("")}…`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.35; }
  ctx.fillText(shown, x, y);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return ctx.measureText(shown).width;
}

/** 按宽度折行（中文逐字、英文按词），最多 maxLines 行，最后一行放不下加 …；返回画了几行。 */
export function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, lineHeight: number, maxLines: number, options: PutOptions & { width: number }): number {
  ctx.font = options.font(options.size);
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = options.spacing ?? "0px";
  const tokens = text.match(/[A-Za-z0-9@#'’.\-_]+|\s+|./gu) ?? [];
  const rows: string[] = [];
  let row = "";
  for (const token of tokens) {
    const next = row + token;
    if (row && ctx.measureText(next).width > options.width) {
      rows.push(row.trimEnd());
      row = token.trimStart();
      if (rows.length === maxLines) break;
    } else row = next;
  }
  if (rows.length < maxLines && row.trim()) rows.push(row.trim());
  const truncated = rows.length === maxLines && rows.join("").replace(/\s/gu, "").length < text.replace(/\s/gu, "").length;
  rows.forEach((line, index) => {
    const last = index === rows.length - 1;
    put(ctx, last && truncated ? `${line}…` : line, x, y + index * lineHeight, { ...options, min: options.size });
  });
  return rows.length;
}

export const fill = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 日历格要用的：从 start 到 end 每一天（含首尾），本地日期字符串。 */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last && out.length < 4000) {
    out.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function percent(part: number, whole: number): string {
  const value = (part / whole) * 100;
  if (value > 0 && value < 0.1) return "不到 0.1%";
  // 还有别人说过话就别四舍五入成 100%
  if (part < whole && value > 99) return "99%";
  return `${value > 0 && value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

function groupShare(mine: number, total: number): string {
  if (!mine) return "采集到的消息里还没有我说的";
  if (mine >= total) return "群里的话全是我说的";
  const tenths = Math.round((mine * 10) / total);
  if (mine * 2 >= total) return tenths >= 10 ? "差不多全是我说的" : `每 10 条里有 ${tenths} 条是我说的`;
  return `平均每 ${n(total / mine)} 条里有 1 条是我说的`;
}

/** 「最晚」按凌晨 5 点换天：凌晨两点那条算前一天夜里。 */
function nightOf(at: Date, year: number): string {
  if (at.getHours() >= 5) return day(at, year);
  const before = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1, 12);
  return `${day(before, year)}夜里，已经过了零点`;
}

/** 一种风格：fontCss 是 Google Fonts css2 的查询串；fonts 是要预载的 canvas 字体写法；draw 在 1080×1440 上画满。 */
export interface SparkCardTheme {
  fontCss: string;
  fonts: string[];
  draw(ctx: CanvasRenderingContext2D, lines: SparkCardLines): void;
}
