package dev.geminixiang.pimobile;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView, kept running while the agent works in the background.
 *
 * Chromium freezes a page that has been hidden for a minute (Blink's page freezing): timers, plugin callbacks, and
 * events stop until the page is shown again, so a run, or a fired schedule, stalls while pi is in the background even
 * though the foreground service keeps the process alive. The page counts as hidden when the window is not visible.
 * While the agent works, this view reports its window as visible, so the page is never hidden and never frozen; when
 * the work ends it reports the real visibility again. Nothing is drawn meanwhile: the window itself stays hidden.
 */
public class PiWebView extends CapacitorWebView {

    private boolean keepRunning;
    private int windowVisibility = View.VISIBLE;

    public PiWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        windowVisibility = visibility;
        super.onWindowVisibilityChanged(keepRunning ? View.VISIBLE : visibility);
    }

    /** Keep the page running in the background, or let it be hidden (and frozen) again. Call on the UI thread. */
    static void keepRunning(WebView view, boolean on) {
        if (!(view instanceof PiWebView)) return;
        PiWebView web = (PiWebView) view;
        if (web.keepRunning == on) return;
        web.keepRunning = on;
        web.dispatchVisibility();
    }

    private void dispatchVisibility() {
        super.onWindowVisibilityChanged(keepRunning ? View.VISIBLE : windowVisibility);
    }
}
