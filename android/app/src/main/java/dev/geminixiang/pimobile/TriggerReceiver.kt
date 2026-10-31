package dev.geminixiang.pimobile

import android.app.Notification
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.provider.Settings
import android.util.Log
import com.getcapacitor.JSObject
import java.util.Locale
import java.util.TimeZone

private const val NOTIFICATION_TEXT_LIMIT = 500

class TriggerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_FIRE -> intent.getStringExtra(EXTRA_ID)?.let { TriggerStore.schedule(context, it) }?.let { fire(context, it, null) }
            ACTION_PLACE -> place(context, intent)
            ActivityTrigger.ACTION -> ActivityTrigger.receive(context, intent)
            else -> {
                TriggerStore.armAll(context)
                if (intent.action == Intent.ACTION_TIMEZONE_CHANGED) timezone(context, intent.getStringExtra(Intent.EXTRA_TIMEZONE))
            }
        }
    }

    companion object {
        @JvmStatic
        fun headphones(context: Context, device: String) = event(context, "headphones", device) { it.trigger is When.Headphones }

        @JvmStatic
        fun bluetooth(context: Context, device: String, connected: Boolean) =
            event(context, "bluetooth", (if (connected) "連上藍牙 " else "斷開藍牙 ") + device) {
                val bluetooth = it.trigger
                bluetooth is When.Bluetooth && bluetooth.connect == connected && includes(device, bluetooth.device)
            }

        @JvmStatic
        fun notification(context: Context, row: NotificationStore.Row) {
            val from = if (row.sender.isNullOrEmpty()) row.title else row.sender
            val body = if (row.text.length > NOTIFICATION_TEXT_LIMIT) row.text.take(NOTIFICATION_TEXT_LIMIT) + "…" else row.text
            event(context, "notification", "收到 ${row.app} 的通知：" + (if (from.isNullOrEmpty()) "" else "$from：") + body) {
                val wanted = it.trigger
                if (wanted !is When.Notification) return@event false
                val app = wanted.app
                val contains = wanted.contains
                val appMatches = app == null || includes(row.app, app) || includes(row.packageName, app)
                val textMatches = contains == null || listOf(row.title, row.text, row.sender, row.conversation).any { part -> includes(part, contains) }
                appMatches && textMatches
            }
        }

        internal fun wifi(context: Context) {
            val name = TriggerEvents.wifiName(context)
            event(context, "wifi", if (name != null) "連上 Wi-Fi $name" else "連上 Wi-Fi") {
                val wifi = it.trigger
                wifi is When.Wifi && (wifi.ssid == null || wifi.ssid.equals(name, ignoreCase = true))
            }
        }

        internal fun event(context: Context, kind: String, detail: String, matches: (Schedule) -> Boolean) {
            for (schedule in TriggerStore.due(context, matches)) fire(context, schedule, detail)
            Log.i(TRIGGERS_TAG, "$kind event" + if (kind == "notification") "" else ": $detail")
        }

        private fun timezone(context: Context, id: String?) {
            val zone = if (id != null) TimeZone.getTimeZone(id) else TimeZone.getDefault()
            event(context, "timezone", "時區改成 ${zone.id}（${zone.getDisplayName(Locale.TRADITIONAL_CHINESE)}）") { it.trigger is When.Timezone }
        }

        private fun place(context: Context, intent: Intent) {
            val id = intent.getStringExtra(EXTRA_ID) ?: return
            val entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false)
            val place = TriggerStore.schedule(context, id)?.trigger
            if (place !is When.Place || place.arrive != entering) return
            if (TriggerEvents.settling(context, id)) {
                Log.i(TRIGGERS_TAG, "place $id: ${if (entering) "inside" else "outside"} when armed, not an event")
                return
            }
            event(context, "place", (if (entering) "到了 " else "離開 ") + place.label) { it.id == id }
        }

        private fun fire(context: Context, schedule: Schedule, detail: String?) {
            val live = TriggersPlugin.live()
            val quiet = live == null && startQuietly(context, schedule.name)
            val event = JSObject().put("kind", "alarm").put("trigger", schedule.id).put("live", live != null || quiet)
            if (detail != null) event.put("device", detail)
            TriggerStore.enqueue(context, event)
            when (schedule.trigger) {
                is When.Once -> TriggerStore.remove(context, schedule.id)
                is When.Daily -> TriggerStore.arm(context, schedule)
                is When.Event -> {}
            }
            Log.i(TRIGGERS_TAG, "fired ${schedule.id}" + if (live != null) " (live)" else if (quiet) " (started quietly)" else " (no WebView)")
            if (live != null) {
                live.wake(schedule.name)
                return
            }
            if (quiet) return
            AgentService.createChannels(context)
            val notification =
                Notification.Builder(context, AgentService.CHANNEL_PROACTIVE)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setLargeIcon(AgentService.avatar(context, schedule.avatar))
                    .setContentTitle(schedule.name)
                    .setContentText("點一下開始")
                    .setContentIntent(AgentService.openApp(context))
                    .setAutoCancel(true)
                    .build()
            context.getSystemService(NotificationManager::class.java).notify(TriggersPlugin.waitingNotificationId(schedule.id), notification)
        }

        private fun startQuietly(context: Context, name: String): Boolean {
            if (!Settings.canDrawOverlays(context)) return false
            try {
                context.startActivity(
                    Intent(context, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                        .putExtra(MainActivity.EXTRA_QUIET, true),
                )
            } catch (error: RuntimeException) {
                Log.w(TRIGGERS_TAG, "could not start pi quietly", error)
                return false
            }
            try {
                context.startForegroundService(Intent(context, AgentService::class.java).putExtra(AgentService.EXTRA_TEXT, name))
            } catch (error: RuntimeException) {
                Log.w(TRIGGERS_TAG, "started pi quietly without its foreground service", error)
            }
            return true
        }

        private fun includes(value: String?, part: String) = value != null && value.lowercase(Locale.ROOT).contains(part.lowercase(Locale.ROOT))
    }
}
