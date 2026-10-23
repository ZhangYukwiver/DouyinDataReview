import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { LIBRARY_TEXTS, createLookDesk } from "./aiEdit/look.mjs";
import { AnalysisLibrary, analysisPrompt, apiBaseUrl, networkFailure, parseAnalysisConfig, requestAnalysis, startAnalysis, transientFailure } from "./videoAnalysis.mjs";

const config = { baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "doubao-seed-2-0-mini-260428", direction: "" };

function sse(chunks, status = 200) {
  const body = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
const delta = (content, finish = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

describe("parseAnalysisConfig", () => {
  it("trims, drops the trailing slash and keeps the direction", () => {
    expect(parseAnalysisConfig({ baseUrl: " https://ark.example.com/api/v3/ ", apiKey: " k ", model: "m", direction: "美食探店" }))
      .toEqual({ baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "m", direction: "美食探店", videoInput: null });
  });

  it("fills in the version path for a bare host and drops a pasted /chat/completions", () => {
    expect(apiBaseUrl("https://api.huiliu.one")).toBe("https://api.huiliu.one/v1");
    expect(apiBaseUrl("https://api.huiliu.one/")).toBe("https://api.huiliu.one/v1");
    expect(apiBaseUrl("https://ark.cn-beijing.volces.com")).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(apiBaseUrl("https://relay.example.com/v1/chat/completions")).toBe("https://relay.example.com/v1");
    expect(apiBaseUrl("https://relay.example.com/chat/completions")).toBe("https://relay.example.com");
    expect(apiBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(apiBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
    expect(apiBaseUrl("")).toBe("");
    expect(parseAnalysisConfig({ baseUrl: "https://api.huiliu.one", apiKey: "k", model: "m" }).baseUrl).toBe("https://api.huiliu.one/v1");
  });

  it("explains network failures by their cause, and marks dropped connections for the caller", () => {
    const failure = (message, code) => new TypeError(message, code ? { cause: Object.assign(new Error(code), { code }) } : undefined);
    expect(networkFailure(new TypeError("x is not a function"))).toBeNull();
    expect(networkFailure(new Error("fetch failed"))).toBeNull();
    expect(networkFailure(failure("fetch failed", "ECONNREFUSED"))).toEqual({ text: "接口地址拒绝连接（ECONNREFUSED），检查一下地址和端口。" });
    expect(networkFailure(failure("fetch failed", "UNABLE_TO_VERIFY_LEAF_SIGNATURE")).text).toContain("证书");
    expect(networkFailure(failure("fetch failed", "UND_ERR_CONNECT_TIMEOUT")).text).toContain("连接接口超时");
    expect(networkFailure(failure("terminated", "UND_ERR_SOCKET"), 5_000)).toEqual({ text: "接口连接中途断开了（UND_ERR_SOCKET）。", retry: true, dropped: true });
    expect(networkFailure(failure("terminated", "ECONNABORTED"), 95_000).text).toBe("等了 95 秒后，接口连接中途断开了（ECONNABORTED）。");
    // 还没收到回答就断：可以悄悄重发，但不是「中途断开」
    expect(networkFailure(failure("fetch failed", "ECONNRESET"))).toEqual({ text: "连接还没建立好就被断开了（ECONNRESET），检查一下网络、代理和地址。", retry: true });
    expect(networkFailure(failure("fetch failed", "UND_ERR_HEADERS_TIMEOUT"), 300_000).text).toBe("接口 300 秒都没开始回答，这边先断开了（UND_ERR_HEADERS_TIMEOUT）。");
    expect(networkFailure(failure("terminated", "UND_ERR_BODY_TIMEOUT"), 420_000).text).toBe("接口太久没有新内容，这边先断开了（UND_ERR_BODY_TIMEOUT）。");
    expect(networkFailure(failure("fetch failed")).text).toBe("连不上接口地址（fetch failed），检查一下网络和地址。");
  });

  it("reports a 200 reply that carries an error, and a body cut off mid-read as a dropped connection", async () => {
    const config = { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" };
    const refused = async () => new Response(JSON.stringify({ error: { message: "当前分组下模型 m 无可用渠道", code: "model_not_found" } }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(requestAnalysis({ config, video: {}, videoBase64: "AA==", fetchImpl: refused })).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("无可用渠道") });
    const cut = async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => { throw new TypeError("terminated", { cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }) }); } });
    await expect(requestAnalysis({ config, video: {}, videoBase64: "AA==", fetchImpl: cut })).rejects.toMatchObject({ code: "provider_unreachable", dropped: true });
  });

  it("resends when the relay reports a passing upstream failure, but not errors that will not go away", async () => {
    const upstream = { error: { message: "Upstream HTTP/2 stream failed", type: "upstream_error" } };
    const noChannel = { error: { message: "分组 default 下模型 m 无可用渠道", code: "model_not_found" } };
    expect(transientFailure(0, JSON.stringify(upstream))).toBe(true);
    expect(transientFailure(502, "")).toBe(true);
    expect(transientFailure(529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).toBe(true);
    expect(transientFailure(0, JSON.stringify({ error: { code: 502, message: "Provider disconnected unexpectedly" } }))).toBe(true);
    expect(transientFailure(500, JSON.stringify({ error: { code: "InternalServiceError", message: "The service encountered an unexpected internal error. Please retry later." } }))).toBe(true);
    expect(transientFailure(500, JSON.stringify({ error: { message: "invalid image format" } }))).toBe(false);
    expect(transientFailure(503, JSON.stringify(noChannel))).toBe(false);
    expect(transientFailure(0, JSON.stringify({ error: { message: "content violates our usage policy" } }))).toBe(false);
    expect(transientFailure(400, "timeout")).toBe(false);
    expect(transientFailure(429, "try again later")).toBe(false);
    const config = { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" };
    let calls = 0;
    // 远端中转站在回答流里回过这句：重发一次就拿到了
    const flaky = async () => { calls += 1; return calls === 1 ? sse([upstream]) : sse([delta("拆解", "stop")]); };
    await expect(requestAnalysis({ config, video: {}, videoBase64: "AA==", fetchImpl: flaky })).resolves.toBe("拆解");
    expect(calls).toBe(2);
    calls = 0;
    const broken = async () => { calls += 1; return sse([upstream]); };
    await expect(requestAnalysis({ config, video: {}, videoBase64: "AA==", fetchImpl: broken }))
      .rejects.toMatchObject({ code: "provider_error", message: "接口报错：Upstream HTTP/2 stream failed，自动重发了 2 次还是这样。" });
    expect(calls).toBe(3);
    calls = 0;
    const gone = async () => { calls += 1; return new Response(JSON.stringify(noChannel), { status: 503 }); };
    await expect(requestAnalysis({ config, video: {}, videoBase64: "AA==", fetchImpl: gone })).rejects.toMatchObject({ message: expect.stringContaining("中转站里没有能用的这个模型") });
    expect(calls).toBe(1);
  });

  it("tells the library to re-analyze after a dropped connection, without the chat's advice", async () => {
    const drop = () => { throw new TypeError("terminated", { cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }) }); };
    let calls = 0;
    const error = await requestAnalysis({ config: { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" }, video: {}, videoBase64: "AA==", fetchImpl: async () => { calls += 1; drop(); } }).catch((failure) => failure);
    expect(calls).toBe(3);
    expect(error).toMatchObject({ code: "provider_unreachable", dropped: true, message: "接口连接中途断开了（UND_ERR_SOCKET），自动重发了 2 次还是断开。" });
    // 写到一半被掐断（远端中转站 21 秒、47 秒都断过）：自己重发，从头拿完整的回答
    calls = 0;
    const cutOnce = async () => {
      calls += 1;
      if (calls > 1) return sse([delta("完整的拆解", "stop")]);
      let sent = false;
      const body = new ReadableStream({ pull(controller) { if (sent) return controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })); sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta("写到一半"))}\n\n`)); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await expect(requestAnalysis({ config: { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" }, video: {}, videoBase64: "AA==", fetchImpl: cutOnce })).resolves.toBe("完整的拆解");
    expect(calls).toBe(2);
    // 歇着准备重发时正好到了超时：报超时，不冒充用户停止
    await expect(requestAnalysis({ config: { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" }, video: {}, videoBase64: "AA==", signal: AbortSignal.timeout(100), fetchImpl: async () => drop() })).rejects.toMatchObject({ name: "TimeoutError" });
    // 等太久这边自己断开的（5 分钟没开始回答）不重发
    calls = 0;
    const slow = async () => { calls += 1; throw new TypeError("fetch failed", { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }); };
    await expect(requestAnalysis({ config: { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" }, video: {}, videoBase64: "AA==", fetchImpl: slow })).rejects.toMatchObject({ code: "provider_unreachable" });
    expect(calls).toBe(1);
  });

  it("rejects non-http addresses and missing keys", () => {
    expect(() => parseAnalysisConfig({ baseUrl: "file:///etc", apiKey: "k", model: "m" })).toThrow("https://");
    expect(() => parseAnalysisConfig({ baseUrl: "https://a.com", apiKey: "", model: "m" })).toThrow("Key");
  });
});

describe("analysisPrompt", () => {
  it("appends what the page told us and marks the rest unknown", () => {
    const text = analysisPrompt({ title: "三分钟学会", author: "阿明", durationSeconds: 61, tags: ["教程"], stats: { diggCount: 12, playCount: 0 } }, "");
    expect(text).toContain("请从创作者角度拆解我提供的视频");
    expect(text).toContain("标题：三分钟学会");
    expect(text).toContain("时长：61 秒");
    expect(text).toContain("词条：#教程");
    expect(text).toContain("发布时间：未知");
    expect(text).toContain("点赞 12");
    expect(text).not.toContain("播放 0");
    expect(text).toContain("我的创作方向：没有填写");
    expect(text).toContain("固定 10 行");
    expect(text).toContain("标准 Markdown 表格");
  });
});

describe("requestAnalysis", () => {
  it("streams the answer and sends the video as a data URL", async () => {
    let sent = null;
    const fetchImpl = async (url, init) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return sse([delta("① 概括"), delta("\n② 表格", "stop"), "[DONE]"]);
    };
    const text = await requestAnalysis({ config, video: { title: "t" }, videoBase64: "AAAA", fetchImpl });
    expect(text).toBe("① 概括\n② 表格");
    expect(sent.url).toBe("https://ark.example.com/api/v3/chat/completions");
    expect(sent.auth).toBe("Bearer k");
    expect(sent.body.stream).toBe(true);
    expect(sent.body.max_tokens).toBeGreaterThan(4096);
    expect(sent.body.messages[0].content[0]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } });
  });

  it("notes a cut-off answer", async () => {
    const text = await requestAnalysis({ config, video: null, videoBase64: "A", fetchImpl: async () => sse([delta("半截", "length")]) });
    expect(text).toContain("没写完");
  });

  it("explains provider errors with the provider's own message", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { code: "AuthenticationError", message: "the API key is invalid" } }), { status: 401 });
    await expect(requestAnalysis({ config, video: null, videoBase64: "A", fetchImpl })).rejects.toThrow("Key 不对或没有权限：the API key is invalid");
  });

  it("accepts a plain JSON reply from providers that ignore streaming", async () => {
    const fetchImpl = async () => Response.json({ choices: [{ message: { content: "整段" }, finish_reason: "stop" }] });
    expect(await requestAnalysis({ config, video: null, videoBase64: "A", fetchImpl })).toBe("整段");
  });
});

function fakeCollector({ file, status = "complete", error = null }) {
  const jobs = new Map();
  return {
    startVideoDownload(url, options) {
      const job = { id: `job-${jobs.size}`, url, options, polls: 0 };
      jobs.set(job.id, job);
      return { id: job.id, status: "queued" };
    },
    getVideoDownloadJob(id) {
      const job = jobs.get(id);
      job.polls += 1;
      return job.polls < 2 ? { id, status: "running" } : { id, status, error, video: { title: "下好了", author: "阿明" } };
    },
    getVideoDownloadFilePath: () => file,
    jobs,
  };
}

async function settle(library, id) {
  for (let i = 0; i < 100 && library.list().find((item) => item.id === id)?.status === "running"; i += 1) await delay(5);
  await library.saving;
  return library.list().find((item) => item.id === id);
}

describe("startAnalysis", () => {
  it("downloads the smallest copy, asks the model and saves the answer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "analysis-"));
    const video = path.join(dir, "v.mp4");
    await writeFile(video, "fake-mp4");
    const library = new AnalysisLibrary(path.join(dir, "analyses.json"));
    const collector = fakeCollector({ file: video });
    let sentVideo = null;
    const fetchImpl = async (_url, init) => {
      sentVideo = JSON.parse(init.body).messages[0].content[0].video_url.url;
      return sse([delta("拆解结果", "stop")]);
    };
    const entry = startAnalysis({ library, collector, url: "https://www.douyin.com/video/7562882230080818489", config, fetchImpl, pollMs: 1 });
    expect(entry.status).toBe("running");
    expect([...collector.jobs.values()][0].options).toEqual({ smallest: true });
    const done = await settle(library, entry.id);
    expect(done).toMatchObject({ status: "complete", markdown: "拆解结果", video: { title: "下好了" }, model: config.model });
    expect(sentVideo).toBe(`data:video/mp4;base64,${Buffer.from("fake-mp4").toString("base64")}`);
    expect(JSON.parse(await readFile(path.join(dir, "analyses.json"), "utf8"))[0].markdown).toBe("拆解结果");

    // 同一链接再解析覆盖原来那条，失败时留着上一次的结果
    const again = startAnalysis({ library, collector: fakeCollector({ file: video, status: "failed", error: "抖音要求完成安全验证" }), url: entry.sourceUrl, config, fetchImpl, pollMs: 1 });
    expect(again.id).toBe(entry.id);
    expect(await settle(library, entry.id)).toMatchObject({ status: "failed", error: "抖音要求完成安全验证", markdown: "拆解结果" });
    expect(library.list()).toHaveLength(1);
  });

  it("has the analysis page cut the video into screenshots and beats when the model cannot watch video", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "analysis-"));
    const video = path.join(dir, "v.mp4");
    await writeFile(video, "fake-mp4");
    const library = new AnalysisLibrary(path.join(dir, "analyses.json"));
    const url = "https://www.douyin.com/video/7562882230080818489";
    const looks = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS, timeoutMs: 2_000 });
    const sent = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      if (body.messages[0].content.some((part) => part.type === "video_url")) {
        return new Response(JSON.stringify({ error: { message: "unknown variant `video_url`, expected `text` or `image_url`" } }), { status: 400 });
      }
      return sse([delta("① 截图拆解", "stop")]);
    };
    const pageAnswers = async (id) => {
      let look = null;
      for (let i = 0; i < 200 && !(look = library.list().find((item) => item.id === id)?.look); i += 1) await delay(5);
      return look;
    };
    const answer = { duration: 8, audio: true, flashes: [], shots: [{ start: 0, end: 4, frame: "data:image/jpeg;base64,AAAA" }, { start: 4, end: 8, frame: null }], beats: { bpm: 120, beats: [0.5, 1, 1.5, 2], strong: [] } };

    // 没测过：先整段发，被拒后挂给解析库页面
    const entry = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: null }, looks, fetchImpl, pollMs: 1 });
    const look = await pageAnswers(entry.id);
    expect(look).toMatchObject({ kind: "reference", url: expect.stringMatching(/^\/v1\/analyses\/look\/[0-9a-f]{32}\/file$/u) });
    expect(library.list()[0].stage).toBe("looking");
    await library.save();
    expect(JSON.parse(await readFile(library.file, "utf8"))[0].look).toBeUndefined();
    looks.answer(entry.id, look.id, answer);
    const done = await settle(library, entry.id);
    expect(done).toMatchObject({ status: "complete", stage: null });
    expect(done.markdown).toMatch(/^> 这个模型看不了视频[\s\S]*① 截图拆解$/u);
    expect(done.look).toBeUndefined();
    expect(sent[0].messages[0].content.at(-1).text).toContain("只回答一行：NO_VIDEO");
    const parts = sent[1].messages[0].content;
    expect(parts.filter((part) => part.type === "image_url")).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "low" } }]);
    expect([sent[0].reasoning_effort, sent[1].reasoning_effort]).toEqual([undefined, "low"]);
    expect(parts[0].text).toContain("音乐约 120 BPM");
    expect(parts.at(-1).text).toContain("只回答一行：NO_IMAGES");

    // 配置时已测出看不了：不再先发整段视频
    sent.length = 0;
    const direct = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks, fetchImpl, pollMs: 1 });
    looks.answer(direct.id, (await pageAnswers(direct.id)).id, answer);
    expect(await settle(library, direct.id)).toMatchObject({ status: "complete" });
    expect(sent).toHaveLength(1);

    // 不认 reasoning_effort 的接口（各家说法不一，有的回 422）：去掉再发
    const refusals = [
      [400, "Unrecognized request argument supplied: reasoning_effort"],
      [400, "\"gemma3:12b\" does not support thinking"],
      [422, "Extra inputs are not permitted"],
    ];
    for (const [status, message] of refusals) {
      sent.length = 0;
      const picky = async (_url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body);
        if (body.reasoning_effort) return new Response(JSON.stringify({ error: { message } }), { status });
        return sse([delta("③ 不带推理参数", "stop")]);
      };
      const retried = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks, fetchImpl: picky, pollMs: 1 });
      looks.answer(retried.id, (await pageAnswers(retried.id)).id, answer);
      expect(await settle(library, retried.id)).toMatchObject({ status: "complete", markdown: expect.stringContaining("③ 不带推理参数") });
      expect(sent.map((body) => body.reasoning_effort)).toEqual(["low", undefined]);
    }
    // 真是别的错：重发一次照样失败，报第二次的原话；限流之类不重发
    sent.length = 0;
    const refusing = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { message: `image too large (${sent.length})` } }), { status: 400 });
    };
    const refused = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks, fetchImpl: refusing, pollMs: 1 });
    looks.answer(refused.id, (await pageAnswers(refused.id)).id, answer);
    expect(await settle(library, refused.id)).toMatchObject({ status: "failed", error: expect.stringContaining("image too large (2)") });
    expect(sent.map((body) => body.reasoning_effort)).toEqual(["low", undefined]);
    sent.length = 0;
    const limited = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    };
    const throttled = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks, fetchImpl: limited, pollMs: 1 });
    looks.answer(throttled.id, (await pageAnswers(throttled.id)).id, answer);
    expect(await settle(library, throttled.id)).toMatchObject({ status: "failed", error: expect.stringContaining("限流") });
    expect(sent).toHaveLength(1);

    // 拆的时候采集器关了：提示和下载、分析阶段被打断时一样
    const closing = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS });
    const cut = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks: closing, fetchImpl, pollMs: 1 });
    await pageAnswers(cut.id);
    closing.close();
    expect(await settle(library, cut.id)).toMatchObject({ status: "failed", error: "上次解析到一半采集器关掉了，请重新解析。" });

    // 应用页面没开着
    const lonely = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS, timeoutMs: 30 });
    const missed = startAnalysis({ library, collector: fakeCollector({ file: video }), url, config: { ...config, videoInput: false }, looks: lonely, fetchImpl, pollMs: 1 });
    expect(await settle(library, missed.id)).toMatchObject({ status: "failed", error: expect.stringContaining("打开应用，再点「重新解析」") });
  });

  it("has the page squeeze a video too big for one request, and squeezes again by half when the provider still says 413", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "analysis-"));
    const video = path.join(dir, "v.mp4");
    await writeFile(video, Buffer.alloc(46 * 1024 * 1024));
    const library = new AnalysisLibrary(path.join(dir, "analyses.json"));
    const looks = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS, timeoutMs: 2_000 });
    const mp4 = (size) => Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(size - 12)]);
    const sent = [];
    const fetchImpl = async (_url, init) => {
      const url = JSON.parse(init.body).messages[0].content[0].video_url.url;
      sent.push(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").length);
      return sent.length === 1 ? new Response("Exceeded limit on max bytes to request body : 67108864", { status: 413 }) : sse([delta("压缩后拆解", "stop")]);
    };
    const asked = [];
    const entry = startAnalysis({ library, collector: fakeCollector({ file: video }), url: "https://www.douyin.com/video/7562882230080818489", config, looks, fetchImpl, pollMs: 1 });
    for (const size of [1_000, 400]) {
      let look = null;
      for (let i = 0; i < 400 && !((look = library.list()[0].look)?.kind === "squeeze" && !asked.includes(look.id)); i += 1) await delay(5);
      expect(library.list()[0].stage).toBe("squeezing");
      asked.push(look.id);
      looks.answer(entry.id, look.id, { duration: 130, audio: true, video: mp4(size).toString("base64") });
      expect(look.bytes).toBe(asked.length === 1 ? 45 * 1024 * 1024 : 500);
    }
    expect(await settle(library, entry.id)).toMatchObject({ status: "complete", markdown: "压缩后拆解" });
    expect(sent).toEqual([1_000, 400]);
  });

  it("with a local CLI skips the whole video, has the page cut screenshots and asks the CLI once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "analysis-"));
    const video = path.join(dir, "v.mp4");
    await writeFile(video, "fake-mp4");
    const library = new AnalysisLibrary(path.join(dir, "analyses.json"));
    const looks = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS, timeoutMs: 2_000 });
    const asked = [];
    let reply = async () => "① 本机拆解";
    const localAi = { ask: async (id, options) => { asked.push({ id, ...options }); return reply(); } };
    const fetchImpl = async () => { throw new Error("本机运行时不该请求接口"); };
    const local = parseAnalysisConfig({ runtime: "codex", model: "", direction: "美食探店", apiKey: "old", baseUrl: "https://x" });
    expect(local).toEqual({ runtime: "codex", model: "", videoInput: false, direction: "美食探店" });
    const answer = { duration: 8, audio: false, flashes: [], shots: [{ start: 0, end: 8, frame: "data:image/jpeg;base64,AAAA" }] };
    const run = async () => {
      const entry = startAnalysis({ library, collector: fakeCollector({ file: video }), url: "https://www.douyin.com/video/7562882230080818489", config: local, looks, localAi, fetchImpl, pollMs: 1 });
      let look = null;
      for (let i = 0; i < 200 && !(look = library.list().find((item) => item.id === entry.id)?.look); i += 1) await delay(5);
      looks.answer(entry.id, look.id, answer);
      return settle(library, entry.id);
    };
    const done = await run();
    expect(done).toMatchObject({ status: "complete", model: "Codex（默认模型）" });
    expect(done.markdown).toMatch(/^> 这个模型看不了视频[\s\S]*① 本机拆解$/u);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ id: "codex", model: "" });
    expect(asked[0].parts.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(asked[0].prompt).toContain("我的创作方向：美食探店");
    expect(asked[0].prompt).toContain("只回答一行：NO_IMAGES");

    const { LocalAiError } = await import("./localAi.mjs");
    reply = async () => { throw new LocalAiError("local_rate_limit", "Codex 这段时间的用量到上限了，等额度恢复了再试。"); };
    expect(await run()).toMatchObject({ status: "failed", error: "Codex 这段时间的用量到上限了，等额度恢复了再试。" });
    reply = async () => { throw new LocalAiError("local_closed", "采集器关掉了。", 503); };
    expect(await run()).toMatchObject({ status: "failed", error: "上次解析到一半采集器关掉了，请重新解析。" });
    reply = async () => "  ";
    expect(await run()).toMatchObject({ status: "failed", error: "Codex 这次什么都没回，稍后再试。" });
    await expect(requestAnalysis({ config: local, video: null, videoBase64: "AAAA", localAi })).rejects.toMatchObject({ code: "video_unsupported" });
  });

  it("refuses image posts and marks interrupted runs failed on load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "analysis-"));
    const library = new AnalysisLibrary(path.join(dir, "analyses.json"));
    const entry = startAnalysis({ library, collector: fakeCollector({ file: path.join(dir, "album.zip") }), url: "https://www.douyin.com/note/7562882230080818489", config, fetchImpl: async () => { throw new Error("不该调用"); }, pollMs: 1 });
    expect(await settle(library, entry.id)).toMatchObject({ status: "failed", error: expect.stringContaining("图文") });

    await writeFile(library.file, JSON.stringify([{ id: "a", status: "running" }]));
    const reopened = new AnalysisLibrary(library.file);
    await reopened.load();
    expect(reopened.list()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("重新解析") });
  });

  it("rejects links that are not Douyin pages", () => {
    const library = new AnalysisLibrary("/nonexistent/analyses.json");
    expect(() => startAnalysis({ library, collector: fakeCollector({}), url: "https://example.com/a.mp4", config })).toThrow();
  });
});
