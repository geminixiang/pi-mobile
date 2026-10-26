package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.ActivityTransitionResult;
import com.google.android.gms.location.DetectedActivity;
import java.util.ArrayList;
import java.util.List;

final class ActivityTrigger {

    static final String ACTION = "dev.geminixiang.pimobile.TRIGGER_ACTIVITY";
    private static final String TAG = "PiTriggers";
    private static final long STALE_MS = 10 * 60_000L;

    private enum Kind {
        WALKING(DetectedActivity.WALKING, "walking", "開始走路", "停止走路"),
        RUNNING(DetectedActivity.RUNNING, "running", "開始跑步", "停止跑步"),
        CYCLING(DetectedActivity.ON_BICYCLE, "cycling", "開始騎車", "停止騎車"),
        VEHICLE(DetectedActivity.IN_VEHICLE, "vehicle", "上車", "下車"),
        STILL(DetectedActivity.STILL, "still", "靜止下來", "開始移動");

        final int type;
        final String name;
        final String started;
        final String stopped;

        Kind(int type, String name, String started, String stopped) {
            this.type = type;
            this.name = name;
            this.started = started;
            this.stopped = stopped;
        }

        static Kind of(int type) {
            for (Kind kind : values()) if (kind.type == type) return kind;
            return null;
        }
    }

    private ActivityTrigger() {}

    private static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent intent(Context context) {
        Intent intent = new Intent(context, TriggerReceiver.class).setAction(ACTION).setData(Uri.parse("pimobile-activity://transitions"));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static final String PREFS = "pi-trigger-activity";
    private static final String KEY_ARMED = "registration";
    private static final String KEY_ARMED_AT = "registered.at";
    private static final long SETTLE_NANOS = 60_000_000_000L;

    private static String registration(Context context) {
        int boot = android.provider.Settings.Global.getInt(context.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, 0);
        long installed;
        try {
            installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException error) {
            installed = 0;
        }
        return boot + "@" + installed;
    }

    @SuppressWarnings("MissingPermission")
    static void arm(Context context, boolean wanted) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!allowed(context)) {
            if (wanted) Log.w(TAG, "activity trigger: no activity recognition permission");
            return;
        }
        String current = registration(context);
        String armed = prefs.getString(KEY_ARMED, "");
        if (!wanted) {
            if (armed.isEmpty()) return;
            prefs.edit().remove(KEY_ARMED).apply();
            ActivityRecognition.getClient(context).removeActivityTransitionUpdates(intent(context))
                .addOnFailureListener(error -> Log.w(TAG, "activity trigger: could not stop", error));
            return;
        }
        if (armed.equals(current)) return;
        List<ActivityTransition> transitions = new ArrayList<>();
        for (Kind kind : Kind.values()) {
            transitions.add(new ActivityTransition.Builder().setActivityType(kind.type).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build());
            transitions.add(new ActivityTransition.Builder().setActivityType(kind.type).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build());
        }
        ActivityRecognition.getClient(context).requestActivityTransitionUpdates(new ActivityTransitionRequest(transitions), intent(context))
            .addOnSuccessListener(done -> prefs.edit().putString(KEY_ARMED, current).putLong(KEY_ARMED_AT, SystemClock.elapsedRealtimeNanos()).apply())
            .addOnFailureListener(error -> Log.w(TAG, "activity trigger: could not start", error));
    }

    static void receive(Context context, Intent intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        long now = SystemClock.elapsedRealtimeNanos();
        long armedAt = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_ARMED_AT, 0);
        for (ActivityTransitionEvent event : result.getTransitionEvents()) {
            Kind kind = Kind.of(event.getActivityType());
            if (kind == null || (now - event.getElapsedRealTimeNanos()) / 1_000_000 > STALE_MS) continue;
            if (event.getElapsedRealTimeNanos() - armedAt < SETTLE_NANOS) {
                Log.i(TAG, "activity " + kind.name + ": the state when armed, not an event");
                continue;
            }
            boolean started = event.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER;
            String phase = started ? "start" : "stop";
            TriggerReceiver.event(context, "activity", started ? kind.started : kind.stopped, item -> {
                org.json.JSONObject when = item.optJSONObject("when");
                return kind.name.equals(when.optString("activity")) && phase.equals(when.optString("on"));
            });
        }
    }
}
