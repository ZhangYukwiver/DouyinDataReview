import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startCollectorServer } from "./server.mjs";

const runtimes = [];
const directories = [];
const modelServers = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.allSettled(modelServers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function startModel() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "参考 [C1] 的运镜步骤。" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  modelServers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key", model: "fake" };
}

async function start() {
  const directory = await mkdtemp(path.join(tmpdir(), "library-http-"));
  directories.push(directory);
  await writeFile(path.join(directory, "records.json"), JSON.stringify({ schemaVersion: 2, records: {
    watch_history: [{ id: "watch_history:100", videoId: "100", title: "运镜教程", author: "甲", body: "先慢推再平移", url: "https://www.douyin.com/video/100", occurredAt: "2026-01-01" }],
    liked_videos: [], favorite_videos: [],
  }, chatMessages: [], chatConversations: [], warnings: [] }));
  const runtime = await startCollectorServer({ port: 0, dataDirectory: directory, browserSources: [], desktopSupported: false });
  runtimes.push(runtime);
  const pair = await fetch(`${runtime.baseUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) }).then(response => response.json());
  const request = async (pathname, { method = "GET", body } = {}) => {
    const response = await fetch(`${runtime.baseUrl}${pathname}`, { method, headers: { Authorization: `Bearer ${pair.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, request };
}

describe("content library HTTP routes", () => {
  it("rebuilds from records, saves mixed-platform content, and manages topics", async () => {
    const { runtime, request } = await start();
    const initial = await request("/v1/library?platform=douyin&limit=40");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ total: 1, items: [{ key: "douyin:100", platform: "douyin", title: "运镜教程" }] });
    const indexPath = path.join(runtime.dataDirectory, "content-library.json");
    const firstIndexMtime = (await stat(indexPath)).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect((await request("/v1/library?platform=douyin&offset=0&limit=1")).body.items[0].key).toBe("douyin:100");
    expect((await stat(indexPath)).mtimeMs).toBe(firstIndexMtime);
    await writeFile(path.join(runtime.dataDirectory, "records.json"), JSON.stringify({ schemaVersion: 2, records: {
      watch_history: [{ id: "watch_history:100", videoId: "100", title: "运镜教程（更新）", author: "甲", body: "先慢推再平移", url: "https://www.douyin.com/video/100", occurredAt: "2026-01-01" }],
      liked_videos: [], favorite_videos: [],
    }, chatMessages: [], chatConversations: [], warnings: [] }));
    expect((await request("/v1/library?platform=douyin&limit=1")).body.items[0].title).toBe("运镜教程（更新）");

    const note = { platform: "xiaohongshu", accountId: "default", contentId: "note-1", title: "布光笔记", author: "乙", body: "柔光补光", url: "https://www.xiaohongshu.com/explore/note-1" };
    expect((await request("/v1/library/save", { method: "POST", body: { ...note, accountId: "missing" } })).status).toBe(404);
    const saved = await request("/v1/library/save", { method: "POST", body: { ...note, sourceAccounts: [{ accountId: "missing" }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.item.sourceAccounts.map(source => source.accountId)).toEqual(["default"]);
    const created = await request("/v1/library/topics", { method: "POST", body: { name: "拍摄参考" } });
    expect(created.status).toBe(201);
    const topicId = created.body.topic.id;
    expect((await request(`/v1/library/topics/${encodeURIComponent(topicId)}/items`, { method: "POST", body: { key: "douyin:100" } })).status).toBe(200);
    expect((await request(`/v1/library/topics/${encodeURIComponent(topicId)}/items`, { method: "POST", body: { key: "xiaohongshu:note-1" } })).status).toBe(200);
    const scoped = await request(`/v1/library?topicId=${encodeURIComponent(topicId)}&limit=40`);
    expect(scoped.body.items.map(item => item.key).sort()).toEqual(["douyin:100", "xiaohongshu:note-1"]);

    const detail = await request(`/v1/library/items/${encodeURIComponent("douyin:100")}`);
    expect(detail.body.item.title).toBe("运镜教程（更新）");
    expect((await request("/v1/library/topics")).body.topics[0].items).toHaveLength(2);
  });

  it("asks the configured AI with scoped source citations and rejects unknown citations", async () => {
    const { request } = await start();
    const config = await startModel();
    const answer = await request("/v1/library/ask", { method: "POST", body: { scope: "library", question: "怎么运镜？", signal: "watched", filterQuery: "运镜", config } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ answer: "参考 [C1] 的运镜步骤。", sources: [{ citation: "C1", entryKey: "douyin:100", platform: "douyin" }] });
    const scoped = await request("/v1/library/ask", { method: "POST", body: { scope: "item", key: "douyin:100", accountId: "default", question: "总结一下", config } });
    expect(scoped.status).toBe(200);
    expect(scoped.body.sources[0].entryKey).toBe("douyin:100");
  });
});

