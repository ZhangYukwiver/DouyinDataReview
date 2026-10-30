import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

// AI 助手的 MCP 端点，两处用：本机 CLI（Codex、Claude Code）每轮在 127.0.0.1 的随机端口上开一个、这一轮结束就关；
// 采集器自己的 /mcp 给用户自己的 AI 客户端长期接入（设置里打开）。
// 只做 streamable HTTP 的最小子集：initialize、tools/list、tools/call、ping，POST 直接回 JSON，不开 SSE。
// 鉴权靠 Bearer 密钥；失败回 403 不回 401（Claude Code 碰到 401 会去走 OAuth 注册，最后把服务标成失败）。

const MAX_BODY_BYTES = 1 << 20;
const PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
// Claude Code 默认把超过 5 万字的工具结果存成文件、只给模型看开头 2KB（工具都关了，模型读不到全文）
const RESULT_CHARS = 400_000;
const STOPPED = { ok: false, code: "stopped", message: "这一轮已经停了，这个工具没有执行。" };

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** 比对 Authorization 头和期望的密钥（定长比较）。 */
export function bearerMatches(header, secret) {
  const given = Buffer.from(String(header ?? ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 处理一个 MCP 请求：tools 是 OpenAI 形状的工具定义（或返回它的函数），call(name, args) 执行一个工具并返回给模型的结果对象。
 * authorized(header) 认密钥，closed() 为真时一律拒。调用一个一个排着执行（Codex 会几毫秒内连发好几个，同时操作会打架）。
 */
export function mcpHandler({ tools, call, authorized, closed = () => false, onListed = () => undefined }) {
  let queue = Promise.resolve();
  const listing = () => (typeof tools === "function" ? tools() : tools).map(({ function: tool }) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    _meta: { "anthropic/maxResultSizeChars": RESULT_CHARS },
  }));

  const runTool = (name, args) => {
    const task = queue.then(async () => {
      if (closed()) return STOPPED;
      try {
        return await call(name, args);
      } catch (error) {
        if (error?.name === "AbortError" || closed()) return STOPPED;
        console.error("AI 助手 MCP 工具出错:", error);
        return { ok: false, code: "tool_failed", message: "这个工具没执行成功。" };
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };

  const answer = async (message) => {
    const { id, method, params } = message;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return rpc(id, { protocolVersion: PROTOCOLS.has(asked) ? asked : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "dy2", version: "1" } });
    }
    if (method === "ping") return rpc(id, {});
    if (method === "tools/list") {
      onListed();
      return rpc(id, { tools: listing() });
    }
    if (method === "tools/call") {
      if (typeof params?.name !== "string") return rpcError(id, -32602, "缺少工具名");
      const args = params.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcError(id, -32602, "参数要是对象");
      const result = await runTool(params.name, args);
      let text = JSON.stringify(result) ?? "{}";
      if (text.length > RESULT_CHARS) text = `${text.slice(0, RESULT_CHARS)}…（结果太长，后面略了）`;
      return rpc(id, { content: [{ type: "text", text }], isError: result?.ok === false });
    }
    return rpcError(id, -32601, "不支持这个方法");
  };

  return (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    // 浏览器发来的一律不认（CLI 和 AI 客户端不带 Origin），挡住网页借本机端口调工具
    if (request.headers.origin) { send(403, { error: "forbidden" }); request.resume(); return; }
    if (closed() || !authorized(request.headers.authorization)) { send(403, { error: "forbidden" }); request.resume(); return; }
    if (new URL(request.url, "http://127.0.0.1").pathname !== "/mcp") { send(404, { error: "not_found" }); request.resume(); return; }
    if (request.method === "GET") { send(405, undefined, { Allow: "POST, DELETE" }); request.resume(); return; }
    // Codex 正常退出时发 DELETE 结束会话，这一轮是否结束由我们自己定
    if (request.method === "DELETE") { send(200, {}); request.resume(); return; }
    if (request.method !== "POST") { send(405, undefined, { Allow: "POST, DELETE" }); request.resume(); return; }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { send(413, { error: "too_large" }); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { send(400, rpcError(null, -32700, "不是 JSON")); return; }
      if (Array.isArray(message) || !message || typeof message !== "object") { send(400, rpcError(null, -32600, "不支持批量请求")); return; }
      // 通知（没有 id）不用回内容
      if (message.id === undefined || message.id === null) { send(202); return; }
      answer(message).then(
        (body) => { if (!response.destroyed) send(200, body, { "Mcp-Session-Id": "dy2" }); },
        (error) => { console.error("AI 助手 MCP 出错:", error); if (!response.destroyed) send(500, rpcError(message.id, -32603, "内部错误")); },
      );
    });
  };
}

/** 本机 CLI 的一轮：开在随机端口上，返回 { url, secret, listed(), close() }。 */
export async function openMcp({ tools, call }) {
  const secret = randomBytes(32).toString("base64url");
  let closed = false;
  let listed = false;
  let queue = Promise.resolve();
  const handle = mcpHandler({
    tools,
    call: (name, args) => (queue = Promise.resolve(call(name, args))),
    authorized: (header) => bearerMatches(header, secret),
    closed: () => closed,
    onListed: () => { listed = true; },
  });
  const server = http.createServer(handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    secret,
    listed: () => listed,
    /** 关掉这一轮：排着的调用不再执行，返回的 promise 等正在执行的那个做完（它的结果要先记进历史）。 */
    close() {
      closed = true;
      server.close();
      server.closeAllConnections();
      return queue.catch(() => undefined);
    },
  };
}
