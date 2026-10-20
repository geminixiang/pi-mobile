package dev.geminixiang.pimobile;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.trilead.ssh2.ChannelCondition;
import com.trilead.ssh2.Connection;
import com.trilead.ssh2.Session;
import com.trilead.ssh2.crypto.keys.Ed25519Provider;
import com.trilead.ssh2.signature.Ed25519Verify;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * SSH from the phone, for pi-env daemons on the owner's machines (docs/design/sandbox-ssh.md). The WebView cannot
 * spawn `ssh`, so this holds the connections and exposes exec channels as byte streams: `data` events carry stdout and
 * stderr (base64), `exit` the status, and `write` / `eof` / `close` drive stdin.
 *
 * The app has one Ed25519 key of its own in its private storage; nothing of the owner's ~/.ssh is used. A connection
 * is refused unless the server presents exactly the host key the owner accepted (`scanHostKey` shows it first).
 */
@CapacitorPlugin(name = "Ssh")
public class SshPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int KEX_TIMEOUT_MS = 20_000;
    private static final int KEEPALIVE_MS = 15_000;
    private static final int READ_BUFFER = 64 * 1024;

    private final ExecutorService work = Executors.newCachedThreadPool();
    private final Map<Integer, Connection> connections = new ConcurrentHashMap<>();
    private final Map<Integer, Channel> channels = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private KeyPair keyPair;

    private static final class Channel {
        final int connection;
        final Session session;
        /** Writes in order, off the plugin thread. */
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        Channel(int connection, Session session) {
            this.connection = connection;
            this.session = session;
        }
    }

    // ---------- The app's key ----------

    private synchronized KeyPair key() throws Exception {
        if (keyPair != null) return keyPair;
        Ed25519Provider.insertIfNeeded();
        File dir = new File(getContext().getFilesDir(), "ssh");
        File privateFile = new File(dir, "id_ed25519.pk8");
        File publicFile = new File(dir, "id_ed25519.x509");
        KeyFactory factory = KeyFactory.getInstance("Ed25519");
        if (privateFile.exists() && publicFile.exists()) {
            keyPair = new KeyPair(
                factory.generatePublic(new X509EncodedKeySpec(Files.readAllBytes(publicFile.toPath()))),
                factory.generatePrivate(new PKCS8EncodedKeySpec(Files.readAllBytes(privateFile.toPath())))
            );
            return keyPair;
        }
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        KeyPair generated = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        Files.write(publicFile.toPath(), generated.getPublic().getEncoded());
        Files.write(privateFile.toPath(), generated.getPrivate().getEncoded());
        privateFile.setReadable(false, false);
        privateFile.setReadable(true, true);
        keyPair = generated;
        return keyPair;
    }

    /** The app's public key as an authorized_keys line. */
    @PluginMethod
    public void publicKey(PluginCall call) {
        work.execute(() -> {
            try {
                byte[] blob = Ed25519Verify.get().encodePublicKey(key().getPublic());
                JSObject result = new JSObject();
                result.put("publicKey", "ssh-ed25519 " + Base64.encodeToString(blob, Base64.NO_WRAP) + " pi-mobile");
                call.resolve(result);
            } catch (Exception e) {
                call.reject("無法產生 SSH 金鑰：" + e.getMessage(), "key", e);
            }
        });
    }

    // ---------- Host keys ----------

    private static String fingerprint(byte[] hostKey) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(hostKey);
        return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP | Base64.NO_PADDING);
    }

    /** Connects only far enough to read the server's host key, for the owner to compare before accepting it. */
    @PluginMethod
    public void scanHostKey(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 22);
        if (host == null || host.isEmpty()) {
            call.reject("沒有主機名稱", "input");
            return;
        }
        work.execute(() -> {
            Connection connection = new Connection(host, port);
            String[] seen = new String[2];
            try {
                connection.connect((h, p, algorithm, key) -> {
                    seen[0] = algorithm;
                    seen[1] = Base64.encodeToString(key, Base64.NO_WRAP);
                    return true;
                }, CONNECT_TIMEOUT_MS, KEX_TIMEOUT_MS);
                JSObject result = new JSObject();
                result.put("algorithm", seen[0]);
                result.put("key", seen[1]);
                result.put("fingerprint", fingerprint(Base64.decode(seen[1], Base64.NO_WRAP)));
                call.resolve(result);
            } catch (Exception e) {
                call.reject(problem(host, e), "connect", e);
            } finally {
                connection.close();
            }
        });
    }

    // ---------- Connections ----------

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host");
        String user = call.getString("user");
        String hostKey = call.getString("hostKey");
        int port = call.getInt("port", 22);
        if (host == null || user == null || hostKey == null) {
            call.reject("缺少主機、帳號或主機金鑰", "input");
            return;
        }
        byte[] accepted = Base64.decode(hostKey, Base64.NO_WRAP);
        work.execute(() -> {
            Connection connection = new Connection(host, port);
            try {
                connection.connect((h, p, algorithm, key) -> Arrays.equals(key, accepted), CONNECT_TIMEOUT_MS, KEX_TIMEOUT_MS);
            } catch (Exception e) {
                connection.close();
                // sshlib reports a refused host key as a failed connection whose cause names the verifier.
                boolean keyChanged = false;
                for (Throwable cause = e; cause != null && !keyChanged; cause = cause.getCause()) {
                    keyChanged = String.valueOf(cause.getMessage()).contains("not accepted by the verifier");
                }
                call.reject(keyChanged ? "主機金鑰跟你接受的不一樣，連線已拒絕" : problem(host, e), keyChanged ? "hostKey" : "connect", e);
                return;
            }
            try {
                if (!connection.authenticateWithPublicKey(user, key())) {
                    connection.close();
                    call.reject("主機拒絕了 app 的金鑰：請把公鑰加到 " + user + " 的 ~/.ssh/authorized_keys", "auth");
                    return;
                }
            } catch (Exception e) {
                connection.close();
                call.reject(problem(host, e), "auth", e);
                return;
            }
            int id = nextId.getAndIncrement();
            connections.put(id, connection);
            connection.addConnectionMonitor((reason) -> {
                if (connections.remove(id) == null) return;
                JSObject event = new JSObject();
                event.put("connection", id);
                event.put("reason", reason == null ? "closed" : String.valueOf(reason.getMessage()));
                notifyListeners("closed", event);
            });
            keepAlive(id, connection);
            JSObject result = new JSObject();
            result.put("connection", id);
            call.resolve(result);
        });
    }

    /** Pings so a dead link (Wi-Fi change, sleep) is noticed in seconds rather than at the next TCP timeout. */
    private void keepAlive(int id, Connection connection) {
        work.execute(() -> {
            while (connections.get(id) == connection) {
                try {
                    Thread.sleep(KEEPALIVE_MS);
                    if (connections.get(id) != connection) return;
                    connection.ping();
                } catch (InterruptedException e) {
                    return;
                } catch (IOException e) {
                    connection.close();
                    return;
                }
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        int id = call.getInt("connection", 0);
        Connection connection = connections.remove(id);
        if (connection != null) work.execute(connection::close);
        for (Map.Entry<Integer, Channel> entry : channels.entrySet()) {
            if (entry.getValue().connection == id) closeChannel(entry.getKey());
        }
        call.resolve();
    }

    // ---------- Exec channels ----------

    @PluginMethod
    public void exec(PluginCall call) {
        int connectionId = call.getInt("connection", 0);
        String command = call.getString("command");
        Connection connection = connections.get(connectionId);
        if (connection == null) {
            call.reject("SSH 連線已經斷了", "closed");
            return;
        }
        if (command == null) {
            call.reject("沒有指令", "input");
            return;
        }
        work.execute(() -> {
            Session session;
            try {
                session = connection.openSession();
                session.execCommand(command);
            } catch (IOException e) {
                call.reject("無法開啟 SSH 通道：" + e.getMessage(), "exec", e);
                return;
            }
            int id = nextId.getAndIncrement();
            channels.put(id, new Channel(connectionId, session));
            JSObject result = new JSObject();
            result.put("channel", id);
            call.resolve(result);
            // Readers start after the id is resolved, so the first `data` event finds its listener.
            work.execute(() -> pump(id, "stdout", session.getStdout()));
            work.execute(() -> pump(id, "stderr", session.getStderr()));
        });
    }

    private final Map<Integer, AtomicInteger> openStreams = new ConcurrentHashMap<>();

    private void pump(int id, String stream, InputStream input) {
        openStreams.computeIfAbsent(id, key -> new AtomicInteger(2));
        byte[] buffer = new byte[READ_BUFFER];
        try {
            int read;
            while ((read = input.read(buffer)) > 0) {
                JSObject event = new JSObject();
                event.put("channel", id);
                event.put("stream", stream);
                event.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                notifyListeners("data", event);
            }
        } catch (IOException ignored) {
            // The channel or connection closed; `exit` reports it.
        }
        AtomicInteger open = openStreams.get(id);
        if (open != null && open.decrementAndGet() == 0) finished(id);
    }

    private void finished(int id) {
        openStreams.remove(id);
        Channel channel = channels.remove(id);
        Integer code = null;
        String signal = null;
        if (channel != null) {
            channel.session.waitForCondition(ChannelCondition.EXIT_STATUS | ChannelCondition.EXIT_SIGNAL, 2000);
            code = channel.session.getExitStatus();
            signal = channel.session.getExitSignal();
            channel.session.close();
            channel.writer.shutdown();
        }
        JSObject event = new JSObject();
        event.put("channel", id);
        event.put("code", code);
        event.put("signal", signal);
        notifyListeners("exit", event);
    }

    @PluginMethod
    public void write(PluginCall call) {
        Channel channel = channels.get(call.getInt("channel", 0));
        String data = call.getString("data", "");
        if (channel == null) {
            call.reject("SSH 通道已經關了", "closed");
            return;
        }
        byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
        channel.writer.execute(() -> {
            try {
                OutputStream stdin = channel.session.getStdin();
                stdin.write(bytes);
                stdin.flush();
            } catch (IOException ignored) {
                // The reader sees the close and reports `exit`.
            }
        });
        call.resolve();
    }

    /** Ends stdin; the remote command sees end of input. */
    @PluginMethod
    public void eof(PluginCall call) {
        Channel channel = channels.get(call.getInt("channel", 0));
        if (channel != null) {
            channel.writer.execute(() -> {
                try {
                    channel.session.getStdin().close();
                } catch (IOException ignored) {
                    // Already closed.
                }
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        closeChannel(call.getInt("channel", 0));
        call.resolve();
    }

    private void closeChannel(int id) {
        Channel channel = channels.get(id);
        if (channel == null) return;
        channel.writer.execute(channel.session::close);
    }

    private static String problem(String host, Exception e) {
        android.util.Log.w("SshPlugin", "ssh to " + host + " failed", e);
        // sshlib wraps the reason ("There was a problem while connecting"); the innermost cause says what happened.
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String message = root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
        if (root instanceof java.net.UnknownHostException) return "找不到主機 " + host;
        if (root instanceof java.net.SocketTimeoutException) return "連不到 " + host + "（逾時）";
        if (e instanceof java.net.UnknownHostException) return "找不到主機 " + host;
        if (e instanceof java.net.SocketTimeoutException || message.contains("timed out")) return "連不到 " + host + "（逾時）";
        if (message.contains("refused")) return host + " 沒有開 SSH";
        return "SSH 連線失敗：" + message;
    }

    @Override
    protected void handleOnDestroy() {
        for (Connection connection : connections.values()) connection.close();
        connections.clear();
        work.shutdownNow();
    }
}
