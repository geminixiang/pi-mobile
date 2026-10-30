package dev.geminixiang.pimobile

import android.accessibilityservice.AccessibilityService
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
    }
}
