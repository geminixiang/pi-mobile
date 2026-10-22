package dev.geminixiang.pimobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.IOException;
import java.io.InputStream;

/**
 * Keeps the app process running while the agent works: a foreground service (so Android does not freeze or kill the
 * process when the app is in the background or the screen is locked) plus a partial wake lock (so the CPU keeps
 * running with the screen off). The WebView, and the agent loop in it, live in the same process and keep going.
 * Started and stopped by KeepAlivePlugin from the web side when runs begin and end.
 */
public class AgentService extends Service {

    static final String CHANNEL_WORKING = "agent-working";
    static final String CHANNEL_DONE = "agent-done";
    static final String CHANNEL_PROACTIVE = "agent-proactive";
    static final String CHANNEL_APPROVAL = "agent-approval";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_TITLE = "title";
    private static final int NOTIFICATION_ID = 1;
    /** Safety net: release the wake lock even if the web side never says the run ended. */
    private static final long WAKE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000L;

    private PowerManager.WakeLock wakeLock;

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel working = new NotificationChannel(CHANNEL_WORKING, "pi 工作中", NotificationManager.IMPORTANCE_LOW);
        working.setDescription("agent 在背景執行時顯示");
        working.setShowBadge(false);
        manager.createNotificationChannel(working);
        NotificationChannel done = new NotificationChannel(CHANNEL_DONE, "pi 完成", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("app 不在前景時，agent 完成或需要你確認");
        manager.createNotificationChannel(done);
        NotificationChannel proactive = new NotificationChannel(CHANNEL_PROACTIVE, "pi 主動通知", NotificationManager.IMPORTANCE_DEFAULT);
        proactive.setDescription("排程和其他觸發執行的結果");
        manager.createNotificationChannel(proactive);
        NotificationChannel approval = new NotificationChannel(CHANNEL_APPROVAL, "pi 需要確認", NotificationManager.IMPORTANCE_HIGH);
        approval.setDescription("app 不在前景時，agent 要做需要你允許的操作");
        manager.createNotificationChannel(approval);
    }

    static Icon avatar(Context context, String id) {
        if (id == null || !id.matches("[a-z]+")) return null;
        try (InputStream in = context.getAssets().open("public/avatars/" + id + ".webp")) {
            Bitmap bitmap = BitmapFactory.decodeStream(in);
            return bitmap == null ? null : Icon.createWithBitmap(bitmap);
        } catch (IOException error) {
            return null;
        }
    }

    static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build(String title, String text) {
        return new Notification.Builder(this, CHANNEL_WORKING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(this))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null && intent.hasExtra(EXTRA_TEXT) ? intent.getStringExtra(EXTRA_TEXT) : "";
        createChannels(this);
        String title = intent != null && intent.hasExtra(EXTRA_TITLE) ? intent.getStringExtra(EXTRA_TITLE) : "pi 工作中";
        Notification notification = build(title, text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        if (wakeLock == null) {
            PowerManager power = getSystemService(PowerManager.class);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:agent");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        // Not sticky: if Android kills the process anyway, the next launch resumes the run (pi-durable).
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
