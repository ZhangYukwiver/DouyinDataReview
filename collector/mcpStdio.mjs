#!/usr/bin/env node
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// 把应用的 /mcp（HTTP）转成 stdio：Codex、Cursor、Claude 等任何 MCP 客户端都用同一行命令接入，不用手抄令牌。
// 命令由设置 → AI 按本机实际路径生成；令牌每次请求现读（删掉 mcp-token 重启应用会换新的）。
// DY2_MCP_URL / DY2_MCP_TOKEN_FILE 只在从源码运行时用得上（4765 端口、.local-data）。
// 用 node:http 不用 fetch：fetch 默认 5 分钟等不到响应头就断，下载工具最多要等 5 分钟。

const endpoint = process.env.DY2_MCP_URL || "http://127.0.0.1:47652/mcp";

function appDataDirectory() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

const tokenFile = process.env.DY2_MCP_TOKEN_FILE || path.join(appDataDirectory(), "内容数据工作台", "collector", "mcp-token");
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function post(body) {
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

function explain(error) {
  if (error?.code === "ENOENT") return `找不到 MCP 令牌 ${tokenFile}，先打开一次内容数据工作台。`;
  if (error?.code === "ECONNREFUSED") return `连不上内容数据工作台（${endpoint}），先把应用打开。`;
  return error?.message || String(error);
}

async function forward(line) {
  let message;
  try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是 JSON" } }); return; }
  const id = message?.id ?? null;
  try {
    const { status, text } = await post(line);
    if (id === null) return; // 通知不用回
    let body = null;
    try { body = JSON.parse(text); } catch { /* 下面按状态码报 */ }
    if (body?.jsonrpc) { write(body); return; }
    throw new Error(status === 403 ? "令牌对不上：应用可能换过令牌，或者连到了别的端口。" : `应用返回 ${status}。`);
  } catch (error) {
    if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32000, message: explain(error) } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) forward(line);
});
