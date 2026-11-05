package dev.geminixiang.pimobile

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.view.View
import androidx.core.os.bundleOf
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import java.io.File
import org.json.JSONArray
import org.json.JSONException

private const val WIDTH = 1080
private const val HEIGHT = 2400
private const val POLL_MS = 500L
private const val TOTAL_MS = 30_000L
private const val SETTLED_MS = 2_000L
private const val CHECK_MS = 15_000L
private const val ANSWER_MS = 3_000L
private const val EXIT_MS = 100L
private const val DATA_SUFFIX = "webpages"
private const val TEXT_LENGTH = "document.body ? document.body.innerText.length : 0"
private const val READ = "(function(){return JSON.stringify([document.documentElement.outerHTML, document.body ? document.body.innerText.length : 0, document.title, location.href]);})()"

// why: a page spinning on pi's profile froze pi with it; here it cannot reach pi's renderer, and the WebView's browser side (network, GPU, callbacks) is away from pi's main thread too, which a separate profile alone would not give
class PageWorker : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val messenger = Messenger(
        Handler(Looper.getMainLooper()) { message ->
            val url = message.data.getString(URL).orEmpty()
            val reply = Reply(message.replyTo, message.arg1)
            if (!WebPages.isWeb(Uri.parse(url))) reply.send(bundleOf(ERROR to "url must be http or https"))
            else if (message.what == CHECK) Check(url, reply).start()
            else Render(url, reply).start()
            true
        },
    )

    override fun onCreate() {
        super.onCreate()
        if (!suffixed) WebView.setDataDirectorySuffix(DATA_SUFFIX)
        suffixed = true
    }

    override fun onBind(intent: Intent): IBinder = messenger.binder

    private fun endProcess() {
        main.postDelayed({ Process.killProcess(Process.myPid()) }, EXIT_MS)
    }

    private class Reply(private val to: Messenger, val id: Int) {
        fun send(data: Bundle) {
            to.send(Message.obtain().also {
                it.arg1 = id
                it.data = data
            })
        }
    }

    private inner class Check(private val url: String, private val reply: Reply) {
        private val view = WebPages.create(this@PageWorker)
        private var done = false

        fun start() {
            view.webViewClient = object : WebPages.WebOnly() {
                override fun blocked(reason: String) = finish(bundleOf(BLOCKED to reason))

                override fun gone() = finish(Bundle())

                override fun onPageCommitVisible(webView: WebView, pageUrl: String?) = finish(Bundle())

                override fun onPageFinished(webView: WebView, pageUrl: String?) = finish(Bundle())
            }
            view.loadUrl(url)
            main.postDelayed(::deadline, CHECK_MS)
        }

        private fun deadline() {
            if (done) return
            var answered = false
            view.evaluateJavascript("1") { answered = true }
            main.postDelayed({
                finish(Bundle())
                if (!answered) endProcess()
            }, ANSWER_MS)
        }

        private fun finish(data: Bundle) {
            if (done) return
            done = true
            view.stopLoading()
            view.destroy()
            reply.send(data)
        }
    }

    private inner class Render(private val url: String, private val reply: Reply) {
        private val started = System.currentTimeMillis()
        private val view = WebPages.create(this@PageWorker)
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
            fail("the page stopped responding")
            endProcess()
        }

        private fun poll() {
            if (done) return
            val now = System.currentTimeMillis()
            val late = now - started >= TOTAL_MS
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
                val file = File(cacheDir, "page-${reply.id}.html").also { it.writeText(values.getString(0)) }
                close()
                reply.send(bundleOf(FILE to file.path, TITLE to values.getString(2), URL to values.getString(3), MS to System.currentTimeMillis() - started, SETTLED to !late))
            } catch (_: JSONException) {
                if (late) fail("could not read the page") else main.postDelayed(::poll, POLL_MS)
            }
        }

        private fun fail(message: String) {
            close()
            reply.send(bundleOf(ERROR to message))
        }

        private fun close() {
            done = true
            view.stopLoading()
            view.destroy()
        }
    }

    companion object {
        const val CHECK = 1
        const val RENDER = 2
        const val URL = "url"
        const val ERROR = "error"
        const val BLOCKED = "blocked"
        const val FILE = "file"
        const val TITLE = "title"
        const val MS = "ms"
        const val SETTLED = "settled"
        private var suffixed = false
    }
}
