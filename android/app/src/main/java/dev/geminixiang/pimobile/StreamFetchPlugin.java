package dev.geminixiang.pimobile;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "StreamFetch")
public class StreamFetchPlugin extends Plugin {

    private final Map<String, HttpURLConnection> open = new ConcurrentHashMap<>();
    private final Set<String> aborted = ConcurrentHashMap.newKeySet();
    private int next = 0;

    @PluginMethod
    public void start(PluginCall call) {
        String id = "f" + (++next);
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers", new JSObject());
        String text = call.getString("body");
        String base64 = call.getString("bodyBase64");
        byte[] body = base64 != null ? Base64.decode(base64, Base64.NO_WRAP) : text != null ? text.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;
        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
        new Thread(() -> run(id, url, method, headers, body)).start();
    }

    @PluginMethod
    public void abort(PluginCall call) {
        String id = call.getString("id", "");
        aborted.add(id);
        HttpURLConnection connection = open.remove(id);
        if (connection != null) connection.disconnect();
        call.resolve();
    }

    private void run(String id, String url, String method, JSObject headers, byte[] body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            open.put(id, connection);
            if (aborted.contains(id)) return;
            connection.setRequestMethod(method);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);
            for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
                String key = keys.next();
                connection.setRequestProperty(key, headers.getString(key));
            }
            if (body != null) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body);
                }
            }
            int status = connection.getResponseCode();
            if (aborted.contains(id)) return;
            JSObject head = new JSObject();
            head.put("id", id);
            head.put("status", status);
            JSObject responseHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() != null) responseHeaders.put(entry.getKey().toLowerCase(java.util.Locale.ROOT), String.join(", ", entry.getValue()));
            }
            head.put("headers", responseHeaders);
            notifyListeners("head", head);
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in != null) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1 && !aborted.contains(id)) {
                    JSObject chunk = new JSObject();
                    chunk.put("id", id);
                    chunk.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                    notifyListeners("chunk", chunk);
                }
                in.close();
            }
            if (aborted.contains(id)) return;
            JSObject end = new JSObject();
            end.put("id", id);
            notifyListeners("end", end);
        } catch (Exception e) {
            if (aborted.contains(id)) return;
            JSObject error = new JSObject();
            error.put("id", id);
            error.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            notifyListeners("error", error);
        } finally {
            open.remove(id);
            aborted.remove(id);
            if (connection != null) connection.disconnect();
        }
    }
}
