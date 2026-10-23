package dev.geminixiang.pimobile;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.CapacitorWebView;

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
