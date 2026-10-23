package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.util.Log;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class TriggerEvents {

    static final String ACTION_PLACE = "dev.geminixiang.pimobile.TRIGGER_PLACE";
    private static final int CHARGING_JOB = 4711;
    private static final String TAG = "PiTriggers";
    private static final String PREFS = "pi-trigger-events";
    private static final String KEY_PLACES = "places";
    private static final String KEY_BOOT = "boot";

    private TriggerEvents() {}

    static void sync(Context context, JSONArray schedules) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int boot = android.provider.Settings.Global.getInt(context.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, 0);
        if (prefs.getInt(KEY_BOOT, -1) != boot) {
            prefs.edit().putInt(KEY_BOOT, boot).putStringSet(KEY_PLACES, new HashSet<>()).apply();
        }
        Set<String> armedPlaces = prefs.getStringSet(KEY_PLACES, new HashSet<>());
        boolean charging = false;
        boolean wifi = false;
        boolean photo = false;
        boolean activity = false;
        Set<String> places = new HashSet<>();
        for (int i = 0; i < schedules.length(); i++) {
            JSONObject item = schedules.optJSONObject(i);
            JSONObject when = item == null ? null : item.optJSONObject("when");
            if (when == null) continue;
            switch (when.optString("kind")) {
                case "charging":
                    charging = true;
                    break;
                case "wifi":
                    wifi = true;
                    break;
                case "photo":
                    photo = true;
                    break;
                case "activity":
                    activity = true;
                    break;
                case "place": {
                    String key = item.optString("id") + "@" + when.optDouble("latitude") + "," + when.optDouble("longitude") + "," + when.optDouble("radius");
                    boolean armed = armedPlaces.contains(key) && alive(placeIntent(context, item.optString("id"), PendingIntent.FLAG_NO_CREATE));
                    if (armed || armPlace(context, item.optString("id"), when)) places.add(key);
                    break;
                }
                default:
                    break;
            }
        }
        PhotoTrigger.arm(context, photo);
        ActivityTrigger.arm(context, activity);
        if (charging) scheduleCharging(context);
        else context.getSystemService(JobScheduler.class).cancel(CHARGING_JOB);
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (wifi && jobs.getPendingJob(WIFI_JOB) == null) {
            prefs.edit().putLong(KEY_WIFI_NETWORK, currentWifi(context)).apply();
            scheduleWifi(context, 0);
        } else if (!wifi) {
            jobs.cancel(WIFI_JOB);
        }
        Set<String> kept = new HashSet<>();
        for (String key : places) kept.add(key.substring(0, key.indexOf('@')));
        for (String key : armedPlaces) {
            if (places.contains(key)) continue;
            String id = key.substring(0, key.indexOf('@'));
            if (kept.contains(id)) continue;
            PendingIntent intent = placeIntent(context, id);
            if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                context.getSystemService(LocationManager.class).removeProximityAlert(intent);
            }
            intent.cancel();
        }
        prefs.edit().putStringSet(KEY_PLACES, places).apply();
    }

    static void scheduleCharging(Context context, long delayMs) {
        JobInfo.Builder job = new JobInfo.Builder(CHARGING_JOB, new ComponentName(context, ChargingJob.class))
            .setRequiresCharging(true)
            .setPersisted(true);
        if (delayMs > 0) job.setMinimumLatency(delayMs);
        context.getSystemService(JobScheduler.class).schedule(job.build());
    }

    static void scheduleCharging(Context context) {
        scheduleCharging(context, 0);
    }

    private static final long CHECK_MS = 15 * 60_000L;

    public static class ChargingJob extends JobService {
        @Override
        public boolean onStartJob(JobParameters params) {
            SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long lastAt = prefs.getLong("charge.at", 0);
            int lastLevel = prefs.getInt("charge.level", -1);
            int level = getSystemService(android.os.BatteryManager.class).getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
            boolean started = lastAt == 0 || now - lastAt > 3 * CHECK_MS || level < lastLevel;
            prefs.edit().putLong("charge.at", now).putInt("charge.level", level).apply();
            Log.i(TAG, "charging check: level " + level + ", last " + lastLevel + (started ? ", new charge" : ", same charge"));
            if (started) TriggerReceiver.event(this, "charging", "開始充電（電量 " + level + "%）", null);
            scheduleCharging(this, CHECK_MS);
            return false;
        }

        @Override
        public boolean onStopJob(JobParameters params) {
            return false;
        }
    }

    private static boolean alive(PendingIntent intent) {
        return intent != null;
    }

    private static final int WIFI_JOB = 4712;
    private static final String KEY_WIFI_NETWORK = "wifi.network";

    static void scheduleWifi(Context context, long delayMs) {
        NetworkRequest wifi = new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build();
        JobInfo.Builder job = new JobInfo.Builder(WIFI_JOB, new ComponentName(context, WifiJob.class)).setRequiredNetwork(wifi).setPersisted(true);
        if (delayMs > 0) job.setMinimumLatency(delayMs);
        context.getSystemService(JobScheduler.class).schedule(job.build());
    }

    private static long currentWifi(Context context) {
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        android.net.Network network = connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? network.getNetworkHandle() : 0;
    }

    public static class WifiJob extends JobService {
        @Override
        public boolean onStartJob(JobParameters params) {
            android.net.Network network = params.getNetwork();
            long handle = network != null ? network.getNetworkHandle() : currentWifi(this);
            SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean fresh = handle != 0 && handle != prefs.getLong(KEY_WIFI_NETWORK, 0);
            prefs.edit().putLong(KEY_WIFI_NETWORK, handle).apply();
            Log.i(TAG, "wifi check: network " + handle + (fresh ? ", new connection" : ", same connection"));
            if (fresh) TriggerReceiver.wifi(this);
            scheduleWifi(this, CHECK_MS);
            return false;
        }

        @Override
        public boolean onStopJob(JobParameters params) {
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    static String wifiName(Context context) {
        WifiInfo info = context.getSystemService(WifiManager.class).getConnectionInfo();
        String ssid = info == null ? null : info.getSSID();
        if (ssid == null || ssid.equals(WifiManager.UNKNOWN_SSID) || ssid.isEmpty()) return null;
        return ssid.replaceAll("^\"|\"$", "");
    }

    private static PendingIntent placeIntent(Context context, String id) {
        return placeIntent(context, id, PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent placeIntent(Context context, String id, int flags) {
        Intent intent = new Intent(context, TriggerReceiver.class)
            .setAction(ACTION_PLACE)
            .setData(Uri.parse("pimobile-place://" + Uri.encode(id)))
            .putExtra(TriggerStore.EXTRA_ID, id);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE | flags);
    }

    private static boolean armPlace(Context context, String id, JSONObject when) {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "no location permission; place schedule " + id + " cannot be armed");
            return false;
        }
        try {
            LocationManager location = context.getSystemService(LocationManager.class);
            PendingIntent intent = placeIntent(context, id);
            location.removeProximityAlert(intent);
            location.addProximityAlert(when.optDouble("latitude"), when.optDouble("longitude"), (float) when.optDouble("radius", 200), -1, intent);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_ARMED_PREFIX + id, System.currentTimeMillis()).apply();
            return true;
        } catch (SecurityException | IllegalArgumentException error) {
            Log.w(TAG, "could not arm place schedule " + id, error);
            return false;
        }
    }

    private static final String KEY_ARMED_PREFIX = "armed.";
    private static final long SETTLE_MS = 2 * 60_000L;

    static boolean settling(Context context, String id) {
        long armed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_ARMED_PREFIX + id, 0);
        return System.currentTimeMillis() - armed < SETTLE_MS;
    }

    static boolean backgroundLocation(Context context) {
        return context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
}
