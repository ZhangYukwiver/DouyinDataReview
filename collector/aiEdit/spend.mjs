import { randomBytes } from "node:crypto";

import { AiEditError } from "./library.mjs";

// 花钱前先问用户：生成视频这类按条扣费的工具，真正调服务商之前把要花的钱挂到正在跑的这一轮上（session.streaming.spend），
// 页面长轮询看到后画一张确认卡片，用户点「生成」或「不生成」交回来，工具再接着跑。写法照 look.mjs 的 ask，去掉认领和心跳。
// 模型自己批准不了：工具参数里没有任何确认字段，只有配过对的页面请求能回答；没有页面开着就等到超时，当作没同意。
// 技能跑命令前问用户（session.streaming.command）也用这一套，只换掉给模型的话和错误码（texts）。

export const SPEND_TIMEOUT_MS = 15 * 60_000;

/** 给模型的话：不同意、没人点都一分钱没花，别再调，换别的做法。 */
const DENIED = "用户没同意生成，一分钱没花。用户没再提就别再调了，改用图片、网页片段或素材库里现有的素材。";
const TIMED_OUT = "等了 15 分钟没人点确认，这段没有生成，一分钱没花。用户没再提就别再调了，改用图片、网页片段或素材库里现有的素材。";

const SPEND_TEXTS = {
  denied: DENIED,
  timedOut: TIMED_OUT,
  closed: "采集器关掉了，这段没有生成。",
  unavailable: "这一轮已经结束了，没法再问用户。",
  deniedCode: "spend_denied",
  timeoutCode: "spend_timeout",
};

/**
 * holder 和 look.mjs 的一样：{ id, live()?: 这一轮还在吗, get(): 当前挂着的, set(spend): 挂上/摘下（不存盘）, touch(): 叫醒页面 }。
 * ask 回的 Promise：同意 resolve（页面随答复交回的 extra，没有就是 undefined）；不同意 spend_denied、超时 spend_timeout、
 * 停止 AbortError、采集器关掉 interrupted。texts 可以换掉给模型的话和不同意、超时的错误码，没给的照花钱的。
 */
export function createSpendDesk({ timeoutMs = SPEND_TIMEOUT_MS, now = () => Date.now(), texts = {} } = {}) {
  const say = { ...SPEND_TEXTS, ...texts };
  const asks = new Map();

  return {
    /** spec：{ kind, provider, model, seconds, resolution, ratio, audio, prompt, estimate }，原样挂给页面看。 */
    ask(holder, spec, { signal } = {}) {
      if (holder.live && !holder.live()) return Promise.reject(new AiEditError("spend_unavailable", say.unavailable, 409));
      const id = randomBytes(8).toString("hex");
      return new Promise((resolve, reject) => {
        const finish = (settle, value) => {
          const ask = asks.get(id);
          if (!ask) return;
          asks.delete(id);
          clearTimeout(ask.timer);
          signal?.removeEventListener("abort", ask.abort);
          if (holder.get()?.id === id) {
            holder.set(null);
            holder.touch();
          }
          settle(value);
        };
        const ask = {
          holderId: holder.id,
          timer: setTimeout(() => finish(reject, new AiEditError(say.timeoutCode, say.timedOut, 504)), timeoutMs),
          abort: () => finish(reject, Object.assign(new Error("stopped"), { name: "AbortError" })),
          allow: (extra) => finish(resolve, extra),
          deny: () => finish(reject, new AiEditError(say.deniedCode, say.denied, 409)),
          close: () => finish(reject, new AiEditError("interrupted", say.closed, 503)),
        };
        asks.set(id, ask);
        if (signal?.aborted) { ask.abort(); return; }
        signal?.addEventListener("abort", ask.abort, { once: true });
        holder.set({ id, ...spec, expiresAt: now() + timeoutMs });
        holder.touch();
      });
    },

    /** 页面交回用户的决定：先答的算数，答过的、别的会话的、已经结束的都当找不到。extra 是同意时跟着交回的（比如「以后不用问」）。 */
    answer(holderId, askId, allow, extra) {
      const ask = asks.get(askId);
      if (!ask || ask.holderId !== holderId) throw new AiEditError("spend_not_found", "这次确认已经结束了。", 404);
      if (allow === true) ask.allow(extra ?? undefined);
      else ask.deny();
      return true;
    },

    close() {
      for (const ask of [...asks.values()]) ask.close();
    },
  };
}
