package dev.geminixiang.pimobile

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.net.http.SslError
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat

object WebPages {
    fun isWeb(url: Uri): Boolean = url.scheme == "http" || url.scheme == "https"

    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context, profile: String): WebView {
        val view = WebView(context)
        // why: WebViews on one profile share one renderer and its main thread; on pi's profile a spinning page froze pi with it
        ProfileStore.getInstance().getOrCreateProfile(profile)
        WebViewCompat.setProfile(view, profile)
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            userAgentString = userAgentString.replace("; wv", "")
        }
        return view
    }

    abstract class WebOnly : WebViewClient() {
        abstract fun blocked(reason: String)

        abstract fun gone()

        override fun shouldOverrideUrlLoading(webView: WebView, request: WebResourceRequest): Boolean = !isWeb(request.url)

        override fun onReceivedSslError(webView: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            blocked("${error.url}: its certificate ${certificateProblem(error.primaryError)}")
        }

        override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail): Boolean {
            gone()
            return true
        }

        override fun onSafeBrowsingHit(webView: WebView, request: WebResourceRequest, threatType: Int, response: SafeBrowsingResponse) {
            response.backToSafety(false)
            blocked("${request.url}: Google Safe Browsing lists it as ${threat(threatType)}")
        }
    }

    private fun certificateProblem(error: Int): String =
        when (error) {
            SslError.SSL_EXPIRED -> "has expired"
            SslError.SSL_NOTYETVALID -> "is not valid yet"
            SslError.SSL_IDMISMATCH -> "belongs to another site"
            SslError.SSL_UNTRUSTED -> "is not from a trusted authority"
            SslError.SSL_DATE_INVALID -> "has an invalid date"
            else -> "is invalid"
        }

    private fun threat(type: Int): String =
        when (type) {
            WebViewClient.SAFE_BROWSING_THREAT_PHISHING -> "phishing"
            WebViewClient.SAFE_BROWSING_THREAT_MALWARE -> "malware"
            WebViewClient.SAFE_BROWSING_THREAT_UNWANTED_SOFTWARE -> "unwanted software"
            WebViewClient.SAFE_BROWSING_THREAT_BILLING -> "a billing scam"
            else -> "unsafe"
        }
}
