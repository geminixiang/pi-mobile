package dev.geminixiang.pimobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
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

    abstract static class WebOnly extends WebViewClient {
        abstract void blocked(String reason);

        @Override
        public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
            return !isWeb(request.getUrl());
        }

        @Override
        public void onReceivedSslError(WebView webView, SslErrorHandler handler, SslError error) {
            handler.cancel();
            blocked(error.getUrl() + ": its certificate " + certificateProblem(error.getPrimaryError()));
        }

        @Override
        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
            blocked(webView.getUrl() + ": its renderer stopped");
            return true;
        }

        @Override
        public void onSafeBrowsingHit(WebView webView, WebResourceRequest request, int threatType, SafeBrowsingResponse response) {
            response.backToSafety(false);
            blocked(request.getUrl() + ": Google Safe Browsing lists it as " + threat(threatType));
        }
    }

    private static String certificateProblem(int error) {
        return switch (error) {
            case SslError.SSL_EXPIRED -> "has expired";
            case SslError.SSL_NOTYETVALID -> "is not valid yet";
            case SslError.SSL_IDMISMATCH -> "belongs to another site";
            case SslError.SSL_UNTRUSTED -> "is not from a trusted authority";
            case SslError.SSL_DATE_INVALID -> "has an invalid date";
            default -> "is invalid";
        };
    }

    private static String threat(int type) {
        return switch (type) {
            case WebViewClient.SAFE_BROWSING_THREAT_PHISHING -> "phishing";
            case WebViewClient.SAFE_BROWSING_THREAT_MALWARE -> "malware";
            case WebViewClient.SAFE_BROWSING_THREAT_UNWANTED_SOFTWARE -> "unwanted software";
            case WebViewClient.SAFE_BROWSING_THREAT_BILLING -> "a billing scam";
            default -> "unsafe";
        };
    }
}
