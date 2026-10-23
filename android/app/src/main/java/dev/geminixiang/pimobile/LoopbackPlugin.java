package dev.geminixiang.pimobile;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "Loopback")
public class LoopbackPlugin extends Plugin {

    private static final int WAIT_MS = 10 * 60_000;
    private static final String BACK = "dev.geminixiang.pimobile:/back";
    private ServerSocket server;

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", 0);
        String path = call.getString("path", "/");
        stopServer();
        ServerSocket socket;
        try {
            socket = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"));
            socket.setSoTimeout(WAIT_MS);
        } catch (IOException e) {
            call.reject("cannot listen on 127.0.0.1:" + port + ": " + e.getMessage());
            return;
        }
        synchronized (this) {
            server = socket;
        }
        JSObject result = new JSObject();
        result.put("port", socket.getLocalPort());
        call.resolve(result);
        new Thread(() -> serve(socket, path)).start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    private void serve(ServerSocket socket, String path) {
        try {
            while (!socket.isClosed()) {
                try (Socket client = socket.accept()) {
                    client.setSoTimeout(10_000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    String line = reader.readLine();
                    String[] parts = line == null ? new String[0] : line.split(" ");
                    boolean ours = parts.length >= 2 && "GET".equals(parts[0]) && parts[1].startsWith(path);
                    reply(client.getOutputStream(), ours);
                    if (!ours) continue;
                    JSObject event = new JSObject();
                    event.put("url", "http://127.0.0.1:" + socket.getLocalPort() + parts[1]);
                    notifyListeners("redirect", event);
                    break;
                }
            }
        } catch (SocketTimeoutException e) {
        } catch (IOException e) {
        } finally {
            closeQuietly(socket);
        }
    }

    private static void reply(OutputStream out, boolean ours) throws IOException {
        String body = ours
            ? "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>pi mobile</title>" +
            "<body style=\"font-family:system-ui;background:#161d27;color:#ebe7e4;padding:40px 24px\"><h2>登入完成</h2>" +
            "<p><a href=\"" + BACK + "\" style=\"color:#8fb3d9\">回到 pi mobile</a>，這個分頁可以關掉。</p>" +
            "<script>location.href = \"" + BACK + "\";</script>"
            : "";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = (ours ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found") +
            "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private synchronized void stopServer() {
        if (server != null) closeQuietly(server);
        server = null;
    }

    private static void closeQuietly(ServerSocket socket) {
        try {
            socket.close();
        } catch (IOException error) {
            Log.w("pi.loopback", "could not close the redirect server", error);
        }
    }
}
