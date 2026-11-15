package dev.geminixiang.pimobile

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.Currency

private const val SHOWN_CHARS = 60
private val CURRENCY_CODES: Set<String> by lazy { Currency.getAvailableCurrencies().mapTo(HashSet()) { it.currencyCode } }
private val CODE_WORD = Regex("(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])")
private val GAPS = setOf(' ', ' ', ' ')

internal const val SECRET = "secret"

internal sealed interface MoneyScan {
    data object Clear : MoneyScan
    data class Amount(val shown: String) : MoneyScan
    data object Unread : MoneyScan
}

internal fun ScreenStep.handsOn(): Boolean =
    when (this) {
        is ScreenStep.Tap, is ScreenStep.TapId, is ScreenStep.TapText, is ScreenStep.LongPress, is ScreenStep.Swipe, is ScreenStep.Type, ScreenStep.Clear -> true
        is ScreenStep.Press -> key == "enter"
        else -> false
    }

internal fun PhoneScreenService.moneyOn(display: Int, deadline: Long): MoneyScan {
    val roots = windowsOn(display)
        .filter { it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD && it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY }
        .mapNotNull { it.root }
    for (root in roots) {
        val found = amountUnder(root, deadline)
        if (found != MoneyScan.Clear) return found
    }
    return MoneyScan.Clear
}

private fun amountUnder(node: AccessibilityNodeInfo, deadline: Long): MoneyScan {
    if (System.currentTimeMillis() > deadline) return MoneyScan.Unread
    if (!node.isVisibleToUser) return MoneyScan.Clear
    listOfNotNull(node.text, node.contentDescription).map(CharSequence::toString).firstOrNull(::showsAmount)
        ?.let { return MoneyScan.Amount(it.trim().take(SHOWN_CHARS)) }
    for (at in 0 until node.childCount) {
        val found = node.getChild(at)?.let { amountUnder(it, deadline) } ?: continue
        if (found != MoneyScan.Clear) return found
    }
    return MoneyScan.Clear
}

private fun showsAmount(text: String): Boolean {
    val symbol = text.indices.any { at -> Character.getType(text[at]) == Character.CURRENCY_SYMBOL.toInt() && digitBeside(text, at, at + 1) }
    return symbol || CODE_WORD.findAll(text).any { it.value in CURRENCY_CODES && digitBeside(text, it.range.first, it.range.last + 1) }
}

private fun digitBeside(text: String, start: Int, end: Int): Boolean {
    val after = text.getOrNull(end)?.let { if (it in GAPS) text.getOrNull(end + 1) else it }
    val before = text.getOrNull(start - 1)?.let { if (it in GAPS) text.getOrNull(start - 2) else it }
    return after?.isDigit() == true || before?.isDigit() == true
}
