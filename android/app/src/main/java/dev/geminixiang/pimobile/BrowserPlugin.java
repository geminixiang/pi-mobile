package dev.geminixiang.pimobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import dev.geminixiang.pimobile.Background.Failure;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "Browser")
public class BrowserPlugin extends Plugin {

    private static final int DEFAULT_WIDTH = 1080;
    private static final int DEFAULT_HEIGHT = 2100;
    private static final long LOAD_MS = 15_000;
    private static final long SETTLE_MS = 400;
    private static final long IDLE_MS = 15 * 60_000;
    private static final long USER_QUIET_MS = 4_000;
    private static final long USER_WAIT_MS = 60_000;
    private static final long WAIT_FOR_MS = 8_000;
    private static final long WAIT_FOR_MAX_MS = 20_000;
    private static final long WAIT_MAX_MS = 10_000;
    private static final int MAX_TABS = 8;
    private static final String PREFS = "browser";
    private static final String FORGOTTEN_KEY = "forgotten";
    private static final String TABS_KEY = "tabs:";

    private static final String FACTS = "({ ready: document.readyState, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000) })";
    private static final String PAGE_SCRIPT = "public/page-controller.js";
    private static final long ASYNC_MS = 15_000;
    private static final long ANSWER_SECONDS = 10;
    private static final String ANSWER_CHANNEL = "piAnswer";
    private static final String ASYNC = "(() => { if (typeof window.__piPage !== 'object') return 'missing'; const answer = (result) => %s.postMessage(%s + '\\n' + JSON.stringify(result)); Promise.resolve().then(() => %s).then((value) => answer({ ok: value ?? {} }), (failure) => answer({ error: String((failure && failure.message) || failure) })); return 'started'; })()";

    private static final String INSERT = "((t) => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('insertText', false, t); return 'ok'; })(%s)";
    private static final String CLEAR = "(() => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; })()";
    private static final String HAS_TEXT = "(document.body ? document.body.innerText : '').includes(%s)";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final Map<String, Tabs> bots = new ConcurrentHashMap<>();
    private final AtomicLong asyncKeys = new AtomicLong();
    private final Map<String, CompletableFuture<String>> answers = new ConcurrentHashMap<>();
    private volatile String pageScript;

    private final class Tabs {
        final String bot;
        final Map<String, Session> open = new LinkedHashMap<>();
        String active;
        int next = 1;
        boolean shown;
        FrameLayout.LayoutParams placed;
        float radius;
        int width = DEFAULT_WIDTH;
        int height = DEFAULT_HEIGHT;

        Tabs(String bot) {
            this.bot = bot;
        }
    }

    private final class Session {
        final Tabs owner;
        final String tab;
        final WebView view;
        volatile boolean loading;
        volatile long lastUserTouch;
        volatile boolean injecting;
        boolean agentTouched;
        volatile String dialog;
        final Runnable expire;

        Session(Tabs owner, String tab, WebView view) {
            this.owner = owner;
            this.tab = tab;
            this.view = view;
            this.expire = () -> {
                if (owner.shown && tab.equals(owner.active)) return;
                String saved = prefs().getString(TABS_KEY + owner.bot, null);
                close(owner, tab);
                if (owner.open.isEmpty() && saved != null) prefs().edit().putString(TABS_KEY + owner.bot, saved).apply();
            };
        }
    }

    private static String profileOf(String bot) {
        return "bot-" + bot;
    }

    @PluginMethod
    public void read(PluginCall call) {
        Background.run(work, call, () -> {
            Session session = session(call);
            call.resolve(snapshot(session, call.getBoolean("screenshot", false), null));
        });
    }

    @PluginMethod
    public void act(PluginCall call) {
        Background.run(work, call, () -> {
            Session session = session(call);
            JSArray steps = call.getArray("steps", new JSArray());
            boolean screenshot = call.getBoolean("screenshot", false);
            List<String> did = new ArrayList<>();
            String error = null;
            for (int i = 0; i < steps.length() && error == null; i++) {
                JSONObject step = steps.getJSONObject(i);
                try {
                    waitForUser(session);
                    String touched = run(session, step);
                    if (touched != null) did.add(touched);
                } catch (Failure failure) {
                    error = "step " + (i + 1) + " (" + step.optString("action") + "): " + failure.getMessage();
                }
            }
            JSObject result = snapshot(session, screenshot, error);
            if (!did.isEmpty()) result.put("did", new JSONArray(did));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        Background.run(work, call, () -> {
            Session session = session(call);
            Tabs tabs = session.owner;
            float density = getContext().getResources().getDisplayMetrics().density;
            onMain(() -> {
                View bridge = getBridge().getWebView();
                ViewGroup root = getActivity().findViewById(android.R.id.content);
                int[] from = new int[2];
                int[] to = new int[2];
                bridge.getLocationInWindow(from);
                root.getLocationInWindow(to);
                tabs.width = Math.max(1, Math.round(call.getFloat("width", 0f) * density));
                tabs.height = Math.max(1, Math.round(call.getFloat("height", 0f) * density));
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(tabs.width, tabs.height);
                params.leftMargin = from[0] - to[0] + Math.round(call.getFloat("x", 0f) * density);
                params.topMargin = from[1] - to[1] + Math.round(call.getFloat("y", 0f) * density);
                tabs.placed = params;
                tabs.radius = call.getFloat("radius", 0f) * density;
                tabs.shown = true;
                attach(session, true);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = bots.get(call.getString("bot", ""));
            if (tabs != null) onMain(() -> {
                tabs.shown = false;
                for (Session session : tabs.open.values()) park(session);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void peek(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = bots.get(call.getString("bot", ""));
            Session session = tabs == null || tabs.active == null ? null : tabs.open.get(tabs.active);
            JSObject out = new JSObject();
            if (session != null) out.put("jpeg", capture(session));
            call.resolve(out);
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        Background.run(work, call, () -> {
            String bot = call.getString("bot", "");
            Tabs tabs = bots.remove(bot);
            prefs().edit().remove(TABS_KEY + bot).apply();
            onMain(() -> {
                if (tabs != null) {
                    for (Session session : tabs.open.values()) destroy(session);
                    tabs.open.clear();
                }
                return null;
            });
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                call.resolve();
                return;
            }
            boolean deleted = onMain(() -> {
                ProfileStore store = ProfileStore.getInstance();
                Profile profile = store.getProfile(profileOf(bot));
                if (profile == null) return true;
                profile.getCookieManager().removeAllCookies(null);
                profile.getCookieManager().flush();
                profile.getWebStorage().deleteAllData();
                try {
                    store.deleteProfile(profileOf(bot));
                    return true;
                } catch (IllegalStateException inUse) {
                    return false;
                }
            });
            // why: Chromium keeps a profile loaded for the rest of the process once a WebView used it, so it is deleted at the next start
            if (!deleted) prefs().edit().putStringSet(FORGOTTEN_KEY, with(prefs().getStringSet(FORGOTTEN_KEY, Set.of()), profileOf(bot))).apply();
            call.resolve();
        });
    }

    @Override
    public void load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        Set<String> left = new HashSet<>();
        for (String name : prefs().getStringSet(FORGOTTEN_KEY, Set.of())) {
            ProfileStore store = ProfileStore.getInstance();
            if (store.getProfile(name) == null) continue;
            try {
                store.deleteProfile(name);
            } catch (IllegalStateException inUse) {
                left.add(name);
            }
        }
        prefs().edit().putStringSet(FORGOTTEN_KEY, left).apply();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static Set<String> with(Set<String> names, String name) {
        Set<String> next = new HashSet<>(names);
        next.add(name);
        return next;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        for (Tabs tabs : bots.values()) for (Session session : tabs.open.values()) flush(session);
    }

    private Tabs tabsOf(PluginCall call) throws Failure {
        String bot = call.getString("bot", "");
        if (bot.isEmpty()) throw new Failure("invalid", "bot is required");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            throw new Failure("unsupported", "this phone's WebView cannot keep a separate browser per Bot; update Android System WebView");
        }
        return bots.computeIfAbsent(bot, Tabs::new);
    }

    private Session session(PluginCall call) throws Exception {
        Tabs tabs = tabsOf(call);
        String tab = call.getString("tab", null);
        return onMain(() -> {
            restore(tabs);
            String wanted = tab != null ? tab : tabs.active;
            Session existing = wanted == null ? null : tabs.open.get(wanted);
            if (existing == null && tab != null) throw new Failure("no_tab", "tab " + tab + " is not open; open tabs: " + String.join(", ", tabs.open.keySet()));
            Session session = existing != null ? existing : create(tabs, String.valueOf(tabs.next++));
            main.removeCallbacks(session.expire);
            main.postDelayed(session.expire, IDLE_MS);
            return session;
        });
    }

    @PluginMethod
    public void newTab(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = tabsOf(call);
            Session session = onMain(() -> {
                restore(tabs);
                if (tabs.open.size() >= MAX_TABS) throw new Failure("too_many", "a Bot keeps at most " + MAX_TABS + " tabs; close one first");
                Session created = create(tabs, String.valueOf(tabs.next++));
                select(tabs, created.tab);
                return created;
            });
            JSObject out = new JSObject();
            out.put("tab", session.tab);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void selectTab(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = tabsOf(call);
            String tab = call.getString("tab", "");
            onMain(() -> {
                restore(tabs);
                if (!tabs.open.containsKey(tab)) throw new Failure("no_tab", "tab " + tab + " is not open");
                select(tabs, tab);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void closeTab(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = tabsOf(call);
            String tab = call.getString("tab", "");
            onMain(() -> {
                restore(tabs);
                if (!tabs.open.containsKey(tab)) throw new Failure("no_tab", "tab " + tab + " is not open");
                close(tabs, tab);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void tabs(PluginCall call) {
        Background.run(work, call, () -> {
            String bot = call.getString("bot", "");
            Tabs tabs = bots.get(bot);
            JSONArray saved = new JSONArray(prefs().getString(TABS_KEY + bot, "[]"));
            call.resolve(onMain(() -> tabs == null || tabs.open.isEmpty() ? savedListing(bot, saved) : listing(tabs, bot)));
        });
    }

    private static JSObject savedListing(String bot, JSONArray urls) {
        JSObject out = new JSObject();
        JSArray list = new JSArray();
        for (int i = 0; i < urls.length(); i++) {
            JSObject item = new JSObject();
            item.put("id", String.valueOf(i + 1));
            item.put("url", urls.optString(i));
            item.put("title", "");
            list.put(item);
        }
        if (urls.length() > 0) out.put("active", "1");
        out.put("bot", bot);
        out.put("tabs", list);
        return out;
    }

    private JSObject listing(Tabs tabs, String bot) {
        JSObject out = new JSObject();
        JSArray list = new JSArray();
        if (tabs != null) {
            for (Session session : tabs.open.values()) {
                JSObject item = new JSObject();
                item.put("id", session.tab);
                item.put("url", orEmpty(session.view.getUrl()));
                item.put("title", orEmpty(session.view.getTitle()));
                list.put(item);
            }
            if (tabs.active != null) out.put("active", tabs.active);
        }
        out.put("bot", bot);
        out.put("tabs", list);
        return out;
    }

    private void announceTabs(Tabs tabs) {
        remember(tabs);
        notifyListeners("tabs", listing(tabs, tabs.bot));
    }

    private void remember(Tabs tabs) {
        JSONArray urls = new JSONArray();
        for (Session session : tabs.open.values()) urls.put(orEmpty(session.view.getUrl()));
        prefs().edit().putString(TABS_KEY + tabs.bot, urls.toString()).apply();
    }

    private void restore(Tabs tabs) throws JSONException {
        if (!tabs.open.isEmpty()) return;
        JSONArray urls = new JSONArray(prefs().getString(TABS_KEY + tabs.bot, "[]"));
        tabs.next = 1;
        for (int i = 0; i < urls.length(); i++) {
            Session session = create(tabs, String.valueOf(tabs.next++));
            String url = urls.getString(i);
            if (!WebPages.isWeb(Uri.parse(url))) continue;
            session.loading = true;
            session.view.loadUrl(url);
        }
        prefs().edit().putString(TABS_KEY + tabs.bot, urls.toString()).apply();
    }

    private void select(Tabs tabs, String tab) {
        tabs.active = tab;
        Session next = tabs.open.get(tab);
        if (tabs.shown && next != null) attach(next, false);
        announceTabs(tabs);
        if (next != null) announce(next);
    }

    private void close(Tabs tabs, String tab) {
        Session session = tabs.open.remove(tab);
        if (session == null) return;
        destroy(session);
        if (!tab.equals(tabs.active)) {
            announceTabs(tabs);
            return;
        }
        tabs.active = null;
        String last = tabs.open.keySet().stream().reduce((first, second) -> second).orElse(null);
        if (last == null) announceTabs(tabs);
        else select(tabs, last);
    }

    private void park(Session session) {
        if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
        layOut(session);
        main.removeCallbacks(session.expire);
        main.postDelayed(session.expire, IDLE_MS);
    }

    private void destroy(Session session) {
        main.removeCallbacks(session.expire);
        if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
        session.view.destroy();
    }

    private void attach(Session session, boolean fade) {
        Tabs tabs = session.owner;
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        float radius = tabs.radius;
        session.view.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View outlined, Outline outline) {
                // why: the round rect starts one radius above the view, so only the bottom corners are rounded, where the sheet's own corners are
                outline.setRoundRect(0, Math.round(-radius), outlined.getWidth(), outlined.getHeight(), radius);
            }
        });
        session.view.setClipToOutline(true);
        for (Session other : tabs.open.values()) {
            if (other != session && other.view.getParent() != null) park(other);
        }
        if (session.view.getParent() != root) {
            if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
            session.view.setAlpha(fade ? 0f : 1f);
            root.addView(session.view, tabs.placed);
            if (fade) session.view.animate().alpha(1f).setDuration(140).start();
        } else {
            session.view.setLayoutParams(tabs.placed);
        }
        main.removeCallbacks(session.expire);
    }

    @SuppressLint("ClickableViewAccessibility")
    private Session create(Tabs tabs, String id) {
        String bot = tabs.bot;
        ProfileStore.getInstance().getOrCreateProfile(profileOf(bot));
        WebView view = WebPages.create(getContext());
        WebViewCompat.setProfile(view, profileOf(bot));
        Session session = new Session(tabs, id, view);
        WebViewCompat.addWebMessageListener(view, ANSWER_CHANNEL, Set.of("*"), (webView, message, origin, mainFrame, reply) -> {
            String data = message.getData();
            int cut = data == null ? -1 : data.indexOf('\n');
            if (cut < 0) return;
            CompletableFuture<String> waiting = answers.remove(data.substring(0, cut));
            if (waiting != null) waiting.complete(data.substring(cut + 1));
        });
        view.setWebViewClient(new WebPages.WebOnly() {
            @Override
            public void onPageStarted(WebView webView, String url, Bitmap favicon) {
                session.loading = true;
                announce(session);
            }

            @Override
            public void onPageFinished(WebView webView, String url) {
                session.loading = false;
                flush(session);
                announce(session);
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView webView, String title) {
                announce(session);
            }

            @Override
            public boolean onJsAlert(WebView webView, String url, String message, JsResult result) {
                session.dialog = "alert: " + message;
                result.confirm();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView webView, String url, String message, JsResult result) {
                session.dialog = "confirm, answered cancel: " + message;
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView webView, String url, String message, String defaultValue, JsPromptResult result) {
                session.dialog = "prompt, answered cancel: " + message;
                result.cancel();
                return true;
            }
        });
        view.setOnTouchListener((touched, event) -> {
            session.agentTouched = session.injecting;
            if (!session.injecting) session.lastUserTouch = SystemClock.uptimeMillis();
            return false;
        });
        ViewCompat.setWindowInsetsAnimationCallback(view, new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            @Override
            public void onPrepare(WindowInsetsAnimationCompat animation) {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(view);
                boolean opening = insets != null && !insets.isVisible(WindowInsetsCompat.Type.ime()) && (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
                if (opening && session.agentTouched && view.hasFocus()) WindowCompat.getInsetsController(getActivity().getWindow(), view).hide(WindowInsetsCompat.Type.ime());
            }

            @Override
            public WindowInsetsCompat onProgress(WindowInsetsCompat insets, List<WindowInsetsAnimationCompat> running) {
                return insets;
            }
        });
        layOut(session);
        tabs.open.put(session.tab, session);
        if (tabs.active == null) tabs.active = session.tab;
        main.postDelayed(session.expire, IDLE_MS);
        announceTabs(tabs);
        return session;
    }

    private void announce(Session session) {
        JSObject page = new JSObject();
        page.put("bot", session.owner.bot);
        page.put("tab", session.tab);
        page.put("url", orEmpty(session.view.getUrl()));
        page.put("title", orEmpty(session.view.getTitle()));
        page.put("loading", session.loading);
        page.put("canGoBack", session.view.canGoBack());
        page.put("canGoForward", session.view.canGoForward());
        notifyListeners("page", page);
        if (!session.loading) remember(session.owner);
    }

    private static String orEmpty(String text) {
        return text == null ? "" : text;
    }

    private void layOut(Session session) {
        session.view.measure(View.MeasureSpec.makeMeasureSpec(session.owner.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(session.owner.height, View.MeasureSpec.EXACTLY));
        session.view.layout(0, 0, session.owner.width, session.owner.height);
    }

    private void flush(Session session) {
        main.post(() -> {
            Profile profile = ProfileStore.getInstance().getProfile(profileOf(session.owner.bot));
            if (profile != null) profile.getCookieManager().flush();
        });
    }

    private String run(Session session, JSONObject step) throws Exception {
        String action = step.optString("action");
        switch (action) {
            case "open" -> {
                String url = step.optString("url");
                if (!WebPages.isWeb(Uri.parse(url))) throw new Failure("invalid", "url must be http or https");
                navigate(session, () -> session.view.loadUrl(url));
            }
            case "reload" -> navigate(session, session.view::reload);
            case "tap" -> {
                String target = tapElement(session, step);
                settle(session);
                return "tapped [" + step.getInt("index") + "] " + target;
            }
            case "tap_at" -> {
                if (!step.has("x") || !step.has("y")) throw new Failure("invalid", "tap_at needs x and y");
                float scale = (float) Double.parseDouble(eval(session, "devicePixelRatio"));
                tap(session, (float) step.getDouble("x") * scale, (float) step.getDouble("y") * scale);
                settle(session);
            }
            case "type" -> {
                if (!step.has("text")) throw new Failure("invalid", "type needs text");
                String target = tapElement(session, step);
                Thread.sleep(SETTLE_MS);
                insert(session, step.getString("text"));
                return "typed into [" + step.getInt("index") + "] " + target;
            }
            case "type_here" -> {
                if (!step.has("text")) throw new Failure("invalid", "type_here needs text");
                insert(session, step.getString("text"));
            }
            case "clear" -> {
                if (!"\"ok\"".equals(eval(session, CLEAR))) throw new Failure("no_focus", "no field has focus: tap the field first");
            }
            case "key" -> {
                int code = switch (step.optString("keys")) {
                    case "enter" -> KeyEvent.KEYCODE_ENTER;
                    case "tab" -> KeyEvent.KEYCODE_TAB;
                    case "escape" -> KeyEvent.KEYCODE_ESCAPE;
                    case "backspace" -> KeyEvent.KEYCODE_DEL;
                    default -> throw new Failure("invalid", "keys is enter, tab, escape, or backspace");
                };
                key(session, code);
                settle(session);
            }
            case "select" -> {
                if (!step.has("index") || !step.has("option")) throw new Failure("invalid", "select needs index and option");
                evalPage(session, "window.__piPage.select(" + step.getInt("index") + ", " + JSONObject.quote(step.getString("option")) + ")");
                Thread.sleep(SETTLE_MS);
            }
            case "scroll", "scroll_in" -> {
                if ("scroll_in".equals(action) && !step.has("index")) throw new Failure("invalid", "scroll_in needs index");
                String inside = "scroll_in".equals(action) ? ", " + step.getInt("index") : "";
                evalPage(session, "window.__piPage.scroll(" + JSONObject.quote(step.optString("direction", "down")) + inside + ")");
                Thread.sleep(SETTLE_MS);
            }
            case "back", "forward" -> {
                boolean back = "back".equals(action);
                boolean went = onMain(() -> {
                    if (!(back ? session.view.canGoBack() : session.view.canGoForward())) return false;
                    if (back) session.view.goBack();
                    else session.view.goForward();
                    return true;
                });
                if (!went) throw new Failure("invalid", "there is no page to go " + action + " to");
                settle(session);
            }
            case "wait" -> Thread.sleep(Math.min(Math.max(step.optLong("ms", 1000), 0), WAIT_MAX_MS));
            case "wait_for" -> waitFor(session, step);
            default -> throw new Failure("invalid", "unknown action " + action);
        }
        return null;
    }

    private void navigate(Session session, Runnable go) throws Exception {
        session.loading = true;
        onMain(() -> {
            go.run();
            return null;
        });
        settle(session);
    }

    private void insert(Session session, String text) throws Exception {
        if (!"\"ok\"".equals(eval(session, String.format(INSERT, JSONObject.quote(text))))) throw new Failure("no_focus", "no field has focus: tap the field first");
    }

    private void waitFor(Session session, JSONObject step) throws Exception {
        if (!step.has("text")) throw new Failure("invalid", "wait_for needs text");
        String text = step.getString("text");
        boolean gone = step.optBoolean("gone", false);
        long limit = Math.min(Math.max(step.optLong("ms", WAIT_FOR_MS), 0), WAIT_FOR_MAX_MS);
        long end = SystemClock.uptimeMillis() + limit;
        String probe = String.format(HAS_TEXT, JSONObject.quote(text));
        while (true) {
            boolean there = "true".equals(eval(session, probe));
            if (there != gone) return;
            if (SystemClock.uptimeMillis() >= end) {
                throw new Failure("timeout", "waited " + limit / 1000 + " s and " + JSONObject.quote(text) + (gone ? " is still on the page" : " did not appear"));
            }
            Thread.sleep(250);
        }
    }

    private void waitForUser(Session session) throws InterruptedException {
        long end = SystemClock.uptimeMillis() + USER_WAIT_MS;
        while (SystemClock.uptimeMillis() - session.lastUserTouch < USER_QUIET_MS && SystemClock.uptimeMillis() < end) Thread.sleep(200);
    }

    private void settle(Session session) throws Exception {
        Thread.sleep(SETTLE_MS);
        awaitLoad(session);
        Thread.sleep(SETTLE_MS);
    }

    private static void awaitLoad(Session session) throws InterruptedException {
        long end = SystemClock.uptimeMillis() + LOAD_MS;
        while (session.loading && SystemClock.uptimeMillis() < end) Thread.sleep(200);
    }

    private void tap(Session session, float x, float y) throws Exception {
        long down = SystemClock.uptimeMillis();
        inject(session, MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0));
        Thread.sleep(60);
        inject(session, MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0));
    }

    private void inject(Session session, MotionEvent event) throws Exception {
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        onMain(() -> {
            session.injecting = true;
            session.view.dispatchTouchEvent(event);
            session.injecting = false;
            event.recycle();
            return null;
        });
    }

    private void key(Session session, int code) throws Exception {
        long now = SystemClock.uptimeMillis();
        onMain(() -> {
            session.view.dispatchKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
            session.view.dispatchKeyEvent(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0));
            return null;
        });
    }

    private JSObject snapshot(Session session, boolean screenshot, String error) throws Exception {
        awaitLoad(session);
        JSONObject page = new JSONObject(eval(session, FACTS));
        JSONObject state = evalPage(session, "window.__piPage.state()");
        JSObject out = new JSObject();
        out.put("tab", session.tab);
        out.put("loading", session.loading || !"complete".equals(page.optString("ready")));
        out.put("elements", state.optString("header") + "\n" + state.optString("content") + "\n" + state.optString("footer"));
        out.put("tabs", onMain(() -> listing(session.owner, session.owner.bot)).getJSONArray("tabs"));
        String dialog = session.dialog;
        session.dialog = null;
        out.put("text", dialog == null ? page.optString("text") : "[The page showed a dialog: " + dialog + "]\n" + page.optString("text"));
        if (screenshot) out.put("jpeg", capture(session));
        if (error != null) out.put("error", error);
        return out;
    }

    private String tapElement(Session session, JSONObject step) throws Exception {
        if (!step.has("index")) throw new Failure("invalid", step.optString("action") + " needs index");
        JSONObject center = evalPage(session, "window.__piPage.center(" + step.getInt("index") + ")");
        tap(session, (float) center.getDouble("x"), (float) center.getDouble("y"));
        return center.optString("what");
    }

    private JSONObject evalPage(Session session, String expression) throws Exception {
        String key = "r" + asyncKeys.incrementAndGet();
        CompletableFuture<String> answer = new CompletableFuture<>();
        answers.put(key, answer);
        String start = String.format(ASYNC, ANSWER_CHANNEL, JSONObject.quote(key), expression);
        try {
            if ("\"missing\"".equals(eval(session, start))) {
                eval(session, script() + ";0");
                if ("\"missing\"".equals(eval(session, start))) throw new Failure("page", "the page script did not load on this page");
            }
            JSONObject result = new JSONObject(answer.get(ASYNC_MS, TimeUnit.MILLISECONDS));
            if (result.has("error")) throw new Failure("page", result.getString("error"));
            return result.getJSONObject("ok");
        } catch (TimeoutException timeout) {
            throw new Failure("timeout", "the page did not answer in " + ASYNC_MS / 1000 + " s");
        } finally {
            answers.remove(key);
        }
    }

    private String script() throws Exception {
        if (pageScript == null) {
            try (InputStream input = getContext().getAssets().open(PAGE_SCRIPT)) {
                pageScript = new String(input.readAllBytes(), StandardCharsets.UTF_8);
            }
        }
        return pageScript;
    }

    private String capture(Session session) throws Exception {
        Bitmap bitmap = onMain(() -> {
            Bitmap drawn = Bitmap.createBitmap(Math.max(1, session.owner.width / 2), Math.max(1, session.owner.height / 2), Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(drawn);
            canvas.scale(0.5f, 0.5f);
            session.view.draw(canvas);
            return drawn;
        });
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 70, bytes);
        bitmap.recycle();
        return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
    }

    private String eval(Session session, String script) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        main.post(() -> session.view.evaluateJavascript(script, result::complete));
        try {
            return result.get(ANSWER_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException timeout) {
            throw new Failure("timeout", "the page did not answer in " + ANSWER_SECONDS + " s");
        }
    }

    private <T> T onMain(Callable<T> task) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return task.call();
        FutureTask<T> future = new FutureTask<>(task);
        main.post(future);
        try {
            return future.get(ANSWER_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException failed) {
            if (failed.getCause() instanceof Exception cause) throw cause;
            throw failed;
        }
    }
}
