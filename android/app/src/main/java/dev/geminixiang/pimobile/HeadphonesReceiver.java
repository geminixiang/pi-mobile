package dev.geminixiang.pimobile;

import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Bluetooth headphones connecting or disconnecting (A2DP), one of the broadcasts a manifest receiver still gets on
 * Android 8 and later, so pi need not be running. Exported, because the Bluetooth stack sends it from its own process;
 * it handles only that action, which only the system can send, so it is separate from TriggerReceiver, whose actions
 * other apps must not reach.
 */
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
            // Taking the earbuds out ends what pi was saying.
            Speaker.stopIfSpeaking();
            return;
        }
        if (state != BluetoothProfile.STATE_CONNECTED) return;
        BluetoothDevice device = device(intent);
        String name = "藍牙耳機";
        try {
            if (device != null) {
                BluetoothClass type = device.getBluetoothClass();
                // A2DP is also car audio and speakers; only what one wears counts.
                if (type != null && !wearable(type.getDeviceClass())) {
                    Log.i(TAG, "a2dp device is not headphones: " + type.getDeviceClass());
                    return;
                }
                if (device.getName() != null) name = device.getName();
            }
        } catch (SecurityException error) {
            // Without BLUETOOTH_CONNECT the broadcast would not have come; keep the generic name if it is revoked now.
        }
        TriggerReceiver.headphones(context, name);
    }

    /**
     * Headphones and earbuds report one of these (WH-1000XM5 and Redmi Buds: wearable headset). Not handsfree: car
     * kits report that too (an MG car's did, with A2DP), and the point is something the user is wearing.
     */
    static boolean wearable(int deviceClass) {
        return deviceClass == BluetoothClass.Device.AUDIO_VIDEO_HEADPHONES
            || deviceClass == BluetoothClass.Device.AUDIO_VIDEO_WEARABLE_HEADSET
            || deviceClass == BluetoothClass.Device.AUDIO_VIDEO_UNCATEGORIZED;
    }

}
