// 假的 Codex / Claude Code（测试用，不进安装包）：node fake-cli.mjs <codex|claude> <真 CLI 的参数…>
// 按环境变量 FAKE_PLAN 指向的 JSON 剧本吐真 CLI 的事件、真的去连 MCP 端点调工具；每次运行往 FAKE_RECORD 追加一行记录。
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [role, ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(process.env.FAKE_PLAN, "utf8"));
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const value = (flag) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? args[args.indexOf(flag) + 1];

if (args.includes("--version")) {
  console.log(role === "codex" ? `codex-cli ${plan.version ?? "0.161.0"}` : `${plan.version ?? "2.1.280"} (Claude Code)`);
  process.exit(0);
}
if (role === "codex" && args[0] === "login") {
  console.log(plan.loggedIn === false ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(plan.loggedIn === false ? 1 : 0);
}
if (role === "codex" && args[0] === "features") {
  console.log((plan.features ?? ["shell_tool", "unified_exec", "apps", "view_image"]).map((name) => `${name.padEnd(40)} stable             true`).join("\n"));
  process.exit(0);
}
// --settings 交来的设置文件里有 apiKeyHelper 就算登录了（真 CLI 也是这样）
const helper = args.includes("--settings") && existsSync(value("--settings")) ? JSON.parse(readFileSync(value("--settings"), "utf8")).apiKeyHelper : null;
if (role === "claude" && args.includes("auth")) {
  const text = helper ? "Auth token: apiKeyHelper" : plan.authText ?? "Login method: Claude Max account";
  console.log(text);
  process.exit(/not logged in/iu.test(text) ? 1 : 0);
}

const stdin = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => resolve(text));
});

let mcp = null;
if (role === "codex") {
  const url = args.map((arg) => arg.match(/^mcp_servers\.dy2\.url=(.+)$/u)?.[1]).find(Boolean);
  if (url) mcp = { url: JSON.parse(url), auth: `Bearer ${process.env.DY2_MCP_TOKEN}` };
} else if (args.includes("--mcp-config")) {
  const server = JSON.parse(readFileSync(value("--mcp-config"), "utf8")).mcpServers.dy2;
  mcp = { url: server.url, auth: server.headers.Authorization };
}

const record = {
  role, args, stdin, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(),
  env: Object.fromEntries(["NO_PROXY", "HTTPS_PROXY", "CLAUDE_CODE_DISABLE_ATTACHMENTS", "DY2_MCP_TOKEN", "CLAUDECODE", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].map((key) => [key, process.env[key] ?? null])),
  images: args.filter((arg) => arg.startsWith("--image=")).map((arg) => existsSync(arg.slice(8))),
  helper,
  system: (() => {
    const file = role === "codex" ? JSON.parse(args.map((arg) => arg.match(/^model_instructions_file=(.+)$/u)?.[1]).find(Boolean) ?? "null") : value("--system-prompt-file");
    return file && existsSync(file) ? readFileSync(file, "utf8") : null;
  })(),
  results: [],
};
let saved = false;
const save = () => {
  if (saved) return;
  saved = true;
  appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify(record)}\n`);
};

let rpcId = 0;
const rpc = async (method, params) => {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: mcp.auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  return response.json();
};

let finished = false;
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  if (role === "claude") print({ type: "result", subtype: "success", is_error: false, result: "", session_id: "s" });
  else print({ type: "turn.completed", usage: {} });
  save();
  process.exit(code);
};
process.on("SIGINT", () => {
  save();
  // 真 Claude 收到 SIGINT 会吐一条 error_during_execution 的 result 再退；Codex 不吐结束事件
  if (role === "claude") print({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
  process.exit(role === "claude" ? 0 : 1);
});

if (role === "claude") print({ type: "system", subtype: "init", mcp_servers: mcp ? [{ name: "dy2", status: plan.mcpStatus ?? "connected" }] : [] });
else print({ type: "thread.started", thread_id: "t" });
if (mcp && !plan.skipTools) {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: role } });
  record.tools = (await rpc("tools/list", {})).result?.tools?.map((tool) => tool.name);
}

for (const step of plan.steps ?? []) {
  if (step.say) {
    if (role === "claude") {
      for (const piece of [step.say.slice(0, 2), step.say.slice(2)]) print({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
      print({ type: "assistant", message: { id: "m", content: [{ type: "text", text: step.say }] } });
    } else {
      print({ type: "item.completed", item: { id: "i", type: "agent_message", text: step.say } });
    }
  } else if (step.call) {
    const reply = await rpc("tools/call", { name: step.call, arguments: step.arguments ?? {} });
    record.results.push(reply.result ?? reply.error);
  } else if (step.calls) {
    // 几毫秒内连发好几个（Codex 的 code mode 就这样）
    const replies = await Promise.all(step.calls.map((name) => rpc("tools/call", { name, arguments: {} })));
    record.results.push(...replies.map((reply) => reply.result ?? reply.error));
  } else if (step.fail) {
    if (role === "claude") {
      print({ type: "assistant", error: step.fail.error, message: { id: "e", model: "<synthetic>", content: [{ type: "text", text: step.fail.text }] } });
      print({ type: "result", subtype: "success", is_error: true, api_error_status: step.fail.status ?? null, result: step.fail.text });
    } else {
      print({ type: "turn.failed", error: { message: step.fail.text } });
    }
    save();
    process.exit(1);
  } else if (step.stderr) {
    process.stderr.write(`${step.stderr}\n`);
  } else if (step.exit !== undefined) {
    save();
    process.exit(step.exit);
  } else if (step.hang) {
    // 带一个孙进程，测停止时是不是整棵进程树都杀掉了
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    record.grandchild = grandchild.pid;
    save();
    await new Promise(() => {});
  }
}
finish();
