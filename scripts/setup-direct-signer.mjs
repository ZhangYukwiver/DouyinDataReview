#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIRECT_SIGNER_COMMIT,
  DIRECT_SIGNER_FILES,
  verifyDirectSigner,
} from "../collector/directHistory.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const dataDirectory = path.join(projectDirectory, ".local-data");
const targetDirectory = path.join(dataDirectory, "direct-signer");
const sourceRoot = `https://raw.githubusercontent.com/mafqla/douyin-api/${DIRECT_SIGNER_COMMIT}`;

async function download(relativePath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${sourceRoot}/${relativePath}`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > 2 * 1024 * 1024) throw new Error("unexpected_size");
    if (createHash("sha256").update(body).digest("hex") !== DIRECT_SIGNER_FILES[relativePath]) {
      throw new Error("sha256_mismatch");
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);

  try {
    await verifyDirectSigner(targetDirectory);
    console.log("评论回复签名器已经安装并通过校验。");
    return;
  } catch (error) {
    if (error?.code && error.code !== "signer_missing") throw error;
  }

  const downloads = new Map();
  for (const relativePath of Object.keys(DIRECT_SIGNER_FILES)) {
    downloads.set(relativePath, await download(relativePath));
  }
  for (const [relativePath, body] of downloads) {
    const destination = path.join(targetDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o400 });
    await rename(temporary, destination);
  }
  await verifyDirectSigner(targetDirectory);
  console.log(`评论回复签名器已安装：mafqla/douyin-api@${DIRECT_SIGNER_COMMIT.slice(0, 7)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? `安装失败：${error.message}` : "评论回复签名器安装失败。");
  process.exitCode = 1;
});
