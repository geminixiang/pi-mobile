package dev.geminixiang.pimobile

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView

private const val TAG = "PiWatchdog"
private const val TICK_MS = 10_000L
private const val SILENCE_MS = 30_000L

internal class RendererWatchdog(private val view: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val tick = Runnable { tick() }
    private var running = false
    private var lastTick = 0L
    private var lastAnswer = 0L

    fun start() {
        if (running) return
        running = true
        lastTick = SystemClock.uptimeMillis()
        lastAnswer = lastTick
        main.postDelayed(tick, TICK_MS)
    }

    fun stop() {
        running = false
        main.removeCallbacks(tick)
    }

    private fun tick() {
        val now = SystemClock.uptimeMillis()
        // why: a late tick means this process was frozen or asleep too, so the silence says nothing about the renderer
        if (now - lastTick > 2 * TICK_MS) lastAnswer = now
        lastTick = now
        if (now - lastAnswer >= SILENCE_MS) return restart()
        view.evaluateJavascript("1") { lastAnswer = SystemClock.uptimeMillis() }
        main.postDelayed(tick, TICK_MS)
    }

    private fun restart() {
        running = false
        Log.w(TAG, "the page did not answer for ${SILENCE_MS / 1000} s: restarting its renderer")
        view.webViewRenderProcess?.terminate()
    }
}
