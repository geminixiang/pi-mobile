package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Path
import android.graphics.PointF
import android.os.Bundle
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityNodeInfo
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt
import org.json.JSONObject

private const val TAP_MS = 60L
private const val LONG_PRESS_MS = 700L
private const val SCROLL_MS = 350L
private const val GESTURE_GRACE_MS = 3000L
private const val READ_BACK_MS = 1500L
private const val READ_BACK_POLL_MS = 100L
private const val OPEN_MS = 4000L
private const val OPEN_POLL_MS = 100L
private val GLOBAL_KEYS =
    mapOf(
        "back" to AccessibilityService.GLOBAL_ACTION_BACK,
        "home" to AccessibilityService.GLOBAL_ACTION_HOME,
        "recents" to AccessibilityService.GLOBAL_ACTION_RECENTS,
        "notifications" to AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS,
        "quick_settings" to AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS,
    )

internal sealed interface ScreenStep {
    data class Tap(val x: Double, val y: Double) : ScreenStep

    data class LongPress(val x: Double, val y: Double) : ScreenStep

    data class Swipe(val x: Double, val y: Double, val toX: Double, val toY: Double, val ms: Long) : ScreenStep

    data class Scroll(val direction: String, val x: Double?, val y: Double?) : ScreenStep

    data class Type(val text: String) : ScreenStep

    data object Clear : ScreenStep

    data class Press(val key: String) : ScreenStep

    data class Open(val app: String) : ScreenStep

    data class Wait(val ms: Long) : ScreenStep

    companion object {
        fun of(json: JSONObject): ScreenStep =
            when (val action = json.getString("action")) {
                "tap" -> Tap(json.getDouble("x"), json.getDouble("y"))
                "long_press" -> LongPress(json.getDouble("x"), json.getDouble("y"))
                "swipe" -> Swipe(json.getDouble("x"), json.getDouble("y"), json.getDouble("to_x"), json.getDouble("to_y"), json.getLong("ms"))
                "scroll" -> Scroll(json.getString("direction"), json.optional("x"), json.optional("y"))
                "type" -> Type(json.getString("text"))
                "clear" -> Clear
                "key" -> Press(json.getString("key"))
                "open" -> Open(json.getString("app"))
                "wait" -> Wait(json.getLong("ms"))
                else -> throw IllegalArgumentException("unknown action $action")
            }

        private fun JSONObject.optional(field: String): Double? = if (has(field)) getDouble(field) else null
    }
}

internal class ScreenActor {
    private var lastTap: PointF? = null
    private val launchers = LinkedHashMap<String, String>()

    fun perform(service: PhoneScreenService, step: ScreenStep, screen: DisplayMetrics, scale: Float): Outcome<String?> {
        val px = { points: Double -> (points / scale).toFloat() }
        when (step) {
            is ScreenStep.Tap -> {
                val at = PointF(px(step.x), px(step.y))
                lastTap = at
                val target = service.describedAt(at.x, at.y, scale)
                service.gesture(line(at.x, at.y, at.x, at.y), TAP_MS).valueOr { return it }
                return Outcome.Ok("tapped $target")
            }
            is ScreenStep.LongPress -> {
                val x = px(step.x)
                val y = px(step.y)
                val target = service.describedAt(x, y, scale)
                service.gesture(line(x, y, x, y), LONG_PRESS_MS).valueOr { return it }
                return Outcome.Ok("long-pressed $target")
            }
            is ScreenStep.Swipe -> service.gesture(line(px(step.x), px(step.y), px(step.toX), px(step.toY)), step.ms).valueOr { return it }
            is ScreenStep.Scroll -> service.scroll(step, screen, step.x?.let(px) ?: (screen.widthPixels / 2f), step.y?.let(px) ?: (screen.heightPixels / 2f)).valueOr { return it }
            is ScreenStep.Type -> type(service, step.text, replace = false).valueOr { return it }
            ScreenStep.Clear -> type(service, "", replace = true).valueOr { return it }
            is ScreenStep.Press -> press(service, step.key).valueOr { return it }
            is ScreenStep.Open -> open(service, step.app).valueOr { return it }
            is ScreenStep.Wait -> Thread.sleep(step.ms)
        }
        return Outcome.Ok(null)
    }

    private fun type(service: PhoneScreenService, text: String, replace: Boolean): Outcome<Unit> {
        val focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val field =
            (if (focused?.isEditable == true) focused else editableAt(service.rootInActiveWindow)) ?: focused
                ?: return Outcome.Stopped("no text field has focus: tap one first")
        if (field.isEditable) {
            val before = if (replace) "" else shown(field)
            val arguments = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, before + text) }
            if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return readBack(field, text)
        }
        if (replace) return Outcome.Stopped("this field cannot be emptied here: select its text and delete it")
        service.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("pi", text))
        if (field.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return readBack(field, text)
        return Outcome.Stopped("this field takes no typed text, but the text is on the clipboard: long_press in the field and tap 貼上 (Paste)")
    }

    private fun editableAt(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null || !node.isVisibleToUser) return null
        val tap = lastTap
        if (node.isEditable && (node.isFocused || (tap != null && node.covers(tap.x.roundToInt(), tap.y.roundToInt())))) return node
        return (0 until node.childCount).firstNotNullOfOrNull { editableAt(node.getChild(it)) }
    }

    private fun open(service: PhoneScreenService, name: String): Outcome<Unit> {
        val wanted = name.trim().lowercase(Locale.ROOT)
        val packages = service.packageManager
        val cached = match(wanted)?.takeIf { packages.getLaunchIntentForPackage(it) != null }
        val pkg = cached ?: loadLaunchers(packages).let { match(wanted) }
        val intent = pkg?.let(packages::getLaunchIntentForPackage) ?: return Outcome.Stopped("no installed app is called $name; the apps are: ${launchers.values.joinToString(", ")}")
        service.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        val until = SystemClock.uptimeMillis() + OPEN_MS
        while (SystemClock.uptimeMillis() < until && pkg != service.rootInActiveWindow?.packageName?.toString()) Thread.sleep(OPEN_POLL_MS)
        return Outcome.Ok(Unit)
    }

    private fun loadLaunchers(packages: PackageManager) {
        launchers.clear()
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        for (info in packages.queryIntentActivities(launcher, 0)) launchers[info.activityInfo.packageName] = info.loadLabel(packages).toString()
    }

    private fun match(wanted: String): String? {
        val labels = launchers.mapValues { it.value.lowercase(Locale.ROOT) }
        return labels.entries.firstOrNull { (pkg, label) -> pkg.equals(wanted, ignoreCase = true) || label == wanted }?.key
            ?: labels.entries.firstOrNull { it.value.contains(wanted) }?.key
            ?: labels.entries.filter { it.value.length > 2 && wanted.contains(it.value) }.maxByOrNull { it.value.length }?.key
    }
}

private fun PhoneScreenService.gesture(path: Path, ms: Long): Outcome<Unit> {
    val finished = CountDownLatch(1)
    val completed = AtomicBoolean(false)
    val sent =
        dispatchGesture(
            GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(),
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(description: GestureDescription) {
                    completed.set(true)
                    finished.countDown()
                }

                override fun onCancelled(description: GestureDescription) {
                    finished.countDown()
                }
            },
            null,
        )
    if (!sent || !finished.await(ms + GESTURE_GRACE_MS, TimeUnit.MILLISECONDS) || !completed.get()) return Outcome.Stopped("the system cancelled the gesture")
    return Outcome.Ok(Unit)
}

private fun PhoneScreenService.scroll(step: ScreenStep.Scroll, screen: DisplayMetrics, x: Float, y: Float): Outcome<Unit> {
    val (dx, dy) =
        when (step.direction) {
            "down" -> 0f to -screen.heightPixels * 0.35f
            "up" -> 0f to screen.heightPixels * 0.35f
            "right" -> -screen.widthPixels * 0.6f to 0f
            "left" -> screen.widthPixels * 0.6f to 0f
            else -> throw IllegalArgumentException("direction ${step.direction}")
        }
    val fromX = (x - dx / 2).coerceIn(1f, screen.widthPixels - 1f)
    val fromY = (y - dy / 2).coerceIn(1f, screen.heightPixels - 1f)
    return gesture(line(fromX, fromY, fromX + dx, fromY + dy), SCROLL_MS)
}

private fun press(service: PhoneScreenService, key: String): Outcome<Unit> {
    val global = GLOBAL_KEYS[key]
    if (global != null) return if (service.performGlobalAction(global)) Outcome.Ok(Unit) else Outcome.Stopped("the system refused it")
    val field = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return Outcome.Stopped("no text field has focus")
    if (!field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) return Outcome.Stopped("the field has no enter action: tap the send or search button")
    return Outcome.Ok(Unit)
}

private fun readBack(field: AccessibilityNodeInfo, typed: String): Outcome<Unit> {
    if (typed.isEmpty() || field.isPassword) return Outcome.Ok(Unit)
    val end = SystemClock.uptimeMillis() + READ_BACK_MS
    val wanted = comparable(typed)
    while (SystemClock.uptimeMillis() < end) {
        field.refresh()
        if (comparable(shown(field)).contains(wanted)) return Outcome.Ok(Unit)
        Thread.sleep(READ_BACK_POLL_MS)
    }
    return Outcome.Stopped("the field shows \"${clip(shown(field))}\", not what was typed; read the screen and type again or into another field")
}

private fun shown(field: AccessibilityNodeInfo): String {
    val text = field.text
    return if (text == null || field.isShowingHintText) "" else text.toString()
}

private fun comparable(text: String) = buildString { text.codePoints().filter(Character::isLetterOrDigit).forEach(::appendCodePoint) }

private fun line(x: Float, y: Float, toX: Float, toY: Float) =
    Path().apply {
        moveTo(maxOf(0f, x), maxOf(0f, y))
        lineTo(maxOf(0f, toX), maxOf(0f, toY))
    }
