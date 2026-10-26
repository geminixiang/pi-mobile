package dev.geminixiang.pimobile;

import android.os.Bundle;
import android.os.Environment;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(AppsPlugin.class);
        registerPlugin(CalendarPlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(TriggersPlugin.class);
        registerPlugin(NotificationsPlugin.class);
        registerPlugin(DatabasePlugin.class);
        registerPlugin(LoopbackPlugin.class);
        registerPlugin(StreamFetchPlugin.class);
        registerPlugin(ContactsPlugin.class);
        registerPlugin(PhotosPlugin.class);
        registerPlugin(RecordsPlugin.class);
        registerPlugin(UsagePlugin.class);
        registerPlugin(ScannerPlugin.class);
        registerPlugin(HealthPlugin.class);
        registerPlugin(BotFilesPlugin.class);
        registerPlugin(PagePlugin.class);
        registerPlugin(PhoneScreenPlugin.class);
        registerPlugin(PhoneStatePlugin.class);
        super.onCreate(savedInstanceState);
        removeSshKey();
        removeOldCaptures();
    }

    private static final long CAPTURE_KEPT_MS = 24 * 60 * 60 * 1000L;

    private void removeOldCaptures() {
        File dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - CAPTURE_KEPT_MS;
        for (File file : files) if (file.getName().startsWith("JPEG_") && file.lastModified() < cutoff) file.delete();
    }

    private void removeSshKey() {
        File dir = new File(getFilesDir(), "ssh");
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) file.delete();
        dir.delete();
    }
}
