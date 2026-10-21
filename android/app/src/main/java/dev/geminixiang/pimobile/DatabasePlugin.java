package dev.geminixiang.pimobile;

import android.content.Intent;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The user's own SQLite database for the agent's sql tool: one file on the phone (databases/pi-data.db), shared by the
 * bots, holding whatever tables they create (a ledger, a reading list, a weight log). Statements of one call run in one
 * transaction. Off the main thread, since a query can take a while.
 */
@CapacitorPlugin(name = "Database")
public class DatabasePlugin extends Plugin {

    private static final String NAME = "pi-data.db";
    private SQLiteDatabase db;

    private synchronized SQLiteDatabase db() {
        if (db == null || !db.isOpen()) {
            db = SQLiteDatabase.openOrCreateDatabase(getContext().getDatabasePath(NAME), null);
            db.execSQL("PRAGMA foreign_keys = ON");
        }
        return db;
    }

    /** statements: [{ sql, params? }]; results: one per statement, rows for queries, changes for the rest. */
    @PluginMethod
    public void execute(PluginCall call) {
        JSArray statements = call.getArray("statements");
        new Thread(() -> {
            SQLiteDatabase database = db();
            JSArray results = new JSArray();
            int index = 0;
            database.beginTransaction();
            try {
                for (; index < statements.length(); index++) {
                    JSONObject statement = statements.getJSONObject(index);
                    String sql = statement.getString("sql");
                    JSONArray params = statement.optJSONArray("params");
                    results.put(run(database, sql, params == null ? new JSONArray() : params));
                }
                database.setTransactionSuccessful();
            } catch (Exception e) {
                call.reject("statement " + (index + 1) + ": " + e.getMessage());
                return;
            } finally {
                database.endTransaction();
            }
            JSObject result = new JSObject();
            result.put("results", results);
            call.resolve(result);
        }).start();
    }

    /** A statement that returns rows: SELECT, PRAGMA, EXPLAIN, and a WITH that only selects. */
    private static boolean isQuery(String sql, int type) {
        if (type == DatabaseUtils.STATEMENT_SELECT || type == DatabaseUtils.STATEMENT_PRAGMA) return true;
        String head = sql.trim().toUpperCase(java.util.Locale.ROOT);
        if (head.startsWith("EXPLAIN")) return true;
        return head.startsWith("WITH") && !head.matches("(?s).*\\b(INSERT|UPDATE|DELETE|REPLACE)\\b.*");
    }

    private static JSObject run(SQLiteDatabase database, String sql, JSONArray params) throws JSONException {
        int type = DatabaseUtils.getSqlStatementType(sql);
        if (type == DatabaseUtils.STATEMENT_ATTACH) throw new IllegalArgumentException("ATTACH and DETACH are not allowed");
        JSObject result = new JSObject();
        if (isQuery(sql, type)) {
            // rawQuery binds strings only; SQLite's column affinity converts them where it compares with a column.
            String[] args = new String[params.length()];
            for (int i = 0; i < params.length(); i++) args[i] = params.isNull(i) ? null : String.valueOf(params.get(i));
            try (Cursor cursor = database.rawQuery(sql, args)) {
                JSArray columns = new JSArray();
                for (String name : cursor.getColumnNames()) columns.put(name);
                JSArray rows = new JSArray();
                while (cursor.moveToNext()) {
                    JSONArray row = new JSONArray();
                    for (int c = 0; c < cursor.getColumnCount(); c++) row.put(value(cursor, c));
                    rows.put(row);
                }
                result.put("columns", columns);
                result.put("rows", rows);
            }
            return result;
        }
        try (SQLiteStatement statement = database.compileStatement(sql)) {
            for (int i = 0; i < params.length(); i++) {
                Object param = params.get(i);
                int at = i + 1;
                if (param == JSONObject.NULL) statement.bindNull(at);
                else if (param instanceof Integer || param instanceof Long) statement.bindLong(at, ((Number) param).longValue());
                else if (param instanceof Number) statement.bindDouble(at, ((Number) param).doubleValue());
                else if (param instanceof Boolean) statement.bindLong(at, ((Boolean) param) ? 1 : 0);
                else statement.bindString(at, String.valueOf(param));
            }
            if (sql.trim().regionMatches(true, 0, "INSERT", 0, 6) || sql.trim().regionMatches(true, 0, "REPLACE", 0, 7)) {
                result.put("lastInsertId", statement.executeInsert());
                result.put("changes", 1);
            } else if (type == DatabaseUtils.STATEMENT_UPDATE) {
                result.put("changes", statement.executeUpdateDelete());
            } else {
                statement.execute();
                result.put("changes", 0);
            }
        }
        return result;
    }

    private static Object value(Cursor cursor, int column) {
        switch (cursor.getType(column)) {
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:
                return cursor.getLong(column);
            case Cursor.FIELD_TYPE_FLOAT:
                return cursor.getDouble(column);
            case Cursor.FIELD_TYPE_BLOB:
                return "<blob " + cursor.getBlob(column).length + " bytes>";
            default:
                return cursor.getString(column);
        }
    }

    /** Tables with their columns and row counts, for the prompt and settings. */
    @PluginMethod
    public void schema(PluginCall call) {
        new Thread(() -> {
            SQLiteDatabase database = db();
            JSArray tables = new JSArray();
            try (
                Cursor cursor = database.rawQuery(
                    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'android_metadata' ORDER BY name",
                    null
                )
            ) {
                while (cursor.moveToNext()) {
                    String name = cursor.getString(0);
                    JSObject table = new JSObject();
                    table.put("name", name);
                    table.put("sql", cursor.getString(1));
                    table.put("rows", DatabaseUtils.queryNumEntries(database, name));
                    tables.put(table);
                }
            } catch (RuntimeException e) {
                call.reject(e.getMessage());
                return;
            }
            JSObject result = new JSObject();
            result.put("tables", tables);
            call.resolve(result);
        }).start();
    }

    /** The share sheet with a copy of the database file, for a backup or a desktop SQLite tool. */
    @PluginMethod
    public void export(PluginCall call) {
        new Thread(() -> {
            try {
                SQLiteDatabase database = db();
                File dir = new File(getContext().getCacheDir(), "share");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (!f.delete()) f.deleteOnExit();
                File copy = new File(dir, NAME);
                // VACUUM INTO writes a consistent copy even while the database is open.
                database.execSQL("VACUUM INTO ?", new Object[] { copy.getAbsolutePath() });
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", copy);
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType("application/vnd.sqlite3")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(Intent.createChooser(send, "匯出資料庫"));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }
}
