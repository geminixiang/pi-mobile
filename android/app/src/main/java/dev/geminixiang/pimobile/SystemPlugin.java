package dev.geminixiang.pimobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.view.HapticFeedbackConstants;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small system bridges: open a URL in the user's browser, read the clipboard (the WebView's API cannot), and haptic
 * ticks, which the system plays without the vibrate permission and as the user set them in Settings.
 */
@CapacitorPlugin(name = "System")
public class SystemPlugin extends Plugin {

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        // https, or http on this device's loopback (a local test server for MCP sign-ins).
        boolean loopback = url != null && (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:"));
        if (url == null || !(url.startsWith("https://") || loopback)) {
            call.reject("https URL required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * kind: "tick" (a dial snapping into a detent: Android 14's segment tick, made for segmented sliders, else the
     * clock tick), "press" (a long press took effect), "confirm".
     */
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

    /** Whether pi is the digital assistant (summoned with the side key, it gets the screen: AssistSession). */
    @PluginMethod
    public void assistant(PluginCall call) {
        android.app.role.RoleManager roles = getContext().getSystemService(android.app.role.RoleManager.class);
        JSObject result = new JSObject();
        result.put("held", roles != null && roles.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT));
        call.resolve(result);
    }

    /** The system page where the user picks the digital assistant; Android does not let an app ask for the role. */
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

    /**
     * The system's fingerprint or face check, or the screen lock when the phone has no biometrics, before an approval
     * (Settings › 帳號 › 核准時驗證). Resolves {ok}: false when the user cancels or fails.
     */
    @PluginMethod
    public void authenticate(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 30) {
            confirmScreenLock(call);
            return;
        }
        android.hardware.biometrics.BiometricPrompt prompt = new android.hardware.biometrics.BiometricPrompt.Builder(getContext())
            .setTitle(call.getString("title", "確認是你"))
            .setSubtitle(call.getString("subtitle", ""))
            .setAllowedAuthenticators(
                android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG |
                android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build();
        prompt.authenticate(
            new android.os.CancellationSignal(),
            getContext().getMainExecutor(),
            new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                    JSObject answer = new JSObject();
                    answer.put("ok", true);
                    call.resolve(answer);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    JSObject answer = new JSObject();
                    answer.put("ok", false);
                    answer.put("reason", String.valueOf(message));
                    call.resolve(answer);
                }
            }
        );
    }

    private void confirmScreenLock(PluginCall call) {
        android.app.KeyguardManager keyguard = getContext().getSystemService(android.app.KeyguardManager.class);
        Intent intent = keyguard.createConfirmDeviceCredentialIntent(call.getString("title", "確認是你"), call.getString("subtitle", ""));
        if (intent == null) {
            JSObject answer = new JSObject();
            answer.put("ok", false);
            answer.put("reason", "手機沒有設定螢幕鎖");
            call.resolve(answer);
            return;
        }
        startActivityForResult(call, intent, "screenLockConfirmed");
    }

    @ActivityCallback
    private void screenLockConfirmed(PluginCall call, ActivityResult result) {
        JSObject answer = new JSObject();
        answer.put("ok", result.getResultCode() == android.app.Activity.RESULT_OK);
        call.resolve(answer);
    }
}
