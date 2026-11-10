package dev.geminixiang.pimobile

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.graphics.Bitmap
import android.media.ExifInterface
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@CapacitorPlugin(
    name = "Photos",
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.ACCESS_MEDIA_LOCATION], alias = "photos"),
        Permission(strings = [Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED], alias = "selected"),
    ],
)
class PhotosPlugin : Plugin() {
    private fun allowed() = getPermissionState("photos") == PermissionState.GRANTED || getPermissionState("selected") == PermissionState.GRANTED

    @PluginMethod
    fun search(call: PluginCall) {
        val from = call.data.optLong("from", 0L)
        val to = call.data.optLong("to", Long.MAX_VALUE)
        val limit = call.getInt("limit") ?: 200
        val album = call.getString("album")
        val resolver = context.contentResolver
        val columns =
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT,
            )
        val taken = "COALESCE(${MediaStore.Images.Media.DATE_TAKEN}, ${MediaStore.Images.Media.DATE_ADDED} * 1000)"
        val where = "$taken >= $from AND $taken <= $to" + if (album != null) " AND ${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} LIKE ?" else ""
        val args = album?.let { arrayOf("%$it%") }
        val rows = mutableListOf<JSObject>()
        val ids = mutableListOf<Long>()
        resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, where, args, "$taken DESC")?.use { cursor ->
            while (cursor.moveToNext() && rows.size < limit) {
                val id = cursor.getLong(0)
                rows.add(
                    JSObject()
                        .put("id", id.toString())
                        .put("name", cursor.getString(1).orEmpty())
                        .put("time", if (cursor.isNull(2)) cursor.getLong(3) * 1000 else cursor.getLong(2))
                        .put("album", cursor.getString(4).orEmpty())
                        .put("width", cursor.getInt(5))
                        .put("height", cursor.getInt(6)),
                )
                ids.add(id)
            }
        }
        Background.run(call) {
            val places = places(resolver, ids)
            val items = JSArray()
            rows.forEachIndexed { i, row ->
                val place = places[ids[i]]
                if (place != null && place.size == 2) {
                    row.put("latitude", place[0])
                    row.put("longitude", place[1])
                }
                items.put(row)
            }
            call.resolve(JSObject().put("items", items))
        }
    }

    private fun places(resolver: ContentResolver, ids: List<Long>): Map<Long, DoubleArray> {
        val cache = PlacesCache.get(context)
        val known = cache.lookup(ids)
        val missing = ids.filterNot { it in known }
        if (missing.isEmpty()) return known
        val read = ConcurrentHashMap<Long, DoubleArray>()
        val pool = Executors.newFixedThreadPool(maxOf(2, Runtime.getRuntime().availableProcessors()))
        missing.forEach { id ->
            pool.execute {
                place(resolver, ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id))?.let { read[id] = it }
            }
        }
        pool.shutdown()
        try {
            pool.awaitTermination(2, TimeUnit.MINUTES)
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        cache.store(read)
        known.putAll(read)
        return known
    }

    @PluginMethod
    fun view(call: PluginCall) {
        if (!allowed()) {
            call.reject("no photos permission")
            return
        }
        val edge = call.getInt("edge") ?: 1280
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, call.getString("id", "0").orEmpty().toLong())
        try {
            val bitmap = context.contentResolver.loadThumbnail(uri, Size(edge, edge), null)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
            call.resolve(
                JSObject()
                    .put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                    .put("width", bitmap.width)
                    .put("height", bitmap.height),
            )
        } catch (error: IOException) {
            call.reject("could not read that photo", error)
        }
    }

    private companion object {
        fun place(resolver: ContentResolver, uri: Uri): DoubleArray? =
            try {
                resolver.openInputStream(MediaStore.setRequireOriginal(uri))?.use { input ->
                    val latLong = FloatArray(2)
                    if (!ExifInterface(input).getLatLong(latLong) || (latLong[0] == 0f && latLong[1] == 0f)) {
                        PlacesCache.NONE
                    } else {
                        doubleArrayOf(latLong[0].toDouble(), latLong[1].toDouble())
                    }
                }
            } catch (error: IOException) {
                null
            } catch (error: SecurityException) {
                null
            } catch (error: UnsupportedOperationException) {
                null
            }
    }
}
