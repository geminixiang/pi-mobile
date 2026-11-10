package dev.geminixiang.pimobile

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "KeepAlive",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class KeepAlivePlugin : Plugin() {
    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, AgentService::class.java).putExtra(AgentService.EXTRA_TEXT, call.getString("text", ""))
        try {
            context.startForegroundService(intent)
        } catch (error: RuntimeException) {
            call.reject("could not start the foreground service: ${error.message}")
            return
        }
        setRendererImportant(true)
        call.resolve()
    }

    private fun setRendererImportant(important: Boolean) = activity.runOnUiThread { keepWebViewRunning(bridge.webView, important) }

    @PluginMethod
    fun stop(call: PluginCall) {
        // why: stopService before onStartCommand ran crashes pi (ForegroundServiceDidNotStartInTimeException); a queued stop runs after startForeground.
        try {
            context.startService(Intent(context, AgentService::class.java).setAction(AgentService.ACTION_STOP))
        } catch (inBackground: IllegalStateException) {
            context.stopService(Intent(context, AgentService::class.java))
        }
        setRendererImportant(false)
        call.resolve()
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        AgentService.createChannels(context)
        val text = call.getString("text", "")
        val notification =
            Notification.Builder(context, AgentService.CHANNEL_DONE)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(call.getString("title", "pi"))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(AgentService.openApp(context))
                .setAutoCancel(true)
                .build()
        context.getSystemService(NotificationManager::class.java).notify(DONE_NOTIFICATION_ID, notification)
        call.resolve()
    }

    @PluginMethod
    fun clearNotification(call: PluginCall) {
        context.getSystemService(NotificationManager::class.java).cancel(DONE_NOTIFICATION_ID)
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val power = context.getSystemService(PowerManager::class.java)
        call.resolve(
            JSObject()
                .put("notifications", notificationsAllowed())
                .put("unrestrictedBattery", power.isIgnoringBatteryOptimizations(context.packageName)),
        )
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (notificationsAllowed()) {
            call.resolve(granted(true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsResult")
    }

    @PermissionCallback
    private fun notificationsResult(call: PluginCall) = call.resolve(granted(getPermissionState("notifications") == PermissionState.GRANTED))

    @PluginMethod
    fun requestUnrestrictedBattery(call: PluginCall) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    private fun notificationsAllowed(): Boolean = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val DONE_NOTIFICATION_ID = 2

        internal fun keepWebViewRunning(webView: WebView, on: Boolean) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !on)
            PiWebView.keepRunning(webView, on)
        }

        private fun granted(value: Boolean): JSObject = JSObject().put("granted", value)
    }
}
