package dev.geminixiang.pimobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Where each photo (by MediaStore id) was taken, from its EXIF, read once. NONE marks a photo without a place. */
final class PlacesCache extends SQLiteOpenHelper {

    static final double[] NONE = new double[0];
    private static PlacesCache instance;

    static synchronized PlacesCache get(Context context) {
        if (instance == null) instance = new PlacesCache(context.getApplicationContext());
        return instance;
    }

    private PlacesCache(Context context) {
        super(context, "photo-places.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE places (id INTEGER PRIMARY KEY, lat REAL, lon REAL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    /** The known ones among `ids`; a photo without a place maps to NONE. */
    Map<Long, double[]> lookup(List<Long> ids) {
        Map<Long, double[]> known = new HashMap<>();
        SQLiteDatabase db = getReadableDatabase();
        for (int start = 0; start < ids.size(); start += 500) {
            StringBuilder in = new StringBuilder();
            for (long id : ids.subList(start, Math.min(ids.size(), start + 500))) in.append(in.length() > 0 ? "," : "").append(id);
            try (Cursor cursor = db.rawQuery("SELECT id, lat, lon FROM places WHERE id IN (" + in + ")", null)) {
                while (cursor.moveToNext()) known.put(cursor.getLong(0), cursor.isNull(1) ? NONE : new double[] { cursor.getDouble(1), cursor.getDouble(2) });
            }
        }
        return known;
    }

    void store(Map<Long, double[]> places) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Map.Entry<Long, double[]> entry : places.entrySet()) {
                ContentValues values = new ContentValues();
                values.put("id", entry.getKey());
                if (entry.getValue().length == 2) {
                    values.put("lat", entry.getValue()[0]);
                    values.put("lon", entry.getValue()[1]);
                }
                db.insertWithOnConflict("places", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }
}
