import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

// WorkBuddy 桌面端的 wb.request 通道负责账号认证；这里只传模型请求，不读取它的登录令牌。
export class WorkbuddyError extends Error {
  constructor(code, message, status = 503) { super(message); this.name = "WorkbuddyError"; this.code = code; this.status = status; }
}
const offline = () => new WorkbuddyError("local_not_running", "请先打开 WorkBuddy 桌面版并登录，再点「重新检测」。");
const disconnected = () => new WorkbuddyError("local_connection", "与 WorkBuddy 的连接已断开。请确认 WorkBuddy 正在运行，再试一次。");

function sessionProof(ticket, role, endpoint, clientNonce, serverNonce) {
  const parts = [];
  for (const value of [role === "server" ? "wbipc-s" : "wbipc-c", "1", endpoint, clientNonce, serverNonce]) {
    const data = Buffer.from(value, "utf8");
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    parts.push(size, data);
  }
  return createHmac("sha256", Buffer.from(ticket, "utf8")).update(Buffer.concat(parts)).digest("base64url");
}

export async function connectWorkbuddy({ configDir, signal, timeoutMs = 8_000 }) {
  signal?.throwIfAborted();
  const file = path.join(configDir, "wbipc", "endpoint.json");
  let discovery;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096 || process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) throw offline();
    discovery = JSON.parse(await readFile(file, "utf8"));
  } catch { throw offline(); }
  const { endpoint, ticket } = discovery ?? {};
  if (typeof endpoint !== "string" || typeof ticket !== "string" || ticket.length < 32 || ticket.length > 256 ||
      (process.platform === "win32" ? !endpoint.startsWith("\\\\.\\pipe\\wbipc-") : !path.isAbsolute(endpoint))) throw offline();
  if (process.platform !== "win32") {
    try { const info = await lstat(endpoint); if (!info.isSocket() || info.uid !== process.getuid()) throw offline(); }
    catch { throw offline(); }
  }
  signal?.throwIfAborted();
  const socket = net.createConnection({ path: endpoint });
  const clientNonce = randomBytes(16).toString("base64url");
  const pending = new Map();
  let sequence = 0;
  let ready = false;
  let proofSent = false;
  let closed = false;
  let buffer = "";
  let handshakeResolve, handshakeReject;
  const handshake = new Promise((resolve, reject) => { handshakeResolve = resolve; handshakeReject = reject; });
  // 文件里的票据只用于本机握手；日志、命令行和模型请求都不带它。
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  const close = (error = disconnected()) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    socket.destroy();
    handshakeReject(error);
    for (const request of [...pending.values()]) request.finish(error);
  };
  const stop = () => close(signal.reason);
  const timer = setTimeout(() => close(offline()), timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  const request = (method, params, requestSignal, mode) => new Promise((resolve, reject) => {
    if (closed) { reject(disconnected()); return; }
    if (requestSignal?.aborted) { reject(requestSignal.reason); return; }
    const id = ++sequence;
    const finish = (error, result) => {
      if (!pending.delete(id)) return;
      requestSignal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => {
      if (!closed) send({ jsonrpc: "2.0", method: "$/cancel", params: { id } });
      finish(requestSignal.reason);
    };
    pending.set(id, { finish });
    requestSignal?.addEventListener("abort", abort, { once: true });
    send({ jsonrpc: "2.0", id, method, params, ...(mode ? { mode } : {}) });
  });
  socket.setEncoding("utf8");
  socket.on("connect", () => send({ type: "session_hello", protocol_min: 1, protocol_max: 1,
    ticket_id: createHash("sha256").update(ticket).digest("hex").slice(0, 16), client_nonce: clientNonce,
    client: { kind: "external", id: "dy2" } }));
  socket.on("data", (chunk) => {
    if (closed) return;
    buffer += chunk;
    if (buffer.length > 2_000_000) { close(disconnected()); return; }
    for (let newline; !closed && (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { close(disconnected()); return; }
      if (!ready && !proofSent && message.type === "session_challenge") {
        if (message.protocol !== 1 || typeof message.server_nonce !== "string" || message.server_nonce.length > 128 || typeof message.server_proof !== "string") { close(disconnected()); return; }
        const expected = Buffer.from(sessionProof(ticket, "server", endpoint, clientNonce, message.server_nonce));
        const actual = Buffer.from(message.server_proof);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) { close(disconnected()); return; }
        proofSent = true;
        send({ type: "session_prove", client_proof: sessionProof(ticket, "client", endpoint, clientNonce, message.server_nonce) });
      } else if (!ready && message.type === "session_hello_ack") {
        if (!proofSent) { close(disconnected()); return; }
        ready = true;
        if (!Array.isArray(message.pipes) || !message.pipes.includes("wb.request")) {
          close(new WorkbuddyError("local_login", "WorkBuddy 当前没有可用的登录会话。请在 WorkBuddy 中确认账号后重试。")); return;
        }
        handshakeResolve();
      } else if (message.type === "session_hello_error") { close(disconnected()); return; }
      else if (message.id !== undefined) {
        const error = message.error ? new WorkbuddyError("local_connection", `WorkBuddy 请求失败：${String(message.error.message || "连接暂时不可用").slice(0, 200)}`) : null;
        pending.get(message.id)?.finish(error, message.result);
      }
    }
  });
  socket.on("error", () => close(ready ? disconnected() : offline()));
  socket.on("close", () => close(ready ? disconnected() : offline()));
  try {
    await handshake;
    const pipe = await request("broker/GetPipe", { pipe: "wb.request" }, signal);
    if (typeof pipe?.channel !== "string" || !pipe.methods?.includes("http.fetch"))
      throw new WorkbuddyError("local_unsupported", "当前 WorkBuddy 不支持本机模型调用，请更新 WorkBuddy 后重试。");
    clearTimeout(timer);
    return {
      close,
      async fetchImpl(url, init) {
        // 这个通道只服务应用的模型请求，不转发任意网址或调用方的 Authorization。
        if (url !== "http://workbuddy.local/v2/chat/completions" || init?.method !== "POST" || typeof init.body !== "string")
          throw new WorkbuddyError("local_failed", "WorkBuddy 模型请求格式不正确。", 400);
        const reply = await request(`${pipe.channel}/http.fetch`, {
          method: "POST", path: "/v2/chat/completions", headers: { "content-type": "application/json", accept: "text/event-stream" },
          body_b64: Buffer.from(init.body, "utf8").toString("base64"),
        }, init.signal, "call");
        if (!Number.isInteger(reply?.status) || reply.status < 200 || reply.status > 599 || typeof reply.body_b64 !== "string" || reply.body_b64.length > 900_000)
          throw disconnected();
        const body = Buffer.from(reply.body_b64, "base64");
        if (reply.status >= 400) {
          let detail;
          try { detail = JSON.parse(body.toString("utf8")); } catch { /* 下方用通用提示。 */ }
          return Response.json({ error: { message: detail?.displayMsg?.zh || detail?.msg || detail?.error?.message || "WorkBuddy 模型请求失败。" } }, { status: reply.status });
        }
        return new Response(body.length ? body : null, { status: reply.status, headers: reply.headers });
      },
    };
  } catch (error) { close(error); throw error; }
}

export async function probeWorkbuddy(options) {
  const client = await connectWorkbuddy(options);
  client.close();
}

export async function converseWorkbuddy({ configDir, model, systemPrompt, prompt, mcp, signal, onText = () => {}, onDelta = () => {} }) {
  const client = await connectWorkbuddy({ configDir, signal });
  try {
    // 和接口模式共用工具循环；WorkBuddy 只收到应用明确提供的工具，没有桌面端的文件/命令权限。
    const { runConversation } = await import("./assistant/chat.mjs");
    let rpcId = 0;
    const rpc = async (method, params) => {
      const response = await fetch(mcp.url, { method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcp.secret}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      const reply = await response.json();
      if (!response.ok || reply.error) throw new WorkbuddyError("local_tools_unavailable", "WorkBuddy 没连上应用工具，请重试。", 502);
      return reply.result;
    };
    let tools = [];
    const allowed = new Map();
    if (mcp) {
      await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dy2-workbuddy" } });
      const listed = await rpc("tools/list", {});
      if (!Array.isArray(listed?.tools)) throw new WorkbuddyError("local_tools_unavailable", "应用工具列表暂时不可用，请重试。", 502);
      tools = listed.tools.map((tool) => {
        const name = `mcp__dy2__${tool.name}`;
        allowed.set(name, tool.name);
        return { type: "function", function: { name, description: tool.description, parameters: tool.inputSchema } };
      });
    }
    const result = await runConversation({
      config: { baseUrl: "http://workbuddy.local/v2", apiKey: "", model: model || "auto" },
      history: [{ role: "user", content: prompt }], tools, system: async () => systemPrompt, signal,
      fetchImpl: client.fetchImpl, onText: onDelta,
      execute: async (call) => {
        const name = allowed.get(call.name);
        if (!name) return { ok: false, code: "unknown_tool", message: "只能使用应用提供的工具。" };
        let args;
        try { args = JSON.parse(call.arguments); } catch { return { ok: false, code: "invalid_arguments", message: "工具参数不是有效的 JSON，请重新填写。" }; }
        const reply = await rpc("tools/call", { name, arguments: args });
        const text = (reply?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
        try { return JSON.parse(text); } catch { return { ok: !reply?.isError, text }; }
      },
    });
    if (result.text) onText(result.text);
    return { done: true, failure: null };
  } finally { client.close(); }
}
