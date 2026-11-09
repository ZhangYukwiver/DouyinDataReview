import { describe, expect, it } from "vitest";
import { buildConversationExport, conversationExportName, conversationText } from "./conversationExport";
import type { ChatConversationSummary, ChatMessage } from "../domain/chatRecords";

const friend: ChatConversationSummary = { id: "friend-a", kind: "friend", name: "同名好友", messageCount: 500, ownMessageCount: 250 };
const message = (id: number, conversationId = friend.id): ChatMessage => ({ id: String(id), conversationId, conversationType: "friend", conversationName: friend.name,
  senderId: id % 2 ? "self" : "peer", senderName: null, sentAt: "2026-11-09T10:00:00Z", type: "text", text: `测试 ${id}`, mediaUrl: null, share: null, callDurationSeconds: null });

describe("single conversation export", () => {
  it("exports all 500 local messages, excludes a same-named friend and strips voice secrets", () => {
    const messages = Array.from({ length: 500 }, (_, id) => message(id));
    const sensitive = { ...message(501), voiceResource: { secret: "must-not-export" } };
    const result = buildConversationExport(friend, [...messages, message(600, "friend-b"), sensitive]);
    expect(result.chatMessages).toHaveLength(501);
    expect(result.chatConversations).toHaveLength(1);
    expect(result.chatConversations[0]?.messageCount).toBe(501);
    expect(result.parts).toEqual(["chat"]);
    expect(result.records).toEqual({ watch_history: [], liked_videos: [], favorite_videos: [] });
    expect(JSON.stringify(result)).not.toContain("must-not-export");
    expect(sensitive.voiceResource.secret).toBe("must-not-export");
  });
  it("refuses group exports and empty matches", () => {
    expect(() => buildConversationExport({ ...friend, kind: "group" }, [message(1)])).toThrow();
    expect(() => buildConversationExport(friend, [message(1, "other")])).toThrow();
    expect(() => buildConversationExport(friend, [{ ...message(1), conversationType: "group" }])).toThrow();
  });
  it("labels self in text and makes a safe Windows filename", () => {
    expect(conversationText(buildConversationExport(friend, [message(1)]), "self")).toContain("] 我\r\n测试 1");
    expect(conversationExportName('../a:<b>', "txt")).not.toMatch(/[<>:"/\\|?*]/u);
  });
});
