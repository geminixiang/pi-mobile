package dev.geminixiang.pimobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
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
    private static final String PENDING_PREFS = "browser";
    private static final String PENDING_KEY = "forgotten";

    private static final String READ = """
        (() => {
          const vw = innerWidth, vh = innerHeight;
          const picks = 'a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
          const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
          const lines = [];
          let more = 0;
          for (const el of document.querySelectorAll(picks)) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input ' + (el.type || 'text') : tag);
            const secret = tag === 'input' && el.type === 'password';
            const label = clean(el.getAttribute('aria-label') || (tag === 'input' || tag === 'textarea' ? '' : el.innerText) || el.title || el.alt || el.name || el.placeholder, 80);
            const value = (tag === 'input' || tag === 'textarea' || tag === 'select') && !secret && el.value ? ' value=' + JSON.stringify(clean(el.value, 60)) : '';
            const hint = el.placeholder && el.placeholder !== label ? ' placeholder=' + JSON.stringify(clean(el.placeholder, 40)) : '';
            const field = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
            if (!label && !value && !hint && !field) continue;
            const state = (el.checked ? ' checked' : '') + (el.disabled ? ' disabled' : '') + (el === document.activeElement ? ' focused' : '');
            if (lines.length >= 80) { more++; continue; }
            lines.push('[' + role + '] ' + JSON.stringify(label) + value + hint + state + ' @' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2));
          }
          const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 6000);
          return JSON.stringify({ url: location.href, title: document.title, width: vw, height: vh, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, elements: lines.join('\\n'), more, text, dpr: devicePixelRatio, ready: document.readyState });
        })()
        """;

    private static final String INSERT = "((t) => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('insertText', false, t); return 'ok'; })(%s)";
    private static final String CLEAR = "(() => { const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; })()";
    private static final String HAS_TEXT = "(document.body ? document.body.innerText : '').includes(%s)";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

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

    private final class Session {
        final String bot;
        final WebView view;
        volatile boolean loading;
        volatile long lastUserTouch;
        volatile boolean injecting;
        volatile String dialog;
        int width = DEFAULT_WIDTH;
        int height = DEFAULT_HEIGHT;
        boolean shown;
        final Runnable expire;

        Session(String bot, WebView view) {
            this.bot = bot;
            this.view = view;
            this.expire = () -> {
                if (shown) return;
                sessions.remove(bot);
                view.destroy();
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
            float density = getContext().getResources().getDisplayMetrics().density;
            onMain(() -> {
                View bridge = getBridge().getWebView();
                ViewGroup root = getActivity().findViewById(android.R.id.content);
                int[] from = new int[2];
                int[] to = new int[2];
                bridge.getLocationInWindow(from);
                root.getLocationInWindow(to);
                session.width = Math.max(1, Math.round(call.getFloat("width", 0f) * density));
                session.height = Math.max(1, Math.round(call.getFloat("height", 0f) * density));
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(session.width, session.height);
                params.leftMargin = from[0] - to[0] + Math.round(call.getFloat("x", 0f) * density);
                params.topMargin = from[1] - to[1] + Math.round(call.getFloat("y", 0f) * density);
                if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
                root.addView(session.view, params);
                session.shown = true;
                main.removeCallbacks(session.expire);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        Background.run(work, call, () -> {
            Session session = sessions.get(call.getString("bot", ""));
            if (session != null) onMain(() -> {
                if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
                session.shown = false;
                layOut(session);
                main.postDelayed(session.expire, IDLE_MS);
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        Background.run(work, call, () -> {
            String bot = call.getString("bot", "");
            Session session = sessions.remove(bot);
            onMain(() -> {
                if (session != null) {
                    main.removeCallbacks(session.expire);
                    if (session.view.getParent() instanceof ViewGroup parent) parent.removeView(session.view);
                    session.view.destroy();
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
        for (Session session : sessions.values()) flush(session);
    }

    private Session session(PluginCall call) throws Exception {
        String bot = call.getString("bot", "");
        if (bot.isEmpty()) throw new Failure("invalid", "bot is required");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            throw new Failure("unsupported", "this phone's WebView cannot keep a separate browser per Bot; update Android System WebView");
        }
        Session existing = sessions.get(bot);
        if (existing != null) {
            onMain(() -> {
                main.removeCallbacks(existing.expire);
                if (!existing.shown) main.postDelayed(existing.expire, IDLE_MS);
                return null;
            });
            return existing;
        }
        return onMain(() -> create(bot));
    }

    @SuppressLint({ "SetJavaScriptEnabled", "ClickableViewAccessibility" })
    private Session create(String bot) {
        ProfileStore.getInstance().getOrCreateProfile(profileOf(bot));
        WebView view = new WebView(getContext());
        WebViewCompat.setProfile(view, profileOf(bot));
        Session session = new Session(bot, view);
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
            }

            @Override
            public void onPageFinished(WebView webView, String url) {
                session.loading = false;
                flush(session);
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
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
        sessions.put(bot, session);
        main.postDelayed(session.expire, IDLE_MS);
        return session;
    }

    private void layOut(Session session) {
        session.view.measure(View.MeasureSpec.makeMeasureSpec(session.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(session.height, View.MeasureSpec.EXACTLY));
        session.view.layout(0, 0, session.width, session.height);
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
                if (!step.has("x") || !step.has("y")) throw new Failure("invalid", "tap needs x and y");
                float scale = (float) Double.parseDouble(eval(session, "devicePixelRatio"));
                tap(session, (float) step.getDouble("x") * scale, (float) step.getDouble("y") * scale);
                settle(session);
            }
            case "type" -> {
                if (!step.has("text")) throw new Failure("invalid", "type needs text");
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
            case "scroll" -> {
                String direction = step.optString("direction", "down");
                String by = switch (direction) {
                    case "up" -> "0, -innerHeight * 0.8";
                    case "left" -> "-innerWidth * 0.8, 0";
                    case "right" -> "innerWidth * 0.8, 0";
                    default -> "0, innerHeight * 0.8";
                };
                eval(session, "scrollBy(" + by + "), 0");
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
        JSONObject page = new JSONObject(new JSONArray("[" + eval(session, READ) + "]").getString(0));
        JSObject out = new JSObject();
        out.put("url", page.optString("url"));
        out.put("title", page.optString("title"));
        out.put("width", page.optInt("width"));
        out.put("height", page.optInt("height"));
        out.put("scrollY", page.optInt("scrollY"));
        out.put("scrollHeight", page.optInt("scrollHeight"));
        out.put("loading", session.loading || !"complete".equals(page.optString("ready")));
        out.put("elements", page.optString("elements"));
        out.put("more", page.optInt("more"));
        String dialog = session.dialog;
        session.dialog = null;
        out.put("text", dialog == null ? page.optString("text") : "[The page showed a dialog: " + dialog + "]\n" + page.optString("text"));
        if (screenshot) out.put("jpeg", capture(session));
        if (done != null) out.put("done", done);
        if (error != null) out.put("error", error);
        flush(session);
        return out;
    }

    private String capture(Session session) throws Exception {
        return onMain(() -> {
            Bitmap bitmap = Bitmap.createBitmap(Math.max(1, session.width / 2), Math.max(1, session.height / 2), Bitmap.Config.ARGB_8888);
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
        return future.get(10, TimeUnit.SECONDS);
    }
}
