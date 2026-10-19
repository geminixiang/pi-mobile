package dev.geminixiang.pimobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Small system bridges: open a URL in the user's browser, and read the clipboard (the WebView's API cannot). */
@CapacitorPlugin(name = "System")
public class SystemPlugin extends Plugin {

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("https URL required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
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
}
