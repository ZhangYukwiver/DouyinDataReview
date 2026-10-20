import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditError, invalid } from "./errors.mjs";
import { createAiEdit } from "./index.mjs";
import { MediaLibrary } from "./library.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-edit/media");
const KEY = "test-key";
const CONFIG = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: KEY, model: "doubao-seed-2-1-lite-260915" };

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// ---------- 假的依赖 ----------

const kindOf = (name) => {
  const extension = path.extname(name).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"].includes(extension)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) return "audio";
  throw invalid("MEDIA_TYPE_UNSUPPORTED", "Unsupported local media type");
};

const probe = async (filePath) => {
  const size = (await stat(filePath)).size;
  if (size < 16) throw invalid("MEDIA_PROBE_FAILED", "Media could not be inspected");
  const kind = kindOf(filePath);
  return { path: filePath, kind, duration_us: kind === "image" ? 86_400_000_000 : 3_000_000, width: kind === "audio" ? null : 1280, height: kind === "audio" ? null : 720, audio: kind !== "image", video: kind !== "audio" };
};

/** 只实现会话流程用到的几个方法、行为照 JianYingAPI 的内存版工程库。 */
function memoryStore() {
  const projects = new Map();
  let counter = 0;
  const get = (id) => {
    const project = projects.get(id);
    if (!project) throw new EditError("PROJECT_NOT_FOUND", "Project does not exist", { status: 404 });
    return structuredClone(project);
  };
  const save = (project) => {
    project.revision += 1;
    projects.set(project.id, structuredClone(project));
    return structuredClone(project);
  };
  return {
    projects,
    async createProject({ name, canvas }) {
      for (const key of ["width", "height", "fps"]) {
        if (!Number.isInteger(canvas[key]) || canvas[key] < 1 || canvas[key] > 7680) throw invalid("VALIDATION_ERROR", `canvas.${key} is invalid`);
      }
      const project = { id: String(++counter).padStart(32, "0"), name, canvas, created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z", revision: 1, tracks: [], markers: [], draft: null };
      projects.set(project.id, project);
      return structuredClone(project);
    },
    async getProject(id) { return get(id); },
    async deleteProject(id) { get(id); projects.delete(id); },
    async updateProject(id, { name }) { return save({ ...get(id), name }); },
    async createTrack(id, { track_type: type, name }) {
      const project = get(id);
      project.tracks.push({ id: `track${project.tracks.length + 1}`, track_type: type, name: name ?? type, mute: false, segments: [] });
      return save(project);
    },
    async addMediaSegment(id, trackId, request) {
      const project = get(id);
      const track = project.tracks.find((item) => item.id === trackId);
      if (!track) throw invalid("TRACK_NOT_FOUND", "Track does not exist");
      track.segments.push({ id: `seg${++counter}`, kind: kindOf(request.path), path: request.path, timeline: request.timeline, source: request.source ?? { start_us: 0, duration_us: request.timeline.duration_us }, material_name: request.material_name });
      return save(project);
    },
    async deleteSegment(id, segmentId) {
      const project = get(id);
      for (const track of project.tracks) track.segments = track.segments.filter((segment) => segment.id !== segmentId);
      return save(project);
    },
    async mediaInfos(project) {
      return [...new Set(project.tracks.flatMap((track) => track.segments.map((segment) => segment.path)))].map((item) => ({ path: item }));
    },
  };
}

function fakeDraftBox(overrides = {}) {
  let counter = 0;
  return {
    status: vi.fn(() => ({ status: "available", reason: null, platform: "mac", jianyingRunning: false, draftsRoot: "/drafts" })),
    createDraft: vi.fn(async ({ draftName }) => ({ draftId: `0000000${++counter}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`, draftName, path: `/drafts/${draftName}` })),
    repairDraft: vi.fn(async ({ project, draftId }) => ({ draftId, draftName: project.name, path: `/drafts/${project.name}` })),
    ...overrides,
  };
}

// ---------- 假的模型接口 ----------

function sse(chunks) {
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
const textReply = (text) => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
const toolReply = (calls) => sse([
  { choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: `call_${index}_${call.name}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
]);
const lastToolResult = (body) => JSON.parse(body.messages.filter((message) => message.role === "tool").at(-1).content);

/** 起一个和采集器一样接线的小服务：配对校验前后各调一次 handle。 */
async function start({ real = false, store = real ? undefined : memoryStore(), draftBox = fakeDraftBox(), fetchImpl, collector = null, dataDirectory, ...options } = {}) {
  const directory = dataDirectory ?? await temporaryDirectory("ai-edit-index-");
  // real：工程库和媒体探测都用模块 B、C 的真实实现
  const fakes = real ? {} : { probe, kindOf };
  const aiEdit = createAiEdit({ dataDirectory: directory, store, draftBox, fetchImpl, ...fakes, getCollector: () => collector, pollMs: 10, ...options });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (await aiEdit.handle(request, response, url)) return;
    if (request.headers.authorization !== "Bearer ok") { response.writeHead(401).end(JSON.stringify({ error: "not_paired" })); return; }
    if (await aiEdit.handle(request, response, url, { paired: true })) return;
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    await aiEdit.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = async (pathname, { method = "GET", body, headers = {}, raw = false } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { Authorization: "Bearer ok", ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    });
    if (raw) return response;
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // 按截止时间等，不按次数：并行跑测试时机器忙，轮询会慢
  const until = async (read, done, what) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`${what} never settled`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const waitIdle = (id) => until(async () => (await call(`/v1/ai-edit/sessions/${id}`)).body, (body) => body.session.status !== "running", "session");
  const settle = (id) => until(async () => (await call("/v1/ai-edit/media")).body.media.find((entry) => entry.id === id), (item) => item.status !== "importing", "media");
  return { aiEdit, base, call, waitIdle, settle, until, directory, store, draftBox };
}

async function uploadFixture(call, name, as = name) {
  const bytes = new Uint8Array(await readFile(path.join(FIXTURES, name)));
  return call(`/v1/ai-edit/media/upload?name=${encodeURIComponent(as)}`, { method: "POST", body: bytes, headers: { "Content-Type": "application/octet-stream" } });
}

// ---------- 测试 ----------

describe("AI edit sessions", () => {
  it("creates, lists, long-polls and deletes sessions together with their projects", async () => {
    const { call, store, base } = await start();
    expect((await fetch(`${base}/v1/ai-edit/sessions`)).status).toBe(401);
    const created = await call("/v1/ai-edit/sessions", { method: "POST", body: {} });
    expect(created.status).toBe(201);
    const { session, project } = created.body;
    expect(project).toMatchObject({ name: "未命名剪辑", canvas: { width: 1080, height: 1920, fps: 30 } });
    expect(session).toMatchObject({ title: "未命名剪辑", status: "idle", projectId: project.id, draftBox: null, revision: 1, error: null, messages: [], streaming: null });
    const wide = await call("/v1/ai-edit/sessions", { method: "POST", body: { title: "横屏", canvas: { width: 1920, height: 1080 } } });
    expect(wide.body.project.canvas).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect((await call("/v1/ai-edit/sessions", { method: "POST", body: { canvas: { width: 0, height: 10 } } })).body).toMatchObject({ error: "invalid_canvas" });
    expect((await call("/v1/ai-edit/sessions")).body.sessions.map((item) => item.title).sort()).toEqual(["未命名剪辑", "横屏"]);

    // 长轮询：revision 没变就挂着，变了立刻回
    let settled = false;
    const polling = call(`/v1/ai-edit/sessions/${session.id}?afterRevision=${session.revision}`).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    const sent = await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "随便聊聊", config: { ...CONFIG, apiKey: "" } } });
    expect(sent).toMatchObject({ status: 400, body: { error: "invalid_config", message: "先在 AI 剪辑的接口设置里填好 Key 和模型。" } });
    expect(settled).toBe(false);
    expect((await call(`/v1/ai-edit/sessions/${session.id}?afterRevision=x`)).status).toBe(400);
    expect((await call(`/v1/ai-edit/sessions/${"0".repeat(31)}g`)).status).toBe(404);

    expect((await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" })).body).toEqual({ ok: true });
    expect((await polling).status).toBe(404);
    expect(store.projects.has(project.id)).toBe(false);
    expect((await call(`/v1/ai-edit/sessions/${session.id}`)).status).toBe(404);
  }, 20_000);

  it("runs a conversation: tools edit the project, the page sees revisions and a tidy chat", async () => {
    const requests = [];
    let mediaId;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return toolReply([{ name: "create_track", args: { track_type: "video", name: "主轨" } }]);
      if (requests.length === 2) return toolReply([{ name: "add_media_clip", args: { track_id: lastToolResult(body).track_id, media_id: mediaId, duration: 2.5 } }, { name: "add_effect", args: { clip_id: "missing", effect_type: "x" } }]);
      return textReply("加好了一段 2.5 秒的海边画面。");
    };
    const { call, waitIdle } = await start({ fetchImpl });
    mediaId = (await uploadFixture(call, "clip-720p.mp4", "海边.mp4")).body.item.id;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    const sent = await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "把海边那段放进来\n要 2.5 秒", config: CONFIG } });
    expect(sent.status).toBe(202);
    expect(sent.body.session).toMatchObject({ status: "running", title: "把海边那段放进来", messages: [{ role: "user", text: "把海边那段放进来\n要 2.5 秒" }] });

    const done = await waitIdle(session.id);
    expect(done.session).toMatchObject({ status: "idle", error: null, streaming: null });
    expect(done.session.revision).toBeGreaterThan(session.revision + 3);
    const assistant = done.session.messages.find((item) => item.role === "assistant");
    expect(assistant).toMatchObject({
      text: "加好了一段 2.5 秒的海边画面。",
      actions: [
        { name: "create_track", summary: "新建了视频轨道", ok: true },
        { name: "add_media_clip", summary: "加了视频片段「海边.mp4」", ok: true },
        { name: "add_effect", summary: "加了特效「x」", ok: false, error: expect.any(String) },
      ],
    });
    expect(done.project.name).toBe("把海边那段放进来");
    expect(done.project.tracks[0].segments[0]).toMatchObject({ timeline: { start_us: 0, duration_us: 2_500_000 }, material_name: "海边.mp4" });
    expect(done.project.tracks[0].segments[0].path.endsWith(`${mediaId}.mp4`)).toBe(true);
    // 系统提示里有画布和素材；当前时间线附在每次请求的最后一条，系统提示在一轮里不变（接口的前缀缓存才命中得了）
    expect(requests[0].messages[0].content).toContain(`${mediaId}｜视频｜海边.mp4｜3 秒`);
    expect(requests[0].thinking).toEqual({ type: "disabled" });
    expect(requests[2].messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("\"track_id\":\"track1\"") });
    expect(requests[0].messages.at(-1).content).toContain("当前总时长 0 秒");
    expect(requests[2].messages[0]).toEqual(requests[0].messages[0]);
    // 给模型的历史不发给页面
    expect(done.session).not.toHaveProperty("history");
  }, 20_000);

  it("streams text into the session and stops cleanly", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "我先看看素材" } }] })}\n\n`));
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const { call } = await start({ fetchImpl });
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: { title: "停一下" } })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "剪", config: CONFIG } });
    let current = (await call(`/v1/ai-edit/sessions/${session.id}`)).body.session;
    for (let attempt = 0; attempt < 50 && !current.streaming?.text; attempt += 1) {
      current = (await call(`/v1/ai-edit/sessions/${session.id}?afterRevision=${current.revision}`)).body.session;
    }
    expect(current.streaming).toEqual({ text: "我先看看素材", actions: [] });
    expect(current.title).toBe("停一下");
    expect(await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "再来", config: CONFIG } })).toMatchObject({ status: 409, body: { error: "session_busy" } });
    expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toMatchObject({ status: 409, body: { error: "session_busy" } });
    const stopped = await call(`/v1/ai-edit/sessions/${session.id}/stop`, { method: "POST", body: {} });
    expect(stopped.body.session).toMatchObject({ status: "idle", streaming: null, error: null });
    expect(stopped.body.session.messages.at(-1)).toMatchObject({ role: "assistant", text: "我先看看素材\n\n（已停止）" });
  }, 20_000);

  it("shows provider failures on the session", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const { call, waitIdle } = await start({ fetchImpl });
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "hi", config: CONFIG } });
    const done = await waitIdle(session.id);
    expect(done.session).toMatchObject({ status: "failed", error: { code: "provider_error", message: "接口 Key 不对或没有权限：bad key" } });
  }, 20_000);

  it("marks a turn that was running when the collector died as failed after a restart", async () => {
    const dataDirectory = await temporaryDirectory("ai-edit-restart-");
    const hanging = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const first = await start({ dataDirectory, fetchImpl: hanging });
    const { session } = (await first.call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await first.call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "hi", config: CONFIG } });
    // 不调 close，模拟采集器直接被杀掉：第二个实例读同一个目录
    const second = await start({ dataDirectory, fetchImpl: hanging, store: first.store });
    const { body } = await second.call(`/v1/ai-edit/sessions/${session.id}`);
    expect(body.session).toMatchObject({ status: "failed", error: { code: "interrupted" }, streaming: null });
    expect(body.session.messages.map((item) => item.role)).toEqual(["user"]);
  }, 20_000);
});

describe("AI edit media library", () => {
  it("streams uploads to disk and serves them with Range support behind the key", async () => {
    const { call, base, directory } = await start();
    const uploaded = await uploadFixture(call, "clip-720p.mp4", "我的 视频.MP4");
    expect(uploaded.status).toBe(201);
    const { item } = uploaded.body;
    expect(item).toMatchObject({ name: "我的 视频.MP4", kind: "video", status: "ready", durationUs: 3_000_000, width: 1280, height: 720, hasAudio: true, size: 236_085, source: { type: "local" } });
    expect(item).not.toHaveProperty("file");
    const original = await readFile(path.join(FIXTURES, "clip-720p.mp4"));
    expect(await readFile(path.join(directory, "ai-edit", "media", `${item.id}.mp4`))).toEqual(original);
    expect((await readdir(path.join(directory, "ai-edit", "media"))).sort()).toEqual([`${item.id}.mp4`, "index.json"]);

    const listed = (await call("/v1/ai-edit/media")).body;
    expect(listed.media).toEqual([item]);
    const fileUrl = `${base}/v1/ai-edit/media/${item.id}/file?key=${encodeURIComponent(listed.key)}`;
    // 不带 Bearer 也能取，但 key 必须对
    expect((await fetch(`${base}/v1/ai-edit/media/${item.id}/file?key=wrong`)).status).toBe(404);
    expect((await fetch(`${base}/v1/ai-edit/media/${item.id}/file`)).status).toBe(404);
    const full = await fetch(fileUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(original);
    const part = await fetch(fileUrl, { headers: { Range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${original.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(original.subarray(100, 200));
    const tail = await fetch(fileUrl, { headers: { Range: "bytes=-10" } });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(original.subarray(-10));
    const open = await fetch(fileUrl, { headers: { Range: `bytes=${original.length - 5}-` } });
    expect(open.headers.get("content-range")).toBe(`bytes ${original.length - 5}-${original.length - 1}/${original.length}`);
    const beyond = await fetch(fileUrl, { headers: { Range: `bytes=${original.length}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${original.length}`);

    const unsupported = await call("/v1/ai-edit/media/upload?name=notes.txt", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(unsupported).toMatchObject({ status: 422, body: { error: "media_type_unsupported" } });
    const broken = await call("/v1/ai-edit/media/upload?name=bad.mp4", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(broken).toMatchObject({ status: 422, body: { error: "media_unreadable" } });
    expect((await readdir(path.join(directory, "ai-edit", "media"))).sort()).toEqual([`${item.id}.mp4`, "index.json"]);
  }, 20_000);

  it("refuses uploads over the limit without keeping a partial file", async () => {
    const { base, directory } = await start({ maxUploadBytes: 1_000 });
    // 声明的长度超限：不收请求体，直接 413
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/v1/ai-edit/media/upload?name=big.mp4`, { method: "POST", headers: { Authorization: "Bearer ok", "Content-Type": "application/octet-stream", "Content-Length": 5_000 } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.write(Buffer.alloc(100));
    });
    expect(status).toBe(413);
    // 没声明长度、边传边超：写到一半就停，临时文件删掉
    const library = new MediaLibrary({ directory: path.join(directory, "ai-edit", "media"), probe, kindOf, maxUploadBytes: 1_000 });
    await library.load();
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(400, 1));
    await expect(library.upload(Readable.from(chunks), "big.mp4")).rejects.toMatchObject({ code: "media_too_large", status: 413 });
    expect(await readdir(path.join(directory, "ai-edit", "media"))).toEqual([]);
  }, 20_000);

  it("imports a video from the content library through the collector's download", async () => {
    const downloads = await temporaryDirectory("ai-edit-downloads-");
    const jobs = new Map();
    let polls = 0;
    const collector = {
      startVideoDownload: vi.fn((url) => {
        const id = `job-${jobs.size + 1}`;
        const failing = url.endsWith("/2");
        const note = url.endsWith("/3");
        jobs.set(id, { id, url, failing, note });
        return { id, status: "queued" };
      }),
      getVideoDownloadJob: (id) => {
        const job = jobs.get(id);
        polls += 1;
        if (polls % 3) return { id, status: "running" };
        if (job.failing) return { id, status: "failed", error: "作品已删除，下载不了。" };
        return { id, status: "complete", video: { videoId: "1", title: "下载到的标题", author: "作者甲", cover: "https://p3.douyinpic.com/c.jpg" } };
      },
      getVideoDownloadFilePath: (id) => path.join(downloads, jobs.get(id).note ? "note.zip" : "video.mp4"),
    };
    await copyFile(path.join(FIXTURES, "clip-720p.mp4"), path.join(downloads, "video.mp4"));
    await copyFile(path.join(FIXTURES, "still.png"), path.join(downloads, "note.zip"));
    const { call, directory, settle, until } = await start({ collector });

    const started = await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/1", author: "作者甲", durationSeconds: 3 } });
    expect(started.status).toBe(202);
    expect(started.body.item).toMatchObject({ name: "抖音视频", status: "importing", kind: "video", durationUs: 3_000_000, source: { type: "douyin", url: "https://www.douyin.com/video/1", author: "作者甲" } });
    const id = started.body.item.id;
    // 同一条链接再导入直接用那条
    expect((await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/1" } })).body.item.id).toBe(id);
    expect(collector.startVideoDownload).toHaveBeenCalledTimes(1);
    expect(await settle(id)).toMatchObject({ status: "ready", name: "下载到的标题", size: 236_085, source: { title: "下载到的标题", videoId: "1", cover: "https://p3.douyinpic.com/c.jpg" } });
    expect((await stat(path.join(directory, "ai-edit", "media", `${id}.mp4`))).size).toBe(236_085);

    const failed = (await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/2", title: "会失败" } })).body.item;
    const note = (await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/3" } })).body.item;
    expect(await settle(failed.id)).toMatchObject({ status: "failed", error: "作品已删除，下载不了。", name: "会失败" });
    expect(await settle(note.id)).toMatchObject({ status: "failed", error: "图文作品暂不能当素材。" });
    // 状态先变、素材清单后存盘（先写 .tmp 再改名），等存完再看目录
    const names = await until(() => readdir(path.join(directory, "ai-edit", "media")), (list) => !list.some((name) => name.endsWith(".tmp")), "media index");
    expect(names.sort()).toEqual([`${id}.mp4`, "index.json"]);

    expect((await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://example.com/video/1" } })).body).toMatchObject({ error: "invalid_url" });
    expect((await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/9", mediaType: "image" } })).body).toMatchObject({ error: "not_video", message: "图文作品暂不能当素材。" });
  }, 20_000);

  it("says the collector is busy when it cannot download", async () => {
    const { call } = await start({ collector: null });
    expect(await call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/1" } })).toMatchObject({ status: 409, body: { error: "collector_busy" } });
    const refusing = await start({ collector: { startVideoDownload: () => { throw Object.assign(new Error("采集器正在执行其他任务，请稍后再试。"), { code: "collector_busy" }); } } });
    expect(await refusing.call("/v1/ai-edit/media/douyin", { method: "POST", body: { url: "https://www.douyin.com/video/1" } })).toMatchObject({ status: 409, body: { error: "collector_busy", message: "采集器正在执行其他任务，请稍后再试。" } });
  }, 20_000);

  it("keeps media that a project still uses", async () => {
    const { call, store, directory } = await start();
    const { item } = (await uploadFixture(call, "tone.mp3")).body;
    const { session, project } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    const withTrack = await store.createTrack(project.id, { track_type: "audio" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp3`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    expect(await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).toMatchObject({ status: 409, body: { error: "media_in_use" } });
    await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" });
    expect(await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).toEqual({ status: 200, body: { ok: true } });
    expect((await call("/v1/ai-edit/media")).body.media).toEqual([]);
    expect(await readdir(path.join(directory, "ai-edit", "media"))).toEqual(["index.json"]);
    expect((await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).status).toBe(404);
  }, 20_000);
});

/** 素材在工程里存的绝对路径：素材库目录的真实路径（macOS 临时目录多一层 /private）+ 文件名。 */
async function mediaPath(directory, name) {
  return path.join(await realpath(path.join(directory, "ai-edit", "media")), name);
}

describe("AI edit export to Jianying", () => {
  async function prepared(draftBox) {
    const context = await start({ draftBox });
    const { item } = (await uploadFixture(context.call, "clip-720p.mp4")).body;
    const { session, project } = (await context.call("/v1/ai-edit/sessions", { method: "POST", body: { title: "导出测试" } })).body;
    return { ...context, item, session, project };
  }

  it("creates the draft once and updates the same draft afterwards", async () => {
    const draftBox = fakeDraftBox();
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toMatchObject({ status: 422, body: { error: "project_empty" } });
    const media = await mediaPath(directory, `${item.id}.mp4`);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: media, timeline: { start_us: 0, duration_us: 1_000_000 } });

    const first = await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} });
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", draftName: "导出测试", path: "/drafts/导出测试", created: true });
    expect(first.body.session.draftBox).toMatchObject({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", draftName: "导出测试", exportedRevision: 3 });
    expect(draftBox.createDraft).toHaveBeenCalledWith(expect.objectContaining({ draftName: "导出测试", media: [{ path: media }], project: expect.objectContaining({ id: project.id }) }));

    const second = await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} });
    expect(second.body.result).toMatchObject({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", created: false });
    expect(draftBox.repairDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD" }));
    expect(draftBox.createDraft).toHaveBeenCalledTimes(1);

    // 用户在剪映里删掉了那份草稿：重新建一份
    draftBox.repairDraft.mockRejectedValueOnce(new EditError("DRAFT_BOX_NOT_FOUND", "Draft was not found", { status: 404 }));
    const third = await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} });
    expect(third.body.result).toMatchObject({ draftId: "00000002-AAAA-BBBB-CCCC-DDDDDDDDDDDD", created: true });
    expect((await call("/v1/ai-edit/sessions")).body.sessions[0].draftBox.draftId).toBe("00000002-AAAA-BBBB-CCCC-DDDDDDDDDDDD");
  }, 20_000);

  it("asks to quit Jianying first and reports a missing draft box", async () => {
    const draftBox = fakeDraftBox({
      createDraft: vi.fn(async () => { throw new EditError("DRAFT_BOX_APP_RUNNING", "Close Jianying before adding a draft", { status: 409 }); }),
    });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toEqual({ status: 409, body: { error: "jianying_running", message: "剪映正在运行，请先退出剪映再导入。" } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}`)).body.session.draftBox).toBeNull();

    draftBox.status.mockReturnValue({ status: "unavailable", reason: "drafts_root_unavailable", platform: "mac", jianyingRunning: true });
    expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toMatchObject({ status: 503, body: { error: "draft_box_unavailable" } });
    expect((await call("/v1/ai-edit/draft-box")).body).toEqual({ status: "unavailable", reason: "drafts_root_unavailable", platform: "mac", jianyingRunning: true });
    draftBox.status.mockImplementation(() => { throw new EditError("DRAFT_BOX_INDEX_INVALID", "bad", { status: 500 }); });
    expect((await call("/v1/ai-edit/draft-box")).body).toMatchObject({ status: "unavailable", reason: "draft_box_index_invalid" });
  }, 20_000);

  it("hands back what Jianying refused instead of asking to retry", async () => {
    const draftBox = fakeDraftBox({
      createDraft: vi.fn(async () => { throw invalid("DRAFT_FEATURE_INVALID", "当前片段已存在类型为 'in' 的动画"); }),
    });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    const refused = await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} });
    expect(refused).toMatchObject({ status: 422, body: { error: "draft_invalid", message: expect.stringContaining("当前片段已存在类型为 'in' 的动画") } });
    expect(refused.body.message).not.toContain("稍后重试");
    draftBox.createDraft.mockRejectedValueOnce(invalid("SOURCE_RANGE_INVALID", "截取的素材时间范围超出了素材时长"));
    expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).body.message).toContain("截取的区间超出了素材长度");
    // 真出了意外的才是 500
    draftBox.createDraft.mockRejectedValueOnce(new Error("disk on fire"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toMatchObject({ status: 500, body: { error: "export_failed" } });
    } finally {
      quiet.mockRestore();
    }
  }, 20_000);

  it("keeps media that an exported Windows draft points to, even after the session is deleted", async () => {
    const draftDirectory = await temporaryDirectory("ai-edit-windows-draft-");
    const draftBox = fakeDraftBox({
      profile: { cloneMaterials: false },
      createDraft: vi.fn(async ({ draftName }) => ({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", draftName, path: draftDirectory })),
      repairDraft: vi.fn(async ({ project, draftId }) => ({ draftId, draftName: project.name, path: draftDirectory })),
    });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const other = (await uploadFixture(call, "clip-720p.mp4", "另一段.mp4")).body.item;
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    let current = await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    current = await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${other.id}.mp4`), timeline: { start_us: 1_000_000, duration_us: 1_000_000 } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).status).toBe(200);
    // AI 把第二段从时间线上拿掉了、但还没重新导入：剪映草稿还引用着它
    await store.deleteSegment(project.id, current.tracks[0].segments[1].id);
    expect(await call(`/v1/ai-edit/media/${other.id}`, { method: "DELETE" })).toMatchObject({ status: 409, body: { error: "media_in_draft", message: expect.stringContaining("导出测试") } });
    // 重新导入后草稿不再用它，就能删
    expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).status).toBe(200);
    expect((await call(`/v1/ai-edit/media/${other.id}`, { method: "DELETE" })).status).toBe(200);

    // 删了会话，草稿还在：素材删不得
    await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" });
    expect(await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).toMatchObject({ status: 409, body: { error: "media_in_draft" } });
    expect((await call("/v1/ai-edit/media")).body.media[0]).not.toHaveProperty("drafts");
    // 用户在剪映里删了那份草稿之后才能删素材
    await rm(draftDirectory, { recursive: true, force: true });
    expect(await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).toEqual({ status: 200, body: { ok: true } });
  }, 20_000);

  it("does not hold media for Mac drafts, which carry their own copy", async () => {
    const draftDirectory = await temporaryDirectory("ai-edit-mac-draft-");
    const draftBox = fakeDraftBox({ profile: { cloneMaterials: true }, createDraft: vi.fn(async ({ draftName }) => ({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", draftName, path: draftDirectory })) });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).status).toBe(200);
    await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" });
    expect((await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).status).toBe(200);
  }, 20_000);

  it("lets the model export too", async () => {
    let mediaId;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const tools = body.messages.filter((message) => message.role === "tool").length;
      if (tools === 0) return toolReply([{ name: "create_track", args: { track_type: "video" } }]);
      if (tools === 1) return toolReply([{ name: "add_media_clip", args: { track_id: lastToolResult(body).track_id, media_id: mediaId } }]);
      if (tools === 2) return toolReply([{ name: "export_to_jianying" }]);
      return textReply("已经放进剪映草稿箱了。");
    };
    const draftBox = fakeDraftBox();
    const { call, waitIdle } = await start({ fetchImpl, draftBox });
    mediaId = (await uploadFixture(call, "clip-720p.mp4")).body.item.id;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: { title: "模型导出" } })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "做好导入剪映", config: CONFIG } });
    const done = await waitIdle(session.id);
    expect(done.session.draftBox).toMatchObject({ draftName: "模型导出" });
    expect(done.session.messages.at(-1).actions.at(-1)).toEqual({ name: "export_to_jianying", summary: "导入了剪映草稿箱", ok: true });
    expect(draftBox.createDraft).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("answers the export call after the collector was killed right after exporting", async () => {
    const dataDirectory = await temporaryDirectory("ai-edit-killed-");
    let requests = 0;
    const firstFetch = async (_url, init) => {
      requests += 1;
      if (requests === 1) return toolReply([{ name: "export_to_jianying" }]);
      // 第二次请求一直挂着，这时采集器被杀
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    const first = await start({ dataDirectory, fetchImpl: firstFetch });
    const { item } = (await uploadFixture(first.call, "clip-720p.mp4")).body;
    const { session, project } = (await first.call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    const withTrack = await first.store.createTrack(project.id, { track_type: "video" });
    await first.store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(dataDirectory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    await first.call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "导出", config: CONFIG } });
    const file = path.join(dataDirectory, "ai-edit", "sessions", `${session.id}.json`);
    const pending = async () => JSON.parse(await readFile(file, "utf8")).history.map((entry) => entry.role);
    // 导入剪映时会话中途存过盘：history 停在还没回结果的工具调用上
    for (const deadline = Date.now() + 10_000; requests < 2 || (await pending()).at(-1) !== "assistant";) {
      if (Date.now() > deadline) throw new Error("export never persisted");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    let sent = null;
    const second = await start({ dataDirectory, store: first.store, fetchImpl: async (_url, init) => { sent ??= JSON.parse(init.body); return textReply("好的"); } });
    await second.call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "接着来", config: CONFIG } });
    await second.waitIdle(session.id);
    const calls = sent.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.id);
    const answered = sent.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
    expect(calls).toEqual(["call_0_export_to_jianying"]);
    expect(answered).toEqual(calls);
    // 最后一条是自动附上的工程现状
    expect(sent.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user", "user"]);
  }, 20_000);
});

// 模块 A/B/C/D 都在时，用真实的工程库、媒体探测和草稿箱把整条链路跑一遍
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_MODULES = ["projectStore.mjs", "media.mjs", "draft.mjs", "draftBox.mjs"].every((name) => existsSync(path.join(HERE, name)));

describe.runIf(REAL_MODULES)("AI edit with the real project store and draft box", () => {
  it("edits a timeline through the model and writes a Jianying draft, then updates the same draft", async () => {
    const { createDraftBox } = await import("./draftBox.mjs");
    const draftsRoot = await temporaryDirectory("ai-edit-jianying-");
    let jianyingRunning = false;
    const draftBox = createDraftBox({ platform: "darwin", env: { JY_JIANYING_DRAFTS_ROOT: draftsRoot }, home: draftsRoot, isJianyingRunning: () => jianyingRunning });
    const ids = {};
    const results = (body) => body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
    const requests = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const done = results(body);
      switch (requests.length) {
        case 1:
          return toolReply([
            { name: "search_catalog", args: { kind: "transition", query: "叠化" } },
            { name: "create_track", args: { track_type: "video", name: "主画面" } },
            { name: "create_track", args: { track_type: "audio", name: "配乐" } },
            { name: "create_track", args: { track_type: "text", name: "标题" } },
          ]);
        case 2:
          [ids.video, ids.audio, ids.text] = done.slice(1, 4).map((result) => result.track_id);
          return toolReply([
            { name: "add_media_clip", args: { track_id: ids.video, media_id: ids.clip, duration: 2, source_start: 0.5 } },
            { name: "add_media_clip", args: { track_id: ids.video, media_id: ids.still, duration: 1.5 } },
            { name: "add_media_clip", args: { track_id: ids.audio, media_id: ids.tone, start: 0, duration: 3.5 } },
            { name: "add_text_clip", args: { track_id: ids.text, text: "海边的一天", start: 0.2, duration: 2, font_size: 12, transform: { transform_y: 0.6 } } },
          ]);
        case 3:
          [ids.first, ids.second, ids.music, ids.title] = done.slice(4, 8).map((result) => result.clip_id);
          return toolReply([
            { name: "add_transition", args: { clip_id: ids.first, transition_type: "叠化", duration: 0.5 } },
            { name: "add_fade", args: { clip_id: ids.music, fade_in: 0.5, fade_out: 1 } },
            { name: "add_keyframes", args: { clip_id: ids.second, keyframes: [{ property: "uniform_scale", offset: 0, value: 1 }, { property: "uniform_scale", offset: 1.5, value: 1.2 }] } },
            { name: "add_animation", args: { clip_id: ids.title, animation_type: "冲屏位移" } },
            { name: "add_effect", args: { clip_id: ids.first, effect_type: "不存在的特效" } },
          ]);
        case 4:
          return toolReply([{ name: "get_timeline" }, { name: "export_to_jianying" }]);
        default:
          return textReply("剪好了：2 秒海边画面接 1.5 秒照片，配了音乐和标题，已经放进剪映草稿箱。");
      }
    };
    const { call, waitIdle } = await start({ real: true, fetchImpl, draftBox });
    ids.clip = (await uploadFixture(call, "clip-720p.mp4", "海边.mp4")).body.item.id;
    ids.still = (await uploadFixture(call, "still.png", "照片.png")).body.item.id;
    ids.tone = (await uploadFixture(call, "tone.mp3", "配乐.mp3")).body.item.id;
    expect((await call("/v1/ai-edit/media")).body.media.find((item) => item.id === ids.tone)).toMatchObject({ kind: "audio", durationUs: expect.any(Number), hasAudio: true });
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: { title: "海边" } })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "剪一个海边小片", config: CONFIG } });
    const done = await waitIdle(session.id);
    const actions = done.session.messages.at(-1).actions;
    expect(actions.filter((action) => !action.ok).map((action) => action.name)).toEqual(["add_effect"]);
    expect(done.session).toMatchObject({ status: "idle", error: null, draftBox: { draftName: "海边" } });

    const timeline = results(requests[4]).at(-2);
    expect(timeline).toMatchObject({ ok: true, duration: 3.5, tracks: [{ type: "video", clips: [{ start: 0, duration: 2, source_start: 0.5, transition: { duration: 0.5 } }, { start: 2, duration: 1.5, keyframes: 2 }] }, { type: "audio" }, { type: "text" }] });
    expect(results(requests[4]).at(-1)).toEqual({ ok: true, draft_name: "海边", created: true });
    const project = done.project;
    expect(project.tracks[0].segments[0]).toMatchObject({ timeline: { start_us: 0, duration_us: 2_000_000 }, source: { start_us: 500_000, duration_us: 2_000_000 }, material_name: "海边.mp4" });
    expect(project.tracks[1].segments[0].fade).toEqual({ in_duration_us: 500_000, out_duration_us: 1_000_000 });

    const { draftId } = done.session.draftBox;
    const index = JSON.parse(await readFile(path.join(draftsRoot, "root_meta_info.json"), "utf8"));
    const entry = index.all_draft_store.find((item) => item.draft_id === draftId);
    expect(entry).toBeTruthy();
    const draftFolder = path.dirname(entry.draft_json_file);
    expect(existsSync(path.join(draftFolder, "draft_info.json"))).toBe(true);
    const content = JSON.parse(await readFile(path.join(draftFolder, "draft_info.json"), "utf8"));
    expect(content.duration).toBe(3_500_000);
    const materialPaths = content.materials.videos.map((video) => video.path);
    expect(materialPaths.every((item) => item.startsWith(path.join(draftFolder, "materials")))).toBe(true);

    // 再导一次是原位更新同一份
    const again = await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} });
    expect(again.status).toBe(200);
    expect(again.body.result).toMatchObject({ draftId, created: false });
    expect(JSON.parse(await readFile(path.join(draftsRoot, "root_meta_info.json"), "utf8")).all_draft_store).toHaveLength(1);

    jianyingRunning = true;
    expect(await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).toMatchObject({ status: 409, body: { error: "jianying_running" } });
    expect((await call("/v1/ai-edit/draft-box")).body).toMatchObject({ status: "available", platform: "mac", jianyingRunning: true });

    // 工程用着的素材不能删
    expect((await call(`/v1/ai-edit/media/${ids.tone}`, { method: "DELETE" })).body.error).toBe("media_in_use");
  }, 20_000);
});
