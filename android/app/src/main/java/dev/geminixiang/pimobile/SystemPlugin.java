package dev.geminixiang.pimobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.view.HapticFeedbackConstants;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;

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
        int tick = HapticFeedbackConstants.SEGMENT_TICK;
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
        openSettings(getContext(), new Intent(android.provider.Settings.ACTION_VOICE_INPUT_SETTINGS), android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
        call.resolve();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "");
        if (!url.startsWith("https://")) {
            call.reject("https URL required");
            return;
        }
        Context context = getContext();
        Background.run(call, () -> {
            File apk = new File(new File(context.getCacheDir(), "update"), "pi-mobile.apk");
            download(url, apk, sha256);
            requireSameApp(context, apk);
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
            context.startActivity(new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        });
    }

    private static void download(String url, File apk, String sha256) throws Exception {
        File folder = apk.getParentFile();
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("cannot create " + folder.getName());
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new UpdateFailure("download", "HTTP " + status);
            try (InputStream input = new DigestInputStream(connection.getInputStream(), digest); FileOutputStream output = new FileOutputStream(apk)) {
                input.transferTo(output);
            }
        } finally {
            connection.disconnect();
        }
        if (!HexFormat.of().formatHex(digest.digest()).equals(sha256)) throw new UpdateFailure("checksum", "the download does not match its SHA-256");
    }

    private static void requireSameApp(Context context, File apk) throws Exception {
        PackageManager packages = context.getPackageManager();
        PackageInfo archive = packages.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (archive == null || !context.getPackageName().equals(archive.packageName)) throw new UpdateFailure("not_this_app", "the download is not pi mobile");
        PackageInfo installed = packages.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (archive.signingInfo == null || !Arrays.equals(archive.signingInfo.getApkContentsSigners(), installed.signingInfo.getApkContentsSigners())) {
            throw new UpdateFailure("other_key", "the download is signed with another key");
        }
    }

    private static final class UpdateFailure extends Exception implements Background.Coded {
        private final String code;

        UpdateFailure(String code, String message) {
            super(message);
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }
    }

    static void openSettings(Context context, Intent preferred, String fallbackAction) {
        try {
            context.startActivity(preferred.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            context.startActivity(new Intent(fallbackAction).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }
}
