// Runs only after the user taps Read, inside their own Douyin WebView session.
// The site's SDK signs its fetch calls; credentials never cross the native bridge.
// Keep this as a string: Function.toString() changes when Metro minifies a release.
const READER = String.raw`async function(requestId, options) {
  const send = (message) => window.ReactNativeWebView.postMessage(JSON.stringify({ requestId, ...message }));
  const fail = (code) => { throw new Error(code); };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    if (window.top !== window || location.origin !== "https://www.douyin.com") fail("page");
    const historyPath = "/aweme/v1/web/history/read/";
    const apiHosts = ["www.douyin.com", "www-hj.douyin.com"];
    const templates = performance.getEntriesByType("resource").map(entry => {
      try { return new URL(entry.name); } catch { return null; }
    }).filter(url => url && url.protocol === "https:" && apiHosts.includes(url.hostname)
      && url.pathname === historyPath && !url.port && !url.username && !url.password);
    const template = templates[templates.length - 1];
    if (!template || template.searchParams.get("aid") !== "6383" || !template.searchParams.get("webid")) fail("template");
    const common = new URLSearchParams();
    const safe = ["device_platform", "aid", "channel", "update_version_code", "pc_client_type", "pc_libra_divert",
      "support_h265", "support_dash", "version_code", "version_name", "cookie_enabled", "screen_width",
      "screen_height", "browser_language", "browser_platform", "browser_name", "browser_version",
      "browser_online", "engine_name", "engine_version", "os_name", "os_version", "cpu_core_num",
      "device_memory", "platform", "downlink", "effective_type", "round_trip_time", "webid"];
    for (const key of safe) {
      const value = template.searchParams.get(key);
      if (value && value.length <= 500) common.set(key, value);
    }
    const request = async (path, business, form) => {
      const url = new URL(path, location.origin);
      url.search = common.toString();
      for (const [key, value] of Object.entries(business || {})) url.searchParams.set(key, value);
      const response = await fetch(url.toString(), { credentials: "include", signal: controller.signal, redirect: "error",
        ...(form ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: new URLSearchParams(form).toString() } : {}) });
      if (response.status === 429) fail("limited");
      if (response.status === 401 || response.status === 403) fail("login");
      if (response.status !== 200) fail("rejected");
      const resultUrl = new URL(response.url);
      // The site's SDK can route history reads to its first-party www-hj host.
      if (resultUrl.protocol !== "https:" || !apiHosts.includes(resultUrl.hostname) || resultUrl.port
        || resultUrl.username || resultUrl.password || resultUrl.pathname !== path) fail("format");
      if (Number(response.headers.get("content-length")) > 8000000) fail("format");
      const body = await response.text();
      if (body.length > 8000000) fail("format");
      let data;
      try { data = JSON.parse(body); } catch { fail("format"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) fail("format");
      if (data.status_code === 8) fail("login");
      if (data.status_code !== 0) fail("rejected");
      return data;
    };
    const identity = async () => {
      const payload = await request("/aweme/v1/web/user/profile/self/");
      const user = payload.user || (payload.data && payload.data.user);
      if (!user || !/^[1-9]\d{0,29}$/.test(String(user.uid || ""))) fail("login");
      return { id: String(user.uid), nickname: String(user.nickname || "抖音用户").slice(0, 100) };
    };
    const account = await identity();
    if (options && options.accountId && options.accountId !== account.id) fail("account");
    if (options && options.prepareOnly) {
      send({ type: "session", account, context: { userAgent: navigator.userAgent, values: Object.fromEntries(common) } });
      return;
    }
    const type = options ? options.recordType : "watch_history";
    const cursor = options ? options.cursor : "0";
    if (!["watch_history", "liked_videos", "favorite_videos"].includes(type) || !/^\d{1,20}$/.test(cursor)) fail("format");
    let response;
    if (type === "watch_history") {
      response = await request(historyPath, { count: "20", max_cursor: cursor, directory: "0", category: "0", status: "-1" });
    } else if (type === "liked_videos") {
      const self = await request("/aweme/v1/web/user/profile/self/");
      const user = self.user || (self.data && self.data.user);
      if (!user || String(user.uid) !== account.id) fail("account");
      if (typeof user.sec_uid !== "string" || !/^MS4w[\w-]{10,200}$/.test(user.sec_uid)) fail("format");
      response = await request("/aweme/v1/web/aweme/favorite/", { sec_user_id: user.sec_uid, max_cursor: cursor,
        min_cursor: "0", whale_cut_token: "", cut_version: "1", count: "18", publish_video_strategy_type: "2" });
    } else {
      response = await request("/aweme/v1/web/aweme/listcollection/", { publish_video_strategy_type: "2" }, { count: "10", cursor });
    }
    const payload = Array.isArray(response.aweme_list) ? response : response.data;
    if (!payload || !Array.isArray(payload.aweme_list) || payload.aweme_list.length > 20) fail("format");
    if (![0, 1, false, true, "0", "1"].includes(payload.has_more)) fail("format");
    const records = payload.aweme_list.map(item => {
      if (!item || !/^[1-9]\d{0,29}$/.test(String(item.aweme_id || ""))) fail("format");
      const id = String(item.aweme_id);
      const history = item.history_info || {};
      // A publication timestamp or playback-progress update is not a like/favorite action.
      const rawTime = type === "watch_history" ? ((payload.aweme_date || response.aweme_date || {})[id]
        || history.view_time || history.watch_time || history.history_time || item.view_time || item.watch_time || item.history_time || item.last_view_time) : null;
      const numeric = Number(rawTime);
      const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric) : null;
      const watchedAt = date && Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100
        ? date.toISOString() : null;
      const basic = { id, title: String(item.desc || item.caption || "未命名作品").slice(0, 500),
        author: String(item.author && item.author.nickname || "未知作者").slice(0, 100), watchedAt };
      if (!options) return basic;
      const topics = [...(Array.isArray(item.cha_list) ? item.cha_list.map(row => row.cha_name) : []),
        ...(Array.isArray(item.text_extra) ? item.text_extra.map(row => row.hashtag_name) : []),
        ...(basic.title.match(/#[^\s#]+/g) || []).map(tag => tag.slice(1))]
        .filter(value => typeof value === "string" && value.trim()).map(value => value.trim().slice(0, 100));
      const duration = Number(item.video && item.video.duration || item.duration);
      const music = item.music;
      return { ...basic, authorId: item.author && item.author.uid ? String(item.author.uid) : null,
        topics: [...new Set(topics)].slice(0, 30),
        durationSeconds: Number.isFinite(duration) && duration > 0 && duration <= 86400000 ? duration / 1000 : null,
        music: music && music.title ? { title: String(music.title).slice(0, 100), author: String(music.author || "").slice(0, 100) } : null };
    });
    if ((await identity()).id !== account.id) fail("account");
    const hasMore = [1, "1", true].includes(payload.has_more);
    const nextCursor = String(payload[type === "favorite_videos" ? "cursor" : "max_cursor"] ?? response[type === "favorite_videos" ? "cursor" : "max_cursor"] ?? "");
    if (options && hasMore && (!/^\d{1,20}$/.test(nextCursor) || nextCursor === cursor)) fail("pagination");
    send({ type: "page", account, records, hasMore,
      ...(options ? { recordType: type, cursor, nextCursor: hasMore ? nextCursor : null } : {}) });
  } catch (error) {
    const code = error && error.name === "AbortError" ? "timeout" : error && error.message;
    send({ type: "error", code: ["page", "template", "login", "account", "timeout", "network", "rejected", "limited", "format", "pagination"].includes(code) ? code : "network" });
  } finally { clearTimeout(timer); }
}`;

export function buildReaderScript(requestId: string, options?: {
  recordType: import("../domain/personalRecords").PersonalRecordType; cursor: string; accountId?: string;
}): string {
  return `(${READER})(${JSON.stringify(requestId)},${JSON.stringify(options) ?? "undefined"});true;`;
}

export function buildSessionScript(requestId: string, accountId?: string): string {
  return `(${READER})(${JSON.stringify(requestId)},${JSON.stringify({ prepareOnly: true, accountId })});true;`;
}
