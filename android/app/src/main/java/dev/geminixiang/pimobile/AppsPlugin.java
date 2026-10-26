package dev.geminixiang.pimobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.AlarmClock;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import org.json.JSONException;

@CapacitorPlugin(name = "Apps")
public class AppsPlugin extends Plugin {

    private void launch(PluginCall call, Intent intent) {
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app on this phone handles this", "NO_APP");
        } catch (SecurityException e) {
            call.reject("the system blocked this: " + e.getMessage(), "BLOCKED");
        }
    }

    @PluginMethod
    public void setAlarm(PluginCall call) {
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, call.getInt("hour", 0))
            .putExtra(AlarmClock.EXTRA_MINUTES, call.getInt("minute", 0))
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        JSArray days = call.getArray("days");
        if (days != null && days.length() > 0) {
            ArrayList<Integer> list = new ArrayList<>();
            try {
                for (int i = 0; i < days.length(); i++) list.add(days.getInt(i));
            } catch (JSONException e) {
                call.reject("days must be numbers");
                return;
            }
            intent.putExtra(AlarmClock.EXTRA_DAYS, list);
        }
        launch(call, intent);
    }

    @PluginMethod
    public void setTimer(PluginCall call) {
        Intent intent = new Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, call.getInt("seconds", 60))
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        launch(call, intent);
    }

    @PluginMethod
    public void composeEmail(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"));
        try {
            JSArray to = call.getArray("to", new JSArray());
            String[] addresses = new String[to.length()];
            for (int i = 0; i < to.length(); i++) addresses[i] = to.getString(i);
            intent.putExtra(Intent.EXTRA_EMAIL, addresses);
        } catch (JSONException e) {
            call.reject("to must be strings");
            return;
        }
        String subject = call.getString("subject");
        if (subject != null) intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        intent.putExtra(Intent.EXTRA_TEXT, call.getString("body", ""));
        launch(call, intent);
    }

    @PluginMethod
    public void composeSms(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(call.getString("to", ""))))
            .putExtra("sms_body", call.getString("body", ""));
        launch(call, intent);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String uri = call.getString("uri", "");
        launch(call, new Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addCategory(Intent.CATEGORY_BROWSABLE));
    }

    private Uri stage(PluginCall call, String base64) throws IOException {
        File dir = new File(getContext().getCacheDir(), "share");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (!f.delete()) f.deleteOnExit();
        File file = new File(dir, new File(call.getString("fileName", "file")).getName());
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(Base64.decode(base64, Base64.DEFAULT));
        }
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        Uri uri;
        try {
            uri = stage(call, call.getString("fileBase64", ""));
        } catch (IOException e) {
            call.reject("could not stage the file: " + e.getMessage());
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, call.getString("mimeType", "application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        launch(call, view);
    }

    @PluginMethod
    public void share(PluginCall call) {
        Intent send = new Intent(Intent.ACTION_SEND);
        String text = call.getString("text");
        if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
        String data = call.getString("fileBase64");
        if (data != null) {
            Uri uri;
            try {
                uri = stage(call, data);
            } catch (IOException e) {
                call.reject("could not stage the file: " + e.getMessage());
                return;
            }
            send.putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setType(call.getString("mimeType", "application/octet-stream"));
        } else {
            send.setType("text/plain");
        }
        String title = call.getString("title");
        if (title != null) send.putExtra(Intent.EXTRA_TITLE, title);
        launch(call, Intent.createChooser(send, title));
    }
}
