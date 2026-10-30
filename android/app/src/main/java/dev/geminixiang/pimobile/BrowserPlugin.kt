package dev.geminixiang.pimobile

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Outline
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dev.geminixiang.pimobile.Background.Failure
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject

private const val DEFAULT_WIDTH = 1080
private const val DEFAULT_HEIGHT = 2100
private const val IDLE_MS = 15 * 60_000L
private const val FADE_MS = 140L
private const val MAX_TABS = 8
private const val PREFS = "browser"
private const val FORGOTTEN_KEY = "forgotten"
private const val TABS_KEY = "tabs:"
private const val FACTS = "({ ready: document.readyState, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000) })"

internal class Placement(val params: FrameLayout.LayoutParams, val radius: Float)

internal class BotTabs(val bot: String) {
    val open = LinkedHashMap<String, BrowserTab>()
    var active: String? = null
    var next = 1
    var shownAt: Placement? = null
    var width = DEFAULT_WIDTH
    var height = DEFAULT_HEIGHT
}

@CapacitorPlugin(name = "Browser")
class BrowserPlugin : Plugin() {
    private val work = Executors.newCachedThreadPool()
    private val bots = ConcurrentHashMap<String, BotTabs>()
    private val prefs: SharedPreferences get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @PluginMethod
    fun read(call: PluginCall) = Background.run(work, call) { call.resolve(snapshot(tabOf(call), call.data.optBoolean("screenshot"), null)) }

    @PluginMethod
    fun act(call: PluginCall) =
        Background.run(work, call) {
            val tab = tabOf(call)
            val steps = call.data.getJSONArray("steps")
            val did = mutableListOf<String>()
            var stopped: String? = null
            for (at in 0 until steps.length()) {
                val json = steps.getJSONObject(at)
                tab.waitForUser()
                when (val ran = tab.perform(Step.of(json))) {
                    is Outcome.Ok -> ran.value?.let(did::add)
                    is Outcome.Stopped -> {
                        stopped = "step ${at + 1} (${json.getString("action")}): ${ran.reason}"
                        break
                    }
                }
            }
            val result = snapshot(tab, call.data.optBoolean("screenshot"), stopped)
            if (did.isNotEmpty()) result.put("did", JSONArray(did))
            call.resolve(result)
        }

    @PluginMethod
    fun go(call: PluginCall) =
        Background.run(work, call) {
            val tab = tabOf(call)
            val url = call.data.optString("url")
            when (call.data.optString("action")) {
                "open" -> {
                    if (!WebPages.isWeb(Uri.parse(url))) throw Failure("invalid", "url must be http or https")
                    onMain { tab.view.loadUrl(url) }
                }
                "back" -> onMain { if (tab.view.canGoBack()) tab.view.goBack() }
                "forward" -> onMain { if (tab.view.canGoForward()) tab.view.goForward() }
                "reload" -> onMain { tab.view.reload() }
                else -> throw Failure("invalid", "action is back, forward, reload, or open")
            }
            call.resolve()
        }

    @PluginMethod
    fun show(call: PluginCall) =
        Background.run(work, call) {
            val tab = tabOf(call)
            val tabs = tab.owner
            val density = context.resources.displayMetrics.density
            val dp = { name: String -> (call.data.getDouble(name) * density).roundToInt() }
            onMain {
                val root = activity.findViewById<ViewGroup>(android.R.id.content)
                val from = IntArray(2).also(bridge.webView::getLocationInWindow)
                val to = IntArray(2).also(root::getLocationInWindow)
                tabs.width = maxOf(1, dp("width"))
                tabs.height = maxOf(1, dp("height"))
                val params =
                    FrameLayout.LayoutParams(tabs.width, tabs.height).apply {
                        leftMargin = from[0] - to[0] + dp("x")
                        topMargin = from[1] - to[1] + dp("y")
                    }
                val placement = Placement(params, call.data.getDouble("radius").toFloat() * density)
                tabs.shownAt = placement
                attach(tab, placement, fade = true)
            }
            call.resolve()
        }

    @PluginMethod
    fun hide(call: PluginCall) =
        Background.run(work, call) {
            val tabs = bots[call.data.optString("bot")]
            if (tabs != null) {
                onMain {
                    tabs.shownAt = null
                    tabs.open.values.forEach(::park)
                }
            }
            call.resolve()
        }

    @PluginMethod
    fun peek(call: PluginCall) =
        Background.run(work, call) {
            val tabs = bots[call.data.optString("bot")]
            val tab = tabs?.active?.let { tabs.open[it] }
            call.resolve(JSObject().apply { if (tab != null) put("jpeg", tab.capture()) })
        }

    @PluginMethod
    fun forget(call: PluginCall) =
        Background.run(work, call) {
            val bot = call.data.optString("bot")
            val tabs = bots.remove(bot)
            prefs.edit().remove(TABS_KEY + bot).apply()
            onMain {
                tabs?.open?.values?.forEach(::destroy)
                tabs?.open?.clear()
            }
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return@run call.resolve()
            val deleted =
                onMain {
                    val profile = ProfileStore.getInstance().getProfile(profileOf(bot))
                    profile?.cookieManager?.removeAllCookies(null)
                    profile?.cookieManager?.flush()
                    profile?.webStorage?.deleteAllData()
                    deleteProfile(profileOf(bot))
                }
            // why: Chromium keeps a profile loaded for the rest of the process once a WebView used it, so it is deleted at the next start
            if (!deleted) prefs.edit().putStringSet(FORGOTTEN_KEY, prefs.getStringSet(FORGOTTEN_KEY, emptySet()).orEmpty() + profileOf(bot)).apply()
            call.resolve()
        }

    @PluginMethod
    fun newTab(call: PluginCall) =
        Background.run(work, call) {
            val tabs = botTabs(call)
            val tab =
                onMain {
                    restore(tabs)
                    if (tabs.open.size >= MAX_TABS) throw Failure("too_many", "a Bot keeps at most $MAX_TABS tabs; close one first")
                    create(tabs).also { select(tabs, it.id) }
                }
            call.resolve(JSObject().put("tab", tab.id))
        }

    @PluginMethod
    fun selectTab(call: PluginCall) =
        Background.run(work, call) {
            val tabs = botTabs(call)
            val id = call.data.optString("tab")
            onMain {
                restore(tabs)
                if (id !in tabs.open) throw Failure("no_tab", "tab $id is not open")
                select(tabs, id)
            }
            call.resolve()
        }

    @PluginMethod
    fun closeTab(call: PluginCall) =
        Background.run(work, call) {
            val tabs = botTabs(call)
            val id = call.data.optString("tab")
            onMain {
                restore(tabs)
                if (id !in tabs.open) throw Failure("no_tab", "tab $id is not open")
                close(tabs, id)
            }
            call.resolve()
        }

    @PluginMethod
    fun tabs(call: PluginCall) =
        Background.run(work, call) {
            val bot = call.data.optString("bot")
            val tabs = bots[bot]
            val saved = JSONArray(prefs.getString(TABS_KEY + bot, "[]"))
            call.resolve(onMain { if (tabs == null || tabs.open.isEmpty()) savedListing(bot, saved) else listing(tabs) })
        }

    override fun load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val left = prefs.getStringSet(FORGOTTEN_KEY, emptySet()).orEmpty().filterNot(::deleteProfile).toSet()
        prefs.edit().putStringSet(FORGOTTEN_KEY, left).apply()
    }

    override fun handleOnPause() {
        super.handleOnPause()
        for (tabs in bots.values) tabs.open.values.forEach(BrowserTab::flushCookies)
    }

    private fun deleteProfile(name: String): Boolean {
        val store = ProfileStore.getInstance()
        if (store.getProfile(name) == null) return true
        return try {
            store.deleteProfile(name)
            true
        } catch (inUse: IllegalStateException) {
            false
        }
    }

    private fun botTabs(call: PluginCall): BotTabs {
        val bot = call.data.optString("bot")
        if (bot.isEmpty()) throw Failure("invalid", "bot is required")
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            throw Failure("unsupported", "this phone's WebView cannot keep a separate browser per Bot; update Android System WebView")
        }
        return bots.computeIfAbsent(bot, ::BotTabs)
    }

    private fun tabOf(call: PluginCall): BrowserTab {
        val tabs = botTabs(call)
        val wanted: String? = call.getString("tab")
        return onMain {
            restore(tabs)
            val existing = (wanted ?: tabs.active)?.let { tabs.open[it] }
            if (existing == null && wanted != null) throw Failure("no_tab", "tab $wanted is not open; open tabs: ${tabs.open.keys.joinToString(", ")}")
            val tab = existing ?: create(tabs)
            mainHandler.removeCallbacks(tab.expire)
            mainHandler.postDelayed(tab.expire, IDLE_MS)
            tab
        }
    }

    private fun savedListing(bot: String, urls: JSONArray): JSObject {
        val list = JSArray()
        for (at in 0 until urls.length()) list.put(JSObject().put("id", (at + 1).toString()).put("url", urls.optString(at)).put("title", ""))
        return JSObject().put("bot", bot).put("tabs", list).apply { if (urls.length() > 0) put("active", "1") }
    }

    private fun listing(tabs: BotTabs): JSObject {
        val list = JSArray()
        for (tab in tabs.open.values) list.put(JSObject().put("id", tab.id).put("url", tab.view.url.orEmpty()).put("title", tab.view.title.orEmpty()))
        return JSObject().put("bot", tabs.bot).put("tabs", list).apply { tabs.active?.let { put("active", it) } }
    }

    private fun announceTabs(tabs: BotTabs) {
        remember(tabs)
        notifyListeners("tabs", listing(tabs))
    }

    private fun announce(tab: BrowserTab) {
        val page =
            JSObject()
                .put("bot", tab.owner.bot)
                .put("tab", tab.id)
                .put("url", tab.view.url.orEmpty())
                .put("title", tab.view.title.orEmpty())
                .put("loading", tab.loading)
                .put("canGoBack", tab.view.canGoBack())
                .put("canGoForward", tab.view.canGoForward())
        notifyListeners("page", page)
        if (!tab.loading) remember(tab.owner)
    }

    private fun remember(tabs: BotTabs) {
        val urls = JSONArray(tabs.open.values.map { it.view.url.orEmpty() })
        prefs.edit().putString(TABS_KEY + tabs.bot, urls.toString()).apply()
    }

    private fun restore(tabs: BotTabs) {
        if (tabs.open.isNotEmpty()) return
        val urls = JSONArray(prefs.getString(TABS_KEY + tabs.bot, "[]"))
        tabs.next = 1
        for (at in 0 until urls.length()) {
            val tab = create(tabs)
            val url = urls.getString(at)
            if (!WebPages.isWeb(Uri.parse(url))) continue
            tab.loading = true
            tab.view.loadUrl(url)
        }
        prefs.edit().putString(TABS_KEY + tabs.bot, urls.toString()).apply()
    }

    private fun create(tabs: BotTabs): BrowserTab {
        val tab = BrowserTab(tabs, (tabs.next++).toString(), context, activity.window, ::announce, ::expire)
        tabs.open[tab.id] = tab
        if (tabs.active == null) tabs.active = tab.id
        mainHandler.postDelayed(tab.expire, IDLE_MS)
        announceTabs(tabs)
        return tab
    }

    private fun expire(tab: BrowserTab) {
        val tabs = tab.owner
        if (tabs.shownAt != null && tab.id == tabs.active) return
        val saved = prefs.getString(TABS_KEY + tabs.bot, null)
        close(tabs, tab.id)
        if (tabs.open.isEmpty() && saved != null) prefs.edit().putString(TABS_KEY + tabs.bot, saved).apply()
    }

    private fun select(tabs: BotTabs, id: String) {
        tabs.active = id
        val next = tabs.open[id]
        val placement = tabs.shownAt
        if (placement != null && next != null) attach(next, placement, fade = false)
        announceTabs(tabs)
        if (next != null) announce(next)
    }

    private fun close(tabs: BotTabs, id: String) {
        val tab = tabs.open.remove(id) ?: return
        destroy(tab)
        if (id != tabs.active) return announceTabs(tabs)
        tabs.active = null
        val last = tabs.open.keys.lastOrNull() ?: return announceTabs(tabs)
        select(tabs, last)
    }

    private fun park(tab: BrowserTab) {
        tab.view.detach()
        tab.layOut()
        mainHandler.removeCallbacks(tab.expire)
        mainHandler.postDelayed(tab.expire, IDLE_MS)
    }

    private fun destroy(tab: BrowserTab) {
        mainHandler.removeCallbacks(tab.expire)
        tab.view.detach()
        tab.view.destroy()
    }

    private fun attach(tab: BrowserTab, placement: Placement, fade: Boolean) {
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        tab.view.outlineProvider =
            object : ViewOutlineProvider() {
                override fun getOutline(outlined: View, outline: Outline) {
                    // why: the round rect starts one radius above the view, so only the bottom corners are rounded, where the sheet's own corners are
                    outline.setRoundRect(0, (-placement.radius).roundToInt(), outlined.width, outlined.height, placement.radius)
                }
            }
        tab.view.clipToOutline = true
        mainHandler.removeCallbacks(tab.expire)
        for (other in tab.owner.open.values) if (other !== tab && other.view.parent != null) park(other)
        if (tab.view.parent === root) {
            tab.view.layoutParams = placement.params
            return
        }
        tab.view.detach()
        tab.view.alpha = if (fade) 0f else 1f
        root.addView(tab.view, placement.params)
        if (fade) tab.view.animate().alpha(1f).setDuration(FADE_MS).start()
    }

    private fun snapshot(tab: BrowserTab, screenshot: Boolean, error: String?): JSObject {
        tab.awaitLoad()
        val facts = JSONObject(tab.eval(FACTS).valueOr { throw Failure("timeout", it.reason) })
        val state = tab.callPage("window.__piPage.state()").valueOr { throw Failure("page", it.reason) }
        val dialog = tab.takeDialog()
        val text = facts.optString("text")
        return JSObject().apply {
            put("tab", tab.id)
            put("loading", tab.loading || facts.optString("ready") != "complete")
            put("elements", "${state.optString("header")}\n${state.optString("content")}\n${state.optString("footer")}")
            put("tabs", onMain { listing(tab.owner) }.getJSONArray("tabs"))
            put("text", if (dialog == null) text else "[The page showed a dialog: $dialog]\n$text")
            if (screenshot) put("jpeg", tab.capture())
            if (error != null) put("error", error)
        }
    }
}
