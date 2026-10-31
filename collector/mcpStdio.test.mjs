import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { bearerMatches, mcpHandler } from "./assistant/mcp.mjs";

const bridge = fileURLToPath(new URL("./mcpStdio.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** 起转发程序，按行喂请求，等到收齐 expected 条回复。 */
function run(env, lines, expected) {
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, ...env } });
  cleanups.push(() => child.kill());
  const replies = [];
  let buffer = "";
  return new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      replies.push(...parts.map((part) => JSON.parse(part)));
      if (replies.length >= expected) resolve(replies.sort((a, b) => a.id - b.id));
    });
    child.stdin.write(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
  });
}

it("把 stdio 请求转给 /mcp，通知不回，令牌不对、应用没开时报清楚", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dy2-mcp-stdio-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "mcp-token");
  await writeFile(tokenFile, "secret\n");
  const server = http.createServer(mcpHandler({
    tools: [{ function: { name: "echo", description: "原样返回", parameters: { type: "object" } } }],
    call: async (name, args) => ({ ok: true, name, args }),
    authorized: (header) => bearerMatches(header, "secret"),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { DY2_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, DY2_MCP_TOKEN_FILE: tokenFile };

  const replies = await run(env, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } },
    "not json",
  ], 3);
  expect(replies[0]).toMatchObject({ id: null, error: { code: -32700 } });
  expect(replies[1].result.serverInfo.name).toBe("dy2");
  expect(JSON.parse(replies[2].result.content[0].text)).toEqual({ ok: true, name: "echo", args: { a: 1 } });

  await writeFile(tokenFile, "changed\n");
  const [wrongToken] = await run(env, [{ jsonrpc: "2.0", id: 3, method: "ping" }], 1);
  expect(wrongToken.error.message).toContain("令牌对不上");

  await new Promise((resolve) => server.close(resolve));
  const [down] = await run(env, [{ jsonrpc: "2.0", id: 4, method: "ping" }], 1);
  expect(down.error.message).toContain("先把应用打开");
});
