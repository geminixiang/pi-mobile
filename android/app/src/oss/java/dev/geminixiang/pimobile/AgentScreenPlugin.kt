package dev.geminixiang.pimobile

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.geminixiang.agentscreen.AgentScreen
import dev.geminixiang.agentscreen.Opened
import dev.geminixiang.agentscreen.Outcome
import java.util.concurrent.Executors

@CapacitorPlugin(name = "AgentScreen")
class AgentScreenPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private val screen by lazy { AgentScreen(context) }

    @PluginMethod
    fun pair(call: PluginCall) = work(call) { reply(screen.pair(call.getString("code").orEmpty())) }

    @PluginMethod
    fun open(call: PluginCall) = work(call) {
        val metrics = context.resources.displayMetrics
        when (val opened = screen.open(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)) {
            is Opened.Ready -> JSObject().put("ok", true).put("display", opened.display)
            is Opened.Failed -> JSObject().put("ok", false).put("reason", opened.reason)
        }
    }

    @PluginMethod
    fun launch(call: PluginCall) = work(call) { reply(screen.launch(call.getString("package").orEmpty())) }

    @PluginMethod
    fun shot(call: PluginCall) = work(call) { JSObject().put("jpeg", screen.shot().orEmpty()) }

    @PluginMethod
    fun close(call: PluginCall) = work(call) {
        screen.close()
        JSObject()
    }

    private fun work(call: PluginCall, task: () -> JSObject) {
        worker.execute { call.resolve(task()) }
    }

    private fun reply(outcome: Outcome): JSObject = when (outcome) {
        Outcome.Done -> JSObject().put("ok", true)
        is Outcome.Failed -> JSObject().put("ok", false).put("reason", outcome.reason)
    }
}
