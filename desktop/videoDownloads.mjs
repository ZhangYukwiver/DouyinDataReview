import { constants, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";

// 页面通过 <a download> 保存视频、音频和 ZIP，由外壳存进下载目录。
// ponytail: 按扩展名认视频下载，导出数据的 json、分享卡 png 照旧弹框；以后有别的 zip 要分开再让页面打标记
export const isVideoDownload = (fileName) => /\.(mp4|m4a|zip)$/iu.test(fileName);

/** 设置里存的文件夹；没设过、文件坏了就用 系统下载/抖音视频 */
export function readVideoDownloadDirectory(settingsFile, fallback) {
  try {
    const { directory } = JSON.parse(readFileSync(settingsFile, "utf8"));
    if (typeof directory === "string" && path.isAbsolute(directory)) return directory;
  } catch { /* 用默认 */ }
  return fallback;
}

export async function saveVideoCopies(directory, files, saving = new Set()) {
  const names = [];
  try {
    for (const { filePath, fileName } of files) names.push(await saveVideoCopy(directory, filePath, fileName, saving));
    return names;
  } catch (error) {
    await Promise.all(names.map(name => rm(path.join(directory, name), { force: true })));
    throw error;
  }
}

export function writeVideoDownloadDirectory(settingsFile, directory) {
  writeFileSync(settingsFile, JSON.stringify({ directory }));
}

/** 同名文件已经在了就加 (1)、(2)…，不覆盖之前存的；saving 是还在写、磁盘上还没有的那些 */
export function uniqueSavePath(directory, fileName, saving = new Set()) {
  mkdirSync(directory, { recursive: true });
  const { name, ext } = path.parse(path.basename(fileName));
  let candidate = path.join(directory, `${name}${ext}`);
  for (let index = 1; lstatSync(candidate, { throwIfNoEntry: false }) || saving.has(candidate); index += 1) candidate = path.join(directory, `${name} (${index})${ext}`);
  return candidate;
}

// 扩展下载也落在应用设置的目录；与桌面正在保存的文件共用占位，并防止竞态覆盖。
export async function saveVideoCopy(directory, source, fileName, saving = new Set()) {
  for (;;) {
    const target = uniqueSavePath(directory, fileName, saving);
    saving.add(target);
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return path.basename(target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      saving.delete(target);
    }
  }
}
