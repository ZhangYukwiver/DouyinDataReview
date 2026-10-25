import { createHash } from "node:crypto";
import { DirectHistoryError } from "./directHistory.mjs";
import { directSecurityHeaders, refreshDirectCsrf, requireDirectCredentials } from "./directCredentials.mjs";

export const DIRECT_WRITE_PATHS = {
  like: "/aweme/v1/web/commit/item/digg/", collect: "/aweme/v1/web/aweme/collect/",
  follow: "/aweme/v1/web/commit/follow/user/", comment: "/aweme/v1/web/comment/publish", deleteComment: "/aweme/v1/web/comment/delete/",
};

export function parseDirectJson(response) {
  if (!response.text?.trim() || response.text.trim() === "blocked")
    throw new DirectHistoryError("verification_required", "抖音要求安全验证，请在登录窗口完成后重试。");
  let value;
  try { value = JSON.parse(response.text); } catch { throw new DirectHistoryError("invalid_json", "抖音没有返回有效操作回执。"); }
  if (!value || typeof value !== "object") throw new DirectHistoryError("schema_changed", "抖音操作回执格式发生变化。");
  return value;
}

export async function signDirectRequest(api, url, { body = "", method = "GET", append = {} } = {}) {
  const signed = await api.signer(url, { userAgent: api.currentUserAgent, uifid: api.cookie("UIFID"), method, body });
  const checked = new URL(signed);
  if (checked.origin !== url.origin || checked.pathname !== url.pathname || checked.hash || checked.username || checked.password
    || !/^[A-Za-z0-9+/_=-]{64,512}$/u.test(checked.searchParams.get("a_bogus") || ""))
    throw new DirectHistoryError("unsafe_url", "签名结果偏离允许的操作接口，已停止请求。");
  return String(signed) + Object.entries(append).map(([name, value]) => `&${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("");
}

export async function directWrite(api, action, input, { onDispatch = () => {} } = {}) {
  const pathname = DIRECT_WRITE_PATHS[action];
  if (!pathname) throw new DirectHistoryError("invalid_request", "操作类型无效。");
  const security = requireDirectCredentials(api.session);
  const awemeId = String(input.awemeId || "");
  if (action !== "follow" && !/^\d{5,30}$/u.test(awemeId)) throw new DirectHistoryError("invalid_request", "作品标识无效。");
  let body;
  if (["like", "collect", "follow"].includes(action) && typeof input.desired !== "boolean") throw new DirectHistoryError("invalid_request", "请选择目标状态。");
  if (action === "like") body = { aweme_id: awemeId, item_type: "0", type: input.desired ? "1" : "0" };
  if (action === "collect") body = { action: input.desired ? "1" : "0", aweme_id: awemeId, aweme_type: "0" };
  if (action === "follow") {
    if (!/^\d{1,30}$/u.test(input.uid || "") || !/^MS4w[\w-]{10,200}$/u.test(input.secUid || "") || input.uid === api.session.uid)
      throw new DirectHistoryError("invalid_request", "关注目标无效。");
    body = { user_id: input.uid, sec_user_id: input.secUid, type: input.desired ? "1" : "0", channel_id: "3", from: "0", from_pre: "0" };
  }
  if (action === "comment") {
    const content = typeof input.text === "string" ? input.text.replace(/\s+/gu, " ").trim() : "";
    if (!content || content.length > 500 || (input.replyTo != null && !/^\d{5,30}$/u.test(input.replyTo)))
      throw new DirectHistoryError("invalid_request", "评论需为 1–500 字，请选择有效回复对象。");
    body = { aweme_id: awemeId, ...(input.replyTo ? { reply_id: input.replyTo } : {}), comment_send_celltime: "0", comment_video_celltime: "0",
      one_level_comment_rank: "-1", paste_edit_method: "non_paste", text: content, text_extra: "[]" };
  }
  if (action === "deleteComment") {
    if (!/^\d{5,30}$/u.test(input.commentId || "")) throw new DirectHistoryError("invalid_request", "评论标识无效。");
    body = { cid: input.commentId, aweme_id: awemeId };
  }
  // Refresh CSRF before dispatch. No write is retried after a transport error.
  await refreshDirectCsrf(api);
  // The current PC site's write requests are routed through www-hj. Sending
  // the same write to the page host reaches a different server policy.
  const url = new URL(pathname, "https://www-hj.douyin.com");
  for (const [name, value] of Object.entries({ device_platform: "webapp", aid: "6383", channel: "channel_pc_web", ...api.session.values,
    uifid: api.cookie("UIFID"), verifyFp: api.cookie("s_v_web_id"), fp: api.cookie("s_v_web_id"), msToken: security.msToken || api.cookie("msToken") }))
    if (value) url.searchParams.set(name, String(value));
  const encoded = new URLSearchParams(body).toString();
  const signed = await signDirectRequest(api, url, { method: "POST", body: action === "like" ? "" : encoded,
    append: { uid: createHash("md5").update(api.session.uid).digest("hex") } });
  const headers = { ...directSecurityHeaders(api.session, pathname), Origin: "https://www.douyin.com" };
  onDispatch();
  const response = await api.raw(signed, { method: "POST", body: encoded, headers, referer: "https://www.douyin.com/" });
  return parseDirectJson(response);
}
