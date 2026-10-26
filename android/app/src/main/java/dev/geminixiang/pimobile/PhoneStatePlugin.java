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
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
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
            if (Build.VERSION.SDK_INT >= 31 && caps.getTransportInfo() instanceof WifiInfo) {
                String ssid = ((WifiInfo) caps.getTransportInfo()).getSSID();
                if (ssid != null && !ssid.contains("unknown ssid")) wifiState.put("name", ssid.replaceAll("^\"|\"$", ""));
            }
        }
        if (wifiConnected && !wifiState.has("name")) {
            WifiInfo info = wifi.getConnectionInfo();
            String ssid = info == null ? null : info.getSSID();
            if (ssid != null && !ssid.contains("unknown ssid")) wifiState.put("name", ssid.replaceAll("^\"|\"$", ""));
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
        if (phone != null && Build.VERSION.SDK_INT >= 26) {
            try {
                mobile.put("on", phone.isDataEnabled());
            } catch (SecurityException e) {
                mobile.put("on", "unknown");
            }
        }
        result.put("mobileData", mobile);
        result.put("airplaneMode", Settings.Global.getInt(context.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0) == 1);
        LocationManager location = context.getSystemService(LocationManager.class);
        result.put("location", Build.VERSION.SDK_INT >= 28 && location.isLocationEnabled());
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
        boolean panels = Build.VERSION.SDK_INT >= 29;
        switch (what) {
            case "wifi":
                return new Intent(panels ? Settings.Panel.ACTION_WIFI : Settings.ACTION_WIFI_SETTINGS);
            case "bluetooth":
                return new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            case "mobile_data":
            case "airplane_mode":
                return new Intent(panels ? Settings.Panel.ACTION_INTERNET_CONNECTIVITY : Settings.ACTION_WIRELESS_SETTINGS);
            case "location":
                return new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            case "nfc":
                return new Intent(panels ? Settings.Panel.ACTION_NFC : Settings.ACTION_NFC_SETTINGS);
            case "battery_saver":
                return new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS);
            default:
                return null;
        }
    }

    private static final String[][] LABELS = {
        { "wifi", "wi-fi", "wifi", "wlan" },
        { "bluetooth", "藍牙", "bluetooth" },
        { "mobile_data", "行動數據", "mobile data", "數據" },
        { "airplane_mode", "飛航", "airplane", "flight" },
        { "location", "位置", "定位", "location" },
        { "nfc", "nfc" },
        { "battery_saver", "省電", "battery saver", "power saving" },
    };

    private String[] labelsOf(String what) {
        for (String[] row : LABELS) if (row[0].equals(what)) return row;
        return new String[] { what };
    }

    private AccessibilityNodeInfo findSwitch(AccessibilityNodeInfo node, String[] labels, boolean firstOnly) {
        if (node == null || !node.isVisibleToUser()) return null;
        if (node.isCheckable()) {
            if (firstOnly) return node;
            String own = describe(node);
            AccessibilityNodeInfo parent = node.getParent();
            String around = parent == null ? "" : describe(parent);
            for (int i = 1; i < labels.length; i++) if ((own + " " + around).contains(labels[i])) return node;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findSwitch(node.getChild(i), labels, firstOnly);
            if (found != null) return found;
        }
        return null;
    }

    private static String describe(AccessibilityNodeInfo node) {
        StringBuilder text = new StringBuilder();
        collect(node, text, 0);
        return text.toString().toLowerCase(Locale.ROOT);
    }

    private static void collect(AccessibilityNodeInfo node, StringBuilder into, int depth) {
        if (node == null || depth > 3 || into.length() > 200) return;
        if (node.getText() != null) into.append(node.getText()).append(' ');
        if (node.getContentDescription() != null) into.append(node.getContentDescription()).append(' ');
        for (int i = 0; i < node.getChildCount(); i++) collect(node.getChild(i), into, depth + 1);
    }

    private boolean press(AccessibilityNodeInfo node) {
        for (AccessibilityNodeInfo at = node; at != null; at = at.getParent()) {
            if (at.isClickable()) return at.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        return false;
    }

    private static boolean directly(String what) {
        return ("wifi".equals(what) && Build.VERSION.SDK_INT < 29) || ("bluetooth".equals(what) && Build.VERSION.SDK_INT < 33);
    }

    @SuppressWarnings({ "deprecation", "MissingPermission" })
    private boolean switchDirectly(String what, boolean on) {
        Context context = getContext();
        if ("wifi".equals(what) && Build.VERSION.SDK_INT < 29) {
            return context.getApplicationContext().getSystemService(WifiManager.class).setWifiEnabled(on) && settle(what, on);
        }
        if ("bluetooth".equals(what) && Build.VERSION.SDK_INT < 33) {
            if (Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) return false;
            BluetoothManager manager = context.getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            return adapter != null && (on ? adapter.enable() : adapter.disable()) && settle(what, on);
        }
        return false;
    }

    private boolean settle(String what, boolean on) {
        for (int wait = 0; wait < 25; wait++) {
            Boolean now = isOn(what);
            if (now != null && now == on) return true;
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }

    private void returnTo(PhoneScreenService service, String previous) throws InterruptedException {
        for (int wait = 0; wait < 10; wait++) {
            Thread.sleep(150);
            AccessibilityNodeInfo front = service.getRootInActiveWindow();
            if (front != null && front.getPackageName() != null && previous.equals(front.getPackageName().toString())) return;
        }
        Intent back = getContext().getPackageManager().getLaunchIntentForPackage(previous);
        if (back != null) getContext().startActivity(back.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
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
        if (directly(what)) {
            worker.execute(() -> {
                boolean done = switchDirectly(what, want);
                JSObject result = connectionsState();
                Boolean now = isOn(what);
                result.put("outcome", now != null && now == want ? "changed" : done ? "pressed" : "refused");
                call.resolve(result);
            });
            return;
        }
        PhoneScreenService service = PhoneScreenService.running;
        AccessibilityNodeInfo shown = service == null ? null : service.getRootInActiveWindow();
        String previous = shown == null || shown.getPackageName() == null ? null : shown.getPackageName().toString();
        getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        if (service == null) {
            JSObject result = connectionsState();
            result.put("outcome", "panel");
            call.resolve(result);
            return;
        }
        worker.execute(() -> {
            String outcome = "panel";
            try {
                AccessibilityNodeInfo target = null;
                String settingsPackage = null;
                boolean shared = "mobile_data".equals(what) || "airplane_mode".equals(what);
                for (int wait = 0; wait < 40 && target == null; wait++) {
                    Thread.sleep(150);
                    if (wait == 20) getContext().startActivity(new Intent(intent));
                    for (AccessibilityWindowInfo window : service.getWindows()) {
                        if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION && window.getType() != AccessibilityWindowInfo.TYPE_SYSTEM) continue;
                        if (!window.isActive() && !window.isFocused()) continue;
                        AccessibilityNodeInfo root = window.getRoot();
                        if (root == null || root.getPackageName() == null || root.getPackageName().toString().equals(getContext().getPackageName())) continue;
                        target = findSwitch(root, labelsOf(what), false);
                        if (target == null && !shared) target = findSwitch(root, labelsOf(what), true);
                        if (target != null) {
                            settingsPackage = root.getPackageName().toString();
                            break;
                        }
                    }
                }
                if (target != null && target.isChecked() != want && press(target)) {
                    outcome = "pressed";
                    for (int wait = 0; wait < 20; wait++) {
                        Thread.sleep(200);
                        Boolean now = isOn(what);
                        if (now != null && now == want) {
                            outcome = "changed";
                            break;
                        }
                    }
                }
                AccessibilityNodeInfo front = service.getRootInActiveWindow();
                boolean stillThere = front != null && front.getPackageName() != null && front.getPackageName().toString().equals(settingsPackage);
                if (!"panel".equals(outcome) && stillThere) service.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
                if (!"panel".equals(outcome) && previous != null) returnTo(service, previous);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            JSObject result = connectionsState();
            result.put("outcome", outcome);
            call.resolve(result);
        });
    }
}
