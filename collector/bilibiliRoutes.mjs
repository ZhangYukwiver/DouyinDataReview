import path from "node:path";

import { BilibiliError, createBilibili } from "./bilibili.mjs";
import { prepareBilibiliProtocol } from "./bilibiliProtocol.mjs";
import { isPlatformAccountId } from "./platformAccounts.mjs";

/**
 * HTTP adapter for the B 站 collector. The server owns CORS, bearer-token
 * authentication and request-body parsing. It only needs to call
 * `await routes.handle({ method, pathname, searchParams, body, loopback })`.
 * A non-matching path returns null. A matching path always returns
 * `{ status, body }`, so the server can use its existing `sendJson` helper.
 *
 * Mounting example:
 *
 *   const bilibiliRoutes = createBilibiliRoutes({
 *     dataDirectory,
 *     accountRegistry: bilibiliAccounts,
 *     contentLibrary,
 *     enabled: process.env.DY_BILIBILI_ENABLED !== "0",
 *   });
 *   const reply = await bilibiliRoutes.handle({
 *     method: request.method,
 *     pathname: url.pathname,
 *     searchParams: url.searchParams,
 *     body,
 *     loopback: isLoopbackAddress(request.socket.remoteAddress),
 *   });
 *   if (reply) sendJson(response, reply.status, reply.body);
 */

export const BILIBILI_ROUTE_PREFIX = "/v1/bilibili";

const routeError = (status, error, message) => ({ status, body: { error, message } });

function inputAccountId(searchParams, body, accountRegistry) {
  const requested = body?.accountId ?? body?.account ?? searchParams?.get?.("account") ?? null;
  const active = accountRegistry?.activeId ?? "default";
  const accountId = String(requested || active);
  if (!isPlatformAccountId(accountId)) throw new BilibiliError("invalid_account", "B 站账号标识无效。", 400);
  return accountId;
}

function accountOf(accountRegistry, accountId) {
  if (!accountRegistry) return null;
  const account = accountRegistry.get?.(accountId);
  if (!account) throw new BilibiliError("account_not_found", "没有这个 B 站账号。", 404);
  if (account.platform && account.platform !== "bilibili") throw new BilibiliError("account_platform_mismatch", "这个账号属于其他平台。", 409);
  return account;
}

function directoryOf(dataDirectory, accountRegistry, accountId) {
  const root = path.resolve(dataDirectory);
  let directory;
  if (accountRegistry?.directory) {
    // PlatformAccountRegistry.directory(account) is required to return the
    // platform root, for example <data>/bilibili or
    // <data>/accounts/<id>/bilibili. The Bilibili service appends only
    // browser-profile and snapshot.json below that root.
    const account = accountRegistry.get?.(accountId) ?? accountId;
    directory = accountRegistry.directory(account);
  } else {
    const platformRoot = path.join(dataDirectory, "bilibili");
    directory = accountId === "default" ? platformRoot : path.join(platformRoot, "accounts", accountId);
  }
  const resolved = path.resolve(directory);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new BilibiliError("invalid_account_directory", "B 站账号目录不在应用数据目录内。", 500);
  return resolved;
}

function callbackRecords(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return {
    favorites: items.filter(item => item.sources?.includes("favorite")),
    history: items.filter(item => item.sources?.includes("history")),
  };
}

export function createBilibiliRoutes({ dataDirectory, accountRegistry = null, contentLibrary = null, enabled = false, openContext = undefined } = {}) {
  if (!dataDirectory) throw new TypeError("dataDirectory is required");

  const resolveDirectory = accountId => directoryOf(dataDirectory, accountRegistry, accountId);
  const pendingLibrary = new Map();
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function retryLibrary(key, task) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await task();
        pendingLibrary.delete(key);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(150 * (attempt + 1));
      }
    }
    pendingLibrary.set(key, task);
    return { pending: true, error: lastError };
  }
  async function retryPendingContent() {
    for (const [key, task] of [...pendingLibrary]) await retryLibrary(key, task);
    return pendingLibrary.size;
  }
  const updateIdentity = async ({ accountId, account, lastSyncedAt, loggedIn }) => {
    if (!accountRegistry?.update) return;
    await accountRegistry.update(accountId, {
      ...(account ? { uid: account.mid, nickname: account.uname, avatar: account.avatar } : {}),
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
      ...(loggedIn !== undefined ? { loggedIn } : { loggedIn: Boolean(account?.isLogin) }),
    }).catch(() => undefined);
  };
  const updateLibrary = async ({ accountId, account, snapshot, directory, reason }) => {
    if (!contentLibrary || !snapshot) return;
    if (reason === "manual") {
      const item = [...(snapshot.items ?? [])].sort((left, right) => String(right.savedAt ?? "").localeCompare(String(left.savedAt ?? "")))[0];
      if (item) {
        const task = () => contentLibrary.manualSave({
          platform: "bilibili", contentId: item.bvid, contentType: "video", title: item.title, author: item.author,
          authorId: item.authorId, url: item.url, coverUrl: item.cover, publishedAt: item.publishedAt,
          accountId, accountName: account?.uname ?? null,
        });
        await retryLibrary(`${accountId}:manual:${item.key}`, task);
      }
      return;
    }
    const task = () => contentLibrary.rebuildFromSnapshots([{
      platform: "bilibili",
      accountId,
      accountName: account?.uname ?? null,
      accountDirectory: path.relative(dataDirectory, directory),
      records: callbackRecords(snapshot),
    }]);
    await retryLibrary(`${accountId}:sync`, task);
  };
  const serviceOptions = {
    dataDirectory,
    resolveAccountDirectory: resolveDirectory,
    ...(openContext ? { openContext } : {}),
    onAccountIdentity: updateIdentity,
    onSnapshot: updateLibrary,
  };
  const service = createBilibili(serviceOptions);

  const isEnabled = context => typeof enabled === "function" ? enabled(context) === true : enabled === true;
  const matches = pathname => pathname === BILIBILI_ROUTE_PREFIX || pathname.startsWith(`${BILIBILI_ROUTE_PREFIX}/`);

  async function handle({ method = "GET", pathname, searchParams = new URLSearchParams(), body = null, loopback = true, signal, accountChanging = false } = {}) {
    if (!matches(pathname)) return null;
    if (loopback === false) return routeError(403, "loopback_only", "B 站账号只能在当前电脑管理。");
    const route = pathname.slice(BILIBILI_ROUTE_PREFIX.length).replace(/\/$/u, "") || "/";
    if (!isEnabled({ method, pathname, route })) return routeError(404, "bilibili_not_released", "这台采集器已关闭 B 站接入。");
    try {
      const accountId = inputAccountId(searchParams, body, accountRegistry);
      const registryAccount = accountOf(accountRegistry, accountId);
      const operation = method === "POST" ? prepareBilibiliProtocol(route, body) : null;
      if (operation) {
        if (accountChanging) return routeError(409, "bilibili_busy", "账号管理操作尚未结束，请稍后重试。");
        const write = route === "/interact";
        if (write && !(body?.accountId ?? body?.account)) return routeError(400, "invalid_request", "互动操作须指定 B 站账号。");
        return { status: 200, body: await service.runProtocol(accountId, operation, { signal, expectedMid: registryAccount?.uid, write }) };
      }
      await retryPendingContent();
      const snapshotStatus = ["/login", "/sync", "/detail"].includes(route) ? await service.status(accountId) : null;
      const expectedMid = registryAccount?.uid ?? snapshotStatus?.account?.mid ?? null;

      if (method === "GET" && route === "/") return { status: 200, body: await service.status(accountId) };
      if (method === "POST" && route === "/login") return { status: 202, body: { job: service.startLogin(accountId, { expectedMid }) } };
      if (method === "POST" && route === "/sync") return { status: 202, body: { job: service.startSync(accountId, { lists: body?.lists, expectedMid }) } };
      if (method === "POST" && route === "/cancel") return { status: 200, body: { ok: service.cancel(body?.jobId, accountId) } };
      if (method === "POST" && route === "/logout") return { status: 200, body: await service.logout(accountId) };
      if (method === "GET" && route === "/folders") {
        const status = await service.status(accountId);
        return { status: 200, body: { account: status.account, folders: status.snapshot?.folders ?? [] } };
      }
      if (method === "GET" && route === "/history") {
        const status = await service.status(accountId);
        return { status: 200, body: { account: status.account, items: (status.snapshot?.items ?? []).filter(item => item.sources?.includes("history")) } };
      }
      if (method === "POST" && route === "/detail") {
        if (typeof body?.bvid !== "string") return routeError(400, "invalid_request", "请输入 BVID。");
        return { status: 200, body: await service.getDetail(accountId, body.bvid, { expectedMid, signal }) };
      }
      if (method === "POST" && route === "/save") {
        if (!body?.item || typeof body.item !== "object") return routeError(400, "invalid_request", "缺少要保存的视频。");
        return { status: 200, body: await service.save(accountId, { ...body.item, accountId }) };
      }
      return routeError(404, "not_found", "没有这个 B 站接口。");
    } catch (error) {
      const invalid = error instanceof SyntaxError || error?.message === "body_too_large";
      return routeError(error?.status ?? (invalid ? 400 : 500), error?.code ?? (invalid ? "invalid_request" : "bilibili_failed"), error?.status ? error.message : invalid ? "请求格式无效。" : "B 站操作失败，请稍后重试。");
    }
  }

  return { service, matches, handle, retryPendingContent, pendingLibrary };
}

