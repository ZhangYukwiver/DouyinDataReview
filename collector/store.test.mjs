import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEmptyRecords } from "./normalizer.mjs";
import { CollectorStore } from "./store.mjs";

describe("CollectorStore", () => {
  it("atomically replaces an existing snapshot without storing raw session data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-"));
    try {
      const store = new CollectorStore(directory);
      const records = createEmptyRecords();
      records.liked_videos.push({
        id: "liked_videos:1",
        title: "记录",
        author: null,
        occurredAt: null,
        url: "https://www.douyin.com/video/1",
      });

      await store.save(records, ["第一次"]);
      await store.save(records, ["第二次"], {
        directSync: { watch_history: true, liked_videos: false, favorite_videos: true },
        chatMessages: [{
          id: "chat-1",
          conversationId: "conv-1",
          conversationName: "会话",
          senderId: "user-1",
          senderName: "联系人",
          sentAt: "2026-08-20T00:00:00.000Z",
          type: "call",
          text: "通话",
          mediaUrl: "https://evil.example/image.jpg",
          share: {
            title: "视频标题",
            author: "作者",
            coverUrl: "https://p3.douyinpic.com/cover.jpg",
            url: "https://www.douyin.com/video/123?token=secret",
          },
          callDurationSeconds: 208,
        }, {
          id: "group-body-1",
          conversationId: "group-1",
          conversationType: "group",
          conversationName: "群聊",
          senderId: "user-1",
          senderName: "成员",
          sentAt: "2026-08-20T00:01:00.000Z",
          type: "text",
          text: "不应落盘",
          mediaUrl: null,
          share: null,
          callDurationSeconds: null,
        }],
        chatConversations: [{
          id: "group-1",
          kind: "group",
          name: "测试群",
          avatarUrl: "https://p3.douyinpic.com/group-avatar.jpg",
          messageCount: 12,
          ownMessageCount: 3,
        }],
      });

      const loaded = await store.load();
      const raw = await readFile(path.join(directory, "records.json"), "utf8");
      expect(loaded.schemaVersion).toBe(2);
      expect(loaded.records.liked_videos).toHaveLength(1);
      expect(loaded.warnings).toEqual(["第二次"]);
      expect(loaded.directSync).toEqual({
        watch_history: true,
        liked_videos: false,
        favorite_videos: true,
      });
      expect(loaded.chatMessages).toMatchObject([{
        id: "chat-1",
        callDurationSeconds: 208,
        mediaUrl: null,
        share: {
          coverUrl: "https://p3.douyinpic.com/cover.jpg",
          url: "https://www.douyin.com/video/123",
        },
      }]);
      expect(loaded.chatMessages).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "group-body-1" })]));
      expect(loaded.chatConversations).toEqual([expect.objectContaining({
        id: "group-1",
        kind: "group",
        name: "测试群",
        avatarUrl: "https://p3.douyinpic.com/group-avatar.jpg",
        messageCount: 12,
        ownMessageCount: 3,
      })]);
      expect(Object.keys(loaded.chatConversations[0])).toEqual([
        "id",
        "kind",
        "name",
        "avatarUrl",
        "secUid",
        "lastActiveAt",
        "messageCount",
        "ownMessageCount",
      ]);
      expect(raw).not.toMatch(/cookie|msToken|a_bogus|x-bogus/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates a v1 snapshot without clearing its records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-v1-"));
    try {
      const filePath = path.join(directory, "records.json");
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2025-01-01T00:00:00.000Z",
        records: {
          watch_history: [{
            id: "watch_history:legacy-video",
            title: "legacy record",
            author: "legacy creator",
            occurredAt: "2024-12-31T16:00:00.000Z",
            url: "https://www.douyin.com/video/legacy-video",
          }],
          liked_videos: [],
          favorite_videos: [],
        },
        warnings: ["legacy warning"],
      }), "utf8");

      const loaded = await new CollectorStore(directory).load();
      const persisted = JSON.parse(await readFile(filePath, "utf8"));

      expect(loaded).toMatchObject({
        schemaVersion: 2,
        updatedAt: "2025-01-01T00:00:00.000Z",
        warnings: ["legacy warning"],
        directSync: { watch_history: false, liked_videos: false, favorite_videos: false },
      });
      expect(loaded.records.watch_history[0]).toMatchObject({
        id: "watch_history:legacy-video:2024-12-31T16:00:00.000Z",
        videoId: "legacy-video",
        title: "legacy record",
        occurredAtSource: "platform_action",
      });
      expect(persisted.schemaVersion).toBe(2);
      expect(persisted.records.watch_history).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates the legacy completion warning into explicit per-type direct sync state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-v2-"));
    try {
      const filePath = path.join(directory, "records.json");
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-08-15T00:00:00.000Z",
        records: createEmptyRecords(),
        warnings: ["无界面读取完成：观看历史 25 页、点赞 72 页、收藏 12 页。"],
      }), "utf8");

      const loaded = await new CollectorStore(directory).load();

      expect(loaded.directSync).toEqual({
        watch_history: true,
        liked_videos: true,
        favorite_videos: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes legacy empty numeric chat placeholders when loading a snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-chat-migration-"));
    try {
      const filePath = path.join(directory, "records.json");
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-08-30T00:00:00.000Z",
        records: createEmptyRecords(),
        chatConversations: [{
          id: "conv-1",
          kind: "friend",
          name: "联系人",
          messageCount: 2,
          ownMessageCount: 1,
        }],
        chatMessages: [{
          id: "7678560234599844388",
          conversationId: "conv-1",
          conversationType: "friend",
          conversationName: "联系人",
          senderId: "me",
          senderName: null,
          sentAt: "2026-08-27T04:15:21.000Z",
          type: "unknown",
          text: null,
          mediaUrl: null,
          share: null,
          callDurationSeconds: null,
        }, {
          id: "unknown-file-1",
          conversationId: "conv-1",
          conversationType: "friend",
          conversationName: "联系人",
          senderId: "friend",
          senderName: "联系人",
          sentAt: "2026-08-27T04:16:00.000Z",
          type: "unknown",
          text: null,
          mediaUrl: null,
          share: null,
          callDurationSeconds: null,
        }],
        warnings: [],
      }), "utf8");

      const loaded = await new CollectorStore(directory).load();
      const persisted = JSON.parse(await readFile(filePath, "utf8"));

      expect(loaded.chatMessages.map((message) => message.id)).toEqual(["unknown-file-1"]);
      expect(persisted.chatMessages.map((message) => message.id)).toEqual(["unknown-file-1"]);
      expect(persisted.records).toEqual(createEmptyRecords());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates title-only share messages to text when loading a snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-share-migration-"));
    try {
      const filePath = path.join(directory, "records.json");
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-08-30T00:00:00.000Z",
        records: createEmptyRecords(),
        chatConversations: [{
          id: "conv-1",
          kind: "friend",
          name: "联系人",
          messageCount: 1,
          ownMessageCount: 0,
        }],
        chatMessages: [{
          id: "plain-share-1",
          conversationId: "conv-1",
          conversationType: "friend",
          conversationName: "联系人",
          senderId: "friend",
          senderName: "联系人",
          sentAt: "2026-08-27T04:15:21.000Z",
          type: "share",
          text: "普通消息",
          mediaUrl: null,
          share: { title: "普通消息", author: null, coverUrl: null, url: null },
          callDurationSeconds: null,
        }],
        warnings: [],
      }), "utf8");

      const loaded = await new CollectorStore(directory).load();
      const persisted = JSON.parse(await readFile(filePath, "utf8"));

      expect(loaded.chatMessages[0]).toMatchObject({ type: "text", text: "普通消息", share: null });
      expect(persisted.chatMessages[0]).toMatchObject({ type: "text", text: "普通消息", share: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps concurrent saves from racing on the shared temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-collector-store-"));
    try {
      const store = new CollectorStore(directory);
      await Promise.all(Array.from({ length: 5 }, () => store.save(createEmptyRecords())));
      expect((await store.load()).records.liked_videos).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
