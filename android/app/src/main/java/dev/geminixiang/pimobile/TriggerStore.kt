package dev.geminixiang.pimobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.getcapacitor.JSObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZonedDateTime
import java.util.UUID
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal const val ACTION_FIRE = "dev.geminixiang.pimobile.TRIGGER_FIRE"
internal const val EXTRA_ID = "id"
internal const val TRIGGERS_TAG = "PiTriggers"
private const val PREFS = "pi-triggers"
private const val KEY_SCHEDULES = "schedules"
private const val KEY_EVENTS = "events"
private const val KEY_LAST = "last."
private const val KEY_BEFORE = "before."
private const val HOUR_MS = 60 * 60 * 1000L

object TriggerStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun stored(context: Context, key: String): JSONArray =
        try {
            JSONArray(prefs(context).getString(key, "[]"))
        } catch (error: JSONException) {
            Log.w(TRIGGERS_TAG, "dropping unreadable $key", error)
            JSONArray()
        }

    @Synchronized
    internal fun schedules(context: Context): List<Schedule> =
        stored(context, KEY_SCHEDULES).objects().mapNotNull { json ->
            try {
                Schedule.of(json)
            } catch (error: Exception) {
                Log.w(TRIGGERS_TAG, "dropping unreadable schedule ${json.optString("id")}", error)
                null
            }
        }

    internal fun schedule(context: Context, id: String) = schedules(context).firstOrNull { it.id == id }

    @Synchronized
    internal fun replace(context: Context, next: JSONArray): JSObject {
        val kept = next.objects().map { it.getString("id") }.toSet()
        for (old in schedules(context)) if (old.id !in kept) cancelAlarm(context, old.id)
        prefs(context).edit().putString(KEY_SCHEDULES, next.toString()).apply()
        ReportsWidget.refreshAll(context)
        return armAll(context)
    }

    @Synchronized
    internal fun remove(context: Context, id: String) {
        val kept = stored(context, KEY_SCHEDULES).objects().filter { it.getString("id") != id }
        prefs(context).edit().putString(KEY_SCHEDULES, JSONArray(kept).toString()).apply()
        cancelAlarm(context, id)
    }

    @JvmStatic
    @Synchronized
    fun armAll(context: Context): JSObject {
        val all = schedules(context)
        TriggerEvents.sync(context, all)
        val times = JSObject()
        for (schedule in all) arm(context, schedule)?.let { times.put(schedule.id, it) }
        return times
    }

    internal fun arm(context: Context, schedule: Schedule): Long? {
        val at = schedule.trigger.nextTime(ZonedDateTime.now())
        if (at == null) {
            cancelAlarm(context, schedule.id)
            return null
        }
        val alarms = context.getSystemService(AlarmManager::class.java)
        val fire = fireIntent(context, schedule.id)
        if (alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire)
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire)
        return at
    }

    private fun fireIntent(context: Context, id: String): PendingIntent {
        val intent = Intent(context, TriggerReceiver::class.java).setAction(ACTION_FIRE).setData(Uri.parse("pimobile-trigger://" + Uri.encode(id))).putExtra(EXTRA_ID, id)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun cancelAlarm(context: Context, id: String) = context.getSystemService(AlarmManager::class.java).cancel(fireIntent(context, id))

    @Synchronized
    internal fun due(context: Context, matches: (Schedule) -> Boolean): List<Schedule> {
        val now = ZonedDateTime.now()
        val nowMs = now.toInstant().toEpochMilli()
        val prefs = prefs(context)
        val editor = prefs.edit()
        val due = mutableListOf<Schedule>()
        for (schedule in schedules(context)) {
            val event = schedule.trigger
            if (event !is When.Event || !matches(schedule) || !event.window.contains(now)) continue
            val last = prefs.getLong(KEY_LAST + schedule.id, 0)
            val waited =
                if (event.window.gapHours >= 24) last == 0L || Instant.ofEpochMilli(last).atZone(now.zone).toLocalDate() != now.toLocalDate()
                else nowMs - last >= event.window.gapHours * HOUR_MS
            if (!waited) continue
            editor.putLong(KEY_BEFORE + schedule.id, last).putLong(KEY_LAST + schedule.id, nowMs)
            due.add(schedule)
        }
        editor.apply()
        return due
    }

    @Synchronized
    internal fun giveBackGap(context: Context, id: String) {
        val prefs = prefs(context)
        if (!prefs.contains(KEY_BEFORE + id)) return
        prefs.edit().putLong(KEY_LAST + id, prefs.getLong(KEY_BEFORE + id, 0)).remove(KEY_BEFORE + id).apply()
    }

    @JvmStatic
    @Synchronized
    fun enqueue(context: Context, event: JSObject): JSONObject {
        event.put("id", UUID.randomUUID().toString()).put("at", System.currentTimeMillis())
        val events = stored(context, KEY_EVENTS).put(event)
        prefs(context).edit().putString(KEY_EVENTS, events.toString()).apply()
        return event
    }

    @Synchronized
    internal fun events(context: Context): JSONArray = stored(context, KEY_EVENTS)

    @Synchronized
    internal fun ack(context: Context, ids: Set<String>) {
        val (done, kept) = stored(context, KEY_EVENTS).objects().partition { it.optString("id") in ids }
        for (event in done) {
            val files = event.optJSONArray("files") ?: continue
            for (file in files.objects()) {
                val stored = File(file.getString("path"))
                if (inInbox(context, stored) && !stored.delete()) Log.w(TRIGGERS_TAG, "could not delete $stored")
            }
        }
        prefs(context).edit().putString(KEY_EVENTS, JSONArray(kept).toString()).apply()
    }

    @JvmStatic
    fun inbox(context: Context): File {
        val dir = File(context.filesDir, "inbox")
        if (!dir.isDirectory && !dir.mkdirs()) Log.w(TRIGGERS_TAG, "could not create $dir")
        return dir
    }

    private fun inInbox(context: Context, file: File) =
        try {
            file.canonicalFile.parentFile == inbox(context).canonicalFile
        } catch (error: IOException) {
            Log.w(TRIGGERS_TAG, "could not resolve $file", error)
            false
        }
}

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull(::optJSONObject)
