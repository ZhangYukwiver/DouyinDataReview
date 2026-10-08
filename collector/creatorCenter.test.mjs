import { describe, expect, it, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import { CreatorCenter, creatorRequest, parseCreatorJson } from "./creatorCenter.mjs";

describe("creatorRequest", () => {
  it("builds a whitelisted GET query", () => {
    const request = creatorRequest("item_portrait", { item_id: "7690508847588330798" });
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://creator.douyin.com/janus/douyin/creator/data/fans/item/portrait");
    expect(url.searchParams.get("item_id")).toBe("7690508847588330798");
    expect(url.searchParams.get("aid")).toBe("2906");
  });

  it("sends POST queries as JSON with numbers kept numeric", () => {
    const request = creatorRequest("dashboard", { recent_days: 30 });
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({ recent_days: 30 });
  });

  it("rejects unknown endpoints, unknown params and odd values", () => {
    expect(creatorRequest("publish", {})).toBeNull();
    expect(creatorRequest("toString", {})).toBeNull();
    expect(creatorRequest("item_portrait", { aweme_id: "1" })).toBeNull();
    expect(creatorRequest("item_portrait", { item_id: "1&x=2" })).toBeNull();
    expect(creatorRequest("item_portrait", [])).toBeNull();
  });
});

describe("creatorRequest for 抖音指数", () => {
  const window = { keyword: "咖啡", start_date: "20260906", end_date: "20261006" };

  it("shapes the single keyword into the body the official page sends, dates kept as strings", () => {
    const trend = creatorRequest("index_hot_trend", window);
    expect(trend.method).toBe("POST");
    expect(new URL(trend.url).pathname).toBe("/api/v2/index/get_multi_keyword_hot_trend");
    expect(JSON.parse(trend.body)).toEqual({ keyword_list: ["咖啡"], start_date: "20260906", end_date: "20261006", app_name: "aweme", region: [] });
    expect(JSON.parse(creatorRequest("index_relation_word", window).body)).toEqual({ param: { keyword: "咖啡", start_date: "20260906", end_date: "20261006", app_name: "aweme" } });
    expect(JSON.parse(creatorRequest("index_portrait", { ...window, app_name: "toutiao" }).body).param).toMatchObject({ keyword: "咖啡", app_name: "toutiao" });
    expect(JSON.parse(creatorRequest("index_keyword_valid", { keyword: "C++ & 咖啡" }).body)).toEqual({ keyword_list: ["C++ & 咖啡"] });
    expect(creatorRequest("index_valid_date", {})).toMatchObject({ method: "GET", body: null });
  });

  it("rejects missing, blank, over-long or malformed inputs", () => {
    expect(creatorRequest("index_hot_trend", { keyword: "咖啡" })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, keyword: "  " })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, keyword: "字".repeat(51) })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, keyword: "a\nb" })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, start_date: "2026-09-06" })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, end_date: 20261006 })).not.toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, app_name: "kuaishou" })).toBeNull();
    expect(creatorRequest("index_hot_trend", { ...window, region: "北京" })).toBeNull();
    // 订阅、个人信息这类接口没有入口
    expect(creatorRequest("index_get_user_sub_word", {})).toBeNull();
  });
});

describe("parseCreatorJson", () => {
  it("keeps long ids exact and leaves strings untouched", () => {
    const parsed = parseCreatorJson('{"id":7693381400807935267,"ids":[7693381400807935267,-7693381400807935267],"n":12,"f":0.5e3,"s":"a:7693381400807935267,","t":"\\"9999999999999999999"}');
    expect(parsed).toEqual({ id: "7693381400807935267", ids: ["7693381400807935267", "-7693381400807935267"], n: 12, f: 500, s: "a:7693381400807935267,", t: "\"9999999999999999999" });
  });

  it("returns null for empty or broken bodies", () => {
    expect(parseCreatorJson("")).toBeNull();
    expect(parseCreatorJson("<html>")).toBeNull();
  });
});

describe("CreatorCenter", () => {
  const collectorWith = (results, overrides = {}) => {
    const page = {
      closed: false,
      isClosed() { return this.closed; },
      context() { return context; },
      goto: vi.fn(async () => {}),
      on: vi.fn(),
      close: vi.fn(async function close() { page.closed = true; }),
      evaluate: vi.fn(async () => results),
    };
    const context = { newPage: vi.fn(async () => page) };
    const collector = {
      context,
      visibleBrowserWorkRunning: () => false,
      ensureBrowser: vi.fn(async () => context),
      hasLoginSession: vi.fn(async () => true),
      releaseHeadlessContextIfIdle: vi.fn(async () => {}),
      ...overrides,
    };
    return { collector, page };
  };

  it("reads a batch in one blank page and reuses it", async () => {
    const { collector, page } = collectorWith([{ status: 200, text: '{"status_code":0,"total":1}' }, { status: 500, text: "" }]);
    const center = new CreatorCenter(collector);
    const results = await center.read([{ key: "user_info" }, { key: "dashboard", params: { recent_days: 7 } }]);
    expect(results).toEqual([{ ok: true, data: { status_code: 0, total: 1 } }, { ok: false, status: 500 }]);
    await center.read([{ key: "user_info" }]);
    expect(collector.context.newPage).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith("https://creator.douyin.com/robots.txt", expect.anything());
    expect(center.active).toBe(true);
    await center.close();
    expect(center.active).toBe(false);
    expect(collector.releaseHeadlessContextIfIdle).toHaveBeenCalled();
  });

  it("decrypts index responses, and flags (not hides) ones it cannot decrypt", async () => {
    const CURRENT = ["SjXbYTJb7zXoUToSicUL3A==", "OekMLjghRg8vlX/PemLc+Q=="];
    const cipher = createCipheriv("aes-128-cbc", Buffer.from(CURRENT[0], "base64"), Buffer.from(CURRENT[1], "base64"));
    const secret = Buffer.concat([cipher.update('{"keyword_latest_day":"20261006","BaseResp":{"StatusCode":0}}', "utf8"), cipher.final()]).toString("base64");
    const { collector } = collectorWith([
      { status: 200, text: JSON.stringify({ data: secret, msg: "", status: 0 }), encrypted: "2" },
      { status: 200, text: JSON.stringify({ data: "AAAAAAAAAAAAAAAAAAAAAA==", msg: "", status: 0 }), encrypted: "2" },
      { status: 422, text: '{"msg":"ValidateError","status":422}', encrypted: null },
    ]);
    const results = await new CreatorCenter(collector).read([{ key: "index_valid_date" }, { key: "index_valid_date" }, { key: "index_valid_date" }]);
    expect(results).toEqual([
      { ok: true, data: { keyword_latest_day: "20261006", BaseResp: { StatusCode: 0 } } },
      { ok: false, status: 200, reason: "undecryptable" },
      { ok: false, status: 422 },
    ]);
  });

  it("still schedules an idle close when opening the page fails, so the browser it launched gets released", async () => {
    vi.useFakeTimers();
    try {
      const { collector } = collectorWith([], { hasLoginSession: vi.fn(async () => false) });
      const center = new CreatorCenter(collector);
      await expect(center.read([{ key: "user_info" }])).rejects.toMatchObject({ code: "login_required" });
      expect(collector.releaseHeadlessContextIfIdle).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(collector.releaseHeadlessContextIfIdle).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("reports login and busy states and rejects bad batches before opening a page", async () => {
    const { collector } = collectorWith([{ status: 200, text: '{"status_code":8}' }]);
    await expect(new CreatorCenter(collector).read([{ key: "user_info" }])).rejects.toMatchObject({ code: "login_required" });
    await expect(new CreatorCenter(collector).read([{ key: "publish" }])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(new CreatorCenter(collector).read([])).rejects.toMatchObject({ code: "invalid_request" });
    const busy = collectorWith([], { context: null, visibleBrowserWorkRunning: () => true }).collector;
    await expect(new CreatorCenter(busy).read([{ key: "user_info" }])).rejects.toMatchObject({ code: "collector_busy" });
    expect(busy.ensureBrowser).not.toHaveBeenCalled();
  });
});
