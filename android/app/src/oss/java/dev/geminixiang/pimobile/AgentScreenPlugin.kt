package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.geminixiang.agentscreen.AgentScreen
import dev.geminixiang.agentscreen.Opened
import dev.geminixiang.agentscreen.Outcome
import java.util.concurrent.Executors

private val KEYCODES = mapOf("back" to "KEYCODE_BACK", "home" to "KEYCODE_HOME", "recents" to "KEYCODE_APP_SWITCH")

@CapacitorPlugin(name = "AgentScreen")
class AgentScreenPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val screen by lazy { AgentScreen(context) }
    private var preview: AgentPreview? = null

    override fun load() {
        screen.onFailure = { reason ->
            Log.w("AgentPreview", reason)
            worker.execute { screen.unwatch() }
            main.post { preview?.failed() }
        }
        DisplayShells.install(object : DisplayShell {
            override fun key(display: Int, key: String) = KEYCODES[key]?.let { screen.key(display, it) } ?: false
            override fun reason(display: Int) = screen.reason(display)
            override fun before(display: Int, action: String): String? {
                screen.reason(display)?.let { return it }
                if (display == screen.display) main.post { preview?.step(action) }
                return null
            }
            override fun attach(service: AccessibilityService?) {
                main.post {
                    preview?.hide()
                    preview = service?.let {
                        AgentPreview(it, screen.aspect,
                            watch = { surface -> worker.execute {
                                val result = screen.watch(surface)
                                if (result is Outcome.Failed) screen.onFailure(result.reason)
                            } },
                            unwatch = { release -> worker.execute {
                                val result = screen.unwatch()
                                if (result is Outcome.Failed) Log.w("AgentPreview", result.reason)
                                release()
                            } },
                            takeover = { worker.execute {
                                val result = synchronized(DisplayShells) { screen.takeover() }
                                main.post {
                                    if (result == Outcome.Done) preview?.hide() else {
                                        Log.w("AgentPreview", "takeover: $result")
                                        preview?.takeoverFailed()
                                    }
                                }
                            } },
                        )
                    }
                    if (screen.display != null) preview?.show()
                }
            }
        })
    }

    override fun handleOnDestroy() {
        DisplayShells.install(null)
        main.post {
            screen.onFailure = { reason -> Log.w("AgentPreview", reason) }
            worker.execute { screen.close() }
            worker.shutdown()
        }
    }

    @PluginMethod
    fun pair(call: PluginCall) = work(call) { reply(screen.pair(call.getString("code").orEmpty())) }

    @PluginMethod
    fun open(call: PluginCall) = work(call) {
        val metrics = context.resources.displayMetrics
        val previous = screen.display
        when (val opened = screen.open(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)) {
            is Opened.Ready -> {
                if (previous != opened.display) main.post { preview?.show() }
                JSObject().put("ok", true).put("display", opened.display)
            }
            is Opened.Failed -> JSObject().put("ok", false).put("reason", opened.reason)
        }
    }

    @PluginMethod
    fun close(call: PluginCall) = work(call) {
        main.post { preview?.hide() }
        screen.close()
        JSObject()
    }

    private fun work(call: PluginCall, task: () -> JSObject) {
        worker.execute {
            call.resolve(runCatching(task).getOrElse { reply(Outcome.Failed(it.message ?: "screen_failed")) })
        }
    }

    private fun reply(outcome: Outcome): JSObject = when (outcome) {
        Outcome.Done -> JSObject().put("ok", true)
        is Outcome.Failed -> JSObject().put("ok", false).put("reason", outcome.reason)
    }
}
