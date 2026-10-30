import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeChatPayload } from "./chatNormalizer.mjs";
import { normalizeVoiceResource, transcribeVoiceMessage, VOICE_RECOGNITION_PATH } from "./chatVoice.mjs";
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
});
