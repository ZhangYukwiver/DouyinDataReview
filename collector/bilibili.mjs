import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { BrowserConnectionError } from "./browserConnection.mjs";

/**
 * B 站读取走普通网页会话。每个账号都使用自己的 persistent context，cookie 只留在
 * 该账号的 data directory 里。这里不读取 Chrome/Edge 的现有 profile，也不保存 cookie
 * 到 JSON。服务端挂载时传入 resolveAccountDirectory，把账号注册表和平台目录接起来。
 */

export const BILIBILI_LISTS = Object.freeze({
  favorites: { label: "收藏夹" },
  history: { label: "观看历史" },
});

export const BILIBILI_ACTIVE_STATES = Object.freeze(["starting", "login", "syncing"]);

const BILIBILI_ORIGIN = "https://www.bilibili.com";
const API_ORIGIN = "https://api.bilibili.com";
const MAX_PAGE_SIZE = 40;
const MAX_FOLDERS = 100;
const MAX_ITEMS = 10_000;
const MAX_PAGES = 100;

export class BilibiliError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "BilibiliError";
    this.code = code;
    this.status = status;
  }
}

const text = (value, limit = 500) => typeof value === "string" ? value.trim().slice(0, limit) : (typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, limit) : "");
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const safeId = (value) => text(value, 80).replace(/[^\w:-]/gu, "_");

export function normalizeBvid(value) {
  // BVID 的字母部分大小写敏感。只接受标准的大写 BV 前缀，保留后面的原字符，
  // 否则把 BV1abCDefGHi 整段转大写会指向另一条作品。
  const bvid = text(value, 20);
  return /^BV[0-9A-Za-z]{10}$/u.test(bvid) ? bvid : null;
}

export function bvidFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/[.]bilibili[.]com$/u.test(url.hostname) && url.hostname !== "b23.tv") return null;
    return normalizeBvid(url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/u)?.[1]);
  } catch {
    return null;
  }
}

export function normalizeAccount(raw, accountId) {
  if (!raw || typeof raw !== "object") return null;
  const data = raw.data ?? raw;
  const mid = text(data.mid ?? data.uid, 40);
  const uname = text(data.uname ?? data.name, 120);
  if (!mid || !uname) return null;
  return {
    platform: "bilibili",
    accountId: safeId(accountId || "default"),
    mid,
    uname,
    avatar: text(data.face ?? data.avatar, 1000) || null,
    isLogin: data.isLogin === true,
  };
}

export function normalizeFolder(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? raw.media_id ?? "");
  if (!/^\d{1,30}$/u.test(id)) return null;
  return {
    id,
    title: text(raw.title ?? raw.name, 100) || "未命名收藏夹",
    mediaCount: Math.max(0, number(raw.media_count ?? raw.count) ?? 0),
    isDefault: raw.fav_state === 1 || raw.type === 0 || id === "0",
  };
}

function sourceOf(value) {
  if (value === "history" || value === "favorite") return value;
  if (value === null || value === undefined) return null;
  return "manual";
}

export function normalizeItem(raw, { accountId, source = "manual", folderId = null } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const bvid = normalizeBvid(raw.bvid ?? raw.bv_id) ?? bvidFromUrl(raw.url ?? raw.arcurl ?? "");
  if (!bvid) return null;
  const aid = text(raw.aid ?? raw.id, 30) || null;
  const owner = raw.owner ?? raw.author ?? {};
  const title = text(raw.title ?? raw.show_title, 300) || "无标题视频";
  const url = `https://www.bilibili.com/video/${bvid}`;
  const folderIds = Array.isArray(raw.folderIds) ? raw.folderIds.map(String).filter(id => /^\d{1,30}$/u.test(id)) : [];
  if (folderId && /^\d{1,30}$/u.test(String(folderId))) folderIds.push(String(folderId));
  return {
    platform: "bilibili",
    accountId: safeId(accountId || raw.accountId || "default"),
    key: `bilibili:${bvid}`,
    bvid,
    aid,
    title,
    author: text(typeof raw.author === "string" ? raw.author : owner.name ?? raw.author_name, 120) || null,
    authorId: text(raw.authorId ?? owner.mid ?? raw.author_mid, 40) || null,
    cover: text(raw.pic ?? raw.cover ?? raw.coverUrl, 1000).replace(/^http:\/\//u, "https://").replace(/^\/\//u, "https://") || null,
    url,
    durationSeconds: Math.max(0, number(raw.duration ?? raw.duration_seconds) ?? 0) || null,
    publishedAt: raw.pubdate ? isoFromSeconds(raw.pubdate) : text(raw.publishedAt, 40) || null,
    watchedAt: raw.view_at ? isoFromSeconds(raw.view_at) : text(raw.watchedAt, 40) || null,
    progress: raw.progress === -1 || raw.progress === null || raw.progress === undefined ? null : Math.max(0, number(raw.progress) ?? 0),
    sources: [...new Set([...(Array.isArray(raw.sources) ? raw.sources : []), sourceOf(source)].filter(Boolean))],
    folderIds: [...new Set(folderIds)],
    stats: {
      playCount: number(raw.stat?.view ?? raw.play_count),
      likeCount: number(raw.stat?.like ?? raw.like_count),
      commentCount: number(raw.stat?.reply ?? raw.comment_count),
    },
    savedAt: text(raw.savedAt, 40) || null,
  };
}

function isoFromSeconds(value) {
  const seconds = number(value);
  return seconds && seconds > 0 && seconds < 4_102_444_800 ? new Date(seconds * 1000).toISOString() : null;
}

export function mergeItems(items) {
  const byKey = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeItem(item, { accountId: item?.accountId, source: Array.isArray(item?.sources) && item.sources.length ? null : "manual" });
    if (!normalized) continue;
    const previous = byKey.get(normalized.key);
    if (!previous) {
      byKey.set(normalized.key, normalized);
      continue;
    }
    const merged = {
      ...previous,
      ...Object.fromEntries(Object.entries(normalized).filter(([key, value]) => value !== null && value !== "" && value !== undefined)),
      sources: [...new Set([...previous.sources, ...normalized.sources])],
      folderIds: [...new Set([...previous.folderIds, ...normalized.folderIds])],
      savedAt: previous.savedAt ?? normalized.savedAt,
    };
    byKey.set(normalized.key, merged);
  }
  return [...byKey.values()].slice(0, MAX_ITEMS);
}

function defaultAccountDirectory(dataDirectory, accountId) {
  // The resolver returns the platform account root. The default account keeps
  // Bilibili alongside the other platform roots; additional accounts follow
  // the same root and never add a second `bilibili` segment.
  const platformRoot = path.join(dataDirectory, "bilibili");
  return accountId === "default" ? platformRoot : path.join(platformRoot, "accounts", safeId(accountId));
}

async function launchContext(directory, { interactive = false } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launchPersistentContext(directory, {
        channel,
        headless: !interactive,
        viewport: { width: 1280, height: 800 },
        locale: "zh-CN",
      });
    } catch {
      // Try the next locally installed browser channel.
    }
  }
  throw new BrowserConnectionError("bilibili_browser_unavailable", "没有找到可用的 Chrome 或 Edge。B 站读取需要本机浏览器。", 503);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writeJson(file, value, signal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pageJson(page, url, signal) {
  signal?.throwIfAborted();
  const result = await page.evaluate(async target => {
    const response = await fetch(target, { credentials: "include", headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }, url);
  signal?.throwIfAborted();
  if (!result?.body || result.status < 200 || result.status >= 300) throw new BilibiliError("bilibili_upstream_failed", "B 站接口暂时没有返回有效数据。", 502);
  const code = Number(result.body.code ?? 0);
  if (code === -101 || result.body.data?.isLogin === false) throw new BilibiliError("bilibili_login_required", "B 站账号还没有登录，请先登录后重试。", 409);
  if (code !== 0) throw new BilibiliError("bilibili_upstream_failed", text(result.body.message, 200) || "B 站接口暂时不可用。", 502);
  return result.body;
}

async function currentAccount(page, signal) {
  const response = await pageJson(page, `${API_ORIGIN}/x/web-interface/nav`, signal);
  const account = normalizeAccount(response, "default");
  if (!account || account.isLogin !== true) throw new BilibiliError("bilibili_login_required", "B 站账号还没有登录，请先登录后重试。", 409);
  return account;
}

function profileDirectory(directory) {
  return path.join(directory, "browser-profile");
}

function snapshotFile(directory) {
  return path.join(directory, "snapshot.json");
}

async function ensurePage(context, url = BILIBILI_ORIGIN) {
  const page = context.pages?.()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page;
}

async function readFolders(page, account, signal) {
  const nav = account.mid;
  // `created/list` now returns -400 for web sessions. The page itself uses
  // list-all, which includes the default folder and remains available without
  // a client-side signature.
  const response = await pageJson(page, `${API_ORIGIN}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(nav)}&web_location=333.1387`, signal);
  const rawFolders = Array.isArray(response.data?.list) ? response.data.list : [];
  const expectedCount = number(response.data?.count ?? response.data?.total);
  const folders = rawFolders.map(normalizeFolder).filter(Boolean);
  if (rawFolders.length > MAX_FOLDERS || folders.length > MAX_FOLDERS || (expectedCount !== null && expectedCount > folders.length)) {
    throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹数量超出本次安全读取范围，本次没有覆盖本地快照。", 502);
  }
  return folders;
}

function pageSignature(rows, selector = value => value) {
  const values = rows.map(row => {
    const value = selector(row);
    if (value) return String(value);
    try { return JSON.stringify(row); } catch { return String(row); }
  });
  return values.sort().join("|");
}

async function readFolderItems(page, account, folder, signal) {
  const result = [];
  const seenPages = new Set();
  let complete = false;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    signal?.throwIfAborted();
    const url = `${API_ORIGIN}/x/v3/fav/resource/list?media_id=${encodeURIComponent(folder.id)}&pn=${pageNumber}&ps=${MAX_PAGE_SIZE}&keyword=&order=mtime&type=0&tid=0&platform=web`;
    const response = await pageJson(page, url, signal);
    const medias = response.data?.medias;
    if (!Array.isArray(medias) || !medias.length) {
      if (response.data?.has_more === true) throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹分页返回不完整，本次没有覆盖本地快照。", 502);
      complete = true;
      break;
    }
    const signature = pageSignature(medias, raw => raw?.bvid ?? raw?.bv_id ?? raw?.id ?? raw?.aid);
    if (!signature || seenPages.has(signature)) throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹分页重复，本次没有覆盖本地快照。", 502);
    seenPages.add(signature);
    result.push(...medias.map(raw => normalizeItem(raw, { accountId: account.accountId, source: "favorite", folderId: folder.id })).filter(Boolean));
    if (result.length > MAX_ITEMS) throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹超过本次安全读取上限，本次没有覆盖本地快照。", 502);
    if (response.data?.has_more !== true) {
      complete = true;
      break;
    }
    if (pageNumber === MAX_PAGES) throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹分页超过本次安全读取上限，本次没有覆盖本地快照。", 502);
  }
  if (!complete) throw new BilibiliError("bilibili_pagination_incomplete", "B 站收藏夹分页未完整结束，本次没有覆盖本地快照。", 502);
  return result;
}

async function readHistory(page, account, signal) {
  const result = [];
  const seenPages = new Set();
  let complete = false;
  // The endpoint uses pn for the web history page and remains readable without WBI signing.
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    signal?.throwIfAborted();
    const response = await pageJson(page, `${API_ORIGIN}/x/v2/history?pn=${pageNumber}`, signal);
    const rows = Array.isArray(response.data) ? response.data : [];
    if (!rows.length) {
      complete = true;
      break;
    }
    const signature = pageSignature(rows, raw => raw?.history?.bvid ?? raw?.bvid ?? raw?.history?.aid ?? raw?.aid ?? raw?.history?.kid ?? raw?.kid);
    if (!signature || seenPages.has(signature)) throw new BilibiliError("bilibili_pagination_incomplete", "B 站观看历史分页重复，本次没有覆盖本地快照。", 502);
    seenPages.add(signature);
    result.push(...rows.map(raw => normalizeItem(raw.history ?? raw, { accountId: account.accountId, source: "history" })).filter(Boolean));
    if (result.length > MAX_ITEMS) throw new BilibiliError("bilibili_pagination_incomplete", "B 站观看历史超过本次安全读取上限，本次没有覆盖本地快照。", 502);
    if (rows.length < 20) {
      complete = true;
      break;
    }
    if (pageNumber === MAX_PAGES) throw new BilibiliError("bilibili_pagination_incomplete", "B 站观看历史分页超过本次安全读取上限，本次没有覆盖本地快照。", 502);
  }
  if (!complete) throw new BilibiliError("bilibili_pagination_incomplete", "B 站观看历史分页未完整结束，本次没有覆盖本地快照。", 502);
  return result;
}

async function readDetail(page, bvid, signal) {
  const id = normalizeBvid(bvid);
  if (!id) throw new BilibiliError("invalid_request", "请输入有效的 BVID。", 400);
  const response = await pageJson(page, `${API_ORIGIN}/x/web-interface/view?bvid=${encodeURIComponent(id)}`, signal);
  const item = normalizeItem(response.data, { accountId: "default", source: "manual" });
  if (!item) throw new BilibiliError("bilibili_invalid_item", "B 站没有返回这个视频的有效信息。", 502);
  return { ...item, description: text(response.data?.desc, 10_000), pages: Array.isArray(response.data?.pages) ? response.data.pages.map(pageInfo => ({ cid: pageInfo.cid, part: text(pageInfo.part, 300), durationSeconds: number(pageInfo.duration) })) : [] };
}

function mergeSnapshot(snapshot, account, folders, folderItems, history, requested = ["favorites", "history"]) {
  const replaceFavorites = requested.includes("favorites");
  const replaceHistory = requested.includes("history");
  const preserved = (snapshot?.items ?? []).map(item => {
    const sources = Array.isArray(item?.sources) ? item.sources.filter(source =>
      !(replaceFavorites && source === "favorite") && !(replaceHistory && source === "history")) : [];
    return {
      ...item,
      sources,
      // Folder membership is wholly owned by a favorites sync. This removes
      // stale assignments after an upstream move/removal while retaining a
      // manual/history copy of the same video.
      folderIds: replaceFavorites ? [] : item?.folderIds,
    };
  }).filter(item => item.sources.length || item.savedAt);
  const items = mergeItems([
    ...preserved,
    ...(replaceFavorites ? folderItems : []),
    ...(replaceHistory ? history : []),
  ]);
  return {
    schemaVersion: 1,
    platform: "bilibili",
    account,
    fetchedAt: new Date().toISOString(),
    folders,
    items,
  };
}

export function createBilibili({ dataDirectory, resolveAccountDirectory = (id) => defaultAccountDirectory(dataDirectory, id), openContext = launchContext,
  onAccountIdentity = null, onSnapshot = null } = {}) {
  if (!dataDirectory) throw new TypeError("dataDirectory is required");
  const jobs = new Map();
  const writes = new Map();

  const directoryFor = accountId => resolveAccountDirectory(safeId(accountId || "default"));
  const readSnapshot = accountId => readJson(snapshotFile(directoryFor(accountId)));
  const notify = async (callback, value) => {
    if (typeof callback !== "function") return;
    await Promise.resolve(callback(value)).catch(() => undefined);
  };

  async function markLoggedOut(accountId, { directory = directoryFor(accountId), previous = null, signal } = {}) {
    const snapshot = previous ?? await readSnapshot(accountId);
    const account = snapshot?.account ? { ...snapshot.account, isLogin: false } : null;
    if (snapshot?.account) {
      signal?.throwIfAborted();
      // Keep fetchedAt, folders, items, savedAt and topic-facing local records
      // untouched; only the online state is changed after auth loss or a MID
      // mismatch. Registry callbacks likewise patch loggedIn only.
      await writeJson(snapshotFile(directory), { ...snapshot, account });
    }
    await notify(onAccountIdentity, { accountId: safeId(accountId || "default"), account, loggedIn: false });
    return snapshot?.account ? { ...snapshot, account } : snapshot;
  }
  const isAuthFailure = error => error?.code === "bilibili_login_required" || error?.code === "bilibili_account_mismatch";

  function enqueueWrite(accountId, task) {
    const key = safeId(accountId || "default");
    const previous = writes.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    writes.set(key, run.catch(() => undefined));
    return run.finally(() => { if (writes.get(key) === run) writes.delete(key); });
  }

  async function status(accountId = "default") {
    const snapshot = await readSnapshot(accountId);
    const job = [...jobs.values()].filter(value => value.accountId === safeId(accountId)).sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
    return { account: snapshot?.account ?? null, snapshot, job };
  }

  function start(accountId, type, task) {
    const id = randomUUID();
    const key = safeId(accountId || "default");
    const current = [...jobs.values()].find(value => value.accountId === key && BILIBILI_ACTIVE_STATES.includes(value.state));
    if (current) throw new BilibiliError("bilibili_busy", "B 站上一个操作还没结束，请稍等。", 409);
    const controller = new AbortController();
    const job = { id, accountId: key, type, state: type === "login" ? "login" : "starting", message: type === "login" ? "请在打开的 B 站窗口中登录。" : "正在读取 B 站…", error: null, startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(id, job);
    Object.defineProperty(job, "controller", { value: controller, enumerable: false });
    const completion = Promise.resolve().then(() => task(controller.signal)).then(() => {
      job.state = "done"; job.message = type === "login" ? "B 站登录成功。" : "B 站同步完成。";
    }, error => {
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      job.message = error instanceof Error ? error.message : "B 站操作失败。";
      job.error = error?.code ?? "bilibili_failed";
    }).finally(() => { job.finishedAt = new Date().toISOString(); });
    Object.defineProperty(job, "promise", { value: completion, enumerable: false });
    void completion;
    return { ...job };
  }

  function startLogin(accountId = "default", { expectedMid = null } = {}) {
    return start(accountId, "login", async signal => {
      const directory = directoryFor(accountId);
      const context = await openContext(profileDirectory(directory), { interactive: true });
      try {
        const page = await ensurePage(context, "https://passport.bilibili.com/login");
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          const response = await page.evaluate(async target => { const res = await fetch(target, { credentials: "include" }); return res.json().catch(() => null); }, `${API_ORIGIN}/x/web-interface/nav`);
          const account = normalizeAccount(response, safeId(accountId));
          if (account?.isLogin === true) {
            const previous = await readSnapshot(accountId);
            if (expectedMid && account.mid !== String(expectedMid)) {
              await markLoggedOut(accountId, { directory, previous, signal });
              throw new BilibiliError("bilibili_account_mismatch", "登录后识别到的 B 站账号与当前账号不一致，本次没有覆盖原资料。", 409);
            }
            await mkdir(path.dirname(snapshotFile(directory)), { recursive: true, mode: 0o700 });
            await writeJson(snapshotFile(directory), { ...(previous ?? { schemaVersion: 1, platform: "bilibili", folders: [], items: [] }), account, fetchedAt: new Date().toISOString() }, signal);
            await notify(onAccountIdentity, { accountId: safeId(accountId), account });
            return account;
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        throw new BilibiliError("bilibili_login_timeout", "B 站登录等待超时，请完成扫码后重试。", 408);
      } finally {
        await context.close().catch(() => undefined);
      }
    });
  }

  function startSync(accountId = "default", { lists = ["favorites", "history"], expectedMid = null } = {}) {
    const requested = [...new Set(Array.isArray(lists) ? lists : [])].filter(value => value in BILIBILI_LISTS);
    if (!requested.length) throw new BilibiliError("invalid_request", "至少选择收藏夹或观看历史。", 400);
    return start(accountId, "sync", async signal => enqueueWrite(accountId, async () => {
      const directory = directoryFor(accountId);
      const context = await openContext(profileDirectory(directory), { interactive: false });
      try {
        const page = await ensurePage(context);
        const account = { ...(await currentAccount(page, signal)), accountId: safeId(accountId || "default") };
        if (expectedMid && account.mid !== String(expectedMid)) {
          throw new BilibiliError("bilibili_account_mismatch", "当前 B 站登录账号已变化，本次没有覆盖原资料。", 409);
        }
        const previous = await readSnapshot(accountId);
        const folders = requested.includes("favorites") ? await readFolders(page, account, signal) : previous?.folders ?? [];
        const folderItems = requested.includes("favorites") ? (await Promise.all(folders.map(folder => readFolderItems(page, account, folder, signal)))).flat() : [];
        const history = requested.includes("history") ? await readHistory(page, account, signal) : [];
        await mkdir(path.dirname(snapshotFile(directory)), { recursive: true, mode: 0o700 });
        const snapshot = mergeSnapshot(previous, account, folders, folderItems, history, requested);
        await writeJson(snapshotFile(directory), snapshot, signal);
        await notify(onAccountIdentity, { accountId: safeId(accountId), account, lastSyncedAt: snapshot.fetchedAt });
        await notify(onSnapshot, { accountId: safeId(accountId), account, snapshot, directory, reason: "sync" });
        return snapshot;
      } catch (error) {
        if (isAuthFailure(error)) await markLoggedOut(accountId, { directory, signal }).catch(() => undefined);
        throw error;
      } finally {
        await context.close().catch(() => undefined);
      }
    }));
  }

  async function getDetail(accountId = "default", bvid, { signal, expectedMid = null } = {}) {
    const directory = directoryFor(accountId);
    const context = await openContext(profileDirectory(directory), { interactive: false });
    try {
      const page = await ensurePage(context);
      const account = await currentAccount(page, signal);
      if (expectedMid && account.mid !== String(expectedMid)) {
        throw new BilibiliError("bilibili_account_mismatch", "当前 B 站登录账号已变化，本次没有覆盖原资料。", 409);
      }
      const detail = await readDetail(page, bvid, signal);
      return { ...detail, accountId: safeId(accountId || "default"), account };
    } catch (error) {
      if (isAuthFailure(error)) await markLoggedOut(accountId, { directory, signal }).catch(() => undefined);
      throw error;
    } finally { await context.close().catch(() => undefined); }
  }

  async function save(accountId = "default", raw) {
    const directory = directoryFor(accountId);
    const item = normalizeItem(raw, { accountId, source: "manual" });
    if (!item) throw new BilibiliError("invalid_request", "请输入可识别的 B 站视频或 BVID。", 400);
    return enqueueWrite(accountId, async () => {
      const current = await readSnapshot(accountId);
      const now = new Date().toISOString();
      const snapshot = { ...(current ?? { schemaVersion: 1, platform: "bilibili", folders: [] }), account: current?.account ?? null, fetchedAt: now, items: mergeItems([...(current?.items ?? []), { ...item, savedAt: now }]) };
      await mkdir(path.dirname(snapshotFile(directory)), { recursive: true, mode: 0o700 });
      await writeJson(snapshotFile(directory), snapshot);
      await notify(onSnapshot, { accountId: safeId(accountId), account: snapshot.account, snapshot, directory, reason: "manual" });
      return snapshot.items.find(row => row.key === item.key) ?? item;
    });
  }

  async function logout(accountId = "default") {
    const active = [...jobs.values()].find(value => value.accountId === safeId(accountId) && BILIBILI_ACTIVE_STATES.includes(value.state));
    if (active) throw new BilibiliError("bilibili_busy", "B 站上一个操作还没结束，请稍等。", 409);
    const directory = directoryFor(accountId);
    const profile = profileDirectory(directory);
    // Keep the local snapshot and account association. Removing this directory only logs the
    // platform account out and lets the next login prove a new mid before replacing it.
    return enqueueWrite(accountId, async () => {
      await rm(profile, { recursive: true, force: true });
      const previous = await readSnapshot(accountId);
      if (previous?.account) {
        await writeJson(snapshotFile(directory), { ...previous, account: { ...previous.account, isLogin: false } });
      }
      await notify(onAccountIdentity, { accountId: safeId(accountId), account: previous?.account ? { ...previous.account, isLogin: false } : null, loggedIn: false });
      return { ok: true };
    });
  }

  async function close() {
    const active = [...jobs.values()].filter(value => BILIBILI_ACTIVE_STATES.includes(value.state));
    for (const job of active) job.controller?.abort?.();
    await Promise.allSettled(active.map(job => job.promise ?? Promise.resolve()));
    await Promise.allSettled([...writes.values()]);
  }

  return {
    status,
    startLogin,
    startSync,
    cancel(jobId, accountId = null) {
      const job = jobs.get(jobId);
      if (!job) return false;
      if (accountId !== null && job.accountId !== safeId(accountId || "default")) throw new BilibiliError("bilibili_account_mismatch", "不能取消其他 B 站账号的任务。", 409);
      job.controller?.abort?.();
      return true;
    },
    jobs,
    close,
    getDetail,
    save,
    logout,
    readSnapshot,
  };
}

export const bilibiliAccountDirectory = defaultAccountDirectory;

