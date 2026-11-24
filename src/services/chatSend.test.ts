import { afterEach, describe, expect, it, vi } from "vitest";
import { sendChatMessage } from "./chatSend";
import { LocalCollectorError } from "./localCollector";

afterEach(() => {
  vi.unstubAllGlobals();
});

const connection = { baseUrl: "http://127.0.0.1:4765", token: "test-token" };

describe("sendChatMessage", () => {
  it("sends the selected accountId in both the request query and JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: "confirmed", message: "已发送" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await sendChatMessage(connection, "7091970798369407526", "你好", "acc-a");
    expect(outcome).toEqual({ outcome: "confirmed", message: "已发送" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4765/v1/chat/send?account=acc-a");
    expect(JSON.parse(String(init.body))).toMatchObject({
      conversationId: "7091970798369407526",
      text: "你好",
      accountId: "acc-a",
    });
  });

  it("omits account scoping when no accountId is supplied and surfaces account_changed rejections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "account_changed",
      message: "采集器已经换到另一个账号了，这条消息没有发出去。",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendChatMessage(connection, "7091970798369407526", "你好")).rejects.toMatchObject({
      name: "LocalCollectorError",
      code: "account_changed",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4765/v1/chat/send");
    expect(JSON.parse(String(init.body)).accountId).toBeUndefined();
    expect(new LocalCollectorError("account_changed", "test").code).toBe("account_changed");
  });
});
