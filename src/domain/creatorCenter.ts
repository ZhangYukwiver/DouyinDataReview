// 创作者中心页面的取数规则和数字格式：全部照官方网页（creator.douyin.com）的前端逻辑，
// 同一个站点里有好几套格式化，各用在各的地方，不能混用。

type Raw = Record<string, any>;
const num = (value: unknown): number => (value === null || value === undefined || value === "" ? Number.NaN : Number(value));

function trimNumber(text: string): string {
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

/** 数据中心的大数缩写（官方 Q）：0 → 0，非数字 → -，万/亿最多两位小数，其余千分位。 */
export function dcCount(value: unknown): string {
  const n = num(value);
  if (Number.isNaN(n)) return "-";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}万`;
  return n.toLocaleString("zh-CN");
}

/** 数据中心带单位的值（官方 Z）：值为 0 时只显示 0，不带单位。 */
export function dcValue(value: unknown, unit = "", digits = 2): string {
  const n = num(value);
  if (Number.isNaN(n)) return "-";
  if (n === 0) return "0";
  const options = { maximumFractionDigits: digits };
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toLocaleString("zh-CN", options)}亿${unit}`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toLocaleString("zh-CN", options)}万${unit}`;
  return `${n.toLocaleString("zh-CN", options)}${unit}`;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** 作品列表卡片上的比率（官方 Dg）：69.7%、3.13%、0%，极小值改用 ‰。 */
export function listRate(value: unknown): string {
  const n = num(value === "" ? 0 : value);
  if (Number.isNaN(n)) return "--";
  if (n === 0) return "0%";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return abs < 0.00005 ? `${sign}${round(abs * 1000, 2)}‰` : `${sign}${round(abs * 100, 2)}%`;
}

/** 作品列表卡片上的数量（官方 Pk）。 */
export function listCount(value: unknown): string {
  const n = num(value === "" ? 0 : value);
  if (Number.isNaN(n)) return "--";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e8) return `${trimNumber((n / 1e8).toFixed(2))}亿`;
  if (Math.abs(n) >= 1e4) return `${trimNumber((n / 1e4).toFixed(1))}万`;
  if (Math.abs(n) >= 1) return trimNumber(n.toFixed(1));
  return trimNumber(n.toFixed(2));
}

/** 作品详情卡片的大数缩写（官方 Tt）。trim：true 去尾零；"hasDigit" 小数全是 0 才去；false 不去。 */
export function detailNumber(value: number, digit = 2, trim: boolean | "hasDigit" = "hasDigit"): { text: string; unit: string } {
  let scaled = value;
  let unit = "";
  if (Math.abs(value) >= 1e8) { scaled = value / 1e8; unit = "亿"; } else if (Math.abs(value) >= 1e4) { scaled = value / 1e4; unit = "万"; }
  let text = round(scaled, digit).toFixed(digit);
  if (trim === true) text = trimNumber(text);
  else if (trim === "hasDigit" && /\.0+$/u.test(text)) text = text.replace(/\.0+$/u, "");
  return { text, unit };
}

export type DetailKind = "count" | "percent" | "time";

/** 作品详情指标卡：百分比固定两位，数量 hasDigit，时长拆成时分秒；粉丝组走 digit 1 去尾零（官方的例外）。 */
export function detailMetric(value: unknown, kind: DetailKind, fansGroup = false): { text: string; unit: string } {
  const n = num(value);
  if (Number.isNaN(n)) return { text: "-", unit: "" };
  const v = Math.max(n, 0);
  if (kind === "time") return { text: durationText(v), unit: "" };
  if (kind === "percent") {
    const { text } = detailNumber(v * 100, fansGroup ? 1 : 2, fansGroup ? true : false);
    return { text, unit: "%" };
  }
  return fansGroup ? detailNumber(v, 1, true) : detailNumber(v, 2, "hasDigit");
}

/** 平均播放时长这类秒数：4秒、1分3秒、1时2分3秒（秒按四舍五入）。 */
export function durationText(seconds: number): string {
  let total = Math.floor(seconds);
  if (seconds - total >= 0.5) total += 1;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours}时${minutes}分${rest}秒`;
  if (minutes) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
}

/** 评论点赞、热词热度（官方 ZV）：740.2万、1万。 */
export function shortCount(value: unknown): string {
  const n = num(value);
  if (Number.isNaN(n)) return "0";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/u, "")}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/u, "")}万`;
  return String(n);
}

/** 画像表格占比：12.18%，太小显示 <0.01%。 */
export function portraitPercent(ratio: number): string {
  const text = (ratio * 100).toFixed(2);
  return Number(text) < 0.01 ? "<0.01%" : `${text}%`;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** 2026年09月28日 17:02 */
export function fullTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 列表封面角标：90001 → 01:30（分钟数超过 60 才带小时，照官方写法）。 */
export function listDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 60) return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
  return `${pad(minutes)}:${pad(seconds % 60)}`;
}
/** 详情页封面角标：58867 → 0:00:58（秒向下取整）。 */
export function detailDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
/** 秒 → mm:ss（≥1 小时 HH:mm:ss）。 */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** 评论时间（官方 dh）。 */
export function commentTime(seconds: number, now = Date.now()): string {
  const ms = seconds > 1e10 ? seconds : seconds * 1000;
  const date = new Date(ms);
  const current = new Date(now);
  const diff = (now - ms) / 1000;
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (sameDay(date, current)) return `${Math.floor(diff / 3600)}小时前`;
  const yesterday = new Date(now - 86400000);
  if (sameDay(date, yesterday)) return `昨天${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (diff < 3 * 86400) return `${Math.floor(diff / 86400)}天前`;
  const clock = `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === current.getFullYear() ? clock : `${date.getFullYear()}年${clock}`;
}

// ---------- 数据中心 ----------

export type DiagnosisKey = "PlayCnt" | "Interact" | "PlayFinishRatio" | "PublishActivation" | "NewFans";
export const DIAGNOSIS: Array<{ key: DiagnosisKey; label: string; valueName: string; dimension: number | null; topLabel: string; ratio: boolean }> = [
  { key: "PlayCnt", label: "播放量", valueName: "视频播放量", dimension: 1, topLabel: "7日新增播放量", ratio: false },
  { key: "Interact", label: "互动率", valueName: "互动指数", dimension: 2, topLabel: "7日互动量", ratio: true },
  { key: "PlayFinishRatio", label: "完播率", valueName: "完播率", dimension: 3, topLabel: "7日完播率", ratio: true },
  { key: "PublishActivation", label: "作品数", valueName: "投稿数", dimension: null, topLabel: "播放量", ratio: false },
  { key: "NewFans", label: "粉丝净增", valueName: "新增粉丝数", dimension: 5, topLabel: "7日新增粉丝", ratio: false },
];
/** 雷达图轴顺序（官方 Qr） */
export const RADAR_AXES: Array<{ key: DiagnosisKey; label: string }> = [
  { key: "PlayCnt", label: "播放量" }, { key: "Interact", label: "互动指数" }, { key: "PublishActivation", label: "投稿量" },
  { key: "NewFans", label: "新增粉丝数" }, { key: "PlayFinishRatio", label: "完播率" },
];
const DIAGNOSIS_ADVICE: Record<string, string> = {
  投稿数: "持续发布作品，才会吸引更多粉丝哟，快来记录美好生活吧",
  视频播放量: "作品内容是提升播放量的制胜法宝，可以关注同行业热门作品的拍摄技巧，还可以巧用热门话题、热门音乐和道具，继续加油",
  完播率: "想要作品吸引人，前3秒钟是关键，可以多分析同行业热门作品的的人设、镜头技巧和音乐，结合自身特点，创作出更精彩的作品",
  互动指数: "作品的开头和结尾的情节设计很关键，打造独特的\"记忆点\"，并且让观众多点赞留言，另外记得多在评论区和观众互动哦",
  新增粉丝数: "提升作品的播放量吸引更多人观看、积极和粉丝互动，都可以增加粉丝哦，此外还可以通过DOU+的方式新增粉丝，不妨试一试",
};

/** 指标块：「播放量 36」「超过66%同类作者」和选中时的「较好/优秀」。 */
export function diagnosisBlock(key: DiagnosisKey, entry: Raw | undefined) {
  const config = DIAGNOSIS.find((item) => item.key === key)!;
  const rank = Number(entry?.AuthorRank ?? 0) || 0;
  const own = Number(entry?.OwnValue ?? 0) || 0;
  const value = config.ratio ? `${(100 * own).toFixed(1)}%` : dcCount(own);
  const rankText = rank >= 0.5 ? `超过${(100 * rank).toFixed(0)}%同类作者` : `低于${(100 * (1 - rank)).toFixed(0)}%同类作者`;
  const tag = rank >= 0.8 ? "优秀" : rank >= 0.5 ? "较好" : null;
  return { label: config.label, value, rankText, tag };
}

/** 「X分析」那句话：您的视频播放量为36，高于65.62%的同类创作者（低于一半时加提升建议）。 */
export function diagnosisSentence(key: DiagnosisKey, entry: Raw | undefined): { parts: Array<{ text: string; bold?: boolean }> } {
  const config = DIAGNOSIS.find((item) => item.key === key)!;
  const rank = Number(entry?.AuthorRank ?? 0) || 0;
  const own = Number(entry?.OwnValue ?? 0) || 0;
  const mine = config.ratio ? `${(100 * own).toFixed(2)}%` : dcValue(own);
  const digits = rank === 0 || rank === 1 ? 0 : 2;
  const higher = rank > 0.5;
  const pct = `${(100 * (higher ? rank : 1 - rank)).toFixed(digits)}%`;
  const parts: Array<{ text: string; bold?: boolean }> = [
    { text: `您的${config.valueName}为` }, { text: mine, bold: true }, { text: `，${higher ? "高于" : "低于"}` }, { text: pct, bold: true }, { text: "的同类创作者" },
  ];
  if (rank < 0.5) parts.push({ text: `。${DIAGNOSIS_ADVICE[config.valueName]}` });
  return { parts };
}

export interface DashboardCard { key: string; label: string; aliases: string[]; unit: "" | "%" | "s" | "min"; tip?: string }
const AWEME_RENAME: Record<string, string> = {
  play_cnt: "vv", homepage_view_cnt: "profile_uv", digg_cnt: "like", share_count: "share", comment_cnt: "comment",
  net_fans_cnt: "net_follow_fans", cancel_fans_cnt: "unfollow_fans", total_fans_cnt: "fans_all",
};
export const DASHBOARD_CARDS: Record<"aweme" | "mix" | "fans", DashboardCard[]> = {
  aweme: [
    { key: "publish_cnt", label: "投稿量", aliases: ["publish_cnt", "publish_count", "item_cnt", "aweme_cnt"], unit: "" },
    { key: "vv", label: "总播放量", aliases: ["vv"], unit: "", tip: "周期内所有作品的总播放量，包含历史作品，多次观看会重复计算，不含本人观看数据" },
    { key: "like", label: "总点赞量", aliases: ["like"], unit: "" },
    { key: "share", label: "总分享量", aliases: ["share", "share_count", "share_cnt"], unit: "" },
    { key: "comment", label: "总评论量", aliases: ["comment"], unit: "" },
    { key: "completion_rate_5s", label: "5秒完播率", aliases: ["completion_rate_5s", "finish5s"], unit: "%" },
    { key: "bounce_rate_2s", label: "2秒跳出率", aliases: ["bounce_rate_2s", "skip2s"], unit: "%" },
    { key: "cover_click_ratio", label: "封面点击率", aliases: ["cover_click_ratio"], unit: "%", tip: "统计周期内，作品封面的点击量/作品封面的曝光量" },
    { key: "average_play_duration", label: "平均播放时长", aliases: ["average_play_duration", "play_avg_time", "avg_play_time", "avg_view_second"], unit: "s" },
  ],
  mix: [
    { key: "view_count", label: "总播放量", aliases: ["view_count", "play_count", "average_play_count"], unit: "" },
    { key: "like_count", label: "总点赞量", aliases: ["like_count", "average_like_count"], unit: "" },
    { key: "share_count", label: "总分享量", aliases: ["share_count", "average_share_count"], unit: "" },
    { key: "comment_count", label: "总评论量", aliases: ["comment_count", "average_comment_count"], unit: "" },
    { key: "completion_rate", label: "完播率", aliases: ["completion_rate", "average_completion_rate"], unit: "%" },
    { key: "bounce_rate_2s", label: "2秒跳出率", aliases: ["bounce_rate_2s", "average_bounce_rate_2s"], unit: "%" },
    { key: "cover_click_rate", label: "点击率", aliases: ["cover_click_rate"], unit: "%" },
    { key: "average_play_duration", label: "平均播放时长", aliases: ["average_play_duration", "avg_view_second"], unit: "s" },
  ],
  fans: [
    { key: "total_fans_cnt", label: "总粉丝量", aliases: ["total_fans_cnt", "fans_all"], unit: "" },
    { key: "net_fans_cnt", label: "粉丝净增", aliases: ["net_fans_cnt", "net_follow_fans"], unit: "" },
    { key: "new_fans_cnt", label: "吸粉量", aliases: ["increase_fans_cnt", "new_fans_cnt", "follow_fans_cnt"], unit: "" },
    { key: "cancel_fans_cnt", label: "脱粉量", aliases: ["cancel_fans_cnt", "unfollow_fans"], unit: "" },
    { key: "home_view_fans_cnt", label: "回访粉丝量", aliases: ["return_fans_cnt", "revisit_fans_cnt", "home_view_fans_cnt"], unit: "" },
  ],
};
export const DASHBOARD_DEFAULT = { aweme: "vv", mix: "view_count", fans: "net_fans_cnt" } as const;

/** 把 dashboard 响应按官方别名对到卡片上；对不到的卡显示 -。 */
export function dashboardMetrics(tab: "aweme" | "mix" | "fans", payload: Raw | null): Map<string, Raw> {
  const metrics: Raw[] = Array.isArray(payload?.metrics) ? payload!.metrics : [];
  const byName = new Map<string, Raw>();
  for (const metric of metrics) {
    const name = tab === "aweme" ? AWEME_RENAME[metric.english_metric_name] ?? metric.english_metric_name : metric.english_metric_name;
    byName.set(name, metric);
  }
  const result = new Map<string, Raw>();
  for (const card of DASHBOARD_CARDS[tab]) {
    const found = card.aliases.map((alias) => byName.get(alias)).find(Boolean);
    if (found) result.set(card.key, found);
  }
  return result;
}

export function dashboardCardValue(card: DashboardCard, metric: Raw | undefined): string {
  if (!metric) return "-";
  const value = Number(metric.metric_value || 0) * (card.unit === "%" ? 100 : 1);
  return dcValue(value, card.unit);
}

/** 统计周期：近 N 天截至昨天（本地时间），同一天只写一个日期。 */
export function periodText(days: number, now = new Date()): string {
  const day = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const end = day(1);
  const start = day(days);
  return start === end ? end : `${start} 至 ${end}`;
}

/** 直播各分类下的指标 key（官方 Et.webcast），括号里的 metrics_type 用来拉趋势。 */
export const LIVE_TABS: Array<{ id: number; label: string; metrics: Array<{ key: string; type: number; unit: "" | "%" | "min" }> }> = [
  { id: 1, label: "收入", metrics: [{ key: "coin", type: 101, unit: "" }, { key: "gift_uv", type: 102, unit: "" }, { key: "gift_fans_uv", type: 103, unit: "" }] },
  { id: 2, label: "观看", metrics: [{ key: "watch_pv", type: 201, unit: "" }, { key: "watch_uv", type: 202, unit: "" }, { key: "online_uv_max", type: 203, unit: "" }, { key: "watch_fans_uv", type: 204, unit: "" }, { key: "playtime_avg", type: 205, unit: "min" }, { key: "fans_playtime_avg", type: 206, unit: "min" }] },
  { id: 3, label: "互动", metrics: [{ key: "comment_uv", type: 301, unit: "" }, { key: "fans_comment_uv", type: 302, unit: "" }, { key: "like_cnt", type: 303, unit: "" }, { key: "fans_like_cnt", type: 304, unit: "" }] },
  { id: 4, label: "粉丝", metrics: [{ key: "follow_uv", type: 401, unit: "" }, { key: "follow_ratio", type: 402, unit: "%" }] },
  { id: 5, label: "开播", metrics: [{ key: "live_time", type: 501, unit: "min" }, { key: "live_cnt", type: 502, unit: "" }] },
];

/** 账号粉丝画像（fans/summary/v2）的一维：{key,label,count} → 名称 + 百分比。 */
export function fansDistribution(list: unknown, mode: "normalize" | "raw" | "age" = "normalize", names: Record<string, string> = {}): Array<{ name: string; value: number }> {
  if (!Array.isArray(list)) return [];
  let rows = list.map((item: Raw) => ({ name: names[item?.key] ?? (item?.label || item?.key || ""), key: String(item?.key ?? item?.label ?? ""), value: Number(item?.count) }))
    .filter((row) => row.name && Number.isFinite(row.value) && row.value >= 0);
  if (mode === "age") rows = rows.sort((a, b) => parseInt(a.key, 10) - parseInt(b.key, 10));
  if (mode === "raw") return rows.map((row) => ({ name: row.name, value: Math.min(100, row.value) })).sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return total > 0 ? rows.map((row) => ({ name: row.name, value: (row.value / total) * 100 })) : [];
}

// ---------- 作品管理 ----------

const STATUS_LABELS: Record<string, string> = {
  PUBLISHED: "已发布", REVIEWING: "审核中", NOTPASSED: "未通过", SCHEDULE: "定时发布中", NOT_SUITABLE_TO_SHOW: "不适宜公开",
  LIMIT_SHOW_RANGE: "限制分享范围", NOT_RECOMMEND: "不适合继续推荐", PRE_REVIEW_NOT_PASS: "排雷不通过", STAR_REIVEW_PASSED: "广告主确认中",
  STAR_ADVERTISER_REJECTED: "广告主已反馈", STAR_ADVERTISER_NOT_PUBLISHED: "待广告主发布", STAR_SCHEDULE: "广告主定时发布中",
  REVIEWED_RECORDING: "审核通过，备案中", REVIEW_NOT_PASS: "审核未通过", REVIEWED_RECORDED: "审核通过，备案通过", RECORD_NOT_PASS: "备案未通过",
  ACCOUNT_BANNED: "定时发布失败，可在禁言/禁稿解封后重新发布", PRIVATE: "",
};
export const STATUS_TONE: Record<string, "good" | "warn" | "muted" | "info" | "dark"> = {
  PUBLISHED: "good", REVIEWED_RECORDED: "good", REVIEWING: "warn", STAR_REIVEW_PASSED: "warn", STAR_ADVERTISER_NOT_PUBLISHED: "warn", REVIEWED_RECORDING: "warn",
  SCHEDULE: "info", STAR_SCHEDULE: "info", ACCOUNT_BANNED: "dark",
};

function isScheduled(aweme: Raw): boolean {
  return [0, 4, 5].includes(Number(aweme?.timer?.status)) && aweme?.timer?.status !== undefined && aweme?.timer?.status !== null;
}

/** 作品状态（官方模块 6803 的推导顺序）。 */
export function workStatus(aweme: Raw): { key: string; label: string } {
  const value = Number(aweme?.status_value);
  let key: string | null = [102, 140, 143].includes(value) ? "PUBLISHED" : value === 141 ? "REVIEWING" : value === 144 ? "NOTPASSED" : null;
  let extra: Raw = {};
  try { extra = typeof aweme?.extra === "string" ? JSON.parse(aweme.extra) : aweme?.extra ?? {}; } catch { extra = {}; }
  if (extra?.drama_review_status !== undefined) key = ["REVIEWING", "REVIEWED_RECORDING", "REVIEW_NOT_PASS", "REVIEWED_RECORDED", "RECORD_NOT_PASS"][Number(extra.drama_review_status)] ?? key;
  if (key === "NOTPASSED") {
    key = "NOT_SUITABLE_TO_SHOW";
    const star = aweme?.star_atlas_info?.review_status;
    if (star !== undefined) key = ({ 4: "STAR_ADVERTISER_REJECTED", 3: "STAR_REIVEW_PASSED", 6: "STAR_ADVERTISER_NOT_PUBLISHED", 7: "STAR_SCHEDULE" } as Record<number, string>)[Number(star)] ?? key;
    if (aweme?.is_preview === 1) key = "PRE_REVIEW_NOT_PASS";
  }
  if (key === "REVIEWING" && aweme?.status?.reviewed) key = "NOTPASSED";
  if (Number(aweme?.timer?.status) === 4 && aweme?.timer) key = "ACCOUNT_BANNED";
  if (key !== "REVIEWING" && key !== "ACCOUNT_BANNED" && isScheduled(aweme)) key = "SCHEDULE";
  if (Number(aweme?.review_struct?.status) === 3) key = "NOT_RECOMMEND";
  if (Number(aweme?.status?.private_status) === 1) key = "PRIVATE";
  const label = aweme?.review_struct?.status_desc || (key ? STATUS_LABELS[key] ?? "" : "");
  return { key: key ?? "", label };
}

export interface ListMetric { label: string; key: string; kind: "count" | "rate" }
const C = (label: string, key: string): ListMetric => ({ label, key, kind: "count" });
const R = (label: string, key: string): ListMetric => ({ label, key, kind: "rate" });
const BASE = [C("播放", "view_count"), C("点赞", "like_count"), C("评论", "comment_count"), C("分享", "share_count")];

/** 卡片指标套：长文章 / 图文 / ≥3 分钟视频 / 其余短视频。 */
export function listMetricSet(aweme: Raw): ListMetric[] {
  if (Number(aweme?.type) === 8) return [...BASE, R("详情页进入率", "enter_detail_ratio"), R("完播率", "long_article_finish_ratio")];
  if (aweme?.is_pic_word || Number(aweme?.type) === 1) return [...BASE, C("收藏", "favorite_count"), R("划走率", "bounce_rate_2s"), R("文案展开率", "description_spread_rate"), C("平均浏览图片数", "image_avg_view_count"), C("吸粉量", "subscribe_count")];
  if (Number(aweme?.duration ?? aweme?.video?.duration) >= 180000) return [...BASE, C("收藏", "favorite_count"), C("弹幕", "danmaku_count"), R("封面点击率", "cover_click_rate"), R("平均播放占比", "avg_view_proportion"), C("吸粉量", "subscribe_count")];
  return [...BASE, C("收藏", "favorite_count"), R("完播率", "completion_rate"), R("2秒跳出率", "bounce_rate_2s"), C("吸粉量", "subscribe_count")];
}

/** 私密、审核中、未通过这些作品，官方整行指标显示 -。 */
export function listMetricsHidden(aweme: Raw, metrics: Raw | undefined): boolean {
  if (!metrics) return true;
  const review = Number(aweme?.review_struct?.status);
  if (review === 3) return false;
  if (aweme?.status?.is_private) return true;
  if ([1, 2, 4, 6].includes(review)) return true;
  const { label } = workStatus(aweme);
  return Boolean(label) && label !== "已发布" && label !== "审核通过，备案通过";
}

export const WORK_STATUS_FILTER = [{ label: "全部", value: 0 }, { label: "已发布", value: 1 }, { label: "审核中", value: 2 }, { label: "未通过", value: 3 }];
export const WORK_TYPE_FILTER = [
  { label: "1min-视频", value: 2 }, { label: "1-3min视频", value: 3 }, { label: "3-5min视频", value: 4 },
  { label: "5min+视频", value: 5 }, { label: "图文", value: 1 }, { label: "长图文", value: 8 },
];

// ---------- 作品详情 ----------

export type ContentType = "SHORT_VIDEO" | "MID_VIDEO" | "IMAGE_TEXT" | "LONG_ARTICLE";
export function contentType(type: unknown): ContentType {
  const value = Number(type);
  if ([1, 6, 7].includes(value)) return "IMAGE_TEXT";
  if (value === 4 || value === 5) return "MID_VIDEO";
  if (value === 8) return "LONG_ARTICLE";
  return "SHORT_VIDEO";
}

/** 发布时间早于「N 天前那天的 23:59:59.999」。 */
export function olderThanDays(createSeconds: number, days: number, now = new Date()): boolean {
  const edge = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 23, 59, 59, 999).getTime();
  return createSeconds * 1000 < edge;
}

export interface DetailCard { label: string; key: string; kind: DetailKind; counts: Array<1 | 2>; units: Array<1 | 2> }
// counts：1 新增 2 累计；units：2 每小时 1 每天（顺序即默认值）
const NEW_TOTAL: Array<1 | 2> = [1, 2];
const HOUR_DAY: Array<1 | 2> = [2, 1];
const D = (label: string, key: string, kind: DetailKind = "count", counts: Array<1 | 2> = NEW_TOTAL, units: Array<1 | 2> = HOUR_DAY): DetailCard => ({ label, key, kind, counts, units });
const TOTAL_ONLY: Array<1 | 2> = [2];
const DAY_ONLY: Array<1 | 2> = [1];

export const OVERVIEW_TRAFFIC: Record<ContentType, DetailCard[]> = {
  SHORT_VIDEO: [D("播放量", "view_count"), D("点赞量", "like_count"), D("评论量", "comment_count"), D("分享量", "share_count"), D("收藏量", "favorite_count"), D("弹幕量", "danmaku_count", "count", NEW_TOTAL, DAY_ONLY), D("完播率", "completion_rate", "percent", TOTAL_ONLY), D("2s跳出率", "bounce_rate_2s", "percent", TOTAL_ONLY)],
  MID_VIDEO: [D("播放量", "view_count"), D("点赞量", "like_count"), D("评论量", "comment_count"), D("分享量", "share_count"), D("收藏量", "favorite_count"), D("弹幕量", "danmaku_count", "count", NEW_TOTAL, DAY_ONLY), D("封面点击率", "cover_click_rate", "percent", TOTAL_ONLY), D("平均播放占比", "avg_view_proportion", "percent", TOTAL_ONLY)],
  IMAGE_TEXT: [D("播放量", "view_count"), D("点赞量", "like_count"), D("评论量", "comment_count"), D("分享量", "share_count"), D("收藏量", "favorite_count"), D("划走率", "bounce_rate_2s", "percent", TOTAL_ONLY), D("文案展开率", "description_spread_rate", "percent", TOTAL_ONLY), D("平均浏览图片数", "image_avg_view_count", "count", TOTAL_ONLY)],
  LONG_ARTICLE: [D("播放量", "view_count"), D("点赞量", "like_count"), D("评论量", "comment_count"), D("分享量", "share_count"), D("详情页进入率", "enter_detail_ratio", "percent", TOTAL_ONLY), D("完播率", "long_article_finish_ratio", "percent", TOTAL_ONLY)],
};
export const OVERVIEW_FANS: DetailCard[] = [D("涨粉量", "subscribe_count"), D("脱粉量", "unsubscribe_count"), D("粉丝播放占比", "fan_view_proportion", "percent", TOTAL_ONLY, DAY_ONLY)];
export const OVERVIEW_TIPS: Record<ContentType, string[]> = {
  SHORT_VIDEO: ["播放量：作品被观看的次数，不含本人观看", "弹幕量：视频互动弹幕量，数据每天12点更新", "完播率：完整看完视频的用户数量÷看过视频的用户总人数，包含本人观看，越高说明作品越吸引观众", "2s跳出率：观看不满2s的播放量/总播放量，包含本人观看，越高说明作品前两秒越不吸引观众", "5s完播率：观看超过5s的播放量/总播放量，包含本人观看，越高说明作品前五秒越吸引观众"],
  MID_VIDEO: ["播放量：作品被观看的次数，不含本人观看", "弹幕量：视频互动弹幕量，数据每天12点更新", "平均播放占比：视频被播放的平均时长/视频总时长，越高说明作品被播放时长越长"],
  IMAGE_TEXT: ["播放量：作品被观看的次数，不含本人观看", "文案展开率：图文详情页被展开的次数/作品播放量，越高说明文案被展开越多"],
  LONG_ARTICLE: ["播放量：作品被观看的次数，不含本人观看", "完播率：完整播完的播放量/总播放量,包含本人观看,越高说明作品越吸引观众", "详情页进入率：点击查看全文btn进入长图文详情页的次数/播放量,详情页进入率越高说明长图文越吸引观众"],
};

const S = (label: string, key: string, kind: DetailKind = "percent") => ({ label, key, kind });
export const ATTRACTION: Record<ContentType, Array<{ label: string; key: string; kind: DetailKind }>> = {
  SHORT_VIDEO: [S("完播率", "completion_rate"), S("平均播放时长", "avg_view_second", "time"), S("2s跳出率", "bounce_rate_2s"), S("5s完播率", "completion_rate_5s"), S("平均播放占比", "avg_view_proportion")],
  MID_VIDEO: [S("封面点击率", "cover_click_rate"), S("平均播放时长", "avg_view_second", "time"), S("完播率", "completion_rate"), S("2s跳出率", "bounce_rate_2s"), S("平均播放占比", "avg_view_proportion"), S("5s完播率", "completion_rate_5s")],
  IMAGE_TEXT: [S("封面点击率", "cover_click_rate"), S("文案展开率", "description_spread_rate"), S("划走率", "bounce_rate_2s"), S("平均浏览图片数", "image_avg_view_count", "count"), S("文案完读率", "description_completion_rate"), S("评论进入率", "comment_entry_rate")],
  LONG_ARTICLE: [S("完播率", "long_article_finish_ratio"), S("封面点击率", "cover_click_rate"), S("划走率", "bounce_rate_2s"), S("详情页进入率", "enter_detail_ratio"), S("评论进入率", "comment_entry_rate")],
};
export const ENGAGEMENT: Record<ContentType, Array<{ label: string; key: string; kind: DetailKind }>> = {
  SHORT_VIDEO: [S("点赞率", "like_rate"), S("评论率", "comment_rate"), S("分享率", "share_rate"), S("收藏率", "favorite_rate"), S("弹幕量", "danmaku_count", "count"), S("不感兴趣率", "dislike_rate")],
  MID_VIDEO: [S("点赞率", "like_rate"), S("评论率", "comment_rate"), S("分享率", "share_rate"), S("收藏率", "favorite_rate"), S("弹幕量", "danmaku_count", "count"), S("不感兴趣率", "dislike_rate")],
  IMAGE_TEXT: [S("点赞率", "like_rate"), S("评论率", "comment_rate"), S("下载量", "download_count", "count"), S("收藏率", "favorite_rate"), S("分享率", "share_rate"), S("不感兴趣率", "dislike_rate")],
  LONG_ARTICLE: [S("点赞率", "like_rate"), S("评论率", "comment_rate"), S("分享率", "share_rate"), S("收藏率", "favorite_rate"), S("不感兴趣率", "dislike_rate")],
};
export const AUDIENCE_CARDS: DetailCard[] = [
  D("涨粉量", "subscribe_count", "count", [2, 1], [1, 2]), D("涨粉率", "subscribe_rate", "percent", [2, 1], [1, 2]),
  D("脱粉量", "unsubscribe_count", "count", [2, 1], [1, 2]), D("脱粉率", "unsubscribe_rate", "percent", [2, 1], [1, 2]),
  D("不感兴趣量", "dislike_count", "count", [2], [1, 2]), D("不感兴趣率", "dislike_rate", "percent", [2], [1, 2]),
];

export const PLAY_SOURCE_NAMES: Record<string, string> = {
  homepage_hot: "推荐页", search: "搜索", homepage: "个人主页", fresh: "同城页", familiar: "朋友页", follow: "关注页",
  message: "消息页", compilation: "合集", order: "电商", other: "其他", yumme_vv_all: "精选App",
};
const sourcePercent = (value: number) => (value ? round(value * 100, 1) : 0);

/** 流量来源：抖音 / 其他 App 两组，过滤极小值、合并主页播放、按占比排序、映射中文（映射表里没有的丢掉，和官方一样）。 */
export function playSources(list: unknown): { douyin: Array<{ name: string; value: number; percent: number; diff: number }>; other: Array<{ name: string; value: number; percent: number; diff: number }> } {
  const rows: Raw[] = Array.isArray(list) ? list : [];
  const group = (items: Raw[]) => {
    const kept: Raw[] = items.filter((item) => Number(item.value) >= 0.0005).map((item) => ({ ...item, value: Number(item.value), history_difference: Number(item.history_difference) || 0 }));
    const self = kept.find((item) => item.key === "self_profile_vv_all");
    const others = kept.find((item) => item.key === "other_profile_vv_all");
    const rest = kept.filter((item) => item !== self && item !== others);
    if (self && others) rest.push({ ...self, value: self.value + others.value });
    else if (self || others) rest.push({ ...(self ?? others)!, key: "self_profile_vv_all" });
    return rest.sort((a, b) => b.value - a.value)
      .filter((item) => PLAY_SOURCE_NAMES[item.key])
      .map((item) => {
        const diff = Math.abs(item.history_difference) < 0.001 ? 0 : item.history_difference;
        return { name: PLAY_SOURCE_NAMES[item.key]!, value: item.value, percent: sourcePercent(item.value), diff: sourcePercent(diff) };
      });
  };
  return { douyin: group(rows.filter((item) => Number(item.app_id) === 1128)), other: group(rows.filter((item) => Number(item.app_id) !== 1128)) };
}

export const GENDER_NAMES: Record<string, string> = { male: "男性", female: "女性" };
export const ACTIVE_NAMES: Record<string, string> = { "4": "重度", "3": "中度", "2": "轻度", "1": "低活", "-1": "未知" };

export const COMMENT_TYPES = [{ label: "全部评论", value: "0" }, { label: "未回复", value: "not_replied" }, { label: "包含问题", value: "question" }, { label: "可能打扰", value: "disturb" }];
export const COMMENT_CROWDS = [{ label: "全部人群", value: "0" }, { label: "互关朋友", value: "friend" }, { label: "我的关注", value: "following" }, { label: "我的粉丝", value: "fans" }];
export const COMMENT_SORTS = [{ label: "最新发布", value: "TIME", option: 0 }, { label: "最早发布", value: "EARLIEST", option: 1 }, { label: "最多点赞", value: "HOT", option: 2 }];

export function commentSelectOptions(type: string, crowd: string): string {
  return type === crowd ? String(type) : `${crowd},${type}`;
}

export interface CreatorComment {
  id: string; avatar: string | null; name: string; isAuthor: boolean; createTime: number; replyTo: string | null;
  text: string; folded: boolean; images: string[]; likes: string; replyCount: number; replies: CreatorComment[];
}

const lastUrl = (value: Raw | undefined) => {
  const list = Array.isArray(value?.url_list) ? value!.url_list.filter(Boolean) : [];
  return list.length ? String(list[list.length - 1]) : null;
};

/** 网页版评论接口的一条 → 页面要显示的字段（官方 Uy）；老接口已经是转换后的样子，两种都认。 */
export function normalizeComment(raw: Raw): CreatorComment {
  const user = raw.user ?? {};
  const info = raw.user_info ?? {};
  const replies = Array.isArray(raw.reply_comment) ? raw.reply_comment : Array.isArray(raw.reply_list) ? raw.reply_list : [];
  const images = Array.isArray(raw.image_list) ? raw.image_list.map((image: Raw) => lastUrl(image?.origin_url) ?? lastUrl(image?.medium_url) ?? lastUrl(image?.thumb_url) ?? lastUrl(image)).filter((url: string | null): url is string => Boolean(url)) : [];
  return {
    id: String(raw.cid ?? raw.comment_id ?? ""),
    avatar: lastUrl(user.avatar_thumb) ?? info.avatar_url ?? null,
    name: String(user.nickname ?? info.screen_name ?? "") || "抖音用户",
    isAuthor: raw.label_type === 1 || raw.label_text === "作者" || Boolean(raw.is_author),
    createTime: Number(raw.create_time) || 0,
    replyTo: raw.reply_to_username || raw.reply_to_user_info?.screen_name || null,
    text: String(raw.text ?? ""),
    folded: Boolean(raw.user_buried ?? raw.user_bury),
    images,
    likes: shortCount(raw.digg_count ?? 0),
    replyCount: Number(raw.reply_comment_total ?? raw.comment_reply_total ?? raw.reply_count ?? 0) || 0,
    replies: replies.map(normalizeComment),
  };
}
