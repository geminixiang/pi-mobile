package dev.geminixiang.pimobile

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.util.Log

class DndReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != NotificationsPlugin.ACTION_DND_END) return
        val listener = NotificationsListener.instance
        if (listener != null) {
            end(context, listener)
            return
        }
        context.getSharedPreferences(NotificationsPlugin.DND_PREFS, 0).edit().putBoolean(PENDING, true).apply()
        NotificationListenerService.requestRebind(ComponentName(context, NotificationsListener::class.java))
        Log.i("PiDnd", "listener not bound; ending Do Not Disturb when it connects")
    }

    companion object {
        internal const val PENDING = "pending-end"

        internal fun end(context: Context, listener: NotificationsListener) {
            listener.requestInterruptionFilter(NotificationListenerService.INTERRUPTION_FILTER_ALL)
            context
                .getSharedPreferences(NotificationsPlugin.DND_PREFS, 0)
                .edit()
                .putLong(NotificationsPlugin.DND_UNTIL, 0)
                .putBoolean(PENDING, false)
                .apply()
        }
    }
}
