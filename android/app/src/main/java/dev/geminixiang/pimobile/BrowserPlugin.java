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
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
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
import java.io.ByteArrayOutputStream;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
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
    private static final int MAX_TABS = 4;
    private static final String PENDING_PREFS = "browser";
    private static final String PENDING_KEY = "forgotten";

    private static final String FACTS = "JSON.stringify({ url: location.href, title: document.title, width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, ready: document.readyState, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000) })";
    private static final String PAGE_SCRIPT = "public/page-controller.js";
    private static final long ASYNC_MS = 15_000;

    private static final String INSERT = "((t) => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('insertText', false, t); return 'ok'; })(%s)";
    private static final String CLEAR = "(() => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; })()";
    private static final String SCROLL = """
        (() => {
          const by = [%s];
          const before = scrollY + scrollX;
          scrollBy(by[0], by[1]);
          if (scrollY + scrollX !== before) return 'page';
          for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement) {
            const st = getComputedStyle(el);
            const can = (el.scrollHeight > el.clientHeight && /auto|scroll/.test(st.overflowY)) || (el.scrollWidth > el.clientWidth && /auto|scroll/.test(st.overflowX));
            if (!can) continue;
            el.scrollBy(by[0], by[1]);
            return 'inner';
          }
          return 'none';
        })()
        """;
    private static final String HAS_TEXT = "(document.body ? document.body.innerText : '').includes(%s)";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final Map<String, Tabs> bots = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong pending = new java.util.concurrent.atomic.AtomicLong();
    private volatile String pageScript;

    private static final class Failure extends Exception implements Background.Coded {
        private final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }
    }

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
        final String bot;
        final String tab;
        final WebView view;
        volatile boolean loading;
        volatile long lastUserTouch;
        volatile boolean injecting;
        volatile String dialog;
        final Runnable expire;

        Session(Tabs owner, String tab, WebView view) {
            this.owner = owner;
            this.bot = owner.bot;
            this.tab = tab;
            this.view = view;
            this.expire = () -> {
                if (owner.shown && tab.equals(owner.active)) return;
                close(owner, tab);
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
            call.resolve(snapshot(session, call.getBoolean("screenshot", false), null, null));
        });
    }

    @PluginMethod
    public void act(PluginCall call) {
        Background.run(work, call, () -> {
            Session session = session(call);
            JSArray steps = call.getArray("steps", new JSArray());
            boolean screenshot = call.getBoolean("screenshot", false);
            for (int i = 0; i < steps.length(); i++) {
                JSONObject step = steps.getJSONObject(i);
                try {
                    waitForUser(session);
                    run(session, step);
                } catch (Failure failure) {
                    call.resolve(snapshot(session, screenshot, i, "step " + (i + 1) + " (" + step.optString("action") + "): " + failure.getMessage()));
                    return;
                }
            }
            call.resolve(snapshot(session, screenshot, steps.length(), null));
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
                for (Session session : tabs.open.values()) {
                    if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
                    layOut(session);
                    main.removeCallbacks(session.expire);
                    main.postDelayed(session.expire, IDLE_MS);
                }
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
            onMain(() -> {
                if (tabs != null) {
                    for (Session session : tabs.open.values()) {
                        main.removeCallbacks(session.expire);
                        if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
                        session.view.destroy();
                    }
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
            if (!deleted) pending().edit().putStringSet(PENDING_KEY, with(pending().getStringSet(PENDING_KEY, Set.of()), profileOf(bot))).apply();
            call.resolve();
        });
    }

    @Override
    public void load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        Set<String> left = new HashSet<>();
        for (String name : pending().getStringSet(PENDING_KEY, Set.of())) {
            ProfileStore store = ProfileStore.getInstance();
            if (store.getProfile(name) == null) continue;
            try {
                store.deleteProfile(name);
            } catch (IllegalStateException inUse) {
                left.add(name);
            }
        }
        pending().edit().putStringSet(PENDING_KEY, left).apply();
    }

    private SharedPreferences pending() {
        return getContext().getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE);
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

    private Session session(PluginCall call) throws Exception {
        String bot = call.getString("bot", "");
        if (bot.isEmpty()) throw new Failure("invalid", "bot is required");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            throw new Failure("unsupported", "this phone's WebView cannot keep a separate browser per Bot; update Android System WebView");
        }
        Tabs tabs = bots.computeIfAbsent(bot, Tabs::new);
        String tab = call.getString("tab", null);
        return onMain(() -> {
            String wanted = tab != null ? tab : tabs.active;
            Session existing = wanted == null ? null : tabs.open.get(wanted);
            if (existing == null && tab != null) throw new Failure("no_tab", "tab " + tab + " is not open; open tabs: " + String.join(", ", tabs.open.keySet()));
            Session session = existing != null ? existing : create(tabs);
            main.removeCallbacks(session.expire);
            if (!(tabs.shown && session.tab.equals(tabs.active))) main.postDelayed(session.expire, IDLE_MS);
            return session;
        });
    }

    @PluginMethod
    public void newTab(PluginCall call) {
        Background.run(work, call, () -> {
            String bot = call.getString("bot", "");
            if (bot.isEmpty()) throw new Failure("invalid", "bot is required");
            Tabs tabs = bots.computeIfAbsent(bot, Tabs::new);
            Session session = onMain(() -> {
                if (tabs.open.size() >= MAX_TABS) throw new Failure("too_many", "a Bot keeps at most " + MAX_TABS + " tabs; close one first");
                Session created = create(tabs);
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
            Tabs tabs = bots.get(call.getString("bot", ""));
            String tab = call.getString("tab", "");
            onMain(() -> {
                if (tabs == null || !tabs.open.containsKey(tab)) throw new Failure("no_tab", "tab " + tab + " is not open");
                select(tabs, tab);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void closeTab(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = bots.get(call.getString("bot", ""));
            String tab = call.getString("tab", "");
            onMain(() -> {
                if (tabs == null || !tabs.open.containsKey(tab)) throw new Failure("no_tab", "tab " + tab + " is not open");
                close(tabs, tab);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void tabs(PluginCall call) {
        Background.run(work, call, () -> {
            Tabs tabs = bots.get(call.getString("bot", ""));
            call.resolve(onMain(() -> listing(tabs, call.getString("bot", ""))));
        });
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
        notifyListeners("tabs", listing(tabs, tabs.bot));
    }

    private void select(Tabs tabs, String tab) {
        Session previous = tabs.active == null ? null : tabs.open.get(tabs.active);
        tabs.active = tab;
        Session next = tabs.open.get(tab);
        if (tabs.shown && next != null) {
            if (previous != null && previous != next && previous.view.getParent() instanceof ViewGroup parent) {
                parent.removeView(previous.view);
                layOut(previous);
                main.postDelayed(previous.expire, IDLE_MS);
            }
            attach(next, false);
        }
        announceTabs(tabs);
        if (next != null) announce(next);
    }

    private void close(Tabs tabs, String tab) {
        Session session = tabs.open.remove(tab);
        if (session == null) return;
        main.removeCallbacks(session.expire);
        if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
        session.view.destroy();
        if (tab.equals(tabs.active)) {
            String last = null;
            for (String id : tabs.open.keySet()) last = id;
            tabs.active = null;
            if (last != null) select(tabs, last);
        }
        if (tabs.open.isEmpty()) tabs.active = null;
        announceTabs(tabs);
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
            if (other != session && other.view.getParent() instanceof ViewGroup parent) parent.removeView(other.view);
        }
        boolean fresh = session.view.getParent() != root;
        if (session.view.getParent() instanceof ViewGroup parent && fresh) parent.removeView(session.view);
        if (fresh) {
            session.view.setAlpha(fade ? 0f : 1f);
            root.addView(session.view, tabs.placed);
            if (fade) session.view.animate().alpha(1f).setDuration(140).start();
        } else {
            session.view.setLayoutParams(tabs.placed);
        }
        main.removeCallbacks(session.expire);
    }

    @SuppressLint({ "SetJavaScriptEnabled", "ClickableViewAccessibility" })
    private Session create(Tabs tabs) {
        String bot = tabs.bot;
        ProfileStore.getInstance().getOrCreateProfile(profileOf(bot));
        WebView view = new WebView(getContext());
        WebViewCompat.setProfile(view, profileOf(bot));
        Session session = new Session(tabs, String.valueOf(tabs.next++), view);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !"http".equals(scheme) && !"https".equals(scheme);
            }

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
            if (!session.injecting) session.lastUserTouch = SystemClock.uptimeMillis();
            return false;
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
        page.put("bot", session.bot);
        page.put("tab", session.tab);
        page.put("active", session.tab.equals(session.owner.active));
        page.put("url", orEmpty(session.view.getUrl()));
        page.put("title", orEmpty(session.view.getTitle()));
        page.put("loading", session.loading);
        page.put("canGoBack", session.view.canGoBack());
        page.put("canGoForward", session.view.canGoForward());
        notifyListeners("page", page);
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
            Profile profile = ProfileStore.getInstance().getProfile(profileOf(session.bot));
            if (profile != null) profile.getCookieManager().flush();
        });
    }

    private void run(Session session, JSONObject step) throws Exception {
        String action = step.optString("action");
        switch (action) {
            case "open" -> {
                String url = step.optString("url");
                String scheme = Uri.parse(url).getScheme();
                if (!"http".equals(scheme) && !"https".equals(scheme)) throw new Failure("invalid", "url must be http or https");
                session.loading = true;
                onMain(() -> {
                    session.view.loadUrl(url);
                    return null;
                });
                settle(session);
            }
            case "tap" -> {
                tapTarget(session, step);
                settle(session);
            }
            case "type" -> {
                if (!step.has("text")) throw new Failure("invalid", "type needs text");
                if (step.has("index")) {
                    tapTarget(session, step);
                    Thread.sleep(SETTLE_MS);
                }
                if (!"\"ok\"".equals(eval(session, String.format(INSERT, JSONObject.quote(step.getString("text")))))) {
                    throw new Failure("no_focus", "no field has focus: tap the field first");
                }
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
                JSONObject result = new JSONObject(evalIndexed(session, "window.__piPage.select(" + step.getInt("index") + ", " + JSONObject.quote(step.getString("option")) + ")"));
                if (!result.optBoolean("success")) throw new Failure("select", result.optString("message"));
                Thread.sleep(SETTLE_MS);
            }
            case "scroll" -> {
                String direction = step.optString("direction", "down");
                if ("down".equals(direction) || "up".equals(direction)) {
                    String index = step.has("index") ? ", " + step.getInt("index") : "";
                    evalPage(session, "window.__piPage.scroll(" + "down".equals(direction) + index + ")");
                    Thread.sleep(SETTLE_MS);
                    return;
                }
                String by = switch (direction) {
                    case "up" -> "0, -innerHeight * 0.8";
                    case "left" -> "-innerWidth * 0.8, 0";
                    case "right" -> "innerWidth * 0.8, 0";
                    default -> "0, innerHeight * 0.8";
                };
                eval(session, String.format(SCROLL, by));
                Thread.sleep(SETTLE_MS);
            }
            case "back" -> {
                boolean went = onMain(() -> {
                    if (!session.view.canGoBack()) return false;
                    session.view.goBack();
                    return true;
                });
                if (!went) throw new Failure("invalid", "there is no page to go back to");
                settle(session);
            }
            case "forward" -> {
                boolean went = onMain(() -> {
                    if (!session.view.canGoForward()) return false;
                    session.view.goForward();
                    return true;
                });
                if (!went) throw new Failure("invalid", "there is no page to go forward to");
                settle(session);
            }
            case "reload" -> {
                session.loading = true;
                onMain(() -> {
                    session.view.reload();
                    return null;
                });
                settle(session);
            }
            case "wait" -> Thread.sleep(Math.min(Math.max(step.optLong("ms", 1000), 0), WAIT_MAX_MS));
            case "wait_for" -> waitFor(session, step);
            default -> throw new Failure("invalid", "unknown action " + action);
        }
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
        long end = SystemClock.uptimeMillis() + LOAD_MS;
        while (session.loading && SystemClock.uptimeMillis() < end) Thread.sleep(200);
        Thread.sleep(SETTLE_MS);
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

    private JSObject snapshot(Session session, boolean screenshot, Integer done, String error) throws Exception {
        long end = SystemClock.uptimeMillis() + LOAD_MS;
        while (session.loading && SystemClock.uptimeMillis() < end) Thread.sleep(200);
        JSONObject page = new JSONObject(new JSONArray("[" + eval(session, FACTS) + "]").getString(0));
        JSONObject state = new JSONObject(evalPage(session, "window.__piPage.state()"));
        JSObject out = new JSObject();
        out.put("tab", session.tab);
        out.put("url", page.optString("url"));
        out.put("title", page.optString("title"));
        out.put("width", page.optInt("width"));
        out.put("height", page.optInt("height"));
        out.put("scrollY", page.optInt("scrollY"));
        out.put("scrollHeight", page.optInt("scrollHeight"));
        out.put("loading", session.loading || !"complete".equals(page.optString("ready")));
        out.put("elements", state.optString("header") + "\n" + state.optString("content") + "\n" + state.optString("footer"));
        out.put("more", 0);
        String dialog = session.dialog;
        session.dialog = null;
        out.put("text", dialog == null ? page.optString("text") : "[The page showed a dialog: " + dialog + "]\n" + page.optString("text"));
        if (screenshot) out.put("jpeg", capture(session));
        if (done != null) out.put("done", done);
        if (error != null) out.put("error", error);
        flush(session);
        return out;
    }

    private void tapTarget(Session session, JSONObject step) throws Exception {
        float scale = (float) Double.parseDouble(eval(session, "devicePixelRatio"));
        if (step.has("index")) {
            JSONObject center = new JSONObject(evalIndexed(session, "window.__piPage.center(" + step.getInt("index") + ")"));
            tap(session, (float) center.getDouble("x") * scale, (float) center.getDouble("y") * scale);
            return;
        }
        if (!step.has("x") || !step.has("y")) throw new Failure("invalid", "tap needs index, or x and y");
        tap(session, (float) step.getDouble("x") * scale, (float) step.getDouble("y") * scale);
    }

    private String evalIndexed(Session session, String expression) throws Exception {
        try {
            return evalPage(session, expression);
        } catch (Failure failure) {
            if (!"page".equals(failure.code())) throw failure;
            throw new Failure("stale", failure.getMessage() + "; read the page again, since its [n] indexes change when the page does");
        }
    }

    private String evalPage(Session session, String expression) throws Exception {
        if (!"\"object\"".equals(eval(session, "typeof window.__piPage"))) eval(session, script() + ";0");
        String key = "r" + pending.incrementAndGet();
        eval(session, "(() => { const box = window.__piAsync || (window.__piAsync = {}); Promise.resolve().then(() => " + expression + ").then((value) => { box." + key + " = { ok: JSON.stringify(value === undefined ? null : value) }; }, (failure) => { box." + key + " = { error: String((failure && failure.message) || failure) }; }); return 0; })()");
        long end = SystemClock.uptimeMillis() + ASYNC_MS;
        while (SystemClock.uptimeMillis() < end) {
            String raw = new JSONArray("[" + eval(session, "(() => { const box = window.__piAsync || {}; const value = box." + key + "; delete box." + key + "; return value ? JSON.stringify(value) : ''; })()") + "]").getString(0);
            if (!raw.isEmpty()) {
                JSONObject result = new JSONObject(raw);
                if (result.has("error")) throw new Failure("page", result.getString("error"));
                return result.getString("ok");
            }
            Thread.sleep(50);
        }
        throw new Failure("timeout", "the page did not answer in " + ASYNC_MS / 1000 + " s");
    }

    private String script() throws Exception {
        if (pageScript == null) {
            try (java.io.InputStream input = getContext().getAssets().open(PAGE_SCRIPT)) {
                pageScript = new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            }
        }
        return pageScript;
    }

    private String capture(Session session) throws Exception {
        return onMain(() -> {
            Bitmap bitmap = Bitmap.createBitmap(Math.max(1, session.owner.width / 2), Math.max(1, session.owner.height / 2), Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.scale(0.5f, 0.5f);
            session.view.draw(canvas);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 70, bytes);
            bitmap.recycle();
            return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        });
    }

    private String eval(Session session, String script) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        main.post(() -> session.view.evaluateJavascript(script, result::complete));
        try {
            return result.get(10, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            throw new Failure("timeout", "the page did not answer in 10 s");
        }
    }

    private <T> T onMain(Callable<T> task) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return task.call();
        FutureTask<T> future = new FutureTask<>(task);
        main.post(future);
        try {
            return future.get(10, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException failed) {
            if (failed.getCause() instanceof Exception cause) throw cause;
            throw failed;
        }
    }
}
