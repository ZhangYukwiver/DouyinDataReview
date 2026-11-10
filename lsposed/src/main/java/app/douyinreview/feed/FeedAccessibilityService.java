package app.douyinreview.feed;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

public final class FeedAccessibilityService extends AccessibilityService {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable check = this::inspect;
    private FeedProfile lastProfile;
    private String lastCard = "";
    private boolean swiping, scheduled;

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        SettingsApp app = (SettingsApp) getApplication();
        app.accessibilityConnected = true;
        app.notifyView();
        schedule();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { schedule(); }

    private void schedule() {
        if (!swiping && !scheduled) scheduled = main.postDelayed(check, 250);
    }

    private void inspect() {
        scheduled = false;
        SettingsApp app = (SettingsApp) getApplication();
        FeedProfile profile = app.activeProfile;
        if (profile == null || profile.rules.isEmpty() || profile.mode.equals("off")) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            String host = String.valueOf(root.getPackageName());
            if (!host.equals("com.ss.android.ugc.aweme.lite") && !host.equals("com.ss.android.ugc.aweme")) return;
            Card card = new Card();
            card.read(root);
            if (!card.home || !card.recommended || !card.player || card.editor ||
                    (card.caption.isEmpty() && card.author.isEmpty())) return;
            String identity = card.author + "\n" + card.caption;
            if (lastProfile == profile && identity.equals(lastCard)) return;
            lastProfile = profile;
            lastCard = identity;
            if (!profile.blocked(card.fields())) return;
            app.observed++;
            app.notifyView();
            if (profile.mode.equals("observe")) return;
            Rect bounds = new Rect();
            root.getBoundsInScreen(bounds);
            if (!bounds.isEmpty()) swipe(bounds, app);
        } finally { root.recycle(); }
    }

    private void swipe(Rect bounds, SettingsApp app) {
        Path path = new Path();
        path.moveTo(bounds.exactCenterX(), bounds.top + bounds.height() * 0.69f);
        path.lineTo(bounds.exactCenterX(), bounds.top + bounds.height() * 0.29f);
        var gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 230)).build();
        swiping = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription completed) {
                swiping = false;
                app.skipped++;
                Log.i("ReviewFeedHelper", "规则命中，已完成上划手势");
                app.notifyView();
                schedule();
            }
            @Override public void onCancelled(GestureDescription cancelled) { swiping = false; }
        }, main);
    }

    private static final class Card {
        private static final Pattern TAG = Pattern.compile("#([^\\s#，。！？、]+)");
        String author = "", caption = "";
        boolean home, recommended, player, editor;
        int nodes;

        void read(AccessibilityNodeInfo node) {
            if (++nodes > 420 || !node.isVisibleToUser()) return;
            String id = node.getViewIdResourceName();
            String text = node.getText() == null ? "" : node.getText().toString().trim();
            String label = node.getContentDescription() == null ? "" : node.getContentDescription().toString();
            home |= text.equals("首页") || label.startsWith("首页，按钮");
            recommended |= label.startsWith("推荐，已选中") || (text.equals("推荐") && node.isSelected());
            player |= label.startsWith("暂停视频") || label.startsWith("播放视频");
            editor |= node.isEditable();
            if (id != null) {
                if (id.endsWith(":id/desc") && !text.isEmpty()) caption = text;
                if (id.endsWith(":id/user_avatar") && !label.isEmpty()) author = label;
                if (author.isEmpty() && id.endsWith(":id/title") && text.startsWith("@")) author = text.substring(1);
            }
            for (int i = 0; i < node.getChildCount() && nodes < 420; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) {
                    try { read(child); }
                    finally { child.recycle(); }
                }
            }
        }

        Map<String,String> fields() {
            String desc = FeedProfile.normalize(caption);
            var tags = new StringBuilder();
            var matcher = TAG.matcher(desc);
            while (matcher.find()) tags.append(matcher.group(1)).append(' ');
            var fields = new HashMap<String,String>();
            fields.put("desc", desc);
            fields.put("tag", tags.toString().trim());
            fields.put("author", FeedProfile.normalize(author));
            fields.put("any", desc + " " + fields.get("author"));
            return fields;
        }
    }

    @Override public void onInterrupt() { main.removeCallbacks(check); scheduled = false; }

    @Override public void onDestroy() {
        main.removeCallbacks(check);
        SettingsApp app = (SettingsApp) getApplication();
        app.accessibilityConnected = false;
        app.notifyView();
        super.onDestroy();
    }
}
