package dev.geminixiang.pimobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.ExifInterface;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "Photos",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.ACCESS_MEDIA_LOCATION }, alias = "photos"),
        @Permission(strings = { Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED }, alias = "selected")
    }
)
public class PhotosPlugin extends Plugin {

    private boolean allowed() {
        return getPermissionState("photos") == PermissionState.GRANTED
            || getPermissionState("selected") == PermissionState.GRANTED;
    }

    private boolean ensurePermission(PluginCall call, String callback) {
        if (allowed()) return true;
        if (!TriggersPlugin.inFront(getActivity())) {
            call.reject("pi has no photos permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.");
            return false;
        }
        requestPermissionForAliases(new String[] { "photos", "selected" }, call, callback);
        return false;
    }

    @PluginMethod
    public void search(PluginCall call) {
        if (ensurePermission(call, "searchResult")) list(call);
    }

    @PermissionCallback
    private void searchResult(PluginCall call) {
        if (allowed()) list(call);
        else call.reject("photos permission denied", "permission");
    }

    private void list(PluginCall call) {
        long from = call.getLong("from", 0L);
        long to = call.getLong("to", Long.MAX_VALUE);
        int limit = call.getInt("limit", 200);
        String album = call.getString("album");
        ContentResolver resolver = getContext().getContentResolver();
        String[] columns = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
        };
        String taken = "COALESCE(" + MediaStore.Images.Media.DATE_TAKEN + ", " + MediaStore.Images.Media.DATE_ADDED + " * 1000)";
        String where = taken + " >= " + from + " AND " + taken + " <= " + to + (album != null ? " AND " + MediaStore.Images.Media.BUCKET_DISPLAY_NAME + " LIKE ?" : "");
        String[] args = album != null ? new String[] { "%" + album + "%" } : null;
        List<JSObject> rows = new ArrayList<>();
        List<Long> ids = new ArrayList<>();
        try (Cursor cursor = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, where, args, taken + " DESC")) {
            while (cursor != null && cursor.moveToNext() && rows.size() < limit) {
                long id = cursor.getLong(0);
                JSObject item = new JSObject();
                item.put("id", String.valueOf(id));
                item.put("name", cursor.getString(1));
                item.put("time", cursor.isNull(2) ? cursor.getLong(3) * 1000 : cursor.getLong(2));
                item.put("album", cursor.getString(4));
                item.put("width", cursor.getInt(5));
                item.put("height", cursor.getInt(6));
                rows.add(item);
                ids.add(id);
            }
        }
        Background.run(call, () -> {
            Map<Long, double[]> places = places(resolver, ids);
            JSArray items = new JSArray();
            for (int i = 0; i < rows.size(); i++) {
                double[] place = places.get(ids.get(i));
                if (place != null && place.length == 2) {
                    rows.get(i).put("latitude", place[0]);
                    rows.get(i).put("longitude", place[1]);
                }
                items.put(rows.get(i));
            }
            JSObject result = new JSObject();
            result.put("items", items);
            call.resolve(result);
        });
    }

    private Map<Long, double[]> places(ContentResolver resolver, List<Long> ids) {
        PlacesCache cache = PlacesCache.get(getContext());
        Map<Long, double[]> known = cache.lookup(ids);
        List<Long> missing = new ArrayList<>();
        for (long id : ids) if (!known.containsKey(id)) missing.add(id);
        if (missing.isEmpty()) return known;
        Map<Long, double[]> read = new ConcurrentHashMap<>();
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(2, Runtime.getRuntime().availableProcessors()));
        for (long id : missing) {
            pool.execute(() -> {
                double[] place = place(resolver, ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id));
                if (place != null) read.put(id, place);
            });
        }
        pool.shutdown();
        try {
            pool.awaitTermination(2, TimeUnit.MINUTES);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        cache.store(read);
        known.putAll(read);
        return known;
    }

    private static double[] place(ContentResolver resolver, Uri uri) {
        try (InputStream input = resolver.openInputStream(MediaStore.setRequireOriginal(uri))) {
            if (input == null) return null;
            float[] latLong = new float[2];
            if (!new ExifInterface(input).getLatLong(latLong) || (latLong[0] == 0 && latLong[1] == 0)) return PlacesCache.NONE;
            return new double[] { latLong[0], latLong[1] };
        } catch (IOException | SecurityException | UnsupportedOperationException error) {
            return null;
        }
    }

    @PluginMethod
    public void view(PluginCall call) {
        if (!allowed()) {
            call.reject("no photos permission");
            return;
        }
        int edge = call.getInt("edge", 1280);
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Long.parseLong(call.getString("id", "0")));
        try {
            Bitmap bitmap = getContext().getContentResolver().loadThumbnail(uri, new Size(edge, edge), null);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out);
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            result.put("width", bitmap.getWidth());
            result.put("height", bitmap.getHeight());
            call.resolve(result);
        } catch (IOException | NumberFormatException error) {
            call.reject("could not read that photo", error);
        }
    }
}
