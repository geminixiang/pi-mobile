package dev.geminixiang.pimobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import java.io.ByteArrayOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

private const val LOAD_MS = 15_000L
private const val POLL_MS = 200L
private const val TAP_MS = 60L
private const val USER_QUIET_MS = 4_000L
private const val USER_WAIT_MS = 60_000L
private const val EVAL_SECONDS = 10L
private const val PAGE_ANSWER_MS = 15_000L
private const val ANSWER_CHANNEL = "piAnswer"
private const val PAGE_SCRIPT = "public/page-controller.js"
private const val MISSING = "\"missing\""
private const val CALL_PAGE = "(() => { if (typeof window.__piPage !== 'object') return 'missing'; const answer = (result) => %s.postMessage(%s + '\\n' + JSON.stringify(result)); Promise.resolve().then(() => %s).then((value) => answer({ ok: value ?? {} }), (failure) => answer({ error: String((failure && failure.message) || failure) })); return 'started'; })()"

internal val mainHandler = Handler(Looper.getMainLooper())

internal fun <T> onMain(task: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return task()
    val future = FutureTask(Callable { task() })
    mainHandler.post(future)
    try {
        return future.get(EVAL_SECONDS, TimeUnit.SECONDS)
    } catch (failed: ExecutionException) {
        throw failed.cause ?: failed
    }
}

internal fun View.detach() {
    val parent = parent
    if (parent is ViewGroup) parent.removeView(this)
}

internal fun profileOf(bot: String) = "bot-$bot"

private object PageScript {
    @Volatile private var text: String? = null

    fun of(context: Context): String = text ?: context.assets.open(PAGE_SCRIPT).use { String(it.readBytes(), Charsets.UTF_8) }.also { text = it }
}

@SuppressLint("ClickableViewAccessibility")
internal class BrowserTab(
    val owner: BotTabs,
    val id: String,
    context: Context,
    window: Window,
    changed: (BrowserTab) -> Unit,
    idle: (BrowserTab) -> Unit,
) {
    val view: WebView = WebPages.create(context)
    val expire = Runnable { idle(this) }

    @Volatile var loading = false

    @Volatile private var lastUserTouch = 0L

    @Volatile private var injecting = false

    private var agentTouched = false

    @Volatile private var dialog: String? = null

    private val answers = ConcurrentHashMap<String, CompletableFuture<String>>()
    private val answerKeys = AtomicLong()

    init {
        ProfileStore.getInstance().getOrCreateProfile(profileOf(owner.bot))
        WebViewCompat.setProfile(view, profileOf(owner.bot))
        WebViewCompat.addWebMessageListener(view, ANSWER_CHANNEL, setOf("*")) { _, message, _, _, _ ->
            val data = message.data.orEmpty()
            val cut = data.indexOf('\n')
            if (cut >= 0) answers.remove(data.substring(0, cut))?.complete(data.substring(cut + 1))
        }
        view.webViewClient =
            object : WebPages.WebOnly() {
                override fun onPageStarted(webView: WebView, url: String?, favicon: Bitmap?) {
                    loading = true
                    changed(this@BrowserTab)
                }

                override fun doUpdateVisitedHistory(webView: WebView, url: String?, reload: Boolean) = changed(this@BrowserTab)

                override fun onPageFinished(webView: WebView, url: String?) {
                    loading = false
                    flushCookies()
                    changed(this@BrowserTab)
                }
            }
        view.webChromeClient =
            object : WebChromeClient() {
                override fun onReceivedTitle(webView: WebView, title: String?) = changed(this@BrowserTab)

                override fun onJsAlert(webView: WebView, url: String?, message: String?, result: JsResult): Boolean {
                    dialog = "alert: $message"
                    result.confirm()
                    return true
                }

                override fun onJsConfirm(webView: WebView, url: String?, message: String?, result: JsResult): Boolean {
                    dialog = "confirm, answered cancel: $message"
                    result.cancel()
                    return true
                }

                override fun onJsPrompt(webView: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
                    dialog = "prompt, answered cancel: $message"
                    result.cancel()
                    return true
                }
            }
        view.setOnTouchListener { _, _ ->
            agentTouched = injecting
            if (!injecting) lastUserTouch = SystemClock.uptimeMillis()
            false
        }
        ViewCompat.setWindowInsetsAnimationCallback(
            view,
            object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    val ime = WindowInsetsCompat.Type.ime()
                    val insets = ViewCompat.getRootWindowInsets(view)
                    val opening = insets != null && !insets.isVisible(ime) && (animation.typeMask and ime) != 0
                    if (opening && agentTouched && view.hasFocus()) WindowCompat.getInsetsController(window, view).hide(ime)
                }

                override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>) = insets
            },
        )
        layOut()
    }

    fun layOut() {
        view.measure(View.MeasureSpec.makeMeasureSpec(owner.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(owner.height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, owner.width, owner.height)
    }

    fun flushCookies() {
        mainHandler.post { ProfileStore.getInstance().getProfile(profileOf(owner.bot))?.cookieManager?.flush() }
    }

    fun takeDialog(): String? = dialog.also { dialog = null }

    fun awaitLoad() {
        val end = SystemClock.uptimeMillis() + LOAD_MS
        while (loading && SystemClock.uptimeMillis() < end) Thread.sleep(POLL_MS)
    }

    fun waitForUser() {
        val end = SystemClock.uptimeMillis() + USER_WAIT_MS
        while (SystemClock.uptimeMillis() - lastUserTouch < USER_QUIET_MS && SystemClock.uptimeMillis() < end) Thread.sleep(POLL_MS)
    }

    fun eval(script: String): Outcome<String> {
        val result = CompletableFuture<String>()
        mainHandler.post { view.evaluateJavascript(script) { result.complete(it) } }
        return try {
            Outcome.Ok(result.get(EVAL_SECONDS, TimeUnit.SECONDS))
        } catch (timeout: TimeoutException) {
            Outcome.Stopped("the page did not answer in $EVAL_SECONDS s")
        }
    }

    fun callPage(expression: String): Outcome<JSONObject> {
        val key = "r" + answerKeys.incrementAndGet()
        val answer = CompletableFuture<String>()
        answers[key] = answer
        try {
            val start = CALL_PAGE.format(ANSWER_CHANNEL, JSONObject.quote(key), expression)
            if (eval(start).valueOr { return it } == MISSING) {
                eval(PageScript.of(view.context) + ";0").valueOr { return it }
                if (eval(start).valueOr { return it } == MISSING) return Outcome.Stopped("the page script did not load on this page")
            }
            val result =
                try {
                    JSONObject(answer.get(PAGE_ANSWER_MS, TimeUnit.MILLISECONDS))
                } catch (timeout: TimeoutException) {
                    return Outcome.Stopped("the page did not answer in ${PAGE_ANSWER_MS / 1000} s")
                }
            if (result.has("error")) return Outcome.Stopped(result.getString("error"))
            return Outcome.Ok(result.getJSONObject("ok"))
        } finally {
            answers.remove(key)
        }
    }

    fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0))
        Thread.sleep(TAP_MS)
        inject(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0))
    }

    fun press(code: Int) {
        val down = SystemClock.uptimeMillis()
        onMain {
            view.dispatchKeyEvent(KeyEvent(down, down, KeyEvent.ACTION_DOWN, code, 0))
            view.dispatchKeyEvent(KeyEvent(down, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0))
        }
    }

    fun capture(): String {
        val bitmap =
            onMain {
                val drawn = Bitmap.createBitmap(maxOf(1, owner.width / 2), maxOf(1, owner.height / 2), Bitmap.Config.ARGB_8888)
                val canvas = Canvas(drawn)
                canvas.scale(0.5f, 0.5f)
                view.draw(canvas)
                drawn
            }
        val bytes = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 70, bytes)
        bitmap.recycle()
        return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
    }

    private fun inject(event: MotionEvent) {
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        onMain {
            injecting = true
            view.dispatchTouchEvent(event)
            injecting = false
            event.recycle()
        }
    }
}
