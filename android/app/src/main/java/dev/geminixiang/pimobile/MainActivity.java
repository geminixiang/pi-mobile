package dev.geminixiang.pimobile;

import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import com.getcapacitor.BridgeActivity;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {

    /** The edge strip the web side treats as a swipe-in from the edge (App.tsx EDGE_ZONE), in dp. */
    private static final int EDGE_DP = 28;
    /** Android lets an app take at most 200 dp of each edge from the back gesture. */
    private static final int BAND_DP = 200;
    /** Where that band starts, as a share of the height: the middle of the conversation, where a thumb swipes. */
    private static final float BAND_TOP = 0.36f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(AppsPlugin.class);
        registerPlugin(CalendarPlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(TriggersPlugin.class);
        registerPlugin(SshPlugin.class);
        super.onCreate(savedInstanceState);
        keepEdgesForDrawers(getBridge().getWebView());
    }

    /**
     * With gesture navigation, a swipe in from either edge is the system's back, so the swipes that open the bot list
     * (left) and the bot's panel (right) never reach the page. Exclude a band of each edge from the back gesture;
     * above and below it, back works as usual.
     */
    private void keepEdgesForDrawers(View view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        float density = getResources().getDisplayMetrics().density;
        int edge = Math.round(EDGE_DP * density);
        int band = Math.round(BAND_DP * density);
        view.addOnLayoutChangeListener((changed, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int width = right - left;
            int height = bottom - top;
            int start = Math.round(height * BAND_TOP);
            changed.setSystemGestureExclusionRects(Arrays.asList(
                new Rect(0, start, edge, Math.min(height, start + band)),
                new Rect(width - edge, start, width, Math.min(height, start + band))
            ));
        });
    }
}
