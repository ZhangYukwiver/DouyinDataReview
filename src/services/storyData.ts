import type { ReportModel } from "../components/workspace/ReportWorkspace";
import { hasChatShareEvidence } from "../domain/chatRecords";
import type { ChatConversationSummary, ChatMessage } from "../domain/chatRecords";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../domain/personalRecords";

// One JSON snapshot handed to the static story page (public/story) through same-origin localStorage.
export const STORY_STORAGE_KEY = "content-insights.story";

export interface StoryRanked { name: string; count: number; share: number }
export interface StoryCard { title: string; author: string | null; coverUrl: string | null; url: string | null; kind: "liked" | "favorite" | "watch" }
/** A ranked tag plus the one card that carries it, so the roll can put a related cover under each headline. */
export interface StoryTopic extends StoryRanked { card: StoryCard | null }
export interface StoryConversation { name: string; kind: ChatConversationSummary["kind"]; avatarUrl: string | null; messageCount: number; ownMessageCount: number }
export interface StoryHeatRef { title: string; count: number; url: string | null }
/** Popularity of the content itself (like counts as recorded), never a claim about the person. */
export interface StoryHeat { sampled: number; median: number; hottest: StoryHeatRef; quietest: StoryHeatRef }
/** How old a piece of content already was when the person acted on it. */
export interface StoryAge { sampled: number; medianDays: number; bands: Array<{ label: string; share: number }> }
export interface StoryLength { seconds: number; medianDuration: number | null; longest: { title: string; seconds: number } | null }
export interface StoryChat {
  friendMessages: number;
  callSeconds: number;
  conversations: number;
  /** text / image / share / sticker / call·voice, in the order the page draws them. */
  forms: Array<{ code: string; label: string; count: number; share: number }>;
  top: StoryConversation[];
  share: { title: string | null; author: string | null; coverUrl: string | null; url: string | null } | null;
}

/** One topic term (an explicit hashtag) or one chat word, counted once per record. */
export interface StoryTerm { name: string; count: number; share: number }
export interface StoryTermField {
  total: number;
  /** Records that carry at least one usable term. */
  sampled: number;
  distinct: number;
  top: StoryTerm[];
  /** Share of sampled records mentioning any of the top terms. */
  coverage: number;
  /** How many terms it takes to reach half the sampled records — smaller means more concentrated. */
  halfAt: number | null;
  /** Records dropped before counting (chat boilerplate); always 0 for hashtag sources. */
  excluded: number;
}
export interface StoryLexicon {
  watch: StoryTermField;
  liked: StoryTermField;
  favorite: StoryTermField;
  /** Chat words; null for archive imports and where the browser has no segmenter. */
  chat: StoryTermField | null;
  /** Hashtags on the video cards friends shared; null for archive imports. */
  shared: StoryTermField | null;
  contrast: { both: string[]; sharedOnly: string[]; likedOnly: string[] } | null;
}
export interface StoryFieldCoverage { label: string; count: number; base: number; share: number }

export interface StoryData {
  version: 1;
  generatedAt: string;
  year: number;
  status: ReportModel["status"];
  source: { kind: "collector" | "archive"; updatedAt: string | null; parsedFileCount: number | null; ignoredFileCount: number | null };
  counts: { watch: number; liked: number; favorite: number; chat: number | null; events: number };
  unique: number;
  activeDays: number;
  range: [string, string] | null;
  months: number[];
  hours: number[];
  /** Reliable records per calendar day, ascending — the calendar in chapter 02 is drawn from this. */
  days: Array<[string, number]>;
  peakHour: number | null;
  peakDay: string | null;
  timeSources: { platform_action: number; archive_action: number; unknown: number };
  intersection: ReportModel["intersection"];
  /** Shares of watched records finishing ≥90% / 30–90% / <30%; null without progress data. */
  progress: { done: number; mid: number; shallow: number } | null;
  recent: StoryCard[];
  topTopic: StoryRanked | null;
  topics: StoryTopic[];
  topCreator: { name: string; unique: number; avatarUrl: string | null } | null;
  topicsCount: number;
  creators: StoryRanked[];
  creatorsCount: number;
  musics: Array<{ title: string; author: string | null; count: number }>;
  musicsCount: number;
  heat: StoryHeat | null;
  age: StoryAge | null;
  length: StoryLength;
  /** 视频 / 图文 / 直播 shares among records with a known mediaType. */
  media: Array<{ label: string; share: number }> | null;
  /** <1 min / 1–10 min / 10+ min shares among records with a duration. */
  durations: Array<{ label: string; share: number }> | null;
  music: { title: string; author: string | null; count: number } | null;
  chat: StoryChat | null;
  lexicon: StoryLexicon;
  /** How many records actually carry each field the story leans on. */
  fields: StoryFieldCoverage[];
  reliableRatio: number;
  caveats: { noTime: number; noVideoId: number; warnings: number };
  /** title/english = 三个词的落款；name/reading = 这三个词合起来的名字和一段读法。 */
  profile: { title: string; english: string; name: string; nameEnglish: string; reading: string };
}

export interface StoryInput {
  records: PersonalRecordCollection;
  chatMessages: ChatMessage[];
  chatConversations: ChatConversationSummary[];
  source: "collector" | "archive";
  updatedAt: string | null;
  warnings: string[];
  archive?: { parsedFileCount: number; ignoredFileCount: number } | null;
}

type Row = { record: PersonalVideoRecord; type: keyof PersonalRecordCollection };

export function buildStoryData(model: ReportModel, input: StoryInput): StoryData {
  const { records } = input;
  const rows: Row[] = (["watch_history", "liked_videos", "favorite_videos"] as const).flatMap((type) => records[type].map((record) => ({ record, type })));
  const timeSources = { platform_action: 0, archive_action: 0, unknown: 0 };
  const reliable: Array<{ row: Row; time: number }> = [];
  for (const row of rows) {
    const time = validTime(row.record.occurredAt);
    if (time === null || row.record.occurredAtSource === "unknown") timeSources.unknown += 1;
    else if (row.record.occurredAtSource === "archive_action") { timeSources.archive_action += 1; reliable.push({ row, time }); }
    else { timeSources.platform_action += 1; reliable.push({ row, time }); }
  }
  const times = reliable.map((item) => item.time);
  const range: StoryData["range"] = times.length ? [isoDay(Math.min(...times)), isoDay(Math.max(...times))] : null;
  const perDay = new Map<string, number>();
  for (const { time } of reliable) perDay.set(isoDay(time), (perDay.get(isoDay(time)) ?? 0) + 1);
  const peakDay = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const progress = model.progressPercents;
  const bands = progress.length
    ? {
        done: progress.filter((value) => value >= 90).length / progress.length,
        mid: progress.filter((value) => value >= 30 && value < 90).length / progress.length,
        shallow: progress.filter((value) => value < 30).length / progress.length,
      }
    : null;

  const topCreatorName = model.creators[0]?.name ?? null;
  const creatorRows = topCreatorName ? rows.filter(({ record }) => record.author?.trim() === topCreatorName) : [];
  const topCreator = topCreatorName
    ? { name: topCreatorName, unique: new Set(creatorRows.map(({ record }) => recordKey(record))).size, avatarUrl: creatorRows.find(({ record }) => record.authorAvatarUrl)?.record.authorAvatarUrl ?? null }
    : null;

  const known = rows.filter(({ record }) => record.mediaType === "video" || record.mediaType === "image" || record.mediaType === "live");
  const media = shares(known.map(({ record }) => record.mediaType), [["视频", (value) => value === "video"], ["图文", (value) => value === "image"], ["直播", (value) => value === "live"]]);
  const lengths = rows.map(({ record }) => record.durationSeconds).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const durations = shares(lengths, [["< 1 分钟", (value) => value < 60], ["1–10 分钟", (value) => value >= 60 && value < 600], ["10 分钟以上", (value) => value >= 600]]);

  const musicCounts = new Map<string, { title: string; author: string | null; count: number }>();
  for (const { record } of rows) {
    const title = record.music?.title?.trim();
    if (!title) continue;
    const key = record.music?.id?.trim() || title;
    const entry = musicCounts.get(key) ?? { title, author: record.music?.author?.trim() || null, count: 0 };
    entry.count += 1;
    musicCounts.set(key, entry);
  }
  const musics = [...musicCounts.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "zh-CN"));
  const topMusic = musics[0] ?? null;

  // one entry per content; like counts are a property of the content, so they are reported as a snapshot only
  const heatById = new Map<string, StoryHeatRef>();
  for (const { record } of rows) {
    const count = record.stats?.diggCount;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0 || heatById.has(recordKey(record))) continue;
    heatById.set(recordKey(record), { title: record.title?.trim() || "未命名内容", count, url: record.url ?? null });
  }
  const heats = [...heatById.values()].sort((a, b) => a.count - b.count);
  const hottest = heats[heats.length - 1], quietest = heats[0];
  const heat: StoryHeat | null = hottest && quietest ? { sampled: heats.length, median: median(heats.map((item) => item.count)), hottest, quietest } : null;

  const ages = reliable.map(({ row, time }) => { const published = validTime(row.record.publishedAt); return published === null ? null : (time - published) / 86_400_000; }).filter((value): value is number => value !== null && value >= 0);
  const age: StoryAge | null = ages.length ? { sampled: ages.length, medianDays: Math.round(median(ages)), bands: shares(ages, [["一周内", (value) => value <= 7], ["三个月内", (value) => value > 7 && value <= 90], ["更早", (value) => value > 90]])! } : null;

  const friend = friendMessages(input.chatMessages, input.chatConversations);
  const watchTerms = records.watch_history.map(termsOf);
  const likedTerms = records.liked_videos.map(termsOf);
  const shareCards = input.source === "collector" ? friend.filter((message) => hasChatShareEvidence(message.share)) : [];
  const sharedTerms = shareCards.map((message) => hashtags(message.share?.title));
  const shared = input.source === "collector" ? termField(sharedTerms, shareCards.length) : null;
  const likedField = termField(likedTerms, records.liked_videos.length);
  const lexicon: StoryLexicon = {
    watch: termField(watchTerms, records.watch_history.length),
    liked: likedField,
    favorite: termField(records.favorite_videos.map(termsOf), records.favorite_videos.length),
    chat: input.source === "collector" ? chatField(friend) : null,
    shared,
    // a comparison needs both sides to have enough records to be worth reading
    contrast: shared && shared.sampled >= 10 && likedField.sampled >= 10 ? contrastOf(rankTerms(likedTerms), rankTerms(sharedTerms)) : null,
  };

  const progressRows = records.watch_history.filter((record) => typeof record.watchProgress?.percent === "number" || typeof record.watchProgress?.watchedSeconds === "number");
  const fields: StoryFieldCoverage[] = ([
    ["行为时间", reliable.length, rows.length],
    ["作品 ID", rows.filter(({ record }) => Boolean(record.videoId)).length, rows.length],
    ["话题标签", rows.filter(({ record }) => termsOf(record).length > 0).length, rows.length],
    ["时长", lengths.length, rows.length],
    ["发布时间", rows.filter(({ record }) => validTime(record.publishedAt) !== null).length, rows.length],
    ["点赞数", rows.filter(({ record }) => typeof record.stats?.diggCount === "number" && Number.isFinite(record.stats.diggCount)).length, rows.length],
    ["已看进度", progressRows.length, records.watch_history.length],
  ] as Array<[string, number, number]>).map(([label, count, base]) => ({ label, count, base, share: base ? count / base : 0 }));

  const pool = cardPool(records), usedCards = new Set<string>();
  // all ten ranked tags, not eight: the roll drops compound tags (高达模型 next to 模型) and fills the gap from further down
  const topics: StoryTopic[] = model.topics.map((topic) => ({ ...topic, card: topicCard(pool, topic.name, usedCards) }));
  const longestRow = rows.filter(({ record }) => typeof record.durationSeconds === "number" && Number.isFinite(record.durationSeconds)).sort((a, b) => b.record.durationSeconds! - a.record.durationSeconds!)[0];
  const length: StoryLength = { seconds: model.attentionSeconds, medianDuration: lengths.length ? median(lengths) : null, longest: longestRow ? { title: longestRow.record.title?.trim() || "未命名内容", seconds: longestRow.record.durationSeconds! } : null };

  const data: Signed = {
    version: 1,
    generatedAt: new Date().toISOString(),
    // The volume is dated by its latest reliable record, not by the report window.
    year: range ? Number(range[1].slice(0, 4)) : model.year,
    status: model.status,
    source: { kind: input.source, updatedAt: input.updatedAt, parsedFileCount: input.archive?.parsedFileCount ?? null, ignoredFileCount: input.archive?.ignoredFileCount ?? null },
    counts: { watch: model.watch, liked: model.liked, favorite: model.favorite, chat: input.source === "collector" ? model.chat : null, events: rows.length },
    unique: model.unique,
    activeDays: model.activeDays,
    range,
    months: model.months,
    hours: model.hours,
    days: [...perDay].sort((a, b) => a[0].localeCompare(b[0])),
    peakHour: model.peakHour,
    peakDay,
    timeSources,
    intersection: model.intersection,
    progress: bands,
    recent: recentCards(pool),
    topTopic: model.topics[0] ?? null,
    topics,
    topCreator,
    media,
    durations,
    music: topMusic && topMusic.count >= 2 ? topMusic : null,
    topicsCount: new Set(rows.flatMap(({ record }) => record.topics ?? [])).size,
    creators: model.creators.slice(0, 5),
    creatorsCount: model.creatorsCount,
    musics: musics.filter((item) => item.count >= 2).slice(0, 3),
    musicsCount: musicCounts.size,
    heat,
    age,
    length,
    chat: input.source === "collector" ? chatSummary(input.chatMessages, input.chatConversations) : null,
    lexicon,
    fields,
    reliableRatio: model.reliableRatio,
    caveats: { noTime: timeSources.unknown, noVideoId: rows.filter(({ record }) => !record.videoId).length, warnings: input.warnings.length },
  };
  // The badge title from the report is deliberately left out: the volume signs itself.
  return { ...data, profile: storySignature(data) };
}

/**
 * 落款 = 三个词，一个列表出一个：什么时候看、看的是什么、看完怎么处理。
 * Ordinary words picked by the snapshot, not a badge and not a verdict on the person.
 */
type Signed = Omit<StoryData, "profile">;
type Word = { zh: string; en: string; test: (data: Signed) => boolean };

const WHEN = [
  { from: 0, zh: "凌晨", en: "SMALL HOURS" },
  { from: 5, zh: "清晨", en: "FIRST LIGHT" },
  { from: 9, zh: "上午", en: "MORNING" },
  { from: 12, zh: "正午", en: "MIDDAY" },
  { from: 14, zh: "午后", en: "AFTERNOON" },
  { from: 18, zh: "傍晚", en: "DUSK" },
  { from: 21, zh: "夜里", en: "AFTER DARK" },
];
const ANY_HOUR = { zh: "不定", en: "NO FIXED HOUR" };

const WHAT: Word[] = [
  { zh: "图文", en: "STILLS", test: (data) => bandShare(data.media, "图文") >= 0.3 },
  { zh: "长镜", en: "LONG TAKES", test: (data) => bandShare(data.durations, "10 分钟以上") >= 0.2 },
  { zh: "碎片", en: "FRAGMENTS", test: (data) => bandShare(data.durations, "< 1 分钟") >= 0.5 },
  { zh: "同一题", en: "ONE SUBJECT", test: (data) => (data.topTopic?.share ?? 0) >= 0.15 },
  { zh: "四面八方", en: "ALL DIRECTIONS", test: (data) => data.topicsCount >= 30 },
];
const ANY_CONTENT = { zh: "寻常", en: "THE ORDINARY" };

const HOW: Word[] = [
  { zh: "留到结尾", en: "TO THE END", test: (data) => (data.progress?.done ?? 0) >= 0.5 },
  { zh: "留一份", en: "KEPT A COPY", test: (data) => share(data.counts.favorite, data.unique) >= 0.08 },
  { zh: "留个记号", en: "A MARK LEFT", test: (data) => share(data.counts.liked, data.unique) >= 0.25 },
  { zh: "递给朋友", en: "PASSED ALONG", test: (data) => (data.chat?.forms.find((form) => form.code === "share")?.count ?? 0) >= 20 },
];
const ANY_HABIT = { zh: "不作停留", en: "PASSING THROUGH" };

function share(part: number, whole: number): number { return whole > 0 ? part / whole : 0; }
function bandShare(bands: Array<{ label: string; share: number }> | null, label: string): number {
  return bands?.find((band) => band.label === label)?.share ?? 0;
}

/**
 * 组合名：看的是什么 × 看完留下什么 决定名字，时候出前缀，读作「夜行的过路客」。
 * 这是对三个词的读法，不是对人的判断——写的是行为的样子，不评价好坏。
 */
const NAMES: Record<string, { name: string; english: string; reading: string }> = {
  "图文|留到结尾": { name: "末页客", english: "THE LAST PAGE", reading: "图文没有进度条，停在哪一页全看自己。你多半一页页翻到最后一张，把最后那句话也读完，才退出来看下一条。" },
  "图文|留一份": { name: "装订工", english: "THE BINDER", reading: "图文是存得住的东西，一张图、几行字都停在原地。看着不错的你会收下来，散开的页就这样一册册攒起来。" },
  "图文|留个记号": { name: "折角人", english: "THE FOLDED CORNER", reading: "读到某一页，觉得说到自己了，就点一下，像把书角折过去。折过的那些页都在赞里排着，是当时觉得对的几张。" },
  "图文|递给朋友": { name: "邮差", english: "THE POSTCARD", reading: "图文截下来就能发，一整条读完也就那么几张图。合适的那几张你转进对话框，让人接着往下看。" },
  "图文|不作停留": { name: "翻页手", english: "TURNING PAGES", reading: "图文翻得快，一屏说一件事，看明白就往下走。你很少停下来做点什么，这一页翻过去，下一页接上。" },
  "长镜|留到结尾": { name: "片尾常客", english: "ROLLING CREDITS", reading: "长片子你多半整段看下来，中途很少跳走，等它放完了才起身。这一年花掉的时间，大都落在这种一段一段的内容上。" },
  "长镜|留一份": { name: "存片员", english: "THE ARCHIVIST", reading: "长的片子看得慢，中意的就收下来，放进自己那份片单。片单里排着的，多是要坐下来看上一阵的长东西。" },
  "长镜|留个记号": { name: "按印人", english: "THE THUMBPRINT", reading: "你看的多是要花时间的片子，看的时候不怎么动手，合意的到末尾按一下赞。像在长长的一段后面摁个指印。" },
  "长镜|递给朋友": { name: "放映师", english: "THE PROJECTIONIST", reading: "长的内容你看得多，碰上对味的第一件事是转给朋友，还捎上一句，让人家也看看。片子在你这儿放完一遍，再放给别人一遍。" },
  "长镜|不作停留": { name: "离席者", english: "THE EMPTY SEAT", reading: "长的片子你一段一段地看，看完就走：不按赞，不收藏，也不转给谁。这一年时间花在片子上，记录里的动作不多。" },
  "碎片|留到结尾": { name: "末帧人", english: "THE FULL CLIP", reading: "东西不长，你也很少中途划走，多半让它走到最后一帧再翻下一条。一天里过眼的不少，大都是从头看到尾的。" },
  "碎片|留一份": { name: "挑拣手", english: "THE SIEVE", reading: "短片一条完了接下一条，你伸手拦下的不少：看对眼的就收进自己的柜子。柜子里攒的，多是这么从一长串里拿下来的。" },
  "碎片|留个记号": { name: "盖章员", english: "THE QUICK STAMP", reading: "你翻得快，手也跟着快，看中的按一下就过，不多停也不多说。一路刷下来，那些短东西上留了一串连着的戳。" },
  "碎片|递给朋友": { name: "传阅者", english: "HAND TO HAND", reading: "有意思的东西在你这儿停不久，看完随手就发进对话框。一年里不少条是这么从你手里过去的，短东西传得也快。" },
  "碎片|不作停留": { name: "过路客", english: "THE UNSIGNED VISIT", reading: "内容一路往下滑，你看完就翻下一条，很少回头再点个什么。这一年从眼前过去的东西不少，动手的次数不多。" },
  "同一题|留到结尾": { name: "追更客", english: "STRAIGHT THROUGH", reading: "你总回到同一路题材，也很少中途走开：一条看完再接一条，像追一部没完的连载，每次都追到那一集的末尾。" },
  "同一题|留一份": { name: "抄书匠", english: "THE COPYIST", reading: "你在同一路东西里来回挑，碰上对的就存一份，像把喜欢的篇目一页页抄进自己的本子。本子翻开，前后都是一路的东西。" },
  "同一题|留个记号": { name: "结绳人", english: "THE KNOTTED CORD", reading: "你看的多是同一类，看过按一下，算给自己记一笔。不特意存着，也不多说什么，一路按下来的那些，前后都在一条线上。" },
  "同一题|递给朋友": { name: "牵线手", english: "WORD OF MOUTH", reading: "同一路内容你看得熟，碰上合适的就转出去；想起哪个朋友，就把那条送过去。来回几次，你常看的那一路也走到了别人那儿。" },
  "同一题|不作停留": { name: "巡线员", english: "THE SAME LINE", reading: "你走的差不多是同一条线，题材反复落在一处；看过之后不按不存，多数也没到结尾。路是熟路，看完就接着走下一条。" },
  "四面八方|留到结尾": { name: "逛展者", english: "WALKS EVERY ROOM", reading: "你什么都点开，题材换来换去，但很少中途退出：一条看到完才松手。像在展厅里挨个房间走，每间都走到头，再拐进一间完全不相干的。" },
  "四面八方|留一份": { name: "收纳手", english: "THE ODD SHELF", reading: "你看的东西五花八门，遇上顺眼的就存起来。日子久了，收藏架上什么都放着一点，上一格和下一格常常不搭界。" },
  "四面八方|留个记号": { name: "垒石人", english: "THE CAIRN", reading: "你几乎什么类型都进去转一圈，临走按一下。一年下来，这些赞落在互不相干的地方，像走山路时沿途垒下的一小堆一小堆石头。" },
  "四面八方|递给朋友": { name: "二传手", english: "THE RELAY", reading: "这边刷到一条，那边就发给可能用得上的人。转出去的东西彼此毫不相干，凑在一起才看得出你都逛过哪儿。" },
  "四面八方|不作停留": { name: "穿堂风", english: "THE CROSS BREEZE", reading: "你从一个类型穿到下一个，看过就滑走，很少回头。像屋子两头的门都开着，风从这头进、那头出，中间少有东西留在手上。" },
  "寻常|留到结尾": { name: "打烊客", english: "CLOSING TIME", reading: "你看的多是寻常东西，题材上没有明显偏向；可既然点开了，就一路看到最后，像店里最后走的那位客人，等灯灭了才起身。" },
  "寻常|留一份": { name: "压箱手", english: "THE BOTTOM DRAWER", reading: "你看的都是寻常内容，看着往后用得上的就存下来。存下的多是当时想着还会再翻一翻的那种，先压在箱底。" },
  "寻常|留个记号": { name: "点头人", english: "THE QUIET NOD", reading: "你看的东西说不上偏爱哪一类，寻常内容居多。看完不多说什么，按一下就过去了，像迎面走过时点了个头，算应过一声。" },
  "寻常|递给朋友": { name: "货郎", english: "DOOR TO DOOR", reading: "你看的都是寻常内容，可看着看着会想起某个人，就把它发过去。发出去那一下，更像顺手打个招呼。" },
  "寻常|不作停留": { name: "空手客", english: "TOOK NOTHING HOME", reading: "寻常内容一条接着一条过去，你很少停下来做点什么，看完就翻下一条。这一年看过的东西不少，手上一直是空的。" },
};

const PREFIXES: Record<string, { prefix: string; opening: string }> = {
  "凌晨": { prefix: "夜半", opening: "这一年大半的时候都在零点以后，屋里灯已经关了，只剩屏幕这点亮。" },
  "清晨": { prefix: "清早", opening: "这一年常常从天刚亮时开始，你醒了还没起身，先看上一会儿。" },
  "上午": { prefix: "上午", opening: "这一年主要落在上午，一天的事刚起头，你在两件事之间腾出几分钟。" },
  "正午": { prefix: "午间", opening: "这一年多集中在正午前后，饭在手边，你在这段空当里翻上一阵。" },
  "午后": { prefix: "午后", opening: "这一年大都在午后展开，光斜过桌面，你把一天里最松快的一段留在这儿。" },
  "傍晚": { prefix: "日落", opening: "这一年多半在天黑前后，路灯刚亮，一天的事收了尾，你才腾出手。" },
  "夜里": { prefix: "夜行", opening: "这一年的多数时候在夜里，等家里安静下来，你才打开来看。" },
  "不定": { prefix: "不定时", opening: "这一年没有固定的钟点，你什么时候都可能打开，白天有，深夜也有。" },
};

/** The lists the name table has to cover, in display order. Exported for the coverage check. */
export const SIGNATURE_WORDS = {
  when: [...WHEN.map((item) => item.zh), ANY_HOUR.zh],
  what: [...WHAT.map((item) => item.zh), ANY_CONTENT.zh],
  how: [...HOW.map((item) => item.zh), ANY_HABIT.zh],
};

export function signatureName(when: string, what: string, how: string): { name: string; english: string; reading: string } {
  const named = NAMES[`${what}|${how}`];
  const stamp = PREFIXES[when];
  if (!named || !stamp) return { name: "无名的一卷", english: "UNNAMED VOLUME", reading: "这一年的记录还认不出一个名字来。" };
  return { name: `${stamp.prefix}的${named.name}`, english: named.english, reading: `${stamp.opening}${named.reading}` };
}

export function storySignature(data: Signed): StoryData["profile"] {
  const hour = data.peakHour;
  const when = (hour === null ? null : WHEN.filter((item) => hour >= item.from).pop()) ?? ANY_HOUR;
  const what = WHAT.find((item) => item.test(data)) ?? ANY_CONTENT;
  const how = HOW.find((item) => item.test(data)) ?? ANY_HABIT;
  const named = signatureName(when.zh, what.zh, how.zh);
  return {
    title: `${when.zh} · ${what.zh} · ${how.zh}`,
    english: `${when.en} · ${what.en} · ${how.en}`,
    name: named.name,
    nameEnglish: named.english,
    reading: named.reading,
  };
}

export function writeStoryData(data: StoryData, storage = globalThis.localStorage): void {
  try { storage?.setItem(STORY_STORAGE_KEY, JSON.stringify(data)); } catch { /* private mode: the page falls back to its demo numbers */ }
}

export function clearStoryData(storage = globalThis.localStorage): void {
  try { storage?.removeItem(STORY_STORAGE_KEY); } catch { /* nothing stored */ }
}

type TaggedRecord = { record: PersonalVideoRecord; kind: StoryCard["kind"] };
// Kept items first (liked + favorite, latest first), then watches, latest first.
function cardPool(records: PersonalRecordCollection): TaggedRecord[] {
  const byTime = (list: TaggedRecord[]) => list.slice().sort((a, b) => (validTime(b.record.occurredAt) ?? 0) - (validTime(a.record.occurredAt) ?? 0));
  return [
    ...byTime([...records.liked_videos.map((record) => ({ record, kind: "liked" as const })), ...records.favorite_videos.map((record) => ({ record, kind: "favorite" as const }))]),
    ...byTime(records.watch_history.map((record) => ({ record, kind: "watch" as const }))),
  ];
}
const toCard = ({ record, kind }: TaggedRecord): StoryCard => ({ title: record.title?.trim() || "未命名内容", author: record.author?.trim() || null, coverUrl: record.coverUrl ?? null, url: record.url ?? null, kind });

// The latest four contents, one card each.
function recentCards(pool: TaggedRecord[]): StoryCard[] {
  const seen = new Set<string>();
  const cards: StoryCard[] = [];
  for (const item of pool) {
    if (cards.length >= 4) break;
    const key = recordKey(item.record);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(toCard(item));
  }
  return cards;
}

// The card that carries a tag: one not already given to an earlier tag first (a hashtag-heavy video must not fill the whole roll),
// then a real cover over a bare one, a tag visible in the title over a structured-only one, then the latest.
function topicCard(pool: TaggedRecord[], topic: string, used: Set<string>): StoryCard | null {
  const key = topic.toLowerCase();
  const has = (terms: string[]) => terms.some((term) => term.toLowerCase() === key);
  let best: { item: TaggedRecord; score: number } | null = null;
  for (const item of pool) {
    if (!has(termsOf(item.record))) continue;
    const score = (used.has(recordKey(item.record)) ? 0 : 4) + (item.record.coverUrl ? 2 : 0) + (has(hashtags(item.record.title)) ? 1 : 0);
    if (!best || score > best.score) best = { item, score };
  }
  if (!best) return null;
  used.add(recordKey(best.item.record));
  return toCard(best.item);
}

function chatSummary(messages: ChatMessage[], conversations: ChatConversationSummary[]): StoryChat {
  const groupIds = new Set(conversations.filter((conversation) => conversation.kind === "group").map((conversation) => conversation.id));
  const friend = messages.filter((message) => message.conversationType !== "group" && (!message.conversationId || !groupIds.has(message.conversationId)));
  const forms: Array<[string, string, (message: ChatMessage) => boolean]> = [
    ["text", "文字", (message) => message.type === "text"],
    ["image", "图片", (message) => message.type === "image"],
    ["share", "分享", (message) => message.type === "share" || message.type === "comment"],
    ["sticker", "表情", (message) => message.type === "sticker"],
    ["call · voice", "通话 / 语音", (message) => message.type === "call" || message.type === "voice"],
  ];
  const share = friend.find((message) => message.share && (message.share.title || message.share.coverUrl))?.share ?? null;
  return {
    friendMessages: friend.length,
    callSeconds: friend.reduce((total, message) => total + (typeof message.callDurationSeconds === "number" && Number.isFinite(message.callDurationSeconds) && message.callDurationSeconds > 0 ? message.callDurationSeconds : 0), 0),
    conversations: conversations.length,
    forms: forms.map(([code, label, test]) => { const count = friend.filter(test).length; return { code, label, count, share: friend.length ? count / friend.length : 0 }; }),
    top: conversations.slice().sort((a, b) => b.messageCount - a.messageCount).slice(0, 3).map((conversation) => ({
      name: conversation.name?.trim() || (conversation.kind === "group" ? "未命名群聊" : "未命名会话"),
      kind: conversation.kind,
      avatarUrl: conversation.avatarUrl ?? null,
      messageCount: conversation.messageCount,
      ownMessageCount: conversation.ownMessageCount,
    })),
    share: share ? { title: share.title, author: share.author, coverUrl: share.coverUrl, url: share.url } : null,
  };
}

// ---- lexicon: explicit hashtags for video records, browser word segmentation for chat ----

const TOPIC_PATTERN = /#([^#\s,，。.!！?？:：;；]{1,50})/gu;
const HAN = /^\p{Script=Han}+$/u;
// enough of the spoken filler to keep the chat list readable; a word list dependency would be heavier than the feature
const CHAT_STOPWORDS = new Set(
  ("的 了 是 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 这些 那些 在 有 和 与 及 或 就 都 也 还 又 很 太 更 最 不 没 没有 要 会 能 可以 可能 应该 把 被 让 给 对 从 到 向 于 为 以 用 跟 比 " +
   "吧 吗 呢 啊 哦 呀 嗯 哈 哈哈 哈哈哈 嘿 哎 唉 呃 哇 噢 嗯嗯 好 好的 好了 行 可 而 但 但是 因为 所以 如果 然后 还是 或者 什么 怎么 怎样 为什么 哪 哪里 谁 多少 几 " +
   "一个 一下 一些 一点 一起 一样 已经 现在 今天 明天 昨天 时候 一直 只是 就是 不是 而且 这样 那样 这么 那么 自己 大家 我的 你的 他的 视频 抖音 分享 看看 来看 一定 " +
   "真的 感觉 觉得 知道 看到 看了 有点 不要 不能 不会 直接 出来 起来 过来 回来 下来 上来 出去 进去 才 再 只 每 各 另 某 其 之 者 所 着 过 得 地 啦 嘛 咯 哟 呗 喔 嘞 " +
   "还有 非常 我要 你要 我看 我有 都没 不了 不知道 也是 都是 我是 给我 其实 结果 本来 时间").split(" "),
);

type TermRank = { key: string; name: string; count: number };

function hashtags(text: string | null | undefined): string[] {
  const found: string[] = [];
  for (const match of (text ?? "").matchAll(TOPIC_PATTERN)) { const term = match[1]?.trim(); if (term) found.push(term); }
  return found;
}

/** Explicit topic tags only: segmenting a title would cut game and product names in half. */
function termsOf(record: PersonalVideoRecord): string[] {
  const terms: string[] = [];
  for (const raw of [...(record.topics ?? []), ...hashtags(record.title)]) {
    const term = String(raw).replace(/^#/u, "").trim();
    if (term && !terms.some((item) => item.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  return terms;
}

// A term counts once per record, so a count reads as "how many records mention it".
function rankTerms(docs: string[][]): TermRank[] {
  const counts = new Map<string, TermRank>();
  for (const terms of docs) {
    const seen = new Set<string>();
    for (const term of terms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { key, name: term, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

function termField(docs: string[][], total: number, excluded = 0): StoryTermField {
  const sampled = docs.filter((terms) => terms.length > 0).map((terms) => new Set(terms.map((term) => term.toLowerCase())));
  const ranked = rankTerms(docs);
  const topKeys = new Set(ranked.slice(0, 12).map((item) => item.key));
  const share = (count: number) => (sampled.length ? count / sampled.length : 0);
  const hit = sampled.map(() => false);
  let covered = 0;
  let halfAt: number | null = null;
  for (let index = 0; index < ranked.length && sampled.length; index += 1) {
    const key = ranked[index]!.key;
    sampled.forEach((terms, position) => { if (!hit[position] && terms.has(key)) { hit[position] = true; covered += 1; } });
    if (covered * 2 >= sampled.length) { halfAt = index + 1; break; }
  }
  return {
    total,
    sampled: sampled.length,
    distinct: ranked.length,
    top: ranked.slice(0, 12).map((item) => ({ name: item.name, count: item.count, share: share(item.count) })),
    coverage: share(sampled.filter((terms) => [...terms].some((key) => topKeys.has(key))).length),
    halfAt,
    excluded,
  };
}

function contrastOf(liked: TermRank[], shared: TermRank[]): StoryLexicon["contrast"] {
  const keysOf = (list: TermRank[], size: number) => new Set(list.slice(0, size).map((item) => item.key));
  const sharedTop = keysOf(shared, 30), sharedWide = keysOf(shared, 100), likedWide = keysOf(liked, 100);
  return {
    both: liked.slice(0, 30).filter((item) => sharedTop.has(item.key)).slice(0, 4).map((item) => item.name),
    sharedOnly: shared.slice(0, 30).filter((item) => !likedWide.has(item.key)).slice(0, 4).map((item) => item.name),
    likedOnly: liked.slice(0, 30).filter((item) => !sharedWide.has(item.key)).slice(0, 4).map((item) => item.name),
  };
}

function friendMessages(messages: ChatMessage[], conversations: ChatConversationSummary[]): ChatMessage[] {
  const groupIds = new Set(conversations.filter((conversation) => conversation.kind === "group").map((conversation) => conversation.id));
  return messages.filter((message) => message.conversationType !== "group" && (!message.conversationId || !groupIds.has(message.conversationId)));
}

type Segmenter = { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> };

/** Chat has no hashtags, so words come from the browser's own segmenter; platform boilerplate is dropped first. */
function chatField(friend: ChatMessage[]): StoryTermField | null {
  const factory = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => Segmenter }).Segmenter;
  if (typeof factory !== "function") return null;
  const texts = friend.filter((message) => message.type === "text" && message.text?.trim());
  const shape = (text: string) => text.replace(/\d+/gu, "#").replace(/\s+/gu, "").slice(0, 40);
  const byShape = new Map<string, Set<string>>();
  for (const message of texts) {
    const key = shape(message.text ?? "");
    const ids = byShape.get(key) ?? new Set<string>();
    ids.add(message.conversationId ?? "");
    byShape.set(key, ids);
  }
  // the same sentence in three or more conversations is the platform talking, not the person
  const boilerplate = new Set([...byShape].filter(([, ids]) => ids.size >= 3).map(([key]) => key));
  const kept = texts.filter((message) => !boilerplate.has(shape(message.text ?? "")));
  const segmenter = new factory("zh", { granularity: "word" });
  return termField(kept.map((message) => chatWords(segmenter, message.text ?? "")), texts.length, texts.length - kept.length);
}

function chatWords(segmenter: Segmenter, text: string): string[] {
  const cleaned = text.replace(/https?:\/\/\S+/gu, " ").replace(/\[[^\]]{1,8}\]/gu, " ").replace(/@[^\s@:：,，]{1,20}/gu, " ").replace(/#[^#\s,，。.!！?？:：;；]{1,50}/gu, " ");
  const words: string[] = [];
  let run = "";
  // ponytail: a run of single characters is one word the segmenter split up; a long run is a sentence, not a word, so it is dropped
  const flush = () => { if (run.length >= 2 && run.length <= 6) words.push(run); run = ""; };
  for (const piece of segmenter.segment(cleaned)) {
    const word = piece.segment;
    if (!piece.isWordLike) { flush(); continue; }
    if (HAN.test(word)) {
      if (word.length === 1) { run += word; continue; }
      flush();
      words.push(word);
    } else {
      flush();
      if (/^[a-z]{2,}$/iu.test(word)) words.push(word.toLowerCase());
    }
  }
  flush();
  return words.filter((word) => word.length >= 2 && new Set(word).size > 1 && !CHAT_STOPWORDS.has(word));
}

function shares<T>(items: T[], buckets: Array<[string, (value: T) => boolean]>): Array<{ label: string; share: number }> | null {
  if (!items.length) return null;
  return buckets.map(([label, test]) => ({ label, share: items.filter(test).length / items.length }));
}

function median(values: number[]): number { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0; } // ponytail: lower middle, no averaging
function recordKey(record: PersonalVideoRecord): string { return record.videoId ?? record.url ?? record.id; }
function validTime(value: string | null | undefined): number | null { if (!value) return null; const time = new Date(value).getTime(); return Number.isFinite(time) ? time : null; }
function isoDay(time: number): string { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
