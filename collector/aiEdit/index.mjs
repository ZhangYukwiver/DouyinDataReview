import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { modelFetch } from "../systemProxy.mjs";
import { VideoDownloadError } from "../videoDownloader.mjs";
import { MAX_TOOL_CALLS, parseEditConfig, runConversation, sealHistory, trimHistory } from "./chat.mjs";
import { EditError } from "./errors.mjs";
import { AiEditError, MediaLibrary, isMediaId } from "./library.mjs";
import { createLookDesk } from "./look.mjs";
import { SessionStore, isSessionId, revertTarget, sessionDetail } from "./sessions.mjs";
import {
  TOOL_DEFINITIONS, buildContextMessage, buildSystemPrompt, clipLabel, createToolRunner, describeToolError, micros, probeVideoInput, rearrangeGrids, seconds, trackLabel,
} from "./tools.mjs";

// AI 剪辑在采集器里的入口：会话、工程、素材库、对话循环和导入剪映草稿箱的 HTTP 接口。
// 数据都在采集器根数据目录的 ai-edit/ 下，不分抖音账号。server.mjs 在配对校验前后各调一次 handle：
// 校验前只处理带 key 的素材文件地址（<video>/<img> 带不了 Bearer），校验后（paired: true）处理其余接口。

const DEFAULT_TITLE = "未命名剪辑";
const DEFAULT_CANVAS = { width: 1080, height: 1920, fps: 30 };
const MESSAGE_BODY_BYTES = 64 * 1024;
const BODY_BYTES = 16 * 1024;
// 页面交回的参考视频截图：最多 40 张小 JPEG
const LOOK_BODY_BYTES = 24 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_GOAL_CHARS = 2_000;
const pickCanvas = (body) => Object.fromEntries(["width", "height", "fps"].filter((key) => body?.[key] !== undefined).map((key) => [key, body[key]]));
const STORED_HISTORY_CHARS = 600_000;
const STREAM_THROTTLE_MS = 150;
const REPAIR_FALLBACK = new Set(["DRAFT_BOX_NOT_FOUND", "DRAFT_BOX_NOT_OWNED", "DRAFT_BOX_PROJECT_MISMATCH"]);
const EXPORT_MODES = new Set(["auto", "new", "update"]);
// 没存指纹的老会话：索引里的修改时间比导出时间晚这么多才算在剪映里动过
const DRAFT_CHANGED_AFTER_MS = 10_000;
// 看板上能手动做的改动和各自放开的参数（null 是照工具定义）；update_clip 只放开时间、截取、倍速、文字和位置大小，update_track 只放开静音
const BOARD_EDITS = new Map([
  ["move_clip", null],
  ["update_clip", new Set(["clip_id", "start", "duration", "source_start", "source_duration", "speed", "text", "transform"])],
  ["split_clip", null],
  ["delete_clip", null],
  ["duplicate_clip", null],
  ["update_track", new Set(["track_id", "mute"])],
  ["reorder_tracks", null],
]);
// 一批手动改动（多选、整组挪）最多几条、请求体最大多少；超过 8 条给模型的说明并成一句
const MAX_BATCH_EDITS = 50;
const EDIT_BODY_BYTES = 64 * 1024;
const MAX_BATCH_NOTES = 8;
const MAX_PENDING_NOTES = 30;
const MAX_REGION_CLIPS = 30;
const MEDIA_KINDS = new Set(["video", "image", "audio"]);

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

/** 一句话的前几个字（换行和连续空白并成一个空格）。 */
const leading = (text, count) => [...String(text ?? "").replace(/\s+/gu, " ").trim()].slice(0, count).join("");
const sentence = (text) => (/[。！？]$/u.test(text) ? text : `${text}。`);
const percent = (value) => `${Math.round(value * 1000) / 10}%`;

/** 页面框选的范围：比例坐标（从画布左上角量）+ 那一刻框里的片段，只留工程里真有的。 */
function parseRegion(raw, project) {
  const bad = () => new AiEditError("invalid_region", "框选的范围不对，重新框一下。", 422);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const { time_us: time, x, y, width, height, clip_ids: ids = [] } = raw;
  const unit = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!Number.isSafeInteger(time) || time < 0 || ![x, y, width, height].every(unit) || width <= 0 || height <= 0
    || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) throw bad();
  if (!Array.isArray(ids) || ids.length > MAX_REGION_CLIPS || !ids.every((item) => typeof item === "string")) throw bad();
  const segments = new Map(project.tracks.flatMap((track) => (track.segments ?? []).map((segment) => [segment.id, segment])));
  const clipIds = [...new Set(ids)].filter((item) => segments.has(item));
  return { time_us: time, x, y, width, height, clip_ids: clipIds, labels: clipIds.map((item) => clipLabel(segments.get(item))) };
}

function describeRegion({ time_us: time, x, y, width, height, clip_ids: ids, labels }) {
  const where = `用户在画面上框了一块：时刻 ${seconds(time)} 秒，横向 ${percent(x)}–${percent(x + width)}、纵向 ${percent(y)}–${percent(y + height)}（从画面左上角量）。`;
  if (!ids.length) return `${where}框里没有片段，是画面上的这块空白位置。用户这次说的「这里」「这块」指的就是这个位置。`;
  const inside = ids.map((item, index) => `clip_id ${item}（${labels[index]}）`).join("、");
  return `${where}框里有：${inside}。用户这次说的「这里」「这块」「这个」指的就是框里这些，只改它们，框外的别动，除非用户明说。`;
}

/** 进模型历史的这条用户消息：前面附上用户在看板上手动改过的地方和框选；都没有就是原话。 */
function userContent(text, notes, region) {
  if (!notes.length && !region) return text;
  return [
    "【应用自动附上，不是用户说的话】",
    ...(notes.length ? ["用户在看板上手动改过（以工程现状为准，这些是用户自己改的，别改回去，除非用户这次明说）：", ...notes.map((note) => `- ${note}`)] : []),
    ...(region ? [describeRegion(region)] : []),
    "【用户这次说的话】",
    text,
  ].join("\n");
}

/** 记一句给模型看的手动改动说明；太多了最后一条并成「还有 N 处」。 */
function addNote(session, note) {
  const notes = session.pendingNotes;
  if (notes.length < MAX_PENDING_NOTES) {
    notes.push(note);
    return;
  }
  const more = /^还有 (\d+) 处/u.exec(notes[MAX_PENDING_NOTES - 1]);
  notes[MAX_PENDING_NOTES - 1] = `还有 ${(more ? Number(more[1]) : 1) + 1} 处手动改动没一一列出，以工程现状为准`;
}

/** 看板发来的改动：一条 { name, arguments }，或者一批 { edits: [...] }。只放开看板上能做的那几种、那几项。 */
function boardEdits(body) {
  const notAllowed = () => new AiEditError("edit_not_allowed", "这个改动不能在看板上做。", 422);
  const edits = body.edits === undefined ? [{ name: body.name, arguments: body.arguments }] : body.edits;
  if (!Array.isArray(edits) || !edits.length) throw notAllowed();
  if (edits.length > MAX_BATCH_EDITS) throw new AiEditError("too_many_edits", `一次最多改 ${MAX_BATCH_EDITS} 处。`, 422);
  for (const edit of edits) {
    const keys = BOARD_EDITS.get(edit?.name);
    const args = edit?.arguments;
    if (keys === undefined || !args || typeof args !== "object" || Array.isArray(args)
      || (keys && Object.keys(args).some((key) => !keys.has(key)))
      || (edit.name === "update_track" && typeof args.mute !== "boolean")) throw notAllowed();
  }
  return edits.map(({ name, arguments: args }) => ({ name, args }));
}

const TRANSFORM_PARTS = [["位置", ["transform_x", "transform_y"]], ["大小", ["scale_x", "scale_y"]], ["角度", ["rotation"]], ["不透明度", ["alpha"]], ["翻转", ["flip_horizontal", "flip_vertical"]]];
const TRANSFORM_DEFAULTS = { scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false };

/** 位置、大小、角度这些里实际变了哪几样（没设过的按默认值比）。 */
function transformChanges(before, after) {
  const value = (transform, key) => transform?.[key] ?? TRANSFORM_DEFAULTS[key];
  const differs = (key) => {
    const [left, right] = [value(before, key), value(after, key)];
    return typeof left === "number" && typeof right === "number" ? Math.abs(left - right) > 1e-9 : left !== right;
  };
  return TRANSFORM_PARTS.filter(([, keys]) => keys.some(differs)).map(([part]) => part);
}

function locate(project, clipId) {
  for (const track of project?.tracks ?? []) {
    const segment = (track.segments ?? []).find((item) => item.id === clipId);
    if (segment) return { track, segment };
  }
  return null;
}

const trackRef = (track) => `“${trackLabel(track)}”（track_id ${track?.id}）`;

/** 轨道顺序只动了一条、挪到了最上或最下（列表越靠后越在上层）：回 [轨道, "最上层" | "最下层"]，否则 null。 */
function movedToEdge(before, after) {
  const [from, to] = [before.tracks.map((track) => track.id), after.tracks.map((track) => track.id)];
  const same = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);
  const without = (id) => from.filter((item) => item !== id);
  const pick = (id) => after.tracks.find((track) => track.id === id);
  if (to.length && from.at(-1) !== to.at(-1) && same(without(to.at(-1)), to.slice(0, -1))) return [pick(to.at(-1)), "最上层"];
  if (to.length && from[0] !== to[0] && same(without(to[0]), to.slice(1))) return [pick(to[0]), "最下层"];
  return null;
}

/**
 * 看板上的一步改动：撤销按钮上的说法 label、给模型看的说明 note（片段带上 clip_id），都按改动前后的工程写。
 * before、after 是这一步前后的工程，result 是工具回给模型的结果。
 */
function describeEdit(name, args, before, after, result) {
  if (name === "update_track") {
    const track = after.tracks.find((item) => item.id === args.track_id);
    const named = `“${trackLabel(track)}”`;
    return args.mute ? { label: `静音${named}`, note: `把${trackRef(track)}静音了` } : { label: `取消${named}的静音`, note: `取消了${trackRef(track)}的静音` };
  }
  if (name === "reorder_tracks") {
    const edge = movedToEdge(before, after);
    if (!edge) return { label: "调整轨道的上下层", note: "调整了轨道的上下层顺序" };
    const [track, side] = edge;
    return { label: `把“${trackLabel(track)}”移到${side}`, note: `把${trackRef(track)}移到了${side}` };
  }
  const was = locate(before, args.clip_id);
  const label = clipLabel(was?.segment);
  const ref = `${label}（clip_id ${args.clip_id}）`;
  if (name === "delete_clip") return { label: `删掉${label}`, note: `删掉了${ref}` };
  if (name === "split_clip") {
    const at = typeof micros(args.offset) === "number" && was ? `在 ${seconds(was.segment.timeline.start_us + micros(args.offset))} 秒处` : "";
    const parts = result.clip_ids?.length === 2 ? `，现在是 clip_id ${result.clip_ids[0]} 和 clip_id ${result.clip_ids[1]} 两段` : "";
    return { label: `切开${label}`, note: `${at}切开了${ref}${parts}` };
  }
  // 换了轨道就写上是哪条
  const onto = (now) => (now.track.id === was?.track.id ? "" : `${trackRef(now.track)}上，`);
  if (name === "duplicate_clip") {
    const copy = locate(after, result.clip_id);
    const where = copy ? `，新的一段是 clip_id ${copy.segment.id}，放在${onto(copy) || "同一条轨道上，"}${seconds(copy.segment.timeline.start_us)} 秒开始` : "";
    return { label: `复制${label}`, note: `复制了${ref}${where}` };
  }
  const now = locate(after, args.clip_id);
  if (!now) return { label: `修改${label}`, note: `改了${ref}` };
  if (name === "move_clip") {
    const target = onto(now);
    return { label: `挪动${label}`, note: `把${ref}挪到了${target || " "}${seconds(now.segment.timeline.start_us)} 秒开始` };
  }
  // update_clip
  const keys = Object.keys(args).filter((key) => key !== "clip_id" && args[key] !== undefined);
  const changed = keys.includes("transform") ? transformChanges(was?.segment.transform, now.segment.transform) : [];
  const only = (key) => keys.length > 0 && keys.every((item) => item === key);
  let short = `修改${label}`;
  if (keys.includes("text")) short = `改${label}`;
  else if (only("transform")) short = changed.length ? `调整${label}的${changed.join("、")}` : short;
  else if (only("start")) short = `挪动${label}`;
  else if (keys.some((key) => ["duration", "source_start", "source_duration"].includes(key))) short = `裁剪${label}`;
  else if (only("speed")) short = `给${label}变速`;
  const { segment } = now;
  if (only("text")) return { label: short, note: `把${ref}改成了“${leading(segment.text, 40)}”` };
  const parts = [];
  if (keys.includes("text")) parts.push(`文字改成了“${leading(segment.text, 40)}”`);
  if (keys.includes("start") || keys.includes("duration")) parts.push(`时间改成了 ${seconds(segment.timeline.start_us)} 秒开始、长 ${seconds(segment.timeline.duration_us)} 秒`);
  if ((keys.includes("source_start") || keys.includes("source_duration")) && segment.source) {
    parts.push(`改成从素材第 ${seconds(segment.source.start_us)} 秒开始截取 ${seconds(segment.source.duration_us)} 秒`);
  }
  // 看板裁剪时会带上原来的倍速，没变就不提
  if (keys.includes("speed") && Number(was?.segment.speed ?? 1) !== Number(segment.speed ?? 1)) parts.push(`倍速改成了 ${Math.round((segment.speed ?? 1) * 1000) / 1000} 倍`);
  if (changed.length) parts.push(`调了${changed.join("、")}`);
  return { label: short, note: parts.length ? `改了${ref}：${parts.join("，")}` : `改了${ref}` };
}

/** 一批改动在撤销按钮上的说法：同一种操作说「挪动了 3 段」，混着的说「改了 3 处」。 */
function batchLabel(steps) {
  if (steps.length === 1) return steps[0].label;
  const verbs = { move_clip: "挪动了", delete_clip: "删了", duplicate_clip: "复制了", split_clip: "切开了" };
  const verb = steps.every((step) => step.name === steps[0].name) ? verbs[steps[0].name] : null;
  return verb ? `${verb} ${steps.length} 段` : `改了 ${steps.length} 处`;
}

/** 一批改动给模型的说明：不多就每步一句，多了并成一句、列出涉及的片段。 */
function batchNotes(steps, label) {
  if (steps.length <= MAX_BATCH_NOTES) return steps.map((step) => step.note);
  const ids = [...new Set(steps.flatMap((step) => [step.args.clip_id, step.result.clip_id, ...(step.result.clip_ids ?? [])]))]
    .filter((item) => typeof item === "string");
  return [`一次${label}${ids.length ? `，涉及 clip_id ${ids.join("、")}` : ""}`];
}

function undoNote(checkpoint) {
  if (checkpoint.kind === "turn") return `撤销了上一步，时间线回到了${checkpoint.label}的样子`;
  if (checkpoint.kind === "revert") return "撤销了刚才的退回";
  return `撤销了上一步（${checkpoint.label}）`;
}

/** 在操作历史里一次撤好几步：回到 target 那一步之前（AI 那一轮的说法本身带着「之前」）。 */
const undoManyNote = (count, target) => `撤销了 ${count} 步，时间线回到了${target.label.replace(/之前$/u, "")}之前的样子`;

function redoNote(step) {
  if (step.kind === "turn") return `重做了刚才撤销的一步，时间线回到了${step.label.replace(/之前$/u, "之后")}的样子`;
  if (step.kind === "revert") return "重做了刚才撤销的退回";
  return `重做了：${step.label}`;
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
  fetchImpl = modelFetch,
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
    const sessions = new SessionStore({ directory: path.join(root, "sessions"), checkpointDirectory: path.join(root, "checkpoints"), now });
    await sessions.load();
    // 素材导入完成或失败时叫醒各会话的长轮询，页面跟着刷新素材栏
    library.subscribe(() => { for (const session of sessions.sessions.values()) void sessions.touch(session, { quiet: true }); });
    return { library, store, draftBox, sessions, looks: createLookDesk() };
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

  /** 上次导入后用户在剪映里打开或改过那份草稿：抛 draft_changed，什么都不写。草稿没了或看不出来就照旧。 */
  const checkDraftUnchanged = async (session) => {
    const { draftBox } = state;
    if (typeof draftBox.fingerprint !== "function") return;
    const { draftId, draftName, fingerprint, exportedAt } = session.draftBox;
    let changed;
    try {
      if (typeof fingerprint === "string") changed = (await draftBox.fingerprint(draftId)) !== fingerprint;
      else {
        // 加指纹之前导出的会话：拿索引里的修改时间和导出时间比
        const modified = Date.parse((await draftBox.getDraft(draftId))?.draft?.modified_at ?? "");
        changed = modified - Date.parse(exportedAt ?? "") > DRAFT_CHANGED_AFTER_MS;
      }
    } catch {
      return; // 草稿被删了（下面会新建）或者读不出来（照旧更新）
    }
    if (changed) throw new AiEditError("draft_changed", `剪映里的「${draftName}」在上次导入后被打开或改过。`, 409);
  };

  /** mode：auto 草稿在剪映里被改过就停下；new 另存一份新草稿；update 直接覆盖。 */
  const exportSession = async (session, { mode = "auto" } = {}) => {
    const { store, draftBox, sessions, library } = state;
    if (!EXPORT_MODES.has(mode)) throw new AiEditError("invalid_request", "导入方式不对，请重试。", 422);
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
      if (session.draftBox?.draftId && mode !== "new") {
        if (mode === "auto") await checkDraftUnchanged(session);
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
      // 记下导完那一刻草稿的样子，下次导入前对一下有没有在剪映里被动过
      const fingerprint = typeof draftBox.fingerprint === "function" ? await draftBox.fingerprint(draft.draftId).catch(() => null) : null;
      session.draftBox = {
        draftId: draft.draftId, draftName: draft.draftName, exportedAt: now().toISOString(), exportedRevision: project.revision,
        ...(typeof fingerprint === "string" ? { fingerprint } : {}),
      };
      await sessions.touch(session, { persist: true });
      return { draftId: draft.draftId, draftName: draft.draftName, path: draft.path, created };
    } catch (error) {
      throw draftBoxError(error);
    } finally {
      exporting.delete(session.id);
    }
  };

  const runTurn = async (session, config, signal, release = () => undefined, turn = {}) => {
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
      // 活儿挂在这一轮上（streaming 不存盘），页面长轮询看到后接手
      askLook: (request) => state.looks.ask({
        id: session.id,
        live: () => Boolean(session.streaming),
        get: () => session.streaming?.look ?? null,
        set: (look) => { if (session.streaming) session.streaming.look = look; },
        touch: () => void sessions.touch(session, { quiet: true }),
      }, request, { signal }),
      offerLookFile: (file) => state.looks.offerFile(file),
      exportDraft: (mode) => exportSession(session, { mode }),
      onRename: (name) => { session.title = name; },
      // arrange_grid 排过的格子记在会话上（跟着会话存盘），换画布时按新画布重排
      grids: session.grids,
    });
    let text = "";
    let status = "idle";
    let error = null;
    let stopped = false;
    try {
      const result = await runConversation({
        config, history: session.history, tools: TOOL_DEFINITIONS, signal, fetchImpl, onText, maxToolCalls: MAX_TOOL_CALLS,
        // 系统提示只放不常变的；工程现状每步都变，附在每次请求的最后，不打断接口的前缀缓存
        // 目标每次请求都读最新的：一轮做到一半改了，下一步就照新的来
        system: async () => buildSystemPrompt({ project: await store.getProject(session.projectId), media: library.list(), goal: session.goal }),
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
    // 这一轮没动工程就不留开跑前的存档；动了的话之前撤销掉的就不能再重做了（看不出动没动也按动了算）
    const revision = await store.getProject(session.projectId).then((project) => project.revision, () => null);
    if (turn.checkpoint && revision === turn.revision) await sessions.dropCheckpoint(session, turn.checkpoint.id).catch(() => undefined);
    if (revision === null || revision !== turn.revision) await sessions.clearRedo(session).catch(() => undefined);
    // 先让出「正在跑」再写空闲：页面一看到空闲就可能马上点导入，不能撞上 session_busy
    release();
    Object.assign(session, { streaming: null, status, error });
    await sessions.touch(session, { persist: true });
  };

  const startTurn = async (session, text, config, region = null) => {
    const { store, sessions } = state;
    const controller = new AbortController();
    const run = { controller, promise: null };
    // 先占住「正在跑」再存档：存档要读写盘，这期间别的请求不能插进来
    running.set(session.id, run);
    const turn = {};
    try {
      // 每轮开跑前存一份，可以撤销这一轮或者退回到这句话之前
      const { checkpoint, revision } = await saveCheckpoint(session, "turn", `AI 处理“${leading(text, 12)}”之前`);
      Object.assign(turn, { checkpoint, revision });
    } catch (error) {
      console.error("AI 剪辑存档失败:", error);
    }
    const first = !session.messages.some((item) => item.role === "user");
    session.messages.push({ id: randomBytes(8).toString("hex"), role: "user", text, at: now().toISOString(), ...(region ? { region } : {}) });
    // 模型看到的这条消息前面附上看板上的手动改动和框选；页面上显示的还是原话
    session.history.push({ role: "user", content: userContent(text, session.pendingNotes, region) });
    session.pendingNotes = [];
    Object.assign(session, { status: "running", error: null, streaming: { text: "", actions: [] } });
    if (first && session.title === DEFAULT_TITLE && titleFrom(text)) {
      // 没起名的剪辑用第一句话当名字，工程名（导入剪映后的草稿名）跟着改
      session.title = titleFrom(text);
      try {
        const renamed = await store.updateProject(session.projectId, { name: session.title });
        // 改名不算这一轮的改动
        if (turn.checkpoint) turn.revision = renamed.revision;
      } catch { /* 改不了工程名不影响对话 */ }
    }
    await sessions.touch(session, { persist: true });
    const release = () => { if (running.get(session.id) === run) running.delete(session.id); };
    run.promise = runTurn(session, config, controller.signal, release, turn)
      .catch((error) => console.error("AI 剪辑对话收尾失败:", error))
      .finally(release);
  };

  // 看板上的手动改动、撤销、重做、退回、换画面比例共用一把锁；AI 在剪或正在导入剪映时都不做
  const editing = new Set();
  const lockEdit = (id) => {
    if (running.has(id)) throw new AiEditError("session_busy", "AI 正在剪，等它做完再改。", 409);
    if (exporting.has(id)) throw new AiEditError("session_busy", "正在导入剪映，请稍等。", 409);
    if (editing.has(id)) throw new AiEditError("session_busy", "上一个改动还没做完，请稍等。", 409);
    editing.add(id);
    return () => editing.delete(id);
  };

  /** 现在整个工程的样子（连同 arrange_grid 排过的格子）。回 { snapshot, revision }。 */
  const snapshotNow = async (session) => {
    const { name, canvas, tracks, markers, revision } = await state.store.getProject(session.projectId);
    return { snapshot: { project: { name, canvas, tracks, markers }, grids: structuredClone(session.grids) }, revision };
  };

  /** 存一份现在的样子，撤销、退回用；messageIndex 不给就记在现在这句之后。回 { checkpoint, revision, snapshot }。 */
  const saveCheckpoint = async (session, kind, label, messageIndex) => {
    const { snapshot, revision } = await snapshotNow(session);
    return { checkpoint: await state.sessions.addCheckpoint(session, { kind, label, snapshot, messageIndex }), revision, snapshot };
  };

  /** 读存档；文件没了、读不出来或不像工程的回 null。 */
  const readCheckpoint = async (session, checkpoint) => {
    try {
      const snapshot = await state.sessions.readCheckpoint(session, checkpoint.id);
      if (Array.isArray(snapshot?.project?.tracks)) return snapshot;
    } catch (error) {
      console.error("AI 剪辑读存档失败:", error);
    }
    return null;
  };

  /** 存档里用到的素材都还在素材库里才回得去：回第一个已经删掉的素材名，都在就是 null。 */
  const missingMedia = (snapshot) => {
    const { library } = state;
    for (const segment of snapshot.project.tracks.flatMap((track) => track.segments ?? [])) {
      if (!MEDIA_KINDS.has(segment.kind)) continue;
      const id = library.idForPath(segment.path);
      if (id && library.get(id)?.status === "ready") continue;
      return segment.material_name ?? String(segment.path ?? "").split(/[\\/]/u).at(-1);
    }
    return null;
  };

  /** 把工程整份换回存档里的样子；工程名就是剪辑名，跟着换。 */
  const restoreSnapshot = async (session, snapshot) => {
    const restored = await state.store.restoreProject(session.projectId, snapshot.project);
    for (const key of Object.keys(session.grids)) delete session.grids[key];
    Object.assign(session.grids, structuredClone(snapshot.grids ?? {}));
    if (typeof restored?.name === "string") session.title = restored.name;
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

    // 应用开着就接活儿：只回各会话这一轮挂着的拆视频任务，地址带上素材 key（来问的是配过对的页面）
    if (pathname === "/v1/ai-edit/looks") {
      if (method !== "GET") { notAllowed(); return; }
      const looks = [...sessions.sessions.values()].filter((session) => session.streaming?.look)
        .map((session) => ({ sessionId: session.id, look: { ...session.streaming.look, url: `${session.streaming.look.url}?key=${encodeURIComponent(library.key)}` } }));
      sendJson(response, 200, { looks });
      return;
    }

    if (pathname === "/v1/ai-edit/probe-video") {
      if (method !== "POST") { notAllowed(); return; }
      const body = await readJson(request, BODY_BYTES);
      sendJson(response, 200, await probeVideoInput({ config: parseEditConfig(body.config), fetchImpl, signal: AbortSignal.timeout(120_000) }));
      return;
    }

    const lookMatch = pathname.match(/^\/v1\/ai-edit\/sessions\/([^/]+)\/look\/([0-9a-f]{16})$/u);
    if (lookMatch) {
      if (method !== "POST") { notAllowed(); return; }
      const body = await readJson(request, LOOK_BODY_BYTES);
      state.looks.answer(lookMatch[1], lookMatch[2], body);
      sendJson(response, 200, { ok: true });
      return;
    }

    const sessionMatch = pathname.match(/^\/v1\/ai-edit\/sessions\/([^/]+)(?:\/(messages|stop|export|goal|canvas|edit|undo|redo|revert))?$/u);
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
        const region = body.region === undefined || body.region === null ? null : parseRegion(body.region, await store.getProject(session.projectId));
        if (running.has(id)) throw new AiEditError("session_busy", "AI 还在处理上一条，等它做完或先停止。", 409);
        if (exporting.has(id)) throw new AiEditError("session_busy", "正在导入剪映，请稍等。", 409);
        if (editing.has(id)) throw new AiEditError("session_busy", "看板上的改动还没做完，请稍等。", 409);
        await startTurn(session, text, config, region);
        sendJson(response, 202, { session: sessionDetail(session) });
        return;
      }
      if (action === "goal") {
        // 目标不进对话历史，写在每次请求的系统提示里，历史再长被裁掉也还在；AI 正在剪的时候也能改
        const body = await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (goal.length > MAX_GOAL_CHARS) throw new AiEditError("goal_too_long", `目标写在 ${MAX_GOAL_CHARS} 字以内。`);
        session.goal = goal;
        await sessions.touch(session, { persist: true });
        sendJson(response, 200, { session: sessionDetail(session) });
        return;
      }
      if (action === "canvas") {
        // 看板上直接换画面比例；AI 正在剪或正在导入时不换，免得它按旧画布算的位置跟着歪
        const body = await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        const unlock = lockEdit(id);
        try {
          const { canvas } = await store.getProject(session.projectId);
          const { checkpoint } = await saveCheckpoint(session, "edit", "换画面比例");
          let changed;
          try {
            changed = await store.setCanvas(session.projectId, { ...canvas, ...pickCanvas(body) });
          } catch (error) {
            await sessions.dropCheckpoint(session, checkpoint.id);
            await sessions.save(session);
            if (error instanceof EditError) throw new AiEditError("invalid_canvas", "画布宽高要在 16 到 7680 之间的整数，帧率 1 到 120。", 422);
            throw error;
          }
          // 分屏的缩放和蒙版跟画布比例有关：arrange_grid 排过的按新画布重排
          await rearrangeGrids({ store, library: state.library, projectId: session.projectId }, session.grids);
          const { width, height, fps } = changed.canvas;
          addNote(session, `把画布改成了 ${width}×${height}（${width === height ? "方形" : width > height ? "横屏" : "竖屏"}），${fps} 帧/秒`);
          await sessions.clearRedo(session);
          await sessions.touch(session, { persist: true });
          sendJson(response, 200, await sessionState(session));
        } finally {
          unlock();
        }
        return;
      }
      if (action === "edit") {
        // 看板上手动剪：和 AI 用同一套工具、同一套校验，只放开看板上能做的那几种。一批改动（多选、整组挪）只存一份存档，
        // 撤销一下就全回去；中间哪一步没做成，整批都不算
        const body = await readJson(request, EDIT_BODY_BYTES);
        const session = requireSession(id);
        const edits = boardEdits(body);
        const unlock = lockEdit(id);
        try {
          // 说法要看改完的样子才写得准，先占个位，做完再填
          const { checkpoint, revision, snapshot } = await saveCheckpoint(session, "edit", "看板上的改动");
          const runTool = createToolRunner({ store, library, projectId: session.projectId, grids: session.grids });
          const steps = [];
          let failure = null;
          try {
            let before = snapshot.project;
            for (const [index, { name, args }] of edits.entries()) {
              const { result, action: done } = await runTool(name, args);
              if (!result.ok) {
                const reason = sentence(done.error ?? "没改成");
                failure = new AiEditError(String(result.code).toLowerCase(), edits.length === 1 ? reason : `第 ${index + 1} 步没做成：${reason}`, 422);
                break;
              }
              const after = await store.getProject(session.projectId);
              steps.push({ name, args, result, ...describeEdit(name, args, before, after, result) });
              before = after;
            }
          } catch (error) {
            failure = error;
          }
          if (failure) {
            // 前几步已经改了的回到存档的样子；存档不留（存档数到顶时最旧那份已经删了，会话文件跟着存一下）
            const current = await store.getProject(session.projectId).then((project) => project.revision, () => null);
            const restored = current !== revision;
            if (restored) await restoreSnapshot(session, snapshot);
            await sessions.dropCheckpoint(session, checkpoint.id);
            if (restored) await sessions.touch(session, { persist: true, quiet: true });
            else await sessions.save(session);
            throw failure;
          }
          checkpoint.label = batchLabel(steps);
          for (const note of batchNotes(steps, checkpoint.label)) addNote(session, note);
          await sessions.clearRedo(session);
          await sessions.touch(session, { persist: true });
          sendJson(response, 200, await sessionState(session));
        } finally {
          unlock();
        }
        return;
      }
      if (action === "undo") {
        // 不带 to 撤一步；带 to（操作历史里的一步）就一次撤到那一步之前。撤掉的每一步都进重做栈，连按重做能一步步走回来
        const body = await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        const unlock = lockEdit(id);
        try {
          const list = session.checkpoints;
          const single = body.to === undefined || body.to === null;
          const index = single ? list.length - 1 : list.findIndex((item) => item.id === body.to);
          if (single && index < 0) throw new AiEditError("nothing_to_undo", "没有能撤销的改动了。", 409);
          if (index < 0) throw new AiEditError("history_not_found", "这一步已经找不到了。", 409);
          const target = list[index];
          const last = index === list.length - 1;
          const snapshot = await readCheckpoint(session, target);
          if (!snapshot) {
            // 中间的存档坏了不丢：丢了这一步就跳过去了
            if (!last) throw new AiEditError("history_not_found", "这一步的存档坏了，回不去了。", 409);
            // 存档坏了就丢掉，不然撤销一直卡在这一份；不接着往前撤，免得不知道撤到了哪一步
            await sessions.dropCheckpoint(session, target.id);
            await sessions.touch(session, { persist: true });
            throw new AiEditError("nothing_to_undo", "上一步的存档坏了，已经丢掉，可以再按一次撤销。", 409);
          }
          const missing = missingMedia(snapshot);
          if (missing) {
            throw new AiEditError("revert_media_missing", last
              ? `撤销不了上一步：要用到的素材“${missing}”已经从素材库删掉了，更早的改动也没法再撤销。`
              : `撤销不到这一步：要用到的素材“${missing}”已经从素材库删掉了。`, 409);
          }
          const steps = list.slice(index);
          const step = ({ kind, label, messageIndex }) => ({ kind, label, messageIndex });
          // 最新那一步重做以后就是现在的样子
          const newest = await sessions.addRedo(session, { ...step(steps.at(-1)), snapshot: (await snapshotNow(session)).snapshot });
          try {
            await restoreSnapshot(session, snapshot);
          } catch (error) {
            await sessions.dropRedo(session, newest.id);
            await sessions.save(session);
            throw error;
          }
          // 更早的每一步重做以后，是它后面那份存档的样子：文件直接挪进重做栈，最先要重做的放在最上面
          for (let j = steps.length - 2; j >= 0; j -= 1) await sessions.checkpointToRedo(session, steps[j + 1].id, step(steps[j]));
          await sessions.dropCheckpoint(session, target.id);
          addNote(session, steps.length === 1 ? undoNote(target) : undoManyNote(steps.length, target));
          await sessions.touch(session, { persist: true });
          sendJson(response, 200, await sessionState(session));
        } finally {
          unlock();
        }
        return;
      }
      if (action === "redo") {
        await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        const unlock = lockEdit(id);
        try {
          const step = session.redo.at(-1);
          if (!step) throw new AiEditError("nothing_to_redo", "没有能重做的改动了。", 409);
          const snapshot = await readCheckpoint(session, step);
          if (!snapshot) {
            await sessions.dropRedo(session, step.id);
            await sessions.touch(session, { persist: true });
            throw new AiEditError("nothing_to_redo", "下一步的存档坏了，已经丢掉，可以再按一次重做。", 409);
          }
          const missing = missingMedia(snapshot);
          if (missing) throw new AiEditError("revert_media_missing", `重做不了：要用到的素材“${missing}”已经从素材库删掉了。`, 409);
          // 重做前的样子存成存档：说法和记在第几句都用被撤的那份原来的，退回才找得准
          const { checkpoint } = await saveCheckpoint(session, step.kind, step.label, step.messageIndex);
          try {
            await restoreSnapshot(session, snapshot);
          } catch (error) {
            await sessions.dropCheckpoint(session, checkpoint.id);
            await sessions.save(session);
            throw error;
          }
          await sessions.dropRedo(session, step.id);
          addNote(session, redoNote(step));
          await sessions.touch(session, { persist: true });
          sendJson(response, 200, await sessionState(session));
        } finally {
          unlock();
        }
        return;
      }
      if (action === "revert") {
        const body = await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        const unlock = lockEdit(id);
        try {
          const unavailable = new AiEditError("revert_unavailable", "这句话之前的样子已经找不回来了。", 409);
          const index = session.messages.findIndex((item) => item.id === body.messageId && item.role === "user");
          // 这句话发出那一刻的样子：之前在看板上做的手动改动要留着
          const target = revertTarget(session, index);
          if (!target) throw unavailable;
          // 存档坏了不在这里丢：丢了就会落到更晚的存档上，退回的位置就错了
          const snapshot = await readCheckpoint(session, target);
          if (!snapshot) throw unavailable;
          const missing = missingMedia(snapshot);
          if (missing) throw new AiEditError("revert_media_missing", `要用到的素材“${missing}”已经从素材库删掉了，回不去了。`, 409);
          // 退回之前也存一份，退错了还能撤销
          const { checkpoint } = await saveCheckpoint(session, "revert", "退回");
          try {
            await restoreSnapshot(session, snapshot);
          } catch (error) {
            await sessions.dropCheckpoint(session, checkpoint.id);
            await sessions.save(session);
            throw error;
          }
          const said = leading(session.messages[index].text, 16);
          session.messages.push({ id: randomBytes(8).toString("hex"), role: "note", text: `已退回到“${said}”之前的样子`, at: now().toISOString() });
          addNote(session, `把时间线退回到了“${said}”发出之前的样子`);
          await sessions.clearRedo(session);
          await sessions.touch(session, { persist: true });
          sendJson(response, 200, await sessionState(session));
        } finally {
          unlock();
        }
        return;
      }
      if (action === "stop") {
        await readJson(request, BODY_BYTES);
        const session = requireSession(id);
        await stopRun(id);
        sendJson(response, 200, { session: sessionDetail(session) });
        return;
      }
      const body = await readJson(request, BODY_BYTES);
      const session = requireSession(id);
      if (running.has(id)) throw new AiEditError("session_busy", "AI 还在改时间线，等它做完再导入。", 409);
      if (editing.has(id)) throw new AiEditError("session_busy", "看板上的改动还没做完，请稍等。", 409);
      const result = await exportSession(session, { mode: body.mode ?? "auto" });
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
      const lookFileMatch = url.pathname.match(/^\/v1\/ai-edit\/look\/([^/]+)\/file$/u);
      if (!paired && !((fileMatch || lookFileMatch) && request.method === "GET")) return false;
      try {
        try { state ??= await load(); }
        catch (error) {
          console.error("AI 剪辑没能启动:", error);
          throw new AiEditError("ai_edit_unavailable", "AI 剪辑没能启动，请重启应用。", 503);
        }
        if (fileMatch && request.method === "GET") await handleMediaFile(request, response, fileMatch[1], url);
        else if (lookFileMatch && request.method === "GET") {
          // 和素材文件同一把 key：key 不对和地址失效回一样的结果
          if (state.library.checkKey(url.searchParams.get("key"))) await state.looks.sendFile(request, response, lookFileMatch[1]);
          else sendJson(response, 404, { error: "look_not_found", message: "这个视频地址已经失效了。" });
        } else await route(request, response, url);
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
      state.looks.close();
      for (const run of running.values()) run.controller.abort();
      state.sessions.wakeAll();
      await Promise.race([Promise.allSettled([...running.values()].map((run) => run.promise)), delay(3_000)]);
      await state.sessions.flush();
    },
  };
}
