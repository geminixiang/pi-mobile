package dev.geminixiang.pimobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

final class WebPages {

    private WebPages() {}

    static boolean isWeb(Uri url) {
        String scheme = url.getScheme();
        return "http".equals(scheme) || "https".equals(scheme);
    }

    @SuppressLint("SetJavaScriptEnabled")
    static WebView create(Context context) {
        WebView view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));
        return view;
    }

    static class WebOnly extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
            return !isWeb(request.getUrl());
        }
    }
}
