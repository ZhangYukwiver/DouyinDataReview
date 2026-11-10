#!/usr/bin/env node

import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.MEDIA_TARGET_PLATFORM || process.platform;
const arch = process.env.MEDIA_TARGET_ARCH || process.arch;
const target = `${platform}-${arch}`;
const executable = platform === "win32" ? { ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" } : { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
const sourceRoot = path.resolve(process.env.MEDIA_TOOLS_SOURCE_DIR || path.join(projectDirectory, "build", "media-tools-source"));
const mediaDirectory = path.join(projectDirectory, "build", "media-tools");
const destination = path.join(mediaDirectory, target);

async function stage(kind, fileName) {
  const source = path.join(sourceRoot, target, fileName);
  const destinationFile = path.join(destination, fileName);
  try {
    await copyFile(source, destinationFile);
  } catch (error) {
    throw new Error(`缺少 ${target} 的 ${fileName}，请先构建 LGPL 媒体工具并放入 ${path.relative(projectDirectory, path.join(sourceRoot, target))}。`, { cause: error });
  }
  if (platform !== "win32") await chmod(destinationFile, 0o755);
}

await mkdir(mediaDirectory, { recursive: true, mode: 0o755 });
for (const name of await readdir(mediaDirectory)) {
  if (name !== "LICENSES.txt") await rm(path.join(mediaDirectory, name), { force: true, recursive: true });
}
await mkdir(destination, { recursive: true, mode: 0o755 });
await stage("ffmpeg", executable.ffmpeg);
await stage("ffprobe", executable.ffprobe);
console.log(`Staged media tools for ${target} in ${path.relative(projectDirectory, destination)}.`);

