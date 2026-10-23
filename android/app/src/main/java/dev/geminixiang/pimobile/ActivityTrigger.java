package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
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
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent intent(Context context) {
        Intent intent = new Intent(context, TriggerReceiver.class).setAction(ACTION).setData(Uri.parse("pimobile-activity://transitions"));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static final String PREFS = "pi-trigger-activity";
    private static final String KEY_ARMED = "armed";

    @SuppressWarnings("MissingPermission")
    static void arm(Context context, boolean wanted) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!allowed(context)) {
            if (wanted) Log.w(TAG, "activity trigger: no activity recognition permission");
            return;
        }
        if (!wanted) {
            if (!prefs.getBoolean(KEY_ARMED, false)) return;
            prefs.edit().putBoolean(KEY_ARMED, false).apply();
            ActivityRecognition.getClient(context).removeActivityTransitionUpdates(intent(context))
                .addOnFailureListener(error -> Log.w(TAG, "activity trigger: could not stop", error));
            return;
        }
        prefs.edit().putBoolean(KEY_ARMED, true).apply();
        List<ActivityTransition> transitions = new ArrayList<>();
        for (Kind kind : Kind.values()) {
            transitions.add(new ActivityTransition.Builder().setActivityType(kind.type).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build());
            transitions.add(new ActivityTransition.Builder().setActivityType(kind.type).setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build());
        }
        ActivityRecognition.getClient(context).requestActivityTransitionUpdates(new ActivityTransitionRequest(transitions), intent(context))
            .addOnFailureListener(error -> Log.w(TAG, "activity trigger: could not start", error));
    }

    static void receive(Context context, Intent intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        long now = SystemClock.elapsedRealtimeNanos();
        for (ActivityTransitionEvent event : result.getTransitionEvents()) {
            Kind kind = Kind.of(event.getActivityType());
            if (kind == null || (now - event.getElapsedRealTimeNanos()) / 1_000_000 > STALE_MS) continue;
            boolean started = event.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER;
            String phase = started ? "start" : "stop";
            TriggerReceiver.event(context, "activity", started ? kind.started : kind.stopped, item -> {
                org.json.JSONObject when = item.optJSONObject("when");
                return kind.name.equals(when.optString("activity")) && phase.equals(when.optString("on"));
            });
        }
    }
}
