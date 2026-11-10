package app.douyinreview.feed;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class SettingsActivity extends Activity {
    private TextView connection, summary;
    private SettingsApp app;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        app = (SettingsApp) getApplication();
        var scroll = new ScrollView(this);
        scroll.setFitsSystemWindows(true);
        var body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        int space = Math.round(20 * getResources().getDisplayMetrics().density);
        body.setPadding(space, space, space, space);
        connection = new TextView(this);
        connection.setTextSize(16);
        body.addView(connection);
        summary = new TextView(this);
        summary.setTextSize(18);
        summary.setPadding(0, space, 0, space);
        body.addView(summary);
        var accessibility = new Button(this);
        accessibility.setText("设置自动划走");
        accessibility.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        body.addView(accessibility);
        var button = new Button(this);
        button.setText("导入手机配置");
        button.setOnClickListener(view -> {
            var intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            startActivityForResult(intent, 1);
        });
        body.addView(button);
        var help = new TextView(this);
        help.setPadding(0, space, 0, 0);
        help.setText("保留官方抖音时，在系统无障碍设置中开启「推荐流自动划走」。助手在推荐页匹配可见的作者、文案和话题；「只记录」模式只统计命中。按频率插入视频需要框架模式。\n\n规则来自桌面端「设置 → 推荐流 → 导出手机配置」。更新规则后重新导入即可。");
        body.addView(help);
        scroll.addView(body);
        setContentView(scroll);
    }

    @Override protected void onStart() {
        super.onStart();
        app.listener = () -> {
            String status = app.accessibilityConnected ? "自动划走已开启" : "自动划走未开启";
            if (app.observed > 0) status += " · 本次运行命中 " + app.observed + " 条，完成上划 " + app.skipped + " 次";
            connection.setText(app.connection.isEmpty() ? status : status + "\n" + app.connection);
            summary.setText(app.summary);
        };
        app.listener.run();
    }
    @Override protected void onStop() { app.listener = null; super.onStop(); }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 1 && result == RESULT_OK && data != null && data.getData() != null) app.importFile(data.getData());
    }
}
