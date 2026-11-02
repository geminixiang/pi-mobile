package dev.geminixiang.pimobile;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.LocationManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.nfc.NfcAdapter;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "PhoneState")
public class PhoneStatePlugin extends Plugin {

    private static final String[] STREAM_NAMES = { "ring", "media", "alarm", "notification", "call" };
    private static final int[] STREAMS = {
        AudioManager.STREAM_RING,
        AudioManager.STREAM_MUSIC,
        AudioManager.STREAM_ALARM,
        AudioManager.STREAM_NOTIFICATION,
        AudioManager.STREAM_VOICE_CALL,
    };

    private volatile Boolean torchOn;
    private CameraManager.TorchCallback torchWatch;

    private AudioManager audio() {
        return getContext().getSystemService(AudioManager.class);
    }

    private JSObject soundState() {
        AudioManager audio = audio();
        JSObject result = new JSObject();
        int ringer = audio.getRingerMode();
        result.put("ringer", ringer == AudioManager.RINGER_MODE_SILENT ? "silent" : ringer == AudioManager.RINGER_MODE_VIBRATE ? "vibrate" : "normal");
        JSObject volumes = new JSObject();
        for (int i = 0; i < STREAMS.length; i++) {
            int max = audio.getStreamMaxVolume(STREAMS[i]);
            volumes.put(STREAM_NAMES[i], max == 0 ? 0 : Math.round(audio.getStreamVolume(STREAMS[i]) * 100f / max));
        }
        result.put("volumePercent", volumes);
        return result;
    }

    @PluginMethod
    public void sound(PluginCall call) {
        call.resolve(soundState());
    }

    @PluginMethod
    public void setRinger(PluginCall call) {
        String mode = call.getString("mode", "");
        int ringer = "silent".equals(mode)
            ? AudioManager.RINGER_MODE_SILENT
            : "vibrate".equals(mode) ? AudioManager.RINGER_MODE_VIBRATE : AudioManager.RINGER_MODE_NORMAL;
        try {
            audio().setRingerMode(ringer);
        } catch (SecurityException e) {
            call.reject("dnd");
            return;
        }
        call.resolve(soundState());
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        String name = call.getString("stream", "");
        int index = -1;
        for (int i = 0; i < STREAM_NAMES.length; i++) if (STREAM_NAMES[i].equals(name)) index = i;
        if (index < 0) {
            call.reject("unknown stream " + name);
            return;
        }
        AudioManager audio = audio();
        int stream = STREAMS[index];
        int max = audio.getStreamMaxVolume(stream);
        int level = Math.round(Math.max(0, Math.min(100, call.getInt("percent", 0))) * max / 100f);
        try {
            if (stream == AudioManager.STREAM_RING && level > 0 && audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) {
                audio.setRingerMode(AudioManager.RINGER_MODE_NORMAL);
            }
            audio.setStreamVolume(stream, level, 0);
        } catch (SecurityException e) {
            call.reject("dnd");
            return;
        }
        call.resolve(soundState());
    }

    private JSObject displayState() {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("canChange", Settings.System.canWrite(context));
        try {
            int brightness = Settings.System.getInt(context.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
            result.put("brightnessPercent", Math.round(brightness * 100f / 255));
            result.put(
                "autoBrightness",
                Settings.System.getInt(context.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE) ==
                    Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC
            );
            result.put("autoRotate", Settings.System.getInt(context.getContentResolver(), Settings.System.ACCELEROMETER_ROTATION) == 1);
            result.put("screenTimeoutSeconds", Settings.System.getInt(context.getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT) / 1000);
        } catch (Settings.SettingNotFoundException e) {
            result.put("unreadable", e.getMessage());
        }
        return result;
    }

    @PluginMethod
    public void display(PluginCall call) {
        call.resolve(displayState());
    }

    @PluginMethod
    public void setDisplay(PluginCall call) {
        Context context = getContext();
        if (!Settings.System.canWrite(context)) {
            call.reject("write-settings");
            return;
        }
        String what = call.getString("what", "");
        android.content.ContentResolver resolver = context.getContentResolver();
        switch (what) {
            case "brightness":
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS, Math.round(Math.max(1, Math.min(100, call.getInt("value", 50))) * 255 / 100f));
                break;
            case "auto_brightness":
                Settings.System.putInt(
                    resolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE,
                    Boolean.TRUE.equals(call.getBoolean("on")) ? Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC : Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
                );
                break;
            case "auto_rotate":
                Settings.System.putInt(resolver, Settings.System.ACCELEROMETER_ROTATION, Boolean.TRUE.equals(call.getBoolean("on")) ? 1 : 0);
                break;
            case "screen_timeout":
                Settings.System.putInt(resolver, Settings.System.SCREEN_OFF_TIMEOUT, Math.max(15, Math.min(1800, call.getInt("value", 30))) * 1000);
                break;
            default:
                call.reject("unknown setting " + what);
                return;
        }
        call.resolve(displayState());
    }

    @PluginMethod
    public void openWriteSettings(PluginCall call) {
        getContext()
            .startActivity(
                new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null)).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                )
            );
        call.resolve();
    }

    private String torchCamera() throws CameraAccessException {
        CameraManager cameras = getContext().getSystemService(CameraManager.class);
        for (String id : cameras.getCameraIdList()) {
            Boolean flash = cameras.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (Boolean.TRUE.equals(flash)) return id;
        }
        return null;
    }

    private void watchTorch() {
        if (torchWatch != null) return;
        torchWatch = new CameraManager.TorchCallback() {
            @Override
            public void onTorchModeChanged(String cameraId, boolean enabled) {
                torchOn = enabled;
            }

            @Override
            public void onTorchModeUnavailable(String cameraId) {
                torchOn = null;
            }
        };
        getContext().getSystemService(CameraManager.class).registerTorchCallback(torchWatch, new Handler(Looper.getMainLooper()));
    }

    @PluginMethod
    public void flashlight(PluginCall call) {
        watchTorch();
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            JSObject result = new JSObject();
            result.put("state", torchOn == null ? "unavailable" : torchOn ? "on" : "off");
            call.resolve(result);
        }, 150);
    }

    @PluginMethod
    public void setFlashlight(PluginCall call) {
        watchTorch();
        boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
        try {
            String id = torchCamera();
            if (id == null) {
                call.reject("this phone has no flashlight");
                return;
            }
            getContext().getSystemService(CameraManager.class).setTorchMode(id, on);
        } catch (CameraAccessException e) {
            call.reject("the camera is in use: " + e.getMessage());
            return;
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            JSObject result = new JSObject();
            result.put("state", torchOn == null ? "unavailable" : torchOn ? "on" : "off");
            call.resolve(result);
        }, 250);
    }

    private boolean granted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject connectionsState() {
        Context context = getContext();
        JSObject result = new JSObject();
        WifiManager wifi = context.getApplicationContext().getSystemService(WifiManager.class);
        JSObject wifiState = new JSObject();
        wifiState.put("on", wifi.isWifiEnabled());
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        boolean wifiConnected = false;
        for (Network network : connectivity.getAllNetworks()) {
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
            if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
            wifiConnected = true;
            if (caps.getTransportInfo() instanceof WifiInfo) {
                String ssid = ((WifiInfo) caps.getTransportInfo()).getSSID();
                if (ssid != null && !ssid.contains("unknown ssid")) wifiState.put("name", ssid.replaceAll("^\"|\"$", ""));
            }
        }
        if (wifiConnected && !wifiState.has("name")) {
            String name = TriggerEvents.wifiName(context);
            if (name != null) wifiState.put("name", name);
            else wifiState.put("name", granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "(hidden: location is off)" : "(hidden: needs location permission)");
        }
        wifiState.put("connected", wifiConnected);
        result.put("wifi", wifiState);

        JSObject bluetooth = new JSObject();
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        bluetooth.put("on", adapter != null && adapter.isEnabled());
        if (adapter != null && adapter.isEnabled() && granted(Manifest.permission.BLUETOOTH_CONNECT)) {
            List<String> connected = new ArrayList<>();
            for (int profile : new int[] { BluetoothProfile.HEADSET, BluetoothProfile.A2DP }) {
                if (adapter.getProfileConnectionState(profile) == BluetoothProfile.STATE_CONNECTED) connected.add(profile == BluetoothProfile.A2DP ? "audio" : "headset");
            }
            bluetooth.put("connectedProfiles", String.join(", ", connected));
        }
        result.put("bluetooth", bluetooth);

        TelephonyManager phone = context.getSystemService(TelephonyManager.class);
        JSObject mobile = new JSObject();
        if (phone != null) {
            try {
                mobile.put("on", phone.isDataEnabled());
            } catch (SecurityException e) {
                mobile.put("on", "unknown");
            }
        }
        result.put("mobileData", mobile);
        result.put("airplaneMode", Settings.Global.getInt(context.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0) == 1);
        LocationManager location = context.getSystemService(LocationManager.class);
        result.put("location", location.isLocationEnabled());
        NfcAdapter nfc = NfcAdapter.getDefaultAdapter(context);
        result.put("nfc", nfc == null ? "none" : nfc.isEnabled() ? "on" : "off");
        result.put("batterySaver", context.getSystemService(PowerManager.class).isPowerSaveMode());
        return result;
    }

    @PluginMethod
    public void connections(PluginCall call) {
        call.resolve(connectionsState());
    }

    private Boolean isOn(String what) {
        JSObject state = connectionsState();
        try {
            switch (what) {
                case "wifi":
                    return state.getJSObject("wifi").getBoolean("on");
                case "bluetooth":
                    return state.getJSObject("bluetooth").getBoolean("on");
                case "mobile_data":
                    Object on = state.getJSObject("mobileData").opt("on");
                    return on instanceof Boolean ? (Boolean) on : null;
                case "airplane_mode":
                    return state.getBoolean("airplaneMode");
                case "location":
                    return state.getBoolean("location");
                case "nfc":
                    return "on".equals(state.getString("nfc"));
                case "battery_saver":
                    return state.getBoolean("batterySaver");
                default:
                    return null;
            }
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    private Intent panel(String what) {
        switch (what) {
            case "wifi":
                return new Intent(Settings.Panel.ACTION_WIFI);
            case "bluetooth":
                return new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            case "mobile_data":
            case "airplane_mode":
                return new Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY);
            case "location":
                return new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            case "nfc":
                return new Intent(Settings.Panel.ACTION_NFC);
            case "battery_saver":
                return new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS);
            default:
                return null;
        }
    }

    @PluginMethod
    public void setConnection(PluginCall call) {
        String what = call.getString("what", "");
        boolean want = Boolean.TRUE.equals(call.getBoolean("on"));
        Intent intent = panel(what);
        if (intent == null) {
            call.reject("unknown connection " + what);
            return;
        }
        Boolean before = isOn(what);
        if (before != null && before == want) {
            JSObject result = connectionsState();
            result.put("outcome", "already");
            call.resolve(result);
            return;
        }
        if (!TriggersPlugin.inFront(getActivity()) && PhoneScreenService.running == null) {
            call.reject("pi is in the background, and the phone does not let it open the " + what + " panel from there. Ask the user to open pi and try again.", "BACKGROUND");
            return;
        }
        getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        JSObject result = connectionsState();
        result.put("outcome", "panel");
        call.resolve(result);
    }
}
