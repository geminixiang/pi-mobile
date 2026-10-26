package dev.geminixiang.pimobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "PhoneScreen")
public class PhoneScreenPlugin extends Plugin {

    private static final int SHOT_WIDTH = 540;
    private static final int MAX_ELEMENTS = 160;
    private static final int MAX_LABEL = 60;
    private static final long QUIET_MS = 350;
    private static final long SETTLE_CAP_MS = 2500;
    private static final long ELEMENTS_MS = 2500;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService screenshots = Executors.newSingleThreadExecutor();
    private float lastTapX = -1;
    private float lastTapY = -1;

    static class StepFailure extends Exception {
        StepFailure(String message) {
            super(message);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", PhoneScreenService.running != null);
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Intent detail = new Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, new ComponentName(getContext(), PhoneScreenService.class).flattenToString())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (detail.resolveActivity(getContext().getPackageManager()) != null) intent = detail;
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openAppInfo(PluginCall call) {
        getContext().startActivity(
            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null)).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
            )
        );
        call.resolve();
    }

    @PluginMethod
    public void read(PluginCall call) {
        PhoneScreenService service = PhoneScreenService.running;
        if (service == null) {
            call.reject("off");
            return;
        }
        worker.execute(() -> {
            try {
                call.resolve(snapshot(service, call.getBoolean("screenshot", false)));
            } catch (RuntimeException | InterruptedException e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void act(PluginCall call) {
        PhoneScreenService service = PhoneScreenService.running;
        if (service == null) {
            call.reject("off");
            return;
        }
        JSArray steps = call.getArray("steps");
        worker.execute(() -> {
            String failure = null;
            int done = 0;
            try {
                for (int i = 0; i < steps.length(); i++) {
                    JSONObject step = steps.getJSONObject(i);
                    try {
                        run(service, step);
                    } catch (StepFailure e) {
                        failure = "step " + (i + 1) + " (" + step.optString("action") + "): " + e.getMessage();
                        break;
                    }
                    done = i + 1;
                    settle(service, i + 1 < steps.length() ? 1500 : SETTLE_CAP_MS);
                }
                JSObject result = snapshot(service, call.getBoolean("screenshot", false));
                result.put("done", done);
                if (failure != null) result.put("error", failure);
                call.resolve(result);
            } catch (JSONException | RuntimeException | InterruptedException e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private DisplayMetrics metrics(PhoneScreenService service) {
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windows = service.getSystemService(WindowManager.class);
        windows.getDefaultDisplay().getRealMetrics(metrics);
        return metrics;
    }

    private float scale(PhoneScreenService service) {
        return (float) SHOT_WIDTH / metrics(service).widthPixels;
    }

    private void run(PhoneScreenService service, JSONObject step) throws StepFailure, InterruptedException {
        float scale = scale(service);
        String action = step.optString("action");
        switch (action) {
            case "tap":
                lastTapX = at(step, "x", scale);
                lastTapY = at(step, "y", scale);
                gesture(service, line(at(step, "x", scale), at(step, "y", scale), at(step, "x", scale), at(step, "y", scale)), 60);
                break;
            case "long_press":
                gesture(service, line(at(step, "x", scale), at(step, "y", scale), at(step, "x", scale), at(step, "y", scale)), 700);
                break;
            case "swipe":
                gesture(
                    service,
                    line(at(step, "x", scale), at(step, "y", scale), at(step, "to_x", scale), at(step, "to_y", scale)),
                    step.optInt("ms", 300)
                );
                break;
            case "scroll":
                scroll(service, step, scale);
                break;
            case "type":
                type(service, step.optString("text"), false);
                break;
            case "clear":
                type(service, "", true);
                break;
            case "key":
                key(service, step.optString("keys"));
                break;
            case "open":
                open(service, step.optString("app"));
                break;
            case "wait":
                Thread.sleep(Math.min(10000, Math.max(0, step.optInt("ms", 500))));
                break;
            default:
                throw new StepFailure("unknown action");
        }
    }

    private float at(JSONObject step, String field, float scale) throws StepFailure {
        if (!step.has(field)) throw new StepFailure("needs " + field);
        return (float) step.optDouble(field) / scale;
    }

    private Path line(float x, float y, float toX, float toY) {
        Path path = new Path();
        path.moveTo(Math.max(0, x), Math.max(0, y));
        path.lineTo(Math.max(0, toX), Math.max(0, toY));
        return path;
    }

    private void gesture(PhoneScreenService service, Path path, int ms) throws StepFailure, InterruptedException {
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(1, Math.min(5000, ms))))
            .build();
        CountDownLatch finished = new CountDownLatch(1);
        boolean[] completed = { false };
        boolean sent = service.dispatchGesture(
            gesture,
            new AccessibilityService.GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription description) {
                    completed[0] = true;
                    finished.countDown();
                }

                @Override
                public void onCancelled(GestureDescription description) {
                    finished.countDown();
                }
            },
            null
        );
        if (!sent || !finished.await(ms + 3000L, TimeUnit.MILLISECONDS) || !completed[0]) {
            throw new StepFailure("the system cancelled the gesture");
        }
    }

    private void scroll(PhoneScreenService service, JSONObject step, float scale) throws StepFailure, InterruptedException {
        DisplayMetrics screen = metrics(service);
        float x = step.has("x") ? at(step, "x", scale) : screen.widthPixels / 2f;
        float y = step.has("y") ? at(step, "y", scale) : screen.heightPixels / 2f;
        float dx = 0;
        float dy = 0;
        switch (step.optString("direction", "down")) {
            case "down":
                dy = -screen.heightPixels * 0.35f;
                break;
            case "up":
                dy = screen.heightPixels * 0.35f;
                break;
            case "right":
                dx = -screen.widthPixels * 0.6f;
                break;
            case "left":
                dx = screen.widthPixels * 0.6f;
                break;
            default:
                throw new StepFailure("direction is up, down, left, or right");
        }
        float fromX = Math.min(screen.widthPixels - 1, Math.max(1, x - dx / 2));
        float fromY = Math.min(screen.heightPixels - 1, Math.max(1, y - dy / 2));
        gesture(service, line(fromX, fromY, fromX + dx, fromY + dy), 350);
    }

    private void type(PhoneScreenService service, String text, boolean replace) throws StepFailure {
        AccessibilityNodeInfo focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        AccessibilityNodeInfo field = focused != null && focused.isEditable() ? focused : editableAt(service.getRootInActiveWindow());
        if (field == null) field = focused;
        if (field == null) throw new StepFailure("no text field has focus: tap one first");
        if (field.isEditable()) {
            CharSequence current = field.getText();
            boolean hint = field.isShowingHintText();
            String before = replace || hint || current == null ? "" : current.toString();
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, before + text);
            if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return;
        }
        if (replace) throw new StepFailure("this field cannot be emptied here: select its text and delete it");
        ClipboardManager clipboard = service.getSystemService(ClipboardManager.class);
        clipboard.setPrimaryClip(ClipData.newPlainText("pi", text));
        if (field.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return;
        throw new StepFailure("this field takes no typed text, but the text is on the clipboard: long_press in the field and tap 貼上 (Paste)");
    }

    private AccessibilityNodeInfo editableAt(AccessibilityNodeInfo node) {
        if (node == null || !node.isVisibleToUser()) return null;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (node.isEditable() && (node.isFocused() || bounds.contains(Math.round(lastTapX), Math.round(lastTapY)))) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = editableAt(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private void key(PhoneScreenService service, String key) throws StepFailure {
        switch (key) {
            case "back":
                global(service, AccessibilityService.GLOBAL_ACTION_BACK);
                break;
            case "home":
                global(service, AccessibilityService.GLOBAL_ACTION_HOME);
                break;
            case "recents":
                global(service, AccessibilityService.GLOBAL_ACTION_RECENTS);
                break;
            case "notifications":
                global(service, AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS);
                break;
            case "quick_settings":
                global(service, AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS);
                break;
            case "enter":
                AccessibilityNodeInfo field = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (field == null) throw new StepFailure("no text field has focus");
                if (!field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
                    throw new StepFailure("the field has no enter action: tap the send or search button");
                }
                break;
            default:
                throw new StepFailure("keys is back, home, recents, notifications, quick_settings, or enter");
        }
    }

    private void global(PhoneScreenService service, int action) throws StepFailure {
        if (!service.performGlobalAction(action)) throw new StepFailure("the system refused it");
    }

    private final Map<String, String> launchers = new LinkedHashMap<>();

    private void loadLaunchers(PackageManager packages) {
        launchers.clear();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo info : packages.queryIntentActivities(launcher, 0)) {
            launchers.put(info.activityInfo.packageName, String.valueOf(info.loadLabel(packages)));
        }
    }

    private String match(String wanted) {
        String partial = null;
        String within = null;
        int withinLength = 2;
        for (Map.Entry<String, String> app : launchers.entrySet()) {
            String label = app.getValue().toLowerCase(Locale.ROOT);
            if (app.getKey().equalsIgnoreCase(wanted) || label.equals(wanted)) return app.getKey();
            if (partial == null && label.contains(wanted)) partial = app.getKey();
            if (label.length() > withinLength && wanted.contains(label)) {
                within = app.getKey();
                withinLength = label.length();
            }
        }
        return partial != null ? partial : within;
    }

    private void open(PhoneScreenService service, String name) throws StepFailure {
        String wanted = name.trim().toLowerCase(Locale.ROOT);
        if (wanted.isEmpty()) throw new StepFailure("needs app");
        PackageManager packages = service.getPackageManager();
        String pkg = launchers.isEmpty() ? null : match(wanted);
        Intent intent = pkg == null ? null : packages.getLaunchIntentForPackage(pkg);
        if (intent == null) {
            loadLaunchers(packages);
            pkg = match(wanted);
            intent = pkg == null ? null : packages.getLaunchIntentForPackage(pkg);
        }
        if (intent == null) throw new StepFailure("no installed app is called " + name + "; the apps are: " + String.join(", ", launchers.values()));
        service.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
        long until = System.currentTimeMillis() + 4000;
        while (System.currentTimeMillis() < until && !pkg.equals(frontPackage(service))) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private static String frontPackage(PhoneScreenService service) {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        return root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
    }

    private void settle(PhoneScreenService service, long cap) throws InterruptedException {
        long start = System.currentTimeMillis();
        Thread.sleep(150);
        while (service.quietFor() < QUIET_MS && System.currentTimeMillis() - start < cap) Thread.sleep(50);
    }

    private JSObject snapshot(PhoneScreenService service, boolean withScreenshot) throws InterruptedException {
        DisplayMetrics screen = metrics(service);
        float scale = (float) SHOT_WIDTH / screen.widthPixels;
        JSObject result = new JSObject();
        result.put("width", SHOT_WIDTH);
        result.put("height", Math.round(screen.heightPixels * scale));
        AccessibilityNodeInfo active = service.getRootInActiveWindow();
        for (int wait = 0; active == null && wait < 15; wait++) {
            Thread.sleep(100);
            active = service.getRootInActiveWindow();
        }
        if (active != null && active.getPackageName() != null) {
            String pkg = active.getPackageName().toString();
            result.put("package", pkg);
            result.put("app", NotificationsListener.appLabel(service.getPackageManager(), pkg));
        }
        boolean keyboard = false;
        long deadline = System.currentTimeMillis() + ELEMENTS_MS;
        List<String> lines = new ArrayList<>();
        List<AccessibilityWindowInfo> windows = service.getWindows();
        for (AccessibilityWindowInfo window : windows) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                keyboard = true;
                continue;
            }
            Rect area = new Rect();
            window.getBoundsInScreen(area);
            boolean sliver = area.height() < screen.heightPixels / 8 || area.width() < screen.widthPixels / 8;
            if (window.getType() == AccessibilityWindowInfo.TYPE_SYSTEM && sliver) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            int before = lines.size();
            walk(root, scale, false, lines, deadline);
            if (lines.size() > before && windows.size() > 1) {
                CharSequence title = window.getTitle();
                lines.add(before, "# " + kindOf(window) + (title == null ? "" : " " + clip(title.toString())));
            }
            if (lines.size() >= MAX_ELEMENTS || System.currentTimeMillis() > deadline) break;
        }
        if (windows.isEmpty() && active != null) walk(active, scale, false, lines, deadline);
        if (System.currentTimeMillis() > deadline) result.put("slow", true);
        result.put("keyboard", keyboard);
        result.put("elements", String.join("\n", lines.subList(0, Math.min(lines.size(), MAX_ELEMENTS))));
        result.put("more", Math.max(0, lines.size() - MAX_ELEMENTS));
        if (!withScreenshot) return result;
        String shot = screenshot(service, scale, result);
        if (shot != null) result.put("jpeg", shot);
        return result;
    }

    private String kindOf(AccessibilityWindowInfo window) {
        switch (window.getType()) {
            case AccessibilityWindowInfo.TYPE_SYSTEM:
                return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY:
                return "overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER:
                return "divider";
            default:
                return "app";
        }
    }

    private static String clip(String text) {
        String flat = text.replaceAll("\\s+", " ").trim();
        return flat.length() > MAX_LABEL ? flat.substring(0, MAX_LABEL) + "…" : flat;
    }

    private static String ownLabel(AccessibilityNodeInfo node) {
        CharSequence text = node.getText();
        if (node.isPassword()) return text == null || text.length() == 0 ? "" : "••••";
        if (text != null && text.toString().trim().length() > 0) return clip(text.toString());
        CharSequence description = node.getContentDescription();
        if (description != null && description.toString().trim().length() > 0) return clip(description.toString());
        CharSequence hint = node.getHintText();
        if (hint != null && hint.toString().trim().length() > 0) return clip(hint.toString());
        return "";
    }

    private static void texts(AccessibilityNodeInfo node, StringBuilder into, long deadline) {
        if (into.length() > MAX_LABEL || System.currentTimeMillis() > deadline) return;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null || !child.isVisibleToUser()) continue;
            String label = ownLabel(child);
            if (!label.isEmpty()) into.append(into.length() > 0 ? " · " : "").append(label);
            texts(child, into, deadline);
        }
    }

    private void walk(AccessibilityNodeInfo node, float scale, boolean insideButton, List<String> lines, long deadline) {
        if (lines.size() >= MAX_ELEMENTS + 1 || System.currentTimeMillis() > deadline || !node.isVisibleToUser()) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        boolean clickable = node.isClickable() || node.isLongClickable();
        boolean editable = node.isEditable();
        boolean scrollable = node.isScrollable();
        boolean checkable = node.isCheckable();
        String label = ownLabel(node);
        if (clickable && label.isEmpty() && !editable) {
            StringBuilder inner = new StringBuilder();
            texts(node, inner, deadline);
            label = clip(inner.toString());
        }
        String role = editable
            ? "field"
            : checkable
                ? (node.isChecked() ? "checked" : "unchecked")
                : clickable
                    ? "button"
                    : scrollable
                        ? "list"
                        : label.isEmpty() || insideButton ? null : "text";
        if (role != null && !bounds.isEmpty()) {
            StringBuilder line = new StringBuilder(role);
            if (!label.isEmpty()) line.append(" \"").append(label.replace("\"", "'")).append('"');
            line.append(" at ").append(Math.round(bounds.exactCenterX() * scale)).append(',').append(Math.round(bounds.exactCenterY() * scale));
            if (scrollable && !"list".equals(role)) line.append(" scrollable");
            if (node.isFocused()) line.append(" focused");
            if (node.isSelected()) line.append(" selected");
            if (!node.isEnabled()) line.append(" disabled");
            lines.add(line.toString());
        }
        boolean inside = insideButton || (clickable && !editable);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) walk(child, scale, inside, lines, deadline);
        }
    }

    private String screenshot(PhoneScreenService service, float scale, JSObject result) throws InterruptedException {
        for (int attempt = 0; attempt < 4; attempt++) {
            CountDownLatch done = new CountDownLatch(1);
            Bitmap[] shot = { null };
            int[] code = { 0 };
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                screenshots,
                new AccessibilityService.TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(AccessibilityService.ScreenshotResult screenshot) {
                        HardwareBuffer buffer = screenshot.getHardwareBuffer();
                        Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, screenshot.getColorSpace());
                        if (hardware != null) {
                            shot[0] = hardware.copy(Bitmap.Config.ARGB_8888, false);
                            hardware.recycle();
                        }
                        buffer.close();
                        done.countDown();
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        code[0] = errorCode;
                        done.countDown();
                    }
                }
            );
            if (!done.await(5, TimeUnit.SECONDS)) break;
            if (shot[0] != null) {
                Bitmap full = shot[0];
                Bitmap small = Bitmap.createScaledBitmap(full, SHOT_WIDTH, Math.round(full.getHeight() * scale), true);
                full.recycle();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 70, out);
                small.recycle();
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            }
            if (code[0] == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) {
                result.put("shotError", "the app on screen blocks screenshots; only its elements are listed");
                return null;
            }
            if (code[0] != AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) break;
            Thread.sleep(400);
        }
        result.put("shotError", "the screenshot failed");
        return null;
    }
}
