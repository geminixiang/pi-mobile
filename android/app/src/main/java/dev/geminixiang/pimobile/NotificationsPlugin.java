package dev.geminixiang.pimobile;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.ComponentName;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "Notifications")
public class NotificationsPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName()));
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 30) {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            intent.putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(getContext(), NotificationsListener.class).flattenToString()
            );
        } else {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException e) {
            getContext().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        long since = call.getLong("since", System.currentTimeMillis() - 24 * 3600_000L);
        int limit = Math.max(0, call.getInt("limit", 0));
        List<NotificationStore.Row> rows = NotificationStore.get(getContext()).list(since, call.getString("app"), call.getString("query"), limit);
        JSArray items = new JSArray();
        for (NotificationStore.Row row : rows) {
            JSObject item = new JSObject();
            item.put("package", row.packageName);
            item.put("app", row.app);
            if (row.conversation != null) item.put("conversation", row.conversation);
            if (row.sender != null && !row.sender.isEmpty()) item.put("sender", row.sender);
            item.put("title", row.title);
            item.put("text", row.text);
            item.put("time", row.time);
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        NotificationStore.get(getContext()).clear();
        call.resolve();
    }

    private NotificationsListener listener(PluginCall call) {
        NotificationsListener listener = NotificationsListener.instance;
        if (listener == null) call.reject("notification access is off");
        return listener;
    }

    private boolean matches(NotificationsListener listener, StatusBarNotification sbn, String app, String conversation) {
        String label = listener.appLabel(sbn.getPackageName()).toLowerCase(Locale.ROOT);
        String needle = app.toLowerCase(Locale.ROOT);
        if (!label.contains(needle) && !sbn.getPackageName().toLowerCase(Locale.ROOT).contains(needle)) return false;
        if (conversation == null || conversation.isEmpty()) return true;
        Bundle extras = sbn.getNotification().extras;
        String title = String.valueOf(extras.getCharSequence(Notification.EXTRA_TITLE));
        String chat = String.valueOf(extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE));
        String c = conversation.toLowerCase(Locale.ROOT);
        return title.toLowerCase(Locale.ROOT).contains(c) || chat.toLowerCase(Locale.ROOT).contains(c);
    }

    private static Notification.Action replyAction(StatusBarNotification sbn) {
        Notification.Action[] actions = sbn.getNotification().actions;
        if (actions == null) return null;
        for (Notification.Action action : actions) {
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null) continue;
            for (RemoteInput input : inputs) if (input.getAllowFreeFormInput()) return action;
        }
        return null;
    }

    @PluginMethod
    public void active(PluginCall call) {
        NotificationsListener listener = listener(call);
        if (listener == null) return;
        JSArray items = new JSArray();
        StatusBarNotification[] active = listener.getActiveNotifications();
        List<StatusBarNotification> sorted = new ArrayList<>(active == null ? List.of() : List.of(active));
        sorted.sort((a, b) -> Long.compare(b.getPostTime(), a.getPostTime()));
        for (StatusBarNotification sbn : sorted) {
            if (sbn.getPackageName().equals(getContext().getPackageName())) continue;
            if (!matches(listener, sbn, call.getString("app", ""), call.getString("conversation"))) continue;
            Bundle extras = sbn.getNotification().extras;
            JSObject item = new JSObject();
            item.put("key", sbn.getKey());
            item.put("app", listener.appLabel(sbn.getPackageName()));
            item.put("title", String.valueOf(extras.getCharSequence(Notification.EXTRA_TITLE, "")));
            item.put("text", String.valueOf(extras.getCharSequence(Notification.EXTRA_TEXT, "")));
            item.put("time", sbn.getPostTime());
            item.put("canReply", replyAction(sbn) != null);
            item.put("clearable", sbn.isClearable());
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void reply(PluginCall call) {
        NotificationsListener listener = listener(call);
        if (listener == null) return;
        String key = call.getString("key", "");
        StatusBarNotification[] active = listener.getActiveNotifications(new String[] { key });
        if (active == null || active.length == 0) {
            call.reject("that notification is gone");
            return;
        }
        Notification.Action action = replyAction(active[0]);
        if (action == null) {
            call.reject("that notification takes no reply");
            return;
        }
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput input : action.getRemoteInputs()) results.putCharSequence(input.getResultKey(), call.getString("text", ""));
        RemoteInput.addResultsToIntent(action.getRemoteInputs(), fill, results);
        try {
            action.actionIntent.send(getContext(), 0, fill);
            call.resolve();
        } catch (PendingIntent.CanceledException error) {
            call.reject("the app no longer takes this reply");
        }
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        NotificationsListener listener = listener(call);
        if (listener == null) return;
        JSArray keys = call.getArray("keys", new JSArray());
        try {
            for (int i = 0; i < keys.length(); i++) listener.cancelNotification(keys.getString(i));
        } catch (org.json.JSONException error) {
            call.reject("keys must be strings");
            return;
        }
        call.resolve();
    }

    private List<MediaController> sessions() {
        MediaSessionManager manager = getContext().getSystemService(MediaSessionManager.class);
        return manager.getActiveSessions(new ComponentName(getContext(), NotificationsListener.class));
    }

    private static String stateName(PlaybackState state) {
        if (state == null) return "none";
        switch (state.getState()) {
            case PlaybackState.STATE_PLAYING:
                return "playing";
            case PlaybackState.STATE_PAUSED:
                return "paused";
            case PlaybackState.STATE_BUFFERING:
                return "buffering";
            case PlaybackState.STATE_STOPPED:
                return "stopped";
            default:
                return "other";
        }
    }

    @PluginMethod
    public void media(PluginCall call) {
        NotificationsListener listener = listener(call);
        if (listener == null) return;
        JSArray items = new JSArray();
        for (MediaController controller : sessions()) {
            JSObject item = new JSObject();
            item.put("package", controller.getPackageName());
            item.put("app", listener.appLabel(controller.getPackageName()));
            item.put("state", stateName(controller.getPlaybackState()));
            MediaMetadata metadata = controller.getMetadata();
            if (metadata != null) {
                item.put("title", metadata.getString(MediaMetadata.METADATA_KEY_TITLE));
                item.put("artist", metadata.getString(MediaMetadata.METADATA_KEY_ARTIST));
                item.put("album", metadata.getString(MediaMetadata.METADATA_KEY_ALBUM));
                item.put("durationMs", metadata.getLong(MediaMetadata.METADATA_KEY_DURATION));
            }
            PlaybackState state = controller.getPlaybackState();
            if (state != null) item.put("positionMs", state.getPosition());
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void mediaControl(PluginCall call) {
        if (listener(call) == null) return;
        String target = call.getString("package");
        for (MediaController controller : sessions()) {
            if (target != null && !target.isEmpty() && !controller.getPackageName().equals(target)) continue;
            MediaController.TransportControls controls = controller.getTransportControls();
            switch (call.getString("action", "")) {
                case "play":
                    controls.play();
                    break;
                case "pause":
                    controls.pause();
                    break;
                case "next":
                    controls.skipToNext();
                    break;
                case "previous":
                    controls.skipToPrevious();
                    break;
                case "stop":
                    controls.stop();
                    break;
                default:
                    call.reject("unknown action");
                    return;
            }
            JSObject result = new JSObject();
            result.put("package", controller.getPackageName());
            call.resolve(result);
            return;
        }
        call.reject("nothing is playing");
    }

    private static final String[] DND_NAMES = { "unknown", "off", "priority", "silent", "alarms" };

    @PluginMethod
    public void dnd(PluginCall call) {
        int filter = getContext().getSystemService(NotificationManager.class).getCurrentInterruptionFilter();
        JSObject result = new JSObject();
        result.put("mode", filter >= 0 && filter < DND_NAMES.length ? DND_NAMES[filter] : "unknown");
        result.put("until", getContext().getSharedPreferences(DND_PREFS, 0).getLong(DND_UNTIL, 0));
        call.resolve(result);
    }

    static final String DND_PREFS = "pi-dnd";
    static final String DND_UNTIL = "until";
    static final String ACTION_DND_END = "dev.geminixiang.pimobile.DND_END";

    @PluginMethod
    public void setDnd(PluginCall call) {
        NotificationsListener listener = listener(call);
        if (listener == null) return;
        String mode = call.getString("mode", "");
        int filter = java.util.Arrays.asList(DND_NAMES).indexOf(mode);
        if (filter < 1) {
            call.reject("mode is off, priority, alarms, or silent");
            return;
        }
        listener.requestInterruptionFilter(filter);
        AlarmManager alarms = getContext().getSystemService(AlarmManager.class);
        PendingIntent end = PendingIntent.getBroadcast(
            getContext(),
            0,
            new Intent(getContext(), DndReceiver.class).setAction(ACTION_DND_END),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        long until = call.getLong("until", 0L);
        alarms.cancel(end);
        if (filter != NotificationListenerService.INTERRUPTION_FILTER_ALL && until > System.currentTimeMillis()) {
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, end);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, end);
        } else {
            until = 0;
        }
        getContext().getSharedPreferences(DND_PREFS, 0).edit().putLong(DND_UNTIL, until).apply();
        call.resolve();
    }
}
