package dev.geminixiang.pimobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.net.Uri
import android.os.IBinder
import android.os.PowerManager
import java.io.IOException

class AgentService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    private fun build(title: String, text: String): Notification =
        Notification.Builder(this, CHANNEL_WORKING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(this))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty()
        createChannels(this)
        startForeground(NOTIFICATION_ID, build("pi 工作中", text), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        val lock =
            wakeLock ?: getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:agent").also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
        lock.acquire(WAKE_LOCK_TIMEOUT_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        internal const val CHANNEL_WORKING = "agent-working"
        internal const val CHANNEL_DONE = "agent-done-knock"
        internal const val CHANNEL_PROACTIVE = "agent-proactive-knock"
        internal const val ACTION_STOP = "dev.geminixiang.pimobile.AGENT_STOP"
        internal const val EXTRA_TEXT = "text"
        private const val NOTIFICATION_ID = 1
        private const val WAKE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000L
        private val AVATAR_ID = Regex("[a-z]+")
        private val SOUND: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()

        private fun sound(context: Context, name: String): Uri = Uri.parse("android.resource://${context.packageName}/raw/$name")

        internal fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val working =
                NotificationChannel(CHANNEL_WORKING, "pi 工作中", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "agent 在背景執行時顯示"
                    setShowBadge(false)
                }
            val done =
                NotificationChannel(CHANNEL_DONE, "pi 完成", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "app 不在前景時，agent 完成"
                    setSound(sound(context, "pi_done"), SOUND)
                }
            val proactive =
                NotificationChannel(CHANNEL_PROACTIVE, "pi 主動通知", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "自動化執行的結果"
                    setSound(sound(context, "pi_knock"), SOUND)
                }
            manager.createNotificationChannels(listOf(working, done, proactive))
            manager.deleteNotificationChannel("agent-done")
            manager.deleteNotificationChannel("agent-proactive")
        }

        internal fun avatar(context: Context, id: String?): Icon? {
            if (id == null || !AVATAR_ID.matches(id)) return null
            return try {
                context.assets.open("public/avatars/$id.webp").use { BitmapFactory.decodeStream(it) }?.let { Icon.createWithBitmap(it) }
            } catch (error: IOException) {
                null
            }
        }

        internal fun openApp(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
