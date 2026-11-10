package dev.geminixiang.pimobile

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Intent
import android.net.Uri
import android.os.Process
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "Usage")
class UsagePlugin : Plugin() {
    private fun allowed(): Boolean {
        val ops = context.getSystemService(AppOpsManager::class.java)
        return ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
    }

    @PluginMethod
    fun status(call: PluginCall) = call.resolve(JSObject().put("allowed", allowed()))

    @PluginMethod
    fun openSettings(call: PluginCall) {
        SystemPlugin.openSettings(
            context,
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}")),
            Settings.ACTION_USAGE_ACCESS_SETTINGS,
        )
        call.resolve()
    }

    @PluginMethod
    fun apps(call: PluginCall) =
        Background.run(call) {
            if (!allowed()) {
                call.reject("usage access is off")
                return@run
            }
            val from = call.data.optLong("from", 0L)
            val to = minOf(call.data.optLong("to", System.currentTimeMillis()), System.currentTimeMillis())
            val events = context.getSystemService(UsageStatsManager::class.java).queryEvents(from, to)
            val started = HashMap<String, Long>()
            val total = HashMap<String, Long>()
            val seen = HashSet<String>()
            var unlocks = 0
            val event = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(event)
                val pkg = event.packageName
                when (event.eventType) {
                    UsageEvents.Event.ACTIVITY_RESUMED -> {
                        seen.add(pkg)
                        started.putIfAbsent(pkg, event.timeStamp)
                    }
                    UsageEvents.Event.ACTIVITY_PAUSED, UsageEvents.Event.ACTIVITY_STOPPED -> {
                        val start = started.remove(pkg) ?: if (seen.add(pkg) && from > 0) from else null
                        if (start != null) total.merge(pkg, event.timeStamp - start) { a, b -> a + b }
                    }
                    UsageEvents.Event.KEYGUARD_HIDDEN -> unlocks++
                    UsageEvents.Event.SCREEN_NON_INTERACTIVE -> {
                        started.forEach { (open, since) -> total.merge(open, event.timeStamp - since) { a, b -> a + b } }
                        started.clear()
                    }
                }
            }
            started.forEach { (open, since) -> total.merge(open, to - since) { a, b -> a + b } }
            val manager = context.packageManager
            val launcherLabels =
                manager
                    .queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                    .associate { it.activityInfo.packageName to it.loadLabel(manager).toString() }
            val home = homePackage()
            val items = JSArray()
            total.entries
                .sortedByDescending { it.value }
                .filter { it.value >= 60_000 && it.key != home }
                .forEach { (pkg, ms) -> launcherLabels[pkg]?.let { items.put(JSObject().put("package", pkg).put("app", it).put("ms", ms)) } }
            call.resolve(JSObject().put("items", items).put("unlocks", unlocks))
        }

    private fun homePackage(): String {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        return context.packageManager.resolveActivity(home, 0)?.activityInfo?.packageName.orEmpty()
    }
}
