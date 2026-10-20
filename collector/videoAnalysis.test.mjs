import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AnalysisLibrary, analysisPrompt, apiBaseUrl, networkFailure, parseAnalysisConfig, requestAnalysis, startAnalysis } from "./videoAnalysis.mjs";

const config = { baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "doubao-seed-2-0-mini-260428", direction: "" };

function sse(chunks, status = 200) {
  const body = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
const delta = (content, finish = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

describe("parseAnalysisConfig", () => {
  it("trims, drops the trailing slash and keeps the direction", () => {
    expect(parseAnalysisConfig({ baseUrl: " https://ark.example.com/api/v3/ ", apiKey: " k ", model: "m", direction: "美食探店" }))
      .toEqual({ baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "m", direction: "美食探店" });
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

  it("tells the library to re-analyze after a dropped connection, without the chat's advice", async () => {
    const drop = () => { throw new TypeError("terminated", { cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }) }); };
    let calls = 0;
    const error = await requestAnalysis({ config: { baseUrl: "https://a.com/v1", apiKey: "k", model: "m" }, video: {}, videoBase64: "AA==", fetchImpl: async () => { calls += 1; drop(); } }).catch((failure) => failure);
    expect(calls).toBe(2);
    expect(error).toMatchObject({ code: "provider_unreachable", dropped: true, message: "接口连接中途断开了（UND_ERR_SOCKET）。" });
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
