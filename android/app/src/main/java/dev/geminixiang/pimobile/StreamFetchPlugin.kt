package dev.geminixiang.pimobile

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

private const val READ_MS = 120_000
private const val CHUNK_BYTES = 16 * 1024

@CapacitorPlugin(name = "StreamFetch")
class StreamFetchPlugin : Plugin() {
    private val open = ConcurrentHashMap<String, HttpURLConnection>()
    private val aborted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val next = AtomicInteger()

    @PluginMethod
    fun start(call: PluginCall) {
        val id = "f${next.incrementAndGet()}"
        val url = call.getString("url").orEmpty()
        val method = call.getString("method", "GET").orEmpty()
        val given = call.getObject("headers", JSObject()) ?: JSObject()
        val headers = given.keys().asSequence().associateWith { given.getString(it).orEmpty() }
        val base64 = call.getString("bodyBase64")
        val body = base64?.let { Base64.decode(it, Base64.NO_WRAP) } ?: call.getString("body")?.toByteArray(Charsets.UTF_8)
        call.resolve(JSObject().put("id", id))
        Thread { run(id, url, method, headers, body) }.start()
    }

    @PluginMethod
    fun abort(call: PluginCall) {
        val id = call.getString("id", "").orEmpty()
        aborted.add(id)
        open.remove(id)?.disconnect()
        call.resolve()
    }

    private fun run(id: String, url: String, method: String, headers: Map<String, String>, body: ByteArray?) {
        var connection: HttpURLConnection? = null
        try {
            val opened = Http.open(URL(url), READ_MS, method, headers)
            connection = opened
            open[id] = opened
            if (id in aborted) return
            if (body != null) {
                opened.doOutput = true
                opened.outputStream.use { it.write(body) }
            }
            val status = opened.responseCode
            if (id in aborted) return
            val responseHeaders = JSObject()
            opened.headerFields.forEach { (key, values) -> if (key != null) responseHeaders.put(key.lowercase(Locale.ROOT), values.joinToString(", ")) }
            notifyListeners("head", JSObject().put("id", id).put("status", status).put("headers", responseHeaders))
            val input = if (status >= 400) opened.errorStream else opened.inputStream
            input?.use { stream ->
                val buffer = ByteArray(CHUNK_BYTES)
                while (id !in aborted) {
                    val read = stream.read(buffer)
                    if (read == -1) break
                    notifyListeners("chunk", JSObject().put("id", id).put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)))
                }
            }
            if (id in aborted) return
            notifyListeners("end", JSObject().put("id", id))
        } catch (failure: Exception) {
            if (id in aborted) return
            notifyListeners("error", JSObject().put("id", id).put("message", failure.message ?: failure.javaClass.simpleName))
        } finally {
            open.remove(id)
            aborted.remove(id)
            connection?.disconnect()
        }
    }
}
