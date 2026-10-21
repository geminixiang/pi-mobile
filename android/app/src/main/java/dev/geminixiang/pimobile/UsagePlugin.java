package dev.geminixiang.pimobile;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Screen time: how long each app was in front between two times, from UsageStatsManager's events (resumed to paused),
 * which is what Digital Wellbeing counts, rather than its daily totals that follow UTC days. Needs usage access, which
 * the user turns on in system settings.
 */
@CapacitorPlugin(name = "Usage")
public class UsagePlugin extends Plugin {

    private boolean allowed() {
        AppOpsManager ops = getContext().getSystemService(AppOpsManager.class);
        return ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName()) == AppOpsManager.MODE_ALLOWED;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", allowed());
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException e) {
            getContext().startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Per app, the time in front between `from` and `to` (ms), longest first; and how many times the screen was unlocked. */
    @PluginMethod
    public void apps(PluginCall call) {
        if (!allowed()) {
            call.reject("usage access is off");
            return;
        }
        long from = call.getLong("from", 0L);
        long to = Math.min(call.getLong("to", System.currentTimeMillis()), System.currentTimeMillis());
        UsageEvents events = getContext().getSystemService(UsageStatsManager.class).queryEvents(from, to);
        Map<String, Long> started = new HashMap<>();
        Map<String, Long> total = new HashMap<>();
        int unlocks = 0;
        UsageEvents.Event event = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            String pkg = event.getPackageName();
            switch (event.getEventType()) {
                case UsageEvents.Event.ACTIVITY_RESUMED:
                    started.putIfAbsent(pkg, event.getTimeStamp());
                    break;
                case UsageEvents.Event.ACTIVITY_PAUSED:
                case UsageEvents.Event.ACTIVITY_STOPPED: {
                    Long start = started.remove(pkg);
                    if (start != null) total.merge(pkg, event.getTimeStamp() - start, Long::sum);
                    break;
                }
                case UsageEvents.Event.KEYGUARD_HIDDEN:
                    unlocks++;
                    break;
                // The screen went off: whatever was in front stops counting, even if its pause never came.
                case UsageEvents.Event.SCREEN_NON_INTERACTIVE:
                    for (Map.Entry<String, Long> open : started.entrySet()) total.merge(open.getKey(), event.getTimeStamp() - open.getValue(), Long::sum);
                    started.clear();
                    break;
                default:
                    break;
            }
        }
        // Still in front at `to`.
        for (Map.Entry<String, Long> open : started.entrySet()) total.merge(open.getKey(), to - open.getValue(), Long::sum);
        PackageManager manager = getContext().getPackageManager();
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(total.entrySet());
        sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
        JSArray items = new JSArray();
        for (Map.Entry<String, Long> entry : sorted) {
            // Under a minute is passing through (a share sheet, a notification tap), not use.
            if (entry.getValue() < 60_000) continue;
            String label = entry.getKey();
            boolean launcher = false;
            try {
                ApplicationInfo info = manager.getApplicationInfo(entry.getKey(), 0);
                label = manager.getApplicationLabel(info).toString();
                launcher = manager.getLaunchIntentForPackage(entry.getKey()) != null;
            } catch (PackageManager.NameNotFoundException ignored) {
                // An app since removed: its package name.
            }
            // The home screen and system UI are not "apps the user used".
            if (!launcher || entry.getKey().equals(homePackage())) continue;
            JSObject item = new JSObject();
            item.put("package", entry.getKey());
            item.put("app", label);
            item.put("ms", entry.getValue());
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        result.put("unlocks", unlocks);
        call.resolve(result);
    }

    private String homePackage() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        android.content.pm.ResolveInfo info = getContext().getPackageManager().resolveActivity(home, 0);
        return info != null && info.activityInfo != null ? info.activityInfo.packageName : "";
    }
}
