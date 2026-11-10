package app.douyinreview.feed;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.net.URI;
import java.util.regex.Pattern;

// Import only a video card. Unknown JSON properties never reach the host model.
final class PortableVideo {
    private static final Pattern CDN = Pattern.compile("(?i)(?:[a-z0-9-]+\\.)*(?:douyinvod|byteimg|douyinpic|douyinstatic|amemv|iesdouyin|douyin|zjcdn|pstatp|bytedance|bytecdn|bytecdntp|ixigua)\\.com");

    static JSONObject read(JSONObject raw) throws JSONException {
        JSONObject author = raw.optJSONObject("author"), video = raw.optJSONObject("video");
        String id = raw.optString("aweme_id");
        if (!id.matches("[0-9]{5,30}") || author == null || author.optString("uid").isEmpty() || video == null) return null;
        JSONObject play = media(video.optJSONObject("play_addr")), cover = media(video.optJSONObject("cover"));
        if (play == null || cover == null) return null;
        JSONObject card = fields(raw, "aweme_id", "aweme_type", "create_time", "desc", "caption", "item_title", "duration");
        JSONObject user = fields(author, "uid", "unique_id", "short_id", "sec_uid", "nickname");
        card.put("author", user.put("avatar_thumb", media(author.optJSONObject("avatar_thumb"))));
        card.put("video", fields(video, "vid", "width", "height", "ratio", "duration")
                .put("play_addr", play).put("cover", cover).put("origin_cover", cover));
        card.put("music", fields(raw.optJSONObject("music"), "id_str", "title", "author"));
        card.put("statistics", fields(raw.optJSONObject("statistics"), "aweme_id", "digg_count", "comment_count", "collect_count", "share_count"));
        card.put("text_extra", tags(raw.optJSONArray("text_extra"), "hashtag_name"));
        card.put("video_tag", tags(raw.optJSONArray("video_tag"), "tag_name"));
        return card;
    }

    private static JSONObject fields(JSONObject object, String... keys) throws JSONException {
        JSONObject result = new JSONObject();
        if (object != null) for (String key : keys) {
            Object value = object.opt(key);
            if (value instanceof String || value instanceof Number) result.put(key, value);
        }
        return result;
    }

    private static JSONArray tags(JSONArray input, String key) throws JSONException {
        JSONArray list = new JSONArray();
        if (input != null) for (int i = 0; i < Math.min(30, input.length()); i++)
            list.put(fields(input.optJSONObject(i), key));
        return list;
    }

    private static JSONObject media(JSONObject object) throws JSONException {
        if (object == null) return null;
        JSONArray urls = object.optJSONArray("url_list"), safe = new JSONArray();
        if (urls != null) for (int i = 0; i < Math.min(3, urls.length()); i++) {
            try {
                URI url = URI.create(urls.getString(i));
                if ("https".equals(url.getScheme()) && url.getHost() != null && CDN.matcher(url.getHost()).matches()
                        && url.getUserInfo() == null && url.getPort() == -1) safe.put(url.toString());
            } catch (IllegalArgumentException ignored) { }
        }
        return safe.length() == 0 ? null : fields(object, "uri", "url_key", "width", "height", "data_size", "file_hash", "url_expire").put("url_list", safe);
    }

    static boolean fresh(JSONObject candidate) {
        long expires = candidate.optJSONObject("video").optJSONObject("play_addr").optLong("url_expire");
        if (expires > 0 && expires < 10_000_000_000L) expires *= 1000L;
        return expires <= 0 || expires > System.currentTimeMillis();
    }
}
