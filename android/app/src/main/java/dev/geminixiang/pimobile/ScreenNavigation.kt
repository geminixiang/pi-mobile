package dev.geminixiang.pimobile

import android.graphics.Rect
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityNodeInfo

internal data class ScreenTarget(val node: AccessibilityNodeInfo, val description: String)

internal class ScreenNavigation(
    private val service: PhoneScreenService,
    private val screen: DisplayMetrics,
    private val scale: Float,
    private val display: Int,
) {
    fun target(step: ScreenStep): Outcome<ScreenTarget> {
        val until = SystemClock.uptimeMillis() + if (step is ScreenStep.TapText) 3000L else ELEMENTS_MS
        do {
            DisplayShells.current?.reason(display)?.let { return Outcome.Stopped(it) }
            val seen = read(until)
            val matches = seen.lines.filter {
                when (step) {
                    is ScreenStep.TapId -> it.id == step.id
                    is ScreenStep.TapText -> it.label.equals(step.text.trim(), ignoreCase = true)
                    else -> false
                }
            }.mapNotNull { line -> line.node?.let { ScreenTarget(clickTarget(it), line.text) } }.distinctBy { it.node }
            if (matches.size > 1) return Outcome.Stopped("target_ambiguous: use an id")
            val found = matches.firstOrNull()
            if (found != null) {
                if (!found.node.refresh() || !found.node.isVisibleToUser) return Outcome.Stopped("target_gone")
                return Outcome.Ok(found)
            }
            if (!seen.complete) return Outcome.Stopped("tree_incomplete")
            if (step is ScreenStep.TapId) return Outcome.Stopped("target_gone: ${step.id}")
            Thread.sleep(100)
        } while (SystemClock.uptimeMillis() < until)
        return Outcome.Stopped("target_missing")
    }

    fun waitFor(step: ScreenStep.WaitFor): Outcome<Unit> {
        val until = SystemClock.uptimeMillis() + step.ms
        do {
            DisplayShells.current?.reason(display)?.let { return Outcome.Stopped(it) }
            val seen = read(until)
            if (seen.complete && seen.lines.isNotEmpty() && contains(seen, step.text) != step.gone) return Outcome.Ok(Unit)
            Thread.sleep(100)
        } while (SystemClock.uptimeMillis() < until)
        return Outcome.Stopped("wait_timeout: ${step.text}")
    }

    fun expect(step: ScreenStep.Expect): Outcome<Unit> {
        val seen = read(SystemClock.uptimeMillis() + ELEMENTS_MS)
        val app = step.app
        if (app != null && !app.equals(seen.front, ignoreCase = true) &&
            !app.equals(seen.front?.let { NotificationsListener.appLabel(service.packageManager, it) }, ignoreCase = true)) {
            return Outcome.Stopped("expect_app: $app")
        }
        if (step.text != null && !contains(seen, step.text)) return Outcome.Stopped("expect_text: ${step.text}")
        return Outcome.Ok(Unit)
    }

    fun scrollTo(step: ScreenStep.ScrollTo): Outcome<Unit> {
        val until = SystemClock.uptimeMillis() + 15000L
        val action = when (step.direction) {
            "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP
            "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
            "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
            else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN
        }
        val fallback = if (step.direction == "up" || step.direction == "left")
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        var previous: List<String>? = null
        repeat(13) { attempt ->
            DisplayShells.current?.reason(display)?.let { return Outcome.Stopped(it) }
            val seen = read(until)
            if (contains(seen, step.text)) return Outcome.Ok(Unit)
            if (!seen.complete) return Outcome.Stopped("tree_incomplete")
            val signature = seen.lines.map { it.text.substringAfter("] ") }
            if (signature == previous) return Outcome.Stopped("scroll_end: ${step.text}")
            if (attempt == 12 || SystemClock.uptimeMillis() >= until) return Outcome.Stopped("scroll_limit: ${step.text}")
            val list = seen.lines.mapNotNull { it.node }.filter { it.isScrollable }.maxWithOrNull(
                compareBy<AccessibilityNodeInfo> { it.actionList.any { offered -> offered.id == action.id || offered.id == fallback } }
                    .thenBy { it.collectionInfo != null }
                    .thenBy { val area = Rect().also(it::getBoundsInScreen); area.width().toLong() * area.height() }
            ) ?: return Outcome.Stopped("no_scrollable_list")
            previous = signature
            val supported = if (list.actionList.contains(action)) action.id else fallback
            val since = SystemClock.uptimeMillis()
            if (!list.performAction(supported)) {
                val area = Rect().also(list::getBoundsInScreen)
                service.scroll(ScreenStep.Scroll(step.direction, null, null), screen, area.exactCenterX(), area.exactCenterY(), display).valueOr { return it }
            }
            service.settle(since, minOf(1500L, maxOf(0L, until - SystemClock.uptimeMillis())), display)
        }
        return Outcome.Stopped("scroll_limit: ${step.text}")
    }

    private fun read(until: Long) = service.see(scale, screen,
        System.currentTimeMillis() + minOf(ELEMENTS_MS, maxOf(1L, until - SystemClock.uptimeMillis())), display)

    private fun contains(seen: Seen, text: String) = seen.lines.any { line ->
        val node = line.node ?: return@any false
        listOf(line.label, node.hintText, node.stateDescription, node.error).any { it?.contains(text.trim(), ignoreCase = true) == true }
    }

    private fun clickTarget(node: AccessibilityNodeInfo): AccessibilityNodeInfo {
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.isClickable) return current
            current = current.parent
        }
        return node
    }
}
