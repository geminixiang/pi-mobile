package dev.geminixiang.pimobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

private const val STALE_MS = 10 * 60_000L
private const val SETTLE_NANOS = 60_000_000_000L
private const val PREFS = "pi-trigger-activity"
private const val KEY_ARMED = "registration"
private const val KEY_ARMED_AT = "registered.at"

object ActivityTrigger {
    internal const val ACTION = "dev.geminixiang.pimobile.TRIGGER_ACTIVITY"

    private enum class Kind(val type: Int, val named: String, val started: String, val stopped: String) {
        WALKING(DetectedActivity.WALKING, "walking", "開始走路", "停止走路"),
        RUNNING(DetectedActivity.RUNNING, "running", "開始跑步", "停止跑步"),
        CYCLING(DetectedActivity.ON_BICYCLE, "cycling", "開始騎車", "停止騎車"),
        VEHICLE(DetectedActivity.IN_VEHICLE, "vehicle", "上車", "下車"),
        STILL(DetectedActivity.STILL, "still", "靜止下來", "開始移動"),
    }

    private fun intent(context: Context): PendingIntent {
        val intent = Intent(context, TriggerReceiver::class.java).setAction(ACTION).setData(Uri.parse("pimobile-activity://transitions"))
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun registration(context: Context): String {
        val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, 0)
        val installed = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        return "$boot@$installed"
    }

    @SuppressLint("MissingPermission")
    internal fun arm(context: Context, wanted: Boolean) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            if (wanted) Log.w(TRIGGERS_TAG, "activity trigger: no activity recognition permission")
            return
        }
        val armed = prefs.getString(KEY_ARMED, "").orEmpty()
        val client = ActivityRecognition.getClient(context)
        if (!wanted) {
            if (armed.isEmpty()) return
            prefs.edit().remove(KEY_ARMED).apply()
            client.removeActivityTransitionUpdates(intent(context)).addOnFailureListener { Log.w(TRIGGERS_TAG, "activity trigger: could not stop", it) }
            return
        }
        val current = registration(context)
        if (armed == current) return
        val transitions =
            Kind.entries.flatMap { kind ->
                listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map {
                    ActivityTransition.Builder().setActivityType(kind.type).setActivityTransition(it).build()
                }
            }
        client
            .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), intent(context))
            .addOnSuccessListener { prefs.edit().putString(KEY_ARMED, current).putLong(KEY_ARMED_AT, SystemClock.elapsedRealtimeNanos()).apply() }
            .addOnFailureListener { Log.w(TRIGGERS_TAG, "activity trigger: could not start", it) }
    }

    internal fun receive(context: Context, intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val now = SystemClock.elapsedRealtimeNanos()
        val armedAt = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_ARMED_AT, 0)
        for (event in result.transitionEvents) {
            val kind = Kind.entries.firstOrNull { it.type == event.activityType } ?: continue
            if ((now - event.elapsedRealTimeNanos) / 1_000_000 > STALE_MS) continue
            if (event.elapsedRealTimeNanos - armedAt < SETTLE_NANOS) {
                Log.i(TRIGGERS_TAG, "activity ${kind.named}: the state when armed, not an event")
                continue
            }
            val started = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
            TriggerReceiver.event(context, "activity", if (started) kind.started else kind.stopped) {
                val wanted = it.trigger
                wanted is When.Activity && wanted.activity == kind.named && wanted.start == started
            }
        }
    }
}
