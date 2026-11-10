package dev.geminixiang.pimobile

import android.app.Notification
import android.content.pm.PackageManager
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

class NotificationsListener : NotificationListenerService() {
    override fun onListenerDisconnected() {
        instance = null
    }

    override fun onListenerConnected() {
        instance = this
        WhileRunningTriggers.listen(this)
        if (getSharedPreferences(NotificationsPlugin.DND_PREFS, 0).getBoolean(DndReceiver.PENDING, false)) DndReceiver.end(this, this)
        try {
            val rows = activeNotifications.orEmpty().flatMap { rowsOf(it) }
            NotificationStore.get(this).add(rows)
        } catch (error: RuntimeException) {
            Log.w("pi.notifications", "could not record the notifications showing at connect", error)
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        NotificationStore.get(this).add(rowsOf(sbn)).forEach { TriggerReceiver.notification(this, it) }
    }

    private fun rowsOf(sbn: StatusBarNotification): List<NotificationStore.Row> {
        val notification = sbn.notification
        val packageName = sbn.packageName
        val skip = Notification.FLAG_ONGOING_EVENT or Notification.FLAG_FOREGROUND_SERVICE or Notification.FLAG_GROUP_SUMMARY
        if (this.packageName == packageName || (notification.flags and skip) != 0) return emptyList()
        val extras = notification.extras
        val app = appLabel(packageName)
        val title = text(extras.getCharSequence(Notification.EXTRA_TITLE))
        val conversation = text(extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE))

        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES, Parcelable::class.java)
        if (!messages.isNullOrEmpty()) {
            return Notification.MessagingStyle.Message.getMessagesFromBundleArray(messages).mapNotNull { message ->
                val body = text(message.text)
                if (body.isEmpty()) return@mapNotNull null
                val chat = conversation.ifEmpty { title }
                val sender = text(message.senderPerson?.name)
                val time = if (message.timestamp > 0) message.timestamp else sbn.postTime
                NotificationStore.Row(
                    packageName = packageName,
                    app = app,
                    conversation = chat,
                    sender = sender,
                    title = title,
                    text = body,
                    time = time,
                    dedup = "$packageName\u0000$chat\u0000$sender\u0000$time\u0000$body",
                )
            }
        }

        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        val body =
            if (!lines.isNullOrEmpty()) {
                lines.joinToString("\n").trimStart('\n')
            } else {
                text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))
            }
        if (title.isEmpty() && body.isEmpty()) return emptyList()
        return listOf(
            NotificationStore.Row(
                packageName = packageName,
                app = app,
                conversation = conversation.ifEmpty { null },
                sender = null,
                title = title,
                text = body,
                time = sbn.postTime,
                dedup = "$packageName\u0000${sbn.key}\u0000$title\u0000$body",
            ),
        )
    }

    internal fun appLabel(packageName: String): String = appLabel(packageManager, packageName)

    companion object {
        @Volatile
        internal var instance: NotificationsListener? = null

        @JvmStatic
        fun appLabel(manager: PackageManager, packageName: String): String =
            try {
                manager.getApplicationLabel(manager.getApplicationInfo(packageName, 0)).toString()
            } catch (e: PackageManager.NameNotFoundException) {
                packageName
            }

        private fun text(value: CharSequence?): String = value?.toString()?.trim().orEmpty()
    }
}
