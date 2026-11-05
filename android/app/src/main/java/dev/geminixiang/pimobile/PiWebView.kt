package dev.geminixiang.pimobile

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.webkit.WebView
import com.getcapacitor.CapacitorWebView

class PiWebView(context: Context, attrs: AttributeSet?) : CapacitorWebView(context, attrs) {
    private val watchdog = RendererWatchdog(this)
    var keepRunning = false
        private set
    private var windowVisibility = View.VISIBLE

    val running: Boolean
        get() = keepRunning || windowVisibility == View.VISIBLE

    override fun onWindowVisibilityChanged(visibility: Int) {
        windowVisibility = visibility
        applyVisibility()
    }

    override fun onDetachedFromWindow() {
        watchdog.stop()
        super.onDetachedFromWindow()
    }

    private fun applyVisibility() {
        super.onWindowVisibilityChanged(if (keepRunning) View.VISIBLE else windowVisibility)
        if (running) watchdog.start() else watchdog.stop()
    }

    companion object {
        @JvmStatic
        fun keepRunning(view: WebView, on: Boolean) {
            if (view !is PiWebView || view.keepRunning == on) return
            view.keepRunning = on
            view.applyVisibility()
        }
    }
}
