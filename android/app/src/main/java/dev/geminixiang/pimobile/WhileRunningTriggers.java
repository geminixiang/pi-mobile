package dev.geminixiang.pimobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.BatteryManager;
import android.os.Build;

final class WhileRunningTriggers {

    private static boolean listening = false;

    private WhileRunningTriggers() {}

    static synchronized void listen(Context context) {
        if (listening) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(Intent.ACTION_BATTERY_LOW);
        filter.addAction(AudioManager.ACTION_HEADSET_PLUG);
        Context app = context.getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) app.registerReceiver(RECEIVER, filter, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(RECEIVER, filter);
        listening = true;
    }

    private static final BroadcastReceiver RECEIVER = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (isInitialStickyBroadcast()) return;
            String action = intent.getAction();
            if (Intent.ACTION_USER_PRESENT.equals(action)) {
                TriggerReceiver.event(context, "unlock", "解鎖手機", null);
            } else if (Intent.ACTION_BATTERY_LOW.equals(action)) {
                int level = context.getSystemService(BatteryManager.class).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                TriggerReceiver.event(context, "battery_low", "電量剩 " + level + "%", null);
            } else if (AudioManager.ACTION_HEADSET_PLUG.equals(action)) {
                int state = intent.getIntExtra("state", -1);
                if (state == 1) TriggerReceiver.headphones(context, "有線耳機");
                else if (state == 0) Speaker.stopIfSpeaking();
            }
        }
    };
}
