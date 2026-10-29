import type { PersonalVideoRecord } from "../domain/personalRecords";
import { closeExplore, interactExplore, reactExplore, readExplore, type ExploreConnection, type ExploreOutcome, type ExplorePage } from "./explorer";
import { LocalCollectorError } from "./localCollector";

export function buildVideoFeed(records: PersonalVideoRecord[], initial: PersonalVideoRecord): PersonalVideoRecord[] {
  const videos = records.filter((item) => item.url && item.mediaType !== "live");
  return videos.some((item) => item.id === initial.id) ? videos : [initial, ...videos];
}

/** Bound the wheel lock even when trackpad momentum never becomes fully idle. */
export function createVideoWheelGesture() {
  let last = -Infinity, switched = -Infinity, delta = 0, consumed = false;
  return (amount: number, now: number): number => {
    if (now - last > 180 || (consumed && (now - switched >= 650 ||
      (Math.sign(amount) !== Math.sign(delta) && Math.abs(amount) >= 8 && now - switched >= 220)))) {
      delta = 0; consumed = false;
    }
    last = now;
    if (consumed) return 0;
    delta += amount;
    if (Math.abs(delta) < 65) return 0;
    consumed = true;
    switched = now;
    return Math.sign(delta);
  };
}

/** A previous media/comment request can still be finishing in the shared collector. */
export async function waitForCollector<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (true) {
    signal.throwIfAborted();
    try { return await operation(); } catch (error) {
      if (!(error instanceof LocalCollectorError) || error.code !== "collector_busy" || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

const videoIdOf = (record: PersonalVideoRecord) => record.videoId || /\/(?:video|note)\/(\d+)/u.exec(record.url ?? "")?.[1];

/** Own only this player's comment tab; never close search/profile sessions. */
export function createVideoCommentsSession(connection: ExploreConnection, record: PersonalVideoRecord) {
  const id = videoIdOf(record);
  let sessionId: string | undefined;
  let disposed = false;
  let pending: Promise<ExplorePage> | null = null;
  const controller = new AbortController();
  const release = () => {
    if (!sessionId) return;
    const current = sessionId;
    sessionId = undefined;
    void closeExplore(connection, [current]).catch(() => {});
  };
  const read = (): Promise<ExplorePage> => {
    if (disposed) return Promise.reject(new DOMException("评论已关闭", "AbortError"));
    if (!id) return Promise.reject(new Error("这条记录缺少作品 ID，请在抖音原页查看评论。"));
    if (pending) return pending;
    pending = waitForCollector(async () => {
      let result: ExplorePage;
      try { result = await readExplore(connection, { kind: "comments", id, sessionId }); }
      catch (error) {
        if (!(error instanceof LocalCollectorError) || error.code !== "session_expired") throw error;
        sessionId = undefined;
        controller.signal.throwIfAborted();
        result = await readExplore(connection, { kind: "comments", id });
      }
      sessionId = result.sessionId;
      // Keep the bounded request alive on close so even a late-created tab is released.
      if (disposed) { release(); controller.signal.throwIfAborted(); }
      return result;
    }, controller.signal).finally(() => { pending = null; if (disposed) release(); });
    return pending;
  };
  return {
    read: () => read(),
    /** Posts through the same tab the comments were read from, so a reply target is on that page. */
    async comment(text: string, replyTo?: string): Promise<ExploreOutcome> {
      await pending?.catch(() => {});
      if (disposed) throw new DOMException("评论已关闭", "AbortError");
      const current = sessionId;
      if (!current) throw new Error("评论还没加载好，请稍后再发。");
      const requestId = crypto.randomUUID();
      return waitForCollector(() => interactExplore(connection, { sessionId: current, requestId, action: "comment", text, ...(replyTo ? { replyTo } : {}) }), controller.signal);
    },
    close() { disposed = true; controller.abort(); if (!pending) release(); },
  };
}

/** 播放器里的点赞 / 收藏：只发一个请求、带上想要的状态（点两次也不会重复）；没开「允许在抖音上操作」时采集器拦下并说明，抖音拒了就抛错让界面退回 */
export async function reactVideo(connection: ExploreConnection, record: PersonalVideoRecord, action: "like" | "collect", desired: boolean, signal: AbortSignal): Promise<ExploreOutcome> {
  const id = videoIdOf(record);
  if (!id) throw new Error("这条记录缺少作品 ID，请在抖音原页操作。");
  const outcome = await waitForCollector(() => reactExplore(connection, { awemeId: id, action, desired }), signal);
  if (outcome.outcome === "rejected") throw new Error(outcome.message);
  return outcome;
}

/** The "分享给朋友" list lives in its own tab of the video page, released when the panel closes. */
export function createVideoShareSession(connection: ExploreConnection, record: PersonalVideoRecord) {
  const id = videoIdOf(record);
  let sessionId: string | undefined;
  let closed = false;
  const controller = new AbortController();
  return {
    async read(): Promise<ExplorePage> {
      if (!id) throw new Error("这条记录缺少作品 ID，请在抖音原页分享。");
      const page = await waitForCollector(() => readExplore(connection, { kind: "sharees", id }), controller.signal);
      // A result that lands after close still owns a tab; release it rather than keep it.
      if (closed) { void closeExplore(connection, [page.sessionId]).catch(() => {}); throw new DOMException("分享已关闭", "AbortError"); }
      sessionId = page.sessionId;
      return page;
    },
    share(targetId: string): Promise<ExploreOutcome> {
      const current = sessionId;
      if (!current) return Promise.reject(new Error("朋友列表还没准备好，请稍后再试。"));
      const requestId = crypto.randomUUID();
      return waitForCollector(() => interactExplore(connection, { sessionId: current, requestId, action: "share", targetId }), controller.signal);
    },
    close() {
      closed = true; controller.abort();
      if (sessionId) void closeExplore(connection, [sessionId]).catch(() => {});
      sessionId = undefined;
    },
  };
}
