import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, createWriteStream, mkdirSync } from "node:fs";
import { access, appendFile, chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Unzip, UnzipInflate } from "fflate";
import { load as loadYaml } from "js-yaml";

import { cliEnv, killTree, loginShellEnv, runFile, searchDirs, withoutHostVars } from "../localAi.mjs";
import { modelFetch, systemProxy } from "../systemProxy.mjs";
import { findBrowser } from "./film/browser.mjs";
import { AiEditError } from "./library.mjs";
import { renameRetrying } from "./rename.mjs";

// AI 剪辑的技能：用户自己装的「含 SKILL.md 的文件夹」（GitHub 仓库或本机文件夹），模型照里面的说明读写文件、跑命令。
// 这里不认任何具体技能：说明运行时读 SKILL.md，读写和命令都限在技能包根目录和这个技能的工作目录里。
// 登记表 <ai-edit>/skills.json；GitHub 包解到 <ai-edit>/skills/<owner>_<repo>/（旁边 .files-<owner>_<repo>.json 记着 zip 里带了哪些路径）；
// 工作目录 <ai-edit>/skill-work/<技能 id>/。

const SKILL_FILE = "SKILL.md";
const MAX_PACKAGE_BYTES = 200 * 1024 ** 2;
const MAX_PACKAGE_FILES = 5_000;
// 一次推太大的块，fflate 会按文件一层层递归到爆栈（一大块里几千个小文件）：切小了再推
const ZIP_SLICE = 16 * 1024;
// 找 SKILL.md：最多往下 4 层；点开头的目录只看这几个（技能常放在 .claude/skills/ 下）
const FIND_DEPTH = 4;
// 本机文件夹只认往下两层的技能（x/SKILL.md、skills/x/SKILL.md），.claude/skills/x 这类三层：再深的多半是选了个大文件夹
const LOCAL_DEPTH = 2;
const DOT_DIRS = new Set([".claude", ".agents", ".codex"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
// 看着像密钥的文件名：关键词后面要接分隔符或结尾（tokenizer.json、vocab.json 不算），复数也算（tokens.json、auth_tokens.json）；
// .env 的模板（.env.example、.env.defaults 之类）放行，.env、.env.local、.envrc 照拦
const SECRET_FILE = /(^|[._-])(api[_-]?key|secret|credential|password|token)s?([._-]|$)|^\.env(?!\.(example|sample|template|dist|defaults)$)|\.(pem|key|p12)$|^id_(rsa|ed25519)/iu;
// 模型的词表：名字里带 tokens，但不是密钥
const VOCAB_FILE = /^(special_tokens_map|added_tokens)\.json$/iu;
// 说明文档不当密钥（credentials.md 讲的是怎么配）；.txt 不放，api_key.txt 这类就是密钥
const DOC_FILE = /\.(md|mdx|markdown|rst)$/iu;
// 写文件时不许动的：技能自己的说明和脚本、版本库、依赖
const PROTECTED_DIRS = new Set(["agents", "references", "scripts"]);
const MAX_LIST_ENTRIES = 300;
const MAX_READ_BYTES = 32 * 1024 ** 2;
const MAX_READ_CHARS = 40_000;
const MAX_LINE_CHARS = 2_000;
const MAX_LINES = 2_000;
const MAX_MATCHES = 80;
const MAX_WRITE_BYTES = 2 * 1024 ** 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 20 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;
const STOP_WAIT_MS = 5_000;
const MAX_JOBS = 4;
const KEEP_FINISHED = 20;
const MAX_ARGS = 500;
const LOG_BYTES = 20 * 1024 ** 2;
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 8_000;
const ERROR_CHARS = 4_000;
const LAST_LINE_CHARS = 120;
const OUTPUT_EVERY_MS = 1_000;
// 命令退出了、输出管道还被它起的常驻进程占着：等一会儿就不等了
const CLOSE_GRACE_MS = 500;
// 命令退了、它起的进程还在同一个进程组里：隔这么久看一眼组空了没有
const STRAY_SWEEP_MS = 3_000;
const NEW_FILES = 30;
const SCAN_DEPTH = 4;
const SCAN_ENTRIES = 20_000;
const SCAN_SKIP = new Set(["node_modules", ".git", ".runs"]);
const ENV_TTL_MS = 60_000;
// cmd.exe 会解释的字符：.cmd/.bat 只能经过它跑，参数里有这些就不跑
const CMD_UNSAFE = /[&|<>^%"\r\n]/u;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
const OS_NAMES = { darwin: "macOS", win32: "Windows", linux: "Linux" };
// Windows 上机器的和用户的环境变量在注册表里的位置
const REGISTRY_ENV = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"];
// 读写技能文件时系统报的错：带上原因交给模型，它才知道该换个地方写，还是先停掉占着文件的程序
const FS_WHY = {
  EACCES: "没有权限", EPERM: "没有权限或者被别的程序占着", EBUSY: "被别的程序占着", EROFS: "在只读的位置", ENOSPC: "磁盘满了",
  EEXIST: "路径里有一段已经是文件", ENOTDIR: "路径里有一段已经是文件", EISDIR: "是个文件夹",
};

const isFile = (file) => stat(file).then((info) => info.isFile(), () => false);

/** 接在 fs 调用后面：带 code 的系统错误换成 AiEditError（file_unreadable / file_unwritable），别的原样抛。 */
const fsFailed = (verb, file) => (error) => {
  if (error instanceof AiEditError || error?.name === "AbortError" || typeof error?.code !== "string") throw error;
  throw new AiEditError(verb === "写" ? "file_unwritable" : "file_unreadable", `「${file}」${verb}不了：${FS_WHY[error.code] ?? "系统报错"}（${error.code}）。`, 422);
};

/** 文件开头几个字节看得出能直接跑：#! 脚本、ELF、Mach-O（universal 和 Java .class 同一个头，多给执行位无害）。 */
const runnable = (head) => (head[0] === 0x23 && head[1] === 0x21)
  || (head.length >= 4 && ((head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)
    || ((head[0] === 0xcf || head[0] === 0xce) && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe)
    || (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe)));

/** media.mjs 的 isWithin：Windows 上 path.relative 本来就不分大小写。 */
function within(root, file) {
  const relative = path.relative(root, file);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** UTF-8 解不了的（Windows 上的中文程序、老文件）按 GBK 解；这个 Node 没带 GBK 时退回 UTF-8 容错解。 */
function legacyDecoder() {
  try { return new TextDecoder("gbk"); } catch { return new TextDecoder("utf-8"); }
}

function decodeText(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return legacyDecoder().decode(bytes); }
}

/** 末尾有几个字节是没写完的 UTF-8 字（开头字节说要几个、后面还不够）：最多 3 个。 */
function utf8Pending(bytes) {
  for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 3); index -= 1) {
    const byte = bytes[index];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return bytes.length - index < need ? bytes.length - index : 0;
  }
  return 0;
}

/** 按 GBK 从 start 往后数（头字节 0x81–0xFE 的占两个字节）：最后是不是只剩半个字。 */
function gbkHalf(bytes, start = 0) {
  let index = start;
  while (index < bytes.length) index += bytes[index] >= 0x81 && bytes[index] <= 0xfe ? 2 : 1;
  return index > bytes.length;
}

/**
 * SKILL.md 开头的 YAML 头：只取 name、description；name 缺了用目录名。
 * 整段解析不了（别的键写得不规范、冒号没加引号之类）时按顶层键一块块解，name、description 各解各的；
 * 这一块自己也解不了就取冒号后面的全部文字（连同续行），去掉 |、>- 这类块标记。
 */
export function parseSkillFile(text, fallbackName) {
  const lines = String(text).replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const end = lines[0].trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  const head = end > 0 ? lines.slice(1, end).join("\n") : "";
  let meta = {};
  try {
    const loaded = head ? loadYaml(head) : null;
    if (loaded && typeof loaded === "object") meta = loaded;
  } catch {
    for (const block of head.split(/\n(?=\S)/u)) {
      const match = block.match(/^(name|description)[ \t]*:/u);
      if (!match) continue;
      try { meta[match[1]] = loadYaml(block)?.[match[1]]; } catch {
        meta[match[1]] = block.slice(match[0].length).replace(/^[ \t]*[|>][-+1-9]*[ \t]*(?=\n|$)/u, "").trim().replace(/^(["'])([\s\S]*)\1$/u, "$2");
      }
    }
  }
  const clean = (value, max) => Array.from(typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/gu, " ").trim() : "").slice(0, max).join("");
  return {
    // 目录名也一样清理：文件夹名里可能有换行、一长串
    name: clean(meta.name, MAX_NAME) || clean(fallbackName, MAX_NAME),
    description: clean(meta.description, MAX_DESCRIPTION),
  };
}

/**
 * 在 base 里找技能（最多往下 maxDepth 层）：base 自己有 SKILL.md 就只有它；找到一个技能就不再往它里面找。
 * links：指向文件夹的软链也跟进去（装技能的工具常把 .claude/skills/x 链到 .agents/skills/x），坏链跳过、链回这一路上层的（成环）不进；
 * 回的是走过来的路径（链所在的位置），真实路径调用方自己取。base 要是真实路径。
 */
async function findSkillDirs(base, maxDepth = FIND_DEPTH, { links = false } = {}) {
  const found = [];
  // chain：这一路上各层的真实路径，只在跟软链时记
  const walk = async (dir, depth, chain) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.name === SKILL_FILE && !entry.isDirectory())) { found.push(dir); return; }
    if (depth >= maxDepth) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && !DOT_DIRS.has(entry.name))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1, chain && [...chain, path.join(chain.at(-1), entry.name)]);
      else if (chain && entry.isSymbolicLink()) {
        const real = await realpath(full).catch(() => null);
        if (real && !chain.includes(real) && await stat(real).then((info) => info.isDirectory(), () => false)) await walk(full, depth + 1, [...chain, real]);
      }
    }
  };
  await walk(base, 0, links ? [base] : null);
  return found;
}

/** 安装来源：GitHub 仓库地址（可带 /tree/<ref>/<子目录>）或本机文件夹的完整路径。 */
function parseSource(value, home) {
  const text = typeof value === "string" ? value.trim() : "";
  const github = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(\/[^?#]*)?)?\/?(?:[?#].*)?$/iu);
  if (github) {
    const [, owner, repo, ref, rest] = github;
    let parts = [];
    try { parts = (rest ?? "").split("/").filter(Boolean).map(decodeURIComponent); } catch { parts = [".."]; }
    if (![owner, repo, ...parts].some((part) => /^\.+$/u.test(part))) {
      return { type: "github", owner, repo, ref: ref ? decodeURIComponent(ref) : null, subdir: parts.join("/") || null };
    }
  }
  const local = text.replace(/^~(?=$|[\\/])/u, home);
  if (local && !local.includes("\0") && path.isAbsolute(local)) return { type: "folder", path: path.resolve(local) };
  throw new AiEditError("skill_source_invalid", "要填 GitHub 仓库地址（https://github.com/…），或者本机文件夹的完整路径。", 400);
}

/**
 * 一路输出（stdout 或 stderr）：每一块先按 UTF-8 解，解不了的那一块换 GBK，下一块重新按 UTF-8 试
 * （中文 Windows 上 cmd.exe 的 GBK 报错和 node 的 UTF-8 输出会混在同一路里）；去掉颜色控制符。
 * 只留开头 headChars 字和之后的最后 tailChars 字（两段不重叠），cut 表示中间丢过。
 */
function outputText(headChars, tailChars) {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const legacy = legacyDecoder();
  let legacyOpen = false;
  // GBK 的解码器里留着半个字（上一块按 GBK 解，最后一个字被拆开了）
  let legacyHalf = false;
  // 上一块末尾半个 UTF-8 字的字节：留到这一块拼上再解，这一块要改按 GBK 解时也带上（GBK 的一个字常被拆在两块里）
  let held = new Uint8Array(0);
  const state = {
    head: "",
    tail: "",
    cut: false,
    push(chunk, final = false) {
      const bytes = held.length ? Buffer.concat([held, chunk]) : chunk;
      const cut = final ? bytes.length : bytes.length - utf8Pending(bytes);
      let text;
      if (legacyHalf) {
        // 这一块先交给 GBK 把字接上：后半个字单看可能像没写完的 UTF-8（≥0xC0 的一个字节），按 UTF-8 缓着就接不回去了
        text = legacy.decode(bytes, { stream: !final });
        legacyOpen = !final;
        legacyHalf = !final && gbkHalf(bytes, 1);
      } else {
        try {
          text = utf8.decode(bytes.subarray(0, cut));
          held = Buffer.from(bytes.subarray(cut));
          // 上一块按 GBK 解时剩下的半个字冲出来，放在这一块前面
          if (legacyOpen) { text = legacy.decode() + text; legacyOpen = false; }
        } catch {
          // GBK 的解码器一直留着（半个字跨块也接得上）
          held = new Uint8Array(0);
          text = legacy.decode(bytes, { stream: !final });
          legacyOpen = !final;
          legacyHalf = !final && gbkHalf(bytes);
        }
      }
      text = text.replace(ANSI, "");
      const room = Math.max(0, headChars - state.head.length);
      state.head += text.slice(0, room);
      state.tail += text.slice(room);
      if (state.tail.length > tailChars) {
        state.tail = state.tail.slice(-tailChars);
        state.cut = true;
      }
      return text;
    },
    last: (count) => (state.cut ? state.tail : state.head + state.tail).slice(-count),
  };
  return state;
}

/** 等 done 结束，最多等 ms；signal 中止时抛它的 reason。 */
async function waitFor(done, ms, signal) {
  let timer;
  let onAbort;
  try {
    await Promise.race([done, new Promise((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      if (!signal) return;
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 命令开始以后改过的文件：dirs 各扫往下 4 层（跳过依赖、版本库、运行日志），新的在前。
 * 每个目录各数两万条：包根再大，也挤不掉工作目录里的产出。
 */
async function changedFiles(dirs, since) {
  const found = new Map();
  let budget = 0;
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      budget -= 1;
      if (budget < 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < SCAN_DEPTH && !SCAN_SKIP.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && !found.has(full)) {
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs >= since) found.set(full, info);
      }
    }
  };
  for (const dir of new Set(dirs)) {
    budget = SCAN_ENTRIES;
    await walk(dir, 0);
  }
  return [...found].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, NEW_FILES).map(([file, info]) => ({ path: file, size: info.size }));
}

/** 跑 reg.exe 拿原始字节（中文系统下是本地代码页，不能当 UTF-8 收），跑不了回 null。 */
function queryRegistry(args) {
  const reg = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return new Promise((resolve) => {
    try {
      execFile(reg, args, { encoding: "buffer", timeout: 3_000, maxBuffer: 1024 ** 2, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Windows 的环境：安装器把新装的 Node、Python 写进注册表里的 Path，用户 setx 的变量（CODEX_HOME 之类）也只进注册表，已经开着的应用拿不到（不重启就一直找不到）。
 * 现读一遍机器的和用户的环境变量（%变量% 按本进程的展开）：Path 里本进程没有的目录接在后面，原来的先后不变；
 * 别的变量本进程没有的才补上，两边都有时用户的盖过机器的；读不到的就算了。
 */
export async function windowsEnv({ env = process.env, query = queryRegistry } = {}) {
  const vars = { ...env };
  const named = (name) => Object.keys(vars).find((key) => key.toUpperCase() === name.toUpperCase());
  const expand = (text) => text.replace(/%([^%;]+)%/gu, (whole, name) => (named(name) ? vars[named(name)] : whole));
  const key = named("PATH") ?? "Path";
  const dirs = String(vars[key] ?? "").split(";").filter(Boolean);
  const plain = (dir) => dir.replace(/\\+$/u, "").toLowerCase();
  // 要补的变量：变量名大写 → 注册表里的名字、值、是不是 REG_EXPAND_SZ（要展开 %变量%）
  const missing = new Map();
  for (const hive of REGISTRY_ENV) {
    let output = null;
    try { output = await query(["query", hive]); } catch { output = null; }
    for (const line of output ? decodeText(output).split(/\r?\n/u) : []) {
      // 名字是 (默认)、(Default) 的是键的默认值，不是环境变量
      const match = line.match(/^\s+([^\s(].*?)\s+REG_(EXPAND_)?SZ\s+(.*)$/u);
      if (!match) continue;
      const [, name, expandable, value] = match;
      if (name.toUpperCase() !== "PATH") {
        if (!named(name)) missing.set(name.toUpperCase(), { name, value, expandable });
        continue;
      }
      for (const item of value.split(";")) {
        const dir = expand(item.trim());
        if (dir && !dirs.some((known) => plain(known) === plain(dir))) dirs.push(dir);
      }
    }
  }
  vars[key] = dirs.join(";");
  for (const { name, value, expandable } of missing.values()) vars[name] = expandable ? expand(value) : value;
  return vars;
}

/**
 * root：AI 剪辑的数据根目录（index.mjs 里的 root）。测试可以注入 platform、home、shellEnv()、proxy()、developerTools()。
 * 方法全是 async，出错一律抛 AiEditError。
 */
export function createSkills({
  root,
  fetchImpl = modelFetch,
  now = () => new Date(),
  platform = process.platform,
  home = os.homedir(),
  shellEnv = () => (platform === "win32" ? windowsEnv() : loginShellEnv({ platform })),
  proxy = () => systemProxy().then((value) => value?.url ?? null).catch(() => null),
  // macOS 装没装命令行工具：xcode-select -p 不会弹窗（跑 /usr/bin/python3 --version 本身就会弹安装框）
  developerTools = () => runFile("/usr/bin/xcode-select", ["-p"], { timeoutMs: 3_000 }).then((result) => result.code === 0),
}) {
  let base = null;
  let entries = null;
  let loading = null;
  let queue = Promise.resolve();
  let userEnv = null;
  let environment = null;
  let tools = null;
  let closed = false;
  const active = new Set();
  const jobs = new Map();

  const same = (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const packagesDir = () => path.join(base, "skills");
  const workDir = (id) => path.join(base, "skill-work", id);
  const notFound = (key) => new AiEditError("skill_not_found", `没有「${key}」这个技能，可能没装、已经删了或者没启用。`, 404);

  /** 第一次用时读登记表；顺手清掉上次中途退出留下的下载临时目录。 */
  const load = () => {
    loading ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      base = await realpath(root);
      await mkdir(packagesDir(), { recursive: true, mode: 0o700 });
      for (const name of await readdir(packagesDir()).catch(() => [])) {
        if (/^\.(download|old)-/u.test(name)) await rm(path.join(packagesDir(), name), { recursive: true, force: true }).catch(() => undefined);
      }
      try {
        const parsed = JSON.parse(await readFile(path.join(base, "skills.json"), "utf8"));
        entries = Array.isArray(parsed?.skills) ? parsed.skills.filter((entry) => typeof entry?.id === "string" && typeof entry.root === "string" && typeof entry.dir === "string") : [];
      } catch {
        entries = [];
      }
    })().catch((error) => { loading = null; throw error; });
    return loading;
  };

  const save = async () => {
    const file = path.join(base, "skills.json");
    await writeFile(`${file}.tmp`, JSON.stringify({ skills: entries }, null, 2), { mode: 0o600 });
    await renameRetrying(`${file}.tmp`, file);
  };

  // 改登记表的操作排队，免得两次安装互相覆盖
  const serial = (work) => {
    const next = queue.then(() => load()).then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** 对外的样子：每次现读 SKILL.md（更新、改了说明马上生效），读不到就记在 problem 上。 */
  const view = async (entry) => {
    let name = entry.name ?? path.basename(entry.dir);
    let description = "";
    let problem = null;
    try {
      ({ name, description } = parseSkillFile(decodeText(await readFile(path.join(entry.dir, SKILL_FILE))), path.basename(entry.dir)));
    } catch (error) {
      if (!await stat(entry.dir).then((info) => info.isDirectory(), () => false)) problem = `技能文件夹不在了（${entry.dir}），重新安装或者删掉它。`;
      else if (error?.code === "ENOENT") problem = "文件夹里没有 SKILL.md 了，重新安装或者删掉它。";
      else problem = `SKILL.md 读不了（${error?.code ?? error?.message ?? "原因不明"}）。`;
    }
    return {
      id: entry.id, name, description, root: entry.root, dir: entry.dir, work: workDir(entry.id), source: entry.source,
      enabled: entry.enabled !== false, trustCommands: entry.trustCommands === true, installedAt: entry.installedAt, problem,
    };
  };

  const list = async () => {
    await load();
    const all = await Promise.all(entries.map(view));
    return all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };

  // 命令自己退出了、它起的进程还在同一个进程组里跑（起完服务就退出的启动器）：记着，停止和关应用时还能连组杀掉。
  // 组一空就丢掉，免得以后这个组号分给了别的程序还去杀它。Windows 没有进程组，管不到（要 Job Object 才行）
  const strays = new Set();
  let sweep = null;
  const groupAlive = (job) => { try { process.kill(-job.pgid, 0); return true; } catch { return false; } };
  const prune = () => {
    for (const job of strays) if (!groupAlive(job)) strays.delete(job);
    if (!strays.size && sweep) { clearInterval(sweep); sweep = null; }
  };
  const keepStray = (job) => {
    strays.add(job);
    sweep ??= setInterval(prune, STRAY_SWEEP_MS).unref();
  };
  const stopStray = async (job) => {
    const send = (signal) => { try { process.kill(-job.pgid, signal); } catch { /* 组已经空了 */ } };
    // 和 killTree 一样：先让它收个尾，一秒半还在就强杀
    send("SIGINT");
    for (let waited = 0; groupAlive(job) && waited < STOP_WAIT_MS; waited += 100) {
      if (waited === 1_500) send("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    strays.delete(job);
    job.status = "stopped";
  };

  const running = () => [...jobs.values()].filter((job) => job.status === "running");
  // 前台、后台的命令都在 active 里，跑完才拿掉；命令退了、留下的进程还在跑的也算
  const busy = (packageRoot) => {
    prune();
    return [...active, ...strays].some((job) => same(job.root, packageRoot));
  };
  const busyError = () => new AiEditError("skill_busy", "这个技能包还有命令在跑：后台的先在设置里停掉，AI 正在跑的等它做完或者先停止这一轮，再来改。", 409);
  // 同一个来源：GitHub 比仓库地址（ref、子目录不同也是同一个仓库），本机比文件夹
  const sameSource = (a, b) => a?.type === b.type
    && (b.type === "github" ? String(a.url).toLowerCase() === b.url.toLowerCase() : same(String(a.path), b.path));
  // GitHub 包旁边记着 zip 里带了哪些路径（更新时分得清哪些是技能自己后来存的）
  const filesList = (packageRoot) => path.join(path.dirname(packageRoot), `.files-${path.basename(packageRoot)}.json`);
  const pathKey = (relative) => (platform === "win32" ? relative.toLowerCase() : relative);

  /**
   * 一个包（同一个根目录）的技能登记进表：同一个文件夹的沿用原来的 id 和开关，这次没找到、SKILL.md 也没了的去掉。
   * 文件夹相同但来源换了（别的仓库落到了同一个目录），「运行命令不用问」不沿用。
   * found 是 [{ root, dir }]：本机文件夹里链到外面的技能，包根是它自己的文件夹，不是 packageRoot。
   */
  const register = async (packageRoot, found, source) => {
    const taken = new Set(entries.map((entry) => entry.id));
    const installedAt = now().toISOString();
    const installed = [];
    for (const { root: skillRoot, dir } of found) {
      const { name } = parseSkillFile(decodeText(await readFile(path.join(dir, SKILL_FILE))), path.basename(dir));
      let entry = entries.find((item) => same(item.root, skillRoot) && same(item.dir, dir));
      if (!entry) {
        const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
        const stem = slug(name) || slug(path.basename(dir)) || "skill";
        let id = stem;
        for (let n = 2; taken.has(id); n += 1) id = `${stem}-${n}`;
        taken.add(id);
        entry = { id, enabled: true, trustCommands: false };
        entries.push(entry);
      } else if (!sameSource(entry.source, source)) entry.trustCommands = false;
      Object.assign(entry, { name, root: skillRoot, dir, source, installedAt });
      installed.push(entry);
    }
    const keep = [];
    for (const entry of entries) {
      if (!same(entry.root, packageRoot) || installed.includes(entry) || await isFile(path.join(entry.dir, SKILL_FILE))) keep.push(entry);
    }
    entries = keep;
    await save();
    return { installed: await Promise.all(installed.map(view)) };
  };

  /** 下 GitHub 仓库的 zip 解进 folder：外层的 <repo>-<ref>/ 原样解出来，之后再认；跳过 .git 和 __MACOSX。 */
  const download = async ({ owner, repo, ref }, folder, signal) => {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/${ref ? encodeURIComponent(ref) : "HEAD"}`;
    let response;
    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AiEditError("skill_download_failed", `连不上 GitHub（${error?.cause?.code ?? error?.message ?? "原因不明"}），检查网络或代理再试。`, 502);
    }
    if (response.status === 404) throw new AiEditError("skill_download_failed", "GitHub 上没找到这个仓库或分支；私有仓库下载不了。", 422);
    if (!response.ok || !response.body) throw new AiEditError("skill_download_failed", `GitHub 返回了 ${response.status}，稍后再试。`, 502);
    const tooLarge = () => new AiEditError("skill_too_large", "技能包超过 200MB 了，装不了。", 413);
    if (Number(response.headers.get("content-length")) > MAX_PACKAGE_BYTES) throw tooLarge();
    let received = 0;
    let total = 0;
    let count = 0;
    let failure = null;
    const fail = (error) => { failure ??= error; };
    const writes = [];
    const streams = [];
    try {
      const unzip = new Unzip((file) => {
        const name = file.name.replace(/\\/gu, "/");
        if (name.endsWith("/")) return;
        count += 1;
        if (count > MAX_PACKAGE_FILES) { fail(new AiEditError("skill_too_many_files", "技能包里的文件超过 5000 个了，装不了。", 413)); return; }
        const parts = name.split("/");
        if (parts.some((part) => part === ".git" || part === "__MACOSX")) return;
        const target = path.resolve(folder, name);
        if (!within(folder, target) || target === folder || parts.includes("..")) { fail(new AiEditError("skill_bad_zip", "压缩包里有不安全的路径，没装。", 422)); return; }
        // 数据是同步回调进来的：当场开文件、当场 start，写入交给写入流排队（和导入剪辑工程 zip 的写法一样）
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const out = createWriteStream(target, { mode: 0o600 });
        streams.push(out);
        let magic = Buffer.alloc(0);
        const done = new Promise((resolve, reject) => {
          out.on("error", reject);
          // fflate 流式解压拿不到 zip 里的权限位：#! 脚本和 ELF/Mach-O 程序补上执行权限，技能里带的程序才能直接跑
          out.on("finish", () => (runnable(magic) ? chmod(target, 0o700).then(resolve, resolve) : resolve()));
          file.ondata = (error, data, final) => {
            if (error) { reject(error); out.destroy(); return; }
            if (magic.length < 4) magic = Buffer.concat([magic, data.subarray(0, 4 - magic.length)]);
            total += data.length;
            if (total > MAX_PACKAGE_BYTES) { reject(tooLarge()); out.destroy(); return; }
            out.write(data);
            if (final) out.end();
          };
        });
        file.start();
        writes.push(done.catch(fail));
      });
      unzip.register(UnzipInflate);
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > MAX_PACKAGE_BYTES) throw tooLarge();
        for (let at = 0; at < chunk.length && !failure; at += ZIP_SLICE) unzip.push(chunk.subarray(at, at + ZIP_SLICE));
        if (failure) throw failure;
      }
      unzip.push(new Uint8Array(0), true);
      await Promise.all(writes);
      if (failure) throw failure;
      if (!count) throw new AiEditError("skill_bad_zip", "下载下来的不是 zip 压缩包，没装。", 422);
    } catch (error) {
      for (const out of streams) out.destroy();
      if (error instanceof AiEditError || signal?.aborted) throw error;
      throw new AiEditError("skill_download_failed", `技能包下载到一半断了或者解不开（${error?.message ?? "原因不明"}），再试一次。`, 502);
    }
  };

  /**
   * 更新时把旧包里技能自己后来存的东西（数据、装的依赖、录音之类）搬进新包，同名文件夹一层层合并：
   * 新包里有的以新的为准；旧 zip 里带的（上游删掉了）不搬；packaged 是旧 zip 的路径表，没有时旧的全搬。
   */
  const carryOver = async (from, to, packaged, relative = "") => {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const there = await lstat(path.join(to, entry.name)).catch(() => null);
      if (there) {
        if (entry.isDirectory() && there.isDirectory()) await carryOver(path.join(from, entry.name), path.join(to, entry.name), packaged, name);
      } else if (!packaged?.has(pathKey(name))) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        await renameRetrying(path.join(from, entry.name), path.join(to, entry.name));
      } else if (entry.isDirectory()) {
        await carryOver(path.join(from, entry.name), path.join(to, entry.name), packaged, name);
      }
    }
  };

  const installGithub = async (source, signal) => {
    await load();
    // GitHub 的用户名、组织名不能带下划线：拼起来不会两个仓库撞成一个目录（owner-repo 会：a-b/c 和 a/b-c）
    const key = `${source.owner}_${source.repo}`.toLowerCase();
    const temp = path.join(packagesDir(), `.download-${randomBytes(6).toString("hex")}`);
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      await download(source, temp, signal);
      // GitHub 的 zip 外面包着一层 <repo>-<ref>/
      const top = await readdir(temp, { withFileTypes: true });
      const unpacked = top.length === 1 && top[0].isDirectory() ? path.join(temp, top[0].name) : temp;
      const from = source.subdir ? path.join(unpacked, ...source.subdir.split("/")) : unpacked;
      if (source.subdir && !await stat(from).then((info) => info.isDirectory(), () => false)) {
        throw new AiEditError("skill_missing", `仓库里没有「${source.subdir}」这个文件夹。`, 422);
      }
      const found = await findSkillDirs(from);
      if (!found.length) throw new AiEditError("skill_missing", "这个仓库里没找到 SKILL.md，不是技能包。", 422);
      const packaged = (await readdir(unpacked, { recursive: true })).map(pathKey);
      const url = `https://github.com/${source.owner}/${source.repo}`;
      return await serial(async () => {
        const target = path.join(packagesDir(), key);
        if (busy(target)) throw busyError();
        // 同一个仓库重装 = 更新：解好的整个换上去，换失败就把旧的放回来
        const old = path.join(packagesDir(), `.old-${randomBytes(6).toString("hex")}`);
        const had = await stat(target).then(() => true, () => false);
        // 路径表读不到、坏了：旧包里新 zip 没有的全搬，宁可多留
        const before = had ? await readFile(filesList(target), "utf8").then((text) => new Set(JSON.parse(text))).catch(() => null) : null;
        if (had) await renameRetrying(target, old);
        try {
          await renameRetrying(unpacked, target);
        } catch (error) {
          if (had) await renameRetrying(old, target).catch(() => undefined);
          throw error;
        }
        let kept = null;
        if (had) {
          try {
            await carryOver(old, target, before);
            await rm(old, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
          } catch (error) {
            // 搬到一半失败：旧包改成启动时不会清掉的名字留着，用户还能自己拷回来
            kept = { error, at: path.join(packagesDir(), `.backup-${key}-${randomBytes(4).toString("hex")}`) };
            await renameRetrying(old, kept.at).catch(() => { kept.at = old; });
          }
        }
        await writeFile(filesList(target), JSON.stringify(packaged), { mode: 0o600 });
        const dirs = found.map((dir) => ({ root: target, dir: path.join(target, path.relative(unpacked, dir)) }));
        const result = await register(target, dirs, { type: "github", url, ref: source.ref, subdir: source.subdir });
        if (kept) {
          throw new AiEditError("skill_update_partial", `新版本装好了，但旧版本里技能自己存的数据没搬全（${kept.error?.code ?? kept.error?.message ?? "原因不明"}）。旧版本留在 ${kept.at}，要的东西可以从那里拷回来。`, 500);
        }
        return result;
      });
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  };

  /**
   * 本机文件夹：原地登记，不复制；删的时候也只去掉登记。整个文件夹都是 AI 能读写的范围，所以不收：
   * 家目录、各个程序放配置和数据的目录（~/.config、mac 的 ~/Library、Windows 的 %APPDATA% 和 %LOCALAPPDATA%）和它们的上层，
   * 应用自己的数据目录（里面、上层都不行），Claude/Codex 的配置目录（只有里面的 skills/ 可以）。
   * 技能只认往下两层的（.claude/skills/x 这类三层），选了个大文件夹、技能埋得很深的不认。
   * 软链也跟进去：链到文件夹外面的技能自己算一个包（AI 只能动它自己的文件夹），它的文件夹同样不能范围太大，太大的跳过并说明。
   */
  const installFolder = async (source) => {
    let folder;
    try { folder = await realpath(source.path); } catch { folder = null; }
    if (!folder || !await stat(folder).then((info) => info.isDirectory(), () => false)) {
      throw new AiEditError("skill_missing", `找不到「${source.path}」这个文件夹。`, 422);
    }
    await load();
    const real = (dir) => realpath(dir).catch(() => dir);
    // 本进程的和用户环境里的都算（Windows 上变量名不分大小写）
    const envs = [process.env, await baseEnv()];
    const vars = (name) => envs.map((env) => env[Object.keys(env).find((key) => key.toUpperCase() === name)]);
    const dirs = (list) => Promise.all(list.filter((dir) => typeof dir === "string" && path.isAbsolute(dir)).map(real));
    const agentDirs = await dirs([...[...DOT_DIRS].map((name) => path.join(home, name)), ...vars("CLAUDE_CONFIG_DIR"), ...vars("CODEX_HOME")]);
    const dataDirs = await dirs([
      home, path.join(home, ".config"),
      ...(platform === "darwin" ? [path.join(home, "Library")] : []),
      ...(platform === "win32" ? [...vars("APPDATA"), ...vars("LOCALAPPDATA")] : []),
    ]);
    // 配置目录的上层也不行（CLAUDE_CONFIG_DIR、CODEX_HOME 可能不在家目录里）：选了上层，里面的登录信息就都能读到
    const tooBroad = (dir) => [...dataDirs, ...agentDirs].some((other) => within(dir, other)) || within(dir, base) || within(base, dir)
      || agentDirs.some((other) => within(other, dir) && !within(path.join(other, "skills"), dir));
    const broad = "家目录、各个程序放配置和数据的目录、应用数据目录、Claude/Codex 的配置目录";
    if (tooBroad(folder)) {
      throw new AiEditError("skill_source_too_broad", `这个文件夹范围太大或者是应用自己的数据（${broad}），AI 会能读写里面所有东西。请改选里面的 skills 文件夹，或者单个技能的文件夹。`, 422);
    }
    const near = (dir) => {
      const parts = path.relative(folder, dir).split(path.sep).filter(Boolean);
      return parts.length <= LOCAL_DEPTH || (parts.length === LOCAL_DEPTH + 1 && DOT_DIRS.has(parts[0]) && parts[1] === "skills");
    };
    // 深度按链所在的位置算；同一个技能链了几次只算一次
    const found = [];
    const skipped = [];
    const seen = new Set();
    for (const dir of (await findSkillDirs(folder, LOCAL_DEPTH + 1, { links: true })).filter(near)) {
      const real = await realpath(dir).catch(() => null);
      if (!real || seen.has(pathKey(real))) continue;
      seen.add(pathKey(real));
      if (within(folder, real)) found.push({ root: folder, dir: real });
      else if (tooBroad(real)) skipped.push(`「${dir}」链到的「${real}」范围太大或者是应用自己的数据（${broad}），AI 会能读写里面所有东西，没装。`);
      else found.push({ root: real, dir: real });
    }
    if (!found.length && skipped.length) throw new AiEditError("skill_source_too_broad", `${skipped.join("")}把技能单独放进一个文件夹再装。`, 422);
    if (!found.length) {
      throw new AiEditError("skill_missing", "这个文件夹里没找到技能：只看它自己和往下两层（.claude/skills/ 这类往下三层）有没有 SKILL.md。请选单个技能的文件夹，或者技能仓库的根目录。", 422);
    }
    const result = await serial(() => register(folder, found, { type: "folder", path: folder }));
    return skipped.length ? { ...result, skipped } : result;
  };

  /** 新文件（还不存在）取父目录的真实路径再拼回去；悬空的软链不算不存在（写进去会写到它指的地方）。 */
  const realTarget = async (file) => {
    try {
      return await realpath(file);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code) || await lstat(file).then(() => true, () => false)) return null;
      const parent = path.dirname(file);
      if (parent === file) return null;
      const real = await realTarget(parent);
      return real && path.join(real, path.basename(file));
    }
  };

  const resolve = async (skill, p, { write = false } = {}) => {
    if (typeof p !== "string" || p.includes("\0")) throw new AiEditError("path_invalid", "路径要是一段文字，不能带空字符。", 400);
    await mkdir(skill.work, { recursive: true, mode: 0o700 }).catch(fsFailed("写", skill.work));
    let roots;
    try {
      roots = await Promise.all([skill.root, skill.work, skill.dir].map((dir) => realpath(dir)));
    } catch {
      throw new AiEditError("skill_unavailable", `技能「${skill.name}」的文件夹不在了，重新安装或者删掉它。`, 409);
    }
    const [packageRoot, work, dir] = roots;
    const text = p.trim();
    // ~work/… 是这个技能的工作目录；其余相对路径按 SKILL.md 所在的文件夹算
    const raw = /^~work(?=$|[\\/])/u.test(text) ? path.join(skill.work, text.slice(5)) : path.resolve(skill.dir, text);
    const outside = () => new AiEditError("path_outside_skill", `「${p}」不在技能包或它的工作目录里，只能读写这两处的文件。`, 403);
    // 先按字面查一遍，界外的路径碰都不碰：Windows 上 realpath 一个 \\主机\共享 会去连对方的 SMB，macOS 的 /net 会触发自动挂载。
    // 登记的路径和真实路径都比（GitHub 包的路径是拼出来的，/var 和 /private/var、8.3 短名都可能对不上）
    if (![packageRoot, work, skill.root, skill.work].some((dir) => within(dir, raw))) throw outside();
    const target = await realTarget(raw);
    // 再按真实路径查：防软链跑出去
    if (!target || !(within(packageRoot, target) || within(work, target))) throw outside();
    if (write) {
      const parts = path.relative(within(packageRoot, target) ? packageRoot : work, target).toLowerCase().split(path.sep);
      const inSkill = within(dir, target) ? path.relative(dir, target).toLowerCase().split(path.sep) : [];
      if (parts.at(-1) === SKILL_FILE.toLowerCase() || parts.some((part) => part === ".git" || part === "node_modules")
        || PROTECTED_DIRS.has(inSkill[0])) {
        throw new AiEditError("path_protected", "技能自己的说明和脚本（SKILL.md、agents/、references/、scripts/）、.git 和 node_modules 里的文件不能改；草稿写到 ~work/ 下。", 403);
      }
    }
    return target;
  };

  /** 文件夹：列一层（最多 300 条，文件夹在前）。 */
  const listDir = async (dir) => {
    const all = await readdir(dir, { withFileTypes: true }).catch(fsFailed("读", dir));
    all.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const entries = [];
    for (const entry of all.slice(0, MAX_LIST_ENTRIES)) {
      const kind = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
      const size = kind === "file" ? (await stat(path.join(dir, entry.name)).catch(() => null))?.size ?? null : null;
      entries.push({ name: entry.name, kind, size });
    }
    return { path: dir, kind: "dir", entries, ...(all.length > entries.length ? { total_entries: all.length } : {}) };
  };

  const readSkillFile = async (skill, p, { offset = 1, limit = 400, search = null } = {}) => {
    const file = await resolve(skill, p ?? SKILL_FILE);
    const info = await stat(file).catch(() => null);
    if (!info) throw new AiEditError("file_not_found", `没有「${p ?? SKILL_FILE}」这个文件或文件夹。`, 404);
    if (info.isDirectory()) return listDir(file);
    if (SECRET_FILE.test(path.basename(file)) && !DOC_FILE.test(path.basename(file)) && !VOCAB_FILE.test(path.basename(file))) throw new AiEditError("secret_file", "这个文件看着像密钥或密码，不读。", 403);
    if (info.size > MAX_READ_BYTES) throw new AiEditError("file_too_large", "文件超过 32MB 了，太大读不了。", 413);
    const bytes = await readFile(file).catch(fsFailed("读", file));
    if (bytes.subarray(0, 8_192).includes(0)) return { path: file, kind: "binary", size: info.size };
    const lines = decodeText(bytes).replace(/^\uFEFF/u, "").split(/\r?\n/u);
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const row = (index, mark = "") => {
      const line = lines[index];
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…（这一行还有 ${line.length - MAX_LINE_CHARS} 字）` : line;
      return `${index + 1}${mark}\t${shown}\n`;
    };
    if (typeof search === "string" && search) {
      // 像 grep -n -C2：命中的行号后面是「:」，上下文是「-」，不挨着的几段之间隔一行「--」
      const needle = search.toLowerCase();
      const hits = [];
      for (let index = 0; index < lines.length && hits.length <= MAX_MATCHES; index += 1) {
        if (lines[index].toLowerCase().includes(needle)) hits.push(index);
      }
      const shown = new Set(hits.slice(0, MAX_MATCHES));
      let text = "";
      let last = -1;
      let full = false;
      for (const hit of shown) {
        const start = Math.max(hit - 2, last + 1);
        if (last >= 0 && start > last + 1) text += "--\n";
        for (let index = start; index <= Math.min(hit + 2, lines.length - 1); index += 1) {
          const next = row(index, shown.has(index) ? ":" : "-");
          if (text.length + next.length > MAX_READ_CHARS) { full = true; break; }
          text += next;
          last = index;
        }
        if (full) break;
      }
      return { path: file, kind: "text", search, matches: shown.size, lines: text, total_lines: lines.length, truncated: full || hits.length > MAX_MATCHES };
    }
    const from = Math.max(1, Math.floor(Number(offset)) || 1);
    const count = Math.min(MAX_LINES, Math.max(1, Math.floor(Number(limit)) || 400));
    let text = "";
    let to = from - 1;
    for (let index = from - 1; index < lines.length && index < from - 1 + count; index += 1) {
      const next = row(index);
      if (text && text.length + next.length > MAX_READ_CHARS) break;
      text += next;
      to = index + 1;
    }
    return { path: file, kind: "text", lines: text, from, to, total_lines: lines.length, truncated: to < lines.length };
  };

  const writeSkillFile = async (skill, p, content, { append = false } = {}) => {
    if (typeof content !== "string") throw new AiEditError("content_invalid", "写进文件的内容要是文字。", 400);
    const file = await resolve(skill, p, { write: true });
    const text = append ? content : content.replace(/^\uFEFF/u, "");
    const bytes = Buffer.byteLength(text);
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) throw new AiEditError("path_is_dir", `「${p}」是个文件夹，不能当文件写。`, 422);
    if ((append ? info?.size ?? 0 : 0) + bytes > MAX_WRITE_BYTES) throw new AiEditError("file_too_large", "技能文件写完不能超过 2MB；大的产出让命令自己写。", 413);
    const failed = fsFailed("写", file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(failed);
    if (append) await appendFile(file, text).catch(failed);
    else await writeFile(file, text).catch(failed);
    return { path: file, bytes };
  };

  /**
   * 用户的环境，去掉宿主会话的变量：mac/linux 是登录 shell 的，Windows 是本进程的接上注册表里现在的 Path，读不到都用本进程的。
   * 一分钟内复用；找不到命令时马上作废（start 里），用户刚装好 Node、Python 回来再试就能找到。
   */
  const baseEnv = () => {
    if (!userEnv || Date.now() - userEnv.at > ENV_TTL_MS) {
      const vars = Promise.resolve().then(shellEnv).catch(() => null);
      userEnv = { at: Date.now(), value: vars.then((value) => withoutHostVars(value ?? process.env)) };
    }
    return userEnv.value;
  };

  // macOS 装没装命令行工具，一分钟内复用
  const hasDeveloperTools = () => {
    if (!tools || Date.now() - tools.at > ENV_TTL_MS) tools = { at: Date.now(), value: Promise.resolve().then(developerTools).catch(() => false) };
    return tools.value;
  };

  /**
   * 在 PATH 和常见安装位置里找程序；Windows 按 PATHEXT 补后缀，跳过应用商店的 python 占位程序，
   * macOS 没装命令行工具时跳过 /usr/bin 里的 python（只是个占位，一跑就弹「要安装命令行开发者工具」）。
   */
  const which = async (name, env) => {
    const exts = platform === "win32" && !path.extname(name) ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    // Node 官方安装包和 nvm-windows 默认在这里：注册表读不到时也找得到刚装的
    const extra = platform === "win32" ? [path.join(env.ProgramW6432 ?? env.ProgramFiles ?? "C:\\Program Files", "nodejs")] : [];
    for (const dir of [...await searchDirs({ platform, env, home }), ...extra]) {
      if (platform === "win32" && /[\\/]WindowsApps[\\/]?$/iu.test(dir) && /^python/iu.test(name)) continue;
      if (platform === "darwin" && dir.replace(/\/+$/u, "") === "/usr/bin" && /^python/iu.test(name) && !await hasDeveloperTools()) continue;
      for (const ext of exts) {
        const file = path.join(dir, `${name}${ext.toLowerCase()}`);
        if (!await isFile(file)) continue;
        if (platform === "win32" || await access(file, constants.X_OK).then(() => true, () => false)) return file;
      }
    }
    return null;
  };

  const noNode = () => new AiEditError("command_missing", "这台电脑没装 Node.js，这个技能要用 npm / npx。先到 nodejs.org 装一个（LTS 版），装好后再试；还找不到就重启一下应用。", 422);

  /** npm / npx 怎么起，找不到回 null。 */
  const npmCommand = async (name, node, env) => {
    if (platform !== "win32") {
      const file = await which(name, env);
      return file && { file, prefix: [], node };
    }
    // npm.cmd 要过 cmd.exe，参数一转义就乱：直接用 node 跑它包里的脚本
    const cli = path.join(path.dirname(node), "node_modules", "npm", "bin", `${name}-cli.js`);
    if (await isFile(cli)) return { file: node, prefix: [cli], node };
    // Volta 之类的管理器：node、npm、npx 都是 .exe 的 shim，旁边没有 node_modules；exe 不用过 cmd.exe，直接起
    const shim = await which(`${name}.exe`, env);
    return shim && { file: shim, prefix: [], node };
  };

  /** argv[0] 换成真正要起的程序：node 没装就用应用自带的；npm/npx 要用户的 Node；带路径的按 cwd 算、只能在技能里。 */
  const commandFor = async (skill, name, cwd, env) => {
    if (name === "node" || name === "npm" || name === "npx") {
      const node = await which("node", env);
      if (name === "node") return node ? { file: node, prefix: [], node } : { file: process.execPath, prefix: [], env: { ELECTRON_RUN_AS_NODE: "1" } };
      const spec = node && await npmCommand(name, node, env);
      if (!spec) throw noNode();
      return spec;
    }
    if (/[\\/]/u.test(name)) {
      // 绝对路径（比如 environment 里查到的 python）直接用；相对路径按 cwd 算，只能是技能包或工作目录里的程序
      const file = path.isAbsolute(name) ? path.resolve(name) : await resolve(skill, /^~work(?=$|[\\/])/u.test(name) ? name : path.resolve(cwd, name));
      if (!await isFile(file)) throw new AiEditError("command_missing", `没有「${name}」这个程序。`, 422);
      // 应用自己的程序（用自带 Node 时 process.execPath 就是它）：要按 node 跑，不然起的是第二个应用实例
      const real = (item) => realpath(item).catch(() => item);
      if (same(await real(file), await real(process.execPath))) return { file, prefix: [], env: { ELECTRON_RUN_AS_NODE: "1" } };
      return { file, prefix: [], node: await which("node", env) };
    }
    const file = await which(name, env);
    if (!file) throw new AiEditError("command_missing", `找不到命令「${name}」：这台电脑上没装，或者不在 PATH 里。`, 422);
    return { file, prefix: [], node: await which("node", env) };
  };

  const envFor = async (skill, spec) => {
    const vars = await baseEnv();
    const env = cliEnv("skill", vars, {
      proxy: await proxy(),
      extra: {
        // Node 24 起设了这个才按 HTTPS_PROXY 走代理（技能脚本下载素材时用得上）
        NODE_USE_ENV_PROXY: "1",
        DY2_SKILL_DIR: skill.dir, DY2_SKILL_ROOT: skill.root, DY2_WORK_DIR: skill.work,
        PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", FORCE_COLOR: "0",
        ...spec.env,
      },
    });
    // 找到的 Node 不在 PATH 里（nvm 没在 rc 里加载之类）：放到最前面，npm 脚本里的 #!/usr/bin/env node 和子命令才找得到
    if (spec.node) {
      const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
      const dirs = String(env[key] ?? "").split(path.delimiter).filter(Boolean);
      if (!dirs.some((dir) => same(dir, path.dirname(spec.node)))) env[key] = [path.dirname(spec.node), ...dirs].join(path.delimiter);
    }
    return env;
  };

  /** 起一个命令：stdout、stderr 分开收，全文追加写进工作目录的 .runs/<job_id>.log（20MB 以后只计数）。 */
  const start = async (skill, argv, { cwd, background, onOutput }) => {
    if (closed) throw new AiEditError("interrupted", "采集器关掉了，命令没有执行。", 503);
    if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGS || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !argv[0].trim()) {
      throw new AiEditError("command_invalid", "命令要写成参数数组，比如 [\"node\", \"scripts/x.mjs\"]。", 400);
    }
    if (/\s/u.test(argv[0].trim()) && !/[\\/]/u.test(argv[0])) {
      throw new AiEditError("command_invalid", `命令和参数要分开写成数组，比如 ${JSON.stringify(argv[0].trim().split(/\s+/u))}；不经过 shell，没有管道、重定向和 &&。`, 400);
    }
    await mkdir(skill.work, { recursive: true, mode: 0o700 }).catch(fsFailed("写", skill.work));
    const folder = cwd ? await resolve(skill, cwd) : await realpath(skill.root).catch(() => null);
    if (!folder || !await stat(folder).then((info) => info.isDirectory(), () => false)) {
      throw new AiEditError("cwd_invalid", `「${cwd ?? skill.root}」不是一个存在的文件夹。`, 422);
    }
    const work = await realpath(skill.work);
    const spec = await commandFor(skill, argv[0], folder, await baseEnv()).catch((error) => {
      // 找不到命令：环境作废，用户装好了回来再试时现读
      if (error?.code === "command_missing") { userEnv = null; environment = null; }
      throw error;
    });
    const env = await envFor(skill, spec);
    // 参数里的 ~work 换成工作目录（不经过 shell，环境变量也展开不了）
    const expand = (arg) => arg.replace(/^([^=]*=)?~work(?=$|[\\/])(.*)$/su, (_, lead = "", rest) => `${lead}${path.join(skill.work, rest)}`);
    let args = [...spec.prefix, ...argv.slice(1).map(expand)];
    let file = spec.file;
    let verbatim = false;
    if (platform === "win32" && /\.(cmd|bat)$/iu.test(file)) {
      if ([file, ...args].some((arg) => CMD_UNSAFE.test(arg))) {
        throw new AiEditError("argument_unsafe", "这条命令是 .cmd/.bat，要经过 cmd.exe 运行，参数里不能有 & | < > ^ % \" 和换行。", 422);
      }
      args = ["/d", "/s", "/c", `""${file}" ${args.map((arg) => `"${arg}"`).join(" ")}"`];
      file = env.ComSpec ?? process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      verbatim = true;
    }
    await mkdir(path.join(work, ".runs"), { recursive: true, mode: 0o700 });
    // 上面等的时候（登录 shell 可能要好几秒）应用可能关了：close() 只杀已经登记的，这里再看一眼
    if (closed) throw new AiEditError("interrupted", "采集器关掉了，命令没有执行。", 503);
    // 从这里到登记进 active 不能再有 await：两条后台命令同时开时才不会一起挤进去，close() 也插不进来
    if (background && running().length >= MAX_JOBS) {
      throw new AiEditError("too_many_jobs", `已经有 ${MAX_JOBS} 个后台命令在跑了，先用 skill_job 停掉不用的再开新的。`, 409);
    }
    const id = randomBytes(8).toString("hex");
    const logFile = path.join(work, ".runs", `${id}.log`);
    const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    log.on("error", () => undefined);
    log.write(`$ ${argv.join(" ")}\n（在 ${folder}）\n\n`);
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(file, args, { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: platform !== "win32", windowsVerbatimArguments: verbatim });
    } catch (error) {
      log.end();
      throw new AiEditError("command_start_failed", `命令启动不了（${error?.code ?? error?.message}）。`, 422);
    }
    const job = {
      id, skill: skill.name, skillId: skill.id, root: skill.root, command: argv, cwd: folder, work, logFile, background, child,
      startedAt, started_at: now().toISOString(), status: "running", exitCode: null, error: null, stopping: false,
      out: outputText(HEAD_CHARS, TAIL_CHARS), err: outputText(0, ERROR_CHARS),
    };
    active.add(job);
    let logged = 0;
    let unlogged = 0;
    let lastLine = "";
    let lastSent = 0;
    let outputTimer = null;
    const report = () => {
      outputTimer = null;
      lastSent = Date.now();
      try { onOutput(lastLine); } catch { /* 页面状态行出错不影响命令 */ }
    };
    const take = (buffer) => (chunk) => {
      const text = buffer.push(chunk);
      const size = Buffer.byteLength(text);
      if (logged + size <= LOG_BYTES) { log.write(text); logged += size; } else unlogged += size;
      const line = text.split(/[\r\n]+/u).map((item) => item.trim()).filter(Boolean).at(-1);
      // 这一轮已经收尾了（命令退了，它留下的进程还在写）：不再往页面状态行上挂
      if (!line || !onOutput || job.settled) return;
      lastLine = Array.from(line).slice(-LAST_LINE_CHARS).join("");
      const wait = OUTPUT_EVERY_MS - (Date.now() - lastSent);
      if (wait <= 0) report();
      else outputTimer ??= setTimeout(report, wait);
    };
    child.stdout.on("data", take(job.out));
    child.stderr.on("data", take(job.err));
    job.done = new Promise((done) => {
      let ended = false;
      let grace = null;
      // 日志收尾：冲掉解码器里剩的半个字，记上没写进去的字节数
      const finishLog = (then) => {
        job.out.push(new Uint8Array(0), true);
        job.err.push(new Uint8Array(0), true);
        if (unlogged) log.write(`\n（后面还有 ${unlogged} 字节输出没写进日志）\n`);
        if (log.closed) then();
        else {
          log.once("close", () => then());
          log.end();
        }
      };
      // lingering：命令退出了，输出管道还被它起的常驻进程占着，宽限到了就不等了
      const end = (code, lingering = false) => {
        if (ended) return;
        ended = true;
        job.settled = true;
        clearTimeout(grace);
        clearTimeout(outputTimer);
        if (code !== undefined) job.exitCode = code;
        job.status = job.stopping ? "stopped" : "exited";
        active.delete(job);
        if (platform !== "win32" && child.pid && !job.stopping && !closed) {
          job.pgid = child.pid;
          if (groupAlive(job)) keepStray(job);
        }
        if (lingering) {
          // 管道不关：关了常驻进程下次写输出就 EPIPE 崩掉。接着读进日志（照样受 20MB 上限），它真关了再收尾
          child.stdout.unref?.();
          child.stderr.unref?.();
          child.once("close", () => finishLog(() => undefined));
          done();
          return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        finishLog(done);
      };
      child.once("error", (error) => {
        job.error = error;
        job.err.push(Buffer.from(`命令启动不了：${error?.code ?? error?.message}`));
        end(null);
      });
      child.once("exit", (code) => {
        job.exitCode = code;
        grace = setTimeout(() => end(code, true), CLOSE_GRACE_MS);
      });
      child.once("close", (code) => end(code ?? job.exitCode));
    });
    if (background) {
      jobs.set(id, job);
      // 结束了的后台任务留最近 20 个，模型还能查结果
      job.done.then(() => {
        const finished = [...jobs.values()].filter((item) => item.status !== "running");
        for (const item of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(item.id);
      });
    }
    return job;
  };

  // 短的放前面：压缩历史时结果只留开头，日志和产出不能被长输出挤掉
  const jobView = async (job) => ({
    job_id: job.id, status: job.status, ...(strays.has(job) ? { leftover: true } : {}), exit_code: job.exitCode,
    log: job.logFile, new_files: await changedFiles([job.work, job.cwd], job.startedAt - 50),
    stderr_tail: job.err.last(ERROR_CHARS), stdout_tail: job.out.last(TAIL_CHARS),
  });

  return {
    list,

    async enabled() {
      return (await list()).filter((skill) => skill.enabled && !skill.problem);
    },

    async get(idOrName) {
      const all = await list();
      const byId = all.find((skill) => skill.id === idOrName);
      if (byId) return byId;
      const named = all.filter((skill) => skill.name === idOrName);
      if (named.length === 1) return named[0];
      throw notFound(idOrName);
    },

    /** source：GitHub 仓库地址或本机文件夹的完整路径。回 { installed: [技能...] }。 */
    async install(source, { signal } = {}) {
      const parsed = parseSource(source, home);
      return parsed.type === "github" ? installGithub(parsed, signal) : installFolder(parsed);
    },

    async update(id, { enabled, trustCommands } = {}) {
      if ([enabled, trustCommands].some((value) => value !== undefined && typeof value !== "boolean")) {
        throw new AiEditError("skill_patch_invalid", "启用和「运行命令不用问」只能是开或关。", 400);
      }
      return serial(async () => {
        const entry = entries.find((item) => item.id === id);
        if (!entry) throw notFound(id);
        if (enabled !== undefined) entry.enabled = enabled;
        if (trustCommands !== undefined) entry.trustCommands = trustCommands;
        await save();
        return view(entry);
      });
    },

    /**
     * 去掉登记：GitHub 包没有别的技能在用时连文件一起删；本机文件夹不删文件。工作目录都留着。
     * 包目录先改名挪进 .old-（改名是原子的：失败了登记还在，可以再删一次），登记存好了再真删，删不掉的下次启动清。
     */
    async remove(id) {
      return serial(async () => {
        const entry = entries.find((item) => item.id === id);
        if (!entry) throw notFound(id);
        if (busy(entry.root)) throw busyError();
        const packages = packagesDir();
        const drop = entry.source?.type === "github" && within(packages, entry.root) && !same(entry.root, packages)
          && !entries.some((item) => item !== entry && same(item.root, entry.root));
        const trash = drop && await stat(entry.root).then(() => true, () => false) ? path.join(packages, `.old-${randomBytes(6).toString("hex")}`) : null;
        if (trash) await renameRetrying(entry.root, trash);
        const before = entries;
        entries = entries.filter((item) => item !== entry);
        try {
          await save();
        } catch (error) {
          entries = before;
          if (trash) await renameRetrying(trash, entry.root).catch(() => undefined);
          throw error;
        }
        if (trash) await rm(trash, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
        if (drop) await rm(filesList(entry.root), { force: true }).catch(() => undefined);
        return { removed: true };
      });
    },

    resolve,
    readFile: readSkillFile,
    writeFile: writeSkillFile,

    /**
     * 跑一条命令（参数数组，不经过 shell）。前台等它结束（超时杀掉、回 timed_out），后台马上回 job_id。
     * signal 只管前台：用户点停止时杀掉、抛 AbortError；后台任务不跟着这一轮走。
     */
    async run(skill, argv, { cwd, timeoutMs, background = false, signal, onOutput } = {}) {
      signal?.throwIfAborted();
      const job = await start(skill, argv, { cwd, background, onOutput: background ? null : onOutput });
      if (background) return { job_id: job.id, status: "running", log: job.logFile };
      const limit = Math.min(Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        await waitFor(job.done, limit, signal);
      } catch (error) {
        killTree(job.child, { platform, hard: true });
        throw error;
      }
      const timedOut = job.status === "running";
      if (timedOut) {
        killTree(job.child, { platform, hard: true });
        await waitFor(job.done, STOP_WAIT_MS);
      }
      if (job.error) throw new AiEditError("command_start_failed", `命令启动不了（${job.error.code ?? job.error.message}）。`, 422);
      // 短的放前面（同 jobView）
      return {
        job_id: job.id, exit_code: timedOut ? null : job.exitCode, ...(timedOut ? { timed_out: true } : {}),
        duration_seconds: Math.round((Date.now() - job.startedAt) / 100) / 10, truncated: job.out.cut || job.err.cut,
        log: job.logFile, new_files: await changedFiles([job.work, job.cwd], job.startedAt - 50),
        stderr_tail: job.err.tail, stdout_head: job.out.head, stdout_tail: job.out.tail,
      };
    },

    /** 查后台任务（和命令退了、留下的进程还在跑的）：waitMs 等它结束（最多 10 分钟），stop 停掉它。 */
    async job(jobId, { waitMs = 0, stop = false, signal } = {}) {
      prune();
      const job = jobs.get(jobId) ?? [...strays].find((item) => item.id === jobId);
      if (!job) throw new AiEditError("job_not_found", "没有这个后台命令，可能早就结束了（应用重启过也会清空）。", 404);
      if (stop && job.status === "running") {
        job.stopping = true;
        killTree(job.child, { platform });
        await waitFor(job.done, STOP_WAIT_MS);
      } else if (stop && strays.has(job)) {
        await stopStray(job);
      } else if (job.status === "running" && Number(waitMs) > 0) {
        await waitFor(job.done, Math.min(Number(waitMs), MAX_WAIT_MS), signal);
      }
      return jobView(job);
    },

    async jobs() {
      prune();
      const row = (job) => ({ job_id: job.id, skill: job.skill, command: job.command, started_at: job.started_at, status: job.status });
      // 命令退了、留下的进程还在跑的也列出来，设置里才看得到、停得掉
      return [...running().map(row), ...[...strays].map((job) => ({ ...row(job), status: "running", leftover: true }))];
    },

    /** 采集器关掉时：所有命令强杀，不等；命令退了、留下的进程连组杀掉。 */
    async close() {
      closed = true;
      for (const job of active) killTree(job.child, { platform, hard: true });
      prune();
      for (const job of strays) { try { process.kill(-job.pgid, "SIGKILL"); } catch { /* 组已经空了 */ } }
      strays.clear();
      prune();
    },

    /** 这台电脑上有什么（给模型判断技能里的步骤能不能做），一分钟内复用。 */
    async environment() {
      if (environment && Date.now() - environment.at < ENV_TTL_MS) return environment.value;
      const value = (async () => {
        const env = await baseEnv();
        const node = await which("node", env);
        const version = node ? (await runFile(node, ["--version"], { env })).stdout.trim().replace(/^v/u, "") || null : process.versions.node;
        const npm = node ? Boolean(await npmCommand("npm", node, env)) : false;
        return {
          os: `${OS_NAMES[platform] ?? platform} ${os.release()} ${process.arch}`,
          shell: "没有：命令按参数数组直接运行，不经过 shell",
          // 用应用自带的 Node 时路径就是应用本身，照着路径跑会再开一个应用：不报路径，让模型写 node
          node: node ? { path: node, version, bundled: false } : { path: "node", version, bundled: true, note: "这台电脑没装 Node.js，用应用自带的：命令第一项写 node，别写路径。" },
          npm,
          python: await which("python3", env) ?? await which("python", env),
          ffmpeg: await which("ffmpeg", env),
          chrome: findBrowser({ platform, home }),
        };
      })();
      environment = { at: Date.now(), value };
      return value;
    },
  };
}
