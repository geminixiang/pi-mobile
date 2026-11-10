package dev.geminixiang.pimobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(
    name = "Phone",
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
    ],
)
class PhonePlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    override fun getPermissionStates(): MutableMap<String, PermissionState> {
        val states = super.getPermissionStates()
        if (anyLocation()) states["location"] = PermissionState.GRANTED
        return states
    }

    private fun anyLocation() = granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION)

    @PluginMethod
    fun getLocation(call: PluginCall) {
        if (anyLocation()) {
            locate(call)
            return
        }
        if (!TriggersPlugin.inFront(activity)) {
            call.reject("pi has no location permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
            return
        }
        requestPermissionForAlias("location", call, "locationResult")
    }

    @PermissionCallback
    private fun locationResult(call: PluginCall) {
        if (anyLocation()) locate(call) else call.reject("location permission denied", "permission")
    }

    @SuppressLint("MissingPermission")
    private fun locate(call: PluginCall) {
        val manager = context.getSystemService(LocationManager::class.java)
        if (!manager.isLocationEnabled) {
            call.reject("location is turned off on the phone", "disabled")
            return
        }
        val provider = pickProvider(manager)
        if (provider == null) {
            call.reject("no location provider is available", "unavailable")
            return
        }
        // why: with only approximate permission Android stretches the request to one fix per 10 minutes; on the S24 no provider answered in 20 s, and the wait ended on this same location
        val approximate = if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) null else lastKnown(manager)
        if (approximate != null) {
            resolve(call, approximate, true)
            return
        }
        val done = AtomicBoolean(false)
        val cancel = CancellationSignal()
        val timeout =
            Runnable {
                if (!done.compareAndSet(false, true)) return@Runnable
                cancel.cancel()
                val last = lastKnown(manager)
                if (last != null) resolve(call, last, true) else call.reject("no location fix within ${FIX_TIMEOUT_MS / 1000} seconds", "timeout")
            }
        main.postDelayed(timeout, FIX_TIMEOUT_MS)
        val others =
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { other ->
                other != provider &&
                    manager.isProviderEnabled(other) &&
                    (other != LocationManager.GPS_PROVIDER || granted(Manifest.permission.ACCESS_FINE_LOCATION))
            }
        currentFrom(manager, listOf(provider) + others, 0, cancel, done, timeout, call)
    }

    @SuppressLint("MissingPermission")
    private fun currentFrom(
        manager: LocationManager,
        order: List<String>,
        index: Int,
        cancel: CancellationSignal,
        done: AtomicBoolean,
        timeout: Runnable,
        call: PluginCall,
    ) {
        manager.getCurrentLocation(order[index], cancel, context.mainExecutor) { location: Location? ->
            if (done.get()) return@getCurrentLocation
            if (location == null && index + 1 < order.size) {
                currentFrom(manager, order, index + 1, cancel, done, timeout, call)
                return@getCurrentLocation
            }
            if (!done.compareAndSet(false, true)) return@getCurrentLocation
            main.removeCallbacks(timeout)
            val fix = location ?: lastKnown(manager)
            if (fix != null) {
                resolve(call, fix, location == null)
            } else {
                call.reject("no location fix: GPS and network location gave none. Ask the user where they are.", "unavailable")
            }
        }
    }

    private fun pickProvider(manager: LocationManager): String? =
        when {
            manager.hasProvider(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
            granted(Manifest.permission.ACCESS_FINE_LOCATION) && manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> null
        }

    @SuppressLint("MissingPermission")
    private fun lastKnown(manager: LocationManager): Location? =
        manager.getProviders(true).mapNotNull { manager.getLastKnownLocation(it) }.maxByOrNull { it.time }

    private fun resolve(call: PluginCall, location: Location, lastKnown: Boolean) {
        val result = JSObject()
        result.put("latitude", location.latitude)
        result.put("longitude", location.longitude)
        if (location.hasAccuracy()) result.put("accuracyMeters", Math.round(location.accuracy))
        if (location.hasAltitude()) result.put("altitudeMeters", Math.round(location.altitude))
        if (location.hasSpeed()) result.put("speedMetersPerSecond", Math.round(location.speed * 10) / 10.0)
        if (location.hasBearing()) result.put("bearingDegrees", Math.round(location.bearing))
        result.put("ageSeconds", maxOf(0L, (System.currentTimeMillis() - location.time) / 1000))
        result.put("provider", location.provider)
        result.put("approximate", !granted(Manifest.permission.ACCESS_FINE_LOCATION))
        result.put("lastKnown", lastKnown)
        Thread {
            geocode(location)?.let { result.put("address", it) }
            call.resolve(result)
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun geocode(location: Location): JSObject? {
        if (!Geocoder.isPresent()) return null
        return try {
            val a = Geocoder(context, Locale.getDefault()).getFromLocation(location.latitude, location.longitude, 1)?.firstOrNull() ?: return null
            val address = JSObject()
            if (a.maxAddressLineIndex >= 0) address.put("line", a.getAddressLine(0))
            a.countryName?.let { address.put("country", it) }
            a.adminArea?.let { address.put("adminArea", it) }
            a.locality?.let { address.put("locality", it) }
            a.subLocality?.let { address.put("subLocality", it) }
            a.thoroughfare?.let { address.put("street", it) }
            address
        } catch (failed: Exception) {
            null
        }
    }

    @PluginMethod
    @Suppress("DEPRECATION")
    fun geocode(call: PluginCall) {
        val query = call.getString("query", "").orEmpty().trim()
        if (query.isEmpty()) {
            call.reject("query is empty")
            return
        }
        if (!Geocoder.isPresent()) {
            call.reject("this phone has no geocoder", "unavailable")
            return
        }
        Thread {
            try {
                val a = Geocoder(context, Locale.getDefault()).getFromLocationName(query, 1)?.firstOrNull()
                if (a == null) {
                    call.reject("no place found for $query", "not_found")
                    return@Thread
                }
                val result = JSObject()
                result.put("latitude", a.latitude)
                result.put("longitude", a.longitude)
                if (a.maxAddressLineIndex >= 0) result.put("address", a.getAddressLine(0))
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("geocoding failed: ${e.message}", "failed")
            }
        }.start()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val result = JSObject()

        val battery = context.getSystemService(BatteryManager::class.java)
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val power = JSObject()
        power.put("percent", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
        power.put("charging", battery.isCharging)
        if (sticky != null) {
            power.put(
                "plugged",
                when (sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)) {
                    BatteryManager.BATTERY_PLUGGED_AC -> "ac"
                    BatteryManager.BATTERY_PLUGGED_USB -> "usb"
                    BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
                    else -> "no"
                },
            )
            val tenths = sticky.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            if (tenths != Int.MIN_VALUE) power.put("temperatureCelsius", tenths / 10.0)
        }
        power.put("powerSaving", context.getSystemService(PowerManager::class.java).isPowerSaveMode)
        result.put("battery", power)

        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val caps = connectivity.activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
        val network = JSObject()
        if (caps == null) {
            network.put("type", "none")
        } else {
            network.put(
                "type",
                when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    else -> "other"
                },
            )
            network.put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
            network.put("metered", connectivity.isActiveNetworkMetered)
            network.put("internet", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
        }
        result.put("network", network)

        val audio = context.getSystemService(AudioManager::class.java)
        val sound = JSObject()
        sound.put(
            "ringer",
            when (audio.ringerMode) {
                AudioManager.RINGER_MODE_SILENT -> "silent"
                AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
                else -> "normal"
            },
        )
        val filter = context.getSystemService(NotificationManager::class.java).currentInterruptionFilter
        sound.put("doNotDisturb", filter != NotificationManager.INTERRUPTION_FILTER_ALL && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN)
        val outputs =
            audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { device ->
                audioKind(device.type)?.let { kind -> JSObject().put("kind", kind).put("name", device.productName.toString()) }
            }
        sound.put("connectedAudio", JSArray(outputs))
        result.put("sound", sound)

        val stat = StatFs(Environment.getDataDirectory().path)
        val storage = JSObject()
        storage.put("freeGB", Math.round(stat.availableBytes / 1e8) / 10.0)
        storage.put("totalGB", Math.round(stat.totalBytes / 1e8) / 10.0)
        result.put("storage", storage)

        result.put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        result.put("android", Build.VERSION.RELEASE)
        call.resolve(result)
    }

    @PluginMethod
    fun readSensors(call: PluginCall) {
        val manager = context.getSystemService(SensorManager::class.java)
        val sensors: List<Sensor?> =
            listOf(Sensor.TYPE_PRESSURE, Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_LIGHT, Sensor.TYPE_PROXIMITY).map { manager.getDefaultSensor(it) }
        val names = listOf("barometer", "compass", "light", "proximity")
        val latest = arrayOfNulls<FloatArray>(sensors.size)
        val listener =
            object : SensorEventListener {
                override fun onSensorChanged(event: SensorEvent) {
                    sensors.forEachIndexed { i, sensor -> if (event.sensor === sensor) latest[i] = event.values.clone() }
                }

                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
            }
        sensors.filterNotNull().forEach { manager.registerListener(listener, it, SensorManager.SENSOR_DELAY_UI, main) }
        main.postDelayed({
            manager.unregisterListener(listener)
            val result = JSObject()
            latest[0]?.let { pressure ->
                val hPa = pressure[0]
                val air = JSObject()
                air.put("pressureHPa", Math.round(hPa * 10) / 10.0)
                air.put("altitudeMetersEstimate", Math.round(SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, hPa)))
                result.put("barometer", air)
            }
            latest[1]?.let { result.put("compass", compass(it)) }
            latest[2]?.let { result.put("lightLux", Math.round(it[0])) }
            val proximity = latest[3]
            val proximitySensor = sensors[3]
            if (proximity != null && proximitySensor != null) result.put("proximity", if (proximity[0] < proximitySensor.maximumRange) "near" else "far")
            val missing = names.filterIndexed { i, _ -> latest[i] == null }
            if (missing.isNotEmpty()) result.put("noReading", JSArray(missing))
            call.resolve(result)
        }, SENSOR_WINDOW_MS)
    }

    @SuppressLint("MissingPermission")
    private fun compass(vector: FloatArray): JSObject {
        val matrix = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(matrix, vector)
        SensorManager.getOrientation(matrix, orientation)
        val magnetic = (Math.toDegrees(orientation[0].toDouble()) + 360) % 360
        val compass = JSObject()
        compass.put("magneticHeadingDegrees", Math.round(magnetic))
        compass.put("pitchDegrees", Math.round(Math.toDegrees(orientation[1].toDouble())))
        compass.put("rollDegrees", Math.round(Math.toDegrees(orientation[2].toDouble())))
        val last = if (anyLocation()) lastKnown(context.getSystemService(LocationManager::class.java)) else null
        val trueHeading =
            last?.let {
                val field = GeomagneticField(it.latitude.toFloat(), it.longitude.toFloat(), it.altitude.toFloat(), System.currentTimeMillis())
                (magnetic + field.declination + 360) % 360
            }
        trueHeading?.let { compass.put("trueHeadingDegrees", Math.round(it)) }
        val heading = trueHeading ?: magnetic
        compass.put("facing", POINTS[(Math.round(heading / 45) % 8).toInt()])
        return compass
    }

    companion object {
        private const val FIX_TIMEOUT_MS = 20_000L
        private const val SENSOR_WINDOW_MS = 900L
        private val POINTS = listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

        private fun audioKind(type: Int): String? =
            when (type) {
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bluetooth"
                else -> null
            }
    }
}
