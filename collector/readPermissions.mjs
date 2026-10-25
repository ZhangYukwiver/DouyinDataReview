import { BrowserConnectionError } from "./browserConnection.mjs";

export function parseReadPermissions(value) {
  if (!value || typeof value.videos !== "boolean" || typeof value.chat !== "boolean" || (!value.videos && !value.chat))
    throw new BrowserConnectionError("invalid_read_permissions", "请选择读取视频、读取聊天中的至少一项。", 400);
  return { videos: value.videos, chat: value.chat };
}

export function importedReadPermissions(source) {
  // Imports made before permission selection retain their existing capabilities.
  if (!source || !Object.hasOwn(source, "readPermissions")) return { videos: true, chat: true };
  try { return parseReadPermissions(source.readPermissions); }
  catch { return { videos: false, chat: false }; }
}

export function readPermissionForRequest(method, pathname) {
  if ((method === "POST" && ["/v1/chat/observe", "/v1/chat/messages", "/v1/chat/send"].includes(pathname))
    || (method === "GET" && pathname === "/v1/chat/streaks")) return "chat";
  if ((method === "POST" && ["/v1/sync", "/v1/experimental/records-direct", "/v1/downloads",
    "/v1/explore/read", "/v1/explore/interact", "/v1/explore/video", "/v1/creator/read", "/v1/live/rooms", "/v1/analyses"].includes(pathname))
    || (method === "GET" && (pathname === "/v1/live/following" || /^\/v1\/live\/rooms\/[0-9a-f-]{36}$/u.test(pathname)))) return "videos";
  return null;
}

// 会在抖音上留下动作的请求：探索里的点赞、收藏、关注、评论、分享，聊天和续火花的发消息
export const WRITE_REQUESTS = new Set(["/v1/explore/interact", "/v1/chat/send"]);
export const WRITES_DISABLED_MESSAGE = "在抖音上点赞、评论、关注、分享和发私信默认是关着的，到「设置 → 隐私」打开「允许在抖音上操作」再试。";
