package dev.geminixiang.pimobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import java.io.File;
import java.time.DayOfWeek;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The native half of triggers. The web side owns the trigger definitions and mirrors their schedules here, so alarms
 * fire, and are set again after a reboot, without the WebView. What happens while the WebView is gone is recorded in
 * an event queue; the web side takes the events when it runs again and acknowledges them once handled, so an event is
 * neither lost nor handled twice.
 *
 * A schedule is {id, name, when}, with when {kind: "daily", time: "HH:MM", days: [1..7]} (ISO weekdays, Monday is 1;
 * empty means every day) or {kind: "once", at: epoch ms}.
 */
final class TriggerStore {

    static final String ACTION_FIRE = "dev.geminixiang.pimobile.TRIGGER_FIRE";
    static final String ACTION_APPROVAL = "dev.geminixiang.pimobile.APPROVAL";
    static final String EXTRA_ID = "id";
    static final String EXTRA_APPROVED = "approved";
    private static final String TAG = "PiTriggers";
    private static final String PREFS = "pi-triggers";
    private static final String KEY_SCHEDULES = "schedules";
    private static final String KEY_EVENTS = "events";
    /** A one-time schedule missed by more than this (the phone was off) is dropped instead of fired late. */
    private static final long MISSED_GRACE_MS = 6 * 60 * 60 * 1000L;

    private TriggerStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray array(Context context, String key) {
        try {
            return new JSONArray(prefs(context).getString(key, "[]"));
        } catch (JSONException error) {
            Log.w(TAG, "dropping unreadable " + key, error);
            return new JSONArray();
        }
    }

    static synchronized JSONArray schedules(Context context) {
        return array(context, KEY_SCHEDULES);
    }

    static synchronized JSONObject schedule(Context context, String id) {
        JSONArray all = schedules(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) return item;
        }
        return null;
    }

    /** Replace every schedule: cancel the alarms of removed ones, set the alarms of the rest. Returns id -> next fire. */
    static synchronized JSONObject replaceSchedules(Context context, JSONArray next) {
        Set<String> keep = new HashSet<>();
        for (int i = 0; i < next.length(); i++) keep.add(next.optJSONObject(i).optString("id"));
        JSONArray previous = schedules(context);
        for (int i = 0; i < previous.length(); i++) {
            String id = previous.optJSONObject(i).optString("id");
            if (!keep.contains(id)) cancelAlarm(context, id);
        }
        prefs(context).edit().putString(KEY_SCHEDULES, next.toString()).apply();
        return armAll(context);
    }

    static synchronized void removeSchedule(Context context, String id) {
        JSONArray all = schedules(context);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < all.length(); i++) if (!id.equals(all.optJSONObject(i).optString("id"))) kept.put(all.optJSONObject(i));
        prefs(context).edit().putString(KEY_SCHEDULES, kept.toString()).apply();
        cancelAlarm(context, id);
    }

    /** Set the alarm of every schedule, as after a reboot; returns id -> next fire time. */
    static synchronized JSONObject armAll(Context context) {
        JSONObject times = new JSONObject();
        JSONArray all = schedules(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            long at = arm(context, item);
            try {
                if (at > 0) times.put(item.optString("id"), at);
            } catch (JSONException ignored) {
                // A string key and a long value always fit.
            }
        }
        return times;
    }

    /** Set the alarm for the schedule's next time; returns that time, or -1 when it has none. */
    static long arm(Context context, JSONObject schedule) {
        String id = schedule.optString("id");
        long at = nextTime(schedule.optJSONObject("when"), System.currentTimeMillis());
        if (at < 0) {
            cancelAlarm(context, id);
            return -1;
        }
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent fire = fireIntent(context, id);
        // Exact alarms also exempt the start of the foreground service when they fire; without the permission the
        // alarm may come several minutes late.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
        }
        return at;
    }

    static long nextTime(JSONObject when, long now) {
        if (when == null) return -1;
        switch (when.optString("kind")) {
            case "once": {
                long at = when.optLong("at", -1);
                if (at > now) return at;
                return at > now - MISSED_GRACE_MS ? now + 5_000 : -1;
            }
            case "daily": {
                LocalTime time;
                try {
                    time = LocalTime.parse(when.optString("time"));
                } catch (RuntimeException error) {
                    return -1;
                }
                Set<Integer> days = new HashSet<>();
                JSONArray list = when.optJSONArray("days");
                if (list != null) for (int i = 0; i < list.length(); i++) days.add(list.optInt(i));
                ZonedDateTime current = ZonedDateTime.now();
                ZonedDateTime candidate = current.with(time).withSecond(0).withNano(0);
                for (int step = 0; step < 8; step++) {
                    DayOfWeek day = candidate.getDayOfWeek();
                    if (candidate.toInstant().toEpochMilli() > now && (days.isEmpty() || days.contains(day.getValue()))) {
                        return candidate.toInstant().toEpochMilli();
                    }
                    candidate = candidate.plusDays(1).with(time);
                }
                return -1;
            }
            default:
                return -1;
        }
    }

    private static PendingIntent fireIntent(Context context, String id) {
        Intent intent = new Intent(context, TriggerReceiver.class)
            .setAction(ACTION_FIRE)
            .setData(Uri.parse("pimobile-trigger://" + Uri.encode(id)))
            .putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void cancelAlarm(Context context, String id) {
        context.getSystemService(AlarmManager.class).cancel(fireIntent(context, id));
    }

    /** Append an event; it gets an id and a time. */
    static synchronized JSONObject enqueue(Context context, JSONObject event) {
        try {
            event.put("id", UUID.randomUUID().toString());
            event.put("at", System.currentTimeMillis());
        } catch (JSONException ignored) {
            // String keys always fit.
        }
        JSONArray events = array(context, KEY_EVENTS);
        events.put(event);
        prefs(context).edit().putString(KEY_EVENTS, events.toString()).apply();
        return event;
    }

    static synchronized JSONArray events(Context context) {
        return array(context, KEY_EVENTS);
    }

    /** Drop handled events, and the files they carried. */
    static synchronized void ack(Context context, Set<String> ids) {
        JSONArray events = array(context, KEY_EVENTS);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.optJSONObject(i);
            if (event == null) continue;
            if (!ids.contains(event.optString("id"))) {
                kept.put(event);
                continue;
            }
            JSONObject file = event.optJSONObject("file");
            if (file != null) {
                File stored = new File(file.optString("path"));
                if (isInbox(context, stored) && !stored.delete()) Log.w(TAG, "could not delete " + stored);
            }
        }
        prefs(context).edit().putString(KEY_EVENTS, kept.toString()).apply();
    }

    /** Where shared files wait until the web side reads them. */
    static File inbox(Context context) {
        File dir = new File(context.getFilesDir(), "inbox");
        if (!dir.isDirectory() && !dir.mkdirs()) Log.w(TAG, "could not create " + dir);
        return dir;
    }

    static boolean isInbox(Context context, File file) {
        try {
            return file.getCanonicalFile().getParentFile().equals(inbox(context).getCanonicalFile());
        } catch (java.io.IOException error) {
            return false;
        }
    }
}
