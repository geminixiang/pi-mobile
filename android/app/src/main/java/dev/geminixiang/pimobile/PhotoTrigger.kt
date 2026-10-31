package dev.geminixiang.pimobile

import android.Manifest
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.provider.MediaStore
import android.util.Log
import java.util.Locale

private const val JOB = 4713
private const val PREFS = "pi-trigger-photos"
private const val KEY_SINCE = "since"
private const val LISTED = 5

object PhotoTrigger {
    private data class Photo(val id: Long, val album: String)

    internal fun arm(context: Context, wanted: Boolean) {
        val jobs = context.getSystemService(JobScheduler::class.java)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!wanted) {
            jobs.cancel(JOB)
            prefs.edit().remove(KEY_SINCE).apply()
            return
        }
        if (!prefs.contains(KEY_SINCE)) prefs.edit().putLong(KEY_SINCE, System.currentTimeMillis() / 1000).apply()
        if (jobs.getPendingJob(JOB) == null) schedule(context)
    }

    private fun schedule(context: Context) {
        val photos = JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS)
        val job = JobInfo.Builder(JOB, ComponentName(context, Job::class.java)).addTriggerContentUri(photos).setTriggerContentUpdateDelay(5_000).setTriggerContentMaxDelay(60_000).build()
        context.getSystemService(JobScheduler::class.java).schedule(job)
    }

    private fun check(context: Context) {
        if (context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TRIGGERS_TAG, "photo trigger: no photos permission")
            return
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(KEY_SINCE, System.currentTimeMillis() / 1000)
        val columns = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.BUCKET_DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED)
        val where = "${MediaStore.Images.Media.DATE_ADDED} > ? AND ${MediaStore.Images.Media.IS_PENDING} = 0"
        val photos = mutableListOf<Photo>()
        var newest = since
        context.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, where, arrayOf(since.toString()), "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { cursor ->
            while (cursor.moveToNext()) {
                photos.add(Photo(cursor.getLong(0), cursor.getString(1).orEmpty()))
                newest = maxOf(newest, cursor.getLong(2))
            }
        }
        prefs.edit().putLong(KEY_SINCE, newest).apply()
        if (photos.isEmpty()) return
        val listed = photos.take(LISTED).joinToString("、") { (if (it.album.isEmpty()) "" else it.album + " ") + "id " + it.id }
        val detail = "拍了 ${photos.size} 張新照片：$listed" + if (photos.size > LISTED) "…" else ""
        TriggerReceiver.event(context, "photo", detail) { schedule ->
            val wanted = schedule.trigger
            wanted is When.Photo && (wanted.album == null || photos.any { it.album.lowercase(Locale.ROOT).contains(wanted.album.lowercase(Locale.ROOT)) })
        }
    }

    class Job : JobService() {
        override fun onStartJob(params: JobParameters): Boolean {
            try {
                check(this)
            } finally {
                schedule(this)
            }
            return false
        }

        override fun onStopJob(params: JobParameters) = false
    }
}
