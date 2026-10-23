package dev.geminixiang.pimobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.view.HapticFeedbackConstants;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "System")
public class SystemPlugin extends Plugin {

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        boolean loopback = url != null && (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:"));
        if (url == null || !(url.startsWith("https://") || loopback)) {
            call.reject("https URL required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "tick");
        int tick = android.os.Build.VERSION.SDK_INT >= 34 ? HapticFeedbackConstants.SEGMENT_TICK : HapticFeedbackConstants.CLOCK_TICK;
        int constant = "press".equals(kind)
            ? HapticFeedbackConstants.LONG_PRESS
            : "confirm".equals(kind) ? HapticFeedbackConstants.CONFIRM : tick;
        getActivity().runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(constant));
        call.resolve();
    }

    @PluginMethod
    public void clipboardText(PluginCall call) {
        ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
        ClipData clip = clipboard.getPrimaryClip();
        CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(getContext()) : null;
        JSObject result = new JSObject();
        result.put("text", text == null ? "" : text.toString());
        call.resolve(result);
    }

    @PluginMethod
    public void assistant(PluginCall call) {
        android.app.role.RoleManager roles = getContext().getSystemService(android.app.role.RoleManager.class);
        JSObject result = new JSObject();
        result.put("held", roles != null && roles.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT));
        call.resolve(result);
    }

    @PluginMethod
    public void openAssistantSettings(PluginCall call) {
        android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_VOICE_INPUT_SETTINGS)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException e) {
            getContext().startActivity(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }
}
