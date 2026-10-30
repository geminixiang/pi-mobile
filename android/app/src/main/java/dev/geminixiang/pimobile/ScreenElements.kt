package dev.geminixiang.pimobile

import android.graphics.Rect
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import kotlin.math.roundToInt

internal const val MAX_ELEMENTS = 160
internal const val ELEMENTS_MS = 2500L
private const val MAX_LABEL = 60
private const val TREE_RETRY_MS = 200L
private const val SEPARATOR = " · "
private val SPACES = Regex("\\s+")

internal data class Line(val text: String, val node: AccessibilityNodeInfo?)

internal data class Seen(val lines: List<Line>, val keyboard: Boolean, val front: String?)

internal fun PhoneScreenService.see(scale: Float, screen: DisplayMetrics, deadline: Long): Seen {
    val lines = mutableListOf<Line>()
    var active: AccessibilityNodeInfo? = null
    var keyboard = false
    var attempt = 0
    while (lines.isEmpty() && System.currentTimeMillis() < deadline) {
        if (attempt++ > 0) Thread.sleep(TREE_RETRY_MS)
        active = rootInActiveWindow
        val shown = windows
        for (window in shown) {
            if (window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                keyboard = true
                continue
            }
            val area = Rect().also(window::getBoundsInScreen)
            val sliver = area.height() < screen.heightPixels / 8 || area.width() < screen.widthPixels / 8
            if (window.type == AccessibilityWindowInfo.TYPE_SYSTEM && sliver) continue
            val root = window.root ?: continue
            val before = lines.size
            walk(root, scale, false, lines, deadline)
            if (lines.size > before && shown.size > 1) lines.add(before, Line("# ${kindOf(window)}${window.title?.let { " " + clip(it.toString()) }.orEmpty()}", null))
            if (lines.size >= MAX_ELEMENTS || System.currentTimeMillis() > deadline) break
        }
        val alone = active
        if (shown.isEmpty() && alone != null) walk(alone, scale, false, lines, deadline)
    }
    return Seen(withOwners(lines, deadline), keyboard, active?.packageName?.toString())
}

internal fun PhoneScreenService.describedAt(x: Float, y: Float, scale: Float): String {
    val deadline = System.currentTimeMillis() + ELEMENTS_MS
    val px = x.roundToInt()
    val py = y.roundToInt()
    val window = windows.firstOrNull { it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD && Rect().also(it::getBoundsInScreen).contains(px, py) }
    val hit = window?.let { smallestAt(it.root, px, py, null, deadline) }
    val point = "at ${(x * scale).roundToInt()},${(y * scale).roundToInt()}"
    if (hit == null) return "$point, where nothing takes a tap"
    val owner = ownerOf(hit, deadline)
    return quoted(labelOf(hit, deadline)) + (if (owner.isEmpty()) "" else " in ${quoted(owner)}") + " " + point
}

internal fun AccessibilityNodeInfo.covers(x: Int, y: Int) = Rect().also(::getBoundsInScreen).contains(x, y)

internal fun clip(text: String): String {
    val flat = text.replace(SPACES, " ").trim()
    return if (flat.length > MAX_LABEL) flat.take(MAX_LABEL) + "…" else flat
}

private fun walk(node: AccessibilityNodeInfo, scale: Float, insideButton: Boolean, into: MutableList<Line>, deadline: Long) {
    if (into.size >= MAX_ELEMENTS + 1 || System.currentTimeMillis() > deadline || !node.isVisibleToUser) return
    val bounds = Rect().also(node::getBoundsInScreen)
    val clickable = node.isClickable || node.isLongClickable
    val editable = node.isEditable
    val label = if (clickable && !editable) labelOf(node, deadline) else ownLabel(node)
    val role =
        when {
            editable -> "field"
            node.isCheckable -> if (node.isChecked) "checked" else "unchecked"
            clickable -> "button"
            node.isScrollable -> "list"
            label.isEmpty() || insideButton -> null
            else -> "text"
        }
    if (role != null && !bounds.isEmpty) {
        val named = if (label.isEmpty()) role else "$role ${quoted(label)}"
        val center = "at ${(bounds.exactCenterX() * scale).roundToInt()},${(bounds.exactCenterY() * scale).roundToInt()}"
        val flags =
            listOfNotNull(
                "scrollable".takeIf { node.isScrollable && role != "list" },
                "focused".takeIf { node.isFocused },
                "selected".takeIf { node.isSelected },
                "disabled".takeIf { !node.isEnabled },
            )
        into.add(Line((listOf(named, center) + flags).joinToString(" "), node))
    }
    val inside = insideButton || (clickable && !editable)
    for (at in 0 until node.childCount) node.getChild(at)?.let { walk(it, scale, inside, into, deadline) }
}

private fun kindOf(window: AccessibilityWindowInfo) =
    when (window.type) {
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "overlay"
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "divider"
        else -> "app"
    }

private fun withOwners(lines: List<Line>, deadline: Long): List<Line> {
    val shapes = lines.map { shapeOf(it.text) }
    val counts = shapes.groupingBy { it }.eachCount()
    return lines.mapIndexed { at, line ->
        val node = line.node
        val shape = shapes[at]
        if (node == null || !actionable(node) || (counts[shape] ?: 0) < 2) return@mapIndexed line
        val owner = ownerOf(node, deadline)
        if (owner.isEmpty()) line else line.copy(text = "$shape in ${quoted(owner)}${line.text.substring(shape.length)}")
    }
}

private fun shapeOf(line: String): String {
    val at = line.lastIndexOf(" at ")
    return if (at < 0) line else line.substring(0, at)
}

private fun ownLabel(node: AccessibilityNodeInfo): String {
    val text = node.text
    if (node.isPassword) return if (text.isNullOrEmpty()) "" else "••••"
    return listOf(text, node.contentDescription, node.hintText).firstOrNull { !it.isNullOrBlank() }?.let { clip(it.toString()) }.orEmpty()
}

private fun labelOf(node: AccessibilityNodeInfo, deadline: Long): String {
    val own = ownLabel(node)
    if (own.isNotEmpty()) return own
    val inner = StringBuilder()
    texts(node, null, inner, deadline)
    return clip(inner.toString())
}

private fun ownerOf(node: AccessibilityNodeInfo, deadline: Long): String {
    val around = StringBuilder()
    var from = node
    var parent = node.parent
    while (parent != null) {
        texts(parent, from, around, deadline)
        if (around.length > MAX_LABEL || System.currentTimeMillis() > deadline) return ""
        val words = around.split(SEPARATOR).filter { part -> part.codePoints().anyMatch(Character::isLetterOrDigit) }
        if (words.isNotEmpty()) return words.joinToString(SEPARATOR)
        from = parent
        parent = parent.parent
    }
    return ""
}

private fun texts(node: AccessibilityNodeInfo, skipped: AccessibilityNodeInfo?, into: StringBuilder, deadline: Long) {
    for (at in 0 until node.childCount) {
        if (into.length > MAX_LABEL || System.currentTimeMillis() > deadline) return
        val child = node.getChild(at) ?: continue
        if (!child.isVisibleToUser || child == skipped) continue
        val label = ownLabel(child)
        if (label.isNotEmpty()) into.append(if (into.isNotEmpty()) SEPARATOR else "").append(label)
        texts(child, null, into, deadline)
    }
}

private fun smallestAt(node: AccessibilityNodeInfo?, x: Int, y: Int, best: AccessibilityNodeInfo?, deadline: Long): AccessibilityNodeInfo? {
    if (node == null || !node.isVisibleToUser || !node.covers(x, y) || System.currentTimeMillis() > deadline) return best
    val smallest = if (actionable(node) && (best == null || areaOf(node) < areaOf(best))) node else best
    return (0 until node.childCount).fold(smallest) { found, at -> smallestAt(node.getChild(at), x, y, found, deadline) }
}

private fun areaOf(node: AccessibilityNodeInfo): Long {
    val bounds = Rect().also(node::getBoundsInScreen)
    return bounds.width().toLong() * bounds.height()
}

private fun actionable(node: AccessibilityNodeInfo) = node.isClickable || node.isLongClickable || node.isEditable || node.isCheckable

private fun quoted(text: String) = "\"${text.replace("\"", "'")}\""
