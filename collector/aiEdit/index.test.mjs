import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalAi } from "../localAi.mjs";
import { EditError, invalid } from "./errors.mjs";
import { createAiEdit } from "./index.mjs";
import { MediaLibrary } from "./library.mjs";
import { ProjectStore } from "./projectStore.mjs";

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

describe("AI edit help from the open page", () => {
  it("hangs a beat job on the running turn, serves the clip to the page and resumes with its answer", async () => {
    const requests = [];
    const ids = {};
    const fetchImpl = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return requests.length === 1 ? toolReply([{ name: "detect_beats", args: { media_id: ids.tone } }]) : textReply("测好了");
    };
    const { call, base, until, waitIdle } = await start({ fetchImpl });
    ids.tone = (await uploadFixture(call, "tone.mp3", "配乐.mp3")).body.item.id;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "测一下配乐的节拍", config: CONFIG } });
    const look = await until(async () => (await call(`/v1/ai-edit/sessions/${session.id}`)).body.session.streaming?.look, Boolean, "look job");
    expect(look).toMatchObject({ kind: "beats", url: `/v1/ai-edit/media/${ids.tone}/file`, name: "配乐.mp3" });
    // 应用开着就能接：不在 AI 剪辑页面时，最外层每 3 秒问一次待拆的活儿（地址带好素材 key）
    const pending = (await call("/v1/ai-edit/looks")).body.looks;
    expect(pending).toEqual([{ sessionId: session.id, look: expect.objectContaining({ id: look.id, url: expect.stringMatching(new RegExp(`^/v1/ai-edit/media/${ids.tone}/file\\?key=.+`, "u")) }) }]);
    expect((await fetch(`${base}/v1/ai-edit/looks`)).status).toBe(401);
    // 页面用素材库的 key 取文件（和看板取缩略图一样，不用配对）
    const { key } = (await call("/v1/ai-edit/media")).body;
    expect((await fetch(`${base}${look.url}?key=${key}`)).status).toBe(200);
    expect((await call(`/v1/ai-edit/sessions/${session.id}/look/${"0".repeat(16)}`, { method: "POST", body: {} })).status).toBe(404);
    expect((await fetch(`${base}/v1/ai-edit/sessions/${session.id}/look/${look.id}`, { method: "POST", body: "{}" })).status).toBe(401);
    const answered = await call(`/v1/ai-edit/sessions/${session.id}/look/${look.id}`, { method: "POST", body: { duration: 3, audio: true, beats: { bpm: 120, beats: [0.5, 1, 1.5], strong: [1] } } });
    expect(answered.body).toEqual({ ok: true });
    const done = await waitIdle(session.id);
    expect(done.session).toMatchObject({ status: "idle", streaming: null });
    expect(lastToolResult(requests[1])).toMatchObject({ ok: true, bpm: 120, beats: [0.5, 1, 1.5], strong: [1] });
  }, 20_000);

  it("probes whether the configured model can watch video", async () => {
    const fetchImpl = async () => Response.json({ choices: [{ message: { content: "386" }, finish_reason: "stop" }] });
    const { call } = await start({ fetchImpl });
    expect((await call("/v1/ai-edit/probe-video", { method: "POST", body: { config: CONFIG } })).body).toEqual({ videoInput: true, answer: "386" });
    expect((await call("/v1/ai-edit/probe-video", { method: "POST", body: { config: { ...CONFIG, apiKey: "" } } })).body).toMatchObject({ error: "invalid_config" });
  });
});

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

  it("lets the user set and change the goal, which every model request carries in its system prompt", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const { call, waitIdle, directory } = await start({ fetchImpl });
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    expect(session.goal).toBe("");
    const set = await call(`/v1/ai-edit/sessions/${session.id}/goal`, { method: "POST", body: { goal: "  30 秒旅行卡点快闪，用「放空」这首歌  " } });
    expect(set).toMatchObject({ status: 200, body: { session: { goal: "30 秒旅行卡点快闪，用「放空」这首歌" } } });
    expect(set.body.session.revision).toBeGreaterThan(session.revision);
    // 还没发消息就已经存盘了（采集器这时重启，目标也还在）
    const stored = async () => JSON.parse(await readFile(path.join(directory, "ai-edit", "sessions", `${session.id}.json`), "utf8")).goal;
    expect(await stored()).toBe("30 秒旅行卡点快闪，用「放空」这首歌");
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "开始剪", config: CONFIG } });
    await waitIdle(session.id);
    expect(requests[0].messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("\n30 秒旅行卡点快闪，用「放空」这首歌\n") });
    // 改了目标，下一次请求就是新的
    await call(`/v1/ai-edit/sessions/${session.id}/goal`, { method: "POST", body: { goal: "改成 15 秒" } });
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "再来", config: CONFIG } });
    await waitIdle(session.id);
    expect(requests[1].messages[0].content).toContain("\n改成 15 秒\n");
    expect(requests[1].messages[0].content).not.toContain("放空");
    // 存盘了；太长不收；清空就是删掉
    expect(await stored()).toBe("改成 15 秒");
    expect(await call(`/v1/ai-edit/sessions/${session.id}/goal`, { method: "POST", body: { goal: "长".repeat(2_001) } })).toMatchObject({ status: 400, body: { error: "goal_too_long" } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}/goal`, { method: "POST", body: { goal: "" } })).body.session.goal).toBe("");
    expect(await stored()).toBe("");
    expect((await call(`/v1/ai-edit/sessions/${"0".repeat(32)}/goal`, { method: "POST", body: { goal: "x" } })).status).toBe(404);
  }, 20_000);

  it("switches the canvas from the board, but not while the AI is editing", async () => {
    let release;
    const fetchImpl = async () => { await new Promise((resolve) => { release = resolve; }); return textReply("好"); };
    const { call, waitIdle } = await start({ real: true, fetchImpl });
    const { session, project } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    expect(project.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    const wide = await call(`/v1/ai-edit/sessions/${session.id}/canvas`, { method: "POST", body: { width: 1920, height: 1080 } });
    expect(wide).toMatchObject({ status: 200, body: { project: { canvas: { width: 1920, height: 1080, fps: 30 } } } });
    expect(wide.body.session.revision).toBeGreaterThan(session.revision);
    expect(await call(`/v1/ai-edit/sessions/${session.id}/canvas`, { method: "POST", body: { width: 0, height: 1080 } })).toMatchObject({ status: 422, body: { error: "invalid_canvas" } });
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "剪", config: CONFIG } });
    expect(await call(`/v1/ai-edit/sessions/${session.id}/canvas`, { method: "POST", body: { width: 1080, height: 1080 } })).toMatchObject({ status: 409, body: { error: "session_busy" } });
    for (let i = 0; i < 100 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await waitIdle(session.id);
    expect((await call(`/v1/ai-edit/sessions/${session.id}/canvas`, { method: "POST", body: { width: 1080, height: 1080 } })).body.project.canvas).toEqual({ width: 1080, height: 1080, fps: 30 });
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
    // 给模型的历史不发给页面：页面上的 history 是操作历史（撤销用的存档）
    expect(done.session.history).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/u), kind: "turn", label: "AI 处理“把海边那段放进来 要 2”之前", at: expect.any(String) }]);
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

  it("checks whether the draft was opened or changed in Jianying before updating it, and lets the user save a new one or overwrite", async () => {
    let print = "v1";
    const draftBox = fakeDraftBox({ fingerprint: vi.fn(async () => print), getDraft: vi.fn(async () => { throw new Error("没用到"); }) });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    const exportAs = (body) => call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body });

    expect((await exportAs({})).body.session.draftBox).toMatchObject({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", fingerprint: "v1" });
    // 没动过：照旧原位更新
    expect((await exportAs({ mode: "auto" })).body.result).toMatchObject({ created: false });
    expect(draftBox.repairDraft).toHaveBeenCalledTimes(1);

    // 用户在剪映里打开改过：什么都不写，让用户选
    print = "v2";
    expect(await exportAs({})).toEqual({ status: 409, body: { error: "draft_changed", message: "剪映里的「导出测试」在上次导入后被打开或改过。" } });
    expect(draftBox.repairDraft).toHaveBeenCalledTimes(1);
    expect(draftBox.createDraft).toHaveBeenCalledTimes(1);
    // 覆盖：不比对，直接原位更新，记下新的指纹
    const overwritten = await exportAs({ mode: "update" });
    expect(overwritten.body.result).toMatchObject({ draftId: "00000001-AAAA-BBBB-CCCC-DDDDDDDDDDDD", created: false });
    expect(overwritten.body.session.draftBox.fingerprint).toBe("v2");
    expect(draftBox.repairDraft).toHaveBeenCalledTimes(2);
    // 另存：旧草稿不碰，新建一份，会话改指向新的
    print = "v3";
    const saved = await exportAs({ mode: "new" });
    expect(saved.body.result).toMatchObject({ draftId: "00000002-AAAA-BBBB-CCCC-DDDDDDDDDDDD", draftName: "导出测试", created: true });
    expect(saved.body.session.draftBox).toMatchObject({ draftId: "00000002-AAAA-BBBB-CCCC-DDDDDDDDDDDD", fingerprint: "v3" });
    expect(draftBox.repairDraft).toHaveBeenCalledTimes(2);
    expect(await exportAs({ mode: "replace" })).toMatchObject({ status: 422, body: { error: "invalid_request" } });

    // 剪映里删掉了那份草稿：照旧新建
    draftBox.fingerprint.mockRejectedValueOnce(new EditError("DRAFT_BOX_NOT_FOUND", "Draft was not found", { status: 404 }));
    draftBox.repairDraft.mockRejectedValueOnce(new EditError("DRAFT_BOX_NOT_FOUND", "Draft was not found", { status: 404 }));
    expect((await exportAs({})).body.result).toMatchObject({ draftId: "00000003-AAAA-BBBB-CCCC-DDDDDDDDDDDD", created: true });
  }, 20_000);

  it("compares the index time with the export time for sessions exported before fingerprints", async () => {
    let modified = null;
    const draftBox = fakeDraftBox({
      // 第一次导出时算不出指纹，等于加指纹之前导出的会话
      fingerprint: vi.fn(async () => "v1").mockRejectedValueOnce(new Error("算不出")),
      getDraft: vi.fn(async () => { if (!modified) throw new Error("读不出索引"); return { ok: true, draft: { modified_at: modified } }; }),
    });
    const { call, store, session, project, directory, item } = await prepared(draftBox);
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    const exportAs = (body) => call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body });
    const first = (await exportAs({})).body.session.draftBox;
    expect(first).not.toHaveProperty("fingerprint");
    const exportedAt = Date.parse(first.exportedAt);
    // 索引里的修改时间比导出晚 1 分钟：在剪映里动过
    modified = new Date(exportedAt + 60_000).toISOString();
    expect(await exportAs({})).toMatchObject({ status: 409, body: { error: "draft_changed" } });
    // 只晚几秒（导出时自己写的）不算；这次导完就有指纹了
    modified = new Date(exportedAt + 5_000).toISOString();
    expect((await exportAs({})).body.session.draftBox).toMatchObject({ draftId: first.draftId, fingerprint: "v1" });
    expect(draftBox.repairDraft).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("lets the model pass the user's choice when the draft was changed in Jianying", async () => {
    let print = "v1";
    const draftBox = fakeDraftBox({ fingerprint: vi.fn(async () => print) });
    const requests = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const tools = body.messages.filter((message) => message.role === "tool").length;
      if (tools === 0) return toolReply([{ name: "export_to_jianying" }]);
      if (tools === 1) return toolReply([{ name: "export_to_jianying", args: { mode: "new" } }]);
      return textReply("另存了一份新草稿。");
    };
    const context = await start({ draftBox, fetchImpl });
    const { call, store, directory, waitIdle } = context;
    const { item } = (await uploadFixture(call, "clip-720p.mp4")).body;
    const { session, project } = (await call("/v1/ai-edit/sessions", { method: "POST", body: { title: "模型另存" } })).body;
    const withTrack = await store.createTrack(project.id, { track_type: "video" });
    await store.addMediaSegment(project.id, withTrack.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, { method: "POST", body: {} })).status).toBe(200);
    print = "v2";
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "另存一份新的", config: CONFIG } });
    const done = await waitIdle(session.id);
    expect(lastToolResult(requests[1])).toMatchObject({ ok: false, code: "draft_changed", message: expect.stringContaining("先问用户") });
    expect(lastToolResult(requests[2])).toEqual({ ok: true, draft_name: "模型另存", created: true });
    expect(done.session.draftBox).toMatchObject({ draftId: "00000002-AAAA-BBBB-CCCC-DDDDDDDDDDDD", fingerprint: "v2" });
    expect(done.session.messages.at(-1).actions.map((action) => [action.summary, action.ok])).toEqual([["导入了剪映草稿箱", false], ["另存了一份剪映草稿", true]]);
    expect(requests[0].messages[0].content).toContain("返回 draft_changed");
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

// ---------- 看板手动剪、存档撤销退回、框选 ----------

/** 真实的工程库（看板上的改动要走它的校验），媒体探测用上面的假探测。 */
async function startBoard(options = {}) {
  const dataDirectory = await temporaryDirectory("ai-edit-board-");
  const store = new ProjectStore({ directory: path.join(dataDirectory, "ai-edit", "projects"), probe });
  return start({ dataDirectory, store, ...options });
}

/** 一个会话：视频轨上一段 1 秒的「海边.mp4」，文字轨上一句「周末去海边」。 */
async function boardSession({ call, store, directory }, title = "看板") {
  const { item } = (await uploadFixture(call, "clip-720p.mp4", "海边.mp4")).body;
  const { session, project } = (await call("/v1/ai-edit/sessions", { method: "POST", body: { title } })).body;
  let current = await store.createTrack(project.id, { track_type: "video", name: "主画面" });
  current = await store.addMediaSegment(project.id, current.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 0, duration_us: 1_000_000 }, material_name: "海边.mp4" });
  current = await store.createTrack(project.id, { track_type: "text", name: "标题" });
  current = await store.addTextSegment(project.id, current.tracks[1].id, { text: "周末去海边", timeline: { start_us: 0, duration_us: 1_000_000 } });
  return { item, session, clip: current.tracks[0].segments[0].id, title: current.tracks[1].segments[0].id };
}

const checkpointFiles = (directory, id) => readdir(path.join(directory, "ai-edit", "checkpoints", id)).catch(() => []);
const userContents = (body) => body.messages.filter((message) => message.role === "user").map((message) => message.content);

describe("AI edit board edits", () => {
  it("edits clips through the same tool checks, keeps a checkpoint per edit and tells the model on the next turn", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { call, directory, waitIdle } = context;
    const { session, clip, title } = await boardSession(context);
    const edit = (name, args) => call(`/v1/ai-edit/sessions/${session.id}/edit`, { method: "POST", body: { name, arguments: args } });
    const clipsOf = (project) => project.tracks.map((track) => track.segments.map((segment) => ({ id: segment.id, start: segment.timeline.start_us, duration: segment.timeline.duration_us })));

    const moved = await edit("move_clip", { clip_id: clip, start: 1.5 });
    expect(moved.status).toBe(200);
    expect(clipsOf(moved.body.project)[0]).toEqual([{ id: clip, start: 1_500_000, duration: 1_000_000 }]);
    expect(moved.body.session.undo).toEqual({ label: "挪动视频“海边.mp4”", kind: "edit" });
    const retitled = await edit("update_clip", { clip_id: title, text: "周日去海边" });
    expect(retitled.body.project.tracks[1].segments[0].text).toBe("周日去海边");
    expect(retitled.body.session.undo).toEqual({ label: "改文字“周末去海边”", kind: "edit" });

    // 只放开看板上的几种改动、update_clip 也只放开几项
    for (const [name, args] of [["update_clip", { clip_id: clip, volume: 0.5 }], ["add_effect", { clip_id: clip, effect_type: "x" }], ["export_to_jianying", {}], ["move_clip", "x"]]) {
      expect(await edit(name, args)).toEqual({ status: 422, body: { error: "edit_not_allowed", message: "这个改动不能在看板上做。" } });
    }
    const split = await edit("split_clip", { clip_id: clip, offset: 0.4 });
    const [first, second] = split.body.project.tracks[0].segments.map((segment) => segment.id);
    expect(clipsOf(split.body.project)[0]).toEqual([{ id: first, start: 1_500_000, duration: 400_000 }, { id: second, start: 1_900_000, duration: 600_000 }]);
    // 工具的校验照旧，报错换成中文；没改成的不留存档
    expect(await edit("move_clip", { clip_id: first, start: 1.8 })).toEqual({ status: 422, body: { error: "timeline_overlap", message: "和同一轨道上的片段时间重叠了。" } });
    expect(await edit("move_clip", { clip_id: "nope", start: 1 })).toMatchObject({ status: 422, body: { error: "segment_not_found" } });
    expect(await edit("update_clip", { clip_id: first, transform: { x: 1 } })).toMatchObject({ status: 422, body: { error: "arguments_invalid" } });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(3);
    expect((await call(`/v1/ai-edit/sessions/${session.id}`)).body.session.undo).toEqual({ label: "切开视频“海边.mp4”", kind: "edit" });

    await edit("delete_clip", { clip_id: second });
    const trimmed = await edit("update_clip", { clip_id: first, start: 0, duration: 0.2, source_start: 0.5, source_duration: 0.2, speed: 1, transform: { transform_x: 0.5 } });
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.project.tracks[0].segments[0]).toMatchObject({ timeline: { start_us: 0, duration_us: 200_000 }, source: { start_us: 500_000, duration_us: 200_000 }, transform: { transform_x: 0.5 } });
    expect(trimmed.body.session.undo).toEqual({ label: "裁剪视频“海边.mp4”", kind: "edit" });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(5);
    // 裁剪时带上的是原来的倍速，说明里不提；真改了倍速才写
    expect((await edit("update_clip", { clip_id: first, speed: 0.5 })).body.session.undo).toEqual({ label: "给视频“海边.mp4”变速", kind: "edit" });

    // 下一轮把这些改动附在用户这句话前面给模型看；页面上还是原话
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "加个标题", config: CONFIG } });
    const done = await waitIdle(session.id);
    expect(done.session.messages[0]).toEqual({ id: expect.any(String), role: "user", text: "加个标题", at: expect.any(String) });
    expect(userContents(requests[0])[0]).toBe([
      "【应用自动附上，不是用户说的话】",
      "用户在看板上手动改过（以工程现状为准，这些是用户自己改的，别改回去，除非用户这次明说）：",
      `- 把视频“海边.mp4”（clip_id ${clip}）挪到了 1.5 秒开始`,
      `- 把文字“周末去海边”（clip_id ${title}）改成了“周日去海边”`,
      `- 在 1.9 秒处切开了视频“海边.mp4”（clip_id ${clip}），现在是 clip_id ${first} 和 clip_id ${second} 两段`,
      `- 删掉了视频“海边.mp4”（clip_id ${second}）`,
      `- 改了视频“海边.mp4”（clip_id ${first}）：时间改成了 0 秒开始、长 0.2 秒，改成从素材第 0.5 秒开始截取 0.2 秒，调了位置`,
      `- 改了视频“海边.mp4”（clip_id ${first}）：倍速改成了 0.5 倍`,
      "【用户这次说的话】",
      "加个标题",
    ].join("\n"));
    // 说过一次就清掉；这一轮没动工程，开跑前的存档也不留
    expect(done.session.undo).toEqual({ label: "给视频“海边.mp4”变速", kind: "edit" });
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "再看看", config: CONFIG } });
    await waitIdle(session.id);
    expect(userContents(requests[1]).at(-2)).toBe("再看看");
    expect(await checkpointFiles(directory, session.id)).toHaveLength(6);
  }, 20_000);

  it("adds, renames and moves markers and adds a subtitle line from the timeline toolbar, with a named batch", async () => {
    const context = await startBoard();
    const { call } = context;
    const { session } = await boardSession(context);
    const url = `/v1/ai-edit/sessions/${session.id}/edit`;
    const edit = (name, args) => call(url, { method: "POST", body: { name, arguments: args } });

    let state = (await edit("add_marker", { time: 0.5, label: "标记 1", color: "#4C8DFF" })).body;
    expect(state.project.markers).toEqual([{ time_us: 500_000, label: "标记 1", color: "#4C8DFF" }]);
    expect(state.session.undo).toEqual({ label: "加了标记“标记 1”", kind: "edit" });
    state = (await edit("add_marker", { time: 0.5, label: "高潮" })).body;
    expect(state.session.undo.label).toBe("改了标记“高潮”");
    // 拖动标记：删旧的、加新的，一批算一步，名字由看板给
    state = (await call(url, { method: "POST", body: { label: "挪动标记“高潮”", edits: [
      { name: "remove_marker", arguments: { time: 0.5 } }, { name: "add_marker", arguments: { time: 0.8, label: "高潮", color: "#FF5A5A" } },
    ] } })).body;
    expect(state.project.markers).toEqual([{ time_us: 800_000, label: "高潮", color: "#FF5A5A" }]);
    expect(state.session.undo.label).toBe("挪动标记“高潮”");

    // 还没有字幕：在播放头处补一条就新建一组，放在画面下方；再补一条进同一组
    state = (await edit("add_subtitle_line", { start: 0.2, duration: 0.5, text: "新字幕" })).body;
    const group = state.project.tracks.find((track) => track.kind === "subtitle");
    expect(group.segments).toMatchObject([{ text: "新字幕", timeline: { start_us: 200_000, duration_us: 500_000 }, transform: { transform_y: -0.8 } }]);
    state = (await edit("add_subtitle_line", { track_id: group.id, start: 1, duration: 0.5, text: "第二句" })).body;
    expect(state.project.tracks.find((track) => track.id === group.id).segments.map((line) => line.text)).toEqual(["新字幕", "第二句"]);
    expect(state.session.undo.label).toBe("加了一条字幕“第二句”");
    expect((await edit("add_subtitle_line", { track_id: group.id, start: 1.2, duration: 0.5, text: "叠上了" })).status).toBe(422);
    expect((await edit("add_marker", { time: 1, label: "x", extra: 1 })).body.error).toBe("edit_not_allowed");
  });

  it("undoes edits and AI turns, reverts to before a message, and keeps nothing for a turn that changed nothing", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const said = userContents(body).at(-2);
      const tools = body.messages.filter((message) => message.role === "tool").length;
      const done = body.messages.at(-2)?.role === "tool";
      if (said.endsWith("加一条视频轨") && !done) return toolReply([{ name: "create_track", args: { track_type: "video", name: "画面" } }]);
      if (said.endsWith("再加一条音频轨") && !done) return toolReply([{ name: "create_track", args: { track_type: "audio", name: "配乐" } }]);
      return textReply(`好${tools}`);
    };
    const context = await startBoard({ fetchImpl });
    const { call, directory, waitIdle } = context;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    const send = async (text) => {
      await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text, config: CONFIG } });
      return waitIdle(session.id);
    };
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    const trackNames = (project) => project.tracks.map((track) => track.name);
    expect(await post("undo")).toEqual({ status: 409, body: { error: "nothing_to_undo", message: "没有能撤销的改动了。" } });

    let state = await send("加一条视频轨");
    const [m1] = state.session.messages;
    expect(trackNames(state.project)).toEqual(["画面"]);
    expect(state.session).toMatchObject({ title: "加一条视频轨", undo: { label: "AI 处理“加一条视频轨”之前", kind: "turn" }, revertible: [m1.id] });
    state = await send("随便聊聊");
    const m2 = state.session.messages[2];
    // 只聊天没动工程：不多留一份
    expect(state.session).toMatchObject({ undo: { label: "AI 处理“加一条视频轨”之前", kind: "turn" }, revertible: [m1.id] });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(1);
    state = await send("再加一条音频轨");
    const m3 = state.session.messages[4];
    expect(trackNames(state.project)).toEqual(["画面", "配乐"]);
    expect(state.session.revertible).toEqual([m1.id, m2.id, m3.id]);

    // 退回到「随便聊聊」之前：那时只有视频轨
    let reverted = await post("revert", { messageId: m2.id });
    expect(reverted.status).toBe(200);
    expect(trackNames(reverted.body.project)).toEqual(["画面"]);
    expect(reverted.body.session.messages.at(-1)).toEqual({ id: expect.any(String), role: "note", text: "已退回到“随便聊聊”之前的样子", at: expect.any(String) });
    expect(reverted.body.session.undo).toEqual({ label: "退回", kind: "revert" });
    // 退回到第一句之前：工程回到一开始的样子，名字也是
    reverted = await post("revert", { messageId: m1.id });
    expect(reverted.body.project).toMatchObject({ name: "未命名剪辑", tracks: [] });
    expect(reverted.body.session.title).toBe("未命名剪辑");
    // 撤销刚才的退回
    const undone = await post("undo");
    expect(trackNames(undone.body.project)).toEqual(["画面"]);
    expect(undone.body.session.undo).toEqual({ label: "退回", kind: "revert" });

    for (const messageId of ["nope", state.session.messages[1].id, undefined]) {
      expect(await post("revert", { messageId })).toEqual({ status: 409, body: { error: "revert_unavailable", message: "这句话之前的样子已经找不回来了。" } });
    }
    // 下一轮告诉模型时间线被退回、撤销过
    state = await send("现在怎么样");
    const told = userContents(requests.at(-1)).at(-2);
    expect(told).toContain("- 把时间线退回到了“随便聊聊”发出之前的样子\n- 把时间线退回到了“加一条视频轨”发出之前的样子\n- 撤销了刚才的退回\n【用户这次说的话】\n现在怎么样");
    expect(state.session.messages.filter((item) => item.role === "user").map((item) => item.text)).toEqual(["加一条视频轨", "随便聊聊", "再加一条音频轨", "现在怎么样"]);

    // 一份份撤销到头
    let left = (await call(`/v1/ai-edit/sessions/${session.id}`)).body.session;
    for (let guard = 0; left.undo && guard < 10; guard += 1) left = (await post("undo")).body.session;
    expect(left).toMatchObject({ undo: null, revertible: [] });
    expect((await call(`/v1/ai-edit/sessions/${session.id}`)).body.project.tracks).toEqual([]);
    expect(await post("undo")).toMatchObject({ status: 409, body: { error: "nothing_to_undo" } });

    // 删会话连存档一起删
    await post("canvas", { width: 1920, height: 1080 });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(1);
    await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" });
    expect(existsSync(path.join(directory, "ai-edit", "checkpoints", session.id))).toBe(false);
  }, 30_000);

  it("goes back to the moment a message was sent, keeping the board edits made before it", async () => {
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const done = body.messages.at(-2)?.role === "tool";
      if (userContents(body).at(-2).endsWith("加一条音频轨") && !done) return toolReply([{ name: "create_track", args: { track_type: "audio", name: "配乐" } }]);
      return textReply("好");
    };
    const context = await startBoard({ fetchImpl });
    const { call, waitIdle } = context;
    const { session, clip } = await boardSession(context);
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    const send = async (text) => {
      await post("messages", { text, config: CONFIG });
      return waitIdle(session.id);
    };
    const startOf = (project) => project.tracks.flatMap((track) => track.segments).find((segment) => segment.id === clip).timeline.start_us;
    const hasMusic = (project) => project.tracks.some((track) => track.name === "配乐");

    await send("先看看");
    expect((await post("edit", { name: "move_clip", arguments: { clip_id: clip, start: 2 } })).status).toBe(200);
    // 只聊天：这句话发出时片段已经在 2 秒，之后工程也没变，没东西可退
    let state = await send("这样可以吗");
    const asked = state.session.messages[2];
    expect(asked.text).toBe("这样可以吗");
    expect(state.session.revertible).not.toContain(asked.id);
    expect(await post("revert", { messageId: asked.id })).toMatchObject({ status: 409, body: { error: "revert_unavailable" } });
    // AI 改了工程以后再退回到这句之前：之前手动挪的还在
    state = await send("加一条音频轨");
    expect(hasMusic(state.project)).toBe(true);
    expect(state.session.revertible).toContain(asked.id);
    let reverted = await post("revert", { messageId: asked.id });
    expect(reverted.status).toBe(200);
    expect(hasMusic(reverted.body.project)).toBe(false);
    expect(startOf(reverted.body.project)).toBe(2_000_000);

    // 手动挪了马上说一句让 AI 改工程的话（这一轮开跑前的存档还在）：退回到这句之前也留着这次挪动
    expect((await post("edit", { name: "move_clip", arguments: { clip_id: clip, start: 3 } })).status).toBe(200);
    state = await send("再加一条音频轨");
    const again = state.session.messages.at(-2);
    expect(again.text).toBe("再加一条音频轨");
    expect(hasMusic(state.project)).toBe(true);
    reverted = await post("revert", { messageId: again.id });
    expect(reverted.status).toBe(200);
    expect(hasMusic(reverted.body.project)).toBe(false);
    expect(startOf(reverted.body.project)).toBe(3_000_000);
    // 第一句之前：那时片段还在 0 秒
    reverted = await post("revert", { messageId: state.session.messages[0].id });
    expect(startOf(reverted.body.project)).toBe(0);
  }, 20_000);

  it("drops a checkpoint that can no longer be read so undo can go on to the one before", async () => {
    const context = await startBoard();
    const { call, directory } = context;
    const { session, clip, title } = await boardSession(context);
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    expect((await post("edit", { name: "move_clip", arguments: { clip_id: clip, start: 1 } })).status).toBe(200);
    expect((await post("edit", { name: "update_clip", arguments: { clip_id: title, text: "周日去海边" } })).body.session.undo).toEqual({ label: "改文字“周末去海边”", kind: "edit" });
    // 后一份存档是挪动之后的样子：把它的文件弄坏
    const folder = path.join(directory, "ai-edit", "checkpoints", session.id);
    for (const name of await readdir(folder)) {
      const snapshot = JSON.parse(await readFile(path.join(folder, name), "utf8"));
      if (snapshot.project.tracks[0].segments[0].timeline.start_us === 1_000_000) await writeFile(path.join(folder, name), "坏了");
    }
    expect(await post("undo")).toEqual({ status: 409, body: { error: "nothing_to_undo", message: "上一步的存档坏了，已经丢掉，可以再按一次撤销。" } });
    expect((await call(`/v1/ai-edit/sessions/${session.id}`)).body.session.undo).toEqual({ label: "挪动视频“海边.mp4”", kind: "edit" });
    const undone = await post("undo");
    expect(undone.status).toBe(200);
    expect(undone.body.project.tracks[0].segments[0].timeline.start_us).toBe(0);
    expect(undone.body.session).toMatchObject({ undo: null, redo: { label: "挪动视频“海边.mp4”" } });
    // 只剩重做用的那份（挪动之后的样子）
    expect(await checkpointFiles(directory, session.id)).toHaveLength(1);
  }, 20_000);

  it("will not go back to a timeline whose media was removed from the library", async () => {
    const context = await startBoard();
    const { call } = context;
    const { session, item, clip } = await boardSession(context);
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    expect((await post("edit", { name: "delete_clip", arguments: { clip_id: clip } })).status).toBe(200);
    // 时间线上已经不用它了，素材库能删；存档里还用着
    expect((await call(`/v1/ai-edit/media/${item.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await post("undo")).toEqual({ status: 409, body: { error: "revert_media_missing", message: "撤销不了上一步：要用到的素材“海边.mp4”已经从素材库删掉了，更早的改动也没法再撤销。" } });
    const { session: after, project } = (await call(`/v1/ai-edit/sessions/${session.id}`)).body;
    expect(project.tracks[0].segments).toEqual([]);
    expect(after.undo).toEqual({ label: "删掉视频“海边.mp4”", kind: "edit" });
  }, 20_000);

  it("keeps the last 50 checkpoints and cannot go back past the oldest one it dropped", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return requests.length === 1 ? toolReply([{ name: "create_track", args: { track_type: "video" } }]) : textReply("好");
    };
    const context = await startBoard({ fetchImpl });
    const { call, directory, waitIdle } = context;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "建条轨道", config: CONFIG } });
    const [m1] = (await waitIdle(session.id)).session.messages;
    let latest;
    for (let n = 0; n < 50; n += 1) {
      latest = await call(`/v1/ai-edit/sessions/${session.id}/canvas`, { method: "POST", body: n % 2 ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 } });
      expect(latest.status).toBe(200);
    }
    expect(latest.body.session).toMatchObject({ undo: { label: "换画面比例" }, revertible: [] });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(50);
    expect(await call(`/v1/ai-edit/sessions/${session.id}/revert`, { method: "POST", body: { messageId: m1.id } })).toMatchObject({ status: 409, body: { error: "revert_unavailable" } });
    // 给模型的说明最多 30 条，多的并成一句
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "看看", config: CONFIG } });
    await waitIdle(session.id);
    const told = userContents(requests.at(-1)).at(-2).split("\n");
    expect(told.filter((line) => line.startsWith("- "))).toHaveLength(30);
    expect(told).toContain("- 把画布改成了 1920×1080（横屏），30 帧/秒");
    expect(told).toContain("- 还有 21 处手动改动没一一列出，以工程现状为准");
  }, 30_000);

  it("does one thing at a time: board edits, undo, revert and canvas wait for the AI, an export and each other", async () => {
    let release;
    const fetchImpl = async () => { await new Promise((resolve) => { release = resolve; }); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { call, store, draftBox, waitIdle } = context;
    const { session, clip } = await boardSession(context);
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    const busy = { status: 409, body: { error: "session_busy" } };
    await post("messages", { text: "剪", config: CONFIG });
    for (const [action, body] of [["edit", { name: "move_clip", arguments: { clip_id: clip, start: 2 } }], ["undo", {}], ["redo", {}], ["revert", { messageId: "x" }], ["canvas", { width: 1920, height: 1080 }]]) {
      expect(await post(action, body)).toMatchObject(busy);
    }
    for (let i = 0; i < 100 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await waitIdle(session.id);

    // 一个手动改动没做完时，别的改动、发消息、导入剪映都等着
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const moveSegment = store.moveSegment.bind(store);
    store.moveSegment = async (...args) => { entered(); await gate; return moveSegment(...args); };
    const moving = post("edit", { name: "move_clip", arguments: { clip_id: clip, start: 2 } });
    await reached;
    expect(await post("edit", { name: "delete_clip", arguments: { clip_id: clip } })).toMatchObject(busy);
    expect(await post("undo")).toMatchObject(busy);
    expect(await post("canvas", { width: 1920, height: 1080 })).toMatchObject(busy);
    expect(await post("messages", { text: "再来", config: CONFIG })).toMatchObject(busy);
    expect(await post("export")).toMatchObject(busy);
    open();
    expect((await moving).status).toBe(200);

    // 正在导入剪映时也不改
    let finish;
    const exportGate = new Promise((resolve) => { finish = resolve; });
    let started;
    const exportStarted = new Promise((resolve) => { started = resolve; });
    const createDraft = draftBox.createDraft.getMockImplementation();
    draftBox.createDraft.mockImplementationOnce(async (...args) => { started(); await exportGate; return createDraft(...args); });
    const exporting = post("export");
    await exportStarted;
    expect(await post("edit", { name: "delete_clip", arguments: { clip_id: clip } })).toMatchObject(busy);
    expect(await post("undo")).toMatchObject(busy);
    finish();
    expect((await exporting).status).toBe(200);
    expect((await post("undo")).status).toBe(200);
  }, 20_000);
});

describe("AI edit redo, history and batches on the board", () => {
  /** 会话上的几个快捷操作：发消息并等这一轮做完、调接口、看片段在哪。 */
  function helpers({ call, waitIdle }, session) {
    const post = (action, body = {}) => call(`/v1/ai-edit/sessions/${session.id}/${action}`, { method: "POST", body });
    const edit = (name, args) => post("edit", { name, arguments: args });
    const batch = (edits) => post("edit", { edits: edits.map(([name, args]) => ({ name, arguments: args })) });
    const send = async (text) => {
      await post("messages", { text, config: CONFIG });
      return waitIdle(session.id);
    };
    const find = (project, clipId) => {
      const track = project.tracks.find((item) => item.segments.some((segment) => segment.id === clipId));
      return track ? { track: track.id, ...track.segments.find((segment) => segment.id === clipId) } : null;
    };
    const startOf = (project, clipId) => find(project, clipId)?.timeline.start_us ?? null;
    return { post, edit, batch, send, find, startOf };
  }
  const told = (requests) => userContents(requests.at(-1)).at(-2).split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));

  it("redoes what was undone one step at a time, and undoes a redo again", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { directory } = context;
    const { session, clip } = await boardSession(context);
    const { post, edit, send, startOf } = helpers(context, session);
    expect(await post("redo")).toEqual({ status: 409, body: { error: "nothing_to_redo", message: "没有能重做的改动了。" } });
    expect((await edit("move_clip", { clip_id: clip, start: 1 })).status).toBe(200);
    expect((await edit("move_clip", { clip_id: clip, start: 2 })).body.session.redo).toBeNull();

    let state = (await post("undo")).body;
    expect(startOf(state.project, clip)).toBe(1_000_000);
    expect(state.session).toMatchObject({ undo: { label: "挪动视频“海边.mp4”", kind: "edit" }, redo: { label: "挪动视频“海边.mp4”" } });
    // 存档和重做的快照在同一个目录
    expect(await checkpointFiles(directory, session.id)).toHaveLength(2);
    state = (await post("redo")).body;
    expect(startOf(state.project, clip)).toBe(2_000_000);
    expect(state.session).toMatchObject({ undo: { label: "挪动视频“海边.mp4”", kind: "edit" }, redo: null });
    expect(state.session.history.map((item) => item.label)).toEqual(["挪动视频“海边.mp4”", "挪动视频“海边.mp4”"]);
    expect(await checkpointFiles(directory, session.id)).toHaveLength(2);

    // 撤到头再一步步重做回来，重做以后还能再撤
    expect(startOf((await post("undo")).body.project, clip)).toBe(1_000_000);
    state = (await post("undo")).body;
    expect(startOf(state.project, clip)).toBe(0);
    expect(state.session).toMatchObject({ undo: null, history: [] });
    expect(startOf((await post("redo")).body.project, clip)).toBe(1_000_000);
    state = (await post("redo")).body;
    expect(startOf(state.project, clip)).toBe(2_000_000);
    expect(await post("redo")).toMatchObject({ status: 409, body: { error: "nothing_to_redo" } });
    state = (await post("undo")).body;
    expect(startOf(state.project, clip)).toBe(1_000_000);
    expect(state.session.redo).toEqual({ label: "挪动视频“海边.mp4”" });

    // 撤销、重做都告诉模型
    await send("现在呢");
    expect(told(requests)).toEqual([
      `把视频“海边.mp4”（clip_id ${clip}）挪到了 1 秒开始`,
      `把视频“海边.mp4”（clip_id ${clip}）挪到了 2 秒开始`,
      "撤销了上一步（挪动视频“海边.mp4”）",
      "重做了：挪动视频“海边.mp4”",
      "撤销了上一步（挪动视频“海边.mp4”）",
      "撤销了上一步（挪动视频“海边.mp4”）",
      "重做了：挪动视频“海边.mp4”",
      "重做了：挪动视频“海边.mp4”",
      "撤销了上一步（挪动视频“海边.mp4”）",
    ]);
  }, 20_000);

  it("forgets what can be redone once the timeline changes another way, deleting its files", async () => {
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const done = body.messages.at(-2)?.role === "tool";
      if (userContents(body).at(-2).endsWith("加一条音频轨") && !done) return toolReply([{ name: "create_track", args: { track_type: "audio", name: "配乐" } }]);
      return textReply("好");
    };
    const context = await startBoard({ fetchImpl });
    const { directory } = context;
    const { session, clip, title } = await boardSession(context);
    const { post, edit, send } = helpers(context, session);
    const current = async () => (await context.call(`/v1/ai-edit/sessions/${session.id}`)).body;
    const undone = async () => {
      expect((await edit("move_clip", { clip_id: clip, start: 3 })).status).toBe(200);
      const state = (await post("undo")).body;
      expect(state.session.redo).toEqual({ label: "挪动视频“海边.mp4”" });
      return state;
    };
    // 只剩存档的文件，重做的都删了
    const onlyCheckpoints = async (state) => {
      expect(state.session.redo).toBeNull();
      expect(await checkpointFiles(directory, session.id)).toHaveLength(state.session.history.length);
    };

    await undone();
    await onlyCheckpoints((await edit("update_clip", { clip_id: title, text: "周日去海边" })).body);
    await undone();
    await onlyCheckpoints((await post("canvas", { width: 1920, height: 1080 })).body);
    // AI 这一轮只聊天、没动工程：还能重做
    await undone();
    let state = await send("随便聊聊");
    expect(state.session.redo).toEqual({ label: "挪动视频“海边.mp4”" });
    await onlyCheckpoints(await send("加一条音频轨"));
    const asked = state.session.messages.findLast((item) => item.role === "user");
    await undone();
    await onlyCheckpoints((await post("revert", { messageId: asked.id })).body);
    // 没做成的改动不算
    await undone();
    expect(await edit("move_clip", { clip_id: "nope", start: 1 })).toMatchObject({ status: 422 });
    expect((await current()).session.redo).toEqual({ label: "挪动视频“海边.mp4”" });
  }, 30_000);

  it("undoes several steps at once from the history, then redoes them one by one", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { directory } = context;
    const { session, clip, title } = await boardSession(context);
    const { post, edit, send, startOf, find } = helpers(context, session);
    // 切开以后原来那段的 clip_id 就没了，start 是 null
    const look = (project) => ({ start: startOf(project, clip), text: find(project, title).text, clips: project.tracks[0].segments.length });
    const current = async () => (await context.call(`/v1/ai-edit/sessions/${session.id}`)).body;
    const states = [look((await current()).project)];
    for (const [name, args] of [["move_clip", { clip_id: clip, start: 1 }], ["update_clip", { clip_id: title, text: "周日去海边" }], ["move_clip", { clip_id: clip, start: 2 }], ["split_clip", { clip_id: clip, offset: 0.5 }]]) {
      const done = await edit(name, args);
      expect(done.status).toBe(200);
      states.push(look(done.body.project));
    }
    let { history } = (await current()).session;
    expect(history.map((item) => [item.kind, item.label])).toEqual([
      ["edit", "切开视频“海边.mp4”"], ["edit", "挪动视频“海边.mp4”"], ["edit", "改文字“周末去海边”"], ["edit", "挪动视频“海边.mp4”"],
    ]);

    expect(await post("undo", { to: "0".repeat(16) })).toEqual({ status: 409, body: { error: "history_not_found", message: "这一步已经找不到了。" } });
    // 撤到「改文字」那一步之前：后面三步一起撤掉
    let state = (await post("undo", { to: history[2].id })).body;
    expect(look(state.project)).toEqual(states[1]);
    expect(state.session).toMatchObject({ undo: { label: "挪动视频“海边.mp4”", kind: "edit" }, redo: { label: "改文字“周末去海边”" } });
    expect(state.session.history.map((item) => item.id)).toEqual([history[3].id]);
    expect(await checkpointFiles(directory, session.id)).toHaveLength(4);
    // 连按重做一步步走回来
    for (const [index, next] of [[2, "挪动视频“海边.mp4”"], [3, "切开视频“海边.mp4”"], [4, null]]) {
      state = (await post("redo")).body;
      expect(look(state.project)).toEqual(states[index]);
      expect(state.session.redo).toEqual(next && { label: next });
    }
    expect(state.project.tracks[0].segments).toHaveLength(2);
    history = state.session.history;
    expect(history.map((item) => item.label)).toEqual(["切开视频“海边.mp4”", "挪动视频“海边.mp4”", "改文字“周末去海边”", "挪动视频“海边.mp4”"]);
    expect(await checkpointFiles(directory, session.id)).toHaveLength(4);
    // 撤到最新那一步之前，就是撤一步
    state = (await post("undo", { to: history[0].id })).body;
    expect(state.session).toMatchObject({ redo: { label: "切开视频“海边.mp4”" }, history: history.slice(1) });

    await send("看看");
    expect(told(requests).slice(-5)).toEqual([
      "撤销了 3 步，时间线回到了改文字“周末去海边”之前的样子",
      "重做了：改文字“周末去海边”",
      "重做了：挪动视频“海边.mp4”",
      "重做了：切开视频“海边.mp4”",
      "撤销了上一步（切开视频“海边.mp4”）",
    ]);
  }, 20_000);

  it("keeps the moment a message was sent findable after an AI turn is undone and redone", async () => {
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const done = body.messages.at(-2)?.role === "tool";
      if (userContents(body).at(-2).endsWith("加一条音频轨") && !done) return toolReply([{ name: "create_track", args: { track_type: "audio", name: "配乐" } }]);
      return textReply("好");
    };
    const context = await startBoard({ fetchImpl });
    const { session } = await boardSession(context);
    const { post, send } = helpers(context, session);
    let state = await send("加一条音频轨");
    const asked = state.session.messages[0];
    state = (await post("undo")).body;
    expect(state.session).toMatchObject({ redo: { label: "AI 处理“加一条音频轨”之前" }, revertible: [] });
    state = (await post("redo")).body;
    expect(state.project.tracks.map((track) => track.name)).toContain("配乐");
    expect(state.session).toMatchObject({ undo: { label: "AI 处理“加一条音频轨”之前", kind: "turn" }, revertible: [asked.id] });
    const reverted = await post("revert", { messageId: asked.id });
    expect(reverted.body.project.tracks.map((track) => track.name)).not.toContain("配乐");
  }, 20_000);

  it("applies a batch as one step: one checkpoint, one undo, and nothing left behind when a step fails", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { directory, store } = context;
    const { session, item, clip, title } = await boardSession(context);
    const { post, batch, send, startOf } = helpers(context, session);
    const current = async () => (await context.call(`/v1/ai-edit/sessions/${session.id}`)).body;
    const { project: created } = await current();
    const added = await store.addMediaSegment(created.id, created.tracks[0].id, { path: await mediaPath(directory, `${item.id}.mp4`), timeline: { start_us: 1_000_000, duration_us: 1_000_000 }, material_name: "日落.mp4" });
    const other = added.tracks[0].segments[1].id;

    let state = await batch([["move_clip", { clip_id: clip, start: 4 }], ["move_clip", { clip_id: other, start: 5 }]]);
    expect(state.status).toBe(200);
    expect([startOf(state.body.project, clip), startOf(state.body.project, other)]).toEqual([4_000_000, 5_000_000]);
    expect(state.body.session.undo).toEqual({ label: "挪动了 2 段", kind: "edit" });
    expect(await checkpointFiles(directory, session.id)).toHaveLength(1);
    state = await post("undo");
    expect([startOf(state.body.project, clip), startOf(state.body.project, other)]).toEqual([0, 1_000_000]);
    expect(state.body.session.redo).toEqual({ label: "挪动了 2 段" });
    state = await post("redo");
    expect([startOf(state.body.project, clip), startOf(state.body.project, other)]).toEqual([4_000_000, 5_000_000]);

    expect((await batch([["update_clip", { clip_id: title, text: "周日去海边" }], ["move_clip", { clip_id: clip, start: 2 }]])).body.session.undo).toEqual({ label: "改了 2 处", kind: "edit" });
    expect((await batch([["delete_clip", { clip_id: other }]])).body.session.undo).toEqual({ label: "删掉视频“日落.mp4”", kind: "edit" });
    const many = await batch(Array.from({ length: 10 }, (_, index) => ["move_clip", { clip_id: clip, start: 10 + index }]));
    expect(many.body.session.undo).toEqual({ label: "挪动了 10 段", kind: "edit" });
    expect(startOf(many.body.project, clip)).toBe(19_000_000);

    // 第 2 步没做成：第 1 步也退回去，存档不留、redo 不动
    const before = await current();
    const files = await checkpointFiles(directory, session.id);
    const failed = await batch([["move_clip", { clip_id: clip, start: 30 }], ["move_clip", { clip_id: "nope", start: 1 }], ["delete_clip", { clip_id: clip }]]);
    expect(failed).toEqual({ status: 422, body: { error: "segment_not_found", message: "第 2 步没做成：找不到这个片段。" } });
    const after = await current();
    expect(after.project.tracks).toEqual(before.project.tracks);
    expect(after.session).toMatchObject({ undo: before.session.undo, history: before.session.history, redo: before.session.redo });
    expect(await checkpointFiles(directory, session.id)).toEqual(files);
    // 只有一条时就是那一条的原因
    expect(await batch([["move_clip", { clip_id: "nope", start: 1 }]])).toEqual({ status: 422, body: { error: "segment_not_found", message: "找不到这个片段。" } });

    // 请求不对的整批不做
    expect(await post("edit", { edits: [] })).toMatchObject({ status: 422, body: { error: "edit_not_allowed" } });
    expect(await post("edit", { edits: "x" })).toMatchObject({ status: 422, body: { error: "edit_not_allowed" } });
    expect(await batch([["move_clip", { clip_id: clip, start: 1 }], ["add_effect", { clip_id: clip, effect_type: "x" }]])).toMatchObject({ status: 422, body: { error: "edit_not_allowed" } });
    expect(await batch(Array.from({ length: 201 }, () => ["move_clip", { clip_id: clip, start: 1 }]))).toEqual({ status: 422, body: { error: "too_many_edits", message: "一次最多改 200 处。" } });
    expect(startOf((await current()).project, clip)).toBe(19_000_000);

    // 给模型：一批不多就每步一句，多了并成一句；没做成的那批不提
    await send("看看");
    expect(told(requests)).toEqual([
      `把视频“海边.mp4”（clip_id ${clip}）挪到了 4 秒开始`,
      `把视频“日落.mp4”（clip_id ${other}）挪到了 5 秒开始`,
      "撤销了上一步（挪动了 2 段）",
      "重做了：挪动了 2 段",
      `把文字“周末去海边”（clip_id ${title}）改成了“周日去海边”`,
      `把视频“海边.mp4”（clip_id ${clip}）挪到了 2 秒开始`,
      `删掉了视频“日落.mp4”（clip_id ${other}）`,
      `一次挪动了 10 段，涉及 clip_id ${clip}`,
    ]);
  }, 20_000);

  it("moves clips across tracks, copies them, mutes tracks and restacks them from the board", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { store } = context;
    const { session, clip, title } = await boardSession(context);
    const { post, edit, send, find } = helpers(context, session);
    const { project: created } = (await context.call(`/v1/ai-edit/sessions/${session.id}`)).body;
    const [main, text] = created.tracks.map((track) => track.id);
    const pip = (await store.createTrack(created.id, { track_type: "video", name: "画中画" })).tracks.at(-1).id;
    const music = (await store.createTrack(created.id, { track_type: "audio", name: "配乐" })).tracks.at(-1).id;
    const order = async (ids) => (await edit("reorder_tracks", { track_ids: ids })).body;

    let state = (await edit("move_clip", { clip_id: clip, start: 0, track_id: pip })).body;
    expect(find(state.project, clip)).toMatchObject({ track: pip, timeline: { start_us: 0 } });
    expect(state.session.undo).toEqual({ label: "挪动视频“海边.mp4”", kind: "edit" });
    expect(await edit("move_clip", { clip_id: title, start: 0, track_id: pip })).toEqual({ status: 422, body: { error: "track_type_mismatch", message: "轨道类型不对。" } });
    expect(await edit("move_clip", { clip_id: clip, start: 0, track_id: music })).toMatchObject({ status: 422, body: { error: "track_type_mismatch" } });

    state = (await edit("duplicate_clip", { clip_id: clip, start: 1 })).body;
    const copied = state.project.tracks.find((track) => track.id === pip).segments[1];
    expect(copied).toMatchObject({ id: expect.not.stringMatching(clip), material_name: "海边.mp4", timeline: { start_us: 1_000_000, duration_us: 1_000_000 } });
    expect(state.session.undo).toEqual({ label: "复制视频“海边.mp4”", kind: "edit" });
    state = (await edit("duplicate_clip", { clip_id: clip, start: 0, track_id: main })).body;
    const onMain = state.project.tracks.find((track) => track.id === main).segments[0];
    expect(await edit("duplicate_clip", { clip_id: clip, start: 0.5 })).toMatchObject({ status: 422, body: { error: "timeline_overlap" } });

    // 轨道只放开静音
    state = (await edit("update_track", { track_id: music, mute: true })).body;
    expect(state.project.tracks.find((track) => track.id === music).mute).toBe(true);
    expect(state.session.undo).toEqual({ label: "静音“配乐”", kind: "edit" });
    expect((await edit("update_track", { track_id: music, mute: false })).body.session.undo).toEqual({ label: "取消“配乐”的静音", kind: "edit" });
    for (const args of [{ track_id: music, name: "背景音乐", mute: true }, { track_id: music }, { track_id: music, mute: "yes" }]) {
      expect(await edit("update_track", args)).toMatchObject({ status: 422, body: { error: "edit_not_allowed" } });
    }

    // 列表越靠后越在上层
    expect((await order([text, pip, music, main])).session.undo).toEqual({ label: "把“主画面”移到最上层", kind: "edit" });
    expect((await order([music, text, pip, main])).session.undo).toEqual({ label: "把“配乐”移到最下层", kind: "edit" });
    expect((await order([music, pip, text, main])).session.undo).toEqual({ label: "调整轨道的上下层", kind: "edit" });
    expect(await edit("reorder_tracks", { track_ids: [main] })).toMatchObject({ status: 422, body: { error: "track_order_invalid" } });
    const undone = (await post("undo")).body;
    expect(undone.project.tracks.map((track) => track.id)).toEqual([music, text, pip, main]);

    await send("看看");
    expect(told(requests)).toEqual([
      `把视频“海边.mp4”（clip_id ${clip}）挪到了“画中画”（track_id ${pip}）上，0 秒开始`,
      `复制了视频“海边.mp4”（clip_id ${clip}），新的一段是 clip_id ${copied.id}，放在同一条轨道上，1 秒开始`,
      `复制了视频“海边.mp4”（clip_id ${clip}），新的一段是 clip_id ${onMain.id}，放在“主画面”（track_id ${main}）上，0 秒开始`,
      `把“配乐”（track_id ${music}）静音了`,
      `取消了“配乐”（track_id ${music}）的静音`,
      `把“主画面”（track_id ${main}）移到了最上层`,
      `把“配乐”（track_id ${music}）移到了最下层`,
      "调整了轨道的上下层顺序",
      "撤销了上一步（调整轨道的上下层）",
    ]);
  }, 20_000);

  it("names what a transform change actually changed", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { session, clip } = await boardSession(context);
    const { edit, send } = helpers(context, session);
    const placed = { transform_x: 0.5, scale_x: 2, scale_y: 2, rotation: 30 };
    const labels = [];
    for (const transform of [{ transform_x: 0.5 }, placed, placed, { ...placed, alpha: 0.5, flip_horizontal: true }, null]) {
      const done = await edit("update_clip", { clip_id: clip, transform });
      expect(done.status).toBe(200);
      labels.push(done.body.session.undo.label);
    }
    expect(labels).toEqual([
      "调整视频“海边.mp4”的位置",
      "调整视频“海边.mp4”的大小、角度",
      "修改视频“海边.mp4”",
      "调整视频“海边.mp4”的不透明度、翻转",
      "调整视频“海边.mp4”的位置、大小、角度、不透明度、翻转",
    ]);
    await send("看看");
    const ref = `视频“海边.mp4”（clip_id ${clip}）`;
    expect(told(requests)).toEqual([`改了${ref}：调了位置`, `改了${ref}：调了大小、角度`, `改了${ref}`, `改了${ref}：调了不透明度、翻转`, `改了${ref}：调了位置、大小、角度、不透明度、翻转`]);
  }, 20_000);
});

describe("AI edit region on the picture", () => {
  it("checks the box, keeps it on the message for the page and tells the model what is inside", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { call, waitIdle } = context;
    const { session, clip, title } = await boardSession(context);
    const send = (region, text = "把这里改大一点") => call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text, config: CONFIG, region } });
    const box = { time_us: 3_200_000, x: 0.1, y: 0.05, width: 0.3, height: 0.25, clip_ids: [clip, title, "不在工程里"] };
    for (const region of [
      "左上角", [box], { ...box, time_us: -1 }, { ...box, time_us: 1.5 }, { ...box, x: 0.8 }, { ...box, height: 0 },
      { ...box, y: -0.1 }, { ...box, width: Number.NaN }, { ...box, clip_ids: Array.from({ length: 31 }, (_, index) => `c${index}`) }, { ...box, clip_ids: [1] }, { ...box, clip_ids: "x" },
    ]) {
      expect(await send(region)).toEqual({ status: 422, body: { error: "invalid_region", message: "框选的范围不对，重新框一下。" } });
    }
    // 碰到右边和下边（浮点误差以内）也算框在画面里
    const sent = await send(box);
    expect(sent.status).toBe(202);
    const expected = { time_us: 3_200_000, x: 0.1, y: 0.05, width: 0.3, height: 0.25, clip_ids: [clip, title], labels: ["视频“海边.mp4”", "文字“周末去海边”"] };
    expect(sent.body.session.messages[0]).toEqual({ id: expect.any(String), role: "user", text: "把这里改大一点", at: expect.any(String), region: expected });
    await waitIdle(session.id);
    expect(userContents(requests[0])[0]).toBe([
      "【应用自动附上，不是用户说的话】",
      `用户在画面上框了一块：时刻 3.2 秒，横向 10%–40%、纵向 5%–30%（从画面左上角量）。框里有：clip_id ${clip}（视频“海边.mp4”）、clip_id ${title}（文字“周末去海边”）。用户这次说的「这里」「这块」「这个」指的就是框里这些，只改它们，框外的别动，除非用户明说。`,
      "【用户这次说的话】",
      "把这里改大一点",
    ].join("\n"));

    expect((await send({ time_us: 0, x: 0.7, y: 0.9, width: 0.3 + 1e-7, height: 0.1, clip_ids: [] }, "这里加个贴纸")).status).toBe(202);
    const done = await waitIdle(session.id);
    expect(done.session.messages[2].region).toMatchObject({ clip_ids: [], labels: [] });
    expect(userContents(requests[1]).at(-2)).toContain("横向 70%–100%、纵向 90%–100%（从画面左上角量）。框里没有片段，是画面上的这块空白位置。");
    // 不带框选的消息照旧
    expect((await send(undefined, "好了")).body.session.messages.at(-1)).not.toHaveProperty("region");
  }, 20_000);
});

describe("AI edit references, pasted images and dropped turns", () => {
  it("checks what the user referenced, keeps the labels on the message and tells the model what each one is", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("好"); };
    const context = await startBoard({ fetchImpl });
    const { call, waitIdle } = context;
    const { session, clip, title } = await boardSession(context);
    const logo = (await uploadFixture(call, "still.png", "logo.png")).body.item;
    const send = (refs, text = "把这段换成这个素材") => call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text, config: CONFIG, refs } });
    for (const refs of [
      "这段", [null], [{ kind: "x" }], [{ kind: "clip" }], [{ kind: "clip", clip_id: 3 }], [{ kind: "time", time_us: -1 }], [{ kind: "time", time_us: 1.5 }],
      [{ kind: "time", time_us: 2_000_001 }], [{ kind: "media", media_id: 1 }], Array.from({ length: 11 }, () => ({ kind: "clip", clip_id: clip })),
    ]) {
      expect(await send(refs)).toEqual({ status: 422, body: { error: "invalid_refs", message: "引用的东西不对，重新选一下。" } });
    }
    // 不在工程里的片段、不在素材库里的素材悄悄去掉，重复的只留一个
    const sent = await send([
      { kind: "clip", clip_id: clip }, { kind: "clip", clip_id: "早删了" }, { kind: "time", time_us: 500_000 },
      { kind: "media", media_id: logo.id }, { kind: "media", media_id: "f".repeat(32) }, { kind: "clip", clip_id: clip },
    ]);
    expect(sent.status).toBe(202);
    expect(sent.body.session.messages[0].refs).toEqual([
      { kind: "clip", clip_id: clip, label: "视频“海边.mp4”" },
      { kind: "time", time_us: 500_000, label: "第 0.5 秒" },
      { kind: "media", media_id: logo.id, label: "素材“logo.png”" },
    ]);
    await waitIdle(session.id);
    expect(userContents(requests[0])[0]).toBe([
      "【应用自动附上，不是用户说的话】",
      `用户这句话引用了：clip_id ${clip}（视频“海边.mp4”，在时间线 0–1 秒）、时刻 0.5 秒（这一刻正在显示或播放的有：clip_id ${title}（文字“周末去海边”）、clip_id ${clip}（视频“海边.mp4”））、media_id ${logo.id}（素材“logo.png”，图片 1280×720）。用户说的「这段」「这里」「这个素材」指的就是这些；引用的东西在工程现状里找不到了，就以工程现状为准，并跟用户说一声。`,
      "【用户这次说的话】",
      "把这段换成这个素材",
    ].join("\n"));
    // 片尾之后 1 秒以内也能引用；那一刻什么都没有
    expect((await send([{ kind: "time", time_us: 2_000_000 }], "这里加个结尾")).status).toBe(202);
    await waitIdle(session.id);
    expect(userContents(requests[1]).at(-2)).toContain("时刻 2 秒（这一刻时间线上什么都没有）");
    // 引用的都找不到了就和没引用一样
    const none = await send([{ kind: "clip", clip_id: "早删了" }], "好了");
    expect(none.body.session.messages.at(-1)).not.toHaveProperty("refs");
    await waitIdle(session.id);
    expect(userContents(requests[2]).at(-2)).toBe("好了");
    // 过了一分钟的时刻和页面上一样写成几分几秒；给模型的还是秒数
    const project = await context.store.getProject(session.projectId);
    await context.store.addTextSegment(project.id, project.tracks[1].id, { text: "片尾", timeline: { start_us: 70_000_000, duration_us: 10_000_000 } });
    const late = await send([{ kind: "time", time_us: 75_040_000 }], "这里加个转场");
    expect(late.body.session.messages.at(-1).refs).toEqual([{ kind: "time", time_us: 75_040_000, label: "第 1 分 15 秒" }]);
    await waitIdle(session.id);
    expect(userContents(requests[3]).at(-2)).toContain("时刻 75.04 秒（这一刻正在显示或播放的有：");
  }, 20_000);

  it("keeps pasted images as files for the model, shows their names on the message and cleans them up with the session", async () => {
    const requests = [];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return textReply("看到了"); };
    const { call, waitIdle, directory } = await start({ fetchImpl });
    const cover = (await uploadFixture(call, "still.jpg", "封面.jpg")).body.item;
    const video = (await uploadFixture(call, "clip-720p.mp4", "海边.mp4")).body.item;
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    // 预览比原来的消息上限 64KB 大得多也收
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300 * 1024, 7)]);
    const preview = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const send = (attachments, config = CONFIG) => call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "用这张当封面", config, attachments } });
    expect(await send(Array.from({ length: 5 }, () => ({ media_id: cover.id, preview })))).toEqual({ status: 422, body: { error: "too_many_attachments", message: "一次最多带 4 张图。" } });
    for (const attachments of [[{ media_id: video.id, preview }], [{ media_id: cover.id, preview: "data:image/jpeg;base64,AAAA" }], "封面"]) {
      expect(await send(attachments)).toEqual({ status: 422, body: { error: "invalid_attachment", message: "图片不对，换一张试试。" } });
    }
    const folder = path.join(directory, "ai-edit", "attachments", session.id);
    expect(existsSync(folder)).toBe(false);

    const sent = await send([{ media_id: cover.id, preview }]);
    expect(sent.status).toBe(202);
    expect(sent.body.session.messages[0].attachments).toEqual([{ media_id: cover.id, name: "封面.jpg" }]);
    await waitIdle(session.id);
    const files = await readdir(folder);
    expect(files).toEqual([expect.stringMatching(/^[0-9a-f]{16}\.jpg$/u)]);
    expect((await readFile(path.join(folder, files[0]))).equals(bytes)).toBe(true);
    const user = requests[0].messages.find((message) => message.role === "user");
    expect(user).not.toHaveProperty("attachments");
    expect(user.content[0].text).toContain(`用户这句话附了 1 张图：素材“封面.jpg”（media_id ${cover.id}）`);
    expect(user.content[1]).toEqual({ type: "image_url", image_url: { url: preview, detail: "low" } });
    // 页面上的会话里没有图的数据
    expect(JSON.stringify((await call(`/v1/ai-edit/sessions/${session.id}`)).body)).not.toContain("base64");

    // 换一个看不了图的模型：去掉图重发，这一轮的动作里说一声
    const blind = { ...CONFIG, model: "index-no-eyes" };
    const refusing = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.messages.some((message) => Array.isArray(message.content))) return new Response(JSON.stringify({ error: { message: "image input is not supported" } }), { status: 400 });
      return textReply("按名字放上去了");
    };
    const second = await start({ fetchImpl: refusing });
    const image = (await uploadFixture(second.call, "still.jpg", "封面.jpg")).body.item;
    const { session: other } = (await second.call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await second.call(`/v1/ai-edit/sessions/${other.id}/messages`, { method: "POST", body: { text: "用这张", config: blind, attachments: [{ media_id: image.id, preview }] } });
    const done = await second.waitIdle(other.id);
    expect(done.session.messages.at(-1)).toMatchObject({ text: "按名字放上去了", actions: [{ name: "see_images", summary: "这个模型看不了图片，只告诉了它图片的名字", ok: false }] });

    expect((await call(`/v1/ai-edit/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
  }, 20_000);

  it("tells the page once old turns had to be dropped, and reminds the model what the user said in them", async () => {
    const requests = [];
    const replies = [textReply("回".repeat(70_000)), textReply("回".repeat(70_000)), textReply("好")];
    const fetchImpl = async (_url, init) => { requests.push(JSON.parse(init.body)); return replies.shift(); };
    const { call, waitIdle } = await start({ fetchImpl });
    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    expect(session.trimmed).toBe(false);
    for (const text of ["先剪一版旅行片", "节奏快一点"]) {
      await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text, config: CONFIG } });
      expect((await waitIdle(session.id)).session.trimmed).toBe(false);
    }
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "再加个片尾", config: CONFIG } });
    const done = await waitIdle(session.id);
    expect(done.session.trimmed).toBe(true);
    expect(userContents(requests[2])[0]).toBe("【应用自动附上，不是用户说的话】更早的对话已经省略，用户之前说过：\n- 先剪一版旅行片\n【用户这次说的话】\n节奏快一点");
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

// ---------- 本机的 Codex / Claude Code ----------

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/local-ai/fake-cli.mjs");

async function fakeLocalAi(plan) {
  const directory = await temporaryDirectory("ai-edit-local-");
  const planFile = path.join(directory, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  const localAi = createLocalAi({
    dataDirectory: directory,
    resolve: async (id) => ({ command: process.execPath, prefix: [FAKE_CLI, id], env: {}, path: FAKE_CLI }),
    shellEnv: async () => ({ ...process.env, FAKE_PLAN: planFile, FAKE_RECORD: path.join(directory, "record.jsonl") }),
    proxy: async () => null,
  });
  cleanups.push(() => localAi.close());
  return { localAi, setPlan: (next) => writeFile(planFile, JSON.stringify(next)) };
}

describe("AI edit through a local CLI", () => {
  it("lists the local runtimes, skips the video probe, edits through MCP and stops mid tool call", async () => {
    const { localAi, setPlan } = await fakeLocalAi({ steps: [{ say: "先看看时间线" }, { call: "get_timeline" }, { say: "时间线是空的" }] });
    const fetchImpl = async () => { throw new Error("本机运行时不该请求接口"); };
    const { call, until, waitIdle } = await start({ localAi, fetchImpl });
    const { runtimes } = (await call("/v1/ai-edit/runtimes")).body;
    expect(runtimes).toEqual([
      { id: "codex", label: "Codex", state: "ready", version: "0.161.0", message: "已经找到 Codex 0.161.0，也登录好了。" },
      { id: "claude", label: "Claude Code", state: "ready", version: "2.1.280", message: "已经找到 Claude Code 2.1.280，也登录好了。" },
    ]);
    expect((await call("/v1/ai-edit/probe-video", { method: "POST", body: { config: { runtime: "claude" } } })).body).toEqual({ videoInput: false, answer: "" });

    const { session } = (await call("/v1/ai-edit/sessions", { method: "POST", body: {} })).body;
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "看看现在有什么", config: { runtime: "codex" } } });
    let done = await waitIdle(session.id);
    expect(done.session).toMatchObject({ status: "idle", error: null, streaming: null });
    expect(done.session.messages.at(-1)).toMatchObject({ role: "assistant", text: "先看看时间线\n\n时间线是空的", actions: [expect.objectContaining({ name: "get_timeline", ok: true })] });

    // 停在等页面测节拍的地方：点停止，CLI 被杀、这一轮标「已停止」
    const ids = { tone: (await uploadFixture(call, "tone.mp3", "配乐.mp3")).body.item.id };
    await setPlan({ steps: [{ say: "我来测节拍" }, { call: "detect_beats", arguments: { media_id: ids.tone } }, { say: "不该出现" }] });
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "做卡点", config: { runtime: "claude" } } });
    await until(async () => (await call(`/v1/ai-edit/sessions/${session.id}`)).body.session.streaming?.look, Boolean, "look job");
    await call(`/v1/ai-edit/sessions/${session.id}/stop`, { method: "POST", body: {} });
    done = await waitIdle(session.id);
    expect(done.session.status).toBe("idle");
    expect(done.session.messages.at(-1).text).toBe("我来测节拍\n\n（已停止）");

    // 没登录：不起进程，直接告诉用户怎么登录
    await setPlan({ authText: "Login: Expired — log in again" });
    await localAi.status("claude", { fresh: true });
    await call(`/v1/ai-edit/sessions/${session.id}/messages`, { method: "POST", body: { text: "继续", config: { runtime: "claude" } } });
    done = await waitIdle(session.id);
    expect(done.session).toMatchObject({ status: "failed", error: { code: "local_expired", message: expect.stringContaining("claude auth login") } });
  }, 30_000);
});
