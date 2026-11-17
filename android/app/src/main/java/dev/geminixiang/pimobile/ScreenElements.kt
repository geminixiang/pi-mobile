package dev.geminixiang.pimobile

import android.graphics.Rect
import android.util.DisplayMetrics
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import kotlin.math.roundToInt

internal const val ELEMENTS_MS = 2500L
private const val TREE_RETRY_MS = 200L
private const val SEPARATOR = " · "

internal data class Line(val text: String, val node: AccessibilityNodeInfo?, val label: String = "", val id: Int = 0, val context: String = "")

internal class ElementIds {
    private data class Identity(val node: AccessibilityNodeInfo, val label: String, val context: String)
    private val displays = mutableMapOf<Int, Map<Identity, Int>>()
    private var next = 1

    fun assign(display: Int, lines: List<Line>): List<Line> {
        val previous = displays[display].orEmpty()
        val current = mutableMapOf<Identity, Int>()
        val result = lines.map { line ->
            val node = line.node ?: return@map line
            val identity = Identity(node, if (node.isEditable) node.viewIdResourceName.orEmpty() else line.label, line.context)
            val id = previous[identity] ?: next++
            current[identity] = id
            line.copy(id = id, text = "[$id] ${line.text}")
        }
        displays[display] = current
        return result
    }
}

internal data class Seen(val lines: List<Line>, val keyboard: Boolean, val front: String?, val complete: Boolean)

internal fun PhoneScreenService.see(scale: Float, screen: DisplayMetrics, deadline: Long, display: Int = Display.DEFAULT_DISPLAY): Seen {
    val lines = mutableListOf<Line>()
    var active: AccessibilityNodeInfo? = null
    var keyboard = false
    var attempt = 0
    while (lines.isEmpty() && System.currentTimeMillis() < deadline) {
        if (attempt++ > 0) Thread.sleep(TREE_RETRY_MS)
        val shown = windowsOn(display)
        active = activeRoot(display)
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
            walk(root, scale, screen, lines, deadline)
            if (lines.size > before) {
                val dialog = window.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                    (root.className?.contains("Dialog") == true || area.height() < screen.heightPixels * 0.8)
                lines.add(before, Line("# ${kindOf(window)}${if (dialog) " dialog/modal" else ""}${window.title?.let { " " + clip(it.toString()) }.orEmpty()}", null))
            }
            if (System.currentTimeMillis() > deadline) break
        }
        val alone = active
        if (shown.isEmpty() && alone != null) walk(alone, scale, screen, lines, deadline)
    }
    val identified = elementIds.assign(display, withOwners(lines, deadline))
    return Seen(identified, keyboard, active?.packageName?.toString(), System.currentTimeMillis() <= deadline)
}

internal fun PhoneScreenService.windowsOn(display: Int): List<AccessibilityWindowInfo> = if (display == Display.DEFAULT_DISPLAY) windows else windowsOnAllDisplays.get(display).orEmpty()

internal fun PhoneScreenService.activeRoot(display: Int): AccessibilityNodeInfo? =
    if (display == Display.DEFAULT_DISPLAY) rootInActiveWindow else windowsOn(display).firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }?.root

internal fun PhoneScreenService.describedAt(x: Float, y: Float, scale: Float, display: Int): String {
    val deadline = System.currentTimeMillis() + ELEMENTS_MS
    val px = x.roundToInt()
    val py = y.roundToInt()
    val window = windowsOn(display).firstOrNull { it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD && Rect().also(it::getBoundsInScreen).contains(px, py) }
    val hit = window?.let { smallestAt(it.root, px, py, null, deadline) }
    val point = "at ${(x * scale).roundToInt()},${(y * scale).roundToInt()}"
    if (hit == null) return "$point, where nothing takes a tap"
    val owner = ownerOf(hit, deadline)
    return quoted(labelOf(hit, deadline)) + (if (owner.isEmpty()) "" else " in ${quoted(owner)}") + " " + point
}

internal fun AccessibilityNodeInfo.covers(x: Int, y: Int) = Rect().also(::getBoundsInScreen).contains(x, y)

private fun walk(node: AccessibilityNodeInfo, scale: Float, screen: DisplayMetrics, into: MutableList<Line>, deadline: Long) {
    if (System.currentTimeMillis() > deadline || !node.isVisibleToUser) return
    val bounds = Rect().also(node::getBoundsInScreen)
    if (!bounds.intersect(0, 0, screen.widthPixels, screen.heightPixels)) return
    val clickable = node.isClickable || node.isLongClickable
    val editable = node.isEditable
    val label = if (clickable && !editable) labelOf(node, deadline) else ownLabel(node)
    val role =
        when {
            editable -> "field"
            node.isCheckable -> if (node.isChecked) "checked" else "unchecked"
            clickable -> "button"
            node.isScrollable -> "list"
            label.isEmpty() && node.error.isNullOrEmpty() -> null
            else -> "text"
        }
    if (role != null && !bounds.isEmpty) {
        val named = if (editable) "field ${fieldLabel(if (node.isShowingHintText) "" else node.text?.toString().orEmpty(), node.hintText?.toString().orEmpty(), node.isPassword)}"
            else if (label.isEmpty()) role else "$role ${quoted(label)}"
        val center = "at ${(bounds.exactCenterX() * scale).roundToInt()},${(bounds.exactCenterY() * scale).roundToInt()}"
        val flags =
            listOfNotNull(
                "scrollable".takeIf { node.isScrollable && role != "list" },
                "focused".takeIf { node.isFocused },
                "selected".takeIf { node.isSelected },
                "disabled".takeIf { !node.isEnabled },
                node.stateDescription?.takeIf { it.isNotBlank() }?.let { "state=${quoted(it.toString())}" },
                node.error?.takeIf { it.isNotBlank() }?.let { "error=${quoted(it.toString())}" },
                "invalid".takeIf { node.isContentInvalid },
                "more below".takeIf { node.actionList.contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD) || node.actionList.contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN) },
                node.collectionInfo?.let { "rows=${it.rowCount} columns=${it.columnCount}" },
                node.collectionItemInfo?.let { "row=${it.rowIndex + 1} column=${it.columnIndex + 1}" },
            )
        into.add(Line((listOf(named, center) + flags).joinToString(" "), node, label))
    }
    for (at in 0 until node.childCount) node.getChild(at)?.let { walk(it, scale, screen, into, deadline) }
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
        if (node == null) return@mapIndexed line
        val owner = ownerOf(node, deadline)
        val text = if (owner.isEmpty() || !actionable(node) || (counts[shape] ?: 0) < 2) line.text
            else "$shape in ${quoted(owner)}${line.text.substring(shape.length)}"
        line.copy(text = text, context = owner)
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
