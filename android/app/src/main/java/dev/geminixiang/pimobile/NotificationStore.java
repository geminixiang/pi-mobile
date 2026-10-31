package dev.geminixiang.pimobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.List;

public final class NotificationStore extends SQLiteOpenHelper {

    static final long KEEP_MS = 30L * 24 * 3600_000;
    private static NotificationStore instance;

    static synchronized NotificationStore get(Context context) {
        if (instance == null) instance = new NotificationStore(context.getApplicationContext());
        return instance;
    }

    private NotificationStore(Context context) {
        super(context, "notifications.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, app TEXT NOT NULL, " +
            "conversation TEXT, sender TEXT, title TEXT, text TEXT, time INTEGER NOT NULL, dedup TEXT NOT NULL UNIQUE)"
        );
        db.execSQL("CREATE INDEX notifications_time ON notifications (time)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    public static final class Row {
        String packageName;
        String app;
        String conversation;
        String sender;
        String title;
        String text;
        long time;
        String dedup;
    }

    synchronized List<Row> add(List<Row> rows) {
        List<Row> added = new ArrayList<>();
        if (rows.isEmpty()) return added;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Row row : rows) {
                ContentValues values = new ContentValues();
                values.put("package", row.packageName);
                values.put("app", row.app);
                values.put("conversation", row.conversation);
                values.put("sender", row.sender);
                values.put("title", row.title);
                values.put("text", row.text);
                values.put("time", row.time);
                values.put("dedup", row.dedup);
                if (db.insertWithOnConflict("notifications", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1) added.add(row);
            }
            db.delete("notifications", "time < ?", new String[] { String.valueOf(System.currentTimeMillis() - KEEP_MS) });
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return added;
    }

    synchronized List<Row> list(long since, String app, String query, int limit) {
        List<String> args = new ArrayList<>();
        StringBuilder where = new StringBuilder("time >= ?");
        args.add(String.valueOf(since));
        if (app != null && !app.isEmpty()) {
            where.append(" AND (app LIKE ? OR package LIKE ?)");
            args.add("%" + app + "%");
            args.add("%" + app + "%");
        }
        if (query != null && !query.isEmpty()) {
            where.append(" AND (title LIKE ? OR text LIKE ? OR sender LIKE ? OR conversation LIKE ?)");
            for (int i = 0; i < 4; i++) args.add("%" + query + "%");
        }
        List<Row> rows = new ArrayList<>();
        try (
            Cursor cursor = getReadableDatabase().query(
                "notifications",
                new String[] { "package", "app", "conversation", "sender", "title", "text", "time" },
                where.toString(),
                args.toArray(new String[0]),
                null,
                null,
                "time DESC",
                limit > 0 ? String.valueOf(limit) : null
            )
        ) {
            while (cursor.moveToNext()) {
                Row row = new Row();
                row.packageName = cursor.getString(0);
                row.app = cursor.getString(1);
                row.conversation = cursor.getString(2);
                row.sender = cursor.getString(3);
                row.title = cursor.getString(4);
                row.text = cursor.getString(5);
                row.time = cursor.getLong(6);
                rows.add(row);
            }
        }
        return rows;
    }

    synchronized void clear() {
        getWritableDatabase().delete("notifications", null, null);
    }
}
