import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, expect, it } from "vitest";
import { createLocalAi, withoutHostVars } from "./localAi.mjs";
import { openMcp } from "./assistant/mcp.mjs";
import { connectWorkbuddy, probeWorkbuddy } from "./workbuddyIpc.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function proof(ticket, side, endpoint, clientNonce, serverNonce) {
  const chunks = [side === "server" ? "wbipc-s" : "wbipc-c", "1", endpoint, clientNonce, serverNonce].flatMap(value => {
    const bytes = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes];
  });
  return createHmac("sha256", ticket).update(Buffer.concat(chunks)).digest("base64url");
}
const sse = (delta, finish = "stop") => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;

async function desktop({ mode = "ready", respond } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dy-workbuddy-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\wbipc-dy-test-${randomUUID()}` : path.join(directory, "desktop.sock");
  const ticket = randomBytes(32).toString("base64url");
  const requests = [], frames = [], sockets = new Set();
  let cancelResolve;
  const cancelled = new Promise(resolve => { cancelResolve = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    let clientNonce, serverNonce, phase = "hello", modelPending = false;
    socket.on("close", () => { sockets.delete(socket); if (modelPending) cancelResolve(); });
    const send = message => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
    readline.createInterface({ input: socket }).on("line", line => {
      const message = JSON.parse(line); frames.push(message);
      if (phase === "hello") {
        expect(message.type).toBe("session_hello");
        expect(message.ticket_id).toBe(createHash("sha256").update(ticket).digest("hex").slice(0, 16));
        clientNonce = message.client_nonce; serverNonce = randomBytes(16).toString("base64url"); phase = "proof";
        if (mode === "no_proof") send({ type: "session_hello_ack", pipes: ["wb.request"] });
        else send({ type: "session_challenge", protocol: 1, server_nonce: serverNonce,
          server_proof: mode === "bad_proof" ? "invalid" : proof(ticket, "server", endpoint, clientNonce, serverNonce) });
      } else if (phase === "proof") {
        expect(message.type).toBe("session_prove");
        expect(message.client_proof).toBe(proof(ticket, "client", endpoint, clientNonce, serverNonce));
        phase = "ready"; send({ type: "session_hello_ack", pipes: mode === "logged_out" ? [] : ["wb.request"] });
      } else if (message.method === "broker/GetPipe") send({ jsonrpc: "2.0", id: message.id, result: { channel: "c:wb.request", methods: ["http.fetch"] } });
      else if (message.method === "$/cancel") { modelPending = false; cancelResolve(); }
      else {
        expect(message.method).toBe("c:wb.request/http.fetch"); expect(message.mode).toBe("call");
        const params = message.params;
        expect(params.path).toBe("/v2/chat/completions");
        expect(params.headers).toEqual({ "content-type": "application/json", accept: "text/event-stream" });
        const body = JSON.parse(Buffer.from(params.body_b64, "base64").toString()); requests.push(body); modelPending = true;
        Promise.resolve(respond?.(body, requests.length)).then(reply => {
          if (!reply) return;
          modelPending = false;
          send({ jsonrpc: "2.0", id: message.id, result: { status: reply.status ?? 200,
            headers: { "content-type": reply.type ?? "text/event-stream" }, body_b64: Buffer.from(reply.body).toString("base64") } });
        }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await mkdir(path.join(directory, "wbipc"));
  await writeFile(path.join(directory, "wbipc", "endpoint.json"), JSON.stringify({ endpoint, ticket }), { mode: 0o600 });
  const version = path.join(directory, "version.cjs");
  await writeFile(version, "console.log('2.161.0');\n");
  const ai = createLocalAi({ dataDirectory: directory, proxy: async () => null, shellEnv: async () => withoutHostVars(process.env),
    resolve: async () => ({ command: process.execPath, prefix: [version], path: version, env: {}, workbuddy: { configDir: directory } }) });
  cleanups.push(() => ai.close());
  return { directory, ai, requests, frames, cancelled, ticket };
}

it("checks the running desktop without spending model requests and reports a signed-out desktop", async () => {
  let host = await desktop();
  expect(await host.ai.status("workbuddy")).toMatchObject({ state: "ready", message: expect.stringContaining("连上 WorkBuddy 桌面端") });
  expect(host.requests).toEqual([]);
  host = await desktop({ mode: "logged_out" });
  expect(await host.ai.status("workbuddy")).toMatchObject({ state: "logged_out" });
  expect(host.requests).toEqual([]);
});

it("uses the desktop session for the complete MCP tool loop without forwarding any API key or ticket", async () => {
  const host = await desktop({ respond: (_, call) => ({ body: call === 1
    ? sse({ tool_calls: [{ index: 0, id: "echo-1", type: "function", function: { name: "mcp__dy2__echo", arguments: JSON.stringify({ text: "连接成功" }) } }] }, "tool_calls")
    : sse({ content: "连接成功。" }) }) });
  const calls = [];
  const mcp = await openMcp({ tools: [{ type: "function", function: { name: "echo", description: "回声", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
    call: async (name, args) => { calls.push([name, args]); return { ok: true, text: args.text }; } });
  cleanups.push(() => mcp.close());
  const said = [];
  await host.ai.converse("workbuddy", { systemPrompt: "只能用应用的工具。", prompt: "请验证连接。", mcp: { url: mcp.url, secret: mcp.secret }, onText: text => said.push(text) });
  expect(said).toEqual(["连接成功。"]);
  expect(calls).toEqual([["echo", { text: "连接成功" }]]);
  expect(host.requests).toHaveLength(2);
  expect(host.requests[0].model).toBe("auto");
  expect(host.requests[0].tools.map(tool => tool.function.name)).toEqual(["mcp__dy2__echo"]);
  expect(host.requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "echo-1" });
  expect(JSON.stringify(host.requests)).not.toContain(host.ticket);
  expect(JSON.stringify(host.requests)).not.toContain(mcp.secret);
});

it("stops an in-flight desktop request when the user cancels", async () => {
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const host = await desktop({ respond: () => { requested(); return undefined; } });
  const controller = new AbortController();
  const running = host.ai.converse("workbuddy", { systemPrompt: "s", prompt: "p", signal: controller.signal });
  const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
  await started; controller.abort();
  await rejected;
  await host.cancelled;
});

it.each(["bad_proof", "no_proof"])("rejects %s before sending user data or a client proof", async mode => {
  const host = await desktop({ mode });
  await expect(probeWorkbuddy({ configDir: host.directory })).rejects.toMatchObject({ code: "local_connection" });
  expect(host.frames.map(frame => frame.type)).toEqual(["session_hello"]);
  expect(host.requests).toEqual([]);
});

it("reports a closed desktop and refuses requests to any other URL", async () => {
  const host = await desktop();
  const client = await connectWorkbuddy({ configDir: host.directory });
  cleanups.push(() => client.close());
  await expect(client.fetchImpl("https://elsewhere.example/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "local_failed" });
  expect(host.requests).toEqual([]);
  await expect(probeWorkbuddy({ configDir: path.join(host.directory, "missing") })).rejects.toMatchObject({ code: "local_not_running" });
});

it("translates native quota failures into the existing local AI error", async () => {
  const host = await desktop({ respond: () => ({ status: 429, type: "application/json", body: JSON.stringify({ msg: "quota exceeded", displayMsg: { zh: "额度已用完" } }) }) });
  await expect(host.ai.converse("workbuddy", { systemPrompt: "s", prompt: "p" })).rejects.toMatchObject({ code: "local_rate_limit" });
});
