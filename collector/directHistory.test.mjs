import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIRECT_FAVORITE_ENDPOINT,
  DIRECT_HISTORY_ENDPOINT,
  DIRECT_LIKED_ENDPOINT,
  DIRECT_SIGNER_COMMIT,
  DirectHistoryError,
  buildUnsignedHistoryUrl,
  captureDirectHistoryTemplate,
  collectDirectRecordPages,
  directSignerProcessConfiguration,
  fetchDirectHistoryPage,
  scrollHiddenListPage,
} from "./directHistory.mjs";

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const template = {
  version: 1,
  signerCommit: DIRECT_SIGNER_COMMIT,
  capturedAt: "2026-08-13T00:00:00.000Z",
  parameterOrder: [
    "count", "max_cursor", "directory", "category", "status",
    "device_platform", "aid", "channel", "webid", "msToken", "verifyFp", "fp", "uifid",
  ],
  values: {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    webid: "1234567890123456789",
  },
  headers: { "user-agent": userAgent, "sec-ch-ua-platform": '"macOS"' },
};

let dataDirectory;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "douyin-direct-history-"));
  await writeFile(path.join(dataDirectory, "direct-history-template.json"), JSON.stringify(template), { mode: 0o600 });
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

const sessionCookies = [
  { domain: ".douyin.com", name: "sessionid", value: "session-secret" },
  { domain: ".douyin.com", name: "msToken", value: "ms-secret" },
  { domain: ".douyin.com", name: "s_v_web_id", value: "verify-secret" },
  { domain: ".douyin.com", name: "UIFID", value: "uifid-secret" },
];

function signedUrl(value) {
  const url = new URL(value);
  url.searchParams.append("a_bogus", "A".repeat(80));
  return url;
}

function fakeContext({ cookies = sessionCookies, payload, status = 200 } = {}) {
  let requestedUrl = DIRECT_HISTORY_ENDPOINT;
  const response = {
    body: vi.fn(async () => Buffer.from(JSON.stringify(payload ?? {
      status_code: 0,
      aweme_list: [{ aweme_id: "history-1", history_info: { view_time: 1_700_000_000 } }],
      has_more: 0,
    }))),
    headers: vi.fn(() => ({ "content-type": "application/json" })),
    status: vi.fn(() => status),
    url: vi.fn(() => requestedUrl),
  };
  const context = {
    cookies: vi.fn(async () => cookies),
  };
  const isolatedRequest = {
    dispose: vi.fn(async () => undefined),
    get: vi.fn(async (url) => {
        requestedUrl = url;
        return response;
    }),
    post: vi.fn(async (url) => {
      requestedUrl = url;
      return response;
    }),
  };
  const requestFactory = {
    newContext: vi.fn(async () => isolatedRequest),
  };
  return { context, isolatedRequest, requestFactory, response };
}

describe("direct signer process", () => {
  const runtimeDirectory = path.join(tmpdir(), "direct signer runtime");
  const runnerPath = path.join(tmpdir(), "direct signer runner.cjs");
  const executablePath = path.join(tmpdir(), "runtime.exe");

  it("uses a hidden permission-limited Node subprocess on Windows", () => {
    const configuration = directSignerProcessConfiguration({
      platform: "win32",
      executablePath,
      runtimeDirectory,
      runnerPath,
    });

    expect(configuration.command).toBe(path.resolve(executablePath));
    expect(configuration.args).toEqual([
      "--permission",
      `--allow-fs-read=${path.resolve(runtimeDirectory)}`,
      `--allow-fs-read=${path.resolve(runnerPath)}`,
      path.resolve(runnerPath),
      path.resolve(runtimeDirectory),
    ]);
    expect(configuration.options).toMatchObject({
      cwd: path.resolve(runtimeDirectory),
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1", LANG: "C", LC_ALL: "C", TZ: "UTC" }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(configuration.options.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("keeps the macOS system sandbox around the same Node permission boundary", () => {
    const configuration = directSignerProcessConfiguration({
      platform: "darwin",
      executablePath: "/usr/local/bin/node",
      runtimeDirectory,
      runnerPath,
    });

    expect(configuration.command).toBe("/usr/bin/sandbox-exec");
    expect(configuration.args.slice(0, 4)).toEqual([
      "-p",
      "(version 1) (allow default) (deny network*) (deny file-write*)",
      "/usr/local/bin/node",
      "--permission",
    ]);
  });

  it("rejects platforms without an implemented process boundary", () => {
    expect(() => directSignerProcessConfiguration({
      platform: "linux",
      executablePath: "/usr/bin/node",
      runtimeDirectory,
      runnerPath,
    })).toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
  });
});

describe("direct history request", () => {
  it("builds and sends one fixed signed GET without exposing a Cookie header", async () => {
    const { context, isolatedRequest, requestFactory } = fakeContext();
    const signer = vi.fn(async (url) => signedUrl(url));

    const payload = await fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer });

    expect(payload.aweme_list[0]?.history_info.view_time).toBe(1_700_000_000);
    expect(signer).toHaveBeenCalledTimes(1);
    const [unsigned, signerOptions] = signer.mock.calls[0];
    expect(unsigned.origin + unsigned.pathname).toBe(DIRECT_HISTORY_ENDPOINT);
    expect(unsigned.searchParams.get("count")).toBe("20");
    expect(unsigned.searchParams.get("max_cursor")).toBe("0");
    expect(unsigned.searchParams.has("a_bogus")).toBe(false);
    expect(signerOptions).toEqual({ directory: undefined, uifid: "uifid-secret", userAgent });

    expect(context.cookies).toHaveBeenCalledWith("https://www.douyin.com/", DIRECT_HISTORY_ENDPOINT);
    expect(requestFactory.newContext).toHaveBeenCalledTimes(1);
    expect(requestFactory.newContext).toHaveBeenCalledWith(expect.objectContaining({
      userAgent,
      storageState: expect.objectContaining({ cookies: sessionCookies }),
    }));
    expect(isolatedRequest.get).toHaveBeenCalledTimes(1);
    expect(isolatedRequest.dispose).toHaveBeenCalledTimes(1);
    const [requestUrl, options] = isolatedRequest.get.mock.calls[0];
    expect(new URL(requestUrl).origin + new URL(requestUrl).pathname).toBe(DIRECT_HISTORY_ENDPOINT);
    expect(options).toMatchObject({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
    expect(Object.keys(options.headers).map((name) => name.toLocaleLowerCase())).not.toContain("cookie");
  });

  it("omits msToken when the browser profile does not store it", async () => {
    const { context, requestFactory } = fakeContext({ cookies: sessionCookies.filter((cookie) => cookie.name !== "msToken") });
    const signer = vi.fn(async (url) => signedUrl(url));

    await expect(fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer }))
      .resolves.toBeTruthy();
    expect(signer.mock.calls[0]?.[0].searchParams.has("msToken")).toBe(false);
    expect(requestFactory.newContext).toHaveBeenCalledTimes(1);
  });

  it("signs the requested pagination cursor", async () => {
    const { context, requestFactory } = fakeContext();
    const signer = vi.fn(async (url) => signedUrl(url));

    await fetchDirectHistoryPage({
      context,
      currentUserAgent: userAgent,
      dataDirectory,
      cursor: "1700000000000",
      requestFactory,
      signer,
    });

    expect(signer.mock.calls[0]?.[0].searchParams.get("max_cursor")).toBe("1700000000000");
  });

  it("asks for the watched-to-the-end list with the history page's own filter, right after count", async () => {
    const { context, requestFactory } = fakeContext();
    const signer = vi.fn(async (url) => signedUrl(url));

    await fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, completedOnly: true, requestFactory, signer });

    const params = signer.mock.calls[0][0].searchParams;
    const names = [...params.keys()];
    expect(names.slice(names.indexOf("count"), names.indexOf("count") + 4)).toEqual(["count", "status", "category", "directory"]);
    // the template carries its own status=-1 filter; sending both would read the whole history as finished
    expect(Object.fromEntries(["status", "category", "directory"].map((name) => [name, params.getAll(name)])))
      .toEqual({ status: ["1"], category: ["0"], directory: ["0"] });
  });

  it("rejects an invalid pagination cursor before signing or sending", async () => {
    const { context, requestFactory } = fakeContext();
    const signer = vi.fn();

    await expect(fetchDirectHistoryPage({
      context,
      currentUserAgent: userAgent,
      dataDirectory,
      cursor: "next-page",
      requestFactory,
      signer,
    })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(signer).not.toHaveBeenCalled();
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });

  it("rejects an incomplete session before signing or sending", async () => {
    const { context, requestFactory } = fakeContext({ cookies: sessionCookies.filter((cookie) => cookie.name !== "UIFID") });
    const signer = vi.fn();

    await expect(fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer }))
      .rejects.toMatchObject({ code: "session_incomplete" });
    expect(signer).not.toHaveBeenCalled();
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });

  it("stops after one 403 without retrying", async () => {
    const { context, isolatedRequest, requestFactory } = fakeContext({ status: 403 });

    await expect(fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer: async (url) => signedUrl(url) }))
      .rejects.toMatchObject({ code: "session_rejected" });
    expect(isolatedRequest.get).toHaveBeenCalledTimes(1);
    expect(isolatedRequest.dispose).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(dataDirectory, "direct-history-template.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports Douyin status 8 as an expired login so the app can reopen the login browser", async () => {
    const { context, requestFactory } = fakeContext({ payload: { status_code: 8, status_msg: "用户未登录" } });

    await expect(fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer: async (url) => signedUrl(url) }))
      .rejects.toMatchObject({ code: "login_required" });
  });

  it("rejects a template captured by another browser before sending", async () => {
    const { context, requestFactory } = fakeContext();

    await expect(fetchDirectHistoryPage({
      context,
      currentUserAgent: userAgent.replace("Chrome/140", "Chrome/141"),
      dataDirectory,
      requestFactory,
      signer: async (url) => signedUrl(url),
    })).rejects.toMatchObject({ code: "template_mismatch" });
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });

  it("keeps a page when records lack history_info.view_time", async () => {
    const { context, requestFactory } = fakeContext({
      payload: {
        status_code: 0,
        aweme_list: [{ aweme_id: "history-1", create_time: 1_700_000_000 }],
        has_more: 0,
      },
    });

    await expect(fetchDirectHistoryPage({ context, currentUserAgent: userAgent, dataDirectory, requestFactory, signer: async (url) => signedUrl(url) }))
      .resolves.toMatchObject({ aweme_list: [{ aweme_id: "history-1" }] });
  });

  it("rejects a signer result that changes the host", async () => {
    const { context, requestFactory } = fakeContext();

    await expect(fetchDirectHistoryPage({
      context,
      currentUserAgent: userAgent,
      dataDirectory,
      requestFactory,
      signer: async () => new URL(`https://evil.example/history?a_bogus=${"A".repeat(80)}`),
    })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });

  it("rejects www-hj as the signed request host", async () => {
    const { context, requestFactory } = fakeContext();

    await expect(fetchDirectHistoryPage({
      context,
      currentUserAgent: userAgent,
      dataDirectory,
      requestFactory,
      signer: async (url) => new URL(url.toString().replace("www.douyin.com", "www-hj.douyin.com")),
    })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(requestFactory.newContext).not.toHaveBeenCalled();
  });
});

describe("direct history URL boundary", () => {
  it("ignores cookies from lookalike domains", () => {
    expect(() => buildUnsignedHistoryUrl(sessionCookies.map((cookie) => ({
      ...cookie,
      domain: "evildouyin.com",
    })), template)).toThrowError(DirectHistoryError);
  });

  it("captures only an ordered non-secret request template", async () => {
    const url = new URL(DIRECT_HISTORY_ENDPOINT);
    const values = {
      max_cursor: "0",
      count: "20",
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      pc_libra_divert: "Mac",
      support_h265: "1",
      support_dash: "1",
      webid: "1234567890123456789",
      msToken: "secret-ms-token",
      verifyFp: "secret-fp",
      fp: "secret-fp",
      uifid: `secret-uifid-${"x".repeat(400)}`,
      a_bogus: "secret-signature",
    };
    for (const [name, value] of Object.entries(values)) url.searchParams.append(name, value);
    const request = {
      url: () => url.toString(),
      headerValue: vi.fn(async (name) => {
        if (name === "sec-ch-ua-platform") throw new Error("header_unavailable");
        return null;
      }),
    };

    await expect(captureDirectHistoryTemplate(dataDirectory, request, userAgent)).resolves.toBe(true);
    const raw = await readFile(path.join(dataDirectory, "direct-history-template.json"), "utf8");
    expect(raw).not.toMatch(/secret-ms-token|secret-fp|secret-uifid|secret-signature/u);
    expect(JSON.parse(raw).parameterOrder).toEqual(Object.keys(values).filter((name) => name !== "a_bogus"));
    expect(JSON.parse(raw).headers).toEqual({ "user-agent": userAgent });
  });

  it("captures a history template from the official www-hj host", async () => {
    const url = new URL(DIRECT_HISTORY_ENDPOINT.replace("www.douyin.com", "www-hj.douyin.com"));
    for (const [name, value] of Object.entries({
      max_cursor: "0",
      count: "20",
      device_platform: "webapp",
      aid: "6383",
      webid: "1234567890123456789",
      verifyFp: "secret-fp",
      fp: "secret-fp",
      uifid: "secret-uifid",
      a_bogus: "secret-signature",
    })) url.searchParams.append(name, value);
    const request = {
      url: () => url.toString(),
      headerValue: vi.fn(async () => null),
    };

    await expect(captureDirectHistoryTemplate(dataDirectory, request, userAgent)).resolves.toBe(true);
  });
});

describe("hidden likes and favorites", () => {
  it("scrolls a visible nested list even when it is narrower than half the viewport", () => {
    const list = {
      clientHeight: 480,
      clientWidth: 520,
      scrollHeight: 1_480,
      scrollTop: 0,
      getBoundingClientRect: () => ({ left: 40, right: 560, top: 120, bottom: 600, width: 520, height: 480 }),
      scrollTo: vi.fn(function scrollTo(_left, top) { this.scrollTop = top; }),
    };
    const root = {
      clientHeight: 900,
      clientWidth: 1_280,
      scrollHeight: 900,
      scrollTop: 0,
      getBoundingClientRect: () => ({ left: 0, right: 1_280, top: 0, bottom: 900, width: 1_280, height: 900 }),
    };
    const scrollTo = vi.fn();
    vi.stubGlobal("innerWidth", 1_280);
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));
    vi.stubGlobal("window", { scrollTo });
    vi.stubGlobal("document", {
      scrollingElement: root,
      documentElement: root,
      querySelectorAll: () => [list],
    });

    try {
      expect(scrollHiddenListPage()).toMatchObject({ candidateCount: 1, movedCount: 1 });
      expect(list.scrollTop).toBe(1_000);
      expect(list.scrollTo).toHaveBeenCalledWith(0, 1_000);
      expect(scrollTo).toHaveBeenCalledWith(0, 900);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 页面里那段请求函数直接在 node 里跑，只把 fetch 换成假的
  function listPage(respond) {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      requests.push({ url: new URL(url), init });
      const { status = 200, payload, text } = await respond(new URL(url), init);
      return { status, text: async () => text ?? JSON.stringify(payload) };
    }));
    return { page: { evaluate: vi.fn(async (callback, argument) => callback(argument)) }, requests };
  }
  const selfPayload = { status_code: 0, user: { uid: "123", sec_uid: "MS4wLjABAAAA-me" } };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads likes page by page inside the page, with the account's sec_uid and the next max_cursor", async () => {
    const { page, requests } = listPage((url) => {
      if (url.pathname.endsWith("/user/profile/self/")) return { payload: selfPayload };
      return url.searchParams.get("max_cursor") === "0"
        ? { payload: { status_code: 0, aweme_list: [{ aweme_id: "liked-1" }], has_more: 1, max_cursor: 1_700_000_000_001 } }
        : { payload: { status_code: 0, aweme_list: [{ aweme_id: "liked-2" }], has_more: 0, max_cursor: 1_700_000_000_000 } };
    });
    const pages = [];

    await expect(collectDirectRecordPages(page, "liked_videos", async (payload, count) => {
      pages.push([count, payload.aweme_list[0].aweme_id]);
    }, { dataDirectory })).resolves.toBe(2);

    expect(pages).toEqual([[1, "liked-1"], [2, "liked-2"]]);
    expect(requests.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
      "https://www.douyin.com/aweme/v1/web/user/profile/self/",
      DIRECT_LIKED_ENDPOINT,
      DIRECT_LIKED_ENDPOINT,
    ]);
    const liked = requests[1].url.searchParams;
    expect([liked.get("sec_user_id"), liked.get("count"), liked.get("webid"), liked.get("aid")]).toEqual(["MS4wLjABAAAA-me", "18", "1234567890123456789", "6383"]);
    expect(requests[2].url.searchParams.get("max_cursor")).toBe("1700000000001");
    // 签名和 msToken 交给页面 SDK，这里一个都不带
    for (const { url, init } of requests) {
      expect(url.searchParams.has("a_bogus") || url.searchParams.has("msToken")).toBe(false);
      expect(init).toEqual({ credentials: "include" });
    }
  });

  it("posts the favorites cursor as a form body and stops where the handler says", async () => {
    const { page, requests } = listPage(() => ({
      payload: { status_code: 0, aweme_list: [{ aweme_id: "favorite-1" }], has_more: 1, cursor: 1_787_844_497_003_727 },
    }));
    const onPage = vi.fn(async (_payload, count) => count < 2);

    await expect(collectDirectRecordPages(page, "favorite_videos", onPage, { dataDirectory })).resolves.toBe(2);

    expect(requests.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([DIRECT_FAVORITE_ENDPOINT, DIRECT_FAVORITE_ENDPOINT]);
    expect(requests.map(({ init }) => init.body)).toEqual(["count=10&cursor=0", "count=10&cursor=1787844497003727"]);
    expect(requests[0].init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    });
  });

  it("stops when the next cursor points back to a page already read", async () => {
    const { page } = listPage(() => ({ payload: { status_code: 0, aweme_list: [], has_more: 1, cursor: "0" } }));
    const onPage = vi.fn();

    await expect(collectDirectRecordPages(page, "favorite_videos", onPage, { dataDirectory }))
      .rejects.toMatchObject({ code: "pagination_stalled" });
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the security gateway blocks the request", "favorite_videos", () => ({ status: 403, text: "Blocked by ArgusSecurityPlugin Signature Not Found" }), { code: "session_rejected", message: expect.stringContaining("安全网关") }],
    ["the login has expired", "favorite_videos", () => ({ payload: { status_code: 8 } }), { code: "login_required" }],
    ["Douyin rate-limits the read", "favorite_videos", () => ({ status: 429, text: "" }), { code: "rate_limited" }],
    ["a page says nothing about more pages", "favorite_videos", () => ({ payload: { status_code: 0, aweme_list: [] } }), { code: "pagination_missing" }],
    ["the account profile lacks a sec_uid", "liked_videos", () => ({ payload: { status_code: 0, user: { uid: "123" } } }), { code: "schema_changed" }],
    ["the network request fails", "liked_videos", () => { throw new TypeError("Failed to fetch"); }, { code: "request_failed" }],
  ])("stops without reading on when %s", async (_case, type, respond, expected) => {
    const { page } = listPage(respond);
    const onPage = vi.fn();

    await expect(collectDirectRecordPages(page, type, onPage, { dataDirectory })).rejects.toMatchObject(expected);
    expect(onPage).not.toHaveBeenCalled();
  });

  it("times out when the page stops answering", async () => {
    vi.useFakeTimers();
    const page = { evaluate: vi.fn(() => new Promise(() => undefined)) };

    try {
      const collection = collectDirectRecordPages(page, "favorite_videos", vi.fn(), { dataDirectory });
      const rejection = expect(collection).rejects.toMatchObject({ code: "page_timeout" });
      // 先读完模板文件、发出请求，超时的计时器才挂上
      await vi.waitFor(() => expect(page.evaluate).toHaveBeenCalled());
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
