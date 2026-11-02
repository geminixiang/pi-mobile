package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

class PhoneScreenService : AccessibilityService() {
    @Volatile private var lastChange = 0L

    override fun onServiceConnected() {
        running = this
    }

    override fun onUnbind(intent: Intent?): Boolean {
        running = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        running = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        lastChange = SystemClock.uptimeMillis()
    }

    override fun onInterrupt() {}

    fun lastChangeAt() = lastChange

    companion object {
        @JvmField @Volatile var running: PhoneScreenService? = null

        // why: Android lets an app whose accessibility service is bound start activities from the background (measured on the S24, Android 16); otherwise it drops them without an error
        @JvmStatic fun canStartActivities(activity: Activity?) = TriggersPlugin.inFront(activity) || running != null
    }
}
