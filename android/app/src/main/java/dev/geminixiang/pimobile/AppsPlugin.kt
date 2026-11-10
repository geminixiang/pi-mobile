package dev.geminixiang.pimobile

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.AlarmClock
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import org.json.JSONException

@CapacitorPlugin(name = "Apps")
class AppsPlugin : Plugin() {
    private fun launch(call: PluginCall, intent: Intent) {
        if (!PhoneScreenService.canStartActivities(activity)) {
            call.reject("pi is in the background, and the phone does not let it open other apps from there. Ask the user to open pi and try again.", "BACKGROUND")
            return
        }
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (missing: ActivityNotFoundException) {
            call.reject("no app on this phone handles this", "NO_APP")
        } catch (blocked: SecurityException) {
            call.reject("the system blocked this: ${blocked.message}", "BLOCKED")
        }
    }

    @PluginMethod
    fun setAlarm(call: PluginCall) {
        val intent =
            Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, call.getInt("hour") ?: 0)
                .putExtra(AlarmClock.EXTRA_MINUTES, call.getInt("minute") ?: 0)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        call.getString("label")?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        val days = call.getArray("days")
        if (days != null && days.length() > 0) {
            val list =
                try {
                    ArrayList((0 until days.length()).map { days.getInt(it) })
                } catch (notNumbers: JSONException) {
                    call.reject("days must be numbers")
                    return
                }
            intent.putExtra(AlarmClock.EXTRA_DAYS, list)
        }
        launch(call, intent)
    }

    @PluginMethod
    fun openAlarms(call: PluginCall) = launch(call, Intent(AlarmClock.ACTION_SHOW_ALARMS))

    @PluginMethod
    fun setTimer(call: PluginCall) {
        val intent =
            Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, call.getInt("seconds") ?: 60)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        call.getString("label")?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        launch(call, intent)
    }

    @PluginMethod
    fun composeEmail(call: PluginCall) {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"))
        val addresses =
            try {
                val to = call.getArray("to") ?: JSArray()
                Array(to.length()) { to.getString(it) }
            } catch (notStrings: JSONException) {
                call.reject("to must be strings")
                return
            }
        intent.putExtra(Intent.EXTRA_EMAIL, addresses)
        call.getString("subject")?.let { intent.putExtra(Intent.EXTRA_SUBJECT, it) }
        intent.putExtra(Intent.EXTRA_TEXT, call.getString("body", ""))
        launch(call, intent)
    }

    @PluginMethod
    fun composeSms(call: PluginCall) {
        val intent =
            Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(call.getString("to", ""))))
                .putExtra("sms_body", call.getString("body", ""))
        launch(call, intent)
    }

    @PluginMethod
    fun open(call: PluginCall) = launch(call, Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("uri", ""))).addCategory(Intent.CATEGORY_BROWSABLE))

    private fun stage(call: PluginCall, base64: String): Uri {
        val file = File(emptyShareFolder(context), File(call.getString("fileName", "file")).name)
        file.outputStream().use { it.write(Base64.decode(base64, Base64.DEFAULT)) }
        return shared(context, file)
    }

    @PluginMethod
    fun openFile(call: PluginCall) {
        val uri =
            try {
                stage(call, call.getString("fileBase64", "").orEmpty())
            } catch (failed: IOException) {
                call.reject("could not stage the file: ${failed.message}")
                return
            }
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, call.getString("mimeType", "application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        launch(call, view)
    }

    @PluginMethod
    fun share(call: PluginCall) {
        val send = Intent(Intent.ACTION_SEND)
        call.getString("text")?.let { send.putExtra(Intent.EXTRA_TEXT, it) }
        val data = call.getString("fileBase64")
        if (data != null) {
            val uri =
                try {
                    stage(call, data)
                } catch (failed: IOException) {
                    call.reject("could not stage the file: ${failed.message}")
                    return
                }
            send.putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.setType(call.getString("mimeType", "application/octet-stream"))
        } else {
            send.setType("text/plain")
        }
        val title = call.getString("title")
        if (title != null) send.putExtra(Intent.EXTRA_TITLE, title)
        launch(call, Intent.createChooser(send, title))
    }

    companion object {
        internal fun emptyShareFolder(context: Context): File {
            val dir = File(context.cacheDir, "share")
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create $dir")
            dir.listFiles()?.forEach { if (!it.delete()) it.deleteOnExit() }
            return dir
        }

        internal fun shared(context: Context, file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }
}
