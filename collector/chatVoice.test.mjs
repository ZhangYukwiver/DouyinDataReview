import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeChatPayload } from "./chatNormalizer.mjs";
import { normalizeVoiceResource, transcribeVoiceMessage, transcribeVoiceMessages, VOICE_RECOGNITION_PATH } from "./chatVoice.mjs";
import { directApiFixture, imResponse } from "./fixtures/directClient.mjs";
import { protoNumber as n, protoString as s, protoMessage as m } from "./directProto.mjs";
import { CollectorStore } from "./store.mjs";
import { createEmptyRecords } from "./normalizer.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";

const id = "7654321098765432199", shortId = "7654321098765432100", secUid = `MS4w${"a".repeat(24)}`;
const resource = { uri: "tos-cn-i-audio/resource", secUid, conversationShortId: shortId, messageType: 109, skey: "synthetic-key" };
const message = { id, type: "voice", conversationType: "friend", voiceResource: resource };

describe("Douyin voice transcription", () => {
  it.each([17, 109, 501])("retains native voice type %s and exact 64-bit request identifiers", async type => {
    const payload = imResponse(301, [m(1, [s(1, "0:1:123:456"), n(2, 1), n(3, id), n(5, shortId), n(6, type), n(7, 456),
      s(8, JSON.stringify(type === 17 ? { resource_url: { uri: resource.uri }, duration: 5000 }
        : { aweType: 10900, tkey: resource.uri, skey: resource.skey, duration: 5000 })), s(14, secUid)]), n(2, 0)]);
    const normalized = normalizeChatPayload(payload, { endpoint: { kind: "chat_messages", pathname: "/v1/message/get_by_conversation" } }).messages[0];
    expect(normalized).toMatchObject({ id, type: "voice", voiceResource: { uri: resource.uri, secUid, conversationShortId: shortId, messageType: type } });
    const directory = await mkdtemp(path.join(tmpdir(), "dy-voice-"));
    try {
      const store = new CollectorStore(directory);
      await store.save(createEmptyRecords(), [], { chatMessages: [normalized] });
      expect((await store.load()).chatMessages[0].voiceResource).toEqual(normalized.voiceResource);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("posts the native JSON request and signs the exact body without fetching the audio", async () => {
    const { api, fetch, signer } = directApiFixture((url, options) => {
      expect(url.pathname).toBe(VOICE_RECOGNITION_PATH);
      expect(options.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(options.data)).toEqual({ req_list: [{ uri: resource.uri, sec_uid: secUid, uuid: "1234567890123456789",
        message_id: id, message_type: 109, skey: resource.skey, conv_short_id: shortId }] });
      return { payload: { status_code: 0, recognition_results: [{ message_id: id, text_result: " 明天见。 " }] } };
    });
    try {
      expect(await transcribeVoiceMessage(api, message)).toEqual({ id, text: "明天见。" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(signer.mock.calls[0][1].body).toBe(fetch.mock.calls[0][1].data);
    } finally { await api.close(); }
  });

  it.each([
    [{ recognition_results: [] }, "voice_text_unavailable"],
    [{ recognition_results: [{ text_result: " " }] }, "voice_text_unavailable"],
    [{ recognition_results: [{ message_id: "999", text_result: "别人的话" }] }, "voice_result_mismatch"],
    [{ status_code: 8 }, "login_required"],
  ])("does not claim transcription success for an invalid response", async (payload, code) => {
    const { api } = directApiFixture(() => ({ payload }));
    try { await expect(transcribeVoiceMessage(api, message)).rejects.toMatchObject({ code }); }
    finally { await api.close(); }
  });

  it("transcribes several voices in one request and matches each result by message id", async () => {
    const second = { ...message, id: "7654321098765432188" }, third = { ...message, id: "7654321098765432177" };
    const { api, fetch } = directApiFixture((url, options) => {
      expect(JSON.parse(options.data).req_list.map(item => item.message_id)).toEqual([id, second.id, third.id]);
      return { payload: { status_code: 0, recognition_results: [{ message_id: second.id, text_result: "第二条" }, { message_id: id, text_result: "第一条" }] } };
    });
    try {
      expect(await transcribeVoiceMessages(api, [message, second, third, { id: "1", type: "voice" }])).toEqual([
        { id, text: "第一条" }, { id: second.id, text: "第二条" },
        { id: third.id, error: "voice_text_unavailable", message: expect.any(String) },
        { id: "1", error: "voice_resource_missing", message: expect.any(String) },
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await api.close(); }
  });

  it("rejects missing resources before any platform request", async () => {
    const api = { request: vi.fn() };
    await expect(transcribeVoiceMessage(api, { id })).rejects.toMatchObject({ code: "voice_resource_missing" });
    expect(normalizeVoiceResource({ ...resource, conversationShortId: "not-an-id" })).toBeNull();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("only transcribes a local friend voice in the selected collector", async () => {
    const collector = new DouyinCollector({ dataDirectory: "/unused-voice-test", store: {} });
    collector.snapshot = { chatMessages: [message, { ...message, id: "123", conversationType: "group" }] };
    collector.ensureDirectApi = vi.fn();
    await expect(collector.transcribeChatVoice({ messageId: "999" })).rejects.toMatchObject({ code: "voice_not_found" });
    await expect(collector.transcribeChatVoice({ messageId: "123" })).rejects.toMatchObject({ code: "voice_not_found" });
    expect(collector.ensureDirectApi).not.toHaveBeenCalled();
  });

  it("keeps a finished transcript locally so exporting again does not ask Douyin", async () => {
    const { api, fetch } = directApiFixture(() => ({ payload: { status_code: 0, recognition_results: [{ message_id: id, text_result: "明天见。" }] } }));
    const collector = new DouyinCollector({ dataDirectory: "/unused-voice-test", store: {} });
    collector.snapshot = { chatMessages: [{ ...message }] };
    collector.ensureDirectApi = vi.fn(async () => api);
    try {
      expect(await collector.transcribeChatVoice({ messageId: id })).toEqual({ id, text: "明天见。" });
      expect(await collector.transcribeChatVoice({ messageId: id })).toEqual({ id, text: "明天见。" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(collector.snapshot.chatMessages[0]).toMatchObject({ text: "明天见。", voiceTranscription: { status: "done" } });
    } finally { await api.close(); }
  });
});
