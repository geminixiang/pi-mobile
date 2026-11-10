package dev.geminixiang.pimobile

import android.content.Intent
import android.database.Cursor
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

private const val NAME = "pi-data.db"

@CapacitorPlugin(name = "Database")
class DatabasePlugin : Plugin() {
    private var opened: SQLiteDatabase? = null

    @Synchronized
    private fun db(): SQLiteDatabase {
        opened?.takeIf { it.isOpen }?.let { return it }
        return SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(NAME), null).also {
            it.execSQL("PRAGMA foreign_keys = ON")
            opened = it
        }
    }

    @PluginMethod
    fun execute(call: PluginCall) {
        val statements = call.getArray("statements")
        Background.run(call) {
            val database = db()
            val results = JSArray()
            var index = 0
            database.beginTransaction()
            try {
                while (index < statements.length()) {
                    val statement = statements.getJSONObject(index)
                    results.put(run(database, statement.getString("sql"), statement.optJSONArray("params") ?: JSONArray()))
                    index++
                }
                database.setTransactionSuccessful()
            } catch (failed: Exception) {
                call.reject("statement ${index + 1}: ${failed.message}")
                return@run
            } finally {
                database.endTransaction()
            }
            call.resolve(JSObject().put("results", results))
        }
    }

    @PluginMethod
    fun schema(call: PluginCall) {
        Background.run(call) {
            val database = db()
            val tables = JSArray()
            try {
                database.rawQuery(
                    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'android_metadata' ORDER BY name",
                    null,
                ).use { cursor ->
                    while (cursor.moveToNext()) {
                        val name = cursor.getString(0)
                        tables.put(
                            JSObject()
                                .put("name", name)
                                .put("sql", cursor.getString(1).orEmpty())
                                .put("rows", DatabaseUtils.queryNumEntries(database, name)),
                        )
                    }
                }
            } catch (failed: RuntimeException) {
                call.reject(failed.message)
                return@run
            }
            call.resolve(JSObject().put("tables", tables))
        }
    }

    @PluginMethod
    fun export(call: PluginCall) {
        Background.run(call) {
            try {
                val database = db()
                val copy = File(AppsPlugin.emptyShareFolder(context), NAME)
                database.execSQL("VACUUM INTO ?", arrayOf<Any>(copy.absolutePath))
                val send =
                    Intent(Intent.ACTION_SEND)
                        .setType("application/vnd.sqlite3")
                        .putExtra(Intent.EXTRA_STREAM, AppsPlugin.shared(context, copy))
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                activity.startActivity(Intent.createChooser(send, "匯出資料庫"))
                call.resolve()
            } catch (failed: Exception) {
                call.reject(failed.message)
            }
        }
    }

    private companion object {
        fun run(database: SQLiteDatabase, sql: String, params: JSONArray): JSObject {
            if (DatabaseUtils.getSqlStatementType(sql) == DatabaseUtils.STATEMENT_ATTACH) throw IllegalArgumentException("ATTACH and DETACH are not allowed")
            val changesBefore = totalChanges(database)
            database.rawQueryWithFactory(boundTo(params), sql, null, "").use { cursor ->
                val rowCount = cursor.count
                if (cursor.columnCount > 0) {
                    val columns = JSArray()
                    cursor.columnNames.forEach { columns.put(it) }
                    val rows = JSArray()
                    for (r in 0 until rowCount) {
                        if (!cursor.moveToPosition(r)) break
                        val row = JSONArray()
                        for (c in 0 until cursor.columnCount) row.put(value(cursor, c))
                        rows.put(row)
                    }
                    return JSObject().put("columns", columns).put("rows", rows)
                }
            }
            val changes = totalChanges(database) - changesBefore
            val result = JSObject().put("changes", changes)
            if (changes > 0 && insertsRows(sql)) result.put("lastInsertId", DatabaseUtils.longForQuery(database, "SELECT last_insert_rowid()", null))
            return result
        }

        fun totalChanges(database: SQLiteDatabase) = DatabaseUtils.longForQuery(database, "SELECT total_changes()", null)

        fun insertsRows(sql: String): Boolean {
            val head = sql.trim()
            return head.startsWith("INSERT", ignoreCase = true) || head.startsWith("REPLACE", ignoreCase = true)
        }

        fun boundTo(params: JSONArray) =
            SQLiteDatabase.CursorFactory { _, driver, editTable, query ->
                for (i in 0 until params.length()) {
                    val at = i + 1
                    when (val param = params.opt(i)) {
                        null, JSONObject.NULL -> query.bindNull(at)
                        is Int -> query.bindLong(at, param.toLong())
                        is Long -> query.bindLong(at, param)
                        is Number -> query.bindDouble(at, param.toDouble())
                        is Boolean -> query.bindLong(at, if (param) 1L else 0L)
                        else -> query.bindString(at, param.toString())
                    }
                }
                SQLiteCursor(driver, editTable, query)
            }

        fun value(cursor: Cursor, column: Int): Any? =
            when (cursor.getType(column)) {
                Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
                Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(column)
                Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(column)
                Cursor.FIELD_TYPE_BLOB -> "<blob ${cursor.getBlob(column).size} bytes>"
                else -> cursor.getString(column)
            }
    }
}
