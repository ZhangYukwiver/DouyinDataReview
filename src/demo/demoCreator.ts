// 在线体验版的创作者中心：按 key 回合成的、和抖音创作者平台同形状的 JSON（/v1/creator/read）。
// 虚构一个做家常菜 / 一人食短视频的小创作者「示例账号」：固定种子，日期都相对现在算，每天打开都有「近 7 天」。
// 每条作品的播放按「发布后逐日衰减 + 长尾」一条曲线累积，数据看板、作品卡片、作品详情趋势、粉丝数都从这条曲线算，彼此对得上。
// 作品封面、账号头像用 demoArt 现画的 SVG，其他头像留空；作品 id 用 99 开头（抖音现有作品 id 是 7 开头），不会撞上真作品。
import type { CreatorKey, CreatorQuery } from "../services/creatorCenter";
import { ACCOUNT_AVATAR, cover } from "./demoArt";

type Raw = Record<string, any>;
type Params = Record<string, string | number>;
type Result = { ok: true; data: Raw } | { ok: false; reason: "failed" };

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NICK = "示例账号";
const UID = "990000000000001";

function makeRandom(seed: number) {
  let state = seed % 2147483647 || 1;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}
function seedOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 2147483646) + 1;
}
const randomFor = (text: string) => makeRandom(seedOf(text));
const pickOf = <T,>(rnd: () => number, list: readonly T[]) => list[Math.floor(rnd() * list.length)] as T;
const span = (rnd: () => number, min: number, max: number) => min + rnd() * (max - min);
const pad = (value: number) => String(value).padStart(2, "0");
const fixed = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const dayText = (ms: number, sep = "") => { const d = new Date(ms); return `${d.getFullYear()}${sep}${pad(d.getMonth() + 1)}${sep}${pad(d.getDate())}`; };
const clock = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(Math.round(seconds) % 60)}`;
/** 本地时间 n 天前的零点（n 为负就是往后） */
const midnight = (ms: number, daysAgo = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime(); };
/** 把一组占比按名字写成 [{key,label,count}]，粉丝画像的几项都这么给 */
const shares = (rows: Array<[string, number]>, total = 1) => rows.map(([key, value]) => ({ key, label: key, count: fixed(value * total, 2) }));

// ---------- 作品 ----------

const DISHES = ["番茄牛腩", "葱油拌面", "酸汤肥牛", "土豆炖排骨", "蒜蓉粉丝蒸虾", "青椒肉丝", "麻婆豆腐", "红烧茄子", "鸡蛋灌饼", "皮蛋瘦肉粥", "冬瓜丸子汤", "香煎鸡腿排",
  "手撕包菜", "番茄鸡蛋面", "糖醋里脊", "蛋包饭", "咖喱鸡肉饭", "酸辣土豆丝", "黄焖鸡", "小炒黄牛肉", "豆角焖面", "腊肠煲仔饭", "香菇滑鸡", "萝卜炖羊肉", "凉拌黄瓜", "炸酱面",
  "蜜汁叉烧", "蒸水蛋", "南瓜小米粥", "韭菜盒子", "酸菜鱼", "宫保鸡丁", "肉末茄子", "鲜虾馄饨", "芋泥西米露", "生煎包", "卤牛肉", "可乐鸡翅"];
const HOOKS = ["酱汁比例写在最后", "新手也不会翻车", "一口锅就够了", "比外卖香多了", "十块钱吃两顿", "关键是这一步", "冰箱剩菜也能做", "下饭到停不下来", "提前一晚备好料",
  "火候一次讲清楚", "第一次做就成功", "这周已经做了三次"];
const TAGS = ["一人食", "快手菜", "下饭菜", "家常菜", "打工人的晚饭", "美食教程"];
const MIXES = [{ id: "9900000000000101", name: "一人食" }, { id: "9900000000000102", name: "周末小厨房" }];

type Kind = 1 | 2 | 3 | 4; // 作品管理的体裁：1 图文、2 一分钟内、3 一到三分钟、4 三到五分钟
interface Work {
  index: number; id: string; title: string; dish: string; type: Kind; duration: number; pictures: number; publish: number;
  state: "ok" | "reviewing" | "private" | "rejected"; pinned: boolean; mix: string | null; quality: boolean; douPlus: number;
  /** 这条作品最终会有的播放量；当前播放 = potential × reach(发布至今) */
  potential: number; perView: Record<string, number>; level: Record<string, number>;
}

/** 发布后经过 age 毫秒，最终播放量走完了多少：头几天衰减很快，外加两个月的长尾 */
const reach = (age: number) => (age <= 0 ? 0 : 0.88 * (1 - Math.pow(0.6, age / DAY)) + 0.12 * (1 - Math.exp(-age / (70 * DAY))));

function buildWorks(now: number): Work[] {
  const rnd = makeRandom(20261113);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const works: Work[] = [];
  let daysAgo = 1;
  for (let index = 0; index < 118; index += 1) {
    const type: Kind = index % 11 === 6 ? 1 : index % 13 === 9 ? 4 : rnd() < 0.3 ? 3 : 2;
    const dish = DISHES[(index * 11 + 5) % DISHES.length]!; // 隔开轮换，相邻几条不撞菜
    const hook = pickOf(rnd, HOOKS);
    const template = Math.floor(rnd() * 5);
    const title = type === 1 ? (rnd() < 0.5 ? `${dish}的做法整理好了，收藏慢慢看 #美食教程` : `这周晚饭吃了什么｜${dish}和另外六道 #一周晚饭`)
      : type === 4 ? `完整版｜${dish}从备菜到出锅，${hook} #家常菜`
        : [`${dish}，${hook} #${pickOf(rnd, TAGS)}`, `下班四十分钟，${dish}上桌 #打工人的晚饭`, `一人食｜${dish} #一人食`, `周末在家做${dish}，${hook} #周末做饭`, `${dish}这样做，${hook} #家常菜`][template]!;
    // 第一条是三小时前刚发、还在审核；之后每 2–4 天一条，中午或晚上发
    const publish = index === 0 ? now - 3 * HOUR : midnight(now, daysAgo) + (rnd() < 0.4 ? span(rnd, 11.5, 13) : span(rnd, 17.5, 21.5)) * HOUR;
    if (index > 0) daysAgo += 2 + Math.floor(rnd() * 3);
    const age = (now - publish) / DAY;
    const state = index === 0 ? "reviewing" : index === 8 ? "private" : index === 23 ? "rejected" : "ok";
    const hit = index === 4 ? 9 : index === 17 ? 14 : index === 52 ? 6 : 1;
    const potential = state !== "ok" ? 0 : Math.round(24000 * (0.35 + 0.65 * Math.exp(-age / 200)) * Math.exp(gauss() * 0.7) * hit * (type === 1 ? 0.5 : type === 4 ? 0.7 : 1));
    const video = type !== 1;
    const duration = type === 2 ? span(rnd, 18, 59) * 1000 : type === 3 ? span(rnd, 65, 170) * 1000 : type === 4 ? span(rnd, 185, 290) * 1000 : 0;
    const pictures = video ? 0 : 3 + Math.floor(rnd() * 7);
    const finish = type === 2 ? span(rnd, 0.26, 0.42) : type === 3 ? span(rnd, 0.12, 0.22) : span(rnd, 0.06, 0.12);
    const proportion = type === 2 ? span(rnd, 0.45, 0.62) : type === 3 ? span(rnd, 0.3, 0.45) : span(rnd, 0.22, 0.35);
    const subscribe = span(rnd, 0.0025, 0.005) * (hit > 1 ? 1.4 : 1);
    const perView: Record<string, number> = {
      like_count: span(rnd, 0.03, 0.055) * (hit > 1 ? 1.2 : 1), comment_count: span(rnd, 0.003, 0.007), share_count: span(rnd, 0.004, 0.012),
      favorite_count: span(rnd, 0.012, 0.035), danmaku_count: video ? span(rnd, 0.0003, 0.0009) : 0, subscribe_count: subscribe,
      unsubscribe_count: subscribe * span(rnd, 0.03, 0.07), dislike_count: span(rnd, 0.001, 0.003), ...(video ? {} : { download_count: span(rnd, 0.002, 0.006) }),
    };
    const level: Record<string, number> = video ? {
      completion_rate: finish, completion_rate_5s: span(rnd, 0.5, 0.7), bounce_rate_2s: span(rnd, 0.18, 0.3), cover_click_rate: span(rnd, 0.05, 0.11),
      avg_view_proportion: proportion, avg_view_second: (duration / 1000) * proportion, fan_view_proportion: span(rnd, 0.09, 0.2),
    } : {
      bounce_rate_2s: span(rnd, 0.3, 0.45), cover_click_rate: span(rnd, 0.05, 0.11), fan_view_proportion: span(rnd, 0.09, 0.2),
      description_spread_rate: span(rnd, 0.06, 0.13), image_avg_view_count: Math.min(pictures, span(rnd, 2.6, 5.2)), description_completion_rate: span(rnd, 0.35, 0.6),
      comment_entry_rate: span(rnd, 0.04, 0.08),
    };
    works.push({
      index, id: `9920261113${String(104729 + index * 7919).padStart(9, "0")}`, title, dish, type, duration: Math.round(duration), pictures, publish, state,
      pinned: index === 4 || index === 17, mix: template === 2 && video ? MIXES[0]!.id : template === 3 && video ? MIXES[1]!.id : null,
      quality: index === 4, douPlus: index === 4 ? 5200 : 0, potential, perView, level,
    });
  }
  return works;
}

/** 某个时刻这条作品的全部指标（作品卡片、作品详情、对比都读这一份） */
function metricsAt(work: Work, at: number): Raw {
  const views = work.potential * reach(at - work.publish);
  const metrics: Raw = { view_count: Math.round(views) };
  for (const [key, rate] of Object.entries(work.perView)) metrics[key] = Math.round(views * rate);
  for (const [key, value] of Object.entries(work.level)) metrics[key] = fixed(value, key === "avg_view_second" || key === "image_avg_view_count" ? 2 : 4);
  const rate = (key: string) => (metrics.view_count ? fixed(metrics[key] / metrics.view_count, 6) : 0);
  for (const key of ["like", "comment", "share", "favorite", "dislike", "subscribe", "unsubscribe"]) metrics[`${key}_rate`] = rate(`${key}_count`);
  return metrics;
}

/** [from, to) 这段时间里一批作品的增量：播放、各项计数之和，比率按播放加权 */
function aggregate(works: Work[], from: number, to: number, now: number): Raw {
  const out: Raw = { view_count: 0, publish_cnt: 0 };
  const weights: Record<string, number> = {};
  const end = Math.min(to, now);
  for (const work of works) {
    if (work.state === "ok" && work.publish >= from && work.publish < to) out.publish_cnt += 1;
    const views = end > from ? work.potential * Math.max(0, reach(end - work.publish) - reach(from - work.publish)) : 0;
    if (!views) continue;
    out.view_count += views;
    for (const [key, rate] of Object.entries(work.perView)) out[key] = (out[key] ?? 0) + views * rate;
    for (const [key, value] of Object.entries(work.level)) { out[key] = (out[key] ?? 0) + views * value; weights[key] = (weights[key] ?? 0) + views; }
  }
  for (const key of Object.keys(out)) out[key] = key in weights ? fixed(out[key] / weights[key]!) : Math.round(out[key]);
  return out;
}

// ---------- 整个账号（第一次被问到时按当时的时间生成一次） ----------

interface FansDay { day: number; increase: number; cancel: number; net: number; total: number; revisit: number }
interface World { now: number; works: Work[]; byId: Map<string, Work>; fans: FansDay[]; followers: number; likes: number }
let cached: World | null = null;

function world(): World {
  if (cached) return cached;
  const now = Date.now();
  const works = buildWorks(now);
  const first = midnight(Math.min(...works.map((work) => work.publish)));
  // 粉丝逐日：作品带来的关注 + 主页零散关注，减去作品带来的取关和日常流失
  const fans: FansDay[] = [];
  let total = 600;
  for (let day = first; day <= now; day = midnight(day, -1)) {
    const rnd = randomFor(`fans${dayText(day)}`);
    const delta = aggregate(works, day, midnight(day, -1), now);
    const increase = Math.round(Number(delta.subscribe_count ?? 0) + span(rnd, 2, 7));
    const cancel = Math.round(Number(delta.unsubscribe_count ?? 0) + total * span(rnd, 0.0003, 0.0007));
    total += increase - cancel;
    fans.push({ day, increase, cancel, net: increase - cancel, total, revisit: Math.round(total * span(rnd, 0.025, 0.04)) });
  }
  const likes = works.reduce((sum, work) => sum + Number(metricsAt(work, now).like_count), 0);
  cached = { now, works, byId: new Map(works.map((work) => [work.id, work])), fans, followers: total, likes };
  return cached;
}

/** 近 N 天（截至昨天）每天的零点，最早的在前 */
const recentDays = (now: number, days: number) => Array.from({ length: days }, (_, index) => midnight(now, days - index));

// ---------- 数据中心 ----------

const DIAGNOSIS_RANKS = { PlayCnt: 0.71, Interact: 0.63, PlayFinishRatio: 0.44, PublishActivation: 0.58, NewFans: 0.68 };

function diagnosis(): Raw {
  const { now, works, fans } = world();
  const week = aggregate(works, midnight(now, 7), midnight(now), now);
  const interact = (Number(week.like_count) + Number(week.comment_count) + Number(week.share_count)) / (Number(week.view_count) || 1);
  const newFans = fans.filter((day) => day.day >= midnight(now, 7) && day.day < midnight(now)).reduce((sum, day) => sum + day.net, 0);
  const finish = Number(week.completion_rate ?? 0);
  const entry = (key: keyof typeof DIAGNOSIS_RANKS, own: number, similar: number) => ({ OwnValue: own, SimilarValue: similar, AuthorRank: DIAGNOSIS_RANKS[key] });
  return { code: 0, data: {
    PlayCnt: entry("PlayCnt", week.view_count, Math.round(week.view_count * 0.72)), Interact: entry("Interact", fixed(interact, 6), fixed(interact * 0.86, 6)),
    PlayFinishRatio: entry("PlayFinishRatio", finish, fixed(finish * 1.08)), PublishActivation: entry("PublishActivation", week.publish_cnt, 2),
    NewFans: entry("NewFans", newFans, Math.round(newFans * 0.8)),
  } };
}

/** 数据总览右边的「贡献 TOP3」：近 7 天里各维度最高的三条（1 播放、2 互动、3 完播率、5 涨粉） */
function contributionTop(params: Params): Raw {
  const { now, works } = world();
  const dimension = Number(params.dimension);
  const rows = works.filter((work) => work.state === "ok" && work.type !== 1).map((work) => {
    const week = aggregate([work], midnight(now, 7), midnight(now), now);
    const value = dimension === 1 ? week.view_count : dimension === 2 ? Number(week.like_count) + Number(week.comment_count) + Number(week.share_count)
      : dimension === 3 ? work.level.completion_rate! : Number(week.subscribe_count ?? 0);
    return { work, views: week.view_count, value };
  }).filter((row) => row.views >= 300).sort((a, b) => b.value - a.value).slice(0, 3);
  return { status_code: 0, value_type: dimension === 3 ? 2 : 1, items: rows.map(({ work, value }) => ({ item_id: work.id, title: work.title, cover: coverOf(work), metric_value: dimension === 3 ? fixed(value) : value })) };
}

const AWEME_NAMES: Array<[string, string]> = [["publish_cnt", "publish_cnt"], ["play_cnt", "view_count"], ["digg_cnt", "like_count"], ["share_count", "share_count"], ["comment_cnt", "comment_count"],
  ["completion_rate_5s", "completion_rate_5s"], ["bounce_rate_2s", "bounce_rate_2s"], ["cover_click_ratio", "cover_click_rate"], ["avg_view_second", "avg_view_second"]];
const MIX_NAMES: Array<[string, string]> = [["view_count", "view_count"], ["like_count", "like_count"], ["share_count", "share_count"], ["comment_count", "comment_count"],
  ["completion_rate", "completion_rate"], ["bounce_rate_2s", "bounce_rate_2s"], ["cover_click_rate", "cover_click_rate"], ["average_play_duration", "avg_view_second"]];
const YUMME = new Set(["play_cnt", "digg_cnt", "share_count"]);

/** 作品数据（投稿 / 合集）：每个指标一张卡 + 逐日趋势，带环比；几项计数带「抖音精选」那一份 */
function dashboard(params: Params, mix: boolean): Raw {
  const { now, works } = world();
  const pool = mix ? works.filter((work) => work.mix) : works;
  const days = Math.max(1, Math.min(90, Number(params.recent_days) || 7));
  const list = recentDays(now, days + 1).map((day) => ({ day, stats: aggregate(pool, day, midnight(day, -1), now) }));
  const whole = aggregate(pool, list[1]!.day, midnight(now), now);
  return { status_code: 0, metrics: (mix ? MIX_NAMES : AWEME_NAMES).map(([name, key]) => ({
    english_metric_name: name, metric_value: whole[key] ?? 0,
    trends: list.slice(1).map(({ day, stats }, index) => {
      const value = Number(stats[key] ?? 0);
      const before = Number(list[index]!.stats[key] ?? 0);
      return { date_time: dayText(day), value, change_rate: before ? fixed((value - before) / before) : 0, ...(YUMME.has(name) ? { yumme_value: Math.round(value * 0.035) } : {}) };
    }),
  })) };
}

function dashboardFans(params: Params): Raw {
  const { now, fans } = world();
  const days = Math.max(1, Math.min(90, Number(params.recent_days) || 7));
  const from = midnight(now, days);
  const index = fans.findIndex((day) => day.day >= from);
  const rows = fans.slice(Math.max(0, index - 1), fans.findIndex((day) => day.day >= midnight(now)));
  const shown = rows.slice(rows.length - days);
  const card = (name: string, pickValue: (day: FansDay) => number, total: number) => ({
    english_metric_name: name, metric_value: total,
    trends: shown.map((day) => { const before = rows[rows.indexOf(day) - 1]; const value = pickValue(day); const prev = before ? pickValue(before) : 0;
      return { date_time: dayText(day.day), value, change_rate: prev ? fixed((value - prev) / Math.abs(prev)) : 0 }; }),
  });
  const sum = (pickValue: (day: FansDay) => number) => shown.reduce((total, day) => total + pickValue(day), 0);
  return { status_code: 0, metrics: [
    card("total_fans_cnt", (day) => day.total, shown[shown.length - 1]?.total ?? 0), card("net_fans_cnt", (day) => day.net, sum((day) => day.net)),
    card("new_fans_cnt", (day) => day.increase, sum((day) => day.increase)), card("cancel_fans_cnt", (day) => day.cancel, sum((day) => day.cancel)),
    card("home_view_fans_cnt", (day) => day.revisit, Math.round(sum((day) => day.revisit) / Math.max(1, shown.length))),
  ] };
}

// ---------- 直播：每三天播一场（昨天总有一场），每场的数自成一套 ----------

const LIVE_NAMES: Record<string, string> = {
  coin: "收获音浪", gift_uv: "送礼人数", gift_fans_uv: "送礼粉丝数", watch_pv: "观看次数", watch_uv: "观看人数", online_uv_max: "最高在线人数",
  watch_fans_uv: "观看粉丝数", playtime_avg: "人均观看时长", fans_playtime_avg: "粉丝人均观看时长", comment_uv: "评论人数", fans_comment_uv: "评论粉丝数",
  like_cnt: "点赞次数", fans_like_cnt: "粉丝点赞次数", follow_uv: "新增粉丝数", follow_ratio: "转粉率", live_time: "直播时长", live_cnt: "直播场次",
};
const LIVE_TYPES: Record<number, string> = { 101: "coin", 102: "gift_uv", 103: "gift_fans_uv", 201: "watch_pv", 202: "watch_uv", 203: "online_uv_max", 204: "watch_fans_uv", 205: "playtime_avg",
  206: "fans_playtime_avg", 301: "comment_uv", 302: "fans_comment_uv", 303: "like_cnt", 304: "fans_like_cnt", 401: "follow_uv", 402: "follow_ratio", 501: "live_time", 502: "live_cnt" };
const LIVE_TAB_KEYS: Record<number, string[]> = { 1: ["coin", "gift_uv", "gift_fans_uv"], 2: ["watch_pv", "watch_uv", "online_uv_max", "watch_fans_uv", "playtime_avg", "fans_playtime_avg"],
  3: ["comment_uv", "fans_comment_uv", "like_cnt", "fans_like_cnt"], 4: ["follow_uv", "follow_ratio"], 5: ["live_time", "live_cnt"] };

function liveDay(daysAgo: number): Raw | null {
  if ((daysAgo - 1) % 3 !== 0) return null;
  const rnd = randomFor(`live${daysAgo}`);
  const uv = Math.round(span(rnd, 800, 2100));
  const follow = Math.round(uv * span(rnd, 0.025, 0.05));
  const gift = Math.round(span(rnd, 18, 60));
  return {
    coin: Math.round(gift * span(rnd, 60, 140)), gift_uv: gift, gift_fans_uv: Math.round(gift * span(rnd, 0.5, 0.75)), watch_pv: Math.round(uv * span(rnd, 1.4, 1.9)), watch_uv: uv,
    online_uv_max: Math.round(uv * span(rnd, 0.06, 0.1)), watch_fans_uv: Math.round(uv * span(rnd, 0.28, 0.4)), playtime_avg: fixed(span(rnd, 2.4, 4.6), 2), fans_playtime_avg: fixed(span(rnd, 6, 10.5), 2),
    comment_uv: Math.round(uv * span(rnd, 0.07, 0.12)), fans_comment_uv: Math.round(uv * span(rnd, 0.03, 0.05)), like_cnt: Math.round(uv * span(rnd, 6, 14)),
    fans_like_cnt: Math.round(uv * span(rnd, 3, 6)), follow_uv: follow, follow_ratio: fixed(follow / uv), live_time: Math.round(span(rnd, 85, 150)), live_cnt: 1,
  };
}
const LIVE_PEAK = new Set(["online_uv_max"]);
const LIVE_AVERAGE = new Set(["playtime_avg", "fans_playtime_avg"]);
function liveTotal(key: string, days: number): number {
  const sessions = Array.from({ length: days }, (_, index) => liveDay(index + 1)).filter((day): day is Raw => Boolean(day));
  if (key === "follow_ratio") return fixed(sessions.reduce((sum, day) => sum + day.follow_uv, 0) / Math.max(1, sessions.reduce((sum, day) => sum + day.watch_uv, 0)));
  if (LIVE_PEAK.has(key)) return Math.max(0, ...sessions.map((day) => day[key]));
  const total = sessions.reduce((sum, day) => sum + Number(day[key] ?? 0), 0);
  return LIVE_AVERAGE.has(key) ? fixed(total / Math.max(1, sessions.length), 2) : total;
}

const VIEWERS = ["橙子不酸", "晚饭吃什么呀", "一颗卤蛋", "早睡早起的阿青", "小鹿爱喝汤", "番茄炒蛋本蛋", "爱吃辣的南方人", "周末不加班", "厨房小白", "慢慢来", "山野的风", "糯米团子",
  "北方的饺子", "加班到九点", "云朵棉花糖", "米饭要两碗", "认真吃饭", "小葱拌豆腐", "海盐柠檬", "不吃香菜", "阿北", "半夏", "青柠气泡水", "今天也要加油"];
function billboard(kind: string, days: number): Raw[] {
  const rnd = randomFor(`${kind}${days}`);
  const names = [...VIEWERS].sort(() => rnd() - 0.5).slice(0, Math.min(20, 8 + days));
  return names.map((name, index) => ({ rank: index + 1, encrypted_user_id: `demo${kind}${index}`, nick_name: name, avatar_url: null, fan_group_level: rnd() < 0.6 ? Math.max(1, 14 - index - Math.floor(rnd() * 4)) : 0 }));
}

// ---------- 粉丝画像（账号的和单条作品的共用一套比例，单条作品上下浮动一点） ----------

const GENDER: Array<[string, number]> = [["female", 0.63], ["male", 0.37]];
const AGES: Array<[string, number]> = [["18-23", 0.14], ["24-30", 0.31], ["31-40", 0.29], ["41-50", 0.17], ["50+", 0.09]];
const PROVINCES: Array<[string, number]> = [["广东", 0.12], ["四川", 0.09], ["江苏", 0.08], ["浙江", 0.075], ["山东", 0.07], ["河南", 0.065], ["湖南", 0.05], ["湖北", 0.048], ["重庆", 0.045],
  ["北京", 0.04], ["上海", 0.04], ["福建", 0.035], ["陕西", 0.03], ["安徽", 0.03]];
const CITIES: Array<[string, number]> = [["成都", 7.8], ["重庆", 6.1], ["广州", 5.4], ["深圳", 5], ["上海", 4.6], ["北京", 4.2], ["杭州", 3.9], ["武汉", 3.5]];
const INTERESTS: Array<[string, number]> = [["美食", 0.385], ["生活", 0.212], ["旅行", 0.098], ["母婴", 0.071], ["家居", 0.064], ["健康", 0.052], ["时尚", 0.041]];
const ACTIVE: Array<[string, string, number]> = [["4", "重度", 0.34], ["3", "中度", 0.29], ["2", "轻度", 0.22], ["1", "低活", 0.15]];
const SEARCHES: Array<[string, number]> = [["家常菜做法", 52000], ["一人食", 38600], ["减脂餐", 27400], ["快手早餐", 21900], ["下饭菜", 18300], ["空气炸锅食谱", 15200], ["带饭便当", 9800]];
const jitter = (rows: Array<[string, number]>, rnd: () => number): Array<[string, number]> => {
  const moved = rows.map(([key, value]): [string, number] => [key, value * span(rnd, 0.85, 1.15)]);
  const total = moved.reduce((sum, [, value]) => sum + value, 0);
  return moved.map(([key, value]) => [key, fixed(value / total)]);
};

function fansSummary(): Raw {
  const { followers } = world();
  return {
    status_code: 0,
    gender_distribution: shares(GENDER, followers), age_distribution: shares(AGES, followers),
    active_levels: ACTIVE.map(([key, label, share]) => ({ key, label, count: Math.round(share * followers) })),
    // 设备分布只写系统，不写手机品牌
    device_brand_distribution: shares([["安卓手机", 0.58], ["iOS 手机", 0.36], ["平板电脑", 0.04], ["其他", 0.02]], followers),
    city_distribution: shares(CITIES), fans_interest_distribution: shares(INTERESTS.map(([key, value]): [string, number] => [key, value * 100])),
    fans_portrait: { like_item_keyword: SEARCHES.map(([name, value]) => ({ name, value: Math.round(value / 5) })) },
  };
}

// ---------- 作品管理 ----------

const covers = new Map<string, string>();
const coverOf = (work: Work) => {
  if (!covers.has(work.id)) covers.set(work.id, cover(work.title, "美食", covers.size));
  return { url_list: [covers.get(work.id)!] };
};

function awemeOf(work: Work): Raw {
  const video = work.type !== 1;
  return {
    aweme_id: work.id, desc: work.title, create_time: Math.floor(work.publish / 1000), is_pinned: work.pinned, aweme_type: video ? 0 : 68,
    status_value: work.state === "reviewing" ? 141 : work.state === "rejected" ? 144 : 102,
    status: { private_status: work.state === "private" ? 1 : 0, is_private: work.state === "private", reviewed: work.state === "rejected" },
    author: { uid: UID, nickname: NICK }, duration: work.duration,
    ...(video ? { video: { duration: work.duration, cover: coverOf(work) } } : { images: Array.from({ length: work.pictures }, () => coverOf(work)) }),
  };
}
/** 作品详情、排序列表用的那种结构（item/mget、item/list） */
function itemOf(work: Work, now: number): Raw {
  return {
    id: work.id, item_id: work.id, user_id: UID, type: work.type, description: work.title, create_time: Math.floor(work.publish / 1000), cover: coverOf(work),
    video_info: { duration: work.duration }, picture_info: { count: work.pictures }, review: { status: 2 }, metrics: metricsAt(work, now),
  };
}

const STATUS_FILTER: Record<number, Array<Work["state"]>> = { 1: ["ok", "private"], 2: ["reviewing"], 3: ["rejected"] };
function workList(params: Params): Raw {
  const { now, works } = world();
  const pool = works.filter((work) => !STATUS_FILTER[Number(params.status)] || STATUS_FILTER[Number(params.status)]!.includes(work.state));
  const cursor = Number(params.max_cursor) || 0;
  const count = Math.max(1, Math.min(40, Number(params.count) || 12));
  const rest = cursor ? pool.filter((work) => work.publish < cursor) : pool;
  const page = rest.slice(0, count);
  return {
    status_code: 0, status_msg: "", total: pool.length, has_more: rest.length > page.length,
    max_cursor: page.length ? Math.floor(page[page.length - 1]!.publish) : cursor, min_cursor: page.length ? Math.floor(page[0]!.publish) : cursor,
    aweme_list: page.map(awemeOf), items: page.map((work) => ({ id: work.id, user_id: UID, type: work.type, metrics: metricsAt(work, now) })),
  };
}

/** 按播放 / 点赞排序（最高播放 order_by 3，最高点赞 5），只排近 90 天已发布的；游标就是偏移 */
function itemList(params: Params): Raw {
  const { now, works } = world();
  const start = Number(params.start_time) || now - 90 * DAY;
  const end = Number(params.end_time) || now;
  const key = Number(params.order_by) === 5 ? "like_count" : "view_count";
  const pool = works.filter((work) => work.state === "ok" && work.publish >= start && work.publish <= end).map((work) => itemOf(work, now))
    .sort((a, b) => b.metrics[key] - a.metrics[key]);
  const offset = Number(params.max_cursor) || 0;
  const count = Math.max(1, Math.min(40, Number(params.count) || 12));
  const next = Math.min(pool.length, offset + count);
  return { status_code: 0, items: pool.slice(offset, next), has_more: next < pool.length, min_cursor: next, max_cursor: next, total: pool.length };
}

// ---------- 作品详情 ----------

const workOf = (params: Params) => world().byId.get(String(params.item_id ?? params.id ?? params.aweme_id ?? String(params.ids ?? "").split(",")[0]));

function mget(params: Params): Raw {
  const { now } = world();
  const work = workOf(params);
  if (!work || work.state !== "ok") return { status_code: 0, items: [] };
  return { status_code: 0, items: [{
    ...itemOf(work, now), dou_plus: { view_count: work.douPlus }, incentive_life: { incentive_play_count: 0 }, integrated_incentive: { incentive_sum_list: [] },
    content_analysis: { quality: work.quality ? 2 : 1, video_content_info: work.quality ? { subsidy_vv: 18000, subsidy_income: 0 } : {} },
  }] };
}

const COMPARE: Array<[string, string, 0 | 1 | 2]> = [["completion_rate", "完播率", 0], ["avg_view_second", "平均播放时长", 2], ["bounce_rate_2s", "2s跳出率", 0], ["completion_rate_5s", "5s完播率", 0],
  ["avg_view_proportion", "平均播放占比", 0], ["cover_click_rate", "封面点击率", 0], ["like_rate", "点赞率", 0], ["comment_rate", "评论率", 0], ["share_rate", "分享率", 0],
  ["favorite_rate", "收藏率", 0], ["dislike_rate", "不感兴趣率", 0], ["danmaku_count", "弹幕量", 1], ["description_spread_rate", "文案展开率", 0], ["image_avg_view_count", "平均浏览图片数", 1],
  ["download_count", "下载量", 1], ["description_completion_rate", "文案完读率", 0], ["comment_entry_rate", "评论进入率", 0]];
const LOWER_BETTER = new Set(["bounce_rate_2s", "dislike_rate"]);

/** 和自己往期（之前 10 条同体裁的已发布作品）比；播放按最终量比，刚发的作品才不会一律「下降」 */
function itemCompare(params: Params): Raw {
  const { now, works } = world();
  const work = workOf(params);
  if (!work) return { status_code: 0 };
  const before = works.filter((other) => other.index > work.index && other.state === "ok" && other.type === work.type).slice(0, 10);
  const mine = metricsAt(work, now);
  const past = before.map((other) => metricsAt(other, now));
  const average = (key: string) => past.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / Math.max(1, past.length);
  const metrics = COMPARE.filter(([key]) => mine[key] !== undefined).map(([name, desc, type]) => {
    const old = average(name);
    return { name, name_desc: desc, metric_type: type, self_value: mine[name], change_ratio: old ? fixed((mine[name] - old) / old) : 0 };
  });
  const potential = before.reduce((sum, other) => sum + other.potential, 0) / Math.max(1, before.length);
  const ratio = potential ? fixed(work.potential / potential - 1) : 0;
  const changeType = ratio > 0.15 ? 0 : ratio < -0.15 ? 1 : 2;
  const goodness = (metric: Raw) => (LOWER_BETTER.has(metric.name) ? -1 : 1) * metric.change_ratio;
  const ranked = [...metrics].sort((a, b) => goodness(b) - goodness(a));
  const selected = changeType === 0 ? ranked.filter((metric) => goodness(metric) > 0).slice(0, 2) : changeType === 1 ? ranked.reverse().filter((metric) => goodness(metric) < 0).slice(0, 2) : [];
  return { status_code: 0, view_count_metric: { change_type: changeType, change_ratio: ratio }, selected_metrics: selected.map((metric) => metric.name), metrics };
}

/** 单条作品某个指标的趋势：每天（发布那天到今天，最多 30 天）或每小时（最近 48 小时，发布 14 天后不再更新） */
function itemTrend(params: Params): Raw {
  const { now } = world();
  const work = workOf(params);
  const key = String(params.metrics ?? "view_count");
  if (!work) return { status_code: 0, trend_map: {} };
  const hourly = Number(params.time_unit) === 2;
  const cumulative = Number(params.trend_type) === 2;
  const accumulates = key === "view_count" || key in work.perView;
  const valueAt = (at: number) => { const views = work.potential * reach(at - work.publish); return key === "view_count" ? views : views * (work.perView[key] ?? 0); };
  const final = Number(metricsAt(work, now)[key] ?? 0);
  let points: Array<{ start: number; end: number; label: string }>;
  if (hourly) {
    const last = Math.min(now, work.publish + 14 * DAY);
    const top = new Date(last).setMinutes(0, 0, 0);
    const first = Math.max(new Date(work.publish).setMinutes(0, 0, 0), top - 47 * HOUR);
    points = [];
    for (let at = first; at <= top; at += HOUR) points.push({ start: at, end: Math.min(at + HOUR, last), label: `${dayText(at, "-")} ${pad(new Date(at).getHours())}:00:00` });
  } else {
    const days = Math.min(29, Math.round((midnight(now) - midnight(work.publish)) / DAY));
    points = Array.from({ length: days + 1 }, (_, index) => { const start = midnight(now, days - index); return { start, end: Math.min(midnight(start, -1), now), label: dayText(start, "-") }; });
  }
  const rnd = randomFor(`${work.id}${key}${hourly}${cumulative}`);
  const full = points.map((point, index) => {
    if (accumulates) return { date_time: point.label, value: Math.max(0, Math.round(cumulative ? valueAt(point.end) : valueAt(point.end) - valueAt(Math.max(point.start, work.publish)))) };
    // 比率类：累计的越往后越贴近最终值，新增的每段上下浮动
    const wobble = (rnd() - 0.5) * 0.3 * (cumulative ? 1 - index / Math.max(1, points.length - 1) : 1);
    return { date_time: point.label, value: fixed(final * (1 + wobble), key.includes("count") ? 2 : 6) };
  });
  const groups: Raw = { "0": full };
  if (accumulates) {
    groups["3"] = full.map((point) => ({ ...point, value: Math.round(point.value * 0.035) }));
    groups["1"] = full.map((point, index) => ({ ...point, value: point.value - groups["3"][index].value }));
  }
  return { status_code: 0, trend_map: { [key]: groups } };
}

/** 观看趋势：留存（1 视频 / 3 图文）、跳出（7 / 9）、点赞（2 / 8）；当前作品 + 同类作品 */
function itemRealtime(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0 };
  const type = Number(params.analysis_type);
  const mode = type === 1 || type === 3 ? "retention" : type === 7 || type === 9 ? "bounce" : "like";
  const pic = work.type === 1;
  const seconds = work.duration / 1000;
  const step = pic ? 1 : Math.max(1, Math.ceil(seconds / 60));
  const count = pic ? work.pictures : Math.floor(seconds / step);
  const bounce = work.level.bounce_rate_2s ?? 0.25;
  const finish = pic ? 0.35 : work.level.completion_rate ?? 0.3;
  const dip = Math.round(count * 0.42);
  // 留存曲线：开头两秒掉得快，之后平缓下降到完播率；中段有一个低谷
  const curve = (x: number, ratio: number, valley: boolean) => {
    const length = pic ? work.pictures - 1 : seconds;
    const a = Math.min(0.6, bounce * 1.15);
    const lambda = -Math.log(Math.max(0.05, (ratio - a * Math.exp(-length / 2)) / (1 - a))) / length;
    const value = a * Math.exp(-x / (pic ? 0.8 : 2)) + (1 - a) * Math.exp(-lambda * x);
    return valley && Math.abs(x / step - dip) < 2 ? value * 0.94 : value;
  };
  const series = (similar: boolean) => {
    const ratio = similar ? finish * 0.9 : finish;
    const rnd = randomFor(`${work.id}${mode}${similar}`);
    // 视频的点是第 step、2·step… 秒；图文的点是第 1、2… 张（留存从第 1 张的 100% 起）
    const at = (index: number) => (pic ? index : (index + 1) * step);
    const values = Array.from({ length: count }, (_, index) => {
      if (mode === "retention") return curve(at(index), ratio, !similar);
      if (mode === "bounce") return pic ? curve(index, ratio, !similar) - curve(index + 1, ratio, !similar)
        : (index === 0 ? 1 : curve(at(index - 1), ratio, !similar)) - curve(at(index), ratio, !similar);
      return (0.6 + rnd() * 0.4) * (index / count > 0.7 ? 2.2 : 1);
    });
    const total = mode === "like" ? values.reduce((sum, value) => sum + value, 0) : 1;
    return values.map((value, index) => ({ key: pic ? String(index + 1) : clock(at(index)), value: fixed(Math.max(0, value / total)) }));
  };
  return {
    status_code: 0, analysis_trend: { current_item: series(false), similar_author: series(true) },
    valley_list: mode === "retention" && !pic && count > 10 ? { "0": [{ start: (dip - 1) * step, end: (dip + 2) * step }] } : {},
  };
}

/** 进度分析（只有 3 分钟以上的视频有）：每 10 秒的跳过率和回看率 */
function itemProgress(params: Params): Raw {
  const work = workOf(params);
  if (!work || work.type === 1) return { status_code: 0, jump_forward: [], jump_backward: [] };
  const rnd = randomFor(`${work.id}progress`);
  const keys = Array.from({ length: Math.floor(work.duration / 10000) }, (_, index) => (index + 1) * 10);
  const shape = (base: number, peak: number) => keys.map((key) => ({ key, value: fixed(base * (0.6 + rnd() * 0.8) + (Math.abs(key / (work.duration / 1000) - peak) < 0.08 ? base * 2 : 0)) }));
  return { status_code: 0, jump_forward: shape(0.045, 0.2), jump_backward: shape(0.025, 0.7) };
}

const CHAPTERS = ["备菜", "处理食材", "下锅", "调味收汁", "出锅试吃"];
function itemChapter(params: Params): Raw {
  const work = workOf(params);
  if (!work || work.type === 1 || work.type === 2) return { status_code: 0, chapter_info: { ChapterDetails: [] }, chapter_top_data: [] };
  const rnd = randomFor(`${work.id}chapter`);
  const details = CHAPTERS.map((desc, index) => ({ Timestamp: Math.round((work.duration * index) / CHAPTERS.length), Desc: desc }));
  return { status_code: 0, chapter_info: { ChapterDetails: details }, chapter_top_data: details.map((detail) => ({ chapter_detail: detail, click_rate: fixed(span(rnd, 0.02, 0.12)) })) };
}

function itemBullet(params: Params): Raw {
  const work = workOf(params);
  if (!work || work.type === 1) return { status_code: 0, current_item: [], similar_author: [] };
  const total = Math.max(3, Number(metricsAt(work, world().now).danmaku_count));
  const step = work.duration > 60000 ? 10 : 5;
  const keys = Array.from({ length: Math.floor(work.duration / 1000 / step) }, (_, index) => (index + 1) * step);
  const spread = (similar: boolean) => { const rnd = randomFor(`${work.id}bullet${similar}`); return keys.map((key) => ({ key, value: Math.round((total / keys.length) * span(rnd, 0.3, 1.9) * (similar ? 0.8 : 1)) })); };
  return { status_code: 0, current_item: spread(false), similar_author: spread(true) };
}

function itemPlaySource(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0, play_source: [] };
  const rnd = randomFor(`${work.id}source`);
  const raw: Array<[string, number]> = [["homepage_hot", span(rnd, 0.62, 0.8)], ["search", span(rnd, 0.04, 0.12)], ["self_profile_vv_all", span(rnd, 0.025, 0.05)],
    ["other_profile_vv_all", span(rnd, 0.004, 0.01)], ["follow", span(rnd, 0.02, 0.05)], ["familiar", span(rnd, 0.01, 0.03)], ["fresh", span(rnd, 0.01, 0.03)],
    ["message", span(rnd, 0.003, 0.01)], ...(work.mix ? [["compilation", span(rnd, 0.01, 0.03)] as [string, number]] : []), ["other", span(rnd, 0.005, 0.015)]];
  const total = raw.reduce((sum, [, value]) => sum + value, 0);
  return { status_code: 0, play_source: [
    ...raw.map(([key, value]) => ({ app_id: 1128, key, value: fixed(value / total, 6), history_difference: fixed((rnd() - 0.5) * 0.04, 6) })),
    { app_id: 2329, key: "yumme_vv_all", value: fixed(span(rnd, 0.02, 0.05), 6), history_difference: fixed((rnd() - 0.5) * 0.01, 6) },
  ] };
}

function itemSearchKeyword(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0, show_from: [], inspire_search: [] };
  const rnd = randomFor(`${work.id}search`);
  const rows = (words: string[]) => { let left = span(rnd, 0.6, 0.85); return words.map((keyword) => { const percent = fixed(left * span(rnd, 0.25, 0.45)); left -= percent; return { keyword, percent }; }); };
  return { status_code: 0,
    show_from: rows([`${work.dish}的做法`, work.dish, `家常${work.dish}`, `${work.dish}怎么做好吃`, "一人食食谱", "快手菜"]),
    inspire_search: rows([`${work.dish}要焯水吗`, `${work.dish}配什么`, `${work.dish}的热量`, "下饭菜", "一周晚饭不重样"]) };
}

function itemPortrait(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0 };
  const rnd = randomFor(`${work.id}portrait`);
  const list = (rows: Array<[string, number]>) => ({ ratio_list: jitter(rows, rnd).map(([key, value]) => ({ key, value })) });
  return { status_code: 0, gender: list(GENDER), age: list(AGES), province: list(PROVINCES), active: jitter(ACTIVE.map(([key, , share]): [string, number] => [key, share]), rnd).map(([key, value]) => ({ key, value })) };
}
function itemAudience(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0 };
  const rnd = randomFor(`${work.id}audience`);
  return { status_code: 0, audience_preference: { total_data: { ratio_data: jitter(INTERESTS, rnd).map(([key, value]) => ({ key, value })) } },
    audience_search_most_keywords: SEARCHES.map(([keywords, count]) => ({ keywords, query_cnt_7d: Math.round(count * span(rnd, 0.8, 1.2)) })) };
}

const HOT_WORDS = ["好吃", "收藏了", "看饿了", "比例", "火候", "米饭", "周末试试", "下饭", "简单", "新手", "酱汁", "上班", "一个人", "成功了", "颜色", "多久", "外卖", "家里人", "香", "教程"];
function commentHotwords(params: Params): Raw {
  const work = workOf(params);
  if (!work) return { status_code: 0, word_cloud_list: [] };
  const rnd = randomFor(`${work.id}words`);
  const words = [work.dish, ...[...HOT_WORDS].sort(() => rnd() - 0.5)].slice(0, 16);
  return { status_code: 0, word_cloud_list: words.map((word, index) => ({ rank: index + 1, word })) };
}

// ---------- 评论：每条作品一份固定的评论区，30 天内走新接口，更早的走老接口 ----------

interface Comment { id: string; text: string; time: number; likes: number; user: string; author: boolean; crowd: string[]; replies: Comment[]; replyTo: string | null }
const LINES = ["看饿了，今晚就做{dish}", "请问{dish}要炖多久？", "收藏了，周末试试[赞]", "酱汁比例能再说一遍吗？", "跟着做了一次，家里人都说好吃", "终于等到更新了[星星眼]",
  "一个人住也要好好吃饭", "没有烤箱可以用平底锅吗？", "{dish}我妈也是这么做的", "第一次做就成功了，谢谢", "能出一期减脂版吗？", "看完立刻去买菜了[捂脸]", "火候讲得很清楚，新手友好",
  "为什么我做出来颜色没这么好看？", "这个刀工我先放弃了[捂脸]", "求出一期一周带饭合集", "上班路上看饿了", "已经做了三次了，次次光盘", "放多少盐合适呀？", "{dish}配米饭绝了[呲牙]",
  "背景音乐好舒服", "周末就安排上", "这个量一个人吃刚好", "收汁那一步太治愈了"];
const AUTHOR_REPLIES = ["小火慢慢来，四十分钟左右就软了", "可以的，火开小一点多焖两分钟", "盐少量多次加，最后尝一下再调", "有空安排上！", "谢谢喜欢～", "下期就做", "比例写在置顶评论里啦"];
const OTHER_REPLIES = ["同问", "+1 我也想知道", "我做过，真的好吃", "哈哈哈哈同款", "[赞][赞]", "我也是看饿了"];
const QUESTION = /[？?]|吗|多久|多少/u;
const commentCache = new Map<string, Comment[]>();

function commentsOf(work: Work): Comment[] {
  const hit = commentCache.get(work.id);
  if (hit) return hit;
  const { now } = world();
  const rnd = randomFor(`${work.id}comments`);
  const metrics = metricsAt(work, now);
  const top = Math.min(36, Math.round(Number(metrics.comment_count) * 0.6));
  const likeCap = Math.max(20, Number(metrics.view_count) * 0.008); // 评论点赞跟着作品播放量走
  const at = (after: number) => Math.min(now - 60_000, after + (now - after) * Math.pow(rnd(), 3) + 5 * 60_000);
  const list: Comment[] = Array.from({ length: top }, (_, index) => {
    const text = pickOf(rnd, LINES).replace("{dish}", work.dish);
    const time = at(work.publish);
    const id = `${work.id}${String(index).padStart(4, "0")}`;
    const fan = rnd() < 0.45;
    const crowd = [...(fan ? ["fans"] : []), ...(rnd() < 0.06 ? ["following"] : []), ...(fan && rnd() < 0.08 ? ["friend"] : [])];
    const replies: Comment[] = [];
    const user = pickOf(rnd, VIEWERS);
    if (QUESTION.test(text) ? rnd() < 0.7 : rnd() < 0.15) replies.push({ id: `${id}01`, text: pickOf(rnd, AUTHOR_REPLIES), time: at(time), likes: Math.floor(rnd() * 30), user: NICK, author: true, crowd: [], replies: [], replyTo: null });
    for (let k = 0, extra = Math.floor(Math.pow(rnd(), 2) * 4); k < extra; k += 1) {
      replies.push({ id: `${id}${pad(k + 2)}`, text: pickOf(rnd, OTHER_REPLIES), time: at(time), likes: Math.floor(rnd() * 8), user: pickOf(rnd, VIEWERS), author: false, crowd: [], replies: [], replyTo: rnd() < 0.3 ? user : null });
    }
    replies.sort((a, b) => a.time - b.time);
    return { id, text, time, likes: Math.floor(Math.pow(rnd(), 3) * likeCap), user, author: false, crowd, replies, replyTo: null };
  });
  commentCache.set(work.id, list);
  return list;
}
const webComment = (c: Comment): Raw => ({ cid: c.id, text: c.text, create_time: Math.floor(c.time / 1000), digg_count: c.likes, reply_comment_total: c.replies.length, label_type: c.author ? 1 : 0,
  user: { nickname: c.user, avatar_thumb: { url_list: [] } }, reply_comment: [], reply_to_username: c.replyTo ?? "", user_buried: false });
const oldComment = (c: Comment): Raw => ({ comment_id: c.id, text: c.text, create_time: Math.floor(c.time / 1000), digg_count: c.likes, reply_count: c.replies.length, is_author: c.author,
  user_info: { screen_name: c.user, avatar_url: null }, reply_to_user_info: c.replyTo ? { screen_name: c.replyTo } : null });
const pageOf = <T,>(rows: T[], cursor: number, count: number) => ({ rows: rows.slice(cursor, cursor + count), cursor: Math.min(rows.length, cursor + count), has_more: cursor + count < rows.length, total: rows.length });

function commentList(params: Params, old: boolean): Raw {
  const work = workOf(old ? { item_id: params.item_id ?? "" } : { item_id: params.aweme_id ?? "" });
  const field = old ? "comment_info_list" : "comments";
  if (!work) return { status_code: 0, [field]: [], cursor: 0, has_more: false };
  const options = String(params.comment_select_options ?? "0").split(",").filter((part) => part && part !== "0");
  const keyword = String(params.keyword ?? "").trim();
  const sort = old ? ({ TIME: 0, EARLIEST: 1, HOT: 2 } as Record<string, number>)[String(params.sort)] ?? 0 : Number(params.sort_options) || 0;
  const rows = commentsOf(work).filter((c) => options.every((option) => option === "not_replied" ? !c.replies.some((reply) => reply.author)
    : option === "question" ? QUESTION.test(c.text) : option === "disturb" ? false : c.crowd.includes(option)))
    .filter((c) => !keyword || c.text.includes(keyword) || c.replies.some((reply) => reply.text.includes(keyword)))
    .sort((a, b) => (sort === 2 ? b.likes - a.likes : sort === 1 ? a.time - b.time : b.time - a.time));
  const page = pageOf(rows, Number(params.cursor) || 0, Number(params.count) || 10);
  return { status_code: 0, [field]: page.rows.map(old ? oldComment : webComment), cursor: page.cursor, has_more: page.has_more, total: page.total };
}

function commentReplies(params: Params, old: boolean): Raw {
  const id = String(params.comment_id ?? "");
  const work = world().byId.get(id.slice(0, 19));
  const parent = work ? commentsOf(work).find((c) => c.id === id) : undefined;
  const page = pageOf(parent?.replies ?? [], Number(params.cursor) || 0, Number(params.count) || 10);
  return { status_code: 0, [old ? "comment_info_list" : "comments"]: page.rows.map(old ? oldComment : webComment), cursor: page.cursor, has_more: page.has_more, total: page.total };
}

// ---------- 抖音指数：热点榜（探索页） ----------

const TOPICS = ["打工人的带饭日常", "周末去哪儿玩", "第一次带爸妈旅行", "一个人吃饭也要好好吃", "城市夜跑", "租房小改造", "下班后的两小时", "回村过周末", "毕业后的第一份工作",
  "早餐店的清晨", "菜市场里的烟火气", "地铁上的读书人", "宠物的迷惑行为", "老手艺人", "家常菜挑战", "街头篮球", "小县城的夜市", "退休后的新爱好", "城市骑行路线", "露营装备清单",
  "厨房收纳", "健身三十天的变化", "考试周的图书馆", "外婆的拿手菜", "一碗面的讲究", "绿皮火车上的旅途", "雨天的咖啡馆", "广场舞新曲目", "农家小院", "手工面包", "夜宵摊",
  "运动会名场面", "新手种菜", "博物馆里的冷知识", "城市的老街巷", "社区食堂", "一人居的小确幸", "儿时的零食", "家庭聚餐", "早起打卡", "通勤路上的风景", "自制奶茶"];
const SEASON_TOPICS = [["围炉煮茶", "冬天的第一场雪", "年货清单", "腊味飘香", "跨年夜怎么过", "热乎乎的火锅"], ["春天的第一口野菜", "踏青好去处", "清明吃青团", "春笋上市", "换季穿搭", "樱花开了"],
  ["消暑甜品", "夏天的西瓜", "暑假去哪儿", "夜市小龙虾", "防晒小技巧", "冰粉的做法"], ["秋天的第一杯热饮", "桂花开了", "螃蟹季", "银杏叶黄了", "秋冬养生汤", "立冬吃饺子"]];
const TOPIC_CATEGORY = ["生活", "美食", "旅行", "运动", "萌宠", "知识"];

/** 两个榜各 30 条，同一天里不变，换一天重新洗一次 */
function hotTopics(): Raw {
  const now = Date.now();
  const season = SEASON_TOPICS[Math.floor((new Date(now).getMonth() + 1) / 3) % 4]!;
  const rnd = randomFor(`hot${dayText(now)}`);
  const pool = [...season, ...TOPICS].map((name, index) => ({ name, order: rnd() - (index < season.length ? 0.5 : 0) })).sort((a, b) => a.order - b.order).map((row) => row.name);
  const board = (names: string[], top: number, bottom: number) => names.map((topic_name, index) => ({
    rank: index + 1, topic_name, topic_index: Math.round(top * Math.pow(bottom / top, index / (names.length - 1)) * span(rnd, 0.97, 1.03)),
    rank_flag: [1, 1, 0, -1][Math.floor(rnd() * 4)], category: pickOf(rnd, TOPIC_CATEGORY),
  }));
  return { BaseResp: { StatusCode: 0, StatusMessage: "" }, current: board(pool.slice(0, 30), 12_100_000, 1_800_000), rocketing: board(pool.slice(pool.length - 30).reverse(), 3_800_000, 260_000) };
}

// ---------- 抖音指数：达人详情（探索页主页上方），按搜索词合成一位达人 ----------

const indexOk = (data: Raw) => ({ status: 0, msg: "", data: { ...data, BaseResp: { StatusCode: 0, StatusMessage: "" } } });
const darenNames = new Map<string, string>();
const DAREN_TAGS = [["美食", "家常菜"], ["生活", "日常记录"], ["旅行", "城市漫游"], ["萌宠", "猫"], ["知识", "科普"], ["运动", "跑步"], ["音乐", "弹唱"], ["三农", "田园生活"]];
const DAREN_TITLES = ["今天也是普通的一天", "随手拍的晚霞", "这个方法真的有用", "第一次尝试，翻车了", "周末去了一趟郊外", "给自己做顿好的", "看完这个我沉默了", "终于等到这一天",
  "记录一下今天的小确幸", "这次真的不一样", "把日子过成喜欢的样子", "一个人的周末"];
const latestDay = () => dayText(midnight(Date.now(), 2));
const shiftDay = (day: string, days: number) => dayText(new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + days).getTime());
function darenProfile(id: string) {
  const rnd = randomFor(`daren${id}`);
  const fans = Math.round(Math.exp(span(rnd, Math.log(30_000), Math.log(900_000))));
  return { rnd, fans, likes: Math.round(fans * span(rnd, 8, 22)), works: Math.round(span(rnd, 90, 620)), tags: pickOf(rnd, DAREN_TAGS) };
}
function darenSeries(id: string) {
  const { fans } = darenProfile(id);
  const rnd = randomFor(`daren-series${id}`);
  const end = latestDay();
  const days = Array.from({ length: 90 }, (_, index) => shiftDay(end, index - 89));
  const daily = { like: [] as number[], fans: [] as number[], share: [] as number[], comment: [] as number[], item: [] as number[] };
  for (let index = 0; index < days.length; index += 1) {
    const posted = rnd() < 0.35 ? 1 : 0;
    const heat = (posted ? span(rnd, 1.2, 2.6) : span(rnd, 0.5, 1)) * (rnd() < 0.04 ? 5 : 1);
    daily.like.push(Math.round(fans * 0.012 * heat)); daily.fans.push(Math.round(fans * 0.0009 * heat * span(rnd, 0.6, 1.3)));
    daily.share.push(Math.round(fans * 0.0011 * heat)); daily.comment.push(Math.round(fans * 0.0007 * heat)); daily.item.push(posted);
  }
  return { days, daily };
}
const sumLast = (list: number[], days: number, offset = 0) => list.slice(list.length - days - offset, list.length - offset).reduce((sum, value) => sum + value, 0);
const change = (now: number, before: number) => (before ? fixed((now - before) / before) : null);

function daren(key: CreatorKey, params: Params): Raw | null {
  if (key === "daren_valid_date") return indexOk({ datetime: latestDay() });
  if (key === "daren_suggest") {
    const keyword = String(params.keyword ?? "").trim();
    let id = "";
    for (let seed = seedOf(keyword); id.length < 11; seed = Math.floor(seed / 26) || seedOf(`${keyword}${id}`)) id += String.fromCharCode(97 + (seed % 26));
    darenNames.set(id, keyword);
    return indexOk({ userlist: keyword ? [{ user_id: id, user_name: keyword, aweme_id: keyword, aweme_url: "", avatar_url: null }] : [] });
  }
  const id = String(params.user_id ?? "");
  const name = darenNames.get(id);
  if (!name) return null;
  const profile = darenProfile(id);
  const { days, daily } = darenSeries(id);
  if (key === "daren_info") {
    const first = profile.fans >= 100_000 ? { first_1w_fans_date: shiftDay(latestDay(), -680), first_10w_fans_date: shiftDay(latestDay(), -210) } : { first_1w_fans_date: shiftDay(latestDay(), -320) };
    return indexOk({ user_id: id, user_name: name, first_tag_name: profile.tags[0], second_tag_name: profile.tags[1], fans_count: profile.fans, like_count: profile.likes, item_count: profile.works, fans_milestone: first });
  }
  if (key === "daren_trend") {
    const periods: Array<[string, number]> = [["day", 1], ["week", 7], ["half_month", 15], ["month", 30]];
    const out: Raw = {};
    for (const [metric, list] of Object.entries(daily)) {
      out[`${metric}listday`] = days.map((date, index) => ({ date, count: list[index] }));
      out[`${metric}_info`] = Object.fromEntries(periods.flatMap(([period, length]) => [[`new_${metric}_count_by_${period}`, sumLast(list, length)], [`exchange_by_${period}`, change(sumLast(list, length), sumLast(list, length, length))]]));
    }
    return indexOk(out);
  }
  if (key === "daren_work_average") {
    const posts = (length: number, offset = 0) => Math.max(1, sumLast(daily.item, length, offset));
    const average = (list: number[], length: number, offset = 0) => Math.round(sumLast(list, length, offset) / posts(length, offset));
    const block = (metric: "like" | "fans" | "share" | "comment") => [{
      [`${metric}_average_count_by_week`]: average(daily[metric], 7), exchange_by_week: change(average(daily[metric], 7), average(daily[metric], 7, 7)),
      [`${metric}_average_count_by_month`]: average(daily[metric], 30), exchange_by_month: change(average(daily[metric], 30), average(daily[metric], 30, 30)),
    }];
    return indexOk({ like_info: block("like"), fans_info: block("fans"), share_info: block("share"), comment_info: block("comment") });
  }
  if (key === "daren_top_videos") {
    const rnd = randomFor(`daren-videos${id}`);
    const start = String(params.start_date ?? shiftDay(latestDay(), -30));
    const rows = days.flatMap((date, index) => (daily.item[index] && date >= start ? [{
      item_id: `9930${String(seedOf(`${id}${date}`)).padStart(15, "0")}`, video_text: pickOf(rnd, DAREN_TITLES), picture: null, create_time: date,
      like_cnt: Math.round(daily.like[index]! * span(rnd, 1.5, 4)), coment_cnt: Math.round(daily.comment[index]! * span(rnd, 1.5, 4)),
      share_cnt: Math.round(daily.share[index]! * span(rnd, 1.5, 4)), follow_cnt: Math.round(daily.fans[index]! * span(rnd, 1.2, 3)),
    }] : []));
    const by = (field: string) => [...rows].sort((a: Raw, b: Raw) => b[field] - a[field]).slice(0, 20);
    return indexOk({ create_time_list: by("create_time"), like_list: by("like_cnt"), comment_list: by("coment_cnt"), share_list: by("share_cnt"), follow_list: by("follow_cnt") });
  }
  if (key === "daren_fans") {
    const rnd = profile.rnd;
    const group = (rows: Array<[string, number]>) => JSON.stringify(jitter(rows, rnd).map(([label, value]) => ({ name: label, value })));
    const tgi = (rows: Array<[string, number]>) => JSON.stringify(rows.map(([label]) => ({ name: label, value: Math.round(span(rnd, 60, 160)) })));
    const age: Array<[string, number]> = [["18-23", 0.16], ["24-30", 0.3], ["31-40", 0.28], ["41-50", 0.16], ["50-", 0.1]];
    const city: Array<[string, number]> = [["一线", 0.14], ["新一线", 0.22], ["二线", 0.19], ["三线", 0.2], ["四线", 0.14], ["五线", 0.11]];
    const price: Array<[string, number]> = [["0-1000", 0.12], ["1000-2000", 0.26], ["2000-3000", 0.27], ["3000-5000", 0.22], ["5000以上", 0.13]];
    const tags: Array<[string, number]> = [[profile.tags[0]!, 0.3], ["生活", 0.18], ["美食", 0.14], ["旅行", 0.1], ["影视", 0.09], ["游戏", 0.07], ["汽车", 0.06], ["未分类", 0.06]];
    const province = PROVINCES.slice(0, 10).map(([label, value]): [string, number] => [label, value]);
    return indexOk({ Gender: group(GENDER), Gender_Tgi: tgi(GENDER), Age: group(age), Age_Tgi: tgi(age), Province: group(province), Province_Tgi: tgi(province),
      CityLabel: group(city), CityLabel_Tgi: tgi(city), DevicePrice: group(price), DevicePrice_Tgi: tgi(price), FirstTag: group(tags), FirstTag_Tgi: tgi(tags) });
  }
  return null;
}

// ---------- key → 界面上的哪一块 ----------

const ANSWERS: Partial<Record<CreatorKey, (params: Params) => Raw | null>> = {
  // 创作者中心顶部账号卡（昵称、签名、关注 / 粉丝 / 获赞）；has_data_mgmt_perm 打开「粉丝数据」「粉丝画像」两块
  user_info: () => { const { followers, likes } = world(); return { status_code: 0, has_data_mgmt_perm: true, user_profile: {
    nick_name: NICK, unique_id: "示例号_0001", signature: "下班后的一人食和周末小厨房｜家常菜做法都写在视频最后", avatar_url: ACCOUNT_AVATAR,
    following_count: 163, follower_count: followers, total_favorited: likes } }; },
  // 作品数据的「合集」页签、两套客户端分开显示（不分）
  author_upgrade: () => ({ status_code: 0, is_show_per_client_data: false }),
  mix_list: () => ({ status_code: 0, total: MIXES.length, mixs: MIXES.map((mix) => ({ mix_id: mix.id, mix_name: mix.name, item_count: world().works.filter((work) => work.mix === mix.id).length, cover_url: null })) }),
  // 数据总览：五项诊断 + 雷达图 + 贡献 TOP3
  diagnosis, contribution_top: contributionTop,
  // 作品数据（投稿 / 合集）、粉丝数据
  dashboard: (params) => dashboard(params, false), dashboard_mix: (params) => dashboard(params, true), dashboard_fans: dashboardFans,
  // 作品数据的「直播」页签：五组卡片 + 趋势 + 送礼 / 观看榜、新增粉丝来源
  live_dashboard: (params) => { const days = Number(params.day_window) || 7; const yesterday = dayText(midnight(Date.now(), 1), "-");
    return { status_code: 0, data: Object.fromEntries((LIVE_TAB_KEYS[Number(params.tab_type)] ?? []).map((key) => [key, { name: LIVE_NAMES[key], value: liveTotal(key, days), date: yesterday }])) }; },
  live_trends: (params) => { const days = Number(params.day_window) || 7; const key = LIVE_TYPES[Number(params.metrics_type)] ?? "watch_uv";
    return { status_code: 0, data: Array.from({ length: days }, (_, index) => ({ date: dayText(midnight(Date.now(), days - index), "-"), value: liveDay(days - index)?.[key] ?? 0 })) }; },
  live_gift_billboard: (params) => ({ status_code: 0, data: { gift_billboard: billboard("gift", Number(params.day_window) || 7) } }),
  live_watch_billboard: (params) => ({ status_code: 0, data: { watch_billboard: billboard("watch", Number(params.day_window) || 7) } }),
  live_fans_source: (params) => { const total = liveTotal("follow_uv", Number(params.day_window) || 7); const rnd = randomFor("fans-source");
    const parts: Array<[string, number]> = [["直播推荐", 0.46], ["关注页", 0.21], ["个人主页", 0.15], ["同城", 0.1], ["其他", 0.08]];
    return { status_code: 0, data: { NewFansSource: parts.map(([name, rate]) => ({ name, value: Math.round(total * rate), rate, compare: rnd() < 0.6 ? 1 : 0 })) } }; },
  // 粉丝画像
  fans_summary: fansSummary,
  // 作品管理：最新发布（翻页、状态筛选、总数）、按播放 / 点赞排序
  work_list: workList, item_list: itemList,
  // 作品详情：头部 + 总览 / 流量分析 / 观众分析 / 评论热词 / 评论管理
  item_mget: mget, item_compare: itemCompare, item_trend: itemTrend, item_realtime: itemRealtime, item_progress: itemProgress, item_chapter: itemChapter,
  item_bullet: itemBullet, item_play_source: itemPlaySource, item_search_keyword: itemSearchKeyword, item_portrait: itemPortrait, item_audience: itemAudience,
  item_summarize: (params) => ({ status_code: 0, item_list: workOf(params) ? [{ item_id: String(params.item_id), sec_item_id: String(params.item_id) }] : [] }),
  comment_hotwords: commentHotwords,
  comment_list: (params) => commentList(params, false), comment_list_old: (params) => commentList(params, true),
  comment_replies: (params) => commentReplies(params, false), comment_replies_old: (params) => commentReplies(params, true),
  // 探索页「抖音热点」
  index_hot_topic: hotTopics,
};

function answerOne(query: CreatorQuery): Result {
  const params = (query?.params ?? {}) as Params;
  const key = query?.key;
  try {
    const data = key?.startsWith("daren_") ? daren(key, params) : key ? ANSWERS[key]?.(params) ?? null : null;
    return data ? { ok: true, data } : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export function answerCreatorRead(body: unknown): { results: Result[] } {
  const requests = (body as { requests?: CreatorQuery[] } | null)?.requests;
  return { results: Array.isArray(requests) ? requests.map(answerOne) : [] };
}
