package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

class PhoneScreenService : AccessibilityService() {
    internal val changes = ScreenChanges()
    internal val elementIds = ElementIds()

    override fun onServiceConnected() {
        running = this
        DisplayShells.current?.attach(this)
    }

    override fun onUnbind(intent: Intent?): Boolean {
        DisplayShells.current?.attach(null)
        running = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        DisplayShells.current?.attach(null)
        running = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val displays = windowsOnAllDisplays
        for (at in 0 until displays.size()) {
            if (displays.valueAt(at).any { it.id == event.windowId }) {
                changes.record(displays.keyAt(at), SystemClock.uptimeMillis())
                return
            }
        }
    }

    override fun onInterrupt() {}

    companion object {
        @JvmField @Volatile var running: PhoneScreenService? = null

        // why: Android lets an app whose accessibility service is bound start activities from the background (measured on the S24, Android 16); otherwise it drops them without an error
        @JvmStatic fun canStartActivities(activity: Activity?) = TriggersPlugin.inFront(activity) || running != null
    }
}
