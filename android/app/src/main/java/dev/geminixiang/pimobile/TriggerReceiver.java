package dev.geminixiang.pimobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Alarms of trigger schedules, the answer buttons of approval notifications, and the system events after which alarms
 * must be set again (reboot, app update, clock or time zone change, exact alarm permission granted). Headphones
 * connecting come from HeadphonesReceiver.
 */
public class TriggerReceiver extends BroadcastReceiver {

    private static final String TAG = "PiTriggers";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (TriggerStore.ACTION_FIRE.equals(action)) fire(context, intent.getStringExtra(TriggerStore.EXTRA_ID), null);
        else if (TriggerStore.ACTION_APPROVAL.equals(action)) answer(context, intent);
        // Only this app can send it: the receiver is not exported, and the plugin schedules it only in development builds.
        else if (TriggerStore.ACTION_TEST_HEADPHONES.equals(action)) headphones(context, intent.getStringExtra(TriggerStore.EXTRA_DEVICE));
        else if (TriggerEvents.ACTION_PLACE.equals(action)) place(context, intent);
        else TriggerStore.armAll(context);
    }

    /** A Wi-Fi network came up: the Wi-Fi schedules for any network, or for this one by name. */
    static void wifi(Context context) {
        String name = TriggerEvents.wifiName(context);
        event(context, "wifi", name != null ? "連上 Wi-Fi " + name : "連上 Wi-Fi", item -> {
            String wanted = item.optJSONObject("when").optString("ssid", "");
            return wanted.isEmpty() || (name != null && name.equalsIgnoreCase(wanted));
        });
    }

    /** A proximity alert: the phone entered or left one place schedule's circle; it fires if that is the side it wants. */
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

    /** An event of `kind` happened (`detail` says which, for the run): fire the schedules that `match` and apply now. */
    static void event(Context context, String kind, String detail, java.util.function.Predicate<JSONObject> match) {
        for (String id : TriggerStore.eventSchedules(context, kind, match == null ? item -> true : match)) {
            JSONObject cause = new JSONObject();
            try {
                cause.put("device", detail);
            } catch (JSONException ignored) {
                // String keys always fit.
            }
            fire(context, id, cause);
        }
        Log.i(TAG, kind + " event: " + detail);
    }

    /** Headphones connected (Bluetooth from HeadphonesReceiver, wired from TriggersPlugin while pi runs): fire what applies. */
    static void headphones(Context context, String device) {
        event(context, "headphones", device, null);
    }

    static void fire(Context context, String id, JSONObject cause) {
        if (id == null) return;
        JSONObject schedule = TriggerStore.schedule(context, id);
        if (schedule == null) return;
        String name = schedule.optString("name", "排程");
        TriggersPlugin live = TriggersPlugin.live();
        JSONObject event = new JSONObject();
        try {
            event.put("kind", "alarm");
            event.put("trigger", id);
            // Whether the WebView was there to run it right away; the web side keeps it with the run.
            event.put("live", live != null);
            if (cause != null && cause.has("device")) event.put("device", cause.optString("device"));
        } catch (JSONException ignored) {
            // String keys always fit.
        }
        TriggerStore.enqueue(context, event);
        JSONObject when = schedule.optJSONObject("when");
        if (when != null && "once".equals(when.optString("kind"))) TriggerStore.removeSchedule(context, id);
        else if (when != null && ("daily".equals(when.optString("kind")))) TriggerStore.arm(context, schedule);
        Log.i(TAG, "fired " + id + (live != null ? " (live)" : " (no WebView)"));

        if (live != null) {
            live.wake(name);
            return;
        }
        // No WebView, so no agent: ask the user to open pi. The queued event runs as soon as it starts.
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

    private void answer(Context context, Intent intent) {
        String id = intent.getStringExtra(TriggerStore.EXTRA_ID);
        if (id == null) return;
        context.getSystemService(NotificationManager.class).cancel(TriggersPlugin.approvalNotificationId(id));
        TriggersPlugin live = TriggersPlugin.live();
        // Without the WebView the run that asked is gone too; it asks again when it resumes.
        if (live != null) live.approvalAnswered(id, intent.getBooleanExtra(TriggerStore.EXTRA_APPROVED, false));
    }
}
