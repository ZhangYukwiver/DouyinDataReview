import { describe, expect, it } from "vitest";
import { createEmptyPersonalRecords } from "../domain/personalRecords";
import { buildDataExport, type DataExportSelection } from "./exportData";
import { parseExportedSnapshot, type CollectorSnapshot } from "./localCollector";

const snapshot: CollectorSnapshot = {
  schemaVersion: 2, updatedAt: "2026-10-14T01:00:00Z", records: {
    watch_history: [{ id: "watch-1", title: "watch-title", author: null, occurredAt: null, url: null }],
    liked_videos: [{ id: "like-1", title: "like-title", author: null, occurredAt: null, url: null }],
    favorite_videos: [{ id: "favorite-1", title: "favorite-title", author: null, occurredAt: null, url: null }],
  },
  chatMessages: [{ id: "message", conversationId: "friend", conversationType: "friend", conversationName: "好友", senderId: "friend", senderName: "好友",
    sentAt: "2026-10-14T01:00:00Z", type: "text", text: "private message", mediaUrl: null, share: null, callDurationSeconds: null }],
  chatConversations: [{ id: "friend", kind: "friend", name: "好友", messageCount: 1, ownMessageCount: 0, avatarUrl: null }],
  warnings: ["warning about private message"],
};
const none: DataExportSelection = { watch_history: false, liked_videos: false, favorite_videos: false, chat: false };

describe("selected data export", () => {
  it("excludes chat contents, conversation metadata and collection warnings from video-only exports", () => {
    const data = buildDataExport(snapshot, { ...none, watch_history: true });
    expect(data.parts).toEqual(["watch_history"]);
    expect(data.chatMessages).toEqual([]); expect(data.chatConversations).toEqual([]);
    expect(data.records.watch_history).toEqual(snapshot.records.watch_history);
    expect(data.records.liked_videos).toEqual([]); expect(data.records.favorite_videos).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("private message");
    expect(parseExportedSnapshot(data)).not.toBeNull();
    expect(snapshot.chatMessages).toHaveLength(1);
  });
  it("exports chat-only backups that can be imported again", () => {
    const data = buildDataExport(snapshot, { ...none, chat: true });
    expect(data.records).toEqual(createEmptyPersonalRecords());
    expect(parseExportedSnapshot(data)?.chatMessages[0]?.text).toBe("private message");
    expect(data.chatConversations).toEqual(snapshot.chatConversations);
  });
  it("rejects an empty selection", () => {
    expect(() => buildDataExport(snapshot, none)).toThrow("至少选择");
  });
  it.each(["liked_videos", "favorite_videos"] as const)("exports only the selected video category %s", part => {
    const data = buildDataExport(snapshot, { ...none, [part]: true });
    expect(data.records[part]).toEqual(snapshot.records[part]);
    expect(data.records.watch_history).toEqual([]);
    expect(data.chatMessages).toEqual([]);
    expect(parseExportedSnapshot(data)?.records[part]).toHaveLength(1);
  });
});
