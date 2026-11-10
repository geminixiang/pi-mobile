package dev.geminixiang.pimobile

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket

@CapacitorPlugin(name = "Loopback")
class LoopbackPlugin : Plugin() {
    private var server: ServerSocket? = null

    @PluginMethod
    fun start(call: PluginCall) {
        val port = call.getInt("port", 0) ?: 0
        val path = call.getString("path", "/") ?: "/"
        stopServer()
        val socket =
            try {
                ServerSocket(port, 1, InetAddress.getByName("127.0.0.1")).apply { soTimeout = WAIT_MS }
            } catch (error: IOException) {
                call.reject("cannot listen on 127.0.0.1:$port: ${error.message}")
                return
            }
        synchronized(this) { server = socket }
        call.resolve(JSObject().put("port", socket.localPort))
        Thread { serve(socket, path) }.start()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopServer()
        call.resolve()
    }

    private fun serve(socket: ServerSocket, path: String) {
        try {
            while (!socket.isClosed) {
                val redirected =
                    socket.accept().use { client ->
                        client.soTimeout = 10_000
                        val line = client.getInputStream().bufferedReader(Charsets.UTF_8).readLine()
                        val parts = line?.split(" ").orEmpty()
                        val ours = parts.size >= 2 && parts[0] == "GET" && parts[1].startsWith(path)
                        reply(client.getOutputStream(), ours)
                        if (ours) notifyListeners("redirect", JSObject().put("url", "http://127.0.0.1:${socket.localPort}${parts[1]}"))
                        ours
                    }
                if (redirected) break
            }
        } catch (ended: IOException) {
        } finally {
            closeQuietly(socket)
        }
    }

    @Synchronized
    private fun stopServer() {
        server?.let { closeQuietly(it) }
        server = null
    }

    companion object {
        private const val WAIT_MS = 10 * 60_000
        private const val BACK = "dev.geminixiang.pimobile:/back"

        private fun reply(out: OutputStream, ours: Boolean) {
            val body =
                if (ours) {
                    "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>pi mobile</title>" +
                        "<body style=\"font-family:system-ui;background:#161d27;color:#ebe7e4;padding:40px 24px\"><h2>登入完成</h2>" +
                        "<p><a href=\"" + BACK + "\" style=\"color:#8fb3d9\">回到 pi mobile</a>，這個分頁可以關掉。</p>" +
                        "<script>location.href = \"" + BACK + "\";</script>"
                } else {
                    ""
                }
            val bytes = body.toByteArray(Charsets.UTF_8)
            val head =
                (if (ours) "HTTP/1.1 200 OK" else "HTTP/1.1 404 Not Found") +
                    "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.US_ASCII))
            out.write(bytes)
            out.flush()
        }

        private fun closeQuietly(socket: ServerSocket) {
            try {
                socket.close()
            } catch (error: IOException) {
                Log.w("pi.loopback", "could not close the redirect server", error)
            }
        }
    }
}
