package app.douyinreview.feed;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class FeedProfileTest {
    private static JSONObject candidate(String id, String word) throws Exception {
        JSONObject media = new JSONObject().put("url_list", new JSONArray().put("https://cdn.douyinvod.com/test"));
        JSONObject video = new JSONObject().put("aweme_id", id).put("author", new JSONObject().put("uid", "1"))
                .put("video", new JSONObject().put("play_addr", media).put("cover", media));
        return new JSONObject().put("word", word).put("video", video);
    }
    private static JSONObject profile(int every) throws Exception {
        return new JSONObject().put("format", "douyin-review-feed/1").put("mode", "hide").put("pickEvery", every)
                .put("words", new JSONArray(List.of("咖啡", "摄影"))).put("rules", new JSONArray()).put("candidates",
                        new JSONArray().put(candidate("90001", "咖啡")).put(candidate("90002", "摄影")).put(candidate("90003", "咖啡")));
    }
    private static FeedProfile.Item item(String id) { return new FeedProfile.Item(id, id, true, false); }
    private static final FeedProfile.Decoder IDS = obj -> obj.optString("aweme_id");

    @Test public void mixesAcrossPagesAfterVisibleOriginalsAndRotatesTerms() throws Exception {
        FeedProfile p = new FeedProfile(profile(2));
        assertEquals(List.of("10001"), p.mix(List.of(item("10001"), new FeedProfile.Item("ad", "ad", false, true)), IDS));
        assertEquals(List.of("10002", "90001", "10003", "10004", "90002"), p.mix(List.of(item("10002"), item("10003"), item("10004")), IDS));
        assertEquals(List.of("10005", "10006", "90003"), p.mix(List.of(item("90001"), item("10005"), item("10006")), IDS));
    }
    @Test public void replacesOnlyPlayableSlotsWithValidUniqueCandidates() throws Exception {
        FeedProfile p = new FeedProfile(profile(0));
        assertEquals(List.of("90001", "90003", "10003"), p.mix(List.of(item("10001"), item("10002"), item("10003")),
                obj -> obj.optString("aweme_id").equals("90002") ? null : IDS.decode(obj)));
        assertEquals(List.of("10004"), p.mix(List.of(item("90001"), item("10004")), IDS));
        FeedProfile regular = new FeedProfile(profile(1));
        assertEquals(List.of("10001", "90003", "90001", "90002"), regular.mix(List.of(item("10001"), item("90001")), IDS));
    }
    @Test public void compiledRulesUseTheSameNormalizedFieldsAndWeights() throws Exception {
        JSONObject rules = profile(3).put("rules", new JSONArray()
                .put(new JSONObject().put("field", "desc").put("value", "abc").put("weight", .4))
                .put(new JSONObject().put("field", "author").put("pattern", "^c.t$").put("flags", "i").put("weight", .6)));
        FeedProfile p = new FeedProfile(rules);
        String desc = FeedProfile.normalize(" Ａ\u200bＢＣ ");
        assertTrue(p.blocked(Map.of("desc", desc, "author", "cat")));
        assertFalse(p.blocked(Map.of("desc", desc, "author", "other")));
    }
    @Test public void invalidOrExpiredMediaCannotBecomeAPick() throws Exception {
        JSONObject card = candidate("90001", "咖啡").getJSONObject("video");
        JSONObject addr = card.getJSONObject("video").getJSONObject("play_addr");
        addr.put("url_expire", 1_000_000);
        assertFalse(PortableVideo.fresh(PortableVideo.read(card)));
        addr.put("url_list", new JSONArray().put("https://127.0.0.1/test").put("file:///test"));
        assertNull(PortableVideo.read(card));
    }
}
