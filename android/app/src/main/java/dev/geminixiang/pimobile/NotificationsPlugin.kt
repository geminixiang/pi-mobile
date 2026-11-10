package dev.geminixiang.pimobile

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Bundle
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONException
import java.util.Locale

@CapacitorPlugin(name = "Notifications")
class NotificationsPlugin : Plugin() {
    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(JSObject().put("allowed", NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)))
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent =
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                ComponentName(context, NotificationsListener::class.java).flattenToString(),
            )
        SystemPlugin.openSettings(context, intent, Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        call.resolve()
    }

    @PluginMethod
    fun list(call: PluginCall) =
        Background.run(call) {
            val since = call.data.optLong("since", System.currentTimeMillis() - 24 * 3600_000L)
            val limit = maxOf(0, call.getInt("limit") ?: 0)
            val rows = NotificationStore.get(context).list(since, call.getString("app"), call.getString("query"), limit)
            val items = JSArray()
            rows.forEach { row ->
                val item = JSObject()
                item.put("package", row.packageName)
                item.put("app", row.app)
                row.conversation?.let { item.put("conversation", it) }
                if (!row.sender.isNullOrEmpty()) item.put("sender", row.sender)
                item.put("title", row.title)
                item.put("text", row.text)
                item.put("time", row.time)
                items.put(item)
            }
            call.resolve(JSObject().put("items", items))
        }

    @PluginMethod
    fun clear(call: PluginCall) {
        NotificationStore.get(context).clear()
        call.resolve()
    }

    private fun listener(call: PluginCall): NotificationsListener? {
        val listener = NotificationsListener.instance
        if (listener == null) call.reject("notification access is off")
        return listener
    }

    private fun matches(listener: NotificationsListener, sbn: StatusBarNotification, app: String, conversation: String?): Boolean {
        val label = listener.appLabel(sbn.packageName).lowercase(Locale.ROOT)
        val needle = app.lowercase(Locale.ROOT)
        if (!label.contains(needle) && !sbn.packageName.lowercase(Locale.ROOT).contains(needle)) return false
        if (conversation.isNullOrEmpty()) return true
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE).toString()
        val chat = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE).toString()
        val wanted = conversation.lowercase(Locale.ROOT)
        return title.lowercase(Locale.ROOT).contains(wanted) || chat.lowercase(Locale.ROOT).contains(wanted)
    }

    @PluginMethod
    fun active(call: PluginCall) =
        Background.run(call) {
            val listener = listener(call) ?: return@run
            val items = JSArray()
            listener.activeNotifications
                .orEmpty()
                .sortedByDescending { it.postTime }
                .filter { it.packageName != context.packageName }
                .filter { matches(listener, it, call.getString("app", "").orEmpty(), call.getString("conversation")) }
                .forEach { sbn ->
                    val extras = sbn.notification.extras
                    val item = JSObject()
                    item.put("key", sbn.key)
                    item.put("app", listener.appLabel(sbn.packageName))
                    item.put("title", extras.getCharSequence(Notification.EXTRA_TITLE, "").toString())
                    item.put("text", extras.getCharSequence(Notification.EXTRA_TEXT, "").toString())
                    item.put("time", sbn.postTime)
                    item.put("canReply", replyAction(sbn) != null)
                    item.put("clearable", sbn.isClearable)
                    items.put(item)
                }
            call.resolve(JSObject().put("items", items))
        }

    @PluginMethod
    fun reply(call: PluginCall) {
        val listener = listener(call) ?: return
        val key = call.getString("key", "").orEmpty()
        val active = listener.getActiveNotifications(arrayOf(key))
        if (active.isNullOrEmpty()) {
            call.reject("that notification is gone")
            return
        }
        val action = replyAction(active[0])
        if (action == null) {
            call.reject("that notification takes no reply")
            return
        }
        val inputs = action.remoteInputs ?: emptyArray()
        val fill = Intent()
        val results = Bundle()
        inputs.forEach { results.putCharSequence(it.resultKey, call.getString("text", "")) }
        RemoteInput.addResultsToIntent(inputs, fill, results)
        try {
            action.actionIntent.send(context, 0, fill)
            call.resolve()
        } catch (error: PendingIntent.CanceledException) {
            call.reject("the app no longer takes this reply")
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        val listener = listener(call) ?: return
        val keys = call.getArray("keys") ?: JSArray()
        try {
            for (i in 0 until keys.length()) listener.cancelNotification(keys.getString(i))
        } catch (error: JSONException) {
            call.reject("keys must be strings")
            return
        }
        call.resolve()
    }

    private fun sessions(): List<MediaController> =
        context.getSystemService(MediaSessionManager::class.java).getActiveSessions(ComponentName(context, NotificationsListener::class.java))

    @PluginMethod
    fun media(call: PluginCall) {
        val listener = listener(call) ?: return
        val items = JSArray()
        sessions().forEach { controller ->
            val item = JSObject()
            item.put("package", controller.packageName)
            item.put("app", listener.appLabel(controller.packageName))
            item.put("state", stateName(controller.playbackState))
            controller.metadata?.let { metadata ->
                item.put("title", metadata.getString(MediaMetadata.METADATA_KEY_TITLE))
                item.put("artist", metadata.getString(MediaMetadata.METADATA_KEY_ARTIST))
                item.put("album", metadata.getString(MediaMetadata.METADATA_KEY_ALBUM))
                item.put("durationMs", metadata.getLong(MediaMetadata.METADATA_KEY_DURATION))
            }
            controller.playbackState?.let { item.put("positionMs", it.position) }
            items.put(item)
        }
        call.resolve(JSObject().put("items", items))
    }

    @PluginMethod
    fun mediaControl(call: PluginCall) {
        if (listener(call) == null) return
        val target = call.getString("package")
        val controller = sessions().firstOrNull { target.isNullOrEmpty() || it.packageName == target }
        if (controller == null) {
            call.reject("nothing is playing")
            return
        }
        val controls = controller.transportControls
        when (call.getString("action", "")) {
            "play" -> controls.play()
            "pause" -> controls.pause()
            "next" -> controls.skipToNext()
            "previous" -> controls.skipToPrevious()
            "stop" -> controls.stop()
            else -> {
                call.reject("unknown action")
                return
            }
        }
        call.resolve(JSObject().put("package", controller.packageName))
    }

    @PluginMethod
    fun dnd(call: PluginCall) {
        val filter = context.getSystemService(NotificationManager::class.java).currentInterruptionFilter
        val result = JSObject()
        result.put("mode", DND_NAMES.getOrElse(filter) { "unknown" })
        result.put("until", context.getSharedPreferences(DND_PREFS, 0).getLong(DND_UNTIL, 0))
        call.resolve(result)
    }

    @PluginMethod
    fun setDnd(call: PluginCall) {
        val listener = listener(call) ?: return
        val filter = DND_NAMES.indexOf(call.getString("mode", ""))
        if (filter < 1) {
            call.reject("mode is off, priority, alarms, or silent")
            return
        }
        listener.requestInterruptionFilter(filter)
        val alarms = context.getSystemService(AlarmManager::class.java)
        val end =
            PendingIntent.getBroadcast(
                context,
                0,
                Intent(context, DndReceiver::class.java).setAction(ACTION_DND_END),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val requested = call.data.optLong("until", 0L)
        alarms.cancel(end)
        val until =
            if (filter != NotificationListenerService.INTERRUPTION_FILTER_ALL && requested > System.currentTimeMillis()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, requested, end)
                requested
            } else {
                0L
            }
        context.getSharedPreferences(DND_PREFS, 0).edit().putLong(DND_UNTIL, until).apply()
        call.resolve()
    }

    companion object {
        internal const val DND_PREFS = "pi-dnd"
        internal const val DND_UNTIL = "until"
        internal const val ACTION_DND_END = "dev.geminixiang.pimobile.DND_END"

        private val DND_NAMES = listOf("unknown", "off", "priority", "silent", "alarms")

        private fun replyAction(sbn: StatusBarNotification): Notification.Action? =
            sbn.notification.actions?.firstOrNull { action -> action.remoteInputs?.any { it.allowFreeFormInput } == true }

        private fun stateName(state: PlaybackState?): String =
            when (state?.state) {
                null -> "none"
                PlaybackState.STATE_PLAYING -> "playing"
                PlaybackState.STATE_PAUSED -> "paused"
                PlaybackState.STATE_BUFFERING -> "buffering"
                PlaybackState.STATE_STOPPED -> "stopped"
                else -> "other"
            }
    }
}
