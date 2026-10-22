import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openMcp } from "./aiEdit/mcp.mjs";
import { claudeArgs, claudeUserSettings, cliEnv, cliFailure, codexArgs, codexUserConfig, createLocalAi, findCli, loginShellEnv, parseLocalConfig, runFile, withoutHostVars } from "./localAi.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/local-ai/fake-cli.mjs");
const ECHO = [{ type: "function", function: { name: "echo", description: "回声", parameters: { type: "object", properties: { text: { type: "string" } } } } }];

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 用假 CLI 起一个 localAi：plan 是剧本，records() 读每次运行的记录。 */
async function fakeAi(plan) {
  const directory = await temporaryDirectory("local-ai-");
  const planFile = path.join(directory, "plan.json");
  const recordFile = path.join(directory, "record.jsonl");
  await writeFile(planFile, JSON.stringify(plan));
  const ai = createLocalAi({
    dataDirectory: directory,
    resolve: async (id) => (plan.missing?.includes(id) ? null : { command: process.execPath, prefix: [FAKE, id], env: {}, path: FAKE }),
    shellEnv: async () => ({ ...withoutHostVars(process.env), FAKE_PLAN: planFile, FAKE_RECORD: recordFile, CLAUDE_CODE_OAUTH_TOKEN: "user-token", ...plan.env }),
    proxy: async () => null,
  });
  cleanups.push(() => ai.close());
  const records = async () => (await readFile(recordFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ai, records, directory, setPlan: (next) => writeFile(planFile, JSON.stringify(next)) };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("finding the CLI", () => {
  it.skipIf(process.platform === "win32")("swaps the npm wrapper of codex for its native program", async () => {
    const root = await temporaryDirectory("find-cli-");
    const pkg = path.join(root, "lib", "node_modules", "@openai", "codex");
    const native = path.join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex");
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(path.join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
    await writeFile(native, "binary");
    await mkdir(path.join(root, "bin"));
    await symlink(path.join(pkg, "bin", "codex.js"), path.join(root, "bin", "codex"));
    const found = await findCli("codex", { platform: "darwin", arch: "arm64", env: { PATH: path.join(root, "bin") }, home: root });
    expect(found).toMatchObject({ command: await realpath(native), prefix: [] });
  });

  it("runs a script with the app's own Node when there is no native program, and never starts a .cmd on Windows", async () => {
    const root = await temporaryDirectory("find-cli-");
    const npm = path.join(root, "npm");
    const script = path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "#!/usr/bin/env node\n");
    await writeFile(path.join(npm, "codex.cmd"), "@echo off\n");
    const found = await findCli("codex", { platform: "win32", arch: "x64", env: { Path: npm, LOCALAPPDATA: root, APPDATA: root }, home: root });
    expect(found.command).toBe(process.execPath);
    expect(found.prefix[0]).toMatch(/codex\.js$/u);
    expect(found.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(await findCli("claude", { platform: "win32", arch: "x64", env: { Path: npm, LOCALAPPDATA: root, APPDATA: root }, home: root })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("looks in the usual folders, newest nvm first, when PATH has nothing", async () => {
    const home = await temporaryDirectory("find-cli-");
    for (const version of ["v20.1.0", "v24.18.0", "v9.0.0"]) {
      await mkdir(path.join(home, ".nvm", "versions", "node", version, "bin"), { recursive: true });
      await writeFile(path.join(home, ".nvm", "versions", "node", version, "bin", "codex"), "binary");
    }
    await mkdir(path.join(home, ".local", "bin"), { recursive: true });
    await writeFile(path.join(home, ".local", "bin", "claude"), "binary");
    expect((await findCli("codex", { platform: "darwin", arch: "arm64", env: { PATH: "/nonexistent" }, home })).command).toContain("v24.18.0");
    expect((await findCli("claude", { platform: "darwin", arch: "arm64", env: {}, home })).command).toBe(await realpath(path.join(home, ".local", "bin", "claude")));
  });

  it("reads the login shell environment between markers and ignores rc noise", async () => {
    const run = async (shell, args) => {
      const mark = args[1].match(/printf %s ([0-9a-f]+);/u)[1];
      return { code: 0, stdout: `oh-my-zsh 有更新\n${mark}PATH=/x/bin\0LINES=a\nb\0${mark}`, stderr: "" };
    };
    expect(await loginShellEnv({ platform: "darwin", env: { SHELL: "/bin/zsh", HOME: "/h" }, run })).toEqual({ HOME: "/h", PATH: "/x/bin", LINES: "a\nb" });
    expect(await loginShellEnv({ platform: "darwin", env: { SHELL: "/bin/zsh" }, run: async () => ({ code: null, stdout: "" }) })).toBeNull();
    expect(await loginShellEnv({ platform: "win32" })).toBeNull();
  });
});

describe("what the CLI gets", () => {
  it("keeps the user's own settings, adds the system proxy and keeps local addresses direct; drops host session variables only from our own environment", () => {
    const env = cliEnv("claude", { PATH: "/bin", ANTHROPIC_BASE_URL: "https://relay", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_CA_CERTIFICATE: "/ca.pem", NO_PROXY: "corp", CLAUDE_CODE_DISABLE_ATTACHMENTS: "0" }, { proxy: "http://127.0.0.1:7897", extra: { DY2_MCP_TOKEN: "s" } });
    expect(env).toMatchObject({ PATH: "/bin", ANTHROPIC_BASE_URL: "https://relay", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_CA_CERTIFICATE: "/ca.pem", HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "corp,127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1", DY2_MCP_TOKEN: "s" });
    expect(withoutHostVars({ PATH: "/bin", CODEX_HOME: "/c", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CODEX_THREAD_ID: "t", ELECTRON_RUN_AS_NODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_CA_CERTIFICATE: "/ca" }))
      .toEqual({ PATH: "/bin", CODEX_HOME: "/c", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_CA_CERTIFICATE: "/ca" });
    expect(cliEnv("codex", { https_proxy: "http://p:1" }, { proxy: "http://other:2" })).not.toHaveProperty("HTTPS_PROXY");
    expect(cliEnv("codex", {}, {})).not.toHaveProperty("CLAUDE_CODE_DISABLE_ATTACHMENTS");
  });

  it("switches off the CLIs' own tools and settings and keeps the secret and prompt off the command line", () => {
    const claude = claudeArgs({ systemFile: "/r/system.md", mcpFile: "/r/mcp.json", model: "sonnet" });
    expect(claude.join(" ")).toContain("--tools  --setting-sources  --strict-mcp-config");
    expect(claude).toEqual(expect.arrayContaining(["--no-session-persistence", "--allowedTools", "mcp__dy2", "--model=sonnet", "--system-prompt-file"]));
    expect(claudeArgs({ systemFile: "/r/s", maxTurns: 1 })).not.toContain("--mcp-config");
    const codex = codexArgs({ workDir: "/w", systemFile: "C:\\r\\system.md", mcpUrl: "http://127.0.0.1:5/mcp", model: "gpt-x", effort: "medium", features: new Set(["shell_tool", "unified_exec", "apps"]), authStore: "keyring" });
    const line = codex.join(" ");
    expect(codex.slice(0, 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C"]);
    expect(line).toContain("--disable shell_tool --disable unified_exec --disable apps -c");
    expect(line).not.toContain("--disable plugins");
    expect(codex).toEqual(expect.arrayContaining([
      'features.code_mode.direct_only_tool_namespaces=["mcp__dy2"]', 'mcp_servers.dy2.default_tools_approval_mode="approve"',
      "mcp_servers.dy2.required=true", 'mcp_servers.dy2.bearer_token_env_var="DY2_MCP_TOKEN"', 'model_instructions_file="C:\\\\r\\\\system.md"', "--model=gpt-x",
      "skills.bundled.enabled=false", 'cli_auth_credentials_store="keyring"',
    ]));
    expect(codex.at(-1)).toBe("-");
    expect(line).not.toMatch(/dangerously|bypass/u);
    expect(codexArgs({ workDir: "/w", systemFile: "/s", effort: "low", images: ["/a.jpg"] }).slice(-2)).toEqual(["--image=/a.jpg", "-"]);
  });

  it("reads the default model and where the login is kept from the top of the Codex config only", async () => {
    const home = await temporaryDirectory("codex-home-");
    await mkdir(path.join(home, ".codex"));
    const config = (text) => writeFile(path.join(home, ".codex", "config.toml"), text);
    await config('model = "gpt-6.1-sol" # 默认\napproval_policy = "never"\ncli_auth_credentials_store = "keyring"\n[profiles.x]\nmodel = "other"\n');
    expect(await codexUserConfig({}, home)).toEqual({ model: "gpt-6.1-sol", authStore: "keyring" });
    await config('[profiles.x]\nmodel = "other"\ncli_auth_credentials_store = "keyring"\n');
    expect(await codexUserConfig({}, home)).toEqual({ model: "", authStore: "" });
    // 默认走第三方中转：不加载配置就没了中转，那家的模型名官方后端不认，留空
    await config('model_provider = "relay"\nmodel = "deepseek-v4"\ncli_auth_credentials_store = "weird"\n');
    expect(await codexUserConfig({}, home)).toEqual({ model: "", authStore: "" });
    await config('model_provider = "openai"\nmodel = "gpt-6.1-sol"\n');
    expect((await codexUserConfig({}, home)).model).toBe("gpt-6.1-sol");
    expect(await codexUserConfig({ CODEX_HOME: path.join(home, "none") }, home)).toEqual({ model: "", authStore: "" });
  });

  it("takes only the env and the key helper from the Claude Code settings", async () => {
    const home = await temporaryDirectory("claude-home-");
    await mkdir(path.join(home, ".claude"));
    await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay", N: 1 }, apiKeyHelper: "echo key", hooks: { Stop: [] } }));
    expect(await claudeUserSettings({}, home)).toEqual({ env: { ANTHROPIC_BASE_URL: "https://relay" }, apiKeyHelper: "echo key" });
    expect(await claudeUserSettings({ CLAUDE_CONFIG_DIR: path.join(home, "none") }, home)).toEqual({ env: {}, apiKeyHelper: "" });
    expect(claudeArgs({ systemFile: "/s", settingsFile: "/r/settings.json" })).toEqual(expect.arrayContaining(["--settings", "/r/settings.json"]));
    expect(claudeArgs({ systemFile: "/s" })).not.toContain("--settings");
  });

  it.skipIf(process.platform === "win32")("does not wait for background processes that keep the output open", async () => {
    let started = Date.now();
    const quick = await runFile("/bin/sh", ["-c", "echo ready; sleep 30"], { timeoutMs: 5_000, until: (text) => text.includes("ready") });
    expect(quick).toMatchObject({ code: 0, stdout: "ready\n" });
    expect(Date.now() - started).toBeLessThan(2_000);
    started = Date.now();
    expect((await runFile("/bin/sh", ["-c", "sleep 30 & echo x"], { timeoutMs: 300 })).code).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("accepts a local runtime without a key and refuses odd model names", () => {
    const fail = (message) => new Error(message);
    expect(parseLocalConfig({ runtime: "codex", model: " gpt-6.1-sol ", apiKey: "k", baseUrl: "https://x" }, fail)).toEqual({ runtime: "codex", model: "gpt-6.1-sol", videoInput: false });
    expect(parseLocalConfig({ runtime: "claude" }, fail)).toEqual({ runtime: "claude", model: "", videoInput: false });
    expect(() => parseLocalConfig({ runtime: "claude", model: "sonnet; rm -rf" }, fail)).toThrow(/模型名/u);
  });

  it("says CLI failures in plain words", () => {
    const say = (id, details) => cliFailure(id, { model: "gpt-x", ...details });
    expect(say("claude", { failure: { kind: "api", status: 401, error: "authentication_failed", text: "OAuth access token has expired" } })).toMatchObject({ code: "local_login", message: expect.stringContaining("claude auth login") });
    expect(say("codex", { failure: { kind: "api", text: "unexpected status 401 Unauthorized" } }).message).toContain("codex login");
    expect(say("codex", { failure: { kind: "api", text: "Your refresh token was revoked. Please log out and sign in again." } }).code).toBe("local_login");
    expect(say("codex", { failure: { kind: "api", text: "You've hit your usage limit." } }).code).toBe("local_rate_limit");
    expect(say("codex", { failure: { kind: "api", text: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." } }).message).toContain("「gpt-x」");
    expect(say("claude", { failure: { kind: "api", status: 529, text: "overloaded" } }).code).toBe("local_busy");
    expect(say("codex", { stderr: "thread/start failed: required MCP servers failed to initialize: dy2" }).code).toBe("local_tools_unavailable");
    expect(say("codex", { code: 3, stderr: "panic\nsomething broke" })).toMatchObject({ code: "local_crashed", message: expect.stringContaining("something broke") });
    for (const error of [say("claude", { failure: { kind: "api", status: 401 } }), say("codex", { code: 1 })]) expect(error.message).not.toMatch(/status|api_error|runtime/u);
  });
});

describe("local runtime status", () => {
  it("tells ready, logged out, too old, missing and unsafe versions apart without the email", async () => {
    let { ai } = await fakeAi({});
    expect(await ai.status("codex")).toMatchObject({ state: "ready", version: "0.161.0", message: "已经找到 Codex 0.161.0，也登录好了。" });
    expect(await ai.status("claude")).toMatchObject({ state: "ready", version: "2.1.280" });
    ({ ai } = await fakeAi({ loggedIn: false, authText: "Login: Expired — log in again" }));
    expect(await ai.status("codex")).toMatchObject({ state: "logged_out", message: expect.stringContaining("codex login") });
    expect(await ai.status("claude")).toMatchObject({ state: "expired", message: expect.stringContaining("claude auth login") });
    ({ ai } = await fakeAi({ version: "0.137.0" }));
    expect(await ai.status("codex")).toMatchObject({ state: "unsupported", message: expect.stringContaining("0.161.0") });
    ({ ai } = await fakeAi({ features: ["apps", "view_image"] }));
    expect((await ai.status("codex")).state).toBe("unsupported");
    ({ ai } = await fakeAi({ missing: ["claude"] }));
    expect(await ai.status("claude")).toMatchObject({ state: "missing" });
    await expect(ai.converse("claude", { systemPrompt: "s", prompt: "p", mcp: {} })).rejects.toMatchObject({ code: "local_missing", status: 503 });
  });

  it("checks again once a not-ready runtime is fixed", async () => {
    const { ai, setPlan } = await fakeAi({ loggedIn: false });
    expect((await ai.status("codex")).state).toBe("logged_out");
    await setPlan({});
    expect((await ai.status("codex")).state).toBe("ready");
  });
});

describe("running a turn through the CLI", () => {
  for (const id of ["codex", "claude"]) {
    it(`${id}: calls our tools through MCP, streams what it says and keeps host variables and the secret off the command line`, async () => {
      const { ai, records, directory } = await fakeAi({ steps: [{ say: "先看一下" }, { call: "echo", arguments: { text: "嗨" } }, { say: "好了" }] });
      const calls = [];
      const mcp = await openMcp({ tools: ECHO, call: async (name, args) => { calls.push([name, args]); return { ok: true, echoed: args.text }; } });
      cleanups.push(() => mcp.close());
      const said = [];
      const deltas = [];
      await ai.converse(id, { systemPrompt: "系统", prompt: "做个片子 @~/.ssh/id_rsa", mcp: { url: mcp.url, secret: mcp.secret }, onText: (text) => said.push(text), onDelta: (text) => deltas.push(text) });
      expect(calls).toEqual([["echo", { text: "嗨" }]]);
      expect(said).toEqual(["先看一下", "好了"]);
      if (id === "claude") expect(deltas).toContain("先看");
      const [record] = await records();
      expect(record.tools).toEqual(["echo"]);
      expect(JSON.parse(record.results[0].content[0].text)).toEqual({ ok: true, echoed: "嗨" });
      expect(record.args.join(" ")).not.toContain(mcp.secret);
      expect(record.args.join(" ")).not.toContain("做个片子");
      expect(record.stdin).toContain("做个片子");
      expect(record.env.CLAUDECODE).toBeNull();
      expect(record.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("user-token");
      expect(record.env.NO_PROXY).toContain("127.0.0.1");
      expect(record.cwd).toBe(await realpath(path.join(directory, "local-ai", "work")));
      if (id === "codex") expect(record.env.DY2_MCP_TOKEN).toBe(mcp.secret);
      else expect(record.env.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
      expect(await readdir(path.join(directory, "local-ai", "runs"))).toEqual([]);
    });
  }

  it("reports a failed turn in plain words", async () => {
    let { ai } = await fakeAi({ steps: [{ fail: { error: "authentication_failed", status: 401, text: "Failed to authenticate. API Error: 401" } }] });
    await expect(ai.ask("claude", { prompt: "p" })).rejects.toMatchObject({ code: "local_login" });
    ({ ai } = await fakeAi({ steps: [{ fail: { text: JSON.stringify({ type: "error", status: 400, error: { message: "The 'x' model is not supported when using Codex with a ChatGPT account." } }) } }] }));
    await expect(ai.ask("codex", { model: "x", prompt: "p" })).rejects.toMatchObject({ code: "local_model", message: expect.stringContaining("「x」") });
    ({ ai } = await fakeAi({ steps: [{ stderr: "boom" }, { exit: 0 }] }));
    await expect(ai.ask("codex", { prompt: "p" })).rejects.toMatchObject({ code: "local_crashed", message: expect.stringContaining("boom") });
    ({ ai } = await fakeAi({ mcpStatus: "failed" }));
    const mcp = await openMcp({ tools: ECHO, call: async () => ({ ok: true }) });
    cleanups.push(() => mcp.close());
    await expect(ai.converse("claude", { systemPrompt: "s", prompt: "p", mcp: { url: mcp.url, secret: mcp.secret } })).rejects.toMatchObject({ code: "local_tools_unavailable" });
  });

  it.skipIf(process.platform === "win32")("stops the whole process tree when the turn is stopped, and close() kills what is left", async () => {
    const { ai, records } = await fakeAi({ steps: [{ hang: true }] });
    const controller = new AbortController();
    const running = ai.ask("codex", { prompt: "p", signal: controller.signal });
    let record;
    for (let tries = 0; tries < 200 && !record; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      [record] = await records();
    }
    expect(alive(record.grandchild)).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    for (let tries = 0; tries < 120 && alive(record.grandchild); tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive(record.grandchild)).toBe(false);

    const second = ai.ask("claude", { prompt: "p" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ai.close();
    await expect(second).rejects.toMatchObject({ code: "local_closed" });
  });
});

describe("asking about screenshots", () => {
  const PNG = "iVBORw0KGgo=";
  const parts = [
    { type: "text", text: "镜头表" },
    { type: "text", text: "镜头 1（0–1 秒）" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}`, detail: "low" } },
    { type: "text", text: "镜头 2（1–2 秒）" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } },
  ];

  it("gives Claude the pictures in place over stdin, with no tools", async () => {
    const { ai, records } = await fakeAi({ steps: [{ say: "| 维度 | 发现 |" }] });
    expect(await ai.ask("claude", { parts, prompt: "拆解提示词" })).toBe("| 维度 | 发现 |");
    const [record] = await records();
    const content = JSON.parse(record.stdin).message.content;
    expect(content.map((block) => block.type)).toEqual(["text", "text", "image", "text", "image", "text"]);
    expect(content[2].source).toEqual({ type: "base64", media_type: "image/png", data: PNG });
    expect(content.at(-1).text).toBe("拆解提示词");
    expect(record.args).not.toContain("--mcp-config");
    expect(record.args).toContain("1");
  });

  it("attaches the pictures to Codex as files, marks where each one goes and cleans up", async () => {
    const { ai, records, directory } = await fakeAi({ steps: [{ say: "拆好了" }] });
    expect(await ai.ask("codex", { parts, prompt: "拆解提示词" })).toBe("拆好了");
    const [record] = await records();
    expect(record.images).toEqual([true, true]);
    expect(record.args.filter((arg) => arg.startsWith("--image="))[1]).toMatch(/frame-02\.jpg$/u);
    expect(record.stdin).toBe("镜头表\n镜头 1（0–1 秒）\n（第 1 张附图）\n镜头 2（1–2 秒）\n（第 2 张附图）\n拆解提示词");
    expect(record.args.join(" ")).not.toContain("mcp_servers");
    expect(record.args).toContain('model_reasoning_effort="low"');
    expect(await readdir(path.join(directory, "local-ai", "runs"))).toEqual([]);
  });
});

describe("the MCP desk", () => {
  async function desk(call = async () => ({ ok: true })) {
    const mcp = await openMcp({ tools: ECHO, call });
    cleanups.push(() => mcp.close());
    const post = (body, headers = {}) => fetch(mcp.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcp.secret}`, ...headers }, body: JSON.stringify(body) });
    return { mcp, post };
  }

  it("answers the handshake and lists the tools with room for long results", async () => {
    const { mcp, post } = await desk();
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect((await init.json()).result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
    expect((await (await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })).json()).result.protocolVersion).toBe("2025-06-18");
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await (await post({ jsonrpc: "2.0", id: 3, method: "server/discover" })).json()).error.code).toBe(-32601);
    expect(mcp.listed()).toBe(false);
    const { tools } = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/list" })).json()).result;
    expect(tools).toEqual([{ name: "echo", description: "回声", inputSchema: ECHO[0].function.parameters, _meta: { "anthropic/maxResultSizeChars": 400_000 } }]);
    expect(mcp.listed()).toBe(true);
    expect((await fetch(mcp.url, { headers: { Authorization: `Bearer ${mcp.secret}` } })).status).toBe(405);
  });

  it("turns away strangers and browsers without ever answering 401", async () => {
    const { mcp, post } = await desk();
    const statuses = [
      (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer wrong" })).status,
      (await fetch(mcp.url, { method: "POST", body: "{}" })).status,
      (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Origin: "http://evil.example" })).status,
      (await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 400]);
    mcp.close();
    await expect(post({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow();
  });

  it("runs calls one at a time, marks failures and answers stopped once the turn is over", async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { mcp, post } = await desk(async (name, args) => {
      order.push(`start ${args.n}`);
      if (args.n === 1) await gate;
      order.push(`end ${args.n}`);
      if (args.n === 3) throw Object.assign(new Error("stopped"), { name: "AbortError" });
      return args.n === 2 ? { ok: false, code: "bad", message: "不行" } : { ok: true };
    });
    const call = (n) => post({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "echo", arguments: { n } } }).then((response) => response.json());
    const replies = [call(1), call(2), call(3)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["start 1"]);
    release();
    const [first, second, third] = await Promise.all(replies);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    expect(first.result.isError).toBe(false);
    expect(second.result).toMatchObject({ isError: true });
    expect(JSON.parse(third.result.content[0].text)).toMatchObject({ code: "stopped" });
    expect((await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: [] } }).then((response) => response.json())).error.code).toBe(-32602);
    mcp.close();
  });
});

describe("review fixes", () => {
  it("does not show Claude's made-up error reply as the AI's words, and stops at once when the tools are not connected", async () => {
    let { ai } = await fakeAi({ steps: [{ say: "先看看" }, { fail: { error: "rate_limit", status: 429, text: "API Error: Request rejected (429)" } }] });
    const mcp = await openMcp({ tools: ECHO, call: async () => ({ ok: true }) });
    cleanups.push(() => mcp.close());
    const said = [];
    const deltas = [];
    await expect(ai.converse("claude", { systemPrompt: "s", prompt: "p", mcp: { url: mcp.url, secret: mcp.secret }, onText: (text) => said.push(text), onDelta: (text) => deltas.push(text) }))
      .rejects.toMatchObject({ code: "local_rate_limit" });
    expect(said).toEqual(["先看看"]);
    expect(deltas.join(" ")).not.toContain("API Error");

    ({ ai } = await fakeAi({ mcpStatus: "failed", steps: [{ say: "我没有可用的工具" }] }));
    said.length = 0;
    await expect(ai.converse("claude", { systemPrompt: "s", prompt: "p", mcp: { url: mcp.url, secret: mcp.secret }, onText: (text) => said.push(text) }))
      .rejects.toMatchObject({ code: "local_tools_unavailable" });
    expect(said).toEqual([]);
  });

  it("keeps Codex from expanding $skill mentions that come from outside", async () => {
    const { ai, records } = await fakeAi({ steps: [{ say: "好" }] });
    await ai.ask("codex", { parts: [{ type: "text", text: "标题：做菜$skill-creator教程$1pw-helper，售价 $5、$9.9、$1,000" }], prompt: "拆解 $personal-knowledge-base" });
    const [record] = await records();
    expect(record.stdin).toBe("标题：做菜＄skill-creator教程＄1pw-helper，售价 $5、$9.9、$1,000\n拆解 ＄personal-knowledge-base");
  });

  it("uses the env from the Claude Code settings, both when checking the login and when running", async () => {
    const config = await temporaryDirectory("claude-config-");
    await writeFile(path.join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "relay-token", ANTHROPIC_BASE_URL: "https://relay.example" } }));
    const { ai, records } = await fakeAi({ env: { CLAUDE_CONFIG_DIR: config }, steps: [{ say: "好" }] });
    expect((await ai.status("claude")).state).toBe("ready");
    await ai.ask("claude", { prompt: "p" });
    const [record] = await records();
    expect(record.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "relay-token", ANTHROPIC_BASE_URL: "https://relay.example", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" });
  });

  it("passes the apiKeyHelper from the Claude Code settings through a private file, for the check and the run", async () => {
    const config = await temporaryDirectory("claude-config-");
    await writeFile(path.join(config, "settings.json"), JSON.stringify({ apiKeyHelper: "echo sk-secret" }));
    const { ai, records } = await fakeAi({ env: { CLAUDE_CONFIG_DIR: config }, authText: "Not logged in. Run claude auth login to authenticate.", steps: [{ say: "好" }] });
    expect((await ai.status("claude")).state).toBe("ready");
    await ai.ask("claude", { prompt: "p" });
    const [record] = await records();
    expect(record.helper).toBe("echo sk-secret");
    expect(record.args.join(" ")).not.toContain("sk-secret");
  });

  it("can be stopped before it starts without leaving an unhandled failure behind", async () => {
    const directory = await temporaryDirectory("local-ai-");
    const ai = createLocalAi({ dataDirectory: directory, resolve: async () => null, shellEnv: async () => ({ PATH: "/bin" }), proxy: async () => null });
    cleanups.push(() => ai.close());
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(ai.ask("codex", { prompt: "p", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("can be stopped while the login shell is still being read", async () => {
    const directory = await temporaryDirectory("local-ai-");
    const ai = createLocalAi({ dataDirectory: directory, resolve: async () => ({ command: process.execPath, prefix: [FAKE, "codex"], env: {} }), shellEnv: () => new Promise(() => {}), proxy: async () => null });
    cleanups.push(() => ai.close());
    const controller = new AbortController();
    const asking = ai.ask("codex", { prompt: "p", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(asking).rejects.toMatchObject({ name: "AbortError" });
  });
});
