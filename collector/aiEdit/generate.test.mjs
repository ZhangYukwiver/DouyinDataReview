import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { backgroundNote, estimateVideoCost, parseGenerateConfig } from "./generate.mjs";
import { AiEditError, MediaLibrary } from "./library.mjs";
import { createToolRunner } from "./tools.mjs";

// 生成图片和视频：素材库用真目录（adopt 要把临时文件挪进去），接口全是假的，按地址分路，一个真请求都不发。

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-edit/media");
const IMAGE_KEY = "sk-test-image-secret-0123456789";
const VIDEO_KEY = "ark-test-video-secret-0123456789";
const IMAGE = { baseUrl: "https://api.openai.com/v1", apiKey: IMAGE_KEY, model: "gpt-image-2.5-flare" };
const VIDEO = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: VIDEO_KEY, model: "doubao-seedance-2-0-260128" };
const TASKS = `${VIDEO.baseUrl}/contents/generations/tasks`;

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const kindOf = (name) => {
  const extension = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image";
  if ([".mp4", ".mov"].includes(extension)) return "video";
  throw new Error("unsupported");
};
const probe = async (filePath) => (kindOf(filePath) === "image"
  ? { kind: "image", duration_us: 86_400_000_000, width: 1024, height: 1536, audio: false, video: true }
  : { kind: "video", duration_us: 5_041_667, width: 720, height: 1280, audio: false, video: true });

async function library() {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-edit-generate-"));
  directories.push(directory);
  const media = new MediaLibrary({ directory: path.join(directory, "media"), probe, kindOf, pollMs: 5 });
  await media.load();
  return media;
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const errorBody = (code, message, type) => ({ error: { code, message, ...(type ? { type } : {}) } });

/** 按地址分路的假接口：routes 里每项 [判断, 回应]，回应可以是函数；记下每次请求。 */
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const route = routes.find(([match]) => match(call));
    if (!route) throw new Error(`没想到会请求 ${call.method} ${call.url}`);
    const reply = typeof route[1] === "function" ? await route[1](call) : route[1];
    return reply.clone();
  };
  return { calls, fetchImpl };
}

async function setup({ routes = [], canvas = { width: 1080, height: 1920, fps: 30 }, ...overrides } = {}) {
  const media = await library();
  const api = fakeApi(routes);
  const ctx = {
    store: { getProject: async () => ({ canvas }) }, library: media, projectId: "p".repeat(32),
    generation: { image: IMAGE, video: VIDEO }, generated: { images: 0 }, fetchImpl: api.fetchImpl, pollMs: 1,
    ...overrides,
  };
  return { media, ...api, ctx, run: createToolRunner(ctx) };
}

const png = () => readFile(path.join(FIXTURES, "still.png"));
const mp4 = () => readFile(path.join(FIXTURES, "clip-720p.mp4"));
const generations = (call) => call.url === `${IMAGE.baseUrl}/images/generations`;
const edits = (call) => call.url === `${IMAGE.baseUrl}/images/edits`;
const generatedFiles = async (media) => (await readdir(media.root)).filter((name) => !name.startsWith("index.json"));
/** 等后台做完：素材库里有了东西（最多 5 秒）。 */
async function settled(media) {
  const deadline = Date.now() + 5_000;
  while (!media.list().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return media.list();
}

describe("parseGenerateConfig", () => {
  it("keeps only the providers with a key and cleans up pasted addresses", () => {
    for (const raw of [undefined, null, "x", [], {}, { image: { apiKey: "  " } }, { image: [], video: "k" }]) expect(parseGenerateConfig(raw)).toBeNull();
    expect(parseGenerateConfig({ image: { apiKey: " k " } })).toEqual({ image: { baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-image-2.5-flare" } });
    expect(parseGenerateConfig({ video: { apiKey: "k", baseUrl: "", model: "" } })).toEqual({ video: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k", model: "doubao-seedance-2-0-260128" } });
    const pasted = parseGenerateConfig({
      image: { apiKey: "k", baseUrl: "https://relay.example.com/v1/images/generations/", model: "gpt-image-2" },
      video: { apiKey: "k", baseUrl: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" },
    });
    expect(pasted.image).toMatchObject({ baseUrl: "https://relay.example.com/v1", model: "gpt-image-2" });
    expect(pasted.video.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(parseGenerateConfig({ image: { apiKey: "k", baseUrl: "https://relay.example.com/v1/images/edits" } }).image.baseUrl).toBe("https://relay.example.com/v1");
    // 只填域名：补上版本路径（方舟 /api/v3，其余 /v1）
    expect(parseGenerateConfig({ image: { apiKey: "k", baseUrl: "https://api.openai.com" } }).image.baseUrl).toBe("https://api.openai.com/v1");
    expect(parseGenerateConfig({ video: { apiKey: "k", baseUrl: "https://ark.cn-beijing.volces.com/" } }).video.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(() => parseGenerateConfig({ image: { apiKey: "k", baseUrl: "ftp://x" } })).toThrow(expect.objectContaining({ code: "invalid_config" }));
    const long = parseGenerateConfig({ image: { apiKey: "k".repeat(600), model: "m".repeat(200) } }).image;
    expect([long.apiKey.length, long.model.length]).toEqual([500, 100]);
  });
});

describe("estimateVideoCost", () => {
  it("prices by model prefix and resolution, longer prefixes first", () => {
    expect(estimateVideoCost("doubao-seedance-2-0-260128", 5, "720p")).toBe(4.97);
    expect(estimateVideoCost("doubao-seedance-2-0-260128", 5, "1080p")).toBe(12.39);
    expect(estimateVideoCost("doubao-seedance-2-0-fast-260128", 5, "720p")).toBe(4);
    expect(estimateVideoCost("doubao-seedance-2-0-mini-260615", 10, "480p")).toBe(2.24);
    expect(estimateVideoCost("doubao-seedance-2-5-260628", 10, "1080p")).toBe(37.42);
    expect(estimateVideoCost("doubao-seedance-2-5-260628", 4, "720p")).toBe(6.05);
    expect(estimateVideoCost("doubao-seedance-2-0-fast-260128", 5, "1080p")).toBeNull();
    expect(estimateVideoCost("my-relay-video-model", 5, "720p")).toBeNull();
  });
});

describe("generate_image", () => {
  it("sends one request, saves the returned picture into the library and reuses it for the same prompt", async () => {
    const bytes = await png();
    const { run, calls, media, ctx } = await setup({ routes: [[generations, json({ data: [{ b64_json: bytes.toString("base64") }] })]] });
    const { result, action } = await run("generate_image", { prompt: "  海边日落，远处有帆船，水彩风格  " });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${IMAGE_KEY}`, "Content-Type": "application/json" } });
    // 竖屏画布挑 9:16，gpt-image-2 起用自定义尺寸
    expect(JSON.parse(calls[0].body)).toEqual({ model: "gpt-image-2.5-flare", prompt: "海边日落，远处有帆船，水彩风格", size: "864x1536", quality: "medium", output_format: "png", n: 1 });
    expect(result).toMatchObject({ ok: true, media: { kind: "image", status: "ready", from: "AI 生成", name: "海边日落，远处有帆船，水彩风格" }, note: expect.stringContaining("add_media_clip") });
    expect(action).toEqual({ name: "generate_image", summary: "生成了图片「海边日落，远处有帆船，水彩风格」", ok: true });
    const item = media.get(result.media.media_id);
    expect(item.source).toEqual({ type: "generated", provider: "openai", model: "gpt-image-2.5-flare", prompt: "海边日落，远处有帆船，水彩风格", key: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(await readFile(media.readyPath(item.id))).toEqual(bytes);
    expect(path.extname(item.file)).toBe(".png");
    expect(ctx.generated.images).toBe(1);

    // 同样的说明：直接回那一张，不再发请求、不算数
    const again = await run("generate_image", { prompt: "海边日落，远处有帆船，水彩风格", name: "别的名字" });
    expect(again.result).toMatchObject({ ok: true, reused: true, media: { media_id: item.id }, note: expect.stringContaining("之前用同样的说明生成过") });
    expect(calls).toHaveLength(1);
    expect(ctx.generated.images).toBe(1);
    expect(await generatedFiles(media)).toEqual([`${item.id}.png`]);
  });

  it("stops at six pictures a turn, counted across calls", async () => {
    const bytes = await png();
    const { run, calls, ctx } = await setup({ routes: [[generations, json({ data: [{ b64_json: bytes.toString("base64") }] })]] });
    for (let index = 0; index < 6; index += 1) expect((await run("generate_image", { prompt: `第 ${index} 张` })).result.ok).toBe(true);
    const over = await run("generate_image", { prompt: "第 7 张" });
    expect(over.result).toMatchObject({ ok: false, code: "generate_limit", message: expect.stringContaining("6 次") });
    expect(over.action).toEqual({ name: "generate_image", summary: "这一轮生成图片到上限了，“第 7 张”没生成", ok: false });
    expect(calls).toHaveLength(6);
    expect(ctx.generated).toEqual({ images: 6 });
  });

  it("counts every request that went out, even the ones that failed", async () => {
    const { run, calls, ctx } = await setup({ routes: [[generations, json(errorBody("bad_gateway", "upstream timed out"), 502)]] });
    // 本地就挡下的（参考图找不到）没发请求，不算
    expect((await run("generate_image", { prompt: "没有图", reference_media_ids: ["f".repeat(32)] })).result).toMatchObject({ ok: false, code: "media_not_found" });
    expect(ctx.generated.images).toBe(0);
    // 中转站超时、5xx 时接口那边可能已经扣费：发出去就算一次
    for (let index = 0; index < 6; index += 1) expect((await run("generate_image", { prompt: `第 ${index} 张` })).result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect((await run("generate_image", { prompt: "第 7 张" })).result).toMatchObject({ ok: false, code: "generate_limit", message: expect.stringContaining("没成功的也算") });
    expect(calls).toHaveLength(6);
  });

  it("downloads the picture without the key when the relay answers with a link", async () => {
    const bytes = await png();
    const { run, calls } = await setup({
      routes: [
        [generations, json({ data: [{ url: "https://cdn.example.com/out.png" }] })],
        [(call) => call.url === "https://cdn.example.com/out.png", new Response(bytes)],
      ],
    });
    const { result } = await run("generate_image", { prompt: "城市夜景", ratio: "16:9", quality: "high", transparent: true, name: "夜景" });
    expect(result).toMatchObject({ ok: true, media: { name: "夜景", kind: "image" } });
    expect(JSON.parse(calls[0].body)).toMatchObject({ size: "1536x864", quality: "high", background: "transparent" });
    expect(calls[1].headers).toEqual({});
    expect(JSON.stringify(calls[1])).not.toContain(IMAGE_KEY);
  });

  it("maps ratios to the three standard sizes for older models", async () => {
    const bytes = await png();
    const { run, calls } = await setup({
      generation: { image: { ...IMAGE, model: "gpt-image-1.5" } },
      canvas: { width: 1920, height: 1080, fps: 30 },
      routes: [[generations, json({ data: [{ b64_json: bytes.toString("base64") }] })]],
    });
    for (const ratio of [undefined, "9:16", "1:1", "4:3", "2:3"]) await run("generate_image", { prompt: `比例 ${ratio}`, ...(ratio ? { ratio } : {}) });
    expect(calls.map((call) => JSON.parse(call.body).size)).toEqual(["1536x1024", "1024x1536", "1024x1024", "1536x1024", "1024x1536"]);
    expect((await run("generate_image", { prompt: "x", ratio: "5:4" })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
  });

  it("sends reference pictures as image[] fields to the edits endpoint", async () => {
    const bytes = await png();
    const { run, calls, media } = await setup({ routes: [[edits, json({ data: [{ b64_json: bytes.toString("base64") }] })]] });
    const first = await media.importFile(path.join(FIXTURES, "still.png"), "人物.png");
    const second = await media.importFile(path.join(FIXTURES, "still.jpg"), "背景.jpg");
    const { result } = await run("generate_image", { prompt: "把人物放进背景里", reference_media_ids: [first.id, second.id, first.id] });
    expect(result).toMatchObject({ ok: true });
    const [call] = calls;
    expect(call.url).toBe(`${IMAGE.baseUrl}/images/edits`);
    // multipart 的 Content-Type（带 boundary）交给 fetch 自己写
    expect(call.headers).toEqual({ Authorization: `Bearer ${IMAGE_KEY}` });
    expect(call.body).toBeInstanceOf(FormData);
    const images = call.body.getAll("image[]");
    expect(images.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(Buffer.from(await images[0].arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(["model", "prompt", "size", "quality", "output_format", "n"].map((key) => [key, call.body.get(key)])))
      .toEqual({ model: "gpt-image-2.5-flare", prompt: "把人物放进背景里", size: "864x1536", quality: "medium", output_format: "png", n: "1" });
    expect(call.body.has("background")).toBe(false);

    const video = await media.importFile(path.join(FIXTURES, "clip-720p.mp4"), "片段.mp4");
    expect((await run("generate_image", { prompt: "参考视频", reference_media_ids: [video.id] })).result).toMatchObject({ ok: false, code: "not_image" });
    expect((await run("generate_image", { prompt: "太多", reference_media_ids: ["a", "b", "c", "d", "e"].map((c) => c.repeat(32)) })).result).toMatchObject({ ok: false, code: "arguments_invalid" });
    expect((await run("generate_image", { prompt: "没有", reference_media_ids: ["f".repeat(32)] })).result).toMatchObject({ ok: false, code: "media_not_found" });
    expect(calls).toHaveLength(1);
  });

  it("puts provider errors in plain words, sends once and never repeats the key", async () => {
    const cases = [
      [401, errorBody("invalid_api_key", `Incorrect API key provided: ${IMAGE_KEY}`), "generate_key_invalid", "Key 不对"],
      [403, errorBody(null, "Your organization must be verified to use the model gpt-image-2.5-flare."), "organization_unverified", "组织验证"],
      [403, errorBody("unsupported_country_region_territory", "Country, region, or territory not supported"), "generate_forbidden", "地区不支持"],
      [429, errorBody("insufficient_quota", "You exceeded your current quota", "insufficient_quota"), "quota_exceeded", "余额或额度不够"],
      [429, errorBody("billing_hard_limit_reached", "Billing hard limit has been reached"), "quota_exceeded", "余额或额度不够"],
      [429, errorBody(null, "Rate limit reached for gpt-image-2.5-flare"), "rate_limited", "太频繁"],
      [400, errorBody("moderation_blocked", "Your request was rejected by the safety system.", "image_generation_user_error"), "moderation_blocked", "内容审核没通过"],
      [503, errorBody("server_is_overloaded", "overloaded"), "provider_unavailable", "暂时不可用"],
      // 5xx 带上服务商原话（抹掉 Key）
      [502, errorBody("bad_gateway", `upstream refused key ${IMAGE_KEY}`), "provider_unavailable", "服务商说：upstream refused key ***"],
      // 中转站没有这个模型（new-api 的 503 model_not_found）：配置问题，不说「稍后再试」
      [503, errorBody("model_not_found", "No available channel for model gpt-image-2.5-flare"), "provider_error", "中转站里没有能用的这个模型"],
      [400, errorBody("invalid_value", `Invalid size for key ${IMAGE_KEY}`), "provider_error", "图片没生成出来"],
    ];
    for (const [status, body, code, words] of cases) {
      const { run, calls } = await setup({ routes: [[generations, json(body, status)]] });
      const { result, action } = await run("generate_image", { prompt: "海边" });
      expect(result, code).toMatchObject({ ok: false, code, message: expect.stringContaining(words) });
      expect(JSON.stringify({ result, action }), code).not.toContain(IMAGE_KEY);
      expect(calls, code).toHaveLength(1);
    }
    // 中转站不支持参考图
    const { run, media } = await setup({ routes: [[edits, json({ error: { message: "Not Found" } }, 404)]] });
    const reference = await media.importFile(path.join(FIXTURES, "still.png"), "图.png");
    expect((await run("generate_image", { prompt: "改图", reference_media_ids: [reference.id] })).result).toMatchObject({ ok: false, code: "references_unsupported", message: expect.stringContaining("不支持参考图") });
    // one-api 的改图接口回 501 api_not_implemented
    const oneApi = await setup({ routes: [[edits, json({ error: { message: "API not implemented", type: "one_api_error", code: "api_not_implemented" } }, 501)]] });
    const picture = await oneApi.media.importFile(path.join(FIXTURES, "still.png"), "图.png");
    expect((await oneApi.run("generate_image", { prompt: "改图", reference_media_ids: [picture.id] })).result).toMatchObject({ ok: false, code: "references_unsupported" });
    // 网络断了：不重发
    const offline = await setup({ routes: [[generations, () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }); }]] });
    expect((await offline.run("generate_image", { prompt: "海边" })).result).toMatchObject({ ok: false, code: "network_error", message: expect.stringContaining("没有自动重发") });
    expect(offline.calls).toHaveLength(1);
    // 回的不是图片
    const junk = await setup({ routes: [[generations, json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })]] });
    expect((await junk.run("generate_image", { prompt: "海边" })).result).toMatchObject({ ok: false, code: "provider_error" });
    expect(await generatedFiles(junk.media)).toEqual([]);
  });
});

describe("generate_video", () => {
  /** 建任务回 cgt-1；查进度按 states 一个个回，最后一个一直回（states 也可以是函数，现场决定）；下载回 clip-720p.mp4。 */
  async function videoApi(states, { onPoll = () => undefined, create = json({ id: "cgt-1" }) } = {}) {
    const bytes = await mp4();
    let polls = 0;
    return [
      [(call) => call.method === "POST" && call.url === TASKS, create],
      [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, () => {
        const state = typeof states === "function" ? states(polls) : states[Math.min(polls, states.length - 1)];
        polls += 1;
        onPoll(polls);
        return json(state);
      }],
      [(call) => call.method === "DELETE" && call.url === `${TASKS}/cgt-1`, json({})],
      [(call) => call.url === "https://tos.example.com/out.mp4", new Response(bytes)],
    ];
  }
  const SUCCEEDED = { status: "succeeded", content: { video_url: "https://tos.example.com/out.mp4" }, usage: { completion_tokens: 108_900, total_tokens: 108_900 } };

  it("asks before spending and sends nothing when the user says no", async () => {
    const asked = [];
    const { run, calls } = await setup({
      routes: await videoApi([SUCCEEDED]),
      askSpend: async (spec) => { asked.push(spec); throw new AiEditError("spend_denied", "用户没同意生成，一分钱没花。"); },
    });
    const { result, action } = await run("generate_video", { prompt: "海浪拍打礁石，慢镜头" });
    expect(asked).toEqual([{ kind: "video", provider: "火山方舟 Seedance", model: VIDEO.model, seconds: 5, resolution: "720p", ratio: "9:16", audio: false, prompt: "海浪拍打礁石，慢镜头", estimate: 4.97 }]);
    // 给模型的照旧是没同意；给页面的是一句人话，用户自己选的不画成失败
    expect(result).toMatchObject({ ok: false, code: "spend_denied", message: "用户没同意生成，一分钱没花。" });
    expect(action).toEqual({ name: "generate_video", summary: "你选了不生成视频“海浪拍打礁石，慢镜头”", ok: true });
    expect(calls).toEqual([]);
    // 没有页面能问：不生成
    const unattended = await setup({ routes: await videoApi([SUCCEEDED]) });
    expect((await unattended.run("generate_video", { prompt: "海浪" })).result).toMatchObject({ ok: false, code: "spend_unavailable", message: expect.stringContaining("要开着应用才能确认") });
    expect(unattended.calls).toEqual([]);
  });

  it("creates the task once, polls until it is done and downloads the video into the library", async () => {
    const asked = [];
    const { run, calls, media } = await setup({
      canvas: { width: 1920, height: 1080, fps: 30 },
      routes: await videoApi([{ status: "queued" }, { status: "running" }, SUCCEEDED]),
      askSpend: async (spec) => { asked.push(spec); },
    });
    const { result, action } = await run("generate_video", { prompt: "城市延时摄影，车流划出光轨", duration: 40, resolution: "480p", with_audio: true, name: "车流" });
    expect(asked[0]).toMatchObject({ seconds: 15, resolution: "480p", ratio: "16:9", audio: true });
    const create = calls.find((call) => call.method === "POST");
    expect(create.headers).toEqual({ Authorization: `Bearer ${VIDEO_KEY}`, "Content-Type": "application/json" });
    expect(JSON.parse(create.body)).toEqual({
      model: VIDEO.model, content: [{ type: "text", text: "城市延时摄影，车流划出光轨" }],
      resolution: "480p", ratio: "16:9", duration: 15, generate_audio: true, watermark: false, execution_expires_after: 3600,
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET" && call.url.startsWith(TASKS))).toHaveLength(3);
    expect(calls.filter((call) => call.url.startsWith(TASKS)).every((call) => call.headers.Authorization === `Bearer ${VIDEO_KEY}`)).toBe(true);
    // 下载结果不带 Key
    const download = calls.find((call) => call.url === "https://tos.example.com/out.mp4");
    expect(JSON.stringify(download)).not.toContain(VIDEO_KEY);
    expect(result).toMatchObject({ ok: true, tokens: 108_900, media: { kind: "video", name: "车流", from: "AI 生成", duration: 5.041667 } });
    expect(result.note).toContain("只能生成 4 到 15 秒，按 15 秒生成的");
    expect(result.note).toContain("生成了 5.04 秒带声音的视频");
    expect(action).toEqual({ name: "generate_video", summary: "生成了视频「车流」", ok: true });
    const item = media.get(result.media.media_id);
    expect(item.source).toMatchObject({ type: "generated", provider: "seedance", model: VIDEO.model, prompt: "城市延时摄影，车流划出光轨" });
    expect(await readFile(media.readyPath(item.id))).toEqual(await mp4());
    expect(await generatedFiles(media)).toEqual([`${item.id}.mp4`]);

    // 同样的说明和参数：查重在确认之前，不问、不花钱
    const before = calls.length;
    const again = await run("generate_video", { prompt: "城市延时摄影，车流划出光轨", duration: 15, resolution: "480p", with_audio: true });
    expect(again.result).toMatchObject({ ok: true, reused: true, media: { media_id: item.id } });
    expect(asked).toHaveLength(1);
    expect(calls).toHaveLength(before);
  });

  it("brings back why a task failed and explains Ark errors", async () => {
    const failed = await setup({
      routes: await videoApi([{ status: "running" }, { status: "failed", error: { code: "InternalServiceError", message: "生成服务暂时出错" } }]),
      askSpend: async () => undefined,
    });
    expect((await failed.run("generate_video", { prompt: "海浪" })).result).toMatchObject({ ok: false, code: "generate_failed", message: "视频没生成出来：生成服务暂时出错" });
    expect(await generatedFiles(failed.media)).toEqual([]);

    const cases = [
      [404, errorBody("ModelNotOpen", "Your account has not activated the model"), "model_not_open", "开通管理"],
      [403, errorBody("AccountOverdueError", "overdue"), "account_overdue", "欠费"],
      [403, errorBody("OperationDenied.ServiceNotOpen", "not open"), "service_not_open", "还没开通"],
      [404, errorBody("InvalidEndpointOrModel.NotFound", "not found"), "model_not_found", "模型名"],
      [401, errorBody("AuthenticationError", `bad key ${VIDEO_KEY}`), "generate_key_invalid", "Key 不对"],
      [429, errorBody("ModelAccountRpmRateLimitExceeded", "rpm"), "rate_limited", "太频繁"],
      // 这几种 429 等多久都不会好：说清楚去控制台做什么
      [429, errorBody("SetLimitExceeded", "Your account has reached the set inference limit"), "usage_limit_reached", "开通管理"],
      [429, errorBody("AccountQuotaExceeded", "insufficient quota"), "quota_exceeded", "充值"],
      [429, errorBody("InflightBatchsizeExceeded", "inflight batch size exceeded"), "quota_exceeded", "同时在做的任务数"],
      [429, errorBody("QuotaExceeded", "Your account has exhausted its free trial quota for the model"), "quota_exceeded", "免费试用额度"],
      // 排队中的任务数超限也是 QuotaExceeded，这种等等就好
      [429, errorBody("QuotaExceeded", "The request has exceeded the quota"), "rate_limited", "太频繁"],
      [400, errorBody("InputImageSensitiveContentDetected.PrivacyInformation", "face"), "real_face", "真人脸"],
      [400, errorBody("InputTextSensitiveContentDetected", "text"), "moderation_blocked", "审核没通过"],
    ];
    for (const [status, body, code, words] of cases) {
      const { run, calls } = await setup({ routes: await videoApi([SUCCEEDED], { create: json(body, status) }), askSpend: async () => undefined });
      const { result, action } = await run("generate_video", { prompt: "海浪" });
      expect(result, code).toMatchObject({ ok: false, code, message: expect.stringContaining(words) });
      expect(JSON.stringify({ result, action }), code).not.toContain(VIDEO_KEY);
      expect(calls, code).toHaveLength(1);
    }
    // 方舟模型开通了还要余额：说清楚门槛
    const { run } = await setup({ routes: await videoApi([SUCCEEDED], { create: json(errorBody("ModelNotOpen", "x"), 404) }), askSpend: async () => undefined });
    expect((await run("generate_video", { prompt: "海浪" })).result.message).toContain("不少于 200 元");
  });

  it("cancels a task that is still queued when the user stops", async () => {
    const controller = new AbortController();
    const { run, calls, media } = await setup({
      signal: controller.signal,
      routes: await videoApi([{ status: "queued" }], { onPoll: (count) => { if (count === 1) setTimeout(() => controller.abort(), 0); } }),
      askSpend: async () => undefined,
    });
    await expect(run("generate_video", { prompt: "海浪" })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(calls.find((call) => call.method === "DELETE").headers).toEqual({ Authorization: `Bearer ${VIDEO_KEY}` });
    const polled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(polled);
    expect(media.list()).toEqual([]);
  });

  it("lets a running task finish in the background after the user stops, and keeps the video", async () => {
    const controller = new AbortController();
    let asked = 0;
    const generated = { images: 0, background: [] };
    const { run, calls, media } = await setup({
      signal: controller.signal,
      generated,
      routes: await videoApi([{ status: "running" }, { status: "running" }, SUCCEEDED], { onPoll: (count) => { if (count === 1) setTimeout(() => controller.abort(), 0); } }),
      askSpend: async () => { asked += 1; },
    });
    await expect(run("generate_video", { prompt: "海浪" })).rejects.toMatchObject({ name: "AbortError" });
    // 记下来（带任务号），这一轮的「（已停止）」后面告诉用户这段还会做完、照常扣费
    expect(generated.background).toEqual([{ name: "海浪", taskId: "cgt-1", phase: "generating" }]);
    // 还在后台做的时候同样的说明再调：不再问、不再建任务
    const again = await setup({ library: media, routes: [], askSpend: async () => { asked += 1; } });
    expect((await again.run("generate_video", { prompt: "海浪" })).result).toMatchObject({ ok: false, code: "generate_pending" });
    expect(asked).toBe(1);
    expect(again.calls).toEqual([]);
    expect(await settled(media)).toEqual([expect.objectContaining({ kind: "video", status: "ready", source: expect.objectContaining({ type: "generated", provider: "seedance" }) })]);
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });

  it("says a video stopped while its task was being created may still be made, and keeps it if it is", async () => {
    const controller = new AbortController();
    const generated = { images: 0, background: [] };
    let reply;
    const answered = new Promise((resolve) => { reply = resolve; });
    const bytes = await mp4();
    let polls = 0;
    const { run, calls, media } = await setup({
      signal: controller.signal,
      generated,
      routes: [
        // 建任务的请求还在路上时用户点了停止
        [(call) => call.method === "POST", async () => { setTimeout(() => controller.abort(), 0); await answered; return json({ id: "cgt-1" }); }],
        // 一建好就开跑了：取消不了
        [(call) => call.method === "DELETE", json(errorBody("InvalidParameter", "task is running"), 400)],
        [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, () => json((polls += 1) < 2 ? { status: "running" } : SUCCEEDED)],
        [(call) => call.url === "https://tos.example.com/out.mp4", new Response(bytes)],
      ],
      askSpend: async () => undefined,
    });
    await expect(run("generate_video", { prompt: "刚提交就停" })).rejects.toMatchObject({ name: "AbortError" });
    // 还没有任务号：结尾说「刚提交给方舟，如果已经开始生成就停不下来」
    expect(generated.background).toEqual([{ name: "刚提交就停", phase: "submitted" }]);
    reply();
    expect(await settled(media)).toEqual([expect.objectContaining({ kind: "video", status: "ready" })]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "GET", "GET", "GET"]);
  });

  it("hands a slow video to the background after the foreground wait, and still saves it", async () => {
    // pollMs 是 1：前台等 1.2 秒就转后台（正式环境 20 分钟）
    let finished = false;
    let asked = 0;
    const generated = { images: 0, background: [] };
    const { run, calls, media } = await setup({
      generated,
      routes: await videoApi(() => (finished ? SUCCEEDED : { status: "running" })),
      askSpend: async () => { asked += 1; },
    });
    const { result } = await run("generate_video", { prompt: "慢慢涨潮" });
    expect(result).toMatchObject({ ok: false, code: "generate_background", message: expect.stringContaining("做完会自动放进素材库，照常扣费。别再生成一次") });
    expect(result.message).toContain("cgt-1");
    expect(generated.background).toEqual([{ name: "慢慢涨潮", taskId: "cgt-1", phase: "generating" }]);
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    // 后台还在做：同样的说明再调不问、不建
    const again = await setup({ library: media, routes: [], askSpend: async () => { asked += 1; } });
    expect((await again.run("generate_video", { prompt: "慢慢涨潮" })).result).toMatchObject({ ok: false, code: "generate_pending" });
    expect(asked).toBe(1);
    expect(again.calls).toEqual([]);
    finished = true;
    expect(await settled(media)).toEqual([expect.objectContaining({ kind: "video", status: "ready", name: "慢慢涨潮" })]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // 到点时还在排队：取消掉，没扣费，也不转后台
    const queued = await setup({ generated: { images: 0, background: [] }, routes: await videoApi([{ status: "queued" }]), askSpend: async () => undefined });
    expect((await queued.run("generate_video", { prompt: "一直排队" })).result).toMatchObject({ ok: false, code: "generate_timeout", message: expect.stringContaining("没有扣费") });
    expect(queued.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(queued.ctx.generated.background).toEqual([]);
    const polled = queued.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(queued.calls).toHaveLength(polled);
  }, 10_000);

  it("keeps polling through dropped connections, timeouts, rate limits and server errors", async () => {
    const offline = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); };
    const replies = [
      offline, offline, offline,
      () => json(errorBody("ModelAccountRpmRateLimitExceeded", "rpm"), 429),
      () => json({}, 408),
      () => json(errorBody("InternalServiceError", "busy"), 503),
      () => { throw new DOMException("timed out", "TimeoutError"); },
    ];
    const bytes = await mp4();
    let asked = 0;
    const { run, calls, media } = await setup({
      routes: [
        [(call) => call.method === "POST", json({ id: "cgt-1" })],
        [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, () => (replies.length ? replies.shift()() : json(SUCCEEDED))],
        [(call) => call.url === "https://tos.example.com/out.mp4", new Response(bytes)],
      ],
      askSpend: async () => { asked += 1; },
    });
    expect((await run("generate_video", { prompt: "网不好的海浪" })).result).toMatchObject({ ok: true, media: { kind: "video" } });
    expect(asked).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET" && call.url.startsWith(TASKS))).toHaveLength(8);
    expect(media.list()).toHaveLength(1);

    // 方舟明确说没这个任务（4xx）：不再查
    const gone = await setup({
      routes: [
        [(call) => call.method === "POST", json({ id: "cgt-1" })],
        [(call) => call.method === "GET", json(errorBody("ResourceNotFound", "task not found"), 404)],
      ],
      askSpend: async () => undefined,
    });
    expect((await gone.run("generate_video", { prompt: "找不到的海浪" })).result).toMatchObject({ ok: false });
    expect(gone.calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("gives up only after three hours, checking once more first", async () => {
    const real = Date.now.bind(Date);
    let shift = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
    const later = (count) => { if (count === 2) shift = 4 * 60 * 60_000; };
    try {
      // 第 2 次查完时钟拨到 4 小时后：再查一次发现做完了，照常下载入库
      const done = await setup({ routes: await videoApi([{ status: "running" }, { status: "running" }, SUCCEEDED], { onPoll: later }), askSpend: async () => undefined });
      expect((await done.run("generate_video", { prompt: "最后一刻做完" })).result).toMatchObject({ ok: true });
      expect(done.media.list()).toHaveLength(1);
      shift = 0;
      // 再查一次还在跑：这才放弃，报错带任务号
      const stuck = await setup({ routes: await videoApi([{ status: "running" }], { onPoll: later }), askSpend: async () => undefined });
      const { result } = await stuck.run("generate_video", { prompt: "一直在跑" });
      expect(result).toMatchObject({ ok: false, code: "generate_timeout", message: expect.stringContaining("cgt-1") });
      expect(stuck.calls.filter((call) => call.method === "GET")).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a paid video that would not download and downloads it again on the same call, without asking or creating", async () => {
    const bytes = await mp4();
    const download = (call) => call.url === "https://tos.example.com/out.mp4";
    let broken = true;
    let asked = 0;
    const { run, calls, media } = await setup({
      routes: [
        [(call) => call.method === "POST", json({ id: "cgt-1" })],
        [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, json(SUCCEEDED)],
        [download, () => (broken ? new Response("bad gateway", { status: 502 }) : new Response(bytes))],
      ],
      askSpend: async () => { asked += 1; },
    });
    const first = await run("generate_video", { prompt: "下不下来的海浪" });
    expect(first.result).toMatchObject({ ok: false, code: "download_failed", message: expect.stringContaining("任务号 cgt-1") });
    expect(first.result.message).toContain("不会再扣钱");
    expect(calls.filter(download)).toHaveLength(5);
    expect(await generatedFiles(media)).toEqual([]);

    // 同样的说明再调：重新查一次任务拿链接再下载，不问、不建
    broken = false;
    const second = await run("generate_video", { prompt: "下不下来的海浪" });
    expect(second.result).toMatchObject({ ok: true, media: { kind: "video", name: "下不下来的海浪" }, note: expect.stringContaining("没有再扣钱") });
    expect(asked).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET" && call.url.startsWith(TASKS))).toHaveLength(2);
    expect((await run("generate_video", { prompt: "下不下来的海浪" })).result).toMatchObject({ ok: true, reused: true });
  });

  it("never creates a second task when it is unclear whether the first one went through", async () => {
    const reset = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); };
    const cutOff = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("terminated")); } }), { status: 200 });
    const cases = [
      ["gateway", json(errorBody("", "Bad Gateway"), 502), "方舟回了 502"],
      ["wrapped id", json({ code: 0, data: { id: "cgt-1" } }), "没给任务编号"],
      ["reset", reset, "没收到方舟的答复（ECONNRESET）"],
      ["cut off", cutOff, "读到一半"],
    ];
    for (const [label, reply, words] of cases) {
      let asked = 0;
      const { run, calls } = await setup({ routes: [[(call) => call.method === "POST", reply]], askSpend: async () => { asked += 1; } });
      const { result } = await run("generate_video", { prompt: "说不准的海浪" });
      expect(result, label).toMatchObject({ ok: false, code: "create_uncertain", message: expect.stringContaining(words) });
      expect(result.message, label).toContain("先别重试");
      expect(result.message, label).not.toContain("稍后再试");
      // 同样的说明再调：不问、不建，回同一句提醒
      expect((await run("generate_video", { prompt: "说不准的海浪" })).result, label).toMatchObject({ ok: false, code: "create_uncertain", message: expect.stringContaining("到火山方舟控制台的视频生成任务里看看") });
      expect(asked, label).toBe(1);
      expect(calls, label).toHaveLength(1);
    }
    // 请求根本没发出去（拒绝连接）：肯定没建、没扣费，同样的说明可以再问一次
    const refused = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }) }); };
    let asked = 0;
    const { run, calls } = await setup({ routes: [[(call) => call.method === "POST", refused]], askSpend: async () => { asked += 1; } });
    expect((await run("generate_video", { prompt: "没发出去的海浪" })).result).toMatchObject({ ok: false, code: "network_error", message: expect.stringContaining("没扣费") });
    expect((await run("generate_video", { prompt: "没发出去的海浪" })).result).toMatchObject({ ok: false, code: "network_error" });
    expect(asked).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("asks about at most two videos a turn, counting the ones the user turned down", async () => {
    let asked = 0;
    const { run, calls, ctx } = await setup({
      routes: await videoApi([SUCCEEDED]),
      askSpend: async () => { asked += 1; throw new AiEditError("spend_denied", "用户没同意生成，一分钱没花。"); },
    });
    for (const prompt of ["第一段", "第二段"]) expect((await run("generate_video", { prompt })).result).toMatchObject({ ok: false, code: "spend_denied" });
    const over = await run("generate_video", { prompt: "第三段" });
    expect(over.result).toMatchObject({ ok: false, code: "generate_limit", message: expect.stringContaining("2 段") });
    expect(over.action).toEqual({ name: "generate_video", summary: "这一轮生成视频到上限了，“第三段”没生成", ok: false });
    expect(asked).toBe(2);
    expect(calls).toEqual([]);
    expect(ctx.generated.videos).toBe(2);

    // 15 分钟没人点：给模型的话不变，页面上是一句人话（不是「生成了视频…」）
    const timedOut = await setup({ routes: [], askSpend: async () => { throw new AiEditError("spend_timeout", "等了 15 分钟没人点确认，这段没有生成，一分钱没花。", 504); } });
    const late = await timedOut.run("generate_video", { prompt: "没人点的海浪" });
    expect(late.result).toEqual({ ok: false, code: "spend_timeout", message: "等了 15 分钟没人点确认，这段没有生成，一分钱没花。" });
    expect(late.action).toEqual({ name: "generate_video", summary: "视频“没人点的海浪”等了 15 分钟没人确认，没有生成", ok: false });
  });

  it("checks the task again before cancelling, and never deletes one that finished while polling kept failing", async () => {
    const offline = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); };
    const bytes = await mp4();
    // 查到一次排队后断网，断网期间方舟上做完扣了费；网刚恢复、下一次查询还没到时用户点了停止
    const controller = new AbortController();
    const generated = { images: 0, background: [] };
    let gets = 0;
    let online = true;
    const { run, calls, media } = await setup({
      signal: controller.signal,
      generated,
      routes: [
        [(call) => call.method === "POST", json({ id: "cgt-1" })],
        [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, () => {
          gets += 1;
          if (gets === 1) { online = false; return json({ status: "queued" }); }
          if (!online) {
            if (gets === 3) { online = true; setTimeout(() => controller.abort(), 0); }
            offline();
          }
          return json(SUCCEEDED);
        }],
        // 对做好的任务 DELETE 会删掉任务记录：一次都不能发
        [(call) => call.method === "DELETE", json({})],
        [(call) => call.url === "https://tos.example.com/out.mp4", new Response(bytes)],
      ],
      askSpend: async () => undefined,
    });
    await expect(run("generate_video", { prompt: "断网时做完的海浪" })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    // 现查到已经做好了：结尾说「已经生成好了，还在下载」，叫醒轮询马上去下载
    expect(generated.background).toEqual([{ name: "断网时做完的海浪", taskId: "cgt-1", phase: "downloading" }]);
    expect(await settled(media)).toEqual([expect.objectContaining({ kind: "video", status: "ready" })]);

    // 到点时现查不到（还断着网）：缓存里是排队也不取消，当停不下来转后台
    const shutdown = new AbortController();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let down = false;
      const stuck = await setup({
        generated: { images: 0, background: [] },
        shutdown: shutdown.signal,
        routes: [
          [(call) => call.method === "POST", json({ id: "cgt-1" })],
          [(call) => call.method === "GET", () => { if (down) offline(); down = true; return json({ status: "queued" }); }],
          [(call) => call.method === "DELETE", json({})],
        ],
        askSpend: async () => undefined,
      });
      const { result } = await stuck.run("generate_video", { prompt: "断着网排队" });
      expect(result).toMatchObject({ ok: false, code: "generate_background", message: expect.stringContaining("照常扣费") });
      expect(stuck.calls.filter((call) => call.method === "DELETE")).toEqual([]);
      expect(stuck.ctx.generated.background).toEqual([{ name: "断着网排队", taskId: "cgt-1", phase: "generating" }]);
    } finally {
      shutdown.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      warn.mockRestore();
    }

    // 现查到已经失败了：不扣费，不用转后台
    const failed = new AbortController();
    const quiet = await setup({
      signal: failed.signal,
      generated: { images: 0, background: [] },
      routes: await videoApi([{ status: "running" }, { status: "failed", error: { code: "InternalServiceError", message: "出错了" } }], { onPoll: (count) => { if (count === 1) setTimeout(() => failed.abort(), 0); } }),
      askSpend: async () => undefined,
    });
    await expect(quiet.run("generate_video", { prompt: "停的时候已经失败" })).rejects.toMatchObject({ name: "AbortError" });
    expect(quiet.ctx.generated.background).toEqual([]);
    expect(quiet.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });

  it("lets only one clip ask about the same video at a time, and frees it when the user says no or stops", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    const prompt = "两个剪辑都要的海浪";
    let approve;
    const first = await setup({ routes: await videoApi([SUCCEEDED]), askSpend: () => new Promise((resolve) => { approve = resolve; }) });
    const asking = first.run("generate_video", { prompt });
    await tick();
    // A 的卡片还挂着：B 同样的说明不再弹卡片
    let asked = 0;
    const second = await setup({ library: first.media, routes: [], askSpend: async () => { asked += 1; } });
    const blocked = await second.run("generate_video", { prompt });
    expect(blocked.result).toMatchObject({ ok: false, code: "generate_pending", message: expect.stringContaining("另一个剪辑正在请用户确认") });
    expect(blocked.action).toEqual({ name: "generate_video", summary: `另一个剪辑正在确认或生成同样的视频“${prompt}”，这次没再生成`, ok: false });
    approve();
    expect((await asking).result).toMatchObject({ ok: true, media: { kind: "video" } });
    // 做好入库了：B 再调直接回那一段
    expect((await second.run("generate_video", { prompt })).result).toMatchObject({ ok: true, reused: true });
    expect(asked).toBe(0);
    expect(first.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(second.calls).toEqual([]);

    // 没同意、点了停止：占位撤掉，再调又会问
    for (const reason of [new AiEditError("spend_denied", "用户没同意生成，一分钱没花。", 409), Object.assign(new Error("stopped"), { name: "AbortError" })]) {
      let refuse;
      const third = await setup({ routes: [], askSpend: () => new Promise((_resolve, reject) => { refuse = () => reject(reason); }) });
      const pending = third.run("generate_video", { prompt: "没要成的海浪" }).then((value) => value, (error) => error);
      await tick();
      const meanwhile = await setup({ library: third.media, routes: [], askSpend: async () => { throw new Error("不该问"); } });
      expect((await meanwhile.run("generate_video", { prompt: "没要成的海浪" })).result).toMatchObject({ code: "generate_pending" });
      refuse();
      await pending;
      let again = 0;
      const later = await setup({ library: third.media, routes: [], askSpend: async () => { again += 1; throw new AiEditError("spend_denied", "用户没同意生成，一分钱没花。", 409); } });
      expect((await later.run("generate_video", { prompt: "没要成的海浪" })).result).toMatchObject({ code: "spend_denied" });
      expect(again, reason.name).toBe(1);
    }
  });

  it("keeps cancelling a stopped video while it is still queued, and says so when the same video is asked for again", async () => {
    const controller = new AbortController();
    const generated = { images: 0, background: [] };
    let reply;
    const answered = new Promise((resolve) => { reply = resolve; });
    let deletes = 0;
    const { run, calls, media } = await setup({
      signal: controller.signal,
      generated,
      routes: [
        // 建任务的请求还在路上时用户点了停止
        [(call) => call.method === "POST", async () => { setTimeout(() => controller.abort(), 0); await answered; return json({ id: "cgt-1" }); }],
        // 第一次取消碰上网关出错，任务还在排队
        [(call) => call.method === "DELETE", () => ((deletes += 1) === 1 ? json(errorBody("InternalServiceError", "busy"), 502) : json({}))],
        [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, json({ status: "queued" })],
      ],
      askSpend: async () => undefined,
    });
    await expect(run("generate_video", { prompt: "排队时停" })).rejects.toMatchObject({ name: "AbortError" });
    expect(generated.background).toEqual([{ name: "排队时停", phase: "submitted" }]);
    // 马上再要同样的这段：说清楚排队的会被取消、不会自己进素材库
    let asked = 0;
    const again = await setup({ library: media, routes: [], askSpend: async () => { asked += 1; } });
    const resend = await again.run("generate_video", { prompt: "排队时停" });
    expect(resend.result).toMatchObject({ ok: false, code: "generate_pending", message: expect.stringContaining("排队中的会被取消") });
    expect(resend.result.message).toContain("会重新请用户确认");
    expect(resend.result.message).not.toContain("别再生成一次");
    expect(resend.action).toEqual({ name: "generate_video", summary: "上一轮停止时视频“排队时停”刚提交，这次没再生成", ok: false });
    expect(asked).toBe(0);
    reply();
    const deadline = Date.now() + 5_000;
    while (deletes < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "GET", "DELETE"]);
    // 取消掉了：不再查，也不进素材库；同样的说明再调重新请用户确认
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(4);
    expect(media.list()).toEqual([]);
    await again.run("generate_video", { prompt: "排队时停" });
    expect(asked).toBe(1);
  });

  it("says a stopped re-download costs nothing more", async () => {
    const bytes = await mp4();
    const download = (call) => call.url === "https://tos.example.com/out.mp4";
    const controller = new AbortController();
    let broken = true;
    const routes = [
      [(call) => call.method === "POST", json({ id: "cgt-1" })],
      [(call) => call.method === "GET" && call.url === `${TASKS}/cgt-1`, json(SUCCEEDED)],
      [download, async () => {
        if (broken) return new Response("bad gateway", { status: 502 });
        // 重新下载到一半用户点了停止
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(bytes);
      }],
    ];
    const first = await setup({ routes, askSpend: async () => undefined });
    expect((await first.run("generate_video", { prompt: "重新下载时停" })).result).toMatchObject({ code: "download_failed" });
    broken = false;
    const generated = { images: 0, background: [] };
    const second = await setup({ library: first.media, signal: controller.signal, generated, routes, askSpend: async () => { throw new Error("不该问"); } });
    await expect(second.run("generate_video", { prompt: "重新下载时停" })).rejects.toMatchObject({ name: "AbortError" });
    expect(generated.background).toEqual([{ name: "重新下载时停", taskId: "cgt-1", phase: "redownload" }]);
    expect(await settled(first.media)).toEqual([expect.objectContaining({ kind: "video", status: "ready" })]);
    expect(first.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(second.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("checks reference pictures before asking and keeps the three modes apart", async () => {
    const asked = [];
    const { run, calls, media } = await setup({ routes: await videoApi([SUCCEEDED]), askSpend: async (spec) => { asked.push(spec); } });
    const first = await media.importFile(path.join(FIXTURES, "still.png"), "首帧.png");
    const last = await media.importFile(path.join(FIXTURES, "still.jpg"), "尾帧.jpg");
    const extra = await media.importFile(path.join(FIXTURES, "still.webp"), "参考.webp");
    const fail = async (args, code, words) => {
      const { result } = await run("generate_video", { prompt: "海浪", ...args });
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code, ...(words ? { message: expect.stringContaining(words) } : {}) });
    };
    await fail({ first_frame_media_id: first.id, reference_media_ids: [extra.id] }, "arguments_invalid", "不能同时给");
    await fail({ last_frame_media_id: last.id }, "arguments_invalid", "同时给首帧");
    await fail({ reference_media_ids: Array.from({ length: 10 }, (_, index) => String(index).repeat(32)) }, "arguments_invalid", "最多 9 张");
    media.get(extra.id).width = 200;
    await fail({ reference_media_ids: [extra.id] }, "image_size_invalid", "300 到 6000");
    Object.assign(media.get(extra.id), { width: 3000, height: 1000 });
    await fail({ reference_media_ids: [extra.id] }, "image_size_invalid", "0.4 到 2.5");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    // 首尾帧：比例跟着首帧走（adaptive），图转成 data URL
    await run("generate_video", { prompt: "从白天到黑夜", first_frame_media_id: first.id, last_frame_media_id: last.id, ratio: "16:9" });
    const body = JSON.parse(calls.find((call) => call.method === "POST").body);
    expect(body.ratio).toBe("adaptive");
    expect(body.content.slice(1).map((part) => [part.type, part.role, part.image_url.url.slice(0, 22)])).toEqual([
      ["image_url", "first_frame", "data:image/png;base64,"],
      ["image_url", "last_frame", "data:image/jpeg;base64"],
    ]);
    expect(body.content[1].image_url.url).toBe(`data:image/png;base64,${(await png()).toString("base64")}`);

    // 参考图：每张 reference_image，比例照画布
    Object.assign(media.get(extra.id), { width: 1024, height: 1024 });
    calls.length = 0;
    await run("generate_video", { prompt: "参考这只猫", reference_media_ids: [first.id, extra.id] });
    const refs = JSON.parse(calls.find((call) => call.method === "POST").body);
    expect(refs.ratio).toBe("9:16");
    expect(refs.content.slice(1).map((part) => [part.role, part.image_url.url.slice(0, 22)])).toEqual([["reference_image", "data:image/png;base64,"], ["reference_image", "data:image/webp;base64"]]);
  });

  it("refuses 1080p on fast, mini and 2.5 models and allows 30 seconds on 2.5", async () => {
    const asked = [];
    const fast = await setup({ generation: { video: { ...VIDEO, model: "doubao-seedance-2-0-fast-260128" } }, routes: await videoApi([SUCCEEDED]), askSpend: async (spec) => { asked.push(spec); } });
    expect((await fast.run("generate_video", { prompt: "海浪", resolution: "1080p" })).result).toMatchObject({ ok: false, code: "arguments_invalid", message: expect.stringContaining("480p 或 720p") });
    expect(fast.calls).toEqual([]);
    const longer = await setup({ generation: { video: { ...VIDEO, model: "doubao-seedance-2-5-260628" } }, routes: await videoApi([SUCCEEDED]), askSpend: async (spec) => { asked.push(spec); } });
    // 2.5 的 1080p 是 10 位色深的 H.265：剪映和本机可能放不了，花钱前就拦下
    expect((await longer.run("generate_video", { prompt: "海浪", duration: 30, resolution: "1080p" })).result).toMatchObject({ ok: false, code: "arguments_invalid", message: expect.stringContaining("改成 720p") });
    expect(longer.calls).toEqual([]);
    const { result } = await longer.run("generate_video", { prompt: "海浪", duration: 30 });
    expect(result.ok).toBe(true);
    expect(result.note).not.toContain("只能生成");
    expect(asked).toEqual([expect.objectContaining({ seconds: 30, resolution: "720p", estimate: 45.36 })]);
  });
});

describe("backgroundNote", () => {
  it("tells the user, by stage, whether a video still costs money and when it will show up", () => {
    const later = "要开着应用等它做完；关掉的话，到火山方舟控制台的视频生成任务里按任务号下载。";
    expect(backgroundNote([])).toBe("");
    expect(backgroundNote([{ name: "涨潮", taskId: "cgt-1", phase: "generating" }], { stopped: true }))
      .toBe(`视频“涨潮”（方舟任务号 cgt-1）还在方舟上生成，停不下来，做完会自动放进素材库，照常扣费。${later}`);
    expect(backgroundNote([{ name: "涨潮", taskId: "cgt-1", phase: "generating" }])).toBe(`视频“涨潮”（方舟任务号 cgt-1）还在方舟上生成，做完会自动放进素材库，照常扣费。${later}`);
    // 已经生成好、正在下载：钱已经扣了，不是「还在生成」
    expect(backgroundNote([{ name: "退潮", taskId: "cgt-2", phase: "downloading" }], { stopped: true }))
      .toBe("视频“退潮”（方舟任务号 cgt-2）已经在方舟上生成好了，钱已经扣了，还在下载，下完会自动放进素材库。要开着应用等它下完；关掉的话，到火山方舟控制台的视频生成任务里按任务号下载。");
    // 重新下载：不会再扣钱
    const again = backgroundNote([{ name: "礁石", taskId: "cgt-3", phase: "redownload" }], { stopped: true });
    expect(again).toContain("不会再扣钱");
    expect(again).not.toContain("照常扣费");
    // 刚提交：开始生成了就停不下来，排队中的会取消
    expect(backgroundNote([{ name: "海鸥", phase: "submitted" }], { stopped: true }))
      .toBe("视频“海鸥”刚提交给方舟，如果已经开始生成就停不下来，做完会自动放进素材库，照常扣费；还在排队的会取消，不扣费。要开着应用等它做完；关掉的话，到火山方舟控制台的视频生成任务里下载。");
    expect(backgroundNote([{ name: "海鸥", taskId: "cgt-4", phase: "submitted" }], { stopped: true })).toContain("“海鸥”（方舟任务号 cgt-4）已经提交给方舟，如果已经开始生成就停不下来");
    // 几种一起：各说各的
    const mixed = backgroundNote([
      { name: "甲", taskId: "cgt-1", phase: "generating" }, { name: "乙", taskId: "cgt-2", phase: "downloading" }, { name: "丙", taskId: "cgt-3", phase: "generating" },
    ]);
    expect(mixed).toBe(`视频“甲”（方舟任务号 cgt-1）、“丙”（方舟任务号 cgt-3）还在方舟上生成，做完会自动放进素材库，照常扣费。视频“乙”（方舟任务号 cgt-2）已经在方舟上生成好了，钱已经扣了，还在下载，下完会自动放进素材库。${later}`);
  });
});
