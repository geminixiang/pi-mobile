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
 * must be set again (reboot, app update, clock or time zone change, exact alarm permission granted).
 */
public class TriggerReceiver extends BroadcastReceiver {

    private static final String TAG = "PiTriggers";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (TriggerStore.ACTION_FIRE.equals(action)) fire(context, intent.getStringExtra(TriggerStore.EXTRA_ID));
        else if (TriggerStore.ACTION_APPROVAL.equals(action)) answer(context, intent);
        else TriggerStore.armAll(context);
    }

    private void fire(Context context, String id) {
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
        } catch (JSONException ignored) {
            // String keys always fit.
        }
        TriggerStore.enqueue(context, event);
        JSONObject when = schedule.optJSONObject("when");
        if (when != null && "once".equals(when.optString("kind"))) TriggerStore.removeSchedule(context, id);
        else TriggerStore.arm(context, schedule);
        Log.i(TAG, "fired " + id + (live != null ? " (live)" : " (no WebView)"));

        if (live != null) {
            live.wake(name);
            return;
        }
        // No WebView, so no agent: ask the user to open pi. The queued event runs as soon as it starts.
        AgentService.createChannels(context);
        Notification notification = new Notification.Builder(context, AgentService.CHANNEL_PROACTIVE)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
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
