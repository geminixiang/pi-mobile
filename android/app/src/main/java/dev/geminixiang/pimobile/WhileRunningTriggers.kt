package dev.geminixiang.pimobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
import kotlin.math.roundToInt

object WhileRunningTriggers {
    private var listening = false

    private val receiver =
        object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (isInitialStickyBroadcast) return
                when (intent.action) {
                    Intent.ACTION_USER_PRESENT -> TriggerReceiver.event(context, "unlock", "解鎖手機") { it.trigger is When.Unlock }
                    Intent.ACTION_BATTERY_LOW -> TriggerReceiver.event(context, "battery_low", "電量剩 ${batteryPercent(context)}%") { it.trigger is When.BatteryLow }
                    AudioManager.ACTION_HEADSET_PLUG ->
                        when (intent.getIntExtra("state", -1)) {
                            1 -> TriggerReceiver.headphones(context, "有線耳機")
                            0 -> Speaker.stopIfSpeaking()
                        }
                }
            }
        }

    @JvmStatic
    @Synchronized
    fun listen(context: Context) {
        if (listening) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(AudioManager.ACTION_HEADSET_PLUG)
        }
        context.applicationContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        listening = true
    }

    private fun batteryPercent(context: Context): Int {
        val battery = context.applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        if (level >= 0 && scale > 0) return (level * 100f / scale).roundToInt()
        return context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }
}
