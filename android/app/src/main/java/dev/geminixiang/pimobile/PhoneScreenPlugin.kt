package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import org.json.JSONArray

private const val SHOT_WIDTH = 540
private const val SHOT_SECONDS = 5L
private const val SHOT_ATTEMPTS = 4
private const val SHOT_RETRY_MS = 400L
private const val SETTLE_POLL_MS = 50L
private const val NEXT_STEP_CAP_MS = 1500L
private const val LAST_STEP_CAP_MS = 2500L
private val OFF = Outcome.Stopped("off")
private val SHOT_FAILED = Outcome.Stopped("the screenshot failed")

@CapacitorPlugin(name = "PhoneScreen")
class PhoneScreenPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private val screenshots = Executors.newSingleThreadExecutor()
    private val actor = ScreenActor()
    private val lastSeen = mutableMapOf<Int, ScreenText>()

    @PluginMethod
    fun status(call: PluginCall) = call.resolve(JSObject().put("allowed", PhoneScreenService.running != null))

    @PluginMethod
    fun openSettings(call: PluginCall) {
        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun openAppInfo(call: PluginCall) {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        call.resolve()
    }

    @PluginMethod
    fun read(call: PluginCall) =
        worker.reply(call) {
            val service = PhoneScreenService.running ?: return@reply OFF
            val display = call.data.optInt("display", Display.DEFAULT_DISPLAY)
            DisplayShells.current?.before(display, "read")?.let { return@reply Outcome.Ok(stoppedSnapshot(it, metrics(service, display))) }
            Outcome.Ok(snapshot(service, call.data.optBoolean("screenshot"), display))
        }

    @PluginMethod
    fun act(call: PluginCall) =
        worker.reply(call) {
            val service = PhoneScreenService.running ?: return@reply OFF
            val steps = call.data.getJSONArray("steps")
            val display = call.data.optInt("display", Display.DEFAULT_DISPLAY)
            val before = lastSeen[display]
            val note = call.getString("note")
            val did = mutableListOf<String>()
            var done = 0
            var stopped: String? = null
            for (at in 0 until steps.length()) {
                val json = steps.getJSONObject(at)
                val step = ScreenStep.of(json)
                val since = SystemClock.uptimeMillis()
                val screen = metrics(service, display) ?: return@reply Outcome.Ok(stoppedSnapshot("display_closed", null).put("done", done))
                when (val ran = actor.perform(service, step, screen, SHOT_WIDTH.toFloat() / screen.widthPixels, display, note)) {
                    is Outcome.Ok -> ran.value?.let(did::add)
                    is Outcome.Stopped -> {
                        stopped = "step ${at + 1} (${json.getString("action")}): ${ran.reason}"
                        break
                    }
                }
                done = at + 1
                if (step !is ScreenStep.Wait && step !is ScreenStep.WaitFor && step !is ScreenStep.Expect && step !is ScreenStep.ScrollTo)
                    service.settle(since, if (done < steps.length()) NEXT_STEP_CAP_MS else LAST_STEP_CAP_MS, display)
            }
            val interrupted = DisplayShells.current?.reason(display)
            val result = (if (interrupted == null) snapshot(service, call.data.optBoolean("screenshot"), display, before)
                else stoppedSnapshot(interrupted, metrics(service, display))).put("done", done)
            if (interrupted == null && done > 0 && lastSeen[display] == before) result.put("unchanged", true)
            if (did.isNotEmpty()) result.put("did", JSONArray(did))
            (interrupted ?: stopped)?.let { result.put("error", it) }
            Outcome.Ok(result)
        }

    private fun metrics(service: PhoneScreenService, display: Int) =
        service.getSystemService(DisplayManager::class.java).getDisplay(display)?.let { target -> DisplayMetrics().also(target::getRealMetrics) }

    private fun snapshot(service: PhoneScreenService, withScreenshot: Boolean, display: Int = Display.DEFAULT_DISPLAY, before: ScreenText? = null): JSObject {
        val screen = metrics(service, display) ?: return stoppedSnapshot("display_closed", null)
        val scale = SHOT_WIDTH.toFloat() / screen.widthPixels
        val deadline = System.currentTimeMillis() + ELEMENTS_MS
        val seen = service.see(scale, screen, deadline, display)
        val current = ScreenText(seen.front, seen.keyboard, seen.lines.map { it.text }, seen.complete)
        val (delta, elements) = current.changes(before)
        lastSeen[display] = current
        val result =
            JSObject()
                .put("width", SHOT_WIDTH)
                .put("height", (screen.heightPixels * scale).roundToInt())
                .put("keyboard", seen.keyboard)
                .put("elements", elements)
                .put("more", current.more)
                .put("delta", delta)
        seen.front?.let { result.put("package", it).put("app", NotificationsListener.appLabel(service.packageManager, it)) }
        if (!current.complete) result.put("slow", true)
        if (!withScreenshot) return result
        when (val shot = screenshot(service, scale, display)) {
            is Outcome.Ok -> result.put("jpeg", shot.value)
            is Outcome.Stopped -> result.put("shotError", shot.reason)
        }
        return result
    }

    private fun stoppedSnapshot(reason: String, screen: DisplayMetrics?) = JSObject()
        .put("width", SHOT_WIDTH)
        .put("height", screen?.let { (it.heightPixels * SHOT_WIDTH.toFloat() / it.widthPixels).roundToInt() } ?: 0)
        .put("keyboard", false).put("elements", "").put("more", 0).put("error", reason)

    private fun screenshot(service: PhoneScreenService, scale: Float, display: Int): Outcome<String> {
        repeat(SHOT_ATTEMPTS) {
            val done = CountDownLatch(1)
            val shot = AtomicReference<Bitmap?>()
            val code = AtomicInteger()
            service.takeScreenshot(
                display,
                screenshots,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                        val buffer = screenshot.hardwareBuffer
                        Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)?.let {
                            shot.set(it.copy(Bitmap.Config.ARGB_8888, false))
                            it.recycle()
                        }
                        buffer.close()
                        done.countDown()
                    }

                    override fun onFailure(errorCode: Int) {
                        code.set(errorCode)
                        done.countDown()
                    }
                },
            )
            if (!done.await(SHOT_SECONDS, TimeUnit.SECONDS)) return SHOT_FAILED
            val full = shot.get()
            if (full != null) {
                val small = Bitmap.createScaledBitmap(full, SHOT_WIDTH, (full.height * scale).roundToInt(), true)
                full.recycle()
                val out = ByteArrayOutputStream()
                small.compress(Bitmap.CompressFormat.JPEG, 70, out)
                small.recycle()
                return Outcome.Ok(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
            }
            if (code.get() == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) return Outcome.Stopped("the app on screen blocks screenshots; only its elements are listed")
            if (code.get() != AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return SHOT_FAILED
            Thread.sleep(SHOT_RETRY_MS)
        }
        return SHOT_FAILED
    }
}

internal fun PhoneScreenService.settle(since: Long, cap: Long, display: Int) {
    val start = SystemClock.uptimeMillis()
    while (changes.pending(display, since, start, SystemClock.uptimeMillis(), cap)) Thread.sleep(SETTLE_POLL_MS)
}
