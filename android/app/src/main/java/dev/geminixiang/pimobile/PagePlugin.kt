package dev.geminixiang.pimobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

private const val IDLE_MS = 60_000L

@CapacitorPlugin(name = "Page")
class PagePlugin : Plugin() {
    private class Request(val kind: Int, val call: PluginCall)

    private val main = Handler(Looper.getMainLooper())
    private val requests = HashMap<Int, Request>()
    private val replies = Messenger(
        Handler(Looper.getMainLooper()) { message ->
            requests.remove(message.arg1)?.let { answer(it, message) }
            if (requests.isEmpty()) main.postDelayed(release, IDLE_MS)
            true
        },
    )
    private val release = Runnable(::unbind)
    private var nextId = 0
    private var bound = false
    private var worker: Messenger? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            worker = Messenger(service)
            requests.forEach(::post)
        }

        override fun onServiceDisconnected(name: ComponentName) = workerGone()

        override fun onBindingDied(name: ComponentName) = workerGone()
    }

    @PluginMethod
    fun check(call: PluginCall) = send(PageWorker.CHECK, call)

    @PluginMethod
    fun render(call: PluginCall) = send(PageWorker.RENDER, call)

    override fun handleOnDestroy() {
        main.removeCallbacks(release)
        unbind()
    }

    private fun send(kind: Int, call: PluginCall) {
        main.post {
            main.removeCallbacks(release)
            val id = nextId++
            val request = Request(kind, call)
            requests[id] = request
            post(id, request)
            if (!bound) bound = context.bindService(Intent(context, PageWorker::class.java), connection, Context.BIND_AUTO_CREATE)
            if (!bound) workerGone()
        }
    }

    private fun post(id: Int, request: Request) {
        worker?.send(Message.obtain().also {
            it.what = request.kind
            it.arg1 = id
            it.replyTo = replies
            it.data.putString(PageWorker.URL, request.call.getString("url", ""))
        })
    }

    private fun answer(request: Request, message: Message) {
        val data = message.data
        val error = data.getString(PageWorker.ERROR)
        if (error != null) return request.call.reject(error)
        if (request.kind == PageWorker.CHECK) {
            val out = JSObject()
            data.getString(PageWorker.BLOCKED)?.let { out.put("blocked", it) }
            return request.call.resolve(out)
        }
        val file = File(data.getString(PageWorker.FILE).orEmpty())
        Background.run(request.call) {
            val out = JSObject()
            out.put("html", file.readText())
            out.put("title", data.getString(PageWorker.TITLE))
            out.put("url", data.getString(PageWorker.URL))
            out.put("ms", data.getLong(PageWorker.MS))
            out.put("settled", data.getBoolean(PageWorker.SETTLED))
            file.delete()
            request.call.resolve(out)
        }
    }

    private fun workerGone() {
        DeviceLog.event(context, "warn", "page.worker_gone", "${requests.size} pages were waiting")
        requests.values.forEach {
            if (it.kind == PageWorker.CHECK) it.call.resolve(JSObject()) else it.call.reject("the page stopped responding")
        }
        requests.clear()
        unbind()
    }

    private fun unbind() {
        worker = null
        if (!bound) return
        bound = false
        context.unbindService(connection)
    }
}
