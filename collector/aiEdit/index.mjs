import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { VideoDownloadError } from "../videoDownloader.mjs";
import { MAX_TOOL_CALLS, parseEditConfig, runConversation, sealHistory, trimHistory } from "./chat.mjs";
import { EditError } from "./errors.mjs";
import { AiEditError, MediaLibrary, isMediaId } from "./library.mjs";
import { SessionStore, isSessionId, sessionDetail } from "./sessions.mjs";
import { TOOL_DEFINITIONS, buildContextMessage, buildSystemPrompt, createToolRunner, describeToolError } from "./tools.mjs";

// AI 剪辑在采集器里的入口：会话、工程、素材库、对话循环和导入剪映草稿箱的 HTTP 接口。
// 数据都在采集器根数据目录的 ai-edit/ 下，不分抖音账号。server.mjs 在配对校验前后各调一次 handle：
// 校验前只处理带 key 的素材文件地址（<video>/<img> 带不了 Bearer），校验后（paired: true）处理其余接口。

const DEFAULT_TITLE = "未命名剪辑";
const DEFAULT_CANVAS = { width: 1080, height: 1920, fps: 30 };
const MESSAGE_BODY_BYTES = 64 * 1024;
const BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const STORED_HISTORY_CHARS = 600_000;
const STREAM_THROTTLE_MS = 150;
const REPAIR_FALLBACK = new Set(["DRAFT_BOX_NOT_FOUND", "DRAFT_BOX_NOT_OWNED", "DRAFT_BOX_PROJECT_MISMATCH"]);

function sendJson(response, status, payload, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AiEditError("body_too_large", "请求太大了。", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AiEditError("invalid_request", "请求无效，请重试。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiEditError("invalid_request", "请求无效，请重试。");
  return value;
}

/** 页面上要看的错误：AI 剪辑自己的错误原样回；原仓库移植来的错误换成中文。 */
function toHttpError(error) {
  if (error instanceof AiEditError) return error;
  if (error instanceof VideoDownloadError) return new AiEditError(error.code, error.message, error.code === "invalid_url" ? 400 : 409);
  if (error instanceof EditError) {
    const { text } = describeToolError(error);
    return new AiEditError(String(error.code).toLowerCase(), `${text}。`, error.status ?? 400);
  }
  console.error("AI 剪辑请求出错:", error);
  return new AiEditError("ai_edit_failed", "AI 剪辑出错了，请稍后重试。", 500);
}

function draftBoxError(error) {
  if (error instanceof AiEditError) return error;
  if (error?.code === "DRAFT_BOX_APP_RUNNING") return new AiEditError("jianying_running", "剪映正在运行，请先退出剪映再导入。", 409);
  if (error?.code === "DRAFT_BOX_PROCESS_CHECK_FAILED") return new AiEditError("jianying_running", "没法确认剪映有没有在运行，请先退出剪映再导入。", 409);
  if (error?.code === "DRAFT_BOX_WRITE_UNAVAILABLE") return new AiEditError("draft_box_unavailable", "没找到能写入的剪映草稿箱，先装好剪映、打开一次再试。", 503);
  // 时间线里有剪映不接受的设置（生成草稿时才查出来的）：重试没用，把原因交给用户和模型去改
  if (error instanceof EditError && error.status === 422) {
    const reason = error.code === "DRAFT_FEATURE_INVALID" ? "有剪映不接受的设置" : describeToolError(error).text;
    return new AiEditError("draft_invalid", `导不进剪映：${reason}（${String(error.message).slice(0, 200)}）。让 AI 改掉这一处再导入。`, 422);
  }
  console.error("导入剪映草稿箱失败:", error);
  return new AiEditError("export_failed", "没导进剪映草稿箱，请稍后重试。", 500);
}

/** 草稿箱状态：找不到或索引读不懂都算不可用，不让这个接口报错。 */
async function draftBoxStatus(draftBox) {
  try {
    return await draftBox.status();
  } catch (error) {
    return { status: "unavailable", reason: String(error?.code ?? "status_failed").toLowerCase(), platform: process.platform, jianyingRunning: false };
  }
}

function chatError(error) {
  if (error instanceof AiEditError) return { code: error.code, message: error.message };
  if (error?.name === "TimeoutError") return { code: "provider_timeout", message: "接口太久没回应，请稍后重试。" };
  console.error("AI 剪辑对话出错:", error);
  return { code: "chat_failed", message: "AI 这一轮没做完，请重试。" };
}

// 第一句话的第一个分句当临时名字（导入剪映后就是草稿名，不带省略号）；AI 剪完第一轮会按内容另起名。
function titleFrom(text) {
  const line = text.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  const clause = line.split(/[，。！？；,.!?;]/u).map((item) => item.trim()).find(Boolean) ?? line;
  return [...clause].slice(0, 20).join("");
}

/**
 * dataDirectory：采集器根数据目录；getCollector()：当前采集器（切换账号时为 null）；busyReason()：采集器正忙时的说明；
 * getExplorer()：探索（参考视频搜抖音用，切换账号时为 null）。
 * 测试可以注入 store / draftBox / probe / kindOf / fetchImpl。
 */
export function createAiEdit({
  dataDirectory,
  getCollector = () => null,
  busyReason = () => null,
  getExplorer = () => null,
  draftBox: injectedDraftBox,
  store: injectedStore,
  probe: injectedProbe,
  kindOf: injectedKindOf,
  fetchImpl = (...args) => fetch(...args),
  now = () => new Date(),
  pollMs = 1_000,
  longPollMs = 8_000,
  maxUploadBytes,
} = {}) {
  const root = path.join(dataDirectory, "ai-edit");
  const running = new Map();
  // 参考视频的解析结果，各会话共用（不进解析库）
  const references = new Map();
  const exporting = new Set();
  let closing = false;
  let state = null;

  const init = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // 剪映相关的模块（特效目录 1MB+、草稿序列化）第一次用到才加载
    const media = injectedProbe && injectedKindOf ? null : await import("./media.mjs");
    const probe = injectedProbe ?? media.probeMedia;
    const library = new MediaLibrary({
      directory: path.join(root, "media"), probe, kindOf: injectedKindOf ?? media.mediaKind,
      getCollector, busyReason, pollMs, now, ...(maxUploadBytes ? { maxUploadBytes } : {}),
    });
    await library.load();
    let store = injectedStore;
    if (!store) {
      const { ProjectStore } = await import("./projectStore.mjs");
      await mkdir(path.join(root, "projects"), { recursive: true, mode: 0o700 });
      store = new ProjectStore({ directory: path.join(root, "projects"), mediaRoots: [library.root], probe });
    }
    const draftBox = injectedDraftBox ?? (await import("./draftBox.mjs")).createDraftBox();
    const sessions = new SessionStore({ directory: path.join(root, "sessions"), now });
    await sessions.load();
    // 素材导入完成或失败时叫醒各会话的长轮询，页面跟着刷新素材栏
    library.subscribe(() => { for (const session of sessions.sessions.values()) void sessions.touch(session, { quiet: true }); });
    return { library, store, draftBox, sessions };
  };
  let ready = null;
  const load = () => {
    ready ??= init().catch((error) => { ready = null; throw error; });
    return ready;
  };

  const sessionState = async (session) => {
    let project = null;
    try { project = await state.store.getProject(session.projectId); } catch { /* 工程文件丢了就只回会话 */ }
    return { session: sessionDetail(session), project };
  };

  const requireSession = (id) => {
    const session = state.sessions.get(id);
    if (!session) throw new AiEditError("session_not_found", "这个剪辑不存在或已经删除了。", 404);
    return session;
  };

  const exportSession = async (session) => {
    const { store, draftBox, sessions, library } = state;
    if (exporting.has(session.id)) throw new AiEditError("session_busy", "正在导入剪映，请稍等。", 409);
    exporting.add(session.id);
    try {
      const status = await draftBoxStatus(draftBox);
      if (status?.status !== "available") throw new AiEditError("draft_box_unavailable", "没找到剪映的草稿箱，先装好剪映、打开一次再试。", 503);
      const project = await store.getProject(session.projectId);
      if (!project.tracks.some((track) => track.segments?.length)) throw new AiEditError("project_empty", "时间线还是空的，先让 AI 加点素材再导入。", 422);
      let media;
      try { media = await store.mediaInfos(project); }
      catch (error) {
        if (!(error instanceof EditError)) throw error;
        throw new AiEditError("media_missing", "有素材文件找不到了或者变了，先让 AI 把它从时间线上换掉再导入。", 422);
      }
      let draft = null;
      let created = false;
      if (session.draftBox?.draftId) {
        try { draft = await draftBox.repairDraft({ project, media, draftId: session.draftBox.draftId }); }
        catch (error) {
          // 用户在剪映里删掉了那份草稿（或那份已经不归我们管），就新建一份
          if (!REPAIR_FALLBACK.has(error?.code)) throw error;
        }
      }
      if (!draft) {
        draft = await draftBox.createDraft({ project, media, draftName: project.name });
        created = true;
      }
      // Windows 的草稿直接引用素材库里的文件（Mac 拷进了草稿自己的目录）：记在素材库里，会话删了也还在，删素材时要查
      if (!draftBox.profile?.cloneMaterials) {
        const paths = project.tracks.flatMap((track) => track.segments ?? []).map((segment) => segment.path);
        await library.recordDraft(draft, paths).catch((error) => console.error("AI 剪辑记录草稿用到的素材失败:", error));
      }
      session.draftBox = { draftId: draft.draftId, draftName: draft.draftName, exportedAt: now().toISOString(), exportedRevision: project.revision };
      await sessions.touch(session, { persist: true });
      return { draftId: draft.draftId, draftName: draft.draftName, path: draft.path, created };
    } catch (error) {
      throw draftBoxError(error);
    } finally {
      exporting.delete(session.id);
    }
  };

  const runTurn = async (session, config, signal, release = () => undefined) => {
    const { store, library, sessions } = state;
    const streaming = session.streaming;
    let timer = null;
    let flushedAt = 0;
    const flush = () => {
      timer = null;
      flushedAt = Date.now();
      void sessions.touch(session);
    };
    const onText = (text) => {
      streaming.text = text;
      // 流式文字大约 150ms 叫醒一次页面
      timer ??= setTimeout(flush, Math.max(0, STREAM_THROTTLE_MS - (Date.now() - flushedAt)));
    };
    const runTool = createToolRunner({
      store, library, projectId: session.projectId, getCollector, signal,
      getExplorer, config, references, fetchImpl, pollMs,
      exportDraft: () => exportSession(session),
      onRename: (name) => { session.title = name; },
    });
    let text = "";
    let status = "idle";
    let error = null;
    let stopped = false;
    try {
      const result = await runConversation({
        config, history: session.history, tools: TOOL_DEFINITIONS, signal, fetchImpl, onText, maxToolCalls: MAX_TOOL_CALLS,
        // 系统提示只放不常变的；工程现状每步都变，附在每次请求的最后，不打断接口的前缀缓存
        system: async () => buildSystemPrompt({ project: await store.getProject(session.projectId), media: library.list() }),
        context: async () => buildContextMessage({ project: await store.getProject(session.projectId), library }),
        execute: async (call) => {
          const { result: output, action } = await runTool(call.name, call.arguments);
          streaming.actions.push(action);
          await sessions.touch(session);
          return output;
        },
      });
      text = result.text;
    } catch (failure) {
      sealHistory(session.history, closing ? "采集器关掉了，这个工具没有执行。" : undefined);
      text = streaming.text;
      if (closing) {
        status = "failed";
        error = { code: "interrupted", message: "采集器关掉了，这一轮没做完，可以接着说。" };
      } else if (signal.aborted && failure?.name !== "TimeoutError") {
        stopped = true;
      } else {
        status = "failed";
        error = chatError(failure);
      }
    } finally {
      clearTimeout(timer);
    }
    const actions = streaming.actions;
    if (stopped) text = text ? `${text}\n\n（已停止）` : "（已停止）";
    if (text || actions.length) {
      session.messages.push({ id: randomBytes(8).toString("hex"), role: "assistant", text, at: now().toISOString(), ...(actions.length ? { actions } : {}) });
    }
    session.history = trimHistory(session.history, STORED_HISTORY_CHARS);
    // 先让出「正在跑」再写空闲：页面一看到空闲就可能马上点导入，不能撞上 session_busy
    release();
    Object.assign(session, { streaming: null, status, error });
    await sessions.touch(session, { persist: true });
  };

  const startTurn = async (session, text, config) => {
    const { store, sessions } = state;
    const controller = new AbortController();
    const run = { controller, promise: null };
    running.set(session.id, run);
    const first = !session.messages.some((item) => item.role === "user");
    session.messages.push({ id: randomBytes(8).toString("hex"), role: "user", text, at: now().toISOString() });
    session.history.push({ role: "user", content: text });
    Object.assign(session, { status: "running", error: null, streaming: { text: "", actions: [] } });
    if (first && session.title === DEFAULT_TITLE && titleFrom(text)) {
      // 没起名的剪辑用第一句话当名字，工程名（导入剪映后的草稿名）跟着改
      session.title = titleFrom(text);
      try { await store.updateProject(session.projectId, { name: session.title }); } catch { /* 改不了工程名不影响对话 */ }
    }
    await sessions.touch(session, { persist: true });
    const release = () => { if (running.get(session.id) === run) running.delete(session.id); };
    run.promise = runTurn(session, config, controller.signal, release)
      .catch((error) => console.error("AI 剪辑对话收尾失败:", error))
      .finally(release);
  };

  const stopRun = async (id, timeoutMs = 5_000) => {
    const run = running.get(id);
    if (!run) return;
    run.controller.abort();
    await Promise.race([run.promise, delay(timeoutMs)]);
  };

  const mediaInUse = async (item) => {
    const target = state.library.filePath(item);
    for (const session of state.sessions.sessions.values()) {
      let project;
      try { project = await state.store.getProject(session.projectId); } catch { continue; }
      if (project.tracks.some((track) => track.segments?.some((segment) => segment.path === target))) return true;
    }
    return false;
  };

  const handleMediaFile = async (request, response, id, url) => {
    const { library } = state;
    const item = isMediaId(id) ? library.get(id) : null;
    // key 不对和没有这个素材回一样的结果，不让人猜 id
    if (!item || item.status !== "ready" || !library.checkKey(url.searchParams.get("key"))) {
      sendJson(response, 404, { error: "media_not_found", message: "没有这个素材。" });
      return;
    }
    await library.send(request, response, item);
  };

  const route = async (request, response, url) => {
    const { library, store, draftBox, sessions } = state;
    const method = request.method;
    const pathname = url.pathname;
    const notAllowed = () => sendJson(response, 405, { error: "method_not_allowed", message: "不支持这个操作。" });

    if (pathname === "/v1/ai-edit/sessions") {
      if (method === "GET") { sendJson(response, 200, { sessions: sessions.list() }); return; }
      if (method !== "POST") { notAllowed(); return; }
      const body = await readJson(request, BODY_BYTES);
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : DEFAULT_TITLE;
      if (body.canvas !== undefined && (!body.canvas || typeof body.canvas !== "object" || Array.isArray(body.canvas))) {
        throw new AiEditError("invalid_canvas", "画布尺寸不对。", 422);
      }
      let project;
      try {
        project = await store.createProject({ name: title, canvas: body.canvas ? { ...DEFAULT_CANVAS, ...body.canvas } : { ...DEFAULT_CANVAS } });
      } catch (error) {
        if (error instanceof EditError) throw new AiEditError("invalid_canvas", "画布宽高要在 16 到 7680 之间的整数，帧率 1 到 120。", 422);
        throw error;
      }
      const session = await sessions.create({ title, projectId: project.id });
      sendJson(response, 201, { session: sessionDetail(session), project });
      return;
    }

    const sessionMatch = pathname.match(/^\/v1\/ai-edit\/sessions\/([^/]+)(?:\/(messages|stop|export))?$/u);
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      if (!isSessionId(id)) throw new AiEditError("session_not_found", "这个剪辑不存在或已经删除了。", 404);
      if (!action && method === "GET") {
        let session = requireSession(id);
        const after = url.searchParams.get("afterRevision");
        if (after !== null) {
          if (!/^\d+$/u.test(after) || !Number.isSafeInteger(Number(after))) throw new AiEditError("invalid_revision", "请求无效，请重试。");
          const gone = new AbortController();
          const abort = () => gone.abort();
          response.once("close", abort);
          await sessions.wait(id, Number(after), { timeoutMs: closing ? 0 : longPollMs, signal: gone.signal });
          response.off("close", abort);
          if (response.destroyed) return;
          session = requireSession(id);
        }
        sendJson(response, 200, await sessionState(session));
        return;
      }
      if (!action && method === "DELETE") {
        const session = requireSession(id);
        await stopRun(id);
        await sessions.remove(id);
        try { await store.deleteProject(session.projectId); } catch { /* 工程已经没了 */ }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (!action || method !== "POST") { notAllowed(); return; }
      if (action === "messages") {
        const body = await readJson(request, MESSAGE_BODY_BYTES);
        const session = requireSession(id);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new AiEditError("invalid_request", "先输入想怎么剪。");
        if (text.length > MAX_MESSAGE_CHARS) throw new AiEditError("message_too_long", "这条消息太长了，分几次说。");
        const config = parseEditConfig(body.config);
        if (running.has(id)) throw new AiEditError("session_busy", "AI 还在处理上一条，等它做完或先停止。", 409);
        if (exporting.has(id)) throw new AiEditError("session_busy", "正在导入剪映，请稍等。", 409);
        await startTurn(session, text, config);
        sendJson(response, 202, { session: sessionDetail(session) });
        return;
      }
      if (action === "stop") {
        await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        await stopRun(id);
        sendJson(response, 200, { session: sessionDetail(session) });
        return;
      }
      await readJson(request, BODY_BYTES);
      const session = requireSession(id);
      if (running.has(id)) throw new AiEditError("session_busy", "AI 还在改时间线，等它做完再导入。", 409);
      const result = await exportSession(session);
      sendJson(response, 200, { session: sessionDetail(session), result });
      return;
    }

    if (pathname === "/v1/ai-edit/draft-box") {
      if (method !== "GET") { notAllowed(); return; }
      const status = await draftBoxStatus(draftBox);
      sendJson(response, 200, {
        status: status?.status === "available" ? "available" : "unavailable",
        reason: status?.reason ?? null,
        platform: status?.platform ?? process.platform,
        jianyingRunning: Boolean(status?.jianyingRunning),
      });
      return;
    }

    if (pathname === "/v1/ai-edit/media") {
      if (method !== "GET") { notAllowed(); return; }
      sendJson(response, 200, { media: library.list(), key: library.key });
      return;
    }
    if (pathname === "/v1/ai-edit/media/douyin") {
      if (method !== "POST") { notAllowed(); return; }
      const body = await readJson(request, BODY_BYTES);
      sendJson(response, 202, { item: await library.importDouyin(body) });
      return;
    }
    if (pathname === "/v1/ai-edit/media/upload") {
      if (method !== "POST") { notAllowed(); return; }
      try {
        const item = await library.upload(request, url.searchParams.get("name"), { contentLength: request.headers["content-length"] });
        sendJson(response, 201, { item });
      } catch (error) {
        // 没读完的请求体不再收了，回完错误就断开
        if (!request.complete) response.setHeader("Connection", "close");
        throw error;
      }
      return;
    }
    const mediaMatch = pathname.match(/^\/v1\/ai-edit\/media\/([^/]+)$/u);
    if (mediaMatch) {
      if (method !== "DELETE") { notAllowed(); return; }
      const item = isMediaId(mediaMatch[1]) ? library.get(mediaMatch[1]) : null;
      if (!item) throw new AiEditError("media_not_found", "素材库里没有这个素材。", 404);
      if (await mediaInUse(item)) throw new AiEditError("media_in_use", "有剪辑正在用这个素材，先从时间线上去掉再移除。", 409);
      const draft = await library.draftUsing(item);
      if (draft) throw new AiEditError("media_in_draft", `剪映草稿「${draft.name}」直接用着这个素材文件，先在剪映里删掉那份草稿再移除。`, 409);
      await library.remove(item.id);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  };

  return {
    async handle(request, response, url, { paired = false } = {}) {
      if (!url.pathname.startsWith("/v1/ai-edit/")) return false;
      const fileMatch = url.pathname.match(/^\/v1\/ai-edit\/media\/([^/]+)\/file$/u);
      if (!paired && !(fileMatch && request.method === "GET")) return false;
      try {
        try { state ??= await load(); }
        catch (error) {
          console.error("AI 剪辑没能启动:", error);
          throw new AiEditError("ai_edit_unavailable", "AI 剪辑没能启动，请重启应用。", 503);
        }
        if (fileMatch && request.method === "GET") await handleMediaFile(request, response, fileMatch[1], url);
        else await route(request, response, url);
      } catch (error) {
        const failure = toHttpError(error);
        sendJson(response, failure.status, { error: failure.code, message: failure.message });
      }
      return true;
    },

    async close() {
      closing = true;
      if (!state) return;
      state.library.close();
      for (const run of running.values()) run.controller.abort();
      state.sessions.wakeAll();
      await Promise.race([Promise.allSettled([...running.values()].map((run) => run.promise)), delay(3_000)]);
      await state.sessions.flush();
    },
  };
}
