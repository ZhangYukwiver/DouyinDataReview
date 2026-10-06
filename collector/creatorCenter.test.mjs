import { describe, expect, it, vi } from "vitest";
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
