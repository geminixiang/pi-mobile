package dev.geminixiang.pimobile

import android.content.Intent
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import java.io.File

class MainActivity : BridgeActivity() {
    private var restoring = false

    override fun onCreate(savedInstanceState: Bundle?) {
        restoring = savedInstanceState != null
        registerPlugin(KeepAlivePlugin::class.java)
        registerPlugin(VoicePlugin::class.java)
        registerPlugin(SystemPlugin::class.java)
        registerPlugin(AppsPlugin::class.java)
        registerPlugin(CalendarPlugin::class.java)
        registerPlugin(PhonePlugin::class.java)
        registerPlugin(TriggersPlugin::class.java)
        registerPlugin(NotificationsPlugin::class.java)
        registerPlugin(DatabasePlugin::class.java)
        registerPlugin(LoopbackPlugin::class.java)
        registerPlugin(StreamFetchPlugin::class.java)
        registerPlugin(ContactsPlugin::class.java)
        registerPlugin(PhotosPlugin::class.java)
        registerPlugin(RecordsPlugin::class.java)
        registerPlugin(UsagePlugin::class.java)
        registerPlugin(ScannerPlugin::class.java)
        registerPlugin(HealthPlugin::class.java)
        registerPlugin(BotFilesPlugin::class.java)
        registerPlugin(PagePlugin::class.java)
        registerPlugin(BrowserPlugin::class.java)
        registerPlugin(PhoneScreenPlugin::class.java)
        registerPlugin(PhoneStatePlugin::class.java)
        super.onCreate(savedInstanceState)
        bridge.addWebViewListener(
            object : WebViewListener() {
                override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail): Boolean = reloadAfterRenderer(webView, detail)
            },
        )
        restoring = false
        if (savedInstanceState?.getBoolean(KEPT_RUNNING) == true) KeepAlivePlugin.keepWebViewRunning(bridge.webView, true)
        removeSshKey()
        removeOldCaptures()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        goQuietIfAsked(intent)
    }

    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state)
        state.putBoolean(KEPT_RUNNING, (bridge.webView as? PiWebView)?.keepRunning == true)
    }

    private fun goQuietIfAsked(intent: Intent) {
        if (restoring || !intent.getBooleanExtra(EXTRA_QUIET, false)) return
        KeepAlivePlugin.keepWebViewRunning(bridge.webView, true)
        moveTaskToBack(true)
    }

    private fun reloadAfterRenderer(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (view !is PiWebView || !view.running) return false
        Log.w("PiWatchdog", "the page's renderer is gone: loading the app again")
        DeviceLog.event(this, "error", "renderer.gone", if (detail.didCrash()) "it crashed" else "the system or the watchdog ended it")
        recreate()
        return true
    }

    private fun removeOldCaptures() {
        val files = getExternalFilesDir(Environment.DIRECTORY_PICTURES)?.listFiles() ?: return
        val cutoff = System.currentTimeMillis() - CAPTURE_KEPT_MS
        files.filter { it.name.startsWith("JPEG_") && it.lastModified() < cutoff }.forEach { it.delete() }
    }

    private fun removeSshKey() {
        val dir = File(filesDir, "ssh")
        val files = dir.listFiles() ?: return
        files.forEach { it.delete() }
        dir.delete()
    }

    companion object {
        internal const val EXTRA_QUIET = "dev.geminixiang.pimobile.QUIET"
        private const val KEPT_RUNNING = "keptRunning"
        private const val CAPTURE_KEPT_MS = 24 * 60 * 60 * 1000L
    }
}
