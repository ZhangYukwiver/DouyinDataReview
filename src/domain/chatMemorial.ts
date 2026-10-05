import { CHAT_EMOJI } from "./chatEmoji";
import type { ChatConversationKind, ChatMessage } from "./chatRecords";
import { shiftDay, SPARK_LIT_DAYS, sparkDayKey, type Spark, type SparkDay } from "./chatSparks";

/**
 * 火花纪念卡要画的东西：一个会话的聊天统计。
 * 好友会话用本机存下的全部消息；群消息不落盘，只有采集时数下的总数和我发了几条，
 * 钟点、表情这类要看正文的，只能从这次从抖音现读到的最近一批里算（sample 标出是多少条）。
 */
export interface ChatMemorial {
  kind: ChatConversationKind;
  name: string;
  /** 亮着/重燃中/最近断了的火花；没有就是 null。 */
  spark: { days: number; text: string; official: boolean; state: Spark["state"]; brokeOn: string | null; today: SparkDay } | null;
  /** 好友：第一条和最后一条消息的时间；群：null（看不到群里最早的消息）。 */
  firstAt: string | null;
  lastAt: string | null;
  /** 从第一条消息那天到今天，含首尾两天。 */
  sinceDays: number | null;
  total: number;
  mine: number;
  theirs: number;
  /** 认不认得出哪些是我发的；认不出时 mine/theirs 用的是采集器数的条数，分享、第一句就不分是谁。 */
  selfKnown: boolean;
  /** 群聊里钟点、表情这些只来自现读到的最近 sample 条；好友是 null（用的是全部消息）。 */
  sample: number | null;
  /** 有消息的天数、双方都发过的天数、最长连着互发了几天。群里没有「双方」，都是 null。 */
  activeDays: number | null;
  mutualDays: number | null;
  longestRun: { days: number; start: string; end: string } | null;
  /** 0–23 点各发了多少条；一条带时间的都没有就是 null。 */
  hours: number[] | null;
  peakHour: number | null;
  /** 最晚的一条（按凌晨 5 点换天算「晚」）。 */
  latest: string | null;
  busiestDay: { date: string; count: number } | null;
  /** 分享视频（含转发的评论）各自发了几个。 */
  shares: { mine: number; theirs: number };
  stickers: number;
  images: number;
  /** 抖音内置小表情（[捂脸] 这类文字代码），最多三个。 */
  topEmoji: Array<{ code: string; count: number }>;
  /** 聊天里出现最多的词，最多五个；群聊不算（别人的话）。 */
  topWords: Array<{ word: string; count: number }>;
  /** 第一句文字消息；群聊不算。 */
  firstLine: { text: string; mine: boolean | null; at: string } | null;
  /** 每一天谁发过消息，最早的在前，只列有消息的日子；群聊为空。 */
  days: Array<{ date: string; who: Exclude<SparkDay, "none">; count: number }>;
  /** 统计时刻。 */
  at: string;
}

export interface MemorialInput {
  id: string;
  kind: ChatConversationKind;
  name: string;
  /** 好友：本机全部消息；群：现读到的那一批（可以是空的）。 */
  messages: readonly ChatMessage[];
  /** 群的总数从会话摘要来：采集时数过、正文丢掉了。 */
  messageCount: number;
  ownMessageCount: number;
}

// 凌晨 5 点前发的算前一天的「深夜」，和年度分享图的「最晚一次」一个口径
const NIGHT_EDGE_MINUTES = 5 * 60;
const EMOJI_CODES = new Set(CHAT_EMOJI.map(([code]) => code));
// ponytail: 只挡掉最常见的虚词，够挑出几个像样的高频词；要更准再换分词词典
const STOP_WORDS = new Set(("我们 你们 他们 她们 它们 自己 什么 怎么 这么 那么 这个 那个 这样 那样 这里 那里 就是 还是 但是 而且 因为 所以 如果 然后 已经 没有 不是 可以 可能 一个 一下 一点 知道 觉得 现在 时候 真的 还有 只是 不过 应该 一样 哪个 为什么 东西 好像 其实 起来 出来 一直 是不是 有没有 那种 这种 的话 感觉 直接 有点 不会 不要 需要 还要 一起 刚刚 今天 明天 昨天 http https www com douyin").split(" "));

export function buildChatMemorial(input: MemorialInput, selfId: string | null, spark: Spark | null, now: Date = new Date()): ChatMemorial {
  const group = input.kind === "group";
  const said = input.messages.filter((message) => message.type !== "system");
  const self = group ? selfId : resolveSelf(said, selfId, input.ownMessageCount);
  const selfKnown = group || self !== null || input.ownMessageCount <= 0;
  const own = (message: ChatMessage) => (self !== null && message.senderId === self) || /^(我|本人|自己)$/u.test(message.senderName?.trim() ?? "");
  const timed = said
    .map((message) => ({ message, at: message.sentAt ? new Date(message.sentAt) : null }))
    .filter((item): item is { message: ChatMessage; at: Date } => item.at !== null && !Number.isNaN(item.at.getTime()))
    .sort((left, right) => left.at.getTime() - right.at.getTime());

  // 群：摘要是采集那一刻数的，可能比这次现读到的还少（采集后才说的话），取大的
  const mineCount = group ? Math.max(input.ownMessageCount, said.filter(own).length)
    : selfKnown ? said.filter(own).length : Math.min(input.ownMessageCount, said.length);
  const total = group ? Math.max(input.messageCount, said.length, mineCount) : said.length;

  const hours = Array.from({ length: 24 }, () => 0);
  const byDay = new Map<string, { senders: Set<string>; mine: boolean; theirs: boolean; count: number }>();
  let latest: Date | null = null;
  for (const { message, at } of timed) {
    hours[at.getHours()] = (hours[at.getHours()] ?? 0) + 1;
    const night = (at.getHours() * 60 + at.getMinutes() - NIGHT_EDGE_MINUTES + 1440) % 1440;
    if (!latest || night >= (latest.getHours() * 60 + latest.getMinutes() - NIGHT_EDGE_MINUTES + 1440) % 1440) latest = at;
    const key = sparkDayKey(at);
    const day = byDay.get(key) ?? { senders: new Set<string>(), mine: false, theirs: false, count: 0 };
    day.count += 1;
    if (message.senderId?.trim()) day.senders.add(message.senderId.trim());
    // 没有发送者的消息（unknown 之类）只计条数，不算谁说过话，和火花一个口径
    if (own(message)) day.mine = true; else if (message.senderId?.trim()) day.theirs = true;
    byDay.set(key, day);
  }
  const peak = hours.reduce((best, value, hour) => (value > hours[best]! ? hour : best), 0);

  // 和火花一个口径：同一天出现两个不同的发送者算双方都发过（认出是我的那条可能只有名字没有 id）
  const days = [...byDay.entries()].map(([date, day]) => ({
    date,
    count: day.count,
    who: (day.senders.size >= 2 || (day.mine && day.theirs) ? "both" : !self ? "one" : day.mine ? "mine" : "theirs") as ChatMemorial["days"][number]["who"],
  }));
  let longestRun: ChatMemorial["longestRun"] = null;
  if (!group) {
    let run: { days: number; start: string; end: string } | null = null;
    for (const day of days) {
      if (day.who !== "both") { run = null; continue; }
      const prev = sparkDayKey(shiftDay(new Date(`${day.date}T12:00:00`), -1));
      run = run !== null && run.end === prev ? { days: run.days + 1, start: run.start, end: day.date } : { days: 1, start: day.date, end: day.date };
      if (!longestRun || run.days > longestRun.days) longestRun = run;
    }
  }
  // 群里只有最近一批消息，按天画格子、挑最热闹的一天都会误导，不给
  const busiest = group ? null : days.reduce<ChatMemorial["busiestDay"]>((best, day) => (!best || day.count > best.count ? { date: day.date, count: day.count } : best), null);

  const emoji = new Map<string, number>();
  for (const message of said) for (const code of message.text?.match(/\[[^[\]]{1,8}\]/gu) ?? []) if (EMOJI_CODES.has(code)) emoji.set(code, (emoji.get(code) ?? 0) + 1);

  const first = timed[0]?.at ?? null;
  const firstText = group ? null : timed.find(({ message }) => message.type === "text" && cleanLine(message.text));
  const shares = said.filter((message) => message.type === "share" || message.type === "comment");

  return {
    kind: input.kind,
    name: input.name,
    spark: sparkOf(spark),
    firstAt: group || !first ? null : first.toISOString(),
    lastAt: group || !timed.length ? null : timed[timed.length - 1]!.at.toISOString(),
    sinceDays: group || !first ? null : Math.round((shiftDay(now, 0).getTime() - shiftDay(first, 0).getTime()) / 86_400_000) + 1,
    total,
    mine: mineCount,
    theirs: Math.max(0, total - mineCount),
    selfKnown,
    sample: group ? said.length : null,
    activeDays: group ? null : byDay.size,
    mutualDays: group ? null : days.filter((day) => day.who === "both").length,
    longestRun,
    hours: timed.length ? hours : null,
    peakHour: timed.length ? peak : null,
    latest: latest ? latest.toISOString() : null,
    busiestDay: busiest,
    shares: { mine: shares.filter(own).length, theirs: shares.filter((message) => !own(message)).length },
    stickers: said.filter((message) => message.type === "sticker").length,
    images: said.filter((message) => message.type === "image").length,
    topEmoji: top(emoji, 3).map(([code, count]) => ({ code, count })),
    topWords: group ? [] : topWords(said),
    firstLine: firstText ? { text: cleanLine(firstText.message.text)!, mine: selfKnown ? own(firstText.message) : null, at: firstText.at.toISOString() } : null,
    days: group ? [] : days,
    at: now.toISOString(),
  };
}

/** 隐私模式：名字换成「好友 / 群聊」，词和第一句话这种带正文的都拿掉。 */
export function scrubMemorial(memorial: ChatMemorial): ChatMemorial {
  return { ...memorial, name: memorial.kind === "group" ? "群聊" : "好友", topWords: [], firstLine: null };
}

// 全局按「谁在所有会话里说得最多」认出的 selfId 偶尔会错（只有一个会话、对方话更多时会把对方当成我），
// 也可能是 null。采集器知道真正的账号，每个会话数了「我发了几条」（偶尔比本机多一两条，像撤回的）：
// selfId 的条数和它差不多一样接近就用 selfId，否则哪个发送者最接近它就是我；两个一样接近就认不出。
function resolveSelf(messages: readonly ChatMessage[], selfId: string | null, own: number): string | null {
  if (own <= 0) return selfId;
  const counts = new Map<string, number>();
  for (const message of messages) {
    const sender = message.senderId?.trim();
    if (sender) counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }
  const gap = (sender: string) => Math.abs((counts.get(sender) ?? 0) - own);
  const ranked = [...counts.keys()].sort((left, right) => gap(left) - gap(right));
  const best = ranked[0];
  if (best === undefined) return selfId;
  if (selfId && counts.has(selfId) && gap(selfId) <= gap(best) + Math.min(3, Math.max(1, Math.round(own * 0.1)))) return selfId;
  return ranked[1] === undefined || gap(best) < gap(ranked[1]) ? best : null;
}

function sparkOf(spark: Spark | null): ChatMemorial["spark"] {
  if (!spark) return null;
  const official = spark.official !== undefined;
  // 本机估算的、还没连满三天的不算火花
  if (!official && spark.state !== "broken" && spark.days < SPARK_LIT_DAYS) return null;
  return { days: spark.days, text: spark.official ?? String(spark.days), official, state: spark.state, brokeOn: spark.brokeOn, today: spark.today };
}

function topWords(messages: readonly ChatMessage[]): ChatMemorial["topWords"] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return [];
  const segmenter = new Segmenter("zh-CN", { granularity: "word" });
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.type !== "text" || !message.text) continue;
    const text = message.text.replace(/https?:\/\/\S+/gu, " ").replace(/\[[^[\]]{1,8}\]/gu, " ");
    for (const { segment, isWordLike } of segmenter.segment(text)) {
      const word = segment.trim().toLowerCase();
      if (!isWordLike || Array.from(word).length < 2 || /^\d+$/u.test(word) || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  // 只出现一次的不算「高频」
  return top(counts, 5).filter(([, count]) => count >= 2).map(([word, count]) => ({ word, count }));
}

function top(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN")).slice(0, limit);
}

function cleanLine(text: string | null): string | null {
  const line = text?.replace(/\s+/gu, " ").trim();
  return line && !/^\[(?:图片|表情包|分享|通话)\]$/u.test(line) ? line : null;
}
