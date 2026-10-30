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
import android.os.SystemClock;
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
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "PhoneScreen")
public class PhoneScreenPlugin extends Plugin {

    private static final int SHOT_WIDTH = 540;
    private static final int MAX_ELEMENTS = 160;
    private static final int MAX_LABEL = 60;
    private static final long QUIET_MS = 350;
    private static final long FIRST_CHANGE_MS = 1000;
    private static final long TREE_RETRY_MS = 200;
    private static final long READ_BACK_MS = 1500;
    private static final long SETTLE_CAP_MS = 2500;
    private static final long ELEMENTS_MS = 2500;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService screenshots = Executors.newSingleThreadExecutor();
    private float lastTapX = -1;
    private float lastTapY = -1;
    private String lastSeen;

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
            List<String> did = new ArrayList<>();
            String before = lastSeen;
            try {
                for (int i = 0; i < steps.length(); i++) {
                    JSONObject step = steps.getJSONObject(i);
                    long since = SystemClock.uptimeMillis();
                    try {
                        String touched = run(service, step);
                        if (touched != null) did.add(touched);
                    } catch (StepFailure e) {
                        failure = "step " + (i + 1) + " (" + step.optString("action") + "): " + e.getMessage();
                        break;
                    }
                    done = i + 1;
                    if (!"wait".equals(step.optString("action"))) settle(service, since, i + 1 < steps.length() ? 1500 : SETTLE_CAP_MS);
                }
                JSObject result = snapshot(service, call.getBoolean("screenshot", false));
                result.put("done", done);
                if (done > 0 && lastSeen.equals(before)) result.put("unchanged", true);
                if (!did.isEmpty()) result.put("did", new JSONArray(did));
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

    private String run(PhoneScreenService service, JSONObject step) throws StepFailure, InterruptedException {
        float scale = scale(service);
        String action = step.optString("action");
        switch (action) {
            case "tap": {
                lastTapX = at(step, "x", scale);
                lastTapY = at(step, "y", scale);
                String target = describedAt(service, lastTapX, lastTapY, scale);
                gesture(service, line(lastTapX, lastTapY, lastTapX, lastTapY), 60);
                return "tapped " + target;
            }
            case "long_press": {
                float x = at(step, "x", scale);
                float y = at(step, "y", scale);
                String target = describedAt(service, x, y, scale);
                gesture(service, line(x, y, x, y), 700);
                return "long-pressed " + target;
            }
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
        return null;
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

    private void type(PhoneScreenService service, String text, boolean replace) throws StepFailure, InterruptedException {
        AccessibilityNodeInfo focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        AccessibilityNodeInfo field = focused != null && focused.isEditable() ? focused : editableAt(service.getRootInActiveWindow());
        if (field == null) field = focused;
        if (field == null) throw new StepFailure("no text field has focus: tap one first");
        if (field.isEditable()) {
            String before = replace ? "" : shown(field);
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, before + text);
            if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
                readBack(field, text);
                return;
            }
        }
        if (replace) throw new StepFailure("this field cannot be emptied here: select its text and delete it");
        ClipboardManager clipboard = service.getSystemService(ClipboardManager.class);
        clipboard.setPrimaryClip(ClipData.newPlainText("pi", text));
        if (field.performAction(AccessibilityNodeInfo.ACTION_PASTE)) {
            readBack(field, text);
            return;
        }
        throw new StepFailure("this field takes no typed text, but the text is on the clipboard: long_press in the field and tap 貼上 (Paste)");
    }

    private void readBack(AccessibilityNodeInfo field, String typed) throws StepFailure, InterruptedException {
        if (typed.isEmpty() || field.isPassword()) return;
        long end = SystemClock.uptimeMillis() + READ_BACK_MS;
        String wanted = comparable(typed);
        while (SystemClock.uptimeMillis() < end) {
            field.refresh();
            if (comparable(shown(field)).contains(wanted)) return;
            Thread.sleep(100);
        }
        throw new StepFailure("the field shows \"" + clip(shown(field)) + "\", not what was typed; read the screen and type again or into another field");
    }

    private static String shown(AccessibilityNodeInfo field) {
        CharSequence text = field.getText();
        return text == null || field.isShowingHintText() ? "" : text.toString();
    }

    private static String comparable(String text) {
        StringBuilder kept = new StringBuilder();
        text.codePoints().filter(Character::isLetterOrDigit).forEach(kept::appendCodePoint);
        return kept.toString();
    }

    private AccessibilityNodeInfo editableAt(AccessibilityNodeInfo node) {
        if (node == null || !node.isVisibleToUser()) return null;
        if (node.isEditable() && (node.isFocused() || contains(node, Math.round(lastTapX), Math.round(lastTapY)))) return node;
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

    private void settle(PhoneScreenService service, long since, long cap) throws InterruptedException {
        long start = SystemClock.uptimeMillis();
        while (service.lastChangeAt() <= since && SystemClock.uptimeMillis() - start < FIRST_CHANGE_MS) Thread.sleep(50);
        while (SystemClock.uptimeMillis() - service.lastChangeAt() < QUIET_MS && SystemClock.uptimeMillis() - start < cap) Thread.sleep(50);
    }

    private JSObject snapshot(PhoneScreenService service, boolean withScreenshot) throws InterruptedException {
        DisplayMetrics screen = metrics(service);
        float scale = (float) SHOT_WIDTH / screen.widthPixels;
        JSObject result = new JSObject();
        result.put("width", SHOT_WIDTH);
        result.put("height", Math.round(screen.heightPixels * scale));
        long deadline = System.currentTimeMillis() + ELEMENTS_MS;
        AccessibilityNodeInfo active = null;
        boolean keyboard = false;
        List<String> lines = new ArrayList<>();
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        for (int attempt = 0; lines.isEmpty() && System.currentTimeMillis() < deadline; attempt++) {
            if (attempt > 0) Thread.sleep(TREE_RETRY_MS);
            active = service.getRootInActiveWindow();
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
                walk(root, scale, false, lines, nodes, deadline);
                if (lines.size() > before && windows.size() > 1) {
                    CharSequence title = window.getTitle();
                    lines.add(before, "# " + kindOf(window) + (title == null ? "" : " " + clip(title.toString())));
                    nodes.add(before, null);
                }
                if (lines.size() >= MAX_ELEMENTS || System.currentTimeMillis() > deadline) break;
            }
            if (windows.isEmpty() && active != null) walk(active, scale, false, lines, nodes, deadline);
        }
        if (active != null && active.getPackageName() != null) {
            String pkg = active.getPackageName().toString();
            result.put("package", pkg);
            result.put("app", NotificationsListener.appLabel(service.getPackageManager(), pkg));
        }
        withOwners(lines, nodes, deadline);
        if (System.currentTimeMillis() > deadline) result.put("slow", true);
        result.put("keyboard", keyboard);
        String elements = String.join("\n", lines.subList(0, Math.min(lines.size(), MAX_ELEMENTS)));
        result.put("elements", elements);
        result.put("more", Math.max(0, lines.size() - MAX_ELEMENTS));
        lastSeen = result.optString("package") + "\n" + elements;
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

    private static void texts(AccessibilityNodeInfo node, AccessibilityNodeInfo skipped, StringBuilder into, long deadline) {
        for (int i = 0; i < node.getChildCount() && into.length() <= MAX_LABEL && System.currentTimeMillis() <= deadline; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null || !child.isVisibleToUser() || child.equals(skipped)) continue;
            String label = ownLabel(child);
            if (!label.isEmpty()) into.append(into.length() > 0 ? " · " : "").append(label);
            texts(child, null, into, deadline);
        }
    }

    private void walk(AccessibilityNodeInfo node, float scale, boolean insideButton, List<String> lines, List<AccessibilityNodeInfo> nodes, long deadline) {
        if (lines.size() >= MAX_ELEMENTS + 1 || System.currentTimeMillis() > deadline || !node.isVisibleToUser()) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        boolean clickable = node.isClickable() || node.isLongClickable();
        boolean editable = node.isEditable();
        boolean scrollable = node.isScrollable();
        boolean checkable = node.isCheckable();
        String label = clickable && !editable ? labelOf(node, deadline) : ownLabel(node);
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
            if (!label.isEmpty()) line.append(' ').append(quoted(label));
            line.append(" at ").append(Math.round(bounds.exactCenterX() * scale)).append(',').append(Math.round(bounds.exactCenterY() * scale));
            if (scrollable && !"list".equals(role)) line.append(" scrollable");
            if (node.isFocused()) line.append(" focused");
            if (node.isSelected()) line.append(" selected");
            if (!node.isEnabled()) line.append(" disabled");
            lines.add(line.toString());
            nodes.add(node);
        }
        boolean inside = insideButton || (clickable && !editable);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) walk(child, scale, inside, lines, nodes, deadline);
        }
    }

    private static void withOwners(List<String> lines, List<AccessibilityNodeInfo> nodes, long deadline) {
        List<String> shapes = lines.stream().map(PhoneScreenPlugin::shapeOf).toList();
        Map<String, Integer> seen = new HashMap<>();
        for (String shape : shapes) seen.merge(shape, 1, Integer::sum);
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            String shape = shapes.get(i);
            AccessibilityNodeInfo node = nodes.get(i);
            if (node == null || !actionable(node) || seen.get(shape) < 2) continue;
            String owner = ownerOf(node, deadline);
            if (!owner.isEmpty()) lines.set(i, shape + " in " + quoted(owner) + line.substring(shape.length()));
        }
    }

    private static String shapeOf(String line) {
        int at = line.lastIndexOf(" at ");
        return at < 0 ? line : line.substring(0, at);
    }

    private static String ownerOf(AccessibilityNodeInfo node, long deadline) {
        StringBuilder around = new StringBuilder();
        AccessibilityNodeInfo from = node;
        for (AccessibilityNodeInfo parent = node.getParent(); parent != null; from = parent, parent = parent.getParent()) {
            texts(parent, from, around, deadline);
            if (around.length() > MAX_LABEL || System.currentTimeMillis() > deadline) return "";
            List<String> words = Arrays.stream(around.toString().split(" · ")).filter((part) -> part.codePoints().anyMatch(Character::isLetterOrDigit)).toList();
            if (!words.isEmpty()) return String.join(" · ", words);
        }
        return "";
    }

    private static String quoted(String text) {
        return "\"" + text.replace("\"", "'") + "\"";
    }

    private static String labelOf(AccessibilityNodeInfo node, long deadline) {
        String own = ownLabel(node);
        if (!own.isEmpty()) return own;
        StringBuilder inner = new StringBuilder();
        texts(node, null, inner, deadline);
        return clip(inner.toString());
    }

    private String describedAt(PhoneScreenService service, float x, float y, float scale) {
        long deadline = System.currentTimeMillis() + ELEMENTS_MS;
        int px = Math.round(x);
        int py = Math.round(y);
        AccessibilityNodeInfo hit = null;
        Rect area = new Rect();
        for (AccessibilityWindowInfo window : service.getWindows()) {
            window.getBoundsInScreen(area);
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD || !area.contains(px, py)) continue;
            hit = smallestAt(window.getRoot(), px, py, null, deadline);
            break;
        }
        String point = "at " + Math.round(x * scale) + "," + Math.round(y * scale);
        if (hit == null) return point + ", where nothing takes a tap";
        String owner = ownerOf(hit, deadline);
        return quoted(labelOf(hit, deadline)) + (owner.isEmpty() ? "" : " in " + quoted(owner)) + " " + point;
    }

    private static AccessibilityNodeInfo smallestAt(AccessibilityNodeInfo node, int x, int y, AccessibilityNodeInfo best, long deadline) {
        if (node == null || !node.isVisibleToUser() || !contains(node, x, y) || System.currentTimeMillis() > deadline) return best;
        AccessibilityNodeInfo smallest = actionable(node) && (best == null || areaOf(node) < areaOf(best)) ? node : best;
        for (int i = 0; i < node.getChildCount(); i++) smallest = smallestAt(node.getChild(i), x, y, smallest, deadline);
        return smallest;
    }

    private static long areaOf(AccessibilityNodeInfo node) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return (long) bounds.width() * bounds.height();
    }

    private static boolean contains(AccessibilityNodeInfo node, int x, int y) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return bounds.contains(x, y);
    }

    private static boolean actionable(AccessibilityNodeInfo node) {
        return node.isClickable() || node.isLongClickable() || node.isEditable() || node.isCheckable();
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
