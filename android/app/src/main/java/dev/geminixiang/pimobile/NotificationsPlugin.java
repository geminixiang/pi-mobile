package dev.geminixiang.pimobile;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/** The recorded notifications (NotificationsListener) for the agent, and notification access for settings. */
@CapacitorPlugin(name = "Notifications")
public class NotificationsPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName()));
        call.resolve(result);
    }

    /** The system page where the user allows or revokes notification access; pi's own entry when the system has one. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 30) {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            intent.putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(getContext(), NotificationsListener.class).flattenToString()
            );
        } else {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException e) {
            getContext().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        long since = call.getLong("since", System.currentTimeMillis() - 24 * 3600_000L);
        int limit = Math.max(1, Math.min(call.getInt("limit", 50), 300));
        List<NotificationStore.Row> rows = NotificationStore.get(getContext()).list(since, call.getString("app"), call.getString("query"), limit);
        JSArray items = new JSArray();
        for (NotificationStore.Row row : rows) {
            JSObject item = new JSObject();
            item.put("package", row.packageName);
            item.put("app", row.app);
            if (row.conversation != null) item.put("conversation", row.conversation);
            if (row.sender != null && !row.sender.isEmpty()) item.put("sender", row.sender);
            item.put("title", row.title);
            item.put("text", row.text);
            item.put("time", row.time);
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        NotificationStore.get(getContext()).clear();
        call.resolve();
    }
}
