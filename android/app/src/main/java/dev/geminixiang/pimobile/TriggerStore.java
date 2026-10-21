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
 * empty means every day), {kind: "once", at: epoch ms}, or {kind: "headphones", days, from?, until?, gapHours}: when
 * headphones connect on those days, between from and until ("HH:MM", local), and not within gapHours of its last run
 * (24: not on the same day).
 * Headphones schedules have no alarm.
 */
final class TriggerStore {

    static final String ACTION_FIRE = "dev.geminixiang.pimobile.TRIGGER_FIRE";
    static final String ACTION_APPROVAL = "dev.geminixiang.pimobile.APPROVAL";
    static final String EXTRA_ID = "id";
    static final String EXTRA_APPROVED = "approved";
    /** TriggersPlugin.simulateHeadphones, in development builds only. */
    static final String ACTION_TEST_HEADPHONES = "dev.geminixiang.pimobile.TEST_HEADPHONES";
    static final String EXTRA_DEVICE = "device";
    private static final String TAG = "PiTriggers";
    private static final String PREFS = "pi-triggers";
    private static final String KEY_SCHEDULES = "schedules";
    private static final String KEY_EVENTS = "events";
    /** A one-time schedule missed by more than this (the phone was off) is dropped instead of fired late. */
    private static final long MISSED_GRACE_MS = 6 * 60 * 60 * 1000L;
    private static final String KEY_LAST_PREFIX = "last.";

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

    /** Set the alarm of every schedule, and arm the event sources, as after a reboot; returns id -> next fire time. */
    static synchronized JSONObject armAll(Context context) {
        JSONObject times = new JSONObject();
        JSONArray all = schedules(context);
        TriggerEvents.sync(context, all);
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

    /**
     * Headphones connected: the headphones schedules that apply now, which are marked as run. The gap is counted
     * here rather than on the web side so a reconnect a minute later (earbuds often connect twice) does not queue a
     * second run while the first is still waiting for the WebView.
     */
    static java.util.List<String> headphonesSchedules(Context context) {
        return eventSchedules(context, "headphones", item -> true);
    }

    /**
     * An event happened: the schedules of that kind that `match` accepts (it sees the whole schedule) and that apply now (their days, hours, and
     * gap), which are marked as run. Headphones, charging, Wi-Fi, and places all go through here (TriggerReceiver.event).
     */
    static synchronized java.util.List<String> eventSchedules(Context context, String kind, java.util.function.Predicate<JSONObject> match) {
        java.util.List<String> due = new java.util.ArrayList<>();
        JSONArray all = schedules(context);
        ZonedDateTime now = ZonedDateTime.now();
        long nowMs = System.currentTimeMillis();
        SharedPreferences.Editor editor = prefs(context).edit();
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            JSONObject when = item == null ? null : item.optJSONObject("when");
            if (when == null || !kind.equals(when.optString("kind")) || !match.test(item)) continue;
            String id = item.optString("id");
            if (!headphonesWindow(when, now)) continue;
            long last = prefs(context).getLong(KEY_LAST_PREFIX + id, 0);
            int gapHours = Math.max(1, when.optInt("gapHours", 4));
            if (gapHours >= 24) {
                // Once a day means once per calendar day: Monday at 08:00 must not block Tuesday at 07:50.
                java.time.LocalDate lastDay = java.time.Instant.ofEpochMilli(last).atZone(now.getZone()).toLocalDate();
                if (last > 0 && lastDay.equals(now.toLocalDate())) continue;
            } else if (nowMs - last < gapHours * 60L * 60 * 1000) {
                continue;
            }
            editor.putLong(KEY_LAST_PREFIX + id, nowMs);
            due.add(id);
        }
        editor.apply();
        return due;
    }

    static boolean headphonesWindow(JSONObject when, ZonedDateTime now) {
        JSONArray list = when.optJSONArray("days");
        if (list != null && list.length() > 0) {
            boolean today = false;
            for (int i = 0; i < list.length(); i++) if (list.optInt(i) == now.getDayOfWeek().getValue()) today = true;
            if (!today) return false;
        }
        String from = when.optString("from", "");
        String until = when.optString("until", "");
        if (from.isEmpty() && until.isEmpty()) return true;
        try {
            LocalTime time = now.toLocalTime();
            LocalTime start = from.isEmpty() ? LocalTime.MIN : LocalTime.parse(from);
            LocalTime end = until.isEmpty() ? LocalTime.MAX : LocalTime.parse(until);
            // A window such as 22:00 to 02:00 crosses midnight.
            return start.isAfter(end) ? !time.isBefore(start) || time.isBefore(end) : !time.isBefore(start) && time.isBefore(end);
        } catch (RuntimeException error) {
            return false;
        }
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
            JSONArray files = event.optJSONArray("files");
            for (int f = 0; files != null && f < files.length(); f++) {
                JSONObject file = files.optJSONObject(f);
                File stored = new File(file != null ? file.optString("path") : "");
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
