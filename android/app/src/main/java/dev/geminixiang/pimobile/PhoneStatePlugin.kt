package dev.geminixiang.pimobile

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.location.LocationManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.nfc.NfcAdapter
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.telephony.TelephonyManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONException

@CapacitorPlugin(name = "PhoneState")
class PhoneStatePlugin : Plugin() {
    @Volatile private var torchOn: Boolean? = null
    private var torchWatch: CameraManager.TorchCallback? = null

    private fun audio() = context.getSystemService(AudioManager::class.java)

    private fun soundState(): JSObject {
        val audio = audio()
        val result = JSObject()
        result.put(
            "ringer",
            when (audio.ringerMode) {
                AudioManager.RINGER_MODE_SILENT -> "silent"
                AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
                else -> "normal"
            },
        )
        val volumes = JSObject()
        STREAMS.forEach { (name, stream) ->
            val max = audio.getStreamMaxVolume(stream)
            volumes.put(name, if (max == 0) 0 else Math.round(audio.getStreamVolume(stream) * 100f / max))
        }
        result.put("volumePercent", volumes)
        return result
    }

    @PluginMethod
    fun sound(call: PluginCall) = call.resolve(soundState())

    @PluginMethod
    fun setRinger(call: PluginCall) {
        val ringer =
            when (call.getString("mode", "")) {
                "silent" -> AudioManager.RINGER_MODE_SILENT
                "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
                else -> AudioManager.RINGER_MODE_NORMAL
            }
        try {
            audio().ringerMode = ringer
        } catch (denied: SecurityException) {
            call.reject("dnd")
            return
        }
        call.resolve(soundState())
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val name = call.getString("stream", "").orEmpty()
        val stream = STREAMS[name]
        if (stream == null) {
            call.reject("unknown stream $name")
            return
        }
        val audio = audio()
        val max = audio.getStreamMaxVolume(stream)
        val level = Math.round((call.getInt("percent") ?: 0).coerceIn(0, 100) * max / 100f)
        try {
            if (stream == AudioManager.STREAM_RING && level > 0 && audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
                audio.ringerMode = AudioManager.RINGER_MODE_NORMAL
            }
            audio.setStreamVolume(stream, level, 0)
        } catch (denied: SecurityException) {
            call.reject("dnd")
            return
        }
        call.resolve(soundState())
    }

    private fun displayState(): JSObject {
        val resolver = context.contentResolver
        val result = JSObject()
        result.put("canChange", Settings.System.canWrite(context))
        try {
            val brightness = Settings.System.getInt(resolver, Settings.System.SCREEN_BRIGHTNESS)
            result.put("brightnessPercent", Math.round(brightness * 100f / 255))
            result.put(
                "autoBrightness",
                Settings.System.getInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC,
            )
            result.put("autoRotate", Settings.System.getInt(resolver, Settings.System.ACCELEROMETER_ROTATION) == 1)
            result.put("screenTimeoutSeconds", Settings.System.getInt(resolver, Settings.System.SCREEN_OFF_TIMEOUT) / 1000)
        } catch (e: Settings.SettingNotFoundException) {
            result.put("unreadable", e.message)
        }
        return result
    }

    @PluginMethod
    fun display(call: PluginCall) = call.resolve(displayState())

    @PluginMethod
    fun setDisplay(call: PluginCall) {
        if (!Settings.System.canWrite(context)) {
            call.reject("write-settings")
            return
        }
        val what = call.getString("what", "").orEmpty()
        val resolver = context.contentResolver
        when (what) {
            "brightness" -> {
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS, Math.round((call.getInt("value") ?: 50).coerceIn(1, 100) * 255 / 100f))
            }
            "auto_brightness" ->
                Settings.System.putInt(
                    resolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE,
                    if (call.getBoolean("on") == true) Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC else Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
                )
            "auto_rotate" -> Settings.System.putInt(resolver, Settings.System.ACCELEROMETER_ROTATION, if (call.getBoolean("on") == true) 1 else 0)
            "screen_timeout" -> Settings.System.putInt(resolver, Settings.System.SCREEN_OFF_TIMEOUT, (call.getInt("value") ?: 30).coerceIn(15, 1800) * 1000)
            else -> {
                call.reject("unknown setting $what")
                return
            }
        }
        call.resolve(displayState())
    }

    @PluginMethod
    fun openWriteSettings(call: PluginCall) {
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        call.resolve()
    }

    private fun torchCamera(): String? {
        val cameras = context.getSystemService(CameraManager::class.java)
        return cameras.cameraIdList.firstOrNull { cameras.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
    }

    private fun watchTorch() {
        if (torchWatch != null) return
        val watch =
            object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                    torchOn = enabled
                }

                override fun onTorchModeUnavailable(cameraId: String) {
                    torchOn = null
                }
            }
        torchWatch = watch
        context.getSystemService(CameraManager::class.java).registerTorchCallback(watch, Handler(Looper.getMainLooper()))
    }

    @PluginMethod
    fun flashlight(call: PluginCall) {
        watchTorch()
        Handler(Looper.getMainLooper()).postDelayed({
            val on = torchOn
            call.resolve(JSObject().put("state", if (on == null) "unavailable" else if (on) "on" else "off"))
        }, 150)
    }

    @PluginMethod
    fun setFlashlight(call: PluginCall) {
        watchTorch()
        val on = call.getBoolean("on") == true
        try {
            val id = torchCamera()
            if (id == null) {
                call.reject("this phone has no flashlight")
                return
            }
            context.getSystemService(CameraManager::class.java).setTorchMode(id, on)
        } catch (e: CameraAccessException) {
            call.reject("the camera is in use: ${e.message}")
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({
            val state = torchOn
            call.resolve(JSObject().put("state", if (state == null) "unavailable" else if (state) "on" else "off"))
        }, 250)
    }

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun connectionsState(): JSObject {
        val result = JSObject()
        val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
        val wifiState = JSObject()
        wifiState.put("on", wifi.isWifiEnabled)
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val wifiNetworks =
            connectivity.allNetworks
                .mapNotNull { connectivity.getNetworkCapabilities(it) }
                .filter { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
        wifiNetworks.forEach { caps ->
            val info = caps.transportInfo
            if (info is WifiInfo) {
                val ssid: String? = info.ssid
                if (ssid != null && !ssid.contains("unknown ssid")) wifiState.put("name", ssid.removePrefix("\"").removeSuffix("\""))
            }
        }
        val wifiConnected = wifiNetworks.isNotEmpty()
        if (wifiConnected && !wifiState.has("name")) {
            wifiState.put(
                "name",
                TriggerEvents.wifiName(context)
                    ?: if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) "(hidden: location is off)" else "(hidden: needs location permission)",
            )
        }
        wifiState.put("connected", wifiConnected)
        result.put("wifi", wifiState)

        val bluetooth = JSObject()
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        bluetooth.put("on", adapter != null && adapter.isEnabled)
        if (adapter != null && adapter.isEnabled && granted(Manifest.permission.BLUETOOTH_CONNECT)) {
            val connected =
                listOf(BluetoothProfile.HEADSET, BluetoothProfile.A2DP)
                    .filter { adapter.getProfileConnectionState(it) == BluetoothProfile.STATE_CONNECTED }
                    .map { if (it == BluetoothProfile.A2DP) "audio" else "headset" }
            bluetooth.put("connectedProfiles", connected.joinToString(", "))
        }
        result.put("bluetooth", bluetooth)

        val mobile = JSObject()
        context.getSystemService(TelephonyManager::class.java)?.let { phone ->
            try {
                mobile.put("on", phone.isDataEnabled)
            } catch (denied: SecurityException) {
                mobile.put("on", "unknown")
            }
        }
        result.put("mobileData", mobile)
        result.put("airplaneMode", Settings.Global.getInt(context.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1)
        result.put("location", context.getSystemService(LocationManager::class.java).isLocationEnabled)
        val nfc = NfcAdapter.getDefaultAdapter(context)
        result.put("nfc", if (nfc == null) "none" else if (nfc.isEnabled) "on" else "off")
        result.put("batterySaver", context.getSystemService(PowerManager::class.java).isPowerSaveMode)
        return result
    }

    @PluginMethod
    fun connections(call: PluginCall) = call.resolve(connectionsState())

    private fun isOn(what: String): Boolean? {
        val state = connectionsState()
        return try {
            when (what) {
                "wifi" -> state.getJSObject("wifi")?.getBoolean("on")
                "bluetooth" -> state.getJSObject("bluetooth")?.getBoolean("on")
                "mobile_data" -> state.getJSObject("mobileData")?.opt("on").let { if (it is Boolean) it else null }
                "airplane_mode" -> state.getBoolean("airplaneMode")
                "location" -> state.getBoolean("location")
                "nfc" -> state.getString("nfc") == "on"
                "battery_saver" -> state.getBoolean("batterySaver")
                else -> null
            }
        } catch (e: JSONException) {
            null
        }
    }

    private fun panel(what: String): Intent? =
        when (what) {
            "wifi" -> Intent(Settings.Panel.ACTION_WIFI)
            "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            "mobile_data", "airplane_mode" -> Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
            "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            "nfc" -> Intent(Settings.Panel.ACTION_NFC)
            "battery_saver" -> Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS)
            else -> null
        }

    @PluginMethod
    fun setConnection(call: PluginCall) {
        val what = call.getString("what", "").orEmpty()
        val want = call.getBoolean("on") == true
        val intent = panel(what)
        if (intent == null) {
            call.reject("unknown connection $what")
            return
        }
        if (isOn(what) == want) {
            call.resolve(connectionsState().put("outcome", "already"))
            return
        }
        if (call.getBoolean("mayOpen") != true || !PhoneScreenService.canStartActivities(activity)) {
            call.reject(
                "pi is in the background, and the phone does not let it open the $what panel from there. Ask the user to open pi and try again.",
                "BACKGROUND",
            )
            return
        }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve(connectionsState().put("outcome", "panel"))
    }

    companion object {
        private val STREAMS =
            mapOf(
                "ring" to AudioManager.STREAM_RING,
                "media" to AudioManager.STREAM_MUSIC,
                "alarm" to AudioManager.STREAM_ALARM,
                "notification" to AudioManager.STREAM_NOTIFICATION,
                "call" to AudioManager.STREAM_VOICE_CALL,
            )
    }
}
