package app.douyinreview.feed;

import android.app.Application;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.util.AtomicFile;
import io.github.libxposed.service.XposedService;
import io.github.libxposed.service.XposedServiceHelper;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SettingsApp extends Application {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private XposedService service;
    private AtomicFile local;
    volatile String connection = "";
    volatile FeedProfile activeProfile;
    boolean accessibilityConnected;
    int observed, skipped;
    volatile String summary = "尚未导入手机配置";
    Runnable listener;

    @Override public void onCreate() {
        super.onCreate();
        local = new AtomicFile(new File(getFilesDir(), "feed.json"));
        worker.execute(() -> { if (local.getBaseFile().exists()) restore(false); });
        XposedServiceHelper.registerListener(new XposedServiceHelper.OnServiceListener() {
            public void onServiceBind(XposedService value) {
                worker.execute(() -> {
                    service = value;
                    connection = "LSPosed 已连接。请确认作用域已勾选你使用的抖音或抖音极速版。";
                    if (local.getBaseFile().exists()) restore(true);
                    notifyView();
                });
            }
            public void onServiceDied(XposedService value) {
                worker.execute(() -> {
                    if (service == value) { service = null; connection = "LSPosed 连接已断开。"; notifyView(); }
                });
            }
        });
    }

    void importFile(Uri uri) {
        worker.execute(() -> {
            try (InputStream stream = getContentResolver().openInputStream(uri)) {
                if (stream == null) throw new IOException("文件无法打开");
                byte[] bytes = FeedProfile.readBytes(stream);
                var profile = parse(bytes);
                FileOutputStream output = local.startWrite();
                try { output.write(bytes); local.finishWrite(output); }
                catch (IOException error) { local.failWrite(output); throw error; }
                setProfile(profile);
                if (service != null) publish(bytes);
            } catch (Exception error) { summary = "配置导入或同步失败：" + error.getMessage(); }
            notifyView();
        });
    }

    private void restore(boolean sync) {
        try (InputStream stream = local.openRead()) {
            byte[] bytes = FeedProfile.readBytes(stream);
            setProfile(parse(bytes));
            if (sync) publish(bytes);
        } catch (Exception error) { summary = "配置读取或同步失败：" + error.getMessage(); }
        notifyView();
    }

    private FeedProfile parse(byte[] bytes) throws Exception {
        return new FeedProfile(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
    }

    private void setProfile(FeedProfile profile) {
        activeProfile = profile;
        String frequency = profile.interval == 0 ? "只看词条" : "每 " + profile.interval + " 条推荐插 1 条";
        String mode = switch (profile.mode) {
            case "off" -> "关闭"; case "observe" -> "只记录"; default -> "隐藏";
        };
        summary = "屏蔽规则 " + profile.rules.size() + " 条 · " + mode + "\n框架模式推荐词 " + profile.words.size()
                + " 个 · " + frequency + "\n已导入候选视频 " + profile.candidateCount + " 条";
    }

    private void publish(byte[] bytes) throws IOException {
        SharedPreferences settings = service.getRemotePreferences(FeedProfile.GROUP);
        String previous = settings.getString(FeedProfile.ACTIVE, "");
        // 先完整写新文件，再切换指针。正在刷视频的进程始终能读到一份完整配置。
        StringBuilder key = new StringBuilder("feed-");
        try {
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) key.append(String.format("%02x", b & 255));
        } catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        String name = key + ".json";
        if (name.equals(previous)) {
            connection = "配置已同步至 LSPosed。";
            return;
        }
        try {
            try (var out = new ParcelFileDescriptor.AutoCloseOutputStream(service.openRemoteFile(name))) {
                out.write(bytes); out.getFD().sync();
            }
            if (!settings.edit().putString(FeedProfile.ACTIVE, name).commit()) throw new IOException("框架未确认配置更新");
        } catch (IOException | RuntimeException error) { service.deleteRemoteFile(name); throw error; }
        if (previous != null && previous.startsWith("feed-")) service.deleteRemoteFile(previous);
        connection = "配置已交给 LSPosed。首次启用后请重新打开抖音，之后新配置对下一批首页推荐生效。";
    }

    void notifyView() { main.post(() -> { if (listener != null) listener.run(); }); }
}
