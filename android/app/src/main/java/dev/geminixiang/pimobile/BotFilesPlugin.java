package dev.geminixiang.pimobile;

import android.util.Base64;
import com.getcapacitor.JSArray;
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
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "BotFiles")
public class BotFilesPlugin extends Plugin {

    private static final Pattern BOT = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private final ExecutorService work = Executors.newFixedThreadPool(4);

    private static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private interface Job {
        void run() throws Exception;
    }

    private void run(PluginCall call, Job job) {
        work.execute(() -> {
            try {
                job.run();
            } catch (Failure failure) {
                call.reject(failure.getMessage(), failure.code);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()), "io");
            }
        });
    }

    private File bots() {
        return new File(getContext().getFilesDir(), "bots");
    }

    private File botRoot(PluginCall call) throws Failure {
        String bot = call.getString("bot", "");
        if (!BOT.matcher(bot).matches()) throw new Failure("invalid", "bad bot id");
        return new File(bots(), bot);
    }

    private File resolve(PluginCall call, String key) throws Failure, IOException {
        File root = botRoot(call);
        String path = call.getString(key, "");
        if (path.startsWith("/") || path.contains("\0")) throw new Failure("invalid", "path must be relative: " + path);
        File file = path.isEmpty() ? root : new File(root, path);
        String rootPath = root.getCanonicalPath();
        String filePath = file.getCanonicalPath();
        if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) throw new Failure("invalid", "outside the folder: " + path);
        return file;
    }

    private static long number(PluginCall call, String key, long fallback) {
        Object value = call.getData().opt(key);
        return value instanceof Number ? ((Number) value).longValue() : fallback;
    }

    private static Failure notFound(String path) {
        return new Failure("not_found", "No such file or directory: " + path);
    }

    private static JSObject info(File file) {
        JSObject out = new JSObject();
        out.put("name", file.getName());
        out.put("kind", file.isDirectory() ? "directory" : "file");
        out.put("size", file.isDirectory() ? 0 : file.length());
        out.put("mtimeMs", file.lastModified());
        out.put("executable", file.isFile() && file.canExecute());
        return out;
    }

    @PluginMethod
    public void stat(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (!file.exists()) {
                if (file.equals(botRoot(call))) {
                    JSObject empty = new JSObject();
                    empty.put("name", "");
                    empty.put("kind", "directory");
                    empty.put("size", 0);
                    empty.put("mtimeMs", 0);
                    empty.put("executable", false);
                    call.resolve(empty);
                    return;
                }
                throw notFound(call.getString("path"));
            }
            call.resolve(info(file));
        });
    }

    @PluginMethod
    public void exists(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            JSObject result = new JSObject();
            result.put("exists", file.exists() || file.equals(botRoot(call)));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        run(call, () -> {
            File dir = resolve(call, "path");
            JSArray entries = new JSArray();
            if (!dir.exists() && dir.equals(botRoot(call))) {
                JSObject out = new JSObject();
                out.put("entries", entries);
                call.resolve(out);
                return;
            }
            if (!dir.exists()) throw notFound(call.getString("path"));
            if (!dir.isDirectory()) throw new Failure("not_directory", "Not a directory: " + call.getString("path"));
            File[] files = dir.listFiles();
            if (files != null) for (File file : files) entries.put(info(file));
            JSObject out = new JSObject();
            out.put("entries", entries);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (!file.exists()) throw notFound(call.getString("path"));
            if (file.isDirectory()) throw new Failure("is_directory", "Is a directory: " + call.getString("path"));
            long offset = number(call, "offset", 0L);
            try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                long size = input.length();
                long start = Math.min(Math.max(offset, 0), size);
                long length = Math.min(Math.max(number(call, "length", size - start), 0), size - start);
                if (length > Integer.MAX_VALUE - 8) throw new Failure("invalid", "read too large");
                byte[] bytes = new byte[(int) length];
                input.seek(start);
                input.readFully(bytes);
                JSObject out = new JSObject();
                out.put("size", size);
                if (call.getBoolean("text", false)) out.put("text", new String(bytes, StandardCharsets.UTF_8));
                else out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(out);
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (file.equals(botRoot(call)) || file.isDirectory()) throw new Failure("is_directory", "Is a directory: " + call.getString("path"));
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory()) {
                if (parent.exists()) throw new Failure("not_directory", "Not a directory: " + parent.getName());
                if (!parent.mkdirs() && !parent.isDirectory()) throw new IOException("cannot create " + parent.getName());
            }
            String text = call.getString("text");
            byte[] bytes = text != null ? text.getBytes(StandardCharsets.UTF_8) : Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            if (call.getBoolean("append", false)) {
                try (FileOutputStream output = new FileOutputStream(file, true)) {
                    output.write(bytes);
                }
            } else {
                File temp = File.createTempFile(".pi-write-", "", parent);
                try (FileOutputStream output = new FileOutputStream(temp)) {
                    output.write(bytes);
                    output.getFD().sync();
                }
                try {
                    Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException unsupported) {
                    Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void truncate(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (!file.exists()) throw notFound(call.getString("path"));
            if (file.isDirectory()) throw new Failure("is_directory", "Is a directory: " + call.getString("path"));
            try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
                output.setLength(Math.max(number(call, "size", 0L), 0));
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void create(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            File parent = file.getParentFile();
            if (parent == null || !parent.isDirectory()) throw notFound(call.getString("path"));
            boolean directory = call.getBoolean("directory", false);
            boolean created = directory ? file.mkdir() : file.createNewFile();
            if (!created) throw new Failure("exists", "Already exists: " + call.getString("path"));
            call.resolve();
        });
    }

    @PluginMethod
    public void chmod(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (!file.exists()) throw notFound(call.getString("path"));
            boolean executable = (call.getInt("mode", 0) & 0111) != 0;
            if (!file.setExecutable(executable, false)) throw new IOException("cannot change the mode of " + file.getName());
            call.resolve();
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        run(call, () -> {
            File dir = resolve(call, "path");
            if (dir.isDirectory()) {
                if (!call.getBoolean("recursive", false) && !dir.equals(botRoot(call))) throw new Failure("exists", "Already exists: " + call.getString("path"));
                call.resolve();
                return;
            }
            if (dir.exists()) throw new Failure("not_directory", "Not a directory: " + call.getString("path"));
            boolean made = call.getBoolean("recursive", false) || dir.equals(botRoot(call)) ? dir.mkdirs() : dir.mkdir();
            if (!made && !dir.isDirectory()) {
                File parent = dir.getParentFile();
                if (parent != null && !parent.exists()) throw notFound(call.getString("path"));
                throw new IOException("cannot create " + dir.getName());
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (!file.exists()) {
                if (call.getBoolean("force", false)) {
                    call.resolve();
                    return;
                }
                throw notFound(call.getString("path"));
            }
            if (file.equals(botRoot(call))) throw new Failure("invalid", "cannot remove the folder itself");
            if (file.isDirectory()) {
                String[] children = file.list();
                if (children != null && children.length > 0 && !call.getBoolean("recursive", false)) throw new Failure("invalid", "Directory not empty: " + call.getString("path"));
            }
            deleteTree(file);
            call.resolve();
        });
    }

    @PluginMethod
    public void rename(PluginCall call) {
        run(call, () -> {
            File from = resolve(call, "from");
            File to = resolve(call, "to");
            if (!from.exists()) throw notFound(call.getString("from"));
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory()) throw notFound(call.getString("to"));
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING);
            call.resolve();
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        run(call, () -> {
            File file = resolve(call, "path");
            if (file.equals(botRoot(call)) || file.isDirectory()) throw new Failure("is_directory", "Is a directory: " + call.getString("path"));
            URL url = new URL(call.getString("url", ""));
            HttpURLConnection connection = null;
            for (int hops = 0; ; hops++) {
                String protocol = url.getProtocol();
                if (!"http".equals(protocol) && !"https".equals(protocol)) throw new Failure("invalid", "url must be http or https");
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(60_000);
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) pi-mobile");
                int status = connection.getResponseCode();
                String location = connection.getHeaderField("Location");
                if (status >= 300 && status < 400 && location != null && hops < 5) {
                    connection.disconnect();
                    url = new URL(url, location);
                    continue;
                }
                if (status >= 400) {
                    connection.disconnect();
                    throw new Failure("http", "HTTP " + status + " " + url);
                }
                break;
            }
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) throw new IOException("cannot create " + parent.getName());
            File temp = File.createTempFile(".pi-write-", "", parent);
            long size = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temp)) {
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = input.read(buffer)) > 0; ) {
                    output.write(buffer, 0, n);
                    size += n;
                }
                output.getFD().sync();
            } catch (IOException failure) {
                if (!temp.delete()) temp.deleteOnExit();
                throw failure;
            } finally {
                connection.disconnect();
            }
            try {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            JSObject out = new JSObject();
            out.put("size", size);
            out.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            out.put("url", url.toString());
            call.resolve(out);
        });
    }

    @PluginMethod
    public void listBots(PluginCall call) {
        run(call, () -> {
            JSArray ids = new JSArray();
            File[] folders = bots().listFiles();
            if (folders != null) for (File folder : folders) if (folder.isDirectory() && BOT.matcher(folder.getName()).matches()) ids.put(folder.getName());
            JSObject out = new JSObject();
            out.put("ids", ids);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void removeBot(PluginCall call) {
        run(call, () -> {
            File root = botRoot(call);
            if (root.exists()) deleteTree(root);
            call.resolve();
        });
    }

    private static void deleteTree(File file) throws IOException {
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if (!file.delete() && file.exists()) throw new IOException("cannot delete " + file.getName());
    }
}
