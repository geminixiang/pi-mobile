package dev.geminixiang.pimobile;

import android.content.Intent;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.File;

public class MainActivity extends BridgeActivity {

    static final String EXTRA_QUIET = "dev.geminixiang.pimobile.QUIET";
    private static final String KEPT_RUNNING = "keptRunning";
    private boolean restoring;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        restoring = savedInstanceState != null;
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(AppsPlugin.class);
        registerPlugin(CalendarPlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(TriggersPlugin.class);
        registerPlugin(NotificationsPlugin.class);
        registerPlugin(DatabasePlugin.class);
        registerPlugin(LoopbackPlugin.class);
        registerPlugin(StreamFetchPlugin.class);
        registerPlugin(ContactsPlugin.class);
        registerPlugin(PhotosPlugin.class);
        registerPlugin(RecordsPlugin.class);
        registerPlugin(UsagePlugin.class);
        registerPlugin(ScannerPlugin.class);
        registerPlugin(HealthPlugin.class);
        registerPlugin(BotFilesPlugin.class);
        registerPlugin(PagePlugin.class);
        registerPlugin(BrowserPlugin.class);
        registerPlugin(PhoneScreenPlugin.class);
        registerPlugin(PhoneStatePlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return reloadAfterRenderer(view, detail);
            }
        });
        restoring = false;
        if (savedInstanceState != null && savedInstanceState.getBoolean(KEPT_RUNNING)) KeepAlivePlugin.keepWebViewRunning(getBridge().getWebView(), true);
        removeSshKey();
        removeOldCaptures();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        goQuietIfAsked(intent);
    }

    @Override
    public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean(KEPT_RUNNING, getBridge().getWebView() instanceof PiWebView web && web.getKeepRunning());
    }

    private void goQuietIfAsked(Intent intent) {
        if (restoring || !intent.getBooleanExtra(EXTRA_QUIET, false)) return;
        KeepAlivePlugin.keepWebViewRunning(getBridge().getWebView(), true);
        moveTaskToBack(true);
    }

    private boolean reloadAfterRenderer(WebView view, RenderProcessGoneDetail detail) {
        if (!(view instanceof PiWebView web) || !web.getRunning()) return false;
        Log.w("PiWatchdog", "the page's renderer is gone: loading the app again");
        DeviceLog.INSTANCE.event(this, "error", "renderer.gone", detail.didCrash() ? "it crashed" : "the system or the watchdog ended it");
        recreate();
        return true;
    }

    private static final long CAPTURE_KEPT_MS = 24 * 60 * 60 * 1000L;

    private void removeOldCaptures() {
        File dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - CAPTURE_KEPT_MS;
        for (File file : files) if (file.getName().startsWith("JPEG_") && file.lastModified() < cutoff) file.delete();
    }

    private void removeSshKey() {
        File dir = new File(getFilesDir(), "ssh");
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) file.delete();
        dir.delete();
    }
}
