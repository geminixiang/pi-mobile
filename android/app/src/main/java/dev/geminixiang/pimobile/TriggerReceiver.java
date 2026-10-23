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
        else TriggerStore.armAll(context);
    }

    static void wifi(Context context) {
        String name = TriggerEvents.wifiName(context);
        event(context, "wifi", name != null ? "連上 Wi-Fi " + name : "連上 Wi-Fi", item -> {
            String wanted = item.optJSONObject("when").optString("ssid", "");
            return wanted.isEmpty() || (name != null && name.equalsIgnoreCase(wanted));
        });
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
        Log.i(TAG, kind + " event: " + detail);
    }

    static void headphones(Context context, String device) {
        event(context, "headphones", device, null);
    }

    static void fire(Context context, String id, JSONObject cause) {
        if (id == null) return;
        JSONObject schedule = TriggerStore.schedule(context, id);
        if (schedule == null) return;
        String name = schedule.optString("name", "排程");
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
