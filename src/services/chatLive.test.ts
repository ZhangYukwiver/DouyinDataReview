import { describe, expect, it, vi } from "vitest";
import { extendLiveHistory, type LivePage } from "./chatLive";
import type { ChatMessage } from "../domain/chatRecords";

const DAY = 86_400_000;
const now = Date.parse("2026-11-14T12:00:00Z");
const message = (id: number): ChatMessage => ({ id: String(id), conversationId: "g", conversationType: "group", conversationName: null,
  senderId: "a", senderName: null, sentAt: new Date(now - id * DAY).toISOString(), type: "text", text: null, mediaUrl: null, share: null, callDurationSeconds: null });

// 每页 10 条、一天一条，共 100 天
function pages() {
  return vi.fn(async (before: string | null): Promise<LivePage> => {
    const start = before ? Number(before) : 0;
    const messages = Array.from({ length: 10 }, (_, index) => message(start + index));
    const more = start + 10 < 100;
    return { messages, hasMore: more, cursor: more ? String(start + 10) : null };
  });
}

describe("extendLiveHistory", () => {
  it("pages back until the range start, then continues from where it stopped", async () => {
    const load = pages();
    const month = await extendLiveHistory(load, null, now - 25 * DAY);
    expect(load).toHaveBeenCalledTimes(3);
    expect(month.messages[0]?.id).toBe("29");
    expect(month.messages.at(-1)?.id).toBe("0");
    const all = await extendLiveHistory(load, month, 0);
    expect(load.mock.calls.slice(3).map(([before]) => before)).toEqual(["30", "40", "50", "60", "70", "80", "90"]);
    expect(all).toMatchObject({ complete: true, cursor: null });
    expect(all.messages).toHaveLength(100);
    // 已经覆盖的短范围不再请求
    await extendLiveHistory(load, all, now - 7 * DAY);
    expect(load).toHaveBeenCalledTimes(10);
  });
  it("stops when cancelled", async () => {
    const stop = new AbortController();
    const load = pages();
    await expect(extendLiveHistory(load, null, 0, { signal: stop.signal, onPage: () => stop.abort() })).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
