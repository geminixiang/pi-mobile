package dev.geminixiang.pimobile

import android.Manifest
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log

private const val TAG = "PiTriggers"
private const val ACTION_A2DP = "android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED"

class HeadphonesReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_A2DP) bluetooth(context, intent)
    }

    private companion object {
        fun bluetooth(context: Context, intent: Intent) {
            val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
            if (state != BluetoothProfile.STATE_CONNECTED && state != BluetoothProfile.STATE_DISCONNECTED) return
            val device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            val mayReadDevice = context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            val named = if (device != null && mayReadDevice) device.name else null
            if (named != null) TriggerReceiver.bluetooth(context, named, state == BluetoothProfile.STATE_CONNECTED)
            if (state == BluetoothProfile.STATE_DISCONNECTED) {
                Speaker.stopIfSpeaking()
                return
            }
            if (device != null && mayReadDevice) {
                val type = device.bluetoothClass
                if (type != null && !wearable(type.deviceClass)) {
                    Log.i(TAG, "a2dp device is not headphones: ${type.deviceClass}")
                    return
                }
            }
            TriggerReceiver.headphones(context, named ?: "藍牙耳機")
        }

        fun wearable(deviceClass: Int) =
            deviceClass == BluetoothClass.Device.AUDIO_VIDEO_HEADPHONES ||
                deviceClass == BluetoothClass.Device.AUDIO_VIDEO_WEARABLE_HEADSET ||
                deviceClass == BluetoothClass.Device.AUDIO_VIDEO_UNCATEGORIZED
    }
}
