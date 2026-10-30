import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { systemProxy } from "./systemProxy.mjs";

// 本机的 Codex CLI / Claude Code 当 AI 用：走用户自己登录的订阅，不用填接口和 Key。
// 每次调用起一个不落盘的 CLI 进程，自带的命令行、读写文件、网页、插件全关掉，也不加载用户的 CLAUDE.md、hooks、插件、MCP 和 config.toml；
// 环境和用户在终端里用 CLI 时一样（登录 shell 里的变量，加上 Claude Code settings.json 里的 env），走中转的配置照样能用。
// AI 助手的工具由调用方开一个本机 MCP 端点交给它（collector/assistant/mcp.mjs）。

export const LOCAL_RUNTIMES = {
  // 0.161 起才能把 MCP 工具直接摊给模型（direct_only_tool_namespaces），更早的版本工具藏在 JS 沙箱里
  codex: { label: "Codex", minVersion: "0.161.0" },
  claude: { label: "Claude Code", minVersion: "2.1.0" },
};

export const isLocalRuntime = (value) => typeof value === "string" && Object.hasOwn(LOCAL_RUNTIMES, value);

export function runtimeLabel(runtime, model = "") {
  const label = LOCAL_RUNTIMES[runtime]?.label ?? runtime;
  return `${label}（${model || "默认模型"}）`;
}

/** 请求体里的本机运行时配置（信任边界）：不要地址和 Key，模型选填（留空用 CLI 自己的默认）。 */
export function parseLocalConfig(value, fail) {
  const model = typeof value?.model === "string" ? value.model.trim().slice(0, 120) : "";
  if (model && !/^[\w.:/[\]-]+$/u.test(model)) throw fail("模型名只能用字母、数字和 - . _ : /，留空就用默认模型。");
  return { runtime: value.runtime, model };
}

export class LocalAiError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "LocalAiError";
    this.code = code;
    this.status = status;
  }
}

const STATUS_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const SHELL_TIMEOUT_MS = 8_000;
// 登录 shell 没读出来（rc 太慢之类）先用本进程的环境，过一阵再读一次
const SHELL_RETRY_MS = 5 * 60_000;
// 助手的工具最慢是下载视频和等用户点确认卡片（最长 15 分钟），CLI 那边别先放弃
const TOOL_TIMEOUT_SECONDS = 1_200;
const MAX_TURNS = 120;
const STDERR_TAIL = 4_000;

// Codex 的这些能力和助手无关，有的能跑命令、读文件。能读本机文件的几个必须在列表里（改了名就关不掉，判成版本对不上）
const CODEX_OFF = ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "memories", "goals", "hooks", "skill_search",
  "tool_suggest", "browser_use", "computer_use", "image_generation", "remote_plugin", "sleep_tool", "view_image"];
const CODEX_MUST_OFF = ["shell_tool", "unified_exec", "view_image"];
const CODEX_AUTH_STORES = new Set(["file", "keyring", "auto", "ephemeral"]);
// 跑在 Claude Code / Codex 会话里开发时继承下来的宿主变量：带过去会让被调起的 CLI 以为自己嵌在别人里面。
// 只在读不到登录 shell、退回本进程环境时才去掉（Windows 一直是这样）；登录 shell 里的都是用户自己设的，原样留着。
// 用户自己会设的几个同前缀变量（订阅令牌、走 Bedrock/Vertex、公司代理的根证书）回退时也留着
const HOST_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CODEX_.*|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|MCP_.*)$/u;
const USER_VARS = /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_SKIP_\w+_AUTH|CLAUDE_CODE_CLIENT_\w+|CLAUDE_CODE_GIT_BASH_PATH|CODEX_HOME|CODEX_CA_CERTIFICATE)$/u;

const NATIVE_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
};

const exists = async (file) => {
  try { return (await stat(file)).isFile(); } catch { return false; }
};

/**
 * 跑一条命令拿输出（检测版本、登录状态这类）：stdin 关掉，输出只留前 1MB。
 * 到点就杀整组、不等它关管道（rc 里起的后台进程会一直占着输出管道）；until(stdout) 为真就提前收工。
 */
/** signal 断了就杀掉进程，回 { code: null, aborted: true } */
export function runFile(command, args, { env, cwd, timeoutMs = CHECK_TIMEOUT_MS, until, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout, stderr, ...result });
    };
    const take = (current, chunk) => (current.length < 1_000_000 ? current + chunk : current);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout = take(stdout, chunk);
      if (until?.(stdout)) finish({ code: 0 });
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = take(stderr, chunk); });
    const timer = setTimeout(() => { killTree(child, { hard: true }); finish({ code: null }); }, timeoutMs);
    const stop = () => { killTree(child, { hard: true }); finish({ code: null, aborted: true }); };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => finish({ code: null, error }));
    child.once("close", (code) => finish({ code }));
  });
}

/**
 * 登录 shell 的环境：从 Finder 打开的应用 PATH 只有 /usr/bin:/bin，找不到 nvm、~/.local/bin 里的 CLI，
 * 用户在 .zshrc 里设的代理、CODEX_HOME 也拿不到。必须带 -i：只用 -l 不读 .zshrc（实测会找到别处的旧版 codex）。
 * 传给 shell 的环境只留最基本的几项，拿到的就只是用户自己 rc 里设的，宿主进程的变量带不进去。
 */
export async function loginShellEnv({ platform = process.platform, env = process.env, run = runFile } = {}) {
  if (platform === "win32") return null;
  const shell = env.SHELL || os.userInfo().shell || "/bin/zsh";
  const mark = randomBytes(8).toString("hex");
  const base = Object.fromEntries(["HOME", "USER", "LOGNAME", "LANG", "TMPDIR"].filter((key) => env[key]).map((key) => [key, env[key]]));
  const { code, stdout } = await run(shell, ["-ilc", `printf %s ${mark}; env -0; printf %s ${mark}`], {
    env: { ...base, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb" },
    timeoutMs: SHELL_TIMEOUT_MS,
    // 读到第二个标记就够了，不等 shell 退出（rc 里有意起的后台进程不去碰它）
    until: (text) => text.indexOf(mark) >= 0 && text.lastIndexOf(mark) > text.indexOf(mark),
  });
  const start = stdout.indexOf(mark);
  const end = stdout.lastIndexOf(mark);
  // rc 文件打印的杂音在标记外面；退出码不看，有的 rc 最后一条命令失败也不影响
  if (code === null || start < 0 || end <= start) return null;
  const vars = {};
  for (const entry of stdout.slice(start + mark.length, end).split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) vars[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return vars.PATH ? { ...base, ...vars } : null;
}

function versionNumber(text) {
  return String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number) ?? null;
}

function older(version, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] < minimum[index];
  }
  return false;
}

async function nvmBins(home) {
  const root = path.join(home, ".nvm", "versions", "node");
  let names = [];
  try { names = await readdir(root); } catch { return []; }
  return names.map((name) => ({ name, version: versionNumber(name) ?? [0, 0, 0] }))
    .sort((a, b) => (older(a.version, b.version) ? 1 : older(b.version, a.version) ? -1 : 0))
    .map(({ name }) => path.join(root, name, "bin"));
}

export async function searchDirs({ platform, env, home }) {
  const pathVar = env.PATH ?? env.Path ?? "";
  const listed = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [...listed, path.join(local, "Programs", "OpenAI", "Codex", "bin"), path.join(home, ".local", "bin"), path.join(roaming, "npm")];
  }
  return [...listed, path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"), path.join(home, ".npm-global", "bin"), ...await nvmBins(home)];
}

async function isScript(file) {
  if (/\.[cm]?js$/iu.test(file)) return true;
  let handle;
  try {
    handle = await open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    return /^#!.*\bnode\b/u.test(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * npm 装的 codex 是 #!/usr/bin/env node 的小脚本，GUI 应用的 PATH 里没有 node 就起不来：
 * 换成它包里自带的原生程序；找不到再用应用自己的 Node（Electron 设 ELECTRON_RUN_AS_NODE）跑脚本。
 */
async function launchSpec(file, { platform, arch }) {
  const real = await realpath(file).catch(() => file);
  if (!await isScript(real)) return { command: real, prefix: [], env: {}, path: real };
  const triple = NATIVE_TRIPLES[`${platform}-${arch}`];
  const root = path.dirname(path.dirname(real));
  const exe = platform === "win32" ? ".exe" : "";
  if (triple && /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/u.test(real)) {
    for (const native of [
      path.join(root, "node_modules", "@openai", `codex-${platform}-${arch}`, "vendor", triple, "bin", `codex${exe}`),
      path.join(root, "vendor", triple, "bin", `codex${exe}`),
    ]) {
      if (await exists(native)) return { command: native, prefix: [], env: {}, path: real };
    }
  }
  return { command: process.execPath, prefix: [real], env: { ELECTRON_RUN_AS_NODE: "1" }, path: real };
}

// npm 全局装在 Windows 上的：.cmd 旁边 node_modules 里真正要起的那个
const NPM_TARGETS = {
  codex: ["@openai", "codex", "bin", "codex.js"],
  claude: ["@anthropic-ai", "claude-code", "bin", "claude.exe"],
};

/** 找 CLI：PATH 里和常见安装位置挨个看。Windows 永远不起 .cmd（Node 起 .cmd 要过 cmd.exe，参数一转义就乱）。 */
export async function findCli(id, { platform = process.platform, arch = process.arch, env = process.env, home = os.homedir() } = {}) {
  for (const dir of await searchDirs({ platform, env, home })) {
    if (platform !== "win32") {
      const file = path.join(dir, id);
      if (await exists(file)) return launchSpec(file, { platform, arch });
      continue;
    }
    const exe = path.join(dir, `${id}.exe`);
    if (await exists(exe)) return launchSpec(exe, { platform, arch });
    if (!NPM_TARGETS[id] || !await exists(path.join(dir, `${id}.cmd`))) continue;
    const target = path.join(dir, "node_modules", ...NPM_TARGETS[id]);
    if (await exists(target)) return launchSpec(target, { platform, arch });
  }
  return null;
}

/** 读不到登录 shell 时用本进程的环境，去掉宿主会话的变量。 */
export function withoutHostVars(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !HOST_VARS.test(key) || USER_VARS.test(key)));
}

/**
 * Claude Code settings.json 里和登录有关的两项（走中转的人常把地址和令牌写在 env 里，或者用 apiKeyHelper 取令牌）：
 * 只取这两项，hooks、插件、权限这些照旧不加载。apiKeyHelper 写进只有本人能读的临时文件、用 --settings 交给 CLI
 * （它可能直接带着密钥，不能进命令行），检测和运行都带上。
 */
export async function claudeUserSettings(env, home = os.homedir()) {
  const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
  try {
    const settings = JSON.parse(await readFile(file, "utf8"));
    const vars = settings?.env && typeof settings.env === "object" ? Object.fromEntries(Object.entries(settings.env).filter(([, item]) => typeof item === "string")) : {};
    return { env: vars, apiKeyHelper: typeof settings?.apiKeyHelper === "string" ? settings.apiKeyHelper : "" };
  } catch {
    return { env: {}, apiKeyHelper: "" };
  }
}



/**
 * 给 CLI 的环境：以登录 shell 的为准（和用户在终端里用 CLI 时一样）。
 * shell 里没设代理就补上系统代理（国内直连 OpenAI、Anthropic 多半不通），本机地址一律不走代理（连我们的 MCP 端点）。
 */
export function cliEnv(id, base, { proxy = null, extra = {} } = {}) {
  const env = { ...base };
  const hasProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((key) => env[key]);
  if (!hasProxy && proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy });
  const local = "127.0.0.1,localhost,::1";
  for (const key of ["NO_PROXY", "no_proxy"]) env[key] = env[key] ? `${env[key]},${local}` : local;
  if (id === "claude") {
    Object.assign(env, {
      // 消息里的「@路径」会被 Claude Code 当附件读进来（关了工具也挡不住），抖音标题这类文字里可能有
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
      // 不在后台更新插件市场、不发统计；重试别等太久
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_MAX_RETRIES: "2",
    });
  }
  return { ...env, ...extra };
}

/**
 * 不加载用户的 config.toml 时，自己读出顶层的几项：默认模型（留空时用），凭据存在哪（存在钥匙串里的不告诉它就找不到）。
 * 默认走第三方中转的配置不加载就丢了中转，那家的模型名官方后端不认，这时模型留空让 Codex 用内置默认。
 */
export async function codexUserConfig(env, home = os.homedir()) {
  const file = path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return { model: "", authStore: "" }; }
  const top = text.split(/^\s*\[/mu)[0];
  const value = (key) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]{1,200})"\\s*(?:#.*)?$`, "mu"))?.[1] ?? "";
  const provider = value("model_provider");
  const relay = (provider && provider !== "openai") || value("openai_base_url");
  const authStore = value("cli_auth_credentials_store");
  return { model: relay ? "" : value("model").slice(0, 120), authStore: CODEX_AUTH_STORES.has(authStore) ? authStore : "" };
}

export function claudeArgs({ systemFile, mcpFile, model, settingsFile = "", maxTurns = MAX_TURNS }) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    // 空串 = 不要任何自带工具（Bash、Read、Write、WebFetch…）；不读用户和项目的 settings、CLAUDE.md、hooks、插件
    "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--permission-mode", "dontAsk",
    "--system-prompt-file", systemFile, "--no-session-persistence", "--max-turns", String(maxTurns),
    ...(settingsFile ? ["--settings", settingsFile] : []),
    ...(mcpFile ? ["--mcp-config", mcpFile, "--allowedTools", "mcp__dy2"] : []),
    ...(model ? [`--model=${model}`] : []),
  ];
}

export function codexArgs({ workDir, systemFile, mcpUrl, model, effort, features = null, authStore = "" }) {
  // JSON 的字符串、数组、布尔、数字写法也是合法的 TOML（Windows 路径里的反斜杠也转义好了）
  const config = (key, value) => ["-c", `${key}=${JSON.stringify(value)}`];
  const off = features ? CODEX_OFF.filter((name) => features.has(name)) : CODEX_OFF;
  return [
    "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", workDir,
    "--sandbox", "read-only", ...config("approval_policy", "never"),
    ...off.flatMap((name) => ["--disable", name]),
    ...config("web_search", "disabled"),
    ...config("include_permissions_instructions", false), ...config("include_apps_instructions", false),
    ...config("include_collaboration_mode_instructions", false), ...config("include_environment_context", false),
    ...config("skills.include_instructions", false), ...config("skills.bundled.enabled", false),
    ...config("tools.experimental_request_user_input.enabled", false),
    ...(authStore ? config("cli_auth_credentials_store", authStore) : []),
    ...config("model_reasoning_effort", effort), ...config("model_instructions_file", systemFile),
    ...(mcpUrl ? [
      // 不加这一条，MCP 工具藏在 JS 沙箱里、模型一开始看不到参数；不自动批准的话 exec 模式下每次调用都被拦
      ...config("features.code_mode.direct_only_tool_namespaces", ["mcp__dy2"]),
      ...config("mcp_servers.dy2.url", mcpUrl), ...config("mcp_servers.dy2.bearer_token_env_var", "DY2_MCP_TOKEN"),
      ...config("mcp_servers.dy2.default_tools_approval_mode", "approve"),
      // 连不上就别跑：不设的话它会没有工具也照样做完一轮
      ...config("mcp_servers.dy2.required", true), ...config("mcp_servers.dy2.startup_timeout_sec", 20),
      ...config("mcp_servers.dy2.tool_timeout_sec", TOOL_TIMEOUT_SECONDS),
    ] : []),
    ...(model ? [`--model=${model}`] : []),
    "-",
  ];
}

/** 一行一个事件的解析：Claude 看 is_error 和 api_error_status，别看 subtype（接口出错时 subtype 照样是 success）。 */
function claudeReader({ onText, onDelta, agent }) {
  let current = "";
  const state = { done: false, failure: null, apiError: null };
  return {
    state,
    line(event) {
      // 应用的工具没连上：调用方马上停掉进程，之后的话不用了
      if (state.failure?.kind === "mcp") return;
      if (event.type === "system" && event.subtype === "init" && agent) {
        if (event.mcp_servers?.find((server) => server.name === "dy2")?.status === "failed") state.failure = { kind: "mcp" };
      } else if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
        current += event.event.delta.text ?? "";
        onDelta(current);
      } else if (event.type === "assistant") {
        // 接口出错时 CLI 先发一条合成的「回答」，里面是英文报错原文：只拿来判断出了什么错，不当成 AI 说的话
        if (typeof event.error === "string" || event.message?.model === "<synthetic>") {
          if (typeof event.error === "string") state.apiError = event.error;
          current = "";
          return;
        }
        for (const block of event.message?.content ?? []) {
          if (block?.type === "text" && block.text) {
            current = "";
            onText(block.text);
          }
        }
      } else if (event.type === "result") {
        state.done = true;
        if (event.subtype === "error_max_turns") state.limit = true;
        else if (event.is_error) state.failure = { kind: "api", status: event.api_error_status ?? null, error: state.apiError, text: String(event.result ?? (event.errors ?? []).join(" ")) };
      }
    },
  };
}

/** Codex：只有 turn.completed 才算做完；单条 error 事件多半是配置提醒或重连，不算失败。 */
function codexReader({ onText }) {
  const state = { done: false, failure: null, lastError: "" };
  return {
    state,
    line(event) {
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) onText(event.item.text);
      else if (event.type === "error" && typeof event.message === "string") state.lastError = event.message;
      else if (event.type === "turn.completed") state.done = true;
      else if (event.type === "turn.failed") state.failure = { kind: "api", text: unwrapMessage(event.error?.message) };
    },
  };
}

// turn.failed 的 message 常常是一段 JSON 字符串（里面才是接口的报错）
function unwrapMessage(text) {
  const raw = String(text ?? "");
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {
    return raw;
  }
}

/** CLI 的失败说成人话；登录、额度、模型名这几种最常见。 */
export function cliFailure(id, { failure, code = null, stderr = "", model = "" }) {
  const label = LOCAL_RUNTIMES[id].label;
  const login = id === "codex" ? "codex login" : "claude auth login";
  const text = `${failure?.error ?? ""} ${failure?.text ?? ""} ${failure ? "" : stderr}`;
  const status = failure?.status ?? Number(text.match(/\b(401|403|404|429|529)\b/u)?.[1] ?? 0);
  if (failure?.kind === "mcp" || /required MCP servers? failed/iu.test(stderr)) {
    return new LocalAiError("local_tools_unavailable", `${label} 没连上应用的工具，这一轮什么都没做。再试一次，还不行就重启应用。`);
  }
  if (status === 401 || /authentication_failed|unauthori[sz]ed|not logged in|log ?in again|sign in again|refresh token|expired/iu.test(text)) {
    return new LocalAiError("local_login", `${label} 没登录或者登录过期了。先在终端里运行 ${login} 登录一次，再试。`);
  }
  if (status === 429 || /rate_limit|usage limit|quota|too many requests/iu.test(text)) {
    return new LocalAiError("local_rate_limit", `${label} 这段时间的用量到上限了，等额度恢复了再试。`);
  }
  if (status === 404 || /model_not_found|model .*not (supported|found|exist)|unrecognized_model/iu.test(text)) {
    return new LocalAiError("local_model", `${label} 用不了「${model || "默认"}」这个模型，到 AI 设置里换一个，或者留空用默认模型。`);
  }
  if (status === 529 || /overloaded/iu.test(text)) return new LocalAiError("local_busy", `${label} 那边现在太忙，稍后再试。`);
  if (failure) {
    const detail = String(failure.text || failure.error || "").trim().slice(0, 160);
    return new LocalAiError("local_failed", `${label} 这一轮出错了${detail ? `：${detail}` : ""}。`);
  }
  const last = stderr.trim().split("\n").at(-1)?.trim().slice(0, 160);
  return new LocalAiError("local_crashed", `${label} 意外退出了（退出码 ${code ?? "未知"}）${last ? `：${last}` : ""}。`);
}

/** 杀整棵进程树：npm 版 codex 是小脚本带着原生程序，只杀外面那层里面的会变孤儿。 */
export function killTree(child, { platform = process.platform, hard = false } = {}) {
  if (!child?.pid) return;
  if (platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  const signal = (name) => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* 已经退了 */ } } };
  // SIGINT 让 CLI 收个尾（Codex 会给 MCP 发 DELETE），一秒半还没走就强杀
  signal(hard ? "SIGKILL" : "SIGINT");
  if (!hard) setTimeout(() => signal("SIGKILL"), 1_500).unref();
}


/**
 * dataDirectory：采集器数据目录，CLI 的工作目录和每次运行的临时文件放在它下面的 local-ai/ 里。
 * 测试可以注入 resolve(id) → { command, prefix, env }、shellEnv()、run、proxy()。
 */
export function createLocalAi({
  dataDirectory,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  resolve: injectedResolve,
  shellEnv = () => loginShellEnv({ platform }),
  run = runFile,
  proxy = () => systemProxy().then((value) => value?.url ?? null).catch(() => null),
  statusTtlMs = STATUS_TTL_MS,
} = {}) {
  const root = path.join(dataDirectory, "local-ai");
  const workDir = path.join(root, "work");
  const runsDir = path.join(root, "runs");
  const children = new Set();
  const statuses = new Map();
  const closed = new AbortController();
  let environment = null;
  let fallbackAt = 0;
  let prepared = null;

  // 固定一个空目录当工作目录：Claude Code 会按工作目录在用户的 ~/.claude/projects 下建目录，每次换一个会越堆越多
  const prepare = () => {
    prepared ??= (async () => {
      await rm(runsDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await mkdir(runsDir, { recursive: true, mode: 0o700 });
      return realpath(workDir);
    })().catch((error) => { prepared = null; throw error; });
    return prepared;
  };

  const baseEnv = (fresh) => {
    if (fresh || (fallbackAt && Date.now() - fallbackAt > SHELL_RETRY_MS)) {
      environment = null;
      fallbackAt = 0;
    }
    environment ??= (async () => {
      const vars = await Promise.resolve().then(shellEnv).catch(() => null);
      if (vars) return vars;
      fallbackAt = Date.now();
      return withoutHostVars(process.env);
    })();
    return environment;
  };

  const resolve = async (id, fresh) => {
    if (injectedResolve) return injectedResolve(id);
    return findCli(id, { platform, arch, env: await baseEnv(fresh), home });
  };

  const envFor = async (id, spec, extra) => {
    const base = await baseEnv(false);
    const settings = id === "claude" ? (await claudeUserSettings(base, home)).env : {};
    return cliEnv(id, { ...base, ...settings }, { proxy: await proxy(), extra: { ...spec.env, ...extra } });
  };

  const check = (spec, args, env) => run(spec.command, [...spec.prefix, ...args], { env, cwd: home });

  const detect = async (id, fresh) => {
    const { label, minVersion } = LOCAL_RUNTIMES[id];
    const spec = await resolve(id, fresh);
    const base = { id, label, version: null, path: spec?.path ?? null };
    if (!spec) return { ...base, state: "missing", message: `这台电脑上没找到 ${label}。装好并在终端里登录一次后，点「重新检测」。` };
    const env = await envFor(id, spec, {});
    const versionRun = await check(spec, ["--version"], env);
    const version = versionNumber(versionRun.stdout);
    if (!version) {
      const reason = (versionRun.error?.code ?? versionRun.stderr.trim().split("\n").at(-1) ?? "").toString().slice(0, 120);
      return { ...base, state: "broken", message: `找到了 ${label}，但它启动不了${reason ? `（${reason}）` : ""}。重新装一遍再试。` };
    }
    const shown = version.join(".");
    if (older(version, versionNumber(minVersion))) {
      return { ...base, version: shown, state: "unsupported", message: `这台电脑上的 ${label} 是 ${shown}，太旧了，先更新到 ${minVersion} 以上。` };
    }
    let features = null;
    if (id === "codex") {
      const login = await check(spec, ["login", "status"], env);
      if (login.code !== 0) return { ...base, version: shown, state: "logged_out", message: "Codex 还没登录。先在终端里运行 codex login 登录一次，再点「重新检测」。" };
      const listed = await check(spec, ["features", "list"], env);
      const names = new Set([...listed.stdout.matchAll(/^([a-z0-9_]+)\s+\S/gmu)].map((match) => match[1]));
      // 关不掉命令行的版本不能用：它会在对话的时候能读用户的文件
      if (listed.code === 0 && names.size && !CODEX_MUST_OFF.every((name) => names.has(name))) {
        return { ...base, version: shown, state: "unsupported", message: `这台电脑上的 Codex ${shown} 和应用对不上，更新到最新版再试。` };
      }
      features = listed.code === 0 && names.size ? names : null;
    } else {
      // JSON 版过期了也写 loggedIn:true，要看文字版；和真正跑的时候一样不读 settings（里面的 env 已经放进环境了）
      const { apiKeyHelper } = await claudeUserSettings(await baseEnv(false), home);
      const auth = await withRunDir(async (dir) => {
        const settingsFile = await helperFile(dir, apiKeyHelper);
        return check(spec, ["--setting-sources", "", ...(settingsFile ? ["--settings", settingsFile] : []), "auth", "status", "--text"], env);
      });
      if (/expired/iu.test(auth.stdout)) return { ...base, version: shown, state: "expired", message: "Claude Code 的登录过期了。先在终端里运行 claude auth login 重新登录，再点「重新检测」。" };
      if (auth.code !== 0 || /not logged in/iu.test(auth.stdout)) return { ...base, version: shown, state: "logged_out", message: "Claude Code 还没登录。先在终端里运行 claude auth login 登录一次，再点「重新检测」。" };
    }
    return { ...base, version: shown, state: "ready", message: `已经找到 ${label} ${shown}，也登录好了。`, features };
  };

  /** 装没装、登没登录（不花额度）：给设置面板看，每次起进程前也查一下（Codex 没登录时要重连二十秒才报错）。 */
  const status = async (id, { fresh = false } = {}) => {
    const cached = statuses.get(id);
    if (!fresh && cached && Date.now() - cached.at < statusTtlMs) return cached.value;
    const pending = detect(id, fresh).then((value) => {
      statuses.set(id, { at: value.state === "ready" ? Date.now() : 0, value: pending });
      return value;
    });
    statuses.set(id, { at: Date.now(), value: pending });
    return pending;
  };

  const ready = async (id) => {
    const found = await status(id);
    if (found.state !== "ready") throw new LocalAiError(`local_${found.state}`, found.message, 503);
    return found;
  };

  /** 起一次 CLI：stdin 写完就关，按行读事件；停止时杀整棵进程树。 */
  const launch = async (id, { spec, args, env, input, reader, signal, model }) => {
    const cwd = await prepare();
    const stop = AbortSignal.any([signal, closed.signal].filter(Boolean));
    stop.throwIfAborted();
    const child = spawn(spec.command, [...spec.prefix, ...args], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: platform !== "win32",
    });
    children.add(child);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      // 停了以后 CLI 还要一会儿才退，这期间吐出来的话不算数（用户已经看到「已停止」了）
      if (stop.aborted || !line.startsWith("{")) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { reader.line(event); } catch (error) { console.error("本机 AI 事件处理出错:", error); }
      // Claude Code 连不上应用的工具也会接着跑完一轮（白花额度），看到了就停
      if (reader.state.failure?.kind === "mcp") killTree(child, { platform, hard: true });
    });
    const abort = () => killTree(child, { platform, hard: closed.signal.aborted });
    stop.addEventListener("abort", abort, { once: true });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", (error) => reject(error));
        child.once("close", (exitCode) => resolve(exitCode));
      }).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "EACCES") throw new LocalAiError("local_missing", `这台电脑上的 ${LOCAL_RUNTIMES[id].label} 启动不了，到 AI 设置里点「重新检测」看看。`, 503);
        throw error;
      });
      stop.throwIfAborted();
      if (reader.state.failure || !reader.state.done) throw cliFailure(id, { failure: reader.state.failure, code, stderr: `${stderr}\n${reader.state.lastError ?? ""}`, model });
      return reader.state;
    } finally {
      stop.removeEventListener("abort", abort);
      lines.close();
      children.delete(child);
    }
  };

  const withRunDir = async (work) => {
    await prepare();
    const dir = await mkdtemp(path.join(runsDir, "run-"));
    try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  };

  const writePrivate = (file, text) => writeFile(file, text, { mode: 0o600 });

  /** 有 apiKeyHelper 就写一份只含它的设置文件，返回路径；没有返回空串。 */
  const helperFile = async (dir, apiKeyHelper) => {
    if (!apiKeyHelper) return "";
    const file = path.join(dir, "settings.json");
    await writePrivate(file, JSON.stringify({ apiKeyHelper }));
    return file;
  };

  // 起进程之前的几步（检测、找程序、读配置）也要能停：rc 卡住时别让停止按钮和超时失灵
  const abortable = (promise, signal) => (!signal ? promise : new Promise((resolve, reject) => {
    // 先停了的话里面那个照样跑完，它后来报的错要有人接（没人接的拒绝会让 node 跑的采集器整个退出）
    promise.catch(() => undefined);
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  }));

  /** 起进程前的准备：确认能用、找到程序、定下模型（Codex 留空时读用户配置里的）。 */
  const setup = (id, model, signal) => abortable((async () => {
    const found = await ready(id);
    const spec = await resolve(id, false);
    if (!spec) throw new LocalAiError("local_missing", found.message, 503);
    const codex = id === "codex" ? await codexUserConfig(await baseEnv(false), home) : null;
    const claude = id === "claude" ? await claudeUserSettings(await baseEnv(false), home) : null;
    return { found, spec, model: model || codex?.model || "", authStore: codex?.authStore ?? "", apiKeyHelper: claude?.apiKeyHelper ?? "" };
  })(), AbortSignal.any([signal, closed.signal].filter(Boolean)));

  // Codex 会把「$技能名」展开成用户本机那个技能的全文（抖音标题、私信这类外来文字里可能有）：换成全角就不会。
  // 价格（$ 后面只有数字，比如 $5、$9.9、$1,000）原样留着（ponytail: 用户自己写的「$ABC」也会变全角，真碰上再按已装技能名精确替换）
  const noSkillMention = (text) => text.replace(/\$(?=\d*[A-Za-z_])/gu, "＄");

  /**
   * 带工具跑一轮：mcp = { url, secret }，CLI 通过它调应用的工具。
   * onText(这一段说完的话)、onDelta(这一段到目前为止的字)：Claude 能逐字出，Codex 只能一段一段出。
   */
  const converse = async (id, { model = "", systemPrompt, prompt, mcp, signal, onText = () => undefined, onDelta = () => undefined }) => {
    const { found, spec, model: chosen, authStore, apiKeyHelper } = await setup(id, model, signal);
    return withRunDir(async (dir) => {
      const systemFile = path.join(dir, "system.md");
      await writePrivate(systemFile, systemPrompt);
      if (id === "claude") {
        const mcpFile = path.join(dir, "mcp.json");
        await writePrivate(mcpFile, JSON.stringify({ mcpServers: { dy2: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.secret}` }, timeout: TOOL_TIMEOUT_SECONDS * 1000 } } }));
        const input = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null, session_id: "" })}\n`;
        const args = claudeArgs({ systemFile, mcpFile, model: chosen, settingsFile: await helperFile(dir, apiKeyHelper) });
        return launch(id, { spec, args, env: await envFor(id, spec, {}), input, reader: claudeReader({ onText, onDelta, agent: true }), signal, model: chosen });
      }
      const args = codexArgs({ workDir: await prepare(), systemFile, mcpUrl: mcp.url, model: chosen, effort: "medium", features: found.features, authStore });
      // MCP 的密钥只放环境变量，不进命令行（同一台电脑的其他账户用 ps 看得到命令行）
      return launch(id, { spec, args, env: await envFor(id, spec, { DY2_MCP_TOKEN: mcp.secret }), input: noSkillMention(prompt), reader: codexReader({ onText }), signal, model: chosen });
    });
  };

  /** 采集器关掉时：正在跑的 CLI 全部强杀，不留着继续花额度。 */
  const close = async () => {
    closed.abort(new LocalAiError("local_closed", "采集器关掉了。", 503));
    for (const child of children) killTree(child, { platform, hard: true });
  };

  return { status, converse, close };
}
