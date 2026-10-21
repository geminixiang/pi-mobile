package dev.geminixiang.pimobile;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Web-side access to triggers: mirror the schedules, take and acknowledge queued events, post proactive and approval
 * notifications, and receive what other apps share with pi. Events are announced with the "event" listener; the
 * listener carries nothing, the web side reads the queue.
 */
@CapacitorPlugin(
    name = "Triggers",
    // Android 12 and later deliver Bluetooth connection broadcasts only with it; earlier versions need no prompt.
    permissions = { @Permission(strings = { "android.permission.BLUETOOTH_CONNECT" }, alias = "bluetooth") }
)
public class TriggersPlugin extends Plugin {

    private static final String TAG = "PiTriggers";
    /** Shared files larger than this are refused, so a video shared by mistake does not fill the WebView's memory. */
    private static final long MAX_SHARED_BYTES = 20L * 1024 * 1024;
    private static final long APPROVAL_TIMEOUT_MS = 30 * 60 * 1000L;

    private static volatile TriggersPlugin live;

    /** The plugin of a running WebView, or null when there is none (the process was started for a broadcast). */
    static TriggersPlugin live() {
        return live;
    }

    /** Whether the user is looking at pi: a permission dialog asked from the background would wait unseen. */
    static boolean inFront(android.app.Activity activity) {
        return activity instanceof androidx.lifecycle.LifecycleOwner
            && ((androidx.lifecycle.LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED);
    }

    static int waitingNotificationId(String triggerId) {
        return 0x1000 + (triggerId.hashCode() & 0xfff);
    }

    static int approvalNotificationId(String approvalId) {
        return 0x2000 + (approvalId.hashCode() & 0xfff);
    }

    private static int proactiveNotificationId(String key) {
        return 0x3000 + (key.hashCode() & 0xfff);
    }

    /** Wired headphones: their broadcast only reaches receivers registered by a running app, so only while pi runs. */
    private final BroadcastReceiver wired = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // Registering delivers the current state at once; only a change counts.
            if (isInitialStickyBroadcast()) return;
            int state = intent.getIntExtra("state", -1);
            if (state == 1) TriggerReceiver.headphones(context, "有線耳機");
            else if (state == 0) Speaker.stopIfSpeaking();
        }
    };

    @Override
    public void load() {
        live = this;
        receiveShare(getActivity().getIntent());
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_HEADSET_PLUG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getContext().registerReceiver(wired, filter, Context.RECEIVER_EXPORTED);
        else getContext().registerReceiver(wired, filter);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        receiveShare(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        try {
            getContext().unregisterReceiver(wired);
        } catch (IllegalArgumentException ignored) {
            // Not registered.
        }
        super.handleOnDestroy();
    }

    /**
     * A trigger fired while the WebView runs. Start the foreground service now, while the alarm's exemption from the
     * background start restriction lasts, and raise the renderer's priority (see KeepAlivePlugin), then tell the web side.
     */
    void wake(String text) {
        try {
            getContext().startForegroundService(new Intent(getContext(), AgentService.class).putExtra(AgentService.EXTRA_TEXT, text));
        } catch (RuntimeException error) {
            Log.w(TAG, "could not start the foreground service", error);
        }
        getActivity().runOnUiThread(() -> KeepAlivePlugin.keepWebViewRunning(getBridge().getWebView(), true));
        notifyListeners("event", new JSObject(), true);
    }

    void approvalAnswered(String id, boolean approved) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("approved", approved);
        notifyListeners("approval", data, true);
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

    /** Clear the "tap to start" notification of a trigger that is now running. */
    @PluginMethod
    public void started(PluginCall call) {
        String trigger = call.getString("trigger", "");
        getContext().getSystemService(NotificationManager.class).cancel(waitingNotificationId(trigger));
        call.resolve();
    }

    /** A shared file from the queue, as base64. Only files in the inbox can be read. */
    @PluginMethod
    public void readFile(PluginCall call) {
        File file = new File(call.getString("path", ""));
        if (!TriggerStore.isInbox(getContext(), file)) {
            call.reject("not a shared file");
            return;
        }
        try (InputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int read = 0;
            while (read < bytes.length) {
                int count = input.read(bytes, read, bytes.length - read);
                if (count < 0) break;
                read += count;
            }
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(bytes, 0, read, Base64.NO_WRAP));
            call.resolve(result);
        } catch (IOException error) {
            call.reject("could not read the shared file", error);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        AlarmManager alarms = getContext().getSystemService(AlarmManager.class);
        JSObject result = new JSObject();
        result.put("exactAlarms", Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms());
        result.put("bluetooth", bluetoothGranted());
        call.resolve(result);
    }

    private boolean bluetoothGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    /** Ask for the Bluetooth permission a headphones schedule needs; resolves {granted}. Only with pi in front. */
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

    /**
     * Act as if headphones connected, for tests on devices without them (the emulator). Only in development builds:
     * those with WebView debugging on, which release-android.sh turns off. delayMs lets a test put pi in the
     * background first. It goes through an alarm, as a broadcast to TriggerReceiver: a cached process is frozen, so a
     * delayed callback in it would not run, while a broadcast thaws it like the real Bluetooth one does.
     */
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        call.resolve();
    }

    /** The system page where the user allows exact alarms (off by default since Android 14). */
    @PluginMethod
    public void requestExactAlarms(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** What a run wants the user to know. Tapping opens the conversation it came from. */
    @PluginMethod
    public void notify(PluginCall call) {
        String conversation = call.getString("conversation", "");
        AgentService.createChannels(getContext());
        String text = call.getString("text", "");
        Notification notification = new Notification.Builder(getContext(), AgentService.CHANNEL_PROACTIVE)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(call.getString("title", "pi"))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(openConversation(conversation))
            .setAutoCancel(true)
            .build();
        getContext().getSystemService(NotificationManager.class).notify(proactiveNotificationId(conversation), notification);
        call.resolve();
    }

    /** Approve or decline a tool's request from the notification, without opening pi. Answered on "approval". */
    @PluginMethod
    public void askApproval(PluginCall call) {
        String id = call.getString("id", "");
        String text = call.getString("text", "");
        AgentService.createChannels(getContext());
        Notification notification = new Notification.Builder(getContext(), AgentService.CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(call.getString("title", "pi 需要你確認"))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(AgentService.openApp(getContext()))
            .addAction(new Notification.Action.Builder(null, "拒絕", answer(id, false)).build())
            .addAction(new Notification.Action.Builder(null, "允許", answer(id, true)).build())
            .setCategory(Notification.CATEGORY_REMINDER)
            .setTimeoutAfter(APPROVAL_TIMEOUT_MS)
            .setOngoing(true)
            .build();
        getContext().getSystemService(NotificationManager.class).notify(approvalNotificationId(id), notification);
        call.resolve();
    }

    @PluginMethod
    public void cancelApproval(PluginCall call) {
        getContext().getSystemService(NotificationManager.class).cancel(approvalNotificationId(call.getString("id", "")));
        call.resolve();
    }

    private PendingIntent answer(String id, boolean approved) {
        Intent intent = new Intent(getContext(), TriggerReceiver.class)
            .setAction(TriggerStore.ACTION_APPROVAL)
            .setData(Uri.parse("pimobile-approval://" + Uri.encode(id) + "/" + approved))
            .putExtra(TriggerStore.EXTRA_ID, id)
            .putExtra(TriggerStore.EXTRA_APPROVED, approved);
        return PendingIntent.getBroadcast(getContext(), 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Opens pi on a conversation through a pimobile://open link, which the web side handles like any app link. */
    private PendingIntent openConversation(String conversation) {
        if (conversation.isEmpty()) return AgentService.openApp(getContext());
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("pimobile://open?conversation=" + Uri.encode(conversation)), getContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getContext(), conversation.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Text or an image another app shared with pi ("Share" -> pi). */
    private void receiveShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        // Mark it handled: the activity keeps its launch intent, and load() must not take it again.
        intent.setAction(Intent.ACTION_MAIN);
        JSONObject event = new JSONObject();
        try {
            event.put("kind", "share");
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text != null) event.put("text", text);
            if (subject != null) event.put("subject", subject);
            Uri stream = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : legacyStream(intent);
            String type = intent.getType();
            if (stream != null && type != null && type.startsWith("image/")) {
                File copy = copyShared(stream);
                if (copy != null) {
                    String actual = getContext().getContentResolver().getType(stream);
                    JSONObject file = new JSONObject();
                    file.put("path", copy.getAbsolutePath());
                    file.put("mimeType", actual != null ? actual : type);
                    event.put("file", file);
                }
            }
        } catch (JSONException ignored) {
            // String keys always fit.
        }
        TriggerStore.enqueue(getContext(), event);
        notifyListeners("event", new JSObject(), true);
    }

    @SuppressWarnings("deprecation")
    private static Uri legacyStream(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private File copyShared(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        File target = new File(TriggerStore.inbox(getContext()), UUID.randomUUID().toString());
        try (InputStream input = resolver.openInputStream(uri); OutputStream output = new FileOutputStream(target)) {
            if (input == null) return null;
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int count;
            while ((count = input.read(buffer)) > 0) {
                total += count;
                if (total > MAX_SHARED_BYTES) throw new IOException("shared file is larger than " + MAX_SHARED_BYTES + " bytes");
                output.write(buffer, 0, count);
            }
            return target;
        } catch (IOException | SecurityException error) {
            Log.w(TAG, "could not copy the shared file", error);
            if (target.exists() && !target.delete()) Log.w(TAG, "could not delete " + target);
            return null;
        }
    }
}
