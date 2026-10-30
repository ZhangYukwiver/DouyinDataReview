import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPersonalRecords } from "../domain/personalRecords";
import { buildDataExport, buildDataExportWithVoice, type DataExportSelection } from "./exportData";
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
afterEach(() => vi.unstubAllGlobals());

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

describe("voice export", () => {
  const voiceSnapshot = (): CollectorSnapshot => ({ ...snapshot, chatMessages: [
    { ...snapshot.chatMessages[0]!, id: "123", type: "voice", text: null },
    { ...snapshot.chatMessages[0]!, id: "456", type: "voice", text: null },
  ] });
  const options = () => ({ connection: { baseUrl: "http://127.0.0.1:4765", token: "test-token" }, accountId: "account-a", signal: new AbortController().signal });
  it("exports native text, preserves failures, strips resource keys and round-trips long transcripts", async () => {
    const input = voiceSnapshot(), text = "这是转写的完整文字。".repeat(100);
    Object.assign(input.chatMessages[0]!, { voiceResource: { skey: "do-not-export" } });
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toContain("/v1/chat/voice/transcribe?account=account-a");
      const id = JSON.parse(init.body).messageId;
      return id === "123" ? new Response(JSON.stringify({ id, text }))
        : new Response(JSON.stringify({ error: "voice_text_unavailable", message: "暂未返回文字" }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const result = await buildDataExportWithVoice(input, { ...none, chat: true }, { ...options(), onProgress: progress });
    expect(result.chatMessages[0]).toMatchObject({ type: "voice", text, voiceTranscription: { status: "done" } });
    expect(result.chatMessages[1]).toMatchObject({ text: "[语音未转写]", voiceTranscription: { status: "unavailable", reason: "暂未返回文字" } });
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("do-not-export");
    expect(input.chatMessages[0]?.text).toBeNull();
    expect(parseExportedSnapshot(result)?.chatMessages.find(message => message.id === "123")).toMatchObject({ text, voiceTranscription: { status: "done" } });
    expect(progress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
  });
  it("does not contact Douyin when chat is unselected or text is already available", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await buildDataExportWithVoice(voiceSnapshot(), { ...none, liked_videos: true }, options());
    const input = voiceSnapshot();
    input.chatMessages = [{ ...input.chatMessages[0]!, text: "已有文字", voiceTranscription: { status: "done" } }];
    expect((await buildDataExportWithVoice(input, { ...none, chat: true }, options())).chatMessages[0]?.text).toBe("已有文字");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stops the export on cancellation or an account change", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(buildDataExportWithVoice(voiceSnapshot(), { ...none, chat: true }, { ...options(), signal: controller.signal })).rejects.toThrow();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "account_changed", message: "账号已切换" }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(buildDataExportWithVoice(voiceSnapshot(), { ...none, chat: true }, options())).rejects.toMatchObject({ code: "account_changed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry every remaining voice when credentials have expired", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "browser_reconnect_required", message: "请重新导入登录凭据" }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const result = await buildDataExportWithVoice(voiceSnapshot(), { ...none, chat: true }, options());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.chatMessages.every(message => message.voiceTranscription?.status === "failed")).toBe(true);
    expect(result.warnings[0]).toContain("2 条语音未转写");
  });
});
