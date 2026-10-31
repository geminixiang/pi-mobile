package dev.geminixiang.pimobile

import android.Manifest
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.provider.Settings
import android.util.Log

internal const val ACTION_PLACE = "dev.geminixiang.pimobile.TRIGGER_PLACE"
private const val CHARGING_JOB = 4711
private const val WIFI_JOB = 4712
private const val PREFS = "pi-trigger-events"
private const val KEY_PLACES = "places"
private const val KEY_BOOT = "boot"
private const val KEY_WIFI_NETWORK = "wifi.network"
private const val KEY_ARMED = "armed."
private const val KEY_CHARGE_AT = "charge.at"
private const val KEY_CHARGE_LEVEL = "charge.level"
private const val CHECK_MS = 15 * 60_000L
private const val SETTLE_MS = 2 * 60_000L

object TriggerEvents {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    internal fun sync(context: Context, schedules: List<Schedule>) {
        val prefs = prefs(context)
        val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, 0)
        if (prefs.getInt(KEY_BOOT, -1) != boot) prefs.edit().putInt(KEY_BOOT, boot).putStringSet(KEY_PLACES, emptySet()).apply()
        val wanted = schedules.map { it.trigger }
        PhotoTrigger.arm(context, wanted.any { it is When.Photo })
        ActivityTrigger.arm(context, wanted.any { it is When.Activity })
        val jobs = context.getSystemService(JobScheduler::class.java)
        if (wanted.any { it is When.Charging }) scheduleCharging(context, 0) else jobs.cancel(CHARGING_JOB)
        val wifi = wanted.any { it is When.Wifi }
        if (wifi && jobs.getPendingJob(WIFI_JOB) == null) {
            prefs.edit().putLong(KEY_WIFI_NETWORK, currentWifi(context)).apply()
            scheduleWifi(context, 0)
        } else if (!wifi) {
            jobs.cancel(WIFI_JOB)
        }
        val armed = prefs.getStringSet(KEY_PLACES, emptySet()).orEmpty()
        val places =
            schedules
                .mapNotNull { schedule ->
                    val place = schedule.trigger
                    if (place !is When.Place) return@mapNotNull null
                    val key = "${schedule.id}@${place.latitude},${place.longitude},${place.radius}"
                    val alive = key in armed && placeIntent(context, schedule.id, PendingIntent.FLAG_NO_CREATE) != null
                    key.takeIf { alive || armPlace(context, schedule.id, place) }
                }
                .toSet()
        val kept = places.map { it.substringBefore('@') }.toSet()
        for (id in (armed - places).map { it.substringBefore('@') }.filter { it !in kept }) {
            val intent = placeIntent(context, id, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                context.getSystemService(LocationManager::class.java).removeProximityAlert(intent)
            }
            intent.cancel()
        }
        prefs.edit().putStringSet(KEY_PLACES, places).apply()
    }

    internal fun settling(context: Context, id: String) = System.currentTimeMillis() - prefs(context).getLong(KEY_ARMED + id, 0) < SETTLE_MS

    internal fun backgroundLocation(context: Context) = context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

    @JvmStatic
    @Suppress("DEPRECATION")
    fun wifiName(context: Context): String? {
        val ssid = context.getSystemService(WifiManager::class.java).connectionInfo?.ssid
        if (ssid == null || ssid == WifiManager.UNKNOWN_SSID || ssid.isEmpty()) return null
        return ssid.removeSurrounding("\"")
    }

    private fun scheduleCharging(context: Context, delayMs: Long) {
        val job = JobInfo.Builder(CHARGING_JOB, ComponentName(context, ChargingJob::class.java)).setRequiresCharging(true).setPersisted(true)
        if (delayMs > 0) job.setMinimumLatency(delayMs)
        context.getSystemService(JobScheduler::class.java).schedule(job.build())
    }

    private fun scheduleWifi(context: Context, delayMs: Long) {
        val wifi = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        val job = JobInfo.Builder(WIFI_JOB, ComponentName(context, WifiJob::class.java)).setRequiredNetwork(wifi).setPersisted(true)
        if (delayMs > 0) job.setMinimumLatency(delayMs)
        context.getSystemService(JobScheduler::class.java).schedule(job.build())
    }

    private fun currentWifi(context: Context): Long {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork ?: return 0
        val onWifi = connectivity.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        return if (onWifi) network.networkHandle else 0
    }

    private fun placeIntent(context: Context, id: String, flags: Int): PendingIntent? {
        val intent = Intent(context, TriggerReceiver::class.java).setAction(ACTION_PLACE).setData(Uri.parse("pimobile-place://" + Uri.encode(id))).putExtra(EXTRA_ID, id)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE or flags)
    }

    private fun armPlace(context: Context, id: String, place: When.Place): Boolean {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TRIGGERS_TAG, "no location permission; place schedule $id cannot be armed")
            return false
        }
        val intent = placeIntent(context, id, PendingIntent.FLAG_UPDATE_CURRENT) ?: return false
        try {
            val location = context.getSystemService(LocationManager::class.java)
            location.removeProximityAlert(intent)
            location.addProximityAlert(place.latitude, place.longitude, place.radius, -1, intent)
        } catch (error: SecurityException) {
            Log.w(TRIGGERS_TAG, "could not arm place schedule $id", error)
            return false
        } catch (error: IllegalArgumentException) {
            Log.w(TRIGGERS_TAG, "could not arm place schedule $id", error)
            return false
        }
        prefs(context).edit().putLong(KEY_ARMED + id, System.currentTimeMillis()).apply()
        return true
    }

    class ChargingJob : JobService() {
        override fun onStartJob(params: JobParameters): Boolean {
            val prefs = prefs(this)
            val now = System.currentTimeMillis()
            val lastAt = prefs.getLong(KEY_CHARGE_AT, 0)
            val lastLevel = prefs.getInt(KEY_CHARGE_LEVEL, -1)
            val level = getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val started = lastAt == 0L || now - lastAt > 3 * CHECK_MS || level < lastLevel
            prefs.edit().putLong(KEY_CHARGE_AT, now).putInt(KEY_CHARGE_LEVEL, level).apply()
            Log.i(TRIGGERS_TAG, "charging check: level $level, last $lastLevel" + if (started) ", new charge" else ", same charge")
            if (started) TriggerReceiver.event(this, "charging", "開始充電（電量 $level%）") { it.trigger is When.Charging }
            scheduleCharging(this, CHECK_MS)
            return false
        }

        override fun onStopJob(params: JobParameters) = false
    }

    class WifiJob : JobService() {
        override fun onStartJob(params: JobParameters): Boolean {
            val handle = params.network?.networkHandle ?: currentWifi(this)
            val prefs = prefs(this)
            val fresh = handle != 0L && handle != prefs.getLong(KEY_WIFI_NETWORK, 0)
            prefs.edit().putLong(KEY_WIFI_NETWORK, handle).apply()
            Log.i(TRIGGERS_TAG, "wifi check: network $handle" + if (fresh) ", new connection" else ", same connection")
            if (fresh) TriggerReceiver.wifi(this)
            scheduleWifi(this, CHECK_MS)
            return false
        }

        override fun onStopJob(params: JobParameters) = false
    }
}
