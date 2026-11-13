#!/usr/bin/env node
// 知识库语义检索的浏览器运行库（transformers.js + ONNX Runtime wasm），版本同轻阅网页端。
// 用 npm pack 取固定版本的包（跟着本机 npm 源走），只解出要用的几个文件放进 public/knowledge/vendor/，逐个校验 SHA-256。
// 模型本身不在这里：采集器在第一次用知识库时下载（collector/knowledgeBase.mjs）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "public", "knowledge", "vendor");
const packages = {
  "@huggingface/transformers@3.8.1": {
    "dist/transformers.min.js": ["transformers.min.js", "aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa"],
    LICENSE: ["transformers-LICENSE"],
  },
  "onnxruntime-web@1.22.0-dev.20250409-89f8206ba4": {
    "dist/ort-wasm-simd-threaded.jsep.mjs": ["ort-wasm-simd-threaded.jsep.mjs", "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9"],
    "dist/ort-wasm-simd-threaded.jsep.wasm": ["ort-wasm-simd-threaded.jsep.wasm", "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39"],
  },
};
// onnxruntime-web 的包里不带 LICENSE 文件，按它声明的 MIT 写一份
const ORT_LICENSE = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const present = async (name, hash) => readFile(path.join(target, name)).then(bytes => !hash || sha(bytes) === hash, () => false);

await mkdir(target, { recursive: true });
for (const [spec, files] of Object.entries(packages)) {
  const missing = [];
  for (const [from, [name, hash]] of Object.entries(files)) if (!await present(name, hash)) missing.push([from, name, hash]);
  if (!missing.length) continue;
  const work = await mkdtemp(path.join(tmpdir(), "knowledge-runtime-"));
  try {
    console.log(`准备知识库运行库：${spec}`);
    // 都在临时目录里用相对路径：Windows 上的 GNU tar 会把 C: 当成远程主机
    const tarball = execFileSync("npm", ["pack", spec, "--silent"], { cwd: work, encoding: "utf8", shell: process.platform === "win32" }).trim().split(/\r?\n/u).at(-1);
    execFileSync("tar", ["-xzf", tarball, ...missing.map(([from]) => `package/${from}`)], { cwd: work });
    for (const [from, name, hash] of missing) {
      const source = path.join(work, "package", from);
      if (hash && sha(await readFile(source)) !== hash) throw new Error(`知识库运行库校验失败：${spec} ${from}`);
      await copyFile(source, path.join(target, name));
    }
  } finally { await rm(work, { recursive: true, force: true }); }
}
await writeFile(path.join(target, "onnxruntime-LICENSE"), ORT_LICENSE);
console.log("知识库运行库已就绪：public/knowledge/vendor/");
