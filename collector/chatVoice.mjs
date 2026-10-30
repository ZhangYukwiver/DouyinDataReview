import { DirectHistoryError } from "./directHistory.mjs";

export const VOICE_MESSAGE_TYPES = new Set([17, 109, 501]);
export const VOICE_RECOGNITION_PATH = "/aweme/v1/web/im/message/audio/recognition/";

const string = (value, limit = 2_048) => typeof value === "string" && value.trim().length <= limit
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : "";

// Only the fields used by Douyin's own “转文字” action. Keep these in the local
// collector; the portable export must not contain the audio decryption key.
export function normalizeVoiceResource(value) {
  if (!value || typeof value !== "object" || !VOICE_MESSAGE_TYPES.has(value.messageType)) return null;
  const uri = string(value.uri), secUid = string(value.secUid, 300), shortId = string(value.conversationShortId, 30);
  if (!uri || !/^MS4w[\w-]+$/u.test(secUid) || !/^\d{1,30}$/u.test(shortId)) return null;
  return { uri, secUid, conversationShortId: shortId, messageType: value.messageType,
    ...(string(value.skey) ? { skey: string(value.skey) } : {}) };
}

export async function transcribeVoiceMessage(api, message, { signal } = {}) {
  const voice = normalizeVoiceResource(message.voiceResource);
  if (!voice || !/^\d{1,30}$/u.test(message.id))
    throw new DirectHistoryError("voice_resource_missing", "缺少语音转写资料，请重新读取聊天记录后再导出。");
  // Native caller: lf3-social.iesdouyin.com/obj/douyin-social-cdn/pcim/static/js/async/__federation_expose_default_export.0ccd0cf4.js
  // resource_url.uri (plain voice) or tkey + skey (encrypted voice).
  const payload = await api.request(VOICE_RECOGNITION_PATH, { method: "POST", contentType: "application/json", signal,
    body: JSON.stringify({ req_list: [{ uri: voice.uri, sec_uid: voice.secUid,
      uuid: api.session.values.webid || "0", message_id: message.id, message_type: voice.messageType,
      ...(voice.skey ? { skey: voice.skey } : {}), conv_short_id: voice.conversationShortId }] }) });
  const results = payload.recognition_results;
  // Send one message per request. Never attach another message's result.
  const result = Array.isArray(results) && results.length === 1 ? results[0] : null;
  if (result?.message_id != null && String(result.message_id) !== message.id)
    throw new DirectHistoryError("voice_result_mismatch", "抖音返回的转写与当前语音不一致。");
  const text = typeof result?.text_result === "string" ? result.text_result.trim() : "";
  if (!text || text.length > 16_000)
    throw new DirectHistoryError("voice_text_unavailable", "抖音暂未返回这条语音的转写文字。");
  return { id: message.id, text };
}
