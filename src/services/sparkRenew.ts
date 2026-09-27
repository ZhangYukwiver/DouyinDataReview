import type { PersonalVideoRecord } from "../domain/personalRecords";
import { CHAT_SEND_UNCONFIRMED, sendChatMessage, type ChatSendConnection } from "./chatSend";
import { LocalCollectorError } from "./localCollector";
import { createVideoShareSession, waitForCollector } from "./videoFeed";

/** 一句话和表情都是文字消息（表情就是 [续火花吧] 这样的代码）；视频走抖音自己的「分享给朋友」。 */
export type SparkPayload = { kind: "text"; text: string } | { kind: "video"; record: PersonalVideoRecord };
export type SparkSendState = "waiting" | "sending" | "sent" | "failed" | "unknown" | "skipped";
export interface SparkSendUpdate { state: SparkSendState; message?: string }

// ponytail: 固定上限防误选一大批，火花真超过这个数再放开
export const MAX_SPARK_BATCH = 50;
// 和具体好友无关的问题：剩下的也会同样失败，或者不该再发，直接停下
const STOP_CODES = new Set([CHAT_SEND_UNCONFIRMED, "not_receiving", "not_connected", "verification_required", "login_required", "not_paired", "explore_unreachable"]);
const STOPPED = "已停下，这位没发。";

/** 分享名单里的 ID：私信会话 0:1:<一方>:<另一方> 取不是自己的那段（名单里有你自己，采集器那边也会排除）；群聊就是会话 ID 本身。 */
export const shareTargetIds = (conversationId: string, selfId: string | null) =>
  (/^0:1:(\d+):(\d+)$/u.exec(conversationId)?.slice(1) ?? (/^\d{5,30}$/u.test(conversationId) ? [conversationId] : [])).filter((id) => id !== selfId);

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

// 一次只发一位，中间隔几秒，像手动一条条发；发出去以后绝不重试，结果不明就标待确认。
export async function renewSparks(connection: ChatSendConnection, conversationIds: readonly string[], payload: SparkPayload, { signal, onUpdate, selfId = null, gapMs = () => 2_000 + Math.random() * 2_500 }: {
  signal: AbortSignal; onUpdate: (conversationId: string, update: SparkSendUpdate) => void; selfId?: string | null; gapMs?: () => number;
}): Promise<void> {
  const queue = conversationIds.slice(0, MAX_SPARK_BATCH);
  const share = payload.kind === "video" ? createVideoShareSession(connection, payload.record) : null;
  try {
    let listed: Set<string> | null = null;
    if (share) {
      try { listed = new Set((await share.read()).items.map((item) => item.id)); } catch (error) {
        const message = error instanceof Error ? error.message : "没能打开这个视频的分享名单。";
        for (const id of queue) onUpdate(id, { state: "failed", message });
        return;
      }
    }
    // 连着两位都没发出去多半是被限制了（发太频繁、要验证），再发只会更糟
    let stopped = false, failures = 0, sentBefore = false;
    for (const id of queue) {
      if (stopped || signal.aborted) { onUpdate(id, { state: "skipped", message: STOPPED }); continue; }
      const peer = listed ? shareTargetIds(id, selfId).find((candidate) => listed!.has(candidate)) : null;
      // 名单只有抖音分享面板最上面、不用往下翻就看得到的那几位：往下翻会让抖音给沿路的人都建会话
      if (listed && !peer) { onUpdate(id, { state: "skipped", message: "TA 不在抖音分享面板最上面那几位里，视频没发；发一句话或表情不受影响。" }); continue; }
      if (sentBefore) await pause(gapMs(), signal);
      if (signal.aborted) { onUpdate(id, { state: "skipped", message: STOPPED }); continue; }
      sentBefore = true;
      onUpdate(id, { state: "sending" });
      let state: SparkSendState;
      try {
        const outcome = share ? await share.share(peer!) : await waitForCollector(() => sendChatMessage(connection, id, payload.kind === "text" ? payload.text : ""), signal);
        state = outcome.outcome === "confirmed" ? "sent" : outcome.outcome === "rejected" ? "failed" : "unknown";
        onUpdate(id, { state, message: outcome.message });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") { onUpdate(id, { state: "skipped", message: STOPPED }); stopped = true; continue; }
        const code = error instanceof LocalCollectorError ? error.code : "";
        state = code === CHAT_SEND_UNCONFIRMED ? "unknown" : "failed";
        onUpdate(id, { state, message: error instanceof Error ? error.message : "没发出去，请稍后再试。" });
        if (STOP_CODES.has(code)) stopped = true;
      }
      failures = state === "failed" ? failures + 1 : 0;
      if (failures >= 2) stopped = true;
    }
  } finally { share?.close(); }
}

export interface SparkRenewRun { ids: string[]; progress: Record<string, SparkSendUpdate>; running: boolean }

// 一轮续火花在看板外面跑：关掉看板、点开别的会话、切到别的页面都接着发，
// 只有点「停下」或关掉整个页面才停（正在发的那一个照样发完）。同一时间只跑一轮。
let current: SparkRenewRun | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const publish = (next: SparkRenewRun | null) => { current = next; for (const listener of listeners) listener(); };

export const sparkRenewJob = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => current,
  start(connection: ChatSendConnection, ids: readonly string[], payload: SparkPayload, selfId: string | null) {
    if (current?.running || !ids.length) return;
    const run = new AbortController();
    controller = run;
    publish({ ids: [...ids], progress: Object.fromEntries(ids.map((id) => [id, { state: "waiting" }])), running: true });
    void renewSparks(connection, ids, payload, {
      signal: run.signal, selfId,
      onUpdate: (id, update) => { if (current) publish({ ...current, progress: { ...current.progress, [id]: update } }); },
    }).finally(() => {
      if (controller === run) controller = null;
      if (current) publish({ ...current, running: false });
    });
  },
  stop() { controller?.abort(); },
  /** 发完以后把这一轮的结果收起来；还在发就不动。 */
  dismiss() { if (!current?.running) publish(null); },
};
