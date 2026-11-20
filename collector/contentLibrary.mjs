import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { documentOf } from "./knowledgeBase.mjs";

/**
 * The cross-platform content index is deliberately independent from records.json.
 * Platform collectors can write snapshots here without changing the existing
 * account-specific Douyin record format. `sourceAccounts` keeps the identity
 * dimension while one canonical item represents the same platform object.
 */
export const CONTENT_LIBRARY_SCHEMA_VERSION = 1;
export const CONTENT_PLATFORMS = ["douyin", "xiaohongshu", "bilibili"];
export const CONTENT_SIGNALS = ["watched", "liked", "favorited", "saved", "manual"];
const MAX_ENTRIES = 200_000;
const MAX_TOPICS = 10_000;
const MAX_TOPIC_ITEMS = 50_000;
const MAX_TEXT = 200_000;
const MAX_TITLE = 500;
const MAX_URL = 4_096;
const MAX_ID = 300;
const MAX_ACCOUNT_ID = 100;
const MAX_ACCOUNT_NAME = 200;
const MAX_SEARCH = 200;
const STABLE_PLATFORM_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const SEARCH_STOP_WORDS = new Set("的 是 在 了 吗 呢 和 与 及 有 我 你 它 这 那 一个 什么 如何 怎么 哪些 是否 可以 请问 the a an is are of to and or in on for with what how why".split(" "));

function text(value, limit) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const valueText = String(value).trim();
  return valueText ? valueText.slice(0, limit) : null;
}

function optionalDate(value) {
  const valueText = text(value, 100);
  if (!valueText) return null;
  const time = Date.parse(valueText);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function latestTimestamp(...values) {
  return values.map(optionalDate).filter(Boolean).sort().at(-1) ?? null;
}

function earliestTimestamp(...values) {
  return values.map(optionalDate).filter(Boolean).sort().at(0) ?? null;
}

function validId(value, limit = MAX_ID) {
  const valueText = text(value, limit);
  return valueText && !/[\u0000\u0001-\u001F\u007F/\\]/u.test(valueText) ? valueText : null;
}

function validPlatform(value) {
  return CONTENT_PLATFORMS.includes(value) ? value : null;
}

function normalizeUrl(value) {
  const valueText = text(value, MAX_URL);
  if (!valueText) return null;
  try {
    const url = new URL(valueText);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSignals(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => CONTENT_SIGNALS.includes(item)))];
}

function normalizeAccountRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accountId = validId(value.accountId ?? value.id, MAX_ACCOUNT_ID);
  if (!accountId) return null;
  return {
    accountId,
    accountName: text(value.accountName ?? value.name, MAX_ACCOUNT_NAME),
    signals: normalizeSignals(value.signals ?? value.actions),
    lastSeenAt: optionalDate(value.lastSeenAt ?? value.seenAt),
    materials: (Array.isArray(value.materials) ? value.materials : []).map(normalizeMaterial).filter(Boolean).slice(0, 100),
  };
}

export function contentKey(platform, contentId) {
  const site = validPlatform(platform);
  const id = validId(contentId);
  if (!site || !id) return null;
  return `${site}:${id}`;
}

function normalizeMaterial(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = text(value.kind, 40);
  const materialText = text(value.text ?? value.body, MAX_TEXT);
  if (!kind || !materialText) return null;
  return {
    kind,
    key: text(value.key, MAX_ID),
    title: text(value.title, MAX_TITLE),
    text: materialText,
    createdAt: optionalDate(value.createdAt),
    source: text(value.source, 100),
  };
}

function mergeAccounts(current, incoming) {
  const byId = new Map((Array.isArray(current) ? current : []).map((item) => [item.accountId, {
    ...item,
    signals: [...item.signals],
    materials: (item.materials ?? []).map(material => ({ ...material })),
  }]));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const account = normalizeAccountRef(item);
    if (!account) continue;
    const existing = byId.get(account.accountId);
    if (!existing) {
      byId.set(account.accountId, account);
      continue;
    }
    byId.set(account.accountId, {
      accountId: account.accountId,
      accountName: account.accountName ?? existing.accountName,
      signals: [...new Set([...existing.signals, ...account.signals])],
      lastSeenAt: account.lastSeenAt ?? existing.lastSeenAt,
      materials: mergeMaterials(existing.materials, account.materials),
    });
  }
  return [...byId.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
}

function normalizeEntry(value, fallbackKey = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const platform = validPlatform(value.platform);
  const contentId = validId(value.contentId ?? value.nativeId);
  const key = contentKey(platform, contentId);
  if (!key || (fallbackKey && fallbackKey !== key)) return null;
  const now = new Date().toISOString();
  const materials = (Array.isArray(value.materials) ? value.materials : []).map(normalizeMaterial).filter(Boolean).slice(0, 100);
  return {
    key,
    platform,
    contentId,
    contentType: text(value.contentType ?? value.type, 40) ?? "unknown",
    title: text(value.title, MAX_TITLE) ?? "",
    body: text(value.body ?? value.text, MAX_TEXT),
    author: text(value.author, MAX_TITLE),
    authorId: validId(value.authorId, MAX_ID),
    url: normalizeUrl(value.url),
    coverUrl: normalizeUrl(value.coverUrl ?? value.cover),
    mediaType: text(value.mediaType, 40),
    publishedAt: optionalDate(value.publishedAt),
    stats: value.stats && typeof value.stats === "object" && !Array.isArray(value.stats) ? { ...value.stats } : null,
    topics: Array.isArray(value.topics) ? [...new Set(value.topics.map((item) => text(item, 100)).filter(Boolean))].slice(0, 100) : [],
    materials,
    sourceAccounts: mergeAccounts([], value.sourceAccounts ?? (value.accountId ? [{
      accountId: value.accountId,
      accountName: value.accountName,
      signals: value.signals ?? value.actions ?? [value.signal].filter(Boolean),
      lastSeenAt: value.lastSeenAt,
      materials: value.accountMaterials,
    }] : [])),
    firstSeenAt: optionalDate(value.firstSeenAt) ?? now,
    lastSeenAt: optionalDate(value.lastSeenAt) ?? now,
    savedAt: optionalDate(value.savedAt),
    updatedAt: optionalDate(value.updatedAt) ?? optionalDate(value.lastSeenAt) ?? now,
  };
}

function mergeEntry(current, incoming) {
  const next = normalizeEntry({ ...current, ...incoming }, current.key);
  if (!next) return current;
  return {
    ...current,
    ...next,
    title: next.title || current.title,
    body: next.body || current.body,
    author: next.author || current.author,
    authorId: next.authorId || current.authorId,
    url: next.url || current.url,
    coverUrl: next.coverUrl || current.coverUrl,
    mediaType: next.mediaType || current.mediaType,
    publishedAt: next.publishedAt || current.publishedAt,
    stats: next.stats || current.stats,
    topics: [...new Set([...(current.topics ?? []), ...(next.topics ?? [])])].slice(0, 100),
    materials: mergeMaterials(current.materials, next.materials),
    sourceAccounts: mergeAccounts(current.sourceAccounts, next.sourceAccounts),
    firstSeenAt: earliestTimestamp(current.firstSeenAt, next.firstSeenAt) ?? STABLE_PLATFORM_TIMESTAMP,
    lastSeenAt: latestTimestamp(current.lastSeenAt, next.lastSeenAt) ?? STABLE_PLATFORM_TIMESTAMP,
    savedAt: next.savedAt || current.savedAt,
    updatedAt: latestTimestamp(current.updatedAt, next.updatedAt) ?? STABLE_PLATFORM_TIMESTAMP,
  };
}

function mergeMaterials(current, incoming) {
  const map = new Map();
  for (const item of [...(current ?? []), ...(incoming ?? [])]) {
    const material = normalizeMaterial(item);
    if (!material) continue;
    const key = `${material.kind}:${material.key ?? ""}`;
    map.set(key, material);
  }
  return [...map.values()].slice(0, 100);
}

function normalizeTopic(value, fallbackId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = validId(value.id ?? fallbackId, 100);
  const name = text(value.name, 120);
  if (!id || !name) return null;
  const items = [...new Set((Array.isArray(value.items) ? value.items : []).map((item) => {
    if (typeof item === "string") return item;
    return item && typeof item === "object" ? contentKey(item.platform, item.contentId) ?? text(item.key, MAX_ID) : null;
  }).filter(Boolean))].slice(0, MAX_TOPIC_ITEMS);
  const now = new Date().toISOString();
  return {
    id,
    name,
    description: text(value.description, 500),
    items,
    createdAt: optionalDate(value.createdAt) ?? now,
    updatedAt: optionalDate(value.updatedAt) ?? now,
  };
}

function emptySnapshot() {
  return { schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION, updatedAt: null, entries: {}, topics: [] };
}

function normalizeSnapshot(value) {
  const snapshot = emptySnapshot();
  if (!value || typeof value !== "object" || Array.isArray(value)) return snapshot;
  const entries = value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : {};
  let count = 0;
  for (const [key, item] of Object.entries(entries)) {
    const normalized = normalizeEntry(item, key);
    if (!normalized) continue;
    snapshot.entries[normalized.key] = normalized;
    if (++count >= MAX_ENTRIES) break;
  }
  const topics = Array.isArray(value.topics) ? value.topics.map((item) => normalizeTopic(item)).filter(Boolean).slice(0, MAX_TOPICS) : [];
  snapshot.topics = topics.filter((topic, index, list) => list.findIndex((candidate) => candidate.id === topic.id) === index);
  snapshot.updatedAt = optionalDate(value.updatedAt);
  return snapshot;
}

function tokenize(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase();
  const result = [];
  for (const word of normalized.match(/[\u3400-\u9FFF]+|(?:(?![\u3400-\u9FFF])[\p{L}\p{N}])+/gu) ?? []) {
    if (/^[\u3400-\u9FFF]/u.test(word)) {
      for (let index = 0; index < word.length; index += 1) {
        if (!SEARCH_STOP_WORDS.has(word[index])) result.push(word[index]);
        if (index + 1 < word.length && !SEARCH_STOP_WORDS.has(word.slice(index, index + 2))) result.push(word.slice(index, index + 2));
      }
    } else if (!SEARCH_STOP_WORDS.has(word) && word.length < 100) result.push(word);
  }
  return result;
}

function matchesFilter(entry, filters = {}) {
  if (filters.platform && entry.platform !== filters.platform) return false;
  if (filters.accountId && !entry.sourceAccounts.some((item) => item.accountId === filters.accountId)) return false;
  if (filters.signal) {
    const signals = filters.signal === "saved" || filters.signal === "manual" ? ["saved", "manual"] : [filters.signal];
    if (!entry.sourceAccounts.some(item => (!filters.accountId || item.accountId === filters.accountId) && signals.some(signal => item.signals.includes(signal)))) return false;
  }
  if (filters.contentType && entry.contentType !== filters.contentType) return false;
  if (filters.topicId && !filters.topicKeys?.has(entry.key)) return false;
  return true;
}

function entrySearchText(entry) {
  return [entry.title, entry.body, entry.author, entry.authorId, entry.platform, entry.contentType, ...(entry.topics ?? []), ...(entry.materials ?? []).flatMap((item) => [item.title, item.text])].filter(Boolean).join(" ");
}

function scoreEntry(entry, query) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return 0;
  const haystack = entrySearchText(entry).normalize("NFKC").toLowerCase();
  let score = 0;
  let matchedPrimary = 0;
  const primaryTerms = terms.filter((term) => term.length > 1 || !/^[\u3400-\u9FFF]$/u.test(term));
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at < 0) continue;
    score += 1;
    if (primaryTerms.includes(term)) matchedPrimary += 1;
    if (entry.title.toLowerCase().includes(term)) score += 4;
    if (entry.author?.toLowerCase().includes(term)) score += 2;
  }
  return primaryTerms.length && matchedPrimary === 0 ? 0 : score;
}

function compareEntries(left, right) {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.lastSeenAt.localeCompare(left.lastSeenAt)
    || left.key.localeCompare(right.key);
}

function snippet(entry, query, limit = 260) {
  const source = [entry.body, ...(entry.materials ?? []).map((item) => item.text), entry.title].filter(Boolean).join("\n");
  const terms = tokenize(query);
  const lower = source.toLowerCase();
  const offset = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((item) => item >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, offset - Math.floor(limit / 3));
  return `${start > 0 ? "…" : ""}${source.slice(start, start + limit)}${start + limit < source.length ? "…" : ""}`;
}

function publicEntry(entry, includeText = false) {
  if (!entry) return null;
  const result = {
    ...entry,
    sourceAccounts: entry.sourceAccounts.map(({ materials: _materials, ...item }) => ({ ...item, signals: [...item.signals] })),
    materials: (entry.materials ?? []).map((item) => ({ ...item })),
  };
  if (!includeText) {
    delete result.body;
    result.materials = result.materials.map(({ text: _text, ...item }) => item);
  }
  return result;
}

function projectEntry(entry, accountId, materials = undefined) {
  if (!entry || !accountId) return entry;
  return {
    ...entry,
    sourceAccounts: entry.sourceAccounts.filter((item) => item.accountId === accountId),
    ...(materials === undefined ? { materials: [] } : { materials }),
  };
}

function analysisAccountKey(platform, accountId) {
  return `${platform}:${accountId}`;
}

async function mapConcurrent(values, limit, mapper) {
  const list = Array.from(values);
  const result = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      result[index] = await mapper(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return result;
}

function recordId(record) {
  return validId(record?.videoId)
    ?? validId(record?.contentId)
    ?? validId(record?.noteId ?? record?.note_id)
    ?? validId(record?.bvid)
    ?? validId(record?.aid)
    ?? (typeof record?.url === "string" ? /\/(?:video|note|item)\/([A-Za-z0-9_-]+)/u.exec(record.url)?.[1] : null)
    ?? (typeof record?.id === "string" ? record.id.replace(/^(?:watch_history|liked_videos|favorite_videos):/u, "") : null);
}

function mediaTypeOf(record, platform) {
  const value = String(record?.mediaType ?? record?.type ?? "").trim().toLowerCase();
  if (value === "video") return "video";
  if (value === "image" || value === "normal" || value === "note" || value === "图文") return "image";
  if (value === "live") return "live";
  return platform === "xiaohongshu" ? "image" : "video";
}

function recordToContent(record, platform, accountId, accountName, signal, sourceTimestamp = null) {
  const contentId = recordId(record);
  if (!contentId) return null;
  const mediaType = mediaTypeOf(record, platform);
  // Platform snapshots are periodically rebuilt. If a record has no event
  // timestamp, use the snapshot's own time (or a stable epoch fallback), never
  // Date.now(), so a refresh cannot reshuffle otherwise unchanged rows.
  const observedAt = optionalDate(record.occurredAt ?? record.watchedAt ?? record.updatedAt ?? record.exportedAt ?? record.fetchedAt ?? record.publishedAt ?? sourceTimestamp) ?? STABLE_PLATFORM_TIMESTAMP;
  return {
    platform,
    contentId,
    contentType: record.contentType ?? mediaType,
    title: record.title ?? record.desc ?? record.display_title ?? "",
    body: record.body ?? record.description ?? record.descText ?? null,
    author: record.author ?? record.user?.nickname ?? record.owner?.name ?? null,
    authorId: record.authorId ?? record.user?.user_id ?? record.owner?.mid ?? null,
    url: record.url ?? null,
    coverUrl: record.coverUrl ?? record.cover ?? null,
    mediaType,
    publishedAt: record.publishedAt ?? null,
    stats: record.stats ?? null,
    accountId,
    accountName,
    signals: [signal],
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    updatedAt: observedAt,
  };
}

export class ContentLibraryStore {
  constructor(dataDirectory, { analysisRoot = path.join(dataDirectory, "video-analysis") } = {}) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "content-library.json");
    this.metaFilePath = path.join(dataDirectory, "content-library-meta.json");
    this.analysisRoot = analysisRoot;
    this.analysisRoots = new Map();
    this.snapshot = null;
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load() {
    if (this.snapshot) return this.snapshot;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error instanceof SyntaxError) {
        const broken = `${this.filePath}.broken-${Date.now()}`;
        await rename(this.filePath, broken).catch(() => undefined);
      } else if (error?.code !== "ENOENT") {
        throw error;
      }
      parsed = emptySnapshot();
    }
    this.snapshot = normalizeSnapshot(parsed);
    // Topics and manually saved entries have their own recovery file. This
    // lets a damaged or deleted derived index be rebuilt without losing the
    // user's local organization.
    const metadata = await readFile(this.metaFilePath, "utf8").then(value => JSON.parse(value)).catch(() => null);
    if (metadata && typeof metadata === "object") {
      const meta = normalizeSnapshot({ entries: metadata.recoveryEntries ?? metadata.manualEntries, topics: metadata.topics, updatedAt: metadata.updatedAt });
      for (const [key, entry] of Object.entries(meta.entries)) this.snapshot.entries[key] = this.snapshot.entries[key] ? mergeEntry(this.snapshot.entries[key], entry) : entry;
      if (Array.isArray(metadata.topics)) this.snapshot.topics = meta.topics;
      this.snapshot.updatedAt ??= meta.updatedAt;
    }
    return this.snapshot;
  }

  async read(filters = {}) {
    const snapshot = await this.load();
    const topicKeys = filters.topicId ? new Set(snapshot.topics.find((topic) => topic.id === filters.topicId)?.items ?? []) : null;
    const query = text(filters.query, MAX_SEARCH) ?? "";
    let rows = Object.values(snapshot.entries).filter((entry) => matchesFilter(entry, { ...filters, topicKeys }));
    if (query) {
      rows = await mapConcurrent(rows, 8, async (entry) => ({ ...entry, materials: await this.materialsForEntry(entry, filters.accountId ?? null) }));
      rows = rows.map((entry) => ({ entry, score: scoreEntry(entry, query) })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || compareEntries(left.entry, right.entry)).map((item) => item.entry);
    }
    else rows.sort(compareEntries);
    const total = rows.length;
    const offset = Math.max(0, Number.isInteger(filters.offset) ? filters.offset : 0);
    const limit = Math.min(500, Math.max(1, Number.isInteger(filters.limit) ? filters.limit : 100));
    const items = rows.slice(offset, offset + limit).map((entry) => publicEntry(
      projectEntry(entry, filters.accountId, filters.accountId && query && filters.includeText === true ? entry.materials : undefined),
      filters.includeText === true,
    ));
    return { schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION, updatedAt: snapshot.updatedAt, total, items };
  }

  async get(key, { includeText = true, accountId = null } = {}) {
    const snapshot = await this.load();
    const entry = snapshot.entries[key];
    if (!entry) return null;
    if (accountId && !entry.sourceAccounts.some((item) => item.accountId === accountId)) return null;
    const materials = await this.materialsForEntry(entry, accountId);
    return publicEntry(projectEntry({ ...entry, materials }, accountId, materials), includeText);
  }

  async materialsForEntry(entry, accountId = null) {
    const relations = accountId
      ? entry.sourceAccounts.filter(account => account.accountId === accountId)
      : entry.sourceAccounts;
    const localMaterials = relations.flatMap(account => account.materials ?? []);
    const accountIds = relations.map(account => account.accountId);
    const diskMaterials = await this.analysisMaterials(entry.platform, entry.contentId, {
      accountIds: accountId || accountIds.length ? accountIds : null,
    });
    return mergeMaterials(accountId ? localMaterials : [...(entry.materials ?? []), ...localMaterials], diskMaterials);
  }

  registerAccountDirectory(accountId, directory, { platform = "douyin" } = {}) {
    const id = validId(accountId, MAX_ACCOUNT_ID);
    const site = validPlatform(platform);
    if (!id || !site || typeof directory !== "string" || !directory) throw Object.assign(new Error("账号目录无效。"), { code: "invalid_account_directory" });
    this.analysisRoots.set(analysisAccountKey(site, id), path.resolve(directory));
    return { platform: site, accountId: id, directory: path.resolve(directory) };
  }

  upsert(value) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const incoming = normalizeEntry(value);
      if (!incoming) throw Object.assign(new Error("内容条目缺少有效的平台或原生 ID。"), { code: "invalid_content" });
      if (!snapshot.entries[incoming.key] && Object.keys(snapshot.entries).length >= MAX_ENTRIES) throw Object.assign(new Error("内容库已达到上限。"), { code: "content_library_full" });
      snapshot.entries[incoming.key] = snapshot.entries[incoming.key] ? mergeEntry(snapshot.entries[incoming.key], incoming) : incoming;
      if (value?.accountId && !snapshot.entries[incoming.key].sourceAccounts.some((item) => item.accountId === value.accountId)) snapshot.entries[incoming.key].sourceAccounts = mergeAccounts(snapshot.entries[incoming.key].sourceAccounts, [value]);
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return publicEntry(snapshot.entries[incoming.key], true);
    });
  }

  upsertMany(items) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const saved = [];
      let count = Object.keys(snapshot.entries).length;
      for (const value of Array.isArray(items) ? items : []) {
        const incoming = normalizeEntry(value);
        if (!incoming) continue;
        if (!snapshot.entries[incoming.key] && ++count > MAX_ENTRIES) break;
        snapshot.entries[incoming.key] = snapshot.entries[incoming.key] ? mergeEntry(snapshot.entries[incoming.key], incoming) : incoming;
        saved.push(publicEntry(snapshot.entries[incoming.key], true));
      }
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return saved;
    });
  }

  /**
   * Rebuild platform relations from account snapshots. This deliberately
   * merges into the existing index, preserving hand-saved content and topic
   * references. Repeating it after a sync is idempotent.
   *
   * A snapshot is `{ platform, accountId, accountName, records }`, where
   * `records` is either CollectorStore's `{ records: {...} }` or the records
   * collection itself. `replaceAccount` removes stale relations for the
   * snapshot's account before adding the current rows.
   */
  rebuildFromSnapshots(snapshots, { replaceAccount = true } = {}) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const topicMembers = new Set(snapshot.topics.flatMap(topic => topic.items));
      const report = { added: 0, updated: 0, detached: 0, skipped: 0, accounts: [] };
      for (const source of Array.isArray(snapshots) ? snapshots : []) {
        const platform = validPlatform(source?.platform);
        const accountId = validId(source?.accountId, MAX_ACCOUNT_ID);
        if (!platform || !accountId) {
          report.skipped += 1;
          continue;
        }
        const accountName = text(source.accountName, MAX_ACCOUNT_NAME);
        if (platform === "douyin") {
          this.analysisRoots.set(analysisAccountKey(platform, accountId), path.resolve(source.analysisDirectory ?? path.join(this.dataDirectory, source.accountDirectory ?? "")));
        }
        const before = new Set();
        for (const entry of Object.values(snapshot.entries)) {
          if (!replaceAccount || entry.platform !== platform) continue;
          const relation = entry.sourceAccounts.find((item) => item.accountId === accountId);
          if (!relation) continue;
          before.add(entry.key);
          entry.sourceAccounts = entry.sourceAccounts.filter((item) => item.accountId !== accountId);
          const localSignals = relation.signals.filter(signal => signal === "manual" || signal === "saved");
          if (localSignals.length || topicMembers.has(entry.key)) entry.sourceAccounts.push({ ...relation, signals: localSignals });
          report.detached += 1;
        }
        const records = source.records?.records ?? source.records;
        const sourceTimestamp = source.updatedAt ?? source.exportedAt ?? source.fetchedAt ?? null;
        const rows = [];
        const groups = [];
        for (const [type, values] of Object.entries(records && typeof records === "object" ? records : {})) {
          if (type === "lists" && values && typeof values === "object") {
            for (const [listName, listValue] of Object.entries(values)) {
              const listRows = Array.isArray(listValue) ? listValue : listValue?.notes ?? listValue?.items ?? listValue?.records;
              if (Array.isArray(listRows)) groups.push([listName, listRows]);
            }
          } else if (Array.isArray(values)) groups.push([type, values]);
        }
        for (const [type, values] of groups) {
          const signal = type === "watch_history" ? "watched" : type === "liked_videos" ? "liked" : type === "favorite_videos" ? "favorited" : null;
          const listSignal = signal ?? (type === "saved" ? "saved" : type === "favorites" || type === "favorite" ? "favorited" : type === "likes" || type === "liked" ? "liked" : type === "history" || type === "watch" ? "watched" : null);
          if (!listSignal) continue;
          for (const record of values) {
            const item = recordToContent(record, platform, accountId, accountName, listSignal, sourceTimestamp);
            if (item) rows.push(item);
            else report.skipped += 1;
          }
        }
        for (const value of rows) {
          const incoming = normalizeEntry(value);
          if (!incoming) {
            report.skipped += 1;
            continue;
          }
          const old = snapshot.entries[incoming.key];
          snapshot.entries[incoming.key] = old ? mergeEntry(old, incoming) : incoming;
          if (old) report.updated += 1;
          else report.added += 1;
          before.delete(incoming.key);
        }
        // Analysis results are account-local material too. A video may have
        // been analyzed before its platform sync record was imported, so make
        // that material discoverable instead of requiring a duplicate record.
        if (platform === "douyin" && source.analysisDirectory) {
          const analysisRoot = path.resolve(source.analysisDirectory);
          for (const contentId of await this.analysisContentIdsFromRoot(analysisRoot)) {
            const materials = await this.readAnalysisMaterialsFromRoot(analysisRoot, contentId);
            if (!materials.length) continue;
            const incoming = normalizeEntry({
              platform,
              contentId,
              // AI-generated material titles are account-private; keep the
              // canonical item title neutral until a platform record supplies
              // a public title.
              title: "",
              accountMaterials: materials,
              accountId,
              accountName,
              firstSeenAt: sourceTimestamp ?? STABLE_PLATFORM_TIMESTAMP,
              lastSeenAt: sourceTimestamp ?? STABLE_PLATFORM_TIMESTAMP,
              updatedAt: sourceTimestamp ?? STABLE_PLATFORM_TIMESTAMP,
            });
            if (!incoming) continue;
            const old = snapshot.entries[incoming.key];
            snapshot.entries[incoming.key] = old ? mergeEntry(old, incoming) : incoming;
            if (old) report.updated += 1;
            else report.added += 1;
            before.delete(incoming.key);
          }
        }
        report.accounts.push({ platform, accountId, records: rows.length, staleRelationsDetached: before.size });
      }
      for (const [key, entry] of Object.entries(snapshot.entries)) {
        if (!entry.sourceAccounts.length && !entry.savedAt && !topicMembers.has(key)) delete snapshot.entries[key];
      }
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return report;
    });
  }

  manualSave(value) {
    return this.upsert({ ...value, signals: [...new Set([...(value?.signals ?? []), "manual", "saved"])], savedAt: new Date().toISOString() });
  }

  async accountImpact(accountId, platform = null) {
    const snapshot = await this.load();
    const entries = Object.values(snapshot.entries).filter((entry) => entry.sourceAccounts.some((item) => item.accountId === accountId && (!platform || entry.platform === platform)));
    const keys = new Set(entries.map(entry => entry.key));
    const topics = snapshot.topics.filter(topic => topic.items.some(key => keys.has(key)));
    return { accountId, platform, entries: entries.map((entry) => entry.key), entryCount: entries.length, topicIds: topics.map((topic) => topic.id), topicCount: topics.length };
  }

  detachAccount(accountId, { platform = null, deleteOrphans = false } = {}) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const impact = await this.accountImpact(accountId, platform);
      const removed = [];
      for (const [key, entry] of Object.entries(snapshot.entries)) {
        const matchingRelations = entry.sourceAccounts.filter((item) => item.accountId === accountId && (!platform || entry.platform === platform));
        const matching = matchingRelations.length > 0;
        if (!matching) continue;
        entry.sourceAccounts = entry.sourceAccounts.filter((item) => !(item.accountId === accountId && (!platform || entry.platform === platform)));
        if (matchingRelations.some(item => item.signals.includes("manual") || item.signals.includes("saved"))
          && !entry.sourceAccounts.some(item => item.signals.includes("manual") || item.signals.includes("saved"))) {
          entry.savedAt = null;
        }
        // Account deletion is a local-data deletion: if the removed account
        // was the last source, its private hand-saved entry is an orphan too.
        // Entries with another account relation remain available, including
        // their manual signal and topic references.
        if (deleteOrphans && entry.sourceAccounts.length === 0) {
          delete snapshot.entries[key];
          removed.push(key);
        }
      }
      if (deleteOrphans && removed.length) {
        const removedSet = new Set(removed);
        for (const topic of snapshot.topics) topic.items = topic.items.filter((key) => !removedSet.has(key));
      }
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return { detached: true, removed, impact };
    });
  }

  async listTopics() {
    const snapshot = await this.load();
    return snapshot.topics.map((topic) => ({ ...topic, items: [...topic.items] }));
  }

  createTopic(value) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const topic = normalizeTopic({ ...value, id: value?.id ?? randomUUID() });
      if (!topic) throw Object.assign(new Error("专题需要名称。"), { code: "invalid_topic" });
      if (snapshot.topics.some((item) => item.id === topic.id)) throw Object.assign(new Error("专题已存在。"), { code: "topic_exists" });
      if (snapshot.topics.length >= MAX_TOPICS) throw Object.assign(new Error("专题数量已达到上限。"), { code: "topic_limit" });
      topic.items = topic.items.filter((key) => snapshot.entries[key]);
      snapshot.topics.push(topic);
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return { ...topic, items: [...topic.items] };
    });
  }

  updateTopic(id, patch) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const index = snapshot.topics.findIndex((topic) => topic.id === id);
      if (index < 0) throw Object.assign(new Error("没有这个专题。"), { code: "topic_not_found" });
      const topic = normalizeTopic({ ...snapshot.topics[index], ...patch, id });
      if (!topic) throw Object.assign(new Error("专题名称无效。"), { code: "invalid_topic" });
      topic.items = topic.items.filter((key) => snapshot.entries[key]);
      snapshot.topics[index] = topic;
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return { ...topic, items: [...topic.items] };
    });
  }

  deleteTopic(id) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const before = snapshot.topics.length;
      snapshot.topics = snapshot.topics.filter((topic) => topic.id !== id);
      if (before === snapshot.topics.length) throw Object.assign(new Error("没有这个专题。"), { code: "topic_not_found" });
      snapshot.updatedAt = new Date().toISOString();
      await this.write(snapshot);
      return { deleted: true, id };
    });
  }

  addToTopic(topicId, keyOrValue, note = null) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const topic = snapshot.topics.find((item) => item.id === topicId);
      if (!topic) throw Object.assign(new Error("没有这个专题。"), { code: "topic_not_found" });
      const key = typeof keyOrValue === "string" ? keyOrValue : contentKey(keyOrValue?.platform, keyOrValue?.contentId);
      if (!key || !snapshot.entries[key]) throw Object.assign(new Error("内容还没有保存到内容库。"), { code: "content_not_found" });
      if (!topic.items.includes(key)) {
        if (topic.items.length >= MAX_TOPIC_ITEMS) throw Object.assign(new Error("专题内容已达到上限。"), { code: "topic_full" });
        topic.items.push(key);
      }
      snapshot.updatedAt = new Date().toISOString();
      topic.updatedAt = snapshot.updatedAt;
      await this.write(snapshot);
      return { topic: { ...topic, items: [...topic.items] }, key, note: text(note, 500) };
    });
  }

  removeFromTopic(topicId, key) {
    return this.enqueue(async () => {
      const snapshot = await this.load();
      const topic = snapshot.topics.find((item) => item.id === topicId);
      if (!topic) throw Object.assign(new Error("没有这个专题。"), { code: "topic_not_found" });
      topic.items = topic.items.filter((item) => item !== key);
      topic.updatedAt = new Date().toISOString();
      snapshot.updatedAt = topic.updatedAt;
      await this.write(snapshot);
      return { topic: { ...topic, items: [...topic.items] }, key };
    });
  }

  async search(query, filters = {}) {
    return this.read({ ...filters, query, includeText: true });
  }

  async analysisMaterials(platform, contentId, { accountIds = null } = {}) {
    if (platform !== "douyin" || !/^\d{1,24}$/u.test(String(contentId ?? ""))) return [];
    const roots = accountIds === null || accountIds === undefined
      ? [this.analysisRoot, ...[...this.analysisRoots.entries()].filter(([key]) => key.startsWith("douyin:")).map(([, root]) => root)]
      : [...new Set(accountIds.map(accountId => this.analysisRoots.get(analysisAccountKey(platform, accountId))).filter(Boolean))];
    const uniqueRoots = [...new Set(roots)];
    const materials = [];
    for (const root of uniqueRoots) {
      materials.push(...await this.readAnalysisMaterialsFromRoot(root, contentId));
    }
    const seen = new Set();
    return materials.filter((item) => {
      const key = `${item.kind}:${item.key ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async readAnalysisMaterialsFromRoot(root, contentId) {
    const directory = path.join(root, String(contentId), "results");
    const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const results = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json") || file.name.startsWith(".")) continue;
      const value = await readFile(path.join(directory, file.name), "utf8").then(JSON.parse).catch(() => null);
      if (!value || !["transcript", "notes", "script"].includes(value.kind)) continue;
      const document = documentOf(String(contentId), value);
      if (!document?.text?.trim()) continue;
      results.push(normalizeMaterial({ kind: document.kind, key: document.key, title: document.title, text: document.text, createdAt: document.createdAt, source: "douyin-video-analysis" }));
    }
    return results.filter(Boolean);
  }

  async analysisContentIdsFromRoot(root) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.isDirectory() && /^\d{1,24}$/u.test(entry.name)).map(entry => entry.name);
  }

  async questionSources({ query, filterQuery = null, scope = "library", topicId = null, key = null, platform = null, accountId = null, signal = null, limit = 4 } = {}) {
    const snapshot = await this.load();
    const topicKeys = topicId ? new Set(snapshot.topics.find((topic) => topic.id === topicId)?.items ?? []) : null;
    const contentQuery = text(filterQuery, MAX_SEARCH) ?? "";
    const questionQuery = text(query, MAX_SEARCH) ?? "";
    const candidates = Object.values(snapshot.entries).filter((entry) => {
      if (scope === "item" && (!key || entry.key !== key)) return false;
      if (scope === "item" && topicId && (!topicKeys || !topicKeys.has(entry.key))) return false;
      if (scope === "topic" && (!topicKeys || !topicKeys.has(entry.key))) return false;
      return matchesFilter(entry, { platform, accountId, signal, topicKeys: topicId ? topicKeys : null });
    });
    const hydrated = await mapConcurrent(candidates, 8, async (entry) => ({ ...entry, materials: await this.materialsForEntry(entry, accountId) }));
    const requireQuestionMatch = scope === "library";
    const ranked = hydrated.map((entry) => ({
      entry,
      score: scoreEntry(entry, questionQuery),
      filterScore: contentQuery ? scoreEntry(entry, contentQuery) : 1,
    })).filter((item) => (!contentQuery || item.filterScore > 0) && (!questionQuery || item.score > 0 || !requireQuestionMatch))
      .sort((left, right) => right.score - left.score || right.filterScore - left.filterScore || compareEntries(left.entry, right.entry))
      .slice(0, Math.min(20, Math.max(1, limit)));
    const sources = [];
    for (const { entry } of ranked) {
      const materials = entry.materials ?? [];
      const body = entry.body || materials.map((item) => item.text).join("\n\n") || entry.title;
      sources.push({ citation: `C${sources.length + 1}`, entryKey: entry.key, platform: entry.platform, contentId: entry.contentId, title: entry.title, url: entry.url, accountIds: accountId ? entry.sourceAccounts.filter((item) => item.accountId === accountId).map((item) => item.accountId) : entry.sourceAccounts.map((item) => item.accountId), quote: snippet({ ...entry, body, materials }, query ?? "", 1_500) });
    }
    return sources;
  }

  buildQuestionPrompt(question, sources) {
    const safe = (value) => String(value ?? "").replace(/<(\/?)解析片段>/gu, "＜$1解析片段＞");
    return `任务：跨平台内容库问答。问题：${safe(question)}\n以下是本地内容库检索出的片段，不是全部内容。材料不足时明确说明，不把未检索到视为内容中没有。回答关键事实必须标注给定的 [C编号]，不得编造引用编号。\n<解析片段>\n${(sources ?? []).map((source) => `[${safe(source.citation)}] ${source.platform} ${source.title ? `《${safe(source.title)}》` : ""}\n${safe(source.quote)}`).join("\n\n")}\n</解析片段>`;
  }

  async write(snapshot) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ ...snapshot, schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, this.filePath);
    const topicKeys = new Set(snapshot.topics.flatMap(topic => topic.items));
    // Keep every entry needed to reopen a local topic, not just manually
    // saved entries. The derived platform index may be deleted/rebuilt later.
    const recoveryEntries = Object.fromEntries(Object.entries(snapshot.entries).filter(([key, entry]) => topicKeys.has(key) || Boolean(entry.savedAt) || entry.sourceAccounts.some((item) => item.signals.includes("manual"))));
    const metadataPath = `${this.metaFilePath}.${process.pid}.tmp`;
    const metadataFile = await open(metadataPath, "w", 0o600);
    try {
      await metadataFile.writeFile(`${JSON.stringify({ schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION, updatedAt: snapshot.updatedAt, topics: snapshot.topics, manualEntries: recoveryEntries, recoveryEntries })}\n`);
      await metadataFile.sync();
    } finally {
      await metadataFile.close();
    }
    await rename(metadataPath, this.metaFilePath);
  }
}

export function normalizeContentLibrarySnapshot(value) {
  return normalizeSnapshot(value);
}

export function createContentLibrary(dataDirectory, options) {
  return new ContentLibraryStore(dataDirectory, options);
}

