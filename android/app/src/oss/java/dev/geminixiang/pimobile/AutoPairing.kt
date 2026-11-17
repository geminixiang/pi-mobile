package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.net.InetAddresses
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import dev.geminixiang.agentscreen.AgentScreen
import dev.geminixiang.agentscreen.Outcome
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private const val WATCH_MINUTES = 5L
private const val LOOK_EVERY_MS = 200L
private const val CODE_LENGTH = 6

internal class AutoPairing(private val context: Context, private val screen: AgentScreen, private val reader: () -> AccessibilityService?) {
    private class Watch(val settings: String, val end: (Outcome) -> Unit, val discovery: AutoCloseable, val bound: ScheduledFuture<*>) {
        val advertised = mutableSetOf<Int>()
        var looking: ScheduledFuture<*>? = null
        var tried: Int? = null
        var missed = "left"
    }

    private val executor = Executors.newSingleThreadScheduledExecutor()
    private var watch: Watch? = null

    fun start(end: (Outcome) -> Unit) = executor.execute {
        finish(Outcome.Failed("restarted"))
        val settings = context.packageManager.resolveActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), 0)?.activityInfo?.packageName
            ?: return@execute end(Outcome.Failed("no_settings"))
        val discovery = screen.watchPairing(
            found = { port -> executor.execute { watch?.let { advertised(it, port) } } },
            failed = { executor.execute { finish(Outcome.Failed("discovery_failed")) } },
        )
        val bound = executor.schedule({ finish(Outcome.Failed("timeout")) }, WATCH_MINUTES, TimeUnit.MINUTES)
        watch = Watch(settings, end, discovery, bound)
    }

    fun stop() = executor.execute { watch?.let { finish(Outcome.Failed(it.missed)) } }

    fun close() {
        stop()
        executor.shutdown()
    }

    private fun advertised(current: Watch, port: Int) {
        current.advertised.add(port)
        if (current.looking == null) current.looking = executor.scheduleWithFixedDelay({ look(current) }, 0, LOOK_EVERY_MS, TimeUnit.MILLISECONDS)
    }

    private fun look(current: Watch) {
        if (watch !== current) return
        val service = reader() ?: return run { current.missed = "accessibility_off" }
        val dialog = pairingDialog(service, current.settings)?.takeIf { it.port in current.advertised }
            ?: return run { if (current.tried == null) current.missed = "code_not_found" }
        if (dialog.port == current.tried) return
        current.tried = dialog.port
        when (val paired = screen.pair(dialog.code, dialog.port)) {
            Outcome.Done -> finish(paired)
            is Outcome.Failed -> if (paired.reason == "wrong_code") finish(paired) else current.missed = paired.reason
        }
    }

    private fun finish(outcome: Outcome) {
        val ended = watch ?: return
        watch = null
        ended.looking?.cancel(false)
        ended.bound.cancel(false)
        ended.discovery.close()
        ended.end(outcome)
    }
}

private class PairingDialog(val code: String, val port: Int)

private fun pairingDialog(service: AccessibilityService, settings: String): PairingDialog? =
    service.windows.mapNotNull { it.root }.filter { it.packageName == settings }.firstNotNullOfOrNull { root ->
        val texts = textsIn(root)
        val code = texts.singleOrNull { it.length == CODE_LENGTH && it.all(Char::isDigit) }
        val port = texts.mapNotNull(::portOf).singleOrNull()
        if (code == null || port == null) null else PairingDialog(code.map(Char::digitToInt).joinToString(""), port)
    }

private fun textsIn(node: AccessibilityNodeInfo): List<String> =
    listOfNotNull(node.text?.toString()?.trim()) + (0 until node.childCount).mapNotNull(node::getChild).flatMap(::textsIn)

private fun portOf(text: String): Int? {
    val host = text.substringBeforeLast(':', "").removeSurrounding("[", "]")
    val port = text.substringAfterLast(':').toIntOrNull() ?: return null
    return if (port in 1..65535 && host.isNotEmpty() && InetAddresses.isNumericAddress(host)) port else null
}
