import { randomBytes } from "node:crypto";

import { AssistantError } from "./chat.mjs";

// 对外动作（发私信、点赞、评论、关注、分享）真正发出去之前先问用户：工具挂一张待确认，应用长轮询看到后画卡片，
// 用户点「允许」或「不要」交回来，工具再接着跑。模型自己批准不了：工具参数里没有任何确认字段，
// 只有配过对的页面请求能回答；应用没开着就等到超时，当作没同意。应用内对话和外部 MCP 发起的都排在这一处。
// 点过「允许」，同一范围（应用内是这一轮，外部 AI 是 10 分钟）里同一种操作、同样内容的不再问，换了目标也算
// （把同一个视频分享给几个人只点一次）；最多再放行 MAX_REUSE 次。

export const CONFIRM_TIMEOUT_MS = 15 * 60_000;
const GRANT_MS = 10 * 60_000;
const MAX_REUSE = 9;

const DENIED = "用户没同意，这件事没有做。用户没再提就别再试了。";
const TIMED_OUT = "等了 15 分钟没人点确认，这件事没有做。用户没再提就别再试了。";

/** onChange() 在待确认列表变了时调用（叫醒长轮询）。 */
export function createConfirmDesk({ timeoutMs = CONFIRM_TIMEOUT_MS, now = () => Date.now(), onChange = () => undefined } = {}) {
  const asks = new Map();
  // 范围|操作|内容 → { expiresAt, left }
  const grants = new Map();
  const grantKey = (scope, spec) => `${scope}\u0000${spec.action}\u0000${spec.text ?? ""}`;

  const finish = (id, settle, value) => {
    const ask = asks.get(id);
    if (!ask) return;
    asks.delete(id);
    clearTimeout(ask.timer);
    ask.signal?.removeEventListener("abort", ask.abort);
    onChange();
    settle(value);
  };

  return {
    /**
     * spec：{ action: 给用户看的一句话, target, text?, source: "app" | "mcp" }。scope 是放行的范围（应用内一轮一个），不给就每次都问。
     * 同意时 resolve，不同意/超时/停止/关掉时 reject。
     */
    ask(spec, { signal, scope = null } = {}) {
      if (signal?.aborted) return Promise.reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
      const key = scope ? grantKey(scope, spec) : null;
      const grant = key ? grants.get(key) : null;
      if (grant && grant.expiresAt > now() && grant.left > 0) {
        grant.left -= 1;
        return Promise.resolve();
      }
      const id = randomBytes(8).toString("hex");
      return new Promise((resolve, reject) => {
        const ask = {
          spec: { id, ...spec, ...(key ? { covers: true } : {}), expiresAt: now() + timeoutMs },
          signal,
          timer: setTimeout(() => finish(id, reject, new AssistantError("confirm_timeout", TIMED_OUT, 504)), timeoutMs),
          abort: () => finish(id, reject, Object.assign(new Error("stopped"), { name: "AbortError" })),
          allow: () => {
            if (key) grants.set(key, { expiresAt: now() + GRANT_MS, left: MAX_REUSE });
            finish(id, resolve);
          },
          deny: () => finish(id, reject, new AssistantError("confirm_denied", DENIED, 409)),
          close: () => finish(id, reject, new AssistantError("interrupted", "应用关掉了，这件事没有做。", 503)),
        };
        asks.set(id, ask);
        signal?.addEventListener("abort", ask.abort, { once: true });
        onChange();
      });
    },

    /** 页面交回用户的决定：先答的算数，答过的、已经结束的都当找不到。 */
    answer(id, allow) {
      const ask = asks.get(id);
      if (!ask) throw new AssistantError("confirm_not_found", "这次确认已经结束了。", 404);
      if (allow === true) ask.allow();
      else ask.deny();
    },

    /** 一轮结束：这一轮点过的「允许」作废。 */
    forget(scope) {
      for (const key of [...grants.keys()]) if (key.startsWith(`${scope}\u0000`)) grants.delete(key);
    },

    pending: () => [...asks.values()].map((ask) => ask.spec),

    close() {
      for (const ask of [...asks.values()]) ask.close();
      grants.clear();
    },
  };
}
