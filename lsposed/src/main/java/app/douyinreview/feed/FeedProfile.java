package app.douyinreview.feed;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class FeedProfile {
    static final String GROUP = "feed", ACTIVE = "active";
    static final int MAX_BYTES = 4 * 1024 * 1024;
    private static final Pattern INVISIBLE = Pattern.compile("[\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]");
    private static final Pattern SPACE = Pattern.compile("[\\s\\p{Z}]+");
    final List<Rule> rules = new ArrayList<>();
    final String mode;
    final int interval;
    final List<String> words;
    private final Map<String, ArrayDeque<JSONObject>> queues = new LinkedHashMap<>();
    private final LinkedHashSet<String> seen = new LinkedHashSet<>(), inserted = new LinkedHashSet<>();
    final int candidateCount;
    private int turn, gap;

    FeedProfile(JSONObject json) throws JSONException {
        if (!"douyin-review-feed/1".equals(json.getString("format"))) throw new JSONException("请选择桌面导出的手机配置。");
        mode = json.getString("mode");
        interval = json.getInt("pickEvery");
        if (!Arrays.asList("off", "observe", "hide", "dislike").contains(mode) || interval < 0 || interval > 10)
            throw new JSONException("配置中的过滤方式或插入频率无效。");
        JSONArray filters = json.getJSONArray("rules");
        for (int i = 0; i < filters.length(); i++) rules.add(new Rule(filters.getJSONObject(i)));
        JSONArray terms = json.getJSONArray("words");
        if (terms.length() > 20) throw new JSONException("推荐词过多。");
        for (int i = 0; i < terms.length(); i++) queues.put(terms.getString(i), new ArrayDeque<>());
        words = new ArrayList<>(queues.keySet());
        JSONArray candidates = json.getJSONArray("candidates");
        int count = 0;
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject entry = candidates.getJSONObject(i);
            ArrayDeque<JSONObject> queue = queues.get(entry.getString("word"));
            JSONObject video = PortableVideo.read(entry.getJSONObject("video"));
            if (queue != null && video != null) { queue.addLast(video); count++; }
        }
        candidateCount = count;
    }

    static byte[] readBytes(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) {
            if (out.size() + n > MAX_BYTES) throw new IOException("配置超过 4 MB。");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    static String normalize(String value) {
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKC);
        return SPACE.matcher(INVISIBLE.matcher(normalized).replaceAll("")).replaceAll(" ").toLowerCase(Locale.ROOT).trim();
    }

    static final class Rule {
        final String field, value;
        final Pattern pattern;
        final double weight;
        Rule(JSONObject json) throws JSONException {
            field = json.getString("field"); weight = json.getDouble("weight");
            value = json.optString("value", "");
            if (!Arrays.asList("any", "desc", "author", "tag", "music").contains(field) || weight <= 0 || !Double.isFinite(weight))
                throw new JSONException("配置含有无效的屏蔽规则。");
            String flags = json.optString("flags");
            int mask = (flags.contains("i") ? Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE : 0)
                    | (flags.contains("m") ? Pattern.MULTILINE : 0) | (flags.contains("s") ? Pattern.DOTALL : 0);
            pattern = json.has("pattern") ? Pattern.compile(json.getString("pattern"), mask) : null;
        }
    }

    boolean blocked(Map<String, String> fields) {
        double score = 0;
        for (Rule rule : rules) {
            String haystack = fields.get(rule.field);
            if (haystack != null && !haystack.isEmpty() &&
                    (rule.pattern == null ? haystack.contains(rule.value) : rule.pattern.matcher(haystack).find())) score += rule.weight;
        }
        return score >= 1;
    }

    record Item(Object model, String id, boolean ordinary, boolean matches) {}
    interface Decoder { Object decode(JSONObject candidate); }

    private static void remember(LinkedHashSet<String> set, String id) {
        if (id.isEmpty()) return;
        set.add(id);
        if (set.size() > 5000) set.remove(set.iterator().next());
    }

    private Object take(Set<String> pageIds, Decoder decoder) {
        for (int tried = 0; tried < words.size(); tried++) {
            String word = words.get(turn);
            turn = (turn + 1) % words.size();
            ArrayDeque<JSONObject> queue = queues.get(word);
            while (!queue.isEmpty()) {
                JSONObject candidate = queue.removeFirst();
                String id = candidate.optString("aweme_id");
                if (seen.contains(id) || pageIds.contains(id) || !PortableVideo.fresh(candidate)) continue;
                Object model = decoder.decode(candidate);
                if (model == null) continue;
                remember(inserted, id); remember(seen, id);
                return model;
            }
        }
        return null;
    }

    List<Object> mix(List<Item> page, Decoder decoder) {
        List<Item> kept = new ArrayList<>();
        Set<String> pageIds = new HashSet<>();
        boolean hide = mode.equals("hide") || mode.equals("dislike");
        for (Item item : page) {
            if ((hide && item.matches()) || inserted.contains(item.id())) continue;
            kept.add(item);
            if (interval > 0) pageIds.add(item.id());
        }
        List<Object> output = new ArrayList<>();
        for (Item item : kept) {
            if (!item.ordinary() || words.isEmpty()) {
                output.add(item.model()); remember(seen, item.id()); continue;
            }
            if (interval == 0) {
                Object pick = take(pageIds, decoder);
                if (pick != null) { output.add(pick); continue; }
                if (inserted.contains(item.id())) continue;
            }
            output.add(item.model()); remember(seen, item.id());
            if (interval > 0 && ++gap >= interval) {
                gap = interval;
                Object pick = take(pageIds, decoder);
                if (pick != null) { output.add(pick); gap = 0; }
            }
        }
        return output;
    }
}
