import { useEffect, useState } from "react";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import { closeExplore, readExplore, type ExploreConnection, type ExplorePage } from "./explorer";
import { videoIdOf, waitForCollector } from "./videoFeed";

export function isExpiredCover(url: string | null | undefined): boolean {
  if (!url) return true;
  try {
    const expires = new URL(url).searchParams.get("x-expires");
    return expires !== null && Number.isFinite(Number(expires)) && Number(expires) * 1000 <= Date.now() + 60_000;
  } catch { return true; }
}

type CoverRequest = { promise: Promise<string | null>; controller: AbortController; users: Set<AbortSignal>; until: number };
const covers = new Map<string, CoverRequest>();
let pending = Promise.resolve();
const coverKey = (connection: ExploreConnection | null | undefined, owner: string | null | undefined, record: PersonalVideoRecord) =>
  JSON.stringify([connection?.baseUrl, connection?.token, owner, videoIdOf(record), record.coverUrl]);

/** 只读作品详情；同一作品合并请求，封面读取串行，避免挤满探索接口。 */
export function loadRecordCover(connection: ExploreConnection, owner: string | null | undefined, record: PersonalVideoRecord, signal: AbortSignal): Promise<string | null> {
  const id = videoIdOf(record);
  if (signal.aborted || record.mediaType === "live" || !id || !/^\d{5,30}$/u.test(id)) return Promise.resolve(null);
  const key = coverKey(connection, owner, record);
  let request = covers.get(key);
  if (!request || request.until <= Date.now() || request.controller.signal.aborted) {
    const entry: CoverRequest = { promise: Promise.resolve(null), controller: new AbortController(), users: new Set(), until: Infinity };
    entry.promise = pending.then(async () => {
      let page: ExplorePage | undefined;
      try {
        entry.controller.signal.throwIfAborted();
        page = await waitForCollector(() => readExplore(connection, { kind: "detail", id }, entry.controller.signal), entry.controller.signal);
        const video = page.video;
        const url = video?.videoId === id ? video.coverUrl : null;
        return url && !isExpiredCover(url) ? url : null;
      } finally {
        if (page) await closeExplore(connection, [page.sessionId]).catch(() => {});
      }
    }).catch(() => null);
    pending = entry.promise.then(() => {});
    void entry.promise.then((url) => {
      const expires = url ? new URL(url).searchParams.get("x-expires") : null;
      const expiry = expires !== null && Number.isFinite(Number(expires)) ? Number(expires) * 1000 - 60_000 : Infinity;
      entry.until = Math.min(Date.now() + (url ? 60 * 60_000 : 30_000), expiry);
    });
    // 只缓存最近浏览的封面；完整内容库仍以原始记录为准。
    if (covers.size >= 256) covers.delete(covers.keys().next().value!);
    covers.set(key, entry);
    request = entry;
  }
  const entry = request;
  entry.users.add(signal);
  const abort = () => {
    entry.users.delete(signal);
    if (!entry.users.size) {
      entry.controller.abort();
      if (covers.get(key) === entry) covers.delete(key);
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  return entry.promise.finally(() => {
    signal.removeEventListener("abort", abort);
    entry.users.delete(signal);
  });
}

/** 过期或加载失败时补取一次；换记录、账号或封面地址后重新判断。 */
export function useRecordCover(record: PersonalVideoRecord, connection: ExploreConnection | null | undefined, owner: string | null | undefined, active: boolean) {
  const baseUrl = connection?.baseUrl, token = connection?.token;
  const key = coverKey(connection, owner, record);
  const [replacement, setReplacement] = useState<{ key: string; url: string | null } | null>(null);
  const [failed, setFailed] = useState<{ key: string; url: string } | null>(null);
  const url = replacement?.key === key ? replacement.url : record.coverUrl ?? null;
  const unavailable = isExpiredCover(url) || (failed?.key === key && failed.url === url);
  useEffect(() => {
    if (!active || !baseUrl || !token || !unavailable || replacement?.key === key || record.mediaType === "live") return;
    const controller = new AbortController();
    void loadRecordCover({ baseUrl, token }, owner, record, controller.signal).then((fresh) => {
      if (!controller.signal.aborted) setReplacement({ key, url: fresh });
    });
    return () => controller.abort();
  }, [active, baseUrl, token, owner, key, unavailable, replacement?.key, record.mediaType]);
  return {
    coverUrl: active && !unavailable ? url : null,
    onError: () => { if (url) setFailed({ key, url }); },
  };
}
