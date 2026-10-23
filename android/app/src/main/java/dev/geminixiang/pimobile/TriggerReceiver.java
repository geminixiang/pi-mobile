package dev.geminixiang.pimobile;

import com.getcapacitor.JSObject;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import org.json.JSONObject;

public class TriggerReceiver extends BroadcastReceiver {

    private static final String TAG = "PiTriggers";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (TriggerStore.ACTION_FIRE.equals(action)) fire(context, intent.getStringExtra(TriggerStore.EXTRA_ID), null);
        else if (TriggerStore.ACTION_TEST_HEADPHONES.equals(action)) headphones(context, intent.getStringExtra(TriggerStore.EXTRA_DEVICE));
        else if (TriggerEvents.ACTION_PLACE.equals(action)) place(context, intent);
        else if (ActivityTrigger.ACTION.equals(action)) ActivityTrigger.receive(context, intent);
        else {
            TriggerStore.armAll(context);
            if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)) timezone(context, intent.getStringExtra(Intent.EXTRA_TIMEZONE));
        }
    }

    private static void timezone(Context context, String id) {
        java.util.TimeZone zone = id != null ? java.util.TimeZone.getTimeZone(id) : java.util.TimeZone.getDefault();
        String name = zone.getDisplayName(java.util.Locale.TRADITIONAL_CHINESE);
        event(context, "timezone", "時區改成 " + zone.getID() + "（" + name + "）", null);
    }

    static void bluetooth(Context context, String device, boolean connected) {
        event(context, "bluetooth", (connected ? "連上藍牙 " : "斷開藍牙 ") + device, item -> {
            JSONObject when = item.optJSONObject("when");
            return when.optString("on").equals(connected ? "connect" : "disconnect") && includes(device, when.optString("device", ""));
        });
    }

    static void wifi(Context context) {
        String name = TriggerEvents.wifiName(context);
        event(context, "wifi", name != null ? "連上 Wi-Fi " + name : "連上 Wi-Fi", item -> {
            String wanted = item.optJSONObject("when").optString("ssid", "");
            return wanted.isEmpty() || (name != null && name.equalsIgnoreCase(wanted));
        });
    }

    private static final int NOTIFICATION_TEXT_LIMIT = 500;

    static void notification(Context context, NotificationStore.Row row) {
        String from = row.sender != null && !row.sender.isEmpty() ? row.sender : row.title;
        String body = row.text.length() > NOTIFICATION_TEXT_LIMIT ? row.text.substring(0, NOTIFICATION_TEXT_LIMIT) + "…" : row.text;
        String detail = "收到 " + row.app + " 的通知：" + (from.isEmpty() ? "" : from + "：") + body;
        event(context, "notification", detail, item -> {
            JSONObject when = item.optJSONObject("when");
            String app = when.optString("app", "");
            String contains = when.optString("contains", "");
            boolean appMatches = app.isEmpty() || includes(row.app, app) || includes(row.packageName, app);
            boolean textMatches = contains.isEmpty()
                || includes(row.title, contains) || includes(row.text, contains) || includes(row.sender, contains) || includes(row.conversation, contains);
            return appMatches && textMatches;
        });
    }

    private static boolean includes(String value, String part) {
        return value != null && value.toLowerCase(java.util.Locale.ROOT).contains(part.toLowerCase(java.util.Locale.ROOT));
    }

    private static void place(Context context, Intent intent) {
        String id = intent.getStringExtra(TriggerStore.EXTRA_ID);
        boolean entering = intent.getBooleanExtra(android.location.LocationManager.KEY_PROXIMITY_ENTERING, false);
        JSONObject schedule = id == null ? null : TriggerStore.schedule(context, id);
        JSONObject when = schedule == null ? null : schedule.optJSONObject("when");
        if (when == null || "leave".equals(when.optString("on")) == entering) return;
        if (TriggerEvents.settling(context, id)) {
            Log.i(TAG, "place " + id + ": " + (entering ? "inside" : "outside") + " when armed, not an event");
            return;
        }
        event(context, "place", (entering ? "到了 " : "離開 ") + when.optString("label", "那裡"), item -> id.equals(item.optString("id")));
    }

    static void event(Context context, String kind, String detail, java.util.function.Predicate<JSONObject> match) {
        for (String id : TriggerStore.eventSchedules(context, kind, match == null ? item -> true : match)) {
            JSObject cause = new JSObject();
            cause.put("device", detail);
            fire(context, id, cause);
        }
        Log.i(TAG, kind + " event" + ("notification".equals(kind) ? "" : ": " + detail));
    }

    static void headphones(Context context, String device) {
        event(context, "headphones", device, null);
    }

    static void fire(Context context, String id, JSONObject cause) {
        if (id == null) return;
        JSONObject schedule = TriggerStore.schedule(context, id);
        if (schedule == null) return;
        String name = schedule.optString("name", "自動化");
        TriggersPlugin live = TriggersPlugin.live();
        JSObject event = new JSObject();
        event.put("kind", "alarm");
        event.put("trigger", id);
        event.put("live", live != null);
        if (cause != null && cause.has("device")) event.put("device", cause.optString("device"));
        TriggerStore.enqueue(context, event);
        JSONObject when = schedule.optJSONObject("when");
        if (when != null && "once".equals(when.optString("kind"))) TriggerStore.removeSchedule(context, id);
        else if (when != null && ("daily".equals(when.optString("kind")))) TriggerStore.arm(context, schedule);
        Log.i(TAG, "fired " + id + (live != null ? " (live)" : " (no WebView)"));

        if (live != null) {
            live.wake(name);
            return;
        }
        AgentService.createChannels(context);
        Notification notification = new Notification.Builder(context, AgentService.CHANNEL_PROACTIVE)
            .setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(AgentService.avatar(context, schedule.optString("avatar", null)))
            .setContentTitle(name)
            .setContentText("點一下開始")
            .setContentIntent(AgentService.openApp(context))
            .setAutoCancel(true)
            .build();
        context.getSystemService(NotificationManager.class).notify(TriggersPlugin.waitingNotificationId(id), notification);
    }
}
