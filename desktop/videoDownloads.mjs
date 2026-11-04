import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// 页面存视频（单条 mp4、图文/批量 zip）都走 <a download>，由外壳接住直接存进这个文件夹，不再每次弹「存储为」。
// ponytail: 按扩展名认视频下载，导出数据的 json、分享卡 png 照旧弹框；以后有别的 zip 要分开再让页面打标记
export const isVideoDownload = (fileName) => /\.(mp4|zip)$/iu.test(fileName);

/** 设置里存的文件夹；没设过、文件坏了就用 系统下载/抖音视频 */
export function readVideoDownloadDirectory(settingsFile, fallback) {
  try {
    const { directory } = JSON.parse(readFileSync(settingsFile, "utf8"));
    if (typeof directory === "string" && path.isAbsolute(directory)) return directory;
  } catch { /* 用默认 */ }
  return fallback;
}

export function writeVideoDownloadDirectory(settingsFile, directory) {
  writeFileSync(settingsFile, JSON.stringify({ directory }));
}

/** 同名文件已经在了就加 (1)、(2)…，不覆盖之前存的；saving 是还在写、磁盘上还没有的那些 */
export function uniqueSavePath(directory, fileName, saving = new Set()) {
  mkdirSync(directory, { recursive: true });
  const { name, ext } = path.parse(path.basename(fileName));
  let candidate = path.join(directory, `${name}${ext}`);
  for (let index = 1; existsSync(candidate) || saving.has(candidate); index += 1) candidate = path.join(directory, `${name} (${index})${ext}`);
  return candidate;
}
