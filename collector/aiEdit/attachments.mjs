import { AiEditError, isMediaId } from "./library.mjs";

// 对话里贴的图：图本身照常上传进素材库，页面另外生成一份小预览（长边 1024 以内的 JPEG 等）随消息发来，
// 存成文件给能看图的模型看。这里只校验请求体，存文件在 SessionStore。

export const MAX_ATTACHMENTS = 4;
export const MAX_PREVIEW_BYTES = 400 * 1024;
const PREVIEW = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;
// base64 比原文件大三分之一，再留点前缀的余量；超过这么长不用解码就知道太大
const MAX_PREVIEW_CHARS = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 64;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIGNATURES = {
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(PNG),
  "image/webp": (bytes) => bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP",
};

/** 请求体里的 attachments：最多 4 张，每张是素材库里一张就绪的图片 + 它的预览。回 [{ media_id, name, mime, bytes }]。 */
export function parseAttachments(raw, library) {
  if (raw === undefined || raw === null) return [];
  const bad = () => new AiEditError("invalid_attachment", "图片不对，换一张试试。", 422);
  if (!Array.isArray(raw)) throw bad();
  if (raw.length > MAX_ATTACHMENTS) throw new AiEditError("too_many_attachments", `一次最多带 ${MAX_ATTACHMENTS} 张图。`, 422);
  return raw.map((item) => {
    const media = isMediaId(item?.media_id) ? library.get(item.media_id) : null;
    if (!media || media.kind !== "image" || media.status !== "ready") throw bad();
    const match = typeof item.preview === "string" && item.preview.length <= MAX_PREVIEW_CHARS ? PREVIEW.exec(item.preview) : null;
    if (!match) throw bad();
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_PREVIEW_BYTES || !SIGNATURES[match[1]](bytes)) throw bad();
    return { media_id: media.id, name: media.name, mime: match[1], bytes };
  });
}

/** 给模型看的一句：贴了哪几张图（素材名和 media_id）。看得到图的模型还会在同一条消息里收到图本身。 */
export function describeAttachments(attachments) {
  const names = attachments.map((item) => `素材“${item.name}”（media_id ${item.media_id}）`).join("、");
  return `用户这句话附了 ${attachments.length} 张图：${names}。图已经放进素材库，要放进时间线就用这个 media_id。`;
}
