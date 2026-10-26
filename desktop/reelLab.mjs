import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// 送去拆片工坊（ReelLab，另一个独立应用）：照它的送件约定往收件箱放一对文件，再用 reellab://inbox 叫醒它。
// 收件箱路径只由主进程决定，页面只给下载任务编号和这条视频的说明
export const REELLAB_PROTOCOL = "reellab://";
export const REELLAB_INBOX_URL = "reellab://inbox";

const JOB_ID = /^[0-9a-f-]{20,}$/iu;
const MAX_TEXT = 500;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null);

/** 页面传来的参数：jobId 必须像下载任务编号，其余字段类型不对就当没有 */
export function parseReelLabRequest(value) {
  if (!value || typeof value !== "object" || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) return null;
  let url = text(value.url);
  try {
    if (url && !/^https?:$/u.test(new URL(url).protocol)) url = null;
  } catch {
    url = null;
  }
  const seconds = value.durationSeconds;
  return {
    jobId: value.jobId,
    title: text(value.title) ?? "未命名视频",
    author: text(value.author),
    url,
    description: text(value.description),
    durationSeconds: typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

/**
 * isInstalled：系统里有没有登记 reellab 协议；getDownloadFilePath：按下载任务取采集器下好的文件（没有就是 null）；
 * inboxDirectory：<appData>/ReelLab/inbox；openInbox：打开 reellab://inbox。
 * 回 { status: "sent" | "not_installed" } 或 { status: "failed", message }，不抛错。
 * 文件放好了只是叫不醒时回 { status: "sent", wakeFailed: true }：已经送到了，页面不能再让人重送，否则收件箱里会多一份。
 */
export async function sendToReelLab(value, { isInstalled, getDownloadFilePath, inboxDirectory, openInbox, now = () => new Date() }) {
  const request = parseReelLabRequest(value);
  if (!request) return { status: "failed", message: "送件参数不对，请重新点一次。" };
  if (!isInstalled()) return { status: "not_installed" };
  const source = getDownloadFilePath(request.jobId);
  if (!source) return { status: "failed", message: "视频还没下好，或者下好太久已经清掉了，请重新送一次。" };
  // 图文作品下下来是 zip，拆片工坊只收 mp4
  if (path.extname(source).toLowerCase() !== ".mp4") return { status: "failed", message: "只能送视频，图文作品送不过去。" };

  const id = randomBytes(16).toString("hex");
  const video = path.join(inboxDirectory, `${id}.mp4`);
  const manifest = path.join(inboxDirectory, `${id}.json`);
  try {
    await mkdir(inboxDirectory, { recursive: true });
    // 先写 .part 再改名；json 最后出现，拆片工坊看到 json 才算这一份放好了
    await copyFile(source, `${video}.part`);
    await rename(`${video}.part`, video);
    const { title, author, url, description, durationSeconds } = request;
    await writeFile(`${manifest}.part`, JSON.stringify({ version: 1, title, author, url, description, durationSeconds, sentAt: now().toISOString() }));
    await rename(`${manifest}.part`, manifest);
  } catch (error) {
    await Promise.all([video, `${video}.part`, `${manifest}.part`].map((file) => rm(file, { force: true }).catch(() => undefined)));
    return { status: "failed", message: `没能放进拆片工坊的收件箱：${error instanceof Error ? error.message : "未知错误"}` };
  }
  try {
    await openInbox();
  } catch {
    return { status: "sent", wakeFailed: true };
  }
  return { status: "sent" };
}
