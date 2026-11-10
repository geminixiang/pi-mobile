package dev.geminixiang.pimobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class NotificationStore private constructor(context: Context) : SQLiteOpenHelper(context, "notifications.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, app TEXT NOT NULL, " +
                "conversation TEXT, sender TEXT, title TEXT, text TEXT, time INTEGER NOT NULL, dedup TEXT NOT NULL UNIQUE)",
        )
        db.execSQL("CREATE INDEX notifications_time ON notifications (time)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    class Row(
        val packageName: String,
        val app: String,
        val conversation: String?,
        val sender: String?,
        val title: String,
        val text: String,
        val time: Long,
        val dedup: String = "",
    )

    @Synchronized
    internal fun add(rows: List<Row>): List<Row> {
        if (rows.isEmpty()) return emptyList()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val added =
                rows.filter { row ->
                    val values =
                        ContentValues().apply {
                            put("package", row.packageName)
                            put("app", row.app)
                            put("conversation", row.conversation)
                            put("sender", row.sender)
                            put("title", row.title)
                            put("text", row.text)
                            put("time", row.time)
                            put("dedup", row.dedup)
                        }
                    db.insertWithOnConflict("notifications", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1L
                }
            db.delete("notifications", "time < ?", arrayOf((System.currentTimeMillis() - KEEP_MS).toString()))
            db.setTransactionSuccessful()
            return added
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    internal fun list(since: Long, app: String?, query: String?, limit: Int): List<Row> {
        val args = mutableListOf(since.toString())
        val where = StringBuilder("time >= ?")
        if (!app.isNullOrEmpty()) {
            where.append(" AND (app LIKE ? OR package LIKE ?)")
            args.add("%$app%")
            args.add("%$app%")
        }
        if (!query.isNullOrEmpty()) {
            where.append(" AND (title LIKE ? OR text LIKE ? OR sender LIKE ? OR conversation LIKE ?)")
            repeat(4) { args.add("%$query%") }
        }
        return readableDatabase
            .query(
                "notifications",
                arrayOf("package", "app", "conversation", "sender", "title", "text", "time"),
                where.toString(),
                args.toTypedArray(),
                null,
                null,
                "time DESC",
                if (limit > 0) limit.toString() else null,
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        add(
                            Row(
                                packageName = cursor.getString(0),
                                app = cursor.getString(1),
                                conversation = cursor.getString(2),
                                sender = cursor.getString(3),
                                title = cursor.getString(4).orEmpty(),
                                text = cursor.getString(5).orEmpty(),
                                time = cursor.getLong(6),
                            ),
                        )
                    }
                }
            }
    }

    @Synchronized
    internal fun clear() {
        writableDatabase.delete("notifications", null, null)
    }

    companion object {
        internal const val KEEP_MS = 30L * 24 * 3600_000

        private var instance: NotificationStore? = null

        @Synchronized
        internal fun get(context: Context): NotificationStore = instance ?: NotificationStore(context.applicationContext).also { instance = it }
    }
}
