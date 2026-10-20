package dev.geminixiang.pimobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(VoicePlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(AppsPlugin.class);
        registerPlugin(CalendarPlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(TriggersPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
