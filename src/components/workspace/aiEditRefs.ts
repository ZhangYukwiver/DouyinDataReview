import { MAX_MESSAGE_REFS, type AiEditMessageRef, type AiEditRefRequest, type EditProject, type EditSegment } from "../../services/aiEdit";
import { findSegment, projectDuration, secondMark, US_PER_SECOND } from "./aiEditModel";

// 对话里的引用。用户这边：输入框上方的小条（引用到对话的片段、这一刻、素材），发出去换成请求里的样子；
// AI 那边：回复里写的 [[片段:id]]、[[时间:秒]]，拆出来显示成人话、做成能点的（点了看板跳过去）。

/** 输入框上方的一条引用 */
export type ComposerRef = { kind: "clip"; clipId: string } | { kind: "time"; timeUs: number } | { kind: "media"; mediaId: string };

export const refKey = (ref: ComposerRef): string =>
  ref.kind === "clip" ? `clip:${ref.clipId}` : ref.kind === "time" ? `time:${ref.timeUs}` : `media:${ref.mediaId}`;

/** 往引用里加几条：已经有的不重复加，满了以后的丢掉；dropped 是因为满了没加上的条数 */
export function addRefs(list: readonly ComposerRef[], more: readonly ComposerRef[]): { refs: ComposerRef[]; dropped: number } {
  const refs = [...list];
  const seen = new Set(refs.map(refKey));
  let dropped = 0;
  for (const ref of more) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    if (refs.length >= MAX_MESSAGE_REFS) { dropped += 1; continue; }
    seen.add(key);
    refs.push(ref);
  }
  return { refs, dropped };
}

export const refRequest = (ref: ComposerRef): AiEditRefRequest =>
  ref.kind === "clip" ? { kind: "clip", clip_id: ref.clipId } : ref.kind === "time" ? { kind: "time", time_us: ref.timeUs } : { kind: "media", media_id: ref.mediaId };

/** 落到整帧上：播放中读到的播放头不在帧上 */
export function snapToFrame(us: number, fps: number): number {
  const frame = US_PER_SECOND / (fps > 0 ? fps : 30);
  return Math.max(0, Math.round(Math.round(us / frame) * frame));
}

/** 引用的这一刻已经在片尾之后（引用以后片子被剪短了） */
const pastEnd = (ref: ComposerRef, project: Pick<EditProject, "tracks"> | null | undefined): boolean =>
  ref.kind === "time" && Boolean(project) && ref.timeUs > projectDuration(project);

/** 真正发出去的引用：已经在片尾之后的时刻不发（小条上标着「已经超过片尾」） */
export const sendableRefs = (refs: readonly ComposerRef[], project: Pick<EditProject, "tracks"> | null | undefined): ComposerRef[] =>
  refs.filter((ref) => !pastEnd(ref, project));

/** 小条上的说法：片段按现在的工程叫（AI 改了字跟着变），找不到了照实说 */
export function composerRefLabel(
  ref: ComposerRef,
  project: Pick<EditProject, "tracks"> | null | undefined,
  nameOf: (segment: EditSegment) => string,
  mediaName: (mediaId: string) => string | null,
): string {
  if (ref.kind === "time") return pastEnd(ref, project) ? `${secondMark(ref.timeUs)}（已经超过片尾，不会发出去）` : secondMark(ref.timeUs);
  if (ref.kind === "media") {
    const name = mediaName(ref.mediaId);
    return name ? `素材“${name}”` : "已经删掉的素材";
  }
  const found = findSegment(project, ref.clipId);
  return found ? nameOf(found.segment) : "已经不在时间线上的一段";
}

/** 用户气泡下面那行小字 */
export function refsCaption(refs: readonly AiEditMessageRef[] | null | undefined): string | null {
  const labels = (refs ?? []).map((ref) => ref.label).filter(Boolean);
  return labels.length ? `引用了${labels.join("、")}` : null;
}

// ---------- 回复里的引用 ----------

export type ReplyPiece = { kind: "text"; text: string } | { kind: "clip"; clipId: string } | { kind: "time"; timeUs: number };

/** [[片段:id]]、[[时间:3.2]]，冒号全角半角都认；时间后面多写了「秒」「s」也认 */
const REPLY_REF = /\[\[\s*(片段|时间)\s*[:：]\s*([^\[\]\n]{1,80}?)\s*\]\]/gu;
const SECONDS = /^(\d+(?:\.\d+)?)\s*(?:秒|s)?$/u;

function replyRef(kind: string, value: string): ReplyPiece | null {
  if (kind === "片段") return /^\S+$/u.test(value) ? { kind: "clip", clipId: value } : null;
  const seconds = SECONDS.exec(value);
  return seconds ? { kind: "time", timeUs: Math.round(Number(seconds[1]) * US_PER_SECOND) } : null;
}

/** 把回复拆成普通字和引用；写得不对的引用原样当字留着 */
export function splitReplyRefs(text: string): ReplyPiece[] {
  const pieces: ReplyPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(REPLY_REF)) {
    const piece = replyRef(match[1]!, match[2]!);
    if (!piece) continue;
    let at = match.index ?? 0;
    let end = at + match[0].length;
    // 时间链接自己显示成「第 X 秒」：模型在外面又写了「第」「秒」就并进链接，免得读成「第 第 3.5 秒 秒」
    if (piece.kind === "time") {
      const lead = /第\s*$/u.exec(text.slice(last, at));
      if (lead) at -= lead[0].length;
      const tail = /^\s*秒/u.exec(text.slice(end));
      if (tail) end += tail[0].length;
    }
    if (at > last) pieces.push({ kind: "text", text: text.slice(last, at) });
    pieces.push(piece);
    last = end;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}

/** 流式输出时，末尾还没写完的「[[…」先藏起来（一行之内、不太长才算），免得先蹦出一串 id 再变成名字 */
export function hideOpenRef(text: string): string {
  const open = text.lastIndexOf("[[");
  if (open >= 0 && !text.includes("]]", open)) {
    const tail = text.slice(open);
    if (tail.length <= 90 && !tail.includes("\n")) return text.slice(0, open);
  }
  return text.endsWith("[") ? text.slice(0, -1) : text;
}

/** 回复里一处引用显示成什么；片段找不到了说「前面提到的一段」，不能点 */
export function replyRefLabel(
  piece: Exclude<ReplyPiece, { kind: "text" }>,
  project: Pick<EditProject, "tracks"> | null | undefined,
  nameOf: (segment: EditSegment) => string,
): { label: string; found: boolean } {
  if (piece.kind === "time") return { label: secondMark(piece.timeUs), found: true };
  const found = findSegment(project, piece.clipId);
  return found ? { label: nameOf(found.segment), found: true } : { label: "前面提到的一段", found: false };
}

/** 还在流式输出的回复：引用直接换成说法（写完以后才做成能点的） */
export function plainReplyRefs(text: string, label: (piece: Exclude<ReplyPiece, { kind: "text" }>) => string): string {
  return splitReplyRefs(text).map((piece) => (piece.kind === "text" ? piece.text : label(piece))).join("");
}
