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
});

describe("hidden likes and favorites", () => {
  it("accepts a successful list response after an initial access rejection", async () => {
    let onResponse;
    const response = (status, payload) => ({
      body: vi.fn(async () => Buffer.from(JSON.stringify(payload))),
      finished: vi.fn(async () => null),
      headers: vi.fn(() => ({})),
      status: vi.fn(() => status),
      url: vi.fn(() => DIRECT_FAVORITE_ENDPOINT),
    });
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => false),
      goto: vi.fn(async () => {
        onResponse(response(403, {}));
        onResponse(response(200, {
          status_code: 0,
          aweme_list: [{ aweme_id: "favorite-1" }],
          has_more: 0,
        }));
        await Promise.resolve();
      }),
      on: vi.fn((event, callback) => { if (event === "response") onResponse = callback; }),
    };
    const onPage = vi.fn(async () => true);

    await expect(collectDirectRecordPages(
      { newPage: vi.fn(async () => page) },
      "favorite_videos",
      onPage,
    )).resolves.toBe(1);

    expect(onPage).toHaveBeenCalledWith(expect.objectContaining({
      aweme_list: [{ aweme_id: "favorite-1" }],
    }), 1);
  });

  it("stops hidden pagination when the page handler reaches a known record", async () => {
    let onResponse;
    const response = (payload, url = DIRECT_LIKED_ENDPOINT) => ({
      body: vi.fn(async () => Buffer.from(JSON.stringify(payload))),
      finished: vi.fn(async () => null),
      headers: vi.fn(() => ({})),
      status: vi.fn(() => 200),
      url: vi.fn(() => url),
    });
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
      goto: vi.fn(async () => {
        onResponse(response({
          status_code: 0,
          aweme_list: [{ aweme_id: "liked-1" }],
          has_more: 1,
          max_cursor: "1700000000000",
        }));
        await Promise.resolve();
        onResponse(response(
          { status_code: 0, aweme_list: [], has_more: 0 },
          DIRECT_LIKED_ENDPOINT.replace("www-hj.douyin.com", "www.douyin.com"),
        ));
        await Promise.resolve();
      }),
      on: vi.fn((event, callback) => { if (event === "response") onResponse = callback; }),
    };
    const context = { newPage: vi.fn(async () => page) };
    const pages = [];

    await expect(collectDirectRecordPages(context, "liked_videos", async (payload) => {
      pages.push(payload);
      return false;
    })).resolves.toBe(1);

    expect(page.goto).toHaveBeenCalledWith("https://www.douyin.com/user/self?showTab=like", expect.any(Object));
    expect(pages.map((payload) => payload.aweme_list.length)).toEqual([1]);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { delayMs: 0, timing: "prefetched", shouldContinue: false, behavior: "ignores" },
    { delayMs: 1_000, timing: "late", shouldContinue: false, behavior: "ignores" },
    { delayMs: 0, timing: "required", shouldContinue: true, behavior: "propagates" },
  ])("$behavior $timing body failures at the incremental boundary", async ({ delayMs, shouldContinue }) => {
    vi.useFakeTimers();
    let onResponse;
    const response = (body) => ({
      body,
      finished: vi.fn(async () => null),
      headers: vi.fn(() => ({})),
      status: vi.fn(() => 200),
      url: vi.fn(() => DIRECT_LIKED_ENDPOINT),
    });
    const bodyError = new Error("response.body: Protocol error (Network.getResponseBody): No resource with given identifier found");
    const failedResponse = response(vi.fn(async () => { throw bodyError; }));
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
      goto: vi.fn(async () => {
        onResponse(response(vi.fn(async () => Buffer.from(JSON.stringify({
          status_code: 0,
          aweme_list: [{ aweme_id: "known-liked-video" }],
          has_more: 1,
          max_cursor: "1700000000000",
        })))));
        if (delayMs === 0) onResponse(failedResponse);
        else setTimeout(() => onResponse(failedResponse), delayMs);
      }),
      on: vi.fn((event, callback) => { if (event === "response") onResponse = callback; }),
    };
    const onPage = vi.fn(async () => shouldContinue);

    try {
      const outcome = collectDirectRecordPages(
        { newPage: vi.fn(async () => page) },
        "liked_videos",
        onPage,
      ).then((value) => ({ value }), (error) => ({ error }));

      await vi.runAllTimersAsync();

      expect(onPage).toHaveBeenCalledTimes(1);
      expect(page.close).toHaveBeenCalledTimes(1);
      await expect(outcome).resolves.toEqual(shouldContinue ? { error: bodyError } : { value: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when a moving likes page does not advance pagination", async () => {
    vi.useFakeTimers();
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => true),
      goto: vi.fn(async () => undefined),
      on: vi.fn(),
    };

    try {
      const collection = collectDirectRecordPages(
        { newPage: vi.fn(async () => page) },
        "liked_videos",
        vi.fn(),
      );
      const rejection = expect(collection).rejects.toMatchObject({ code: "pagination_missing" });

      await vi.runAllTimersAsync();
      await rejection;

      expect(page.evaluate).toHaveBeenCalledTimes(20);
      expect(page.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when a likes response never finishes", async () => {
    vi.useFakeTimers();
    let onResponse;
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
      goto: vi.fn(async () => {
        onResponse({
          body: vi.fn(async () => Buffer.from("")),
          finished: vi.fn(async () => new Promise(() => undefined)),
          headers: vi.fn(() => ({})),
          status: vi.fn(() => 200),
          url: vi.fn(() => DIRECT_LIKED_ENDPOINT),
        });
      }),
      on: vi.fn((event, callback) => { if (event === "response") onResponse = callback; }),
    };

    try {
      const collection = collectDirectRecordPages(
        { newPage: vi.fn(async () => page) },
        "liked_videos",
        vi.fn(),
      );
      const rejection = expect(collection).rejects.toMatchObject({ code: "response_timeout" });

      await vi.runAllTimersAsync();
      await rejection;

      expect(page.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when the list page stops answering script evaluations", async () => {
    vi.useFakeTimers();
    const page = {
      close: vi.fn(() => new Promise(() => undefined)),
      evaluate: vi.fn(() => new Promise(() => undefined)),
      goto: vi.fn(async () => undefined),
      on: vi.fn(),
    };

    try {
      const collection = collectDirectRecordPages(
        { newPage: vi.fn(async () => page) },
        "liked_videos",
        vi.fn(),
      );
      const rejection = expect(collection).rejects.toMatchObject({ code: "page_timeout" });

      await vi.runAllTimersAsync();
      await rejection;

      expect(page.evaluate).toHaveBeenCalledTimes(1);
      expect(page.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the favorites collection route without requiring a visible browser", async () => {
    let onResponse;
    const page = {
      close: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
      goto: vi.fn(async () => {
        onResponse({
          body: vi.fn(async () => Buffer.from('{"status_code":0,"aweme_list":[],"has_more":0}')),
          finished: vi.fn(async () => null),
          headers: vi.fn(() => ({})),
          status: vi.fn(() => 200),
          url: vi.fn(() => DIRECT_FAVORITE_ENDPOINT),
        });
        await Promise.resolve();
      }),
      on: vi.fn((event, callback) => { if (event === "response") onResponse = callback; }),
    };

    await collectDirectRecordPages({ newPage: vi.fn(async () => page) }, "favorite_videos", vi.fn());

    expect(page.goto.mock.calls[0][0]).toContain("showTab=favorite_collection");
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});
