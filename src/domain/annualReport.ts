import type {
  PersonalRecordCollection,
  PersonalRecordType,
  PersonalVideoRecord,
} from "./personalRecords";

/**
 * The report intentionally keeps the source of a date explicit.  A date with
 * an unknown provenance must not silently become an annual activity event.
 */
export type AnnualOccurredAtSource = "platform_action" | "archive_action" | "unknown";
export type AnnualCardStatus = "ok" | "insufficient";
export type AnnualReportStatus = "ok" | "insufficient" | "empty";
export type AnnualCardId =
  | "overview"
  | "rhythm"
  | "monthly"
  | "creators"
  | "interests"
  | "kept"
  | "highlights"
  | "summary";

export const ANNUAL_TIME_ZONE = "Asia/Shanghai" as const;
export const ANNUAL_CARD_IDS: readonly AnnualCardId[] = [
  "overview",
  "rhythm",
  "monthly",
  "creators",
  "interests",
  "kept",
  "highlights",
  "summary",
] as const;

export interface AnnualIndexOptions {
  /** A collector/archive hint used only for legacy records with no source field. */
  source?: "collector" | "archive" | "mixed" | string;
  /** Explicit fallback for legacy records. Defaults to unknown (strict mode). */
  defaultOccurredAtSource?: AnnualOccurredAtSource;
  /** Collection state is carried into coverage; it never changes record counts. */
  collectionState?: "complete" | "partial" | "unknown" | string;
  /** Convenience flag for callers that already reduced collector state. */
  partial?: boolean;
  /** Snapshot warnings are surfaced in every report coverage object. */
  warnings?: readonly string[];
  /** Makes the default-year choice deterministic in tests and on the UI. */
  now?: Date | string | number;
  /** Kept as an option for callers, but the report always uses Shanghai. */
  timezone?: typeof ANNUAL_TIME_ZONE;
}

export interface AnnualDateRange {
  start: string;
  end: string;
  startAt: string;
  endAt: string;
}

export interface AnnualTypeCoverage {
  recordCount: number;
  uniqueVideoCount: number;
  reliableRecordCount: number;
  reliableUniqueVideoCount: number;
  undatedRecordCount: number;
  unknownSourceRecordCount: number;
  invalidDateRecordCount: number;
  reliableDateRatio: number;
}

export interface DataCoverage {
  /** The requested report year, when this is a year-scoped coverage object. */
  year: number | null;
  source: string | null;
  collectionState: string;
  partial: boolean;
  warnings: string[];
  recordCount: number;
  uniqueVideoCount: number;
  reliableRecordCount: number;
  reliableUniqueVideoCount: number;
  undatedRecordCount: number;
  unknownSourceRecordCount: number;
  invalidDateRecordCount: number;
  /** Convenient aliases for callers that use the wording from the design. */
  datedRecordCount: number;
  datedUniqueVideoCount: number;
  missingOccurredAtCount: number;
  reliableDateRatio: number;
  dateRange: AnnualDateRange | null;
  availableYears: number[];
  byType: Record<PersonalRecordType, AnnualTypeCoverage>;
}

export interface AnnualZonedDate {
  /** YYYY-MM-DD in Asia/Shanghai. */
  date: string;
  year: number;
  month: number;
  day: number;
  /** Monday = 0, Sunday = 6. */
  weekday: number;
  hour: number;
}

export interface AnnualIndexedRecord {
  type: PersonalRecordType;
  record: PersonalVideoRecord;
  /** Canonical cross-category id, if one can be determined. */
  videoId: string | null;
  /** Stable key used for de-duplication within a category. */
  comparisonKey: string;
  hasComparableVideoId: boolean;
  occurredAt: string | null;
  occurredAtSource: AnnualOccurredAtSource;
  timestamp: number | null;
  zoned: AnnualZonedDate | null;
  sourceIndex: number;
}

export interface AnnualSnapshotSet {
  /** Only comparable ids are included. Unknown-id records are deliberately omitted. */
  videoIds: string[];
  recordCount: number;
  unknownIdRecordCount: number;
}

export interface AnnualYearBucket {
  year: number;
  /** Includes valid timestamps with unknown provenance for coverage diagnostics. */
  entries: AnnualIndexedRecord[];
  /** Includes only platform_action/archive_action entries used by annual cards. */
  reliableEntries: AnnualIndexedRecord[];
  uniqueEntries: AnnualIndexedRecord[];
  reliableUniqueEntries: AnnualIndexedRecord[];
  byType: Record<PersonalRecordType, AnnualIndexedRecord[]>;
  uniqueByType: Record<PersonalRecordType, AnnualIndexedRecord[]>;
}

export interface AnnualIndex {
  timezone: typeof ANNUAL_TIME_ZONE;
  entries: AnnualIndexedRecord[];
  /** Alias retained for consumers that call these rows records. */
  records: AnnualIndexedRecord[];
  uniqueEntries: AnnualIndexedRecord[];
  byType: Record<PersonalRecordType, AnnualIndexedRecord[]>;
  uniqueByType: Record<PersonalRecordType, AnnualIndexedRecord[]>;
  /** Precomputed year buckets keep year switching off the original record arrays. */
  yearBuckets: Readonly<Record<number, AnnualYearBucket>>;
  snapshotSets: Record<PersonalRecordType, AnnualSnapshotSet>;
  coverage: DataCoverage;
  availableYears: number[];
  latestYear: number | null;
  defaultYear: number | null;
  now: string;
  options: Readonly<AnnualIndexOptions>;
}

export interface AnnualCardManifest {
  id: AnnualCardId;
  order: number;
  title: string;
  eyebrow: string;
  description: string;
}

export const ANNUAL_CARD_MANIFEST: readonly AnnualCardManifest[] = [
  {
    id: "overview",
    order: 0,
    title: "年度总览",
    eyebrow: "YOUR YEAR",
    description: "可靠时间记录的全年度活动概览",
  },
  {
    id: "rhythm",
    order: 1,
    title: "观看作息",
    eyebrow: "YOUR RHYTHM",
    description: "观看历史在一周与一天中的分布",
  },
  {
    id: "monthly",
    order: 2,
    title: "偏好变化",
    eyebrow: "PREFERENCE SHIFT",
    description: "按播放进度更新时间观察喜欢与收藏变化",
  },
  {
    id: "creators",
    order: 3,
    title: "创作者宇宙",
    eyebrow: "YOUR CREATORS",
    description: "年度创作者分布与探索范围",
  },
  {
    id: "interests",
    order: 4,
    title: "喜好画像",
    eyebrow: "YOUR PREFERENCES",
    description: "喜欢与收藏中的显式话题、音乐与时长",
  },
  {
    id: "kept",
    order: 5,
    title: "留下来的内容",
    eyebrow: "WHAT STAYED",
    description: "全部已采集列表的内容交集快照",
  },
  {
    id: "highlights",
    order: 6,
    title: "年度高光",
    eyebrow: "HIGHLIGHTS",
    description: "从可靠时间与平台统计中选出的代表内容",
  },
  {
    id: "summary",
    order: 7,
    title: "Bento 总结",
    eyebrow: "THE RECAP",
    description: "复用前七张卡片的年度摘要",
  },
] as const;

export const PERSONAL_SUMMARY_CARD_MANIFEST: readonly AnnualCardManifest[] = [
  { id: "overview", order: 0, title: "样本总览", eyebrow: "CURRENT SAMPLE", description: "当前三类列表的内容与时间覆盖" },
  { id: "rhythm", order: 1, title: "观看作息", eyebrow: "YOUR RHYTHM", description: "有可靠行为时间的观看样本分布" },
  { id: "monthly", order: 2, title: "偏好变化", eyebrow: "PREFERENCE SHIFT", description: "按播放进度更新时间观察喜欢与收藏变化" },
  { id: "creators", order: 3, title: "创作者宇宙", eyebrow: "YOUR CREATORS", description: "当前样本中的创作者分布" },
  { id: "interests", order: 4, title: "喜好画像", eyebrow: "YOUR PREFERENCES", description: "喜欢与收藏中的显式话题、音乐与时长" },
  { id: "kept", order: 5, title: "留下来的内容", eyebrow: "WHAT STAYED", description: "三类当前样本的内容交集" },
  { id: "highlights", order: 6, title: "内容高光", eyebrow: "HIGHLIGHTS", description: "从当前样本中选出的代表内容" },
  { id: "summary", order: 7, title: "Bento 总结", eyebrow: "THE RECAP", description: "复用前七张卡片的个人摘要" },
] as const;

export interface AnnualOverviewData {
  counts: {
    watch: number;
    liked: number;
    favorite: number;
    total: number;
    watchEvents: number;
    likedEvents: number;
    favoriteEvents: number;
  };
  activeDays: number;
  watchActiveDays: number;
  dateRange: AnnualDateRange | null;
  peakDay: AnnualPeakDay | null;
  calendar: AnnualCalendarDay[];
  coverage: DataCoverage;
}

export interface AnnualCalendarDay {
  date: string;
  count: number;
  uniqueVideos: number;
  byType: Record<"watch" | "liked" | "favorite", number>;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface AnnualPeakDay {
  date: string;
  count: number;
  uniqueVideos: number;
  byType: Record<"watch" | "liked" | "favorite", number>;
  records: AnnualContentRef[];
}

export interface AnnualHeatmapCell {
  weekday: number;
  hour: number;
  count: number;
  uniqueVideos: number;
}

export interface AnnualRhythmData {
  heatmap: AnnualHeatmapCell[];
  mostActiveWeekday: { weekday: number; count: number } | null;
  mostActiveHour: { hour: number; count: number } | null;
  earliest: AnnualContentRef | null;
  latest: AnnualContentRef | null;
  personality: string | null;
  threshold: { minimumRecords: number; minimumActiveDays: number };
  watchRecordCount: number;
  activeDays: number;
}

export interface AnnualMonthPoint {
  month: number;
  label: string;
  liked: number | null;
  favorite: number | null;
  likedEvents: number;
  favoriteEvents: number;
}

export interface AnnualMonthlyData {
  months: AnnualMonthPoint[];
  peakMonth: { month: number; label: string; count: number } | null;
  seriesAvailability: Record<"liked" | "favorite", boolean>;
  unavailableSeries: Array<"liked" | "favorite">;
}

export interface AnnualCreator {
  rank: number;
  name: string;
  authorId: string | null;
  count: number;
  events: number;
  share: number;
}

export interface AnnualCreatorsData {
  top: AnnualCreator[];
  creatorCount: number;
  unknownCount: number;
  headShare: number;
  exploration: number;
}

export interface AnnualTopic {
  name: string;
  count: number;
}

export interface AnnualMusic {
  id: string | null;
  title: string;
  author: string | null;
  count: number;
}

export interface AnnualDurationBucket {
  id: "under_15s" | "15_60s" | "1_5m" | "over_5m";
  label: string;
  count: number;
}

export interface AnnualInterestsData {
  topics: AnnualTopic[];
  music: AnnualMusic[];
  durations: AnnualDurationBucket[];
  durationStats: { count: number; averageSeconds: number | null; medianSeconds: number | null };
  signalCount: number;
}

export interface AnnualKeptData {
  scope: "all_snapshot";
  sets: Record<"watch" | "liked" | "favorite", AnnualSnapshotSet>;
  pairwise: {
    watchLiked: number;
    watchFavorite: number;
    likedFavorite: number;
  };
  allThree: number;
  comparableVideoCount: number;
  unknownIdRecordCount: number;
}

export interface AnnualContentRef {
  videoId: string | null;
  title: string;
  author: string | null;
  authorId: string | null;
  url: string | null;
  coverUrl: string | null;
  type: PersonalRecordType;
  occurredAt: string | null;
  durationSeconds: number | null;
  interactionScore: number | null;
}

export interface AnnualHighlightsData {
  first: AnnualContentRef | null;
  last: AnnualContentRef | null;
  peakDay: AnnualContentRef | null;
  longest: AnnualContentRef | null;
  mostEngaged: AnnualContentRef | null;
}

export interface AnnualSummaryData {
  metrics: {
    activeDays: number;
    totalUniqueVideos: number;
    creatorCount: number;
    topTopic: AnnualTopic | null;
    topCreator: AnnualCreator | null;
    allThree: number;
  };
  coverage: DataCoverage;
  sourceCardIds: AnnualCardId[];
}

export type AnnualCardData =
  | AnnualOverviewData
  | AnnualRhythmData
  | AnnualMonthlyData
  | AnnualCreatorsData
  | AnnualInterestsData
  | AnnualKeptData
  | AnnualHighlightsData
  | AnnualSummaryData;

export interface AnnualCard {
  id: AnnualCardId;
  order: number;
  title: string;
  eyebrow: string;
  description: string;
  status: AnnualCardStatus;
  reason: string | null;
  notices: string[];
  data: AnnualCardData;
}

export interface AnnualReport {
  year: number;
  timezone: typeof ANNUAL_TIME_ZONE;
  status: AnnualReportStatus;
  isAvailableYear: boolean;
  isCurrentPartialYear: boolean;
  periodLabel: string;
  coverage: DataCoverage;
  snapshotCoverage: DataCoverage;
  cards: AnnualCard[];
  cardManifest: readonly AnnualCardManifest[];
  /** Alias useful to renderers that call the manifest simply `manifest`. */
  manifest: readonly AnnualCardManifest[];
  overview: AnnualCard;
  rhythm: AnnualCard;
  monthly: AnnualCard;
  creators: AnnualCard;
  interests: AnnualCard;
  kept: AnnualCard;
  highlights: AnnualCard;
  summary: AnnualCard;
}

export type PersonalSummaryReport = AnnualReport;

type ShortType = "watch" | "liked" | "favorite";

const TYPE_ORDER: readonly PersonalRecordType[] = [
  "watch_history",
  "liked_videos",
  "favorite_videos",
] as const;

const SHORT_TYPE: Record<PersonalRecordType, ShortType> = {
  watch_history: "watch",
  liked_videos: "liked",
  favorite_videos: "favorite",
};

function isPreferenceEntry(entry: AnnualIndexedRecord): boolean {
  return entry.type === "liked_videos" || entry.type === "favorite_videos";
}

const ACCEPTED_SOURCES = new Set<AnnualOccurredAtSource>(["platform_action", "archive_action"]);
const MAX_STRING_LENGTH = 500;
const MAX_TOPIC_LENGTH = 100;
const MAX_TOPICS = 100;
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ANNUAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueOf(record: PersonalVideoRecord, keys: readonly string[]): unknown {
  const source = record as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function cleanString(value: unknown, maxLength = MAX_STRING_LENGTH): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) return null;
  return result;
}

function cleanUrl(value: unknown): string | null {
  const candidate = cleanString(value, 2_048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalUrl(value: unknown): string | null {
  const cleaned = cleanUrl(value);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLocaleLowerCase();
    return url.toString().replace(/\/$/u, "");
  } catch {
    return cleaned;
  }
}

function normalizeId(value: unknown): string | null {
  const candidate = cleanString(value, 200);
  return candidate ? candidate : null;
}

function extractVideoId(record: PersonalVideoRecord, type: PersonalRecordType): { id: string | null; comparable: boolean } {
  const explicit = valueOf(record, [
    "videoId",
    "video_id",
    "awemeId",
    "aweme_id",
    "itemId",
    "item_id",
    "groupId",
    "group_id",
  ]);
  const explicitId = normalizeId(explicit);
  if (explicitId) return { id: explicitId, comparable: true };

  const url = cleanUrl(valueOf(record, ["url", "shareUrl", "share_url", "videoUrl", "video_url"]));
  if (url) {
    try {
      const parsed = new URL(url);
      const pathMatch = parsed.pathname.match(/\/(?:video|note|aweme)\/(\d{4,})/iu);
      if (pathMatch?.[1]) return { id: pathMatch[1], comparable: true };
      const queryId = normalizeId(parsed.searchParams.get("modal_id") ?? parsed.searchParams.get("item_id"));
      if (queryId) return { id: queryId, comparable: true };
    } catch {
      // canonicalUrl has already validated the URL.
    }
  }

  // v1 collector/parser ids carry the record type as a prefix. Removing it
  // lets old snapshots correlate the same hash/aweme id across lists while
  // still avoiding category-specific ids as an overlap key.
  const legacyId = normalizeId(valueOf(record, ["id"]));
  if (legacyId) {
    const prefix = `${type}-`;
    const colonPrefix = `${type}:`;
    const stripped = legacyId.startsWith(prefix)
      ? legacyId.slice(prefix.length)
      : legacyId.startsWith(colonPrefix)
        ? legacyId.slice(colonPrefix.length)
        : legacyId;
    if (stripped) return { id: stripped, comparable: false };
  }
  return { id: null, comparable: false };
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1e11 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  const candidate = cleanString(value, 200);
  if (!candidate) return null;
  if (/^\d{10,13}$/u.test(candidate)) {
    const numeric = Number(candidate);
    const milliseconds = candidate.length === 10 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  const naive = candidate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/u);
  if (naive) {
    const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0"] = naive;
    if (
      Number(month) < 1 || Number(month) > 12
      || Number(day) < 1 || Number(day) > 31
      || Number(hour) < 0 || Number(hour) > 23
      || Number(minute) < 0 || Number(minute) > 59
      || Number(second) < 0 || Number(second) > 59
    ) return null;
    const milliseconds = Number(fraction.padEnd(3, "0"));
    const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds) - 8 * 60 * 60 * 1_000;
    const parts = formatShanghai(utc);
    if (parts.year === Number(year) && parts.month === Number(month) && parts.day === Number(day)) return utc;
    return null;
  }
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceFor(record: PersonalVideoRecord, options: AnnualIndexOptions): AnnualOccurredAtSource {
  const raw = valueOf(record, ["occurredAtSource", "occurred_at_source"]);
  if (raw === "platform_action" || raw === "archive_action" || raw === "unknown") return raw;
  if (options.defaultOccurredAtSource) return options.defaultOccurredAtSource;
  if (options.source === "collector") return "platform_action";
  if (options.source === "archive") return "archive_action";
  return "unknown";
}

function formatShanghai(timestamp: number): AnnualZonedDate {
  const parts = SHANGHAI_FORMATTER.formatToParts(new Date(timestamp));
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(map.get("year"));
  const month = Number(map.get("month"));
  const day = Number(map.get("day"));
  const hour = Number(map.get("hour"));
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const utcDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  return {
    date,
    year,
    month,
    day,
    weekday: (utcDay + 6) % 7,
    hour: Number.isFinite(hour) ? hour : 0,
  };
}

function toIso(timestamp: number | null, original: unknown): string | null {
  if (timestamp !== null) return new Date(timestamp).toISOString();
  return cleanString(original, 200);
}

function safeTypeRecords(records: PersonalRecordCollection | null | undefined, type: PersonalRecordType): PersonalVideoRecord[] {
  const value = records && (records as unknown as Record<string, unknown>)[type];
  return Array.isArray(value) ? value.filter((item): item is PersonalVideoRecord => isRecord(item)) : [];
}

function dedupeKey(entry: AnnualIndexedRecord): string {
  if (entry.videoId) return `video:${entry.videoId}`;
  const url = canonicalUrl(valueOf(entry.record, ["url", "shareUrl", "share_url", "videoUrl", "video_url"]));
  if (url) return `url:${url}`;
  return entry.comparisonKey;
}

// 带参数的 localeCompare 每比一次都要现建一个 Collator，排序上万条时很慢；结果和它一样
const TEXT_COLLATOR = new Intl.Collator("zh-Hans", { sensitivity: "base", numeric: true });

function compareText(left: string, right: string): number {
  return TEXT_COLLATOR.compare(left, right);
}

function compareStableString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: AnnualIndexedRecord, right: AnnualIndexedRecord): number {
  const leftTime = left.timestamp ?? Number.POSITIVE_INFINITY;
  const rightTime = right.timestamp ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.type !== right.type) return TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type);
  if ((left.videoId ?? "") !== (right.videoId ?? "")) return compareStableString(left.videoId ?? "", right.videoId ?? "");
  return left.sourceIndex - right.sourceIndex;
}

function latestFirst(left: AnnualIndexedRecord, right: AnnualIndexedRecord): number {
  const leftTime = left.timestamp ?? Number.NEGATIVE_INFINITY;
  const rightTime = right.timestamp ?? Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return compareEntries(left, right);
}

function uniqueEntries(entries: readonly AnnualIndexedRecord[], alreadySorted = false): AnnualIndexedRecord[] {
  const map = new Map<string, AnnualIndexedRecord>();
  for (const entry of entries) {
    const key = dedupeKey(entry);
    const previous = map.get(key);
    if (!previous) {
      map.set(key, entry);
      continue;
    }
    // Prefer the entry with a reliable date, then the one with more metadata.
    const previousScore = metadataScore(previous.record);
    const currentScore = metadataScore(entry.record);
    if (currentScore > previousScore || (currentScore === previousScore && latestFirst(entry, previous) < 0)) {
      map.set(key, mergeIndexedEntries(previous, entry, entry));
    } else {
      map.set(key, mergeIndexedEntries(entry, previous, entry));
    }
  }
  const result = [...map.values()];
  return alreadySorted ? result : result.sort(compareEntries);
}

function uniqueCount(entries: readonly AnnualIndexedRecord[]): number {
  const keys = new Set<string>();
  for (const entry of entries) keys.add(dedupeKey(entry));
  return keys.size;
}

function metadataScore(record: PersonalVideoRecord): number {
  const source = record as unknown as Record<string, unknown>;
  let score = 0;
  for (const key of ["title", "author", "authorId", "authorAvatarUrl", "coverUrl", "url", "publishedAt", "mediaType", "music", "stats", "watchProgress"]) {
    const value = source[key];
    if (value !== null && value !== undefined && value !== "") score += 1;
  }
  const topics = source.topics;
  if (Array.isArray(topics)) score += Math.min(topics.length, 5);
  return score;
}

function mergeIndexedEntries(
  left: AnnualIndexedRecord,
  right: AnnualIndexedRecord,
  latest: AnnualIndexedRecord,
): AnnualIndexedRecord {
  const leftRecord = left.record as unknown as Record<string, unknown>;
  const rightRecord = right.record as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...rightRecord };
  for (const [key, value] of Object.entries(leftRecord)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "topics" && Array.isArray(value)) {
      const oldTopics = Array.isArray(merged.topics) ? merged.topics : [];
      merged.topics = [...new Set([...value, ...oldTopics].filter((item): item is string => typeof item === "string"))].slice(0, MAX_TOPICS);
    } else if (key === "stats" && isRecord(value)) {
      // Platform stats are snapshots; the later non-empty snapshot wins per field.
      const preferredStats = isRecord(merged.stats) ? merged.stats : {};
      merged.stats = { ...value, ...preferredStats };
    } else if (merged[key] === null || merged[key] === undefined || merged[key] === "") {
      merged[key] = value;
    }
  }
  const latestStats = valueOf(latest.record, ["stats"]);
  if (isRecord(latestStats)) {
    const existingStats = isRecord(merged.stats) ? merged.stats : {};
    merged.stats = { ...existingStats, ...latestStats };
  }
  const mergedRecord = merged as unknown as PersonalVideoRecord;
  const timestamp = right.timestamp ?? left.timestamp;
  return {
    ...right,
    record: mergedRecord,
    occurredAt: toIso(timestamp, right.occurredAt ?? left.occurredAt),
    timestamp,
    zoned: timestamp === null ? (left.zoned ?? right.zoned) : formatShanghai(timestamp),
    occurredAtSource: ACCEPTED_SOURCES.has(right.occurredAtSource)
      ? right.occurredAtSource
      : left.occurredAtSource,
  };
}

function buildCoverage(
  entries: readonly AnnualIndexedRecord[],
  availableYears: readonly number[],
  options: AnnualIndexOptions,
  year: number | null,
): DataCoverage {
  const scoped = year === null ? entries : entries.filter((entry) => entry.zoned?.year === year && entry.timestamp !== null && ACCEPTED_SOURCES.has(entry.occurredAtSource));
  const sourceEntries = year === null ? entries : entries.filter((entry) => entry.zoned?.year === year);
  const reliable = scoped.filter((entry) => entry.timestamp !== null && ACCEPTED_SOURCES.has(entry.occurredAtSource));
  const uniqueVideoCount = uniqueCount(sourceEntries);
  const reliableUniqueVideoCount = uniqueCount(reliable);
  const byType = {} as Record<PersonalRecordType, AnnualTypeCoverage>;
  for (const type of TYPE_ORDER) {
    const typeEntries = sourceEntries.filter((entry) => entry.type === type);
    const typeReliable = reliable.filter((entry) => entry.type === type);
    byType[type] = {
      recordCount: typeEntries.length,
      uniqueVideoCount: uniqueCount(typeEntries),
      reliableRecordCount: typeReliable.length,
      reliableUniqueVideoCount: uniqueCount(typeReliable),
      undatedRecordCount: typeEntries.filter((entry) => entry.timestamp === null).length,
      unknownSourceRecordCount: typeEntries.filter((entry) => entry.timestamp !== null && !ACCEPTED_SOURCES.has(entry.occurredAtSource)).length,
      invalidDateRecordCount: typeEntries.filter((entry) => entry.timestamp === null && valueOf(entry.record, ["occurredAt"]) !== undefined && valueOf(entry.record, ["occurredAt"]) !== null).length,
      reliableDateRatio: typeEntries.length ? typeReliable.length / typeEntries.length : 0,
    };
  }
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  for (const entry of reliable) {
    if (entry.timestamp === null) continue;
    firstTimestamp = Math.min(firstTimestamp, entry.timestamp);
    lastTimestamp = Math.max(lastTimestamp, entry.timestamp);
  }
  const dateRange = Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp)
    ? {
      start: formatShanghai(firstTimestamp).date,
      end: formatShanghai(lastTimestamp).date,
      startAt: new Date(firstTimestamp).toISOString(),
      endAt: new Date(lastTimestamp).toISOString(),
    }
    : null;
  const warnings = [...new Set((options.warnings ?? []).filter((warning): warning is string => typeof warning === "string").slice(0, 100))];
  const collectionState = options.collectionState === "partial" ? "partial" : options.collectionState === "complete" ? "complete" : "unknown";
  const partial = options.partial === true || collectionState === "partial" || warnings.length > 0;
  const undatedRecordCount = sourceEntries.filter((entry) => entry.timestamp === null).length;
  const missingOccurredAtCount = sourceEntries.filter((entry) => {
    const value = valueOf(entry.record, ["occurredAt", "occurred_at"]);
    return value === undefined || value === null || cleanString(value, 200) === null;
  }).length;
  const unknownSourceRecordCount = sourceEntries.filter((entry) => entry.timestamp !== null && !ACCEPTED_SOURCES.has(entry.occurredAtSource)).length;
  const invalidDateRecordCount = sourceEntries.filter((entry) => entry.timestamp === null && valueOf(entry.record, ["occurredAt"]) !== undefined && valueOf(entry.record, ["occurredAt"]) !== null).length;
  return {
    year,
    source: typeof options.source === "string" && options.source ? options.source : null,
    collectionState,
    partial,
    warnings,
    recordCount: sourceEntries.length,
    uniqueVideoCount,
    reliableRecordCount: reliable.length,
    reliableUniqueVideoCount,
    undatedRecordCount,
    unknownSourceRecordCount,
    invalidDateRecordCount,
    datedRecordCount: reliable.length,
    datedUniqueVideoCount: reliableUniqueVideoCount,
    missingOccurredAtCount,
    reliableDateRatio: sourceEntries.length ? reliable.length / sourceEntries.length : 0,
    dateRange,
    availableYears: [...availableYears],
    byType,
  };
}

function normalizeNow(value: AnnualIndexOptions["now"]): number {
  const parsed = parseTimestamp(value ?? Date.now());
  return parsed ?? Date.now();
}

function currentShanghaiYear(timestamp: number): number {
  return formatShanghai(timestamp).year;
}

function chooseDefaultYear(years: readonly number[], nowTimestamp: number): number | null {
  if (years.length === 0) return null;
  const currentYear = currentShanghaiYear(nowTimestamp);
  const prior = years.filter((year) => year < currentYear);
  return (prior.length ? prior : years).reduce((latest, year) => Math.max(latest, year), years[0]!);
}

function normalizedRecordIdentity(entry: AnnualIndexedRecord): string {
  return dedupeKey(entry);
}

function normalizeTopics(record: PersonalVideoRecord): string[] {
  const rawTopics = valueOf(record, ["topics", "hashtags", "hashTags"]);
  const values: unknown[] = Array.isArray(rawTopics) ? rawTopics : rawTopics === undefined ? [] : [rawTopics];
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanString(value, MAX_TOPIC_LENGTH);
    if (!cleaned) continue;
    const topic = cleaned.replace(/^#/u, "").trim();
    if (topic && !result.includes(topic)) result.push(topic);
    if (result.length >= MAX_TOPICS) break;
  }
  const title = cleanString(valueOf(record, ["title"]));
  if (title) {
    for (const match of title.matchAll(/#([^#\s,，。.!！?？:：;；]{1,50})/gu)) {
      const topic = cleanString(match[1], MAX_TOPIC_LENGTH)?.replace(/^#/u, "");
      if (topic && !result.includes(topic)) result.push(topic);
      if (result.length >= MAX_TOPICS) break;
    }
  }
  return result;
}

function authorOf(record: PersonalVideoRecord): { name: string | null; id: string | null } {
  return {
    name: cleanString(valueOf(record, ["author", "authorName", "nickname", "creatorName"])),
    id: normalizeId(valueOf(record, ["authorId", "author_id", "uid", "userId"])),
  };
}

function coverOf(record: PersonalVideoRecord): string | null {
  return cleanUrl(valueOf(record, ["coverUrl", "cover_url", "cover", "thumbnail", "poster"]));
}

function durationOf(record: PersonalVideoRecord): number | null {
  const value = valueOf(record, ["durationSeconds", "duration_seconds", "duration"]);
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 86_400) return null;
  return number;
}

function musicOf(record: PersonalVideoRecord): { id: string | null; title: string; author: string | null } | null {
  const raw = valueOf(record, ["music"]);
  if (typeof raw === "string" || typeof raw === "number") {
    const title = cleanString(raw);
    return title ? { id: null, title, author: null } : null;
  }
  if (!isRecord(raw)) return null;
  const title = cleanString(raw.title ?? raw.name ?? raw.musicName);
  if (!title) return null;
  return {
    id: normalizeId(raw.id ?? raw.musicId ?? raw.mid),
    title,
    author: cleanString(raw.author ?? raw.authorName ?? raw.artist),
  };
}

function numericField(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function statsOf(record: PersonalVideoRecord): Record<string, number> {
  const raw = valueOf(record, ["stats", "platformStats", "interaction", "platformInteraction"]);
  if (!isRecord(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const number = numericField(value);
    if (number !== null && number <= 10_000_000_000) result[key] = number;
  }
  return result;
}

function interactionScore(record: PersonalVideoRecord): number | null {
  const stats = statsOf(record);
  const engagementValues = [
    stats.diggCount ?? stats.digg_count ?? stats.likeCount ?? stats.like_count,
    stats.commentCount ?? stats.comment_count,
    stats.shareCount ?? stats.share_count,
    stats.collectCount ?? stats.collect_count,
  ].filter((value): value is number => typeof value === "number");
  if (engagementValues.length > 0) return engagementValues.reduce((sum, value) => sum + value, 0);
  const playCount = stats.playCount ?? stats.play_count;
  if (typeof playCount !== "number") return null;
  // Keep this a deterministic display score, not a claim about an official ranking.
  return playCount;
}

export function contentRef(entry: AnnualIndexedRecord): AnnualContentRef {
  const author = authorOf(entry.record);
  return {
    videoId: entry.videoId,
    title: cleanString(valueOf(entry.record, ["title"])) ?? "未命名视频",
    author: author.name,
    authorId: author.id,
    url: cleanUrl(valueOf(entry.record, ["url", "shareUrl", "share_url", "videoUrl", "video_url"])),
    coverUrl: coverOf(entry.record),
    type: entry.type,
    occurredAt: entry.occurredAt,
    durationSeconds: durationOf(entry.record),
    interactionScore: interactionScore(entry.record),
  };
}

function compareForStableRank(left: { count: number; name: string; id?: string | null }, right: { count: number; name: string; id?: string | null }): number {
  if (left.count !== right.count) return right.count - left.count;
  const nameOrder = compareText(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  return compareText(left.id ?? "", right.id ?? "");
}

function cardStatus(ok: boolean, reason: string): { status: AnnualCardStatus; reason: string | null } {
  return ok ? { status: "ok", reason: null } : { status: "insufficient", reason };
}

export function isReliableAnnualEntry(entry: AnnualIndexedRecord): boolean {
  return entry.timestamp !== null && entry.zoned !== null && ACCEPTED_SOURCES.has(entry.occurredAtSource);
}

function makeYearBuckets(entries: readonly AnnualIndexedRecord[]): Readonly<Record<number, AnnualYearBucket>> {
  const mutable: Record<number, AnnualYearBucket> = {};
  for (const entry of entries) {
    if (!entry.zoned) continue;
    const year = entry.zoned.year;
    let bucket = mutable[year];
    if (!bucket) {
      const byType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
      const uniqueByType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
      for (const type of TYPE_ORDER) {
        byType[type] = [];
        uniqueByType[type] = [];
      }
      bucket = {
        year,
        entries: [],
        reliableEntries: [],
        uniqueEntries: [],
        reliableUniqueEntries: [],
        byType,
        uniqueByType,
      };
      mutable[year] = bucket;
    }
    bucket.entries.push(entry);
    bucket.byType[entry.type].push(entry);
    if (isReliableAnnualEntry(entry)) bucket.reliableEntries.push(entry);
  }
  for (const bucket of Object.values(mutable)) {
    bucket.uniqueEntries = uniqueEntries(bucket.entries, true);
    bucket.reliableUniqueEntries = uniqueEntries(bucket.reliableEntries, true);
    for (const type of TYPE_ORDER) bucket.uniqueByType[type] = uniqueEntries(bucket.byType[type], true);
  }
  return mutable;
}

function bucketFor(index: AnnualIndex, year: number): AnnualYearBucket {
  const bucket = index.yearBuckets[year];
  if (bucket) return bucket;
  const byType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
  const uniqueByType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
  for (const type of TYPE_ORDER) {
    byType[type] = [];
    uniqueByType[type] = [];
  }
  return {
    year,
    entries: [],
    reliableEntries: [],
    uniqueEntries: [],
    reliableUniqueEntries: [],
    byType,
    uniqueByType,
  };
}

function calendarForYear(entries: readonly AnnualIndexedRecord[], year: number): AnnualCalendarDay[] {
  const daysInYear = new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29 ? 366 : 365;
  const result: AnnualCalendarDay[] = [];
  const byDate = new Map<string, AnnualIndexedRecord[]>();
  for (const entry of entries) {
    if (!entry.zoned || entry.zoned.year !== year) continue;
    const list = byDate.get(entry.zoned.date) ?? [];
    list.push(entry);
    byDate.set(entry.zoned.date, list);
  }
  const maxCount = Math.max(1, ...[...byDate.values()].map((items) => items.length));
  for (let offset = 0; offset < daysInYear; offset += 1) {
    const date = new Date(Date.UTC(year, 0, 1 + offset));
    const key = date.toISOString().slice(0, 10);
    const items = byDate.get(key) ?? [];
    const unique = new Set(items.map(normalizedRecordIdentity));
    const byType: Record<ShortType, number> = { watch: 0, liked: 0, favorite: 0 };
    for (const item of items) byType[SHORT_TYPE[item.type]] += 1;
    const count = items.length;
    const level = count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((count / maxCount) * 4))) as 1 | 2 | 3 | 4;
    result.push({ date: key, count, uniqueVideos: unique.size, byType, level });
  }
  return result;
}

function peakDayForEntries(entries: readonly AnnualIndexedRecord[], year?: number): AnnualPeakDay | null {
  const byDate = new Map<string, AnnualIndexedRecord[]>();
  for (const entry of entries) {
    if (!entry.zoned || (year !== undefined && entry.zoned.year !== year)) continue;
    const list = byDate.get(entry.zoned.date) ?? [];
    list.push(entry);
    byDate.set(entry.zoned.date, list);
  }
  const ranked = [...byDate.entries()].map(([date, items]) => ({ date, items })).sort((left, right) => {
    if (left.items.length !== right.items.length) return right.items.length - left.items.length;
    return left.date.localeCompare(right.date);
  });
  const winner = ranked[0];
  if (!winner || winner.items.length === 0) return null;
  const byType: Record<ShortType, number> = { watch: 0, liked: 0, favorite: 0 };
  for (const item of winner.items) byType[SHORT_TYPE[item.type]] += 1;
  const refs = [...winner.items].sort(compareEntries).slice(0, 5).map(contentRef);
  return {
    date: winner.date,
    count: winner.items.length,
    uniqueVideos: new Set(winner.items.map(normalizedRecordIdentity)).size,
    byType,
    records: refs,
  };
}

function buildOverview(index: AnnualIndex, year: number): { data: AnnualOverviewData; status: AnnualCardStatus; reason: string | null } {
  const entries = bucketFor(index, year).reliableEntries;
  const byType = Object.fromEntries(TYPE_ORDER.map((type) => [type, entries.filter((entry) => entry.type === type)])) as Record<PersonalRecordType, AnnualIndexedRecord[]>;
  const uniqueCounts = Object.fromEntries(TYPE_ORDER.map((type) => [type, uniqueCount(byType[type])])) as Record<PersonalRecordType, number>;
  const calendar = calendarForYear(entries, year);
  const activeDays = calendar.filter((day) => day.count > 0).length;
  const watchActiveDays = calendar.filter((day) => day.byType.watch > 0).length;
  const peakDay = peakDayForEntries(entries, year);
  const coverage = buildCoverage(bucketFor(index, year).entries, index.availableYears, index.options, year);
  const data: AnnualOverviewData = {
    counts: {
      watch: uniqueCounts.watch_history,
      liked: uniqueCounts.liked_videos,
      favorite: uniqueCounts.favorite_videos,
      total: new Set(entries.map(normalizedRecordIdentity)).size,
      watchEvents: byType.watch_history.length,
      likedEvents: byType.liked_videos.length,
      favoriteEvents: byType.favorite_videos.length,
    },
    activeDays,
    watchActiveDays,
    dateRange: coverage.dateRange,
    peakDay,
    calendar,
    coverage,
  };
  return {
    data,
    ...cardStatus(entries.length > 0, "这一年没有带可靠行为时间的记录"),
  };
}

function buildSampleOverview(index: AnnualIndex): { data: AnnualOverviewData; status: AnnualCardStatus; reason: string | null } {
  const reliable = index.entries.filter(isReliableAnnualEntry);
  const years = [...new Set(reliable.map((entry) => entry.zoned!.year))];
  const calendar = years.length === 1 ? calendarForYear(reliable, years[0]!) : [];
  return {
    data: {
      counts: {
        watch: index.uniqueByType.watch_history.length,
        liked: index.uniqueByType.liked_videos.length,
        favorite: index.uniqueByType.favorite_videos.length,
        total: index.uniqueEntries.length,
        watchEvents: index.byType.watch_history.length,
        likedEvents: index.byType.liked_videos.length,
        favoriteEvents: index.byType.favorite_videos.length,
      },
      activeDays: new Set(reliable.map((entry) => entry.zoned!.date)).size,
      watchActiveDays: new Set(reliable.filter((entry) => entry.type === "watch_history").map((entry) => entry.zoned!.date)).size,
      dateRange: index.coverage.dateRange,
      peakDay: peakDayForEntries(reliable),
      calendar,
      coverage: index.coverage,
    },
    ...cardStatus(index.entries.length > 0, "当前还没有可总结的记录"),
  };
}

function buildRhythmFromEntries(
  entries: readonly AnnualIndexedRecord[],
  missingReason: string,
): { data: AnnualRhythmData; status: AnnualCardStatus; reason: string | null } {
  const cellMap = new Map<string, AnnualIndexedRecord[]>();
  const weekdayCounts = new Map<number, number>();
  const hourCounts = new Map<number, number>();
  for (const entry of entries) {
    const zoned = entry.zoned!;
    const key = `${zoned.weekday}:${zoned.hour}`;
    const items = cellMap.get(key) ?? [];
    items.push(entry);
    cellMap.set(key, items);
    weekdayCounts.set(zoned.weekday, (weekdayCounts.get(zoned.weekday) ?? 0) + 1);
    hourCounts.set(zoned.hour, (hourCounts.get(zoned.hour) ?? 0) + 1);
  }
  const heatmap: AnnualHeatmapCell[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const items = cellMap.get(`${weekday}:${hour}`) ?? [];
      heatmap.push({ weekday, hour, count: items.length, uniqueVideos: new Set(items.map(normalizedRecordIdentity)).size });
    }
  }
  const weekdayRanked = [...weekdayCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const hourRanked = [...hourCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const activeDays = new Set(entries.map((entry) => entry.zoned!.date)).size;
  const sorted = [...entries].sort(compareEntries);
  const sufficient = entries.length >= 20 && activeDays >= 14;
  const personality = sufficient && weekdayRanked[0] && hourRanked[0]
    ? `你最常在${weekdayLabel(weekdayRanked[0][0])}${hourLabel(hourRanked[0][0])}打开抖音`
    : null;
  const data: AnnualRhythmData = {
    heatmap,
    mostActiveWeekday: weekdayRanked[0] ? { weekday: weekdayRanked[0][0], count: weekdayRanked[0][1] } : null,
    mostActiveHour: hourRanked[0] ? { hour: hourRanked[0][0], count: hourRanked[0][1] } : null,
    earliest: sorted[0] ? contentRef(sorted[0]) : null,
    latest: sorted.length ? contentRef(sorted[sorted.length - 1]!) : null,
    personality,
    threshold: { minimumRecords: 20, minimumActiveDays: 14 },
    watchRecordCount: entries.length,
    activeDays,
  };
  return { data, ...cardStatus(sufficient, missingReason) };
}

function buildRhythm(index: AnnualIndex, year: number): { data: AnnualRhythmData; status: AnnualCardStatus; reason: string | null } {
  return buildRhythmFromEntries(
    bucketFor(index, year).reliableEntries.filter((entry) => entry.type === "watch_history"),
    "观看历史不足以判断稳定的观看作息",
  );
}

function buildMonthlyFromEntries(
  entries: readonly AnnualIndexedRecord[],
  missingReason: string,
): { data: AnnualMonthlyData; status: AnnualCardStatus; reason: string | null } {
  const preferenceEntries = entries.filter(isPreferenceEntry);
  const months: AnnualMonthPoint[] = [];
  const availability = {
    liked: preferenceEntries.some((entry) => entry.type === "liked_videos"),
    favorite: preferenceEntries.some((entry) => entry.type === "favorite_videos"),
  };
  for (let month = 1; month <= 12; month += 1) {
    const monthEntries = preferenceEntries.filter((entry) => entry.zoned!.month === month);
    const liked = monthEntries.filter((entry) => entry.type === "liked_videos");
    const favorite = monthEntries.filter((entry) => entry.type === "favorite_videos");
    months.push({
      month,
      label: `${month}月`,
      liked: availability.liked ? uniqueCount(liked) : null,
      favorite: availability.favorite ? uniqueCount(favorite) : null,
      likedEvents: liked.length,
      favoriteEvents: favorite.length,
    });
  }
  const ranked = months.map((month) => ({
    month: month.month,
    label: month.label,
    count: month.likedEvents + month.favoriteEvents,
  })).sort((a, b) => b.count - a.count || a.month - b.month);
  const hasSeries = Object.values(availability).some(Boolean);
  return {
    data: {
      months,
      peakMonth: hasSeries && ranked[0] && ranked[0].count > 0 ? ranked[0] : null,
      seriesAvailability: availability,
      unavailableSeries: (["liked", "favorite"] as const).filter((type) => !availability[type]),
    },
    ...cardStatus(hasSeries, missingReason),
  };
}

function buildMonthly(index: AnnualIndex, year: number): { data: AnnualMonthlyData; status: AnnualCardStatus; reason: string | null } {
  return buildMonthlyFromEntries(bucketFor(index, year).reliableEntries, "这一年没有可按月比较的喜欢或收藏时间");
}

function buildCreatorsFromEntries(
  entries: readonly AnnualIndexedRecord[],
  missingReason: string,
): { data: AnnualCreatorsData; status: AnnualCardStatus; reason: string | null } {
  const groups = new Map<string, { name: string; id: string | null; keys: Set<string>; events: number }>();
  const idsByRecord = new Map<string, Set<string>>();
  const unknownKeys = new Set<string>();
  for (const entry of entries) {
    const author = authorOf(entry.record);
    if (!author.id) continue;
    const recordKey = normalizedRecordIdentity(entry);
    const ids = idsByRecord.get(recordKey) ?? new Set<string>();
    ids.add(author.id);
    idsByRecord.set(recordKey, ids);
  }
  for (const entry of entries) {
    const author = authorOf(entry.record);
    if (!author.name && !author.id) {
      unknownKeys.add(normalizedRecordIdentity(entry));
      continue;
    }
    const name = author.name?.toLocaleLowerCase() ?? null;
    const matchingIds = idsByRecord.get(normalizedRecordIdentity(entry));
    const resolvedId = author.id ?? (matchingIds?.size === 1 ? [...matchingIds][0]! : null);
    const key = resolvedId ? `authorId:${resolvedId}` : `authorName:${name}`;
    const group = groups.get(key) ?? { name: author.name ?? "未命名创作者", id: author.id, keys: new Set<string>(), events: 0 };
    if (author.name && (group.name === "未命名创作者" || compareText(author.name, group.name) < 0)) group.name = author.name;
    if (author.id) group.id = author.id;
    group.keys.add(normalizedRecordIdentity(entry));
    group.events += 1;
    groups.set(key, group);
  }
  const ranked = [...groups.values()].map((group) => ({ name: group.name, authorId: group.id, count: group.keys.size, events: group.events, share: 0 })).sort(compareForStableRank);
  const total = ranked.reduce((sum, item) => sum + item.count, 0);
  const top = ranked.slice(0, 10).map((item, index) => ({ ...item, rank: index + 1, share: total ? item.count / total : 0 }));
  const headShare = total && top[0] ? top[0].count / total : 0;
  const exploration = total > 0 ? groups.size / total : 0;
  return {
    data: { top, creatorCount: groups.size, unknownCount: unknownKeys.size, headShare, exploration },
    ...cardStatus(ranked.length > 0, missingReason),
  };
}

function buildCreators(index: AnnualIndex, year: number): { data: AnnualCreatorsData; status: AnnualCardStatus; reason: string | null } {
  return buildCreatorsFromEntries(bucketFor(index, year).reliableEntries, "年度记录中没有可识别的创作者");
}

function buildInterestsFromEntries(
  entries: readonly AnnualIndexedRecord[],
  missingReason: string,
): { data: AnnualInterestsData; status: AnnualCardStatus; reason: string | null } {
  // Interest metadata describes content, so the same video present in several
  // behavior lists contributes once rather than masquerading as repeat views.
  const topics = new Map<string, number>();
  const music = new Map<string, AnnualMusic>();
  const durations: AnnualDurationBucket[] = [
    { id: "under_15s", label: "15 秒以内", count: 0 },
    { id: "15_60s", label: "15 秒至 1 分钟", count: 0 },
    { id: "1_5m", label: "1 至 5 分钟", count: 0 },
    { id: "over_5m", label: "5 分钟以上", count: 0 },
  ];
  const durationValues: number[] = [];
  for (const entry of entries) {
    for (const topic of normalizeTopics(entry.record)) topics.set(topic, (topics.get(topic) ?? 0) + 1);
    const itemMusic = musicOf(entry.record);
    if (itemMusic) {
      const key = itemMusic.id ? `id:${itemMusic.id}` : `title:${itemMusic.title.toLocaleLowerCase()}`;
      const previous = music.get(key);
      music.set(key, previous ? { ...previous, count: previous.count + 1 } : { ...itemMusic, count: 1 });
    }
    const duration = durationOf(entry.record);
    if (duration !== null) {
      durationValues.push(duration);
      if (duration < 15) durations[0]!.count += 1;
      else if (duration < 60) durations[1]!.count += 1;
      else if (duration <= 300) durations[2]!.count += 1;
      else durations[3]!.count += 1;
    }
  }
  const topTopics = [...topics.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || compareText(a.name, b.name)).slice(0, 20);
  const topMusic = [...music.values()].sort((a, b) => b.count - a.count || compareText(a.title, b.title) || compareText(a.id ?? "", b.id ?? "")).slice(0, 10);
  durationValues.sort((a, b) => a - b);
  const averageSeconds = durationValues.length ? durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length : null;
  const middle = Math.floor(durationValues.length / 2);
  const medianSeconds = durationValues.length === 0
    ? null
    : durationValues.length % 2 === 1
      ? durationValues[middle]!
      : (durationValues[middle - 1]! + durationValues[middle]!) / 2;
  const signalCount = topTopics.length + topMusic.length + durationValues.length;
  return {
    data: {
      topics: topTopics,
      music: topMusic,
      durations,
      durationStats: { count: durationValues.length, averageSeconds, medianSeconds },
      signalCount,
    },
    ...cardStatus(signalCount > 0, missingReason),
  };
}

function buildInterests(index: AnnualIndex, year: number): { data: AnnualInterestsData; status: AnnualCardStatus; reason: string | null } {
  return buildInterestsFromEntries(
    uniqueEntries(bucketFor(index, year).reliableEntries.filter(isPreferenceEntry)),
    "年度喜欢与收藏记录缺少可用的话题、音乐或时长字段",
  );
}

function buildKept(index: AnnualIndex): { data: AnnualKeptData; status: AnnualCardStatus; reason: string | null } {
  const sets = index.snapshotSets;
  const watch = new Set(sets.watch_history.videoIds);
  const liked = new Set(sets.liked_videos.videoIds);
  const favorite = new Set(sets.favorite_videos.videoIds);
  const intersection = (left: Set<string>, right: Set<string>): number => [...left].filter((id) => right.has(id)).length;
  const allThree = [...watch].filter((id) => liked.has(id) && favorite.has(id)).length;
  const comparableVideoCount = new Set([...watch, ...liked, ...favorite]).size;
  const unknownIdRecordCount = TYPE_ORDER.reduce((sum, type) => sum + sets[type].unknownIdRecordCount, 0);
  return {
    data: {
      scope: "all_snapshot",
      sets: { watch: sets.watch_history, liked: sets.liked_videos, favorite: sets.favorite_videos },
      pairwise: {
        watchLiked: intersection(watch, liked),
        watchFavorite: intersection(watch, favorite),
        likedFavorite: intersection(liked, favorite),
      },
      allThree,
      comparableVideoCount,
      unknownIdRecordCount,
    },
    ...cardStatus(comparableVideoCount > 0, "已采集列表中没有可比较的 videoId"),
  };
}

function buildHighlightsFromEntries(
  timeEntries: readonly AnnualIndexedRecord[],
  contentEntries: readonly AnnualIndexedRecord[],
  peakDay: AnnualPeakDay | null,
  missingReason: string,
): { data: AnnualHighlightsData; status: AnnualCardStatus; reason: string | null } {
  const sorted = [...timeEntries].sort(compareEntries);
  const byPeak = peakDay?.records[0] ?? null;
  const withDuration = contentEntries.filter((entry) => durationOf(entry.record) !== null).sort((left, right) => {
    const delta = (durationOf(right.record) ?? 0) - (durationOf(left.record) ?? 0);
    return delta || compareEntries(left, right);
  });
  const withScore = contentEntries.filter((entry) => interactionScore(entry.record) !== null).sort((left, right) => {
    const delta = (interactionScore(right.record) ?? 0) - (interactionScore(left.record) ?? 0);
    return delta || compareEntries(left, right);
  });
  const data: AnnualHighlightsData = {
    first: sorted[0] ? contentRef(sorted[0]) : null,
    last: sorted.length ? contentRef(sorted[sorted.length - 1]!) : null,
    peakDay: byPeak,
    longest: withDuration[0] ? contentRef(withDuration[0]) : null,
    mostEngaged: withScore[0] ? contentRef(withScore[0]) : null,
  };
  return { data, ...cardStatus(Object.values(data).some(Boolean), missingReason) };
}

function buildHighlights(index: AnnualIndex, year: number, peakDay: AnnualPeakDay | null): { data: AnnualHighlightsData; status: AnnualCardStatus; reason: string | null } {
  const entries = bucketFor(index, year).reliableEntries;
  return buildHighlightsFromEntries(entries, entries, peakDay, "这一年没有可用于高光排序的可靠时间记录");
}

function weekdayLabel(weekday: number): string {
  return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][weekday] ?? "";
}

function hourLabel(hour: number): string {
  if (hour === 0) return " 00:00";
  if (hour < 12) return ` ${String(hour).padStart(2, "0")}:00`;
  if (hour === 12) return " 12:00";
  return ` ${String(hour).padStart(2, "0")}:00`;
}

function makeCard<T extends AnnualCardData>(manifest: AnnualCardManifest, result: { data: T; status: AnnualCardStatus; reason: string | null }): AnnualCard {
  return { ...manifest, ...result, notices: [] };
}

function noticesForCard(
  id: AnnualCardId,
  coverage: DataCoverage,
  snapshotCoverage: DataCoverage,
  kept: AnnualKeptData,
): string[] {
  const notices: string[] = [];
  if (coverage.partial) {
    notices.push(...(coverage.warnings.length ? coverage.warnings : ["采集状态为 partial，当前结果可能不完整"]));
  }
  if (id !== "kept" && snapshotCoverage.undatedRecordCount > 0) {
    notices.push(`${snapshotCoverage.undatedRecordCount} 条记录没有可用行为时间，未进入年度分析`);
  }
  if (id !== "kept" && coverage.unknownSourceRecordCount > 0) {
    notices.push(`${coverage.unknownSourceRecordCount} 条记录的行为时间来源不可靠，未进入年度分析`);
  }
  if ((id === "kept" || id === "summary") && kept.unknownIdRecordCount > 0) {
    notices.push(`${kept.unknownIdRecordCount} 条记录缺少可比较的 videoId，未进入列表交集`);
  }
  return [...new Set(notices)];
}

function buildSummary(
  overview: AnnualCard,
  creators: AnnualCard,
  interests: AnnualCard,
  kept: AnnualCard,
  coverage: DataCoverage,
  missingReason = "没有足够的年度数据生成摘要",
): { data: AnnualSummaryData; status: AnnualCardStatus; reason: string | null } {
  const overviewData = overview.data as AnnualOverviewData;
  const creatorsData = creators.data as AnnualCreatorsData;
  const interestsData = interests.data as AnnualInterestsData;
  const keptData = kept.data as AnnualKeptData;
  const hasAny = overviewData.counts.total > 0 || creatorsData.creatorCount > 0 || interestsData.signalCount > 0;
  return {
    data: {
      metrics: {
        activeDays: overviewData.activeDays,
        totalUniqueVideos: overviewData.counts.total,
        creatorCount: creatorsData.creatorCount,
        topTopic: interestsData.topics[0] ?? null,
        topCreator: creatorsData.top[0] ?? null,
        allThree: keptData.allThree,
      },
      coverage,
      sourceCardIds: ["overview", "rhythm", "monthly", "creators", "interests", "kept", "highlights"],
    },
    ...cardStatus(hasAny, missingReason),
  };
}

function sampleNoticesForCard(
  id: AnnualCardId,
  coverage: DataCoverage,
  kept: AnnualKeptData,
  spansYears: boolean,
  preferenceSpansYears: boolean,
): string[] {
  const notices: string[] = [];
  if (coverage.partial) notices.push(...(coverage.warnings.length ? coverage.warnings : ["采集状态为 partial，结论只代表当前样本"]));
  if (["overview", "rhythm", "monthly", "highlights"].includes(id)) {
    const withoutReliableTime = coverage.recordCount - coverage.reliableRecordCount;
    if (withoutReliableTime > 0) notices.push(`${withoutReliableTime} 条记录已进入内容统计，但未进入时间图表`);
  }
  if (id === "overview" && spansYears) notices.push("可靠行为时间跨越多个年份，未合并日期热力图");
  if (id === "monthly" && preferenceSpansYears) notices.push("喜欢与收藏时间跨越多个年份，未合并月份趋势");
  if ((id === "kept" || id === "summary") && kept.unknownIdRecordCount > 0) {
    notices.push(`${kept.unknownIdRecordCount} 条记录缺少可比较的 videoId，未进入列表交集`);
  }
  return [...new Set(notices)];
}

export function buildAnnualIndex(
  records: PersonalRecordCollection | null | undefined,
  options: AnnualIndexOptions = {},
): AnnualIndex {
  const entries: AnnualIndexedRecord[] = [];
  const byType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
  for (const type of TYPE_ORDER) byType[type] = [];
  for (const type of TYPE_ORDER) {
    const sourceRecords = safeTypeRecords(records, type);
    sourceRecords.forEach((record, sourceIndex) => {
      const timestamp = parseTimestamp(valueOf(record, ["occurredAt", "occurred_at"]));
      const source = sourceFor(record, options);
      const extracted = extractVideoId(record, type);
      const canonical = extracted.id ? `video:${extracted.id}` : canonicalUrl(valueOf(record, ["url", "shareUrl", "share_url", "videoUrl", "video_url"])) ? `url:${canonicalUrl(valueOf(record, ["url", "shareUrl", "share_url", "videoUrl", "video_url"]))}` : `record:${type}:${sourceIndex}:${cleanString(valueOf(record, ["id"])) ?? "unknown"}`;
      const entry: AnnualIndexedRecord = {
        type,
        record,
        videoId: extracted.id,
        comparisonKey: canonical,
        hasComparableVideoId: extracted.comparable,
        occurredAt: toIso(timestamp, valueOf(record, ["occurredAt", "occurred_at"])),
        occurredAtSource: source,
        timestamp,
        zoned: timestamp === null ? null : formatShanghai(timestamp),
        sourceIndex,
      };
      entries.push(entry);
      byType[type].push(entry);
    });
  }
  entries.sort(compareEntries);
  const uniqueByType = {} as Record<PersonalRecordType, AnnualIndexedRecord[]>;
  for (const type of TYPE_ORDER) uniqueByType[type] = uniqueEntries(byType[type]);
  const uniqueEntriesAll = uniqueEntries(entries, true);
  const reliable = entries.filter((entry) => entry.timestamp !== null && ACCEPTED_SOURCES.has(entry.occurredAtSource));
  const availableYears = [...new Set(reliable.map((entry) => entry.zoned!.year))].sort((a, b) => a - b);
  const nowTimestamp = normalizeNow(options.now);
  const defaultYear = chooseDefaultYear(availableYears, nowTimestamp);
  const snapshotSets = {} as Record<PersonalRecordType, AnnualSnapshotSet>;
  for (const type of TYPE_ORDER) {
    const ids = new Set<string>();
    let unknownIdRecordCount = 0;
    for (const entry of byType[type]) {
      if (entry.hasComparableVideoId && entry.videoId) ids.add(entry.videoId);
      else unknownIdRecordCount += 1;
    }
    snapshotSets[type] = {
      videoIds: [...ids].sort(compareStableString),
      recordCount: byType[type].length,
      unknownIdRecordCount,
    };
  }
  const normalizedOptions: AnnualIndexOptions = {
    ...options,
    timezone: ANNUAL_TIME_ZONE,
    warnings: [...new Set((options.warnings ?? []).filter((warning): warning is string => typeof warning === "string"))],
  };
  const coverage = buildCoverage(entries, availableYears, normalizedOptions, null);
  const yearBuckets = makeYearBuckets(entries);
  return {
    timezone: ANNUAL_TIME_ZONE,
    entries,
    records: entries,
    uniqueEntries: uniqueEntriesAll,
    byType,
    uniqueByType,
    yearBuckets,
    snapshotSets,
    coverage,
    availableYears,
    latestYear: availableYears.length ? availableYears[availableYears.length - 1]! : null,
    defaultYear,
    now: new Date(nowTimestamp).toISOString(),
    options: Object.freeze(normalizedOptions),
  };
}

export function getDefaultAnnualYear(index: AnnualIndex, now?: Date | string | number): number | null {
  const nowTimestamp = normalizeNow(now ?? index.options.now);
  return chooseDefaultYear(index.availableYears, nowTimestamp);
}

export function buildAnnualReport(index: AnnualIndex, year: number): AnnualReport {
  const requestedYear = Number.isFinite(year) ? Math.trunc(year) : Number.NaN;
  const normalizedYear = requestedYear >= 1900 && requestedYear <= 9_999
    ? requestedYear
    : index.defaultYear ?? currentShanghaiYear(parseTimestamp(index.now) ?? Date.now());
  const isAvailableYear = index.availableYears.includes(normalizedYear);
  const nowTimestamp = parseTimestamp(index.now) ?? Date.now();
  const isCurrentPartialYear = normalizedYear === currentShanghaiYear(nowTimestamp);
  const coverage = buildCoverage(bucketFor(index, normalizedYear).entries, index.availableYears, index.options, normalizedYear);
  const snapshotCoverage = index.coverage;
  const overviewResult = buildOverview(index, normalizedYear);
  const rhythmResult = buildRhythm(index, normalizedYear);
  const monthlyResult = buildMonthly(index, normalizedYear);
  const creatorsResult = buildCreators(index, normalizedYear);
  const interestsResult = buildInterests(index, normalizedYear);
  const keptResult = buildKept(index);
  const highlightsResult = buildHighlights(index, normalizedYear, overviewResult.data.peakDay);
  const byId = new Map<AnnualCardId, AnnualCard>();
  const results: Array<{ id: AnnualCardId; result: { data: AnnualCardData; status: AnnualCardStatus; reason: string | null } }> = [
    { id: "overview", result: overviewResult },
    { id: "rhythm", result: rhythmResult },
    { id: "monthly", result: monthlyResult },
    { id: "creators", result: creatorsResult },
    { id: "interests", result: interestsResult },
    { id: "kept", result: keptResult },
    { id: "highlights", result: highlightsResult },
  ];
  for (const item of results) {
    const manifest = ANNUAL_CARD_MANIFEST.find((candidate) => candidate.id === item.id)!;
    byId.set(item.id, makeCard(manifest, item.result));
  }
  const summaryResult = buildSummary(byId.get("overview")!, byId.get("creators")!, byId.get("interests")!, byId.get("kept")!, coverage);
  byId.set("summary", makeCard(ANNUAL_CARD_MANIFEST.find((candidate) => candidate.id === "summary")!, summaryResult));
  const keptData = byId.get("kept")!.data as AnnualKeptData;
  for (const [id, card] of byId) card.notices = noticesForCard(id, coverage, snapshotCoverage, keptData);
  const cards = ANNUAL_CARD_IDS.map((id) => byId.get(id)!).map((card) => ({ ...card }));
  const anyAnnualData = coverage.reliableRecordCount > 0;
  const status: AnnualReportStatus = anyAnnualData ? "ok" : index.entries.length > 0 ? "insufficient" : "empty";
  const report: AnnualReport = {
    year: normalizedYear,
    timezone: ANNUAL_TIME_ZONE,
    status,
    isAvailableYear,
    isCurrentPartialYear,
    periodLabel: isCurrentPartialYear ? `${normalizedYear}（截至当前）` : `${normalizedYear}`,
    coverage,
    snapshotCoverage,
    cards,
    cardManifest: ANNUAL_CARD_MANIFEST,
    manifest: ANNUAL_CARD_MANIFEST,
    overview: byId.get("overview")!,
    rhythm: byId.get("rhythm")!,
    monthly: byId.get("monthly")!,
    creators: byId.get("creators")!,
    interests: byId.get("interests")!,
    kept: byId.get("kept")!,
    highlights: byId.get("highlights")!,
    summary: byId.get("summary")!,
  };
  return report;
}

export function buildPersonalSummary(
  records: PersonalRecordCollection | null | undefined,
  options: AnnualIndexOptions = {},
): PersonalSummaryReport {
  const sampled: PersonalRecordCollection = {
    watch_history: safeTypeRecords(records, "watch_history"),
    liked_videos: safeTypeRecords(records, "liked_videos"),
    favorite_videos: safeTypeRecords(records, "favorite_videos"),
  };
  const index = buildAnnualIndex(sampled, options);
  const reliableEntries = index.entries.filter(isReliableAnnualEntry);
  const reliableYears = new Set(reliableEntries.map((entry) => entry.zoned!.year));
  const spansYears = reliableYears.size > 1;
  const reliablePreferenceEntries = reliableEntries.filter(isPreferenceEntry);
  const preferenceSpansYears = new Set(reliablePreferenceEntries.map((entry) => entry.zoned!.year)).size > 1;
  const overviewResult = buildSampleOverview(index);
  const rhythmResult = buildRhythmFromEntries(
    reliableEntries.filter((entry) => entry.type === "watch_history"),
    "当前观看样本不足以判断稳定的观看作息",
  );
  const monthlyResult = preferenceSpansYears
    ? buildMonthlyFromEntries([], "喜欢与收藏时间跨越多个年份，未合并月份趋势")
    : buildMonthlyFromEntries(reliablePreferenceEntries, "当前样本没有可按月比较的可靠喜欢或收藏时间");
  const creatorsResult = buildCreatorsFromEntries(index.entries, "当前样本中没有可识别的创作者");
  const interestsResult = buildInterestsFromEntries(
    uniqueEntries(index.entries.filter(isPreferenceEntry)),
    "喜欢与收藏样本缺少可用的话题、音乐或时长字段",
  );
  const keptResult = buildKept(index);
  const highlightsResult = buildHighlightsFromEntries(
    reliableEntries,
    index.uniqueEntries,
    overviewResult.data.peakDay,
    "当前样本缺少可用于高光展示的时间、时长或互动信息",
  );
  const byId = new Map<AnnualCardId, AnnualCard>();
  const results: Array<{ id: AnnualCardId; result: { data: AnnualCardData; status: AnnualCardStatus; reason: string | null } }> = [
    { id: "overview", result: overviewResult },
    { id: "rhythm", result: rhythmResult },
    { id: "monthly", result: monthlyResult },
    { id: "creators", result: creatorsResult },
    { id: "interests", result: interestsResult },
    { id: "kept", result: keptResult },
    { id: "highlights", result: highlightsResult },
  ];
  for (const item of results) {
    const manifest = PERSONAL_SUMMARY_CARD_MANIFEST.find((candidate) => candidate.id === item.id)!;
    byId.set(item.id, makeCard(manifest, item.result));
  }
  const summaryResult = buildSummary(
    byId.get("overview")!,
    byId.get("creators")!,
    byId.get("interests")!,
    byId.get("kept")!,
    index.coverage,
    "当前还没有足够的样本生成摘要",
  );
  byId.set("summary", makeCard(PERSONAL_SUMMARY_CARD_MANIFEST.find((candidate) => candidate.id === "summary")!, summaryResult));
  const keptData = keptResult.data;
  for (const [id, card] of byId) card.notices = sampleNoticesForCard(id, index.coverage, keptData, spansYears, preferenceSpansYears);
  const cards = ANNUAL_CARD_IDS.map((id) => ({ ...byId.get(id)! }));
  const nowTimestamp = parseTimestamp(index.now) ?? Date.now();
  return {
    status: index.entries.length > 0 ? "ok" : "empty",
    year: currentShanghaiYear(nowTimestamp),
    timezone: ANNUAL_TIME_ZONE,
    isAvailableYear: false,
    isCurrentPartialYear: false,
    periodLabel: "当前样本",
    coverage: index.coverage,
    snapshotCoverage: index.coverage,
    cards,
    cardManifest: PERSONAL_SUMMARY_CARD_MANIFEST,
    manifest: PERSONAL_SUMMARY_CARD_MANIFEST,
    overview: byId.get("overview")!,
    rhythm: byId.get("rhythm")!,
    monthly: byId.get("monthly")!,
    creators: byId.get("creators")!,
    interests: byId.get("interests")!,
    kept: byId.get("kept")!,
    highlights: byId.get("highlights")!,
    summary: byId.get("summary")!,
  };
}
