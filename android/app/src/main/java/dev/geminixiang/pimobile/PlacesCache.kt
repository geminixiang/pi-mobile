package dev.geminixiang.pimobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

internal class PlacesCache private constructor(context: Context) : SQLiteOpenHelper(context, "photo-places.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE places (id INTEGER PRIMARY KEY, lat REAL, lon REAL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun lookup(ids: List<Long>): MutableMap<Long, DoubleArray> {
        val known = HashMap<Long, DoubleArray>()
        val db = readableDatabase
        ids.chunked(500).forEach { chunk ->
            db.rawQuery("SELECT id, lat, lon FROM places WHERE id IN (${chunk.joinToString(",")})", null).use { cursor ->
                while (cursor.moveToNext()) known[cursor.getLong(0)] = if (cursor.isNull(1)) NONE else doubleArrayOf(cursor.getDouble(1), cursor.getDouble(2))
            }
        }
        return known
    }

    fun store(places: Map<Long, DoubleArray>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            places.forEach { (id, place) ->
                val values = ContentValues()
                values.put("id", id)
                if (place.size == 2) {
                    values.put("lat", place[0])
                    values.put("lon", place[1])
                }
                db.insertWithOnConflict("places", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    companion object {
        val NONE = DoubleArray(0)
        private var instance: PlacesCache? = null

        @Synchronized
        fun get(context: Context): PlacesCache = instance ?: PlacesCache(context.applicationContext).also { instance = it }
    }
}
