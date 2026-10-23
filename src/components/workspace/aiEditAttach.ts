import { MAX_MESSAGE_ATTACHMENTS, type AiEditAttachmentRequest } from "../../services/aiEdit";
import { addRefs, refKey, type ComposerRef } from "./aiEditRefs";

// 对话框里附的图：照旧传进素材库，同时在页面里画一份小预览给能看图的模型看（长边不超过 1024 的 JPEG，整段 data URL 不超过 400KB）。
// 一句话最多带 4 张图；不是图、画不出预览、超了 4 张的文件传完变成素材引用（引用也满了就只进素材库）。

/** 输入框上方一条还在传、或者传好了的文件 */
export interface AttachDraft {
  key: string;
  name: string;
  /** 当成图带给模型 */
  image: boolean;
  /** 给模型看的小预览：undefined 是还在画，null 是画不出来 */
  preview?: string | null;
  progress: number;
  /** 传好了是素材库里的 id */
  mediaId: string | null;
}

export const PREVIEW_MAX_CHARS = 400_000;
/** 依次试的长边和质量：先降质量，还超就缩小 */
export const PREVIEW_STEPS: ReadonlyArray<{ side: number; quality: number }> = [
  { side: 1024, quality: 0.85 }, { side: 1024, quality: 0.7 }, { side: 1024, quality: 0.55 },
  { side: 768, quality: 0.6 }, { side: 512, quality: 0.6 }, { side: 384, quality: 0.5 },
];

/** 缩到长边不超过 side（不放大），至少 1 像素 */
export function fitWithin(width: number, height: number, side: number): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const previewFits = (dataUrl: string): boolean => dataUrl.length <= PREVIEW_MAX_CHARS;

// 和素材库收的图一致（素材库只按扩展名认 png/jpg/jpeg/webp）；别的图片格式当普通文件传，传不上就报错，不占 4 张图的名额
const IMAGE_EXT = /\.(jpe?g|png|webp)$/iu;
const IMAGE_TYPE = /^image\/(png|jpeg|webp)$/u;

/** 能不能当图带给 AI：看扩展名，类型只用来排除（写着别的类型的不算） */
export function isImageFile(file: { type?: string; name: string }): boolean {
  if (file.type && !IMAGE_TYPE.test(file.type)) return false;
  return IMAGE_EXT.test(file.name);
}

/** 截图粘贴进来都叫 image.png：换个认得出的名字，素材库里、给 AI 的说明里都用它 */
export function pastedName(name: string, type: string, now: Date): string {
  if (name && !/^image\.\w+$/iu.test(name)) return name;
  const ext = /^image\/(\w+)/u.exec(type)?.[1]?.replace("jpeg", "jpg") ?? "png";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `粘贴的图片 ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

const PASTE_IMAGE_NAME = /^image\.\w+$/iu;

/**
 * 粘贴的是不是「文档里的字，顺带一张预览图」：Excel、Word、WPS、Numbers 复制字或表格时，剪贴板里除了字和 HTML 还有一张预览图，
 * 浏览器把它当成一个叫 image.png 的文件。这种照常把字贴进输入框。
 * 截图（只有图）、浏览器里复制图片（HTML 只有一个 img，Windows 上字是图片地址）、从访达复制的文件（有真实文件名）仍当附件。
 */
export function pasteIsRichText({ text, html, files }: { text: string; html: string; files: ReadonlyArray<{ name: string; type?: string }> }): boolean {
  if (!files.length || files.some((file) => !file.type || !PASTE_IMAGE_NAME.test(file.name))) return false;
  const plain = text.trim();
  if (!plain || !html.trim()) return false;
  const bare = html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<\/?(?:html|head|body|meta)\b[^>]*>/giu, "");
  if (/^\s*<img\b[^>]*>\s*$/iu.test(bare)) return false;
  const sources = Array.from(html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/giu), (match) => match[1]!.replace(/&amp;/gu, "&"));
  return !sources.includes(plain);
}

/** 这次加的文件哪几个当图带：前面已经有 existing 张，加起来最多 4 张 */
export function planAttachments(existing: number, files: ReadonlyArray<{ type?: string; name: string }>): boolean[] {
  let room = Math.max(0, MAX_MESSAGE_ATTACHMENTS - existing);
  return files.map((file) => {
    if (!room || !isImageFile(file)) return false;
    room -= 1;
    return true;
  });
}

/** 传好了、又不当图带的从附件里拿掉，交出素材 id 变成引用 */
export function settleAttachments(files: readonly AttachDraft[]): { files: AttachDraft[]; mediaIds: string[] } {
  const mediaIds: string[] = [];
  const kept = files.filter((file) => {
    if (!file.mediaId || (file.image && file.preview !== null)) return true;
    mediaIds.push(file.mediaId);
    return false;
  });
  return { files: kept, mediaIds };
}

/**
 * 某个附件传了多少、传好了、画好了预览（patch 为 null 是没传上去，拿掉）；传好又不当图带的移进引用。
 * 这个附件已经不在了返回 null；dropped 是引用满了没加上的条数
 */
export function patchAttachment<T extends { files: AttachDraft[]; refs: ComposerRef[] }>(draft: T, key: string, patch: Partial<AttachDraft> | null): { draft: T; dropped: number } | null {
  if (!draft.files.some((file) => file.key === key)) return null;
  const files = patch ? draft.files.map((file) => (file.key === key ? { ...file, ...patch } : file)) : draft.files.filter((file) => file.key !== key);
  const settled = settleAttachments(files);
  const added = addRefs(draft.refs, settled.mediaIds.map((mediaId) => ({ kind: "media" as const, mediaId })));
  return { draft: { ...draft, files: settled.files, refs: added.refs }, dropped: added.dropped };
}

type Draft = { sessionId: string | null; files: AttachDraft[]; refs: ComposerRef[] };

/** 还没有剪辑时攒的那一排，交给刚建好的剪辑（不然 currentId 一换就看不到了） */
export const adoptDraft = <T extends Draft>(draft: T, sessionId: string): T => (draft.sessionId === null ? { ...draft, sessionId } : draft);

/** 发出去以后拿掉发了的那些（按发的时候那一排认，发出去之后才加的留着）；sessionIds 是这一排可能记在的剪辑 */
export function clearSent<T extends Draft>(draft: T, sessionIds: ReadonlyArray<string | null>, sent: { refs: readonly ComposerRef[]; files: readonly AttachDraft[] }): T {
  if (!sessionIds.includes(draft.sessionId) || (!sent.refs.length && !sent.files.length)) return draft;
  const refs = new Set(sent.refs.map(refKey));
  const files = new Set(sent.files.map((file) => file.key));
  return { ...draft, refs: draft.refs.filter((ref) => !refs.has(refKey(ref))), files: draft.files.filter((file) => !files.has(file.key)) };
}

/** 素材库里删掉了某个素材：这一排里附的这张图、引用的这个素材一起拿掉，免得发出去被整条拒收 */
export function dropMedia<T extends Draft>(draft: T, mediaId: string): T {
  if (!draft.files.some((file) => file.mediaId === mediaId) && !draft.refs.some((ref) => ref.kind === "media" && ref.mediaId === mediaId)) return draft;
  return { ...draft, files: draft.files.filter((file) => file.mediaId !== mediaId), refs: draft.refs.filter((ref) => !(ref.kind === "media" && ref.mediaId === mediaId)) };
}

/** 发消息前还得等：有没传完的、预览还没画好的 */
export const attachmentsPending = (files: readonly AttachDraft[]): boolean =>
  files.some((file) => !file.mediaId || (file.image && file.preview === undefined));

export const attachmentRequests = (files: readonly AttachDraft[]): AiEditAttachmentRequest[] =>
  files.flatMap((file) => (file.image && file.mediaId && file.preview ? [{ media_id: file.mediaId, preview: file.preview }] : []));

/** 在页面里画预览；解不开的图（文件坏了、扩展名和内容对不上）返回 null */
export async function imagePreview(file: Blob): Promise<string | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    for (const step of PREVIEW_STEPS) {
      const size = fitWithin(bitmap.width, bitmap.height, step.side);
      canvas.width = size.width;
      canvas.height = size.height;
      // 图片内容本身的底色，不是界面颜色：JPEG 没有透明，不垫白底透明的地方会变黑
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const url = canvas.toDataURL("image/jpeg", step.quality);
      if (url.startsWith("data:image/jpeg;base64,") && previewFits(url)) return url;
    }
    return null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
