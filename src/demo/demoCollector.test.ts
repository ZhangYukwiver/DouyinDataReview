import { afterEach, expect, it, vi } from "vitest";
import { checkCollectorHealth, collectorFeedFilter, collectorFeedFilteredVideos, collectorMyComments, getCollectorPairingCode, getCollectorRecords, getCollectorStatus, getDefaultCollectorBaseUrl, pairCollector } from "../services/localCollector";
import { readUsageSessions } from "../services/usageSessions";
import { readRecordFolders } from "../services/recordFolders";
import { installDemoCollector } from "./demoCollector";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// 客户端的解析规则一收紧，合成数据就可能整条被丢掉：用真的解析函数读一遍
it("在线体验版的假采集器能被工作台原样读进来", async () => {
  vi.stubEnv("EXPO_PUBLIC_DEMO", "1");
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", globalThis.fetch);
  installDemoCollector();
  const base = getDefaultCollectorBaseUrl();
  await checkCollectorHealth(base);
  const token = await pairCollector(base, await getCollectorPairingCode(base));
  const [status, snapshot] = await Promise.all([getCollectorStatus(base, token), getCollectorRecords(base, token)]);
  expect(status.state).toBe("complete");
  expect(status.account?.avatar).toMatch(/^data:image\/svg\+xml,/u);
  expect(snapshot.records.watch_history).toHaveLength(status.counts.watch_history);
  expect(snapshot.records.liked_videos).toHaveLength(status.counts.liked_videos);
  expect(snapshot.records.favorite_videos).toHaveLength(status.counts.favorite_videos);
  expect(snapshot.chatMessages).toHaveLength(status.counts.chat_messages);
  expect(snapshot.records.watch_history.length).toBeGreaterThan(1000);
  expect(snapshot.records.watch_history.some((record) => record.mediaType === "live")).toBe(true);
  // 封面超过 2048 字会被截断成坏图
  expect(snapshot.records.watch_history.every((record) => record.coverUrl?.startsWith("data:image/svg+xml,") && record.coverUrl.length < 2048)).toBe(true);
  expect(snapshot.chatConversations.every((conversation) => conversation.avatarUrl)).toBe(true);

  const connection = { baseUrl: base, token };
  expect((await collectorMyComments(base, token)).length).toBeGreaterThan(5);
  expect((await collectorFeedFilteredVideos(base, token)).length).toBeGreaterThan(10);
  expect((await collectorFeedFilter(base, token)).mode).toBe("hide");
  expect((await readUsageSessions(connection)).sessions.length).toBeGreaterThan(10);
  const folders = await readRecordFolders(connection);
  expect(folders?.lists.favorite_videos.folders.length).toBeGreaterThan(1);
  expect(Object.keys(folders?.lists.favorite_videos.items ?? {}).length).toBeGreaterThan(10);
});

it("正式构建不放行 data: 图片地址", async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", globalThis.fetch);
  installDemoCollector();
  const base = getDefaultCollectorBaseUrl();
  const snapshot = await getCollectorRecords(base, await pairCollector(base, "20261113"));
  expect(snapshot.records.watch_history.some((record) => record.coverUrl)).toBe(false);
});
