package dev.geminixiang.pimobile;

import android.content.pm.ResolveInfo;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Intent;
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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
        Set<String> seen = new HashSet<>();
        int unlocks = 0;
        UsageEvents.Event event = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            String pkg = event.getPackageName();
            switch (event.getEventType()) {
                case UsageEvents.Event.ACTIVITY_RESUMED:
                    seen.add(pkg);
                    started.putIfAbsent(pkg, event.getTimeStamp());
                    break;
                case UsageEvents.Event.ACTIVITY_PAUSED:
                case UsageEvents.Event.ACTIVITY_STOPPED: {
                    Long start = started.remove(pkg);
                    boolean inFrontAtFrom = start == null && seen.add(pkg) && from > 0;
                    if (inFrontAtFrom) start = from;
                    if (start != null) total.merge(pkg, event.getTimeStamp() - start, Long::sum);
                    break;
                }
                case UsageEvents.Event.KEYGUARD_HIDDEN:
                    unlocks++;
                    break;
                case UsageEvents.Event.SCREEN_NON_INTERACTIVE:
                    for (Map.Entry<String, Long> open : started.entrySet()) total.merge(open.getKey(), event.getTimeStamp() - open.getValue(), Long::sum);
                    started.clear();
                    break;
                default:
                    break;
            }
        }
        for (Map.Entry<String, Long> open : started.entrySet()) total.merge(open.getKey(), to - open.getValue(), Long::sum);
        PackageManager manager = getContext().getPackageManager();
        Map<String, String> launcherLabels = new HashMap<>();
        for (ResolveInfo launcher : manager.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
            launcherLabels.put(launcher.activityInfo.packageName, launcher.loadLabel(manager).toString());
        }
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(total.entrySet());
        sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
        JSArray items = new JSArray();
        for (Map.Entry<String, Long> entry : sorted) {
            if (entry.getValue() < 60_000) continue;
            String label = launcherLabels.get(entry.getKey());
            if (label == null || entry.getKey().equals(homePackage())) continue;
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
