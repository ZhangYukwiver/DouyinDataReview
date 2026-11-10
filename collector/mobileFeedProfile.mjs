import "../extension/filter.js";
import { searchWord } from "./directExplorer.mjs";

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => ["number", "string", "boolean"].includes(typeof object?.[key]))
    .map(key => [key, object[key]]));
}

// 只导出播放普通视频用到的字段，不携带桌面会话或观看记录。
function cdnMedia(value) {
  if (!value || !Array.isArray(value.url_list)) return undefined;
  const urls = value.url_list.filter(url => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && !u.username && !u.password && !u.port
        && /(?:^|\.)(?:douyinvod|byteimg|douyinpic|douyinstatic|amemv|iesdouyin|douyin|zjcdn|pstatp|bytedance|bytecdn|bytecdntp|ixigua)\.com$/iu.test(u.hostname);
    } catch { return false; }
  }).slice(0, 3);
  if (!urls.length) return undefined;
  return { ...pick(value, ["uri", "url_key", "width", "height", "data_size", "file_hash", "url_expire"]), url_list: urls };
}

function portableVideo(item) {
  const video = item?.video, author = item?.author;
  if (!/^\d{5,30}$/u.test(item?.aweme_id) || !author?.uid || !video || item.live_room || item.images?.length) return null;
  const play = cdnMedia(video.play_addr), cover = cdnMedia(video.cover) ?? cdnMedia(video.origin_cover);
  if (!play || !cover) return null;
  return {
    ...pick(item, ["aweme_id", "aweme_type", "create_time", "desc", "caption", "item_title", "duration"]),
    author: { ...pick(author, ["uid", "unique_id", "short_id", "sec_uid", "nickname"]), avatar_thumb: cdnMedia(author.avatar_thumb) },
    video: { ...pick(video, ["vid", "width", "height", "ratio", "duration"]), play_addr: play, cover, origin_cover: cover },
    music: pick(item.music, ["id_str", "title", "author"]),
    text_extra: (item.text_extra ?? []).map(tag => pick(tag, ["hashtag_name"])),
    video_tag: (item.video_tag ?? []).map(tag => pick(tag, ["tag_name"])),
    statistics: pick(item.statistics, ["aweme_id", "digg_count", "comment_count", "collect_count", "share_count"]),
  };
}

export async function mobileFeedProfile(settings, getApi, signal) {
  const rules = globalThis.DYF.compileRules(settings.rules);
  const words = [...new Set((settings.words ?? "").split(/\r?\n/u).map(s => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
  const profile = {
    format: "douyin-review-feed/1", createdAt: Date.now(), mode: settings.mode, pickEvery: settings.pickEvery,
    rules: rules.map(({ field, value, weight, re }) => ({ field, value, weight, ...(re && { pattern: re.source, flags: re.flags }) })),
    words, candidates: [],
  };
  if (!words.length) return profile;
  let api;
  try { api = await getApi(); }
  catch {
    signal?.throwIfAborted();
    return profile;
  }
  const seen = new Set();
  let bytes = 0;
  for (const word of words) {
    signal?.throwIfAborted();
    const state = { offset: 0, searchId: null, queue: [] };
    await searchWord(api, { rules }, word, state, signal);
    for (const raw of state.queue) {
      const video = portableVideo(raw);
      if (!video || seen.has(video.aweme_id)) continue;
      const entry = { word, video };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > 3_500_000) continue;
      bytes += size;
      seen.add(video.aweme_id);
      profile.candidates.push(entry);
    }
  }
  return profile;
}
