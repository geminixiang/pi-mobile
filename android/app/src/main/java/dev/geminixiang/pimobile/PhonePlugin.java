package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.StatFs;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Context about the phone for the agent: one location fix with its address, device status, and a single reading of
 * the environmental sensors. Everything is read once, when a tool asks; nothing runs in the background.
 */
@CapacitorPlugin(
    name = "Phone",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location"),
    }
)
public class PhonePlugin extends Plugin {

    private static final long FIX_TIMEOUT_MS = 20_000;
    private static final long SENSOR_WINDOW_MS = 900;

    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean granted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- Location ----------

    /** Coarse alone is enough: the user may choose "approximate" in the permission dialog. */
    private boolean anyLocation() {
        return granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    @PluginMethod
    public void getLocation(PluginCall call) {
        if (!anyLocation()) {
            requestPermissionForAlias("location", call, "locationResult");
            return;
        }
        locate(call);
    }

    @PermissionCallback
    private void locationResult(PluginCall call) {
        if (anyLocation()) locate(call);
        else call.reject("location permission denied", "permission");
    }

    @SuppressWarnings("MissingPermission")
    private void locate(PluginCall call) {
        LocationManager manager = getContext().getSystemService(LocationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && !manager.isLocationEnabled()) {
            call.reject("location is turned off on the phone", "disabled");
            return;
        }
        String provider = pickProvider(manager);
        if (provider == null) {
            call.reject("no location provider is available", "unavailable");
            return;
        }
        AtomicBoolean done = new AtomicBoolean(false);
        CancellationSignal cancel = new CancellationSignal();
        LocationListener[] legacy = new LocationListener[1];
        Runnable timeout = () -> {
            if (!done.compareAndSet(false, true)) return;
            cancel.cancel();
            if (legacy[0] != null) manager.removeUpdates(legacy[0]);
            Location last = lastKnown(manager);
            if (last != null) resolve(call, last, true);
            else call.reject("no location fix within " + FIX_TIMEOUT_MS / 1000 + " seconds", "timeout");
        };
        main.postDelayed(timeout, FIX_TIMEOUT_MS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            manager.getCurrentLocation(provider, cancel, getContext().getMainExecutor(), (location) -> {
                if (!done.compareAndSet(false, true)) return;
                main.removeCallbacks(timeout);
                Location fix = location != null ? location : lastKnown(manager);
                if (fix != null) resolve(call, fix, location == null);
                else call.reject("no location fix", "unavailable");
            });
        } else {
            legacy[0] = new LocationListener() {
                @Override
                public void onLocationChanged(Location location) {
                    if (!done.compareAndSet(false, true)) return;
                    main.removeCallbacks(timeout);
                    resolve(call, location, false);
                }

                @Override
                public void onStatusChanged(String p, int status, Bundle extras) {}

                @Override
                public void onProviderEnabled(String p) {}

                @Override
                public void onProviderDisabled(String p) {}
            };
            manager.requestSingleUpdate(provider, legacy[0], Looper.getMainLooper());
        }
    }

    private String pickProvider(LocationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && manager.hasProvider(LocationManager.FUSED_PROVIDER)) {
            return LocationManager.FUSED_PROVIDER;
        }
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION) && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            return LocationManager.GPS_PROVIDER;
        }
        if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER;
        return null;
    }

    @SuppressWarnings("MissingPermission")
    private Location lastKnown(LocationManager manager) {
        Location best = null;
        for (String provider : manager.getProviders(true)) {
            Location location = manager.getLastKnownLocation(provider);
            if (location != null && (best == null || location.getTime() > best.getTime())) best = location;
        }
        return best;
    }

    /** Reports the fix, with an address from the platform geocoder when it has one. Geocoding blocks, so off the main thread. */
    private void resolve(PluginCall call, Location location, boolean lastKnown) {
        JSObject result = new JSObject();
        result.put("latitude", location.getLatitude());
        result.put("longitude", location.getLongitude());
        if (location.hasAccuracy()) result.put("accuracyMeters", Math.round(location.getAccuracy()));
        if (location.hasAltitude()) result.put("altitudeMeters", Math.round(location.getAltitude()));
        if (location.hasSpeed()) result.put("speedMetersPerSecond", Math.round(location.getSpeed() * 10) / 10.0);
        if (location.hasBearing()) result.put("bearingDegrees", Math.round(location.getBearing()));
        result.put("ageSeconds", Math.max(0, (System.currentTimeMillis() - location.getTime()) / 1000));
        result.put("provider", location.getProvider());
        result.put("approximate", !granted(Manifest.permission.ACCESS_FINE_LOCATION));
        result.put("lastKnown", lastKnown);
        new Thread(() -> {
            JSObject address = geocode(location);
            if (address != null) result.put("address", address);
            call.resolve(result);
        }).start();
    }

    @SuppressWarnings("deprecation")
    private JSObject geocode(Location location) {
        if (!Geocoder.isPresent()) return null;
        try {
            List<Address> found = new Geocoder(getContext(), Locale.getDefault()).getFromLocation(location.getLatitude(), location.getLongitude(), 1);
            if (found == null || found.isEmpty()) return null;
            Address a = found.get(0);
            JSObject address = new JSObject();
            if (a.getMaxAddressLineIndex() >= 0) address.put("line", a.getAddressLine(0));
            if (a.getCountryName() != null) address.put("country", a.getCountryName());
            if (a.getAdminArea() != null) address.put("adminArea", a.getAdminArea());
            if (a.getLocality() != null) address.put("locality", a.getLocality());
            if (a.getSubLocality() != null) address.put("subLocality", a.getSubLocality());
            if (a.getThoroughfare() != null) address.put("street", a.getThoroughfare());
            return address;
        } catch (Exception e) {
            return null;
        }
    }

    /** Address or place name to coordinates, with the platform geocoder (no API key). Blocks, so off the main thread. */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void geocode(PluginCall call) {
        String query = call.getString("query", "").trim();
        if (query.isEmpty()) {
            call.reject("query is empty");
            return;
        }
        if (!Geocoder.isPresent()) {
            call.reject("this phone has no geocoder", "unavailable");
            return;
        }
        new Thread(() -> {
            try {
                List<Address> found = new Geocoder(getContext(), Locale.getDefault()).getFromLocationName(query, 1);
                if (found == null || found.isEmpty()) {
                    call.reject("no place found for " + query, "not_found");
                    return;
                }
                Address a = found.get(0);
                JSObject result = new JSObject();
                result.put("latitude", a.getLatitude());
                result.put("longitude", a.getLongitude());
                if (a.getMaxAddressLineIndex() >= 0) result.put("address", a.getAddressLine(0));
                call.resolve(result);
            } catch (Exception e) {
                call.reject("geocoding failed: " + e.getMessage(), "failed");
            }
        }).start();
    }

    // ---------- Device status ----------

    @PluginMethod
    public void getStatus(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();

        BatteryManager battery = context.getSystemService(BatteryManager.class);
        Intent sticky = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        JSObject power = new JSObject();
        power.put("percent", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
        power.put("charging", battery.isCharging());
        if (sticky != null) {
            int plugged = sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            power.put("plugged", plugged == BatteryManager.BATTERY_PLUGGED_AC ? "ac"
                : plugged == BatteryManager.BATTERY_PLUGGED_USB ? "usb"
                : plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS ? "wireless" : "no");
            int tenths = sticky.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (tenths != Integer.MIN_VALUE) power.put("temperatureCelsius", tenths / 10.0);
        }
        power.put("powerSaving", context.getSystemService(PowerManager.class).isPowerSaveMode());
        result.put("battery", power);

        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        Network active = connectivity.getActiveNetwork();
        NetworkCapabilities caps = active == null ? null : connectivity.getNetworkCapabilities(active);
        JSObject network = new JSObject();
        if (caps == null) {
            network.put("type", "none");
        } else {
            network.put("type", caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : "other");
            network.put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            network.put("metered", connectivity.isActiveNetworkMetered());
            network.put("internet", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        }
        result.put("network", network);

        AudioManager audio = context.getSystemService(AudioManager.class);
        JSObject sound = new JSObject();
        int ringer = audio.getRingerMode();
        sound.put("ringer", ringer == AudioManager.RINGER_MODE_SILENT ? "silent" : ringer == AudioManager.RINGER_MODE_VIBRATE ? "vibrate" : "normal");
        int filter = context.getSystemService(NotificationManager.class).getCurrentInterruptionFilter();
        sound.put("doNotDisturb", filter != NotificationManager.INTERRUPTION_FILTER_ALL && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN);
        JSArray outputs = new JSArray();
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            String kind = audioKind(device.getType());
            if (kind == null) continue;
            JSObject entry = new JSObject();
            entry.put("kind", kind);
            entry.put("name", String.valueOf(device.getProductName()));
            outputs.put(entry);
        }
        sound.put("connectedAudio", outputs);
        result.put("sound", sound);

        StatFs stat = new StatFs(Environment.getDataDirectory().getPath());
        JSObject storage = new JSObject();
        storage.put("freeGB", Math.round(stat.getAvailableBytes() / 1e8) / 10.0);
        storage.put("totalGB", Math.round(stat.getTotalBytes() / 1e8) / 10.0);
        result.put("storage", storage);

        result.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        result.put("android", Build.VERSION.RELEASE);
        call.resolve(result);
    }

    private static String audioKind(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "wired";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
                return "bluetooth";
            default:
                return null;
        }
    }

    // ---------- Sensors ----------

    /** Listens to the environmental sensors for a moment and reports the latest value of each. */
    @PluginMethod
    public void readSensors(PluginCall call) {
        SensorManager manager = getContext().getSystemService(SensorManager.class);
        Sensor[] sensors = {
            manager.getDefaultSensor(Sensor.TYPE_PRESSURE),
            manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR),
            manager.getDefaultSensor(Sensor.TYPE_LIGHT),
            manager.getDefaultSensor(Sensor.TYPE_PROXIMITY),
        };
        String[] names = { "barometer", "compass", "light", "proximity" };
        float[][] latest = new float[sensors.length][];
        SensorEventListener listener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                for (int i = 0; i < sensors.length; i++) if (event.sensor == sensors[i]) latest[i] = event.values.clone();
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        for (Sensor sensor : sensors) {
            if (sensor != null) manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, main);
        }
        main.postDelayed(() -> {
            manager.unregisterListener(listener);
            JSObject result = new JSObject();
            if (latest[0] != null) {
                JSObject air = new JSObject();
                float hPa = latest[0][0];
                air.put("pressureHPa", Math.round(hPa * 10) / 10.0);
                air.put("altitudeMetersEstimate", Math.round(SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, hPa)));
                result.put("barometer", air);
            }
            if (latest[1] != null) result.put("compass", compass(latest[1]));
            if (latest[2] != null) result.put("lightLux", Math.round(latest[2][0]));
            if (latest[3] != null) result.put("proximity", latest[3][0] < sensors[3].getMaximumRange() ? "near" : "far");
            JSArray missing = new JSArray();
            for (int i = 0; i < sensors.length; i++) if (latest[i] == null) missing.put(names[i]);
            if (missing.length() > 0) result.put("noReading", missing);
            call.resolve(result);
        }, SENSOR_WINDOW_MS);
    }

    /** Heading from the rotation vector: magnetic, and true north when a recent location gives the declination. */
    @SuppressWarnings("MissingPermission")
    private JSObject compass(float[] vector) {
        float[] matrix = new float[9];
        float[] orientation = new float[3];
        SensorManager.getRotationMatrixFromVector(matrix, vector);
        SensorManager.getOrientation(matrix, orientation);
        double heading = (Math.toDegrees(orientation[0]) + 360) % 360;
        JSObject compass = new JSObject();
        compass.put("magneticHeadingDegrees", Math.round(heading));
        compass.put("pitchDegrees", Math.round(Math.toDegrees(orientation[1])));
        compass.put("rollDegrees", Math.round(Math.toDegrees(orientation[2])));
        if (anyLocation()) {
            Location last = lastKnown(getContext().getSystemService(LocationManager.class));
            if (last != null) {
                GeomagneticField field = new GeomagneticField(
                    (float) last.getLatitude(), (float) last.getLongitude(), (float) last.getAltitude(), System.currentTimeMillis());
                heading = (heading + field.getDeclination() + 360) % 360;
                compass.put("trueHeadingDegrees", Math.round(heading));
            }
        }
        String[] points = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
        compass.put("facing", points[(int) Math.round(heading / 45) % 8]);
        return compass;
    }
}
