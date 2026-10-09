import {
  ANNUAL_TIME_ZONE,
  buildAnnualIndex,
  contentRef,
  isReliableAnnualEntry,
  type AnnualContentRef,
  type AnnualIndex,
  type AnnualIndexedRecord,
  type AnnualIndexOptions,
  type DataCoverage,
} from "./annualReport";
import type {
  PersonalRecordCollection,
  PersonalVideoRecord,
} from "./personalRecords";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CURRENT_DAYS = 30;
const DEFAULT_FALLBACK_DAYS = 90;
const MIN_WINDOW_RECORDS = 10;
const MIN_PROFILE_FIELD_RECORDS = 10;
const MIN_RHYTHM_RECORDS = 20;
const MIN_RHYTHM_DAYS = 7;

export type LivingReportStatus = "ok" | "partial" | "empty";
export type LivingFreshness = "fresh" | "stale" | "partial" | "unknown";
export type LivingConfidence = "high" | "medium" | "insufficient";
export type LivingDirection = "up" | "down" | "steady" | "new" | "unknown";
export type LivingChapterId = "current" | "rhythm" | "shift" | "profile" | "kept" | "continuation";

export interface LivingReportOptions extends AnnualIndexOptions {
  /** The collector snapshot time, deliberately separate from behavior time. */
  sourceUpdatedAt?: string | null;
  currentDays?: number;
  fallbackDays?: number;
}

export interface LivingWindow {
  label: string;
  days: number;
  startAt: string | null;
  endAt: string | null;
  recordCount: number;
  uniqueVideoCount: number;
  activeDays: number;
}

export interface LivingSignal {
  id: string;
  label: string;
  value: string;
  count: number;
  share: number;
  delta: number | null;
  direction: LivingDirection;
  confidence: LivingConfidence;
  evidence: AnnualContentRef[];
}

export interface LivingChapter {
  id: LivingChapterId;
  eyebrow: string;
  title: string;
  narrative: string;
  status: "ok" | "insufficient";
  confidence: LivingConfidence;
  signals: LivingSignal[];
  evidence: AnnualContentRef[];
  notice: string | null;
}

export type LivingAxisId = "exploration" | "breadth" | "depth" | "newness";

export interface LivingAxis {
  id: LivingAxisId;
  leftLabel: string;
  rightLabel: string;
  value: number | null;
  label: string | null;
  confidence: LivingConfidence;
  evidenceCount: number;
}

export interface LivingProfile {
  axes: LivingAxis[];
  confidence: LivingConfidence;
  notice: string | null;
}

export interface LivingReport {
  timezone: typeof ANNUAL_TIME_ZONE;
  status: LivingReportStatus;
  asOf: string;
  sourceUpdatedAt: string | null;
  freshness: LivingFreshness;
  coverage: DataCoverage;
  currentWindow: LivingWindow;
  comparisonWindow: LivingWindow;
  usedFallbackWindow: boolean;
  chapters: LivingChapter[];
  profile: LivingProfile;
}

interface RankedGroup {
  name: string;
  entries: AnnualIndexedRecord[];
}

interface WindowPair {
  current: AnnualIndexedRecord[];
  comparison: AnnualIndexedRecord[];
  days: number;
}

export function buildLivingReport(
  records: PersonalRecordCollection | null | undefined,
  options: LivingReportOptions = {},
): LivingReport {
  const index = buildAnnualIndex(records, options);
  const now = parseDate(index.now) ?? Date.now();
  const reliable = index.entries.filter(isReliableAnnualEntry);
  const requestedDays = positiveInteger(options.currentDays, DEFAULT_CURRENT_DAYS);
  const fallbackDays = Math.max(requestedDays, positiveInteger(options.fallbackDays, DEFAULT_FALLBACK_DAYS));
  let windows = makeWindows(reliable, now, requestedDays);
  let usedFallbackWindow = false;

  if (reliable.length > 0 && needsFallback(windows.current)) {
    windows = makeWindows(reliable, now, fallbackDays);
    usedFallbackWindow = true;
  }

  const currentWindow = describeWindow(windows.current, now, windows.days, "最近");
  const comparisonWindow = describeWindow(windows.comparison, now - windows.days * DAY_MS, windows.days, "此前");
  const freshness = classifyFreshness(options.sourceUpdatedAt, index.coverage.partial, now);
  const currentUnique = uniqueEntries(windows.current);
  const comparisonUnique = uniqueEntries(windows.comparison);
  const profile = buildProfile(index);
  const chapters = [
    buildCurrentChapter(currentUnique, currentWindow),
    buildRhythmChapter(windows.current, currentWindow),
    buildShiftChapter(currentUnique, comparisonUnique, currentWindow, comparisonWindow),
    buildProfileChapter(profile),
    buildKeptChapter(index),
    buildContinuationChapter(freshness, options.sourceUpdatedAt, usedFallbackWindow),
  ];

  return {
    timezone: ANNUAL_TIME_ZONE,
    status: index.entries.length === 0 ? "empty" : index.coverage.partial || reliable.length === 0 ? "partial" : "ok",
    asOf: index.now,
    sourceUpdatedAt: normalizeDate(options.sourceUpdatedAt),
    freshness,
    coverage: index.coverage,
    currentWindow,
    comparisonWindow,
    usedFallbackWindow,
    chapters,
    profile,
  };
}

function makeWindows(entries: readonly AnnualIndexedRecord[], now: number, days: number): WindowPair {
  const currentStart = now - days * DAY_MS;
  const comparisonStart = currentStart - days * DAY_MS;
  return {
    current: entries.filter((entry) => inRange(entry, currentStart, now)),
    comparison: entries.filter((entry) => inRange(entry, comparisonStart, currentStart, false)),
    days,
  };
}

function inRange(entry: AnnualIndexedRecord, start: number, end: number, includeEnd = true): boolean {
  return entry.timestamp !== null && entry.timestamp >= start && (includeEnd ? entry.timestamp <= end : entry.timestamp < end);
}

function needsFallback(entries: readonly AnnualIndexedRecord[]): boolean {
  return entries.length < MIN_WINDOW_RECORDS;
}

function describeWindow(
  entries: readonly AnnualIndexedRecord[],
  end: number,
  days: number,
  prefix: string,
): LivingWindow {
  const timestamps = entries.map((entry) => entry.timestamp).filter((value): value is number => value !== null);
  const start = end - days * DAY_MS;
  return {
    label: `${prefix}${days}天`,
    days,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    recordCount: entries.length,
    uniqueVideoCount: uniqueEntries(entries).length,
    activeDays: new Set(timestamps.map((timestamp) => shanghaiDate(timestamp))).size,
  };
}

function uniqueEntries(entries: readonly AnnualIndexedRecord[]): AnnualIndexedRecord[] {
  const map = new Map<string, AnnualIndexedRecord>();
  for (const entry of entries) {
    const key = entry.videoId ? `video:${entry.videoId}` : entry.comparisonKey;
    if (!map.has(key)) map.set(key, entry);
  }
  return [...map.values()].sort((left, right) => (left.timestamp ?? Infinity) - (right.timestamp ?? Infinity));
}

function buildCurrentChapter(entries: readonly AnnualIndexedRecord[], window: LivingWindow): LivingChapter {
  const topics = rankGroups(entries, topicsOf);
  const creators = rankGroups(entries, creatorsOf);
  const primary = topics[0] ?? creators[0];
  const signals = (topics.length ? topics : creators).slice(0, 3).map((group, index) => signalFromGroup(
    `current-${index}`,
    topics.length ? `#${group.name}` : group.name,
    group,
    entries.length,
    null,
    "unknown",
  ));
  const evidence = uniqueEvidence(signals.flatMap((signal) => signal.evidence));
  if (!primary) {
    return chapter(
      "current",
      "最近发生什么",
      "你最近在靠近什么？",
      `${window.label}里还没有足够的显式内容线索，先把这段足迹保留下来。`,
      "insufficient",
      "insufficient",
      [],
      evidence,
      "需要更多带可靠行为时间的记录才能形成当前主题。",
    );
  }
  const noun = topics.length ? `#${primary.name}` : primary.name;
  const confidence = confidenceFor(entries.length, window.activeDays);
  const enoughEvidence = confidence !== "insufficient";
  return chapter(
    "current",
    "最近发生什么",
    "你最近在靠近什么？",
    enoughEvidence
      ? `${window.label}里，${noun} 是你最常靠近的内容线索。`
      : `${window.label}里已经出现 ${noun} 的线索，但还不足以判断稳定倾向。`,
    enoughEvidence ? "ok" : "insufficient",
    confidence,
    signals,
    evidence,
    enoughEvidence ? null : "需要至少 3 个活跃日或更多可靠记录才能形成当前线索。",
  );
}

function buildRhythmChapter(entries: readonly AnnualIndexedRecord[], window: LivingWindow): LivingChapter {
  const watched = entries.filter((entry) => entry.type === "watch_history" && entry.zoned);
  const hourCounts = new Map<number, AnnualIndexedRecord[]>();
  for (const entry of watched) {
    const hour = entry.zoned!.hour;
    const bucket = hourCounts.get(hour) ?? [];
    bucket.push(entry);
    hourCounts.set(hour, bucket);
  }
  const ranked = [...hourCounts.entries()].sort((left, right) => right[1].length - left[1].length || left[0] - right[0]);
  const peak = ranked[0];
  const activeDays = new Set(watched.map((entry) => entry.zoned!.date)).size;
  if (!peak || watched.length < MIN_RHYTHM_RECORDS || activeDays < MIN_RHYTHM_DAYS) {
    return chapter(
      "rhythm",
      "你的节拍",
      "你的注意力有节拍。",
      "当前可靠观看时间还不足以判断稳定的出现时段。",
      "insufficient",
      "insufficient",
      [],
      [],
      `需要至少 ${MIN_RHYTHM_RECORDS} 条观看记录和 ${MIN_RHYTHM_DAYS} 个活跃日。`,
    );
  }
  const [hour, hourEntries] = peak;
  const signal = signalFromGroup(
    "peak-hour",
    "最常出现",
    { name: `${String(hour).padStart(2, "0")}:00`, entries: hourEntries },
    watched.length,
    null,
    "unknown",
  );
  return chapter(
    "rhythm",
    "你的节拍",
    "你的注意力有节拍。",
    `${window.label}里，你最常在 ${String(hour).padStart(2, "0")}:00 左右打开内容。`,
    "ok",
    confidenceFor(watched.length, activeDays),
    [signal],
    signal.evidence,
    null,
  );
}

function buildShiftChapter(
  current: readonly AnnualIndexedRecord[],
  comparison: readonly AnnualIndexedRecord[],
  currentWindow: LivingWindow,
  comparisonWindow: LivingWindow,
): LivingChapter {
  if (current.length < MIN_WINDOW_RECORDS || comparison.length < MIN_WINDOW_RECORDS) {
    return chapter(
      "shift",
      "偏好变化",
      "偏好正在转向哪里？",
      "还没有两个足够完整的时间窗口可以比较。",
      "insufficient",
      "insufficient",
      [],
      [],
      `需要当前和此前窗口各有至少 ${MIN_WINDOW_RECORDS} 条去重内容。`,
    );
  }
  const currentGroups = rankGroups(current, topicsOf);
  const comparisonGroups = rankGroups(comparison, topicsOf);
  if (!currentGroups.length || !comparisonGroups.length) {
    return chapter(
      "shift",
      "偏好变化",
      "偏好正在转向哪里？",
      "两个窗口还没有足够的显式主题可以比较。",
      "insufficient",
      "insufficient",
      [],
      [],
      "需要当前和此前窗口都带有可识别的话题字段。",
    );
  }
  const currentByName = new Map(currentGroups.map((group) => [group.name, group]));
  const comparisonByName = new Map(comparisonGroups.map((group) => [group.name, group]));
  const names = [...new Set([...currentByName.keys(), ...comparisonByName.keys()])];
  const changes = names.map((name) => {
    const currentGroup = currentByName.get(name);
    const comparisonGroup = comparisonByName.get(name);
    const currentCount = currentGroup?.entries.length ?? 0;
    const previous = comparisonGroup ? comparisonGroup.entries.length / comparison.length : 0;
    const share = currentCount / current.length;
    return {
      name,
      group: currentGroup ?? comparisonGroup!,
      currentCount,
      share,
      delta: share - previous,
    };
  }).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || right.share - left.share);
  const signals = changes.slice(0, 3).map(({ name, group, currentCount, share, delta }, index) => signalFromGroup(
    `shift-${index}`,
    `#${name}`,
    group,
    current.length,
    delta,
    delta > 0.08 ? "up" : delta < -0.08 ? "down" : "steady",
    share,
    currentCount,
  ));
  const lead = changes[0];
  if (!lead || Math.abs(lead.delta) <= 0.08) {
    return chapter(
      "shift",
      "偏好变化",
      "偏好正在转向哪里？",
      "两个窗口的主题占比变化还不够明显，先不把稳定波动写成转向。",
      "insufficient",
      "insufficient",
      [],
      [],
      "需要更大的窗口差异才能形成变化结论。",
    );
  }
  const narrative = lead
    ? `${currentWindow.label}里，#${lead.name} 相比${comparisonWindow.label}${lead.delta > 0 ? "上升" : "回落"}得最明显。`
    : "两个窗口里还没有足够稳定的显式主题。";
  return chapter(
    "shift",
    "偏好变化",
    "偏好正在转向哪里？",
    narrative,
    "ok",
    confidenceFor(current.length + comparison.length, currentWindow.activeDays + comparisonWindow.activeDays),
    signals,
    uniqueEvidence(signals.flatMap((signal) => signal.evidence)),
    null,
  );
}

function buildProfile(index: AnnualIndex): LivingProfile {
  const reliable = uniqueEntries(index.uniqueEntries.filter(isReliableAnnualEntry));
  const creators = rankGroups(reliable, creatorsOf);
  const creatorCount = creators.length;
  const total = reliable.length;
  const topShare = creators[0] && total ? creators[0].entries.length / total : null;
  const watch = reliable.filter((entry) => entry.type === "watch_history");
  const depthValues = watch.map(watchDepth).filter((value): value is number => value !== null);
  const publishedValues = reliable.map(newnessValue).filter((value): value is number => value !== null);
  const axes: LivingAxis[] = [
    axis("exploration", "熟悉", "探索", creatorCount && total >= MIN_PROFILE_FIELD_RECORDS ? (creatorCount / total) * 100 : null, total),
    axis("breadth", "专注", "广泛", topShare !== null && total >= MIN_PROFILE_FIELD_RECORDS ? (1 - topShare) * 100 : null, total),
    axis("depth", "采样", "深看", depthValues.length >= MIN_PROFILE_FIELD_RECORDS ? average(depthValues) : null, depthValues.length),
    axis("newness", "怀旧", "新鲜", publishedValues.length >= MIN_PROFILE_FIELD_RECORDS ? average(publishedValues) : null, publishedValues.length),
  ];
  const available = axes.filter((item) => item.value !== null);
  const confidence = total >= 50 && available.length >= 3
    ? "high"
    : total >= 20 && available.length >= 1
      ? "medium"
      : "insufficient";
  return {
    axes,
    confidence,
    notice: available.length < axes.length
      ? "部分画像轴缺少观看进度或发布时间字段，暂不补写结论。"
      : null,
  };
}

function buildProfileChapter(profile: LivingProfile): LivingChapter {
  const available = profile.axes.filter((axis) => axis.value !== null && axis.label);
  const narrative = available.length
    ? `从当前样本看，你更接近「${available.map((axis) => axis.label).join(" · ")}」这组内容倾向。`
    : "你的内容画像还在形成，当前样本不足以给出稳定倾向。";
  return chapter(
    "profile",
    "行为画像",
    "你如何选择内容？",
    narrative,
    available.length ? "ok" : "insufficient",
    profile.confidence,
    [],
    [],
    profile.notice,
  );
}

function buildKeptChapter(index: AnnualIndex): LivingChapter {
  const watch = new Set(index.snapshotSets.watch_history.videoIds);
  const liked = new Set(index.snapshotSets.liked_videos.videoIds);
  const favorite = new Set(index.snapshotSets.favorite_videos.videoIds);
  const allThree = [...watch].filter((id) => liked.has(id) && favorite.has(id));
  const comparable = new Set([...watch, ...liked, ...favorite]);
  const evidenceById = new Map<string, AnnualIndexedRecord>();
  for (const entry of index.entries) {
    if (entry.videoId && !evidenceById.has(entry.videoId)) evidenceById.set(entry.videoId, entry);
  }
  const evidence = allThree.map((id) => evidenceById.get(id)).filter((entry): entry is AnnualIndexedRecord => Boolean(entry)).slice(0, 3).map(contentRef);
  if (!comparable.size) {
    return chapter(
      "kept",
      "留下来的内容",
      "什么会被你留下？",
      "当前列表还没有足够的可比较 videoId。",
      "insufficient",
      "insufficient",
      [],
      evidence,
      "交集只使用真实 videoId，不猜测类别之间是否为同一内容。",
    );
  }
  const signal: LivingSignal = {
    id: "all-three",
    label: "三类列表都有",
    value: String(allThree.length),
    count: allThree.length,
    share: comparable.size ? allThree.length / comparable.size : 0,
    delta: null,
    direction: "unknown",
    confidence: "medium",
    evidence,
  };
  return chapter(
    "kept",
    "留下来的内容",
    "什么会被你留下？",
    `在已采集列表快照里，有 ${allThree.length} 个内容同时出现在观看、喜欢和收藏中。`,
    "ok",
    "medium",
    [signal],
    evidence,
    "这是当前列表快照，不代表行为转化率。",
  );
}

function buildContinuationChapter(
  freshness: LivingFreshness,
  sourceUpdatedAt: string | null | undefined,
  usedFallbackWindow: boolean,
): LivingChapter {
  const narrative = freshness === "fresh"
    ? "这份报告刚刚更新，新的记录会继续改变后续章节。"
    : freshness === "partial"
      ? "这次采集没有完整结束，先保留已经验证的部分。"
      : freshness === "stale"
        ? "数据已经有一段时间没有更新，下一次增量读取会让故事继续。"
        : "当前数据源没有可确认的更新时间。";
  const notice = usedFallbackWindow
    ? "最近 30 天样本不足，当前报告已扩大到最近 90 天。"
    : sourceUpdatedAt
      ? null
      : "报告只描述当前本地样本，不代表平台完整历史。";
  return chapter(
    "continuation",
    "故事还在继续",
    "这一章还在继续。",
    narrative,
    "ok",
    freshness === "fresh" ? "high" : freshness === "unknown" ? "insufficient" : "medium",
    [],
    [],
    notice,
  );
}

function rankGroups(
  entries: readonly AnnualIndexedRecord[],
  extractor: (record: PersonalVideoRecord) => string[],
): RankedGroup[] {
  const groups = new Map<string, AnnualIndexedRecord[]>();
  for (const entry of entries) {
    for (const name of extractor(entry.record)) {
      const group = groups.get(name) ?? [];
      if (!group.some((candidate) => stableKey(candidate) === stableKey(entry))) group.push(entry);
      groups.set(name, group);
    }
  }
  return [...groups.entries()]
    .map(([name, groupEntries]) => ({ name, entries: groupEntries }))
    .sort((left, right) => right.entries.length - left.entries.length || left.name.localeCompare(right.name, "zh-Hans"));
}

function signalFromGroup(
  id: string,
  label: string,
  group: RankedGroup,
  total: number,
  delta: number | null,
  direction: LivingDirection,
  shareOverride?: number,
  countOverride?: number,
): LivingSignal {
  const count = countOverride ?? group.entries.length;
  const share = shareOverride ?? (total ? group.entries.length / total : 0);
  return {
    id,
    label,
    value: `${count} 条`,
    count,
    share,
    delta,
    direction,
    confidence: confidenceFor(group.entries.length, new Set(group.entries.map((entry) => entry.zoned?.date).filter(Boolean)).size),
    evidence: group.entries.slice(0, 3).map(contentRef),
  };
}

function chapter(
  id: LivingChapterId,
  eyebrow: string,
  title: string,
  narrative: string,
  status: "ok" | "insufficient",
  confidence: LivingConfidence,
  signals: LivingSignal[],
  evidence: AnnualContentRef[],
  notice: string | null,
): LivingChapter {
  return { id, eyebrow, title, narrative, status, confidence, signals, evidence, notice };
}

function axis(id: LivingAxisId, leftLabel: string, rightLabel: string, value: number | null, evidenceCount: number): LivingAxis {
  const normalized = value === null ? null : Math.min(100, Math.max(0, value));
  return {
    id,
    leftLabel,
    rightLabel,
    value: normalized,
    label: normalized === null ? null : normalized < 35 ? leftLabel : normalized > 65 ? rightLabel : "中间倾向",
    confidence: normalized === null ? "insufficient" : evidenceCount >= 30 ? "high" : evidenceCount >= 10 ? "medium" : "insufficient",
    evidenceCount,
  };
}

function confidenceFor(recordCount: number, activeDays: number): LivingConfidence {
  if (recordCount >= 50 && activeDays >= 14) return "high";
  if (recordCount >= MIN_WINDOW_RECORDS && activeDays >= 3) return "medium";
  return "insufficient";
}

function topicsOf(record: PersonalVideoRecord): string[] {
  const values = Array.isArray(record.topics) ? record.topics : [];
  const fromTitle = [...(record.title ?? "").matchAll(/#([^#\s,，。.!！?？:：;；]{1,50})/gu)].map((match) => match[1] ?? "");
  return [...new Set([...values, ...fromTitle].map((value) => String(value).replace(/^#/u, "").trim()).filter(Boolean))].slice(0, 20);
}

function creatorsOf(record: PersonalVideoRecord): string[] {
  return record.author?.trim() ? [record.author.trim()] : [];
}

function watchDepth(entry: AnnualIndexedRecord): number | null {
  const progress = entry.record.watchProgress;
  if (typeof progress?.percent === "number" && Number.isFinite(progress.percent)) return progress.percent;
  if (typeof progress?.watchedSeconds === "number" && typeof entry.record.durationSeconds === "number" && entry.record.durationSeconds > 0) {
    return Math.min(100, Math.max(0, progress.watchedSeconds / entry.record.durationSeconds * 100));
  }
  return null;
}

function newnessValue(entry: AnnualIndexedRecord): number | null {
  if (!entry.occurredAt || !entry.record.publishedAt) return null;
  const occurred = parseDate(entry.occurredAt);
  const published = parseDate(entry.record.publishedAt);
  if (occurred === null || published === null) return null;
  const ageDays = Math.abs(occurred - published) / DAY_MS;
  return Math.min(100, Math.max(0, 100 - ageDays / 180 * 100));
}

function uniqueEvidence(evidence: readonly AnnualContentRef[]): AnnualContentRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = item.videoId ?? `${item.type}:${item.title}:${item.occurredAt ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function stableKey(entry: AnnualIndexedRecord): string {
  return entry.videoId ? `video:${entry.videoId}` : entry.comparisonKey;
}

function classifyFreshness(sourceUpdatedAt: string | null | undefined, partial: boolean, now: number): LivingFreshness {
  if (partial) return "partial";
  const timestamp = parseDate(sourceUpdatedAt);
  if (timestamp === null) return "unknown";
  return now - timestamp <= DAY_MS ? "fresh" : "stale";
}

function normalizeDate(value: string | null | undefined): string | null {
  const timestamp = parseDate(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

// 建一个格式化器比格式化一次贵得多，上万条记录每条新建一个要多花一秒
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: ANNUAL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

function shanghaiDate(timestamp: number): string {
  return SHANGHAI_DATE.format(new Date(timestamp));
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
