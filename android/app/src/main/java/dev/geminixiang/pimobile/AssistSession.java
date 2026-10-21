package dev.geminixiang.pimobile;

import android.app.assist.AssistStructure;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One summon of pi as the assistant: the system hands over what is on screen, the text of the app in front
 * (AssistStructure) and a screenshot, when the user allowed them in the assistant settings. They go to pi like a
 * share (TriggerStore's queue): the screenshot as a photo and the text as a file, in the composer, for the user to ask
 * about. pi sees the screen only when the user summons it.
 */
public class AssistSession extends VoiceInteractionSession {

    private static final String TAG = "PiAssist";
    /** The structure and the screenshot come separately; wait this long for the second. */
    private static final long WAIT_MS = 1500;

    private final Handler main = new Handler(Looper.getMainLooper());
    private String screenText;
    private String appName;
    private Bitmap screenshot;
    private boolean structureDone;
    private boolean screenshotDone;
    private boolean sent;

    AssistSession(Context context) {
        super(context);
    }

    @Override
    public void onShow(Bundle args, int flags) {
        super.onShow(args, flags);
        main.postDelayed(this::send, WAIT_MS);
    }

    @Override
    public void onHandleAssist(AssistState state) {
        AssistStructure structure = state.getAssistStructure();
        if (structure != null) {
            ComponentName activity = structure.getActivityComponent();
            if (activity != null) appName = label(activity.getPackageName());
            Set<String> lines = new LinkedHashSet<>();
            for (int i = 0; i < structure.getWindowNodeCount(); i++) collect(structure.getWindowNodeAt(i).getRootViewNode(), lines);
            screenText = String.join("\n", lines);
        }
        structureDone = true;
        if (screenshotDone) main.post(this::send);
    }

    @Override
    public void onHandleScreenshot(Bitmap bitmap) {
        screenshot = bitmap;
        screenshotDone = true;
        if (structureDone) main.post(this::send);
    }

    /** The visible text of a view tree, each distinct line once, in reading order. */
    private static void collect(AssistStructure.ViewNode node, Set<String> lines) {
        if (node == null || node.getVisibility() != android.view.View.VISIBLE) return;
        CharSequence text = node.getText();
        if (text != null && text.toString().trim().length() > 0) lines.add(text.toString().trim());
        else if (node.getContentDescription() != null && node.getContentDescription().toString().trim().length() > 0) {
            lines.add(node.getContentDescription().toString().trim());
        }
        for (int i = 0; i < node.getChildCount(); i++) collect(node.getChildAt(i), lines);
    }

    private String label(String packageName) {
        try {
            PackageManager manager = getContext().getPackageManager();
            return manager.getApplicationLabel(manager.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    /** Queue what was captured as a share from the assistant and open pi on it; once, whatever arrived by then. */
    private void send() {
        if (sent) return;
        sent = true;
        Context context = getContext();
        JSONObject event = new JSONObject();
        try {
            event.put("kind", "share");
            event.put("source", "assist");
            if (appName != null) event.put("subject", appName);
            JSONArray files = new JSONArray();
            if (screenshot != null) {
                File image = new File(TriggerStore.inbox(context), UUID.randomUUID() + ".jpg");
                try (FileOutputStream out = new FileOutputStream(image)) {
                    screenshot.compress(Bitmap.CompressFormat.JPEG, 85, out);
                }
                files.put(new JSONObject().put("path", image.getAbsolutePath()).put("name", "畫面.jpg").put("mimeType", "image/jpeg"));
            }
            if (screenText != null && !screenText.isEmpty()) {
                File text = new File(TriggerStore.inbox(context), UUID.randomUUID() + ".txt");
                try (FileOutputStream out = new FileOutputStream(text)) {
                    out.write(screenText.getBytes(StandardCharsets.UTF_8));
                }
                String name = (appName != null ? appName : "畫面") + " 的文字.txt";
                files.put(new JSONObject().put("path", text.getAbsolutePath()).put("name", name).put("mimeType", "text/plain"));
            }
            if (files.length() > 0) event.put("files", files);
        } catch (JSONException | IOException error) {
            Log.w(TAG, "could not keep the screen", error);
        }
        TriggerStore.enqueue(context, event);
        TriggersPlugin plugin = TriggersPlugin.live();
        if (plugin != null) plugin.announce();
        // pi's own task, not startAssistantActivity: that starts a second MainActivity in an assistant task, a second
        // WebView and runtime on the same storage. Starting from the session is allowed while its window shows.
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(open);
        finish();
    }
}
