package dev.geminixiang.pimobile

import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONException

private const val PROFILE = "web-pages"
private const val WIDTH = 1080
private const val HEIGHT = 2400
private const val POLL_MS = 500L
private const val TOTAL_MS = 30_000L
private const val SETTLED_MS = 2_000L
private const val CHECK_MS = 15_000L
private const val ANSWER_MS = 3_000L
private const val TEXT_LENGTH = "document.body ? document.body.innerText.length : 0"
private const val READ = "(function(){return JSON.stringify([document.documentElement.outerHTML, document.title, location.href]);})()"

@CapacitorPlugin(name = "Page")
class PagePlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())

    @PluginMethod
    fun check(call: PluginCall) = start(call) { url -> Check(call, url).start() }

    @PluginMethod
    fun render(call: PluginCall) = start(call) { url -> Render(call, url).start() }

    private fun start(call: PluginCall, begin: (String) -> Unit) {
        val url = call.getString("url", "").orEmpty()
        if (!WebPages.isWeb(Uri.parse(url))) return call.reject("url must be http or https")
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return call.reject("this phone's WebView cannot keep pages apart from pi; update Android System WebView")
        main.post { begin(url) }
    }

    private inner class Check(private val call: PluginCall, private val url: String) {
        private val view = WebPages.create(context, PROFILE)
        private var done = false

        fun start() {
            view.webViewClient = object : WebPages.WebOnly() {
                override fun blocked(reason: String) = finish(JSObject().put("blocked", reason))

                override fun gone() = finish(JSObject())

                override fun onPageCommitVisible(webView: WebView, pageUrl: String?) = finish(JSObject())

                override fun onPageFinished(webView: WebView, pageUrl: String?) = finish(JSObject())
            }
            view.loadUrl(url)
            main.postDelayed(::deadline, CHECK_MS)
        }

        private fun deadline() {
            if (done) return
            var answered = false
            view.evaluateJavascript("1") { answered = true }
            main.postDelayed({
                if (!answered && !done) view.webViewRenderProcess?.terminate()
                finish(JSObject())
            }, ANSWER_MS)
        }

        private fun finish(out: JSObject) {
            if (done) return
            done = true
            view.stopLoading()
            view.destroy()
            call.resolve(out)
        }
    }

    private inner class Render(private val call: PluginCall, private val url: String) {
        private val started = System.currentTimeMillis()
        private val view = WebPages.create(context, PROFILE)
        private var loaded = false
        private var done = false
        private var lastLength = -1
        private var sameSince = 0L
        private var error: String? = null

        fun start() {
            view.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, WIDTH, HEIGHT)
            view.webViewClient = object : WebPages.WebOnly() {
                override fun blocked(reason: String) {
                    error = "pi blocked $reason"
                }

                override fun gone() {
                    if (!done) fail("the page stopped responding")
                }

                override fun onPageStarted(webView: WebView, pageUrl: String?, favicon: Bitmap?) {
                    loaded = false
                    error = null
                }

                override fun onPageFinished(webView: WebView, pageUrl: String?) {
                    loaded = true
                }

                override fun onReceivedError(webView: WebView, request: WebResourceRequest, failure: WebResourceError) {
                    if (request.isForMainFrame) error = failure.description.toString()
                }
            }
            view.loadUrl(url)
            main.postDelayed(::poll, POLL_MS)
            main.postDelayed(::stuck, TOTAL_MS + ANSWER_MS)
        }

        private fun stuck() {
            if (done) return
            // why: destroying a WebView does not stop a script spinning in its renderer
            view.webViewRenderProcess?.terminate()
            fail("the page stopped responding")
        }

        private fun poll() {
            if (done) return
            val late = System.currentTimeMillis() - started >= TOTAL_MS
            if (error != null && (loaded || late)) return fail("could not load the page: $error")
            if (!loaded && !late) {
                main.postDelayed(::poll, POLL_MS)
                return
            }
            view.evaluateJavascript(TEXT_LENGTH) { length -> settle(length.toIntOrNull() ?: 0, late) }
        }

        private fun settle(length: Int, late: Boolean) {
            if (done) return
            val time = System.currentTimeMillis()
            if (length != lastLength) {
                lastLength = length
                sameSince = time
            }
            if (late || (length > 0 && time - sameSince >= SETTLED_MS)) view.evaluateJavascript(READ) { json -> read(json, late) }
            else main.postDelayed(::poll, POLL_MS)
        }

        private fun read(json: String, late: Boolean) {
            if (done) return
            try {
                val values = JSONArray(JSONArray("[$json]").getString(0))
                close()
                call.resolve(JSObject().put("html", values.getString(0)).put("title", values.getString(1)).put("url", values.getString(2)).put("ms", System.currentTimeMillis() - started).put("settled", !late))
            } catch (_: JSONException) {
                if (late) fail("could not read the page") else main.postDelayed(::poll, POLL_MS)
            }
        }

        private fun fail(message: String) {
            close()
            call.reject(message)
        }

        private fun close() {
            done = true
            view.stopLoading()
            view.destroy()
        }
    }
}
