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

// 「转文字」接口本来就收一个列表。实测一次带 10 条、0.3 秒全部返回，按 message_id 一一对上；
// ponytail: 只验证过 10 条，更大的批次没试过
export const VOICE_BATCH_SIZE = 10;

/** 每条返回 { id, text } 或 { id, error, message }；整批请求失败（登录、限流等）才抛错 */
export async function transcribeVoiceMessages(api, messages, { signal } = {}) {
  const items = messages.map(message => ({ message,
    voice: /^\d{1,30}$/u.test(message.id) ? normalizeVoiceResource(message.voiceResource) : null }));
  const ready = items.filter(item => item.voice);
  const byId = new Map();
  if (ready.length) {
    // Native caller: lf3-social.iesdouyin.com/obj/douyin-social-cdn/pcim/static/js/async/__federation_expose_default_export.0ccd0cf4.js
    // resource_url.uri (plain voice) or tkey + skey (encrypted voice).
    const payload = await api.request(VOICE_RECOGNITION_PATH, { method: "POST", contentType: "application/json", signal,
      body: JSON.stringify({ req_list: ready.map(({ message, voice }) => ({ uri: voice.uri, sec_uid: voice.secUid,
        uuid: api.session.values.webid || "0", message_id: message.id, message_type: voice.messageType,
        ...(voice.skey ? { skey: voice.skey } : {}), conv_short_id: voice.conversationShortId })) }) });
    // 按 message_id 对号；只发一条时没带编号也算这一条的。有一条对不上号就整批作废，绝不把别人的话安到这条上
    for (const result of Array.isArray(payload.recognition_results) ? payload.recognition_results : []) {
      const id = result?.message_id == null && ready.length === 1 ? ready[0].message.id : String(result?.message_id);
      if (!ready.some(item => item.message.id === id))
        throw new DirectHistoryError("voice_result_mismatch", "抖音返回的转写与当前语音不一致。");
      byId.set(id, result);
    }
  }
  return items.map(({ message, voice }) => {
    if (!voice) return { id: message.id, error: "voice_resource_missing", message: "缺少语音转写资料，请重新读取聊天记录后再导出。" };
    const text = typeof byId.get(message.id)?.text_result === "string" ? byId.get(message.id).text_result.trim() : "";
    return text && text.length <= 16_000 ? { id: message.id, text }
      : { id: message.id, error: "voice_text_unavailable", message: "抖音暂未返回这条语音的转写文字。" };
  });
}

export async function transcribeVoiceMessage(api, message, options) {
  const [result] = await transcribeVoiceMessages(api, [message], options);
  if (result.error) throw new DirectHistoryError(result.error, result.message);
  return result;
}
