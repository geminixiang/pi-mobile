package dev.geminixiang.pimobile

import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import android.webkit.WebView
import org.json.JSONObject

private const val SETTLE_MS = 400L
private const val WAIT_FOR_POLL_MS = 250L
private const val OK = "\"ok\""
private const val INSERT = "((t) => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('insertText', false, t); return 'ok'; })(%s)"
private const val CLEAR = "(() => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; })()"
private const val HAS_TEXT = "(document.body ? document.body.innerText : '').includes(%s)"
private val NO_FOCUS = Outcome.Stopped("no field has focus: tap the field first")
private val KEY_CODES = mapOf("enter" to KeyEvent.KEYCODE_ENTER, "tab" to KeyEvent.KEYCODE_TAB, "escape" to KeyEvent.KEYCODE_ESCAPE, "backspace" to KeyEvent.KEYCODE_DEL)

internal sealed interface Step {
    data class Open(val url: String) : Step

    data class Tap(val index: Int) : Step

    data class TapAt(val x: Double, val y: Double) : Step

    data class Type(val index: Int, val text: String) : Step

    data class TypeHere(val text: String) : Step

    data object Clear : Step

    data class Select(val index: Int, val option: String) : Step

    data class Press(val code: Int) : Step

    data class Scroll(val direction: String, val index: Int?) : Step

    data object Back : Step

    data object Forward : Step

    data object Reload : Step

    data class Wait(val ms: Long) : Step

    data class WaitFor(val text: String, val gone: Boolean, val ms: Long) : Step

    companion object {
        fun of(json: JSONObject): Step =
            when (val action = json.getString("action")) {
                "open" -> Open(json.getString("url"))
                "tap" -> Tap(json.getInt("index"))
                "tap_at" -> TapAt(json.getDouble("x"), json.getDouble("y"))
                "type" -> Type(json.getInt("index"), json.getString("text"))
                "type_here" -> TypeHere(json.getString("text"))
                "clear" -> Clear
                "select" -> Select(json.getInt("index"), json.getString("option"))
                "key" -> Press(KEY_CODES.getValue(json.getString("key")))
                "scroll" -> Scroll(json.getString("direction"), null)
                "scroll_in" -> Scroll(json.getString("direction"), json.getInt("index"))
                "back" -> Back
                "forward" -> Forward
                "reload" -> Reload
                "wait" -> Wait(json.getLong("ms"))
                "wait_for" -> WaitFor(json.getString("text"), json.getBoolean("gone"), json.getLong("ms"))
                else -> throw IllegalArgumentException("unknown action $action")
            }
    }
}

internal fun BrowserTab.perform(step: Step): Outcome<String?> {
    when (step) {
        is Step.Open -> {
            if (!WebPages.isWeb(Uri.parse(step.url))) return Outcome.Stopped("url must be http or https")
            navigate { loadUrl(step.url) }
        }
        Step.Reload -> navigate { reload() }
        is Step.Tap -> {
            val target = tapElement(step.index).valueOr { return it }
            settle()
            return Outcome.Ok("tapped $target")
        }
        is Step.TapAt -> {
            val scale = eval("devicePixelRatio").valueOr { return it }.toFloat()
            tap(step.x.toFloat() * scale, step.y.toFloat() * scale)
            settle()
        }
        is Step.Type -> {
            val target = tapElement(step.index).valueOr { return it }
            Thread.sleep(SETTLE_MS)
            insert(step.text).valueOr { return it }
            return Outcome.Ok("typed into $target")
        }
        is Step.TypeHere -> insert(step.text).valueOr { return it }
        Step.Clear -> if (eval(CLEAR).valueOr { return it } != OK) return NO_FOCUS
        is Step.Select -> {
            callPage("window.__piPage.select(${step.index}, ${JSONObject.quote(step.option)})").valueOr { return it }
            Thread.sleep(SETTLE_MS)
        }
        is Step.Press -> {
            press(step.code)
            settle()
        }
        is Step.Scroll -> {
            val inside = step.index?.let { ", $it" }.orEmpty()
            callPage("window.__piPage.scroll(${JSONObject.quote(step.direction)}$inside)").valueOr { return it }
            Thread.sleep(SETTLE_MS)
        }
        Step.Back -> {
            if (!onMain { view.canGoBack().also { if (it) view.goBack() } }) return Outcome.Stopped("there is no page to go back to")
            settle()
        }
        Step.Forward -> {
            if (!onMain { view.canGoForward().also { if (it) view.goForward() } }) return Outcome.Stopped("there is no page to go forward to")
            settle()
        }
        is Step.Wait -> Thread.sleep(step.ms)
        is Step.WaitFor -> return waitFor(step)
    }
    return Outcome.Ok(null)
}

private fun BrowserTab.navigate(go: WebView.() -> Unit) {
    loading = true
    onMain { view.go() }
    settle()
}

private fun BrowserTab.settle() {
    Thread.sleep(SETTLE_MS)
    awaitLoad()
    Thread.sleep(SETTLE_MS)
}

private fun BrowserTab.tapElement(index: Int): Outcome<String> {
    val center = callPage("window.__piPage.center($index)").valueOr { return it }
    tap(center.getDouble("x").toFloat(), center.getDouble("y").toFloat())
    return Outcome.Ok("[$index] ${center.optString("what")}")
}

private fun BrowserTab.insert(text: String): Outcome<Unit> {
    if (eval(INSERT.format(JSONObject.quote(text))).valueOr { return it } != OK) return NO_FOCUS
    return Outcome.Ok(Unit)
}

private fun BrowserTab.waitFor(step: Step.WaitFor): Outcome<String?> {
    val end = SystemClock.uptimeMillis() + step.ms
    val probe = HAS_TEXT.format(JSONObject.quote(step.text))
    while (true) {
        val there = eval(probe).valueOr { return it } == "true"
        if (there != step.gone) return Outcome.Ok(null)
        if (SystemClock.uptimeMillis() >= end) {
            val still = if (step.gone) "is still on the page" else "did not appear"
            return Outcome.Stopped("waited ${step.ms / 1000} s and ${JSONObject.quote(step.text)} $still")
        }
        Thread.sleep(WAIT_FOR_POLL_MS)
    }
}
