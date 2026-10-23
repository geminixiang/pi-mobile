package dev.geminixiang.pimobile;

import android.os.Build;
import android.content.pm.PackageManager;
import android.Manifest;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class HeadphonesReceiver extends BroadcastReceiver {

    private static final String TAG = "PiTriggers";
    static final String ACTION_A2DP = "android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_A2DP.equals(intent.getAction())) bluetooth(context, intent);
    }

    @SuppressWarnings("deprecation")
    private static BluetoothDevice device(Intent intent) {
        return android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
            ? intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class)
            : intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
    }

    private static void bluetooth(Context context, Intent intent) {
        int state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1);
        if (state == BluetoothProfile.STATE_DISCONNECTED) {
            Speaker.stopIfSpeaking();
            return;
        }
        if (state != BluetoothProfile.STATE_CONNECTED) return;
        BluetoothDevice device = device(intent);
        String name = "藍牙耳機";
        boolean mayReadDevice = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        if (device != null && mayReadDevice) {
            BluetoothClass type = device.getBluetoothClass();
            if (type != null && !wearable(type.getDeviceClass())) {
                Log.i(TAG, "a2dp device is not headphones: " + type.getDeviceClass());
                return;
            }
            if (device.getName() != null) name = device.getName();
        }
        TriggerReceiver.headphones(context, name);
    }

    static boolean wearable(int deviceClass) {
        return deviceClass == BluetoothClass.Device.AUDIO_VIDEO_HEADPHONES
            || deviceClass == BluetoothClass.Device.AUDIO_VIDEO_WEARABLE_HEADSET
            || deviceClass == BluetoothClass.Device.AUDIO_VIDEO_UNCATEGORIZED;
    }

}
