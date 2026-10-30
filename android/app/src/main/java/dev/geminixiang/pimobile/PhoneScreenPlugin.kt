package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager
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
private const val QUIET_MS = 350L
private const val FIRST_CHANGE_MS = 1000L
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
    private var lastSeen: String? = null

    @PluginMethod
    fun status(call: PluginCall) = call.resolve(JSObject().put("allowed", PhoneScreenService.running != null))

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val component = ComponentName(context, PhoneScreenService::class.java).flattenToString()
        val detail = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val list = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(if (detail.resolveActivity(context.packageManager) != null) detail else list)
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
            Outcome.Ok(snapshot(service, call.data.optBoolean("screenshot")))
        }

    @PluginMethod
    fun act(call: PluginCall) =
        worker.reply(call) {
            val service = PhoneScreenService.running ?: return@reply OFF
            val steps = call.data.getJSONArray("steps")
            val before = lastSeen
            val did = mutableListOf<String>()
            var done = 0
            var stopped: String? = null
            for (at in 0 until steps.length()) {
                val json = steps.getJSONObject(at)
                val step = ScreenStep.of(json)
                val since = SystemClock.uptimeMillis()
                val screen = metrics(service)
                when (val ran = actor.perform(service, step, screen, SHOT_WIDTH.toFloat() / screen.widthPixels)) {
                    is Outcome.Ok -> ran.value?.let(did::add)
                    is Outcome.Stopped -> {
                        stopped = "step ${at + 1} (${json.getString("action")}): ${ran.reason}"
                        break
                    }
                }
                done = at + 1
                if (step !is ScreenStep.Wait) service.settle(since, if (done < steps.length()) NEXT_STEP_CAP_MS else LAST_STEP_CAP_MS)
            }
            val result = snapshot(service, call.data.optBoolean("screenshot")).put("done", done)
            if (done > 0 && lastSeen == before) result.put("unchanged", true)
            if (did.isNotEmpty()) result.put("did", JSONArray(did))
            if (stopped != null) result.put("error", stopped)
            Outcome.Ok(result)
        }

    private fun metrics(service: PhoneScreenService) = DisplayMetrics().also { service.getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(it) }

    private fun snapshot(service: PhoneScreenService, withScreenshot: Boolean): JSObject {
        val screen = metrics(service)
        val scale = SHOT_WIDTH.toFloat() / screen.widthPixels
        val deadline = System.currentTimeMillis() + ELEMENTS_MS
        val seen = service.see(scale, screen, deadline)
        val elements = seen.lines.take(MAX_ELEMENTS).joinToString("\n") { it.text }
        lastSeen = seen.front.orEmpty() + "\n" + elements
        val result =
            JSObject()
                .put("width", SHOT_WIDTH)
                .put("height", (screen.heightPixels * scale).roundToInt())
                .put("keyboard", seen.keyboard)
                .put("elements", elements)
                .put("more", maxOf(0, seen.lines.size - MAX_ELEMENTS))
        seen.front?.let { result.put("package", it).put("app", NotificationsListener.appLabel(service.packageManager, it)) }
        if (System.currentTimeMillis() > deadline) result.put("slow", true)
        if (!withScreenshot) return result
        when (val shot = screenshot(service, scale)) {
            is Outcome.Ok -> result.put("jpeg", shot.value)
            is Outcome.Stopped -> result.put("shotError", shot.reason)
        }
        return result
    }

    private fun screenshot(service: PhoneScreenService, scale: Float): Outcome<String> {
        repeat(SHOT_ATTEMPTS) {
            val done = CountDownLatch(1)
            val shot = AtomicReference<Bitmap?>()
            val code = AtomicInteger()
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
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

private fun PhoneScreenService.settle(since: Long, cap: Long) {
    val start = SystemClock.uptimeMillis()
    while (lastChangeAt() <= since && SystemClock.uptimeMillis() - start < FIRST_CHANGE_MS) Thread.sleep(SETTLE_POLL_MS)
    while (SystemClock.uptimeMillis() - lastChangeAt() < QUIET_MS && SystemClock.uptimeMillis() - start < cap) Thread.sleep(SETTLE_POLL_MS)
}
