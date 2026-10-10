// 抖音指数（创作者平台 creator_count，前身是巨量算数）：热点榜和达人详情的解析与展示格式。
// 字段规则来自登录态下对官方页面的实抓（热点榜 10-07、达人详情 10-10；接口见 collector/creatorCenter.mjs）。

type Raw = Record<string, any> | null | undefined;

export function shiftDay(day: string, days: number): string {
  const year = Number(day.slice(0, 4)), month = Number(day.slice(4, 6)), date = Number(day.slice(6, 8));
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return `${moved.getUTCFullYear()}${String(moved.getUTCMonth() + 1).padStart(2, "0")}${String(moved.getUTCDate()).padStart(2, "0")}`;
}

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{8}$/u.test(value);
const number = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
/** 业务错误放在 BaseResp.StatusCode 里，HTTP 仍是 200 */
export const indexOk = (data: Raw): boolean => Boolean(data) && Number(data?.BaseResp?.StatusCode ?? 0) === 0;

/** 官方页面的数字习惯：≥1 万显示成「494.0 万」 */
export function formatIndex(value: number): string {
  return Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(Math.round(value));
}
export function formatChange(value: number | null): string {
  if (value === null) return "—";
  const percent = value * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(Math.abs(percent) >= 100 ? 0 : 1)}%`;
}
export function formatShare(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}
/** 20261006 → 10/06 */
export function shortDay(day: string): string {
  return `${day.slice(4, 6)}/${day.slice(6, 8)}`;
}


export interface HotTopic {
  rank: number; name: string;
  /** 热点指数（官方页面显示成「1210.2 万」） */
  index: number;
  /** 排名相对上一轮：1 上升、-1 下降、0 持平 */
  trend: -1 | 0 | 1;
  category: string;
}
export interface HotTopics { current: HotTopic[]; rocketing: HotTopic[] }

const parseTopics = (list: unknown): HotTopic[] => (Array.isArray(list) ? list : []).flatMap((entry: Raw): HotTopic[] => {
  const name = typeof entry?.topic_name === "string" ? entry.topic_name.trim() : "";
  if (!name) return [];
  const flag = number(entry?.rank_flag);
  return [{ rank: number(entry?.rank), name, index: number(entry?.topic_index), trend: flag > 0 ? 1 : flag < 0 ? -1 : 0, category: typeof entry?.category === "string" ? entry.category : "" }];
}).sort((a, b) => a.rank - b.rank);

/** 抖音指数首页的「抖音实时热点」(current) 和「抖音飙升热点」(rocketing)；两个榜都是空的当没读到 */
export function parseHotTopics(data: Raw): HotTopics | null {
  if (!indexOk(data)) return null;
  const topics = { current: parseTopics(data?.current), rocketing: parseTopics(data?.rocketing) };
  return topics.current.length || topics.rocketing.length ? topics : null;
}

// ——— 达人详情（抖音指数里搜达人 → 达人详情页的作者分析 / 作品分析 / 粉丝分析）———
// 达人接口的业务数据和 BaseResp 都包在 data 里：{ data: {..., BaseResp}, msg, status }

const darenData = (raw: Raw): Raw => raw && Number(raw.status ?? 0) === 0 && indexOk(raw.data) ? raw.data : null;
const rate = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** 达人库的最新数据日（一般是 T-2） */
export function parseDarenDay(raw: Raw): string | null {
  const data = darenData(raw);
  return isDay(data?.datetime) ? data!.datetime : null;
}

/**
 * 在达人搜索结果里找到主页上这个人：先按主页链接里的 sec_uid 对号，对不上再比抖音号。
 * 返回达人库自己的 user_id（一串字母编码，不是抖音 uid）；找不到说明这个人没进达人库。
 */
export function pickDaren(raw: Raw, user: { id: string; handle: string }): string | null {
  const data = darenData(raw);
  const list: Raw[] = Array.isArray(data?.userlist) ? data!.userlist : [];
  const handle = user.handle.trim().toLowerCase();
  const hit = list.find((row) => typeof row?.aweme_url === "string" && row.aweme_url.split("?")[0]!.endsWith(`/user/${user.id}`))
    ?? (handle ? list.find((row) => String(row?.aweme_id ?? "").toLowerCase() === handle) : undefined);
  return typeof hit?.user_id === "string" && /^[a-z0-9]+$/u.test(hit.user_id) ? hit.user_id : null;
}

export const DAREN_PERIODS = [{ key: "day", label: "昨日" }, { key: "week", label: "近 7 天" }, { key: "half_month", label: "近 15 天" }, { key: "month", label: "近 30 天" }] as const;
export const DAREN_METRICS = [{ key: "like", label: "新增点赞量" }, { key: "fans", label: "净增粉丝量" }, { key: "share", label: "新增分享量" }, { key: "comment", label: "新增评论量" }, { key: "item", label: "新增作品量" }] as const;
export const WORK_METRICS = [{ key: "like", label: "篇均点赞量" }, { key: "fans", label: "篇均涨粉量" }, { key: "share", label: "篇均分享量" }, { key: "comment", label: "篇均评论量" }] as const;
export type DarenPeriod = typeof DAREN_PERIODS[number]["key"];
export type DarenMetric = typeof DAREN_METRICS[number]["key"];
export type WorkMetric = typeof WORK_METRICS[number]["key"];
/** change 是比上一个等长区间的涨跌（小数），官方没给是 null */
export interface DarenStat { value: number; change: number | null }

export interface DarenDetail {
  id: string; name: string; tags: string[];
  fans: number; likes: number; works: number;
  /** 涨粉里程碑：「10万粉」哪天达成，按粉丝数排 */
  milestones: Array<{ label: string; day: string }>;
  stats: Record<DarenPeriod, Record<DarenMetric, DarenStat>>;
  /** 最近 31 天逐日（含首尾），日期升序 */
  daily: { days: string[] } & Record<DarenMetric, number[]>;
}

/** 达人基本信息 + 作者分析（核心指标和逐日趋势）。两样缺一样就算没读到 */
export function parseDaren(infoRaw: Raw, trendRaw: Raw, span = 31): DarenDetail | null {
  const info = darenData(infoRaw), trend = darenData(trendRaw);
  if (!info || !trend || typeof info.user_id !== "string") return null;
  const series = (key: DarenMetric) => new Map((Array.isArray(trend[`${key}listday`]) ? trend[`${key}listday`] : [])
    .filter((point: Raw) => isDay(point?.date)).map((point: Raw) => [point!.date as string, number(point!.count)]));
  const lines = Object.fromEntries(DAREN_METRICS.map(({ key }) => [key, series(key)])) as Record<DarenMetric, Map<string, number>>;
  const days = [...lines.like.keys()].sort().slice(-span);
  if (!days.length) return null;
  const stats = Object.fromEntries(DAREN_PERIODS.map(({ key: period }) => [period, Object.fromEntries(DAREN_METRICS.map(({ key }) => {
    const block = trend[`${key}_info`];
    return [key, { value: number(block?.[`new_${key}_count_by_${period}`]), change: rate(block?.[`exchange_by_${period}`]) }];
  }))])) as DarenDetail["stats"];
  const milestones = Object.entries(info.fans_milestone ?? {}).flatMap(([key, day]) => {
    const match = /^first_(\d+)w_fans_date$/u.exec(key);
    return match && isDay(day) ? [{ count: Number(match[1]), label: `${match[1]}万粉`, day }] : [];
  }).sort((a, b) => a.count - b.count).map(({ label, day }) => ({ label, day }));
  return {
    id: info.user_id, name: String(info.user_name ?? ""),
    tags: [info.first_tag_name, info.second_tag_name].filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())),
    fans: number(info.fans_count), likes: number(info.like_count), works: number(info.item_count),
    milestones, stats,
    daily: { days, ...Object.fromEntries(DAREN_METRICS.map(({ key }) => [key, days.map((day) => lines[key].get(day) ?? 0)])) } as DarenDetail["daily"],
  };
}

export type WorkAverages = Record<"week" | "month", Record<WorkMetric, DarenStat>>;

/** 作品分析的「篇均」：近 7 天 / 近 30 天每条作品平均带来多少 */
export function parseWorkAverages(raw: Raw): WorkAverages | null {
  const data = darenData(raw);
  if (!data) return null;
  const block = (key: WorkMetric) => (Array.isArray(data[`${key}_info`]) ? data[`${key}_info`][0] : data[`${key}_info`]) as Raw;
  if (!WORK_METRICS.some(({ key }) => block(key))) return null;
  const period = (span: "week" | "month") => Object.fromEntries(WORK_METRICS.map(({ key }) => [key, {
    value: number(block(key)?.[`${key}_average_count_by_${span}`]), change: rate(block(key)?.[`exchange_by_${span}`]),
  }])) as Record<WorkMetric, DarenStat>;
  return { week: period("week"), month: period("month") };
}

export const TOP_VIDEO_ORDERS = [
  { key: "create_time_list", label: "最新发布" }, { key: "like_list", label: "点赞最多" }, { key: "comment_list", label: "评论最多" },
  { key: "share_list", label: "分享最多" }, { key: "follow_list", label: "涨粉最多" },
] as const;
export type TopVideoOrder = typeof TOP_VIDEO_ORDERS[number]["key"];
export interface DarenVideo { id: string; title: string; cover: string | null; day: string | null; likes: number; comments: number; shares: number; follows: number }

/** 时间窗口内的作品，官方按几种口径各排好一份（每份最多 20 条）。全空当没读到 */
export function parseTopVideos(raw: Raw): Record<TopVideoOrder, DarenVideo[]> | null {
  const data = darenData(raw);
  if (!data) return null;
  const lists = Object.fromEntries(TOP_VIDEO_ORDERS.map(({ key }) => [key, (Array.isArray(data[key]) ? data[key] : []).flatMap((row: Raw): DarenVideo[] => {
    const id = String(row?.item_id ?? "");
    if (!/^\d{15,30}$/u.test(id)) return [];
    return [{
      id, title: String(row?.video_text ?? "").trim(), cover: typeof row?.picture === "string" && row.picture.startsWith("https://") ? row.picture : null,
      day: isDay(row?.create_time) ? row!.create_time : null,
      // 官方字段名就拼成 coment_cnt
      likes: number(row?.like_cnt), comments: number(row?.coment_cnt ?? row?.comment_cnt), shares: number(row?.share_cnt), follows: number(row?.follow_cnt),
    }];
  })])) as Record<TopVideoOrder, DarenVideo[]>;
  return Object.values(lists).some((list) => list.length) ? lists : null;
}

export interface FanRow { label: string; /** 占比 0–1 */ share: number; /** 偏好度，100 是平均水平 */ tgi: number | null }
export interface FanGroup { key: string; title: string; rows: FanRow[] }

const FAN_GROUPS: Array<{ key: string; title: string; limit?: number; order?: "label" }> = [
  { key: "Gender", title: "性别" }, { key: "Age", title: "年龄", order: "label" }, { key: "Province", title: "省份", limit: 10 },
  { key: "CityLabel", title: "城市级别" }, { key: "DeviceBrand", title: "手机品牌", limit: 8 }, { key: "DevicePrice", title: "手机价格", order: "label" },
  { key: "FirstTag", title: "兴趣", limit: 8 },
];
const FAN_LABELS: Record<string, string> = { male: "男", female: "女", "50-": "50 以上" };
const pairs = (text: unknown): Array<{ name: string; value: number }> => {
  try {
    const list = typeof text === "string" ? JSON.parse(text) : text;
    return (Array.isArray(list) ? list : []).filter((item) => typeof item?.name === "string" && Number.isFinite(Number(item?.value))).map((item) => ({ name: item.name, value: Number(item.value) }));
  } catch { return []; }
};
const leadingNumber = (label: string) => Number(/\d+/u.exec(label)?.[0] ?? Infinity);

/** 粉丝画像：各维度的占比和 TGI（官方两份数组分开给，按名字对上）。「未分类」那几项不是兴趣，去掉 */
export function parseFans(raw: Raw): FanGroup[] | null {
  const data = darenData(raw);
  if (!data) return null;
  const groups = FAN_GROUPS.flatMap(({ key, title, limit, order }): FanGroup[] => {
    const tgi = new Map(pairs(data[`${key}_Tgi`]).map((item) => [item.name, item.value]));
    let rows = pairs(data[key]).filter((item) => !item.name.startsWith("未分类")).map((item) => ({ label: FAN_LABELS[item.name] ?? item.name, share: item.value, tgi: tgi.get(item.name) ?? null }));
    rows = order === "label" ? rows.sort((a, b) => leadingNumber(a.label) - leadingNumber(b.label)) : rows.sort((a, b) => b.share - a.share);
    rows = rows.slice(0, limit ?? rows.length);
    return rows.length ? [{ key, title, rows }] : [];
  });
  return groups.length ? groups : null;
}

/** 去创作者平台看这个达人的完整详情页 */
export function darenPageUrl(id: string): string {
  return `https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/daren/detail?uid=${encodeURIComponent(id)}`;
}
