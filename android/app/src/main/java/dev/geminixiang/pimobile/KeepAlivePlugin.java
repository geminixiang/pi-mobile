package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Web-side control of AgentService, completion notifications, and the permissions they need. */
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class KeepAlivePlugin extends Plugin {

    private static final int DONE_NOTIFICATION_ID = 2;

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), AgentService.class)
            .putExtra(AgentService.EXTRA_TEXT, call.getString("text", ""))
            .putExtra(AgentService.EXTRA_TITLE, call.getString("title", "pi 工作中"));
        getContext().startForegroundService(intent);
        setRendererImportant(true);
        call.resolve();
    }

    /**
     * The WebView's JavaScript runs in Chromium's renderer process, not in the app process the foreground service
     * protects. By default Chromium waives the renderer's importance when the WebView is not visible, so in the
     * background Android caches and freezes it and the agent loop stops even though the app process lives on. And
     * Chromium itself freezes a page hidden for a minute; PiWebView keeps it visible to Chromium while the agent works.
     */
    private void setRendererImportant(boolean important) {
        getActivity().runOnUiThread(() -> keepWebViewRunning(getBridge().getWebView(), important));
    }

    static void keepWebViewRunning(WebView webView, boolean on) {
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !on);
        PiWebView.keepRunning(webView, on);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), AgentService.class));
        setRendererImportant(false);
        call.resolve();
    }

    /** A dismissable notification, for "done" or "needs your approval" while the app is not in front. */
    @PluginMethod
    public void notify(PluginCall call) {
        AgentService.createChannels(getContext());
        Notification notification = new Notification.Builder(getContext(), AgentService.CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(call.getString("title", "pi"))
            .setContentText(call.getString("text", ""))
            .setStyle(new Notification.BigTextStyle().bigText(call.getString("text", "")))
            .setContentIntent(AgentService.openApp(getContext()))
            .setAutoCancel(true)
            .build();
        getContext().getSystemService(NotificationManager.class).notify(DONE_NOTIFICATION_ID, notification);
        call.resolve();
    }

    @PluginMethod
    public void clearNotification(PluginCall call) {
        getContext().getSystemService(NotificationManager.class).cancel(DONE_NOTIFICATION_ID);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        PowerManager power = getContext().getSystemService(PowerManager.class);
        JSObject result = new JSObject();
        result.put("notifications", notificationsAllowed());
        result.put("unrestrictedBattery", power.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (notificationsAllowed()) {
            call.resolve(granted(true));
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        call.resolve(granted(getPermissionState("notifications") == PermissionState.GRANTED));
    }

    /** Opens the system dialog that exempts the app from battery optimization (Samsung otherwise sleeps it). */
    @PluginMethod
    public void requestUnrestrictedBattery(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static JSObject granted(boolean value) {
        JSObject result = new JSObject();
        result.put("granted", value);
        return result;
    }
}
