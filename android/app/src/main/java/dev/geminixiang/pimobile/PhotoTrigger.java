package dev.geminixiang.pimobile;

import android.Manifest;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class PhotoTrigger {

    private static final int JOB = 4713;
    private static final String TAG = "PiTriggers";
    private static final String PREFS = "pi-trigger-photos";
    private static final String KEY_SINCE = "since";
    private static final int LISTED = 5;

    private PhotoTrigger() {}

    static void arm(Context context, boolean wanted) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!wanted) {
            jobs.cancel(JOB);
            prefs.edit().remove(KEY_SINCE).apply();
            return;
        }
        if (!prefs.contains(KEY_SINCE)) prefs.edit().putLong(KEY_SINCE, System.currentTimeMillis() / 1000).apply();
        if (jobs.getPendingJob(JOB) == null) schedule(context);
    }

    private static void schedule(Context context) {
        JobInfo job = new JobInfo.Builder(JOB, new ComponentName(context, Job.class))
            .addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
            .setTriggerContentUpdateDelay(5_000)
            .setTriggerContentMaxDelay(60_000)
            .build();
        context.getSystemService(JobScheduler.class).schedule(job);
    }

    private static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
    }

    private static final class Photo {
        final long id;
        final String album;

        Photo(long id, String album) {
            this.id = id;
            this.album = album == null ? "" : album;
        }
    }

    static void check(Context context) {
        if (!allowed(context)) {
            Log.w(TAG, "photo trigger: no photos permission");
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long since = prefs.getLong(KEY_SINCE, System.currentTimeMillis() / 1000);
        String[] columns = { MediaStore.Images.Media._ID, MediaStore.Images.Media.BUCKET_DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED };
        String where = MediaStore.Images.Media.DATE_ADDED + " > ?" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? " AND " + MediaStore.Images.Media.IS_PENDING + " = 0" : "");
        List<Photo> photos = new ArrayList<>();
        long newest = since;
        try (Cursor cursor = context.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, where, new String[] { String.valueOf(since) }, MediaStore.Images.Media.DATE_ADDED + " DESC")) {
            while (cursor != null && cursor.moveToNext()) {
                photos.add(new Photo(cursor.getLong(0), cursor.getString(1)));
                newest = Math.max(newest, cursor.getLong(2));
            }
        }
        prefs.edit().putLong(KEY_SINCE, newest).apply();
        if (photos.isEmpty()) return;
        TriggerReceiver.event(context, "photo", describe(photos), item -> {
            String album = item.optJSONObject("when").optString("album", "").toLowerCase(Locale.ROOT);
            if (album.isEmpty()) return true;
            for (Photo photo : photos) if (photo.album.toLowerCase(Locale.ROOT).contains(album)) return true;
            return false;
        });
    }

    private static String describe(List<Photo> photos) {
        StringBuilder text = new StringBuilder("拍了 " + photos.size() + " 張新照片：");
        for (int i = 0; i < Math.min(LISTED, photos.size()); i++) {
            Photo photo = photos.get(i);
            text.append(i > 0 ? "、" : "").append(photo.album.isEmpty() ? "" : photo.album + " ").append("id ").append(photo.id);
        }
        if (photos.size() > LISTED) text.append("…");
        return text.toString();
    }

    public static class Job extends JobService {
        @Override
        public boolean onStartJob(JobParameters params) {
            try {
                check(this);
            } finally {
                schedule(this);
            }
            return false;
        }

        @Override
        public boolean onStopJob(JobParameters params) {
            return false;
        }
    }
}
