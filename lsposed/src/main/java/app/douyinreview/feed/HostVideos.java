package app.douyinreview.feed;

import org.json.JSONObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;

final class HostVideos {
    final Class<?> aweme;
    private final Map<Class<?>, Map<String, Object>> readers = new HashMap<>();
    private final ClassLoader loader;
    private Object gson;
    private Method fromJson;

    HostVideos(ClassLoader loader) throws ClassNotFoundException {
        this.loader = loader;
        aweme = loader.loadClass("com.ss.android.ugc.aweme.feed.model.Aweme");
    }

    private Object read(Object obj, String... names) throws ReflectiveOperationException {
        if (obj == null) return null;
        Class<?> type = obj.getClass();
        Map<String, Object> members = readers.computeIfAbsent(type, unused -> new HashMap<>());
        for (String name : names) {
            if (!members.containsKey(name)) {
                Object member = null;
                try { member = type.getMethod(name); }
                catch (NoSuchMethodException ignored) {
                    try { member = type.getField(name); } catch (NoSuchFieldException absent) { }
                }
                members.put(name, member);
            }
            Object member = members.get(name);
            Object value = member instanceof Method m ? m.invoke(obj) : member instanceof Field f ? f.get(obj) : null;
            if (value != null) return value;
        }
        return null;
    }

    private String text(Object value) { return value instanceof String || value instanceof Number ? value.toString() : ""; }
    private String tags(Object array, String getter, String field) throws ReflectiveOperationException {
        StringBuilder out = new StringBuilder();
        if (array instanceof Iterable<?> values)
            for (Object value : values) out.append(' ').append(text(read(value, getter, field)));
        return out.toString();
    }

    FeedProfile.Item item(Object model, FeedProfile profile) throws ReflectiveOperationException {
        if (!aweme.isInstance(model)) return new FeedProfile.Item(model, "", false, false);
        String id = text(read(model, "getAid", "aid"));
        if (id.isEmpty()) throw new NoSuchFieldException("Aweme.aid");
        Object adFlag = read(model, "getIsAdAweme", "getAd", "isAd");
        boolean ad = Boolean.TRUE.equals(adFlag) || Integer.valueOf(1).equals(adFlag);
        boolean ordinary = !ad && !Boolean.TRUE.equals(read(model, "isLive")) && read(model, "getVideo", "video") != null;
        if (profile.rules.isEmpty() || profile.mode.equals("off")) return new FeedProfile.Item(model, id, ordinary, ad);
        Object author = read(model, "getAuthor", "author"), music = read(model, "getMusic", "music");
        Map<String, String> fields = new HashMap<>();
        fields.put("desc", FeedProfile.normalize(String.join(" ", text(read(model, "getDesc", "desc")),
                text(read(model, "getCaption", "caption")), text(read(model, "getItemTitle", "itemTitle")))));
        fields.put("author", FeedProfile.normalize(String.join(" ", text(read(author, "getNickname", "nickname")),
                text(read(author, "getUniqueId", "uniqueId")), text(read(author, "getShortId", "shortId")), text(read(author, "getUid", "uid")))));
        fields.put("tag", FeedProfile.normalize(tags(read(model, "getTextExtra", "textExtra"), "getHashTagName", "hashTagName")
                + tags(read(model, "getVideoTag", "videoTag"), "getTagName", "tagName")));
        fields.put("music", FeedProfile.normalize(text(read(music, "getMusicName", "getTitle", "musicName"))));
        fields.put("any", String.join(" ", fields.get("desc"), fields.get("author"), fields.get("tag"), fields.get("music")));
        return new FeedProfile.Item(model, id, ordinary, ad || profile.blocked(fields));
    }

    Object decode(JSONObject card) throws ReflectiveOperationException {
        if (fromJson == null) {
            try {
                fromJson = loader.loadClass("com.ss.android.ugc.aweme.utils.GsonUtil").getMethod("fromJson", String.class, Class.class);
            } catch (ClassNotFoundException | NoSuchMethodException missingHelper) {
                Class<?> type = loader.loadClass("com.google.gson.Gson");
                gson = type.getConstructor().newInstance();
                fromJson = type.getMethod("fromJson", String.class, Class.class);
            }
        }
        Object model = fromJson.invoke(gson, card.toString(), aweme);
        if (!aweme.isInstance(model) || !card.optString("aweme_id").equals(text(read(model, "getAid", "aid")))) return null;
        Object video = read(model, "getVideo", "video"), play = read(video, "getPlayAddr", "playAddr");
        Object urls = read(play, "getUrlList", "urlList");
        return read(model, "getAuthor", "author") != null && urls instanceof java.util.List<?> list && !list.isEmpty() ? model : null;
    }
}
