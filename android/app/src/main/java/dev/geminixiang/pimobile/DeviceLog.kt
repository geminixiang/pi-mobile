package dev.geminixiang.pimobile

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors
import org.json.JSONObject

private const val LIMIT_BYTES = 1_000_000L
private const val KEEP_BYTES = 500_000

internal object DeviceLog {
    private val writer = Executors.newSingleThreadExecutor()

    private fun file(context: Context) = File(context.filesDir, "device.log")

    fun append(context: Context, lines: List<String>) {
        val target = file(context)
        writer.execute {
            target.appendText(lines.joinToString(separator = "\n", postfix = "\n"))
            if (target.length() > LIMIT_BYTES) trim(target)
        }
    }

    fun event(context: Context, level: String, event: String, message: String) {
        append(context, listOf(JSONObject().put("at", Instant.now().toString()).put("level", level).put("event", event).put("message", message).toString()))
    }

    fun read(context: Context, call: PluginCall) {
        val target = file(context)
        writer.reply(call) { Outcome.Ok(JSObject().put("text", if (target.exists()) target.readText() else "")) }
    }

    private fun trim(target: File) {
        val kept = target.readBytes().let { it.copyOfRange(it.size - KEEP_BYTES, it.size) }
        val firstWhole = kept.indexOf('\n'.code.toByte()) + 1
        target.writeBytes(kept.copyOfRange(firstWhole, kept.size))
    }
}
