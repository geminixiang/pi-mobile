package dev.geminixiang.pimobile;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.service.notification.NotificationListenerService;
import android.util.Log;

/**
 * Ends a Do Not Disturb the agent set with an end time (NotificationsPlugin.setDnd). Only the notification listener may
 * change it; when pi's process was gone, the system has not bound the listener yet, so this asks for a rebind and the
 * listener turns it off when it connects (NotificationsListener.onListenerConnected).
 */
public class DndReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!NotificationsPlugin.ACTION_DND_END.equals(intent.getAction())) return;
        NotificationsListener listener = NotificationsListener.instance;
        if (listener != null) {
            end(context, listener);
            return;
        }
        context.getSharedPreferences(NotificationsPlugin.DND_PREFS, 0).edit().putBoolean(PENDING, true).apply();
        NotificationListenerService.requestRebind(new ComponentName(context, NotificationsListener.class));
        Log.i("PiDnd", "listener not bound; ending Do Not Disturb when it connects");
    }

    static final String PENDING = "pending-end";

    static void end(Context context, NotificationsListener listener) {
        listener.requestInterruptionFilter(NotificationListenerService.INTERRUPTION_FILTER_ALL);
        context.getSharedPreferences(NotificationsPlugin.DND_PREFS, 0).edit().putLong(NotificationsPlugin.DND_UNTIL, 0).putBoolean(PENDING, false).apply();
    }
}
