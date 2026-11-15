package dev.geminixiang.pimobile

internal const val MAX_ELEMENTS = 160
internal const val MAX_LABEL = 300
private val SPACES = Regex("\\s+")

internal fun clip(text: String): String {
    val flat = text.replace(SPACES, " ").trim()
    return if (flat.length > MAX_LABEL) flat.take(MAX_LABEL) + "…" else flat
}

internal fun quoted(text: String) = "\"${clip(text).replace("\"", "'")}\""

internal fun fieldLabel(text: String, hint: String, password: Boolean): String =
    (if (text.isEmpty()) "empty" else if (password) "hidden" else quoted(text)) +
        (if (hint.isEmpty()) "" else " hint=${quoted(hint)}")

internal data class ScreenText(val front: String?, val keyboard: Boolean, val lines: List<String>, val complete: Boolean) {
    val more get() = maxOf(0, lines.size - MAX_ELEMENTS)
    val listed get() = lines.take(MAX_ELEMENTS)

    fun changes(before: ScreenText?): Pair<Boolean, String> {
        val full = false to listed.joinToString("\n")
        if (before == null || !complete || !before.complete || front != before.front || keyboard != before.keyboard ||
            lines.filter { it.startsWith("#") } != before.lines.filter { it.startsWith("#") }) return full
        val old = before.listed.toSet()
        val current = listed.toSet()
        val changed = listed.filter { it !in old }
        val ids = listed.map { it.substringBefore(' ') }.toSet()
        val gone = before.listed.filter { it.substringBefore(' ') !in ids }.map { it.substringBefore(' ') }
        if (changed.size + (old - current).size > maxOf(listed.size, before.listed.size) / 2) return full
        return true to (changed + if (gone.isEmpty()) emptyList() else listOf("gone: ${gone.joinToString(", ")}")).joinToString("\n")
    }
}
