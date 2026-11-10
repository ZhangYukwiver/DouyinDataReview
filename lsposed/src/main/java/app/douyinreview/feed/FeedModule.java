package app.douyinreview.feed;

import android.content.SharedPreferences;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import io.github.libxposed.api.XposedModule;
import org.json.JSONObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.WeakHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class FeedModule extends XposedModule {
    private String processName;
    private final WeakHashMap<Object, Boolean> processed = new WeakHashMap<>();
    private String activeFile;
    private FeedProfile profile;
    private boolean reportedProblem;

    @Override public void onModuleLoaded(ModuleLoadedParam param) { processName = param.getProcessName(); }

    @Override public void onPackageReady(PackageReadyParam param) {
        String host = param.getPackageName();
        if (!param.isFirstPackage() || !host.equals(processName)
                || !("com.ss.android.ugc.aweme".equals(host) || "com.ss.android.ugc.aweme.lite".equals(host))) return;
        try {
            ClassLoader loader = param.getClassLoader();
            Class<?> feed = loader.loadClass("com.ss.android.ugc.aweme.feed.model.FeedItemList");
            Field items = feed.getField("items");
            if (!List.class.isAssignableFrom(items.getType())) throw new NoSuchFieldException("FeedItemList.items");
            Class<?> response = loader.loadClass("com.bytedance.retrofit2.client.Response");
            Method url = response.getMethod("getUrl");
            Method success = loader.loadClass("com.bytedance.retrofit2.SsResponse").getDeclaredMethod("success", Object.class, response);
            HostVideos videos = new HostVideos(loader);
            if (BuildConfig.BUNDLED_PROFILE) loadBundledProfile();
            SharedPreferences settings = BuildConfig.BUNDLED_PROFILE ? null : getRemotePreferences(FeedProfile.GROUP);
            hook(success).intercept(chain -> {
                Object body = chain.getArg(0);
                if (feed.isInstance(body)) {
                    try {
                        String address = (String) url.invoke(chain.getArg(1));
                        if (mainFeed(address)) apply(body, items, videos, settings);
                    } catch (Exception | LinkageError error) { report(error); }
                }
                return chain.proceed();
            });
            log(Log.INFO, "ReviewFeed", "已连接推荐页处理入口");
        } catch (Exception | LinkageError error) { report(error); }
    }

    static boolean mainFeed(String address) {
        if (address == null) return false;
        String path = URI.create(address).getPath();
        return path != null && path.matches("/aweme/v[12]/feed/?");
    }

    private void loadBundledProfile() throws Exception {
        try (ZipFile module = new ZipFile(getModuleApplicationInfo().sourceDir)) {
            ZipEntry bundled = module.getEntry("assets/review-feed.json");
            if (bundled == null) throw new java.io.FileNotFoundException("assets/review-feed.json");
            try (var in = module.getInputStream(bundled)) {
                profile = new FeedProfile(new JSONObject(new String(FeedProfile.readBytes(in), StandardCharsets.UTF_8)));
            }
        }
        log(Log.INFO, "ReviewFeed", "已载入内置配置，屏蔽规则 " + profile.rules.size() + " 条，推荐词 " + profile.words.size() + " 个");
    }

    private synchronized void apply(Object body, Field items, HostVideos videos, SharedPreferences prefs) throws Exception {
        String name = prefs == null ? null : prefs.getString(FeedProfile.ACTIVE, "");
        if (processed.containsKey(body)) return;
        if (name != null && !name.isEmpty() && !name.equals(activeFile)) {
            try (var stream = new ParcelFileDescriptor.AutoCloseInputStream(openRemoteFile(name))) {
                profile = new FeedProfile(new JSONObject(new String(FeedProfile.readBytes(stream), StandardCharsets.UTF_8)));
            }
            activeFile = name;
            reportedProblem = false;
        }
        if (profile == null) return;
        if (!(items.get(body) instanceof List<?> original) || original.isEmpty()) return;
        List<FeedProfile.Item> page = new ArrayList<>(original.size());
        for (Object model : original) page.add(videos.item(model, profile));
        List<Object> result = profile.mix(page, card -> {
            try {
                Object value = videos.decode(card);
                if (value == null) report(new IllegalArgumentException("candidate model"));
                return value;
            } catch (Exception | LinkageError error) { report(error); return null; }
        });
        if (!original.equals(result)) items.set(body, result);
        processed.put(body, true);
        int hits = 0;
        for (FeedProfile.Item item : page) if (item.matches()) hits++;
        log(Log.INFO, "ReviewFeed", "首页推荐 " + page.size() + " 条，命中 " + hits + " 条，输出 " + result.size() + " 条");
    }

    private synchronized void report(Throwable cause) {
        if (reportedProblem) return;
        reportedProblem = true;
        log(Log.WARN, "ReviewFeed", "未能处理此版本的推荐数据：" + cause.getClass().getSimpleName());
    }
}
