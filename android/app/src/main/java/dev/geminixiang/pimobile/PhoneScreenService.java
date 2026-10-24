package dev.geminixiang.pimobile;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;

public class PhoneScreenService extends AccessibilityService {

    static volatile PhoneScreenService running;
    private volatile long lastChange;

    @Override
    protected void onServiceConnected() {
        running = this;
    }

    @Override
    public boolean onUnbind(Intent intent) {
        running = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        running = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        lastChange = SystemClock.uptimeMillis();
    }

    @Override
    public void onInterrupt() {}

    long quietFor() {
        return SystemClock.uptimeMillis() - lastChange;
    }
}
