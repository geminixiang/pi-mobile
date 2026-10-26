package dev.geminixiang.pimobile;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "Triggers",
    permissions = {
        @Permission(strings = { "android.permission.BLUETOOTH_CONNECT" }, alias = "bluetooth"),
        @Permission(strings = { "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION" }, alias = "location"),
        @Permission(strings = { "android.permission.ACCESS_BACKGROUND_LOCATION" }, alias = "background"),
        @Permission(strings = { "android.permission.READ_MEDIA_IMAGES" }, alias = "photos"),
        @Permission(strings = { "android.permission.ACTIVITY_RECOGNITION" }, alias = "activity")
    }
)
public class TriggersPlugin extends Plugin {

    private static final String TAG = "PiTriggers";
    private static final long MAX_SHARED_BYTES = 20L * 1024 * 1024;

    private static volatile TriggersPlugin live;

    static TriggersPlugin live() {
        return live;
    }

    void announce() {
        notifyListeners("event", new JSObject(), true);
    }

    static boolean inFront(android.app.Activity activity) {
        return activity instanceof androidx.lifecycle.LifecycleOwner
            && ((androidx.lifecycle.LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED);
    }

    static int waitingNotificationId(String triggerId) {
        return 0x1000 + (triggerId.hashCode() & 0xfff);
    }

    private static int proactiveNotificationId(String key) {
        return 0x3000 + (key.hashCode() & 0xfff);
    }

    @Override
    public void load() {
        live = this;
        receiveShare(getActivity().getIntent());
        WhileRunningTriggers.listen(getContext());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        receiveShare(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        super.handleOnDestroy();
    }

    void wake(String text) {
        try {
            getContext().startForegroundService(new Intent(getContext(), AgentService.class).putExtra(AgentService.EXTRA_TEXT, text));
        } catch (RuntimeException error) {
            Log.w(TAG, "could not start the foreground service", error);
        }
        getActivity().runOnUiThread(() -> KeepAlivePlugin.keepWebViewRunning(getBridge().getWebView(), true));
        notifyListeners("event", new JSObject(), true);
    }

    @PluginMethod
    public void sync(PluginCall call) {
        JSArray schedules = call.getArray("schedules", new JSArray());
        JSONObject next = TriggerStore.replaceSchedules(getContext(), schedules);
        JSObject result = new JSObject();
        result.put("next", next);
        call.resolve(result);
    }

    @PluginMethod
    public void events(PluginCall call) {
        JSObject result = new JSObject();
        result.put("events", TriggerStore.events(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void ack(PluginCall call) {
        Set<String> ids = new HashSet<>();
        JSArray list = call.getArray("ids", new JSArray());
        for (int i = 0; i < list.length(); i++) ids.add(list.optString(i));
        TriggerStore.ack(getContext(), ids);
        call.resolve();
    }

    @PluginMethod
    public void started(PluginCall call) {
        String trigger = call.getString("trigger", "");
        getContext().getSystemService(NotificationManager.class).cancel(waitingNotificationId(trigger));
        call.resolve();
    }

    @PluginMethod
    public void skipped(PluginCall call) {
        TriggerStore.giveBackGap(getContext(), call.getString("trigger", ""));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        AlarmManager alarms = getContext().getSystemService(AlarmManager.class);
        JSObject result = new JSObject();
        result.put("exactAlarms", alarms.canScheduleExactAlarms());
        result.put("bluetooth", bluetoothGranted());
        call.resolve(result);
    }

    private boolean bluetoothGranted() {
        return getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void requestLocationAlways(PluginCall call) {
        if (TriggerEvents.backgroundLocation(getContext())) {
            locationResult(call);
            return;
        }
        if (!inFront(getActivity())) {
            call.reject("pi cannot ask for location while it is in the background. Ask the user to open pi.");
            return;
        }
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) requestPermissionForAlias("location", call, "foregroundResult");
        else requestPermissionForAlias("background", call, "locationResult");
    }

    @PermissionCallback
    private void foregroundResult(PluginCall call) {
        if (getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED) requestPermissionForAlias("background", call, "locationResult");
        else locationResult(call);
    }

    @PermissionCallback
    private void locationResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("foreground", getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED);
        result.put("background", TriggerEvents.backgroundLocation(getContext()));
        call.resolve(result);
        TriggerStore.armAll(getContext());
    }

    @PluginMethod
    public void requestBluetooth(PluginCall call) {
        if (bluetoothGranted()) {
            bluetoothResult(call);
            return;
        }
        if (!inFront(getActivity())) {
            call.reject("pi cannot ask for the Bluetooth permission while it is in the background. Ask the user to open pi.");
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothResult");
    }

    @PermissionCallback
    private void bluetoothResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", bluetoothGranted());
        call.resolve(result);
    }

    private boolean granted(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        String to = call.getString("to", "");
        if (!"photos".equals(to) && !"activity".equals(to)) {
            call.reject("unknown access " + to);
            return;
        }
        if (granted(to)) {
            accessResult(call);
            return;
        }
        if (!inFront(getActivity())) {
            call.reject("pi cannot ask for this permission while it is in the background. Ask the user to open pi.");
            return;
        }
        requestPermissionForAlias(to, call, "accessResult");
    }

    @PermissionCallback
    private void accessResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", granted(call.getString("to", "")));
        call.resolve(result);
        if (result.optBoolean("granted")) TriggerStore.armAll(getContext());
    }

    @PluginMethod
    public void simulateHeadphones(PluginCall call) {
        if (!getBridge().getConfig().isWebContentsDebuggingEnabled()) {
            call.reject("only in development builds");
            return;
        }
        Intent intent = new Intent(getContext(), TriggerReceiver.class)
            .setAction(TriggerStore.ACTION_TEST_HEADPHONES)
            .putExtra(TriggerStore.EXTRA_DEVICE, call.getString("device", "測試耳機"));
        PendingIntent pending = PendingIntent.getBroadcast(getContext(), 1, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        long at = System.currentTimeMillis() + Math.max(0, call.getInt("delayMs", 0));
        AlarmManager alarms = getContext().getSystemService(AlarmManager.class);
        if (alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        call.resolve();
    }

    @PluginMethod
    public void requestExactAlarms(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String conversation = call.getString("conversation", "");
        AgentService.createChannels(getContext());
        String text = call.getString("text", "");
        Notification notification = new Notification.Builder(getContext(), AgentService.CHANNEL_PROACTIVE)
            .setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(AgentService.avatar(getContext(), call.getString("avatar")))
            .setContentTitle(call.getString("title", "pi"))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(openConversation(conversation))
            .setAutoCancel(true)
            .build();
        getContext().getSystemService(NotificationManager.class).notify(proactiveNotificationId(conversation), notification);
        call.resolve();
    }

    private PendingIntent openConversation(String conversation) {
        if (conversation.isEmpty()) return AgentService.openApp(getContext());
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("pimobile://open?conversation=" + Uri.encode(conversation)), getContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getContext(), conversation.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void receiveShare(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        intent.setAction(Intent.ACTION_MAIN);
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String sharedType = intent.getType();
        List<Uri> streams = sharedStreams(intent);
        new Thread(() -> {
            JSObject event = new JSObject();
            event.put("kind", "share");
            if (text != null) event.put("text", text);
            if (subject != null) event.put("subject", subject);
            JSArray files = new JSArray();
            for (Uri stream : streams) {
                File copy = copyShared(stream);
                if (copy == null) continue;
                String type = getContext().getContentResolver().getType(stream);
                JSObject file = new JSObject();
                file.put("path", copy.getAbsolutePath());
                file.put("name", displayName(stream));
                file.put("mimeType", type != null ? type : sharedType != null ? sharedType : "");
                files.put(file);
            }
            if (files.length() > 0) event.put("files", files);
            TriggerStore.enqueue(getContext(), event);
            notifyListeners("event", new JSObject(), true);
        }).start();
    }

    private static List<Uri> sharedStreams(Intent intent) {
        List<Uri> streams = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            if (many != null) streams.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            if (one != null) streams.add(one);
        }
        return streams;
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException error) {
            Log.w(TAG, "could not read the shared file's name", error);
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "shared";
    }

    private File copyShared(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        File target = new File(TriggerStore.inbox(getContext()), UUID.randomUUID().toString());
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) return null;
            try (OutputStream output = new FileOutputStream(target)) {
                copyLimited(input, output);
            }
            return target;
        } catch (IOException | SecurityException error) {
            Log.w(TAG, "could not copy the shared file", error);
            if (target.exists() && !target.delete()) Log.w(TAG, "could not delete " + target);
            return null;
        }
    }

    private static void copyLimited(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int count;
        while ((count = input.read(buffer)) > 0) {
            total += count;
            if (total > MAX_SHARED_BYTES) throw new IOException("shared file is larger than " + MAX_SHARED_BYTES + " bytes");
            output.write(buffer, 0, count);
        }
    }
}
