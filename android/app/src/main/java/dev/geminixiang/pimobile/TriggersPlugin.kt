package dev.geminixiang.pimobile

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

private const val MAX_SHARED_BYTES = 20L * 1024 * 1024
private const val IN_BACKGROUND = "while it is in the background. Ask the user to open pi."

@CapacitorPlugin(
    name = "Triggers",
    permissions = [
        Permission(strings = ["android.permission.BLUETOOTH_CONNECT"], alias = "bluetooth"),
        Permission(strings = ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"], alias = "location"),
        Permission(strings = ["android.permission.ACCESS_BACKGROUND_LOCATION"], alias = "background"),
        Permission(strings = ["android.permission.READ_MEDIA_IMAGES"], alias = "photos"),
        Permission(strings = ["android.permission.ACTIVITY_RECOGNITION"], alias = "activity"),
    ],
)
class TriggersPlugin : Plugin() {
    override fun load() {
        current = this
        receiveShare(activity.intent)
        WhileRunningTriggers.listen(context)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        receiveShare(intent)
    }

    override fun handleOnDestroy() {
        if (current === this) current = null
        super.handleOnDestroy()
    }

    fun announce() = notifyListeners("event", JSObject(), true)

    internal fun wake(text: String) {
        try {
            context.startForegroundService(Intent(context, AgentService::class.java).putExtra(AgentService.EXTRA_TEXT, text))
        } catch (error: RuntimeException) {
            Log.w(TRIGGERS_TAG, "could not start the foreground service", error)
        }
        activity.runOnUiThread { KeepAlivePlugin.keepWebViewRunning(bridge.webView, true) }
        announce()
    }

    @PluginMethod
    fun sync(call: PluginCall) = call.resolve(JSObject().put("next", TriggerStore.replace(context, call.getArray("schedules") ?: JSArray())))

    @PluginMethod
    fun events(call: PluginCall) = call.resolve(JSObject().put("events", TriggerStore.events(context)))

    @PluginMethod
    fun ack(call: PluginCall) {
        val ids = call.getArray("ids") ?: JSArray()
        TriggerStore.ack(context, (0 until ids.length()).map(ids::getString).toSet())
        call.resolve()
    }

    @PluginMethod
    fun started(call: PluginCall) {
        context.getSystemService(NotificationManager::class.java).cancel(waitingNotificationId(call.getString("trigger").orEmpty()))
        call.resolve()
    }

    @PluginMethod
    fun skipped(call: PluginCall) {
        TriggerStore.giveBackGap(context, call.getString("trigger").orEmpty())
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) =
        call.resolve(JSObject().put("exactAlarms", context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()).put("bluetooth", granted("bluetooth")))

    @PluginMethod
    fun requestLocationAlways(call: PluginCall) {
        if (TriggerEvents.backgroundLocation(context)) return locationResult(call)
        if (!inFront(activity)) return call.reject("pi cannot ask for location $IN_BACKGROUND")
        if (!granted("location")) requestPermissionForAlias("location", call, "foregroundResult") else requestPermissionForAlias("background", call, "locationResult")
    }

    @PermissionCallback
    private fun foregroundResult(call: PluginCall) {
        if (granted("location")) requestPermissionForAlias("background", call, "locationResult") else locationResult(call)
    }

    @PermissionCallback
    private fun locationResult(call: PluginCall) {
        call.resolve(JSObject().put("foreground", granted("location")).put("background", TriggerEvents.backgroundLocation(context)))
        TriggerStore.armAll(context)
    }

    @PluginMethod
    fun requestBluetooth(call: PluginCall) {
        if (granted("bluetooth")) return bluetoothResult(call)
        if (!inFront(activity)) return call.reject("pi cannot ask for the Bluetooth permission $IN_BACKGROUND")
        requestPermissionForAlias("bluetooth", call, "bluetoothResult")
    }

    @PermissionCallback
    private fun bluetoothResult(call: PluginCall) = call.resolve(JSObject().put("granted", granted("bluetooth")))

    @PluginMethod
    fun requestAccess(call: PluginCall) {
        val to = call.getString("to").orEmpty()
        if (to != "photos" && to != "activity") return call.reject("unknown access $to")
        if (granted(to)) return accessResult(call)
        if (!inFront(activity)) return call.reject("pi cannot ask for this permission $IN_BACKGROUND")
        requestPermissionForAlias(to, call, "accessResult")
    }

    @PermissionCallback
    private fun accessResult(call: PluginCall) {
        val allowed = granted(call.getString("to").orEmpty())
        call.resolve(JSObject().put("granted", allowed))
        if (allowed) TriggerStore.armAll(context)
    }

    @PluginMethod
    fun requestExactAlarms(call: PluginCall) {
        context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        val conversation = call.getString("conversation").orEmpty()
        val text = call.getString("text").orEmpty()
        AgentService.createChannels(context)
        val notification =
            Notification.Builder(context, AgentService.CHANNEL_PROACTIVE)
                .setSmallIcon(R.drawable.ic_notification)
                .setLargeIcon(AgentService.avatar(context, call.getString("avatar")))
                .setContentTitle(call.getString("title") ?: "pi")
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(openConversation(context, conversation))
                .setAutoCancel(true)
                .build()
        context.getSystemService(NotificationManager::class.java).notify(0x3000 + (conversation.hashCode() and 0xfff), notification)
        call.resolve()
    }

    @PluginMethod
    fun report(call: PluginCall) {
        ReportsWidget.add(context, call.data)
        call.resolve()
    }

    @PluginMethod
    fun seen(call: PluginCall) {
        ReportsWidget.seen(context, call.getString("conversation").orEmpty())
        call.resolve()
    }

    private fun granted(alias: String) = getPermissionState(alias) == PermissionState.GRANTED

    private fun receiveShare(intent: Intent?) {
        if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return
        val streams =
            if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
        intent.action = Intent.ACTION_MAIN
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val sharedType = intent.type
        Thread {
            val event = JSObject().put("kind", "share")
            if (text != null) event.put("text", text)
            if (subject != null) event.put("subject", subject)
            val files = JSArray()
            for (stream in streams) {
                val copy = copyShared(stream) ?: continue
                val type = context.contentResolver.getType(stream) ?: sharedType.orEmpty()
                files.put(JSObject().put("path", copy.absolutePath).put("name", displayName(stream)).put("mimeType", type))
            }
            if (files.length() > 0) event.put("files", files)
            TriggerStore.enqueue(context, event)
            announce()
        }.start()
    }

    private fun displayName(uri: Uri): String {
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0)
            }
        } catch (error: RuntimeException) {
            Log.w(TRIGGERS_TAG, "could not read the shared file's name", error)
        }
        return uri.lastPathSegment ?: "shared"
    }

    private fun copyShared(uri: Uri): File? {
        val target = File(TriggerStore.inbox(context), UUID.randomUUID().toString())
        try {
            val input = context.contentResolver.openInputStream(uri) ?: return null
            input.use { target.outputStream().use { output -> copyLimited(input, output) } }
            return target
        } catch (error: IOException) {
            Log.w(TRIGGERS_TAG, "could not copy the shared file", error)
        } catch (error: SecurityException) {
            Log.w(TRIGGERS_TAG, "could not copy the shared file", error)
        }
        if (target.exists() && !target.delete()) Log.w(TRIGGERS_TAG, "could not delete $target")
        return null
    }

    companion object {
        @Volatile private var current: TriggersPlugin? = null

        @JvmStatic fun live(): TriggersPlugin? = current

        @JvmStatic fun inFront(activity: Activity?) = activity is LifecycleOwner && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

        internal fun waitingNotificationId(trigger: String) = 0x1000 + (trigger.hashCode() and 0xfff)

        internal fun openConversation(context: Context, conversation: String): PendingIntent {
            if (conversation.isEmpty()) return AgentService.openApp(context)
            val intent =
                Intent(Intent.ACTION_VIEW, Uri.parse("pimobile://open?conversation=" + Uri.encode(conversation)), context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, conversation.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private fun copyLimited(input: InputStream, output: OutputStream) {
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count <= 0) return
                total += count
                if (total > MAX_SHARED_BYTES) throw IOException("shared file is larger than $MAX_SHARED_BYTES bytes")
                output.write(buffer, 0, count)
            }
        }
    }
}
