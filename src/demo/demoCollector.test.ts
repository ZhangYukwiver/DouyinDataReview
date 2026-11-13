import { afterEach, expect, it, vi } from "vitest";
import { checkCollectorHealth, getCollectorPairingCode, getCollectorRecords, getCollectorStatus, getDefaultCollectorBaseUrl, pairCollector } from "../services/localCollector";
import { installDemoCollector } from "./demoCollector";

afterEach(() => vi.unstubAllGlobals());

// 客户端的解析规则一收紧，合成数据就可能整条被丢掉：用真的解析函数读一遍
it("在线体验版的假采集器能被工作台原样读进来", async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", globalThis.fetch);
  installDemoCollector();
  const base = getDefaultCollectorBaseUrl();
  await checkCollectorHealth(base);
  const token = await pairCollector(base, await getCollectorPairingCode(base));
  const [status, snapshot] = await Promise.all([getCollectorStatus(base, token), getCollectorRecords(base, token)]);
  expect(status.state).toBe("complete");
  expect(snapshot.records.watch_history).toHaveLength(status.counts.watch_history);
  expect(snapshot.records.liked_videos).toHaveLength(status.counts.liked_videos);
  expect(snapshot.records.favorite_videos).toHaveLength(status.counts.favorite_videos);
  expect(snapshot.chatMessages).toHaveLength(status.counts.chat_messages);
  expect(snapshot.records.watch_history.length).toBeGreaterThan(1000);
});
