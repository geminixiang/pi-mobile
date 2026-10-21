package dev.geminixiang.pimobile;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.ArrayList;
import java.util.List;

/**
 * Records the notifications other apps show (NotificationStore), once the user allows notification access in system
 * settings. Left out: pi's own, ongoing ones (music, navigation, downloads, foreground services), group summaries, and
 * ones with no text. The system binds this service and starts the app's process for it, so it records whether or not
 * pi is open.
 */
public class NotificationsListener extends NotificationListenerService {

    @Override
    public void onListenerConnected() {
        // What is in the shade now, so a fresh grant has something to read.
        try {
            List<NotificationStore.Row> rows = new ArrayList<>();
            StatusBarNotification[] active = getActiveNotifications();
            if (active != null) for (StatusBarNotification sbn : active) rows.addAll(rowsOf(sbn));
            NotificationStore.get(this).add(rows);
        } catch (RuntimeException ignored) {
            // A listener the system is unbinding again; the next post records normally.
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        NotificationStore.get(this).add(rowsOf(sbn));
    }

    private List<NotificationStore.Row> rowsOf(StatusBarNotification sbn) {
        List<NotificationStore.Row> rows = new ArrayList<>();
        Notification notification = sbn.getNotification();
        String packageName = sbn.getPackageName();
        int skip = Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE | Notification.FLAG_GROUP_SUMMARY;
        if (getPackageName().equals(packageName) || (notification.flags & skip) != 0) return rows;
        Bundle extras = notification.extras;
        String app = appLabel(packageName);
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String conversation = text(extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE));

        // A chat: one row per message, so the history survives the app replacing the notification.
        Parcelable[] messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (messages != null && messages.length > 0) {
            for (Notification.MessagingStyle.Message message : Notification.MessagingStyle.Message.getMessagesFromBundleArray(messages)) {
                String body = text(message.getText());
                if (body.isEmpty()) continue;
                NotificationStore.Row row = new NotificationStore.Row();
                row.packageName = packageName;
                row.app = app;
                row.conversation = conversation.isEmpty() ? title : conversation;
                CharSequence sender = message.getSenderPerson() != null ? message.getSenderPerson().getName() : null;
                row.sender = text(sender);
                row.title = title;
                row.text = body;
                row.time = message.getTimestamp() > 0 ? message.getTimestamp() : sbn.getPostTime();
                row.dedup = packageName + "\u0000" + row.conversation + "\u0000" + row.sender + "\u0000" + row.time + "\u0000" + body;
                rows.add(row);
            }
            return rows;
        }

        CharSequence big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        String body = text(big != null ? big : extras.getCharSequence(Notification.EXTRA_TEXT));
        CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (lines != null && lines.length > 0) {
            // Inbox style (an email app's "3 new messages"): its lines are the messages.
            StringBuilder joined = new StringBuilder();
            for (CharSequence line : lines) joined.append(joined.length() > 0 ? "\n" : "").append(line);
            body = joined.toString();
        }
        if (title.isEmpty() && body.isEmpty()) return rows;
        NotificationStore.Row row = new NotificationStore.Row();
        row.packageName = packageName;
        row.app = app;
        row.conversation = conversation.isEmpty() ? null : conversation;
        row.sender = null;
        row.title = title;
        row.text = body;
        row.time = sbn.getPostTime();
        row.dedup = packageName + "\u0000" + sbn.getKey() + "\u0000" + title + "\u0000" + body;
        rows.add(row);
        return rows;
    }

    private String appLabel(String packageName) {
        try {
            PackageManager manager = getPackageManager();
            ApplicationInfo info = manager.getApplicationInfo(packageName, 0);
            return manager.getApplicationLabel(info).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }
}
