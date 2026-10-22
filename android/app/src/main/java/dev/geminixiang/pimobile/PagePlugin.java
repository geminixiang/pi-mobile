package dev.geminixiang.pimobile;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Renders a web page in a WebView no one sees and returns its HTML once the page's own scripts have filled it in, for
 * web_fetch on pages that build their content in JavaScript. The WebView is never attached to a window, has no
 * bridge to the app, no file or content access, opens no popups, and follows only http and https; it is destroyed
 * after each page. Waits for the load, then until the text stops growing, up to a deadline.
 */
@CapacitorPlugin(name = "Page")
public class PagePlugin extends Plugin {

    private static final int WIDTH = 1080;
    private static final int HEIGHT = 2400;
    private static final long POLL_MS = 500;
    private static final long TOTAL_MS = 30_000;
    /** After the load, how long the text must stay the same to count as done (tables that fill in from a second request take over a second). */
    private static final long SETTLED_MS = 2_000;
    private static final String READ = "(function(){return JSON.stringify([document.documentElement.outerHTML, document.body ? document.body.innerText.length : 0, document.title, location.href]);})()";

    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void render(PluginCall call) {
        String url = call.getString("url", "");
        String scheme = Uri.parse(url).getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            call.reject("url must be http or https");
            return;
        }
        main.post(() -> new Render(call, url).start());
    }

    private final class Render {
        private final PluginCall call;
        private final String url;
        private final long started = System.currentTimeMillis();
        private WebView view;
        private boolean loaded;
        private boolean done;
        private int lastLength = -1;
        private long sameSince;
        private String error;

        Render(PluginCall call, String url) {
            this.call = call;
            this.url = url;
        }

        @SuppressLint("SetJavaScriptEnabled")
        void start() {
            view = new WebView(getContext());
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));
            // A size, so pages that lay out by the viewport render as on a phone.
            view.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY));
            view.layout(0, 0, WIDTH, HEIGHT);
            view.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                    String next = request.getUrl().getScheme();
                    return !"http".equals(next) && !"https".equals(next);
                }

                @Override
                public void onPageStarted(WebView webView, String pageUrl, Bitmap favicon) {
                    loaded = false;
                    error = null;
                }

                @Override
                public void onPageFinished(WebView webView, String pageUrl) {
                    loaded = true;
                }

                @Override
                public void onReceivedError(WebView webView, WebResourceRequest request, android.webkit.WebResourceError failure) {
                    if (request.isForMainFrame()) error = String.valueOf(failure.getDescription());
                }
            });
            view.loadUrl(url);
            main.postDelayed(this::poll, POLL_MS);
        }

        void poll() {
            if (done) return;
            long now = System.currentTimeMillis();
            // The main page failed: the WebView shows its own error page, which is not the page.
            if (error != null && (loaded || now - started >= TOTAL_MS)) {
                finish(null, "could not load the page: " + error);
                return;
            }
            boolean late = now - started >= TOTAL_MS;
            if (!loaded && !late) {
                main.postDelayed(this::poll, POLL_MS);
                return;
            }
            view.evaluateJavascript(READ, (json) -> {
                if (done) return;
                try {
                    // evaluateJavascript gives the result as JSON: a string holding our JSON array.
                    JSONArray values = new JSONArray(new JSONArray("[" + json + "]").getString(0));
                    int length = values.getInt(1);
                    long time = System.currentTimeMillis();
                    if (length != lastLength) {
                        lastLength = length;
                        sameSince = time;
                    }
                    if (late || (length > 0 && time - sameSince >= SETTLED_MS)) {
                        JSObject out = new JSObject();
                        out.put("html", values.getString(0));
                        out.put("title", values.getString(2));
                        out.put("url", values.getString(3));
                        out.put("ms", time - started);
                        out.put("settled", !late);
                        finish(out, null);
                    } else {
                        main.postDelayed(this::poll, POLL_MS);
                    }
                } catch (JSONException parse) {
                    if (late) finish(null, "could not read the page");
                    else main.postDelayed(this::poll, POLL_MS);
                }
            });
        }

        void finish(JSObject out, String failure) {
            done = true;
            view.stopLoading();
            view.destroy();
            if (out != null) call.resolve(out);
            else call.reject(failure);
        }
    }
}
